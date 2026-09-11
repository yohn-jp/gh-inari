/**
 * Transport-neutral Core planning for native Semantic Issue relationships.
 *
 * `parent` and `dependsOn` are the only forward semantic authorities.  The
 * provider-facing `children`/`blocks` views are deliberately not accepted as
 * mutation input here.  This module computes bounded deltas from normalized
 * desired and observed evidence; it never performs provider I/O.
 */
import { issueReferenceKey, normalizeIssueReference } from "./contract/issue-reference.js";
export const SEMANTIC_ISSUE_RELATION_PLAN_VERSION = "1";
export class SemanticIssueRelationError extends Error {
    diagnostics;
    constructor(diagnostics) {
        super(diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n"));
        this.name = "SemanticIssueRelationError";
        this.diagnostics = diagnostics;
    }
}
const RELATION_PLAN_KEYS = new Set([
    "version",
    "kind",
    "subject",
    "desired",
    "observed",
    "capabilities",
    "provenance",
    "generation",
    "preconditions",
    "effects",
]);
const RELATION_STATE_KEYS = new Set([
    "parent",
    "dependsOn",
    "parentRepresentation",
    "dependsOnRepresentation",
    "parentStatus",
    "dependsOnStatus",
    "status",
]);
const EFFECT_KINDS = new Set([
    "SET_PARENT_RELATION",
    "CLEAR_PARENT_RELATION",
    "ADD_BLOCKED_BY_RELATION",
    "REMOVE_BLOCKED_BY_RELATION",
]);
const NATIVE_PARENT_CAPABILITY = "github.issue.parent.native";
const NATIVE_DEPENDS_ON_CAPABILITY = "github.issue.blocked-by.native";
const MAX_NODES = 1_000;
const MAX_REFERENCES = 1_000;
function isRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function hasOwn(record, key) {
    return Object.prototype.hasOwnProperty.call(record, key);
}
function compareReferences(left, right) {
    return (left.repositoryHost.localeCompare(right.repositoryHost, "en-US") ||
        left.repositoryId.localeCompare(right.repositoryId, "en-US") ||
        left.number - right.number);
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
                .sort((left, right) => left.localeCompare(right, "en-US"))
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
        for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, "en-US")))
            clone[key] = cloneImmutable(value[key]);
        return Object.freeze(clone);
    }
    return value;
}
function diagnostic(code, path, message) {
    return { code, path, message };
}
function unknownProperties(value, allowed, path, diagnostics) {
    for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, "en-US"))) {
        if (!allowed.has(key))
            diagnostics.push(diagnostic("RELATION_INPUT_UNKNOWN_PROPERTY", `${path}.${key}`, `Property "${key}" is not supported.`));
    }
}
function normalizeReference(value, path, diagnostics) {
    const result = normalizeIssueReference(value, path);
    if (!result.valid || result.reference === undefined) {
        diagnostics.push(diagnostic("RELATION_REFERENCE_INVALID", path, "IssueReference is invalid."));
        return undefined;
    }
    return result.reference;
}
function looksLikeIssueReference(value) {
    return hasOwn(value, "repositoryHost") || hasOwn(value, "repositoryId") || hasOwn(value, "number");
}
function normalizeReferenceArray(value, path, diagnostics) {
    if (!Array.isArray(value)) {
        diagnostics.push(diagnostic("RELATION_REFERENCE_INVALID", path, "Relation references must be an array."));
        return undefined;
    }
    if (value.length > MAX_REFERENCES) {
        diagnostics.push(diagnostic("RELATION_REFERENCE_INVALID", path, "Relation references exceed the bounded item limit."));
        return undefined;
    }
    const values = [];
    const seen = new Set();
    value.forEach((entry, index) => {
        const reference = normalizeReference(entry, `${path}[${index}]`, diagnostics);
        if (reference === undefined)
            return;
        const key = issueReferenceKey(reference);
        if (seen.has(key)) {
            diagnostics.push(diagnostic("RELATION_REFERENCE_DUPLICATE", `${path}[${index}]`, "Relation references must be unique."));
            return;
        }
        seen.add(key);
        values.push(reference);
    });
    return values.sort(compareReferences);
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
function sameRepository(left, right) {
    return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}
function nativeCapability(capabilities, kind) {
    const aliases = kind === "parent"
        ? new Set([NATIVE_PARENT_CAPABILITY, "issue.parent.native"])
        : new Set([
            NATIVE_DEPENDS_ON_CAPABILITY,
            "github.issue.dependencies.native",
            "github.issue.blocked_by.native",
            "issue.depends-on.native",
        ]);
    return capabilities.some((capability) => aliases.has(capability));
}
function normalizeCapabilities(value, diagnostics) {
    if (!Array.isArray(value)) {
        diagnostics.push(diagnostic("RELATION_INPUT_INVALID", "$.capabilities", "Capabilities must be an array."));
        return undefined;
    }
    const values = [];
    const seen = new Set();
    value.forEach((entry, index) => {
        if (typeof entry !== "string" || entry.trim().length === 0) {
            diagnostics.push(diagnostic("RELATION_INPUT_INVALID", `$.capabilities[${index}]`, "Capability must be a non-empty string."));
            return;
        }
        if (seen.has(entry)) {
            diagnostics.push(diagnostic("RELATION_INPUT_INVALID", `$.capabilities[${index}]`, "Capabilities must be unique."));
            return;
        }
        seen.add(entry);
        values.push(entry);
    });
    return values.sort((left, right) => left.localeCompare(right, "en-US"));
}
function cycleDiagnostic(kind, path, cycle) {
    return diagnostic(kind === "parent" ? "RELATION_PARENT_CYCLE" : "RELATION_DEPENDENCY_CYCLE", path, `${kind === "parent" ? "Parent" : "Dependency"} relationship graph contains a cycle: ${cycle.join(" -> ")}.`);
}
function detectCycles(nodes, kind) {
    const edges = new Map();
    for (const node of nodes) {
        const key = issueReferenceKey(node.reference);
        const references = kind === "parent" ? (node.parent === undefined ? [] : [node.parent]) : node.dependsOn;
        edges.set(key, references.map(issueReferenceKey));
    }
    const state = new Map();
    const stack = [];
    const visit = (key) => {
        const current = state.get(key);
        if (current === "visited")
            return undefined;
        if (current === "visiting") {
            const start = stack.indexOf(key);
            return cycleDiagnostic(kind, "$.graph.nodes", [...stack.slice(start < 0 ? 0 : start), key]);
        }
        state.set(key, "visiting");
        stack.push(key);
        for (const next of edges.get(key) ?? []) {
            // Edges to a node outside a complete bounded scope cannot form a cycle
            // entirely inside the supplied graph; the caller controls scope safety.
            if (!edges.has(next))
                continue;
            const found = visit(next);
            if (found !== undefined)
                return found;
        }
        stack.pop();
        state.set(key, "visited");
        return undefined;
    };
    for (const key of edges.keys()) {
        const found = visit(key);
        if (found !== undefined)
            return found;
    }
    return undefined;
}
/** Validate a bounded relationship graph before any provider effect. */
export function validateIssueRelationshipGraph(input) {
    const diagnostics = [];
    if (!isRecord(input)) {
        diagnostics.push(diagnostic("RELATION_INPUT_INVALID", "$", "Relationship graph must be an object."));
        return { valid: false, diagnostics };
    }
    unknownProperties(input, new Set(["scope", "nodes"]), "$", diagnostics);
    const scope = input.scope === "unavailable" ? "unavailable" : "complete";
    if (input.scope !== undefined && input.scope !== "complete" && input.scope !== "unavailable")
        diagnostics.push(diagnostic("RELATION_INPUT_INVALID", "$.scope", "Graph scope must be complete or unavailable."));
    if (!Array.isArray(input.nodes)) {
        diagnostics.push(diagnostic("RELATION_INPUT_INVALID", "$.nodes", "Relationship graph nodes must be an array."));
        return { valid: false, diagnostics };
    }
    if (input.nodes.length > MAX_NODES)
        diagnostics.push(diagnostic("RELATION_INPUT_INVALID", "$.nodes", "Relationship graph exceeds the bounded node limit."));
    const nodes = [];
    const seenNodes = new Set();
    input.nodes.forEach((entry, index) => {
        const path = `$.nodes[${index}]`;
        if (!isRecord(entry)) {
            diagnostics.push(diagnostic("RELATION_INPUT_INVALID", path, "Relationship graph node must be an object."));
            return;
        }
        unknownProperties(entry, new Set(["reference", "parent", "dependsOn"]), path, diagnostics);
        const reference = normalizeReference(entry.reference, `${path}.reference`, diagnostics);
        if (reference === undefined)
            return;
        const key = issueReferenceKey(reference);
        if (seenNodes.has(key)) {
            diagnostics.push(diagnostic("RELATION_REFERENCE_DUPLICATE", `${path}.reference`, "Relationship graph node references must be unique."));
            return;
        }
        seenNodes.add(key);
        const parent = hasOwn(entry, "parent") && entry.parent !== null
            ? normalizeReference(entry.parent, `${path}.parent`, diagnostics)
            : undefined;
        const dependsOn = hasOwn(entry, "dependsOn")
            ? normalizeReferenceArray(entry.dependsOn, `${path}.dependsOn`, diagnostics)
            : [];
        if (parent !== undefined && issueReferenceKey(parent) === key)
            diagnostics.push(diagnostic("RELATION_SELF", `${path}.parent`, "An Issue cannot be its own parent."));
        if (dependsOn !== undefined && dependsOn.some((dependency) => issueReferenceKey(dependency) === key))
            diagnostics.push(diagnostic("RELATION_SELF", `${path}.dependsOn`, "An Issue cannot depend on itself."));
        nodes.push({ reference, ...(parent === undefined ? {} : { parent }), dependsOn: dependsOn ?? [] });
    });
    // A graph marked complete must be closed over every authoritative edge.  A
    // missing target would make cycle admission unsound (the cycle may pass
    // through an omitted node), so report unavailable evidence rather than
    // silently treating the edge as a leaf.
    if (scope === "complete") {
        const nodeKeys = new Set(nodes.map((node) => issueReferenceKey(node.reference)));
        for (const [index, node] of nodes.entries()) {
            if (node.parent !== undefined && !nodeKeys.has(issueReferenceKey(node.parent)))
                diagnostics.push(diagnostic("RELATION_EVIDENCE_UNAVAILABLE", `$.nodes[${index}].parent`, "A complete relationship graph must include every parent target."));
            node.dependsOn.forEach((reference, dependencyIndex) => {
                if (!nodeKeys.has(issueReferenceKey(reference)))
                    diagnostics.push(diagnostic("RELATION_EVIDENCE_UNAVAILABLE", `$.nodes[${index}].dependsOn[${dependencyIndex}]`, "A complete relationship graph must include every dependency target."));
            });
        }
    }
    if (diagnostics.length === 0) {
        const parentCycle = detectCycles(nodes, "parent");
        if (parentCycle !== undefined)
            diagnostics.push(parentCycle);
        const dependencyCycle = detectCycles(nodes, "dependency");
        if (dependencyCycle !== undefined)
            diagnostics.push(dependencyCycle);
    }
    if (diagnostics.length > 0)
        return { valid: false, diagnostics };
    return {
        valid: true,
        graph: cloneImmutable({
            scope,
            nodes: [...nodes].sort((left, right) => compareReferences(left.reference, right.reference)),
        }),
        diagnostics: [],
    };
}
function desiredState(input, diagnostics) {
    if (!isRecord(input)) {
        diagnostics.push(diagnostic("RELATION_INPUT_INVALID", "$.desired", "Desired relationship state must be an object."));
        return undefined;
    }
    const hasRelationsWrapper = isRecord(input.relations);
    const source = hasRelationsWrapper ? input.relations : input;
    if (hasRelationsWrapper) {
        unknownProperties(input, new Set(["relations"]), "$.desired", diagnostics);
        unknownProperties(source, new Set(["parent", "dependsOn"]), "$.desired.relations", diagnostics);
    }
    else {
        unknownProperties(input, new Set(["parent", "dependsOn", "parentRepresentation", "dependsOnRepresentation"]), "$.desired", diagnostics);
    }
    const parentValue = source.parent;
    let parent;
    let parentRepresentation = "none";
    let parentRepresentationExplicit = false;
    if (isRecord(parentValue) && looksLikeIssueReference(parentValue)) {
        parent = normalizeReference(parentValue, "$.desired.parent", diagnostics);
        parentRepresentation = "native";
    }
    else if (isRecord(parentValue)) {
        unknownProperties(parentValue, new Set(["relation", "representation", "reference"]), "$.desired.relations.parent", diagnostics);
        if (parentValue.relation !== undefined && parentValue.relation !== "parent")
            diagnostics.push(diagnostic("RELATION_KIND_UNSUPPORTED", "$.desired.relations.parent.relation", "Only the parent relation is supported."));
        if (parentValue.representation !== undefined) {
            parentRepresentationExplicit = true;
            if (parentValue.representation !== "none" &&
                parentValue.representation !== "native" &&
                parentValue.representation !== "body-fallback")
                diagnostics.push(diagnostic("RELATION_INPUT_INVALID", "$.desired.relations.parent.representation", "Parent relation representation is invalid."));
            else
                parentRepresentation = parentValue.representation;
        }
        if (hasOwn(parentValue, "reference"))
            parent = normalizeReference(parentValue.reference, "$.desired.relations.parent.reference", diagnostics);
    }
    else if (parentValue !== undefined && parentValue !== null) {
        parent = normalizeReference(parentValue, "$.desired.parent", diagnostics);
        parentRepresentation = "native";
    }
    if (parentValue === undefined && source.parentRepresentation !== undefined) {
        parentRepresentationExplicit = true;
        if (source.parentRepresentation !== "none" &&
            source.parentRepresentation !== "native" &&
            source.parentRepresentation !== "body-fallback")
            diagnostics.push(diagnostic("RELATION_INPUT_INVALID", "$.desired.parentRepresentation", "Parent relation representation is invalid."));
        else
            parentRepresentation = source.parentRepresentation;
    }
    // Object relation syntax is intentionally equivalent to the compact
    // reference syntax.  A non-empty reference without an explicit
    // representation is therefore a native target, not an accidental `none`
    // value that is rejected later.
    if (parent !== undefined && !parentRepresentationExplicit)
        parentRepresentation = "native";
    const dependenciesValue = isRecord(source.dependsOn) ? source.dependsOn : source.dependsOn;
    let dependsOn;
    let dependsOnRepresentation = "none";
    let dependsOnRepresentationExplicit = false;
    if (isRecord(dependenciesValue) && !Array.isArray(dependenciesValue)) {
        unknownProperties(dependenciesValue, new Set(["relation", "representation", "references"]), "$.desired.relations.dependsOn", diagnostics);
        if (dependenciesValue.relation !== undefined && dependenciesValue.relation !== "dependsOn")
            diagnostics.push(diagnostic("RELATION_KIND_UNSUPPORTED", "$.desired.relations.dependsOn.relation", "Only the dependsOn relation is supported."));
        if (dependenciesValue.representation !== undefined) {
            dependsOnRepresentationExplicit = true;
            if (dependenciesValue.representation !== "none" &&
                dependenciesValue.representation !== "native" &&
                dependenciesValue.representation !== "body-fallback")
                diagnostics.push(diagnostic("RELATION_INPUT_INVALID", "$.desired.relations.dependsOn.representation", "dependsOn relation representation is invalid."));
            else
                dependsOnRepresentation = dependenciesValue.representation;
        }
        dependsOn = normalizeReferenceArray(dependenciesValue.references, "$.desired.relations.dependsOn.references", diagnostics);
    }
    else if (dependenciesValue !== undefined) {
        dependsOn = normalizeReferenceArray(dependenciesValue, "$.desired.dependsOn", diagnostics);
        dependsOnRepresentation = "native";
    }
    if (dependenciesValue === undefined && source.dependsOnRepresentation !== undefined) {
        dependsOnRepresentationExplicit = true;
        if (source.dependsOnRepresentation !== "none" &&
            source.dependsOnRepresentation !== "native" &&
            source.dependsOnRepresentation !== "body-fallback")
            diagnostics.push(diagnostic("RELATION_INPUT_INVALID", "$.desired.dependsOnRepresentation", "dependsOn relation representation is invalid."));
        else
            dependsOnRepresentation = source.dependsOnRepresentation;
    }
    if (dependsOn === undefined)
        dependsOn = [];
    if (dependsOn.length > 0 && !dependsOnRepresentationExplicit)
        dependsOnRepresentation = "native";
    if (parent === undefined && !parentRepresentationExplicit)
        parentRepresentation = "none";
    if (dependsOn.length === 0 && !dependsOnRepresentationExplicit)
        dependsOnRepresentation = "none";
    if (parentRepresentation === "none" && parent !== undefined)
        diagnostics.push(diagnostic("RELATION_INPUT_INVALID", "$.desired.relations.parent", "A non-empty parent relation cannot use the none representation."));
    if (dependsOnRepresentation === "none" && dependsOn.length > 0)
        diagnostics.push(diagnostic("RELATION_INPUT_INVALID", "$.desired.relations.dependsOn", "A non-empty dependsOn relation cannot use the none representation."));
    return { ...(parent === undefined ? {} : { parent }), dependsOn, parentRepresentation, dependsOnRepresentation };
}
function observedState(input, diagnostics, initiallyEmpty) {
    if (input === undefined && initiallyEmpty)
        return { parentStatus: "empty", dependsOnStatus: "empty", status: "complete", dependsOn: [] };
    if (!isRecord(input)) {
        diagnostics.push(diagnostic("RELATION_EVIDENCE_UNAVAILABLE", "$.observed", "Observed relationship evidence is required."));
        return undefined;
    }
    const source = isRecord(input.relations) ? input.relations : input;
    if (isRecord(input.relations)) {
        unknownProperties(input, new Set(["relations"]), "$.observed", diagnostics);
        unknownProperties(source, new Set(["parent", "dependsOn"]), "$.observed.relations", diagnostics);
        const parent = source.parent;
        const depends = source.dependsOn;
        if (!isRecord(parent) || !isRecord(depends)) {
            diagnostics.push(diagnostic("RELATION_EVIDENCE_UNAVAILABLE", "$.observed.relations", "Observed relation projections are required."));
            return undefined;
        }
        unknownProperties(parent, new Set(["representation", "reference"]), "$.observed.relations.parent", diagnostics);
        unknownProperties(depends, new Set(["representation", "references"]), "$.observed.relations.dependsOn", diagnostics);
        const parentStatus = parent.representation === "conflict" ? "conflict" : parent.representation === "none" ? "empty" : "present";
        const parentReference = hasOwn(parent, "reference")
            ? normalizeReference(parent.reference, "$.observed.relations.parent.reference", diagnostics)
            : undefined;
        const dependencyStatus = depends.representation === "conflict" ? "conflict" : depends.representation === "none" ? "empty" : "present";
        const dependencyReferences = normalizeReferenceArray(depends.references, "$.observed.relations.dependsOn.references", diagnostics) ?? [];
        if (parent.representation !== "none" && parentReference === undefined)
            diagnostics.push(diagnostic("RELATION_EVIDENCE_UNAVAILABLE", "$.observed.relations.parent.reference", "A represented parent relation requires an authoritative reference."));
        if (parent.representation === "none" && parentReference !== undefined)
            diagnostics.push(diagnostic("RELATION_INPUT_INVALID", "$.observed.relations.parent.reference", "An empty parent relation cannot contain a reference."));
        if (depends.representation !== "none" && dependencyReferences.length === 0)
            diagnostics.push(diagnostic("RELATION_EVIDENCE_UNAVAILABLE", "$.observed.relations.dependsOn.references", "A represented dependsOn relation requires authoritative references."));
        const status = parentStatus === "conflict" || dependencyStatus === "conflict" ? "ambiguous" : "complete";
        return {
            ...(parentReference === undefined ? {} : { parent: parentReference }),
            dependsOn: dependencyReferences,
            parentStatus,
            dependsOnStatus: dependencyStatus,
            status,
        };
    }
    const parent = hasOwn(source, "parent") && source.parent !== undefined && source.parent !== null
        ? normalizeReference(source.parent, "$.observed.parent", diagnostics)
        : undefined;
    const dependencyReferences = hasOwn(source, "dependsOn")
        ? normalizeReferenceArray(source.dependsOn, "$.observed.dependsOn", diagnostics)
        : [];
    if (dependencyReferences === undefined)
        return undefined;
    const parentStatus = source.parentStatus === "empty" ||
        source.parentStatus === "present" ||
        source.parentStatus === "unavailable" ||
        source.parentStatus === "conflict"
        ? source.parentStatus
        : parent === undefined
            ? "empty"
            : "present";
    const dependsOnStatus = source.dependsOnStatus === "empty" ||
        source.dependsOnStatus === "present" ||
        source.dependsOnStatus === "unavailable" ||
        source.dependsOnStatus === "conflict"
        ? source.dependsOnStatus
        : dependencyReferences.length === 0
            ? "empty"
            : "present";
    const status = source.status === "complete" || source.status === "unavailable" || source.status === "ambiguous"
        ? source.status
        : parentStatus === "unavailable" || dependsOnStatus === "unavailable"
            ? "unavailable"
            : parentStatus === "conflict" || dependsOnStatus === "conflict"
                ? "ambiguous"
                : "complete";
    if (parentStatus === "present" && parent === undefined)
        diagnostics.push(diagnostic("RELATION_EVIDENCE_UNAVAILABLE", "$.observed.parent", "A present parent observation requires an authoritative reference."));
    if (parentStatus === "empty" && parent !== undefined)
        diagnostics.push(diagnostic("RELATION_INPUT_INVALID", "$.observed.parent", "An empty parent observation cannot contain a reference."));
    if (dependsOnStatus === "present" && dependencyReferences.length === 0)
        diagnostics.push(diagnostic("RELATION_EVIDENCE_UNAVAILABLE", "$.observed.dependsOn", "A present dependsOn observation requires authoritative references."));
    if (dependsOnStatus === "empty" && dependencyReferences.length > 0)
        diagnostics.push(diagnostic("RELATION_INPUT_INVALID", "$.observed.dependsOn", "An empty dependsOn observation cannot contain references."));
    if (status === "complete" &&
        (parentStatus === "unavailable" ||
            parentStatus === "conflict" ||
            dependsOnStatus === "unavailable" ||
            dependsOnStatus === "conflict"))
        diagnostics.push(diagnostic("RELATION_EVIDENCE_UNAVAILABLE", "$.observed.status", "Complete relation status cannot contain unavailable or conflicting evidence."));
    return {
        ...(parent === undefined ? {} : { parent }),
        dependsOn: dependencyReferences,
        parentStatus,
        dependsOnStatus,
        status,
    };
}
function relationGraphWithDesired(subject, desired, graphInput, diagnostics) {
    if (graphInput === undefined)
        return undefined;
    const result = validateIssueRelationshipGraph(graphInput);
    diagnostics.push(...result.diagnostics);
    if (!result.valid || result.graph === undefined)
        return result;
    const subjectKey = issueReferenceKey(subject);
    const nodes = result.graph.nodes.filter((node) => issueReferenceKey(node.reference) !== subjectKey);
    nodes.push({
        reference: subject,
        ...(desired.parent === undefined ? {} : { parent: desired.parent }),
        dependsOn: desired.dependsOn,
    });
    const merged = validateIssueRelationshipGraph({ scope: result.graph.scope, nodes });
    diagnostics.push(...merged.diagnostics);
    return merged;
}
function repositoryDiagnostics(subject, desired, capabilities, diagnostics) {
    if (desired.parent !== undefined && issueReferenceKey(desired.parent) === issueReferenceKey(subject))
        diagnostics.push(diagnostic("RELATION_SELF", "$.desired.parent", "An Issue cannot be its own parent."));
    if (desired.dependsOn.some((reference) => issueReferenceKey(reference) === issueReferenceKey(subject)))
        diagnostics.push(diagnostic("RELATION_SELF", "$.desired.dependsOn", "An Issue cannot depend on itself."));
    if (desired.parentRepresentation === "native") {
        if (!nativeCapability(capabilities, "parent"))
            diagnostics.push(diagnostic("RELATION_CAPABILITY_UNSUPPORTED", "$.capabilities", "Native parent relationship capability is not declared."));
        else if (desired.parent !== undefined && !sameRepository(subject, desired.parent))
            diagnostics.push(diagnostic("RELATION_CROSS_REPOSITORY_UNSUPPORTED", "$.desired.parent", "Native parent relationships require the same repository identity."));
    }
    if (desired.dependsOnRepresentation === "native") {
        if (!nativeCapability(capabilities, "dependsOn"))
            diagnostics.push(diagnostic("RELATION_CAPABILITY_UNSUPPORTED", "$.capabilities", "Native blocked-by relationship capability is not declared."));
        for (const reference of desired.dependsOn)
            if (!sameRepository(subject, reference))
                diagnostics.push(diagnostic("RELATION_CROSS_REPOSITORY_UNSUPPORTED", "$.desired.dependsOn", "Native blocked-by relationships require the same repository identity."));
    }
}
function relationEffects(desired, observed) {
    const effects = [];
    if (desired.parentRepresentation === "native") {
        if (!sameReference(desired.parent, observed.parent)) {
            if (observed.parent !== undefined)
                effects.push({ kind: "CLEAR_PARENT_RELATION", previousParent: observed.parent });
            if (desired.parent !== undefined)
                effects.push({ kind: "SET_PARENT_RELATION", parent: desired.parent });
        }
    }
    else if (observed.parent !== undefined && desired.parent === undefined) {
        // A body-fallback desired state does not authorize native removal.
    }
    if (desired.dependsOnRepresentation === "native") {
        const desiredKeys = new Set(desired.dependsOn.map(issueReferenceKey));
        const observedKeys = new Set(observed.dependsOn.map(issueReferenceKey));
        for (const reference of observed.dependsOn
            .filter((entry) => !desiredKeys.has(issueReferenceKey(entry)))
            .sort(compareReferences))
            effects.push({ kind: "REMOVE_BLOCKED_BY_RELATION", reference });
        for (const reference of desired.dependsOn
            .filter((entry) => !observedKeys.has(issueReferenceKey(entry)))
            .sort(compareReferences))
            effects.push({ kind: "ADD_BLOCKED_BY_RELATION", reference });
    }
    return effects;
}
/**
 * Compute a deterministic native relationship delta.  `initiallyEmpty` is
 * intended only for a just-created Issue whose provider state cannot yet be
 * observed; update/reconciliation callers must supply authoritative evidence.
 */
export function tryPlanSemanticIssueRelations(input) {
    const diagnostics = [];
    if (!isRecord(input)) {
        diagnostics.push(diagnostic("RELATION_INPUT_INVALID", "$", "Relationship plan input must be an object."));
        return { valid: false, diagnostics };
    }
    unknownProperties(input, new Set([
        "subject",
        "desired",
        "observed",
        "capabilities",
        "provenance",
        "generation",
        "preconditions",
        "graph",
        "initiallyEmpty",
    ]), "$", diagnostics);
    const subject = normalizeReference(input.subject, "$.subject", diagnostics);
    const desired = desiredState(input.desired, diagnostics);
    const capabilities = normalizeCapabilities(input.capabilities, diagnostics);
    const observed = observedState(input.observed, diagnostics, input.initiallyEmpty === true);
    if (input.initiallyEmpty !== undefined && typeof input.initiallyEmpty !== "boolean")
        diagnostics.push(diagnostic("RELATION_INPUT_INVALID", "$.initiallyEmpty", "initiallyEmpty must be boolean."));
    if (subject === undefined ||
        desired === undefined ||
        capabilities === undefined ||
        observed === undefined ||
        diagnostics.length > 0)
        return { valid: false, diagnostics };
    if (observed.status === "ambiguous" ||
        observed.parentStatus === "unavailable" ||
        observed.dependsOnStatus === "unavailable")
        diagnostics.push(diagnostic("RELATION_CONFLICT", "$.observed", "Ambiguous or unavailable relation evidence cannot be mutated."));
    repositoryDiagnostics(subject, desired, capabilities, diagnostics);
    const effects = relationEffects(desired, observed);
    const graph = relationGraphWithDesired(subject, desired, input.graph, diagnostics);
    if (graph?.graph?.scope === "unavailable" && effects.length > 0)
        diagnostics.push(diagnostic("RELATION_EVIDENCE_UNAVAILABLE", "$.graph.scope", "Complete relationship graph evidence is required before applying a relation delta."));
    if (diagnostics.length > 0)
        return { valid: false, diagnostics };
    const plan = {
        version: SEMANTIC_ISSUE_RELATION_PLAN_VERSION,
        kind: "issue-relations",
        subject,
        desired,
        observed,
        capabilities,
        ...(input.provenance === undefined
            ? {}
            : { provenance: cloneImmutable(input.provenance) }),
        ...(input.generation === undefined
            ? {}
            : { generation: cloneImmutable(input.generation) }),
        preconditions: [{ kind: "RELATION_OBSERVATION_MATCH", observed }],
        effects,
    };
    return { valid: true, plan: cloneImmutable(plan), diagnostics: [] };
}
export function planSemanticIssueRelations(input) {
    const result = tryPlanSemanticIssueRelations(input);
    if (!result.valid || result.plan === undefined)
        throw new SemanticIssueRelationError(result.diagnostics);
    return result.plan;
}
export const tryPlanSemanticIssueRelationMutation = tryPlanSemanticIssueRelations;
export const planSemanticIssueRelationMutation = planSemanticIssueRelations;
export const createSemanticIssueRelationMutationPlan = planSemanticIssueRelations;
function validPlanState(value, path, diagnostics, desired) {
    if (!isRecord(value)) {
        diagnostics.push(diagnostic("RELATION_PLAN_INVALID", path, "Relationship plan state must be an object."));
        return false;
    }
    unknownProperties(value, RELATION_STATE_KEYS, path, diagnostics);
    const parent = hasOwn(value, "parent") ? normalizeReference(value.parent, `${path}.parent`, diagnostics) : undefined;
    const dependsOn = normalizeReferenceArray(value.dependsOn, `${path}.dependsOn`, diagnostics);
    if (desired) {
        if (value.parentRepresentation !== "none" &&
            value.parentRepresentation !== "native" &&
            value.parentRepresentation !== "body-fallback")
            diagnostics.push(diagnostic("RELATION_PLAN_INVALID", `${path}.parentRepresentation`, "Parent representation is invalid."));
        if (value.dependsOnRepresentation !== "none" &&
            value.dependsOnRepresentation !== "native" &&
            value.dependsOnRepresentation !== "body-fallback")
            diagnostics.push(diagnostic("RELATION_PLAN_INVALID", `${path}.dependsOnRepresentation`, "dependsOn representation is invalid."));
        if (value.parentRepresentation === "none" && parent !== undefined)
            diagnostics.push(diagnostic("RELATION_PLAN_INVALID", `${path}.parent`, "None parent representation cannot contain a reference."));
        if (value.dependsOnRepresentation === "none" && (dependsOn?.length ?? 0) > 0)
            diagnostics.push(diagnostic("RELATION_PLAN_INVALID", `${path}.dependsOn`, "None dependsOn representation cannot contain references."));
    }
    else {
        if (value.parentStatus !== "empty" &&
            value.parentStatus !== "present" &&
            value.parentStatus !== "unavailable" &&
            value.parentStatus !== "conflict")
            diagnostics.push(diagnostic("RELATION_PLAN_INVALID", `${path}.parentStatus`, "Parent observation status is invalid."));
        if (value.dependsOnStatus !== "empty" &&
            value.dependsOnStatus !== "present" &&
            value.dependsOnStatus !== "unavailable" &&
            value.dependsOnStatus !== "conflict")
            diagnostics.push(diagnostic("RELATION_PLAN_INVALID", `${path}.dependsOnStatus`, "dependsOn observation status is invalid."));
        if (value.status !== "complete" && value.status !== "unavailable" && value.status !== "ambiguous")
            diagnostics.push(diagnostic("RELATION_PLAN_INVALID", `${path}.status`, "Relationship observation status is invalid."));
    }
    return dependsOn !== undefined;
}
/** Validate a transported native relationship plan without provider I/O. */
export function validateSemanticIssueRelationMutationPlan(input) {
    const diagnostics = [];
    if (!isRecord(input)) {
        diagnostics.push(diagnostic("RELATION_PLAN_INVALID", "$", "Relationship mutation plan must be an object."));
        return { valid: false, diagnostics };
    }
    unknownProperties(input, RELATION_PLAN_KEYS, "$", diagnostics);
    if (input.version !== SEMANTIC_ISSUE_RELATION_PLAN_VERSION)
        diagnostics.push(diagnostic("RELATION_PLAN_INVALID", "$.version", "Relationship plan version is unsupported."));
    if (input.kind !== "issue-relations")
        diagnostics.push(diagnostic("RELATION_PLAN_INVALID", "$.kind", "Relationship plan kind is invalid."));
    const subject = normalizeReference(input.subject, "$.subject", diagnostics);
    validPlanState(input.desired, "$.desired", diagnostics, true);
    validPlanState(input.observed, "$.observed", diagnostics, false);
    const capabilities = normalizeCapabilities(input.capabilities, diagnostics);
    if (!Array.isArray(input.preconditions) || input.preconditions.length !== 1)
        diagnostics.push(diagnostic("RELATION_PLAN_INVALID", "$.preconditions", "Exactly one relation observation precondition is required."));
    else {
        const precondition = input.preconditions[0];
        if (!isRecord(precondition) || precondition.kind !== "RELATION_OBSERVATION_MATCH")
            diagnostics.push(diagnostic("RELATION_PLAN_INVALID", "$.preconditions[0]", "Relation observation precondition is invalid."));
        else {
            unknownProperties(precondition, new Set(["kind", "observed"]), "$.preconditions[0]", diagnostics);
            if (stableSerialize(precondition.observed) !== stableSerialize(input.observed))
                diagnostics.push(diagnostic("RELATION_PLAN_INVALID", "$.preconditions[0].observed", "Precondition observation must equal plan observation."));
        }
    }
    if (!Array.isArray(input.effects))
        diagnostics.push(diagnostic("RELATION_PLAN_INVALID", "$.effects", "Relation effects must be an array."));
    else {
        input.effects.forEach((effect, index) => {
            const path = `$.effects[${index}]`;
            if (!isRecord(effect) || !EFFECT_KINDS.has(effect.kind)) {
                diagnostics.push(diagnostic("RELATION_PLAN_INVALID", path, "Relation effect kind is invalid."));
                return;
            }
            const effectKeys = effect.kind === "SET_PARENT_RELATION"
                ? new Set(["kind", "parent"])
                : effect.kind === "CLEAR_PARENT_RELATION"
                    ? new Set(["kind", "previousParent"])
                    : new Set(["kind", "reference"]);
            unknownProperties(effect, effectKeys, path, diagnostics);
            if (effect.kind === "SET_PARENT_RELATION")
                normalizeReference(effect.parent, `${path}.parent`, diagnostics);
            if (effect.kind === "CLEAR_PARENT_RELATION" && hasOwn(effect, "previousParent"))
                normalizeReference(effect.previousParent, `${path}.previousParent`, diagnostics);
            if (effect.kind === "ADD_BLOCKED_BY_RELATION" || effect.kind === "REMOVE_BLOCKED_BY_RELATION")
                normalizeReference(effect.reference, `${path}.reference`, diagnostics);
        });
    }
    if (subject !== undefined && capabilities !== undefined && diagnostics.length === 0) {
        const semanticDiagnostics = [];
        const desired = desiredState(input.desired, semanticDiagnostics);
        const observed = observedState(input.observed, semanticDiagnostics, false);
        if (desired !== undefined && observed !== undefined) {
            repositoryDiagnostics(subject, desired, capabilities, semanticDiagnostics);
            const expectedEffects = relationEffects(desired, observed);
            if (stableSerialize(expectedEffects) !== stableSerialize(input.effects))
                semanticDiagnostics.push(diagnostic("RELATION_PLAN_INVALID", "$.effects", "Relation effects must be the deterministic delta from observed to desired state."));
        }
        for (const entry of semanticDiagnostics)
            diagnostics.push(diagnostic("RELATION_PLAN_INVALID", entry.path, entry.message));
    }
    if (diagnostics.length > 0 || subject === undefined || capabilities === undefined)
        return { valid: false, diagnostics };
    return { valid: true, plan: cloneImmutable(input), diagnostics: [] };
}
export function serializeSemanticIssueRelationMutationPlan(input) {
    const result = validateSemanticIssueRelationMutationPlan(input);
    if (!result.valid || result.plan === undefined)
        throw new SemanticIssueRelationError(result.diagnostics);
    return stableSerialize(result.plan);
}
export function deserializeSemanticIssueRelationMutationPlan(serialized) {
    let parsed;
    try {
        parsed = JSON.parse(serialized);
    }
    catch {
        throw new SemanticIssueRelationError([
            diagnostic("RELATION_PLAN_INVALID", "$", "Relationship plan must be valid JSON."),
        ]);
    }
    const result = validateSemanticIssueRelationMutationPlan(parsed);
    if (!result.valid || result.plan === undefined)
        throw new SemanticIssueRelationError(result.diagnostics);
    return result.plan;
}
export const serializeSemanticIssueRelationPlan = serializeSemanticIssueRelationMutationPlan;
export const parseSemanticIssueRelationMutationPlan = deserializeSemanticIssueRelationMutationPlan;
export const parseSemanticIssueRelationPlan = deserializeSemanticIssueRelationMutationPlan;
/** Build the compact observed state used by the relation executor. */
export function semanticIssueRelationStateFromObserved(observed) {
    const parent = observed.relations.parent;
    const dependsOn = observed.relations.dependsOn;
    const parentStatus = parent.representation === "conflict" ? "conflict" : parent.reference === undefined ? "empty" : "present";
    const dependsOnStatus = dependsOn.representation === "conflict" ? "conflict" : dependsOn.references.length === 0 ? "empty" : "present";
    return {
        ...(parent.reference === undefined ? {} : { parent: parent.reference }),
        dependsOn: dependsOn.references,
        parentStatus,
        dependsOnStatus,
        status: parentStatus === "conflict" || dependsOnStatus === "conflict" ? "ambiguous" : "complete",
    };
}
/** Compare relation states by stable Issue identity, never by mutable locators. */
export function sameSemanticIssueRelationState(left, right) {
    return sameReference(left.parent, right.parent) && sameReferences(left.dependsOn, right.dependsOn);
}
//# sourceMappingURL=semantic-issue-relations.js.map