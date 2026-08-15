import { type ArtifactInputDocument, type ExistingArtifactDiagnostic, type ExistingArtifactValidationResult } from "./artifact.js";
import { type CanonicalContract } from "./contract/index.js";
import { type GovernedArtifactDomain, type GovernedMutationResult } from "./governance.js";
import { GitHubAdapter, type GitHubIssue, type GitHubPullRequest } from "./github/index.js";
import type { ValidatedRenderedIssueArtifact, ValidatedRenderedPullRequestArtifact } from "./github/types.js";
import type { TemplateSelector } from "./template-discovery.js";
export type RemediationOperation = "check" | "edit" | "normalize" | "sync";
export type RemediationStatus = "valid-current" | "non-canonical" | "semantically-invalid" | "unsupported" | "ambiguous";
export type RemediationErrorCode = "SEMANTIC_PATCH_INVALID" | "SEMANTIC_PATCH_UNSUPPORTED" | "NORMALIZATION_UNSAFE" | "SYNC_INPUT_INCOMPLETE" | "SYNC_CURRENT_UNSUPPORTED" | "PR_HEAD_CHANGE_UNSUPPORTED";
export declare class RemediationError extends Error {
    readonly code: RemediationErrorCode;
    readonly path?: string;
    readonly details?: Readonly<Record<string, unknown>>;
    constructor(code: RemediationErrorCode, message: string, path?: string, details?: Readonly<Record<string, unknown>>);
}
export interface ExistingArtifactRead {
    readonly remote: GitHubIssue | GitHubPullRequest;
    readonly contract?: CanonicalContract;
    readonly result: ExistingArtifactValidationResult;
}
export interface ExistingArtifactAssessment {
    readonly status: RemediationStatus;
    readonly normalizable: boolean;
    readonly canonicalBody?: string;
    readonly diagnostics: readonly ExistingArtifactDiagnostic[];
}
export interface SemanticDiffChange {
    readonly path: string;
    readonly before?: unknown;
    readonly after?: unknown;
}
export interface RenderedDiffSummary {
    readonly changed: boolean;
    readonly before: RenderedValueSummary;
    readonly after: RenderedValueSummary;
}
export interface RenderedValueSummary {
    readonly sha256: string;
    readonly length: number;
    readonly preview: string;
}
export interface SemanticArtifactDiff {
    readonly changed: boolean;
    readonly semantic: readonly SemanticDiffChange[];
    readonly rendered: RenderedDiffSummary;
}
export type PreparedRemediationArtifact = ValidatedRenderedIssueArtifact | ValidatedRenderedPullRequestArtifact;
/** Read and select an existing artifact using the same governed candidate path as `get`. */
export declare function readGovernedExistingArtifact(adapter: GitHubAdapter, domain: GovernedArtifactDomain, number: number, selector?: string | TemplateSelector): Promise<ExistingArtifactRead>;
/** Classify the current artifact and prove whether a canonical body can preserve its semantics. */
export declare function assessExistingArtifact(domain: GovernedArtifactDomain, read: ExistingArtifactRead): ExistingArtifactAssessment;
/** Render through the existing canonical renderer; this is the only representation authority. */
export declare function renderCanonicalBody(domain: GovernedArtifactDomain, contract: CanonicalContract, fields: Readonly<Record<string, unknown>>): string;
/** Build the complete semantic input represented by the current remote artifact. */
export declare function currentArtifactInput(domain: GovernedArtifactDomain, read: ExistingArtifactRead): ArtifactInputDocument;
/** Apply an explicit semantic patch without touching raw Markdown or inferring missing fields. */
export declare function applySemanticPatch(domain: GovernedArtifactDomain, read: ExistingArtifactRead, patch: ArtifactInputDocument): ArtifactInputDocument;
/** Validate and prepare the complete desired state through the existing artifact boundary. */
export declare function prepareRemediationArtifact(domain: GovernedArtifactDomain, contract: CanonicalContract, input: ArtifactInputDocument): PreparedRemediationArtifact;
/** Ensure a declarative sync only names fields in the authoritative contract. */
export declare function prepareSyncInput(domain: GovernedArtifactDomain, read: ExistingArtifactRead, desired: ArtifactInputDocument): ArtifactInputDocument;
/** Compare the current semantic/rendered artifact with a prepared canonical projection. */
export declare function diffArtifact(domain: GovernedArtifactDomain, read: ExistingArtifactRead, desired: PreparedRemediationArtifact): SemanticArtifactDiff;
/** Apply a prepared artifact through the existing freshness and reconciliation boundary. */
export declare function updateGovernedExistingArtifact(adapter: GitHubAdapter, domain: GovernedArtifactDomain, number: number, artifact: PreparedRemediationArtifact): Promise<GovernedMutationResult<GitHubIssue> | GovernedMutationResult<GitHubPullRequest>>;
