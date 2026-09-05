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
export const MAX_CHANGE_BASE_BRANCH_LENGTH = MAX_CHANGE_BRANCH_LENGTH;
export const MAX_CHANGE_TRANSITION_EFFECTS = 8;
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
//# sourceMappingURL=change.js.map