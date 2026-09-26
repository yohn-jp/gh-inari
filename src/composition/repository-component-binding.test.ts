import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { setupLocalAdmission } from "../admission/setup.js";
import { listLocalAuthorityIdentities, prepareLocalAuthorityIdentity } from "../authority/index.js";
import { ExecutorAppCredentialStore, ExecutorCredentialStore } from "../executor/credential-store.js";
import { ExecutorRepositoryBindingStore } from "../executor/repository-binding-store.js";
import { ensureLocalExecutorConfiguration } from "../executor/setup.js";
import { writeLocalJson } from "../local-control/config.js";
import { setupLocalAuthority } from "../local-control/identity.js";
import { RepositoryRegistry } from "../local-control/repository-registry.js";
import { findSetupSecretMaterial } from "../runtime-contracts/index.js";
import {
  RepositoryComponentBindingError,
  readExecutorCustodyEvidence,
  resolveRepositoryComponentBinding,
} from "./repository-component-binding.js";
import { SetupConfigStore, setupStateFileKey, validateSetupConfigRecord } from "./setup-config-store.js";

const one = { repositoryHost: "github.com", repositoryId: "1001", nameWithOwner: "acme/one" };
const two = { repositoryHost: "github.com", repositoryId: "1002", nameWithOwner: "acme/two" };
const SHARED_APP = "4242";
const DEDICATED_APP = "5151";

function pem(): Buffer {
  return Buffer.from(
    generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }),
  );
}

interface World {
  readonly home: string;
  readonly environment: NodeJS.ProcessEnv;
  cleanup(): void;
}

function world(): World {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-component-binding-"));
  const home = path.join(root, "home");
  return {
    home,
    environment: { INARI_CONFIG_HOME: home },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** App-scoped Executor credential, provider-verified, and the repository bindings the Executor owner published. */
function enroll(
  environment: NodeJS.ProcessEnv,
  configId: string,
  appId: string,
  repositories: readonly (typeof one & { readonly installationId: string })[],
) {
  const apps = new ExecutorAppCredentialStore(environment);
  const saved = apps.save(configId, appId, pem()).record;
  const credential = apps.markProviderVerified(appId, saved.generation);
  for (const repository of repositories)
    new ExecutorRepositoryBindingStore(environment).publish({
      repositoryHost: repository.repositoryHost,
      repositoryId: repository.repositoryId,
      nameWithOwner: repository.nameWithOwner,
      appId,
      installationId: repository.installationId,
      generation: credential.generation,
      fingerprint: credential.fingerprint,
    });
  return credential;
}

function record(
  environment: NodeJS.ProcessEnv,
  repository: typeof one,
  patch: Parameters<SetupConfigStore["update"]>[2],
) {
  const store = new SetupConfigStore({ environment });
  return store.update(repository, store.read(repository)?.revision ?? 0, patch);
}

function serializedLeaks(value: unknown, home: string): readonly string[] {
  const text = JSON.stringify(value);
  return [home, "PRIVATE KEY", ".pem", "privateKey", "credential.json", "keys/"].filter((needle) =>
    text.includes(needle),
  );
}

test("#1201 two repositories resolve independent bindings: shared App intentionally, dedicated App distinctly", async () => {
  const w = world();
  try {
    const { config: executor } = await ensureLocalExecutorConfiguration(w.environment);
    const shared = enroll(w.environment, executor.id, SHARED_APP, [
      { ...one, installationId: "71" },
      { ...two, installationId: "72" },
    ]);
    record(w.environment, one, {
      app: { appId: SHARED_APP, installationId: "71" },
      executor: { configId: executor.id, issuerKeyFingerprint: shared.fingerprint },
    });
    record(w.environment, two, {
      app: { appId: SHARED_APP, installationId: "72" },
      executor: { configId: executor.id, issuerKeyFingerprint: shared.fingerprint },
    });
    const first = resolveRepositoryComponentBinding(one, { environment: w.environment });
    const second = resolveRepositoryComponentBinding(two, { environment: w.environment });
    // Shared-App compatibility: one credential generation, two independent repository bindings.
    assert.equal(first.executor?.appCredential?.fingerprint, second.executor?.appCredential?.fingerprint);
    assert.equal(first.executor?.appCredential?.source, "app-scoped");
    assert.deepEqual(
      [first.executor?.binding?.repositoryId, first.executor?.binding?.installationId, first.executor?.binding?.status],
      [one.repositoryId, "71", "bound"],
    );
    assert.deepEqual(
      [second.executor?.binding?.repositoryId, second.executor?.binding?.installationId],
      [two.repositoryId, "72"],
    );
    assert.deepEqual([first.conflicts, second.conflicts], [[], []]);
    assert.equal(first.setup?.source, "canonical");
    assert.equal(first.registered, true);
    assert.equal(readdirSync(path.join(w.home, "executor", "apps")).length, 1);

    // A dedicated App for a third repository stays distinct and never leaks into the other two.
    const three = { repositoryHost: "github.com", repositoryId: "1003", nameWithOwner: "acme/three" };
    const dedicated = enroll(w.environment, executor.id, DEDICATED_APP, [{ ...three, installationId: "73" }]);
    record(w.environment, three, {
      app: { appId: DEDICATED_APP, installationId: "73" },
      executor: { configId: executor.id, issuerKeyFingerprint: dedicated.fingerprint },
    });
    const third = resolveRepositoryComponentBinding(three, { environment: w.environment });
    assert.equal(third.executor?.appCredential?.appId, DEDICATED_APP);
    assert.notEqual(third.executor?.appCredential?.fingerprint, shared.fingerprint);
    assert.equal(third.executor?.binding?.appId, DEDICATED_APP);
    assert.deepEqual(resolveRepositoryComponentBinding(one, { environment: w.environment }), first);
    assert.deepEqual(resolveRepositoryComponentBinding(two, { environment: w.environment }), second);
    for (const projection of [first, second, third]) {
      assert.deepEqual(serializedLeaks(projection, w.home), []);
      assert.deepEqual(findSetupSecretMaterial(projection), []);
    }
  } finally {
    w.cleanup();
  }
});

test("#1201 one Authority identity serves both repositories by reference, without key duplication", async () => {
  const w = world();
  try {
    const { identity } = prepareLocalAuthorityIdentity("runtime-shared", w.environment);
    const reference = { authorityId: identity.authorityId, publicKeyFingerprint: identity.publicKeyFingerprint };
    record(w.environment, one, { authority: reference });
    record(w.environment, two, { authority: reference });
    for (const repository of [one, two]) {
      const projection = resolveRepositoryComponentBinding(repository, { environment: w.environment });
      assert.deepEqual(projection.authority?.identity, { ...reference, custody: "authority-id" });
      assert.deepEqual(projection.conflicts, []);
      assert.deepEqual(serializedLeaks(projection, w.home), []);
    }
    assert.equal(listLocalAuthorityIdentities(w.environment).length, 1);
    assert.deepEqual(readdirSync(path.join(w.home, "authority", "keys")), ["runtime-shared"]);
    assert.deepEqual(readdirSync(path.join(w.home, "repositories", one.repositoryId)).sort(), [
      "repository.json",
      "setup.json",
    ]);

    // Another key under the referenced ID is a conflict, never adopted silently.
    const other = prepareLocalAuthorityIdentity("runtime-other", w.environment).identity;
    record(
      w.environment,
      { ...two, repositoryId: "1004", nameWithOwner: "acme/four" },
      {
        authority: { authorityId: "runtime-shared", publicKeyFingerprint: other.publicKeyFingerprint },
      },
    );
    assert.deepEqual(
      resolveRepositoryComponentBinding(
        { ...two, repositoryId: "1004", nameWithOwner: "acme/four" },
        { environment: w.environment },
      ).conflicts,
      ["authority"],
    );
  } finally {
    w.cleanup();
  }
});

test("#1201 incomplete Authority-ID custody is unreadable, not projected as configured identity", async () => {
  const w = world();
  try {
    const { identity } = prepareLocalAuthorityIdentity("runtime-broken", w.environment);
    record(w.environment, one, {
      authority: {
        authorityId: identity.authorityId,
        publicKeyFingerprint: identity.publicKeyFingerprint,
      },
    });
    unlinkSync(path.join(w.home, "authority", "keys", identity.authorityId, "private-key.pem"));
    assert.throws(
      () => resolveRepositoryComponentBinding(one, { environment: w.environment }),
      (error: unknown) => error instanceof RepositoryComponentBindingError && error.subjects.includes("authority"),
    );
  } finally {
    w.cleanup();
  }
});

test("#1201 rename preserves immutable identity and bindings; a fresh process needs no legacy exports", async () => {
  const w = world();
  try {
    const { config: executor } = await ensureLocalExecutorConfiguration(w.environment);
    const credential = enroll(w.environment, executor.id, SHARED_APP, [{ ...one, installationId: "71" }]);
    record(w.environment, one, {
      endpoint: "https://inari.example.com",
      app: { appId: SHARED_APP, installationId: "71" },
      executor: { configId: executor.id, issuerKeyFingerprint: credential.fingerprint },
    });
    const before = resolveRepositoryComponentBinding(one, { environment: w.environment });
    const renamed = { ...one, nameWithOwner: "acme/renamed" };
    record(w.environment, renamed, {});
    const registry = new RepositoryRegistry({ environment: w.environment }).get(one.repositoryId);
    assert.equal(registry?.nameWithOwner, "acme/renamed");
    // Either name resolves the same immutable repository and the same bindings.
    const fresh = { INARI_CONFIG_HOME: w.home };
    for (const observed of [renamed, one]) {
      const after = resolveRepositoryComponentBinding(observed, { environment: fresh });
      assert.deepEqual(after.repository, { ...one, nameWithOwner: "acme/renamed" });
      assert.deepEqual(after.executor, before.executor);
      assert.equal(after.endpoint, "https://inari.example.com");
    }
    // Legacy Executor exports in a shell never select or override the canonical binding.
    const exported = resolveRepositoryComponentBinding(renamed, {
      environment: {
        ...fresh,
        INARI_GITHUB_APP_ID: DEDICATED_APP,
        GITHUB_APP_ID: DEDICATED_APP,
        INARI_GITHUB_APP_PRIVATE_KEY_FILE: path.join(w.home, "elsewhere.pem"),
      },
    });
    assert.deepEqual(exported.executor, before.executor);
  } finally {
    w.cleanup();
  }
});

test("#1201 legacy custody and setup are compatibility input only and never override canonical state", async () => {
  const w = world();
  try {
    const { config: executor } = await ensureLocalExecutorConfiguration(w.environment);
    // Un-adopted legacy single-App custody with a verified repository binding.
    const legacyStore = new ExecutorCredentialStore(w.environment);
    const legacy = legacyStore.save(executor.id, SHARED_APP, pem()).record;
    legacyStore.recordBinding(legacy.generation, { ...one, installationId: "71" });
    const legacyEvidence = readExecutorCustodyEvidence(w.environment);
    assert.deepEqual(
      legacyEvidence?.credentials.map((item) => [item.appId, item.source]),
      [[SHARED_APP, "legacy"]],
    );
    assert.deepEqual(
      legacyEvidence?.bindings.map((item) => [item.repositoryId, item.status, item.source]),
      [[one.repositoryId, "bound", "legacy"]],
    );

    // A legacy runtime/setup record is read only while no canonical record exists.
    const legacyRecord = validateSetupConfigRecord({
      version: 1,
      repository: one,
      revision: 3,
      app: { appId: DEDICATED_APP },
    });
    writeLocalJson(
      "runtime",
      `setup/${setupStateFileKey(one)}.json`,
      legacyRecord,
      validateSetupConfigRecord,
      w.environment,
    );
    const compatible = resolveRepositoryComponentBinding(one, { environment: w.environment });
    assert.equal(compatible.setup?.source, "legacy");
    assert.equal(compatible.registered, false);

    // Canonical App-scoped custody and the canonical setup record win over stale legacy evidence.
    const canonical = enroll(w.environment, executor.id, SHARED_APP, [{ ...one, installationId: "71" }]);
    new SetupConfigStore({ environment: w.environment }).adopt(
      one,
      validateSetupConfigRecord({
        version: 1,
        repository: one,
        revision: 1,
        app: { appId: SHARED_APP, installationId: "71" },
        executor: { configId: executor.id, issuerKeyFingerprint: canonical.fingerprint },
      }),
    );
    const resolved = resolveRepositoryComponentBinding(one, { environment: w.environment });
    assert.equal(resolved.setup?.source, "canonical");
    assert.equal(resolved.app?.appId, SHARED_APP);
    assert.equal(resolved.executor?.appCredential?.source, "app-scoped");
    assert.equal(resolved.executor?.appCredential?.fingerprint, canonical.fingerprint);
    assert.equal(resolved.executor?.binding?.source, "app-scoped");
    assert.deepEqual(resolved.conflicts, []);
    // Legacy sources were never rewritten or removed.
    assert.equal(legacyStore.current()?.fingerprint, legacy.fingerprint);
    assert.equal(new SetupConfigStore({ environment: w.environment }).readLegacy(one)?.revision, 3);
  } finally {
    w.cleanup();
  }
});

test("#1201 contradicting owner evidence is reported as a bounded conflict; unreadable evidence fails closed", async () => {
  const w = world();
  try {
    const { config: executor } = await ensureLocalExecutorConfiguration(w.environment);
    const credential = enroll(w.environment, executor.id, DEDICATED_APP, [{ ...one, installationId: "71" }]);
    record(w.environment, one, {
      app: { appId: SHARED_APP, installationId: "71" },
      executor: { configId: executor.id, issuerKeyFingerprint: credential.fingerprint },
    });
    assert.deepEqual(resolveRepositoryComponentBinding(one, { environment: w.environment }).conflicts, [
      "executor-binding",
    ]);

    // Admission is referenced by its public component identity and the Executor it pins.
    const authority = setupLocalAuthority(w.environment);
    setupLocalAdmission(
      createDelegatorRecord({
        id: "runtime-admission",
        key: authority.config.publicKey,
        maxSessionTtlSeconds: 3600,
        capabilityCeiling: ["change.implement"],
      }),
      w.environment,
    );
    const projection = resolveRepositoryComponentBinding(one, { environment: w.environment });
    assert.equal(projection.admission?.executorId, executor.id);
    assert.match(projection.admission?.id ?? "", /^adm_/u);
    assert.deepEqual(serializedLeaks(projection, w.home), []);

    writeLocalJson(
      "executor",
      "repository-bindings/not-a-binding.json",
      { unexpected: true },
      (value) => value,
      w.environment,
    );
    assert.throws(
      () => resolveRepositoryComponentBinding(one, { environment: w.environment }),
      (error: unknown) =>
        error instanceof RepositoryComponentBindingError && error.subjects.includes("executor/custody"),
    );
  } finally {
    w.cleanup();
  }
});
