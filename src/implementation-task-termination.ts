/**
 * Provider-neutral evidence for terminating one currently authorized
 * Implementation task. This module validates evidence supplied by the
 * repository adapter; it does not read or write provider state or establish
 * Runtime operator authority.
 */

import { canonicalJsonString, type CanonicalJsonValue } from "./agent-authority/codec.js";
import {
  validateImplementationAuthorizationRecord,
  type ImplementationAuthorizationRecord,
  type ImplementationBaseEvidence,
} from "./implementation-authorization.js";
import { issueReferenceKey, normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";
import type { ImplementationRepositoryIdentity } from "./implementation-contract.js";

export const IMPLEMENTATION_TASK_TERMINATION_VERSION = 1 as const;
export type ImplementationTaskTerminationVersion = typeof IMPLEMENTATION_TASK_TERMINATION_VERSION;
export const IMPLEMENTATION_TASK_TERMINATION_KIND = "implementation-task-termination" as const;
export const MAX_IMPLEMENTATION_TASK_TERMINATION_RECORD_BYTES = 16_384 as const;
export const MAX_IMPLEMENTATION_TASK_TERMINATION_RECORDS = 16 as const;
export const MAX_IMPLEMENTATION_TASK_TERMINATION_PROVENANCE_KEYS = 4 as const;
export const MAX_IMPLEMENTATION_TASK_TERMINATION_PROVENANCE_LABEL_LENGTH = 128 as const;
export const MAX_IMPLEMENTATION_TASK_TERMINATION_PROVENANCE_BYTES = 1_024 as const;
export const MAX_IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_RECORD_BYTES = 65_536 as const;
export const MAX_IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_PROVENANCE_BYTES = 8_192 as const;

/** Public, bounded metadata identifying where observed evidence came from. */
export interface ImplementationTaskTerminationProvenance {
  readonly [key: string]: string;
}

/** A repository-owned terminal fact for exactly one Implementation authorization. */
export interface ImplementationTaskTerminationRecord {
  readonly version: ImplementationTaskTerminationVersion;
  readonly kind: typeof IMPLEMENTATION_TASK_TERMINATION_KIND;
  readonly repository: ImplementationRepositoryIdentity;
  readonly implementation: IssueReference;
  /** The current authorization record's canonical governed-body digest. */
  readonly authorizationDigest: string;
  readonly base: ImplementationBaseEvidence;
}

export type ImplementationTaskTerminationViolationCode =
  | "IMPLEMENTATION_TASK_TERMINATION_INPUT_INVALID"
  | "IMPLEMENTATION_TASK_TERMINATION_RECORD_UNKNOWN_PROPERTY"
  | "IMPLEMENTATION_TASK_TERMINATION_RECORD_INVALID"
  | "IMPLEMENTATION_TASK_TERMINATION_VERSION_UNSUPPORTED"
  | "IMPLEMENTATION_TASK_TERMINATION_KIND_UNSUPPORTED"
  | "IMPLEMENTATION_TASK_TERMINATION_AUTHORIZATION_INVALID"
  | "IMPLEMENTATION_TASK_TERMINATION_REPOSITORY_MISMATCH"
  | "IMPLEMENTATION_TASK_TERMINATION_IMPLEMENTATION_MISMATCH"
  | "IMPLEMENTATION_TASK_TERMINATION_AUTHORIZATION_MISMATCH"
  | "IMPLEMENTATION_TASK_TERMINATION_BASE_MISMATCH"
  | "IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_INVALID"
  | "IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_UNKNOWN_PROPERTY"
  | "IMPLEMENTATION_TASK_TERMINATION_RECORDS_AMBIGUOUS";

export interface ImplementationTaskTerminationViolation {
  readonly code: ImplementationTaskTerminationViolationCode;
  readonly path: string;
  readonly message: string;
}

export interface ImplementationTaskTerminationValidationResult {
  readonly valid: boolean;
  readonly record?: ImplementationTaskTerminationRecord;
  readonly violations: readonly ImplementationTaskTerminationViolation[];
}

export interface ImplementationTaskTerminationObservedRecord {
  readonly record: unknown;
  /** Secret-free source metadata supplied by the repository adapter. */
  readonly provenance: ImplementationTaskTerminationProvenance;
}

/** An authoritative read must say so explicitly; an empty list proves absence. */
export type ImplementationTaskTerminationRead =
  | {
      readonly status: "authoritative";
      readonly provenance: ImplementationTaskTerminationProvenance;
      readonly records: readonly ImplementationTaskTerminationObservedRecord[];
    }
  | {
      readonly status: "unavailable";
      readonly provenance: ImplementationTaskTerminationProvenance;
    };

export interface InvalidImplementationTaskTerminationProvenance {
  readonly valid: false;
}

type ProvenanceReceipt = ImplementationTaskTerminationProvenance | InvalidImplementationTaskTerminationProvenance;

interface ObservationProvenance {
  readonly provenance?: ImplementationTaskTerminationProvenance;
  readonly recordProvenance: readonly ProvenanceReceipt[];
}

export type ImplementationTaskTerminationObservationResult =
  | (ObservationProvenance & { readonly status: "absent" })
  | (ObservationProvenance & {
      readonly status: "present";
      readonly record: ImplementationTaskTerminationRecord;
    })
  | (ObservationProvenance & { readonly status: "unavailable" })
  | (ObservationProvenance & {
      readonly status: "invalid";
      readonly violations: readonly ImplementationTaskTerminationViolation[];
    });

type RecordValue = Record<string, unknown>;

const RECORD_KEYS = new Set(["version", "kind", "repository", "implementation", "authorizationDigest", "base"]);
const REPOSITORY_KEYS = new Set(["repositoryHost", "repositoryId", "repository"]);
const BASE_KEYS = new Set(["branch", "revision", "freshness"]);
const READ_KEYS = new Set(["status", "provenance", "records"]);
const OBSERVED_RECORD_KEYS = new Set(["record", "provenance"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const SAFE_PROVENANCE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const SAFE_PROVENANCE_LABEL = /^[\x20-\x7e]+$/u;
const SENSITIVE_PROVENANCE_LABEL =
  /(?:private\s*key|secret|token|credential|jwt|installation|password|bearer|api[-_ ]?key|access[-_ ]?key)/iu;
const CREDENTIAL_VALUE =
  /(?:\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u;

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => freeze(entry))) as T;
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) result[key] = freeze(value[key]);
    return Object.freeze(result) as T;
  }
  return value;
}

function addViolation(
  violations: ImplementationTaskTerminationViolation[],
  code: ImplementationTaskTerminationViolationCode,
  path: string,
  message: string,
): void {
  violations.push({ code, path, message });
}

function unknownProperties(
  value: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  violations: ImplementationTaskTerminationViolation[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      addViolation(
        violations,
        "IMPLEMENTATION_TASK_TERMINATION_RECORD_UNKNOWN_PROPERTY",
        path,
        "Task termination evidence contains an unsupported property.",
      );
      return;
    }
  }
}

function normalizeProvenance(
  input: unknown,
  path: string,
  violations: ImplementationTaskTerminationViolation[],
):
  | { readonly value: ImplementationTaskTerminationProvenance; readonly serialized: string; readonly bytes: number }
  | undefined {
  if (!isRecord(input)) {
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_INVALID",
      path,
      "Provenance must be a bounded secret-free object.",
    );
    return undefined;
  }
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.length > MAX_IMPLEMENTATION_TASK_TERMINATION_PROVENANCE_KEYS) {
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_INVALID",
      path,
      `Provenance must contain 1-${MAX_IMPLEMENTATION_TASK_TERMINATION_PROVENANCE_KEYS} properties.`,
    );
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const key of keys) {
    const value = input[key];
    if (
      !SAFE_PROVENANCE_KEY.test(key) ||
      SENSITIVE_PROVENANCE_LABEL.test(key) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_IMPLEMENTATION_TASK_TERMINATION_PROVENANCE_LABEL_LENGTH ||
      !SAFE_PROVENANCE_LABEL.test(value) ||
      SENSITIVE_PROVENANCE_LABEL.test(value) ||
      CREDENTIAL_VALUE.test(value)
    ) {
      addViolation(
        violations,
        "IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_INVALID",
        path,
        `Provenance labels must be printable, secret-free text of at most ${MAX_IMPLEMENTATION_TASK_TERMINATION_PROVENANCE_LABEL_LENGTH} characters.`,
      );
      return undefined;
    }
    normalized[key] = value;
  }

  const value = freeze(normalized);
  const serialized = canonicalJsonString(value as CanonicalJsonValue);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_IMPLEMENTATION_TASK_TERMINATION_PROVENANCE_BYTES) {
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_INVALID",
      path,
      `Serialized provenance exceeds ${MAX_IMPLEMENTATION_TASK_TERMINATION_PROVENANCE_BYTES} bytes.`,
    );
    return undefined;
  }
  return { value, serialized, bytes };
}

function normalizeRepository(
  input: unknown,
  path: string,
  violations: ImplementationTaskTerminationViolation[],
): ImplementationRepositoryIdentity | undefined {
  if (!isRecord(input)) {
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_RECORD_INVALID",
      path,
      "Repository identity must be an object.",
    );
    return undefined;
  }
  unknownProperties(input, REPOSITORY_KEYS, path, violations);
  const host = input.repositoryHost;
  const id = input.repositoryId;
  const locator = input.repository;
  if (
    typeof host !== "string" ||
    host.length === 0 ||
    /[\s/]/u.test(host) ||
    typeof id !== "string" ||
    !REPOSITORY_ID_PATTERN.test(id) ||
    (locator !== undefined && (typeof locator !== "string" || !REPOSITORY_PATTERN.test(locator)))
  ) {
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_RECORD_INVALID",
      path,
      "Repository identity must contain a valid host and immutable repository ID, with an optional owner/name locator.",
    );
    return undefined;
  }
  return {
    repositoryHost: host.toLocaleLowerCase("en-US"),
    repositoryId: id,
    ...(locator === undefined ? {} : { repository: (locator as string).toLocaleLowerCase("en-US") }),
  };
}

function normalizeBase(
  input: unknown,
  path: string,
  violations: ImplementationTaskTerminationViolation[],
): ImplementationBaseEvidence | undefined {
  if (!isRecord(input)) {
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_RECORD_INVALID",
      path,
      "Accepted base evidence must be an object.",
    );
    return undefined;
  }
  unknownProperties(input, BASE_KEYS, path, violations);
  const { branch, revision, freshness } = input;
  if (
    typeof branch !== "string" ||
    branch.length === 0 ||
    typeof revision !== "string" ||
    revision.length === 0 ||
    typeof freshness !== "string" ||
    freshness.length === 0
  ) {
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_RECORD_INVALID",
      path,
      "Accepted base evidence must contain branch, revision, and freshness strings.",
    );
    return undefined;
  }
  return { branch, revision, freshness };
}

function sameRepository(left: ImplementationRepositoryIdentity, right: ImplementationRepositoryIdentity): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

function sameBase(left: ImplementationBaseEvidence, right: ImplementationBaseEvidence): boolean {
  return left.branch === right.branch && left.revision === right.revision && left.freshness === right.freshness;
}

function recordStringBytes(input: RecordValue): number {
  let bytes = 0;
  const add = (value: unknown): void => {
    if (typeof value === "string") bytes += Buffer.byteLength(value, "utf8");
  };
  add(input.kind);
  add(input.authorizationDigest);
  for (const [property, keys] of [
    ["repository", REPOSITORY_KEYS],
    ["implementation", new Set(["repositoryHost", "repositoryId", "repository", "number"])],
    ["base", BASE_KEYS],
  ] as const) {
    const nested = input[property];
    if (isRecord(nested)) for (const key of keys) add(nested[key]);
  }
  return bytes;
}

/** Validate a strict termination record against the caller's current authorization record. */
export function validateImplementationTaskTerminationRecord(
  input: unknown,
  currentAuthorization: unknown,
): ImplementationTaskTerminationValidationResult {
  const violations: ImplementationTaskTerminationViolation[] = [];
  const authorizationResult = validateImplementationAuthorizationRecord(currentAuthorization);
  const authorization: ImplementationAuthorizationRecord | undefined = authorizationResult.record;
  if (!authorizationResult.valid || authorization === undefined)
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_AUTHORIZATION_INVALID",
      "$.authorization",
      "A valid current Implementation authorization record is required.",
    );

  if (!isRecord(input)) {
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_INPUT_INVALID",
      "$",
      "Task termination record must be an object.",
    );
    return { valid: false, violations: Object.freeze(violations) };
  }

  unknownProperties(input, RECORD_KEYS, "$", violations);
  if (recordStringBytes(input) > MAX_IMPLEMENTATION_TASK_TERMINATION_RECORD_BYTES) {
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_RECORD_INVALID",
      "$",
      `Task termination record text exceeds the ${MAX_IMPLEMENTATION_TASK_TERMINATION_RECORD_BYTES}-byte input bound.`,
    );
    return { valid: false, violations: Object.freeze(violations) };
  }
  if (input.version !== IMPLEMENTATION_TASK_TERMINATION_VERSION)
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_VERSION_UNSUPPORTED",
      "$.version",
      "Task termination record version is unsupported.",
    );
  if (input.kind !== IMPLEMENTATION_TASK_TERMINATION_KIND)
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_KIND_UNSUPPORTED",
      "$.kind",
      "Task termination record kind is unsupported.",
    );

  const repository = normalizeRepository(input.repository, "$.repository", violations);
  const implementationResult = normalizeIssueReference(input.implementation, "$.implementation");
  const implementation = implementationResult.reference;
  if (!implementationResult.valid || implementation === undefined)
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_RECORD_INVALID",
      "$.implementation",
      "Implementation reference is invalid.",
    );

  const authorizationDigest = input.authorizationDigest;
  if (typeof authorizationDigest !== "string" || !SHA256_PATTERN.test(authorizationDigest))
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_RECORD_INVALID",
      "$.authorizationDigest",
      "Authorization digest must be lowercase SHA-256 hex.",
    );
  const base = normalizeBase(input.base, "$.base", violations);

  if (
    violations.length > 0 ||
    authorization === undefined ||
    repository === undefined ||
    implementation === undefined ||
    base === undefined
  )
    return { valid: false, violations: Object.freeze(violations) };

  if (!sameRepository(repository, authorization.repository))
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_REPOSITORY_MISMATCH",
      "$.repository",
      "Termination record repository does not match the current authorization repository identity.",
    );
  if (issueReferenceKey(implementation) !== issueReferenceKey(authorization.implementation))
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_IMPLEMENTATION_MISMATCH",
      "$.implementation",
      "Termination record does not target the current Implementation Issue.",
    );
  if (
    implementation.repositoryHost !== repository.repositoryHost ||
    implementation.repositoryId !== repository.repositoryId
  )
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_REPOSITORY_MISMATCH",
      "$.implementation",
      "Implementation reference and repository identity do not match.",
    );
  if (authorizationDigest !== authorization.governedBodyDigest)
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_AUTHORIZATION_MISMATCH",
      "$.authorizationDigest",
      "Termination record does not match the current canonical authorization digest.",
    );
  if (!sameBase(base, authorization.base))
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_BASE_MISMATCH",
      "$.base",
      "Termination record does not match the current authorization's accepted base evidence.",
    );

  if (violations.length > 0) return { valid: false, violations: Object.freeze(violations) };
  const normalizedRecord: ImplementationTaskTerminationRecord = {
    version: IMPLEMENTATION_TASK_TERMINATION_VERSION,
    kind: IMPLEMENTATION_TASK_TERMINATION_KIND,
    repository,
    implementation,
    authorizationDigest: authorizationDigest as string,
    base,
  };
  const serializedRecord = canonicalJsonString(normalizedRecord as unknown as CanonicalJsonValue);
  if (Buffer.byteLength(serializedRecord, "utf8") > MAX_IMPLEMENTATION_TASK_TERMINATION_RECORD_BYTES) {
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_RECORD_INVALID",
      "$",
      `Serialized task termination record exceeds ${MAX_IMPLEMENTATION_TASK_TERMINATION_RECORD_BYTES} bytes.`,
    );
    return { valid: false, violations: Object.freeze(violations) };
  }
  const record = freeze(normalizedRecord);
  return { valid: true, record, violations: Object.freeze([]) };
}

/**
 * Interpret one provider-neutral current read. Only an explicitly
 * authoritative empty read proves absence. Repeated identical records are
 * one event; distinct valid records are ambiguous and fail closed.
 */
export function observeImplementationTaskTermination(
  input: unknown,
  currentAuthorization: unknown,
): ImplementationTaskTerminationObservationResult {
  const violations: ImplementationTaskTerminationViolation[] = [];
  const emptyRecordProvenance: readonly ProvenanceReceipt[] = Object.freeze([]);
  if (!isRecord(input)) {
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_INVALID",
      "$",
      "Task termination observation must be an object.",
    );
    return { status: "invalid", recordProvenance: emptyRecordProvenance, violations: Object.freeze(violations) };
  }

  const provenance = normalizeProvenance(
    hasOwn(input, "provenance") ? input.provenance : undefined,
    "$.provenance",
    violations,
  );

  const authorizationResult = validateImplementationAuthorizationRecord(currentAuthorization);
  if (!authorizationResult.valid || authorizationResult.record === undefined)
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_AUTHORIZATION_INVALID",
      "$.authorization",
      "A valid current Implementation authorization record is required.",
    );

  const status = input.status;
  if (status !== "authoritative" && status !== "unavailable")
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_INVALID",
      "$.status",
      'Observation status must be "authoritative" or "unavailable".',
    );
  const allowed = status === "unavailable" ? new Set(["status", "provenance"]) : READ_KEYS;
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      addViolation(
        violations,
        "IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_UNKNOWN_PROPERTY",
        "$",
        "Task termination observation contains an unsupported property.",
      );
      break;
    }
  }
  if (status === "authoritative" && !Array.isArray(input.records))
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_INVALID",
      "$.records",
      "An authoritative observation must contain a record array, including when it is empty.",
    );

  const rawRecords = status === "authoritative" && Array.isArray(input.records) ? input.records : [];
  const recordProvenance: ProvenanceReceipt[] = [];
  if (rawRecords.length > MAX_IMPLEMENTATION_TASK_TERMINATION_RECORDS) {
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_INVALID",
      "$.records",
      `Authoritative observation exceeds the ${MAX_IMPLEMENTATION_TASK_TERMINATION_RECORDS}-record limit.`,
    );
    recordProvenance.push({ valid: false });
  }
  let totalProvenanceBytes = provenance?.bytes ?? 0;
  const candidates: {
    readonly record: ImplementationTaskTerminationRecord;
    readonly serialized: string;
  }[] = [];
  let totalRecordBytes = 0;
  for (const [index, candidate] of rawRecords.slice(0, MAX_IMPLEMENTATION_TASK_TERMINATION_RECORDS).entries()) {
    const path = `$.records[${index}]`;
    if (!isRecord(candidate)) {
      addViolation(
        violations,
        "IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_INVALID",
        path,
        "Observed record evidence must be an object containing record and provenance.",
      );
      recordProvenance.push({ valid: false });
      continue;
    }
    for (const key of Object.keys(candidate)) {
      if (!OBSERVED_RECORD_KEYS.has(key)) {
        addViolation(
          violations,
          "IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_UNKNOWN_PROPERTY",
          path,
          "Observed task termination evidence contains an unsupported property.",
        );
        break;
      }
    }
    const candidateProvenance = normalizeProvenance(candidate.provenance, `${path}.provenance`, violations);
    if (
      candidateProvenance === undefined ||
      totalProvenanceBytes + (candidateProvenance?.bytes ?? 0) >
        MAX_IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_PROVENANCE_BYTES
    ) {
      if (candidateProvenance !== undefined)
        addViolation(
          violations,
          "IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_INVALID",
          `${path}.provenance`,
          `Observation provenance exceeds ${MAX_IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_PROVENANCE_BYTES} total serialized bytes.`,
        );
      recordProvenance.push({ valid: false });
      continue;
    }
    totalProvenanceBytes += candidateProvenance.bytes;
    recordProvenance.push(candidateProvenance.value);
    const validation = validateImplementationTaskTerminationRecord(candidate.record, currentAuthorization);
    for (const violation of validation.violations)
      violations.push({ ...violation, path: `${path}${violation.path === "$" ? "" : violation.path.slice(1)}` });
    if (validation.valid && validation.record !== undefined) {
      const serialized = canonicalJsonString(validation.record as unknown as CanonicalJsonValue);
      const recordBytes = Buffer.byteLength(serialized, "utf8");
      if (totalRecordBytes + recordBytes > MAX_IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_RECORD_BYTES) {
        addViolation(
          violations,
          "IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_INVALID",
          "$.records",
          `Observed task termination records exceed ${MAX_IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_RECORD_BYTES} total serialized bytes.`,
        );
        continue;
      }
      totalRecordBytes += recordBytes;
      candidates.push({ record: validation.record, serialized });
    }
  }

  recordProvenance.sort((left, right) => {
    const leftSerialized = canonicalJsonString(left as CanonicalJsonValue);
    const rightSerialized = canonicalJsonString(right as CanonicalJsonValue);
    return leftSerialized < rightSerialized ? -1 : leftSerialized > rightSerialized ? 1 : 0;
  });
  const frozenRecordProvenance = Object.freeze(recordProvenance.map((entry) => freeze(entry)));
  const resultProvenance: ObservationProvenance = {
    ...(provenance === undefined ? {} : { provenance: provenance.value }),
    recordProvenance: frozenRecordProvenance,
  };

  if (violations.length > 0)
    return {
      status: "invalid",
      ...resultProvenance,
      violations: Object.freeze(violations.map((violation) => Object.freeze(violation))),
    };
  if (status === "unavailable") return { status: "unavailable", ...resultProvenance };
  if (candidates.length === 0) return { status: "absent", ...resultProvenance };

  const distinct = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) distinct.set(candidate.serialized, candidate);
  if (distinct.size > 1) {
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_RECORDS_AMBIGUOUS",
      "$.records",
      "Multiple distinct termination records match the current authorization.",
    );
    return {
      status: "invalid",
      ...resultProvenance,
      violations: Object.freeze(violations.map((violation) => Object.freeze(violation))),
    };
  }

  const record = [...distinct.values()][0]?.record;
  if (record === undefined) {
    addViolation(
      violations,
      "IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_INVALID",
      "$.records",
      "Authoritative observation did not produce a valid record result.",
    );
    return {
      status: "invalid",
      ...resultProvenance,
      violations: Object.freeze(violations.map((violation) => Object.freeze(violation))),
    };
  }

  return { status: "present", ...resultProvenance, record };
}
