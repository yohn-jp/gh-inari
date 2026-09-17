/**
 * Immutable post-authorization execution evidence for one Implementation.
 *
 * Authorization freezes the canonical body and its digest before two facts
 * are necessarily known: the actual implementation branch and execution of
 * `verification.targetedTests`. This bounded Core contract represents
 * exactly those two facts, produced by the execution runtime and bound to
 * one specific authorization, base, branch, and PR head revision. It is
 * immutable input evidence, never a persisted lifecycle record, signature,
 * or replay registry.
 */

import { normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";
import type { ImplementationBaseEvidence } from "./implementation-authorization.js";
import type { ImplementationRepositoryIdentity } from "./implementation-contract.js";

export const IMPLEMENTATION_EXECUTION_EVIDENCE_VERSION = 1 as const;
export type ImplementationExecutionEvidenceVersion = typeof IMPLEMENTATION_EXECUTION_EVIDENCE_VERSION;
export const IMPLEMENTATION_EXECUTION_EVIDENCE_KIND = "implementation-execution-evidence" as const;

export const IMPLEMENTATION_EXECUTION_EVIDENCE_TEST_RESULTS = Object.freeze(["satisfied", "failed"] as const);
export type ImplementationExecutionEvidenceTestResult = (typeof IMPLEMENTATION_EXECUTION_EVIDENCE_TEST_RESULTS)[number];

export interface ImplementationExecutionEvidenceTargetedTest {
  readonly command: string;
  readonly result: ImplementationExecutionEvidenceTestResult;
}

/** Bounded immutable evidence for one authorized Implementation's branch and targeted-test execution. */
export interface ImplementationExecutionEvidence {
  readonly version: ImplementationExecutionEvidenceVersion;
  readonly kind: typeof IMPLEMENTATION_EXECUTION_EVIDENCE_KIND;
  readonly implementation: IssueReference;
  readonly repository: ImplementationRepositoryIdentity;
  readonly governedBodyDigest: string;
  readonly base: ImplementationBaseEvidence;
  readonly branch: string;
  readonly headRevision: string;
  readonly targetedTests: readonly ImplementationExecutionEvidenceTargetedTest[];
}

export type ImplementationExecutionEvidenceViolationCode =
  | "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID"
  | "IMPLEMENTATION_EXECUTION_EVIDENCE_UNKNOWN_PROPERTY"
  | "IMPLEMENTATION_EXECUTION_EVIDENCE_DUPLICATE_TEST";

export interface ImplementationExecutionEvidenceViolation {
  readonly code: ImplementationExecutionEvidenceViolationCode;
  readonly path: string;
  readonly message: string;
}

export interface ImplementationExecutionEvidenceParseResult {
  readonly valid: boolean;
  readonly evidence?: ImplementationExecutionEvidence;
  readonly violations: readonly ImplementationExecutionEvidenceViolation[];
}

export class ImplementationExecutionEvidenceError extends Error {
  readonly code: ImplementationExecutionEvidenceViolationCode;
  readonly violations: readonly ImplementationExecutionEvidenceViolation[];

  constructor(violations: readonly ImplementationExecutionEvidenceViolation[]) {
    const first = violations[0];
    if (first === undefined) throw new Error("Implementation execution evidence errors require a violation.");
    super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
    this.name = "ImplementationExecutionEvidenceError";
    this.code = first.code;
    this.violations = Object.freeze([...violations]);
  }
}

const EVIDENCE_KEYS = new Set([
  "version",
  "kind",
  "implementation",
  "repository",
  "governedBodyDigest",
  "base",
  "branch",
  "headRevision",
  "targetedTests",
]);
const REPOSITORY_KEYS = new Set(["repositoryHost", "repositoryId", "repository"]);
const BASE_KEYS = new Set(["branch", "revision", "freshness"]);
const TEST_KEYS = new Set(["command", "result"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const MAX_TARGETED_TESTS = 200;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cloneImmutable<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => cloneImmutable(entry))) as T;
  if (isRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareStrings)) clone[key] = cloneImmutable(value[key]);
    return Object.freeze(clone) as T;
  }
  return value;
}

function addViolation(
  violations: ImplementationExecutionEvidenceViolation[],
  code: ImplementationExecutionEvidenceViolationCode,
  path: string,
  message: string,
): void {
  violations.push({ code, path, message });
}

function unknownProperties(
  value: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  violations: ImplementationExecutionEvidenceViolation[],
): void {
  for (const key of Object.keys(value).sort(compareStrings)) {
    if (!allowed.has(key))
      addViolation(
        violations,
        "IMPLEMENTATION_EXECUTION_EVIDENCE_UNKNOWN_PROPERTY",
        `${path}.${key}`,
        "Property is not supported.",
      );
  }
}

/** Canonicalization retained only for repository identities that intentionally share authorization semantics. */
function text(
  value: unknown,
  path: string,
  violations: ImplementationExecutionEvidenceViolation[],
): string | undefined {
  if (typeof value !== "string") {
    addViolation(violations, "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID", path, "Value must be a string.");
    return undefined;
  }
  const normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) {
    addViolation(violations, "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID", path, "Value must not be empty.");
    return undefined;
  }
  if (!SAFE_TEXT.test(normalized)) {
    addViolation(violations, "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID", path, "Value contains a control character.");
    return undefined;
  }
  return normalized;
}

/**
 * Runtime/provider evidence identities are exact values, not authored prose.
 * Trimming, Unicode compatibility normalization, or newline rewriting would
 * silently collapse distinct evidence before authorization/PR binding. Keep
 * the original string byte-for-byte while enforcing only the shared safety
 * and non-empty boundary; field-specific syntax checks remain separate.
 */
function identityText(
  value: unknown,
  path: string,
  violations: ImplementationExecutionEvidenceViolation[],
): string | undefined {
  if (typeof value !== "string") {
    addViolation(violations, "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID", path, "Value must be a string.");
    return undefined;
  }
  if (value.length === 0) {
    addViolation(violations, "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID", path, "Value must not be empty.");
    return undefined;
  }
  if (!SAFE_TEXT.test(value)) {
    addViolation(violations, "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID", path, "Value contains a control character.");
    return undefined;
  }
  return value;
}

function normalizeRepository(
  value: unknown,
  path: string,
  violations: ImplementationExecutionEvidenceViolation[],
): ImplementationRepositoryIdentity | undefined {
  if (!isRecord(value)) {
    addViolation(
      violations,
      "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID",
      path,
      "Repository identity must be an object.",
    );
    return undefined;
  }
  unknownProperties(value, REPOSITORY_KEYS, path, violations);
  const repositoryHost = text(value.repositoryHost, `${path}.repositoryHost`, violations);
  const repositoryId = text(value.repositoryId, `${path}.repositoryId`, violations);
  const repository =
    value.repository === undefined ? undefined : text(value.repository, `${path}.repository`, violations);
  if (repositoryId !== undefined && !REPOSITORY_ID_PATTERN.test(repositoryId))
    addViolation(
      violations,
      "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID",
      `${path}.repositoryId`,
      "Repository ID is invalid.",
    );
  if (repository !== undefined && !REPOSITORY_PATTERN.test(repository))
    addViolation(
      violations,
      "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID",
      `${path}.repository`,
      "Repository locator is invalid.",
    );
  if (repositoryHost === undefined || repositoryId === undefined) return undefined;
  return {
    repositoryHost: repositoryHost.toLocaleLowerCase("en-US"),
    repositoryId,
    ...(repository === undefined ? {} : { repository: repository.toLocaleLowerCase("en-US") }),
  };
}

function normalizeBase(
  value: unknown,
  path: string,
  violations: ImplementationExecutionEvidenceViolation[],
): ImplementationBaseEvidence | undefined {
  if (!isRecord(value)) {
    addViolation(violations, "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID", path, "Base evidence must be an object.");
    return undefined;
  }
  unknownProperties(value, BASE_KEYS, path, violations);
  const branch = identityText(value.branch, `${path}.branch`, violations);
  const revision = identityText(value.revision, `${path}.revision`, violations);
  const freshness = identityText(value.freshness, `${path}.freshness`, violations);
  if (branch !== undefined && !BRANCH_PATTERN.test(branch))
    addViolation(violations, "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID", `${path}.branch`, "Base branch is invalid.");
  if (branch === undefined || revision === undefined || freshness === undefined) return undefined;
  return { branch, revision, freshness };
}

function normalizeTargetedTests(
  value: unknown,
  path: string,
  violations: ImplementationExecutionEvidenceViolation[],
): readonly ImplementationExecutionEvidenceTargetedTest[] | undefined {
  if (!Array.isArray(value)) {
    addViolation(violations, "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID", path, "Targeted tests must be an array.");
    return undefined;
  }
  if (value.length > MAX_TARGETED_TESTS) {
    addViolation(
      violations,
      "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID",
      path,
      `Targeted tests exceed ${MAX_TARGETED_TESTS} entries.`,
    );
    return undefined;
  }
  // Duplicate/unknown commands must never be resolved by collection order:
  // every entry is validated independently and a single duplicate/malformed
  // entry invalidates the whole collection rather than being skipped.
  const seen = new Set<string>();
  const results: ImplementationExecutionEvidenceTargetedTest[] = [];
  let ok = true;
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      addViolation(
        violations,
        "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID",
        `${path}[${index}]`,
        "Targeted test record must be an object.",
      );
      ok = false;
      return;
    }
    unknownProperties(entry, TEST_KEYS, `${path}[${index}]`, violations);
    const command = identityText(entry.command, `${path}[${index}].command`, violations);
    const result = entry.result;
    if (result !== "satisfied" && result !== "failed") {
      addViolation(
        violations,
        "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID",
        `${path}[${index}].result`,
        'Result must be "satisfied" or "failed".',
      );
      ok = false;
    }
    if (command === undefined) {
      ok = false;
      return;
    }
    if (seen.has(command)) {
      addViolation(
        violations,
        "IMPLEMENTATION_EXECUTION_EVIDENCE_DUPLICATE_TEST",
        `${path}[${index}].command`,
        "Targeted-test command is duplicated.",
      );
      ok = false;
      return;
    }
    seen.add(command);
    if (result === "satisfied" || result === "failed") results.push({ command, result });
  });
  return ok ? results : undefined;
}

/** Parse and canonically validate one execution-evidence input. Never throws. */
export function tryParseImplementationExecutionEvidence(input: unknown): ImplementationExecutionEvidenceParseResult {
  const violations: ImplementationExecutionEvidenceViolation[] = [];
  if (!isRecord(input)) {
    addViolation(violations, "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID", "$", "Execution evidence must be an object.");
    return { valid: false, violations };
  }
  unknownProperties(input, EVIDENCE_KEYS, "$", violations);
  if (input.version !== IMPLEMENTATION_EXECUTION_EVIDENCE_VERSION)
    addViolation(
      violations,
      "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID",
      "$.version",
      "Execution evidence version is unsupported.",
    );
  if (input.kind !== IMPLEMENTATION_EXECUTION_EVIDENCE_KIND)
    addViolation(
      violations,
      "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID",
      "$.kind",
      "Execution evidence kind is unsupported.",
    );
  const referenceResult = normalizeIssueReference(input.implementation, "$.implementation");
  if (!referenceResult.valid || referenceResult.reference === undefined)
    addViolation(
      violations,
      "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID",
      "$.implementation",
      "Implementation reference is invalid.",
    );
  const repository = normalizeRepository(input.repository, "$.repository", violations);
  const governedBodyDigest = identityText(input.governedBodyDigest, "$.governedBodyDigest", violations);
  if (governedBodyDigest !== undefined && !SHA256_PATTERN.test(governedBodyDigest))
    addViolation(
      violations,
      "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID",
      "$.governedBodyDigest",
      "Body digest must be lowercase SHA-256 hex.",
    );
  const base = normalizeBase(input.base, "$.base", violations);
  const branch = identityText(input.branch, "$.branch", violations);
  if (branch !== undefined && !BRANCH_PATTERN.test(branch))
    addViolation(violations, "IMPLEMENTATION_EXECUTION_EVIDENCE_INVALID", "$.branch", "Branch is invalid.");
  const headRevision = identityText(input.headRevision, "$.headRevision", violations);
  const targetedTests = normalizeTargetedTests(input.targetedTests, "$.targetedTests", violations);
  if (
    violations.length > 0 ||
    referenceResult.reference === undefined ||
    repository === undefined ||
    governedBodyDigest === undefined ||
    base === undefined ||
    branch === undefined ||
    headRevision === undefined ||
    targetedTests === undefined
  )
    return { valid: false, violations };
  return {
    valid: true,
    evidence: cloneImmutable({
      version: IMPLEMENTATION_EXECUTION_EVIDENCE_VERSION,
      kind: IMPLEMENTATION_EXECUTION_EVIDENCE_KIND,
      implementation: referenceResult.reference,
      repository,
      governedBodyDigest,
      base,
      branch,
      headRevision,
      targetedTests,
    }),
    violations: [],
  };
}

/** Throwing entry point for callers that require an admitted execution-evidence value. */
export function parseImplementationExecutionEvidence(input: unknown): ImplementationExecutionEvidence {
  const result = tryParseImplementationExecutionEvidence(input);
  if (!result.valid || result.evidence === undefined) throw new ImplementationExecutionEvidenceError(result.violations);
  return result.evidence;
}
