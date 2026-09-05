/**
 * The transport-independent semantic contract for a governed Change.
 *
 * This module owns transport-independent Change data, validation, canonical
 * serialization, pure canonical branch identity derivation, the lifecycle
 * transition matrix, and pure effect planning. It does not read or mutate
 * GitHub state or execute effects.
 */
import { deriveBranchName } from "../branch-naming-authority.mjs";
import { issueReferenceKey, normalizeIssueReference, } from "./contract/issue-reference.js";
import { parsePullRequestPolicyOverlay } from "./pr-policy.js";
export const CHANGE_CONTRACT_VERSION = 1;
export const CHANGE_STATES = Object.freeze([
    "DEFINED",
    "DRAFT",
    "REVIEW",
    "ACCEPTED",
    "MERGED",
    "ABORTED",
    "RECOVERY_REQUIRED",
]);
export const CHANGE_PROVENANCE_ROLES = Object.freeze([
    "requester",
    "issuer",
    "implementer",
    "reviewer",
    "merger",
]);
/** Boundaries keep machine-readable failures safe to return to callers. */
export const MAX_CHANGE_DIAGNOSTICS = 32;
export const MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH = 240;
export const MAX_CHANGE_DIAGNOSTIC_PATH_LENGTH = 160;
export const MAX_CHANGE_PRINCIPAL_LENGTH = 160;
export const MAX_CHANGE_BRANCH_LENGTH = 255;
export const MAX_CHANGE_HOST_LENGTH = 255;
export const MAX_CHANGE_IDEMPOTENCY_KEY_LENGTH = 512;
/** Version of the transport-independent transition request and plan contract. */
export const CHANGE_TRANSITION_CONTRACT_VERSION = CHANGE_CONTRACT_VERSION;
/**
 * `merge` is reserved for a future merge-coordination capability.  It is
 * represented in the request vocabulary but is intentionally not executable
 * by this planning contract yet.
 */
export const CHANGE_TRANSITION_OPERATIONS = Object.freeze(["issue", "ready", "abort", "merge"]);
export const CHANGE_TRANSITIONS = CHANGE_TRANSITION_OPERATIONS;
export const CHANGE_IMPLEMENTED_TRANSITIONS = Object.freeze(["issue", "ready", "abort"]);
/** The only lifecycle edges currently owned by Inari Core. */
export const CHANGE_TRANSITION_RULES = Object.freeze([
    { transition: "issue", from: "DEFINED", to: "DRAFT" },
    { transition: "ready", from: "DRAFT", to: "REVIEW" },
    { transition: "abort", from: "DRAFT", to: "ABORTED" },
    { transition: "abort", from: "REVIEW", to: "ABORTED" },
]);
export const CHANGE_TRANSITION_MATRIX = CHANGE_TRANSITION_RULES;
export const CHANGE_EFFECT_KINDS = Object.freeze([
    "CREATE_BRANCH",
    "CREATE_PULL_REQUEST",
    "MARK_PULL_REQUEST_READY",
    "CLOSE_PULL_REQUEST",
    "DELETE_BRANCH",
]);
export const CHANGE_PROJECTION_STATUSES = Object.freeze([
    "healthy",
    "absent",
    "partial",
    "duplicate",
    "wrong-base",
    "ambiguous",
    "unavailable",
]);
export const CHANGE_PROJECTION_CANDIDATE_CLASSES = Object.freeze(["canonical", "noncanonical", "conflicting"]);
export const CHANGE_EVIDENCE_STATUSES = Object.freeze(["available", "absent", "unavailable"]);
/** The two idempotent issuance outcomes owned by Inari Core. */
export const CHANGE_ISSUANCE_MODES = Object.freeze(["create", "return-existing"]);
export const CHANGE_ISSUANCE_SOURCE_STATUSES = Object.freeze(["absent", "healthy"]);
/** Outcomes recorded by a transport-independent issuance effect journal. */
export const CHANGE_ISSUANCE_EFFECT_STATUSES = Object.freeze(["succeeded", "failed"]);
export const CHANGE_ISSUANCE_COMPENSATION_STATUSES = Object.freeze(["required", "succeeded", "failed"]);
export const CHANGE_ISSUANCE_RECOVERY_STATUSES = Object.freeze([
    "compensation-required",
    "compensated",
    "recovery-required",
]);
const DIAGNOSTIC_CODES = [
    "CHANGE_INVALID_JSON",
    "CHANGE_INVALID_ROOT",
    "CHANGE_MISSING_PROPERTY",
    "CHANGE_UNKNOWN_PROPERTY",
    "CHANGE_UNSUPPORTED_VERSION",
    "CHANGE_INVALID_IDENTITY",
    "CHANGE_INVALID_STATE",
    "CHANGE_INVALID_PROVENANCE",
    "CHANGE_INVALID_PROJECTION",
    "CHANGE_INVALID_BRANCH_INPUT",
    "CHANGE_INVALID_BRANCH_GOVERNANCE",
    "CHANGE_BRANCH_GOVERNANCE_MISMATCH",
    "CHANGE_INVALID_TRANSITION",
    "CHANGE_UNSUPPORTED_TRANSITION",
    "CHANGE_TRANSITION_NOT_ALLOWED",
    "CHANGE_INVALID_TRANSITION_TARGET",
    "CHANGE_INVALID_EFFECT",
    "CHANGE_INVALID_PLAN",
    "CHANGE_PROJECTION_INVALID_EVIDENCE",
    "CHANGE_PROJECTION_EVIDENCE_MISSING",
    "CHANGE_PROJECTION_EVIDENCE_UNAVAILABLE",
    "CHANGE_PROJECTION_ISSUE_MISMATCH",
    "CHANGE_PROJECTION_PARTIAL",
    "CHANGE_PROJECTION_DUPLICATE",
    "CHANGE_PROJECTION_WRONG_BASE",
    "CHANGE_PROJECTION_AMBIGUOUS",
    "CHANGE_PROJECTION_CONFLICT",
    "CHANGE_ISSUANCE_ROOT_ISSUE_ABSENT",
];
const CHANGE_KEYS = new Set(["version", "identity", "state", "provenance", "projection"]);
const IDENTITY_KEYS = new Set(["repositoryHost", "repositoryId", "rootIssue"]);
const PROVENANCE_KEYS = new Set(CHANGE_PROVENANCE_ROLES);
const PROJECTION_KEYS = new Set(["branch", "pullRequest"]);
const CANONICAL_BRANCH_DERIVATION_KEYS = new Set(["change", "branchGovernance", "naming"]);
const BRANCH_NAMING_KEYS = new Set(["type", "slug"]);
const TRANSITION_REQUEST_KEYS = new Set(["version", "transition", "change", "target"]);
const TRANSITION_TARGET_KEYS = new Set(["branch", "baseBranch", "pullRequest"]);
const TRANSITION_PLAN_KEYS = new Set(["version", "request", "from", "to", "result", "effects"]);
const EFFECT_KEYS = new Set(["kind", "branch", "baseBranch", "rootIssue", "draft", "pullRequest"]);
const CHANGE_PROJECTION_INPUT_KEYS = new Set([
    "change",
    "branchGovernance",
    "naming",
    "baseBranch",
    "evidence",
    "provenance",
]);
const CHANGE_ISSUANCE_PLAN_KEYS = new Set([
    "version",
    "operation",
    "mode",
    "sourceStatus",
    "transaction",
    "result",
    "effects",
    "verification",
]);
const CHANGE_ISSUANCE_TRANSACTION_KEYS = new Set(["operation", "identity", "idempotencyKey"]);
const CHANGE_ISSUANCE_VERIFICATION_KEYS = new Set([
    "phase",
    "status",
    "canonicalBranch",
    "canonicalBaseBranch",
    "state",
    "pullRequest",
]);
const CHANGE_ISSUANCE_PULL_REQUEST_KEYS = new Set(["required", "number"]);
const CHANGE_ISSUANCE_ATTEMPT_KEYS = new Set(["effect", "status"]);
const CHANGE_ISSUANCE_FAILURE_KEYS = new Set(["effect", "code", "message"]);
const CHANGE_ISSUANCE_FAILURE_RECORD_KEYS = new Set(["attemptedEffects", "failure", "projection"]);
const CHANGE_ISSUANCE_COMPENSATION_PLAN_KEYS = new Set([
    "version",
    "operation",
    "transaction",
    "issuance",
    "failureEvidence",
    "effects",
    "verification",
]);
const CHANGE_ISSUANCE_COMPENSATION_VERIFICATION_KEYS = new Set([
    "phase",
    "status",
    "canonicalBranch",
    "canonicalBaseBranch",
    "state",
    "pullRequest",
]);
const CHANGE_ISSUANCE_RECOVERY_INPUT_KEYS = new Set([
    "issuance",
    "attemptedEffects",
    "failure",
    "projection",
    "compensation",
]);
const CHANGE_ISSUANCE_COMPENSATION_OUTCOME_INPUT_KEYS = new Set(["status", "projection", "failure"]);
const CHANGE_ISSUANCE_RECOVERY_PLAN_KEYS = new Set([
    "version",
    "operation",
    "transaction",
    "issuance",
    "failureEvidence",
    "compensation",
    "result",
]);
const CHANGE_ISSUANCE_RECOVERY_COMPENSATION_KEYS = new Set(["status", "plan", "outcome"]);
const CHANGE_ISSUANCE_COMPENSATION_OUTCOME_KEYS = new Set(["status", "evidence", "failure"]);
const CHANGE_ISSUANCE_RECOVERY_RESULT_KEYS = new Set(["status", "state", "issued", "change"]);
const CHANGE_PROJECTION_RESULT_KEYS = new Set([
    "valid",
    "status",
    "canonicalBranch",
    "canonicalBaseBranch",
    "candidates",
    "change",
    "diagnostics",
]);
const CHANGE_PROJECTION_CANDIDATES_KEYS = new Set(["branches", "pullRequests"]);
const CHANGE_PROJECTION_CANDIDATE_KEYS = new Set(["candidate", "classification", "reason"]);
const CHANGE_GITHUB_EVIDENCE_KEYS = new Set(["issue", "branches", "pullRequests"]);
const CHANGE_EVIDENCE_AVAILABLE_KEYS = new Set(["status", "value"]);
const CHANGE_EVIDENCE_ABSENT_KEYS = new Set(["status"]);
const CHANGE_EVIDENCE_UNAVAILABLE_KEYS = new Set(["status", "reason"]);
const CHANGE_ISSUE_EVIDENCE_KEYS = new Set(["number", "state"]);
const CHANGE_BRANCH_EVIDENCE_KEYS = new Set(["name"]);
const CHANGE_PULL_REQUEST_EVIDENCE_KEYS = new Set([
    "number",
    "head",
    "base",
    "state",
    "draft",
    "merged",
    "accepted",
    "rootIssue",
    "provenance",
]);
export const MAX_CHANGE_BASE_BRANCH_LENGTH = MAX_CHANGE_BRANCH_LENGTH;
export const MAX_CHANGE_TRANSITION_EFFECTS = 8;
export const MAX_CHANGE_PROJECTION_CANDIDATES = 64;
export const MAX_CHANGE_ISSUANCE_ATTEMPTS = MAX_CHANGE_TRANSITION_EFFECTS;
export const MAX_CHANGE_FAILURE_CODE_LENGTH = 80;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOwn(record, key) {
    return Object.prototype.hasOwnProperty.call(record, key);
}
function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function boundedText(value, maxLength) {
    if (value.length > maxLength)
        throw new RangeError(`Change text exceeds its ${maxLength}-character bound.`);
    return value;
}
function safeText(value, maxLength) {
    if (value.length <= maxLength)
        return value;
    return `${value.slice(0, maxLength - 1)}…`;
}
function safePath(path) {
    return safeText(path, MAX_CHANGE_DIAGNOSTIC_PATH_LENGTH);
}
function safeMessage(message) {
    return safeText(message, MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH);
}
function addDiagnostic(diagnostics, code, path, message) {
    if (diagnostics.length >= MAX_CHANGE_DIAGNOSTICS)
        return;
    diagnostics.push(createChangeDiagnostic({
        code,
        path: safePath(path),
        message: safeMessage(message),
    }));
}
function addUnknownProperties(record, allowed, path, diagnostics) {
    for (const key of Object.keys(record).sort(compareText)) {
        if (!allowed.has(key)) {
            addDiagnostic(diagnostics, "CHANGE_UNKNOWN_PROPERTY", `${path}.${key}`, "Property is not supported.");
        }
    }
}
function canonicalizeDiagnostic(diagnostic) {
    if (diagnostic.version !== CHANGE_CONTRACT_VERSION) {
        throw new TypeError("Change diagnostic has an unsupported version.");
    }
    if (!DIAGNOSTIC_CODES.includes(diagnostic.code)) {
        throw new TypeError("Change diagnostic has an unsupported code.");
    }
    return {
        version: CHANGE_CONTRACT_VERSION,
        code: diagnostic.code,
        path: boundedText(diagnostic.path, MAX_CHANGE_DIAGNOSTIC_PATH_LENGTH),
        message: boundedText(diagnostic.message, MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH),
    };
}
function compareDiagnostics(left, right) {
    return (compareText(left.path, right.path) || compareText(left.code, right.code) || compareText(left.message, right.message));
}
/** Create one bounded, versioned machine-readable diagnostic. */
export function createChangeDiagnostic(input) {
    if (!DIAGNOSTIC_CODES.includes(input.code))
        throw new TypeError(`Unsupported Change diagnostic code: ${input.code}.`);
    if (input.message.length === 0)
        throw new TypeError("Change diagnostic messages cannot be empty.");
    const path = input.path ?? "$";
    if (path.length === 0)
        throw new TypeError("Change diagnostic paths cannot be empty.");
    return {
        version: CHANGE_CONTRACT_VERSION,
        code: input.code,
        path: boundedText(path, MAX_CHANGE_DIAGNOSTIC_PATH_LENGTH),
        message: boundedText(input.message, MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH),
    };
}
/** Sort and bound a diagnostic set for deterministic machine consumption. */
export function createChangeDiagnosticReport(diagnostics) {
    if (diagnostics.length > MAX_CHANGE_DIAGNOSTICS) {
        throw new RangeError(`At most ${MAX_CHANGE_DIAGNOSTICS} Change diagnostics are supported.`);
    }
    return {
        version: CHANGE_CONTRACT_VERSION,
        diagnostics: diagnostics.map(canonicalizeDiagnostic).sort(compareDiagnostics),
    };
}
export function serializeChangeDiagnosticReport(report) {
    if (report.version !== CHANGE_CONTRACT_VERSION) {
        throw new TypeError("Change diagnostic report has an unsupported version.");
    }
    return JSON.stringify(createChangeDiagnosticReport(report.diagnostics));
}
export function deserializeChangeDiagnosticReport(serialized) {
    let parsed;
    try {
        parsed = JSON.parse(serialized);
    }
    catch (error) {
        throw new TypeError(`Change diagnostics must be valid JSON: ${safeMessage(error instanceof Error ? error.message : String(error))}`);
    }
    if (!isRecord(parsed))
        throw new TypeError("Change diagnostics must be a JSON object.");
    if (Object.keys(parsed).some((key) => key !== "version" && key !== "diagnostics")) {
        throw new TypeError("Change diagnostics contain an unknown property.");
    }
    if (parsed.version !== CHANGE_CONTRACT_VERSION) {
        throw new TypeError(`Unsupported Change diagnostics version: ${String(parsed.version)}.`);
    }
    if (!Array.isArray(parsed.diagnostics) || !parsed.diagnostics.every(isDiagnostic)) {
        throw new TypeError("Change diagnostics must contain a valid diagnostics array.");
    }
    return createChangeDiagnosticReport(parsed.diagnostics);
}
function isDiagnostic(value) {
    if (!isRecord(value))
        return false;
    return (Object.keys(value).every((key) => key === "version" || key === "code" || key === "path" || key === "message") &&
        value.version === CHANGE_CONTRACT_VERSION &&
        typeof value.code === "string" &&
        DIAGNOSTIC_CODES.includes(value.code) &&
        typeof value.path === "string" &&
        typeof value.message === "string");
}
function identityDiagnosticPath(path, sourcePath) {
    return sourcePath === `${path}.number` ? `${path}.rootIssue` : sourcePath;
}
function identityMessage(code) {
    switch (code) {
        case "REFERENCE_REPOSITORY_HOST_INVALID":
            return "repositoryHost must be a valid non-empty host without whitespace or path separators.";
        case "REFERENCE_REPOSITORY_ID_INVALID":
            return "repositoryId must be a positive decimal repository identity.";
        case "REFERENCE_NUMBER_INVALID":
            return "rootIssue must be a positive safe integer.";
        default:
            return "Change identity is invalid.";
    }
}
/** Validate and canonicalize the repository/root-Issue identity. */
export function validateChangeIdentity(input, path = "$") {
    const diagnostics = [];
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_IDENTITY", path, "Change identity must be an object.");
        return { valid: false, diagnostics };
    }
    addUnknownProperties(input, IDENTITY_KEYS, path, diagnostics);
    const host = input.repositoryHost;
    if (typeof host === "string" && host.length > MAX_CHANGE_HOST_LENGTH) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_IDENTITY", `${path}.repositoryHost`, "repositoryHost exceeds its bound.");
    }
    const reference = normalizeIssueReference({
        repositoryHost: input.repositoryHost,
        repositoryId: input.repositoryId,
        number: input.rootIssue,
    }, path);
    for (const violation of reference.violations) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_IDENTITY", identityDiagnosticPath(path, violation.path), identityMessage(violation.code));
    }
    if (diagnostics.length > 0 || !reference.valid || reference.reference === undefined) {
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    return {
        valid: true,
        identity: {
            repositoryHost: reference.reference.repositoryHost,
            repositoryId: reference.reference.repositoryId,
            rootIssue: reference.reference.number,
        },
        diagnostics: [],
    };
}
export const normalizeChangeIdentity = validateChangeIdentity;
export const projectChangeIdentity = validateChangeIdentity;
function validateCanonicalBranchChangeIdentity(input, diagnostics) {
    if (isRecord(input) && hasOwn(input, "identity")) {
        const result = validateChange(input);
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        return result.change?.identity;
    }
    const result = validateChangeIdentity(input, "$.change");
    diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    return result.identity;
}
function branchGovernanceDiagnosticPath(error) {
    if (error instanceof Error && "path" in error && typeof error.path === "string") {
        return error.path.replace(/^\$\.branch/u, "$.branchGovernance");
    }
    return "$.branchGovernance";
}
function validateCanonicalBranchGovernance(input, diagnostics) {
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_BRANCH_GOVERNANCE", "$.branchGovernance", "Branch governance must be an object.");
        return undefined;
    }
    try {
        const parsed = parsePullRequestPolicyOverlay(JSON.stringify({ version: 1, sections: [], branch: input }));
        if (parsed.branch === undefined) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_BRANCH_GOVERNANCE", "$.branchGovernance", "Branch governance must declare a pattern.");
            return undefined;
        }
        return parsed.branch;
    }
    catch (error) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_BRANCH_GOVERNANCE", branchGovernanceDiagnosticPath(error), `Branch governance is invalid: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}
function validateCanonicalBranchNaming(input, diagnostics) {
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_BRANCH_INPUT", "$.naming", "Branch naming input must be an object.");
        return undefined;
    }
    addUnknownProperties(input, BRANCH_NAMING_KEYS, "$.naming", diagnostics);
    const type = input.type;
    const slug = input.slug;
    if (!hasOwn(input, "type")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.naming.type", "Property is required.");
    }
    else if (typeof type !== "string" || type.length === 0 || /[\u0000-\u001F\u007F]/u.test(type)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_BRANCH_INPUT", "$.naming.type", "Branch type is invalid.");
    }
    if (!hasOwn(input, "slug")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.naming.slug", "Property is required.");
    }
    else if (typeof slug !== "string" || slug.length === 0 || /[\u0000-\u001F\u007F]/u.test(slug)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_BRANCH_INPUT", "$.naming.slug", "Branch slug is invalid.");
    }
    if (diagnostics.some((diagnostic) => diagnostic.path === "$.naming.type" || diagnostic.path === "$.naming.slug")) {
        return undefined;
    }
    return { type: type, slug: slug };
}
/**
 * Derive one canonical branch identity from a validated Change identity,
 * repository branch governance, and governance-resolved naming parts.
 *
 * The branch grammar is owned by the shared branch authority. This function
 * only supplies the Change Issue number, verifies the repository policy, and
 * returns a pure projection; it never creates or updates a Git ref.
 */
export function deriveCanonicalBranchIdentity(input) {
    const diagnostics = [];
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_BRANCH_INPUT", "$", "Canonical branch derivation input must be an object.");
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    addUnknownProperties(input, CANONICAL_BRANCH_DERIVATION_KEYS, "$", diagnostics);
    let identity;
    if (!hasOwn(input, "change")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.change", "Property is required.");
    }
    else {
        identity = validateCanonicalBranchChangeIdentity(input.change, diagnostics);
    }
    let governance;
    if (!hasOwn(input, "branchGovernance")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.branchGovernance", "Property is required.");
    }
    else {
        governance = validateCanonicalBranchGovernance(input.branchGovernance, diagnostics);
    }
    let naming;
    if (!hasOwn(input, "naming")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.naming", "Property is required.");
    }
    else {
        naming = validateCanonicalBranchNaming(input.naming, diagnostics);
    }
    if (diagnostics.length > 0 || identity === undefined || governance === undefined || naming === undefined) {
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    let branch;
    try {
        branch = deriveBranchName({ type: naming.type, issueNumber: identity.rootIssue, slug: naming.slug });
    }
    catch (error) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_BRANCH_INPUT", "$.naming", error instanceof Error ? error.message : String(error));
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    if (branch.length > MAX_CHANGE_BRANCH_LENGTH) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_BRANCH_INPUT", "$.naming", `Derived branch exceeds its ${MAX_CHANGE_BRANCH_LENGTH}-character bound.`);
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    let pattern;
    try {
        pattern = new RegExp(governance.pattern, "u");
    }
    catch (error) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_BRANCH_GOVERNANCE", "$.branchGovernance.pattern", `Branch governance is invalid: ${error instanceof Error ? error.message : String(error)}`);
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    if (!pattern.test(branch)) {
        addDiagnostic(diagnostics, "CHANGE_BRANCH_GOVERNANCE_MISMATCH", "$.branchGovernance.pattern", `Derived branch "${branch}" does not satisfy the repository's branch governance.`);
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    return { valid: true, branch, diagnostics: [] };
}
function projectionEvidenceUnavailableResult(diagnostics, canonicalBranch, canonicalBaseBranch) {
    return {
        valid: false,
        status: "unavailable",
        ...(canonicalBranch === undefined ? {} : { canonicalBranch }),
        ...(canonicalBaseBranch === undefined ? {} : { canonicalBaseBranch }),
        candidates: { branches: [], pullRequests: [] },
        diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics,
    };
}
function projectionText(value, path, diagnostics, label, maxLength) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > maxLength ||
        /[\u0000-\u001F\u007F]/u.test(value)) {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", path, `${label} is invalid.`);
        return undefined;
    }
    return value;
}
function projectionNumber(value, path, diagnostics, label) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", path, `${label} must be a positive safe integer.`);
        return undefined;
    }
    return value;
}
function readChangeProjectionEvidenceSource(input, path, parseValue, diagnostics) {
    if (input === undefined) {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_EVIDENCE_MISSING", path, "Evidence is required.");
        return { status: "unavailable" };
    }
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", path, "Evidence source must be an object.");
        return { status: "unavailable" };
    }
    const status = input.status;
    if (status === "absent") {
        addUnknownProperties(input, CHANGE_EVIDENCE_ABSENT_KEYS, path, diagnostics);
        return { status: "absent" };
    }
    if (status === "available") {
        addUnknownProperties(input, CHANGE_EVIDENCE_AVAILABLE_KEYS, path, diagnostics);
        if (!hasOwn(input, "value")) {
            addDiagnostic(diagnostics, "CHANGE_PROJECTION_EVIDENCE_MISSING", `${path}.value`, "Available evidence must contain a value.");
            return { status: "unavailable" };
        }
        const value = parseValue(input.value, `${path}.value`, diagnostics);
        return value === undefined ? { status: "unavailable" } : { status: "available", value };
    }
    if (status === "unavailable") {
        addUnknownProperties(input, CHANGE_EVIDENCE_UNAVAILABLE_KEYS, path, diagnostics);
        if (!hasOwn(input, "reason")) {
            addDiagnostic(diagnostics, "CHANGE_PROJECTION_EVIDENCE_MISSING", `${path}.reason`, "Unavailable evidence must declare a reason.");
            return { status: "unavailable" };
        }
        const reason = input.reason;
        if (typeof reason !== "string" ||
            reason.length === 0 ||
            reason.length > MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH ||
            /[\u0000-\u001F\u007F]/u.test(reason)) {
            addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", `${path}.reason`, "Unavailable evidence reason is invalid.");
            return { status: "unavailable" };
        }
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_EVIDENCE_UNAVAILABLE", path, `Evidence is unavailable: ${reason}`);
        return { status: "unavailable" };
    }
    addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", `${path}.status`, "Evidence source status is unsupported.");
    return { status: "unavailable" };
}
function parseChangeIssueEvidence(value, path, diagnostics) {
    const before = diagnostics.length;
    if (!isRecord(value)) {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", path, "Issue evidence must be an object.");
        return undefined;
    }
    addUnknownProperties(value, CHANGE_ISSUE_EVIDENCE_KEYS, path, diagnostics);
    const number = projectionNumber(value.number, `${path}.number`, diagnostics, "Issue number");
    const state = value.state;
    if (state !== "open" && state !== "closed") {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", `${path}.state`, "Issue state is invalid.");
    }
    if (diagnostics.length !== before && number === undefined)
        return undefined;
    if (number === undefined || (state !== "open" && state !== "closed"))
        return undefined;
    return { number, state };
}
function parseChangeBranchEvidence(value, path, diagnostics) {
    const before = diagnostics.length;
    if (!isRecord(value)) {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", path, "Branch evidence must be an object.");
        return undefined;
    }
    addUnknownProperties(value, CHANGE_BRANCH_EVIDENCE_KEYS, path, diagnostics);
    const name = projectionText(value.name, `${path}.name`, diagnostics, "Branch name", MAX_CHANGE_BRANCH_LENGTH);
    return diagnostics.length === before && name !== undefined ? { name } : undefined;
}
function parseChangeBranchEvidenceList(value, path, diagnostics) {
    if (!Array.isArray(value)) {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", path, "Branch evidence value must be an array.");
        return undefined;
    }
    if (value.length > MAX_CHANGE_PROJECTION_CANDIDATES) {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", path, `At most ${MAX_CHANGE_PROJECTION_CANDIDATES} branch candidates are supported.`);
        return undefined;
    }
    const branches = [];
    for (const [index, candidate] of value.entries()) {
        const parsed = parseChangeBranchEvidence(candidate, `${path}[${index}]`, diagnostics);
        if (parsed !== undefined)
            branches.push(parsed);
    }
    if (branches.length !== value.length)
        return undefined;
    return branches.sort((left, right) => compareText(left.name, right.name));
}
function parseChangePullRequestEvidence(value, path, diagnostics) {
    const before = diagnostics.length;
    if (!isRecord(value)) {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", path, "Pull-request evidence must be an object.");
        return undefined;
    }
    addUnknownProperties(value, CHANGE_PULL_REQUEST_EVIDENCE_KEYS, path, diagnostics);
    const number = projectionNumber(value.number, `${path}.number`, diagnostics, "Pull-request number");
    const head = projectionText(value.head, `${path}.head`, diagnostics, "Pull-request head", MAX_CHANGE_BRANCH_LENGTH);
    const base = projectionText(value.base, `${path}.base`, diagnostics, "Pull-request base", MAX_CHANGE_BASE_BRANCH_LENGTH);
    const state = value.state;
    if (state !== "open" && state !== "closed") {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", `${path}.state`, "Pull-request state is invalid.");
    }
    const draft = value.draft;
    if (typeof draft !== "boolean") {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", `${path}.draft`, "Pull-request draft state is invalid.");
    }
    let merged;
    if (hasOwn(value, "merged")) {
        if (typeof value.merged !== "boolean") {
            addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", `${path}.merged`, "Pull-request merged state is invalid.");
        }
        else {
            merged = value.merged;
        }
    }
    else if (state === "closed") {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_EVIDENCE_MISSING", `${path}.merged`, "Closed pull-request evidence must distinguish merged from aborted.");
    }
    else if (state === "open") {
        merged = false;
    }
    let accepted;
    if (hasOwn(value, "accepted")) {
        if (typeof value.accepted !== "boolean") {
            addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", `${path}.accepted`, "Pull-request acceptance evidence is invalid.");
        }
        else {
            accepted = value.accepted;
        }
    }
    let rootIssue;
    if (hasOwn(value, "rootIssue")) {
        rootIssue = projectionNumber(value.rootIssue, `${path}.rootIssue`, diagnostics, "Root Issue number");
    }
    let provenance;
    if (hasOwn(value, "provenance")) {
        const result = validateChangeProvenance(value.provenance, `${path}.provenance`);
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        provenance = result.provenance;
    }
    if (state === "open" && merged === true) {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_CONFLICT", `${path}.merged`, "An open pull request cannot be projected as merged.");
    }
    if (draft === true && accepted === true) {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_CONFLICT", `${path}.accepted`, "A draft pull request cannot be projected as accepted.");
    }
    if (diagnostics.length !== before ||
        number === undefined ||
        head === undefined ||
        base === undefined ||
        (state !== "open" && state !== "closed") ||
        typeof draft !== "boolean" ||
        merged === undefined) {
        return undefined;
    }
    return {
        number,
        head,
        base,
        state,
        draft,
        merged,
        ...(accepted === undefined ? {} : { accepted }),
        ...(rootIssue === undefined ? {} : { rootIssue }),
        ...(provenance === undefined ? {} : { provenance }),
    };
}
function parseChangePullRequestEvidenceList(value, path, diagnostics) {
    if (!Array.isArray(value)) {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", path, "Pull-request evidence value must be an array.");
        return undefined;
    }
    if (value.length > MAX_CHANGE_PROJECTION_CANDIDATES) {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", path, `At most ${MAX_CHANGE_PROJECTION_CANDIDATES} pull-request candidates are supported.`);
        return undefined;
    }
    const pullRequests = [];
    for (const [index, candidate] of value.entries()) {
        const parsed = parseChangePullRequestEvidence(candidate, `${path}[${index}]`, diagnostics);
        if (parsed !== undefined)
            pullRequests.push(parsed);
    }
    if (pullRequests.length !== value.length)
        return undefined;
    return pullRequests.sort(compareChangePullRequestEvidence);
}
function compareOptionalNumber(left, right) {
    if (left === undefined && right === undefined)
        return 0;
    if (left === undefined)
        return -1;
    if (right === undefined)
        return 1;
    return left - right;
}
function compareOptionalBoolean(left, right) {
    if (left === undefined && right === undefined)
        return 0;
    if (left === undefined)
        return -1;
    if (right === undefined)
        return 1;
    return Number(left) - Number(right);
}
function compareChangePullRequestEvidence(left, right) {
    return (left.number - right.number ||
        compareText(left.head, right.head) ||
        compareText(left.base, right.base) ||
        compareText(left.state, right.state) ||
        Number(left.draft) - Number(right.draft) ||
        Number(left.merged) - Number(right.merged) ||
        compareOptionalBoolean(left.accepted, right.accepted) ||
        compareOptionalNumber(left.rootIssue, right.rootIssue) ||
        compareText(left.provenance?.issuer ?? "", right.provenance?.issuer ?? "") ||
        compareText(left.provenance?.implementer ?? "", right.provenance?.implementer ?? "") ||
        compareText(left.provenance?.reviewer ?? "", right.provenance?.reviewer ?? "") ||
        compareText(left.provenance?.merger ?? "", right.provenance?.merger ?? "") ||
        compareText(left.provenance?.requester ?? "", right.provenance?.requester ?? ""));
}
function projectionSourceValue(read, empty) {
    return read.status === "available" && read.value !== undefined ? read.value : empty;
}
function countProjectionValues(values, key) {
    const counts = new Map();
    for (const value of values) {
        const valueKey = key(value);
        counts.set(valueKey, (counts.get(valueKey) ?? 0) + 1);
    }
    return counts;
}
function classifyChangeBranchCandidates(branches, canonicalBranch) {
    const counts = countProjectionValues(branches, (candidate) => candidate.name);
    return branches.map((candidate) => {
        const count = counts.get(candidate.name) ?? 0;
        if (count > 1) {
            return {
                candidate,
                classification: "conflicting",
                reason: "The same branch candidate was reported more than once.",
            };
        }
        if (candidate.name === canonicalBranch) {
            return { candidate, classification: "canonical", reason: "Branch matches the derived canonical identity." };
        }
        return {
            candidate,
            classification: "noncanonical",
            reason: "Branch does not match the derived canonical identity.",
        };
    });
}
function projectionPullRequestIdentityMatches(candidate, canonicalBranch, canonicalBaseBranch, rootIssue) {
    return (candidate.head === canonicalBranch &&
        candidate.base === canonicalBaseBranch &&
        (candidate.rootIssue === undefined || candidate.rootIssue === rootIssue));
}
function classifyChangePullRequestCandidates(pullRequests, canonicalBranch, canonicalBaseBranch, rootIssue) {
    const numberCounts = countProjectionValues(pullRequests, (candidate) => String(candidate.number));
    return pullRequests.map((candidate) => {
        if ((numberCounts.get(String(candidate.number)) ?? 0) > 1) {
            return {
                candidate,
                classification: "conflicting",
                reason: "The same pull-request number was reported more than once.",
            };
        }
        if (candidate.head === canonicalBranch && candidate.base !== canonicalBaseBranch) {
            return {
                candidate,
                classification: "conflicting",
                reason: "Pull-request base does not match the canonical base branch.",
            };
        }
        if (candidate.head === canonicalBranch && candidate.rootIssue !== undefined && candidate.rootIssue !== rootIssue) {
            return {
                candidate,
                classification: "conflicting",
                reason: "Pull-request root Issue claim conflicts with the projected Change identity.",
            };
        }
        if (projectionPullRequestIdentityMatches(candidate, canonicalBranch, canonicalBaseBranch, rootIssue)) {
            return {
                candidate,
                classification: "canonical",
                reason: "Pull request matches the canonical branch, base, and Change identity.",
            };
        }
        return {
            candidate,
            classification: "noncanonical",
            reason: "Pull request does not match the canonical branch projection.",
        };
    });
}
function mergeChangeProvenance(base, candidate) {
    if (candidate === undefined)
        return base;
    return {
        ...base,
        ...candidate,
    };
}
function createProjectedChange(identity, provenance, state, branch, pullRequest) {
    const projection = {
        ...(branch === undefined ? {} : { branch }),
        ...(pullRequest === undefined ? {} : { pullRequest }),
    };
    return {
        version: CHANGE_CONTRACT_VERSION,
        identity,
        state,
        provenance,
        ...(Object.keys(projection).length === 0 ? {} : { projection }),
    };
}
function changeStateFromPullRequest(candidate) {
    if (candidate.state === "closed")
        return candidate.merged ? "MERGED" : "ABORTED";
    if (candidate.draft)
        return "DRAFT";
    if (candidate.accepted === true)
        return "ACCEPTED";
    return "REVIEW";
}
function projectionStatusDiagnostic(status, diagnostics) {
    if (status === "partial") {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_PARTIAL", "$.evidence", "Canonical branch and pull request evidence do not form a complete Change projection.");
    }
    else if (status === "duplicate") {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_DUPLICATE", "$.evidence", "More than one candidate claims the canonical Change projection.");
    }
    else if (status === "wrong-base") {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_WRONG_BASE", "$.evidence.pullRequests", "A canonical-branch pull request targets the wrong base branch.");
    }
    else if (status === "ambiguous") {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_AMBIGUOUS", "$.evidence", "Multiple plausible Change candidates exist; no heuristic candidate selection is allowed.");
    }
}
/**
 * Purely project one Change from bounded Issue, branch, and pull-request
 * evidence. Existing Change state is never used as authority, and no GitHub
 * client, persistence, mutation, or candidate heuristic is involved.
 */
export function projectChangeFromGitHubEvidence(input) {
    const diagnostics = [];
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Change projection input must be a JSON object.");
        return projectionEvidenceUnavailableResult(diagnostics);
    }
    addUnknownProperties(input, CHANGE_PROJECTION_INPUT_KEYS, "$", diagnostics);
    let identity;
    let provenance = {};
    if (!hasOwn(input, "change")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.change", "Property is required.");
    }
    else if (isRecord(input.change) && hasOwn(input.change, "identity")) {
        const result = validateChange(input.change);
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        identity = result.change?.identity;
        provenance = result.change?.provenance ?? {};
    }
    else {
        const result = validateChangeIdentity(input.change, "$.change");
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        identity = result.identity;
    }
    if (hasOwn(input, "provenance")) {
        const result = validateChangeProvenance(input.provenance, "$.provenance");
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        if (result.provenance !== undefined)
            provenance = result.provenance;
    }
    let canonicalBranch;
    if (identity !== undefined) {
        const derivationInput = { change: identity };
        if (hasOwn(input, "branchGovernance"))
            derivationInput.branchGovernance = input.branchGovernance;
        if (hasOwn(input, "naming"))
            derivationInput.naming = input.naming;
        const result = deriveCanonicalBranchIdentity(derivationInput);
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        canonicalBranch = result.branch;
    }
    let canonicalBaseBranch;
    if (!hasOwn(input, "baseBranch")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.baseBranch", "Property is required.");
    }
    else {
        canonicalBaseBranch = projectionText(input.baseBranch, "$.baseBranch", diagnostics, "Canonical base branch", MAX_CHANGE_BASE_BRANCH_LENGTH);
    }
    let evidence;
    if (!hasOwn(input, "evidence")) {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_EVIDENCE_MISSING", "$.evidence", "Evidence is required.");
    }
    else if (!isRecord(input.evidence)) {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", "$.evidence", "Evidence must be an object.");
    }
    else {
        evidence = input.evidence;
        addUnknownProperties(evidence, CHANGE_GITHUB_EVIDENCE_KEYS, "$.evidence", diagnostics);
    }
    if (identity === undefined ||
        canonicalBranch === undefined ||
        canonicalBaseBranch === undefined ||
        evidence === undefined ||
        diagnostics.length > 0) {
        return projectionEvidenceUnavailableResult(diagnostics, canonicalBranch, canonicalBaseBranch);
    }
    const issueRead = readChangeProjectionEvidenceSource(hasOwn(evidence, "issue") ? evidence.issue : undefined, "$.evidence.issue", parseChangeIssueEvidence, diagnostics);
    const branchRead = readChangeProjectionEvidenceSource(hasOwn(evidence, "branches") ? evidence.branches : undefined, "$.evidence.branches", parseChangeBranchEvidenceList, diagnostics);
    const pullRequestRead = readChangeProjectionEvidenceSource(hasOwn(evidence, "pullRequests") ? evidence.pullRequests : undefined, "$.evidence.pullRequests", parseChangePullRequestEvidenceList, diagnostics);
    if (diagnostics.length > 0) {
        return projectionEvidenceUnavailableResult(diagnostics, canonicalBranch, canonicalBaseBranch);
    }
    const branches = projectionSourceValue(branchRead, []);
    const pullRequests = projectionSourceValue(pullRequestRead, []);
    const candidates = {
        branches: classifyChangeBranchCandidates(branches, canonicalBranch),
        pullRequests: classifyChangePullRequestCandidates(pullRequests, canonicalBranch, canonicalBaseBranch, identity.rootIssue),
    };
    const issue = issueRead.status === "available" ? issueRead.value : undefined;
    if (issueRead.status === "available" && issue === undefined) {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_INVALID_EVIDENCE", "$.evidence.issue", "Issue evidence is incomplete.");
        return projectionEvidenceUnavailableResult(diagnostics, canonicalBranch, canonicalBaseBranch);
    }
    if (issue !== undefined && issue.number !== identity.rootIssue) {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_ISSUE_MISMATCH", "$.evidence.issue.number", "Issue evidence does not match the projected Change root Issue.");
        return {
            valid: false,
            status: "unavailable",
            canonicalBranch,
            canonicalBaseBranch,
            candidates,
            diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics,
        };
    }
    const canonicalBranches = candidates.branches.filter((candidate) => candidate.candidate.name === canonicalBranch);
    const canonicalPullRequests = pullRequests.filter((candidate) => projectionPullRequestIdentityMatches(candidate, canonicalBranch, canonicalBaseBranch, identity.rootIssue));
    const pullRequestNumberCounts = countProjectionValues(pullRequests, (candidate) => String(candidate.number));
    const duplicateCanonicalPullRequestNumbers = pullRequests.some((candidate) => candidate.head === canonicalBranch && (pullRequestNumberCounts.get(String(candidate.number)) ?? 0) > 1);
    const wrongBasePullRequests = pullRequests.filter((candidate) => candidate.head === canonicalBranch && candidate.base !== canonicalBaseBranch);
    const conflictingCandidates = [
        ...candidates.branches.filter((candidate) => candidate.classification === "conflicting"),
        ...candidates.pullRequests.filter((candidate) => candidate.classification === "conflicting"),
    ];
    const plausibleNoncanonicalPullRequests = pullRequests.filter((candidate) => candidate.rootIssue === identity.rootIssue && candidate.head !== canonicalBranch);
    let status;
    if (canonicalBranches.length > 1 || canonicalPullRequests.length > 1 || duplicateCanonicalPullRequestNumbers) {
        status = "duplicate";
    }
    else if (wrongBasePullRequests.length > 0) {
        status = "wrong-base";
    }
    else if (conflictingCandidates.length > 0) {
        status = "ambiguous";
    }
    else if (canonicalBranches.length === 1 && canonicalPullRequests.length === 1 && issue !== undefined) {
        status = "healthy";
    }
    else if (canonicalBranches.length === 1 || canonicalPullRequests.length === 1) {
        status = "partial";
    }
    else if (plausibleNoncanonicalPullRequests.length > 1) {
        status = "ambiguous";
    }
    else if (issueRead.status === "absent" && (canonicalBranches.length > 0 || canonicalPullRequests.length > 0)) {
        status = "partial";
    }
    else {
        status = "absent";
    }
    if (status === "absent") {
        const change = issue === undefined ? undefined : createProjectedChange(identity, provenance, "DEFINED", undefined, undefined);
        return {
            valid: true,
            status,
            canonicalBranch,
            canonicalBaseBranch,
            candidates,
            ...(change === undefined ? {} : { change }),
            diagnostics: [],
        };
    }
    const canonicalPullRequest = canonicalPullRequests.length === 1 ? canonicalPullRequests[0] : undefined;
    const knownBranch = canonicalBranches.length === 1 || pullRequests.some((candidate) => candidate.head === canonicalBranch);
    const projectedBranch = knownBranch ? canonicalBranch : undefined;
    const projectedPullRequest = canonicalPullRequest?.number;
    const projectedProvenance = mergeChangeProvenance(provenance, canonicalPullRequest?.provenance);
    const state = status === "healthy"
        ? changeStateFromPullRequest(canonicalPullRequest)
        : "RECOVERY_REQUIRED";
    const change = createProjectedChange(identity, projectedProvenance, state, projectedBranch, projectedPullRequest);
    if (conflictingCandidates.length > 0 && status !== "duplicate" && status !== "wrong-base") {
        addDiagnostic(diagnostics, "CHANGE_PROJECTION_CONFLICT", "$.evidence", "Conflicting candidates claim part of the canonical Change projection.");
    }
    projectionStatusDiagnostic(status, diagnostics);
    return {
        valid: status === "healthy",
        status,
        canonicalBranch,
        canonicalBaseBranch,
        candidates,
        change,
        diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics,
    };
}
export const projectChangeFromEvidence = projectChangeFromGitHubEvidence;
export const deriveChangeProjection = projectChangeFromGitHubEvidence;
/** Stable identity key; locator changes cannot create a second Change. */
export function changeIdentityKey(input) {
    const result = validateChangeIdentity(input);
    if (!result.valid || result.identity === undefined)
        throw new ChangeValidationError(result.diagnostics);
    return issueReferenceKey({
        repositoryHost: result.identity.repositoryHost,
        repositoryId: result.identity.repositoryId,
        number: result.identity.rootIssue,
    });
}
/** Validate the five provenance roles without imposing transition policy. */
export function validateChangeProvenance(input, path = "$") {
    const diagnostics = [];
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PROVENANCE", path, "Change provenance must be an object.");
        return { valid: false, diagnostics };
    }
    addUnknownProperties(input, PROVENANCE_KEYS, path, diagnostics);
    const provenance = {};
    for (const role of CHANGE_PROVENANCE_ROLES) {
        if (!hasOwn(input, role))
            continue;
        const value = input[role];
        if (typeof value !== "string" ||
            value.length === 0 ||
            value.trim().length === 0 ||
            value.length > MAX_CHANGE_PRINCIPAL_LENGTH ||
            /[\u0000-\u001F\u007F]/u.test(value)) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PROVENANCE", `${path}.${role}`, "Provenance role identity is invalid.");
            continue;
        }
        provenance[role] = value;
    }
    if (diagnostics.length > 0) {
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    return { valid: true, provenance, diagnostics: [] };
}
/** Validate semantic branch/PR projection fields without naming-policy logic. */
export function validateChangeProjection(input, path = "$") {
    const diagnostics = [];
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PROJECTION", path, "Change projection must be an object.");
        return { valid: false, diagnostics };
    }
    addUnknownProperties(input, PROJECTION_KEYS, path, diagnostics);
    const projection = {};
    let branch;
    let pullRequest;
    if (hasOwn(input, "branch")) {
        if (typeof input.branch !== "string" ||
            input.branch.length === 0 ||
            input.branch.length > MAX_CHANGE_BRANCH_LENGTH ||
            /[\u0000-\u001F\u007F]/u.test(input.branch)) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PROJECTION", `${path}.branch`, "Change branch identity is invalid.");
        }
        else {
            branch = input.branch;
        }
    }
    if (hasOwn(input, "pullRequest")) {
        if (typeof input.pullRequest !== "number" || !Number.isSafeInteger(input.pullRequest) || input.pullRequest < 1) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PROJECTION", `${path}.pullRequest`, "pullRequest must be a positive safe integer.");
        }
        else {
            pullRequest = input.pullRequest;
        }
    }
    if (diagnostics.length > 0) {
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    if (branch !== undefined)
        projection.branch = branch;
    if (pullRequest !== undefined)
        projection.pullRequest = pullRequest;
    return { valid: true, projection, diagnostics: [] };
}
/** Validate and canonicalize one complete Change snapshot. */
export function validateChange(input) {
    const diagnostics = [];
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Change contract must be a JSON object.");
        return { valid: false, diagnostics };
    }
    addUnknownProperties(input, CHANGE_KEYS, "$", diagnostics);
    if (!hasOwn(input, "version")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.version", "Property is required.");
    }
    else if (input.version !== CHANGE_CONTRACT_VERSION) {
        addDiagnostic(diagnostics, "CHANGE_UNSUPPORTED_VERSION", "$.version", "Change contract version is unsupported.");
    }
    let identity;
    if (!hasOwn(input, "identity")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.identity", "Property is required.");
    }
    else {
        const result = validateChangeIdentity(input.identity, "$.identity");
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        identity = result.identity;
    }
    let state;
    if (!hasOwn(input, "state")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.state", "Property is required.");
    }
    else if (typeof input.state !== "string" || !CHANGE_STATES.includes(input.state)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_STATE", "$.state", "Change lifecycle state is unsupported.");
    }
    else {
        state = input.state;
    }
    let provenance;
    if (!hasOwn(input, "provenance")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.provenance", "Property is required.");
    }
    else {
        const result = validateChangeProvenance(input.provenance, "$.provenance");
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        provenance = result.provenance;
    }
    let projection;
    if (hasOwn(input, "projection")) {
        const result = validateChangeProjection(input.projection, "$.projection");
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        projection = result.projection;
    }
    const normalizedDiagnostics = createChangeDiagnosticReport(diagnostics).diagnostics;
    if (normalizedDiagnostics.length > 0 || identity === undefined || state === undefined || provenance === undefined) {
        return { valid: false, diagnostics: normalizedDiagnostics };
    }
    return {
        valid: true,
        change: {
            version: CHANGE_CONTRACT_VERSION,
            identity,
            state,
            provenance,
            ...(projection === undefined ? {} : { projection }),
        },
        diagnostics: [],
    };
}
export const normalizeChange = validateChange;
export const projectChange = validateChange;
export function isChange(input) {
    return validateChange(input).valid;
}
export class ChangeValidationError extends Error {
    code;
    path;
    diagnostics;
    constructor(diagnostics) {
        const report = createChangeDiagnosticReport(diagnostics);
        const first = report.diagnostics[0];
        if (first === undefined)
            throw new Error("Change validation errors require at least one diagnostic.");
        super(report.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n"));
        this.name = "ChangeValidationError";
        this.code = first.code;
        this.path = first.path;
        this.diagnostics = report.diagnostics;
    }
    toJSON() {
        return { code: this.code, path: this.path, message: this.message, diagnostics: this.diagnostics };
    }
}
export function assertChange(input) {
    const result = validateChange(input);
    if (!result.valid)
        throw new ChangeValidationError(result.diagnostics);
}
/** Serialize the canonical representation, with stable property ordering. */
export function serializeChange(input) {
    const result = validateChange(input);
    if (!result.valid || result.change === undefined)
        throw new ChangeValidationError(result.diagnostics);
    const serialized = JSON.stringify(result.change);
    if (serialized === undefined)
        throw new Error("Change contract could not be serialized.");
    return serialized;
}
/** Parse an untrusted JSON boundary and return the canonical Change value. */
export function deserializeChange(serialized) {
    let parsed;
    try {
        parsed = JSON.parse(serialized);
    }
    catch (error) {
        throw new ChangeValidationError([
            createChangeDiagnostic({
                code: "CHANGE_INVALID_JSON",
                message: safeMessage(`Change contract must be valid JSON: ${error instanceof Error ? error.message : String(error)}`),
            }),
        ]);
    }
    const result = validateChange(parsed);
    if (!result.valid || result.change === undefined)
        throw new ChangeValidationError(result.diagnostics);
    return result.change;
}
export const parseChange = deserializeChange;
export const serializeChangeContract = serializeChange;
function normalizeChangeTransition(input) {
    if (typeof input !== "string")
        return undefined;
    const normalized = input.toLowerCase();
    return CHANGE_TRANSITION_OPERATIONS.includes(normalized)
        ? normalized
        : undefined;
}
function validateTransitionBranch(value, path, maxLength, diagnostics) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > maxLength ||
        /[\u0000-\u001F\u007F]/u.test(value)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_TRANSITION_TARGET", path, "Branch identity is invalid.");
        return undefined;
    }
    return value;
}
function validateTransitionTarget(input, path) {
    const diagnostics = [];
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_TRANSITION_TARGET", path, "Transition target must be an object.");
        return { valid: false, diagnostics };
    }
    addUnknownProperties(input, TRANSITION_TARGET_KEYS, path, diagnostics);
    let branch;
    let baseBranch;
    let pullRequest;
    if (hasOwn(input, "branch")) {
        branch = validateTransitionBranch(input.branch, `${path}.branch`, MAX_CHANGE_BRANCH_LENGTH, diagnostics);
    }
    if (hasOwn(input, "baseBranch")) {
        baseBranch = validateTransitionBranch(input.baseBranch, `${path}.baseBranch`, MAX_CHANGE_BASE_BRANCH_LENGTH, diagnostics);
    }
    if (hasOwn(input, "pullRequest")) {
        if (typeof input.pullRequest !== "number" || !Number.isSafeInteger(input.pullRequest) || input.pullRequest < 1) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_TRANSITION_TARGET", `${path}.pullRequest`, "pullRequest must be a positive safe integer.");
        }
        else {
            pullRequest = input.pullRequest;
        }
    }
    if (diagnostics.length > 0) {
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    return {
        valid: true,
        target: {
            ...(branch === undefined ? {} : { branch }),
            ...(baseBranch === undefined ? {} : { baseBranch }),
            ...(pullRequest === undefined ? {} : { pullRequest }),
        },
        diagnostics: [],
    };
}
function transitionRule(transition, state) {
    return CHANGE_TRANSITION_RULES.find((candidate) => candidate.transition === transition && candidate.from === state);
}
function reportTransitionMismatch(diagnostics, path, message) {
    addDiagnostic(diagnostics, "CHANGE_TRANSITION_NOT_ALLOWED", path, message);
}
function reportTargetProblem(diagnostics, path, message) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_TRANSITION_TARGET", path, message);
}
function sameDefinedValue(left, right) {
    return left === undefined || right === undefined || left === right;
}
function validateTransitionSemantics(change, transition, target) {
    const diagnostics = [];
    if (transition === "merge") {
        addDiagnostic(diagnostics, "CHANGE_UNSUPPORTED_TRANSITION", "$.transition", "The merge transition is reserved for a future merge-coordination capability.");
        return { diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    const rule = transitionRule(transition, change.state);
    if (rule === undefined) {
        reportTransitionMismatch(diagnostics, "$.change.state", `Transition "${transition}" is not allowed from state "${change.state}".`);
        return { diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    if (transition === "issue") {
        if (change.projection?.branch !== undefined || change.projection?.pullRequest !== undefined) {
            reportTransitionMismatch(diagnostics, "$.change.projection", "An issue transition requires a Change without an existing canonical projection.");
        }
        if (target === undefined) {
            reportTargetProblem(diagnostics, "$.target", "An issue transition requires a target.");
        }
        else {
            if (target.branch === undefined) {
                reportTargetProblem(diagnostics, "$.target.branch", "An issue transition requires a canonical branch.");
            }
            if (target.baseBranch === undefined) {
                reportTargetProblem(diagnostics, "$.target.baseBranch", "An issue transition requires a base branch.");
            }
            if (target.pullRequest !== undefined) {
                reportTargetProblem(diagnostics, "$.target.pullRequest", "An issue transition cannot contain an already-created pull request.");
            }
        }
        if (diagnostics.length > 0) {
            return { diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
        }
        return {
            diagnostics: [],
            resolved: {
                branch: target?.branch,
                baseBranch: target?.baseBranch,
            },
        };
    }
    if (target?.baseBranch !== undefined) {
        reportTargetProblem(diagnostics, "$.target.baseBranch", `The ${transition} transition does not accept a base branch target.`);
    }
    const sourceBranch = change.projection?.branch;
    const sourcePullRequest = change.projection?.pullRequest;
    if (!sameDefinedValue(sourceBranch, target?.branch)) {
        reportTargetProblem(diagnostics, "$.target.branch", "Target branch does not match the current Change projection.");
    }
    if (!sameDefinedValue(sourcePullRequest, target?.pullRequest)) {
        reportTargetProblem(diagnostics, "$.target.pullRequest", "Target pull request does not match the current Change projection.");
    }
    const branch = target?.branch ?? sourceBranch;
    const pullRequest = target?.pullRequest ?? sourcePullRequest;
    if (branch === undefined) {
        reportTargetProblem(diagnostics, "$.change.projection.branch", "The transition requires a canonical branch.");
    }
    if (pullRequest === undefined) {
        reportTargetProblem(diagnostics, "$.change.projection.pullRequest", "The transition requires a canonical pull request.");
    }
    if (diagnostics.length > 0) {
        return { diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    return { diagnostics: [], resolved: { branch, pullRequest } };
}
/** Validate a transport-independent lifecycle request and its transition policy. */
export function validateChangeTransitionRequest(input) {
    const diagnostics = [];
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Change transition request must be a JSON object.");
        return { valid: false, diagnostics };
    }
    addUnknownProperties(input, TRANSITION_REQUEST_KEYS, "$", diagnostics);
    if (!hasOwn(input, "version")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.version", "Property is required.");
    }
    else if (input.version !== CHANGE_TRANSITION_CONTRACT_VERSION) {
        addDiagnostic(diagnostics, "CHANGE_UNSUPPORTED_VERSION", "$.version", "Change transition contract version is unsupported.");
    }
    let transition;
    if (!hasOwn(input, "transition")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.transition", "Property is required.");
    }
    else {
        transition = normalizeChangeTransition(input.transition);
        if (transition === undefined) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_TRANSITION", "$.transition", "Transition operation is unsupported.");
        }
    }
    let change;
    if (!hasOwn(input, "change")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.change", "Property is required.");
    }
    else {
        const result = validateChange(input.change);
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        change = result.change;
    }
    let target;
    if (hasOwn(input, "target")) {
        const result = validateTransitionTarget(input.target, "$.target");
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        target = result.target;
    }
    if (diagnostics.length > 0 || transition === undefined || change === undefined) {
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    const semantic = validateTransitionSemantics(change, transition, target);
    diagnostics.push(...semantic.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    if (diagnostics.length > 0 || semantic.resolved === undefined) {
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    return {
        valid: true,
        request: {
            version: CHANGE_TRANSITION_CONTRACT_VERSION,
            transition,
            change,
            ...(target === undefined ? {} : { target }),
        },
        diagnostics: [],
    };
}
export const validateChangeTransition = validateChangeTransitionRequest;
/** Assert a valid request at a trusted Core call boundary. */
export function assertChangeTransitionRequest(input) {
    const result = validateChangeTransitionRequest(input);
    if (!result.valid)
        throw new ChangeTransitionValidationError(result.diagnostics);
}
function resolvedTransitionTarget(request) {
    const target = request.target;
    const projection = request.change.projection;
    if (request.transition === "issue") {
        return { branch: target?.branch, baseBranch: target?.baseBranch };
    }
    return {
        branch: target?.branch ?? projection?.branch,
        pullRequest: target?.pullRequest ?? projection?.pullRequest,
    };
}
function transitionResult(request, to) {
    const resolved = resolvedTransitionTarget(request);
    const projection = {
        ...(resolved.branch === undefined ? {} : { branch: resolved.branch }),
        ...(resolved.pullRequest === undefined ? {} : { pullRequest: resolved.pullRequest }),
    };
    return {
        version: CHANGE_CONTRACT_VERSION,
        identity: request.change.identity,
        state: to,
        provenance: request.change.provenance,
        ...(Object.keys(projection).length === 0 ? {} : { projection }),
    };
}
function buildChangeTransitionPlan(request) {
    const rule = transitionRule(request.transition, request.change.state);
    if (rule === undefined) {
        throw new Error("Cannot build a plan for an invalid Change transition request.");
    }
    const resolved = resolvedTransitionTarget(request);
    const effects = [];
    if (request.transition === "issue") {
        if (resolved.branch === undefined || resolved.baseBranch === undefined) {
            throw new Error("A valid issue request must resolve branch and base branch targets.");
        }
        effects.push({
            kind: "CREATE_BRANCH",
            branch: resolved.branch,
            baseBranch: resolved.baseBranch,
        }, {
            kind: "CREATE_PULL_REQUEST",
            branch: resolved.branch,
            baseBranch: resolved.baseBranch,
            rootIssue: request.change.identity.rootIssue,
            draft: true,
        });
    }
    else if (request.transition === "ready") {
        if (resolved.pullRequest === undefined)
            throw new Error("A valid ready request must resolve a pull request.");
        effects.push({ kind: "MARK_PULL_REQUEST_READY", pullRequest: resolved.pullRequest });
    }
    else if (request.transition === "abort") {
        if (resolved.pullRequest === undefined)
            throw new Error("A valid abort request must resolve a pull request.");
        effects.push({ kind: "CLOSE_PULL_REQUEST", pullRequest: resolved.pullRequest });
    }
    else {
        throw new Error("The merge transition is not currently plannable.");
    }
    return {
        version: CHANGE_TRANSITION_CONTRACT_VERSION,
        request,
        from: rule.from,
        to: rule.to,
        result: transitionResult(request, rule.to),
        effects,
    };
}
/**
 * Produce a deterministic declarative plan.  This function has no I/O and
 * never invokes an adapter or a privileged GitHub capability.
 */
export function planChangeTransition(input) {
    const result = validateChangeTransitionRequest(input);
    if (!result.valid || result.request === undefined) {
        throw new ChangeTransitionValidationError(result.diagnostics);
    }
    return buildChangeTransitionPlan(result.request);
}
export const createChangeTransitionPlan = planChangeTransition;
function requiredPlanState(input, key, diagnostics) {
    if (!hasOwn(input, key)) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", `$.${key}`, "Property is required.");
        return undefined;
    }
    if (typeof input[key] !== "string" || !CHANGE_STATES.includes(input[key])) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `$.${key}`, "Plan lifecycle state is unsupported.");
        return undefined;
    }
    return input[key];
}
function requiredEffectBranch(input, key, path, maxLength, diagnostics) {
    if (!hasOwn(input, key)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_EFFECT", `${path}.${key}`, "Effect property is required.");
        return undefined;
    }
    return validateEffectBranch(input[key], `${path}.${key}`, maxLength, diagnostics);
}
function validateEffectBranch(value, path, maxLength, diagnostics) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > maxLength ||
        /[\u0000-\u001F\u007F]/u.test(value)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_EFFECT", path, "Effect branch identity is invalid.");
        return undefined;
    }
    return value;
}
function requiredEffectNumber(input, key, path, diagnostics) {
    if (!hasOwn(input, key)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_EFFECT", `${path}.${key}`, "Effect property is required.");
        return undefined;
    }
    if (typeof input[key] !== "number" || !Number.isSafeInteger(input[key]) || input[key] < 1) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_EFFECT", `${path}.${key}`, "Effect number must be a positive safe integer.");
        return undefined;
    }
    return input[key];
}
function rejectEffectProperties(input, allowed, path, diagnostics) {
    for (const key of Object.keys(input).sort(compareText)) {
        if (!allowed.has(key)) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_EFFECT", `${path}.${key}`, "Effect property is not valid for its kind.");
        }
    }
}
/** Validate one declarative effect primitive without executing it. */
export function validateChangeEffect(input, path = "$") {
    const diagnostics = [];
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_EFFECT", path, "Change effect must be an object.");
        return { valid: false, diagnostics };
    }
    addUnknownProperties(input, EFFECT_KEYS, path, diagnostics);
    const kind = input.kind;
    if (typeof kind !== "string" || !CHANGE_EFFECT_KINDS.includes(kind)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_EFFECT", `${path}.kind`, "Effect kind is unsupported.");
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    if (kind === "CREATE_BRANCH") {
        const allowed = new Set(["kind", "branch", "baseBranch"]);
        rejectEffectProperties(input, allowed, path, diagnostics);
        const branch = requiredEffectBranch(input, "branch", path, MAX_CHANGE_BRANCH_LENGTH, diagnostics);
        const baseBranch = requiredEffectBranch(input, "baseBranch", path, MAX_CHANGE_BASE_BRANCH_LENGTH, diagnostics);
        if (diagnostics.length > 0 || branch === undefined || baseBranch === undefined) {
            return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
        }
        return { valid: true, effect: { kind, branch, baseBranch }, diagnostics: [] };
    }
    if (kind === "CREATE_PULL_REQUEST") {
        const allowed = new Set(["kind", "branch", "baseBranch", "rootIssue", "draft"]);
        rejectEffectProperties(input, allowed, path, diagnostics);
        const branch = requiredEffectBranch(input, "branch", path, MAX_CHANGE_BRANCH_LENGTH, diagnostics);
        const baseBranch = requiredEffectBranch(input, "baseBranch", path, MAX_CHANGE_BASE_BRANCH_LENGTH, diagnostics);
        const rootIssue = requiredEffectNumber(input, "rootIssue", path, diagnostics);
        if (!hasOwn(input, "draft") || input.draft !== true) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_EFFECT", `${path}.draft`, "Create pull request effects must be draft.");
        }
        if (diagnostics.length > 0 || branch === undefined || baseBranch === undefined || rootIssue === undefined) {
            return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
        }
        return { valid: true, effect: { kind, branch, baseBranch, rootIssue, draft: true }, diagnostics: [] };
    }
    if (kind === "DELETE_BRANCH") {
        const allowed = new Set(["kind", "branch"]);
        rejectEffectProperties(input, allowed, path, diagnostics);
        const branch = requiredEffectBranch(input, "branch", path, MAX_CHANGE_BRANCH_LENGTH, diagnostics);
        if (diagnostics.length > 0 || branch === undefined) {
            return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
        }
        return { valid: true, effect: { kind, branch }, diagnostics: [] };
    }
    const allowed = new Set(["kind", "pullRequest"]);
    rejectEffectProperties(input, allowed, path, diagnostics);
    const pullRequest = requiredEffectNumber(input, "pullRequest", path, diagnostics);
    if (diagnostics.length > 0 || pullRequest === undefined) {
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    if (kind === "MARK_PULL_REQUEST_READY") {
        return { valid: true, effect: { kind, pullRequest }, diagnostics: [] };
    }
    return { valid: true, effect: { kind: "CLOSE_PULL_REQUEST", pullRequest }, diagnostics: [] };
}
function validateEffectList(input, path, diagnostics) {
    if (!Array.isArray(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Plan effects must be an array.");
        return [];
    }
    if (input.length > MAX_CHANGE_TRANSITION_EFFECTS) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, `At most ${MAX_CHANGE_TRANSITION_EFFECTS} transition effects are supported.`);
    }
    const effects = [];
    for (let index = 0; index < input.length && diagnostics.length < MAX_CHANGE_DIAGNOSTICS; index += 1) {
        const result = validateChangeEffect(input[index], `${path}[${index}]`);
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        if (result.effect !== undefined)
            effects.push(result.effect);
    }
    return effects;
}
function canonicalPlanEquals(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
/** Validate and canonicalize a previously generated or transported plan. */
export function validateChangeTransitionPlan(input) {
    const diagnostics = [];
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Change transition plan must be a JSON object.");
        return { valid: false, diagnostics };
    }
    addUnknownProperties(input, TRANSITION_PLAN_KEYS, "$", diagnostics);
    if (!hasOwn(input, "version")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.version", "Property is required.");
    }
    else if (input.version !== CHANGE_TRANSITION_CONTRACT_VERSION) {
        addDiagnostic(diagnostics, "CHANGE_UNSUPPORTED_VERSION", "$.version", "Change transition plan version is unsupported.");
    }
    let request;
    if (!hasOwn(input, "request")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.request", "Property is required.");
    }
    else {
        const result = validateChangeTransitionRequest(input.request);
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        request = result.request;
    }
    const from = requiredPlanState(input, "from", diagnostics);
    const to = requiredPlanState(input, "to", diagnostics);
    let resultChange;
    if (!hasOwn(input, "result")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.result", "Property is required.");
    }
    else {
        const result = validateChange(input.result);
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        resultChange = result.change;
    }
    let effects = [];
    if (!hasOwn(input, "effects")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.effects", "Property is required.");
    }
    else {
        effects = validateEffectList(input.effects, "$.effects", diagnostics);
    }
    if (diagnostics.length > 0 ||
        request === undefined ||
        from === undefined ||
        to === undefined ||
        resultChange === undefined) {
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    const expected = buildChangeTransitionPlan(request);
    if (from !== expected.from) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.from", "Plan source state does not match its request.");
    }
    if (to !== expected.to) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.to", "Plan target state does not match its request.");
    }
    if (!canonicalPlanEquals(resultChange, expected.result)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.result", "Plan result does not match its transition.");
    }
    if (!canonicalPlanEquals(effects, expected.effects)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.effects", "Plan effects do not match its transition.");
    }
    if (diagnostics.length > 0) {
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    return { valid: true, plan: expected, diagnostics: [] };
}
export const validateChangePlan = validateChangeTransitionPlan;
/** Assert a valid declarative plan at an executor boundary. */
export function assertChangeTransitionPlan(input) {
    const result = validateChangeTransitionPlan(input);
    if (!result.valid)
        throw new ChangeTransitionValidationError(result.diagnostics);
}
export class ChangeTransitionValidationError extends ChangeValidationError {
    constructor(diagnostics) {
        super(diagnostics);
        this.name = "ChangeTransitionValidationError";
    }
}
/** Serialize the canonical transition request with stable property ordering. */
export function serializeChangeTransitionRequest(input) {
    const result = validateChangeTransitionRequest(input);
    if (!result.valid || result.request === undefined)
        throw new ChangeTransitionValidationError(result.diagnostics);
    const serialized = JSON.stringify(result.request);
    if (serialized === undefined)
        throw new Error("Change transition request could not be serialized.");
    return serialized;
}
/** Parse and validate an untrusted transition request JSON boundary. */
export function deserializeChangeTransitionRequest(serialized) {
    let parsed;
    try {
        parsed = JSON.parse(serialized);
    }
    catch (error) {
        throw new ChangeTransitionValidationError([
            createChangeDiagnostic({
                code: "CHANGE_INVALID_JSON",
                message: safeMessage(`Change transition request must be valid JSON: ${error instanceof Error ? error.message : String(error)}`),
            }),
        ]);
    }
    const result = validateChangeTransitionRequest(parsed);
    if (!result.valid || result.request === undefined)
        throw new ChangeTransitionValidationError(result.diagnostics);
    return result.request;
}
/** Serialize the canonical effect plan with stable property ordering. */
export function serializeChangeTransitionPlan(input) {
    const result = validateChangeTransitionPlan(input);
    if (!result.valid || result.plan === undefined)
        throw new ChangeTransitionValidationError(result.diagnostics);
    const serialized = JSON.stringify(result.plan);
    if (serialized === undefined)
        throw new Error("Change transition plan could not be serialized.");
    return serialized;
}
/** Parse and validate an untrusted effect plan JSON boundary. */
export function deserializeChangeTransitionPlan(serialized) {
    let parsed;
    try {
        parsed = JSON.parse(serialized);
    }
    catch (error) {
        throw new ChangeTransitionValidationError([
            createChangeDiagnostic({
                code: "CHANGE_INVALID_JSON",
                message: safeMessage(`Change transition plan must be valid JSON: ${error instanceof Error ? error.message : String(error)}`),
            }),
        ]);
    }
    const result = validateChangeTransitionPlan(parsed);
    if (!result.valid || result.plan === undefined)
        throw new ChangeTransitionValidationError(result.diagnostics);
    return result.plan;
}
export function isChangeTransitionRequest(input) {
    return validateChangeTransitionRequest(input).valid;
}
export function isChangeTransitionPlan(input) {
    return validateChangeTransitionPlan(input).valid;
}
export const parseChangeTransitionRequest = deserializeChangeTransitionRequest;
export const parseChangeTransitionPlan = deserializeChangeTransitionPlan;
export const serializeChangeTransitionRequestContract = serializeChangeTransitionRequest;
export const serializeChangeTransitionPlanContract = serializeChangeTransitionPlan;
function isChangeIssuanceHealthyState(value) {
    return value === "DRAFT" || value === "REVIEW" || value === "ACCEPTED" || value === "MERGED" || value === "ABORTED";
}
function issuancePlanText(value, path, label, maxLength, diagnostics) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > maxLength ||
        /[\u0000-\u001F\u007F]/u.test(value)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, `${label} is invalid.`);
        return undefined;
    }
    return value;
}
function validateChangeIssuanceTransaction(input, path, diagnostics) {
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Issuance transaction must be an object.");
        return undefined;
    }
    addUnknownProperties(input, CHANGE_ISSUANCE_TRANSACTION_KEYS, path, diagnostics);
    if (input.operation !== "issue") {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.operation`, "Issuance operation must be issue.");
    }
    let identity;
    if (!hasOwn(input, "identity")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", `${path}.identity`, "Property is required.");
    }
    else {
        const result = validateChangeIdentity(input.identity, `${path}.identity`);
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        identity = result.identity;
    }
    const idempotencyKey = issuancePlanText(input.idempotencyKey, `${path}.idempotencyKey`, "Idempotency key", MAX_CHANGE_IDEMPOTENCY_KEY_LENGTH, diagnostics);
    if (diagnostics.length > 0 || identity === undefined || idempotencyKey === undefined)
        return undefined;
    return { operation: "issue", identity, idempotencyKey };
}
function validateChangeIssuanceVerification(input, path, diagnostics) {
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Issuance verification expectation must be an object.");
        return undefined;
    }
    addUnknownProperties(input, CHANGE_ISSUANCE_VERIFICATION_KEYS, path, diagnostics);
    if (input.phase !== "post-effect") {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.phase`, "Verification phase must be post-effect.");
    }
    if (input.status !== "healthy") {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.status`, "Verification status must be healthy.");
    }
    const canonicalBranch = issuancePlanText(input.canonicalBranch, `${path}.canonicalBranch`, "Canonical branch", MAX_CHANGE_BRANCH_LENGTH, diagnostics);
    const canonicalBaseBranch = issuancePlanText(input.canonicalBaseBranch, `${path}.canonicalBaseBranch`, "Canonical base branch", MAX_CHANGE_BASE_BRANCH_LENGTH, diagnostics);
    let state;
    if (!isChangeIssuanceHealthyState(input.state)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.state`, "Verification state is not healthy.");
    }
    else {
        state = input.state;
    }
    let pullRequestNumber;
    if (!hasOwn(input, "pullRequest")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", `${path}.pullRequest`, "Property is required.");
    }
    else if (!isRecord(input.pullRequest)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.pullRequest`, "Pull-request expectation must be an object.");
    }
    else {
        addUnknownProperties(input.pullRequest, CHANGE_ISSUANCE_PULL_REQUEST_KEYS, `${path}.pullRequest`, diagnostics);
        if (input.pullRequest.required !== true) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.pullRequest.required`, "Pull-request expectation must require a canonical pull request.");
        }
        if (hasOwn(input.pullRequest, "number")) {
            if (typeof input.pullRequest.number !== "number" ||
                !Number.isSafeInteger(input.pullRequest.number) ||
                input.pullRequest.number < 1) {
                addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.pullRequest.number`, "Expected pull-request number must be a positive safe integer.");
            }
            else {
                pullRequestNumber = input.pullRequest.number;
            }
        }
    }
    if (diagnostics.length > 0 ||
        canonicalBranch === undefined ||
        canonicalBaseBranch === undefined ||
        state === undefined) {
        return undefined;
    }
    return {
        phase: "post-effect",
        status: "healthy",
        canonicalBranch,
        canonicalBaseBranch,
        state,
        pullRequest: {
            required: true,
            ...(pullRequestNumber === undefined ? {} : { number: pullRequestNumber }),
        },
    };
}
function buildChangeIssuanceVerification(result, canonicalBranch, canonicalBaseBranch) {
    if (!isChangeIssuanceHealthyState(result.state)) {
        throw new Error("Issuance verification requires a healthy Change state.");
    }
    const pullRequest = result.projection?.pullRequest;
    return {
        phase: "post-effect",
        status: "healthy",
        canonicalBranch,
        canonicalBaseBranch,
        state: result.state,
        pullRequest: {
            required: true,
            ...(pullRequest === undefined ? {} : { number: pullRequest }),
        },
    };
}
function buildChangeIssuancePlan(projection) {
    if ((projection.status !== "absent" && projection.status !== "healthy") ||
        !projection.valid ||
        projection.change === undefined ||
        projection.canonicalBranch === undefined ||
        projection.canonicalBaseBranch === undefined) {
        throw new Error("A valid absent or healthy Change projection is required for issuance planning.");
    }
    const sourceStatus = projection.status;
    const transactionIdentity = projection.change.identity;
    const transaction = {
        operation: "issue",
        identity: transactionIdentity,
        idempotencyKey: changeIdentityKey(transactionIdentity),
    };
    if (sourceStatus === "absent") {
        const transitionPlan = planChangeTransition({
            version: CHANGE_TRANSITION_CONTRACT_VERSION,
            transition: "issue",
            change: projection.change,
            target: {
                branch: projection.canonicalBranch,
                baseBranch: projection.canonicalBaseBranch,
            },
        });
        return {
            version: CHANGE_TRANSITION_CONTRACT_VERSION,
            operation: "issue",
            mode: "create",
            sourceStatus,
            transaction,
            result: transitionPlan.result,
            effects: transitionPlan.effects,
            verification: buildChangeIssuanceVerification(transitionPlan.result, projection.canonicalBranch, projection.canonicalBaseBranch),
        };
    }
    return {
        version: CHANGE_TRANSITION_CONTRACT_VERSION,
        operation: "issue",
        mode: "return-existing",
        sourceStatus,
        transaction,
        result: projection.change,
        effects: [],
        verification: buildChangeIssuanceVerification(projection.change, projection.canonicalBranch, projection.canonicalBaseBranch),
    };
}
function issuanceFailureDiagnostics(projection) {
    if (projection.diagnostics.length > 0)
        return projection.diagnostics;
    if (projection.status === "absent" && projection.change === undefined) {
        return [
            createChangeDiagnostic({
                code: "CHANGE_ISSUANCE_ROOT_ISSUE_ABSENT",
                path: "$.evidence.issue",
                message: "Change issuance requires confirmed root Issue evidence.",
            }),
        ];
    }
    return [
        createChangeDiagnostic({
            code: "CHANGE_INVALID_PLAN",
            path: "$.projection",
            message: "Change projection cannot produce an issuance plan.",
        }),
    ];
}
/**
 * Plan idempotent Change issuance from the canonical #213 projection.
 * This function is pure: it does not invoke GitHub, Actions, an App, a CLI,
 * credentials, or any effect executor.
 */
export function planChangeIssuance(input) {
    const projection = projectChangeFromGitHubEvidence(input);
    if (!projection.valid ||
        (projection.status !== "absent" && projection.status !== "healthy") ||
        projection.change === undefined ||
        projection.canonicalBranch === undefined ||
        projection.canonicalBaseBranch === undefined) {
        throw new ChangeIssuanceValidationError(issuanceFailureDiagnostics(projection));
    }
    const plan = buildChangeIssuancePlan(projection);
    const result = validateChangeIssuancePlan(plan);
    if (!result.valid || result.plan === undefined)
        throw new ChangeIssuanceValidationError(result.diagnostics);
    return result.plan;
}
export const createChangeIssuancePlan = planChangeIssuance;
export const planIdempotentChangeIssuance = planChangeIssuance;
/** Validate and canonicalize a transport-independent issuance plan. */
export function validateChangeIssuancePlan(input) {
    const diagnostics = [];
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Change issuance plan must be a JSON object.");
        return { valid: false, diagnostics };
    }
    addUnknownProperties(input, CHANGE_ISSUANCE_PLAN_KEYS, "$", diagnostics);
    if (!hasOwn(input, "version")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.version", "Property is required.");
    }
    else if (input.version !== CHANGE_TRANSITION_CONTRACT_VERSION) {
        addDiagnostic(diagnostics, "CHANGE_UNSUPPORTED_VERSION", "$.version", "Change issuance plan version is unsupported.");
    }
    if (input.operation !== "issue") {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.operation", "Issuance operation must be issue.");
    }
    let mode;
    if (!hasOwn(input, "mode")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.mode", "Property is required.");
    }
    else if (!CHANGE_ISSUANCE_MODES.includes(input.mode)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.mode", "Issuance mode is unsupported.");
    }
    else {
        mode = input.mode;
    }
    let sourceStatus;
    if (!hasOwn(input, "sourceStatus")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.sourceStatus", "Property is required.");
    }
    else if (!CHANGE_ISSUANCE_SOURCE_STATUSES.includes(input.sourceStatus)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.sourceStatus", "Issuance source status is unsupported.");
    }
    else {
        sourceStatus = input.sourceStatus;
    }
    let transaction;
    if (!hasOwn(input, "transaction")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.transaction", "Property is required.");
    }
    else {
        transaction = validateChangeIssuanceTransaction(input.transaction, "$.transaction", diagnostics);
    }
    let resultChange;
    if (!hasOwn(input, "result")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.result", "Property is required.");
    }
    else {
        const result = validateChange(input.result);
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        resultChange = result.change;
    }
    let effects = [];
    if (!hasOwn(input, "effects")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.effects", "Property is required.");
    }
    else {
        effects = validateEffectList(input.effects, "$.effects", diagnostics);
    }
    let verification;
    if (!hasOwn(input, "verification")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.verification", "Property is required.");
    }
    else {
        verification = validateChangeIssuanceVerification(input.verification, "$.verification", diagnostics);
    }
    if (diagnostics.length > 0 ||
        mode === undefined ||
        sourceStatus === undefined ||
        transaction === undefined ||
        resultChange === undefined ||
        verification === undefined) {
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    const expectedIdempotencyKey = changeIdentityKey(resultChange.identity);
    if (!canonicalPlanEquals(transaction.identity, resultChange.identity)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.transaction.identity", "Transaction identity must match the result.");
    }
    if (transaction.idempotencyKey !== expectedIdempotencyKey) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.transaction.idempotencyKey", "Idempotency key must be derived from the Change identity.");
    }
    if ((mode === "create" && sourceStatus !== "absent") || (mode === "return-existing" && sourceStatus !== "healthy")) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.sourceStatus", "Issuance mode does not match source status.");
    }
    if (verification.state !== resultChange.state) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.verification.state", "Verification state must match the result.");
    }
    if (verification.canonicalBranch !== resultChange.projection?.branch) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.verification.canonicalBranch", "Verification branch must match the result projection.");
    }
    if (mode === "create") {
        if (resultChange.state !== "DRAFT" || resultChange.projection?.pullRequest !== undefined) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.result", "A create issuance result must be a Draft Change without a preassigned pull request.");
        }
        if (verification.pullRequest.number !== undefined) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.verification.pullRequest.number", "A create issuance plan cannot preassign a pull-request number.");
        }
        const definedChange = {
            version: CHANGE_CONTRACT_VERSION,
            identity: resultChange.identity,
            state: "DEFINED",
            provenance: resultChange.provenance,
        };
        let expectedTransition;
        try {
            expectedTransition = planChangeTransition({
                version: CHANGE_TRANSITION_CONTRACT_VERSION,
                transition: "issue",
                change: definedChange,
                target: {
                    branch: verification.canonicalBranch,
                    baseBranch: verification.canonicalBaseBranch,
                },
            });
        }
        catch (error) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.result", `Create issuance transition is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (expectedTransition !== undefined) {
            if (!canonicalPlanEquals(resultChange, expectedTransition.result)) {
                addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.result", "Create result does not match the issue transition.");
            }
            if (!canonicalPlanEquals(effects, expectedTransition.effects)) {
                addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.effects", "Create effects do not match the issue transition.");
            }
        }
    }
    else {
        if (!isChangeIssuanceHealthyState(resultChange.state) || resultChange.projection?.pullRequest === undefined) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.result", "A return-existing result must be a healthy canonical Change.");
        }
        if (verification.pullRequest.number !== resultChange.projection?.pullRequest) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.verification.pullRequest.number", "Existing verification must identify the returned canonical pull request.");
        }
        if (effects.length !== 0) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.effects", "Return-existing issuance must have no effects.");
        }
    }
    if (diagnostics.length > 0) {
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    return {
        valid: true,
        plan: {
            version: CHANGE_TRANSITION_CONTRACT_VERSION,
            operation: "issue",
            mode,
            sourceStatus,
            transaction: {
                operation: "issue",
                identity: resultChange.identity,
                idempotencyKey: expectedIdempotencyKey,
            },
            result: resultChange,
            effects,
            verification,
        },
        diagnostics: [],
    };
}
/** Assert a valid declarative issuance plan at an executor boundary. */
export function assertChangeIssuancePlan(input) {
    const result = validateChangeIssuancePlan(input);
    if (!result.valid)
        throw new ChangeIssuanceValidationError(result.diagnostics);
}
export function isChangeIssuancePlan(input) {
    return validateChangeIssuancePlan(input).valid;
}
/** Serialize a canonical issuance plan with stable property ordering. */
export function serializeChangeIssuancePlan(input) {
    const result = validateChangeIssuancePlan(input);
    if (!result.valid || result.plan === undefined)
        throw new ChangeIssuanceValidationError(result.diagnostics);
    const serialized = JSON.stringify(result.plan);
    if (serialized === undefined)
        throw new Error("Change issuance plan could not be serialized.");
    return serialized;
}
/** Parse and validate an untrusted issuance plan JSON boundary. */
export function deserializeChangeIssuancePlan(serialized) {
    let parsed;
    try {
        parsed = JSON.parse(serialized);
    }
    catch (error) {
        throw new ChangeIssuanceValidationError([
            createChangeDiagnostic({
                code: "CHANGE_INVALID_JSON",
                message: safeMessage(`Change issuance plan must be valid JSON: ${error instanceof Error ? error.message : String(error)}`),
            }),
        ]);
    }
    const result = validateChangeIssuancePlan(parsed);
    if (!result.valid || result.plan === undefined)
        throw new ChangeIssuanceValidationError(result.diagnostics);
    return result.plan;
}
export const parseChangeIssuancePlan = deserializeChangeIssuancePlan;
export const serializeChangeIssuancePlanContract = serializeChangeIssuancePlan;
export class ChangeIssuanceValidationError extends ChangeValidationError {
    constructor(diagnostics) {
        super(diagnostics);
        this.name = "ChangeIssuanceValidationError";
    }
}
function validateChangeIssuanceEffectAttempts(input, path, diagnostics) {
    if (!Array.isArray(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Attempted effects must be an array.");
        return [];
    }
    if (input.length > MAX_CHANGE_ISSUANCE_ATTEMPTS) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, `At most ${MAX_CHANGE_ISSUANCE_ATTEMPTS} attempted effects are supported.`);
    }
    const attempts = [];
    for (let index = 0; index < input.length && diagnostics.length < MAX_CHANGE_DIAGNOSTICS; index += 1) {
        const attempt = input[index];
        const before = diagnostics.length;
        if (!isRecord(attempt)) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}[${index}]`, "Effect attempt must be an object.");
            continue;
        }
        addUnknownProperties(attempt, CHANGE_ISSUANCE_ATTEMPT_KEYS, `${path}[${index}]`, diagnostics);
        const effectResult = validateChangeEffect(attempt.effect, `${path}[${index}].effect`);
        diagnostics.push(...effectResult.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        if (!CHANGE_ISSUANCE_EFFECT_STATUSES.includes(attempt.status)) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}[${index}].status`, "Effect attempt status is unsupported.");
        }
        if (diagnostics.length === before &&
            effectResult.effect !== undefined &&
            CHANGE_ISSUANCE_EFFECT_STATUSES.includes(attempt.status)) {
            attempts.push({ effect: effectResult.effect, status: attempt.status });
        }
    }
    return attempts;
}
function validateChangeIssuanceFailureEvidence(input, path, diagnostics) {
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Failure evidence must be an object.");
        return undefined;
    }
    addUnknownProperties(input, CHANGE_ISSUANCE_FAILURE_KEYS, path, diagnostics);
    const effectResult = validateChangeEffect(input.effect, `${path}.effect`);
    diagnostics.push(...effectResult.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
    const code = issuancePlanText(input.code, `${path}.code`, "Failure code", MAX_CHANGE_FAILURE_CODE_LENGTH, diagnostics);
    const message = issuancePlanText(input.message, `${path}.message`, "Failure message", MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH, diagnostics);
    if (diagnostics.length > 0 || effectResult.effect === undefined || code === undefined || message === undefined) {
        return undefined;
    }
    return { effect: effectResult.effect, code, message };
}
function validateChangeProjectionCandidateBranch(input, path, diagnostics) {
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Branch projection candidate must be an object.");
        return undefined;
    }
    addUnknownProperties(input, CHANGE_PROJECTION_CANDIDATE_KEYS, path, diagnostics);
    const candidateDiagnostics = [];
    const candidate = parseChangeBranchEvidence(input.candidate, `${path}.candidate`, candidateDiagnostics);
    diagnostics.push(...candidateDiagnostics);
    const classification = input.classification;
    if (typeof classification !== "string" ||
        !CHANGE_PROJECTION_CANDIDATE_CLASSES.includes(classification)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.classification`, "Projection candidate classification is invalid.");
    }
    const reason = issuancePlanText(input.reason, `${path}.reason`, "Projection candidate reason", MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH, diagnostics);
    if (candidate === undefined ||
        reason === undefined ||
        typeof classification !== "string" ||
        !CHANGE_PROJECTION_CANDIDATE_CLASSES.includes(classification)) {
        return undefined;
    }
    return {
        candidate,
        classification: classification,
        reason,
    };
}
function validateChangeProjectionCandidatePullRequest(input, path, diagnostics) {
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Pull-request projection candidate must be an object.");
        return undefined;
    }
    addUnknownProperties(input, CHANGE_PROJECTION_CANDIDATE_KEYS, path, diagnostics);
    const candidateDiagnostics = [];
    const candidate = parseChangePullRequestEvidence(input.candidate, `${path}.candidate`, candidateDiagnostics);
    diagnostics.push(...candidateDiagnostics);
    const classification = input.classification;
    if (typeof classification !== "string" ||
        !CHANGE_PROJECTION_CANDIDATE_CLASSES.includes(classification)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.classification`, "Projection candidate classification is invalid.");
    }
    const reason = issuancePlanText(input.reason, `${path}.reason`, "Projection candidate reason", MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH, diagnostics);
    if (candidate === undefined ||
        reason === undefined ||
        typeof classification !== "string" ||
        !CHANGE_PROJECTION_CANDIDATE_CLASSES.includes(classification)) {
        return undefined;
    }
    return {
        candidate,
        classification: classification,
        reason,
    };
}
function validateChangeProjectionResult(input, path, diagnostics) {
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Projection evidence must be an object.");
        return undefined;
    }
    addUnknownProperties(input, CHANGE_PROJECTION_RESULT_KEYS, path, diagnostics);
    if (typeof input.valid !== "boolean") {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.valid`, "Projection evidence validity is invalid.");
    }
    if (typeof input.status !== "string" ||
        !CHANGE_PROJECTION_STATUSES.includes(input.status)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.status`, "Projection evidence status is invalid.");
    }
    let canonicalBranch;
    if (hasOwn(input, "canonicalBranch")) {
        canonicalBranch = issuancePlanText(input.canonicalBranch, `${path}.canonicalBranch`, "Canonical branch", MAX_CHANGE_BRANCH_LENGTH, diagnostics);
    }
    let canonicalBaseBranch;
    if (hasOwn(input, "canonicalBaseBranch")) {
        canonicalBaseBranch = issuancePlanText(input.canonicalBaseBranch, `${path}.canonicalBaseBranch`, "Canonical base branch", MAX_CHANGE_BASE_BRANCH_LENGTH, diagnostics);
    }
    const candidatesValue = input.candidates;
    let branches = [];
    let pullRequests = [];
    if (!isRecord(candidatesValue)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.candidates`, "Projection candidates must be an object.");
    }
    else {
        addUnknownProperties(candidatesValue, CHANGE_PROJECTION_CANDIDATES_KEYS, `${path}.candidates`, diagnostics);
        if (!Array.isArray(candidatesValue.branches)) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.candidates.branches`, "Branch candidates must be an array.");
        }
        else if (candidatesValue.branches.length > MAX_CHANGE_PROJECTION_CANDIDATES) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.candidates.branches`, `At most ${MAX_CHANGE_PROJECTION_CANDIDATES} branch candidates are supported.`);
        }
        else {
            for (let index = 0; index < candidatesValue.branches.length; index += 1) {
                const candidate = validateChangeProjectionCandidateBranch(candidatesValue.branches[index], `${path}.candidates.branches[${index}]`, diagnostics);
                if (candidate !== undefined)
                    branches.push(candidate);
            }
        }
        if (!Array.isArray(candidatesValue.pullRequests)) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.candidates.pullRequests`, "Pull-request candidates must be an array.");
        }
        else if (candidatesValue.pullRequests.length > MAX_CHANGE_PROJECTION_CANDIDATES) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.candidates.pullRequests`, `At most ${MAX_CHANGE_PROJECTION_CANDIDATES} pull-request candidates are supported.`);
        }
        else {
            for (let index = 0; index < candidatesValue.pullRequests.length; index += 1) {
                const candidate = validateChangeProjectionCandidatePullRequest(candidatesValue.pullRequests[index], `${path}.candidates.pullRequests[${index}]`, diagnostics);
                if (candidate !== undefined)
                    pullRequests.push(candidate);
            }
        }
    }
    let change;
    if (hasOwn(input, "change")) {
        const result = validateChange(input.change);
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        change = result.change;
    }
    let projectionDiagnostics = [];
    if (!Array.isArray(input.diagnostics) || input.diagnostics.length > MAX_CHANGE_DIAGNOSTICS) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.diagnostics`, "Projection diagnostics are invalid.");
    }
    else if (!input.diagnostics.every(isDiagnostic)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.diagnostics`, "Projection diagnostics are invalid.");
    }
    else {
        try {
            projectionDiagnostics = createChangeDiagnosticReport(input.diagnostics).diagnostics;
        }
        catch {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.diagnostics`, "Projection diagnostics exceed their bounds.");
        }
    }
    branches = branches.sort((left, right) => compareText(left.candidate.name, right.candidate.name) ||
        compareText(left.classification, right.classification) ||
        compareText(left.reason, right.reason));
    pullRequests = pullRequests.sort((left, right) => compareChangePullRequestEvidence(left.candidate, right.candidate) ||
        compareText(left.classification, right.classification) ||
        compareText(left.reason, right.reason));
    if (typeof input.valid === "boolean" && typeof input.status === "string") {
        const status = input.status;
        if (CHANGE_PROJECTION_STATUSES.includes(status) && input.valid !== (status === "healthy" || status === "absent")) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.valid`, "Projection validity does not match its status.");
        }
    }
    if (diagnostics.length > 0 ||
        typeof input.valid !== "boolean" ||
        typeof input.status !== "string" ||
        !CHANGE_PROJECTION_STATUSES.includes(input.status) ||
        !Array.isArray(input.diagnostics)) {
        return undefined;
    }
    return {
        valid: input.valid,
        status: input.status,
        ...(canonicalBranch === undefined ? {} : { canonicalBranch }),
        ...(canonicalBaseBranch === undefined ? {} : { canonicalBaseBranch }),
        candidates: { branches, pullRequests },
        ...(change === undefined ? {} : { change }),
        diagnostics: projectionDiagnostics,
    };
}
function validateChangeIssuanceFailureRecord(input, path, diagnostics) {
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Issuance failure evidence must be an object.");
        return undefined;
    }
    addUnknownProperties(input, CHANGE_ISSUANCE_FAILURE_RECORD_KEYS, path, diagnostics);
    const attemptedEffects = validateChangeIssuanceEffectAttempts(input.attemptedEffects, `${path}.attemptedEffects`, diagnostics);
    const failure = validateChangeIssuanceFailureEvidence(input.failure, `${path}.failure`, diagnostics);
    let projection;
    if (!hasOwn(input, "projection")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", `${path}.projection`, "Property is required.");
    }
    else {
        projection = validateChangeProjectionResult(input.projection, `${path}.projection`, diagnostics);
    }
    if (diagnostics.length > 0 || failure === undefined || projection === undefined)
        return undefined;
    return { attemptedEffects, failure, projection };
}
function validateChangeIssuanceCompensationVerification(input, path, diagnostics) {
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Compensation verification expectation must be an object.");
        return undefined;
    }
    addUnknownProperties(input, CHANGE_ISSUANCE_COMPENSATION_VERIFICATION_KEYS, path, diagnostics);
    if (input.phase !== "post-compensation") {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.phase`, "Compensation verification phase is invalid.");
    }
    if (input.status !== "absent") {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.status`, "Compensation verification must prove absence.");
    }
    const canonicalBranch = issuancePlanText(input.canonicalBranch, `${path}.canonicalBranch`, "Canonical branch", MAX_CHANGE_BRANCH_LENGTH, diagnostics);
    const canonicalBaseBranch = issuancePlanText(input.canonicalBaseBranch, `${path}.canonicalBaseBranch`, "Canonical base branch", MAX_CHANGE_BASE_BRANCH_LENGTH, diagnostics);
    if (input.state !== "DEFINED") {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.state`, "Compensation verification state must be DEFINED.");
    }
    if (!isRecord(input.pullRequest)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.pullRequest`, "Pull-request verification must be an object.");
    }
    else {
        const allowed = new Set(["required"]);
        rejectEffectProperties(input.pullRequest, allowed, `${path}.pullRequest`, diagnostics);
        if (input.pullRequest.required !== false) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.pullRequest.required`, "Compensation verification must not require a pull request.");
        }
    }
    if (diagnostics.length > 0 || canonicalBranch === undefined || canonicalBaseBranch === undefined)
        return undefined;
    return {
        phase: "post-compensation",
        status: "absent",
        canonicalBranch,
        canonicalBaseBranch,
        state: "DEFINED",
        pullRequest: { required: false },
    };
}
function sameChangeIdentity(left, right) {
    return canonicalPlanEquals(left, right);
}
function sameEffect(left, right) {
    return canonicalPlanEquals(left, right);
}
function sameFailureEvidence(left, right) {
    return canonicalPlanEquals(left, right);
}
function addRecoverySemanticDiagnostic(diagnostics, path, message) {
    addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, message);
}
function validateCreateIssuanceFailureSemantics(issuance, attemptedEffects, failure, diagnostics) {
    if (issuance.mode !== "create" || issuance.sourceStatus !== "absent") {
        addRecoverySemanticDiagnostic(diagnostics, "$.issuance", "Compensation is only valid for a create issuance from an absent Change.");
    }
    if (issuance.effects.length !== 2) {
        addRecoverySemanticDiagnostic(diagnostics, "$.issuance.effects", "A compensable issuance must contain the ordered branch and Draft pull-request effects.");
        return;
    }
    if (attemptedEffects.length !== 2) {
        addRecoverySemanticDiagnostic(diagnostics, "$.failureEvidence.attemptedEffects", "A compensable issuance must record both ordered effect attempts.");
    }
    else {
        const [branchAttempt, pullRequestAttempt] = attemptedEffects;
        if (!sameEffect(branchAttempt.effect, issuance.effects[0]) || branchAttempt.status !== "succeeded") {
            addRecoverySemanticDiagnostic(diagnostics, "$.failureEvidence.attemptedEffects[0]", "Canonical branch creation must be the first successful attempted effect.");
        }
        if (!sameEffect(pullRequestAttempt.effect, issuance.effects[1]) || pullRequestAttempt.status !== "failed") {
            addRecoverySemanticDiagnostic(diagnostics, "$.failureEvidence.attemptedEffects[1]", "Canonical Draft pull-request creation must be the failed second effect.");
        }
    }
    if (!sameEffect(failure.effect, issuance.effects[1])) {
        addRecoverySemanticDiagnostic(diagnostics, "$.failureEvidence.failure.effect", "Failure evidence must identify the canonical Draft pull-request effect.");
    }
}
function validateFailureProjectionIdentity(issuance, projection, path, diagnostics) {
    const expectedBranch = issuance.verification.canonicalBranch;
    const expectedBaseBranch = issuance.verification.canonicalBaseBranch;
    if (projection.canonicalBranch !== expectedBranch) {
        addRecoverySemanticDiagnostic(diagnostics, `${path}.canonicalBranch`, "Projection evidence branch does not match issuance.");
    }
    if (projection.canonicalBaseBranch !== expectedBaseBranch) {
        addRecoverySemanticDiagnostic(diagnostics, `${path}.canonicalBaseBranch`, "Projection evidence base branch does not match issuance.");
    }
    if (projection.change !== undefined &&
        !sameChangeIdentity(projection.change.identity, issuance.transaction.identity)) {
        addRecoverySemanticDiagnostic(diagnostics, `${path}.change.identity`, "Projection evidence identity does not match issuance.");
    }
}
function validateCompensationPlanEffects(effects, expectedBranch, path, diagnostics) {
    if (effects.length !== 1 || effects[0]?.kind !== "DELETE_BRANCH" || effects[0].branch !== expectedBranch) {
        addRecoverySemanticDiagnostic(diagnostics, path, "Compensation must contain exactly one delete effect for the canonical branch.");
    }
}
function validateFailureProjectionShape(projection, expectedBranch, expectedBaseBranch, rootIssue, path, diagnostics) {
    if (projection.status !== "partial") {
        addRecoverySemanticDiagnostic(diagnostics, path, "Branch compensation requires a confirmed partial branch-only projection.");
    }
    if (projection.change?.state !== "RECOVERY_REQUIRED") {
        addRecoverySemanticDiagnostic(diagnostics, `${path}.change.state`, "A branch-only failed issuance must be represented as RECOVERY_REQUIRED before compensation.");
    }
    if (projection.change?.projection?.branch !== expectedBranch ||
        projection.change?.projection?.pullRequest !== undefined) {
        addRecoverySemanticDiagnostic(diagnostics, `${path}.change.projection`, "Failure projection must retain only the canonical branch and no pull request.");
    }
    if (projection.candidates.branches.filter((candidate) => candidate.candidate.name === expectedBranch).length !== 1) {
        addRecoverySemanticDiagnostic(diagnostics, `${path}.candidates.branches`, "Failure projection must contain exactly one canonical branch candidate.");
    }
    if (projection.candidates.pullRequests.some((candidate) => candidate.classification === "canonical")) {
        addRecoverySemanticDiagnostic(diagnostics, `${path}.candidates.pullRequests`, "Failure projection must not contain a canonical pull request.");
    }
    if (projection.candidates.branches.some((candidate) => candidate.classification === "conflicting")) {
        addRecoverySemanticDiagnostic(diagnostics, `${path}.candidates.branches`, "Conflicting branch evidence cannot be compensated automatically.");
    }
    if (projection.candidates.pullRequests.some((candidate) => candidate.classification === "conflicting")) {
        addRecoverySemanticDiagnostic(diagnostics, `${path}.candidates.pullRequests`, "Conflicting pull-request evidence cannot be compensated automatically.");
    }
    const plausibleNoncanonicalPullRequests = projection.candidates.pullRequests.filter((candidate) => candidate.candidate.rootIssue === rootIssue && candidate.candidate.head !== expectedBranch);
    if (plausibleNoncanonicalPullRequests.length > 1) {
        addRecoverySemanticDiagnostic(diagnostics, `${path}.candidates.pullRequests`, "Multiple plausible noncanonical pull requests make compensation ambiguous.");
    }
    if (projection.canonicalBranch !== expectedBranch || projection.canonicalBaseBranch !== expectedBaseBranch) {
        addRecoverySemanticDiagnostic(diagnostics, path, "Failure projection canonical identities do not match issuance.");
    }
}
function projectionInputSource(input, key) {
    if (!isRecord(input) || !isRecord(input.evidence))
        return undefined;
    const source = input.evidence[key];
    return isRecord(source) ? source : undefined;
}
function projectionInputSourceIsAvailable(input, key) {
    return projectionInputSource(input, key)?.status === "available";
}
function projectionInputSourceIsConfirmedEmpty(input, key) {
    const source = projectionInputSource(input, key);
    if (source === undefined || source.status === "absent")
        return source !== undefined;
    return source.status === "available" && Array.isArray(source.value) && source.value.length === 0;
}
function projectionInputIssueIsOpen(input) {
    const source = projectionInputSource(input, "issue");
    return source?.status === "available" && isRecord(source.value) && source.value.state === "open";
}
function validateSafeFailureProjection(projectionInput, projection, issuance, path, diagnostics) {
    const before = diagnostics.length;
    validateFailureProjectionShape(projection, issuance.verification.canonicalBranch, issuance.verification.canonicalBaseBranch, issuance.transaction.identity.rootIssue, path, diagnostics);
    if (!projectionInputIssueIsOpen(projectionInput)) {
        addRecoverySemanticDiagnostic(diagnostics, `${path}.evidence.issue`, "Failure evidence must confirm an open root Issue.");
    }
    for (const key of ["branches", "pullRequests"]) {
        if (!projectionInputSourceIsAvailable(projectionInput, key)) {
            addRecoverySemanticDiagnostic(diagnostics, `${path}.evidence.${key}`, "Compensation requires a complete available artifact read; unavailable or absent evidence is unsafe.");
        }
    }
    return diagnostics.length === before;
}
function validateSafeAbsentProjection(projectionInput, projection, issuance, path, diagnostics) {
    const before = diagnostics.length;
    if (projection.status !== "absent" || !projection.valid || projection.change?.state !== "DEFINED") {
        addRecoverySemanticDiagnostic(diagnostics, path, "Successful compensation requires a confirmed absent projection.");
    }
    if (projection.change?.projection !== undefined) {
        addRecoverySemanticDiagnostic(diagnostics, `${path}.change.projection`, "An absent projection cannot retain artifacts.");
    }
    if (projection.canonicalBranch !== issuance.verification.canonicalBranch) {
        addRecoverySemanticDiagnostic(diagnostics, `${path}.canonicalBranch`, "Compensation evidence branch does not match issuance.");
    }
    if (projection.canonicalBaseBranch !== issuance.verification.canonicalBaseBranch) {
        addRecoverySemanticDiagnostic(diagnostics, `${path}.canonicalBaseBranch`, "Compensation evidence base branch does not match issuance.");
    }
    if (!projectionInputIssueIsOpen(projectionInput)) {
        addRecoverySemanticDiagnostic(diagnostics, `${path}.evidence.issue`, "Compensation evidence must confirm an open root Issue.");
    }
    for (const key of ["branches", "pullRequests"]) {
        if (!projectionInputSourceIsConfirmedEmpty(projectionInput, key)) {
            addRecoverySemanticDiagnostic(diagnostics, `${path}.evidence.${key}`, "Successful compensation requires confirmed absence of every canonical artifact.");
        }
    }
    return diagnostics.length === before;
}
function parseChangeIssuanceRecoveryInput(input, diagnostics) {
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Issuance recovery input must be an object.");
        return undefined;
    }
    addUnknownProperties(input, CHANGE_ISSUANCE_RECOVERY_INPUT_KEYS, "$", diagnostics);
    let issuance;
    if (!hasOwn(input, "issuance")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.issuance", "Property is required.");
    }
    else {
        const result = validateChangeIssuancePlan(input.issuance);
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        issuance = result.plan;
    }
    const attemptedEffects = validateChangeIssuanceEffectAttempts(input.attemptedEffects, "$.attemptedEffects", diagnostics);
    const failure = validateChangeIssuanceFailureEvidence(input.failure, "$.failure", diagnostics);
    let projection;
    let projectionInput;
    if (!hasOwn(input, "projection")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.projection", "Property is required.");
        projectionInput = undefined;
    }
    else {
        projectionInput = input.projection;
        projection = projectChangeFromGitHubEvidence(projectionInput);
    }
    let compensation;
    if (hasOwn(input, "compensation")) {
        if (!isRecord(input.compensation)) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.compensation", "Compensation outcome must be an object.");
        }
        else {
            addUnknownProperties(input.compensation, CHANGE_ISSUANCE_COMPENSATION_OUTCOME_INPUT_KEYS, "$.compensation", diagnostics);
            const status = input.compensation.status;
            if (typeof status !== "string" ||
                !CHANGE_ISSUANCE_COMPENSATION_STATUSES.includes(status) ||
                status === "required") {
                addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.compensation.status", "Compensation outcome status is invalid.");
            }
            let compensationProjection;
            if (!hasOwn(input.compensation, "projection")) {
                addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.compensation.projection", "Property is required.");
            }
            else {
                compensationProjection = projectChangeFromGitHubEvidence(input.compensation.projection);
            }
            let compensationFailure;
            if (hasOwn(input.compensation, "failure")) {
                compensationFailure = validateChangeIssuanceFailureEvidence(input.compensation.failure, "$.compensation.failure", diagnostics);
            }
            if (status === "succeeded" && compensationFailure !== undefined) {
                addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.compensation.failure", "A successful compensation cannot contain failure evidence.");
            }
            if (status === "failed" && compensationFailure === undefined && !hasOwn(input.compensation, "failure")) {
                addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.compensation.failure", "A failed compensation must preserve failure evidence.");
            }
            if (compensationProjection !== undefined &&
                typeof status === "string" &&
                (status === "succeeded" || status === "failed")) {
                compensation = {
                    status,
                    projectionInput: input.compensation.projection,
                    projection: compensationProjection,
                    ...(compensationFailure === undefined ? {} : { failure: compensationFailure }),
                };
            }
        }
    }
    if (diagnostics.length > 0 ||
        issuance === undefined ||
        failure === undefined ||
        projection === undefined ||
        projectionInput === undefined) {
        return undefined;
    }
    validateFailureProjectionIdentity(issuance, projection, "$.projection", diagnostics);
    if (compensation !== undefined) {
        validateFailureProjectionIdentity(issuance, compensation.projection, "$.compensation.projection", diagnostics);
    }
    return { issuance, attemptedEffects, failure, projectionInput, projection, compensation };
}
function recoveryChangeFromProjection(issuance, projection) {
    const observed = projection.change?.projection;
    return {
        version: CHANGE_CONTRACT_VERSION,
        identity: issuance.transaction.identity,
        state: "RECOVERY_REQUIRED",
        provenance: projection.change?.provenance ?? issuance.result.provenance,
        ...(observed === undefined ? {} : { projection: observed }),
    };
}
function definedChangeAfterCompensation(issuance) {
    return {
        version: CHANGE_CONTRACT_VERSION,
        identity: issuance.transaction.identity,
        state: "DEFINED",
        provenance: issuance.result.provenance,
    };
}
function compensationVerification(issuance) {
    return {
        phase: "post-compensation",
        status: "absent",
        canonicalBranch: issuance.verification.canonicalBranch,
        canonicalBaseBranch: issuance.verification.canonicalBaseBranch,
        state: "DEFINED",
        pullRequest: { required: false },
    };
}
function buildChangeIssuanceCompensationPlan(parsed, diagnostics) {
    validateCreateIssuanceFailureSemantics(parsed.issuance, parsed.attemptedEffects, parsed.failure, diagnostics);
    validateSafeFailureProjection(parsed.projectionInput, parsed.projection, parsed.issuance, "$.projection", diagnostics);
    if (diagnostics.length > 0)
        return undefined;
    const plan = {
        version: CHANGE_TRANSITION_CONTRACT_VERSION,
        operation: "compensate-issue",
        transaction: parsed.issuance.transaction,
        issuance: parsed.issuance,
        failureEvidence: {
            attemptedEffects: parsed.attemptedEffects,
            failure: parsed.failure,
            projection: parsed.projection,
        },
        effects: [
            {
                kind: "DELETE_BRANCH",
                branch: parsed.issuance.verification.canonicalBranch,
            },
        ],
        verification: compensationVerification(parsed.issuance),
    };
    const result = validateChangeIssuanceCompensationPlan(plan);
    if (!result.valid || result.plan === undefined) {
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        return undefined;
    }
    return result.plan;
}
/** Validate and canonicalize an explicit branch-compensation plan. */
export function validateChangeIssuanceCompensationPlan(input) {
    const diagnostics = [];
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Change issuance compensation plan must be an object.");
        return { valid: false, diagnostics };
    }
    addUnknownProperties(input, CHANGE_ISSUANCE_COMPENSATION_PLAN_KEYS, "$", diagnostics);
    if (input.version !== CHANGE_TRANSITION_CONTRACT_VERSION) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.version", "Compensation plan version is unsupported.");
    }
    if (input.operation !== "compensate-issue") {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.operation", "Compensation plan operation is invalid.");
    }
    let transaction;
    if (!hasOwn(input, "transaction")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.transaction", "Property is required.");
    }
    else {
        transaction = validateChangeIssuanceTransaction(input.transaction, "$.transaction", diagnostics);
    }
    let issuance;
    if (!hasOwn(input, "issuance")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.issuance", "Property is required.");
    }
    else {
        const result = validateChangeIssuancePlan(input.issuance);
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        issuance = result.plan;
    }
    let failureEvidence;
    if (!hasOwn(input, "failureEvidence")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.failureEvidence", "Property is required.");
    }
    else {
        failureEvidence = validateChangeIssuanceFailureRecord(input.failureEvidence, "$.failureEvidence", diagnostics);
    }
    let effects = [];
    if (!hasOwn(input, "effects")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.effects", "Property is required.");
    }
    else {
        effects = validateEffectList(input.effects, "$.effects", diagnostics);
    }
    let verification;
    if (!hasOwn(input, "verification")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.verification", "Property is required.");
    }
    else {
        verification = validateChangeIssuanceCompensationVerification(input.verification, "$.verification", diagnostics);
    }
    if (diagnostics.length > 0 ||
        transaction === undefined ||
        issuance === undefined ||
        failureEvidence === undefined ||
        verification === undefined) {
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    if (!sameChangeIdentity(transaction.identity, issuance.transaction.identity)) {
        addRecoverySemanticDiagnostic(diagnostics, "$.transaction.identity", "Compensation transaction identity must match issuance.");
    }
    if (transaction.idempotencyKey !== issuance.transaction.idempotencyKey) {
        addRecoverySemanticDiagnostic(diagnostics, "$.transaction.idempotencyKey", "Compensation must reuse issuance idempotency.");
    }
    validateCreateIssuanceFailureSemantics(issuance, failureEvidence.attemptedEffects, failureEvidence.failure, diagnostics);
    validateFailureProjectionIdentity(issuance, failureEvidence.projection, "$.failureEvidence.projection", diagnostics);
    validateFailureProjectionShape(failureEvidence.projection, issuance.verification.canonicalBranch, issuance.verification.canonicalBaseBranch, issuance.transaction.identity.rootIssue, "$.failureEvidence.projection", diagnostics);
    validateCompensationPlanEffects(effects, issuance.verification.canonicalBranch, "$.effects", diagnostics);
    if (!canonicalPlanEquals(verification, compensationVerification(issuance))) {
        addRecoverySemanticDiagnostic(diagnostics, "$.verification", "Compensation verification does not match issuance.");
    }
    if (diagnostics.length > 0) {
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    return {
        valid: true,
        plan: {
            version: CHANGE_TRANSITION_CONTRACT_VERSION,
            operation: "compensate-issue",
            transaction: issuance.transaction,
            issuance,
            failureEvidence,
            effects,
            verification,
        },
        diagnostics: [],
    };
}
/** Assert a valid explicit branch-compensation plan at an executor boundary. */
export function assertChangeIssuanceCompensationPlan(input) {
    const result = validateChangeIssuanceCompensationPlan(input);
    if (!result.valid)
        throw new ChangeIssuanceRecoveryValidationError(result.diagnostics);
}
export function isChangeIssuanceCompensationPlan(input) {
    return validateChangeIssuanceCompensationPlan(input).valid;
}
/** Plan the only safe compensation for a confirmed branch-created/PR-failed issuance. */
export function planChangeIssuanceCompensation(input) {
    const diagnostics = [];
    const parsed = parseChangeIssuanceRecoveryInput(input, diagnostics);
    if (parsed === undefined)
        throw new ChangeIssuanceRecoveryValidationError(createChangeDiagnosticReport(diagnostics).diagnostics);
    const plan = buildChangeIssuanceCompensationPlan(parsed, diagnostics);
    if (plan === undefined)
        throw new ChangeIssuanceRecoveryValidationError(createChangeDiagnosticReport(diagnostics).diagnostics);
    return plan;
}
export const createChangeIssuanceCompensationPlan = planChangeIssuanceCompensation;
export const planChangeCompensation = planChangeIssuanceCompensation;
function validateChangeIssuanceCompensationOutcome(input, path, diagnostics) {
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Compensation outcome must be an object.");
        return undefined;
    }
    addUnknownProperties(input, CHANGE_ISSUANCE_COMPENSATION_OUTCOME_KEYS, path, diagnostics);
    const status = input.status;
    if (typeof status !== "string" ||
        !CHANGE_ISSUANCE_COMPENSATION_STATUSES.includes(status) ||
        status === "required") {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.status`, "Compensation outcome status is invalid.");
    }
    let evidence;
    if (!hasOwn(input, "evidence")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", `${path}.evidence`, "Property is required.");
    }
    else {
        evidence = validateChangeProjectionResult(input.evidence, `${path}.evidence`, diagnostics);
    }
    let failure;
    if (hasOwn(input, "failure")) {
        failure = validateChangeIssuanceFailureEvidence(input.failure, `${path}.failure`, diagnostics);
    }
    if (status === "succeeded" && failure !== undefined) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.failure`, "A successful compensation cannot contain failure evidence.");
    }
    if (status === "failed" && failure === undefined && !hasOwn(input, "failure")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", `${path}.failure`, "A failed compensation must preserve failure evidence.");
    }
    if (diagnostics.length > 0 || evidence === undefined || (status !== "succeeded" && status !== "failed")) {
        return undefined;
    }
    return {
        status,
        evidence,
        ...(failure === undefined ? {} : { failure }),
    };
}
function validateChangeIssuanceRecoveryResult(input, path, diagnostics) {
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", path, "Issuance recovery result must be an object.");
        return undefined;
    }
    addUnknownProperties(input, CHANGE_ISSUANCE_RECOVERY_RESULT_KEYS, path, diagnostics);
    const status = input.status;
    if (typeof status !== "string" ||
        !CHANGE_ISSUANCE_RECOVERY_STATUSES.includes(status)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.status`, "Issuance recovery result status is invalid.");
    }
    if (input.state !== "DEFINED" && input.state !== "RECOVERY_REQUIRED") {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.state`, "Issuance recovery result state is invalid.");
    }
    if (input.issued !== false) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", `${path}.issued`, "Recovery results must state that no Change is issued.");
    }
    let change;
    if (!hasOwn(input, "change")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", `${path}.change`, "Property is required.");
    }
    else {
        const result = validateChange(input.change);
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        change = result.change;
    }
    if (diagnostics.length > 0 ||
        change === undefined ||
        (status !== "compensation-required" && status !== "compensated" && status !== "recovery-required") ||
        (input.state !== "DEFINED" && input.state !== "RECOVERY_REQUIRED")) {
        return undefined;
    }
    return {
        status: status,
        state: input.state,
        issued: false,
        change,
    };
}
function buildChangeIssuanceRecoveryPlan(parsed, diagnostics) {
    const compensationPlan = buildChangeIssuanceCompensationPlan(parsed, diagnostics);
    if (compensationPlan === undefined)
        return undefined;
    let compensationStatus = "required";
    let outcome;
    let result = {
        status: "compensation-required",
        state: "RECOVERY_REQUIRED",
        issued: false,
        change: recoveryChangeFromProjection(parsed.issuance, parsed.projection),
    };
    if (parsed.compensation !== undefined) {
        compensationStatus = parsed.compensation.status;
        outcome = {
            status: parsed.compensation.status,
            evidence: parsed.compensation.projection,
            ...(parsed.compensation.failure === undefined ? {} : { failure: parsed.compensation.failure }),
        };
        if (parsed.compensation.status === "succeeded") {
            validateSafeAbsentProjection(parsed.compensation.projectionInput, parsed.compensation.projection, parsed.issuance, "$.compensation.projection", diagnostics);
            if (diagnostics.length === 0) {
                result = {
                    status: "compensated",
                    state: "DEFINED",
                    issued: false,
                    change: definedChangeAfterCompensation(parsed.issuance),
                };
            }
        }
        else {
            if (parsed.compensation.failure === undefined) {
                addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.compensation.failure", "A failed compensation must preserve failure evidence.");
            }
            else if (!sameEffect(parsed.compensation.failure.effect, compensationPlan.effects[0])) {
                addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.compensation.failure.effect", "Compensation failure evidence must identify the branch delete effect.");
            }
            result = {
                status: "recovery-required",
                state: "RECOVERY_REQUIRED",
                issued: false,
                change: recoveryChangeFromProjection(parsed.issuance, parsed.compensation.projection),
            };
        }
    }
    if (diagnostics.length > 0)
        return undefined;
    const plan = {
        version: CHANGE_TRANSITION_CONTRACT_VERSION,
        operation: "recover-issue",
        transaction: parsed.issuance.transaction,
        issuance: parsed.issuance,
        failureEvidence: compensationPlan.failureEvidence,
        compensation: {
            status: compensationStatus,
            plan: compensationPlan,
            ...(outcome === undefined ? {} : { outcome }),
        },
        result,
    };
    const validation = validateChangeIssuanceRecoveryPlan(plan);
    if (!validation.valid || validation.plan === undefined) {
        diagnostics.push(...validation.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        return undefined;
    }
    return validation.plan;
}
/** Validate and canonicalize a deterministic issuance recovery plan. */
export function validateChangeIssuanceRecoveryPlan(input) {
    const diagnostics = [];
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_ROOT", "$", "Change issuance recovery plan must be an object.");
        return { valid: false, diagnostics };
    }
    addUnknownProperties(input, CHANGE_ISSUANCE_RECOVERY_PLAN_KEYS, "$", diagnostics);
    if (input.version !== CHANGE_TRANSITION_CONTRACT_VERSION) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.version", "Recovery plan version is unsupported.");
    }
    if (input.operation !== "recover-issue") {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.operation", "Recovery plan operation is invalid.");
    }
    let transaction;
    if (!hasOwn(input, "transaction")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.transaction", "Property is required.");
    }
    else {
        transaction = validateChangeIssuanceTransaction(input.transaction, "$.transaction", diagnostics);
    }
    let issuance;
    if (!hasOwn(input, "issuance")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.issuance", "Property is required.");
    }
    else {
        const result = validateChangeIssuancePlan(input.issuance);
        diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
        issuance = result.plan;
    }
    let failureEvidence;
    if (!hasOwn(input, "failureEvidence")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.failureEvidence", "Property is required.");
    }
    else {
        failureEvidence = validateChangeIssuanceFailureRecord(input.failureEvidence, "$.failureEvidence", diagnostics);
    }
    let compensationStatus;
    let compensationPlan;
    let outcome;
    if (!hasOwn(input, "compensation")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.compensation", "Property is required.");
    }
    else if (!isRecord(input.compensation)) {
        addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.compensation", "Recovery compensation must be an object.");
    }
    else {
        addUnknownProperties(input.compensation, CHANGE_ISSUANCE_RECOVERY_COMPENSATION_KEYS, "$.compensation", diagnostics);
        const status = input.compensation.status;
        if (!CHANGE_ISSUANCE_COMPENSATION_STATUSES.includes(status)) {
            addDiagnostic(diagnostics, "CHANGE_INVALID_PLAN", "$.compensation.status", "Recovery compensation status is invalid.");
        }
        else {
            compensationStatus = status;
        }
        if (!hasOwn(input.compensation, "plan")) {
            addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.compensation.plan", "Property is required.");
        }
        else {
            const result = validateChangeIssuanceCompensationPlan(input.compensation.plan);
            diagnostics.push(...result.diagnostics.slice(0, Math.max(0, MAX_CHANGE_DIAGNOSTICS - diagnostics.length)));
            compensationPlan = result.plan;
        }
        if (hasOwn(input.compensation, "outcome")) {
            outcome = validateChangeIssuanceCompensationOutcome(input.compensation.outcome, "$.compensation.outcome", diagnostics);
        }
    }
    let result;
    if (!hasOwn(input, "result")) {
        addDiagnostic(diagnostics, "CHANGE_MISSING_PROPERTY", "$.result", "Property is required.");
    }
    else {
        result = validateChangeIssuanceRecoveryResult(input.result, "$.result", diagnostics);
    }
    if (diagnostics.length > 0 ||
        transaction === undefined ||
        issuance === undefined ||
        failureEvidence === undefined ||
        compensationStatus === undefined ||
        compensationPlan === undefined ||
        result === undefined) {
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    if (!sameChangeIdentity(transaction.identity, issuance.transaction.identity)) {
        addRecoverySemanticDiagnostic(diagnostics, "$.transaction.identity", "Recovery transaction identity must match issuance.");
    }
    if (transaction.idempotencyKey !== issuance.transaction.idempotencyKey) {
        addRecoverySemanticDiagnostic(diagnostics, "$.transaction.idempotencyKey", "Recovery must reuse issuance idempotency.");
    }
    if (!canonicalPlanEquals(failureEvidence, compensationPlan.failureEvidence)) {
        addRecoverySemanticDiagnostic(diagnostics, "$.failureEvidence", "Recovery must retain the compensation failure evidence unchanged.");
    }
    if (compensationStatus === "required" && outcome !== undefined) {
        addRecoverySemanticDiagnostic(diagnostics, "$.compensation.outcome", "A pending compensation cannot contain an outcome.");
    }
    if (compensationStatus !== "required") {
        if (outcome === undefined) {
            addRecoverySemanticDiagnostic(diagnostics, "$.compensation.outcome", "A completed compensation must retain its outcome.");
        }
        else if (outcome.status !== compensationStatus) {
            addRecoverySemanticDiagnostic(diagnostics, "$.compensation.outcome.status", "Compensation status must match its outcome.");
        }
    }
    if (outcome !== undefined) {
        validateFailureProjectionIdentity(issuance, outcome.evidence, "$.compensation.outcome.evidence", diagnostics);
        if (outcome.status === "succeeded") {
            if (outcome.failure !== undefined) {
                addRecoverySemanticDiagnostic(diagnostics, "$.compensation.outcome.failure", "Successful compensation cannot retain failure evidence.");
            }
            if (outcome.evidence.status !== "absent" || !outcome.evidence.valid) {
                addRecoverySemanticDiagnostic(diagnostics, "$.compensation.outcome.evidence", "Successful compensation must prove an absent projection.");
            }
        }
        else if (outcome.failure === undefined) {
            addRecoverySemanticDiagnostic(diagnostics, "$.compensation.outcome.failure", "Failed compensation must retain failure evidence.");
        }
        else if (!sameEffect(outcome.failure.effect, compensationPlan.effects[0])) {
            addRecoverySemanticDiagnostic(diagnostics, "$.compensation.outcome.failure.effect", "Compensation failure evidence must identify the branch delete effect.");
        }
    }
    const expectedResultState = compensationStatus === "succeeded" ? "DEFINED" : "RECOVERY_REQUIRED";
    const expectedResultStatus = compensationStatus === "required"
        ? "compensation-required"
        : compensationStatus === "succeeded"
            ? "compensated"
            : "recovery-required";
    if (result.status !== expectedResultStatus || result.state !== expectedResultState) {
        addRecoverySemanticDiagnostic(diagnostics, "$.result", "Recovery result does not match compensation outcome.");
    }
    if (result.change.state !== expectedResultState) {
        addRecoverySemanticDiagnostic(diagnostics, "$.result.change.state", "Recovery Change state does not match compensation outcome.");
    }
    if (!sameChangeIdentity(result.change.identity, issuance.transaction.identity)) {
        addRecoverySemanticDiagnostic(diagnostics, "$.result.change.identity", "Recovery result identity must match issuance.");
    }
    if (compensationStatus === "succeeded" && result.change.projection !== undefined) {
        addRecoverySemanticDiagnostic(diagnostics, "$.result.change.projection", "Compensation success must return no issued Change projection.");
    }
    if (diagnostics.length > 0) {
        return { valid: false, diagnostics: createChangeDiagnosticReport(diagnostics).diagnostics };
    }
    return {
        valid: true,
        plan: {
            version: CHANGE_TRANSITION_CONTRACT_VERSION,
            operation: "recover-issue",
            transaction: issuance.transaction,
            issuance,
            failureEvidence,
            compensation: {
                status: compensationStatus,
                plan: compensationPlan,
                ...(outcome === undefined ? {} : { outcome }),
            },
            result,
        },
        diagnostics: [],
    };
}
/** Assert a valid deterministic issuance recovery plan at an executor boundary. */
export function assertChangeIssuanceRecoveryPlan(input) {
    const result = validateChangeIssuanceRecoveryPlan(input);
    if (!result.valid)
        throw new ChangeIssuanceRecoveryValidationError(result.diagnostics);
}
export function isChangeIssuanceRecoveryPlan(input) {
    return validateChangeIssuanceRecoveryPlan(input).valid;
}
/**
 * Plan issuance compensation and recovery from bounded effect/projection
 * evidence. This function is pure and never executes the delete effect.
 */
export function planChangeIssuanceRecovery(input) {
    const diagnostics = [];
    const parsed = parseChangeIssuanceRecoveryInput(input, diagnostics);
    if (parsed === undefined)
        throw new ChangeIssuanceRecoveryValidationError(createChangeDiagnosticReport(diagnostics).diagnostics);
    const plan = buildChangeIssuanceRecoveryPlan(parsed, diagnostics);
    if (plan === undefined)
        throw new ChangeIssuanceRecoveryValidationError(createChangeDiagnosticReport(diagnostics).diagnostics);
    return plan;
}
export const createChangeIssuanceRecoveryPlan = planChangeIssuanceRecovery;
export const planChangeRecovery = planChangeIssuanceRecovery;
/** Serialize a canonical transport-independent compensation plan. */
export function serializeChangeIssuanceCompensationPlan(input) {
    const result = validateChangeIssuanceCompensationPlan(input);
    if (!result.valid || result.plan === undefined)
        throw new ChangeIssuanceRecoveryValidationError(result.diagnostics);
    const serialized = JSON.stringify(result.plan);
    if (serialized === undefined)
        throw new Error("Change issuance compensation plan could not be serialized.");
    return serialized;
}
/** Parse and validate an untrusted compensation plan JSON boundary. */
export function deserializeChangeIssuanceCompensationPlan(serialized) {
    let parsed;
    try {
        parsed = JSON.parse(serialized);
    }
    catch (error) {
        throw new ChangeIssuanceRecoveryValidationError([
            createChangeDiagnostic({
                code: "CHANGE_INVALID_JSON",
                message: safeMessage(`Change issuance compensation plan must be valid JSON: ${error instanceof Error ? error.message : String(error)}`),
            }),
        ]);
    }
    const result = validateChangeIssuanceCompensationPlan(parsed);
    if (!result.valid || result.plan === undefined)
        throw new ChangeIssuanceRecoveryValidationError(result.diagnostics);
    return result.plan;
}
/** Serialize a canonical transport-independent recovery plan. */
export function serializeChangeIssuanceRecoveryPlan(input) {
    const result = validateChangeIssuanceRecoveryPlan(input);
    if (!result.valid || result.plan === undefined)
        throw new ChangeIssuanceRecoveryValidationError(result.diagnostics);
    const serialized = JSON.stringify(result.plan);
    if (serialized === undefined)
        throw new Error("Change issuance recovery plan could not be serialized.");
    return serialized;
}
/** Parse and validate an untrusted recovery plan JSON boundary. */
export function deserializeChangeIssuanceRecoveryPlan(serialized) {
    let parsed;
    try {
        parsed = JSON.parse(serialized);
    }
    catch (error) {
        throw new ChangeIssuanceRecoveryValidationError([
            createChangeDiagnostic({
                code: "CHANGE_INVALID_JSON",
                message: safeMessage(`Change issuance recovery plan must be valid JSON: ${error instanceof Error ? error.message : String(error)}`),
            }),
        ]);
    }
    const result = validateChangeIssuanceRecoveryPlan(parsed);
    if (!result.valid || result.plan === undefined)
        throw new ChangeIssuanceRecoveryValidationError(result.diagnostics);
    return result.plan;
}
export const parseChangeIssuanceCompensationPlan = deserializeChangeIssuanceCompensationPlan;
export const parseChangeIssuanceRecoveryPlan = deserializeChangeIssuanceRecoveryPlan;
export const serializeChangeCompensationPlan = serializeChangeIssuanceCompensationPlan;
export const serializeChangeRecoveryPlan = serializeChangeIssuanceRecoveryPlan;
export class ChangeIssuanceRecoveryValidationError extends ChangeValidationError {
    constructor(diagnostics) {
        super(diagnostics);
        this.name = "ChangeIssuanceRecoveryValidationError";
    }
}
//# sourceMappingURL=change.js.map