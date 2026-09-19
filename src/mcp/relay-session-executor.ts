/**
 * Hosted-MCP adapter for the Repository Relay.
 *
 * This module is a transport adapter only.  It reads the two canonical
 * Session-envelope fields needed to route a job, forwards the original
 * envelope by reference, and returns the Runtime's canonical execution
 * result.  Session authentication and capability admission remain the
 * Runtime executor's responsibility.
 */

import {
  MAX_RELAY_DEADLINE_MS,
  normalizeRelayEnvelope,
  normalizeRelayRepositoryIdentity,
  type RelayEnvelope,
  type RelayRepositoryIdentity,
  type RelayResultEnvelope,
} from "../relay/contract.js";
import { decodeSessionCertificateCompact } from "../agent-authority/session-certificate.js";
import type {
  CapabilityAuthorizedSessionExecutionFailure,
  CapabilityAuthorizedSessionExecutionResult,
  CapabilityAuthorizedSessionExecutor,
  CapabilityAuthorizedSessionOperation,
} from "../session-authorized-change-executor.js";

export const RELAY_SESSION_EXECUTOR_VERSION = 1 as const;

export const RELAY_SESSION_EXECUTOR_ERROR_CODES = Object.freeze([
  "RELAY_SESSION_INVALID_ENVELOPE",
  "RELAY_SESSION_REPOSITORY_MISMATCH",
  "RELAY_SESSION_SIGNER_MISMATCH",
  "RELAY_SESSION_UNAVAILABLE",
  "RELAY_SESSION_TIMEOUT",
  "RELAY_SESSION_AMBIGUOUS_DELIVERY",
  "RELAY_SESSION_MALFORMED_RESULT",
] as const);
export type RelaySessionExecutorErrorCode = (typeof RELAY_SESSION_EXECUTOR_ERROR_CODES)[number];

/** A dispatch request contains routing metadata and the exact caller value. */
export interface RepositoryRelayDispatchRequest {
  readonly repository: RelayRepositoryIdentity;
  /** Immutable signer binding decoded from the canonical Session certificate. */
  readonly certificateSigner: string;
  /** Compatibility name for relay implementations that call this identity a Delegator. */
  readonly delegatorId: string;
  /** The original signed envelope; this reference is never rewritten. */
  readonly envelope: unknown;
  readonly signedSessionEnvelope: unknown;
}

/** A Relay implementation returns one contract envelope, not provider data. */
export interface RepositoryRelayDispatchPort {
  dispatch(
    request: RepositoryRelayDispatchRequest,
    signal?: AbortSignal,
  ): Promise<RelayEnvelope | { readonly envelope: RelayEnvelope }>;
}

export interface RelaySessionExecutorOptions {
  /** The immutable repository partition selected by the embedding. */
  readonly repository: RelayRepositoryIdentity;
  readonly dispatch: RepositoryRelayDispatchPort;
  /** Optional fixed Delegator binding for this Hosted-MCP relay connection. */
  readonly expectedCertificateSigner?: string;
  /** Defaults to the relay contract deadline. */
  readonly timeoutMs?: number;
}

export interface RelaySessionExecutionFailure extends CapabilityAuthorizedSessionExecutionFailure {
  readonly code: "SESSION_EXECUTION_FAILED";
  readonly relayCode: RelaySessionExecutorErrorCode;
}

export type RelaySessionExecutionResult = Omit<CapabilityAuthorizedSessionExecutionResult, "failure"> & {
  readonly failure?: RelaySessionExecutionFailure;
};

export class RelaySessionExecutorError extends TypeError {
  readonly code: RelaySessionExecutorErrorCode;

  constructor(code: RelaySessionExecutorErrorCode, message: string) {
    super(message);
    this.name = "RelaySessionExecutorError";
    this.code = code;
  }
}

const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const SIGNER_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const OPERATION_VALUES = new Set<CapabilityAuthorizedSessionOperation>([
  "change.issue",
  "change.show",
  "change.ready",
  "change.abort",
  "change.merge",
  "branch.advance",
]);
const FORBIDDEN_SECRET_KEY = /(?:private.?key|secret|credential|password|token|authorization|bearer)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownString(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? (value[key] as string) : undefined;
}

function validateOptions(options: RelaySessionExecutorOptions): {
  readonly repository: RelayRepositoryIdentity;
  readonly dispatch: RepositoryRelayDispatchPort;
  readonly expectedCertificateSigner?: string;
  readonly timeoutMs: number;
} {
  if (!isRecord(options) || !isRecord(options.repository) || !isRecord(options.dispatch)) {
    throw new TypeError("Relay Session executor configuration is invalid.");
  }
  const repository = normalizeRelayRepositoryIdentity(options.repository);
  if (typeof options.dispatch.dispatch !== "function") {
    throw new TypeError("Repository Relay dispatch port is invalid.");
  }
  const signer = options.expectedCertificateSigner;
  if (signer !== undefined && (typeof signer !== "string" || !SIGNER_PATTERN.test(signer))) {
    throw new TypeError("Expected certificate signer is invalid.");
  }
  const timeoutMs = options.timeoutMs ?? MAX_RELAY_DEADLINE_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RELAY_DEADLINE_MS) {
    throw new TypeError("Relay Session executor timeout is outside the bounded relay deadline.");
  }
  return { repository, dispatch: options.dispatch, expectedCertificateSigner: signer, timeoutMs };
}

function failure(
  code: RelaySessionExecutorErrorCode,
  phase: CapabilityAuthorizedSessionExecutionFailure["phase"],
  message: string,
): RelaySessionExecutionResult {
  return {
    version: 1,
    status: "failed",
    failure: { code: "SESSION_EXECUTION_FAILED", relayCode: code, phase, message },
  };
}

function routeEnvelope(
  envelope: unknown,
  repository: RelayRepositoryIdentity,
  expectedCertificateSigner: string | undefined,
): { readonly certificateSigner: string } {
  if (!isRecord(envelope))
    throw new RelaySessionExecutorError("RELAY_SESSION_INVALID_ENVELOPE", "Session envelope is invalid.");
  const repositoryId = ownString(envelope, "repositoryId");
  const certificate = ownString(envelope, "certificate");
  if (repositoryId === undefined || !REPOSITORY_ID_PATTERN.test(repositoryId) || certificate === undefined) {
    throw new RelaySessionExecutorError(
      "RELAY_SESSION_INVALID_ENVELOPE",
      "Session envelope routing fields are invalid.",
    );
  }
  if (repositoryId !== repository.repositoryId) {
    throw new RelaySessionExecutorError(
      "RELAY_SESSION_REPOSITORY_MISMATCH",
      "Session envelope targets another repository.",
    );
  }
  const decoded = decodeSessionCertificateCompact(certificate);
  if (!decoded.valid || decoded.value === undefined) {
    throw new RelaySessionExecutorError(
      "RELAY_SESSION_INVALID_ENVELOPE",
      "Session certificate is structurally invalid.",
    );
  }
  if (decoded.value.payload.repository.id !== repositoryId) {
    throw new RelaySessionExecutorError(
      "RELAY_SESSION_REPOSITORY_MISMATCH",
      "Session certificate targets another repository.",
    );
  }
  const signer = decoded.value.header.kid;
  if (!SIGNER_PATTERN.test(signer)) {
    throw new RelaySessionExecutorError("RELAY_SESSION_INVALID_ENVELOPE", "Session certificate signer is invalid.");
  }
  if (expectedCertificateSigner !== undefined && signer !== expectedCertificateSigner) {
    throw new RelaySessionExecutorError(
      "RELAY_SESSION_SIGNER_MISMATCH",
      "Session certificate signer is not bound to this relay.",
    );
  }
  return { certificateSigner: signer };
}

function containsSecretKey(value: unknown, seen = new Set<object>()): boolean {
  if (!isRecord(value) && !Array.isArray(value)) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_SECRET_KEY.test(key) || containsSecretKey(item, seen)) return true;
    }
    return false;
  }
  return value.some((item) => containsSecretKey(item, seen));
}

function normalizeRuntimeResult(value: unknown): CapabilityAuthorizedSessionExecutionResult {
  if (!isRecord(value))
    throw new RelaySessionExecutorError("RELAY_SESSION_MALFORMED_RESULT", "Runtime result is invalid.");
  const allowed = new Set([
    "version",
    "operation",
    "status",
    "projection",
    "execution",
    "branchAdvance",
    "provenance",
    "failure",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || value.version !== 1) {
    throw new RelaySessionExecutorError("RELAY_SESSION_MALFORMED_RESULT", "Runtime result is not canonical.");
  }
  if (value.status !== "succeeded" && value.status !== "failed") {
    throw new RelaySessionExecutorError("RELAY_SESSION_MALFORMED_RESULT", "Runtime result status is invalid.");
  }
  if (
    value.operation !== undefined &&
    (typeof value.operation !== "string" ||
      !OPERATION_VALUES.has(value.operation as CapabilityAuthorizedSessionOperation))
  ) {
    throw new RelaySessionExecutorError("RELAY_SESSION_MALFORMED_RESULT", "Runtime result operation is invalid.");
  }
  if (containsSecretKey(value)) {
    throw new RelaySessionExecutorError(
      "RELAY_SESSION_MALFORMED_RESULT",
      "Runtime result contains forbidden credential material.",
    );
  }
  if (value.status === "failed" && !isRecord(value.failure)) {
    throw new RelaySessionExecutorError(
      "RELAY_SESSION_MALFORMED_RESULT",
      "Failed Runtime result has no bounded failure.",
    );
  }
  return value as unknown as CapabilityAuthorizedSessionExecutionResult;
}

function decodeResultPayload(envelope: RelayResultEnvelope): CapabilityAuthorizedSessionExecutionResult {
  try {
    const bytes = Buffer.from(envelope.resultPayload, "base64url");
    if (bytes.length === 0) throw new Error("empty");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return normalizeRuntimeResult(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof RelaySessionExecutorError) throw error;
    throw new RelaySessionExecutorError("RELAY_SESSION_MALFORMED_RESULT", "Relay result payload is malformed.");
  }
}

function unwrapRelayEnvelope(value: unknown): RelayEnvelope {
  if (isRecord(value) && "envelope" in value) return value.envelope as RelayEnvelope;
  return value as RelayEnvelope;
}

function mapRelayResponse(
  value: unknown,
  repository: RelayRepositoryIdentity,
): CapabilityAuthorizedSessionExecutionResult {
  let envelope: RelayEnvelope;
  try {
    envelope = normalizeRelayEnvelope(unwrapRelayEnvelope(value), repository);
  } catch {
    throw new RelaySessionExecutorError(
      "RELAY_SESSION_MALFORMED_RESULT",
      "Relay response is not a valid contract envelope.",
    );
  }
  if (envelope.kind === "control") {
    if (envelope.deliveryState === "delivered-ambiguous") {
      throw new RelaySessionExecutorError(
        "RELAY_SESSION_AMBIGUOUS_DELIVERY",
        "Relay delivery is ambiguous and requires recovery.",
      );
    }
    if (envelope.deliveryState === "unavailable") {
      throw new RelaySessionExecutorError("RELAY_SESSION_UNAVAILABLE", "Repository Relay is unavailable.");
    }
    throw new RelaySessionExecutorError("RELAY_SESSION_TIMEOUT", "Relay delivery expired before a Runtime result.");
  }
  if (envelope.kind !== "result") {
    throw new RelaySessionExecutorError("RELAY_SESSION_MALFORMED_RESULT", "Relay response is not a terminal result.");
  }
  return decodeResultPayload(envelope);
}

export class RelayBackedSessionExecutor implements CapabilityAuthorizedSessionExecutor {
  readonly #repository: RelayRepositoryIdentity;
  readonly #dispatch: RepositoryRelayDispatchPort;
  readonly #expectedCertificateSigner?: string;
  readonly #timeoutMs: number;

  constructor(options: RelaySessionExecutorOptions) {
    const validated = validateOptions(options);
    this.#repository = validated.repository;
    this.#dispatch = validated.dispatch;
    this.#expectedCertificateSigner = validated.expectedCertificateSigner;
    this.#timeoutMs = validated.timeoutMs;
  }

  async execute(envelope: unknown): Promise<RelaySessionExecutionResult> {
    let route: { readonly certificateSigner: string };
    try {
      route = routeEnvelope(envelope, this.#repository, this.#expectedCertificateSigner);
    } catch (error) {
      if (error instanceof RelaySessionExecutorError) return failure(error.code, "request", error.message);
      return failure("RELAY_SESSION_INVALID_ENVELOPE", "request", "Session envelope is invalid.");
    }

    const request: RepositoryRelayDispatchRequest = Object.freeze({
      repository: this.#repository,
      certificateSigner: route.certificateSigner,
      delegatorId: route.certificateSigner,
      envelope,
      signedSessionEnvelope: envelope,
    });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new RelaySessionExecutorError("RELAY_SESSION_TIMEOUT", "Repository Relay request timed out."));
        }, this.#timeoutMs);
      });
      const response = await Promise.race([this.#dispatch.dispatch(request, controller.signal), timeout]);
      return mapRelayResponse(response, this.#repository) as RelaySessionExecutionResult;
    } catch (error) {
      if (error instanceof RelaySessionExecutorError) {
        if (error.code === "RELAY_SESSION_TIMEOUT") {
          return failure(
            "RELAY_SESSION_AMBIGUOUS_DELIVERY",
            "recovery-required",
            "Repository Relay timed out after dispatch; delivery certainty requires recovery.",
          );
        }
        const phase = error.code === "RELAY_SESSION_AMBIGUOUS_DELIVERY" ? "recovery-required" : "execution";
        return failure(error.code, phase, error.message);
      }
      return failure("RELAY_SESSION_UNAVAILABLE", "execution", "Repository Relay request failed closed.");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export function createRelayBackedSessionExecutor(options: RelaySessionExecutorOptions): RelayBackedSessionExecutor {
  return new RelayBackedSessionExecutor(options);
}

export const createRepositoryRelaySessionExecutor = createRelayBackedSessionExecutor;
