/**
 * Bounded, read-only Endpoint projection of Repository Relay Runtime
 * presence.  Presence is operational evidence only: it never authenticates
 * an Endpoint, grants a capability, or replaces GitHub-owned state.
 */

import {
  validateEndpointIdentity,
  validateEndpointRepositoryIdentity,
  type EndpointIdentity,
  type EndpointRepositoryIdentity,
} from "./endpoint-authorization.js";
export const ENDPOINT_RUNTIME_PRESENCE_CONTRACT_VERSION = 1 as const;
export type EndpointRuntimePresenceContractVersion = typeof ENDPOINT_RUNTIME_PRESENCE_CONTRACT_VERSION;

export const ENDPOINT_RUNTIME_PRESENCE_STATES = Object.freeze([
  "connected",
  "unavailable",
  "stale",
  "reconnecting",
  "unknown",
] as const);
export type EndpointRuntimePresenceState = (typeof ENDPOINT_RUNTIME_PRESENCE_STATES)[number];

export const ENDPOINT_RUNTIME_PRESENCE_FRESHNESS_STATES = Object.freeze(["fresh", "stale", "unknown"] as const);
export type EndpointRuntimePresenceFreshness = (typeof ENDPOINT_RUNTIME_PRESENCE_FRESHNESS_STATES)[number];

export const ENDPOINT_RUNTIME_PRESENCE_LIMITS = Object.freeze({
  defaultMaxAgeMs: 300_000,
  maxAgeMs: 86_400_000,
  maxRecords: 128,
  maxDiagnostics: 8,
} as const);

export type EndpointRuntimePresenceDiagnosticCode =
  | "ENDPOINT_RUNTIME_PRESENCE_INVALID_RELAY"
  | "ENDPOINT_RUNTIME_PRESENCE_REPOSITORY_MISMATCH"
  | "ENDPOINT_RUNTIME_PRESENCE_AMBIGUOUS"
  | "ENDPOINT_RUNTIME_PRESENCE_STALE";

export interface EndpointRuntimePresenceDiagnostic {
  readonly code: EndpointRuntimePresenceDiagnosticCode;
  readonly message: string;
}

/** Structural read seam keeps the packaged Endpoint projection independent of the Worker adapter bundle. */
export interface EndpointRuntimePresenceRelayRecord {
  readonly version: number;
  readonly repository: { readonly repositoryHost: string; readonly repositoryId: string };
  readonly connectionId: string;
  readonly delegatorId: string;
  readonly generation?: number;
  readonly state: "connected" | "reconnecting" | "stale" | "unknown";
  readonly authenticated: boolean;
  readonly current: boolean;
  readonly openedAtMs: number;
  readonly expiresAtMs: number;
  readonly observedAtMs: number;
}

export interface EndpointRuntimePresenceRelaySnapshot {
  readonly version: number;
  readonly repository: { readonly repositoryHost: string; readonly repositoryId: string } | null;
  readonly availability: "available" | "unknown";
  readonly observedAtMs: number;
  readonly records: readonly EndpointRuntimePresenceRelayRecord[];
}

export interface EndpointRuntimePresenceInput {
  readonly endpoint: EndpointIdentity;
  readonly repository: EndpointRepositoryIdentity;
  readonly relay: EndpointRuntimePresenceRelaySnapshot;
  /** Optional immutable Runtime transport selectors. */
  readonly connectionId?: string;
  readonly delegatorId?: string;
  readonly now?: number | Date;
  readonly maxAgeMs?: number;
}

export interface EndpointRuntimePresenceFreshnessEvidence {
  readonly state: EndpointRuntimePresenceFreshness;
  readonly observedAtMs: number | null;
  readonly ageMs: number | null;
  readonly maxAgeMs: number;
}

export interface EndpointRuntimePresenceRuntime {
  readonly connectionId: string;
  readonly delegatorId: string;
  readonly generation?: number;
  readonly current: boolean;
}

export interface EndpointRuntimePresenceProjection {
  readonly version: EndpointRuntimePresenceContractVersion;
  readonly endpoint: EndpointIdentity;
  readonly repository: EndpointRepositoryIdentity;
  /** Presence is deliberately not an authorization or repository authority. */
  readonly authoritative: false;
  readonly state: EndpointRuntimePresenceState;
  readonly freshness: EndpointRuntimePresenceFreshnessEvidence;
  readonly runtime: EndpointRuntimePresenceRuntime | null;
  readonly diagnostics: readonly EndpointRuntimePresenceDiagnostic[];
}

export type EndpointRuntimePresence = EndpointRuntimePresenceProjection;

export class EndpointRuntimePresenceError extends TypeError {
  readonly code = "ENDPOINT_RUNTIME_PRESENCE_INVALID_INPUT" as const;

  constructor(message: string) {
    super(message);
    this.name = "EndpointRuntimePresenceError";
  }
}

function normalizeNow(value: number | Date | undefined): number {
  if (value === undefined) return Date.now();
  const result = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(result) || result < 0) throw new EndpointRuntimePresenceError("Presence clock is invalid.");
  return result;
}

function normalizeMaxAge(value: number | undefined): number {
  const result = value ?? ENDPOINT_RUNTIME_PRESENCE_LIMITS.defaultMaxAgeMs;
  if (!Number.isSafeInteger(result) || result < 0 || result > ENDPOINT_RUNTIME_PRESENCE_LIMITS.maxAgeMs) {
    throw new EndpointRuntimePresenceError("Presence freshness window is invalid.");
  }
  return result;
}

function repositoryMatches(left: EndpointRepositoryIdentity, right: unknown): boolean {
  if (typeof right !== "object" || right === null) return false;
  const value = right as { readonly repositoryHost?: unknown; readonly repositoryId?: unknown };
  return left.repositoryHost === value.repositoryHost && left.repositoryId === value.repositoryId;
}

function diagnostic(code: EndpointRuntimePresenceDiagnosticCode, message: string): EndpointRuntimePresenceDiagnostic {
  return Object.freeze({ code, message });
}

function freshness(
  observedAtMs: number | null,
  nowMs: number,
  maxAgeMs: number,
): EndpointRuntimePresenceFreshnessEvidence {
  if (observedAtMs === null || !Number.isSafeInteger(observedAtMs) || observedAtMs < 0 || observedAtMs > nowMs) {
    return Object.freeze({ state: "unknown", observedAtMs, ageMs: null, maxAgeMs });
  }
  const ageMs = nowMs - observedAtMs;
  return Object.freeze({
    state: ageMs <= maxAgeMs ? "fresh" : "stale",
    observedAtMs,
    ageMs,
    maxAgeMs,
  });
}

function runtimeOf(record: EndpointRuntimePresenceRelayRecord): EndpointRuntimePresenceRuntime {
  return Object.freeze({
    connectionId: record.connectionId,
    delegatorId: record.delegatorId,
    ...(record.generation === undefined ? {} : { generation: record.generation }),
    current: record.current,
  });
}

function projection(
  endpoint: EndpointIdentity,
  repository: EndpointRepositoryIdentity,
  state: EndpointRuntimePresenceState,
  evidence: EndpointRuntimePresenceFreshnessEvidence,
  runtime: EndpointRuntimePresenceRuntime | null,
  diagnostics: readonly EndpointRuntimePresenceDiagnostic[],
): EndpointRuntimePresenceProjection {
  return Object.freeze({
    version: ENDPOINT_RUNTIME_PRESENCE_CONTRACT_VERSION,
    endpoint,
    repository,
    authoritative: false,
    state,
    freshness: evidence,
    runtime,
    diagnostics: Object.freeze(diagnostics.slice(0, ENDPOINT_RUNTIME_PRESENCE_LIMITS.maxDiagnostics)),
  });
}

function normalizedIdentity(input: EndpointRuntimePresenceInput): {
  readonly endpoint: EndpointIdentity;
  readonly repository: EndpointRepositoryIdentity;
} {
  const endpoint = validateEndpointIdentity(input.endpoint);
  if (!endpoint.valid || endpoint.value === undefined)
    throw new EndpointRuntimePresenceError("Endpoint identity is invalid.");
  const repository = validateEndpointRepositoryIdentity(input.repository);
  if (!repository.valid || repository.value === undefined)
    throw new EndpointRuntimePresenceError("Endpoint repository identity is invalid.");
  return { endpoint: endpoint.value, repository: repository.value };
}

function relayRecords(input: EndpointRuntimePresenceRelaySnapshot): readonly EndpointRuntimePresenceRelayRecord[] {
  if (
    input === null ||
    typeof input !== "object" ||
    input.version !== 1 ||
    (input.availability !== "available" && input.availability !== "unknown") ||
    !Array.isArray(input.records) ||
    input.records.length > ENDPOINT_RUNTIME_PRESENCE_LIMITS.maxRecords
  ) {
    throw new EndpointRuntimePresenceError("Relay presence snapshot is invalid.");
  }
  return input.records;
}

/** Project one immutable Endpoint/repository context from bounded relay evidence. */
export function projectEndpointRuntimePresence(input: EndpointRuntimePresenceInput): EndpointRuntimePresenceProjection {
  const { endpoint, repository } = normalizedIdentity(input);
  const nowMs = normalizeNow(input.now);
  const maxAgeMs = normalizeMaxAge(input.maxAgeMs);
  const relayRepository = (() => {
    try {
      return input.relay.repository;
    } catch {
      return undefined;
    }
  })();
  const baseFreshness = freshness(
    Number.isSafeInteger(input.relay?.observedAtMs) ? input.relay.observedAtMs : null,
    nowMs,
    maxAgeMs,
  );
  if (relayRepository === undefined || relayRepository === null || input.relay.version !== 1) {
    return projection(
      endpoint,
      repository,
      "unknown",
      Object.freeze({ ...baseFreshness, state: "unknown", ageMs: null }),
      null,
      [diagnostic("ENDPOINT_RUNTIME_PRESENCE_INVALID_RELAY", "Relay evidence is missing or malformed.")],
    );
  }
  if (!repositoryMatches(repository, relayRepository)) {
    return projection(
      endpoint,
      repository,
      "unknown",
      Object.freeze({ ...baseFreshness, state: "unknown", ageMs: null }),
      null,
      [
        diagnostic(
          "ENDPOINT_RUNTIME_PRESENCE_REPOSITORY_MISMATCH",
          "Relay evidence crosses immutable repository identity.",
        ),
      ],
    );
  }
  let records: readonly EndpointRuntimePresenceRelayRecord[];
  try {
    records = relayRecords(input.relay);
  } catch {
    return projection(
      endpoint,
      repository,
      "unknown",
      Object.freeze({ ...baseFreshness, state: "unknown", ageMs: null }),
      null,
      [diagnostic("ENDPOINT_RUNTIME_PRESENCE_INVALID_RELAY", "Relay presence records are malformed.")],
    );
  }
  if (input.relay.availability === "unknown") {
    return projection(
      endpoint,
      repository,
      "unknown",
      Object.freeze({ ...baseFreshness, state: "unknown", ageMs: null }),
      null,
      [diagnostic("ENDPOINT_RUNTIME_PRESENCE_INVALID_RELAY", "Relay presence could not be read deterministically.")],
    );
  }
  if (
    records.some(
      (record) =>
        record === null ||
        typeof record !== "object" ||
        typeof record.connectionId !== "string" ||
        typeof record.delegatorId !== "string" ||
        typeof record.state !== "string" ||
        typeof record.current !== "boolean" ||
        !repositoryMatches(repository, record.repository),
    )
  ) {
    return projection(
      endpoint,
      repository,
      "unknown",
      Object.freeze({ ...baseFreshness, state: "unknown", ageMs: null }),
      null,
      [
        diagnostic(
          "ENDPOINT_RUNTIME_PRESENCE_REPOSITORY_MISMATCH",
          "Relay evidence crosses immutable repository identity.",
        ),
      ],
    );
  }
  const matching = records.filter(
    (record) =>
      (input.connectionId === undefined || record.connectionId === input.connectionId) &&
      (input.delegatorId === undefined || record.delegatorId === input.delegatorId),
  );
  const groups = new Set(matching.map((record) => `${record.connectionId}\u0000${record.delegatorId}`));
  if (groups.size > 1) {
    return projection(
      endpoint,
      repository,
      "unknown",
      Object.freeze({ ...baseFreshness, state: "unknown", ageMs: null }),
      null,
      [diagnostic("ENDPOINT_RUNTIME_PRESENCE_AMBIGUOUS", "Multiple Runtime identities match the Endpoint context.")],
    );
  }
  if (matching.length === 0) {
    return projection(endpoint, repository, "unavailable", baseFreshness, null, []);
  }
  const current = matching.filter((record) => record.state === "connected" && record.current);
  if (current.length > 1) {
    return projection(
      endpoint,
      repository,
      "unknown",
      Object.freeze({ ...baseFreshness, state: "unknown", ageMs: null }),
      null,
      [diagnostic("ENDPOINT_RUNTIME_PRESENCE_AMBIGUOUS", "Relay reported more than one current Runtime generation.")],
    );
  }
  const selected = current[0] ?? matching.find((record) => record.state === "reconnecting") ?? matching[0];
  const selectedFreshness = freshness(selected.observedAtMs, nowMs, maxAgeMs);
  if (selectedFreshness.state === "unknown") {
    return projection(endpoint, repository, "unknown", selectedFreshness, runtimeOf(selected), []);
  }
  if (selectedFreshness.state === "stale") {
    return projection(endpoint, repository, "stale", selectedFreshness, runtimeOf(selected), [
      diagnostic("ENDPOINT_RUNTIME_PRESENCE_STALE", "Relay evidence exceeds the configured freshness window."),
    ]);
  }
  if (selected.state === "connected" && selected.current) {
    return projection(endpoint, repository, "connected", selectedFreshness, runtimeOf(selected), []);
  }
  if (selected.state === "reconnecting") {
    return projection(endpoint, repository, "reconnecting", selectedFreshness, runtimeOf(selected), []);
  }
  return projection(endpoint, repository, "stale", selectedFreshness, runtimeOf(selected), []);
}

/** Descriptive alias for Endpoint callers that use "project" as a read operation. */
export const readEndpointRuntimePresence = projectEndpointRuntimePresence;
