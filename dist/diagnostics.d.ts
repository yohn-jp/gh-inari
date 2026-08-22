/**
 * Versioned, bounded diagnostics shared by artifact convergence operations.
 *
 * This module is a data contract only. Command adapters may project their
 * local failures into it, but the contract deliberately does not own command
 * behavior or template semantics.
 */
export declare const ARTIFACT_DIAGNOSTIC_VERSION: 1;
export type ArtifactDiagnosticVersion = typeof ARTIFACT_DIAGNOSTIC_VERSION;
export type ArtifactDiagnosticState = "accepted" | "missing" | "invalid" | "conflicting" | "unsupported" | "unrecoverable";
/** Stable reason discriminants shared by all convergence command adapters. */
export type ArtifactDiagnosticCode = "FIELD_ACCEPTED" | "FIELD_MISSING" | "FIELD_INVALID" | "FIELD_CONFLICT" | "FIELD_UNSUPPORTED" | "ARTIFACT_UNRECOVERABLE";
export type ArtifactDiagnosticRecoveryAction = "provide" | "replace" | "resolve-conflict" | "select-template" | "repair" | "retry";
export interface ArtifactDiagnosticRecovery {
    readonly action: ArtifactDiagnosticRecoveryAction;
    /** Field identity or JSON path, when the action is field-local. */
    readonly path?: string;
    /** Bounded human-readable projection of the deterministic next step. */
    readonly hint?: string;
}
export interface ArtifactDiagnosticInput {
    readonly state: ArtifactDiagnosticState;
    readonly code: ArtifactDiagnosticCode;
    /** Field identity or JSON path. Keep this field-local where possible. */
    readonly path?: string;
    /** Human-readable projection; state and code remain authoritative. */
    readonly message: string;
    readonly expected?: unknown;
    readonly actual?: unknown;
    readonly recovery?: readonly ArtifactDiagnosticRecoveryInput[];
}
export interface ArtifactDiagnosticRecoveryInput {
    readonly action: ArtifactDiagnosticRecoveryAction;
    readonly path?: string;
    readonly hint?: string;
}
export interface ArtifactDiagnostic {
    readonly version: ArtifactDiagnosticVersion;
    readonly state: ArtifactDiagnosticState;
    readonly code: ArtifactDiagnosticCode;
    readonly path?: string;
    readonly message: string;
    readonly expected?: BoundedDiagnosticValue;
    readonly actual?: BoundedDiagnosticValue;
    readonly recovery?: readonly ArtifactDiagnosticRecovery[];
}
/**
 * A recursively bounded value suitable for expected/actual evidence.
 * Truncation is explicit so consumers never mistake evidence for a complete
 * artifact or complete field payload.
 */
export type BoundedDiagnosticValue = null | boolean | number | string | readonly BoundedDiagnosticValue[] | {
    readonly [key: string]: BoundedDiagnosticValue;
};
export interface ArtifactDiagnosticReport {
    readonly version: ArtifactDiagnosticVersion;
    readonly diagnostics: readonly ArtifactDiagnostic[];
    /** Explicitly accepted field identities retained for partial convergence. */
    readonly acceptedFields: readonly string[];
}
export declare const MAX_ARTIFACT_DIAGNOSTICS: 32;
export declare const MAX_ACCEPTED_FIELDS: 128;
export declare const MAX_DIAGNOSTIC_MESSAGE_LENGTH: 240;
export declare const MAX_DIAGNOSTIC_PATH_LENGTH: 160;
export declare const MAX_RECOVERY_ACTIONS: 4;
export declare const MAX_RECOVERY_HINT_LENGTH: 240;
export declare const MAX_EVIDENCE_DEPTH: 3;
export declare const MAX_EVIDENCE_ITEMS: 8;
export declare const MAX_EVIDENCE_KEYS: 12;
export declare const MAX_EVIDENCE_STRING_LENGTH: 240;
/**
 * Create one contract-valid diagnostic and sanitize all evidence at the
 * boundary. Sanitization is intentionally lossy: diagnostics must never be a
 * transport for a complete artifact, secret, or unbounded parser payload.
 */
export declare function createArtifactDiagnostic(input: ArtifactDiagnosticInput): ArtifactDiagnostic;
/** Create a stable report, sorting field identities and diagnostics by contract keys. */
export declare function createArtifactDiagnosticReport(diagnostics: readonly ArtifactDiagnostic[], acceptedFields?: readonly string[]): ArtifactDiagnosticReport;
/** Serialize a report with stable key ordering and stable diagnostic ordering. */
export declare function serializeArtifactDiagnosticReport(report: ArtifactDiagnosticReport): string;
/** Project the machine contract into bounded human-readable text. */
export declare function formatArtifactDiagnostic(diagnostic: ArtifactDiagnostic): string;
/** Project all report diagnostics without introducing a command-specific shape. */
export declare function formatArtifactDiagnosticReport(report: ArtifactDiagnosticReport): string;
/** Parse and validate a serialized report at an untrusted boundary. */
export declare function deserializeArtifactDiagnosticReport(serialized: string): ArtifactDiagnosticReport;
