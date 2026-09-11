import assert from "node:assert/strict";
import { test } from "node:test";
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

  const ready = await actors.executor.execute(mutationRequest("ready", "agent:golden-path"));
  assert.deepEqual(
    actors.issuer.effects.map((effect) => effect.kind),
    ["CREATE_BRANCH", "CREATE_PULL_REQUEST", "MARK_PULL_REQUEST_READY"],
  );
  assert.equal(ready.evidence?.outcome, "verified");
  assert.equal(ready.projection.status, "healthy");
  assert.equal(ready.projection.change?.state, "REVIEW");
  assertBoundedPublicResult("ready", ready);

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

  const aborted = createGoldenPathActors(abortedEvidenceInput());
  const abortRetry = await aborted.executor.execute(mutationRequest("abort"));
  assert.equal(abortRetry.evidence?.outcome, "returned-existing");
  assert.deepEqual(aborted.issuer.effects, []);
  assert.equal(abortRetry.projection.change?.state, "ABORTED");
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
});
