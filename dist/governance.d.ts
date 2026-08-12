import { type CanonicalContract, type ContractProvenance } from "./contract/ir.js";
import { GitHubAdapter, type GitHubIssue, type GitHubPullRequest, type ValidatedRenderedIssueArtifact, type ValidatedRenderedPullRequestArtifact } from "./github/index.js";
import { type TemplateDiscoveryResult, type TemplateSelector } from "./template-discovery.js";
export type GovernedArtifactDomain = "issue" | "pr";
export type GovernanceErrorCode = "GOVERNANCE_POLICY_OVERRIDE_FORBIDDEN" | "GOVERNANCE_SOURCE_UNAVAILABLE" | "GOVERNANCE_SOURCE_INVALID" | "GOVERNANCE_GENERATION_STALE";
export interface GovernanceErrorDetails {
    readonly operation?: string;
    readonly repository?: string;
    readonly ref?: string;
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
export declare function compileLocalGovernedContract(domain: GovernedArtifactDomain, root: string, selector?: string | TemplateSelector, policyPath?: string | boolean): Promise<CanonicalContract>;
/** Compile every repository-native Issue Form with the shared compiler. */
export declare function compileLocalIssueFormContracts(root: string): Promise<readonly CanonicalContract[]>;
/**
 * Resolve and compile governance from the target repository's default branch.
 * No local repository files are consulted by this path.
 */
export declare function compileRepositoryGovernedContract(adapter: GitHubAdapter, domain: GovernedArtifactDomain, selector?: string | TemplateSelector): Promise<CanonicalContract>;
/**
 * Compile every supported native template from the target repository's
 * trusted default-branch governance. Read commands use this candidate set to
 * identify an existing artifact without inventing a second template grammar.
 */
export declare function compileRepositoryGovernedContracts(adapter: GitHubAdapter, domain: GovernedArtifactDomain): Promise<readonly CanonicalContract[]>;
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
 * template, and its policy if one was used) is still present with the exact
 * same blob SHA. Any other outcome — a changed or removed template, a
 * changed, removed, or newly introduced policy — fails closed with a stable
 * GOVERNANCE_GENERATION_STALE error; the caller must recompile and
 * revalidate against the new generation before mutating.
 */
export declare function verifyGovernedMutationFreshness(adapter: GitHubAdapter, provenance: ContractProvenance): Promise<void>;
/** Create an Issue only after verifying its governance generation is still fresh. */
export declare function createGovernedIssue(adapter: GitHubAdapter, artifact: ValidatedRenderedIssueArtifact): Promise<GitHubIssue>;
/** Update an Issue only after verifying its governance generation is still fresh. */
export declare function updateGovernedIssue(adapter: GitHubAdapter, issueNumber: number, artifact: ValidatedRenderedIssueArtifact): Promise<GitHubIssue>;
/** Create a pull request only after verifying its governance generation is still fresh. */
export declare function createGovernedPullRequest(adapter: GitHubAdapter, artifact: ValidatedRenderedPullRequestArtifact): Promise<GitHubPullRequest>;
/** Update a pull request only after verifying its governance generation is still fresh. */
export declare function updateGovernedPullRequest(adapter: GitHubAdapter, pullRequestNumber: number, artifact: ValidatedRenderedPullRequestArtifact): Promise<GitHubPullRequest>;
