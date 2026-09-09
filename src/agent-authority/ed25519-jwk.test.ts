import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { assertEd25519PublicJwk, validateEd25519PublicJwk } from "./ed25519-jwk.js";

function realEd25519PublicKeyX(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return jwk.x;
}

test("accepts a well-formed Ed25519 public JWK", () => {
  const x = realEd25519PublicKeyX();
  const result = validateEd25519PublicJwk({ kty: "OKP", crv: "Ed25519", x });
  assert.equal(result.valid, true);
  assert.deepEqual(result.value, { kty: "OKP", crv: "Ed25519", x });
});

test("rejects a non-object input", () => {
  assert.equal(validateEd25519PublicJwk("not-a-key").valid, false);
  assert.equal(validateEd25519PublicJwk(null).valid, false);
  assert.equal(validateEd25519PublicJwk([1, 2, 3]).valid, false);
});

test("rejects an unknown property", () => {
  const x = realEd25519PublicKeyX();
  const result = validateEd25519PublicJwk({ kty: "OKP", crv: "Ed25519", x, use: "sig" });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.code === "ED25519_JWK_UNKNOWN_PROPERTY"));
});

test("rejects a wrong key type or curve", () => {
  const x = realEd25519PublicKeyX();
  assert.equal(validateEd25519PublicJwk({ kty: "RSA", crv: "Ed25519", x }).valid, false);
  assert.equal(validateEd25519PublicJwk({ kty: "OKP", crv: "P-256", x }).valid, false);
});

test("rejects key material of the wrong length", () => {
  const shortX = Buffer.alloc(16, 7).toString("base64url");
  const longX = Buffer.alloc(64, 7).toString("base64url");
  assert.equal(validateEd25519PublicJwk({ kty: "OKP", crv: "Ed25519", x: shortX }).valid, false);
  assert.equal(validateEd25519PublicJwk({ kty: "OKP", crv: "Ed25519", x: longX }).valid, false);
});

test("rejects padded base64 and non-base64url characters", () => {
  const raw = Buffer.alloc(32, 9).toString("base64");
  assert.equal(validateEd25519PublicJwk({ kty: "OKP", crv: "Ed25519", x: raw }).valid, false);
  assert.equal(validateEd25519PublicJwk({ kty: "OKP", crv: "Ed25519", x: "!".repeat(43) }).valid, false);
});

test("assertEd25519PublicJwk throws with a bounded message on invalid input", () => {
  assert.throws(() => assertEd25519PublicJwk({ kty: "OKP", crv: "Ed25519", x: "short" }), /key/i);
});
