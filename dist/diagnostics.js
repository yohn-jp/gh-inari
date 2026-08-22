/**
 * Versioned, bounded diagnostics shared by artifact convergence operations.
 *
 * This module is a data contract only. Command adapters may project their
 * local failures into it, but the contract deliberately does not own command
 * behavior or template semantics.
 */
export const ARTIFACT_DIAGNOSTIC_VERSION = 1;
export const MAX_ARTIFACT_DIAGNOSTICS = 32;
export const MAX_ACCEPTED_FIELDS = 128;
export const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 240;
export const MAX_DIAGNOSTIC_PATH_LENGTH = 160;
export const MAX_RECOVERY_ACTIONS = 4;
export const MAX_RECOVERY_HINT_LENGTH = 240;
export const MAX_EVIDENCE_LENGTH = 240;
export const MAX_EVIDENCE_ITEMS = 8;
export const MAX_EVIDENCE_COLLECTION_LENGTH = 128;
const REPORT_KEYS = new Set(["version", "diagnostics", "acceptedFields"]);
const DIAGNOSTIC_KEYS = new Set([
    "version",
    "state",
    "code",
    "reason",
    "detailCode",
    "path",
    "message",
    "expected",
    "actual",
    "recovery",
]);
const RECOVERY_KEYS = new Set(["action", "path", "hint"]);
const FIELD_EVIDENCE_KEYS = new Set([
    "field",
    "type",
    "length",
    "truncated",
    "value",
    "itemCount",
    "itemTypes",
    "keyCount",
]);
const RECOVERY_ACTIONS = [
    "provide",
    "replace",
    "resolve-conflict",
    "select-template",
    "repair",
    "retry",
];
const EVIDENCE_TYPES = [
    "string",
    "number",
    "boolean",
    "null",
    "undefined",
    "array",
    "object",
];
const PROHIBITED_FIELD_SEGMENT = /^(?:rawbody|renderedbody|fullartifact|artifact|body|payload|document|accesstoken|privatekey|sessionsecret|authorization|cookie|credential|password|secret|token)$/i;
const DETAIL_DEFINITIONS = {
    FIELD_ACCEPTED: { state: "accepted", reason: "accepted", code: "FIELD_ACCEPTED" },
    FIELD_MISSING: { state: "missing", reason: "required", code: "FIELD_MISSING" },
    FIELD_REQUIRED: { state: "missing", reason: "required", code: "FIELD_MISSING" },
    FIELD_INVALID: { state: "invalid", reason: "constraint", code: "FIELD_INVALID" },
    FIELD_TYPE_MISMATCH: { state: "invalid", reason: "type", code: "FIELD_INVALID" },
    FIELD_CONSTRAINT_VIOLATION: { state: "invalid", reason: "constraint", code: "FIELD_INVALID" },
    FIELD_CONFLICT: { state: "conflicting", reason: "conflict", code: "FIELD_CONFLICT" },
    FIELD_VALUE_CONFLICT: { state: "conflicting", reason: "conflict", code: "FIELD_CONFLICT" },
    FIELD_UNSUPPORTED: { state: "unsupported", reason: "unsupported", code: "FIELD_UNSUPPORTED" },
    TEMPLATE_AMBIGUOUS: { state: "conflicting", reason: "conflict", code: "FIELD_CONFLICT" },
    TEMPLATE_UNPARSEABLE: { state: "unsupported", reason: "unsupported", code: "FIELD_UNSUPPORTED" },
    ARTIFACT_UNRECOVERABLE: { state: "unrecoverable", reason: "unrecoverable", code: "ARTIFACT_UNRECOVERABLE" },
};
/**
 * Convert an untrusted semantic value to field-local type/size evidence. No
 * caller value is retained, including short strings and nested object keys.
 */
export function createFieldEvidence(field, value) {
    const normalizedField = assertFieldPath(field);
    if (value === null)
        return { field: normalizedField, type: "null" };
    if (value === undefined)
        return { field: normalizedField, type: "undefined" };
    if (typeof value === "string") {
        return {
            field: normalizedField,
            type: "string",
            length: Math.min(value.length, MAX_EVIDENCE_LENGTH),
            truncated: value.length > MAX_EVIDENCE_LENGTH,
        };
    }
    if (typeof value === "boolean")
        return { field: normalizedField, type: "boolean", value };
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new TypeError("Non-finite numbers are not valid diagnostic evidence.");
        return { field: normalizedField, type: "number", value };
    }
    if (Array.isArray(value)) {
        const itemTypes = [...new Set(value.map((entry) => valueType(entry)))].sort(compareText);
        return {
            field: normalizedField,
            type: "array",
            itemCount: Math.min(value.length, MAX_EVIDENCE_COLLECTION_LENGTH),
            itemTypes,
            truncated: value.length > MAX_EVIDENCE_COLLECTION_LENGTH,
        };
    }
    if (typeof value === "object") {
        const keyCount = Object.keys(value).length;
        return {
            field: normalizedField,
            type: "object",
            keyCount: Math.min(keyCount, MAX_EVIDENCE_COLLECTION_LENGTH),
            truncated: keyCount > MAX_EVIDENCE_COLLECTION_LENGTH,
        };
    }
    throw new TypeError("Unsupported diagnostic evidence value.");
}
/** Create one contract-valid diagnostic and validate all evidence at the boundary. */
export function createArtifactDiagnostic(input) {
    const detailCode = input.detailCode ?? input.code;
    const definition = DETAIL_DEFINITIONS[detailCode];
    if (definition === undefined)
        throw new TypeError(`Unsupported artifact diagnostic detail code: ${detailCode}.`);
    if (input.state !== definition.state || input.code !== definition.code) {
        throw new TypeError(`Diagnostic detail code ${detailCode} is incompatible with state/code.`);
    }
    if (input.reason !== undefined && input.reason !== definition.reason) {
        throw new TypeError(`Diagnostic detail code ${detailCode} is incompatible with reason ${input.reason}.`);
    }
    const diagnostic = {
        version: ARTIFACT_DIAGNOSTIC_VERSION,
        state: definition.state,
        code: definition.code,
        reason: definition.reason,
        detailCode,
        ...(input.path === undefined ? {} : { path: boundedText(input.path, MAX_DIAGNOSTIC_PATH_LENGTH) }),
        message: boundedText(input.message, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
        ...(input.expected === undefined ? {} : { expected: normalizeEvidence(input.expected) }),
        ...(input.actual === undefined ? {} : { actual: normalizeEvidence(input.actual) }),
        ...(input.recovery === undefined ? {} : { recovery: normalizeRecovery(input.recovery) }),
    };
    return diagnostic;
}
/** Create a stable report, sorting all set-like members by contract keys. */
export function createArtifactDiagnosticReport(diagnostics, acceptedFields = []) {
    if (diagnostics.length > MAX_ARTIFACT_DIAGNOSTICS) {
        throw new RangeError(`At most ${MAX_ARTIFACT_DIAGNOSTICS} diagnostics are supported.`);
    }
    if (acceptedFields.length > MAX_ACCEPTED_FIELDS) {
        throw new RangeError(`At most ${MAX_ACCEPTED_FIELDS} accepted fields are supported.`);
    }
    const normalized = diagnostics.map(canonicalizeDiagnostic).sort(compareDiagnostics);
    const accepted = [...new Set(acceptedFields.map(assertFieldPath))].sort(compareText);
    return {
        version: ARTIFACT_DIAGNOSTIC_VERSION,
        diagnostics: normalized,
        acceptedFields: accepted,
    };
}
/** Serialize a report with canonical ordering of diagnostics/evidence/actions. */
export function serializeArtifactDiagnosticReport(report) {
    if (report.version !== ARTIFACT_DIAGNOSTIC_VERSION) {
        throw new TypeError("Artifact diagnostics report has an unsupported version.");
    }
    return JSON.stringify(createArtifactDiagnosticReport(report.diagnostics, report.acceptedFields));
}
/** Project the machine contract into bounded human-readable text. */
export function formatArtifactDiagnostic(diagnostic) {
    const normalized = canonicalizeDiagnostic(diagnostic);
    const location = normalized.path === undefined ? "artifact" : normalized.path;
    const recovery = normalized.recovery?.find((action) => action.hint !== undefined)?.hint;
    const prefix = `[${normalized.code}/${normalized.detailCode}/${normalized.reason}]`;
    return recovery === undefined
        ? `${prefix} ${location}: ${normalized.message}`
        : `${prefix} ${location}: ${normalized.message} Next: ${recovery}`;
}
/** Project all report diagnostics without introducing a command-specific shape. */
export function formatArtifactDiagnosticReport(report) {
    const normalized = createArtifactDiagnosticReport(report.diagnostics, report.acceptedFields);
    const lines = normalized.diagnostics.map(formatArtifactDiagnostic);
    if (normalized.acceptedFields.length > 0)
        lines.push(`Accepted fields: ${normalized.acceptedFields.join(", ")}.`);
    return lines.join("\n");
}
/** Parse and validate a serialized report at an untrusted boundary. */
export function deserializeArtifactDiagnosticReport(serialized) {
    let parsed;
    try {
        parsed = JSON.parse(serialized);
    }
    catch (error) {
        throw new TypeError(`Artifact diagnostics must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(parsed))
        throw new TypeError("Artifact diagnostics must be a JSON object.");
    if (Object.keys(parsed).some((key) => !REPORT_KEYS.has(key))) {
        throw new TypeError("Artifact diagnostics contain an unknown property.");
    }
    if (parsed.version !== ARTIFACT_DIAGNOSTIC_VERSION) {
        throw new TypeError(`Unsupported artifact diagnostics version: ${String(parsed.version)}.`);
    }
    if (!Array.isArray(parsed.diagnostics) || !parsed.diagnostics.every(isDiagnostic)) {
        throw new TypeError("Artifact diagnostics must contain a valid diagnostics array.");
    }
    if (!Array.isArray(parsed.acceptedFields) || !parsed.acceptedFields.every((field) => typeof field === "string")) {
        throw new TypeError("Artifact diagnostics must contain an acceptedFields string array.");
    }
    return createArtifactDiagnosticReport(parsed.diagnostics, parsed.acceptedFields);
}
function canonicalizeDiagnostic(diagnostic) {
    const definition = DETAIL_DEFINITIONS[diagnostic.detailCode];
    if (definition === undefined || definition.state !== diagnostic.state || definition.code !== diagnostic.code) {
        throw new TypeError("Artifact diagnostic has an invalid state/code/detail combination.");
    }
    if (definition.reason !== diagnostic.reason)
        throw new TypeError("Artifact diagnostic has an invalid reason.");
    return {
        version: ARTIFACT_DIAGNOSTIC_VERSION,
        state: definition.state,
        code: definition.code,
        reason: definition.reason,
        detailCode: diagnostic.detailCode,
        ...(diagnostic.path === undefined ? {} : { path: boundedText(diagnostic.path, MAX_DIAGNOSTIC_PATH_LENGTH) }),
        message: boundedText(diagnostic.message, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
        ...(diagnostic.expected === undefined ? {} : { expected: normalizeEvidence(diagnostic.expected) }),
        ...(diagnostic.actual === undefined ? {} : { actual: normalizeEvidence(diagnostic.actual) }),
        ...(diagnostic.recovery === undefined ? {} : { recovery: normalizeRecovery(diagnostic.recovery) }),
    };
}
function normalizeEvidence(value) {
    if (!isRecord(value)) {
        throw new TypeError("Diagnostic evidence must be field-local typed evidence; raw values are not accepted.");
    }
    if (Object.keys(value).some((key) => !FIELD_EVIDENCE_KEYS.has(key))) {
        throw new TypeError("Diagnostic evidence contains an unknown property.");
    }
    if (typeof value.field !== "string")
        throw new TypeError("Diagnostic evidence requires a field identity.");
    const field = assertFieldPath(value.field);
    if (typeof value.type !== "string" || !EVIDENCE_TYPES.includes(value.type)) {
        throw new TypeError("Diagnostic evidence has an unsupported type.");
    }
    switch (value.type) {
        case "string":
            if (!isBoundedInteger(value.length, MAX_EVIDENCE_LENGTH) || typeof value.truncated !== "boolean") {
                throw new TypeError("String evidence has invalid bounds.");
            }
            return { field, type: "string", length: value.length, truncated: value.truncated };
        case "number":
            if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
                throw new TypeError("Number evidence has an invalid value.");
            }
            return { field, type: "number", value: value.value };
        case "boolean":
            if (typeof value.value !== "boolean")
                throw new TypeError("Boolean evidence has an invalid value.");
            return { field, type: "boolean", value: value.value };
        case "null":
            return { field, type: "null" };
        case "undefined":
            return { field, type: "undefined" };
        case "array": {
            if (!isBoundedInteger(value.itemCount, MAX_EVIDENCE_COLLECTION_LENGTH) || typeof value.truncated !== "boolean") {
                throw new TypeError("Array evidence has invalid bounds.");
            }
            if (!Array.isArray(value.itemTypes) ||
                value.itemTypes.length > MAX_EVIDENCE_ITEMS ||
                !value.itemTypes.every((type) => typeof type === "string" && EVIDENCE_TYPES.includes(type))) {
                throw new TypeError("Array evidence has invalid item types.");
            }
            return {
                field,
                type: "array",
                itemCount: value.itemCount,
                itemTypes: [...new Set(value.itemTypes)].sort(compareText),
                truncated: value.truncated,
            };
        }
        case "object":
            if (!isBoundedInteger(value.keyCount, MAX_EVIDENCE_COLLECTION_LENGTH) || typeof value.truncated !== "boolean") {
                throw new TypeError("Object evidence has invalid bounds.");
            }
            return { field, type: "object", keyCount: value.keyCount, truncated: value.truncated };
    }
}
function normalizeRecovery(input) {
    if (input.length > MAX_RECOVERY_ACTIONS) {
        throw new RangeError(`At most ${MAX_RECOVERY_ACTIONS} recovery actions are supported.`);
    }
    return input
        .map((recovery) => {
        if (!RECOVERY_ACTIONS.includes(recovery.action))
            throw new TypeError(`Unsupported recovery action: ${recovery.action}.`);
        return {
            action: recovery.action,
            ...(recovery.path === undefined ? {} : { path: boundedText(recovery.path, MAX_DIAGNOSTIC_PATH_LENGTH) }),
            ...(recovery.hint === undefined ? {} : { hint: boundedText(recovery.hint, MAX_RECOVERY_HINT_LENGTH) }),
        };
    })
        .sort(compareRecovery);
}
function compareRecovery(left, right) {
    return compareText([left.action, left.path ?? "", left.hint ?? ""].join("\u0000"), [right.action, right.path ?? "", right.hint ?? ""].join("\u0000"));
}
function compareDiagnostics(left, right) {
    const leftKey = JSON.stringify({
        path: left.path ?? "",
        state: left.state,
        code: left.code,
        reason: left.reason,
        detailCode: left.detailCode,
        message: left.message,
        expected: left.expected ?? null,
        actual: left.actual ?? null,
        recovery: left.recovery ?? [],
    });
    const rightKey = JSON.stringify({
        path: right.path ?? "",
        state: right.state,
        code: right.code,
        reason: right.reason,
        detailCode: right.detailCode,
        message: right.message,
        expected: right.expected ?? null,
        actual: right.actual ?? null,
        recovery: right.recovery ?? [],
    });
    return compareText(leftKey, rightKey);
}
function assertFieldPath(value) {
    const bounded = boundedText(value, MAX_DIAGNOSTIC_PATH_LENGTH);
    const segments = bounded
        .replace(/^\$\.?/, "")
        .split(/[.[\]]/u)
        .filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => PROHIBITED_FIELD_SEGMENT.test(segment))) {
        throw new TypeError("Diagnostic evidence must identify one non-sensitive semantic field.");
    }
    return bounded;
}
function boundedText(value, maxLength) {
    if (value.length > maxLength)
        throw new RangeError(`Diagnostic text exceeds its ${maxLength}-character bound.`);
    return value;
}
function isBoundedInteger(value, max) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}
function valueType(value) {
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return "array";
    if (typeof value === "object")
        return "object";
    if (typeof value === "string")
        return "string";
    if (typeof value === "number")
        return "number";
    if (typeof value === "boolean")
        return "boolean";
    if (typeof value === "undefined")
        return "undefined";
    throw new TypeError("Unsupported diagnostic evidence value.");
}
function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function isDiagnostic(value) {
    if (!isRecord(value))
        return false;
    if (Object.keys(value).some((key) => !DIAGNOSTIC_KEYS.has(key)))
        return false;
    return (value.version === ARTIFACT_DIAGNOSTIC_VERSION &&
        typeof value.state === "string" &&
        typeof value.code === "string" &&
        typeof value.reason === "string" &&
        typeof value.detailCode === "string" &&
        typeof value.message === "string" &&
        (value.path === undefined || typeof value.path === "string") &&
        (value.expected === undefined || isEvidence(value.expected)) &&
        (value.actual === undefined || isEvidence(value.actual)) &&
        (value.recovery === undefined ||
            (Array.isArray(value.recovery) &&
                value.recovery.every((entry) => isRecord(entry) &&
                    [...Object.keys(entry)].every((key) => RECOVERY_KEYS.has(key)) &&
                    typeof entry.action === "string" &&
                    RECOVERY_ACTIONS.includes(entry.action) &&
                    (entry.path === undefined || typeof entry.path === "string") &&
                    (entry.hint === undefined || typeof entry.hint === "string")))));
}
function isEvidence(value) {
    if (!isRecord(value))
        return false;
    return (typeof value.field === "string" &&
        typeof value.type === "string" &&
        EVIDENCE_TYPES.includes(value.type));
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=diagnostics.js.map