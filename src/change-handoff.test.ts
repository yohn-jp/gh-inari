import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMPLEMENTATION_HANDOFF_CONTRACT_VERSION,
  IMPLEMENTATION_HANDOFF_KIND,
  projectImplementationHandoff,
  tryProjectImplementationHandoff,
  validateImplementationHandoff,
} from "./change-handoff.js";
import { projectChangeFromGitHubEvidence, type ChangeIdentity, type ChangeProjectionResult } from "./change.js";

const identity: ChangeIdentity = {
  repositoryHost: "github.com",
  repositoryId: "100000219",
  rootIssue: 42,
};
const branch = "feat/42-canonical-change";

function projection(draft = true): ChangeProjectionResult {
  const result = projectChangeFromGitHubEvidence({
    change: identity,
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "canonical-change" },
    baseBranch: "main",
    evidence: {
      issue: { status: "available", value: { number: identity.rootIssue, state: "open" } },
      branches: { status: "available", value: [{ name: branch }] },
      pullRequests: {
        status: "available",
        value: [{ number: 142, head: branch, base: "main", state: "open", draft, merged: false }],
      },
    },
  });
  assert.equal(result.valid, true);
  return result;
}

test("healthy DRAFT Change projects to a bounded immutable implementation handoff", () => {
  const result = tryProjectImplementationHandoff(projection());
  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.handoff, {
    version: IMPLEMENTATION_HANDOFF_CONTRACT_VERSION,
    kind: IMPLEMENTATION_HANDOFF_KIND,
    repositoryHost: "github.com",
    repositoryId: "100000219",
    rootIssue: 42,
    changeVersion: 1,
    state: "DRAFT",
    branch,
    baseBranch: "main",
    pullRequest: 142,
  });
  assert.equal(Object.isFrozen(result.handoff), true);
  assert.equal(JSON.stringify(result.handoff), JSON.stringify(projectImplementationHandoff(projection())));
  assert.doesNotMatch(JSON.stringify(result.handoff), /worktree|session|process|checkout|runtime/iu);
});

test("healthy REVIEW evidence is not implementation-admissible", () => {
  const result = tryProjectImplementationHandoff(projection(false));
  assert.equal(result.valid, false);
  assert.equal(result.handoff, undefined);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_INVALID_STATE"));
});

test("partial, duplicate, ambiguous, wrong-base, and unavailable evidence fail closed", () => {
  const cases: readonly ChangeProjectionResult[] = [
    {
      ...projection(),
      valid: false,
      status: "partial",
      diagnostics: [
        {
          version: 1,
          code: "CHANGE_PROJECTION_PARTIAL",
          path: "$.evidence",
          message: "partial",
        },
      ],
    },
    {
      ...projection(),
      valid: false,
      status: "duplicate",
      diagnostics: [
        {
          version: 1,
          code: "CHANGE_PROJECTION_DUPLICATE",
          path: "$.evidence",
          message: "duplicate",
        },
      ],
    },
    {
      ...projection(),
      valid: false,
      status: "ambiguous",
      diagnostics: [
        {
          version: 1,
          code: "CHANGE_PROJECTION_AMBIGUOUS",
          path: "$.evidence",
          message: "ambiguous",
        },
      ],
    },
    {
      ...projection(),
      valid: false,
      status: "wrong-base",
      diagnostics: [
        {
          version: 1,
          code: "CHANGE_PROJECTION_WRONG_BASE",
          path: "$.evidence.pullRequests",
          message: "wrong base",
        },
      ],
    },
    {
      ...projection(),
      valid: false,
      status: "unavailable",
      diagnostics: [
        {
          version: 1,
          code: "CHANGE_PROJECTION_EVIDENCE_UNAVAILABLE",
          path: "$.evidence",
          message: "unavailable",
        },
      ],
    },
  ];
  for (const input of cases) {
    const result = tryProjectImplementationHandoff(input);
    assert.equal(result.valid, false, input.status);
    assert.equal(result.handoff, undefined, input.status);
    assert.ok(result.diagnostics.length > 0, input.status);
  }
});

test("handoff validation is closed-world and excludes local runtime ownership", () => {
  const valid = validateImplementationHandoff(projectImplementationHandoff(projection()));
  assert.equal(valid.valid, true);
  const invalid = validateImplementationHandoff({
    ...projectImplementationHandoff(projection()),
    worktree: "/tmp/inari",
    session: "worker-session",
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_UNKNOWN_PROPERTY"));
});
