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
  RELAY_INTERNAL_DISPATCH_PATH,
  RepositoryRelayDurableObject,
  repositoryRelayDurableObjectId,
  type RelayDurableObjectNamespaceLike,
} from "./relay/cloudflare-repository-relay.js";
import {
  createRelayBackedSessionExecutor,
  type RepositoryRelayDispatchPort,
  type RepositoryRelayDispatchRequest,
} from "./mcp/relay-session-executor.js";
import { createInariMcpHttpHandler } from "./mcp/http-transport.js";
import { createDirectAppHttpHandler, DIRECT_APP_EXECUTE_PATH } from "./agent-authority/direct-app-http.js";
import { jsonResponse, methodNotAllowed, safePathname } from "./worker-http.js";
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
import { ENDPOINT_ONBOARDING_PATH } from "./endpoint-onboarding.js";
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
  const internalUrl = new URL(`https://inari-relay.internal${RELAY_INTERNAL_DISPATCH_PATH}`);
  internalUrl.searchParams.set("repositoryId", repository.repositoryId);
  internalUrl.searchParams.set("repositoryHost", repository.repositoryHost);
  internalUrl.searchParams.set("connectionId", sourceConnectionId);
  const response = await stub.fetch(
    new Request(internalUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: new TextDecoder().decode(encodeRelayEnvelope(job, repository)),
      signal,
    }),
  );
  if (!response.ok) throw new Error("Repository Relay dispatch request failed.");
  let envelope: RelayEnvelope;
  try {
    envelope = decodeRelayEnvelope(await response.text(), repository);
  } catch {
    throw new Error("Repository Relay returned an invalid dispatch result.");
  }
  if (envelope.kind !== "result" && envelope.kind !== "control") {
    throw new Error("Repository Relay returned an invalid dispatch result.");
  }
  emit({
    occurredAtMs: Date.now(),
    kind: "delivery",
    surface: "hosted-worker",
    connectionId: sourceConnectionId,
    jobId,
    deliveryState:
      envelope.kind === "result"
        ? "terminal-result"
        : envelope.deliveryState === "delivered-ambiguous"
          ? "possibly-delivered"
          : envelope.deliveryState,
    failureClass:
      envelope.kind === "control" && envelope.deliveryState === "delivered-ambiguous"
        ? "disconnected"
        : envelope.kind === "control" && envelope.deliveryState === "expired"
          ? "expired"
          : "none",
  });
  return envelope;
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

/**
 * Same frozen #377 direct-App wire contract as the standalone `worker.ts`
 * deployment, but backed by the Relay-dispatched session executor instead of
 * a Worker-held GitHub App key: execution still requires a connected Runtime.
 */
async function execute(request: Request, env: Env): Promise<Response> {
  try {
    return await createDirectAppHttpHandler({ executor: createHostedMcpSessionExecutor(env) })(request);
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
  if (pathname === ENDPOINT_ONBOARDING_PATH) return false;
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

async function staticAsset(request: Request, env: Env, pathname: string): Promise<Response> {
  if (workerFirstPath(pathname) || env.ASSETS === undefined) {
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
    const pathname = safePathname(request.url);
    if (pathname === undefined) return jsonResponse(400, { ok: false, error: { code: "MALFORMED_REQUEST" } });
    if (pathname === "/healthz") return request.method === "GET" ? healthz(env) : methodNotAllowed("GET");
    if (pathname === HOSTED_ENDPOINT_OAUTH_EXCHANGE_PATH) return oauthExchange(request, env);
    if (pathname === ENDPOINT_HTTP_PATH) return endpoint(request, env);
    if (pathname === ENDPOINT_WEBHOOK_PATH) return webhook(request, env);
    if (pathname === "/mcp") return mcp(request, env);
    if (pathname === DIRECT_APP_EXECUTE_PATH) return execute(request, env);
    if (pathname === "/v1/relay/connect") return relayConnect(request, env);
    return staticAsset(request, env, pathname);
  },
};

export { RepositoryRelayDurableObject };
export {
  createHostedEndpointPresenceReader,
  HostedEndpointPresenceReader,
  RELAY_RUNTIME_PRESENCE_INTERNAL_METHOD,
  RELAY_RUNTIME_PRESENCE_INTERNAL_PATH,
} from "./hosted-endpoint-presence-reader.js";
