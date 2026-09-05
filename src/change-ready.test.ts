import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGE_CONTRACT_VERSION,
  CHANGE_TRANSITION_CONTRACT_VERSION,
  planChangeRecovery,
  planChangeIssuance,
  planChangeReadyTransition,
  planChangeTransition,
  validateChangeReadyTransition,
  type Change,
  type ChangeProjectionInput,
  type ChangeReadyEvidence,
  type ChangePullRequestEvidence,
} from "./change.js";
import { renderIssueArtifact, renderPullRequestArtifact } from "./artifact.js";
import { issueContractFixture, pullRequestContractFixture } from "./contract/fixtures.js";
import type { CanonicalContract } from "./contract/ir.js";
import {
  INARI_ISSUER_PRINCIPAL,
  type IssuerMutationRequest,
  type IssuerMutationResult,
  type IssuerRepositoryIdentity,
  type TrustedExecutionContext,
} from "./github/issuer-authority.js";
import {
  TrustedChangeExecutor,
  ChangeTrustedExecutorError,
  type ChangeTrustedEvidenceReader,
} from "./change-trusted-executor.js";
import type { ChangeRemoteMutationRequest } from "./change-executor.js";

const identity = {
  repositoryHost: "github.com",
  repositoryId: "221000001",
  rootIssue: 221,
} as const;
const branch = "feat/221-implement-governed-change-ready-transition";
const baseBranch = "main";
const issuer = INARI_ISSUER_PRINCIPAL;
const branchGovernance = { pattern: "^(feat|fix|docs|refactor|test|chore)/[0-9]+-[a-z0-9-]+$" };
const naming = { type: "feat", slug: "implement-governed-change-ready-transition" };

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
  problem: "A Draft Change needs a governed Ready transition.",
  category: "feature",
  affected_areas: ["contracts"],
  acceptance: ["tests"],
});
const pullRequestBody = renderPullRequestArtifact(pullRequestContract, {
  summary: "Complete the governed Ready transition.",
  linked_issue: "Closes #221",
  acceptance: ["tests"],
  scope: "Ready validation and trusted execution.",
});

function pullRequest(overrides: Partial<ChangePullRequestEvidence> = {}): ChangePullRequestEvidence {
  return {
    number: 2210,
    head: branch,
    base: baseBranch,
    state: "open",
    draft: true,
    merged: false,
    provenance: { issuer },
    ...overrides,
  };
}

function projectionInput(pr: ChangePullRequestEvidence = pullRequest()): ChangeProjectionInput {
  const readyEvidence: ChangeReadyEvidence = {
    issue: { contract: issueContract, body: issueBody },
    pullRequest: { contract: pullRequestContract, body: pullRequestBody },
  };
  return {
    change: identity,
    provenance: { issuer },
    branchGovernance,
    naming,
    baseBranch,
    evidence: {
      issue: { status: "available", value: { number: identity.rootIssue, state: "open" } },
      branches: { status: "available", value: [{ name: branch }] },
      pullRequests: { status: "available", value: [pr] },
    },
    readyEvidence,
  };
}

function canonicalChange(input: ChangeProjectionInput = projectionInput()): Change {
  return planChangeIssuance(input).result;
}

function readyInput(input: ChangeProjectionInput = projectionInput(), change = canonicalChange(input)) {
  return {
    change,
    projection: input,
    issue: input.readyEvidence?.issue,
    pullRequest: input.readyEvidence?.pullRequest,
  };
}

test("healthy DRAFT -> REVIEW validates every Ready precondition in Core", () => {
  const result = validateChangeReadyTransition(readyInput());
  assert.equal(result.valid, true);
  assert.equal(result.idempotent, false);
  assert.equal(result.change?.state, "DRAFT");
  assert.equal(result.projection?.status, "healthy");
});

test("missing Issue/PR evidence and invalid contract evidence reject before planning", () => {
  const missing = validateChangeReadyTransition({
    change: canonicalChange(),
    projection: projectionInput(),
  });
  assert.equal(missing.valid, false);
  assert.ok(missing.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_MISSING_PROPERTY"));

  const invalid = validateChangeReadyTransition({
    ...readyInput(),
    issue: { contract: issueContract, body: issueBody.replace("Validate all", "") },
    pullRequest: { contract: pullRequestContract, body: pullRequestBody.replace("Closes #221", "No link") },
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_PROVENANCE_INVALID_PR_CONTRACT"));
});

test("noncanonical branch/PR, issuer, base, and projection recovery drift reject", () => {
  const cases = [
    projectionInput(pullRequest({ head: "feat/221-other" })),
    projectionInput(pullRequest({ provenance: { issuer: "human:manual" } })),
    projectionInput(pullRequest({ base: "develop" })),
    {
      ...projectionInput(),
      evidence: { ...projectionInput().evidence, branches: { status: "available" as const, value: [] } },
    },
    {
      ...projectionInput(),
      readyEvidence: {
        issue: { contract: issueContract, body: issueBody },
        pullRequest: { contract: pullRequestContract, body: pullRequestBody.replace("Closes #221", "No link") },
      },
    },
  ];
  for (const input of cases) {
    assert.equal(validateChangeReadyTransition(readyInput(input, canonicalChange())).valid, false);
  }
});

test("already-ready healthy retry is idempotent and requires no effect", () => {
  const input = projectionInput(pullRequest({ draft: false }));
  const result = validateChangeReadyTransition(readyInput(input));
  assert.equal(result.valid, true);
  assert.equal(result.idempotent, true);
  assert.equal(canonicalChange(input).state, "REVIEW");
});

const target: IssuerRepositoryIdentity = {
  repositoryHost: identity.repositoryHost,
  repositoryId: identity.repositoryId,
  nameWithOwner: "acme/inari",
};
const execution: TrustedExecutionContext = {
  version: 1,
  runtime: "github-actions",
  event: "workflow_dispatch",
  repository: target,
  workflowRef: "refs/heads/main",
  workflowSha: "a".repeat(40),
  workflowTrust: "protected",
  codeExecution: "trusted-only",
  fork: false,
  pullRequest: false,
};

class MutableReader implements ChangeTrustedEvidenceReader {
  constructor(public current: ChangeProjectionInput) {}
  async read(_request: ChangeRemoteMutationRequest): Promise<ChangeProjectionInput> {
    return this.current;
  }
}

class FakeIssuer {
  readonly effects: string[] = [];
  fail = false;
  mutate = true;
  constructor(readonly reader: MutableReader) {}

  async applyEffects(request: IssuerMutationRequest): Promise<IssuerMutationResult> {
    const effect = request.effects[0];
    assert.ok(effect);
    this.effects.push(effect.kind);
    if (this.fail) throw new Error("provider response must not cross the boundary");
    if (this.mutate && effect.kind === "MARK_PULL_REQUEST_READY") {
      this.reader.current = {
        ...this.reader.current,
        evidence: {
          ...this.reader.current.evidence,
          pullRequests: {
            status: "available",
            value:
              this.reader.current.evidence.pullRequests?.status === "available"
                ? this.reader.current.evidence.pullRequests.value.map((candidate) => ({ ...candidate, draft: false }))
                : [],
          },
        },
      };
    }
    return {
      version: 1,
      authority: "issuer",
      issuer: { kind: "github-app", slug: "inari-issuer", appId: "218", principal: issuer },
      repository: target,
      installation: { appId: "218", installationId: "221", repositoryHost: identity.repositoryHost },
      permissions: { pull_requests: "write" },
      effects: [{ kind: effect.kind, status: "applied" }],
    };
  }
}

function executor(reader: MutableReader, issuerAuthority: FakeIssuer): TrustedChangeExecutor {
  return new TrustedChangeExecutor({ reader, issuerAuthority, execution, target });
}

function remoteReadyRequest(): ChangeRemoteMutationRequest {
  return { version: CHANGE_TRANSITION_CONTRACT_VERSION, operation: "ready", issue: identity.rootIssue };
}

test("trusted executor applies only MARK_PULL_REQUEST_READY after Core validation", async () => {
  const reader = new MutableReader(projectionInput());
  const issuerAuthority = new FakeIssuer(reader);
  const result = await executor(reader, issuerAuthority).execute(remoteReadyRequest());
  assert.deepEqual(issuerAuthority.effects, ["MARK_PULL_REQUEST_READY"]);
  assert.equal(result.evidence?.outcome, "verified");
  assert.equal(result.projection.change?.state, "REVIEW");
});

test("invalid Ready request causes no GitHub mutation", async () => {
  const input = projectionInput(pullRequest({ base: "develop" }));
  const reader = new MutableReader(input);
  const issuerAuthority = new FakeIssuer(reader);
  await assert.rejects(
    executor(reader, issuerAuthority).execute(remoteReadyRequest()),
    (error: unknown) =>
      error instanceof ChangeTrustedExecutorError && error.code === "CHANGE_EXECUTION_PRECONDITION_FAILED",
  );
  assert.deepEqual(issuerAuthority.effects, []);
});

test("trusted executor treats a healthy already-ready retry as a no-op", async () => {
  const reader = new MutableReader(projectionInput(pullRequest({ draft: false })));
  const issuerAuthority = new FakeIssuer(reader);
  const result = await executor(reader, issuerAuthority).execute(remoteReadyRequest());
  assert.deepEqual(issuerAuthority.effects, []);
  assert.equal(result.evidence?.outcome, "returned-existing");
  assert.equal(result.projection.change?.state, "REVIEW");
});

test("mutation failure is bounded and never reported as success", async () => {
  const reader = new MutableReader(projectionInput());
  const issuerAuthority = new FakeIssuer(reader);
  issuerAuthority.fail = true;
  const result = await executor(reader, issuerAuthority).execute(remoteReadyRequest());
  assert.equal(result.evidence?.outcome, "failed");
  assert.equal(result.evidence?.failure?.code, "PULL_REQUEST_READY_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /provider response|token|privateKey/iu);
});

test("post-effect projection verification failure is deterministic and bounded", async () => {
  const reader = new MutableReader(projectionInput());
  const issuerAuthority = new FakeIssuer(reader);
  issuerAuthority.mutate = false;
  await assert.rejects(
    executor(reader, issuerAuthority).execute(remoteReadyRequest()),
    (error: unknown) =>
      error instanceof ChangeTrustedExecutorError && error.code === "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
  );
  assert.deepEqual(issuerAuthority.effects, ["MARK_PULL_REQUEST_READY"]);
});

test("requester and issuer provenance remain separate through Ready", async () => {
  const reader = new MutableReader(projectionInput());
  const issuerAuthority = new FakeIssuer(reader);
  const result = await executor(reader, issuerAuthority).execute({
    ...remoteReadyRequest(),
    requester: "agent:implementation",
  });
  assert.equal(result.evidence?.requester, "agent:implementation");
  assert.equal(result.evidence?.issuer, issuer);
  assert.equal(result.projection.change?.provenance.requester, "agent:implementation");
  assert.equal(result.projection.change?.provenance.issuer, issuer);
  assert.equal(result.projection.change?.provenance.implementer, undefined);
  assert.equal(result.projection.change?.provenance.reviewer, undefined);
  assert.equal(result.projection.change?.version, CHANGE_CONTRACT_VERSION);
});

test("Ready addition preserves the Abort recovery plan", () => {
  const change = canonicalChange();
  const transition = planChangeTransition({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    transition: "abort",
    change,
  });
  const recovery = planChangeRecovery({
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
    projection: projectionInput(pullRequest({ state: "closed", draft: false })),
  });

  assert.equal(recovery.operation, "recover-transition");
  if (recovery.operation !== "recover-transition") throw new Error("expected Abort transition recovery");
  assert.deepEqual(recovery.effects, [{ kind: "DELETE_BRANCH", branch }]);
});

test("Abort addition preserves the healthy Ready retry no-op", () => {
  const input = projectionInput(pullRequest({ draft: false }));
  const change = canonicalChange(input);
  const readyPlan = planChangeReadyTransition(readyInput(input, change));

  assert.deepEqual(readyPlan.effects, []);
  assert.equal(readyPlan.from, "REVIEW");
  assert.equal(readyPlan.to, "REVIEW");
});

test("RECOVERY_REQUIRED and ABORTED Changes cannot enter Ready", () => {
  for (const state of ["RECOVERY_REQUIRED", "ABORTED"] as const) {
    const result = validateChangeReadyTransition(readyInput(projectionInput(), { ...canonicalChange(), state }));
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.length > 0);
    assert.throws(() => planChangeReadyTransition(readyInput(projectionInput(), { ...canonicalChange(), state })));
  }
});
