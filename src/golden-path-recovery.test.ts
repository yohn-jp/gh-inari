import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GOLDEN_PATH_RECOVERY_CLASSES,
  GOLDEN_PATH_RECOVERY_ACTIONS,
  deserializeGoldenPathRecovery,
  isGoldenPathRecovery,
  projectGoldenPathRecovery,
  serializeGoldenPathRecovery,
  validateGoldenPathRecovery,
  type GoldenPathRecoveryInput,
} from "./golden-path-recovery.js";
import {
  planChangeIssuance,
  planChangeIssuanceRecovery,
  planChangeTransition,
  planChangeTransitionRecovery,
  type ChangeBranchEvidence,
  type ChangeIdentity,
  type ChangeProjectionInput,
  type ChangeProjectionResult,
  type ChangePullRequestEvidence,
} from "./change.js";
import type { ChangeRemoteExecutionEvidence } from "./change-executor.js";

const branch = "feat/395-golden-path";
const branchSha = "0123456789abcdef0123456789abcdef01234567";
const coreIdentity: ChangeIdentity = { repositoryHost: "github.com", repositoryId: "100", rootIssue: 395 };
const branchGovernance = { pattern: "^feat/[0-9]+-[a-z0-9-]+$" } as const;
const naming = { type: "feat", slug: "golden-path" } as const;

function coreProjectionInput(
  branches: readonly ChangeBranchEvidence[],
  pullRequests: readonly ChangePullRequestEvidence[],
): ChangeProjectionInput {
  return {
    change: coreIdentity,
    branchGovernance,
    naming,
    baseBranch: "main",
    evidence: {
      issue: { status: "available", value: { number: 395, state: "open" } },
      branches: { status: "available", value: branches },
      pullRequests: { status: "available", value: pullRequests },
    },
  };
}

function projection(
  status: ChangeProjectionResult["status"],
  options: { branchSha?: string; pullRequestState?: "open" | "closed"; merged?: boolean } = {},
): ChangeProjectionResult {
  const pullRequest =
    options.pullRequestState === undefined
      ? []
      : [
          {
            candidate: {
              number: 902,
              head: branch,
              base: "main",
              state: options.pullRequestState,
              draft: true,
              ...(options.merged === undefined ? {} : { merged: options.merged }),
            },
            classification: "canonical" as const,
            reason: "canonical",
          },
        ];
  return {
    valid: status === "healthy" || status === "absent",
    status,
    canonicalBranch: branch,
    canonicalBaseBranch: "main",
    candidates: {
      branches:
        options.branchSha === undefined
          ? []
          : [{ candidate: { name: branch, sha: options.branchSha }, classification: "canonical", reason: "canonical" }],
      pullRequests: pullRequest,
    },
    change: {
      version: 1,
      identity: { repositoryHost: "github.com", repositoryId: "100", rootIssue: 395 },
      state: status === "healthy" ? "DRAFT" : "RECOVERY_REQUIRED",
      provenance: {},
      ...(options.branchSha === undefined ? {} : { projection: { branch } }),
    },
    diagnostics: [],
  };
}

function evidence(
  operation: ChangeRemoteExecutionEvidence["operation"],
  outcome: ChangeRemoteExecutionEvidence["outcome"],
  options: Partial<Pick<ChangeRemoteExecutionEvidence, "compensation" | "effects" | "failure">> = {},
): ChangeRemoteExecutionEvidence {
  return { version: 1, operation, outcome, effects: [], ...options };
}

function input(
  projectionValue: ChangeProjectionResult,
  evidenceValue: ChangeRemoteExecutionEvidence,
  options: Pick<GoldenPathRecoveryInput, "authoritativeReread"> = {},
): GoldenPathRecoveryInput {
  return { projection: projectionValue, evidence: evidenceValue, ...options };
}

test("execution evidence alone cannot authorize issuance cleanup", () => {
  const result = projectGoldenPathRecovery(
    input(
      projection("partial", { branchSha }),
      evidence("issue", "recovery-required", {
        effects: [{ kind: "CREATE_BRANCH", status: "succeeded", createdCommitSha: branchSha }],
        failure: { kind: "CREATE_PULL_REQUEST", code: "CREATE_PR_FAILED", message: "bounded" },
      }),
    ),
  );
  assert.deepEqual(result, {
    class: "ISSUANCE_COMPENSATION_UNSAFE",
    safeAction: "MANUAL_REVIEW",
    owner: "recovery",
    retryable: false,
    rereadRequired: true,
    automaticCleanup: "forbidden",
    reasonCode: "MANUAL_RECOVERY_REVIEW_REQUIRED",
  });
});

test("unsafe or ambiguous issuance cleanup is manual and forbidden", () => {
  const result = projectGoldenPathRecovery(
    input(
      projection("partial", { branchSha: "fedcba9876543210fedcba9876543210fedcba98" }),
      evidence("issue", "recovery-required", {
        effects: [{ kind: "CREATE_BRANCH", status: "succeeded", createdCommitSha: branchSha }],
        compensation: "failed",
        failure: { kind: "DELETE_BRANCH", code: "DELETE_FAILED", message: "bounded" },
      }),
    ),
  );
  assert.equal(result?.class, "ISSUANCE_COMPENSATION_UNSAFE");
  assert.equal(result?.safeAction, "MANUAL_REVIEW");
  assert.equal(result?.automaticCleanup, "forbidden");
});

test("an unsafe recovery result is not hidden by a successful compensation attempt", () => {
  const result = projectGoldenPathRecovery(
    input(
      projection("partial", { branchSha }),
      evidence("issue", "recovery-required", {
        compensation: "succeeded",
        failure: { kind: "CREATE_PULL_REQUEST", code: "VERIFY_FAILED", message: "bounded" },
      }),
    ),
  );
  assert.equal(result?.class, "ISSUANCE_COMPENSATION_UNSAFE");
  assert.equal(result?.safeAction, "MANUAL_REVIEW");
  assert.equal(result?.automaticCleanup, "forbidden");
});

test("a canonical pull request that is already visible prevents branch cleanup inference", () => {
  const result = projectGoldenPathRecovery(
    input(
      projection("partial", { branchSha, pullRequestState: "open" }),
      evidence("issue", "recovery-required", {
        effects: [{ kind: "CREATE_BRANCH", status: "succeeded", createdCommitSha: branchSha }],
        failure: { kind: "CREATE_PULL_REQUEST", code: "VERIFY_FAILED", message: "bounded" },
      }),
    ),
  );
  assert.equal(result?.class, "ISSUANCE_COMPENSATION_UNSAFE");
  assert.equal(result?.automaticCleanup, "forbidden");
});

test("execution evidence alone cannot authorize abort cleanup", () => {
  const result = projectGoldenPathRecovery(
    input(
      projection("partial", { branchSha, pullRequestState: "closed", merged: false }),
      evidence("abort", "recovery-required", {
        failure: { kind: "CLOSE_PULL_REQUEST", code: "CLOSE_FAILED", message: "bounded" },
      }),
    ),
  );
  assert.deepEqual(result, {
    class: "ABORT_CLEANUP_UNSAFE",
    safeAction: "MANUAL_REVIEW",
    owner: "recovery",
    retryable: false,
    rereadRequired: true,
    automaticCleanup: "forbidden",
    reasonCode: "MANUAL_RECOVERY_REVIEW_REQUIRED",
  });
});

test("unavailable abort evidence waits and never authorizes cleanup", () => {
  const result = projectGoldenPathRecovery(
    input(
      projection("unavailable"),
      evidence("abort", "recovery-required", {
        failure: { kind: "DELETE_BRANCH", code: "READ_FAILED", message: "bounded" },
      }),
    ),
  );
  assert.equal(result?.class, "ABORT_CLEANUP_UNSAFE");
  assert.equal(result?.safeAction, "WAIT");
  assert.equal(result?.automaticCleanup, "forbidden");
});

test("a merged canonical pull request remains unsafe without a Core plan", () => {
  const result = projectGoldenPathRecovery(
    input(
      projection("partial", { branchSha, pullRequestState: "closed", merged: true }),
      evidence("abort", "recovery-required", {
        failure: { kind: "DELETE_BRANCH", code: "DELETE_FAILED", message: "bounded" },
      }),
    ),
  );
  assert.equal(result?.class, "ABORT_CLEANUP_UNSAFE");
  assert.equal(result?.safeAction, "MANUAL_REVIEW");
  assert.equal(result?.automaticCleanup, "forbidden");
});

test("post-effect verification never trusts caller-supplied retry proof", () => {
  const evidenceValue = evidence("ready", "recovery-required", {
    failure: { kind: "MARK_PULL_REQUEST_READY", code: "VERIFY_FAILED", message: "bounded" },
  });
  const withoutProof = projectGoldenPathRecovery(input(projection("healthy", { branchSha }), evidenceValue));
  assert.equal(withoutProof?.safeAction, "MANUAL_REVIEW");
  assert.equal(withoutProof?.retryable, false);

  const withRereadOnly = projectGoldenPathRecovery(
    input(projection("healthy", { branchSha }), evidenceValue, {
      authoritativeReread: { status: "complete", projection: projection("healthy", { branchSha }) },
    }),
  );
  assert.equal(withRereadOnly?.safeAction, "MANUAL_REVIEW");
  assert.equal(withRereadOnly?.retryable, false);
});

test("generic failure and verified compensation do not become recovery classifications", () => {
  assert.equal(
    projectGoldenPathRecovery(input(projection("healthy", { branchSha }), evidence("ready", "failed"))),
    null,
  );
  assert.equal(
    projectGoldenPathRecovery(
      input(projection("absent"), evidence("issue", "compensated", { compensation: "succeeded" })),
    ),
    null,
  );
});

test("a recovery-state projection without executor evidence remains fail-closed", () => {
  const result = projectGoldenPathRecovery({
    operation: "issue",
    projection: projection("partial", { branchSha }),
  });
  assert.equal(result?.class, "ISSUANCE_COMPENSATION_UNSAFE");
  assert.equal(result?.safeAction, "MANUAL_REVIEW");
  assert.equal(result?.automaticCleanup, "forbidden");
});

test("a validated issuance recovery plan supplies cleanup authority without reclassification", () => {
  const issuance = planChangeIssuance(coreProjectionInput([], []));
  const plan = planChangeIssuanceRecovery({
    issuance,
    attemptedEffects: [
      {
        effect: issuance.effects[0]!,
        status: "succeeded",
        evidence: {
          kind: "CREATE_BRANCH",
          branch,
          baseBranch: "main",
          createdCommitSha: branchSha,
        },
      },
      { effect: issuance.effects[1]!, status: "failed" },
    ],
    failure: { effect: issuance.effects[1]!, code: "CREATE_FAILED", message: "bounded" },
    projection: coreProjectionInput([{ name: branch, sha: branchSha }], []),
  });
  const result = projectGoldenPathRecovery({ recoveryPlan: plan });
  assert.deepEqual(result, {
    class: "ISSUANCE_PARTIAL_PROJECTION",
    safeAction: "RECOVER",
    owner: "recovery",
    retryable: false,
    rereadRequired: true,
    automaticCleanup: "conditional",
    reasonCode: "RECOVERY_ACTION_REQUIRED",
  });
});

test("a Core-verified successful issuance compensation is not recovery evidence", () => {
  const issuance = planChangeIssuance(coreProjectionInput([], []));
  const plan = planChangeIssuanceRecovery({
    issuance,
    attemptedEffects: [
      {
        effect: issuance.effects[0]!,
        status: "succeeded",
        evidence: {
          kind: "CREATE_BRANCH",
          branch,
          baseBranch: "main",
          createdCommitSha: branchSha,
        },
      },
      { effect: issuance.effects[1]!, status: "failed" },
    ],
    failure: { effect: issuance.effects[1]!, code: "CREATE_FAILED", message: "bounded" },
    projection: coreProjectionInput([{ name: branch, sha: branchSha }], []),
    compensation: { status: "succeeded", projection: coreProjectionInput([], []) },
  });
  assert.equal(projectGoldenPathRecovery({ recoveryPlan: plan }), null);
});

test("a validated abort recovery plan exposes only its remaining Core-admitted cleanup", () => {
  const change = {
    version: 1 as const,
    identity: coreIdentity,
    state: "DRAFT" as const,
    provenance: {},
    projection: { branch, pullRequest: 902 },
  };
  const transition = planChangeTransition({
    version: 1,
    transition: "abort",
    change,
    target: { branch, pullRequest: 902 },
  });
  const plan = planChangeTransitionRecovery({
    transition,
    attemptedEffects: [{ effect: transition.effects[0]!, status: "failed" }],
    failure: { effect: transition.effects[0]!, code: "CLOSE_FAILED", message: "bounded" },
    projection: coreProjectionInput(
      [{ name: branch, sha: branchSha }],
      [{ number: 902, head: branch, base: "main", state: "open", draft: true }],
    ),
  });
  const result = projectGoldenPathRecovery({ recoveryPlan: plan });
  assert.deepEqual(result, {
    class: "ABORT_CLEANUP_PENDING",
    safeAction: "ABORT",
    owner: "recovery",
    retryable: false,
    rereadRequired: true,
    automaticCleanup: "conditional",
    reasonCode: "ABORT_CLEANUP_REQUIRED",
  });
});

test("an invalid forged recovery plan cannot authorize a mutation action", () => {
  const forged = {
    version: 1,
    operation: "recover-transition",
    effects: [{ kind: "DELETE_BRANCH", branch }],
  } as never;
  const result = projectGoldenPathRecovery({ recoveryPlan: forged });
  assert.deepEqual(result, {
    class: "ABORT_CLEANUP_UNSAFE",
    safeAction: "MANUAL_REVIEW",
    owner: "recovery",
    retryable: false,
    rereadRequired: true,
    automaticCleanup: "forbidden",
    reasonCode: "MANUAL_RECOVERY_REVIEW_REQUIRED",
  });
});

test("validation rejects caller-forged owners and recovery combinations", () => {
  const valid = {
    class: "POST_EFFECT_VERIFICATION",
    safeAction: "MANUAL_REVIEW",
    owner: "recovery",
    retryable: false,
    rereadRequired: true,
    automaticCleanup: "forbidden",
    reasonCode: "MANUAL_RECOVERY_REVIEW_REQUIRED",
  } as const;
  assert.equal(validateGoldenPathRecovery(valid).valid, true);
  const retryable = {
    ...valid,
    safeAction: "RETRY",
    retryable: true,
    automaticCleanup: "none",
    reasonCode: "IDEMPOTENT_RETRY",
  } as const;
  assert.equal(validateGoldenPathRecovery({ ...retryable, retryOf: "READY_CHANGE" }).valid, true);
  assert.equal(validateGoldenPathRecovery({ ...valid, retryOf: "READY_CHANGE" }).valid, false);
  assert.equal(validateGoldenPathRecovery({ ...valid, retryOf: "RECOVER" }).valid, false);
  assert.equal(validateGoldenPathRecovery({ ...valid, owner: "caller" }).valid, false);
  assert.equal(validateGoldenPathRecovery({ ...valid, safeAction: "RETRY", retryable: false }).valid, false);
  assert.equal(
    validateGoldenPathRecovery({ ...valid, safeAction: "RECOVER", automaticCleanup: "forbidden" }).valid,
    false,
  );
  assert.equal(validateGoldenPathRecovery({ ...valid, extra: true }).valid, false);
});

test("recovery vocabulary and serialization remain bounded and deterministic", () => {
  assert.deepEqual(GOLDEN_PATH_RECOVERY_CLASSES, [
    "ISSUANCE_PARTIAL_PROJECTION",
    "ISSUANCE_COMPENSATION_UNSAFE",
    "ABORT_CLEANUP_PENDING",
    "ABORT_CLEANUP_UNSAFE",
    "POST_EFFECT_VERIFICATION",
  ]);
  assert.deepEqual(GOLDEN_PATH_RECOVERY_ACTIONS, ["RETRY", "ABORT", "RECOVER", "MANUAL_REVIEW", "WAIT"]);
  const recovery = projectGoldenPathRecovery(
    input(projection("healthy", { branchSha }), evidence("ready", "recovery-required")),
  );
  assert.ok(recovery);
  const serialized = serializeGoldenPathRecovery(recovery);
  assert.deepEqual(deserializeGoldenPathRecovery(serialized), recovery);
  assert.equal(isGoldenPathRecovery(recovery), true);
  assert.equal(validateGoldenPathRecovery({ ...recovery, rereadRequired: false }).valid, false);
});
