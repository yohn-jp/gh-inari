import { type CanonicalContract, type CanonicalField } from "./ir.js";
import { type ArtifactDiagnosticReport, type ArtifactDiagnosticReason } from "../diagnostics.js";
/** Stable machine-readable semantic input diagnostics. */
export type SemanticViolationCode = "INPUT_NOT_OBJECT" | "INPUT_UNKNOWN_FIELD" | "INPUT_REQUIRED" | "INPUT_TYPE" | "INPUT_ENUM" | "INPUT_OPTION" | "INPUT_DUPLICATE" | "INPUT_MIN_LENGTH" | "INPUT_MAX_LENGTH" | "INPUT_PATTERN" | "INPUT_MIN_ITEMS" | "INPUT_MAX_ITEMS" | "INPUT_CHECKLIST_REQUIRED" | "INPUT_CHECKLIST_INCOMPLETE" | "INPUT_UNSAFE_CONTENT" | "INPUT_DEPENDENCY";
export interface SemanticViolation {
    readonly code: SemanticViolationCode;
    readonly path: string;
    readonly message: string;
}
export interface SemanticValidationResult {
    readonly valid: boolean;
    readonly violations: readonly SemanticViolation[];
    /** Defaults are materialized here only after all input values are validated. */
    readonly values: Readonly<Record<string, unknown>>;
}
/** Compact identity retained by a partial result for a later repair merge. */
export interface PartialArtifactIdentity {
    readonly artifactKind: CanonicalContract["artifactKind"];
    readonly irVersion: CanonicalContract["irVersion"];
    readonly schemaVersion: CanonicalContract["schemaVersion"];
    readonly templateIdentity: CanonicalContract["templateIdentity"];
}
/** Field-local constraints projected without defaults or the complete schema. */
export interface PartialFieldConstraintProjection {
    readonly field: string;
    readonly path: string;
    readonly type: CanonicalField["type"];
    readonly required: boolean;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: string;
    readonly linkedIssue?: true;
    readonly minItems?: number;
    readonly maxItems?: number;
    readonly uniqueItems?: boolean;
    readonly allowedValues?: readonly string[];
    readonly requiredItems?: readonly string[];
    readonly checklistRequireComplete?: true;
}
export interface PartialFieldIssue {
    readonly field: string;
    readonly path: string;
    readonly reason: ArtifactDiagnosticReason;
    readonly message: string;
    /** Only unresolved fields carry projected constraints. */
    readonly constraints?: PartialFieldConstraintProjection;
}
/**
 * Stateless classification of a supplied field map. `values` contains only
 * supplied values that passed validation; defaults are deliberately excluded.
 */
export interface PartialSemanticValidationResult {
    readonly valid: boolean;
    /** True only when every declared field was supplied and accepted. */
    readonly complete: boolean;
    readonly artifactKind: CanonicalContract["artifactKind"];
    readonly templateIdentity: CanonicalContract["templateIdentity"];
    readonly identity: PartialArtifactIdentity;
    readonly acceptedFields: readonly string[];
    readonly missingFields: readonly PartialFieldIssue[];
    readonly invalidFields: readonly PartialFieldIssue[];
    readonly values: Readonly<Record<string, unknown>>;
    /** Projections are present only for fields in missingFields/invalidFields. */
    readonly projectedConstraints: readonly PartialFieldConstraintProjection[];
    readonly diagnostics: ArtifactDiagnosticReport;
}
/**
 * The immutable state a caller carries between partial repair attempts.
 *
 * This deliberately contains accepted semantic values only.  Missing and
 * invalid values are not carried forward, so a repair cannot accidentally
 * turn an earlier diagnostic into candidate state.
 */
export interface PartialSemanticRepairContext {
    readonly identity: PartialArtifactIdentity;
    readonly acceptedFields: readonly string[];
    readonly values: Readonly<Record<string, unknown>>;
}
/** Result of merging one bounded repair patch into an accepted candidate. */
export interface PartialSemanticRepairResult {
    /** True only when the patch and the complete merged candidate are valid. */
    readonly valid: boolean;
    /** True when the merged candidate can be rendered by the canonical path. */
    readonly complete: boolean;
    readonly artifactKind: CanonicalContract["artifactKind"];
    readonly templateIdentity: CanonicalContract["templateIdentity"];
    readonly identity: PartialArtifactIdentity;
    /** Accepted values after this attempt; invalid patch values are excluded. */
    readonly values: Readonly<Record<string, unknown>>;
    /** Values after canonical defaults are materialized, when complete is true. */
    readonly canonicalValues: Readonly<Record<string, unknown>>;
    readonly acceptedFields: readonly string[];
    readonly changedFields: readonly string[];
    /** True when no patch value changed accepted semantic state. */
    readonly noOp: boolean;
    readonly context: PartialSemanticRepairContext;
    readonly missingFields: readonly PartialFieldIssue[];
    readonly invalidFields: readonly PartialFieldIssue[];
    readonly projectedConstraints: readonly PartialFieldConstraintProjection[];
    readonly diagnostics: ArtifactDiagnosticReport;
    /** The reclassified candidate, useful for the next stateless attempt. */
    readonly partial: PartialSemanticValidationResult;
}
export declare class SemanticValidationError extends Error {
    readonly violations: readonly SemanticViolation[];
    readonly diagnostics?: ArtifactDiagnosticReport;
    readonly details?: Readonly<Record<string, unknown>>;
    constructor(violations: readonly SemanticViolation[], diagnostics?: ArtifactDiagnosticReport, details?: Readonly<Record<string, unknown>>);
}
/**
 * Validate the semantic field map for a compiled contract. This is the one
 * validator used by preview, mutation preparation, and existing-artifact
 * reconstruction.
 */
export declare function validateSemanticInput(contractInput: unknown, input: unknown): SemanticValidationResult;
/**
 * Classify a partial semantic field map without applying contract defaults.
 * This is intentionally stateless: the returned identity and accepted values
 * are sufficient for a caller to merge a later repair patch locally.
 */
export declare function validatePartialSemanticInput(contractInput: unknown, input: unknown): PartialSemanticValidationResult;
/**
 * Merge a targeted repair into a prior partial result without retaining any
 * process-local state.  `previous` may be a partial validation result or the
 * compact `PartialSemanticRepairContext` returned by an earlier attempt.
 * `patch` may be a bare field map or an envelope containing `fields`/`patch`
 * and an optional identity which is checked against the prior context.
 *
 * A patch is validated before it is merged.  An invalid replacement therefore
 * cannot erase a previously accepted value, while its bounded diagnostic is
 * still returned to the caller for the next retry.
 */
export declare function repairPartialSemanticInput(contractInput: unknown, previous: unknown, patch?: unknown): PartialSemanticRepairResult;
/** Terminology alias for callers that describe the operation as a merge. */
export declare const mergePartialSemanticInput: typeof repairPartialSemanticInput;
/** Build a transport-safe context from a partial validation result. */
export declare function createPartialSemanticRepairContext(result: PartialSemanticValidationResult): PartialSemanticRepairContext;
/** Compact, canonical JSON projection for transport between repair attempts. */
export declare function serializePartialSemanticValidationResult(result: PartialSemanticValidationResult): string;
/** Terminology aliases for callers that treat validation as classification. */
export declare const classifyPartialSemanticInput: typeof validatePartialSemanticInput;
export declare function assertSemanticInput(contractInput: unknown, input: unknown): Readonly<Record<string, unknown>>;
