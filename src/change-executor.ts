import {
  CHANGE_EFFECT_KINDS,
  CHANGE_IMPLEMENTED_TRANSITIONS,
  CHANGE_TRANSITION_CONTRACT_VERSION,
  validateChangeProjectionResult,
  type ChangeDiagnostic,
  type ChangeEffectKind,
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
  /** Opaque requester provenance; never a credential. */
  readonly requester?: string;
}

export interface ChangeRemoteMutationRequest extends ChangeRemoteRequestBase {
  readonly operation: ChangeRemoteMutation;
}

export interface ChangeRemoteReadRequest extends ChangeRemoteRequestBase {
  readonly operation: "show";
}

/** Bounded evidence emitted by a trusted executor, never a raw API result. */
export interface ChangeRemoteEffectEvidence {
  readonly kind: ChangeEffectKind;
  readonly status: "succeeded" | "failed";
}

export const CHANGE_REMOTE_EXECUTION_OUTCOMES = Object.freeze([
  "verified",
  "returned-existing",
  "compensated",
  "recovery-required",
  "failed",
] as const);
export type ChangeRemoteExecutionOutcome = (typeof CHANGE_REMOTE_EXECUTION_OUTCOMES)[number];

export interface ChangeRemoteExecutionFailureEvidence {
  readonly kind: ChangeEffectKind;
  readonly code: string;
  readonly message: string;
}

export interface ChangeRemoteExecutionEvidence {
  readonly version: typeof CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION;
  readonly operation: ChangeRemoteMutation;
  readonly outcome: ChangeRemoteExecutionOutcome;
  readonly requester?: string;
  readonly issuer?: string;
  readonly effects: readonly ChangeRemoteEffectEvidence[];
  readonly compensation?: "not-required" | "succeeded" | "failed";
  readonly failure?: ChangeRemoteExecutionFailureEvidence;
}

/** Projection plus bounded execution provenance; transport details stay out. */
export interface ChangeRemoteExecutionResult {
  readonly projection: ChangeProjectionResult;
  readonly evidence?: ChangeRemoteExecutionEvidence;
}

/**
 * The CLI talks to this semantic boundary only. Implementations may use an
 * Action, service, App event handler, or another transport; none of those
 * details are part of the request or result contract.
 */
export interface ChangeRemoteExecutor {
  execute(request: ChangeRemoteMutationRequest): Promise<ChangeProjectionResult | ChangeRemoteExecutionResult>;
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
  if (
    request.requester !== undefined &&
    (!validText(request.requester, 160) || /[\u0000-\u001F\u007F]/u.test(request.requester))
  ) {
    throw new ChangeRemoteExecutorError(
      "CHANGE_REMOTE_REQUEST_INVALID",
      "A Change request requester identity is invalid.",
      { issue: request.issue },
    );
  }
  if (request.operation !== "show") assertMutation(request.operation);
  return request;
}

function normalizeProjection(operation: string, result: unknown): ChangeProjectionResult {
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

function validText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001F\u007F]/u.test(value)
  );
}

function normalizeExecutionEvidence(operation: string, value: unknown): ChangeRemoteExecutionEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ChangeRemoteExecutorError(
      "CHANGE_REMOTE_RESULT_INVALID",
      "The Change executor returned invalid bounded execution evidence.",
      { operation },
    );
  }
  const candidate = value as Record<string, unknown>;
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
    throw new ChangeRemoteExecutorError(
      "CHANGE_REMOTE_RESULT_INVALID",
      "The Change executor returned invalid bounded execution evidence.",
      { operation },
    );
  }
  if (
    candidate.version !== CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION ||
    candidate.operation !== operation ||
    !CHANGE_REMOTE_EXECUTION_OUTCOMES.includes(candidate.outcome as ChangeRemoteExecutionOutcome) ||
    !Array.isArray(candidate.effects) ||
    candidate.effects.length > 8
  ) {
    throw new ChangeRemoteExecutorError(
      "CHANGE_REMOTE_RESULT_INVALID",
      "The Change executor returned invalid bounded execution evidence.",
      { operation },
    );
  }
  const effects: ChangeRemoteEffectEvidence[] = [];
  for (const effect of candidate.effects) {
    if (
      typeof effect !== "object" ||
      effect === null ||
      Array.isArray(effect) ||
      Object.keys(effect).some((key) => key !== "kind" && key !== "status")
    ) {
      throw new ChangeRemoteExecutorError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "The Change executor returned invalid bounded execution evidence.",
        { operation },
      );
    }
    const entry = effect as Record<string, unknown>;
    if (!CHANGE_EFFECT_KINDS.includes(entry.kind as ChangeEffectKind)) {
      throw new ChangeRemoteExecutorError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "The Change executor returned invalid bounded execution evidence.",
        { operation },
      );
    }
    if (entry.status !== "succeeded" && entry.status !== "failed") {
      throw new ChangeRemoteExecutorError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "The Change executor returned invalid bounded execution evidence.",
        { operation },
      );
    }
    effects.push({ kind: entry.kind as ChangeEffectKind, status: entry.status });
  }
  const requester = candidate.requester === undefined ? undefined : candidate.requester;
  const issuer = candidate.issuer === undefined ? undefined : candidate.issuer;
  if ((requester !== undefined && !validText(requester, 160)) || (issuer !== undefined && !validText(issuer, 160))) {
    throw new ChangeRemoteExecutorError(
      "CHANGE_REMOTE_RESULT_INVALID",
      "The Change executor returned invalid bounded execution evidence.",
      { operation },
    );
  }
  let failure: ChangeRemoteExecutionFailureEvidence | undefined;
  if (candidate.failure !== undefined) {
    if (typeof candidate.failure !== "object" || candidate.failure === null || Array.isArray(candidate.failure)) {
      throw new ChangeRemoteExecutorError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "The Change executor returned invalid bounded execution evidence.",
        { operation },
      );
    }
    const failureValue = candidate.failure as Record<string, unknown>;
    if (
      Object.keys(failureValue).some((key) => !["kind", "code", "message"].includes(key)) ||
      !CHANGE_EFFECT_KINDS.includes(failureValue.kind as ChangeEffectKind) ||
      !validText(failureValue.code, 80) ||
      !validText(failureValue.message, 240)
    ) {
      throw new ChangeRemoteExecutorError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "The Change executor returned invalid bounded execution evidence.",
        { operation },
      );
    }
    failure = {
      kind: failureValue.kind as ChangeEffectKind,
      code: failureValue.code,
      message: failureValue.message,
    };
  }
  if (
    candidate.compensation !== undefined &&
    !["not-required", "succeeded", "failed"].includes(candidate.compensation as string)
  ) {
    throw new ChangeRemoteExecutorError(
      "CHANGE_REMOTE_RESULT_INVALID",
      "The Change executor returned invalid bounded execution evidence.",
      { operation },
    );
  }
  return {
    version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
    operation: operation as ChangeRemoteMutation,
    outcome: candidate.outcome as ChangeRemoteExecutionOutcome,
    ...(requester === undefined ? {} : { requester }),
    ...(issuer === undefined ? {} : { issuer }),
    effects: Object.freeze(effects),
    ...(candidate.compensation === undefined
      ? {}
      : { compensation: candidate.compensation as "not-required" | "succeeded" | "failed" }),
    ...(failure === undefined ? {} : { failure }),
  };
}

function normalizeExecutionResult(operation: string, result: unknown): ChangeRemoteExecutionResult {
  if (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    Object.prototype.hasOwnProperty.call(result, "projection")
  ) {
    const envelope = result as Record<string, unknown>;
    const projection = normalizeProjection(operation, envelope.projection);
    const evidence =
      envelope.evidence === undefined ? undefined : normalizeExecutionEvidence(operation, envelope.evidence);
    return Object.freeze({
      projection,
      ...(evidence === undefined ? {} : { evidence }),
    });
  }
  return { projection: normalizeProjection(operation, result) };
}

export function changeRemoteMutationRequest(
  operation: ChangeRemoteMutation,
  issue: number,
  requester?: string,
): ChangeRemoteMutationRequest {
  const request: ChangeRemoteMutationRequest = {
    version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
    operation,
    issue,
    ...(requester === undefined ? {} : { requester }),
  };
  validateRequest(request);
  return request;
}

export function changeRemoteReadRequest(issue: number, requester?: string): ChangeRemoteReadRequest {
  const request: ChangeRemoteReadRequest = {
    version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
    operation: "show",
    issue,
    ...(requester === undefined ? {} : { requester }),
  };
  validateRequest(request);
  return request;
}

export async function executeChangeRemoteMutation(
  executor: ChangeRemoteExecutor,
  request: ChangeRemoteMutationRequest,
): Promise<ChangeProjectionResult> {
  validateRequest(request);
  return (await executeChangeRemoteMutationResult(executor, request)).projection;
}

export async function executeChangeRemoteMutationResult(
  executor: ChangeRemoteExecutor,
  request: ChangeRemoteMutationRequest,
): Promise<ChangeRemoteExecutionResult> {
  validateRequest(request);
  return normalizeExecutionResult(request.operation, await executor.execute(request));
}

export async function readChangeRemoteProjection(
  executor: ChangeRemoteExecutor,
  request: ChangeRemoteReadRequest,
): Promise<ChangeProjectionResult> {
  validateRequest(request);
  return normalizeProjection(request.operation, await executor.read(request));
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
