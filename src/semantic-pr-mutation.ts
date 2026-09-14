/**
 * Governed Semantic PR write authority.
 *
 * This module is the provider-independent authority for bounded conversation
 * comments, reviews, and merges.  It validates and materializes requests,
 * admits them against execution-time evidence, delegates one bounded effect to
 * a provider adapter, rereads the resource, and only then returns success.
 * Change lifecycle state is deliberately not represented here.
 */

import type {
  GitHubPullRequest,
  GitHubPullRequestComment,
  GitHubPullRequestMergePolicyEvidence,
  GitHubPullRequestMergeResponse,
  GitHubPullRequestReview,
  RepositoryContext,
} from "./github/types.js";
import { tryObserveSemanticPullRequest } from "./semantic-pr-observation.js";

export const SEMANTIC_PULL_REQUEST_MUTATION_CONTRACT_VERSION = "1" as const;
export type SemanticPullRequestMutationContractVersion = typeof SEMANTIC_PULL_REQUEST_MUTATION_CONTRACT_VERSION;

export const SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION = "1" as const;
export type SemanticPullRequestMutationPlanVersion = typeof SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION;

export const SEMANTIC_PULL_REQUEST_MUTATION_LIMITS = Object.freeze({
  bodyBytes: 65_536,
  expectedHeadLength: 128,
  expectedBaseLength: 512,
  diagnostics: 32,
  diagnosticMessageLength: 500,
} as const);

export type SemanticPullRequestMutationOperation = "comment" | "review" | "merge";
export type SemanticPullRequestMutationOutcome =
  "succeeded" | "idempotent" | "stale" | "blocked" | "failed" | "recovery-required";

export type SemanticPullRequestReviewIntent = "approve" | "request-changes" | "comment-only";
export type SemanticPullRequestRetryMode = "reject-duplicate" | "allow-duplicate";
export type SemanticPullRequestMergeStrategy = "merge" | "squash" | "rebase";

export interface SemanticPullRequestRepositoryIdentity {
  readonly hostname: string;
  readonly nameWithOwner: string;
  readonly repositoryId?: string;
}

export interface SemanticPullRequestCommentRequest {
  readonly version: SemanticPullRequestMutationContractVersion;
  readonly operation: "comment";
  readonly repository: SemanticPullRequestRepositoryIdentity;
  readonly pullRequest: number;
  readonly body: string;
  readonly expectedHead?: string;
}

export interface SemanticPullRequestReviewRequest {
  readonly version: SemanticPullRequestMutationContractVersion;
  readonly operation: "review";
  readonly repository: SemanticPullRequestRepositoryIdentity;
  readonly pullRequest: number;
  readonly expectedHead: string;
  readonly intent: SemanticPullRequestReviewIntent;
  readonly body: string;
  readonly retry: SemanticPullRequestRetryMode;
}

export interface SemanticPullRequestMergeRequest {
  readonly version: SemanticPullRequestMutationContractVersion;
  readonly operation: "merge";
  readonly repository: SemanticPullRequestRepositoryIdentity;
  readonly pullRequest: number;
  readonly expectedHead: string;
  readonly expectedBase: string;
  readonly strategy: SemanticPullRequestMergeStrategy;
}

export type SemanticPullRequestMutationRequest =
  SemanticPullRequestCommentRequest | SemanticPullRequestReviewRequest | SemanticPullRequestMergeRequest;

export type SemanticPullRequestMutationPrecondition =
  | {
      readonly kind: "PULL_REQUEST_IDENTITY_MATCH";
      readonly repository: SemanticPullRequestRepositoryIdentity;
      readonly pullRequest: number;
    }
  | {
      readonly kind: "PULL_REQUEST_HEAD_MATCH";
      readonly expectedHead: string;
    }
  | {
      readonly kind: "PULL_REQUEST_BASE_MATCH";
      readonly expectedBase: string;
    }
  | {
      readonly kind: "PULL_REQUEST_NOT_DRAFT";
    }
  | {
      readonly kind: "PULL_REQUEST_MERGEABLE";
    };

export type SemanticPullRequestMutationEffect =
  | {
      readonly kind: "CREATE_CONVERSATION_COMMENT";
      readonly body: string;
    }
  | {
      readonly kind: "SUBMIT_REVIEW";
      readonly intent: SemanticPullRequestReviewIntent;
      readonly body: string;
    }
  | {
      readonly kind: "MERGE_PULL_REQUEST";
      readonly strategy: SemanticPullRequestMergeStrategy;
    };

export interface SemanticPullRequestMutationPlan {
  readonly version: SemanticPullRequestMutationPlanVersion;
  readonly kind: "pull_request_mutation";
  readonly operation: SemanticPullRequestMutationOperation;
  readonly request: SemanticPullRequestMutationRequest;
  readonly preconditions: readonly SemanticPullRequestMutationPrecondition[];
  readonly effects: readonly [SemanticPullRequestMutationEffect];
}

export type SemanticPullRequestMutationViolationCode =
  | "PR_MUTATION_REQUEST_INVALID"
  | "PR_MUTATION_REQUEST_UNKNOWN_PROPERTY"
  | "PR_MUTATION_REQUEST_VALUE_INVALID"
  | "PR_MUTATION_PLAN_INVALID";

export interface SemanticPullRequestMutationViolation {
  readonly code: SemanticPullRequestMutationViolationCode;
  readonly path: string;
  readonly message: string;
}

export interface SemanticPullRequestMutationRequestResult {
  readonly valid: boolean;
  readonly request?: SemanticPullRequestMutationRequest;
  readonly violations: readonly SemanticPullRequestMutationViolation[];
}

export interface SemanticPullRequestMutationPlanResult {
  readonly valid: boolean;
  readonly plan?: SemanticPullRequestMutationPlan;
  readonly violations: readonly SemanticPullRequestMutationViolation[];
}

export class SemanticPullRequestMutationValidationError extends Error {
  readonly violations: readonly SemanticPullRequestMutationViolation[];

  constructor(violations: readonly SemanticPullRequestMutationViolation[]) {
    super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
    this.name = "SemanticPullRequestMutationValidationError";
    this.violations = Object.freeze([...violations].slice(0, SEMANTIC_PULL_REQUEST_MUTATION_LIMITS.diagnostics));
  }
}

export interface SemanticPullRequestMutationDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface SemanticPullRequestMutationEvidence {
  readonly version: SemanticPullRequestMutationContractVersion;
  readonly operation: SemanticPullRequestMutationOperation;
  readonly outcome: SemanticPullRequestMutationOutcome;
  readonly effect: "not-attempted" | "succeeded" | "failed" | "ambiguous";
  readonly verified: boolean;
  readonly postcondition?: "recorded" | "merged" | "not-proven";
  readonly providerResponse?: "accepted" | "rejected" | "ambiguous";
  readonly current?: Readonly<{
    readonly pullRequest: number;
    readonly head: string;
    readonly base: string;
    readonly state: "open" | "closed";
  }>;
  readonly resource?: Readonly<{
    readonly id: number;
    readonly url?: string;
  }>;
}

export interface SemanticPullRequestMutationResult {
  readonly version: SemanticPullRequestMutationContractVersion;
  readonly operation: SemanticPullRequestMutationOperation;
  readonly outcome: "succeeded" | "idempotent";
  readonly plan: SemanticPullRequestMutationPlan;
  readonly evidence: SemanticPullRequestMutationEvidence;
  readonly current: GitHubPullRequest;
  readonly resource?: GitHubPullRequestComment | GitHubPullRequestReview;
}

export type SemanticPullRequestMutationErrorCode =
  | "PR_MUTATION_EXECUTION_REQUEST_INVALID"
  | "PR_MUTATION_EXECUTION_PLAN_INVALID"
  | "PR_MUTATION_REPOSITORY_MISMATCH"
  | "PR_MUTATION_TARGET_READ_FAILED"
  | "PR_MUTATION_TARGET_INVALID"
  | "PR_MUTATION_STALE_HEAD"
  | "PR_MUTATION_STALE_BASE"
  | "PR_MUTATION_DRAFT"
  | "PR_MUTATION_NOT_OPEN"
  | "PR_MUTATION_DUPLICATE_REVIEW"
  | "PR_MUTATION_MERGE_BLOCKED"
  | "PR_MUTATION_POLICY_READ_FAILED"
  | "PR_MUTATION_EFFECT_FAILED"
  | "PR_MUTATION_POSTCONDITION_READ_FAILED"
  | "PR_MUTATION_POSTCONDITION_FAILED"
  | "PR_MUTATION_RECOVERY_REQUIRED";

export class SemanticPullRequestMutationError extends Error {
  readonly code: SemanticPullRequestMutationErrorCode;
  readonly outcome: Exclude<SemanticPullRequestMutationOutcome, "succeeded" | "idempotent">;
  readonly diagnostics: readonly SemanticPullRequestMutationDiagnostic[];
  readonly plan?: SemanticPullRequestMutationPlan;
  readonly evidence: SemanticPullRequestMutationEvidence;

  constructor(options: {
    readonly code: SemanticPullRequestMutationErrorCode;
    readonly outcome: Exclude<SemanticPullRequestMutationOutcome, "succeeded" | "idempotent">;
    readonly message: string;
    readonly diagnostics: readonly SemanticPullRequestMutationDiagnostic[];
    readonly evidence: SemanticPullRequestMutationEvidence;
    readonly plan?: SemanticPullRequestMutationPlan;
  }) {
    super(options.message);
    this.name = "SemanticPullRequestMutationError";
    this.code = options.code;
    this.outcome = options.outcome;
    this.diagnostics = Object.freeze(
      [...options.diagnostics].slice(0, SEMANTIC_PULL_REQUEST_MUTATION_LIMITS.diagnostics),
    );
    this.evidence = Object.freeze(options.evidence);
    this.plan = options.plan;
  }
}

/** Provider-neutral bounded effect and observation seam owned by the adapter. */
export interface SemanticPullRequestMutationProvider {
  readonly getRepositoryContext: () => Promise<RepositoryContext>;
  /** Login of the identity whose credentials execute provider effects; binds review idempotence to this caller. */
  readonly getAuthenticatedUser: () => Promise<string>;
  readonly readPullRequest: (pullRequest: number) => Promise<GitHubPullRequest>;
  readonly listPullRequestComments: (pullRequest: number) => Promise<readonly GitHubPullRequestComment[]>;
  readonly createPullRequestComment: (pullRequest: number, body: string) => Promise<GitHubPullRequestComment>;
  readonly listPullRequestReviews: (pullRequest: number) => Promise<readonly GitHubPullRequestReview[]>;
  readonly submitPullRequestReview: (
    pullRequest: number,
    intent: SemanticPullRequestReviewIntent,
    body: string,
    expectedHead?: string,
  ) => Promise<GitHubPullRequestReview>;
  readonly mergePullRequest: (
    pullRequest: number,
    strategy: SemanticPullRequestMergeStrategy,
    expectedHead?: string,
  ) => Promise<GitHubPullRequestMergeResponse>;
  /** Optional only for providers without branch-protection evidence support. */
  readonly getPullRequestMergePolicy?: (
    pullRequest: GitHubPullRequest,
  ) => Promise<GitHubPullRequestMergePolicyEvidence>;
}

export interface SemanticPullRequestMutationExecutionRequest {
  readonly version: SemanticPullRequestMutationContractVersion;
  readonly plan: unknown;
}

export interface SemanticPullRequestMutationExecutionPort {
  execute(request: SemanticPullRequestMutationExecutionRequest): Promise<SemanticPullRequestMutationResult>;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stableSerialize(value: unknown, stack = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite numbers are not supported.");
    return String(value);
  }
  if (value === undefined) return "undefined";
  if (typeof value !== "object") throw new TypeError("Only JSON-compatible values are supported.");
  if (stack.has(value)) throw new TypeError("Cyclic JSON data is not supported.");
  stack.add(value);
  let serialized: string;
  if (Array.isArray(value)) {
    serialized = `[${value.map((entry) => stableSerialize(entry, stack)).join(",")}]`;
  } else if (isRecord(value)) {
    serialized = `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], stack)}`)
      .join(",")}}`;
  } else {
    throw new TypeError("Only plain JSON objects are supported.");
  }
  stack.delete(value);
  return serialized;
}

function cloneImmutable<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => cloneImmutable(entry))) as T;
  if (isRecord(value)) {
    const result: RecordValue = {};
    for (const key of Object.keys(value).sort()) result[key] = cloneImmutable(value[key]);
    return Object.freeze(result) as T;
  }
  return value;
}

function unknownProperties(
  value: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  violations: SemanticPullRequestMutationViolation[],
): void {
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key))
      violations.push({
        code: "PR_MUTATION_REQUEST_UNKNOWN_PROPERTY",
        path: `${path}.${key}`,
        message: `Property "${key}" is not supported.`,
      });
  }
}

function boundedString(
  value: unknown,
  path: string,
  violations: SemanticPullRequestMutationViolation[],
  maxLength: number,
  allowEmpty = false,
  rejectControls = false,
): string | undefined {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxLength ||
    /\u0000/gu.test(value) ||
    (rejectControls && /[\u0000-\u001F\u007F]/u.test(value)) ||
    Buffer.byteLength(value, "utf8") > maxLength
  ) {
    violations.push({
      code: "PR_MUTATION_REQUEST_VALUE_INVALID",
      path,
      message: "Value is not within the bounded string contract.",
    });
    return undefined;
  }
  return value;
}

function positiveNumber(
  value: unknown,
  path: string,
  violations: SemanticPullRequestMutationViolation[],
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    violations.push({
      code: "PR_MUTATION_REQUEST_VALUE_INVALID",
      path,
      message: "Pull request number must be a positive integer.",
    });
    return undefined;
  }
  return value;
}

function repositoryIdentity(
  value: unknown,
  path: string,
  violations: SemanticPullRequestMutationViolation[],
): SemanticPullRequestRepositoryIdentity | undefined {
  if (!isRecord(value)) {
    violations.push({ code: "PR_MUTATION_REQUEST_INVALID", path, message: "Repository identity is required." });
    return undefined;
  }
  unknownProperties(value, new Set(["hostname", "nameWithOwner", "repositoryId"]), path, violations);
  const hostname = boundedString(value.hostname, `${path}.hostname`, violations, 255);
  const nameWithOwner = boundedString(value.nameWithOwner, `${path}.nameWithOwner`, violations, 512);
  const repositoryId =
    value.repositoryId === undefined
      ? undefined
      : boundedString(value.repositoryId, `${path}.repositoryId`, violations, 32);
  if (repositoryId !== undefined && !/^[1-9][0-9]{0,19}$/u.test(repositoryId)) {
    violations.push({
      code: "PR_MUTATION_REQUEST_VALUE_INVALID",
      path: `${path}.repositoryId`,
      message: "Repository database identity is invalid.",
    });
  }
  if (hostname === undefined || nameWithOwner === undefined) return undefined;
  if (!/^[^\s/]+$/u.test(hostname) || !/^[^\s/]+\/[^\s/]+$/u.test(nameWithOwner)) {
    violations.push({
      code: "PR_MUTATION_REQUEST_VALUE_INVALID",
      path,
      message: "Repository identity has an invalid host or owner/name.",
    });
    return undefined;
  }
  return { hostname: hostname.toLowerCase(), nameWithOwner, ...(repositoryId === undefined ? {} : { repositoryId }) };
}

function materializeRequest(input: unknown): SemanticPullRequestMutationRequestResult {
  const violations: SemanticPullRequestMutationViolation[] = [];
  if (!isRecord(input)) {
    return {
      valid: false,
      violations: [{ code: "PR_MUTATION_REQUEST_INVALID", path: "$", message: "Mutation request must be an object." }],
    };
  }
  const operation = input.operation;
  if (input.version !== SEMANTIC_PULL_REQUEST_MUTATION_CONTRACT_VERSION) {
    violations.push({
      code: "PR_MUTATION_REQUEST_INVALID",
      path: "$.version",
      message: "Mutation request version is unsupported.",
    });
  }
  if (operation !== "comment" && operation !== "review" && operation !== "merge") {
    violations.push({
      code: "PR_MUTATION_REQUEST_INVALID",
      path: "$.operation",
      message: "Mutation operation must be comment, review, or merge.",
    });
    return { valid: false, violations };
  }
  const common = new Set(["version", "operation", "repository", "pullRequest"]);
  const allowed =
    operation === "comment"
      ? new Set([...common, "body", "expectedHead"])
      : operation === "review"
        ? new Set([...common, "expectedHead", "intent", "body", "retry"])
        : new Set([...common, "expectedHead", "expectedBase", "strategy"]);
  unknownProperties(input, allowed, "$", violations);
  const repository = repositoryIdentity(input.repository, "$.repository", violations);
  const pullRequest = positiveNumber(input.pullRequest, "$.pullRequest", violations);

  if (operation === "comment") {
    const body = boundedString(input.body, "$.body", violations, SEMANTIC_PULL_REQUEST_MUTATION_LIMITS.bodyBytes);
    const expectedHead =
      input.expectedHead === undefined
        ? undefined
        : boundedString(
            input.expectedHead,
            "$.expectedHead",
            violations,
            SEMANTIC_PULL_REQUEST_MUTATION_LIMITS.expectedHeadLength,
            false,
            true,
          );
    if (repository === undefined || pullRequest === undefined || body === undefined)
      return { valid: false, violations };
    return {
      valid: violations.length === 0,
      ...(violations.length === 0
        ? {
            request: {
              version: SEMANTIC_PULL_REQUEST_MUTATION_CONTRACT_VERSION,
              operation,
              repository,
              pullRequest,
              body,
              ...(expectedHead === undefined ? {} : { expectedHead }),
            },
          }
        : {}),
      violations,
    };
  }

  const expectedHead = boundedString(
    input.expectedHead,
    "$.expectedHead",
    violations,
    SEMANTIC_PULL_REQUEST_MUTATION_LIMITS.expectedHeadLength,
    false,
    true,
  );
  if (operation === "review") {
    const intent = input.intent;
    if (intent !== "approve" && intent !== "request-changes" && intent !== "comment-only")
      violations.push({
        code: "PR_MUTATION_REQUEST_VALUE_INVALID",
        path: "$.intent",
        message: "Review intent is invalid.",
      });
    const body = boundedString(
      input.body === undefined ? "" : input.body,
      "$.body",
      violations,
      SEMANTIC_PULL_REQUEST_MUTATION_LIMITS.bodyBytes,
      true,
    );
    const retry = input.retry === undefined ? "reject-duplicate" : input.retry;
    if (retry !== "reject-duplicate" && retry !== "allow-duplicate")
      violations.push({
        code: "PR_MUTATION_REQUEST_VALUE_INVALID",
        path: "$.retry",
        message: "Retry mode is invalid.",
      });
    if (repository === undefined || pullRequest === undefined || expectedHead === undefined || body === undefined)
      return { valid: false, violations };
    if (intent !== "approve" && intent !== "request-changes" && intent !== "comment-only")
      return { valid: false, violations };
    if (retry !== "reject-duplicate" && retry !== "allow-duplicate") return { valid: false, violations };
    return {
      valid: violations.length === 0,
      ...(violations.length === 0
        ? {
            request: {
              version: SEMANTIC_PULL_REQUEST_MUTATION_CONTRACT_VERSION,
              operation,
              repository,
              pullRequest,
              expectedHead,
              intent,
              body,
              retry,
            },
          }
        : {}),
      violations,
    };
  }

  const expectedBase = boundedString(
    input.expectedBase,
    "$.expectedBase",
    violations,
    SEMANTIC_PULL_REQUEST_MUTATION_LIMITS.expectedBaseLength,
    false,
    true,
  );
  const strategy = input.strategy;
  if (strategy !== "merge" && strategy !== "squash" && strategy !== "rebase")
    violations.push({
      code: "PR_MUTATION_REQUEST_VALUE_INVALID",
      path: "$.strategy",
      message: "Merge strategy is invalid.",
    });
  if (repository === undefined || pullRequest === undefined || expectedHead === undefined || expectedBase === undefined)
    return { valid: false, violations };
  if (strategy !== "merge" && strategy !== "squash" && strategy !== "rebase") return { valid: false, violations };
  return {
    valid: violations.length === 0,
    ...(violations.length === 0
      ? {
          request: {
            version: SEMANTIC_PULL_REQUEST_MUTATION_CONTRACT_VERSION,
            operation,
            repository,
            pullRequest,
            expectedHead,
            expectedBase,
            strategy,
          },
        }
      : {}),
    violations,
  };
}

function boundedRequestResult(
  result: SemanticPullRequestMutationRequestResult,
): SemanticPullRequestMutationRequestResult {
  return {
    ...result,
    violations: Object.freeze(result.violations.slice(0, SEMANTIC_PULL_REQUEST_MUTATION_LIMITS.diagnostics)),
  };
}

export function tryMaterializeSemanticPullRequestMutationRequest(
  input: unknown,
): SemanticPullRequestMutationRequestResult {
  return boundedRequestResult(materializeRequest(input));
}

export function materializeSemanticPullRequestMutationRequest(input: unknown): SemanticPullRequestMutationRequest {
  const result = boundedRequestResult(materializeRequest(input));
  if (!result.valid || result.request === undefined)
    throw new SemanticPullRequestMutationValidationError(result.violations);
  return result.request;
}

export function tryPlanSemanticPullRequestMutation(input: unknown): SemanticPullRequestMutationPlanResult {
  const requestResult = boundedRequestResult(materializeRequest(input));
  if (!requestResult.valid || requestResult.request === undefined)
    return { valid: false, violations: requestResult.violations };
  const request = requestResult.request;
  const preconditions: SemanticPullRequestMutationPrecondition[] = [
    { kind: "PULL_REQUEST_IDENTITY_MATCH", repository: request.repository, pullRequest: request.pullRequest },
  ];
  let effect: SemanticPullRequestMutationEffect;
  if (request.operation === "comment") {
    if (request.expectedHead !== undefined)
      preconditions.push({ kind: "PULL_REQUEST_HEAD_MATCH", expectedHead: request.expectedHead });
    effect = { kind: "CREATE_CONVERSATION_COMMENT", body: request.body };
  } else if (request.operation === "review") {
    preconditions.push({ kind: "PULL_REQUEST_HEAD_MATCH", expectedHead: request.expectedHead });
    effect = { kind: "SUBMIT_REVIEW", intent: request.intent, body: request.body };
  } else {
    preconditions.push(
      { kind: "PULL_REQUEST_HEAD_MATCH", expectedHead: request.expectedHead },
      { kind: "PULL_REQUEST_BASE_MATCH", expectedBase: request.expectedBase },
      { kind: "PULL_REQUEST_NOT_DRAFT" },
      { kind: "PULL_REQUEST_MERGEABLE" },
    );
    effect = { kind: "MERGE_PULL_REQUEST", strategy: request.strategy };
  }
  return {
    valid: true,
    plan: cloneImmutable({
      version: SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION,
      kind: "pull_request_mutation",
      operation: request.operation,
      request,
      preconditions,
      effects: [effect],
    }),
    violations: [],
  };
}

export function planSemanticPullRequestMutation(input: unknown): SemanticPullRequestMutationPlan {
  const result = tryPlanSemanticPullRequestMutation(input);
  if (!result.valid || result.plan === undefined)
    throw new SemanticPullRequestMutationValidationError(result.violations);
  return result.plan;
}

export const createSemanticPullRequestMutationPlan = planSemanticPullRequestMutation;

function validatePlan(input: unknown): SemanticPullRequestMutationPlanResult {
  if (!isRecord(input))
    return {
      valid: false,
      violations: [{ code: "PR_MUTATION_PLAN_INVALID", path: "$", message: "Mutation plan must be an object." }],
    };
  const planned = tryPlanSemanticPullRequestMutation(input.request);
  const violations: SemanticPullRequestMutationViolation[] = [...planned.violations];
  if (input.version !== SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION)
    violations.push({
      code: "PR_MUTATION_PLAN_INVALID",
      path: "$.version",
      message: "Mutation plan version is unsupported.",
    });
  if (input.kind !== "pull_request_mutation")
    violations.push({ code: "PR_MUTATION_PLAN_INVALID", path: "$.kind", message: "Mutation plan kind is invalid." });
  if (input.operation !== "comment" && input.operation !== "review" && input.operation !== "merge")
    violations.push({
      code: "PR_MUTATION_PLAN_INVALID",
      path: "$.operation",
      message: "Mutation plan operation is invalid.",
    });
  if (planned.plan !== undefined) {
    let canonical = false;
    try {
      canonical =
        planned.plan.operation === input.operation && stableSerialize(planned.plan) === stableSerialize(input);
    } catch {
      violations.push({
        code: "PR_MUTATION_PLAN_INVALID",
        path: "$",
        message: "Mutation plan contains unsupported or cyclic data.",
      });
    }
    if (!canonical)
      violations.push({
        code: "PR_MUTATION_PLAN_INVALID",
        path: "$",
        message: "Mutation plan is not the canonical plan for its request.",
      });
  }
  return violations.length === 0
    ? { valid: true, plan: cloneImmutable(input as unknown as SemanticPullRequestMutationPlan), violations: [] }
    : { valid: false, violations };
}

export function validateSemanticPullRequestMutationPlan(input: unknown): SemanticPullRequestMutationPlanResult {
  return validatePlan(input);
}

export function serializeSemanticPullRequestMutationPlan(input: unknown): string {
  const result = validatePlan(input);
  if (!result.valid || result.plan === undefined)
    throw new SemanticPullRequestMutationValidationError(result.violations);
  return stableSerialize(result.plan);
}

export function deserializeSemanticPullRequestMutationPlan(serialized: string): SemanticPullRequestMutationPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new SemanticPullRequestMutationValidationError([
      { code: "PR_MUTATION_PLAN_INVALID", path: "$", message: "Mutation plan must be valid JSON." },
    ]);
  }
  const result = validatePlan(parsed);
  if (!result.valid || result.plan === undefined)
    throw new SemanticPullRequestMutationValidationError(result.violations);
  return result.plan;
}

export const parseSemanticPullRequestMutationPlan = deserializeSemanticPullRequestMutationPlan;

function diagnostic(code: string, path: string, message: string): SemanticPullRequestMutationDiagnostic {
  return { code, path, message: message.slice(0, SEMANTIC_PULL_REQUEST_MUTATION_LIMITS.diagnosticMessageLength) };
}

function currentEvidence(pullRequest: GitHubPullRequest): NonNullable<SemanticPullRequestMutationEvidence["current"]> {
  return {
    pullRequest: pullRequest.number,
    head: pullRequest.headSha ?? pullRequest.head,
    base: pullRequest.base,
    state: pullRequest.state,
  };
}

function emptyEvidence(
  operation: SemanticPullRequestMutationOperation,
  outcome: SemanticPullRequestMutationOutcome,
  effect: SemanticPullRequestMutationEvidence["effect"],
  verified = false,
): SemanticPullRequestMutationEvidence {
  return { version: SEMANTIC_PULL_REQUEST_MUTATION_CONTRACT_VERSION, operation, outcome, effect, verified };
}

function headOf(pullRequest: GitHubPullRequest): string {
  return pullRequest.headSha ?? pullRequest.head;
}

function isMerged(pullRequest: GitHubPullRequest): boolean {
  return (
    pullRequest.state === "closed" &&
    (pullRequest.merged === true ||
      (pullRequest.mergedAt !== undefined && pullRequest.mergedAt !== null) ||
      (pullRequest.mergeCommitSha !== undefined && pullRequest.mergeCommitSha !== null))
  );
}

function mergedMatchingTarget(pullRequest: GitHubPullRequest, request: SemanticPullRequestMergeRequest): boolean {
  return (
    isMerged(pullRequest) &&
    pullRequest.number === request.pullRequest &&
    pullRequest.headSha === request.expectedHead &&
    pullRequest.base === request.expectedBase
  );
}

/**
 * Idempotent-replay proof requires authoritative strategy evidence: a
 * missing `mergeMethod` must not be treated as a wildcard match for an
 * arbitrary requested strategy (issue #521 review).
 */
function mergedAsRequested(pullRequest: GitHubPullRequest, request: SemanticPullRequestMergeRequest): boolean {
  return mergedMatchingTarget(pullRequest, request) && pullRequest.mergeMethod === request.strategy;
}

/**
 * Post-effect verification after this executor's own accepted provider
 * response: the requested strategy is already proven by that acceptance, so
 * missing reread `mergeMethod` evidence does not invalidate the postcondition.
 */
function mergedMatchingOwnEffect(pullRequest: GitHubPullRequest, request: SemanticPullRequestMergeRequest): boolean {
  return (
    mergedMatchingTarget(pullRequest, request) &&
    (pullRequest.mergeMethod === undefined || pullRequest.mergeMethod === request.strategy)
  );
}

function repositoryMatches(request: SemanticPullRequestRepositoryIdentity, context: RepositoryContext): boolean {
  return (
    request.hostname.toLowerCase() === context.hostname.toLowerCase() &&
    request.nameWithOwner === context.nameWithOwner &&
    (request.repositoryId === undefined || request.repositoryId === context.repositoryId)
  );
}

function intentForReview(review: GitHubPullRequestReview): SemanticPullRequestReviewIntent | undefined {
  if (review.state === "approved") return "approve";
  if (review.state === "changes-requested") return "request-changes";
  if (review.state === "commented") return "comment-only";
  return undefined;
}

/**
 * Duplicate/idempotence matching must bind the authenticated mutation
 * principal: an absent `author` on provider evidence cannot prove this
 * caller submitted the review, so it never matches (issue #521 review).
 */
function sameReview(
  review: GitHubPullRequestReview,
  request: SemanticPullRequestReviewRequest,
  actor: string,
): boolean {
  return (
    review.author === actor &&
    review.commitId === request.expectedHead &&
    intentForReview(review) === request.intent &&
    (review.body ?? "") === request.body
  );
}

function strategyAllowed(
  strategy: SemanticPullRequestMergeStrategy,
  policy: GitHubPullRequestMergePolicyEvidence | undefined,
): boolean {
  return policy?.allowedStrategies === undefined || policy.allowedStrategies.includes(strategy);
}

function mergePolicySatisfied(policy: GitHubPullRequestMergePolicyEvidence | undefined): boolean {
  if (policy === undefined) return true;
  if (policy.checks?.authoritative === true && policy.checks.satisfied !== true) return false;
  if (policy.reviews?.authoritative === true && policy.reviews.satisfied !== true) return false;
  return true;
}

function mergeabilityBlocked(pullRequest: GitHubPullRequest): boolean {
  if (pullRequest.mergeable === false) return true;
  return ["blocked", "dirty", "conflicting", "unstable"].includes(pullRequest.mergeableState ?? "");
}

function mergeabilityUnknown(pullRequest: GitHubPullRequest): boolean {
  return pullRequest.mergeable === null || ["unknown", "checking"].includes(pullRequest.mergeableState ?? "");
}

function errorIsAmbiguous(error: unknown): boolean {
  if (isRecord(error) && error.ambiguous === true) return true;
  if (isRecord(error) && (error.category === "transport" || error.category === "timeout")) return true;
  if (isRecord(error) && isRecord(error.details)) {
    return error.details.category === "transport" || error.details.category === "timeout";
  }
  return false;
}

function throwMutationError(
  plan: SemanticPullRequestMutationPlan,
  code: SemanticPullRequestMutationErrorCode,
  outcome: Exclude<SemanticPullRequestMutationOutcome, "succeeded" | "idempotent">,
  message: string,
  diagnostics: readonly SemanticPullRequestMutationDiagnostic[],
  evidence: SemanticPullRequestMutationEvidence,
): never {
  throw new SemanticPullRequestMutationError({ code, outcome, message, diagnostics, evidence, plan });
}

function validateExecutionRequest(input: unknown): asserts input is SemanticPullRequestMutationExecutionRequest {
  if (!isRecord(input) || input.version !== SEMANTIC_PULL_REQUEST_MUTATION_CONTRACT_VERSION || !hasOwn(input, "plan")) {
    throw new SemanticPullRequestMutationError({
      code: "PR_MUTATION_EXECUTION_REQUEST_INVALID",
      outcome: "failed",
      message: "Semantic PR mutation execution request is invalid.",
      diagnostics: [
        diagnostic("PR_MUTATION_EXECUTION_REQUEST_INVALID", "$.version", "Execution request version is unsupported."),
      ],
      evidence: emptyEvidence("comment", "failed", "not-attempted"),
    });
  }
}

async function readTarget(
  provider: SemanticPullRequestMutationProvider,
  plan: SemanticPullRequestMutationPlan,
): Promise<{ readonly context: RepositoryContext; readonly pullRequest: GitHubPullRequest }> {
  let context: RepositoryContext;
  let pullRequest: GitHubPullRequest;
  try {
    [context, pullRequest] = await Promise.all([
      provider.getRepositoryContext(),
      provider.readPullRequest(plan.request.pullRequest),
    ]);
  } catch {
    throwMutationError(
      plan,
      "PR_MUTATION_TARGET_READ_FAILED",
      "failed",
      "Current pull-request identity could not be established before mutation.",
      [diagnostic("PR_MUTATION_TARGET_READ_FAILED", "$.pullRequest", "Current pull-request evidence is unavailable.")],
      emptyEvidence(plan.operation, "failed", "not-attempted"),
    );
  }
  const observation = tryObserveSemanticPullRequest(
    context.repositoryId === undefined
      ? { pullRequest }
      : {
          pullRequest,
          repository: {
            hostname: context.hostname,
            nameWithOwner: context.nameWithOwner,
            repositoryId: context.repositoryId,
          },
        },
  );
  if (!observation.valid) {
    throwMutationError(
      plan,
      "PR_MUTATION_TARGET_INVALID",
      "failed",
      "The provider returned pull-request evidence outside the existing observation contract.",
      observation.violations.map((violation) => diagnostic(violation.code, violation.path, violation.message)),
      { ...emptyEvidence(plan.operation, "failed", "not-attempted"), current: currentEvidence(pullRequest) },
    );
  }
  return { context, pullRequest };
}

function admitIdentity(
  plan: SemanticPullRequestMutationPlan,
  context: RepositoryContext,
  pullRequest: GitHubPullRequest,
): void {
  if (!repositoryMatches(plan.request.repository, context) || pullRequest.number !== plan.request.pullRequest) {
    throwMutationError(
      plan,
      "PR_MUTATION_REPOSITORY_MISMATCH",
      "blocked",
      "The observed pull request does not match the requested repository identity.",
      [diagnostic("PR_MUTATION_REPOSITORY_MISMATCH", "$.repository", "Target identity verification failed.")],
      { ...emptyEvidence(plan.operation, "blocked", "not-attempted"), current: currentEvidence(pullRequest) },
    );
  }
}

function admitHead(
  plan: SemanticPullRequestMutationPlan,
  pullRequest: GitHubPullRequest,
  expectedHead: string | undefined,
): void {
  if (expectedHead !== undefined && pullRequest.headSha === undefined) {
    throwMutationError(
      plan,
      "PR_MUTATION_TARGET_INVALID",
      "failed",
      "The provider did not return an immutable pull-request head identity.",
      [
        diagnostic(
          "PR_MUTATION_TARGET_INVALID",
          "$.headSha",
          "Expected-head admission requires provider commit evidence.",
        ),
      ],
      { ...emptyEvidence(plan.operation, "failed", "not-attempted"), current: currentEvidence(pullRequest) },
    );
  }
  if (expectedHead !== undefined && pullRequest.headSha !== expectedHead) {
    throwMutationError(
      plan,
      "PR_MUTATION_STALE_HEAD",
      "stale",
      "The pull-request head changed after the mutation request was prepared.",
      [
        diagnostic(
          "PR_MUTATION_STALE_HEAD",
          "$.expectedHead",
          "Execution-time pull-request head does not match expectedHead.",
        ),
      ],
      { ...emptyEvidence(plan.operation, "stale", "not-attempted"), current: currentEvidence(pullRequest) },
    );
  }
}

function result(
  plan: SemanticPullRequestMutationPlan,
  current: GitHubPullRequest,
  outcome: "succeeded" | "idempotent",
  evidence: SemanticPullRequestMutationEvidence,
  resource?: GitHubPullRequestComment | GitHubPullRequestReview,
): SemanticPullRequestMutationResult {
  return Object.freeze({
    version: SEMANTIC_PULL_REQUEST_MUTATION_CONTRACT_VERSION,
    operation: plan.operation,
    outcome,
    plan,
    evidence,
    current,
    ...(resource === undefined ? {} : { resource }),
  });
}

/** Executes one canonical PR mutation only after fresh admission and proof. */
export class LocalSemanticPullRequestMutationExecutor implements SemanticPullRequestMutationExecutionPort {
  readonly #provider: SemanticPullRequestMutationProvider;

  constructor(options: { readonly adapter: SemanticPullRequestMutationProvider }) {
    if (typeof options?.adapter?.readPullRequest !== "function")
      throw new TypeError("A PR mutation provider is required.");
    this.#provider = options.adapter;
  }

  async execute(request: SemanticPullRequestMutationExecutionRequest): Promise<SemanticPullRequestMutationResult> {
    validateExecutionRequest(request);
    const planned = validatePlan(request.plan);
    if (!planned.valid || planned.plan === undefined) {
      throw new SemanticPullRequestMutationError({
        code: "PR_MUTATION_EXECUTION_PLAN_INVALID",
        outcome: "failed",
        message: "Semantic PR mutation plan is invalid and cannot be executed.",
        diagnostics: planned.violations.map((violation) =>
          diagnostic(violation.code, violation.path, violation.message),
        ),
        evidence: emptyEvidence("comment", "failed", "not-attempted"),
      });
    }
    const plan = planned.plan;
    const target = await readTarget(this.#provider, plan);
    admitIdentity(plan, target.context, target.pullRequest);
    if (target.pullRequest.state !== "open" && plan.operation !== "merge") {
      throwMutationError(
        plan,
        "PR_MUTATION_NOT_OPEN",
        "blocked",
        "The pull request is not open for this mutation.",
        [diagnostic("PR_MUTATION_NOT_OPEN", "$.pullRequest.state", "The pull request is not open.")],
        { ...emptyEvidence(plan.operation, "blocked", "not-attempted"), current: currentEvidence(target.pullRequest) },
      );
    }

    if (plan.operation === "comment") return this.executeComment(plan, target.pullRequest);
    if (plan.operation === "review") return this.executeReview(plan, target.pullRequest);
    return this.executeMerge(plan, target.pullRequest);
  }

  private async executeComment(
    plan: SemanticPullRequestMutationPlan,
    before: GitHubPullRequest,
  ): Promise<SemanticPullRequestMutationResult> {
    const request = plan.request as SemanticPullRequestCommentRequest;
    admitHead(plan, before, request.expectedHead);
    let created: GitHubPullRequestComment;
    try {
      created = await this.#provider.createPullRequestComment(request.pullRequest, request.body);
    } catch (error: unknown) {
      if (errorIsAmbiguous(error)) {
        try {
          await this.#provider.listPullRequestComments(request.pullRequest);
        } catch {
          // The outcome remains recovery-required either way; this reread is
          // best effort because the provider did not return a resource ID.
        }
        throwMutationError(
          plan,
          "PR_MUTATION_RECOVERY_REQUIRED",
          "recovery-required",
          "The comment provider result is ambiguous and the created comment is not identified safely.",
          [
            diagnostic(
              "PR_MUTATION_RECOVERY_REQUIRED",
              "$.effects[0]",
              "Reread comments and recover the outcome before retrying.",
            ),
          ],
          { ...emptyEvidence("comment", "recovery-required", "ambiguous"), providerResponse: "ambiguous" },
        );
      }
      throwMutationError(
        plan,
        "PR_MUTATION_EFFECT_FAILED",
        "failed",
        "GitHub rejected the pull-request conversation comment mutation.",
        [
          diagnostic(
            "PR_MUTATION_EFFECT_FAILED",
            "$.effects[0]",
            "The conversation comment was not accepted by the provider.",
          ),
        ],
        { ...emptyEvidence("comment", "failed", "failed"), providerResponse: "rejected" },
      );
    }
    let comments: readonly GitHubPullRequestComment[];
    try {
      comments = await this.#provider.listPullRequestComments(request.pullRequest);
    } catch {
      throwMutationError(
        plan,
        "PR_MUTATION_POSTCONDITION_READ_FAILED",
        "recovery-required",
        "The created conversation comment could not be reread for verification.",
        [diagnostic("PR_MUTATION_POSTCONDITION_READ_FAILED", "$.resource", "Created comment evidence is unavailable.")],
        {
          ...emptyEvidence("comment", "recovery-required", "ambiguous"),
          providerResponse: "accepted",
          resource: { id: created.id, url: created.url },
        },
      );
    }
    const verified = comments.some((comment) => comment.id === created.id && comment.body === request.body);
    if (!verified) {
      throwMutationError(
        plan,
        "PR_MUTATION_POSTCONDITION_FAILED",
        "failed",
        "The provider response did not produce a verifiable conversation comment.",
        [diagnostic("PR_MUTATION_POSTCONDITION_FAILED", "$.resource", "Created comment postcondition is not proven.")],
        {
          ...emptyEvidence("comment", "failed", "succeeded"),
          providerResponse: "accepted",
          postcondition: "not-proven",
          resource: { id: created.id, url: created.url },
        },
      );
    }
    return result(
      plan,
      before,
      "succeeded",
      {
        ...emptyEvidence("comment", "succeeded", "succeeded", true),
        postcondition: "recorded",
        providerResponse: "accepted",
        current: currentEvidence(before),
        resource: { id: created.id, url: created.url },
      },
      created,
    );
  }

  private async executeReview(
    plan: SemanticPullRequestMutationPlan,
    before: GitHubPullRequest,
  ): Promise<SemanticPullRequestMutationResult> {
    const request = plan.request as SemanticPullRequestReviewRequest;
    admitHead(plan, before, request.expectedHead);
    if (before.state !== "open") {
      throwMutationError(
        plan,
        "PR_MUTATION_NOT_OPEN",
        "blocked",
        "The pull request is not open for review.",
        [diagnostic("PR_MUTATION_NOT_OPEN", "$.pullRequest.state", "The pull request is not open.")],
        { ...emptyEvidence("review", "blocked", "not-attempted"), current: currentEvidence(before) },
      );
    }
    let actor: string;
    try {
      actor = await this.#provider.getAuthenticatedUser();
    } catch {
      throwMutationError(
        plan,
        "PR_MUTATION_TARGET_READ_FAILED",
        "failed",
        "The authenticated mutation principal could not be established before review execution.",
        [diagnostic("PR_MUTATION_TARGET_READ_FAILED", "$.actor", "Caller identity evidence is unavailable.")],
        { ...emptyEvidence("review", "failed", "not-attempted"), current: currentEvidence(before) },
      );
    }
    let existing: readonly GitHubPullRequestReview[];
    try {
      existing = await this.#provider.listPullRequestReviews(request.pullRequest);
    } catch {
      throwMutationError(
        plan,
        "PR_MUTATION_TARGET_READ_FAILED",
        "failed",
        "Current pull-request review evidence could not be established before mutation.",
        [diagnostic("PR_MUTATION_REVIEW_READ_FAILED", "$.reviews", "Current review evidence is unavailable.")],
        { ...emptyEvidence("review", "failed", "not-attempted"), current: currentEvidence(before) },
      );
    }
    const sameIntent = existing.filter(
      (review) =>
        review.author === actor &&
        review.commitId === request.expectedHead &&
        intentForReview(review) === request.intent,
    );
    const exact = sameIntent.find((review) => sameReview(review, request, actor));
    if (exact !== undefined && request.retry === "reject-duplicate") {
      return result(
        plan,
        before,
        "idempotent",
        {
          ...emptyEvidence("review", "idempotent", "not-attempted", true),
          postcondition: "recorded",
          current: currentEvidence(before),
          resource: { id: exact.id, url: exact.url },
        },
        exact,
      );
    }
    if (sameIntent.length > 0 && request.retry === "reject-duplicate") {
      throwMutationError(
        plan,
        "PR_MUTATION_DUPLICATE_REVIEW",
        "blocked",
        "A review with the requested intent already exists on this pull-request head; retry explicitly to add another.",
        [
          diagnostic(
            "PR_MUTATION_DUPLICATE_REVIEW",
            "$.retry",
            "Duplicate review retry was rejected by the semantic contract.",
          ),
        ],
        { ...emptyEvidence("review", "blocked", "not-attempted"), current: currentEvidence(before) },
      );
    }

    let submitted: GitHubPullRequestReview;
    try {
      submitted = await this.#provider.submitPullRequestReview(
        request.pullRequest,
        request.intent,
        request.body,
        request.expectedHead,
      );
    } catch (error: unknown) {
      if (errorIsAmbiguous(error)) {
        let recovered: readonly GitHubPullRequestReview[];
        try {
          recovered = await this.#provider.listPullRequestReviews(request.pullRequest);
        } catch {
          throwMutationError(
            plan,
            "PR_MUTATION_RECOVERY_REQUIRED",
            "recovery-required",
            "The review provider result is ambiguous and current review evidence is unavailable.",
            [
              diagnostic(
                "PR_MUTATION_RECOVERY_REQUIRED",
                "$.effects[0]",
                "Reread reviews before deciding whether it is safe to retry.",
              ),
            ],
            { ...emptyEvidence("review", "recovery-required", "ambiguous"), providerResponse: "ambiguous" },
          );
        }
        const recoveredReview = recovered.find((review) => sameReview(review, request, actor));
        if (recoveredReview !== undefined) {
          return result(
            plan,
            before,
            "idempotent",
            {
              ...emptyEvidence("review", "idempotent", "ambiguous", true),
              postcondition: "recorded",
              providerResponse: "ambiguous",
              current: currentEvidence(before),
              resource: { id: recoveredReview.id, url: recoveredReview.url },
            },
            recoveredReview,
          );
        }
        throwMutationError(
          plan,
          "PR_MUTATION_RECOVERY_REQUIRED",
          "recovery-required",
          "The review provider result is ambiguous and current evidence does not identify the requested review.",
          [
            diagnostic(
              "PR_MUTATION_RECOVERY_REQUIRED",
              "$.effects[0]",
              "Reread reviews before deciding whether it is safe to retry.",
            ),
          ],
          { ...emptyEvidence("review", "recovery-required", "ambiguous"), providerResponse: "ambiguous" },
        );
      }
      throwMutationError(
        plan,
        "PR_MUTATION_EFFECT_FAILED",
        "failed",
        "GitHub rejected the pull-request review mutation.",
        [diagnostic("PR_MUTATION_EFFECT_FAILED", "$.effects[0]", "The review was not accepted by the provider.")],
        { ...emptyEvidence("review", "failed", "failed"), providerResponse: "rejected" },
      );
    }
    let reread: readonly GitHubPullRequestReview[];
    try {
      reread = await this.#provider.listPullRequestReviews(request.pullRequest);
    } catch {
      throwMutationError(
        plan,
        "PR_MUTATION_POSTCONDITION_READ_FAILED",
        "recovery-required",
        "The submitted review could not be reread for verification.",
        [
          diagnostic(
            "PR_MUTATION_POSTCONDITION_READ_FAILED",
            "$.resource",
            "Submitted review evidence is unavailable.",
          ),
        ],
        {
          ...emptyEvidence("review", "recovery-required", "ambiguous"),
          providerResponse: "accepted",
          resource: { id: submitted.id, url: submitted.url },
        },
      );
    }
    const verified = reread.some(
      (review) =>
        review.id === submitted.id &&
        review.author === actor &&
        review.commitId === request.expectedHead &&
        intentForReview(review) === request.intent &&
        (review.body ?? "") === request.body,
    );
    if (!verified) {
      throwMutationError(
        plan,
        "PR_MUTATION_POSTCONDITION_FAILED",
        "failed",
        "The provider response did not produce a verifiable review on the expected pull-request head.",
        [diagnostic("PR_MUTATION_POSTCONDITION_FAILED", "$.resource", "Submitted review postcondition is not proven.")],
        {
          ...emptyEvidence("review", "failed", "succeeded"),
          providerResponse: "accepted",
          postcondition: "not-proven",
          resource: { id: submitted.id, url: submitted.url },
        },
      );
    }
    return result(
      plan,
      before,
      "succeeded",
      {
        ...emptyEvidence("review", "succeeded", "succeeded", true),
        postcondition: "recorded",
        providerResponse: "accepted",
        current: currentEvidence(before),
        resource: { id: submitted.id, url: submitted.url },
      },
      submitted,
    );
  }

  private async executeMerge(
    plan: SemanticPullRequestMutationPlan,
    before: GitHubPullRequest,
  ): Promise<SemanticPullRequestMutationResult> {
    const request = plan.request as SemanticPullRequestMergeRequest;
    admitHead(plan, before, request.expectedHead);
    if (before.base !== request.expectedBase) {
      throwMutationError(
        plan,
        "PR_MUTATION_STALE_BASE",
        "stale",
        "The pull-request base branch changed after the merge request was prepared.",
        [
          diagnostic(
            "PR_MUTATION_STALE_BASE",
            "$.expectedBase",
            "Execution-time pull-request base does not match expectedBase.",
          ),
        ],
        { ...emptyEvidence("merge", "stale", "not-attempted"), current: currentEvidence(before) },
      );
    }
    if (mergedAsRequested(before, request)) {
      return result(plan, before, "idempotent", {
        ...emptyEvidence("merge", "idempotent", "not-attempted", true),
        postcondition: "merged",
        current: currentEvidence(before),
      });
    }
    if (before.state !== "open") {
      throwMutationError(
        plan,
        "PR_MUTATION_NOT_OPEN",
        "blocked",
        "The pull request is not open and is not proven to be the requested merged head.",
        [diagnostic("PR_MUTATION_NOT_OPEN", "$.pullRequest.state", "The pull request is not open for merge.")],
        { ...emptyEvidence("merge", "blocked", "not-attempted"), current: currentEvidence(before) },
      );
    }
    if (before.draft) {
      throwMutationError(
        plan,
        "PR_MUTATION_DRAFT",
        "blocked",
        "Draft pull requests cannot be merged through the governed PR mutation authority.",
        [diagnostic("PR_MUTATION_DRAFT", "$.pullRequest.draft", "Draft state blocks merge admission.")],
        { ...emptyEvidence("merge", "blocked", "not-attempted"), current: currentEvidence(before) },
      );
    }
    if (mergeabilityBlocked(before) || mergeabilityUnknown(before)) {
      throwMutationError(
        plan,
        "PR_MUTATION_MERGE_BLOCKED",
        "blocked",
        "Current pull-request mergeability is conflicting, blocked, or not authoritatively known.",
        [
          diagnostic(
            "PR_MUTATION_MERGE_BLOCKED",
            "$.pullRequest.mergeability",
            "Merge admission requires known non-conflicting evidence.",
          ),
        ],
        { ...emptyEvidence("merge", "blocked", "not-attempted"), current: currentEvidence(before) },
      );
    }
    let policy: GitHubPullRequestMergePolicyEvidence | undefined;
    if (this.#provider.getPullRequestMergePolicy !== undefined) {
      try {
        policy = await this.#provider.getPullRequestMergePolicy(before);
      } catch {
        throwMutationError(
          plan,
          "PR_MUTATION_POLICY_READ_FAILED",
          "failed",
          "Authoritative repository merge policy evidence could not be established.",
          [diagnostic("PR_MUTATION_POLICY_READ_FAILED", "$.policy", "Required merge policy evidence is unavailable.")],
          { ...emptyEvidence("merge", "failed", "not-attempted"), current: currentEvidence(before) },
        );
      }
    }
    if (!strategyAllowed(request.strategy, policy) || !mergePolicySatisfied(policy)) {
      throwMutationError(
        plan,
        "PR_MUTATION_MERGE_BLOCKED",
        "blocked",
        "Repository merge policy or required checks/reviews do not admit this merge.",
        [
          diagnostic(
            "PR_MUTATION_MERGE_BLOCKED",
            "$.strategy",
            "The requested merge is not admitted by current policy evidence.",
          ),
        ],
        { ...emptyEvidence("merge", "blocked", "not-attempted"), current: currentEvidence(before) },
      );
    }

    let providerResponse: GitHubPullRequestMergeResponse | undefined;
    let providerError: unknown;
    try {
      providerResponse = await this.#provider.mergePullRequest(
        request.pullRequest,
        request.strategy,
        request.expectedHead,
      );
    } catch (error: unknown) {
      providerError = error;
    }
    let after: GitHubPullRequest;
    try {
      after = await this.#provider.readPullRequest(request.pullRequest);
    } catch {
      throwMutationError(
        plan,
        "PR_MUTATION_POSTCONDITION_READ_FAILED",
        "recovery-required",
        "Merge outcome is not known because the post-mutation pull request reread failed.",
        [
          diagnostic(
            "PR_MUTATION_POSTCONDITION_READ_FAILED",
            "$.postcondition",
            "Merged state cannot be established safely.",
          ),
        ],
        {
          ...emptyEvidence("merge", "recovery-required", providerError === undefined ? "succeeded" : "ambiguous"),
          providerResponse: providerError === undefined ? "accepted" : "ambiguous",
          postcondition: "not-proven",
          current: currentEvidence(before),
        },
      );
    }
    const verifiedMerge =
      providerError === undefined ? mergedMatchingOwnEffect(after, request) : mergedAsRequested(after, request);
    if (verifiedMerge) {
      const outcome = providerError === undefined && providerResponse?.merged === true ? "succeeded" : "idempotent";
      return result(plan, after, outcome, {
        ...emptyEvidence("merge", outcome, providerError === undefined ? "succeeded" : "ambiguous", true),
        postcondition: "merged",
        providerResponse: providerError === undefined ? "accepted" : "ambiguous",
        current: currentEvidence(after),
      });
    }
    const ambiguous = providerError !== undefined && errorIsAmbiguous(providerError);
    throwMutationError(
      plan,
      ambiguous
        ? "PR_MUTATION_RECOVERY_REQUIRED"
        : providerError === undefined && providerResponse?.merged === true
          ? "PR_MUTATION_POSTCONDITION_FAILED"
          : "PR_MUTATION_EFFECT_FAILED",
      ambiguous ? "recovery-required" : "failed",
      ambiguous
        ? "The merge provider result is ambiguous and current evidence does not prove the requested merge."
        : providerError === undefined && providerResponse?.merged === true
          ? "The provider reported a merge, but the verified postcondition does not match the requested PR head/base."
          : "GitHub did not complete the requested pull-request merge.",
      [
        diagnostic(
          ambiguous ? "PR_MUTATION_RECOVERY_REQUIRED" : "PR_MUTATION_POSTCONDITION_FAILED",
          "$.postcondition",
          ambiguous
            ? "Recover by rereading current provider state before retrying."
            : "Requested merged postcondition is not proven.",
        ),
      ],
      {
        ...emptyEvidence(
          "merge",
          ambiguous ? "recovery-required" : "failed",
          providerError === undefined ? "succeeded" : "ambiguous",
        ),
        providerResponse: providerError === undefined ? "accepted" : "ambiguous",
        postcondition: "not-proven",
        current: currentEvidence(after),
      },
    );
  }
}

/** @deprecated Use `LocalSemanticPullRequestMutationExecutor` for the local execution profile. */
export const SemanticPullRequestMutationExecutor = LocalSemanticPullRequestMutationExecutor;
/** @deprecated Use `LocalSemanticPullRequestMutationExecutor` for the local execution profile. */
export type SemanticPullRequestMutationExecutor = LocalSemanticPullRequestMutationExecutor;
