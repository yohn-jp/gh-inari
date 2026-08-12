import { type CanonicalContract } from "./ir.js";
import { type TemplateDiscoveryResult, type TemplateIdentity as DiscoveredTemplateIdentity, type TemplateSelector } from "../template-discovery.js";
export type IssueFormCompilerErrorCode = "ISSUE_FORM_INVALID_YAML" | "ISSUE_FORM_DUPLICATE_KEY" | "ISSUE_FORM_INVALID_ROOT" | "ISSUE_FORM_MISSING_PROPERTY" | "ISSUE_FORM_UNKNOWN_PROPERTY" | "ISSUE_FORM_INVALID_VALUE" | "ISSUE_FORM_DUPLICATE_ID" | "ISSUE_FORM_DUPLICATE_VALUE" | "ISSUE_FORM_AMBIGUOUS" | "ISSUE_FORM_UNSUPPORTED_TYPE" | "ISSUE_FORM_UNSUPPORTED_SEMANTICS" | "ISSUE_FORM_SOURCE_ERROR" | "ISSUE_FORM_IR_INVALID";
export interface IssueFormSourceContext {
    readonly templateId: string;
    readonly templatePath: string;
    readonly yamlPath: string;
    readonly line?: number;
    readonly column?: number;
}
export interface IssueFormCompilerViolation {
    readonly code: IssueFormCompilerErrorCode;
    readonly path: string;
    readonly message: string;
    readonly context: IssueFormSourceContext;
}
export declare class IssueFormCompilerError extends Error {
    readonly code: IssueFormCompilerErrorCode;
    readonly path: string;
    readonly context: IssueFormSourceContext;
    readonly violations: readonly IssueFormCompilerViolation[];
    constructor(violations: readonly IssueFormCompilerViolation[], options?: ErrorOptions);
    toJSON(): {
        code: IssueFormCompilerErrorCode;
        message: string;
        path: string;
        context: IssueFormSourceContext;
        violations: readonly IssueFormCompilerViolation[];
    };
}
/** The discovery identity plus optional discriminators accepted by the pure compiler boundary. */
export type IssueFormTemplateIdentity = Pick<DiscoveredTemplateIdentity, "id" | "name" | "path"> & Partial<Pick<DiscoveredTemplateIdentity, "type" | "kind">>;
/** Compile YAML already selected by the repository's template discovery layer. */
export declare function compileIssueFormYaml(source: string, template: IssueFormTemplateIdentity): CanonicalContract;
/** Short alias for callers compiling an in-memory Issue Form source. */
export declare const compileIssueForm: typeof compileIssueFormYaml;
/** Discover, read, select, and compile one repository-native Issue Form. */
export declare function compileIssueFormTemplate(discovery: TemplateDiscoveryResult, selector?: string | TemplateSelector): Promise<CanonicalContract>;
