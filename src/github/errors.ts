export type GitHubAdapterErrorCategory =
  "environment" | "authentication" | "repository" | "transport" | "api" | "contract";

export type GitHubAdapterErrorCode =
  | "GH_NOT_INSTALLED"
  | "GH_UNAUTHENTICATED"
  | "REPOSITORY_RESOLUTION_FAILED"
  | "INVALID_REPOSITORY_OVERRIDE"
  | "GITHUB_TRANSPORT_FAILED"
  | "GITHUB_API_FAILED"
  | "GITHUB_API_RESPONSE_INVALID"
  | "CONTRACT_VIOLATION";

export interface GitHubAdapterErrorDetails {
  readonly operation?: string;
  readonly path?: string;
  readonly executable?: string;
  readonly hostname?: string;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly response?: string;
  readonly [key: string]: string | number | undefined;
}

export class GitHubAdapterError extends Error {
  readonly category: GitHubAdapterErrorCategory;
  readonly code: GitHubAdapterErrorCode;
  readonly details: Readonly<GitHubAdapterErrorDetails>;

  constructor(
    category: GitHubAdapterErrorCategory,
    code: GitHubAdapterErrorCode,
    message: string,
    details: GitHubAdapterErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitHubAdapterError";
    this.category = category;
    this.code = code;
    this.details = details;
  }
}

export class GhNotInstalledError extends GitHubAdapterError {
  constructor(executable = "gh", cause?: unknown) {
    super(
      "environment",
      "GH_NOT_INSTALLED",
      `The GitHub CLI executable "${executable}" is not available. Install gh and try again.`,
      { executable },
      { cause },
    );
    this.name = "GhNotInstalledError";
  }
}

export class GhUnauthenticatedError extends GitHubAdapterError {
  constructor(hostname: string | undefined, stderr?: string, cause?: unknown) {
    const hostMessage = hostname === undefined ? "GitHub" : `GitHub host ${hostname}`;
    super(
      "authentication",
      "GH_UNAUTHENTICATED",
      `${hostMessage} is not authenticated through gh. Run gh auth login and try again.`,
      { hostname, stderr },
      { cause },
    );
    this.name = "GhUnauthenticatedError";
  }
}

export class RepositoryResolutionError extends GitHubAdapterError {
  constructor(message: string, details: GitHubAdapterErrorDetails = {}, cause?: unknown) {
    super("repository", "REPOSITORY_RESOLUTION_FAILED", message, details, { cause });
    this.name = "RepositoryResolutionError";
  }
}

export class InvalidRepositoryOverrideError extends GitHubAdapterError {
  constructor(repository: string, cause?: unknown) {
    super(
      "repository",
      "INVALID_REPOSITORY_OVERRIDE",
      `Repository override "${repository}" must be owner/name, host/owner/name, or a GitHub repository URL.`,
      { path: "repository" },
      { cause },
    );
    this.name = "InvalidRepositoryOverrideError";
  }
}

export class GitHubTransportError extends GitHubAdapterError {
  constructor(operation: string, message: string, details: GitHubAdapterErrorDetails = {}, cause?: unknown) {
    super("transport", "GITHUB_TRANSPORT_FAILED", message, { operation, ...details }, { cause });
    this.name = "GitHubTransportError";
  }
}

export class GitHubApiError extends GitHubAdapterError {
  constructor(operation: string, message: string, details: GitHubAdapterErrorDetails = {}, cause?: unknown) {
    super("api", "GITHUB_API_FAILED", message, { operation, ...details }, { cause });
    this.name = "GitHubApiError";
  }
}

export class GitHubApiResponseError extends GitHubAdapterError {
  constructor(operation: string, message: string, details: GitHubAdapterErrorDetails = {}, cause?: unknown) {
    super("api", "GITHUB_API_RESPONSE_INVALID", message, { operation, ...details }, { cause });
    this.name = "GitHubApiResponseError";
  }
}

export class ContractViolationError extends GitHubAdapterError {
  constructor(message: string, path?: string, cause?: unknown) {
    super("contract", "CONTRACT_VIOLATION", message, { path }, { cause });
    this.name = "ContractViolationError";
  }
}

export function isGitHubAdapterError(error: unknown): error is GitHubAdapterError {
  return error instanceof GitHubAdapterError;
}
