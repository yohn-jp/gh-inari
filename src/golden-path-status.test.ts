import assert from "node:assert/strict";
import test from "node:test";
import {
  GOLDEN_PATH_NORMAL_ACTION_KINDS,
  projectGoldenPathStatus,
  tryProjectGoldenPathStatus,
  validateGoldenPathStatus,
} from "./golden-path-status.js";

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environment: true,
    governance: true,
    issue: { status: "present", governed: true, number: 42 },
    ...overrides,
  };
}

test("projects each normal Golden Path phase to at most one bounded action", () => {
  const cases: Array<{
    name: string;
    input: Record<string, unknown>;
    phase: string;
    availability: string;
    action: string | null;
    reason: string | null;
  }> = [
    {
      name: "environment",
      input: {},
      phase: "ENVIRONMENT",
      availability: "actionable",
      action: "PREFLIGHT",
      reason: "PACKAGE_CAPABILITY_REQUIRED",
    },
    {
      name: "governance",
      input: { environment: true },
      phase: "GOVERNANCE",
      availability: "actionable",
      action: "DISCOVER_GOVERNANCE",
      reason: "GOVERNANCE_DISCOVERY_REQUIRED",
    },
    {
      name: "issue",
      input: { environment: true, governance: true, issue: "absent" },
      phase: "ISSUE",
      availability: "actionable",
      action: "CREATE_ISSUE",
      reason: "GOVERNED_ISSUE_REQUIRED",
    },
    {
      name: "defined change",
      input: input({ change: { state: "DEFINED", projectionStatus: "absent" } }),
      phase: "ISSUE",
      availability: "actionable",
      action: "ISSUE_CHANGE",
      reason: "CHANGE_ISSUANCE_REQUIRED",
    },
    {
      name: "implementation",
      input: input({ change: { state: "DRAFT", projectionStatus: "healthy" } }),
      phase: "IMPLEMENTATION",
      availability: "actionable",
      action: "IMPLEMENT",
      reason: "CHANGE_ISSUED",
    },
    {
      name: "ready",
      input: input({ change: { state: "DRAFT", projectionStatus: "healthy" }, implementation: { ready: true } }),
      phase: "READY",
      availability: "actionable",
      action: "READY_CHANGE",
      reason: "READY_PRECONDITIONS_REQUIRED",
    },
    {
      name: "review",
      input: input({ change: { state: "REVIEW", projectionStatus: "healthy" } }),
      phase: "REVIEW",
      availability: "actionable",
      action: "WAIT",
      reason: "WAIT_FOR_REPOSITORY_REVIEW",
    },
    {
      name: "terminal",
      input: input({ change: { state: "MERGED", projectionStatus: "healthy" } }),
      phase: "TERMINAL",
      availability: "terminal",
      action: null,
      reason: null,
    },
  ];

  for (const candidate of cases) {
    const result = projectGoldenPathStatus(candidate.input);
    assert.equal(result.status.phase, candidate.phase, candidate.name);
    assert.equal(result.status.availability, candidate.availability, candidate.name);
    assert.equal(result.nextAction?.kind ?? null, candidate.action, candidate.name);
    assert.equal(result.nextAction?.reasonCode ?? null, candidate.reason, candidate.name);
    assert.equal(result.recovery, null, candidate.name);
    assert.ok(result.nextAction === null || GOLDEN_PATH_NORMAL_ACTION_KINDS.includes(result.nextAction.kind as never));
  }
});

test("suppresses normal mutation for unavailable and ambiguous Change evidence", () => {
  for (const projectionStatus of ["partial", "duplicate", "wrong-base", "ambiguous", "unavailable"] as const) {
    const result = projectGoldenPathStatus(input({ change: { state: "DRAFT", projectionStatus } }));
    assert.equal(result.status.availability, "blocked");
    assert.equal(result.nextAction, null);
    assert.equal(result.status.projectionStatus, projectionStatus);
  }
});

test("projects supplied recovery evidence without selecting recovery policy", () => {
  const result = projectGoldenPathStatus(
    input({
      change: { state: "RECOVERY_REQUIRED", projectionStatus: "partial" },
      recovery: {
        class: "POST_EFFECT_VERIFICATION",
        safeAction: "MANUAL_REVIEW",
        retryable: false,
        rereadRequired: true,
        automaticCleanup: "forbidden",
      },
    }),
  );
  assert.equal(result.status.phase, "RECOVERY");
  assert.equal(result.status.availability, "recovery-required");
  assert.equal(result.nextAction?.kind, "MANUAL_REVIEW");
  assert.equal(result.nextAction?.owner, "recovery");
  assert.equal(result.nextAction?.reasonCode, "MANUAL_RECOVERY_REVIEW_REQUIRED");
  assert.equal(result.recovery?.rereadRequired, true);
});

test("projects recovery WAIT as a recovery-owned action with the reread reason", () => {
  const result = projectGoldenPathStatus(
    input({
      change: { state: "RECOVERY_REQUIRED", projectionStatus: "partial" },
      recovery: {
        class: "POST_EFFECT_VERIFICATION",
        safeAction: "WAIT",
        retryable: false,
        rereadRequired: true,
        automaticCleanup: "none",
      },
    }),
  );
  assert.deepEqual(result.nextAction, {
    kind: "WAIT",
    owner: "recovery",
    reasonCode: "AUTHORITATIVE_REREAD_REQUIRED",
  });
  assert.equal(validateGoldenPathStatus(result).valid, true);
});

test("fails closed for inconsistent recovery action metadata", () => {
  const base = input({ change: { state: "RECOVERY_REQUIRED", projectionStatus: "partial" } });
  assert.equal(
    tryProjectGoldenPathStatus({
      ...base,
      recovery: {
        class: "POST_EFFECT_VERIFICATION",
        safeAction: "RETRY",
        owner: "worker",
        retryable: false,
        rereadRequired: true,
        automaticCleanup: "forbidden",
      },
    }).valid,
    false,
  );
  const validRecovery = projectGoldenPathStatus({
    ...base,
    recovery: {
      class: "POST_EFFECT_VERIFICATION",
      safeAction: "WAIT",
      retryable: false,
      rereadRequired: true,
      automaticCleanup: "none",
    },
  });
  assert.equal(
    validateGoldenPathStatus({
      ...validRecovery,
      nextAction: { ...validRecovery.nextAction!, owner: "repository" },
    }).valid,
    false,
  );
});

test("leaves recovery safety classification to the recovery projector", () => {
  const result = projectGoldenPathStatus(
    input({
      change: { state: "RECOVERY_REQUIRED", projectionStatus: "partial" },
      recovery: {
        class: "POST_EFFECT_VERIFICATION",
        safeAction: "RETRY",
        retryable: false,
        rereadRequired: true,
        automaticCleanup: "forbidden",
      },
    }),
  );
  assert.equal(result.status.availability, "recovery-required");
  assert.equal(result.nextAction?.kind, "RETRY");
  assert.equal(result.recovery?.retryable, false);
  assert.equal(validateGoldenPathStatus(result).valid, true);
});

test("rejects contradictory or malformed evidence instead of guessing", () => {
  const contradictory = tryProjectGoldenPathStatus(
    input({
      subject: { repositoryHost: "github.com", repositoryId: "1", rootIssue: 99 },
      change: {
        state: "DRAFT",
        projectionStatus: "healthy",
        subject: { repositoryHost: "github.com", repositoryId: "1", rootIssue: 42 },
      },
    }),
  );
  assert.equal(contradictory.valid, false);
  assert.ok(contradictory.diagnostics.length > 0);
  assert.equal(tryProjectGoldenPathStatus({ environment: true, unsupported: true }).valid, false);
});

test("accepts a complete Change Core snapshot without reinterpreting its nested authority", () => {
  const result = projectGoldenPathStatus(
    input({
      change: {
        version: 1,
        identity: { repositoryHost: "github.com", repositoryId: "1", rootIssue: 42 },
        state: "DRAFT",
        provenance: { issuer: "app:inari-issuer" },
        projection: { branch: "feat/42-example", pullRequest: 7 },
      },
    }),
  );
  assert.equal(result.status.changeState, "DRAFT");
  assert.equal(result.status.projectionStatus, "healthy");
  assert.equal(result.nextAction?.kind, "IMPLEMENT");
  assert.deepEqual(result.subject, { repositoryHost: "github.com", repositoryId: "1", rootIssue: 42 });
});

test("rejects unknown evidence status and projection status instead of falling back", () => {
  assert.equal(tryProjectGoldenPathStatus({ environment: { status: "ready" } }).valid, false);
  assert.equal(
    tryProjectGoldenPathStatus(input({ change: { state: "DRAFT", projectionStatus: "not-a-status" } })).valid,
    false,
  );
});

test("validates the zero-or-one action invariant at the public boundary", () => {
  const valid = projectGoldenPathStatus(input({ change: { state: "DRAFT", projectionStatus: "healthy" } }));
  assert.equal(validateGoldenPathStatus(valid).valid, true);
  assert.equal(
    validateGoldenPathStatus({ ...valid, status: { ...valid.status, availability: "blocked" } }).valid,
    false,
  );
  assert.equal(
    validateGoldenPathStatus({
      ...valid,
      nextAction: { ...valid.nextAction!, owner: "caller" },
    }).valid,
    false,
  );
  for (const state of ["DRAFT", "REVIEW", "ACCEPTED", "MERGED", "ABORTED", "RECOVERY_REQUIRED"] as const) {
    assert.equal(
      tryProjectGoldenPathStatus(input({ issue: "absent", change: { state, projectionStatus: "healthy" } })).valid,
      false,
      state,
    );
  }
});
