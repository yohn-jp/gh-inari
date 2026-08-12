import { type CanonicalContract } from "./contract/ir.js";
import { type TemplateIdentity as DiscoveredTemplateIdentity, type TemplateSelector } from "./template-discovery.js";
export type PullRequestTemplateErrorCode = "PR_TEMPLATE_EMPTY" | "PR_TEMPLATE_UNSUPPORTED_CONSTRUCT" | "PR_TEMPLATE_AMBIGUOUS_STRUCTURE" | "PR_TEMPLATE_NOT_PULL_REQUEST" | "PR_TEMPLATE_READ_FAILED";
export interface PullRequestTemplateErrorDetails {
    readonly path?: string;
    readonly line?: number;
    readonly construct?: string;
    readonly reason?: string;
}
/** A typed failure raised when the supported PR-template subset cannot be represented safely. */
export declare class PullRequestTemplateError extends Error {
    readonly code: PullRequestTemplateErrorCode;
    readonly details: PullRequestTemplateErrorDetails;
    constructor(code: PullRequestTemplateErrorCode, message: string, details?: PullRequestTemplateErrorDetails, options?: ErrorOptions);
    toJSON(): {
        code: PullRequestTemplateErrorCode;
        message: string;
        details: PullRequestTemplateErrorDetails;
    };
}
/**
 * Parse one repository-native PR template into the existing canonical IR.
 *
 * The identity is deliberately the discovery-layer identity. This keeps
 * filesystem discovery and parsing as separate concerns while ensuring the
 * compiled contract cannot be detached from a native template path.
 */
export declare function parsePullRequestTemplate(markdown: string, identity: DiscoveredTemplateIdentity): CanonicalContract;
/** Compile one discovered native PR template from a repository root. */
export declare function compilePullRequestTemplate(repositoryRoot?: string | URL, selector?: string | TemplateSelector): Promise<CanonicalContract>;
/** Synchronous counterpart for callers that already operate synchronously. */
export declare function compilePullRequestTemplateSync(repositoryRoot?: string | URL, selector?: string | TemplateSelector): CanonicalContract;
/** Compile all native PR templates in the discovery layer's stable order. */
export declare function compilePullRequestTemplates(repositoryRoot?: string | URL): Promise<readonly CanonicalContract[]>;
/** Synchronous counterpart of compilePullRequestTemplates. */
export declare function compilePullRequestTemplatesSync(repositoryRoot?: string | URL): readonly CanonicalContract[];
/**
 * Render the structural portion of a validated PR contract as canonical GFM.
 * No placeholder, requirement, or policy is invented when the IR does not
 * contain one.
 */
export declare function renderPullRequestTemplate(input: unknown): string;
