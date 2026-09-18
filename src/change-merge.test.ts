import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGE_TRANSITION_CONTRACT_VERSION,
  planChangeTransition,
  projectChangeFromGitHubEvidence,
  type ChangeProjectionInput,
  type ChangePullRequestEvidence,
  type ChangeReadyEvidence,
} from "./change.js";
import { renderIssueArtifact, renderPullRequestArtifact } from "./artifact.js";
import { issueContractFixture, pullRequestContractFixture } from "./contract/fixtures.js";
import type { CanonicalContract } from "./contract/ir.js";
import {
  planSemanticPullRequestMutation,
  SemanticPullRequestMutationError,
  type SemanticPullRequestMutationExecutionPort,
  type SemanticPullRequestMutationResult,
} from "./semantic-pr-mutation.js";
import { changeMutationRequest, type ChangeMutationRequest } from "./change-execution-port.js";
import {
  TrustedChangeExecutor,
  ChangeTrustedExecutorError,
  type ChangeTrustedEvidenceReader,
} from "./change-trusted-executor.js";
import {
  INARI_ISSUER_PRINCIPAL,
  type IssuerMutationRequest,
  type IssuerMutationResult,
  type TrustedExecutionContext,
} from "./github/effect-authorizer.js";

const identity = { repositoryHost: "github.com", repositoryId: "687000001", rootIssue: 687 } as const;
const branch = "feat/687-change-merge-terminalization";
const base = "main";
const headSha = "a".repeat(40);
const target = {
  repositoryHost: identity.repositoryHost,
  repositoryId: identity.repositoryId,
  nameWithOwner: "acme/inari",
} as const;
const execution: TrustedExecutionContext = {
  version: 1,
  runtime: "github-actions",
  event: "workflow_dispatch",
  repository: target,
  workflowRef: "refs/heads/main",
  workflowSha: "b".repeat(40),
  workflowTrust: "protected",
  codeExecution: "trusted-only",
  fork: false,
  pullRequest: false,
};
const branchGovernance = { pattern: "^(feat|fix|docs|refactor|test|chore)/[0-9]+-[a-z0-9-]+$" };
const naming = { type: "feat", slug: "change-merge-terminalization" };

function governed(contract: CanonicalContract): CanonicalContract {
  return {
    ...contract,
    provenance: {
      authority: "repository-default-branch",
      repository: {
        host: identity.repositoryHost,
        owner: "acme",
        name: "inari",
        nameWithOwner: target.nameWithOwner,
        repositoryId: identity.repositoryId,
      },
      ref: base,
      treeSha: "c".repeat(40),
      template: {
        path: contract.templateIdentity.path,
        ref: base,
        sha: "d".repeat(40),
        digest: "e".repeat(64),
      },
    },
  };
}

const issueContract = governed(issueContractFixture);
const pullRequestContract = governed(pullRequestContractFixture);
const issueBody = renderIssueArtifact(issueContract, {
  problem: "Coordinate the governed merge terminalization.",
  category: "feature",
  affected_areas: ["contracts"],
  acceptance: ["tests"],
});
const pullRequestBody = renderPullRequestArtifact(pullRequestContract, {
  summary: "Compose Change merge over the existing Semantic PR authority.",
  linked_issue: "Closes #687",
  acceptance: ["tests"],
  scope: "Merge validation and trusted execution.",
});

function pullRequest(overrides: Partial<ChangePullRequestEvidence> = {}): ChangePullRequestEvidence {
  return {
    number: 6870,
    head: branch,
    headSha,
    base,
    state: "open",
    draft: false,
    merged: false,
    accepted: false,
    provenance: { issuer: INARI_ISSUER_PRINCIPAL },
    ...overrides,
  };
}

function input(pr: ChangePullRequestEvidence = pullRequest()): ChangeProjectionInput {
  const readyEvidence: ChangeReadyEvidence = {
    issue: { contract: issueContract, body: issueBody },
    pullRequest: { contract: pullRequestContract, body: pullRequestBody },
  };
  return {
    change: identity,
    provenance: { issuer: INARI_ISSUER_PRINCIPAL },
    branchGovernance,
    naming,
    baseBranch: base,
    evidence: {
      issue: { status: "available", value: { number: identity.rootIssue, state: "open" } },
      branches: { status: "available", value: [{ name: branch, sha: headSha }] },
      pullRequests: { status: "available", value: [pr] },
    },
    readyEvidence,
  };
}

function mergePlan() {
  return planSemanticPullRequestMutation({
    version: "1",
    operation: "merge",
    repository: {
      hostname: identity.repositoryHost,
      nameWithOwner: target.nameWithOwner,
      repositoryId: identity.repositoryId,
    },
    pullRequest: 6870,
    expectedHead: headSha,
    expectedBase: base,
    strategy: "squash",
  });
}

test("Change merge planning binds the canonical PR/head/base and has no duplicate effect engine", () => {
  const projected = projectChangeFromGitHubEvidence(input());
  assert.equal(projected.change?.state, "REVIEW");
  const plan = planChangeTransition({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    transition: "merge",
    change: projected.change!,
    target: {
      branch,
      baseBranch: base,
      pullRequest: 6870,
      semanticPullRequestMergePlan: mergePlan(),
    },
  });
  assert.equal(plan.to, "MERGED");
  assert.deepEqual(plan.effects, []);
});

class Reader implements ChangeTrustedEvidenceReader {
  count = 0;
  constructor(
    readonly first: ChangeProjectionInput,
    readonly second?: ChangeProjectionInput,
  ) {}
  async read(_request: ChangeMutationRequest): Promise<ChangeProjectionInput> {
    this.count += 1;
    if (this.count > 1 && this.second !== undefined) return this.second;
    return this.first;
  }
}

class RereadFailureReader implements ChangeTrustedEvidenceReader {
  count = 0;
  constructor(readonly first: ChangeProjectionInput) {}
  async read(_request: ChangeMutationRequest): Promise<ChangeProjectionInput> {
    this.count += 1;
    if (this.count > 1) throw new Error("provider ambiguity");
    return this.first;
  }
}

class MutationExecutor implements SemanticPullRequestMutationExecutionPort {
  calls: unknown[] = [];
  constructor(readonly outcome: "succeeded" | "idempotent" = "succeeded") {}
  async execute(request: {
    readonly version: "1";
    readonly plan: unknown;
  }): Promise<SemanticPullRequestMutationResult> {
    this.calls.push(request);
    const plan = request.plan as ReturnType<typeof mergePlan>;
    return {
      version: "1",
      operation: "merge",
      outcome: this.outcome,
      plan,
      evidence: {
        version: "1",
        operation: "merge",
        outcome: this.outcome,
        effect: this.outcome === "idempotent" ? "not-attempted" : "succeeded",
        verified: true,
        postcondition: "merged",
        current: { pullRequest: 6870, head: headSha, base, state: "closed" },
      },
      current: {
        number: 6870,
        title: "Change",
        body: pullRequestBody,
        state: "closed",
        url: "https://github.com/acme/inari/pull/6870",
        draft: false,
        head: branch,
        headSha,
        base,
        merged: true,
        mergedAt: "2026-09-18T00:00:00Z",
        mergeCommitSha: "f".repeat(40),
        mergeMethod: "squash",
      },
    };
  }
}

const authorizer = {
  async applyEffects(_request: IssuerMutationRequest): Promise<IssuerMutationResult> {
    throw new Error("Change merge must not invoke the legacy Change effect engine.");
  },
};

function mergeExecutor(reader: Reader, semantic: SemanticPullRequestMutationExecutionPort): TrustedChangeExecutor {
  return new TrustedChangeExecutor({
    reader,
    effectAuthorizer: authorizer,
    execution,
    target,
    semanticPullRequestMutationExecutor: semantic,
  });
}

test("trusted Change merge delegates REVIEW and ACCEPTED to Semantic PR authority and rereads MERGED", async () => {
  for (const accepted of [false, true] as const) {
    const first = input(pullRequest({ accepted }));
    const second = input(pullRequest({ accepted, state: "closed", merged: true }));
    const reader = new Reader(first, second);
    const semantic = new MutationExecutor();
    const result = await mergeExecutor(reader, semantic).execute(
      changeMutationRequest("merge", 687, undefined, undefined, "squash"),
    );
    assert.equal(result.projection.change?.state, "MERGED");
    assert.equal(result.evidence?.outcome, "verified");
    assert.equal(reader.count, 2);
    assert.equal(semantic.calls.length, 1);
    const plan = (semantic.calls[0] as { readonly plan: ReturnType<typeof mergePlan> }).plan;
    assert.equal(plan.request.pullRequest, 6870);
    assert.equal(plan.request.expectedHead, headSha);
    assert.equal(plan.request.expectedBase, base);
  }
});

test("Change merge rejects DRAFT, stale head, and reread ambiguity with typed closed outcomes", async () => {
  const draftSemantic = new MutationExecutor();
  await assert.rejects(
    mergeExecutor(new Reader(input(pullRequest({ draft: true }))), draftSemantic).execute(
      changeMutationRequest("merge", 687, undefined, undefined, "squash"),
    ),
    (error: unknown) =>
      error instanceof ChangeTrustedExecutorError && error.code === "CHANGE_EXECUTION_PRECONDITION_FAILED",
  );
  assert.equal(draftSemantic.calls.length, 0);

  const stale = new SemanticPullRequestMutationError({
    code: "PR_MUTATION_STALE_HEAD",
    outcome: "stale",
    message: "The pull-request head changed.",
    diagnostics: [{ code: "PR_MUTATION_STALE_HEAD", path: "$.expectedHead", message: "stale" }],
    evidence: { version: "1", operation: "merge", outcome: "stale", effect: "not-attempted", verified: false },
  });
  const staleExecutor: SemanticPullRequestMutationExecutionPort = {
    execute: async () => {
      throw stale;
    },
  };
  await assert.rejects(
    mergeExecutor(new Reader(input()), staleExecutor).execute(
      changeMutationRequest("merge", 687, undefined, undefined, "squash"),
    ),
    (error: unknown) =>
      error instanceof ChangeTrustedExecutorError &&
      error.code === "CHANGE_EXECUTION_PRECONDITION_FAILED" &&
      error.evidence?.failure?.kind === "MERGE_PULL_REQUEST",
  );

  const successful = new MutationExecutor();
  await assert.rejects(
    mergeExecutor(new RereadFailureReader(input()), successful).execute(
      changeMutationRequest("merge", 687, undefined, undefined, "squash"),
    ),
    (error: unknown) =>
      error instanceof ChangeTrustedExecutorError && error.code === "CHANGE_EXECUTION_RECOVERY_REQUIRED",
  );
});
