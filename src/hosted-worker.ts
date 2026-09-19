/** Hosted Cloudflare composition for native MCP and the Repository Relay. */

import { base64UrlEncodeText } from "./agent-authority/codec.js";
import {
  MAX_RELAY_DEADLINE_MS,
  decodeRelayEnvelope,
  encodeRelayEnvelope,
  normalizeRelayRepositoryIdentity,
  type RelayEnvelope,
  type RelayJobEnvelope,
  type RelayRepositoryIdentity,
} from "./relay/contract.js";
import {
  repositoryRelayDurableObjectId,
  type RepositoryRelayWebSocket,
  type RelayDurableObjectNamespaceLike,
} from "./relay/cloudflare-repository-relay.js";
import {
  createRelayBackedSessionExecutor,
  type RepositoryRelayDispatchPort,
  type RepositoryRelayDispatchRequest,
} from "./mcp/relay-session-executor.js";
import { createInariMcpHttpHandler } from "./mcp/http-transport.js";
import type {
  CapabilityAuthorizedSessionExecutionResult,
  CapabilityAuthorizedSessionExecutor,
} from "./session-authorized-change-executor.js";

const DEFAULT_REPOSITORY_HOST = "github.com";
const SERVICE_NAME = "gh-inari-hosted-relay-worker";
const SERVICE_VERSION = "1";
const RUNTIME_ROLE = "runtime";
const UPGRADE = "websocket";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const DELEGATOR_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

export interface HostedDurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface HostedDurableObjectNamespace extends RelayDurableObjectNamespaceLike<unknown> {
  get(id: unknown): HostedDurableObjectStub;
}

export interface Env {
  readonly REPOSITORY_RELAY?: HostedDurableObjectNamespace;
  /** Non-secret provider host partition; the default is GitHub.com. */
  readonly INARI_HOSTED_REPOSITORY_HOST?: string;
}

type HostedWebSocket = RepositoryRelayWebSocket & {
  readonly accept?: () => void;
  addEventListener?: (type: "open" | "message" | "close" | "error", listener: (event: unknown) => void) => void;
  removeEventListener?: (type: "open" | "message" | "close" | "error", listener: (event: unknown) => void) => void;
  onopen?: ((event: unknown) => void) | null;
  onmessage?: ((event: unknown) => void) | null;
  onclose?: ((event: unknown) => void) | null;
  onerror?: ((event: unknown) => void) | null;
};

type UpgradeResponse = Response & { readonly webSocket?: HostedWebSocket };

function jsonResponse(status: number, body: Record<string, unknown>, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function methodNotAllowed(allow: string): Response {
  return new Response("Method not allowed.", { status: 405, headers: { allow, "cache-control": "no-store" } });
}

function serviceUnavailable(): Response {
  return jsonResponse(503, { ok: false, error: { code: "HOSTED_WORKER_UNAVAILABLE" } });
}

function hasRelayBinding(namespace: Env["REPOSITORY_RELAY"]): namespace is HostedDurableObjectNamespace {
  return namespace !== undefined && typeof namespace.idFromName === "function" && typeof namespace.get === "function";
}

function repositoryHost(env: Env): string {
  const configured = env.INARI_HOSTED_REPOSITORY_HOST ?? DEFAULT_REPOSITORY_HOST;
  return normalizeRelayRepositoryIdentity({ repositoryId: "1", repositoryHost: configured }).repositoryHost;
}

function repositoryFromRelayUrl(url: URL): RelayRepositoryIdentity | undefined {
  const repositoryId = url.searchParams.get("repositoryId");
  if (repositoryId === null) return undefined;
  try {
    return normalizeRelayRepositoryIdentity({
      repositoryId,
      repositoryHost: url.searchParams.get("repositoryHost") ?? DEFAULT_REPOSITORY_HOST,
    });
  } catch {
    return undefined;
  }
}

function stringParam(url: URL, key: string, pattern: RegExp): string | undefined {
  const value = url.searchParams.get(key);
  return value !== null && pattern.test(value) ? value : undefined;
}

function randomIdentifier(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? Date.now().toString(36)}`;
}

function frameText(event: unknown): string | undefined {
  const value =
    typeof event === "object" && event !== null && "data" in event
      ? (event as { readonly data?: unknown }).data
      : event;
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder("utf-8", { fatal: true }).decode(value);
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  return undefined;
}

function sessionRepository(envelope: unknown, host: string): RelayRepositoryIdentity | undefined {
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return undefined;
  const repositoryId = (envelope as { readonly repositoryId?: unknown }).repositoryId;
  if (typeof repositoryId !== "string") return undefined;
  try {
    return normalizeRelayRepositoryIdentity({ repositoryId, repositoryHost: host });
  } catch {
    return undefined;
  }
}

function unavailableExecution(): CapabilityAuthorizedSessionExecutionResult {
  return {
    version: 1,
    status: "failed",
    failure: {
      code: "SESSION_EXECUTION_FAILED",
      phase: "execution",
      message: "Hosted Repository Relay execution failed closed.",
    },
  };
}

function socketListener(
  socket: HostedWebSocket,
  type: "open" | "message" | "close" | "error",
  listener: (event: unknown) => void,
): () => void {
  if (socket.addEventListener !== undefined) {
    socket.addEventListener(type, listener);
    return () => socket.removeEventListener?.(type, listener);
  }
  const key = `on${type}` as "onopen" | "onmessage" | "onclose" | "onerror";
  socket[key] = listener;
  return () => {
    if (socket[key] === listener) socket[key] = null;
  };
}

async function dispatchThroughDurableObject(
  namespace: HostedDurableObjectNamespace | undefined,
  request: RepositoryRelayDispatchRequest,
  signal?: AbortSignal,
): Promise<RelayEnvelope> {
  if (!hasRelayBinding(namespace)) throw new Error("Repository Relay binding is unavailable.");
  const repository = normalizeRelayRepositoryIdentity(request.repository);
  const objectId = repositoryRelayDurableObjectId(namespace, repository);
  const stub = namespace.get(objectId);
  const sourceConnectionId = randomIdentifier("mcp");
  const jobId = randomIdentifier("job");
  const serialized = JSON.stringify(request.signedSessionEnvelope);
  if (serialized === undefined) throw new Error("Session envelope is not serializable.");
  const job: RelayJobEnvelope = {
    version: 1,
    kind: "job",
    repository,
    // #821 binds the dispatch to the certificate signer. Hosted Runtimes use
    // the same bounded value as their connectionId; no caller URL is used.
    connectionId: request.delegatorId,
    jobId,
    deliveryState: "pre-delivery",
    deadlineMs: MAX_RELAY_DEADLINE_MS,
    signedSessionRequest: base64UrlEncodeText(serialized),
  };
  const internalUrl = new URL("https://inari-relay.internal/v1/relay/connect");
  internalUrl.searchParams.set("repositoryId", repository.repositoryId);
  internalUrl.searchParams.set("repositoryHost", repository.repositoryHost);
  internalUrl.searchParams.set("role", "client");
  internalUrl.searchParams.set("connectionId", sourceConnectionId);
  const upgrade = new Request(internalUrl, { method: "GET", headers: { upgrade: UPGRADE }, signal });
  const response = (await stub.fetch(upgrade)) as UpgradeResponse;
  const socket = response.webSocket;
  if (socket === undefined) throw new Error("Repository Relay did not accept the internal connection.");
  socket.accept?.();

  return new Promise<RelayEnvelope>((resolve, reject) => {
    let settled = false;
    let sent = false;
    const cleanups: Array<() => void> = [];
    const finish = (error?: Error, envelope?: RelayEnvelope): void => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      socket.close?.(1000, "dispatch-complete");
      if (error !== undefined) reject(error);
      else if (envelope !== undefined) resolve(envelope);
      else reject(new Error("Repository Relay closed before a result."));
    };
    const onMessage = (event: unknown): void => {
      let text: string | undefined;
      try {
        text = frameText(event);
      } catch {
        return;
      }
      if (text === undefined) return;
      try {
        const envelope = decodeRelayEnvelope(text, repository);
        if (envelope.kind === "result" || envelope.kind === "control") finish(undefined, envelope);
      } catch {
        // Ignore non-contract frames at this internal transport boundary.
      }
    };
    const onClosed = (): void => finish(new Error("Repository Relay connection closed."));
    cleanups.push(socketListener(socket, "message", onMessage));
    cleanups.push(socketListener(socket, "close", onClosed));
    cleanups.push(socketListener(socket, "error", onClosed));
    const onAbort = (): void => finish(new Error("Repository Relay dispatch was aborted."));
    if (signal !== undefined) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onAbort));
    }
    const send = (): void => {
      if (sent || settled) return;
      sent = true;
      try {
        socket.send(new TextDecoder().decode(encodeRelayEnvelope(job, repository)));
      } catch {
        finish(new Error("Repository Relay dispatch could not be sent."));
      }
    };
    if (socket.readyState === 0) cleanups.push(socketListener(socket, "open", send));
    else send();
  });
}

export function createHostedRelayDispatch(
  namespace: HostedDurableObjectNamespace | undefined,
): RepositoryRelayDispatchPort {
  return Object.freeze({
    dispatch: (request: RepositoryRelayDispatchRequest, signal?: AbortSignal) =>
      dispatchThroughDurableObject(namespace, request, signal),
  });
}

export function createHostedMcpSessionExecutor(env: Env): CapabilityAuthorizedSessionExecutor {
  const host = repositoryHost(env);
  const dispatch = createHostedRelayDispatch(env.REPOSITORY_RELAY);
  return Object.freeze({
    async execute(envelope: unknown): Promise<CapabilityAuthorizedSessionExecutionResult> {
      const repository = sessionRepository(envelope, host);
      if (repository === undefined) return unavailableExecution();
      try {
        return await createRelayBackedSessionExecutor({ repository, dispatch }).execute(envelope);
      } catch {
        return unavailableExecution();
      }
    },
  });
}

function healthz(env: Env): Response {
  let configured = false;
  try {
    repositoryHost(env);
    configured = hasRelayBinding(env.REPOSITORY_RELAY);
  } catch {
    configured = false;
  }
  return jsonResponse(configured ? 200 : 503, {
    ok: configured,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    transport: "mcp-and-repository-relay",
  });
}

async function relayConnect(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  if (request.headers.get("upgrade")?.toLowerCase() !== UPGRADE) {
    return new Response("WebSocket upgrade required.", {
      status: 426,
      headers: { upgrade: UPGRADE, "cache-control": "no-store" },
    });
  }
  const url = new URL(request.url);
  const repository = repositoryFromRelayUrl(url);
  const connectionId = stringParam(url, "connectionId", IDENTIFIER_PATTERN);
  const delegatorId = stringParam(url, "delegatorId", DELEGATOR_PATTERN);
  const role = url.searchParams.get("role");
  if (
    repository === undefined ||
    connectionId === undefined ||
    delegatorId === undefined ||
    (role !== null && role !== RUNTIME_ROLE)
  ) {
    return new Response("Invalid Repository Relay connection.", {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }
  if (!hasRelayBinding(env.REPOSITORY_RELAY)) return serviceUnavailable();
  const objectId = repositoryRelayDurableObjectId(env.REPOSITORY_RELAY, repository);
  const stub = env.REPOSITORY_RELAY.get(objectId);
  const internalUrl = new URL("https://inari-relay.internal/v1/relay/connect");
  internalUrl.searchParams.set("repositoryId", repository.repositoryId);
  internalUrl.searchParams.set("repositoryHost", repository.repositoryHost);
  internalUrl.searchParams.set("role", RUNTIME_ROLE);
  internalUrl.searchParams.set("connectionId", connectionId);
  internalUrl.searchParams.set("delegatorId", delegatorId);
  try {
    return await stub.fetch(new Request(internalUrl, { method: "GET", headers: { upgrade: UPGRADE } }));
  } catch {
    return serviceUnavailable();
  }
}

async function mcp(request: Request, env: Env): Promise<Response> {
  try {
    return await createInariMcpHttpHandler({ sessionExecutor: createHostedMcpSessionExecutor(env) })(request);
  } catch {
    return serviceUnavailable();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/healthz") return request.method === "GET" ? healthz(env) : methodNotAllowed("GET");
    if (pathname === "/mcp") return mcp(request, env);
    if (pathname === "/v1/relay/connect") return relayConnect(request, env);
    return new Response("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
  },
};
