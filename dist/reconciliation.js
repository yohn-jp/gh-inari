import { extractTemplateIdentityMarker, loadCanonicalArtifact, prepareIssueArtifact, preparePullRequestArtifact, recoverExistingArtifactValues, renderIssueArtifact, renderPullRequestArtifact, selectExistingArtifactCandidate, validateExistingIssueArtifact, validateExistingPullRequestArtifact, validatePartialArtifactInput, } from "./artifact.js";
import { SemanticValidationError } from "./contract/index.js";
import { createArtifactDiagnostic, createArtifactDiagnosticReport, } from "./diagnostics.js";
import { compileRepositoryGovernedContract, compileRepositoryGovernedContracts, updateGovernedIssue, updateGovernedPullRequest, } from "./governance.js";
import { createHash } from "node:crypto";
export class RemediationError extends Error {
    code;
    path;
    details;
    diagnostics;
    constructor(code, message, path, details, diagnostics) {
        super(message);
        this.name = "RemediationError";
        this.code = code;
        this.path = path;
        this.details = details;
        this.diagnostics = diagnostics;
    }
}
/** Project recoverable remediation failures through the shared #118 contract. */
export function remediationDiagnosticReport(domain, operation, read, input, error) {
    const requirementReport = remediationRequirementDiagnostics(error);
    if (requirementReport !== undefined)
        return boundedDiagnosticReport(requirementReport);
    let semanticReport;
    if (read.result.parse.parsed && read.contract !== undefined) {
        const candidate = error instanceof RemediationError &&
            (error.code === "PR_HEAD_CHANGE_UNSUPPORTED" || error.code === "PR_DRAFT_CHANGE_UNSUPPORTED")
            ? currentArtifactInput(domain, read)
            : (input ?? currentArtifactInput(domain, read));
        const loaded = loadCanonicalArtifact(read.contract, candidate);
        semanticReport = boundedDiagnosticReport(loaded.diagnostics);
    }
    if (error instanceof RemediationError && error.code === "SEMANTIC_PATCH_INVALID") {
        return createArtifactDiagnosticReport([
            ...(semanticReport?.diagnostics.slice(0, 31) ?? []),
            createArtifactDiagnostic({
                state: "invalid",
                code: "FIELD_INVALID",
                detailCode: "FIELD_CONSTRAINT_VIOLATION",
                reason: "constraint",
                path: error.path,
                message: error.message,
                recovery: [{ action: "replace", path: error.path, hint: "Remove or replace the undeclared field." }],
            }),
        ], semanticReport?.acceptedFields ?? []);
    }
    if (error instanceof RemediationError && error.code === "PR_HEAD_CHANGE_UNSUPPORTED") {
        return createArtifactDiagnosticReport([
            ...(semanticReport?.diagnostics.slice(0, 31) ?? []),
            createArtifactDiagnostic({
                state: "unsupported",
                code: "FIELD_UNSUPPORTED",
                detailCode: "FIELD_UNSUPPORTED",
                reason: "unsupported",
                path: "$.metadata.head",
                message: error.message,
                recovery: [
                    {
                        action: "replace",
                        path: "$.metadata.head",
                        hint: "Keep the current pull-request head branch and retry.",
                    },
                ],
            }),
        ], semanticReport?.acceptedFields ?? []);
    }
    if (error instanceof RemediationError && error.code === "PR_DRAFT_CHANGE_UNSUPPORTED") {
        return createArtifactDiagnosticReport([
            ...(semanticReport?.diagnostics.slice(0, 31) ?? []),
            createArtifactDiagnostic({
                state: "unsupported",
                code: "FIELD_UNSUPPORTED",
                detailCode: "FIELD_UNSUPPORTED",
                reason: "unsupported",
                path: "$.metadata.draft",
                message: error.message,
                recovery: [
                    {
                        action: "replace",
                        path: "$.metadata.draft",
                        hint: "Omit draft or keep the current pull-request draft state and retry.",
                    },
                ],
            }),
        ], semanticReport?.acceptedFields ?? []);
    }
    if (error instanceof RemediationError &&
        (error.code === "SEMANTIC_PATCH_UNSUPPORTED" || error.code === "SYNC_METADATA_UNSUPPORTED") &&
        typeof error.details?.metadata === "string") {
        const path = error.path ?? `$.metadata.${error.details.metadata}`;
        return createArtifactDiagnosticReport([
            ...(semanticReport?.diagnostics.slice(0, 31) ?? []),
            createArtifactDiagnostic({
                state: "unsupported",
                code: "FIELD_UNSUPPORTED",
                detailCode: "FIELD_UNSUPPORTED",
                reason: "unsupported",
                path,
                message: error.message,
                recovery: [{ action: "replace", path, hint: "Remove the unsupported metadata option and retry." }],
            }),
        ], semanticReport?.acceptedFields ?? []);
    }
    if (semanticReport !== undefined &&
        (semanticReport.diagnostics.length > 0 || semanticReport.acceptedFields.length > 0)) {
        return semanticReport;
    }
    const sourceDiagnostics = read.remediationDiagnostics ?? read.result.parse.diagnostics;
    const projected = sourceDiagnostics.slice(0, 32).map((diagnostic) => {
        const ambiguous = diagnostic.code === "EXISTING_AMBIGUOUS_TEMPLATE";
        const selectedTemplate = read.contract?.templateIdentity.path;
        const hasSelectedTemplate = selectedTemplate !== undefined;
        const path = projectExistingDiagnosticPath(diagnostic.path, read.contract);
        const recovery = ambiguous
            ? [
                {
                    action: "select-template",
                    path: "$.template",
                    hint: "Select one authoritative template with --template and retry.",
                },
            ]
            : hasSelectedTemplate
                ? [
                    {
                        action: "repair",
                        path: "$.artifact",
                        hint: `Repair the artifact to match selected template "${selectedTemplate}" and retry.`,
                    },
                ]
                : [
                    {
                        action: "select-template",
                        path: "$.template",
                        hint: "Select an authoritative template with --template and retry.",
                    },
                ];
        return createArtifactDiagnostic({
            state: ambiguous ? "conflicting" : "unsupported",
            code: ambiguous ? "FIELD_CONFLICT" : "FIELD_UNSUPPORTED",
            detailCode: ambiguous ? "TEMPLATE_AMBIGUOUS" : "TEMPLATE_UNPARSEABLE",
            reason: ambiguous ? "conflict" : "unsupported",
            path,
            message: existingDiagnosticMessage(diagnostic.code, hasSelectedTemplate),
            recovery,
        });
    });
    if (projected.length > 0)
        return createArtifactDiagnosticReport(projected);
    const selectedTemplate = read.contract?.templateIdentity.path;
    return createArtifactDiagnosticReport([
        createArtifactDiagnostic({
            state: "unrecoverable",
            code: "ARTIFACT_UNRECOVERABLE",
            path: "$.artifact",
            message: operation === "normalize"
                ? "Normalization cannot preserve the existing artifact deterministically."
                : operation === "sync"
                    ? "The existing artifact cannot be safely synchronized as a semantic document."
                    : "The existing artifact cannot be safely edited as a semantic document.",
            recovery: [
                {
                    action: "repair",
                    path: "$.artifact",
                    hint: selectedTemplate === undefined
                        ? "Repair the artifact against an authoritative template and retry."
                        : `Repair the artifact against selected template "${selectedTemplate}" and retry.`,
                },
            ],
        }),
    ]);
}
/** Attach the common report while preserving the command's existing outer error. */
export function translateRemediationFailure(domain, operation, read, error, input) {
    const diagnostics = remediationDiagnosticReport(domain, operation, read, input, error);
    const details = {
        ...remediationFailureDetails(read),
        ...(error instanceof RemediationError && error.details !== undefined ? error.details : {}),
    };
    if (error instanceof RemediationError) {
        return new RemediationError(error.code, error.message, error.path, details, diagnostics);
    }
    if (error instanceof SemanticValidationError) {
        return new SemanticValidationError(error.violations, diagnostics, details);
    }
    return error;
}
/** Bounded context for explicit-template repair without retaining source/body data. */
export function remediationFailureDetails(read) {
    const template = read.contract?.templateIdentity;
    const requirements = explicitRepairRequirements(read);
    return {
        ...(template === undefined
            ? {}
            : {
                template: {
                    id: boundDiagnosticText(template.id),
                    name: boundDiagnosticText(template.name),
                    path: boundDiagnosticText(template.path),
                    source: template.source,
                },
            }),
        ...(read.result.attemptedTemplates === undefined
            ? {}
            : {
                attemptedTemplates: read.result.attemptedTemplates.slice(0, 32).map(boundDiagnosticText),
            }),
        ...(requirements === undefined ? {} : { requirements }),
    };
}
const MAX_DIFF_CHANGES = 32;
const MAX_DIFF_VALUE = 240;
const MAX_PREVIEW = 160;
const DOMAIN_ARTIFACT_KIND = {
    issue: "issue",
    pr: "pull_request",
};
function issueReferenceFromRemote(remote, number) {
    const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/issues\/[1-9][0-9]*$/u.exec(remote.url);
    const repositoryId = "repositoryId" in remote ? remote.repositoryId : undefined;
    if (match === null || repositoryId === undefined)
        return undefined;
    const repositoryHost = "repositoryHost" in remote ? remote.repositoryHost : undefined;
    return {
        repositoryHost: (repositoryHost ?? match[1]).toLocaleLowerCase("en-US"),
        repositoryId,
        repository: `${match[2]}/${match[3]}`.toLocaleLowerCase("en-US"),
        number,
    };
}
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
    if (selector === undefined) {
        const marker = extractTemplateIdentityMarker(remote.body ?? "");
        if (marker.status !== "absent") {
            return resolveExistingArtifactByMarker(domain, remote, contracts, failedTemplates, marker.status, marker.marker);
        }
    }
    const candidates = contracts.map((contract) => ({
        contract,
        result: domain === "issue"
            ? validateExistingIssueArtifact(contract, remote.body, issueReferenceFromRemote(remote, number))
            : validateExistingPullRequestArtifact(contract, remote.body),
    }));
    const selected = selectExistingArtifactCandidate(candidates);
    if (selector !== undefined && candidates[0] !== undefined && !candidates[0].result.parse.parsed) {
        // Explicit template selection is authoritative for repair. Keep the strict
        // parser untouched, but recover only unambiguous contract-owned values and
        // expose them as a semantic candidate to edit/normalize. Structural parser
        // failures remain available separately for bounded diagnostics.
        const contract = candidates[0].contract;
        const strictResult = candidates[0].result;
        const recovered = recoverExistingArtifactValues(contract, remote.body);
        const input = artifactInputFromRemote(domain, remote, recovered.values, recovered.dependencies);
        const loaded = loadCanonicalArtifact(contract, input);
        const result = {
            valid: loaded.valid,
            classification: loaded.valid ? "valid" : "semantic",
            parse: {
                parsed: true,
                values: loaded.valid ? loaded.canonical : recovered.values,
                ...(loaded.dependencies === undefined ? {} : { dependencies: loaded.dependencies }),
                diagnostics: [],
            },
            violations: loaded.valid ? [] : loaded.violations,
        };
        return {
            remote,
            contract,
            result,
            templateSelection: "explicit",
            remediationDiagnostics: strictResult.parse.diagnostics,
        };
    }
    if (selected.contract !== undefined || failedTemplates.length === 0) {
        const explicitContract = selector !== undefined ? candidates[0]?.contract : undefined;
        const remediationDiagnostics = selected.contract === undefined
            ? candidates.flatMap((candidate) => candidate.result.parse.diagnostics).slice(0, 32)
            : undefined;
        return {
            remote,
            contract: selected.contract ?? explicitContract,
            result: selected.result,
            templateSelection: selector === undefined ? "inferred" : "explicit",
            ...(remediationDiagnostics === undefined || remediationDiagnostics.length === 0
                ? {}
                : { remediationDiagnostics }),
        };
    }
    const compileDiagnostics = failedTemplates.map((failed) => ({
        code: "EXISTING_TEMPLATE_COMPILE_FAILED",
        path: failed.path,
        message: `[${failed.path}] Template failed to compile: ${failed.message}`,
    }));
    const diagnostics = [...selected.result.parse.diagnostics, ...compileDiagnostics];
    return {
        remote,
        result: {
            valid: false,
            classification: selected.result.classification,
            parse: { parsed: false, values: {}, diagnostics },
            violations: diagnostics,
            attemptedTemplates: selected.result.attemptedTemplates,
        },
    };
}
function resolveExistingArtifactByMarker(domain, remote, contracts, failedTemplates, status, marker) {
    const invalid = (message) => {
        const diagnostic = {
            code: "EXISTING_TEMPLATE_MARKER_INVALID",
            path: "$.template",
            message,
        };
        return {
            remote,
            result: {
                valid: false,
                classification: "wrong-template",
                parse: { parsed: false, values: {}, diagnostics: [diagnostic] },
                violations: [diagnostic],
            },
        };
    };
    if (status !== "valid" || marker === undefined) {
        return invalid(status === "unsupported-version"
            ? `Artifact template identity marker uses an unsupported marker version: ${marker?.version ?? "unknown"}.`
            : "Artifact template identity marker is malformed.");
    }
    if (marker.kind !== DOMAIN_ARTIFACT_KIND[domain]) {
        return invalid(`Artifact template identity marker names a "${marker.kind}" template, which cannot resolve a ${DOMAIN_ARTIFACT_KIND[domain]} artifact.`);
    }
    const contract = contracts.find((candidate) => candidate.templateIdentity.path === marker.path);
    if (contract === undefined) {
        const failed = failedTemplates.find((failedTemplate) => failedTemplate.path === marker.path);
        return invalid(failed === undefined
            ? `Artifact template identity marker names an unknown or stale template: ${marker.path}.`
            : `[${failed.path}] Artifact template identity marker names a template that failed to compile: ${failed.message}`);
    }
    const result = domain === "issue"
        ? validateExistingIssueArtifact(contract, remote.body, issueReferenceFromRemote(remote, remote.number))
        : validateExistingPullRequestArtifact(contract, remote.body);
    return { remote, contract, result };
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
    const canonicalBody = renderCanonicalBody(domain, read.contract, read.result.parse.values, read.result.parse.dependencies);
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
export function renderCanonicalBody(domain, contract, fields, dependencies) {
    return domain === "issue"
        ? renderIssueArtifact(contract, { fields, ...(dependencies === undefined ? {} : { dependencies }) })
        : renderPullRequestArtifact(contract, fields);
}
/** Build the complete semantic input represented by the current remote artifact. */
export function currentArtifactInput(domain, read) {
    const recovered = !read.result.parse.parsed && read.contract !== undefined && read.templateSelection === "explicit"
        ? recoverExistingArtifactValues(read.contract, read.remote.body)
        : undefined;
    const fields = recovered === undefined ? read.result.parse.values : recovered.values;
    const dependencies = read.result.parse.dependencies ?? recovered?.dependencies;
    return artifactInputFromRemote(domain, read.remote, fields, dependencies);
}
function artifactInputFromRemote(domain, remote, fields, dependencies) {
    if (domain === "issue") {
        const issue = remote;
        return {
            fields,
            metadata: { title: issue.title, labels: issue.labels, assignees: issue.assignees },
            ...(dependencies === undefined ? {} : { dependencies }),
        };
    }
    const pullRequest = remote;
    return {
        fields,
        metadata: {
            title: pullRequest.title,
            head: pullRequest.head,
            base: pullRequest.base,
            draft: pullRequest.draft,
            ...(pullRequest.maintainerCanModify === undefined
                ? {}
                : { maintainerCanModify: pullRequest.maintainerCanModify }),
        },
    };
}
/** Apply an explicit semantic patch without touching raw Markdown or inferring missing fields. */
export function applySemanticPatch(domain, read, patch) {
    assertSupportedEditMetadata(domain, patch.metadata, read.remote);
    if (read.contract === undefined || (!read.result.parse.parsed && read.templateSelection !== "explicit")) {
        throw new RemediationError("SEMANTIC_PATCH_UNSUPPORTED", "The existing artifact is not safely parseable under one authoritative template.", "$.artifact");
    }
    assertKnownFields(read.contract, patch.fields, "SEMANTIC_PATCH_INVALID");
    const current = currentArtifactInput(domain, read);
    const metadata = { ...current.metadata, ...patch.metadata };
    const merged = {
        fields: { ...current.fields, ...patch.fields },
        metadata,
        ...(patch.dependencies === undefined
            ? current.dependencies === undefined
                ? {}
                : { dependencies: current.dependencies }
            : { dependencies: patch.dependencies }),
    };
    if (read.templateSelection === "explicit" && !read.result.valid) {
        validateReconstructedInput(read.contract, merged, "SEMANTIC_PATCH_INVALID");
    }
    return merged;
}
/** Reject metadata that the primary edit operation cannot honor for this resource. */
function assertSupportedEditMetadata(domain, metadata, remote) {
    const keys = Object.keys(metadata).sort(compareStrings);
    const supported = domain === "issue" ? new Set(["title", "labels", "assignees"]) : new Set(["title", "base", "maintainerCanModify"]);
    for (const key of keys) {
        if (domain === "pr" && key === "head") {
            const pullRequest = remote;
            const requested = metadata.head;
            throw new RemediationError("PR_HEAD_CHANGE_UNSUPPORTED", "Pull request head branches cannot be changed through the GitHub pull-request model.", "$.metadata.head", { current: pullRequest.head, ...(requested === undefined ? {} : { requested }) });
        }
        if (supported.has(key))
            continue;
        throw new RemediationError("SEMANTIC_PATCH_UNSUPPORTED", `Metadata "${key}" is not supported by ${domain === "issue" ? "issue" : "pull request"} edit.`, `$.metadata.${key}`, { metadata: key });
    }
}
/** Validate values recovered during an explicit-template repair. */
export function validateReconstructedInput(contract, input, code) {
    const loaded = loadCanonicalArtifact(contract, input);
    if (loaded.valid)
        return;
    const partial = validatePartialArtifactInput(contract, input.fields);
    throw new RemediationError(code, "The selected template requires semantic values that could not be recovered from the existing artifact.", "$.fields", {
        requirements: {
            acceptedFields: partial.acceptedFields,
            missingFields: partial.missingFields,
            invalidFields: partial.invalidFields,
            projectedConstraints: partial.projectedConstraints,
            diagnostics: partial.diagnostics,
        },
    });
}
/** Validate and prepare the complete desired state through the existing artifact boundary. */
export function prepareRemediationArtifact(domain, contract, input) {
    if (domain === "issue")
        return prepareIssueArtifact(contract, input).artifact;
    return preparePullRequestArtifact(contract, input).artifact;
}
/** Ensure a declarative sync names only authoritative fields and preserves omitted Issue state. */
export function prepareSyncInput(domain, read, desired) {
    if (read.contract === undefined) {
        throw new RemediationError("SYNC_CURRENT_UNSUPPORTED", "Sync refuses to replace an unsupported or unparseable existing artifact.", "$.artifact");
    }
    assertKnownFields(read.contract, desired.fields, "SYNC_INPUT_INCOMPLETE");
    assertSupportedSyncMetadata(domain, desired.metadata);
    if (domain === "issue") {
        const current = currentArtifactInput(domain, read);
        return {
            fields: { ...current.fields, ...desired.fields },
            metadata: { ...current.metadata, ...desired.metadata },
            ...(desired.dependencies === undefined
                ? current.dependencies === undefined
                    ? {}
                    : { dependencies: current.dependencies }
                : { dependencies: desired.dependencies }),
        };
    }
    if (domain === "pr" && desired.metadata.head !== undefined) {
        const remote = read.remote;
        if (desired.metadata.head !== remote.head) {
            throw new RemediationError("PR_HEAD_CHANGE_UNSUPPORTED", "Pull request head branches cannot be changed through the GitHub pull-request model.", "$.head", { current: boundDiagnosticText(remote.head), requested: boundDiagnosticText(desired.metadata.head) });
        }
    }
    if (domain === "pr" && desired.metadata.draft !== undefined) {
        const remote = read.remote;
        if (desired.metadata.draft !== remote.draft) {
            throw new RemediationError("PR_DRAFT_CHANGE_UNSUPPORTED", "Pull request draft state cannot be changed through the GitHub pull-request update model.", "$.draft", { current: remote.draft, requested: desired.metadata.draft });
        }
    }
    return desired;
}
function assertSupportedSyncMetadata(domain, metadata) {
    const supported = domain === "issue"
        ? new Set(["title", "labels", "assignees"])
        : new Set(["title", "head", "base", "draft", "maintainerCanModify"]);
    const unsupported = Object.keys(metadata)
        .filter((key) => !supported.has(key))
        .sort(compareStrings);
    const key = unsupported[0];
    if (key === undefined)
        return;
    throw new RemediationError("SYNC_METADATA_UNSUPPORTED", `Metadata "${key}" is not supported by ${domain} sync.`, `$.metadata.${key}`, { metadata: key });
}
/**
 * Compare the current semantic/rendered artifact with a prepared canonical projection.
 * PR sync owns maintainerCanModify; edit retains its established diff behavior.
 */
export function diffArtifact(domain, read, desired, includePullRequestMaintainerCanModify = false) {
    const currentInput = currentArtifactInput(domain, read);
    const currentFields = currentInput.fields;
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
    if (domain === "issue") {
        const currentDependencies = currentInput.dependencies;
        const desiredDependencies = desiredDependenciesFromArtifact(desired, read.contract);
        if (stableValue(currentDependencies) !== stableValue(desiredDependencies)) {
            semantic.push({
                path: "$.dependencies",
                ...(currentDependencies === undefined ? {} : { before: boundedValue(currentDependencies) }),
                ...(desiredDependencies === undefined ? {} : { after: boundedValue(desiredDependencies) }),
            });
        }
    }
    const currentMetadata = currentMetadataForDiff(domain, read.remote);
    const desiredMetadata = desiredMetadataForDiff(domain, desired, includePullRequestMaintainerCanModify);
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
    const parsed = domain === "issue"
        ? validateExistingIssueArtifact(contract, artifact.body)
        : validateExistingPullRequestArtifact(contract, artifact.body);
    return parsed.parse.values;
}
function desiredDependenciesFromArtifact(artifact, contract) {
    if (contract === undefined || contract.artifactKind !== "issue")
        return undefined;
    return validateExistingIssueArtifact(contract, artifact.body).parse.dependencies;
}
function currentMetadataForDiff(domain, remote) {
    if (domain === "issue") {
        const issue = remote;
        return { title: issue.title, labels: issue.labels, assignees: issue.assignees };
    }
    const pullRequest = remote;
    return {
        title: pullRequest.title,
        head: pullRequest.head,
        base: pullRequest.base,
        draft: pullRequest.draft,
        ...(pullRequest.maintainerCanModify === undefined ? {} : { maintainerCanModify: pullRequest.maintainerCanModify }),
    };
}
function desiredMetadataForDiff(domain, artifact, includePullRequestMaintainerCanModify) {
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
        ...(includePullRequestMaintainerCanModify && pullRequest.maintainerCanModify !== undefined
            ? { maintainerCanModify: pullRequest.maintainerCanModify }
            : {}),
    };
}
function assertKnownFields(contract, fields, code) {
    const known = new Set(contract.sections.flatMap((section) => section.fields.map((field) => field.id)));
    const unknown = Object.keys(fields).find((field) => !known.has(field));
    if (unknown !== undefined) {
        throw new RemediationError(code, `Unknown semantic field "${unknown}".`, `$.fields.${unknown}`, { field: unknown });
    }
}
function remediationRequirementDiagnostics(error) {
    if (!(error instanceof RemediationError))
        return undefined;
    const requirements = error.details?.requirements;
    if (typeof requirements !== "object" || requirements === null)
        return undefined;
    const diagnostics = requirements.diagnostics;
    if (!isArtifactDiagnosticReport(diagnostics))
        return undefined;
    return diagnostics;
}
function explicitRepairRequirements(read) {
    if (read.contract === undefined || read.templateSelection !== "explicit" || read.result.valid)
        return undefined;
    const domain = read.contract.artifactKind === "issue" ? "issue" : "pr";
    const partial = validatePartialArtifactInput(read.contract, currentArtifactInput(domain, read).fields);
    return {
        acceptedFields: partial.acceptedFields,
        missingFields: partial.missingFields,
        invalidFields: partial.invalidFields,
        projectedConstraints: partial.projectedConstraints,
        diagnostics: partial.diagnostics,
    };
}
function isArtifactDiagnosticReport(value) {
    return (typeof value === "object" &&
        value !== null &&
        "diagnostics" in value &&
        Array.isArray(value.diagnostics) &&
        "acceptedFields" in value &&
        Array.isArray(value.acceptedFields));
}
function boundedDiagnosticReport(report) {
    return createArtifactDiagnosticReport(report.diagnostics.slice(0, 32), report.acceptedFields.slice(0, 128));
}
function existingDiagnosticMessage(code, hasSelectedTemplate) {
    if (code === "EXISTING_AMBIGUOUS_TEMPLATE")
        return "The artifact matches more than one repository template.";
    if (code === "EXISTING_EXTRA_CONTENT")
        return "The artifact contains content outside the selected template structure.";
    if (code === "EXISTING_UNKNOWN_CHECKLIST_ITEM") {
        return "The artifact contains a checklist item that is not declared by the selected template.";
    }
    if (code === "EXISTING_TEMPLATE_COMPILE_FAILED")
        return "The repository template could not be compiled.";
    if (code === "EXISTING_TEMPLATE_MARKER_INVALID")
        return "The artifact template identity marker is invalid.";
    if (code === "EXISTING_WRONG_TEMPLATE") {
        return hasSelectedTemplate
            ? "The artifact structure does not match the selected template."
            : "The artifact structure does not match an authoritative template.";
    }
    return hasSelectedTemplate
        ? "The artifact representation does not match the selected template."
        : "The artifact representation could not be parsed against an authoritative template.";
}
function projectExistingDiagnosticPath(path, contract) {
    if (path === "$" || path === "$.body")
        return "$.artifact";
    if (path === "$.template")
        return path;
    if (contract !== undefined) {
        const fieldIds = contract.sections.flatMap((section) => section.fields.map((field) => field.id));
        const lastSegment = path.split(".").at(-1);
        const field = fieldIds.find((id) => id === lastSegment);
        if (field !== undefined)
            return `$.fields.${field}`;
    }
    const fieldLikePath = /^\$\.(?:sections\.)?([A-Za-z][A-Za-z0-9_-]*)$/u.exec(path);
    if (fieldLikePath?.[1] !== undefined)
        return `$.fields.${fieldLikePath[1]}`;
    return path;
}
function boundDiagnosticText(value) {
    return value.slice(0, 160);
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