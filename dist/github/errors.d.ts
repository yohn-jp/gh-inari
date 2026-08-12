export type GitHubAdapterErrorCategory = "environment" | "authentication" | "repository" | "transport" | "timeout" | "api" | "contract";
export type GitHubAdapterErrorCode = "GH_NOT_INSTALLED" | "GH_UNAUTHENTICATED" | "REPOSITORY_RESOLUTION_FAILED" | "INVALID_REPOSITORY_OVERRIDE" | "GITHUB_TRANSPORT_FAILED" | "GITHUB_TIMEOUT" | "GITHUB_API_FAILED" | "GITHUB_API_RESPONSE_INVALID" | "CONTRACT_VIOLATION";
export interface GitHubAdapterErrorDetails {
    readonly operation?: string;
    readonly path?: string;
    readonly executable?: string;
    readonly hostname?: string;
    readonly exitCode?: number;
    readonly stderr?: string;
    readonly response?: string;
    readonly timeoutMs?: number;
    readonly [key: string]: string | number | undefined;
}
export declare class GitHubAdapterError extends Error {
    readonly category: GitHubAdapterErrorCategory;
    readonly code: GitHubAdapterErrorCode;
    readonly details: Readonly<GitHubAdapterErrorDetails>;
    constructor(category: GitHubAdapterErrorCategory, code: GitHubAdapterErrorCode, message: string, details?: GitHubAdapterErrorDetails, options?: ErrorOptions);
}
export declare class GhNotInstalledError extends GitHubAdapterError {
    constructor(executable?: string, cause?: unknown);
}
export declare class GhUnauthenticatedError extends GitHubAdapterError {
    constructor(hostname: string | undefined, stderr?: string, cause?: unknown);
}
export declare class RepositoryResolutionError extends GitHubAdapterError {
    constructor(message: string, details?: GitHubAdapterErrorDetails, cause?: unknown);
}
export declare class InvalidRepositoryOverrideError extends GitHubAdapterError {
    constructor(repository: string, cause?: unknown);
}
export declare class GitHubTransportError extends GitHubAdapterError {
    constructor(operation: string, message: string, details?: GitHubAdapterErrorDetails, cause?: unknown);
}
export declare class GitHubTimeoutError extends GitHubAdapterError {
    constructor(operation: string, timeoutMs: number, cause?: unknown);
}
export declare class GitHubApiError extends GitHubAdapterError {
    constructor(operation: string, message: string, details?: GitHubAdapterErrorDetails, cause?: unknown);
}
export declare class GitHubApiResponseError extends GitHubAdapterError {
    constructor(operation: string, message: string, details?: GitHubAdapterErrorDetails, cause?: unknown);
}
export declare class ContractViolationError extends GitHubAdapterError {
    constructor(message: string, path?: string, cause?: unknown);
}
export declare function isGitHubAdapterError(error: unknown): error is GitHubAdapterError;
