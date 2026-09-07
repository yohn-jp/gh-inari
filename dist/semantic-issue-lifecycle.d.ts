/**
 * Pure Core projection of Issue lifecycle evidence.
 *
 * This module deliberately consumes the existing Observed Issue Projection
 * and IssueReference primitives.  It does not parse Markdown, perform
 * GitHub I/O, or mutate an Issue.  The input is a bounded set of observed
 * Issues; parent/dependsOn remain the only forward relation authorities and
 * children/blocks/supersededBy are derived views.
 */
import { type IssueReference } from "./contract/issue-reference.js";
import type { SemanticArtifact } from "./contract/semantic-artifact.js";
import type { ObservedIssueProjection } from "./semantic-issue-observation.js";
export declare const SEMANTIC_ISSUE_LIFECYCLE_VERSION: "1";
export type SemanticIssueLifecycleVersion = typeof SEMANTIC_ISSUE_LIFECYCLE_VERSION;
export declare const SEMANTIC_ISSUE_LIFECYCLE_LIMITS: Readonly<{
    readonly issues: 1000;
    readonly references: 1000;
    readonly diagnostics: 100;
    readonly messageLength: 500;
}>;
export type SemanticIssueLifecycleRole = "tracker" | "leaf";
export type SemanticIssueLifecycleEvidenceStatus = "present" | "empty" | "unavailable";
export type SemanticIssueLifecycleCompletionStatus = "complete" | "in-progress" | "unknown" | "not-declared";
/** Explicit lifecycle semantics supplied by the existing Artifact Contract. */
export interface SemanticIssueLifecycleDeclaration {
    /** Explicit role; no role is inferred from the graph or prose. */
    readonly role?: SemanticIssueLifecycleRole;
    /** Canonical forward supersession relation. */
    readonly supersedes?: readonly IssueReference[];
    /** Compatibility evidence for the derived inverse view. */
    readonly supersededBy?: readonly IssueReference[];
}
/**
 * Bounded checklist evidence.  Checklist entries are IssueReferences so a
 * checklist can be compared with the same cross-repository child identity
 * used by the relation graph.
 */
export interface SemanticIssueChecklistEvidence {
    readonly status: "present" | "unavailable";
    readonly completed: readonly IssueReference[];
    readonly remaining: readonly IssueReference[];
}
/** One observed Issue and its optional explicit lifecycle declaration. */
export interface SemanticIssueLifecycleNode {
    readonly reference: IssueReference;
    readonly observed?: ObservedIssueProjection;
    /** Optional materialized Issue Artifact carrying the declaration values. */
    readonly artifact?: SemanticArtifact;
    /** Narrow adapter input for callers that already extracted Artifact values. */
    readonly declaration?: SemanticIssueLifecycleDeclaration;
    readonly checklist?: SemanticIssueChecklistEvidence;
}
/**
 * The set itself is the bounded evidence scope.  `scope: unavailable` is
 * useful when an adapter could not establish that the set is complete; in
 * that case inverse views and completion fail closed.
 */
export interface SemanticIssueLifecycleInput {
    readonly scope?: "complete" | "unavailable";
    readonly issues: readonly SemanticIssueLifecycleNode[];
}
export interface SemanticIssueLifecycleCompletion {
    readonly status: SemanticIssueLifecycleCompletionStatus;
    readonly children: readonly IssueReference[];
    readonly completed: readonly IssueReference[];
    readonly remaining: readonly IssueReference[];
    /** Set only when exactly one authoritative child remains incomplete. */
    readonly finalGateRemainder?: IssueReference;
}
export interface SemanticIssueLifecycleIssueProjection {
    readonly reference: IssueReference;
    readonly role?: SemanticIssueLifecycleRole;
    readonly parent?: IssueReference;
    readonly parentEvidence: SemanticIssueLifecycleEvidenceStatus;
    readonly children: readonly IssueReference[];
    readonly childrenEvidence: SemanticIssueLifecycleEvidenceStatus;
    readonly dependsOn: readonly IssueReference[];
    readonly dependsOnEvidence: SemanticIssueLifecycleEvidenceStatus;
    readonly blocks: readonly IssueReference[];
    readonly blocksEvidence: SemanticIssueLifecycleEvidenceStatus;
    readonly supersedes: readonly IssueReference[];
    readonly supersededBy: readonly IssueReference[];
    readonly supersessionEvidence: SemanticIssueLifecycleEvidenceStatus;
    readonly completion: SemanticIssueLifecycleCompletion;
    readonly checklist?: SemanticIssueChecklistEvidence;
    readonly drift: readonly SemanticIssueLifecycleDiagnostic[];
}
export interface SemanticIssueLifecycleProjection {
    readonly version: SemanticIssueLifecycleVersion;
    readonly kind: "issue-lifecycle";
    readonly scope: "complete" | "unavailable";
    readonly issues: readonly SemanticIssueLifecycleIssueProjection[];
}
export type SemanticIssueLifecycleDiagnosticCode = "INPUT_INVALID" | "INPUT_UNKNOWN_PROPERTY" | "REFERENCE_INVALID" | "REFERENCE_DUPLICATE" | "ISSUE_DUPLICATE" | "OBSERVED_ISSUE_INVALID" | "DECLARATION_INVALID" | "CHECKLIST_INVALID" | "EVIDENCE_UNAVAILABLE" | "RELATION_CONFLICT" | "RELATION_DRIFT" | "SUPERSESSION_DRIFT" | "ROLE_RELATION_DRIFT" | "COMPLETION_DRIFT" | "CHECKLIST_RELATION_DRIFT";
export interface SemanticIssueLifecycleDiagnostic {
    readonly code: SemanticIssueLifecycleDiagnosticCode;
    readonly path: string;
    readonly message: string;
    readonly expected?: unknown;
    readonly actual?: unknown;
}
export interface SemanticIssueLifecycleResult {
    readonly valid: boolean;
    readonly projection?: SemanticIssueLifecycleProjection;
    readonly diagnostics: readonly SemanticIssueLifecycleDiagnostic[];
}
export declare class SemanticIssueLifecycleError extends Error {
    readonly diagnostics: readonly SemanticIssueLifecycleDiagnostic[];
    constructor(diagnostics: readonly SemanticIssueLifecycleDiagnostic[]);
}
/** Project bounded Issue observations into lifecycle and inverse relation views. */
export declare function tryProjectSemanticIssueLifecycle(input: unknown): SemanticIssueLifecycleResult;
/** Throwing lifecycle projection entry point for Core callers. */
export declare function projectSemanticIssueLifecycle(input: unknown): SemanticIssueLifecycleProjection;
export declare const tryProjectIssueLifecycle: typeof tryProjectSemanticIssueLifecycle;
export declare const projectIssueLifecycle: typeof projectSemanticIssueLifecycle;
export declare const observeSemanticIssueLifecycle: typeof projectSemanticIssueLifecycle;
export declare const tryObserveSemanticIssueLifecycle: typeof tryProjectSemanticIssueLifecycle;
