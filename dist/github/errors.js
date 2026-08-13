export class GitHubAdapterError extends Error {
    category;
    code;
    details;
    constructor(category, code, message, details = {}, options) {
        super(message, options);
        this.name = "GitHubAdapterError";
        this.category = category;
        this.code = code;
        this.details = details;
    }
}
export class GhNotInstalledError extends GitHubAdapterError {
    constructor(executable = "gh", cause) {
        super("environment", "GH_NOT_INSTALLED", `The GitHub CLI executable "${executable}" is not available. Install gh and try again.`, { executable }, { cause });
        this.name = "GhNotInstalledError";
    }
}
export class GhUnauthenticatedError extends GitHubAdapterError {
    constructor(hostname, stderr, cause) {
        const hostMessage = hostname === undefined ? "GitHub" : `GitHub host ${hostname}`;
        super("authentication", "GH_UNAUTHENTICATED", `${hostMessage} is not authenticated through gh. Run gh auth login and try again.`, { hostname, stderr }, { cause });
        this.name = "GhUnauthenticatedError";
    }
}
export class RepositoryResolutionError extends GitHubAdapterError {
    constructor(message, details = {}, cause) {
        super("repository", "REPOSITORY_RESOLUTION_FAILED", message, details, { cause });
        this.name = "RepositoryResolutionError";
    }
}
export class InvalidRepositoryOverrideError extends GitHubAdapterError {
    constructor(repository, cause) {
        super("repository", "INVALID_REPOSITORY_OVERRIDE", `Repository override "${repository}" must be owner/name, host/owner/name, or a GitHub repository URL.`, { path: "repository" }, { cause });
        this.name = "InvalidRepositoryOverrideError";
    }
}
export class GitHubTransportError extends GitHubAdapterError {
    constructor(operation, message, details = {}, cause) {
        super("transport", "GITHUB_TRANSPORT_FAILED", message, { operation, ...details }, { cause });
        this.name = "GitHubTransportError";
    }
}
export class GitHubOutputLimitError extends GitHubAdapterError {
    constructor(operation, stream, limitBytes, outputBytes, cause) {
        super("transport", "GITHUB_OUTPUT_LIMIT_EXCEEDED", `gh ${stream} output exceeded its bounded limit of ${limitBytes} bytes during ${operation}.`, { operation, stream, limitBytes, outputBytes }, { cause });
        this.name = "GitHubOutputLimitError";
    }
}
export class GitHubTimeoutError extends GitHubAdapterError {
    constructor(operation, timeoutMs, cause) {
        super("timeout", "GITHUB_TIMEOUT", `gh did not complete ${operation} within the bounded timeout of ${timeoutMs}ms.`, { operation, timeoutMs }, { cause });
        this.name = "GitHubTimeoutError";
    }
}
export class GitHubApiError extends GitHubAdapterError {
    constructor(operation, message, details = {}, cause) {
        super("api", "GITHUB_API_FAILED", message, { operation, ...details }, { cause });
        this.name = "GitHubApiError";
    }
}
export class GitHubApiResponseError extends GitHubAdapterError {
    constructor(operation, message, details = {}, cause) {
        super("api", "GITHUB_API_RESPONSE_INVALID", message, { operation, ...details }, { cause });
        this.name = "GitHubApiResponseError";
    }
}
/**
 * GitHub's issue resource family can represent pull requests. Raised when a
 * caller addressed the Issue path but the numbered resource is actually a
 * pull request, so it fails closed instead of silently accepting a
 * PR-shaped resource as an Issue artifact.
 */
export class GitHubResourceKindMismatchError extends GitHubAdapterError {
    constructor(operation, issueNumber, cause) {
        super("api", "GITHUB_RESOURCE_KIND_MISMATCH", `Resource #${issueNumber} is a pull request, not an Issue; refusing to treat it as an Issue artifact.`, { operation, path: "pull_request" }, { cause });
        this.name = "GitHubResourceKindMismatchError";
    }
}
export class ContractViolationError extends GitHubAdapterError {
    constructor(message, path, cause) {
        super("contract", "CONTRACT_VIOLATION", message, { path }, { cause });
        this.name = "ContractViolationError";
    }
}
export function isGitHubAdapterError(error) {
    return error instanceof GitHubAdapterError;
}
//# sourceMappingURL=errors.js.map