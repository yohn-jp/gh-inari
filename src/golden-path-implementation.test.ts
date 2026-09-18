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
        conformance: { version: 1, kind: "implementation-conformance", status: "missing-verification", valid: false },
      }),
    ],
    [
      "ready-change",
      native({ conformance: { version: 1, kind: "implementation-conformance", status: "conformant", valid: true } }),
    ],
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
      readiness: {
        version: 1,
        kind: "implementation-readiness-admission",
        valid: false,
        admitted: false,
        classification: "BLOCKED",
        implementation,
      },
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
