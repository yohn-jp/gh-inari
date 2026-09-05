/**
 * Canonical branch naming and classification owned by Inari Core.
 *
 * Repository policy may constrain ordinary pull-request branches. Release
 * branches have a separate, deterministic semver class. Neither class is an
 * authorization or security boundary.
 */
import type { EffectivePullRequestBranchGovernance, PullRequestBranchGovernance } from "./contract/ir.js";
export declare const DEFAULT_BRANCH_PATTERN: "^(feat|fix|docs|refactor|test|chore)/\\d+-[a-z0-9-]+$";
export declare const DEFAULT_RELEASE_BRANCH_PATTERN: "^release/(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$";
export declare const DEFAULT_BRANCH_EXEMPTIONS: readonly ["main"];
export declare const MAX_BRANCH_NAME_LENGTH: 255;
export declare const DEFAULT_BRANCH_GOVERNANCE: EffectivePullRequestBranchGovernance;
export type BranchClassification = "unclassified" | "ordinary" | "release" | "exempt" | "invalid-release" | "invalid";
export type BranchGovernanceViolationCode = "BRANCH_NAME_MISSING" | "BRANCH_NAME_INVALID" | "BRANCH_NAME_TOO_LONG" | "BRANCH_POLICY_INVALID" | "BRANCH_PATTERN_MISMATCH" | "BRANCH_RELEASE_INVALID";
export interface BranchGovernanceViolation {
    readonly code: BranchGovernanceViolationCode;
    readonly path: "$.head" | "$.branch";
    readonly message: string;
}
export interface BranchClassificationResult {
    readonly valid: boolean;
    readonly classification: BranchClassification;
    readonly version?: string;
    readonly violations: readonly BranchGovernanceViolation[];
}
/** Add effective defaults to a repository-declared branch policy. */
export declare function effectiveBranchGovernance(input: PullRequestBranchGovernance): EffectivePullRequestBranchGovernance;
/** Parse the ordinary Change branch identity without assigning governance meaning. */
export declare function parseCanonicalChangeBranchName(branch: string): {
    readonly type: string;
    readonly issueNumber: number;
    readonly slug: string;
} | undefined;
/** Derive the canonical ordinary branch projection for a Change. */
export declare function deriveBranchName(input: {
    readonly type: string;
    readonly issueNumber: number;
    readonly slug: string;
}): string;
/**
 * Classify an observed PR head branch against one compiled repository policy.
 * An absent policy intentionally returns a valid unclassified result: the
 * repository has declared no branch-name precondition.
 */
export declare function classifyBranchName(branch: unknown, governance?: PullRequestBranchGovernance): BranchClassificationResult;
/** Compatibility-facing diagnostics for the package's branch helper. */
export declare function validateBranchName(branch: unknown, governance?: PullRequestBranchGovernance): readonly string[];
