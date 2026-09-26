import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findSetupSecretMaterial } from "../runtime-contracts/index.js";
import {
  SetupConfigStore,
  SetupConfigStoreError,
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
    const file = path.join(root, "runtime", "setup", `${setupStateFileKey(repository)}.json`);
    const stored: unknown = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(findSetupSecretMaterial(stored), []);
    // Only the setup record exists below runtime/setup; no operator file is touched.
    assert.deepEqual(readdirSync(path.join(root, "runtime", "setup")), [`${setupStateFileKey(repository)}.json`]);
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
    const file = path.join(root, "runtime", "setup", `${setupStateFileKey(repository)}.json`);
    rmSync(file);
    writeFileSync(file, "{", { mode: 0o600 });
    assert.throws(() => store.read(repository), { code: "SETUP_CONFIG_UNREADABLE" });
    assert.throws(() => store.update(repository, 1, { app: { appId: "123" } }), { code: "SETUP_CONFIG_UNREADABLE" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
