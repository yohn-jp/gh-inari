import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPABILITY_PROVENANCE_VERSION,
  createCapabilityExecutionProvenance,
  normalizeCapabilityExecutionProvenance,
  omitUnauthenticatedCapabilityExecutionProvenance,
  redactCapabilityExecutionProvenance,
  validateCapabilityExecutionProvenance,
} from "./capability-provenance.js";

const REPOSITORY = {
  repositoryHost: "github.com",
  repositoryId: "123456789",
  nameWithOwner: "acme/inari",
} as const;

const BASE = {
  version: CAPABILITY_PROVENANCE_VERSION,
  stage: "authenticated" as const,
  repository: REPOSITORY,
  runtimeAuthority: { id: "runtime-a", kid: "runtime-a" },
  session: { id: "session-a", certificateJti: "certificate-a" },
  authority: { ref: "main", sha: "a".repeat(40) },
  request: {
    requestId: "request-a",
    operation: "change.issue",
    issuedAt: 1_757_635_200,
    expiresAt: 1_757_635_260,
  },
  subject: { kind: "change" as const, issue: 376 },
};

const ADMITTED = {
  ...BASE,
  stage: "authorized" as const,
  capability: { kind: "change.implement" as const, issue: 376 },
};

const APP_SCOPED = {
  ...ADMITTED,
  stage: "app-scoped" as const,
  app: {
    kind: "github-app" as const,
    slug: "inari-issuer" as const,
    appId: "123",
    principal: "app:inari-issuer" as const,
    installationId: "456",
  },
};

test("normalizes successful authenticated provenance into an immutable bounded value", () => {
  const result = normalizeCapabilityExecutionProvenance({
    ...BASE,
    agent: { name: "codex", version: "1", runtime: "test" },
  });

  assert.ok(result);
  assert.equal(result.version, 1);
  assert.equal(result.stage, "authenticated");
  assert.equal(result.capability, undefined);
  assert.equal(result.app, undefined);
  assert.deepEqual(result.agent, { name: "codex", version: "1", runtime: "test" });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.repository), true);
  assert.equal(Object.isFrozen(result.request), true);
  assert.equal(Object.isFrozen(result.agent), true);
  assert.equal(JSON.stringify(result).includes("privateKey"), false);
});

test("authentication failure has no fabricated Session provenance", () => {
  const unauthenticated = { ...BASE, session: undefined };
  assert.equal(normalizeCapabilityExecutionProvenance(unauthenticated), undefined);
  assert.equal(omitUnauthenticatedCapabilityExecutionProvenance(), undefined);
});

test("admission denial cannot be represented as authorized provenance", () => {
  const denied = { ...BASE, stage: "authorized" as const };
  const result = validateCapabilityExecutionProvenance(denied);

  assert.equal(result.valid, false);
  assert.equal(normalizeCapabilityExecutionProvenance(denied), undefined);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.path === "$.capability"));
});

test("provider failure retains only the reached App-scoped identity", () => {
  const providerFailure = {
    ...APP_SCOPED,
    providerResponse: { status: 500, body: "installation token leaked here" },
    error: "provider stack and arbitrary error text",
  };
  const result = normalizeCapabilityExecutionProvenance(providerFailure);
  const redacted = redactCapabilityExecutionProvenance(providerFailure);

  assert.equal(result, undefined);
  assert.ok(redacted);
  assert.equal("providerResponse" in redacted, false);
  assert.equal("error" in redacted, false);
  assert.equal(JSON.stringify(redacted).includes("token"), false);
});

test("recovery-required execution remains bounded and does not claim verification", () => {
  const recoveryRequired = {
    ...APP_SCOPED,
    stage: "app-scoped" as const,
    recovery: "recovery-required after provider timeout",
  };
  const result = normalizeCapabilityExecutionProvenance(recoveryRequired);
  const redacted = redactCapabilityExecutionProvenance(recoveryRequired);

  assert.equal(result, undefined);
  assert.ok(redacted);
  assert.equal(redacted.stage, "app-scoped");
  assert.equal("recovery" in redacted, false);
});

test("malformed provenance fails closed without retaining unsafe evidence", () => {
  const malformed = {
    ...BASE,
    authority: { ref: "main", sha: "not-a-policy-sha\u0000" },
    sessionPrivateKey: "-----BEGIN PRIVATE KEY-----",
    certificate: "eyJhbGciOiJFZERTQSJ9.secret.jwt",
    signedRequestBody: "raw request body",
  };
  const result = validateCapabilityExecutionProvenance(malformed);

  assert.equal(result.valid, false);
  assert.equal(result.value, undefined);
  assert.equal(normalizeCapabilityExecutionProvenance(malformed), undefined);
  assert.ok(result.diagnostics.every((diagnostic) => !diagnostic.message.includes("PRIVATE KEY")));
});

test("verified provenance separates commit author from App mutation actor", () => {
  const verified = createCapabilityExecutionProvenance({
    ...APP_SCOPED,
    stage: "verified" as const,
    commitAuthor: { name: "Implementation Author", email: "author@example.test" },
  });

  assert.equal(verified.stage, "verified");
  assert.deepEqual(verified.commitAuthor, {
    name: "Implementation Author",
    email: "author@example.test",
  });
  assert.deepEqual(verified.app, {
    kind: "github-app",
    slug: "inari-issuer",
    appId: "123",
    principal: "app:inari-issuer",
    installationId: "456",
  });
  assert.equal("providerActor" in verified, false);
  assert.equal("effectEvidence" in verified, false);
  assert.equal(JSON.stringify(verified).includes("secret"), false);
});

test("stage transitions require the exact evidence established at each boundary", () => {
  assert.equal(
    normalizeCapabilityExecutionProvenance({ ...BASE, stage: "authenticated", capability: ADMITTED.capability }),
    undefined,
  );
  assert.equal(normalizeCapabilityExecutionProvenance({ ...ADMITTED, app: APP_SCOPED.app }), undefined);
  assert.equal(normalizeCapabilityExecutionProvenance({ ...ADMITTED, stage: "verified" }), undefined);
  assert.ok(normalizeCapabilityExecutionProvenance(ADMITTED));
  assert.ok(normalizeCapabilityExecutionProvenance(APP_SCOPED));
});
