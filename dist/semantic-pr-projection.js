/**
 * Pure Core projection and planning for a materialized Semantic Artifact
 * whose kind is `pull_request`.
 *
 * The Semantic Artifact is the only semantic authority in this module.  In
 * particular, title, head, base, metadata, and `implements` are read from
 * the artifact and cannot be supplied as projection-time overrides.  This
 * module does not know a GitHub transport and never performs a mutation.
 */
import { createHash } from "node:crypto";
import { escapeMarkdownValue } from "./artifact.js";
import { issueReferenceKey, normalizeIssueReference } from "./contract/issue-reference.js";
export const SEMANTIC_PULL_REQUEST_PROJECTION_VERSION = "1";
export const SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION = "1";
/** Capability identifiers understood by the first PR projection slice. */
export const GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES = Object.freeze({
    nativeImplementsRelation: "github.pull_request.implements.native",
    recognizedClosingReference: "github.pull_request.implements.closing-reference",
    bodyRelationFallback: "github.pull_request.implements.body-fallback",
});
/** Short alias retained for callers that name the set by its projection role. */
export const SEMANTIC_PULL_REQUEST_CAPABILITIES = GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES;
export class SemanticPullRequestProjectionError extends Error {
    violations;
    constructor(violations) {
        super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
        this.name = "SemanticPullRequestProjectionError";
        this.violations = violations;
    }
}
const ARTIFACT_KEYS = new Set([
    "version",
    "effectiveContractVersion",
    "artifactContractVersion",
    "kind",
    "id",
    "values",
    "fields",
    "provenance",
    "generation",
]);
const PROJECTION_INPUT_KEYS = new Set(["artifact", "capabilities"]);
const CAPABILITY_FLAG_KEYS = new Set([
    "nativeImplementsRelation",
    "recognizedClosingReference",
    "bodyRelationFallback",
]);
const PR_PROPERTY_NAMES = new Set([
    "title",
    "head",
    "base",
    "type",
    "labels",
    "assignees",
    "milestone",
    "reviewers",
    "draft",
    "maintainerCanModify",
    "implements",
]);
const CAPABILITY_ALIASES = {
    native: new Set([
        GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES.nativeImplementsRelation,
        "pull-request.implements.native",
        "pull_request.implements.native",
    ]),
    recognized: new Set([
        GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES.recognizedClosingReference,
        "pull-request.implements.closing-reference",
        "pull_request.implements.closing-reference",
    ]),
    fallback: new Set([
        GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES.bodyRelationFallback,
        "pull-request.implements.body-fallback",
        "pull_request.implements.body-fallback",
    ]),
};
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
function unknownProperties(input, allowed, path, violations, code = "PROJECTION_INPUT_UNKNOWN_PROPERTY") {
    for (const key of Object.keys(input).sort(compareStrings)) {
        if (!allowed.has(key))
            addViolation(violations, code, `${path}.${key}`, `Property "${key}" is not supported.`);
    }
}
/** Stable JSON for Core values; object insertion order never affects output. */
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
function invalidResult(violations) {
    return { valid: false, violations };
}
function invalidPlanResult(violations) {
    return { valid: false, violations };
}
function requiredString(value, path, violations, maxLength = 255) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > maxLength ||
        /[\u0000-\u001F\u007F]/u.test(value)) {
        addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", path, "Value must be a bounded non-empty string.");
        return undefined;
    }
    return value;
}
function nonEmptyStringArray(value, path, violations) {
    if (!Array.isArray(value)) {
        addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", path, "Value must be an array of strings.");
        return undefined;
    }
    const values = [];
    const seen = new Set();
    value.forEach((entry, index) => {
        const parsed = requiredString(entry, `${path}[${index}]`, violations, 512);
        if (parsed === undefined)
            return;
        if (seen.has(parsed)) {
            addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", `${path}[${index}]`, "Values must be unique.");
            return;
        }
        seen.add(parsed);
        values.push(parsed);
    });
    return values;
}
function provenanceIsValid(value) {
    if (!isRecord(value) || value.authority !== "repository-default-branch")
        return false;
    if (!isRecord(value.repository) || !isRecord(value.source))
        return false;
    const repository = value.repository;
    const source = value.source;
    if (["host", "owner", "name", "nameWithOwner"].some((key) => typeof repository[key] !== "string" || repository[key].length === 0)) {
        return false;
    }
    if (repository.repositoryId !== undefined &&
        (typeof repository.repositoryId !== "string" || !/^[1-9][0-9]{0,19}$/u.test(repository.repositoryId))) {
        return false;
    }
    return (typeof value.ref === "string" &&
        value.ref.length > 0 &&
        typeof value.treeSha === "string" &&
        value.treeSha.length > 0 &&
        ["path", "ref", "sha", "digest"].every((key) => typeof source[key] === "string" && source[key].length > 0));
}
function validateProvenance(value, path, violations) {
    if (!provenanceIsValid(value)) {
        addViolation(violations, "SEMANTIC_ARTIFACT_PROVENANCE_INVALID", path, "Governance provenance is invalid.");
        return undefined;
    }
    try {
        stableSerialize(value);
    }
    catch {
        addViolation(violations, "SEMANTIC_ARTIFACT_PROVENANCE_INVALID", path, "Governance provenance is not JSON-compatible.");
        return undefined;
    }
    return value;
}
function normalizeCapabilities(input, violations) {
    const values = [];
    if (Array.isArray(input)) {
        input.forEach((entry, index) => {
            if (typeof entry !== "string" || entry.trim().length === 0) {
                addViolation(violations, "CAPABILITIES_INVALID", `$.capabilities[${index}]`, "Capability must be a non-empty string.");
                return;
            }
            values.push(entry);
        });
    }
    else if (isRecord(input)) {
        unknownProperties(input, CAPABILITY_FLAG_KEYS, "$.capabilities", violations, "CAPABILITIES_INVALID");
        for (const key of [...CAPABILITY_FLAG_KEYS].sort(compareStrings)) {
            if (hasOwn(input, key) && typeof input[key] !== "boolean") {
                addViolation(violations, "CAPABILITIES_INVALID", `$.capabilities.${key}`, "Capability flag must be boolean.");
            }
        }
        if (input.nativeImplementsRelation === true)
            values.push(GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES.nativeImplementsRelation);
        if (input.recognizedClosingReference === true)
            values.push(GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES.recognizedClosingReference);
        if (input.bodyRelationFallback === true)
            values.push(GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES.bodyRelationFallback);
    }
    else {
        addViolation(violations, "CAPABILITIES_INVALID", "$.capabilities", "Capabilities must be an array or flags object.");
        return undefined;
    }
    return [...new Set(values)].sort(compareStrings);
}
function hasCapability(capabilities, kind) {
    const aliases = CAPABILITY_ALIASES[kind];
    return capabilities.some((capability) => aliases.has(capability));
}
function validateJsonValue(value, path, violations, stack = new WeakSet()) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return;
    if (typeof value === "number" && Number.isFinite(value))
        return;
    if (typeof value !== "object" || value === null) {
        addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", path, "Value must be JSON-compatible.");
        return;
    }
    if (stack.has(value)) {
        addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", path, "Value must not contain cycles.");
        return;
    }
    if (!Array.isArray(value) && !isRecord(value)) {
        addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", path, "Value must be a plain JSON value.");
        return;
    }
    stack.add(value);
    if (Array.isArray(value))
        value.forEach((entry, index) => validateJsonValue(entry, `${path}[${index}]`, violations, stack));
    else
        Object.keys(value).forEach((key) => validateJsonValue(value[key], `${path}.${key}`, violations, stack));
    stack.delete(value);
}
function normalizeReferences(value, path, violations) {
    if (!Array.isArray(value)) {
        addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", path, "implements must be an array of IssueReference values.");
        return undefined;
    }
    const references = [];
    const seen = new Set();
    value.forEach((entry, index) => {
        const result = normalizeIssueReference(entry, `${path}[${index}]`);
        if (!result.valid || result.reference === undefined) {
            addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", `${path}[${index}]`, "IssueReference is invalid.");
            return;
        }
        const key = issueReferenceKey(result.reference);
        if (seen.has(key)) {
            addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", `${path}[${index}]`, "Issue references must be unique.");
            return;
        }
        seen.add(key);
        references.push(result.reference);
    });
    return references.sort((left, right) => compareStrings(issueReferenceKey(left), issueReferenceKey(right)));
}
function validateSemanticArtifact(input) {
    const violations = [];
    if (!isRecord(input)) {
        addViolation(violations, "SEMANTIC_ARTIFACT_INVALID", "$.artifact", "Semantic Artifact must be an object.");
        return { violations };
    }
    unknownProperties(input, ARTIFACT_KEYS, "$.artifact", violations, "SEMANTIC_ARTIFACT_INVALID");
    if (input.version !== "1")
        addViolation(violations, "SEMANTIC_ARTIFACT_INCOMPATIBLE", "$.artifact.version", "Semantic Artifact version is unsupported.");
    if (input.effectiveContractVersion !== "1")
        addViolation(violations, "SEMANTIC_ARTIFACT_INCOMPATIBLE", "$.artifact.effectiveContractVersion", "Effective Contract version is unsupported.");
    if (input.artifactContractVersion !== "1")
        addViolation(violations, "SEMANTIC_ARTIFACT_INCOMPATIBLE", "$.artifact.artifactContractVersion", "Artifact Contract version is unsupported.");
    if (input.kind !== "pull_request")
        addViolation(violations, "SEMANTIC_ARTIFACT_INCOMPATIBLE", "$.artifact.kind", "A pull_request Semantic Artifact is required.");
    const id = requiredString(input.id, "$.artifact.id", violations, 512);
    if (!isRecord(input.values))
        addViolation(violations, "SEMANTIC_ARTIFACT_INVALID", "$.artifact.values", "Semantic values must be an object.");
    if (!isRecord(input.fields))
        addViolation(violations, "SEMANTIC_ARTIFACT_INVALID", "$.artifact.fields", "Semantic fields must be an object.");
    const provenance = validateProvenance(input.provenance, "$.artifact.provenance", violations);
    const generation = validateProvenance(input.generation, "$.artifact.generation", violations);
    if (provenance !== undefined &&
        generation !== undefined &&
        stableSerialize(provenance) !== stableSerialize(generation)) {
        addViolation(violations, "SEMANTIC_ARTIFACT_PROVENANCE_INVALID", "$.artifact.generation", "Generation must equal provenance.");
    }
    const values = isRecord(input.values) ? input.values : {};
    const fields = isRecord(input.fields) ? input.fields : {};
    unknownProperties(values, PR_PROPERTY_NAMES, "$.artifact.values", violations, "SEMANTIC_ARTIFACT_VALUE_INVALID");
    for (const [key, value] of Object.entries(fields))
        validateJsonValue(value, `$.artifact.fields.${key}`, violations);
    const title = requiredString(values.title, "$.artifact.values.title", violations);
    const head = requiredString(values.head, "$.artifact.values.head", violations);
    const base = requiredString(values.base, "$.artifact.values.base", violations);
    const references = hasOwn(values, "implements")
        ? normalizeReferences(values.implements, "$.artifact.values.implements", violations)
        : [];
    const metadata = {};
    for (const key of ["labels", "assignees", "reviewers"]) {
        if (!hasOwn(values, key))
            continue;
        const parsed = nonEmptyStringArray(values[key], `$.artifact.values.${key}`, violations);
        if (parsed !== undefined)
            metadata[key] = [...parsed].sort(compareStrings);
    }
    if (hasOwn(values, "milestone")) {
        const milestone = requiredString(values.milestone, "$.artifact.values.milestone", violations, 512);
        if (milestone !== undefined)
            metadata.milestone = milestone;
    }
    for (const key of ["draft", "maintainerCanModify"]) {
        if (!hasOwn(values, key))
            continue;
        if (typeof values[key] !== "boolean")
            addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", `$.artifact.values.${key}`, "Value must be boolean.");
        else
            metadata[key] = values[key];
    }
    if (violations.length > 0 ||
        id === undefined ||
        title === undefined ||
        head === undefined ||
        base === undefined ||
        references === undefined ||
        provenance === undefined ||
        !isRecord(input.fields))
        return { violations };
    return {
        artifact: {
            artifact: input,
            title,
            head,
            base,
            references,
            metadata: metadata,
            fields,
            provenance,
        },
        violations: [],
    };
}
function relationLabel(reference, provenance) {
    const repository = provenance.repository;
    if (reference.repositoryHost.toLocaleLowerCase("en-US") === repository.host.toLocaleLowerCase("en-US") &&
        repository.repositoryId !== undefined &&
        reference.repositoryId === repository.repositoryId) {
        return `#${reference.number}`;
    }
    if (reference.repository !== undefined)
        return `${reference.repository}#${reference.number}`;
    return undefined;
}
function relationBodyLines(references, provenance, violations) {
    const lines = [];
    references.forEach((reference, index) => {
        const label = relationLabel(reference, provenance);
        if (label === undefined) {
            addViolation(violations, "RELATION_UNREPRESENTABLE", `$.artifact.values.implements[${index}]`, "The IssueReference has no repository locator for a GitHub closing-reference projection.");
            return;
        }
        lines.push(`Closes ${label}`);
    });
    return violations.length > 0 ? undefined : lines;
}
function relationFallbackMarker(references) {
    return `<!-- inari:semantic-relation ${stableSerialize({ version: "1", implements: references })} -->`;
}
function renderFieldValue(value) {
    if (typeof value === "string")
        return escapeMarkdownValue(value);
    if (Array.isArray(value)) {
        if (value.length === 0)
            return "[]";
        if (value.every((entry) => typeof entry === "string")) {
            return value.map((entry) => `- ${escapeMarkdownValue(entry)}`).join("\n");
        }
    }
    return escapeMarkdownValue(stableSerialize(value));
}
function fieldHeading(name) {
    return name
        .replace(/[\r\n]+/gu, " ")
        .trim()
        .replace(/^#+(?=\s|$)/u, "\\#");
}
function renderCanonicalBody(fields, relationRepresentation, references, provenance, violations) {
    const blocks = [];
    for (const key of Object.keys(fields).sort(compareStrings)) {
        blocks.push(`## ${fieldHeading(key)}\n\n${renderFieldValue(fields[key])}`);
    }
    if (relationRepresentation === "recognized-convention") {
        const lines = relationBodyLines(references, provenance, violations);
        if (lines !== undefined && lines.length > 0)
            blocks.push(lines.join("\n"));
    }
    else if (relationRepresentation === "body-fallback" && references.length > 0) {
        blocks.push(relationFallbackMarker(references));
    }
    if (violations.length > 0)
        return undefined;
    return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}
function projectionRequest(input, secondCapabilities, violations) {
    if (secondCapabilities !== undefined) {
        return { artifact: input, capabilities: secondCapabilities };
    }
    if (!isRecord(input)) {
        addViolation(violations, "PROJECTION_INPUT_INVALID", "$", "Projection input must be an object.");
        return undefined;
    }
    unknownProperties(input, PROJECTION_INPUT_KEYS, "$", violations);
    if (!hasOwn(input, "artifact"))
        addViolation(violations, "PROJECTION_INPUT_INVALID", "$.artifact", "Semantic Artifact is required.");
    if (!hasOwn(input, "capabilities"))
        addViolation(violations, "PROJECTION_INPUT_INVALID", "$.capabilities", "Declared capabilities are required.");
    return { artifact: input.artifact, capabilities: input.capabilities };
}
function buildProjection(input, secondCapabilities) {
    const violations = [];
    const request = projectionRequest(input, secondCapabilities, violations);
    if (request === undefined)
        return invalidResult(violations);
    const artifactResult = validateSemanticArtifact(request.artifact);
    violations.push(...artifactResult.violations);
    const artifact = artifactResult.artifact;
    const capabilities = normalizeCapabilities(request.capabilities, violations);
    if (artifact === undefined || capabilities === undefined || violations.length > 0)
        return invalidResult(violations);
    let representation = "none";
    if (artifact.references.length > 0) {
        if (hasCapability(capabilities, "native"))
            representation = "native";
        else if (hasCapability(capabilities, "recognized"))
            representation = "recognized-convention";
        else if (hasCapability(capabilities, "fallback"))
            representation = "body-fallback";
        else {
            addViolation(violations, "RELATION_UNREPRESENTABLE", "$.capabilities", "No declared GitHub capability can represent the semantic implements relation.");
        }
    }
    const body = renderCanonicalBody(artifact.fields, representation, artifact.references, artifact.provenance, violations);
    if (body === undefined) {
        if (violations.length === 0)
            addViolation(violations, "PROJECTION_BODY_INVALID", "$.desired.body", "Canonical body could not be rendered.");
        return invalidResult(violations);
    }
    const desired = {
        version: SEMANTIC_PULL_REQUEST_PROJECTION_VERSION,
        kind: "pull_request",
        title: artifact.title,
        head: artifact.head,
        base: artifact.base,
        body,
        metadata: artifact.metadata,
        relations: {
            implements: {
                relation: "implements",
                references: artifact.references,
                representation,
            },
        },
        provenance: artifact.provenance,
        generation: artifact.provenance,
    };
    return { valid: true, projection: cloneImmutable(desired), violations: [] };
}
/** Project a PR Semantic Artifact. No title/head/base/relation override exists. */
export function tryProjectSemanticPullRequest(input, capabilities) {
    return buildProjection(input, capabilities);
}
/** Throwing projection entry point for Core callers. */
export function projectSemanticPullRequest(input, capabilities) {
    const result = tryProjectSemanticPullRequest(input, capabilities);
    if (!result.valid || result.projection === undefined)
        throw new SemanticPullRequestProjectionError(result.violations);
    return result.projection;
}
export const projectSemanticPullRequestArtifact = projectSemanticPullRequest;
export const projectPullRequestSemanticArtifact = projectSemanticPullRequest;
function artifactDigest(artifact) {
    const payload = {
        version: artifact.version,
        effectiveContractVersion: artifact.effectiveContractVersion,
        artifactContractVersion: artifact.artifactContractVersion,
        kind: artifact.kind,
        id: artifact.id,
        values: artifact.values,
        fields: artifact.fields,
        provenance: artifact.provenance,
        generation: artifact.generation,
    };
    return createHash("sha256").update(stableSerialize(payload), "utf8").digest("hex");
}
/** Produce a declarative, versioned plan; this function has no GitHub I/O. */
export function tryPlanSemanticPullRequest(input, capabilities) {
    const projectionResult = tryProjectSemanticPullRequest(input, capabilities);
    if (!projectionResult.valid || projectionResult.projection === undefined)
        return invalidPlanResult(projectionResult.violations);
    const request = projectionRequest(input, capabilities, []);
    if (request === undefined) {
        return invalidPlanResult([
            { code: "MUTATION_PLAN_INVALID", path: "$", message: "Mutation plan input could not be resolved." },
        ]);
    }
    const artifactResult = validateSemanticArtifact(request.artifact);
    if (artifactResult.artifact === undefined) {
        return invalidPlanResult([
            { code: "MUTATION_PLAN_INVALID", path: "$.artifact", message: "Validated Semantic Artifact is required." },
        ]);
    }
    const generation = cloneImmutable(artifactResult.artifact.provenance);
    const desired = projectionResult.projection;
    const plan = {
        version: SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION,
        kind: "pull_request",
        artifact: {
            version: artifactResult.artifact.artifact.version,
            effectiveContractVersion: artifactResult.artifact.artifact.effectiveContractVersion,
            artifactContractVersion: artifactResult.artifact.artifact.artifactContractVersion,
            kind: "pull_request",
            id: artifactResult.artifact.artifact.id,
            digest: artifactDigest(artifactResult.artifact.artifact),
        },
        provenance: cloneImmutable(artifactResult.artifact.provenance),
        generation,
        capabilities: cloneImmutable(normalizeCapabilities(request.capabilities, []) ?? []),
        desired,
        preconditions: [
            { kind: "GOVERNANCE_GENERATION_MATCH", generation },
            { kind: "PULL_REQUEST_TARGET_ABSENT", head: desired.head, base: desired.base },
        ],
        effects: [{ kind: "CREATE_PULL_REQUEST", desired }],
    };
    return { valid: true, plan: cloneImmutable(plan), violations: [] };
}
export function planSemanticPullRequest(input, capabilities) {
    const result = tryPlanSemanticPullRequest(input, capabilities);
    if (!result.valid || result.plan === undefined)
        throw new SemanticPullRequestProjectionError(result.violations);
    return result.plan;
}
export const planSemanticPullRequestMutation = planSemanticPullRequest;
export const createSemanticPullRequestMutationPlan = planSemanticPullRequest;
/** Stable transport representation for the versioned plan. */
export function serializeSemanticPullRequestMutationPlan(input) {
    const result = validateSemanticPullRequestMutationPlan(input);
    if (!result.valid || result.plan === undefined)
        throw new SemanticPullRequestProjectionError(result.violations);
    return stableSerialize(result.plan);
}
/** Validate the bounded shape of a transported plan without executing it. */
export function validateSemanticPullRequestMutationPlan(input) {
    const violations = [];
    if (!isRecord(input)) {
        addViolation(violations, "MUTATION_PLAN_INVALID", "$", "Mutation plan must be an object.");
        return invalidPlanResult(violations);
    }
    const required = [
        "version",
        "kind",
        "artifact",
        "provenance",
        "generation",
        "capabilities",
        "desired",
        "preconditions",
        "effects",
    ];
    const allowed = new Set(required);
    unknownProperties(input, allowed, "$", violations, "MUTATION_PLAN_INVALID");
    if (input.version !== SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION)
        addViolation(violations, "MUTATION_PLAN_INVALID", "$.version", "Mutation plan version is unsupported.");
    if (input.kind !== "pull_request")
        addViolation(violations, "MUTATION_PLAN_INVALID", "$.kind", "Mutation plan kind is invalid.");
    if (!isRecord(input.artifact))
        addViolation(violations, "MUTATION_PLAN_INVALID", "$.artifact", "Artifact identity is required.");
    if (!provenanceIsValid(input.provenance))
        addViolation(violations, "MUTATION_PLAN_INVALID", "$.provenance", "Plan provenance is invalid.");
    if (!provenanceIsValid(input.generation))
        addViolation(violations, "MUTATION_PLAN_INVALID", "$.generation", "Plan generation is invalid.");
    if (provenanceIsValid(input.provenance) &&
        provenanceIsValid(input.generation) &&
        stableSerialize(input.provenance) !== stableSerialize(input.generation))
        addViolation(violations, "MUTATION_PLAN_INVALID", "$.generation", "Plan generation must equal provenance.");
    const capabilities = normalizeCapabilities(input.capabilities, violations);
    if (!Array.isArray(input.preconditions))
        addViolation(violations, "MUTATION_PLAN_INVALID", "$.preconditions", "Preconditions must be an array.");
    if (!Array.isArray(input.effects) || input.effects.length !== 1)
        addViolation(violations, "MUTATION_PLAN_INVALID", "$.effects", "A PR plan requires one explicit effect.");
    if (!isRecord(input.desired) || input.desired.kind !== "pull_request")
        addViolation(violations, "MUTATION_PLAN_INVALID", "$.desired", "Desired pull-request projection is required.");
    if (violations.length > 0 || capabilities === undefined)
        return invalidPlanResult(violations);
    return { valid: true, plan: cloneImmutable(input), violations: [] };
}
export function deserializeSemanticPullRequestMutationPlan(serialized) {
    let parsed;
    try {
        parsed = JSON.parse(serialized);
    }
    catch {
        throw new SemanticPullRequestProjectionError([
            { code: "MUTATION_PLAN_INVALID", path: "$", message: "Mutation plan must be valid JSON." },
        ]);
    }
    const result = validateSemanticPullRequestMutationPlan(parsed);
    if (!result.valid || result.plan === undefined)
        throw new SemanticPullRequestProjectionError(result.violations);
    return result.plan;
}
export const serializeSemanticPullRequestPlan = serializeSemanticPullRequestMutationPlan;
export const parseSemanticPullRequestMutationPlan = deserializeSemanticPullRequestMutationPlan;
//# sourceMappingURL=semantic-pr-projection.js.map