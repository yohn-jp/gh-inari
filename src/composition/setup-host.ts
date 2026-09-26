/**
 * Local Setup/control host and product wiring (#1121).
 *
 * This composition wires the installed `inari setup` frontends to the one
 * canonical Setup Application over the real #1120 owner adapters:
 *
 * - `createLocalSetupApplication` builds the Setup Application from
 *   `createLocalSetupPorts`; the CLI and the browser host construct it the same
 *   way over the same persisted non-secret stores.
 * - `createObservedRuntimeLifecycle` (CLI) observes the discovered Runtime and
 *   never spawns: a short-lived CLI process cannot own long-running children.
 * - `createOwnedRuntimeLifecycle` (setup host) starts/restarts the ordinary
 *   Runtime through the existing Supervisor/discovery model. Starts are
 *   serialized, a running owned or discovered healthy Runtime is reused and
 *   never duplicated, and only children this instance started are stopped.
 * - `startSetupHost` is an explicitly owned loopback HTTP host on a
 *   dynamically allocated port. It needs no Executor key, repository trust or
 *   ready Runtime. It serves the packaged setup-console assets, delivers an
 *   in-memory operator bootstrap only to a same-origin page request, and routes
 *   `/api/setup/*` to the #1118 Setup API bound to that operator session.
 *
 * Composition owns lifecycle only. It never parses secrets: enrollment bytes
 * are streamed opaquely to the Executor enrollment owner.
 */
import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createSetupApplication, type SetupApplication } from "../application/setup/index.js";
import type { SetupEnrollmentSource } from "../cli/setup/index.js";
import { createSetupApiServer } from "../console/api.js";
import { OperatorSession } from "../console/operator-session.js";
import {
  SETUP_CONSOLE_ASSETS,
  lookupSetupConsoleAsset,
  readSetupConsoleAsset,
  setupConsoleAssetHeaders,
} from "../console/public-assets.js";
import type { RepositoryIdentity } from "../github/effect-authorizer.js";
import { resolveLocalRepositoryContext } from "../github/local-repository-context.js";
import { githubRestBaseUrl } from "../github/native-http-transport.js";
import {
  clearLocalRuntimeEndpoint,
  publishLocalRuntimeEndpoint,
  readLocalRuntimeEndpoint,
  type LocalRuntimeEndpoint,
} from "../local-control/runtime-discovery.js";
import { isLocalRuntimeLoopbackAddress } from "../local-control/status-page.js";
import {
  LocalRuntimeSupervisorError,
  probeLocalRuntime,
  startLocalRuntime,
  type LocalRuntimeProbe,
  type SupervisedLocalRuntime,
} from "../local-control/supervisor.js";
import { LocalRuntimeProfileStore } from "../local-runtime-profile.js";
import {
  MAX_SECRET_ENROLLMENT_BYTES,
  MAX_SETUP_TEXT_LENGTH,
  type SetupDiagnostic,
  type SetupGeneration,
} from "../runtime-contracts/index.js";
import { createLocalSetupPorts, type SetupAdapterOptions } from "./setup-adapters.js";
import type {
  RuntimeHealthEvidence,
  RuntimeLifecyclePort,
  RuntimeLifecycleRequest,
  RuntimeLifecycleResult,
} from "./setup-observation.js";

export const SETUP_HOST_PROTOCOL_VERSION = 1 as const;
export const SETUP_HOST_INFO_PATH = "/api/setup/host" as const;
export const SETUP_HOST_BOOTSTRAP_PATH = "/api/setup/bootstrap" as const;
/** Request header that marks a bootstrap request as a same-origin script call (forces CORS preflight cross-site). */
export const SETUP_HOST_BOOTSTRAP_HEADER = "x-inari-setup-bootstrap" as const;
/** Concurrent live operator sessions (browser tabs) per host; the oldest is dropped beyond this. */
const MAX_OPERATOR_SESSIONS = 8;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const MAX_REPOSITORY_RESPONSE_BYTES = 256 * 1024;

export class SetupHostError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SetupHostError";
    this.code = code;
  }
}

function diagnostic(code: string, message: string): SetupDiagnostic {
  return Object.freeze({ code, message: message.slice(0, MAX_SETUP_TEXT_LENGTH) });
}

// ---------------------------------------------------------------------------
// Repository identity

export interface SetupRepositoryResolutionOptions {
  readonly root: string;
  readonly environment?: NodeJS.ProcessEnv;
  /** Explicit `owner/name` or URL locator; otherwise the local Git remote. */
  readonly repository?: string;
  /** Explicit decimal repository ID. */
  readonly repositoryId?: string;
  readonly fetch?: typeof globalThis.fetch;
}

async function publicRepositoryId(
  host: string,
  nameWithOwner: string,
  fetcher: typeof globalThis.fetch,
): Promise<string | undefined> {
  const [owner = "", name = ""] = nameWithOwner.split("/");
  try {
    // Credential-free public read; a private repository simply does not resolve here.
    const response = await fetcher(
      `${githubRestBaseUrl(host)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      {
        method: "GET",
        headers: { accept: "application/vnd.github+json" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const text = await response.text();
    if (text.length > MAX_REPOSITORY_RESPONSE_BYTES) return undefined;
    const body = JSON.parse(text) as { id?: unknown; full_name?: unknown };
    const id = typeof body.id === "number" && Number.isSafeInteger(body.id) ? String(body.id) : undefined;
    return id !== undefined &&
      DECIMAL_ID.test(id) &&
      typeof body.full_name === "string" &&
      body.full_name.toLowerCase() === nameWithOwner.toLowerCase()
      ? id
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the immutable repository identity without credentials: an explicit
 * ID, then the recorded Runtime profile, then a public repository read.
 */
export async function resolveSetupRepository(options: SetupRepositoryResolutionOptions): Promise<RepositoryIdentity> {
  let context: ReturnType<typeof resolveLocalRepositoryContext>;
  try {
    context = resolveLocalRepositoryContext({
      ...(options.repository === undefined ? {} : { repository: options.repository }),
      cwd: options.root,
    });
  } catch {
    throw new SetupHostError(
      "SETUP_REPOSITORY_UNRESOLVED",
      "The repository could not be resolved from --repository or the local Git remote.",
    );
  }
  const base = { repositoryHost: context.hostname, nameWithOwner: context.nameWithOwner };
  if (options.repositoryId !== undefined) {
    if (!DECIMAL_ID.test(options.repositoryId))
      throw new SetupHostError("SETUP_REPOSITORY_ID_INVALID", "--repository-id must be a decimal repository ID.");
    return Object.freeze({ ...base, repositoryId: options.repositoryId });
  }
  let profile: Awaited<ReturnType<LocalRuntimeProfileStore["findForRepository"]>>;
  try {
    profile = await new LocalRuntimeProfileStore({ environment: options.environment ?? process.env }).findForRepository(
      { repositoryHost: base.repositoryHost, repositoryNameWithOwner: base.nameWithOwner },
    );
  } catch {
    throw new SetupHostError("SETUP_REPOSITORY_PROFILE_UNREADABLE", "The recorded Runtime profile could not be read.");
  }
  if (profile !== undefined) return Object.freeze({ ...base, repositoryId: profile.repository.repositoryId });
  const id = await publicRepositoryId(
    base.repositoryHost,
    base.nameWithOwner,
    options.fetch ?? globalThis.fetch.bind(globalThis),
  );
  if (id !== undefined) return Object.freeze({ ...base, repositoryId: id });
  throw new SetupHostError(
    "SETUP_REPOSITORY_ID_REQUIRED",
    `The repository ID of ${base.nameWithOwner} is not recorded and could not be read publicly; pass --repository-id <id>.`,
  );
}

// ---------------------------------------------------------------------------
// Setup Application

/** The one Setup Application every local frontend uses, over the real #1120 owner adapters. */
export function createLocalSetupApplication(
  options: Omit<SetupAdapterOptions, "lifecycle"> & { readonly lifecycle: RuntimeLifecyclePort },
): SetupApplication {
  return createSetupApplication(createLocalSetupPorts(options));
}

/**
 * CLI enrollment seam: opens an operator file reference and streams its bytes
 * opaquely to the Executor enrollment owner. Nothing here reads or parses them.
 */
export function createFileEnrollmentSource(root: string): SetupEnrollmentSource {
  return Object.freeze({
    open(reference: string) {
      const file = path.resolve(root, reference);
      let size: number;
      try {
        const stat = statSync(file);
        if (!stat.isFile()) throw new Error("not a file");
        size = stat.size;
      } catch {
        throw new SetupHostError("SETUP_ENROLLMENT_FILE_UNREADABLE", "The enrollment file could not be opened.");
      }
      if (size < 1 || size > MAX_SECRET_ENROLLMENT_BYTES)
        throw new SetupHostError("SETUP_ENROLLMENT_FILE_INVALID", "The enrollment file size is out of bounds.");
      return { declaredBytes: size, stream: createReadStream(file) as AsyncIterable<Uint8Array> };
    },
  });
}

// ---------------------------------------------------------------------------
// Runtime lifecycle

export interface RuntimeLifecycleDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly probe?: (environment: NodeJS.ProcessEnv) => Promise<LocalRuntimeProbe>;
  readonly start?: (environment: NodeJS.ProcessEnv) => Promise<SupervisedLocalRuntime>;
  readonly now?: () => Date;
}

async function observeRuntime(
  dependencies: RuntimeLifecycleDependencies,
  generation: SetupGeneration,
  extra: readonly SetupDiagnostic[] = [],
): Promise<RuntimeHealthEvidence> {
  const probe = await (dependencies.probe ?? probeLocalRuntime)(dependencies.environment ?? process.env);
  return {
    status: probe.status,
    observedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    generation: generation.configuration,
    diagnostics: [
      ...(probe.reason === undefined ? [] : [diagnostic("SETUP_RUNTIME_UNHEALTHY", probe.reason)]),
      ...(probe.status === "healthy" ? [] : extra),
    ],
  };
}

const failed = (code: string, message: string): RuntimeLifecycleResult => ({
  outcome: "failed",
  diagnostics: [diagnostic(code, message)],
});

/** Observe-only lifecycle for short-lived CLI processes; start/restart name the owning entrypoints. */
export function createObservedRuntimeLifecycle(dependencies: RuntimeLifecycleDependencies = {}): RuntimeLifecyclePort {
  const owner = (): Promise<RuntimeLifecycleResult> =>
    Promise.resolve(
      failed(
        "SETUP_RUNTIME_OWNER_REQUIRED",
        "This CLI process does not own long-running Runtime children; start it from `inari setup console` or run `inari runtime supervise` in the foreground.",
      ),
    );
  return Object.freeze({
    observe: (generation: SetupGeneration) => observeRuntime(dependencies, generation),
    start: owner,
    restart: owner,
  });
}

export interface OwnedRuntimeLifecycle extends RuntimeLifecyclePort {
  /** True while this instance owns started Runtime children. */
  owns(): boolean;
  /** Stops only the children this instance started; later starts fail. */
  shutdown(): Promise<void>;
}

export function createOwnedRuntimeLifecycle(dependencies: RuntimeLifecycleDependencies = {}): OwnedRuntimeLifecycle {
  const environment = dependencies.environment ?? process.env;
  const probe = (): Promise<LocalRuntimeProbe> => (dependencies.probe ?? probeLocalRuntime)(environment);
  const spawnRuntime = dependencies.start ?? ((env: NodeJS.ProcessEnv) => startLocalRuntime(env));
  let runtime: SupervisedLocalRuntime | undefined;
  let lastFailure: SetupDiagnostic | undefined;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();

  /** Start/restart/shutdown are serialized so repeated requests never race into duplicate children. */
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  }

  function watch(started: SupervisedLocalRuntime): void {
    void started.exited.then(async (exit) => {
      if (runtime !== started) return; // Intentional stop by this owner.
      runtime = undefined;
      lastFailure = diagnostic(
        "SETUP_RUNTIME_CHILD_EXITED",
        `${exit.component} stopped unexpectedly; the owned local Runtime was stopped.`,
      );
      await started.stop().catch(() => undefined);
    });
  }

  async function spawnOwned(): Promise<RuntimeLifecycleResult> {
    try {
      const started = await spawnRuntime(environment);
      runtime = started;
      lastFailure = undefined;
      watch(started);
      return { outcome: "succeeded", diagnostics: [] };
    } catch (error: unknown) {
      const code = error instanceof LocalRuntimeSupervisorError ? error.code : "SETUP_RUNTIME_START_FAILED";
      const message = error instanceof Error ? error.message : "The local Runtime could not be started.";
      lastFailure = diagnostic(code, message);
      // A failed start stops what it spawned; only an unconfirmed stop leaves the effect unknown.
      return {
        outcome: code === "LOCAL_RUNTIME_SUPERVISOR_SHUTDOWN_FAILED" ? "unknown" : "failed",
        diagnostics: [lastFailure],
      };
    }
  }

  async function start(): Promise<RuntimeLifecycleResult> {
    if (closed) return failed("SETUP_HOST_CLOSED", "The setup host is shutting down.");
    const current = await probe();
    if (runtime !== undefined) {
      return current.status === "healthy"
        ? {
            outcome: "succeeded",
            diagnostics: [diagnostic("SETUP_RUNTIME_ALREADY_OWNED", "The owned local Runtime is already running.")],
          }
        : failed("SETUP_RUNTIME_OWNED_UNHEALTHY", "The owned local Runtime is unhealthy; restart it.");
    }
    if (current.status === "healthy")
      return {
        outcome: "succeeded",
        diagnostics: [
          diagnostic(
            "SETUP_RUNTIME_ALREADY_RUNNING",
            "A healthy local Runtime is already running; no process was started.",
          ),
        ],
      };
    if (current.status === "unhealthy")
      return failed(
        "SETUP_RUNTIME_NOT_OWNED",
        "A reachable local Runtime that this host did not start is unhealthy; stop it where it was started.",
      );
    return spawnOwned();
  }

  return Object.freeze({
    observe: (generation: SetupGeneration) =>
      observeRuntime({ ...dependencies, environment }, generation, lastFailure === undefined ? [] : [lastFailure]),
    start: (_request: RuntimeLifecycleRequest) => serialize(start),
    restart: (_request: RuntimeLifecycleRequest) =>
      serialize(async () => {
        if (closed) return failed("SETUP_HOST_CLOSED", "The setup host is shutting down.");
        const current = runtime;
        if (current === undefined)
          return failed(
            "SETUP_RUNTIME_NOT_OWNED",
            "This setup host did not start the local Runtime; restart it where it was started.",
          );
        runtime = undefined;
        try {
          await current.stop();
        } catch {
          return {
            outcome: "unknown" as const,
            diagnostics: [
              diagnostic("SETUP_RUNTIME_STOP_UNCONFIRMED", "The owned local Runtime did not confirm shutdown."),
            ],
          };
        }
        return spawnOwned();
      }),
    owns: () => runtime !== undefined,
    shutdown: () =>
      serialize(async () => {
        closed = true;
        const current = runtime;
        runtime = undefined;
        if (current !== undefined) await current.stop();
      }),
  });
}

// ---------------------------------------------------------------------------
// Setup/control host

/** Packaged console assets beside this module: `dist/setup-console/` (installed) or the checkout build. */
export function defaultSetupConsoleAssetDirectory(): string {
  const source = path.extname(fileURLToPath(import.meta.url)).toLowerCase() === ".ts";
  return fileURLToPath(new URL(source ? "../../dist/setup-console/" : "../setup-console/", import.meta.url));
}

function receivingMachineLabel(value: string | undefined): string {
  const printable = [...(value ?? hostname())].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
  const label = printable.join("").trim().slice(0, 128);
  return label.length > 0 ? label : "this machine";
}

function hostInfo(value: unknown, id: string): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.ok === true &&
    record.component === "setup" &&
    record.id === id &&
    record.protocol === SETUP_HOST_PROTOCOL_VERSION
  );
}

/**
 * The live setup host announced for this local configuration, verified by its
 * own identity endpoint. A stale or foreign announcement is not returned.
 */
export async function findLiveSetupHost(
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<LocalRuntimeEndpoint | undefined> {
  let announcement: LocalRuntimeEndpoint | undefined;
  try {
    announcement = readLocalRuntimeEndpoint("setup", environment);
  } catch {
    return undefined;
  }
  if (announcement === undefined) return undefined;
  try {
    const response = await fetcher(new URL(SETUP_HOST_INFO_PATH, announcement.endpoint), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    if (response.status !== 200) return undefined;
    return hostInfo(await response.json(), announcement.id) ? announcement : undefined;
  } catch {
    return undefined;
  }
}

export interface SetupHostOptions {
  readonly application: SetupApplication;
  readonly repository: RepositoryIdentity;
  readonly environment?: NodeJS.ProcessEnv;
  readonly assetDirectory?: string;
  readonly receivingMachine?: string;
  /** The owned Runtime lifecycle; shut down with this host. */
  readonly lifecycle?: Pick<OwnedRuntimeLifecycle, "shutdown">;
}

export interface SetupHostHandle {
  readonly id: string;
  /** Exact browser origin, e.g. `http://127.0.0.1:49152`. */
  readonly origin: string;
  readonly announcement: LocalRuntimeEndpoint;
  /** Resolves once the host has fully shut down. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

interface OperatorEntry {
  readonly session: OperatorSession;
  readonly api: Server;
}

function send(out: ServerResponse, status: number, body?: unknown): void {
  out.statusCode = status;
  out.setHeader("cache-control", "no-store");
  out.setHeader("x-content-type-options", "nosniff");
  out.setHeader("referrer-policy", "no-referrer");
  if (body === undefined) {
    out.end();
    return;
  }
  out.setHeader("content-type", "application/json; charset=utf-8");
  out.end(JSON.stringify(body));
}

export async function startSetupHost(options: SetupHostOptions): Promise<SetupHostHandle> {
  const environment = options.environment ?? process.env;
  const assetDirectory = options.assetDirectory ?? defaultSetupConsoleAssetDirectory();
  for (const item of SETUP_CONSOLE_ASSETS) {
    try {
      if (!statSync(path.join(assetDirectory, item.file)).isFile()) throw new Error("missing");
    } catch {
      throw new SetupHostError(
        "SETUP_HOST_ASSETS_MISSING",
        "The packaged setup console assets are missing; rebuild or reinstall Inari.",
      );
    }
  }
  const receivingMachine = receivingMachineLabel(options.receivingMachine);
  const id = `stp_${randomBytes(18).toString("base64url")}`;
  const sessions: OperatorEntry[] = [];
  let origin = "";
  let expectedHost = "";

  function prune(now: number): void {
    for (let index = sessions.length - 1; index >= 0; index -= 1) {
      if (sessions[index]!.session.context.expiresAt <= now) sessions.splice(index, 1);
    }
    while (sessions.length >= MAX_OPERATOR_SESSIONS) sessions.shift();
  }

  async function bootstrap(request: IncomingMessage, out: ServerResponse): Promise<void> {
    request.resume();
    const site = request.headers["sec-fetch-site"];
    if (
      request.method !== "POST" ||
      request.headers.origin !== origin ||
      request.headers[SETUP_HOST_BOOTSTRAP_HEADER] !== "1" ||
      (site !== undefined && site !== "same-origin")
    )
      return send(out, 403);
    const state = await options.application.state(options.repository);
    prune(Date.now());
    const session = new OperatorSession(options.repository, state.generation.configuration);
    const api = createSetupApiServer({
      application: options.application,
      repository: options.repository,
      configuration: state.generation.configuration,
      session,
      origin,
    });
    sessions.push({ session, api });
    // Delivered only in this response body; never stored, logged, embedded in assets or placed in a URL.
    send(out, 200, {
      apiOrigin: origin,
      bearer: session.context.bearer,
      csrf: session.context.csrf,
      receivingMachine,
    });
  }

  function routeApi(request: IncomingMessage, out: ServerResponse): void {
    const authorization = request.headers.authorization;
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const csrf = request.headers["x-csrf-token"];
    const entry = sessions.find((item) =>
      item.session.authorize(
        bearer,
        typeof csrf === "string" ? csrf : undefined,
        options.repository,
        item.session.context.configuration,
      ),
    );
    if (entry === undefined) {
      request.resume();
      return send(out, 403);
    }
    entry.api.emit("request", request, out);
  }

  async function handle(request: IncomingMessage, out: ServerResponse): Promise<void> {
    if (!isLocalRuntimeLoopbackAddress(request.socket.remoteAddress) || request.headers.host !== expectedHost) {
      request.resume();
      return send(out, 403);
    }
    const target = request.url ?? "/";
    const asset = lookupSetupConsoleAsset(request.method, target);
    if (asset !== undefined) {
      request.resume();
      const bytes = await readSetupConsoleAsset(assetDirectory, asset);
      out.writeHead(200, setupConsoleAssetHeaders(asset, bytes.byteLength));
      out.end(request.method === "HEAD" ? undefined : bytes);
      return;
    }
    if (target === SETUP_HOST_INFO_PATH) {
      request.resume();
      if (request.method !== "GET") return send(out, 405);
      return send(out, 200, {
        ok: true,
        operation: "setup.host",
        component: "setup",
        id,
        protocol: SETUP_HOST_PROTOCOL_VERSION,
      });
    }
    if (target === SETUP_HOST_BOOTSTRAP_PATH) return bootstrap(request, out);
    if (target.startsWith("/api/setup/")) return routeApi(request, out);
    request.resume();
    return send(out, 404);
  }

  const server = createServer((request, out) => {
    void handle(request, out).catch(() => {
      if (!out.headersSent) send(out, 500);
      else out.destroy();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Dynamic loopback port only; there is no fixed-port fallback.
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch {
    server.close();
    throw new SetupHostError("SETUP_HOST_LISTEN_FAILED", "The setup host could not bind a loopback port.");
  }
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : undefined;
  if (port === undefined) {
    server.close();
    throw new SetupHostError("SETUP_HOST_LISTEN_FAILED", "The setup host did not acquire a listening port.");
  }
  origin = `http://127.0.0.1:${port}`;
  expectedHost = `127.0.0.1:${port}`;
  let announcement: LocalRuntimeEndpoint;
  try {
    announcement = publishLocalRuntimeEndpoint("setup", id, port, environment);
  } catch {
    server.close();
    throw new SetupHostError("SETUP_HOST_DISCOVERY_FAILED", "The setup host endpoint could not be published.");
  }

  let closing: Promise<void> | undefined;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      sessions.length = 0;
      try {
        clearLocalRuntimeEndpoint(announcement, environment);
      } catch {
        // Only this instance's announcement is ever removed; a failure leaves it for stale detection.
      }
      try {
        await options.lifecycle?.shutdown();
      } finally {
        await stopped;
        resolveClosed();
      }
    })());
  return Object.freeze({ id, origin, announcement, closed, close });
}
