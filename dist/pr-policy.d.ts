import { type CanonicalContract, type EffectivePullRequestBranchGovernance, type PullRequestBranchGovernance } from "./contract/ir.js";
import type { TemplateIdentity } from "./template-discovery.js";
export declare const PULL_REQUEST_POLICY_VERSION: 1;
export type PullRequestPolicyErrorCode = "PR_POLICY_INVALID_YAML" | "PR_POLICY_INVALID_ROOT" | "PR_POLICY_UNSUPPORTED_VERSION" | "PR_POLICY_UNKNOWN_PROPERTY" | "PR_POLICY_INVALID_VALUE" | "PR_POLICY_TEMPLATE_MISMATCH" | "PR_POLICY_UNKNOWN_REFERENCE" | "PR_POLICY_AMBIGUOUS_REFERENCE" | "PR_POLICY_UNSUPPORTED_CONSTRAINT" | "PR_POLICY_CONFLICT";
export declare class PullRequestPolicyError extends Error {
    readonly code: PullRequestPolicyErrorCode;
    readonly path: string;
    constructor(code: PullRequestPolicyErrorCode, message: string, path?: string);
    toJSON(): {
        code: PullRequestPolicyErrorCode;
        path: string;
        message: string;
    };
}
export interface PullRequestPolicyOverlay {
    readonly version: typeof PULL_REQUEST_POLICY_VERSION;
    readonly template?: string | PullRequestPolicyTemplateSelector;
    readonly sections?: readonly PullRequestPolicySectionRule[];
    readonly templates?: readonly PullRequestPolicyTemplateEntry[];
    /**
     * Repository-declared constraint on the actual pull-request head branch
     * name. Applies regardless of which native PR template is selected, since
     * branch naming is a property of the branch, not the body template.
     */
    readonly branch?: EffectivePullRequestBranchGovernance;
}
export type PullRequestPolicyBranchRule = PullRequestBranchGovernance;
export interface PullRequestPolicyTemplateSelector {
    readonly id?: string;
    readonly path?: string;
    readonly name?: string;
}
export interface PullRequestPolicyTemplateEntry {
    readonly template?: string | PullRequestPolicyTemplateSelector;
    readonly sections: readonly PullRequestPolicySectionRule[];
}
export interface PullRequestPolicyCompileOptions {
    /** All native PR templates available in the authoritative repository. */
    readonly templateIdentities?: readonly Pick<TemplateIdentity, "id" | "path" | "name">[];
}
export interface PullRequestPolicySectionRule {
    readonly fieldId: string;
    readonly required?: boolean;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: string;
    readonly minItems?: number;
    readonly maxItems?: number;
    readonly linkedIssue?: boolean;
    readonly checklistMinCompleted?: number;
    readonly checklistRequireComplete?: boolean;
}
/** Compile a small, data-only PR overlay into the shared canonical contract. */
export declare function compilePullRequestPolicyOverlay(contractInput: unknown, source: string | PullRequestPolicyOverlay, options?: PullRequestPolicyCompileOptions): CanonicalContract;
export declare function parsePullRequestPolicyOverlay(source: string): PullRequestPolicyOverlay;
export declare function compilePullRequestPolicyFile(contract: unknown, filePath: string, options?: PullRequestPolicyCompileOptions): Promise<CanonicalContract>;
