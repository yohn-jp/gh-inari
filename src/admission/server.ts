/**
 * Admission server (#1107). Public Admission role entry for serving: the
 * bounded local Admission HTTP wire, mTLS enforcement and process startup.
 * Session admission and execution authorization are delegated to the private
 * authorization module; the Executor is reached only through the neutral
 * `LocalExecutorClient` protocol client. The server holds no provider
 * credential and no private signing key.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";
import type { Delegator } from "../agent-authority/delegator.js";
import type { AuthorizedExecution } from "../authorized-execution.js";
import { validateIssuerRepositoryIdentity, type RepositoryIdentity } from "../github/effect-authorizer.js";
import type { LocalAdmissionConfig } from "../local-control/config.js";
import { LocalExecutorClient } from "../local-control/executor-client.js";
import type { LocalExecutorEvidenceRequest } from "../local-control/executor-http.js";
import { validateExecutionIntent } from "../local-control/execution-intent.js";
import {
  clearLocalRuntimeEndpoint,
  publishLocalRuntimeEndpoint,
  requireLocalRuntimeEndpoint,
  type LocalRuntimeEndpoint,
} from "../local-control/runtime-discovery.js";
import { validateLocalSessionBinding } from "../local-control/session-binding.js";
import { createLocalRuntimeStatusPage, isLocalRuntimeLoopbackAddress } from "../local-control/status-page.js";
import {
  LocalTransportSecurityError,
  loadLocalMtlsIdentity,
  type LocalMtlsIdentity,
} from "../local-control/transport-security.js";
import {
  admitSession,
  authorizeExecutionIntent,
  closeSession,
  type AdmissionAuthorizationOptions,
} from "./authorization.js";
import { LOCAL_ADMISSION_DEFAULT_PORT, LocalAdmissionError, readLocalAdmissionConfiguration } from "./setup.js";

export const LOCAL_ADMISSION_STATUS_PATH = "/status" as const;
const LOCAL_ADMISSION_HISTORICAL_PORT = 8766;
export const LOCAL_ADMISSION_PROTOCOL_VERSION = 1 as const;
export const LOCAL_ADMISSION_HEALTH_PATH = "/health" as const;
export const LOCAL_ADMISSION_SESSIONS_PATH = "/v1/sessions" as const;
export const LOCAL_ADMISSION_REPOSITORY_PATH = "/v1/repository" as const;
export const LOCAL_ADMISSION_EXECUTIONS_PATH = "/v1/executions" as const;
export const LOCAL_ADMISSION_SESSION_ID_HEADER = "x-inari-session-id" as const;
export const MAX_LOCAL_ADMISSION_BODY_BYTES = 1_048_576;

/**
 * Executor surface Admission consumes. `LocalExecutorClient` (the neutral
 * client of the Executor wire protocol) implements it; Admission never loads
 * Executor internals.
 */
export interface AdmissionExecutorClient {
  verifyReady(): Promise<unknown>;
  resolveRepository?(repositoryNameWithOwner: string): Promise<RepositoryIdentity>;
  readEvidence(request: LocalExecutorEvidenceRequest): Promise<unknown>;
  execute(execution: AuthorizedExecution): Promise<unknown>;
}

interface LocalAdmissionHttpHandlerOptions {
  readonly admissionId: string;
  readonly version: string;
  readonly runtimeAuthority: Delegator;
  readonly executor: AdmissionExecutorClient;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

function authorizationOptions(options: LocalAdmissionHttpHandlerOptions): AdmissionAuthorizationOptions {
  return {
    runtimeAuthority: options.runtimeAuthority,
    readEvidence: (request) => options.executor.readEvidence(request),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function jsonContentType(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;|\s*$)/iu.test(value);
}

async function readBoundedBody(
  request: Request,
): Promise<
  { readonly kind: "body"; readonly text: string } | { readonly kind: "too-large" } | { readonly kind: "error" }
> {
  if (request.body === null) return { kind: "body", text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_LOCAL_ADMISSION_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return { kind: "too-large" };
      }
      chunks.push(chunk.value);
    }
  } catch {
    return { kind: "error" };
  } finally {
    reader.releaseLock();
  }
  return { kind: "body", text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8") };
}

async function bodyJson(request: Request): Promise<{ readonly value?: unknown; readonly response?: Response }> {
  if (!jsonContentType(request.headers.get("content-type")))
    return {
      response: json(415, {
        ok: false,
        error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Content type must be application/json." },
      }),
    };
  const body = await readBoundedBody(request);
  if (body.kind === "too-large")
    return {
      response: json(413, {
        ok: false,
        error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the configured maximum size." },
      }),
    };
  if (body.kind === "error")
    return {
      response: json(400, {
        ok: false,
        error: { code: "MALFORMED_REQUEST", message: "Request body could not be read." },
      }),
    };
  try {
    return { value: JSON.parse(body.text) as unknown };
  } catch {
    return {
      response: json(400, { ok: false, error: { code: "MALFORMED_JSON", message: "Request body is not valid JSON." } }),
    };
  }
}

function createLocalAdmissionHttpHandler(
  options: LocalAdmissionHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return json(400, { ok: false, error: { code: "MALFORMED_REQUEST", message: "Request URL is invalid." } });
    }
    if (url.pathname === LOCAL_ADMISSION_HEALTH_PATH) {
      if (request.method !== "GET")
        return json(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is supported." } });
      return json(200, {
        ok: true,
        version: options.version,
        component: "admission",
        admissionId: options.admissionId,
        protocol: LOCAL_ADMISSION_PROTOCOL_VERSION,
        readiness: "ready",
      });
    }
    if (url.pathname === LOCAL_ADMISSION_REPOSITORY_PATH) {
      if (request.method !== "POST")
        return json(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported." } });
      const parsed = await bodyJson(request);
      if (parsed.response !== undefined) return parsed.response;
      if (
        !isRecord(parsed.value) ||
        !exactKeys(parsed.value, ["version", "repositoryNameWithOwner"]) ||
        parsed.value.version !== LOCAL_ADMISSION_PROTOCOL_VERSION ||
        typeof parsed.value.repositoryNameWithOwner !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(parsed.value.repositoryNameWithOwner) ||
        options.executor.resolveRepository === undefined
      ) {
        return json(400, {
          ok: false,
          error: { code: "INVALID_REPOSITORY_REQUEST", message: "Repository request is invalid." },
        });
      }
      try {
        const repository = await options.executor.resolveRepository(parsed.value.repositoryNameWithOwner);
        const validation = validateIssuerRepositoryIdentity(repository);
        if (
          !validation.valid ||
          validation.value === undefined ||
          validation.value.nameWithOwner.toLocaleLowerCase("en-US") !==
            parsed.value.repositoryNameWithOwner.toLocaleLowerCase("en-US")
        ) {
          throw new Error();
        }
        return json(200, {
          ok: true,
          repository: {
            repositoryHost: validation.value.repositoryHost,
            repositoryId: validation.value.repositoryId,
            repositoryNameWithOwner: validation.value.nameWithOwner,
          },
        });
      } catch {
        return json(503, {
          ok: false,
          error: { code: "REPOSITORY_UNAVAILABLE", message: "Repository identity could not be resolved." },
        });
      }
    }
    if (url.pathname === LOCAL_ADMISSION_SESSIONS_PATH) {
      if (request.method !== "POST")
        return json(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported." } });
      const parsed = await bodyJson(request);
      if (parsed.response !== undefined) return parsed.response;
      if (!isRecord(parsed.value) || !exactKeys(parsed.value, ["version", "binding"]) || parsed.value.version !== 1)
        return json(400, {
          ok: false,
          error: { code: "INVALID_SESSION_BINDING", message: "Session request is invalid." },
        });
      const validation = validateLocalSessionBinding(parsed.value.binding);
      if (!validation.valid || validation.value === undefined)
        return json(403, { ok: false, error: { code: "SESSION_DENIED", message: "Session binding was denied." } });
      try {
        const session = await admitSession(validation.value, authorizationOptions(options));
        return json(201, { ok: true, session: { id: session.id, status: session.status, exp: session.exp } });
      } catch {
        return json(403, { ok: false, error: { code: "SESSION_DENIED", message: "Session binding was denied." } });
      }
    }
    if (url.pathname.startsWith(`${LOCAL_ADMISSION_SESSIONS_PATH}/`)) {
      if (request.method !== "DELETE")
        return json(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only DELETE is supported." } });
      const sessionId = url.pathname.slice(LOCAL_ADMISSION_SESSIONS_PATH.length + 1);
      if (!/^[A-Za-z0-9._-]{1,128}$/u.test(sessionId))
        return json(400, { ok: false, error: { code: "INVALID_SESSION_ID", message: "Session id is invalid." } });
      const parsed = await bodyJson(request);
      if (parsed.response !== undefined) return parsed.response;
      if (!isRecord(parsed.value) || !exactKeys(parsed.value, ["version", "binding"]) || parsed.value.version !== 1)
        return json(400, {
          ok: false,
          error: { code: "INVALID_SESSION_BINDING", message: "Session close is invalid." },
        });
      const validation = validateLocalSessionBinding(parsed.value.binding);
      if (!validation.valid || validation.value === undefined || validation.value.sessionId !== sessionId)
        return json(403, { ok: false, error: { code: "SESSION_DENIED", message: "Session close was denied." } });
      try {
        const session = await closeSession(validation.value, authorizationOptions(options));
        return json(200, { ok: true, session: { id: session.id, status: session.status } });
      } catch {
        return json(403, { ok: false, error: { code: "SESSION_DENIED", message: "Session close was denied." } });
      }
    }
    if (url.pathname === LOCAL_ADMISSION_EXECUTIONS_PATH) {
      if (request.method !== "POST")
        return json(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported." } });
      const parsed = await bodyJson(request);
      if (parsed.response !== undefined) return parsed.response;
      const validation = validateExecutionIntent(parsed.value);
      if (!validation.valid || validation.intent === undefined)
        return json(400, {
          ok: false,
          error: { code: "INVALID_EXECUTION_INTENT", message: "ExecutionIntent is invalid." },
        });
      const sessionId = request.headers.get(LOCAL_ADMISSION_SESSION_ID_HEADER);
      if (sessionId === null || !/^[A-Za-z0-9._-]{1,128}$/u.test(sessionId))
        return json(400, {
          ok: false,
          error: { code: "INVALID_SESSION_SELECTOR", message: "A bounded Session selector header is required." },
        });
      try {
        const execution = await authorizeExecutionIntent(validation.intent, sessionId, authorizationOptions(options));
        const result = await options.executor.execute(execution);
        return json(200, { ok: true, result });
      } catch {
        return json(403, { ok: false, error: { code: "ADMISSION_DENIED", message: "Execution was denied." } });
      }
    }
    return json(404, { ok: false, error: { code: "NOT_FOUND", message: "The requested path is not implemented." } });
  };
}

function requestFromIncoming(request: IncomingMessage): Request {
  const host = request.headers.host ?? "127.0.0.1";
  const url = new URL(request.url ?? "/", `http://${host}`);
  const method = request.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(name, value.join(", "));
    else if (value !== undefined) headers.set(name, value);
  }
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });
  return new Request(url, {
    method,
    headers,
    body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
    duplex: "half",
  } as RequestInit & { readonly duplex: "half" });
}

export function createLocalAdmissionHttpServer(
  config: LocalAdmissionConfig,
  version: string,
  runtimeAuthority: Delegator,
  executor: AdmissionExecutorClient,
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly now?: () => Date;
    readonly transport?: LocalMtlsIdentity;
  } = {},
): Server {
  const nonLoopback = config.listen.host === "0.0.0.0";
  if (
    nonLoopback !== (options.transport !== undefined) ||
    (options.transport !== undefined &&
      (options.transport.peerRole !== "executor" || options.transport.peerId !== config.executor.id))
  ) {
    throw new LocalAdmissionError(
      "LOCAL_TRANSPORT_MTLS_CONFIGURATION_INVALID",
      "Non-loopback local Runtime requires valid owner-only Admission and Executor mTLS identities.",
    );
  }
  const handler = createLocalAdmissionHttpHandler({
    admissionId: config.id,
    version,
    runtimeAuthority,
    executor,
    ...options,
  });
  let server: Server;
  server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const pathname = new URL(incoming.url ?? "/", "http://127.0.0.1").pathname;
        if (pathname === LOCAL_ADMISSION_STATUS_PATH) {
          if (config.listen.host !== "127.0.0.1" && !isLocalRuntimeLoopbackAddress(incoming.socket.remoteAddress)) {
            outgoing.statusCode = 404;
            outgoing.end();
            return;
          }
          if (incoming.method !== "GET") {
            outgoing.statusCode = 405;
            outgoing.setHeader("allow", "GET");
            outgoing.setHeader("content-type", "text/plain; charset=utf-8");
            outgoing.end("Only GET is supported.\n");
            return;
          }
          const address = server.address();
          const boundPort = typeof address === "object" && address !== null ? address.port : undefined;
          if (boundPort === undefined) {
            outgoing.statusCode = 503;
            outgoing.end();
            return;
          }
          let readiness: "ready" | "not-ready" = "ready";
          try {
            await executor.verifyReady();
          } catch {
            readiness = "not-ready";
          }
          const response = createLocalRuntimeStatusPage({
            component: "admission",
            id: config.id,
            readiness,
            endpoint: `http://127.0.0.1:${boundPort}`,
            pinnedPeer: { component: "executor", id: config.executor.id },
          });
          outgoing.statusCode = response.status;
          response.headers.forEach((value, key) => outgoing.setHeader(key, value));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
          return;
        }
        const response = await handler(requestFromIncoming(incoming));
        outgoing.statusCode = response.status;
        response.headers.forEach((value, key) => outgoing.setHeader(key, value));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        outgoing.statusCode = 400;
        outgoing.setHeader("content-type", "application/json; charset=utf-8");
        outgoing.end(
          JSON.stringify({ ok: false, error: { code: "MALFORMED_REQUEST", message: "Request could not be handled." } }),
        );
      }
    })();
  });
  return server.listen(
    config.listen.port === LOCAL_ADMISSION_HISTORICAL_PORT ? LOCAL_ADMISSION_DEFAULT_PORT : config.listen.port,
    config.listen.host,
  );
}

export async function startConfiguredLocalAdmission(
  version: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{
  readonly server: Server;
  readonly config: LocalAdmissionConfig;
  readonly announcement: LocalRuntimeEndpoint;
}> {
  const { config, runtimeAuthority } = readLocalAdmissionConfiguration(environment);
  let transport: ReturnType<typeof loadLocalMtlsIdentity> | undefined;
  if (config.listen.host === "0.0.0.0") {
    try {
      transport = loadLocalMtlsIdentity("admission", config.id, config.executor.id, environment);
    } catch (error: unknown) {
      if (error instanceof LocalTransportSecurityError) {
        throw new LocalAdmissionError(error.code, error.message);
      }
      throw error;
    }
  }
  const discoveredExecutor = (): LocalExecutorClient => {
    const endpoint = requireLocalRuntimeEndpoint("executor", config.executor.id, environment);
    return new LocalExecutorClient({
      id: config.executor.id,
      endpoint: endpoint.endpoint,
      ...(transport === undefined ? {} : { transport }),
    });
  };
  const executor: AdmissionExecutorClient = {
    verifyReady: () => discoveredExecutor().verifyReady(),
    resolveRepository: (repositoryNameWithOwner) => discoveredExecutor().resolveRepository(repositoryNameWithOwner),
    readEvidence: (request) => discoveredExecutor().readEvidence(request),
    execute: (execution) => discoveredExecutor().execute(execution),
  };
  try {
    await executor.verifyReady();
  } catch {
    throw new LocalAdmissionError("EXECUTOR_NOT_READY", "Configured Executor identity or readiness check failed.");
  }
  const server = createLocalAdmissionHttpServer(config, version, runtimeAuthority, executor, {
    environment,
    ...(transport === undefined ? {} : { transport }),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch {
    server.close();
    throw new LocalAdmissionError("ADMISSION_LISTEN_FAILED", "Local Admission could not bind its configured endpoint.");
  }
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : undefined;
  if (port === undefined) {
    server.close();
    throw new LocalAdmissionError("ADMISSION_LISTEN_FAILED", "Local Admission did not acquire a listening port.");
  }
  let announcement: LocalRuntimeEndpoint;
  try {
    announcement = publishLocalRuntimeEndpoint("admission", config.id, port, environment);
  } catch {
    server.close();
    throw new LocalAdmissionError(
      "ADMISSION_DISCOVERY_FAILED",
      "Local Admission endpoint could not be published safely.",
    );
  }
  server.once("close", () => {
    try {
      clearLocalRuntimeEndpoint(announcement, environment);
    } catch {
      // A shutdown cleanup failure must not change the process close behavior.
    }
  });
  return { server, config, announcement };
}
