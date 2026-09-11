import assert from "node:assert/strict";
import { test } from "node:test";
import { renderIssueArtifact, renderPullRequestArtifact } from "./artifact.js";
import {
  CHANGE_CONTRACT_VERSION,
  CHANGE_TRANSITION_CONTRACT_VERSION,
  projectChangeFromGitHubEvidence,
  type ChangeDiagnostic,
  type ChangeGitHubEvidence,
  type ChangeProjectionInput,
  type ChangeProjectionResult,
} from "./change.js";
import {
  ChangeRemoteExecutorError,
  type ChangeRemoteExecutionResult,
  type ChangeRemoteExecutor,
  type ChangeRemoteMutationRequest,
  type ChangeRemoteReadRequest,
} from "./change-executor.js";
import { ChangeTrustedExecutorError } from "./change-trusted-executor.js";
import { issueContractFixture, pullRequestContractFixture } from "./contract/fixtures.js";
import type { CanonicalContract } from "./contract/ir.js";
import {
  composeGoldenPathReviewAdmission,
  executeGoldenPathReviewAdmission,
  GOLDEN_PATH_REVIEW_ADMISSION_CONTRACT_VERSION,
  GOLDEN_PATH_REVIEW_ADMISSION_OPERATION,
  projectGoldenPathReviewAdmission,
} from "./golden-path-review.js";

const identity = {
  repositoryHost: "github.com",
  repositoryId: "408000001",
  rootIssue: 408,
} as const;
const branch = "feat/408-golden-path-implementation-to-review";
const baseBranch = "main";
const issuer = "github:app/inari-issuer";
const branchGovernance = { pattern: "^(feat|fix|docs|refactor|test|chore)/[0-9]+-[a-z0-9-]+$" };
const naming = { type: "feat", slug: "golden-path-implementation-to-review" };

function governedContract(contract: CanonicalContract): CanonicalContract {
  return {
    ...contract,
    provenance: {
      authority: "repository-default-branch",
      repository: {
        host: identity.repositoryHost,
        owner: "acme",
        name: "inari",
        nameWithOwner: "acme/inari",
        repositoryId: identity.repositoryId,
      },
      ref: baseBranch,
      treeSha: "fixture-tree-sha",
      template: {
        path: contract.templateIdentity.path,
        ref: baseBranch,
        sha: "fixture-template-sha",
        digest: "fixture-template-digest",
      },
    },
  };
}

const issueContract = governedContract(issueContractFixture);
const pullRequestContract = governedContract(pullRequestContractFixture);
const issueBody = renderIssueArtifact(issueContract, {
  problem: "Implementation is complete and the Change can enter review.",
  category: "feature",
  affected_areas: ["contracts"],
  acceptance: ["tests"],
});
const pullRequestBody = renderPullRequestArtifact(pullRequestContract, {
  summary: "Compose implementation completion with governed Ready.",
  linked_issue: "Closes #408",
  acceptance: ["tests"],
  scope: "Ready validation and trusted execution.",
});

function projectionInput(draft: boolean): ChangeProjectionInput {
  const evidence: ChangeGitHubEvidence = {
    issue: { status: "available", value: { number: identity.rootIssue, state: "open" } },
    branches: { status: "available", value: [{ name: branch }] },
    pullRequests: {
      status: "available",
      value: [
        {
          number: 4080,
          head: branch,
          base: baseBranch,
          state: "open",
          draft,
          merged: false,
          provenance: { issuer },
        },
      ],
    },
  };
  return {
    change: identity,
    provenance: { issuer },
    branchGovernance,
    naming,
    baseBranch,
    evidence,
    readyEvidence: {
      issue: { contract: issueContract, body: issueBody },
      pullRequest: { contract: pullRequestContract, body: pullRequestBody },
    },
  };
}

function projection(draft: boolean): ChangeProjectionResult {
  const result = projectChangeFromGitHubEvidence(projectionInput(draft));
  assert.equal(result.valid, true);
  assert.equal(result.status, "healthy");
  assert.ok(result.change);
  return result;
}

function evidence(
  outcome: "verified" | "returned-existing" | "failed",
): NonNullable<ChangeRemoteExecutionResult["evidence"]> {
  return {
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    operation: "ready",
    outcome,
    issuer,
    effects:
      outcome === "returned-existing"
        ? []
        : [{ kind: "MARK_PULL_REQUEST_READY", status: outcome === "verified" ? "succeeded" : "failed" }],
    ...(outcome === "failed"
      ? {
          failure: {
            kind: "MARK_PULL_REQUEST_READY" as const,
            code: "PULL_REQUEST_READY_FAILED",
            message: "The bounded Ready effect failed.",
          },
        }
      : {}),
  };
}

function result(draft: boolean, outcome: "verified" | "returned-existing" | "failed"): ChangeRemoteExecutionResult {
  return { projection: projection(draft), evidence: evidence(outcome) };
}

class FakeExecutor implements ChangeRemoteExecutor {
  readonly executeRequests: ChangeRemoteMutationRequest[] = [];
  readonly readRequests: ChangeRemoteReadRequest[] = [];

  constructor(
    private readonly response:
      | ChangeRemoteExecutionResult
      | ChangeProjectionResult
      | Error
      | (() => ChangeRemoteExecutionResult | ChangeProjectionResult),
  ) {}

  async execute(request: ChangeRemoteMutationRequest): Promise<ChangeRemoteExecutionResult | ChangeProjectionResult> {
    this.executeRequests.push(request);
    if (this.response instanceof Error) throw this.response;
    return typeof this.response === "function" ? this.response() : this.response;
  }

  async read(request: ChangeRemoteReadRequest): Promise<ChangeProjectionResult> {
    this.readRequests.push(request);
    throw new Error("the review composition must not use the read port");
  }
}

function diagnostic(code: ChangeDiagnostic["code"], path: string, message: string): ChangeDiagnostic {
  return { version: CHANGE_CONTRACT_VERSION, code, path, message };
}

test("DRAFT implementation completion delegates only to semantic change ready and proves REVIEW", async () => {
  const executor = new FakeExecutor(result(false, "verified"));
  const output = await executeGoldenPathReviewAdmission({
    issue: identity.rootIssue,
    requester: "agent:implementation",
    executor,
  });

  assert.equal(output.ok, true);
  if (!output.ok) throw new Error("expected verified review admission");
  assert.equal(output.version, GOLDEN_PATH_REVIEW_ADMISSION_CONTRACT_VERSION);
  assert.equal(output.operation, GOLDEN_PATH_REVIEW_ADMISSION_OPERATION);
  assert.equal(output.issue, identity.rootIssue);
  assert.equal(output.change.state, "REVIEW");
  assert.equal(output.canonicalPullRequest, 4080);
  assert.equal(output.projection.status, "healthy");
  assert.equal(output.executionOutcome, "verified");
  assert.deepEqual(output.evidence?.effects, [{ kind: "MARK_PULL_REQUEST_READY", status: "succeeded" }]);
  assert.equal(executor.executeRequests.length, 1);
  assert.deepEqual(executor.executeRequests[0], {
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    operation: "ready",
    issue: identity.rootIssue,
    requester: "agent:implementation",
  });
  assert.deepEqual(executor.readRequests, []);
});

test("already-REVIEW retry is returned-existing and has no Ready effect", async () => {
  const executor = new FakeExecutor(result(false, "returned-existing"));
  const output = await composeGoldenPathReviewAdmission({ issue: identity.rootIssue, executor });

  assert.equal(output.ok, true);
  if (!output.ok) throw new Error("expected idempotent review admission");
  assert.equal(output.executionOutcome, "returned-existing");
  assert.deepEqual(output.evidence?.effects, []);
  assert.equal(output.change.state, "REVIEW");
});

test("DRAFT result without verified execution evidence fails closed", () => {
  const output = projectGoldenPathReviewAdmission(identity.rootIssue, {
    projection: projection(true),
  });

  assert.equal(output.ok, false);
  if (output.ok) throw new Error("expected a fail-closed result");
  assert.equal(output.error.code, "GOLDEN_PATH_REVIEW_RESULT_INVALID");
  assert.equal(output.projection?.change?.state, "DRAFT");
});

test("effect failure remains a bounded failure with existing execution evidence", () => {
  const output = projectGoldenPathReviewAdmission(identity.rootIssue, result(true, "failed"));

  assert.equal(output.ok, false);
  if (output.ok) throw new Error("expected a failed Ready result");
  assert.equal(output.error.code, "CHANGE_EXECUTION_EFFECT_FAILED");
  assert.equal(output.executionOutcome, "failed");
  assert.equal(output.evidence?.failure?.code, "PULL_REQUEST_READY_FAILED");
  assert.doesNotMatch(JSON.stringify(output), /token|privateKey|provider response/iu);
});

test("precondition, stale-read, and verification failures preserve bounded executor diagnostics", async () => {
  const precondition = new ChangeTrustedExecutorError(
    "CHANGE_EXECUTION_PRECONDITION_FAILED",
    "Ready transition preconditions failed.",
    [diagnostic("CHANGE_TRANSITION_NOT_ALLOWED", "$.change.state", "Ready transition is not allowed from ABORTED.")],
  );
  const staleRead = new ChangeTrustedExecutorError(
    "CHANGE_EXECUTION_READ_FAILED",
    "Trusted Change evidence read failed closed.",
    [diagnostic("CHANGE_PROJECTION_EVIDENCE_UNAVAILABLE", "$.evidence", "Authoritative evidence is unavailable.")],
  );
  const verification = new ChangeTrustedExecutorError(
    "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
    "Post-effect Ready projection verification failed.",
    [diagnostic("CHANGE_INVALID_PLAN", "$.projection.change.state", "Projection did not reach REVIEW.")],
  );

  for (const [error, code] of [
    [precondition, "CHANGE_EXECUTION_PRECONDITION_FAILED"],
    [staleRead, "CHANGE_EXECUTION_READ_FAILED"],
    [verification, "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED"],
  ] as const) {
    const output = await executeGoldenPathReviewAdmission({
      issue: identity.rootIssue,
      executor: new FakeExecutor(error),
    });
    assert.equal(output.ok, false);
    if (output.ok) throw new Error("expected a fail-closed result");
    assert.equal(output.error.code, code);
    assert.equal(output.diagnostics.length, 1);
    assert.equal(output.diagnostics[0]?.code, error.diagnostics[0]?.code);
  }
});

test("invalid remote output and mismatched identity never become a REVIEW success", async () => {
  const invalidRemote = await executeGoldenPathReviewAdmission({
    issue: identity.rootIssue,
    executor: new FakeExecutor(new ChangeRemoteExecutorError("CHANGE_REMOTE_RESULT_INVALID", "bounded result")),
  });
  assert.equal(invalidRemote.ok, false);
  if (invalidRemote.ok) throw new Error("expected invalid remote result");
  assert.equal(invalidRemote.error.code, "CHANGE_REMOTE_RESULT_INVALID");

  const mismatched = projection(false);
  const mismatchedChange = {
    ...mismatched,
    change:
      mismatched.change === undefined ? undefined : { ...mismatched.change, identity: { ...identity, rootIssue: 409 } },
  };
  const output = projectGoldenPathReviewAdmission(identity.rootIssue, {
    projection: mismatchedChange,
    evidence: evidence("verified"),
  });
  assert.equal(output.ok, false);
  if (output.ok) throw new Error("expected identity mismatch failure");
  assert.equal(output.error.code, "GOLDEN_PATH_REVIEW_RESULT_INVALID");
});

test("request validation remains bounded and no direct GitHub-ready path is exposed", async () => {
  const output = await executeGoldenPathReviewAdmission({
    issue: 0,
    executor: new FakeExecutor(result(false, "verified")),
  });
  assert.equal(output.ok, false);
  if (output.ok) throw new Error("expected invalid request failure");
  assert.equal(output.error.code, "CHANGE_REMOTE_REQUEST_INVALID");
  assert.equal(JSON.stringify(output).includes("ready_for_review"), false);
});
