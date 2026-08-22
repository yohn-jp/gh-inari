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
export const MAX_EVIDENCE_DEPTH = 3;
export const MAX_EVIDENCE_ITEMS = 8;
export const MAX_EVIDENCE_KEYS = 12;
export const MAX_EVIDENCE_STRING_LENGTH = 240;
const SENSITIVE_KEY = /(?:^|[_-])(api[-_]?key|authorization|cookie|credential|password|secret|token)(?:$|[_-])/i;
const PRIVATE_ARTIFACT_KEY = /^(?:artifact|body|document|fields|metadata|payload)$/i;
const REPORT_KEYS = new Set(["version", "diagnostics", "acceptedFields"]);
const DIAGNOSTIC_KEYS = new Set(["version", "state", "code", "path", "message", "expected", "actual", "recovery"]);
const RECOVERY_KEYS = new Set(["action", "path", "hint"]);
const CODE_STATE = {
    FIELD_ACCEPTED: "accepted",
    FIELD_MISSING: "missing",
    FIELD_INVALID: "invalid",
    FIELD_CONFLICT: "conflicting",
    FIELD_UNSUPPORTED: "unsupported",
    ARTIFACT_UNRECOVERABLE: "unrecoverable",
};
/**
 * Create one contract-valid diagnostic and sanitize all evidence at the
 * boundary. Sanitization is intentionally lossy: diagnostics must never be a
 * transport for a complete artifact, secret, or unbounded parser payload.
 */
export function createArtifactDiagnostic(input) {
    assertStateCode(input.state, input.code);
    const diagnostic = {
        version: ARTIFACT_DIAGNOSTIC_VERSION,
        state: input.state,
        code: input.code,
        ...(input.path === undefined ? {} : { path: boundedText(input.path, MAX_DIAGNOSTIC_PATH_LENGTH) }),
        message: boundedText(input.message, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
        ...(input.expected === undefined ? {} : { expected: sanitizeEvidence(input.expected) }),
        ...(input.actual === undefined ? {} : { actual: sanitizeEvidence(input.actual) }),
        ...(input.recovery === undefined ? {} : { recovery: normalizeRecovery(input.recovery) }),
    };
    return diagnostic;
}
/** Create a stable report, sorting field identities and diagnostics by contract keys. */
export function createArtifactDiagnosticReport(diagnostics, acceptedFields = []) {
    if (diagnostics.length > MAX_ARTIFACT_DIAGNOSTICS) {
        throw new RangeError(`At most ${MAX_ARTIFACT_DIAGNOSTICS} diagnostics are supported.`);
    }
    if (acceptedFields.length > MAX_ACCEPTED_FIELDS) {
        throw new RangeError(`At most ${MAX_ACCEPTED_FIELDS} accepted fields are supported.`);
    }
    const normalized = diagnostics.map(canonicalizeDiagnostic).sort(compareDiagnostics);
    const accepted = [...new Set(acceptedFields.map((field) => boundedText(field, MAX_DIAGNOSTIC_PATH_LENGTH)))].sort();
    return {
        version: ARTIFACT_DIAGNOSTIC_VERSION,
        diagnostics: normalized,
        acceptedFields: accepted,
    };
}
/** Serialize a report with stable key ordering and stable diagnostic ordering. */
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
    return recovery === undefined
        ? `[${normalized.code}] ${location}: ${normalized.message}`
        : `[${normalized.code}] ${location}: ${normalized.message} Next: ${recovery}`;
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
function assertStateCode(state, code) {
    if (CODE_STATE[code] !== state) {
        throw new TypeError(`Diagnostic code ${code} is incompatible with state ${state}.`);
    }
}
function assertDiagnostic(diagnostic) {
    if (diagnostic.version !== ARTIFACT_DIAGNOSTIC_VERSION) {
        throw new TypeError("Artifact diagnostic has an unsupported version.");
    }
    assertStateCode(diagnostic.state, diagnostic.code);
    if (diagnostic.message.length > MAX_DIAGNOSTIC_MESSAGE_LENGTH) {
        throw new RangeError("Artifact diagnostic message exceeds its bound.");
    }
    if (diagnostic.path !== undefined && diagnostic.path.length > MAX_DIAGNOSTIC_PATH_LENGTH) {
        throw new RangeError("Artifact diagnostic path exceeds its bound.");
    }
    if (diagnostic.recovery !== undefined && diagnostic.recovery.length > MAX_RECOVERY_ACTIONS) {
        throw new RangeError("Artifact diagnostic recovery actions exceed their bound.");
    }
    return diagnostic;
}
function canonicalizeDiagnostic(diagnostic) {
    assertDiagnostic(diagnostic);
    return {
        version: ARTIFACT_DIAGNOSTIC_VERSION,
        state: diagnostic.state,
        code: diagnostic.code,
        ...(diagnostic.path === undefined ? {} : { path: boundedText(diagnostic.path, MAX_DIAGNOSTIC_PATH_LENGTH) }),
        message: boundedText(diagnostic.message, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
        ...(diagnostic.expected === undefined ? {} : { expected: sanitizeEvidence(diagnostic.expected) }),
        ...(diagnostic.actual === undefined ? {} : { actual: sanitizeEvidence(diagnostic.actual) }),
        ...(diagnostic.recovery === undefined ? {} : { recovery: normalizeRecovery(diagnostic.recovery) }),
    };
}
function normalizeRecovery(input) {
    if (input.length > MAX_RECOVERY_ACTIONS) {
        throw new RangeError(`At most ${MAX_RECOVERY_ACTIONS} recovery actions are supported.`);
    }
    return input.map((recovery) => ({
        action: assertRecoveryAction(recovery.action),
        ...(recovery.path === undefined ? {} : { path: boundedText(recovery.path, MAX_DIAGNOSTIC_PATH_LENGTH) }),
        ...(recovery.hint === undefined ? {} : { hint: boundedText(recovery.hint, MAX_RECOVERY_HINT_LENGTH) }),
    }));
}
function assertRecoveryAction(action) {
    const actions = [
        "provide",
        "replace",
        "resolve-conflict",
        "select-template",
        "repair",
        "retry",
    ];
    if (!actions.includes(action)) {
        throw new TypeError(`Unsupported artifact diagnostic recovery action: ${action}.`);
    }
    return action;
}
function sanitizeEvidence(value, depth = 0, key) {
    if (key !== undefined && (SENSITIVE_KEY.test(key) || PRIVATE_ARTIFACT_KEY.test(key))) {
        return "[redacted]";
    }
    if (value === null || typeof value === "boolean" || typeof value === "string") {
        return typeof value === "string" ? boundedEvidenceText(value) : value;
    }
    if (typeof value === "number")
        return Number.isFinite(value) ? value : String(value);
    if (depth >= MAX_EVIDENCE_DEPTH)
        return "[truncated]";
    if (Array.isArray(value)) {
        const bounded = value.slice(0, MAX_EVIDENCE_ITEMS).map((entry) => sanitizeEvidence(entry, depth + 1));
        return value.length > MAX_EVIDENCE_ITEMS ? [...bounded, "[truncated]"] : bounded;
    }
    if (isRecord(value)) {
        const keys = Object.keys(value).sort().slice(0, MAX_EVIDENCE_KEYS);
        const bounded = {};
        for (const entry of keys)
            bounded[entry] = sanitizeEvidence(value[entry], depth + 1, entry);
        if (Object.keys(value).length > MAX_EVIDENCE_KEYS)
            bounded._truncated = "[truncated]";
        return bounded;
    }
    return "[unsupported]";
}
function boundedEvidenceText(value) {
    return value.length <= MAX_EVIDENCE_STRING_LENGTH ? value : `${value.slice(0, MAX_EVIDENCE_STRING_LENGTH)}…`;
}
function boundedText(value, maxLength) {
    if (value.length > maxLength)
        throw new RangeError(`Diagnostic text exceeds its ${maxLength}-character bound.`);
    return value;
}
function compareDiagnostics(left, right) {
    const leftKey = [left.path ?? "", left.code, left.state, left.message].join("\u0000");
    const rightKey = [right.path ?? "", right.code, right.state, right.message].join("\u0000");
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}
function isDiagnostic(value) {
    if (!isRecord(value))
        return false;
    if (Object.keys(value).some((key) => !DIAGNOSTIC_KEYS.has(key)))
        return false;
    return (value.version === ARTIFACT_DIAGNOSTIC_VERSION &&
        typeof value.state === "string" &&
        typeof value.code === "string" &&
        CODE_STATE[value.code] === value.state &&
        typeof value.message === "string" &&
        (value.path === undefined || typeof value.path === "string") &&
        (value.recovery === undefined ||
            (Array.isArray(value.recovery) &&
                value.recovery.every((entry) => isRecord(entry) &&
                    [...Object.keys(entry)].every((key) => RECOVERY_KEYS.has(key)) &&
                    typeof entry.action === "string" &&
                    ["provide", "replace", "resolve-conflict", "select-template", "repair", "retry"].includes(entry.action) &&
                    (entry.path === undefined || typeof entry.path === "string") &&
                    (entry.hint === undefined || typeof entry.hint === "string")))));
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=diagnostics.js.map