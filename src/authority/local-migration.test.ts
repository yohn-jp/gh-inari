import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  delegatorPublicKeyFingerprint,
  generateAndPersistDelegatorKeyPair,
  loadDelegatorKeyPair,
  type DelegatorKeyPair,
} from "../agent-authority/delegator-key.js";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import type { Delegator } from "../agent-authority/delegator.js";
import { readLocalAdmissionConfiguration } from "../admission/setup.js";
import {
  localComponentPath,
  validateLocalAdmissionConfig,
  validateLocalCliConfig,
  validateLocalComponentIdentity,
  validateLocalExecutorConfig,
  writeLocalJson,
} from "../local-control/config.js";
import { publishLocalRuntimeEndpoint, readLocalRuntimeEndpoint } from "../local-control/runtime-discovery.js";
import { LocalRuntimeProfileStore, type LocalRuntimeProfile } from "../local-runtime-profile.js";
import { selectSetupAuthority } from "./setup-trust.js";
import {
  applyLocalConfigMigration,
  LOCAL_CONFIG_MIGRATION_STEPS,
  previewLocalConfigMigration,
  type LocalConfigMigrationRequest,
  type LocalConfigMigrationStep,
} from "./local-migration.js";

const ADMISSION_ID = "adm_0123456789abcdefABCD";
const EXECUTOR_ID = "exec_0123456789abcdefABCD";
const AUTHORITY_ID = "runtime-migration-test";
const REPOSITORY = { repositoryHost: "github.com", repositoryId: "1330755860", repositoryNameWithOwner: "acme/inari" };
const ENDPOINT = "https://endpoint.example.test";

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly key: DelegatorKeyPair;
  readonly sourceKeyPath: string;
  readonly adopted: Delegator;
  readonly profile: LocalRuntimeProfile;
  readonly request: LocalConfigMigrationRequest;
}

interface FixtureOptions {
  /** 0.15 persisted fixed endpoints; 0.16 relies on runtime discovery only. */
  readonly release?: "0.15" | "0.16";
  /** Legacy pin differing from the adopted record only in a mutable lifecycle field. */
  readonly pin?: "legacy" | "canonical" | "absent";
}

function pinFrom(adopted: Delegator, overrides: Partial<Delegator> = {}): Delegator {
  return { ...adopted, ...overrides };
}

/** Isolated temp config home populated with observed legacy state; never the operator's home. */
async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-local-migration-"));
  const home = path.join(root, "config");
  const environment: NodeJS.ProcessEnv = { INARI_CONFIG_HOME: home };
  const sourceKeyPath = path.join(home, "runtime-keys", "legacy-runtime-key.pem");
  const key = generateAndPersistDelegatorKeyPair(sourceKeyPath);
  const canonical = createDelegatorRecord({
    id: AUTHORITY_ID,
    key,
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement"],
  });
  const profile: LocalRuntimeProfile = {
    version: 1,
    state: "ready",
    endpoint: ENDPOINT,
    relayUrl: "wss://relay.example.test/connect",
    repository: REPOSITORY,
    app: { appId: "42", installationId: "7" },
    authority: {
      authorityId: AUTHORITY_ID,
      publicKeyFingerprint: delegatorPublicKeyFingerprint(key),
      privateKeyPath: sourceKeyPath,
    },
  };
  await new LocalRuntimeProfileStore({ environment }).save(profile);
  // #1115 adoption result: canonical trust selected for the existing profile key.
  const adopted = selectSetupAuthority({
    repository: REPOSITORY,
    profile,
    authorityId: AUTHORITY_ID,
    key,
    local: [],
    canonical: [canonical],
    maxSessionTtlSeconds: 3_600,
  });

  const legacy = (options.release ?? "0.15") === "0.15";
  writeLocalJson(
    "cli",
    "config.json",
    {
      version: 1,
      topology: { admission: "local", executor: "local" },
      admission: legacy ? { id: ADMISSION_ID, endpoint: "http://127.0.0.1:8081" } : { id: ADMISSION_ID },
    },
    validateLocalCliConfig,
    environment,
  );
  writeLocalJson(
    "admission",
    "identity.json",
    { version: 1, id: ADMISSION_ID },
    (value) => validateLocalComponentIdentity(value, "admission"),
    environment,
  );
  writeLocalJson(
    "admission",
    "config.json",
    {
      version: 1,
      id: ADMISSION_ID,
      listen: { host: "127.0.0.1", port: legacy ? 8081 : 0 },
      executor: legacy ? { id: EXECUTOR_ID, endpoint: "http://127.0.0.1:8082" } : { id: EXECUTOR_ID },
    },
    validateLocalAdmissionConfig,
    environment,
  );
  writeLocalJson(
    "executor",
    "config.json",
    {
      version: 1,
      id: EXECUTOR_ID,
      listen: { host: "127.0.0.1", port: legacy ? 8082 : 0 },
      provider: { kind: "github", credentialProfile: "github-app-installation" },
    },
    validateLocalExecutorConfig,
    environment,
  );
  const pin = options.pin ?? (legacy ? "legacy" : "canonical");
  if (pin !== "absent")
    writeLocalJson(
      "admission",
      "runtime-authority.json",
      pin === "legacy" ? pinFrom(adopted, { notAfter: "2027-01-01T00:00:00.000Z" }) : adopted,
      (value) => value as Delegator,
      environment,
    );
  // Unknown and Session material that migration must never touch.
  await writeFile(path.join(home, "admission", "operator-notes.txt"), "keep\n", { mode: 0o600 });
  writeLocalJson("admission", "sessions/session-1.json", { id: "session-1" }, (value) => value, environment);
  return {
    root,
    home,
    environment,
    key,
    sourceKeyPath,
    adopted,
    profile,
    request: { identity: { endpoint: ENDPOINT, repository: REPOSITORY }, adoptedAuthority: adopted, environment },
  };
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const info = await stat(full);
        result[path.relative(directory, full)] = `${info.mtimeMs}:${(await readFile(full)).toString("base64")}`;
      }
    }
  }
  await walk(directory);
  return result;
}

async function json(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

/** No private-key material; `publicPin` permits the public key inside an exact public pin copy. */
function assertSecretFree(value: unknown, fixtureValue: Fixture, pem: string, publicPin = false): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const privateJwk = fixtureValue.key.privateKey.export({ format: "jwk" }) as { d?: string };
  const pemBody = pem.replace(/-----[A-Z ]+-----|\s/gu, "");
  assert.doesNotMatch(serialized, /PRIVATE KEY|"d":/u);
  assert.equal(serialized.includes(pemBody), false);
  assert.equal(serialized.includes(pemBody.slice(-44)), false);
  assert.ok(privateJwk.d !== undefined && !serialized.includes(privateJwk.d));
  if (!publicPin) assert.equal(serialized.includes(fixtureValue.key.publicKeyJwk.x), false);
}

async function withFixture(options: FixtureOptions, run: (value: Fixture) => Promise<void>): Promise<void> {
  const value = await fixture(options);
  try {
    await run(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
}

test("observed 0.15 fixed-endpoint state migrates through preview and confirmation without manual edits", async () => {
  await withFixture({ release: "0.15" }, async (value) => {
    const pem = await readFile(value.sourceKeyPath, "utf8");
    const before = await snapshot(value.root);
    const preview = await previewLocalConfigMigration(value.request);
    assert.deepEqual(await snapshot(value.root), before, "preview must not write");
    assert.equal(preview.status, "ready");
    assert.deepEqual(preview.steps, LOCAL_CONFIG_MIGRATION_STEPS);
    assert.deepEqual(preview.blockers, []);
    assert.match(preview.generation, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(preview.evidence.cli !== "absent" && preview.evidence.cli !== "unreadable", true);
    assert.deepEqual(preview.evidence.authority.custodyKey, "absent");
    assert.equal(preview.evidence.authority.profileKey, delegatorPublicKeyFingerprint(value.key));
    assertSecretFree(preview, value, pem);
    assert.deepEqual(await previewLocalConfigMigration(value.request), preview, "preview is deterministic");

    const unconfirmed = await applyLocalConfigMigration({
      ...value.request,
      generation: preview.generation,
      confirm: false,
    });
    assert.equal(unconfirmed.status, "unconfirmed");
    assert.deepEqual(await snapshot(value.root), before);

    const applied = await applyLocalConfigMigration({
      ...value.request,
      generation: preview.generation,
      confirm: true,
    });
    assert.equal(applied.status, "migrated");
    assert.equal(applied.ready, true);
    assert.deepEqual(applied.completedSteps, LOCAL_CONFIG_MIGRATION_STEPS);
    assert.deepEqual(applied.operatorActions, ["restart-runtime", "close-existing-sessions"]);
    assertSecretFree(applied, value, pem);

    const { environment } = value;
    assert.deepEqual(await json(localComponentPath("cli", "config.json", environment)), {
      version: 1,
      topology: { admission: "local", executor: "local" },
      admission: { id: ADMISSION_ID },
    });
    assert.deepEqual(await json(localComponentPath("admission", "config.json", environment)), {
      version: 1,
      id: ADMISSION_ID,
      listen: { host: "127.0.0.1", port: 8081 },
      executor: { id: EXECUTOR_ID },
    });
    const configured = readLocalAdmissionConfiguration(environment);
    assert.deepEqual(configured.runtimeAuthority, value.adopted);
    assert.equal(configured.config.id, ADMISSION_ID);
    assert.equal(
      ((await json(localComponentPath("executor", "config.json", environment))) as { id: string }).id,
      EXECUTOR_ID,
    );

    const custody = localComponentPath("authority", "private-key.pem", environment);
    assert.equal(
      delegatorPublicKeyFingerprint(loadDelegatorKeyPair(custody)),
      delegatorPublicKeyFingerprint(value.key),
    );
    assert.equal((await lstat(custody)).mode & 0o077, 0);
    assert.equal(await readFile(value.sourceKeyPath, "utf8"), pem, "source key is copied, never moved");
    assert.equal(
      ((await json(localComponentPath("authority", "config.json", environment))) as { publicKeyFingerprint: string })
        .publicKeyFingerprint,
      delegatorPublicKeyFingerprint(value.key),
    );
    const profile = await new LocalRuntimeProfileStore({ environment }).load(value.profile);
    assert.deepEqual(profile, {
      ...value.profile,
      authority: { ...value.profile.authority, privateKeyPath: custody },
    });

    // Bounded recovery evidence: exact copies of replaced public/config records, no secret.
    assert.ok(applied.recoveryPath !== undefined);
    const recovery = applied.recoveryPath;
    assert.deepEqual((await readdir(recovery)).sort(), [
      "admission-config.json",
      "admission-runtime-authority.json",
      "cli-config.json",
      "manifest.json",
      "runtime-profile.json",
    ]);
    const originalFiles = before;
    assert.deepEqual(
      await readFile(path.join(recovery, "cli-config.json"), "utf8"),
      Buffer.from(originalFiles["config/cli/config.json"]?.split(":")[1] ?? "", "base64").toString("utf8"),
    );
    assert.deepEqual(await json(path.join(recovery, "runtime-profile.json")), value.profile);
    const manifest = await json(path.join(recovery, "manifest.json"));
    assert.equal((manifest as { generation: string }).generation, preview.generation);
    assertSecretFree(manifest, value, pem);
    for (const entry of await readdir(recovery))
      assertSecretFree(await readFile(path.join(recovery, entry), "utf8"), value, pem, true);

    // Unknown files and Session state are untouched.
    assert.equal(await readFile(path.join(value.home, "admission", "operator-notes.txt"), "utf8"), "keep\n");
    assert.deepEqual(await json(path.join(value.home, "admission", "sessions", "session-1.json")), { id: "session-1" });
  });
});

test("retry after migration is idempotent and preserves IDs, keys and trust fields", async () => {
  await withFixture({ release: "0.15" }, async (value) => {
    const first = await previewLocalConfigMigration(value.request);
    await applyLocalConfigMigration({ ...value.request, generation: first.generation, confirm: true });
    const migrated = await snapshot(value.root);

    const stale = await applyLocalConfigMigration({ ...value.request, generation: first.generation, confirm: true });
    assert.equal(stale.status, "stale");
    assert.equal(stale.ready, false);

    const again = await previewLocalConfigMigration(value.request);
    assert.equal(again.status, "migrated");
    assert.deepEqual(again.steps, []);
    const retry = await applyLocalConfigMigration({ ...value.request, generation: again.generation, confirm: true });
    assert.equal(retry.status, "migrated");
    assert.equal(retry.ready, true);
    assert.deepEqual(retry.completedSteps, []);
    assert.deepEqual(await snapshot(value.root), migrated, "retry performs no write");
    assert.deepEqual(readLocalAdmissionConfiguration(value.environment).runtimeAuthority, value.adopted);
  });
});

test("0.16 discovery state converges key custody and profile while preserving the canonical pin", async () => {
  await withFixture({ release: "0.16", pin: "canonical" }, async (value) => {
    const pinPath = localComponentPath("admission", "runtime-authority.json", value.environment);
    const pinBefore = await readFile(pinPath, "utf8");
    const preview = await previewLocalConfigMigration(value.request);
    assert.deepEqual(preview.steps, ["recovery-evidence", "authority-key", "authority-descriptor", "runtime-profile"]);
    const applied = await applyLocalConfigMigration({
      ...value.request,
      generation: preview.generation,
      confirm: true,
    });
    assert.equal(applied.status, "migrated");
    assert.equal(await readFile(pinPath, "utf8"), pinBefore);
    assert.deepEqual((await readdir(applied.recoveryPath ?? "")).sort(), ["manifest.json", "runtime-profile.json"]);
  });
});

test("a missing Admission pin is bound to the exact adopted canonical record", async () => {
  await withFixture({ release: "0.16", pin: "absent" }, async (value) => {
    const preview = await previewLocalConfigMigration(value.request);
    assert.ok(preview.steps.includes("admission-pin"));
    const applied = await applyLocalConfigMigration({
      ...value.request,
      generation: preview.generation,
      confirm: true,
    });
    assert.equal(applied.status, "migrated");
    assert.deepEqual(readLocalAdmissionConfiguration(value.environment).runtimeAuthority, value.adopted);
  });
});

test("stale confirmation and evidence drift are rejected before any mutation", async () => {
  await withFixture({ release: "0.15" }, async (value) => {
    const preview = await previewLocalConfigMigration(value.request);
    const cliPath = localComponentPath("cli", "config.json", value.environment);
    const drifted = {
      version: 1,
      topology: { admission: "local", executor: "local" },
      admission: { id: ADMISSION_ID, endpoint: "http://127.0.0.1:9091" },
    };
    await writeFile(cliPath, `${JSON.stringify(drifted)}\n`, { mode: 0o600 });
    const before = await snapshot(value.root);
    const result = await applyLocalConfigMigration({ ...value.request, generation: preview.generation, confirm: true });
    assert.equal(result.status, "stale");
    assert.notEqual(result.currentGeneration, preview.generation);
    assert.deepEqual(await snapshot(value.root), before);
    const wrong = await applyLocalConfigMigration({
      ...value.request,
      generation: `sha256:${"0".repeat(64)}`,
      confirm: true,
    });
    assert.equal(wrong.status, "stale");
    assert.deepEqual(await snapshot(value.root), before);
  });
});

test("an active Admission or Executor announcement blocks until the operator stops the Runtime", async () => {
  await withFixture({ release: "0.15" }, async (value) => {
    for (const component of ["admission", "executor"] as const) {
      const announcement = publishLocalRuntimeEndpoint(
        component,
        component === "admission" ? ADMISSION_ID : EXECUTOR_ID,
        component === "admission" ? 18081 : 18082,
        value.environment,
      );
      const before = await snapshot(value.root);
      const preview = await previewLocalConfigMigration(value.request);
      assert.equal(preview.status, "blocked");
      assert.deepEqual(preview.blockers, [{ code: "RUNTIME_ACTIVE", subject: component }]);
      assert.deepEqual(preview.operatorActions, ["stop-runtime"]);
      const result = await applyLocalConfigMigration({
        ...value.request,
        generation: preview.generation,
        confirm: true,
      });
      assert.equal(result.status, "blocked");
      assert.deepEqual(await snapshot(value.root), before);
      assert.deepEqual(readLocalRuntimeEndpoint(component, value.environment), announcement, "never stops processes");
      await rm(localComponentPath("runtime", `endpoints/${component}.json`, value.environment));
    }
    assert.equal((await previewLocalConfigMigration(value.request)).status, "ready");
  });
});

test("trust changes, identity conflicts and ambiguous state are safely rejected", async () => {
  const cases: readonly [string, (value: Fixture) => Promise<LocalConfigMigrationRequest | void>, string, string][] = [
    [
      "different pinned key",
      async (value) => {
        const other = generateAndPersistDelegatorKeyPair(path.join(value.root, "other.pem"));
        const pin = createDelegatorRecord({
          id: AUTHORITY_ID,
          key: other,
          notBefore: new Date("2026-08-01T00:00:00.000Z"),
          maxSessionTtlSeconds: 3_600,
          capabilityCeiling: ["change.implement"],
        });
        await writeFile(
          localComponentPath("admission", "runtime-authority.json", value.environment),
          JSON.stringify(pin),
          {
            mode: 0o600,
          },
        );
      },
      "TRUST_CHANGE_REQUIRED",
      "admission/runtime-authority.json",
    ],
    [
      "different pinned Authority ID",
      async (value) => {
        await writeFile(
          localComponentPath("admission", "runtime-authority.json", value.environment),
          JSON.stringify({ ...value.adopted, id: "runtime-other" }),
          { mode: 0o600 },
        );
      },
      "TRUST_CHANGE_REQUIRED",
      "admission/runtime-authority.json",
    ],
    [
      "wider pinned capability ceiling",
      async (value) => {
        await writeFile(
          localComponentPath("admission", "runtime-authority.json", value.environment),
          JSON.stringify({ ...value.adopted, capabilityCeiling: ["change.implement", "change.merge"] }),
          { mode: 0o600 },
        );
      },
      "TRUST_CHANGE_REQUIRED",
      "admission/runtime-authority.json",
    ],
    [
      "different immutable notBefore",
      async (value) => {
        await writeFile(
          localComponentPath("admission", "runtime-authority.json", value.environment),
          JSON.stringify({ ...value.adopted, notBefore: "2026-09-01T00:00:00.000Z" }),
          { mode: 0o600 },
        );
      },
      "TRUST_CHANGE_REQUIRED",
      "admission/runtime-authority.json",
    ],
    [
      "adopted record for another Authority",
      async (value) => {
        const other = generateAndPersistDelegatorKeyPair(path.join(value.root, "adopted-other.pem"));
        return {
          ...value.request,
          adoptedAuthority: createDelegatorRecord({
            id: "runtime-other",
            key: other,
            notBefore: new Date("2026-08-01T00:00:00.000Z"),
            maxSessionTtlSeconds: 3_600,
            capabilityCeiling: ["change.implement"],
          }),
        };
      },
      "AUTHORITY_IDENTITY_CONFLICT",
      "runtime-profile",
    ],
    [
      "conflicting custody key",
      async (value) => {
        generateAndPersistDelegatorKeyPair(localComponentPath("authority", "private-key.pem", value.environment));
      },
      "AUTHORITY_KEY_CONFLICT",
      "authority/private-key.pem",
    ],
    [
      "conflicting Authority descriptor",
      async (value) => {
        const other = generateAndPersistDelegatorKeyPair(path.join(value.root, "descriptor-other.pem"));
        writeLocalJson(
          "authority",
          "config.json",
          {
            version: 1,
            publicKey: other.publicKeyJwk,
            publicKeyFingerprint: delegatorPublicKeyFingerprint(other),
            privateKeyFile: "private-key.pem",
          },
          (entry) => entry,
          value.environment,
        );
      },
      "AUTHORITY_DESCRIPTOR_CONFLICT",
      "authority/config.json",
    ],
    [
      "missing key in both locations",
      async (value) => {
        await rm(value.sourceKeyPath);
      },
      "AUTHORITY_KEY_UNAVAILABLE",
      "authority/private-key.pem",
    ],
    [
      "CLI route for another Admission",
      async (value) => {
        await writeFile(
          localComponentPath("cli", "config.json", value.environment),
          JSON.stringify({
            version: 1,
            topology: { admission: "local", executor: "local" },
            admission: { id: "adm_fedcba9876543210ZYXW", endpoint: "http://127.0.0.1:8081" },
          }),
          { mode: 0o600 },
        );
      },
      "COMPONENT_IDENTITY_UNPROVEN",
      "cli/config.json",
    ],
    [
      "Admission bound to another Executor",
      async (value) => {
        await writeFile(
          localComponentPath("executor", "config.json", value.environment),
          JSON.stringify({
            version: 1,
            id: "exec_fedcba9876543210ZYXW",
            listen: { host: "127.0.0.1", port: 0 },
            provider: { kind: "github", credentialProfile: "github-app-installation" },
          }),
          { mode: 0o600 },
        );
      },
      "COMPONENT_IDENTITY_UNPROVEN",
      "executor/config.json",
    ],
    [
      "ambiguous repository profiles",
      async (value) => {
        await new LocalRuntimeProfileStore({ environment: value.environment }).save({
          ...value.profile,
          endpoint: "https://other-endpoint.example.test",
        });
      },
      "PROFILE_AMBIGUOUS",
      "runtime-profile",
    ],
    [
      "unreadable owned configuration",
      async (value) => {
        await writeFile(localComponentPath("admission", "config.json", value.environment), "{not json", {
          mode: 0o600,
        });
      },
      "LOCAL_STATE_UNREADABLE",
      "admission/config.json",
    ],
  ];
  for (const [name, mutate, code, subject] of cases) {
    await withFixture({ release: "0.15" }, async (value) => {
      const request = (await mutate(value)) ?? value.request;
      const before = await snapshot(value.root);
      const preview = await previewLocalConfigMigration(request);
      assert.equal(preview.status, "blocked", name);
      assert.ok(
        preview.blockers.some((blocker) => blocker.code === code && blocker.subject === subject),
        `${name}: ${JSON.stringify(preview.blockers)}`,
      );
      const result = await applyLocalConfigMigration({ ...request, generation: preview.generation, confirm: true });
      assert.equal(result.status, "blocked", name);
      assert.deepEqual(await snapshot(value.root), before, `${name}: no mutation`);
    });
  }
});

test("injected failures preserve recovery material, report truthful not-ready state, and retry converges", async () => {
  for (const failing of LOCAL_CONFIG_MIGRATION_STEPS) {
    await withFixture({ release: "0.15" }, async (value) => {
      const pem = await readFile(value.sourceKeyPath, "utf8");
      const preview = await previewLocalConfigMigration(value.request);
      const result = await applyLocalConfigMigration({
        ...value.request,
        generation: preview.generation,
        confirm: true,
        faults: {
          beforeStep: (step: LocalConfigMigrationStep) => {
            if (step === failing) throw new Error("injected interruption");
          },
        },
      });
      const index = LOCAL_CONFIG_MIGRATION_STEPS.indexOf(failing);
      assert.equal(result.status, "recovery-required", failing);
      assert.equal(result.ready, false);
      assert.equal(result.failedStep, failing);
      assert.equal(result.failureCode, "MIGRATION_STEP_FAILED");
      assert.deepEqual(result.completedSteps, LOCAL_CONFIG_MIGRATION_STEPS.slice(0, index), failing);
      assert.deepEqual(result.pendingSteps, LOCAL_CONFIG_MIGRATION_STEPS.slice(index), failing);
      // Only the recovery evidence (outside owned records) may exist when no owned record changed.
      assert.equal(result.preMigrationStateIntact, index <= 1, failing);
      assertSecretFree(result, value, pem);
      // The Runtime profile is last: it is unchanged by any earlier failure.
      assert.deepEqual(
        await new LocalRuntimeProfileStore({ environment: value.environment }).load(value.profile),
        value.profile,
      );
      assert.equal(await readFile(value.sourceKeyPath, "utf8"), pem);
      if (index > 0) {
        const recovery = result.recoveryPath ?? "";
        assert.ok((await readdir(recovery)).includes("manifest.json"));
        assert.deepEqual(await json(path.join(recovery, "runtime-profile.json")), value.profile);
      }

      const fresh = await previewLocalConfigMigration(value.request);
      assert.equal(fresh.status, "ready");
      const retried = await applyLocalConfigMigration({
        ...value.request,
        generation: fresh.generation,
        confirm: true,
      });
      assert.equal(retried.status, "migrated", failing);
      assert.equal(readLocalAdmissionConfiguration(value.environment).config.id, ADMISSION_ID);
      assert.equal(readLocalAdmissionConfiguration(value.environment).config.executor.id, EXECUTOR_ID);
      assert.deepEqual(readLocalAdmissionConfiguration(value.environment).runtimeAuthority, value.adopted);
      assert.equal((await previewLocalConfigMigration(value.request)).status, "migrated");
      if (index > 0)
        assert.ok((await readdir(result.recoveryPath ?? "")).includes("manifest.json"), "prior evidence kept");
    });
  }
});

test("owned records drifting mid-apply are never overwritten and the profile is not moved", async () => {
  await withFixture({ release: "0.15" }, async (value) => {
    const preview = await previewLocalConfigMigration(value.request);
    const admissionPath = localComponentPath("admission", "config.json", value.environment);
    const drifted = {
      version: 1,
      id: ADMISSION_ID,
      listen: { host: "127.0.0.1", port: 9999 },
      executor: { id: EXECUTOR_ID, endpoint: "http://127.0.0.1:8082" },
    };
    const result = await applyLocalConfigMigration({
      ...value.request,
      generation: preview.generation,
      confirm: true,
      faults: {
        beforeStep: (step) => {
          if (step === "admission-config") writeFileSync(admissionPath, JSON.stringify(drifted));
        },
      },
    });
    assert.equal(result.status, "recovery-required");
    assert.equal(result.failedStep, "admission-config");
    assert.equal(result.failureCode, "LOCAL_CONTROL_CONFIG_CONFLICT");
    assert.equal(result.preMigrationStateIntact, false);
    assert.deepEqual(await json(admissionPath), drifted);
    assert.deepEqual(
      await new LocalRuntimeProfileStore({ environment: value.environment }).load(value.profile),
      value.profile,
    );
  });
});

test("a Runtime started before the final profile step blocks the profile update", async () => {
  await withFixture({ release: "0.15" }, async (value) => {
    const preview = await previewLocalConfigMigration(value.request);
    const result = await applyLocalConfigMigration({
      ...value.request,
      generation: preview.generation,
      confirm: true,
      faults: {
        beforeStep: (step) => {
          if (step === "runtime-profile")
            publishLocalRuntimeEndpoint("admission", ADMISSION_ID, 18081, value.environment);
        },
      },
    });
    assert.equal(result.status, "recovery-required");
    assert.equal(result.failedStep, "runtime-profile");
    assert.equal(result.failureCode, "OWNER_STATE_UNVERIFIED");
    assert.deepEqual(result.operatorActions, ["stop-runtime"]);
    assert.deepEqual(result.blockers, [{ code: "RUNTIME_ACTIVE", subject: "admission" }]);
    assert.deepEqual(
      await new LocalRuntimeProfileStore({ environment: value.environment }).load(value.profile),
      value.profile,
    );
  });
});
