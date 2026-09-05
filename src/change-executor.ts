import {
  CHANGE_IMPLEMENTED_TRANSITIONS,
  CHANGE_TRANSITION_CONTRACT_VERSION,
  validateChangeProjectionResult,
  type ChangeDiagnostic,
  type ChangeProjectionResult,
} from "./change.js";

/** Version of the transport-neutral semantic request boundary. */
export const CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION = CHANGE_TRANSITION_CONTRACT_VERSION;

export const CHANGE_REMOTE_MUTATIONS = CHANGE_IMPLEMENTED_TRANSITIONS;
export type ChangeRemoteMutation = (typeof CHANGE_REMOTE_MUTATIONS)[number];

export interface ChangeRemoteExecutorOptions {
  /** Repository-local working directory used by an executor implementation. */
  readonly cwd: string;
  /** Optional repository locator selected by the caller's normal CLI option. */
  readonly repository?: string;
}

interface ChangeRemoteRequestBase {
  readonly version: typeof CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION;
  readonly issue: number;
}

export interface ChangeRemoteMutationRequest extends ChangeRemoteRequestBase {
  readonly operation: ChangeRemoteMutation;
}

export interface ChangeRemoteReadRequest extends ChangeRemoteRequestBase {
  readonly operation: "show";
}

/**
 * The CLI talks to this semantic boundary only. Implementations may use an
 * Action, service, App event handler, or another transport; none of those
 * details are part of the request or result contract.
 */
export interface ChangeRemoteExecutor {
  execute(request: ChangeRemoteMutationRequest): Promise<ChangeProjectionResult>;
  read(request: ChangeRemoteReadRequest): Promise<ChangeProjectionResult>;
}

/** Compatibility aliases for library callers naming the same boundary. */
export type RemoteChangeExecutor = ChangeRemoteExecutor;
export type ChangeExecutor = ChangeRemoteExecutor;

export type ChangeRemoteExecutorErrorCode =
  "CHANGE_REMOTE_REQUEST_INVALID" | "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE" | "CHANGE_REMOTE_RESULT_INVALID";

export class ChangeRemoteExecutorError extends Error {
  readonly code: ChangeRemoteExecutorErrorCode;
  readonly details?: unknown;
  readonly diagnostics?: readonly ChangeDiagnostic[];

  constructor(
    code: ChangeRemoteExecutorErrorCode,
    message: string,
    details?: unknown,
    diagnostics?: readonly ChangeDiagnostic[],
  ) {
    super(message);
    this.name = "ChangeRemoteExecutorError";
    this.code = code;
    this.details = details;
    this.diagnostics = diagnostics;
  }
}

function assertIssueNumber(issue: number): void {
  if (!Number.isSafeInteger(issue) || issue < 1) {
    throw new ChangeRemoteExecutorError(
      "CHANGE_REMOTE_REQUEST_INVALID",
      "A Change request requires a positive Issue number.",
      { issue },
    );
  }
}

function assertMutation(operation: string): asserts operation is ChangeRemoteMutation {
  if (!CHANGE_REMOTE_MUTATIONS.includes(operation as ChangeRemoteMutation)) {
    throw new ChangeRemoteExecutorError(
      "CHANGE_REMOTE_REQUEST_INVALID",
      `Unsupported Change mutation "${operation}".`,
      { operation },
    );
  }
}

function validateRequest(
  request: ChangeRemoteMutationRequest | ChangeRemoteReadRequest,
): ChangeRemoteMutationRequest | ChangeRemoteReadRequest {
  if (request.version !== CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION) {
    throw new ChangeRemoteExecutorError(
      "CHANGE_REMOTE_REQUEST_INVALID",
      "Change remote request contract version is unsupported.",
      { version: request.version },
    );
  }
  assertIssueNumber(request.issue);
  if (request.operation !== "show") assertMutation(request.operation);
  return request;
}

function normalizeResult(operation: string, result: unknown): ChangeProjectionResult {
  const validation = validateChangeProjectionResult(result);
  if (!validation.valid || validation.projection === undefined) {
    throw new ChangeRemoteExecutorError(
      "CHANGE_REMOTE_RESULT_INVALID",
      "The Change executor returned an invalid bounded projection.",
      { operation },
      validation.diagnostics,
    );
  }
  return validation.projection;
}

export function changeRemoteMutationRequest(
  operation: ChangeRemoteMutation,
  issue: number,
): ChangeRemoteMutationRequest {
  const request: ChangeRemoteMutationRequest = {
    version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
    operation,
    issue,
  };
  validateRequest(request);
  return request;
}

export function changeRemoteReadRequest(issue: number): ChangeRemoteReadRequest {
  const request: ChangeRemoteReadRequest = {
    version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
    operation: "show",
    issue,
  };
  validateRequest(request);
  return request;
}

export async function executeChangeRemoteMutation(
  executor: ChangeRemoteExecutor,
  request: ChangeRemoteMutationRequest,
): Promise<ChangeProjectionResult> {
  validateRequest(request);
  return normalizeResult(request.operation, await executor.execute(request));
}

export async function readChangeRemoteProjection(
  executor: ChangeRemoteExecutor,
  request: ChangeRemoteReadRequest,
): Promise<ChangeProjectionResult> {
  validateRequest(request);
  return normalizeResult(request.operation, await executor.read(request));
}

/** Default until a repository configures a trusted remote executor. */
export function createUnavailableChangeRemoteExecutor(): ChangeRemoteExecutor {
  const unavailable = (operation: string): never => {
    throw new ChangeRemoteExecutorError(
      "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE",
      "No remote Change executor is configured for this CLI runtime.",
      { operation },
    );
  };
  return {
    execute: async (request) => unavailable(request.operation),
    read: async (request) => unavailable(request.operation),
  };
}
