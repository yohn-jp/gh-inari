import { repairPartialSemanticInput, SemanticValidationError, validatePartialSemanticInput, validateSemanticInput, } from "./contract/validation.js";
import { createArtifactDiagnostic, createArtifactDiagnosticReport, createFieldEvidence, MAX_ARTIFACT_DIAGNOSTICS, } from "./diagnostics.js";
import { assertCanonicalContract, } from "./contract/ir.js";
import { createValidatedRenderedIssueArtifact, createValidatedRenderedPullRequestArtifact, } from "./github/capability.js";
export class ArtifactInputError extends Error {
    code;
    path;
    details;
    constructor(code, message, path = "$", details) {
        super(message);
        this.name = "ArtifactInputError";
        this.code = code;
        this.path = path;
        this.details = details;
    }
}
/** Stable failures raised before a mutation-capable artifact is created. */
export class ArtifactPreparationError extends Error {
    code;
    diagnostics;
    constructor(code, message, diagnostics = []) {
        super(message);
        this.name = "ArtifactPreparationError";
        this.code = code;
        this.diagnostics = createArtifactDiagnosticReport(diagnostics.slice(0, MAX_ARTIFACT_DIAGNOSTICS)).diagnostics;
    }
}
const GITHUB_NO_RESPONSE = "_No response_";
/** Explicit empty strings need a representation distinct from omitted values. */
const EXPLICIT_EMPTY_STRING_MARKER = "\u200B";
/**
 * Bounded invisible template identity marker embedded in newly rendered
 * artifacts. It is the primary template-selection signal for governed
 * read/repair/validation; legacy artifacts without a marker (or with one
 * that cannot be trusted) fall back to deterministic structural matching.
 * The marker is metadata only: it never substitutes for the authoritative
 * repository governance/provenance that resolves the actual contract.
 */
export const TEMPLATE_IDENTITY_MARKER_VERSION = "1";
const TEMPLATE_IDENTITY_MARKER_PREFIX = "<!-- inari:template ";
const TEMPLATE_IDENTITY_MARKER_SUFFIX = " -->";
const TEMPLATE_IDENTITY_MARKER_LINE_PATTERN = /^<!-- inari:template (\{.*\}) -->$/u;
const TEMPLATE_IDENTITY_MARKER_MAX_LENGTH = 512;
function renderTemplateIdentityMarker(contract) {
    const marker = {
        version: TEMPLATE_IDENTITY_MARKER_VERSION,
        kind: contract.artifactKind,
        path: contract.templateIdentity.path,
    };
    return `${TEMPLATE_IDENTITY_MARKER_PREFIX}${JSON.stringify(marker)}${TEMPLATE_IDENTITY_MARKER_SUFFIX}`;
}
/**
 * Recognize and remove a trailing template identity marker line without
 * applying semantic parsing. Only a line starting with the exact reserved
 * marker prefix is treated as a marker attempt at all; ordinary trailing
 * HTML comments (e.g. PR template scaffolding) are left untouched here and
 * handled by the existing comment-stripping path. Once the reserved prefix
 * is detected, the line is never silently ignored as "absent" again: an
 * oversized, truncated, or otherwise broken marker attempt fails closed as
 * "malformed" instead of falling through to structural matching.
 */
export function extractTemplateIdentityMarker(body) {
    const source = normalizeSource(body);
    const lines = source.split("\n");
    let end = lines.length;
    while (end > 0 && (lines[end - 1] ?? "").trim().length === 0)
        end -= 1;
    const candidate = end > 0 ? (lines[end - 1] ?? "").trim() : undefined;
    if (candidate === undefined || !candidate.startsWith(TEMPLATE_IDENTITY_MARKER_PREFIX)) {
        return { status: "absent", body: source };
    }
    const remaining = lines.slice(0, end - 1);
    while (remaining.at(-1) !== undefined && (remaining.at(-1) ?? "").trim().length === 0)
        remaining.pop();
    const strippedBody = remaining.length === 0 ? "" : `${remaining.join("\n")}\n`;
    if (candidate.length > TEMPLATE_IDENTITY_MARKER_MAX_LENGTH || !candidate.endsWith(TEMPLATE_IDENTITY_MARKER_SUFFIX)) {
        return { status: "malformed", body: strippedBody };
    }
    const match = TEMPLATE_IDENTITY_MARKER_LINE_PATTERN.exec(candidate);
    if (match === null)
        return { status: "malformed", body: strippedBody };
    let payload;
    try {
        payload = JSON.parse(match[1]);
    }
    catch {
        return { status: "malformed", body: strippedBody };
    }
    if (!isTemplateIdentityMarkerShape(payload))
        return { status: "malformed", body: strippedBody };
    if (payload.version !== TEMPLATE_IDENTITY_MARKER_VERSION) {
        return { status: "unsupported-version", marker: payload, body: strippedBody };
    }
    return { status: "valid", marker: payload, body: strippedBody };
}
function isTemplateIdentityMarkerShape(value) {
    return (isRecord(value) &&
        typeof value.version === "string" &&
        (value.kind === "issue" || value.kind === "pull_request") &&
        typeof value.path === "string" &&
        value.path.trim().length > 0);
}
/** Parse the documented JSON input envelope while keeping field semantics adapter-independent. */
export function parseArtifactInputDocument(input) {
    if (!isRecord(input))
        throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "Input must be a JSON object.");
    const metadataKeys = ["title", "labels", "assignees", "head", "base", "draft", "maintainerCanModify"];
    if (Object.prototype.hasOwnProperty.call(input, "fields")) {
        if (!isRecord(input.fields))
            throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "fields must be an object.", "$.fields");
        const metadata = {};
        for (const key of metadataKeys) {
            if (input[key] !== undefined)
                metadata[key] = input[key];
        }
        const unknown = Object.keys(input).filter((key) => key !== "fields" && !Object.prototype.hasOwnProperty.call(metadata, key));
        if (unknown.length > 0)
            throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", `Unknown input property "${unknown[0]}".`, `$.${unknown[0]}`);
        return { fields: input.fields, metadata: parseMetadata(metadata) };
    }
    const reservedInBare = Object.keys(input).find((key) => metadataKeys.includes(key));
    if (reservedInBare !== undefined) {
        throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", `Reserved metadata key "${reservedInBare}" cannot appear without a fields property.`, `$.${reservedInBare}`);
    }
    return { fields: input, metadata: {} };
}
/** Adapt a parsed JSON envelope without granting it canonical status. */
export function adaptJsonArtifactCandidate(input) {
    const document = parseArtifactInputDocument(input);
    return { ...document, source: "json" };
}
/** Adapt internal structured fields to the same candidate shape as JSON. */
export function adaptFieldArtifactCandidate(fields, metadata = {}) {
    if (!isRecord(fields)) {
        throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "Candidate fields must be an object.", "$.fields");
    }
    return { fields, metadata, source: "fields" };
}
/** Alias used by command adapters that call this input the CLI field path. */
export const adaptCliFieldCandidate = adaptFieldArtifactCandidate;
/** Generic adapter spelling for callers that already hold structured fields. */
export const adaptArtifactCandidate = adaptFieldArtifactCandidate;
/** Adapt an existing native artifact body through the repository parser. */
export function adaptMarkdownArtifactCandidate(contractInput, body) {
    assertCanonicalContract(contractInput);
    const contract = contractInput;
    const parse = contract.artifactKind === "issue"
        ? parseExistingIssueArtifact(contract, body)
        : parseExistingPullRequestArtifact(contract, body);
    if (!parse.parsed)
        return { parsed: false, diagnostics: parse.diagnostics };
    return {
        parsed: true,
        candidate: { fields: parse.values, metadata: {}, source: "markdown" },
        diagnostics: parse.diagnostics,
    };
}
/** Existing GitHub bodies use the same native Markdown adapter by design. */
export function adaptExistingArtifactCandidate(contractInput, body) {
    const adapted = adaptMarkdownArtifactCandidate(contractInput, body);
    return adapted.candidate === undefined
        ? adapted
        : { ...adapted, candidate: { ...adapted.candidate, source: "existing" } };
}
/**
 * Reload a candidate against the selected canonical contract.  Complete input
 * takes the normal one-pass validator (and therefore may materialize contract
 * defaults); incomplete/invalid input uses the bounded partial contract and
 * exposes only accepted semantic values.
 */
export function loadCanonicalArtifact(contractInput, candidateInput) {
    assertCanonicalContract(contractInput);
    const candidate = normalizeArtifactCandidate(candidateInput);
    const validation = validateSemanticInput(contractInput, candidate.fields);
    if (validation.valid) {
        const acceptedFields = Object.keys(validation.values)
            .sort(compareStrings)
            .map((field) => `$.fields.${field}`);
        const diagnostics = createArtifactDiagnosticReport([], acceptedFields);
        return {
            valid: true,
            complete: true,
            canonical: validation.values,
            canonicalJson: validation.values,
            values: validation.values,
            candidate,
            acceptedFields,
            missingFields: [],
            invalidFields: [],
            diagnostics,
            violations: [],
        };
    }
    const partial = validatePartialSemanticInput(contractInput, candidate.fields);
    return {
        valid: false,
        complete: false,
        canonical: partial.values,
        canonicalJson: partial.values,
        values: partial.values,
        candidate,
        acceptedFields: partial.acceptedFields,
        missingFields: partial.missingFields,
        invalidFields: partial.invalidFields,
        diagnostics: partial.diagnostics,
        violations: validation.violations,
    };
}
/** Explicitly named alias for callers that pass a candidate object. */
export const loadCanonicalCandidate = loadCanonicalArtifact;
/** Load a JSON representation through the canonical contract boundary. */
export function loadCanonicalJsonArtifact(contractInput, input) {
    return loadCanonicalArtifact(contractInput, adaptJsonArtifactCandidate(input));
}
/** Load native Markdown through the same parser and canonical contract. */
export function loadCanonicalMarkdownArtifact(contractInput, body) {
    const adapted = adaptMarkdownArtifactCandidate(contractInput, body);
    if (!adapted.parsed || adapted.candidate === undefined) {
        const candidate = { fields: {}, metadata: {}, source: "markdown" };
        const diagnostics = markdownDiagnostics(adapted.diagnostics);
        return {
            valid: false,
            complete: false,
            canonical: {},
            canonicalJson: {},
            values: {},
            candidate,
            acceptedFields: [],
            missingFields: [],
            invalidFields: [],
            diagnostics,
            violations: [],
        };
    }
    return loadCanonicalArtifact(contractInput, adapted.candidate);
}
/** Existing-body spelling retained so read/repair callers share one boundary. */
export function loadCanonicalExistingArtifact(contractInput, body) {
    const adapted = adaptExistingArtifactCandidate(contractInput, body);
    if (!adapted.parsed || adapted.candidate === undefined) {
        const candidate = { fields: {}, metadata: {}, source: "existing" };
        const diagnostics = markdownDiagnostics(adapted.diagnostics);
        return {
            valid: false,
            complete: false,
            canonical: {},
            canonicalJson: {},
            values: {},
            candidate,
            acceptedFields: [],
            missingFields: [],
            invalidFields: [],
            diagnostics,
            violations: [],
        };
    }
    return loadCanonicalArtifact(contractInput, adapted.candidate);
}
function normalizeArtifactCandidate(input) {
    if (isArtifactCandidate(input))
        return input;
    if (isRecord(input) && input.parsed === true && isArtifactCandidate(input.candidate))
        return input.candidate;
    if (isArtifactInputDocument(input))
        return { ...input, source: "json" };
    return adaptJsonArtifactCandidate(input);
}
function isArtifactCandidate(input) {
    return (isRecord(input) &&
        (input.source === "json" ||
            input.source === "markdown" ||
            input.source === "existing" ||
            input.source === "fields") &&
        Object.prototype.hasOwnProperty.call(input, "fields") &&
        isRecord(input.metadata));
}
function isArtifactInputDocument(input) {
    return isRecord(input) && Object.prototype.hasOwnProperty.call(input, "fields") && isRecord(input.metadata);
}
function markdownDiagnostics(diagnostics) {
    const projected = diagnostics.slice(0, 32).map((diagnostic) => createArtifactDiagnostic({
        state: "unsupported",
        code: "FIELD_UNSUPPORTED",
        detailCode: diagnostic.code === "EXISTING_AMBIGUOUS_TEMPLATE" ? "TEMPLATE_AMBIGUOUS" : "TEMPLATE_UNPARSEABLE",
        reason: "unsupported",
        path: diagnostic.path,
        message: diagnostic.message,
        recovery: [
            {
                action: diagnostic.code === "EXISTING_AMBIGUOUS_TEMPLATE" ? "select-template" : "retry",
                path: diagnostic.path,
            },
        ],
    }));
    return createArtifactDiagnosticReport(projected, []);
}
/** Classify an artifact input envelope without applying semantic defaults. */
export function validatePartialArtifactInput(contractInput, input) {
    assertCanonicalContract(contractInput);
    return validatePartialSemanticInput(contractInput, parseArtifactInputDocument(input).fields);
}
/** Terminology alias for callers that treat validation as classification. */
export const classifyPartialArtifactInput = validatePartialArtifactInput;
/** Merge only a targeted field patch into a prior stateless partial result. */
export function repairPartialArtifactInput(contractInput, previous, patch) {
    assertCanonicalContract(contractInput);
    return repairPartialSemanticInput(contractInput, previous, patch);
}
/** Terminology alias for callers that describe targeted repair as a merge. */
export const mergePartialArtifactInput = repairPartialArtifactInput;
export function renderIssueArtifact(contractInput, input) {
    assertCanonicalContract(contractInput);
    if (contractInput.artifactKind !== "issue")
        throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "An Issue contract is required.");
    const loaded = loadCanonicalArtifact(contractInput, input);
    if (!loaded.valid)
        throw new SemanticValidationError(loaded.violations);
    return renderIssueBody(contractInput, loaded.canonical);
}
export function renderPullRequestArtifact(contractInput, input) {
    assertCanonicalContract(contractInput);
    if (contractInput.artifactKind !== "pull_request") {
        throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "A pull request contract is required.");
    }
    const loaded = loadCanonicalArtifact(contractInput, input);
    if (!loaded.valid)
        throw new SemanticValidationError(loaded.violations);
    return renderPullRequestBody(contractInput, loaded.canonical);
}
/** Construct the only values accepted by the GitHub mutation adapter. */
export function prepareIssueArtifact(contractInput, input) {
    assertCanonicalContract(contractInput);
    if (contractInput.artifactKind !== "issue")
        throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "An Issue contract is required.");
    requireTrustedProvenance(contractInput);
    const loaded = loadCanonicalArtifact(contractInput, input);
    if (!loaded.valid)
        throw new SemanticValidationError(loaded.violations);
    const title = requiredMetadataString(input.metadata.title ?? contractInput.nativeMetadata.title, "title");
    const labels = mergeIssueLabels(contractInput.nativeMetadata.labels, input.metadata.labels);
    const expectedLabels = contractInput.nativeMetadata.labels === undefined && input.metadata.labels === undefined
        ? undefined
        : [...(contractInput.nativeMetadata.labels ?? []), ...(input.metadata.labels ?? [])];
    const body = renderIssueBody(contractInput, loaded.canonical);
    verifyRenderedRoundTrip(contractInput, loaded.canonical, body, "issue");
    const artifact = createValidatedRenderedIssueArtifact({
        kind: "issue",
        title,
        body,
        provenance: contractInput.provenance,
        ...(labels === undefined ? {} : { labels }),
        ...(input.metadata.assignees === undefined ? {} : { assignees: input.metadata.assignees }),
    });
    verifyIssueMetadataRoundTrip({
        title,
        ...(expectedLabels === undefined ? {} : { labels: expectedLabels }),
        ...(input.metadata.assignees === undefined ? {} : { assignees: input.metadata.assignees }),
    }, artifact);
    return { input, validation: semanticValidationFromLoad(loaded), artifact };
}
export function preparePullRequestArtifact(contractInput, input) {
    assertCanonicalContract(contractInput);
    if (contractInput.artifactKind !== "pull_request") {
        throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "A pull request contract is required.");
    }
    requireTrustedProvenance(contractInput);
    const loaded = loadCanonicalArtifact(contractInput, input);
    if (!loaded.valid)
        throw new SemanticValidationError(loaded.violations);
    const title = requiredMetadataString(input.metadata.title, "title");
    const head = requiredMetadataString(input.metadata.head, "head");
    const base = requiredMetadataString(input.metadata.base, "base");
    const body = renderPullRequestBody(contractInput, loaded.canonical);
    verifyRenderedRoundTrip(contractInput, loaded.canonical, body, "pull_request");
    const artifact = createValidatedRenderedPullRequestArtifact({
        kind: "pull_request",
        title,
        body,
        provenance: contractInput.provenance,
        head,
        base,
        ...(input.metadata.draft === undefined ? {} : { draft: input.metadata.draft }),
        ...(input.metadata.maintainerCanModify === undefined
            ? {}
            : { maintainerCanModify: input.metadata.maintainerCanModify }),
    });
    verifyPullRequestMetadataRoundTrip(input.metadata, artifact);
    return { input, validation: semanticValidationFromLoad(loaded), artifact };
}
export function parseExistingIssueArtifact(contractInput, body) {
    assertCanonicalContract(contractInput);
    if (contractInput.artifactKind !== "issue")
        throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "An Issue contract is required.");
    return parseRenderedBody(contractInput, body ?? "", 3, false);
}
export function parseExistingPullRequestArtifact(contractInput, body) {
    assertCanonicalContract(contractInput);
    if (contractInput.artifactKind !== "pull_request") {
        throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", "A pull request contract is required.");
    }
    return parseRenderedBody(contractInput, body ?? "", undefined, true);
}
/**
 * Recover field values from a malformed or wrong-template body without
 * weakening the strict existing-artifact parser. The section boundaries and
 * field decoding are the same parser primitives used by strict parsing; only
 * the order/complete-structure requirement is relaxed for an explicitly
 * selected repair target.
 */
export function recoverExistingArtifactValues(contractInput, body) {
    assertCanonicalContract(contractInput);
    const contract = contractInput;
    const strict = contract.artifactKind === "issue"
        ? parseExistingIssueArtifact(contract, body)
        : parseExistingPullRequestArtifact(contract, body);
    if (strict.parsed)
        return { values: strict.values, diagnostics: strict.diagnostics };
    const markerFreeBody = extractTemplateIdentityMarker(body ?? "").body;
    const stripComments = contract.artifactKind === "pull_request";
    const source = normalizeSource(stripComments ? removeHtmlComments(markerFreeBody) : markerFreeBody);
    const blocks = headingBlocks(source);
    const values = {};
    const expectedTitles = new Map();
    for (const section of contract.sections) {
        if (section.kind !== "input")
            continue;
        const field = section.fields[0];
        const title = section.title ?? field?.label;
        if (field === undefined || title === undefined)
            continue;
        const expectedTitle = escapeHeading(title);
        expectedTitles.set(expectedTitle, (expectedTitles.get(expectedTitle) ?? 0) + 1);
    }
    for (const section of contract.sections) {
        if (section.kind !== "input")
            continue;
        const field = section.fields[0];
        const title = section.title ?? field?.label;
        if (field === undefined || title === undefined)
            continue;
        const expectedTitle = escapeHeading(title);
        if (expectedTitles.get(expectedTitle) !== 1)
            continue;
        const candidates = blocks.filter((block) => block.title === expectedTitle);
        if (candidates.length !== 1)
            continue;
        const block = candidates[0];
        const parsed = parseFieldLines(field, block.body, `$.${field.id}`, stripComments, contract.artifactKind === "issue");
        // parseFieldLines may retain known checklist selections alongside a
        // bounded structural diagnostic. The canonical loader below decides
        // whether such a partial value is semantically usable.
        if (parsed.value !== undefined)
            values[field.id] = parsed.value;
    }
    return { values, diagnostics: strict.diagnostics };
}
export function validateExistingIssueArtifact(contractInput, body) {
    assertCanonicalContract(contractInput);
    const parse = parseExistingIssueArtifact(contractInput, body);
    return validateParsedArtifact(contractInput, parse);
}
export function validateExistingPullRequestArtifact(contractInput, body) {
    assertCanonicalContract(contractInput);
    const parse = parseExistingPullRequestArtifact(contractInput, body);
    return validateParsedArtifact(contractInput, parse);
}
/** Project only validated semantic values; invalid artifacts never expose parsed fields. */
export function projectExistingArtifact(result) {
    return {
        valid: result.valid,
        projection: result.valid ? "canonical" : "unavailable",
        classification: result.classification,
        ...(result.valid ? { fields: result.parse.values } : {}),
        diagnostics: result.parse.diagnostics,
        ...(result.classification === "semantic" ? { violations: result.violations } : {}),
        ...(result.attemptedTemplates === undefined ? {} : { attemptedTemplates: result.attemptedTemplates }),
    };
}
/** Select a uniquely parsed governed artifact, failing closed on ambiguity. */
export function selectExistingArtifactCandidate(candidates) {
    const parsed = candidates.filter((candidate) => candidate.result.parse.parsed);
    if (parsed.length === 1) {
        const selected = parsed[0];
        return selected;
    }
    if (parsed.length > 1) {
        const paths = parsed.map((candidate) => candidate.contract.templateIdentity.path).sort(compareStrings);
        const diagnostic = {
            code: "EXISTING_AMBIGUOUS_TEMPLATE",
            path: "$.template",
            message: `Artifact structure matches multiple repository-native templates: ${paths.join(", ")}.`,
        };
        return {
            result: {
                valid: false,
                classification: "ambiguous",
                parse: { parsed: false, values: {}, diagnostics: [diagnostic] },
                violations: [diagnostic],
            },
        };
    }
    const attemptedTemplates = candidates
        .map((candidate) => candidate.contract.templateIdentity.path)
        .sort(compareStrings);
    const classification = candidates.some((candidate) => candidate.result.parse.diagnostics.some((diagnostic) => diagnostic.code === "EXISTING_WRONG_TEMPLATE"))
        ? "wrong-template"
        : "unparseable";
    const diagnostic = {
        code: classification === "wrong-template" ? "EXISTING_WRONG_TEMPLATE" : "EXISTING_UNPARSEABLE",
        path: "$.template",
        message: classification === "wrong-template"
            ? `Artifact structure does not match any repository-native template. Tried: ${attemptedTemplates.join(", ")}.`
            : `Artifact could not be parsed against any repository-native template. Tried: ${attemptedTemplates.join(", ")}.`,
    };
    return {
        result: {
            valid: false,
            classification,
            parse: { parsed: false, values: {}, diagnostics: [diagnostic] },
            violations: [diagnostic],
            attemptedTemplates,
        },
    };
}
/** Validate the same required string metadata enforced by mutation preparation. */
export function validateRequiredMetadataString(value, key) {
    if (typeof value === "string" && value.trim().length > 0)
        return undefined;
    return {
        code: "INPUT_METADATA_INVALID",
        path: `$.${key}`,
        message: `${key} must be a non-empty string.`,
    };
}
export async function validateExistingIssueFromAdapter(reader, contract, issueNumber) {
    const issue = await reader.getIssue(issueNumber);
    return { number: issueNumber, url: issue.url, result: validateExistingIssueArtifact(contract, issue.body) };
}
export async function validateExistingPullRequestFromAdapter(reader, contract, pullRequestNumber) {
    const pullRequest = await reader.getPullRequest(pullRequestNumber);
    return {
        number: pullRequestNumber,
        url: pullRequest.url,
        result: validateExistingPullRequestArtifact(contract, pullRequest.body),
    };
}
function validateParsedArtifact(contract, parse) {
    if (!parse.parsed) {
        const classification = parse.diagnostics.some((diagnostic) => diagnostic.code === "EXISTING_WRONG_TEMPLATE")
            ? "wrong-template"
            : "unparseable";
        return { valid: false, classification, parse, violations: parse.diagnostics };
    }
    const semantic = loadCanonicalArtifact(contract, {
        fields: parse.values,
        metadata: {},
        source: "existing",
    });
    return {
        valid: semantic.valid,
        classification: semantic.valid ? "valid" : "semantic",
        parse,
        violations: semantic.violations,
    };
}
function requireTrustedProvenance(contract) {
    if (contract.provenance === undefined) {
        throw new ArtifactPreparationError("ARTIFACT_PROVENANCE_MISSING", "Mutation preparation requires a contract bound to trusted repository governance.", [
            createArtifactDiagnostic({
                state: "unrecoverable",
                code: "ARTIFACT_UNRECOVERABLE",
                reason: "unrecoverable",
                path: "$.provenance",
                message: "The compiled contract has no trusted repository/ref provenance.",
                recovery: [{ action: "retry", path: "$.provenance" }],
            }),
        ]);
    }
}
function verifyPullRequestMetadataRoundTrip(input, artifact) {
    const expected = {
        title: input.title,
        head: input.head,
        base: input.base,
        ...(input.draft === undefined ? {} : { draft: input.draft }),
        ...(input.maintainerCanModify === undefined ? {} : { maintainerCanModify: input.maintainerCanModify }),
    };
    const actual = {
        title: artifact.title,
        head: artifact.head,
        base: artifact.base,
        ...(artifact.draft === undefined ? {} : { draft: artifact.draft }),
        ...(artifact.maintainerCanModify === undefined ? {} : { maintainerCanModify: artifact.maintainerCanModify }),
    };
    const mismatches = [];
    for (const key of Object.keys(expected).sort(compareStrings)) {
        const path = `$.metadata.${key}`;
        if (stableValue(expected[key]) === stableValue(actual[key]))
            continue;
        mismatches.push(createArtifactDiagnostic({
            state: "conflicting",
            code: "FIELD_CONFLICT",
            detailCode: "FIELD_VALUE_CONFLICT",
            reason: "conflict",
            path,
            message: "Prepared pull request metadata changed before the mutation boundary.",
            expected: createFieldEvidence(path, expected[key]),
            actual: createFieldEvidence(path, actual[key]),
            recovery: [{ action: "repair", path, hint: "Repair the pull request metadata projection." }],
        }));
    }
    if (mismatches.length > 0) {
        throw new ArtifactPreparationError("ARTIFACT_ROUND_TRIP_INVALID", "Prepared pull request metadata did not preserve its validated values.", mismatches);
    }
}
function verifyIssueMetadataRoundTrip(expected, artifact) {
    const actual = {
        title: artifact.title,
        ...(artifact.labels === undefined ? {} : { labels: artifact.labels }),
        ...(artifact.assignees === undefined ? {} : { assignees: artifact.assignees }),
    };
    const mismatches = [];
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort(compareStrings);
    for (const key of keys) {
        const expectedPresent = Object.prototype.hasOwnProperty.call(expected, key);
        const actualPresent = Object.prototype.hasOwnProperty.call(actual, key);
        const path = `$.metadata.${key}`;
        if (expectedPresent && actualPresent && stableValue(expected[key]) === stableValue(actual[key]))
            continue;
        mismatches.push(createArtifactDiagnostic({
            state: "conflicting",
            code: "FIELD_CONFLICT",
            detailCode: "FIELD_VALUE_CONFLICT",
            reason: "conflict",
            path,
            message: "Prepared issue metadata changed before the mutation boundary.",
            expected: createFieldEvidence(path, expectedPresent ? expected[key] : undefined),
            actual: createFieldEvidence(path, actualPresent ? actual[key] : undefined),
            recovery: [{ action: "repair", path, hint: "Repair the issue metadata projection." }],
        }));
    }
    if (mismatches.length > 0) {
        throw new ArtifactPreparationError("ARTIFACT_ROUND_TRIP_INVALID", "Prepared issue metadata did not preserve its validated values.", mismatches);
    }
}
function verifyRenderedRoundTrip(contract, expectedValues, body, kind) {
    const parsed = kind === "issue" ? parseExistingIssueArtifact(contract, body) : parseExistingPullRequestArtifact(contract, body);
    if (!parsed.parsed) {
        throw new ArtifactPreparationError("ARTIFACT_ROUND_TRIP_INVALID", `Rendered ${kind} artifact did not reparse under the compiled contract.`, roundTripParseDiagnostics(contract, expectedValues, parsed.diagnostics));
    }
    const reconstructed = validateSemanticInput(contract, parsed.values);
    if (!reconstructed.valid) {
        throw new ArtifactPreparationError("ARTIFACT_ROUND_TRIP_INVALID", `Rendered ${kind} artifact failed semantic validation after reparsing.`, roundTripSemanticDiagnostics(contract, expectedValues, parsed.values, reconstructed.violations));
    }
    const mismatches = compareMaterializedValues(expectedValues, reconstructed.values);
    if (mismatches.length > 0) {
        throw new ArtifactPreparationError("ARTIFACT_ROUND_TRIP_INVALID", `Rendered ${kind} artifact did not preserve its validated semantic values.`, mismatches);
    }
}
function roundTripParseDiagnostics(contract, expectedValues, diagnostics) {
    const projected = diagnostics.slice(0, MAX_ARTIFACT_DIAGNOSTICS).map((diagnostic) => {
        const fieldId = semanticFieldId(contract, diagnostic.path);
        const path = fieldId === undefined ? semanticDiagnosticPath(contract, diagnostic.path) : fieldPath(fieldId);
        return createArtifactDiagnostic({
            state: "unsupported",
            code: "FIELD_UNSUPPORTED",
            detailCode: "TEMPLATE_UNPARSEABLE",
            reason: "unsupported",
            ...(path === undefined ? {} : { path }),
            message: roundTripParseMessage(diagnostic.code),
            ...(fieldId === undefined
                ? {}
                : {
                    expected: createFieldEvidence(fieldPath(fieldId), expectedValues[fieldId]),
                    actual: createFieldEvidence(fieldPath(fieldId), undefined),
                }),
            recovery: path === undefined ? [{ action: "retry" }] : [{ action: "repair", path }],
        });
    });
    return projected.length > 0
        ? projected
        : [
            createArtifactDiagnostic({
                state: "unrecoverable",
                code: "ARTIFACT_UNRECOVERABLE",
                reason: "unrecoverable",
                message: "Rendered artifact could not be reparsed under the compiled contract.",
                recovery: [{ action: "retry" }],
            }),
        ];
}
function roundTripSemanticDiagnostics(contract, expectedValues, actualValues, violations) {
    const projected = violations.slice(0, MAX_ARTIFACT_DIAGNOSTICS).map((violation) => {
        const fieldId = semanticFieldId(contract, violation.path);
        const path = fieldId === undefined ? semanticDiagnosticPath(contract, violation.path) : fieldPath(fieldId);
        const evidencePath = fieldId === undefined ? path : fieldPath(fieldId);
        return createArtifactDiagnostic({
            state: "invalid",
            code: "FIELD_INVALID",
            detailCode: violation.code === "INPUT_TYPE" ? "FIELD_TYPE_MISMATCH" : "FIELD_CONSTRAINT_VIOLATION",
            reason: violation.code === "INPUT_TYPE" ? "type" : "constraint",
            ...(path === undefined ? {} : { path }),
            message: violation.code === "INPUT_TYPE"
                ? "Reparsed semantic value has an unsupported type."
                : "Reparsed semantic value violates a compiled constraint.",
            ...(evidencePath === undefined
                ? {}
                : {
                    expected: createFieldEvidence(evidencePath, fieldId === undefined ? undefined : expectedValues[fieldId]),
                    actual: createFieldEvidence(evidencePath, fieldId === undefined ? undefined : actualValues[fieldId]),
                }),
            recovery: path === undefined ? [{ action: "repair" }] : [{ action: "repair", path }],
        });
    });
    return projected.length > 0
        ? projected
        : [
            createArtifactDiagnostic({
                state: "unrecoverable",
                code: "ARTIFACT_UNRECOVERABLE",
                reason: "unrecoverable",
                message: "Reparsed artifact failed semantic validation under the compiled contract.",
                recovery: [{ action: "retry" }],
            }),
        ];
}
function compareMaterializedValues(expected, actual) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort(compareStrings);
    const diagnostics = [];
    for (const key of keys) {
        const expectedPresent = Object.prototype.hasOwnProperty.call(expected, key);
        const actualPresent = Object.prototype.hasOwnProperty.call(actual, key);
        const path = fieldPath(key);
        if (!expectedPresent || !actualPresent) {
            diagnostics.push(createArtifactDiagnostic({
                state: "conflicting",
                code: "FIELD_CONFLICT",
                detailCode: "FIELD_VALUE_CONFLICT",
                reason: "conflict",
                path,
                message: "Rendered artifact changed whether this semantic field was materialized.",
                expected: createFieldEvidence(path, expectedPresent ? expected[key] : undefined),
                actual: createFieldEvidence(path, actualPresent ? actual[key] : undefined),
                recovery: [{ action: "repair", path, hint: "Repair the renderer/parser mapping for this field." }],
            }));
            continue;
        }
        if (stableValue(expected[key]) !== stableValue(actual[key])) {
            diagnostics.push(createArtifactDiagnostic({
                state: "conflicting",
                code: "FIELD_CONFLICT",
                detailCode: "FIELD_VALUE_CONFLICT",
                reason: "conflict",
                path,
                message: "Rendered artifact changed this materialized semantic value.",
                expected: createFieldEvidence(path, expected[key]),
                actual: createFieldEvidence(path, actual[key]),
                recovery: [{ action: "repair", path, hint: "Repair the renderer/parser mapping for this field." }],
            }));
        }
    }
    return diagnostics;
}
function fieldPath(fieldId) {
    return `$.fields.${fieldId}`;
}
function semanticFieldId(contract, path) {
    const fields = contract.sections.flatMap((section) => section.fields);
    for (const field of fields) {
        if (path === `$.${field.id}` || path.startsWith(`$.${field.id}[`))
            return field.id;
    }
    const sectionId = /^\$\.sections\.([^.[\]]+)/u.exec(path)?.[1];
    return sectionId === undefined
        ? undefined
        : contract.sections.find((section) => section.id === sectionId)?.fields[0]?.id;
}
function semanticDiagnosticPath(contract, path) {
    const sectionId = /^\$\.sections\.([^.[\]]+)/u.exec(path)?.[1];
    if (sectionId !== undefined && contract.sections.some((section) => section.id === sectionId)) {
        return `$.sections.${sectionId}`;
    }
    return path === "$" ? undefined : path.startsWith("$.artifact") ? undefined : path;
}
function roundTripParseMessage(code) {
    switch (code) {
        case "EXISTING_UNKNOWN_CHECKLIST_ITEM":
            return "Rendered artifact contains an undeclared checklist item.";
        case "EXISTING_EXTRA_CONTENT":
            return "Rendered artifact contains content outside the compiled template structure.";
        case "EXISTING_WRONG_TEMPLATE":
            return "Rendered artifact does not match the compiled template structure.";
        default:
            return "Rendered artifact does not match the compiled field representation.";
    }
}
function stableValue(value) {
    if (value === undefined)
        return "undefined";
    if (value === null || typeof value !== "object")
        return JSON.stringify(value) ?? String(value);
    if (Array.isArray(value))
        return `[${value.map((entry) => stableValue(entry)).join(",")}]`;
    const record = value;
    return `{${Object.keys(record)
        .sort(compareStrings)
        .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
        .join(",")}}`;
}
function renderIssueBody(contract, values) {
    const blocks = [];
    for (let sectionIndex = 0; sectionIndex < contract.sections.length; sectionIndex += 1) {
        const section = contract.sections[sectionIndex];
        if (section.kind === "documentation") {
            // GitHub renders Issue Form markdown in the form only; it is not part of
            // the submitted Issue body. The content remains in the contract for
            // schema/explain and native-source traceability.
            continue;
        }
        const title = section.title ?? section.fields[0]?.label;
        if (title === undefined)
            continue;
        const body = section.fields
            .map((field) => renderFieldValue(field, values[field.id], "issue"))
            .filter(Boolean)
            .join("\n\n");
        blocks.push([`### ${escapeHeading(title)}`, body].filter((part) => part.length > 0).join("\n\n"));
    }
    return `${blocks.join("\n\n")}\n\n${renderTemplateIdentityMarker(contract)}\n`;
}
function renderPullRequestBody(contract, values) {
    const blocks = [];
    for (let sectionIndex = 0; sectionIndex < contract.sections.length; sectionIndex += 1) {
        const section = contract.sections[sectionIndex];
        if (section.kind === "documentation") {
            const content = trimBlankLines(section.content ?? "");
            if (content !== undefined)
                blocks.push(section.title === undefined ? content : renderDocumentation(section, content));
            continue;
        }
        const title = section.title ?? section.fields[0]?.label;
        const level = section.render.headingLevel ?? section.nativeMetadata.headingLevel;
        if (title === undefined || level === undefined)
            throw new ArtifactInputError("INPUT_DOCUMENT_INVALID", `PR section "${section.id}" has no heading identity.`);
        const rendered = section.fields
            .map((field) => renderFieldValue(field, values[field.id], "pull_request"))
            .filter(Boolean);
        blocks.push([`${"#".repeat(level)} ${escapeHeading(title)}`, ...rendered].join("\n\n"));
    }
    return `${blocks.join("\n\n")}\n\n${renderTemplateIdentityMarker(contract)}\n`;
}
function renderDocumentation(section, content) {
    const level = section.render.headingLevel ?? section.nativeMetadata.headingLevel;
    if (section.title === undefined || level === undefined)
        return content;
    return [`${"#".repeat(level)} ${escapeHeading(section.title)}`, content].join("\n\n");
}
function renderFieldValue(field, value, kind) {
    if (field.type === "string" || field.type === "enum") {
        if (typeof value === "string" && value.length === 0) {
            return field.nativeMetadata.render === undefined
                ? EXPLICIT_EMPTY_STRING_MARKER
                : renderCodeBlock(EXPLICIT_EMPTY_STRING_MARKER, field.nativeMetadata.render);
        }
        if (typeof value === "string" && (kind !== "issue" || value.trim().length > 0)) {
            const renderedValue = kind === "issue" ? issueNativeValue(field, value) : value;
            return field.nativeMetadata.render === undefined
                ? escapeMarkdownValue(renderedValue)
                : renderCodeBlock(renderedValue, field.nativeMetadata.render);
        }
        if (kind === "pull_request")
            return field.nativeMetadata.placeholder ?? "";
        return field.nativeMetadata.render === undefined
            ? GITHUB_NO_RESPONSE
            : renderCodeBlock("", field.nativeMetadata.render);
    }
    if (field.type === "array") {
        if (!Array.isArray(value))
            return kind === "issue" ? GITHUB_NO_RESPONSE : "";
        if (value.length === 0)
            return kind === "issue" ? GITHUB_NO_RESPONSE : "";
        const renderedValues = kind === "issue"
            ? value.map((entry) => (typeof entry === "string" ? issueNativeValue(field, entry) : String(entry)))
            : value.map((entry) => String(entry));
        if (field.nativeMetadata.multiple === true)
            return renderedValues.map((entry) => escapeMarkdownValue(entry)).join(", ");
        return renderedValues.map((entry) => `- ${escapeMarkdownValue(entry)}`).join("\n");
    }
    const selected = new Set(Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []);
    const placeholder = kind === "pull_request" ? field.nativeMetadata.placeholder : undefined;
    const lines = field.items.map((item) => `- [${selected.has(item.id) ? "x" : " "}] ${escapeMarkdownValue(item.label)}`);
    return [placeholder === undefined ? "" : placeholder, lines.join("\n")].filter(Boolean).join("\n\n");
}
/** Map canonical Issue semantic values to the labels shown by GitHub Issue Forms. */
function issueNativeValue(field, value) {
    if (field.type === "enum")
        return field.options.find((option) => option.value === value)?.label ?? value;
    if (field.type === "array")
        return field.items.options?.find((option) => option.value === value)?.label ?? value;
    return value;
}
/** Map GitHub Issue Form labels back to canonical semantic values. */
function issueSemanticValue(field, value) {
    if (value === undefined)
        return undefined;
    if (field.type === "enum")
        return field.options.find((option) => option.label === value)?.value ?? value;
    if (field.type === "array")
        return field.items.options?.find((option) => option.label === value)?.value ?? value;
    return value;
}
function parseRenderedBody(contract, body, issueHeadingLevel, stripComments) {
    const markerFreeBody = extractTemplateIdentityMarker(body).body;
    const source = normalizeSource(stripComments ? removeHtmlComments(markerFreeBody) : markerFreeBody);
    const lines = source.split("\n");
    const values = {};
    const diagnostics = [];
    let cursor = 0;
    for (let sectionIndex = 0; sectionIndex < contract.sections.length; sectionIndex += 1) {
        const section = contract.sections[sectionIndex];
        while (lines[cursor] !== undefined && lines[cursor]?.trim().length === 0)
            cursor += 1;
        if (section.kind === "documentation") {
            if (issueHeadingLevel !== undefined)
                continue;
            const expected = trimBlankLines(stripComments ? removeHtmlComments(section.content ?? "") : (section.content ?? ""));
            if (expected !== undefined) {
                const expectedLines = expected.split("\n");
                if (!sameLines(lines.slice(cursor, cursor + expectedLines.length), expectedLines)) {
                    diagnostics.push({
                        code: "EXISTING_UNPARSEABLE",
                        path: `$.sections.${section.id}`,
                        message: "Documentation structure does not match the native template.",
                    });
                    return { parsed: false, values: {}, diagnostics };
                }
                cursor += expectedLines.length;
            }
            continue;
        }
        const expectedTitle = section.title ?? section.fields[0]?.label;
        const field = section.fields[0];
        if (expectedTitle === undefined || field === undefined)
            continue;
        const heading = lines[cursor];
        const level = issueHeadingLevel ?? section.render.headingLevel ?? section.nativeMetadata.headingLevel;
        const expectedHeading = `${"#".repeat(level ?? 3)} ${escapeHeading(expectedTitle)}`;
        if (heading?.trim() !== expectedHeading) {
            const hasHeading = lines.some((line) => isHeading(line));
            diagnostics.push({
                code: hasHeading ? "EXISTING_WRONG_TEMPLATE" : "EXISTING_UNPARSEABLE",
                path: `$.sections.${section.id}`,
                message: `Expected native section heading "${expectedHeading}".`,
            });
            return { parsed: false, values: {}, diagnostics };
        }
        cursor += 1;
        const contentStart = cursor;
        const nextIssueHeading = issueHeadingLevel === undefined ? undefined : findNextIssueHeading(contract, sectionIndex);
        let openFence;
        while (cursor < lines.length) {
            const line = lines[cursor] ?? "";
            const fenceMatch = /^(`{3,})/u.exec(line);
            if (openFence === undefined) {
                if (nextIssueHeading === undefined
                    ? issueHeadingLevel === undefined && isHeading(line)
                    : line.trim() === nextIssueHeading)
                    break;
                if (fenceMatch !== null)
                    openFence = fenceMatch[1];
            }
            else if (fenceMatch !== null && fenceMatch[1] === openFence) {
                openFence = undefined;
            }
            cursor += 1;
        }
        let fieldEnd = cursor;
        const nextSection = contract.sections[sectionIndex + 1];
        const nextDocumentation = issueHeadingLevel === undefined && nextSection?.kind === "documentation"
            ? trimBlankLines(stripComments ? removeHtmlComments(nextSection.content ?? "") : (nextSection.content ?? ""))
            : undefined;
        if (nextDocumentation !== undefined) {
            const documentationLines = nextDocumentation.split("\n");
            const rawCandidate = lines.slice(contentStart, fieldEnd);
            const candidate = trimLineRange(rawCandidate);
            if (candidate.length >= documentationLines.length &&
                sameLines(candidate.slice(-documentationLines.length), documentationLines)) {
                const leadingBlankLines = rawCandidate.findIndex((line) => line.trim().length > 0);
                const candidateStart = contentStart + Math.max(leadingBlankLines, 0);
                fieldEnd = candidateStart + candidate.length - documentationLines.length;
                cursor = fieldEnd;
            }
        }
        const fieldLines = trimLineRange(lines.slice(contentStart, fieldEnd));
        const parsed = parseFieldLines(field, fieldLines, `$.${field.id}`, stripComments, issueHeadingLevel !== undefined);
        diagnostics.push(...parsed.diagnostics);
        if (parsed.value !== undefined)
            values[field.id] = parsed.value;
        if (parsed.diagnostics.length > 0)
            return { parsed: false, values: {}, diagnostics };
    }
    while (lines[cursor] !== undefined && lines[cursor]?.trim().length === 0)
        cursor += 1;
    if (cursor < lines.length && lines.slice(cursor).some((line) => line.trim().length > 0)) {
        diagnostics.push({
            code: "EXISTING_EXTRA_CONTENT",
            path: "$",
            message: "Artifact contains content outside the compiled template structure.",
        });
    }
    if (diagnostics.length > 0)
        return { parsed: false, values: {}, diagnostics };
    return { parsed: true, values, diagnostics: [] };
}
function headingBlocks(source) {
    const lines = source.split("\n");
    const starts = [];
    let openFence;
    lines.forEach((line, index) => {
        const fenceMatch = /^(`{3,})/u.exec(line);
        if (openFence === undefined && fenceMatch !== null) {
            openFence = fenceMatch[1];
            return;
        }
        if (openFence !== undefined) {
            if (fenceMatch !== null && fenceMatch[1] === openFence)
                openFence = undefined;
            return;
        }
        const match = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*$/u.exec(line);
        if (match !== null)
            starts.push({ index, title: match[1] });
    });
    return starts.map((start, position) => {
        const next = starts[position + 1]?.index ?? lines.length;
        return { title: start.title, body: trimLineRange(lines.slice(start.index + 1, next)) };
    });
}
function parseFieldLines(field, lines, path, stripComments, issueBody) {
    const diagnostics = [];
    const filtered = stripComments ? lines.filter((line) => line.trim().length > 0) : lines;
    if (filtered.length === 1 && filtered[0]?.trim() === GITHUB_NO_RESPONSE) {
        // GitHub uses the same marker for an empty optional selection. Preserve
        // the materialized empty array so prepared artifacts remain reversible.
        return { value: field.type === "array" ? [] : undefined, diagnostics };
    }
    if (field.type === "string" || field.type === "enum") {
        const parsedValue = field.nativeMetadata.render === undefined
            ? trimBlankLines(unescapeMarkdownValue(filtered.join("\n")))
            : parseRenderedCodeBlock(filtered, field.nativeMetadata.render, path, diagnostics);
        if (parsedValue === EXPLICIT_EMPTY_STRING_MARKER)
            return { value: "", diagnostics };
        const placeholder = stripComments
            ? removeHtmlComments(field.nativeMetadata.placeholder ?? "")
            : (field.nativeMetadata.placeholder ?? "");
        if (stripComments && parsedValue !== undefined && parsedValue === trimBlankLines(placeholder))
            return { value: undefined, diagnostics };
        return { value: issueBody ? issueSemanticValue(field, parsedValue) : parsedValue, diagnostics };
    }
    if (field.type === "array") {
        if (field.nativeMetadata.multiple === true) {
            const value = trimBlankLines(unescapeMarkdownValue(filtered.join("\n")));
            if (value === undefined)
                return { value: undefined, diagnostics };
            const values = value
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0);
            if (values.length === 0)
                return { value: undefined, diagnostics };
            return { value: issueBody ? values.map((value) => issueSemanticValue(field, value)) : values, diagnostics };
        }
        const values = filtered
            .map((line) => {
            const value = /^[-+*][ \t]+(.+)$/u.exec(line)?.[1]?.trim();
            return value === undefined ? undefined : unescapeMarkdownValue(value);
        })
            .filter((value) => value !== undefined);
        if (values.length !== filtered.length) {
            diagnostics.push({
                code: "EXISTING_UNPARSEABLE",
                path,
                message: "Array values must be a canonical Markdown list.",
            });
            return { value: undefined, diagnostics };
        }
        return { value: values, diagnostics };
    }
    const values = [];
    const checklistLines = stripComments
        ? removeRenderedPlaceholder(filtered, field.nativeMetadata.placeholder)
        : filtered;
    for (const line of checklistLines) {
        const match = /^[-+*][ \t]+\[([ xX])\][ \t]+(.+)$/u.exec(line);
        if (match === null) {
            diagnostics.push({
                code: "EXISTING_UNPARSEABLE",
                path,
                message: "Checklist values must use canonical task-list syntax.",
            });
            continue;
        }
        const label = unescapeMarkdownValue(match[2]?.trim() ?? "");
        const item = field.items.find((candidate) => candidate.label === label);
        if (item === undefined) {
            diagnostics.push({
                code: "EXISTING_UNKNOWN_CHECKLIST_ITEM",
                path,
                message: `Unknown checklist item "${label}".`,
            });
        }
        else if (match[1]?.toLowerCase() === "x") {
            values.push(item.id);
        }
    }
    return { value: values, diagnostics };
}
function removeRenderedPlaceholder(lines, placeholder) {
    if (placeholder === undefined)
        return lines;
    const placeholderLines = nonEmptyLines(removeHtmlComments(placeholder));
    return placeholderLines.length > 0 && sameLines(lines.slice(0, placeholderLines.length), placeholderLines)
        ? lines.slice(placeholderLines.length)
        : lines;
}
function findNextIssueHeading(contract, sectionIndex) {
    for (let index = sectionIndex + 1; index < contract.sections.length; index += 1) {
        const section = contract.sections[index];
        if (section.kind !== "input")
            continue;
        const title = section.title ?? section.fields[0]?.label;
        if (title !== undefined)
            return `### ${escapeHeading(title)}`;
    }
    return undefined;
}
function parseRenderedCodeBlock(lines, language, path, diagnostics) {
    const opening = /^(`{3,})(.*)$/u.exec(lines[0] ?? "");
    if (opening === null || opening[2] !== language || lines.length < 2) {
        diagnostics.push({
            code: "EXISTING_UNPARSEABLE",
            path,
            message: `Rendered textarea values must use a fenced ${language} code block.`,
        });
        return undefined;
    }
    const fence = opening[1];
    if (lines.at(-1) !== fence) {
        diagnostics.push({
            code: "EXISTING_UNPARSEABLE",
            path,
            message: "Rendered textarea code blocks must have a matching closing fence.",
        });
        return undefined;
    }
    const value = lines.slice(1, -1).join("\n");
    return value.length === 0 ? undefined : value;
}
function renderCodeBlock(value, language) {
    const normalized = normalizeSource(value);
    const longestFence = Math.max(0, ...Array.from(normalized.matchAll(/`+/gu), (match) => match[0]?.length ?? 0));
    const fence = "`".repeat(Math.max(3, longestFence + 1));
    return `${fence}${language}\n${normalized}\n${fence}`;
}
function mergeIssueLabels(nativeLabels, callerLabels) {
    if (nativeLabels === undefined && callerLabels === undefined)
        return undefined;
    const labels = [];
    for (const label of [...(nativeLabels ?? []), ...(callerLabels ?? [])]) {
        if (!labels.includes(label))
            labels.push(label);
    }
    return labels;
}
function parseMetadata(input) {
    const metadata = {};
    if (input.title !== undefined)
        metadata.title = requiredMetadataString(input.title, "title");
    for (const key of ["labels", "assignees"]) {
        if (input[key] !== undefined)
            metadata[key] = stringArray(input[key], key);
    }
    for (const key of ["head", "base"]) {
        if (input[key] !== undefined)
            metadata[key] = requiredMetadataString(input[key], key);
    }
    for (const key of ["draft", "maintainerCanModify"]) {
        if (input[key] !== undefined) {
            if (typeof input[key] !== "boolean")
                throw new ArtifactInputError("INPUT_METADATA_INVALID", `${key} must be a boolean.`, `$.${key}`);
            metadata[key] = input[key];
        }
    }
    return metadata;
}
function requiredMetadataString(value, key) {
    const violation = validateRequiredMetadataString(value, key);
    if (violation !== undefined)
        throw new ArtifactInputError(violation.code, violation.message, violation.path);
    return value;
}
function stringArray(value, key) {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
        throw new ArtifactInputError("INPUT_METADATA_INVALID", `${key} must be an array of non-empty strings.`, `$.${key}`);
    }
    return [...value];
}
function escapeHeading(value) {
    return value.replace(/[\r\n]+/gu, " ").trim();
}
/** Escape only Markdown constructs that could change the canonical section structure. */
export function escapeMarkdownValue(value) {
    return normalizeSource(value)
        .split("\n")
        .map((line) => {
        if (/^ {0,3}(?:#{1,6})(?:[ \t]+|$)/u.test(line))
            return line.replace(/^( {0,3})(#)/u, "$1\\$2");
        if (/^ {0,3}(?:[-+*]|\d+[.)])[ \t]+\[[ xX]\]/u.test(line))
            return line.replace(/^( {0,3})([-+*]|\d+[.)])/u, "$1\\$2");
        if (/^ {0,3}(?:```|~~~)/u.test(line))
            return line.replace(/^([ \t]{0,3})([`~])/u, "$1\\$2");
        if (/^ {0,3}>[ \t]?/u.test(line))
            return line.replace(/^( {0,3})(>)/u, "$1\\$2");
        if (/^ {0,3}<!--/u.test(line))
            return line.replace(/^( {0,3})(<!--)/u, "$1\\$2");
        return line;
    })
        .join("\n");
}
function unescapeMarkdownValue(value) {
    return normalizeSource(value)
        .split("\n")
        .map((line) => line.replace(/^( {0,3})\\(#{1,6}|[-+*]|\d+[.)]|[`~]|>|<!--)/u, "$1$2"))
        .join("\n");
}
export function removeHtmlComments(value) {
    let result = "";
    let cursor = 0;
    while (cursor < value.length) {
        const start = value.indexOf("<!--", cursor);
        if (start < 0) {
            result += value.slice(cursor);
            break;
        }
        result += value.slice(cursor, start);
        const end = value.indexOf("-->", start + 4);
        if (end < 0)
            break;
        cursor = end + 3;
    }
    return result;
}
function normalizeSource(value) {
    return value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}
function trimBlankLines(value) {
    const lines = value.split("\n");
    while (lines[0] !== undefined && lines[0].trim().length === 0)
        lines.shift();
    while (lines.at(-1) !== undefined && lines.at(-1)?.trim().length === 0)
        lines.pop();
    return lines.length === 0 ? undefined : lines.join("\n");
}
function trimLineRange(lines) {
    const copy = [...lines];
    while (copy[0] !== undefined && copy[0].trim().length === 0)
        copy.shift();
    while (copy.at(-1) !== undefined && copy.at(-1)?.trim().length === 0)
        copy.pop();
    return copy;
}
function nonEmptyLines(value) {
    return normalizeSource(value)
        .split("\n")
        .filter((line) => line.trim().length > 0);
}
function isHeading(line) {
    return /^#{1,6}[ \t]+\S/u.test(line);
}
function sameLines(actual, expected) {
    return actual.length === expected.length && actual.every((line, index) => line === expected[index]);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function compareStrings(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function semanticValidationFromLoad(loaded) {
    return { valid: loaded.valid, violations: loaded.violations, values: loaded.canonical };
}
//# sourceMappingURL=artifact.js.map