/**
 * The transport-independent semantic contract for a governed Change.
 *
 * This module owns transport-independent Change data, validation, canonical
 * serialization, pure canonical branch identity derivation, the lifecycle
 * transition matrix, and pure effect planning. It does not read or mutate
 * GitHub state or execute effects.
 */

import { deriveBranchName } from "../branch-naming-authority.mjs";
import { isTrustedInariIssuerPrincipal } from "./issuer-identity.js";

import {
  validateExistingIssueArtifact,
  validateExistingPullRequestArtifact,
  type ExistingArtifactValidationResult,
} from "./artifact.js";
import {
  issueReferenceKey,
  normalizeIssueReference,
  type IssueDependencyViolationCode,
} from "./contract/issue-reference.js";
import { validateCanonicalContract, type CanonicalContract, type PullRequestBranchGovernance } from "./contract/ir.js";
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
export const MAX_CHANGE_PR_TITLE_LENGTH = 255 as const;
export const MAX_CHANGE_PR_BODY_LENGTH = 65_536 as const;

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
  // A healthy REVIEW projection is a safe retry result, not a second
  // lifecycle mutation.  The plan for this edge is intentionally empty.
  { transition: "ready", from: "REVIEW", to: "REVIEW" },
  { transition: "abort", from: "DRAFT", to: "ABORTED" },
  { transition: "abort", from: "REVIEW", to: "ABORTED" },
  // An already terminated Change is a deterministic no-op on retry. A
  // RECOVERY_REQUIRED abort may retry only the remaining cleanup effect.
  { transition: "abort", from: "ABORTED", to: "ABORTED" },
  { transition: "abort", from: "RECOVERY_REQUIRED", to: "ABORTED" },
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
  "DELETE_BRANCH",
] as const);
export type ChangeEffectKind = (typeof CHANGE_EFFECT_KINDS)[number];

/** Core-owned abort cleanup policy. Only the canonical branch may be deleted. */
export const CHANGE_ABORT_CLEANUP_POLICY = "canonical-branch" as const;
export type ChangeAbortCleanupPolicy = typeof CHANGE_ABORT_CLEANUP_POLICY;

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
      /** Core-owned deterministic GitHub pull-request title. */
      readonly title: string;
      /** Core-owned deterministic initial body; never an Issue-conversion request. */
      readonly body: string;
      readonly draft: true;
    }
  | {
      readonly kind: "MARK_PULL_REQUEST_READY";
      readonly pullRequest: number;
    }
  | {
      readonly kind: "CLOSE_PULL_REQUEST";
      readonly pullRequest: number;
    }
  | {
      readonly kind: "DELETE_BRANCH";
      readonly branch: string;
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
  | "CHANGE_ISSUANCE_ROOT_ISSUE_ABSENT"
  | "CHANGE_PROVENANCE_INVALID_INPUT"
  | "CHANGE_PROVENANCE_IDENTITY_MISMATCH"
  | "CHANGE_PROVENANCE_ROOT_ISSUE_MISMATCH"
  | "CHANGE_PROVENANCE_BRANCH_MISMATCH"
  | "CHANGE_PROVENANCE_BASE_MISMATCH"
  | "CHANGE_PROVENANCE_PULL_REQUEST_MISMATCH"
  | "CHANGE_PROVENANCE_INVALID_ISSUER"
  | "CHANGE_PROVENANCE_ISSUER_MISMATCH"
  | "CHANGE_PROVENANCE_INVALID_PR_CONTRACT"
  | "CHANGE_PROVENANCE_CONFLICT";

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

export interface ChangeProjectionResultValidationResult {
  readonly valid: boolean;
  readonly projection?: ChangeProjectionResult;
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
  /** Additional bounded artifact evidence consumed only by Ready validation. */
  readonly readyEvidence?: ChangeReadyEvidence;
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

/** The governed PR body/contract pair checked at merge admission. */
export interface ChangeMergeAdmissionPullRequest {
  /** A repository-governed canonical PR contract, not a caller-authored schema. */
  readonly contract: CanonicalContract;
  /** The physical PR body read from GitHub. */
  readonly body: string | null;
}

/**
 * Inputs to the pure merge-admission provenance validator.
 *
 * `change` is the already-issued canonical snapshot. `projection` is the
 * bounded #213 evidence input and is deliberately separate from the physical
 * PR body. `issuance` is optional for callers that retain the #214 transaction
 * record; when present it is checked as an additional canonical authority.
 */
export interface ChangeMergeAdmissionInput {
  readonly change: Change;
  readonly projection: ChangeProjectionInput | ChangeProjectionResult;
  readonly issuance?: ChangeIssuancePlan;
  readonly pullRequest: ChangeMergeAdmissionPullRequest;
  /** Optional explicit issuer assertion from the trusted caller. */
  readonly issuer?: string;
}

/** Result consumed by a later required-check projection. */
export interface ChangeMergeAdmissionValidationResult {
  readonly valid: boolean;
  /** Present only for a valid canonical Change admission. */
  readonly change?: Change;
  /** The fresh #213 projection used for the decision. */
  readonly projection?: ChangeProjectionResult;
  /** Physical evidence; this is never promoted to canonical identity. */
  readonly physicalPullRequest?: ChangePullRequestEvidence;
  readonly diagnostics: readonly ChangeDiagnostic[];
}

/** A governed artifact body paired with the Core-resolved canonical contract. */
export interface ChangeReadyArtifactEvidence {
  readonly contract: CanonicalContract;
  readonly body: string | null;
}

/** Fresh evidence required by the governed DRAFT -> REVIEW transition. */
export interface ChangeReadyEvidence {
  readonly issue: ChangeReadyArtifactEvidence;
  readonly pullRequest: ChangeMergeAdmissionPullRequest;
}

/** Inputs to the Core-owned Ready precondition gate. */
export interface ChangeReadyTransitionInput {
  readonly change: Change;
  readonly projection: ChangeProjectionInput | ChangeProjectionResult;
  readonly issue: ChangeReadyArtifactEvidence;
  readonly pullRequest: ChangeMergeAdmissionPullRequest;
  /** Optional explicit issuer assertion from the trusted caller. */
  readonly issuer?: string;
}

export interface ChangeReadyTransitionValidationResult {
  readonly valid: boolean;
  readonly change?: Change;
  readonly projection?: ChangeProjectionResult;
  readonly physicalPullRequest?: ChangePullRequestEvidence;
  /** True only when the validated healthy projection is already REVIEW. */
  readonly idempotent?: boolean;
  readonly diagnostics: readonly ChangeDiagnostic[];
}

/** Naming aliases for adapters that describe the same admission boundary. */
export type ChangeProvenanceValidationInput = ChangeMergeAdmissionInput;
export type ChangeCanonicalProvenanceInput = ChangeMergeAdmissionInput;
export type ChangeCanonicalProvenanceValidationResult = ChangeMergeAdmissionValidationResult;

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

/** Outcomes recorded by a transport-independent issuance effect journal. */
export const CHANGE_ISSUANCE_EFFECT_STATUSES = Object.freeze(["succeeded", "failed"] as const);
export type ChangeIssuanceEffectStatus = (typeof CHANGE_ISSUANCE_EFFECT_STATUSES)[number];

/** One bounded effect attempt, including the failed effect when present. */
export interface ChangeIssuanceEffectAttempt {
  readonly effect: ChangeEffect;
  readonly status: ChangeIssuanceEffectStatus;
}

export type ChangeIssuanceAttemptedEffect = ChangeIssuanceEffectAttempt;

/** Bounded executor failure evidence; it contains no transport or credential. */
export interface ChangeIssuanceFailureEvidence {
  readonly effect: ChangeEffect;
  readonly code: string;
  readonly message: string;
}

export const CHANGE_ISSUANCE_COMPENSATION_STATUSES = Object.freeze(["required", "succeeded", "failed"] as const);
export type ChangeIssuanceCompensationStatus = (typeof CHANGE_ISSUANCE_COMPENSATION_STATUSES)[number];

export const CHANGE_ISSUANCE_RECOVERY_STATUSES = Object.freeze([
  "compensation-required",
  "compensated",
  "recovery-required",
] as const);
export type ChangeIssuanceRecoveryStatus = (typeof CHANGE_ISSUANCE_RECOVERY_STATUSES)[number];

/** Verification authority for the desired post-compensation absent projection. */
export interface ChangeIssuanceCompensationVerificationExpectation {
  readonly phase: "post-compensation";
  readonly status: "absent";
  readonly canonicalBranch: string;
  readonly canonicalBaseBranch: string;
  readonly state: "DEFINED";
  readonly pullRequest: {
    readonly required: false;
  };
}

/** Bounded failure evidence retained by a compensation or recovery plan. */
export interface ChangeIssuanceFailureRecord {
  readonly attemptedEffects: readonly ChangeIssuanceEffectAttempt[];
  readonly failure: ChangeIssuanceFailureEvidence;
  readonly projection: ChangeProjectionResult;
}

/** One explicit branch-compensation plan; it is never executed by this module. */
export interface ChangeIssuanceCompensationPlan {
  readonly version: ChangeTransitionContractVersion;
  readonly operation: "compensate-issue";
  readonly transaction: ChangeIssuanceTransaction;
  /** The original #214 issuance plan remains the transaction authority. */
  readonly issuance: ChangeIssuancePlan;
  readonly failureEvidence: ChangeIssuanceFailureRecord;
  readonly effects: readonly ChangeEffect[];
  readonly verification: ChangeIssuanceCompensationVerificationExpectation;
}

export type ChangeCompensationPlan = ChangeIssuanceCompensationPlan;

/** Input evidence for a compensation result. */
export interface ChangeIssuanceCompensationOutcomeInput {
  readonly status: Exclude<ChangeIssuanceCompensationStatus, "required">;
  /** Reuses #213 projection input/evidence authority. */
  readonly projection: ChangeProjectionInput;
  readonly failure?: ChangeIssuanceFailureEvidence;
}

/** Normalized, bounded compensation outcome retained in a recovery plan. */
export interface ChangeIssuanceCompensationOutcome {
  readonly status: Exclude<ChangeIssuanceCompensationStatus, "required">;
  readonly evidence: ChangeProjectionResult;
  readonly failure?: ChangeIssuanceFailureEvidence;
}

export interface ChangeIssuanceRecoveryResult {
  readonly status: ChangeIssuanceRecoveryStatus;
  /** The lifecycle state is explicit even when no valid Change was issued. */
  readonly state: "DEFINED" | "RECOVERY_REQUIRED";
  readonly issued: false;
  readonly change: Change;
}

/** Input to pure issuance compensation/recovery planning. */
export interface ChangeIssuanceRecoveryInput {
  readonly issuance: ChangeIssuancePlan;
  readonly attemptedEffects: readonly ChangeIssuanceEffectAttempt[];
  readonly failure: ChangeIssuanceFailureEvidence;
  /** The bounded post-failure projection read used to prove a safe delete. */
  readonly projection: ChangeProjectionInput;
  readonly compensation?: ChangeIssuanceCompensationOutcomeInput;
}

export type ChangeIssuanceCompensationInput = Omit<ChangeIssuanceRecoveryInput, "compensation">;

/** One deterministic recovery plan retaining all failure and repair evidence. */
export interface ChangeIssuanceRecoveryPlan {
  readonly version: ChangeTransitionContractVersion;
  readonly operation: "recover-issue";
  readonly transaction: ChangeIssuanceTransaction;
  readonly issuance: ChangeIssuancePlan;
  readonly failureEvidence: ChangeIssuanceFailureRecord;
  readonly compensation: {
    readonly status: ChangeIssuanceCompensationStatus;
    readonly plan: ChangeIssuanceCompensationPlan;
    readonly outcome?: ChangeIssuanceCompensationOutcome;
  };
  readonly result: ChangeIssuanceRecoveryResult;
}

/** Generic recovery result for any already-planned lifecycle transition. */
export interface ChangeTransitionRecoveryResult {
  readonly status: "recovery-required";
  readonly state: "RECOVERY_REQUIRED";
  readonly change: Change;
}

/**
 * Shared transition recovery plan. It is deliberately transition-generic:
 * abort cleanup reuses this authority instead of introducing an abort-only
 * recovery state machine.
 */
export interface ChangeTransitionRecoveryPlan {
  readonly version: ChangeTransitionContractVersion;
  readonly operation: "recover-transition";
  readonly transition: ChangeTransitionPlan;
  readonly failureEvidence: ChangeIssuanceFailureRecord;
  /** Ordered effects still required to retry the failed transition. */
  readonly effects: readonly ChangeEffect[];
  readonly result: ChangeTransitionRecoveryResult;
}

export type ChangeRecoveryPlan = ChangeIssuanceRecoveryPlan | ChangeTransitionRecoveryPlan;

export interface ChangeIssuanceCompensationPlanValidationResult {
  readonly valid: boolean;
  readonly plan?: ChangeIssuanceCompensationPlan;
  readonly diagnostics: readonly ChangeDiagnostic[];
}

export interface ChangeIssuanceRecoveryPlanValidationResult {
  readonly valid: boolean;
  readonly plan?: ChangeIssuanceRecoveryPlan;
  readonly diagnostics: readonly ChangeDiagnostic[];
}

export interface ChangeTransitionRecoveryPlanValidationResult {
  readonly valid: boolean;
  readonly plan?: ChangeTransitionRecoveryPlan;
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
  "CHANGE_PROVENANCE_INVALID_INPUT",
  "CHANGE_PROVENANCE_IDENTITY_MISMATCH",
  "CHANGE_PROVENANCE_ROOT_ISSUE_MISMATCH",
  "CHANGE_PROVENANCE_BRANCH_MISMATCH",
  "CHANGE_PROVENANCE_BASE_MISMATCH",
  "CHANGE_PROVENANCE_PULL_REQUEST_MISMATCH",
  "CHANGE_PROVENANCE_INVALID_ISSUER",
  "CHANGE_PROVENANCE_ISSUER_MISMATCH",
  "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
  "CHANGE_PROVENANCE_CONFLICT",
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
const EFFECT_KEYS = new Set(["kind", "branch", "baseBranch", "rootIssue", "title", "body", "draft", "pullRequest"]);
const CHANGE_PROJECTION_INPUT_KEYS = new Set([
  "change",
  "branchGovernance",
  "naming",
  "baseBranch",
  "evidence",
  "provenance",
  "readyEvidence",
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
const CHANGE_ISSUANCE_ATTEMPT_KEYS = new Set(["effect", "status"]);
const CHANGE_ISSUANCE_FAILURE_KEYS = new Set(["effect", "code", "message"]);
const CHANGE_ISSUANCE_FAILURE_RECORD_KEYS = new Set(["attemptedEffects", "failure", "projection"]);
const CHANGE_ISSUANCE_COMPENSATION_PLAN_KEYS = new Set([
  "version",
  "operation",
  "transaction",
  "issuance",
  "failureEvidence",
  "effects",
  "verification",
]);
const CHANGE_ISSUANCE_COMPENSATION_VERIFICATION_KEYS = new Set([
  "phase",
  "status",
  "canonicalBranch",
  "canonicalBaseBranch",
  "state",
  "pullRequest",
]);
const CHANGE_ISSUANCE_RECOVERY_INPUT_KEYS = new Set([
  "issuance",
  "attemptedEffects",
  "failure",
  "projection",
  "compensation",
]);
const CHANGE_ISSUANCE_COMPENSATION_OUTCOME_INPUT_KEYS = new Set(["status", "projection", "failure"]);
const CHANGE_ISSUANCE_RECOVERY_PLAN_KEYS = new Set([
  "version",
  "operation",
  "transaction",
  "issuance",
  "failureEvidence",
  "compensation",
  "result",
]);
const CHANGE_ISSUANCE_RECOVERY_COMPENSATION_KEYS = new Set(["status", "plan", "outcome"]);
const CHANGE_ISSUANCE_COMPENSATION_OUTCOME_KEYS = new Set(["status", "evidence", "failure"]);
const CHANGE_ISSUANCE_RECOVERY_RESULT_KEYS = new Set(["status", "state", "issued", "change"]);
const CHANGE_PROJECTION_RESULT_KEYS = new Set([
  "valid",
  "status",
  "canonicalBranch",
  "canonicalBaseBranch",
  "candidates",
  "change",
  "diagnostics",
]);
const CHANGE_MERGE_ADMISSION_INPUT_KEYS = new Set([
  "change",
  "projection",
  "issuance",
  "pullRequest",
  "issuer",
  "canonicalChange",
  "canonical",
  "projectionInput",
  "projectionResult",
  "issuancePlan",
  "governedPullRequest",
  "pullRequestContract",
  "pullRequestBody",
  "prContract",
  "prBody",
  "contract",
  "body",
  "expectedIssuer",
  "branchGovernance",
  "naming",
  "baseBranch",
  "evidence",
  "provenance",
]);
const CHANGE_MERGE_ADMISSION_PULL_REQUEST_KEYS = new Set(["contract", "body"]);
const CHANGE_READY_INPUT_KEYS = new Set([
  "change",
  "projection",
  "issue",
  "rootIssue",
  "issueArtifact",
  "rootIssueArtifact",
  "pullRequest",
  "governedPullRequest",
  "issuer",
  "expectedIssuer",
  "canonicalChange",
  "canonical",
  "projectionInput",
  "projectionResult",
  "issueContract",
  "rootIssueContract",
  "issueBody",
  "rootIssueBody",
  "pullRequestContract",
  "prContract",
  "pullRequestBody",
  "prBody",
  "contract",
  "body",
  "branchGovernance",
  "naming",
  "baseBranch",
  "evidence",
  "provenance",
  "readyEvidence",
]);
const CHANGE_READY_ARTIFACT_KEYS = new Set(["contract", "body"]);
const CHANGE_PROJECTION_CANDIDATES_KEYS = new Set(["branches", "pullRequests"]);
const CHANGE_PROJECTION_CANDIDATE_KEYS = new Set(["candidate", "classification", "reason"]);
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
export const MAX_CHANGE_ISSUANCE_ATTEMPTS = MAX_CHANGE_TRANSITION_EFFECTS;
export const MAX_CHANGE_FAILURE_CODE_LENGTH = 80 as const;
/** Bodies are read through a bounded transport before entering Core. */
export const MAX_CHANGE_ARTIFACT_BODY_LENGTH = 1_048_576 as const;

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
    candidate.number !== rootIssue &&
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
    if (candidate.number === rootIssue) {
      return {
        candidate,
        classification: "conflicting",
        reason: "The canonical pull request number must be distinct from the root Issue number.",
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
  const historicalAbortedPullRequest =
    canonicalBranches.length === 0 &&
    canonicalPullRequests.length === 1 &&
    canonicalPullRequests[0]?.state === "closed" &&
    canonicalPullRequests[0]?.merged === false &&
    issue !== undefined;
  const incompleteAbortedCleanup =
    canonicalBranches.length === 1 &&
    canonicalPullRequests.length === 1 &&
    canonicalPullRequests[0]?.state === "closed" &&
    canonicalPullRequests[0]?.merged === false &&
    issue !== undefined;
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
  } else if (incompleteAbortedCleanup) {
    // Under the Core abort policy a closed, unmerged PR with its canonical
    // branch still present is an incomplete cleanup, not a successful abort.
    status = "partial";
  } else if (historicalAbortedPullRequest) {
    // A closed canonical PR retains the branch identity in GitHub evidence,
    // so an explicitly deleted branch does not erase historical provenance.
    status = "healthy";
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

/**
 * The initial Draft PR metadata is semantic Change data, not adapter policy.
 * Keep this payload intentionally small: implementation details and governed
 * PR fields are completed by the later Ready admission path.
 */
function initialChangePullRequestPayload(rootIssue: number): { readonly title: string; readonly body: string } {
  return {
    title: `Change #${rootIssue}`,
    body: `Closes #${rootIssue}`,
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
    const pullRequestPayload = initialChangePullRequestPayload(request.change.identity.rootIssue);
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
        ...pullRequestPayload,
        draft: true,
      },
    );
  } else if (request.transition === "ready") {
    if (resolved.pullRequest === undefined) throw new Error("A valid ready request must resolve a pull request.");
    if (rule.from === "DRAFT") {
      effects.push({ kind: "MARK_PULL_REQUEST_READY", pullRequest: resolved.pullRequest });
    }
  } else if (request.transition === "abort") {
    if (resolved.pullRequest === undefined) throw new Error("A valid abort request must resolve a pull request.");
    if (request.change.state === "ABORTED") {
      // A historical aborted Change is already fully terminated. In
      // particular, do not issue duplicate close/delete mutations.
    } else if (request.change.state === "RECOVERY_REQUIRED") {
      // Recovery retries only the remaining canonical cleanup effect. The
      // trusted executor admits this edge only for closed canonical PR
      // evidence; Core remains the sole effect planner.
      if (resolved.branch === undefined) throw new Error("A recovery retry must resolve a canonical branch.");
      effects.push({ kind: "DELETE_BRANCH", branch: resolved.branch });
    } else {
      effects.push(
        { kind: "CLOSE_PULL_REQUEST", pullRequest: resolved.pullRequest },
        { kind: "DELETE_BRANCH", branch: resolved.branch! },
      );
    }
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

function requiredEffectText(
  input: RecordValue,
  key: "title" | "body",
  path: string,
  maxLength: number,
  diagnostics: ChangeDiagnostic[],
): string | undefined {
  if (!hasOwn(input, key)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_EFFECT", `${path}.${key}`, "Effect property is required.");
    return undefined;
  }
  const value = input[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_EFFECT", `${path}.${key}`, "Effect text is invalid.");
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
    const allowed = new Set(["kind", "branch", "baseBranch", "rootIssue", "title", "body", "draft"]);
    rejectEffectProperties(input, allowed, path, diagnostics);
    const branch = requiredEffectBranch(input, "branch", path, MAX_CHANGE_BRANCH_LENGTH, diagnostics);
    const baseBranch = requiredEffectBranch(input, "baseBranch", path, MAX_CHANGE_BASE_BRANCH_LENGTH, diagnostics);
    const rootIssue = requiredEffectNumber(input, "rootIssue", path, diagnostics);
    const title = requiredEffectText(input, "title", path, MAX_CHANGE_PR_TITLE_LENGTH, diagnostics);
    const body = requiredEffectText(input, "body", path, MAX_CHANGE_PR_BODY_LENGTH, diagnostics);
    if (!hasOwn(input, "draft") || input.draft !== true) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_EFFECT",
        `${path}.draft`,
        "Create pull request effects must be draft.",
      );
    }
    if (
      diagnostics.length > 0 ||
      branch === undefined ||
      baseBranch === undefined ||
      rootIssue === undefined ||
      title === undefined ||
      body === undefined
    ) {
      return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    return { valid: true, effect: { kind, branch, baseBranch, rootIssue, title, body, draft: true }, diagnostics: [] };
  }

  if (kind === "DELETE_BRANCH") {
    const allowed = new Set(["kind", "branch"]);
    rejectEffectProperties(input, allowed, path, diagnostics);
    const branch = requiredEffectBranch(input, "branch", path, MAX_CHANGE_BRANCH_LENGTH, diagnostics);
    if (diagnostics.length > 0 || branch === undefined) {
      return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    return { valid: true, effect: { kind, branch }, diagnostics: [] };
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

function validateChangeIssuanceEffectAttempts(
  input: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): ChangeIssuanceEffectAttempt[] {
  if (!Array.isArray(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Attempted effects must be an array.");
    return [];
  }
  if (input.length > MAX_CHANGE_ISSUANCE_ATTEMPTS) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_PLAN",
      path,
      `At most ${MAX_CHANGE_ISSUANCE_ATTEMPTS} attempted effects are supported.`,
    );
  }
  const attempts: ChangeIssuanceEffectAttempt[] = [];
  for (let index = 0; index < input.length && diagnostics.length < MAX_CHANGE_DIAGNOSTICS; index += 1) {
    const attempt = input[index];
    const before = diagnostics.length;
    if (!isRecord(attempt)) {
      addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}[${index}]`, "Effect attempt must be an object.");
      continue;
    }
    addUnknownProperties(attempt, CHANGE_ISSUANCE_ATTEMPT_KEYS, `${path}[${index}]`, diagnostics);
    const effectResult = validateChangeEffect(attempt.effect, `${path}[${index}].effect`);
    diagnostics.push(...effectResult.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    if (!CHANGE_ISSUANCE_EFFECT_STATUSES.includes(attempt.status as ChangeIssuanceEffectStatus)) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_PLAN",
        `${path}[${index}].status`,
        "Effect attempt status is unsupported.",
      );
    }
    if (
      diagnostics.length === before &&
      effectResult.effect !== undefined &&
      CHANGE_ISSUANCE_EFFECT_STATUSES.includes(attempt.status as ChangeIssuanceEffectStatus)
    ) {
      attempts.push({ effect: effectResult.effect, status: attempt.status as ChangeIssuanceEffectStatus });
    }
  }
  return attempts;
}

function validateChangeIssuanceFailureEvidence(
  input: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): ChangeIssuanceFailureEvidence | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Failure evidence must be an object.");
    return undefined;
  }
  addUnknownProperties(input, CHANGE_ISSUANCE_FAILURE_KEYS, path, diagnostics);
  const effectResult = validateChangeEffect(input.effect, `${path}.effect`);
  diagnostics.push(...effectResult.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
  const code = issuancePlanText(
    input.code,
    `${path}.code`,
    "Failure code",
    MAX_CHANGE_FAILURE_CODE_LENGTH,
    diagnostics,
  );
  const message = issuancePlanText(
    input.message,
    `${path}.message`,
    "Failure message",
    MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH,
    diagnostics,
  );
  if (diagnostics.length > 0 || effectResult.effect === undefined || code === undefined || message === undefined) {
    return undefined;
  }
  return { effect: effectResult.effect, code, message };
}

function validateChangeProjectionCandidateBranch(
  input: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): ChangeProjectionCandidate<ChangeBranchEvidence> | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Branch projection candidate must be an object.");
    return undefined;
  }
  addUnknownProperties(input, CHANGE_PROJECTION_CANDIDATE_KEYS, path, diagnostics);
  const candidateDiagnostics: ChangeDiagnostic[] = [];
  const candidate = parseChangeBranchEvidence(input.candidate, `${path}.candidate`, candidateDiagnostics);
  diagnostics.push(...candidateDiagnostics);
  const classification = input.classification;
  if (
    typeof classification !== "string" ||
    !CHANGE_PROJECTION_CANDIDATE_CLASSES.includes(classification as ChangeProjectionCandidateClass)
  ) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_PLAN",
      `${path}.classification`,
      "Projection candidate classification is invalid.",
    );
  }
  const reason = issuancePlanText(
    input.reason,
    `${path}.reason`,
    "Projection candidate reason",
    MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH,
    diagnostics,
  );
  if (
    candidate === undefined ||
    reason === undefined ||
    typeof classification !== "string" ||
    !CHANGE_PROJECTION_CANDIDATE_CLASSES.includes(classification as ChangeProjectionCandidateClass)
  ) {
    return undefined;
  }
  return {
    candidate,
    classification: classification as ChangeProjectionCandidateClass,
    reason,
  };
}

function validateChangeProjectionCandidatePullRequest(
  input: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): ChangeProjectionCandidate<ChangePullRequestEvidence> | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Pull-request projection candidate must be an object.");
    return undefined;
  }
  addUnknownProperties(input, CHANGE_PROJECTION_CANDIDATE_KEYS, path, diagnostics);
  const candidateDiagnostics: ChangeDiagnostic[] = [];
  const candidate = parseChangePullRequestEvidence(input.candidate, `${path}.candidate`, candidateDiagnostics);
  diagnostics.push(...candidateDiagnostics);
  const classification = input.classification;
  if (
    typeof classification !== "string" ||
    !CHANGE_PROJECTION_CANDIDATE_CLASSES.includes(classification as ChangeProjectionCandidateClass)
  ) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_PLAN",
      `${path}.classification`,
      "Projection candidate classification is invalid.",
    );
  }
  const reason = issuancePlanText(
    input.reason,
    `${path}.reason`,
    "Projection candidate reason",
    MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH,
    diagnostics,
  );
  if (
    candidate === undefined ||
    reason === undefined ||
    typeof classification !== "string" ||
    !CHANGE_PROJECTION_CANDIDATE_CLASSES.includes(classification as ChangeProjectionCandidateClass)
  ) {
    return undefined;
  }
  return {
    candidate,
    classification: classification as ChangeProjectionCandidateClass,
    reason,
  };
}

function parseChangeProjectionResult(
  input: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): ChangeProjectionResult | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Projection evidence must be an object.");
    return undefined;
  }
  addUnknownProperties(input, CHANGE_PROJECTION_RESULT_KEYS, path, diagnostics);
  if (typeof input.valid !== "boolean") {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.valid`, "Projection evidence validity is invalid.");
  }
  if (
    typeof input.status !== "string" ||
    !CHANGE_PROJECTION_STATUSES.includes(input.status as ChangeProjectionStatus)
  ) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.status`, "Projection evidence status is invalid.");
  }

  let canonicalBranch: string | undefined;
  if (hasOwn(input, "canonicalBranch")) {
    canonicalBranch = issuancePlanText(
      input.canonicalBranch,
      `${path}.canonicalBranch`,
      "Canonical branch",
      MAX_CHANGE_BRANCH_LENGTH,
      diagnostics,
    );
  }
  let canonicalBaseBranch: string | undefined;
  if (hasOwn(input, "canonicalBaseBranch")) {
    canonicalBaseBranch = issuancePlanText(
      input.canonicalBaseBranch,
      `${path}.canonicalBaseBranch`,
      "Canonical base branch",
      MAX_CHANGE_BASE_BRANCH_LENGTH,
      diagnostics,
    );
  }

  const candidatesValue = input.candidates;
  let branches: ChangeProjectionCandidate<ChangeBranchEvidence>[] = [];
  let pullRequests: ChangeProjectionCandidate<ChangePullRequestEvidence>[] = [];
  if (!isRecord(candidatesValue)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.candidates`, "Projection candidates must be an object.");
  } else {
    addUnknownProperties(candidatesValue, CHANGE_PROJECTION_CANDIDATES_KEYS, `${path}.candidates`, diagnostics);
    if (!Array.isArray(candidatesValue.branches)) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_PLAN",
        `${path}.candidates.branches`,
        "Branch candidates must be an array.",
      );
    } else if (candidatesValue.branches.length > MAX_CHANGE_PROJECTION_CANDIDATES) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_PLAN",
        `${path}.candidates.branches`,
        `At most ${MAX_CHANGE_PROJECTION_CANDIDATES} branch candidates are supported.`,
      );
    } else {
      for (let index = 0; index < candidatesValue.branches.length; index += 1) {
        const candidate = validateChangeProjectionCandidateBranch(
          candidatesValue.branches[index],
          `${path}.candidates.branches[${index}]`,
          diagnostics,
        );
        if (candidate !== undefined) branches.push(candidate);
      }
    }
    if (!Array.isArray(candidatesValue.pullRequests)) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_PLAN",
        `${path}.candidates.pullRequests`,
        "Pull-request candidates must be an array.",
      );
    } else if (candidatesValue.pullRequests.length > MAX_CHANGE_PROJECTION_CANDIDATES) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_PLAN",
        `${path}.candidates.pullRequests`,
        `At most ${MAX_CHANGE_PROJECTION_CANDIDATES} pull-request candidates are supported.`,
      );
    } else {
      for (let index = 0; index < candidatesValue.pullRequests.length; index += 1) {
        const candidate = validateChangeProjectionCandidatePullRequest(
          candidatesValue.pullRequests[index],
          `${path}.candidates.pullRequests[${index}]`,
          diagnostics,
        );
        if (candidate !== undefined) pullRequests.push(candidate);
      }
    }
  }

  let change: Change | undefined;
  if (hasOwn(input, "change")) {
    const result = validateChange(input.change);
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    change = result.change;
  }

  let projectionDiagnostics: readonly ChangeDiagnostic[] = [];
  if (!Array.isArray(input.diagnostics) || input.diagnostics.length > MAX_CHANGE_DIAGNOSTICS) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.diagnostics`, "Projection diagnostics are invalid.");
  } else if (!input.diagnostics.every(isDiagnostic)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.diagnostics`, "Projection diagnostics are invalid.");
  } else {
    try {
      projectionDiagnostics = createChangeDiagnosticReport(input.diagnostics).diagnostics;
    } catch {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_PLAN",
        `${path}.diagnostics`,
        "Projection diagnostics exceed their bounds.",
      );
    }
  }

  branches = branches.sort(
    (left, right) =>
      compareText(left.candidate.name, right.candidate.name) ||
      compareText(left.classification, right.classification) ||
      compareText(left.reason, right.reason),
  );
  pullRequests = pullRequests.sort(
    (left, right) =>
      compareChangePullRequestEvidence(
        left.candidate as NormalizedChangePullRequestEvidence,
        right.candidate as NormalizedChangePullRequestEvidence,
      ) ||
      compareText(left.classification, right.classification) ||
      compareText(left.reason, right.reason),
  );

  if (typeof input.valid === "boolean" && typeof input.status === "string") {
    const status = input.status as ChangeProjectionStatus;
    if (CHANGE_PROJECTION_STATUSES.includes(status) && input.valid !== (status === "healthy" || status === "absent")) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_PLAN",
        `${path}.valid`,
        "Projection validity does not match its status.",
      );
    }
  }
  if (
    diagnostics.length > 0 ||
    typeof input.valid !== "boolean" ||
    typeof input.status !== "string" ||
    !CHANGE_PROJECTION_STATUSES.includes(input.status as ChangeProjectionStatus) ||
    !Array.isArray(input.diagnostics)
  ) {
    return undefined;
  }
  return {
    valid: input.valid,
    status: input.status as ChangeProjectionStatus,
    ...(canonicalBranch === undefined ? {} : { canonicalBranch }),
    ...(canonicalBaseBranch === undefined ? {} : { canonicalBaseBranch }),
    candidates: { branches, pullRequests },
    ...(change === undefined ? {} : { change }),
    diagnostics: projectionDiagnostics,
  };
}

/** Validate one bounded projection at a transport or package boundary. */
export function validateChangeProjectionResult(input: unknown): ChangeProjectionResultValidationResult {
  const diagnostics: ChangeDiagnostic[] = [];
  const projection = parseChangeProjectionResult(input, "$", diagnostics);
  if (projection === undefined || diagnostics.length > 0) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  return { valid: true, projection, diagnostics: [] };
}

/** Assert that an executor returned the bounded Change projection contract. */
export function assertChangeProjectionResult(input: unknown): asserts input is ChangeProjectionResult {
  const result = validateChangeProjectionResult(input);
  if (!result.valid || result.projection === undefined) throw new ChangeValidationError(result.diagnostics);
}

function validateChangeIssuanceFailureRecord(
  input: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): ChangeIssuanceFailureRecord | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Issuance failure evidence must be an object.");
    return undefined;
  }
  addUnknownProperties(input, CHANGE_ISSUANCE_FAILURE_RECORD_KEYS, path, diagnostics);
  const attemptedEffects = validateChangeIssuanceEffectAttempts(
    input.attemptedEffects,
    `${path}.attemptedEffects`,
    diagnostics,
  );
  const failure = validateChangeIssuanceFailureEvidence(input.failure, `${path}.failure`, diagnostics);
  let projection: ChangeProjectionResult | undefined;
  if (!hasOwn(input, "projection")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", `${path}.projection`, "Property is required.");
  } else {
    projection = parseChangeProjectionResult(input.projection, `${path}.projection`, diagnostics);
  }
  if (diagnostics.length > 0 || failure === undefined || projection === undefined) return undefined;
  return { attemptedEffects, failure, projection };
}

function validateChangeIssuanceCompensationVerification(
  input: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): ChangeIssuanceCompensationVerificationExpectation | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Compensation verification expectation must be an object.");
    return undefined;
  }
  addUnknownProperties(input, CHANGE_ISSUANCE_COMPENSATION_VERIFICATION_KEYS, path, diagnostics);
  if (input.phase !== "post-compensation") {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.phase`, "Compensation verification phase is invalid.");
  }
  if (input.status !== "absent") {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_PLAN",
      `${path}.status`,
      "Compensation verification must prove absence.",
    );
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
  if (input.state !== "DEFINED") {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_PLAN",
      `${path}.state`,
      "Compensation verification state must be DEFINED.",
    );
  }
  if (!isRecord(input.pullRequest)) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_PLAN",
      `${path}.pullRequest`,
      "Pull-request verification must be an object.",
    );
  } else {
    const allowed = new Set(["required"]);
    rejectEffectProperties(input.pullRequest, allowed, `${path}.pullRequest`, diagnostics);
    if (input.pullRequest.required !== false) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_PLAN",
        `${path}.pullRequest.required`,
        "Compensation verification must not require a pull request.",
      );
    }
  }
  if (diagnostics.length > 0 || canonicalBranch === undefined || canonicalBaseBranch === undefined) return undefined;
  return {
    phase: "post-compensation",
    status: "absent",
    canonicalBranch,
    canonicalBaseBranch,
    state: "DEFINED",
    pullRequest: { required: false },
  };
}

function sameChangeIdentity(left: ChangeIdentity, right: ChangeIdentity): boolean {
  return canonicalPlanEquals(left, right);
}

function sameEffect(left: ChangeEffect, right: ChangeEffect): boolean {
  return canonicalPlanEquals(left, right);
}

function sameFailureEvidence(left: ChangeIssuanceFailureEvidence, right: ChangeIssuanceFailureEvidence): boolean {
  return canonicalPlanEquals(left, right);
}

function addRecoverySemanticDiagnostic(diagnostics: ChangeDiagnostic[], path: string, message: string): void {
  addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, message);
}

function validateCreateIssuanceFailureSemantics(
  issuance: ChangeIssuancePlan,
  attemptedEffects: readonly ChangeIssuanceEffectAttempt[],
  failure: ChangeIssuanceFailureEvidence,
  diagnostics: ChangeDiagnostic[],
): void {
  if (issuance.mode !== "create" || issuance.sourceStatus !== "absent") {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.issuance",
      "Compensation is only valid for a create issuance from an absent Change.",
    );
  }
  if (issuance.effects.length !== 2) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.issuance.effects",
      "A compensable issuance must contain the ordered branch and Draft pull-request effects.",
    );
    return;
  }
  if (attemptedEffects.length !== 2) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.failureEvidence.attemptedEffects",
      "A compensable issuance must record both ordered effect attempts.",
    );
  } else {
    const [branchAttempt, pullRequestAttempt] = attemptedEffects;
    if (!sameEffect(branchAttempt.effect, issuance.effects[0]) || branchAttempt.status !== "succeeded") {
      addRecoverySemanticDiagnostic(
        diagnostics,
        "$.failureEvidence.attemptedEffects[0]",
        "Canonical branch creation must be the first successful attempted effect.",
      );
    }
    if (!sameEffect(pullRequestAttempt.effect, issuance.effects[1]) || pullRequestAttempt.status !== "failed") {
      addRecoverySemanticDiagnostic(
        diagnostics,
        "$.failureEvidence.attemptedEffects[1]",
        "Canonical Draft pull-request creation must be the failed second effect.",
      );
    }
  }
  if (!sameEffect(failure.effect, issuance.effects[1])) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.failureEvidence.failure.effect",
      "Failure evidence must identify the canonical Draft pull-request effect.",
    );
  }
}

function validateFailureProjectionIdentity(
  issuance: ChangeIssuancePlan,
  projection: ChangeProjectionResult,
  path: string,
  diagnostics: ChangeDiagnostic[],
): void {
  const expectedBranch = issuance.verification.canonicalBranch;
  const expectedBaseBranch = issuance.verification.canonicalBaseBranch;
  if (projection.canonicalBranch !== expectedBranch) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      `${path}.canonicalBranch`,
      "Projection evidence branch does not match issuance.",
    );
  }
  if (projection.canonicalBaseBranch !== expectedBaseBranch) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      `${path}.canonicalBaseBranch`,
      "Projection evidence base branch does not match issuance.",
    );
  }
  if (
    projection.change !== undefined &&
    !sameChangeIdentity(projection.change.identity, issuance.transaction.identity)
  ) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      `${path}.change.identity`,
      "Projection evidence identity does not match issuance.",
    );
  }
}

function validateCompensationPlanEffects(
  effects: readonly ChangeEffect[],
  expectedBranch: string,
  path: string,
  diagnostics: ChangeDiagnostic[],
): void {
  if (effects.length !== 1 || effects[0]?.kind !== "DELETE_BRANCH" || effects[0].branch !== expectedBranch) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      path,
      "Compensation must contain exactly one delete effect for the canonical branch.",
    );
  }
}

function validateFailureProjectionShape(
  projection: ChangeProjectionResult,
  expectedBranch: string,
  expectedBaseBranch: string,
  rootIssue: number,
  path: string,
  diagnostics: ChangeDiagnostic[],
): void {
  if (projection.status !== "partial") {
    addRecoverySemanticDiagnostic(
      diagnostics,
      path,
      "Branch compensation requires a confirmed partial branch-only projection.",
    );
  }
  if (projection.change?.state !== "RECOVERY_REQUIRED") {
    addRecoverySemanticDiagnostic(
      diagnostics,
      `${path}.change.state`,
      "A branch-only failed issuance must be represented as RECOVERY_REQUIRED before compensation.",
    );
  }
  if (
    projection.change?.projection?.branch !== expectedBranch ||
    projection.change?.projection?.pullRequest !== undefined
  ) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      `${path}.change.projection`,
      "Failure projection must retain only the canonical branch and no pull request.",
    );
  }
  if (projection.candidates.branches.filter((candidate) => candidate.candidate.name === expectedBranch).length !== 1) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      `${path}.candidates.branches`,
      "Failure projection must contain exactly one canonical branch candidate.",
    );
  }
  if (projection.candidates.pullRequests.some((candidate) => candidate.classification === "canonical")) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      `${path}.candidates.pullRequests`,
      "Failure projection must not contain a canonical pull request.",
    );
  }
  if (projection.candidates.branches.some((candidate) => candidate.classification === "conflicting")) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      `${path}.candidates.branches`,
      "Conflicting branch evidence cannot be compensated automatically.",
    );
  }
  if (projection.candidates.pullRequests.some((candidate) => candidate.classification === "conflicting")) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      `${path}.candidates.pullRequests`,
      "Conflicting pull-request evidence cannot be compensated automatically.",
    );
  }
  const plausibleNoncanonicalPullRequests = projection.candidates.pullRequests.filter(
    (candidate) => candidate.candidate.rootIssue === rootIssue && candidate.candidate.head !== expectedBranch,
  );
  if (plausibleNoncanonicalPullRequests.length > 1) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      `${path}.candidates.pullRequests`,
      "Multiple plausible noncanonical pull requests make compensation ambiguous.",
    );
  }
  if (projection.canonicalBranch !== expectedBranch || projection.canonicalBaseBranch !== expectedBaseBranch) {
    addRecoverySemanticDiagnostic(diagnostics, path, "Failure projection canonical identities do not match issuance.");
  }
}

function projectionInputSource(input: unknown, key: "issue" | "branches" | "pullRequests"): RecordValue | undefined {
  if (!isRecord(input) || !isRecord(input.evidence)) return undefined;
  const source = input.evidence[key];
  return isRecord(source) ? source : undefined;
}

function projectionInputSourceIsAvailable(input: unknown, key: "issue" | "branches" | "pullRequests"): boolean {
  return projectionInputSource(input, key)?.status === "available";
}

function projectionInputSourceIsConfirmedEmpty(input: unknown, key: "branches" | "pullRequests"): boolean {
  const source = projectionInputSource(input, key);
  if (source === undefined || source.status === "absent") return source !== undefined;
  return source.status === "available" && Array.isArray(source.value) && source.value.length === 0;
}

function projectionInputIssueIsOpen(input: unknown): boolean {
  const source = projectionInputSource(input, "issue");
  return source?.status === "available" && isRecord(source.value) && source.value.state === "open";
}

function validateSafeFailureProjection(
  projectionInput: unknown,
  projection: ChangeProjectionResult,
  issuance: ChangeIssuancePlan,
  path: string,
  diagnostics: ChangeDiagnostic[],
): boolean {
  const before = diagnostics.length;
  validateFailureProjectionShape(
    projection,
    issuance.verification.canonicalBranch,
    issuance.verification.canonicalBaseBranch,
    issuance.transaction.identity.rootIssue,
    path,
    diagnostics,
  );
  if (!projectionInputIssueIsOpen(projectionInput)) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      `${path}.evidence.issue`,
      "Failure evidence must confirm an open root Issue.",
    );
  }
  for (const key of ["branches", "pullRequests"] as const) {
    if (!projectionInputSourceIsAvailable(projectionInput, key)) {
      addRecoverySemanticDiagnostic(
        diagnostics,
        `${path}.evidence.${key}`,
        "Compensation requires a complete available artifact read; unavailable or absent evidence is unsafe.",
      );
    }
  }
  return diagnostics.length === before;
}

function validateSafeAbsentProjection(
  projectionInput: unknown,
  projection: ChangeProjectionResult,
  issuance: ChangeIssuancePlan,
  path: string,
  diagnostics: ChangeDiagnostic[],
): boolean {
  const before = diagnostics.length;
  if (projection.status !== "absent" || !projection.valid || projection.change?.state !== "DEFINED") {
    addRecoverySemanticDiagnostic(diagnostics, path, "Successful compensation requires a confirmed absent projection.");
  }
  if (projection.change?.projection !== undefined) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      `${path}.change.projection`,
      "An absent projection cannot retain artifacts.",
    );
  }
  if (projection.canonicalBranch !== issuance.verification.canonicalBranch) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      `${path}.canonicalBranch`,
      "Compensation evidence branch does not match issuance.",
    );
  }
  if (projection.canonicalBaseBranch !== issuance.verification.canonicalBaseBranch) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      `${path}.canonicalBaseBranch`,
      "Compensation evidence base branch does not match issuance.",
    );
  }
  if (!projectionInputIssueIsOpen(projectionInput)) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      `${path}.evidence.issue`,
      "Compensation evidence must confirm an open root Issue.",
    );
  }
  for (const key of ["branches", "pullRequests"] as const) {
    if (!projectionInputSourceIsConfirmedEmpty(projectionInput, key)) {
      addRecoverySemanticDiagnostic(
        diagnostics,
        `${path}.evidence.${key}`,
        "Successful compensation requires confirmed absence of every canonical artifact.",
      );
    }
  }
  return diagnostics.length === before;
}

interface ParsedChangeIssuanceRecoveryInput {
  readonly issuance: ChangeIssuancePlan;
  readonly attemptedEffects: readonly ChangeIssuanceEffectAttempt[];
  readonly failure: ChangeIssuanceFailureEvidence;
  readonly projectionInput: unknown;
  readonly projection: ChangeProjectionResult;
  readonly compensation?: {
    readonly status: Exclude<ChangeIssuanceCompensationStatus, "required">;
    readonly projectionInput: unknown;
    readonly projection: ChangeProjectionResult;
    readonly failure?: ChangeIssuanceFailureEvidence;
  };
}

function parseChangeIssuanceRecoveryInput(
  input: unknown,
  diagnostics: ChangeDiagnostic[],
): ParsedChangeIssuanceRecoveryInput | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Issuance recovery input must be an object.");
    return undefined;
  }
  addUnknownProperties(input, CHANGE_ISSUANCE_RECOVERY_INPUT_KEYS, "$", diagnostics);

  let issuance: ChangeIssuancePlan | undefined;
  if (!hasOwn(input, "issuance")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.issuance", "Property is required.");
  } else {
    const result = validateChangeIssuancePlan(input.issuance);
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    issuance = result.plan;
  }

  const attemptedEffects = validateChangeIssuanceEffectAttempts(
    input.attemptedEffects,
    "$.attemptedEffects",
    diagnostics,
  );
  const failure = validateChangeIssuanceFailureEvidence(input.failure, "$.failure", diagnostics);

  let projection: ChangeProjectionResult | undefined;
  let projectionInput: unknown;
  if (!hasOwn(input, "projection")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.projection", "Property is required.");
    projectionInput = undefined;
  } else {
    projectionInput = input.projection;
    projection = projectChangeFromGitHubEvidence(projectionInput);
  }

  let compensation:
    | {
        readonly status: Exclude<ChangeIssuanceCompensationStatus, "required">;
        readonly projectionInput: unknown;
        readonly projection: ChangeProjectionResult;
        readonly failure?: ChangeIssuanceFailureEvidence;
      }
    | undefined;
  if (hasOwn(input, "compensation")) {
    if (!isRecord(input.compensation)) {
      addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.compensation", "Compensation outcome must be an object.");
    } else {
      addUnknownProperties(
        input.compensation,
        CHANGE_ISSUANCE_COMPENSATION_OUTCOME_INPUT_KEYS,
        "$.compensation",
        diagnostics,
      );
      const status = input.compensation.status;
      if (
        typeof status !== "string" ||
        !CHANGE_ISSUANCE_COMPENSATION_STATUSES.includes(status as ChangeIssuanceCompensationStatus) ||
        status === "required"
      ) {
        addDiagnostic(
          diagnostics,
          "CHANGE_INVALID_PLAN",
          "$.compensation.status",
          "Compensation outcome status is invalid.",
        );
      }
      let compensationProjection: ChangeProjectionResult | undefined;
      if (!hasOwn(input.compensation, "projection")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.compensation.projection", "Property is required.");
      } else {
        compensationProjection = projectChangeFromGitHubEvidence(input.compensation.projection);
      }
      let compensationFailure: ChangeIssuanceFailureEvidence | undefined;
      if (hasOwn(input.compensation, "failure")) {
        compensationFailure = validateChangeIssuanceFailureEvidence(
          input.compensation.failure,
          "$.compensation.failure",
          diagnostics,
        );
      }
      if (status === "succeeded" && compensationFailure !== undefined) {
        addDiagnostic(
          diagnostics,
          "CHANGE_INVALID_PLAN",
          "$.compensation.failure",
          "A successful compensation cannot contain failure evidence.",
        );
      }
      if (status === "failed" && compensationFailure === undefined && !hasOwn(input.compensation, "failure")) {
        addDiagnostic(
          diagnostics,
          "CHANGE_MISSING_PROPERTY",
          "$.compensation.failure",
          "A failed compensation must preserve failure evidence.",
        );
      }
      if (
        compensationProjection !== undefined &&
        typeof status === "string" &&
        (status === "succeeded" || status === "failed")
      ) {
        compensation = {
          status,
          projectionInput: input.compensation.projection,
          projection: compensationProjection,
          ...(compensationFailure === undefined ? {} : { failure: compensationFailure }),
        };
      }
    }
  }

  if (
    diagnostics.length > 0 ||
    issuance === undefined ||
    failure === undefined ||
    projection === undefined ||
    projectionInput === undefined
  ) {
    return undefined;
  }
  validateFailureProjectionIdentity(issuance, projection, "$.projection", diagnostics);
  if (compensation !== undefined) {
    validateFailureProjectionIdentity(issuance, compensation.projection, "$.compensation.projection", diagnostics);
  }
  return { issuance, attemptedEffects, failure, projectionInput, projection, compensation };
}

function recoveryChangeFromProjection(issuance: ChangeIssuancePlan, projection: ChangeProjectionResult): Change {
  const observed = projection.change?.projection;
  return {
    version: CHANGE_CONTRACT_VERSION,
    identity: issuance.transaction.identity,
    state: "RECOVERY_REQUIRED",
    provenance: projection.change?.provenance ?? issuance.result.provenance,
    ...(observed === undefined ? {} : { projection: observed }),
  };
}

function definedChangeAfterCompensation(issuance: ChangeIssuancePlan): Change {
  return {
    version: CHANGE_CONTRACT_VERSION,
    identity: issuance.transaction.identity,
    state: "DEFINED",
    provenance: issuance.result.provenance,
  };
}

function compensationVerification(issuance: ChangeIssuancePlan): ChangeIssuanceCompensationVerificationExpectation {
  return {
    phase: "post-compensation",
    status: "absent",
    canonicalBranch: issuance.verification.canonicalBranch,
    canonicalBaseBranch: issuance.verification.canonicalBaseBranch,
    state: "DEFINED",
    pullRequest: { required: false },
  };
}

function buildChangeIssuanceCompensationPlan(
  parsed: ParsedChangeIssuanceRecoveryInput,
  diagnostics: ChangeDiagnostic[],
): ChangeIssuanceCompensationPlan | undefined {
  validateCreateIssuanceFailureSemantics(parsed.issuance, parsed.attemptedEffects, parsed.failure, diagnostics);
  validateSafeFailureProjection(
    parsed.projectionInput,
    parsed.projection,
    parsed.issuance,
    "$.projection",
    diagnostics,
  );
  if (diagnostics.length > 0) return undefined;

  const plan: ChangeIssuanceCompensationPlan = {
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    operation: "compensate-issue",
    transaction: parsed.issuance.transaction,
    issuance: parsed.issuance,
    failureEvidence: {
      attemptedEffects: parsed.attemptedEffects,
      failure: parsed.failure,
      projection: parsed.projection,
    },
    effects: [
      {
        kind: "DELETE_BRANCH",
        branch: parsed.issuance.verification.canonicalBranch,
      },
    ],
    verification: compensationVerification(parsed.issuance),
  };
  const result = validateChangeIssuanceCompensationPlan(plan);
  if (!result.valid || result.plan === undefined) {
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    return undefined;
  }
  return result.plan;
}

/** Validate and canonicalize an explicit branch-compensation plan. */
export function validateChangeIssuanceCompensationPlan(input: unknown): ChangeIssuanceCompensationPlanValidationResult {
  const diagnostics: ChangeDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Change issuance compensation plan must be an object.");
    return { valid: false, diagnostics };
  }
  addUnknownProperties(input, CHANGE_ISSUANCE_COMPENSATION_PLAN_KEYS, "$", diagnostics);

  if (input.version !== CHANGE_TRANSITION_CONTRACT_VERSION) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.version", "Compensation plan version is unsupported.");
  }
  if (input.operation !== "compensate-issue") {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.operation", "Compensation plan operation is invalid.");
  }

  let transaction: ChangeIssuanceTransaction | undefined;
  if (!hasOwn(input, "transaction")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.transaction", "Property is required.");
  } else {
    transaction = validateChangeIssuanceTransaction(input.transaction, "$.transaction", diagnostics);
  }

  let issuance: ChangeIssuancePlan | undefined;
  if (!hasOwn(input, "issuance")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.issuance", "Property is required.");
  } else {
    const result = validateChangeIssuancePlan(input.issuance);
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    issuance = result.plan;
  }

  let failureEvidence: ChangeIssuanceFailureRecord | undefined;
  if (!hasOwn(input, "failureEvidence")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.failureEvidence", "Property is required.");
  } else {
    failureEvidence = validateChangeIssuanceFailureRecord(input.failureEvidence, "$.failureEvidence", diagnostics);
  }

  let effects: ChangeEffect[] = [];
  if (!hasOwn(input, "effects")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.effects", "Property is required.");
  } else {
    effects = validateEffectList(input.effects, "$.effects", diagnostics);
  }

  let verification: ChangeIssuanceCompensationVerificationExpectation | undefined;
  if (!hasOwn(input, "verification")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.verification", "Property is required.");
  } else {
    verification = validateChangeIssuanceCompensationVerification(input.verification, "$.verification", diagnostics);
  }

  if (
    diagnostics.length > 0 ||
    transaction === undefined ||
    issuance === undefined ||
    failureEvidence === undefined ||
    verification === undefined
  ) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }

  if (!sameChangeIdentity(transaction.identity, issuance.transaction.identity)) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.transaction.identity",
      "Compensation transaction identity must match issuance.",
    );
  }
  if (transaction.idempotencyKey !== issuance.transaction.idempotencyKey) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.transaction.idempotencyKey",
      "Compensation must reuse issuance idempotency.",
    );
  }
  validateCreateIssuanceFailureSemantics(
    issuance,
    failureEvidence.attemptedEffects,
    failureEvidence.failure,
    diagnostics,
  );
  validateFailureProjectionIdentity(issuance, failureEvidence.projection, "$.failureEvidence.projection", diagnostics);
  validateFailureProjectionShape(
    failureEvidence.projection,
    issuance.verification.canonicalBranch,
    issuance.verification.canonicalBaseBranch,
    issuance.transaction.identity.rootIssue,
    "$.failureEvidence.projection",
    diagnostics,
  );
  validateCompensationPlanEffects(effects, issuance.verification.canonicalBranch, "$.effects", diagnostics);
  if (!canonicalPlanEquals(verification, compensationVerification(issuance))) {
    addRecoverySemanticDiagnostic(diagnostics, "$.verification", "Compensation verification does not match issuance.");
  }

  if (diagnostics.length > 0) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  return {
    valid: true,
    plan: {
      version: CHANGE_TRANSITION_CONTRACT_VERSION,
      operation: "compensate-issue",
      transaction: issuance.transaction,
      issuance,
      failureEvidence,
      effects,
      verification,
    },
    diagnostics: [],
  };
}

/** Assert a valid explicit branch-compensation plan at an executor boundary. */
export function assertChangeIssuanceCompensationPlan(input: unknown): asserts input is ChangeIssuanceCompensationPlan {
  const result = validateChangeIssuanceCompensationPlan(input);
  if (!result.valid) throw new ChangeIssuanceRecoveryValidationError(result.diagnostics);
}

export function isChangeIssuanceCompensationPlan(input: unknown): input is ChangeIssuanceCompensationPlan {
  return validateChangeIssuanceCompensationPlan(input).valid;
}

/** Plan the only safe compensation for a confirmed branch-created/PR-failed issuance. */
export function planChangeIssuanceCompensation(input: unknown): ChangeIssuanceCompensationPlan {
  const diagnostics: ChangeDiagnostic[] = [];
  const parsed = parseChangeIssuanceRecoveryInput(input, diagnostics);
  if (parsed === undefined)
    throw new ChangeIssuanceRecoveryValidationError(createChangeDiagnosticReport(diagnostics).diagnostics);
  const plan = buildChangeIssuanceCompensationPlan(parsed, diagnostics);
  if (plan === undefined)
    throw new ChangeIssuanceRecoveryValidationError(createChangeDiagnosticReport(diagnostics).diagnostics);
  return plan;
}

export const createChangeIssuanceCompensationPlan = planChangeIssuanceCompensation;
export const planChangeCompensation = planChangeIssuanceCompensation;

function validateChangeIssuanceCompensationOutcome(
  input: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): ChangeIssuanceCompensationOutcome | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Compensation outcome must be an object.");
    return undefined;
  }
  addUnknownProperties(input, CHANGE_ISSUANCE_COMPENSATION_OUTCOME_KEYS, path, diagnostics);
  const status = input.status;
  if (
    typeof status !== "string" ||
    !CHANGE_ISSUANCE_COMPENSATION_STATUSES.includes(status as ChangeIssuanceCompensationStatus) ||
    status === "required"
  ) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.status`, "Compensation outcome status is invalid.");
  }
  let evidence: ChangeProjectionResult | undefined;
  if (!hasOwn(input, "evidence")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", `${path}.evidence`, "Property is required.");
  } else {
    evidence = parseChangeProjectionResult(input.evidence, `${path}.evidence`, diagnostics);
  }
  let failure: ChangeIssuanceFailureEvidence | undefined;
  if (hasOwn(input, "failure")) {
    failure = validateChangeIssuanceFailureEvidence(input.failure, `${path}.failure`, diagnostics);
  }
  if (status === "succeeded" && failure !== undefined) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_PLAN",
      `${path}.failure`,
      "A successful compensation cannot contain failure evidence.",
    );
  }
  if (status === "failed" && failure === undefined && !hasOwn(input, "failure")) {
    addDiagnostic(
      diagnostics,
      "CHANGE_MISSING_PROPERTY",
      `${path}.failure`,
      "A failed compensation must preserve failure evidence.",
    );
  }
  if (diagnostics.length > 0 || evidence === undefined || (status !== "succeeded" && status !== "failed")) {
    return undefined;
  }
  return {
    status,
    evidence,
    ...(failure === undefined ? {} : { failure }),
  };
}

function validateChangeIssuanceRecoveryResult(
  input: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): ChangeIssuanceRecoveryResult | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Issuance recovery result must be an object.");
    return undefined;
  }
  addUnknownProperties(input, CHANGE_ISSUANCE_RECOVERY_RESULT_KEYS, path, diagnostics);
  const status = input.status;
  if (
    typeof status !== "string" ||
    !CHANGE_ISSUANCE_RECOVERY_STATUSES.includes(status as ChangeIssuanceRecoveryStatus)
  ) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.status`, "Issuance recovery result status is invalid.");
  }
  if (input.state !== "DEFINED" && input.state !== "RECOVERY_REQUIRED") {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.state`, "Issuance recovery result state is invalid.");
  }
  if (input.issued !== false) {
    addDiagnostic(
      diagnostics,
      "CHANGE_INVALID_PLAN",
      `${path}.issued`,
      "Recovery results must state that no Change is issued.",
    );
  }
  let change: Change | undefined;
  if (!hasOwn(input, "change")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", `${path}.change`, "Property is required.");
  } else {
    const result = validateChange(input.change);
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    change = result.change;
  }
  if (
    diagnostics.length > 0 ||
    change === undefined ||
    (status !== "compensation-required" && status !== "compensated" && status !== "recovery-required") ||
    (input.state !== "DEFINED" && input.state !== "RECOVERY_REQUIRED")
  ) {
    return undefined;
  }
  return {
    status: status as ChangeIssuanceRecoveryStatus,
    state: input.state,
    issued: false,
    change,
  };
}

function buildChangeIssuanceRecoveryPlan(
  parsed: ParsedChangeIssuanceRecoveryInput,
  diagnostics: ChangeDiagnostic[],
): ChangeIssuanceRecoveryPlan | undefined {
  const compensationPlan = buildChangeIssuanceCompensationPlan(parsed, diagnostics);
  if (compensationPlan === undefined) return undefined;

  let compensationStatus: ChangeIssuanceCompensationStatus = "required";
  let outcome: ChangeIssuanceCompensationOutcome | undefined;
  let result: ChangeIssuanceRecoveryResult = {
    status: "compensation-required",
    state: "RECOVERY_REQUIRED",
    issued: false,
    change: recoveryChangeFromProjection(parsed.issuance, parsed.projection),
  };

  if (parsed.compensation !== undefined) {
    compensationStatus = parsed.compensation.status;
    outcome = {
      status: parsed.compensation.status,
      evidence: parsed.compensation.projection,
      ...(parsed.compensation.failure === undefined ? {} : { failure: parsed.compensation.failure }),
    };
    if (parsed.compensation.status === "succeeded") {
      validateSafeAbsentProjection(
        parsed.compensation.projectionInput,
        parsed.compensation.projection,
        parsed.issuance,
        "$.compensation.projection",
        diagnostics,
      );
      if (diagnostics.length === 0) {
        result = {
          status: "compensated",
          state: "DEFINED",
          issued: false,
          change: definedChangeAfterCompensation(parsed.issuance),
        };
      }
    } else {
      if (parsed.compensation.failure === undefined) {
        addDiagnostic(
          diagnostics,
          "CHANGE_INVALID_PLAN",
          "$.compensation.failure",
          "A failed compensation must preserve failure evidence.",
        );
      } else if (!sameEffect(parsed.compensation.failure.effect, compensationPlan.effects[0]!)) {
        addDiagnostic(
          diagnostics,
          "CHANGE_INVALID_PLAN",
          "$.compensation.failure.effect",
          "Compensation failure evidence must identify the branch delete effect.",
        );
      }
      result = {
        status: "recovery-required",
        state: "RECOVERY_REQUIRED",
        issued: false,
        change: recoveryChangeFromProjection(parsed.issuance, parsed.compensation.projection),
      };
    }
  }

  if (diagnostics.length > 0) return undefined;
  const plan: ChangeIssuanceRecoveryPlan = {
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    operation: "recover-issue",
    transaction: parsed.issuance.transaction,
    issuance: parsed.issuance,
    failureEvidence: compensationPlan.failureEvidence,
    compensation: {
      status: compensationStatus,
      plan: compensationPlan,
      ...(outcome === undefined ? {} : { outcome }),
    },
    result,
  };
  const validation = validateChangeIssuanceRecoveryPlan(plan);
  if (!validation.valid || validation.plan === undefined) {
    diagnostics.push(...validation.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    return undefined;
  }
  return validation.plan;
}

/** Validate and canonicalize a deterministic issuance recovery plan. */
export function validateChangeIssuanceRecoveryPlan(input: unknown): ChangeIssuanceRecoveryPlanValidationResult {
  const diagnostics: ChangeDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Change issuance recovery plan must be an object.");
    return { valid: false, diagnostics };
  }
  addUnknownProperties(input, CHANGE_ISSUANCE_RECOVERY_PLAN_KEYS, "$", diagnostics);
  if (input.version !== CHANGE_TRANSITION_CONTRACT_VERSION) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.version", "Recovery plan version is unsupported.");
  }
  if (input.operation !== "recover-issue") {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.operation", "Recovery plan operation is invalid.");
  }

  let transaction: ChangeIssuanceTransaction | undefined;
  if (!hasOwn(input, "transaction")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.transaction", "Property is required.");
  } else {
    transaction = validateChangeIssuanceTransaction(input.transaction, "$.transaction", diagnostics);
  }
  let issuance: ChangeIssuancePlan | undefined;
  if (!hasOwn(input, "issuance")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.issuance", "Property is required.");
  } else {
    const result = validateChangeIssuancePlan(input.issuance);
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    issuance = result.plan;
  }
  let failureEvidence: ChangeIssuanceFailureRecord | undefined;
  if (!hasOwn(input, "failureEvidence")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.failureEvidence", "Property is required.");
  } else {
    failureEvidence = validateChangeIssuanceFailureRecord(input.failureEvidence, "$.failureEvidence", diagnostics);
  }

  let compensationStatus: ChangeIssuanceCompensationStatus | undefined;
  let compensationPlan: ChangeIssuanceCompensationPlan | undefined;
  let outcome: ChangeIssuanceCompensationOutcome | undefined;
  if (!hasOwn(input, "compensation")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.compensation", "Property is required.");
  } else if (!isRecord(input.compensation)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.compensation", "Recovery compensation must be an object.");
  } else {
    addUnknownProperties(input.compensation, CHANGE_ISSUANCE_RECOVERY_COMPENSATION_KEYS, "$.compensation", diagnostics);
    const status = input.compensation.status;
    if (!CHANGE_ISSUANCE_COMPENSATION_STATUSES.includes(status as ChangeIssuanceCompensationStatus)) {
      addDiagnostic(
        diagnostics,
        "CHANGE_INVALID_PLAN",
        "$.compensation.status",
        "Recovery compensation status is invalid.",
      );
    } else {
      compensationStatus = status as ChangeIssuanceCompensationStatus;
    }
    if (!hasOwn(input.compensation, "plan")) {
      addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.compensation.plan", "Property is required.");
    } else {
      const result = validateChangeIssuanceCompensationPlan(input.compensation.plan);
      diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
      compensationPlan = result.plan;
    }
    if (hasOwn(input.compensation, "outcome")) {
      outcome = validateChangeIssuanceCompensationOutcome(
        input.compensation.outcome,
        "$.compensation.outcome",
        diagnostics,
      );
    }
  }

  let result: ChangeIssuanceRecoveryResult | undefined;
  if (!hasOwn(input, "result")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.result", "Property is required.");
  } else {
    result = validateChangeIssuanceRecoveryResult(input.result, "$.result", diagnostics);
  }

  if (
    diagnostics.length > 0 ||
    transaction === undefined ||
    issuance === undefined ||
    failureEvidence === undefined ||
    compensationStatus === undefined ||
    compensationPlan === undefined ||
    result === undefined
  ) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }

  if (!sameChangeIdentity(transaction.identity, issuance.transaction.identity)) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.transaction.identity",
      "Recovery transaction identity must match issuance.",
    );
  }
  if (transaction.idempotencyKey !== issuance.transaction.idempotencyKey) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.transaction.idempotencyKey",
      "Recovery must reuse issuance idempotency.",
    );
  }
  if (!canonicalPlanEquals(failureEvidence, compensationPlan.failureEvidence)) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.failureEvidence",
      "Recovery must retain the compensation failure evidence unchanged.",
    );
  }
  if (compensationStatus === "required" && outcome !== undefined) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.compensation.outcome",
      "A pending compensation cannot contain an outcome.",
    );
  }
  if (compensationStatus !== "required") {
    if (outcome === undefined) {
      addRecoverySemanticDiagnostic(
        diagnostics,
        "$.compensation.outcome",
        "A completed compensation must retain its outcome.",
      );
    } else if (outcome.status !== compensationStatus) {
      addRecoverySemanticDiagnostic(
        diagnostics,
        "$.compensation.outcome.status",
        "Compensation status must match its outcome.",
      );
    }
  }
  if (outcome !== undefined) {
    validateFailureProjectionIdentity(issuance, outcome.evidence, "$.compensation.outcome.evidence", diagnostics);
    if (outcome.status === "succeeded") {
      if (outcome.failure !== undefined) {
        addRecoverySemanticDiagnostic(
          diagnostics,
          "$.compensation.outcome.failure",
          "Successful compensation cannot retain failure evidence.",
        );
      }
      if (outcome.evidence.status !== "absent" || !outcome.evidence.valid) {
        addRecoverySemanticDiagnostic(
          diagnostics,
          "$.compensation.outcome.evidence",
          "Successful compensation must prove an absent projection.",
        );
      }
    } else if (outcome.failure === undefined) {
      addRecoverySemanticDiagnostic(
        diagnostics,
        "$.compensation.outcome.failure",
        "Failed compensation must retain failure evidence.",
      );
    } else if (!sameEffect(outcome.failure.effect, compensationPlan.effects[0]!)) {
      addRecoverySemanticDiagnostic(
        diagnostics,
        "$.compensation.outcome.failure.effect",
        "Compensation failure evidence must identify the branch delete effect.",
      );
    }
  }

  const expectedResultState: "DEFINED" | "RECOVERY_REQUIRED" =
    compensationStatus === "succeeded" ? "DEFINED" : "RECOVERY_REQUIRED";
  const expectedResultStatus: ChangeIssuanceRecoveryStatus =
    compensationStatus === "required"
      ? "compensation-required"
      : compensationStatus === "succeeded"
        ? "compensated"
        : "recovery-required";
  if (result.status !== expectedResultStatus || result.state !== expectedResultState) {
    addRecoverySemanticDiagnostic(diagnostics, "$.result", "Recovery result does not match compensation outcome.");
  }
  if (result.change.state !== expectedResultState) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.result.change.state",
      "Recovery Change state does not match compensation outcome.",
    );
  }
  if (!sameChangeIdentity(result.change.identity, issuance.transaction.identity)) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.result.change.identity",
      "Recovery result identity must match issuance.",
    );
  }
  if (compensationStatus === "succeeded" && result.change.projection !== undefined) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.result.change.projection",
      "Compensation success must return no issued Change projection.",
    );
  }

  if (diagnostics.length > 0) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  return {
    valid: true,
    plan: {
      version: CHANGE_TRANSITION_CONTRACT_VERSION,
      operation: "recover-issue",
      transaction: issuance.transaction,
      issuance,
      failureEvidence,
      compensation: {
        status: compensationStatus,
        plan: compensationPlan,
        ...(outcome === undefined ? {} : { outcome }),
      },
      result,
    },
    diagnostics: [],
  };
}

/** Assert a valid deterministic issuance recovery plan at an executor boundary. */
export function assertChangeIssuanceRecoveryPlan(input: unknown): asserts input is ChangeIssuanceRecoveryPlan {
  const result = validateChangeIssuanceRecoveryPlan(input);
  if (!result.valid) throw new ChangeIssuanceRecoveryValidationError(result.diagnostics);
}

export function isChangeIssuanceRecoveryPlan(input: unknown): input is ChangeIssuanceRecoveryPlan {
  return validateChangeIssuanceRecoveryPlan(input).valid;
}

/**
 * Plan issuance compensation and recovery from bounded effect/projection
 * evidence. This function is pure and never executes the delete effect.
 */
export function planChangeIssuanceRecovery(input: unknown): ChangeIssuanceRecoveryPlan {
  const diagnostics: ChangeDiagnostic[] = [];
  const parsed = parseChangeIssuanceRecoveryInput(input, diagnostics);
  if (parsed === undefined)
    throw new ChangeIssuanceRecoveryValidationError(createChangeDiagnosticReport(diagnostics).diagnostics);
  const plan = buildChangeIssuanceRecoveryPlan(parsed, diagnostics);
  if (plan === undefined)
    throw new ChangeIssuanceRecoveryValidationError(createChangeDiagnosticReport(diagnostics).diagnostics);
  return plan;
}

export const createChangeIssuanceRecoveryPlan = planChangeIssuanceRecovery;

interface ParsedChangeTransitionRecoveryInput {
  readonly transition: ChangeTransitionPlan;
  readonly failureEvidence: ChangeIssuanceFailureRecord;
  readonly effects: readonly ChangeEffect[];
  readonly result: ChangeTransitionRecoveryResult;
}

const CHANGE_TRANSITION_RECOVERY_PLAN_KEYS = new Set([
  "version",
  "operation",
  "transition",
  "failureEvidence",
  "effects",
  "result",
]);
const CHANGE_TRANSITION_RECOVERY_RESULT_KEYS = new Set(["status", "state", "change"]);

function validateTransitionRecoverySemantics(
  transition: ChangeTransitionPlan,
  failureEvidence: ChangeIssuanceFailureRecord,
  effects: readonly ChangeEffect[],
  result: ChangeTransitionRecoveryResult,
  diagnostics: ChangeDiagnostic[],
): void {
  const attempts = failureEvidence.attemptedEffects;
  if (attempts.length === 0 || attempts.length > transition.effects.length) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.failureEvidence.attemptedEffects",
      "Transition recovery must record a non-empty ordered prefix of transition effects.",
    );
  } else {
    for (let index = 0; index < attempts.length; index += 1) {
      const expected = transition.effects[index];
      const attempt = attempts[index];
      if (expected === undefined || !sameEffect(attempt.effect, expected)) {
        addRecoverySemanticDiagnostic(
          diagnostics,
          `$.failureEvidence.attemptedEffects[${index}].effect`,
          "Transition recovery effect evidence does not match the planned effect order.",
        );
      }
      if (index < attempts.length - 1 && attempt.status !== "succeeded") {
        addRecoverySemanticDiagnostic(
          diagnostics,
          `$.failureEvidence.attemptedEffects[${index}].status`,
          "Only the final attempted transition effect may fail.",
        );
      }
    }
    if (attempts.at(-1)?.status !== "failed") {
      addRecoverySemanticDiagnostic(
        diagnostics,
        "$.failureEvidence.attemptedEffects",
        "Transition recovery must identify the failed final effect.",
      );
    }
    if (!sameEffect(attempts.at(-1)!.effect, failureEvidence.failure.effect)) {
      addRecoverySemanticDiagnostic(
        diagnostics,
        "$.failureEvidence.failure.effect",
        "Failure evidence must identify the final failed transition effect.",
      );
    }
  }

  const failedIndex = Math.max(0, attempts.length - 1);
  if (!canonicalPlanEquals(effects, transition.effects.slice(failedIndex))) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.effects",
      "Recovery effects must contain the failed effect and every later effect in order.",
    );
  }
  if (!sameChangeIdentity(result.change.identity, transition.result.identity)) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.result.change.identity",
      "Recovery result identity must match the transition.",
    );
  }
  if (result.status !== "recovery-required" || result.state !== "RECOVERY_REQUIRED") {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.result",
      "A failed transition must produce RECOVERY_REQUIRED semantics.",
    );
  }
  const projection = failureEvidence.projection;
  if (!projection.valid && projection.status !== "partial") {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.failureEvidence.projection",
      "Transition recovery requires a bounded healthy or partial projection.",
    );
  }
  if (projection.change === undefined) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.failureEvidence.projection.change",
      "Transition recovery requires a projected Change snapshot.",
    );
  } else if (!sameChangeIdentity(projection.change.identity, transition.result.identity)) {
    addRecoverySemanticDiagnostic(
      diagnostics,
      "$.failureEvidence.projection.change.identity",
      "Recovery projection identity must match the transition.",
    );
  }
}

function parseChangeTransitionRecoveryResult(
  input: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): ChangeTransitionRecoveryResult | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Transition recovery result must be an object.");
    return undefined;
  }
  addUnknownProperties(input, CHANGE_TRANSITION_RECOVERY_RESULT_KEYS, path, diagnostics);
  if (input.status !== "recovery-required") {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.status`, "Recovery result status is invalid.");
  }
  if (input.state !== "RECOVERY_REQUIRED") {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.state`, "Recovery result state is invalid.");
  }
  const changeResult = validateChange(input.change);
  diagnostics.push(...changeResult.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
  if (diagnostics.length > 0 || changeResult.change === undefined) return undefined;
  return { status: "recovery-required", state: "RECOVERY_REQUIRED", change: changeResult.change };
}

function parseChangeTransitionRecoveryInput(
  input: unknown,
  diagnostics: ChangeDiagnostic[],
): ParsedChangeTransitionRecoveryInput | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Transition recovery input must be an object.");
    return undefined;
  }
  addUnknownProperties(input, new Set(["transition", "attemptedEffects", "failure", "projection"]), "$", diagnostics);

  let transition: ChangeTransitionPlan | undefined;
  if (!hasOwn(input, "transition")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.transition", "Property is required.");
  } else {
    const result = validateChangeTransitionPlan(input.transition);
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    transition = result.plan;
  }
  const attemptedEffects = validateChangeIssuanceEffectAttempts(
    input.attemptedEffects,
    "$.attemptedEffects",
    diagnostics,
  );
  const failure = validateChangeIssuanceFailureEvidence(input.failure, "$.failure", diagnostics);
  let projection: ChangeProjectionResult | undefined;
  if (!hasOwn(input, "projection")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.projection", "Property is required.");
  } else {
    projection = projectChangeFromGitHubEvidence(input.projection);
  }
  if (diagnostics.length > 0 || transition === undefined || failure === undefined || projection === undefined) {
    return undefined;
  }
  const failureEvidence: ChangeIssuanceFailureRecord = { attemptedEffects, failure, projection };
  const failedIndex = Math.max(0, attemptedEffects.length - 1);
  const projectedChange = projection.change;
  const recoveryChange: Change = {
    ...transition.result,
    state: "RECOVERY_REQUIRED",
    provenance: {
      ...transition.result.provenance,
      ...(projectedChange?.provenance ?? {}),
    },
    ...(projectedChange?.projection === undefined
      ? transition.result.projection === undefined
        ? {}
        : { projection: transition.result.projection }
      : { projection: projectedChange.projection }),
  };
  const result: ChangeTransitionRecoveryResult = {
    status: "recovery-required",
    state: "RECOVERY_REQUIRED",
    change: recoveryChange,
  };
  const effects = transition.effects.slice(failedIndex);
  validateTransitionRecoverySemantics(transition, failureEvidence, effects, result, diagnostics);
  if (diagnostics.length > 0) return undefined;
  return { transition, failureEvidence, effects, result };
}

function buildChangeTransitionRecoveryPlan(
  parsed: ParsedChangeTransitionRecoveryInput,
  diagnostics: ChangeDiagnostic[],
): ChangeTransitionRecoveryPlan | undefined {
  const plan: ChangeTransitionRecoveryPlan = {
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    operation: "recover-transition",
    transition: parsed.transition,
    failureEvidence: parsed.failureEvidence,
    effects: parsed.effects,
    result: parsed.result,
  };
  const validation = validateChangeTransitionRecoveryPlan(plan);
  if (!validation.valid || validation.plan === undefined) {
    diagnostics.push(...validation.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    return undefined;
  }
  return validation.plan;
}

/** Validate the shared recovery plan used by all transition executors. */
export function validateChangeTransitionRecoveryPlan(input: unknown): ChangeTransitionRecoveryPlanValidationResult {
  const diagnostics: ChangeDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Transition recovery plan must be an object.");
    return { valid: false, diagnostics };
  }
  addUnknownProperties(input, CHANGE_TRANSITION_RECOVERY_PLAN_KEYS, "$", diagnostics);
  if (input.version !== CHANGE_TRANSITION_CONTRACT_VERSION) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.version", "Transition recovery plan version is unsupported.");
  }
  if (input.operation !== "recover-transition") {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.operation", "Transition recovery operation is invalid.");
  }
  let transition: ChangeTransitionPlan | undefined;
  if (!hasOwn(input, "transition")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.transition", "Property is required.");
  } else {
    const result = validateChangeTransitionPlan(input.transition);
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    transition = result.plan;
  }
  let failureEvidence: ChangeIssuanceFailureRecord | undefined;
  if (!hasOwn(input, "failureEvidence")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.failureEvidence", "Property is required.");
  } else {
    failureEvidence = validateChangeIssuanceFailureRecord(input.failureEvidence, "$.failureEvidence", diagnostics);
  }
  const effects = validateEffectList(input.effects, "$.effects", diagnostics);
  let result: ChangeTransitionRecoveryResult | undefined;
  if (!hasOwn(input, "result")) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.result", "Property is required.");
  } else {
    result = parseChangeTransitionRecoveryResult(input.result, "$.result", diagnostics);
  }
  if (diagnostics.length > 0 || transition === undefined || failureEvidence === undefined || result === undefined) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  validateTransitionRecoverySemantics(transition, failureEvidence, effects, result, diagnostics);
  if (diagnostics.length > 0) {
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  return {
    valid: true,
    plan: {
      version: CHANGE_TRANSITION_CONTRACT_VERSION,
      operation: "recover-transition",
      transition,
      failureEvidence,
      effects,
      result,
    },
    diagnostics: [],
  };
}

export function planChangeTransitionRecovery(input: unknown): ChangeTransitionRecoveryPlan {
  const diagnostics: ChangeDiagnostic[] = [];
  const parsed = parseChangeTransitionRecoveryInput(input, diagnostics);
  if (parsed === undefined) {
    throw new ChangeIssuanceRecoveryValidationError(createChangeDiagnosticReport(diagnostics).diagnostics);
  }
  const plan = buildChangeTransitionRecoveryPlan(parsed, diagnostics);
  if (plan === undefined) {
    throw new ChangeIssuanceRecoveryValidationError(createChangeDiagnosticReport(diagnostics).diagnostics);
  }
  return plan;
}

export const createChangeTransitionRecoveryPlan = planChangeTransitionRecovery;

/** Dispatches to the existing issuance recovery or generic transition recovery authority. */
export function planChangeRecovery(input: unknown): ChangeRecoveryPlan {
  if (isRecord(input) && hasOwn(input, "transition")) return planChangeTransitionRecovery(input);
  return planChangeIssuanceRecovery(input);
}

export const createChangeRecoveryPlan = planChangeRecovery;

/** Serialize a canonical transport-independent compensation plan. */
export function serializeChangeIssuanceCompensationPlan(input: unknown): string {
  const result = validateChangeIssuanceCompensationPlan(input);
  if (!result.valid || result.plan === undefined) throw new ChangeIssuanceRecoveryValidationError(result.diagnostics);
  const serialized = JSON.stringify(result.plan);
  if (serialized === undefined) throw new Error("Change issuance compensation plan could not be serialized.");
  return serialized;
}

/** Parse and validate an untrusted compensation plan JSON boundary. */
export function deserializeChangeIssuanceCompensationPlan(serialized: string): ChangeIssuanceCompensationPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new ChangeIssuanceRecoveryValidationError([
      createChangeDiagnostic({
        code: "CHANGE_INVALID_JSON",
        message: safeMessage(
          `Change issuance compensation plan must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      }),
    ]);
  }
  const result = validateChangeIssuanceCompensationPlan(parsed);
  if (!result.valid || result.plan === undefined) throw new ChangeIssuanceRecoveryValidationError(result.diagnostics);
  return result.plan;
}

/** Serialize a canonical transport-independent recovery plan. */
export function serializeChangeIssuanceRecoveryPlan(input: unknown): string {
  const result = validateChangeIssuanceRecoveryPlan(input);
  if (!result.valid || result.plan === undefined) throw new ChangeIssuanceRecoveryValidationError(result.diagnostics);
  const serialized = JSON.stringify(result.plan);
  if (serialized === undefined) throw new Error("Change issuance recovery plan could not be serialized.");
  return serialized;
}

/** Parse and validate an untrusted recovery plan JSON boundary. */
export function deserializeChangeIssuanceRecoveryPlan(serialized: string): ChangeIssuanceRecoveryPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new ChangeIssuanceRecoveryValidationError([
      createChangeDiagnostic({
        code: "CHANGE_INVALID_JSON",
        message: safeMessage(
          `Change issuance recovery plan must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      }),
    ]);
  }
  const result = validateChangeIssuanceRecoveryPlan(parsed);
  if (!result.valid || result.plan === undefined) throw new ChangeIssuanceRecoveryValidationError(result.diagnostics);
  return result.plan;
}

/** Serialize the shared transition recovery plan with stable property ordering. */
export function serializeChangeTransitionRecoveryPlan(input: unknown): string {
  const result = validateChangeTransitionRecoveryPlan(input);
  if (!result.valid || result.plan === undefined) throw new ChangeIssuanceRecoveryValidationError(result.diagnostics);
  const serialized = JSON.stringify(result.plan);
  if (serialized === undefined) throw new Error("Change transition recovery plan could not be serialized.");
  return serialized;
}

/** Parse and validate the shared transition recovery plan boundary. */
export function deserializeChangeTransitionRecoveryPlan(serialized: string): ChangeTransitionRecoveryPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new ChangeIssuanceRecoveryValidationError([
      createChangeDiagnostic({
        code: "CHANGE_INVALID_JSON",
        message: safeMessage(
          `Change transition recovery plan must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      }),
    ]);
  }
  const result = validateChangeTransitionRecoveryPlan(parsed);
  if (!result.valid || result.plan === undefined) throw new ChangeIssuanceRecoveryValidationError(result.diagnostics);
  return result.plan;
}

/** Serialize either recovery shape through the shared recovery authority. */
export function serializeChangeRecoveryPlan(input: unknown): string {
  if (isRecord(input) && hasOwn(input, "transition")) return serializeChangeTransitionRecoveryPlan(input);
  return serializeChangeIssuanceRecoveryPlan(input);
}

/** Parse either recovery shape through the shared recovery authority. */
export function deserializeChangeRecoveryPlan(serialized: string): ChangeRecoveryPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new ChangeIssuanceRecoveryValidationError([
      createChangeDiagnostic({
        code: "CHANGE_INVALID_JSON",
        message: safeMessage(
          `Change recovery plan must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      }),
    ]);
  }
  if (isRecord(parsed) && parsed.operation === "recover-transition") {
    return deserializeChangeTransitionRecoveryPlan(serialized);
  }
  return deserializeChangeIssuanceRecoveryPlan(serialized);
}

export const parseChangeIssuanceCompensationPlan = deserializeChangeIssuanceCompensationPlan;
export const parseChangeIssuanceRecoveryPlan = deserializeChangeIssuanceRecoveryPlan;
export const parseChangeTransitionRecoveryPlan = deserializeChangeTransitionRecoveryPlan;
export const parseChangeRecoveryPlan = deserializeChangeRecoveryPlan;
export const serializeChangeCompensationPlan = serializeChangeIssuanceCompensationPlan;

export class ChangeIssuanceRecoveryValidationError extends ChangeValidationError {
  constructor(diagnostics: readonly ChangeDiagnostic[]) {
    super(diagnostics);
    this.name = "ChangeIssuanceRecoveryValidationError";
  }
}

interface ParsedChangeMergeAdmissionPullRequest {
  readonly contract?: unknown;
  readonly body?: unknown;
  readonly hasContract: boolean;
  readonly hasBody: boolean;
}

interface ChangeMergeAdmissionAlias {
  readonly present: boolean;
  readonly value?: unknown;
}

function readChangeMergeAdmissionAlias(
  input: RecordValue,
  keys: readonly string[],
  path: string,
  diagnostics: ChangeDiagnostic[],
): ChangeMergeAdmissionAlias {
  const present = keys.filter((key) => hasOwn(input, key));
  if (present.length > 1) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_CONFLICT",
      path,
      `Ambiguous input uses multiple aliases: ${present.join(", ")}.`,
    );
  }
  const key = present[0];
  return key === undefined ? { present: false } : { present: true, value: input[key] };
}

function admissionDiagnosticPath(prefix: string, path: string): string {
  return path === "$" ? prefix : `${prefix}${path.slice(1)}`;
}

function appendAdmissionDiagnostics(
  diagnostics: ChangeDiagnostic[],
  source: readonly ChangeDiagnostic[],
  prefix: string,
): void {
  for (const diagnostic of source) {
    addDiagnostic(diagnostics, diagnostic.code, admissionDiagnosticPath(prefix, diagnostic.path), diagnostic.message);
    if (diagnostics.length >= MAX_CHANGE_DIAGNOSTICS) return;
  }
}

function parseChangeMergeAdmissionPullRequest(
  input: unknown,
  diagnostics: ChangeDiagnostic[],
): ParsedChangeMergeAdmissionPullRequest | undefined {
  if (!isRecord(input)) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_INVALID_INPUT",
      "$.pullRequest",
      "Merge-admission pull-request evidence must be an object.",
    );
    return undefined;
  }
  addUnknownProperties(input, CHANGE_MERGE_ADMISSION_PULL_REQUEST_KEYS, "$.pullRequest", diagnostics);
  const hasContract = hasOwn(input, "contract");
  const hasBody = hasOwn(input, "body");
  if (!hasContract) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.pullRequest.contract", "Property is required.");
  }
  if (!hasBody) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.pullRequest.body", "Property is required.");
  }
  return {
    ...(hasContract ? { contract: input.contract } : {}),
    ...(hasBody ? { body: input.body } : {}),
    hasContract,
    hasBody,
  };
}

function admissionIssuer(value: unknown, path: string, diagnostics: ChangeDiagnostic[]): string | undefined {
  const result = validateChangeProvenance({ issuer: value });
  if (!result.valid || result.provenance?.issuer === undefined) {
    addDiagnostic(diagnostics, "CHANGE_PROVENANCE_INVALID_ISSUER", path, "Issuer provenance is invalid.");
    return undefined;
  }
  return result.provenance.issuer;
}

function validateAdmissionPullRequestContract(
  contractInput: unknown,
  bodyInput: unknown,
  identity: ChangeIdentity | undefined,
  baseBranch: string | undefined,
  diagnostics: ChangeDiagnostic[],
): boolean {
  const before = diagnostics.length;
  const contractResult = validateCanonicalContract(contractInput);
  if (!contractResult.valid) {
    for (const violation of contractResult.violations) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
        admissionDiagnosticPath("$.pullRequest.contract", violation.path),
        violation.message,
      );
    }
  } else {
    const contract = contractInput as CanonicalContract;
    if (contract.artifactKind !== "pull_request") {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
        "$.pullRequest.contract.artifactKind",
        "The governed contract must be a pull-request contract.",
      );
    }
    const provenance = contract.provenance;
    if (provenance === undefined) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
        "$.pullRequest.contract.provenance",
        "The pull-request contract must carry trusted repository provenance.",
      );
    } else {
      if (identity !== undefined && provenance.repository.host.toLowerCase() !== identity.repositoryHost) {
        addDiagnostic(
          diagnostics,
          "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
          "$.pullRequest.contract.provenance.repository.host",
          "The pull-request contract belongs to a different repository host.",
        );
      }
      if (identity !== undefined && provenance.repository.repositoryId !== identity.repositoryId) {
        addDiagnostic(
          diagnostics,
          "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
          "$.pullRequest.contract.provenance.repository.repositoryId",
          "The pull-request contract does not identify the Change repository.",
        );
      }
      if (provenance.repository.repositoryId === undefined) {
        addDiagnostic(
          diagnostics,
          "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
          "$.pullRequest.contract.provenance.repository.repositoryId",
          "The governed pull-request contract must carry a repository database identity.",
        );
      }
      if (baseBranch !== undefined && provenance.ref !== baseBranch) {
        addDiagnostic(
          diagnostics,
          "CHANGE_PROVENANCE_BASE_MISMATCH",
          "$.pullRequest.contract.provenance.ref",
          "The governed pull-request contract was not resolved from the canonical base branch.",
        );
      }
    }

    if (typeof bodyInput !== "string" && bodyInput !== null) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
        "$.pullRequest.body",
        "Physical pull-request body must be a string or null.",
      );
    } else if (bodyInput !== null && bodyInput.length > MAX_CHANGE_ARTIFACT_BODY_LENGTH) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
        "$.pullRequest.body",
        "Physical pull-request body exceeds the bounded evidence limit.",
      );
    } else {
      let existing: ExistingArtifactValidationResult;
      try {
        existing = validateExistingPullRequestArtifact(contract, bodyInput);
      } catch {
        addDiagnostic(
          diagnostics,
          "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
          "$.pullRequest.body",
          "Governed pull-request contract validation failed.",
        );
        return diagnostics.length === before;
      }
      if (!existing.valid) {
        const violations = existing.violations.length > 0 ? existing.violations : existing.parse.diagnostics;
        for (const violation of violations) {
          const path = "path" in violation && typeof violation.path === "string" ? violation.path : "$.body";
          const message =
            "message" in violation && typeof violation.message === "string" ? violation.message : "invalid";
          addDiagnostic(
            diagnostics,
            "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
            admissionDiagnosticPath("$.pullRequest.body", path),
            message,
          );
        }
        if (violations.length === 0) {
          addDiagnostic(
            diagnostics,
            "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
            "$.pullRequest.body",
            "Physical pull-request body does not satisfy the governed contract.",
          );
        }
      }
    }
  }
  return diagnostics.length === before;
}

function validateAdmissionIssuance(
  issuance: ChangeIssuancePlan,
  canonical: Change,
  canonicalBranch: string | undefined,
  canonicalBaseBranch: string | undefined,
  canonicalPullRequest: number | undefined,
  expectedIssuer: string | undefined,
  diagnostics: ChangeDiagnostic[],
): void {
  if (!sameChangeIdentity(issuance.transaction.identity, canonical.identity)) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_IDENTITY_MISMATCH",
      "$.issuance.transaction.identity",
      "Issuance transaction identity does not match the canonical Change.",
    );
  }
  if (!sameChangeIdentity(issuance.result.identity, canonical.identity)) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_IDENTITY_MISMATCH",
      "$.issuance.result.identity",
      "Issuance result identity does not match the canonical Change.",
    );
  }
  if (canonicalBranch !== undefined) {
    if (issuance.verification.canonicalBranch !== canonicalBranch) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_BRANCH_MISMATCH",
        "$.issuance.verification.canonicalBranch",
        "Issuance verification does not identify the canonical branch.",
      );
    }
    if (issuance.result.projection?.branch !== canonicalBranch) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_BRANCH_MISMATCH",
        "$.issuance.result.projection.branch",
        "Issuance result does not identify the canonical branch.",
      );
    }
  }
  if (canonicalBaseBranch !== undefined && issuance.verification.canonicalBaseBranch !== canonicalBaseBranch) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_BASE_MISMATCH",
      "$.issuance.verification.canonicalBaseBranch",
      "Issuance verification does not identify the canonical base branch.",
    );
  }
  const issuanceIssuer = issuance.result.provenance.issuer;
  if (issuanceIssuer === undefined) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_INVALID_ISSUER",
      "$.issuance.result.provenance.issuer",
      "Issuance result must identify its issuer.",
    );
  } else if (
    !isTrustedInariIssuerPrincipal(issuanceIssuer) ||
    expectedIssuer === undefined ||
    issuanceIssuer !== expectedIssuer
  ) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_ISSUER_MISMATCH",
      "$.issuance.result.provenance.issuer",
      "Issuance issuer provenance does not match the canonical issuer.",
    );
  }
  if (canonicalPullRequest !== undefined) {
    if (issuance.mode === "return-existing" && issuance.result.projection?.pullRequest !== canonicalPullRequest) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_PULL_REQUEST_MISMATCH",
        "$.issuance.result.projection.pullRequest",
        "Issuance does not identify the canonical pull request.",
      );
    }
    if (
      issuance.verification.pullRequest.number !== undefined &&
      issuance.verification.pullRequest.number !== canonicalPullRequest
    ) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_PULL_REQUEST_MISMATCH",
        "$.issuance.verification.pullRequest.number",
        "Issuance verification does not identify the canonical pull request.",
      );
    }
  }
}

/**
 * Validate one canonical Change for merge admission.
 *
 * The canonical snapshot and (when supplied) issuance plan establish the
 * governed identity. The #213 projection is recomputed from bounded physical
 * evidence, and the selected physical PR is checked without ever promoting
 * it to canonical identity merely because its intent looks similar.
 */
export function validateChangeMergeAdmission(input: unknown): ChangeMergeAdmissionValidationResult {
  const diagnostics: ChangeDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_INVALID_INPUT",
      "$",
      "Change merge-admission input must be a JSON object.",
    );
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  addUnknownProperties(input, CHANGE_MERGE_ADMISSION_INPUT_KEYS, "$", diagnostics);

  let issuance: ChangeIssuancePlan | undefined;
  const issuanceInput = readChangeMergeAdmissionAlias(input, ["issuance", "issuancePlan"], "$.issuance", diagnostics);
  if (issuanceInput.present) {
    const result = validateChangeIssuancePlan(issuanceInput.value);
    appendAdmissionDiagnostics(diagnostics, result.diagnostics, "$.issuance");
    issuance = result.plan;
  }

  const canonicalInput = readChangeMergeAdmissionAlias(
    input,
    ["change", "canonicalChange", "canonical"],
    "$.change",
    diagnostics,
  );
  let canonical: Change | undefined;
  if (!canonicalInput.present) {
    if (issuance?.result !== undefined) canonical = issuance.result;
    else addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.change", "Property is required.");
  } else {
    const result = validateChange(canonicalInput.value);
    appendAdmissionDiagnostics(diagnostics, result.diagnostics, "$.change");
    canonical = result.change;
  }

  const projectionInputAlias = readChangeMergeAdmissionAlias(
    input,
    ["projection", "projectionInput", "projectionResult"],
    "$.projection",
    diagnostics,
  );
  let projection: ChangeProjectionResult | undefined;
  let projectionSource = projectionInputAlias.value;
  const flattenedProjection =
    !projectionInputAlias.present &&
    ["branchGovernance", "naming", "baseBranch", "evidence", "provenance"].some((key) => hasOwn(input, key));
  if (flattenedProjection) {
    projectionSource = {
      change: canonicalInput.value ?? canonical,
      branchGovernance: input.branchGovernance,
      naming: input.naming,
      baseBranch: input.baseBranch,
      evidence: input.evidence,
      ...(hasOwn(input, "provenance") ? { provenance: input.provenance } : {}),
    };
  }
  const projectionIsRawInput = isRecord(projectionSource) && hasOwn(projectionSource, "evidence");
  if (!projectionInputAlias.present && !flattenedProjection) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.projection", "Property is required.");
  } else if (projectionIsRawInput) {
    const result = projectChangeFromGitHubEvidence(projectionSource);
    appendAdmissionDiagnostics(diagnostics, result.diagnostics, "$.projection");
    projection = result;
  } else {
    const result = validateChangeProjectionResult(projectionSource);
    appendAdmissionDiagnostics(diagnostics, result.diagnostics, "$.projection");
    projection = result.projection;
    if (projection !== undefined)
      appendAdmissionDiagnostics(diagnostics, projection.diagnostics, "$.projection.result");
  }

  // #214 remains the issuance authority even when an adapter passes only the
  // #213 projection input. Planning is pure and has no GitHub side effect.
  if (issuance === undefined && projectionIsRawInput) {
    try {
      issuance = planChangeIssuance(projectionSource);
    } catch {
      // The projection diagnostics already describe the fail-closed state.
    }
  }

  const pullRequestAlias = readChangeMergeAdmissionAlias(
    input,
    ["pullRequest", "governedPullRequest"],
    "$.pullRequest",
    diagnostics,
  );
  let pullRequest: ParsedChangeMergeAdmissionPullRequest | undefined;
  if (pullRequestAlias.present) {
    pullRequest = parseChangeMergeAdmissionPullRequest(pullRequestAlias.value, diagnostics);
  } else {
    const contractAlias = readChangeMergeAdmissionAlias(
      input,
      ["pullRequestContract", "prContract", "contract"],
      "$.pullRequest.contract",
      diagnostics,
    );
    const bodyAlias = readChangeMergeAdmissionAlias(
      input,
      ["pullRequestBody", "prBody", "body"],
      "$.pullRequest.body",
      diagnostics,
    );
    if (contractAlias.present || bodyAlias.present) {
      pullRequest = parseChangeMergeAdmissionPullRequest(
        {
          ...(contractAlias.present ? { contract: contractAlias.value } : {}),
          ...(bodyAlias.present ? { body: bodyAlias.value } : {}),
        },
        diagnostics,
      );
    }
  }
  if (pullRequest === undefined && !pullRequestAlias.present) {
    addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.pullRequest", "Property is required.");
  }

  const issuerAlias = readChangeMergeAdmissionAlias(input, ["issuer", "expectedIssuer"], "$.issuer", diagnostics);
  let explicitIssuer: string | undefined;
  if (issuerAlias.present) explicitIssuer = admissionIssuer(issuerAlias.value, "$.issuer", diagnostics);

  const canonicalIssuer = canonical?.provenance.issuer;
  if (canonical !== undefined && canonicalIssuer === undefined) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_INVALID_ISSUER",
      "$.change.provenance.issuer",
      "A canonical Change must identify its issuer.",
    );
  } else if (canonicalIssuer !== undefined && !isTrustedInariIssuerPrincipal(canonicalIssuer)) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_ISSUER_MISMATCH",
      "$.change.provenance.issuer",
      "Canonical Change issuer provenance is not anchored to the trusted Inari issuer authority.",
    );
  }
  if (explicitIssuer !== undefined && !isTrustedInariIssuerPrincipal(explicitIssuer)) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_ISSUER_MISMATCH",
      "$.issuer",
      "Explicit issuer provenance is not anchored to the trusted Inari issuer authority.",
    );
  }
  if (explicitIssuer !== undefined && canonicalIssuer !== undefined && explicitIssuer !== canonicalIssuer) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_ISSUER_MISMATCH",
      "$.issuer",
      "Explicit issuer provenance does not match the canonical Change.",
    );
  }
  const expectedIssuer = explicitIssuer ?? canonicalIssuer;

  if (canonical !== undefined && projection !== undefined) {
    const projectedIssuer = projection.change?.provenance.issuer;
    if (projectedIssuer === undefined) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_INVALID_ISSUER",
        "$.projection.change.provenance.issuer",
        "Projected canonical Change must identify its issuer.",
      );
    } else if (!isTrustedInariIssuerPrincipal(projectedIssuer) || projectedIssuer !== expectedIssuer) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_ISSUER_MISMATCH",
        "$.projection.change.provenance.issuer",
        "Projected Change issuer provenance does not match the trusted canonical issuer.",
      );
    }
    if (!sameChangeIdentity(canonical.identity, projection.change?.identity ?? canonical.identity)) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_IDENTITY_MISMATCH",
        "$.projection.change.identity",
        "Projection identity does not match the canonical Change.",
      );
    }
    if (!isChangeIssuanceHealthyState(canonical.state)) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_INVALID_INPUT",
        "$.change.state",
        "Only a healthy canonical Change can pass merge admission.",
      );
    }
    const canonicalBranch = canonical.projection?.branch;
    const canonicalPullRequest = canonical.projection?.pullRequest;
    if (canonicalBranch === undefined) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_BRANCH_MISMATCH",
        "$.change.projection.branch",
        "Canonical Change must identify its canonical branch.",
      );
    }
    if (canonicalPullRequest === undefined) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_PULL_REQUEST_MISMATCH",
        "$.change.projection.pullRequest",
        "Canonical Change must identify its canonical pull request.",
      );
    }

    if (projection.status !== "healthy" || !projection.valid) {
      if (projection.diagnostics.length === 0) {
        addDiagnostic(
          diagnostics,
          "CHANGE_PROVENANCE_CONFLICT",
          "$.projection.status",
          "Only a healthy Change projection can pass merge admission.",
        );
      }
    } else {
      const canonicalBranchCandidates = projection.candidates.branches.filter(
        (candidate) => candidate.classification === "canonical",
      );
      const canonicalPullRequestCandidates = projection.candidates.pullRequests.filter(
        (candidate) => candidate.classification === "canonical",
      );
      const conflictingCandidates = [...projection.candidates.branches, ...projection.candidates.pullRequests].filter(
        (candidate) => candidate.classification === "conflicting",
      );
      if (canonicalBranchCandidates.length !== 1 || canonicalPullRequestCandidates.length !== 1) {
        addDiagnostic(
          diagnostics,
          "CHANGE_PROVENANCE_CONFLICT",
          "$.projection.candidates",
          "A healthy projection must contain exactly one canonical branch and pull request candidate.",
        );
      }
      if (conflictingCandidates.length > 0) {
        addDiagnostic(
          diagnostics,
          "CHANGE_PROVENANCE_CONFLICT",
          "$.projection.candidates",
          "A healthy projection cannot contain conflicting candidates.",
        );
      }
      if (canonicalBranch !== undefined && projection.canonicalBranch !== canonicalBranch) {
        addDiagnostic(
          diagnostics,
          "CHANGE_PROVENANCE_BRANCH_MISMATCH",
          "$.projection.canonicalBranch",
          "Projection branch does not match the canonical Change.",
        );
      }
      if (projection.change === undefined) {
        addDiagnostic(
          diagnostics,
          "CHANGE_PROVENANCE_CONFLICT",
          "$.projection.change",
          "A healthy projection must contain a canonical Change snapshot.",
        );
      } else {
        if (projection.change.state !== canonical.state) {
          addDiagnostic(
            diagnostics,
            "CHANGE_PROVENANCE_CONFLICT",
            "$.projection.change.state",
            "Projection lifecycle state does not match the canonical Change.",
          );
        }
        if (canonicalBranch !== undefined && projection.change.projection?.branch !== canonicalBranch) {
          addDiagnostic(
            diagnostics,
            "CHANGE_PROVENANCE_BRANCH_MISMATCH",
            "$.projection.change.projection.branch",
            "Projected Change does not identify the canonical branch.",
          );
        }
        if (canonicalPullRequest !== undefined && projection.change.projection?.pullRequest !== canonicalPullRequest) {
          addDiagnostic(
            diagnostics,
            "CHANGE_PROVENANCE_PULL_REQUEST_MISMATCH",
            "$.projection.change.projection.pullRequest",
            "Projected Change does not identify the canonical pull request.",
          );
        }
      }
    }

    if (canonicalPullRequest !== undefined) {
      const physicalCandidates = projection.candidates.pullRequests.filter(
        (candidate) => candidate.candidate.number === canonicalPullRequest,
      );
      if (physicalCandidates.length !== 1) {
        addDiagnostic(
          diagnostics,
          "CHANGE_PROVENANCE_PULL_REQUEST_MISMATCH",
          "$.projection.candidates.pullRequests",
          "The pre-established canonical pull-request identity is not present exactly once in physical evidence.",
        );
      } else {
        const physical = physicalCandidates[0] as ChangeProjectionCandidate<ChangePullRequestEvidence>;
        if (physical.classification !== "canonical") {
          addDiagnostic(
            diagnostics,
            "CHANGE_PROVENANCE_CONFLICT",
            "$.projection.candidates.pullRequests",
            "The physical pull request is not a canonical projection candidate.",
          );
        }
        const candidate = physical.candidate;
        if (canonicalBranch !== undefined && candidate.head !== canonicalBranch) {
          addDiagnostic(
            diagnostics,
            "CHANGE_PROVENANCE_BRANCH_MISMATCH",
            "$.projection.candidates.pullRequests",
            "Physical pull-request head does not match the canonical branch.",
          );
        }
        if (projection.canonicalBaseBranch !== undefined && candidate.base !== projection.canonicalBaseBranch) {
          addDiagnostic(
            diagnostics,
            "CHANGE_PROVENANCE_BASE_MISMATCH",
            "$.projection.candidates.pullRequests",
            "Physical pull-request base does not match the canonical base branch.",
          );
        }
        if (candidate.rootIssue !== undefined && candidate.rootIssue !== canonical.identity.rootIssue) {
          addDiagnostic(
            diagnostics,
            "CHANGE_PROVENANCE_ROOT_ISSUE_MISMATCH",
            "$.projection.candidates.pullRequests",
            "Physical pull-request root Issue claim does not match the canonical Change.",
          );
        }
        const physicalIssuer = candidate.provenance?.issuer;
        if (physicalIssuer === undefined) {
          addDiagnostic(
            diagnostics,
            "CHANGE_PROVENANCE_INVALID_ISSUER",
            "$.projection.candidates.pullRequests",
            "The canonical physical pull request has no issuer provenance.",
          );
        } else if (
          !isTrustedInariIssuerPrincipal(physicalIssuer) ||
          expectedIssuer === undefined ||
          physicalIssuer !== expectedIssuer
        ) {
          addDiagnostic(
            diagnostics,
            "CHANGE_PROVENANCE_ISSUER_MISMATCH",
            "$.projection.candidates.pullRequests",
            "Physical pull-request issuer provenance does not match the canonical issuer.",
          );
        }
      }
    }

    if (issuance !== undefined) {
      validateAdmissionIssuance(
        issuance,
        canonical,
        canonicalBranch,
        projection.canonicalBaseBranch,
        canonicalPullRequest,
        expectedIssuer,
        diagnostics,
      );
    }

    if (pullRequest !== undefined && pullRequest.hasContract && pullRequest.hasBody) {
      validateAdmissionPullRequestContract(
        pullRequest.contract,
        pullRequest.body,
        canonical.identity,
        projection.canonicalBaseBranch,
        diagnostics,
      );
    }
  }

  const normalizedDiagnostics = createChangeDiagnosticReport(diagnostics).diagnostics;
  const valid =
    normalizedDiagnostics.length === 0 &&
    canonical !== undefined &&
    projection !== undefined &&
    projection.valid &&
    projection.status === "healthy" &&
    pullRequest !== undefined &&
    pullRequest.hasContract &&
    pullRequest.hasBody;
  const physicalPullRequest =
    canonical?.projection?.pullRequest === undefined || projection === undefined
      ? undefined
      : projection.candidates.pullRequests.find(
          (candidate) => candidate.candidate.number === canonical.projection?.pullRequest,
        )?.candidate;
  return {
    valid,
    ...(valid && canonical !== undefined ? { change: canonical } : {}),
    ...(projection === undefined ? {} : { projection }),
    ...(physicalPullRequest === undefined ? {} : { physicalPullRequest }),
    diagnostics: normalizedDiagnostics,
  };
}

export const validateCanonicalChangeProvenance = validateChangeMergeAdmission;
export const validateChangeProvenanceForMergeAdmission = validateChangeMergeAdmission;

interface ParsedChangeReadyArtifactEvidence {
  readonly contract?: unknown;
  readonly body?: unknown;
  readonly hasContract: boolean;
  readonly hasBody: boolean;
}

function parseChangeReadyArtifactEvidence(
  input: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
): ParsedChangeReadyArtifactEvidence | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_PROVENANCE_INVALID_INPUT", path, "Ready artifact evidence must be an object.");
    return undefined;
  }
  addUnknownProperties(input, CHANGE_READY_ARTIFACT_KEYS, path, diagnostics);
  const hasContract = hasOwn(input, "contract");
  const hasBody = hasOwn(input, "body");
  if (!hasContract) addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", `${path}.contract`, "Property is required.");
  if (!hasBody) addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", `${path}.body`, "Property is required.");
  return {
    ...(hasContract ? { contract: input.contract } : {}),
    ...(hasBody ? { body: input.body } : {}),
    hasContract,
    hasBody,
  };
}

function validateReadyArtifactBody(
  contract: CanonicalContract,
  bodyInput: unknown,
  path: string,
  diagnostics: ChangeDiagnostic[],
  subject?: { readonly repositoryHost: string; readonly repositoryId: string; readonly number: number },
): void {
  if (typeof bodyInput !== "string" && bodyInput !== null) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
      path,
      "Artifact body must be a string or null.",
    );
    return;
  }
  if (bodyInput !== null && bodyInput.length > MAX_CHANGE_ARTIFACT_BODY_LENGTH) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
      path,
      "Artifact body exceeds the bounded evidence limit.",
    );
    return;
  }
  try {
    const existing =
      contract.artifactKind === "issue"
        ? validateExistingIssueArtifact(contract, bodyInput, subject)
        : validateExistingPullRequestArtifact(contract, bodyInput);
    if (existing.valid) return;
    const violations = existing.violations.length > 0 ? existing.violations : existing.parse.diagnostics;
    for (const violation of violations) {
      const violationPath = "path" in violation && typeof violation.path === "string" ? violation.path : "$.body";
      const message = "message" in violation && typeof violation.message === "string" ? violation.message : "invalid";
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
        admissionDiagnosticPath(path, violationPath),
        message,
      );
    }
    if (violations.length === 0) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
        path,
        "Artifact body does not satisfy the governed contract.",
      );
    }
  } catch {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
      path,
      "Governed artifact contract validation failed.",
    );
  }
}

function validateReadyIssueArtifact(
  input: ParsedChangeReadyArtifactEvidence | undefined,
  identity: ChangeIdentity | undefined,
  baseBranch: string | undefined,
  diagnostics: ChangeDiagnostic[],
): void {
  if (input === undefined || !input.hasContract || !input.hasBody) return;
  const contractResult = validateCanonicalContract(input.contract);
  if (!contractResult.valid) {
    for (const violation of contractResult.violations) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
        admissionDiagnosticPath("$.issue.contract", violation.path),
        violation.message,
      );
    }
    return;
  }
  const contract = input.contract as CanonicalContract;
  if (contract.artifactKind !== "issue") {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
      "$.issue.contract.artifactKind",
      "The root Issue contract must be an Issue contract.",
    );
    return;
  }
  const provenance = contract.provenance;
  if (provenance === undefined) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
      "$.issue.contract.provenance",
      "The root Issue contract must carry trusted repository provenance.",
    );
  } else {
    if (identity !== undefined && provenance.repository.host.toLowerCase() !== identity.repositoryHost) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
        "$.issue.contract.provenance.repository.host",
        "The root Issue contract belongs to a different repository host.",
      );
    }
    if (identity !== undefined && provenance.repository.repositoryId !== identity.repositoryId) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
        "$.issue.contract.provenance.repository.repositoryId",
        "The root Issue contract does not identify the Change repository.",
      );
    }
    if (provenance.repository.repositoryId === undefined) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
        "$.issue.contract.provenance.repository.repositoryId",
        "The root Issue contract must carry a repository database identity.",
      );
    }
    if (baseBranch !== undefined && provenance.ref !== baseBranch) {
      addDiagnostic(
        diagnostics,
        "CHANGE_PROVENANCE_BASE_MISMATCH",
        "$.issue.contract.provenance.ref",
        "The root Issue contract was not resolved from the canonical base branch.",
      );
    }
  }
  if (identity !== undefined) {
    validateReadyArtifactBody(contract, input.body, "$.issue.body", diagnostics, {
      repositoryHost: identity.repositoryHost,
      repositoryId: identity.repositoryId,
      number: identity.rootIssue,
    });
  } else {
    validateReadyArtifactBody(contract, input.body, "$.issue.body", diagnostics);
  }
}

function validateReadyRootIssueEvidence(
  projectionInput: unknown,
  identity: ChangeIdentity | undefined,
  diagnostics: ChangeDiagnostic[],
): void {
  if (!isRecord(projectionInput) || !hasOwn(projectionInput, "evidence") || !isRecord(projectionInput.evidence)) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_EVIDENCE_MISSING",
      "$.projection.evidence.issue",
      "Ready validation requires fresh root Issue evidence.",
    );
    return;
  }
  const evidence = projectionInput.evidence;
  if (!hasOwn(evidence, "issue") || !isRecord(evidence.issue) || evidence.issue.status !== "available") {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_EVIDENCE_MISSING",
      "$.projection.evidence.issue",
      "Ready validation requires an available root Issue read.",
    );
    return;
  }
  const issueSource = evidence.issue;
  if (!isRecord(issueSource.value)) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_INVALID_EVIDENCE",
      "$.projection.evidence.issue.value",
      "Root Issue evidence is invalid.",
    );
    return;
  }
  if (issueSource.value.state !== "open") {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROVENANCE_ROOT_ISSUE_MISMATCH",
      "$.projection.evidence.issue.value.state",
      "The root Issue must remain open for the Ready transition.",
    );
  }
  if (identity !== undefined && issueSource.value.number !== identity.rootIssue) {
    addDiagnostic(
      diagnostics,
      "CHANGE_PROJECTION_ISSUE_MISMATCH",
      "$.projection.evidence.issue.value.number",
      "Root Issue evidence does not match the canonical Change identity.",
    );
  }
}

function readyAdmissionInput(input: RecordValue, diagnostics: ChangeDiagnostic[]): RecordValue {
  const admission: RecordValue = {};
  const canonical = readChangeMergeAdmissionAlias(
    input,
    ["change", "canonicalChange", "canonical"],
    "$.change",
    diagnostics,
  );
  if (canonical.present) admission.change = canonical.value;

  const projection = readChangeMergeAdmissionAlias(
    input,
    ["projection", "projectionInput", "projectionResult"],
    "$.projection",
    diagnostics,
  );
  if (projection.present) {
    admission.projection = projection.value;
  } else if (["branchGovernance", "naming", "baseBranch", "evidence", "provenance"].some((key) => hasOwn(input, key))) {
    admission.projection = {
      change: canonical.value,
      branchGovernance: input.branchGovernance,
      naming: input.naming,
      baseBranch: input.baseBranch,
      evidence: input.evidence,
      ...(hasOwn(input, "provenance") ? { provenance: input.provenance } : {}),
    };
  }

  const pullRequest = readChangeMergeAdmissionAlias(
    input,
    ["pullRequest", "governedPullRequest"],
    "$.pullRequest",
    diagnostics,
  );
  if (pullRequest.present) {
    admission.pullRequest = pullRequest.value;
  } else {
    const contract = readChangeMergeAdmissionAlias(
      input,
      ["pullRequestContract", "prContract", "contract"],
      "$.pullRequest.contract",
      diagnostics,
    );
    const body = readChangeMergeAdmissionAlias(
      input,
      ["pullRequestBody", "prBody", "body"],
      "$.pullRequest.body",
      diagnostics,
    );
    if (contract.present || body.present) {
      admission.pullRequest = {
        ...(contract.present ? { contract: contract.value } : {}),
        ...(body.present ? { body: body.value } : {}),
      };
    }
  }

  const issuer = readChangeMergeAdmissionAlias(input, ["issuer", "expectedIssuer"], "$.issuer", diagnostics);
  if (issuer.present) admission.issuer = issuer.value;
  return admission;
}

function readyIssueEvidence(
  input: RecordValue,
  diagnostics: ChangeDiagnostic[],
): ParsedChangeReadyArtifactEvidence | undefined {
  const nested = isRecord(input.readyEvidence) ? input.readyEvidence : undefined;
  if (nested !== undefined) {
    addUnknownProperties(nested, new Set(["issue", "rootIssue", "pullRequest"]), "$.readyEvidence", diagnostics);
  }
  const direct = readChangeMergeAdmissionAlias(
    input,
    ["issue", "rootIssue", "issueArtifact", "rootIssueArtifact"],
    "$.issue",
    diagnostics,
  );
  if (direct.present) return parseChangeReadyArtifactEvidence(direct.value, "$.issue", diagnostics);
  if (nested !== undefined) {
    const nestedIssue = readChangeMergeAdmissionAlias(
      nested,
      ["issue", "rootIssue"],
      "$.readyEvidence.issue",
      diagnostics,
    );
    if (nestedIssue.present) return parseChangeReadyArtifactEvidence(nestedIssue.value, "$.issue", diagnostics);
  }
  const contract = readChangeMergeAdmissionAlias(
    input,
    ["issueContract", "rootIssueContract"],
    "$.issue.contract",
    diagnostics,
  );
  const body = readChangeMergeAdmissionAlias(input, ["issueBody", "rootIssueBody"], "$.issue.body", diagnostics);
  if (contract.present || body.present) {
    return parseChangeReadyArtifactEvidence(
      {
        ...(contract.present ? { contract: contract.value } : {}),
        ...(body.present ? { body: body.value } : {}),
      },
      "$.issue",
      diagnostics,
    );
  }
  addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.issue", "Root Issue governance evidence is required.");
  return undefined;
}

function readyPullRequestInput(input: RecordValue): unknown {
  if (hasOwn(input, "pullRequest") || hasOwn(input, "governedPullRequest")) return undefined;
  const nested = isRecord(input.readyEvidence) ? input.readyEvidence : undefined;
  if (nested !== undefined && (hasOwn(nested, "pullRequest") || hasOwn(nested, "governedPullRequest"))) {
    return nested.pullRequest ?? nested.governedPullRequest;
  }
  return undefined;
}

/** Validate every semantic precondition before a Ready effect can be planned. */
export function validateChangeReadyTransition(input: unknown): ChangeReadyTransitionValidationResult {
  const diagnostics: ChangeDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHANGE_PROVENANCE_INVALID_INPUT", "$", "Ready transition input must be an object.");
    return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
  }
  addUnknownProperties(input, CHANGE_READY_INPUT_KEYS, "$", diagnostics);
  const admissionInput = readyAdmissionInput(input, diagnostics);
  const nestedReadyPullRequest = readyPullRequestInput(input);
  if (nestedReadyPullRequest !== undefined && !hasOwn(admissionInput, "pullRequest")) {
    admissionInput.pullRequest = nestedReadyPullRequest;
  }
  const admission = validateChangeMergeAdmission(admissionInput);
  appendAdmissionDiagnostics(diagnostics, admission.diagnostics, "$");

  const canonicalValue = admissionInput.change;
  const canonicalResult = validateChange(canonicalValue);
  const identity = canonicalResult.change?.identity;
  const projectionValue = admissionInput.projection;
  validateReadyRootIssueEvidence(projectionValue, identity, diagnostics);

  const issueEvidence = readyIssueEvidence(input, diagnostics);
  const baseBranch = admission.projection?.canonicalBaseBranch;
  validateReadyIssueArtifact(issueEvidence, identity, baseBranch, diagnostics);

  let idempotent = false;
  if (admission.valid && admission.change !== undefined) {
    if (admission.change.state !== "DRAFT" && admission.change.state !== "REVIEW") {
      addDiagnostic(
        diagnostics,
        "CHANGE_TRANSITION_NOT_ALLOWED",
        "$.change.state",
        `Ready transition is only allowed from DRAFT or REVIEW, not ${admission.change.state}.`,
      );
    } else {
      idempotent = admission.change.state === "REVIEW";
    }
  }

  const normalizedDiagnostics = createChangeDiagnosticReport(diagnostics).diagnostics;
  const valid = admission.valid && normalizedDiagnostics.length === 0;
  return {
    valid,
    ...(valid && admission.change !== undefined ? { change: admission.change } : {}),
    ...(admission.projection === undefined ? {} : { projection: admission.projection }),
    ...(admission.physicalPullRequest === undefined ? {} : { physicalPullRequest: admission.physicalPullRequest }),
    ...(valid ? { idempotent } : {}),
    diagnostics: normalizedDiagnostics,
  };
}

export class ChangeReadyTransitionValidationError extends ChangeTransitionValidationError {
  constructor(diagnostics: readonly ChangeDiagnostic[]) {
    super(diagnostics);
    this.name = "ChangeReadyTransitionValidationError";
  }
}

/** Plan Ready only after the Core-owned precondition gate succeeds. */
export function planChangeReadyTransition(input: unknown): ChangeTransitionPlan {
  const result = validateChangeReadyTransition(input);
  if (!result.valid || result.change === undefined) {
    throw new ChangeReadyTransitionValidationError(result.diagnostics);
  }
  return planChangeTransition({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    transition: "ready",
    change: result.change,
    target: {
      branch: result.change.projection?.branch,
      pullRequest: result.change.projection?.pullRequest,
    },
  });
}

export const validateReadyTransition = validateChangeReadyTransition;
export const planReadyTransition = planChangeReadyTransition;
