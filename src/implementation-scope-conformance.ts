/**
 * Product-neutral conformance corpus for implementation-execution-scope v1.
 *
 * The JSON corpus is the consumer-facing contract.  This module only provides
 * the bounded fixture envelope and the deterministic Inari producer oracle
 * used to create and verify its expected results.  It deliberately does not
 * read Issues, call providers, or add an execution adapter.
 */

import {
  validateImplementationScopeApplicability,
  type ImplementationScopeApplicabilityStatus,
} from "./implementation-scope-applicability.js";
import {
  implementationScopeProjectionPaths,
  isImplementationScopeProjectionPathAllowed,
  isImplementationScopeProjectionPathDenied,
  matchesImplementationScopeSelector,
  validateImplementationScopeProjection,
  type ImplementationScopeProjectionOperation,
} from "./implementation-scope-projection.js";

export const IMPLEMENTATION_SCOPE_CONFORMANCE_VERSION = 1 as const;
export type ImplementationScopeConformanceVersion = typeof IMPLEMENTATION_SCOPE_CONFORMANCE_VERSION;

export const IMPLEMENTATION_SCOPE_CONFORMANCE_KIND = "implementation-execution-scope-conformance" as const;
export const IMPLEMENTATION_SCOPE_CONFORMANCE_RESULT_KIND =
  "implementation-execution-scope-conformance-result" as const;

export const IMPLEMENTATION_SCOPE_CONFORMANCE_OPERATIONS = Object.freeze([
  "READONLY",
  "WRITE",
  "CREATE",
  "DELETE",
  "DENY",
] as const);
export type ImplementationScopeConformanceOperation = (typeof IMPLEMENTATION_SCOPE_CONFORMANCE_OPERATIONS)[number];

/** One exact path/operation query a consumer must answer. */
export interface ImplementationScopeConformanceProbe {
  readonly operation: ImplementationScopeConformanceOperation;
  /** Unknown is intentional: malformed provider paths are negative fixtures. */
  readonly path: unknown;
}

/** The semantic answer for one probe; no provider or lifecycle data is included. */
export interface ImplementationScopeConformanceDecision {
  readonly operation: ImplementationScopeConformanceOperation;
  readonly path: unknown;
  /** Whether the operation's own selector list matched the exact path. */
  readonly matched: boolean;
  /** Whether the DENY selector list matched the exact path. */
  readonly denied: boolean;
  /** Whether the artifact may authorize this operation for the exact path. */
  readonly allowed: boolean;
}

export interface ImplementationScopeConformanceApplicability {
  readonly valid: boolean;
  readonly applicable: boolean;
  readonly status: ImplementationScopeApplicabilityStatus;
}

/** Bounded semantic result that external consumers reproduce from the corpus. */
export interface ImplementationScopeConformanceResult {
  readonly version: ImplementationScopeConformanceVersion;
  readonly kind: typeof IMPLEMENTATION_SCOPE_CONFORMANCE_RESULT_KIND;
  readonly name: string;
  readonly applicability: ImplementationScopeConformanceApplicability;
  readonly decisions: readonly ImplementationScopeConformanceDecision[];
}

export interface ImplementationScopeConformanceFixture {
  readonly version: ImplementationScopeConformanceVersion;
  readonly name: string;
  readonly artifact: unknown;
  readonly current: unknown;
  readonly probes: readonly ImplementationScopeConformanceProbe[];
  readonly expected: ImplementationScopeConformanceResult;
}

export interface ImplementationScopeConformanceCorpus {
  readonly version: ImplementationScopeConformanceVersion;
  readonly kind: typeof IMPLEMENTATION_SCOPE_CONFORMANCE_KIND;
  readonly fixtures: readonly ImplementationScopeConformanceFixture[];
}

export interface ImplementationScopeConformanceDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ImplementationScopeConformanceValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly ImplementationScopeConformanceDiagnostic[];
}

export interface ImplementationScopeConformanceComparisonResult {
  readonly valid: boolean;
  readonly mismatches: readonly ImplementationScopeConformanceDiagnostic[];
}

const CORPUS_KEYS = new Set(["version", "kind", "fixtures"]);
const FIXTURE_KEYS = new Set(["version", "name", "artifact", "current", "probes", "expected"]);
const PROBE_KEYS = new Set(["operation", "path"]);
const RESULT_KEYS = new Set(["version", "kind", "name", "applicability", "decisions"]);
const APPLICABILITY_KEYS = new Set(["valid", "applicable", "status"]);
const DECISION_KEYS = new Set(["operation", "path", "matched", "denied", "allowed"]);
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,95}$/u;
const MAX_FIXTURES = 64;
const MAX_PROBES = 128;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function diagnostic(
  diagnostics: ImplementationScopeConformanceDiagnostic[],
  code: string,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function unknownProperties(
  value: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: ImplementationScopeConformanceDiagnostic[],
): void {
  for (const key of Object.keys(value).sort(compareStrings)) {
    if (!allowed.has(key))
      diagnostic(diagnostics, "CONFORMANCE_UNKNOWN_PROPERTY", `${path}.${key}`, "Property is not supported.");
  }
}

function cloneStable<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneStable(entry)) as T;
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareStrings)) result[key] = cloneStable(value[key]);
    return result as T;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(cloneStable(value));
}

function isOperation(value: unknown): value is ImplementationScopeConformanceOperation {
  return (
    typeof value === "string" && IMPLEMENTATION_SCOPE_CONFORMANCE_OPERATIONS.some((operation) => operation === value)
  );
}

function isApplicabilityStatus(value: unknown): value is ImplementationScopeApplicabilityStatus {
  return value === "current" || value === "stale" || value === "mismatch" || value === "unsupported";
}

function inspectApplicability(
  value: unknown,
  path: string,
  diagnostics: ImplementationScopeConformanceDiagnostic[],
): void {
  if (!isRecord(value)) {
    diagnostic(diagnostics, "CONFORMANCE_INVALID_RESULT", path, "Applicability result must be an object.");
    return;
  }
  unknownProperties(value, APPLICABILITY_KEYS, path, diagnostics);
  if (typeof value.valid !== "boolean")
    diagnostic(diagnostics, "CONFORMANCE_INVALID_RESULT", `${path}.valid`, "valid must be boolean.");
  if (typeof value.applicable !== "boolean")
    diagnostic(diagnostics, "CONFORMANCE_INVALID_RESULT", `${path}.applicable`, "applicable must be boolean.");
  if (!isApplicabilityStatus(value.status))
    diagnostic(diagnostics, "CONFORMANCE_INVALID_RESULT", `${path}.status`, "status is unsupported.");
  if (value.status === "current" && (value.valid !== true || value.applicable !== true))
    diagnostic(diagnostics, "CONFORMANCE_INVALID_RESULT", path, "current applicability must be valid and applicable.");
  if (value.status !== "current" && (value.valid !== false || value.applicable !== false))
    diagnostic(diagnostics, "CONFORMANCE_INVALID_RESULT", path, "non-current applicability must fail closed.");
}

function inspectDecision(value: unknown, path: string, diagnostics: ImplementationScopeConformanceDiagnostic[]): void {
  if (!isRecord(value)) {
    diagnostic(diagnostics, "CONFORMANCE_INVALID_RESULT", path, "Decision must be an object.");
    return;
  }
  unknownProperties(value, DECISION_KEYS, path, diagnostics);
  if (!isOperation(value.operation))
    diagnostic(diagnostics, "CONFORMANCE_INVALID_RESULT", `${path}.operation`, "operation is unsupported.");
  if (typeof value.matched !== "boolean")
    diagnostic(diagnostics, "CONFORMANCE_INVALID_RESULT", `${path}.matched`, "matched must be boolean.");
  if (typeof value.denied !== "boolean")
    diagnostic(diagnostics, "CONFORMANCE_INVALID_RESULT", `${path}.denied`, "denied must be boolean.");
  if (typeof value.allowed !== "boolean")
    diagnostic(diagnostics, "CONFORMANCE_INVALID_RESULT", `${path}.allowed`, "allowed must be boolean.");
  if (value.operation === "DENY" && value.allowed !== false)
    diagnostic(diagnostics, "CONFORMANCE_INVALID_RESULT", `${path}.allowed`, "DENY is not an allow operation.");
  if (value.allowed === true && (value.denied === true || value.operation === "DENY"))
    diagnostic(diagnostics, "CONFORMANCE_INVALID_RESULT", path, "DENY must never be widened into authority.");
}

function inspectResult(value: unknown, path: string, diagnostics: ImplementationScopeConformanceDiagnostic[]): void {
  if (!isRecord(value)) {
    diagnostic(diagnostics, "CONFORMANCE_INVALID_RESULT", path, "Expected result must be an object.");
    return;
  }
  unknownProperties(value, RESULT_KEYS, path, diagnostics);
  if (value.version !== IMPLEMENTATION_SCOPE_CONFORMANCE_VERSION)
    diagnostic(diagnostics, "CONFORMANCE_UNSUPPORTED_VERSION", `${path}.version`, "Result version is unsupported.");
  if (value.kind !== IMPLEMENTATION_SCOPE_CONFORMANCE_RESULT_KIND)
    diagnostic(diagnostics, "CONFORMANCE_INVALID_KIND", `${path}.kind`, "Result kind is invalid.");
  if (typeof value.name !== "string" || !SAFE_NAME.test(value.name))
    diagnostic(diagnostics, "CONFORMANCE_INVALID_NAME", `${path}.name`, "Result name is invalid.");
  inspectApplicability(value.applicability, `${path}.applicability`, diagnostics);
  if (!Array.isArray(value.decisions)) {
    diagnostic(diagnostics, "CONFORMANCE_INVALID_RESULT", `${path}.decisions`, "decisions must be an array.");
    return;
  }
  if (value.decisions.length > MAX_PROBES)
    diagnostic(diagnostics, "CONFORMANCE_LIMIT", `${path}.decisions`, "Too many decisions.");
  value.decisions.forEach((decision, index) => inspectDecision(decision, `${path}.decisions[${index}]`, diagnostics));
}

function inspectFixture(
  value: unknown,
  path: string,
  diagnostics: ImplementationScopeConformanceDiagnostic[],
): value is ImplementationScopeConformanceFixture {
  if (!isRecord(value)) {
    diagnostic(diagnostics, "CONFORMANCE_INVALID_FIXTURE", path, "Fixture must be an object.");
    return false;
  }
  unknownProperties(value, FIXTURE_KEYS, path, diagnostics);
  if (value.version !== IMPLEMENTATION_SCOPE_CONFORMANCE_VERSION)
    diagnostic(diagnostics, "CONFORMANCE_UNSUPPORTED_VERSION", `${path}.version`, "Fixture version is unsupported.");
  if (typeof value.name !== "string" || !SAFE_NAME.test(value.name))
    diagnostic(diagnostics, "CONFORMANCE_INVALID_NAME", `${path}.name`, "Fixture name is invalid.");
  if (!hasOwn(value, "artifact"))
    diagnostic(diagnostics, "CONFORMANCE_INVALID_FIXTURE", `${path}.artifact`, "Artifact is required.");
  if (!hasOwn(value, "current"))
    diagnostic(diagnostics, "CONFORMANCE_INVALID_FIXTURE", `${path}.current`, "Current evidence is required.");
  if (!Array.isArray(value.probes)) {
    diagnostic(diagnostics, "CONFORMANCE_INVALID_FIXTURE", `${path}.probes`, "probes must be an array.");
  } else {
    if (value.probes.length === 0 || value.probes.length > MAX_PROBES)
      diagnostic(diagnostics, "CONFORMANCE_LIMIT", `${path}.probes`, "Fixture probe count is out of bounds.");
    value.probes.forEach((probe, index) => {
      if (!isRecord(probe)) {
        diagnostic(diagnostics, "CONFORMANCE_INVALID_PROBE", `${path}.probes[${index}]`, "Probe must be an object.");
        return;
      }
      unknownProperties(probe, PROBE_KEYS, `${path}.probes[${index}]`, diagnostics);
      if (!isOperation(probe.operation))
        diagnostic(
          diagnostics,
          "CONFORMANCE_INVALID_PROBE",
          `${path}.probes[${index}].operation`,
          "operation is unsupported.",
        );
    });
  }
  inspectResult(value.expected, `${path}.expected`, diagnostics);
  return true;
}

/**
 * Produce one semantic result from a fixture using Inari's v1 parser,
 * matcher, DENY precedence, and applicability implementation.
 */
export function produceImplementationScopeConformance(
  fixture: ImplementationScopeConformanceFixture,
): ImplementationScopeConformanceResult {
  const applicability = validateImplementationScopeApplicability({
    artifact: fixture.artifact,
    current: fixture.current,
  });
  const parsed = validateImplementationScopeProjection(fixture.artifact);
  const projection = parsed.projection;
  const decisions = fixture.probes.map((probe) => {
    const operation = probe.operation;
    const path = probe.path;
    const exactPath = typeof path === "string" ? path : undefined;
    const denied =
      projection !== undefined && exactPath !== undefined
        ? isImplementationScopeProjectionPathDenied(projection, exactPath)
        : false;
    const matched =
      projection === undefined || exactPath === undefined
        ? false
        : operation === "DENY"
          ? denied
          : implementationScopeProjectionPaths(projection, operation as ImplementationScopeProjectionOperation).some(
              (selector) => matchesImplementationScopeSelector(selector, exactPath),
            );
    const allowed =
      applicability.applicable && operation !== "DENY" && exactPath !== undefined && projection !== undefined
        ? isImplementationScopeProjectionPathAllowed(projection, operation, exactPath)
        : false;
    return { operation, path, matched, denied, allowed };
  });
  return {
    version: IMPLEMENTATION_SCOPE_CONFORMANCE_VERSION,
    kind: IMPLEMENTATION_SCOPE_CONFORMANCE_RESULT_KIND,
    name: fixture.name,
    applicability: {
      valid: applicability.valid,
      applicable: applicability.applicable,
      status: applicability.status,
    },
    decisions,
  };
}

/** Compatibility spelling for consumers that call the oracle an evaluator. */
export const evaluateImplementationScopeConformance = produceImplementationScopeConformance;

/** Compare a consumer result with the producer oracle without requiring object key order. */
export function compareImplementationScopeConformance(
  fixture: ImplementationScopeConformanceFixture,
  actual: unknown,
): ImplementationScopeConformanceComparisonResult {
  const diagnostics: ImplementationScopeConformanceDiagnostic[] = [];
  inspectResult(actual, "$.actual", diagnostics);
  if (diagnostics.length > 0) return { valid: false, mismatches: Object.freeze(diagnostics) };
  const expected = produceImplementationScopeConformance(fixture);
  if (stableJson(actual) !== stableJson(expected))
    diagnostic(
      diagnostics,
      "CONFORMANCE_SEMANTIC_MISMATCH",
      "$.actual",
      "Consumer result does not match the producer oracle.",
    );
  return { valid: diagnostics.length === 0, mismatches: Object.freeze(diagnostics) };
}

/** Validate both the closed corpus envelope and every expected semantic result. */
export function validateImplementationScopeConformanceCorpus(
  input: unknown,
): ImplementationScopeConformanceValidationResult {
  const diagnostics: ImplementationScopeConformanceDiagnostic[] = [];
  if (!isRecord(input)) {
    diagnostic(diagnostics, "CONFORMANCE_INVALID_ROOT", "$", "Conformance corpus must be an object.");
    return { valid: false, diagnostics: Object.freeze(diagnostics) };
  }
  unknownProperties(input, CORPUS_KEYS, "$", diagnostics);
  if (input.version !== IMPLEMENTATION_SCOPE_CONFORMANCE_VERSION)
    diagnostic(diagnostics, "CONFORMANCE_UNSUPPORTED_VERSION", "$.version", "Corpus version is unsupported.");
  if (input.kind !== IMPLEMENTATION_SCOPE_CONFORMANCE_KIND)
    diagnostic(diagnostics, "CONFORMANCE_INVALID_KIND", "$.kind", "Corpus kind is invalid.");
  if (!Array.isArray(input.fixtures)) {
    diagnostic(diagnostics, "CONFORMANCE_INVALID_CORPUS", "$.fixtures", "fixtures must be an array.");
    return { valid: false, diagnostics: Object.freeze(diagnostics) };
  }
  if (input.fixtures.length === 0 || input.fixtures.length > MAX_FIXTURES)
    diagnostic(diagnostics, "CONFORMANCE_LIMIT", "$.fixtures", "Corpus fixture count is out of bounds.");
  const names = new Set<string>();
  input.fixtures.forEach((fixture, index) => {
    const path = `$.fixtures[${index}]`;
    if (!inspectFixture(fixture, path, diagnostics)) return;
    if (names.has(fixture.name))
      diagnostic(diagnostics, "CONFORMANCE_DUPLICATE_NAME", `${path}.name`, "Fixture names must be unique.");
    names.add(fixture.name);
    const produced = produceImplementationScopeConformance(fixture);
    if (stableJson(fixture.expected) !== stableJson(produced))
      diagnostic(
        diagnostics,
        "CONFORMANCE_EXPECTATION_MISMATCH",
        `${path}.expected`,
        "Expected result differs from the producer oracle.",
      );
  });
  return { valid: diagnostics.length === 0, diagnostics: Object.freeze(diagnostics) };
}

/** Return a boolean suitable for a consumer's corpus gate. */
export function isImplementationScopeConformanceCorpus(input: unknown): input is ImplementationScopeConformanceCorpus {
  return validateImplementationScopeConformanceCorpus(input).valid;
}
