import { type CanonicalContract, type ContractProvenance } from "./contract/ir.js";
import { GitHubAdapter, type GitHubIssue, type GitHubPullRequest, type ValidatedRenderedIssueArtifact, type ValidatedRenderedPullRequestArtifact } from "./github/index.js";
import { type TemplateDiscoveryResult, type TemplateSelector } from "./template-discovery.js";
import { type TemplateResolverDependencies } from "./template-resolver.js";
export type GovernedArtifactDomain = "issue" | "pr";
export interface GovernedContractCompileOptions {
    readonly templateResolver?: TemplateResolverDependencies;
}
export type GovernanceErrorCode = "GOVERNANCE_POLICY_OVERRIDE_FORBIDDEN" | "GOVERNANCE_SOURCE_UNAVAILABLE" | "GOVERNANCE_SOURCE_INVALID" | "GOVERNANCE_GENERATION_STALE" | "GOVERNANCE_BRANCH_INVALID";
export interface GovernanceErrorDetails {
    readonly operation?: string;
    readonly repository?: string;
    readonly ref?: string;
    readonly head?: string;
    readonly pattern?: string;
    readonly path?: string;
    readonly reason?: string;
    readonly [key: string]: string | undefined;
}
/** Stable, machine-readable failures for repository governance acquisition. */
export declare class GovernanceError extends Error {
    readonly code: GovernanceErrorCode;
    readonly details: Readonly<GovernanceErrorDetails>;
    constructor(code: GovernanceErrorCode, message: string, details?: GovernanceErrorDetails, options?: ErrorOptions);
    toJSON(): {
        code: GovernanceErrorCode;
        message: string;
        details: Readonly<GovernanceErrorDetails>;
    };
}
/** Arbitrary local policy files are never accepted by governed remote operations. */
export declare function rejectGovernedPolicyOverride(policyPath: string | boolean | undefined): void;
/**
 * Compile governance from a checked-out repository source.
 *
 * This is the local counterpart to compileRepositoryGovernedContract. CLI
 * local schema/validate/render commands and repository workflows both call
 * this function so template, policy, and contract semantics remain owned by
 * the product compiler rather than by handwritten workflow scripts.
 */
export declare function compileLocalGovernedContract(domain: GovernedArtifactDomain, root: string, selector?: string | TemplateSelector, policyPath?: string | boolean, options?: GovernedContractCompileOptions): Promise<CanonicalContract>;
/** Compile every repository-native Issue Form with the shared compiler. */
export declare function compileLocalIssueFormContracts(root: string): Promise<readonly CanonicalContract[]>;
/**
 * Resolve and compile governance from the target repository's default branch.
 * No local repository files are consulted by this path.
 */
export declare function compileRepositoryGovernedContract(adapter: GitHubAdapter, domain: GovernedArtifactDomain, selector?: string | TemplateSelector, options?: GovernedContractCompileOptions): Promise<CanonicalContract>;
/** One repository-native template's compilation outcome: either a usable contract or a bounded diagnostic. */
export type CompiledTemplateOutcome = {
    readonly status: "compiled";
    readonly contract: CanonicalContract;
} | {
    readonly status: "failed";
    readonly path: string;
    readonly message: string;
};
/**
 * Compile every supported native template from the target repository's
 * trusted default-branch governance. Read commands use this candidate set to
 * identify an existing artifact without inventing a second template grammar.
 *
 * A template that fails to compile does not abort its siblings: it is
 * reported as a bounded "failed" outcome so an unrelated malformed template
 * cannot make every existing-artifact read in the repository fail. Callers
 * that need fail-closed behavior for a single selected template should use
 * compileRepositoryGovernedContract instead.
 */
export declare function compileRepositoryGovernedContracts(adapter: GitHubAdapter, domain: GovernedArtifactDomain): Promise<readonly CompiledTemplateOutcome[]>;
/** Discover all authoritative templates without compiling or reading a body. */
export declare function discoverRepositoryTemplates(adapter: GitHubAdapter): Promise<TemplateDiscoveryResult>;
/**
 * Verify, immediately before a governed mutation, that the artifact's
 * repository governance generation is still acceptable.
 *
 * A generation match (`treeSha` equality) is the fast path: nothing under
 * governance changed since compilation. A generation mismatch means the
 * target repository's default branch advanced, but is not itself
 * disqualifying: it is content-equivalent, and therefore still acceptable,
 * only when every governance input the contract was compiled from (its
 * template, its policy if one was used, and its template-resolution config if
 * one was used) is still present with the exact same blob SHA. Any other
 * outcome — a changed or removed governance input, or a newly introduced
 * policy/config — fails closed with a stable GOVERNANCE_GENERATION_STALE
 * error; the caller must recompile and revalidate against the new generation
 * before mutating.
 */
export declare function verifyGovernedMutationFreshness(adapter: GitHubAdapter, provenance: ContractProvenance): Promise<void>;
/**
 * Evidence of whether repository governance was still at the validated
 * generation immediately after a governed mutation's external effect
 * completed. The pre-mutation freshness check cannot close the TOCTOU gap
 * between itself and the GitHub API call it guards, so this reconciles
 * after the fact rather than hiding the remaining uncertainty.
 */
export interface GovernanceReconciliation {
    /** Root tree SHA the mutated artifact's contract was validated against. */
    readonly validatedGeneration: string;
    /** Root tree SHA observed immediately after the mutation completed. */
    readonly currentGeneration: string;
    /** True when currentGeneration is still content-equivalent to validatedGeneration. */
    readonly reconciled: boolean;
    /** Present only when reconciled is false: why the generations diverged. */
    readonly reason?: string;
}
export interface GovernedMutationResult<T> {
    readonly artifact: T;
    readonly governance: GovernanceReconciliation;
}
/** Create an Issue only after verifying its governance generation is still fresh. */
export declare function createGovernedIssue(adapter: GitHubAdapter, artifact: ValidatedRenderedIssueArtifact): Promise<GovernedMutationResult<GitHubIssue>>;
/** Update an Issue only after verifying its governance generation is still fresh. */
export declare function updateGovernedIssue(adapter: GitHubAdapter, issueNumber: number, artifact: ValidatedRenderedIssueArtifact): Promise<GovernedMutationResult<GitHubIssue>>;
/**
 * Create a pull request only after preflighting its actual head branch
 * against repository branch governance and verifying its governance
 * generation is still fresh.
 */
export declare function createGovernedPullRequest(adapter: GitHubAdapter, artifact: ValidatedRenderedPullRequestArtifact): Promise<GovernedMutationResult<GitHubPullRequest>>;
/** Update a pull request only after verifying its governance generation is still fresh. */
export declare function updateGovernedPullRequest(adapter: GitHubAdapter, pullRequestNumber: number, artifact: ValidatedRenderedPullRequestArtifact): Promise<GovernedMutationResult<GitHubPullRequest>>;
