import { constants as fsConstants } from "node:fs";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ContractViolationError,
  GhNotInstalledError,
  GhUnauthenticatedError,
  GitHubAdapterError,
  GitHubApiError,
  GitHubApiResponseError,
  GitHubOutputLimitError,
  GitHubResourceKindMismatchError,
  GitHubTimeoutError,
  GitHubTransportError,
  InvalidRepositoryOverrideError,
  RepositoryResolutionError,
} from "./errors.js";
import {
  isTrustedSemanticIssueArtifact,
  isTrustedSemanticPullRequestArtifact,
  isTrustedValidatedRenderedArtifact,
} from "./capability.js";
import {
  DEFAULT_GH_OUTPUT_LIMITS_BYTES,
  GhTransportOutputLimitError,
  GhTransportTimeoutError,
  ProcessGhTransport,
  type GhCommandResult,
  type GhTransport,
  type GhTransportOutputLimits,
} from "./transport.js";
import {
  VALIDATED_RENDERED_PHASE,
  type GitHubIssue,
  type GitHubOperationalActor,
  type GitHubOperationalChangedFile,
  type GitHubOperationalCheck,
  type GitHubOperationalCollection,
  type GitHubOperationalComment,
  type GitHubOperationalIssueEvidence,
  type GitHubOperationalPagination,
  type GitHubOperationalProvenance,
  type GitHubOperationalPullRequestEvidence,
  type GitHubOperationalRepository,
  type GitHubOperationalReview,
  type GitHubBranch,
  type GitHubMilestone,
  type GitHubPullRequest,
  type GitHubReviewRequests,
  type RepositoryContext,
  type RepositoryTree,
  type RepositoryTreeEntry,
  type ValidatedRenderedIssueArtifact,
  type ValidatedRenderedPullRequestArtifact,
  type ValidatedSemanticPullRequestArtifact,
  type ValidatedSemanticIssueArtifact,
} from "./types.js";

const DEFAULT_HOSTNAME = "github.com";
const MAX_ACTIONS_ARTIFACT_BYTES = 1_048_576;
const MAX_PULL_REQUEST_LIST_ITEMS = 100;
const OPERATIONAL_PAGE_SIZE = 100;
const OPERATIONAL_MAX_PAGES = 10;
const OPERATIONAL_MAX_ITEMS = OPERATIONAL_PAGE_SIZE * OPERATIONAL_MAX_PAGES;
const UNAUTHENTICATED_MESSAGE_PATTERN = /not logged in|authentication failed|login required|status code 401|\b401\b/iu;

/** Bounded gh CLI timeouts by operation class. Real adapter calls always run under one of these. */
export type GhOperationClass = "auth" | "repositoryResolution" | "read" | "mutation";

export const DEFAULT_GH_TIMEOUTS_MS: Readonly<Record<GhOperationClass, number>> = Object.freeze({
  auth: 10_000,
  repositoryResolution: 15_000,
  read: 20_000,
  mutation: 30_000,
});

const OPERATION_CLASSES: Readonly<Record<string, GhOperationClass>> = Object.freeze({
  "gh.version": "auth",
  "auth.status": "auth",
  "repository.resolve": "repositoryResolution",
  "repository.default_branch": "read",
  "repository.governance.tree": "read",
  "repository.governance.blob": "read",
  "auth.identity": "auth",
  "actions.request": "mutation",
  "actions.artifact.download": "read",
  "issue.read": "read",
  "issue.observe": "read",
  "pull_request.read": "read",
  "pull_request.observe": "read",
  "pull_request.review_decision": "read",
  "operational.collection.read": "read",
  "issue.create": "mutation",
  "issue.update": "mutation",
  "issue.relation.read": "read",
  "issue.relation.mutate": "mutation",
  "pull_request.create": "mutation",
  "pull_request.update": "mutation",
  "branch.read": "read",
  "branch.create": "mutation",
});

function operationClass(operation: string): GhOperationClass {
  const operationClassValue = OPERATION_CLASSES[operation];
  if (operationClassValue === undefined) {
    throw new Error(`No timeout class registered for gh operation "${operation}".`);
  }
  return operationClassValue;
}

/**
 * Rejects invalid overrides outright instead of silently disabling a bound: an
 * explicit `{ auth: undefined }` would otherwise erase the default via spread,
 * and non-finite or non-positive values would produce an unbounded or
 * effectively immediate timer.
 */
function validatedTimeoutOverrides(
  overrides: Partial<Record<GhOperationClass, number>> | undefined,
): Partial<Record<GhOperationClass, number>> {
  if (overrides === undefined) return {};
  const validated: Partial<Record<GhOperationClass, number>> = {};
  for (const [operationClassKey, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) {
      throw new ContractViolationError(
        `Timeout override for "${operationClassKey}" must be a finite number greater than zero.`,
        `timeoutsMs.${operationClassKey}`,
      );
    }
    validated[operationClassKey as GhOperationClass] = value;
  }
  return validated;
}

function validatedOutputLimitOverrides(
  overrides: Partial<GhTransportOutputLimits> | undefined,
): Partial<GhTransportOutputLimits> {
  if (overrides === undefined) return {};
  const validated: Partial<Record<keyof GhTransportOutputLimits, number>> = {};
  for (const [stream, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ContractViolationError(
        `Output limit for "${stream}" must be a finite non-negative integer.`,
        `outputLimitsBytes.${stream}`,
      );
    }
    validated[stream as keyof GhTransportOutputLimits] = value;
  }
  return validated;
}

export interface GitHubAdapterOptions {
  /** Working directory used by gh for local repository resolution. */
  readonly cwd?: string;
  /** owner/name, host/owner/name, or a repository URL. */
  readonly repository?: string;
  /** Hostname used with an owner/name override or gh auth status. */
  readonly hostname?: string;
  /** Injectable command transport for tests and alternate local execution. */
  readonly transport?: GhTransport;
  /** Overrides for the default bounded timeout (ms) per gh operation class. */
  readonly timeoutsMs?: Partial<Record<GhOperationClass, number>>;
  /** Overrides for the default bounded stdout/stderr byte limits for every gh operation. */
  readonly outputLimitsBytes?: Partial<GhTransportOutputLimits>;
}

export interface GitHubApiResponse {
  readonly status: number;
  readonly body: unknown;
  /** Lower-cased response headers retained only for bounded pagination. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Bounded values accepted by the repository API seam for JSON request fields. */
export type GitHubApiFieldValue = string | number | boolean;

export class GitHubAdapter {
  private readonly cwd: string | undefined;
  private readonly repository: string | undefined;
  private readonly hostname: string | undefined;
  private readonly transport: GhTransport;
  private readonly executable: string;
  private readonly timeoutsMs: Readonly<Record<GhOperationClass, number>>;
  private readonly outputLimitsBytes: Readonly<GhTransportOutputLimits>;
  private availablePromise: Promise<void> | undefined;
  private contextPromise: Promise<RepositoryContext> | undefined;
  private readonly authenticatedHostnames = new Set<string | undefined>();
  private readonly authenticationPromises = new Map<string | undefined, Promise<void>>();

  constructor(options: GitHubAdapterOptions = {}) {
    this.cwd = options.cwd;
    this.repository = options.repository;
    this.hostname = options.hostname;
    this.transport = options.transport ?? new ProcessGhTransport();
    this.executable = this.transport instanceof ProcessGhTransport ? this.transport.executable : "gh";
    this.timeoutsMs = Object.freeze({ ...DEFAULT_GH_TIMEOUTS_MS, ...validatedTimeoutOverrides(options.timeoutsMs) });
    this.outputLimitsBytes = Object.freeze({
      ...DEFAULT_GH_OUTPUT_LIMITS_BYTES,
      ...validatedOutputLimitOverrides(options.outputLimitsBytes),
    });
  }

  async checkAuthentication(): Promise<void> {
    await this.ensureGhAvailable();
    await this.ensureAuthenticated(this.repositoryHostOverride());
  }

  /** Read the login attached to the caller's existing gh session. */
  async getAuthenticatedUser(): Promise<string> {
    const context = await this.resolveRepositoryContext();
    const result = await this.runApi(
      ["api", "user", "--hostname", context.hostname, "--method", "GET"],
      "auth.identity",
    );
    const record = responseRecord(result, "auth.identity");
    const login = responseString(record.login, "login", "auth.identity");
    if (!/^[A-Za-z0-9-]{1,39}$/u.test(login)) {
      throw new GitHubApiResponseError("auth.identity", "GitHub returned an invalid authenticated user identity.");
    }
    return login;
  }

  async resolveRepositoryContext(): Promise<RepositoryContext> {
    if (this.contextPromise === undefined) {
      const pending = this.resolveRepositoryContextOnce();
      this.contextPromise = pending;
      pending.catch(() => {
        if (this.contextPromise === pending) this.contextPromise = undefined;
      });
    }
    return this.contextPromise;
  }

  async getRepositoryContext(): Promise<RepositoryContext> {
    return this.resolveRepositoryContext();
  }

  /**
   * Request the fixed Actions API surface used by the Change transport.
   * Callers supply only an adapter-owned relative Actions path and bounded form
   * fields; repository, host, and authentication remain resolved here.
   */
  async requestActionsApi(
    actionsPath: string,
    method: "GET" | "POST",
    fields: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    assertActionsApiPath(actionsPath);
    const context = await this.resolveRepositoryContext();
    const args = this.apiArguments(context, `repos/${context.nameWithOwner}/${actionsPath}`, method);
    for (const [name, value] of Object.entries(fields)) appendRawField(args, name, value);
    return this.runApi(args, "actions.request");
  }

  /** Read the bounded repository API surface needed by Change projection. */
  async requestRepositoryApi(
    repositoryPath: string,
    method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
    fields: Readonly<Record<string, GitHubApiFieldValue>> = {},
  ): Promise<GitHubApiResponse> {
    const context = await this.resolveRepositoryContext();
    return this.requestRepositoryApiAt(context.nameWithOwner, context.hostname, repositoryPath, method, fields);
  }

  private async requestRepositoryApiAt(
    nameWithOwner: string,
    hostname: string,
    repositoryPath: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    fields: Readonly<Record<string, GitHubApiFieldValue>>,
  ): Promise<GitHubApiResponse> {
    assertRepositoryApiPath(repositoryPath);
    const operation = method === "GET" ? "issue.relation.read" : "issue.relation.mutate";
    const args = [
      "api",
      `repos/${nameWithOwner}${repositoryPath === "" ? "" : `/${repositoryPath}`}`,
      "--hostname",
      hostname,
      "--method",
      method,
      "--include",
    ];
    for (const [name, value] of Object.entries(fields)) appendRepositoryApiField(args, name, value);
    const result = await this.runCommand(args, operation);
    const response = parseIncludedApiResponse(result.stdout, operation);
    if (response !== undefined) {
      if (response.status !== 404 && (response.status < 200 || response.status >= 300)) {
        throw new GitHubApiError(operation, "GitHub repository API request failed.");
      }
      return response;
    }
    if (result.exitCode !== 0) throw new GitHubApiError(operation, "GitHub repository API request failed.");
    throw new GitHubApiResponseError(operation, "GitHub returned no API response.");
  }

  /** Download one bounded Actions artifact archive through the caller's gh session. */
  async downloadActionsArtifact(artifactId: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(artifactId) || artifactId < 1) {
      throw new ContractViolationError("Actions artifact ID must be a positive integer.", "artifactId");
    }
    const context = await this.resolveRepositoryContext();
    const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-actions-"));
    const destination = path.join(directory, "artifact.zip");
    let handle: FileHandle | undefined;
    try {
      const result = await this.runCommand(
        [
          "api",
          `repos/${context.nameWithOwner}/actions/artifacts/${artifactId}/zip`,
          "--hostname",
          context.hostname,
          "--method",
          "GET",
          "--output",
          destination,
        ],
        "actions.artifact.download",
      );
      if (result.exitCode !== 0) {
        throw new GitHubApiError("actions.artifact.download", "GitHub Actions artifact download failed.");
      }
      try {
        handle = await open(destination, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > MAX_ACTIONS_ARTIFACT_BYTES) {
          throw new GitHubApiResponseError("actions.artifact.download", "GitHub returned an invalid Actions artifact.");
        }
        return new Uint8Array(await readBoundedActionsArtifact(handle));
      } catch (error: unknown) {
        if (error instanceof GitHubAdapterError) throw error;
        throw new GitHubApiResponseError("actions.artifact.download", "GitHub returned an invalid Actions artifact.");
      }
    } finally {
      try {
        if (handle !== undefined) await handle.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }

  /** Read the target repository metadata used to select the trusted governance ref. */
  async getRepositoryDefaultBranch(): Promise<string> {
    const context = await this.resolveRepositoryContext();
    const result = await this.runApi(
      this.apiArguments(context, `repos/${context.nameWithOwner}`, "GET"),
      "repository.default_branch",
    );
    const record = responseRecord(result, "repository.default_branch");
    const ref = responseString(record.default_branch, "default_branch", "repository.default_branch");
    assertRepositoryRef(ref);
    return ref;
  }

  /** Read the complete Git tree for a trusted repository ref. Truncation is invalid for governance. */
  async getRepositoryTree(ref: string): Promise<RepositoryTree> {
    assertRepositoryRef(ref);
    const context = await this.resolveRepositoryContext();
    const result = await this.runApi(
      this.apiArguments(
        context,
        `repos/${context.nameWithOwner}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        "GET",
      ),
      "repository.governance.tree",
    );
    return parseRepositoryTree(result, "repository.governance.tree");
  }

  /** Read and decode one blob selected from the trusted repository tree. */
  async getRepositoryBlob(sha: string): Promise<string> {
    if (sha.trim().length === 0) throw new ContractViolationError("Repository blob SHA must not be empty.", "sha");
    const context = await this.resolveRepositoryContext();
    const result = await this.runApi(
      this.apiArguments(context, `repos/${context.nameWithOwner}/git/blobs/${encodeURIComponent(sha)}`, "GET"),
      "repository.governance.blob",
    );
    const record = responseRecord(result, "repository.governance.blob");
    const returnedSha = responseString(record.sha, "sha", "repository.governance.blob");
    if (returnedSha !== sha) {
      throw new GitHubApiResponseError(
        "repository.governance.blob",
        "GitHub returned a repository blob different from the trusted tree entry.",
        { path: "sha" },
      );
    }
    const encoding = responseString(record.encoding, "encoding", "repository.governance.blob");
    const content = responseString(record.content, "content", "repository.governance.blob");
    if (encoding !== "base64") {
      throw new GitHubApiResponseError(
        "repository.governance.blob",
        "GitHub returned a repository blob with an unsupported encoding.",
        { path: "encoding" },
      );
    }
    const normalizedContent = content.replace(/\s/gu, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalizedContent)) {
      throw new GitHubApiResponseError(
        "repository.governance.blob",
        "GitHub returned an invalid base64 repository blob.",
        { path: "content" },
      );
    }
    const bytes = Buffer.from(normalizedContent, "base64");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new GitHubApiResponseError(
        "repository.governance.blob",
        "GitHub returned a repository blob containing invalid UTF-8 byte sequences.",
        { path: "content" },
        error,
      );
    }
  }

  async getIssue(issueNumber: number): Promise<GitHubIssue> {
    assertIssueNumber(issueNumber, "issue_number");
    const context = await this.resolveRepositoryContext();
    const result = await this.runApi(
      this.apiArguments(context, `repos/${context.nameWithOwner}/issues/${issueNumber}`, "GET"),
      "issue.read",
    );
    return parseIssue(result, "issue.read", context.repositoryId, context.hostname);
  }

  async readIssue(issueNumber: number): Promise<GitHubIssue> {
    return this.getIssue(issueNumber);
  }

  async getPullRequest(pullRequestNumber: number): Promise<GitHubPullRequest> {
    assertIssueNumber(pullRequestNumber, "pull_request_number");
    const context = await this.resolveRepositoryContext();
    const result = await this.runApi(
      this.apiArguments(context, `repos/${context.nameWithOwner}/pulls/${pullRequestNumber}`, "GET"),
      "pull_request.read",
    );
    return parsePullRequest(result, "pull_request.read");
  }

  async readPullRequest(pullRequestNumber: number): Promise<GitHubPullRequest> {
    return this.getPullRequest(pullRequestNumber);
  }

  /**
   * Read and normalize the fixed Issue Operational Observation surface.
   * Semantic template parsing is intentionally not part of this adapter.
   */
  async observeIssue(issueNumber: number): Promise<GitHubOperationalIssueEvidence> {
    assertIssueNumber(issueNumber, "issue_number");
    const context = await this.resolveRepositoryContext();
    const baseEndpoint = `issues/${issueNumber}`;
    const result = await this.runApi(
      this.apiArguments(context, `repos/${context.nameWithOwner}/${baseEndpoint}`, "GET"),
      "issue.observe",
    );
    const base = parseOperationalIssue(result, context, "issue.observe");
    const commentsEndpoint = `issues/${issueNumber}/comments`;
    const comments = await this.readOperationalCollection(
      commentsEndpoint,
      "issue.comments",
      (body) => arrayResponse(body, "comments"),
      (entry, path) => parseOperationalComment(entry, path, "conversation"),
    );
    return {
      ...base,
      comments,
      provenance: operationalProvenance([baseEndpoint, commentsEndpoint]),
    };
  }

  /** Compatibility spelling for callers that describe this as a read. */
  async readOperationalIssue(issueNumber: number): Promise<GitHubOperationalIssueEvidence> {
    return this.observeIssue(issueNumber);
  }

  /**
   * Read and normalize the fixed PR Operational Observation surface. Every
   * expensive collection is bounded and reports its own availability and
   * continuation state.
   */
  async observePullRequest(pullRequestNumber: number): Promise<GitHubOperationalPullRequestEvidence> {
    assertIssueNumber(pullRequestNumber, "pull_request_number");
    const context = await this.resolveRepositoryContext();
    const baseEndpoint = `pulls/${pullRequestNumber}`;
    const result = await this.runApi(
      this.apiArguments(context, `repos/${context.nameWithOwner}/${baseEndpoint}`, "GET"),
      "pull_request.observe",
    );
    const base = parseOperationalPullRequest(result, context, "pull_request.observe");
    const commentsEndpoint = `issues/${pullRequestNumber}/comments`;
    const inlineCommentsEndpoint = `pulls/${pullRequestNumber}/comments`;
    const reviewsEndpoint = `pulls/${pullRequestNumber}/reviews`;
    const filesEndpoint = `pulls/${pullRequestNumber}/files`;
    const comments = await this.readOperationalCollection(
      commentsEndpoint,
      "pull_request.comments",
      (body) => arrayResponse(body, "comments"),
      (entry, path) => parseOperationalComment(entry, path, "conversation"),
    );
    const inlineReviewComments = await this.readOperationalCollection(
      inlineCommentsEndpoint,
      "pull_request.inline_comments",
      (body) => arrayResponse(body, "inline comments"),
      (entry, path) => parseOperationalComment(entry, path, "inline"),
    );
    const reviews = await this.readOperationalCollection(
      reviewsEndpoint,
      "pull_request.reviews",
      (body) => arrayResponse(body, "reviews"),
      (entry, path) => parseOperationalReview(entry, path),
    );
    const changedFiles = await this.readOperationalCollection(
      filesEndpoint,
      "pull_request.files",
      (body) => arrayResponse(body, "changed files"),
      (entry, path) => parseOperationalChangedFile(entry, path),
    );
    const deterministicChangedFiles: GitHubOperationalCollection<GitHubOperationalChangedFile> = {
      ...changedFiles,
      items: [...changedFiles.items].sort(compareOperationalChangedFiles),
    };
    const checks =
      base.head.sha === undefined
        ? unavailableOperationalCollection<GitHubOperationalCheck>(
            "pull_request.checks",
            "PR head SHA was not supplied by GitHub.",
          )
        : await this.readOperationalChecks(base.head.sha);
    const reviewDecisionResult =
      base.reviewDecision === undefined
        ? await this.readOperationalReviewDecision(context, pullRequestNumber)
        : { value: undefined, attempted: false };
    const checksEndpoints =
      base.head.sha === undefined ? [] : [`commits/${base.head.sha}/check-runs`, `commits/${base.head.sha}/status`];
    return {
      ...base,
      ...(base.reviewDecision === undefined && reviewDecisionResult.value !== undefined
        ? { reviewDecision: reviewDecisionResult.value }
        : {}),
      checks,
      reviews,
      comments,
      inlineReviewComments,
      changedFiles: deterministicChangedFiles,
      provenance: operationalProvenance([
        baseEndpoint,
        commentsEndpoint,
        inlineCommentsEndpoint,
        reviewsEndpoint,
        filesEndpoint,
        ...checksEndpoints,
        ...(reviewDecisionResult.attempted ? ["graphql:pullRequest.reviewDecision"] : []),
      ]),
    };
  }

  /** Compatibility spelling for callers that describe this as a read. */
  async readOperationalPullRequest(pullRequestNumber: number): Promise<GitHubOperationalPullRequestEvidence> {
    return this.observePullRequest(pullRequestNumber);
  }

  private async readOperationalChecks(headSha: string): Promise<GitHubOperationalCollection<GitHubOperationalCheck>> {
    const runs = await this.readOperationalCollection(
      `commits/${encodeURIComponent(headSha)}/check-runs`,
      "pull_request.check_runs",
      (body) => {
        if (!isRecord(body))
          throw new GitHubApiResponseError("pull_request.check_runs", "GitHub returned invalid check-run data.");
        return arrayResponse(body.check_runs, "check runs");
      },
      (entry, path) => parseOperationalCheck(entry, path, "check-run"),
    );
    const statuses = await this.readOperationalCollection(
      `commits/${encodeURIComponent(headSha)}/status`,
      "pull_request.statuses",
      (body) => {
        if (!isRecord(body))
          throw new GitHubApiResponseError("pull_request.statuses", "GitHub returned invalid commit status data.");
        return arrayResponse(body.statuses, "statuses");
      },
      (entry, path) => parseOperationalCheck(entry, path, "status"),
    );
    const items = [...runs.items, ...statuses.items].sort(compareOperationalChecks);
    const checks: GitHubOperationalCollection<GitHubOperationalCheck> = {
      status: runs.status === "available" && statuses.status === "available" ? "available" : "unavailable",
      items,
      pagination: combineOperationalPagination(runs.pagination, statuses.pagination, items.length),
      diagnostics: [...runs.diagnostics, ...statuses.diagnostics].slice(0, 100),
    };
    return checks;
  }

  /** Read GitHub's aggregate review decision through one fixed GraphQL query. */
  private async readOperationalReviewDecision(
    context: RepositoryContext,
    pullRequestNumber: number,
  ): Promise<{ readonly value?: string; readonly attempted: boolean }> {
    const query =
      "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision}}}";
    let result: GhCommandResult;
    try {
      result = await this.runCommand(
        [
          "api",
          "graphql",
          "--hostname",
          context.hostname,
          "-f",
          `query=${query}`,
          "-f",
          `owner=${context.owner}`,
          "-f",
          `name=${context.name}`,
          "-F",
          `number=${pullRequestNumber}`,
        ],
        "pull_request.review_decision",
      );
    } catch {
      return { attempted: true };
    }
    if (result.exitCode !== 0) return { attempted: true };
    try {
      const payload = parseJson(result.stdout, "pull_request.review_decision");
      if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.repository))
        return { attempted: true };
      const pullRequest = payload.data.repository.pullRequest;
      if (!isRecord(pullRequest)) return { attempted: true };
      const value = pullRequest.reviewDecision;
      return {
        attempted: true,
        ...(value === null || value === undefined
          ? {}
          : { value: providerText(value, "reviewDecision", "pull_request.review_decision", 64) }),
      };
    } catch {
      return { attempted: true };
    }
  }

  private async readOperationalCollection<T>(
    endpoint: string,
    operation: string,
    pageBody: (body: unknown) => readonly unknown[],
    parseItem: (value: unknown, path: string) => T,
  ): Promise<GitHubOperationalCollection<T>> {
    const items: T[] = [];
    let nextPage: number | undefined = 1;
    let pages = 0;
    while (nextPage !== undefined && pages < OPERATIONAL_MAX_PAGES) {
      const requestedPage: number = nextPage;
      const pageEndpoint = `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=${OPERATIONAL_PAGE_SIZE}&page=${requestedPage}`;
      let response: GitHubApiResponse;
      try {
        response = await this.requestRepositoryApi(pageEndpoint, "GET");
      } catch {
        return operationalCollectionFailure(operation, items, pages, requestedPage, `${operation} read failed.`);
      }
      if (response.status === 404) {
        return operationalCollectionUnavailable(
          operation,
          items,
          pages,
          `${operation} endpoint was not available from GitHub.`,
        );
      }
      if (response.status < 200 || response.status >= 300) {
        return operationalCollectionFailure(
          operation,
          items,
          pages,
          requestedPage,
          `${operation} returned an unavailable response.`,
        );
      }
      let entries: readonly unknown[];
      try {
        entries = pageBody(response.body);
      } catch {
        return operationalCollectionFailure(
          operation,
          items,
          pages,
          requestedPage,
          `${operation} returned malformed collection data.`,
        );
      }
      if (entries.length > OPERATIONAL_PAGE_SIZE || items.length + entries.length > OPERATIONAL_MAX_ITEMS) {
        return operationalCollectionFailure(
          operation,
          items,
          pages,
          requestedPage,
          `${operation} exceeded the bounded collection limit.`,
        );
      }
      const itemOffset = items.length;
      try {
        entries.forEach((entry, index) => items.push(parseItem(entry, `${operation}.items[${itemOffset + index}]`)));
      } catch {
        return operationalCollectionFailure(
          operation,
          items,
          pages,
          requestedPage,
          `${operation} contained malformed provider evidence.`,
        );
      }
      pages += 1;
      const linkedNext = nextPageFromLink(response.headers?.link);
      if (linkedNext !== undefined && linkedNext <= requestedPage) {
        return operationalCollectionFailure(
          operation,
          items,
          pages,
          linkedNext,
          `${operation} returned a non-advancing pagination link.`,
        );
      }
      if (linkedNext !== undefined) nextPage = linkedNext;
      else if (entries.length === OPERATIONAL_PAGE_SIZE) nextPage = requestedPage + 1;
      else nextPage = undefined;
      if (nextPage !== undefined && pages >= OPERATIONAL_MAX_PAGES) {
        return {
          status: "available",
          items,
          pagination: {
            perPage: OPERATIONAL_PAGE_SIZE,
            pages,
            returned: items.length,
            truncated: true,
            nextPage,
          },
          diagnostics: [
            {
              code: "OPERATIONAL_COLLECTION_TRUNCATED",
              path: operation,
              message: `${operation} reached the bounded page limit; request nextPage explicitly to continue.`,
            },
          ],
        };
      }
    }
    return {
      status: "available",
      items,
      pagination: {
        perPage: OPERATIONAL_PAGE_SIZE,
        pages,
        returned: items.length,
        truncated: nextPage !== undefined,
        ...(nextPage === undefined ? {} : { nextPage }),
      },
      diagnostics: [],
    };
  }

  /**
   * Read the bounded set of pull requests targeting one head/base pair.
   *
   * This is an adapter-owned observation primitive for plan preconditions;
   * callers do not construct GitHub API paths or parse provider responses.
   */
  async listPullRequests(head: string, base: string): Promise<readonly GitHubPullRequest[]> {
    assertPullRequestRef(head, "head");
    assertPullRequestRef(base, "base");
    const context = await this.resolveRepositoryContext();
    const query =
      `pulls?head=${encodeURIComponent(`${context.owner}:${head}`)}` +
      `&base=${encodeURIComponent(base)}&state=all&per_page=${MAX_PULL_REQUEST_LIST_ITEMS}`;
    const response = await this.requestRepositoryApi(query, "GET");
    if (response.status === 404) return [];
    if (response.status < 200 || response.status >= 300) {
      throw new GitHubApiError("pull_request.list", "GitHub pull request target lookup failed.");
    }
    if (!Array.isArray(response.body) || response.body.length > MAX_PULL_REQUEST_LIST_ITEMS) {
      throw new GitHubApiResponseError("pull_request.list", "GitHub returned an invalid pull request target list.", {
        path: "body",
      });
    }
    return response.body.map((entry) => parsePullRequest(entry, "pull_request.list"));
  }

  /** Read one explicit branch ref; a missing ref is represented as undefined. */
  async findBranch(branch: string): Promise<GitHubBranch | undefined> {
    assertPullRequestRef(branch, "branch");
    const response = await this.requestRepositoryApi(`git/ref/heads/${encodeURIComponent(branch)}`, "GET");
    if (response.status === 404) return undefined;
    if (response.status < 200 || response.status >= 300) {
      throw new GitHubApiError("branch.read", "GitHub branch ref lookup failed.");
    }
    return parseBranch(response.body, branch, "branch.read");
  }

  /** Create exactly the branch and source refs supplied by a trusted Core plan. */
  async createBranch(branch: string, source: string): Promise<GitHubBranch> {
    assertPullRequestRef(branch, "branch");
    assertPullRequestRef(source, "source");
    const base = await this.findBranch(source);
    if (base === undefined) throw new GitHubApiError("branch.create", "GitHub branch source ref was not found.");
    const context = await this.resolveRepositoryContext();
    const args = this.apiArguments(context, `repos/${context.nameWithOwner}/git/refs`, "POST");
    appendRawField(args, "ref", `refs/heads/${branch}`);
    appendRawField(args, "sha", base.sha);
    const result = await this.runApi(args, "branch.create");
    return parseBranch(result, branch, "branch.create");
  }

  async createIssue(artifact: ValidatedRenderedIssueArtifact): Promise<GitHubIssue> {
    assertValidatedRenderedIssueArtifact(artifact);
    const context = await this.resolveRepositoryContext();
    assertArtifactRepository(artifact, context);
    const args = this.apiArguments(context, `repos/${context.nameWithOwner}/issues`, "POST");
    appendRawField(args, "title", artifact.title);
    appendRawField(args, "body", artifact.body);
    appendRawFields(args, "labels[]", artifact.labels);
    appendRawFields(args, "assignees[]", artifact.assignees);
    const result = await this.runApi(args, "issue.create");
    return parseIssue(result, "issue.create", context.repositoryId, context.hostname);
  }

  /** Apply a Core-projected v2 Semantic Issue through the trusted adapter seam. */
  async createSemanticIssue(artifact: ValidatedSemanticIssueArtifact): Promise<GitHubIssue> {
    assertTrustedSemanticIssueArtifact(artifact);
    const context = await this.resolveRepositoryContext();
    assertArtifactContractRepository(artifact, context);
    const args = this.apiArguments(context, `repos/${context.nameWithOwner}/issues`, "POST");
    appendRawField(args, "title", artifact.title);
    appendRawField(args, "body", artifact.body);
    appendRawFields(args, "labels[]", artifact.labels);
    appendRawFields(args, "assignees[]", artifact.assignees);
    const result = await this.runApi(args, "issue.create");
    return parseIssue(result, "issue.create", context.repositoryId, context.hostname);
  }

  async updateIssue(issueNumber: number, artifact: ValidatedRenderedIssueArtifact): Promise<GitHubIssue> {
    assertIssueNumber(issueNumber, "issue_number");
    assertValidatedRenderedIssueArtifact(artifact);
    const context = await this.resolveRepositoryContext();
    assertArtifactRepository(artifact, context);
    // GitHub's issues API also accepts pull request numbers; read first so a
    // pull request is never silently overwritten with Issue Form content.
    await this.getIssue(issueNumber);
    const args = this.apiArguments(context, `repos/${context.nameWithOwner}/issues/${issueNumber}`, "PATCH");
    appendRawField(args, "title", artifact.title);
    appendRawField(args, "body", artifact.body);
    appendRawFields(args, "labels[]", artifact.labels);
    appendRawFields(args, "assignees[]", artifact.assignees);
    const result = await this.runApi(args, "issue.update");
    return parseIssue(result, "issue.update", context.repositoryId, context.hostname);
  }

  async createPullRequest(artifact: ValidatedRenderedPullRequestArtifact): Promise<GitHubPullRequest> {
    assertValidatedRenderedPullRequestArtifact(artifact);
    const context = await this.resolveRepositoryContext();
    assertArtifactRepository(artifact, context);
    const args = this.apiArguments(context, `repos/${context.nameWithOwner}/pulls`, "POST");
    appendRawField(args, "title", artifact.title);
    appendRawField(args, "body", artifact.body);
    appendRawField(args, "head", artifact.head);
    appendRawField(args, "base", artifact.base);
    appendBooleanField(args, "draft", artifact.draft);
    appendBooleanField(args, "maintainer_can_modify", artifact.maintainerCanModify);
    const result = await this.runApi(args, "pull_request.create");
    return parsePullRequest(result, "pull_request.create");
  }

  /** Apply a Core-projected v2 Semantic PR through the existing GitHub seam. */
  async createSemanticPullRequest(artifact: ValidatedSemanticPullRequestArtifact): Promise<GitHubPullRequest> {
    assertTrustedSemanticPullRequestArtifact(artifact);
    const context = await this.resolveRepositoryContext();
    assertArtifactContractRepository(artifact, context);
    const args = this.apiArguments(context, `repos/${context.nameWithOwner}/pulls`, "POST");
    appendRawField(args, "title", artifact.title);
    appendRawField(args, "body", artifact.body);
    appendRawField(args, "head", artifact.head);
    appendRawField(args, "base", artifact.base);
    appendBooleanField(args, "draft", artifact.draft);
    appendBooleanField(args, "maintainer_can_modify", artifact.maintainerCanModify);
    const result = await this.runApi(args, "pull_request.create");
    const pullRequest = parsePullRequest(result, "pull_request.create");

    // The pull-request create endpoint does not accept labels or assignees.
    // Keep this provider-specific follow-up inside the adapter so Core and the
    // Executor never reconstruct GitHub mutation semantics.
    if ((artifact.labels?.length ?? 0) > 0 || (artifact.assignees?.length ?? 0) > 0) {
      const metadataArgs = this.apiArguments(
        context,
        `repos/${context.nameWithOwner}/issues/${pullRequest.number}`,
        "PATCH",
      );
      appendRawFields(metadataArgs, "labels[]", artifact.labels);
      appendRawFields(metadataArgs, "assignees[]", artifact.assignees);
      await this.runApi(metadataArgs, "pull_request.update");
    }
    return pullRequest;
  }

  async updatePullRequest(
    pullRequestNumber: number,
    artifact: ValidatedRenderedPullRequestArtifact,
  ): Promise<GitHubPullRequest> {
    assertIssueNumber(pullRequestNumber, "pull_request_number");
    assertValidatedRenderedPullRequestArtifact(artifact);
    const context = await this.resolveRepositoryContext();
    assertArtifactRepository(artifact, context);
    const args = this.apiArguments(context, `repos/${context.nameWithOwner}/pulls/${pullRequestNumber}`, "PATCH");
    appendRawField(args, "title", artifact.title);
    appendRawField(args, "body", artifact.body);
    appendRawField(args, "base", artifact.base);
    appendBooleanField(args, "maintainer_can_modify", artifact.maintainerCanModify);
    const result = await this.runApi(args, "pull_request.update");
    return parsePullRequest(result, "pull_request.update");
  }

  private async resolveRepositoryContextOnce(): Promise<RepositoryContext> {
    await this.ensureGhAvailable();
    const override = this.repositoryOverride();
    if (override !== undefined) {
      await this.ensureAuthenticated(override.hostname);
      return this.resolveRepositoryView(`${override.hostname}/${override.nameWithOwner}`, override.hostname);
    }

    await this.ensureAuthenticated(this.normalizedHostname());
    return this.resolveRepositoryView(undefined, this.normalizedHostname() ?? DEFAULT_HOSTNAME);
  }

  /** Resolve the host-scoped REST repository database identity for both local and explicit targets. */
  private async resolveRepositoryView(
    repositoryArgument: string | undefined,
    fallbackHostname: string,
  ): Promise<RepositoryContext> {
    let metadata: RepositoryContext;
    if (repositoryArgument === undefined) {
      const result = await this.runCommand(["repo", "view", "--json", "nameWithOwner,url"], "repository.resolve");
      if (result.exitCode !== 0) {
        if (UNAUTHENTICATED_MESSAGE_PATTERN.test(result.stderr)) {
          throw new GhUnauthenticatedError(fallbackHostname, summarize(result.stderr));
        }
        throw new RepositoryResolutionError(
          "Unable to resolve the current GitHub repository. Check the working directory and authentication.",
          { operation: "repository.resolve", exitCode: result.exitCode, stderr: summarize(result.stderr) },
        );
      }
      const payload = parseJson(result.stdout, "repository.resolve");
      if (!isRecord(payload) || typeof payload.nameWithOwner !== "string") {
        throw new RepositoryResolutionError("gh returned no valid repository locator.", {
          operation: "repository.resolve",
          response: summarize(result.stdout),
        });
      }
      try {
        metadata = repositoryContextFromNameWithOwner(
          payload.nameWithOwner,
          typeof payload.url === "string" ? payload.url : undefined,
          fallbackHostname,
        );
      } catch (error) {
        if (error instanceof RepositoryResolutionError) throw error;
        throw new RepositoryResolutionError(
          "gh returned an invalid repository locator.",
          { operation: "repository.resolve", response: summarize(result.stdout) },
          error,
        );
      }
    } else {
      metadata = parseRepositoryOverride(repositoryArgument, fallbackHostname);
    }

    const identityResult = await this.runCommand(
      ["api", `repos/${metadata.nameWithOwner}`, "--hostname", metadata.hostname, "--method", "GET", "--jq", ".id"],
      "repository.resolve",
    );
    if (identityResult.exitCode !== 0) {
      if (UNAUTHENTICATED_MESSAGE_PATTERN.test(identityResult.stderr)) {
        throw new GhUnauthenticatedError(metadata.hostname, summarize(identityResult.stderr));
      }
      throw new RepositoryResolutionError(
        "Unable to resolve the GitHub repository database identity. Check the target repository and authentication.",
        {
          operation: "repository.resolve",
          exitCode: identityResult.exitCode,
          stderr: summarize(identityResult.stderr),
        },
      );
    }
    const repositoryId = parseRepositoryDatabaseId(identityResult.stdout);
    if (repositoryId === undefined) {
      throw new RepositoryResolutionError("gh returned no valid repository database identity.", {
        operation: "repository.resolve",
        response: summarize(identityResult.stdout),
      });
    }
    return repositoryContext(metadata.hostname, metadata.owner, metadata.name, metadata.url, repositoryId);
  }

  private repositoryOverride(): RepositoryContext | undefined {
    if (this.repository === undefined) return undefined;
    return parseRepositoryOverride(this.repository, this.normalizedHostname() ?? DEFAULT_HOSTNAME);
  }

  private repositoryHostOverride(): string | undefined {
    const override = this.repositoryOverride();
    if (override !== undefined) return override.hostname;
    return this.normalizedHostname();
  }

  private normalizedHostname(): string | undefined {
    if (this.hostname === undefined) return undefined;
    const value = this.hostname.trim().toLowerCase();
    if (!isValidHostname(value)) throw new InvalidRepositoryOverrideError(this.hostname);
    return value;
  }

  private async ensureGhAvailable(): Promise<void> {
    if (this.availablePromise === undefined) {
      const pending = this.ensureGhAvailableOnce();
      this.availablePromise = pending;
      pending.catch(() => {
        if (this.availablePromise === pending) this.availablePromise = undefined;
      });
    }
    return this.availablePromise;
  }

  private async ensureGhAvailableOnce(): Promise<void> {
    const result = await this.runCommand(["--version"], "gh.version");
    if (result.exitCode !== 0) {
      throw new GhNotInstalledError(this.executable);
    }
  }

  private async ensureAuthenticated(hostname: string | undefined): Promise<void> {
    if (this.authenticatedHostnames.has(hostname)) return;
    let pending = this.authenticationPromises.get(hostname);
    if (pending === undefined) {
      pending = this.ensureAuthenticatedOnce(hostname);
      this.authenticationPromises.set(hostname, pending);
      pending
        .catch(() => undefined)
        .finally(() => {
          this.authenticationPromises.delete(hostname);
        });
    }
    return pending;
  }

  private async ensureAuthenticatedOnce(hostname: string | undefined): Promise<void> {
    const args = ["auth", "status"];
    if (hostname !== undefined) args.push("--hostname", hostname);
    const result = await this.runCommand(args, "auth.status");
    if (result.exitCode !== 0) {
      throw new GhUnauthenticatedError(hostname, summarize(result.stderr));
    }
    this.authenticatedHostnames.add(hostname);
  }

  private async runApi(args: readonly string[], operation: string): Promise<unknown> {
    const result = await this.runCommand(args, operation);
    if (result.exitCode !== 0) {
      throw new GitHubApiError(operation, `GitHub API request failed during ${operation}.`, {
        exitCode: result.exitCode,
        stderr: summarize(result.stderr),
      });
    }
    return parseJson(result.stdout, operation);
  }

  private async runCommand(args: readonly string[], operation: string): Promise<GhCommandResult> {
    const timeoutMs = this.timeoutsMs[operationClass(operation)];
    try {
      return await this.transport.run(args, {
        cwd: this.cwd,
        timeoutMs,
        maxStdoutBytes: this.outputLimitsBytes.stdout,
        maxStderrBytes: this.outputLimitsBytes.stderr,
      });
    } catch (error) {
      if (error instanceof GhTransportOutputLimitError) {
        throw new GitHubOutputLimitError(operation, error.stream, error.limitBytes, error.outputBytes, error);
      }
      if (error instanceof GhTransportTimeoutError) {
        throw new GitHubTimeoutError(operation, error.timeoutMs, error);
      }
      if (isErrno(error, "ENOENT")) throw new GhNotInstalledError(this.executable, error);
      throw new GitHubTransportError(
        operation,
        `Unable to execute gh during ${operation}.`,
        { stderr: error instanceof Error ? summarize(error.message) : undefined },
        error,
      );
    }
  }

  private apiArguments(
    context: RepositoryContext,
    endpoint: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
  ): string[] {
    return ["api", endpoint, "--hostname", context.hostname, "--method", method];
  }
}

function assertIssueNumber(value: number, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ContractViolationError("GitHub artifact number must be a positive integer.", path);
  }
}

export function assertValidatedRenderedIssueArtifact(
  artifact: unknown,
): asserts artifact is ValidatedRenderedIssueArtifact {
  assertArtifactBase(artifact, "issue");
  if (!isRecord(artifact)) return;
  assertStringArray(artifact.labels, "labels");
  assertStringArray(artifact.assignees, "assignees");
}

export function assertValidatedRenderedPullRequestArtifact(
  artifact: unknown,
): asserts artifact is ValidatedRenderedPullRequestArtifact {
  assertArtifactBase(artifact, "pull_request");
  if (!isRecord(artifact)) return;
  assertString(artifact.head, "head");
  assertString(artifact.base, "base");
  assertOptionalBoolean(artifact.draft, "draft");
  assertOptionalBoolean(artifact.maintainerCanModify, "maintainerCanModify");
}

export function assertTrustedSemanticPullRequestArtifact(
  artifact: unknown,
): asserts artifact is ValidatedSemanticPullRequestArtifact {
  if (!isTrustedSemanticPullRequestArtifact(artifact)) {
    throw new ContractViolationError("Mutation requires an opaque Semantic PR artifact produced by Core.", "artifact");
  }
  if (!isRecord(artifact)) throw new ContractViolationError("Mutation requires a Semantic PR artifact.");
  if (artifact.phase !== "validated-semantic" || artifact.kind !== "pull_request") {
    throw new ContractViolationError("Mutation requires a validated Semantic PR artifact.", "artifact");
  }
  assertString(artifact.title, "title");
  assertString(artifact.body, "body");
  assertString(artifact.head, "head");
  assertString(artifact.base, "base");
  assertStringArray(artifact.labels, "labels");
  assertStringArray(artifact.assignees, "assignees");
  assertArtifactContractProvenance(artifact.provenance);
  assertOptionalBoolean(artifact.draft, "draft");
  assertOptionalBoolean(artifact.maintainerCanModify, "maintainerCanModify");
}

export function assertTrustedSemanticIssueArtifact(
  artifact: unknown,
): asserts artifact is ValidatedSemanticIssueArtifact {
  if (!isTrustedSemanticIssueArtifact(artifact)) {
    throw new ContractViolationError(
      "Mutation requires an opaque Semantic Issue artifact produced by Core.",
      "artifact",
    );
  }
  if (!isRecord(artifact)) throw new ContractViolationError("Mutation requires a Semantic Issue artifact.");
  if (artifact.phase !== "validated-semantic" || artifact.kind !== "issue") {
    throw new ContractViolationError("Mutation requires a validated Semantic Issue artifact.", "artifact");
  }
  assertString(artifact.title, "title");
  assertString(artifact.body, "body");
  assertStringArray(artifact.labels, "labels");
  assertStringArray(artifact.assignees, "assignees");
  assertArtifactContractProvenance(artifact.provenance);
}

function assertArtifactBase(artifact: unknown, kind: "issue" | "pull_request"): void {
  if (!isTrustedValidatedRenderedArtifact(artifact)) {
    throw new ContractViolationError(
      "Mutation requires an opaque artifact produced by Inari's trusted preparation boundary.",
      "artifact",
    );
  }
  if (!isRecord(artifact)) throw new ContractViolationError("Mutation requires a validated rendered artifact.");
  if (artifact.phase !== VALIDATED_RENDERED_PHASE) {
    throw new ContractViolationError(
      "Mutation requires an artifact produced after contract validation and rendering.",
      "phase",
    );
  }
  if (artifact.kind !== kind) {
    throw new ContractViolationError(`Expected a validated rendered ${kind} artifact.`, "kind");
  }
  assertString(artifact.title, "title");
  assertString(artifact.body, "body");
  assertProvenance(artifact.provenance);
}

function assertArtifactRepository(
  artifact: ValidatedRenderedIssueArtifact | ValidatedRenderedPullRequestArtifact,
  context: RepositoryContext,
): void {
  const provenance = artifact.provenance;
  const hostMatches = provenance.repository.host.toLowerCase() === context.hostname.toLowerCase();
  const provenanceId = provenance.repository.repositoryId;
  const identityMatches =
    provenanceId !== undefined && context.repositoryId !== undefined && provenanceId === context.repositoryId;
  // owner/name is a mutable locator. Mutation provenance must carry both
  // authorities; accepting a locator-only artifact could target a
  // same-name repository recreated after a rename/transfer.
  if (!hostMatches || !identityMatches) {
    throw new ContractViolationError(
      "Mutation artifact provenance does not match the target repository.",
      "provenance.repository",
    );
  }
}

function assertArtifactContractRepository(
  artifact: ValidatedSemanticPullRequestArtifact | ValidatedSemanticIssueArtifact,
  context: RepositoryContext,
): void {
  const provenance = artifact.provenance;
  const hostMatches = provenance.repository.host.toLowerCase() === context.hostname.toLowerCase();
  const identityMatches =
    provenance.repository.repositoryId !== undefined &&
    context.repositoryId !== undefined &&
    provenance.repository.repositoryId === context.repositoryId;
  if (!hostMatches || !identityMatches) {
    throw new ContractViolationError(
      "Mutation artifact provenance does not match the target repository.",
      "provenance.repository",
    );
  }
}

function assertProvenance(value: unknown): void {
  if (!isRecord(value)) {
    throw new ContractViolationError("Mutation requires trusted repository/ref provenance.", "provenance");
  }
  if (
    !isRecord(value.repository) ||
    typeof value.repository.host !== "string" ||
    typeof value.repository.nameWithOwner !== "string" ||
    typeof value.repository.repositoryId !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(value.repository.repositoryId)
  ) {
    throw new ContractViolationError("Mutation requires trusted repository/ref provenance.", "provenance.repository");
  }
}

function assertArtifactContractProvenance(value: unknown): void {
  if (!isRecord(value) || value.authority !== "repository-default-branch") {
    throw new ContractViolationError("Mutation requires trusted Semantic PR provenance.", "provenance");
  }
  if (!isRecord(value.repository) || !isRecord(value.source)) {
    throw new ContractViolationError("Mutation requires trusted Semantic PR provenance.", "provenance");
  }
  if (
    typeof value.repository.host !== "string" ||
    typeof value.repository.nameWithOwner !== "string" ||
    typeof value.repository.repositoryId !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(value.repository.repositoryId) ||
    typeof value.ref !== "string" ||
    typeof value.treeSha !== "string" ||
    typeof value.source.path !== "string" ||
    typeof value.source.ref !== "string" ||
    typeof value.source.sha !== "string" ||
    typeof value.source.digest !== "string"
  ) {
    throw new ContractViolationError("Mutation requires trusted Semantic PR provenance.", "provenance");
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") throw new ContractViolationError(`Artifact field ${path} must be a string.`, path);
}

function assertStringArray(value: unknown, path: string): asserts value is readonly string[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ContractViolationError(`Artifact field ${path} must be an array of strings.`, path);
  }
}

function assertOptionalBoolean(value: unknown, path: string): asserts value is boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") {
    throw new ContractViolationError(`Artifact field ${path} must be a boolean.`, path);
  }
}

function appendRawField(args: string[], name: string, value: string | undefined): void {
  if (value !== undefined) args.push("--raw-field", `${name}=${value}`);
}

function appendRepositoryApiField(args: string[], name: string, value: GitHubApiFieldValue): void {
  if (typeof value === "string") args.push("--raw-field", `${name}=${value}`);
  else args.push("--field", `${name}=${String(value)}`);
}

function appendRawFields(args: string[], name: string, values: readonly string[] | undefined): void {
  if (values === undefined) return;
  for (const value of values) args.push("--raw-field", `${name}=${value}`);
}

function appendBooleanField(args: string[], name: string, value: boolean | undefined): void {
  if (value !== undefined) args.push("--field", `${name}=${value ? "true" : "false"}`);
}

function parseJson(value: string, operation: string): unknown {
  if (value.trim() === "") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new GitHubApiResponseError(
      operation,
      `gh returned invalid JSON during ${operation}.`,
      { response: summarize(value) },
      error,
    );
  }
}

async function readBoundedActionsArtifact(handle: FileHandle): Promise<Buffer> {
  const buffer = Buffer.alloc(MAX_ACTIONS_ARTIFACT_BYTES + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
    bytesRead += result.bytesRead;
    if (result.bytesRead === 0) break;
  }
  if (bytesRead > MAX_ACTIONS_ARTIFACT_BYTES) {
    throw new GitHubApiResponseError("actions.artifact.download", "GitHub returned an invalid Actions artifact.");
  }
  return buffer.subarray(0, bytesRead);
}

function parseIncludedApiResponse(value: string, operation: string): GitHubApiResponse | undefined {
  const lines = value.split(/\r?\n/u);
  let statusIndex = -1;
  let status = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^HTTP\/[^ ]+\s+(\d{3})(?:\s|$)/u.exec(lines[index] ?? "");
    if (match !== null) {
      statusIndex = index;
      status = Number(match[1]);
    }
  }
  if (statusIndex < 0) return undefined;
  let separator = statusIndex + 1;
  while (separator < lines.length && lines[separator] !== "") separator += 1;
  if (separator >= lines.length) {
    throw new GitHubApiResponseError(operation, "GitHub returned an incomplete API response.");
  }
  const headers: Record<string, string> = {};
  for (const line of lines.slice(statusIndex + 1, separator)) {
    const delimiter = line.indexOf(":");
    if (delimiter <= 0) continue;
    const name = line.slice(0, delimiter).trim().toLowerCase();
    const headerValue = line.slice(delimiter + 1).trim();
    // Pagination is the only provider header currently admitted to the
    // normalized read contract. Keeping the surface narrow avoids turning
    // request metadata into an accidental public API.
    if (name === "link") headers[name] = headerValue;
  }
  return {
    status,
    body: parseJson(lines.slice(separator + 1).join("\n"), operation),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  };
}

function assertActionsApiPath(value: string): void {
  if (
    value.length === 0 ||
    value.length > 2048 ||
    value.startsWith("/") ||
    value.includes("\u0000") ||
    value.includes("..") ||
    !/^actions\//u.test(value)
  ) {
    throw new ContractViolationError("Actions API path is invalid.", "actionsPath");
  }
}

function assertRepositoryApiPath(value: string): void {
  if (
    value.length > 2048 ||
    value.startsWith("/") ||
    value.includes("\u0000") ||
    value.includes("..") ||
    (value !== "" && !/^(?:issues\/|pulls(?:\/|\?|$)|commits\/|git\/)/u.test(value))
  ) {
    throw new ContractViolationError("Repository API path is invalid.", "repositoryPath");
  }
}

function providerText(value: unknown, path: string, operation: string, maximum = 2_048): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
      path,
    });
  }
  return value;
}

/**
 * Bounded prose/Markdown field validator for Issue/PR/comment/review
 * bodies. Ordinary multiline Markdown uses TAB/LF/CR, so unlike
 * providerText() this allows those while still rejecting NUL and other
 * unsafe control characters, and bounds by UTF-8 byte length rather than
 * JS code-unit length.
 */
function providerProse(value: unknown, path: string, operation: string, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
      path,
    });
  }
  return value;
}

function optionalProviderText(value: unknown, path: string, operation: string, maximum = 2_048): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return providerText(value, path, operation, maximum);
}

function nullableProviderText(
  value: unknown,
  path: string,
  operation: string,
  maximum = 2_048,
): string | null | undefined {
  if (value === null) return null;
  return optionalProviderText(value, path, operation, maximum);
}

function optionalProviderNumber(value: unknown, path: string, operation: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
      path,
    });
  }
  return value;
}

function operationalActor(value: unknown, path: string, operation: string): GitHubOperationalActor | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new GitHubApiResponseError(operation, `GitHub response actor ${path} is invalid during ${operation}.`, {
      path,
    });
  }
  const login = optionalProviderText(value.login, `${path}.login`, operation, 512);
  const name = optionalProviderText(value.name, `${path}.name`, operation, 512);
  const url = optionalProviderText(value.html_url ?? value.url, `${path}.url`, operation, 2_048);
  const id = optionalProviderNumber(value.id, `${path}.id`, operation);
  if (login === undefined && name === undefined && url === undefined && id === undefined) return null;
  return {
    ...(login === undefined ? {} : { login }),
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(url === undefined ? {} : { url }),
  };
}

function operationalRepository(context: RepositoryContext): GitHubOperationalRepository {
  return {
    host: context.hostname,
    nameWithOwner: context.nameWithOwner,
    ...(context.repositoryId === undefined ? {} : { repositoryId: context.repositoryId }),
  };
}

function operationalProvenance(endpoints: readonly string[]): GitHubOperationalProvenance {
  return {
    provider: "github",
    endpoints: [...new Set(endpoints)].sort((left, right) => left.localeCompare(right, "en-US")),
  };
}

function operationalState(value: unknown): "open" | "closed" | "unknown" {
  if (value === "open" || value === "closed") return value;
  return "unknown";
}

function operationalLabels(value: unknown, path: string, operation: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
      path,
    });
  }
  return [
    ...new Set(
      value.map((entry, index) => {
        if (!isRecord(entry))
          throw new GitHubApiResponseError(operation, `GitHub response field ${path}[${index}] is invalid.`, { path });
        return providerText(entry.name, `${path}[${index}].name`, operation, 512);
      }),
    ),
  ].sort((left, right) => left.localeCompare(right, "en-US"));
}

function operationalActors(value: unknown, path: string, operation: string): readonly GitHubOperationalActor[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
      path,
    });
  }
  return value
    .map((entry, index) => {
      const actor = operationalActor(entry, `${path}[${index}]`, operation);
      if (actor === null)
        throw new GitHubApiResponseError(operation, `GitHub response actor ${path}[${index}] is empty.`);
      return actor;
    })
    .sort(compareOperationalActors);
}

function operationalMilestone(value: unknown, path: string, operation: string): GitHubMilestone | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value))
    throw new GitHubApiResponseError(operation, `GitHub response milestone ${path} is invalid.`, { path });
  return {
    number: responseNumber(value.number, `${path}.number`, operation),
    title: providerText(value.title, `${path}.title`, operation, 512),
  };
}

function operationalRef(
  value: unknown,
  path: string,
  operation: string,
): { readonly ref?: string; readonly sha?: string } {
  if (value === undefined || value === null) return {};
  if (!isRecord(value))
    throw new GitHubApiResponseError(operation, `GitHub response ref ${path} is invalid.`, { path });
  const ref = optionalProviderText(value.ref, `${path}.ref`, operation, 512);
  const sha = optionalProviderText(value.sha, `${path}.sha`, operation, 128);
  return { ...(ref === undefined ? {} : { ref }), ...(sha === undefined ? {} : { sha }) };
}

function parseOperationalIssue(
  value: unknown,
  context: RepositoryContext,
  operation: string,
): Omit<GitHubOperationalIssueEvidence, "comments" | "provenance"> {
  const record = responseRecord(value, operation);
  const number = responseNumber(record.number, "number", operation);
  if (record.pull_request !== undefined) throw new GitHubResourceKindMismatchError(operation, number);
  return {
    repository: operationalRepository(context),
    number,
    title: providerText(record.title, "title", operation, 255),
    body:
      record.body === undefined || record.body === null
        ? null
        : providerProse(record.body, "body", operation, 1_048_576),
    state: operationalState(record.state),
    ...(record.state_reason === undefined
      ? {}
      : { stateReason: nullableProviderText(record.state_reason, "state_reason", operation, 128) }),
    author: operationalActor(record.user, "user", operation),
    labels: operationalLabels(record.labels, "labels", operation),
    assignees: operationalActors(record.assignees, "assignees", operation),
    ...(operationalMilestone(record.milestone, "milestone", operation) === undefined
      ? {}
      : { milestone: operationalMilestone(record.milestone, "milestone", operation) }),
    ...(optionalProviderText(record.created_at, "created_at", operation, 128) === undefined
      ? {}
      : { createdAt: optionalProviderText(record.created_at, "created_at", operation, 128) }),
    ...(optionalProviderText(record.updated_at, "updated_at", operation, 128) === undefined
      ? {}
      : { updatedAt: optionalProviderText(record.updated_at, "updated_at", operation, 128) }),
    ...(optionalProviderText(record.closed_at, "closed_at", operation, 128) === undefined
      ? {}
      : { closedAt: optionalProviderText(record.closed_at, "closed_at", operation, 128) }),
    url: responseUrl(record, operation),
  };
}

function parseOperationalPullRequest(
  value: unknown,
  context: RepositoryContext,
  operation: string,
): Omit<
  GitHubOperationalPullRequestEvidence,
  "checks" | "reviews" | "comments" | "inlineReviewComments" | "changedFiles" | "provenance"
> {
  const record = responseRecord(value, operation);
  const requestedReviewers =
    record.requested_reviewers === undefined && record.requested_teams === undefined
      ? undefined
      : {
          users: operationalActors(record.requested_reviewers, "requested_reviewers", operation),
          teams: operationalTeamSlugs(record.requested_teams, "requested_teams", operation),
        };
  const draft =
    record.draft === undefined || record.draft === null ? undefined : responseBoolean(record.draft, "draft", operation);
  const mergeable =
    record.mergeable === undefined || record.mergeable === null
      ? record.mergeable
      : typeof record.mergeable === "boolean"
        ? record.mergeable
        : null;
  const mergeState =
    record.mergeable_state === undefined || record.mergeable_state === null
      ? record.mergeable_state
      : providerText(record.mergeable_state, "mergeable_state", operation, 64);
  const reviewDecision =
    record.review_decision === undefined || record.review_decision === null
      ? record.review_decision
      : providerText(record.review_decision, "review_decision", operation, 64);
  const merged =
    record.merged === undefined || record.merged === null
      ? record.merged
      : responseBoolean(record.merged, "merged", operation);
  const mergeCommitSha = nullableProviderText(record.merge_commit_sha, "merge_commit_sha", operation, 128);
  const milestone = operationalMilestone(record.milestone, "milestone", operation);
  const createdAt = optionalProviderText(record.created_at, "created_at", operation, 128);
  const updatedAt = optionalProviderText(record.updated_at, "updated_at", operation, 128);
  const closedAt = optionalProviderText(record.closed_at, "closed_at", operation, 128);
  const mergedAt = optionalProviderText(record.merged_at, "merged_at", operation, 128);
  return {
    repository: operationalRepository(context),
    number: responseNumber(record.number, "number", operation),
    title: providerText(record.title, "title", operation, 255),
    body:
      record.body === undefined || record.body === null
        ? null
        : providerProse(record.body, "body", operation, 1_048_576),
    state: operationalState(record.state),
    author: operationalActor(record.user, "user", operation),
    head: operationalRef(record.head, "head", operation),
    base: operationalRef(record.base, "base", operation),
    ...(draft === undefined ? {} : { draft }),
    ...(mergeable === undefined ? {} : { mergeable }),
    ...(mergeState === undefined ? {} : { mergeState }),
    ...(reviewDecision === undefined ? {} : { reviewDecision }),
    ...(merged === undefined ? {} : { merged }),
    ...(mergeCommitSha === undefined ? {} : { mergeCommitSha }),
    labels: operationalLabels(record.labels, "labels", operation),
    assignees: operationalActors(record.assignees, "assignees", operation),
    ...(requestedReviewers === undefined ? {} : { requestedReviewers }),
    ...(milestone === undefined ? {} : { milestone }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(closedAt === undefined ? {} : { closedAt }),
    ...(mergedAt === undefined ? {} : { mergedAt }),
    url: responseUrl(record, operation),
  };
}

function operationalTeamSlugs(value: unknown, path: string, operation: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid.`, { path });
  return [
    ...new Set(
      value.map((entry, index) => {
        if (!isRecord(entry))
          throw new GitHubApiResponseError(operation, `GitHub response field ${path}[${index}] is invalid.`, { path });
        return providerText(entry.slug, `${path}[${index}].slug`, operation, 512);
      }),
    ),
  ].sort((left, right) => left.localeCompare(right, "en-US"));
}

function arrayResponse(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`GitHub returned invalid ${label} collection.`);
  return value;
}

function parseOperationalComment(
  value: unknown,
  path: string,
  kind: "conversation" | "inline",
): GitHubOperationalComment {
  const record = responseRecord(value, "operational.comment");
  const id = responseNumber(record.id, `${path}.id`, "operational.comment");
  const body =
    record.body === undefined || record.body === null
      ? null
      : providerProse(record.body, `${path}.body`, "operational.comment", 1_048_576);
  const author = operationalActor(record.user, `${path}.user`, "operational.comment");
  const createdAt = optionalProviderText(record.created_at, `${path}.created_at`, "operational.comment", 128);
  const updatedAt = optionalProviderText(record.updated_at, `${path}.updated_at`, "operational.comment", 128);
  const url = optionalProviderText(record.html_url ?? record.url, `${path}.url`, "operational.comment", 2_048);
  const commentPath = optionalProviderText(record.path, `${path}.path`, "operational.comment", 512);
  const line =
    record.line === undefined || record.line === null
      ? record.line
      : optionalProviderNumber(record.line, `${path}.line`, "operational.comment");
  const side =
    record.side === undefined || record.side === null
      ? record.side
      : providerText(record.side, `${path}.side`, "operational.comment", 32);
  const inReplyTo =
    record.in_reply_to_id === undefined || record.in_reply_to_id === null
      ? undefined
      : responseNumber(record.in_reply_to_id, `${path}.in_reply_to_id`, "operational.comment");
  return {
    id,
    body,
    author,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(url === undefined ? {} : { url }),
    ...(commentPath === undefined ? {} : { path: commentPath }),
    ...(line === undefined ? {} : { line }),
    ...(side === undefined ? {} : { side }),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
  };
}

function parseOperationalReview(value: unknown, path: string): GitHubOperationalReview {
  const record = responseRecord(value, "operational.review");
  const id = responseNumber(record.id, `${path}.id`, "operational.review");
  const body =
    record.body === undefined || record.body === null
      ? null
      : providerProse(record.body, `${path}.body`, "operational.review", 1_048_576);
  const author = operationalActor(record.user, `${path}.user`, "operational.review");
  const state =
    record.state === undefined || record.state === null
      ? "unknown"
      : providerText(record.state, `${path}.state`, "operational.review", 64);
  const submittedAt = optionalProviderText(record.submitted_at, `${path}.submitted_at`, "operational.review", 128);
  const commitId = optionalProviderText(record.commit_id, `${path}.commit_id`, "operational.review", 128);
  const url = optionalProviderText(record.html_url ?? record.url, `${path}.url`, "operational.review", 2_048);
  return {
    id,
    body,
    author,
    state,
    ...(submittedAt === undefined ? {} : { submittedAt }),
    ...(commitId === undefined ? {} : { commitId }),
    ...(url === undefined ? {} : { url }),
  };
}

function parseOperationalCheck(value: unknown, path: string, kind: "check-run" | "status"): GitHubOperationalCheck {
  const record = responseRecord(value, `operational.${kind}`);
  const rawId = record.id ?? record.context;
  const id =
    typeof rawId === "number"
      ? String(responseNumber(rawId, `${path}.id`, `operational.${kind}`))
      : providerText(rawId, `${path}.id`, `operational.${kind}`, 128);
  const name = providerText(record.name ?? record.context, `${path}.name`, `operational.${kind}`, 512);
  const status = providerText(record.status ?? record.state, `${path}.status`, `operational.${kind}`, 64);
  const conclusion =
    record.conclusion === undefined
      ? undefined
      : nullableProviderText(record.conclusion, `${path}.conclusion`, `operational.${kind}`, 64);
  const description =
    record.description === undefined
      ? undefined
      : nullableProviderText(record.description, `${path}.description`, `operational.${kind}`, 2_048);
  const url = optionalProviderText(
    record.details_url ?? record.target_url,
    `${path}.url`,
    `operational.${kind}`,
    2_048,
  );
  const startedAt = optionalProviderText(record.started_at, `${path}.started_at`, `operational.${kind}`, 128);
  const completedAt = optionalProviderText(record.completed_at, `${path}.completed_at`, `operational.${kind}`, 128);
  return {
    id,
    name,
    kind,
    status,
    ...(conclusion === undefined ? {} : { conclusion }),
    ...(description === undefined ? {} : { description }),
    ...(url === undefined ? {} : { url }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function parseOperationalChangedFile(value: unknown, path: string): GitHubOperationalChangedFile {
  const record = responseRecord(value, "operational.file");
  const additions = optionalProviderNumber(record.additions, `${path}.additions`, "operational.file");
  const deletions = optionalProviderNumber(record.deletions, `${path}.deletions`, "operational.file");
  const changes = optionalProviderNumber(record.changes, `${path}.changes`, "operational.file");
  const status = optionalProviderText(record.status, `${path}.status`, "operational.file", 64);
  const sha = optionalProviderText(record.sha, `${path}.sha`, "operational.file", 128);
  const blobUrl = optionalProviderText(record.blob_url, `${path}.blob_url`, "operational.file", 2_048);
  const rawUrl = optionalProviderText(record.raw_url, `${path}.raw_url`, "operational.file", 2_048);
  const contentsUrl = optionalProviderText(record.contents_url, `${path}.contents_url`, "operational.file", 2_048);
  return {
    filename: providerText(record.filename, `${path}.filename`, "operational.file", 512),
    ...(status === undefined ? {} : { status }),
    ...(additions === undefined ? {} : { additions }),
    ...(deletions === undefined ? {} : { deletions }),
    ...(changes === undefined ? {} : { changes }),
    ...(sha === undefined ? {} : { sha }),
    ...(blobUrl === undefined ? {} : { blobUrl }),
    ...(rawUrl === undefined ? {} : { rawUrl }),
    ...(contentsUrl === undefined ? {} : { contentsUrl }),
  };
}

function nextPageFromLink(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const next = value.split(",").find((part) => /;\s*rel="next"/iu.test(part));
  if (next === undefined) return undefined;
  const match = /[?&]page=(\d+)/u.exec(next);
  if (match === null) return undefined;
  const page = Number(match[1]);
  return Number.isSafeInteger(page) && page > 0 ? page : undefined;
}

function operationalCollectionFailure<T>(
  path: string,
  items: readonly T[],
  pages: number,
  nextPage: number,
  message: string,
): GitHubOperationalCollection<T> {
  return {
    status: "unavailable",
    items,
    pagination: {
      perPage: OPERATIONAL_PAGE_SIZE,
      pages,
      returned: items.length,
      truncated: true,
      nextPage,
    },
    diagnostics: [{ code: "OPERATIONAL_COLLECTION_READ_FAILED", path, message }],
  };
}

function operationalCollectionUnavailable<T>(
  path: string,
  items: readonly T[],
  pages: number,
  message: string,
): GitHubOperationalCollection<T> {
  return {
    status: "unavailable",
    items,
    pagination: { perPage: OPERATIONAL_PAGE_SIZE, pages, returned: items.length, truncated: false },
    diagnostics: [{ code: "OPERATIONAL_COLLECTION_UNAVAILABLE", path, message }],
  };
}

function unavailableOperationalCollection<T>(path: string, message: string): GitHubOperationalCollection<T> {
  return operationalCollectionUnavailable(path, [], 0, message);
}

function combineOperationalPagination(
  left: GitHubOperationalPagination,
  right: GitHubOperationalPagination,
  returned: number,
): GitHubOperationalPagination {
  const truncated = left.truncated || right.truncated;
  const nextPage = left.nextPage ?? right.nextPage;
  return {
    perPage: OPERATIONAL_PAGE_SIZE,
    pages: Math.max(left.pages, right.pages),
    returned,
    truncated,
    ...(truncated && nextPage !== undefined ? { nextPage } : {}),
  };
}

function compareOperationalChecks(left: GitHubOperationalCheck, right: GitHubOperationalCheck): number {
  return (
    left.name.localeCompare(right.name, "en-US") ||
    left.kind.localeCompare(right.kind, "en-US") ||
    left.id.localeCompare(right.id, "en-US")
  );
}

function compareOperationalChangedFiles(
  left: GitHubOperationalChangedFile,
  right: GitHubOperationalChangedFile,
): number {
  return (
    left.filename.localeCompare(right.filename, "en-US") || (left.sha ?? "").localeCompare(right.sha ?? "", "en-US")
  );
}

function compareOperationalActors(left: GitHubOperationalActor, right: GitHubOperationalActor): number {
  return operationalActorKey(left).localeCompare(operationalActorKey(right), "en-US");
}

function operationalActorKey(actor: GitHubOperationalActor): string {
  return `${actor.login ?? ""}\u0000${actor.name ?? ""}\u0000${actor.id ?? 0}\u0000${actor.url ?? ""}`;
}

function parseIssue(value: unknown, operation: string, repositoryId?: string, repositoryHost?: string): GitHubIssue {
  const record = responseRecord(value, operation);
  const number = responseNumber(record.number, "number", operation);
  if (record.pull_request !== undefined) throw new GitHubResourceKindMismatchError(operation, number);
  const title = responseString(record.title, "title", operation);
  const state = responseState(record.state, operation);
  const url = responseUrl(record, operation);
  const body = record.body === null ? null : responseString(record.body, "body", operation);
  const milestone = responseMilestone(record.milestone, "milestone", operation);
  return {
    number,
    title,
    body,
    state,
    url,
    labels: responseNames(record.labels, "labels", operation),
    assignees: responseNames(record.assignees, "assignees", operation),
    ...(milestone === undefined ? {} : { milestone }),
    ...(repositoryId === undefined ? {} : { repositoryId }),
    ...(repositoryHost === undefined ? {} : { repositoryHost }),
  };
}

function parsePullRequest(value: unknown, operation: string): GitHubPullRequest {
  const record = responseRecord(value, operation);
  const number = responseNumber(record.number, "number", operation);
  const title = responseString(record.title, "title", operation);
  const state = responseState(record.state, operation);
  const url = responseUrl(record, operation);
  const body = record.body === null ? null : responseString(record.body, "body", operation);
  const draft = responseBoolean(record.draft, "draft", operation);
  const maintainerCanModify =
    record.maintainer_can_modify === undefined
      ? undefined
      : responseBoolean(record.maintainer_can_modify, "maintainer_can_modify", operation);
  const head = responseRef(record.head, "head", operation);
  const base = responseRef(record.base, "base", operation);
  const milestone = responseMilestone(record.milestone, "milestone", operation);
  const labels = record.labels === undefined ? undefined : responseNames(record.labels, "labels", operation);
  const assignees =
    record.assignees === undefined ? undefined : responseNames(record.assignees, "assignees", operation);
  const requestedReviewers = responseReviewRequests(record, operation);
  return {
    number,
    title,
    body,
    state,
    url,
    draft,
    ...(maintainerCanModify === undefined ? {} : { maintainerCanModify }),
    head,
    base,
    ...(labels === undefined ? {} : { labels }),
    ...(assignees === undefined ? {} : { assignees }),
    ...(milestone === undefined ? {} : { milestone }),
    ...(requestedReviewers === undefined ? {} : { requestedReviewers }),
  };
}

function parseBranch(value: unknown, expectedName: string, operation: string): GitHubBranch {
  const record = responseRecord(value, operation);
  const ref = responseString(record.ref, "ref", operation);
  const expectedRef = `refs/heads/${expectedName}`;
  if (ref !== expectedRef || !isRecord(record.object) || record.object.type !== "commit") {
    throw new GitHubApiResponseError(operation, "GitHub returned an invalid branch ref.", { path: "ref" });
  }
  const sha = responseString(record.object.sha, "object.sha", operation);
  if (sha.length === 0 || sha.length > 128 || /[\u0000-\u001F\u007F]/u.test(sha)) {
    throw new GitHubApiResponseError(operation, "GitHub returned an invalid branch object SHA.", {
      path: "object.sha",
    });
  }
  return { name: expectedName, ref, sha };
}

function responseRecord(value: unknown, operation: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new GitHubApiResponseError(operation, `GitHub returned an invalid object during ${operation}.`);
  }
  return value;
}

function responseNumber(value: unknown, path: string, operation: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
      path,
    });
  }
  return value;
}

function responseString(value: unknown, path: string, operation: string): string {
  if (typeof value !== "string") {
    throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
      path,
    });
  }
  return value;
}

function responseBoolean(value: unknown, path: string, operation: string): boolean {
  if (typeof value !== "boolean") {
    throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
      path,
    });
  }
  return value;
}

function responseState(value: unknown, operation: string): "open" | "closed" {
  if (value !== "open" && value !== "closed") {
    throw new GitHubApiResponseError(operation, `GitHub response state is invalid during ${operation}.`, {
      path: "state",
    });
  }
  return value;
}

function responseUrl(record: Record<string, unknown>, operation: string): string {
  return responseString(record.html_url ?? record.url, "url", operation);
}

function responseNames(value: unknown, path: string, operation: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
      path,
    });
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new GitHubApiResponseError(
        operation,
        `GitHub response field ${path}[${index}] is invalid during ${operation}.`,
        { path: `${path}[${index}]` },
      );
    }
    return responseString(item.name ?? item.login, `${path}[${index}]`, operation);
  });
}

function responseMilestone(value: unknown, path: string, operation: string): GitHubMilestone | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
      path,
    });
  }
  return {
    number: responseNumber(value.number, `${path}.number`, operation),
    title: responseString(value.title, `${path}.title`, operation),
  };
}

// Absent means neither key was returned at all; once either is present, both
// must be well-formed so a partially-shaped response fails closed instead of
// silently reporting an incomplete reviewer set.
function responseReviewRequests(record: Record<string, unknown>, operation: string): GitHubReviewRequests | undefined {
  if (record.requested_reviewers === undefined && record.requested_teams === undefined) return undefined;
  return {
    users: responseUserLogins(record.requested_reviewers, "requested_reviewers", operation),
    teams: responseTeamSlugs(record.requested_teams, "requested_teams", operation),
  };
}

function responseUserLogins(value: unknown, path: string, operation: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
      path,
    });
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new GitHubApiResponseError(
        operation,
        `GitHub response field ${path}[${index}] is invalid during ${operation}.`,
        { path: `${path}[${index}]` },
      );
    }
    return responseString(item.login, `${path}[${index}].login`, operation);
  });
}

// Teams have no `login`; `slug` is the stable, URL-safe identifier (unlike
// the mutable display `name`), matching how GitHub itself addresses teams.
function responseTeamSlugs(value: unknown, path: string, operation: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
      path,
    });
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new GitHubApiResponseError(
        operation,
        `GitHub response field ${path}[${index}] is invalid during ${operation}.`,
        { path: `${path}[${index}]` },
      );
    }
    return responseString(item.slug, `${path}[${index}].slug`, operation);
  });
}

function responseRef(value: unknown, path: string, operation: string): string {
  if (!isRecord(value)) {
    throw new GitHubApiResponseError(operation, `GitHub response field ${path} is invalid during ${operation}.`, {
      path,
    });
  }
  return responseString(value.ref, `${path}.ref`, operation);
}

function assertRepositoryRef(value: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ContractViolationError("Repository governance ref must be a non-empty string.", "ref");
  }
}

function assertPullRequestRef(value: string, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255 || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new ContractViolationError("Pull request ref must be a bounded non-empty string.", path);
  }
}

function parseRepositoryTree(value: unknown, operation: string): RepositoryTree {
  const record = responseRecord(value, operation);
  if (record.truncated !== false) {
    throw new GitHubApiResponseError(
      operation,
      "GitHub returned a truncated repository tree; governance authority cannot be established.",
      { path: "truncated" },
    );
  }
  const sha = responseString(record.sha, "sha", operation);
  if (!Array.isArray(record.tree)) {
    throw new GitHubApiResponseError(operation, "GitHub repository tree response is missing tree entries.", {
      path: "tree",
    });
  }
  const entries: RepositoryTreeEntry[] = record.tree.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new GitHubApiResponseError(operation, `GitHub repository tree entry ${index} is invalid.`, {
        path: `tree[${index}]`,
      });
    }
    const entryPath = responseString(entry.path, `tree[${index}].path`, operation);
    const entrySha = responseString(entry.sha, `tree[${index}].sha`, operation);
    if (entry.type !== "blob" && entry.type !== "tree") {
      throw new GitHubApiResponseError(operation, `GitHub repository tree entry ${index} has an invalid type.`, {
        path: `tree[${index}].type`,
      });
    }
    return { path: entryPath, type: entry.type, sha: entrySha };
  });
  return { sha, entries };
}

function parseRepositoryOverride(repository: string, fallbackHostname: string): RepositoryContext {
  const value = repository.trim();
  if (value.length === 0) throw new InvalidRepositoryOverrideError(repository);

  if (/^https?:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 2) throw new Error("repository URL path must contain owner and name");
      const name = parts[1].replace(/\.git$/iu, "");
      return repositoryContext(url.hostname, parts[0], name, url.toString());
    } catch (error) {
      throw new InvalidRepositoryOverrideError(repository, error);
    }
  }

  const parts = value.split("/");
  try {
    if (parts.length === 2) return repositoryContext(fallbackHostname, parts[0], parts[1]);
    if (parts.length === 3) return repositoryContext(parts[0], parts[1], parts[2]);
  } catch (error) {
    throw new InvalidRepositoryOverrideError(repository, error);
  }
  throw new InvalidRepositoryOverrideError(repository);
}

function repositoryContextFromNameWithOwner(
  nameWithOwner: string,
  url: string | undefined,
  fallbackHostname: string,
  repositoryId?: string,
): RepositoryContext {
  const parts = nameWithOwner.split("/");
  if (parts.length !== 2) {
    throw new RepositoryResolutionError("Repository nameWithOwner must contain exactly owner/name.", {
      path: "nameWithOwner",
    });
  }
  const hostname = url === undefined ? fallbackHostname : repositoryUrlHostname(url, fallbackHostname);
  return repositoryContext(hostname, parts[0], parts[1], url, repositoryId);
}

function repositoryContext(
  hostname: string,
  owner: string,
  name: string,
  url?: string,
  repositoryId?: string,
): RepositoryContext {
  const normalizedHostname = hostname.trim().toLowerCase();
  if (!isValidHostname(normalizedHostname) || !isValidRepositorySegment(owner) || !isValidRepositorySegment(name)) {
    throw new RepositoryResolutionError("Repository identity contains an invalid hostname, owner, or name.", {
      path: "repository",
    });
  }
  const nameWithOwner = `${owner}/${name}`;
  return Object.freeze({
    hostname: normalizedHostname,
    host: normalizedHostname,
    owner,
    name,
    nameWithOwner,
    url: url ?? `https://${normalizedHostname}/${nameWithOwner}`,
    ...(repositoryId === undefined ? {} : { repositoryId }),
  });
}

function repositoryUrlHostname(url: string, fallbackHostname: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return fallbackHostname;
  }
}

function isValidHostname(value: string): boolean {
  return value.length > 0 && !/[\s/]/u.test(value);
}

function isValidRepositorySegment(value: string): boolean {
  if (value === "." || value === "..") return false;
  return /^[A-Za-z0-9_.-]+$/u.test(value);
}

function isStableRepositoryId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/u.test(value);
}

function parseRepositoryDatabaseId(value: string): string | undefined {
  const normalized = value.trim();
  return isStableRepositoryId(normalized) ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isErrno(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code;
}

function summarize(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed;
}
