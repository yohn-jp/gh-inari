/**
 * Bounded applicability validation for one implementation-execution-scope
 * artifact.
 *
 * This boundary deliberately consumes only a parsed projection and bounded
 * current repository/base/authorization evidence. It does not parse an Issue
 * body, read a provider payload, refresh authorization, or use elapsed time
 * as authority.
 */

import {
  IMPLEMENTATION_SCOPE_PROJECTION_VERSION,
  validateImplementationScopeProjection,
  type ImplementationScopeAuthorizationIdentity,
  type ImplementationScopeProjection,
  type ImplementationScopeProjectionViolationCode,
} from "./implementation-scope-projection.js";
import type { ImplementationBaseEvidence } from "./implementation-authorization.js";
import type { ImplementationRepositoryIdentity } from "./implementation-contract.js";
import { issueReferenceKey } from "./contract/issue-reference.js";

export const IMPLEMENTATION_SCOPE_APPLICABILITY_STATUSES = Object.freeze([
  "current",
  "stale",
  "mismatch",
  "unsupported",
] as const);
export type ImplementationScopeApplicabilityStatus = (typeof IMPLEMENTATION_SCOPE_APPLICABILITY_STATUSES)[number];

/** Current evidence admitted by the applicability boundary. */
export interface ImplementationScopeApplicabilityEvidence {
  readonly repository: ImplementationRepositoryIdentity;
  readonly base: ImplementationBaseEvidence;
  /** The current authorization identity, not an Issue or provider payload. */
  readonly authorization: ImplementationScopeAuthorizationIdentity;
}

/** The artifact and bounded evidence required for one applicability decision. */
export interface ImplementationScopeApplicabilityInput {
  readonly artifact: unknown;
  readonly current: ImplementationScopeApplicabilityEvidence;
}

export type ImplementationScopeApplicabilityViolationCode =
  | ImplementationScopeProjectionViolationCode
  | "IMPLEMENTATION_SCOPE_APPLICABILITY_INPUT_INVALID"
  | "IMPLEMENTATION_SCOPE_APPLICABILITY_CURRENT_EVIDENCE_INVALID"
  | "IMPLEMENTATION_SCOPE_APPLICABILITY_ARTIFACT_VERSION_UNSUPPORTED"
  | "IMPLEMENTATION_SCOPE_APPLICABILITY_REPOSITORY_MISMATCH"
  | "IMPLEMENTATION_SCOPE_APPLICABILITY_BASE_BRANCH_MISMATCH"
  | "IMPLEMENTATION_SCOPE_APPLICABILITY_BASE_REVISION_STALE"
  | "IMPLEMENTATION_SCOPE_APPLICABILITY_BASE_FRESHNESS_STALE"
  | "IMPLEMENTATION_SCOPE_APPLICABILITY_AUTHORIZATION_MISMATCH";

export interface ImplementationScopeApplicabilityViolation {
  readonly code: ImplementationScopeApplicabilityViolationCode;
  readonly path: string;
  readonly message: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface ImplementationScopeApplicabilityResult {
  /** True only when every bounded identity and binding is current. */
  readonly valid: boolean;
  readonly applicable: boolean;
  readonly status: ImplementationScopeApplicabilityStatus;
  /** Present only when the artifact has a valid projection shape. */
  readonly artifact?: ImplementationScopeProjection;
  readonly violations: readonly ImplementationScopeApplicabilityViolation[];
}

const INPUT_KEYS = new Set(["artifact", "current"]);
const CURRENT_KEYS = new Set(["repository", "base", "authorization"]);

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addViolation(
  violations: ImplementationScopeApplicabilityViolation[],
  code: ImplementationScopeApplicabilityViolationCode,
  path: string,
  message: string,
  expected?: unknown,
  actual?: unknown,
): void {
  violations.push({
    code,
    path,
    message,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  });
}

function prefixProjectionViolations(
  violations: readonly {
    readonly code: ImplementationScopeProjectionViolationCode;
    readonly path: string;
    readonly message: string;
    readonly expected?: unknown;
    readonly actual?: unknown;
  }[],
  prefix: string,
): ImplementationScopeApplicabilityViolation[] {
  return violations.map((violation) => ({
    code: violation.code,
    path: `${prefix}${violation.path === "$" ? "" : violation.path.slice(1)}`,
    message: violation.message,
    ...(violation.expected === undefined ? {} : { expected: violation.expected }),
    ...(violation.actual === undefined ? {} : { actual: violation.actual }),
  }));
}

function sameRepository(left: ImplementationRepositoryIdentity, right: ImplementationRepositoryIdentity): boolean {
  // repositoryHost + repositoryId are the identity tuple. The owner/name
  // locator is display/transport data and is intentionally not authoritative.
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

function sameAuthorization(
  left: ImplementationScopeAuthorizationIdentity,
  right: ImplementationScopeAuthorizationIdentity,
): boolean {
  return (
    left.version === right.version &&
    left.kind === right.kind &&
    left.contractVersion === right.contractVersion &&
    issueReferenceKey(left.implementation) === issueReferenceKey(right.implementation) &&
    left.governedBodyDigest === right.governedBodyDigest
  );
}

function unsupported(
  violations: readonly ImplementationScopeApplicabilityViolation[],
  artifact?: ImplementationScopeProjection,
): ImplementationScopeApplicabilityResult {
  return {
    valid: false,
    applicable: false,
    status: "unsupported",
    ...(artifact === undefined ? {} : { artifact }),
    violations: Object.freeze([...violations]),
  };
}

function normalizeInput(input: unknown): {
  readonly artifact?: ImplementationScopeProjection;
  readonly current?: ImplementationScopeApplicabilityEvidence;
  readonly violations: readonly ImplementationScopeApplicabilityViolation[];
} {
  const violations: ImplementationScopeApplicabilityViolation[] = [];
  if (!isRecord(input)) {
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_APPLICABILITY_INPUT_INVALID",
      "$",
      "Applicability input must be an object.",
    );
    return { violations };
  }
  for (const key of Object.keys(input).sort(compareStrings)) {
    if (!INPUT_KEYS.has(key))
      addViolation(
        violations,
        "IMPLEMENTATION_SCOPE_APPLICABILITY_INPUT_INVALID",
        `$.${key}`,
        "Property is not supported by the applicability boundary.",
      );
  }

  const artifactResult = validateImplementationScopeProjection(input.artifact);
  violations.push(...prefixProjectionViolations(artifactResult.violations, "$.artifact"));
  if (isRecord(input.artifact) && input.artifact.version !== IMPLEMENTATION_SCOPE_PROJECTION_VERSION)
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_APPLICABILITY_ARTIFACT_VERSION_UNSUPPORTED",
      "$.artifact.version",
      `Only execution-scope artifact version ${IMPLEMENTATION_SCOPE_PROJECTION_VERSION} is supported.`,
      IMPLEMENTATION_SCOPE_PROJECTION_VERSION,
      input.artifact.version,
    );

  const artifact = artifactResult.projection;
  if (artifact === undefined) return { violations };

  if (!isRecord(input.current)) {
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_APPLICABILITY_CURRENT_EVIDENCE_INVALID",
      "$.current",
      "Current repository, base, and authorization evidence must be an object.",
    );
    return { artifact, violations };
  }
  for (const key of Object.keys(input.current).sort(compareStrings)) {
    if (!CURRENT_KEYS.has(key))
      addViolation(
        violations,
        "IMPLEMENTATION_SCOPE_APPLICABILITY_CURRENT_EVIDENCE_INVALID",
        `$.current.${key}`,
        "Property is not supported as bounded current evidence.",
      );
  }

  // Reuse the projection boundary for all current evidence shape and version
  // checks. The artifact's scope is carried through only for validation; it
  // is never taken from current evidence and never refreshed here.
  const currentProjection = validateImplementationScopeProjection({
    version: artifact.version,
    kind: artifact.kind,
    authorization: input.current.authorization,
    repository: input.current.repository,
    base: input.current.base,
    ...(artifact.branch === undefined ? {} : { branch: artifact.branch }),
    scope: artifact.scope,
  });
  violations.push(...prefixProjectionViolations(currentProjection.violations, "$.current"));
  if (currentProjection.projection === undefined) return { artifact, violations };

  return {
    artifact,
    current: {
      repository: currentProjection.projection.repository,
      base: currentProjection.projection.base,
      authorization: currentProjection.projection.authorization,
    },
    violations,
  };
}

/**
 * Decide whether an execution-scope artifact is applicable to current
 * bounded authority. No mutation, re-authorization, clock, or Issue parsing
 * occurs in this function.
 */
export function validateImplementationScopeApplicability(input: unknown): ImplementationScopeApplicabilityResult {
  const normalized = normalizeInput(input);
  if (normalized.artifact === undefined || normalized.current === undefined || normalized.violations.length > 0)
    return unsupported(normalized.violations, normalized.artifact);

  const violations: ImplementationScopeApplicabilityViolation[] = [];
  const artifact = normalized.artifact;
  const current = normalized.current;

  if (!sameRepository(artifact.repository, current.repository))
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_APPLICABILITY_REPOSITORY_MISMATCH",
      "$.current.repository",
      "Current repository identity does not match the execution-scope artifact.",
      artifact.repository,
      current.repository,
    );

  if (artifact.base.branch !== current.base.branch)
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_APPLICABILITY_BASE_BRANCH_MISMATCH",
      "$.current.base.branch",
      "Current base branch does not match the execution-scope artifact.",
      artifact.base.branch,
      current.base.branch,
    );
  if (artifact.base.revision !== current.base.revision)
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_APPLICABILITY_BASE_REVISION_STALE",
      "$.current.base.revision",
      "Current base revision is stale or differs from the execution-scope artifact.",
      artifact.base.revision,
      current.base.revision,
    );
  if (artifact.base.freshness !== current.base.freshness)
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_APPLICABILITY_BASE_FRESHNESS_STALE",
      "$.current.base.freshness",
      "Current base freshness evidence is stale or differs from the execution-scope artifact.",
      artifact.base.freshness,
      current.base.freshness,
    );
  if (!sameAuthorization(artifact.authorization, current.authorization))
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_APPLICABILITY_AUTHORIZATION_MISMATCH",
      "$.current.authorization",
      "Current authorization identity does not match the execution-scope artifact.",
      artifact.authorization,
      current.authorization,
    );

  const hasMismatch = violations.some((violation) =>
    [
      "IMPLEMENTATION_SCOPE_APPLICABILITY_REPOSITORY_MISMATCH",
      "IMPLEMENTATION_SCOPE_APPLICABILITY_BASE_BRANCH_MISMATCH",
      "IMPLEMENTATION_SCOPE_APPLICABILITY_AUTHORIZATION_MISMATCH",
    ].includes(violation.code),
  );
  const hasStale = violations.some((violation) =>
    [
      "IMPLEMENTATION_SCOPE_APPLICABILITY_BASE_REVISION_STALE",
      "IMPLEMENTATION_SCOPE_APPLICABILITY_BASE_FRESHNESS_STALE",
    ].includes(violation.code),
  );
  const status: ImplementationScopeApplicabilityStatus = hasMismatch ? "mismatch" : hasStale ? "stale" : "current";
  return {
    valid: status === "current",
    applicable: status === "current",
    status,
    artifact,
    violations: Object.freeze(violations),
  };
}

/** Compatibility spelling for callers that use the explicit try terminology. */
export const tryValidateImplementationScopeApplicability = validateImplementationScopeApplicability;

/** Type guard for a current, applicable execution-scope artifact. */
export function isImplementationScopeApplicable(input: unknown): boolean {
  return validateImplementationScopeApplicability(input).status === "current";
}
