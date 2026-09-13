import assert from "node:assert/strict";
import { createPublicKey, verify as ed25519Verify } from "node:crypto";
import { test } from "node:test";
import {
  createManagedSession,
  ManagedSessionSigningError,
  MAX_MANAGED_SESSION_SIGN_INPUT_BYTES,
} from "./session-issuance.js";

function publicKeyFor(session: ReturnType<typeof createManagedSession>) {
  return createPublicKey({ key: session.publicKey, format: "jwk" });
}

function verifies(session: ReturnType<typeof createManagedSession>, bytes: Uint8Array, signature: Uint8Array): boolean {
  return ed25519Verify(null, bytes, publicKeyFor(session), signature);
}

test("ManagedSession.sign returns a raw signature verifiable by the Session public key", () => {
  const session = createManagedSession();
  const bytes = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);
  const signature = session.sign(bytes);

  assert.equal(signature.constructor, Uint8Array);
  assert.equal(signature.byteLength, 64);
  assert.equal(verifies(session, bytes, signature), true);
});

test("ManagedSession.sign binds signatures to the Session that owns the private key", () => {
  const first = createManagedSession();
  const second = createManagedSession();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const firstSignature = first.sign(bytes);
  const secondSignature = second.sign(bytes);

  assert.equal(verifies(first, bytes, firstSignature), true);
  assert.equal(verifies(second, bytes, secondSignature), true);
  assert.equal(verifies(first, bytes, secondSignature), false);
  assert.equal(verifies(second, bytes, firstSignature), false);
});

test("ManagedSession.sign signs the exact supplied bytes", () => {
  const session = createManagedSession();
  const bytes = new Uint8Array([0x00, 0xff, 0x80, 0x0a, 0x7f]);
  const transformedBytes = Uint8Array.from(bytes).reverse();
  const signature = session.sign(bytes);

  assert.equal(verifies(session, bytes, signature), true);
  assert.equal(verifies(session, transformedBytes, signature), false);
});

test("ManagedSession.sign does not expose private key material", () => {
  const session = createManagedSession();
  const serialized = JSON.stringify(session);

  assert.equal(Reflect.ownKeys(session).includes("privateKey"), false);
  assert.equal("privateKey" in session, false);
  assert.equal(serialized.includes("PRIVATE KEY"), false);
  assert.equal(serialized.includes('"d"'), false);
  assert.equal(Reflect.ownKeys(session.publicKey).includes("d"), false);
  assert.equal(JSON.stringify(session.publicKey).includes('"d"'), false);
});

test("ManagedSession.sign rejects invalid and oversized input with a deterministic error", () => {
  const session = createManagedSession();
  const expectedMessage = `Managed Session signing input must be a Uint8Array no larger than ${MAX_MANAGED_SESSION_SIGN_INPUT_BYTES} bytes.`;
  const assertInvalidInput = (invoke: () => unknown) => {
    assert.throws(
      invoke,
      (error: unknown) =>
        error instanceof ManagedSessionSigningError &&
        error.code === "MANAGED_SESSION_SIGN_INVALID_INPUT" &&
        error.message === expectedMessage,
    );
  };

  assertInvalidInput(() => session.sign("not-bytes" as never));
  assertInvalidInput(() => session.sign(new Uint8Array(MAX_MANAGED_SESSION_SIGN_INPUT_BYTES + 1)));
});
