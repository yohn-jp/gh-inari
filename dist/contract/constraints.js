import { LINKED_ISSUE_PATTERN, } from "./ir.js";
/** JSON Schema pattern used to reject required strings containing only whitespace. */
export const REQUIRED_STRING_PATTERN = "\\S";
/**
 * Resolve native and supplemental rules once for every consumer of a
 * compiled contract. Native constraints take precedence; the IR validator
 * rejects contradictory overlays before this model is used.
 */
export function effectiveFieldConstraints(contract, field) {
    const supplemental = supplementalForField(contract, field.id);
    const minItems = field.constraints?.minItems ?? supplemental?.minItems;
    const checklistMinCompleted = field.type === "checklist" ? supplemental?.checklistMinCompleted : undefined;
    const requiredItems = field.type === "checklist" ? field.items.filter((item) => item.required).map((item) => item.id) : [];
    const allowedValues = allowedValuesFor(field);
    return {
        required: field.required === "required" || supplemental?.required === true,
        hasDefault: field.defaultValue !== undefined,
        defaultValue: field.defaultValue,
        ...((field.constraints?.minLength ?? supplemental?.minLength) === undefined
            ? {}
            : { minLength: field.constraints?.minLength ?? supplemental?.minLength }),
        ...((field.constraints?.maxLength ?? supplemental?.maxLength) === undefined
            ? {}
            : { maxLength: field.constraints?.maxLength ?? supplemental?.maxLength }),
        ...((field.constraints?.pattern ?? supplemental?.pattern) === undefined
            ? {}
            : { pattern: field.constraints?.pattern ?? supplemental?.pattern }),
        linkedIssue: supplemental?.linkedIssue === true,
        ...(minItems === undefined && checklistMinCompleted === undefined
            ? {}
            : { minItems: Math.max(minItems ?? 0, checklistMinCompleted ?? 0) }),
        ...((field.constraints?.maxItems ?? supplemental?.maxItems) === undefined
            ? {}
            : { maxItems: field.constraints?.maxItems ?? supplemental?.maxItems }),
        uniqueItems: field.constraints?.uniqueItems ?? true,
        ...(allowedValues === undefined ? {} : { allowedValues }),
        requiredItems,
        checklistRequireComplete: supplemental?.checklistRequireComplete === true,
        ...(field.type === "checklist" ? { checklistItemCount: field.items.length } : {}),
    };
}
/** Minimum array cardinality expressed by the public JSON Schema. */
export function schemaMinItems(constraints) {
    const minimum = Math.max(constraints.minItems ?? 0, constraints.required ? 1 : 0, constraints.checklistRequireComplete ? (constraints.checklistItemCount ?? 0) : 0);
    return minimum > 0 ? minimum : undefined;
}
/** Patterns that must all match a string field in the public schema. */
export function schemaStringPatterns(constraints) {
    return [
        ...(constraints.required ? [REQUIRED_STRING_PATTERN] : []),
        ...(constraints.pattern === undefined ? [] : [constraints.pattern]),
        ...(constraints.linkedIssue ? [LINKED_ISSUE_PATTERN] : []),
    ];
}
/** Preserve the compact one-pattern schema shape while composing all rules. */
export function schemaStringPatternProjection(constraints) {
    const requiredPatterns = constraints.required ? [{ pattern: REQUIRED_STRING_PATTERN }] : [];
    const semanticPatterns = [
        ...(constraints.pattern === undefined ? [] : [constraints.pattern]),
        ...(constraints.linkedIssue ? [LINKED_ISSUE_PATTERN] : []),
    ];
    if (requiredPatterns.length === 0) {
        if (semanticPatterns.length === 0)
            return {};
        if (semanticPatterns.length === 1)
            return { pattern: semanticPatterns[0] };
        return { allOf: semanticPatterns.map((pattern) => ({ pattern })) };
    }
    if (semanticPatterns.length === 0)
        return { pattern: REQUIRED_STRING_PATTERN };
    if (semanticPatterns.length === 1)
        return { pattern: semanticPatterns[0], allOf: requiredPatterns };
    return { allOf: [...semanticPatterns.map((pattern) => ({ pattern })), ...requiredPatterns] };
}
function supplementalForField(contract, fieldId) {
    return contract.supplementalConstraints.fields.find((constraint) => constraint.fieldId === fieldId);
}
function allowedValuesFor(field) {
    if (field.type === "enum")
        return field.options.map((option) => option.value);
    if (field.type === "array")
        return field.items.options?.map((option) => option.value);
    if (field.type === "checklist")
        return field.items.map((item) => item.id);
    return undefined;
}
//# sourceMappingURL=constraints.js.map