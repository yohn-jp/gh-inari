/**
 * Pure Core projection and planning for a materialized Semantic Artifact
 * whose kind is `branch`.
 *
 * Branch identity and source are already materialized by Core.  This module
 * only validates the transport boundary and projects those values into a
 * desired Git ref plus a declarative mutation plan.  It never derives a
 * branch name from type, Issue, or slug and it never performs GitHub I/O.
 */
import type { ArtifactContractProvenance } from "./contract/ir.js";
import type { SemanticArtifact } from "./contract/semantic-artifact.js";
export declare const SEMANTIC_BRANCH_PROJECTION_VERSION: "1";
export type SemanticBranchProjectionVersion = typeof SEMANTIC_BRANCH_PROJECTION_VERSION;
export declare const SEMANTIC_BRANCH_MUTATION_PLAN_VERSION: "1";
export type SemanticBranchMutationPlanVersion = typeof SEMANTIC_BRANCH_MUTATION_PLAN_VERSION;
/** Input to the representation-independent Branch projector. */
export interface SemanticBranchProjectionInput {
    readonly artifact: SemanticArtifact;
}
/** Desired Git ref state projected from one validated Branch Semantic Artifact. */
export interface DesiredBranchProjection {
    readonly version: SemanticBranchProjectionVersion;
    readonly kind: "branch";
    /** The desired branch Git ref name, sourced from `artifact.values.name`. */
    readonly name: string;
    /** The desired source/base Git ref, sourced from `artifact.values.source`. */
    readonly source: string;
    readonly provenance: ArtifactContractProvenance;
    readonly generation: ArtifactContractProvenance;
}
export type SemanticBranchPrecondition = {
    readonly kind: "GOVERNANCE_GENERATION_MATCH";
    readonly generation: ArtifactContractProvenance;
} | {
    readonly kind: "BRANCH_TARGET_ABSENT";
    readonly name: string;
};
export type SemanticBranchEffect = {
    readonly kind: "CREATE_BRANCH";
    readonly desired: DesiredBranchProjection;
};
export interface SemanticBranchArtifactIdentity {
    readonly version: SemanticArtifact["version"];
    readonly effectiveContractVersion: SemanticArtifact["effectiveContractVersion"];
    readonly artifactContractVersion: SemanticArtifact["artifactContractVersion"];
    readonly kind: "branch";
    readonly id: string;
    /** SHA-256 of the canonical validated semantic artifact payload. */
    readonly digest: string;
}
/** Versioned, transport-independent desired Branch mutation plan. */
export interface SemanticBranchMutationPlan {
    readonly version: SemanticBranchMutationPlanVersion;
    readonly kind: "branch";
    readonly artifact: SemanticBranchArtifactIdentity;
    /** Immutable governance identity used to produce and admit the plan. */
    readonly provenance: ArtifactContractProvenance;
    readonly generation: ArtifactContractProvenance;
    readonly desired: DesiredBranchProjection;
    readonly preconditions: readonly SemanticBranchPrecondition[];
    readonly effects: readonly SemanticBranchEffect[];
}
export type SemanticBranchProjectionViolationCode = "PROJECTION_INPUT_INVALID" | "PROJECTION_INPUT_UNKNOWN_PROPERTY" | "SEMANTIC_ARTIFACT_INVALID" | "SEMANTIC_ARTIFACT_INCOMPATIBLE" | "SEMANTIC_ARTIFACT_PROVENANCE_INVALID" | "SEMANTIC_ARTIFACT_VALUE_INVALID" | "MUTATION_PLAN_INVALID";
export interface SemanticBranchProjectionViolation {
    readonly code: SemanticBranchProjectionViolationCode;
    readonly path: string;
    readonly message: string;
}
export interface SemanticBranchProjectionResult {
    readonly valid: boolean;
    readonly projection?: DesiredBranchProjection;
    readonly violations: readonly SemanticBranchProjectionViolation[];
}
export interface SemanticBranchMutationPlanResult {
    readonly valid: boolean;
    readonly plan?: SemanticBranchMutationPlan;
    readonly violations: readonly SemanticBranchProjectionViolation[];
}
export declare class SemanticBranchProjectionError extends Error {
    readonly violations: readonly SemanticBranchProjectionViolation[];
    constructor(violations: readonly SemanticBranchProjectionViolation[]);
}
/** Project a Branch Semantic Artifact without performing GitHub mutation. */
export declare function tryProjectSemanticBranch(input: unknown): SemanticBranchProjectionResult;
/** Throwing projection entry point for Core callers. */
export declare function projectSemanticBranch(input: unknown): DesiredBranchProjection;
export declare const projectSemanticBranchArtifact: typeof projectSemanticBranch;
export declare const projectBranchSemanticArtifact: typeof projectSemanticBranch;
/** Produce a declarative, versioned plan; this function has no GitHub I/O. */
export declare function tryPlanSemanticBranch(input: unknown): SemanticBranchMutationPlanResult;
export declare function planSemanticBranch(input: unknown): SemanticBranchMutationPlan;
export declare const planSemanticBranchMutation: typeof planSemanticBranch;
export declare const createSemanticBranchMutationPlan: typeof planSemanticBranch;
/** Validate a transported Branch mutation plan without executing it. */
export declare function validateSemanticBranchMutationPlan(input: unknown): SemanticBranchMutationPlanResult;
export declare function deserializeSemanticBranchMutationPlan(serialized: string): SemanticBranchMutationPlan;
/** Stable transport representation for the versioned plan. */
export declare function serializeSemanticBranchMutationPlan(input: unknown): string;
export declare const serializeSemanticBranchPlan: typeof serializeSemanticBranchMutationPlan;
export declare const parseSemanticBranchMutationPlan: typeof deserializeSemanticBranchMutationPlan;
export declare const parseSemanticBranchPlan: typeof deserializeSemanticBranchMutationPlan;
export type DesiredSemanticBranchProjection = DesiredBranchProjection;
export type SemanticBranchPlan = SemanticBranchMutationPlan;
