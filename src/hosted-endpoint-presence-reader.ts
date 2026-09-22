/**
 * Hosted, read-only adapter for Repository Relay Runtime presence.
 *
 * The adapter receives the repository identity after Endpoint authorization,
 * derives one Durable Object from its immutable provider ID, and turns only
 * the bounded presence snapshot into the existing Endpoint projection.
 */

import {
  MAX_RELAY_ENVELOPE_BYTES,
  normalizeRelayRepositoryIdentity,
  type RelayRepositoryIdentity,
} from "./relay/contract.js";
import {
  projectEndpointRuntimePresence,
  type EndpointRuntimePresenceProjection,
  type EndpointRuntimePresenceRelaySnapshot,
} from "./endpoint-runtime-presence.js";
import type { EndpointApiProjectionRequest } from "./endpoint-api.js";

const MAX_PRESENCE_RECORDS = 128;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const DELEGATOR_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

/** Fixed Worker-to-DO read seam; the outer Hosted Worker never routes it. */
export const RELAY_RUNTIME_PRESENCE_INTERNAL_PATH = "/__inari/internal/relay/presence" as const;
export const RELAY_RUNTIME_PRESENCE_INTERNAL_METHOD = "GET" as const;

export interface HostedEndpointPresenceStub {
  fetch(request: Request): Promise<Response>;
}

export interface HostedEndpointPresenceNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): HostedEndpointPresenceStub;
}

export interface HostedEndpointPresenceReaderOptions {
  readonly namespace: HostedEndpointPresenceNamespace;
  /** Injectable clock for deterministic projection tests. */
  readonly now?: () => number;
  readonly maxAgeMs?: number;
}

export type HostedEndpointPresenceReaderFunction = (
  request: EndpointApiProjectionRequest,
) => Promise<EndpointRuntimePresenceProjection>;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function sameRepository(left: RelayRepositoryIdentity, right: RelayRepositoryIdentity): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

function unknownSnapshot(repository: RelayRepositoryIdentity): EndpointRuntimePresenceRelaySnapshot {
  return Object.freeze({
    version: 1,
    repository: Object.freeze({
      repositoryHost: repository.repositoryHost,
      repositoryId: repository.repositoryId,
    }),
    availability: "unknown" as const,
    observedAtMs: 0,
    records: Object.freeze([]),
  });
}

function boundedTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeRecord(
  value: unknown,
  repository: RelayRepositoryIdentity,
): EndpointRuntimePresenceRelaySnapshot["records"][number] | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "repository",
      "connectionId",
      "delegatorId",
      "generation",
      "state",
      "authenticated",
      "current",
      "openedAtMs",
      "expiresAtMs",
      "observedAtMs",
    ]) ||
    value.version !== 1 ||
    typeof value.connectionId !== "string" ||
    !IDENTIFIER_PATTERN.test(value.connectionId) ||
    typeof value.delegatorId !== "string" ||
    !DELEGATOR_PATTERN.test(value.delegatorId) ||
    (value.generation !== undefined && (!Number.isSafeInteger(value.generation) || (value.generation as number) < 1)) ||
    (value.state !== "connected" &&
      value.state !== "reconnecting" &&
      value.state !== "stale" &&
      value.state !== "unknown") ||
    typeof value.authenticated !== "boolean" ||
    typeof value.current !== "boolean" ||
    !boundedTimestamp(value.openedAtMs) ||
    !boundedTimestamp(value.expiresAtMs) ||
    !boundedTimestamp(value.observedAtMs)
  ) {
    return undefined;
  }
  let recordRepository: RelayRepositoryIdentity;
  try {
    recordRepository = normalizeRelayRepositoryIdentity(value.repository);
  } catch {
    return undefined;
  }
  if (!sameRepository(recordRepository, repository)) return undefined;
  return Object.freeze({
    version: 1,
    repository: Object.freeze({
      repositoryHost: repository.repositoryHost,
      repositoryId: repository.repositoryId,
    }),
    connectionId: value.connectionId,
    delegatorId: value.delegatorId,
    ...(value.generation === undefined ? {} : { generation: value.generation as number }),
    state: value.state,
    authenticated: value.authenticated,
    current: value.current,
    openedAtMs: value.openedAtMs,
    expiresAtMs: value.expiresAtMs,
    observedAtMs: value.observedAtMs,
  });
}

function normalizeSnapshot(
  value: unknown,
  repository: RelayRepositoryIdentity,
): EndpointRuntimePresenceRelaySnapshot | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "repository", "availability", "observedAtMs", "records"]) ||
    value.version !== 1 ||
    (value.availability !== "available" && value.availability !== "unknown") ||
    !boundedTimestamp(value.observedAtMs) ||
    !Array.isArray(value.records) ||
    value.records.length > MAX_PRESENCE_RECORDS
  ) {
    return undefined;
  }
  let responseRepository: RelayRepositoryIdentity | null;
  if (value.repository === null) {
    responseRepository = null;
  } else {
    try {
      responseRepository = normalizeRelayRepositoryIdentity(value.repository);
    } catch {
      return undefined;
    }
    if (!sameRepository(responseRepository, repository)) return undefined;
  }
  if (value.availability === "available" && responseRepository === null) return undefined;
  const records = value.records.map((record) => normalizeRecord(record, repository));
  if (records.some((record): record is undefined => record === undefined)) return undefined;
  if (value.availability === "unknown" && records.length > 0) return undefined;
  return Object.freeze({
    version: 1,
    repository:
      responseRepository === null
        ? null
        : Object.freeze({
            repositoryHost: responseRepository.repositoryHost,
            repositoryId: responseRepository.repositoryId,
          }),
    availability: value.availability,
    observedAtMs: value.observedAtMs,
    records: Object.freeze(records as EndpointRuntimePresenceRelaySnapshot["records"]),
  });
}

function optionsOf(
  input: HostedEndpointPresenceReaderOptions | HostedEndpointPresenceNamespace,
): HostedEndpointPresenceReaderOptions {
  if ("namespace" in input) return input;
  return { namespace: input };
}

export class HostedEndpointPresenceReader {
  private readonly namespace: HostedEndpointPresenceNamespace;
  private readonly now: (() => number) | undefined;
  private readonly maxAgeMs: number | undefined;

  constructor(input: HostedEndpointPresenceReaderOptions | HostedEndpointPresenceNamespace) {
    const options = optionsOf(input);
    this.namespace = options.namespace;
    this.now = options.now;
    this.maxAgeMs = options.maxAgeMs;
  }

  async read(request: EndpointApiProjectionRequest): Promise<EndpointRuntimePresenceProjection> {
    const repository: RelayRepositoryIdentity = {
      repositoryHost: request.repository.repositoryHost,
      repositoryId: request.repository.repositoryId,
    };
    let snapshot: EndpointRuntimePresenceRelaySnapshot = unknownSnapshot(repository);
    try {
      const objectId = this.namespace.idFromName(repository.repositoryId);
      const stub = this.namespace.get(objectId);
      const url = new URL(`https://inari-relay.internal${RELAY_RUNTIME_PRESENCE_INTERNAL_PATH}`);
      url.searchParams.set("repositoryId", repository.repositoryId);
      url.searchParams.set("repositoryHost", repository.repositoryHost);
      const response = await stub.fetch(
        new Request(url, {
          method: RELAY_RUNTIME_PRESENCE_INTERNAL_METHOD,
          signal: request.signal,
        }),
      );
      if (response.status === 200) {
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength <= MAX_RELAY_ENVELOPE_BYTES) {
          const parsed = normalizeSnapshot(JSON.parse(text) as unknown, repository);
          if (parsed !== undefined) snapshot = parsed;
        }
      }
    } catch {
      // Transport, parse, and validation failures all become explicit unknown presence.
    }
    return projectEndpointRuntimePresence({
      endpoint: request.endpoint,
      repository: request.repository,
      relay: snapshot,
      ...(this.now === undefined ? {} : { now: this.now() }),
      ...(this.maxAgeMs === undefined ? {} : { maxAgeMs: this.maxAgeMs }),
    });
  }
}

export function createHostedEndpointPresenceReader(
  input: HostedEndpointPresenceReaderOptions | HostedEndpointPresenceNamespace,
): HostedEndpointPresenceReaderFunction {
  const reader = new HostedEndpointPresenceReader(input);
  return reader.read.bind(reader);
}
