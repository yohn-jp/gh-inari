import assert from "node:assert/strict";
import { test } from "node:test";
import { projectGoldenPathRecovery } from "../golden-path-recovery.js";
import {
  projectGoldenPathStatus,
  tryProjectGoldenPathStatus,
  type GoldenPathStatusInput,
} from "../golden-path-status.js";
import { projectChangeFromGitHubEvidence } from "../change.js";
import { ChangeTrustedExecutorError } from "../change-trusted-executor.js";
import { runCli } from "../cli.js";
import {
  CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
  normalizeChangeRemoteExecutionResult,
  type ChangeRemoteExecutionResult,
} from "../change-executor.js";
import {
  GOLDEN_PATH_BRANCH,
  GOLDEN_PATH_CREATED_COMMIT_SHA,
  GOLDEN_PATH_PULL_REQUEST,
  abortedEvidenceInput,
  absentEvidenceInput,
  createGoldenPathActors,
  draftEvidenceInput,
  mutationRequest,
  reviewEvidenceInput,
} from "./fixtures.js";

const GOLDEN_PATH_SCOPE = {
  environment: { status: "available" as const, verified: true },
  governance: {
    status: "available" as const,
    valid: true,
    repositoryHost: "github.com",
    repositoryId: "411000001",
  },
  issue: { status: "present" as const, governed: true, number: 411, state: "open" as const },
  subject: { repositoryHost: "github.com", repositoryId: "411000001", rootIssue: 411 },
};

function goldenPathInput(
  result: ChangeRemoteExecutionResult,
  extras: Omit<GoldenPathStatusInput, keyof typeof GOLDEN_PATH_SCOPE | "changeProjection" | "execution"> = {},
): GoldenPathStatusInput {
  return {
    ...GOLDEN_PATH_SCOPE,
    changeProjection: result.projection,
    ...(result.evidence === undefined ? {} : { execution: { outcome: result.evidence.outcome } }),
    ...extras,
  };
}

function goldenPathStatus(
  result: ChangeRemoteExecutionResult,
  extras: Omit<GoldenPathStatusInput, keyof typeof GOLDEN_PATH_SCOPE | "changeProjection" | "execution"> = {},
) {
  const recovery = projectGoldenPathRecovery(result);
  return projectGoldenPathStatus(
    goldenPathInput(result, {
      ...extras,
      ...(recovery === null ? {} : { recovery }),
    }),
  );
}

async function captureCliJson(
  argv: readonly string[],
  dependencies: Parameters<typeof runCli>[1],
): Promise<{ readonly exitCode: number; readonly output: Record<string, unknown> }> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli([...argv], dependencies);
    const line = lines.at(-1);
    assert.ok(line, "CLI must emit one JSON result");
    return { exitCode, output: JSON.parse(line) as Record<string, unknown> };
  } finally {
    console.log = originalLog;
  }
}

function assertBoundedPublicResult(operation: "issue" | "ready" | "abort", result: ChangeRemoteExecutionResult): void {
  const normalized = normalizeChangeRemoteExecutionResult(operation, result);
  assert.deepEqual(Object.keys(normalized).sort(), ["evidence", "projection"]);
  assert.equal(normalized.evidence?.version, CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION);
  assert.equal(normalized.evidence?.operation, operation);
  assert.equal("snapshot" in normalized, false);
  assert.doesNotMatch(JSON.stringify(normalized), /"(?:snapshot|stateNode|machineId)"\s*:/iu);
}

test("production issuance, Ready, and Abort machines consume one deterministic evidence fixture", async () => {
  const actors = createGoldenPathActors(absentEvidenceInput());

  const issued = await actors.executor.execute(mutationRequest("issue", "agent:golden-path"));
  assert.deepEqual(
    actors.issuer.effects.map((effect) => effect.kind),
    ["CREATE_BRANCH", "CREATE_PULL_REQUEST"],
  );
  assert.equal(issued.evidence?.outcome, "verified");
  assert.equal(issued.projection.status, "healthy");
  assert.equal(issued.projection.change?.state, "DRAFT");
  assert.equal(issued.projection.change?.projection?.branch, GOLDEN_PATH_BRANCH);
  assert.equal(issued.projection.change?.projection?.pullRequest, GOLDEN_PATH_PULL_REQUEST);
  assert.equal(issued.projection.change?.provenance.requester, "agent:golden-path");
  assertBoundedPublicResult("issue", issued);
  const issuedStatus = goldenPathStatus(issued, { implementation: { status: "in-progress" } });
  assert.deepEqual(issuedStatus.status, {
    phase: "IMPLEMENTATION",
    availability: "actionable",
    changeState: "DRAFT",
    projectionStatus: "healthy",
    executionOutcome: "verified",
  });
  assert.deepEqual(issuedStatus.nextAction, {
    kind: "IMPLEMENT",
    owner: "worker",
    reasonCode: "CHANGE_ISSUED",
  });
  assert.equal(issuedStatus.recovery, null);

  const ready = await actors.executor.execute(mutationRequest("ready", "agent:golden-path"));
  assert.deepEqual(
    actors.issuer.effects.map((effect) => effect.kind),
    ["CREATE_BRANCH", "CREATE_PULL_REQUEST", "MARK_PULL_REQUEST_READY"],
  );
  assert.equal(ready.evidence?.outcome, "verified");
  assert.equal(ready.projection.status, "healthy");
  assert.equal(ready.projection.change?.state, "REVIEW");
  assertBoundedPublicResult("ready", ready);
  const readyStatus = goldenPathStatus(ready, { review: { status: "required", action: "review" } });
  assert.deepEqual(readyStatus.status, {
    phase: "REVIEW",
    availability: "actionable",
    changeState: "REVIEW",
    projectionStatus: "healthy",
    executionOutcome: "verified",
  });
  assert.deepEqual(readyStatus.nextAction, { kind: "REVIEW", owner: "repository", reasonCode: "REVIEW_ADMITTED" });
  assert.equal(readyStatus.recovery, null);

  const aborted = await actors.executor.execute(mutationRequest("abort", "agent:golden-path"));
  assert.deepEqual(
    actors.issuer.effects.map((effect) => effect.kind),
    ["CREATE_BRANCH", "CREATE_PULL_REQUEST", "MARK_PULL_REQUEST_READY", "CLOSE_PULL_REQUEST", "DELETE_BRANCH"],
  );
  assert.equal(aborted.evidence?.outcome, "verified");
  assert.equal(aborted.projection.status, "healthy");
  assert.equal(aborted.projection.change?.state, "ABORTED");
  assert.equal(aborted.projection.change?.projection?.branch, GOLDEN_PATH_BRANCH);
  assert.equal(aborted.projection.change?.projection?.pullRequest, GOLDEN_PATH_PULL_REQUEST);
  assert.equal(actors.reader.current.evidence.branches?.status, "available");
  assert.deepEqual(actors.reader.current.evidence.branches?.value, []);
  const abortedStatus = goldenPathStatus(aborted);
  assert.deepEqual(abortedStatus.status, {
    phase: "TERMINAL",
    availability: "terminal",
    changeState: "ABORTED",
    projectionStatus: "healthy",
    executionOutcome: "verified",
  });
  assert.equal(abortedStatus.nextAction, null);
  assert.equal(abortedStatus.recovery, null);
});

test("production issuance records branch generation evidence before the pull-request effect", async () => {
  const actors = createGoldenPathActors(absentEvidenceInput());
  const result = await actors.executor.execute(mutationRequest("issue"));

  assert.equal(result.evidence?.effects[0]?.kind, "CREATE_BRANCH");
  assert.equal(result.evidence?.effects[0]?.status, "succeeded");
  assert.equal(result.evidence?.effects[0]?.createdCommitSha, GOLDEN_PATH_CREATED_COMMIT_SHA);
  assert.equal(result.evidence?.effects[1]?.kind, "CREATE_PULL_REQUEST");
  assert.equal(result.evidence?.effects[1]?.status, "succeeded");
  assert.equal(actors.issuer.requests[0]?.execution.workflowTrust, "protected");
  assert.equal(actors.issuer.requests[0]?.target.repositoryId, "411000001");
});

test("healthy existing and already-aborted projections use production idempotent paths without effects", async () => {
  const existing = createGoldenPathActors(draftEvidenceInput());
  const issueRetry = await existing.executor.execute(mutationRequest("issue"));
  assert.equal(issueRetry.evidence?.outcome, "returned-existing");
  assert.deepEqual(existing.issuer.effects, []);
  assert.equal(issueRetry.projection.change?.state, "DRAFT");
  assert.deepEqual(goldenPathStatus(issueRetry).nextAction, {
    kind: "IMPLEMENT",
    owner: "worker",
    reasonCode: "CHANGE_ISSUED",
  });

  const aborted = createGoldenPathActors(abortedEvidenceInput());
  const abortRetry = await aborted.executor.execute(mutationRequest("abort"));
  assert.equal(abortRetry.evidence?.outcome, "returned-existing");
  assert.deepEqual(aborted.issuer.effects, []);
  assert.equal(abortRetry.projection.change?.state, "ABORTED");
  assert.equal(goldenPathStatus(abortRetry).nextAction, null);

  const readyRetry = createGoldenPathActors(reviewEvidenceInput());
  const readyExisting = await readyRetry.executor.execute(mutationRequest("ready"));
  assert.equal(readyExisting.evidence?.outcome, "returned-existing");
  const readyStatus = goldenPathStatus(readyExisting, { review: { status: "waiting", action: "wait" } });
  assert.equal(readyStatus.status.phase, "REVIEW");
  assert.deepEqual(readyStatus.nextAction, {
    kind: "WAIT",
    owner: "repository",
    reasonCode: "WAIT_FOR_REPOSITORY_REVIEW",
  });
});

test("verified compensation and unsafe issuance recovery remain distinct in both projections", async () => {
  const compensated = createGoldenPathActors(absentEvidenceInput(), { failEffect: "CREATE_PULL_REQUEST" });
  const compensatedResult = await compensated.executor.execute(mutationRequest("issue"));
  assert.equal(compensatedResult.evidence?.outcome, "compensated");
  assert.equal(compensatedResult.projection.change?.state, "DEFINED");
  assert.equal(projectGoldenPathRecovery(compensatedResult), null);
  const compensatedStatus = goldenPathStatus(compensatedResult);
  assert.equal(compensatedStatus.status.availability, "blocked");
  assert.equal(compensatedStatus.nextAction, null);

  const unsafe = createGoldenPathActors(absentEvidenceInput(), {
    failEffect: "CREATE_PULL_REQUEST",
    applyFailedEffect: true,
  });
  const unsafeResult = await unsafe.executor.execute(mutationRequest("issue"));
  const recovery = projectGoldenPathRecovery(unsafeResult);
  assert.deepEqual(recovery, {
    class: "ISSUANCE_COMPENSATION_UNSAFE",
    safeAction: "MANUAL_REVIEW",
    owner: "recovery",
    retryable: false,
    rereadRequired: true,
    automaticCleanup: "forbidden",
    reasonCode: "MANUAL_RECOVERY_REVIEW_REQUIRED",
  });
  const unsafeStatus = goldenPathStatus(unsafeResult);
  assert.deepEqual(unsafeStatus.status, {
    phase: "RECOVERY",
    availability: "recovery-required",
    changeState: "RECOVERY_REQUIRED",
    projectionStatus: "partial",
    executionOutcome: "recovery-required",
  });
  assert.deepEqual(unsafeStatus.nextAction, {
    kind: "MANUAL_REVIEW",
    owner: "recovery",
    reasonCode: "MANUAL_RECOVERY_REVIEW_REQUIRED",
  });
  assert.deepEqual(unsafeStatus.recovery, recovery);
});

test("effect failure never projects an optimistic Ready state", async () => {
  const actors = createGoldenPathActors(draftEvidenceInput(), { failEffect: "MARK_PULL_REQUEST_READY" });

  const result = await actors.executor.execute(mutationRequest("ready"));
  assert.equal(result.evidence?.outcome, "failed");
  assert.equal(result.evidence?.failure?.kind, "MARK_PULL_REQUEST_READY");
  assert.deepEqual(
    actors.issuer.effects.map((effect) => effect.kind),
    ["MARK_PULL_REQUEST_READY"],
  );
  assert.equal(result.projection.change?.state, "DRAFT");
  assert.equal(actors.reader.current.evidence.pullRequests?.status, "available");
  assert.equal(actors.reader.current.evidence.pullRequests?.value[0]?.draft, true);
});

test("cleanup failure enters the production recovery projection with bounded evidence", async () => {
  const actors = createGoldenPathActors(reviewEvidenceInput(), { failEffect: "DELETE_BRANCH" });
  const result = await actors.executor.execute(mutationRequest("abort"));

  assert.deepEqual(
    actors.issuer.effects.map((effect) => effect.kind),
    ["CLOSE_PULL_REQUEST", "DELETE_BRANCH"],
  );
  assert.equal(result.evidence?.outcome, "recovery-required");
  assert.equal(result.evidence?.compensation, "failed");
  assert.equal(result.evidence?.failure?.kind, "DELETE_BRANCH");
  assert.equal(result.projection.status, "partial");
  assert.equal(result.projection.change?.state, "RECOVERY_REQUIRED");
  assert.equal(result.projection.change?.projection?.branch, GOLDEN_PATH_BRANCH);
  assert.equal(result.projection.change?.projection?.pullRequest, GOLDEN_PATH_PULL_REQUEST);
  const recovery = projectGoldenPathRecovery(result);
  assert.deepEqual(recovery, {
    class: "ABORT_CLEANUP_UNSAFE",
    safeAction: "MANUAL_REVIEW",
    owner: "recovery",
    retryable: false,
    rereadRequired: true,
    automaticCleanup: "forbidden",
    reasonCode: "MANUAL_RECOVERY_REVIEW_REQUIRED",
  });
  const status = goldenPathStatus(result);
  assert.equal(status.status.availability, "recovery-required");
  assert.equal(status.status.phase, "RECOVERY");
  assert.deepEqual(status.nextAction, {
    kind: "MANUAL_REVIEW",
    owner: "recovery",
    reasonCode: "MANUAL_RECOVERY_REVIEW_REQUIRED",
  });
  assert.deepEqual(status.recovery, recovery);
});

test("production Ready verification failure leaves the authoritative projection in DRAFT", async () => {
  const actors = createGoldenPathActors(draftEvidenceInput(), { applySuccessfulEffect: false });

  await assert.rejects(actors.executor.execute(mutationRequest("ready")), (error: unknown) => {
    assert.ok(error instanceof ChangeTrustedExecutorError);
    assert.equal(error.code, "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED");
    assert.doesNotMatch(JSON.stringify(error), /snapshot|stateNode|machineId/iu);
    return true;
  });
  assert.deepEqual(
    actors.issuer.effects.map((effect) => effect.kind),
    ["MARK_PULL_REQUEST_READY"],
  );

  // Feed the fresh authoritative read into the Golden Path projector. The
  // failed machine run must not manufacture a REVIEW state or recovery action.
  const reread = projectChangeFromGitHubEvidence(actors.reader.current);
  assert.equal(reread.change?.state, "DRAFT");
  const status = projectGoldenPathStatus(
    goldenPathInput({ projection: reread }, { ready: { status: "eligible" }, implementation: { status: "ready" } }),
  );
  assert.equal(status.status.changeState, "DRAFT");
  assert.equal(status.status.phase, "READY");
  assert.equal(status.nextAction?.kind, "READY_CHANGE");
  assert.equal(status.recovery, null);
});

test("unavailable production evidence suppresses unsafe Golden Path mutation", () => {
  const input = draftEvidenceInput();
  const unavailable = projectChangeFromGitHubEvidence({
    ...input,
    evidence: {
      ...input.evidence,
      branches: { status: "unavailable" },
    },
  });
  assert.equal(unavailable.status, "unavailable");
  const status = tryProjectGoldenPathStatus(
    goldenPathInput({ projection: unavailable }, { ready: { status: "eligible" } }),
  );
  assert.equal(status.valid, false);
  assert.equal(status.projection, undefined);
  assert.ok(status.diagnostics.some((diagnostic) => diagnostic.code === "GOLDEN_PATH_EVIDENCE_INCOMPLETE"));
});

test("CLI and Actions serializers retain the same projector input envelope", async () => {
  const actors = createGoldenPathActors(reviewEvidenceInput());
  const expected = await actors.executor.execute(mutationRequest("ready"));
  const normalized = normalizeChangeRemoteExecutionResult("ready", expected);
  assert.deepEqual(normalized, expected);

  const cli = await captureCliJson(["change", "ready", "411", "--json"], {
    changeExecutor: {
      async execute() {
        return expected;
      },
      async read() {
        return expected.projection;
      },
    },
  });
  assert.equal(cli.exitCode, 0);
  assert.deepEqual(cli.output.projection, expected.projection);
  assert.deepEqual(cli.output.evidence, expected.evidence);
  const cliResult = {
    projection: cli.output.projection,
    evidence: cli.output.evidence,
  } as ChangeRemoteExecutionResult;
  assert.deepEqual(
    goldenPathStatus(cliResult, { review: { status: "waiting", action: "wait" } }),
    goldenPathStatus(expected, {
      review: { status: "waiting", action: "wait" },
    }),
  );
});
