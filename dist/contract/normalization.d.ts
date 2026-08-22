/**
 * Field-aware canonical value normalization.
 *
 * This is the one representation-independent cleanup boundary applied to
 * every candidate value before semantic validation, regardless of whether
 * the candidate arrived as JSON, native Markdown, an existing GitHub
 * artifact, or direct field input. It performs only bounded,
 * representation-preserving transformations explicitly allowed by the
 * canonical contract rules; anything it cannot normalize safely is rejected
 * rather than rewritten, so callers never see silently mutated meaning.
 *
 * This module deliberately exposes typed, field-aware primitives instead of
 * one generic string sanitizer: normalization rules are a function of the
 * declared CanonicalField type, not free-form string repair.
 */
import { type CanonicalField } from "./ir.js";
/** Hard ceiling on raw string length considered for normalization, independent of any field-declared maxLength. */
export declare const MAX_NORMALIZABLE_STRING_LENGTH: 65536;
export type FieldNormalizationCode = "INPUT_MAX_LENGTH" | "INPUT_UNSAFE_CONTENT";
export interface FieldNormalizationViolation {
    readonly code: FieldNormalizationCode;
    readonly message: string;
}
export type FieldNormalizationResult = {
    readonly ok: true;
    readonly value: unknown;
} | {
    readonly ok: false;
    readonly violation: FieldNormalizationViolation;
};
export declare function normalizeFieldValue(field: CanonicalField, value: unknown): FieldNormalizationResult;
