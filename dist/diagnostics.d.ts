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
/** Stable state-level machine code. */
export type ArtifactDiagnosticCode = "FIELD_ACCEPTED" | "FIELD_MISSING" | "FIELD_INVALID" | "FIELD_CONFLICT" | "FIELD_UNSUPPORTED" | "ARTIFACT_UNRECOVERABLE";
/** Stable machine reason, more precise than the state-level code. */
export type ArtifactDiagnosticReason = "accepted" | "required" | "type" | "constraint" | "conflict" | "unsupported" | "unrecoverable";
/** Stable detail code for field-level and template-level projections. */
export type ArtifactDiagnosticDetailCode = ArtifactDiagnosticCode | "FIELD_REQUIRED" | "FIELD_TYPE_MISMATCH" | "FIELD_CONSTRAINT_VIOLATION" | "FIELD_VALUE_CONFLICT" | "TEMPLATE_AMBIGUOUS" | "TEMPLATE_UNPARSEABLE";
export type ArtifactDiagnosticRecoveryAction = "provide" | "replace" | "resolve-conflict" | "select-template" | "repair" | "retry";
export interface ArtifactDiagnosticRecovery {
    readonly action: ArtifactDiagnosticRecoveryAction;
    /** Field identity or JSON path, when the action is field-local. */
    readonly path?: string;
    /** Bounded human-readable projection of the deterministic next step. */
    readonly hint?: string;
}
export interface ArtifactDiagnosticRecoveryInput {
    readonly action: ArtifactDiagnosticRecoveryAction;
    readonly path?: string;
    readonly hint?: string;
}
export type ArtifactEvidenceType = "string" | "number" | "boolean" | "null" | "undefined" | "array" | "object";
interface FieldEvidenceBase {
    /** Field identity or JSON path; raw artifact locations are rejected. */
    readonly field: string;
    readonly type: ArtifactEvidenceType;
}
export interface StringFieldEvidence extends FieldEvidenceBase {
    readonly type: "string";
    readonly length: number;
    readonly truncated: boolean;
}
export interface NumberFieldEvidence extends FieldEvidenceBase {
    readonly type: "number";
    readonly value: number;
}
export interface BooleanFieldEvidence extends FieldEvidenceBase {
    readonly type: "boolean";
    readonly value: boolean;
}
export interface NullFieldEvidence extends FieldEvidenceBase {
    readonly type: "null";
}
export interface UndefinedFieldEvidence extends FieldEvidenceBase {
    readonly type: "undefined";
}
export interface ArrayFieldEvidence extends FieldEvidenceBase {
    readonly type: "array";
    readonly itemCount: number;
    readonly itemTypes: readonly ArtifactEvidenceType[];
    readonly truncated: boolean;
}
export interface ObjectFieldEvidence extends FieldEvidenceBase {
    readonly type: "object";
    readonly keyCount: number;
    readonly truncated: boolean;
}
/**
 * Field-local, typed evidence. It intentionally has no arbitrary string or
 * object value member: even a short direct string can be a credential.
 */
export type ArtifactDiagnosticEvidence = StringFieldEvidence | NumberFieldEvidence | BooleanFieldEvidence | NullFieldEvidence | UndefinedFieldEvidence | ArrayFieldEvidence | ObjectFieldEvidence;
/** Backward-compatible name for the bounded evidence contract. */
export type BoundedDiagnosticValue = ArtifactDiagnosticEvidence;
export interface ArtifactDiagnosticInput {
    readonly state: ArtifactDiagnosticState;
    readonly code: ArtifactDiagnosticCode;
    /** Optional; defaults to the reason implied by code/detailCode. */
    readonly reason?: ArtifactDiagnosticReason;
    /** Optional; defaults to code. */
    readonly detailCode?: ArtifactDiagnosticDetailCode;
    /** Field identity or JSON path. Keep this field-local where possible. */
    readonly path?: string;
    /** Human-readable projection; state/code/reason remain authoritative. */
    readonly message: string;
    /** Use createFieldEvidence; raw values are rejected at this boundary. */
    readonly expected?: ArtifactDiagnosticEvidence;
    readonly actual?: ArtifactDiagnosticEvidence;
    readonly recovery?: readonly ArtifactDiagnosticRecoveryInput[];
}
export interface ArtifactDiagnostic {
    readonly version: ArtifactDiagnosticVersion;
    readonly state: ArtifactDiagnosticState;
    readonly code: ArtifactDiagnosticCode;
    readonly reason: ArtifactDiagnosticReason;
    readonly detailCode: ArtifactDiagnosticDetailCode;
    readonly path?: string;
    readonly message: string;
    readonly expected?: ArtifactDiagnosticEvidence;
    readonly actual?: ArtifactDiagnosticEvidence;
    readonly recovery?: readonly ArtifactDiagnosticRecovery[];
}
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
export declare const MAX_EVIDENCE_LENGTH: 240;
export declare const MAX_EVIDENCE_ITEMS: 8;
export declare const MAX_EVIDENCE_COLLECTION_LENGTH: 128;
/**
 * Convert an untrusted semantic value to field-local type/size evidence. No
 * caller value is retained, including short strings and nested object keys.
 */
export declare function createFieldEvidence(field: string, value: unknown): ArtifactDiagnosticEvidence;
/** Create one contract-valid diagnostic and validate all evidence at the boundary. */
export declare function createArtifactDiagnostic(input: ArtifactDiagnosticInput): ArtifactDiagnostic;
/** Create a stable report, sorting all set-like members by contract keys. */
export declare function createArtifactDiagnosticReport(diagnostics: readonly ArtifactDiagnostic[], acceptedFields?: readonly string[]): ArtifactDiagnosticReport;
/** Serialize a report with canonical ordering of diagnostics/evidence/actions. */
export declare function serializeArtifactDiagnosticReport(report: ArtifactDiagnosticReport): string;
/** Project the machine contract into bounded human-readable text. */
export declare function formatArtifactDiagnostic(diagnostic: ArtifactDiagnostic): string;
/** Project all report diagnostics without introducing a command-specific shape. */
export declare function formatArtifactDiagnosticReport(report: ArtifactDiagnosticReport): string;
/** Parse and validate a serialized report at an untrusted boundary. */
export declare function deserializeArtifactDiagnosticReport(serialized: string): ArtifactDiagnosticReport;
export {};
