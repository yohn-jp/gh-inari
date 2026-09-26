/** Local process supervision for the distinct Admission and Executor services. */

import { spawn, type ChildProcess } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_ADMISSION_CLIENT_HEALTH_PATH,
  LOCAL_ADMISSION_CLIENT_PROTOCOL_VERSION,
} from "../cli/runtime/admission-client.js";
import { LOCAL_EXECUTOR_HEALTH_PATH, LOCAL_EXECUTOR_PROTOCOL_VERSION } from "./executor-http.js";
import { writeLocalRuntimeLog } from "./runtime-log.js";
import {
  clearLocalRuntimeEndpoint,
  readLocalRuntimeEndpoint,
  requireLocalRuntimeEndpoint,
  type LocalRuntimeComponent,
  type LocalRuntimeEndpoint,
} from "./runtime-discovery.js";

const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_CHILD_OUTPUT_BYTES = 16 * 1024;

export class LocalRuntimeSupervisorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalRuntimeSupervisorError";
    this.code = code;
  }
}

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface ManagedChild {
  readonly component: LocalRuntimeComponent;
  readonly child: ChildProcess;
  readonly exit: Promise<ChildExit>;
  readonly closed: Promise<void>;
  readonly spawnError: Promise<Error>;
  readonly readStderr: () => string;
  readonly forwardStderr: () => void;
  announcement?: LocalRuntimeEndpoint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedAppend(previous: string, addition: string): string {
  const next = previous + addition;
  return Buffer.byteLength(next, "utf8") <= MAX_CHILD_OUTPUT_BYTES ? next : next.slice(-MAX_CHILD_OUTPUT_BYTES);
}

function runtimeLogComponent(component: LocalRuntimeComponent): "admission" | "executor" | "supervisor" {
  return component === "admission" || component === "executor" ? component : "supervisor";
}

function childEnvironment(component: LocalRuntimeComponent, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...environment };
  delete child.GH_TOKEN;
  delete child.GITHUB_TOKEN;
  delete child.INARI_RUNTIME_AUTHORITY_PRIVATE_KEY;
  // The App-user credential is bootstrap-only; neither Runtime child uses it.
  delete child.INARI_GITHUB_APP_USER_CREDENTIAL_FILE;
  delete child.INARI_APP_USER_CREDENTIAL_FILE;
  // Local Executor Issuer key custody is a file reference only; inline PEM never reaches a child.
  delete child.INARI_GITHUB_APP_PRIVATE_KEY;
  delete child.GITHUB_APP_PRIVATE_KEY;
  if (component === "admission") {
    delete child.INARI_GITHUB_APP_ID;
    delete child.GITHUB_APP_ID;
    delete child.INARI_GITHUB_APP_PRIVATE_KEY_FILE;
    delete child.GITHUB_APP_PRIVATE_KEY_FILE;
  }
  return child;
}

/**
 * The package's own CLI entrypoint, resolved beside this module (`dist/index.js`
 * when installed, `src/index.ts` from a checkout); never the caller's argv.
 */
export function localRuntimeEntrypoint(): string {
  const source = extname(fileURLToPath(import.meta.url)).toLowerCase() === ".ts";
  return fileURLToPath(new URL(source ? "../index.ts" : "../index.js", import.meta.url));
}

function createManagedChild(
  component: LocalRuntimeComponent,
  environment: NodeJS.ProcessEnv,
  entry: string,
): ManagedChild {
  if (entry.length === 0) {
    throw new LocalRuntimeSupervisorError(
      "LOCAL_RUNTIME_SUPERVISOR_ENTRYPOINT_MISSING",
      "The Inari CLI entrypoint is unavailable.",
    );
  }
  const loader = extname(entry).toLowerCase() === ".ts" ? ["--import", import.meta.resolve("tsx")] : [];
  const child = spawn(process.execPath, [...loader, entry, component, "serve", "--json"], {
    cwd: process.cwd(),
    env: childEnvironment(component, environment),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  let forwardStderr = false;
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = boundedAppend(stderr, chunk);
    if (forwardStderr) {
      try {
        process.stderr.write(chunk);
      } catch {
        // A broken foreground log sink must not change child supervision.
      }
    }
  });
  const exit = new Promise<ChildExit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const spawnError = new Promise<Error>((resolve) => child.once("error", resolve));
  return {
    component,
    child,
    exit,
    closed,
    spawnError,
    readStderr: () => stderr,
    forwardStderr: () => {
      forwardStderr = true;
    },
  };
}

function componentId(component: LocalRuntimeComponent, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const prefix = component === "admission" ? "adm_" : "exec_";
  return value.startsWith(prefix) && /^[A-Za-z0-9_-]{16,64}$/u.test(value.slice(prefix.length)) ? value : undefined;
}

function startupId(component: LocalRuntimeComponent, value: unknown): string {
  const operation = `${component}.serve`;
  if (!isRecord(value)) {
    throw new LocalRuntimeSupervisorError(
      "LOCAL_RUNTIME_SUPERVISOR_CHILD_OUTPUT_INVALID",
      `${component} returned an invalid startup result.`,
    );
  }
  if (value.ok === false && isRecord(value.error)) {
    const code = typeof value.error.code === "string" ? value.error.code.slice(0, 100) : "START_FAILED";
    const message =
      typeof value.error.message === "string" ? value.error.message.slice(0, 300) : "service startup failed";
    throw new LocalRuntimeSupervisorError(
      "LOCAL_RUNTIME_SUPERVISOR_CHILD_FAILED",
      `${component} failed to start (${code}): ${message}`,
    );
  }
  const id = componentId(component, component === "admission" ? value.admissionId : value.executorId);
  if (value.ok !== true || value.operation !== operation || id === undefined) {
    throw new LocalRuntimeSupervisorError(
      "LOCAL_RUNTIME_SUPERVISOR_CHILD_OUTPUT_INVALID",
      `${component} returned an invalid startup result.`,
    );
  }
  return id;
}

function waitForStartup(child: ManagedChild): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      child.child.stdout?.off("data", onData);
    };
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onData = (chunk: string | Buffer): void => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer, "utf8") > MAX_CHILD_OUTPUT_BYTES) {
        finish(() =>
          reject(
            new LocalRuntimeSupervisorError(
              "LOCAL_RUNTIME_SUPERVISOR_CHILD_OUTPUT_INVALID",
              `${child.component} returned an oversized startup result.`,
            ),
          ),
        );
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      try {
        const id = startupId(child.component, JSON.parse(line) as unknown);
        finish(() => resolve(id));
      } catch (error: unknown) {
        finish(() => reject(error));
      }
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new LocalRuntimeSupervisorError(
            "LOCAL_RUNTIME_SUPERVISOR_START_TIMEOUT",
            `${child.component} did not report readiness before the startup deadline.${child.readStderr() === "" ? "" : ` ${child.readStderr().trim().slice(-500)}`}`,
          ),
        ),
      );
    }, STARTUP_TIMEOUT_MS);
    child.child.stdout?.setEncoding("utf8").on("data", onData);
    void child.spawnError.then((error) => {
      finish(() =>
        reject(
          new LocalRuntimeSupervisorError(
            "LOCAL_RUNTIME_SUPERVISOR_CHILD_SPAWN_FAILED",
            `${child.component} could not be started: ${error.message}`,
          ),
        ),
      );
    });
    void child.exit.then((exit) => {
      finish(() =>
        reject(
          new LocalRuntimeSupervisorError(
            "LOCAL_RUNTIME_SUPERVISOR_CHILD_FAILED",
            `${child.component} exited before reporting readiness (code ${exit.code ?? "none"}${exit.signal === null ? "" : `, signal ${exit.signal}`}).${child.readStderr() === "" ? "" : ` ${child.readStderr().trim().slice(-500)}`}`,
          ),
        ),
      );
    });
  });
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

async function verifyHealth(component: LocalRuntimeComponent, id: string, endpoint: string): Promise<void> {
  const path = component === "admission" ? LOCAL_ADMISSION_CLIENT_HEALTH_PATH : LOCAL_EXECUTOR_HEALTH_PATH;
  let response: Response;
  try {
    response = await fetch(new URL(path, endpoint), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    throw new LocalRuntimeSupervisorError(
      "LOCAL_RUNTIME_SUPERVISOR_HEALTH_FAILED",
      `${component} health could not be read from its discovered endpoint.`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new LocalRuntimeSupervisorError(
      "LOCAL_RUNTIME_SUPERVISOR_HEALTH_FAILED",
      `${component} returned invalid health data.`,
    );
  }
  const idKey = component === "admission" ? "admissionId" : "executorId";
  const protocol =
    component === "admission" ? LOCAL_ADMISSION_CLIENT_PROTOCOL_VERSION : LOCAL_EXECUTOR_PROTOCOL_VERSION;
  const keys = ["ok", "version", "component", idKey, "protocol", "readiness"];
  if (
    !isRecord(body) ||
    !exactKeys(body, keys) ||
    response.status !== 200 ||
    body.ok !== true ||
    body.component !== component ||
    body[idKey] !== id ||
    body.protocol !== protocol ||
    body.readiness !== "ready" ||
    typeof body.version !== "string"
  ) {
    throw new LocalRuntimeSupervisorError(
      "LOCAL_RUNTIME_SUPERVISOR_HEALTH_FAILED",
      `${component} did not pass its discovered identity and readiness check.`,
    );
  }
}

async function startAndVerify(
  component: LocalRuntimeComponent,
  environment: NodeJS.ProcessEnv,
  children: ManagedChild[],
  entry: string,
): Promise<ManagedChild> {
  writeLocalRuntimeLog({ component: runtimeLogComponent(component), event: "starting" });
  const child = createManagedChild(component, environment, entry);
  children.push(child);
  const id = await waitForStartup(child);
  child.forwardStderr();
  let announcement: LocalRuntimeEndpoint;
  try {
    announcement = requireLocalRuntimeEndpoint(component, id, environment);
  } catch {
    throw new LocalRuntimeSupervisorError(
      "LOCAL_RUNTIME_SUPERVISOR_DISCOVERY_FAILED",
      `${component} startup did not publish the expected local endpoint identity.`,
    );
  }
  child.announcement = announcement;
  if (component === "executor" && new URL(announcement.endpoint).protocol === "https:") {
    // Admission performs the client-authenticated Executor readiness check before it reports ready.
    return child;
  }
  await verifyHealth(component, id, announcement.endpoint);
  return child;
}

async function waitForClose(child: ManagedChild, timeoutMs: number): Promise<boolean> {
  if (child.child.exitCode !== null || child.child.signalCode !== null) {
    await child.closed;
    return true;
  }
  return Promise.race([
    child.closed.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function stopChild(child: ManagedChild, environment: NodeJS.ProcessEnv): Promise<boolean> {
  const exitedBeforeStop = child.child.exitCode !== null || child.child.signalCode !== null;
  if (!exitedBeforeStop) {
    writeLocalRuntimeLog({ component: runtimeLogComponent(child.component), event: "stopping" });
    child.child.kill("SIGTERM");
  }
  let stopped = await waitForClose(child, SHUTDOWN_TIMEOUT_MS);
  let forced = false;
  if (!stopped) {
    forced = true;
    writeLocalRuntimeLog({ component: runtimeLogComponent(child.component), event: "forced-stop", outcome: "failure" });
    child.child.kill("SIGKILL");
    stopped = await waitForClose(child, SHUTDOWN_TIMEOUT_MS);
  }
  if (!stopped) {
    throw new LocalRuntimeSupervisorError(
      "LOCAL_RUNTIME_SUPERVISOR_SHUTDOWN_FAILED",
      `${child.component} process did not stop.`,
    );
  }
  if (child.announcement !== undefined) {
    // A child that exited on its own cannot clear its announcement; the owner
    // removes only that exact instance, never another process's endpoint.
    if (exitedBeforeStop) {
      try {
        clearLocalRuntimeEndpoint(child.announcement, environment);
      } catch {
        // The stale check below reports an announcement that could not be removed.
      }
    }
    const current = readLocalRuntimeEndpoint(child.component, environment);
    if (current?.instanceId === child.announcement.instanceId) {
      throw new LocalRuntimeSupervisorError(
        "LOCAL_RUNTIME_SUPERVISOR_DISCOVERY_STALE",
        `${child.component} shutdown left its endpoint announcement active.`,
      );
    }
  }
  writeLocalRuntimeLog({
    component: runtimeLogComponent(child.component),
    event: "stopped",
    outcome: forced ? "failure" : "success",
  });
  return forced;
}

async function stopChildren(children: readonly ManagedChild[], environment: NodeJS.ProcessEnv): Promise<boolean> {
  let forced = false;
  const errors: string[] = [];
  for (const child of [...children].reverse()) {
    try {
      forced = (await stopChild(child, environment)) || forced;
    } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : "Local Runtime child shutdown failed.");
    }
  }
  if (errors.length > 0) {
    throw new LocalRuntimeSupervisorError("LOCAL_RUNTIME_SUPERVISOR_SHUTDOWN_FAILED", errors.join(" "));
  }
  return forced;
}

/** One started, verified Executor/Admission pair owned by the caller that started it. */
export interface SupervisedLocalRuntime {
  readonly executorId: string;
  readonly admissionId: string;
  /** Resolves when either owned child exits for any reason. */
  readonly exited: Promise<{
    readonly component: LocalRuntimeComponent;
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  /** Stops only these owned children; resolves true when forced termination was needed. */
  stop(): Promise<boolean>;
}

export interface LocalRuntimeStartOptions {
  /** CLI entrypoint the children run; defaults to this package's own entrypoint. */
  readonly entrypoint?: string;
}

/**
 * Start Executor then Admission as owned OS processes and verify each through
 * Runtime discovery. On any failure every child started here is stopped
 * before the error is rethrown; nothing outlives a failed start.
 */
export async function startLocalRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  options: LocalRuntimeStartOptions = {},
): Promise<SupervisedLocalRuntime> {
  const entry = options.entrypoint ?? localRuntimeEntrypoint();
  const children: ManagedChild[] = [];
  try {
    const executor = await startAndVerify("executor", environment, children, entry);
    const admission = await startAndVerify("admission", environment, children, entry);
    writeLocalRuntimeLog({ component: "executor", event: "ready", outcome: "success" });
    writeLocalRuntimeLog({ component: "admission", event: "ready", outcome: "success" });
    let stopping: Promise<boolean> | undefined;
    return Object.freeze({
      executorId: executor.announcement!.id,
      admissionId: admission.announcement!.id,
      exited: Promise.race(
        children.map((child) =>
          child.exit.then((result) => ({ component: child.component, code: result.code, signal: result.signal })),
        ),
      ),
      stop: () => (stopping ??= stopChildren(children, environment)),
    });
  } catch (error: unknown) {
    let shutdownError: unknown;
    try {
      await stopChildren(children, environment);
    } catch (stopError: unknown) {
      shutdownError = stopError;
    }
    if (shutdownError !== undefined) {
      throw new LocalRuntimeSupervisorError(
        "LOCAL_RUNTIME_SUPERVISOR_SHUTDOWN_FAILED",
        `${error instanceof Error ? error.message : "Local Runtime supervision failed."} ${shutdownError instanceof Error ? shutdownError.message : "Child shutdown failed."}`,
      );
    }
    throw error;
  }
}

export type LocalRuntimeProbeStatus = "not-running" | "unhealthy" | "healthy";

export interface LocalRuntimeProbe {
  readonly status: LocalRuntimeProbeStatus;
  /** Secret-free reason for a non-healthy status. */
  readonly reason?: string;
  readonly executorId?: string;
  readonly admissionId?: string;
}

async function reachable(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(endpoint, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * Observe the discovered local Runtime without owning it: no announcement or
 * an unreachable (stale) announcement is `not-running`; a reachable service
 * that fails its identity/readiness check is `unhealthy`. Admission reports
 * ready only after its own Executor check, so a TLS Executor is judged by it.
 */
export async function probeLocalRuntime(environment: NodeJS.ProcessEnv = process.env): Promise<LocalRuntimeProbe> {
  let executor: LocalRuntimeEndpoint | undefined;
  let admission: LocalRuntimeEndpoint | undefined;
  try {
    executor = readLocalRuntimeEndpoint("executor", environment);
    admission = readLocalRuntimeEndpoint("admission", environment);
  } catch {
    return { status: "unhealthy", reason: "Local Runtime discovery state is unreadable." };
  }
  const ids = {
    ...(executor === undefined ? {} : { executorId: executor.id }),
    ...(admission === undefined ? {} : { admissionId: admission.id }),
  };
  const live = await Promise.all([
    executor === undefined ? false : reachable(executor.endpoint),
    admission === undefined ? false : reachable(admission.endpoint),
  ]);
  if (!live[0] && !live[1]) return { status: "not-running", ...ids };
  if (executor === undefined || admission === undefined || !live[0] || !live[1])
    return { status: "unhealthy", reason: "Only part of the local Runtime is reachable.", ...ids };
  try {
    if (new URL(executor.endpoint).protocol === "http:") await verifyHealth("executor", executor.id, executor.endpoint);
    await verifyHealth("admission", admission.id, admission.endpoint);
  } catch (error: unknown) {
    return {
      status: "unhealthy",
      reason: error instanceof LocalRuntimeSupervisorError ? error.message : "Local Runtime health failed.",
      ...ids,
    };
  }
  return { status: "healthy", ...ids };
}

/** Start and supervise two OS processes, using Runtime discovery for each readiness check. */
export async function superviseLocalRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  json = false,
): Promise<number> {
  let requestedSignal: NodeJS.Signals | undefined;
  let resolveSignal: (signal: NodeJS.Signals) => void = () => {};
  const signalRequested = new Promise<NodeJS.Signals>((resolve) => {
    resolveSignal = resolve;
  });
  const onInterrupt = (): void => {
    requestedSignal ??= "SIGINT";
    resolveSignal(requestedSignal);
  };
  const onTerminate = (): void => {
    requestedSignal ??= "SIGTERM";
    resolveSignal(requestedSignal);
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const runtime = await startLocalRuntime(environment);
    try {
      if (json) {
        console.log(
          JSON.stringify({
            ok: true,
            operation: "runtime.supervise",
            executorId: runtime.executorId,
            admissionId: runtime.admissionId,
            readiness: "ready",
            foreground: true,
          }),
        );
      } else {
        console.log("Local Admission and Executor are ready under supervision.");
        console.log("Both services expose secret-free loopback status pages at /status.");
        console.log("Press Ctrl-C to stop both services.");
      }
      const outcome = await Promise.race([
        runtime.exited.then((result) => ({ kind: "child" as const, ...result })),
        signalRequested.then((signal) => ({ kind: "signal" as const, signal })),
      ]);
      if (requestedSignal !== undefined || outcome.kind === "signal") {
        const forced = await runtime.stop();
        if (forced) {
          throw new LocalRuntimeSupervisorError(
            "LOCAL_RUNTIME_SUPERVISOR_SHUTDOWN_FORCED",
            "A local Runtime child required forced termination.",
          );
        }
        return 0;
      }
      const termination =
        outcome.signal === null ? `exit code ${outcome.code ?? "unknown"}` : `signal ${outcome.signal}`;
      writeLocalRuntimeLog({
        component: runtimeLogComponent(outcome.component),
        event: "unexpected-exit",
        outcome: "failure",
        ...(outcome.code === null ? {} : { exitCode: outcome.code }),
        ...(outcome.signal === null ? {} : { signal: outcome.signal }),
      });
      throw new LocalRuntimeSupervisorError(
        "LOCAL_RUNTIME_SUPERVISOR_CHILD_EXITED",
        `${outcome.component} stopped unexpectedly with ${termination}; the other local Runtime service was stopped.`,
      );
    } catch (error: unknown) {
      let shutdownError: unknown;
      try {
        await runtime.stop();
      } catch (stopError: unknown) {
        shutdownError = stopError;
      }
      if (shutdownError !== undefined) {
        throw new LocalRuntimeSupervisorError(
          "LOCAL_RUNTIME_SUPERVISOR_SHUTDOWN_FAILED",
          `${error instanceof Error ? error.message : "Local Runtime supervision failed."} ${shutdownError instanceof Error ? shutdownError.message : "Child shutdown failed."}`,
        );
      }
      throw error;
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}
