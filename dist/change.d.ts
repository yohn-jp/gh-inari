/**
 * The transport-independent semantic contract for a governed Change.
 *
 * This module owns transport-independent Change data, validation, canonical
 * serialization, pure canonical branch identity derivation, the lifecycle
 * transition matrix, and pure effect planning. It does not read or mutate
 * GitHub state or execute effects.
 */
import type { PullRequestBranchGovernance } from "./contract/ir.js";
export declare const CHANGE_CONTRACT_VERSION: 1;
export type ChangeContractVersion = typeof CHANGE_CONTRACT_VERSION;
export declare const CHANGE_STATES: readonly ["DEFINED", "DRAFT", "REVIEW", "ACCEPTED", "MERGED", "ABORTED", "RECOVERY_REQUIRED"];
export type ChangeState = (typeof CHANGE_STATES)[number];
export declare const CHANGE_PROVENANCE_ROLES: readonly ["requester", "issuer", "implementer", "reviewer", "merger"];
export type ChangeProvenanceRole = (typeof CHANGE_PROVENANCE_ROLES)[number];
/** Boundaries keep machine-readable failures safe to return to callers. */
export declare const MAX_CHANGE_DIAGNOSTICS: 32;
export declare const MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH: 240;
export declare const MAX_CHANGE_DIAGNOSTIC_PATH_LENGTH: 160;
export declare const MAX_CHANGE_PRINCIPAL_LENGTH: 160;
export declare const MAX_CHANGE_BRANCH_LENGTH: 255;
export declare const MAX_CHANGE_HOST_LENGTH: 255;
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
export declare const CHANGE_TRANSITION_CONTRACT_VERSION: 1;
export type ChangeTransitionContractVersion = typeof CHANGE_TRANSITION_CONTRACT_VERSION;
/**
 * `merge` is reserved for a future merge-coordination capability.  It is
 * represented in the request vocabulary but is intentionally not executable
 * by this planning contract yet.
 */
export declare const CHANGE_TRANSITION_OPERATIONS: readonly ["issue", "ready", "abort", "merge"];
export type ChangeTransition = (typeof CHANGE_TRANSITION_OPERATIONS)[number];
export type ChangeTransitionOperation = ChangeTransition;
export declare const CHANGE_TRANSITIONS: readonly ["issue", "ready", "abort", "merge"];
export declare const CHANGE_IMPLEMENTED_TRANSITIONS: readonly ["issue", "ready", "abort"];
/** The only lifecycle edges currently owned by Inari Core. */
export declare const CHANGE_TRANSITION_RULES: readonly [{
    readonly transition: "issue";
    readonly from: "DEFINED";
    readonly to: "DRAFT";
}, {
    readonly transition: "ready";
    readonly from: "DRAFT";
    readonly to: "REVIEW";
}, {
    readonly transition: "abort";
    readonly from: "DRAFT";
    readonly to: "ABORTED";
}, {
    readonly transition: "abort";
    readonly from: "REVIEW";
    readonly to: "ABORTED";
}];
export declare const CHANGE_TRANSITION_MATRIX: readonly [{
    readonly transition: "issue";
    readonly from: "DEFINED";
    readonly to: "DRAFT";
}, {
    readonly transition: "ready";
    readonly from: "DRAFT";
    readonly to: "REVIEW";
}, {
    readonly transition: "abort";
    readonly from: "DRAFT";
    readonly to: "ABORTED";
}, {
    readonly transition: "abort";
    readonly from: "REVIEW";
    readonly to: "ABORTED";
}];
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
export declare const CHANGE_EFFECT_KINDS: readonly ["CREATE_BRANCH", "CREATE_PULL_REQUEST", "MARK_PULL_REQUEST_READY", "CLOSE_PULL_REQUEST"];
export type ChangeEffectKind = (typeof CHANGE_EFFECT_KINDS)[number];
/**
 * Effects are declarative capabilities for a later executor.  They contain
 * no GitHub client, credential, workflow, or mutation implementation.
 */
export type ChangeEffect = {
    readonly kind: "CREATE_BRANCH";
    readonly branch: string;
    readonly baseBranch: string;
} | {
    readonly kind: "CREATE_PULL_REQUEST";
    readonly branch: string;
    readonly baseBranch: string;
    readonly rootIssue: number;
    readonly draft: true;
} | {
    readonly kind: "MARK_PULL_REQUEST_READY";
    readonly pullRequest: number;
} | {
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
export type ChangeDiagnosticCode = "CHANGE_INVALID_JSON" | "CHANGE_INVALID_ROOT" | "CHANGE_MISSING_PROPERTY" | "CHANGE_UNKNOWN_PROPERTY" | "CHANGE_UNSUPPORTED_VERSION" | "CHANGE_INVALID_IDENTITY" | "CHANGE_INVALID_STATE" | "CHANGE_INVALID_PROVENANCE" | "CHANGE_INVALID_PROJECTION" | "CHANGE_INVALID_BRANCH_INPUT" | "CHANGE_INVALID_BRANCH_GOVERNANCE" | "CHANGE_BRANCH_GOVERNANCE_MISMATCH" | "CHANGE_INVALID_TRANSITION" | "CHANGE_UNSUPPORTED_TRANSITION" | "CHANGE_TRANSITION_NOT_ALLOWED" | "CHANGE_INVALID_TRANSITION_TARGET" | "CHANGE_INVALID_EFFECT" | "CHANGE_INVALID_PLAN" | "CHANGE_PROJECTION_INVALID_EVIDENCE" | "CHANGE_PROJECTION_EVIDENCE_MISSING" | "CHANGE_PROJECTION_EVIDENCE_UNAVAILABLE" | "CHANGE_PROJECTION_ISSUE_MISMATCH" | "CHANGE_PROJECTION_PARTIAL" | "CHANGE_PROJECTION_DUPLICATE" | "CHANGE_PROJECTION_WRONG_BASE" | "CHANGE_PROJECTION_AMBIGUOUS" | "CHANGE_PROJECTION_CONFLICT";
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
export declare const CHANGE_PROJECTION_STATUSES: readonly ["healthy", "absent", "partial", "duplicate", "wrong-base", "ambiguous", "unavailable"];
export type ChangeProjectionStatus = (typeof CHANGE_PROJECTION_STATUSES)[number];
export declare const CHANGE_PROJECTION_CANDIDATE_CLASSES: readonly ["canonical", "noncanonical", "conflicting"];
export type ChangeProjectionCandidateClass = (typeof CHANGE_PROJECTION_CANDIDATE_CLASSES)[number];
export declare const CHANGE_EVIDENCE_STATUSES: readonly ["available", "absent", "unavailable"];
export type ChangeEvidenceStatus = (typeof CHANGE_EVIDENCE_STATUSES)[number];
/** A read result distinguishes confirmed absence from an unavailable read. */
export type ChangeEvidenceSource<T> = {
    readonly status: "available";
    readonly value: T;
} | {
    readonly status: "absent";
} | {
    readonly status: "unavailable";
    readonly reason: string;
};
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
export declare const MAX_CHANGE_BASE_BRANCH_LENGTH: 255;
export declare const MAX_CHANGE_TRANSITION_EFFECTS: 8;
export declare const MAX_CHANGE_PROJECTION_CANDIDATES: 64;
/** Create one bounded, versioned machine-readable diagnostic. */
export declare function createChangeDiagnostic(input: ChangeDiagnosticInput): ChangeDiagnostic;
/** Sort and bound a diagnostic set for deterministic machine consumption. */
export declare function createChangeDiagnosticReport(diagnostics: readonly ChangeDiagnostic[]): ChangeDiagnosticReport;
export declare function serializeChangeDiagnosticReport(report: ChangeDiagnosticReport): string;
export declare function deserializeChangeDiagnosticReport(serialized: string): ChangeDiagnosticReport;
/** Validate and canonicalize the repository/root-Issue identity. */
export declare function validateChangeIdentity(input: unknown, path?: string): ChangeIdentityValidationResult;
export declare const normalizeChangeIdentity: typeof validateChangeIdentity;
export declare const projectChangeIdentity: typeof validateChangeIdentity;
/**
 * Derive one canonical branch identity from a validated Change identity,
 * repository branch governance, and governance-resolved naming parts.
 *
 * The branch grammar is owned by the shared branch authority. This function
 * only supplies the Change Issue number, verifies the repository policy, and
 * returns a pure projection; it never creates or updates a Git ref.
 */
export declare function deriveCanonicalBranchIdentity(input: unknown): CanonicalBranchIdentityDerivationResult;
/**
 * Purely project one Change from bounded Issue, branch, and pull-request
 * evidence. Existing Change state is never used as authority, and no GitHub
 * client, persistence, mutation, or candidate heuristic is involved.
 */
export declare function projectChangeFromGitHubEvidence(input: unknown): ChangeProjectionResult;
export declare const projectChangeFromEvidence: typeof projectChangeFromGitHubEvidence;
export declare const deriveChangeProjection: typeof projectChangeFromGitHubEvidence;
/** Stable identity key; locator changes cannot create a second Change. */
export declare function changeIdentityKey(input: ChangeIdentity): string;
/** Validate the five provenance roles without imposing transition policy. */
export declare function validateChangeProvenance(input: unknown, path?: string): ChangeProvenanceValidationResult;
/** Validate semantic branch/PR projection fields without naming-policy logic. */
export declare function validateChangeProjection(input: unknown, path?: string): ChangeProjectionValidationResult;
/** Validate and canonicalize one complete Change snapshot. */
export declare function validateChange(input: unknown): ChangeValidationResult;
export declare const normalizeChange: typeof validateChange;
export declare const projectChange: typeof validateChange;
export declare function isChange(input: unknown): input is Change;
export declare class ChangeValidationError extends Error {
    readonly code: ChangeDiagnosticCode;
    readonly path: string;
    readonly diagnostics: readonly ChangeDiagnostic[];
    constructor(diagnostics: readonly ChangeDiagnostic[]);
    toJSON(): {
        code: ChangeDiagnosticCode;
        path: string;
        message: string;
        diagnostics: readonly ChangeDiagnostic[];
    };
}
export declare function assertChange(input: unknown): asserts input is Change;
/** Serialize the canonical representation, with stable property ordering. */
export declare function serializeChange(input: unknown): string;
/** Parse an untrusted JSON boundary and return the canonical Change value. */
export declare function deserializeChange(serialized: string): Change;
export declare const parseChange: typeof deserializeChange;
export declare const serializeChangeContract: typeof serializeChange;
/** Validate a transport-independent lifecycle request and its transition policy. */
export declare function validateChangeTransitionRequest(input: unknown): ChangeTransitionRequestValidationResult;
export declare const validateChangeTransition: typeof validateChangeTransitionRequest;
/** Assert a valid request at a trusted Core call boundary. */
export declare function assertChangeTransitionRequest(input: unknown): asserts input is ChangeTransitionRequest;
/**
 * Produce a deterministic declarative plan.  This function has no I/O and
 * never invokes an adapter or a privileged GitHub capability.
 */
export declare function planChangeTransition(input: unknown): ChangeTransitionPlan;
export declare const createChangeTransitionPlan: typeof planChangeTransition;
/** Validate one declarative effect primitive without executing it. */
export declare function validateChangeEffect(input: unknown, path?: string): ChangeEffectValidationResult;
/** Validate and canonicalize a previously generated or transported plan. */
export declare function validateChangeTransitionPlan(input: unknown): ChangeTransitionPlanValidationResult;
export declare const validateChangePlan: typeof validateChangeTransitionPlan;
/** Assert a valid declarative plan at an executor boundary. */
export declare function assertChangeTransitionPlan(input: unknown): asserts input is ChangeTransitionPlan;
export declare class ChangeTransitionValidationError extends ChangeValidationError {
    constructor(diagnostics: readonly ChangeDiagnostic[]);
}
/** Serialize the canonical transition request with stable property ordering. */
export declare function serializeChangeTransitionRequest(input: unknown): string;
/** Parse and validate an untrusted transition request JSON boundary. */
export declare function deserializeChangeTransitionRequest(serialized: string): ChangeTransitionRequest;
/** Serialize the canonical effect plan with stable property ordering. */
export declare function serializeChangeTransitionPlan(input: unknown): string;
/** Parse and validate an untrusted effect plan JSON boundary. */
export declare function deserializeChangeTransitionPlan(serialized: string): ChangeTransitionPlan;
export declare function isChangeTransitionRequest(input: unknown): input is ChangeTransitionRequest;
export declare function isChangeTransitionPlan(input: unknown): input is ChangeTransitionPlan;
export declare const parseChangeTransitionRequest: typeof deserializeChangeTransitionRequest;
export declare const parseChangeTransitionPlan: typeof deserializeChangeTransitionPlan;
export declare const serializeChangeTransitionRequestContract: typeof serializeChangeTransitionRequest;
export declare const serializeChangeTransitionPlanContract: typeof serializeChangeTransitionPlan;
