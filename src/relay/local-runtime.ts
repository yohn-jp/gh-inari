/**
 * Node-local Repository Relay Runtime.
 *
 * This adapter owns only outbound WebSocket transport, connection possession
 * proof, bounded delivery correlation, and delegation to the existing
 * Session-authorized executor.  It does not authenticate Sessions, authorize
 * capabilities, or compose provider credentials.
 */

import { createHash, type KeyObject } from "node:crypto";
import { base64UrlDecodeToBytes, base64UrlEncodeBytes } from "../agent-authority/codec.js";
import {
  decodeRelayPossessionProofChallenge,
  encodeRelayPossessionProofChallenge,
  encodeRelayPossessionProofResponse,
  signRelayPossessionProof,
} from "./connection-proof.js";
import {
  MAX_RELAY_IN_FLIGHT_JOBS,
  decodeRelayEnvelope,
  encodeRelayEnvelope,
  normalizeRelayRepositoryIdentity,
  type RelayEnvelope,
  type RelayRepositoryIdentity,
} from "./contract.js";
import {
  RELAY_DELIVERY_STATE_VERSION,
  applyRelayDeliveryEvent,
  createRelayDeliveryState,
  type RelayDeliveryEvent,
  type RelayDeliveryState,
} from "./delivery-state.js";
import type {
  CapabilityAuthorizedSessionExecutionResult,
  CapabilityAuthorizedSessionExecutor,
} from "../session-authorized-change-executor.js";

export type LocalRelayRuntimeState = "idle" | "connecting" | "connected" | "unavailable" | "shutdown";

export interface RelayWebSocketMessageEvent {
  readonly data: unknown;
}

export interface RelayWebSocketCloseEvent {
  readonly code?: number;
  readonly reason?: string;
}

/** Small injectable surface shared by Node's WebSocket and deterministic fakes. */
export interface RelayWebSocket {
  readonly readyState?: number;
  binaryType?: "blob" | "arraybuffer";
  send(data: string): void;
  close?(code?: number, reason?: string): void;
  addEventListener?(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
  removeEventListener?(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
  onopen?: ((event: unknown) => void) | null;
  onmessage?: ((event: RelayWebSocketMessageEvent) => void) | null;
  onclose?: ((event: RelayWebSocketCloseEvent) => void) | null;
  onerror?: ((event: unknown) => void) | null;
}

export type RelayWebSocketFactory = (url: string) => RelayWebSocket;

export interface LocalRelayRuntimeOptions {
  readonly relayUrl: string;
  readonly repository: RelayRepositoryIdentity;
  readonly delegatorId: string;
  readonly privateKey: KeyObject;
  readonly executor: CapabilityAuthorizedSessionExecutor;
  /** Injectable for deterministic tests; defaults to the platform WebSocket. */
  readonly webSocketFactory?: RelayWebSocketFactory;
  /** Millisecond clock used for proof and deadline calculations. */
  readonly now?: () => number;
  /** Stable connection identity permits delivery correlation across reconnects. */
  readonly connectionId?: string;
  readonly reconnectDelayMs?: number;
}

export interface LocalRelayRuntimeSnapshot {
  readonly state: LocalRelayRuntimeState;
  readonly connectionId: string;
  readonly possessionProved: boolean;
  readonly deliveries: readonly RelayDeliveryState[];
}

interface RuntimeJob {
  readonly jobId: string;
  readonly connectionId: string;
  readonly deadlineMs: number;
  readonly signedSessionRequest: string;
  state: RelayDeliveryState;
  executing: boolean;
  resultPayload?: string;
  resultDigest?: string;
  resultSentOnSocket?: RelayWebSocket;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

const OPEN_READY_STATE = 1;
const MAX_RELAY_CLOCK_SKEW_MS = 5_000;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 30_000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const RELAY_HANDSHAKE_KIND = "repository-relay-possession-challenge";
const RELAY_HANDSHAKE_RESPONSE_KIND = "repository-relay-possession-response";

function textFromFrame(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: true }).decode(data);
  if (data instanceof ArrayBuffer) return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(data));
  return undefined;
}

function isWebSocketOpen(socket: RelayWebSocket): boolean {
  return socket.readyState === undefined || socket.readyState === OPEN_READY_STATE;
}

function defaultWebSocketFactory(url: string): RelayWebSocket {
  const WebSocketConstructor = (
    globalThis as unknown as {
      WebSocket?: new (url: string) => RelayWebSocket;
    }
  ).WebSocket;
  if (typeof WebSocketConstructor !== "function") throw new TypeError("A WebSocket implementation is required.");
  return new WebSocketConstructor(url);
}

function validClock(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function jsonResult(result: CapabilityAuthorizedSessionExecutionResult): string {
  const serialized = JSON.stringify(result);
  if (serialized === undefined) throw new TypeError("Session execution result is not serializable.");
  return base64UrlEncodeBytes(new TextEncoder().encode(serialized));
}

function resultDigest(payload: string): string {
  return `sha256-${createHash("sha256").update(base64UrlDecodeToBytes(payload)).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRelayConnectedFrame(data: string): boolean {
  try {
    const candidate = JSON.parse(data) as unknown;
    return isRecord(candidate) && candidate.type === "repository-relay-connected";
  } catch {
    return false;
  }
}

function decodeRelayConnectedFrame(data: string, repository: RelayRepositoryIdentity, connectionId: string): boolean {
  let candidate: unknown;
  try {
    candidate = JSON.parse(data) as unknown;
  } catch {
    return false;
  }
  if (
    !isRecord(candidate) ||
    candidate.type !== "repository-relay-connected" ||
    candidate.version !== 1 ||
    candidate.connectionId !== connectionId
  )
    return false;
  try {
    const acknowledgedRepository = normalizeRelayRepositoryIdentity(candidate.repository);
    return (
      acknowledgedRepository.repositoryId === repository.repositoryId &&
      acknowledgedRepository.repositoryHost === repository.repositoryHost
    );
  } catch {
    return false;
  }
}

interface RelayChallengeFrame {
  readonly challenge: ReturnType<typeof decodeRelayPossessionProofChallenge>;
  readonly production: boolean;
}

function decodeRelayChallengeFrame(data: string): RelayChallengeFrame {
  let candidate: unknown;
  try {
    candidate = JSON.parse(data) as unknown;
  } catch {
    return { challenge: decodeRelayPossessionProofChallenge(data), production: false };
  }
  if (
    isRecord(candidate) &&
    candidate.type === RELAY_HANDSHAKE_KIND &&
    candidate.version === 1 &&
    isRecord(candidate.challenge)
  ) {
    return {
      challenge: decodeRelayPossessionProofChallenge(
        encodeRelayPossessionProofChallenge(
          candidate.challenge as unknown as Parameters<typeof encodeRelayPossessionProofChallenge>[0],
        ),
      ),
      production: true,
    };
  }
  return { challenge: decodeRelayPossessionProofChallenge(data), production: false };
}

function deliveryEvent(job: RuntimeJob, type: RelayDeliveryEvent["type"], digest?: string): RelayDeliveryEvent {
  return type === "result"
    ? {
        version: RELAY_DELIVERY_STATE_VERSION,
        type,
        connectionId: job.connectionId,
        jobId: job.jobId,
        resultDigest: digest!,
      }
    : { version: RELAY_DELIVERY_STATE_VERSION, type, connectionId: job.connectionId, jobId: job.jobId };
}

export class LocalRelayRuntime {
  readonly #options: LocalRelayRuntimeOptions;
  readonly #connectUrl: string;
  readonly #repository: RelayRepositoryIdentity;
  readonly #connectionId: string;
  readonly #now: () => number;
  readonly #webSocketFactory: RelayWebSocketFactory;
  readonly #reconnectDelayMs: number;
  readonly #jobs = new Map<string, RuntimeJob>();
  #socket?: RelayWebSocket;
  #state: LocalRelayRuntimeState = "idle";
  #possessionProved = false;
  #admissionPendingSocket?: RelayWebSocket;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #listeners: Array<{
    readonly type: "open" | "message" | "close" | "error";
    readonly listener: (event: unknown) => void;
  }> = [];

  constructor(options: LocalRelayRuntimeOptions) {
    if (typeof options?.relayUrl !== "string") throw new TypeError("Relay URL is required.");
    let parsed: URL;
    try {
      parsed = new URL(options.relayUrl);
    } catch {
      throw new TypeError("Relay URL is invalid.");
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new TypeError("Relay URL must use ws or wss.");
    if (!options.executor || typeof options.executor.execute !== "function")
      throw new TypeError("A Session-authorized executor is required.");
    if (
      !options.privateKey ||
      options.privateKey.type !== "private" ||
      options.privateKey.asymmetricKeyType !== "ed25519"
    )
      throw new TypeError("An Ed25519 Delegator private key is required.");
    if (typeof options.delegatorId !== "string" || !IDENTIFIER_PATTERN.test(options.delegatorId))
      throw new TypeError("Delegator id is invalid.");
    const repository = normalizeRelayRepositoryIdentity(options.repository);
    const connectionId = options.connectionId ?? options.delegatorId;
    if (!IDENTIFIER_PATTERN.test(connectionId)) throw new TypeError("Connection id is invalid.");
    const now = options.now ?? Date.now;
    if (typeof now !== "function") throw new TypeError("Runtime clock is invalid.");
    const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    if (!Number.isSafeInteger(reconnectDelayMs) || reconnectDelayMs < 0 || reconnectDelayMs > MAX_RECONNECT_DELAY_MS)
      throw new TypeError("Reconnect delay is invalid.");
    // A bare connection-base URL (e.g. "wss://HOST" with no path) does not
    // reach the hosted Worker's exact-match "/v1/relay/connect" route; the
    // upgrade is rejected before it reaches the Durable Object and this
    // Runtime silently reconnect-loops every `reconnectDelayMs` forever,
    // with no visible error. Fill in the canonical path when the caller
    // supplied none, so the common "just point me at the host" form works.
    if (parsed.pathname === "" || parsed.pathname === "/") parsed.pathname = "/v1/relay/connect";
    // The hosted Relay's WebSocket upgrade reads repositoryId/repositoryHost/
    // connectionId/delegatorId from the URL query. A `relayUrl` that already
    // carries one of these (the documented explicit form) keeps that value;
    // a bare connection-base URL is filled in here so it cannot silently
    // loop against a Relay that rejects the resulting unparameterized upgrade.
    if (!parsed.searchParams.has("repositoryId")) parsed.searchParams.set("repositoryId", repository.repositoryId);
    if (!parsed.searchParams.has("repositoryHost")) {
      parsed.searchParams.set("repositoryHost", repository.repositoryHost);
    }
    if (!parsed.searchParams.has("connectionId")) parsed.searchParams.set("connectionId", connectionId);
    if (!parsed.searchParams.has("delegatorId")) parsed.searchParams.set("delegatorId", options.delegatorId);
    this.#connectUrl = parsed.toString();
    this.#options = options;
    this.#repository = repository;
    this.#connectionId = connectionId;
    this.#now = now;
    this.#webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.#reconnectDelayMs = reconnectDelayMs;
  }

  get state(): LocalRelayRuntimeState {
    return this.#state;
  }

  get connectionId(): string {
    return this.#connectionId;
  }

  snapshot(): LocalRelayRuntimeSnapshot {
    return Object.freeze({
      state: this.#state,
      connectionId: this.#connectionId,
      possessionProved: this.#possessionProved,
      deliveries: Object.freeze([...this.#jobs.values()].map((job) => job.state)),
    });
  }

  delivery(jobId: string): RelayDeliveryState | undefined {
    return this.#jobs.get(jobId)?.state;
  }

  connect(): void {
    if (this.#state === "shutdown" || this.#socket !== undefined) return;
    this.#state = "connecting";
    this.#possessionProved = false;
    this.#admissionPendingSocket = undefined;
    const socket = this.#webSocketFactory(this.#connectUrl);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    this.#listen(socket, "open", () => this.#onOpen(socket));
    this.#listen(socket, "message", (event) => this.#onMessage(socket, event));
    this.#listen(socket, "close", () => this.#onClose(socket));
    this.#listen(socket, "error", () => this.#onClose(socket));
  }

  shutdown(): void {
    if (this.#state === "shutdown") return;
    this.#state = "shutdown";
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    for (const job of this.#jobs.values()) {
      if (job.expiryTimer !== undefined) clearTimeout(job.expiryTimer);
    }
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket?.close !== undefined) socket.close(1000, "shutdown");
  }

  #listen(
    socket: RelayWebSocket,
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ): void {
    if (socket.addEventListener !== undefined) {
      socket.addEventListener(type, listener);
      this.#listeners.push({ type, listener });
      return;
    }
    if (type === "open") socket.onopen = listener;
    else if (type === "message") socket.onmessage = listener as (event: RelayWebSocketMessageEvent) => void;
    else if (type === "close") socket.onclose = listener as (event: RelayWebSocketCloseEvent) => void;
    else socket.onerror = listener;
  }

  #onOpen(socket: RelayWebSocket): void {
    if (socket !== this.#socket || this.#state === "shutdown") return;
    this.#state = "connected";
  }

  #onMessage(socket: RelayWebSocket, event: unknown): void {
    if (socket !== this.#socket || this.#state === "shutdown") return;
    let data: string | undefined;
    try {
      data = textFromFrame((event as RelayWebSocketMessageEvent)?.data ?? event);
    } catch {
      return;
    }
    if (data === undefined) return;
    try {
      const challengeFrame = decodeRelayChallengeFrame(data);
      const challenge = challengeFrame.challenge;
      if (
        challenge.repositoryId !== this.#repository.repositoryId ||
        challenge.delegatorId !== this.#options.delegatorId
      )
        return;
      const nowMs = this.#now();
      if (
        !validClock(nowMs) ||
        challenge.issuedAtMs - nowMs > MAX_RELAY_CLOCK_SKEW_MS ||
        nowMs - challenge.expiresAtMs >= MAX_RELAY_CLOCK_SKEW_MS
      )
        return;
      const proof = signRelayPossessionProof(challenge, this.#options.privateKey);
      const encodedProof = JSON.parse(new TextDecoder().decode(encodeRelayPossessionProofResponse(proof))) as unknown;
      if (challengeFrame.production) {
        this.#admissionPendingSocket = socket;
        try {
          this.#sendRaw(
            socket,
            JSON.stringify({ type: RELAY_HANDSHAKE_RESPONSE_KIND, version: 1, proof: encodedProof }),
          );
        } catch (error) {
          this.#admissionPendingSocket = undefined;
          throw error;
        }
      } else {
        // The bare challenge is retained only for the controlled certification
        // oracle. Production Durable Object connections use the wrapped frame
        // above and cannot become admitted without its acknowledgement.
        this.#sendRaw(socket, new TextDecoder().decode(encodeRelayPossessionProofResponse(proof)));
        this.#possessionProved = true;
        this.#flushResults(socket);
      }
      return;
    } catch {
      // The same frame may be a relay envelope. Protocol errors are ignored
      // without exposing key material or executor details in diagnostics.
    }
    if (
      this.#admissionPendingSocket === socket &&
      decodeRelayConnectedFrame(data, this.#repository, this.#connectionId)
    ) {
      this.#admissionPendingSocket = undefined;
      this.#possessionProved = true;
      this.#flushResults(socket);
      return;
    }
    if (isRelayConnectedFrame(data)) return;
    let envelope: RelayEnvelope;
    try {
      envelope = decodeRelayEnvelope(data, this.#repository);
    } catch {
      return;
    }
    if (envelope.kind === "job") this.#receiveJob(socket, envelope);
    else if (envelope.kind === "control") this.#receiveControl(envelope);
  }

  #receiveJob(socket: RelayWebSocket, envelope: Extract<RelayEnvelope, { kind: "job" }>): void {
    if (!this.#possessionProved || envelope.connectionId !== this.#connectionId) return;
    const existing = this.#jobs.get(envelope.jobId);
    if (existing !== undefined) {
      this.#flushJobResult(socket, existing);
      return;
    }
    const inFlight = [...this.#jobs.values()].filter((job) => job.state.phase !== "terminal-result").length;
    if (inFlight >= MAX_RELAY_IN_FLIGHT_JOBS) return;
    const job: RuntimeJob = {
      jobId: envelope.jobId,
      connectionId: envelope.connectionId,
      deadlineMs: envelope.deadlineMs,
      signedSessionRequest: envelope.signedSessionRequest,
      state: createRelayDeliveryState({ connectionId: envelope.connectionId, jobId: envelope.jobId }),
      executing: true,
    };
    job.state = applyRelayDeliveryEvent(job.state, deliveryEvent(job, "deliver")).state;
    job.expiryTimer = setTimeout(() => {
      if (job.state.phase !== "terminal-result")
        job.state = applyRelayDeliveryEvent(job.state, deliveryEvent(job, "expire")).state;
    }, envelope.deadlineMs);
    this.#jobs.set(envelope.jobId, job);
    let sessionEnvelope: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        base64UrlDecodeToBytes(envelope.signedSessionRequest),
      );
      sessionEnvelope = JSON.parse(text) as unknown;
    } catch {
      job.executing = false;
      return;
    }
    void this.#execute(socket, job, sessionEnvelope);
  }

  async #execute(socket: RelayWebSocket, job: RuntimeJob, sessionEnvelope: unknown): Promise<void> {
    let executionResult: CapabilityAuthorizedSessionExecutionResult;
    try {
      executionResult = await this.#options.executor.execute(sessionEnvelope);
    } catch {
      // The existing executor normally returns a bounded failure result. A
      // thrown transport/runtime failure remains a failed execution result.
      executionResult = {
        version: 1,
        status: "failed",
        failure: { code: "SESSION_EXECUTION_FAILED", phase: "execution", message: "Session execution failed." },
      };
    }
    job.executing = false;
    try {
      job.resultPayload = jsonResult(executionResult);
      job.resultDigest = resultDigest(job.resultPayload);
    } catch {
      return;
    }
    this.#flushJobResult(socket, job);
  }

  #flushResults(socket: RelayWebSocket): void {
    for (const job of this.#jobs.values()) this.#flushJobResult(socket, job);
  }

  #flushJobResult(socket: RelayWebSocket, job: RuntimeJob): void {
    if (job.resultPayload === undefined || job.resultDigest === undefined || job.resultSentOnSocket === socket) return;
    if (socket !== this.#socket || !isWebSocketOpen(socket) || !this.#possessionProved) return;
    try {
      this.#send(socket, {
        version: 1,
        kind: "result",
        repository: this.#repository,
        connectionId: job.connectionId,
        jobId: job.jobId,
        deliveryState: "terminal-result",
        resultPayload: job.resultPayload,
      });
      // WebSocket.send only queues bytes locally. Keep the computed result
      // retryable until the relay lifecycle supplies terminal evidence.
      job.resultSentOnSocket = socket;
    } catch {
      // A failed send leaves the delivery state ambiguous and therefore never
      // triggers an executor replay.
    }
  }

  #receiveControl(envelope: Extract<RelayEnvelope, { kind: "control" }>): void {
    const job = this.#jobs.get(envelope.jobId);
    if (job === undefined || envelope.connectionId !== job.connectionId || job.state.phase === "terminal-result")
      return;
    const type: RelayDeliveryEvent["type"] =
      envelope.deliveryState === "expired"
        ? "expire"
        : envelope.deliveryState === "unavailable"
          ? "disconnect"
          : "timeout";
    job.state = applyRelayDeliveryEvent(job.state, deliveryEvent(job, type)).state;
  }

  #onClose(socket: RelayWebSocket): void {
    if (socket !== this.#socket) return;
    this.#socket = undefined;
    this.#possessionProved = false;
    this.#admissionPendingSocket = undefined;
    for (const job of this.#jobs.values()) {
      if (job.state.phase !== "terminal-result")
        job.state = applyRelayDeliveryEvent(job.state, deliveryEvent(job, "disconnect")).state;
    }
    if (this.#state === "shutdown") return;
    this.#state = "unavailable";
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.connect();
    }, this.#reconnectDelayMs);
  }

  #send(socket: RelayWebSocket, envelope: unknown): void {
    this.#sendRaw(socket, new TextDecoder().decode(encodeRelayEnvelope(envelope, this.#repository)));
  }

  #sendRaw(socket: RelayWebSocket, data: string): void {
    if (!isWebSocketOpen(socket)) throw new Error("Relay socket is unavailable.");
    socket.send(data);
  }
}

export const LocalRuntimeRelayClient = LocalRelayRuntime;
export const createLocalRelayRuntime = (options: LocalRelayRuntimeOptions): LocalRelayRuntime =>
  new LocalRelayRuntime(options);
