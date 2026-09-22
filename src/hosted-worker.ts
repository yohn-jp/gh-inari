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
  RepositoryRelayDurableObject,
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
import {
  DEFAULT_RELAY_TELEMETRY_SINK,
  createRelayTelemetryEvent,
  recordRelayTelemetry,
  type RelayTelemetrySink,
} from "./relay/telemetry.js";
import {
  ENDPOINT_ONBOARDING_PATH,
  createEndpointOnboardingDescriptor,
  type EndpointOnboardingDescriptorInput,
} from "./endpoint-onboarding.js";
import {
  ENDPOINT_WEBHOOK_PATH,
  createEndpointWebhookHandler,
  type EndpointWebhookHandlerOptions,
} from "./endpoint-webhook.js";
import type { EndpointIdentity } from "./endpoint-authorization.js";
import { createEndpointHttpHandler, ENDPOINT_HTTP_PATH, type EndpointHttpHandler } from "./endpoint-http.js";
import type { EndpointApi } from "./endpoint-api.js";
import { createHostedEndpoint, type HostedEndpointOptions } from "./hosted-endpoint.js";
import {
  createHostedEndpointOAuthHandler,
  HOSTED_ENDPOINT_OAUTH_EXCHANGE_PATH,
  type HostedEndpointOAuthOptions,
  type HostedEndpointOAuthHandler,
} from "./hosted-endpoint-oauth.js";

const DEFAULT_REPOSITORY_HOST = "github.com";
const SERVICE_NAME = "gh-inari-hosted-relay-worker";
const SERVICE_VERSION = "1";
const RUNTIME_ROLE = "runtime";
const UPGRADE = "websocket";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const DELEGATOR_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const HOSTED_WEBHOOK_HANDLERS = new WeakMap<object, ReturnType<typeof createEndpointWebhookHandler>>();
const HOSTED_ENDPOINT_HANDLERS = new WeakMap<object, EndpointHttpHandler>();
const HOSTED_OAUTH_HANDLERS = new WeakMap<object, HostedEndpointOAuthHandler>();

export interface HostedDurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface HostedDurableObjectNamespace extends RelayDurableObjectNamespaceLike<unknown> {
  get(id: unknown): HostedDurableObjectStub;
}

export interface HostedStaticAssets {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  readonly REPOSITORY_RELAY?: HostedDurableObjectNamespace;
  readonly ASSETS?: HostedStaticAssets;
  /** Non-secret provider host partition; the default is GitHub.com. */
  readonly INARI_HOSTED_REPOSITORY_HOST?: string;
  /** Non-secret public GitHub App numeric identity. */
  readonly INARI_GITHUB_APP_ID?: string;
  /** Non-secret public GitHub App OAuth client identity. */
  readonly INARI_GITHUB_APP_CLIENT_ID?: string;
  /** Non-secret public GitHub App slug. */
  readonly INARI_GITHUB_APP_SLUG?: string;
  /** Non-secret public GitHub App installation URL. */
  readonly INARI_GITHUB_APP_INSTALLATION_URL?: string;
  /** Non-secret supported App-user authentication profile. */
  readonly INARI_GITHUB_APP_USER_AUTH_PROFILE?: string;
  /** Exact public browser callback URI for the App Authorization Code flow. */
  readonly INARI_GITHUB_APP_CALLBACK_URL?: string;
  /** Confidential App OAuth client secret; never returned by this worker. */
  readonly INARI_GITHUB_APP_CLIENT_SECRET?: string;
  /** Non-secret Endpoint identity used to bind webhook deliveries. */
  readonly INARI_ENDPOINT_ID?: string;
  readonly INARI_ENDPOINT_DEPLOYMENT?: "shared-hosted" | "self-hosted";
  /** Webhook secret is a Worker secret and is never returned by this module. */
  readonly INARI_GITHUB_WEBHOOK_SECRET?: string;
  /** Optional runtime injection for self-hosted composition and tests. */
  readonly endpointWebhook?: EndpointWebhookHandlerOptions;
  /** Explicit self-hosted/test Endpoint API injection; hosted production composes its own API. */
  readonly endpointApi?: EndpointApi;
  /** Optional self-hosted OAuth composition for tests and alternate deployments. */
  readonly endpointOAuth?: HostedEndpointOAuthOptions;
  readonly telemetry?: RelayTelemetrySink;
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

function jsonResponse(status: number, body: object, headers?: HeadersInit): Response {
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

function emitHostedTelemetry(
  sink: RelayTelemetrySink | undefined,
  input: Omit<Parameters<typeof createRelayTelemetryEvent>[0], "repository">,
  repository: RelayRepositoryIdentity,
): void {
  void recordRelayTelemetry(sink, createRelayTelemetryEvent({ ...input, repository }));
}

function hasRelayBinding(namespace: Env["REPOSITORY_RELAY"]): namespace is HostedDurableObjectNamespace {
  return namespace !== undefined && typeof namespace.idFromName === "function" && typeof namespace.get === "function";
}

function repositoryHost(env: Env): string {
  const configured = env.INARI_HOSTED_REPOSITORY_HOST ?? DEFAULT_REPOSITORY_HOST;
  return normalizeRelayRepositoryIdentity({ repositoryId: "1", repositoryHost: configured }).repositoryHost;
}

function repositoryFromRelayUrl(url: URL, configuredHost: string): RelayRepositoryIdentity | undefined {
  const repositoryId = url.searchParams.get("repositoryId");
  if (repositoryId === null) return undefined;
  const requestedHost = url.searchParams.get("repositoryHost");
  if (requestedHost !== null && requestedHost.toLowerCase() !== configuredHost) return undefined;
  try {
    return normalizeRelayRepositoryIdentity({
      repositoryId,
      repositoryHost: configuredHost,
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
  telemetry?: RelayTelemetrySink,
): Promise<RelayEnvelope> {
  if (!hasRelayBinding(namespace)) throw new Error("Repository Relay binding is unavailable.");
  const repository = normalizeRelayRepositoryIdentity(request.repository);
  const objectId = repositoryRelayDurableObjectId(namespace, repository);
  const stub = namespace.get(objectId);
  const sourceConnectionId = randomIdentifier("mcp");
  const jobId = randomIdentifier("job");
  const emit = (input: Omit<Parameters<typeof createRelayTelemetryEvent>[0], "repository">): void => {
    const pending = recordRelayTelemetry(telemetry, createRelayTelemetryEvent({ ...input, repository }));
    void pending;
  };
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
  emit({
    occurredAtMs: Date.now(),
    kind: "job",
    surface: "hosted-worker",
    connectionId: sourceConnectionId,
    jobId,
  });
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
      if (envelope !== undefined) {
        emit({
          occurredAtMs: Date.now(),
          kind: "delivery",
          surface: "hosted-worker",
          connectionId: sourceConnectionId,
          jobId,
          deliveryState:
            envelope.kind === "result"
              ? "terminal-result"
              : envelope.kind === "control"
                ? envelope.deliveryState === "delivered-ambiguous"
                  ? "possibly-delivered"
                  : envelope.deliveryState
                : undefined,
          failureClass:
            envelope.kind === "control" && envelope.deliveryState === "delivered-ambiguous"
              ? "disconnected"
              : envelope.kind === "control" && envelope.deliveryState === "expired"
                ? "expired"
                : "none",
        });
      }
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
  telemetry: RelayTelemetrySink = DEFAULT_RELAY_TELEMETRY_SINK,
): RepositoryRelayDispatchPort {
  return Object.freeze({
    dispatch: (request: RepositoryRelayDispatchRequest, signal?: AbortSignal) =>
      dispatchThroughDurableObject(namespace, request, signal, telemetry),
  });
}

export function createHostedMcpSessionExecutor(env: Env): CapabilityAuthorizedSessionExecutor {
  const host = repositoryHost(env);
  const dispatch = createHostedRelayDispatch(env.REPOSITORY_RELAY, env.telemetry ?? DEFAULT_RELAY_TELEMETRY_SINK);
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

function onboardingUnavailable(): Response {
  return jsonResponse(503, {
    version: 1,
    ok: false,
    error: { code: "ENDPOINT_ONBOARDING_NOT_CONFIGURED" },
  });
}

function onboardingRelayConnectionBase(request: Request): string | undefined {
  try {
    const origin = new URL(request.url);
    if (origin.protocol !== "https:" || origin.username !== "" || origin.password !== "") return undefined;
    origin.protocol = "wss:";
    origin.pathname = "/v1/relay/connect";
    origin.search = "";
    origin.hash = "";
    return origin.toString();
  } catch {
    return undefined;
  }
}

function onboarding(request: Request, env: Env): Response {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const relayConnectionBase = onboardingRelayConnectionBase(request);
  if (relayConnectionBase === undefined) return onboardingUnavailable();
  const input: EndpointOnboardingDescriptorInput = {
    githubHost: env.INARI_HOSTED_REPOSITORY_HOST ?? DEFAULT_REPOSITORY_HOST,
    appId: env.INARI_GITHUB_APP_ID ?? "",
    appClientId: env.INARI_GITHUB_APP_CLIENT_ID ?? "",
    appSlug: env.INARI_GITHUB_APP_SLUG ?? "",
    appInstallationUrl: env.INARI_GITHUB_APP_INSTALLATION_URL ?? "",
    appUserAuthProfile: env.INARI_GITHUB_APP_USER_AUTH_PROFILE ?? "",
    relayConnectionBase,
    ...(env.INARI_GITHUB_APP_CALLBACK_URL === undefined ? {} : { appCallbackUrl: env.INARI_GITHUB_APP_CALLBACK_URL }),
  };
  try {
    return jsonResponse(200, createEndpointOnboardingDescriptor(input));
  } catch {
    return onboardingUnavailable();
  }
}

function oauthOptions(env: Env): HostedEndpointOAuthOptions | undefined {
  if (env.endpointOAuth !== undefined) return env.endpointOAuth;
  if (
    env.INARI_GITHUB_APP_CLIENT_ID === undefined ||
    env.INARI_GITHUB_APP_CLIENT_SECRET === undefined ||
    env.INARI_GITHUB_APP_CALLBACK_URL === undefined
  ) {
    return undefined;
  }
  return {
    clientId: env.INARI_GITHUB_APP_CLIENT_ID,
    clientSecret: env.INARI_GITHUB_APP_CLIENT_SECRET,
    redirectUri: env.INARI_GITHUB_APP_CALLBACK_URL,
    githubHost: env.INARI_HOSTED_REPOSITORY_HOST ?? DEFAULT_REPOSITORY_HOST,
  };
}

async function oauthExchange(request: Request, env: Env): Promise<Response> {
  let options: HostedEndpointOAuthOptions | undefined;
  try {
    options = oauthOptions(env);
  } catch {
    options = undefined;
  }
  if (options === undefined) return serviceUnavailable();
  const key = env as object;
  let handler = HOSTED_OAUTH_HANDLERS.get(key);
  if (handler === undefined) {
    try {
      handler = createHostedEndpointOAuthHandler(options);
    } catch {
      return serviceUnavailable();
    }
    HOSTED_OAUTH_HANDLERS.set(key, handler);
  }
  return handler(request);
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
  let configuredHost: string;
  try {
    configuredHost = repositoryHost(env);
  } catch {
    return new Response("Invalid Repository Relay connection.", {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }
  const repository = repositoryFromRelayUrl(url, configuredHost);
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
  const startedAtMs = Date.now();
  const telemetry = env.telemetry ?? DEFAULT_RELAY_TELEMETRY_SINK;
  try {
    const response = await stub.fetch(new Request(internalUrl, { method: "GET", headers: { upgrade: UPGRADE } }));
    emitHostedTelemetry(
      telemetry,
      {
        occurredAtMs: Date.now(),
        kind: "cpu-active",
        surface: "hosted-worker",
        connectionId,
        durationMs: Math.max(0, Date.now() - startedAtMs),
      },
      repository,
    );
    return response;
  } catch {
    emitHostedTelemetry(
      telemetry,
      {
        occurredAtMs: Date.now(),
        kind: "connection",
        surface: "hosted-worker",
        connectionId,
        failureClass: "transport",
        durationMs: Math.max(0, Date.now() - startedAtMs),
      },
      repository,
    );
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

function webhookOptions(env: Env): EndpointWebhookHandlerOptions | undefined {
  if (env.endpointWebhook !== undefined) return env.endpointWebhook;
  if (env.INARI_GITHUB_WEBHOOK_SECRET === undefined || env.INARI_ENDPOINT_ID === undefined) return undefined;
  const endpoint: EndpointIdentity = {
    version: 1,
    kind: "endpoint",
    id: env.INARI_ENDPOINT_ID,
    deployment: env.INARI_ENDPOINT_DEPLOYMENT ?? "shared-hosted",
  };
  return {
    admission: {
      endpoint,
      repositoryHost: repositoryHost(env),
      secret: env.INARI_GITHUB_WEBHOOK_SECRET,
    },
  };
}

async function webhook(request: Request, env: Env): Promise<Response> {
  let options: EndpointWebhookHandlerOptions | undefined;
  try {
    options = webhookOptions(env);
  } catch {
    options = undefined;
  }
  if (options === undefined) return serviceUnavailable();
  const key = env as object;
  let handler = HOSTED_WEBHOOK_HANDLERS.get(key);
  if (handler === undefined) {
    handler = createEndpointWebhookHandler(options);
    HOSTED_WEBHOOK_HANDLERS.set(key, handler);
  }
  return handler(request);
}

function hostedEndpointOptions(env: Env): HostedEndpointOptions | undefined {
  if (
    env.REPOSITORY_RELAY === undefined ||
    env.INARI_ENDPOINT_ID === undefined ||
    env.INARI_GITHUB_APP_ID === undefined
  ) {
    return undefined;
  }
  return {
    endpoint: {
      version: 1,
      kind: "endpoint",
      id: env.INARI_ENDPOINT_ID,
      deployment: env.INARI_ENDPOINT_DEPLOYMENT ?? "shared-hosted",
    },
    appId: env.INARI_GITHUB_APP_ID,
    presenceNamespace: env.REPOSITORY_RELAY,
  };
}

async function endpoint(request: Request, env: Env): Promise<Response> {
  const key = env as object;
  let handler = HOSTED_ENDPOINT_HANDLERS.get(key);
  if (handler === undefined) {
    try {
      if (env.endpointApi !== undefined) {
        handler = createEndpointHttpHandler({ api: env.endpointApi, path: ENDPOINT_HTTP_PATH });
      } else {
        const options = hostedEndpointOptions(env);
        if (options === undefined) return serviceUnavailable();
        handler = createHostedEndpoint(options);
      }
    } catch {
      return serviceUnavailable();
    }
    HOSTED_ENDPOINT_HANDLERS.set(key, handler);
  }
  return handler(request);
}

function workerFirstPath(pathname: string): boolean {
  return (
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/") ||
    pathname === "/v1" ||
    pathname.startsWith("/v1/") ||
    pathname === "/.well-known" ||
    pathname.startsWith("/.well-known/") ||
    pathname === "/healthz"
  );
}

async function staticAsset(request: Request, env: Env): Promise<Response> {
  if (workerFirstPath(new URL(request.url).pathname) || env.ASSETS === undefined) {
    return new Response("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
  }
  try {
    return await env.ASSETS.fetch(request);
  } catch {
    return serviceUnavailable();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/healthz") return request.method === "GET" ? healthz(env) : methodNotAllowed("GET");
    if (pathname === ENDPOINT_ONBOARDING_PATH) return onboarding(request, env);
    if (pathname === HOSTED_ENDPOINT_OAUTH_EXCHANGE_PATH) return oauthExchange(request, env);
    if (pathname === ENDPOINT_HTTP_PATH) return endpoint(request, env);
    if (pathname === ENDPOINT_WEBHOOK_PATH) return webhook(request, env);
    if (pathname === "/mcp") return mcp(request, env);
    if (pathname === "/v1/relay/connect") return relayConnect(request, env);
    return staticAsset(request, env);
  },
};

export { RepositoryRelayDurableObject };
export {
  createHostedEndpointPresenceReader,
  HostedEndpointPresenceReader,
  RELAY_RUNTIME_PRESENCE_INTERNAL_METHOD,
  RELAY_RUNTIME_PRESENCE_INTERNAL_PATH,
} from "./hosted-endpoint-presence-reader.js";
