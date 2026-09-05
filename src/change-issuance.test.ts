import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGE_CONTRACT_VERSION,
  ChangeIssuanceValidationError,
  planChangeIssuance,
  serializeChangeIssuancePlan,
  type ChangeGitHubEvidence,
  type ChangeIdentity,
  type ChangeProjectionInput,
  type ChangePullRequestEvidence,
} from "./change.js";

const identity: ChangeIdentity = {
  repositoryHost: "github.com",
  repositoryId: "100000214",
  rootIssue: 214,
};
const canonicalBranch = "feat/214-plan-idempotent-change-issuance";
const canonicalBaseBranch = "main";
const branchGovernance = { pattern: "^feat/[0-9]+-[a-z0-9-]+$" };
const naming = { type: "feat", slug: "plan-idempotent-change-issuance" };

function issueEvidence(): ChangeGitHubEvidence["issue"] {
  return { status: "available", value: { number: 214, state: "open" } };
}

function branches(names: readonly string[] = [canonicalBranch]): ChangeGitHubEvidence["branches"] {
  return { status: "available", value: names.map((name) => ({ name })) };
}

function pullRequests(
  candidates: readonly ChangePullRequestEvidence[] = [
    { number: 500, head: canonicalBranch, base: canonicalBaseBranch, state: "open", draft: true, merged: false },
  ],
): ChangeGitHubEvidence["pullRequests"] {
  return { status: "available", value: candidates };
}

function input(evidence: ChangeGitHubEvidence): ChangeProjectionInput {
  return {
    change: identity,
    branchGovernance,
    naming,
    baseBranch: canonicalBaseBranch,
    evidence,
  };
}

function issuanceError(evidence: ChangeGitHubEvidence): ChangeIssuanceValidationError {
  assert.throws(
    () => planChangeIssuance(input(evidence)),
    (error: unknown) => error instanceof ChangeIssuanceValidationError,
  );
  try {
    planChangeIssuance(input(evidence));
  } catch (error: unknown) {
    assert.ok(error instanceof ChangeIssuanceValidationError);
    return error;
  }
  throw new Error("Expected issuance planning to fail.");
}

test("issuance state table plans one ordered create transaction for an absent Change", () => {
  const plan = planChangeIssuance(
    input({ issue: issueEvidence(), branches: branches([]), pullRequests: pullRequests([]) }),
  );

  assert.equal(plan.version, CHANGE_CONTRACT_VERSION);
  assert.equal(plan.operation, "issue");
  assert.equal(plan.mode, "create");
  assert.equal(plan.sourceStatus, "absent");
  assert.equal(plan.transaction.idempotencyKey, "github.com#100000214#214");
  assert.deepEqual(plan.effects, [
    { kind: "CREATE_BRANCH", branch: canonicalBranch, baseBranch: canonicalBaseBranch },
    {
      kind: "CREATE_PULL_REQUEST",
      branch: canonicalBranch,
      baseBranch: canonicalBaseBranch,
      rootIssue: 214,
      title: "Change #214",
      body: "Closes #214",
      draft: true,
    },
  ]);
  assert.deepEqual(plan.verification, {
    phase: "post-effect",
    status: "healthy",
    canonicalBranch,
    canonicalBaseBranch,
    state: "DRAFT",
    pullRequest: { required: true },
  });
  assert.deepEqual(plan.result, {
    version: CHANGE_CONTRACT_VERSION,
    identity,
    state: "DRAFT",
    provenance: {},
    projection: { branch: canonicalBranch },
  });
});

test("issuance retry returns a healthy canonical Change without duplicate effects", () => {
  const plan = planChangeIssuance(
    input({ issue: issueEvidence(), branches: branches(), pullRequests: pullRequests() }),
  );

  assert.equal(plan.mode, "return-existing");
  assert.equal(plan.sourceStatus, "healthy");
  assert.deepEqual(plan.effects, []);
  assert.deepEqual(plan.result.projection, { branch: canonicalBranch, pullRequest: 500 });
  assert.deepEqual(plan.verification.pullRequest, { required: true, number: 500 });
});

test("issuance fails closed for every non-healthy projection state", () => {
  const cases: readonly [string, ChangeGitHubEvidence, string][] = [
    [
      "partial",
      { issue: issueEvidence(), branches: branches(), pullRequests: pullRequests([]) },
      "CHANGE_PROJECTION_PARTIAL",
    ],
    [
      "wrong-base",
      {
        issue: issueEvidence(),
        branches: branches(),
        pullRequests: pullRequests([
          { number: 501, head: canonicalBranch, base: "develop", state: "open", draft: true, merged: false },
        ]),
      },
      "CHANGE_PROJECTION_WRONG_BASE",
    ],
    [
      "duplicate",
      {
        issue: issueEvidence(),
        branches: branches(),
        pullRequests: pullRequests([
          { number: 500, head: canonicalBranch, base: canonicalBaseBranch, state: "open", draft: true, merged: false },
          { number: 501, head: canonicalBranch, base: canonicalBaseBranch, state: "open", draft: false, merged: false },
        ]),
      },
      "CHANGE_PROJECTION_DUPLICATE",
    ],
    [
      "ambiguous",
      {
        issue: issueEvidence(),
        branches: branches([]),
        pullRequests: pullRequests([
          {
            number: 502,
            head: "feat/214-first-candidate",
            base: canonicalBaseBranch,
            state: "open",
            draft: true,
            merged: false,
            rootIssue: 214,
          },
          {
            number: 503,
            head: "feat/214-second-candidate",
            base: canonicalBaseBranch,
            state: "open",
            draft: true,
            merged: false,
            rootIssue: 214,
          },
        ]),
      },
      "CHANGE_PROJECTION_AMBIGUOUS",
    ],
    [
      "unavailable",
      {
        issue: issueEvidence(),
        branches: branches([]),
        pullRequests: { status: "unavailable", reason: "permission denied" },
      },
      "CHANGE_PROJECTION_EVIDENCE_UNAVAILABLE",
    ],
  ];

  for (const [label, evidence, diagnosticCode] of cases) {
    const error = issuanceError(evidence);
    assert.ok(
      error.diagnostics.some((diagnostic) => diagnostic.code === diagnosticCode),
      label,
    );
  }
});

test("issuance fails closed for a canonical root-Issue conflict", () => {
  const error = issuanceError({
    issue: issueEvidence(),
    branches: branches(),
    pullRequests: pullRequests([
      {
        number: 504,
        head: canonicalBranch,
        base: canonicalBaseBranch,
        state: "open",
        draft: true,
        merged: false,
        rootIssue: 999,
      },
    ]),
  });
  assert.ok(error.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_PROJECTION_AMBIGUOUS"));
});

test("issuance plans and serialized verification are deterministic", () => {
  const first = planChangeIssuance(
    input({
      issue: issueEvidence(),
      branches: branches(["feat/214-other", canonicalBranch]),
      pullRequests: pullRequests([
        { number: 501, head: "feat/214-other", base: canonicalBaseBranch, state: "open", draft: false, merged: false },
        { number: 500, head: canonicalBranch, base: canonicalBaseBranch, state: "open", draft: true, merged: false },
      ]),
    }),
  );
  const reordered = planChangeIssuance(
    input({
      issue: issueEvidence(),
      branches: branches([canonicalBranch, "feat/214-other"]),
      pullRequests: pullRequests([
        { number: 500, head: canonicalBranch, base: canonicalBaseBranch, state: "open", draft: true, merged: false },
        { number: 501, head: "feat/214-other", base: canonicalBaseBranch, state: "open", draft: false, merged: false },
      ]),
    }),
  );

  assert.deepEqual(reordered, first);
  assert.equal(serializeChangeIssuancePlan(reordered), serializeChangeIssuancePlan(first));
});
