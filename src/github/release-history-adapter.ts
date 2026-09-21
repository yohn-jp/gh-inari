/**
 * Read-only GitHub implementation of the release-history evidence port.
 *
 * Release history is derived from GitHub's compare contract and the
 * commit-associated pull-request endpoint. The adapter never infers release
 * membership from a list of merged pull requests and never mutates GitHub.
 */

import {
  GitHubAdapter,
  type GitHubApiResponse,
  type GitHubArtifactHttpMethod,
  type GitHubApiFieldValue,
} from "./adapter.js";
import type { RepositoryContext, RepositoryTree, GitHubPullRequest } from "./types.js";
import type {
  ReleaseGovernedMergedChange,
  ReleaseHistoryEvidence,
  ReleaseHistoryEvidencePort,
  ReleaseHistoryReadOptions,
} from "../release-preparation-plan.js";
import {
  admitReleasePullRequest,
  createReleaseHistoryGovernanceReader,
  ReleaseHistoryGovernanceError,
  type ReleaseHistoryGovernanceReader,
} from "../release-history-governance.js";

const MAX_TAGS = 100;
const MAX_COMMITS = 100;
const MAX_ASSOCIATED_PULL_REQUESTS = 100;
const MAX_MERGED_CHANGES = 100;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const SHA_PATTERN = /^[0-9a-f]{7,128}$/iu;
const RELEASE_TAG_PATTERN =
  /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export interface GitHubReleaseHistoryApi {
  requestRepositoryApi(
    repositoryPath: string,
    method?: GitHubArtifactHttpMethod,
    fields?: Readonly<Record<string, GitHubApiFieldValue>>,
  ): Promise<GitHubApiResponse>;
  getRepositoryDefaultBranch(): Promise<string>;
  findBranch(
    branch: string,
  ): Promise<{ readonly name: string; readonly ref: string; readonly sha: string } | undefined>;
  /** Existing adapter methods are optional so read-only test transports can provide raw REST responses. */
  resolveRepositoryContext?: () => Promise<RepositoryContext>;
  getRepositoryContext?: () => Promise<RepositoryContext>;
  getRepositoryTree?: (ref: string) => Promise<RepositoryTree>;
  getRepositoryBlob?: (sha: string) => Promise<string>;
}

export interface GitHubReleaseHistoryAdapterOptions {
  readonly adapter: GitHubReleaseHistoryApi;
  /** Explicit repository identity for bounded semantic relation observation. */
  readonly repository?: RepositoryContext;
}

interface ReleaseTagCandidate {
  readonly tag: string;
  readonly version: string;
  readonly object: Record<string, unknown>;
}

interface CompareCommit {
  readonly sha: string;
}

interface AssociatedPullRequest {
  readonly number: number;
  readonly commitSha: string;
}

export class ReleaseHistoryAdapterError extends Error {
  readonly code = "RELEASE_HISTORY_UNAVAILABLE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReleaseHistoryAdapterError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !SAFE_TEXT.test(value))
    throw new ReleaseHistoryAdapterError(`GitHub returned invalid ${label}.`);
  return value;
}

function boundedBody(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_048_576 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  )
    throw new ReleaseHistoryAdapterError(`GitHub returned invalid ${label}.`);
  return value;
}

function sha(value: unknown, label: string): string {
  const result = boundedText(value, label, 128);
  if (!SHA_PATTERN.test(result)) throw new ReleaseHistoryAdapterError(`GitHub returned invalid ${label}.`);
  return result.toLowerCase();
}

function versionFromTag(tag: string): string | undefined {
  const candidate = tag.startsWith("v") ? tag.slice(1) : tag;
  return RELEASE_TAG_PATTERN.test(tag) ? candidate : undefined;
}

function compareVersions(left: string, right: string): number {
  const leftNumbers = left.split(/[.+-]/u)[0]?.split(".").map(Number) ?? [];
  const rightNumbers = right.split(/[.+-]/u)[0]?.split(".").map(Number) ?? [];
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftNumbers[index] ?? 0) - (rightNumbers[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right, "en-US");
}

function hasNextPage(response: GitHubApiResponse): boolean {
  return response.headers?.link?.includes('rel="next"') === true;
}

function assertSuccessful(response: GitHubApiResponse, label: string): void {
  if (response.status < 200 || response.status >= 300)
    throw new ReleaseHistoryAdapterError(`GitHub ${label} read failed with status ${response.status}.`);
}

function responseArray(response: GitHubApiResponse, label: string, maximum: number): readonly unknown[] {
  assertSuccessful(response, label);
  if (!Array.isArray(response.body) || response.body.length > maximum || hasNextPage(response))
    throw new ReleaseHistoryAdapterError(`GitHub ${label} history is unavailable or truncated.`);
  return response.body;
}

function tagCandidates(body: readonly unknown[]): readonly ReleaseTagCandidate[] {
  const candidates: ReleaseTagCandidate[] = [];
  for (const entry of body) {
    if (!isRecord(entry)) continue;
    const rawRef = typeof entry.ref === "string" ? entry.ref : typeof entry.name === "string" ? entry.name : undefined;
    if (rawRef === undefined) continue;
    const tag = rawRef.startsWith("refs/tags/") ? rawRef.slice("refs/tags/".length) : rawRef;
    const version = versionFromTag(tag);
    if (version === undefined || !isRecord(entry.object)) continue;
    candidates.push({ tag, version, object: entry.object });
  }
  return candidates;
}

async function tagSourceRevision(adapter: GitHubReleaseHistoryApi, candidate: ReleaseTagCandidate): Promise<string> {
  const objectType = candidate.object.type;
  if (objectType === "commit") return sha(candidate.object.sha, `tag ${candidate.tag} commit`);
  if (objectType !== "tag")
    throw new ReleaseHistoryAdapterError(`Tag ${candidate.tag} is not a commit or annotated tag.`);
  const tagSha = sha(candidate.object.sha, `tag ${candidate.tag} object`);
  const response = await adapter.requestRepositoryApi(`git/tags/${encodeURIComponent(tagSha)}`, "GET", {});
  assertSuccessful(response, `annotated tag ${candidate.tag}`);
  if (!isRecord(response.body) || !isRecord(response.body.object) || response.body.object.type !== "commit")
    throw new ReleaseHistoryAdapterError(`Annotated tag ${candidate.tag} does not resolve to a commit.`);
  return sha(response.body.object.sha, `tag ${candidate.tag} commit`);
}

function parseCompare(
  response: GitHubApiResponse,
  previousRevision: string,
  targetRevision: string,
): readonly CompareCommit[] {
  assertSuccessful(response, "release compare");
  if (hasNextPage(response))
    throw new ReleaseHistoryAdapterError("GitHub release compare history is unavailable or truncated.");
  if (!isRecord(response.body)) throw new ReleaseHistoryAdapterError("GitHub release compare response is invalid.");
  const body = response.body;
  if (body.status !== "ahead" && body.status !== "identical")
    throw new ReleaseHistoryAdapterError("Previous release is not an ancestor of the target source.");
  if (body.behind_by !== 0 || typeof body.ahead_by !== "number" || !Number.isSafeInteger(body.ahead_by))
    throw new ReleaseHistoryAdapterError("GitHub release compare ancestry evidence is invalid.");
  if (!isRecord(body.base_commit) || !isRecord(body.merge_base_commit))
    throw new ReleaseHistoryAdapterError("GitHub release compare ancestry evidence is unavailable.");
  if (sha(body.base_commit.sha, "compare base revision") !== previousRevision)
    throw new ReleaseHistoryAdapterError("GitHub release compare base does not match the previous release.");
  if (sha(body.merge_base_commit.sha, "compare merge base revision") !== previousRevision)
    throw new ReleaseHistoryAdapterError("Previous release is not the compare merge base.");
  if (!Array.isArray(body.commits)) throw new ReleaseHistoryAdapterError("GitHub release compare commits are invalid.");
  if (typeof body.total_commits !== "number" || !Number.isSafeInteger(body.total_commits) || body.total_commits < 0)
    throw new ReleaseHistoryAdapterError("GitHub release compare cardinality is invalid.");
  if (
    body.total_commits > MAX_COMMITS ||
    body.commits.length > MAX_COMMITS ||
    body.commits.length !== body.total_commits
  )
    throw new ReleaseHistoryAdapterError("GitHub release compare history is unavailable or truncated.");
  if (body.status === "identical" && (targetRevision !== previousRevision || body.total_commits !== 0))
    throw new ReleaseHistoryAdapterError("GitHub release compare identical-range evidence is invalid.");
  const commits: CompareCommit[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of body.commits.entries()) {
    if (!isRecord(entry)) throw new ReleaseHistoryAdapterError(`GitHub compare commit ${index} is invalid.`);
    const commitSha = sha(entry.sha, `compare commit ${index}`);
    if (commitSha === previousRevision || seen.has(commitSha))
      throw new ReleaseHistoryAdapterError("GitHub release compare contains an invalid duplicate/base commit.");
    seen.add(commitSha);
    commits.push({ sha: commitSha });
  }
  return commits;
}

function pullRequestNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new ReleaseHistoryAdapterError(`GitHub returned invalid ${label}.`);
  return value;
}

function associatedPullRequests(response: GitHubApiResponse, commitSha: string): readonly AssociatedPullRequest[] {
  const entries = responseArray(response, `commit ${commitSha} associated pull requests`, MAX_ASSOCIATED_PULL_REQUESTS);
  const unique = new Map<number, AssociatedPullRequest>();
  for (const entry of entries) {
    if (!isRecord(entry)) throw new ReleaseHistoryAdapterError("GitHub associated pull-request evidence is invalid.");
    const number = pullRequestNumber(entry.number, "associated pull request number");
    if (!unique.has(number)) unique.set(number, { number, commitSha });
  }
  if (unique.size !== 1)
    throw new ReleaseHistoryAdapterError(
      unique.size === 0
        ? `Compare commit ${commitSha} has no associated pull request.`
        : `Compare commit ${commitSha} has conflicting associated pull requests.`,
    );
  return [...unique.values()];
}

function parseRepositoryTreeResponse(response: GitHubApiResponse, ref: string): RepositoryTree {
  assertSuccessful(response, `repository governance tree at ${ref}`);
  if (!isRecord(response.body) || typeof response.body.sha !== "string" || !Array.isArray(response.body.tree))
    throw new ReleaseHistoryAdapterError("GitHub repository governance tree response is invalid.");
  const entries: RepositoryTree["entries"] = response.body.tree.map((entry): RepositoryTree["entries"][number] => {
    if (!isRecord(entry) || typeof entry.path !== "string" || (entry.type !== "blob" && entry.type !== "tree"))
      throw new ReleaseHistoryAdapterError("GitHub repository governance tree entry is invalid.");
    return { path: entry.path, type: entry.type, sha: sha(entry.sha, `repository governance entry ${entry.path}`) };
  });
  return { sha: sha(response.body.sha, "repository governance tree"), entries };
}

async function repositoryContext(
  api: GitHubReleaseHistoryApi,
  explicit?: RepositoryContext,
): Promise<RepositoryContext> {
  if (explicit !== undefined) return explicit;
  const context = await (api.resolveRepositoryContext?.() ?? api.getRepositoryContext?.());
  if (context === undefined)
    throw new ReleaseHistoryAdapterError("Repository identity is unavailable for governance evidence.");
  return context;
}

function pullRequestFromResponse(value: unknown, label: string): GitHubPullRequest {
  if (!isRecord(value)) throw new ReleaseHistoryAdapterError(`GitHub ${label} response is invalid.`);
  const number = pullRequestNumber(value.number, `${label} number`);
  const title = boundedText(value.title, `${label} title`);
  const body = value.body === null ? null : boundedBody(value.body, `${label} body`);
  const state = value.state === "open" || value.state === "closed" ? value.state : undefined;
  if (state === undefined) throw new ReleaseHistoryAdapterError(`GitHub ${label} state is invalid.`);
  const url = boundedText(value.html_url ?? value.url, `${label} URL`, 2_048);
  const head = isRecord(value.head) ? boundedText(value.head.ref, `${label} head ref`) : "unknown";
  const base = isRecord(value.base) ? boundedText(value.base.ref, `${label} base ref`) : "unknown";
  const draft = value.draft === undefined ? false : value.draft;
  if (typeof draft !== "boolean") throw new ReleaseHistoryAdapterError(`GitHub ${label} draft state is invalid.`);
  const mergedAt =
    value.merged_at === null || value.merged_at === undefined
      ? null
      : boundedText(value.merged_at, `${label} merge time`, 64);
  if (mergedAt !== null && (!mergedAt.endsWith("Z") || !Number.isFinite(Date.parse(mergedAt))))
    throw new ReleaseHistoryAdapterError(`GitHub ${label} merge time is invalid.`);
  const merged = value.merged === undefined ? mergedAt !== null : value.merged;
  if (typeof merged !== "boolean") throw new ReleaseHistoryAdapterError(`GitHub ${label} merged state is invalid.`);
  const mergeCommitSha =
    value.merge_commit_sha === null || value.merge_commit_sha === undefined
      ? null
      : sha(value.merge_commit_sha, `${label} merge revision`);
  return {
    number,
    title,
    body,
    state,
    url,
    draft,
    head,
    base,
    ...(isRecord(value.head) && value.head.sha !== undefined
      ? { headSha: sha(value.head.sha, `${label} head revision`) }
      : {}),
    ...(isRecord(value.base) && value.base.sha !== undefined
      ? { baseSha: sha(value.base.sha, `${label} base revision`) }
      : {}),
    ...(value.maintainer_can_modify === undefined
      ? {}
      : { maintainerCanModify: value.maintainer_can_modify as boolean }),
    ...(value.labels === undefined
      ? {}
      : {
          labels: Array.isArray(value.labels)
            ? value.labels.map((entry) => boundedText(isRecord(entry) ? entry.name : entry, `${label} label`))
            : [],
        }),
    ...(value.assignees === undefined
      ? {}
      : {
          assignees: Array.isArray(value.assignees)
            ? value.assignees.map((entry) => boundedText(isRecord(entry) ? entry.login : entry, `${label} assignee`))
            : [],
        }),
    merged,
    mergedAt,
    mergeCommitSha,
  };
}

function governanceReader(
  api: GitHubReleaseHistoryApi,
  targetRef: string,
  context: RepositoryContext,
): ReleaseHistoryGovernanceReader {
  return createReleaseHistoryGovernanceReader({
    context,
    targetRef,
    getRepositoryTree: async (ref) => {
      if (api.getRepositoryTree !== undefined) return api.getRepositoryTree(ref);
      return parseRepositoryTreeResponse(
        await api.requestRepositoryApi(`git/trees/${encodeURIComponent(ref)}?recursive=1`, "GET", {}),
        ref,
      );
    },
    getRepositoryBlob: async (blobSha) => {
      if (api.getRepositoryBlob !== undefined) return api.getRepositoryBlob(blobSha);
      const response = await api.requestRepositoryApi(`git/blobs/${encodeURIComponent(blobSha)}`, "GET", {});
      assertSuccessful(response, `repository governance blob ${blobSha}`);
      if (!isRecord(response.body) || response.body.encoding !== "base64" || typeof response.body.content !== "string")
        throw new ReleaseHistoryAdapterError("GitHub repository governance blob response is invalid.");
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(response.body.content.replace(/\s+/gu, ""), "base64"),
        );
      } catch (error: unknown) {
        throw new ReleaseHistoryAdapterError("GitHub repository governance blob is not valid UTF-8.", { cause: error });
      }
    },
  });
}

/** Read a bounded, deterministic release history from GitHub. */
export class GitHubReleaseHistoryAdapter implements ReleaseHistoryEvidencePort {
  readonly #adapter: GitHubReleaseHistoryApi;
  readonly #repository?: RepositoryContext;

  constructor(options: GitHubReleaseHistoryAdapterOptions | GitHubReleaseHistoryApi | GitHubAdapter) {
    if ("adapter" in options) {
      this.#adapter = options.adapter;
      this.#repository = options.repository;
    } else this.#adapter = options;
  }

  async readReleaseHistory(options: ReleaseHistoryReadOptions = {}): Promise<ReleaseHistoryEvidence> {
    try {
      return await this.#readReleaseHistory(options);
    } catch (error: unknown) {
      if (error instanceof ReleaseHistoryAdapterError) throw error;
      if (error instanceof ReleaseHistoryGovernanceError)
        throw new ReleaseHistoryAdapterError(error.message, { cause: error });
      throw new ReleaseHistoryAdapterError(error instanceof Error ? error.message : "Release history is unavailable.", {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async #readReleaseHistory(options: ReleaseHistoryReadOptions): Promise<ReleaseHistoryEvidence> {
    const targetRef = options.targetRef ?? (await this.#adapter.getRepositoryDefaultBranch());
    if (typeof targetRef !== "string" || targetRef.length === 0 || !SAFE_TEXT.test(targetRef))
      throw new ReleaseHistoryAdapterError("Target source ref is invalid.");
    const targetBranch = await this.#adapter.findBranch(targetRef);
    if (targetBranch === undefined)
      throw new ReleaseHistoryAdapterError(`Target source ref ${targetRef} was not found.`);
    const targetRevision = sha(targetBranch.sha, "target source revision");

    const tagResponse = await this.#adapter.requestRepositoryApi("git/refs/tags?per_page=100", "GET", {});
    const candidates = [...tagCandidates(responseArray(tagResponse, "release tags", MAX_TAGS))];
    if (candidates.length === 0) throw new ReleaseHistoryAdapterError("No semantic release tag was found.");
    candidates.sort(
      (left, right) => compareVersions(right.version, left.version) || left.tag.localeCompare(right.tag, "en-US"),
    );
    const highestVersion = candidates[0]?.version;
    if (highestVersion === undefined) throw new ReleaseHistoryAdapterError("No semantic release tag was found.");
    const highest = candidates.filter((candidate) => candidate.version === highestVersion);
    if (highest.length !== 1)
      throw new ReleaseHistoryAdapterError("Release history has ambiguous highest semantic tags.");
    const previous = highest[0] as ReleaseTagCandidate;
    const previousRevision = await tagSourceRevision(this.#adapter, previous);

    const compareResponse = await this.#adapter.requestRepositoryApi(
      `compare/${encodeURIComponent(previousRevision)}...${encodeURIComponent(targetRevision)}?per_page=${MAX_COMMITS}`,
      "GET",
      {},
    );
    const commits = parseCompare(compareResponse, previousRevision, targetRevision);
    if (commits.length === 0) {
      return Object.freeze({
        previousRelease: Object.freeze({
          tag: previous.tag,
          version: previous.version,
          sourceRevision: previousRevision,
        }),
        targetSource: Object.freeze({ ref: targetRef, sourceRevision: targetRevision }),
        includedChanges: Object.freeze([]),
      });
    }

    const associated = new Map<number, AssociatedPullRequest>();
    for (const commit of commits) {
      const response = await this.#adapter.requestRepositoryApi(
        `commits/${encodeURIComponent(commit.sha)}/pulls?per_page=${MAX_ASSOCIATED_PULL_REQUESTS}`,
        "GET",
        {},
      );
      for (const item of associatedPullRequests(response, commit.sha)) {
        const prior = associated.get(item.number);
        if (prior !== undefined && prior.commitSha !== item.commitSha) continue;
        associated.set(item.number, item);
      }
    }
    if (associated.size === 0 || associated.size > MAX_MERGED_CHANGES)
      throw new ReleaseHistoryAdapterError("Release history has unavailable or excessive associated pull requests.");

    const context = await repositoryContext(this.#adapter, this.#repository);
    const governance = governanceReader(this.#adapter, targetRef, context);
    const changes: ReleaseGovernedMergedChange[] = [];
    for (const item of associated.values()) {
      const response = await this.#adapter.requestRepositoryApi(`pulls/${item.number}`, "GET", {});
      const pullRequest = pullRequestFromResponse(response.body, `pull request #${item.number}`);
      if (pullRequest.number !== item.number)
        throw new ReleaseHistoryAdapterError(`GitHub pull request association #${item.number} is inconsistent.`);
      if (pullRequest.base !== targetRef || pullRequest.merged !== true || pullRequest.mergedAt === null)
        throw new ReleaseHistoryAdapterError(`Pull request #${item.number} is not an admissible merged target change.`);
      const admitted = await admitReleasePullRequest({
        pullRequest,
        mergeCommitSha: item.commitSha,
        repository: context,
        governance,
      });
      changes.push(admitted);
    }
    changes.sort((left, right) => left.mergedAt.localeCompare(right.mergedAt, "en-US") || left.number - right.number);
    return Object.freeze({
      previousRelease: Object.freeze({
        tag: previous.tag,
        version: previous.version,
        sourceRevision: previousRevision,
      }),
      targetSource: Object.freeze({ ref: targetRef, sourceRevision: targetRevision }),
      includedChanges: Object.freeze(changes.map((change) => Object.freeze(change))),
    });
  }
}

export const ReleaseHistoryGitHubAdapter = GitHubReleaseHistoryAdapter;
