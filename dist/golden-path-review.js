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
import { CHANGE_CONTRACT_VERSION } from "./change.js";
import { CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION, ChangeRemoteExecutorError, executeChangeRemoteMutationResult, normalizeChangeRemoteExecutionEvidence, normalizeChangeRemoteExecutionResult, changeRemoteMutationRequest, } from "./change-executor.js";
import { ChangeTrustedExecutorError } from "./change-trusted-executor.js";
import { isSafeTrustedFailureDiagnostics, isSecretSafeBoundedText } from "./change-failure-diagnostics.js";
/** Version of the bounded implementation-to-review composition result. */
export const GOLDEN_PATH_REVIEW_ADMISSION_CONTRACT_VERSION = 1;
/** The composition always delegates the existing semantic Change operation. */
export const GOLDEN_PATH_REVIEW_ADMISSION_OPERATION = "change.ready";
const DEFAULT_FAILURE_MESSAGE = "The governed implementation-to-review transition failed closed.";
const INVALID_RESULT_MESSAGE = "The governed Ready result did not prove a healthy canonical REVIEW projection.";
const EFFECT_FAILURE_MESSAGE = "The governed Ready effect did not produce a verified REVIEW projection.";
const RECOVERY_FAILURE_MESSAGE = "The governed Ready transition requires bounded recovery before review admission.";
function freezeDiagnostics(diagnostics) {
    if (diagnostics === undefined || !isSafeTrustedFailureDiagnostics(diagnostics))
        return Object.freeze([]);
    return Object.freeze([...diagnostics]);
}
function safeMessage(message, fallback) {
    return isSecretSafeBoundedText(message, 240) ? message : fallback;
}
function failureCode(error) {
    if (error instanceof ChangeTrustedExecutorError)
        return error.code;
    if (error instanceof ChangeRemoteExecutorError)
        return error.code;
    return "GOLDEN_PATH_REVIEW_EXECUTION_FAILED";
}
function failureMessage(error) {
    if (error instanceof ChangeTrustedExecutorError || error instanceof ChangeRemoteExecutorError) {
        return safeMessage(error.message, DEFAULT_FAILURE_MESSAGE);
    }
    return DEFAULT_FAILURE_MESSAGE;
}
function failureDiagnostics(error) {
    if (error instanceof ChangeTrustedExecutorError || error instanceof ChangeRemoteExecutorError) {
        return freezeDiagnostics(error.diagnostics);
    }
    return Object.freeze([]);
}
function failureEvidence(error) {
    if (!(error instanceof ChangeTrustedExecutorError) || error.evidence === undefined)
        return undefined;
    try {
        return normalizeChangeRemoteExecutionEvidence("ready", error.evidence);
    }
    catch {
        return undefined;
    }
}
function failure(issue, error, projection, evidence) {
    const normalizedEvidence = evidence ?? failureEvidence(error);
    return Object.freeze({
        version: GOLDEN_PATH_REVIEW_ADMISSION_CONTRACT_VERSION,
        operation: GOLDEN_PATH_REVIEW_ADMISSION_OPERATION,
        issue,
        ...(projection === undefined ? {} : { projection }),
        ...(normalizedEvidence === undefined ? {} : { evidence: normalizedEvidence }),
        ...(normalizedEvidence === undefined ? {} : { executionOutcome: normalizedEvidence.outcome }),
        ok: false,
        error: Object.freeze({
            code: failureCode(error),
            message: failureMessage(error),
            diagnostics: failureDiagnostics(error),
        }),
        diagnostics: failureDiagnostics(error),
    });
}
function resultFailure(issue, code, message, projection, evidence) {
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
        ok: false,
        error: Object.freeze({ code, message, diagnostics }),
        diagnostics,
    });
}
function positivePullRequest(value) {
    return Number.isSafeInteger(value) && value > 0;
}
function isReviewSuccess(issue, projection, evidence) {
    const change = projection.change;
    if (!projection.valid ||
        projection.status !== "healthy" ||
        projection.diagnostics.length !== 0 ||
        change === undefined ||
        change.identity.rootIssue !== issue ||
        change.state !== "REVIEW" ||
        change.projection?.branch === undefined ||
        !positivePullRequest(change.projection.pullRequest) ||
        projection.canonicalBranch !== change.projection.branch ||
        projection.canonicalBaseBranch === undefined)
        return false;
    // The composition's success contract requires the trusted executor's
    // reread/verification evidence.  A legacy projection-only result cannot
    // prove that the Ready effect was applied (or that a retry was a no-op).
    if (evidence === undefined)
        return false;
    if (evidence.outcome === "returned-existing")
        return evidence.effects.length === 0;
    return (evidence.outcome === "verified" &&
        evidence.effects.length === 1 &&
        evidence.effects[0]?.kind === "MARK_PULL_REQUEST_READY" &&
        evidence.effects[0].status === "succeeded");
}
/**
 * Normalize one bounded executor result into the implementation-to-review
 * contract. This function is pure and performs no remote I/O.
 */
export function projectGoldenPathReviewAdmission(issue, result) {
    let normalized;
    try {
        normalized = normalizeChangeRemoteExecutionResult("ready", result);
    }
    catch (error) {
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
        ok: true,
        diagnostics: Object.freeze([]),
    });
}
/**
 * Execute the existing semantic `change ready` request and normalize its
 * authoritative result. No GitHub ready mutation is available from here;
 * the supplied executor remains the sole transport/effect boundary.
 */
export async function executeGoldenPathReviewAdmission(request) {
    try {
        const remoteRequest = changeRemoteMutationRequest("ready", request.issue, request.requester);
        const result = await executeChangeRemoteMutationResult(request.executor, remoteRequest);
        return projectGoldenPathReviewAdmission(request.issue, result);
    }
    catch (error) {
        return failure(request.issue, error);
    }
}
/** Compatibility spelling for callers that name the boundary by composition. */
export const composeGoldenPathReviewAdmission = executeGoldenPathReviewAdmission;
/** Compile-time assertion that this facade remains tied to the Change remote contract. */
export const GOLDEN_PATH_REVIEW_CHANGE_CONTRACT_VERSION = CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION;
export const GOLDEN_PATH_REVIEW_CORE_VERSION = CHANGE_CONTRACT_VERSION;
//# sourceMappingURL=golden-path-review.js.map