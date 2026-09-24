/** Local process supervision for the distinct Admission and Executor services. */

import { spawn, type ChildProcess } from "node:child_process";
import { extname } from "node:path";
import { LOCAL_ADMISSION_HEALTH_PATH, LOCAL_ADMISSION_PROTOCOL_VERSION } from "./admission-server.js";
import { LOCAL_EXECUTOR_HEALTH_PATH, LOCAL_EXECUTOR_PROTOCOL_VERSION } from "./executor-http.js";
import {
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
  announcement?: LocalRuntimeEndpoint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedAppend(previous: string, addition: string): string {
  const next = previous + addition;
  return Buffer.byteLength(next, "utf8") <= MAX_CHILD_OUTPUT_BYTES ? next : next.slice(-MAX_CHILD_OUTPUT_BYTES);
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

function createManagedChild(component: LocalRuntimeComponent, environment: NodeJS.ProcessEnv): ManagedChild {
  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) {
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
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = boundedAppend(stderr, chunk);
  });
  const exit = new Promise<ChildExit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const spawnError = new Promise<Error>((resolve) => child.once("error", resolve));
  return { component, child, exit, closed, spawnError, readStderr: () => stderr };
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
  const path = component === "admission" ? LOCAL_ADMISSION_HEALTH_PATH : LOCAL_EXECUTOR_HEALTH_PATH;
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
  const protocol = component === "admission" ? LOCAL_ADMISSION_PROTOCOL_VERSION : LOCAL_EXECUTOR_PROTOCOL_VERSION;
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
): Promise<ManagedChild> {
  const child = createManagedChild(component, environment);
  children.push(child);
  const id = await waitForStartup(child);
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
  if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill("SIGTERM");
  let stopped = await waitForClose(child, SHUTDOWN_TIMEOUT_MS);
  let forced = false;
  if (!stopped) {
    forced = true;
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
    const current = readLocalRuntimeEndpoint(child.component, environment);
    if (current?.instanceId === child.announcement.instanceId) {
      throw new LocalRuntimeSupervisorError(
        "LOCAL_RUNTIME_SUPERVISOR_DISCOVERY_STALE",
        `${child.component} shutdown left its endpoint announcement active.`,
      );
    }
  }
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

/** Start and supervise two OS processes, using Runtime discovery for each readiness check. */
export async function superviseLocalRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  json = false,
): Promise<number> {
  const children: ManagedChild[] = [];
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
    const executor = await startAndVerify("executor", environment, children);
    const admission = await startAndVerify("admission", environment, children);
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          operation: "runtime.supervise",
          executorId: executor.announcement?.id,
          admissionId: admission.announcement?.id,
          readiness: "ready",
          foreground: true,
        }),
      );
    } else {
      console.log("Local Admission and Executor are ready under supervision.");
      console.log("Both services expose secret-free loopback status pages at /status.");
      console.log("Press Ctrl-C to stop both services.");
    }
    const exit = Promise.race(children.map((child) => child.exit.then((result) => ({ child, result }))));
    const outcome = await Promise.race([
      exit.then((value) => ({ kind: "child" as const, ...value })),
      signalRequested.then((signal) => ({ kind: "signal" as const, signal })),
    ]);
    if (requestedSignal !== undefined || outcome.kind === "signal") {
      const forced = await stopChildren(children, environment);
      if (forced) {
        throw new LocalRuntimeSupervisorError(
          "LOCAL_RUNTIME_SUPERVISOR_SHUTDOWN_FORCED",
          "A local Runtime child required forced termination.",
        );
      }
      return 0;
    }
    const { child, result } = outcome;
    const termination = result.signal === null ? `exit code ${result.code ?? "unknown"}` : `signal ${result.signal}`;
    throw new LocalRuntimeSupervisorError(
      "LOCAL_RUNTIME_SUPERVISOR_CHILD_EXITED",
      `${child.component} stopped unexpectedly with ${termination}; the other local Runtime service was stopped.`,
    );
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
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}
