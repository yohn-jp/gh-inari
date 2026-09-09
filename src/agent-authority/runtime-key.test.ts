import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  RuntimeAuthorityKeyError,
  canonicalRuntimeAuthorityPublicKeyJson,
  exportRuntimeAuthorityPublicKey,
  generateAndPersistRuntimeAuthorityKeyPair,
  generateRuntimeAuthorityKeyPair,
  loadRuntimeAuthorityKeyPair,
  loadRuntimeAuthorityPrivateKey,
  persistRuntimeAuthorityPrivateKey,
} from "./runtime-key.js";

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-runtime-key-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("generates Ed25519 keypairs and exports only a #367-compatible public JWK", () => {
  const pair = generateRuntimeAuthorityKeyPair();
  assert.equal(pair.privateKey.type, "private");
  assert.equal(pair.privateKey.asymmetricKeyType, "ed25519");
  assert.deepEqual(Object.keys(pair.publicKeyJwk).sort(), ["crv", "kty", "x"]);
  assert.equal(pair.publicKeyJwk.kty, "OKP");
  assert.equal(pair.publicKeyJwk.crv, "Ed25519");
  assert.equal("d" in pair.publicKeyJwk, false);
  assert.equal(exportRuntimeAuthorityPublicKey(pair.privateKey).x, pair.publicKeyJwk.x);

  const first = canonicalRuntimeAuthorityPublicKeyJson(pair.publicKeyJwk);
  const second = canonicalRuntimeAuthorityPublicKeyJson({
    x: pair.publicKeyJwk.x,
    kty: pair.publicKeyJwk.kty,
    crv: pair.publicKeyJwk.crv,
  });
  assert.equal(first, second);
  assert.equal(first, `{"crv":"Ed25519","kty":"OKP","x":"${pair.publicKeyJwk.x}"}`);
  assert.equal(first.includes("PRIVATE KEY"), false);
});

test("persists with owner-only permissions and reloads the same public identity", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = path.join(directory, "runtime-authority.pem");
    const generated = generateRuntimeAuthorityKeyPair();
    assert.equal(persistRuntimeAuthorityPrivateKey(filePath, generated.privateKey), filePath);

    const pem = await readFile(filePath, "utf8");
    assert.match(pem, /^-----BEGIN PRIVATE KEY-----/u);
    const stat = await lstat(filePath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o777, 0o600);

    const loaded = loadRuntimeAuthorityKeyPair(filePath);
    assert.equal(loaded.publicKeyJwk.x, generated.publicKeyJwk.x);
    assert.equal(loadRuntimeAuthorityPrivateKey(filePath).asymmetricKeyType, "ed25519");
  });
});

test("fails closed for unsafe permissions, symlinks, and malformed private material", async () => {
  await withTemporaryDirectory(async (directory) => {
    const unsafePath = path.join(directory, "unsafe.pem");
    const generated = generateRuntimeAuthorityKeyPair();
    persistRuntimeAuthorityPrivateKey(unsafePath, generated.privateKey);
    await chmod(unsafePath, 0o644);
    assert.throws(
      () => loadRuntimeAuthorityPrivateKey(unsafePath),
      (error: unknown) =>
        error instanceof RuntimeAuthorityKeyError && error.code === "RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE",
    );

    const symlinkPath = path.join(directory, "link.pem");
    await symlink(unsafePath, symlinkPath);
    assert.throws(
      () => loadRuntimeAuthorityPrivateKey(symlinkPath),
      (error: unknown) =>
        error instanceof RuntimeAuthorityKeyError && error.code === "RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE",
    );
    assert.throws(
      () => persistRuntimeAuthorityPrivateKey(symlinkPath, generated.privateKey),
      (error: unknown) =>
        error instanceof RuntimeAuthorityKeyError && error.code === "RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE",
    );

    const malformedPath = path.join(directory, "malformed.pem");
    await writeFile(malformedPath, "not-a-private-key-secret", { mode: 0o600 });
    assert.throws(
      () => loadRuntimeAuthorityPrivateKey(malformedPath),
      (error: unknown) => {
        assert.equal(error instanceof RuntimeAuthorityKeyError, true);
        if (!(error instanceof RuntimeAuthorityKeyError)) return false;
        assert.equal(error.code, "RUNTIME_AUTHORITY_KEY_INVALID_PRIVATE_KEY");
        assert.equal(error.message.includes("not-a-private-key-secret"), false);
        assert.equal(error.message.includes("PRIVATE KEY"), false);
        return true;
      },
    );
  });
});

test("rejects intermediate symlink, non-directory, and writable ancestor redirection", async () => {
  await withTemporaryDirectory(async (directory) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "inari-runtime-key-outside-"));
    try {
      const generated = generateRuntimeAuthorityKeyPair();
      const redirectedAncestor = path.join(directory, "redirected-ancestor");
      await symlink(outside, redirectedAncestor);
      const redirectedPath = path.join(redirectedAncestor, "nested", "runtime.pem");

      assert.throws(
        () => persistRuntimeAuthorityPrivateKey(redirectedPath, generated.privateKey),
        (error: unknown) =>
          error instanceof RuntimeAuthorityKeyError && error.code === "RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE",
      );
      assert.throws(
        () => loadRuntimeAuthorityPrivateKey(redirectedPath),
        (error: unknown) =>
          error instanceof RuntimeAuthorityKeyError && error.code === "RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE",
      );
      await assert.rejects(lstat(path.join(outside, "nested", "runtime.pem")));

      const nonDirectory = path.join(directory, "non-directory");
      await writeFile(nonDirectory, "not-a-directory", { mode: 0o600 });
      assert.throws(
        () => persistRuntimeAuthorityPrivateKey(path.join(nonDirectory, "runtime.pem"), generated.privateKey),
        (error: unknown) =>
          error instanceof RuntimeAuthorityKeyError && error.code === "RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE",
      );

      const writableAncestor = path.join(directory, "writable-ancestor");
      await mkdir(writableAncestor, { mode: 0o700 });
      await chmod(writableAncestor, 0o777);
      assert.throws(
        () => persistRuntimeAuthorityPrivateKey(path.join(writableAncestor, "runtime.pem"), generated.privateKey),
        (error: unknown) =>
          error instanceof RuntimeAuthorityKeyError && error.code === "RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("does not overwrite an existing local key without explicit replacement", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = path.join(directory, "runtime-authority.pem");
    const first = generateAndPersistRuntimeAuthorityKeyPair(filePath);
    assert.throws(
      () => generateAndPersistRuntimeAuthorityKeyPair(filePath),
      (error: unknown) => error instanceof RuntimeAuthorityKeyError && error.code === "RUNTIME_AUTHORITY_KEY_EXISTS",
    );
    assert.equal(loadRuntimeAuthorityKeyPair(filePath).publicKeyJwk.x, first.publicKeyJwk.x);

    const replacement = generateAndPersistRuntimeAuthorityKeyPair(filePath, { replace: true });
    assert.notEqual(replacement.publicKeyJwk.x, first.publicKeyJwk.x);
    assert.equal(loadRuntimeAuthorityKeyPair(filePath).publicKeyJwk.x, replacement.publicKeyJwk.x);
    // Key generation/replacement has no repository registration side effect.
    await assert.rejects(lstat(path.join(directory, ".github", "inari", "authorities")));
  });
});

test("rejects non-Ed25519 private keys before persistence", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    assert.throws(
      () => persistRuntimeAuthorityPrivateKey(path.join(directory, "rsa.pem"), privateKey),
      (error: unknown) =>
        error instanceof RuntimeAuthorityKeyError && error.code === "RUNTIME_AUTHORITY_KEY_INVALID_PRIVATE_KEY",
    );
  });
});
