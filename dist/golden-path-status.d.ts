/**
 * Pure, transport-neutral projection of the Inari Golden Path.
 *
 * This module composes bounded evidence owned by Repository Canon, Issue
 * Core, and Change Core.  It does not persist a status, execute an effect, or
 * reproduce Change lifecycle legality.  In particular, a Change snapshot is
 * never used to overwrite a fresh Change projection.
 */
import { type Change, type ChangeIdentity, type ChangeProjectionResult, type ChangeProjectionStatus, type ChangeState } from "./change.js";
import { type ChangeRemoteExecutionOutcome } from "./change-executor.js";
export declare const GOLDEN_PATH_STATUS_VERSION: 1;
/** Alias used by callers that name the envelope as a contract. */
export declare const GOLDEN_PATH_STATUS_CONTRACT_VERSION: 1;
export type GoldenPathStatusVersion = typeof GOLDEN_PATH_STATUS_VERSION;
export declare const GOLDEN_PATH_PHASES: readonly ["ENVIRONMENT", "GOVERNANCE", "ISSUE", "CHANGE", "IMPLEMENTATION", "READY", "REVIEW", "TERMINAL", "RECOVERY"];
export type GoldenPathPhase = (typeof GOLDEN_PATH_PHASES)[number];
export declare const GOLDEN_PATH_AVAILABILITIES: readonly ["actionable", "blocked", "recovery-required", "terminal"];
export type GoldenPathAvailability = (typeof GOLDEN_PATH_AVAILABILITIES)[number];
/** Normal actions deliberately exclude recovery actions owned by #410. */
export declare const GOLDEN_PATH_NORMAL_ACTION_KINDS: readonly ["PREFLIGHT", "DISCOVER_GOVERNANCE", "CREATE_ISSUE", "ISSUE_CHANGE", "IMPLEMENT", "READY_CHANGE", "REVIEW", "WAIT"];
export type GoldenPathNormalActionKind = (typeof GOLDEN_PATH_NORMAL_ACTION_KINDS)[number];
export declare const GOLDEN_PATH_NEXT_ACTION_KINDS: readonly ["PREFLIGHT", "DISCOVER_GOVERNANCE", "CREATE_ISSUE", "ISSUE_CHANGE", "IMPLEMENT", "READY_CHANGE", "REVIEW", "WAIT"];
export type GoldenPathNextActionKind = GoldenPathNormalActionKind;
/** Recovery actions are a separate boundary; this module only projects supplied recovery evidence. */
export declare const GOLDEN_PATH_RECOVERY_ACTION_KINDS: readonly ["RETRY", "ABORT", "RECOVER", "MANUAL_REVIEW"];
export type GoldenPathRecoveryActionKind = (typeof GOLDEN_PATH_RECOVERY_ACTION_KINDS)[number];
export declare const GOLDEN_PATH_ACTION_KINDS: readonly ["PREFLIGHT", "DISCOVER_GOVERNANCE", "CREATE_ISSUE", "ISSUE_CHANGE", "IMPLEMENT", "READY_CHANGE", "REVIEW", "WAIT", "RETRY", "ABORT", "RECOVER", "MANUAL_REVIEW"];
export type GoldenPathActionKind = (typeof GOLDEN_PATH_ACTION_KINDS)[number];
export declare const GOLDEN_PATH_ACTION_OWNERS: readonly ["caller", "inari", "worker", "repository", "recovery"];
export type GoldenPathActionOwner = (typeof GOLDEN_PATH_ACTION_OWNERS)[number];
export declare const GOLDEN_PATH_REASON_CODES: readonly ["PACKAGE_CAPABILITY_REQUIRED", "GOVERNANCE_DISCOVERY_REQUIRED", "GOVERNED_ISSUE_REQUIRED", "CHANGE_ISSUANCE_REQUIRED", "CHANGE_ISSUED", "READY_PRECONDITIONS_REQUIRED", "REVIEW_ADMITTED", "AUTHORITATIVE_REREAD_REQUIRED", "IDEMPOTENT_RETRY", "ABORT_CLEANUP_REQUIRED", "RECOVERY_ACTION_REQUIRED", "MANUAL_RECOVERY_REVIEW_REQUIRED", "WAIT_FOR_REPOSITORY_REVIEW"];
export type GoldenPathReasonCode = (typeof GOLDEN_PATH_REASON_CODES)[number];
export declare const GOLDEN_PATH_STATUS_RECOVERY_CLASSES: readonly ["ISSUANCE_PARTIAL_PROJECTION", "ISSUANCE_COMPENSATION_UNSAFE", "ABORT_CLEANUP_PENDING", "ABORT_CLEANUP_UNSAFE", "POST_EFFECT_VERIFICATION"];
export type GoldenPathStatusRecoveryClass = (typeof GOLDEN_PATH_STATUS_RECOVERY_CLASSES)[number];
export declare const GOLDEN_PATH_AUTOMATIC_CLEANUP: readonly ["none", "conditional", "forbidden"];
export type GoldenPathAutomaticCleanup = (typeof GOLDEN_PATH_AUTOMATIC_CLEANUP)[number];
export interface GoldenPathSubject {
    readonly repositoryHost?: string;
    readonly repositoryId?: string;
    readonly rootIssue?: number;
}
export interface GoldenPathStatusFields {
    readonly phase: GoldenPathPhase;
    readonly availability: GoldenPathAvailability;
    readonly changeState?: ChangeState;
    readonly projectionStatus?: ChangeProjectionStatus;
    readonly executionOutcome?: ChangeRemoteExecutionOutcome;
}
export interface GoldenPathNextAction {
    readonly kind: GoldenPathNormalActionKind;
    readonly owner: GoldenPathActionOwner;
    readonly reasonCode: GoldenPathReasonCode;
}
export interface GoldenPathRecoveryNextAction {
    readonly kind: GoldenPathRecoveryActionKind;
    readonly owner: "recovery";
    readonly reasonCode: GoldenPathReasonCode;
    readonly retryOf?: GoldenPathNormalActionKind;
}
export type GoldenPathAdmissibleAction = GoldenPathNextAction | GoldenPathRecoveryNextAction;
export interface GoldenPathRecoveryProjection {
    readonly class: GoldenPathStatusRecoveryClass;
    readonly safeAction: GoldenPathRecoveryActionKind;
    readonly retryable: boolean;
    readonly rereadRequired: true;
    readonly automaticCleanup: GoldenPathAutomaticCleanup;
    readonly retryOf?: GoldenPathNormalActionKind;
    readonly reasonCode?: GoldenPathReasonCode;
}
export type GoldenPathDiagnosticCode = "GOLDEN_PATH_INPUT_INVALID" | "GOLDEN_PATH_INPUT_UNKNOWN_PROPERTY" | "GOLDEN_PATH_EVIDENCE_UNAVAILABLE" | "GOLDEN_PATH_EVIDENCE_CONTRADICTORY" | "GOLDEN_PATH_EVIDENCE_INCOMPLETE" | "GOLDEN_PATH_PROJECTION_INVALID" | "GOLDEN_PATH_RECOVERY_INVALID" | "GOLDEN_PATH_RECOVERY_REQUIRED";
export interface GoldenPathDiagnostic {
    readonly code: GoldenPathDiagnosticCode;
    readonly path: string;
    readonly message: string;
}
/** Versioned result returned by the pure Golden Path projector. */
export interface GoldenPathStatus {
    readonly version: GoldenPathStatusVersion;
    readonly subject?: GoldenPathSubject;
    readonly status: GoldenPathStatusFields;
    /** Exactly zero or one action. `null` is canonical for no safe action. */
    readonly nextAction: GoldenPathAdmissibleAction | null;
    readonly recovery: GoldenPathRecoveryProjection | null;
    readonly diagnostics: readonly GoldenPathDiagnostic[];
}
export type GoldenPathStatusEnvelope = GoldenPathStatus;
export type GoldenPathResult = GoldenPathStatus;
export type GoldenPathStatusProjection = GoldenPathStatus;
export type GoldenPathStatusProjectionInput = GoldenPathStatusInput;
export interface GoldenPathStatusProjectionResult {
    readonly valid: boolean;
    readonly projection?: GoldenPathStatus;
    readonly diagnostics: readonly GoldenPathDiagnostic[];
}
export declare class GoldenPathStatusError extends Error {
    readonly diagnostics: readonly GoldenPathDiagnostic[];
    constructor(diagnostics: readonly GoldenPathDiagnostic[]);
}
export interface GoldenPathEnvironmentEvidence {
    readonly status?: "available" | "unavailable" | "unknown";
    readonly available?: boolean;
    readonly ready?: boolean;
    readonly verified?: boolean;
    readonly packageIdentity?: string;
    readonly capabilities?: readonly string[];
}
export interface GoldenPathGovernanceEvidence {
    readonly status?: "available" | "unavailable" | "unknown";
    readonly available?: boolean;
    readonly valid?: boolean;
    readonly repositoryHost?: string;
    readonly repositoryId?: string;
}
export interface GoldenPathIssueEvidence {
    readonly status?: "present" | "absent" | "unavailable" | "unknown";
    readonly exists?: boolean;
    readonly governed?: boolean;
    readonly number?: number;
    readonly state?: "open" | "closed";
}
export interface GoldenPathImplementationEvidence {
    readonly status?: "ready" | "in-progress" | "unavailable" | "unknown";
    readonly ready?: boolean;
    readonly complete?: boolean;
    readonly evidence?: boolean;
}
export interface GoldenPathReadyEvidence {
    readonly status?: "eligible" | "ineligible" | "unavailable" | "unknown";
    readonly eligible?: boolean;
    readonly preconditions?: boolean;
    readonly evidence?: boolean;
}
export interface GoldenPathReviewEvidence {
    readonly status?: "required" | "waiting" | "complete" | "unavailable" | "unknown";
    readonly action?: "review" | "wait";
}
export interface GoldenPathChangeEvidence {
    readonly projection?: ChangeProjectionResult;
    readonly state?: ChangeState;
    readonly projectionStatus?: ChangeProjectionStatus;
    readonly subject?: GoldenPathSubject;
}
export interface GoldenPathStatusInput {
    readonly environment?: GoldenPathEnvironmentEvidence | boolean | "available" | "unavailable" | "unknown";
    readonly governance?: GoldenPathGovernanceEvidence | boolean | "available" | "unavailable" | "unknown";
    readonly issue?: GoldenPathIssueEvidence | boolean | "present" | "absent" | "unavailable" | "unknown";
    /** A full Change snapshot/identity, a bounded Change evidence object, or a projection result. */
    readonly change?: Change | ChangeIdentity | GoldenPathChangeEvidence;
    readonly changeProjection?: ChangeProjectionResult;
    readonly projection?: ChangeProjectionResult;
    readonly executionOutcome?: ChangeRemoteExecutionOutcome;
    readonly execution?: {
        readonly outcome?: ChangeRemoteExecutionOutcome;
    };
    readonly implementation?: GoldenPathImplementationEvidence | boolean | "ready" | "in-progress" | "unknown";
    readonly ready?: GoldenPathReadyEvidence | boolean | "eligible" | "ineligible" | "unknown";
    readonly review?: GoldenPathReviewEvidence;
    /** Recovery is supplied by the recovery leaf; this projector does not classify it. */
    readonly recovery?: GoldenPathRecoveryProjection | null;
    readonly subject?: GoldenPathSubject;
}
/** Non-throwing projection entry point. */
export declare function tryProjectGoldenPathStatus(input: unknown): GoldenPathStatusProjectionResult;
/** Throwing projection entry point for Core callers. */
export declare function projectGoldenPathStatus(input: unknown): GoldenPathStatus;
export declare const projectGoldenPath: typeof projectGoldenPathStatus;
export declare const tryProjectGoldenPath: typeof tryProjectGoldenPathStatus;
export declare const projectGoldenPathStatusFromEvidence: typeof projectGoldenPathStatus;
export declare const deriveGoldenPathStatus: typeof projectGoldenPathStatus;
export interface GoldenPathStatusValidationResult {
    readonly valid: boolean;
    readonly status?: GoldenPathStatus;
    /** Alias for consumers using the projection vocabulary. */
    readonly projection?: GoldenPathStatus;
    readonly diagnostics: readonly GoldenPathDiagnostic[];
}
/** Validate a serialized status at a transport boundary without exposing internal runtime types. */
export declare function validateGoldenPathStatus(input: unknown): GoldenPathStatusValidationResult;
export declare const assertGoldenPathStatus: (input: unknown) => asserts input is GoldenPathStatus;
