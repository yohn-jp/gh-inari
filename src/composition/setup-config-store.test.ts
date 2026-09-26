import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RepositoryRegistry } from "../local-control/repository-registry.js";
import { findSetupSecretMaterial } from "../runtime-contracts/index.js";
import {
  SetupConfigStore,
  SetupConfigStoreError,
  setupConfigRecordRelativePath,
  setupStateFileKey,
  validateSetupConfigRecord,
} from "./setup-config-store.js";

const repository = { repositoryHost: "github.com", repositoryId: "1330755860", nameWithOwner: "yohn-jp/gh-inari" };
const fingerprint = `sha256:${"a".repeat(64)}`;

function home(): { environment: NodeJS.ProcessEnv; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-setup-config-"));
  return { root, environment: { INARI_CONFIG_HOME: root } };
}

test("fresh processes read the same persisted non-secret configuration without shell exports", () => {
  const { root, environment } = home();
  try {
    const writer = new SetupConfigStore({ environment });
    assert.equal(writer.read(repository), undefined);
    const first = writer.update(repository, 0, {
      app: { appId: "123" },
      executor: { configId: "exec_1234567890123456", issuerKeyFingerprint: fingerprint },
    });
    assert.equal(first.revision, 1);
    // A different process (no inherited INARI_GITHUB_APP_ID) observes the same truth.
    const reader = new SetupConfigStore({ environment: { INARI_CONFIG_HOME: root } });
    assert.deepEqual(reader.read(repository), first);
    const file = path.join(root, "repositories", repository.repositoryId, "setup.json");
    assert.equal(setupConfigRecordRelativePath(repository), `repositories/${repository.repositoryId}/setup.json`);
    const stored: unknown = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(findSetupSecretMaterial(stored), []);
    // The canonical record lives in the repository registry next to the registry record;
    // no legacy runtime/setup record and no operator file is written.
    assert.deepEqual(readdirSync(path.join(root, "repositories", repository.repositoryId)), [
      "repository.json",
      "setup.json",
    ]);
    assert.equal(existsSync(path.join(root, "runtime", "setup")), false);
    assert.deepEqual(new RepositoryRegistry({ environment }).list(), [{ version: 1, ...repository }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updates are compare-and-replace, idempotent and never rewrite recorded identities", () => {
  const { root, environment } = home();
  try {
    const store = new SetupConfigStore({ environment });
    const first = store.update(repository, 0, { app: { appId: "123" } });
    assert.throws(() => store.update(repository, 0, { app: { appId: "123" } }), { code: "SETUP_CONFIG_STALE" });
    assert.deepEqual(store.update(repository, 1, { app: { appId: "123" } }), first);
    assert.throws(() => store.update(repository, 1, { app: { appId: "456" } }), { code: "SETUP_CONFIG_CONFLICT" });
    const bound = store.update(repository, 1, { app: { appId: "123", installationId: "99" } });
    assert.equal(bound.revision, 2);
    assert.throws(() => store.update(repository, 2, { app: { appId: "123", installationId: "98" } }), {
      code: "SETUP_CONFIG_CONFLICT",
    });
    const authority = store.update(repository, 2, {
      authority: { authorityId: "runtime-a", publicKeyFingerprint: fingerprint },
    });
    assert.throws(
      () =>
        store.update(repository, authority.revision, {
          authority: { authorityId: "runtime-b", publicKeyFingerprint: fingerprint },
        }),
      { code: "SETUP_CONFIG_CONFLICT" },
    );
    const published = store.update(repository, authority.revision, {
      publication: {
        authorityId: "runtime-a",
        number: 7,
        url: "https://github.com/yohn-jp/gh-inari/pull/7",
        branch: "inari/runtime-authority/0123456789abcdef",
      },
    });
    const cleared = store.update(repository, published.revision, { publication: null });
    assert.equal(cleared.publication, undefined);
    assert.equal(cleared.app?.installationId, "99");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the closed schema rejects secrets, tokens and unknown members", () => {
  const base = { version: 1, repository, revision: 1 };
  assert.equal(validateSetupConfigRecord(base).revision, 1);
  for (const value of [
    { ...base, token: "x" },
    { ...base, app: { appId: "1", privateKey: "x" } },
    { ...base, app: { appId: "1", clientId: "-----BEGIN PRIVATE KEY-----" } },
    { ...base, endpoint: "https://user:pass@example.com" },
    { ...base, endpoint: "https://example.com/?access_token=ghp_abcdefghijklmnopqrstuvwxyz" },
    { ...base, executor: { configId: "exec_1234567890123456", issuerKeyFingerprint: "not-a-fingerprint" } },
    { ...base, revision: 0 },
  ]) {
    assert.throws(() => validateSetupConfigRecord(value), SetupConfigStoreError);
  }
});

test("a store rejects an unreadable record instead of treating it as absent", () => {
  const { root, environment } = home();
  try {
    const store = new SetupConfigStore({ environment });
    store.update(repository, 0, { app: { appId: "123" } });
    const file = path.join(root, "repositories", repository.repositoryId, "setup.json");
    rmSync(file);
    writeFileSync(file, "{", { mode: 0o600 });
    assert.throws(() => store.read(repository), { code: "SETUP_CONFIG_UNREADABLE" });
    assert.throws(() => store.update(repository, 1, { app: { appId: "123" } }), { code: "SETUP_CONFIG_UNREADABLE" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function legacyFile(root: string): string {
  return path.join(root, "runtime", "setup", `${setupStateFileKey(repository)}.json`);
}

function writeLegacy(root: string, value: unknown): string {
  mkdirSync(path.join(root, "runtime", "setup"), { recursive: true, mode: 0o700 });
  const file = legacyFile(root);
  writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return file;
}

test("a legacy-only record stays readable and is copied forward on the next update without touching it", () => {
  const { root, environment } = home();
  try {
    const legacy = { version: 1, repository, revision: 3, app: { appId: "123" } };
    const file = writeLegacy(root, legacy);
    const before = readFileSync(file, "utf8");
    const store = new SetupConfigStore({ environment });
    assert.deepEqual(store.read(repository), legacy);
    assert.equal(store.observe(repository)?.source, "legacy");
    assert.equal(store.readCanonical(repository), undefined);
    assert.throws(() => store.update(repository, 0, { endpoint: "https://runtime.example.test" }), {
      code: "SETUP_CONFIG_STALE",
    });
    assert.throws(() => store.update(repository, 3, { app: { appId: "456" } }), { code: "SETUP_CONFIG_CONFLICT" });
    assert.equal(store.readCanonical(repository), undefined);
    const next = store.update(repository, 3, { endpoint: "https://runtime.example.test" });
    assert.equal(next.revision, 4);
    assert.equal(store.observe(repository)?.source, "canonical");
    assert.equal(readFileSync(file, "utf8"), before);
    // Later legacy drift never overrides the canonical record.
    writeFileSync(file, `${JSON.stringify({ ...legacy, revision: 9, app: { appId: "999" } })}\n`, { mode: 0o600 });
    assert.deepEqual(store.read(repository), next);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rename keeps the same setup path and refreshes registry display metadata only", () => {
  const { root, environment } = home();
  try {
    const store = new SetupConfigStore({ environment });
    const first = store.update(repository, 0, { app: { appId: "123" } });
    const renamed = { ...repository, nameWithOwner: "yohn-jp/inari-renamed" };
    assert.deepEqual(store.read(renamed), first);
    const next = store.update(renamed, first.revision, { endpoint: "https://runtime.example.test" });
    assert.equal(next.repository.nameWithOwner, "yohn-jp/inari-renamed");
    assert.equal(next.app?.appId, "123");
    assert.deepEqual(readdirSync(path.join(root, "repositories")), [repository.repositoryId]);
    assert.equal(
      new RepositoryRegistry({ environment }).get(repository.repositoryId)?.nameWithOwner,
      renamed.nameWithOwner,
    );
    // The same repository ID under another host is never reused.
    const foreign = { ...repository, repositoryHost: "ghe.example.test" };
    assert.throws(() => store.read(foreign), { code: "SETUP_CONFIG_UNREADABLE" });
    assert.throws(() => store.update(foreign, 0, { app: { appId: "1" } }), SetupConfigStoreError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
