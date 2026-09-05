/**
 * The transport-independent semantic contract for a governed Change.
 *
 * This module owns transport-independent Change data, validation, canonical
 * serialization, and pure canonical branch identity derivation. It does not
 * read or mutate GitHub state or plan transitions.
 */

import { deriveBranchName } from "../branch-naming-authority.mjs";

import {
  issueReferenceKey,
  normalizeIssueReference,
  type IssueDependencyViolationCode,
} from "./contract/issue-reference.js";
import type { PullRequestBranchGovernance } from "./contract/ir.js";
import { parsePullRequestPolicyOverlay } from "./pr-policy.js";

export const CHANGE_CONTRACT_VERSION = 1 as const;
export type ChangeContractVersion = typeof CHANGE_CONTRACT_VERSION;

export const CHANGE_STATES = Object.freeze([
  "DEFINED",
  "DRAFT",
  "REVIEW",
  "ACCEPTED",
  "MERGED",
  "ABORTED",
  "RECOVERY_REQUIRED",
] as const);
export type ChangeState = (typeof CHANGE_STATES)[number];

export const CHANGE_PROVENANCE_ROLES = Object.freeze([
  "requester",
  "issuer",
  "implementer",
  "reviewer",
  "merger",
] as const);
export type ChangeProvenanceRole = (typeof CHANGE_PROVENANCE_ROLES)[number];

/** Boundaries keep machine-readable failures safe to return to callers. */
export const MAX_CHANGE_DIAGNOSTICS = 32 as const;
export const MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH = 240 as const;
export const MAX_CHANGE_DIAGNOSTIC_PATH_LENGTH = 160 as const;
export const MAX_CHANGE_PRINCIPAL_LENGTH = 160 as const;
export const MAX_CHANGE_BRANCH_LENGTH = 255 as const;
export const MAX_CHANGE_HOST_LENGTH = 255 as const;

export interface CanonicalBranchNamingInput {
  /** Repository-governed branch classification, not a complete branch name. */
  readonly type: string;
  /** Repository-governed, grammar-compatible branch slug. */
  readonly slug: string;
}

/** Stable repository identity plus the root Issue number. */
export interface ChangeIdentity {
  /** Normalized GitHub host/install boundary. */
  readonly repositoryHost: string;
  /** Decimal repository database identity within repositoryHost. */
  readonly repositoryId: string;
  /** The Issue that gives this Change its semantic identity. */
  readonly rootIssue: number;
}

/**
 * Role values are opaque caller identities, not GitHub credentials.  The
 * role-specific properties are deliberately separate: one actor may appear
 * in more than one role, but the contract never collapses those authorities.
 */
export interface ChangeProvenance {
  readonly requester?: string;
  readonly issuer?: string;
  readonly implementer?: string;
  readonly reviewer?: string;
  readonly merger?: string;
}

/** Semantic projections retained when they are known; no GitHub API shape. */
export interface ChangeProjection {
  /** Canonical remote branch identity, when issued or historically known. */
  readonly branch?: string;
  /** Canonical pull-request number, when issued or historically known. */
  readonly pullRequest?: number;
}

export interface Change {
  readonly version: ChangeContractVersion;
  readonly identity: ChangeIdentity;
  readonly state: ChangeState;
  readonly provenance: ChangeProvenance;
  readonly projection?: ChangeProjection;
}

export type ChangeDiagnosticCode =
  | "CHANGE_INVALID_JSON"
  | "CHANGE_INVALID_ROOT"
  | "CHANGE_MISSING_PROPERTY"
  | "CHANGE_UNKNOWN_PROPERTY"
  | "CHANGE_UNSUPPORTED_VERSION"
  | "CHANGE_INVALID_IDENTITY"
  | "CHANGE_INVALID_STATE"
  | "CHANGE_INVALID_PROVENANCE"
  | "CHANGE_INVALID_PROJECTION"
  | "CHANGE_INVALID_BRANCH_INPUT"
  | "CHANGE_INVALID_BRANCH_GOVERNANCE"
  | "CHANGE_BRANCH_GOVERNANCE_MISMATCH";

export interface ChangeDiagnosticInput {
  readonly code: ChangeDiagnosticCode;
  readonly path?: string;
  readonly message: string;
}

export interface ChangeDiagnostic {
  readonly version: ChangeContractVersion;
  readonly code: ChangeDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface ChangeDiagnosticReport {
  readonly version: ChangeContractVersion;
  readonly diagnostics: readonly ChangeDiagnostic[];
}

export interface ChangeValidationResult {
  readonly valid: boolean;
  /** Present only when the complete input is valid and canonicalized. */
  readonly change?: Change;
  readonly diagnostics: readonly ChangeDiagnostic[];
}

export interface ChangeIdentityValidationResult {
  readonly valid: boolean;
  readonly identity?: ChangeIdentity;
  readonly diagnostics: readonly ChangeDiagnostic[];
}

export interface ChangeProvenanceValidationResult {
  readonly valid: boolean;
  readonly provenance?: ChangeProvenance;
  readonly diagnostics: readonly ChangeDiagnostic[];
}

export interface ChangeProjectionValidationResult {
  readonly valid: boolean;
  readonly projection?: ChangeProjection;
  readonly diagnostics: readonly ChangeDiagnostic[];
}

export interface CanonicalBranchIdentityDerivationInput {
  readonly change: Change | ChangeIdentity;
  readonly branchGovernance: PullRequestBranchGovernance;
  readonly naming: CanonicalBranchNamingInput;
}

export interface CanonicalBranchIdentityDerivationResult {
  readonly valid: boolean;
  readonly branch?: string;
  readonly diagnostics: readonly ChangeDiagnostic[];
}

const DIAGNOSTIC_CODES: readonly ChangeDiagnosticCode[] = [
  "CHANGE_INVALID_JSON",
  "CHANGE_INVALID_ROOT",
  "CHANGE_MISSING_PROPERTY",
  "CHANGE_UNKNOWN_PROPERTY",
  "CHANGE_UNSUPPORTED_VERSION",
  "CHANGE_INVALID_IDENTITY",
  "CHANGE_INVALID_STATE",
  "CHANGE_INVALID_PROVENANCE",
  "CHANGE_INVALID_PROJECTION",
  "CHANGE_INVALID_BRANCH_INPUT",
  "CHANGE_INVALID_BRANCH_GOVERNANCE",
  "CHANGE_BRANCH_GOVERNANCE_MISMATCH",
];

const CHANGE_KEYS = new Set(["version", "identity", "state", "provenance", "projection"]);
const IDENTITY_KEYS = new Set(["repositoryHost", "repositoryId", "rootIssue"]);
const PROVENANCE_KEYS = new Set(CHANGE_PROVENANCE_ROLES);
const PROJECTION_KEYS = new Set(["branch", "pullRequest"]);
const CANONICAL_BRANCH_DERIVATION_KEYS = new Set(["change", "branchGovernance", "naming"]);
const BRANCH_NAMING_KEYS = new Set(["type", "slug"]);

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedText(value: string, maxLength: number): string {
  if (value.length > maxLength) throw new RangeError(`Change text exceeds its ${maxLength}-character bound.`);
  return value;
}

function safeText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function safePath(path: string): string {
  return safeText(path, MAX_CHANGE_DIAGNOSTIC_PATH_LENGTH);
}

function safeMessage(message: string): string {
  return safeText(message, MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH);
}

function addDiagnostic(
  diagnostics: ChangeDiagnostic[],
  code: ChangeDiagnosticCode,
  path: string,
  message: string,
): void {
  if (diagnostics.length >= MAX_CHANGE_DIAGNOSTICS) return;
  diagnostics.push(
    createChangeDiagnostic({
      code,
      path: safePath(path),
      message: safeMessage(message),
    }),
  );
}

function addUnknownProperties(
  record: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: ChangeDiagnostic[],
): void {
  for (const key of Object.keys(record).sort(compareText)) {
    if (!allowed.has(key)) {
      addDiagnostic(diagnostics, "CHANGE_UNKNOWN_PROPERTY", `${path}.${key}`, "Property is not supported.");
    }
  }
}

function canonicalizeDiagnostic(diagnostic: ChangeDiagnostic): ChangeDiagnostic {
  if (diagnostic.version !== CHANGE_CONTRACT_VERSION) {
    throw new TypeError("Change diagnostic has an unsupported version.");
  }
  if (!DIAGNOSTIC_CODES.includes(diagnostic.code)) {
    throw new TypeError("Change diagnostic has an unsupported code.");
  }
  return {
    version: CHANGE_CONTRACT_VERSION,
    code: diagnostic.code,
    path: boundedText(diagnostic.path, MAX_CHANGE_DIAGNOSTIC_PATH_LENGTH),
    message: boundedText(diagnostic.message, MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH),
  };
}

function compareDiagnostics(left: ChangeDiagnostic, right: ChangeDiagnostic): number {
  return (
    compareText(left.path, right.path) || compareText(left.code, right.code) || compareText(left.message, right.message)
  );
}

/** Create one bounded, versioned machine-readable diagnostic. */
export function createChangeDiagnostic(input: ChangeDiagnosticInput): ChangeDiagnostic {
  if (!DIAGNOSTIC_CODES.includes(input.code)) throw new TypeError(`Unsupported Change diagnostic code: ${input.code}.`);
  if (input.message.length === 0) throw new TypeError("Change diagnostic messages cannot be empty.");
  const path = input.path ?? "$";
  if (path.length === 0) throw new TypeError("Change diagnostic paths cannot be empty.");
  return {
    version: CHANGE_CONTRACT_VERSION,
    code: input.code,
    path: boundedText(path, MAX_CHANGE_DIAGNOSTIC_PATH_LENGTH),
    message: boundedText(input.message, MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH),
  };
}

/** Sort and bound a diagnostic set for deterministic machine consumption. */
export function createChangeDiagnosticReport(diagnostics: readonly ChangeDiagnostic[]): ChangeDiagnosticReport {
  if (diagnostics.length > MAX_CHANGE_DIAGNOSTICS) {
    throw new RangeError(`At most ${MAX_CHANGE_DIAGNOSTICS} Change diagnostics are supported.`);
  }
  return {
    version: CHANGE_CONTRACT_VERSION,
    diagnostics: diagnostics.map(canonicalizeDiagnostic).sort(compareDiagnostics),
  };
}

export function serializeChangeDiagnosticReport(report: ChangeDiagnosticReport): string {
  if (report.version !== CHANGE_CONTRACT_VERSION) {
    throw new TypeError("Change diagnostic report has an unsupported version.");
  }
  return JSON.stringify(createChangeDiagnosticReport(report.diagnostics));
}

export function deserializeChangeDiagnosticReport(serialized: string): ChangeDiagnosticReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new TypeError(
      `Change diagnostics must be valid JSON: ${safeMessage(error instanceof Error ? error.message : String(error))}`,
    );
  }
  if (!isRecord(parsed)) throw new TypeError("Change diagnostics must be a JSON object.");
  if (Object.keys(parsed).some((key) => key !== "version" && key !== "diagnostics")) {
    throw new TypeError("Change diagnostics contain an unknown property.");
  }
  if (parsed.version !== CHANGE_CONTRACT_VERSION) {
    throw new TypeError(`Unsupported Change diagnostics version: ${String(parsed.version)}.`);
  }
  if (!Array.isArray(parsed.diagnostics) || !parsed.diagnostics.every(isDiagnostic)) {
    throw new TypeError("Change diagnostics must contain a valid diagnostics array.");
  }
  return createChangeDiagnosticReport(parsed.diagnostics);
}

function isDiagnostic(value: unknown): value is ChangeDiagnostic {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).every((key) => key === "version" || key === "code" || key === "path" || key === "message") &&
    value.version === CHANGE_CONTRACT_VERSION &&
    typeof value.code === "string" &&
    DIAGNOSTIC_CODES.includes(value.code as ChangeDiagnosticCode) &&
    typeof value.path === "string" &&
    typeof value.message === "string"
  );
}

function identityDiagnosticPath(path: string, sourcePath: string): string {
  return sourcePath === `${path}.number` ? `${path}.rootIssue` : sourcePath;
}

function identityMessage(code: IssueDependencyViolationCode): string {
  switch (code) {
    case "REFERENCE_REPOSITORY_HOST_INVALID":
      return "repositoryHost must be a valid non-empty host without whitespace or path separators.";
    case "REFERENCE_REPOSITORY_ID_INVALID":
      return "repositoryId must be a positive decimal repository identity.";
    case "REFERENCE_NUMBER_INVALID":
      return "rootIssue must be a positive safe integer.";
    default:
      return "Change identity is invalid.";
  }
}

/** Validate and canonicalize the repository/root-Issue identity. */
export function validateChangeIdentity(input: unknown, path = "$"): ChangeIdentityValidationResult {
  const diagnostics: ChangeDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_IDENTITY", path, "Change identity must be an object.");
    return { valid: false, diagnostics };
  }
  addUnknownProperties(input, IDENTITY_KEYS, path, diagnostics);

  const host = input.repositoryHost;
  if (typeof host === "string" && host.length > MAX_CHANGE_HOST_LENGTH) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_IDENTITY",
      `${path}.repositoryHost`,
      "repositoryHost exceeds its bound.",
    );
  }

  const reference = normalizeIssueReference(
    {
      repositoryHost: input.repositoryHost,
      repositoryId: input.repositoryId,
      number: input.rootIssue,
    },
    path,
  );
  for (const violation of reference.violations) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_IDENTITY",
      identityDiagnosticPath(path, violation.path),
      identityMessage(violation.code),
    );
  }
  if (diagnostics.length > 0 || !reference.valid || reference.reference === undefined) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  return {
    valid: true,
    identity: {
      repositoryHost: reference.reference.repositoryHost,
      repositoryId: reference.reference.repositoryId,
      rootIssue: reference.reference.number,
    },
    diagnostics: [],
  };
}

export const normalizeChangeIdentity = validateChangeIdentity;
export const projectChangeIdentity = validateChangeIdentity;

function validateCanonicalBranchChangeIdentity(
  input: unknown,
  diagnostics: ChangeDiagnostic[],
): ChangeIdentity | undefined {
  if (isRecord(input) && hasOwn(input, "identity")) {
    const result = validateChange(input);
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    return result.change?.identity;
  }
  const result = validateChangeIdentity(input, "$.change");
  diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
  return result.identity;
}

function branchGovernanceDiagnosticPath(error: unknown): string {
  if (error instanceof Error && "path" in error && typeof error.path === "string") {
    return error.path.replace(/^\$\.branch/u, "$.branchGovernance");
  }
  return "$.branchGovernance";
}

function validateCanonicalBranchGovernance(
  input: unknown,
  diagnostics: ChangeDiagnostic[],
): PullRequestBranchGovernance | undefined {
  if (!isRecord(input)) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_BRANCH_GOVERNANCE",
      "$.branchGovernance",
      "Branch governance must be an object.",
    );
    return undefined;
  }
  try {
    const parsed = parsePullRequestPolicyOverlay(JSON.stringify({ version: 1, sections: [], branch: input }));
    if (parsed.branch === undefined) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_BRANCH_GOVERNANCE",
        "$.branchGovernance",
        "Branch governance must declare a pattern.",
      );
      return undefined;
    }
    return parsed.branch;
  } catch (error: unknown) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_BRANCH_GOVERNANCE",
      branchGovernanceDiagnosticPath(error),
      `Branch governance is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function validateCanonicalBranchNaming(
  input: unknown,
  diagnostics: ChangeDiagnostic[],
): CanonicalBranchNamingInput | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_BRANCH_INPUT", "$.naming", "Branch naming input must be an object.");
    return undefined;
  }
  addUnknownProperties(input, BRANCH_NAMING_KEYS, "$.naming", diagnostics);
  const type = input.type;
  const slug = input.slug;
  if (!hasOwn(input, "type")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.naming.type", "Property is required.");
  } else if (typeof type !== "string" || type.length === 0 || /[\u0000-\u001F\u007F]/u.test(type)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_BRANCH_INPUT", "$.naming.type", "Branch type is invalid.");
  }
  if (!hasOwn(input, "slug")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.naming.slug", "Property is required.");
  } else if (typeof slug !== "string" || slug.length === 0 || /[\u0000-\u001F\u007F]/u.test(slug)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_BRANCH_INPUT", "$.naming.slug", "Branch slug is invalid.");
  }
  if (diagnostics.some((diagnostic) => diagnostic.path === "$.naming.type" || diagnostic.path === "$.naming.slug")) {
    return undefined;
  }
  return { type: type as string, slug: slug as string };
}

/**
 * Derive one canonical branch identity from a validated Change identity,
 * repository branch governance, and governance-resolved naming parts.
 *
 * The branch grammar is owned by the shared branch authority. This function
 * only supplies the Change Issue number, verifies the repository policy, and
 * returns a pure projection; it never creates or updates a Git ref.
 */
export function deriveCanonicalBranchIdentity(input: unknown): CanonicalBranchIdentityDerivationResult {
  const diagnostics: ChangeDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_BRANCH_INPUT",
      "$",
      "Canonical branch derivation input must be an object.",
    );
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  addUnknownProperties(input, CANONICAL_BRANCH_DERIVATION_KEYS, "$", diagnostics);

  let identity: ChangeIdentity | undefined;
  if (!hasOwn(input, "change")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.change", "Property is required.");
  } else {
    identity = validateCanonicalBranchChangeIdentity(input.change, diagnostics);
  }

  let governance: PullRequestBranchGovernance | undefined;
  if (!hasOwn(input, "branchGovernance")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.branchGovernance", "Property is required.");
  } else {
    governance = validateCanonicalBranchGovernance(input.branchGovernance, diagnostics);
  }

  let naming: CanonicalBranchNamingInput | undefined;
  if (!hasOwn(input, "naming")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.naming", "Property is required.");
  } else {
    naming = validateCanonicalBranchNaming(input.naming, diagnostics);
  }

  if (diagnostics.length > 0 || identity === undefined || governance === undefined || naming === undefined) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }

  let branch: string;
  try {
    branch = deriveBranchName({ type: naming.type, issueNumber: identity.rootIssue, slug: naming.slug });
  } catch (error: unknown) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_BRANCH_INPUT",
      "$.naming",
      error instanceof Error ? error.message : String(error),
    );
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  if (branch.length > MAX_CHANGE_BRANCH_LENGTH) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_BRANCH_INPUT",
      "$.naming",
      `Derived branch exceeds its ${MAX_CHANGE_BRANCH_LENGTH}-character bound.`,
    );
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }

  let pattern: RegExp;
  try {
    pattern = new RegExp(governance.pattern, "u");
  } catch (error: unknown) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_BRANCH_GOVERNANCE",
      "$.branchGovernance.pattern",
      `Branch governance is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  if (!pattern.test(branch)) {
    addDiagnostic(
      diagnostics,
      "CHANGE_BRANCH_GOVERNANCE_MISMATCH",
      "$.branchGovernance.pattern",
      `Derived branch "${branch}" does not satisfy the repository's branch governance.`,
    );
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  return { valid: true, branch, diagnostics: [] };
}

/** Stable identity key; locator changes cannot create a second Change. */
export function changeIdentityKey(input: ChangeIdentity): string {
  const result = validateChangeIdentity(input);
  if (!result.valid || result.identity === undefined) throw new ChangeValidationError(result.diagnostics);
  return issueReferenceKey({
    repositoryHost: result.identity.repositoryHost,
    repositoryId: result.identity.repositoryId,
    number: result.identity.rootIssue,
  });
}

/** Validate the five provenance roles without imposing transition policy. */
export function validateChangeProvenance(input: unknown, path = "$"): ChangeProvenanceValidationResult {
  const diagnostics: ChangeDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PROVENANCE", path, "Change provenance must be an object.");
    return { valid: false, diagnostics };
  }
  addUnknownProperties(input, PROVENANCE_KEYS, path, diagnostics);
  const provenance: Partial<Record<ChangeProvenanceRole, string>> = {};
  for (const role of CHANGE_PROVENANCE_ROLES) {
    if (!hasOwn(input, role)) continue;
    const value = input[role];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.trim().length === 0 ||
      value.length > MAX_CHANGE_PRINCIPAL_LENGTH ||
      /[\u0000-\u001F\u007F]/u.test(value)
    ) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_PROVENANCE",
        `${path}.${role}`,
        "Provenance role identity is invalid.",
      );
      continue;
    }
    provenance[role] = value;
  }
  if (diagnostics.length > 0) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  return { valid: true, provenance, diagnostics: [] };
}

/** Validate semantic branch/PR projection fields without naming-policy logic. */
export function validateChangeProjection(input: unknown, path = "$"): ChangeProjectionValidationResult {
  const diagnostics: ChangeDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PROJECTION", path, "Change projection must be an object.");
    return { valid: false, diagnostics };
  }
  addUnknownProperties(input, PROJECTION_KEYS, path, diagnostics);
  const projection: ChangeProjection = {};
  let branch: string | undefined;
  let pullRequest: number | undefined;
  if (hasOwn(input, "branch")) {
    if (
      typeof input.branch !== "string" ||
      input.branch.length === 0 ||
      input.branch.length > MAX_CHANGE_BRANCH_LENGTH ||
      /[\u0000-\u001F\u007F]/u.test(input.branch)
    ) {
      addDiagnostic(diagnostics, "CHANGE_INVALID_PROJECTION", `${path}.branch`, "Change branch identity is invalid.");
    } else {
      branch = input.branch;
    }
  }
  if (hasOwn(input, "pullRequest")) {
    if (typeof input.pullRequest !== "number" || !Number.isSafeInteger(input.pullRequest) || input.pullRequest < 1) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_PROJECTION",
        `${path}.pullRequest`,
        "pullRequest must be a positive safe integer.",
      );
    } else {
      pullRequest = input.pullRequest;
    }
  }
  if (diagnostics.length > 0) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  if (branch !== undefined) (projection as { branch: string }).branch = branch;
  if (pullRequest !== undefined) (projection as { pullRequest: number }).pullRequest = pullRequest;
  return { valid: true, projection, diagnostics: [] };
}

/** Validate and canonicalize one complete Change snapshot. */
export function validateChange(input: unknown): ChangeValidationResult {
  const diagnostics: ChangeDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Change contract must be a JSON object.");
    return { valid: false, diagnostics };
  }
  addUnknownProperties(input, CHANGE_KEYS, "$", diagnostics);

  if (!hasOwn(input, "version")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.version", "Property is required.");
  } else if (input.version !== CHANGE_CONTRACT_VERSION) {
    addDiagnostic(diagnostics, "CHANGE_UNSUPPORTED_VERSION", "$.version", "Change contract version is unsupported.");
  }

  let identity: ChangeIdentity | undefined;
  if (!hasOwn(input, "identity")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.identity", "Property is required.");
  } else {
    const result = validateChangeIdentity(input.identity, "$.identity");
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    identity = result.identity;
  }

  let state: ChangeState | undefined;
  if (!hasOwn(input, "state")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.state", "Property is required.");
  } else if (typeof input.state !== "string" || !CHANGE_STATES.includes(input.state as ChangeState)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_STATE", "$.state", "Change lifecycle state is unsupported.");
  } else {
    state = input.state as ChangeState;
  }

  let provenance: ChangeProvenance | undefined;
  if (!hasOwn(input, "provenance")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.provenance", "Property is required.");
  } else {
    const result = validateChangeProvenance(input.provenance, "$.provenance");
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    provenance = result.provenance;
  }

  let projection: ChangeProjection | undefined;
  if (hasOwn(input, "projection")) {
    const result = validateChangeProjection(input.projection, "$.projection");
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    projection = result.projection;
  }

  const normalizedDiagnostics = createChangeDiagnosticReport(diagnostics).diagnostics;
  if (normalizedDiagnostics.length > 0 || identity === undefined || state === undefined || provenance === undefined) {
    return { valid: false, diagnostics: normalizedDiagnostics };
  }
  return {
    valid: true,
    change: {
      version: CHANGE_CONTRACT_VERSION,
      identity,
      state,
      provenance,
      ...(projection === undefined ? {} : { projection }),
    },
    diagnostics: [],
  };
}

export const normalizeChange = validateChange;
export const projectChange = validateChange;

export function isChange(input: unknown): input is Change {
  return validateChange(input).valid;
}

export class ChangeValidationError extends Error {
  readonly code: ChangeDiagnosticCode;
  readonly path: string;
  readonly diagnostics: readonly ChangeDiagnostic[];

  constructor(diagnostics: readonly ChangeDiagnostic[]) {
    const report = createChangeDiagnosticReport(diagnostics);
    const first = report.diagnostics[0];
    if (first === undefined) throw new Error("Change validation errors require at least one diagnostic.");
    super(report.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n"));
    this.name = "ChangeValidationError";
    this.code = first.code;
    this.path = first.path;
    this.diagnostics = report.diagnostics;
  }

  toJSON(): {
    code: ChangeDiagnosticCode;
    path: string;
    message: string;
    diagnostics: readonly ChangeDiagnostic[];
  } {
    return { code: this.code, path: this.path, message: this.message, diagnostics: this.diagnostics };
  }
}

export function assertChange(input: unknown): asserts input is Change {
  const result = validateChange(input);
  if (!result.valid) throw new ChangeValidationError(result.diagnostics);
}

/** Serialize the canonical representation, with stable property ordering. */
export function serializeChange(input: unknown): string {
  const result = validateChange(input);
  if (!result.valid || result.change === undefined) throw new ChangeValidationError(result.diagnostics);
  const serialized = JSON.stringify(result.change);
  if (serialized === undefined) throw new Error("Change contract could not be serialized.");
  return serialized;
}

/** Parse an untrusted JSON boundary and return the canonical Change value. */
export function deserializeChange(serialized: string): Change {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new ChangeValidationError([
      createChangeDiagnostic({
        code: "CHANGE_INVALID_JSON",
        message: safeMessage(
          `Change contract must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      }),
    ]);
  }
  const result = validateChange(parsed);
  if (!result.valid || result.change === undefined) throw new ChangeValidationError(result.diagnostics);
  return result.change;
}

export const parseChange = deserializeChange;
export const serializeChangeContract = serializeChange;
