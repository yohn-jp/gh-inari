/**
 * Conformance vectors for the Runtime Authority and Session Certificate
 * schemas (#367). These are plain data so `conformance.test.ts` -- and any
 * future non-TypeScript implementation -- can execute the same fixed inputs
 * against its own validator and expect the same accept/reject outcome.
 *
 * `GOLDEN_SESSION_CERTIFICATE` is a real, deterministically reproducible
 * Ed25519/JWS/JCS artifact: a fixed test-only Runtime keypair (never a real
 * trust anchor -- do not register it in any repository trust record) signs
 * a fixed claim set, and EdDSA signing is itself deterministic, so the
 * `compact` string below is the exact byte-for-byte output any conformant
 * implementation must reproduce from `header/payload` and must be able to
 * decode and signature-verify.
 */

export interface ConformanceVector {
  readonly name: string;
  readonly valid: boolean;
  readonly input: unknown;
}

const VALID_ED25519_JWK = { kty: "OKP", crv: "Ed25519", x: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE" } as const;

export const VALID_RUNTIME_AUTHORITY = Object.freeze({
  version: 1,
  kind: "runtime-authority",
  id: "yohn-local-runtime-2026-09",
  key: VALID_ED25519_JWK,
  status: "active",
  notBefore: "2026-09-08T00:00:00Z",
  notAfter: null,
  maxSessionTtlSeconds: 7200,
  capabilityCeiling: ["change.implement", "change.ready", "change.abort"],
});

export const RUNTIME_AUTHORITY_VECTORS: readonly ConformanceVector[] = Object.freeze([
  { name: "architecture-doc-illustrative-record", valid: true, input: VALID_RUNTIME_AUTHORITY },
  {
    name: "malformed-key-wrong-curve",
    valid: false,
    input: { ...VALID_RUNTIME_AUTHORITY, key: { kty: "OKP", crv: "P-256", x: VALID_ED25519_JWK.x } },
  },
  {
    name: "malformed-key-wrong-length",
    valid: false,
    input: { ...VALID_RUNTIME_AUTHORITY, key: { kty: "OKP", crv: "Ed25519", x: "AQEBAQEBAQEBAQEBAQEBAQ" } },
  },
  {
    name: "malformed-key-rsa-shaped",
    valid: false,
    input: { ...VALID_RUNTIME_AUTHORITY, key: { kty: "RSA", n: "AQAB", e: "AQAB" } },
  },
  { name: "unknown-version", valid: false, input: { ...VALID_RUNTIME_AUTHORITY, version: 2 } },
  { name: "unknown-version-string", valid: false, input: { ...VALID_RUNTIME_AUTHORITY, version: "1" } },
  { name: "ttl-overflow", valid: false, input: { ...VALID_RUNTIME_AUTHORITY, maxSessionTtlSeconds: 86_401 } },
  { name: "ttl-underflow", valid: false, input: { ...VALID_RUNTIME_AUTHORITY, maxSessionTtlSeconds: 0 } },
  {
    name: "capability-ceiling-raw-github-permission",
    valid: false,
    input: { ...VALID_RUNTIME_AUTHORITY, capabilityCeiling: ["contents:write", "pull_requests:write"] },
  },
  { name: "capability-ceiling-empty", valid: false, input: { ...VALID_RUNTIME_AUTHORITY, capabilityCeiling: [] } },
  {
    name: "capability-ceiling-duplicate",
    valid: false,
    input: { ...VALID_RUNTIME_AUTHORITY, capabilityCeiling: ["change.implement", "change.implement"] },
  },
  { name: "invalid-status", valid: false, input: { ...VALID_RUNTIME_AUTHORITY, status: "revoked" } },
  {
    name: "not-after-before-not-before",
    valid: false,
    input: { ...VALID_RUNTIME_AUTHORITY, notAfter: "2020-01-01T00:00:00Z" },
  },
  { name: "unknown-top-level-property", valid: false, input: { ...VALID_RUNTIME_AUTHORITY, trustedAdmin: true } },
  { name: "non-object-root", valid: false, input: "not-a-record" },
]);

export const VALID_SESSION_CERTIFICATE_HEADER = Object.freeze({
  alg: "EdDSA",
  typ: "inari-session+jwt",
  kid: "yohn-local-runtime-2026-09",
});

export const SESSION_CERTIFICATE_HEADER_VECTORS: readonly ConformanceVector[] = Object.freeze([
  { name: "architecture-doc-illustrative-header", valid: true, input: VALID_SESSION_CERTIFICATE_HEADER },
  { name: "alg-none-confusion", valid: false, input: { ...VALID_SESSION_CERTIFICATE_HEADER, alg: "none" } },
  { name: "alg-hs256-confusion", valid: false, input: { ...VALID_SESSION_CERTIFICATE_HEADER, alg: "HS256" } },
  { name: "typ-generic-jwt", valid: false, input: { ...VALID_SESSION_CERTIFICATE_HEADER, typ: "JWT" } },
  { name: "kid-uppercase", valid: false, input: { ...VALID_SESSION_CERTIFICATE_HEADER, kid: "Yohn-Local-Runtime" } },
  { name: "unknown-header-property", valid: false, input: { ...VALID_SESSION_CERTIFICATE_HEADER, cty: "JWT" } },
]);

export const VALID_SESSION_CERTIFICATE_PAYLOAD = Object.freeze({
  ver: 1,
  iss: "runtime:yohn-local-runtime-2026-09",
  sub: "session:01HXAMPLE0000000000000000",
  jti: "01HXAMPLE0000000000000001",
  repository: { id: "123456789", name: "yohn-jp/gh-inari" },
  sessionKey: { kty: "OKP", crv: "Ed25519", x: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI" },
  task: { kind: "issue", number: 364 },
  capabilities: [{ kind: "change.implement", issue: 364 }],
  iat: 1_757_347_200,
  nbf: 1_757_347_200,
  exp: 1_757_354_400,
});

export const SESSION_CERTIFICATE_PAYLOAD_VECTORS: readonly ConformanceVector[] = Object.freeze([
  { name: "architecture-doc-illustrative-payload", valid: true, input: VALID_SESSION_CERTIFICATE_PAYLOAD },
  {
    name: "certificate-with-no-task-scope-is-still-bounded-by-capabilities",
    valid: true,
    input: (() => {
      const { task: _task, ...rest } = VALID_SESSION_CERTIFICATE_PAYLOAD;
      return rest;
    })(),
  },
  { name: "unknown-version", valid: false, input: { ...VALID_SESSION_CERTIFICATE_PAYLOAD, ver: 2 } },
  {
    name: "wrong-repository-name-shape",
    valid: false,
    input: { ...VALID_SESSION_CERTIFICATE_PAYLOAD, repository: { id: "123456789", name: "not-owner-slash-repo" } },
  },
  {
    name: "wrong-repository-id-non-decimal",
    valid: false,
    input: { ...VALID_SESSION_CERTIFICATE_PAYLOAD, repository: { id: "gh-inari", name: "yohn-jp/gh-inari" } },
  },
  {
    name: "malformed-session-key-wrong-length",
    valid: false,
    input: { ...VALID_SESSION_CERTIFICATE_PAYLOAD, sessionKey: { kty: "OKP", crv: "Ed25519", x: "AQEBAQEB" } },
  },
  {
    name: "invalid-capability-claim-raw-github-permission",
    valid: false,
    input: { ...VALID_SESSION_CERTIFICATE_PAYLOAD, capabilities: [{ kind: "issues:write" }] },
  },
  {
    name: "invalid-capability-claim-missing-issue",
    valid: false,
    input: { ...VALID_SESSION_CERTIFICATE_PAYLOAD, capabilities: [{ kind: "change.implement" }] },
  },
  {
    name: "capability-widens-beyond-declared-task",
    valid: false,
    input: { ...VALID_SESSION_CERTIFICATE_PAYLOAD, capabilities: [{ kind: "change.implement", issue: 999 }] },
  },
  {
    name: "duplicate-capability-claims",
    valid: false,
    input: {
      ...VALID_SESSION_CERTIFICATE_PAYLOAD,
      capabilities: [
        { kind: "change.implement", issue: 364 },
        { kind: "change.implement", issue: 364 },
      ],
    },
  },
  { name: "exp-before-nbf", valid: false, input: { ...VALID_SESSION_CERTIFICATE_PAYLOAD, nbf: 2000, exp: 1000 } },
  { name: "time-out-of-range", valid: false, input: { ...VALID_SESSION_CERTIFICATE_PAYLOAD, exp: 9_999_999_999 } },
  {
    name: "issuer-missing-runtime-prefix",
    valid: false,
    input: { ...VALID_SESSION_CERTIFICATE_PAYLOAD, iss: "yohn-local-runtime-2026-09" },
  },
  {
    name: "subject-missing-session-prefix",
    valid: false,
    input: { ...VALID_SESSION_CERTIFICATE_PAYLOAD, sub: "01HXAMPLE0000000000000000" },
  },
]);

/**
 * A real EdDSA-signed compact Session Certificate produced with a fixed,
 * test-only Ed25519 keypair (`d`/`x` below). Regeneratable from
 * `header`/`payload` by any conformant implementation: canonicalize each
 * with JCS, base64url-encode, join with ".", and Ed25519-sign the result --
 * EdDSA is deterministic, so the signature (and therefore `compact`) is
 * reproduced exactly.
 */
export const GOLDEN_SESSION_CERTIFICATE = Object.freeze({
  header: VALID_SESSION_CERTIFICATE_HEADER,
  payload: VALID_SESSION_CERTIFICATE_PAYLOAD,
  testOnlyRuntimeKeyPair: Object.freeze({
    kty: "OKP",
    crv: "Ed25519",
    x: "ICsSAaYDdzS9R_wI7if_JgFzMCVvZdCOllo27AUy3Q0",
    d: "zQgoSdkuGkh68Ur5x03F8BTfbIVc6VGSS5V62RXSvvc",
  }),
  signature: "MUfabu5eBntk18lzySgzkDhVe8W4PUDkEiOPKV0oKj8SJJtMoh0P_1J9-xY2EK5UnAEcrQkKSMpJC1TPgIbzAA",
  compact:
    "eyJhbGciOiJFZERTQSIsImtpZCI6InlvaG4tbG9jYWwtcnVudGltZS0yMDI2LTA5IiwidHlwIjoiaW5hcmktc2Vzc2lvbitqd3QifQ." +
    "eyJjYXBhYmlsaXRpZXMiOlt7Imlzc3VlIjozNjQsImtpbmQiOiJjaGFuZ2UuaW1wbGVtZW50In1dLCJleHAiOjE3NTczNTQ0MDAsImlhdCI6MTc1NzM0NzIwMCwiaXNzIjoicnVudGltZTp5b2huLWxvY2FsLXJ1bnRpbWUtMjAyNi0wOSIsImp0aSI6IjAxSFhBTVBMRTAwMDAwMDAwMDAwMDAwMDEiLCJuYmYiOjE3NTczNDcyMDAsInJlcG9zaXRvcnkiOnsiaWQiOiIxMjM0NTY3ODkiLCJuYW1lIjoieW9obi1qcC9naC1pbmFyaSJ9LCJzZXNzaW9uS2V5Ijp7ImNydiI6IkVkMjU1MTkiLCJrdHkiOiJPS1AiLCJ4IjoiQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSSJ9LCJzdWIiOiJzZXNzaW9uOjAxSFhBTVBMRTAwMDAwMDAwMDAwMDAwMDAiLCJ0YXNrIjp7ImtpbmQiOiJpc3N1ZSIsIm51bWJlciI6MzY0fSwidmVyIjoxfQ." +
    "MUfabu5eBntk18lzySgzkDhVe8W4PUDkEiOPKV0oKj8SJJtMoh0P_1J9-xY2EK5UnAEcrQkKSMpJC1TPgIbzAA",
});
