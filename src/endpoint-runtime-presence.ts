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

export interface EndpointRuntimePresenceRuntimeEntry extends EndpointRuntimePresenceRuntime {
  readonly state: Exclude<EndpointRuntimePresenceState, "unavailable">;
  readonly freshness: EndpointRuntimePresenceFreshnessEvidence;
}

export interface EndpointRuntimePresenceProjection {
  readonly version: EndpointRuntimePresenceContractVersion;
  readonly endpoint: EndpointIdentity;
  readonly repository: EndpointRepositoryIdentity;
  /** Presence is deliberately not an authorization or repository authority. */
  readonly authoritative: false;
  readonly state: EndpointRuntimePresenceState;
  readonly freshness: EndpointRuntimePresenceFreshnessEvidence;
  /** Bounded, deterministic presence evidence for each Runtime identity. */
  readonly runtimes: readonly EndpointRuntimePresenceRuntimeEntry[];
  /** Compatibility projection for callers that only consume one Runtime. */
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

function runtimeState(
  record: EndpointRuntimePresenceRelayRecord,
  evidence: EndpointRuntimePresenceFreshnessEvidence,
  nowMs: number,
): Exclude<EndpointRuntimePresenceState, "unavailable"> {
  if (evidence.state === "unknown") return "unknown";
  if (evidence.state === "stale" || record.expiresAtMs <= nowMs) return "stale";
  if (record.state === "connected" && record.current) {
    return record.authenticated && record.generation !== undefined ? "connected" : "unknown";
  }
  if (record.state === "connected") return "stale";
  if (record.state === "reconnecting") return "reconnecting";
  if (record.state === "stale") return "stale";
  return "unknown";
}

function runtimeEntry(
  record: EndpointRuntimePresenceRelayRecord,
  nowMs: number,
  maxAgeMs: number,
): EndpointRuntimePresenceRuntimeEntry {
  const evidence = freshness(record.observedAtMs, nowMs, maxAgeMs);
  return Object.freeze({
    ...runtimeOf(record),
    state: runtimeState(record, evidence, nowMs),
    freshness: evidence,
  });
}

function projection(
  endpoint: EndpointIdentity,
  repository: EndpointRepositoryIdentity,
  state: EndpointRuntimePresenceState,
  evidence: EndpointRuntimePresenceFreshnessEvidence,
  runtimes: readonly EndpointRuntimePresenceRuntimeEntry[],
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
    runtimes: Object.freeze(runtimes.slice(0, ENDPOINT_RUNTIME_PRESENCE_LIMITS.maxRecords)),
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

function validRelayRecord(record: EndpointRuntimePresenceRelayRecord, repository: EndpointRepositoryIdentity): boolean {
  return (
    record !== null &&
    typeof record === "object" &&
    record.version === 1 &&
    typeof record.connectionId === "string" &&
    typeof record.delegatorId === "string" &&
    (record.state === "connected" ||
      record.state === "reconnecting" ||
      record.state === "stale" ||
      record.state === "unknown") &&
    typeof record.authenticated === "boolean" &&
    typeof record.current === "boolean" &&
    (record.generation === undefined || (Number.isSafeInteger(record.generation) && record.generation >= 0)) &&
    Number.isSafeInteger(record.openedAtMs) &&
    record.openedAtMs >= 0 &&
    Number.isSafeInteger(record.expiresAtMs) &&
    record.expiresAtMs >= 0 &&
    Number.isSafeInteger(record.observedAtMs) &&
    record.observedAtMs >= 0 &&
    repositoryMatches(repository, record.repository)
  );
}

function generationValue(record: EndpointRuntimePresenceRelayRecord): number {
  return record.generation === undefined ? -1 : record.generation;
}

function selectRuntimeRecord(
  records: readonly EndpointRuntimePresenceRelayRecord[],
):
  | { readonly record: EndpointRuntimePresenceRelayRecord; readonly ambiguous: false }
  | { readonly record: null; readonly ambiguous: true } {
  const current = records.filter((record) => record.current);
  if (current.length > 0) {
    const highestGeneration = Math.max(...current.map(generationValue));
    const highest = current.filter((record) => generationValue(record) === highestGeneration);
    if (highest.length !== 1) return { record: null, ambiguous: true };
    return { record: highest[0] as EndpointRuntimePresenceRelayRecord, ambiguous: false };
  }

  const candidates = records.filter((record) => record.state === "reconnecting");
  const fallback = candidates.length > 0 ? candidates : records;
  const highestGeneration = Math.max(...fallback.map(generationValue));
  const highest = fallback.filter((record) => generationValue(record) === highestGeneration);
  const selected = [...highest].sort((left, right) => {
    if (left.observedAtMs !== right.observedAtMs) return right.observedAtMs - left.observedAtMs;
    if (left.openedAtMs !== right.openedAtMs) return right.openedAtMs - left.openedAtMs;
    return right.expiresAtMs - left.expiresAtMs;
  })[0];
  return { record: selected as EndpointRuntimePresenceRelayRecord, ambiguous: false };
}

function identityKey(record: EndpointRuntimePresenceRelayRecord): string {
  return JSON.stringify([record.connectionId, record.delegatorId]);
}

function orderedRuntimeGroups(
  records: readonly EndpointRuntimePresenceRelayRecord[],
): readonly (readonly [string, readonly EndpointRuntimePresenceRelayRecord[]])[] {
  const grouped = new Map<string, EndpointRuntimePresenceRelayRecord[]>();
  for (const record of records) {
    const key = identityKey(record);
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, [record]);
    else group.push(record);
  }
  return [...grouped.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
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
      [],
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
      [],
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
      [],
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
      [],
      null,
      [diagnostic("ENDPOINT_RUNTIME_PRESENCE_INVALID_RELAY", "Relay presence could not be read deterministically.")],
    );
  }
  if (records.some((record) => !repositoryMatches(repository, record?.repository))) {
    return projection(
      endpoint,
      repository,
      "unknown",
      Object.freeze({ ...baseFreshness, state: "unknown", ageMs: null }),
      [],
      null,
      [
        diagnostic(
          "ENDPOINT_RUNTIME_PRESENCE_REPOSITORY_MISMATCH",
          "Relay evidence crosses immutable repository identity.",
        ),
      ],
    );
  }
  if (records.some((record) => !validRelayRecord(record, repository))) {
    return projection(
      endpoint,
      repository,
      "unknown",
      Object.freeze({ ...baseFreshness, state: "unknown", ageMs: null }),
      [],
      null,
      [diagnostic("ENDPOINT_RUNTIME_PRESENCE_INVALID_RELAY", "Relay presence records are malformed.")],
    );
  }
  const matching = records.filter(
    (record) =>
      (input.connectionId === undefined || record.connectionId === input.connectionId) &&
      (input.delegatorId === undefined || record.delegatorId === input.delegatorId),
  );
  if (matching.length === 0) {
    return projection(endpoint, repository, "unavailable", baseFreshness, [], null, []);
  }

  const groups = orderedRuntimeGroups(matching);
  const selections = groups.map(([, group]) => selectRuntimeRecord(group));
  if (selections.some((selection) => selection.ambiguous)) {
    return projection(
      endpoint,
      repository,
      "unknown",
      Object.freeze({ ...baseFreshness, state: "unknown", ageMs: null }),
      [],
      null,
      [
        diagnostic(
          "ENDPOINT_RUNTIME_PRESENCE_AMBIGUOUS",
          "Relay reported conflicting evidence for a Runtime identity/current generation.",
        ),
      ],
    );
  }
  const selected = selections.map((selection) => selection.record as EndpointRuntimePresenceRelayRecord);
  const runtimes = Object.freeze(selected.map((record) => runtimeEntry(record, nowMs, maxAgeMs)));
  const state = runtimes.some((runtime) => runtime.state === "connected")
    ? "connected"
    : runtimes.some((runtime) => runtime.state === "reconnecting")
      ? "reconnecting"
      : runtimes.every((runtime) => runtime.state === "stale")
        ? "stale"
        : "unknown";
  const diagnostics = runtimes.some((runtime) => runtime.state === "stale")
    ? [diagnostic("ENDPOINT_RUNTIME_PRESENCE_STALE", "Relay evidence exceeds the configured freshness window.")]
    : [];
  return projection(
    endpoint,
    repository,
    state,
    baseFreshness,
    runtimes,
    runtimes.length === 1 ? runtimeOf(selected[0] as EndpointRuntimePresenceRelayRecord) : null,
    diagnostics,
  );
}

/** Descriptive alias for Endpoint callers that use "project" as a read operation. */
export const readEndpointRuntimePresence = projectEndpointRuntimePresence;
