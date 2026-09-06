/**
 * Pure Core projection and planning for a materialized Semantic Artifact
 * whose kind is `pull_request`.
 *
 * The Semantic Artifact is the only semantic authority in this module.  In
 * particular, title, head, base, metadata, and `implements` are read from
 * the artifact and cannot be supplied as projection-time overrides.  This
 * module does not know a GitHub transport and never performs a mutation.
 */
import { type IssueReference } from "./contract/issue-reference.js";
import type { ArtifactContractProvenance } from "./contract/ir.js";
import type { SemanticArtifact } from "./contract/semantic-artifact.js";
export declare const SEMANTIC_PULL_REQUEST_PROJECTION_VERSION: "1";
export type SemanticPullRequestProjectionVersion = typeof SEMANTIC_PULL_REQUEST_PROJECTION_VERSION;
export declare const SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION: "1";
export type SemanticPullRequestMutationPlanVersion = typeof SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION;
/** Capability identifiers understood by the first PR projection slice. */
export declare const GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES: Readonly<{
    readonly nativeImplementsRelation: "github.pull_request.implements.native";
    readonly recognizedClosingReference: "github.pull_request.implements.closing-reference";
    readonly bodyRelationFallback: "github.pull_request.implements.body-fallback";
}>;
/** Short alias retained for callers that name the set by its projection role. */
export declare const SEMANTIC_PULL_REQUEST_CAPABILITIES: Readonly<{
    readonly nativeImplementsRelation: "github.pull_request.implements.native";
    readonly recognizedClosingReference: "github.pull_request.implements.closing-reference";
    readonly bodyRelationFallback: "github.pull_request.implements.body-fallback";
}>;
export type GitHubPullRequestProjectionCapability = (typeof GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES)[keyof typeof GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES];
/**
 * Array capabilities are the transport-neutral form used by Effective
 * Contracts.  The object form is a small convenience for Core tests and
 * adapters; it is normalized to the same immutable capability array.
 */
export interface GitHubPullRequestProjectionCapabilityFlags {
    readonly nativeImplementsRelation?: boolean;
    readonly recognizedClosingReference?: boolean;
    readonly bodyRelationFallback?: boolean;
}
export type GitHubPullRequestProjectionCapabilities = readonly string[] | GitHubPullRequestProjectionCapabilityFlags;
export interface SemanticPullRequestProjectionInput {
    readonly artifact: SemanticArtifact;
    readonly capabilities: GitHubPullRequestProjectionCapabilities;
}
export type SemanticPullRequestProjectionRepresentation = "none" | "native" | "recognized-convention" | "body-fallback";
export interface DesiredPullRequestRelationProjection {
    readonly relation: "implements";
    /** Semantic Issue references, retained in the desired projection. */
    readonly references: readonly IssueReference[];
    /** The strongest declared GitHub representation selected by Core. */
    readonly representation: SemanticPullRequestProjectionRepresentation;
}
export interface DesiredPullRequestMetadataProjection {
    readonly labels?: readonly string[];
    readonly assignees?: readonly string[];
    readonly milestone?: string;
    readonly reviewers?: readonly string[];
    readonly draft?: boolean;
    readonly maintainerCanModify?: boolean;
}
export interface DesiredPullRequestProjection {
    readonly version: SemanticPullRequestProjectionVersion;
    readonly kind: "pull_request";
    readonly title: string;
    readonly head: string;
    readonly base: string;
    readonly body: string;
    readonly metadata: DesiredPullRequestMetadataProjection;
    readonly relations: Readonly<{
        readonly implements: DesiredPullRequestRelationProjection;
    }>;
    readonly provenance: ArtifactContractProvenance;
    readonly generation: ArtifactContractProvenance;
}
export type SemanticPullRequestPrecondition = {
    readonly kind: "GOVERNANCE_GENERATION_MATCH";
    readonly generation: ArtifactContractProvenance;
} | {
    readonly kind: "PULL_REQUEST_TARGET_ABSENT";
    readonly head: string;
    readonly base: string;
};
export type SemanticPullRequestEffect = {
    readonly kind: "CREATE_PULL_REQUEST";
    readonly desired: DesiredPullRequestProjection;
};
export interface SemanticPullRequestArtifactIdentity {
    readonly version: SemanticArtifact["version"];
    readonly effectiveContractVersion: SemanticArtifact["effectiveContractVersion"];
    readonly artifactContractVersion: SemanticArtifact["artifactContractVersion"];
    readonly kind: "pull_request";
    readonly id: string;
    /** SHA-256 of the canonical validated semantic artifact payload. */
    readonly digest: string;
}
export interface SemanticPullRequestMutationPlan {
    readonly version: SemanticPullRequestMutationPlanVersion;
    readonly kind: "pull_request";
    readonly artifact: SemanticPullRequestArtifactIdentity;
    /** Immutable governance identity used to produce and admit the plan. */
    readonly provenance: ArtifactContractProvenance;
    readonly generation: ArtifactContractProvenance;
    readonly capabilities: readonly string[];
    readonly desired: DesiredPullRequestProjection;
    readonly preconditions: readonly SemanticPullRequestPrecondition[];
    readonly effects: readonly SemanticPullRequestEffect[];
}
export type SemanticPullRequestProjectionViolationCode = "PROJECTION_INPUT_INVALID" | "PROJECTION_INPUT_UNKNOWN_PROPERTY" | "SEMANTIC_ARTIFACT_INVALID" | "SEMANTIC_ARTIFACT_INCOMPATIBLE" | "SEMANTIC_ARTIFACT_PROVENANCE_INVALID" | "SEMANTIC_ARTIFACT_VALUE_INVALID" | "CAPABILITIES_INVALID" | "RELATION_UNREPRESENTABLE" | "PROJECTION_BODY_INVALID" | "MUTATION_PLAN_INVALID";
export interface SemanticPullRequestProjectionViolation {
    readonly code: SemanticPullRequestProjectionViolationCode;
    readonly path: string;
    readonly message: string;
}
export interface SemanticPullRequestProjectionResult {
    readonly valid: boolean;
    readonly projection?: DesiredPullRequestProjection;
    readonly violations: readonly SemanticPullRequestProjectionViolation[];
}
export interface SemanticPullRequestMutationPlanResult {
    readonly valid: boolean;
    readonly plan?: SemanticPullRequestMutationPlan;
    readonly violations: readonly SemanticPullRequestProjectionViolation[];
}
export declare class SemanticPullRequestProjectionError extends Error {
    readonly violations: readonly SemanticPullRequestProjectionViolation[];
    constructor(violations: readonly SemanticPullRequestProjectionViolation[]);
}
/** Project a PR Semantic Artifact. No title/head/base/relation override exists. */
export declare function tryProjectSemanticPullRequest(input: unknown, capabilities?: unknown): SemanticPullRequestProjectionResult;
/** Throwing projection entry point for Core callers. */
export declare function projectSemanticPullRequest(input: unknown, capabilities?: unknown): DesiredPullRequestProjection;
export declare const projectSemanticPullRequestArtifact: typeof projectSemanticPullRequest;
export declare const projectPullRequestSemanticArtifact: typeof projectSemanticPullRequest;
/** Produce a declarative, versioned plan; this function has no GitHub I/O. */
export declare function tryPlanSemanticPullRequest(input: unknown, capabilities?: unknown): SemanticPullRequestMutationPlanResult;
export declare function planSemanticPullRequest(input: unknown, capabilities?: unknown): SemanticPullRequestMutationPlan;
export declare const planSemanticPullRequestMutation: typeof planSemanticPullRequest;
export declare const createSemanticPullRequestMutationPlan: typeof planSemanticPullRequest;
/** Stable transport representation for the versioned plan. */
export declare function serializeSemanticPullRequestMutationPlan(input: unknown): string;
/** Validate the bounded shape of a transported plan without executing it. */
export declare function validateSemanticPullRequestMutationPlan(input: unknown): SemanticPullRequestMutationPlanResult;
export declare function deserializeSemanticPullRequestMutationPlan(serialized: string): SemanticPullRequestMutationPlan;
export declare const serializeSemanticPullRequestPlan: typeof serializeSemanticPullRequestMutationPlan;
export declare const parseSemanticPullRequestMutationPlan: typeof deserializeSemanticPullRequestMutationPlan;
export * from "./semantic-pr-observation.js";
