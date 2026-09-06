/**
 * Pure Core observation and drift comparison for semantic pull-request
 * projections.
 *
 * `GitHubPullRequest` is already a bounded, transport-normalized read model.
 * This module accepts that model (plus explicitly supplied native relation
 * evidence), preserves all relation representations as evidence, and never
 * treats an observed value as semantic authority.  It performs no GitHub I/O
 * and no mutation.
 */
import { type IssueReference } from "./contract/issue-reference.js";
import type { DesiredPullRequestProjection } from "./semantic-pr-projection.js";
import type { GitHubMilestone, GitHubPullRequest, GitHubReviewRequests } from "./github/types.js";
export declare const SEMANTIC_PULL_REQUEST_OBSERVED_PROJECTION_VERSION: "1";
export type SemanticPullRequestObservedProjectionVersion = typeof SEMANTIC_PULL_REQUEST_OBSERVED_PROJECTION_VERSION;
/** Alias named after the observation operation for callers that use that vocabulary. */
export declare const SEMANTIC_PULL_REQUEST_OBSERVATION_VERSION: "1";
export declare const SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS: Readonly<{
    readonly bodyBytes: 1048576;
    readonly titleLength: 255;
    readonly refLength: 512;
    readonly metadataValueLength: 512;
    readonly relationReferences: 1000;
    readonly diagnostics: 100;
    readonly diagnosticMessageLength: 500;
    readonly diagnosticValueLength: 512;
}>;
export type ObservedPullRequestRelationRepresentation = "none" | "native" | "recognized-convention" | "body-fallback" | "conflict";
/**
 * Repository identity needed to turn a local `#123` closing reference into
 * the existing representation-independent IssueReference primitive.
 * `repositoryId` is intentionally required when such a reference is present;
 * owner/name alone is not an identity.
 */
export interface SemanticPullRequestObservationRepository {
    readonly host?: string;
    readonly hostname?: string;
    readonly repositoryHost?: string;
    readonly repositoryId?: string;
    readonly repository?: string;
    readonly nameWithOwner?: string;
}
export interface ObservedPullRequestMetadataProjection {
    readonly labels?: readonly string[];
    readonly assignees?: readonly string[];
    readonly milestone?: string;
    /** User logins and team slugs retained as one semantic actor set. */
    readonly reviewers?: readonly string[];
    readonly draft?: boolean;
    readonly maintainerCanModify?: boolean;
}
/** Every source is evidence; `native` is omitted when no native evidence was supplied. */
export interface ObservedPullRequestRelationEvidence {
    readonly native?: readonly IssueReference[];
    readonly recognizedConvention: readonly IssueReference[];
    readonly bodyFallback: readonly IssueReference[];
}
export interface ObservedPullRequestRelationProjection {
    readonly relation: "implements";
    /** Populated only when all non-empty representations reconcile. */
    readonly references: readonly IssueReference[];
    readonly representation: ObservedPullRequestRelationRepresentation;
    readonly evidence: ObservedPullRequestRelationEvidence;
}
/**
 * A representation-independent observation. Optional number/state/url are
 * bounded resource evidence and are not part of desired-vs-observed policy
 * comparison.
 */
export interface ObservedPullRequestProjection {
    readonly version: SemanticPullRequestObservedProjectionVersion;
    readonly kind: "pull_request";
    readonly number?: number;
    readonly state?: "open" | "closed";
    readonly url?: string;
    readonly title: string;
    readonly head: string;
    readonly base: string;
    readonly body: string;
    readonly metadata: ObservedPullRequestMetadataProjection;
    readonly relations: Readonly<{
        readonly implements: ObservedPullRequestRelationProjection;
    }>;
}
/** Native relation evidence supplied by a compatible GitHub observation adapter. */
export interface SemanticPullRequestRelationEvidenceInput {
    readonly native?: readonly IssueReference[];
    /** Optional explicit convention evidence; body parsing remains the default. */
    readonly recognizedConvention?: readonly IssueReference[];
    /** Optional explicit fallback evidence; body parsing remains the default. */
    readonly bodyFallback?: readonly IssueReference[];
}
export interface SemanticPullRequestObservationInput {
    readonly pullRequest: GitHubPullRequest;
    readonly repository?: SemanticPullRequestObservationRepository;
    readonly relations?: Readonly<{
        readonly implements?: SemanticPullRequestRelationEvidenceInput | readonly IssueReference[];
    }>;
    /** Compatibility spelling for adapters that call relation input evidence. */
    readonly relationEvidence?: SemanticPullRequestRelationEvidenceInput;
    /** Convenience spelling for the native `implements` observation. */
    readonly nativeImplements?: readonly IssueReference[];
}
export type SemanticPullRequestObservationViolationCode = "OBSERVATION_INPUT_INVALID" | "OBSERVATION_INPUT_UNKNOWN_PROPERTY" | "OBSERVED_PULL_REQUEST_INVALID" | "OBSERVED_PULL_REQUEST_UNKNOWN_PROPERTY" | "OBSERVED_PULL_REQUEST_VALUE_INVALID" | "OBSERVED_RELATION_INVALID" | "OBSERVED_RELATION_UNKNOWN_PROPERTY" | "OBSERVED_RELATION_REFERENCE_INVALID" | "OBSERVED_RELATION_REFERENCE_UNRESOLVED" | "OBSERVED_RELATION_MARKER_INVALID" | "OBSERVED_BODY_INVALID";
export interface SemanticPullRequestObservationViolation {
    readonly code: SemanticPullRequestObservationViolationCode;
    readonly path: string;
    readonly message: string;
}
export interface SemanticPullRequestObservationResult {
    readonly valid: boolean;
    readonly projection?: ObservedPullRequestProjection;
    readonly violations: readonly SemanticPullRequestObservationViolation[];
}
export declare class SemanticPullRequestObservationError extends Error {
    readonly violations: readonly SemanticPullRequestObservationViolation[];
    constructor(violations: readonly SemanticPullRequestObservationViolation[]);
}
export type SemanticPullRequestDriftCode = "DESIRED_PROJECTION_INVALID" | "OBSERVED_PROJECTION_INVALID" | "TITLE_DRIFT" | "HEAD_DRIFT" | "BASE_DRIFT" | "BODY_DRIFT" | "METADATA_DRIFT" | "RELATION_DRIFT" | "RELATION_CONFLICT" | "RELATION_OBSERVATION_UNAVAILABLE";
export interface SemanticPullRequestDriftDiagnostic {
    readonly code: SemanticPullRequestDriftCode;
    readonly path: string;
    readonly message: string;
    readonly expected?: unknown;
    readonly actual?: unknown;
}
export interface SemanticPullRequestComparisonResult {
    readonly valid: boolean;
    readonly diagnostics: readonly SemanticPullRequestDriftDiagnostic[];
    /** Alias for consumers that call the comparison output a drift report. */
    readonly drift: readonly SemanticPullRequestDriftDiagnostic[];
}
/** Normalize a bounded GitHubPullRequest observation into Core evidence. */
export declare function tryObserveSemanticPullRequest(input: unknown, options?: unknown): SemanticPullRequestObservationResult;
/** Throwing observation entry point for Core callers. */
export declare function observeSemanticPullRequest(input: unknown, options?: unknown): ObservedPullRequestProjection;
export declare const tryObserveSemanticPullRequestProjection: typeof tryObserveSemanticPullRequest;
export declare const observeSemanticPullRequestProjection: typeof observeSemanticPullRequest;
export declare const tryObservePullRequestProjection: typeof tryObserveSemanticPullRequest;
export declare const observePullRequestProjection: typeof observeSemanticPullRequest;
export declare const observeGitHubPullRequestProjection: typeof observeSemanticPullRequest;
/** Compare Core DesiredPullRequestProjection against observed GitHub evidence. */
export declare function compareSemanticPullRequestProjection(desired: DesiredPullRequestProjection | {
    readonly desired: unknown;
    readonly observed: unknown;
} | unknown, observed?: ObservedPullRequestProjection | unknown): SemanticPullRequestComparisonResult;
export declare const compareDesiredPullRequestProjection: typeof compareSemanticPullRequestProjection;
export declare const compareSemanticPullRequest: typeof compareSemanticPullRequestProjection;
export declare const comparePullRequestProjection: typeof compareSemanticPullRequestProjection;
export declare const diffSemanticPullRequestProjection: typeof compareSemanticPullRequestProjection;
/** Convenience wrapper for callers that first normalize raw GitHub evidence. */
export declare function observeAndCompareSemanticPullRequest(desired: DesiredPullRequestProjection | unknown, input: unknown, options?: unknown): SemanticPullRequestComparisonResult;
export type { GitHubMilestone, GitHubPullRequest, GitHubReviewRequests };
