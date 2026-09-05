import { CHANGE_IMPLEMENTED_TRANSITIONS, CHANGE_TRANSITION_CONTRACT_VERSION, validateChangeProjectionResult, } from "./change.js";
/** Version of the transport-neutral semantic request boundary. */
export const CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION = CHANGE_TRANSITION_CONTRACT_VERSION;
export const CHANGE_REMOTE_MUTATIONS = CHANGE_IMPLEMENTED_TRANSITIONS;
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
    if (request.operation !== "show")
        assertMutation(request.operation);
    return request;
}
function normalizeResult(operation, result) {
    const validation = validateChangeProjectionResult(result);
    if (!validation.valid || validation.projection === undefined) {
        throw new ChangeRemoteExecutorError("CHANGE_REMOTE_RESULT_INVALID", "The Change executor returned an invalid bounded projection.", { operation }, validation.diagnostics);
    }
    return validation.projection;
}
export function changeRemoteMutationRequest(operation, issue) {
    const request = {
        version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
        operation,
        issue,
    };
    validateRequest(request);
    return request;
}
export function changeRemoteReadRequest(issue) {
    const request = {
        version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
        operation: "show",
        issue,
    };
    validateRequest(request);
    return request;
}
export async function executeChangeRemoteMutation(executor, request) {
    validateRequest(request);
    return normalizeResult(request.operation, await executor.execute(request));
}
export async function readChangeRemoteProjection(executor, request) {
    validateRequest(request);
    return normalizeResult(request.operation, await executor.read(request));
}
/** Default until a repository configures a trusted remote executor. */
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