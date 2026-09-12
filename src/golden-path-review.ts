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

import { CHANGE_CONTRACT_VERSION, type Change, type ChangeDiagnostic, type ChangeProjectionResult } from "./change.js";
import {
  CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
  ChangeRemoteExecutorError,
  executeChangeRemoteMutationResult,
  normalizeChangeRemoteExecutionEvidence,
  normalizeChangeRemoteExecutionResult,
  changeRemoteMutationRequest,
  type ChangeRemoteExecutionEvidence,
  type ChangeRemoteExecutionOutcome,
  type ChangeRemoteExecutor,
  type ChangeRemoteExecutorErrorCode,
} from "./change-executor.js";
import { ChangeTrustedExecutorError, type ChangeTrustedExecutorErrorCode } from "./change-trusted-executor.js";
import { isSafeTrustedFailureDiagnostics, isSecretSafeBoundedText } from "./change-failure-diagnostics.js";

/** Version of the bounded implementation-to-review composition result. */
export const GOLDEN_PATH_REVIEW_ADMISSION_CONTRACT_VERSION = 1 as const;
export type GoldenPathReviewAdmissionContractVersion = typeof GOLDEN_PATH_REVIEW_ADMISSION_CONTRACT_VERSION;

/** The composition always delegates the existing semantic Change operation. */
export const GOLDEN_PATH_REVIEW_ADMISSION_OPERATION = "change.ready" as const;

export type GoldenPathReviewAdmissionFailureCode =
  | ChangeTrustedExecutorErrorCode
  | ChangeRemoteExecutorErrorCode
  | "GOLDEN_PATH_REVIEW_RESULT_INVALID"
  | "GOLDEN_PATH_REVIEW_EXECUTION_FAILED";

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

const DEFAULT_FAILURE_MESSAGE = "The governed implementation-to-review transition failed closed.";
const INVALID_RESULT_MESSAGE = "The governed Ready result did not prove a healthy canonical REVIEW projection.";
const EFFECT_FAILURE_MESSAGE = "The governed Ready effect did not produce a verified REVIEW projection.";
const RECOVERY_FAILURE_MESSAGE = "The governed Ready transition requires bounded recovery before review admission.";

function freezeDiagnostics(diagnostics: readonly ChangeDiagnostic[] | undefined): readonly ChangeDiagnostic[] {
  if (diagnostics === undefined || !isSafeTrustedFailureDiagnostics(diagnostics)) return Object.freeze([]);
  return Object.freeze([...diagnostics]);
}

function safeMessage(message: unknown, fallback: string): string {
  return isSecretSafeBoundedText(message, 240) ? message : fallback;
}

function failureCode(error: unknown): GoldenPathReviewAdmissionFailureCode {
  if (error instanceof ChangeTrustedExecutorError) return error.code;
  if (error instanceof ChangeRemoteExecutorError) return error.code;
  return "GOLDEN_PATH_REVIEW_EXECUTION_FAILED";
}

function failureMessage(error: unknown): string {
  if (error instanceof ChangeTrustedExecutorError || error instanceof ChangeRemoteExecutorError) {
    return safeMessage(error.message, DEFAULT_FAILURE_MESSAGE);
  }
  return DEFAULT_FAILURE_MESSAGE;
}

function failureDiagnostics(error: unknown): readonly ChangeDiagnostic[] {
  if (error instanceof ChangeTrustedExecutorError || error instanceof ChangeRemoteExecutorError) {
    return freezeDiagnostics(error.diagnostics);
  }
  return Object.freeze([]);
}

function failureEvidence(error: unknown): ChangeRemoteExecutionEvidence | undefined {
  if (!(error instanceof ChangeTrustedExecutorError) || error.evidence === undefined) return undefined;
  try {
    return normalizeChangeRemoteExecutionEvidence("ready", error.evidence);
  } catch {
    return undefined;
  }
}

function failure(
  issue: number,
  error: unknown,
  projection?: ChangeProjectionResult,
  evidence?: ChangeRemoteExecutionEvidence,
): GoldenPathReviewAdmissionFailure {
  const normalizedEvidence = evidence ?? failureEvidence(error);
  return Object.freeze({
    version: GOLDEN_PATH_REVIEW_ADMISSION_CONTRACT_VERSION,
    operation: GOLDEN_PATH_REVIEW_ADMISSION_OPERATION,
    issue,
    ...(projection === undefined ? {} : { projection }),
    ...(normalizedEvidence === undefined ? {} : { evidence: normalizedEvidence }),
    ...(normalizedEvidence === undefined ? {} : { executionOutcome: normalizedEvidence.outcome }),
    ok: false as const,
    error: Object.freeze({
      code: failureCode(error),
      message: failureMessage(error),
      diagnostics: failureDiagnostics(error),
    }),
    diagnostics: failureDiagnostics(error),
  });
}

function resultFailure(
  issue: number,
  code: GoldenPathReviewAdmissionFailureCode,
  message: string,
  projection: ChangeProjectionResult,
  evidence: ChangeRemoteExecutionEvidence | undefined,
): GoldenPathReviewAdmissionFailure {
  // Keep the authoritative projection diagnostics on every fail-closed
  // result.  A caller must be able to distinguish stale/unavailable/wrong
  // state evidence without parsing the human-readable failure message.
  const diagnostics = freezeDiagnostics(projection.diagnostics);
  return Object.freeze({
    version: GOLDEN_PATH_REVIEW_ADMISSION_CONTRACT_VERSION,
    operation: GOLDEN_PATH_REVIEW_ADMISSION_OPERATION,
    issue,
    projection,
    ...(evidence === undefined ? {} : { evidence, executionOutcome: evidence.outcome }),
    ok: false as const,
    error: Object.freeze({ code, message, diagnostics }),
    diagnostics,
  });
}

function positivePullRequest(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isReviewSuccess(
  issue: number,
  projection: ChangeProjectionResult,
  evidence: ChangeRemoteExecutionEvidence | undefined,
): projection is ChangeProjectionResult & {
  readonly valid: true;
  readonly status: "healthy";
  readonly change: Change;
} {
  const change = projection.change;
  if (
    !projection.valid ||
    projection.status !== "healthy" ||
    projection.diagnostics.length !== 0 ||
    change === undefined ||
    change.identity.rootIssue !== issue ||
    change.state !== "REVIEW" ||
    change.projection?.branch === undefined ||
    !positivePullRequest(change.projection.pullRequest) ||
    projection.canonicalBranch !== change.projection.branch ||
    projection.canonicalBaseBranch === undefined
  )
    return false;

  // The composition's success contract requires the trusted executor's
  // reread/verification evidence.  A legacy projection-only result cannot
  // prove that the Ready effect was applied (or that a retry was a no-op).
  if (evidence === undefined) return false;
  if (evidence.outcome === "returned-existing") return evidence.effects.length === 0;
  return (
    evidence.outcome === "verified" &&
    evidence.effects.length === 1 &&
    evidence.effects[0]?.kind === "MARK_PULL_REQUEST_READY" &&
    evidence.effects[0].status === "succeeded"
  );
}

/**
 * Normalize one bounded executor result into the implementation-to-review
 * contract. This function is pure and performs no remote I/O.
 */
export function projectGoldenPathReviewAdmission(issue: number, result: unknown): GoldenPathReviewAdmissionResult {
  let normalized;
  try {
    normalized = normalizeChangeRemoteExecutionResult("ready", result);
  } catch (error: unknown) {
    return failure(issue, error);
  }

  const { projection, evidence } = normalized;
  if (evidence?.outcome === "failed") {
    return resultFailure(issue, "CHANGE_EXECUTION_EFFECT_FAILED", EFFECT_FAILURE_MESSAGE, projection, evidence);
  }
  if (evidence?.outcome === "recovery-required" || evidence?.outcome === "compensated") {
    return resultFailure(issue, "CHANGE_EXECUTION_RECOVERY_REQUIRED", RECOVERY_FAILURE_MESSAGE, projection, evidence);
  }
  if (!isReviewSuccess(issue, projection, evidence)) {
    return resultFailure(issue, "GOLDEN_PATH_REVIEW_RESULT_INVALID", INVALID_RESULT_MESSAGE, projection, evidence);
  }

  const change = projection.change;
  const canonicalPullRequest = change.projection?.pullRequest;
  if (!positivePullRequest(canonicalPullRequest)) {
    return resultFailure(issue, "GOLDEN_PATH_REVIEW_RESULT_INVALID", INVALID_RESULT_MESSAGE, projection, evidence);
  }

  const executionOutcome = evidence?.outcome ?? "verified";
  return Object.freeze({
    version: GOLDEN_PATH_REVIEW_ADMISSION_CONTRACT_VERSION,
    operation: GOLDEN_PATH_REVIEW_ADMISSION_OPERATION,
    issue,
    projection,
    change,
    canonicalPullRequest,
    ...(evidence === undefined ? {} : { evidence }),
    executionOutcome,
    ok: true as const,
    diagnostics: Object.freeze([]) as readonly [],
  });
}

/**
 * Execute the existing semantic `change ready` request and normalize its
 * authoritative result. No GitHub ready mutation is available from here;
 * the supplied executor remains the sole transport/effect boundary.
 */
export async function executeGoldenPathReviewAdmission(
  request: GoldenPathReviewAdmissionRequest,
): Promise<GoldenPathReviewAdmissionResult> {
  try {
    const remoteRequest = changeRemoteMutationRequest("ready", request.issue, request.requester);
    const result = await executeChangeRemoteMutationResult(request.executor, remoteRequest);
    return projectGoldenPathReviewAdmission(request.issue, result);
  } catch (error: unknown) {
    return failure(request.issue, error);
  }
}

/** Compatibility spelling for callers that name the boundary by composition. */
export const composeGoldenPathReviewAdmission = executeGoldenPathReviewAdmission;

/** Compile-time assertion that this facade remains tied to the Change remote contract. */
export const GOLDEN_PATH_REVIEW_CHANGE_CONTRACT_VERSION = CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION;
export const GOLDEN_PATH_REVIEW_CORE_VERSION = CHANGE_CONTRACT_VERSION;
