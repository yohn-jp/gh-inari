import { type ChangeDiagnostic, type ChangeProjectionResult } from "./change.js";
/** Version of the transport-neutral semantic request boundary. */
export declare const CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION: 1;
export declare const CHANGE_REMOTE_MUTATIONS: readonly ["issue", "ready", "abort"];
export type ChangeRemoteMutation = (typeof CHANGE_REMOTE_MUTATIONS)[number];
export interface ChangeRemoteExecutorOptions {
    /** Repository-local working directory used by an executor implementation. */
    readonly cwd: string;
    /** Optional repository locator selected by the caller's normal CLI option. */
    readonly repository?: string;
}
interface ChangeRemoteRequestBase {
    readonly version: typeof CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION;
    readonly issue: number;
}
export interface ChangeRemoteMutationRequest extends ChangeRemoteRequestBase {
    readonly operation: ChangeRemoteMutation;
}
export interface ChangeRemoteReadRequest extends ChangeRemoteRequestBase {
    readonly operation: "show";
}
/**
 * The CLI talks to this semantic boundary only. Implementations may use an
 * Action, service, App event handler, or another transport; none of those
 * details are part of the request or result contract.
 */
export interface ChangeRemoteExecutor {
    execute(request: ChangeRemoteMutationRequest): Promise<ChangeProjectionResult>;
    read(request: ChangeRemoteReadRequest): Promise<ChangeProjectionResult>;
}
/** Compatibility aliases for library callers naming the same boundary. */
export type RemoteChangeExecutor = ChangeRemoteExecutor;
export type ChangeExecutor = ChangeRemoteExecutor;
export type ChangeRemoteExecutorErrorCode = "CHANGE_REMOTE_REQUEST_INVALID" | "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE" | "CHANGE_REMOTE_RESULT_INVALID";
export declare class ChangeRemoteExecutorError extends Error {
    readonly code: ChangeRemoteExecutorErrorCode;
    readonly details?: unknown;
    readonly diagnostics?: readonly ChangeDiagnostic[];
    constructor(code: ChangeRemoteExecutorErrorCode, message: string, details?: unknown, diagnostics?: readonly ChangeDiagnostic[]);
}
export declare function changeRemoteMutationRequest(operation: ChangeRemoteMutation, issue: number): ChangeRemoteMutationRequest;
export declare function changeRemoteReadRequest(issue: number): ChangeRemoteReadRequest;
export declare function executeChangeRemoteMutation(executor: ChangeRemoteExecutor, request: ChangeRemoteMutationRequest): Promise<ChangeProjectionResult>;
export declare function readChangeRemoteProjection(executor: ChangeRemoteExecutor, request: ChangeRemoteReadRequest): Promise<ChangeProjectionResult>;
/** Default until a repository configures a trusted remote executor. */
export declare function createUnavailableChangeRemoteExecutor(): ChangeRemoteExecutor;
export {};
