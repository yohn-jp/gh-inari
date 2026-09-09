import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  RUNTIME_AUTHORITY_CONTRACT_VERSION,
  RUNTIME_AUTHORITY_KIND,
  assertRuntimeAuthority,
  canonicalRuntimeAuthorityJson,
  isRuntimeAuthorityActive,
  validateRuntimeAuthority,
} from "./runtime-authority.js";

function ed25519Jwk(): { kty: "OKP"; crv: "Ed25519"; x: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  return publicKey.export({ format: "jwk" }) as { kty: "OKP"; crv: "Ed25519"; x: string };
}

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: RUNTIME_AUTHORITY_CONTRACT_VERSION,
    kind: RUNTIME_AUTHORITY_KIND,
    id: "yohn-local-runtime-2026-09",
    key: ed25519Jwk(),
    status: "active",
    notBefore: "2026-09-08T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 7200,
    capabilityCeiling: ["change.implement", "change.ready", "change.abort"],
    ...overrides,
  };
}

test("accepts the illustrative Runtime Authority record from the architecture doc", () => {
  const result = validateRuntimeAuthority(validRecord());
  assert.equal(result.valid, true);
  assert.equal(result.value?.id, "yohn-local-runtime-2026-09");
});

test("accepts a bounded notAfter expiry after notBefore", () => {
  const result = validateRuntimeAuthority(validRecord({ notAfter: "2027-09-08T00:00:00Z" }));
  assert.equal(result.valid, true);
});

test("rejects an unsupported contract version", () => {
  const result = validateRuntimeAuthority(validRecord({ version: 2 }));
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.code === "RUNTIME_AUTHORITY_UNSUPPORTED_VERSION"));
});

test("rejects an unknown top-level property", () => {
  const result = validateRuntimeAuthority(validRecord({ extra: true }));
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.code === "RUNTIME_AUTHORITY_UNKNOWN_PROPERTY"));
});

test("rejects a malformed key (wrong curve, wrong length, RSA-shaped)", () => {
  assert.equal(
    validateRuntimeAuthority(validRecord({ key: { kty: "OKP", crv: "P-256", x: ed25519Jwk().x } })).valid,
    false,
  );
  assert.equal(
    validateRuntimeAuthority(
      validRecord({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.alloc(16).toString("base64url") } }),
    ).valid,
    false,
  );
  assert.equal(validateRuntimeAuthority(validRecord({ key: { kty: "RSA", n: "x", e: "AQAB" } })).valid, false);
});

test("rejects TTL overflow and underflow", () => {
  assert.equal(validateRuntimeAuthority(validRecord({ maxSessionTtlSeconds: 86_401 })).valid, false);
  assert.equal(validateRuntimeAuthority(validRecord({ maxSessionTtlSeconds: 59 })).valid, false);
  assert.equal(validateRuntimeAuthority(validRecord({ maxSessionTtlSeconds: 7200.5 })).valid, false);
});

test("rejects an empty, oversized, duplicate, or provider-permission capability ceiling", () => {
  assert.equal(validateRuntimeAuthority(validRecord({ capabilityCeiling: [] })).valid, false);
  assert.equal(
    validateRuntimeAuthority(validRecord({ capabilityCeiling: ["change.implement", "change.implement"] })).valid,
    false,
  );
  assert.equal(validateRuntimeAuthority(validRecord({ capabilityCeiling: ["contents:write"] })).valid, false);
});

test("rejects notAfter at or before notBefore", () => {
  assert.equal(validateRuntimeAuthority(validRecord({ notAfter: "2026-09-08T00:00:00Z" })).valid, false);
  assert.equal(validateRuntimeAuthority(validRecord({ notAfter: "2020-01-01T00:00:00Z" })).valid, false);
});

test("rejects an invalid status and an invalid timestamp", () => {
  assert.equal(validateRuntimeAuthority(validRecord({ status: "revoked" })).valid, false);
  assert.equal(validateRuntimeAuthority(validRecord({ notBefore: "not-a-date" })).valid, false);
});

test("rejects a missing property", () => {
  const record = validRecord();
  delete record.maxSessionTtlSeconds;
  const result = validateRuntimeAuthority(record);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.code === "RUNTIME_AUTHORITY_MISSING_PROPERTY"));
});

test("assertRuntimeAuthority throws on invalid input and returns a frozen value on success", () => {
  assert.throws(() => assertRuntimeAuthority({}));
  const authority = assertRuntimeAuthority(validRecord());
  assert.ok(Object.isFrozen(authority));
});

test("canonicalRuntimeAuthorityJson is deterministic regardless of source key order", () => {
  const authority = assertRuntimeAuthority(validRecord());
  const first = canonicalRuntimeAuthorityJson(authority);
  const second = canonicalRuntimeAuthorityJson(
    assertRuntimeAuthority(validRecord({ id: authority.id, key: authority.key })),
  );
  assert.equal(first, second);
});

test("isRuntimeAuthorityActive respects status/notBefore/notAfter", () => {
  const authority = assertRuntimeAuthority(
    validRecord({ notBefore: "2026-01-01T00:00:00Z", notAfter: "2026-12-31T00:00:00Z" }),
  );
  assert.equal(isRuntimeAuthorityActive(authority, new Date("2026-06-01T00:00:00Z")), true);
  assert.equal(isRuntimeAuthorityActive(authority, new Date("2025-01-01T00:00:00Z")), false);
  assert.equal(isRuntimeAuthorityActive(authority, new Date("2027-01-01T00:00:00Z")), false);
  const disabled = assertRuntimeAuthority(validRecord({ status: "disabled" }));
  assert.equal(isRuntimeAuthorityActive(disabled, new Date()), false);
});
