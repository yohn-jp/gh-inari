import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RepositoryRegistry } from "../local-control/repository-registry.js";
import { LocalRuntimeProfileStore, type LocalRuntimeProfile } from "../local-runtime-profile.js";
import { findSetupSecretMaterial } from "../runtime-contracts/index.js";
import { migrateLegacySetupConfig, reconcileLegacySetupConfig } from "./setup-config-migration.js";
import { SetupConfigStore, setupStateFileKey } from "./setup-config-store.js";

const repository = { repositoryHost: "github.com", repositoryId: "1330755860", nameWithOwner: "yohn-jp/gh-inari" };
const fingerprint = `sha256:${"a".repeat(64)}`;
const executor = { configId: "exec_1234567890123456", issuerKeyFingerprint: `sha256:${"b".repeat(64)}` };

function home(): { environment: NodeJS.ProcessEnv; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-setup-migration-"));
  return { root, environment: { INARI_CONFIG_HOME: root } };
}

function legacySetup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    repository,
    revision: 2,
    endpoint: "https://runtime.example.test",
    app: { appId: "123", installationId: "77" },
    executor,
    ...overrides,
  };
}

function writeLegacySetup(root: string, value: unknown): string {
  mkdirSync(path.join(root, "runtime", "setup"), { recursive: true, mode: 0o700 });
  const file = path.join(root, "runtime", "setup", `${setupStateFileKey(repository)}.json`);
  writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return file;
}

function runtimeProfile(overrides: Partial<LocalRuntimeProfile> = {}): LocalRuntimeProfile {
  return {
    version: 1,
    state: "ready",
    endpoint: "https://runtime.example.test",
    relayUrl: "wss://relay.example.test/connect",
    repository: {
      repositoryHost: "github.com",
      repositoryId: "1330755860",
      repositoryNameWithOwner: "yohn-jp/old-name",
    },
    app: { appId: "123", installationId: "77", clientId: "Iv1.public" },
    authority: {
      authorityId: "runtime-a",
      publicKeyFingerprint: fingerprint,
      privateKeyPath: "/secure/runtime-key.pem",
    },
    ...overrides,
  };
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const directory of [path.join(root, "runtime", "setup"), path.join(root, "runtime-profiles")]) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory)) files[entry] = readFileSync(path.join(directory, entry), "utf8");
  }
  return files;
}

function canonicalFile(root: string): string {
  return path.join(root, "repositories", repository.repositoryId, "setup.json");
}

test("a valid legacy runtime/setup record is adopted idempotently and legacy files stay untouched", async () => {
  const { root, environment } = home();
  try {
    writeLegacySetup(root, legacySetup());
    const before = snapshot(root);
    const first = await migrateLegacySetupConfig(repository, { environment });
    assert.equal(first.outcome, "adopted");
    assert.deepEqual(first.sources, ["runtime-setup"]);
    assert.deepEqual(first.record, legacySetup());
    const second = await migrateLegacySetupConfig(repository, { environment });
    assert.equal(second.outcome, "canonical");
    assert.deepEqual(second.record, first.record);
    assert.deepEqual(snapshot(root), before);
    // A fresh process reads the canonical record without environment exports.
    const reader = new SetupConfigStore({ environment: { INARI_CONFIG_HOME: root } });
    assert.equal(reader.observe(repository)?.source, "canonical");
    assert.deepEqual(reader.read(repository), first.record);
    assert.deepEqual(new RepositoryRegistry({ environment }).list(), [{ version: 1, ...repository }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a compatible Runtime profile contributes only public missing fields", async () => {
  const { root, environment } = home();
  try {
    writeLegacySetup(root, legacySetup({ endpoint: undefined, app: { appId: "123" } }));
    await new LocalRuntimeProfileStore({ configHome: root }).save(runtimeProfile());
    const before = snapshot(root);
    const result = await migrateLegacySetupConfig(repository, { environment });
    assert.equal(result.outcome, "adopted");
    assert.deepEqual(result.sources, ["runtime-setup", "runtime-profile"]);
    assert.deepEqual(result.record, {
      version: 1,
      repository,
      revision: 3,
      endpoint: "https://runtime.example.test",
      app: { appId: "123", installationId: "77", clientId: "Iv1.public" },
      executor,
      authority: { authorityId: "runtime-a", publicKeyFingerprint: fingerprint },
    });
    const stored = readFileSync(canonicalFile(root), "utf8");
    assert.doesNotMatch(stored, /privateKeyPath|runtime-key\.pem|relayUrl|"state"/u);
    assert.deepEqual(findSetupSecretMaterial(JSON.parse(stored) as unknown), []);
    assert.deepEqual(snapshot(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Runtime profile alone is adopted without generating any identity", async () => {
  const { root, environment } = home();
  try {
    await new LocalRuntimeProfileStore({ configHome: root }).save(runtimeProfile({ state: "trust-pending" }));
    const result = await migrateLegacySetupConfig(repository, { environment });
    assert.equal(result.outcome, "adopted");
    assert.deepEqual(result.record, {
      version: 1,
      repository,
      revision: 1,
      endpoint: "https://runtime.example.test",
      app: { appId: "123", installationId: "77", clientId: "Iv1.public" },
      authority: { authorityId: "runtime-a", publicKeyFingerprint: fingerprint },
    });
    assert.equal(result.record?.executor, undefined);
    assert.equal(result.record?.publication, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no legacy source adopts nothing and writes nothing", async () => {
  const { root, environment } = home();
  try {
    const result = await migrateLegacySetupConfig(repository, { environment });
    assert.deepEqual(result, { outcome: "absent", sources: [] });
    assert.equal(existsSync(path.join(root, "repositories")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conflicting App, installation, Authority or endpoint evidence blocks migration before any write", async () => {
  const cases: readonly [string, Record<string, unknown>, Partial<LocalRuntimeProfile>][] = [
    ["App", {}, { app: { appId: "456", installationId: "77" } }],
    ["installation", {}, { app: { appId: "123", installationId: "78" } }],
    ["client", { app: { appId: "123", clientId: "Iv1.other" } }, {}],
    ["Authority", { authority: { authorityId: "runtime-b", publicKeyFingerprint: fingerprint } }, {}],
    [
      "Authority fingerprint",
      { authority: { authorityId: "runtime-a", publicKeyFingerprint: `sha256:${"c".repeat(64)}` } },
      {},
    ],
    ["endpoint", {}, { endpoint: "https://other-runtime.example.test" }],
  ];
  for (const [name, setup, profile] of cases) {
    const { root, environment } = home();
    try {
      writeLegacySetup(root, legacySetup(setup));
      await new LocalRuntimeProfileStore({ configHome: root }).save(runtimeProfile(profile));
      const before = snapshot(root);
      await assert.rejects(
        migrateLegacySetupConfig(repository, { environment }),
        {
          code: "SETUP_CONFIG_MIGRATION_CONFLICT",
        },
        name,
      );
      assert.equal(existsSync(path.join(root, "repositories")), false, name);
      assert.deepEqual(snapshot(root), before, name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("ambiguous Runtime profiles and foreign repository identities block migration", async () => {
  const { root, environment } = home();
  try {
    const profiles = new LocalRuntimeProfileStore({ configHome: root });
    await profiles.save(runtimeProfile());
    await profiles.save(runtimeProfile({ endpoint: "https://second-runtime.example.test" }));
    await assert.rejects(migrateLegacySetupConfig(repository, { environment }), {
      code: "SETUP_CONFIG_MIGRATION_CONFLICT",
    });
    assert.equal(existsSync(path.join(root, "repositories")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.throws(
    () =>
      reconcileLegacySetupConfig(
        repository,
        undefined,
        runtimeProfile({
          repository: {
            repositoryHost: "ghe.example.test",
            repositoryId: "1330755860",
            repositoryNameWithOwner: "a/b",
          },
        }),
      ),
    { code: "SETUP_CONFIG_MIGRATION_CONFLICT" },
  );
  // A registry entry for the same ID under another host is an identity conflict, not reuse.
  const other = home();
  try {
    new RepositoryRegistry({ environment: other.environment }).register({
      ...repository,
      repositoryHost: "ghe.example.test",
    });
    writeLegacySetup(other.root, legacySetup());
    await assert.rejects(migrateLegacySetupConfig(repository, { environment: other.environment }), {
      code: "SETUP_CONFIG_MIGRATION_CONFLICT",
    });
    assert.equal(existsSync(canonicalFile(other.root)), false);
  } finally {
    rmSync(other.root, { recursive: true, force: true });
  }
});

test("unreadable or secret-bearing legacy sources fail closed without a canonical record", async () => {
  const { root, environment } = home();
  try {
    const file = writeLegacySetup(root, { ...legacySetup(), token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    const before = readFileSync(file, "utf8");
    await assert.rejects(migrateLegacySetupConfig(repository, { environment }), {
      code: "SETUP_CONFIG_MIGRATION_UNREADABLE",
    });
    assert.equal(existsSync(path.join(root, "repositories")), false);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interrupted migration that registered the repository but wrote no setup record is retried cleanly", async () => {
  const { root, environment } = home();
  try {
    writeLegacySetup(root, legacySetup());
    // Simulate an interruption after registry registration and before the setup write.
    new RepositoryRegistry({ environment }).register(repository);
    const store = new SetupConfigStore({ environment });
    assert.equal(store.readCanonical(repository), undefined);
    assert.equal(store.observe(repository)?.source, "legacy");
    const result = await migrateLegacySetupConfig(repository, { environment });
    assert.equal(result.outcome, "adopted");
    assert.equal(store.observe(repository)?.source, "canonical");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the canonical record wins over later legacy drift and is never replaced", async () => {
  const { root, environment } = home();
  try {
    writeLegacySetup(root, legacySetup());
    const adopted = await migrateLegacySetupConfig(repository, { environment });
    writeLegacySetup(root, legacySetup({ revision: 9, app: { appId: "999", installationId: "1" } }));
    await new LocalRuntimeProfileStore({ configHome: root }).save(
      runtimeProfile({ app: { appId: "555", installationId: "5" } }),
    );
    const again = await migrateLegacySetupConfig(repository, { environment });
    assert.equal(again.outcome, "canonical");
    assert.deepEqual(again.record, adopted.record);
    assert.deepEqual(new SetupConfigStore({ environment }).read(repository), adopted.record);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rename adopts under the same ID path and refreshes registry display metadata only", async () => {
  const { root, environment } = home();
  try {
    writeLegacySetup(root, legacySetup());
    const adopted = await migrateLegacySetupConfig(repository, { environment });
    const renamed = { ...repository, nameWithOwner: "yohn-jp/inari" };
    const store = new SetupConfigStore({ environment });
    assert.deepEqual(store.read(renamed), adopted.record);
    const updated = store.update(renamed, adopted.record!.revision, {
      publication: {
        authorityId: "runtime-a",
        number: 7,
        url: "https://github.com/yohn-jp/inari/pull/7",
        branch: "inari/runtime-authority/0123456789abcdef",
      },
    });
    assert.equal(updated.repository.nameWithOwner, "yohn-jp/inari");
    assert.deepEqual(readdirSync(path.join(root, "repositories")), [repository.repositoryId]);
    assert.deepEqual(new RepositoryRegistry({ environment }).list(), [{ version: 1, ...renamed }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
