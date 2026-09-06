/**
 * Pure Core observation and drift comparison for semantic Issue projections.
 *
 * GitHubIssue is a bounded, transport-normalized read model.  Native Issue
 * relation evidence is supplied by an adapter; this module never performs
 * GitHub I/O or mutation.  Body markers are accepted only when they use the
 * reserved Inari machine convention, so ordinary prose is never interpreted
 * as a semantic relationship.
 */
import { type IssueReference } from "./contract/issue-reference.js";
import type { DesiredIssueProjection } from "./semantic-issue-projection.js";
import type { GitHubIssue, GitHubMilestone } from "./github/types.js";
export declare const SEMANTIC_ISSUE_OBSERVED_PROJECTION_VERSION: "1";
export type SemanticIssueObservedProjectionVersion = typeof SEMANTIC_ISSUE_OBSERVED_PROJECTION_VERSION;
/** Alias named after the observation operation for consumers using that vocabulary. */
export declare const SEMANTIC_ISSUE_OBSERVATION_VERSION: "1";
export declare const SEMANTIC_ISSUE_OBSERVATION_LIMITS: Readonly<{
    readonly bodyBytes: 1048576;
    readonly titleLength: 255;
    readonly urlLength: 2048;
    readonly metadataValueLength: 512;
    readonly relationReferences: 1000;
    readonly diagnostics: 100;
    readonly diagnosticMessageLength: 500;
    readonly diagnosticValueLength: 512;
    readonly markerLength: 32768;
}>;
export type ObservedIssueRelationRepresentation = "none" | "native" | "body-fallback" | "conflict";
export interface SemanticIssueObservationRepository {
    readonly host?: string;
    readonly hostname?: string;
    readonly repositoryHost?: string;
    readonly repositoryId?: string;
    readonly repository?: string;
    readonly nameWithOwner?: string;
}
export interface ObservedIssueMetadataProjection {
    readonly labels?: readonly string[];
    readonly assignees?: readonly string[];
    readonly milestone?: string;
}
export interface ObservedIssueParentRelationEvidence {
    readonly native?: IssueReference;
    readonly bodyFallback?: IssueReference;
}
export interface ObservedIssueParentRelationProjection {
    readonly relation: "parent";
    readonly reference?: IssueReference;
    readonly representation: ObservedIssueRelationRepresentation;
    readonly evidence: ObservedIssueParentRelationEvidence;
}
export interface ObservedIssueDependsOnRelationEvidence {
    readonly native?: readonly IssueReference[];
    readonly bodyFallback: readonly IssueReference[];
}
export interface ObservedIssueDependsOnRelationProjection {
    readonly relation: "dependsOn";
    readonly references: readonly IssueReference[];
    readonly representation: ObservedIssueRelationRepresentation;
    readonly evidence: ObservedIssueDependsOnRelationEvidence;
}
export type ObservedIssueRelationProjection = ObservedIssueParentRelationProjection | ObservedIssueDependsOnRelationProjection;
export interface ObservedIssueProjection {
    readonly version: SemanticIssueObservedProjectionVersion;
    readonly kind: "issue";
    readonly number?: number;
    readonly state?: "open" | "closed";
    readonly url?: string;
    readonly title: string;
    readonly body: string;
    readonly metadata: ObservedIssueMetadataProjection;
    readonly relations: Readonly<{
        readonly parent: ObservedIssueParentRelationProjection;
        readonly dependsOn: ObservedIssueDependsOnRelationProjection;
    }>;
}
export interface SemanticIssueRelationEvidenceInput {
    readonly native?: IssueReference | readonly IssueReference[];
    /** GitHub endpoint spelling for the semantic dependsOn relation. */
    readonly blockedBy?: readonly IssueReference[];
    /** Explicit body evidence is accepted for adapters that already parsed a bounded marker. */
    readonly bodyFallback?: IssueReference | readonly IssueReference[];
}
export interface SemanticIssueObservationRelations {
    readonly parent?: SemanticIssueRelationEvidenceInput | IssueReference;
    readonly dependsOn?: SemanticIssueRelationEvidenceInput | readonly IssueReference[];
}
export interface SemanticIssueObservationInput {
    readonly issue: GitHubIssue;
    readonly repository?: SemanticIssueObservationRepository;
    readonly relations?: SemanticIssueObservationRelations;
    /** Compatibility spelling for adapters that pass relation evidence separately. */
    readonly relationEvidence?: SemanticIssueObservationRelations;
    readonly nativeParent?: IssueReference;
    readonly nativeDependsOn?: readonly IssueReference[];
    readonly nativeBlockedBy?: readonly IssueReference[];
}
export type SemanticIssueObservationViolationCode = "OBSERVATION_INPUT_INVALID" | "OBSERVATION_INPUT_UNKNOWN_PROPERTY" | "OBSERVED_ISSUE_INVALID" | "OBSERVED_ISSUE_UNKNOWN_PROPERTY" | "OBSERVED_ISSUE_VALUE_INVALID" | "OBSERVED_RELATION_INVALID" | "OBSERVED_RELATION_UNKNOWN_PROPERTY" | "OBSERVED_RELATION_REFERENCE_INVALID" | "OBSERVED_RELATION_MARKER_INVALID" | "OBSERVED_BODY_INVALID";
export interface SemanticIssueObservationViolation {
    readonly code: SemanticIssueObservationViolationCode;
    readonly path: string;
    readonly message: string;
}
export interface SemanticIssueObservationResult {
    readonly valid: boolean;
    readonly projection?: ObservedIssueProjection;
    readonly violations: readonly SemanticIssueObservationViolation[];
}
export declare class SemanticIssueObservationError extends Error {
    readonly violations: readonly SemanticIssueObservationViolation[];
    constructor(violations: readonly SemanticIssueObservationViolation[]);
}
export type SemanticIssueDriftCode = "DESIRED_PROJECTION_INVALID" | "OBSERVED_PROJECTION_INVALID" | "TITLE_DRIFT" | "BODY_DRIFT" | "METADATA_DRIFT" | "RELATION_DRIFT" | "RELATION_CONFLICT" | "RELATION_OBSERVATION_UNAVAILABLE";
export interface SemanticIssueDriftDiagnostic {
    readonly code: SemanticIssueDriftCode;
    readonly path: string;
    readonly message: string;
    readonly expected?: unknown;
    readonly actual?: unknown;
}
export interface SemanticIssueComparisonResult {
    readonly valid: boolean;
    readonly diagnostics: readonly SemanticIssueDriftDiagnostic[];
    readonly drift: readonly SemanticIssueDriftDiagnostic[];
}
/** Normalize a bounded GitHubIssue observation into Core evidence. */
export declare function tryObserveSemanticIssue(input: unknown, options?: unknown): SemanticIssueObservationResult;
export declare function observeSemanticIssue(input: unknown, options?: unknown): ObservedIssueProjection;
export declare const tryObserveSemanticIssueProjection: typeof tryObserveSemanticIssue;
export declare const observeSemanticIssueProjection: typeof observeSemanticIssue;
export declare const tryObserveIssueProjection: typeof tryObserveSemanticIssue;
export declare const observeIssueProjection: typeof observeSemanticIssue;
export declare const observeGitHubIssueProjection: typeof observeSemanticIssue;
/** Compare a desired Issue projection against representation-independent evidence. */
export declare function compareSemanticIssueProjection(desired: DesiredIssueProjection | {
    readonly desired: unknown;
    readonly observed: unknown;
} | unknown, observed?: ObservedIssueProjection | unknown): SemanticIssueComparisonResult;
export declare const compareDesiredIssueProjection: typeof compareSemanticIssueProjection;
export declare const compareSemanticIssue: typeof compareSemanticIssueProjection;
export declare const compareIssueProjection: typeof compareSemanticIssueProjection;
export declare const diffSemanticIssueProjection: typeof compareSemanticIssueProjection;
/** Observe a normalized Issue and compare it without exposing adapter I/O to Core. */
export declare function observeAndCompareSemanticIssue(desired: DesiredIssueProjection | unknown, input: unknown, options?: unknown): SemanticIssueComparisonResult;
export type { GitHubIssue, GitHubMilestone };
