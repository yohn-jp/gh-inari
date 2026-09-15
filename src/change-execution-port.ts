import {
  CHANGE_EFFECT_KINDS,
  CHANGE_IMPLEMENTED_TRANSITIONS,
  CHANGE_TRANSITION_CONTRACT_VERSION,
  MAX_CHANGE_COMMIT_SHA_LENGTH,
  normalizeChangeEffectFailureClassification,
  validateChangeProjectionResult,
  type ChangeDiagnostic,
  type ChangeEffectFailureClassification,
  type ChangeEffectKind,
  type ChangeProjectionResult,
} from "./change.js";
import { isSecretSafeBoundedText } from "./change-failure-diagnostics.js";
import { validateChangeProvenanceRecord, type SignedChangeProvenanceRecord } from "./change-provenance-record.js";

/** Version of the transport-neutral semantic request boundary. */
export const CHANGE_EXECUTION_PORT_CONTRACT_VERSION = CHANGE_TRANSITION_CONTRACT_VERSION;
/**
 * Default bounded budget for one transport-backed Change mutation. The
 * execution port owns this budget; callers and coordination harnesses must
 * not duplicate knowledge of the transport's polling strategy.
 */
export const DEFAULT_CHANGE_EXECUTION_DEADLINE_MS = 240_000 as const;
const MAX_SEMANTIC_PULL_REQUEST_PLAN_BYTES = 1_048_576;
export const MAX_CHANGE_EXECUTION_EVIDENCE_BYTES = 16_384 as const;

/** Absolute deadline shared by every nested operation in one execution. */
export interface ChangeExecutionDeadline {
  readonly startedAt: number;
  readonly expiresAt: number;
  /** Remaining budget at the clock owned by the transport boundary. */
  readonly remainingMs: () => number;
}

/** Create one bounded execution deadline from a single transport-owned budget. */
export function createChangeExecutionDeadline(
  maxWaitMs: number = DEFAULT_CHANGE_EXECUTION_DEADLINE_MS,
  now: () => number = () => Date.now(),
): ChangeExecutionDeadline {
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1) {
    throw new RangeError("Change execution deadline must be a positive safe integer.");
  }
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new RangeError("Change execution deadline requires a finite clock value.");
  }
  const expiresAt = startedAt + maxWaitMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new RangeError("Change execution deadline exceeds the safe clock range.");
  }
  return Object.freeze({
    startedAt,
    expiresAt,
    remainingMs: () => Math.max(0, expiresAt - now()),
  });
}

export const CHANGE_EXECUTION_MUTATIONS = CHANGE_IMPLEMENTED_TRANSITIONS;
export type ChangeMutation = (typeof CHANGE_EXECUTION_MUTATIONS)[number];

export interface ChangeExecutionPortOptions {
  /** Repository-local working directory used by a port implementation. */
  readonly cwd: string;
  /** Optional repository locator selected by the caller's normal CLI option. */
  readonly repository?: string;
}

interface ChangeRequestBase {
  readonly version: typeof CHANGE_EXECUTION_PORT_CONTRACT_VERSION;
  readonly issue: number;
}

export interface ChangeMutationRequest extends ChangeRequestBase {
  readonly operation: ChangeMutation;
  /** Core-produced PR plan; validated again inside trusted execution. */
  readonly semanticPullRequestPlan?: unknown;
  /** Caller-produced Runtime-signed provenance for fresh Change issuance. */
  readonly signedProvenanceRecord?: SignedChangeProvenanceRecord;
}

export interface ChangeReadRequest extends ChangeRequestBase {
  readonly operation: "show";
}

/** Bounded evidence emitted by a trusted Executor, never a raw API result. */
export interface ChangeEffectEvidence {
  readonly kind: ChangeEffectKind;
  readonly status: "succeeded" | "failed";
  readonly createdCommitSha?: string;
}

export const CHANGE_EXECUTION_OUTCOMES = Object.freeze([
  "verified",
  "returned-existing",
  "compensated",
  "recovery-required",
  "failed",
] as const);
export type ChangeExecutionOutcome = (typeof CHANGE_EXECUTION_OUTCOMES)[number];

export interface ChangeExecutionFailureEvidence {
  readonly kind: ChangeEffectKind;
  readonly code: string;
  readonly message: string;
  readonly reason?: ChangeEffectFailureClassification["reason"];
  readonly status?: number;
  readonly provider?: ChangeEffectFailureClassification["provider"];
}

export interface ChangeExecutionEvidence {
  readonly version: typeof CHANGE_EXECUTION_PORT_CONTRACT_VERSION;
  readonly operation: ChangeMutation;
  readonly outcome: ChangeExecutionOutcome;
  readonly requester?: string;
  readonly issuer?: string;
  readonly effects: readonly ChangeEffectEvidence[];
  readonly compensation?: "not-required" | "succeeded" | "failed";
  /** The bounded failure of the compensation effect, when cleanup failed. */
  readonly compensationFailure?: ChangeExecutionFailureEvidence;
  readonly failure?: ChangeExecutionFailureEvidence;
}

/** Projection plus bounded execution provenance; transport details stay out. */
export interface ChangeExecutionResult {
  readonly projection: ChangeProjectionResult;
  readonly evidence?: ChangeExecutionEvidence;
}

/**
 * The CLI talks to this semantic boundary only. Implementations may use an
 * Action, service, App event handler, or another transport; none of those
 * details are part of the request or result contract.
 */
export interface ChangeExecutionPort {
  execute(request: ChangeMutationRequest): Promise<ChangeProjectionResult | ChangeExecutionResult>;
  read(request: ChangeReadRequest): Promise<ChangeProjectionResult>;
}

/** Compatibility aliases for library callers naming the same boundary. */
/** @deprecated Use `ChangeExecutionPort`. */
export type RemoteChangeExecutor = ChangeExecutionPort;
/** @deprecated Use `ChangeExecutionPort`; this alias predates the port naming. */
export type ChangeExecutor = ChangeExecutionPort;

export type ChangeExecutionPortErrorCode =
  | "CHANGE_REMOTE_REQUEST_INVALID"
  | "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE"
  | "CHANGE_REMOTE_TRANSPORT_FAILED"
  | "CHANGE_REMOTE_DISPATCH_FAILED"
  | "CHANGE_REMOTE_RUN_FAILED"
  | "CHANGE_REMOTE_CORRELATION_FAILED"
  | "CHANGE_REMOTE_RESULT_INVALID";

export class ChangeExecutionPortError extends Error {
  readonly code: ChangeExecutionPortErrorCode;
  readonly details?: unknown;
  readonly diagnostics?: readonly ChangeDiagnostic[];

  constructor(
    code: ChangeExecutionPortErrorCode,
    message: string,
    details?: unknown,
    diagnostics?: readonly ChangeDiagnostic[],
  ) {
    super(message);
    this.name = "ChangeExecutionPortError";
    this.code = code;
    this.details = details;
    this.diagnostics = diagnostics;
  }
}

function assertIssueNumber(issue: number): void {
  if (!Number.isSafeInteger(issue) || issue < 1) {
    throw new ChangeExecutionPortError(
      "CHANGE_REMOTE_REQUEST_INVALID",
      "A Change request requires a positive Issue number.",
      { issue },
    );
  }
}

function assertMutation(operation: string): asserts operation is ChangeMutation {
  if (!CHANGE_EXECUTION_MUTATIONS.includes(operation as ChangeMutation)) {
    throw new ChangeExecutionPortError("CHANGE_REMOTE_REQUEST_INVALID", `Unsupported Change mutation "${operation}".`, {
      operation,
    });
  }
}

/**
 * Requester provenance is an output of trusted execution, never caller input.
 * Check the prototype chain as well as own properties so a legacy field cannot
 * be smuggled through a request object with an inherited property.
 */
export function hasCallerSuppliedRequester(request: unknown): boolean {
  return typeof request === "object" && request !== null && !Array.isArray(request) && "requester" in request;
}

export function validateChangeRequest(
  request: ChangeMutationRequest | ChangeReadRequest,
): ChangeMutationRequest | ChangeReadRequest {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new ChangeExecutionPortError("CHANGE_REMOTE_REQUEST_INVALID", "A Change request must be an object.");
  }
  if (hasCallerSuppliedRequester(request)) {
    throw new ChangeExecutionPortError(
      "CHANGE_REMOTE_REQUEST_INVALID",
      "Caller-supplied requester identity is not accepted by the Change request contract.",
      { issue: request.issue, path: "$.requester" },
    );
  }
  if (request.version !== CHANGE_EXECUTION_PORT_CONTRACT_VERSION) {
    throw new ChangeExecutionPortError(
      "CHANGE_REMOTE_REQUEST_INVALID",
      "Change remote request contract version is unsupported.",
      { version: request.version },
    );
  }
  assertIssueNumber(request.issue);
  if (request.operation !== "show" && request.semanticPullRequestPlan !== undefined) {
    if (request.operation !== "issue") {
      throw new ChangeExecutionPortError(
        "CHANGE_REMOTE_REQUEST_INVALID",
        "A Semantic PR plan is accepted only for Change issuance.",
        { issue: request.issue },
      );
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(request.semanticPullRequestPlan);
    } catch {
      throw new ChangeExecutionPortError(
        "CHANGE_REMOTE_REQUEST_INVALID",
        "A Semantic PR plan must be JSON-serializable.",
        { issue: request.issue },
      );
    }
    if (serialized === undefined || serialized.length > MAX_SEMANTIC_PULL_REQUEST_PLAN_BYTES) {
      throw new ChangeExecutionPortError(
        "CHANGE_REMOTE_REQUEST_INVALID",
        "A Semantic PR plan exceeds the bounded request size.",
        { issue: request.issue },
      );
    }
  }
  if (request.operation !== "show" && request.signedProvenanceRecord !== undefined) {
    if (request.operation !== "issue") {
      throw new ChangeExecutionPortError(
        "CHANGE_REMOTE_REQUEST_INVALID",
        "Signed provenance is accepted only for Change issuance.",
        { issue: request.issue },
      );
    }
    const validation = validateChangeProvenanceRecord(request.signedProvenanceRecord);
    if (!validation.valid || validation.record === undefined) {
      throw new ChangeExecutionPortError("CHANGE_REMOTE_REQUEST_INVALID", "Signed Change provenance is invalid.", {
        issue: request.issue,
      });
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(validation.record);
    } catch {
      throw new ChangeExecutionPortError(
        "CHANGE_REMOTE_REQUEST_INVALID",
        "Signed Change provenance must be JSON-serializable.",
        { issue: request.issue },
      );
    }
    if (serialized === undefined || serialized.length > 16_384) {
      throw new ChangeExecutionPortError(
        "CHANGE_REMOTE_REQUEST_INVALID",
        "Signed Change provenance exceeds the bounded request size.",
        { issue: request.issue },
      );
    }
  }
  if (request.operation !== "show") assertMutation(request.operation);
  return request;
}

export function normalizeChangeProjection(operation: string, result: unknown): ChangeProjectionResult {
  const validation = validateChangeProjectionResult(result);
  if (!validation.valid || validation.projection === undefined) {
    throw new ChangeExecutionPortError(
      "CHANGE_REMOTE_RESULT_INVALID",
      "The Change executor returned an invalid bounded projection.",
      { operation },
      validation.diagnostics,
    );
  }
  return validation.projection;
}

export function normalizeChangeExecutionEvidence(operation: string, value: unknown): ChangeExecutionEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ChangeExecutionPortError(
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
    "compensationFailure",
    "failure",
  ]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    throw new ChangeExecutionPortError(
      "CHANGE_REMOTE_RESULT_INVALID",
      "The Change executor returned invalid bounded execution evidence.",
      { operation },
    );
  }
  if (
    candidate.version !== CHANGE_EXECUTION_PORT_CONTRACT_VERSION ||
    candidate.operation !== operation ||
    !CHANGE_EXECUTION_MUTATIONS.includes(operation as ChangeMutation) ||
    !CHANGE_EXECUTION_OUTCOMES.includes(candidate.outcome as ChangeExecutionOutcome) ||
    !Array.isArray(candidate.effects) ||
    candidate.effects.length > 8
  ) {
    throw new ChangeExecutionPortError(
      "CHANGE_REMOTE_RESULT_INVALID",
      "The Change executor returned invalid bounded execution evidence.",
      { operation },
    );
  }
  const effects: ChangeEffectEvidence[] = [];
  for (const effect of candidate.effects) {
    if (
      typeof effect !== "object" ||
      effect === null ||
      Array.isArray(effect) ||
      Object.keys(effect).some((key) => key !== "kind" && key !== "status" && key !== "createdCommitSha")
    ) {
      throw new ChangeExecutionPortError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "The Change executor returned invalid bounded execution evidence.",
        { operation },
      );
    }
    const entry = effect as Record<string, unknown>;
    if (!CHANGE_EFFECT_KINDS.includes(entry.kind as ChangeEffectKind)) {
      throw new ChangeExecutionPortError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "The Change executor returned invalid bounded execution evidence.",
        { operation },
      );
    }
    if (entry.status !== "succeeded" && entry.status !== "failed") {
      throw new ChangeExecutionPortError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "The Change executor returned invalid bounded execution evidence.",
        { operation },
      );
    }
    let createdCommitSha: string | undefined;
    if (Object.prototype.hasOwnProperty.call(entry, "createdCommitSha")) {
      if (
        (entry.kind !== "CREATE_BRANCH" && entry.kind !== "CREATE_PROVENANCE_COMMIT") ||
        entry.status !== "succeeded"
      ) {
        throw new ChangeExecutionPortError(
          "CHANGE_REMOTE_RESULT_INVALID",
          "The Change executor returned invalid bounded execution evidence.",
          { operation },
        );
      }
      if (
        typeof entry.createdCommitSha !== "string" ||
        entry.createdCommitSha.length !== MAX_CHANGE_COMMIT_SHA_LENGTH ||
        !/^[0-9a-f]{40}$/iu.test(entry.createdCommitSha)
      ) {
        throw new ChangeExecutionPortError(
          "CHANGE_REMOTE_RESULT_INVALID",
          "The Change executor returned invalid bounded execution evidence.",
          { operation },
        );
      }
      createdCommitSha = entry.createdCommitSha.toLowerCase();
    }
    effects.push({
      kind: entry.kind as ChangeEffectKind,
      status: entry.status,
      ...(createdCommitSha === undefined ? {} : { createdCommitSha }),
    });
  }
  const requester = candidate.requester === undefined ? undefined : candidate.requester;
  const issuer = candidate.issuer === undefined ? undefined : candidate.issuer;
  if (
    (requester !== undefined && !isSecretSafeBoundedText(requester, 160)) ||
    (issuer !== undefined && !isSecretSafeBoundedText(issuer, 160))
  ) {
    throw new ChangeExecutionPortError(
      "CHANGE_REMOTE_RESULT_INVALID",
      "The Change executor returned invalid bounded execution evidence.",
      { operation },
    );
  }
  function normalizeFailure(value: unknown): ChangeExecutionFailureEvidence {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ChangeExecutionPortError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "The Change executor returned invalid bounded execution evidence.",
        { operation },
      );
    }
    const failureValue = value as Record<string, unknown>;
    if (
      Object.keys(failureValue).some(
        (key) => !["kind", "code", "message", "reason", "status", "provider"].includes(key),
      ) ||
      !CHANGE_EFFECT_KINDS.includes(failureValue.kind as ChangeEffectKind) ||
      !isSecretSafeBoundedText(failureValue.code, 80) ||
      !isSecretSafeBoundedText(failureValue.message, 240)
    ) {
      throw new ChangeExecutionPortError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "The Change executor returned invalid bounded execution evidence.",
        { operation },
      );
    }
    let classification: ChangeEffectFailureClassification | undefined;
    try {
      classification =
        failureValue.reason === undefined && failureValue.status === undefined && failureValue.provider === undefined
          ? undefined
          : normalizeChangeEffectFailureClassification({
              ...(failureValue.reason === undefined ? {} : { reason: failureValue.reason }),
              ...(failureValue.status === undefined ? {} : { status: failureValue.status }),
              ...(failureValue.provider === undefined ? {} : { provider: failureValue.provider }),
            });
    } catch {
      throw new ChangeExecutionPortError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "The Change executor returned invalid bounded execution evidence.",
        { operation },
      );
    }
    return {
      kind: failureValue.kind as ChangeEffectKind,
      code: failureValue.code,
      message: failureValue.message,
      ...(classification === undefined ? {} : classification),
    };
  }
  const failure = candidate.failure === undefined ? undefined : normalizeFailure(candidate.failure);
  const compensationFailure =
    candidate.compensationFailure === undefined ? undefined : normalizeFailure(candidate.compensationFailure);
  if (
    candidate.compensation !== undefined &&
    !["not-required", "succeeded", "failed"].includes(candidate.compensation as string)
  ) {
    throw new ChangeExecutionPortError(
      "CHANGE_REMOTE_RESULT_INVALID",
      "The Change executor returned invalid bounded execution evidence.",
      { operation },
    );
  }
  const normalized = {
    version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
    operation: operation as ChangeMutation,
    outcome: candidate.outcome as ChangeExecutionOutcome,
    ...(requester === undefined ? {} : { requester }),
    ...(issuer === undefined ? {} : { issuer }),
    effects: Object.freeze(effects),
    ...(candidate.compensation === undefined
      ? {}
      : { compensation: candidate.compensation as "not-required" | "succeeded" | "failed" }),
    ...(compensationFailure === undefined ? {} : { compensationFailure }),
    ...(failure === undefined ? {} : { failure }),
  };
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > MAX_CHANGE_EXECUTION_EVIDENCE_BYTES) {
    throw new ChangeExecutionPortError(
      "CHANGE_REMOTE_RESULT_INVALID",
      "The Change executor returned oversized bounded execution evidence.",
      { operation },
    );
  }
  return normalized;
}

export function normalizeChangeExecutionResult(operation: string, result: unknown): ChangeExecutionResult {
  if (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    Object.prototype.hasOwnProperty.call(result, "projection")
  ) {
    const envelope = result as Record<string, unknown>;
    if (Object.keys(envelope).some((key) => key !== "projection" && key !== "evidence")) {
      throw new ChangeExecutionPortError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "The Change executor returned an invalid bounded execution result.",
        { operation },
      );
    }
    const projection = normalizeChangeProjection(operation, envelope.projection);
    const evidence =
      envelope.evidence === undefined ? undefined : normalizeChangeExecutionEvidence(operation, envelope.evidence);
    return Object.freeze({
      projection,
      ...(evidence === undefined ? {} : { evidence }),
    });
  }
  return { projection: normalizeChangeProjection(operation, result) };
}

export function changeMutationRequest(
  operation: ChangeMutation,
  issue: number,
  semanticPullRequestPlan?: unknown,
  signedProvenanceRecord?: SignedChangeProvenanceRecord,
): ChangeMutationRequest {
  const request: ChangeMutationRequest = {
    version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
    operation,
    issue,
    ...(semanticPullRequestPlan === undefined ? {} : { semanticPullRequestPlan }),
    ...(signedProvenanceRecord === undefined ? {} : { signedProvenanceRecord }),
  };
  validateChangeRequest(request);
  return request;
}

export function changeReadRequest(issue: number): ChangeReadRequest {
  const request: ChangeReadRequest = {
    version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
    operation: "show",
    issue,
  };
  validateChangeRequest(request);
  return request;
}

export async function executeChangeMutation(
  executor: ChangeExecutionPort,
  request: ChangeMutationRequest,
): Promise<ChangeProjectionResult> {
  validateChangeRequest(request);
  return (await executeChangeMutationResult(executor, request)).projection;
}

export async function executeChangeMutationResult(
  executor: ChangeExecutionPort,
  request: ChangeMutationRequest,
): Promise<ChangeExecutionResult> {
  validateChangeRequest(request);
  return normalizeChangeExecutionResult(request.operation, await executor.execute(request));
}

export async function readChangeProjection(
  executor: ChangeExecutionPort,
  request: ChangeReadRequest,
): Promise<ChangeProjectionResult> {
  validateChangeRequest(request);
  return normalizeChangeProjection(request.operation, await executor.read(request));
}

/** Explicit fallback for a runtime that has no Change execution port implementation. */
export function createUnavailableChangeExecutionPort(): ChangeExecutionPort {
  const unavailable = (operation: string): never => {
    throw new ChangeExecutionPortError(
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

/**
 * Compatibility exports for callers of the pre-#548 remote-executor API.
 * These names all reference the port contract above; they do not define a
 * second contract or implementation.
 */
/** @deprecated Use `CHANGE_EXECUTION_PORT_CONTRACT_VERSION`. */
export const CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION = CHANGE_EXECUTION_PORT_CONTRACT_VERSION;
/** @deprecated Use `MAX_CHANGE_EXECUTION_EVIDENCE_BYTES`. */
export const MAX_CHANGE_REMOTE_EXECUTION_EVIDENCE_BYTES = MAX_CHANGE_EXECUTION_EVIDENCE_BYTES;
/** @deprecated Use `CHANGE_EXECUTION_MUTATIONS`. */
export const CHANGE_REMOTE_MUTATIONS = CHANGE_EXECUTION_MUTATIONS;
/** @deprecated Use `CHANGE_EXECUTION_OUTCOMES`. */
export const CHANGE_REMOTE_EXECUTION_OUTCOMES = CHANGE_EXECUTION_OUTCOMES;

/** @deprecated Use `ChangeMutation`. */
export type ChangeRemoteMutation = ChangeMutation;
/** @deprecated Use `ChangeExecutionPortOptions`. */
export type ChangeRemoteExecutorOptions = ChangeExecutionPortOptions;
/** @deprecated Use `ChangeMutationRequest`. */
export type ChangeRemoteMutationRequest = ChangeMutationRequest;
/** @deprecated Use `ChangeReadRequest`. */
export type ChangeRemoteReadRequest = ChangeReadRequest;
/** @deprecated Use `ChangeEffectEvidence`. */
export type ChangeRemoteEffectEvidence = ChangeEffectEvidence;
/** @deprecated Use `ChangeExecutionOutcome`. */
export type ChangeRemoteExecutionOutcome = ChangeExecutionOutcome;
/** @deprecated Use `ChangeExecutionFailureEvidence`. */
export type ChangeRemoteExecutionFailureEvidence = ChangeExecutionFailureEvidence;
/** @deprecated Use `ChangeExecutionEvidence`. */
export type ChangeRemoteExecutionEvidence = ChangeExecutionEvidence;
/** @deprecated Use `ChangeExecutionResult`. */
export type ChangeRemoteExecutionResult = ChangeExecutionResult;
/** @deprecated Use `ChangeExecutionPort`. */
export type ChangeRemoteExecutor = ChangeExecutionPort;
/** @deprecated Use `ChangeExecutionPortErrorCode`. */
export type ChangeRemoteExecutorErrorCode = ChangeExecutionPortErrorCode;
/** @deprecated Use `ChangeExecutionPortError`. */
export const ChangeRemoteExecutorError = ChangeExecutionPortError;
/** @deprecated Use `ChangeExecutionPortError`. */
export type ChangeRemoteExecutorError = ChangeExecutionPortError;

/** @deprecated Use `normalizeChangeProjection`. */
export const normalizeChangeRemoteProjection = normalizeChangeProjection;
/** @deprecated Use `normalizeChangeExecutionEvidence`. */
export const normalizeChangeRemoteExecutionEvidence = normalizeChangeExecutionEvidence;
/** @deprecated Use `normalizeChangeExecutionResult`. */
export const normalizeChangeRemoteExecutionResult = normalizeChangeExecutionResult;
/** @deprecated Use `changeMutationRequest`. */
export const changeRemoteMutationRequest = changeMutationRequest;
/** @deprecated Use `changeReadRequest`. */
export const changeRemoteReadRequest = changeReadRequest;
/** @deprecated Use `executeChangeMutation`. */
export const executeChangeRemoteMutation = executeChangeMutation;
/** @deprecated Use `executeChangeMutationResult`. */
export const executeChangeRemoteMutationResult = executeChangeMutationResult;
/** @deprecated Use `readChangeProjection`. */
export const readChangeRemoteProjection = readChangeProjection;
/** @deprecated Use `createUnavailableChangeExecutionPort`. */
export const createUnavailableChangeRemoteExecutor = createUnavailableChangeExecutionPort;
