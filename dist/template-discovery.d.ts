export type TemplateType = "issue-form" | "issue-markdown" | "pull-request-default" | "pull-request";
export type TemplateKind = "issue" | "pull-request";
export interface TemplateIdentity {
    readonly id: string;
    readonly type: TemplateType;
    readonly kind: TemplateKind;
    readonly name: string;
    readonly path: string;
}
export interface TemplateDiscoveryResult {
    readonly repositoryRoot: string;
    readonly templates: readonly TemplateIdentity[];
    readonly issueTemplates: readonly TemplateIdentity[];
    readonly pullRequestTemplates: readonly TemplateIdentity[];
}
export interface TemplateSelector {
    readonly id?: string;
    readonly type?: TemplateType;
    readonly kind?: TemplateKind;
    readonly name?: string;
    readonly path?: string;
}
export type TemplateDiscoveryErrorCode = "TEMPLATE_FILESYSTEM_MALFORMED" | "TEMPLATE_ID_CONFLICT" | "TEMPLATE_NOT_FOUND" | "TEMPLATE_SELECTION_AMBIGUOUS" | "TEMPLATE_NAME_CONFLICT" | "INVALID_TEMPLATE_SELECTOR";
export interface TemplateDiscoveryErrorDetails {
    readonly path?: string;
    readonly reason?: string;
    readonly selector?: string | TemplateSelector;
    readonly candidates?: readonly TemplateIdentity[];
}
export declare class TemplateDiscoveryError extends Error {
    readonly code: TemplateDiscoveryErrorCode;
    readonly details: TemplateDiscoveryErrorDetails;
    constructor(code: TemplateDiscoveryErrorCode, message: string, details?: TemplateDiscoveryErrorDetails, options?: ErrorOptions);
    toJSON(): {
        code: TemplateDiscoveryErrorCode;
        message: string;
        details: TemplateDiscoveryErrorDetails;
    };
}
export declare class TemplateFilesystemError extends TemplateDiscoveryError {
    constructor(message: string, details?: TemplateDiscoveryErrorDetails, cause?: unknown);
}
export declare class TemplateNotFoundError extends TemplateDiscoveryError {
    constructor(selector: string | TemplateSelector | undefined, candidates: readonly TemplateIdentity[]);
}
export declare class TemplateSelectionAmbiguousError extends TemplateDiscoveryError {
    constructor(selector: string | TemplateSelector | undefined, candidates: readonly TemplateIdentity[]);
}
export declare class TemplateNameConflictError extends TemplateDiscoveryError {
    constructor(selector: string | TemplateSelector, candidates: readonly TemplateIdentity[]);
}
export declare class InvalidTemplateSelectorError extends TemplateDiscoveryError {
    constructor(selector: unknown);
}
/**
 * Discover the repository-native paths supported by the v1 compiler.
 * Template contents are intentionally not read; parsing belongs to later layers.
 */
export declare function discoverTemplates(repositoryRoot?: string | URL): Promise<TemplateDiscoveryResult>;
/** Synchronous counterpart for callers that already operate synchronously. */
export declare function discoverTemplatesSync(repositoryRoot?: string | URL): TemplateDiscoveryResult;
/**
 * Apply the same repository-native path semantics to a local filesystem or a
 * trusted remote Git tree. Contents and filesystem shape are validated by
 * the caller; this function owns only path classification and identity.
 */
export declare function discoverTemplatesFromPaths(templatePaths: readonly string[], repositoryRoot?: string): TemplateDiscoveryResult;
/** Classify one supported repository-native template path. */
export declare function classifyTemplatePath(templatePath: string): TemplateType | undefined;
/** Whether a path is one of the native template container directories. */
export declare function isTemplateContainerPath(templatePath: string): boolean;
/** Whether a path is inside a native template directory. */
export declare function isTemplatePathInNativeDirectory(templatePath: string): boolean;
/**
 * Select one identity. A string first means an exact ID or path, then a name;
 * name selection is case-insensitive and fails closed when it is not unique.
 */
export declare function selectTemplate(discovery: TemplateDiscoveryResult, selector?: string | TemplateSelector): TemplateIdentity;
export declare function selectIssueTemplate(discovery: TemplateDiscoveryResult, selector?: string | TemplateSelector): TemplateIdentity;
export declare function selectPullRequestTemplate(discovery: TemplateDiscoveryResult, selector?: string | TemplateSelector): TemplateIdentity;
