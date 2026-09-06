/**
 * Bounded compatibility ingress for the v1 artifact APIs.
 *
 * The v1 candidate/document shape is retained for migration, but it is not a
 * semantic authority. This module translates only explicit, typed values into
 * the Core Effective Artifact Contract input shape. Native title/branch rules
 * and the dependency sidecar remain projection/evidence data at this
 * boundary; they never override a Semantic Artifact.
 */
import type { ArtifactCandidate, ArtifactInputDocument, ArtifactInputMetadata } from "./artifact.js";
import { type ArtifactContract } from "./contract/index.js";
import { type IssueDependencies, type IssueReference } from "./contract/issue-reference.js";
import type { CanonicalContract } from "./contract/ir.js";
import { type EffectiveArtifactContract } from "./contract/effective-artifact-contract.js";
import { type SemanticArtifact, type SemanticArtifactMaterializationViolation } from "./contract/semantic-artifact.js";
export declare const LEGACY_ARTIFACT_CONVERGENCE_VERSION: "1";
export declare const MAX_LEGACY_CONVERGENCE_DIAGNOSTICS: 32;
export type LegacyArtifactCompatibilitySource = "candidate" | "document";
export type LegacyArtifactConvergenceCode = "LEGACY_INPUT_INVALID" | "LEGACY_PROVENANCE_MISSING" | "LEGACY_UNKNOWN_METADATA" | "LEGACY_RELATION_UNSUPPORTED" | "LEGACY_RELATION_INVALID" | "LEGACY_SEMANTIC_CONFLICT" | "LEGACY_LINKED_ISSUE_INVALID" | "LEGACY_LINKED_ISSUE_UNRESOLVED" | "LEGACY_TITLE_INVALID" | "LEGACY_BRANCH_INVALID" | "LEGACY_CONTRACT_UNSUPPORTED";
export interface LegacyArtifactConvergenceDiagnostic {
    readonly code: LegacyArtifactConvergenceCode;
    readonly path: string;
    readonly message: string;
}
export interface LegacyArtifactConvergenceResult {
    readonly version: typeof LEGACY_ARTIFACT_CONVERGENCE_VERSION;
    readonly valid: boolean;
    /** Core-owned caller input, suitable for `tryMaterializeSemanticArtifact`. */
    readonly semanticInput?: Readonly<Record<string, unknown>>;
    /** Old metadata/sidecar retained only for a compatibility projection. */
    readonly compatibility?: Readonly<{
        readonly metadata: ArtifactInputMetadata;
        readonly dependencies?: IssueDependencies;
        readonly source: LegacyArtifactCompatibilitySource;
    }>;
    readonly diagnostics: readonly LegacyArtifactConvergenceDiagnostic[];
}
export interface LegacyLinkedIssueRepository {
    readonly repositoryHost: string;
    readonly repositoryId: string;
    readonly repository?: string;
}
export interface LegacyArtifactConvergenceOptions {
    /** Repository identity required to turn an explicit local `#N` into an IssueReference. */
    readonly linkedIssueRepository?: LegacyLinkedIssueRepository;
    /** Explicit typed linkage supplied by an adapter that already resolved identity. */
    readonly linkedIssueReferences?: readonly IssueReference[];
    /** Keep old title-prefix validation at the compatibility boundary. */
    readonly nativeTitlePrefix?: string;
    /** Keep old branch validation at the compatibility boundary. */
    readonly branch?: string;
}
export interface LegacySemanticArtifactMaterializationResult {
    readonly valid: boolean;
    readonly artifact?: SemanticArtifact;
    readonly effectiveContract?: EffectiveArtifactContract;
    readonly diagnostics: readonly (LegacyArtifactConvergenceDiagnostic | SemanticArtifactMaterializationViolation)[];
    readonly compatibility?: LegacyArtifactConvergenceResult["compatibility"];
}
/** Translate a legacy candidate/document into Core input without materializing it. */
export declare function convergeLegacyArtifactInput(effectiveContract: EffectiveArtifactContract, input: ArtifactCandidate | ArtifactInputDocument, options?: LegacyArtifactConvergenceOptions): LegacyArtifactConvergenceResult;
/** Alias emphasizing the old candidate boundary. */
export declare const mapLegacyArtifactCandidate: typeof convergeLegacyArtifactInput;
/**
 * Build a temporary v2 contract for a v1 native-template CanonicalContract.
 * This is a compatibility compiler only; it does not make native metadata or
 * native relation encodings semantic authority.
 */
export declare function artifactContractFromLegacyCanonical(contract: CanonicalContract): ArtifactContract;
/** Compile the compatibility contract using the old contract's trusted generation. */
export declare function compileLegacyEffectiveArtifactContract(contract: CanonicalContract): EffectiveArtifactContract;
/** Materialize a legacy candidate/document through the v2 Core boundary. */
export declare function tryMaterializeLegacyArtifact(contract: CanonicalContract | EffectiveArtifactContract, input: ArtifactCandidate | ArtifactInputDocument, options?: LegacyArtifactConvergenceOptions): LegacySemanticArtifactMaterializationResult;
/** Strict counterpart for callers that already use exception-based Core APIs. */
export declare function materializeLegacyArtifact(contract: CanonicalContract | EffectiveArtifactContract, input: ArtifactCandidate | ArtifactInputDocument, options?: LegacyArtifactConvergenceOptions): SemanticArtifact;
/** Validate a legacy branch projection without deriving or rewriting it. */
export declare function validateLegacyBranchProjection(branch: string): LegacyArtifactConvergenceResult;
