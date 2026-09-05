import { type ChangeDiagnostic, type ChangeEffect, type ChangeEffectKind, type ChangeIssuanceFailureEvidence } from "../change.js";
/** The repository target is resolved by the trusted caller, not by this adapter. */
export interface GitHubChangeEffectRepository {
    readonly hostname: string;
    readonly owner: string;
    readonly name: string;
}
export type GitHubChangeEffectHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type GitHubChangeEffectJsonValue = string | number | boolean | null | readonly GitHubChangeEffectJsonValue[] | {
    readonly [key: string]: GitHubChangeEffectJsonValue;
};
export type GitHubChangeEffectJsonObject = {
    readonly [key: string]: GitHubChangeEffectJsonValue;
};
/** API request data owned by the GitHub adapter boundary. */
export interface GitHubChangeEffectRequest {
    readonly hostname: string;
    readonly method: GitHubChangeEffectHttpMethod;
    readonly path: string;
    readonly body?: GitHubChangeEffectJsonObject;
}
/** The transport returns an opaque response which is consumed and discarded by the adapter. */
export interface GitHubChangeEffectResponse {
    readonly status: number;
    readonly body?: unknown;
}
/**
 * Explicit execution boundary for a future App, Actions, or service transport.
 * Credentials and transport errors remain owned by the implementation.
 */
export interface GitHubChangeEffectTransport {
    request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse>;
}
export interface GitHubChangeEffectAdapterOptions {
    readonly repository: GitHubChangeEffectRepository;
    readonly transport: GitHubChangeEffectTransport;
}
export declare const GITHUB_CHANGE_EFFECT_FAILURE_CODES: Readonly<{
    readonly CREATE_BRANCH: "BRANCH_CREATE_FAILED";
    readonly CREATE_PULL_REQUEST: "PULL_REQUEST_CREATE_FAILED";
    readonly MARK_PULL_REQUEST_READY: "PULL_REQUEST_READY_FAILED";
    readonly CLOSE_PULL_REQUEST: "PULL_REQUEST_CLOSE_FAILED";
    readonly DELETE_BRANCH: "BRANCH_DELETE_FAILED";
}>;
export type GitHubChangeEffectFailureCode = (typeof GITHUB_CHANGE_EFFECT_FAILURE_CODES)[ChangeEffectKind];
/** Bounded success evidence; GitHub response bodies and URLs are intentionally absent. */
export type GitHubChangeEffectSuccessEvidence = {
    readonly kind: "CREATE_BRANCH";
    readonly branch: string;
    readonly baseBranch: string;
} | {
    readonly kind: "CREATE_PULL_REQUEST";
    readonly branch: string;
    readonly baseBranch: string;
    readonly rootIssue: number;
    readonly pullRequest: number;
} | {
    readonly kind: "MARK_PULL_REQUEST_READY";
    readonly pullRequest: number;
} | {
    readonly kind: "CLOSE_PULL_REQUEST";
    readonly pullRequest: number;
} | {
    readonly kind: "DELETE_BRANCH";
    readonly branch: string;
};
export type GitHubChangeEffectFailureEvidence = ChangeIssuanceFailureEvidence;
export interface GitHubChangeEffectSuccessResult {
    readonly status: "succeeded";
    readonly effect: ChangeEffect;
    readonly evidence: GitHubChangeEffectSuccessEvidence;
}
export interface GitHubChangeEffectFailureResult {
    readonly status: "failed";
    readonly effect: ChangeEffect;
    /** This is directly compatible with Core's compensation/recovery input. */
    readonly failure: GitHubChangeEffectFailureEvidence;
}
export type GitHubChangeEffectResult = GitHubChangeEffectSuccessResult | GitHubChangeEffectFailureResult;
/** Raised before transport execution when the supplied effect is not a Core effect contract value. */
export declare class GitHubChangeEffectContractError extends Error {
    readonly code: "CHANGE_EFFECT_INVALID";
    readonly diagnostics: readonly ChangeDiagnostic[];
    constructor(diagnostics?: readonly ChangeDiagnostic[]);
}
export declare class GitHubChangeEffectConfigurationError extends Error {
    readonly code: "GITHUB_CHANGE_EFFECT_CONFIGURATION_INVALID";
    constructor();
}
/**
 * Thin projection of one explicit Core effect onto GitHub's API resources.
 * It deliberately executes no plan, retry, idempotency, lifecycle, naming, or
 * compensation logic.
 */
export declare class GitHubChangeEffectAdapter {
    private readonly repository;
    private readonly transport;
    constructor(options: GitHubChangeEffectAdapterOptions);
    /** Execute exactly one explicit effect and normalize every execution failure. */
    execute(effect: ChangeEffect): Promise<GitHubChangeEffectResult>;
    private executeExplicitEffect;
    private createBranch;
    private createPullRequest;
    private markPullRequestReady;
    private closePullRequest;
    private deleteBranch;
    private request;
    private repositoryPath;
}
