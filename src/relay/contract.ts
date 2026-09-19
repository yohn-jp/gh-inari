/**
 * Deployment-neutral Repository Relay transport contract.
 *
 * This module owns routing identity, bounded framing, and delivery state only.
 * A signed Session request and a terminal result are opaque base64url payloads
 * here; Session, capability, repository, and Change authority stay elsewhere.
 */

export const RELAY_CONTRACT_VERSION = 1 as const;
export type RelayContractVersion = typeof RELAY_CONTRACT_VERSION;

export const MAX_RELAY_ENVELOPE_BYTES = 65_536 as const;
export const MAX_RELAY_OPAQUE_PAYLOAD_BYTES = 49_152 as const;
export const MAX_RELAY_TEXT_BYTES = 256 as const;
export const MAX_RELAY_IDENTIFIER_BYTES = 128 as const;
export const MAX_RELAY_IN_FLIGHT_JOBS = 32 as const;
export const MAX_RELAY_DEADLINE_MS = 30_000 as const;

export const RELAY_LIMITS = Object.freeze({
  envelopeBytes: MAX_RELAY_ENVELOPE_BYTES,
  opaquePayloadBytes: MAX_RELAY_OPAQUE_PAYLOAD_BYTES,
  textBytes: MAX_RELAY_TEXT_BYTES,
  identifierBytes: MAX_RELAY_IDENTIFIER_BYTES,
  inFlightJobs: MAX_RELAY_IN_FLIGHT_JOBS,
  deadlineMs: MAX_RELAY_DEADLINE_MS,
} as const);

export const RELAY_ENVELOPE_KINDS = Object.freeze(["connection", "job", "result", "control"] as const);
export type RelayEnvelopeKind = (typeof RELAY_ENVELOPE_KINDS)[number];

export const RELAY_DELIVERY_STATES = Object.freeze([
  "pre-delivery",
  "delivered-ambiguous",
  "terminal-result",
  "expired",
  "unavailable",
] as const);
export type RelayDeliveryState = (typeof RELAY_DELIVERY_STATES)[number];

const CONTROL_DELIVERY_STATES = Object.freeze(["delivered-ambiguous", "expired", "unavailable"] as const);
type RelayControlDeliveryState = (typeof CONTROL_DELIVERY_STATES)[number];

const JSON_ENCODER = new TextEncoder();
const JSON_DECODER = new TextDecoder("utf-8", { fatal: true });
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,253}[a-z0-9])?$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const FORBIDDEN_FIELD_PATTERN = /(?:private.?key|secret|credential|password|token|authorization|bearer)/iu;
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u;

export interface RelayRepositoryIdentity {
  /** Immutable provider repository ID used for routing and cross-repository checks. */
  readonly repositoryId: string;
  /** Deployment/provider host is routing metadata, never a mutable name binding. */
  readonly repositoryHost: string;
  /** Optional diagnostic metadata; it is not part of repository authority. */
  readonly repositoryNameWithOwner?: string;
}

export interface RelayConnectionEnvelope {
  readonly version: RelayContractVersion;
  readonly kind: "connection";
  readonly repository: RelayRepositoryIdentity;
  readonly connectionId: string;
  readonly maxInFlightJobs: number;
  readonly deadlineMs: number;
}

export interface RelayJobEnvelope {
  readonly version: RelayContractVersion;
  readonly kind: "job";
  readonly repository: RelayRepositoryIdentity;
  readonly connectionId: string;
  readonly jobId: string;
  readonly deliveryState: "pre-delivery";
  readonly deadlineMs: number;
  /** Exact signed Session request bytes, encoded as unpadded base64url. */
  readonly signedSessionRequest: string;
}

export interface RelayResultEnvelope {
  readonly version: RelayContractVersion;
  readonly kind: "result";
  readonly repository: RelayRepositoryIdentity;
  readonly connectionId: string;
  readonly jobId: string;
  readonly deliveryState: "terminal-result";
  /** Exact terminal result bytes, encoded as unpadded base64url. */
  readonly resultPayload: string;
}

export interface RelayControlEnvelope {
  readonly version: RelayContractVersion;
  readonly kind: "control";
  readonly repository: RelayRepositoryIdentity;
  readonly connectionId: string;
  readonly jobId: string;
  readonly deliveryState: RelayControlDeliveryState;
}

export type RelayEnvelope = RelayConnectionEnvelope | RelayJobEnvelope | RelayResultEnvelope | RelayControlEnvelope;

export type RelayExpectedRepository = string | RelayRepositoryIdentity;

export type RelayContractErrorCode =
  | "RELAY_INVALID_ROOT"
  | "RELAY_INVALID_REPOSITORY"
  | "RELAY_MISSING_FIELD"
  | "RELAY_UNKNOWN_FIELD"
  | "RELAY_FORBIDDEN_FIELD"
  | "RELAY_DUPLICATE_FIELD"
  | "RELAY_UNSUPPORTED_VERSION"
  | "RELAY_INVALID_KIND"
  | "RELAY_INVALID_TEXT"
  | "RELAY_INVALID_IDENTIFIER"
  | "RELAY_INVALID_NUMBER"
  | "RELAY_LIMIT_EXCEEDED"
  | "RELAY_INVALID_PAYLOAD"
  | "RELAY_INVALID_DELIVERY_STATE"
  | "RELAY_CROSS_REPOSITORY"
  | "RELAY_MALFORMED_JSON"
  | "RELAY_MALFORMED_WIRE";

export interface RelayDiagnostic {
  readonly code: RelayContractErrorCode;
  readonly path: string;
  readonly message: string;
}

export class RelayContractError extends TypeError {
  readonly code: RelayContractErrorCode;
  readonly path: string;

  constructor(code: RelayContractErrorCode, path: string, message: string) {
    super(message);
    this.name = "RelayContractError";
    this.code = code;
    this.path = path;
  }
}

export interface RelayValidationResult {
  readonly valid: boolean;
  readonly envelope?: RelayEnvelope;
  readonly diagnostics: readonly RelayDiagnostic[];
}

function fail(code: RelayContractErrorCode, path: string, message: string): never {
  throw new RelayContractError(code, path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, path: string, code: RelayContractErrorCode = "RELAY_INVALID_ROOT") {
  if (!isRecord(value)) fail(code, path, "Relay contract value must be a plain object.");
  return value;
}

function propertyPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function assertClosedObject(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  required: readonly string[] = allowed,
): void {
  const allowedSet = new Set(allowed);
  const keys = Reflect.ownKeys(value);
  const symbol = keys.find((key): key is symbol => typeof key === "symbol");
  if (symbol !== undefined) fail("RELAY_UNKNOWN_FIELD", path, "Symbol properties are not part of the relay schema.");
  const unknown = keys
    .filter((key): key is string => typeof key === "string")
    .filter((key) => !allowedSet.has(key))
    .sort()[0];
  if (unknown !== undefined) {
    const code = FORBIDDEN_FIELD_PATTERN.test(unknown) ? "RELAY_FORBIDDEN_FIELD" : "RELAY_UNKNOWN_FIELD";
    fail(code, propertyPath(path, unknown), `Field "${unknown}" is not part of the closed relay schema.`);
  }
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) {
    const key = [...missing].sort()[0] as string;
    fail("RELAY_MISSING_FIELD", propertyPath(path, key), `Required field "${key}" is missing.`);
  }
}

function normalizeText(value: unknown, path: string, maxBytes: number = MAX_RELAY_TEXT_BYTES): string {
  if (typeof value !== "string") fail("RELAY_INVALID_TEXT", path, "Relay text must be a string.");
  if (value.length === 0) fail("RELAY_INVALID_TEXT", path, "Relay text must not be empty.");
  const normalized = value.normalize("NFC");
  if (UNSAFE_TEXT_PATTERN.test(normalized) || /[\ud800-\udfff]/u.test(normalized)) {
    fail("RELAY_INVALID_TEXT", path, "Relay text contains unsafe or unpaired Unicode characters.");
  }
  if (JSON_ENCODER.encode(normalized).byteLength > maxBytes) {
    fail("RELAY_LIMIT_EXCEEDED", path, "Relay text exceeds its byte ceiling.");
  }
  return normalized;
}

function normalizeRepositoryId(value: unknown, path: string): string {
  if (typeof value !== "string" || !REPOSITORY_ID_PATTERN.test(value)) {
    fail("RELAY_INVALID_REPOSITORY", path, "Repository identity requires a positive immutable numeric ID.");
  }
  return value;
}

function normalizeIdentifier(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    JSON_ENCODER.encode(value).byteLength > MAX_RELAY_IDENTIFIER_BYTES ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    fail("RELAY_INVALID_IDENTIFIER", path, "Relay identifier is invalid or exceeds its byte ceiling.");
  }
  return value;
}

function normalizeBoundedInteger(value: unknown, path: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("RELAY_INVALID_NUMBER", path, "Relay number must be a positive safe integer.");
  }
  if ((value as number) > max) fail("RELAY_LIMIT_EXCEEDED", path, "Relay number exceeds its hard ceiling.");
  return value as number;
}

function decodeBase64Url(value: unknown, path: string, allowEmpty: boolean): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    (value.length > 0 && !BASE64URL_PATTERN.test(value))
  ) {
    fail("RELAY_INVALID_PAYLOAD", path, "Opaque relay payload must be unpadded base64url.");
  }
  if (value.length > Math.ceil((MAX_RELAY_OPAQUE_PAYLOAD_BYTES * 4) / 3) || value.length % 4 === 1) {
    fail("RELAY_LIMIT_EXCEEDED", path, "Opaque relay payload exceeds its byte ceiling.");
  }
  let accumulator = 0;
  let bits = 0;
  let outputLength = 0;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const digit =
      code >= 65 && code <= 90
        ? code - 65
        : code >= 97 && code <= 122
          ? code - 97 + 26
          : code >= 48 && code <= 57
            ? code - 48 + 52
            : code === 45
              ? 62
              : 63;
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      outputLength += 1;
      accumulator = bits === 0 ? 0 : accumulator & ((1 << bits) - 1);
    }
  }
  if (bits > 0 && accumulator !== 0)
    fail("RELAY_INVALID_PAYLOAD", path, "Opaque relay payload has non-canonical trailing bits.");
  if (outputLength > MAX_RELAY_OPAQUE_PAYLOAD_BYTES) {
    fail("RELAY_LIMIT_EXCEEDED", path, "Opaque relay payload exceeds its byte ceiling.");
  }
  return value;
}

export function normalizeRelayRepositoryIdentity(input: unknown): RelayRepositoryIdentity {
  const value = record(input, "$.repository", "RELAY_INVALID_REPOSITORY");
  assertClosedObject(value, ["repositoryHost", "repositoryId", "repositoryNameWithOwner"], "$.repository", [
    "repositoryHost",
    "repositoryId",
  ]);
  const repositoryId = normalizeRepositoryId(value.repositoryId, "$.repository.repositoryId");
  const repositoryHost = normalizeText(
    value.repositoryHost,
    "$.repository.repositoryHost",
    MAX_RELAY_TEXT_BYTES,
  ).toLowerCase();
  if (!HOST_PATTERN.test(repositoryHost) || repositoryHost.includes("..")) {
    fail("RELAY_INVALID_REPOSITORY", "$.repository.repositoryHost", "Repository host is invalid.");
  }
  const repositoryNameWithOwner =
    value.repositoryNameWithOwner === undefined
      ? undefined
      : normalizeText(value.repositoryNameWithOwner, "$.repository.repositoryNameWithOwner");
  if (repositoryNameWithOwner !== undefined && !REPOSITORY_NAME_PATTERN.test(repositoryNameWithOwner)) {
    fail("RELAY_INVALID_REPOSITORY", "$.repository.repositoryNameWithOwner", "Repository name metadata is invalid.");
  }
  return Object.freeze({
    repositoryId,
    repositoryHost,
    ...(repositoryNameWithOwner === undefined ? {} : { repositoryNameWithOwner }),
  });
}

export const normalizeRepositoryIdentity = normalizeRelayRepositoryIdentity;

export function relayRepositoriesMatch(
  left: RelayRepositoryIdentity | unknown,
  right: RelayRepositoryIdentity | unknown,
): boolean {
  try {
    return normalizeRelayRepositoryIdentity(left).repositoryId === normalizeRelayRepositoryIdentity(right).repositoryId;
  } catch {
    return false;
  }
}

function assertExpectedRepository(
  repository: RelayRepositoryIdentity,
  expected: RelayExpectedRepository | undefined,
): void {
  if (expected === undefined) return;
  const expectedId =
    typeof expected === "string"
      ? normalizeRepositoryId(expected, "$.expectedRepositoryId")
      : normalizeRelayRepositoryIdentity(expected).repositoryId;
  if (repository.repositoryId !== expectedId) {
    fail("RELAY_CROSS_REPOSITORY", "$.repository.repositoryId", "Relay envelope belongs to another repository.");
  }
}

function normalizeEnvelopeBase(value: Record<string, unknown>, path: string): void {
  if (value.version !== RELAY_CONTRACT_VERSION) {
    fail("RELAY_UNSUPPORTED_VERSION", `${path}.version`, "Relay contract version is unsupported.");
  }
  if (typeof value.kind !== "string" || !RELAY_ENVELOPE_KINDS.includes(value.kind as RelayEnvelopeKind)) {
    fail("RELAY_INVALID_KIND", `${path}.kind`, "Relay envelope kind is not supported.");
  }
}

function normalizeConnection(value: Record<string, unknown>): RelayConnectionEnvelope {
  assertClosedObject(value, ["connectionId", "deadlineMs", "kind", "maxInFlightJobs", "repository", "version"], "$");
  normalizeEnvelopeBase(value, "$");
  if (value.kind !== "connection")
    fail("RELAY_INVALID_KIND", "$.kind", "Relay envelope kind does not match its schema.");
  const repository = normalizeRelayRepositoryIdentity(value.repository);
  return Object.freeze({
    version: RELAY_CONTRACT_VERSION,
    kind: "connection",
    repository,
    connectionId: normalizeIdentifier(value.connectionId, "$.connectionId"),
    maxInFlightJobs: normalizeBoundedInteger(value.maxInFlightJobs, "$.maxInFlightJobs", MAX_RELAY_IN_FLIGHT_JOBS),
    deadlineMs: normalizeBoundedInteger(value.deadlineMs, "$.deadlineMs", MAX_RELAY_DEADLINE_MS),
  });
}

function normalizeJob(value: Record<string, unknown>): RelayJobEnvelope {
  assertClosedObject(
    value,
    ["connectionId", "deadlineMs", "deliveryState", "jobId", "kind", "repository", "signedSessionRequest", "version"],
    "$",
  );
  normalizeEnvelopeBase(value, "$");
  if (value.kind !== "job") fail("RELAY_INVALID_KIND", "$.kind", "Relay envelope kind does not match its schema.");
  if (value.deliveryState !== "pre-delivery") {
    fail("RELAY_INVALID_DELIVERY_STATE", "$.deliveryState", "A job envelope must be pre-delivery.");
  }
  return Object.freeze({
    version: RELAY_CONTRACT_VERSION,
    kind: "job",
    repository: normalizeRelayRepositoryIdentity(value.repository),
    connectionId: normalizeIdentifier(value.connectionId, "$.connectionId"),
    jobId: normalizeIdentifier(value.jobId, "$.jobId"),
    deliveryState: "pre-delivery",
    deadlineMs: normalizeBoundedInteger(value.deadlineMs, "$.deadlineMs", MAX_RELAY_DEADLINE_MS),
    signedSessionRequest: decodeBase64Url(value.signedSessionRequest, "$.signedSessionRequest", false),
  });
}

function normalizeResult(value: Record<string, unknown>): RelayResultEnvelope {
  assertClosedObject(
    value,
    ["connectionId", "deliveryState", "jobId", "kind", "repository", "resultPayload", "version"],
    "$",
  );
  normalizeEnvelopeBase(value, "$");
  if (value.kind !== "result") fail("RELAY_INVALID_KIND", "$.kind", "Relay envelope kind does not match its schema.");
  if (value.deliveryState !== "terminal-result") {
    fail("RELAY_INVALID_DELIVERY_STATE", "$.deliveryState", "A result envelope must be terminal-result.");
  }
  return Object.freeze({
    version: RELAY_CONTRACT_VERSION,
    kind: "result",
    repository: normalizeRelayRepositoryIdentity(value.repository),
    connectionId: normalizeIdentifier(value.connectionId, "$.connectionId"),
    jobId: normalizeIdentifier(value.jobId, "$.jobId"),
    deliveryState: "terminal-result",
    resultPayload: decodeBase64Url(value.resultPayload, "$.resultPayload", true),
  });
}

function normalizeControl(value: Record<string, unknown>): RelayControlEnvelope {
  assertClosedObject(value, ["connectionId", "deliveryState", "jobId", "kind", "repository", "version"], "$");
  normalizeEnvelopeBase(value, "$");
  if (value.kind !== "control") fail("RELAY_INVALID_KIND", "$.kind", "Relay envelope kind does not match its schema.");
  if (!CONTROL_DELIVERY_STATES.includes(value.deliveryState as RelayControlDeliveryState)) {
    fail("RELAY_INVALID_DELIVERY_STATE", "$.deliveryState", "Control delivery state is not supported.");
  }
  return Object.freeze({
    version: RELAY_CONTRACT_VERSION,
    kind: "control",
    repository: normalizeRelayRepositoryIdentity(value.repository),
    connectionId: normalizeIdentifier(value.connectionId, "$.connectionId"),
    jobId: normalizeIdentifier(value.jobId, "$.jobId"),
    deliveryState: value.deliveryState as RelayControlDeliveryState,
  });
}

export function normalizeRelayEnvelope(input: unknown, expectedRepository?: RelayExpectedRepository): RelayEnvelope {
  const value = record(input, "$", "RELAY_INVALID_ROOT");
  if (value.version !== RELAY_CONTRACT_VERSION) {
    fail("RELAY_UNSUPPORTED_VERSION", "$.version", "Relay contract version is unsupported.");
  }
  let envelope: RelayEnvelope;
  switch (value.kind) {
    case "connection":
      envelope = normalizeConnection(value);
      break;
    case "job":
      envelope = normalizeJob(value);
      break;
    case "result":
      envelope = normalizeResult(value);
      break;
    case "control":
      envelope = normalizeControl(value);
      break;
    default:
      fail("RELAY_INVALID_KIND", "$.kind", "Relay envelope kind is not supported.");
  }
  assertExpectedRepository(envelope.repository, expectedRepository);
  return envelope;
}

export function validateRelayEnvelope(
  input: unknown,
  expectedRepository?: RelayExpectedRepository,
): RelayValidationResult {
  try {
    return { valid: true, envelope: normalizeRelayEnvelope(input, expectedRepository), diagnostics: [] };
  } catch (error) {
    if (error instanceof RelayContractError) {
      return {
        valid: false,
        diagnostics: [{ code: error.code, path: error.path, message: error.message }],
      };
    }
    return {
      valid: false,
      diagnostics: [{ code: "RELAY_MALFORMED_WIRE", path: "$", message: "Relay envelope is invalid." }],
    };
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
  return output;
}

function wireBytes(text: string): Uint8Array {
  const bytes = JSON_ENCODER.encode(text);
  if (bytes.byteLength > MAX_RELAY_ENVELOPE_BYTES) {
    fail("RELAY_LIMIT_EXCEEDED", "$", "Relay envelope exceeds its byte ceiling.");
  }
  return bytes;
}

export function encodeRelayEnvelope(input: unknown, expectedRepository?: RelayExpectedRepository): Uint8Array {
  const normalized = normalizeRelayEnvelope(input, expectedRepository);
  return wireBytes(JSON.stringify(canonicalize(normalized)));
}

export function serializeRelayEnvelope(input: unknown, expectedRepository?: RelayExpectedRepository): string {
  return new TextDecoder().decode(encodeRelayEnvelope(input, expectedRepository));
}

function scanJsonStringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const character = text[index] as string;
    if (character === '"') return index + 1;
    if (character === "\\") {
      index += 2;
      if (text[index - 1] === "u") index += 4;
    } else {
      if (character.charCodeAt(0) < 0x20) throw new Error("invalid JSON string");
      index += 1;
    }
  }
  throw new Error("unterminated JSON string");
}

function assertNoDuplicateJsonKeys(text: string): void {
  let index = 0;
  const whitespace = (): void => {
    while (index < text.length && /\s/u.test(text[index] as string)) index += 1;
  };
  const string = (): string => {
    const start = index;
    index = scanJsonStringEnd(text, index);
    return JSON.parse(text.slice(start, index)) as string;
  };
  const value = (): void => {
    whitespace();
    const character = text[index];
    if (character === '"') {
      string();
      return;
    }
    if (character === "{") {
      object();
      return;
    }
    if (character === "[") {
      array();
      return;
    }
    while (index < text.length && !/[\s,\]}]/u.test(text[index] as string)) index += 1;
  };
  const object = (): void => {
    index += 1;
    whitespace();
    const keys = new Set<string>();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    while (index < text.length) {
      whitespace();
      if (text[index] !== '"') throw new Error("invalid JSON object key");
      const key = string();
      if (keys.has(key)) throw new RelayContractError("RELAY_DUPLICATE_FIELD", "$", `Duplicate field "${key}".`);
      keys.add(key);
      whitespace();
      if (text[index] !== ":") throw new Error("invalid JSON object separator");
      index += 1;
      value();
      whitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      if (text[index] !== ",") throw new Error("invalid JSON object delimiter");
      index += 1;
    }
    throw new Error("unterminated JSON object");
  };
  const array = (): void => {
    index += 1;
    whitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    while (index < text.length) {
      value();
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      if (text[index] !== ",") throw new Error("invalid JSON array delimiter");
      index += 1;
    }
    throw new Error("unterminated JSON array");
  };
  value();
  whitespace();
  if (index !== text.length) throw new Error("trailing JSON input");
}

export function decodeRelayEnvelope(
  input: Uint8Array | string,
  expectedRepository?: RelayExpectedRepository,
): RelayEnvelope {
  let text: string;
  if (typeof input === "string") {
    if (JSON_ENCODER.encode(input).byteLength > MAX_RELAY_ENVELOPE_BYTES) {
      fail("RELAY_LIMIT_EXCEEDED", "$", "Relay envelope exceeds its byte ceiling.");
    }
    text = input;
  } else if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_RELAY_ENVELOPE_BYTES) {
      fail("RELAY_LIMIT_EXCEEDED", "$", "Relay envelope exceeds its byte ceiling.");
    }
    try {
      text = JSON_DECODER.decode(input);
    } catch {
      fail("RELAY_MALFORMED_WIRE", "$", "Relay wire bytes are not valid UTF-8.");
    }
  } else {
    fail("RELAY_MALFORMED_WIRE", "$", "Relay wire input must be UTF-8 text or bytes.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
    assertNoDuplicateJsonKeys(text);
  } catch (error) {
    if (error instanceof RelayContractError) throw error;
    fail("RELAY_MALFORMED_JSON", "$", "Relay wire input is not valid JSON.");
  }
  return normalizeRelayEnvelope(parsed, expectedRepository);
}
