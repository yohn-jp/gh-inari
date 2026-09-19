/**
 * Deterministic, deployment-neutral relay delivery lifecycle.
 *
 * This module records transport facts only. It deliberately does not accept
 * signed requests or result payloads: a terminal result is correlated by a
 * caller-provided digest, while semantic Change success remains outside the
 * relay.
 */

import { MAX_RELAY_IDENTIFIER_BYTES } from "./contract.js";

export const RELAY_DELIVERY_STATE_VERSION = 1 as const;
export type RelayDeliveryStateVersion = typeof RELAY_DELIVERY_STATE_VERSION;

export const RELAY_DELIVERY_PHASES = Object.freeze([
  "queued",
  "delivered",
  "acknowledged",
  "terminal-result",
  "possibly-delivered",
  "expired",
  "cancelled",
  "unavailable",
] as const);
export type RelayDeliveryPhase = (typeof RELAY_DELIVERY_PHASES)[number];

export const RELAY_DELIVERY_EVENT_TYPES = Object.freeze([
  "deliver",
  "acknowledge",
  "result",
  "disconnect",
  "timeout",
  "reconnect",
  "expire",
  "cancel",
] as const);
export type RelayDeliveryEventType = (typeof RELAY_DELIVERY_EVENT_TYPES)[number];

export type RelayDeliveryEvidence = "not-delivered" | "delivered" | "delivered-ambiguous";
export type RelayAutomaticRetry = "allowed" | "forbidden";
export type RelayRecoveryClassification = "none" | "recovery-required";

export interface RelayDeliveryState {
  readonly version: RelayDeliveryStateVersion;
  readonly connectionId: string;
  readonly jobId: string;
  readonly phase: RelayDeliveryPhase;
  /** Evidence about Runtime delivery, never evidence of semantic success. */
  readonly deliveryEvidence: RelayDeliveryEvidence;
  /** A later adapter may retry only when this is allowed. */
  readonly automaticRetry: RelayAutomaticRetry;
  /** Ambiguity is consumable by recovery adapters without adding Change state. */
  readonly recovery: RelayRecoveryClassification;
  /** Digest of the terminal result; the result bytes are never retained here. */
  readonly resultDigest?: string;
}

export interface RelayDeliveryEventBase {
  readonly version: RelayDeliveryStateVersion;
  readonly type: RelayDeliveryEventType;
  readonly connectionId: string;
  readonly jobId: string;
}

export type RelayDeliveryEvent =
  | (RelayDeliveryEventBase & { readonly type: "deliver" })
  | (RelayDeliveryEventBase & { readonly type: "acknowledge" })
  | (RelayDeliveryEventBase & { readonly type: "result"; readonly resultDigest: string })
  | (RelayDeliveryEventBase & {
      readonly type: "disconnect" | "timeout" | "reconnect" | "expire" | "cancel";
    });

export type RelayDeliveryTransition =
  "applied" | "duplicate-result-ignored" | "conflicting-result-ignored" | "late-event-ignored";

export interface RelayDeliveryReduction {
  readonly state: RelayDeliveryState;
  readonly transition: RelayDeliveryTransition;
}

export type RelayDeliveryStateErrorCode =
  | "RELAY_DELIVERY_INVALID_STATE"
  | "RELAY_DELIVERY_INVALID_EVENT"
  | "RELAY_DELIVERY_UNSUPPORTED_VERSION"
  | "RELAY_DELIVERY_MISMATCHED_JOB"
  | "RELAY_DELIVERY_INVALID_IDENTIFIER"
  | "RELAY_DELIVERY_INVALID_DIGEST";

export class RelayDeliveryStateError extends TypeError {
  readonly code: RelayDeliveryStateErrorCode;

  constructor(code: RelayDeliveryStateErrorCode, message: string) {
    super(message);
    this.name = "RelayDeliveryStateError";
    this.code = code;
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const DIGEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const JSON_ENCODER = new TextEncoder();

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !IDENTIFIER_PATTERN.test(value) ||
    JSON_ENCODER.encode(value).byteLength > MAX_RELAY_IDENTIFIER_BYTES
  ) {
    throw new RelayDeliveryStateError(
      "RELAY_DELIVERY_INVALID_IDENTIFIER",
      `${field} must be a bounded relay identifier.`,
    );
  }
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new RelayDeliveryStateError(
      "RELAY_DELIVERY_INVALID_DIGEST",
      "resultDigest must be a bounded digest identifier, not a result payload.",
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClosedObject(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value)
    .filter((key) => !allowedSet.has(key))
    .sort()[0];
  if (unknown !== undefined) {
    throw new RelayDeliveryStateError("RELAY_DELIVERY_INVALID_STATE", `Unknown relay delivery field "${unknown}".`);
  }
}

function phaseMetadata(
  phase: RelayDeliveryPhase,
): Pick<RelayDeliveryState, "deliveryEvidence" | "automaticRetry" | "recovery"> {
  switch (phase) {
    case "queued":
    case "unavailable":
      return { deliveryEvidence: "not-delivered", automaticRetry: "allowed", recovery: "none" };
    case "delivered":
    case "acknowledged":
    case "terminal-result":
      return { deliveryEvidence: "delivered", automaticRetry: "forbidden", recovery: "none" };
    case "possibly-delivered":
      return { deliveryEvidence: "delivered-ambiguous", automaticRetry: "forbidden", recovery: "recovery-required" };
    case "expired":
      return { deliveryEvidence: "not-delivered", automaticRetry: "allowed", recovery: "none" };
    case "cancelled":
      return { deliveryEvidence: "not-delivered", automaticRetry: "forbidden", recovery: "none" };
  }
}

function createState(
  connectionId: string,
  jobId: string,
  phase: RelayDeliveryPhase,
  resultDigest?: string,
): RelayDeliveryState {
  const metadata = phaseMetadata(phase);
  return freeze({
    version: RELAY_DELIVERY_STATE_VERSION,
    connectionId,
    jobId,
    phase,
    ...metadata,
    ...(resultDigest === undefined ? {} : { resultDigest }),
  });
}

export interface RelayDeliveryJob {
  readonly connectionId: string;
  readonly jobId: string;
}

/** Create the only initial state: the job is queued and provably undelivered. */
export function createRelayDeliveryState(job: RelayDeliveryJob): RelayDeliveryState {
  if (!isRecord(job)) {
    throw new RelayDeliveryStateError("RELAY_DELIVERY_INVALID_STATE", "A relay delivery job must be an object.");
  }
  assertClosedObject(job, ["connectionId", "jobId"]);
  return createState(identifier(job.connectionId, "connectionId"), identifier(job.jobId, "jobId"), "queued");
}

function normalizePhase(value: unknown): RelayDeliveryPhase {
  if (typeof value !== "string" || !RELAY_DELIVERY_PHASES.includes(value as RelayDeliveryPhase)) {
    throw new RelayDeliveryStateError("RELAY_DELIVERY_INVALID_STATE", "Relay delivery phase is not supported.");
  }
  return value as RelayDeliveryPhase;
}

/** Validate and canonicalize a serialized state without accepting payload data. */
export function normalizeRelayDeliveryState(input: unknown): RelayDeliveryState {
  if (!isRecord(input)) {
    throw new RelayDeliveryStateError("RELAY_DELIVERY_INVALID_STATE", "Relay delivery state must be a plain object.");
  }
  assertClosedObject(input, [
    "automaticRetry",
    "connectionId",
    "deliveryEvidence",
    "jobId",
    "phase",
    "recovery",
    "resultDigest",
    "version",
  ]);
  if (input.version !== RELAY_DELIVERY_STATE_VERSION) {
    throw new RelayDeliveryStateError(
      "RELAY_DELIVERY_UNSUPPORTED_VERSION",
      "Relay delivery state version is unsupported.",
    );
  }
  const connectionId = identifier(input.connectionId, "connectionId");
  const jobId = identifier(input.jobId, "jobId");
  const phase = normalizePhase(input.phase);
  const metadata = phaseMetadata(phase);
  if (
    input.deliveryEvidence !== metadata.deliveryEvidence ||
    input.automaticRetry !== metadata.automaticRetry ||
    input.recovery !== metadata.recovery
  ) {
    throw new RelayDeliveryStateError(
      "RELAY_DELIVERY_INVALID_STATE",
      "Relay delivery metadata does not match its transport phase.",
    );
  }
  const resultDigest = input.resultDigest === undefined ? undefined : digest(input.resultDigest);
  if (phase === "terminal-result" && resultDigest === undefined) {
    throw new RelayDeliveryStateError("RELAY_DELIVERY_INVALID_STATE", "A terminal result requires resultDigest.");
  }
  if (phase !== "terminal-result" && resultDigest !== undefined) {
    throw new RelayDeliveryStateError(
      "RELAY_DELIVERY_INVALID_STATE",
      "Only terminal-result may retain a resultDigest.",
    );
  }
  return createState(connectionId, jobId, phase, resultDigest);
}

export function serializeRelayDeliveryState(state: RelayDeliveryState): string {
  return JSON.stringify(normalizeRelayDeliveryState(state));
}

export function deserializeRelayDeliveryState(serialized: string): RelayDeliveryState {
  if (typeof serialized !== "string") {
    throw new RelayDeliveryStateError("RELAY_DELIVERY_INVALID_STATE", "Serialized relay delivery state must be text.");
  }
  try {
    return normalizeRelayDeliveryState(JSON.parse(serialized) as unknown);
  } catch (error) {
    if (error instanceof RelayDeliveryStateError) throw error;
    throw new RelayDeliveryStateError("RELAY_DELIVERY_INVALID_STATE", "Serialized relay delivery state is malformed.");
  }
}

export function normalizeRelayDeliveryEvent(input: unknown): RelayDeliveryEvent {
  if (!isRecord(input)) {
    throw new RelayDeliveryStateError("RELAY_DELIVERY_INVALID_EVENT", "Relay delivery event must be a plain object.");
  }
  assertClosedObject(input, ["connectionId", "jobId", "resultDigest", "type", "version"]);
  if (input.version !== RELAY_DELIVERY_STATE_VERSION) {
    throw new RelayDeliveryStateError(
      "RELAY_DELIVERY_UNSUPPORTED_VERSION",
      "Relay delivery event version is unsupported.",
    );
  }
  const connectionId = identifier(input.connectionId, "connectionId");
  const jobId = identifier(input.jobId, "jobId");
  if (typeof input.type !== "string" || !RELAY_DELIVERY_EVENT_TYPES.includes(input.type as RelayDeliveryEventType)) {
    throw new RelayDeliveryStateError("RELAY_DELIVERY_INVALID_EVENT", "Relay delivery event type is not supported.");
  }
  if (input.type === "result") {
    return {
      version: RELAY_DELIVERY_STATE_VERSION,
      type: "result",
      connectionId,
      jobId,
      resultDigest: digest(input.resultDigest),
    };
  }
  if (input.resultDigest !== undefined) {
    throw new RelayDeliveryStateError("RELAY_DELIVERY_INVALID_EVENT", "Only result events may carry resultDigest.");
  }
  return { version: RELAY_DELIVERY_STATE_VERSION, type: input.type, connectionId, jobId } as RelayDeliveryEvent;
}

function isTerminal(state: RelayDeliveryState): boolean {
  return state.phase === "terminal-result";
}

function transitionForTerminal(state: RelayDeliveryState, event: RelayDeliveryEvent): RelayDeliveryReduction {
  if (event.type === "result") {
    return {
      state,
      transition: event.resultDigest === state.resultDigest ? "duplicate-result-ignored" : "conflicting-result-ignored",
    };
  }
  return { state, transition: "late-event-ignored" };
}

function nextPhase(state: RelayDeliveryState, event: RelayDeliveryEvent): RelayDeliveryPhase {
  switch (event.type) {
    case "deliver":
      return state.phase === "queued" || state.phase === "unavailable" || state.phase === "expired"
        ? "delivered"
        : state.phase;
    case "acknowledge":
      return state.phase === "queued" || state.phase === "delivered" || state.phase === "possibly-delivered"
        ? "acknowledged"
        : state.phase;
    case "result":
      return "terminal-result";
    case "disconnect":
    case "timeout":
      return state.phase === "queued" || state.phase === "unavailable"
        ? "unavailable"
        : state.phase === "delivered" || state.phase === "acknowledged"
          ? "possibly-delivered"
          : state.phase;
    case "reconnect":
      return state.phase === "unavailable" ? "queued" : state.phase;
    case "expire":
      return state.phase === "queued" || state.phase === "unavailable"
        ? "expired"
        : state.phase === "delivered" || state.phase === "acknowledged"
          ? "possibly-delivered"
          : state.phase;
    case "cancel":
      return state.phase === "queued" || state.phase === "unavailable" ? "cancelled" : state.phase;
  }
}

/**
 * Apply one transport fact. Ambiguous states are sticky across reconnects and
 * never become retryable without a new, explicit proof of non-delivery.
 */
export function applyRelayDeliveryEvent(
  current: RelayDeliveryState,
  input: RelayDeliveryEvent,
): RelayDeliveryReduction {
  const state = normalizeRelayDeliveryState(current);
  const event = normalizeRelayDeliveryEvent(input);
  if (event.connectionId !== state.connectionId || event.jobId !== state.jobId) {
    throw new RelayDeliveryStateError("RELAY_DELIVERY_MISMATCHED_JOB", "Relay delivery event belongs to another job.");
  }
  if (isTerminal(state)) return transitionForTerminal(state, event);
  const phase = nextPhase(state, event);
  if (phase === state.phase) return { state, transition: "late-event-ignored" };
  return {
    state: createState(
      state.connectionId,
      state.jobId,
      phase,
      event.type === "result" ? event.resultDigest : undefined,
    ),
    transition: "applied",
  };
}

export function reduceRelayDeliveryState(current: RelayDeliveryState, event: RelayDeliveryEvent): RelayDeliveryState {
  return applyRelayDeliveryEvent(current, event).state;
}

export function isRelayDeliveryRetryable(state: RelayDeliveryState): boolean {
  return normalizeRelayDeliveryState(state).automaticRetry === "allowed";
}
