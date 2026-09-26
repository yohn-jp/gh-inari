// Public Executor server entry: the Executor HTTP server and configured
// startup. Startup is the credential boundary; it delegates Issuer key
// reading and provider effects to the private `./execution.ts`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { TLSSocket } from "node:tls";
import { Readable } from "node:stream";
import { readLocalJson, validateLocalAdmissionConfig, type LocalExecutorConfig } from "../local-control/config.js";
import {
  LocalTransportSecurityError,
  loadLocalMtlsIdentity,
  verifyLocalMtlsPeerIdentity,
} from "../local-control/transport-security.js";
import {
  createLocalExecutorHttpHandler,
  type LocalExecutorHttpHandlerOptions,
} from "../local-control/executor-http.js";
import {
  clearLocalRuntimeEndpoint,
  publishLocalRuntimeEndpoint,
  type LocalRuntimeEndpoint,
} from "../local-control/runtime-discovery.js";
import { createLocalRuntimeStatusPage, isLocalRuntimeLoopbackAddress } from "../local-control/status-page.js";
import { LocalExecutorError } from "./errors.js";
import {
  executeLocalAuthorizedExecution,
  readLocalExecutorBranchPolicy,
  readLocalExecutorEvidence,
  readLocalExecutorGovernedContract,
  requireLocalExecutorIssuerCredential,
  resolveLocalExecutorRepository,
} from "./execution.js";
import { configuredLocalExecutor, LOCAL_EXECUTOR_DEFAULT_PORT } from "./setup.js";
import { issuerExecutionEnvironment } from "./enrollment/issuer-reference.js";

export const LOCAL_EXECUTOR_STATUS_PATH = "/status" as const;
const LOCAL_EXECUTOR_HISTORICAL_PORT = 8765;

function configuredListenPort(port: number): number {
  return port === LOCAL_EXECUTOR_HISTORICAL_PORT ? LOCAL_EXECUTOR_DEFAULT_PORT : port;
}

export interface LocalExecutorHttpServerOptions extends LocalExecutorHttpHandlerOptions {
  readonly config: LocalExecutorConfig;
  readonly listenPort?: number;
  readonly transport?: ReturnType<typeof loadLocalMtlsIdentity>;
}

function writeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, key) => outgoing.setHeader(key, value));
  return response.arrayBuffer().then((body) => {
    outgoing.end(Buffer.from(body));
  });
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

export function createLocalExecutorHttpServer(options: LocalExecutorHttpServerOptions): Server {
  const handler = createLocalExecutorHttpHandler(options);
  const port = options.listenPort ?? configuredListenPort(options.config.listen.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new TypeError("Local Executor listen port is invalid.");
  const nonLoopback = options.config.listen.host === "0.0.0.0";
  if (
    nonLoopback !== (options.transport !== undefined) ||
    (options.transport !== undefined && options.transport.peerRole !== "admission")
  ) {
    throw new TypeError("Local Executor non-loopback bind requires a configured mTLS identity.");
  }
  let server: Server;
  const handle = (incoming: IncomingMessage, outgoing: ServerResponse): void => {
    if (nonLoopback) {
      const socket = incoming.socket as TLSSocket;
      const peer = socket.getPeerCertificate();
      if (
        !socket.authorized ||
        options.transport === undefined ||
        !verifyLocalMtlsPeerIdentity(peer, "admission", options.transport.peerId)
      ) {
        socket.destroy();
        return;
      }
    }
    void (async () => {
      try {
        const pathname = new URL(incoming.url ?? "/", "http://127.0.0.1").pathname;
        if (pathname === LOCAL_EXECUTOR_STATUS_PATH) {
          if (nonLoopback && !isLocalRuntimeLoopbackAddress(incoming.socket.remoteAddress)) {
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
          await writeResponse(
            createLocalRuntimeStatusPage({
              component: "executor",
              id: options.executorId,
              readiness: options.ready?.() === false ? "not-ready" : "ready",
              endpoint: `${options.transport === undefined ? "http" : "https"}://127.0.0.1:${boundPort}`,
            }),
            outgoing,
          );
          return;
        }
        await writeResponse(await handler(requestFromIncoming(incoming)), outgoing);
      } catch {
        if (!outgoing.headersSent) {
          outgoing.statusCode = 400;
          outgoing.setHeader("content-type", "application/json; charset=utf-8");
        }
        outgoing.end(
          JSON.stringify({ ok: false, error: { code: "MALFORMED_REQUEST", message: "Request could not be handled." } }),
        );
      }
    })();
  };
  if (nonLoopback) {
    const transport = options.transport;
    if (transport === undefined) throw new TypeError("Local Executor mTLS identity is missing.");
    server = createHttpsServer(
      {
        key: transport.privateKey,
        cert: transport.certificate,
        ca: transport.caCertificate,
        requestCert: true,
        rejectUnauthorized: true,
      },
      handle,
    ).listen(port, options.config.listen.host);
  } else {
    server = createServer(handle).listen(port, options.config.listen.host);
  }
  return server;
}

export async function startConfiguredLocalExecutor(
  version: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{
  readonly server: Server;
  readonly config: LocalExecutorConfig;
  readonly announcement: LocalRuntimeEndpoint;
}> {
  const config = configuredLocalExecutor(environment);
  const executionEnvironment = issuerExecutionEnvironment(config.id, environment);
  // Executor startup is the credential boundary: read and validate the key now.
  requireLocalExecutorIssuerCredential(executionEnvironment);
  let transport: ReturnType<typeof loadLocalMtlsIdentity> | undefined;
  if (config.listen.host === "0.0.0.0") {
    const admission = readLocalJson("admission", "config.json", validateLocalAdmissionConfig, environment);
    if (admission === undefined) {
      throw new LocalExecutorError(
        "EXECUTOR_ADMISSION_IDENTITY_MISSING",
        "Non-loopback Executor requires configured local Admission identity and mTLS custody.",
      );
    }
    try {
      transport = loadLocalMtlsIdentity("executor", config.id, admission.id, environment);
    } catch (error: unknown) {
      if (error instanceof LocalTransportSecurityError) {
        throw new LocalExecutorError(error.code, error.message);
      }
      throw error;
    }
  }
  const server = createLocalExecutorHttpServer({
    config,
    version,
    executorId: config.id,
    execute: (execution) => executeLocalAuthorizedExecution(execution, executionEnvironment),
    resolveRepository: (repositoryNameWithOwner) =>
      resolveLocalExecutorRepository(repositoryNameWithOwner, executionEnvironment),
    readEvidence: (request) => readLocalExecutorEvidence(request, executionEnvironment),
    readBranchPolicy: (request) => readLocalExecutorBranchPolicy(request, executionEnvironment),
    readGovernedContract: (request) => readLocalExecutorGovernedContract(request, executionEnvironment),
    ready: () => true,
    ...(transport === undefined ? {} : { transport }),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch {
    server.close();
    throw new LocalExecutorError("EXECUTOR_LISTEN_FAILED", "Local Executor could not bind its configured endpoint.");
  }
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : undefined;
  if (port === undefined) {
    server.close();
    throw new LocalExecutorError("EXECUTOR_LISTEN_FAILED", "Local Executor did not acquire a listening port.");
  }
  let announcement: LocalRuntimeEndpoint;
  try {
    announcement = publishLocalRuntimeEndpoint(
      "executor",
      config.id,
      port,
      environment,
      config.listen.host === "0.0.0.0" ? "https" : "http",
    );
  } catch {
    server.close();
    throw new LocalExecutorError("EXECUTOR_DISCOVERY_FAILED", "Local Executor endpoint could not be published safely.");
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
