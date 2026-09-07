import type { Change, ChangeDiagnostic, ChangeEffect, ChangeProjectionInput, ChangeProjectionResult, ChangeReadyTransitionValidationResult, ChangeTransitionPlan } from "../../change.js";
import type { ChangeRemoteMutationRequest, ChangeRemoteExecutionResult } from "../../change-executor.js";
export type ReadyExecutionFailureCode = "CHANGE_EXECUTION_READ_FAILED" | "CHANGE_EXECUTION_PRECONDITION_FAILED" | "CHANGE_EXECUTION_EFFECT_FAILED" | "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED" | "CHANGE_EXECUTION_RECOVERY_REQUIRED";
export interface ReadyExecutionFailure {
    readonly code: ReadyExecutionFailureCode;
    readonly message: string;
    readonly diagnostics: readonly ChangeDiagnostic[];
}
export interface ReadyReadSuccess {
    readonly ok: true;
    readonly input: ChangeProjectionInput;
}
export interface ReadyReadFailure {
    readonly ok: false;
    readonly failure: ReadyExecutionFailure;
}
export type ReadyReadResult = ReadyReadSuccess | ReadyReadFailure;
export interface ReadyEffectFailure {
    readonly code: string;
    readonly message: string;
}
export interface ReadyEffectSuccess {
    readonly ok: true;
}
export interface ReadyEffectFailureResult {
    readonly ok: false;
    readonly failure: ReadyEffectFailure;
}
export type ReadyEffectResult = ReadyEffectSuccess | ReadyEffectFailureResult;
type ReadyEffect = Extract<ChangeEffect, {
    readonly kind: "MARK_PULL_REQUEST_READY";
}>;
export interface ReadyVerificationResult {
    readonly valid: boolean;
    readonly diagnostics: readonly ChangeDiagnostic[];
    readonly message?: string;
}
export interface ReadyExecutionSemantics {
    readonly project: (input: ChangeProjectionInput) => ChangeProjectionResult;
    readonly validationInput: (input: ChangeProjectionInput, change: Change | undefined, requester: string | undefined) => unknown;
    readonly validate: (input: unknown) => ChangeReadyTransitionValidationResult;
    readonly plan: (input: unknown) => ChangeTransitionPlan;
    readonly verify: (request: ChangeRemoteMutationRequest, input: ChangeProjectionInput, projection: ChangeProjectionResult, plan: ChangeTransitionPlan) => ReadyVerificationResult;
}
export interface ReadyExecutionResults {
    readonly returnedExisting: (projection: ChangeProjectionResult) => ChangeRemoteExecutionResult;
    readonly verified: (projection: ChangeProjectionResult, effect: ReadyEffect) => ChangeRemoteExecutionResult;
    readonly failed: (projection: ChangeProjectionResult, effect: ReadyEffect, failure: ReadyEffectFailure) => ChangeRemoteExecutionResult;
}
export interface ReadyExecutionServices {
    readonly request: ChangeRemoteMutationRequest;
    /** The read actor is the only machine boundary for repository evidence I/O. */
    readonly read: (request: ChangeRemoteMutationRequest) => Promise<ReadyReadResult>;
    /** The effect actor is the only machine boundary for the privileged GitHub mutation. */
    readonly apply: (effect: ReadyEffect) => Promise<ReadyEffectResult>;
    readonly failureForEffect: (effect: ReadyEffect) => ReadyEffectFailure;
    readonly semantics: ReadyExecutionSemantics;
    readonly results: ReadyExecutionResults;
}
export type ReadyExecutionOutcome = {
    readonly kind: "result";
    readonly result: ChangeRemoteExecutionResult;
} | {
    readonly kind: "failure";
    readonly failure: ReadyExecutionFailure;
};
/** Execute the Ready operation through the internal XState actor. */
export declare function executeReadyWithXState(services: ReadyExecutionServices): Promise<ReadyExecutionOutcome>;
export {};
