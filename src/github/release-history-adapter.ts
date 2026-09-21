/**
 * Read-only GitHub implementation of the release-history evidence port.
 *
 * The adapter performs bounded REST reads and normalizes them into the
 * provider-neutral history contract. It does not create tags, releases,
 * commits, or files.
 */

import {
  GitHubAdapter,
  type GitHubApiResponse,
  type GitHubArtifactHttpMethod,
  type GitHubApiFieldValue,
} from "./adapter.js";
import type {
  ReleaseGovernedMergedChange,
  ReleaseHistoryEvidence,
  ReleaseHistoryEvidencePort,
  ReleaseHistoryReadOptions,
} from "../release-preparation-plan.js";

const MAX_TAGS = 100;
const MAX_COMMITS = 100;
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
}

export interface GitHubReleaseHistoryAdapterOptions {
  readonly adapter: GitHubReleaseHistoryApi;
}

interface ReleaseTagCandidate {
  readonly tag: string;
  readonly version: string;
  readonly object: Record<string, unknown>;
}

export class ReleaseHistoryAdapterError extends Error {
  readonly code = "RELEASE_HISTORY_UNAVAILABLE" as const;

  constructor(message: string) {
    super(message);
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

function sourceIssueNumbers(body: unknown): readonly number[] {
  if (typeof body !== "string") return [];
  const numbers = new Set<number>();
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9][0-9]*)\b/giu;
  for (const match of body.matchAll(pattern)) {
    const number = Number(match[1]);
    if (Number.isSafeInteger(number) && number > 0 && numbers.size < 32) numbers.add(number);
  }
  return [...numbers].sort((left, right) => left - right);
}

/** Read a bounded, deterministic release history from GitHub. */
export class GitHubReleaseHistoryAdapter implements ReleaseHistoryEvidencePort {
  readonly #adapter: GitHubReleaseHistoryApi;

  constructor(options: GitHubReleaseHistoryAdapterOptions | GitHubReleaseHistoryApi | GitHubAdapter) {
    this.#adapter = "adapter" in options ? options.adapter : options;
  }

  async readReleaseHistory(options: ReleaseHistoryReadOptions = {}): Promise<ReleaseHistoryEvidence> {
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

    const commitResponse = await this.#adapter.requestRepositoryApi(
      `commits/${encodeURIComponent(targetRevision)}?per_page=${MAX_COMMITS}`,
      "GET",
      {},
    );
    const commits = responseArray(commitResponse, "source commit", MAX_COMMITS);
    const reachable = new Set<string>([targetRevision]);
    for (const entry of commits) {
      if (isRecord(entry) && typeof entry.sha === "string" && SHA_PATTERN.test(entry.sha))
        reachable.add(entry.sha.toLowerCase());
    }
    if (!reachable.has(previousRevision))
      throw new ReleaseHistoryAdapterError("Previous release is outside the bounded source history.");

    const pullResponse = await this.#adapter.requestRepositoryApi(
      `pulls?state=closed&base=${encodeURIComponent(targetRef)}&per_page=${MAX_MERGED_CHANGES}`,
      "GET",
      {},
    );
    const pulls = responseArray(pullResponse, "merged pull request", MAX_MERGED_CHANGES);
    const changes: ReleaseGovernedMergedChange[] = [];
    const seenNumbers = new Set<number>();
    for (const entry of pulls) {
      if (!isRecord(entry) || !isRecord(entry.base)) continue;
      if (entry.base.ref !== targetRef || entry.merged_at === null || entry.merged_at === undefined) continue;
      if (typeof entry.number !== "number" || !Number.isSafeInteger(entry.number) || entry.number < 1) continue;
      if (seenNumbers.has(entry.number))
        throw new ReleaseHistoryAdapterError("Merged history contains duplicate pull requests.");
      const mergeShaValue = entry.merge_commit_sha;
      if (typeof mergeShaValue !== "string" || !SHA_PATTERN.test(mergeShaValue)) continue;
      const mergeSha = mergeShaValue.toLowerCase();
      if (!reachable.has(mergeSha)) continue;
      const mergedAt = boundedText(entry.merged_at, `pull request #${entry.number} merge time`, 64);
      if (!mergedAt.endsWith("Z") || !Number.isFinite(Date.parse(mergedAt)))
        throw new ReleaseHistoryAdapterError(`Pull request #${entry.number} merge time is invalid.`);
      const title = boundedText(entry.title, `pull request #${entry.number} title`, 512);
      changes.push({
        number: entry.number,
        title,
        mergeCommitSha: mergeSha,
        mergedAt,
        governed: true,
        sourceIssueNumbers: sourceIssueNumbers(entry.body),
      });
      seenNumbers.add(entry.number);
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
