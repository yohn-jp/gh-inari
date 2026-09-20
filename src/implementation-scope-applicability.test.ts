import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMPLEMENTATION_AUTHORIZATION_KIND,
  IMPLEMENTATION_AUTHORIZATION_VERSION,
} from "./implementation-authorization.js";
import { IMPLEMENTATION_CONTRACT_VERSION } from "./implementation-contract.js";
import {
  IMPLEMENTATION_SCOPE_PROJECTION_KIND,
  IMPLEMENTATION_SCOPE_PROJECTION_VERSION,
  validateImplementationScopeProjection,
} from "./implementation-scope-projection.js";
import {
  isImplementationScopeApplicable,
  validateImplementationScopeApplicability,
} from "./implementation-scope-applicability.js";

const repository = {
  repositoryHost: "github.com",
  repositoryId: "1330755860",
  repository: "yohn-jp/gh-inari",
} as const;
const base = { branch: "main", revision: "a".repeat(40), freshness: "fresh-1" } as const;
const authorization = {
  version: IMPLEMENTATION_AUTHORIZATION_VERSION,
  kind: IMPLEMENTATION_AUTHORIZATION_KIND,
  contractVersion: IMPLEMENTATION_CONTRACT_VERSION,
  implementation: { ...repository, number: 860 },
  governedBodyDigest: "b".repeat(64),
} as const;

const artifact = validateImplementationScopeProjection({
  version: IMPLEMENTATION_SCOPE_PROJECTION_VERSION,
  kind: IMPLEMENTATION_SCOPE_PROJECTION_KIND,
  authorization,
  repository,
  base,
  branch: "feat/860-execution-scope-applicability",
  scope: {
    readOnly: ["AGENTS.md"],
    write: ["src/index.ts"],
    create: ["src/implementation-scope-applicability.ts"],
    delete: [],
    deny: ["src/github/**"],
  },
}).projection;

if (artifact === undefined) throw new Error("Applicability test artifact must be valid.");

function evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { repository, base, authorization, ...overrides };
}

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { artifact, current: evidence(), ...overrides };
}

test("returns current only when repository, base, version, and authorization identity match", () => {
  const result = validateImplementationScopeApplicability(input());
  assert.equal(result.valid, true);
  assert.equal(result.applicable, true);
  assert.equal(result.status, "current");
  assert.deepEqual(result.violations, []);
  assert.equal(isImplementationScopeApplicable(input()), true);
  assert.equal(Object.isFrozen(result.artifact), true);
});

test("fails closed on repository identity mismatch", () => {
  const result = validateImplementationScopeApplicability(
    input({ current: evidence({ repository: { ...repository, repositoryId: "1330755861" } }) }),
  );
  assert.equal(result.valid, false);
  assert.equal(result.status, "mismatch");
  assert.ok(
    result.violations.some((violation) => violation.code === "IMPLEMENTATION_SCOPE_APPLICABILITY_REPOSITORY_MISMATCH"),
  );
});

test("classifies base revision and freshness drift as stale", () => {
  const revision = validateImplementationScopeApplicability(
    input({ current: evidence({ base: { ...base, revision: "c".repeat(40) } }) }),
  );
  assert.equal(revision.valid, false);
  assert.equal(revision.status, "stale");
  assert.ok(
    revision.violations.some(
      (violation) => violation.code === "IMPLEMENTATION_SCOPE_APPLICABILITY_BASE_REVISION_STALE",
    ),
  );

  const freshness = validateImplementationScopeApplicability(
    input({ current: evidence({ base: { ...base, freshness: "fresh-2" } }) }),
  );
  assert.equal(freshness.valid, false);
  assert.equal(freshness.status, "stale");
  assert.ok(
    freshness.violations.some(
      (violation) => violation.code === "IMPLEMENTATION_SCOPE_APPLICABILITY_BASE_FRESHNESS_STALE",
    ),
  );
});

test("fails closed on authorization identity mismatch", () => {
  const result = validateImplementationScopeApplicability(
    input({
      current: evidence({
        authorization: { ...authorization, governedBodyDigest: "c".repeat(64) },
      }),
    }),
  );
  assert.equal(result.valid, false);
  assert.equal(result.status, "mismatch");
  assert.ok(
    result.violations.some(
      (violation) => violation.code === "IMPLEMENTATION_SCOPE_APPLICABILITY_AUTHORIZATION_MISMATCH",
    ),
  );
});

test("fails closed on unsupported artifact versions and current evidence shape", () => {
  const unsupported = validateImplementationScopeApplicability({
    artifact: { ...artifact, version: 2 },
    current: evidence(),
  });
  assert.equal(unsupported.valid, false);
  assert.equal(unsupported.status, "unsupported");
  assert.ok(
    unsupported.violations.some(
      (violation) => violation.code === "IMPLEMENTATION_SCOPE_APPLICABILITY_ARTIFACT_VERSION_UNSUPPORTED",
    ),
  );

  const malformedCurrent = validateImplementationScopeApplicability(
    input({ current: { ...evidence(), refreshedAuthorization: true } }),
  );
  assert.equal(malformedCurrent.valid, false);
  assert.equal(malformedCurrent.status, "unsupported");
  assert.ok(
    malformedCurrent.violations.some(
      (violation) => violation.code === "IMPLEMENTATION_SCOPE_APPLICABILITY_CURRENT_EVIDENCE_INVALID",
    ),
  );
});

test("does not accept Issue prose or a local authority refresh field", () => {
  const result = validateImplementationScopeApplicability({
    ...input(),
    body: "### Repository\n...",
    refreshAuthorization: true,
  });
  assert.equal(result.valid, false);
  assert.equal(result.status, "unsupported");
  assert.equal(isImplementationScopeApplicable({ ...input(), refreshAuthorization: true }), false);
});
