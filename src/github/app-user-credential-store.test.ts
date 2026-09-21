import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAppUserCredential } from "./app-user-credential.js";
import {
  APP_USER_CREDENTIAL_STORE_VERSION,
  AppUserCredentialStoreError,
  FileAppUserCredentialStore,
  InMemoryAppUserCredentialStore,
} from "./app-user-credential-store.js";

const CREDENTIAL = createAppUserCredential({
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  accessTokenExpiresAt: "2027-01-01T00:00:00.000Z",
  refreshTokenExpiresAt: "2027-06-01T00:00:00.000Z",
});

test("injected App-user store retains opaque credential and metadata only escapes", async () => {
  const store = new InMemoryAppUserCredentialStore();
  await store.save(CREDENTIAL);
  const loaded = await store.load();
  assert.ok(loaded);
  assert.deepEqual(loaded.metadata, CREDENTIAL.metadata);
  assert.equal(JSON.stringify(loaded.metadata).includes("secret"), false);
  await store.clear();
  assert.equal(await store.load(), undefined);
});

test("file store atomically replaces a bounded owner-restricted record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inari-app-user-"));
  const path = join(directory, "credential.json");
  const store = new FileAppUserCredentialStore({ path });
  await store.save(CREDENTIAL);
  const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.version, APP_USER_CREDENTIAL_STORE_VERSION);
  assert.equal(persisted.access_token, "access-secret");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const loaded = await store.load();
  assert.ok(loaded);
  assert.deepEqual(loaded.metadata, CREDENTIAL.metadata);
});

test("file store rejects malformed or oversized records without exposing values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inari-app-user-"));
  const path = join(directory, "credential.json");
  const store = new FileAppUserCredentialStore({ path });
  await store.save(CREDENTIAL);
  await (await import("node:fs/promises")).writeFile(path, JSON.stringify({ version: 99, access_token: "secret" }));
  await assert.rejects(
    () => store.load(),
    (error: unknown) => {
      assert.ok(error instanceof AppUserCredentialStoreError);
      assert.equal(String(error).includes("secret"), false);
      return true;
    },
  );
});
