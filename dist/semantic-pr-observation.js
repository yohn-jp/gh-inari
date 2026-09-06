/**
 * Pure Core observation and drift comparison for semantic pull-request
 * projections.
 *
 * `GitHubPullRequest` is already a bounded, transport-normalized read model.
 * This module accepts that model (plus explicitly supplied native relation
 * evidence), preserves all relation representations as evidence, and never
 * treats an observed value as semantic authority.  It performs no GitHub I/O
 * and no mutation.
 */
import { issueReferenceKey, normalizeIssueReference } from "./contract/issue-reference.js";
export const SEMANTIC_PULL_REQUEST_OBSERVED_PROJECTION_VERSION = "1";
/** Alias named after the observation operation for callers that use that vocabulary. */
export const SEMANTIC_PULL_REQUEST_OBSERVATION_VERSION = SEMANTIC_PULL_REQUEST_OBSERVED_PROJECTION_VERSION;
export const SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS = Object.freeze({
    bodyBytes: 1_048_576,
    titleLength: 255,
    refLength: 512,
    metadataValueLength: 512,
    relationReferences: 1_000,
    diagnostics: 100,
    diagnosticMessageLength: 500,
    diagnosticValueLength: 512,
});
export class SemanticPullRequestObservationError extends Error {
    violations;
    constructor(violations) {
        super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
        this.name = "SemanticPullRequestObservationError";
        this.violations = violations;
    }
}
const OBSERVATION_INPUT_KEYS = new Set([
    "pullRequest",
    "repository",
    "relations",
    "relationEvidence",
    "nativeImplements",
]);
const OBSERVATION_OPTIONS_KEYS = new Set(["repository", "relations", "relationEvidence", "nativeImplements"]);
const PULL_REQUEST_KEYS = new Set([
    "number",
    "title",
    "body",
    "state",
    "url",
    "draft",
    "maintainerCanModify",
    "head",
    "base",
    "labels",
    "assignees",
    "milestone",
    "requestedReviewers",
    // These are accepted only as a direct evidence convenience. They are
    // normalized into the explicit repository identity, never used as policy.
    "repositoryHost",
    "repositoryId",
    "repository",
]);
const OBSERVATION_RELATIONS_KEYS = new Set(["implements"]);
const OBSERVATION_RELATION_EVIDENCE_KEYS = new Set(["native", "recognizedConvention", "bodyFallback"]);
const REPOSITORY_KEYS = new Set(["host", "hostname", "repositoryHost", "repositoryId", "repository", "nameWithOwner"]);
const OBSERVED_PROJECTION_KEYS = new Set([
    "version",
    "kind",
    "number",
    "state",
    "url",
    "title",
    "head",
    "base",
    "body",
    "metadata",
    "relations",
]);
const OBSERVED_METADATA_KEYS = new Set([
    "labels",
    "assignees",
    "milestone",
    "reviewers",
    "draft",
    "maintainerCanModify",
]);
const OBSERVED_RELATION_KEYS = new Set(["relation", "references", "representation", "evidence"]);
const OBSERVED_EVIDENCE_KEYS = new Set(["native", "recognizedConvention", "bodyFallback"]);
const DESIRED_PROJECTION_KEYS = new Set([
    "version",
    "kind",
    "title",
    "head",
    "base",
    "body",
    "metadata",
    "relations",
    "provenance",
    "generation",
]);
const DESIRED_METADATA_KEYS = new Set([
    "labels",
    "assignees",
    "milestone",
    "reviewers",
    "draft",
    "maintainerCanModify",
]);
const DESIRED_RELATIONS_KEYS = new Set(["implements"]);
const DESIRED_IMPLEMENTATION_KEYS = new Set(["relation", "references", "representation"]);
const OBSERVED_RELATION_REPRESENTATIONS = new Set([
    "none",
    "native",
    "recognized-convention",
    "body-fallback",
    "conflict",
]);
const DESIRED_RELATION_REPRESENTATIONS = new Set(["none", "native", "recognized-convention", "body-fallback"]);
const REPOSITORY_LOCATOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const ISSUE_NUMBER_PATTERN = /^[1-9][0-9]{0,15}$/u;
const CLOSING_REFERENCE_PATTERN = /(?:^|[^A-Za-z0-9_])(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)(?:[\t ]+|[\t ]*:[\t ]*)((?:[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)?#([1-9][0-9]{0,15}))(?![A-Za-z0-9_])/giu;
const FALLBACK_MARKER_PATTERN = /<!--[\t ]*inari:semantic-relation[\t ]+([\s\S]{1,32768}?)[\t ]*-->/gu;
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
    if (violations.length >= SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.diagnostics)
        return;
    violations.push({ code, path, message: boundedMessage(message) });
}
function unknownProperties(input, allowed, path, violations, code) {
    for (const key of Object.keys(input).sort(compareStrings)) {
        if (!allowed.has(key))
            addViolation(violations, code, `${path}.${key}`, `Property "${key}" is not supported.`);
    }
}
function boundedMessage(value) {
    const normalized = value.replace(/\s+/gu, " ").trim();
    return normalized.length > SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.diagnosticMessageLength
        ? `${normalized.slice(0, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.diagnosticMessageLength)}…`
        : normalized;
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
    let result;
    if (Array.isArray(value)) {
        result = `[${value.map((entry) => stableSerialize(entry, stack)).join(",")}]`;
    }
    else if (isRecord(value)) {
        result = `{${Object.keys(value)
            .sort(compareStrings)
            .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], stack)}`)
            .join(",")}}`;
    }
    else {
        throw new TypeError("Only plain JSON objects are supported.");
    }
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
function invalidObservation(violations) {
    return { valid: false, violations };
}
function requiredString(value, path, violations, maxLength, code = "OBSERVED_PULL_REQUEST_VALUE_INVALID") {
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
        addViolation(violations, "OBSERVED_BODY_INVALID", path, "Pull request body must be a string or null.");
        return undefined;
    }
    const body = value ?? "";
    if (Buffer.byteLength(body, "utf8") > SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.bodyBytes) {
        addViolation(violations, "OBSERVED_BODY_INVALID", path, "Pull request body exceeds the bounded observation limit.");
        return undefined;
    }
    return body;
}
function stringArray(value, path, violations, maxLength = SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.metadataValueLength) {
    if (!Array.isArray(value)) {
        addViolation(violations, "OBSERVED_PULL_REQUEST_VALUE_INVALID", path, "Value must be an array of strings.");
        return undefined;
    }
    if (value.length > SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.relationReferences) {
        addViolation(violations, "OBSERVED_PULL_REQUEST_VALUE_INVALID", path, "Value exceeds the bounded item limit.");
        return undefined;
    }
    const values = [];
    const seen = new Set();
    value.forEach((entry, index) => {
        const parsed = requiredString(entry, `${path}[${index}]`, violations, maxLength);
        if (parsed === undefined)
            return;
        if (seen.has(parsed)) {
            addViolation(violations, "OBSERVED_PULL_REQUEST_VALUE_INVALID", `${path}[${index}]`, "Values must be unique.");
            return;
        }
        seen.add(parsed);
        values.push(parsed);
    });
    return [...values].sort(compareStrings);
}
function normalizeReferenceArray(value, path, violations, code = "OBSERVED_RELATION_REFERENCE_INVALID") {
    if (!Array.isArray(value)) {
        addViolation(violations, code, path, "Relation references must be an array of IssueReference values.");
        return undefined;
    }
    if (value.length > SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.relationReferences) {
        addViolation(violations, code, path, "Relation references exceed the bounded item limit.");
        return undefined;
    }
    const references = [];
    const seen = new Set();
    value.forEach((entry, index) => {
        const result = normalizeIssueReference(entry, `${path}[${index}]`);
        if (!result.valid || result.reference === undefined) {
            addViolation(violations, code, `${path}[${index}]`, "IssueReference is invalid.");
            return;
        }
        const key = issueReferenceKey(result.reference);
        if (seen.has(key)) {
            addViolation(violations, code, `${path}[${index}]`, "Issue references must be unique.");
            return;
        }
        seen.add(key);
        references.push(result.reference);
    });
    return references.sort((left, right) => compareStrings(issueReferenceKey(left), issueReferenceKey(right)));
}
function sameReferences(left, right) {
    if (left.length !== right.length)
        return false;
    return left.every((reference, index) => issueReferenceKey(reference) === issueReferenceKey(right[index]));
}
function referencesFromSources(sources) {
    const ordered = [
        { source: "native", references: sources.native ?? [] },
        { source: "recognizedConvention", references: sources.recognizedConvention ?? [] },
        { source: "bodyFallback", references: sources.bodyFallback ?? [] },
    ];
    const nonEmpty = ordered.filter((entry) => entry.references.length > 0);
    if (nonEmpty.length === 0)
        return { representation: "none", references: [] };
    const first = nonEmpty[0];
    if (nonEmpty.some((entry) => !sameReferences(first.references, entry.references))) {
        return { representation: "conflict", references: [] };
    }
    const representation = first.source === "native"
        ? "native"
        : first.source === "recognizedConvention"
            ? "recognized-convention"
            : "body-fallback";
    return { representation, references: first.references };
}
function repositoryIdentity(input, pullRequest, path, violations) {
    const values = isRecord(input) ? input : {};
    const hostValue = values.host ?? values.hostname ?? values.repositoryHost ?? pullRequest.repositoryHost;
    const repositoryIdValue = values.repositoryId ?? pullRequest.repositoryId;
    const repositoryValue = values.repository ?? values.nameWithOwner ?? pullRequest.repository;
    if (hostValue === undefined && repositoryIdValue === undefined && repositoryValue === undefined)
        return undefined;
    const host = requiredString(hostValue, `${path}.host`, violations, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.refLength, "OBSERVED_RELATION_INVALID");
    const repositoryId = repositoryIdValue;
    if (typeof repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(repositoryId)) {
        addViolation(violations, "OBSERVED_RELATION_INVALID", `${path}.repositoryId`, "repositoryId must be a positive decimal repository identity.");
    }
    const repository = repositoryValue;
    if (repository !== undefined && (typeof repository !== "string" || !REPOSITORY_LOCATOR_PATTERN.test(repository))) {
        addViolation(violations, "OBSERVED_RELATION_INVALID", `${path}.repository`, "repository must be an owner/name locator.");
    }
    if (host === undefined || typeof repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(repositoryId))
        return undefined;
    return {
        host: host.toLocaleLowerCase("en-US"),
        repositoryId,
        ...(typeof repository === "string" ? { repository: repository.toLocaleLowerCase("en-US") } : {}),
    };
}
function relationReferenceFromLocator(locator, repository, path, violations) {
    const separator = locator.lastIndexOf("#");
    const repositoryLocator = separator < 0 ? "" : locator.slice(0, separator);
    const numberText = separator < 0 ? "" : locator.slice(separator + 1);
    if (!ISSUE_NUMBER_PATTERN.test(numberText)) {
        addViolation(violations, "OBSERVED_RELATION_REFERENCE_INVALID", path, "Closing reference Issue number is invalid.");
        return undefined;
    }
    const number = Number(numberText);
    if (!Number.isSafeInteger(number)) {
        addViolation(violations, "OBSERVED_RELATION_REFERENCE_INVALID", path, "Closing reference Issue number is unsafe.");
        return undefined;
    }
    if (repository === undefined) {
        addViolation(violations, "OBSERVED_RELATION_REFERENCE_UNRESOLVED", path, "Closing reference cannot be resolved without repository identity evidence.");
        return undefined;
    }
    if (repositoryLocator !== "" &&
        repository.repository !== undefined &&
        repositoryLocator.toLocaleLowerCase("en-US") !== repository.repository) {
        addViolation(violations, "OBSERVED_RELATION_REFERENCE_UNRESOLVED", path, "Cross-repository closing reference identity is not available through this bounded observation.");
        return undefined;
    }
    if (repositoryLocator !== "" && repository.repository === undefined) {
        addViolation(violations, "OBSERVED_RELATION_REFERENCE_UNRESOLVED", path, "Cross-repository closing reference cannot be resolved without its repository locator.");
        return undefined;
    }
    return {
        repositoryHost: repository.host,
        repositoryId: repository.repositoryId,
        ...(repository.repository === undefined ? {} : { repository: repository.repository }),
        number,
    };
}
function parseBodyRelations(body, repository, violations) {
    const recognized = [];
    const recognizedSeen = new Set();
    CLOSING_REFERENCE_PATTERN.lastIndex = 0;
    let match;
    while ((match = CLOSING_REFERENCE_PATTERN.exec(body)) !== null) {
        const locator = match[1];
        if (locator === undefined)
            continue;
        const reference = relationReferenceFromLocator(locator, repository, `$.pullRequest.body@${match.index}`, violations);
        if (reference === undefined)
            continue;
        const key = issueReferenceKey(reference);
        if (!recognizedSeen.has(key)) {
            recognizedSeen.add(key);
            recognized.push(reference);
        }
    }
    const fallbackCandidates = [];
    FALLBACK_MARKER_PATTERN.lastIndex = 0;
    while ((match = FALLBACK_MARKER_PATTERN.exec(body)) !== null) {
        const payload = match[1];
        if (payload === undefined)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(payload);
        }
        catch {
            addViolation(violations, "OBSERVED_RELATION_MARKER_INVALID", `$.pullRequest.body@${match.index}`, "Semantic relation fallback marker must contain valid JSON.");
            continue;
        }
        if (!isRecord(parsed) || parsed.version !== "1" || !hasOwn(parsed, "implements")) {
            addViolation(violations, "OBSERVED_RELATION_MARKER_INVALID", `$.pullRequest.body@${match.index}`, "Semantic relation fallback marker has an unsupported shape.");
            continue;
        }
        const markerViolations = [];
        const references = normalizeReferenceArray(parsed.implements, `$.pullRequest.body@${match.index}.implements`, markerViolations, "OBSERVED_RELATION_MARKER_INVALID");
        if (Object.keys(parsed).some((key) => key !== "version" && key !== "implements")) {
            addViolation(markerViolations, "OBSERVED_RELATION_MARKER_INVALID", `$.pullRequest.body@${match.index}`, "Semantic relation fallback marker contains an unsupported property.");
        }
        violations.push(...markerViolations.slice(0, Math.max(0, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.diagnostics - violations.length)));
        if (references !== undefined && markerViolations.length === 0)
            fallbackCandidates.push([...references]);
    }
    const fallback = fallbackCandidates[0] ?? [];
    const conflict = fallbackCandidates.some((candidate) => !sameReferences(candidate, fallback));
    return {
        recognized: recognized.sort((left, right) => compareStrings(issueReferenceKey(left), issueReferenceKey(right))),
        fallback,
        conflict,
    };
}
function parseRelationInput(input, path, violations) {
    if (input === undefined)
        return {};
    let evidence = input;
    if (Array.isArray(input))
        evidence = { native: input };
    if (!isRecord(evidence)) {
        addViolation(violations, "OBSERVED_RELATION_INVALID", path, "Relation evidence must be an object or reference array.");
        return {};
    }
    unknownProperties(evidence, OBSERVATION_RELATION_EVIDENCE_KEYS, path, violations, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
    const result = {};
    for (const key of ["native", "recognizedConvention", "bodyFallback"]) {
        if (!hasOwn(evidence, key))
            continue;
        const references = normalizeReferenceArray(evidence[key], `${path}.${key}`, violations);
        if (references !== undefined)
            result[key] = references;
    }
    return result;
}
function extractRelationInput(input, path, violations) {
    if (input === undefined)
        return {};
    if (Array.isArray(input))
        return parseRelationInput(input, path, violations);
    if (!isRecord(input)) {
        addViolation(violations, "OBSERVED_RELATION_INVALID", path, "Relations must be an object.");
        return {};
    }
    unknownProperties(input, OBSERVATION_RELATIONS_KEYS, path, violations, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
    if (!hasOwn(input, "implements"))
        return {};
    return parseRelationInput(input.implements, `${path}.implements`, violations);
}
function pullRequestRepositoryEvidence(pullRequest, repositoryInput, violations) {
    if (repositoryInput !== undefined && !isRecord(repositoryInput)) {
        addViolation(violations, "OBSERVED_RELATION_INVALID", "$.repository", "Repository identity must be an object.");
        return undefined;
    }
    if (isRecord(repositoryInput))
        unknownProperties(repositoryInput, REPOSITORY_KEYS, "$.repository", violations, "OBSERVED_RELATION_INVALID");
    return repositoryIdentity(repositoryInput, pullRequest, "$.repository", violations);
}
function relationOptionValue(input) {
    const relations = input.relations;
    const relationEvidence = input.relationEvidence;
    const nativeImplements = input.nativeImplements;
    if (relations !== undefined && relationEvidence !== undefined)
        return { __conflictingRelationInputs: true };
    if (relations !== undefined)
        return relations;
    if (relationEvidence !== undefined || nativeImplements !== undefined) {
        return {
            implements: {
                ...(relationEvidence === undefined ? {} : relationEvidence),
                ...(nativeImplements === undefined ? {} : { native: nativeImplements }),
            },
        };
    }
    return undefined;
}
function observationRequest(input, options, violations) {
    if (options !== undefined) {
        if (!isRecord(options)) {
            addViolation(violations, "OBSERVATION_INPUT_INVALID", "$", "Observation options must be an object.");
            return undefined;
        }
        unknownProperties(options, OBSERVATION_OPTIONS_KEYS, "$", violations, "OBSERVATION_INPUT_UNKNOWN_PROPERTY");
        return { pullRequest: input, repository: options.repository, relations: relationOptionValue(options) };
    }
    if (isRecord(input) && hasOwn(input, "pullRequest")) {
        unknownProperties(input, OBSERVATION_INPUT_KEYS, "$", violations, "OBSERVATION_INPUT_UNKNOWN_PROPERTY");
        return {
            pullRequest: input.pullRequest,
            repository: input.repository,
            relations: relationOptionValue(input),
        };
    }
    // Direct normalized GitHubPullRequest convenience form.
    return { pullRequest: input };
}
function parseMilestone(value, path, violations) {
    if (value === undefined || value === null)
        return undefined;
    if (!isRecord(value)) {
        addViolation(violations, "OBSERVED_PULL_REQUEST_VALUE_INVALID", path, "Milestone must be an object or null.");
        return undefined;
    }
    unknownProperties(value, new Set(["number", "title"]), path, violations, "OBSERVED_PULL_REQUEST_UNKNOWN_PROPERTY");
    if (typeof value.number !== "number" || !Number.isSafeInteger(value.number) || value.number < 1)
        addViolation(violations, "OBSERVED_PULL_REQUEST_VALUE_INVALID", `${path}.number`, "Milestone number is invalid.");
    return requiredString(value.title, `${path}.title`, violations, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.metadataValueLength);
}
function parseReviewers(value, path, violations) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value)) {
        addViolation(violations, "OBSERVED_PULL_REQUEST_VALUE_INVALID", path, "Requested reviewers must be an object.");
        return undefined;
    }
    unknownProperties(value, new Set(["users", "teams"]), path, violations, "OBSERVED_PULL_REQUEST_UNKNOWN_PROPERTY");
    if (!hasOwn(value, "users") || !hasOwn(value, "teams")) {
        addViolation(violations, "OBSERVED_PULL_REQUEST_VALUE_INVALID", path, "Both reviewer user and team lists are required.");
        return undefined;
    }
    const users = stringArray(value.users, `${path}.users`, violations);
    const teams = stringArray(value.teams, `${path}.teams`, violations);
    if (users === undefined || teams === undefined)
        return undefined;
    const combined = [...users, ...teams];
    if (new Set(combined).size !== combined.length) {
        addViolation(violations, "OBSERVED_PULL_REQUEST_VALUE_INVALID", path, "Reviewer user and team identifiers must be unique.");
        return undefined;
    }
    return combined.sort(compareStrings);
}
function validatePullRequestEvidence(input) {
    const violations = [];
    if (!isRecord(input)) {
        addViolation(violations, "OBSERVED_PULL_REQUEST_INVALID", "$.pullRequest", "Pull request evidence must be an object.");
        return { violations };
    }
    unknownProperties(input, PULL_REQUEST_KEYS, "$.pullRequest", violations, "OBSERVED_PULL_REQUEST_UNKNOWN_PROPERTY");
    const title = requiredString(input.title, "$.pullRequest.title", violations, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.titleLength);
    const head = requiredString(input.head, "$.pullRequest.head", violations, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.refLength);
    const base = requiredString(input.base, "$.pullRequest.base", violations, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.refLength);
    const body = bodyValue(input.body, "$.pullRequest.body", violations);
    let number;
    if (input.number !== undefined) {
        if (typeof input.number !== "number" || !Number.isSafeInteger(input.number) || input.number < 1)
            addViolation(violations, "OBSERVED_PULL_REQUEST_VALUE_INVALID", "$.pullRequest.number", "Pull request number is invalid.");
        else
            number = input.number;
    }
    let state;
    if (input.state !== undefined) {
        if (input.state !== "open" && input.state !== "closed")
            addViolation(violations, "OBSERVED_PULL_REQUEST_VALUE_INVALID", "$.pullRequest.state", "Pull request state is invalid.");
        else
            state = input.state;
    }
    let url;
    if (input.url !== undefined)
        url = requiredString(input.url, "$.pullRequest.url", violations, 2_048);
    const metadata = {};
    for (const key of ["labels", "assignees"]) {
        if (!hasOwn(input, key))
            continue;
        const values = stringArray(input[key], `$.pullRequest.${key}`, violations);
        if (values !== undefined)
            metadata[key] = values;
    }
    const milestone = parseMilestone(input.milestone, "$.pullRequest.milestone", violations);
    if (milestone !== undefined)
        metadata.milestone = milestone;
    const reviewers = parseReviewers(input.requestedReviewers, "$.pullRequest.requestedReviewers", violations);
    if (reviewers !== undefined)
        metadata.reviewers = reviewers;
    for (const key of ["draft", "maintainerCanModify"]) {
        if (!hasOwn(input, key))
            continue;
        if (typeof input[key] !== "boolean")
            addViolation(violations, "OBSERVED_PULL_REQUEST_VALUE_INVALID", `$.pullRequest.${key}`, "Value must be boolean.");
        else
            metadata[key] = input[key];
    }
    if (violations.length > 0 || title === undefined || head === undefined || base === undefined || body === undefined)
        return { repositoryInput: undefined, violations };
    return {
        evidence: {
            ...(number === undefined ? {} : { number }),
            ...(state === undefined ? {} : { state }),
            ...(url === undefined ? {} : { url }),
            title,
            head,
            base,
            body,
            metadata: metadata,
        },
        repositoryInput: {
            ...(input.repositoryHost === undefined ? {} : { repositoryHost: input.repositoryHost }),
            ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
            ...(input.repository === undefined ? {} : { repository: input.repository }),
        },
        violations,
    };
}
function buildObservedProjection(request) {
    const validated = validatePullRequestEvidence(request.pullRequest);
    const violations = [...validated.violations];
    if (validated.evidence === undefined)
        return invalidObservation(violations);
    const pullRequest = isRecord(request.pullRequest) ? request.pullRequest : {};
    const repository = pullRequestRepositoryEvidence(pullRequest, request.repository === undefined ? validated.repositoryInput : request.repository, violations);
    const explicit = extractRelationInput(request.relations, "$.relations", violations);
    const parsedBody = parseBodyRelations(validated.evidence.body, repository, violations);
    const recognized = explicit.recognizedConvention ?? parsedBody.recognized;
    const bodyFallback = explicit.bodyFallback ?? parsedBody.fallback;
    const native = explicit.native;
    const sourceResult = referencesFromSources({ native, recognizedConvention: recognized, bodyFallback });
    const explicitSourceConflict = (explicit.recognizedConvention !== undefined &&
        !sameReferences(explicit.recognizedConvention, parsedBody.recognized)) ||
        (explicit.bodyFallback !== undefined && !sameReferences(explicit.bodyFallback, parsedBody.fallback));
    const relation = {
        relation: "implements",
        references: sourceResult.references,
        representation: parsedBody.conflict || explicitSourceConflict ? "conflict" : sourceResult.representation,
        evidence: {
            ...(native === undefined ? {} : { native }),
            recognizedConvention: [...recognized],
            bodyFallback: [...bodyFallback],
        },
    };
    if (violations.length > 0)
        return invalidObservation(violations);
    const projection = {
        version: SEMANTIC_PULL_REQUEST_OBSERVED_PROJECTION_VERSION,
        kind: "pull_request",
        ...(validated.evidence.number === undefined ? {} : { number: validated.evidence.number }),
        ...(validated.evidence.state === undefined ? {} : { state: validated.evidence.state }),
        ...(validated.evidence.url === undefined ? {} : { url: validated.evidence.url }),
        title: validated.evidence.title,
        head: validated.evidence.head,
        base: validated.evidence.base,
        body: validated.evidence.body,
        metadata: validated.evidence.metadata,
        relations: { implements: relation },
    };
    return { valid: true, projection: cloneImmutable(projection), violations: [] };
}
/** Normalize a bounded GitHubPullRequest observation into Core evidence. */
export function tryObserveSemanticPullRequest(input, options) {
    const violations = [];
    const request = observationRequest(input, options, violations);
    if (request === undefined)
        return invalidObservation(violations);
    const result = buildObservedProjection(request);
    return violations.length === 0 ? result : invalidObservation([...violations, ...result.violations]);
}
/** Throwing observation entry point for Core callers. */
export function observeSemanticPullRequest(input, options) {
    const result = tryObserveSemanticPullRequest(input, options);
    if (!result.valid || result.projection === undefined)
        throw new SemanticPullRequestObservationError(result.violations);
    return result.projection;
}
export const tryObserveSemanticPullRequestProjection = tryObserveSemanticPullRequest;
export const observeSemanticPullRequestProjection = observeSemanticPullRequest;
export const tryObservePullRequestProjection = tryObserveSemanticPullRequest;
export const observePullRequestProjection = observeSemanticPullRequest;
export const observeGitHubPullRequestProjection = observeSemanticPullRequest;
function desiredProjectionValidation(input) {
    const diagnostics = [];
    if (!isRecord(input)) {
        diagnostics.push({
            code: "DESIRED_PROJECTION_INVALID",
            path: "$",
            message: "Desired pull-request projection must be an object.",
        });
        return { diagnostics };
    }
    for (const key of Object.keys(input).sort(compareStrings)) {
        if (!DESIRED_PROJECTION_KEYS.has(key))
            diagnostics.push({ code: "DESIRED_PROJECTION_INVALID", path: `$.${key}`, message: "Property is not supported." });
    }
    if (input.version !== "1")
        diagnostics.push({
            code: "DESIRED_PROJECTION_INVALID",
            path: "$.version",
            message: "Desired projection version is unsupported.",
        });
    if (input.kind !== "pull_request")
        diagnostics.push({
            code: "DESIRED_PROJECTION_INVALID",
            path: "$.kind",
            message: "Desired projection kind is invalid.",
        });
    const localViolations = [];
    const title = requiredString(input.title, "$.title", localViolations, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.titleLength, "OBSERVED_PULL_REQUEST_VALUE_INVALID");
    const head = requiredString(input.head, "$.head", localViolations, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.refLength, "OBSERVED_PULL_REQUEST_VALUE_INVALID");
    const base = requiredString(input.base, "$.base", localViolations, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.refLength, "OBSERVED_PULL_REQUEST_VALUE_INVALID");
    const body = bodyValue(input.body, "$.body", localViolations);
    if (!isRecord(input.metadata))
        localViolations.push({
            code: "OBSERVED_PULL_REQUEST_VALUE_INVALID",
            path: "$.metadata",
            message: "Desired metadata must be an object.",
        });
    const metadata = {};
    if (isRecord(input.metadata)) {
        unknownProperties(input.metadata, DESIRED_METADATA_KEYS, "$.metadata", localViolations, "OBSERVED_PULL_REQUEST_UNKNOWN_PROPERTY");
        for (const key of ["labels", "assignees", "reviewers"]) {
            if (!hasOwn(input.metadata, key))
                continue;
            const values = stringArray(input.metadata[key], `$.metadata.${key}`, localViolations);
            if (values !== undefined)
                metadata[key] = values;
        }
        if (hasOwn(input.metadata, "milestone")) {
            const milestone = requiredString(input.metadata.milestone, "$.metadata.milestone", localViolations, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.metadataValueLength);
            if (milestone !== undefined)
                metadata.milestone = milestone;
        }
        for (const key of ["draft", "maintainerCanModify"]) {
            if (!hasOwn(input.metadata, key))
                continue;
            if (typeof input.metadata[key] !== "boolean")
                localViolations.push({
                    code: "OBSERVED_PULL_REQUEST_VALUE_INVALID",
                    path: `$.metadata.${key}`,
                    message: "Value must be boolean.",
                });
            else
                metadata[key] = input.metadata[key];
        }
    }
    let relation;
    if (!isRecord(input.relations))
        localViolations.push({
            code: "OBSERVED_PULL_REQUEST_VALUE_INVALID",
            path: "$.relations",
            message: "Desired relations must be an object.",
        });
    else {
        unknownProperties(input.relations, DESIRED_RELATIONS_KEYS, "$.relations", localViolations, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
        const implementsRelation = input.relations.implements;
        if (!isRecord(implementsRelation))
            localViolations.push({
                code: "OBSERVED_PULL_REQUEST_VALUE_INVALID",
                path: "$.relations.implements",
                message: "Desired implements relation must be an object.",
            });
        else {
            unknownProperties(implementsRelation, DESIRED_IMPLEMENTATION_KEYS, "$.relations.implements", localViolations, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
            if (implementsRelation.relation !== "implements")
                localViolations.push({
                    code: "OBSERVED_PULL_REQUEST_VALUE_INVALID",
                    path: "$.relations.implements.relation",
                    message: "Relation kind must be implements.",
                });
            const references = normalizeReferenceArray(implementsRelation.references, "$.relations.implements.references", localViolations, "OBSERVED_RELATION_REFERENCE_INVALID");
            if (typeof implementsRelation.representation !== "string" ||
                !DESIRED_RELATION_REPRESENTATIONS.has(implementsRelation.representation))
                localViolations.push({
                    code: "OBSERVED_PULL_REQUEST_VALUE_INVALID",
                    path: "$.relations.implements.representation",
                    message: "Relation representation is invalid.",
                });
            if (references !== undefined &&
                typeof implementsRelation.representation === "string" &&
                DESIRED_RELATION_REPRESENTATIONS.has(implementsRelation.representation))
                relation = {
                    references,
                    representation: implementsRelation.representation,
                };
        }
    }
    for (const violation of localViolations)
        diagnostics.push({ code: "DESIRED_PROJECTION_INVALID", path: violation.path, message: violation.message });
    if (diagnostics.length > 0 ||
        title === undefined ||
        head === undefined ||
        base === undefined ||
        body === undefined ||
        relation === undefined)
        return { diagnostics: diagnostics.slice(0, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.diagnostics) };
    return { projection: { title, head, base, body, metadata, relation }, diagnostics: [] };
}
function observedProjectionValidation(input) {
    const diagnostics = [];
    if (!isRecord(input))
        return {
            diagnostics: [
                {
                    code: "OBSERVED_PROJECTION_INVALID",
                    path: "$",
                    message: "Observed pull-request projection must be an object.",
                },
            ],
        };
    const violations = [];
    unknownProperties(input, OBSERVED_PROJECTION_KEYS, "$", violations, "OBSERVED_PULL_REQUEST_UNKNOWN_PROPERTY");
    if (input.version !== SEMANTIC_PULL_REQUEST_OBSERVED_PROJECTION_VERSION)
        addViolation(violations, "OBSERVED_PULL_REQUEST_INVALID", "$.version", "Observed projection version is unsupported.");
    if (input.kind !== "pull_request")
        addViolation(violations, "OBSERVED_PULL_REQUEST_INVALID", "$.kind", "Observed projection kind is invalid.");
    const title = requiredString(input.title, "$.title", violations, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.titleLength);
    const head = requiredString(input.head, "$.head", violations, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.refLength);
    const base = requiredString(input.base, "$.base", violations, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.refLength);
    const body = bodyValue(input.body, "$.body", violations);
    const metadata = {};
    if (!isRecord(input.metadata))
        addViolation(violations, "OBSERVED_PULL_REQUEST_INVALID", "$.metadata", "Observed metadata must be an object.");
    else {
        unknownProperties(input.metadata, OBSERVED_METADATA_KEYS, "$.metadata", violations, "OBSERVED_PULL_REQUEST_UNKNOWN_PROPERTY");
        for (const key of ["labels", "assignees", "reviewers"]) {
            if (!hasOwn(input.metadata, key))
                continue;
            const values = stringArray(input.metadata[key], `$.metadata.${key}`, violations);
            if (values !== undefined)
                metadata[key] = values;
        }
        if (hasOwn(input.metadata, "milestone")) {
            const milestone = requiredString(input.metadata.milestone, "$.metadata.milestone", violations, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.metadataValueLength);
            if (milestone !== undefined)
                metadata.milestone = milestone;
        }
        for (const key of ["draft", "maintainerCanModify"]) {
            if (!hasOwn(input.metadata, key))
                continue;
            if (typeof input.metadata[key] !== "boolean")
                addViolation(violations, "OBSERVED_PULL_REQUEST_VALUE_INVALID", `$.metadata.${key}`, "Value must be boolean.");
            else
                metadata[key] = input.metadata[key];
        }
    }
    if (!isRecord(input.relations))
        addViolation(violations, "OBSERVED_RELATION_INVALID", "$.relations", "Observed relations must be an object.");
    let relation;
    if (isRecord(input.relations)) {
        unknownProperties(input.relations, OBSERVATION_RELATIONS_KEYS, "$.relations", violations, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
        const raw = input.relations.implements;
        if (!isRecord(raw))
            addViolation(violations, "OBSERVED_RELATION_INVALID", "$.relations.implements", "Observed implements relation must be an object.");
        else {
            unknownProperties(raw, OBSERVED_RELATION_KEYS, "$.relations.implements", violations, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
            if (raw.relation !== "implements")
                addViolation(violations, "OBSERVED_RELATION_INVALID", "$.relations.implements.relation", "Relation kind must be implements.");
            const references = normalizeReferenceArray(raw.references, "$.relations.implements.references", violations);
            if (typeof raw.representation !== "string" ||
                !OBSERVED_RELATION_REPRESENTATIONS.has(raw.representation))
                addViolation(violations, "OBSERVED_RELATION_INVALID", "$.relations.implements.representation", "Relation representation is invalid.");
            let evidence;
            if (raw.evidence === undefined) {
                const fallbackReferences = raw.representation === "body-fallback" ? (references ?? []) : [];
                const recognizedReferences = raw.representation === "recognized-convention" ? (references ?? []) : [];
                const nativeReferences = raw.representation === "native" ? (references ?? []) : undefined;
                evidence = {
                    ...(nativeReferences === undefined ? {} : { native: nativeReferences }),
                    recognizedConvention: recognizedReferences,
                    bodyFallback: fallbackReferences,
                };
            }
            else if (!isRecord(raw.evidence))
                addViolation(violations, "OBSERVED_RELATION_INVALID", "$.relations.implements.evidence", "Relation evidence must be an object.");
            else {
                unknownProperties(raw.evidence, OBSERVED_EVIDENCE_KEYS, "$.relations.implements.evidence", violations, "OBSERVED_RELATION_UNKNOWN_PROPERTY");
                const native = raw.evidence.native === undefined
                    ? undefined
                    : normalizeReferenceArray(raw.evidence.native, "$.relations.implements.evidence.native", violations);
                const recognizedConvention = normalizeReferenceArray(raw.evidence.recognizedConvention, "$.relations.implements.evidence.recognizedConvention", violations);
                const bodyFallback = normalizeReferenceArray(raw.evidence.bodyFallback, "$.relations.implements.evidence.bodyFallback", violations);
                if (recognizedConvention !== undefined && bodyFallback !== undefined)
                    evidence = { ...(native === undefined ? {} : { native }), recognizedConvention, bodyFallback };
            }
            if (references !== undefined && evidence !== undefined && raw.representation !== "conflict") {
                const source = referencesFromSources({
                    native: evidence.native,
                    recognizedConvention: evidence.recognizedConvention,
                    bodyFallback: evidence.bodyFallback,
                });
                if (source.representation !== raw.representation || !sameReferences(source.references, references))
                    addViolation(violations, "OBSERVED_RELATION_INVALID", "$.relations.implements", "Relation references do not match relation evidence.");
            }
            if (references !== undefined &&
                evidence !== undefined &&
                typeof raw.representation === "string" &&
                OBSERVED_RELATION_REPRESENTATIONS.has(raw.representation))
                relation = {
                    relation: "implements",
                    references,
                    representation: raw.representation,
                    evidence,
                };
        }
    }
    if (violations.length > 0 ||
        title === undefined ||
        head === undefined ||
        base === undefined ||
        body === undefined ||
        relation === undefined) {
        for (const violation of violations)
            diagnostics.push({ code: "OBSERVED_PROJECTION_INVALID", path: violation.path, message: violation.message });
        return { diagnostics: diagnostics.slice(0, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.diagnostics) };
    }
    const optionalResourceFields = {};
    if (input.number !== undefined) {
        if (typeof input.number !== "number" || !Number.isSafeInteger(input.number) || input.number < 1)
            violations.push({
                code: "OBSERVED_PULL_REQUEST_VALUE_INVALID",
                path: "$.number",
                message: "Pull request number is invalid.",
            });
        else
            optionalResourceFields.number = input.number;
    }
    if (input.state !== undefined) {
        if (input.state !== "open" && input.state !== "closed")
            violations.push({
                code: "OBSERVED_PULL_REQUEST_VALUE_INVALID",
                path: "$.state",
                message: "Pull request state is invalid.",
            });
        else
            optionalResourceFields.state = input.state;
    }
    if (input.url !== undefined) {
        const url = requiredString(input.url, "$.url", violations, 2_048);
        if (url !== undefined)
            optionalResourceFields.url = url;
    }
    if (violations.length > 0) {
        for (const violation of violations)
            diagnostics.push({ code: "OBSERVED_PROJECTION_INVALID", path: violation.path, message: violation.message });
        return { diagnostics: diagnostics.slice(0, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.diagnostics) };
    }
    const projection = {
        version: SEMANTIC_PULL_REQUEST_OBSERVED_PROJECTION_VERSION,
        kind: "pull_request",
        ...optionalResourceFields,
        title,
        head,
        base,
        body,
        metadata: metadata,
        relations: { implements: relation },
    };
    return { projection: { projection: cloneImmutable(projection), relation }, diagnostics: [] };
}
function boundedDiagnosticValue(value) {
    if (typeof value === "string") {
        return value.length > SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.diagnosticValueLength
            ? `${value.slice(0, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.diagnosticValueLength)}…`
            : value;
    }
    if (Array.isArray(value))
        return value.slice(0, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.relationReferences).map(boundedDiagnosticValue);
    if (isRecord(value)) {
        const result = {};
        for (const key of Object.keys(value).sort(compareStrings).slice(0, 32))
            result[key] = boundedDiagnosticValue(value[key]);
        return result;
    }
    return value;
}
function comparisonResult(diagnostics) {
    const bounded = diagnostics.slice(0, SEMANTIC_PULL_REQUEST_OBSERVATION_LIMITS.diagnostics);
    return { valid: bounded.length === 0, diagnostics: bounded, drift: bounded };
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
function compareMetadata(desired, observed, diagnostics) {
    for (const key of ["labels", "assignees", "milestone", "reviewers", "draft", "maintainerCanModify"]) {
        if (!hasOwn(desired, key))
            continue;
        const expected = desired[key];
        const actual = observed[key];
        let equal = false;
        if (Array.isArray(expected) && Array.isArray(actual)) {
            const expectedValues = [...expected].map(String).sort(compareStrings);
            const actualValues = [...actual].map(String).sort(compareStrings);
            equal = stableSerialize(expectedValues) === stableSerialize(actualValues);
        }
        else
            equal = stableSerialize(expected) === stableSerialize(actual);
        if (!equal)
            addDrift(diagnostics, "METADATA_DRIFT", `$.metadata.${key}`, `Pull request metadata "${key}" differs from the desired projection.`, expected, actual);
    }
}
function compareRelation(desired, observed, diagnostics) {
    if (observed.representation === "conflict") {
        addDrift(diagnostics, "RELATION_CONFLICT", "$.relations.implements", "Observed implements representations conflict.", desired.references, observed.evidence);
        return;
    }
    const expectedReferences = desired.references;
    const evidence = observed.evidence;
    const sourceValues = [
        { source: "native", references: evidence.native },
        { source: "recognizedConvention", references: evidence.recognizedConvention },
        { source: "bodyFallback", references: evidence.bodyFallback },
    ];
    const nonEmpty = sourceValues.filter((entry) => entry.references !== undefined && entry.references.length > 0);
    if (nonEmpty.some((entry) => !sameReferences(expectedReferences, entry.references))) {
        const actual = nonEmpty.find((entry) => !sameReferences(expectedReferences, entry.references))?.references;
        addDrift(diagnostics, "RELATION_DRIFT", "$.relations.implements.references", "Observed implements relation differs from the desired projection.", expectedReferences, actual);
        return;
    }
    if (expectedReferences.length === 0) {
        if (nonEmpty.length > 0)
            addDrift(diagnostics, "RELATION_DRIFT", "$.relations.implements.references", "Observed an unexpected implements relation.", expectedReferences, nonEmpty[0]?.references);
        return;
    }
    const expectedSource = desired.representation === "native"
        ? "native"
        : desired.representation === "recognized-convention"
            ? "recognizedConvention"
            : desired.representation === "body-fallback"
                ? "bodyFallback"
                : undefined;
    if (expectedSource === undefined) {
        addDrift(diagnostics, "RELATION_DRIFT", "$.relations.implements.representation", "A non-empty relation cannot use the none representation.", expectedReferences, observed.references);
        return;
    }
    const source = sourceValues.find((entry) => entry.source === expectedSource)?.references;
    if (source === undefined) {
        addDrift(diagnostics, "RELATION_OBSERVATION_UNAVAILABLE", "$.relations.implements.evidence", "The expected native implements evidence was not supplied by the bounded observer.", expectedReferences);
    }
    else if (!sameReferences(expectedReferences, source)) {
        addDrift(diagnostics, "RELATION_DRIFT", "$.relations.implements.references", "Observed implements relation differs from the desired projection.", expectedReferences, source);
    }
}
/** Compare Core DesiredPullRequestProjection against observed GitHub evidence. */
export function compareSemanticPullRequestProjection(desired, observed) {
    let desiredInput = desired;
    let observedInput = observed;
    if (observed === undefined && isRecord(desired) && hasOwn(desired, "desired") && hasOwn(desired, "observed")) {
        desiredInput = desired.desired;
        observedInput = desired.observed;
    }
    const desiredResult = desiredProjectionValidation(desiredInput);
    const observedResult = observedProjectionValidation(observedInput);
    const diagnostics = [
        ...desiredResult.diagnostics,
        ...observedResult.diagnostics,
    ];
    if (diagnostics.length > 0 || desiredResult.projection === undefined || observedResult.projection === undefined)
        return comparisonResult(diagnostics);
    const expected = desiredResult.projection;
    const actual = observedResult.projection.projection;
    if (expected.title !== actual.title)
        addDrift(diagnostics, "TITLE_DRIFT", "$.title", "Pull request title differs from the desired projection.", expected.title, actual.title);
    if (expected.head !== actual.head)
        addDrift(diagnostics, "HEAD_DRIFT", "$.head", "Pull request head differs from the desired projection.", expected.head, actual.head);
    if (expected.base !== actual.base)
        addDrift(diagnostics, "BASE_DRIFT", "$.base", "Pull request base differs from the desired projection.", expected.base, actual.base);
    if (expected.body !== actual.body)
        addDrift(diagnostics, "BODY_DRIFT", "$.body", "Pull request body differs from the desired projection.", expected.body, actual.body);
    compareMetadata(expected.metadata, actual.metadata, diagnostics);
    compareRelation(expected.relation, observedResult.projection.relation, diagnostics);
    return comparisonResult(diagnostics);
}
export const compareDesiredPullRequestProjection = compareSemanticPullRequestProjection;
export const compareSemanticPullRequest = compareSemanticPullRequestProjection;
export const comparePullRequestProjection = compareSemanticPullRequestProjection;
export const diffSemanticPullRequestProjection = compareSemanticPullRequestProjection;
/** Convenience wrapper for callers that first normalize raw GitHub evidence. */
export function observeAndCompareSemanticPullRequest(desired, input, options) {
    const observed = tryObserveSemanticPullRequest(input, options);
    if (!observed.valid || observed.projection === undefined) {
        return comparisonResult(observed.violations.map((violation) => ({
            code: "OBSERVED_PROJECTION_INVALID",
            path: violation.path,
            message: violation.message,
        })));
    }
    return compareSemanticPullRequestProjection(desired, observed.projection);
}
//# sourceMappingURL=semantic-pr-observation.js.map