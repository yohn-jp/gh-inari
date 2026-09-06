/**
 * Bounded local Executor for the Semantic Issue vertical slice.
 *
 * The Executor admits a Core-produced versioned plan, resolves the Issue
 * Canon again, checks its immutable generation, and hands the already
 * projected desired values to the trusted GitHub adapter. It never derives
 * title, body, metadata, or relations from CLI/MCP input.
 */
import { compileRepositoryEffectiveIssueContract } from "./artifact-contract-governance.js";
import { tryMaterializeSemanticArtifact } from "./contract/semantic-artifact.js";
import { createValidatedSemanticIssueArtifact } from "./github/capability.js";
import { SEMANTIC_ISSUE_MUTATION_PLAN_VERSION, serializeSemanticIssueMutationPlan, tryPlanSemanticIssue, validateSemanticIssueMutationPlan, } from "./semantic-issue-projection.js";
export const SEMANTIC_ISSUE_EXECUTOR_CONTRACT_VERSION = "1";
export const SEMANTIC_ISSUE_EXECUTION_OUTCOMES = Object.freeze(["verified", "failed"]);
/** Stable fail-closed error at the local Executor boundary. */
export class SemanticIssueExecutorError extends Error {
    code;
    diagnostics;
    evidence;
    details;
    constructor(code, message, diagnostics = [], details, evidence) {
        super(message);
        this.name = "SemanticIssueExecutorError";
        this.code = code;
        this.diagnostics = Object.freeze([...diagnostics]);
        this.details = details;
        this.evidence = evidence;
    }
}
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
function stableSerialize(value, stack = new WeakSet()) {
    if (value === null)
        return "null";
    if (typeof value === "string")
        return JSON.stringify(value);
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number")
        return Number.isFinite(value) ? String(value) : `number:${String(value)}`;
    if (typeof value === "undefined")
        return "undefined";
    if (typeof value !== "object")
        return `${typeof value}:${String(value)}`;
    if (stack.has(value))
        throw new TypeError("Cyclic JSON data is not supported.");
    stack.add(value);
    let serialized;
    if (Array.isArray(value)) {
        serialized = `[${value.map((entry) => stableSerialize(entry, stack)).join(",")}]`;
    }
    else if (isRecord(value)) {
        serialized = `{${Object.keys(value)
            .sort(compareStrings)
            .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], stack)}`)
            .join(",")}}`;
    }
    else {
        throw new TypeError("Only plain JSON objects are supported.");
    }
    stack.delete(value);
    return serialized;
}
function executionEvidence(outcome, status, issue, failure) {
    return Object.freeze({
        version: SEMANTIC_ISSUE_EXECUTOR_CONTRACT_VERSION,
        planVersion: SEMANTIC_ISSUE_MUTATION_PLAN_VERSION,
        outcome,
        effects: Object.freeze([{ kind: "CREATE_ISSUE", status }]),
        ...(issue === undefined ? {} : { issue: Object.freeze({ number: issue.number, url: issue.url }) }),
        ...(failure === undefined ? {} : { failure: Object.freeze(failure) }),
    });
}
function validCapabilities(value) {
    return (Array.isArray(value) &&
        value.every((capability) => typeof capability === "string" && capability.length > 0) &&
        new Set(value).size === value.length);
}
function compareCapabilities(left, right) {
    return stableSerialize([...left].sort()) === stableSerialize([...right].sort());
}
function effectiveGeneration(effective) {
    return effective.generation;
}
function planGeneration(plan) {
    return plan.generation;
}
function validateExecutionRequest(request) {
    if (!isRecord(request)) {
        throw new SemanticIssueExecutorError("SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID", "Semantic Issue execution request must be an object.");
    }
    const allowed = new Set(["version", "plan", "input", "artifact", "selector", "capabilities"]);
    if (Object.keys(request).some((key) => !allowed.has(key))) {
        throw new SemanticIssueExecutorError("SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID", "Semantic Issue execution request contains an unsupported property.");
    }
    if (request.version !== SEMANTIC_ISSUE_EXECUTOR_CONTRACT_VERSION) {
        throw new SemanticIssueExecutorError("SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID", "Semantic Issue execution request version is unsupported.", [
            diagnostic("SEMANTIC_ISSUE_EXECUTION_REQUEST_VERSION_INVALID", "$.version", "Execution request version is unsupported."),
        ]);
    }
    if (request.selector !== undefined && (typeof request.selector !== "string" || request.selector.length === 0)) {
        throw new SemanticIssueExecutorError("SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID", "Semantic Issue execution selector is invalid.", [diagnostic("SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID", "$.selector", "Selector must be a non-empty string.")]);
    }
    if (request.capabilities !== undefined && !validCapabilities(request.capabilities)) {
        throw new SemanticIssueExecutorError("SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID", "Semantic Issue execution capabilities are invalid.", [
            diagnostic("SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID", "$.capabilities", "Capabilities must be unique strings."),
        ]);
    }
}
function planInvalid(diagnostics) {
    return new SemanticIssueExecutorError("SEMANTIC_ISSUE_EXECUTION_PLAN_INVALID", "The Semantic Issue mutation plan is invalid and cannot be executed.", diagnostics);
}
function revalidationFailed(diagnostics) {
    return new SemanticIssueExecutorError("SEMANTIC_ISSUE_EXECUTION_REVALIDATION_FAILED", "Semantic Issue execution-time Core revalidation failed.", diagnostics);
}
function observedProjection(issue) {
    return Object.freeze({
        kind: "issue",
        number: issue.number,
        url: issue.url,
        state: issue.state,
        title: issue.title,
        body: issue.body,
        labels: Object.freeze([...issue.labels]),
        assignees: Object.freeze([...issue.assignees]),
        ...(issue.milestone === undefined ? {} : { milestone: issue.milestone.title }),
    });
}
function unsupportedDesiredState(desired) {
    const diagnostics = [];
    const metadata = desired.metadata;
    if (hasOwn(metadata, "milestone")) {
        diagnostics.push(diagnostic("SEMANTIC_ISSUE_DESIRED_STATE_UNSUPPORTED", "$.desired.metadata.milestone", "The local Executor cannot faithfully apply and verify desired milestone state."));
    }
    if (desired.relations.parent.representation === "native") {
        diagnostics.push(diagnostic("SEMANTIC_ISSUE_DESIRED_STATE_UNSUPPORTED", "$.desired.relations.parent", "The local Executor cannot faithfully apply and verify a native parent relation."));
    }
    if (desired.relations.dependsOn.representation === "native") {
        diagnostics.push(diagnostic("SEMANTIC_ISSUE_DESIRED_STATE_UNSUPPORTED", "$.desired.relations.dependsOn", "The local Executor cannot faithfully apply and verify a native blocked-by relation."));
    }
    return diagnostics;
}
function projectionMismatches(desired, observed) {
    const diagnostics = [];
    const compare = (path, expected, actual) => {
        if (stableSerialize(expected) !== stableSerialize(actual)) {
            diagnostics.push(diagnostic("SEMANTIC_ISSUE_PROJECTION_MISMATCH", path, "Observed Issue differs from the desired projection."));
        }
    };
    const compareStringSet = (path, expected, actual) => {
        compare(path, [...expected].sort(compareStrings), Array.isArray(actual) ? [...actual].sort(compareStrings) : actual);
    };
    compare("$.desired.title", desired.title, observed.title);
    compare("$.desired.body", desired.body, observed.body);
    if (hasOwn(desired.metadata, "labels"))
        compareStringSet("$.desired.metadata.labels", desired.metadata.labels ?? [], observed.labels);
    if (hasOwn(desired.metadata, "assignees"))
        compareStringSet("$.desired.metadata.assignees", desired.metadata.assignees ?? [], observed.assignees);
    if (hasOwn(desired.metadata, "milestone"))
        compare("$.desired.metadata.milestone", desired.metadata.milestone, observed.milestone?.title);
    return diagnostics;
}
function semanticMutationArtifact(plan) {
    const desired = plan.desired;
    return createValidatedSemanticIssueArtifact({
        kind: "issue",
        title: desired.title,
        body: desired.body,
        provenance: desired.provenance,
        ...(desired.metadata.labels === undefined ? {} : { labels: desired.metadata.labels }),
        ...(desired.metadata.assignees === undefined ? {} : { assignees: desired.metadata.assignees }),
    });
}
/**
 * Local/development deployment of the logical Semantic Artifact Executor.
 * The class is plan-centered and never accepts CLI-owned Issue projection or
 * repository-policy rules.
 */
export class SemanticIssueExecutor {
    #adapter;
    #selector;
    #capabilities;
    constructor(options) {
        this.#adapter = options.adapter;
        this.#selector = options.selector;
        this.#capabilities = options.capabilities;
    }
    async execute(request) {
        validateExecutionRequest(request);
        const planResult = validateSemanticIssueMutationPlan(request.plan);
        if (!planResult.valid || planResult.plan === undefined) {
            throw planInvalid(planResult.violations);
        }
        const plan = planResult.plan;
        const selector = request.selector ?? this.#selector;
        const requestedCapabilities = request.capabilities ?? this.#capabilities;
        if (requestedCapabilities !== undefined && !compareCapabilities(requestedCapabilities, plan.capabilities)) {
            throw new SemanticIssueExecutorError("SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID", "Execution capabilities do not match the versioned plan.", [
                diagnostic("SEMANTIC_ISSUE_EXECUTION_CAPABILITIES_MISMATCH", "$.capabilities", "Capabilities must equal the plan capabilities."),
            ]);
        }
        // Reject semantics the adapter cannot faithfully apply and reread before
        // any Canon or GitHub mutation call. Unsupported values are never dropped.
        const unsupported = unsupportedDesiredState(plan.desired);
        if (unsupported.length > 0)
            throw planInvalid(unsupported);
        // Compile against the authoritative default branch/tree/blob immediately
        // before admission. A successful CLI preflight is not authorization.
        let effective;
        try {
            effective = await compileRepositoryEffectiveIssueContract(this.#adapter, selector, {
                capabilities: plan.capabilities,
            });
        }
        catch (error) {
            throw revalidationFailed([
                diagnostic("SEMANTIC_ISSUE_CANON_RESOLUTION_FAILED", "$.generation", error instanceof Error ? error.message : "Authoritative Issue Canon could not be resolved."),
            ]);
        }
        if (stableSerialize(planGeneration(plan)) !== stableSerialize(effectiveGeneration(effective))) {
            throw new SemanticIssueExecutorError("SEMANTIC_ISSUE_EXECUTION_PRECONDITION_FAILED", "Repository governance changed after the plan was produced.", [
                diagnostic("SEMANTIC_ISSUE_GOVERNANCE_GENERATION_MISMATCH", "$.generation", "Plan generation does not match the current repository Canon generation."),
            ], {
                expectedTreeSha: planGeneration(plan).treeSha,
                actualTreeSha: effectiveGeneration(effective).treeSha,
            });
        }
        let admittedPlan = plan;
        if (request.input !== undefined) {
            const materialization = tryMaterializeSemanticArtifact(effective, request.input);
            if (!materialization.valid || materialization.artifact === undefined) {
                throw revalidationFailed(materialization.violations);
            }
            const replanned = tryPlanSemanticIssue({ artifact: materialization.artifact, capabilities: plan.capabilities });
            if (!replanned.valid || replanned.plan === undefined)
                throw revalidationFailed(replanned.violations);
            if (serializeSemanticIssueMutationPlan(replanned.plan) !== serializeSemanticIssueMutationPlan(plan)) {
                throw new SemanticIssueExecutorError("SEMANTIC_ISSUE_EXECUTION_PRECONDITION_FAILED", "The supplied plan does not match execution-time Core materialization.", [
                    diagnostic("SEMANTIC_ISSUE_PLAN_MISMATCH", "$.plan", "Versioned plan differs from the plan produced by the current Core contract."),
                ]);
            }
            admittedPlan = replanned.plan;
        }
        if (request.artifact !== undefined) {
            const replanned = tryPlanSemanticIssue({ artifact: request.artifact, capabilities: plan.capabilities });
            if (!replanned.valid || replanned.plan === undefined)
                throw revalidationFailed(replanned.violations);
            if (serializeSemanticIssueMutationPlan(replanned.plan) !== serializeSemanticIssueMutationPlan(plan)) {
                throw new SemanticIssueExecutorError("SEMANTIC_ISSUE_EXECUTION_PRECONDITION_FAILED", "The supplied plan does not match the materialized Semantic Artifact.", [
                    diagnostic("SEMANTIC_ISSUE_PLAN_ARTIFACT_MISMATCH", "$.artifact", "Plan artifact identity is not bound to the supplied artifact."),
                ]);
            }
            admittedPlan = replanned.plan;
        }
        const generationPrecondition = admittedPlan.preconditions.find((precondition) => precondition.kind === "GOVERNANCE_GENERATION_MATCH");
        if (generationPrecondition === undefined ||
            stableSerialize(generationPrecondition.generation) !== stableSerialize(effectiveGeneration(effective))) {
            throw new SemanticIssueExecutorError("SEMANTIC_ISSUE_EXECUTION_PRECONDITION_FAILED", "The Semantic Issue plan governance precondition is not satisfied.", [
                diagnostic("SEMANTIC_ISSUE_GOVERNANCE_PRECONDITION_FAILED", "$.preconditions", "Current repository state does not satisfy the plan generation precondition."),
            ]);
        }
        const artifact = semanticMutationArtifact(admittedPlan);
        let created;
        try {
            created = await this.#adapter.createSemanticIssue(artifact);
        }
        catch {
            throw new SemanticIssueExecutorError("SEMANTIC_ISSUE_EXECUTION_EFFECT_FAILED", "GitHub Issue creation failed.", [diagnostic("SEMANTIC_ISSUE_EFFECT_FAILED", "$.effects[0]", "CREATE_ISSUE did not succeed.")], undefined, executionEvidence("failed", "failed", undefined, {
                code: "SEMANTIC_ISSUE_EFFECT_FAILED",
                message: "CREATE_ISSUE did not succeed.",
            }));
        }
        let after;
        try {
            after = await this.#adapter.getIssue(created.number);
        }
        catch {
            throw new SemanticIssueExecutorError("SEMANTIC_ISSUE_EXECUTION_READ_FAILED", "Created Issue could not be reread for postcondition verification.", [
                diagnostic("SEMANTIC_ISSUE_POSTCONDITION_READ_FAILED", "$.projection", "Created Issue state could not be reread."),
            ], undefined, executionEvidence("failed", "succeeded", { number: created.number, url: created.url }, {
                code: "SEMANTIC_ISSUE_POSTCONDITION_READ_FAILED",
                message: "Created Issue state could not be reread.",
            }));
        }
        const mismatches = projectionMismatches(admittedPlan.desired, after);
        if (mismatches.length > 0) {
            throw new SemanticIssueExecutorError("SEMANTIC_ISSUE_EXECUTION_PROJECTION_VERIFICATION_FAILED", "Observed Issue does not satisfy the desired Semantic Issue projection.", mismatches, undefined, executionEvidence("failed", "succeeded", { number: after.number, url: after.url }, {
                code: "SEMANTIC_ISSUE_PROJECTION_MISMATCH",
                message: "Observed Issue differs from the desired projection.",
            }));
        }
        return Object.freeze({
            plan: admittedPlan,
            projection: observedProjection(after),
            evidence: executionEvidence("verified", "succeeded", { number: after.number, url: after.url }),
        });
    }
}
/** Explicit alias for callers naming the local deployment. */
export const LocalSemanticIssueExecutor = SemanticIssueExecutor;
//# sourceMappingURL=semantic-issue-executor.js.map