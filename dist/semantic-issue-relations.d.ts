/**
 * Transport-neutral Core planning for native Semantic Issue relationships.
 *
 * `parent` and `dependsOn` are the only forward semantic authorities.  The
 * provider-facing `children`/`blocks` views are deliberately not accepted as
 * mutation input here.  This module computes bounded deltas from normalized
 * desired and observed evidence; it never performs provider I/O.
 */
import { type IssueReference } from "./contract/issue-reference.js";
import type { ArtifactContractProvenance } from "./contract/ir.js";
import type { DesiredIssueProjection } from "./semantic-issue-projection.js";
import type { ObservedIssueProjection } from "./semantic-issue-observation.js";
export declare const SEMANTIC_ISSUE_RELATION_PLAN_VERSION: "1";
export type SemanticIssueRelationPlanVersion = typeof SEMANTIC_ISSUE_RELATION_PLAN_VERSION;
export type SemanticIssueRelationRepresentation = "none" | "native" | "body-fallback";
export interface SemanticIssueRelationState {
    readonly parent?: IssueReference;
    readonly dependsOn: readonly IssueReference[];
}
export interface SemanticIssueRelationDesiredState extends SemanticIssueRelationState {
    readonly parentRepresentation: SemanticIssueRelationRepresentation;
    readonly dependsOnRepresentation: SemanticIssueRelationRepresentation;
}
export type SemanticIssueRelationEvidenceStatus = "complete" | "unavailable" | "ambiguous";
export interface SemanticIssueRelationObservedState extends SemanticIssueRelationState {
    readonly parentStatus: "empty" | "present" | "unavailable" | "conflict";
    readonly dependsOnStatus: "empty" | "present" | "unavailable" | "conflict";
    readonly status: SemanticIssueRelationEvidenceStatus;
}
export type SemanticIssueRelationEffect = {
    readonly kind: "SET_PARENT_RELATION";
    readonly parent: IssueReference;
} | {
    readonly kind: "CLEAR_PARENT_RELATION";
    /** The observed parent used to make the delete bounded and conditional. */
    readonly previousParent?: IssueReference;
} | {
    readonly kind: "ADD_BLOCKED_BY_RELATION";
    readonly reference: IssueReference;
} | {
    readonly kind: "REMOVE_BLOCKED_BY_RELATION";
    readonly reference: IssueReference;
};
/** Compatibility aliases for callers that omit the `_RELATION` suffix. */
export type SemanticIssueRelationDelta = SemanticIssueRelationEffect;
export interface SemanticIssueRelationPrecondition {
    readonly kind: "RELATION_OBSERVATION_MATCH";
    readonly observed: SemanticIssueRelationObservedState;
}
export interface SemanticIssueRelationMutationPlan {
    readonly version: SemanticIssueRelationPlanVersion;
    readonly kind: "issue-relations";
    readonly subject: IssueReference;
    readonly desired: SemanticIssueRelationDesiredState;
    readonly observed: SemanticIssueRelationObservedState;
    readonly capabilities: readonly string[];
    readonly provenance?: ArtifactContractProvenance;
    readonly generation?: ArtifactContractProvenance;
    readonly preconditions: readonly SemanticIssueRelationPrecondition[];
    readonly effects: readonly SemanticIssueRelationEffect[];
}
export type SemanticIssueRelationDiagnosticCode = "RELATION_INPUT_INVALID" | "RELATION_INPUT_UNKNOWN_PROPERTY" | "RELATION_REFERENCE_INVALID" | "RELATION_REFERENCE_DUPLICATE" | "RELATION_SELF" | "RELATION_KIND_UNSUPPORTED" | "RELATION_PARENT_CYCLE" | "RELATION_DEPENDENCY_CYCLE" | "RELATION_CROSS_REPOSITORY_UNSUPPORTED" | "RELATION_CAPABILITY_UNSUPPORTED" | "RELATION_EVIDENCE_UNAVAILABLE" | "RELATION_CONFLICT" | "RELATION_STALE" | "RELATION_PLAN_INVALID";
export interface SemanticIssueRelationDiagnostic {
    readonly code: SemanticIssueRelationDiagnosticCode;
    readonly path: string;
    readonly message: string;
}
export interface SemanticIssueRelationGraphNode {
    readonly reference: IssueReference;
    readonly parent?: IssueReference;
    readonly dependsOn: readonly IssueReference[];
}
export interface SemanticIssueRelationGraph {
    readonly scope: "complete" | "unavailable";
    readonly nodes: readonly SemanticIssueRelationGraphNode[];
}
export interface SemanticIssueRelationGraphResult {
    readonly valid: boolean;
    readonly graph?: SemanticIssueRelationGraph;
    readonly diagnostics: readonly SemanticIssueRelationDiagnostic[];
}
export interface SemanticIssueRelationMutationPlanResult {
    readonly valid: boolean;
    readonly plan?: SemanticIssueRelationMutationPlan;
    readonly diagnostics: readonly SemanticIssueRelationDiagnostic[];
}
export declare class SemanticIssueRelationError extends Error {
    readonly diagnostics: readonly SemanticIssueRelationDiagnostic[];
    constructor(diagnostics: readonly SemanticIssueRelationDiagnostic[]);
}
/** Validate a bounded relationship graph before any provider effect. */
export declare function validateIssueRelationshipGraph(input: unknown): SemanticIssueRelationGraphResult;
/**
 * Compute a deterministic native relationship delta.  `initiallyEmpty` is
 * intended only for a just-created Issue whose provider state cannot yet be
 * observed; update/reconciliation callers must supply authoritative evidence.
 */
export declare function tryPlanSemanticIssueRelations(input: unknown): SemanticIssueRelationMutationPlanResult;
export declare function planSemanticIssueRelations(input: unknown): SemanticIssueRelationMutationPlan;
export declare const tryPlanSemanticIssueRelationMutation: typeof tryPlanSemanticIssueRelations;
export declare const planSemanticIssueRelationMutation: typeof planSemanticIssueRelations;
export declare const createSemanticIssueRelationMutationPlan: typeof planSemanticIssueRelations;
/** Validate a transported native relationship plan without provider I/O. */
export declare function validateSemanticIssueRelationMutationPlan(input: unknown): SemanticIssueRelationMutationPlanResult;
export declare function serializeSemanticIssueRelationMutationPlan(input: unknown): string;
export declare function deserializeSemanticIssueRelationMutationPlan(serialized: string): SemanticIssueRelationMutationPlan;
export declare const serializeSemanticIssueRelationPlan: typeof serializeSemanticIssueRelationMutationPlan;
export declare const parseSemanticIssueRelationMutationPlan: typeof deserializeSemanticIssueRelationMutationPlan;
export declare const parseSemanticIssueRelationPlan: typeof deserializeSemanticIssueRelationMutationPlan;
/** Build the compact observed state used by the relation executor. */
export declare function semanticIssueRelationStateFromObserved(observed: ObservedIssueProjection): SemanticIssueRelationObservedState;
/** Compare relation states by stable Issue identity, never by mutable locators. */
export declare function sameSemanticIssueRelationState(left: SemanticIssueRelationState, right: SemanticIssueRelationState): boolean;
export type { DesiredIssueProjection, ObservedIssueProjection };
