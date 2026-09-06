import { type ValidatedRenderedIssueArtifact, type ValidatedRenderedPullRequestArtifact, type ValidatedSemanticPullRequestArtifact, type ValidatedSemanticIssueArtifact } from "./types.js";
/** Internal compiler-to-adapter boundary; intentionally not part of the public exports. */
export declare function createValidatedRenderedIssueArtifact(artifact: Omit<ValidatedRenderedIssueArtifact, "phase">): ValidatedRenderedIssueArtifact;
/** Internal compiler-to-adapter boundary; intentionally not part of the public exports. */
export declare function createValidatedRenderedPullRequestArtifact(artifact: Omit<ValidatedRenderedPullRequestArtifact, "phase">): ValidatedRenderedPullRequestArtifact;
export declare function isTrustedValidatedRenderedArtifact(value: unknown): value is ValidatedRenderedIssueArtifact | ValidatedRenderedPullRequestArtifact;
/** Internal Core-to-adapter boundary for v2 Semantic PR projections. */
export declare function createValidatedSemanticPullRequestArtifact(artifact: Omit<ValidatedSemanticPullRequestArtifact, "phase">): ValidatedSemanticPullRequestArtifact;
export declare function isTrustedSemanticPullRequestArtifact(value: unknown): value is ValidatedSemanticPullRequestArtifact;
/** Internal Core-to-adapter boundary for v2 Semantic Issue projections. */
export declare function createValidatedSemanticIssueArtifact(artifact: Omit<ValidatedSemanticIssueArtifact, "phase">): ValidatedSemanticIssueArtifact;
export declare function isTrustedSemanticIssueArtifact(value: unknown): value is ValidatedSemanticIssueArtifact;
