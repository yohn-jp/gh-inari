import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { generateAndPersistDelegatorKeyPair, delegatorPublicKeyFingerprint } from "../agent-authority/delegator-key.js";
import { registerDelegator } from "../agent-authority/delegator-lifecycle.js";
import type { Delegator } from "../agent-authority/delegator.js";
import { setupLocalAdmission } from "../admission/setup.js";
import { bindLocalCliAdmissionRoute, ensureLocalCliTopology } from "../local-control/config.js";
import { createSetupApplication, setupOperationId, type SetupEnrollmentUpload } from "../application/setup/index.js";
import { executorIssuerCustody } from "../executor/enrollment/owner.js";
import { ensureLocalExecutorConfiguration } from "../executor/setup.js";
import { setupLocalAuthority } from "../local-control/identity.js";
import { LocalRuntimeProfileStore } from "../local-runtime-profile.js";
import {
  MAX_SECRET_ENROLLMENT_BYTES,
  SETUP_CONTRACT_VERSION,
  findSetupSecretMaterial,
  type SetupActionRequest,
  type SetupGeneration,
} from "../runtime-contracts/index.js";
import { createExecutorSetupEnrollmentPort, createLocalSetupPorts, createSetupActionPort } from "./setup-adapters.js";
import { SetupConfigStore, SetupConfigStoreError, setupStateFileKey } from "./setup-config-store.js";
import { ExecutorCredentialStore } from "../executor/credential-store.js";
import {
  SetupProviderError,
  readSetupConfigurationEvidence,
  type RuntimeLifecyclePort,
  type SessionReadinessPort,
  type SetupProviderPort,
} from "./setup-observation.js";

const repository = { repositoryHost: "github.com", repositoryId: "1330755860", nameWithOwner: "yohn-jp/gh-inari" };
const APP_ID = "4242";

function rsaPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    format: "pem",
    type: "pkcs8",
  }) as string;
}

function upload(text: string, declaredBytes = Buffer.byteLength(text)): SetupEnrollmentUpload {
  const bytes = Buffer.from(text, "utf8");
  return {
    declaredBytes,
    stream: (async function* () {
      yield new Uint8Array(bytes);
    })(),
  };
}

interface World {
  readonly root: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly provider: FakeProvider;
  cleanup(): void;
}

class FakeProvider implements SetupProviderPort {
  canonical: readonly Delegator[] = [];
  readFailure: SetupProviderError | undefined;
  publishFailure: SetupProviderError | undefined;
  installation = { appId: APP_ID, installationId: "77", repositoryId: repository.repositoryId };
  installationFailure: SetupProviderError | undefined;
  readonly published: Delegator[] = [];

  async resolveInstallation() {
    if (this.installationFailure) throw this.installationFailure;
    return this.installation;
  }

  async readCanonicalAuthorities() {
    if (this.readFailure) throw this.readFailure;
    return this.canonical;
  }

  async publishAuthority(_context: unknown, authority: Delegator) {
    if (this.publishFailure) throw this.publishFailure;
    this.published.push(authority);
    return {
      status: "created" as const,
      authorityId: authority.id,
      branch: "inari/runtime-authority/0123456789abcdef",
      pullRequest: { number: 12, url: "https://github.com/yohn-jp/gh-inari/pull/12" },
    };
  }
}

const notReady: SessionReadinessPort = {
  observe: async () => ({ status: "not-ready", observedAt: new Date().toISOString(), diagnostics: [] }),
};

function world(): World {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-setup-adapters-"));
  const home = path.join(root, "home");
  return {
    root,
    environment: { INARI_CONFIG_HOME: home },
    provider: new FakeProvider(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function ports(w: World, extra: Parameters<typeof createLocalSetupPorts>[0] = {}) {
  return createLocalSetupPorts({
    environment: w.environment,
    root: path.join(w.root, "repo"),
    provider: w.provider,
    sessionReadiness: notReady,
    executorVerification: { verifyProvider: async () => false, verifyInstallation: async () => true },
    ...extra,
  });
}

function actionRequest(
  kind: string,
  generation: SetupGeneration,
  inputs: Record<string, string> = {},
): SetupActionRequest {
  return {
    version: SETUP_CONTRACT_VERSION,
    actionId: setupOperationId(kind, generation),
    generation,
    confirmed: true,
    inputs,
  };
}

function storedText(w: World): string {
  const directory = path.join(w.environment.INARI_CONFIG_HOME!, "runtime", "setup");
  return existsSync(directory)
    ? readdirSync(directory)
        .map((file) => readFileSync(path.join(directory, file), "utf8"))
        .join("\n")
    : "";
}

/** A configured repository: enrolled Executor, Authority custody, Admission pin and shared record. */
async function configure(w: World): Promise<Delegator> {
  const { config } = await ensureLocalExecutorConfiguration(w.environment);
  const app = createSetupApplication(ports(w));
  const state = await app.state(repository);
  const action = state.actions.find((item) => item.kind === "executor.configure")!;
  const pem = rsaPem();
  const configured = await app.perform(
    repository,
    { version: 1, actionId: action.id, generation: state.generation, confirmed: true, inputs: { "app-id": APP_ID } },
    { enrollments: { "issuer-key": upload(pem) } },
  );
  assert.equal(configured.outcome, "succeeded");
  assert.equal(executorIssuerCustody(w.environment)?.configId, config.id);
  const authority = setupLocalAuthority(w.environment);
  const record = createDelegatorRecord({
    id: "runtime-test",
    key: authority.config.publicKey,
    maxSessionTtlSeconds: 3600,
    capabilityCeiling: ["change.implement"],
  });
  const admission = setupLocalAdmission(record, w.environment);
  // A configured CLI routes Sessions to this Admission (as `admission setup` binds it).
  ensureLocalCliTopology(w.environment);
  bindLocalCliAdmissionRoute({ id: admission.config.id }, w.environment);
  const store = new SetupConfigStore({ environment: w.environment });
  const current = store.read(repository)!;
  store.update(repository, current.revision, {
    authority: { authorityId: record.id, publicKeyFingerprint: delegatorPublicKeyFingerprint(record.key) },
  });
  return record;
}

test("#1184 complete-configuration routes the local CLI to the configured Admission; an unrouted CLI is not configured", async () => {
  const w = world();
  try {
    await configure(w);
    const cliConfig = path.join(w.environment.INARI_CONFIG_HOME!, "cli", "config.json");
    // A CLI initialized before Admission existed has no route: setup is not usable yet.
    rmSync(cliConfig);
    ensureLocalCliTopology(w.environment);
    const app = createSetupApplication(ports(w));
    const unrouted = await app.state(repository);
    assert.equal(unrouted.dimensions.find((item) => item.dimension === "configuration")?.status, "partial");
    const action = unrouted.actions.find((item) => item.kind === "composition.complete-configuration")!;
    const result = await app.perform(repository, {
      version: 1,
      actionId: action.id,
      generation: unrouted.generation,
      confirmed: true,
      inputs: {},
    });
    assert.equal(result.outcome, "succeeded", JSON.stringify(result.diagnostics));
    const evidence = await readSetupConfigurationEvidence(repository, w.environment);
    assert.equal(evidence.cliAdmissionRouteId, evidence.admission?.id);
    const routed = await app.state(repository);
    assert.equal(routed.dimensions.find((item) => item.dimension === "configuration")?.status, "configured");
    assert.equal(JSON.parse(readFileSync(cliConfig, "utf8")).admission.id, evidence.admission?.id);
  } finally {
    w.cleanup();
  }
});

test("executor.configure carries App ID + PEM to the real Executor custody and records only public references", async () => {
  const w = world();
  try {
    const app = createSetupApplication(ports(w));
    const state = await app.state(repository);
    assert.equal(state.stage, "clean");
    assert.equal(state.nextAction.kind, "perform");
    const action = state.actions.find((item) => item.kind === "executor.configure")!;
    const pem = rsaPem();
    const result = await app.perform(
      repository,
      { version: 1, actionId: action.id, generation: state.generation, confirmed: true, inputs: { "app-id": APP_ID } },
      { enrollments: { "issuer-key": upload(pem) } },
    );
    assert.equal(result.outcome, "succeeded", JSON.stringify(result.diagnostics));
    const custody = executorIssuerCustody(w.environment);
    assert.equal(custody?.appId, APP_ID);
    assert.equal(result.receipt?.publicFingerprint, custody?.fingerprint);
    const record = new SetupConfigStore({ environment: w.environment }).read(repository);
    assert.deepEqual(record?.app, { appId: APP_ID });
    assert.equal(record?.executor?.issuerKeyFingerprint, custody?.fingerprint);
    // A fresh process observes the same truth without any exported App ID.
    const fresh = await createSetupApplication(ports(w)).state(repository);
    assert.equal(fresh.stage, "partial");
    // No secret in the result, shared record, journal or state.
    const serialized = JSON.stringify({ result, state: fresh }) + storedText(w);
    assert.equal(serialized.includes("PRIVATE KEY"), false);
    assert.equal(serialized.includes(pem.slice(40, 80)), false);
    assert.deepEqual(findSetupSecretMaterial(JSON.parse(JSON.stringify({ result, fresh }))), []);
  } finally {
    w.cleanup();
  }
});

test("re-enrolling the same key is idempotent; a different key is rejected without replacing custody", async () => {
  const w = world();
  try {
    const observation = ports(w).observation;
    const generation = (await observation.observe(repository)).generation;
    const port = createExecutorSetupEnrollmentPort({ environment: w.environment });
    const request = {
      version: SETUP_CONTRACT_VERSION,
      kind: "executor-issuer-private-key" as const,
      operationId: setupOperationId("executor.configure", generation),
      repository,
      inputs: { "app-id": APP_ID },
    };
    const pem = rsaPem();
    const first = await port.enroll({ ...request, declaredBytes: Buffer.byteLength(pem) }, upload(pem).stream);
    const custody = executorIssuerCustody(w.environment);
    const second = await port.enroll({ ...request, declaredBytes: Buffer.byteLength(pem) }, upload(pem).stream);
    assert.equal(first.outcome, "enrolled");
    assert.equal(second.publicFingerprint, first.publicFingerprint);
    assert.equal(executorIssuerCustody(w.environment)?.generation, custody?.generation);
    const other = rsaPem();
    const replaced = await port.enroll({ ...request, declaredBytes: Buffer.byteLength(other) }, upload(other).stream);
    assert.equal(replaced.outcome, "rejected");
    assert.equal(executorIssuerCustody(w.environment)?.fingerprint, custody?.fingerprint);
  } finally {
    w.cleanup();
  }
});

test("missing, unknown or invalid App input never reaches custody", async () => {
  const w = world();
  try {
    const app = createSetupApplication(ports(w));
    const state = await app.state(repository);
    const action = state.actions.find((item) => item.kind === "executor.configure")!;
    const base = { version: 1 as const, actionId: action.id, generation: state.generation, confirmed: true };
    const missing = await app.perform(
      repository,
      { ...base, inputs: {} },
      { enrollments: { "issuer-key": upload(rsaPem()) } },
    );
    assert.equal(missing.outcome, "action-required");
    const unknown = await app.perform(
      repository,
      { ...base, inputs: { "app-id": APP_ID, extra: "x" } },
      { enrollments: { "issuer-key": upload(rsaPem()) } },
    );
    assert.equal(unknown.outcome, "action-required");
    const invalid = await app.perform(
      repository,
      { ...base, inputs: { "app-id": "not-a-number" } },
      { enrollments: { "issuer-key": upload(rsaPem()) } },
    );
    assert.equal(invalid.outcome, "failed");
    assert.equal(invalid.diagnostics[0]?.code, "SETUP_APP_ID_INVALID");
    const port = createExecutorSetupEnrollmentPort({ environment: w.environment });
    const bare = await port.enroll(
      {
        version: 1,
        kind: "executor-issuer-private-key",
        operationId: action.id,
        repository,
        declaredBytes: 10,
      },
      upload("0123456789").stream,
    );
    assert.equal(bare.outcome, "rejected");
    assert.equal(
      existsSync(path.join(w.environment.INARI_CONFIG_HOME!, "executor", "issuer", "issuer-key.json")),
      false,
    );
  } finally {
    w.cleanup();
  }
});

test("malformed or oversized enrollment is rejected and custody stays unchanged", async () => {
  const w = world();
  try {
    const app = createSetupApplication(ports(w));
    const state = await app.state(repository);
    const action = state.actions.find((item) => item.kind === "executor.configure")!;
    const base = {
      version: 1 as const,
      actionId: action.id,
      generation: state.generation,
      confirmed: true,
      inputs: { "app-id": APP_ID },
    };
    const oversized = await app.perform(repository, base, {
      enrollments: { "issuer-key": upload("x", MAX_SECRET_ENROLLMENT_BYTES + 1) },
    });
    assert.equal(oversized.outcome, "action-required");
    const garbage = await app.perform(repository, base, { enrollments: { "issuer-key": upload("not a key") } });
    assert.equal(garbage.outcome, "failed");
    assert.equal(garbage.receipt?.outcome, "rejected");
    const longer = await app.perform(repository, base, { enrollments: { "issuer-key": upload(rsaPem(), 16) } });
    assert.equal(longer.outcome, "failed");
    assert.equal(executorIssuerCustody(w.environment), undefined);
    assert.equal(new SetupConfigStore({ environment: w.environment }).read(repository), undefined);
  } finally {
    w.cleanup();
  }
});

test("a stale generation is rejected before any enrollment or owner effect", async () => {
  const w = world();
  try {
    const observation = ports(w).observation;
    const stale = (await observation.observe(repository)).generation;
    // Another process records shared configuration, changing the generation.
    new SetupConfigStore({ environment: w.environment }).update(repository, 0, { app: { appId: APP_ID } });
    const port = createExecutorSetupEnrollmentPort({ environment: w.environment });
    const pem = rsaPem();
    const rejected = await port.enroll(
      {
        version: 1,
        kind: "executor-issuer-private-key",
        operationId: setupOperationId("executor.configure", stale),
        repository,
        declaredBytes: Buffer.byteLength(pem),
        inputs: { "app-id": APP_ID },
      },
      upload(pem).stream,
    );
    assert.equal(rejected.outcome, "rejected");
    assert.equal(rejected.diagnostics[0]?.code, "SETUP_GENERATION_STALE");
    assert.equal(executorIssuerCustody(w.environment), undefined);
    const action = createSetupActionPort({ environment: w.environment, provider: w.provider });
    const result = await action.perform(actionRequest("executor.configure", stale, { "app-id": APP_ID }));
    assert.equal(result.outcome, "stale");
    const foreign = await action.perform(actionRequest("executor.unknown", stale));
    assert.equal(foreign.outcome, "failed");
  } finally {
    w.cleanup();
  }
});

test("a persistence failure after successful enrollment keeps custody and reports a partial unknown outcome", async () => {
  const w = world();
  try {
    class FailingStore extends SetupConfigStore {
      override update(): never {
        throw new SetupConfigStoreError("SETUP_CONFIG_STORAGE_FAILED", "injected");
      }
    }
    const app = createSetupApplication(ports(w, { configStore: new FailingStore({ environment: w.environment }) }));
    const state = await app.state(repository);
    const action = state.actions.find((item) => item.kind === "executor.configure")!;
    const result = await app.perform(
      repository,
      { version: 1, actionId: action.id, generation: state.generation, confirmed: true, inputs: { "app-id": APP_ID } },
      { enrollments: { "issuer-key": upload(rsaPem()) } },
    );
    assert.equal(result.outcome, "unknown");
    assert.ok(result.diagnostics.some((item) => item.code === "SETUP_PARTIAL_EFFECT_UNCONFIRMED"));
    assert.ok(result.receipt?.publicFingerprint);
    // Safely committed custody is not rolled back; the next state reconciles instead of replaying.
    assert.equal(executorIssuerCustody(w.environment)?.fingerprint, result.receipt?.publicFingerprint);
    const next = await createSetupApplication(ports(w)).state(repository);
    assert.equal(next.stage, "partial");
    assert.equal(
      next.actions.some((item) => item.kind === "executor.configure"),
      false,
    );
  } finally {
    w.cleanup();
  }
});

test("complete-configuration adopts an existing profile Authority through #1116 migration without trust change", async () => {
  const w = world();
  try {
    // Local Runtime Authority records are never written below the OS temporary directory.
    const repo = mkdtempSync(path.join(process.cwd(), ".setup-test-"));
    after(() => rmSync(repo, { recursive: true, force: true }));
    const app = createSetupApplication(ports(w, { root: repo }));
    const initial = await app.state(repository);
    const configure = initial.actions.find((item) => item.kind === "executor.configure")!;
    await app.perform(
      repository,
      {
        version: 1,
        actionId: configure.id,
        generation: initial.generation,
        confirmed: true,
        inputs: { "app-id": APP_ID },
      },
      { enrollments: { "issuer-key": upload(rsaPem()) } },
    );
    // No Authority yet: nothing is generated.
    const partial = await app.state(repository);
    const complete = partial.actions.find((item) => item.kind === "composition.complete-configuration")!;
    const blocked = await app.perform(repository, {
      version: 1,
      actionId: complete.id,
      generation: partial.generation,
      confirmed: true,
      inputs: {},
    });
    assert.equal(blocked.outcome, "failed");
    assert.equal(blocked.diagnostics[0]?.code, "SETUP_AUTHORITY_PREPARATION_REQUIRED");
    assert.equal(existsSync(path.join(w.environment.INARI_CONFIG_HOME!, "authority")), false);

    // A legacy `inari setup` profile with its own key and a registered local record.
    const keyPath = path.join(w.root, "legacy", "runtime.pem");
    const key = generateAndPersistDelegatorKeyPair(keyPath);
    const record = createDelegatorRecord({
      id: "runtime-legacy",
      key,
      maxSessionTtlSeconds: 1800,
      notBefore: "2026-01-01T00:00:00.000Z",
      capabilityCeiling: ["change.implement", "change.ready"],
    });
    registerDelegator(repo, record);
    await new LocalRuntimeProfileStore({ environment: w.environment }).save({
      version: 1,
      state: "trust-pending",
      endpoint: "https://inari.example.com",
      relayUrl: "wss://relay.example.com/connect",
      repository: {
        repositoryHost: repository.repositoryHost,
        repositoryId: repository.repositoryId,
        repositoryNameWithOwner: repository.nameWithOwner,
      },
      app: { appId: APP_ID, installationId: "77", clientId: "Iv1.abc" },
      authority: {
        authorityId: record.id,
        publicKeyFingerprint: delegatorPublicKeyFingerprint(key),
        privateKeyPath: keyPath,
      },
    });
    const ready = await app.state(repository);
    const retry = ready.actions.find((item) => item.kind === "composition.complete-configuration")!;
    const result = await app.perform(repository, {
      version: 1,
      actionId: retry.id,
      generation: ready.generation,
      confirmed: true,
      inputs: {},
    });
    assert.equal(result.outcome, "succeeded", JSON.stringify(result.diagnostics));
    const configured = await app.state(repository);
    assert.equal(configured.dimensions.find((item) => item.dimension === "configuration")?.status, "configured");
    const pin = JSON.parse(
      readFileSync(path.join(w.environment.INARI_CONFIG_HOME!, "admission", "runtime-authority.json"), "utf8"),
    ) as Delegator;
    // Identity, key, notBefore, TTL and capability ceiling are preserved exactly.
    assert.deepEqual(pin, record);
    const shared = new SetupConfigStore({ environment: w.environment }).read(repository);
    assert.equal(shared?.authority?.authorityId, record.id);
    assert.equal(shared?.app?.clientId, "Iv1.abc");
    assert.equal(shared?.endpoint, "https://inari.example.com");
    assert.equal(storedText(w).includes("PRIVATE KEY"), false);
  } finally {
    w.cleanup();
  }
});

test("bind-repository uses App-user bootstrap scope and Executor-owned key verification", async () => {
  const w = world();
  try {
    await configure(w);
    const app = createSetupApplication(ports(w));
    const state = await app.state(repository);
    assert.equal(state.nextAction.kind, "perform");
    const bind = state.actions.find((item) => item.kind === "executor.bind-repository")!;
    const request = {
      version: 1 as const,
      actionId: bind.id,
      generation: state.generation,
      confirmed: true,
      inputs: {},
    };
    w.provider.installationFailure = new SetupProviderError("authorization");
    const unauthorized = await app.perform(repository, request);
    assert.equal(unauthorized.outcome, "failed");
    assert.equal(unauthorized.diagnostics[0]?.code, "SETUP_APP_USER_AUTHORIZATION_REQUIRED");
    w.provider.installationFailure = undefined;
    const retried = await app.state(repository);
    const bound = await app.perform(repository, { ...request, generation: retried.generation });
    assert.equal(bound.outcome, "succeeded", JSON.stringify(bound.diagnostics));
    assert.equal(executorIssuerCustody(w.environment)?.providerVerified, true);
    const after = await app.state(repository);
    assert.equal(after.dimensions.find((item) => item.dimension === "provider-binding")?.status, "bound");
    assert.equal(new SetupConfigStore({ environment: w.environment }).read(repository)?.app?.installationId, "77");
    // #1182: the binding setup records is the Executor's own owner evidence, the input execution uses.
    assert.deepEqual(executorIssuerCustody(w.environment)?.bindings, [
      {
        repositoryHost: repository.repositoryHost,
        repositoryId: repository.repositoryId,
        nameWithOwner: repository.nameWithOwner,
        installationId: "77",
      },
    ]);
  } finally {
    w.cleanup();
  }
});

test("#1182 a recorded installation without the Executor's own verified binding is never reported bound", async () => {
  const w = world();
  try {
    await configure(w);
    const app = createSetupApplication(ports(w));
    const state = await app.state(repository);
    const record = new SetupConfigStore({ environment: w.environment }).read(repository)!;
    // The shared record claims an installation and the custody is provider-verified,
    // but the Executor never verified this repository installation.
    new SetupConfigStore({ environment: w.environment }).update(repository, record.revision, {
      app: { ...record.app!, installationId: "77" },
    });
    const custody = new ExecutorCredentialStore(w.environment);
    custody.markProviderVerified(custody.current()!.generation);
    const claimed = await app.state(repository);
    assert.notEqual(claimed.generation.configuration, state.generation.configuration);
    const binding = claimed.dimensions.find((item) => item.dimension === "provider-binding");
    assert.equal(binding?.status, "unbound");
    assert.equal(binding?.diagnostics[0]?.code, "SETUP_ISSUER_KEY_UNVERIFIED");
    assert.equal(
      claimed.actions.some((item) => item.kind === "executor.bind-repository"),
      true,
    );
  } finally {
    w.cleanup();
  }
});

async function bound(w: World): Promise<Delegator> {
  const record = await configure(w);
  const app = createSetupApplication(ports(w));
  const state = await app.state(repository);
  const bind = state.actions.find((item) => item.kind === "executor.bind-repository")!;
  const result = await app.perform(repository, {
    version: 1,
    actionId: bind.id,
    generation: state.generation,
    confirmed: true,
    inputs: {},
  });
  assert.equal(result.outcome, "succeeded");
  return record;
}

test("publish-trust returns pending PR evidence and never implies trust; recheck needs the exact record", async () => {
  const w = world();
  try {
    const record = await bound(w);
    const app = createSetupApplication(ports(w));
    const state = await app.state(repository);
    assert.equal(state.dimensions.find((item) => item.dimension === "repository-trust")?.status, "untrusted");
    const publish = state.actions.find((item) => item.kind === "authority.publish-trust")!;
    const request = {
      version: 1 as const,
      actionId: publish.id,
      generation: state.generation,
      confirmed: true,
      inputs: {},
    };
    const result = await app.perform(repository, request);
    assert.equal(result.outcome, "succeeded");
    assert.equal(result.diagnostics[0]?.code, "SETUP_TRUST_PUBLICATION_PENDING");
    assert.deepEqual(w.provider.published, [record]);
    const pending = await app.state(repository);
    assert.equal(pending.stage, "pending-human-trust");
    assert.equal(pending.nextAction.kind, "wait");

    const recheck = pending.actions.find((item) => item.kind === "authority.recheck-trust")!;
    const recheckRequest = {
      version: 1 as const,
      actionId: recheck.id,
      generation: pending.generation,
      confirmed: true,
      inputs: {},
    };
    const notYet = await app.perform(repository, recheckRequest);
    assert.equal(notYet.outcome, "action-required");
    w.provider.canonical = [{ ...record, capabilityCeiling: ["change.implement", "change.merge"] }];
    // A widened protected-ref record is a conflict: observation withholds the action and the owner rejects it.
    const conflicted = await app.state(repository);
    assert.equal(conflicted.dimensions.find((item) => item.dimension === "repository-trust")?.status, "unknown");
    const widened = await createSetupActionPort({ environment: w.environment, provider: w.provider }).perform(
      recheckRequest,
    );
    assert.equal(widened.outcome, "failed");
    assert.equal(widened.diagnostics[0]?.code, "SETUP_TRUST_CONFLICT");
    w.provider.canonical = [record];
    const trusted = await createSetupActionPort({ environment: w.environment, provider: w.provider }).perform(
      recheckRequest,
    );
    assert.equal(trusted.outcome, "succeeded");
    assert.equal(trusted.diagnostics[0]?.code, "SETUP_TRUST_CONFIRMED");
    const after = await app.state(repository);
    assert.equal(after.dimensions.find((item) => item.dimension === "repository-trust")?.status, "trusted");
  } finally {
    w.cleanup();
  }
});

test("an uncertain publication is unknown and is not replayed blindly", async () => {
  const w = world();
  try {
    await bound(w);
    const app = createSetupApplication(ports(w));
    const state = await app.state(repository);
    const publish = state.actions.find((item) => item.kind === "authority.publish-trust")!;
    w.provider.publishFailure = new SetupProviderError("uncertain");
    const result = await app.perform(repository, {
      version: 1,
      actionId: publish.id,
      generation: state.generation,
      confirmed: true,
      inputs: {},
    });
    assert.equal(result.outcome, "unknown");
    const next = await app.state(repository);
    const step = next.steps.find((item) => item.dimension === "repository-trust");
    assert.equal(step?.status, "uncertain");
  } finally {
    w.cleanup();
  }
});

test("start/restart only dispatch to an injected lifecycle owner and never fabricate success", async () => {
  const w = world();
  try {
    const record = await bound(w);
    w.provider.canonical = [record];
    const absent = createSetupActionPort({ environment: w.environment, provider: w.provider });
    const evidence = await readSetupConfigurationEvidence(repository, w.environment);
    const generation = { repository, configuration: evidence.generation };
    const noOwner = await absent.perform(actionRequest("composition.start-runtime", generation));
    assert.equal(noOwner.outcome, "failed");
    assert.equal(noOwner.diagnostics[0]?.code, "SETUP_RUNTIME_LIFECYCLE_UNAVAILABLE");

    const calls: string[] = [];
    const lifecycle: RuntimeLifecyclePort = {
      observe: async (current) => ({
        status: "not-running",
        observedAt: new Date().toISOString(),
        generation: current.configuration,
        diagnostics: [],
      }),
      start: async (request) => {
        calls.push(`start:${request.operationId}`);
        return { outcome: "unknown", diagnostics: [] };
      },
      restart: async () => {
        throw new Error("lost");
      },
    };
    const app = createSetupApplication(ports(w, { lifecycle }));
    const state = await app.state(repository);
    assert.equal(state.dimensions.find((item) => item.dimension === "health")?.status, "not-running");
    const start = state.actions.find((item) => item.kind === "composition.start-runtime")!;
    const started = await app.perform(repository, {
      version: 1,
      actionId: start.id,
      generation: state.generation,
      confirmed: true,
      inputs: {},
    });
    assert.equal(started.outcome, "unknown");
    assert.deepEqual(calls, [`start:${start.id}`]);
    const withOwner = createSetupActionPort({ environment: w.environment, provider: w.provider, lifecycle });
    const restarted = await withOwner.perform(actionRequest("composition.restart-runtime", generation));
    assert.equal(restarted.outcome, "unknown");
  } finally {
    w.cleanup();
  }
});

test("the shared record file is keyed by immutable repository identity", () => {
  assert.match(setupStateFileKey(repository), /^[0-9a-f]{32}$/u);
  assert.notEqual(setupStateFileKey(repository), setupStateFileKey({ ...repository, repositoryId: "1" }));
});
