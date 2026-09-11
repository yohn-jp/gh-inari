/**
 * Pure Core observation and drift comparison for semantic Issue projections.
 *
 * GitHubIssue is a bounded, transport-normalized read model.  Native Issue
 * relation evidence is supplied by an adapter; this module never performs
 * GitHub I/O or mutation.  Body markers are accepted only when they use the
 * reserved Inari machine convention, so ordinary prose is never interpreted
 * as a semantic relationship.
 */
import { issueReferenceKey, normalizeIssueReference, validateIssueDependencies, } from "./contract/issue-reference.js";
import { extractIssueDependencyMarker } from "./artifact.js";
export const SEMANTIC_ISSUE_OBSERVED_PROJECTION_VERSION = "1";
/** Alias named after the observation operation for consumers using that vocabulary. */
export const SEMANTIC_ISSUE_OBSERVATION_VERSION = SEMANTIC_ISSUE_OBSERVED_PROJECTION_VERSION;
export const SEMANTIC_ISSUE_OBSERVATION_LIMITS = Object.freeze({
    bodyBytes: 1_048_576,
    titleLength: 255,
    urlLength: 2_048,
    metadataValueLength: 512,
    relationReferences: 1_000,
    diagnostics: 100,
    diagnosticMessageLength: 500,
    diagnosticValueLength: 512,
    markerLength: 32_768,
});
export class SemanticIssueObservationError extends Error {
    violations;
    constructor(violations) {
        super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
        this.name = "SemanticIssueObservationError";
        this.violations = violations;
    }
}
const OBSERVATION_INPUT_KEYS = new Set([
    "issue",
    "repository",
    "relations",
    "relationEvidence",
    "nativeParent",
    "nativeDependsOn",
    "nativeBlockedBy",
]);
const OBSERVATION_OPTIONS_KEYS = new Set([
    "repository",
    "relations",
    "relationEvidence",
    "nativeParent",
    "nativeDependsOn",
    "nativeBlockedBy",
]);
const ISSUE_KEYS = new Set([
    "number",
    "title",
    "body",
    "state",
    "url",
    "labels",
    "assignees",
    "milestone",
    "repositoryId",
    "repositoryHost",
    "repository",
]);
const REPOSITORY_KEYS = new Set(["host", "hostname", "repositoryHost", "repositoryId", "repository", "nameWithOwner"]);
const RELATIONS_KEYS = new Set(["parent", "dependsOn", "blockedBy"]);
const RELATION_EVIDENCE_KEYS = new Set(["native", "blockedBy", "bodyFallback"]);
const OBSERVED_PROJECTION_KEYS = new Set([
    "version",
    "kind",
    "number",
    "state",
    "url",
    "title",
    "body",
    "metadata",
    "relations",
]);
const OBSERVED_METADATA_KEYS = new Set(["labels", "assignees", "milestone"]);
const OBSERVED_RELATIONS_KEYS = new Set(["parent", "dependsOn"]);
const OBSERVED_PARENT_KEYS = new Set(["relation", "reference", "representation", "evidence"]);
const OBSERVED_DEPENDS_ON_KEYS = new Set(["relation", "references", "representation", "evidence"]);
const OBSERVED_EVIDENCE_KEYS = new Set(["native", "bodyFallback"]);
const DESIRED_PROJECTION_KEYS = new Set([
    "version",
    "kind",
    "title",
    "body",
    "metadata",
    "relations",
    "provenance",
    "generation",
]);
const DESIRED_METADATA_KEYS = new Set(["labels", "assignees", "milestone"]);
const DESIRED_RELATIONS_KEYS = new Set(["parent", "dependsOn"]);
const DESIRED_PARENT_KEYS = new Set(["relation", "reference", "representation"]);
const DESIRED_DEPENDS_ON_KEYS = new Set(["relation", "references", "representation"]);
const RELATION_REPRESENTATIONS = new Set([
    "none",
    "native",
    "body-fallback",
    "conflict",
]);
const DESIRED_RELATION_REPRESENTATIONS = new Set([
    "none",
    "native",
    "body-fallback",
]);
const MARKER_PREFIX = "<!-- inari:semantic-relation ";
const MARKER_SUFFIX = " -->";
const MARKER_PATTERN = /^<!-- inari:semantic-relation (\{.*\}) -->$/u;
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
function compareIssueReferences(left, right) {
    return (left.repositoryHost.localeCompare(right.repositoryHost, "en-US") ||
        left.repositoryId.localeCompare(right.repositoryId, "en-US") ||
        left.number - right.number);
}
function boundedMessage(value) {
    const normalized = value.replace(/\s+/gu, " ").trim();
    return normalized.length > SEMANTIC_ISSUE_OBSERVATION_LIMITS.diagnosticMessageLength
        ? `${normalized.slice(0, SEMANTIC_ISSUE_OBSERVATION_LIMITS.diagnosticMessageLength)}…`
        : normalized;
}
function addViolation(violations, code, path, message) {
    if (violations.length < SEMANTIC_ISSUE_OBSERVATION_LIMITS.diagnostics)
        violations.push({ code, path, message: boundedMessage(message) });
}
function unknownProperties(input, allowed, path, violations, code) {
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
        return "undefined";
    if (typeof value !== "object")
        throw new TypeError("Only JSON-compatible values are supported.");
    if (stack.has(value))
        throw new TypeError("Cyclic JSON data is not supported.");
    stack.add(value);
    const result = Array.isArray(value)
        ? `[${value.map((entry) => stableSerialize(entry, stack)).join(",")}]`
        : isRecord(value)
            ? `{${Object.keys(value)
                .sort(compareStrings)
                .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], stack)}`)
                .join(",")}}`
            : (() => {
                throw new TypeError("Only plain JSON objects are supported.");
            })();
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
function requiredString(value, path, violations, maxLength, code = "OBSERVED_ISSUE_VALUE_INVALID") {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > maxLength ||
        /[\u0000-\u001F\u007F]/u.test(value)) {
        addViolation(violations, code, path, "Value must be a bounded non-empty string.");
        return undefined;
    }
    return value;
}
function bodyValue(value, path, violations) {
    if (value !== null && typeof value !== "string") {
        addViolation(violations, "OBSERVED_BODY_INVALID", path, "Issue body must be a string or null.");
        return undefined;
    }
    const body = value ?? "";
    if (Buffer.byteLength(body, "utf8") > SEMANTIC_ISSUE_OBSERVATION_LIMITS.bodyBytes) {
        addViolation(violations, "OBSERVED_BODY_INVALID", path, "Issue body exceeds the bounded observation limit.");
        return undefined;
    }
    return body;
}
function stringArray(value, path, violations) {
    if (!Array.isArray(value)) {
        addViolation(violations, "OBSERVED_ISSUE_VALUE_INVALID", path, "Value must be an array of strings.");
        return undefined;
    }
    if (value.length > SEMANTIC_ISSUE_OBSERVATION_LIMITS.relationReferences) {
        addViolation(violations, "OBSERVED_ISSUE_VALUE_INVALID", path, "Value exceeds the bounded item limit.");
        return undefined;
    }
    const result = [];
    const seen = new Set();
    value.forEach((entry, index) => {
        const parsed = requiredString(entry, `${path}[${index}]`, violations, SEMANTIC_ISSUE_OBSERVATION_LIMITS.metadataValueLength);
        if (parsed === undefined)
            return;
        if (seen.has(parsed)) {
            addViolation(violations, "OBSERVED_ISSUE_VALUE_INVALID", `${path}[${index}]`, "Values must be unique.");
            return;
        }
        seen.add(parsed);
        result.push(parsed);
    });
    return result.sort(compareStrings);
}
function normalizeReferences(value, path, violations, allowSingle = false) {
    const values = allowSingle && !Array.isArray(value) ? [value] : value;
    if (!Array.isArray(values)) {
        addViolation(violations, "OBSERVED_RELATION_REFERENCE_INVALID", path, "Relation references must be an array of IssueReference values.");
        return undefined;
    }
    if (values.length > SEMANTIC_ISSUE_OBSERVATION_LIMITS.relationReferences) {
        addViolation(violations, "OBSERVED_RELATION_REFERENCE_INVALID", path, "Relation references exceed the bounded item limit.");
        return undefined;
    }
    const result = [];
    const seen = new Set();
    values.forEach((entry, index) => {
        const normalized = normalizeIssueReference(entry, `${path}[${index}]`);
        if (!normalized.valid || normalized.reference === undefined) {
            addViolation(violations, "OBSERVED_RELATION_REFERENCE_INVALID", `${path}[${index}]`, "IssueReference is invalid.");
            return;
        }
        const key = issueReferenceKey(normalized.reference);
        if (seen.has(key)) {
            addViolation(violations, "OBSERVED_RELATION_REFERENCE_INVALID", `${path}[${index}]`, "Issue references must be unique.");
            return;
        }
        seen.add(key);
        result.push(normalized.reference);
    });
    return result.sort(compareIssueReferences);
}
function sameReference(left, right) {
    return left === undefined || right === undefined
        ? left === right
        : issueReferenceKey(left) === issueReferenceKey(right);
}
function sameReferences(left, right) {
    return (left.length === right.length &&
        left.every((reference, index) => issueReferenceKey(reference) === issueReferenceKey(right[index])));
}
function repositoryIdentity(input, issue, path, violations) {
    const values = isRecord(input) ? input : {};
    if (isRecord(input))
        unknownProperties(input, REPOSITORY_KEYS, path, violations, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
    const host = values.host ?? values.hostname ?? values.repositoryHost ?? issue.repositoryHost;
    const repositoryId = values.repositoryId ?? issue.repositoryId;
    const repository = values.repository ?? values.nameWithOwner ?? issue.repository;
    if (host === undefined && repositoryId === undefined && repository === undefined)
        return undefined;
    if (typeof host !== "string" || host.length === 0 || /[\s/]/u.test(host))
        addViolation(violations, "OBSERVED_RELATION_INVALID", `${path}.host`, "Repository host is invalid.");
    if (typeof repositoryId !== "string" || !/^[1-9][0-9]{0,19}$/u.test(repositoryId))
        addViolation(violations, "OBSERVED_RELATION_INVALID", `${path}.repositoryId`, "Repository identity is invalid.");
    if (repository !== undefined &&
        (typeof repository !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repository)))
        addViolation(violations, "OBSERVED_RELATION_INVALID", `${path}.repository`, "Repository locator is invalid.");
    if (typeof host !== "string" || typeof repositoryId !== "string" || !/^[1-9][0-9]{0,19}$/u.test(repositoryId))
        return undefined;
    return {
        host: host.toLocaleLowerCase("en-US"),
        repositoryId,
        ...(typeof repository === "string" ? { repository: repository.toLocaleLowerCase("en-US") } : {}),
    };
}
function issueReferenceFromMarker(value, repository, path, violations) {
    const normalized = normalizeIssueReference(value, path);
    if (normalized.valid && normalized.reference !== undefined)
        return normalized.reference;
    // Markers produced by Core contain full IssueReference values.  Locator or
    // shorthand values are deliberately not recovered from body prose.
    addViolation(violations, "OBSERVED_RELATION_MARKER_INVALID", path, "Relation marker contains an invalid IssueReference.");
    return undefined;
}
function markerCandidates(body, violations) {
    const candidates = [];
    let offset = 0;
    let fence;
    for (const line of body.split(/\r\n|\r|\n/u)) {
        const leading = line.match(/^[ \t]*/u)?.[0] ?? "";
        const content = line.slice(leading.length);
        const fenceMatch = /^(?<character>`|~)\k<character>\k<character>+/u.exec(content);
        if (fence !== undefined) {
            if (fenceMatch !== null &&
                fenceMatch.groups?.character === fence.character &&
                content.split(fence.character)[0] === "") {
                const count = content.match(new RegExp(`^${fence.character}+`, "u"))?.[0].length ?? 0;
                if (count >= fence.length && /^(`+|~+)\s*$/u.test(content))
                    fence = undefined;
            }
            offset += line.length + 1;
            continue;
        }
        if (leading.length <= 3 && fenceMatch !== null && /^(`+|~+)\s*$/u.test(content)) {
            fence = {
                character: fenceMatch.groups?.character,
                length: content.match(/^(`+|~+)/u)?.[0].length ?? 3,
            };
            offset += line.length + 1;
            continue;
        }
        if (leading.length <= 3 && !content.startsWith(">")) {
            const semantic = MARKER_PATTERN.exec(content);
            if (semantic !== null) {
                if (content.length > SEMANTIC_ISSUE_OBSERVATION_LIMITS.markerLength)
                    addViolation(violations, "OBSERVED_RELATION_MARKER_INVALID", `$.issue.body@${offset}`, "Semantic relation marker is oversized.");
                else {
                    try {
                        candidates.push({
                            kind: "semantic",
                            payload: JSON.parse(semantic[1]),
                            path: `$.issue.body@${offset}`,
                        });
                    }
                    catch {
                        addViolation(violations, "OBSERVED_RELATION_MARKER_INVALID", `$.issue.body@${offset}`, "Semantic relation marker is not valid JSON.");
                    }
                }
            }
            else if (content.startsWith(MARKER_PREFIX)) {
                addViolation(violations, "OBSERVED_RELATION_MARKER_INVALID", `$.issue.body@${offset}`, "Reserved relation marker is malformed.");
            }
        }
        offset += line.length + 1;
    }
    return candidates;
}
function parseBodyRelations(body, repository, violations) {
    const parents = [];
    const dependencyCandidates = [];
    const dependencyMarker = extractIssueDependencyMarker(body);
    if (dependencyMarker.status === "malformed" || dependencyMarker.status === "unsupported-version")
        addViolation(violations, "OBSERVED_RELATION_MARKER_INVALID", "$.issue.body", "Issue dependency marker is malformed or unsupported.");
    else if (dependencyMarker.status === "valid" && dependencyMarker.dependencies !== undefined) {
        const parsed = validateIssueDependencies(dependencyMarker.dependencies);
        if (!parsed.valid || parsed.dependencies.blocks.length > 0)
            addViolation(violations, "OBSERVED_RELATION_MARKER_INVALID", "$.issue.body", "Issue dependency marker is invalid or contains unsupported blocks evidence.");
        else
            dependencyCandidates.push([...parsed.dependencies.blockedBy]);
    }
    for (const marker of markerCandidates(body, violations)) {
        if (!isRecord(marker.payload)) {
            addViolation(violations, "OBSERVED_RELATION_MARKER_INVALID", marker.path, "Relation marker payload must be an object.");
            continue;
        }
        if (marker.kind === "semantic") {
            unknownProperties(marker.payload, new Set(["version", "parent", "dependsOn"]), marker.path, violations, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
            if (marker.payload.version !== "1") {
                addViolation(violations, "OBSERVED_RELATION_MARKER_INVALID", `${marker.path}.version`, "Semantic relation marker version is unsupported.");
                continue;
            }
            if (hasOwn(marker.payload, "parent")) {
                const reference = issueReferenceFromMarker(marker.payload.parent, repository, `${marker.path}.parent`, violations);
                if (reference !== undefined)
                    parents.push(reference);
            }
            if (hasOwn(marker.payload, "dependsOn")) {
                const references = normalizeReferences(marker.payload.dependsOn, `${marker.path}.dependsOn`, violations);
                if (references !== undefined)
                    dependencyCandidates.push([...references]);
            }
        }
    }
    const parent = parents[0];
    const parentConflict = parents.some((reference) => !sameReference(parent, reference));
    const dependsOn = dependencyCandidates[0] ?? [];
    const dependencyConflict = dependencyCandidates.some((references) => !sameReferences(dependsOn, references));
    return { parent, dependsOn, conflict: parentConflict || dependencyConflict };
}
function relationInput(input, path, violations) {
    if (input === undefined)
        return {};
    if (!isRecord(input))
        return { native: input };
    // The compact relation API accepts an IssueReference directly.  It must not
    // be mistaken for the `{ native, bodyFallback }` evidence wrapper, whose
    // unknown-property check would otherwise discard the identity fields.
    if (hasOwn(input, "repositoryHost") || hasOwn(input, "repositoryId") || hasOwn(input, "number"))
        return { native: input };
    unknownProperties(input, RELATION_EVIDENCE_KEYS, path, violations, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
    return {
        native: input.native ?? input.blockedBy,
        bodyFallback: input.bodyFallback,
    };
}
function observationRelations(input, violations) {
    const relations = input.relations;
    const relationEvidence = input.relationEvidence;
    if (relations !== undefined && relationEvidence !== undefined) {
        addViolation(violations, "OBSERVATION_INPUT_INVALID", "$.relations", "Relations and relationEvidence cannot both be supplied.");
        return undefined;
    }
    const selected = relations ?? relationEvidence;
    if (selected === undefined &&
        input.nativeParent === undefined &&
        input.nativeDependsOn === undefined &&
        input.nativeBlockedBy === undefined)
        return undefined;
    const result = isRecord(selected) ? { ...selected } : {};
    if (input.nativeParent !== undefined)
        result.parent = { ...(isRecord(result.parent) ? result.parent : {}), native: input.nativeParent };
    if (input.nativeDependsOn !== undefined)
        result.dependsOn = { ...(isRecord(result.dependsOn) ? result.dependsOn : {}), native: input.nativeDependsOn };
    if (input.nativeBlockedBy !== undefined)
        result.dependsOn = { ...(isRecord(result.dependsOn) ? result.dependsOn : {}), native: input.nativeBlockedBy };
    if (isRecord(result) && result.blockedBy !== undefined) {
        if (result.dependsOn !== undefined) {
            addViolation(violations, "OBSERVATION_INPUT_INVALID", "$.relations.blockedBy", "Use either relations.dependsOn or relations.blockedBy, not both.");
        }
        else
            result.dependsOn = result.blockedBy;
        delete result.blockedBy;
    }
    if (!isRecord(result))
        return undefined;
    unknownProperties(result, RELATIONS_KEYS, "$.relations", violations, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
    return {
        ...(result.parent === undefined ? {} : { parent: result.parent }),
        ...(result.dependsOn === undefined ? {} : { dependsOn: result.dependsOn }),
    };
}
function observationRequest(input, options, violations) {
    if (options !== undefined) {
        if (!isRecord(options)) {
            addViolation(violations, "OBSERVATION_INPUT_INVALID", "$", "Observation options must be an object.");
            return undefined;
        }
        unknownProperties(options, OBSERVATION_OPTIONS_KEYS, "$", violations, "OBSERVATION_INPUT_UNKNOWN_PROPERTY");
        return { issue: input, repository: options.repository, relations: observationRelations(options, violations) };
    }
    if (isRecord(input) && hasOwn(input, "issue")) {
        unknownProperties(input, OBSERVATION_INPUT_KEYS, "$", violations, "OBSERVATION_INPUT_UNKNOWN_PROPERTY");
        return { issue: input.issue, repository: input.repository, relations: observationRelations(input, violations) };
    }
    return { issue: input };
}
function validateIssueEvidence(input, violations) {
    if (!isRecord(input)) {
        addViolation(violations, "OBSERVED_ISSUE_INVALID", "$.issue", "Issue evidence must be an object.");
        return undefined;
    }
    unknownProperties(input, ISSUE_KEYS, "$.issue", violations, "OBSERVED_ISSUE_UNKNOWN_PROPERTY");
    const title = requiredString(input.title, "$.issue.title", violations, SEMANTIC_ISSUE_OBSERVATION_LIMITS.titleLength);
    const body = bodyValue(input.body, "$.issue.body", violations);
    let number;
    if (input.number !== undefined) {
        if (typeof input.number !== "number" || !Number.isSafeInteger(input.number) || input.number < 1)
            addViolation(violations, "OBSERVED_ISSUE_VALUE_INVALID", "$.issue.number", "Issue number is invalid.");
        else
            number = input.number;
    }
    let state;
    if (input.state !== undefined) {
        if (input.state !== "open" && input.state !== "closed")
            addViolation(violations, "OBSERVED_ISSUE_VALUE_INVALID", "$.issue.state", "Issue state is invalid.");
        else
            state = input.state;
    }
    let url;
    if (input.url !== undefined)
        url = requiredString(input.url, "$.issue.url", violations, SEMANTIC_ISSUE_OBSERVATION_LIMITS.urlLength);
    const metadata = {};
    for (const key of ["labels", "assignees"]) {
        if (!hasOwn(input, key))
            continue;
        const values = stringArray(input[key], `$.issue.${key}`, violations);
        if (values !== undefined)
            metadata[key] = values;
    }
    if (hasOwn(input, "milestone")) {
        if (input.milestone === null) {
            // A null milestone is absence, not a semantic empty string.
        }
        else if (!isRecord(input.milestone))
            addViolation(violations, "OBSERVED_ISSUE_VALUE_INVALID", "$.issue.milestone", "Milestone must be an object or null.");
        else {
            unknownProperties(input.milestone, new Set(["number", "title"]), "$.issue.milestone", violations, "OBSERVED_ISSUE_UNKNOWN_PROPERTY");
            if (typeof input.milestone.number !== "number" ||
                !Number.isSafeInteger(input.milestone.number) ||
                input.milestone.number < 1)
                addViolation(violations, "OBSERVED_ISSUE_VALUE_INVALID", "$.issue.milestone.number", "Milestone number is invalid.");
            const milestone = requiredString(input.milestone.title, "$.issue.milestone.title", violations, SEMANTIC_ISSUE_OBSERVATION_LIMITS.metadataValueLength);
            if (milestone !== undefined)
                metadata.milestone = milestone;
        }
    }
    if (violations.length > 0 || title === undefined || body === undefined)
        return undefined;
    return {
        ...(number === undefined ? {} : { number }),
        ...(state === undefined ? {} : { state }),
        ...(url === undefined ? {} : { url }),
        title,
        body,
        metadata: metadata,
        repositoryInput: {
            ...(input.repositoryHost === undefined ? {} : { repositoryHost: input.repositoryHost }),
            ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
            ...(input.repository === undefined ? {} : { repository: input.repository }),
        },
    };
}
function emptyObservation(violations) {
    return { valid: false, violations };
}
function buildObservedProjection(request, violations) {
    const evidence = validateIssueEvidence(request.issue, violations);
    if (evidence === undefined)
        return emptyObservation(violations);
    const issue = isRecord(request.issue) ? request.issue : {};
    const repository = repositoryIdentity(request.repository ?? evidence.repositoryInput, issue, "$.repository", violations);
    const parsed = parseBodyRelations(evidence.body, repository, violations);
    const relationValues = request.relations ?? {};
    const parentInput = relationInput(relationValues.parent, "$.relations.parent", violations);
    const dependsOnInput = relationInput(relationValues.dependsOn, "$.relations.dependsOn", violations);
    const nativeParentValues = parentInput.native === undefined
        ? []
        : (normalizeReferences(parentInput.native, "$.relations.parent.native", violations, true) ?? []);
    const bodyParentValues = parentInput.bodyFallback === undefined
        ? parsed.parent === undefined
            ? []
            : [parsed.parent]
        : (normalizeReferences(parentInput.bodyFallback, "$.relations.parent.bodyFallback", violations, true) ?? []);
    const nativeDependsOn = dependsOnInput.native === undefined
        ? undefined
        : normalizeReferences(dependsOnInput.native, "$.relations.dependsOn.native", violations);
    const bodyDependsOn = dependsOnInput.bodyFallback === undefined
        ? parsed.dependsOn
        : (normalizeReferences(dependsOnInput.bodyFallback, "$.relations.dependsOn.bodyFallback", violations) ?? []);
    const nativeParent = nativeParentValues[0];
    const bodyParent = bodyParentValues[0];
    const parentConflict = nativeParentValues.length > 1 ||
        bodyParentValues.length > 1 ||
        // An explicitly observed native empty set is still evidence.  Treating it
        // as "missing" would allow a stale body fallback marker to override the
        // provider's authoritative empty relation.
        (parentInput.native !== undefined &&
            ((nativeParent === undefined && bodyParent !== undefined) ||
                (nativeParent !== undefined && bodyParent !== undefined && !sameReference(nativeParent, bodyParent))));
    const dependsConflict = parsed.conflict || (nativeDependsOn !== undefined && !sameReferences(nativeDependsOn, bodyDependsOn));
    const parentEvidence = {
        ...(nativeParent === undefined ? {} : { native: nativeParent }),
        ...(bodyParent === undefined ? {} : { bodyFallback: bodyParent }),
    };
    const dependsEvidence = {
        ...(nativeDependsOn === undefined ? {} : { native: nativeDependsOn }),
        bodyFallback: bodyDependsOn,
    };
    const parentRelation = {
        relation: "parent",
        ...(parentConflict
            ? {}
            : nativeParent !== undefined
                ? { reference: nativeParent }
                : bodyParent !== undefined
                    ? { reference: bodyParent }
                    : {}),
        representation: parentConflict
            ? "conflict"
            : nativeParent !== undefined
                ? "native"
                : bodyParent !== undefined
                    ? "body-fallback"
                    : "none",
        evidence: parentEvidence,
    };
    const selectedDependsOn = nativeDependsOn !== undefined && nativeDependsOn.length > 0 ? nativeDependsOn : bodyDependsOn;
    const dependsRelation = {
        relation: "dependsOn",
        references: dependsConflict ? [] : selectedDependsOn,
        representation: dependsConflict
            ? "conflict"
            : nativeDependsOn !== undefined && nativeDependsOn.length > 0
                ? "native"
                : bodyDependsOn.length > 0
                    ? "body-fallback"
                    : "none",
        evidence: dependsEvidence,
    };
    if (violations.length > 0)
        return emptyObservation(violations);
    const projection = {
        version: SEMANTIC_ISSUE_OBSERVED_PROJECTION_VERSION,
        kind: "issue",
        ...(evidence.number === undefined ? {} : { number: evidence.number }),
        ...(evidence.state === undefined ? {} : { state: evidence.state }),
        ...(evidence.url === undefined ? {} : { url: evidence.url }),
        title: evidence.title,
        body: evidence.body,
        metadata: evidence.metadata,
        relations: { parent: parentRelation, dependsOn: dependsRelation },
    };
    return { valid: true, projection: cloneImmutable(projection), violations: [] };
}
/** Normalize a bounded GitHubIssue observation into Core evidence. */
export function tryObserveSemanticIssue(input, options) {
    const violations = [];
    const request = observationRequest(input, options, violations);
    if (request === undefined)
        return emptyObservation(violations);
    return buildObservedProjection(request, violations);
}
export function observeSemanticIssue(input, options) {
    const result = tryObserveSemanticIssue(input, options);
    if (!result.valid || result.projection === undefined)
        throw new SemanticIssueObservationError(result.violations);
    return result.projection;
}
export const tryObserveSemanticIssueProjection = tryObserveSemanticIssue;
export const observeSemanticIssueProjection = observeSemanticIssue;
export const tryObserveIssueProjection = tryObserveSemanticIssue;
export const observeIssueProjection = observeSemanticIssue;
export const observeGitHubIssueProjection = observeSemanticIssue;
function diagnosticFromViolation(violation, code) {
    return { code, path: violation.path, message: violation.message };
}
function desiredProjectionValidation(input) {
    const diagnostics = [];
    if (!isRecord(input))
        return {
            diagnostics: [
                { code: "DESIRED_PROJECTION_INVALID", path: "$", message: "Desired Issue projection must be an object." },
            ],
        };
    for (const key of Object.keys(input).sort(compareStrings))
        if (!DESIRED_PROJECTION_KEYS.has(key))
            diagnostics.push({ code: "DESIRED_PROJECTION_INVALID", path: `$.${key}`, message: "Property is not supported." });
    const local = [];
    if (input.version !== "1")
        addViolation(local, "OBSERVED_ISSUE_VALUE_INVALID", "$.version", "Desired projection version is unsupported.");
    if (input.kind !== "issue")
        addViolation(local, "OBSERVED_ISSUE_VALUE_INVALID", "$.kind", "Desired projection kind is invalid.");
    const title = requiredString(input.title, "$.title", local, SEMANTIC_ISSUE_OBSERVATION_LIMITS.titleLength);
    const body = bodyValue(input.body, "$.body", local);
    const metadata = {};
    if (!isRecord(input.metadata))
        addViolation(local, "OBSERVED_ISSUE_VALUE_INVALID", "$.metadata", "Desired metadata must be an object.");
    else {
        unknownProperties(input.metadata, DESIRED_METADATA_KEYS, "$.metadata", local, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
        for (const key of ["labels", "assignees"])
            if (hasOwn(input.metadata, key)) {
                const values = stringArray(input.metadata[key], `$.metadata.${key}`, local);
                if (values !== undefined)
                    metadata[key] = values;
            }
        if (hasOwn(input.metadata, "milestone")) {
            const milestone = requiredString(input.metadata.milestone, "$.metadata.milestone", local, SEMANTIC_ISSUE_OBSERVATION_LIMITS.metadataValueLength);
            if (milestone !== undefined)
                metadata.milestone = milestone;
        }
    }
    if (!isRecord(input.relations))
        addViolation(local, "OBSERVED_RELATION_INVALID", "$.relations", "Desired relations must be an object.");
    let parent;
    let dependsOn;
    if (isRecord(input.relations)) {
        unknownProperties(input.relations, DESIRED_RELATIONS_KEYS, "$.relations", local, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
        if (!isRecord(input.relations.parent))
            addViolation(local, "OBSERVED_RELATION_INVALID", "$.relations.parent", "Desired parent relation must be an object.");
        else
            parent = input.relations.parent;
        if (!isRecord(input.relations.dependsOn))
            addViolation(local, "OBSERVED_RELATION_INVALID", "$.relations.dependsOn", "Desired dependsOn relation must be an object.");
        else
            dependsOn = input.relations.dependsOn;
    }
    if (parent !== undefined) {
        unknownProperties(parent, DESIRED_PARENT_KEYS, "$.relations.parent", local, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
        if (parent.relation !== "parent")
            addViolation(local, "OBSERVED_RELATION_INVALID", "$.relations.parent.relation", "Relation kind must be parent.");
        if (!DESIRED_RELATION_REPRESENTATIONS.has(parent.representation))
            addViolation(local, "OBSERVED_RELATION_INVALID", "$.relations.parent.representation", "Relation representation is invalid.");
        if (hasOwn(parent, "reference") && normalizeIssueReference(parent.reference).valid === false)
            addViolation(local, "OBSERVED_RELATION_REFERENCE_INVALID", "$.relations.parent.reference", "IssueReference is invalid.");
        if (parent.representation === "none" && hasOwn(parent, "reference"))
            addViolation(local, "OBSERVED_RELATION_INVALID", "$.relations.parent.reference", "The none parent representation cannot contain a reference.");
        if (parent.representation !== "none" && !hasOwn(parent, "reference"))
            addViolation(local, "OBSERVED_RELATION_INVALID", "$.relations.parent.reference", "A represented parent relation requires a reference.");
    }
    if (dependsOn !== undefined) {
        unknownProperties(dependsOn, DESIRED_DEPENDS_ON_KEYS, "$.relations.dependsOn", local, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
        if (dependsOn.relation !== "dependsOn")
            addViolation(local, "OBSERVED_RELATION_INVALID", "$.relations.dependsOn.relation", "Relation kind must be dependsOn.");
        if (!DESIRED_RELATION_REPRESENTATIONS.has(dependsOn.representation))
            addViolation(local, "OBSERVED_RELATION_INVALID", "$.relations.dependsOn.representation", "Relation representation is invalid.");
        if (!Array.isArray(dependsOn.references))
            addViolation(local, "OBSERVED_RELATION_REFERENCE_INVALID", "$.relations.dependsOn.references", "Relation references must be an array.");
        else
            normalizeReferences(dependsOn.references, "$.relations.dependsOn.references", local);
        if (dependsOn.representation === "none" && Array.isArray(dependsOn.references) && dependsOn.references.length > 0)
            addViolation(local, "OBSERVED_RELATION_INVALID", "$.relations.dependsOn.references", "The none dependsOn representation cannot contain references.");
        if (dependsOn.representation !== "none" && Array.isArray(dependsOn.references) && dependsOn.references.length === 0)
            addViolation(local, "OBSERVED_RELATION_INVALID", "$.relations.dependsOn.references", "A represented dependsOn relation requires references.");
    }
    if (local.length > 0 ||
        diagnostics.length > 0 ||
        title === undefined ||
        body === undefined ||
        parent === undefined ||
        dependsOn === undefined) {
        diagnostics.push(...local.map((violation) => diagnosticFromViolation(violation, "DESIRED_PROJECTION_INVALID")));
        return { diagnostics };
    }
    return { projection: { projection: input }, diagnostics };
}
function boundedDiagnosticValue(value) {
    if (typeof value === "string")
        return value.length > SEMANTIC_ISSUE_OBSERVATION_LIMITS.diagnosticValueLength
            ? `${value.slice(0, SEMANTIC_ISSUE_OBSERVATION_LIMITS.diagnosticValueLength)}…`
            : value;
    if (Array.isArray(value))
        return value.slice(0, SEMANTIC_ISSUE_OBSERVATION_LIMITS.relationReferences).map(boundedDiagnosticValue);
    if (isRecord(value)) {
        const result = {};
        for (const key of Object.keys(value).sort(compareStrings).slice(0, 32))
            result[key] = boundedDiagnosticValue(value[key]);
        return result;
    }
    return value;
}
function addDrift(diagnostics, code, path, message, expected, actual) {
    diagnostics.push({
        code,
        path,
        message: boundedMessage(message),
        ...(expected === undefined ? {} : { expected: boundedDiagnosticValue(expected) }),
        ...(actual === undefined ? {} : { actual: boundedDiagnosticValue(actual) }),
    });
}
function comparisonResult(diagnostics) {
    const bounded = diagnostics.slice(0, SEMANTIC_ISSUE_OBSERVATION_LIMITS.diagnostics);
    return { valid: bounded.length === 0, diagnostics: bounded, drift: bounded };
}
function compareMetadata(desired, observed, diagnostics) {
    for (const key of ["labels", "assignees", "milestone"]) {
        if (!hasOwn(desired, key))
            continue;
        const expected = desired[key];
        const actual = observed[key];
        const equal = Array.isArray(expected) && Array.isArray(actual)
            ? stableSerialize([...expected].map(String).sort(compareStrings)) ===
                stableSerialize([...actual].map(String).sort(compareStrings))
            : stableSerialize(expected) === stableSerialize(actual);
        if (!equal)
            addDrift(diagnostics, "METADATA_DRIFT", `$.metadata.${key}`, `Issue metadata "${key}" differs from the desired projection.`, expected, actual);
    }
}
function compareParentRelation(desired, observed, diagnostics) {
    if (observed.representation === "conflict") {
        addDrift(diagnostics, "RELATION_CONFLICT", "$.relations.parent", "Observed parent representations conflict.", desired.reference, observed.evidence);
        return;
    }
    const expected = hasOwn(desired, "reference") ? desired.reference : undefined;
    if (expected === undefined) {
        if (observed.reference !== undefined)
            addDrift(diagnostics, "RELATION_DRIFT", "$.relations.parent.reference", "Observed an unexpected parent relation.", undefined, observed.reference);
        return;
    }
    const expectedRepresentation = desired.representation;
    if (expectedRepresentation === "none") {
        addDrift(diagnostics, "RELATION_DRIFT", "$.relations.parent.representation", "A non-empty parent relation cannot use the none representation.", expected, observed.reference);
        return;
    }
    const source = expectedRepresentation === "native"
        ? observed.evidence.native
        : expectedRepresentation === "body-fallback"
            ? observed.evidence.bodyFallback
            : undefined;
    if (source === undefined) {
        addDrift(diagnostics, "RELATION_OBSERVATION_UNAVAILABLE", "$.relations.parent.evidence", "The expected parent evidence was not supplied by the bounded observer.", expected);
        return;
    }
    if (observed.reference === undefined || !sameReference(expected, observed.reference)) {
        addDrift(diagnostics, "RELATION_DRIFT", "$.relations.parent.reference", "Observed parent relation differs from the desired projection.", expected, observed.reference);
        return;
    }
}
function compareDependsOnRelation(desired, observed, diagnostics) {
    if (observed.representation === "conflict") {
        addDrift(diagnostics, "RELATION_CONFLICT", "$.relations.dependsOn", "Observed dependsOn representations conflict.", desired.references, observed.evidence);
        return;
    }
    const expected = Array.isArray(desired.references) ? desired.references : [];
    const expectedRepresentation = desired.representation;
    if (expected.length > 0) {
        const source = expectedRepresentation === "native"
            ? observed.evidence.native
            : expectedRepresentation === "body-fallback"
                ? observed.evidence.bodyFallback
                : undefined;
        if (source === undefined) {
            addDrift(diagnostics, "RELATION_OBSERVATION_UNAVAILABLE", "$.relations.dependsOn.evidence", "The expected dependsOn evidence was not supplied by the bounded observer.", expected);
            return;
        }
    }
    if (!sameReferences(expected, observed.references)) {
        addDrift(diagnostics, "RELATION_DRIFT", "$.relations.dependsOn.references", "Observed dependsOn relation differs from the desired projection.", expected, observed.references);
        return;
    }
    if (expected.length === 0)
        return;
    if (expectedRepresentation === "none") {
        addDrift(diagnostics, "RELATION_DRIFT", "$.relations.dependsOn.representation", "A non-empty dependsOn relation cannot use the none representation.", expected, observed.references);
        return;
    }
    const source = expectedRepresentation === "native"
        ? observed.evidence.native
        : expectedRepresentation === "body-fallback"
            ? observed.evidence.bodyFallback
            : undefined;
    if (source !== undefined && !sameReferences(expected, source))
        addDrift(diagnostics, "RELATION_DRIFT", "$.relations.dependsOn.evidence", "The expected dependsOn evidence was not supplied by the bounded observer.", expected, source);
}
function validateObservedProjection(input) {
    if (!isRecord(input))
        return {
            diagnostics: [
                { code: "OBSERVED_PROJECTION_INVALID", path: "$", message: "Observed Issue projection must be an object." },
            ],
        };
    const violations = [];
    unknownProperties(input, OBSERVED_PROJECTION_KEYS, "$", violations, "OBSERVED_ISSUE_UNKNOWN_PROPERTY");
    if (input.version !== "1")
        addViolation(violations, "OBSERVED_ISSUE_VALUE_INVALID", "$.version", "Observed projection version is unsupported.");
    if (input.kind !== "issue")
        addViolation(violations, "OBSERVED_ISSUE_VALUE_INVALID", "$.kind", "Observed projection kind is invalid.");
    if (input.number !== undefined &&
        (typeof input.number !== "number" || !Number.isSafeInteger(input.number) || input.number < 1))
        addViolation(violations, "OBSERVED_ISSUE_VALUE_INVALID", "$.number", "Observed Issue number is invalid.");
    if (input.state !== undefined && input.state !== "open" && input.state !== "closed")
        addViolation(violations, "OBSERVED_ISSUE_VALUE_INVALID", "$.state", "Observed Issue state is invalid.");
    if (input.url !== undefined)
        requiredString(input.url, "$.url", violations, SEMANTIC_ISSUE_OBSERVATION_LIMITS.urlLength);
    const title = requiredString(input.title, "$.title", violations, SEMANTIC_ISSUE_OBSERVATION_LIMITS.titleLength);
    const body = bodyValue(input.body, "$.body", violations);
    if (!isRecord(input.metadata))
        addViolation(violations, "OBSERVED_ISSUE_VALUE_INVALID", "$.metadata", "Observed metadata must be an object.");
    else {
        unknownProperties(input.metadata, OBSERVED_METADATA_KEYS, "$.metadata", violations, "OBSERVED_ISSUE_UNKNOWN_PROPERTY");
        for (const key of ["labels", "assignees"])
            if (hasOwn(input.metadata, key))
                stringArray(input.metadata[key], `$.metadata.${key}`, violations);
        if (hasOwn(input.metadata, "milestone"))
            requiredString(input.metadata.milestone, "$.metadata.milestone", violations, SEMANTIC_ISSUE_OBSERVATION_LIMITS.metadataValueLength);
    }
    if (!isRecord(input.relations))
        addViolation(violations, "OBSERVED_RELATION_INVALID", "$.relations", "Observed relations must be an object.");
    else {
        unknownProperties(input.relations, OBSERVED_RELATIONS_KEYS, "$.relations", violations, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
        const parent = input.relations.parent;
        if (!isRecord(parent))
            addViolation(violations, "OBSERVED_RELATION_INVALID", "$.relations.parent", "Observed parent relation must be an object.");
        else {
            unknownProperties(parent, OBSERVED_PARENT_KEYS, "$.relations.parent", violations, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
            if (parent.relation !== "parent")
                addViolation(violations, "OBSERVED_RELATION_INVALID", "$.relations.parent.relation", "Relation kind must be parent.");
            if (!RELATION_REPRESENTATIONS.has(parent.representation))
                addViolation(violations, "OBSERVED_RELATION_INVALID", "$.relations.parent.representation", "Relation representation is invalid.");
            if (hasOwn(parent, "reference"))
                normalizeReferences(parent.reference, "$.relations.parent.reference", violations, true);
            if (parent.evidence === undefined)
                addViolation(violations, "OBSERVED_RELATION_INVALID", "$.relations.parent.evidence", "Parent relation evidence is required.");
            else {
                if (!isRecord(parent.evidence))
                    addViolation(violations, "OBSERVED_RELATION_INVALID", "$.relations.parent.evidence", "Parent relation evidence must be an object.");
                else {
                    unknownProperties(parent.evidence, OBSERVED_EVIDENCE_KEYS, "$.relations.parent.evidence", violations, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
                    if (hasOwn(parent.evidence, "native"))
                        normalizeReferences(parent.evidence.native, "$.relations.parent.evidence.native", violations, true);
                    if (hasOwn(parent.evidence, "bodyFallback"))
                        normalizeReferences(parent.evidence.bodyFallback, "$.relations.parent.evidence.bodyFallback", violations, true);
                }
            }
        }
        const dependsOn = input.relations.dependsOn;
        if (!isRecord(dependsOn))
            addViolation(violations, "OBSERVED_RELATION_INVALID", "$.relations.dependsOn", "Observed dependsOn relation must be an object.");
        else {
            unknownProperties(dependsOn, OBSERVED_DEPENDS_ON_KEYS, "$.relations.dependsOn", violations, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
            if (dependsOn.relation !== "dependsOn")
                addViolation(violations, "OBSERVED_RELATION_INVALID", "$.relations.dependsOn.relation", "Relation kind must be dependsOn.");
            if (!RELATION_REPRESENTATIONS.has(dependsOn.representation))
                addViolation(violations, "OBSERVED_RELATION_INVALID", "$.relations.dependsOn.representation", "Relation representation is invalid.");
            if (!Array.isArray(dependsOn.references))
                addViolation(violations, "OBSERVED_RELATION_REFERENCE_INVALID", "$.relations.dependsOn.references", "Relation references must be an array.");
            else
                normalizeReferences(dependsOn.references, "$.relations.dependsOn.references", violations);
            if (dependsOn.evidence === undefined)
                addViolation(violations, "OBSERVED_RELATION_INVALID", "$.relations.dependsOn.evidence", "DependsOn relation evidence is required.");
            else {
                if (!isRecord(dependsOn.evidence))
                    addViolation(violations, "OBSERVED_RELATION_INVALID", "$.relations.dependsOn.evidence", "DependsOn relation evidence must be an object.");
                else {
                    unknownProperties(dependsOn.evidence, OBSERVED_EVIDENCE_KEYS, "$.relations.dependsOn.evidence", violations, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
                    if (hasOwn(dependsOn.evidence, "native"))
                        normalizeReferences(dependsOn.evidence.native, "$.relations.dependsOn.evidence.native", violations);
                    if (hasOwn(dependsOn.evidence, "bodyFallback"))
                        normalizeReferences(dependsOn.evidence.bodyFallback, "$.relations.dependsOn.evidence.bodyFallback", violations);
                }
            }
        }
    }
    const diagnostics = violations.map((violation) => diagnosticFromViolation(violation, "OBSERVED_PROJECTION_INVALID"));
    if (diagnostics.length > 0 ||
        title === undefined ||
        body === undefined ||
        !isRecord(input.metadata) ||
        !isRecord(input.relations))
        return { diagnostics };
    return { projection: input, diagnostics };
}
/** Compare a desired Issue projection against representation-independent evidence. */
export function compareSemanticIssueProjection(desired, observed) {
    let desiredInput = desired;
    let observedInput = observed;
    if (observed === undefined && isRecord(desired) && hasOwn(desired, "desired") && hasOwn(desired, "observed")) {
        desiredInput = desired.desired;
        observedInput = desired.observed;
    }
    const desiredResult = desiredProjectionValidation(desiredInput);
    const observedResult = validateObservedProjection(observedInput);
    const diagnostics = [...desiredResult.diagnostics, ...observedResult.diagnostics];
    if (diagnostics.length > 0 || desiredResult.projection === undefined || observedResult.projection === undefined)
        return comparisonResult(diagnostics);
    const expected = desiredResult.projection.projection;
    const actual = observedResult.projection;
    if (expected.title !== actual.title)
        addDrift(diagnostics, "TITLE_DRIFT", "$.title", "Issue title differs from the desired projection.", expected.title, actual.title);
    if (expected.body !== actual.body)
        addDrift(diagnostics, "BODY_DRIFT", "$.body", "Issue body differs from the desired projection.", expected.body, actual.body);
    compareMetadata(expected.metadata, actual.metadata, diagnostics);
    compareParentRelation(expected.relations.parent, actual.relations.parent, diagnostics);
    compareDependsOnRelation(expected.relations.dependsOn, actual.relations.dependsOn, diagnostics);
    return comparisonResult(diagnostics);
}
export const compareDesiredIssueProjection = compareSemanticIssueProjection;
export const compareSemanticIssue = compareSemanticIssueProjection;
export const compareIssueProjection = compareSemanticIssueProjection;
export const diffSemanticIssueProjection = compareSemanticIssueProjection;
/** Observe a normalized Issue and compare it without exposing adapter I/O to Core. */
export function observeAndCompareSemanticIssue(desired, input, options) {
    const observed = tryObserveSemanticIssue(input, options);
    if (!observed.valid || observed.projection === undefined)
        return comparisonResult(observed.violations.map((violation) => diagnosticFromViolation(violation, "OBSERVED_PROJECTION_INVALID")));
    return compareSemanticIssueProjection(desired, observed.projection);
}
//# sourceMappingURL=semantic-issue-observation.js.map