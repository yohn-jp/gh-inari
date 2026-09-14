import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  GitHubPullRequest,
  GitHubPullRequestComment,
  GitHubPullRequestMergePolicyEvidence,
  GitHubPullRequestMergeResponse,
  GitHubPullRequestReview,
  RepositoryContext,
} from "./github/types.js";
import {
  SemanticPullRequestMutationError,
  LocalSemanticPullRequestMutationExecutor,
  materializeSemanticPullRequestMutationRequest,
  planSemanticPullRequestMutation,
  tryMaterializeSemanticPullRequestMutationRequest,
  type SemanticPullRequestMutationProvider,
  type SemanticPullRequestReviewIntent,
  type SemanticPullRequestMergeStrategy,
} from "./semantic-pr-mutation.js";

const repository = { hostname: "github.com", nameWithOwner: "acme/inari", repositoryId: "42" } as const;
const context: RepositoryContext = {
  hostname: repository.hostname,
  host: repository.hostname,
  owner: "acme",
  name: "inari",
  nameWithOwner: repository.nameWithOwner,
  url: "https://github.com/acme/inari",
  repositoryId: repository.repositoryId,
};

function pullRequest(overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
  return {
    number: 521,
    title: "Govern PR mutations",
    body: "",
    state: "open",
    url: "https://github.com/acme/inari/pull/521",
    draft: false,
    head: "feat/521-govern-pr-mutations",
    headSha: "head-521",
    base: "main",
    ...overrides,
  };
}

class FakeMutationProvider implements SemanticPullRequestMutationProvider {
  pullRequest = pullRequest();
  comments: GitHubPullRequestComment[] = [];
  reviews: GitHubPullRequestReview[] = [];
  commentEffects = 0;
  reviewEffects = 0;
  mergeEffects = 0;
  failCommentRead = false;
  ambiguousComment = false;
  failReviewRead = false;
  hideSubmittedReview = false;
  ambiguousReview = false;
  failPostconditionRead = false;
  failMerge = false;
  mergeError: unknown;
  ambiguousMerge = false;
  mergePolicy: GitHubPullRequestMergePolicyEvidence | undefined;
  actor = "octocat";
  private readCount = 0;

  async getRepositoryContext(): Promise<RepositoryContext> {
    return context;
  }

  async getAuthenticatedUser(): Promise<string> {
    return this.actor;
  }

  async readPullRequest(): Promise<GitHubPullRequest> {
    this.readCount += 1;
    if (this.failPostconditionRead && this.readCount > 1) throw new Error("reread unavailable");
    return { ...this.pullRequest };
  }

  async listPullRequestComments(): Promise<readonly GitHubPullRequestComment[]> {
    if (this.failCommentRead) throw new Error("comment reread unavailable");
    return [...this.comments];
  }

  async createPullRequestComment(_pullRequest: number, body: string): Promise<GitHubPullRequestComment> {
    this.commentEffects += 1;
    if (this.ambiguousComment) throw Object.assign(new Error("provider connection lost"), { ambiguous: true });
    const comment = {
      id: this.commentEffects,
      body,
      url: `https://github.com/acme/inari#comment-${this.commentEffects}`,
    };
    this.comments.push(comment);
    return comment;
  }

  async listPullRequestReviews(): Promise<readonly GitHubPullRequestReview[]> {
    if (this.failReviewRead) throw new Error("review reread unavailable");
    if (this.hideSubmittedReview && this.reviewEffects > 0) return [];
    return [...this.reviews];
  }

  async submitPullRequestReview(
    _pullRequest: number,
    intent: SemanticPullRequestReviewIntent,
    body: string,
  ): Promise<GitHubPullRequestReview> {
    this.reviewEffects += 1;
    if (this.ambiguousReview) throw Object.assign(new Error("provider connection lost"), { ambiguous: true });
    const state = intent === "approve" ? "approved" : intent === "request-changes" ? "changes-requested" : "commented";
    const review = {
      id: this.reviewEffects,
      body,
      state,
      commitId: this.pullRequest.headSha ?? this.pullRequest.head,
      author: this.actor,
    } as GitHubPullRequestReview;
    this.reviews.push(review);
    return review;
  }

  async mergePullRequest(
    _pullRequest: number,
    strategy: SemanticPullRequestMergeStrategy,
  ): Promise<GitHubPullRequestMergeResponse> {
    this.mergeEffects += 1;
    if (this.ambiguousMerge) throw Object.assign(new Error("provider connection lost"), { ambiguous: true });
    if (this.mergeError !== undefined) throw this.mergeError;
    if (this.failMerge) return { merged: false };
    this.pullRequest = {
      ...this.pullRequest,
      state: "closed",
      merged: true,
      mergedAt: "2026-09-13T00:00:00Z",
      mergeMethod: strategy,
    };
    return { merged: true, sha: "merge-521" };
  }

  async getPullRequestMergePolicy(): Promise<GitHubPullRequestMergePolicyEvidence> {
    return this.mergePolicy ?? {};
  }
}

function plan(input: Record<string, unknown>) {
  return planSemanticPullRequestMutation({
    version: "1",
    repository,
    pullRequest: 521,
    ...input,
  });
}

async function execute(provider: FakeMutationProvider, request: Record<string, unknown>) {
  return new LocalSemanticPullRequestMutationExecutor({ adapter: provider }).execute({
    version: "1",
    plan: plan(request),
  });
}

async function rejected(
  provider: FakeMutationProvider,
  request: Record<string, unknown>,
  code: string,
  outcome: string,
): Promise<SemanticPullRequestMutationError> {
  let captured: SemanticPullRequestMutationError | undefined;
  await assert.rejects(execute(provider, request), (error: unknown) => {
    assert.ok(error instanceof SemanticPullRequestMutationError);
    assert.equal(error.code, code);
    assert.equal(error.outcome, outcome);
    captured = error;
    return true;
  });
  assert.ok(captured);
  return captured;
}

test("materializes a closed, bounded mutation request and rejects unknown properties", () => {
  const result = tryMaterializeSemanticPullRequestMutationRequest({
    version: "1",
    operation: "review",
    repository,
    pullRequest: 521,
    expectedHead: "head-521",
    intent: "approve",
    extra: true,
  });
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((violation) => violation.path === "$.extra"));
  const materialized = materializeSemanticPullRequestMutationRequest({
    version: "1",
    operation: "review",
    repository,
    pullRequest: 521,
    expectedHead: "head-521",
    intent: "comment-only",
  });
  assert.equal(materialized.operation, "review");
  assert.equal(materialized.operation === "review" ? materialized.body : undefined, "");
  assert.equal(materialized.operation === "review" ? materialized.retry : undefined, "reject-duplicate");

  const unknownProperties = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`extra${index}`, true]));
  const bounded = tryMaterializeSemanticPullRequestMutationRequest({
    version: "1",
    operation: "comment",
    repository,
    pullRequest: 521,
    body: "hello",
    ...unknownProperties,
  });
  assert.equal(bounded.violations.length, 32);
});

test("comment effect is bounded and requires a verifiable reread", async () => {
  const provider = new FakeMutationProvider();
  const result = await execute(provider, { operation: "comment", body: "Please take a look." });
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.evidence.verified, true);
  assert.equal(provider.commentEffects, 1);

  const unreadable = new FakeMutationProvider();
  unreadable.failCommentRead = true;
  const error = await rejected(
    unreadable,
    { operation: "comment", body: "One comment." },
    "PR_MUTATION_POSTCONDITION_READ_FAILED",
    "recovery-required",
  );
  assert.equal(error.evidence.effect, "ambiguous");
  assert.equal(unreadable.commentEffects, 1);

  const ambiguous = new FakeMutationProvider();
  ambiguous.ambiguousComment = true;
  const ambiguousError = await rejected(
    ambiguous,
    { operation: "comment", body: "Maybe recorded." },
    "PR_MUTATION_RECOVERY_REQUIRED",
    "recovery-required",
  );
  assert.equal(ambiguousError.evidence.effect, "ambiguous");
});

test("review rejects a stale head before effect and makes exact retry idempotent", async () => {
  const stale = new FakeMutationProvider();
  stale.pullRequest = pullRequest({ headSha: "new-head" });
  await rejected(
    stale,
    { operation: "review", expectedHead: "head-521", intent: "approve", body: "LGTM" },
    "PR_MUTATION_STALE_HEAD",
    "stale",
  );
  assert.equal(stale.reviewEffects, 0);

  const missingImmutableHead = new FakeMutationProvider();
  missingImmutableHead.pullRequest = pullRequest({ headSha: undefined });
  await rejected(
    missingImmutableHead,
    { operation: "review", expectedHead: "head-521", intent: "approve", body: "LGTM" },
    "PR_MUTATION_TARGET_INVALID",
    "failed",
  );
  assert.equal(missingImmutableHead.reviewEffects, 0);

  const provider = new FakeMutationProvider();
  provider.reviews.push({ id: 7, body: "LGTM", state: "approved", commitId: "head-521", author: provider.actor });
  const replay = await execute(provider, {
    operation: "review",
    expectedHead: "head-521",
    intent: "approve",
    body: "LGTM",
  });
  assert.equal(replay.outcome, "idempotent");
  assert.equal(provider.reviewEffects, 0);
});

test("review duplicate/idempotence classification is bound to the authenticated caller, not any reviewer", async () => {
  const provider = new FakeMutationProvider();
  provider.reviews.push({
    id: 7,
    body: "LGTM",
    state: "approved",
    commitId: "head-521",
    author: "reviewer-b",
  });
  const result = await execute(provider, {
    operation: "review",
    expectedHead: "head-521",
    intent: "approve",
    body: "LGTM",
  });
  assert.equal(result.outcome, "succeeded");
  assert.equal(provider.reviewEffects, 1);
  assert.equal(provider.reviews.at(-1)?.author, provider.actor);
});

test("review duplicate policy is explicit and allow-duplicate verifies the new review", async () => {
  const provider = new FakeMutationProvider();
  provider.reviews.push({ id: 7, body: "Previous", state: "approved", commitId: "head-521", author: provider.actor });
  await rejected(
    provider,
    { operation: "review", expectedHead: "head-521", intent: "approve", body: "Current" },
    "PR_MUTATION_DUPLICATE_REVIEW",
    "blocked",
  );
  const retry = await execute(provider, {
    operation: "review",
    expectedHead: "head-521",
    intent: "approve",
    body: "Current",
    retry: "allow-duplicate",
  });
  assert.equal(retry.outcome, "succeeded");
  assert.equal(provider.reviewEffects, 1);

  const unverifiable = new FakeMutationProvider();
  unverifiable.hideSubmittedReview = true;
  await rejected(
    unverifiable,
    { operation: "review", expectedHead: "head-521", intent: "comment-only", body: "A note" },
    "PR_MUTATION_POSTCONDITION_FAILED",
    "failed",
  );
  assert.equal(unverifiable.reviewEffects, 1);

  const ambiguous = new FakeMutationProvider();
  ambiguous.ambiguousReview = true;
  const ambiguousError = await rejected(
    ambiguous,
    { operation: "review", expectedHead: "head-521", intent: "approve", body: "Maybe submitted" },
    "PR_MUTATION_RECOVERY_REQUIRED",
    "recovery-required",
  );
  assert.equal(ambiguousError.evidence.providerResponse, "ambiguous");
});

test("merge admission rejects stale base, draft, and blocked/conflicting evidence without effect", async () => {
  const staleBase = new FakeMutationProvider();
  staleBase.pullRequest = pullRequest({ base: "release" });
  await rejected(
    staleBase,
    { operation: "merge", expectedHead: "head-521", expectedBase: "main", strategy: "squash" },
    "PR_MUTATION_STALE_BASE",
    "stale",
  );
  assert.equal(staleBase.mergeEffects, 0);

  const draft = new FakeMutationProvider();
  draft.pullRequest = pullRequest({ draft: true });
  await rejected(
    draft,
    { operation: "merge", expectedHead: "head-521", expectedBase: "main", strategy: "merge" },
    "PR_MUTATION_DRAFT",
    "blocked",
  );
  assert.equal(draft.mergeEffects, 0);

  const blocked = new FakeMutationProvider();
  blocked.pullRequest = pullRequest({ mergeable: false, mergeableState: "dirty" });
  await rejected(
    blocked,
    { operation: "merge", expectedHead: "head-521", expectedBase: "main", strategy: "merge" },
    "PR_MUTATION_MERGE_BLOCKED",
    "blocked",
  );
  assert.equal(blocked.mergeEffects, 0);
});

test("merge enforces authoritative policy and verifies provider failure, reread failure, and postcondition failure", async () => {
  const policy = new FakeMutationProvider();
  policy.mergePolicy = {
    allowedStrategies: ["squash"],
    checks: { authoritative: true, satisfied: false, required: ["ci"], state: "failure" },
  };
  await rejected(
    policy,
    { operation: "merge", expectedHead: "head-521", expectedBase: "main", strategy: "merge" },
    "PR_MUTATION_MERGE_BLOCKED",
    "blocked",
  );
  assert.equal(policy.mergeEffects, 0);

  const providerFailure = new FakeMutationProvider();
  providerFailure.failMerge = true;
  await rejected(
    providerFailure,
    { operation: "merge", expectedHead: "head-521", expectedBase: "main", strategy: "merge" },
    "PR_MUTATION_EFFECT_FAILED",
    "failed",
  );

  const secretFailure = new FakeMutationProvider();
  secretFailure.mergeError = new Error("access-token=do-not-return");
  const secretError = await rejected(
    secretFailure,
    { operation: "merge", expectedHead: "head-521", expectedBase: "main", strategy: "merge" },
    "PR_MUTATION_EFFECT_FAILED",
    "failed",
  );
  assert.doesNotMatch(secretError.message, /do-not-return/u);
  assert.doesNotMatch(JSON.stringify(secretError.diagnostics), /do-not-return/u);

  const rereadFailure = new FakeMutationProvider();
  rereadFailure.failPostconditionRead = true;
  await rejected(
    rereadFailure,
    { operation: "merge", expectedHead: "head-521", expectedBase: "main", strategy: "merge" },
    "PR_MUTATION_POSTCONDITION_READ_FAILED",
    "recovery-required",
  );

  const postcondition = new FakeMutationProvider();
  postcondition.mergePullRequest = async () => {
    postcondition.mergeEffects += 1;
    return { merged: true };
  };
  await rejected(
    postcondition,
    { operation: "merge", expectedHead: "head-521", expectedBase: "main", strategy: "merge" },
    "PR_MUTATION_POSTCONDITION_FAILED",
    "failed",
  );

  const missingStrategyEvidence = new FakeMutationProvider();
  missingStrategyEvidence.mergePullRequest = async (_pullRequest, strategy) => {
    missingStrategyEvidence.mergeEffects += 1;
    missingStrategyEvidence.pullRequest = {
      ...missingStrategyEvidence.pullRequest,
      state: "closed",
      merged: true,
      mergedAt: "2026-09-13T00:00:00Z",
      mergeMethod: undefined,
    };
    return { merged: true, sha: `merge-${strategy}` };
  };
  const succeededWithoutStrategyEvidence = await execute(missingStrategyEvidence, {
    operation: "merge",
    expectedHead: "head-521",
    expectedBase: "main",
    strategy: "merge",
  });
  assert.equal(succeededWithoutStrategyEvidence.outcome, "succeeded");
});

test("ambiguous merge remains recovery-required and a proven merge replay is idempotent", async () => {
  const ambiguous = new FakeMutationProvider();
  ambiguous.ambiguousMerge = true;
  const error = await rejected(
    ambiguous,
    { operation: "merge", expectedHead: "head-521", expectedBase: "main", strategy: "merge" },
    "PR_MUTATION_RECOVERY_REQUIRED",
    "recovery-required",
  );
  assert.equal(error.evidence.providerResponse, "ambiguous");
  assert.equal(ambiguous.mergeEffects, 1);

  const provider = new FakeMutationProvider();
  const first = await execute(provider, {
    operation: "merge",
    expectedHead: "head-521",
    expectedBase: "main",
    strategy: "squash",
  });
  assert.equal(first.outcome, "succeeded");
  const second = await execute(provider, {
    operation: "merge",
    expectedHead: "head-521",
    expectedBase: "main",
    strategy: "squash",
  });
  assert.equal(second.outcome, "idempotent");
  assert.equal(provider.mergeEffects, 1);
});

test("a merge already closed without provider strategy evidence is not reported idempotent for an arbitrary requested strategy", async () => {
  const provider = new FakeMutationProvider();
  provider.pullRequest = pullRequest({
    state: "closed",
    merged: true,
    mergedAt: "2026-09-13T00:00:00Z",
    mergeMethod: undefined,
  });
  const error = await rejected(
    provider,
    { operation: "merge", expectedHead: "head-521", expectedBase: "main", strategy: "squash" },
    "PR_MUTATION_NOT_OPEN",
    "blocked",
  );
  assert.equal(error.evidence.effect, "not-attempted");
  assert.equal(provider.mergeEffects, 0);
});
