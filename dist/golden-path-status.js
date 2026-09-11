/**
 * Pure, transport-neutral projection of the Inari Golden Path.
 *
 * This module composes bounded evidence owned by Repository Canon, Issue
 * Core, and Change Core.  It does not persist a status, execute an effect, or
 * reproduce Change lifecycle legality.  In particular, a Change snapshot is
 * never used to overwrite a fresh Change projection.
 */
import { CHANGE_PROJECTION_STATUSES, CHANGE_STATES, validateChangeProjectionResult, validateChange, } from "./change.js";
import { CHANGE_REMOTE_EXECUTION_OUTCOMES } from "./change-executor.js";
export const GOLDEN_PATH_STATUS_VERSION = 1;
export const GOLDEN_PATH_PHASES = Object.freeze([
    "ENVIRONMENT",
    "GOVERNANCE",
    "ISSUE",
    "CHANGE",
    "IMPLEMENTATION",
    "READY",
    "REVIEW",
    "TERMINAL",
    "RECOVERY",
]);
export const GOLDEN_PATH_AVAILABILITIES = Object.freeze([
    "actionable",
    "blocked",
    "recovery-required",
    "terminal",
]);
/** Normal actions deliberately exclude recovery actions owned by #410. */
export const GOLDEN_PATH_NORMAL_ACTION_KINDS = Object.freeze([
    "PREFLIGHT",
    "DISCOVER_GOVERNANCE",
    "CREATE_ISSUE",
    "ISSUE_CHANGE",
    "IMPLEMENT",
    "READY_CHANGE",
    "REVIEW",
    "WAIT",
]);
/** Recovery actions are a separate boundary; this module only projects supplied recovery evidence. */
export const GOLDEN_PATH_RECOVERY_ACTION_KINDS = Object.freeze([
    "RETRY",
    "ABORT",
    "RECOVER",
    "MANUAL_REVIEW",
    "WAIT",
]);
export const GOLDEN_PATH_ACTION_KINDS = Object.freeze([
    ...GOLDEN_PATH_NORMAL_ACTION_KINDS,
    ...GOLDEN_PATH_RECOVERY_ACTION_KINDS,
]);
export const GOLDEN_PATH_ACTION_OWNERS = Object.freeze([
    "caller",
    "inari",
    "worker",
    "repository",
    "recovery",
]);
export const GOLDEN_PATH_REASON_CODES = Object.freeze([
    "PACKAGE_CAPABILITY_REQUIRED",
    "GOVERNANCE_DISCOVERY_REQUIRED",
    "GOVERNED_ISSUE_REQUIRED",
    "CHANGE_ISSUANCE_REQUIRED",
    "CHANGE_ISSUED",
    "READY_PRECONDITIONS_REQUIRED",
    "REVIEW_ADMITTED",
    "AUTHORITATIVE_REREAD_REQUIRED",
    "IDEMPOTENT_RETRY",
    "ABORT_CLEANUP_REQUIRED",
    "RECOVERY_ACTION_REQUIRED",
    "MANUAL_RECOVERY_REVIEW_REQUIRED",
    "WAIT_FOR_REPOSITORY_REVIEW",
]);
/**
 * The sole normal-action metadata authority.  Projection and serialized
 * status validation both consume this table; it is not a lifecycle matrix.
 */
export const GOLDEN_PATH_NORMAL_ACTION_METADATA = Object.freeze({
    PREFLIGHT: { owner: "caller", reasonCode: "PACKAGE_CAPABILITY_REQUIRED" },
    DISCOVER_GOVERNANCE: { owner: "inari", reasonCode: "GOVERNANCE_DISCOVERY_REQUIRED" },
    CREATE_ISSUE: { owner: "inari", reasonCode: "GOVERNED_ISSUE_REQUIRED" },
    ISSUE_CHANGE: { owner: "inari", reasonCode: "CHANGE_ISSUANCE_REQUIRED" },
    IMPLEMENT: { owner: "worker", reasonCode: "CHANGE_ISSUED" },
    READY_CHANGE: { owner: "inari", reasonCode: "READY_PRECONDITIONS_REQUIRED" },
    REVIEW: { owner: "repository", reasonCode: "REVIEW_ADMITTED" },
    WAIT: { owner: "repository", reasonCode: "WAIT_FOR_REPOSITORY_REVIEW" },
});
export const GOLDEN_PATH_STATUS_RECOVERY_CLASSES = Object.freeze([
    "ISSUANCE_PARTIAL_PROJECTION",
    "ISSUANCE_COMPENSATION_UNSAFE",
    "ABORT_CLEANUP_PENDING",
    "ABORT_CLEANUP_UNSAFE",
    "POST_EFFECT_VERIFICATION",
]);
export const GOLDEN_PATH_AUTOMATIC_CLEANUP = Object.freeze(["none", "conditional", "forbidden"]);
export class GoldenPathStatusError extends Error {
    diagnostics;
    constructor(diagnostics) {
        super(diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n"));
        this.name = "GoldenPathStatusError";
        this.diagnostics = diagnostics;
    }
}
const MAX_DIAGNOSTICS = 32;
const MAX_MESSAGE_LENGTH = 240;
const TOP_LEVEL_KEYS = new Set([
    "environment",
    "governance",
    "issue",
    "change",
    "changeProjection",
    "projection",
    "executionOutcome",
    "execution",
    "implementation",
    "ready",
    "review",
    "recovery",
    "subject",
]);
const ENVIRONMENT_KEYS = new Set(["status", "available", "ready", "verified", "packageIdentity", "capabilities"]);
const GOVERNANCE_KEYS = new Set(["status", "available", "valid", "repositoryHost", "repositoryId"]);
const ISSUE_KEYS = new Set(["status", "exists", "governed", "number", "state"]);
const CHANGE_EVIDENCE_KEYS = new Set(["projection", "state", "projectionStatus", "subject"]);
const EXECUTION_KEYS = new Set(["outcome"]);
const IMPLEMENTATION_KEYS = new Set(["status", "ready", "complete", "evidence"]);
const READY_KEYS = new Set(["status", "eligible", "preconditions", "evidence"]);
const REVIEW_KEYS = new Set(["status", "action"]);
const SUBJECT_KEYS = new Set(["repositoryHost", "repositoryId", "rootIssue"]);
const RECOVERY_KEYS = new Set([
    "class",
    "safeAction",
    "retryable",
    "rereadRequired",
    "automaticCleanup",
    "retryOf",
    "reasonCode",
]);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
function isRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function boundedMessage(message) {
    const normalized = message.replace(/\s+/gu, " ").trim();
    return normalized.length > MAX_MESSAGE_LENGTH ? `${normalized.slice(0, MAX_MESSAGE_LENGTH)}…` : normalized;
}
function addDiagnostic(diagnostics, code, path, message) {
    if (diagnostics.length < MAX_DIAGNOSTICS)
        diagnostics.push({ code, path, message: boundedMessage(message) });
}
function unknownProperties(value, allowed, path, diagnostics) {
    for (const key of Object.keys(value).sort()) {
        if (!allowed.has(key))
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_UNKNOWN_PROPERTY", `${path}.${key}`, "Property is not supported.");
    }
}
function cloneImmutable(value) {
    if (Array.isArray(value))
        return Object.freeze(value.map((entry) => cloneImmutable(entry)));
    if (isRecord(value)) {
        const clone = {};
        for (const key of Object.keys(value).sort())
            clone[key] = cloneImmutable(value[key]);
        return Object.freeze(clone);
    }
    return value;
}
function validText(value, maxLength = 255) {
    return (typeof value === "string" && value.length > 0 && value.length <= maxLength && !CONTROL_CHARACTER_PATTERN.test(value));
}
function parseSubject(value, path, diagnostics) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value)) {
        addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", path, "Subject evidence must be an object.");
        return undefined;
    }
    unknownProperties(value, SUBJECT_KEYS, path, diagnostics);
    const result = {};
    if (hasOwn(value, "repositoryHost")) {
        if (!validText(value.repositoryHost, 255))
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", `${path}.repositoryHost`, "Repository host must be bounded text.");
        else
            result.repositoryHost = value.repositoryHost;
    }
    if (hasOwn(value, "repositoryId")) {
        if (typeof value.repositoryId !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value.repositoryId))
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", `${path}.repositoryId`, "Repository id must be a positive decimal identifier.");
        else
            result.repositoryId = value.repositoryId;
    }
    if (hasOwn(value, "rootIssue")) {
        if (!Number.isSafeInteger(value.rootIssue) || value.rootIssue < 1)
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", `${path}.rootIssue`, "Root Issue must be a positive integer.");
        else
            result.rootIssue = value.rootIssue;
    }
    return result;
}
function evidenceAvailability(value, kind, diagnostics) {
    if (value === undefined)
        return "missing";
    if (typeof value === "boolean")
        return value ? "available" : "unavailable";
    if (typeof value === "string") {
        if (kind === "issue") {
            if (value === "present")
                return "available";
            if (value === "absent")
                return "absent";
        }
        else if (value === "available")
            return "available";
        if (value === "unavailable" || value === "unknown")
            return "unavailable";
        addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", `$.${kind}`, `Invalid ${kind} evidence status.`);
        return "invalid";
    }
    if (!isRecord(value)) {
        addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", `$.${kind}`, `${kind} evidence must be bounded evidence.`);
        return "invalid";
    }
    const keys = kind === "environment" ? ENVIRONMENT_KEYS : kind === "governance" ? GOVERNANCE_KEYS : ISSUE_KEYS;
    unknownProperties(value, keys, `$.${kind}`, diagnostics);
    if (kind === "environment") {
        for (const key of ["available", "ready", "verified"])
            if (value[key] !== undefined && typeof value[key] !== "boolean")
                addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", `$.environment.${key}`, "Environment flags must be boolean.");
        if (value.packageIdentity !== undefined && !validText(value.packageIdentity, 255))
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.environment.packageIdentity", "Package identity must be bounded text.");
        if (value.capabilities !== undefined &&
            (!Array.isArray(value.capabilities) || value.capabilities.some((entry) => !validText(entry, 255))))
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.environment.capabilities", "Capabilities must be bounded text values.");
    }
    else if (kind === "governance") {
        for (const key of ["available", "valid"])
            if (value[key] !== undefined && typeof value[key] !== "boolean")
                addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", `$.governance.${key}`, "Governance flags must be boolean.");
        if (value.repositoryHost !== undefined && !validText(value.repositoryHost, 255))
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.governance.repositoryHost", "Repository host must be bounded text.");
        if (value.repositoryId !== undefined &&
            (typeof value.repositoryId !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value.repositoryId)))
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.governance.repositoryId", "Repository id must be a positive decimal identifier.");
    }
    else {
        for (const key of ["exists", "governed"])
            if (value[key] !== undefined && typeof value[key] !== "boolean")
                addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", `$.issue.${key}`, "Issue flags must be boolean.");
        if (value.number !== undefined && (!Number.isSafeInteger(value.number) || value.number < 1))
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.issue.number", "Issue number must be a positive integer.");
        if (value.state !== undefined && value.state !== "open" && value.state !== "closed")
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.issue.state", "Issue state is invalid.");
    }
    if (kind === "issue") {
        if (value.status === "absent" || value.exists === false)
            return "absent";
        if (value.status === "unavailable" || value.status === "unknown")
            return "unavailable";
        if (value.governed === false)
            return "unavailable";
        if (value.status === "present" || value.exists === true || value.governed === true)
            return "available";
        return "missing";
    }
    if (value.status === "unavailable" ||
        value.status === "unknown" ||
        value.available === false ||
        value.valid === false)
        return "unavailable";
    if (value.status === "available" ||
        value.available === true ||
        value.valid === true ||
        value.ready === true ||
        value.verified === true ||
        (kind === "governance" && (value.repositoryHost !== undefined || value.repositoryId !== undefined)) ||
        (kind === "environment" && (value.packageIdentity !== undefined || value.capabilities !== undefined)))
        return "available";
    return "missing";
}
function parseProjection(input, diagnostics) {
    let source;
    if (hasOwn(input, "changeProjection"))
        source = input.changeProjection;
    else if (hasOwn(input, "projection"))
        source = input.projection;
    let state;
    let projectionStatus;
    let subject;
    if (source !== undefined) {
        const result = validateChangeProjectionResult(source);
        if (!result.valid || result.projection === undefined) {
            addDiagnostic(diagnostics, "GOLDEN_PATH_PROJECTION_INVALID", "$.changeProjection", "Change projection evidence is invalid.");
        }
        else {
            state = result.projection.change?.state;
            projectionStatus = result.projection.status;
            const identity = result.projection.change?.identity;
            if (identity !== undefined)
                subject = {
                    repositoryHost: identity.repositoryHost,
                    repositoryId: identity.repositoryId,
                    rootIssue: identity.rootIssue,
                };
            return { projection: result.projection, state, projectionStatus, subject };
        }
    }
    if (!hasOwn(input, "change"))
        return {};
    const change = input.change;
    if (!isRecord(change)) {
        addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.change", "Change evidence must be an object.");
        return {};
    }
    // A Change identity is useful before issuance.  It carries scope, but no
    // lifecycle state; the next action is consequently selected from Issue
    // evidence below rather than from an invented Change state.
    if (hasOwn(change, "repositoryHost") || hasOwn(change, "repositoryId") || hasOwn(change, "rootIssue")) {
        const identity = change;
        const parsed = parseSubject({
            repositoryHost: identity.repositoryHost,
            repositoryId: identity.repositoryId,
            rootIssue: identity.rootIssue,
        }, "$.change", diagnostics);
        return { subject: parsed };
    }
    if (hasOwn(change, "projection") ||
        hasOwn(change, "state") ||
        hasOwn(change, "projectionStatus") ||
        hasOwn(change, "subject")) {
        unknownProperties(change, CHANGE_EVIDENCE_KEYS, "$.change", diagnostics);
        if (hasOwn(change, "projection")) {
            const result = validateChangeProjectionResult(change.projection);
            if (!result.valid || result.projection === undefined)
                addDiagnostic(diagnostics, "GOLDEN_PATH_PROJECTION_INVALID", "$.change.projection", "Change projection evidence is invalid.");
            else {
                state = result.projection.change?.state;
                projectionStatus = result.projection.status;
                const identity = result.projection.change?.identity;
                if (identity !== undefined)
                    subject = {
                        repositoryHost: identity.repositoryHost,
                        repositoryId: identity.repositoryId,
                        rootIssue: identity.rootIssue,
                    };
                return { projection: result.projection, state, projectionStatus, subject };
            }
        }
        if (typeof change.state === "string" && CHANGE_STATES.includes(change.state))
            state = change.state;
        else if (hasOwn(change, "state"))
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.change.state", "Change state is invalid.");
        if (typeof change.projectionStatus === "string" &&
            CHANGE_PROJECTION_STATUSES.includes(change.projectionStatus))
            projectionStatus = change.projectionStatus;
        return { state, projectionStatus, subject: parseSubject(change.subject, "$.change.subject", diagnostics) };
    }
    const validation = validateChange(change);
    if (!validation.valid || validation.change === undefined) {
        const identity = change.identity;
        if (isRecord(identity) && typeof change.state === "string" && CHANGE_STATES.includes(change.state)) {
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.change", "A complete Change snapshot is required for direct Change evidence.");
        }
        else
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.change", "Change evidence is invalid.");
        return {};
    }
    const normalized = validation.change;
    state = normalized.state;
    projectionStatus = normalized.state === "DEFINED" ? "absent" : "healthy";
    subject = {
        repositoryHost: normalized.identity.repositoryHost,
        repositoryId: normalized.identity.repositoryId,
        rootIssue: normalized.identity.rootIssue,
    };
    return { state, projectionStatus, subject };
}
function parseExecution(input, diagnostics) {
    let value = input.executionOutcome;
    if (value === undefined && isRecord(input.execution)) {
        unknownProperties(input.execution, EXECUTION_KEYS, "$.execution", diagnostics);
        value = input.execution.outcome;
    }
    else if (input.execution !== undefined && !isRecord(input.execution)) {
        addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.execution", "Execution evidence must be an object.");
    }
    if (value === undefined)
        return undefined;
    if (!CHANGE_REMOTE_EXECUTION_OUTCOMES.includes(value)) {
        addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.executionOutcome", "Execution outcome is invalid.");
        return undefined;
    }
    return value;
}
function readiness(value, kind, diagnostics) {
    if (value === undefined)
        return undefined;
    if (typeof value === "boolean")
        return value;
    if (typeof value === "string") {
        if (kind === "implementation" && value === "ready")
            return true;
        if (kind === "implementation" && (value === "in-progress" || value === "unknown"))
            return false;
        if (kind === "ready" && value === "eligible")
            return true;
        if (kind === "ready" && (value === "ineligible" || value === "unknown"))
            return false;
        addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", `$.${kind}`, `Invalid ${kind} evidence status.`);
        return undefined;
    }
    if (!isRecord(value)) {
        addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", `$.${kind}`, `${kind} evidence must be bounded evidence.`);
        return undefined;
    }
    unknownProperties(value, kind === "implementation" ? IMPLEMENTATION_KEYS : READY_KEYS, `$.${kind}`, diagnostics);
    if (kind === "implementation") {
        if (value.ready === true || value.complete === true || value.status === "ready" || value.evidence === true)
            return true;
        if (value.ready === false ||
            value.complete === false ||
            value.status === "in-progress" ||
            value.status === "unknown" ||
            value.status === "unavailable")
            return false;
    }
    else {
        if (value.eligible === true ||
            value.preconditions === true ||
            value.evidence === true ||
            value.status === "eligible")
            return true;
        if (value.eligible === false ||
            value.preconditions === false ||
            value.status === "ineligible" ||
            value.status === "unknown" ||
            value.status === "unavailable")
            return false;
    }
    return undefined;
}
function parseRecovery(value, diagnostics) {
    if (value === undefined || value === null)
        return value === null ? null : undefined;
    if (!isRecord(value)) {
        addDiagnostic(diagnostics, "GOLDEN_PATH_RECOVERY_INVALID", "$.recovery", "Recovery evidence must be an object.");
        return undefined;
    }
    unknownProperties(value, RECOVERY_KEYS, "$.recovery", diagnostics);
    if (!GOLDEN_PATH_STATUS_RECOVERY_CLASSES.includes(value.class) ||
        !GOLDEN_PATH_RECOVERY_ACTION_KINDS.includes(value.safeAction) ||
        typeof value.retryable !== "boolean" ||
        value.rereadRequired !== true ||
        !GOLDEN_PATH_AUTOMATIC_CLEANUP.includes(value.automaticCleanup)) {
        addDiagnostic(diagnostics, "GOLDEN_PATH_RECOVERY_INVALID", "$.recovery", "Recovery evidence is outside the bounded contract.");
        return undefined;
    }
    if (value.retryOf !== undefined &&
        !GOLDEN_PATH_NORMAL_ACTION_KINDS.includes(value.retryOf)) {
        addDiagnostic(diagnostics, "GOLDEN_PATH_RECOVERY_INVALID", "$.recovery.retryOf", "Recovery retry target is invalid.");
        return undefined;
    }
    if (value.retryable !== (value.safeAction === "RETRY")) {
        addDiagnostic(diagnostics, "GOLDEN_PATH_RECOVERY_INVALID", "$.recovery.retryable", "Recovery retryability must be true exactly for RETRY.");
        return undefined;
    }
    if (value.automaticCleanup === "forbidden" && ["RETRY", "ABORT", "RECOVER"].includes(value.safeAction)) {
        addDiagnostic(diagnostics, "GOLDEN_PATH_RECOVERY_INVALID", "$.recovery.automaticCleanup", "Forbidden cleanup cannot expose an automatic retry, abort, or recover action.");
        return undefined;
    }
    if (value.reasonCode !== undefined && !GOLDEN_PATH_REASON_CODES.includes(value.reasonCode)) {
        addDiagnostic(diagnostics, "GOLDEN_PATH_RECOVERY_INVALID", "$.recovery.reasonCode", "Recovery reason code is invalid.");
        return undefined;
    }
    return {
        class: value.class,
        safeAction: value.safeAction,
        retryable: value.retryable,
        rereadRequired: true,
        automaticCleanup: value.automaticCleanup,
        ...(value.retryOf === undefined ? {} : { retryOf: value.retryOf }),
        ...(value.reasonCode === undefined ? {} : { reasonCode: value.reasonCode }),
    };
}
function scopeSubject(value, path, diagnostics) {
    if (!isRecord(value))
        return undefined;
    const candidate = {};
    if (hasOwn(value, "repositoryHost"))
        candidate.repositoryHost = value.repositoryHost;
    if (hasOwn(value, "repositoryId"))
        candidate.repositoryId = value.repositoryId;
    if (hasOwn(value, "number"))
        candidate.rootIssue = value.number;
    return Object.keys(candidate).length === 0 ? undefined : parseSubject(candidate, path, diagnostics);
}
function mergeSubjects(candidates, diagnostics) {
    const merged = {};
    for (const [candidate, path] of candidates) {
        if (candidate === undefined)
            continue;
        for (const key of ["repositoryHost", "repositoryId", "rootIssue"]) {
            const value = candidate[key];
            if (value === undefined)
                continue;
            if (merged[key] !== undefined && merged[key] !== value)
                addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_CONTRADICTORY", path, "Subject conflicts with authoritative scope evidence.");
            else if (key === "repositoryHost")
                merged.repositoryHost = value;
            else if (key === "repositoryId")
                merged.repositoryId = value;
            else
                merged.rootIssue = value;
        }
    }
    return Object.keys(merged).length === 0 ? undefined : merged;
}
function normalAction(kind) {
    return { kind, ...GOLDEN_PATH_NORMAL_ACTION_METADATA[kind] };
}
function recoveryAction(kind, retryOf, suppliedReasonCode) {
    const reasonCode = suppliedReasonCode ??
        (kind === "ABORT"
            ? "ABORT_CLEANUP_REQUIRED"
            : kind === "MANUAL_REVIEW"
                ? "MANUAL_RECOVERY_REVIEW_REQUIRED"
                : kind === "RETRY"
                    ? "IDEMPOTENT_RETRY"
                    : kind === "WAIT"
                        ? "AUTHORITATIVE_REREAD_REQUIRED"
                        : "RECOVERY_ACTION_REQUIRED");
    return { kind, owner: "recovery", reasonCode, ...(retryOf === undefined ? {} : { retryOf }) };
}
function blockedStatus(phase, fields) {
    return { phase, availability: "blocked", ...fields };
}
function parseAndProject(input) {
    const diagnostics = [];
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$", "Golden Path status input must be an object.");
        return { valid: false, diagnostics };
    }
    unknownProperties(input, TOP_LEVEL_KEYS, "$", diagnostics);
    const environment = evidenceAvailability(input.environment, "environment", diagnostics);
    const governance = evidenceAvailability(input.governance, "governance", diagnostics);
    const issue = evidenceAvailability(input.issue, "issue", diagnostics);
    const change = parseProjection(input, diagnostics);
    const executionOutcome = parseExecution(input, diagnostics);
    const implementationReady = readiness(input.implementation, "implementation", diagnostics);
    const readyEligible = readiness(input.ready, "ready", diagnostics);
    const recovery = parseRecovery(input.recovery, diagnostics);
    const explicitSubject = parseSubject(input.subject, "$.subject", diagnostics);
    const governanceSubject = scopeSubject(input.governance, "$.governance", diagnostics);
    const issueSubject = scopeSubject(input.issue, "$.issue", diagnostics);
    const subject = mergeSubjects([
        [explicitSubject, "$.subject"],
        [change.subject, "$.change"],
        [governanceSubject, "$.governance"],
        [issueSubject, "$.issue"],
    ], diagnostics);
    if (change.projection !== undefined && change.state === undefined)
        addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_INCOMPLETE", "$.changeProjection.change", "A Change projection must carry its authoritative Change state.");
    if (change.projectionStatus === "healthy" && change.state === "DEFINED")
        addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_CONTRADICTORY", "$.changeProjection", "A healthy issued projection cannot carry DEFINED state.");
    if (change.projectionStatus === "absent" && change.state !== undefined && change.state !== "DEFINED")
        addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_CONTRADICTORY", "$.changeProjection", "An absent projection cannot carry an issued Change state.");
    if (implementationReady === true && readyEligible === false)
        addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_CONTRADICTORY", "$.ready", "Implementation readiness conflicts with ready preconditions.");
    if (issue === "absent" && change.state !== undefined && change.state !== "DEFINED")
        addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_CONTRADICTORY", "$.issue", "An absent Issue cannot have an issued or terminal Change state.");
    if (diagnostics.length > 0)
        return { valid: false, diagnostics };
    const fields = {
        ...(change.state === undefined ? {} : { changeState: change.state }),
        ...(change.projectionStatus === undefined ? {} : { projectionStatus: change.projectionStatus }),
        ...(executionOutcome === undefined ? {} : { executionOutcome }),
    };
    let status;
    let nextAction = null;
    let outputRecovery = null;
    if (isRecord(input.review)) {
        unknownProperties(input.review, REVIEW_KEYS, "$.review", diagnostics);
        const review = input.review;
        if (review.status !== undefined &&
            !["required", "waiting", "complete", "unavailable", "unknown"].includes(review.status))
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.review.status", "Review evidence status is invalid.");
        if (review.action !== undefined && review.action !== "review" && review.action !== "wait")
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.review.action", "Review evidence action is invalid.");
    }
    else if (input.review !== undefined)
        addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.review", "Review evidence must be an object.");
    if (recovery !== undefined && recovery !== null && change.state !== "RECOVERY_REQUIRED")
        addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_CONTRADICTORY", "$.recovery", "Recovery evidence requires a RECOVERY_REQUIRED Change state.");
    if (diagnostics.length > 0)
        return { valid: false, diagnostics };
    if (environment === "missing") {
        status = { phase: "ENVIRONMENT", availability: "actionable", ...fields };
        nextAction = normalAction("PREFLIGHT");
    }
    else if (environment !== "available") {
        addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_UNAVAILABLE", "$.environment", "Package environment preflight is unavailable.");
        status = blockedStatus("ENVIRONMENT", fields);
    }
    else if (governance === "missing") {
        status = { phase: "GOVERNANCE", availability: "actionable", ...fields };
        nextAction = normalAction("DISCOVER_GOVERNANCE");
    }
    else if (governance !== "available") {
        addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_UNAVAILABLE", "$.governance", "Repository governance evidence is unavailable.");
        status = blockedStatus("GOVERNANCE", fields);
    }
    else if (issue === "missing" && change.state === undefined) {
        status = { phase: "ISSUE", availability: "actionable", ...fields };
        nextAction = normalAction("CREATE_ISSUE");
    }
    else if (issue === "absent" && change.state === undefined) {
        status = { phase: "ISSUE", availability: "actionable", ...fields };
        nextAction = normalAction("CREATE_ISSUE");
    }
    else if (issue === "unavailable") {
        addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_UNAVAILABLE", "$.issue", "Governed Issue evidence is unavailable.");
        status = blockedStatus("ISSUE", fields);
    }
    else if (change.state === undefined) {
        status = { phase: "ISSUE", availability: "actionable", ...fields };
        nextAction = normalAction("ISSUE_CHANGE");
    }
    else if (change.state === "RECOVERY_REQUIRED") {
        if (recovery !== null && recovery !== undefined) {
            status = { phase: "RECOVERY", availability: "recovery-required", ...fields };
            outputRecovery = recovery;
            nextAction = recoveryAction(recovery.safeAction, recovery.retryOf, recovery.reasonCode);
        }
        else {
            addDiagnostic(diagnostics, "GOLDEN_PATH_RECOVERY_REQUIRED", "$.recovery", "Recovery evidence is required before selecting an action.");
            status = blockedStatus("RECOVERY", fields);
        }
    }
    else if (change.projectionStatus !== undefined &&
        change.projectionStatus !== "healthy" &&
        change.projectionStatus !== "absent") {
        addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_INCOMPLETE", "$.changeProjection.status", "Non-healthy Change projection suppresses normal mutation.");
        status = blockedStatus("CHANGE", fields);
    }
    else if (change.state === "DEFINED") {
        status = { phase: "ISSUE", availability: "actionable", ...fields };
        nextAction = normalAction("ISSUE_CHANGE");
    }
    else if (change.state === "DRAFT") {
        if (readyEligible === true || implementationReady === true) {
            status = { phase: "READY", availability: "actionable", ...fields };
            nextAction = normalAction("READY_CHANGE");
        }
        else {
            status = { phase: "IMPLEMENTATION", availability: "actionable", ...fields };
            nextAction = normalAction("IMPLEMENT");
        }
    }
    else if (change.state === "REVIEW") {
        status = { phase: "REVIEW", availability: "actionable", ...fields };
        if (isRecord(input.review) && input.review.action === "review")
            nextAction = normalAction("REVIEW");
        else
            nextAction = normalAction("WAIT");
    }
    else {
        status = { phase: "TERMINAL", availability: "terminal", ...fields };
    }
    if (executionOutcome === "recovery-required") {
        addDiagnostic(diagnostics, "GOLDEN_PATH_RECOVERY_REQUIRED", "$.executionOutcome", "Recovery execution outcome suppresses normal action.");
        if (status.availability === "actionable") {
            status = { ...status, availability: "blocked" };
            nextAction = null;
        }
    }
    else if (executionOutcome === "failed" || executionOutcome === "compensated") {
        if (status.availability === "actionable") {
            addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_INCOMPLETE", "$.executionOutcome", "Unverified execution outcome suppresses normal mutation.");
            status = { ...status, availability: "blocked" };
            nextAction = null;
        }
    }
    const projection = {
        version: GOLDEN_PATH_STATUS_VERSION,
        ...(subject === undefined || Object.keys(subject).length === 0 ? {} : { subject: cloneImmutable(subject) }),
        status: cloneImmutable(status),
        nextAction: nextAction === null ? null : cloneImmutable(nextAction),
        recovery: outputRecovery === null ? null : cloneImmutable(outputRecovery),
        diagnostics: cloneImmutable(diagnostics),
    };
    return { valid: true, projection: cloneImmutable(projection), diagnostics: [] };
}
/** Non-throwing projection entry point. */
export function tryProjectGoldenPathStatus(input) {
    return parseAndProject(input);
}
/** Throwing projection entry point for Core callers. */
export function projectGoldenPathStatus(input) {
    const result = tryProjectGoldenPathStatus(input);
    if (!result.valid || result.projection === undefined)
        throw new GoldenPathStatusError(result.diagnostics);
    return result.projection;
}
function validateStatusShape(input) {
    const diagnostics = [];
    if (!isRecord(input)) {
        addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$", "Golden Path status must be an object.");
        return diagnostics;
    }
    const allowed = new Set(["version", "subject", "status", "nextAction", "recovery", "diagnostics"]);
    unknownProperties(input, allowed, "$", diagnostics);
    if (input.version !== GOLDEN_PATH_STATUS_VERSION)
        addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.version", "Golden Path status version is unsupported.");
    if (!isRecord(input.status) ||
        !GOLDEN_PATH_PHASES.includes(input.status.phase) ||
        !GOLDEN_PATH_AVAILABILITIES.includes(input.status.availability))
        addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.status", "Status phase or availability is invalid.");
    const availability = isRecord(input.status) ? input.status.availability : undefined;
    if (isRecord(input.status)) {
        const statusKeys = new Set(["phase", "availability", "changeState", "projectionStatus", "executionOutcome"]);
        unknownProperties(input.status, statusKeys, "$.status", diagnostics);
        if (input.status.changeState !== undefined && !CHANGE_STATES.includes(input.status.changeState))
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.status.changeState", "Change state is invalid.");
        if (input.status.projectionStatus !== undefined &&
            !CHANGE_PROJECTION_STATUSES.includes(input.status.projectionStatus))
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.status.projectionStatus", "Projection status is invalid.");
        if (input.status.executionOutcome !== undefined &&
            !CHANGE_REMOTE_EXECUTION_OUTCOMES.includes(input.status.executionOutcome))
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.status.executionOutcome", "Execution outcome is invalid.");
    }
    const action = input.nextAction;
    if (action !== null && !isRecord(action))
        addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.nextAction", "Next action must be an object or null.");
    if (isRecord(action)) {
        unknownProperties(action, new Set(["kind", "owner", "reasonCode", "retryOf"]), "$.nextAction", diagnostics);
        if (!GOLDEN_PATH_ACTION_KINDS.includes(action.kind))
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.nextAction.kind", "Next action kind is invalid.");
        if (!GOLDEN_PATH_ACTION_OWNERS.includes(action.owner))
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.nextAction.owner", "Next action owner is invalid.");
        if (!GOLDEN_PATH_REASON_CODES.includes(action.reasonCode))
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.nextAction.reasonCode", "Next action reason code is invalid.");
        const recoveryEnvelope = availability === "recovery-required" && isRecord(input.recovery);
        const recoveryActionKind = recoveryEnvelope && GOLDEN_PATH_RECOVERY_ACTION_KINDS.includes(action.kind);
        const normalActionKind = !recoveryActionKind && GOLDEN_PATH_NORMAL_ACTION_KINDS.includes(action.kind);
        if (normalActionKind) {
            const expected = GOLDEN_PATH_NORMAL_ACTION_METADATA[action.kind];
            if (action.owner !== expected.owner)
                addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_CONTRADICTORY", "$.nextAction.owner", "Normal action owner does not match its bounded metadata.");
            if (action.reasonCode !== expected.reasonCode)
                addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_CONTRADICTORY", "$.nextAction.reasonCode", "Normal action reason code does not match its bounded metadata.");
        }
        if (recoveryActionKind && isRecord(input.recovery)) {
            if (action.kind !== input.recovery.safeAction || action.owner !== "recovery")
                addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_CONTRADICTORY", "$.nextAction", "Recovery action must mirror recovery.safeAction and be recovery-owned.");
            const expectedReason = input.recovery.reasonCode === undefined
                ? recoveryAction(input.recovery.safeAction).reasonCode
                : input.recovery.reasonCode;
            if (action.reasonCode !== expectedReason)
                addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_CONTRADICTORY", "$.nextAction.reasonCode", "Recovery action reason code does not match recovery evidence.");
            if (Boolean(input.recovery.retryable) !== (input.recovery.safeAction === "RETRY"))
                addDiagnostic(diagnostics, "GOLDEN_PATH_RECOVERY_INVALID", "$.recovery.retryable", "Recovery retryability is inconsistent with safeAction.");
        }
        if (action.retryOf !== undefined &&
            (action.kind !== "RETRY" ||
                !GOLDEN_PATH_NORMAL_ACTION_KINDS.includes(action.retryOf)))
            addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.nextAction.retryOf", "Retry target is invalid.");
        if (recoveryActionKind && action.owner !== "recovery")
            addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_CONTRADICTORY", "$.nextAction.owner", "Recovery action owner must be recovery.");
        if (normalActionKind && action.owner === "recovery")
            addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_CONTRADICTORY", "$.nextAction.owner", "Normal action cannot be owned by recovery.");
    }
    if ((availability === "blocked" || availability === "terminal") && input.nextAction !== null)
        addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_CONTRADICTORY", "$.nextAction", "Blocked and terminal status cannot expose an action.");
    if (availability === "actionable" &&
        (!isRecord(input.nextAction) ||
            !GOLDEN_PATH_NORMAL_ACTION_KINDS.includes(input.nextAction.kind) ||
            input.nextAction.owner === "recovery"))
        addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_CONTRADICTORY", "$.nextAction", "Actionable status requires one normal action.");
    if (availability === "recovery-required" &&
        (!isRecord(input.recovery) ||
            !isRecord(input.nextAction) ||
            !GOLDEN_PATH_RECOVERY_ACTION_KINDS.includes(input.nextAction.kind)))
        addDiagnostic(diagnostics, "GOLDEN_PATH_RECOVERY_INVALID", "$.recovery", "Recovery-required status requires one recovery action.");
    if (availability !== "recovery-required" && input.recovery !== null)
        addDiagnostic(diagnostics, "GOLDEN_PATH_EVIDENCE_CONTRADICTORY", "$.recovery", "Recovery is present outside recovery-required status.");
    if (availability === "recovery-required" && isRecord(input.recovery)) {
        const recoveryDiagnostics = [];
        parseRecovery(input.recovery, recoveryDiagnostics);
        diagnostics.push(...recoveryDiagnostics.slice(0, Math.max(0, MAX_DIAGNOSTICS - diagnostics.length)));
    }
    if (input.subject !== undefined)
        parseSubject(input.subject, "$.subject", diagnostics);
    if (!Array.isArray(input.diagnostics) || input.diagnostics.length > MAX_DIAGNOSTICS)
        addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", "$.diagnostics", "Diagnostics are not bounded.");
    else {
        for (const [index, diagnostic] of input.diagnostics.entries()) {
            if (!isRecord(diagnostic) ||
                typeof diagnostic.code !== "string" ||
                typeof diagnostic.path !== "string" ||
                typeof diagnostic.message !== "string") {
                addDiagnostic(diagnostics, "GOLDEN_PATH_INPUT_INVALID", `$.diagnostics[${index}]`, "Diagnostic is invalid.");
                break;
            }
        }
    }
    return diagnostics;
}
/** Validate a serialized status at a transport boundary without exposing internal runtime types. */
export function validateGoldenPathStatus(input) {
    const diagnostics = validateStatusShape(input);
    if (diagnostics.length > 0)
        return { valid: false, diagnostics };
    const status = cloneImmutable(input);
    return { valid: true, status, projection: status, diagnostics: [] };
}
export const assertGoldenPathStatus = (input) => {
    const result = validateGoldenPathStatus(input);
    if (!result.valid || result.status === undefined)
        throw new GoldenPathStatusError(result.diagnostics);
};
//# sourceMappingURL=golden-path-status.js.map