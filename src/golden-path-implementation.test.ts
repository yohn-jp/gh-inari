import assert from "node:assert/strict";
import test from "node:test";
import { projectGoldenPathImplementation, tryProjectGoldenPathImplementation } from "./golden-path-implementation.js";
import { projectGoldenPathStatus } from "./golden-path-status.js";

const sourceIssue = {
  repositoryHost: "github.com",
  repositoryId: "100000219",
  repository: "acme/inari",
  number: 680,
} as const;
const implementation = { ...sourceIssue, number: 681 } as const;

function authorization(status: "ready" | "authorized" = "authorized") {
  return {
    status,
    valid: true,
    authorized: status === "authorized",
    current: status === "authorized",
    implementation,
  };
}

function conformance(status: string, valid: boolean) {
  return {
    version: 1,
    kind: "implementation-conformance",
    status,
    valid,
    authorization: { authorized: true, current: true, violations: [] },
    changes: [],
    verification: {
      requiredChecks: [],
      requiredTests: [],
      satisfiedChecks: [],
      satisfiedTests: [],
      missingChecks: [],
      missingTests: [],
      failedChecks: [],
      failedTests: [],
      unverifiableChecks: [],
      unverifiableTests: [],
    },
    diagnostics: [],
  };
}

function readiness(classification: "READY" | "BLOCKED" | "INVALID", admitted: boolean, valid: boolean) {
  return {
    version: 1,
    kind: "implementation-readiness-admission",
    valid,
    admitted,
    classification,
    implementation,
    evidence: [],
    unverifiedPrerequisites: [],
    diagnostics: [],
  };
}

function rawAuthorizationRecord() {
  return {
    version: 1,
    kind: "implementation-authorization",
    implementation,
    contractVersion: 1,
    repository: {
      repositoryHost: implementation.repositoryHost,
      repositoryId: implementation.repositoryId,
      repository: implementation.repository,
    },
    base: { branch: "main", revision: "0".repeat(40), freshness: "0".repeat(40) },
    governedBodyDigest: "0".repeat(64),
  };
}

function change(
  state: "DEFINED" | "DRAFT" | "REVIEW" | "MERGED",
  projectionStatus = state === "DEFINED" ? "absent" : "healthy",
) {
  return {
    identity: {
      repositoryHost: implementation.repositoryHost,
      repositoryId: implementation.repositoryId,
      rootIssue: implementation.number,
    },
    state,
    projectionStatus,
  };
}

function native(overrides: Record<string, unknown> = {}) {
  return {
    sourceIssue,
    implementation,
    authorization: authorization(),
    change: change("DRAFT"),
    ...overrides,
  };
}

test("native composition projects the Implementation lifecycle states from canonical evidence", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["draft", { sourceIssue, implementation }],
    ["ready-to-authorize", { sourceIssue, implementation, authorization: authorization("ready") }],
    ["authorized", native({ change: change("DEFINED") })],
    ["active", native()],
    [
      "conformance-required",
      native({
        conformance: conformance("missing-verification", false),
      }),
    ],
    ["ready-change", native({ conformance: conformance("conformant", true) })],
    ["review", native({ change: change("REVIEW") })],
    ["terminal", native({ change: change("MERGED") })],
  ];

  for (const [expected, input] of cases) {
    const result = projectGoldenPathImplementation(input);
    assert.equal(result.status, expected);
    assert.equal(result.compatibility, "implementation-native");
    assert.deepEqual(result.sourceIssue, sourceIssue);
    assert.deepEqual(result.implementation, implementation);
  }
});

test("blocked readiness is projected as blocked without creating a Golden Path lifecycle", () => {
  const result = projectGoldenPathImplementation(
    native({
      readiness: readiness("BLOCKED", false, false),
    }),
  );
  assert.equal(result.status, "blocked");
});

test("native composition rejects a Change rooted in the source Issue", () => {
  const result = tryProjectGoldenPathImplementation(
    native({
      change: {
        identity: {
          repositoryHost: sourceIssue.repositoryHost,
          repositoryId: sourceIssue.repositoryId,
          rootIssue: sourceIssue.number,
        },
        state: "DRAFT",
        projectionStatus: "healthy",
      },
    }),
  );
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((entry) => entry.code === "GOLDEN_PATH_IMPLEMENTATION_IDENTITY_MISMATCH"));
});

test("historical Issue-root compatibility is explicit and never becomes native", () => {
  const result = projectGoldenPathImplementation({
    sourceIssue,
    compatibility: "historical-issue-root",
    change: {
      identity: {
        repositoryHost: sourceIssue.repositoryHost,
        repositoryId: sourceIssue.repositoryId,
        rootIssue: sourceIssue.number,
      },
      state: "DRAFT",
      projectionStatus: "healthy",
    },
  });
  assert.equal(result.compatibility, "historical-issue-root");
  assert.equal(result.status, "active");
  assert.equal(result.implementation, undefined);
});

test("a bare authorization record alone can never assert authorized or current state", () => {
  const result = projectGoldenPathImplementation({
    sourceIssue,
    implementation,
    authorization: rawAuthorizationRecord(),
  });
  assert.equal(result.status, "draft");
  assert.equal(result.authorizationStatus, undefined);
});

test("a caller-forged authorized/current flag without an explicit canonical status cannot reach authorized state", () => {
  const result = projectGoldenPathImplementation({
    sourceIssue,
    implementation,
    authorization: { record: rawAuthorizationRecord(), authorized: true, current: true },
  });
  // authorized/current alone are insufficient; only an explicit canonical
  // status of "authorized" composed by the lifecycle authority can do that.
  assert.equal(result.status, "draft");
});

test("an authoritative aborted lifecycle is terminal and cannot re-enter authorized/active/ready state", () => {
  const abortedAuthorization = { status: "aborted", valid: true, authorized: false, current: false, implementation };
  const result = projectGoldenPathImplementation(native({ authorization: abortedAuthorization }));
  assert.equal(result.status, "terminal");
  assert.equal(result.authorizationStatus, "aborted");
});

test("a forged authorized/current flag on an aborted authorization still cannot escape terminal state", () => {
  const forgedAbortedAuthorization = {
    status: "aborted",
    valid: true,
    authorized: true,
    current: true,
    implementation,
  };
  const result = projectGoldenPathImplementation(native({ authorization: forgedAbortedAuthorization }));
  assert.equal(result.status, "terminal");
});

test("an abbreviated readiness lookalike cannot advance Golden Path state", () => {
  const result = tryProjectGoldenPathImplementation(
    native({
      readiness: {
        version: 1,
        kind: "implementation-readiness-admission",
        valid: true,
        admitted: true,
        classification: "READY",
        implementation,
      },
    }),
  );
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((entry) => entry.code === "GOLDEN_PATH_IMPLEMENTATION_READINESS_INVALID"));
});

test("an abbreviated conformance lookalike cannot advance Golden Path state to ready-change", () => {
  const result = tryProjectGoldenPathImplementation(
    native({ conformance: { version: 1, kind: "implementation-conformance", status: "conformant", valid: true } }),
  );
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((entry) => entry.code === "GOLDEN_PATH_IMPLEMENTATION_CONFORMANCE_INVALID"));
  assert.notEqual(result.projection?.status, "ready-change");
});

test("status composition exposes source and executable identities while adapters retain the shared envelope", () => {
  const result = projectGoldenPathStatus({
    environment: true,
    governance: true,
    sourceIssue: { reference: sourceIssue, status: "present", governed: true },
    implementation: { reference: implementation, authorization: authorization(), change: change("DRAFT") },
  });
  assert.equal(result.status.phase, "IMPLEMENTATION");
  assert.equal(result.status.implementation, "active");
  assert.equal(result.implementation?.status, "active");
  assert.deepEqual(result.subject, {
    repositoryHost: "github.com",
    repositoryId: "100000219",
    sourceIssue: 680,
    implementation: 681,
    rootIssue: 681,
  });
});
