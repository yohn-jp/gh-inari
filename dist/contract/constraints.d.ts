import { type CanonicalContract, type CanonicalField, type FieldConstraints } from "./ir.js";
/** JSON Schema pattern used to reject required strings containing only whitespace. */
export declare const REQUIRED_STRING_PATTERN: "\\S";
export interface EffectiveFieldConstraints {
    readonly required: boolean;
    readonly hasDefault: boolean;
    readonly defaultValue: unknown;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: string;
    readonly linkedIssue: boolean;
    readonly minItems?: number;
    readonly maxItems?: number;
    readonly uniqueItems: boolean;
    readonly allowedValues?: readonly string[];
    readonly requiredItems: readonly string[];
    readonly checklistRequireComplete: boolean;
    readonly checklistItemCount?: number;
}
/**
 * Resolve native and supplemental rules once for every consumer of a
 * compiled contract. Native constraints take precedence; the IR validator
 * rejects contradictory overlays before this model is used.
 */
export declare function effectiveFieldConstraints(contract: CanonicalContract, field: CanonicalField): EffectiveFieldConstraints;
/** Minimum array cardinality expressed by the public JSON Schema. */
export declare function schemaMinItems(constraints: EffectiveFieldConstraints): number | undefined;
/** Patterns that must all match a string field in the public schema. */
export declare function schemaStringPatterns(constraints: EffectiveFieldConstraints): readonly string[];
/** Preserve the compact one-pattern schema shape while composing all rules. */
export declare function schemaStringPatternProjection(constraints: EffectiveFieldConstraints): {
    readonly pattern?: string;
    readonly allOf?: readonly {
        readonly pattern: string;
    }[];
};
export type { FieldConstraints };
