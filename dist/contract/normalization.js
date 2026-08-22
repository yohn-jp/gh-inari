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
/** Hard ceiling on raw string length considered for normalization, independent of any field-declared maxLength. */
export const MAX_NORMALIZABLE_STRING_LENGTH = 65_536;
/** Leading byte-order mark (U+FEFF), stripped as a representation artifact rather than semantic content. */
const LEADING_BOM_PATTERN = new RegExp("^\\uFEFF", "u");
/** CRLF/CR converted to a single canonical LF newline policy before any other check runs. */
const NEWLINE_PATTERN = /\r\n?/gu;
/**
 * C0/C1 control characters other than the two allowed whitespace controls,
 * tab (U+0009) and line feed (U+000A) -- the latter already the sole
 * newline form once the newline policy above has run.
 */
const CONTROL_CHARACTER_PATTERN = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u0080-\\u009F]", "u");
export function normalizeFieldValue(field, value) {
    if (typeof value === "string")
        return normalizeStringValue(value);
    if (Array.isArray(value) && (field.type === "array" || field.type === "checklist")) {
        return normalizeStringArrayValue(value);
    }
    return { ok: true, value };
}
/**
 * Canonicalize one string value: strip a leading byte-order mark, apply a
 * single newline policy, reject unsafe control content, and fold Unicode to
 * NFC with bounded surrounding whitespace trimmed. Every step is
 * representation-preserving; none guesses at repairing unsafe input.
 */
function normalizeStringValue(value) {
    if (value.length > MAX_NORMALIZABLE_STRING_LENGTH) {
        return {
            ok: false,
            violation: { code: "INPUT_MAX_LENGTH", message: "Field value exceeds the maximum normalizable length." },
        };
    }
    const withoutBom = value.replace(LEADING_BOM_PATTERN, "");
    const withNewlinePolicy = withoutBom.replace(NEWLINE_PATTERN, "\n");
    if (CONTROL_CHARACTER_PATTERN.test(withNewlinePolicy)) {
        return {
            ok: false,
            violation: { code: "INPUT_UNSAFE_CONTENT", message: "Field value contains unsupported control characters." },
        };
    }
    return { ok: true, value: withNewlinePolicy.normalize("NFC").trim() };
}
function normalizeStringArrayValue(value) {
    const normalized = [];
    for (const entry of value) {
        if (typeof entry !== "string") {
            normalized.push(entry);
            continue;
        }
        const result = normalizeStringValue(entry);
        if (!result.ok)
            return result;
        normalized.push(result.value);
    }
    return { ok: true, value: normalized };
}
//# sourceMappingURL=normalization.js.map