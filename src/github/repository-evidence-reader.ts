/**
 * Deployment-neutral GitHub Evidence Reader.
 *
 * This component owns bounded provider I/O and the validation needed to turn
 * GitHub responses into typed provider evidence. It deliberately does not
 * derive branch names, select semantic state, compile contracts, or plan
 * effects. Those responsibilities belong to the Core-facing state projector.
 */

import type { GitHubAppRepositoryReadTransport } from "./app-installation-credential-broker.js";
import type { GitHubChangeEffectRepository, GitHubChangeEffectResponse } from "./change-effect-adapter.js";
import type { ChangePullRequestEvidence } from "../change.js";
import type { GitHubOperationalPullRequestEvidence } from "./types.js";
import { INARI_ISSUER_PRINCIPAL } from "../issuer-identity.js";
import type { InariIssuerAppIdentity } from "./issuer-authority.js";
import { GitHubAdapter, type GitHubArtifactTransport } from "./adapter.js";
import {
  tryObserveOperationalPullRequest,
  type OperationalPullRequestObservation,
} from "../operational-observation.js";
import {
  attachGitHubProviderFailure,
  githubProviderFailure,
  githubProviderFailureFromStatus,
  readGitHubProviderFailure,
  type GitHubProviderFailureClassification,
} from "./provider-failure.js";

export const REPOSITORY_EVIDENCE_FAILURE_REASONS = Object.freeze([
  "repository-configuration",
  "repository-request",
  "repository-status",
  "repository-body",
  "repository-id",
  "repository-fork",
  "pull-request-evidence",
] as const);
export type RepositoryEvidenceFailureReason = (typeof REPOSITORY_EVIDENCE_FAILURE_REASONS)[number];

export function isRepositoryEvidenceFailureReason(value: unknown): value is RepositoryEvidenceFailureReason {
  return REPOSITORY_EVIDENCE_FAILURE_REASONS.includes(value as RepositoryEvidenceFailureReason);
}

export class GitHubRepositoryEvidenceReaderError extends Error {
  readonly code = "GITHUB_REPOSITORY_EVIDENCE_READ_FAILED" as const;
  readonly reason?: RepositoryEvidenceFailureReason;
  readonly providerFailure?: GitHubProviderFailureClassification;

  constructor(reason?: RepositoryEvidenceFailureReason, providerFailure?: GitHubProviderFailureClassification) {
    super("GitHub repository evidence read failed closed.");
    this.name = "GitHubRepositoryEvidenceReaderError";
    this.reason = reason;
    if (providerFailure !== undefined) {
      this.providerFailure = providerFailure;
      attachGitHubProviderFailure(this, providerFailure);
    }
  }
}

const MAX_BRANCH_MATCHES = 100;
const MAX_CANONICAL_PULL_REQUEST_MATCHES = 100;
const MAX_REPOSITORY_TEXT_LENGTH = 255;
const MAX_LOGIN_LENGTH = 160;
const MAX_TIMESTAMP_LENGTH = 64;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const GITHUB_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;

export interface GitHubRepositoryEvidenceReaderOptions {
  readonly repository: GitHubChangeEffectRepository;
  readonly repositoryId: string;
  readonly transport: GitHubAppRepositoryReadTransport;
  /** Explicit provider identity for the transport that supplies this evidence. */
  readonly providerPrincipal?: InariIssuerAppIdentity;
  readonly pullRequestNumber?: number;
}

export interface GitHubRepositoryEvidenceReaderProvenance {
  readonly providerPrincipal: InariIssuerAppIdentity;
  readonly repository: Readonly<{
    readonly host: string;
    readonly repositoryId: string;
  }>;
}

export interface GitHubRepositoryEvidence {
  readonly defaultBranch: string;
  readonly issue: GitHubRepositoryIssueEvidence;
  readonly branches: readonly GitHubRepositoryBranchEvidence[];
}

export interface GitHubRepositoryIssueEvidence {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly body: string | null | undefined;
}

/** Provider-normalized branch evidence; no root-Issue or desired-state claim. */
export interface GitHubRepositoryBranchEvidence {
  readonly name: string;
  readonly sha?: string;
}

/** Provider-normalized PR evidence; semantic root-Issue claims are absent. */
export interface GitHubRepositoryPullRequestEvidence extends ChangePullRequestEvidence {
  readonly observed?: boolean;
}

export interface GitHubRepositoryGovernanceTree {
  readonly sha: string;
  readonly entries: readonly { readonly path: string; readonly type: "blob" | "tree"; readonly sha: string }[];
}

function fail(reason?: RepositoryEvidenceFailureReason, providerFailure?: GitHubProviderFailureClassification): never {
  throw new GitHubRepositoryEvidenceReaderError(reason, providerFailure);
}

function invalidProviderResponse(): GitHubProviderFailureClassification {
  return githubProviderFailure("response-invalid", { retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, reason?: RepositoryEvidenceFailureReason): Record<string, unknown> {
  if (!isRecord(value)) fail(reason, invalidProviderResponse());
  return value;
}

function boundedString(value: unknown, maximum: number, reason?: RepositoryEvidenceFailureReason): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(reason);
  }
  return value;
}

function boundedArtifactBody(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_048_576 ||
    /[\u0000-\u0009\u000b-\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    fail();
  }
  return value;
}

function positiveNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail();
  return value;
}

function optionalCommitSha(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return value.type === "commit" && typeof value.sha === "string" && COMMIT_SHA_PATTERN.test(value.sha)
    ? value.sha.toLowerCase()
    : undefined;
}

function optionalPullRequestHeadSha(value: unknown): string | undefined {
  if (!isRecord(value) || value.sha === undefined) return undefined;
  return typeof value.sha === "string" && COMMIT_SHA_PATTERN.test(value.sha) ? value.sha.toLowerCase() : undefined;
}

function boundedGitHubTimestamp(value: unknown): string {
  const timestamp = boundedString(value, MAX_TIMESTAMP_LENGTH);
  const match = GITHUB_TIMESTAMP_PATTERN.exec(timestamp);
  if (match === null) fail();
  const date = new Date(timestamp);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6]);
  const milliseconds = Number((match[7] ?? "").padEnd(3, "0"));
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hours ||
    date.getUTCMinutes() !== minutes ||
    date.getUTCSeconds() !== seconds ||
    date.getUTCMilliseconds() !== milliseconds
  ) {
    fail();
  }
  return timestamp;
}

function mergedStateFromGitHubEvidence(value: unknown): boolean {
  if (value === null) return false;
  boundedGitHubTimestamp(value);
  return true;
}

function apiPath(repository: GitHubChangeEffectRepository, suffix: string): string {
  const base = `repos/${repository.owner}/${repository.name}`;
  return suffix === "" ? base : `${base}/${suffix}`;
}

export class GitHubRepositoryEvidenceReader {
  readonly #options: GitHubRepositoryEvidenceReaderOptions;
  readonly providerPrincipal: InariIssuerAppIdentity | undefined;
  readonly provenance: GitHubRepositoryEvidenceReaderProvenance | undefined;

  constructor(options: GitHubRepositoryEvidenceReaderOptions) {
    this.#options = options;
    this.providerPrincipal = options.providerPrincipal;
    this.provenance =
      options.providerPrincipal === undefined
        ? undefined
        : Object.freeze({
            providerPrincipal: options.providerPrincipal,
            repository: Object.freeze({
              host: options.repository.hostname,
              repositoryId: options.repositoryId,
            }),
          });
  }

  async readRepository(): Promise<{ readonly defaultBranch: string }> {
    const response = await this.request(apiPath(this.#options.repository, ""), "repository-request");
    if (response.status !== 200) {
      fail("repository-status", githubProviderFailureFromStatus(response.status, response.headers));
    }
    const body = record(response.body, "repository-body");
    if (String(body.id) !== this.#options.repositoryId) fail("repository-id");
    return { defaultBranch: boundedString(body.default_branch, MAX_REPOSITORY_TEXT_LENGTH, "repository-body") };
  }

  async readIssue(issueNumber: number): Promise<GitHubRepositoryIssueEvidence> {
    const response = await this.request(
      apiPath(this.#options.repository, `issues/${issueNumber}`),
      "repository-request",
    );
    if (response.status !== 200) {
      fail("repository-status", githubProviderFailureFromStatus(response.status, response.headers));
    }
    const issue = record(response.body, "repository-body");
    if (Object.prototype.hasOwnProperty.call(issue, "pull_request")) fail();
    const number = positiveNumber(issue.number);
    const title = boundedString(issue.title, MAX_REPOSITORY_TEXT_LENGTH);
    const state = issue.state === "open" || issue.state === "closed" ? issue.state : undefined;
    if (state === undefined || issueNumber !== number) fail();
    return { number, title, state, body: boundedArtifactBody(issue.body) };
  }

  async readBranch(branch: string): Promise<GitHubRepositoryBranchEvidence | undefined> {
    const response = await this.request(
      apiPath(this.#options.repository, `git/ref/heads/${encodeURIComponent(branch)}`),
      "repository-request",
    );
    if (response.status === 404) return undefined;
    if (response.status !== 200) {
      fail("repository-status", githubProviderFailureFromStatus(response.status, response.headers));
    }
    const value = record(response.body);
    if (value.ref !== `refs/heads/${branch}`) fail();
    return {
      name: branch,
      ...(optionalCommitSha(value.object) === undefined ? {} : { sha: optionalCommitSha(value.object) }),
    };
  }

  async readBranches(): Promise<readonly GitHubRepositoryBranchEvidence[]> {
    const response = await this.request(
      apiPath(this.#options.repository, "git/matching-refs/heads/"),
      "repository-request",
    );
    if (response.status === 404) return [];
    if (response.status !== 200) {
      fail("repository-status", githubProviderFailureFromStatus(response.status, response.headers));
    }
    if (!Array.isArray(response.body) || response.body.length >= MAX_BRANCH_MATCHES) {
      fail("repository-body", invalidProviderResponse());
    }
    return response.body.map((candidate) => {
      const value = record(candidate);
      const ref = boundedString(value.ref, 512);
      const prefix = "refs/heads/";
      if (!ref.startsWith(prefix)) fail();
      const name = ref.slice(prefix.length);
      const sha = optionalCommitSha(value.object);
      return { name, ...(sha === undefined ? {} : { sha }) };
    });
  }

  async readPullRequests(
    branches: readonly string[],
    baseBranch: string,
    pullRequestNumber?: number,
  ): Promise<readonly GitHubRepositoryPullRequestEvidence[]> {
    try {
      const pullRequests: GitHubRepositoryPullRequestEvidence[] = [];
      for (const branch of [...new Set(branches)].sort()) {
        const response = await this.request(
          apiPath(
            this.#options.repository,
            `pulls?state=all&head=${encodeURIComponent(`${this.#options.repository.owner}:${branch}`)}&base=${encodeURIComponent(baseBranch)}&per_page=${MAX_CANONICAL_PULL_REQUEST_MATCHES}`,
          ),
          "pull-request-evidence",
        );
        if (response.status !== 200) {
          fail("pull-request-evidence", githubProviderFailureFromStatus(response.status, response.headers));
        }
        if (!Array.isArray(response.body) || response.body.length >= MAX_CANONICAL_PULL_REQUEST_MATCHES) {
          fail("pull-request-evidence", invalidProviderResponse());
        }
        for (const candidate of response.body) {
          const parsed = this.parsePullRequestEvidence(candidate, branch, false);
          if (parsed !== undefined) pullRequests.push(parsed);
        }
      }

      if (pullRequestNumber !== undefined) {
        const response = await this.request(
          apiPath(this.#options.repository, `pulls/${pullRequestNumber}`),
          "pull-request-evidence",
        );
        if (response.status !== 200) {
          fail("pull-request-evidence", githubProviderFailureFromStatus(response.status, response.headers));
        }
        const observed = this.parsePullRequestEvidence(response.body, undefined, true);
        if (observed !== undefined && !pullRequests.some((candidate) => candidate.number === observed.number)) {
          pullRequests.push(observed);
        }
      }
      return pullRequests;
    } catch (error: unknown) {
      if (error instanceof GitHubRepositoryEvidenceReaderError && error.reason !== undefined) throw error;
      fail("pull-request-evidence");
    }
  }

  async readPullRequestBody(number: number): Promise<string | null | undefined> {
    const response = await this.request(apiPath(this.#options.repository, `pulls/${number}`), "pull-request-evidence");
    if (response.status !== 200) {
      fail("pull-request-evidence", githubProviderFailureFromStatus(response.status, response.headers));
    }
    const value = record(response.body);
    if (positiveNumber(value.number) !== number) fail("pull-request-evidence");
    return boundedArtifactBody(value.body);
  }

  /** Read normalized provider evidence used by review-bound authorities. */
  async readOperationalPullRequestEvidence(number: number): Promise<GitHubOperationalPullRequestEvidence> {
    try {
      const adapter = new GitHubAdapter({
        repository: `${this.#options.repository.owner}/${this.#options.repository.name}`,
        hostname: this.#options.repository.hostname,
        transport: this.#options.transport as unknown as GitHubArtifactTransport,
      });
      return await adapter.observePullRequest(number);
    } catch (error: unknown) {
      if (error instanceof GitHubRepositoryEvidenceReaderError && error.reason !== undefined) throw error;
      fail("pull-request-evidence");
    }
  }

  /** Read the full Operational Observation used by Implementation conformance. */
  async readOperationalPullRequest(number: number): Promise<OperationalPullRequestObservation> {
    try {
      const result = tryObserveOperationalPullRequest({
        pullRequest: await this.readOperationalPullRequestEvidence(number),
      });
      if (!result.valid || result.observation === undefined) fail("pull-request-evidence");
      return result.observation;
    } catch (error: unknown) {
      if (error instanceof GitHubRepositoryEvidenceReaderError && error.reason !== undefined) throw error;
      fail("pull-request-evidence");
    }
  }

  async readGovernanceTree(ref: string): Promise<GitHubRepositoryGovernanceTree> {
    const response = await this.request(
      apiPath(this.#options.repository, `git/trees/${encodeURIComponent(ref)}?recursive=1`),
      "repository-request",
    );
    if (response.status !== 200) {
      fail("repository-status", githubProviderFailureFromStatus(response.status, response.headers));
    }
    const value = record(response.body, "repository-body");
    const sha = boundedString(value.sha, MAX_REPOSITORY_TEXT_LENGTH);
    if (value.truncated !== false || !Array.isArray(value.tree) || value.tree.length > 2048) {
      fail("repository-body", invalidProviderResponse());
    }
    const entries = value.tree.map((entry) => {
      const candidate = record(entry);
      const type: "blob" | "tree" | undefined =
        candidate.type === "blob" || candidate.type === "tree" ? candidate.type : undefined;
      if (type === undefined) fail();
      return { path: boundedString(candidate.path, 512), type, sha: boundedString(candidate.sha, 255) };
    });
    return { sha, entries };
  }

  private async request(path: string, reason: RepositoryEvidenceFailureReason): Promise<GitHubChangeEffectResponse> {
    try {
      return await this.#options.transport.request({
        hostname: this.#options.repository.hostname,
        method: "GET",
        path,
      });
    } catch (error: unknown) {
      fail(reason, readGitHubProviderFailure(error));
    }
  }

  private parsePullRequestEvidence(
    candidate: unknown,
    expectedHead: string | undefined,
    observed: boolean,
  ): GitHubRepositoryPullRequestEvidence | undefined {
    const value = record(candidate, "pull-request-evidence");
    const head = record(value.head, "pull-request-evidence");
    const base = record(value.base, "pull-request-evidence");
    const user = record(value.user, "pull-request-evidence");
    const state = value.state === "open" || value.state === "closed" ? value.state : undefined;
    if (state === undefined || typeof value.draft !== "boolean") fail("pull-request-evidence");
    const number = positiveNumber(value.number);
    if (observed && this.#options.pullRequestNumber !== undefined && number !== this.#options.pullRequestNumber) {
      fail("pull-request-evidence");
    }
    const login = boundedString(user.login, MAX_LOGIN_LENGTH);
    const headName = boundedString(head.ref, MAX_REPOSITORY_TEXT_LENGTH);
    const headSha = optionalPullRequestHeadSha(head);
    if (expectedHead !== undefined && headName !== expectedHead) return undefined;
    if (head.repo !== undefined && head.repo !== null) {
      const headRepository = record(head.repo, "pull-request-evidence");
      if (headRepository.full_name !== `${this.#options.repository.owner}/${this.#options.repository.name}`)
        return undefined;
    }
    return {
      number,
      head: headName,
      ...(headSha === undefined ? {} : { headSha }),
      base: boundedString(base.ref, MAX_REPOSITORY_TEXT_LENGTH),
      state,
      draft: value.draft,
      ...(state === "closed" ? { merged: mergedStateFromGitHubEvidence(value.merged_at) } : { merged: false }),
      provenance: {
        issuer: login === "inari-issuer[bot]" || login === "inari-issuer" ? INARI_ISSUER_PRINCIPAL : login,
      },
      ...(observed ? { observed: true } : {}),
    };
  }
}
