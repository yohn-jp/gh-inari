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
  verifyRelayPossessionProof,
  verifySessionCertificateConnectionBinding,
  type RelayConnectionKeyBinding,
  type RelayPossessionProofChallenge,
} from "./connection-proof.js";
import {
  applyRelayDeliveryEvent,
  createRelayDeliveryState,
  deserializeRelayDeliveryState,
  isRelayDeliveryRetryable,
  serializeRelayDeliveryState,
  type RelayDeliveryEvent,
  type RelayDeliveryState,
} from "./delivery-state.js";

/** Cloudflare provides this global in a Worker; it is absent from Node types. */
declare const WebSocketPair: new () => [WebSocket, WebSocket];

const JSON_ENCODER = new TextEncoder();
const JSON_DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_STORED_JOBS = 32;
const MAX_USED_NONCES = 128;
const MAX_MESSAGE_BYTES = 65_536;
const CONNECTION_ATTACHMENT_VERSION = 1 as const;
const JOB_RECORD_VERSION = 1 as const;
const RELAY_HANDSHAKE_KIND = "repository-relay-possession-challenge";
const RELAY_HANDSHAKE_RESPONSE_KIND = "repository-relay-possession-response";
const RELAY_HEARTBEAT_REQUEST = "relay:ping";
const RELAY_HEARTBEAT_RESPONSE = "relay:pong";
const JOB_PREFIX = "relay:job:";
const NONCE_KEY = "relay:used-nonces";

type RelayRole = "runtime" | "client";

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
  setWebSocketAutoResponse?(pair: { readonly request: string; readonly response: string } | null): void;
  waitUntil?(promise: Promise<unknown>): void;
}

export interface RepositoryRelayDurableObjectEnvironment {
  /** Optional immutable identity supplied by the Worker binding. */
  readonly repository?: RelayRepositoryIdentity;
  readonly REPOSITORY?: RelayRepositoryIdentity;
}

export interface RepositoryRelayDurableObjectOptions {
  /** Identity is normally supplied by the Worker binding or the request URL. */
  readonly repository?: RelayRepositoryIdentity;
  readonly now?: () => number;
  readonly randomNonce?: () => string;
}

interface RuntimeConnectionAttachment {
  readonly version: typeof CONNECTION_ATTACHMENT_VERSION;
  readonly role: RelayRole;
  readonly repository: RelayRepositoryIdentity;
  readonly connectionId: string;
  readonly delegatorId?: string;
  readonly challenge?: RelayPossessionProofChallenge;
  readonly binding?: RelayConnectionKeyBinding;
  readonly authenticated: boolean;
}

interface StoredJobRecord {
  readonly version: typeof JOB_RECORD_VERSION;
  readonly repository: RelayRepositoryIdentity;
  readonly sourceConnectionId: string;
  readonly targetConnectionId: string;
  readonly deadlineAtMs: number;
  readonly state: RelayDeliveryState;
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

  constructor(
    private readonly state: RepositoryRelayDurableObjectState,
    env: RepositoryRelayDurableObjectEnvironment = {} as RepositoryRelayDurableObjectEnvironment,
    options: RepositoryRelayDurableObjectOptions = {},
  ) {
    const configured = options.repository ?? env.repository ?? env.REPOSITORY;
    this.repository = configured === undefined ? undefined : normalizeRelayRepositoryIdentity(configured);
    this.now = options.now ?? Date.now;
    this.randomNonce = options.randomNonce ?? nonce;
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
    };
    this.state.acceptWebSocket(server, [role]);
    server.serializeAttachment?.(attachment);
    this.state.setWebSocketAutoResponse?.({ request: RELAY_HEARTBEAT_REQUEST, response: RELAY_HEARTBEAT_RESPONSE });
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
      const response = new Response(null, { status: 101 }) as Response & { webSocket?: WebSocket };
      response.webSocket = pair[0];
      return response;
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
    const text = asText(message);
    if (text === undefined) return this.close(webSocket, 1009, "Message exceeds relay bounds.");
    if (attachment.role === "runtime" && !attachment.authenticated) {
      return this.admitRuntime(webSocket, attachment, text);
    }
    let envelope: RelayEnvelope;
    try {
      envelope = decodeRelayEnvelope(text, attachment.repository);
    } catch {
      return this.close(webSocket, 1008, "Malformed relay envelope.");
    }
    if (envelope.kind === "job") return this.receiveJob(webSocket, attachment, envelope);
    if (envelope.kind === "result") return this.receiveResult(webSocket, attachment, envelope);
    if (envelope.kind === "control") return this.receiveControl(webSocket, attachment, envelope);
    this.close(webSocket, 1008, "Unsupported relay message.");
  }

  async webSocketClose(webSocket: RepositoryRelayWebSocket): Promise<void> {
    const attachment = this.attachmentOf(webSocket);
    if (attachment === undefined) return;
    const records = await this.records();
    for (const record of records) {
      if (record.targetConnectionId !== attachment.connectionId) continue;
      await this.applyEvent(record, {
        version: record.state.version,
        type: "disconnect",
        connectionId: record.state.connectionId,
        jobId: record.state.jobId,
      });
    }
  }

  async webSocketError(webSocket: RepositoryRelayWebSocket): Promise<void> {
    await this.webSocketClose(webSocket);
  }

  async alarm(): Promise<void> {
    const now = this.now();
    for (const record of await this.records()) {
      if (record.deadlineAtMs > now) continue;
      const event: RelayDeliveryEvent = {
        version: record.state.version,
        type: "expire",
        connectionId: record.state.connectionId,
        jobId: record.state.jobId,
      };
      await this.applyEvent(record, event);
    }
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
        authenticated: value.authenticated === true,
      };
    } catch {
      return undefined;
    }
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
      const usedNonces = new Set((await this.state.storage.get<string[]>(NONCE_KEY)) ?? []);
      const result = verifyRelayPossessionProof(attachment.challenge, response, { nowMs: this.now(), usedNonces });
      if (!result.valid || result.value === undefined) return this.close(webSocket, 1008, "Invalid possession proof.");
      await this.state.storage.put(NONCE_KEY, [...usedNonces].slice(-MAX_USED_NONCES));
      const authenticatedAttachment: RuntimeConnectionAttachment = {
        ...attachment,
        binding: result.value,
        authenticated: true,
      };
      webSocket.serializeAttachment?.(authenticatedAttachment);
      webSocket.send(
        JSON.stringify({ type: "repository-relay-connected", version: 1, connectionId: attachment.connectionId }),
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
    const certificate = sessionCertificateFromJob(job);
    const runtimes = this.state.getWebSockets("runtime");
    const target = runtimes.find((candidate) => {
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
    const initial = createRelayDeliveryState({ connectionId: job.connectionId, jobId: job.jobId });
    const record: StoredJobRecord = {
      version: JOB_RECORD_VERSION,
      repository: sourceAttachment.repository,
      sourceConnectionId: sourceAttachment.connectionId,
      targetConnectionId: job.connectionId,
      deadlineAtMs: this.now() + job.deadlineMs,
      state: initial,
    };
    if (target === undefined || !isOpen(target)) {
      await this.saveRecord({
        ...record,
        state: applyRelayDeliveryEvent(initial, {
          version: initial.version,
          type: "disconnect",
          connectionId: initial.connectionId,
          jobId: initial.jobId,
        }).state,
      });
      this.sendControl(source, job, "unavailable", "not-delivered");
      return;
    }
    try {
      target.send(new TextDecoder().decode(encodeRelayEnvelope(job, sourceAttachment.repository)));
      const delivered = applyRelayDeliveryEvent(initial, {
        version: initial.version,
        type: "deliver",
        connectionId: initial.connectionId,
        jobId: initial.jobId,
      }).state;
      await this.saveRecord({ ...record, state: delivered });
    } catch {
      await this.saveRecord({
        ...record,
        state: applyRelayDeliveryEvent(initial, {
          version: initial.version,
          type: "disconnect",
          connectionId: initial.connectionId,
          jobId: initial.jobId,
        }).state,
      });
      this.sendControl(source, job, "unavailable", "not-delivered");
    }
  }

  private async receiveResult(
    runtime: RepositoryRelayWebSocket,
    attachment: RuntimeConnectionAttachment,
    resultEnvelope: Extract<RelayEnvelope, { kind: "result" }>,
  ): Promise<void> {
    if (!attachment.authenticated || attachment.connectionId !== resultEnvelope.connectionId)
      return this.close(runtime, 1008, "Runtime binding mismatch.");
    const record = await this.record(resultEnvelope.jobId);
    if (record === undefined || record.targetConnectionId !== attachment.connectionId) return;
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
    if (reduction.transition === "applied") {
      this.forwardToSource(record, encodeRelayEnvelope(resultEnvelope, record.repository));
    }
  }

  private async receiveControl(
    runtime: RepositoryRelayWebSocket,
    attachment: RuntimeConnectionAttachment,
    control: Extract<RelayEnvelope, { kind: "control" }>,
  ): Promise<void> {
    if (!attachment.authenticated || attachment.connectionId !== control.connectionId)
      return this.close(runtime, 1008, "Runtime binding mismatch.");
    const record = await this.record(control.jobId);
    if (record === undefined || record.targetConnectionId !== attachment.connectionId) return;
    await this.applyEvent(record, eventForControl(record.state, control));
    this.forwardToSource(record, encodeRelayEnvelope(control, record.repository));
  }

  private async applyEvent(record: StoredJobRecord, event: RelayDeliveryEvent): Promise<void> {
    const reduction = applyRelayDeliveryEvent(record.state, event);
    await this.saveRecord({ ...record, state: reduction.state });
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
        deadlineAtMs: Number(value.deadlineAtMs),
        state,
      };
    } catch {
      return undefined;
    }
  }

  private async records(): Promise<StoredJobRecord[]> {
    if (this.state.storage.list === undefined) return [];
    const listed = await this.state.storage.list<StoredJobRecord>({ prefix: JOB_PREFIX, limit: MAX_STORED_JOBS });
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
      deadlineAtMs: record.deadlineAtMs,
      state: JSON.parse(serializeRelayDeliveryState(record.state)) as RelayDeliveryState,
    } satisfies StoredJobRecord);
    await this.state.storage.setAlarm?.(record.deadlineAtMs);
  }

  private forwardToSource(record: StoredJobRecord, payload: Uint8Array): void {
    const source = this.state.getWebSockets("client").find((candidate) => {
      const attachment = this.attachmentOf(candidate);
      return (
        attachment?.connectionId === record.sourceConnectionId &&
        attachment.repository.repositoryId === record.repository.repositoryId
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
