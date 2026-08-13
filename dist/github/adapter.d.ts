import { type GhTransport } from "./transport.js";
import { type GitHubIssue, type GitHubPullRequest, type RepositoryContext, type RepositoryTree, type ValidatedRenderedIssueArtifact, type ValidatedRenderedPullRequestArtifact } from "./types.js";
/** Bounded gh CLI timeouts by operation class. Real adapter calls always run under one of these. */
export type GhOperationClass = "auth" | "repositoryResolution" | "read" | "mutation";
export declare const DEFAULT_GH_TIMEOUTS_MS: Readonly<Record<GhOperationClass, number>>;
export interface GitHubAdapterOptions {
    /** Working directory used by gh for local repository resolution. */
    readonly cwd?: string;
    /** owner/name, host/owner/name, or a repository URL. */
    readonly repository?: string;
    /** Hostname used with an owner/name override or gh auth status. */
    readonly hostname?: string;
    /** Injectable command transport for tests and alternate local execution. */
    readonly transport?: GhTransport;
    /** Overrides for the default bounded timeout (ms) per gh operation class. */
    readonly timeoutsMs?: Partial<Record<GhOperationClass, number>>;
}
export declare class GitHubAdapter {
    private readonly cwd;
    private readonly repository;
    private readonly hostname;
    private readonly transport;
    private readonly executable;
    private readonly timeoutsMs;
    private availablePromise;
    private contextPromise;
    private readonly authenticatedHostnames;
    private readonly authenticationPromises;
    constructor(options?: GitHubAdapterOptions);
    checkAuthentication(): Promise<void>;
    resolveRepositoryContext(): Promise<RepositoryContext>;
    getRepositoryContext(): Promise<RepositoryContext>;
    /** Read the target repository metadata used to select the trusted governance ref. */
    getRepositoryDefaultBranch(): Promise<string>;
    /** Read the complete Git tree for a trusted repository ref. Truncation is invalid for governance. */
    getRepositoryTree(ref: string): Promise<RepositoryTree>;
    /** Read and decode one blob selected from the trusted repository tree. */
    getRepositoryBlob(sha: string): Promise<string>;
    getIssue(issueNumber: number): Promise<GitHubIssue>;
    readIssue(issueNumber: number): Promise<GitHubIssue>;
    getPullRequest(pullRequestNumber: number): Promise<GitHubPullRequest>;
    readPullRequest(pullRequestNumber: number): Promise<GitHubPullRequest>;
    createIssue(artifact: ValidatedRenderedIssueArtifact): Promise<GitHubIssue>;
    updateIssue(issueNumber: number, artifact: ValidatedRenderedIssueArtifact): Promise<GitHubIssue>;
    createPullRequest(artifact: ValidatedRenderedPullRequestArtifact): Promise<GitHubPullRequest>;
    updatePullRequest(pullRequestNumber: number, artifact: ValidatedRenderedPullRequestArtifact): Promise<GitHubPullRequest>;
    private resolveRepositoryContextOnce;
    private repositoryOverride;
    private repositoryHostOverride;
    private normalizedHostname;
    private ensureGhAvailable;
    private ensureGhAvailableOnce;
    private ensureAuthenticated;
    private ensureAuthenticatedOnce;
    private runApi;
    private runCommand;
    private apiArguments;
}
export declare function assertValidatedRenderedIssueArtifact(artifact: unknown): asserts artifact is ValidatedRenderedIssueArtifact;
export declare function assertValidatedRenderedPullRequestArtifact(artifact: unknown): asserts artifact is ValidatedRenderedPullRequestArtifact;
