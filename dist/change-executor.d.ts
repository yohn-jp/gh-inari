import { type ChangeDiagnostic, type ChangeEffectKind, type ChangeProjectionResult } from "./change.js";
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
    /** Opaque requester provenance; never a credential. */
    readonly requester?: string;
}
export interface ChangeRemoteMutationRequest extends ChangeRemoteRequestBase {
    readonly operation: ChangeRemoteMutation;
}
export interface ChangeRemoteReadRequest extends ChangeRemoteRequestBase {
    readonly operation: "show";
}
/** Bounded evidence emitted by a trusted executor, never a raw API result. */
export interface ChangeRemoteEffectEvidence {
    readonly kind: ChangeEffectKind;
    readonly status: "succeeded" | "failed";
}
export declare const CHANGE_REMOTE_EXECUTION_OUTCOMES: readonly ["verified", "returned-existing", "compensated", "recovery-required", "failed"];
export type ChangeRemoteExecutionOutcome = (typeof CHANGE_REMOTE_EXECUTION_OUTCOMES)[number];
export interface ChangeRemoteExecutionFailureEvidence {
    readonly kind: ChangeEffectKind;
    readonly code: string;
    readonly message: string;
}
export interface ChangeRemoteExecutionEvidence {
    readonly version: typeof CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION;
    readonly operation: ChangeRemoteMutation;
    readonly outcome: ChangeRemoteExecutionOutcome;
    readonly requester?: string;
    readonly issuer?: string;
    readonly effects: readonly ChangeRemoteEffectEvidence[];
    readonly compensation?: "not-required" | "succeeded" | "failed";
    readonly failure?: ChangeRemoteExecutionFailureEvidence;
}
/** Projection plus bounded execution provenance; transport details stay out. */
export interface ChangeRemoteExecutionResult {
    readonly projection: ChangeProjectionResult;
    readonly evidence?: ChangeRemoteExecutionEvidence;
}
/**
 * The CLI talks to this semantic boundary only. Implementations may use an
 * Action, service, App event handler, or another transport; none of those
 * details are part of the request or result contract.
 */
export interface ChangeRemoteExecutor {
    execute(request: ChangeRemoteMutationRequest): Promise<ChangeProjectionResult | ChangeRemoteExecutionResult>;
    read(request: ChangeRemoteReadRequest): Promise<ChangeProjectionResult>;
}
/** Compatibility aliases for library callers naming the same boundary. */
export type RemoteChangeExecutor = ChangeRemoteExecutor;
export type ChangeExecutor = ChangeRemoteExecutor;
export type ChangeRemoteExecutorErrorCode = "CHANGE_REMOTE_REQUEST_INVALID" | "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE" | "CHANGE_REMOTE_TRANSPORT_FAILED" | "CHANGE_REMOTE_DISPATCH_FAILED" | "CHANGE_REMOTE_RUN_FAILED" | "CHANGE_REMOTE_CORRELATION_FAILED" | "CHANGE_REMOTE_RESULT_INVALID";
export declare class ChangeRemoteExecutorError extends Error {
    readonly code: ChangeRemoteExecutorErrorCode;
    readonly details?: unknown;
    readonly diagnostics?: readonly ChangeDiagnostic[];
    constructor(code: ChangeRemoteExecutorErrorCode, message: string, details?: unknown, diagnostics?: readonly ChangeDiagnostic[]);
}
export declare function normalizeChangeRemoteProjection(operation: string, result: unknown): ChangeProjectionResult;
export declare function normalizeChangeRemoteExecutionResult(operation: string, result: unknown): ChangeRemoteExecutionResult;
export declare function changeRemoteMutationRequest(operation: ChangeRemoteMutation, issue: number, requester?: string): ChangeRemoteMutationRequest;
export declare function changeRemoteReadRequest(issue: number, requester?: string): ChangeRemoteReadRequest;
export declare function executeChangeRemoteMutation(executor: ChangeRemoteExecutor, request: ChangeRemoteMutationRequest): Promise<ChangeProjectionResult>;
export declare function executeChangeRemoteMutationResult(executor: ChangeRemoteExecutor, request: ChangeRemoteMutationRequest): Promise<ChangeRemoteExecutionResult>;
export declare function readChangeRemoteProjection(executor: ChangeRemoteExecutor, request: ChangeRemoteReadRequest): Promise<ChangeProjectionResult>;
/** Explicit fallback for a runtime that has no remote executor implementation. */
export declare function createUnavailableChangeRemoteExecutor(): ChangeRemoteExecutor;
export {};
