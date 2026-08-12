import { type ValidatedRenderedIssueArtifact, type ValidatedRenderedPullRequestArtifact } from "./types.js";
/** Internal compiler-to-adapter boundary; intentionally not part of the public exports. */
export declare function createValidatedRenderedIssueArtifact(artifact: Omit<ValidatedRenderedIssueArtifact, "phase">): ValidatedRenderedIssueArtifact;
/** Internal compiler-to-adapter boundary; intentionally not part of the public exports. */
export declare function createValidatedRenderedPullRequestArtifact(artifact: Omit<ValidatedRenderedPullRequestArtifact, "phase">): ValidatedRenderedPullRequestArtifact;
export declare function isTrustedValidatedRenderedArtifact(value: unknown): value is ValidatedRenderedIssueArtifact | ValidatedRenderedPullRequestArtifact;
