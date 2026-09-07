import type { ChangeDiagnostic, ChangeEffect, ChangeIssuanceEffectAttempt, ChangeProjectionInput, ChangeProjectionResult, ChangeTransitionPlan } from "../../change.js";
import type { ChangeRemoteExecutionResult, ChangeRemoteMutationRequest } from "../../change-executor.js";
export type AbortExecutionFailureCode = "CHANGE_EXECUTION_READ_FAILED" | "CHANGE_EXECUTION_PRECONDITION_FAILED" | "CHANGE_EXECUTION_EFFECT_FAILED" | "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED" | "CHANGE_EXECUTION_RECOVERY_REQUIRED";
export interface AbortExecutionFailure {
    readonly code: AbortExecutionFailureCode;
    readonly message: string;
    readonly diagnostics: readonly ChangeDiagnostic[];
    readonly evidence?: ChangeRemoteExecutionResult["evidence"];
}
export type AbortEffect = Extract<ChangeEffect, {
    readonly kind: "CLOSE_PULL_REQUEST" | "DELETE_BRANCH";
}>;
export interface AbortReadSuccess {
    readonly ok: true;
    readonly input: ChangeProjectionInput;
}
export interface AbortReadFailure {
    readonly ok: false;
    readonly failure: AbortExecutionFailure;
}
export type AbortReadResult = AbortReadSuccess | AbortReadFailure;
export interface AbortEffectSuccess {
    readonly ok: true;
}
export interface AbortEffectFailureResult {
    readonly ok: false;
    readonly failure: {
        readonly code: string;
        readonly message: string;
    };
}
export type AbortEffectResult = AbortEffectSuccess | AbortEffectFailureResult;
export interface AbortEffectFailure {
    readonly effect: AbortEffect;
    readonly code: string;
    readonly message: string;
}
export interface AbortAdmissionSuccess {
    readonly ok: true;
    readonly phase: "normal" | "recovery";
}
export interface AbortAdmissionFailure {
    readonly ok: false;
    readonly failure: AbortExecutionFailure;
}
export type AbortAdmissionResult = AbortAdmissionSuccess | AbortAdmissionFailure;
export interface AbortPlanSuccess {
    readonly ok: true;
    readonly plan: ChangeTransitionPlan;
}
export interface AbortPlanFailure {
    readonly ok: false;
    readonly failure: AbortExecutionFailure;
}
export type AbortPlanResult = AbortPlanSuccess | AbortPlanFailure;
export interface AbortVerificationResult {
    readonly valid: boolean;
    readonly diagnostics: readonly ChangeDiagnostic[];
    readonly message?: string;
}
export interface AbortRecoverySuccess {
    readonly ok: true;
    readonly result: ChangeRemoteExecutionResult;
}
export interface AbortRecoveryFailure {
    readonly ok: false;
    readonly failure: AbortExecutionFailure;
}
export type AbortRecoveryResult = AbortRecoverySuccess | AbortRecoveryFailure;
export interface AbortExecutionSemantics {
    readonly project: (input: ChangeProjectionInput) => ChangeProjectionResult;
    readonly classify: (projection: ChangeProjectionResult) => AbortAdmissionResult;
    readonly plan: (request: ChangeRemoteMutationRequest, projection: ChangeProjectionResult) => AbortPlanResult;
    readonly recover: (request: ChangeRemoteMutationRequest, transition: ChangeTransitionPlan, attempts: readonly ChangeIssuanceEffectAttempt[], failure: AbortEffectFailure, input: ChangeProjectionInput) => AbortRecoveryResult;
    readonly verify: (request: ChangeRemoteMutationRequest, input: ChangeProjectionInput, projection: ChangeProjectionResult, plan: ChangeTransitionPlan) => AbortVerificationResult;
}
export interface AbortExecutionResults {
    readonly returnedExisting: (projection: ChangeProjectionResult) => ChangeRemoteExecutionResult;
    readonly verified: (projection: ChangeProjectionResult, attempts: readonly ChangeIssuanceEffectAttempt[]) => ChangeRemoteExecutionResult;
    readonly recoveryRequired: (projection: ChangeProjectionResult, attempts: readonly ChangeIssuanceEffectAttempt[], failure: AbortEffectFailure) => ChangeRemoteExecutionResult;
}
export interface AbortExecutionServices {
    readonly request: ChangeRemoteMutationRequest;
    /** Evidence I/O is isolated behind the operation actor boundary. */
    readonly read: (request: ChangeRemoteMutationRequest) => Promise<AbortReadResult>;
    /** Privileged effects are isolated behind the operation actor boundary. */
    readonly apply: (effect: AbortEffect) => Promise<AbortEffectResult>;
    readonly failureForEffect: (effect: AbortEffect) => {
        readonly code: string;
        readonly message: string;
    };
    /** Builds the bounded failure returned when recovery evidence cannot be read. */
    readonly recoveryReadFailure: (request: ChangeRemoteMutationRequest, attempts: readonly ChangeIssuanceEffectAttempt[], failure: AbortEffectFailure) => AbortExecutionFailure;
    readonly semantics: AbortExecutionSemantics;
    readonly results: AbortExecutionResults;
}
export type AbortExecutionOutcome = {
    readonly kind: "result";
    readonly result: ChangeRemoteExecutionResult;
} | {
    readonly kind: "failure";
    readonly failure: AbortExecutionFailure;
};
/** Execute Abort and cleanup recovery through the internal XState actor. */
export declare function executeAbortWithXState(services: AbortExecutionServices): Promise<AbortExecutionOutcome>;
