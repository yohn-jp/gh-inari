/**
 * The transport-independent semantic contract for a governed Change.
 *
 * This module intentionally owns only Change data, validation, and
 * canonical serialization.  It does not read or mutate GitHub state, derive
 * branch names, or plan transitions.
 */
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
export type ChangeDiagnosticCode = "CHANGE_INVALID_JSON" | "CHANGE_INVALID_ROOT" | "CHANGE_MISSING_PROPERTY" | "CHANGE_UNKNOWN_PROPERTY" | "CHANGE_UNSUPPORTED_VERSION" | "CHANGE_INVALID_IDENTITY" | "CHANGE_INVALID_STATE" | "CHANGE_INVALID_PROVENANCE" | "CHANGE_INVALID_PROJECTION";
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
