import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import test from "node:test";
import {
  REPOSITORY_ACCESS_ASSERTION_MAX_BYTES,
  RepositoryAccessAssertionError,
  repositoryAccessRequestDigest,
  signRepositoryAccessAssertion,
  verifyRepositoryAccessAssertion,
  type RepositoryAccessAssertionExpectedBindings,
  type RepositoryAccessAssertionSigningInput,
} from "./repository-access-assertion.js";
import { base64UrlEncodeText, canonicalJsonString, type CanonicalJsonValue } from "../agent-authority/codec.js";

// RFC 8032 test seed, intentionally confined to this deterministic test fixture.
const issuerPrivateKey = createPrivateKey({
  key: Buffer.from(
    "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  ),
  format: "der",
  type: "pkcs8",
});
const issuerPublicKey = createPublicKey(issuerPrivateKey);
const issuerKeyId = "hosted-key-2026-09";
const now = 2_000_000_000;
const DETERMINISTIC_V1_VECTOR =
  "eyJhbGciOiJFZERTQSIsImtpZCI6Imhvc3RlZC1rZXktMjAyNi0wOSIsInR5cCI6ImluYXJpLXJlcG9zaXRvcnktYWNjZXNzLWFzc2VydGlvbiIsInZlcnNpb24iOjF9.eyJhcHAiOnsiaWQiOiI5ODc2NTQifSwiYXNzZXJ0aW9uSWQiOiJhc3NlcnRpb246MDFqN3M3aDdtOSIsImF1ZGllbmNlIjoicnVudGltZTo0ZWMxNTU4ZS0xMDE1LTRlYTUtYjVlYS1lZjk0MWU2ZTEyYWMiLCJlbGlnaWJpbGl0eSI6eyJmYWN0IjoicmVwb3NpdG9yeS1hY2Nlc3MiLCJvYnNlcnZlZEF0IjoxOTk5OTk5OTkwfSwiZXhwaXJlc0F0IjoyMDAwMDAwMTIwLCJpbnN0YWxsYXRpb24iOnsiaWQiOiIxMjM0NSJ9LCJpc3N1ZWRBdCI6MjAwMDAwMDAwMCwiaXNzdWVyIjoiaHR0cHM6Ly9ob3N0ZWQuZXhhbXBsZS9pc3N1ZXIvcHJpbWFyeSIsIm5vdEJlZm9yZSI6MjAwMDAwMDAwMCwib3BlcmF0aW9uIjoicHVsbFJlcXVlc3QuY3JlYXRlIiwicmVsYXlJZCI6InJlbGF5OnJ1bnRpbWUtN2U5ZiIsInJlcG9zaXRvcnkiOnsiaG9zdCI6ImdpdGh1Yi5jb20iLCJpZCI6IjEzMzA3NTU4NjAifSwicmVxdWVzdERpZ2VzdCI6InNoYTI1NjoxYmYyMjAxMzQ0ODQ1MjFkODRmMjE2ZDg2ZjFkYzk3NWQzYjg2MWVjZmI1ZGZjNzVjZDQ4MzcxNWYwYTVhMDYxIiwicmVxdWVzdElkIjoicmVxdWVzdDowMWo3czdoN204Iiwic3ViamVjdCI6eyJob3N0IjoiZ2l0aHViLmNvbSIsInByb3ZpZGVyIjoiZ2l0aHViIiwidXNlcklkIjoiNDI0MiJ9LCJ2ZXJzaW9uIjoxfQ.eTDfXaL0R9NVWoyEDJl91zT4Tn0wjnFhz57Nw6JzZNtYTlDMqkKNZhjRhGKnesP0__eHkrFSUmMTVMh05adWCA";

function semanticRequest(overrides: Record<string, unknown> = {}) {
  return {
    operation: "pullRequest.create",
    repository: { host: "github.com", id: "1330755860" },
    appId: "987654",
    installationId: "12345",
    target: {
      kind: "implementation",
      issue: 1316,
      branch: "feat/1316-repository-access-assertion-wire",
      head: "1234567890abcdef1234567890abcdef12345678",
      base: "epic/architecture-convergence",
    },
    input: { title: "Bound caller evidence", draft: true },
    ...overrides,
  };
}

function signingInput(overrides: Record<string, unknown> = {}): RepositoryAccessAssertionSigningInput {
  return {
    issuer: "https://hosted.example/issuer/primary",
    issuerKeyId,
    subject: { provider: "github", host: "github.com", userId: "4242" },
    audience: "runtime:4ec1558e-1015-4ea5-b5ea-ef941e6e12ac",
    relayId: "relay:runtime-7e9f",
    repository: { host: "github.com", id: "1330755860" },
    appId: "987654",
    installationId: "12345",
    eligibilityObservedAt: now - 10,
    issuedAt: now,
    notBefore: now,
    expiresAt: now + 120,
    assertionId: "assertion:01j7s7h7m9",
    requestId: "request:01j7s7h7m8",
    request: semanticRequest() as RepositoryAccessAssertionSigningInput["request"],
    ...overrides,
  } as RepositoryAccessAssertionSigningInput;
}

function expectedBindings(
  overrides: Partial<RepositoryAccessAssertionExpectedBindings> = {},
): RepositoryAccessAssertionExpectedBindings {
  const source = signingInput();
  return {
    issuer: source.issuer,
    issuerKeyId: source.issuerKeyId,
    subject: source.subject,
    audience: source.audience,
    relayId: source.relayId,
    repository: source.repository,
    appId: source.appId,
    installationId: source.installationId,
    request: source.request,
    ...overrides,
  };
}

function signInput(overrides: Partial<RepositoryAccessAssertionSigningInput> = {}): string {
  return signRepositoryAccessAssertion(signingInput(overrides as Record<string, unknown>), issuerPrivateKey);
}

function signedCustom(
  payloadOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): string {
  const input = signingInput();
  const payload = {
    version: 1,
    issuer: input.issuer,
    subject: input.subject,
    audience: input.audience,
    relayId: input.relayId,
    repository: input.repository,
    app: { id: input.appId },
    installation: { id: input.installationId },
    eligibility: { fact: "repository-access", observedAt: input.eligibilityObservedAt },
    issuedAt: input.issuedAt,
    notBefore: input.notBefore,
    expiresAt: input.expiresAt,
    assertionId: input.assertionId,
    requestId: input.requestId,
    operation: input.request.operation,
    requestDigest: repositoryAccessRequestDigest(input.request),
    ...payloadOverrides,
  };
  const header = {
    alg: "EdDSA",
    typ: "inari-repository-access-assertion",
    version: 1,
    kid: issuerKeyId,
    ...headerOverrides,
  };
  const encodedHeader = base64UrlEncodeText(canonicalJsonString(header as unknown as CanonicalJsonValue));
  const encodedPayload = base64UrlEncodeText(canonicalJsonString(payload as unknown as CanonicalJsonValue));
  const inputBytes = Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8");
  const signature = ed25519Sign(null, inputBytes, issuerPrivateKey).toString("base64url");
  return `${inputBytes.toString("utf8")}.${signature}`;
}

function assertDenied(action: () => unknown, code?: RepositoryAccessAssertionError["code"]): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof RepositoryAccessAssertionError);
    if (code !== undefined) assert.equal(error.code, code);
    assert.equal(error.message.length < 128, true);
    assert.equal(/token|Bearer|private|secret|githubusercontent/iu.test(error.message), false);
    return true;
  });
}

test("signs a deterministic v1 compact JWS with the separate Ed25519 issuer key", () => {
  const first = signInput();
  const second = signInput();
  assert.equal(first, second);
  assert.equal(first, DETERMINISTIC_V1_VECTOR);
  assert.equal(first.split(".").length, 3);
  assert.equal(first.length < REPOSITORY_ACCESS_ASSERTION_MAX_BYTES, true);
  assert.equal(first.includes("Bound caller evidence"), false);
  assert.equal(first.includes("title"), false);

  const evidence = verifyRepositoryAccessAssertion(first, {
    publicKey: issuerPublicKey,
    expected: expectedBindings(),
    now,
  });
  assert.deepEqual(evidence, {
    version: 1,
    issuer: "https://hosted.example/issuer/primary",
    issuerKeyId,
    subject: { provider: "github", host: "github.com", userId: "4242" },
    audience: "runtime:4ec1558e-1015-4ea5-b5ea-ef941e6e12ac",
    relayId: "relay:runtime-7e9f",
    repository: { host: "github.com", id: "1330755860" },
    appId: "987654",
    installationId: "12345",
    eligibilityObservedAt: now - 10,
    issuedAt: now,
    notBefore: now,
    expiresAt: now + 120,
    assertionId: "assertion:01j7s7h7m9",
    requestId: "request:01j7s7h7m8",
    operation: "pullRequest.create",
    requestDigest: repositoryAccessRequestDigest(signingInput().request),
  });
});

test("omits raw request secrets from the signed body and verified caller evidence", () => {
  const credential = "gho_inari-user-access-secret";
  const input = signingInput({
    request: semanticRequest({
      target: { kind: "repository-target", selector: credential },
      input: { content: "request", accessToken: credential },
    }) as RepositoryAccessAssertionSigningInput["request"],
  });
  const compact = signRepositoryAccessAssertion(input, issuerPrivateKey);
  const evidence = verifyRepositoryAccessAssertion(compact, {
    publicKey: issuerPublicKey,
    expected: expectedBindings({ request: input.request }),
    now,
  });
  assert.equal(compact.includes(credential), false);
  assert.equal(JSON.stringify(evidence).includes(credential), false);
  assertDenied(() =>
    verifyRepositoryAccessAssertion(credential, {
      publicKey: issuerPublicKey,
      expected: expectedBindings(),
      now,
    }),
  );
});

test("request digest covers the canonical complete operation, target, identities, and input", () => {
  const base = semanticRequest() as RepositoryAccessAssertionSigningInput["request"];
  const reordered = {
    input: base.input,
    target: base.target,
    installationId: base.installationId,
    appId: base.appId,
    repository: base.repository,
    operation: base.operation,
  };
  assert.equal(repositoryAccessRequestDigest(base), repositoryAccessRequestDigest(reordered));
  assert.notEqual(
    repositoryAccessRequestDigest(base),
    repositoryAccessRequestDigest({ ...base, input: { title: "changed", draft: true } }),
  );
  assert.notEqual(
    repositoryAccessRequestDigest(base),
    repositoryAccessRequestDigest({
      ...base,
      target: { ...(base.target as Record<string, unknown>), head: "different" },
    }),
  );
  assertDenied(() => repositoryAccessRequestDigest({ ...base, extra: true } as never), "INVALID_INPUT");
});

test("verification rejects wrong key, issuer, key id, subject, Runtime, Relay, repository, App, and installation", () => {
  const compact = signInput();
  const wrong = generateKeyPairSync("ed25519");
  assertDenied(
    () => verifyRepositoryAccessAssertion(compact, { publicKey: wrong.publicKey, expected: expectedBindings(), now }),
    "INVALID_SIGNATURE",
  );
  assertDenied(
    () =>
      verifyRepositoryAccessAssertion(compact, {
        publicKey: issuerPublicKey,
        expected: expectedBindings({ issuer: "https://other.example/issuer" }),
        now,
      }),
    "BINDING_MISMATCH",
  );
  const cases: Partial<RepositoryAccessAssertionExpectedBindings>[] = [
    { issuerKeyId: "other-key" },
    { subject: { provider: "github", host: "github.com", userId: "7" } },
    { audience: "runtime:other" },
    { relayId: "relay:other" },
    { repository: { host: "github.com", id: "999" } },
    { appId: "999" },
    { installationId: "999" },
  ];
  for (const expected of cases) {
    assertDenied(
      () =>
        verifyRepositoryAccessAssertion(compact, {
          publicKey: issuerPublicKey,
          expected: expectedBindings(expected),
          now,
        }),
      "BINDING_MISMATCH",
    );
  }
});

test("verification rejects a changed semantic request body, operation, or target", () => {
  const compact = signInput();
  const request = signingInput().request;
  const changed: RepositoryAccessAssertionExpectedBindings["request"][] = [
    { ...request, input: { title: "changed", draft: true } },
    { ...request, operation: "issue.create" },
    { ...request, target: { kind: "different" } },
  ];
  for (const candidate of changed) {
    assertDenied(
      () =>
        verifyRepositoryAccessAssertion(compact, {
          publicKey: issuerPublicKey,
          expected: expectedBindings({ request: candidate }),
          now,
        }),
      "BINDING_MISMATCH",
    );
  }
});

test("rejects algorithm confusion, unknown claims, and noncanonical protected JSON", () => {
  assertDenied(
    () =>
      verifyRepositoryAccessAssertion(signedCustom({}, { alg: "none" }), {
        publicKey: issuerPublicKey,
        expected: expectedBindings(),
        now,
      }),
    "INVALID_ASSERTION",
  );
  assertDenied(
    () =>
      verifyRepositoryAccessAssertion(signedCustom({ added: true }), {
        publicKey: issuerPublicKey,
        expected: expectedBindings(),
        now,
      }),
    "INVALID_ASSERTION",
  );
  assertDenied(
    () =>
      verifyRepositoryAccessAssertion(signedCustom({}, { added: true }), {
        publicKey: issuerPublicKey,
        expected: expectedBindings(),
        now,
      }),
    "INVALID_ASSERTION",
  );
  assertDenied(
    () =>
      verifyRepositoryAccessAssertion(signedCustom({}, { version: 2 }), {
        publicKey: issuerPublicKey,
        expected: expectedBindings(),
        now,
      }),
    "INVALID_ASSERTION",
  );
  assertDenied(
    () =>
      verifyRepositoryAccessAssertion(
        signedCustom({ subject: { provider: "other", host: "github.com", userId: "4242" } }),
        { publicKey: issuerPublicKey, expected: expectedBindings(), now },
      ),
    "INVALID_ASSERTION",
  );

  const canonical = signedCustom();
  const [headerSegment, payloadSegment] = canonical.split(".") as [string, string, string];
  const header = JSON.parse(Buffer.from(headerSegment, "base64url").toString("utf8")) as Record<string, unknown>;
  const noncanonicalHeader = Buffer.from(
    JSON.stringify({ kid: header.kid, version: header.version, typ: header.typ, alg: header.alg }),
    "utf8",
  ).toString("base64url");
  const inputBytes = Buffer.from(`${noncanonicalHeader}.${payloadSegment}`, "utf8");
  const signature = ed25519Sign(null, inputBytes, issuerPrivateKey).toString("base64url");
  assertDenied(
    () =>
      verifyRepositoryAccessAssertion(`${inputBytes.toString("utf8")}.${signature}`, {
        publicKey: issuerPublicKey,
        expected: expectedBindings(),
        now,
      }),
    "INVALID_ASSERTION",
  );
});

test("rejects malformed, padded, oversized, and tampered compact assertions without echoing them", () => {
  for (const malformed of [
    "",
    "a.b",
    "a.b.c.d",
    "***.e30.AA",
    `${"x".repeat(REPOSITORY_ACCESS_ASSERTION_MAX_BYTES + 1)}`,
  ]) {
    assertDenied(
      () =>
        verifyRepositoryAccessAssertion(malformed, {
          publicKey: issuerPublicKey,
          expected: expectedBindings(),
          now,
        }),
      "INVALID_ASSERTION",
    );
  }
  const compact = signInput();
  const segments = compact.split(".");
  segments[2] = `${segments[2]}A`;
  assertDenied(() =>
    verifyRepositoryAccessAssertion(segments.join("."), {
      publicKey: issuerPublicKey,
      expected: expectedBindings(),
      now,
    }),
  );
});

test("rejects future, expired, overlong, and stale-eligibility proofs", () => {
  const future = signInput({ issuedAt: now + 31, notBefore: now + 31, expiresAt: now + 151 });
  assertDenied(
    () =>
      verifyRepositoryAccessAssertion(future, {
        publicKey: issuerPublicKey,
        expected: expectedBindings(),
        now,
      }),
    "NOT_YET_VALID",
  );

  const expired = signInput({
    eligibilityObservedAt: now - 250,
    issuedAt: now - 200,
    notBefore: now - 200,
    expiresAt: now - 80,
  });
  assertDenied(
    () =>
      verifyRepositoryAccessAssertion(expired, {
        publicKey: issuerPublicKey,
        expected: expectedBindings(),
        now,
      }),
    "EXPIRED",
  );

  assertDenied(
    () => signRepositoryAccessAssertion(signingInput({ expiresAt: now + 121 }), issuerPrivateKey),
    "INVALID_INPUT",
  );
  assertDenied(
    () => signRepositoryAccessAssertion(signingInput({ eligibilityObservedAt: now + 1 }), issuerPrivateKey),
    "INVALID_INPUT",
  );
  assertDenied(
    () => signRepositoryAccessAssertion(signingInput({ expiresAt: now }), issuerPrivateKey),
    "INVALID_INPUT",
  );
  assertDenied(
    () =>
      verifyRepositoryAccessAssertion(
        signedCustom({ eligibility: { fact: "repository-access", observedAt: now + 1 } }),
        { publicKey: issuerPublicKey, expected: expectedBindings(), now },
      ),
    "INVALID_ASSERTION",
  );
  assertDenied(
    () =>
      verifyRepositoryAccessAssertion(signedCustom({ expiresAt: now }), {
        publicKey: issuerPublicKey,
        expected: expectedBindings(),
        now,
      }),
    "INVALID_ASSERTION",
  );

  const stale = signInput({ eligibilityObservedAt: now - 121 });
  assertDenied(
    () =>
      verifyRepositoryAccessAssertion(stale, {
        publicKey: issuerPublicKey,
        expected: expectedBindings(),
        now,
      }),
    "ELIGIBILITY_STALE",
  );
});

test("accepts a validated public JWK and rejects a private or non-Ed25519 verification key", () => {
  const compact = signInput();
  const jwk = issuerPublicKey.export({ format: "jwk" });
  assert.equal(
    verifyRepositoryAccessAssertion(compact, {
      publicKey: { kty: jwk.kty as "OKP", crv: jwk.crv as "Ed25519", x: jwk.x as string },
      expected: expectedBindings(),
      now,
    }).requestId,
    "request:01j7s7h7m8",
  );
  assertDenied(
    () =>
      verifyRepositoryAccessAssertion(compact, {
        publicKey: issuerPrivateKey,
        expected: expectedBindings(),
        now,
      }),
    "INVALID_KEY",
  );
  const malformedOptions = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("untrusted option secret");
      },
    },
  );
  assertDenied(() => verifyRepositoryAccessAssertion(compact, malformedOptions as never), "INVALID_ASSERTION");
});
