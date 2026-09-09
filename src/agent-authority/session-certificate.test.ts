import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { test } from "node:test";
import {
  SESSION_CERTIFICATE_ALG,
  SESSION_CERTIFICATE_CONTRACT_VERSION,
  SESSION_CERTIFICATE_TYP,
  decodeSessionCertificateCompact,
  encodeSessionCertificateCompact,
  evaluateSessionCertificateAgainstRuntimeAuthority,
  sessionCertificateSigningInput,
  validateSessionCertificateHeader,
  validateSessionCertificatePayload,
  type SessionCertificateHeader,
  type SessionCertificatePayload,
} from "./session-certificate.js";
import { assertRuntimeAuthority, type RuntimeAuthority } from "./runtime-authority.js";

function ed25519Jwk(): { kty: "OKP"; crv: "Ed25519"; x: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  return publicKey.export({ format: "jwk" }) as { kty: "OKP"; crv: "Ed25519"; x: string };
}

const RUNTIME_ID = "yohn-local-runtime-2026-09";

function header(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { alg: SESSION_CERTIFICATE_ALG, typ: SESSION_CERTIFICATE_TYP, kid: RUNTIME_ID, ...overrides };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ver: SESSION_CERTIFICATE_CONTRACT_VERSION,
    iss: `runtime:${RUNTIME_ID}`,
    sub: "session:01HXAMPLE0000000000000000",
    jti: "01HXAMPLE0000000000000001",
    repository: { id: "123456789", name: "yohn-jp/gh-inari" },
    sessionKey: ed25519Jwk(),
    task: { kind: "issue", number: 364 },
    capabilities: [{ kind: "change.implement", issue: 364 }],
    iat: 1_757_347_200,
    nbf: 1_757_347_200,
    exp: 1_757_354_400,
    ...overrides,
  };
}

test("accepts the illustrative header and payload from the architecture doc", () => {
  assert.equal(validateSessionCertificateHeader(header()).valid, true);
  assert.equal(validateSessionCertificatePayload(payload()).valid, true);
});

test("rejects an unsupported alg or typ (algorithm confusion)", () => {
  assert.equal(validateSessionCertificateHeader(header({ alg: "none" })).valid, false);
  assert.equal(validateSessionCertificateHeader(header({ alg: "HS256" })).valid, false);
  assert.equal(validateSessionCertificateHeader(header({ typ: "JWT" })).valid, false);
});

test("rejects an unknown header property", () => {
  const result = validateSessionCertificateHeader(header({ cty: "x" }));
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.code === "SESSION_CERTIFICATE_UNKNOWN_PROPERTY"));
});

test("rejects an unsupported payload version", () => {
  const result = validateSessionCertificatePayload(payload({ ver: 2 }));
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.code === "SESSION_CERTIFICATE_UNSUPPORTED_VERSION"));
});

test("rejects a malformed sessionKey", () => {
  assert.equal(
    validateSessionCertificatePayload(payload({ sessionKey: { kty: "RSA", n: "x", e: "AQAB" } })).valid,
    false,
  );
  assert.equal(
    validateSessionCertificatePayload(payload({ sessionKey: { kty: "OKP", crv: "Ed25519", x: "short" } })).valid,
    false,
  );
});

test("rejects wrong repository shapes", () => {
  assert.equal(
    validateSessionCertificatePayload(payload({ repository: { id: "0", name: "yohn-jp/gh-inari" } })).valid,
    false,
  );
  assert.equal(
    validateSessionCertificatePayload(payload({ repository: { id: "123", name: "not-owner-slash-name" } })).valid,
    false,
  );
  assert.equal(
    validateSessionCertificatePayload(payload({ repository: { id: "123456789", name: "yohn-jp/gh-inari", extra: 1 } }))
      .valid,
    false,
  );
});

test("rejects a capability claim outside the closed vocabulary", () => {
  const result = validateSessionCertificatePayload(payload({ capabilities: [{ kind: "contents:write" }] }));
  assert.equal(result.valid, false);
});

test("rejects duplicate capability claims", () => {
  const result = validateSessionCertificatePayload(
    payload({
      capabilities: [
        { kind: "change.implement", issue: 364 },
        { kind: "change.implement", issue: 364 },
      ],
    }),
  );
  assert.equal(result.valid, false);
});

test("rejects a change.* capability whose issue widens beyond the declared task", () => {
  const result = validateSessionCertificatePayload(
    payload({ task: { kind: "issue", number: 364 }, capabilities: [{ kind: "change.implement", issue: 999 }] }),
  );
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.code === "SESSION_CERTIFICATE_TASK_SCOPE_MISMATCH"));
});

test("rejects exp before nbf and out-of-range time claims", () => {
  assert.equal(validateSessionCertificatePayload(payload({ nbf: 2000, exp: 1000 })).valid, false);
  assert.equal(validateSessionCertificatePayload(payload({ exp: -1 })).valid, false);
  assert.equal(validateSessionCertificatePayload(payload({ exp: 9_999_999_999 })).valid, false);
});

test("sessionCertificateSigningInput is deterministic and produces real Ed25519-verifiable bytes", () => {
  const h = header() as unknown as SessionCertificateHeader;
  const p = payload() as unknown as SessionCertificatePayload;
  const first = sessionCertificateSigningInput(h, p);
  const second = sessionCertificateSigningInput(h, structuredClone(p));
  assert.equal(first.signingInput, second.signingInput);

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signature = edSign(null, Buffer.from(first.signingInput, "utf8"), privateKey);
  assert.equal(edVerify(null, Buffer.from(first.signingInput, "utf8"), publicKey, signature), true);
  const tampered = Buffer.from(`${first.signingInput}x`, "utf8");
  assert.equal(edVerify(null, tampered, publicKey, signature), false);
});

test("sessionCertificateSigningInput rejects header/payload issuer inconsistency", () => {
  const h = header({ kid: "other-runtime" }) as unknown as SessionCertificateHeader;
  const p = payload() as unknown as SessionCertificatePayload;
  assert.throws(() => sessionCertificateSigningInput(h, p));
});

function realSignedCompact(payloadOverrides: Record<string, unknown> = {}): { compact: string; publicKey: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const h = header() as unknown as SessionCertificateHeader;
  const p = payload(payloadOverrides) as unknown as SessionCertificatePayload;
  const { signingInput } = sessionCertificateSigningInput(h, p);
  const signature = edSign(null, Buffer.from(signingInput, "utf8"), privateKey).toString("base64url");
  return {
    compact: encodeSessionCertificateCompact(h, p, signature),
    publicKey: publicKey.export({ format: "jwk" }) as unknown as Buffer,
  };
}

test("encode/decode round-trips a compact Session Certificate and the signature verifies", () => {
  const { privateKey, publicKey: pub } = generateKeyPairSync("ed25519");
  const h = header() as unknown as SessionCertificateHeader;
  const p = payload() as unknown as SessionCertificatePayload;
  const { signingInput } = sessionCertificateSigningInput(h, p);
  const signature = edSign(null, Buffer.from(signingInput, "utf8"), privateKey).toString("base64url");
  const compact = encodeSessionCertificateCompact(h, p, signature);

  const decoded = decodeSessionCertificateCompact(compact);
  assert.equal(decoded.valid, true);
  assert.equal(decoded.value?.signingInput, signingInput);
  assert.equal(decoded.value?.signature, signature);

  const rawSignature = Buffer.from(signature, "base64url");
  assert.equal(edVerify(null, Buffer.from(decoded.value?.signingInput as string, "utf8"), pub, rawSignature), true);
});

test("decode rejects a payload segment that is not the canonical JCS encoding (signature-input drift)", () => {
  const { compact } = realSignedCompact();
  const segments = compact.split(".");
  // Re-encode with a non-canonical key order to simulate an alternative, non-conformant producer.
  const decodedOriginal = JSON.parse(Buffer.from(segments[1] as string, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  const reordered: Record<string, unknown> = {};
  for (const key of Object.keys(decodedOriginal).reverse()) reordered[key] = decodedOriginal[key];
  const driftedSegment = Buffer.from(JSON.stringify(reordered), "utf8").toString("base64url");
  const drifted = `${segments[0]}.${driftedSegment}.${segments[2]}`;

  const result = decodeSessionCertificateCompact(drifted);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.code === "SESSION_CERTIFICATE_CANONICAL_DRIFT"));
});

test("decode rejects a malformed compact string shape", () => {
  assert.equal(decodeSessionCertificateCompact("not-a-jws").valid, false);
  assert.equal(decodeSessionCertificateCompact("a.b").valid, false);
  assert.equal(decodeSessionCertificateCompact("a.b.c.d").valid, false);
  assert.equal(decodeSessionCertificateCompact(12345).valid, false);
});

function runtimeAuthority(overrides: Record<string, unknown> = {}): RuntimeAuthority {
  return assertRuntimeAuthority({
    version: 1,
    kind: "runtime-authority",
    id: RUNTIME_ID,
    key: ed25519Jwk(),
    status: "active",
    notBefore: "2020-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 7200,
    capabilityCeiling: ["change.implement", "change.ready", "change.abort"],
    ...overrides,
  });
}

test("evaluateSessionCertificateAgainstRuntimeAuthority admits a well-formed certificate within the Runtime ceiling", () => {
  const h = header() as unknown as SessionCertificateHeader;
  const p = payload() as unknown as SessionCertificatePayload;
  const result = evaluateSessionCertificateAgainstRuntimeAuthority(
    { header: h, payload: p },
    { runtimeAuthority: runtimeAuthority(), expectedRepositoryId: "123456789", now: new Date(1_757_350_000 * 1000) },
  );
  assert.equal(result.admitted, true);
});

test("evaluateSessionCertificateAgainstRuntimeAuthority rejects a repository mismatch (cross-repository confused deputy)", () => {
  const h = header() as unknown as SessionCertificateHeader;
  const p = payload() as unknown as SessionCertificatePayload;
  const result = evaluateSessionCertificateAgainstRuntimeAuthority(
    { header: h, payload: p },
    { runtimeAuthority: runtimeAuthority(), expectedRepositoryId: "999999999", now: new Date(1_757_350_000 * 1000) },
  );
  assert.equal(result.admitted, false);
  assert.ok(result.diagnostics.some((d) => d.code === "SESSION_CERTIFICATE_REPOSITORY_MISMATCH"));
});

test("evaluateSessionCertificateAgainstRuntimeAuthority rejects a TTL that exceeds the Runtime's maxSessionTtlSeconds", () => {
  const h = header() as unknown as SessionCertificateHeader;
  const p = payload({ nbf: 1_757_347_200, exp: 1_757_347_200 + 20_000 }) as unknown as SessionCertificatePayload;
  const result = evaluateSessionCertificateAgainstRuntimeAuthority(
    { header: h, payload: p },
    {
      runtimeAuthority: runtimeAuthority({ maxSessionTtlSeconds: 7200 }),
      expectedRepositoryId: "123456789",
      now: new Date(1_757_350_000 * 1000),
    },
  );
  assert.equal(result.admitted, false);
  assert.ok(result.diagnostics.some((d) => d.code === "SESSION_CERTIFICATE_TTL_EXCEEDS_RUNTIME_CEILING"));
});

test("evaluateSessionCertificateAgainstRuntimeAuthority rejects a capability outside the Runtime ceiling", () => {
  const h = header() as unknown as SessionCertificateHeader;
  const p = payload({ capabilities: [{ kind: "change.abort", issue: 364 }] }) as unknown as SessionCertificatePayload;
  const result = evaluateSessionCertificateAgainstRuntimeAuthority(
    { header: h, payload: p },
    {
      runtimeAuthority: runtimeAuthority({ capabilityCeiling: ["change.implement"] }),
      expectedRepositoryId: "123456789",
      now: new Date(1_757_350_000 * 1000),
    },
  );
  assert.equal(result.admitted, false);
  assert.ok(result.diagnostics.some((d) => d.code === "SESSION_CERTIFICATE_CAPABILITY_EXCEEDS_RUNTIME_CEILING"));
});

test("evaluateSessionCertificateAgainstRuntimeAuthority rejects expiry and untrusted-runtime cases", () => {
  const h = header() as unknown as SessionCertificateHeader;
  const p = payload() as unknown as SessionCertificatePayload;
  const expired = evaluateSessionCertificateAgainstRuntimeAuthority(
    { header: h, payload: p },
    {
      runtimeAuthority: runtimeAuthority(),
      expectedRepositoryId: "123456789",
      now: new Date((1_757_354_400 + 1) * 1000),
    },
  );
  assert.equal(expired.admitted, false);
  assert.ok(expired.diagnostics.some((d) => d.code === "SESSION_CERTIFICATE_EXPIRED"));

  const untrusted = evaluateSessionCertificateAgainstRuntimeAuthority(
    { header: h, payload: p },
    {
      runtimeAuthority: runtimeAuthority({ id: "some-other-runtime" }),
      expectedRepositoryId: "123456789",
      now: new Date(1_757_350_000 * 1000),
    },
  );
  assert.equal(untrusted.admitted, false);
  assert.ok(untrusted.diagnostics.some((d) => d.code === "SESSION_CERTIFICATE_UNTRUSTED_RUNTIME"));

  const inactive = evaluateSessionCertificateAgainstRuntimeAuthority(
    { header: h, payload: p },
    {
      runtimeAuthority: runtimeAuthority({ status: "disabled" }),
      expectedRepositoryId: "123456789",
      now: new Date(1_757_350_000 * 1000),
    },
  );
  assert.equal(inactive.admitted, false);
});
