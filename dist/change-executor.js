import { CHANGE_EFFECT_KINDS, CHANGE_IMPLEMENTED_TRANSITIONS, CHANGE_TRANSITION_CONTRACT_VERSION, MAX_CHANGE_COMMIT_SHA_LENGTH, validateChangeProjectionResult, } from "./change.js";
import { isSecretSafeBoundedText } from "./change-failure-diagnostics.js";
/** Version of the transport-neutral semantic request boundary. */
export const CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION = CHANGE_TRANSITION_CONTRACT_VERSION;
const MAX_SEMANTIC_PULL_REQUEST_PLAN_BYTES = 1_048_576;
export const MAX_CHANGE_REMOTE_EXECUTION_EVIDENCE_BYTES = 16_384;
export const CHANGE_REMOTE_MUTATIONS = CHANGE_IMPLEMENTED_TRANSITIONS;
/**
 * Canonical requester identity for GitHub-authenticated execution.  The
 * authenticated login is converted at the transport/runtime boundary; it
 * is never a substitute for an issuer or another Change provenance role.
 */
export function canonicalGitHubRequester(login) {
    return `github:${login}`;
}
export const CHANGE_REMOTE_EXECUTION_OUTCOMES = Object.freeze([
    "verified",
    "returned-existing",
    "compensated",
    "recovery-required",
    "failed",
]);
export class ChangeRemoteExecutorError extends Error {
    code;
    details;
    diagnostics;
    constructor(code, message, details, diagnostics) {
        super(message);
        this.name = "ChangeRemoteExecutorError";
        this.code = code;
        this.details = details;
        this.diagnostics = diagnostics;
    }
}
function assertIssueNumber(issue) {
    if (!Number.isSafeInteger(issue) || issue < 1) {
        throw new ChangeRemoteExecutorError("CHANGE_REMOTE_REQUEST_INVALID", "A Change request requires a positive Issue number.", { issue });
    }
}
function assertMutation(operation) {
    if (!CHANGE_REMOTE_MUTATIONS.includes(operation)) {
        throw new ChangeRemoteExecutorError("CHANGE_REMOTE_REQUEST_INVALID", `Unsupported Change mutation "${operation}".`, { operation });
    }
}
function validateRequest(request) {
    if (request.version !== CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION) {
        throw new ChangeRemoteExecutorError("CHANGE_REMOTE_REQUEST_INVALID", "Change remote request contract version is unsupported.", { version: request.version });
    }
    assertIssueNumber(request.issue);
    if (request.requester !== undefined &&
        (!validText(request.requester, 160) || /[\u0000-\u001F\u007F]/u.test(request.requester))) {
        throw new ChangeRemoteExecutorError("CHANGE_REMOTE_REQUEST_INVALID", "A Change request requester identity is invalid.", { issue: request.issue });
    }
    if (request.operation !== "show" && request.semanticPullRequestPlan !== undefined) {
        if (request.operation !== "issue") {
            throw new ChangeRemoteExecutorError("CHANGE_REMOTE_REQUEST_INVALID", "A Semantic PR plan is accepted only for Change issuance.", { issue: request.issue });
        }
        let serialized;
        try {
            serialized = JSON.stringify(request.semanticPullRequestPlan);
        }
        catch {
            throw new ChangeRemoteExecutorError("CHANGE_REMOTE_REQUEST_INVALID", "A Semantic PR plan must be JSON-serializable.", { issue: request.issue });
        }
        if (serialized === undefined || serialized.length > MAX_SEMANTIC_PULL_REQUEST_PLAN_BYTES) {
            throw new ChangeRemoteExecutorError("CHANGE_REMOTE_REQUEST_INVALID", "A Semantic PR plan exceeds the bounded request size.", { issue: request.issue });
        }
    }
    if (request.operation !== "show")
        assertMutation(request.operation);
    return request;
}
export function normalizeChangeRemoteProjection(operation, result) {
    const validation = validateChangeProjectionResult(result);
    if (!validation.valid || validation.projection === undefined) {
        throw new ChangeRemoteExecutorError("CHANGE_REMOTE_RESULT_INVALID", "The Change executor returned an invalid bounded projection.", { operation }, validation.diagnostics);
    }
    return validation.projection;
}
function validText(value, maxLength) {
    return (typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001F\u007F]/u.test(value));
}
export function normalizeChangeRemoteExecutionEvidence(operation, value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ChangeRemoteExecutorError("CHANGE_REMOTE_RESULT_INVALID", "The Change executor returned invalid bounded execution evidence.", { operation });
    }
    const candidate = value;
    const allowed = new Set([
        "version",
        "operation",
        "outcome",
        "requester",
        "issuer",
        "effects",
        "compensation",
        "failure",
    ]);
    if (Object.keys(candidate).some((key) => !allowed.has(key))) {
        throw new ChangeRemoteExecutorError("CHANGE_REMOTE_RESULT_INVALID", "The Change executor returned invalid bounded execution evidence.", { operation });
    }
    if (candidate.version !== CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION ||
        candidate.operation !== operation ||
        !CHANGE_REMOTE_MUTATIONS.includes(operation) ||
        !CHANGE_REMOTE_EXECUTION_OUTCOMES.includes(candidate.outcome) ||
        !Array.isArray(candidate.effects) ||
        candidate.effects.length > 8) {
        throw new ChangeRemoteExecutorError("CHANGE_REMOTE_RESULT_INVALID", "The Change executor returned invalid bounded execution evidence.", { operation });
    }
    const effects = [];
    for (const effect of candidate.effects) {
        if (typeof effect !== "object" ||
            effect === null ||
            Array.isArray(effect) ||
            Object.keys(effect).some((key) => key !== "kind" && key !== "status" && key !== "createdCommitSha")) {
            throw new ChangeRemoteExecutorError("CHANGE_REMOTE_RESULT_INVALID", "The Change executor returned invalid bounded execution evidence.", { operation });
        }
        const entry = effect;
        if (!CHANGE_EFFECT_KINDS.includes(entry.kind)) {
            throw new ChangeRemoteExecutorError("CHANGE_REMOTE_RESULT_INVALID", "The Change executor returned invalid bounded execution evidence.", { operation });
        }
        if (entry.status !== "succeeded" && entry.status !== "failed") {
            throw new ChangeRemoteExecutorError("CHANGE_REMOTE_RESULT_INVALID", "The Change executor returned invalid bounded execution evidence.", { operation });
        }
        let createdCommitSha;
        if (Object.prototype.hasOwnProperty.call(entry, "createdCommitSha")) {
            if (entry.kind !== "CREATE_BRANCH" || entry.status !== "succeeded") {
                throw new ChangeRemoteExecutorError("CHANGE_REMOTE_RESULT_INVALID", "The Change executor returned invalid bounded execution evidence.", { operation });
            }
            if (typeof entry.createdCommitSha !== "string" ||
                entry.createdCommitSha.length !== MAX_CHANGE_COMMIT_SHA_LENGTH ||
                !/^[0-9a-f]{40}$/iu.test(entry.createdCommitSha)) {
                throw new ChangeRemoteExecutorError("CHANGE_REMOTE_RESULT_INVALID", "The Change executor returned invalid bounded execution evidence.", { operation });
            }
            createdCommitSha = entry.createdCommitSha.toLowerCase();
        }
        effects.push({
            kind: entry.kind,
            status: entry.status,
            ...(createdCommitSha === undefined ? {} : { createdCommitSha }),
        });
    }
    const requester = candidate.requester === undefined ? undefined : candidate.requester;
    const issuer = candidate.issuer === undefined ? undefined : candidate.issuer;
    if ((requester !== undefined && !isSecretSafeBoundedText(requester, 160)) ||
        (issuer !== undefined && !isSecretSafeBoundedText(issuer, 160))) {
        throw new ChangeRemoteExecutorError("CHANGE_REMOTE_RESULT_INVALID", "The Change executor returned invalid bounded execution evidence.", { operation });
    }
    let failure;
    if (candidate.failure !== undefined) {
        if (typeof candidate.failure !== "object" || candidate.failure === null || Array.isArray(candidate.failure)) {
            throw new ChangeRemoteExecutorError("CHANGE_REMOTE_RESULT_INVALID", "The Change executor returned invalid bounded execution evidence.", { operation });
        }
        const failureValue = candidate.failure;
        if (Object.keys(failureValue).some((key) => !["kind", "code", "message"].includes(key)) ||
            !CHANGE_EFFECT_KINDS.includes(failureValue.kind) ||
            !isSecretSafeBoundedText(failureValue.code, 80) ||
            !isSecretSafeBoundedText(failureValue.message, 240)) {
            throw new ChangeRemoteExecutorError("CHANGE_REMOTE_RESULT_INVALID", "The Change executor returned invalid bounded execution evidence.", { operation });
        }
        failure = {
            kind: failureValue.kind,
            code: failureValue.code,
            message: failureValue.message,
        };
    }
    if (candidate.compensation !== undefined &&
        !["not-required", "succeeded", "failed"].includes(candidate.compensation)) {
        throw new ChangeRemoteExecutorError("CHANGE_REMOTE_RESULT_INVALID", "The Change executor returned invalid bounded execution evidence.", { operation });
    }
    const normalized = {
        version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
        operation: operation,
        outcome: candidate.outcome,
        ...(requester === undefined ? {} : { requester }),
        ...(issuer === undefined ? {} : { issuer }),
        effects: Object.freeze(effects),
        ...(candidate.compensation === undefined
            ? {}
            : { compensation: candidate.compensation }),
        ...(failure === undefined ? {} : { failure }),
    };
    if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > MAX_CHANGE_REMOTE_EXECUTION_EVIDENCE_BYTES) {
        throw new ChangeRemoteExecutorError("CHANGE_REMOTE_RESULT_INVALID", "The Change executor returned oversized bounded execution evidence.", { operation });
    }
    return normalized;
}
export function normalizeChangeRemoteExecutionResult(operation, result) {
    if (typeof result === "object" &&
        result !== null &&
        !Array.isArray(result) &&
        Object.prototype.hasOwnProperty.call(result, "projection")) {
        const envelope = result;
        if (Object.keys(envelope).some((key) => key !== "projection" && key !== "evidence")) {
            throw new ChangeRemoteExecutorError("CHANGE_REMOTE_RESULT_INVALID", "The Change executor returned an invalid bounded execution result.", { operation });
        }
        const projection = normalizeChangeRemoteProjection(operation, envelope.projection);
        const evidence = envelope.evidence === undefined
            ? undefined
            : normalizeChangeRemoteExecutionEvidence(operation, envelope.evidence);
        return Object.freeze({
            projection,
            ...(evidence === undefined ? {} : { evidence }),
        });
    }
    return { projection: normalizeChangeRemoteProjection(operation, result) };
}
export function changeRemoteMutationRequest(operation, issue, requester, semanticPullRequestPlan) {
    const request = {
        version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
        operation,
        issue,
        ...(requester === undefined ? {} : { requester }),
        ...(semanticPullRequestPlan === undefined ? {} : { semanticPullRequestPlan }),
    };
    validateRequest(request);
    return request;
}
export function changeRemoteReadRequest(issue, requester) {
    const request = {
        version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
        operation: "show",
        issue,
        ...(requester === undefined ? {} : { requester }),
    };
    validateRequest(request);
    return request;
}
export async function executeChangeRemoteMutation(executor, request) {
    validateRequest(request);
    return (await executeChangeRemoteMutationResult(executor, request)).projection;
}
export async function executeChangeRemoteMutationResult(executor, request) {
    validateRequest(request);
    return normalizeChangeRemoteExecutionResult(request.operation, await executor.execute(request));
}
export async function readChangeRemoteProjection(executor, request) {
    validateRequest(request);
    return normalizeChangeRemoteProjection(request.operation, await executor.read(request));
}
/** Explicit fallback for a runtime that has no remote executor implementation. */
export function createUnavailableChangeRemoteExecutor() {
    const unavailable = (operation) => {
        throw new ChangeRemoteExecutorError("CHANGE_REMOTE_EXECUTOR_UNAVAILABLE", "No remote Change executor is configured for this CLI runtime.", { operation });
    };
    return {
        execute: async (request) => unavailable(request.operation),
        read: async (request) => unavailable(request.operation),
    };
}
//# sourceMappingURL=change-executor.js.map