import type { ChangeDiagnostic, ChangeEffect, ChangeEffectSuccessEvidence, ChangeIssuanceEffectAttempt, ChangeIssuanceFailureEvidence, ChangeIssuancePlan, ChangeIssuanceRecoveryPlan, ChangeProjectionInput, ChangeProjectionResult } from "../../change.js";
import type { ChangeRemoteExecutionResult, ChangeRemoteMutationRequest } from "../../change-executor.js";
export type IssuanceExecutionFailureCode = "CHANGE_EXECUTION_READ_FAILED" | "CHANGE_EXECUTION_PRECONDITION_FAILED" | "CHANGE_EXECUTION_EFFECT_FAILED" | "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED" | "CHANGE_EXECUTION_RECOVERY_REQUIRED";
export interface IssuanceExecutionFailure {
    readonly code: IssuanceExecutionFailureCode;
    readonly message: string;
    readonly diagnostics: readonly ChangeDiagnostic[];
    readonly evidence?: ChangeRemoteExecutionResult["evidence"];
}
/** The two ordered create-mode issuance effects; DELETE_BRANCH is compensation-only. */
export type IssuanceCreateEffect = Extract<ChangeEffect, {
    readonly kind: "CREATE_BRANCH" | "CREATE_PULL_REQUEST";
}>;
export type IssuanceCompensationEffect = Extract<ChangeEffect, {
    readonly kind: "DELETE_BRANCH";
}>;
export type IssuanceEffect = IssuanceCreateEffect | IssuanceCompensationEffect;
export interface IssuanceReadSuccess {
    readonly ok: true;
    readonly input: ChangeProjectionInput;
}
export interface IssuanceReadFailure {
    readonly ok: false;
    readonly failure: IssuanceExecutionFailure;
}
export type IssuanceReadResult = IssuanceReadSuccess | IssuanceReadFailure;
export interface IssuanceEffectSuccess {
    readonly ok: true;
    readonly evidence?: ChangeEffectSuccessEvidence;
}
export interface IssuanceEffectFailureResult {
    readonly ok: false;
    readonly failure: {
        readonly code: string;
        readonly message: string;
    };
}
export type IssuanceEffectResult = IssuanceEffectSuccess | IssuanceEffectFailureResult;
export interface IssuancePlanSuccess {
    readonly ok: true;
    readonly plan: ChangeIssuancePlan;
}
export interface IssuancePlanFailure {
    readonly ok: false;
    readonly failure: IssuanceExecutionFailure;
}
export type IssuancePlanResult = IssuancePlanSuccess | IssuancePlanFailure;
export interface IssuanceRecoveryPlanSuccess {
    readonly ok: true;
    readonly plan: ChangeIssuanceRecoveryPlan;
}
export interface IssuanceRecoveryPlanFailure {
    readonly ok: false;
    readonly failure: IssuanceExecutionFailure;
}
export type IssuanceRecoveryPlanResult = IssuanceRecoveryPlanSuccess | IssuanceRecoveryPlanFailure;
export interface IssuanceRecoveryPlanInput {
    readonly issuance: ChangeIssuancePlan;
    readonly attempts: readonly ChangeIssuanceEffectAttempt[];
    readonly failure: ChangeIssuanceFailureEvidence;
    readonly projectionInput: ChangeProjectionInput;
    readonly compensation?: {
        readonly status: "succeeded" | "failed";
        readonly projectionInput: ChangeProjectionInput;
        readonly failure?: ChangeIssuanceFailureEvidence;
    };
}
export interface IssuanceVerificationResult {
    readonly valid: boolean;
    readonly diagnostics: readonly ChangeDiagnostic[];
    readonly message?: string;
}
/** Classification of authoritative evidence rechecked after an effect failure. */
export type IssuanceEffectFailureProjectionClass = "confirmed-absent" | "unresolved";
export interface IssuanceExecutionSemantics {
    readonly project: (input: ChangeProjectionInput) => ChangeProjectionResult;
    /** Governed root-Issue validation; Core owns the exact rule. */
    readonly validateGovernance: (input: ChangeProjectionInput) => readonly ChangeDiagnostic[];
    /** Anti-drift check between the initial and immediately-pre-plan reads. */
    readonly validateGovernanceDrift: (initial: ChangeProjectionInput, fresh: ChangeProjectionInput) => readonly ChangeDiagnostic[];
    readonly plan: (input: ChangeProjectionInput, requester: string | undefined) => IssuancePlanResult;
    readonly verify: (request: ChangeRemoteMutationRequest, input: ChangeProjectionInput, projection: ChangeProjectionResult, plan: ChangeIssuancePlan) => IssuanceVerificationResult;
    /** Classifies rechecked evidence after a CREATE_BRANCH effect failure. */
    readonly classifyEffectFailureProjection: (projection: ChangeProjectionResult) => IssuanceEffectFailureProjectionClass;
    readonly planRecovery: (input: IssuanceRecoveryPlanInput) => IssuanceRecoveryPlanResult;
}
export interface IssuanceExecutionResults {
    readonly returnedExisting: (projection: ChangeProjectionResult) => ChangeRemoteExecutionResult;
    readonly verified: (projection: ChangeProjectionResult, attempts: readonly ChangeIssuanceEffectAttempt[]) => ChangeRemoteExecutionResult;
    /** Bounded thrown failure for a CREATE_BRANCH failure confirmed to have applied no effect. */
    readonly effectFailed: (attempts: readonly ChangeIssuanceEffectAttempt[], failure: ChangeIssuanceFailureEvidence) => IssuanceExecutionFailure;
    readonly compensated: (projection: ChangeProjectionResult, attempts: readonly ChangeIssuanceEffectAttempt[], failure: ChangeIssuanceFailureEvidence) => ChangeRemoteExecutionResult;
    /** Core-validated recovery-required outcome; the reread projection is used as-is. */
    readonly recoveryRequired: (projection: ChangeProjectionResult, attempts: readonly ChangeIssuanceEffectAttempt[], failure: ChangeIssuanceFailureEvidence, compensationStatus: "succeeded" | "failed") => ChangeRemoteExecutionResult;
    /**
     * Recovery-required outcome for evidence Core could not validate as a safe
     * compensation/recovery result; a bounded synthetic RECOVERY_REQUIRED
     * projection is substituted instead of trusting the raw reread shape.
     */
    readonly recoveryUnsafe: (plan: ChangeIssuancePlan, projection: ChangeProjectionResult, attempts: readonly ChangeIssuanceEffectAttempt[], failure: ChangeIssuanceFailureEvidence, compensationStatus: "succeeded" | "failed") => ChangeRemoteExecutionResult;
    /** Bounded thrown failure when repository evidence cannot be reread after an effect failure. */
    readonly recoveryReadFailure: (attempts: readonly ChangeIssuanceEffectAttempt[], failure: ChangeIssuanceFailureEvidence, compensationStatus?: "succeeded" | "failed") => IssuanceExecutionFailure;
}
export interface IssuanceExecutionServices {
    readonly request: ChangeRemoteMutationRequest;
    /** The read actor is the only machine boundary for repository evidence I/O. */
    readonly read: (request: ChangeRemoteMutationRequest) => Promise<IssuanceReadResult>;
    /** The effect actor is the only machine boundary for privileged GitHub mutation. */
    readonly apply: (effect: IssuanceEffect) => Promise<IssuanceEffectResult>;
    readonly failureForEffect: (effect: IssuanceEffect) => {
        readonly code: string;
        readonly message: string;
    };
    readonly semantics: IssuanceExecutionSemantics;
    readonly results: IssuanceExecutionResults;
}
export type IssuanceExecutionOutcome = {
    readonly kind: "result";
    readonly result: ChangeRemoteExecutionResult;
} | {
    readonly kind: "failure";
    readonly failure: IssuanceExecutionFailure;
};
/** Execute Change issuance and its bounded compensation through the internal XState actor. */
export declare function executeIssuanceWithXState(services: IssuanceExecutionServices): Promise<IssuanceExecutionOutcome>;
