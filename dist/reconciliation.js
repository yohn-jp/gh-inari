import { prepareIssueArtifact, preparePullRequestArtifact, renderIssueArtifact, renderPullRequestArtifact, selectExistingArtifactCandidate, validateExistingIssueArtifact, validateExistingPullRequestArtifact, } from "./artifact.js";
import { compileRepositoryGovernedContract, compileRepositoryGovernedContracts, updateGovernedIssue, updateGovernedPullRequest, } from "./governance.js";
import { createHash } from "node:crypto";
export class RemediationError extends Error {
    code;
    path;
    details;
    constructor(code, message, path, details) {
        super(message);
        this.name = "RemediationError";
        this.code = code;
        this.path = path;
        this.details = details;
    }
}
const MAX_DIFF_CHANGES = 32;
const MAX_DIFF_VALUE = 240;
const MAX_PREVIEW = 160;
/** Read and select an existing artifact using the same governed candidate path as `get`. */
export async function readGovernedExistingArtifact(adapter, domain, number, selector) {
    let contracts;
    let failedTemplates;
    if (selector === undefined) {
        const outcomes = await compileRepositoryGovernedContracts(adapter, domain);
        contracts = outcomes.filter(isCompiledOutcome).map((outcome) => outcome.contract);
        failedTemplates = outcomes.filter(isFailedOutcome).map((outcome) => ({
            path: outcome.path,
            message: outcome.message,
        }));
    }
    else {
        contracts = [await compileRepositoryGovernedContract(adapter, domain, selector)];
        failedTemplates = [];
    }
    const remote = domain === "issue" ? await adapter.getIssue(number) : await adapter.getPullRequest(number);
    const candidates = contracts.map((contract) => ({
        contract,
        result: domain === "issue"
            ? validateExistingIssueArtifact(contract, remote.body)
            : validateExistingPullRequestArtifact(contract, remote.body),
    }));
    const selected = selectExistingArtifactCandidate(candidates);
    if (selected.contract !== undefined || failedTemplates.length === 0) {
        return { remote, contract: selected.contract, result: selected.result };
    }
    const compileDiagnostics = failedTemplates.map((failed) => ({
        code: "EXISTING_TEMPLATE_COMPILE_FAILED",
        path: failed.path,
        message: `[${failed.path}] Template failed to compile: ${failed.message}`,
    }));
    const existingViolations = selected.result.violations;
    return {
        remote,
        result: {
            valid: false,
            classification: selected.result.classification,
            parse: {
                parsed: false,
                values: {},
                diagnostics: [...selected.result.parse.diagnostics, ...compileDiagnostics],
            },
            violations: [...existingViolations, ...compileDiagnostics],
        },
    };
}
/** Classify the current artifact and prove whether a canonical body can preserve its semantics. */
export function assessExistingArtifact(domain, read) {
    if (read.result.classification === "ambiguous") {
        return { status: "ambiguous", normalizable: false, diagnostics: read.result.parse.diagnostics };
    }
    if (!read.result.parse.parsed || read.contract === undefined) {
        return { status: "unsupported", normalizable: false, diagnostics: read.result.parse.diagnostics };
    }
    if (!read.result.valid) {
        return { status: "semantically-invalid", normalizable: false, diagnostics: read.result.parse.diagnostics };
    }
    const canonicalBody = renderCanonicalBody(domain, read.contract, read.result.parse.values);
    const currentBody = read.remote.body ?? "";
    const normalizable = canonicalBody !== currentBody;
    const diagnostics = normalizable
        ? [
            {
                code: "EXISTING_NON_CANONICAL",
                path: "$.body",
                message: "Artifact is semantically valid but differs from the canonical rendered representation.",
            },
        ]
        : [];
    return {
        status: normalizable ? "non-canonical" : "valid-current",
        normalizable,
        canonicalBody,
        diagnostics,
    };
}
/** Render through the existing canonical renderer; this is the only representation authority. */
export function renderCanonicalBody(domain, contract, fields) {
    return domain === "issue" ? renderIssueArtifact(contract, fields) : renderPullRequestArtifact(contract, fields);
}
/** Build the complete semantic input represented by the current remote artifact. */
export function currentArtifactInput(domain, read) {
    if (domain === "issue") {
        const remote = read.remote;
        return {
            fields: read.result.parse.values,
            metadata: { title: remote.title, labels: remote.labels, assignees: remote.assignees },
        };
    }
    const remote = read.remote;
    return {
        fields: read.result.parse.values,
        metadata: { title: remote.title, head: remote.head, base: remote.base, draft: remote.draft },
    };
}
/** Apply an explicit semantic patch without touching raw Markdown or inferring missing fields. */
export function applySemanticPatch(domain, read, patch) {
    if (read.contract === undefined || !read.result.parse.parsed) {
        throw new RemediationError("SEMANTIC_PATCH_UNSUPPORTED", "The existing artifact is not safely parseable under one authoritative template.", "$.artifact");
    }
    assertKnownFields(read.contract, patch.fields, "SEMANTIC_PATCH_INVALID");
    const current = currentArtifactInput(domain, read);
    const metadata = { ...current.metadata, ...patch.metadata };
    if (domain === "pr" && patch.metadata.head !== undefined) {
        const remote = read.remote;
        if (patch.metadata.head !== remote.head) {
            throw new RemediationError("PR_HEAD_CHANGE_UNSUPPORTED", "Pull request head branches cannot be changed through the GitHub pull-request model.", "$.head", { current: remote.head, requested: patch.metadata.head });
        }
    }
    return { fields: { ...current.fields, ...patch.fields }, metadata };
}
/** Validate and prepare the complete desired state through the existing artifact boundary. */
export function prepareRemediationArtifact(domain, contract, input) {
    if (domain === "issue")
        return prepareIssueArtifact(contract, input).artifact;
    return preparePullRequestArtifact(contract, input).artifact;
}
/** Ensure a declarative sync only names fields in the authoritative contract. */
export function prepareSyncInput(domain, read, desired) {
    if (read.contract === undefined || !read.result.parse.parsed) {
        throw new RemediationError("SYNC_CURRENT_UNSUPPORTED", "Sync refuses to replace an unsupported or unparseable existing artifact.", "$.artifact");
    }
    assertKnownFields(read.contract, desired.fields, "SYNC_INPUT_INCOMPLETE");
    if (domain === "pr" && desired.metadata.head !== undefined) {
        const remote = read.remote;
        if (desired.metadata.head !== remote.head) {
            throw new RemediationError("PR_HEAD_CHANGE_UNSUPPORTED", "Pull request head branches cannot be changed through the GitHub pull-request model.", "$.head", { current: remote.head, requested: desired.metadata.head });
        }
    }
    return desired;
}
/** Compare the current semantic/rendered artifact with a prepared canonical projection. */
export function diffArtifact(domain, read, desired) {
    const currentFields = read.result.parse.values;
    const desiredFields = desiredFieldsFromArtifact(domain, desired, read.contract);
    const keys = [...new Set([...Object.keys(currentFields), ...Object.keys(desiredFields)])].sort(compareStrings);
    const semantic = [];
    for (const key of keys) {
        if (stableValue(currentFields[key]) !== stableValue(desiredFields[key])) {
            semantic.push({
                path: `$.fields.${key}`,
                ...(Object.prototype.hasOwnProperty.call(currentFields, key)
                    ? { before: boundedValue(currentFields[key]) }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(desiredFields, key)
                    ? { after: boundedValue(desiredFields[key]) }
                    : {}),
            });
        }
    }
    const currentMetadata = currentMetadataForDiff(domain, read.remote);
    const desiredMetadata = desiredMetadataForDiff(domain, desired);
    for (const key of Object.keys(desiredMetadata).sort(compareStrings)) {
        if (stableValue(currentMetadata[key]) !== stableValue(desiredMetadata[key])) {
            semantic.push({
                path: `$.metadata.${key}`,
                ...(currentMetadata[key] === undefined ? {} : { before: boundedValue(currentMetadata[key]) }),
                ...(desiredMetadata[key] === undefined ? {} : { after: boundedValue(desiredMetadata[key]) }),
            });
        }
    }
    const currentBody = read.remote.body ?? "";
    const rendered = {
        changed: currentBody !== desired.body,
        before: summarizeRenderedValue(currentBody),
        after: summarizeRenderedValue(desired.body),
    };
    const boundedSemantic = semantic.slice(0, MAX_DIFF_CHANGES);
    return { changed: semantic.length > 0 || rendered.changed, semantic: boundedSemantic, rendered };
}
/** Apply a prepared artifact through the existing freshness and reconciliation boundary. */
export async function updateGovernedExistingArtifact(adapter, domain, number, artifact) {
    if (domain === "issue")
        return updateGovernedIssue(adapter, number, artifact);
    return updateGovernedPullRequest(adapter, number, artifact);
}
function desiredFieldsFromArtifact(domain, artifact, contract) {
    if (contract === undefined)
        return {};
    // Reparse the canonical projection through the existing parser. This keeps
    // the diff's semantic side tied to the same round-trip authority as writes.
    const parsed = domain === "issue"
        ? validateExistingIssueArtifact(contract, artifact.body)
        : validateExistingPullRequestArtifact(contract, artifact.body);
    return parsed.parse.values;
}
function currentMetadataForDiff(domain, remote) {
    if (domain === "issue") {
        const issue = remote;
        return { title: issue.title, labels: issue.labels, assignees: issue.assignees };
    }
    const pullRequest = remote;
    return { title: pullRequest.title, head: pullRequest.head, base: pullRequest.base, draft: pullRequest.draft };
}
function desiredMetadataForDiff(domain, artifact) {
    if (domain === "issue") {
        const issue = artifact;
        return {
            title: issue.title,
            ...(issue.labels === undefined ? {} : { labels: issue.labels }),
            ...(issue.assignees === undefined ? {} : { assignees: issue.assignees }),
        };
    }
    const pullRequest = artifact;
    return {
        title: pullRequest.title,
        head: pullRequest.head,
        base: pullRequest.base,
        ...(pullRequest.draft === undefined ? {} : { draft: pullRequest.draft }),
    };
}
function assertKnownFields(contract, fields, code) {
    const known = new Set(contract.sections.flatMap((section) => section.fields.map((field) => field.id)));
    const unknown = Object.keys(fields).find((field) => !known.has(field));
    if (unknown !== undefined) {
        throw new RemediationError(code, `Unknown semantic field "${unknown}".`, `$.fields.${unknown}`, { field: unknown });
    }
}
function isCompiledOutcome(outcome) {
    return outcome.status === "compiled";
}
function isFailedOutcome(outcome) {
    return outcome.status === "failed";
}
function summarizeRenderedValue(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = createSha256(bytes);
    return { sha256: digest, length: bytes.byteLength, preview: value.slice(0, MAX_PREVIEW) };
}
function createSha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
function boundedValue(value) {
    const serialized = stableValue(value);
    if (serialized.length <= MAX_DIFF_VALUE)
        return value;
    return { truncated: true, preview: serialized.slice(0, MAX_DIFF_VALUE), length: serialized.length };
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
function compareStrings(left, right) {
    return left.localeCompare(right, "en-US");
}
//# sourceMappingURL=reconciliation.js.map