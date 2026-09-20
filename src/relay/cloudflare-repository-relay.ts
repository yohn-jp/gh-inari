/**
 * Cloudflare Durable Object adapter for the Repository Relay.
 *
 * The object is intentionally a transport boundary. It authenticates only
 * possession of the public key used by a Runtime connection, routes bounded
 * relay envelopes, and records delivery facts. Session, capability, GitHub,
 * and Change authority remain on the Runtime side of the connection.
 */

import {
  decodeRelayEnvelope,
  encodeRelayEnvelope,
  MAX_RELAY_DEADLINE_MS,
  normalizeRelayRepositoryIdentity,
  type RelayEnvelope,
  type RelayJobEnvelope,
  type RelayRepositoryIdentity,
} from "./contract.js";
import { base64UrlDecodeToBytes } from "../agent-authority/codec.js";
import { validateSessionRequestEnvelope } from "../agent-authority/session-request.js";
import {
  createRelayPossessionProofChallenge,
  decodeRelayPossessionProofResponse,
  encodeRelayPossessionProofChallenge,
  MAX_RELAY_POSSESSION_PROOF_TTL_MS,
  verifyRelayPossessionProof,
  verifySessionCertificateConnectionBinding,
  type RelayConnectionKeyBinding,
  type RelayPossessionProofChallenge,
} from "./connection-proof.js";
import {
  applyRelayDeliveryEvent,
  createRelayDeliveryState,
  deserializeRelayDeliveryState,
  serializeRelayDeliveryState,
  type RelayDeliveryEvent,
  type RelayDeliveryState,
} from "./delivery-state.js";
import {
  DEFAULT_RELAY_TELEMETRY_SINK,
  createRelayTelemetryEvent,
  recordRelayTelemetry,
  type RelayTelemetryFailureClass,
  type RelayTelemetrySink,
} from "./telemetry.js";

/** Cloudflare provides this global in a Worker; it is absent from Node types. */
declare const WebSocketPair: new () => [WebSocket, WebSocket];

function createWebSocketAutoResponsePair(request: string, response: string): unknown {
  const ctor = (globalThis as { WebSocketRequestResponsePair?: new (request: string, response: string) => unknown })
    .WebSocketRequestResponsePair;
  return ctor === undefined ? { request, response } : new ctor(request, response);
}

const JSON_ENCODER = new TextEncoder();
const JSON_DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_STORED_JOBS = 32;
const MAX_USED_NONCES = 128;
const MAX_MESSAGE_BYTES = 65_536;
const MAX_RELAY_CONNECTIONS = 128;
const MAX_RELAY_MESSAGES_PER_WINDOW = 256;
const MAX_RELAY_MESSAGE_WINDOW_MS = 60_000;
const MAX_RELAY_CONNECTION_TTL_MS = 86_400_000;
const MAX_RELAY_JOB_RETENTION_MS = 120_000;
const MAX_RUNTIME_GENERATION = Number.MAX_SAFE_INTEGER;
const CONNECTION_ATTACHMENT_VERSION = 1 as const;
const JOB_RECORD_VERSION = 1 as const;
const RELAY_HANDSHAKE_KIND = "repository-relay-possession-challenge";
const RELAY_HANDSHAKE_RESPONSE_KIND = "repository-relay-possession-response";
const RELAY_HEARTBEAT_REQUEST = "relay:ping";
const RELAY_HEARTBEAT_RESPONSE = "relay:pong";
const JOB_PREFIX = "relay:job:";
const NONCE_KEY = "relay:used-nonces";

type RelayRole = "runtime" | "client";

export interface RelayOperationalLimits {
  readonly maxConnections: number;
  readonly maxInFlightJobs: number;
  readonly maxMessagesPerWindow: number;
  readonly messageWindowMs: number;
  readonly maxDeadlineMs: number;
  readonly jobRetentionMs: number;
  readonly connectionTtlMs: number;
  readonly maxRetainedJobs: number;
}

export const RELAY_OPERATIONAL_HARD_LIMITS: RelayOperationalLimits = Object.freeze({
  maxConnections: MAX_RELAY_CONNECTIONS,
  maxInFlightJobs: 32,
  maxMessagesPerWindow: MAX_RELAY_MESSAGES_PER_WINDOW,
  messageWindowMs: MAX_RELAY_MESSAGE_WINDOW_MS,
  maxDeadlineMs: MAX_RELAY_DEADLINE_MS,
  jobRetentionMs: MAX_RELAY_JOB_RETENTION_MS,
  connectionTtlMs: MAX_RELAY_CONNECTION_TTL_MS,
  maxRetainedJobs: MAX_STORED_JOBS,
});

export const DEFAULT_RELAY_OPERATIONAL_LIMITS: RelayOperationalLimits = Object.freeze({
  maxConnections: 64,
  maxInFlightJobs: 16,
  maxMessagesPerWindow: 120,
  messageWindowMs: 1_000,
  maxDeadlineMs: MAX_RELAY_DEADLINE_MS,
  jobRetentionMs: 60_000,
  connectionTtlMs: 3_600_000,
  maxRetainedJobs: MAX_STORED_JOBS,
});

export type RelayOperationalLimitCode =
  | "RELAY_CONNECTION_LIMIT"
  | "RELAY_IN_FLIGHT_LIMIT"
  | "RELAY_MESSAGE_RATE_LIMIT"
  | "RELAY_DEADLINE_LIMIT"
  | "RELAY_RETENTION_LIMIT"
  | "RELAY_CONNECTION_EXPIRED";

export class RelayOperationalLimitError extends Error {
  readonly code: RelayOperationalLimitCode;

  constructor(code: RelayOperationalLimitCode, message: string) {
    super(message);
    this.name = "RelayOperationalLimitError";
    this.code = code;
  }
}

/** The subset of the Workers Hibernation API used by this adapter. */
export interface RepositoryRelayWebSocket {
  readonly readyState?: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close?(code?: number, reason?: string): void;
  serializeAttachment?(attachment: unknown): void;
  deserializeAttachment?(): unknown;
}

export interface RepositoryRelayStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete?(key: string): Promise<boolean>;
  list?<T>(options?: { readonly prefix?: string; readonly limit?: number }): Promise<Map<string, T>>;
  setAlarm?(scheduledTime: number): Promise<void>;
}

export interface RepositoryRelayDurableObjectState {
  readonly storage: RepositoryRelayStorage;
  acceptWebSocket(webSocket: RepositoryRelayWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): RepositoryRelayWebSocket[];
  setWebSocketAutoResponse?(pair: unknown | null): void;
  waitUntil?(promise: Promise<unknown>): void;
}

export interface RepositoryRelayDurableObjectEnvironment {
  /** Optional immutable identity supplied by the Worker binding. */
  readonly repository?: RelayRepositoryIdentity;
  readonly REPOSITORY?: RelayRepositoryIdentity;
  readonly telemetry?: RelayTelemetrySink;
}

export interface RepositoryRelayDurableObjectOptions {
  /** Identity is normally supplied by the Worker binding or the request URL. */
  readonly repository?: RelayRepositoryIdentity;
  readonly now?: () => number;
  readonly randomNonce?: () => string;
  readonly limits?: Partial<RelayOperationalLimits>;
  readonly telemetry?: RelayTelemetrySink;
}

interface RuntimeConnectionAttachment {
  readonly version: typeof CONNECTION_ATTACHMENT_VERSION;
  readonly role: RelayRole;
  readonly repository: RelayRepositoryIdentity;
  readonly connectionId: string;
  readonly delegatorId?: string;
  readonly challenge?: RelayPossessionProofChallenge;
  readonly binding?: RelayConnectionKeyBinding;
  /** Monotonic transport instance identity for an admitted Runtime. */
  readonly generation?: number;
  readonly authenticated: boolean;
  readonly openedAtMs: number;
  readonly expiresAtMs: number;
  readonly messageWindowStartedAtMs: number;
  readonly messageCount: number;
}

interface StoredJobRecord {
  readonly version: typeof JOB_RECORD_VERSION;
  readonly repository: RelayRepositoryIdentity;
  readonly sourceConnectionId: string;
  readonly targetConnectionId: string;
  /** The admitted Runtime transport instance that received the job. */
  readonly targetGeneration?: number;
  readonly deadlineAtMs: number;
  readonly retainedUntilMs: number;
  readonly state: RelayDeliveryState;
}

interface StoredNonceRecord {
  readonly nonce: string;
  readonly expiresAtMs: number;
}

interface RelayRequestContext {
  readonly repository: RelayRepositoryIdentity;
  readonly role: RelayRole;
  readonly connectionId: string;
  readonly delegatorId?: string;
}

export interface RelayDurableObjectNamespaceLike<TId = unknown> {
  idFromName(name: string): TId;
  get(id: TId): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonBytes(value: unknown): Uint8Array {
  return JSON_ENCODER.encode(JSON.stringify(value));
}

function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    if (text === undefined || JSON_ENCODER.encode(text).byteLength > MAX_MESSAGE_BYTES) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

function positiveBoundedInteger(value: number, name: keyof RelayOperationalLimits, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RelayOperationalLimitError(
      "RELAY_RETENTION_LIMIT",
      `${name} must be a positive integer within the relay operational ceiling.`,
    );
  }
  return value;
}

function normalizeOperationalLimits(input: Partial<RelayOperationalLimits> | undefined): RelayOperationalLimits {
  const configured = { ...DEFAULT_RELAY_OPERATIONAL_LIMITS, ...(input ?? {}) };
  return Object.freeze({
    maxConnections: positiveBoundedInteger(
      configured.maxConnections,
      "maxConnections",
      RELAY_OPERATIONAL_HARD_LIMITS.maxConnections,
    ),
    maxInFlightJobs: positiveBoundedInteger(
      configured.maxInFlightJobs,
      "maxInFlightJobs",
      RELAY_OPERATIONAL_HARD_LIMITS.maxInFlightJobs,
    ),
    maxMessagesPerWindow: positiveBoundedInteger(
      configured.maxMessagesPerWindow,
      "maxMessagesPerWindow",
      RELAY_OPERATIONAL_HARD_LIMITS.maxMessagesPerWindow,
    ),
    messageWindowMs: positiveBoundedInteger(
      configured.messageWindowMs,
      "messageWindowMs",
      RELAY_OPERATIONAL_HARD_LIMITS.messageWindowMs,
    ),
    maxDeadlineMs: positiveBoundedInteger(
      configured.maxDeadlineMs,
      "maxDeadlineMs",
      RELAY_OPERATIONAL_HARD_LIMITS.maxDeadlineMs,
    ),
    jobRetentionMs: positiveBoundedInteger(
      configured.jobRetentionMs,
      "jobRetentionMs",
      RELAY_OPERATIONAL_HARD_LIMITS.jobRetentionMs,
    ),
    connectionTtlMs: positiveBoundedInteger(
      configured.connectionTtlMs,
      "connectionTtlMs",
      RELAY_OPERATIONAL_HARD_LIMITS.connectionTtlMs,
    ),
    maxRetainedJobs: positiveBoundedInteger(
      configured.maxRetainedJobs,
      "maxRetainedJobs",
      RELAY_OPERATIONAL_HARD_LIMITS.maxRetainedJobs,
    ),
  });
}

function bytesOfMessage(message: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof message === "string") return JSON_ENCODER.encode(message);
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}

function asText(message: string | ArrayBuffer | ArrayBufferView): string | undefined {
  const bytes = bytesOfMessage(message);
  if (bytes.byteLength > MAX_MESSAGE_BYTES) return undefined;
  try {
    return typeof message === "string" ? message : JSON_DECODER.decode(bytes);
  } catch {
    return undefined;
  }
}

function isUpgrade(request: Request): boolean {
  return request.method === "GET" && request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

function overloadedResponse(): Response {
  return new Response(JSON.stringify({ ok: false, error: { code: "RELAY_OVERLOADED" } }), {
    status: 503,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });
}

function badRequest(message = "Invalid relay request."): Response {
  return new Response(message, { status: 400 });
}

function unauthorized(): Response {
  return new Response("Relay connection is not authorized for transport.", { status: 401 });
}

function repositoryFromQuery(url: URL, configured?: RelayRepositoryIdentity): RelayRepositoryIdentity | undefined {
  if (configured !== undefined) {
    try {
      const normalized = normalizeRelayRepositoryIdentity(configured);
      const requestedId = url.searchParams.get("repositoryId");
      const requestedHost = url.searchParams.get("repositoryHost");
      if (
        (requestedId !== null && requestedId !== normalized.repositoryId) ||
        (requestedHost !== null && requestedHost.toLowerCase() !== normalized.repositoryHost)
      ) {
        return undefined;
      }
      return normalized;
    } catch {
      return undefined;
    }
  }
  const repositoryId = url.searchParams.get("repositoryId");
  const repositoryHost = url.searchParams.get("repositoryHost") ?? "github.com";
  if (repositoryId === null) return undefined;
  try {
    return normalizeRelayRepositoryIdentity({ repositoryId, repositoryHost });
  } catch {
    return undefined;
  }
}

function connectionIdFromQuery(url: URL): string | undefined {
  const value = url.searchParams.get("connectionId");
  return value === null || !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u.test(value) ? undefined : value;
}

function roleFromQuery(url: URL): RelayRole | undefined {
  const value = url.searchParams.get("role") ?? "runtime";
  return value === "runtime" || value === "client" ? value : undefined;
}

function nonce(): string {
  const bytes = new Uint8Array(18);
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.getRandomValues !== undefined) cryptoObject.getRandomValues(bytes);
  else bytes.fill(0);
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function digestPayload(payload: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    let hash = 2_166_136_261;
    for (const byte of JSON_ENCODER.encode(payload)) hash = Math.imul(hash ^ byte, 16_777_619);
    return Promise.resolve(`fnv1a-${(hash >>> 0).toString(16)}`);
  }
  return subtle.digest("SHA-256", JSON_ENCODER.encode(payload)).then((digestBytes) => {
    return [...new Uint8Array(digestBytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  });
}

function eventForControl(
  state: RelayDeliveryState,
  envelope: Extract<RelayEnvelope, { kind: "control" }>,
): RelayDeliveryEvent {
  const type =
    envelope.deliveryState === "delivered-ambiguous"
      ? "timeout"
      : envelope.deliveryState === "expired"
        ? "expire"
        : "disconnect";
  return { version: state.version, type, connectionId: state.connectionId, jobId: state.jobId };
}

function jobKey(jobId: string): string {
  return `${JOB_PREFIX}${jobId}`;
}

function sessionCertificateFromJob(job: RelayJobEnvelope): string | undefined {
  try {
    const envelope = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(base64UrlDecodeToBytes(job.signedSessionRequest)),
    ) as unknown;
    const validated = validateSessionRequestEnvelope(envelope);
    return validated.valid ? validated.value?.certificate : undefined;
  } catch {
    return undefined;
  }
}

function isOpen(webSocket: RepositoryRelayWebSocket): boolean {
  return webSocket.readyState === undefined || webSocket.readyState === 1;
}

/** The object name is deliberately the immutable provider repository ID. */
export function repositoryRelayDurableObjectName(repository: RelayRepositoryIdentity): string {
  return normalizeRelayRepositoryIdentity(repository).repositoryId;
}

export function repositoryRelayDurableObjectId<TId>(
  namespace: RelayDurableObjectNamespaceLike<TId>,
  repository: RelayRepositoryIdentity,
): TId {
  return namespace.idFromName(repositoryRelayDurableObjectName(repository));
}

export class RepositoryRelayDurableObject {
  private readonly repository?: RelayRepositoryIdentity;
  private readonly now: () => number;
  private readonly randomNonce: () => string;
  private readonly limits: RelayOperationalLimits;
  private readonly telemetry?: RelayTelemetrySink;
  private readonly generationReservations = new Map<string, number>();

  constructor(
    private readonly state: RepositoryRelayDurableObjectState,
    env: RepositoryRelayDurableObjectEnvironment = {} as RepositoryRelayDurableObjectEnvironment,
    options: RepositoryRelayDurableObjectOptions = {},
  ) {
    const configured = options.repository ?? env.repository ?? env.REPOSITORY;
    this.repository = configured === undefined ? undefined : normalizeRelayRepositoryIdentity(configured);
    this.now = options.now ?? Date.now;
    this.randomNonce = options.randomNonce ?? nonce;
    this.limits = normalizeOperationalLimits(options.limits);
    this.telemetry = options.telemetry ?? env.telemetry ?? DEFAULT_RELAY_TELEMETRY_SINK;
  }

  private emitTelemetry(
    input: Omit<Parameters<typeof createRelayTelemetryEvent>[0], "repository"> & {
      readonly repository?: RelayRepositoryIdentity;
      readonly failureClass?: RelayTelemetryFailureClass;
    },
  ): void {
    const repository = input.repository ?? this.repository;
    if (repository === undefined) return;
    const event = createRelayTelemetryEvent({ ...input, repository });
    const pending = recordRelayTelemetry(this.telemetry, event);
    if (pending !== undefined) this.state.waitUntil?.(pending);
  }

  private activeConnectionCount(): number {
    try {
      return this.state.getWebSockets().filter((socket) => isOpen(socket)).length;
    } catch {
      return this.limits.maxConnections;
    }
  }

  private connectionCounters(): {
    readonly connections: number;
    readonly inFlightJobs: number;
    readonly retainedJobs: number;
    readonly messagesInWindow: number;
  } {
    let messagesInWindow = 0;
    const now = this.now();
    try {
      for (const socket of this.state.getWebSockets()) {
        const attachment = this.attachmentOf(socket);
        if (
          attachment !== undefined &&
          now >= attachment.messageWindowStartedAtMs &&
          now - attachment.messageWindowStartedAtMs < this.limits.messageWindowMs
        ) {
          messagesInWindow += attachment.messageCount;
        }
      }
    } catch {
      messagesInWindow = 0;
    }
    return {
      connections: this.activeConnectionCount(),
      inFlightJobs: 0,
      retainedJobs: 0,
      messagesInWindow,
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (!isUpgrade(request)) return badRequest("Repository Relay requires a WebSocket upgrade.");
    const url = new URL(request.url);
    const repository = repositoryFromQuery(url, this.repository);
    const role = roleFromQuery(url);
    const connectionId = connectionIdFromQuery(url);
    if (repository === undefined || role === undefined || connectionId === undefined) return badRequest();
    const delegatorId = url.searchParams.get("delegatorId") ?? undefined;
    if (role === "runtime" && (delegatorId === undefined || !/^[A-Za-z0-9._-]{1,128}$/u.test(delegatorId))) {
      return badRequest("Runtime connections require a bounded delegatorId.");
    }
    if (this.activeConnectionCount() >= this.limits.maxConnections) {
      this.emitTelemetry({
        occurredAtMs: this.now(),
        kind: "connection",
        surface: "durable-object",
        repository,
        failureClass: "overloaded",
        counters: this.connectionCounters(),
      });
      return overloadedResponse();
    }
    const openedAtMs = this.now();
    const pair = new WebSocketPair();
    const client = pair[0] as unknown as RepositoryRelayWebSocket;
    const server = pair[1] as unknown as RepositoryRelayWebSocket;
    const attachment: RuntimeConnectionAttachment = {
      version: CONNECTION_ATTACHMENT_VERSION,
      role,
      repository,
      connectionId,
      ...(delegatorId === undefined ? {} : { delegatorId }),
      authenticated: role === "client",
      openedAtMs,
      expiresAtMs: openedAtMs + this.limits.connectionTtlMs,
      messageWindowStartedAtMs: openedAtMs,
      messageCount: 0,
    };
    this.state.acceptWebSocket(server, [role]);
    server.serializeAttachment?.(attachment);
    this.state.setWebSocketAutoResponse?.(
      createWebSocketAutoResponsePair(RELAY_HEARTBEAT_REQUEST, RELAY_HEARTBEAT_RESPONSE),
    );
    await this.scheduleNextAlarm();
    this.emitTelemetry({
      occurredAtMs: openedAtMs,
      kind: "connection",
      surface: "durable-object",
      repository,
      connectionId,
      counters: this.connectionCounters(),
    });
    if (role === "runtime") {
      const challenge = createRelayPossessionProofChallenge({
        repositoryId: repository.repositoryId,
        delegatorId: delegatorId as string,
        nonce: this.randomNonce(),
        issuedAtMs: this.now(),
      });
      const challengedAttachment = { ...attachment, challenge } satisfies RuntimeConnectionAttachment;
      server.serializeAttachment?.(challengedAttachment);
      server.send(
        JSON.stringify({
          type: RELAY_HANDSHAKE_KIND,
          version: 1,
          repository,
          connectionId,
          challenge: JSON.parse(new TextDecoder().decode(encodeRelayPossessionProofChallenge(challenge))) as unknown,
        }),
      );
    }
    try {
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit & { webSocket: WebSocket });
    } catch {
      // Node's Response rejects status 101; Workers accepts the upgrade response.
      return { status: 101, webSocket: pair[0] } as unknown as Response;
    }
  }

  async webSocketMessage(
    webSocket: RepositoryRelayWebSocket,
    message: string | ArrayBuffer | ArrayBufferView,
  ): Promise<void> {
    const attachment = this.attachmentOf(webSocket);
    if (attachment === undefined || !isOpen(webSocket)) return;
    try {
      this.consumeMessage(webSocket, attachment);
    } catch (error) {
      if (error instanceof RelayOperationalLimitError) {
        this.emitTelemetry({
          occurredAtMs: this.now(),
          kind: "message",
          surface: "durable-object",
          repository: attachment.repository,
          connectionId: attachment.connectionId,
          failureClass:
            error.code === "RELAY_MESSAGE_RATE_LIMIT"
              ? "rate-limited"
              : error.code === "RELAY_CONNECTION_EXPIRED"
                ? "expired"
                : "overloaded",
          counters: this.connectionCounters(),
        });
        return this.close(
          webSocket,
          error.code === "RELAY_CONNECTION_EXPIRED" ? 1001 : 1013,
          error.code === "RELAY_CONNECTION_EXPIRED" ? "Relay connection expired." : "Relay operational limit reached.",
        );
      }
      throw error;
    }
    const startedAtMs = this.now();
    const text = asText(message);
    if (text === undefined) {
      this.emitTelemetry({
        occurredAtMs: startedAtMs,
        kind: "message",
        surface: "durable-object",
        repository: attachment.repository,
        connectionId: attachment.connectionId,
        failureClass: "malformed",
      });
      return this.close(webSocket, 1009, "Message exceeds relay bounds.");
    }
    try {
      if (attachment.role === "runtime" && !attachment.authenticated) {
        await this.admitRuntime(webSocket, attachment, text);
        return;
      }
      let envelope: RelayEnvelope;
      try {
        envelope = decodeRelayEnvelope(text, attachment.repository);
      } catch {
        this.emitTelemetry({
          occurredAtMs: startedAtMs,
          kind: "message",
          surface: "durable-object",
          repository: attachment.repository,
          connectionId: attachment.connectionId,
          failureClass: "malformed",
        });
        return this.close(webSocket, 1008, "Malformed relay envelope.");
      }
      if (envelope.kind === "job") return await this.receiveJob(webSocket, attachment, envelope);
      if (envelope.kind === "result") return await this.receiveResult(webSocket, attachment, envelope);
      if (envelope.kind === "control") return await this.receiveControl(webSocket, attachment, envelope);
      this.close(webSocket, 1008, "Unsupported relay message.");
    } finally {
      this.emitTelemetry({
        occurredAtMs: startedAtMs,
        kind: "cpu-active",
        surface: "durable-object",
        repository: attachment.repository,
        connectionId: attachment.connectionId,
        durationMs: Math.max(0, this.now() - startedAtMs),
        counters: this.connectionCounters(),
      });
    }
  }

  async webSocketClose(webSocket: RepositoryRelayWebSocket): Promise<void> {
    const attachment = this.attachmentOf(webSocket);
    if (
      attachment === undefined ||
      attachment.role !== "runtime" ||
      !attachment.authenticated ||
      attachment.generation === undefined
    ) {
      return;
    }
    const records = await this.records();
    for (const record of records) {
      if (record.targetConnectionId !== attachment.connectionId || record.targetGeneration !== attachment.generation)
        continue;
      await this.applyEvent(record, {
        version: record.state.version,
        type: "disconnect",
        connectionId: record.state.connectionId,
        jobId: record.state.jobId,
      });
    }
    this.emitTelemetry({
      occurredAtMs: this.now(),
      kind: "connection",
      surface: "durable-object",
      repository: attachment.repository,
      connectionId: attachment.connectionId,
      failureClass: "disconnected",
      counters: this.connectionCounters(),
    });
  }

  async webSocketError(webSocket: RepositoryRelayWebSocket): Promise<void> {
    await this.webSocketClose(webSocket);
  }

  async alarm(): Promise<void> {
    const now = this.now();
    for (const socket of this.state.getWebSockets()) {
      const attachment = this.attachmentOf(socket);
      if (attachment === undefined || attachment.expiresAtMs > now) continue;
      await this.webSocketClose(socket);
      this.close(socket, 1001, "Relay connection expired.");
      this.emitTelemetry({
        occurredAtMs: now,
        kind: "cleanup",
        surface: "durable-object",
        repository: attachment.repository,
        connectionId: attachment.connectionId,
        failureClass: "expired",
      });
    }
    await this.reapNonces(now);
    await this.reapJobs(now);
    await this.scheduleNextAlarm();
  }

  private attachmentOf(webSocket: RepositoryRelayWebSocket): RuntimeConnectionAttachment | undefined {
    try {
      const value = webSocket.deserializeAttachment?.();
      if (!isRecord(value) || value.version !== CONNECTION_ATTACHMENT_VERSION) return undefined;
      if (value.role !== "runtime" && value.role !== "client") return undefined;
      const repository = normalizeRelayRepositoryIdentity(value.repository);
      if (typeof value.connectionId !== "string") return undefined;
      return {
        version: CONNECTION_ATTACHMENT_VERSION,
        role: value.role,
        repository,
        connectionId: value.connectionId,
        ...(typeof value.delegatorId === "string" ? { delegatorId: value.delegatorId } : {}),
        ...(isRecord(value.challenge)
          ? { challenge: value.challenge as unknown as RelayPossessionProofChallenge }
          : {}),
        ...(isRecord(value.binding) ? { binding: value.binding as unknown as RelayConnectionKeyBinding } : {}),
        ...(Number.isSafeInteger(value.generation) &&
        (value.generation as number) >= 1 &&
        (value.generation as number) <= MAX_RUNTIME_GENERATION
          ? { generation: value.generation as number }
          : {}),
        authenticated: value.authenticated === true,
        openedAtMs: Number.isSafeInteger(value.openedAtMs) ? (value.openedAtMs as number) : 0,
        expiresAtMs: Number.isSafeInteger(value.expiresAtMs) ? (value.expiresAtMs as number) : Number.POSITIVE_INFINITY,
        messageWindowStartedAtMs: Number.isSafeInteger(value.messageWindowStartedAtMs)
          ? (value.messageWindowStartedAtMs as number)
          : 0,
        messageCount:
          Number.isSafeInteger(value.messageCount) && (value.messageCount as number) >= 0
            ? (value.messageCount as number)
            : 0,
      };
    } catch {
      return undefined;
    }
  }

  private sameRuntimeIdentity(
    attachment: RuntimeConnectionAttachment,
    repository: RelayRepositoryIdentity,
    connectionId: string,
    delegatorId: string | undefined,
  ): boolean {
    return (
      attachment.role === "runtime" &&
      attachment.repository.repositoryId === repository.repositoryId &&
      attachment.repository.repositoryHost === repository.repositoryHost &&
      attachment.connectionId === connectionId &&
      attachment.delegatorId === delegatorId
    );
  }

  private runtimeIdentityKey(repository: RelayRepositoryIdentity, connectionId: string, delegatorId: string): string {
    return `${repository.repositoryHost}\u0000${repository.repositoryId}\u0000${delegatorId}\u0000${connectionId}`;
  }

  private async nextRuntimeGeneration(
    repository: RelayRepositoryIdentity,
    connectionId: string,
    delegatorId: string,
  ): Promise<number> {
    // A retained delivery record is durable transport state: it can still
    // receive a result/control/close event for the generation that received
    // the job. Include those records before allocating so a reconstructed DO
    // cannot reuse a generation after its old socket has disappeared.
    const now = this.now();
    const retainedRecords = await this.records();
    const key = this.runtimeIdentityKey(repository, connectionId, delegatorId);
    let highest = this.generationReservations.get(key) ?? 0;
    for (const socket of this.state.getWebSockets("runtime")) {
      const attachment = this.attachmentOf(socket);
      if (
        attachment === undefined ||
        !this.sameRuntimeIdentity(attachment, repository, connectionId, delegatorId) ||
        !attachment.authenticated ||
        attachment.generation === undefined
      ) {
        continue;
      }
      highest = Math.max(highest, attachment.generation);
    }
    for (const record of retainedRecords) {
      if (
        record.retainedUntilMs <= now ||
        record.targetConnectionId !== connectionId ||
        record.repository.repositoryId !== repository.repositoryId ||
        record.repository.repositoryHost !== repository.repositoryHost ||
        record.targetGeneration === undefined
      ) {
        continue;
      }
      highest = Math.max(highest, record.targetGeneration);
    }
    if (highest >= MAX_RUNTIME_GENERATION) {
      throw new RelayOperationalLimitError(
        "RELAY_RETENTION_LIMIT",
        "Runtime transport generation exhausted its bounded ceiling.",
      );
    }
    const generation = highest + 1;
    this.generationReservations.set(key, generation);
    return generation;
  }

  private isCurrentRuntime(webSocket: RepositoryRelayWebSocket, attachment: RuntimeConnectionAttachment): boolean {
    if (!attachment.authenticated || attachment.generation === undefined || !isOpen(webSocket)) return false;
    let highest = 0;
    let currentCount = 0;
    for (const candidate of this.state.getWebSockets("runtime")) {
      const candidateAttachment = this.attachmentOf(candidate);
      if (
        candidateAttachment === undefined ||
        !candidateAttachment.authenticated ||
        candidateAttachment.generation === undefined ||
        !this.sameRuntimeIdentity(
          candidateAttachment,
          attachment.repository,
          attachment.connectionId,
          attachment.delegatorId,
        ) ||
        !isOpen(candidate)
      ) {
        continue;
      }
      if (candidateAttachment.generation > highest) {
        highest = candidateAttachment.generation;
        currentCount = 1;
      } else if (candidateAttachment.generation === highest) {
        currentCount += 1;
      }
    }
    return currentCount === 1 && attachment.generation === highest;
  }

  private supersedeRuntime(currentSocket: RepositoryRelayWebSocket, attachment: RuntimeConnectionAttachment): void {
    if (attachment.generation === undefined) return;
    for (const candidate of this.state.getWebSockets("runtime")) {
      if (candidate === currentSocket || !isOpen(candidate)) continue;
      const candidateAttachment = this.attachmentOf(candidate);
      if (
        candidateAttachment === undefined ||
        !candidateAttachment.authenticated ||
        !this.sameRuntimeIdentity(
          candidateAttachment,
          attachment.repository,
          attachment.connectionId,
          attachment.delegatorId,
        ) ||
        (candidateAttachment.generation !== undefined && candidateAttachment.generation >= attachment.generation)
      ) {
        continue;
      }
      this.close(candidate, 1000, "Runtime connection replaced.");
    }
  }

  private consumeMessage(webSocket: RepositoryRelayWebSocket, attachment: RuntimeConnectionAttachment): void {
    const now = this.now();
    if (now >= attachment.expiresAtMs) {
      throw new RelayOperationalLimitError("RELAY_CONNECTION_EXPIRED", "Relay connection metadata expired.");
    }
    const reset =
      now < attachment.messageWindowStartedAtMs ||
      now - attachment.messageWindowStartedAtMs >= this.limits.messageWindowMs;
    const windowStartedAtMs = reset ? now : attachment.messageWindowStartedAtMs;
    const messageCount = reset ? 0 : attachment.messageCount;
    if (messageCount >= this.limits.maxMessagesPerWindow) {
      throw new RelayOperationalLimitError("RELAY_MESSAGE_RATE_LIMIT", "Relay message rate limit reached.");
    }
    webSocket.serializeAttachment?.({
      ...attachment,
      messageWindowStartedAtMs: windowStartedAtMs,
      messageCount: messageCount + 1,
    } satisfies RuntimeConnectionAttachment);
  }

  private async admitRuntime(
    webSocket: RepositoryRelayWebSocket,
    attachment: RuntimeConnectionAttachment,
    text: string,
  ): Promise<void> {
    let candidate: unknown;
    try {
      candidate = JSON.parse(text) as unknown;
    } catch {
      return this.close(webSocket, 1008, "Malformed possession proof.");
    }
    if (isRecord(candidate) && candidate.type === RELAY_HANDSHAKE_RESPONSE_KIND) candidate = candidate.proof;
    if (attachment.challenge === undefined || attachment.delegatorId === undefined) {
      return this.close(webSocket, 1008, "Missing possession challenge.");
    }
    try {
      if (isRecord(candidate) && typeof candidate.response === "object") candidate = candidate.response;
      const response = decodeRelayPossessionProofResponse(JSON.stringify(candidate));
      const now = this.now();
      const storedNonces = await this.state.storage.get<StoredNonceRecord[] | string[]>(NONCE_KEY);
      const activeNonceRecords: StoredNonceRecord[] = Array.isArray(storedNonces)
        ? storedNonces
            .map((entry): StoredNonceRecord | undefined => {
              if (typeof entry === "string")
                return { nonce: entry, expiresAtMs: now + MAX_RELAY_POSSESSION_PROOF_TTL_MS };
              if (
                isRecord(entry) &&
                typeof entry.nonce === "string" &&
                Number.isSafeInteger(entry.expiresAtMs) &&
                (entry.expiresAtMs as number) > now
              ) {
                return { nonce: entry.nonce, expiresAtMs: entry.expiresAtMs as number };
              }
              return undefined;
            })
            .filter((entry): entry is StoredNonceRecord => entry !== undefined)
            .slice(-MAX_USED_NONCES)
        : [];
      const usedNonces = new Set(activeNonceRecords.map((entry) => entry.nonce));
      const result = verifyRelayPossessionProof(attachment.challenge, response, { nowMs: this.now(), usedNonces });
      if (!result.valid || result.value === undefined) return this.close(webSocket, 1008, "Invalid possession proof.");
      const generation = await this.nextRuntimeGeneration(
        attachment.repository,
        attachment.connectionId,
        attachment.delegatorId,
      );
      await this.state.storage.put(
        NONCE_KEY,
        [
          ...activeNonceRecords,
          { nonce: attachment.challenge.nonce, expiresAtMs: attachment.challenge.expiresAtMs },
        ].slice(-MAX_USED_NONCES),
      );
      await this.scheduleNextAlarm();
      const authenticatedAttachment: RuntimeConnectionAttachment = {
        ...attachment,
        binding: result.value,
        generation,
        authenticated: true,
      };
      webSocket.serializeAttachment?.(authenticatedAttachment);
      this.supersedeRuntime(webSocket, authenticatedAttachment);
      webSocket.send(
        JSON.stringify({
          type: "repository-relay-connected",
          version: 1,
          repository: attachment.repository,
          connectionId: attachment.connectionId,
        }),
      );
    } catch {
      this.close(webSocket, 1008, "Invalid possession proof.");
    }
  }

  private async receiveJob(
    source: RepositoryRelayWebSocket,
    sourceAttachment: RuntimeConnectionAttachment,
    job: RelayJobEnvelope,
  ): Promise<void> {
    // A repeated job ID is never an implicit permission to replay an exchange.
    // The caller must use the delivery/recovery authority outside this adapter.
    if (await this.record(job.jobId)) return;
    if (job.deadlineMs > this.limits.maxDeadlineMs) {
      this.emitTelemetry({
        occurredAtMs: this.now(),
        kind: "job",
        surface: "durable-object",
        repository: job.repository,
        connectionId: job.connectionId,
        jobId: job.jobId,
        failureClass: "overloaded",
      });
      return this.sendControl(source, job, "unavailable", "not-delivered");
    }
    await this.reapJobs(this.now());
    const retained = await this.records();
    const now = this.now();
    const retainedCount = retained.filter((record) => record.retainedUntilMs > now).length;
    const inFlightCount = retained.filter(
      (record) =>
        record.retainedUntilMs > now &&
        record.state.phase !== "terminal-result" &&
        record.state.phase !== "expired" &&
        record.state.phase !== "cancelled" &&
        record.state.phase !== "unavailable",
    ).length;
    const connectionInFlightCount = retained.filter(
      (record) =>
        record.targetConnectionId === job.connectionId &&
        record.retainedUntilMs > now &&
        record.state.phase !== "terminal-result" &&
        record.state.phase !== "expired" &&
        record.state.phase !== "cancelled" &&
        record.state.phase !== "unavailable",
    ).length;
    if (
      retainedCount >= this.limits.maxRetainedJobs ||
      inFlightCount >= this.limits.maxInFlightJobs ||
      connectionInFlightCount >= this.limits.maxInFlightJobs
    ) {
      const code: RelayOperationalLimitCode =
        retainedCount >= this.limits.maxRetainedJobs ? "RELAY_RETENTION_LIMIT" : "RELAY_IN_FLIGHT_LIMIT";
      this.emitTelemetry({
        occurredAtMs: now,
        kind: "job",
        surface: "durable-object",
        repository: job.repository,
        connectionId: job.connectionId,
        jobId: job.jobId,
        failureClass: "overloaded",
        counters: {
          connections: this.activeConnectionCount(),
          inFlightJobs: Math.max(inFlightCount, connectionInFlightCount),
          retainedJobs: retainedCount,
          messagesInWindow: 0,
        },
      });
      return this.sendControl(source, job, "unavailable", "not-delivered");
    }
    const certificate = sessionCertificateFromJob(job);
    this.emitTelemetry({
      occurredAtMs: now,
      kind: "job",
      surface: "durable-object",
      repository: job.repository,
      connectionId: job.connectionId,
      jobId: job.jobId,
      counters: {
        connections: this.activeConnectionCount(),
        inFlightJobs: inFlightCount + 1,
        retainedJobs: retainedCount + 1,
        messagesInWindow: this.connectionCounters().messagesInWindow,
      },
    });
    const runtimes = this.state.getWebSockets("runtime");
    const eligible = runtimes.filter((candidate) => {
      const attachment = this.attachmentOf(candidate);
      return (
        attachment?.role === "runtime" &&
        attachment.authenticated &&
        attachment.connectionId === job.connectionId &&
        attachment.repository.repositoryId === job.repository.repositoryId &&
        attachment.repository.repositoryHost === job.repository.repositoryHost &&
        certificate !== undefined &&
        attachment.binding !== undefined &&
        verifySessionCertificateConnectionBinding(certificate, attachment.binding).valid
      );
    });
    let target: RepositoryRelayWebSocket | undefined;
    let targetAttachment: RuntimeConnectionAttachment | undefined;
    let targetGeneration = 0;
    let targetCount = 0;
    for (const candidate of eligible) {
      const candidateAttachment = this.attachmentOf(candidate);
      if (candidateAttachment === undefined || !this.isCurrentRuntime(candidate, candidateAttachment)) continue;
      if (candidateAttachment.generation === undefined) continue;
      if (candidateAttachment.generation > targetGeneration) {
        target = candidate;
        targetAttachment = candidateAttachment;
        targetGeneration = candidateAttachment.generation;
        targetCount = 1;
      } else if (candidateAttachment.generation === targetGeneration) {
        targetCount += 1;
      }
    }
    if (targetCount !== 1) {
      target = undefined;
      targetAttachment = undefined;
    }
    const initial = createRelayDeliveryState({ connectionId: job.connectionId, jobId: job.jobId });
    const record: StoredJobRecord = {
      version: JOB_RECORD_VERSION,
      repository: sourceAttachment.repository,
      sourceConnectionId: sourceAttachment.connectionId,
      targetConnectionId: job.connectionId,
      ...(targetAttachment?.generation === undefined ? {} : { targetGeneration: targetAttachment.generation }),
      deadlineAtMs: now + job.deadlineMs,
      retainedUntilMs: now + job.deadlineMs + this.limits.jobRetentionMs,
      state: initial,
    };
    if (target === undefined || !isOpen(target)) {
      try {
        await this.saveRecord({
          ...record,
          state: applyRelayDeliveryEvent(initial, {
            version: initial.version,
            type: "disconnect",
            connectionId: initial.connectionId,
            jobId: initial.jobId,
          }).state,
        });
      } catch {
        // The send never started, so this remains a non-delivery outcome even
        // when the durable record itself cannot be written.
      }
      this.sendControl(source, job, "unavailable", "not-delivered");
      return;
    }
    let delivered: RelayDeliveryState;
    try {
      target.send(new TextDecoder().decode(encodeRelayEnvelope(job, sourceAttachment.repository)));
      delivered = applyRelayDeliveryEvent(initial, {
        version: initial.version,
        type: "deliver",
        connectionId: initial.connectionId,
        jobId: initial.jobId,
      }).state;
    } catch {
      try {
        await this.saveRecord({
          ...record,
          state: applyRelayDeliveryEvent(initial, {
            version: initial.version,
            type: "disconnect",
            connectionId: initial.connectionId,
            jobId: initial.jobId,
          }).state,
        });
      } catch {
        // No send occurred, so failure to persist cannot turn this into a
        // delivered exchange.
      }
      this.sendControl(source, job, "unavailable", "not-delivered");
      return;
    }
    try {
      await this.saveRecord({ ...record, state: delivered });
    } catch {
      // A successful WebSocket send is irrevocably ambiguous if durable
      // delivery evidence cannot be recorded. Never report it as retryable.
      const ambiguous = applyRelayDeliveryEvent(delivered, {
        version: delivered.version,
        type: "disconnect",
        connectionId: delivered.connectionId,
        jobId: delivered.jobId,
      }).state;
      try {
        await this.saveRecord({ ...record, state: ambiguous });
      } catch {
        // The source still receives an ambiguity signal even if recovery state
        // cannot be persisted during the same storage outage.
      }
      this.sendControl(source, job, "delivered-ambiguous", "delivered-ambiguous");
    }
  }

  private async receiveResult(
    runtime: RepositoryRelayWebSocket,
    attachment: RuntimeConnectionAttachment,
    resultEnvelope: Extract<RelayEnvelope, { kind: "result" }>,
  ): Promise<void> {
    if (
      !attachment.authenticated ||
      attachment.connectionId !== resultEnvelope.connectionId ||
      !this.isCurrentRuntime(runtime, attachment)
    )
      return this.close(runtime, 1008, "Runtime binding mismatch.");
    const record = await this.record(resultEnvelope.jobId);
    if (
      record === undefined ||
      record.targetConnectionId !== attachment.connectionId ||
      record.targetGeneration !== attachment.generation
    )
      return;
    const digest = await digestPayload(resultEnvelope.resultPayload);
    const event: RelayDeliveryEvent = {
      version: record.state.version,
      type: "result",
      connectionId: record.state.connectionId,
      jobId: record.state.jobId,
      resultDigest: digest,
    };
    const reduction = applyRelayDeliveryEvent(record.state, event);
    await this.saveRecord({ ...record, state: reduction.state });
    this.emitTelemetry({
      occurredAtMs: this.now(),
      kind: "delivery",
      surface: "durable-object",
      repository: record.repository,
      connectionId: record.targetConnectionId,
      jobId: record.state.jobId,
      deliveryState: reduction.state.phase,
    });
    if (reduction.transition === "applied") {
      this.forwardToSource(record, encodeRelayEnvelope(resultEnvelope, record.repository));
    }
  }

  private async receiveControl(
    runtime: RepositoryRelayWebSocket,
    attachment: RuntimeConnectionAttachment,
    control: Extract<RelayEnvelope, { kind: "control" }>,
  ): Promise<void> {
    if (
      !attachment.authenticated ||
      attachment.connectionId !== control.connectionId ||
      !this.isCurrentRuntime(runtime, attachment)
    )
      return this.close(runtime, 1008, "Runtime binding mismatch.");
    const record = await this.record(control.jobId);
    if (
      record === undefined ||
      record.targetConnectionId !== attachment.connectionId ||
      record.targetGeneration !== attachment.generation
    )
      return;
    await this.applyEvent(record, eventForControl(record.state, control));
    this.emitTelemetry({
      occurredAtMs: this.now(),
      kind: "delivery",
      surface: "durable-object",
      repository: record.repository,
      connectionId: record.targetConnectionId,
      jobId: record.state.jobId,
      deliveryState: control.deliveryState === "delivered-ambiguous" ? "possibly-delivered" : control.deliveryState,
      failureClass:
        control.deliveryState === "delivered-ambiguous"
          ? "disconnected"
          : control.deliveryState === "expired"
            ? "expired"
            : "none",
    });
    this.forwardToSource(record, encodeRelayEnvelope(control, record.repository));
  }

  private async applyEvent(record: StoredJobRecord, event: RelayDeliveryEvent): Promise<void> {
    const reduction = applyRelayDeliveryEvent(record.state, event);
    await this.saveRecord({ ...record, state: reduction.state });
  }

  private async reapNonces(now: number): Promise<void> {
    const storedNonces = await this.state.storage.get<StoredNonceRecord[] | string[]>(NONCE_KEY);
    if (!Array.isArray(storedNonces)) return;
    const active = storedNonces
      .map((entry): StoredNonceRecord | undefined => {
        if (typeof entry === "string") return undefined;
        if (
          !isRecord(entry) ||
          typeof entry.nonce !== "string" ||
          !Number.isSafeInteger(entry.expiresAtMs) ||
          (entry.expiresAtMs as number) <= now
        ) {
          return undefined;
        }
        return { nonce: entry.nonce, expiresAtMs: entry.expiresAtMs as number };
      })
      .filter((entry): entry is StoredNonceRecord => entry !== undefined)
      .slice(-MAX_USED_NONCES);
    if (active.length === 0) await this.state.storage.delete?.(NONCE_KEY);
    else await this.state.storage.put(NONCE_KEY, active);
    if (active.length !== storedNonces.length) {
      this.emitTelemetry({
        occurredAtMs: now,
        kind: "cleanup",
        surface: "durable-object",
        repository: this.repository,
        failureClass: "expired",
      });
    }
  }

  private async reapJobs(now: number): Promise<void> {
    for (const record of await this.records()) {
      if (now >= record.retainedUntilMs) {
        await this.state.storage.delete?.(jobKey(record.state.jobId));
        this.emitTelemetry({
          occurredAtMs: now,
          kind: "cleanup",
          surface: "durable-object",
          repository: record.repository,
          connectionId: record.targetConnectionId,
          jobId: record.state.jobId,
          deliveryState: record.state.phase,
          counters: {
            connections: this.activeConnectionCount(),
            inFlightJobs: 0,
            retainedJobs: 0,
            messagesInWindow: 0,
          },
        });
        continue;
      }
      if (record.deadlineAtMs > now) continue;
      if (
        record.state.phase !== "queued" &&
        record.state.phase !== "delivered" &&
        record.state.phase !== "acknowledged" &&
        record.state.phase !== "unavailable"
      ) {
        continue;
      }
      await this.applyEvent(record, {
        version: record.state.version,
        type: "expire",
        connectionId: record.state.connectionId,
        jobId: record.state.jobId,
      });
      this.emitTelemetry({
        occurredAtMs: now,
        kind: "cleanup",
        surface: "durable-object",
        repository: record.repository,
        connectionId: record.targetConnectionId,
        jobId: record.state.jobId,
        deliveryState: record.state.phase,
        failureClass: "expired",
      });
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    if (this.state.storage.setAlarm === undefined) return;
    let next = Number.POSITIVE_INFINITY;
    for (const socket of this.state.getWebSockets()) {
      const attachment = this.attachmentOf(socket);
      if (attachment !== undefined) next = Math.min(next, attachment.expiresAtMs);
    }
    for (const record of await this.records()) next = Math.min(next, record.retainedUntilMs, record.deadlineAtMs);
    const storedNonces = await this.state.storage.get<StoredNonceRecord[]>(NONCE_KEY);
    for (const entry of storedNonces ?? []) {
      if (isRecord(entry) && Number.isSafeInteger(entry.expiresAtMs)) {
        next = Math.min(next, entry.expiresAtMs as number);
      }
    }
    if (Number.isFinite(next)) await this.state.storage.setAlarm(next);
  }

  private async record(jobId: string): Promise<StoredJobRecord | undefined> {
    const value = await this.state.storage.get<StoredJobRecord>(jobKey(jobId));
    if (!isRecord(value) || value.version !== JOB_RECORD_VERSION || !isRecord(value.state)) return undefined;
    try {
      const state = deserializeRelayDeliveryState(JSON.stringify(value.state));
      return {
        version: JOB_RECORD_VERSION,
        repository: normalizeRelayRepositoryIdentity(value.repository),
        sourceConnectionId: String(value.sourceConnectionId),
        targetConnectionId: String(value.targetConnectionId),
        ...(Number.isSafeInteger(value.targetGeneration) &&
        (value.targetGeneration as number) >= 1 &&
        (value.targetGeneration as number) <= MAX_RUNTIME_GENERATION
          ? { targetGeneration: value.targetGeneration as number }
          : {}),
        deadlineAtMs: Number(value.deadlineAtMs),
        retainedUntilMs:
          Number.isSafeInteger(value.retainedUntilMs) && (value.retainedUntilMs as number) > 0
            ? (value.retainedUntilMs as number)
            : Number(value.deadlineAtMs) + this.limits.jobRetentionMs,
        state,
      };
    } catch {
      return undefined;
    }
  }

  private async records(): Promise<StoredJobRecord[]> {
    if (this.state.storage.list === undefined) return [];
    const listed = await this.state.storage.list<StoredJobRecord>({
      prefix: JOB_PREFIX,
      limit: Math.min(MAX_STORED_JOBS + 1, this.limits.maxRetainedJobs + 1),
    });
    const records: StoredJobRecord[] = [];
    for (const value of listed.values()) {
      const parsed = await this.record(value.state?.jobId ?? "");
      if (parsed !== undefined) records.push(parsed);
    }
    return records;
  }

  private async saveRecord(record: StoredJobRecord): Promise<void> {
    await this.state.storage.put(jobKey(record.state.jobId), {
      version: JOB_RECORD_VERSION,
      repository: record.repository,
      sourceConnectionId: record.sourceConnectionId,
      targetConnectionId: record.targetConnectionId,
      ...(record.targetGeneration === undefined ? {} : { targetGeneration: record.targetGeneration }),
      deadlineAtMs: record.deadlineAtMs,
      retainedUntilMs: record.retainedUntilMs,
      state: JSON.parse(serializeRelayDeliveryState(record.state)) as RelayDeliveryState,
    } satisfies StoredJobRecord);
    await this.state.storage.setAlarm?.(record.deadlineAtMs);
  }

  private forwardToSource(record: StoredJobRecord, payload: Uint8Array): void {
    const source = this.state.getWebSockets("client").find((candidate) => {
      const attachment = this.attachmentOf(candidate);
      return (
        attachment?.connectionId === record.sourceConnectionId &&
        attachment.repository.repositoryId === record.repository.repositoryId &&
        attachment.repository.repositoryHost === record.repository.repositoryHost
      );
    });
    if (source !== undefined && isOpen(source)) source.send(payload);
  }

  private sendControl(
    source: RepositoryRelayWebSocket,
    job: RelayJobEnvelope,
    state: "unavailable" | "expired" | "delivered-ambiguous",
    certainty: "not-delivered" | "delivered-ambiguous",
  ): void {
    const envelope = {
      version: job.version,
      kind: "control" as const,
      repository: job.repository,
      connectionId: job.connectionId,
      jobId: job.jobId,
      deliveryState: state,
      deliveryCertainty: certainty,
    };
    source.send(encodeRelayEnvelope(envelope, job.repository));
  }

  private close(webSocket: RepositoryRelayWebSocket, code: number, reason: string): void {
    webSocket.close?.(code, reason);
  }
}

export default RepositoryRelayDurableObject;
