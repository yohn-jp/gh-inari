import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChangeIssuanceRecoveryValidationError,
  CHANGE_TRANSITION_CONTRACT_VERSION,
  planChangeRecovery,
  planChangeIssuance,
  planChangeIssuanceCompensation,
  planChangeIssuanceRecovery,
  planChangeTransition,
  serializeChangeIssuanceRecoveryPlan,
  type ChangeGitHubEvidence,
  type ChangeIssuancePlan,
  type ChangeProjectionInput,
  type ChangePullRequestEvidence,
} from "./change.js";

const identity = {
  repositoryHost: "github.com",
  repositoryId: "100000215",
  rootIssue: 215,
} as const;
const canonicalBranch = "feat/215-define-change-compensation-recovery-plans";
const canonicalBaseBranch = "main";
const branchGovernance = { pattern: "^feat/[0-9]+-[a-z0-9-]+$" };
const naming = { type: "feat", slug: "define-change-compensation-recovery-plans" };

function issueEvidence(): ChangeGitHubEvidence["issue"] {
  return { status: "available", value: { number: 215, state: "open" } };
}

function branchEvidence(names: readonly string[] = [canonicalBranch]): ChangeGitHubEvidence["branches"] {
  return { status: "available", value: names.map((name) => ({ name })) };
}

function pullRequestEvidence(
  candidates: readonly ChangePullRequestEvidence[] = [],
): ChangeGitHubEvidence["pullRequests"] {
  return { status: "available", value: candidates };
}

function projectionInput(evidence: ChangeGitHubEvidence): ChangeProjectionInput {
  return {
    change: identity,
    branchGovernance,
    naming,
    baseBranch: canonicalBaseBranch,
    evidence,
  };
}

function issuancePlan(): ChangeIssuancePlan {
  return planChangeIssuance(
    projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence([]),
      pullRequests: pullRequestEvidence([]),
    }),
  );
}

function branchCreatedPrFailed(plan = issuancePlan()) {
  return {
    issuance: plan,
    attemptedEffects: [
      { effect: plan.effects[0]!, status: "succeeded" as const },
      { effect: plan.effects[1]!, status: "failed" as const },
    ],
    failure: {
      effect: plan.effects[1]!,
      code: "PULL_REQUEST_CREATE_FAILED",
      message: "The Draft pull request effect failed.",
    },
    projection: projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence(),
      pullRequests: pullRequestEvidence([]),
    }),
  };
}

test("branch creation success followed by PR creation failure yields explicit branch compensation", () => {
  const plan = planChangeIssuanceCompensation(branchCreatedPrFailed());

  assert.deepEqual(plan.effects, [{ kind: "DELETE_BRANCH", branch: canonicalBranch }]);
  assert.deepEqual(plan.transaction, plan.issuance.transaction);
  assert.deepEqual(
    plan.failureEvidence.attemptedEffects.map((attempt) => attempt.status),
    ["succeeded", "failed"],
  );
  assert.equal(plan.failureEvidence.failure.effect.kind, "CREATE_PULL_REQUEST");
  assert.deepEqual(plan.verification, {
    phase: "post-compensation",
    status: "absent",
    canonicalBranch,
    canonicalBaseBranch,
    state: "DEFINED",
    pullRequest: { required: false },
  });
});

test("successful compensation returns an explicit no-issued-Change/DEFINED result", () => {
  const input = branchCreatedPrFailed();
  const plan = planChangeIssuanceRecovery({
    ...input,
    compensation: {
      status: "succeeded",
      projection: projectionInput({
        issue: issueEvidence(),
        branches: branchEvidence([]),
        pullRequests: pullRequestEvidence([]),
      }),
    },
  });

  assert.equal(plan.compensation.status, "succeeded");
  assert.equal(plan.result.status, "compensated");
  assert.equal(plan.result.state, "DEFINED");
  assert.equal(plan.result.issued, false);
  assert.deepEqual(plan.result.change, {
    version: 1,
    identity,
    state: "DEFINED",
    provenance: {},
  });
  assert.equal(plan.result.change.projection, undefined);
});

test("failed compensation yields RECOVERY_REQUIRED and preserves bounded repair evidence", () => {
  const input = branchCreatedPrFailed();
  const plan = planChangeIssuanceRecovery({
    ...input,
    compensation: {
      status: "failed",
      projection: input.projection,
      failure: {
        effect: { kind: "DELETE_BRANCH", branch: canonicalBranch },
        code: "BRANCH_DELETE_FAILED",
        message: "The branch compensation effect failed.",
      },
    },
  });

  assert.equal(plan.compensation.status, "failed");
  assert.equal(plan.result.status, "recovery-required");
  assert.equal(plan.result.state, "RECOVERY_REQUIRED");
  assert.equal(plan.result.issued, false);
  assert.equal(plan.result.change.state, "RECOVERY_REQUIRED");
  assert.deepEqual(plan.result.change.projection, { branch: canonicalBranch });
  assert.equal(plan.compensation.outcome?.failure?.code, "BRANCH_DELETE_FAILED");
  assert.equal(plan.failureEvidence.failure.code, "PULL_REQUEST_CREATE_FAILED");
});

test("recovery planning and retry serialization are deterministic", () => {
  const firstInput = {
    ...branchCreatedPrFailed(),
    projection: projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence(["feat/215-unrelated", canonicalBranch]),
      pullRequests: pullRequestEvidence([
        {
          number: 902,
          head: "feat/215-unrelated",
          base: canonicalBaseBranch,
          state: "open",
          draft: true,
          merged: false,
        },
      ]),
    }),
  };
  const reorderedInput = {
    ...firstInput,
    projection: projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence([canonicalBranch, "feat/215-unrelated"]),
      pullRequests: pullRequestEvidence([
        {
          number: 902,
          head: "feat/215-unrelated",
          base: canonicalBaseBranch,
          state: "open",
          draft: true,
          merged: false,
        },
      ]),
    }),
  };
  const first = planChangeIssuanceRecovery(firstInput);
  const reordered = planChangeIssuanceRecovery(reorderedInput);

  assert.deepEqual(reordered, first);
  assert.equal(serializeChangeIssuanceRecoveryPlan(reordered), serializeChangeIssuanceRecoveryPlan(first));

  const retry = planChangeIssuance(
    projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence([]),
      pullRequests: pullRequestEvidence([]),
    }),
  );
  assert.deepEqual(retry, first.issuance);
});

test("ambiguous, unavailable, and inconsistent failure evidence fail closed without a delete plan", () => {
  const base = branchCreatedPrFailed();
  const ambiguous = {
    ...base,
    projection: projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence(),
      pullRequests: pullRequestEvidence([
        {
          number: 903,
          head: "feat/215-first-candidate",
          base: canonicalBaseBranch,
          state: "open",
          draft: true,
          merged: false,
          rootIssue: 215,
        },
        {
          number: 904,
          head: "feat/215-second-candidate",
          base: canonicalBaseBranch,
          state: "open",
          draft: true,
          merged: false,
          rootIssue: 215,
        },
      ]),
    }),
  };
  const unavailable = {
    ...base,
    projection: projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence(),
      pullRequests: { status: "unavailable", reason: "permission denied" },
    }),
  };
  const inconsistent = {
    ...base,
    projection: projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence([]),
      pullRequests: pullRequestEvidence([]),
    }),
  };

  for (const input of [ambiguous, unavailable, inconsistent]) {
    assert.throws(
      () => planChangeIssuanceCompensation(input),
      (error: unknown) => error instanceof ChangeIssuanceRecoveryValidationError,
    );
    assert.throws(
      () => planChangeIssuanceRecovery(input),
      (error: unknown) => error instanceof ChangeIssuanceRecoveryValidationError,
    );
  }
});

test("shared transition recovery plans retain abort provenance and only the pending cleanup effect", () => {
  const change = {
    version: 1 as const,
    identity,
    state: "DRAFT" as const,
    provenance: { requester: "human:sophia", issuer: "app:inari-issuer", implementer: "agent:codex" },
    projection: { branch: canonicalBranch, pullRequest: 901 },
  };
  const transition = planChangeTransition({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    transition: "abort",
    change,
  });
  const projection = projectionInput({
    issue: issueEvidence(),
    branches: branchEvidence(),
    pullRequests: pullRequestEvidence([
      {
        number: 901,
        head: canonicalBranch,
        base: canonicalBaseBranch,
        state: "closed",
        draft: false,
        merged: false,
        provenance: { issuer: "app:inari-issuer" },
      },
    ]),
  });
  const plan = planChangeRecovery({
    transition,
    attemptedEffects: [
      { effect: transition.effects[0]!, status: "succeeded" as const },
      { effect: transition.effects[1]!, status: "failed" as const },
    ],
    failure: {
      effect: transition.effects[1]!,
      code: "BRANCH_DELETE_FAILED",
      message: "The branch deletion effect failed.",
    },
    projection,
  });

  assert.equal(plan.operation, "recover-transition");
  if (plan.operation !== "recover-transition") throw new Error("expected transition recovery");
  assert.deepEqual(plan.effects, [{ kind: "DELETE_BRANCH", branch: canonicalBranch }]);
  assert.equal(plan.result.change.state, "RECOVERY_REQUIRED");
  assert.deepEqual(plan.result.change.provenance, {
    requester: "human:sophia",
    issuer: "app:inari-issuer",
    implementer: "agent:codex",
  });
});
