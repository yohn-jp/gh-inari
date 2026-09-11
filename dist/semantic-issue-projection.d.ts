/**
 * Pure Core projection and planning for a materialized Semantic Artifact
 * whose kind is `issue`.
 *
 * The Semantic Artifact is the only semantic authority in this module. In
 * particular, title, metadata, body fields, parent, and dependsOn are read
 * from the artifact and cannot be supplied as projection-time overrides. The
 * module does not know a GitHub transport and never performs a mutation.
 */
import { type IssueReference } from "./contract/issue-reference.js";
import type { ArtifactContractProvenance } from "./contract/ir.js";
import type { SemanticArtifact } from "./contract/semantic-artifact.js";
import type { SemanticIssueRelationEffect } from "./semantic-issue-relations.js";
export declare const SEMANTIC_ISSUE_PROJECTION_VERSION: "1";
export type SemanticIssueProjectionVersion = typeof SEMANTIC_ISSUE_PROJECTION_VERSION;
export declare const SEMANTIC_ISSUE_MUTATION_PLAN_VERSION: "1";
export type SemanticIssueMutationPlanVersion = typeof SEMANTIC_ISSUE_MUTATION_PLAN_VERSION;
/** Capability identifiers understood by the first Issue projection slice. */
export declare const GITHUB_ISSUE_PROJECTION_CAPABILITIES: Readonly<{
    readonly nativeParentRelation: "github.issue.parent.native";
    /** GitHub names the semantic `dependsOn` edge `blocked_by`. */
    readonly nativeBlockedByRelation: "github.issue.blocked-by.native";
    /** Semantic spelling retained alongside the GitHub endpoint spelling. */
    readonly nativeDependsOnRelation: "github.issue.blocked-by.native";
    readonly bodyRelationFallback: "github.issue.relations.body-fallback";
}>;
/** Short alias retained for callers that name the set by its projection role. */
export declare const SEMANTIC_ISSUE_CAPABILITIES: Readonly<{
    readonly nativeParentRelation: "github.issue.parent.native";
    /** GitHub names the semantic `dependsOn` edge `blocked_by`. */
    readonly nativeBlockedByRelation: "github.issue.blocked-by.native";
    /** Semantic spelling retained alongside the GitHub endpoint spelling. */
    readonly nativeDependsOnRelation: "github.issue.blocked-by.native";
    readonly bodyRelationFallback: "github.issue.relations.body-fallback";
}>;
export type GitHubIssueProjectionCapability = (typeof GITHUB_ISSUE_PROJECTION_CAPABILITIES)[keyof typeof GITHUB_ISSUE_PROJECTION_CAPABILITIES];
/**
 * Array capabilities are the transport-neutral form used by Effective
 * Contracts. The object form is a small convenience for Core tests and
 * adapters; it is normalized to the same immutable capability array.
 */
export interface GitHubIssueProjectionCapabilityFlags {
    readonly nativeParentRelation?: boolean;
    readonly nativeDependsOnRelation?: boolean;
    readonly bodyRelationFallback?: boolean;
    /** Compatibility spellings for adapters naming the GitHub endpoint. */
    readonly nativeParent?: boolean;
    readonly nativeDependsOn?: boolean;
    readonly nativeBlockedByRelation?: boolean;
}
export type GitHubIssueProjectionCapabilities = readonly string[] | GitHubIssueProjectionCapabilityFlags;
export interface SemanticIssueProjectionInput {
    readonly artifact: SemanticArtifact;
    readonly capabilities: GitHubIssueProjectionCapabilities;
}
export type SemanticIssueProjectionRepresentation = "none" | "native" | "body-fallback";
export interface DesiredIssueParentRelationProjection {
    readonly relation: "parent";
    /** The semantic parent Issue reference, omitted when no parent is set. */
    readonly reference?: IssueReference;
    /** The strongest declared GitHub representation selected by Core. */
    readonly representation: SemanticIssueProjectionRepresentation;
}
export interface DesiredIssueDependsOnRelationProjection {
    readonly relation: "dependsOn";
    /** Semantic Issue references retained in the desired projection. */
    readonly references: readonly IssueReference[];
    /** The strongest declared GitHub representation selected by Core. */
    readonly representation: SemanticIssueProjectionRepresentation;
}
export type DesiredIssueRelationProjection = DesiredIssueParentRelationProjection | DesiredIssueDependsOnRelationProjection;
export interface DesiredIssueMetadataProjection {
    readonly labels?: readonly string[];
    readonly assignees?: readonly string[];
    readonly milestone?: string;
}
export interface DesiredIssueProjection {
    readonly version: SemanticIssueProjectionVersion;
    readonly kind: "issue";
    readonly title: string;
    readonly body: string;
    readonly metadata: DesiredIssueMetadataProjection;
    readonly relations: Readonly<{
        readonly parent: DesiredIssueParentRelationProjection;
        readonly dependsOn: DesiredIssueDependsOnRelationProjection;
    }>;
    readonly provenance: ArtifactContractProvenance;
    readonly generation: ArtifactContractProvenance;
}
export type SemanticIssuePrecondition = {
    readonly kind: "GOVERNANCE_GENERATION_MATCH";
    readonly generation: ArtifactContractProvenance;
};
export type SemanticIssueEffect = {
    readonly kind: "CREATE_ISSUE";
    readonly desired: DesiredIssueProjection;
} | SemanticIssueRelationEffect;
export interface SemanticIssueArtifactIdentity {
    readonly version: SemanticArtifact["version"];
    readonly effectiveContractVersion: SemanticArtifact["effectiveContractVersion"];
    readonly artifactContractVersion: SemanticArtifact["artifactContractVersion"];
    readonly kind: "issue";
    readonly id: string;
    /** SHA-256 of the canonical validated semantic artifact payload. */
    readonly digest: string;
}
export interface SemanticIssueMutationPlan {
    readonly version: SemanticIssueMutationPlanVersion;
    readonly kind: "issue";
    readonly artifact: SemanticIssueArtifactIdentity;
    /** Immutable governance identity used to produce and admit the plan. */
    readonly provenance: ArtifactContractProvenance;
    readonly generation: ArtifactContractProvenance;
    readonly capabilities: readonly string[];
    readonly desired: DesiredIssueProjection;
    readonly preconditions: readonly SemanticIssuePrecondition[];
    readonly effects: readonly SemanticIssueEffect[];
}
export type SemanticIssueProjectionViolationCode = "PROJECTION_INPUT_INVALID" | "PROJECTION_INPUT_UNKNOWN_PROPERTY" | "SEMANTIC_ARTIFACT_INVALID" | "SEMANTIC_ARTIFACT_INCOMPATIBLE" | "SEMANTIC_ARTIFACT_PROVENANCE_INVALID" | "SEMANTIC_ARTIFACT_VALUE_INVALID" | "CAPABILITIES_INVALID" | "RELATION_UNREPRESENTABLE" | "PROJECTION_BODY_INVALID" | "MUTATION_PLAN_INVALID";
export interface SemanticIssueProjectionViolation {
    readonly code: SemanticIssueProjectionViolationCode;
    readonly path: string;
    readonly message: string;
}
export interface SemanticIssueProjectionResult {
    readonly valid: boolean;
    readonly projection?: DesiredIssueProjection;
    readonly violations: readonly SemanticIssueProjectionViolation[];
}
export interface SemanticIssueMutationPlanResult {
    readonly valid: boolean;
    readonly plan?: SemanticIssueMutationPlan;
    readonly violations: readonly SemanticIssueProjectionViolation[];
}
export declare class SemanticIssueProjectionError extends Error {
    readonly violations: readonly SemanticIssueProjectionViolation[];
    constructor(violations: readonly SemanticIssueProjectionViolation[]);
}
/** Project an Issue Semantic Artifact. No title/metadata/relation override exists. */
export declare function tryProjectSemanticIssue(input: unknown, capabilities?: unknown): SemanticIssueProjectionResult;
/** Throwing projection entry point for Core callers. */
export declare function projectSemanticIssue(input: unknown, capabilities?: unknown): DesiredIssueProjection;
export declare const projectSemanticIssueArtifact: typeof projectSemanticIssue;
export declare const projectIssueSemanticArtifact: typeof projectSemanticIssue;
/** Produce a declarative, versioned plan; this function has no GitHub I/O. */
export declare function tryPlanSemanticIssue(input: unknown, capabilities?: unknown): SemanticIssueMutationPlanResult;
export declare function planSemanticIssue(input: unknown, capabilities?: unknown): SemanticIssueMutationPlan;
export declare const planSemanticIssueMutation: typeof planSemanticIssue;
export declare const createSemanticIssueMutationPlan: typeof planSemanticIssue;
/** Stable transport representation for the versioned plan. */
export declare function serializeSemanticIssueMutationPlan(input: unknown): string;
/** Validate the bounded shape of a transported plan without executing it. */
export declare function validateSemanticIssueMutationPlan(input: unknown): SemanticIssueMutationPlanResult;
export declare function deserializeSemanticIssueMutationPlan(serialized: string): SemanticIssueMutationPlan;
export declare const serializeSemanticIssuePlan: typeof serializeSemanticIssueMutationPlan;
export declare const parseSemanticIssueMutationPlan: typeof deserializeSemanticIssueMutationPlan;
export * from "./semantic-issue-relations.js";
