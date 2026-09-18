/**
 * Explicit authorization for exactly one canonical Implementation body.
 *
 * This is a representation-independent Core boundary.  It consumes an
 * authoritative Issue body and provider-derived repository/base evidence but
 * does not read or write GitHub, persist a database record, or infer any
 * execution scope.  GitHub remains the persistent authority; the record
 * produced here is bounded immutable evidence for one authorization event.
 */

import { canonicalJsonString, type CanonicalJsonValue } from "./agent-authority/codec.js";
import {
  canonicalizeImplementationIssueBody,
  IMPLEMENTATION_CONTRACT_VERSION,
  implementationIssueBodyDigest,
  parseImplementationIssueBody,
  serializeImplementationContract,
  type ImplementationContract,
  type ImplementationContractVersion,
  type ImplementationRepositoryIdentity,
} from "./implementation-contract.js";
import { issueReferenceKey, normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";
import {
  tryAdmitImplementationReadiness,
  type ImplementationReadinessAdmissionResult,
} from "./implementation-readiness.js";

export const IMPLEMENTATION_AUTHORIZATION_VERSION = 1 as const;
export type ImplementationAuthorizationVersion = typeof IMPLEMENTATION_AUTHORIZATION_VERSION;
export const IMPLEMENTATION_AUTHORIZATION_KIND = "implementation-authorization" as const;
export const IMPLEMENTATION_AUTHORIZATION_DIGEST_ALGORITHM = "sha256" as const;

export type ImplementationLifecycleStatus =
  "draft" | "ready" | "authorized" | "invalidated" | "superseded" | "completed" | "aborted";

export interface ImplementationBaseEvidence {
  /** Provider-resolved base branch name. */
  readonly branch: string;
  /** Provider-resolved immutable base revision. */
  readonly revision: string;
  /** Provider/workflow freshness evidence, compared exactly at authorization. */
  readonly freshness: string;
}

export interface ImplementationIssueAuthorizationEvidence {
  readonly reference: IssueReference;
  readonly body: string;
  /** Non-governed metadata is accepted for adapter convenience and ignored. */
  readonly title?: string;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly comments?: readonly unknown[];
}

/** Explicit provider evidence for a replacement Implementation relationship. */
export interface ImplementationSupersessionEvidence {
  readonly supersedes?: readonly IssueReference[];
  readonly supersededBy?: readonly IssueReference[];
}

/** Immutable evidence produced by one explicit authorization. */
export interface ImplementationAuthorizationRecord {
  readonly version: ImplementationAuthorizationVersion;
  readonly kind: typeof IMPLEMENTATION_AUTHORIZATION_KIND;
  readonly implementation: IssueReference;
  readonly contractVersion: ImplementationContractVersion;
  readonly repository: ImplementationRepositoryIdentity;
  readonly base: ImplementationBaseEvidence;
  readonly governedBodyDigest: string;
  readonly authorizedAt?: string;
}

export interface ImplementationAuthorizationInput {
  /** Canonical Implementation Issue identity. */
  readonly implementation?: IssueReference;
  /** Preferred adapter-shaped current authoritative Issue evidence. */
  readonly issue?: ImplementationIssueAuthorizationEvidence;
  /** Direct body/identity spellings retained for representation-independent callers. */
  readonly body?: string;
  readonly repository: ImplementationRepositoryIdentity;
  readonly base: ImplementationBaseEvidence;
  /** Core-owned dependency readiness evidence required before authorization. */
  readonly readiness?: unknown;
  /** Existing evidence must be supplied on replay; it is never overwritten. */
  readonly existingAuthorization?: unknown;
  readonly authorizedAt?: string;
}

export interface ImplementationAuthorizationVerificationInput {
  readonly authorization: unknown;
  readonly implementation?: IssueReference;
  readonly issue?: ImplementationIssueAuthorizationEvidence;
  readonly body?: string;
  readonly repository?: ImplementationRepositoryIdentity;
  readonly base?: ImplementationBaseEvidence;
  /** Optional current dependency readiness evidence for verification/replay. */
  readonly readiness?: unknown;
  readonly supersession?: ImplementationSupersessionEvidence;
  /**
   * Legacy input retained for representation compatibility; `true` is
   * rejected and can never create terminal completion state.
   */
  readonly completed?: boolean;
}

export type ImplementationAuthorizationViolationCode =
  | "IMPLEMENTATION_AUTHORIZATION_INPUT_INVALID"
  | "IMPLEMENTATION_AUTHORIZATION_UNKNOWN_PROPERTY"
  | "IMPLEMENTATION_AUTHORIZATION_RECORD_INVALID"
  | "IMPLEMENTATION_AUTHORIZATION_RECORD_NONCANONICAL"
  | "IMPLEMENTATION_AUTHORIZATION_BODY_INVALID"
  | "IMPLEMENTATION_AUTHORIZATION_NOT_READY"
  | "IMPLEMENTATION_AUTHORIZATION_REPOSITORY_MISMATCH"
  | "IMPLEMENTATION_AUTHORIZATION_IMPLEMENTATION_MISMATCH"
  | "IMPLEMENTATION_AUTHORIZATION_BASE_EVIDENCE_UNAVAILABLE"
  | "IMPLEMENTATION_AUTHORIZATION_BASE_BRANCH_MISMATCH"
  | "IMPLEMENTATION_AUTHORIZATION_BASE_REVISION_REQUIRED"
  | "IMPLEMENTATION_AUTHORIZATION_BASE_REVISION_MISMATCH"
  | "IMPLEMENTATION_AUTHORIZATION_BASE_FRESHNESS_REQUIRED"
  | "IMPLEMENTATION_AUTHORIZATION_BASE_FRESHNESS_MISMATCH"
  | "IMPLEMENTATION_MODIFIED_AFTER_AUTHORIZATION"
  | "IMPLEMENTATION_AUTHORIZATION_BINDING_DRIFT"
  | "IMPLEMENTATION_AUTHORIZATION_REPLAY_MISMATCH"
  | "IMPLEMENTATION_AUTHORIZATION_SUPERSESSION_INVALID"
  | "IMPLEMENTATION_AUTHORIZATION_SUPERSEDED"
  | "IMPLEMENTATION_AUTHORIZATION_COMPLETION_INVALID";

export interface ImplementationAuthorizationViolation {
  readonly code: ImplementationAuthorizationViolationCode;
  readonly path: string;
  readonly message: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface ImplementationAuthorizationResult {
  readonly valid: boolean;
  readonly status?: ImplementationLifecycleStatus;
  readonly authorization?: ImplementationAuthorizationRecord;
  readonly contract?: ImplementationContract;
  readonly governedBodyDigest?: string;
  readonly readiness?: ImplementationReadinessAdmissionResult;
  readonly violations: readonly ImplementationAuthorizationViolation[];
}

export interface ImplementationAuthorizationInspectionResult extends ImplementationAuthorizationResult {
  readonly authorized: boolean;
  readonly current: boolean;
}

export class ImplementationAuthorizationError extends Error {
  readonly code: ImplementationAuthorizationViolationCode;
  readonly violations: readonly ImplementationAuthorizationViolation[];

  constructor(violations: readonly ImplementationAuthorizationViolation[]) {
    const first = violations[0];
    if (first === undefined) throw new Error("Implementation authorization errors require a violation.");
    super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
    this.name = "ImplementationAuthorizationError";
    this.code = first.code;
    this.violations = Object.freeze([...violations]);
  }
}

const AUTHORIZATION_KEYS = new Set([
  "version",
  "kind",
  "implementation",
  "contractVersion",
  "repository",
  "base",
  "governedBodyDigest",
  "authorizedAt",
]);
const REPOSITORY_KEYS = new Set(["repositoryHost", "repositoryId", "repository"]);
const BASE_KEYS = new Set(["branch", "revision", "freshness"]);
const INPUT_KEYS = new Set([
  "implementation",
  "issue",
  "body",
  "repository",
  "base",
  "readiness",
  "existingAuthorization",
  "authorizedAt",
]);
const VERIFICATION_KEYS = new Set([
  "authorization",
  "implementation",
  "issue",
  "body",
  "repository",
  "base",
  "readiness",
  "supersession",
  "completed",
]);
const ISSUE_KEYS = new Set(["reference", "body", "title", "labels", "assignees", "comments"]);
const SUPERSESSION_KEYS = new Set(["supersedes", "supersededBy"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

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
  violations: ImplementationAuthorizationViolation[],
  code: ImplementationAuthorizationViolationCode,
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

function unknownProperties(
  value: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  violations: ImplementationAuthorizationViolation[],
): void {
  for (const key of Object.keys(value).sort(compareStrings)) {
    if (!allowed.has(key))
      addViolation(
        violations,
        "IMPLEMENTATION_AUTHORIZATION_UNKNOWN_PROPERTY",
        `${path}.${key}`,
        "Property is not supported.",
      );
  }
}

function text(
  value: unknown,
  path: string,
  violations: ImplementationAuthorizationViolation[],
  required = true,
): string | undefined {
  if (typeof value !== "string") {
    if (required)
      addViolation(violations, "IMPLEMENTATION_AUTHORIZATION_RECORD_INVALID", path, "Value must be a string.");
    return undefined;
  }
  const normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) {
    if (required)
      addViolation(violations, "IMPLEMENTATION_AUTHORIZATION_RECORD_INVALID", path, "Value must not be empty.");
    return undefined;
  }
  if (!SAFE_TEXT.test(normalized)) {
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_RECORD_INVALID",
      path,
      "Value contains a control character.",
    );
    return undefined;
  }
  return normalized;
}

function normalizeRepository(
  value: unknown,
  path: string,
  violations: ImplementationAuthorizationViolation[],
): ImplementationRepositoryIdentity | undefined {
  if (!isRecord(value)) {
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_RECORD_INVALID",
      path,
      "Repository identity must be an object.",
    );
    return undefined;
  }
  unknownProperties(value, REPOSITORY_KEYS, path, violations);
  const repositoryHost = text(value.repositoryHost, `${path}.repositoryHost`, violations);
  const repositoryId = text(value.repositoryId, `${path}.repositoryId`, violations);
  const repository = text(value.repository, `${path}.repository`, violations, false);
  if (repositoryId !== undefined && !REPOSITORY_ID_PATTERN.test(repositoryId))
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_RECORD_INVALID",
      `${path}.repositoryId`,
      "Repository ID is invalid.",
    );
  if (repository !== undefined && !REPOSITORY_PATTERN.test(repository))
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_RECORD_INVALID",
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
  violations: ImplementationAuthorizationViolation[],
): ImplementationBaseEvidence | undefined {
  if (!isRecord(value)) {
    addViolation(violations, "IMPLEMENTATION_AUTHORIZATION_RECORD_INVALID", path, "Base evidence must be an object.");
    return undefined;
  }
  unknownProperties(value, BASE_KEYS, path, violations);
  const branch = text(value.branch, `${path}.branch`, violations);
  const revision = text(value.revision, `${path}.revision`, violations);
  const freshness = text(value.freshness, `${path}.freshness`, violations);
  if (branch !== undefined && !BRANCH_PATTERN.test(branch))
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_RECORD_INVALID",
      `${path}.branch`,
      "Base branch is invalid.",
    );
  if (branch === undefined || revision === undefined || freshness === undefined) return undefined;
  return { branch, revision, freshness };
}

function normalizeReference(
  value: unknown,
  path: string,
  violations: ImplementationAuthorizationViolation[],
): IssueReference | undefined {
  const result = normalizeIssueReference(value, path);
  if (!result.valid || result.reference === undefined) {
    addViolation(violations, "IMPLEMENTATION_AUTHORIZATION_RECORD_INVALID", path, "Issue reference is invalid.");
    return undefined;
  }
  return result.reference;
}

function sameRepository(left: ImplementationRepositoryIdentity, right: ImplementationRepositoryIdentity): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

function sameBase(left: ImplementationBaseEvidence, right: ImplementationBaseEvidence): boolean {
  return left.branch === right.branch && left.revision === right.revision && left.freshness === right.freshness;
}

function normalizeAuthorizationRecord(
  input: unknown,
  path = "$",
): {
  readonly record?: ImplementationAuthorizationRecord;
  readonly violations: readonly ImplementationAuthorizationViolation[];
} {
  const violations: ImplementationAuthorizationViolation[] = [];
  if (!isRecord(input)) {
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_RECORD_INVALID",
      path,
      "Authorization record must be an object.",
    );
    return { violations };
  }
  unknownProperties(input, AUTHORIZATION_KEYS, path, violations);
  if (input.version !== IMPLEMENTATION_AUTHORIZATION_VERSION)
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_RECORD_INVALID",
      `${path}.version`,
      "Authorization record version is unsupported.",
    );
  if (input.kind !== IMPLEMENTATION_AUTHORIZATION_KIND)
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_RECORD_INVALID",
      `${path}.kind`,
      "Authorization record kind is unsupported.",
    );
  const implementation = normalizeReference(input.implementation, `${path}.implementation`, violations);
  const contractVersion = input.contractVersion;
  if (contractVersion !== IMPLEMENTATION_CONTRACT_VERSION)
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_RECORD_INVALID",
      `${path}.contractVersion`,
      "Implementation contract version is unsupported.",
    );
  const repository = normalizeRepository(input.repository, `${path}.repository`, violations);
  const base = normalizeBase(input.base, `${path}.base`, violations);
  const governedBodyDigest = text(input.governedBodyDigest, `${path}.governedBodyDigest`, violations);
  if (governedBodyDigest !== undefined && !SHA256_PATTERN.test(governedBodyDigest))
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_RECORD_INVALID",
      `${path}.governedBodyDigest`,
      "Body digest must be lowercase SHA-256 hex.",
    );
  const authorizedAt = text(input.authorizedAt, `${path}.authorizedAt`, violations, false);
  if (
    violations.length > 0 ||
    implementation === undefined ||
    repository === undefined ||
    base === undefined ||
    governedBodyDigest === undefined
  )
    return { violations };
  return {
    record: cloneImmutable({
      version: IMPLEMENTATION_AUTHORIZATION_VERSION,
      kind: IMPLEMENTATION_AUTHORIZATION_KIND,
      implementation,
      contractVersion: IMPLEMENTATION_CONTRACT_VERSION,
      repository,
      base,
      governedBodyDigest,
      ...(authorizedAt === undefined ? {} : { authorizedAt }),
    }),
    violations: [],
  };
}

function issueEvidence(
  input: ImplementationAuthorizationInput | ImplementationAuthorizationVerificationInput,
  violations: ImplementationAuthorizationViolation[],
): { readonly implementation?: IssueReference; readonly body?: string } {
  let implementation = input.implementation;
  let body = input.body;
  if (input.issue !== undefined) {
    if (!isRecord(input.issue)) {
      addViolation(
        violations,
        "IMPLEMENTATION_AUTHORIZATION_INPUT_INVALID",
        "$.issue",
        "Issue evidence must be an object.",
      );
    } else {
      unknownProperties(input.issue, ISSUE_KEYS, "$.issue", violations);
      const issueReference = normalizeReference(input.issue.reference, "$.issue.reference", violations);
      if (
        implementation !== undefined &&
        issueReference !== undefined &&
        issueReferenceKey(implementation) !== issueReferenceKey(issueReference)
      )
        addViolation(
          violations,
          "IMPLEMENTATION_AUTHORIZATION_IMPLEMENTATION_MISMATCH",
          "$.issue.reference",
          "Issue evidence identity disagrees with implementation identity.",
        );
      if (implementation === undefined) implementation = issueReference;
      if (body !== undefined && input.issue.body !== body)
        addViolation(
          violations,
          "IMPLEMENTATION_AUTHORIZATION_INPUT_INVALID",
          "$.body",
          "Direct body and Issue evidence body disagree.",
        );
      body = input.issue.body;
    }
  }
  if (typeof body !== "string")
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_BODY_INVALID",
      "$.body",
      "Current authoritative Issue body is required.",
    );
  return { implementation, body };
}

function validateAuthorizationInput(
  input: unknown,
  verification: boolean,
): {
  readonly input?: ImplementationAuthorizationInput | ImplementationAuthorizationVerificationInput;
  readonly implementation?: IssueReference;
  readonly body?: string;
  readonly repository?: ImplementationRepositoryIdentity;
  readonly base?: ImplementationBaseEvidence;
  readonly violations: readonly ImplementationAuthorizationViolation[];
} {
  const violations: ImplementationAuthorizationViolation[] = [];
  if (!isRecord(input)) {
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_INPUT_INVALID",
      "$",
      "Authorization input must be an object.",
    );
    return { violations };
  }
  unknownProperties(input, verification ? VERIFICATION_KEYS : INPUT_KEYS, "$", violations);
  const evidence = issueEvidence(
    input as unknown as ImplementationAuthorizationInput | ImplementationAuthorizationVerificationInput,
    violations,
  );
  const implementation =
    evidence.implementation === undefined
      ? undefined
      : normalizeReference(evidence.implementation, "$.implementation", violations);
  const body = evidence.body;
  const repository =
    input.repository === undefined ? undefined : normalizeRepository(input.repository, "$.repository", violations);
  const base = input.base === undefined ? undefined : normalizeBase(input.base, "$.base", violations);
  return {
    input: input as unknown as ImplementationAuthorizationInput | ImplementationAuthorizationVerificationInput,
    implementation,
    body,
    repository,
    base,
    violations,
  };
}

function contractBody(
  body: string,
  violations: ImplementationAuthorizationViolation[],
): { contract?: ImplementationContract; digest?: string } {
  const parsed = parseImplementationIssueBody(body);
  if (!parsed.valid || parsed.contract === undefined) {
    for (const violation of parsed.violations)
      addViolation(violations, "IMPLEMENTATION_AUTHORIZATION_BODY_INVALID", violation.path, violation.message);
    return {};
  }
  return { contract: parsed.contract, digest: implementationIssueBodyDigest(body) };
}

function readinessAdmission(
  contract: ImplementationContract,
  implementation: IssueReference | undefined,
  input: unknown,
): ImplementationReadinessAdmissionResult {
  const evidence =
    isRecord(input) && hasOwn(input, "evidence") ? input.evidence : input === undefined ? undefined : input;
  return tryAdmitImplementationReadiness({
    contract,
    implementation,
    ...(evidence === undefined ? {} : { evidence }),
  });
}

function appendReadinessViolation(
  readiness: ImplementationReadinessAdmissionResult,
  violations: ImplementationAuthorizationViolation[],
): void {
  if (readiness.admitted) return;
  addViolation(
    violations,
    "IMPLEMENTATION_AUTHORIZATION_NOT_READY",
    "$.readiness",
    `Implementation readiness admission is ${readiness.classification}.`,
    "READY",
    readiness.classification,
  );
}

function bindingViolations(
  contract: ImplementationContract,
  implementation: IssueReference | undefined,
  repository: ImplementationRepositoryIdentity | undefined,
  base: ImplementationBaseEvidence | undefined,
  violations: ImplementationAuthorizationViolation[],
): void {
  if (implementation !== undefined && !sameRepository(contract.repository, implementation))
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_REPOSITORY_MISMATCH",
      "$.implementation",
      "Implementation Issue belongs to a different repository.",
      contract.repository,
      implementation,
    );
  if (repository === undefined) {
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_INPUT_INVALID",
      "$.repository",
      "Authoritative repository identity is required.",
    );
  } else if (!sameRepository(contract.repository, repository)) {
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_REPOSITORY_MISMATCH",
      "$.repository",
      "Authoritative repository identity disagrees with the contract.",
      contract.repository,
      repository,
    );
  }
  if (base === undefined) {
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_BASE_EVIDENCE_UNAVAILABLE",
      "$.base",
      "Authoritative base branch, revision, and freshness evidence is required.",
    );
    return;
  }
  if (base.branch !== contract.execution.baseBranch)
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_BASE_BRANCH_MISMATCH",
      "$.base.branch",
      "Base branch does not match the contract.",
      contract.execution.baseBranch,
      base.branch,
    );
  if (contract.execution.baseRevision === undefined)
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_BASE_REVISION_REQUIRED",
      "$.execution.baseRevision",
      "Authorization requires a fixed base revision.",
    );
  else if (base.revision !== contract.execution.baseRevision)
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_BASE_REVISION_MISMATCH",
      "$.base.revision",
      "Base revision is stale or differs from the contract.",
      contract.execution.baseRevision,
      base.revision,
    );
  if (contract.execution.baseFreshness === undefined)
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_BASE_FRESHNESS_REQUIRED",
      "$.execution.baseFreshness",
      "Authorization requires base freshness evidence.",
    );
  else if (base.freshness !== contract.execution.baseFreshness)
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_BASE_FRESHNESS_MISMATCH",
      "$.base.freshness",
      "Base freshness evidence is stale or differs from the contract.",
      contract.execution.baseFreshness,
      base.freshness,
    );
}

function hasCode(
  violations: readonly ImplementationAuthorizationViolation[],
  code: ImplementationAuthorizationViolationCode,
): boolean {
  return violations.some((violation) => violation.code === code);
}

function recordBindingDrift(
  record: ImplementationAuthorizationRecord,
  implementation: IssueReference | undefined,
  repository: ImplementationRepositoryIdentity | undefined,
  base: ImplementationBaseEvidence | undefined,
  violations: ImplementationAuthorizationViolation[],
): void {
  if (implementation !== undefined && issueReferenceKey(implementation) !== issueReferenceKey(record.implementation))
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_IMPLEMENTATION_MISMATCH",
      "$.implementation",
      "Current Issue identity does not match the authorization record.",
      record.implementation,
      implementation,
    );
  if (repository === undefined || base === undefined) {
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_BASE_EVIDENCE_UNAVAILABLE",
      "$",
      "Current repository and base evidence is required to verify authorization freshness.",
    );
    return;
  }
  if (!sameRepository(repository, record.repository))
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_BINDING_DRIFT",
      "$.repository",
      "Repository identity changed after authorization.",
      record.repository,
      repository,
    );
  if (!sameBase(base, record.base))
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_BINDING_DRIFT",
      "$.base",
      "Base branch, revision, or freshness changed after authorization.",
      record.base,
      base,
    );
}

function normalizeSupersession(
  value: unknown,
  implementation: IssueReference | undefined,
  violations: ImplementationAuthorizationViolation[],
): ImplementationSupersessionEvidence | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_SUPERSESSION_INVALID",
      "$.supersession",
      "Supersession evidence must be an object.",
    );
    return undefined;
  }
  unknownProperties(value, SUPERSESSION_KEYS, "$.supersession", violations);
  const parse = (key: "supersedes" | "supersededBy"): readonly IssueReference[] => {
    const raw = value[key];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      addViolation(
        violations,
        "IMPLEMENTATION_AUTHORIZATION_SUPERSESSION_INVALID",
        `$.supersession.${key}`,
        "Supersession references must be an array.",
      );
      return [];
    }
    const seen = new Set<string>();
    const references: IssueReference[] = [];
    raw.forEach((entry, index) => {
      const reference = normalizeReference(entry, `$.supersession.${key}[${index}]`, violations);
      if (reference === undefined) return;
      const keyValue = issueReferenceKey(reference);
      if (seen.has(keyValue)) {
        addViolation(
          violations,
          "IMPLEMENTATION_AUTHORIZATION_SUPERSESSION_INVALID",
          `$.supersession.${key}[${index}]`,
          "Supersession references must be unique.",
        );
        return;
      }
      if (implementation !== undefined && keyValue === issueReferenceKey(implementation)) {
        addViolation(
          violations,
          "IMPLEMENTATION_AUTHORIZATION_SUPERSESSION_INVALID",
          `$.supersession.${key}[${index}]`,
          "An Implementation cannot supersede itself.",
        );
        return;
      }
      seen.add(keyValue);
      references.push(reference);
    });
    return references.sort((left, right) => issueReferenceKey(left).localeCompare(issueReferenceKey(right), "en-US"));
  };
  return cloneImmutable({ supersedes: parse("supersedes"), supersededBy: parse("supersededBy") });
}

function authorizationResult(
  status: ImplementationLifecycleStatus,
  violations: readonly ImplementationAuthorizationViolation[],
  values: {
    readonly authorization?: ImplementationAuthorizationRecord;
    readonly contract?: ImplementationContract;
    readonly governedBodyDigest?: string;
    readonly readiness?: ImplementationReadinessAdmissionResult;
  } = {},
): ImplementationAuthorizationResult {
  return {
    valid: violations.length === 0,
    status,
    ...values,
    violations: Object.freeze([...violations]),
  };
}

function nowIso(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string") return undefined;
  const value = input.normalize("NFKC").trim();
  return value.length === 0 ? undefined : value;
}

/**
 * Explicitly authorize one current governed body.  Passing existing evidence
 * makes replay idempotent; any mismatch returns a typed failure and never
 * creates a replacement record for the same Implementation.
 */
export function tryAuthorizeImplementation(input: unknown): ImplementationAuthorizationResult {
  const normalized = validateAuthorizationInput(input, false);
  const violations = [...normalized.violations];
  const value = normalized.input as ImplementationAuthorizationInput | undefined;
  if (value === undefined || normalized.body === undefined) return authorizationResult("draft", violations);
  const parsed = contractBody(normalized.body, violations);
  if (parsed.contract === undefined || parsed.digest === undefined) return authorizationResult("draft", violations);
  const readiness = readinessAdmission(parsed.contract, normalized.implementation, value.readiness);
  appendReadinessViolation(readiness, violations);
  if (normalized.implementation === undefined)
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_INPUT_INVALID",
      "$.implementation",
      "Implementation Issue identity is required.",
    );
  bindingViolations(parsed.contract, normalized.implementation, normalized.repository, normalized.base, violations);
  const existingResult =
    value.existingAuthorization === undefined ? undefined : normalizeAuthorizationRecord(value.existingAuthorization);
  if (existingResult !== undefined) {
    violations.push(...existingResult.violations);
    if (existingResult.record !== undefined) {
      const record = existingResult.record;
      if (
        normalized.implementation !== undefined &&
        issueReferenceKey(normalized.implementation) !== issueReferenceKey(record.implementation)
      )
        addViolation(
          violations,
          "IMPLEMENTATION_AUTHORIZATION_REPLAY_MISMATCH",
          "$.implementation",
          "Replay targets a different Implementation.",
          record.implementation,
          normalized.implementation,
        );
      if (record.governedBodyDigest !== parsed.digest)
        addViolation(
          violations,
          "IMPLEMENTATION_MODIFIED_AFTER_AUTHORIZATION",
          "$.body",
          "The governed Implementation body changed after authorization.",
          record.governedBodyDigest,
          parsed.digest,
        );
      if (normalized.repository !== undefined && !sameRepository(record.repository, normalized.repository))
        addViolation(
          violations,
          "IMPLEMENTATION_AUTHORIZATION_BINDING_DRIFT",
          "$.repository",
          "Repository binding changed after authorization.",
          record.repository,
          normalized.repository,
        );
      if (normalized.base !== undefined && !sameBase(record.base, normalized.base))
        addViolation(
          violations,
          "IMPLEMENTATION_AUTHORIZATION_BINDING_DRIFT",
          "$.base",
          "Base binding changed after authorization.",
          record.base,
          normalized.base,
        );
      if (violations.length === 0)
        return authorizationResult("authorized", [], {
          authorization: record,
          contract: parsed.contract,
          governedBodyDigest: parsed.digest,
          readiness,
        });
      return authorizationResult("invalidated", violations, {
        authorization: record,
        contract: parsed.contract,
        governedBodyDigest: parsed.digest,
        readiness,
      });
    }
    return authorizationResult("invalidated", violations, {
      contract: parsed.contract,
      governedBodyDigest: parsed.digest,
      readiness,
    });
  }
  if (violations.length > 0)
    return authorizationResult("ready", violations, {
      contract: parsed.contract,
      governedBodyDigest: parsed.digest,
      readiness,
    });
  const repository = normalized.repository as ImplementationRepositoryIdentity;
  const base = normalized.base as ImplementationBaseEvidence;
  const implementation = normalized.implementation as IssueReference;
  const record: ImplementationAuthorizationRecord = cloneImmutable({
    version: IMPLEMENTATION_AUTHORIZATION_VERSION,
    kind: IMPLEMENTATION_AUTHORIZATION_KIND,
    implementation,
    contractVersion: IMPLEMENTATION_CONTRACT_VERSION,
    repository,
    base,
    governedBodyDigest: parsed.digest,
    ...(nowIso(value.authorizedAt) === undefined ? {} : { authorizedAt: nowIso(value.authorizedAt) }),
  });
  return authorizationResult("authorized", [], {
    authorization: record,
    contract: parsed.contract,
    governedBodyDigest: parsed.digest,
    readiness,
  });
}

/** Throwing authorization entry point for callers that require an admitted record. */
export function authorizeImplementation(input: unknown): ImplementationAuthorizationRecord {
  const result = tryAuthorizeImplementation(input);
  if (!result.valid || result.authorization === undefined)
    throw new ImplementationAuthorizationError(result.violations);
  return result.authorization;
}

/** Alias emphasizing that the returned record is evidence, not persistent state. */
export const createImplementationAuthorizationRecord = authorizeImplementation;

export function validateImplementationAuthorizationRecord(input: unknown): {
  readonly valid: boolean;
  readonly record?: ImplementationAuthorizationRecord;
  readonly violations: readonly ImplementationAuthorizationViolation[];
} {
  const normalized = normalizeAuthorizationRecord(input);
  return {
    valid: normalized.violations.length === 0,
    record: normalized.record,
    violations: Object.freeze([...normalized.violations]),
  };
}

export function canonicalImplementationAuthorizationRecord(input: unknown): string {
  const validation = validateImplementationAuthorizationRecord(input);
  if (!validation.valid || validation.record === undefined)
    throw new ImplementationAuthorizationError(validation.violations);
  return canonicalJsonString(validation.record as unknown as CanonicalJsonValue);
}

export function serializeImplementationAuthorization(input: unknown): string {
  return canonicalImplementationAuthorizationRecord(input);
}

export function deserializeImplementationAuthorization(input: string): ImplementationAuthorizationRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.endsWith("\n") ? input.slice(0, -1) : input) as unknown;
  } catch {
    throw new ImplementationAuthorizationError([
      {
        code: "IMPLEMENTATION_AUTHORIZATION_RECORD_INVALID",
        path: "$",
        message: "Authorization record JSON is invalid.",
      },
    ]);
  }
  const record = validateImplementationAuthorizationRecord(parsed);
  if (!record.valid || record.record === undefined) throw new ImplementationAuthorizationError(record.violations);
  const source = input.endsWith("\n") ? input.slice(0, -1) : input;
  if (canonicalImplementationAuthorizationRecord(record.record) !== source)
    throw new ImplementationAuthorizationError([
      {
        code: "IMPLEMENTATION_AUTHORIZATION_RECORD_NONCANONICAL",
        path: "$",
        message: "Authorization record JSON is not canonical.",
      },
    ]);
  return record.record;
}

/**
 * Verify current authoritative evidence against one immutable authorization.
 * Metadata is intentionally not accepted as a comparison input: title,
 * labels, assignees, comments, and project state cannot invalidate it.
 */
export function tryVerifyImplementationAuthorization(input: unknown): ImplementationAuthorizationInspectionResult {
  const normalizedInput = validateAuthorizationInput(input, true);
  const violations = [...normalizedInput.violations];
  const value = normalizedInput.input as ImplementationAuthorizationVerificationInput | undefined;
  const recordResult =
    value === undefined ? { record: undefined, violations: [] } : normalizeAuthorizationRecord(value.authorization);
  violations.push(...recordResult.violations);
  if (recordResult.record === undefined || normalizedInput.body === undefined)
    return { ...authorizationResult("invalidated", violations), authorized: false, current: false };
  const record = recordResult.record;
  const parsed = contractBody(normalizedInput.body, violations);
  if (parsed.contract === undefined || parsed.digest === undefined)
    return {
      ...authorizationResult("invalidated", violations, { authorization: record }),
      authorized: false,
      current: false,
    };
  const readiness =
    value?.readiness === undefined
      ? undefined
      : readinessAdmission(parsed.contract, normalizedInput.implementation, value.readiness);
  if (readiness !== undefined) appendReadinessViolation(readiness, violations);
  if (normalizedInput.implementation === undefined)
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_INPUT_INVALID",
      "$.implementation",
      "Implementation Issue identity is required.",
    );
  recordBindingDrift(
    record,
    normalizedInput.implementation,
    normalizedInput.repository,
    normalizedInput.base,
    violations,
  );
  if (record.governedBodyDigest !== parsed.digest)
    addViolation(
      violations,
      "IMPLEMENTATION_MODIFIED_AFTER_AUTHORIZATION",
      "$.body",
      "The governed Implementation body changed after authorization.",
      record.governedBodyDigest,
      parsed.digest,
    );
  const supersession = normalizeSupersession(value?.supersession, normalizedInput.implementation, violations);
  const isSuperseded = (supersession?.supersededBy?.length ?? 0) > 0;
  if (isSuperseded)
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_SUPERSEDED",
      "$.supersession.supersededBy",
      "A newer Implementation supersedes this authorization.",
    );
  if (value?.completed === true && !isSuperseded)
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_COMPLETION_INVALID",
      "$.completed",
      "Completion cannot be supplied as an authorization assertion; it requires authoritative conformance and execution evidence.",
    );
  if (violations.length > 0)
    return {
      ...authorizationResult(isSuperseded ? "superseded" : "invalidated", violations, {
        authorization: record,
        contract: parsed.contract,
        governedBodyDigest: parsed.digest,
        ...(readiness === undefined ? {} : { readiness }),
      }),
      authorized: false,
      current: false,
    };
  return {
    ...authorizationResult("authorized", [], {
      authorization: record,
      contract: parsed.contract,
      governedBodyDigest: parsed.digest,
      ...(readiness === undefined ? {} : { readiness }),
    }),
    authorized: true,
    current: true,
  };
}

export function verifyImplementationAuthorization(input: unknown): ImplementationAuthorizationInspectionResult {
  return tryVerifyImplementationAuthorization(input);
}

/** Lifecycle projection for a draft/ready body before an authorization exists. */
export function inspectImplementationLifecycle(input: unknown): ImplementationAuthorizationInspectionResult {
  if (!isRecord(input) || !hasOwn(input, "authorization")) {
    const normalized = validateAuthorizationInput(input, true);
    const violations = [...normalized.violations];
    if (normalized.body === undefined)
      return { ...authorizationResult("draft", violations), authorized: false, current: false };
    const parsed = contractBody(normalized.body, violations);
    if (parsed.contract === undefined || parsed.digest === undefined)
      return { ...authorizationResult("draft", violations), authorized: false, current: false };
    return {
      ...authorizationResult("ready", violations, { contract: parsed.contract, governedBodyDigest: parsed.digest }),
      authorized: false,
      current: false,
    };
  }
  return tryVerifyImplementationAuthorization(input);
}

/** Explicitly validate a replacement relationship without mutating either Issue. */
export function validateImplementationSupersession(input: unknown): {
  readonly valid: boolean;
  readonly supersession?: ImplementationSupersessionEvidence;
  readonly violations: readonly ImplementationAuthorizationViolation[];
} {
  const violations: ImplementationAuthorizationViolation[] = [];
  if (!isRecord(input)) {
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_SUPERSESSION_INVALID",
      "$",
      "Supersession input must be an object.",
    );
    return { valid: false, violations };
  }
  const replacement = normalizeReference(input.replacement, "$.replacement", violations);
  const supersession = normalizeSupersession(input.supersession, replacement, violations);
  if (supersession === undefined || (supersession.supersedes?.length ?? 0) === 0)
    addViolation(
      violations,
      "IMPLEMENTATION_AUTHORIZATION_SUPERSESSION_INVALID",
      "$.supersession.supersedes",
      "A replacement must explicitly supersede at least one prior Implementation.",
    );
  return {
    valid: violations.length === 0,
    ...(supersession === undefined ? {} : { supersession }),
    violations: Object.freeze(violations),
  };
}

export const implementationBodyDigest = implementationIssueBodyDigest;
export { implementationIssueBodyDigest };
export const canonicalizeImplementationBody = canonicalizeImplementationIssueBody;
export const tryVerifyImplementation = tryVerifyImplementationAuthorization;
export const verifyImplementation = verifyImplementationAuthorization;
