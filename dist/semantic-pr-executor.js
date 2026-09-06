/**
 * Bounded local Executor for the Semantic PR vertical slice.
 *
 * The Executor admits a Core-produced versioned plan, resolves the repository
 * Canon again, checks the immutable generation and current target state, then
 * hands the already-projected desired values to the existing GitHub mutation
 * adapter.  It does not derive branch/title/body values and it is deliberately
 * independent from the Change control plane.
 */
import { compileRepositoryEffectivePullRequestContract } from "./artifact-contract-governance.js";
import { tryMaterializeSemanticArtifact } from "./contract/semantic-artifact.js";
import { createValidatedSemanticPullRequestArtifact } from "./github/capability.js";
import { SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION, serializeSemanticPullRequestMutationPlan, tryPlanSemanticPullRequest, validateSemanticPullRequestMutationPlan, } from "./semantic-pr-projection.js";
export const SEMANTIC_PULL_REQUEST_EXECUTOR_CONTRACT_VERSION = "1";
export const SEMANTIC_PULL_REQUEST_EXECUTION_OUTCOMES = Object.freeze(["verified", "failed"]);
/** Stable fail-closed error at the local Executor boundary. */
export class SemanticPullRequestExecutorError extends Error {
    code;
    diagnostics;
    evidence;
    details;
    constructor(code, message, diagnostics = [], details, evidence) {
        super(message);
        this.name = "SemanticPullRequestExecutorError";
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
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], stack)}`)
            .join(",")}}`;
    }
    else {
        throw new TypeError("Only plain JSON objects are supported.");
    }
    stack.delete(value);
    return serialized;
}
function executionEvidence(outcome, status, pullRequest, failure) {
    return Object.freeze({
        version: SEMANTIC_PULL_REQUEST_EXECUTOR_CONTRACT_VERSION,
        planVersion: SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION,
        outcome,
        effects: Object.freeze([{ kind: "CREATE_PULL_REQUEST", status }]),
        ...(pullRequest === undefined
            ? {}
            : { pullRequest: Object.freeze({ number: pullRequest.number, url: pullRequest.url }) }),
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
        throw new SemanticPullRequestExecutorError("SEMANTIC_PR_EXECUTION_REQUEST_INVALID", "Semantic PR execution request must be an object.");
    }
    const allowed = new Set(["version", "plan", "input", "artifact", "selector", "capabilities"]);
    if (Object.keys(request).some((key) => !allowed.has(key))) {
        throw new SemanticPullRequestExecutorError("SEMANTIC_PR_EXECUTION_REQUEST_INVALID", "Semantic PR execution request contains an unsupported property.");
    }
    if (request.version !== SEMANTIC_PULL_REQUEST_EXECUTOR_CONTRACT_VERSION) {
        throw new SemanticPullRequestExecutorError("SEMANTIC_PR_EXECUTION_REQUEST_INVALID", "Semantic PR execution request version is unsupported.", [
            diagnostic("SEMANTIC_PR_EXECUTION_REQUEST_VERSION_INVALID", "$.version", "Execution request version is unsupported."),
        ]);
    }
    if (request.selector !== undefined && (typeof request.selector !== "string" || request.selector.length === 0)) {
        throw new SemanticPullRequestExecutorError("SEMANTIC_PR_EXECUTION_REQUEST_INVALID", "Semantic PR execution selector is invalid.", [diagnostic("SEMANTIC_PR_EXECUTION_REQUEST_INVALID", "$.selector", "Selector must be a non-empty string.")]);
    }
    if (request.capabilities !== undefined && !validCapabilities(request.capabilities)) {
        throw new SemanticPullRequestExecutorError("SEMANTIC_PR_EXECUTION_REQUEST_INVALID", "Semantic PR execution capabilities are invalid.", [diagnostic("SEMANTIC_PR_EXECUTION_REQUEST_INVALID", "$.capabilities", "Capabilities must be unique strings.")]);
    }
}
function planInvalid(diagnostics) {
    return new SemanticPullRequestExecutorError("SEMANTIC_PR_EXECUTION_PLAN_INVALID", "The Semantic PR mutation plan is invalid and cannot be executed.", diagnostics);
}
function revalidationFailed(diagnostics) {
    return new SemanticPullRequestExecutorError("SEMANTIC_PR_EXECUTION_REVALIDATION_FAILED", "Semantic PR execution-time Core revalidation failed.", diagnostics);
}
function observedProjection(pullRequest) {
    return Object.freeze({
        kind: "pull_request",
        number: pullRequest.number,
        url: pullRequest.url,
        state: pullRequest.state,
        title: pullRequest.title,
        body: pullRequest.body,
        head: pullRequest.head,
        base: pullRequest.base,
        draft: pullRequest.draft,
        ...(pullRequest.maintainerCanModify === undefined ? {} : { maintainerCanModify: pullRequest.maintainerCanModify }),
    });
}
function projectionMismatches(desired, observed) {
    const diagnostics = [];
    const compare = (path, expected, actual) => {
        if (stableSerialize(expected) !== stableSerialize(actual)) {
            diagnostics.push(diagnostic("SEMANTIC_PR_PROJECTION_MISMATCH", path, "Observed pull request differs from the desired projection."));
        }
    };
    compare("$.desired.title", desired.title, observed.title);
    compare("$.desired.head", desired.head, observed.head);
    compare("$.desired.base", desired.base, observed.base);
    compare("$.desired.body", desired.body, observed.body);
    if (hasOwn(desired.metadata, "draft"))
        compare("$.desired.metadata.draft", desired.metadata.draft, observed.draft);
    if (hasOwn(desired.metadata, "maintainerCanModify"))
        compare("$.desired.metadata.maintainerCanModify", desired.metadata.maintainerCanModify, observed.maintainerCanModify);
    return diagnostics;
}
function semanticMutationArtifact(plan) {
    const desired = plan.desired;
    return createValidatedSemanticPullRequestArtifact({
        kind: "pull_request",
        title: desired.title,
        body: desired.body,
        head: desired.head,
        base: desired.base,
        provenance: desired.provenance,
        ...(desired.metadata.draft === undefined ? {} : { draft: desired.metadata.draft }),
        ...(desired.metadata.maintainerCanModify === undefined
            ? {}
            : { maintainerCanModify: desired.metadata.maintainerCanModify }),
    });
}
/**
 * Local/development deployment of the logical Semantic Artifact Executor.
 * The class is intentionally plan-centered and never accepts CLI-owned PR
 * title, branch, body, or relation rules.
 */
export class SemanticPullRequestExecutor {
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
        const planResult = validateSemanticPullRequestMutationPlan(request.plan);
        if (!planResult.valid || planResult.plan === undefined) {
            throw planInvalid(planResult.violations);
        }
        const plan = planResult.plan;
        const selector = request.selector ?? this.#selector;
        const requestedCapabilities = request.capabilities ?? this.#capabilities;
        if (requestedCapabilities !== undefined && !compareCapabilities(requestedCapabilities, plan.capabilities)) {
            throw new SemanticPullRequestExecutorError("SEMANTIC_PR_EXECUTION_REQUEST_INVALID", "Execution capabilities do not match the versioned plan.", [
                diagnostic("SEMANTIC_PR_EXECUTION_CAPABILITIES_MISMATCH", "$.capabilities", "Capabilities must equal the plan capabilities."),
            ]);
        }
        // Compile against the authoritative default branch/tree/blob immediately
        // before admission.  A successful CLI preflight is not authorization.
        const effective = await compileRepositoryEffectivePullRequestContract(this.#adapter, selector, {
            capabilities: plan.capabilities,
        });
        if (stableSerialize(planGeneration(plan)) !== stableSerialize(effectiveGeneration(effective))) {
            throw new SemanticPullRequestExecutorError("SEMANTIC_PR_EXECUTION_PRECONDITION_FAILED", "Repository governance changed after the plan was produced.", [
                diagnostic("SEMANTIC_PR_GOVERNANCE_GENERATION_MISMATCH", "$.generation", "Plan generation does not match the current repository Canon generation."),
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
            const replanned = tryPlanSemanticPullRequest({
                artifact: materialization.artifact,
                capabilities: plan.capabilities,
            });
            if (!replanned.valid || replanned.plan === undefined)
                throw revalidationFailed(replanned.violations);
            if (serializeSemanticPullRequestMutationPlan(replanned.plan) !== serializeSemanticPullRequestMutationPlan(plan)) {
                throw new SemanticPullRequestExecutorError("SEMANTIC_PR_EXECUTION_PRECONDITION_FAILED", "The supplied plan does not match execution-time Core materialization.", [
                    diagnostic("SEMANTIC_PR_PLAN_MISMATCH", "$.plan", "Versioned plan differs from the plan produced by the current Core contract."),
                ]);
            }
            admittedPlan = replanned.plan;
        }
        else if (request.artifact !== undefined) {
            const replanned = tryPlanSemanticPullRequest({ artifact: request.artifact, capabilities: plan.capabilities });
            if (!replanned.valid || replanned.plan === undefined)
                throw revalidationFailed(replanned.violations);
            if (serializeSemanticPullRequestMutationPlan(replanned.plan) !== serializeSemanticPullRequestMutationPlan(plan)) {
                throw new SemanticPullRequestExecutorError("SEMANTIC_PR_EXECUTION_PRECONDITION_FAILED", "The supplied plan does not match the materialized Semantic Artifact.", [
                    diagnostic("SEMANTIC_PR_PLAN_ARTIFACT_MISMATCH", "$.artifact", "Plan artifact identity is not bound to the supplied artifact."),
                ]);
            }
            admittedPlan = replanned.plan;
        }
        const targetPrecondition = admittedPlan.preconditions.find((precondition) => precondition.kind === "PULL_REQUEST_TARGET_ABSENT");
        if (targetPrecondition === undefined) {
            throw new SemanticPullRequestExecutorError("SEMANTIC_PR_EXECUTION_PLAN_INVALID", "The Semantic PR plan has no target-absence precondition.", [
                diagnostic("SEMANTIC_PR_TARGET_PRECONDITION_MISSING", "$.preconditions", "Target absence is required before creation."),
            ]);
        }
        let existing;
        try {
            existing = await this.#adapter.listPullRequests(targetPrecondition.head, targetPrecondition.base);
        }
        catch {
            throw new SemanticPullRequestExecutorError("SEMANTIC_PR_EXECUTION_READ_FAILED", "Unable to read current pull-request target state before mutation.", [
                diagnostic("SEMANTIC_PR_TARGET_READ_FAILED", "$.preconditions", "Current target state could not be established."),
            ]);
        }
        if (existing.length > 0) {
            throw new SemanticPullRequestExecutorError("SEMANTIC_PR_EXECUTION_PRECONDITION_FAILED", "A pull request already exists for the planned head and base.", [diagnostic("SEMANTIC_PR_TARGET_EXISTS", "$.preconditions", "Target-absence precondition is not satisfied.")], { existingCount: existing.length });
        }
        const artifact = semanticMutationArtifact(admittedPlan);
        let created;
        try {
            created = await this.#adapter.createSemanticPullRequest(artifact);
        }
        catch {
            throw new SemanticPullRequestExecutorError("SEMANTIC_PR_EXECUTION_EFFECT_FAILED", "GitHub pull-request creation failed.", [diagnostic("SEMANTIC_PR_EFFECT_FAILED", "$.effects[0]", "CREATE_PULL_REQUEST did not succeed.")], undefined, executionEvidence("failed", "failed", undefined, {
                code: "SEMANTIC_PR_EFFECT_FAILED",
                message: "CREATE_PULL_REQUEST did not succeed.",
            }));
        }
        let after;
        try {
            after = await this.#adapter.getPullRequest(created.number);
        }
        catch {
            throw new SemanticPullRequestExecutorError("SEMANTIC_PR_EXECUTION_READ_FAILED", "Created pull request could not be reread for postcondition verification.", [
                diagnostic("SEMANTIC_PR_POSTCONDITION_READ_FAILED", "$.projection", "Created pull request state could not be reread."),
            ], undefined, executionEvidence("failed", "succeeded", { number: created.number, url: created.url }, {
                code: "SEMANTIC_PR_POSTCONDITION_READ_FAILED",
                message: "Created pull request state could not be reread.",
            }));
        }
        const mismatches = projectionMismatches(admittedPlan.desired, after);
        if (mismatches.length > 0) {
            throw new SemanticPullRequestExecutorError("SEMANTIC_PR_EXECUTION_PROJECTION_VERIFICATION_FAILED", "Observed pull request does not satisfy the desired Semantic PR projection.", mismatches, undefined, executionEvidence("failed", "succeeded", { number: after.number, url: after.url }, {
                code: "SEMANTIC_PR_PROJECTION_MISMATCH",
                message: "Observed pull request differs from the desired projection.",
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
export const LocalSemanticPullRequestExecutor = SemanticPullRequestExecutor;
//# sourceMappingURL=semantic-pr-executor.js.map