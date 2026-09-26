import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { AUTHORIZED_EXECUTION_OPERATIONS } from "../authorized-execution.js";
import { validateRuntimeFailure, type RuntimeFailure } from "../runtime-contracts/runtime-failure.js";

export type LocalRuntimeLogComponent = "admission" | "executor" | "supervisor";
export type LocalRuntimeLogEvent =
  | "request.received"
  | "request.completed"
  | "execution.handoff"
  | "execution.received"
  | "execution.completed"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "forced-stop"
  | "unexpected-exit";
export type LocalRuntimeLogOutcome = "success" | "denied" | "failure" | "unknown";

export interface LocalRuntimeLogFields {
  readonly component: LocalRuntimeLogComponent;
  readonly event: LocalRuntimeLogEvent;
  readonly method?: string;
  readonly route?: string;
  readonly operation?: string;
  readonly correlationId?: string;
  readonly elapsedMs?: number;
  readonly status?: number;
  readonly outcome?: LocalRuntimeLogOutcome;
  readonly failure?: unknown;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
}

const COMPONENTS = new Set<LocalRuntimeLogComponent>(["admission", "executor", "supervisor"]);
const EVENTS = new Set<LocalRuntimeLogEvent>([
  "request.received",
  "request.completed",
  "execution.handoff",
  "execution.received",
  "execution.completed",
  "starting",
  "ready",
  "stopping",
  "stopped",
  "forced-stop",
  "unexpected-exit",
]);
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const OUTCOMES = new Set<LocalRuntimeLogOutcome>(["success", "denied", "failure", "unknown"]);
const SIGNALS = new Set([
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGKILL",
  "SIGUSR1",
  "SIGSEGV",
  "SIGUSR2",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
  "SIGCHLD",
  "SIGCONT",
  "SIGSTOP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGVTALRM",
  "SIGPROF",
  "SIGWINCH",
  "SIGIO",
  "SIGSYS",
]);
const STATIC_ROUTES = new Set([
  "/status",
  "/health",
  "/v1/repository",
  "/v1/pull-request-context",
  "/v1/branch-policy",
  "/v1/readiness",
  "/v1/sessions",
  "/v1/executions",
  "/v1/evidence",
  "/v1/governed-contract",
]);
const CORRELATION_ID = /^(?:local_[0-9a-f-]{36}|corr_[0-9a-f]{24})$/u;
const MAX_ELAPSED_MS = 2_147_483_647;

const responseFailures = new WeakMap<Response, RuntimeFailure>();

function failureFields(
  value: unknown,
): { readonly code: string; readonly stage: string; readonly category: string } | undefined {
  const failure = validateRuntimeFailure(value);
  if (failure === undefined) return undefined;
  return { code: failure.reason, stage: failure.stage, category: failure.category };
}

function safeRoute(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  let pathname: string;
  try {
    pathname = new URL(value, "http://local-runtime.invalid").pathname;
  } catch {
    return undefined;
  }
  if (STATIC_ROUTES.has(pathname)) return pathname;
  if (/^\/v1\/sessions\/[^/]+$/u.test(pathname)) return "/v1/sessions/:id";
  return "/unknown";
}

function boundedElapsedMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(MAX_ELAPSED_MS, Math.floor(value));
}

export function runtimeCorrelationForRequestId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[\x21-\x7e]+$/u.test(value))
    return undefined;
  const digest = createHash("sha256").update("inari-local-runtime-request\0").update(value).digest("hex");
  return `corr_${digest.slice(0, 24)}`;
}

/** Emit only the closed, bounded Runtime log projection to the child stderr channel. */
export function writeLocalRuntimeLog(fields: LocalRuntimeLogFields): void {
  if (!COMPONENTS.has(fields.component) || !EVENTS.has(fields.event)) return;
  const projected: Record<string, unknown> = { component: fields.component, event: fields.event };
  if (fields.method !== undefined) projected.method = METHODS.has(fields.method) ? fields.method : "OTHER";
  const route = safeRoute(fields.route);
  if (route !== undefined) projected.route = route;
  if (
    typeof fields.operation === "string" &&
    AUTHORIZED_EXECUTION_OPERATIONS.includes(fields.operation as (typeof AUTHORIZED_EXECUTION_OPERATIONS)[number])
  ) {
    projected.operation = fields.operation;
  }
  if (typeof fields.correlationId === "string" && CORRELATION_ID.test(fields.correlationId))
    projected.correlationId = fields.correlationId;
  const elapsedMs = boundedElapsedMs(fields.elapsedMs);
  if (elapsedMs !== undefined) projected.elapsedMs = elapsedMs;
  if (
    typeof fields.status === "number" &&
    Number.isInteger(fields.status) &&
    fields.status >= 100 &&
    fields.status <= 599
  )
    projected.status = fields.status;
  if (fields.outcome !== undefined && OUTCOMES.has(fields.outcome)) projected.outcome = fields.outcome;
  const failure = failureFields(fields.failure);
  if (failure !== undefined) projected.failure = failure;
  if (
    fields.exitCode !== undefined &&
    fields.exitCode !== null &&
    Number.isInteger(fields.exitCode) &&
    fields.exitCode >= -1 &&
    fields.exitCode <= 255
  ) {
    projected.exitCode = fields.exitCode;
  }
  if (typeof fields.signal === "string" && SIGNALS.has(fields.signal)) projected.signal = fields.signal;
  try {
    process.stderr.write(`${JSON.stringify(projected)}\n`);
  } catch {
    // Logging must never change a Runtime request or shutdown outcome.
  }
}

export function rememberLocalRuntimeFailure(response: Response, failure: unknown): Response {
  const validated = validateRuntimeFailure(failure);
  if (validated !== undefined) responseFailures.set(response, validated);
  return response;
}

export function localRuntimeFailureForResponse(response: Response): RuntimeFailure | undefined {
  return responseFailures.get(response);
}

export interface LocalRuntimeRequestLog {
  readonly correlationId: string;
  complete(status?: number, failure?: unknown): void;
}

export function localRuntimeOutcomeForStatus(status: number | undefined): LocalRuntimeLogOutcome {
  if (status === undefined || !Number.isInteger(status) || status < 100 || status > 599) return "failure";
  if (status >= 500) return "failure";
  if (status >= 400) return "denied";
  return "success";
}

export function beginLocalRuntimeRequest(
  component: Exclude<LocalRuntimeLogComponent, "supervisor">,
  method: string,
  route: string,
): LocalRuntimeRequestLog {
  const correlationId = `local_${randomUUID()}`;
  const startedAt = performance.now();
  writeLocalRuntimeLog({ component, event: "request.received", method, route, correlationId });
  let completed = false;
  return {
    correlationId,
    complete(status, failure) {
      if (completed) return;
      completed = true;
      const validatedFailure = validateRuntimeFailure(failure);
      const validStatus =
        status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
      writeLocalRuntimeLog({
        component,
        event: "request.completed",
        method,
        route,
        correlationId,
        elapsedMs: performance.now() - startedAt,
        ...(validStatus === undefined
          ? { outcome: "failure" as const }
          : {
              status: validStatus,
              outcome:
                validatedFailure === undefined
                  ? localRuntimeOutcomeForStatus(validStatus)
                  : validStatus >= 400 && validStatus < 500
                    ? "denied"
                    : "failure",
            }),
        ...(validatedFailure === undefined ? {} : { failure: validatedFailure }),
      });
    },
  };
}
