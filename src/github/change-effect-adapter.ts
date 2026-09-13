import { createHash } from "node:crypto";
import {
  MAX_CHANGE_BRANCH_LENGTH,
  MAX_CHANGE_COMMIT_SHA_LENGTH,
  CHANGE_EFFECT_FAILURE_PROVIDER_CODES,
  CHANGE_EFFECT_FAILURE_PROVIDER_FIELDS,
  CHANGE_EFFECT_FAILURE_PROVIDER_RESOURCES,
  MAX_CHANGE_HOST_LENGTH,
  normalizeChangeEffectFailureClassification,
  validateChangeEffect,
  type ChangeDiagnostic,
  type ChangeEffectFailureClassification,
  type ChangeEffectFailureProviderCategory,
  type ChangeEffectFailureProviderCode,
  type ChangeEffectFailureProviderDiagnostic,
  type ChangeEffectFailureProviderField,
  type ChangeEffectFailureProviderResource,
  type ChangeEffect,
  type ChangeEffectKind,
  type ChangeEffectSuccessEvidence,
  type ChangeIssuanceFailureEvidence,
} from "../change.js";
import { readChangeEffectFailureClassification } from "../change-failure-diagnostics.js";
import {
  changeProvenanceRecordPath,
  renderChangeProvenanceRecord,
  verifyChangeProvenanceRecord,
  type SignedChangeProvenanceRecord,
} from "../change-provenance-record.js";
import type { RuntimeAuthority } from "../agent-authority/runtime-authority.js";
import type { GitHubBranchAdvanceCapability } from "./git-data-capability.js";

/** The repository target is resolved by the trusted caller, not by this adapter. */
export interface GitHubChangeEffectRepository {
  readonly hostname: string;
  readonly owner: string;
  readonly name: string;
}

export type GitHubChangeEffectHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type GitHubChangeEffectJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GitHubChangeEffectJsonValue[]
  | { readonly [key: string]: GitHubChangeEffectJsonValue };

export type GitHubChangeEffectJsonObject = { readonly [key: string]: GitHubChangeEffectJsonValue };

/** API request data owned by the GitHub adapter boundary. */
export interface GitHubChangeEffectRequest {
  readonly hostname: string;
  readonly method: GitHubChangeEffectHttpMethod;
  readonly path: string;
  readonly body?: GitHubChangeEffectJsonObject;
}

/** The transport returns an opaque response which is consumed and discarded by the adapter. */
export interface GitHubChangeEffectResponse {
  readonly status: number;
  readonly body?: unknown;
}

/**
 * Explicit execution boundary for a future App, Actions, or service transport.
 * Credentials and transport errors remain owned by the implementation.
 */
export interface GitHubChangeEffectTransport {
  request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse>;
  /**
   * Provider-native compare-and-delete. REST GitHub does not implement this
   * operation; the Actions transport supplies the GraphQL equivalent when
   * available. It is never emulated by a GET followed by an unconditional
   * DELETE.
   */
  readonly compareAndDeleteBranch?: (
    request: GitHubChangeEffectCompareAndDeleteRequest,
  ) => Promise<GitHubChangeEffectCompareAndDeleteOutcome>;
}

export interface GitHubChangeEffectCompareAndDeleteRequest {
  readonly branch: string;
  readonly expectedCommitSha: string;
}

export const GITHUB_CHANGE_EFFECT_COMPARE_AND_DELETE_OUTCOMES = Object.freeze([
  "deleted",
  "absent",
  "mismatch",
] as const);
export type GitHubChangeEffectCompareAndDeleteOutcome =
  (typeof GITHUB_CHANGE_EFFECT_COMPARE_AND_DELETE_OUTCOMES)[number];

export interface GitHubChangeEffectAdapterOptions {
  readonly repository: GitHubChangeEffectRepository;
  readonly transport: GitHubChangeEffectTransport;
  /** Trusted runtime signing and Git-data capability for the provenance effect. */
  readonly provenance?: GitHubChangeProvenanceExecutionOptions;
}

export interface GitHubChangeProvenanceExecutionOptions {
  readonly runtimeAuthority: RuntimeAuthority;
  /** Already Runtime-signed elsewhere; this boundary only verifies it. */
  readonly signedRecord: SignedChangeProvenanceRecord;
  readonly gitData: GitHubBranchAdvanceCapability;
}

export type GitHubChangeProvenanceSignerOptions = Omit<GitHubChangeProvenanceExecutionOptions, "gitData">;

export const GITHUB_CHANGE_EFFECT_FAILURE_CODES = Object.freeze({
  CREATE_BRANCH: "BRANCH_CREATE_FAILED",
  CREATE_PROVENANCE_COMMIT: "PROVENANCE_COMMIT_CREATE_FAILED",
  CREATE_PULL_REQUEST: "PULL_REQUEST_CREATE_FAILED",
  MARK_PULL_REQUEST_READY: "PULL_REQUEST_READY_FAILED",
  CLOSE_PULL_REQUEST: "PULL_REQUEST_CLOSE_FAILED",
  DELETE_BRANCH: "BRANCH_DELETE_FAILED",
} as const satisfies Readonly<Record<ChangeEffectKind, string>>);

export type GitHubChangeEffectFailureCode = (typeof GITHUB_CHANGE_EFFECT_FAILURE_CODES)[ChangeEffectKind];

export const GITHUB_CHANGE_EFFECT_FAILURE_MESSAGES: Readonly<Record<ChangeEffectKind, string>> = Object.freeze({
  CREATE_BRANCH: "The branch creation effect failed.",
  CREATE_PROVENANCE_COMMIT: "The signed provenance commit effect failed.",
  CREATE_PULL_REQUEST: "The pull request creation effect failed.",
  MARK_PULL_REQUEST_READY: "The pull request ready effect failed.",
  CLOSE_PULL_REQUEST: "The pull request close effect failed.",
  DELETE_BRANCH: "The branch deletion effect failed.",
});

/** Maximum serialized provider rejection input inspected by the normalizer. */
export const MAX_GITHUB_CHANGE_EFFECT_REJECTION_BODY_BYTES = 16_384 as const;
/** Maximum number of structured GitHub error entries inspected. */
export const MAX_GITHUB_CHANGE_EFFECT_REJECTION_ERRORS = 8 as const;

const GITHUB_REJECTION_CATEGORY_BY_STATUS: Readonly<Record<number, ChangeEffectFailureProviderCategory>> =
  Object.freeze({
    401: "authentication-failed",
    409: "conflict",
    422: "validation-failed",
    429: "rate-limit",
  });

/** Structured GraphQL error codes that can be projected onto the existing taxonomy. */
const GITHUB_GRAPHQL_REJECTION_CATEGORY_BY_CODE: Readonly<Record<string, ChangeEffectFailureProviderCategory>> =
  Object.freeze({
    BAD_USER_INPUT: "validation-failed",
    CONFLICT: "conflict",
    FORBIDDEN: "authentication-failed",
    INVALID: "validation-failed",
    MISMATCH: "conflict",
    RATE_LIMIT: "rate-limit",
    RATE_LIMITED: "rate-limit",
    STALE: "conflict",
    THROTTLED: "rate-limit",
    UNAUTHENTICATED: "authentication-failed",
    UNAUTHORIZED: "authentication-failed",
    UNPROCESSABLE: "validation-failed",
    VALIDATION_FAILED: "validation-failed",
  });

/**
 * Project a GitHub rejection body into the existing bounded classification.
 * Only allowlisted scalar values are returned; the input is never retained.
 */
export function normalizeGitHubChangeEffectProviderDiagnostic(
  status: number,
  body: unknown,
): ChangeEffectFailureProviderDiagnostic | undefined {
  try {
    return normalizeGitHubChangeEffectProviderDiagnosticUnsafe(status, body);
  } catch {
    return undefined;
  }
}

function normalizeGitHubChangeEffectProviderDiagnosticUnsafe(
  status: number,
  body: unknown,
): ChangeEffectFailureProviderDiagnostic | undefined {
  const statusCategory = GITHUB_REJECTION_CATEGORY_BY_STATUS[status];
  if (body === undefined) {
    return statusCategory === undefined || statusCategory === "validation-failed"
      ? undefined
      : { category: statusCategory };
  }
  if (!isRecord(body)) return undefined;

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(body);
  } catch {
    return undefined;
  }
  if (serialized === undefined) return undefined;
  if (new TextEncoder().encode(serialized).byteLength > MAX_GITHUB_CHANGE_EFFECT_REJECTION_BODY_BYTES) {
    return undefined;
  }

  const category = statusCategory ?? graphqlRejectionCategory(status, body);
  if (category === undefined) return undefined;

  const rawErrors = body.errors;
  if (rawErrors === undefined) return category === "validation-failed" ? undefined : { category };
  if (
    !Array.isArray(rawErrors) ||
    rawErrors.length === 0 ||
    rawErrors.length > MAX_GITHUB_CHANGE_EFFECT_REJECTION_ERRORS
  ) {
    return undefined;
  }

  let detail: Omit<ChangeEffectFailureProviderDiagnostic, "category"> | undefined;
  for (const rawError of rawErrors) {
    if (!isRecord(rawError)) return undefined;
    const candidate = providerErrorDetail(rawError);
    if (candidate === undefined) continue;
    if (detail === undefined) detail = candidate;
  }
  if (category === "validation-failed" && detail === undefined && !isGraphqlRejection(status, body)) return undefined;
  return { category, ...(detail ?? {}) };
}

function isGraphqlRejection(status: number, body: unknown): boolean {
  return status === 200 && isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0;
}

function graphqlRejectionCategory(status: number, body: unknown): ChangeEffectFailureProviderCategory | undefined {
  if (!isGraphqlRejection(status, body)) return undefined;
  const errors = (body as Record<string, unknown>).errors;
  if (!Array.isArray(errors) || errors.length > MAX_GITHUB_CHANGE_EFFECT_REJECTION_ERRORS) return undefined;
  for (const error of errors) {
    if (!isRecord(error)) continue;
    const extensions = isRecord(error.extensions) ? error.extensions : undefined;
    for (const candidate of [error.type, error.code, extensions?.code]) {
      if (typeof candidate !== "string") continue;
      const category = GITHUB_GRAPHQL_REJECTION_CATEGORY_BY_CODE[candidate.toUpperCase()];
      if (category !== undefined) return category;
    }
  }
  return undefined;
}

function providerErrorDetail(
  value: Record<string, unknown>,
): Omit<ChangeEffectFailureProviderDiagnostic, "category"> | undefined {
  const detail: {
    resource?: ChangeEffectFailureProviderResource;
    field?: ChangeEffectFailureProviderField;
    code?: ChangeEffectFailureProviderCode;
  } = {};
  for (const key of ["resource", "field", "code"] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (typeof value[key] !== "string") return undefined;
    if (
      key === "resource" &&
      CHANGE_EFFECT_FAILURE_PROVIDER_RESOURCES.includes(value[key] as ChangeEffectFailureProviderResource)
    ) {
      detail.resource = value[key] as ChangeEffectFailureProviderResource;
    } else if (
      key === "field" &&
      CHANGE_EFFECT_FAILURE_PROVIDER_FIELDS.includes(value[key] as ChangeEffectFailureProviderField)
    ) {
      detail.field = value[key] as ChangeEffectFailureProviderField;
    } else if (
      key === "code" &&
      CHANGE_EFFECT_FAILURE_PROVIDER_CODES.includes(value[key] as ChangeEffectFailureProviderCode)
    ) {
      detail.code = value[key] as ChangeEffectFailureProviderCode;
    }
  }
  return Object.keys(detail).length === 0 ? undefined : detail;
}

/** Stable bounded failure evidence for a single explicit effect. */
export function changeEffectFailureEvidence(
  effect: ChangeEffect,
  classification?: ChangeEffectFailureClassification,
): ChangeIssuanceFailureEvidence {
  return {
    effect,
    code: GITHUB_CHANGE_EFFECT_FAILURE_CODES[effect.kind],
    message: GITHUB_CHANGE_EFFECT_FAILURE_MESSAGES[effect.kind],
    ...(classification === undefined ? {} : normalizeChangeEffectFailureClassification(classification)),
  };
}

const READY_FOR_REVIEW_MUTATION =
  "mutation PullRequestReadyForReview($input: MarkPullRequestReadyForReviewInput!) { " +
  "markPullRequestReadyForReview(input: $input) { " +
  "pullRequest { id number state isDraft } } }";

function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

/** Bounded success evidence; GitHub response bodies and URLs are intentionally absent. */
export type GitHubChangeEffectSuccessEvidence = ChangeEffectSuccessEvidence;

export type GitHubChangeEffectFailureEvidence = ChangeIssuanceFailureEvidence;

export interface GitHubChangeEffectSuccessResult {
  readonly status: "succeeded";
  readonly effect: ChangeEffect;
  readonly evidence: GitHubChangeEffectSuccessEvidence;
}

export interface GitHubChangeEffectFailureResult {
  readonly status: "failed";
  readonly effect: ChangeEffect;
  /** This is directly compatible with Core's compensation/recovery input. */
  readonly failure: GitHubChangeEffectFailureEvidence;
}

export type GitHubChangeEffectResult = GitHubChangeEffectSuccessResult | GitHubChangeEffectFailureResult;

/** Raised before transport execution when the supplied effect is not a Core effect contract value. */
export class GitHubChangeEffectContractError extends Error {
  readonly code = "CHANGE_EFFECT_INVALID" as const;
  readonly diagnostics: readonly ChangeDiagnostic[];

  constructor(diagnostics: readonly ChangeDiagnostic[] = []) {
    super("The GitHub Change effect adapter accepts only a valid explicit Core ChangeEffect.");
    this.name = "GitHubChangeEffectContractError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

export class GitHubChangeEffectConfigurationError extends Error {
  readonly code = "GITHUB_CHANGE_EFFECT_CONFIGURATION_INVALID" as const;

  constructor() {
    super("The GitHub Change effect adapter requires a valid repository and transport boundary.");
    this.name = "GitHubChangeEffectConfigurationError";
  }
}

/** Fixed, secret-safe classification for a provider-backed effect failure. */
export class GitHubChangeEffectFailureError extends Error {
  readonly classification: ChangeEffectFailureClassification;

  constructor(classification: ChangeEffectFailureClassification) {
    super("The GitHub Change effect failed at a bounded provider boundary.");
    this.name = "GitHubChangeEffectFailureError";
    this.classification = normalizeChangeEffectFailureClassification(classification)!;
  }
}

/**
 * Thin projection of one explicit Core effect onto GitHub's API resources.
 * It deliberately executes no plan, retry, idempotency, lifecycle, naming, or
 * compensation logic.
 */
export class GitHubChangeEffectAdapter {
  private readonly repository: GitHubChangeEffectRepository;
  private readonly transport: GitHubChangeEffectTransport;
  private readonly provenance: GitHubChangeProvenanceExecutionOptions | undefined;

  constructor(options: GitHubChangeEffectAdapterOptions) {
    assertRepository(options?.repository);
    if (!isRecord(options?.transport) || typeof options.transport.request !== "function") {
      throw new GitHubChangeEffectConfigurationError();
    }
    this.repository = { ...options.repository };
    this.transport = options.transport;
    this.provenance = options.provenance;
  }

  /** Execute exactly one explicit effect and normalize every execution failure. */
  async execute(effect: ChangeEffect): Promise<GitHubChangeEffectResult> {
    const explicitEffect = assertExplicitChangeEffect(effect);
    try {
      return {
        status: "succeeded",
        effect: explicitEffect,
        evidence: await this.executeExplicitEffect(explicitEffect),
      };
    } catch (error: unknown) {
      const classification =
        error instanceof GitHubChangeEffectFailureError
          ? error.classification
          : (readChangeEffectFailureClassification(error) ??
            (error instanceof InvalidGitHubResponseError
              ? { reason: "response-validation" as const }
              : { reason: "transport" as const }));
      return {
        status: "failed",
        effect: explicitEffect,
        failure: createFailureEvidence(explicitEffect, classification),
      };
    }
  }

  private async executeExplicitEffect(effect: ChangeEffect): Promise<GitHubChangeEffectSuccessEvidence> {
    switch (effect.kind) {
      case "CREATE_BRANCH":
        return this.createBranch(effect);
      case "CREATE_PROVENANCE_COMMIT":
        return this.createProvenanceCommit(effect);
      case "CREATE_PULL_REQUEST":
        return this.createPullRequest(effect);
      case "MARK_PULL_REQUEST_READY":
        return this.markPullRequestReady(effect);
      case "CLOSE_PULL_REQUEST":
        return this.closePullRequest(effect);
      case "DELETE_BRANCH":
        return this.deleteBranch(effect);
    }
  }

  private async createBranch(
    effect: Extract<ChangeEffect, { readonly kind: "CREATE_BRANCH" }>,
  ): Promise<GitHubChangeEffectSuccessEvidence> {
    const baseReference = await this.request(
      {
        method: "GET",
        path: `${this.repositoryPath()}/git/ref/heads/${encodeURIComponent(effect.baseBranch)}`,
      },
      200,
    );
    const baseSha = parseGitReference(baseReference, `refs/heads/${effect.baseBranch}`);
    const createdReference = await this.request(
      {
        method: "POST",
        path: `${this.repositoryPath()}/git/refs`,
        body: { ref: `refs/heads/${effect.branch}`, sha: baseSha },
      },
      201,
    );
    const createdCommitSha = parseGitReference(createdReference, `refs/heads/${effect.branch}`);
    return { kind: effect.kind, branch: effect.branch, baseBranch: effect.baseBranch, createdCommitSha };
  }

  private async createProvenanceCommit(
    effect: Extract<ChangeEffect, { readonly kind: "CREATE_PROVENANCE_COMMIT" }>,
  ): Promise<GitHubChangeEffectSuccessEvidence> {
    const provenance = this.provenance;
    if (provenance === undefined) throw new GitHubChangeEffectConfigurationError();
    if (effect.path !== changeProvenanceRecordPath(effect.rootIssue)) throw new InvalidGitHubResponseError();

    // The Runtime signs the provenance payload before this request ever
    // crosses into the App/executor boundary; this adapter only verifies the
    // already-signed record against the repository-trusted Runtime public
    // key. It never imports or holds a Runtime private key.
    const record = provenance.signedRecord;
    const signedPayload = verifyChangeProvenanceRecord(record, provenance.runtimeAuthority);
    if (signedPayload.rootIssue !== effect.rootIssue || signedPayload.operation !== "change.issue") {
      throw new InvalidGitHubResponseError();
    }
    const content = renderChangeProvenanceRecord(record);
    const capability = provenance.gitData;
    const head = await capability.readRef(effect.branch);
    if (head === undefined) throw new InvalidGitHubResponseError();
    const commit = await capability.readCommit(head.sha);
    const tree = await capability.readTree(commit.treeSha);
    const existing = tree.entries.filter((entry) => entry.path === effect.path);
    if (existing.length > 1) throw new InvalidGitHubResponseError();
    const existingEntry = existing[0];
    if (existingEntry !== undefined) {
      if (existingEntry.type !== "blob" || capability.readBlob === undefined) throw new InvalidGitHubResponseError();
      const existingContent = await capability.readBlob(existingEntry.sha);
      const payload = verifyChangeProvenanceRecord(existingContent, provenance.runtimeAuthority);
      if (payload.rootIssue !== effect.rootIssue || payload.operation !== "change.issue") {
        throw new InvalidGitHubResponseError();
      }
      return {
        kind: effect.kind,
        branch: effect.branch,
        rootIssue: effect.rootIssue,
        path: effect.path,
        createdCommitSha: head.sha,
      };
    }

    const encoded = Buffer.from(content, "utf8").toString("base64");
    const blob = await capability.createBlob({ content: encoded });
    if (blob.sha !== gitBlobSha(content)) throw new InvalidGitHubResponseError();
    const nextTree = await capability.createTree({
      baseTreeSha: commit.treeSha,
      entries: [{ path: effect.path, mode: "100644", type: "blob", sha: blob.sha }],
    });
    const nextCommit = await capability.createCommit({
      message: `Change #${effect.rootIssue}: record signed provenance`,
      treeSha: nextTree.sha,
      parents: [head.sha],
    });
    await capability.compareAndAdvanceRef({
      branch: effect.branch,
      beforeOid: head.sha,
      afterOid: nextCommit.sha,
      force: false,
    });
    const reread = await capability.readRef(effect.branch);
    if (reread?.sha !== nextCommit.sha) {
      // A rejected/ambiguous update is never silently converted into success;
      // a later issuance can only replay the exact committed record.
      throw new InvalidGitHubResponseError();
    }
    return {
      kind: effect.kind,
      branch: effect.branch,
      rootIssue: effect.rootIssue,
      path: effect.path,
      createdCommitSha: reread.sha,
    };
  }

  private async createPullRequest(
    effect: Extract<ChangeEffect, { readonly kind: "CREATE_PULL_REQUEST" }>,
  ): Promise<GitHubChangeEffectSuccessEvidence> {
    const desired = effect.semanticPullRequestPlan?.desired;
    const response = await this.request(
      {
        method: "POST",
        path: `${this.repositoryPath()}/pulls`,
        body: {
          head: desired?.head ?? effect.branch,
          base: desired?.base ?? effect.baseBranch,
          title: desired?.title ?? effect.title,
          body: desired?.body ?? effect.body,
          draft: effect.draft,
          ...(desired?.metadata.maintainerCanModify === undefined
            ? {}
            : { maintainer_can_modify: desired.metadata.maintainerCanModify }),
        },
      },
      201,
    );
    const record = responseRecord(response);
    const pullRequest = responseNumber(record.number);
    // GitHub Issue and pull-request numbers share a namespace. Equality here
    // is the observable signature of Issue-to-PR conversion, never a valid
    // Change issuance result.
    if (pullRequest === effect.rootIssue) throw new InvalidGitHubResponseError();
    if (record.state !== "open" || record.draft !== true) throw new InvalidGitHubResponseError();
    responseBranch(record.head, desired?.head ?? effect.branch);
    responseBranch(record.base, desired?.base ?? effect.baseBranch);
    if (
      desired !== undefined &&
      desired.metadata.maintainerCanModify !== undefined &&
      record.maintainer_can_modify !== desired.metadata.maintainerCanModify
    ) {
      throw new InvalidGitHubResponseError();
    }
    if (
      desired !== undefined &&
      ((desired.metadata.labels?.length ?? 0) > 0 || (desired.metadata.assignees?.length ?? 0) > 0)
    ) {
      const metadataResponse = responseRecord(
        await this.request(
          {
            method: "PATCH",
            path: `${this.repositoryPath()}/issues/${pullRequest}`,
            body: {
              ...(desired.metadata.labels === undefined ? {} : { labels: desired.metadata.labels }),
              ...(desired.metadata.assignees === undefined ? {} : { assignees: desired.metadata.assignees }),
            },
          },
          200,
        ),
      );
      if (desired.metadata.labels !== undefined)
        responseStringSet(metadataResponse.labels, "name", desired.metadata.labels);
      if (desired.metadata.assignees !== undefined)
        responseStringSet(metadataResponse.assignees, "login", desired.metadata.assignees);
    }
    return {
      kind: effect.kind,
      branch: effect.branch,
      baseBranch: effect.baseBranch,
      rootIssue: effect.rootIssue,
      pullRequest,
    };
  }

  private async markPullRequestReady(
    effect: Extract<ChangeEffect, { readonly kind: "MARK_PULL_REQUEST_READY" }>,
  ): Promise<GitHubChangeEffectSuccessEvidence> {
    const current = responseRecord(
      await this.request(
        {
          method: "GET",
          path: `${this.repositoryPath()}/pulls/${effect.pullRequest}`,
        },
        200,
      ),
    );
    if (responseNumber(current.number) !== effect.pullRequest || current.state !== "open" || current.draft !== true) {
      throw new InvalidGitHubResponseError();
    }
    const nodeId = responseBoundedString(current.node_id);

    const response = await this.request(
      {
        method: "POST",
        path: "graphql",
        body: {
          operationName: "PullRequestReadyForReview",
          query: READY_FOR_REVIEW_MUTATION,
          variables: { input: { pullRequestId: nodeId } },
        },
      },
      200,
    );
    const envelope = responseRecord(response);
    if (envelope.errors !== undefined || !isRecord(envelope.data)) {
      throw new InvalidGitHubResponseError();
    }
    const mutation = responseRecord(envelope.data.markPullRequestReadyForReview);
    const record = responseRecord(mutation.pullRequest);
    if (
      record.id !== nodeId ||
      responseNumber(record.number) !== effect.pullRequest ||
      record.state !== "OPEN" ||
      record.isDraft !== false
    ) {
      throw new InvalidGitHubResponseError();
    }
    return { kind: effect.kind, pullRequest: effect.pullRequest };
  }

  private async closePullRequest(
    effect: Extract<ChangeEffect, { readonly kind: "CLOSE_PULL_REQUEST" }>,
  ): Promise<GitHubChangeEffectSuccessEvidence> {
    const response = await this.request(
      {
        method: "PATCH",
        path: `${this.repositoryPath()}/pulls/${effect.pullRequest}`,
        body: { state: "closed" },
      },
      200,
    );
    const record = responseRecord(response);
    if (responseNumber(record.number) !== effect.pullRequest || record.state !== "closed") {
      throw new InvalidGitHubResponseError();
    }
    return { kind: effect.kind, pullRequest: effect.pullRequest };
  }

  private async deleteBranch(
    effect: Extract<ChangeEffect, { readonly kind: "DELETE_BRANCH" }>,
  ): Promise<GitHubChangeEffectSuccessEvidence> {
    const expectedCommitSha = effect.expectedCommitSha;
    if (expectedCommitSha !== undefined) return this.deleteBranchIfUnchanged({ ...effect, expectedCommitSha });
    const response = await this.request(
      {
        method: "DELETE",
        path: `${this.repositoryPath()}/git/refs/heads/${encodeURIComponent(effect.branch)}`,
      },
      204,
    );
    if (response !== undefined && response !== null && response !== "") throw new InvalidGitHubResponseError();
    return { kind: effect.kind, branch: effect.branch };
  }

  private async deleteBranchIfUnchanged(
    effect: Extract<ChangeEffect, { readonly kind: "DELETE_BRANCH" }> & { readonly expectedCommitSha: string },
  ): Promise<GitHubChangeEffectSuccessEvidence> {
    const currentCommitSha = await this.readBranchCommitSha(effect.branch);
    if (currentCommitSha === undefined) {
      return {
        kind: effect.kind,
        branch: effect.branch,
        expectedCommitSha: effect.expectedCommitSha,
        outcome: "absent",
      };
    }
    if (currentCommitSha !== effect.expectedCommitSha) {
      throw new GitHubChangeEffectFailureError({ reason: "generation-mismatch" });
    }

    if (typeof this.transport.compareAndDeleteBranch !== "function") throw new InvalidGitHubResponseError();
    const outcome = await this.transport.compareAndDeleteBranch({
      branch: effect.branch,
      expectedCommitSha: effect.expectedCommitSha,
    });
    if (outcome === "mismatch") {
      throw new GitHubChangeEffectFailureError({ reason: "generation-mismatch" });
    }
    if (outcome !== "deleted" && outcome !== "absent") throw new InvalidGitHubResponseError();
    return {
      kind: effect.kind,
      branch: effect.branch,
      expectedCommitSha: effect.expectedCommitSha,
      outcome,
    };
  }

  private async readBranchCommitSha(branch: string): Promise<string | undefined> {
    let response: GitHubChangeEffectResponse;
    try {
      response = await this.transport.request({
        hostname: this.repository.hostname,
        method: "GET",
        path: `${this.repositoryPath()}/git/ref/heads/${encodeURIComponent(branch)}`,
      });
    } catch (error: unknown) {
      if (error instanceof GitHubChangeEffectFailureError) throw error;
      throw new GitHubChangeEffectFailureError({ reason: "transport" });
    }
    if (!isRecord(response) || !isHttpStatus(response.status)) {
      throw new GitHubChangeEffectFailureError({ reason: "response-validation" });
    }
    if (response.status === 404) return undefined;
    if (response.status !== 200) {
      const provider = normalizeGitHubChangeEffectProviderDiagnostic(response.status, response.body);
      throw new GitHubChangeEffectFailureError({
        reason: "provider-http",
        status: response.status,
        ...(provider === undefined ? {} : { provider }),
      });
    }
    return parseGitReference(response.body, `refs/heads/${branch}`);
  }

  private async request(
    request: Omit<GitHubChangeEffectRequest, "hostname">,
    expectedStatus: number,
  ): Promise<unknown> {
    try {
      const response = await this.transport.request({ ...request, hostname: this.repository.hostname });
      if (!isRecord(response) || !isHttpStatus(response.status)) {
        throw new GitHubChangeEffectFailureError({ reason: "response-validation" });
      }
      if (response.status !== expectedStatus) {
        const provider = normalizeGitHubChangeEffectProviderDiagnostic(response.status, response.body);
        throw new GitHubChangeEffectFailureError({
          reason: "provider-http",
          status: response.status,
          ...(provider === undefined ? {} : { provider }),
        });
      }
      return response.body;
    } catch (error: unknown) {
      if (error instanceof GitHubChangeEffectFailureError) throw error;
      if (error instanceof InvalidGitHubResponseError) {
        throw new GitHubChangeEffectFailureError({ reason: "response-validation" });
      }
      throw new GitHubChangeEffectFailureError({ reason: "transport" });
    }
  }

  private repositoryPath(): string {
    return `repos/${this.repository.owner}/${this.repository.name}`;
  }
}

function assertExplicitChangeEffect(input: unknown): ChangeEffect {
  try {
    const result = validateChangeEffect(input);
    if (!result.valid || result.effect === undefined) throw new GitHubChangeEffectContractError(result.diagnostics);
  } catch (error) {
    if (error instanceof GitHubChangeEffectContractError) throw error;
    throw new GitHubChangeEffectContractError();
  }
  // Keep the caller's explicit values. Core validation is a gate, not an
  // instruction for this adapter to canonicalize or repair the effect.
  return input as ChangeEffect;
}

function createFailureEvidence(
  effect: ChangeEffect,
  classification?: ChangeEffectFailureClassification,
): GitHubChangeEffectFailureEvidence {
  return changeEffectFailureEvidence(effect, classification);
}

function parseGitReference(value: unknown, expectedRef: string): string {
  const record = responseRecord(value);
  if (record.ref !== expectedRef || !isRecord(record.object) || record.object.type !== "commit") {
    throw new InvalidGitHubResponseError();
  }
  return responseCommitSha(record.object.sha);
}

function responseBranch(value: unknown, expected: string): void {
  if (!isRecord(value) || value.ref !== expected) throw new InvalidGitHubResponseError();
}

function responseRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidGitHubResponseError();
  return value;
}

function responseNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new InvalidGitHubResponseError();
  }
  return value;
}

function responseBoundedString(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CHANGE_BRANCH_LENGTH ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new InvalidGitHubResponseError();
  }
  return value;
}

function responseCommitSha(value: unknown): string {
  if (typeof value !== "string" || value.length !== MAX_CHANGE_COMMIT_SHA_LENGTH || !/^[0-9a-f]{40}$/iu.test(value)) {
    throw new InvalidGitHubResponseError();
  }
  return value.toLowerCase();
}

function responseStringSet(value: unknown, property: string, expected: readonly string[]): void {
  if (!Array.isArray(value)) throw new InvalidGitHubResponseError();
  const actual = value.map((entry) => {
    if (!isRecord(entry)) throw new InvalidGitHubResponseError();
    return responseBoundedString(entry[property]);
  });
  const sort = (items: readonly string[]): string[] =>
    [...items].sort((left, right) => left.localeCompare(right, "en-US"));
  if (JSON.stringify(sort(actual)) !== JSON.stringify(sort(expected))) throw new InvalidGitHubResponseError();
}

function assertRepository(value: unknown): asserts value is GitHubChangeEffectRepository {
  if (
    !isRecord(value) ||
    !validHostname(value.hostname) ||
    !validRepositorySegment(value.owner) ||
    !validRepositorySegment(value.name)
  ) {
    throw new GitHubChangeEffectConfigurationError();
  }
}

function validHostname(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CHANGE_HOST_LENGTH &&
    !/[\u0000-\u001F\u007F\s/]/u.test(value)
  );
}

function validRepositorySegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CHANGE_BRANCH_LENGTH &&
    /^[A-Za-z0-9_.-]+$/u.test(value)
  );
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class InvalidGitHubResponseError extends Error {
  constructor() {
    super("GitHub response was invalid.");
    this.name = "InvalidGitHubResponseError";
  }
}
