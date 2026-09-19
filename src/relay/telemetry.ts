/**
 * Secret-safe transport telemetry for the Hosted Repository Relay.
 *
 * The event shape is deliberately closed.  No request, result, signature,
 * credential, token, or provider response is accepted by this module.
 */

import type { RelayDeliveryState } from "./delivery-state.js";
import type { RelayRepositoryIdentity } from "./contract.js";

export const RELAY_TELEMETRY_VERSION = 1 as const;

export type RelayTelemetrySurface = "durable-object" | "hosted-worker";
export type RelayTelemetryKind = "connection" | "message" | "job" | "delivery" | "cleanup" | "cpu-active";
export type RelayTelemetryFailureClass =
  | "none"
  | "malformed"
  | "cross-repository"
  | "overloaded"
  | "rate-limited"
  | "expired"
  | "disconnected"
  | "storage"
  | "transport";

export interface RelayTelemetryCounters {
  readonly connections: number;
  readonly inFlightJobs: number;
  readonly retainedJobs: number;
  readonly messagesInWindow: number;
  readonly cpuActiveMs?: number;
}

export interface RelayTelemetryEvent {
  readonly version: typeof RELAY_TELEMETRY_VERSION;
  readonly occurredAtMs: number;
  readonly kind: RelayTelemetryKind;
  readonly surface: RelayTelemetrySurface;
  /** Stable pseudonymous repository identity; never the repository ID itself. */
  readonly repositoryKey: string;
  readonly connectionId?: string;
  readonly jobId?: string;
  readonly deliveryState?: RelayDeliveryState["phase"];
  readonly failureClass?: RelayTelemetryFailureClass;
  readonly durationMs?: number;
  readonly counters?: RelayTelemetryCounters;
}

export interface RelayTelemetrySink {
  record(event: RelayTelemetryEvent): void | Promise<void>;
}

/** The small logging surface used by the Cloudflare Observability adapter. */
export interface RelayTelemetryLogger {
  log(line: string): void;
}

export interface RelayTelemetryEventInput {
  readonly occurredAtMs: number;
  readonly kind: RelayTelemetryKind;
  readonly surface: RelayTelemetrySurface;
  readonly repository: RelayRepositoryIdentity;
  readonly connectionId?: string;
  readonly jobId?: string;
  readonly deliveryState?: RelayDeliveryState["phase"];
  readonly failureClass?: RelayTelemetryFailureClass;
  readonly durationMs?: number;
  readonly counters?: RelayTelemetryCounters;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const MAX_DURATION_MS = 86_400_000;

function boundedTime(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function boundedDuration(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, MAX_DURATION_MS);
}

function boundedIdentifier(value: string | undefined): string | undefined {
  return value !== undefined && IDENTIFIER_PATTERN.test(value) ? value : undefined;
}

function boundedCounter(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, 1_000_000);
}

function normalizeCounters(input: RelayTelemetryCounters): RelayTelemetryCounters {
  return Object.freeze({
    connections: boundedCounter(input.connections),
    inFlightJobs: boundedCounter(input.inFlightJobs),
    retainedJobs: boundedCounter(input.retainedJobs),
    messagesInWindow: boundedCounter(input.messagesInWindow),
    ...(input.cpuActiveMs === undefined ? {} : { cpuActiveMs: boundedDuration(input.cpuActiveMs) }),
  });
}

function hashPart(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (const byte of new TextEncoder().encode(input)) hash = Math.imul(hash ^ byte, 16_777_619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Return a stable, non-reversible-enough operational partition key. */
export function relayTelemetryRepositoryKey(repository: RelayRepositoryIdentity): string {
  const input = `${repository.repositoryHost}\u0000${repository.repositoryId}`;
  return `repo-${hashPart(input, 2_166_136_261)}${hashPart(input, 2_654_435_761)}`;
}

export function createRelayTelemetryEvent(input: RelayTelemetryEventInput): RelayTelemetryEvent {
  const counters = input.counters === undefined ? undefined : normalizeCounters(input.counters);
  return Object.freeze({
    version: RELAY_TELEMETRY_VERSION,
    occurredAtMs: boundedTime(input.occurredAtMs),
    kind: input.kind,
    surface: input.surface,
    repositoryKey: relayTelemetryRepositoryKey(input.repository),
    ...(boundedIdentifier(input.connectionId) === undefined ? {} : { connectionId: input.connectionId }),
    ...(boundedIdentifier(input.jobId) === undefined ? {} : { jobId: input.jobId }),
    ...(input.deliveryState === undefined ? {} : { deliveryState: input.deliveryState }),
    ...(input.failureClass === undefined ? {} : { failureClass: input.failureClass }),
    ...(boundedDuration(input.durationMs) === undefined ? {} : { durationMs: boundedDuration(input.durationMs) }),
    ...(counters === undefined ? {} : { counters }),
  });
}

/**
 * Emit bounded relay events as JSON lines for Cloudflare Workers Observability.
 *
 * The logger is injectable so production wiring can be exercised without
 * relying on the ambient console in deterministic tests. Only the already
 * normalized RelayTelemetryEvent crosses this boundary.
 */
export function createCloudflareRelayTelemetrySink(logger: RelayTelemetryLogger = console): RelayTelemetrySink {
  return Object.freeze({
    record(event: RelayTelemetryEvent): void {
      logger.log(JSON.stringify(event));
    },
  });
}

/** Default sink for the hosted Worker and Repository Relay Durable Object. */
export const DEFAULT_RELAY_TELEMETRY_SINK: RelayTelemetrySink = createCloudflareRelayTelemetrySink();

/** Telemetry must never be able to change transport behavior. */
export function recordRelayTelemetry(
  sink: RelayTelemetrySink | undefined,
  event: RelayTelemetryEvent,
): Promise<void> | undefined {
  if (sink === undefined) return undefined;
  try {
    const result = sink.record(event);
    return result === undefined ? undefined : Promise.resolve(result).catch(() => undefined);
  } catch {
    return undefined;
  }
}
