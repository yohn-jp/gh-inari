/**
 * Credential-bound provider for the existing Semantic PR mutation authority.
 *
 * This module only translates the scoped GitHub App transport into the
 * provider-neutral #521 contract. Admission, merge execution, idempotence,
 * and postcondition proof remain in `semantic-pr-mutation.ts`.
 */

import type {
  GitHubChangeEffectHttpMethod,
  GitHubChangeEffectJsonObject,
  GitHubChangeEffectRepository,
  GitHubChangeEffectResponse,
  GitHubChangeEffectTransport,
} from "./change-effect-adapter.js";
import type {
  GitHubPullRequest,
  GitHubPullRequestComment,
  GitHubPullRequestMergePolicyEvidence,
  GitHubPullRequestMergeResponse,
  GitHubPullRequestReview,
  RepositoryContext,
} from "./types.js";
import {
  LocalSemanticPullRequestMutationExecutor,
  type SemanticPullRequestMutationExecutionPort,
  type SemanticPullRequestMergeStrategy,
  type SemanticPullRequestReviewIntent,
  type SemanticPullRequestMutationProvider,
} from "../semantic-pr-mutation.js";
import type { RepositoryIdentity } from "./effect-authorizer.js";

const SHA = /^[0-9a-f]{40}$/iu;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

export const GITHUB_APP_SEMANTIC_PULL_REQUEST_PERMISSIONS = Object.freeze({
  pull_requests: "write",
} as const);

export class GitHubAppSemanticPullRequestProviderError extends Error {
  readonly category: "transport" | "provider";

  constructor(category: "transport" | "provider") {
    super("Credential-bound Semantic PR provider operation failed closed.");
    this.name = "GitHubAppSemanticPullRequestProviderError";
    this.category = category;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubAppSemanticPullRequestProviderError("provider");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > 1_048_576 ||
    !SAFE_TEXT.test(value)
  ) {
    throw new GitHubAppSemanticPullRequestProviderError("provider");
  }
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new GitHubAppSemanticPullRequestProviderError("provider");
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : text(value);
}

function optionalSha(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !SHA.test(value)) {
    throw new GitHubAppSemanticPullRequestProviderError("provider");
  }
  return value.toLowerCase();
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return record(value);
}

function parsePullRequest(value: unknown): GitHubPullRequest {
  const candidate = record(value);
  const head = nestedRecord(candidate.head);
  const base = nestedRecord(candidate.base);
  const state = candidate.state === "open" || candidate.state === "closed" ? candidate.state : undefined;
  if (state === undefined || typeof candidate.draft !== "boolean") {
    throw new GitHubAppSemanticPullRequestProviderError("provider");
  }
  const body = candidate.body === null ? null : text(candidate.body, true);
  const mergeable =
    candidate.mergeable === undefined || candidate.mergeable === null
      ? candidate.mergeable
      : typeof candidate.mergeable === "boolean"
        ? candidate.mergeable
        : undefined;
  if (candidate.mergeable !== undefined && mergeable === undefined) {
    throw new GitHubAppSemanticPullRequestProviderError("provider");
  }
  return {
    number: number(candidate.number),
    title: text(candidate.title),
    body,
    state,
    url: text(candidate.html_url ?? candidate.url),
    draft: candidate.draft,
    head: text(head.ref),
    ...(optionalSha(head.sha) === undefined ? {} : { headSha: optionalSha(head.sha) }),
    base: text(base.ref),
    ...(optionalSha(base.sha) === undefined ? {} : { baseSha: optionalSha(base.sha) }),
    ...(candidate.maintainer_can_modify === undefined
      ? {}
      : { maintainerCanModify: candidate.maintainer_can_modify === true }),
    ...(mergeable === undefined ? {} : { mergeable }),
    ...(optionalText(candidate.mergeable_state) === undefined
      ? {}
      : { mergeableState: optionalText(candidate.mergeable_state) }),
    ...(candidate.merged === undefined ? {} : { merged: candidate.merged === true }),
    ...(candidate.merged_at === undefined
      ? {}
      : { mergedAt: candidate.merged_at === null ? null : text(candidate.merged_at) }),
    ...(candidate.merge_commit_sha === undefined
      ? {}
      : { mergeCommitSha: candidate.merge_commit_sha === null ? null : optionalSha(candidate.merge_commit_sha) }),
    ...(candidate.merge_method === undefined ? {} : { mergeMethod: parseStrategy(candidate.merge_method) }),
  };
}

function parseStrategy(value: unknown): SemanticPullRequestMergeStrategy {
  if (value !== "merge" && value !== "squash" && value !== "rebase") {
    throw new GitHubAppSemanticPullRequestProviderError("provider");
  }
  return value;
}

function parseMergeResponse(value: unknown): GitHubPullRequestMergeResponse {
  const candidate = record(value);
  if (typeof candidate.merged !== "boolean") throw new GitHubAppSemanticPullRequestProviderError("provider");
  const sha = optionalSha(candidate.sha);
  return { merged: candidate.merged, ...(sha === undefined ? {} : { sha }) };
}

function parseReviews(value: unknown): readonly GitHubPullRequestReview[] {
  if (!Array.isArray(value) || value.length > 100) throw new GitHubAppSemanticPullRequestProviderError("provider");
  return value.map((entry) => {
    const candidate = record(entry);
    const state = candidate.state;
    const normalizedState =
      state === "APPROVED"
        ? "approved"
        : state === "CHANGES_REQUESTED"
          ? "changes-requested"
          : state === "COMMENTED"
            ? "commented"
            : state === "DISMISSED"
              ? "dismissed"
              : "unknown";
    const user = candidate.user === undefined || candidate.user === null ? undefined : record(candidate.user);
    return {
      id: number(candidate.id),
      body: candidate.body === null || candidate.body === undefined ? null : text(candidate.body, true),
      state: normalizedState,
      commitId: text(candidate.commit_id ?? candidate.commitId),
      ...(user?.login === undefined ? {} : { author: text(user.login) }),
    };
  });
}

function responseBody(response: GitHubChangeEffectResponse, expected: readonly number[]): unknown {
  if (!expected.includes(response.status)) {
    throw new GitHubAppSemanticPullRequestProviderError(response.status >= 500 ? "transport" : "provider");
  }
  return response.body;
}

function repositoryContext(repository: RepositoryIdentity): RepositoryContext {
  const separator = repository.nameWithOwner.indexOf("/");
  if (separator < 1 || separator === repository.nameWithOwner.length - 1) {
    throw new GitHubAppSemanticPullRequestProviderError("provider");
  }
  const owner = repository.nameWithOwner.slice(0, separator);
  const name = repository.nameWithOwner.slice(separator + 1);
  return {
    hostname: repository.repositoryHost,
    host: repository.repositoryHost,
    owner,
    name,
    nameWithOwner: repository.nameWithOwner,
    url: `https://${repository.repositoryHost}/${repository.nameWithOwner}`,
    repositoryId: repository.repositoryId,
  };
}

class ScopedSemanticPullRequestProvider implements SemanticPullRequestMutationProvider {
  readonly #transport: GitHubChangeEffectTransport;
  readonly #repository: RepositoryIdentity;
  readonly #context: RepositoryContext;

  constructor(options: { readonly transport: GitHubChangeEffectTransport; readonly repository: RepositoryIdentity }) {
    this.#transport = options.transport;
    this.#repository = options.repository;
    this.#context = repositoryContext(options.repository);
  }

  getRepositoryContext = async (): Promise<RepositoryContext> => this.#context;

  getAuthenticatedUser = async (): Promise<string> => "inari-issuer[bot]";

  readPullRequest = async (pullRequest: number): Promise<GitHubPullRequest> =>
    parsePullRequest(responseBody(await this.request(`pulls/${numberPath(pullRequest)}`, "GET"), [200]));

  listPullRequestComments = async (_pullRequest: number): Promise<readonly GitHubPullRequestComment[]> => {
    throw new GitHubAppSemanticPullRequestProviderError("provider");
  };

  createPullRequestComment = async (_pullRequest: number, _body: string): Promise<GitHubPullRequestComment> => {
    throw new GitHubAppSemanticPullRequestProviderError("provider");
  };

  listPullRequestReviews = async (pullRequest: number): Promise<readonly GitHubPullRequestReview[]> =>
    parseReviews(
      responseBody(await this.request(`pulls/${numberPath(pullRequest)}/reviews?per_page=100`, "GET"), [200]),
    );

  submitPullRequestReview = async (
    _pullRequest: number,
    _intent: SemanticPullRequestReviewIntent,
    _body: string,
    _expectedHead?: string,
  ): Promise<GitHubPullRequestReview> => {
    throw new GitHubAppSemanticPullRequestProviderError("provider");
  };

  mergePullRequest = async (
    pullRequest: number,
    strategy: SemanticPullRequestMergeStrategy,
    expectedHead?: string,
  ): Promise<GitHubPullRequestMergeResponse> => {
    const body: GitHubChangeEffectJsonObject = {
      merge_method: strategy,
      ...(expectedHead === undefined ? {} : { sha: expectedHead }),
    };
    return parseMergeResponse(
      responseBody(await this.request(`pulls/${numberPath(pullRequest)}/merge`, "PUT", body), [200]),
    );
  };

  getPullRequestMergePolicy = async (pullRequest: GitHubPullRequest): Promise<GitHubPullRequestMergePolicyEvidence> => {
    const repository = record(responseBody(await this.request("", "GET"), [200]));
    const allowedStrategies = [
      repository.allow_merge_commit === true ? "merge" : undefined,
      repository.allow_squash_merge === true ? "squash" : undefined,
      repository.allow_rebase_merge === true ? "rebase" : undefined,
    ].filter((value): value is SemanticPullRequestMergeStrategy => value !== undefined);
    const checks = await this.readRequiredChecks(pullRequest);
    const reviews = await this.readRequiredReviews(pullRequest);
    return {
      ...(allowedStrategies.length === 0 ? {} : { allowedStrategies }),
      ...(checks === undefined ? {} : { checks }),
      ...(reviews === undefined ? {} : { reviews }),
    };
  };

  private async request(
    suffix: string,
    method: GitHubChangeEffectHttpMethod,
    body?: GitHubChangeEffectJsonObject,
  ): Promise<GitHubChangeEffectResponse> {
    const prefix = `repos/${this.#repository.nameWithOwner}`;
    try {
      return await this.#transport.request({
        hostname: this.#repository.repositoryHost,
        method,
        path: suffix === "" ? prefix : `${prefix}/${suffix}`,
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new GitHubAppSemanticPullRequestProviderError("transport");
    }
  }

  private async readRequiredChecks(
    pullRequest: GitHubPullRequest,
  ): Promise<GitHubPullRequestMergePolicyEvidence["checks"] | undefined> {
    const response = await this.request(
      `branches/${encodeURIComponent(pullRequest.base)}/protection/required_status_checks`,
      "GET",
    );
    if (response.status === 404) return undefined;
    const value = record(responseBody(response, [200]));
    const contexts = [
      ...(Array.isArray(value.contexts)
        ? value.contexts.filter((item): item is string => typeof item === "string")
        : []),
      ...(Array.isArray(value.checks)
        ? value.checks.flatMap((item) => {
            if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
            const context = (item as Record<string, unknown>).context;
            return typeof context === "string" ? [context] : [];
          })
        : []),
    ];
    if (contexts.length === 0) return { authoritative: true, satisfied: true, required: [] };
    const sha = pullRequest.headSha;
    if (sha === undefined) return { authoritative: true, satisfied: false, required: contexts };
    const [checksResponse, statusResponse] = await Promise.all([
      this.request(`commits/${sha}/check-runs?per_page=100`, "GET"),
      this.request(`commits/${sha}/status?per_page=100`, "GET"),
    ]);
    const checkBody = record(responseBody(checksResponse, [200]));
    const checkRuns = Array.isArray(checkBody.check_runs) ? checkBody.check_runs : [];
    const checksByName = new Map<string, boolean>();
    for (const item of checkRuns) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.name === "string") checksByName.set(candidate.name, candidate.conclusion === "success");
    }
    const statusBody = Array.isArray(statusResponse.body) ? statusResponse.body : [];
    for (const item of statusBody) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.context === "string") checksByName.set(candidate.context, candidate.state === "success");
    }
    return {
      authoritative: true,
      satisfied: contexts.every((context) => checksByName.get(context) === true),
      required: contexts,
    };
  }

  private async readRequiredReviews(
    pullRequest: GitHubPullRequest,
  ): Promise<GitHubPullRequestMergePolicyEvidence["reviews"] | undefined> {
    const response = await this.request(
      `branches/${encodeURIComponent(pullRequest.base)}/protection/required_pull_request_reviews`,
      "GET",
    );
    if (response.status === 404) return undefined;
    const value = record(responseBody(response, [200]));
    const required =
      typeof value.required_approving_review_count === "number" ? value.required_approving_review_count : 0;
    if (!Number.isSafeInteger(required) || required < 0) {
      throw new GitHubAppSemanticPullRequestProviderError("provider");
    }
    const reviews = parseReviews(
      responseBody(await this.request(`pulls/${numberPath(pullRequest.number)}/reviews?per_page=100`, "GET"), [200]),
    );
    const approved = new Set<string>();
    let changesRequested = false;
    for (const review of reviews) {
      if (review.state === "changes-requested") changesRequested = true;
      if (review.state === "approved" && review.author !== undefined) approved.add(review.author);
    }
    return {
      authoritative: true,
      satisfied: !changesRequested && approved.size >= required,
      requiredApprovals: required,
      approvals: approved.size,
    };
  }
}

function numberPath(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) throw new GitHubAppSemanticPullRequestProviderError("provider");
  return String(value);
}

export class GitHubAppSemanticPullRequestMutationExecutor implements SemanticPullRequestMutationExecutionPort {
  readonly #executor: LocalSemanticPullRequestMutationExecutor;

  constructor(options: { readonly transport: GitHubChangeEffectTransport; readonly repository: RepositoryIdentity }) {
    this.#executor = new LocalSemanticPullRequestMutationExecutor({
      adapter: new ScopedSemanticPullRequestProvider(options),
    });
  }

  execute(request: Parameters<SemanticPullRequestMutationExecutionPort["execute"]>[0]) {
    return this.#executor.execute(request);
  }
}

export function repositoryForSemanticPullRequest(
  repository: GitHubChangeEffectRepository,
  identity: RepositoryIdentity,
): RepositoryIdentity {
  if (
    repository.hostname.toLowerCase() !== identity.repositoryHost.toLowerCase() ||
    `${repository.owner}/${repository.name}` !== identity.nameWithOwner
  ) {
    throw new GitHubAppSemanticPullRequestProviderError("provider");
  }
  return identity;
}
