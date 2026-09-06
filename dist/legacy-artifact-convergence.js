/**
 * Bounded compatibility ingress for the v1 artifact APIs.
 *
 * The v1 candidate/document shape is retained for migration, but it is not a
 * semantic authority. This module translates only explicit, typed values into
 * the Core Effective Artifact Contract input shape. Native title/branch rules
 * and the dependency sidecar remain projection/evidence data at this
 * boundary; they never override a Semantic Artifact.
 */
import { validateBranchName } from "../branch-naming-authority.mjs";
import { parseArtifactContract, } from "./contract/index.js";
import { issueReferenceKey, normalizeIssueReference, validateIssueDependencies, } from "./contract/issue-reference.js";
import { compileEffectiveArtifactContract, } from "./contract/effective-artifact-contract.js";
import { SemanticArtifactMaterializationError, tryMaterializeSemanticArtifact, } from "./contract/semantic-artifact.js";
export const LEGACY_ARTIFACT_CONVERGENCE_VERSION = "1";
export const MAX_LEGACY_CONVERGENCE_DIAGNOSTICS = 32;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOwn(record, key) {
    return Object.prototype.hasOwnProperty.call(record, key);
}
function compareStrings(left, right) {
    return left.localeCompare(right, "en-US");
}
function diagnostic(code, path, message) {
    return { code, path, message };
}
function sortDiagnostics(diagnostics) {
    return [...diagnostics]
        .sort((left, right) => left.path.localeCompare(right.path, "en-US") || left.code.localeCompare(right.code, "en-US"))
        .slice(0, MAX_LEGACY_CONVERGENCE_DIAGNOSTICS);
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
function cloneJson(value) {
    if (Array.isArray(value))
        return value.map((entry) => cloneJson(entry));
    if (isRecord(value)) {
        const output = {};
        for (const key of Object.keys(value).sort(compareStrings))
            output[key] = cloneJson(value[key]);
        return output;
    }
    return value;
}
function sourceFromInput(input) {
    return "source" in input ? "candidate" : "document";
}
function candidateParts(input) {
    return {
        fields: input.fields,
        metadata: input.metadata,
        ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
    };
}
function isEffectiveArtifactContract(value) {
    return (isRecord(value) &&
        value.version === "1" &&
        isRecord(value.contract) &&
        isRecord(value.inputSchema) &&
        isRecord(value.provenance));
}
function referencesEqual(left, right) {
    if (left.length !== right.length)
        return false;
    const leftKeys = left.map(issueReferenceKey).sort(compareStrings);
    const rightKeys = right.map(issueReferenceKey).sort(compareStrings);
    return leftKeys.every((key, index) => key === rightKeys[index]);
}
function normalizeReferences(input, path) {
    if (!Array.isArray(input)) {
        return { diagnostics: [diagnostic("LEGACY_RELATION_INVALID", path, "Semantic relation must be an array.")] };
    }
    const diagnostics = [];
    const references = [];
    const seen = new Set();
    input.forEach((entry, index) => {
        const result = normalizeIssueReference(entry, `${path}[${index}]`);
        if (!result.valid || result.reference === undefined) {
            diagnostics.push(diagnostic("LEGACY_RELATION_INVALID", `${path}[${index}]`, "IssueReference is invalid."));
            return;
        }
        const key = issueReferenceKey(result.reference);
        if (seen.has(key)) {
            diagnostics.push(diagnostic("LEGACY_RELATION_INVALID", `${path}[${index}]`, `Duplicate IssueReference "${key}".`));
            return;
        }
        seen.add(key);
        references.push(result.reference);
    });
    references.sort((left, right) => issueReferenceKey(left).localeCompare(issueReferenceKey(right), "en-US"));
    return { references, diagnostics };
}
function linkedIssueReferenceFromText(value, repository, path) {
    if (isRecord(value)) {
        const result = normalizeIssueReference(value, path);
        return result.valid && result.reference !== undefined
            ? { reference: result.reference, diagnostics: [] }
            : { diagnostics: [diagnostic("LEGACY_LINKED_ISSUE_INVALID", path, "linkedIssue IssueReference is invalid.")] };
    }
    if (typeof value !== "string") {
        return {
            diagnostics: [diagnostic("LEGACY_LINKED_ISSUE_INVALID", path, "linkedIssue must be an explicit reference.")],
        };
    }
    const trimmed = value.trim();
    // Only the complete, reserved closing-reference form is accepted. In
    // particular, this does not search arbitrary prose for a number.
    const match = /^(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+(.+)$/iu.exec(trimmed);
    if (match === null) {
        return {
            diagnostics: [
                diagnostic("LEGACY_LINKED_ISSUE_INVALID", path, "linkedIssue must be a complete closing reference; arbitrary prose is not semantic input."),
            ],
        };
    }
    const locator = match[1];
    const local = /^#([1-9][0-9]*)$/u.exec(locator);
    const crossRepository = /^([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)#([1-9][0-9]*)$/u.exec(locator);
    if (local === null && crossRepository === null) {
        return {
            diagnostics: [diagnostic("LEGACY_LINKED_ISSUE_INVALID", path, "linkedIssue reference syntax is invalid.")],
        };
    }
    if (repository === undefined) {
        return {
            diagnostics: [
                diagnostic("LEGACY_LINKED_ISSUE_UNRESOLVED", path, "A local linked Issue requires explicit repository identity before it can become implements."),
            ],
        };
    }
    if (crossRepository !== null &&
        repository.repository !== undefined &&
        repository.repository.toLocaleLowerCase("en-US") !== crossRepository[1]?.toLocaleLowerCase("en-US")) {
        return {
            diagnostics: [
                diagnostic("LEGACY_LINKED_ISSUE_UNRESOLVED", path, "Cross-repository linked Issue identity does not match the supplied repository authority."),
            ],
        };
    }
    const numberText = local?.[1] ?? crossRepository?.[2];
    const number = Number(numberText);
    return {
        reference: {
            repositoryHost: repository.repositoryHost.toLocaleLowerCase("en-US"),
            repositoryId: repository.repositoryId,
            ...(repository.repository === undefined
                ? crossRepository === null
                    ? {}
                    : { repository: crossRepository[1]?.toLocaleLowerCase("en-US") }
                : { repository: repository.repository.toLocaleLowerCase("en-US") }),
            number,
        },
        diagnostics: [],
    };
}
function relationName(kind) {
    if (kind === "issue")
        return "dependsOn";
    if (kind === "pull_request")
        return "implements";
    return undefined;
}
function declaredProperty(effective, name) {
    return effective.properties[name];
}
function mapLegacyInput(effective, input, options) {
    const diagnostics = [];
    const parts = candidateParts(input);
    if (!isRecord(parts.fields)) {
        return {
            version: LEGACY_ARTIFACT_CONVERGENCE_VERSION,
            valid: false,
            compatibility: {
                metadata: parts.metadata,
                ...(parts.dependencies === undefined ? {} : { dependencies: parts.dependencies }),
                source: sourceFromInput(input),
            },
            diagnostics: [diagnostic("LEGACY_INPUT_INVALID", "$.fields", "Legacy artifact fields must be an object.")],
        };
    }
    const semantic = cloneJson(parts.fields);
    // v1 enum values are scalar strings; Core's closed `choice` primitive is a
    // bounded list. The adapter changes only this representation shape.
    for (const field of effective.fields ?? []) {
        if (field.primitive !== "choice" || !hasOwn(semantic, field.id) || Array.isArray(semantic[field.id]))
            continue;
        semantic[field.id] = [semantic[field.id]];
    }
    const relation = relationName(effective.kind);
    const metadataKeys = [
        "title",
        "labels",
        "assignees",
        "head",
        "base",
        "draft",
        "maintainerCanModify",
    ];
    for (const key of metadataKeys) {
        const value = parts.metadata[key];
        if (value === undefined)
            continue;
        const declaration = declaredProperty(effective, key);
        if (declaration === undefined || declaration.presence === "unused") {
            diagnostics.push(diagnostic("LEGACY_UNKNOWN_METADATA", `$.metadata.${key}`, `Legacy metadata "${key}" is not declared by Core.`));
            continue;
        }
        if (hasOwn(semantic, key) && stableValue(semantic[key]) !== stableValue(value)) {
            diagnostics.push(diagnostic("LEGACY_SEMANTIC_CONFLICT", `$.metadata.${key}`, `Legacy metadata and semantic value "${key}" conflict.`));
            continue;
        }
        semantic[key] = cloneJson(value);
    }
    const sidecarValidation = effective.kind === "issue" ? validateIssueDependencies(parts.dependencies) : undefined;
    if (sidecarValidation !== undefined && !sidecarValidation.valid) {
        for (const violation of sidecarValidation.violations) {
            diagnostics.push(diagnostic("LEGACY_RELATION_INVALID", `$.dependencies${violation.path.slice(1)}`, violation.message));
        }
    }
    const sidecarBlockedBy = sidecarValidation?.valid
        ? sidecarValidation.dependencies.blockedBy
        : sidecarValidation === undefined
            ? (parts.dependencies?.blockedBy ?? [])
            : [];
    if (effective.kind !== "issue" &&
        parts.dependencies !== undefined &&
        ((parts.dependencies.blockedBy?.length ?? 0) > 0 || (parts.dependencies.blocks?.length ?? 0) > 0)) {
        diagnostics.push(diagnostic("LEGACY_RELATION_UNSUPPORTED", "$.dependencies", "Issue dependency sidecar is supported only as an Issue dependsOn compatibility ingress."));
    }
    if (sidecarBlockedBy.length > 0) {
        if (relation !== "dependsOn" || declaredProperty(effective, "dependsOn")?.presence === "unused") {
            diagnostics.push(diagnostic("LEGACY_RELATION_UNSUPPORTED", "$.dependencies.blockedBy", "Legacy dependencies have no declared semantic dependsOn relation."));
        }
        else if (hasOwn(semantic, "dependsOn")) {
            const parsed = normalizeReferences(semantic.dependsOn, "$.dependsOn");
            diagnostics.push(...parsed.diagnostics);
            if (parsed.references !== undefined && !referencesEqual(parsed.references, sidecarBlockedBy)) {
                diagnostics.push(diagnostic("LEGACY_SEMANTIC_CONFLICT", "$.dependencies.blockedBy", "Legacy dependency evidence conflicts with semantic dependsOn."));
            }
        }
        else {
            semantic.dependsOn = cloneJson(sidecarBlockedBy);
        }
    }
    // `blocks` is an inverse compatibility view. It is retained in the
    // compatibility result and intentionally never authored as dependsOn.
    if (relation === "implements") {
        const linkedValue = semantic.linkedIssue ?? semantic.linked_issue;
        const explicit = options.linkedIssueReferences;
        let linked = explicit;
        if (linkedValue !== undefined) {
            const parsed = linkedIssueReferenceFromText(linkedValue, options.linkedIssueRepository, "$.linkedIssue");
            diagnostics.push(...parsed.diagnostics);
            const textReferences = parsed.reference === undefined ? undefined : [parsed.reference];
            if (linked === undefined)
                linked = textReferences;
            else if (textReferences !== undefined && !referencesEqual(textReferences, linked)) {
                diagnostics.push(diagnostic("LEGACY_SEMANTIC_CONFLICT", "$.linkedIssue", "Legacy linkedIssue conflicts with typed implements."));
            }
        }
        if (linked !== undefined) {
            const parsed = hasOwn(semantic, "implements")
                ? normalizeReferences(semantic.implements, "$.implements")
                : undefined;
            if (parsed !== undefined)
                diagnostics.push(...parsed.diagnostics);
            if (parsed?.references !== undefined && !referencesEqual(parsed.references, linked)) {
                diagnostics.push(diagnostic("LEGACY_SEMANTIC_CONFLICT", "$.implements", "Legacy linkedIssue evidence conflicts with semantic implements."));
            }
            else if (!hasOwn(semantic, "implements")) {
                semantic.implements = cloneJson(linked);
            }
        }
        // `linkedIssue`/`linked_issue` is a legacy presentation field. Once its
        // explicit relation has been admitted, it must not reach Core as a second
        // semantic value.
        if (linked !== undefined) {
            delete semantic.linkedIssue;
            delete semantic.linked_issue;
        }
    }
    if (options.nativeTitlePrefix !== undefined && parts.metadata.title !== undefined) {
        const title = parts.metadata.title.trim();
        if (title === options.nativeTitlePrefix.trim()) {
            diagnostics.push(diagnostic("LEGACY_TITLE_INVALID", "$.metadata.title", "Legacy title must contain content beyond the native prefix."));
        }
    }
    if (options.branch !== undefined) {
        const errors = validateBranchName(options.branch);
        if (errors.length > 0)
            diagnostics.push(diagnostic("LEGACY_BRANCH_INVALID", "$.metadata.head", errors[0]));
    }
    const compatibility = {
        metadata: parts.metadata,
        ...(parts.dependencies === undefined ? {} : { dependencies: parts.dependencies }),
        source: sourceFromInput(input),
    };
    return {
        version: LEGACY_ARTIFACT_CONVERGENCE_VERSION,
        valid: diagnostics.length === 0,
        ...(diagnostics.length === 0 ? { semanticInput: semantic } : {}),
        compatibility,
        diagnostics: sortDiagnostics(diagnostics),
    };
}
/** Translate a legacy candidate/document into Core input without materializing it. */
export function convergeLegacyArtifactInput(effectiveContract, input, options = {}) {
    return mapLegacyInput(effectiveContract, input, options);
}
/** Alias emphasizing the old candidate boundary. */
export const mapLegacyArtifactCandidate = convergeLegacyArtifactInput;
function fieldConstraints(field) {
    const constraints = field.constraints;
    const values = field.type === "enum"
        ? field.options.map((option) => option.value)
        : field.type === "array"
            ? field.items.options?.map((option) => option.value)
            : undefined;
    if (constraints === undefined && values === undefined && field.type !== "checklist")
        return undefined;
    return {
        ...(constraints?.minLength === undefined ? {} : { minLength: constraints.minLength }),
        ...(constraints?.maxLength === undefined ? {} : { maxLength: constraints.maxLength }),
        ...(constraints?.pattern === undefined ? {} : { pattern: constraints.pattern }),
        ...(constraints?.minItems === undefined ? {} : { minItems: constraints.minItems }),
        ...(constraints?.maxItems === undefined ? {} : { maxItems: constraints.maxItems }),
        ...(values === undefined ? {} : { values }),
        ...(field.type === "enum" && constraints?.maxItems === undefined ? { maxItems: 1 } : {}),
        ...(field.type === "checklist"
            ? { items: field.items.map((item) => ({ id: item.id, label: item.label, required: item.required })) }
            : {}),
    };
}
function fieldDeclaration(field) {
    const presence = field.required === "required" ? "required" : "optional";
    const primitive = field.type === "string" ? "text" : field.type === "enum" || field.type === "array" ? "choice" : "checklist";
    return {
        id: field.id,
        primitive,
        presence,
        authority: { kind: "supplied" },
        ...(fieldConstraints(field) === undefined
            ? primitive === "choice"
                ? { constraints: {} }
                : {}
            : { constraints: fieldConstraints(field) }),
    };
}
function oldProvenance(provenance) {
    if (provenance === undefined)
        return undefined;
    return {
        authority: provenance.authority,
        repository: provenance.repository,
        ref: provenance.ref,
        treeSha: provenance.treeSha,
        source: provenance.template,
    };
}
/**
 * Build a temporary v2 contract for a v1 native-template CanonicalContract.
 * This is a compatibility compiler only; it does not make native metadata or
 * native relation encodings semantic authority.
 */
export function artifactContractFromLegacyCanonical(contract) {
    const linkedFieldIds = new Set(contract.supplementalConstraints.fields.filter((entry) => entry.linkedIssue === true).map((entry) => entry.fieldId));
    const fields = contract.sections
        .filter((section) => section.kind === "input")
        .flatMap((section) => section.fields.filter((field) => !linkedFieldIds.has(field.id)).map(fieldDeclaration));
    // This object is v2 authoring JSON. `parseArtifactContract` is the sole
    // place that adds normalized shapes/cardinality; never hand-author the
    // normalized IR here.
    const properties = {};
    if (contract.artifactKind === "issue") {
        properties.title = {
            presence: "required",
            authority: { kind: "supplied" },
        };
        properties.labels = {
            presence: "optional",
            authority: { kind: "supplied" },
        };
        properties.assignees = {
            presence: "optional",
            authority: { kind: "supplied" },
        };
        properties.dependsOn = {
            presence: "optional",
            authority: { kind: "supplied" },
        };
        properties.parent = { presence: "unused" };
        properties.milestone = { presence: "unused" };
    }
    else {
        properties.title = {
            presence: "required",
            authority: { kind: "supplied" },
        };
        properties.head = {
            presence: "required",
            authority: { kind: "supplied" },
        };
        properties.base = {
            presence: "required",
            authority: { kind: "supplied" },
        };
        properties.draft = {
            presence: "optional",
            authority: { kind: "supplied" },
        };
        properties.maintainerCanModify = {
            presence: "optional",
            authority: { kind: "supplied" },
        };
        const linked = contract.supplementalConstraints.fields.some((entry) => entry.linkedIssue === true);
        properties.implements = {
            presence: linked ? "required" : "optional",
            authority: { kind: "supplied" },
        };
        properties.labels = { presence: "unused" };
        properties.assignees = { presence: "unused" };
        properties.reviewers = { presence: "unused" };
        properties.milestone = { presence: "unused" };
    }
    return parseArtifactContract({
        version: "1",
        kind: contract.artifactKind,
        id: contract.templateIdentity.id,
        properties,
        ...(contract.artifactKind === "issue" || contract.artifactKind === "pull_request" ? { fields } : {}),
    });
}
/** Compile the compatibility contract using the old contract's trusted generation. */
export function compileLegacyEffectiveArtifactContract(contract) {
    const provenance = oldProvenance(contract.provenance);
    if (provenance === undefined) {
        throw new Error("Legacy CanonicalContract has no trusted provenance.");
    }
    return compileEffectiveArtifactContract(artifactContractFromLegacyCanonical(contract), { provenance });
}
/** Materialize a legacy candidate/document through the v2 Core boundary. */
export function tryMaterializeLegacyArtifact(contract, input, options = {}) {
    let effectiveContract;
    if (isEffectiveArtifactContract(contract))
        effectiveContract = contract;
    else {
        try {
            effectiveContract = compileLegacyEffectiveArtifactContract(contract);
        }
        catch (error) {
            const code = error instanceof Error && error.message.includes("provenance")
                ? "LEGACY_PROVENANCE_MISSING"
                : "LEGACY_CONTRACT_UNSUPPORTED";
            return {
                valid: false,
                diagnostics: [
                    diagnostic(code, code === "LEGACY_PROVENANCE_MISSING" ? "$.provenance" : "$.contract", error instanceof Error ? error.message : "Legacy contract cannot be converged."),
                ],
            };
        }
    }
    const converged = convergeLegacyArtifactInput(effectiveContract, input, options);
    if (!converged.valid || converged.semanticInput === undefined) {
        return {
            valid: false,
            effectiveContract,
            diagnostics: converged.diagnostics,
            compatibility: converged.compatibility,
        };
    }
    const materialization = tryMaterializeSemanticArtifact(effectiveContract, converged.semanticInput);
    return {
        valid: materialization.valid,
        ...(materialization.artifact === undefined ? {} : { artifact: materialization.artifact }),
        effectiveContract,
        diagnostics: materialization.violations,
        compatibility: converged.compatibility,
    };
}
/** Strict counterpart for callers that already use exception-based Core APIs. */
export function materializeLegacyArtifact(contract, input, options = {}) {
    const result = tryMaterializeLegacyArtifact(contract, input, options);
    if (!result.valid || result.artifact === undefined) {
        throw new SemanticArtifactMaterializationError(result.diagnostics.map((entry) => ({
            code: "OUTPUT_INVALID",
            path: entry.path,
            message: entry.message,
        })));
    }
    return result.artifact;
}
/** Validate a legacy branch projection without deriving or rewriting it. */
export function validateLegacyBranchProjection(branch) {
    const errors = validateBranchName(branch);
    return {
        version: LEGACY_ARTIFACT_CONVERGENCE_VERSION,
        valid: errors.length === 0,
        ...(errors.length === 0 ? {} : { compatibility: { metadata: {}, source: "candidate" } }),
        diagnostics: errors.map((message) => diagnostic("LEGACY_BRANCH_INVALID", "$.branch", message)),
    };
}
//# sourceMappingURL=legacy-artifact-convergence.js.map