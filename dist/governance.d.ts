import { type CanonicalContract } from "./contract/ir.js";
import { GitHubAdapter } from "./github/index.js";
import { type TemplateDiscoveryResult, type TemplateSelector } from "./template-discovery.js";
export type GovernedArtifactDomain = "issue" | "pr";
export type GovernanceErrorCode = "GOVERNANCE_POLICY_OVERRIDE_FORBIDDEN" | "GOVERNANCE_SOURCE_UNAVAILABLE" | "GOVERNANCE_SOURCE_INVALID";
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
