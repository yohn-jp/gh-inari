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
    private executeReady;
    private verifyReadyProjection;
    private readInput;
    private executeIssue;
    private recoverIssuance;
    private executeTransition;
    private recoverTransition;
}
export declare const GitHubActionsChangeExecutor: typeof TrustedChangeExecutor;
