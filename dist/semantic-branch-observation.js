/**
 * Pure Core observation and drift comparison for semantic branch projections.
 *
 * A Git ref is bounded evidence only.  This module does not derive semantic
 * branch identity, consult Repository Canon, perform GitHub I/O, or mutate
 * GitHub state.  `source` and `generation` are explicit evidence supplied by
 * the observation boundary; neither is guessed from arbitrary provider data.
 */
export const SEMANTIC_BRANCH_OBSERVED_PROJECTION_VERSION = "1";
/** Alias named after the operation for callers that use observation vocabulary. */
export const SEMANTIC_BRANCH_OBSERVATION_VERSION = SEMANTIC_BRANCH_OBSERVED_PROJECTION_VERSION;
export const SEMANTIC_BRANCH_OBSERVATION_LIMITS = Object.freeze({
    refLength: 512,
    nameLength: 255,
    sourceLength: 512,
    shaLength: 64,
    diagnostics: 100,
    diagnosticMessageLength: 500,
});
export class SemanticBranchObservationError extends Error {
    violations;
    constructor(violations) {
        super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
        this.name = "SemanticBranchObservationError";
        this.violations = violations;
    }
}
const OBSERVATION_INPUT_KEYS = new Set(["ref", "object", "source", "generation"]);
const REF_KEYS = new Set(["ref", "object"]);
const OBJECT_KEYS = new Set(["type", "sha"]);
const PROJECTION_KEYS = new Set(["version", "kind", "name", "source", "generation"]);
const DESIRED_PROJECTION_KEYS = new Set([...PROJECTION_KEYS, "provenance"]);
const PROVENANCE_KEYS = new Set(["authority", "repository", "ref", "treeSha", "source"]);
const REPOSITORY_KEYS = new Set(["host", "owner", "name", "nameWithOwner", "repositoryId"]);
const SOURCE_KEYS = new Set(["path", "ref", "sha", "digest"]);
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
function isRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function hasOwn(record, key) {
    return Object.prototype.hasOwnProperty.call(record, key);
}
function compareStrings(left, right) {
    return left.localeCompare(right, "en-US");
}
function addViolation(violations, code, path, message) {
    violations.push({ code, path, message });
}
function unknownProperties(input, allowed, path, violations, code = "OBSERVATION_INPUT_UNKNOWN_PROPERTY") {
    for (const key of Object.keys(input).sort(compareStrings)) {
        if (!allowed.has(key))
            addViolation(violations, code, `${path}.${key}`, `Property "${key}" is not supported.`);
    }
}
function stableSerialize(value, stack = new WeakSet()) {
    if (value === null)
        return "null";
    if (typeof value === "string")
        return JSON.stringify(value);
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new TypeError("Non-finite numbers are not supported.");
        return String(value);
    }
    if (typeof value === "undefined")
        throw new TypeError("Undefined values are not supported.");
    if (typeof value !== "object")
        throw new TypeError("Only JSON-compatible values are supported.");
    if (stack.has(value))
        throw new TypeError("Cyclic JSON data is not supported.");
    stack.add(value);
    let result;
    if (Array.isArray(value))
        result = `[${value.map((entry) => stableSerialize(entry, stack)).join(",")}]`;
    else if (isRecord(value))
        result = `{${Object.keys(value)
            .sort(compareStrings)
            .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], stack)}`)
            .join(",")}}`;
    else
        throw new TypeError("Only plain JSON objects are supported.");
    stack.delete(value);
    return result;
}
function cloneImmutable(value) {
    if (Array.isArray(value))
        return Object.freeze(value.map((entry) => cloneImmutable(entry)));
    if (isRecord(value)) {
        const clone = {};
        for (const key of Object.keys(value).sort(compareStrings))
            clone[key] = cloneImmutable(value[key]);
        return Object.freeze(clone);
    }
    return value;
}
function boundedString(value, path, maxLength, violations, code = "OBSERVED_BRANCH_VALUE_INVALID") {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > maxLength ||
        CONTROL_CHARACTER_PATTERN.test(value)) {
        addViolation(violations, code, path, "Value must be a bounded non-empty string.");
        return undefined;
    }
    return value;
}
function validProvenance(value) {
    if (!isRecord(value) || value.authority !== "repository-default-branch")
        return false;
    if (!isRecord(value.repository) || !isRecord(value.source))
        return false;
    const repository = value.repository;
    const source = value.source;
    return (Object.keys(value).every((key) => PROVENANCE_KEYS.has(key)) &&
        Object.keys(repository).every((key) => REPOSITORY_KEYS.has(key)) &&
        Object.keys(source).every((key) => SOURCE_KEYS.has(key)) &&
        ["host", "owner", "name", "nameWithOwner"].every((key) => typeof repository[key] === "string" && repository[key].length > 0) &&
        (repository.repositoryId === undefined ||
            (typeof repository.repositoryId === "string" && /^[1-9][0-9]{0,19}$/u.test(repository.repositoryId))) &&
        typeof value.ref === "string" &&
        value.ref.length > 0 &&
        typeof value.treeSha === "string" &&
        value.treeSha.length > 0 &&
        ["path", "ref", "sha", "digest"].every((key) => typeof source[key] === "string" && source[key].length > 0));
}
function validRefEvidence(value, path, violations) {
    if (!isRecord(value)) {
        addViolation(violations, "OBSERVED_BRANCH_REF_INVALID", path, "Git ref evidence must be an object.");
        return undefined;
    }
    unknownProperties(value, REF_KEYS, path, violations, "OBSERVED_BRANCH_REF_INVALID");
    const ref = boundedString(value.ref, `${path}.ref`, SEMANTIC_BRANCH_OBSERVATION_LIMITS.refLength, violations, "OBSERVED_BRANCH_REF_INVALID");
    if (ref === undefined || !ref.startsWith("refs/heads/") || ref.length <= "refs/heads/".length) {
        addViolation(violations, "OBSERVED_BRANCH_REF_INVALID", `${path}.ref`, "Git ref must be a non-empty refs/heads ref.");
    }
    if (!isRecord(value.object)) {
        addViolation(violations, "OBSERVED_BRANCH_REF_INVALID", `${path}.object`, "Git ref target must be an object.");
    }
    else {
        unknownProperties(value.object, OBJECT_KEYS, `${path}.object`, violations, "OBSERVED_BRANCH_REF_INVALID");
        if (value.object.type !== "commit")
            addViolation(violations, "OBSERVED_BRANCH_REF_INVALID", `${path}.object.type`, "Git ref target must be a commit.");
        if (typeof value.object.sha !== "string" || !SHA_PATTERN.test(value.object.sha))
            addViolation(violations, "OBSERVED_BRANCH_REF_INVALID", `${path}.object.sha`, "Git commit SHA is invalid.");
    }
    return ref;
}
function observationInput(input, violations) {
    if (!isRecord(input)) {
        addViolation(violations, "OBSERVATION_INPUT_INVALID", "$", "Branch observation input must be an object.");
        return undefined;
    }
    unknownProperties(input, OBSERVATION_INPUT_KEYS, "$", violations);
    const refInput = typeof input.ref === "string" ? { ref: input.ref, object: input.object } : input.ref;
    const ref = validRefEvidence(refInput, "$.ref", violations);
    const source = boundedString(input.source, "$.source", SEMANTIC_BRANCH_OBSERVATION_LIMITS.sourceLength, violations);
    if (!validProvenance(input.generation))
        addViolation(violations, "OBSERVED_BRANCH_GENERATION_INVALID", "$.generation", "Observed generation must be valid repository provenance.");
    if (ref === undefined || source === undefined || !validProvenance(input.generation))
        return undefined;
    return { ref, source, generation: input.generation };
}
function invalidResult(violations) {
    return { valid: false, violations };
}
/** Normalize bounded Git ref evidence into an immutable observed projection. */
export function tryObserveSemanticBranch(input) {
    const violations = [];
    const normalized = observationInput(input, violations);
    if (normalized === undefined || violations.length > 0)
        return invalidResult(violations);
    const name = normalized.ref.slice("refs/heads/".length);
    if (name.length > SEMANTIC_BRANCH_OBSERVATION_LIMITS.nameLength || CONTROL_CHARACTER_PATTERN.test(name)) {
        addViolation(violations, "OBSERVED_BRANCH_VALUE_INVALID", "$.ref.ref", "Observed branch name is invalid.");
        return invalidResult(violations);
    }
    const projection = {
        version: SEMANTIC_BRANCH_OBSERVED_PROJECTION_VERSION,
        kind: "branch",
        name,
        source: normalized.source,
        generation: normalized.generation,
    };
    return { valid: true, projection: cloneImmutable(projection), violations: [] };
}
/** Throwing observation entry point for Core callers. */
export function observeSemanticBranch(input) {
    const result = tryObserveSemanticBranch(input);
    if (!result.valid || result.projection === undefined)
        throw new SemanticBranchObservationError(result.violations);
    return result.projection;
}
export const tryObserveSemanticBranchProjection = tryObserveSemanticBranch;
export const observeSemanticBranchProjection = observeSemanticBranch;
function validObservedProjection(input) {
    if (!isRecord(input))
        return false;
    return (Object.keys(input).every((key) => PROJECTION_KEYS.has(key)) &&
        input.version === SEMANTIC_BRANCH_OBSERVED_PROJECTION_VERSION &&
        input.kind === "branch" &&
        typeof input.name === "string" &&
        input.name.length > 0 &&
        input.name.length <= SEMANTIC_BRANCH_OBSERVATION_LIMITS.nameLength &&
        !CONTROL_CHARACTER_PATTERN.test(input.name) &&
        typeof input.source === "string" &&
        input.source.length > 0 &&
        input.source.length <= SEMANTIC_BRANCH_OBSERVATION_LIMITS.sourceLength &&
        !CONTROL_CHARACTER_PATTERN.test(input.source) &&
        validProvenance(input.generation));
}
function validDesiredProjection(input) {
    if (!isRecord(input))
        return false;
    return (Object.keys(input).every((key) => DESIRED_PROJECTION_KEYS.has(key)) &&
        input.version === "1" &&
        input.kind === "branch" &&
        typeof input.name === "string" &&
        input.name.length > 0 &&
        input.name.length <= SEMANTIC_BRANCH_OBSERVATION_LIMITS.nameLength &&
        !CONTROL_CHARACTER_PATTERN.test(input.name) &&
        typeof input.source === "string" &&
        input.source.length > 0 &&
        input.source.length <= SEMANTIC_BRANCH_OBSERVATION_LIMITS.sourceLength &&
        !CONTROL_CHARACTER_PATTERN.test(input.source) &&
        validProvenance(input.provenance) &&
        validProvenance(input.generation) &&
        stableSerialize(input.provenance) === stableSerialize(input.generation));
}
function addDrift(diagnostics, code, path, message, expected, actual) {
    if (diagnostics.length >= SEMANTIC_BRANCH_OBSERVATION_LIMITS.diagnostics)
        return;
    diagnostics.push({
        code,
        path,
        message,
        ...(expected === undefined ? {} : { expected }),
        ...(actual === undefined ? {} : { actual }),
    });
}
function comparisonResult(diagnostics) {
    return { valid: diagnostics.length === 0, diagnostics, drift: diagnostics };
}
function validateProjectionInput(input, desired, diagnostics) {
    if ((desired ? validDesiredProjection : validObservedProjection)(input))
        return;
    addDrift(diagnostics, desired ? "DESIRED_PROJECTION_INVALID" : "OBSERVED_PROJECTION_INVALID", "$", desired ? "Desired branch projection is invalid." : "Observed branch projection is invalid.");
}
/** Compare Core desired branch state with bounded observed evidence. */
export function compareSemanticBranchProjection(desired, observed) {
    let desiredInput = desired;
    let observedInput = observed;
    if (observed === undefined && isRecord(desired) && hasOwn(desired, "desired") && hasOwn(desired, "observed")) {
        desiredInput = desired.desired;
        observedInput = desired.observed;
    }
    const diagnostics = [];
    validateProjectionInput(desiredInput, true, diagnostics);
    validateProjectionInput(observedInput, false, diagnostics);
    if (diagnostics.length > 0)
        return comparisonResult(diagnostics);
    const expected = desiredInput;
    const actual = observedInput;
    if (expected.name !== actual.name)
        addDrift(diagnostics, "NAME_DRIFT", "$.name", "Observed branch name differs from the desired projection.", expected.name, actual.name);
    if (expected.source !== actual.source)
        addDrift(diagnostics, "SOURCE_DRIFT", "$.source", "Observed branch source differs from the desired projection.", expected.source, actual.source);
    if (stableSerialize(expected.generation) !== stableSerialize(actual.generation))
        addDrift(diagnostics, "GENERATION_DRIFT", "$.generation", "Observed branch generation differs from the desired projection.", expected.generation, actual.generation);
    return comparisonResult(diagnostics);
}
export const compareSemanticBranchObservation = compareSemanticBranchProjection;
export const compareSemanticBranchProjectionDrift = compareSemanticBranchProjection;
//# sourceMappingURL=semantic-branch-observation.js.map