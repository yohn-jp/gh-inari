import { type ChangeProjectionResult } from "../change.js";
import { type ChangeRemoteExecutor, type ChangeRemoteExecutorOptions, type ChangeRemoteExecutionResult, type ChangeRemoteMutationRequest, type ChangeRemoteReadRequest } from "../change-executor.js";
import type { RepositoryContext } from "./types.js";
/** The only workflow and ref selected by the CLI transport. */
export declare const INARI_CHANGE_EXECUTOR_WORKFLOW: "inari-change-executor.yml";
export declare const INARI_CHANGE_EXECUTOR_REF: "refs/heads/main";
export interface GitHubActionsRemoteApi {
    getRepositoryContext(): Promise<RepositoryContext>;
    getAuthenticatedUser(): Promise<string>;
    requestActionsApi(actionsPath: string, method: "GET" | "POST", fields?: Readonly<Record<string, string>>): Promise<unknown>;
    requestRepositoryApi?(repositoryPath: string, method?: "GET"): Promise<{
        readonly status: number;
        readonly body: unknown;
    }>;
    downloadActionsArtifact(artifactId: number): Promise<Uint8Array>;
}
export interface GitHubActionsChangeRemoteExecutorOptions extends ChangeRemoteExecutorOptions {
    /** Injectable repository/auth/API abstraction; the default is the normal gh session. */
    readonly api?: GitHubActionsRemoteApi;
    /** Internal test/dogfood seam; never a public CLI option. */
    readonly requester?: string;
    readonly maxPollAttempts?: number;
    readonly pollIntervalMs?: number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly randomUUID?: () => string;
}
export declare class GitHubActionsChangeRemoteExecutor implements ChangeRemoteExecutor {
    #private;
    constructor(options: GitHubActionsChangeRemoteExecutorOptions);
    execute(request: ChangeRemoteMutationRequest): Promise<ChangeRemoteExecutionResult>;
    read(request: ChangeRemoteReadRequest): Promise<ChangeProjectionResult>;
    private readCanonicalProjection;
    private withRequester;
    private dispatchAndCollect;
    private readRuns;
    private waitForResult;
    private readArtifacts;
}
export declare function createGitHubActionsChangeRemoteExecutor(options: GitHubActionsChangeRemoteExecutorOptions): ChangeRemoteExecutor;
