/**
 * Bounded re-entry evidence for an Implementation whose canonical Change is
 * already in REVIEW.
 *
 * This is a projection over the existing Change, Operational Observation,
 * Implementation authorization, and Session-binding authorities.  It is not
 * a review authority and it does not introduce a second lifecycle.  In
 * particular, review prose is deliberately absent from the rework marker.
 */

import {
  validateChangeProjectionResult,
  type ChangeProjectionResult,
  type ChangePullRequestEvidence,
} from "./change.js";
import {
  validateImplementationSessionAuthorizationBinding,
  type ImplementationSessionAuthorizationBinding,
} from "./implementation-session-binding.js";
import {
  tryVerifyImplementationAuthorization,
  type ImplementationAuthorizationRecord,
} from "./implementation-authorization.js";
import { tryObserveOperationalPullRequest, type OperationalPullRequestObservation } from "./operational-observation.js";
import { issueReferenceKey, normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";

export const IMPLEMENTATION_REWORK_VERSION = 1 as const;
export const IMPLEMENTATION_REWORK_KIND = "implementation-review-rework" as const;

export const IMPLEMENTATION_REWORK_CLASSIFICATIONS = Object.freeze(["REWORK_REQUESTED", "NO_REWORK"] as const);
export type ImplementationReworkClassification = (typeof IMPLEMENTATION_REWORK_CLASSIFICATIONS)[number];

export const IMPLEMENTATION_REWORK_ACTIONS = Object.freeze(["REWORK", "NONE"] as const);
export type ImplementationReworkAction = (typeof IMPLEMENTATION_REWORK_ACTIONS)[number];

/** The only review intent admitted to a write-capable rework request. */
export const IMPLEMENTATION_REWORK_REVIEW_INTENT = "request-changes" as const;

/**
 * Signed Session request metadata for one bounded rework attempt.  This is
 * evidence of a current review classification, not write authority.  The
 * authority remains the current Implementation-bound Session and its
 * `branch.advance` capability.
 */
export interface ImplementationReworkMarker {
  readonly version: typeof IMPLEMENTATION_REWORK_VERSION;
  readonly kind: typeof IMPLEMENTATION_REWORK_KIND;
  readonly intent: typeof IMPLEMENTATION_REWORK_REVIEW_INTENT;
  readonly pullRequest: number;
  readonly reviewId: number;
  readonly reviewHead: string;
  readonly authorizationDigest: string;
}

export interface ImplementationReworkReview {
  readonly id: number;
  readonly state: "changes_requested";
  readonly head: string;
}

export interface ImplementationReworkCanonicalIdentity {
  readonly issue: number;
  readonly branch: string;
  readonly pullRequest: number;
}

export interface ImplementationReworkProjection {
  readonly version: typeof IMPLEMENTATION_REWORK_VERSION;
  readonly kind: typeof IMPLEMENTATION_REWORK_KIND;
  readonly classification: ImplementationReworkClassification;
  readonly action: ImplementationReworkAction;
  readonly canonical: ImplementationReworkCanonicalIdentity;
  readonly currentHead: string;
  /** The old review/conformance head cannot be reused after branch advance. */
  readonly requiresFreshConformance: true;
  /** Re-entry always returns through the existing conformance-gated Ready. */
  readonly returnTransition: "change.ready";
  readonly review?: ImplementationReworkReview;
  readonly authorization?: ImplementationAuthorizationRecord;
  readonly session?: ImplementationSessionAuthorizationBinding;
  readonly rework?: ImplementationReworkMarker;
}

export interface ImplementationReworkInput {
  /** A fresh, healthy Change projection containing the canonical PR head. */
  readonly change: unknown;
  /** Raw provider evidence normalized by Operational Observation. */
  readonly pullRequest: unknown;
  /** Optional expected head supplied by the caller; it is never trusted over the reread. */
  readonly expectedHead?: unknown;
  /** Current authorization and its current Issue/repository/base evidence. */
  readonly authorization?: unknown;
  readonly implementation?: unknown;
  readonly issue?: unknown;
  readonly repository?: unknown;
  readonly base?: unknown;
  /** The new Session's Implementation authorization binding. */
  readonly session?: unknown;
}

export type ImplementationReworkDiagnosticCode =
  | "IMPLEMENTATION_REWORK_INPUT_INVALID"
  | "IMPLEMENTATION_REWORK_CHANGE_INVALID"
  | "IMPLEMENTATION_REWORK_PULL_REQUEST_INVALID"
  | "IMPLEMENTATION_REWORK_CANONICAL_PR_MISMATCH"
  | "IMPLEMENTATION_REWORK_REVIEW_UNAVAILABLE"
  | "IMPLEMENTATION_REWORK_REVIEW_SUBSTITUTION"
  | "IMPLEMENTATION_REWORK_STALE_HEAD"
  | "IMPLEMENTATION_REWORK_AUTHORIZATION_INVALID"
  | "IMPLEMENTATION_REWORK_STALE_AUTHORIZATION"
  | "IMPLEMENTATION_REWORK_SESSION_INVALID"
  | "IMPLEMENTATION_REWORK_SESSION_MISMATCH";

export interface ImplementationReworkDiagnostic {
  readonly code: ImplementationReworkDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface ImplementationReworkProjectionResult {
  readonly valid: boolean;
  readonly projection?: ImplementationReworkProjection;
  readonly diagnostics: readonly ImplementationReworkDiagnostic[];
}

export interface ImplementationReworkExecutionProjection {
  readonly version: typeof IMPLEMENTATION_REWORK_VERSION;
  readonly kind: typeof IMPLEMENTATION_REWORK_KIND;
  readonly outcome: "advanced" | "idempotent";
  readonly previousHead: string;
  readonly currentHead: string;
  readonly requiresFreshConformance: true;
  readonly returnTransition: "change.ready";
}

export interface ImplementationReworkExecutionProjectionResult {
  readonly valid: boolean;
  readonly projection?: ImplementationReworkExecutionProjection;
  readonly diagnostics: readonly ImplementationReworkDiagnostic[];
}

export class ImplementationReworkError extends Error {
  readonly diagnostics: readonly ImplementationReworkDiagnostic[];

  constructor(diagnostics: readonly ImplementationReworkDiagnostic[]) {
    super(diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join("\n"));
    this.name = "ImplementationReworkError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

type RecordValue = Record<string, unknown>;

const INPUT_KEYS = new Set([
  "change",
  "pullRequest",
  "expectedHead",
  "authorization",
  "implementation",
  "issue",
  "repository",
  "base",
  "session",
]);
const MARKER_KEYS = new Set([
  "version",
  "kind",
  "intent",
  "pullRequest",
  "reviewId",
  "reviewHead",
  "authorizationDigest",
]);
const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function diagnostic(
  diagnostics: ImplementationReworkDiagnostic[],
  code: ImplementationReworkDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function unknownProperties(
  value: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: ImplementationReworkDiagnostic[],
): void {
  for (const key of Object.keys(value).sort())
    if (!allowed.has(key))
      diagnostic(diagnostics, "IMPLEMENTATION_REWORK_INPUT_INVALID", `${path}.${key}`, "Property is not supported.");
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function sameReference(left: IssueReference, right: IssueReference): boolean {
  return issueReferenceKey(left) === issueReferenceKey(right);
}

function sameRepository(
  left: { readonly repositoryHost: string; readonly repositoryId: string },
  right: { readonly repositoryHost: string; readonly repositoryId: string },
): boolean {
  return (
    left.repositoryHost.toLowerCase() === right.repositoryHost.toLowerCase() && left.repositoryId === right.repositoryId
  );
}

function sameBase(
  left: { readonly branch: string; readonly revision: string; readonly freshness: string },
  right: { readonly branch: string; readonly revision: string; readonly freshness: string },
): boolean {
  return left.branch === right.branch && left.revision === right.revision && left.freshness === right.freshness;
}

function markerDiagnostics(input: unknown): readonly ImplementationReworkDiagnostic[] {
  const diagnostics: ImplementationReworkDiagnostic[] = [];
  if (!isRecord(input)) {
    diagnostic(diagnostics, "IMPLEMENTATION_REWORK_INPUT_INVALID", "$", "Rework marker must be an object.");
    return diagnostics;
  }
  unknownProperties(input, MARKER_KEYS, "$", diagnostics);
  if (input.version !== IMPLEMENTATION_REWORK_VERSION)
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_INPUT_INVALID",
      "$.version",
      "Rework marker version is unsupported.",
    );
  if (input.kind !== IMPLEMENTATION_REWORK_KIND)
    diagnostic(diagnostics, "IMPLEMENTATION_REWORK_INPUT_INVALID", "$.kind", "Rework marker kind is unsupported.");
  if (input.intent !== IMPLEMENTATION_REWORK_REVIEW_INTENT)
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_REVIEW_SUBSTITUTION",
      "$.intent",
      "Only request-changes review intent is admitted.",
    );
  if (!positiveInteger(input.pullRequest))
    diagnostic(diagnostics, "IMPLEMENTATION_REWORK_INPUT_INVALID", "$.pullRequest", "Pull request number is invalid.");
  if (!positiveInteger(input.reviewId))
    diagnostic(diagnostics, "IMPLEMENTATION_REWORK_INPUT_INVALID", "$.reviewId", "Review id is invalid.");
  if (typeof input.reviewHead !== "string" || !SHA1.test(input.reviewHead))
    diagnostic(diagnostics, "IMPLEMENTATION_REWORK_INPUT_INVALID", "$.reviewHead", "Review head must be a commit SHA.");
  if (typeof input.authorizationDigest !== "string" || !SHA256.test(input.authorizationDigest))
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_INPUT_INVALID",
      "$.authorizationDigest",
      "Authorization digest is invalid.",
    );
  return Object.freeze(diagnostics);
}

/** Validate the body-free marker accepted by branch.advance. */
export function validateImplementationReworkMarker(input: unknown): {
  readonly valid: boolean;
  readonly marker?: ImplementationReworkMarker;
  readonly diagnostics: readonly ImplementationReworkDiagnostic[];
} {
  const diagnostics = markerDiagnostics(input);
  if (diagnostics.length > 0) return { valid: false, diagnostics };
  const value = input as RecordValue;
  const marker: ImplementationReworkMarker = Object.freeze({
    version: IMPLEMENTATION_REWORK_VERSION,
    kind: IMPLEMENTATION_REWORK_KIND,
    intent: IMPLEMENTATION_REWORK_REVIEW_INTENT,
    pullRequest: value.pullRequest as number,
    reviewId: value.reviewId as number,
    reviewHead: value.reviewHead as string,
    authorizationDigest: value.authorizationDigest as string,
  });
  return { valid: true, marker, diagnostics: [] };
}

function invalid(diagnostics: readonly ImplementationReworkDiagnostic[]): {
  readonly valid: false;
  readonly diagnostics: readonly ImplementationReworkDiagnostic[];
} {
  return { valid: false, diagnostics: Object.freeze([...diagnostics]) };
}

function currentPullRequest(projection: ChangeProjectionResult): ChangePullRequestEvidence | undefined {
  const pullRequest = projection.change?.projection?.pullRequest;
  const branch = projection.canonicalBranch;
  const base = projection.canonicalBaseBranch;
  return projection.candidates.pullRequests.find(
    (candidate) =>
      candidate.classification === "canonical" &&
      candidate.candidate.number === pullRequest &&
      candidate.candidate.head === branch &&
      candidate.candidate.base === base,
  )?.candidate;
}

function reviewState(value: string): string {
  return value.toLowerCase().replace(/-/gu, "_");
}

function freshReview(
  observation: OperationalPullRequestObservation,
  head: string,
  diagnostics: ImplementationReworkDiagnostic[],
): ImplementationReworkReview | undefined {
  if (observation.reviews.status !== "available" || observation.reviews.pagination.truncated) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_REVIEW_UNAVAILABLE",
      "$.pullRequest.reviews",
      "Current pull-request review evidence is unavailable or truncated.",
    );
    return undefined;
  }
  const requested = observation.reviews.items.filter((review) => reviewState(review.state) === "changes_requested");
  const current = requested.filter((review) => review.commitId?.toLowerCase() === head);
  if (current.length > 0) {
    const review = [...current].sort((left, right) => right.id - left.id)[0];
    if (review === undefined) return undefined;
    return { id: review.id, state: "changes_requested", head };
  }
  if (requested.length > 0 || observation.reviewDecision === "changes_requested") {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_STALE_HEAD",
      "$.pullRequest.reviews",
      "The request-changes review is not bound to the current pull-request head.",
    );
  }
  return undefined;
}

function authorizationAndSession(
  input: RecordValue,
  identity: ImplementationReworkCanonicalIdentity,
  diagnostics: ImplementationReworkDiagnostic[],
):
  | {
      readonly authorization: ImplementationAuthorizationRecord;
      readonly session: ImplementationSessionAuthorizationBinding;
    }
  | undefined {
  const authorizationResult = tryVerifyImplementationAuthorization({
    authorization: input.authorization,
    implementation: input.implementation,
    issue: input.issue,
    repository: input.repository,
    base: input.base,
  });
  if (
    !authorizationResult.valid ||
    !authorizationResult.current ||
    !authorizationResult.authorized ||
    authorizationResult.authorization === undefined
  ) {
    const stale = authorizationResult.violations.some((violation) =>
      [
        "IMPLEMENTATION_MODIFIED_AFTER_AUTHORIZATION",
        "IMPLEMENTATION_AUTHORIZATION_BINDING_DRIFT",
        "IMPLEMENTATION_AUTHORIZATION_BASE_REVISION_MISMATCH",
        "IMPLEMENTATION_AUTHORIZATION_BASE_FRESHNESS_MISMATCH",
      ].includes(violation.code),
    );
    diagnostic(
      diagnostics,
      stale ? "IMPLEMENTATION_REWORK_STALE_AUTHORIZATION" : "IMPLEMENTATION_REWORK_AUTHORIZATION_INVALID",
      "$.authorization",
      stale ? "Implementation authorization is stale." : "A current Implementation authorization is required.",
    );
    return undefined;
  }
  const authorization = authorizationResult.authorization;
  if (authorization.implementation.number !== identity.issue) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_SESSION_MISMATCH",
      "$.authorization.implementation",
      "Implementation authorization does not target the canonical Change root.",
    );
    return undefined;
  }

  const sessionResult = validateImplementationSessionAuthorizationBinding(input.session);
  if (!sessionResult.valid || sessionResult.binding === undefined) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_SESSION_INVALID",
      "$.session",
      "A new current Implementation Session binding is required.",
    );
    return undefined;
  }
  const session = sessionResult.binding;
  if (
    session.task.kind !== "issue" ||
    session.task.number !== identity.issue ||
    !sameReference(session.authorization.implementation, authorization.implementation) ||
    session.authorization.governedBodyDigest !== authorization.governedBodyDigest ||
    !sameRepository(session.repository, authorization.repository) ||
    !sameBase(session.base, authorization.base)
  ) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_SESSION_MISMATCH",
      "$.session",
      "Session binding does not match the current Implementation authorization and canonical task.",
    );
    return undefined;
  }
  return { authorization, session };
}

/**
 * Classify one fresh REVIEW observation.  No review body or caller-supplied
 * review intent is read as authority; only provider-normalized state and the
 * review's commit identity can request rework.
 */
export function tryProjectImplementationReviewRework(input: unknown): ImplementationReworkProjectionResult {
  const diagnostics: ImplementationReworkDiagnostic[] = [];
  if (!isRecord(input))
    return invalid([
      { code: "IMPLEMENTATION_REWORK_INPUT_INVALID", path: "$", message: "Rework input must be an object." },
    ]);
  unknownProperties(input, INPUT_KEYS, "$", diagnostics);
  if (diagnostics.length > 0) return invalid(diagnostics);

  const projectionResult = validateChangeProjectionResult(input.change);
  if (!projectionResult.valid || projectionResult.projection === undefined) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_CHANGE_INVALID",
      "$.change",
      "A canonical Change projection is required.",
    );
    return invalid(diagnostics);
  }
  const projection = projectionResult.projection;
  const change = projection.change;
  const physicalPullRequest = currentPullRequest(projection);
  if (
    !projection.valid ||
    projection.status !== "healthy" ||
    change === undefined ||
    change.state !== "REVIEW" ||
    projection.canonicalBranch === undefined ||
    projection.canonicalBaseBranch === undefined ||
    physicalPullRequest === undefined ||
    physicalPullRequest.headSha === undefined
  ) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_CHANGE_INVALID",
      "$.change",
      "Rework requires a healthy canonical REVIEW projection with a current head.",
    );
    return invalid(diagnostics);
  }

  const observationResult = tryObserveOperationalPullRequest({ pullRequest: input.pullRequest });
  if (!observationResult.valid || observationResult.observation === undefined) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_PULL_REQUEST_INVALID",
      "$.pullRequest",
      "Current pull-request evidence is invalid.",
    );
    return invalid(diagnostics);
  }
  const observation = observationResult.observation;
  const head = observation.head.sha;
  const canonical: ImplementationReworkCanonicalIdentity = {
    issue: change.identity.rootIssue,
    branch: projection.canonicalBranch,
    pullRequest: change.projection?.pullRequest ?? 0,
  };
  if (
    !positiveInteger(canonical.pullRequest) ||
    observation.number !== canonical.pullRequest ||
    observation.repository.repositoryId !== change.identity.repositoryId ||
    observation.head.branch !== canonical.branch ||
    observation.base.branch !== projection.canonicalBaseBranch
  ) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_CANONICAL_PR_MISMATCH",
      "$.pullRequest",
      "Rework may target only the canonical PR and branch.",
    );
    return invalid(diagnostics);
  }
  if (observation.state !== "open" || observation.draft === true || head === "unknown" || !SHA1.test(head)) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_STALE_HEAD",
      "$.pullRequest.head.sha",
      "Current canonical PR head is unavailable or not review-bound.",
    );
    return invalid(diagnostics);
  }
  if (physicalPullRequest.headSha !== head) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_STALE_HEAD",
      "$.change.candidates.pullRequests.headSha",
      "Change projection and current PR head disagree.",
    );
    return invalid(diagnostics);
  }
  if (input.expectedHead !== undefined && (typeof input.expectedHead !== "string" || input.expectedHead !== head)) {
    diagnostic(diagnostics, "IMPLEMENTATION_REWORK_STALE_HEAD", "$.expectedHead", "Expected review head is stale.");
    return invalid(diagnostics);
  }

  const review = freshReview(observation, head, diagnostics);
  if (diagnostics.length > 0) return invalid(diagnostics);
  const baseProjection = {
    version: IMPLEMENTATION_REWORK_VERSION,
    kind: IMPLEMENTATION_REWORK_KIND,
    canonical,
    currentHead: head,
    requiresFreshConformance: true as const,
    returnTransition: "change.ready" as const,
  };
  if (review === undefined) {
    return {
      valid: true,
      projection: Object.freeze({
        ...baseProjection,
        classification: "NO_REWORK" as const,
        action: "NONE" as const,
      }),
      diagnostics: [],
    };
  }

  const current = authorizationAndSession(input, canonical, diagnostics);
  if (current === undefined || diagnostics.length > 0) return invalid(diagnostics);
  const rework: ImplementationReworkMarker = Object.freeze({
    version: IMPLEMENTATION_REWORK_VERSION,
    kind: IMPLEMENTATION_REWORK_KIND,
    intent: IMPLEMENTATION_REWORK_REVIEW_INTENT,
    pullRequest: canonical.pullRequest,
    reviewId: review.id,
    reviewHead: review.head,
    authorizationDigest: current.authorization.governedBodyDigest,
  });
  return {
    valid: true,
    projection: Object.freeze({
      ...baseProjection,
      classification: "REWORK_REQUESTED" as const,
      action: "REWORK" as const,
      review,
      authorization: current.authorization,
      session: current.session,
      rework,
    }),
    diagnostics: [],
  };
}

export function projectImplementationReviewRework(input: unknown): ImplementationReworkProjection {
  const result = tryProjectImplementationReviewRework(input);
  if (!result.valid || result.projection === undefined) throw new ImplementationReworkError(result.diagnostics);
  return result.projection;
}

/**
 * Project the existing branch.advance outcome.  Both an actual advance and
 * the existing CAS idempotent replay re-enter through the same Ready
 * transition; neither outcome creates a rework state or lifecycle record.
 */
export function tryProjectImplementationReworkExecution(input: unknown): ImplementationReworkExecutionProjectionResult {
  const diagnostics: ImplementationReworkDiagnostic[] = [];
  if (!isRecord(input)) {
    diagnostic(diagnostics, "IMPLEMENTATION_REWORK_INPUT_INVALID", "$", "Rework execution input must be an object.");
    return invalid(diagnostics);
  }
  unknownProperties(input, new Set(["marker", "branchAdvance"]), "$", diagnostics);
  const markerResult = validateImplementationReworkMarker(input.marker);
  if (!markerResult.valid || markerResult.marker === undefined) {
    diagnostics.push(...markerResult.diagnostics);
    return invalid(diagnostics);
  }
  const branchAdvance = input.branchAdvance;
  if (!isRecord(branchAdvance)) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_INPUT_INVALID",
      "$.branchAdvance",
      "Branch advance result is required.",
    );
    return invalid(diagnostics);
  }
  if (
    branchAdvance.version !== 1 ||
    branchAdvance.operation !== "branch.advance" ||
    branchAdvance.status !== "succeeded" ||
    (branchAdvance.outcome !== "advanced" && branchAdvance.outcome !== "idempotent")
  ) {
    if (branchAdvance.outcome === "stale")
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_REWORK_STALE_HEAD",
        "$.branchAdvance",
        "Branch advance rejected a stale head.",
      );
    else
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_REWORK_INPUT_INVALID",
        "$.branchAdvance",
        "Branch advance did not prove a rework outcome.",
      );
    return invalid(diagnostics);
  }
  if (
    branchAdvance.branch !== undefined &&
    (typeof branchAdvance.branch !== "string" || branchAdvance.branch.length === 0)
  ) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_INPUT_INVALID",
      "$.branchAdvance.branch",
      "Branch identity is invalid.",
    );
    return invalid(diagnostics);
  }
  if (branchAdvance.expectedHead !== markerResult.marker.reviewHead) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_STALE_HEAD",
      "$.branchAdvance.expectedHead",
      "Rework expected head is stale.",
    );
    return invalid(diagnostics);
  }
  if (typeof branchAdvance.resultingHead !== "string" || !SHA1.test(branchAdvance.resultingHead)) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_STALE_HEAD",
      "$.branchAdvance.resultingHead",
      "A new verified head is required.",
    );
    return invalid(diagnostics);
  }
  if (branchAdvance.resultingHead === markerResult.marker.reviewHead) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_REWORK_STALE_HEAD",
      "$.branchAdvance.resultingHead",
      "Rework must produce a new head.",
    );
    return invalid(diagnostics);
  }
  return {
    valid: true,
    projection: Object.freeze({
      version: IMPLEMENTATION_REWORK_VERSION,
      kind: IMPLEMENTATION_REWORK_KIND,
      outcome: branchAdvance.outcome,
      previousHead: markerResult.marker.reviewHead,
      currentHead: branchAdvance.resultingHead,
      requiresFreshConformance: true,
      returnTransition: "change.ready",
    }),
    diagnostics: [],
  };
}

export function projectImplementationReworkExecution(input: unknown): ImplementationReworkExecutionProjection {
  const result = tryProjectImplementationReworkExecution(input);
  if (!result.valid || result.projection === undefined) throw new ImplementationReworkError(result.diagnostics);
  return result.projection;
}

export const tryProjectImplementationReworkResult = tryProjectImplementationReworkExecution;
export const projectImplementationReworkResult = projectImplementationReworkExecution;

/** Compatibility aliases for callers that name the boundary by admission. */
export const tryAdmitImplementationReviewRework = tryProjectImplementationReviewRework;
export const admitImplementationReviewRework = projectImplementationReviewRework;
export const classifyImplementationReviewRework = projectImplementationReviewRework;

/** Produce the exact body-free marker that may be embedded in branch.advance. */
export function createImplementationReworkMarker(input: unknown): ImplementationReworkMarker {
  const projection = projectImplementationReviewRework(input);
  if (projection.rework === undefined)
    throw new ImplementationReworkError([
      {
        code: "IMPLEMENTATION_REWORK_REVIEW_SUBSTITUTION",
        path: "$.review",
        message: "No current request-changes review requests rework.",
      },
    ]);
  return projection.rework;
}
