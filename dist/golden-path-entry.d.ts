/**
 * Golden Path entry composition.
 *
 * This module is intentionally a projection boundary. Repository Canon and
 * Semantic Artifact Core prove that the root Issue is governed; Change Core
 * proves whether a canonical Change is absent or healthy and owns the
 * issuance plan. The module only joins those existing results and identifies
 * the one existing operation a caller may invoke. It does not own a
 * lifecycle, branch naming rule, PR identity, persistence, or a transport.
 */
import { type Change, type ChangeDiagnostic, type ChangeIdentity, type ChangeProjectionInput, type ChangeProjectionResult, type ChangeProjectionStatus, type ChangeReadyArtifactEvidence, type ChangeState } from "./change.js";
import { type ChangeRemoteExecutionOutcome, type ChangeRemoteExecutor } from "./change-executor.js";
import type { EffectiveArtifactContract } from "./contract/effective-artifact-contract.js";
import { type ArtifactContractProvenance } from "./contract/ir.js";
import { type SemanticArtifact } from "./contract/semantic-artifact.js";
/** Version of the transport-neutral entry projection. */
export declare const GOLDEN_PATH_ENTRY_CONTRACT_VERSION: 1;
export type GoldenPathEntryContractVersion = typeof GOLDEN_PATH_ENTRY_CONTRACT_VERSION;
export declare const GOLDEN_PATH_ENTRY_CONTRACT_ID: "urn:inari:golden-path-entry:1";
export declare const GOLDEN_PATH_ENTRY_PHASES: readonly ["ENVIRONMENT", "GOVERNANCE", "ISSUE", "CHANGE", "IMPLEMENTATION", "READY", "REVIEW", "TERMINAL", "RECOVERY"];
export type GoldenPathEntryPhase = (typeof GOLDEN_PATH_ENTRY_PHASES)[number];
export declare const GOLDEN_PATH_ENTRY_AVAILABILITIES: readonly ["actionable", "blocked", "recovery-required", "terminal"];
export type GoldenPathEntryAvailability = (typeof GOLDEN_PATH_ENTRY_AVAILABILITIES)[number];
export declare const GOLDEN_PATH_ENTRY_ACTION_KINDS: readonly ["PREFLIGHT", "DISCOVER_GOVERNANCE", "CREATE_ISSUE", "ISSUE_CHANGE", "IMPLEMENT", "READY_CHANGE", "REVIEW", "RETRY", "ABORT", "RECOVER", "MANUAL_REVIEW", "WAIT"];
export type GoldenPathEntryActionKind = (typeof GOLDEN_PATH_ENTRY_ACTION_KINDS)[number];
export declare const GOLDEN_PATH_ENTRY_REASON_CODES: readonly ["PACKAGE_CAPABILITY_REQUIRED", "GOVERNANCE_DISCOVERY_REQUIRED", "GOVERNED_ISSUE_REQUIRED", "CHANGE_ISSUANCE_REQUIRED", "CHANGE_ISSUED", "READY_PRECONDITIONS_REQUIRED", "REVIEW_ADMITTED", "AUTHORITATIVE_REREAD_REQUIRED", "IDEMPOTENT_RETRY", "ABORT_CLEANUP_REQUIRED", "RECOVERY_ACTION_REQUIRED", "MANUAL_RECOVERY_REVIEW_REQUIRED", "WAIT_FOR_REPOSITORY_REVIEW"];
export type GoldenPathEntryReasonCode = (typeof GOLDEN_PATH_ENTRY_REASON_CODES)[number];
export declare const GOLDEN_PATH_ENTRY_RECOVERY_CLASSES: readonly ["ISSUANCE_PARTIAL_PROJECTION", "ISSUANCE_COMPENSATION_UNSAFE", "ABORT_CLEANUP_PENDING", "ABORT_CLEANUP_UNSAFE", "POST_EFFECT_VERIFICATION"];
export type GoldenPathEntryRecoveryClass = (typeof GOLDEN_PATH_ENTRY_RECOVERY_CLASSES)[number];
export declare const GOLDEN_PATH_ENTRY_RECOVERY_ACTIONS: readonly ["RETRY", "ABORT", "RECOVER", "MANUAL_REVIEW"];
export type GoldenPathEntryRecoveryAction = (typeof GOLDEN_PATH_ENTRY_RECOVERY_ACTIONS)[number];
export declare const GOLDEN_PATH_ENTRY_CLEANUP_MODES: readonly ["none", "conditional", "forbidden"];
export type GoldenPathEntryCleanupMode = (typeof GOLDEN_PATH_ENTRY_CLEANUP_MODES)[number];
export type GoldenPathEntryDiagnosticCode = "GOLDEN_PATH_INPUT_INVALID" | "GOLDEN_PATH_REPOSITORY_MISMATCH" | "GOLDEN_PATH_PREFLIGHT_BLOCKED" | "GOLDEN_PATH_GOVERNANCE_INVALID" | "GOLDEN_PATH_GOVERNED_ISSUE_REQUIRED" | "GOLDEN_PATH_SEMANTIC_INTENT_INVALID" | "GOLDEN_PATH_CHANGE_INVALID" | "GOLDEN_PATH_CHANGE_UNAVAILABLE" | "GOLDEN_PATH_CHANGE_NOT_ADMISSIBLE" | "GOLDEN_PATH_EXECUTION_INVALID";
export interface GoldenPathEntryDiagnostic {
    readonly version: GoldenPathEntryContractVersion;
    readonly code: GoldenPathEntryDiagnosticCode;
    readonly path: string;
    readonly message: string;
}
export type GoldenPathEntryUnderlyingDiagnostic = GoldenPathEntryDiagnostic | ChangeDiagnostic;
/** A bounded repository identity reused from the Change contract. */
export type GoldenPathEntrySubject = ChangeIdentity;
/**
 * Optional read-only package/governance preflight supplied by an adapter.
 * The entry projector never treats a failed preflight as absence and never
 * turns a preflight result into mutation authorization by itself.
 */
export interface GoldenPathEntryPreflightEvidence {
    readonly status: "ready" | "blocked";
    readonly diagnostics?: readonly GoldenPathEntryUnderlyingDiagnostic[];
    readonly generation?: ArtifactContractProvenance;
}
/** A semantic input plus the already repository-resolved Effective Contract. */
export interface GoldenPathEntrySemanticIntent {
    readonly effectiveContract: EffectiveArtifactContract;
    readonly input: unknown;
    /** Optional artifact when materialization was already performed by a caller. */
    readonly artifact?: SemanticArtifact;
}
/**
 * Input to the pure composition. `projection` may be the raw normalized
 * Change evidence input (which this module projects) or an already validated
 * Change projection returned by a trusted read/executor.
 */
export interface GoldenPathEntryProjectionInput {
    readonly projection: ChangeProjectionInput | ChangeProjectionResult;
    /** Optional explicit repository/root-Issue identity checked against the projection. */
    readonly repository?: ChangeIdentity;
    /** Explicit governed root-Issue proof; the embedded Change input is also accepted. */
    readonly governedIssue?: ChangeReadyArtifactEvidence;
    /** Optional semantic intent proof from the Repository Canon boundary. */
    readonly semanticIntent?: GoldenPathEntrySemanticIntent;
    readonly preflight?: GoldenPathEntryPreflightEvidence;
    /** Set false only after a trusted Change executor has admitted the operation. */
    readonly requireGovernedIssue?: boolean;
    readonly executionOutcome?: ChangeRemoteExecutionOutcome;
    /** Existing bounded recovery classification, when a Change executor supplies one. */
    readonly recovery?: GoldenPathEntryRecovery;
}
export interface GoldenPathEntryAction {
    readonly operation: "change.issue";
    readonly issue: number;
    readonly mode: "create" | "return-existing";
}
export interface GoldenPathEntryStatus {
    readonly phase: GoldenPathEntryPhase;
    readonly availability: GoldenPathEntryAvailability;
    readonly changeState?: ChangeState;
    readonly projectionStatus?: ChangeProjectionStatus;
    readonly executionOutcome?: ChangeRemoteExecutionOutcome;
}
export interface GoldenPathEntryNextAction {
    readonly kind: GoldenPathEntryActionKind;
    readonly owner: "caller" | "inari" | "worker" | "repository" | "recovery";
    readonly reasonCode: GoldenPathEntryReasonCode;
    /** Present only for a RETRY action and names the semantic operation retried. */
    readonly retryOf?: string;
}
export interface GoldenPathEntryRecovery {
    readonly class: GoldenPathEntryRecoveryClass;
    readonly safeAction: GoldenPathEntryRecoveryAction;
    readonly retryable: boolean;
    readonly rereadRequired: true;
    readonly automaticCleanup: GoldenPathEntryCleanupMode;
    /** Semantic operation to name when `safeAction` is RETRY. */
    readonly retryOf?: string;
}
/** Bounded governance identity; full contracts remain owned by Core. */
export interface GoldenPathEntryGovernanceProjection {
    readonly kind: "issue";
    readonly id: string;
    readonly version: string;
    readonly generation?: ArtifactContractProvenance;
}
export interface GoldenPathEntryResult {
    readonly version: GoldenPathEntryContractVersion;
    readonly valid: boolean;
    readonly subject?: GoldenPathEntrySubject;
    readonly governance?: GoldenPathEntryGovernanceProjection;
    readonly status: GoldenPathEntryStatus;
    /** The exact existing Change operation and idempotent mode. */
    readonly action?: GoldenPathEntryAction;
    readonly nextAction: GoldenPathEntryNextAction | null;
    readonly recovery: GoldenPathEntryRecovery | null;
    readonly change?: Change;
    readonly projection?: ChangeProjectionResult;
    readonly diagnostics: readonly GoldenPathEntryUnderlyingDiagnostic[];
}
export interface GoldenPathEntryProjectionValidationResult {
    readonly valid: boolean;
    readonly result?: GoldenPathEntryResult;
    readonly diagnostics: readonly GoldenPathEntryUnderlyingDiagnostic[];
}
export declare class GoldenPathEntryProjectionError extends Error {
    readonly diagnostics: readonly GoldenPathEntryUnderlyingDiagnostic[];
    constructor(diagnostics: readonly GoldenPathEntryUnderlyingDiagnostic[]);
}
/**
 * Project a Golden Path entry without any provider effects. The result is
 * deterministic and bounded; invalid/blocked evidence is represented in the
 * result rather than guessed into an issuance action.
 */
export declare function tryProjectGoldenPathEntry(input: unknown): GoldenPathEntryResult;
/** Throwing Core entry point following the existing projection conventions. */
export declare function projectGoldenPathEntry(input: unknown): GoldenPathEntryResult;
export declare const projectGoldenPathEntryResult: typeof tryProjectGoldenPathEntry;
export declare const planGoldenPathEntry: typeof projectGoldenPathEntry;
/** Validate a previously projected result at an adapter/package boundary. */
export declare function validateGoldenPathEntryResult(input: unknown): GoldenPathEntryProjectionValidationResult;
export declare function serializeGoldenPathEntryResult(input: unknown): string;
/**
 * Execute the already-admitted `change issue` operation through the existing
 * semantic executor. The executor remains responsible for fresh governance,
 * lifecycle, effects, reread, and postcondition verification.
 */
export interface GoldenPathEntryExecutionInput extends Omit<GoldenPathEntryProjectionInput, "projection"> {
    /** Optional when the executor read port can establish the current projection. */
    readonly projection?: ChangeProjectionInput | ChangeProjectionResult;
    /** Root Issue used for the read port when `projection` is omitted. */
    readonly issue?: number;
    readonly executor: ChangeRemoteExecutor;
    readonly requester?: string;
}
export declare function executeGoldenPathEntry(input: GoldenPathEntryExecutionInput): Promise<GoldenPathEntryResult>;
/** Compatibility spelling for consumers that name this boundary by composition. */
export declare const composeGoldenPathEntry: typeof executeGoldenPathEntry;
