/** Stable machine-readable semantic input diagnostics. */
export type SemanticViolationCode = "INPUT_NOT_OBJECT" | "INPUT_UNKNOWN_FIELD" | "INPUT_REQUIRED" | "INPUT_TYPE" | "INPUT_ENUM" | "INPUT_OPTION" | "INPUT_DUPLICATE" | "INPUT_MIN_LENGTH" | "INPUT_MAX_LENGTH" | "INPUT_PATTERN" | "INPUT_MIN_ITEMS" | "INPUT_MAX_ITEMS" | "INPUT_CHECKLIST_REQUIRED" | "INPUT_CHECKLIST_INCOMPLETE";
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
export declare class SemanticValidationError extends Error {
    readonly violations: readonly SemanticViolation[];
    constructor(violations: readonly SemanticViolation[]);
}
/**
 * Validate the semantic field map for a compiled contract. This is the one
 * validator used by preview, mutation preparation, and existing-artifact
 * reconstruction.
 */
export declare function validateSemanticInput(contractInput: unknown, input: unknown): SemanticValidationResult;
export declare function assertSemanticInput(contractInput: unknown, input: unknown): Readonly<Record<string, unknown>>;
