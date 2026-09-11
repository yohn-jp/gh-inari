/**
 * Golden Path implementation-complete -> review composition.
 *
 * This module is deliberately a thin boundary over the existing semantic
 * Change `ready` operation.  Change Core owns lifecycle legality and plans,
 * the Ready XState machine owns sequencing/reread/verification, and the
 * remote executor owns transport and privileged effects.  This module only
 * normalizes that result for Golden Path consumers; it never writes GitHub,
 * keeps local runtime state, or introduces another lifecycle authority.
 */
import { type Change, type ChangeDiagnostic, type ChangeProjectionResult } from "./change.js";
import { type ChangeRemoteExecutionEvidence, type ChangeRemoteExecutionOutcome, type ChangeRemoteExecutor, type ChangeRemoteExecutorErrorCode } from "./change-executor.js";
import { type ChangeTrustedExecutorErrorCode } from "./change-trusted-executor.js";
/** Version of the bounded implementation-to-review composition result. */
export declare const GOLDEN_PATH_REVIEW_ADMISSION_CONTRACT_VERSION: 1;
export type GoldenPathReviewAdmissionContractVersion = typeof GOLDEN_PATH_REVIEW_ADMISSION_CONTRACT_VERSION;
/** The composition always delegates the existing semantic Change operation. */
export declare const GOLDEN_PATH_REVIEW_ADMISSION_OPERATION: "change.ready";
export type GoldenPathReviewAdmissionFailureCode = ChangeTrustedExecutorErrorCode | ChangeRemoteExecutorErrorCode | "GOLDEN_PATH_REVIEW_RESULT_INVALID" | "GOLDEN_PATH_REVIEW_EXECUTION_FAILED";
export interface GoldenPathReviewAdmissionError {
    readonly code: GoldenPathReviewAdmissionFailureCode;
    readonly message: string;
    /** Existing Core/executor diagnostics are retained without provider data. */
    readonly diagnostics: readonly ChangeDiagnostic[];
}
interface GoldenPathReviewAdmissionBase {
    readonly version: GoldenPathReviewAdmissionContractVersion;
    readonly operation: typeof GOLDEN_PATH_REVIEW_ADMISSION_OPERATION;
    readonly issue: number;
    /** Fresh bounded Change projection, when the executor returned one. */
    readonly projection?: ChangeProjectionResult;
    /** Existing bounded execution evidence, when the executor returned one. */
    readonly evidence?: ChangeRemoteExecutionEvidence;
    /** Underlying executor outcome; absent when execution failed before a result. */
    readonly executionOutcome?: ChangeRemoteExecutionOutcome;
    readonly diagnostics: readonly ChangeDiagnostic[];
}
/** Verified implementation-complete -> REVIEW result. */
export interface GoldenPathReviewAdmissionSuccess extends GoldenPathReviewAdmissionBase {
    readonly ok: true;
    readonly projection: ChangeProjectionResult;
    readonly change: Change;
    /** Canonical PR identity projected by Change Core, never caller input. */
    readonly canonicalPullRequest: number;
    readonly executionOutcome: "verified" | "returned-existing";
    readonly diagnostics: readonly [];
}
/** Fail-closed result; no normal Ready success is inferred from a failure. */
export interface GoldenPathReviewAdmissionFailure extends GoldenPathReviewAdmissionBase {
    readonly ok: false;
    readonly error: GoldenPathReviewAdmissionError;
}
export type GoldenPathReviewAdmissionResult = GoldenPathReviewAdmissionSuccess | GoldenPathReviewAdmissionFailure;
/** Input to the transport-neutral composition facade. */
export interface GoldenPathReviewAdmissionRequest {
    readonly issue: number;
    readonly executor: ChangeRemoteExecutor;
    /** Opaque requester provenance; credentials remain outside this contract. */
    readonly requester?: string;
}
/**
 * Normalize one bounded executor result into the implementation-to-review
 * contract. This function is pure and performs no remote I/O.
 */
export declare function projectGoldenPathReviewAdmission(issue: number, result: unknown): GoldenPathReviewAdmissionResult;
/**
 * Execute the existing semantic `change ready` request and normalize its
 * authoritative result. No GitHub ready mutation is available from here;
 * the supplied executor remains the sole transport/effect boundary.
 */
export declare function executeGoldenPathReviewAdmission(request: GoldenPathReviewAdmissionRequest): Promise<GoldenPathReviewAdmissionResult>;
/** Compatibility spelling for callers that name the boundary by composition. */
export declare const composeGoldenPathReviewAdmission: typeof executeGoldenPathReviewAdmission;
/** Compile-time assertion that this facade remains tied to the Change remote contract. */
export declare const GOLDEN_PATH_REVIEW_CHANGE_CONTRACT_VERSION: 1;
export declare const GOLDEN_PATH_REVIEW_CORE_VERSION: 1;
export {};
