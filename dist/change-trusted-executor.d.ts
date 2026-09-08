/**
 * Trusted Change execution orchestration.
 *
 * This module is the executable boundary between the semantic Core contracts,
 * the #216 effect adapter, and the #217 issuer authority. It owns sequencing
 * only. Naming, lifecycle validity, idempotency, compensation, and projection
 * semantics remain delegated to the existing Core authorities.
 */
import { type ChangeDiagnostic, type ChangeProjectionInput, type ChangeProjectionResult } from "./change.js";
import { type InariIssuerAppAuthority, type IssuerRepositoryIdentity, type TrustedExecutionContext } from "./github/issuer-authority.js";
import { type ChangeRemoteExecutionEvidence, type ChangeRemoteExecutionResult, type ChangeRemoteExecutor, type ChangeRemoteMutationRequest, type ChangeRemoteReadRequest } from "./change-executor.js";
export interface ChangeTrustedEvidenceReader {
    /** Returns bounded Core projection input; it never returns a GitHub response. */
    read(request: ChangeRemoteMutationRequest | ChangeRemoteReadRequest): Promise<ChangeProjectionInput>;
    /** Production readers may require the governed root-Issue proof for issuance. */
    readonly requiresGovernedIssueValidation?: boolean;
}
export interface ChangeTrustedExecutorOptions {
    readonly reader: ChangeTrustedEvidenceReader;
    readonly issuerAuthority: Pick<InariIssuerAppAuthority, "applyEffects">;
    readonly execution: TrustedExecutionContext;
    readonly target: IssuerRepositoryIdentity;
}
export type ChangeTrustedExecutorErrorCode = "CHANGE_EXECUTION_READ_FAILED" | "CHANGE_EXECUTION_PRECONDITION_FAILED" | "CHANGE_EXECUTION_EFFECT_FAILED" | "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED" | "CHANGE_EXECUTION_RECOVERY_REQUIRED";
export declare const CHANGE_TRUSTED_EXECUTOR_ERROR_CODES: readonly ["CHANGE_EXECUTION_READ_FAILED", "CHANGE_EXECUTION_PRECONDITION_FAILED", "CHANGE_EXECUTION_EFFECT_FAILED", "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED", "CHANGE_EXECUTION_RECOVERY_REQUIRED"];
export declare function isChangeTrustedExecutorErrorCode(value: unknown): value is ChangeTrustedExecutorErrorCode;
/** Bounded trusted-execution failure; provider/API details are discarded. */
export declare class ChangeTrustedExecutorError extends Error {
    readonly code: ChangeTrustedExecutorErrorCode;
    readonly diagnostics: readonly ChangeDiagnostic[];
    readonly evidence?: ChangeRemoteExecutionEvidence;
    constructor(code: ChangeTrustedExecutorErrorCode, message: string, diagnostics?: readonly ChangeDiagnostic[], evidence?: ChangeRemoteExecutionEvidence);
}
export declare class TrustedChangeExecutor implements ChangeRemoteExecutor {
    #private;
    constructor(options: ChangeTrustedExecutorOptions);
    read(request: ChangeRemoteReadRequest): Promise<ChangeProjectionResult>;
    execute(request: ChangeRemoteMutationRequest): Promise<ChangeRemoteExecutionResult>;
    /**
     * Bind semantic provenance to the authenticated trusted runtime actor.
     * Caller input may corroborate that identity, but can never replace it.
     */
    private bindRequester;
    private executeReady;
    private readReadyInput;
    private applyReadyEffect;
    private verifyReadyProjection;
    private readInput;
    /** Read normalized evidence without projecting it; the Ready actor owns the next projection state. */
    private readRawInput;
    private executeAbort;
    private readAbortInput;
    private applyAbortEffect;
    private executeIssue;
    private validateIssuanceGovernance;
    private readIssuanceInput;
    private applyIssuanceEffect;
}
export declare const GitHubActionsChangeExecutor: typeof TrustedChangeExecutor;
