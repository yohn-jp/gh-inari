/**
 * The transport-independent semantic contract for a governed Change.
 *
 * This module owns transport-independent Change data, validation, canonical
 * serialization, pure canonical branch identity derivation, the lifecycle
 * transition matrix, and pure effect planning. It does not read or mutate
 * GitHub state or execute effects.
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
export const MAX_CHANGE_IDEMPOTENCY_KEY_LENGTH = 512 as const;

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

/** Version of the transport-independent transition request and plan contract. */
export const CHANGE_TRANSITION_CONTRACT_VERSION = CHANGE_CONTRACT_VERSION;
export type ChangeTransitionContractVersion = typeof CHANGE_TRANSITION_CONTRACT_VERSION;

/**
 * `merge` is reserved for a future merge-coordination capability.  It is
 * represented in the request vocabulary but is intentionally not executable
 * by this planning contract yet.
 */
export const CHANGE_TRANSITION_OPERATIONS = Object.freeze(["issue", "ready", "abort", "merge"] as const);
export type ChangeTransition = (typeof CHANGE_TRANSITION_OPERATIONS)[number];
export type ChangeTransitionOperation = ChangeTransition;
export const CHANGE_TRANSITIONS = CHANGE_TRANSITION_OPERATIONS;
export const CHANGE_IMPLEMENTED_TRANSITIONS = Object.freeze(["issue", "ready", "abort"] as const);

/** The only lifecycle edges currently owned by Inari Core. */
export const CHANGE_TRANSITION_RULES = Object.freeze([
  { transition: "issue", from: "DEFINED", to: "DRAFT" },
  { transition: "ready", from: "DRAFT", to: "REVIEW" },
  { transition: "abort", from: "DRAFT", to: "ABORTED" },
  { transition: "abort", from: "REVIEW", to: "ABORTED" },
] as const);
export const CHANGE_TRANSITION_MATRIX = CHANGE_TRANSITION_RULES;

/**
 * Inputs resolved by Core's projection policy before a transition is
 * planned.  The target is data, not a transport or an adapter callback.
 */
export interface ChangeTransitionTarget {
  readonly branch?: string;
  readonly baseBranch?: string;
  readonly pullRequest?: number;
}

export interface ChangeTransitionRequest {
  readonly version: ChangeTransitionContractVersion;
  readonly transition: ChangeTransition;
  /** The current canonical Change snapshot. */
  readonly change: Change;
  /** Required for issue; may complete a partial projection for other edges. */
  readonly target?: ChangeTransitionTarget;
}

export const CHANGE_EFFECT_KINDS = Object.freeze([
  "CREATE_BRANCH",
  "CREATE_PULL_REQUEST",
  "MARK_PULL_REQUEST_READY",
  "CLOSE_PULL_REQUEST",
] as const);
export type ChangeEffectKind = (typeof CHANGE_EFFECT_KINDS)[number];

/**
 * Effects are declarative capabilities for a later executor.  They contain
 * no GitHub client, credential, workflow, or mutation implementation.
 */
export type ChangeEffect =
  | {
      readonly kind: "CREATE_BRANCH";
      readonly branch: string;
      readonly baseBranch: string;
    }
  | {
      readonly kind: "CREATE_PULL_REQUEST";
      readonly branch: string;
      readonly baseBranch: string;
      readonly rootIssue: number;
      readonly draft: true;
    }
  | {
      readonly kind: "MARK_PULL_REQUEST_READY";
      readonly pullRequest: number;
    }
  | {
      readonly kind: "CLOSE_PULL_REQUEST";
      readonly pullRequest: number;
    };

export interface ChangeTransitionPlan {
  readonly version: ChangeTransitionContractVersion;
  readonly request: ChangeTransitionRequest;
  readonly from: ChangeState;
  readonly to: ChangeState;
  /** The expected semantic snapshot after the declared effects succeed. */
  readonly result: Change;
  /** Effect order is semantic and must remain deterministic. */
  readonly effects: readonly ChangeEffect[];
}

export interface ChangeTransitionRequestValidationResult {
  readonly valid: boolean;
  readonly request?: ChangeTransitionRequest;
  readonly diagnostics: readonly ChangeDiagnostic[];
}

export type ChangeTransitionValidationResult = ChangeTransitionRequestValidationResult;

export interface ChangeTransitionPlanValidationResult {
  readonly valid: boolean;
  readonly plan?: ChangeTransitionPlan;
  readonly diagnostics: readonly ChangeDiagnostic[];
}

export interface ChangeEffectValidationResult {
  readonly valid: boolean;
  readonly effect?: ChangeEffect;
  readonly diagnostics: readonly ChangeDiagnostic[];
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
  | "CHANGE_BRANCH_GOVERNANCE_MISMATCH"
  | "CHANGE_INVALID_TRANSITION"
  | "CHANGE_UNSUPPORTED_TRANSITION"
  | "CHANGE_TRANSITION_NOT_ALLOWED"
  | "CHANGE_INVALID_TRANSITION_TARGET"
  | "CHANGE_INVALID_EFFECT"
  | "CHANGE_INVALID_PLAN"
  | "CHANGE_PROJECTION_INVALID_EVIDENCE"
  | "CHANGE_PROJECTION_EVIDENCE_MISSING"
  | "CHANGE_PROJECTION_EVIDENCE_UNAVAILABLE"
  | "CHANGE_PROJECTION_ISSUE_MISMATCH"
  | "CHANGE_PROJECTION_PARTIAL"
  | "CHANGE_PROJECTION_DUPLICATE"
  | "CHANGE_PROJECTION_WRONG_BASE"
  | "CHANGE_PROJECTION_AMBIGUOUS"
  | "CHANGE_PROJECTION_CONFLICT"
  | "CHANGE_ISSUANCE_ROOT_ISSUE_ABSENT";

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

export const CHANGE_PROJECTION_STATUSES = Object.freeze([
  "healthy",
  "absent",
  "partial",
  "duplicate",
  "wrong-base",
  "ambiguous",
  "unavailable",
] as const);
export type ChangeProjectionStatus = (typeof CHANGE_PROJECTION_STATUSES)[number];

export const CHANGE_PROJECTION_CANDIDATE_CLASSES = Object.freeze(["canonical", "noncanonical", "conflicting"] as const);
export type ChangeProjectionCandidateClass = (typeof CHANGE_PROJECTION_CANDIDATE_CLASSES)[number];

export const CHANGE_EVIDENCE_STATUSES = Object.freeze(["available", "absent", "unavailable"] as const);
export type ChangeEvidenceStatus = (typeof CHANGE_EVIDENCE_STATUSES)[number];

/** A read result distinguishes confirmed absence from an unavailable read. */
export type ChangeEvidenceSource<T> =
  | { readonly status: "available"; readonly value: T }
  | { readonly status: "absent" }
  | { readonly status: "unavailable"; readonly reason: string };

export type ChangeEvidence<T> = ChangeEvidenceSource<T>;

/** Minimal, normalized Issue evidence required by the pure projection. */
export interface ChangeIssueEvidence {
  readonly number: number;
  readonly state: "open" | "closed";
}

/** One bounded remote branch candidate. */
export interface ChangeBranchEvidence {
  readonly name: string;
}

/**
 * Minimal, normalized pull-request evidence. `merged` is optional only for
 * open PRs, where GitHub's open state is sufficient; a closed PR must carry
 * it so the projection never guesses merged versus aborted.
 */
export interface ChangePullRequestEvidence {
  readonly number: number;
  readonly head: string;
  readonly base: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly merged?: boolean;
  /** Optional governed merge-admission evidence for the ACCEPTED state. */
  readonly accepted?: boolean;
  /** Optional explicit root-Issue claim; branch identity remains authoritative. */
  readonly rootIssue?: number;
  readonly provenance?: ChangeProvenance;
}

/** Bounded evidence collected from GitHub; this type has no transport methods. */
export interface ChangeGitHubEvidence {
  readonly issue?: ChangeEvidenceSource<ChangeIssueEvidence>;
  readonly branches?: ChangeEvidenceSource<readonly ChangeBranchEvidence[]>;
  readonly pullRequests?: ChangeEvidenceSource<readonly ChangePullRequestEvidence[]>;
}

export type ChangeProjectionEvidence = ChangeGitHubEvidence;

export interface ChangeProjectionInput {
  /** A Change snapshot or identity; its existing state is never trusted. */
  readonly change: Change | ChangeIdentity;
  /** Existing repository branch policy consumed by #211's authority. */
  readonly branchGovernance: PullRequestBranchGovernance;
  /** Existing governance-resolved branch naming parts consumed by #211. */
  readonly naming: CanonicalBranchNamingInput;
  /** Repository-governed target base branch. */
  readonly baseBranch: string;
  readonly evidence: ChangeGitHubEvidence;
  /** Optional known provenance when projecting from an identity rather than a snapshot. */
  readonly provenance?: ChangeProvenance;
}

export interface ChangeProjectionCandidate<T> {
  readonly candidate: T;
  readonly classification: ChangeProjectionCandidateClass;
  readonly reason: string;
}

export interface ChangeProjectionCandidates {
  readonly branches: readonly ChangeProjectionCandidate<ChangeBranchEvidence>[];
  readonly pullRequests: readonly ChangeProjectionCandidate<ChangePullRequestEvidence>[];
}

export interface ChangeProjectionResult {
  readonly valid: boolean;
  readonly status: ChangeProjectionStatus;
  readonly canonicalBranch?: string;
  readonly canonicalBaseBranch?: string;
  readonly candidates: ChangeProjectionCandidates;
  /** Present for a healthy/defined projection or for explicit recovery drift. */
  readonly change?: Change;
  readonly diagnostics: readonly ChangeDiagnostic[];
}

/** The two idempotent issuance outcomes owned by Inari Core. */
export const CHANGE_ISSUANCE_MODES = Object.freeze(["create", "return-existing"] as const);
export type ChangeIssuanceMode = (typeof CHANGE_ISSUANCE_MODES)[number];

export const CHANGE_ISSUANCE_SOURCE_STATUSES = Object.freeze(["absent", "healthy"] as const);
export type ChangeIssuanceSourceStatus = (typeof CHANGE_ISSUANCE_SOURCE_STATUSES)[number];
export type ChangeIssuanceHealthyState = Exclude<ChangeState, "DEFINED" | "RECOVERY_REQUIRED">;

/** The transport-neutral identity of one logical issuance transaction. */
export interface ChangeIssuanceTransaction {
  readonly operation: "issue";
  readonly identity: ChangeIdentity;
  /** Stable identity-derived key; it is not a workflow or request identifier. */
  readonly idempotencyKey: string;
}

/**
 * Machine-readable evidence an executor must verify after applying effects.
 * A create plan cannot know the PR number in advance, so `number` is omitted
 * there while `required` remains explicit.
 */
export interface ChangeIssuanceVerificationExpectation {
  readonly phase: "post-effect";
  readonly status: "healthy";
  readonly canonicalBranch: string;
  readonly canonicalBaseBranch: string;
  readonly state: ChangeIssuanceHealthyState;
  readonly pullRequest: {
    readonly required: true;
    readonly number?: number;
  };
}

/** One logical, transport-independent Change issuance transaction. */
export interface ChangeIssuancePlan {
  readonly version: ChangeTransitionContractVersion;
  readonly operation: "issue";
  readonly mode: ChangeIssuanceMode;
  readonly sourceStatus: ChangeIssuanceSourceStatus;
  readonly transaction: ChangeIssuanceTransaction;
  /** Expected semantic Change after the declared effects or existing return. */
  readonly result: Change;
  /** Ordered effects for the one transaction; empty for return-existing. */
  readonly effects: readonly ChangeEffect[];
  readonly verification: ChangeIssuanceVerificationExpectation;
}

export interface ChangeIssuancePlanValidationResult {
  readonly valid: boolean;
  readonly plan?: ChangeIssuancePlan;
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
  "CHANGE_INVALID_TRANSITION",
  "CHANGE_UNSUPPORTED_TRANSITION",
  "CHANGE_TRANSITION_NOT_ALLOWED",
  "CHANGE_INVALID_TRANSITION_TARGET",
  "CHANGE_INVALID_EFFECT",
  "CHANGE_INVALID_PLAN",
  "CHANGE_PROJECTION_INVALID_EVIDENCE",
  "CHANGE_PROJECTION_EVIDENCE_MISSING",
  "CHANGE_PROJECTION_EVIDENCE_UNAVAILABLE",
  "CHANGE_PROJECTION_ISSUE_MISMATCH",
  "CHANGE_PROJECTION_PARTIAL",
  "CHANGE_PROJECTION_DUPLICATE",
  "CHANGE_PROJECTION_WRONG_BASE",
  "CHANGE_PROJECTION_AMBIGUOUS",
  "CHANGE_PROJECTION_CONFLICT",
  "CHANGE_ISSUANCE_ROOT_ISSUE_ABSENT",
];

const CHANGE_KEYS = new Set(["version", "identity", "state", "provenance", "projection"]);
const IDENTITY_KEYS = new Set(["repositoryHost", "repositoryId", "rootIssue"]);
const PROVENANCE_KEYS = new Set(CHANGE_PROVENANCE_ROLES);
const PROJECTION_KEYS = new Set(["branch", "pullRequest"]);
const CANONICAL_BRANCH_DERIVATION_KEYS = new Set(["change", "branchGovernance", "naming"]);
const BRANCH_NAMING_KEYS = new Set(["type", "slug"]);
const TRANSITION_REQUEST_KEYS = new Set(["version", "transition", "change", "target"]);
const TRANSITION_TARGET_KEYS = new Set(["branch", "baseBranch", "pullRequest"]);
const TRANSITION_PLAN_KEYS = new Set(["version", "request", "from", "to", "result", "effects"]);
const EFFECT_KEYS = new Set(["kind", "branch", "baseBranch", "rootIssue", "draft", "pullRequest"]);
const CHANGE_PROJECTION_INPUT_KEYS = new Set([
  "change",
  "branchGovernance",
  "naming",
  "baseBranch",
  "evidence",
  "provenance",
]);
const CHANGE_ISSUANCE_PLAN_KEYS = new Set([
  "version",
  "operation",
  "mode",
  "sourceStatus",
  "transaction",
  "result",
  "effects",
  "verification",
]);
const CHANGE_ISSUANCE_TRANSACTION_KEYS = new Set(["operation", "identity", "idempotencyKey"]);
const CHANGE_ISSUANCE_VERIFICATION_KEYS = new Set([
  "phase",
  "status",
  "canonicalBranch",
  "canonicalBaseBranch",
  "state",
  "pullRequest",
]);
const CHANGE_ISSUANCE_PULL_REQUEST_KEYS = new Set(["required", "number"]);
const CHANGE_GITHUB_EVIDENCE_KEYS = new Set(["issue", "branches", "pullRequests"]);
const CHANGE_EVIDENCE_AVAILABLE_KEYS = new Set(["status", "value"]);
const CHANGE_EVIDENCE_ABSENT_KEYS = new Set(["status"]);
const CHANGE_EVIDENCE_UNAVAILABLE_KEYS = new Set(["status", "reason"]);
const CHANGE_ISSUE_EVIDENCE_KEYS = new Set(["number", "state"]);
const CHANGE_BRANCH_EVIDENCE_KEYS = new Set(["name"]);
const CHANGE_PULL_REQUEST_EVIDENCE_KEYS = new Set([
  "number",
  "head",
  "base",
  "state",
  "draft",
  "merged",
  "accepted",
  "rootIssue",
  "provenance",
]);

export const MAX_CHANGE_BASE_BRANCH_LENGTH = MAX_CHANGE_BRANCH_LENGTH;
export const MAX_CHANGE_TRANSITION_EFFECTS = 8 as const;
export const MAX_CHANGE_PROJECTION_CANDIDATES = 64 as const;

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

interface ChangeProjectionEvidenceRead<T> {
  readonly status: "available" | "absent" | "unavailable";
  readonly value?: T;
}

type NormalizedChangePullRequestEvidence = Omit<ChangePullRequestEvidence, "merged"> & {
  readonly merged: boolean;
};

function projectionEvidenceUnavailableResult(
  diagnostics: ChangeDiagnostic[],
  canonicalBranch?: string,
  canonicalBaseBranch?: string,
): ChangeProjectionResult {
  return {
    valid: false,
    status: "unavailable",
    ...(canonicalBranch === undefined ? {} : { canonicalBranch }),
    ...(canonicalBaseBranch === undefined ? {} : { canonicalBaseBranch }),
    candidates: { branches: [], pullRequests: [] },
    diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics,
  };
}

function projectionText(
  value: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
  label: string,
  maxLength: number,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", path, `${label} is invalid.`);
    return undefined;
  }
  return value;
}

function projectionNumber(
  value: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
  label: string,
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", path, `${label} must be a positive safe integer.`);
    return undefined;
  }
  return value;
}

function readChangeProjectionEvidenceSource<T>(
  input: unknown,
  path: string,
  parseValue: (value: unknown, path: string, diagnostics: ChangeDiagnostic[]) => T | undefined,
  diagnostics: ChangeDiagnostic[],
): ChangeProjectionEvidenceRead<T> {
  if (input === undefined) {
    addDiagnostic(diagnostics, "CHANGE_PROJECTION_EVIDENCE_MISSING", path, "Evidence is required.");
    return { status: "unavailable" };
  }
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", path, "Evidence source must be an object.");
    return { status: "unavailable" };
  }
  const status = input.status;
  if (status === "absent") {
    addUnknownProperties(input, CHANGE_EVIDENCE_ABSENT_KEYS, path, diagnostics);
    return { status: "absent" };
  }
  if (status === "available") {
    addUnknownProperties(input, CHANGE_EVIDENCE_AVAILABLE_KEYS, path, diagnostics);
    if (!hasOwn(input, "value")) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROJECTION_EVIDENCE_MISSING",
        `${path}.value`,
        "Available evidence must contain a value.",
      );
      return { status: "unavailable" };
    }
    const value = parseValue(input.value, `${path}.value`, diagnostics);
    return value === undefined ? { status: "unavailable" } : { status: "available", value };
  }
  if (status === "unavailable") {
    addUnknownProperties(input, CHANGE_EVIDENCE_UNAVAILABLE_KEYS, path, diagnostics);
    if (!hasOwn(input, "reason")) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROJECTION_EVIDENCE_MISSING",
        `${path}.reason`,
        "Unavailable evidence must declare a reason.",
      );
      return { status: "unavailable" };
    }
    const reason = input.reason;
    if (
      typeof reason !== "string" ||
      reason.length === 0 ||
      reason.length > MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH ||
      /[\u0000-\u001F\u007F]/u.test(reason)
    ) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROJECTION_INVALID_EVIDENCE",
        `${path}.reason`,
        "Unavailable evidence reason is invalid.",
      );
      return { status: "unavailable" };
    }
    addDiagnostic(diagnostics, "CHANGE_PROJECTION_EVIDENCE_UNAVAILABLE", path, `Evidence is unavailable: ${reason}`);
    return { status: "unavailable" };
  }
  addDiagnostic(
    diagnostics,
    "CHANGE_PROJECTION_INVALID_EVIDENCE",
    `${path}.status`,
    "Evidence source status is unsupported.",
  );
  return { status: "unavailable" };
}

function parseChangeIssueEvidence(
  value: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): ChangeIssueEvidence | undefined {
  const before = diagnostics.length;
  if (!isRecord(value)) {
    addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", path, "Issue evidence must be an object.");
    return undefined;
  }
  addUnknownProperties(value, CHANGE_ISSUE_EVIDENCE_KEYS, path, diagnostics);
  const number = projectionNumber(value.number, `${path}.number`, diagnostics, "Issue number");
  const state = value.state;
  if (state !== "open" && state !== "closed") {
    addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", `${path}.state`, "Issue state is invalid.");
  }
  if (diagnostics.length !== before && number === undefined) return undefined;
  if (number === undefined || (state !== "open" && state !== "closed")) return undefined;
  return { number, state };
}

function parseChangeBranchEvidence(
  value: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): ChangeBranchEvidence | undefined {
  const before = diagnostics.length;
  if (!isRecord(value)) {
    addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", path, "Branch evidence must be an object.");
    return undefined;
  }
  addUnknownProperties(value, CHANGE_BRANCH_EVIDENCE_KEYS, path, diagnostics);
  const name = projectionText(value.name, `${path}.name`, diagnostics, "Branch name", MAX_CHANGE_BRANCH_LENGTH);
  return diagnostics.length === before && name !== undefined ? { name } : undefined;
}

function parseChangeBranchEvidenceList(
  value: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): readonly ChangeBranchEvidence[] | undefined {
  if (!Array.isArray(value)) {
    addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", path, "Branch evidence value must be an array.");
    return undefined;
  }
  if (value.length > MAX_CHANGE_PROJECTION_CANDIDATES) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_INVALID_EVIDENCE",
      path,
      `At most ${MAX_CHANGE_PROJECTION_CANDIDATES} branch candidates are supported.`,
    );
    return undefined;
  }
  const branches: ChangeBranchEvidence[] = [];
  for (const [index, candidate] of value.entries()) {
    const parsed = parseChangeBranchEvidence(candidate, `${path}[${index}]`, diagnostics);
    if (parsed !== undefined) branches.push(parsed);
  }
  if (branches.length !== value.length) return undefined;
  return branches.sort((left, right) => compareText(left.name, right.name));
}

function parseChangePullRequestEvidence(
  value: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): NormalizedChangePullRequestEvidence | undefined {
  const before = diagnostics.length;
  if (!isRecord(value)) {
    addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", path, "Pull-request evidence must be an object.");
    return undefined;
  }
  addUnknownProperties(value, CHANGE_PULL_REQUEST_EVIDENCE_KEYS, path, diagnostics);

  const number = projectionNumber(value.number, `${path}.number`, diagnostics, "Pull-request number");
  const head = projectionText(value.head, `${path}.head`, diagnostics, "Pull-request head", MAX_CHANGE_BRANCH_LENGTH);
  const base = projectionText(
    value.base,
    `${path}.base`,
    diagnostics,
    "Pull-request base",
    MAX_CHANGE_BASE_BRANCH_LENGTH,
  );
  const state = value.state;
  if (state !== "open" && state !== "closed") {
    addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", `${path}.state`, "Pull-request state is invalid.");
  }
  const draft = value.draft;
  if (typeof draft !== "boolean") {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_INVALID_EVIDENCE",
      `${path}.draft`,
      "Pull-request draft state is invalid.",
    );
  }

  let merged: boolean | undefined;
  if (hasOwn(value, "merged")) {
    if (typeof value.merged !== "boolean") {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROJECTION_INVALID_EVIDENCE",
        `${path}.merged`,
        "Pull-request merged state is invalid.",
      );
    } else {
      merged = value.merged;
    }
  } else if (state === "closed") {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_EVIDENCE_MISSING",
      `${path}.merged`,
      "Closed pull-request evidence must distinguish merged from aborted.",
    );
  } else if (state === "open") {
    merged = false;
  }

  let accepted: boolean | undefined;
  if (hasOwn(value, "accepted")) {
    if (typeof value.accepted !== "boolean") {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROJECTION_INVALID_EVIDENCE",
        `${path}.accepted`,
        "Pull-request acceptance evidence is invalid.",
      );
    } else {
      accepted = value.accepted;
    }
  }

  let rootIssue: number | undefined;
  if (hasOwn(value, "rootIssue")) {
    rootIssue = projectionNumber(value.rootIssue, `${path}.rootIssue`, diagnostics, "Root Issue number");
  }

  let provenance: ChangeProvenance | undefined;
  if (hasOwn(value, "provenance")) {
    const result = validateChangeProvenance(value.provenance, `${path}.provenance`);
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    provenance = result.provenance;
  }

  if (state === "open" && merged === true) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_CONFLICT",
      `${path}.merged`,
      "An open pull request cannot be projected as merged.",
    );
  }
  if (draft === true && accepted === true) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_CONFLICT",
      `${path}.accepted`,
      "A draft pull request cannot be projected as accepted.",
    );
  }

  if (
    diagnostics.length !== before ||
    number === undefined ||
    head === undefined ||
    base === undefined ||
    (state !== "open" && state !== "closed") ||
    typeof draft !== "boolean" ||
    merged === undefined
  ) {
    return undefined;
  }
  return {
    number,
    head,
    base,
    state,
    draft,
    merged,
    ...(accepted === undefined ? {} : { accepted }),
    ...(rootIssue === undefined ? {} : { rootIssue }),
    ...(provenance === undefined ? {} : { provenance }),
  };
}

function parseChangePullRequestEvidenceList(
  value: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): readonly NormalizedChangePullRequestEvidence[] | undefined {
  if (!Array.isArray(value)) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_INVALID_EVIDENCE",
      path,
      "Pull-request evidence value must be an array.",
    );
    return undefined;
  }
  if (value.length > MAX_CHANGE_PROJECTION_CANDIDATES) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_INVALID_EVIDENCE",
      path,
      `At most ${MAX_CHANGE_PROJECTION_CANDIDATES} pull-request candidates are supported.`,
    );
    return undefined;
  }
  const pullRequests: NormalizedChangePullRequestEvidence[] = [];
  for (const [index, candidate] of value.entries()) {
    const parsed = parseChangePullRequestEvidence(candidate, `${path}[${index}]`, diagnostics);
    if (parsed !== undefined) pullRequests.push(parsed);
  }
  if (pullRequests.length !== value.length) return undefined;
  return pullRequests.sort(compareChangePullRequestEvidence);
}

function compareOptionalNumber(left: number | undefined, right: number | undefined): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return left - right;
}

function compareOptionalBoolean(left: boolean | undefined, right: boolean | undefined): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return Number(left) - Number(right);
}

function compareChangePullRequestEvidence(
  left: NormalizedChangePullRequestEvidence,
  right: NormalizedChangePullRequestEvidence,
): number {
  return (
    left.number - right.number ||
    compareText(left.head, right.head) ||
    compareText(left.base, right.base) ||
    compareText(left.state, right.state) ||
    Number(left.draft) - Number(right.draft) ||
    Number(left.merged) - Number(right.merged) ||
    compareOptionalBoolean(left.accepted, right.accepted) ||
    compareOptionalNumber(left.rootIssue, right.rootIssue) ||
    compareText(left.provenance?.issuer ?? "", right.provenance?.issuer ?? "") ||
    compareText(left.provenance?.implementer ?? "", right.provenance?.implementer ?? "") ||
    compareText(left.provenance?.reviewer ?? "", right.provenance?.reviewer ?? "") ||
    compareText(left.provenance?.merger ?? "", right.provenance?.merger ?? "") ||
    compareText(left.provenance?.requester ?? "", right.provenance?.requester ?? "")
  );
}

function projectionSourceValue<T>(read: ChangeProjectionEvidenceRead<T>, empty: T): T {
  return read.status === "available" && read.value !== undefined ? read.value : empty;
}

function countProjectionValues<T>(values: readonly T[], key: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const valueKey = key(value);
    counts.set(valueKey, (counts.get(valueKey) ?? 0) + 1);
  }
  return counts;
}

function classifyChangeBranchCandidates(
  branches: readonly ChangeBranchEvidence[],
  canonicalBranch: string,
): readonly ChangeProjectionCandidate<ChangeBranchEvidence>[] {
  const counts = countProjectionValues(branches, (candidate) => candidate.name);
  return branches.map((candidate) => {
    const count = counts.get(candidate.name) ?? 0;
    if (count > 1) {
      return {
        candidate,
        classification: "conflicting",
        reason: "The same branch candidate was reported more than once.",
      };
    }
    if (candidate.name === canonicalBranch) {
      return { candidate, classification: "canonical", reason: "Branch matches the derived canonical identity." };
    }
    return {
      candidate,
      classification: "noncanonical",
      reason: "Branch does not match the derived canonical identity.",
    };
  });
}

function projectionPullRequestIdentityMatches(
  candidate: NormalizedChangePullRequestEvidence,
  canonicalBranch: string,
  canonicalBaseBranch: string,
  rootIssue: number,
): boolean {
  return (
    candidate.head === canonicalBranch &&
    candidate.base === canonicalBaseBranch &&
    (candidate.rootIssue === undefined || candidate.rootIssue === rootIssue)
  );
}

function classifyChangePullRequestCandidates(
  pullRequests: readonly NormalizedChangePullRequestEvidence[],
  canonicalBranch: string,
  canonicalBaseBranch: string,
  rootIssue: number,
): readonly ChangeProjectionCandidate<ChangePullRequestEvidence>[] {
  const numberCounts = countProjectionValues(pullRequests, (candidate) => String(candidate.number));
  return pullRequests.map((candidate) => {
    if ((numberCounts.get(String(candidate.number)) ?? 0) > 1) {
      return {
        candidate,
        classification: "conflicting",
        reason: "The same pull-request number was reported more than once.",
      };
    }
    if (candidate.head === canonicalBranch && candidate.base !== canonicalBaseBranch) {
      return {
        candidate,
        classification: "conflicting",
        reason: "Pull-request base does not match the canonical base branch.",
      };
    }
    if (candidate.head === canonicalBranch && candidate.rootIssue !== undefined && candidate.rootIssue !== rootIssue) {
      return {
        candidate,
        classification: "conflicting",
        reason: "Pull-request root Issue claim conflicts with the projected Change identity.",
      };
    }
    if (projectionPullRequestIdentityMatches(candidate, canonicalBranch, canonicalBaseBranch, rootIssue)) {
      return {
        candidate,
        classification: "canonical",
        reason: "Pull request matches the canonical branch, base, and Change identity.",
      };
    }
    return {
      candidate,
      classification: "noncanonical",
      reason: "Pull request does not match the canonical branch projection.",
    };
  });
}

function mergeChangeProvenance(base: ChangeProvenance, candidate: ChangeProvenance | undefined): ChangeProvenance {
  if (candidate === undefined) return base;
  return {
    ...base,
    ...candidate,
  };
}

function createProjectedChange(
  identity: ChangeIdentity,
  provenance: ChangeProvenance,
  state: ChangeState,
  branch: string | undefined,
  pullRequest: number | undefined,
): Change {
  const projection: ChangeProjection = {
    ...(branch === undefined ? {} : { branch }),
    ...(pullRequest === undefined ? {} : { pullRequest }),
  };
  return {
    version: CHANGE_CONTRACT_VERSION,
    identity,
    state,
    provenance,
    ...(Object.keys(projection).length === 0 ? {} : { projection }),
  };
}

function changeStateFromPullRequest(candidate: NormalizedChangePullRequestEvidence): ChangeState {
  if (candidate.state === "closed") return candidate.merged ? "MERGED" : "ABORTED";
  if (candidate.draft) return "DRAFT";
  if (candidate.accepted === true) return "ACCEPTED";
  return "REVIEW";
}

function projectionStatusDiagnostic(status: ChangeProjectionStatus, diagnostics: ChangeDiagnostic[]): void {
  if (status === "partial") {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_PARTIAL",
      "$.evidence",
      "Canonical branch and pull request evidence do not form a complete Change projection.",
    );
  } else if (status === "duplicate") {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_DUPLICATE",
      "$.evidence",
      "More than one candidate claims the canonical Change projection.",
    );
  } else if (status === "wrong-base") {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_WRONG_BASE",
      "$.evidence.pullRequests",
      "A canonical-branch pull request targets the wrong base branch.",
    );
  } else if (status === "ambiguous") {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_AMBIGUOUS",
      "$.evidence",
      "Multiple plausible Change candidates exist; no heuristic candidate selection is allowed.",
    );
  }
}

/**
 * Purely project one Change from bounded Issue, branch, and pull-request
 * evidence. Existing Change state is never used as authority, and no GitHub
 * client, persistence, mutation, or candidate heuristic is involved.
 */
export function projectChangeFromGitHubEvidence(input: unknown): ChangeProjectionResult {
  const diagnostics: ChangeDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Change projection input must be a JSON object.");
    return projectionEvidenceUnavailableResult(diagnostics);
  }
  addUnknownProperties(input, CHANGE_PROJECTION_INPUT_KEYS, "$", diagnostics);

  let identity: ChangeIdentity | undefined;
  let provenance: ChangeProvenance = {};
  if (!hasOwn(input, "change")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.change", "Property is required.");
  } else if (isRecord(input.change) && hasOwn(input.change, "identity")) {
    const result = validateChange(input.change);
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    identity = result.change?.identity;
    provenance = result.change?.provenance ?? {};
  } else {
    const result = validateChangeIdentity(input.change, "$.change");
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    identity = result.identity;
  }

  if (hasOwn(input, "provenance")) {
    const result = validateChangeProvenance(input.provenance, "$.provenance");
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    if (result.provenance !== undefined) provenance = result.provenance;
  }

  let canonicalBranch: string | undefined;
  if (identity !== undefined) {
    const derivationInput: RecordValue = { change: identity };
    if (hasOwn(input, "branchGovernance")) derivationInput.branchGovernance = input.branchGovernance;
    if (hasOwn(input, "naming")) derivationInput.naming = input.naming;
    const result = deriveCanonicalBranchIdentity(derivationInput);
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    canonicalBranch = result.branch;
  }

  let canonicalBaseBranch: string | undefined;
  if (!hasOwn(input, "baseBranch")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.baseBranch", "Property is required.");
  } else {
    canonicalBaseBranch = projectionText(
      input.baseBranch,
      "$.baseBranch",
      diagnostics,
      "Canonical base branch",
      MAX_CHANGE_BASE_BRANCH_LENGTH,
    );
  }

  let evidence: RecordValue | undefined;
  if (!hasOwn(input, "evidence")) {
    addDiagnostic(diagnostics, "CHANGE_PROJECTION_EVIDENCE_MISSING", "$.evidence", "Evidence is required.");
  } else if (!isRecord(input.evidence)) {
    addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", "$.evidence", "Evidence must be an object.");
  } else {
    evidence = input.evidence;
    addUnknownProperties(evidence, CHANGE_GITHUB_EVIDENCE_KEYS, "$.evidence", diagnostics);
  }

  if (
    identity === undefined ||
    canonicalBranch === undefined ||
    canonicalBaseBranch === undefined ||
    evidence === undefined ||
    diagnostics.length > 0
  ) {
    return projectionEvidenceUnavailableResult(diagnostics, canonicalBranch, canonicalBaseBranch);
  }

  const issueRead = readChangeProjectionEvidenceSource(
    hasOwn(evidence, "issue") ? evidence.issue : undefined,
    "$.evidence.issue",
    parseChangeIssueEvidence,
    diagnostics,
  );
  const branchRead = readChangeProjectionEvidenceSource(
    hasOwn(evidence, "branches") ? evidence.branches : undefined,
    "$.evidence.branches",
    parseChangeBranchEvidenceList,
    diagnostics,
  );
  const pullRequestRead = readChangeProjectionEvidenceSource(
    hasOwn(evidence, "pullRequests") ? evidence.pullRequests : undefined,
    "$.evidence.pullRequests",
    parseChangePullRequestEvidenceList,
    diagnostics,
  );

  if (diagnostics.length > 0) {
    return projectionEvidenceUnavailableResult(diagnostics, canonicalBranch, canonicalBaseBranch);
  }

  const branches = projectionSourceValue(branchRead, [] as readonly ChangeBranchEvidence[]);
  const pullRequests = projectionSourceValue(pullRequestRead, [] as readonly NormalizedChangePullRequestEvidence[]);
  const candidates: ChangeProjectionCandidates = {
    branches: classifyChangeBranchCandidates(branches, canonicalBranch),
    pullRequests: classifyChangePullRequestCandidates(
      pullRequests,
      canonicalBranch,
      canonicalBaseBranch,
      identity.rootIssue,
    ),
  };

  const issue = issueRead.status === "available" ? issueRead.value : undefined;
  if (issueRead.status === "available" && issue === undefined) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_INVALID_EVIDENCE",
      "$.evidence.issue",
      "Issue evidence is incomplete.",
    );
    return projectionEvidenceUnavailableResult(diagnostics, canonicalBranch, canonicalBaseBranch);
  }
  if (issue !== undefined && issue.number !== identity.rootIssue) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_ISSUE_MISMATCH",
      "$.evidence.issue.number",
      "Issue evidence does not match the projected Change root Issue.",
    );
    return {
      valid: false,
      status: "unavailable",
      canonicalBranch,
      canonicalBaseBranch,
      candidates,
      diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics,
    };
  }

  const canonicalBranches = candidates.branches.filter((candidate) => candidate.candidate.name === canonicalBranch);
  const canonicalPullRequests = pullRequests.filter((candidate) =>
    projectionPullRequestIdentityMatches(candidate, canonicalBranch, canonicalBaseBranch, identity.rootIssue),
  );
  const pullRequestNumberCounts = countProjectionValues(pullRequests, (candidate) => String(candidate.number));
  const duplicateCanonicalPullRequestNumbers = pullRequests.some(
    (candidate) =>
      candidate.head === canonicalBranch && (pullRequestNumberCounts.get(String(candidate.number)) ?? 0) > 1,
  );
  const wrongBasePullRequests = pullRequests.filter(
    (candidate) => candidate.head === canonicalBranch && candidate.base !== canonicalBaseBranch,
  );
  const conflictingCandidates = [
    ...candidates.branches.filter((candidate) => candidate.classification === "conflicting"),
    ...candidates.pullRequests.filter((candidate) => candidate.classification === "conflicting"),
  ];
  const plausibleNoncanonicalPullRequests = pullRequests.filter(
    (candidate) => candidate.rootIssue === identity.rootIssue && candidate.head !== canonicalBranch,
  );

  let status: ChangeProjectionStatus;
  if (canonicalBranches.length > 1 || canonicalPullRequests.length > 1 || duplicateCanonicalPullRequestNumbers) {
    status = "duplicate";
  } else if (wrongBasePullRequests.length > 0) {
    status = "wrong-base";
  } else if (conflictingCandidates.length > 0) {
    status = "ambiguous";
  } else if (canonicalBranches.length === 1 && canonicalPullRequests.length === 1 && issue !== undefined) {
    status = "healthy";
  } else if (canonicalBranches.length === 1 || canonicalPullRequests.length === 1) {
    status = "partial";
  } else if (plausibleNoncanonicalPullRequests.length > 1) {
    status = "ambiguous";
  } else if (issueRead.status === "absent" && (canonicalBranches.length > 0 || canonicalPullRequests.length > 0)) {
    status = "partial";
  } else {
    status = "absent";
  }

  if (status === "absent") {
    const change =
      issue === undefined ? undefined : createProjectedChange(identity, provenance, "DEFINED", undefined, undefined);
    return {
      valid: true,
      status,
      canonicalBranch,
      canonicalBaseBranch,
      candidates,
      ...(change === undefined ? {} : { change }),
      diagnostics: [],
    };
  }

  const canonicalPullRequest = canonicalPullRequests.length === 1 ? canonicalPullRequests[0] : undefined;
  const knownBranch =
    canonicalBranches.length === 1 || pullRequests.some((candidate) => candidate.head === canonicalBranch);
  const projectedBranch = knownBranch ? canonicalBranch : undefined;
  const projectedPullRequest = canonicalPullRequest?.number;
  const projectedProvenance = mergeChangeProvenance(provenance, canonicalPullRequest?.provenance);
  const state =
    status === "healthy"
      ? changeStateFromPullRequest(canonicalPullRequest as NormalizedChangePullRequestEvidence)
      : "RECOVERY_REQUIRED";
  const change = createProjectedChange(identity, projectedProvenance, state, projectedBranch, projectedPullRequest);

  if (conflictingCandidates.length > 0 && status !== "duplicate" && status !== "wrong-base") {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_CONFLICT",
      "$.evidence",
      "Conflicting candidates claim part of the canonical Change projection.",
    );
  }
  projectionStatusDiagnostic(status, diagnostics);
  return {
    valid: status === "healthy",
    status,
    canonicalBranch,
    canonicalBaseBranch,
    candidates,
    change,
    diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics,
  };
}

export const projectChangeFromEvidence = projectChangeFromGitHubEvidence;
export const deriveChangeProjection = projectChangeFromGitHubEvidence;

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

interface ResolvedTransitionTarget {
  readonly branch?: string;
  readonly baseBranch?: string;
  readonly pullRequest?: number;
}

type ChangeTransitionRule = (typeof CHANGE_TRANSITION_RULES)[number];

function normalizeChangeTransition(input: unknown): ChangeTransition | undefined {
  if (typeof input !== "string") return undefined;
  const normalized = input.toLowerCase();
  return CHANGE_TRANSITION_OPERATIONS.includes(normalized as ChangeTransition)
    ? (normalized as ChangeTransition)
    : undefined;
}

function validateTransitionBranch(
  value: unknown,
  path: string,
  maxLength: number,
  diagnostics: ChangeDiagnostic[],
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_TRANSITION_TARGET", path, "Branch identity is invalid.");
    return undefined;
  }
  return value;
}

function validateTransitionTarget(input: unknown, path: string): ChangeTransitionTargetValidation {
  const diagnostics: ChangeDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_TRANSITION_TARGET", path, "Transition target must be an object.");
    return { valid: false, diagnostics };
  }
  addUnknownProperties(input, TRANSITION_TARGET_KEYS, path, diagnostics);

  let branch: string | undefined;
  let baseBranch: string | undefined;
  let pullRequest: number | undefined;
  if (hasOwn(input, "branch")) {
    branch = validateTransitionBranch(input.branch, `${path}.branch`, MAX_CHANGE_BRANCH_LENGTH, diagnostics);
  }
  if (hasOwn(input, "baseBranch")) {
    baseBranch = validateTransitionBranch(
      input.baseBranch,
      `${path}.baseBranch`,
      MAX_CHANGE_BASE_BRANCH_LENGTH,
      diagnostics,
    );
  }
  if (hasOwn(input, "pullRequest")) {
    if (typeof input.pullRequest !== "number" || !Number.isSafeInteger(input.pullRequest) || input.pullRequest < 1) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_TRANSITION_TARGET",
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
  return {
    valid: true,
    target: {
      ...(branch === undefined ? {} : { branch }),
      ...(baseBranch === undefined ? {} : { baseBranch }),
      ...(pullRequest === undefined ? {} : { pullRequest }),
    },
    diagnostics: [],
  };
}

interface ChangeTransitionTargetValidation {
  readonly valid: boolean;
  readonly target?: ChangeTransitionTarget;
  readonly diagnostics: readonly ChangeDiagnostic[];
}

function transitionRule(transition: ChangeTransition, state: ChangeState): ChangeTransitionRule | undefined {
  return CHANGE_TRANSITION_RULES.find((candidate) => candidate.transition === transition && candidate.from === state);
}

function reportTransitionMismatch(diagnostics: ChangeDiagnostic[], path: string, message: string): void {
  addDiagnostic(diagnostics, "CHANGE_TRANSITION_NOT_ALLOWED", path, message);
}

function reportTargetProblem(diagnostics: ChangeDiagnostic[], path: string, message: string): void {
  addDiagnostic(diagnostics, "CHANGE_INVALID_TRANSITION_TARGET", path, message);
}

function sameDefinedValue(left: string | number | undefined, right: string | number | undefined): boolean {
  return left === undefined || right === undefined || left === right;
}

function validateTransitionSemantics(
  change: Change,
  transition: ChangeTransition,
  target: ChangeTransitionTarget | undefined,
): { readonly diagnostics: readonly ChangeDiagnostic[]; readonly resolved?: ResolvedTransitionTarget } {
  const diagnostics: ChangeDiagnostic[] = [];
  if (transition === "merge") {
    addDiagnostic(
      diagnostics,
      "CHANGE_UNSUPPORTED_TRANSITION",
      "$.transition",
      "The merge transition is reserved for a future merge-coordination capability.",
    );
    return { diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }

  const rule = transitionRule(transition, change.state);
  if (rule === undefined) {
    reportTransitionMismatch(
      diagnostics,
      "$.change.state",
      `Transition "${transition}" is not allowed from state "${change.state}".`,
    );
    return { diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }

  if (transition === "issue") {
    if (change.projection?.branch !== undefined || change.projection?.pullRequest !== undefined) {
      reportTransitionMismatch(
        diagnostics,
        "$.change.projection",
        "An issue transition requires a Change without an existing canonical projection.",
      );
    }
    if (target === undefined) {
      reportTargetProblem(diagnostics, "$.target", "An issue transition requires a target.");
    } else {
      if (target.branch === undefined) {
        reportTargetProblem(diagnostics, "$.target.branch", "An issue transition requires a canonical branch.");
      }
      if (target.baseBranch === undefined) {
        reportTargetProblem(diagnostics, "$.target.baseBranch", "An issue transition requires a base branch.");
      }
      if (target.pullRequest !== undefined) {
        reportTargetProblem(
          diagnostics,
          "$.target.pullRequest",
          "An issue transition cannot contain an already-created pull request.",
        );
      }
    }
    if (diagnostics.length > 0) {
      return { diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    return {
      diagnostics: [],
      resolved: {
        branch: target?.branch,
        baseBranch: target?.baseBranch,
      },
    };
  }

  if (target?.baseBranch !== undefined) {
    reportTargetProblem(
      diagnostics,
      "$.target.baseBranch",
      `The ${transition} transition does not accept a base branch target.`,
    );
  }
  const sourceBranch = change.projection?.branch;
  const sourcePullRequest = change.projection?.pullRequest;
  if (!sameDefinedValue(sourceBranch, target?.branch)) {
    reportTargetProblem(diagnostics, "$.target.branch", "Target branch does not match the current Change projection.");
  }
  if (!sameDefinedValue(sourcePullRequest, target?.pullRequest)) {
    reportTargetProblem(
      diagnostics,
      "$.target.pullRequest",
      "Target pull request does not match the current Change projection.",
    );
  }
  const branch = target?.branch ?? sourceBranch;
  const pullRequest = target?.pullRequest ?? sourcePullRequest;
  if (branch === undefined) {
    reportTargetProblem(diagnostics, "$.change.projection.branch", "The transition requires a canonical branch.");
  }
  if (pullRequest === undefined) {
    reportTargetProblem(
      diagnostics,
      "$.change.projection.pullRequest",
      "The transition requires a canonical pull request.",
    );
  }
  if (diagnostics.length > 0) {
    return { diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  return { diagnostics: [], resolved: { branch, pullRequest } };
}

/** Validate a transport-independent lifecycle request and its transition policy. */
export function validateChangeTransitionRequest(input: unknown): ChangeTransitionRequestValidationResult {
  const diagnostics: ChangeDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Change transition request must be a JSON object.");
    return { valid: false, diagnostics };
  }
  addUnknownProperties(input, TRANSITION_REQUEST_KEYS, "$", diagnostics);

  if (!hasOwn(input, "version")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.version", "Property is required.");
  } else if (input.version !== CHANGE_TRANSITION_CONTRACT_VERSION) {
    addDiagnostic(
      diagnostics,
      "CHANGE_UNSUPPORTED_VERSION",
      "$.version",
      "Change transition contract version is unsupported.",
    );
  }

  let transition: ChangeTransition | undefined;
  if (!hasOwn(input, "transition")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.transition", "Property is required.");
  } else {
    transition = normalizeChangeTransition(input.transition);
    if (transition === undefined) {
      addDiagnostic(diagnostics, "CHANGE_INVALID_TRANSITION", "$.transition", "Transition operation is unsupported.");
    }
  }

  let change: Change | undefined;
  if (!hasOwn(input, "change")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.change", "Property is required.");
  } else {
    const result = validateChange(input.change);
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    change = result.change;
  }

  let target: ChangeTransitionTarget | undefined;
  if (hasOwn(input, "target")) {
    const result = validateTransitionTarget(input.target, "$.target");
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    target = result.target;
  }

  if (diagnostics.length > 0 || transition === undefined || change === undefined) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }

  const semantic = validateTransitionSemantics(change, transition, target);
  diagnostics.push(...semantic.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
  if (diagnostics.length > 0 || semantic.resolved === undefined) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  return {
    valid: true,
    request: {
      version: CHANGE_TRANSITION_CONTRACT_VERSION,
      transition,
      change,
      ...(target === undefined ? {} : { target }),
    },
    diagnostics: [],
  };
}

export const validateChangeTransition = validateChangeTransitionRequest;

/** Assert a valid request at a trusted Core call boundary. */
export function assertChangeTransitionRequest(input: unknown): asserts input is ChangeTransitionRequest {
  const result = validateChangeTransitionRequest(input);
  if (!result.valid) throw new ChangeTransitionValidationError(result.diagnostics);
}

function resolvedTransitionTarget(request: ChangeTransitionRequest): ResolvedTransitionTarget {
  const target = request.target;
  const projection = request.change.projection;
  if (request.transition === "issue") {
    return { branch: target?.branch, baseBranch: target?.baseBranch };
  }
  return {
    branch: target?.branch ?? projection?.branch,
    pullRequest: target?.pullRequest ?? projection?.pullRequest,
  };
}

function transitionResult(request: ChangeTransitionRequest, to: ChangeState): Change {
  const resolved = resolvedTransitionTarget(request);
  const projection: ChangeProjection = {
    ...(resolved.branch === undefined ? {} : { branch: resolved.branch }),
    ...(resolved.pullRequest === undefined ? {} : { pullRequest: resolved.pullRequest }),
  };
  return {
    version: CHANGE_CONTRACT_VERSION,
    identity: request.change.identity,
    state: to,
    provenance: request.change.provenance,
    ...(Object.keys(projection).length === 0 ? {} : { projection }),
  };
}

function buildChangeTransitionPlan(request: ChangeTransitionRequest): ChangeTransitionPlan {
  const rule = transitionRule(request.transition, request.change.state);
  if (rule === undefined) {
    throw new Error("Cannot build a plan for an invalid Change transition request.");
  }
  const resolved = resolvedTransitionTarget(request);
  const effects: ChangeEffect[] = [];
  if (request.transition === "issue") {
    if (resolved.branch === undefined || resolved.baseBranch === undefined) {
      throw new Error("A valid issue request must resolve branch and base branch targets.");
    }
    effects.push(
      {
        kind: "CREATE_BRANCH",
        branch: resolved.branch,
        baseBranch: resolved.baseBranch,
      },
      {
        kind: "CREATE_PULL_REQUEST",
        branch: resolved.branch,
        baseBranch: resolved.baseBranch,
        rootIssue: request.change.identity.rootIssue,
        draft: true,
      },
    );
  } else if (request.transition === "ready") {
    if (resolved.pullRequest === undefined) throw new Error("A valid ready request must resolve a pull request.");
    effects.push({ kind: "MARK_PULL_REQUEST_READY", pullRequest: resolved.pullRequest });
  } else if (request.transition === "abort") {
    if (resolved.pullRequest === undefined) throw new Error("A valid abort request must resolve a pull request.");
    effects.push({ kind: "CLOSE_PULL_REQUEST", pullRequest: resolved.pullRequest });
  } else {
    throw new Error("The merge transition is not currently plannable.");
  }
  return {
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    request,
    from: rule.from,
    to: rule.to,
    result: transitionResult(request, rule.to),
    effects,
  };
}

/**
 * Produce a deterministic declarative plan.  This function has no I/O and
 * never invokes an adapter or a privileged GitHub capability.
 */
export function planChangeTransition(input: unknown): ChangeTransitionPlan {
  const result = validateChangeTransitionRequest(input);
  if (!result.valid || result.request === undefined) {
    throw new ChangeTransitionValidationError(result.diagnostics);
  }
  return buildChangeTransitionPlan(result.request);
}

export const createChangeTransitionPlan = planChangeTransition;

function requiredPlanState(
  input: RecordValue,
  key: "from" | "to",
  diagnostics: ChangeDiagnostic[],
): ChangeState | undefined {
  if (!hasOwn(input, key)) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", `$.${key}`, "Property is required.");
    return undefined;
  }
  if (typeof input[key] !== "string" || !CHANGE_STATES.includes(input[key] as ChangeState)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `$.${key}`, "Plan lifecycle state is unsupported.");
    return undefined;
  }
  return input[key] as ChangeState;
}

function requiredEffectBranch(
  input: RecordValue,
  key: "branch" | "baseBranch",
  path: string,
  maxLength: number,
  diagnostics: ChangeDiagnostic[],
): string | undefined {
  if (!hasOwn(input, key)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_EFFECT", `${path}.${key}`, "Effect property is required.");
    return undefined;
  }
  return validateEffectBranch(input[key], `${path}.${key}`, maxLength, diagnostics);
}

function validateEffectBranch(
  value: unknown,
  path: string,
  maxLength: number,
  diagnostics: ChangeDiagnostic[],
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_EFFECT", path, "Effect branch identity is invalid.");
    return undefined;
  }
  return value;
}

function requiredEffectNumber(
  input: RecordValue,
  key: "rootIssue" | "pullRequest",
  path: string,
  diagnostics: ChangeDiagnostic[],
): number | undefined {
  if (!hasOwn(input, key)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_EFFECT", `${path}.${key}`, "Effect property is required.");
    return undefined;
  }
  if (typeof input[key] !== "number" || !Number.isSafeInteger(input[key]) || input[key] < 1) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_EFFECT",
      `${path}.${key}`,
      "Effect number must be a positive safe integer.",
    );
    return undefined;
  }
  return input[key] as number;
}

function rejectEffectProperties(
  input: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: ChangeDiagnostic[],
): void {
  for (const key of Object.keys(input).sort(compareText)) {
    if (!allowed.has(key)) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_EFFECT",
        `${path}.${key}`,
        "Effect property is not valid for its kind.",
      );
    }
  }
}

/** Validate one declarative effect primitive without executing it. */
export function validateChangeEffect(input: unknown, path = "$"): ChangeEffectValidationResult {
  const diagnostics: ChangeDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_EFFECT", path, "Change effect must be an object.");
    return { valid: false, diagnostics };
  }
  addUnknownProperties(input, EFFECT_KEYS, path, diagnostics);
  const kind = input.kind;
  if (typeof kind !== "string" || !CHANGE_EFFECT_KINDS.includes(kind as ChangeEffectKind)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_EFFECT", `${path}.kind`, "Effect kind is unsupported.");
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }

  if (kind === "CREATE_BRANCH") {
    const allowed = new Set(["kind", "branch", "baseBranch"]);
    rejectEffectProperties(input, allowed, path, diagnostics);
    const branch = requiredEffectBranch(input, "branch", path, MAX_CHANGE_BRANCH_LENGTH, diagnostics);
    const baseBranch = requiredEffectBranch(input, "baseBranch", path, MAX_CHANGE_BASE_BRANCH_LENGTH, diagnostics);
    if (diagnostics.length > 0 || branch === undefined || baseBranch === undefined) {
      return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    return { valid: true, effect: { kind, branch, baseBranch }, diagnostics: [] };
  }

  if (kind === "CREATE_PULL_REQUEST") {
    const allowed = new Set(["kind", "branch", "baseBranch", "rootIssue", "draft"]);
    rejectEffectProperties(input, allowed, path, diagnostics);
    const branch = requiredEffectBranch(input, "branch", path, MAX_CHANGE_BRANCH_LENGTH, diagnostics);
    const baseBranch = requiredEffectBranch(input, "baseBranch", path, MAX_CHANGE_BASE_BRANCH_LENGTH, diagnostics);
    const rootIssue = requiredEffectNumber(input, "rootIssue", path, diagnostics);
    if (!hasOwn(input, "draft") || input.draft !== true) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_EFFECT",
        `${path}.draft`,
        "Create pull request effects must be draft.",
      );
    }
    if (diagnostics.length > 0 || branch === undefined || baseBranch === undefined || rootIssue === undefined) {
      return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    return { valid: true, effect: { kind, branch, baseBranch, rootIssue, draft: true }, diagnostics: [] };
  }

  const allowed = new Set(["kind", "pullRequest"]);
  rejectEffectProperties(input, allowed, path, diagnostics);
  const pullRequest = requiredEffectNumber(input, "pullRequest", path, diagnostics);
  if (diagnostics.length > 0 || pullRequest === undefined) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  if (kind === "MARK_PULL_REQUEST_READY") {
    return { valid: true, effect: { kind, pullRequest }, diagnostics: [] };
  }
  return { valid: true, effect: { kind: "CLOSE_PULL_REQUEST", pullRequest }, diagnostics: [] };
}

function validateEffectList(input: unknown, path: string, diagnostics: ChangeDiagnostic[]): ChangeEffect[] {
  if (!Array.isArray(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Plan effects must be an array.");
    return [];
  }
  if (input.length > MAX_CHANGE_TRANSITION_EFFECTS) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_PLAN",
      path,
      `At most ${MAX_CHANGE_TRANSITION_EFFECTS} transition effects are supported.`,
    );
  }
  const effects: ChangeEffect[] = [];
  for (let index = 0; index < input.length && diagnostics.length < MAX_CHANGE_DIAGNOSTICS; index += 1) {
    const result = validateChangeEffect(input[index], `${path}[${index}]`);
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    if (result.effect !== undefined) effects.push(result.effect);
  }
  return effects;
}

function canonicalPlanEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Validate and canonicalize a previously generated or transported plan. */
export function validateChangeTransitionPlan(input: unknown): ChangeTransitionPlanValidationResult {
  const diagnostics: ChangeDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Change transition plan must be a JSON object.");
    return { valid: false, diagnostics };
  }
  addUnknownProperties(input, TRANSITION_PLAN_KEYS, "$", diagnostics);
  if (!hasOwn(input, "version")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.version", "Property is required.");
  } else if (input.version !== CHANGE_TRANSITION_CONTRACT_VERSION) {
    addDiagnostic(
      diagnostics,
      "CHANGE_UNSUPPORTED_VERSION",
      "$.version",
      "Change transition plan version is unsupported.",
    );
  }

  let request: ChangeTransitionRequest | undefined;
  if (!hasOwn(input, "request")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.request", "Property is required.");
  } else {
    const result = validateChangeTransitionRequest(input.request);
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    request = result.request;
  }
  const from = requiredPlanState(input, "from", diagnostics);
  const to = requiredPlanState(input, "to", diagnostics);

  let resultChange: Change | undefined;
  if (!hasOwn(input, "result")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.result", "Property is required.");
  } else {
    const result = validateChange(input.result);
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    resultChange = result.change;
  }

  let effects: ChangeEffect[] = [];
  if (!hasOwn(input, "effects")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.effects", "Property is required.");
  } else {
    effects = validateEffectList(input.effects, "$.effects", diagnostics);
  }

  if (
    diagnostics.length > 0 ||
    request === undefined ||
    from === undefined ||
    to === undefined ||
    resultChange === undefined
  ) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }

  const expected = buildChangeTransitionPlan(request);
  if (from !== expected.from) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.from", "Plan source state does not match its request.");
  }
  if (to !== expected.to) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.to", "Plan target state does not match its request.");
  }
  if (!canonicalPlanEquals(resultChange, expected.result)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.result", "Plan result does not match its transition.");
  }
  if (!canonicalPlanEquals(effects, expected.effects)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.effects", "Plan effects do not match its transition.");
  }
  if (diagnostics.length > 0) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  return { valid: true, plan: expected, diagnostics: [] };
}

export const validateChangePlan = validateChangeTransitionPlan;

/** Assert a valid declarative plan at an executor boundary. */
export function assertChangeTransitionPlan(input: unknown): asserts input is ChangeTransitionPlan {
  const result = validateChangeTransitionPlan(input);
  if (!result.valid) throw new ChangeTransitionValidationError(result.diagnostics);
}

export class ChangeTransitionValidationError extends ChangeValidationError {
  constructor(diagnostics: readonly ChangeDiagnostic[]) {
    super(diagnostics);
    this.name = "ChangeTransitionValidationError";
  }
}

/** Serialize the canonical transition request with stable property ordering. */
export function serializeChangeTransitionRequest(input: unknown): string {
  const result = validateChangeTransitionRequest(input);
  if (!result.valid || result.request === undefined) throw new ChangeTransitionValidationError(result.diagnostics);
  const serialized = JSON.stringify(result.request);
  if (serialized === undefined) throw new Error("Change transition request could not be serialized.");
  return serialized;
}

/** Parse and validate an untrusted transition request JSON boundary. */
export function deserializeChangeTransitionRequest(serialized: string): ChangeTransitionRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new ChangeTransitionValidationError([
      createChangeDiagnostic({
        code: "CHANGE_INVALID_JSON",
        message: safeMessage(
          `Change transition request must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      }),
    ]);
  }
  const result = validateChangeTransitionRequest(parsed);
  if (!result.valid || result.request === undefined) throw new ChangeTransitionValidationError(result.diagnostics);
  return result.request;
}

/** Serialize the canonical effect plan with stable property ordering. */
export function serializeChangeTransitionPlan(input: unknown): string {
  const result = validateChangeTransitionPlan(input);
  if (!result.valid || result.plan === undefined) throw new ChangeTransitionValidationError(result.diagnostics);
  const serialized = JSON.stringify(result.plan);
  if (serialized === undefined) throw new Error("Change transition plan could not be serialized.");
  return serialized;
}

/** Parse and validate an untrusted effect plan JSON boundary. */
export function deserializeChangeTransitionPlan(serialized: string): ChangeTransitionPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new ChangeTransitionValidationError([
      createChangeDiagnostic({
        code: "CHANGE_INVALID_JSON",
        message: safeMessage(
          `Change transition plan must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      }),
    ]);
  }
  const result = validateChangeTransitionPlan(parsed);
  if (!result.valid || result.plan === undefined) throw new ChangeTransitionValidationError(result.diagnostics);
  return result.plan;
}

export function isChangeTransitionRequest(input: unknown): input is ChangeTransitionRequest {
  return validateChangeTransitionRequest(input).valid;
}

export function isChangeTransitionPlan(input: unknown): input is ChangeTransitionPlan {
  return validateChangeTransitionPlan(input).valid;
}

export const parseChangeTransitionRequest = deserializeChangeTransitionRequest;
export const parseChangeTransitionPlan = deserializeChangeTransitionPlan;
export const serializeChangeTransitionRequestContract = serializeChangeTransitionRequest;
export const serializeChangeTransitionPlanContract = serializeChangeTransitionPlan;

/** Issuance consumes the existing canonical projection request unchanged. */
export type ChangeIssuanceRequest = ChangeProjectionInput;

function isChangeIssuanceHealthyState(value: unknown): value is ChangeIssuanceHealthyState {
  return value === "DRAFT" || value === "REVIEW" || value === "ACCEPTED" || value === "MERGED" || value === "ABORTED";
}

function issuancePlanText(
  value: unknown,
  path: string,
  label: string,
  maxLength: number,
  diagnostics: ChangeDiagnostic[],
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, `${label} is invalid.`);
    return undefined;
  }
  return value;
}

function validateChangeIssuanceTransaction(
  input: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): ChangeIssuanceTransaction | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Issuance transaction must be an object.");
    return undefined;
  }
  addUnknownProperties(input, CHANGE_ISSUANCE_TRANSACTION_KEYS, path, diagnostics);

  if (input.operation !== "issue") {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.operation`, "Issuance operation must be issue.");
  }

  let identity: ChangeIdentity | undefined;
  if (!hasOwn(input, "identity")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", `${path}.identity`, "Property is required.");
  } else {
    const result = validateChangeIdentity(input.identity, `${path}.identity`);
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    identity = result.identity;
  }

  const idempotencyKey = issuancePlanText(
    input.idempotencyKey,
    `${path}.idempotencyKey`,
    "Idempotency key",
    MAX_CHANGE_IDEMPOTENCY_KEY_LENGTH,
    diagnostics,
  );
  if (diagnostics.length > 0 || identity === undefined || idempotencyKey === undefined) return undefined;
  return { operation: "issue", identity, idempotencyKey };
}

function validateChangeIssuanceVerification(
  input: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): ChangeIssuanceVerificationExpectation | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Issuance verification expectation must be an object.");
    return undefined;
  }
  addUnknownProperties(input, CHANGE_ISSUANCE_VERIFICATION_KEYS, path, diagnostics);
  if (input.phase !== "post-effect") {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.phase`, "Verification phase must be post-effect.");
  }
  if (input.status !== "healthy") {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.status`, "Verification status must be healthy.");
  }
  const canonicalBranch = issuancePlanText(
    input.canonicalBranch,
    `${path}.canonicalBranch`,
    "Canonical branch",
    MAX_CHANGE_BRANCH_LENGTH,
    diagnostics,
  );
  const canonicalBaseBranch = issuancePlanText(
    input.canonicalBaseBranch,
    `${path}.canonicalBaseBranch`,
    "Canonical base branch",
    MAX_CHANGE_BASE_BRANCH_LENGTH,
    diagnostics,
  );
  let state: ChangeIssuanceHealthyState | undefined;
  if (!isChangeIssuanceHealthyState(input.state)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.state`, "Verification state is not healthy.");
  } else {
    state = input.state;
  }

  let pullRequestNumber: number | undefined;
  if (!hasOwn(input, "pullRequest")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", `${path}.pullRequest`, "Property is required.");
  } else if (!isRecord(input.pullRequest)) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_PLAN",
      `${path}.pullRequest`,
      "Pull-request expectation must be an object.",
    );
  } else {
    addUnknownProperties(input.pullRequest, CHANGE_ISSUANCE_PULL_REQUEST_KEYS, `${path}.pullRequest`, diagnostics);
    if (input.pullRequest.required !== true) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_PLAN",
        `${path}.pullRequest.required`,
        "Pull-request expectation must require a canonical pull request.",
      );
    }
    if (hasOwn(input.pullRequest, "number")) {
      if (
        typeof input.pullRequest.number !== "number" ||
        !Number.isSafeInteger(input.pullRequest.number) ||
        input.pullRequest.number < 1
      ) {
        addDiagnostic(
          diagnostics,
          "CHANGE_INVALID_PLAN",
          `${path}.pullRequest.number`,
          "Expected pull-request number must be a positive safe integer.",
        );
      } else {
        pullRequestNumber = input.pullRequest.number;
      }
    }
  }

  if (
    diagnostics.length > 0 ||
    canonicalBranch === undefined ||
    canonicalBaseBranch === undefined ||
    state === undefined
  ) {
    return undefined;
  }
  return {
    phase: "post-effect",
    status: "healthy",
    canonicalBranch,
    canonicalBaseBranch,
    state,
    pullRequest: {
      required: true,
      ...(pullRequestNumber === undefined ? {} : { number: pullRequestNumber }),
    },
  };
}

function buildChangeIssuanceVerification(
  result: Change,
  canonicalBranch: string,
  canonicalBaseBranch: string,
): ChangeIssuanceVerificationExpectation {
  if (!isChangeIssuanceHealthyState(result.state)) {
    throw new Error("Issuance verification requires a healthy Change state.");
  }
  const pullRequest = result.projection?.pullRequest;
  return {
    phase: "post-effect",
    status: "healthy",
    canonicalBranch,
    canonicalBaseBranch,
    state: result.state,
    pullRequest: {
      required: true,
      ...(pullRequest === undefined ? {} : { number: pullRequest }),
    },
  };
}

function buildChangeIssuancePlan(projection: ChangeProjectionResult): ChangeIssuancePlan {
  if (
    (projection.status !== "absent" && projection.status !== "healthy") ||
    !projection.valid ||
    projection.change === undefined ||
    projection.canonicalBranch === undefined ||
    projection.canonicalBaseBranch === undefined
  ) {
    throw new Error("A valid absent or healthy Change projection is required for issuance planning.");
  }

  const sourceStatus = projection.status;
  const transactionIdentity = projection.change.identity;
  const transaction: ChangeIssuanceTransaction = {
    operation: "issue",
    identity: transactionIdentity,
    idempotencyKey: changeIdentityKey(transactionIdentity),
  };

  if (sourceStatus === "absent") {
    const transitionPlan = planChangeTransition({
      version: CHANGE_TRANSITION_CONTRACT_VERSION,
      transition: "issue",
      change: projection.change,
      target: {
        branch: projection.canonicalBranch,
        baseBranch: projection.canonicalBaseBranch,
      },
    });
    return {
      version: CHANGE_TRANSITION_CONTRACT_VERSION,
      operation: "issue",
      mode: "create",
      sourceStatus,
      transaction,
      result: transitionPlan.result,
      effects: transitionPlan.effects,
      verification: buildChangeIssuanceVerification(
        transitionPlan.result,
        projection.canonicalBranch,
        projection.canonicalBaseBranch,
      ),
    };
  }

  return {
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    operation: "issue",
    mode: "return-existing",
    sourceStatus,
    transaction,
    result: projection.change,
    effects: [],
    verification: buildChangeIssuanceVerification(
      projection.change,
      projection.canonicalBranch,
      projection.canonicalBaseBranch,
    ),
  };
}

function issuanceFailureDiagnostics(projection: ChangeProjectionResult): readonly ChangeDiagnostic[] {
  if (projection.diagnostics.length > 0) return projection.diagnostics;
  if (projection.status === "absent" && projection.change === undefined) {
    return [
      createChangeDiagnostic({
        code: "CHANGE_ISSUANCE_ROOT_ISSUE_ABSENT",
        path: "$.evidence.issue",
        message: "Change issuance requires confirmed root Issue evidence.",
      }),
    ];
  }
  return [
    createChangeDiagnostic({
      code: "CHANGE_INVALID_PLAN",
      path: "$.projection",
      message: "Change projection cannot produce an issuance plan.",
    }),
  ];
}

/**
 * Plan idempotent Change issuance from the canonical #213 projection.
 * This function is pure: it does not invoke GitHub, Actions, an App, a CLI,
 * credentials, or any effect executor.
 */
export function planChangeIssuance(input: unknown): ChangeIssuancePlan {
  const projection = projectChangeFromGitHubEvidence(input);
  if (
    !projection.valid ||
    (projection.status !== "absent" && projection.status !== "healthy") ||
    projection.change === undefined ||
    projection.canonicalBranch === undefined ||
    projection.canonicalBaseBranch === undefined
  ) {
    throw new ChangeIssuanceValidationError(issuanceFailureDiagnostics(projection));
  }

  const plan = buildChangeIssuancePlan(projection);
  const result = validateChangeIssuancePlan(plan);
  if (!result.valid || result.plan === undefined) throw new ChangeIssuanceValidationError(result.diagnostics);
  return result.plan;
}

export const createChangeIssuancePlan = planChangeIssuance;
export const planIdempotentChangeIssuance = planChangeIssuance;

/** Validate and canonicalize a transport-independent issuance plan. */
export function validateChangeIssuancePlan(input: unknown): ChangeIssuancePlanValidationResult {
  const diagnostics: ChangeDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Change issuance plan must be a JSON object.");
    return { valid: false, diagnostics };
  }
  addUnknownProperties(input, CHANGE_ISSUANCE_PLAN_KEYS, "$", diagnostics);

  if (!hasOwn(input, "version")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.version", "Property is required.");
  } else if (input.version !== CHANGE_TRANSITION_CONTRACT_VERSION) {
    addDiagnostic(
      diagnostics,
      "CHANGE_UNSUPPORTED_VERSION",
      "$.version",
      "Change issuance plan version is unsupported.",
    );
  }
  if (input.operation !== "issue") {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.operation", "Issuance operation must be issue.");
  }

  let mode: ChangeIssuanceMode | undefined;
  if (!hasOwn(input, "mode")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.mode", "Property is required.");
  } else if (!CHANGE_ISSUANCE_MODES.includes(input.mode as ChangeIssuanceMode)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.mode", "Issuance mode is unsupported.");
  } else {
    mode = input.mode as ChangeIssuanceMode;
  }

  let sourceStatus: ChangeIssuanceSourceStatus | undefined;
  if (!hasOwn(input, "sourceStatus")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.sourceStatus", "Property is required.");
  } else if (!CHANGE_ISSUANCE_SOURCE_STATUSES.includes(input.sourceStatus as ChangeIssuanceSourceStatus)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.sourceStatus", "Issuance source status is unsupported.");
  } else {
    sourceStatus = input.sourceStatus as ChangeIssuanceSourceStatus;
  }

  let transaction: ChangeIssuanceTransaction | undefined;
  if (!hasOwn(input, "transaction")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.transaction", "Property is required.");
  } else {
    transaction = validateChangeIssuanceTransaction(input.transaction, "$.transaction", diagnostics);
  }

  let resultChange: Change | undefined;
  if (!hasOwn(input, "result")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.result", "Property is required.");
  } else {
    const result = validateChange(input.result);
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    resultChange = result.change;
  }

  let effects: ChangeEffect[] = [];
  if (!hasOwn(input, "effects")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.effects", "Property is required.");
  } else {
    effects = validateEffectList(input.effects, "$.effects", diagnostics);
  }

  let verification: ChangeIssuanceVerificationExpectation | undefined;
  if (!hasOwn(input, "verification")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.verification", "Property is required.");
  } else {
    verification = validateChangeIssuanceVerification(input.verification, "$.verification", diagnostics);
  }

  if (
    diagnostics.length > 0 ||
    mode === undefined ||
    sourceStatus === undefined ||
    transaction === undefined ||
    resultChange === undefined ||
    verification === undefined
  ) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }

  const expectedIdempotencyKey = changeIdentityKey(resultChange.identity);
  if (!canonicalPlanEquals(transaction.identity, resultChange.identity)) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_PLAN",
      "$.transaction.identity",
      "Transaction identity must match the result.",
    );
  }
  if (transaction.idempotencyKey !== expectedIdempotencyKey) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_PLAN",
      "$.transaction.idempotencyKey",
      "Idempotency key must be derived from the Change identity.",
    );
  }
  if ((mode === "create" && sourceStatus !== "absent") || (mode === "return-existing" && sourceStatus !== "healthy")) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.sourceStatus", "Issuance mode does not match source status.");
  }
  if (verification.state !== resultChange.state) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_PLAN",
      "$.verification.state",
      "Verification state must match the result.",
    );
  }
  if (verification.canonicalBranch !== resultChange.projection?.branch) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_PLAN",
      "$.verification.canonicalBranch",
      "Verification branch must match the result projection.",
    );
  }

  if (mode === "create") {
    if (resultChange.state !== "DRAFT" || resultChange.projection?.pullRequest !== undefined) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_PLAN",
        "$.result",
        "A create issuance result must be a Draft Change without a preassigned pull request.",
      );
    }
    if (verification.pullRequest.number !== undefined) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_PLAN",
        "$.verification.pullRequest.number",
        "A create issuance plan cannot preassign a pull-request number.",
      );
    }
    const definedChange: Change = {
      version: CHANGE_CONTRACT_VERSION,
      identity: resultChange.identity,
      state: "DEFINED",
      provenance: resultChange.provenance,
    };
    let expectedTransition: ChangeTransitionPlan | undefined;
    try {
      expectedTransition = planChangeTransition({
        version: CHANGE_TRANSITION_CONTRACT_VERSION,
        transition: "issue",
        change: definedChange,
        target: {
          branch: verification.canonicalBranch,
          baseBranch: verification.canonicalBaseBranch,
        },
      });
    } catch (error: unknown) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_PLAN",
        "$.result",
        `Create issuance transition is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (expectedTransition !== undefined) {
      if (!canonicalPlanEquals(resultChange, expectedTransition.result)) {
        addDiagnostic(
          diagnostics,
          "CHANGE_INVALID_PLAN",
          "$.result",
          "Create result does not match the issue transition.",
        );
      }
      if (!canonicalPlanEquals(effects, expectedTransition.effects)) {
        addDiagnostic(
          diagnostics,
          "CHANGE_INVALID_PLAN",
          "$.effects",
          "Create effects do not match the issue transition.",
        );
      }
    }
  } else {
    if (!isChangeIssuanceHealthyState(resultChange.state) || resultChange.projection?.pullRequest === undefined) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_PLAN",
        "$.result",
        "A return-existing result must be a healthy canonical Change.",
      );
    }
    if (verification.pullRequest.number !== resultChange.projection?.pullRequest) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_PLAN",
        "$.verification.pullRequest.number",
        "Existing verification must identify the returned canonical pull request.",
      );
    }
    if (effects.length !== 0) {
      addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.effects", "Return-existing issuance must have no effects.");
    }
  }

  if (diagnostics.length > 0) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }

  return {
    valid: true,
    plan: {
      version: CHANGE_TRANSITION_CONTRACT_VERSION,
      operation: "issue",
      mode,
      sourceStatus,
      transaction: {
        operation: "issue",
        identity: resultChange.identity,
        idempotencyKey: expectedIdempotencyKey,
      },
      result: resultChange,
      effects,
      verification,
    },
    diagnostics: [],
  };
}

/** Assert a valid declarative issuance plan at an executor boundary. */
export function assertChangeIssuancePlan(input: unknown): asserts input is ChangeIssuancePlan {
  const result = validateChangeIssuancePlan(input);
  if (!result.valid) throw new ChangeIssuanceValidationError(result.diagnostics);
}

export function isChangeIssuancePlan(input: unknown): input is ChangeIssuancePlan {
  return validateChangeIssuancePlan(input).valid;
}

/** Serialize a canonical issuance plan with stable property ordering. */
export function serializeChangeIssuancePlan(input: unknown): string {
  const result = validateChangeIssuancePlan(input);
  if (!result.valid || result.plan === undefined) throw new ChangeIssuanceValidationError(result.diagnostics);
  const serialized = JSON.stringify(result.plan);
  if (serialized === undefined) throw new Error("Change issuance plan could not be serialized.");
  return serialized;
}

/** Parse and validate an untrusted issuance plan JSON boundary. */
export function deserializeChangeIssuancePlan(serialized: string): ChangeIssuancePlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new ChangeIssuanceValidationError([
      createChangeDiagnostic({
        code: "CHANGE_INVALID_JSON",
        message: safeMessage(
          `Change issuance plan must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      }),
    ]);
  }
  const result = validateChangeIssuancePlan(parsed);
  if (!result.valid || result.plan === undefined) throw new ChangeIssuanceValidationError(result.diagnostics);
  return result.plan;
}

export const parseChangeIssuancePlan = deserializeChangeIssuancePlan;
export const serializeChangeIssuancePlanContract = serializeChangeIssuancePlan;

export class ChangeIssuanceValidationError extends ChangeValidationError {
  constructor(diagnostics: readonly ChangeDiagnostic[]) {
    super(diagnostics);
    this.name = "ChangeIssuanceValidationError";
  }
}
