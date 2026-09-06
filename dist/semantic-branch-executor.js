/**
 * Bounded local Executor for a Core-produced Semantic Branch mutation plan.
 *
 * Admission is plan-centered: the Executor re-resolves the repository Canon,
 * revalidates the generation and semantic intent, observes the current refs,
 * applies only the explicit Core effect, and verifies the resulting ref.  It
 * never derives a branch name or source from Change, Issue, or free-form input.
 */
import { createHash } from "node:crypto";
import { ArtifactContractResolutionError, } from "./artifact-contract-governance.js";
import { compileEffectiveArtifactContract } from "./contract/effective-artifact-contract.js";
import { ArtifactContractValidationError, parseArtifactContract } from "./contract/artifact-contract.js";
import { tryMaterializeSemanticArtifact } from "./contract/semantic-artifact.js";
import { SEMANTIC_BRANCH_MUTATION_PLAN_VERSION, serializeSemanticBranchMutationPlan, tryPlanSemanticBranch, validateSemanticBranchMutationPlan, } from "./semantic-branch-projection.js";
export const SEMANTIC_BRANCH_EXECUTOR_CONTRACT_VERSION = "1";
export const SEMANTIC_BRANCH_EXECUTION_OUTCOMES = Object.freeze(["verified", "failed"]);
export class SemanticBranchExecutorError extends Error {
    code;
    diagnostics;
    evidence;
    details;
    constructor(code, message, diagnostics = [], details, evidence) {
        super(message);
        this.name = "SemanticBranchExecutorError";
        this.code = code;
        this.diagnostics = Object.freeze([...diagnostics]);
        this.details = details;
        this.evidence = evidence;
    }
}
const BRANCH_CANON_PATH = ".github/inari/canon/branch.json";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
    const serialized = Array.isArray(value)
        ? `[${value.map((entry) => stableSerialize(entry, stack)).join(",")}]`
        : isRecord(value)
            ? `{${Object.keys(value)
                .sort()
                .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], stack)}`)
                .join(",")}}`
            : (() => {
                throw new TypeError("Only plain JSON objects are supported.");
            })();
    stack.delete(value);
    return serialized;
}
function effectiveGeneration(effective) {
    return stableSerialize(effective.generation);
}
function planGeneration(plan) {
    return stableSerialize(plan.generation);
}
function executionEvidence(outcome, status, branch, failure) {
    return Object.freeze({
        version: SEMANTIC_BRANCH_EXECUTOR_CONTRACT_VERSION,
        planVersion: SEMANTIC_BRANCH_MUTATION_PLAN_VERSION,
        outcome,
        effects: Object.freeze([{ kind: "CREATE_BRANCH", status }]),
        ...(branch === undefined ? {} : { branch: Object.freeze({ name: branch.name, sha: branch.sha }) }),
        ...(failure === undefined ? {} : { failure: Object.freeze(failure) }),
    });
}
function validateExecutionRequest(request) {
    if (!isRecord(request)) {
        throw new SemanticBranchExecutorError("SEMANTIC_BRANCH_EXECUTION_REQUEST_INVALID", "Semantic branch execution request must be an object.");
    }
    const allowed = new Set(["version", "plan", "input", "artifact", "selector"]);
    if (Object.keys(request).some((key) => !allowed.has(key))) {
        throw new SemanticBranchExecutorError("SEMANTIC_BRANCH_EXECUTION_REQUEST_INVALID", "Semantic branch execution request contains an unsupported property.");
    }
    if (request.version !== SEMANTIC_BRANCH_EXECUTOR_CONTRACT_VERSION) {
        throw new SemanticBranchExecutorError("SEMANTIC_BRANCH_EXECUTION_REQUEST_INVALID", "Semantic branch execution request version is unsupported.", [
            diagnostic("SEMANTIC_BRANCH_EXECUTION_REQUEST_VERSION_INVALID", "$.version", "Execution request version is unsupported."),
        ]);
    }
    if (request.selector !== undefined && (typeof request.selector !== "string" || request.selector.length === 0)) {
        throw new SemanticBranchExecutorError("SEMANTIC_BRANCH_EXECUTION_REQUEST_INVALID", "Semantic branch execution selector is invalid.", [diagnostic("SEMANTIC_BRANCH_EXECUTION_REQUEST_INVALID", "$.selector", "Selector must be a non-empty string.")]);
    }
}
function planInvalid(diagnostics) {
    return new SemanticBranchExecutorError("SEMANTIC_BRANCH_EXECUTION_PLAN_INVALID", "The Semantic Branch mutation plan is invalid and cannot be executed.", diagnostics);
}
function revalidationFailed(diagnostics) {
    return new SemanticBranchExecutorError("SEMANTIC_BRANCH_EXECUTION_REVALIDATION_FAILED", "Semantic Branch execution-time Core revalidation failed.", diagnostics);
}
function sourceProvenance(context, ref, treeSha, entry, source) {
    return {
        authority: "repository-default-branch",
        repository: {
            host: context.hostname,
            owner: context.owner,
            name: context.name,
            nameWithOwner: context.nameWithOwner,
            ...(context.repositoryId === undefined ? {} : { repositoryId: context.repositoryId }),
        },
        ref,
        treeSha,
        source: {
            path: entry.path,
            ref,
            sha: entry.sha,
            digest: createHash("sha256").update(source, "utf8").digest("hex"),
        },
    };
}
async function compileRepositoryEffectiveBranchContract(adapter, selector) {
    const context = await adapter.resolveRepositoryContext();
    const ref = await adapter.getRepositoryDefaultBranch();
    const tree = await adapter.getRepositoryTree(ref);
    if (selector !== undefined && selector !== BRANCH_CANON_PATH && selector !== "branch" && selector !== "default") {
        const diagnostic = {
            code: "ARTIFACT_CONTRACT_NOT_FOUND",
            path: "$.selector",
            message: `Branch Artifact Contract selector "${selector}" is not supported.`,
        };
        throw new ArtifactContractResolutionError("ARTIFACT_CONTRACT_NOT_FOUND", diagnostic.path, diagnostic.message, { repository: context.nameWithOwner, ref, path: BRANCH_CANON_PATH }, [diagnostic]);
    }
    const entry = tree.entries.find((candidate) => candidate.path === BRANCH_CANON_PATH && candidate.type === "blob");
    if (entry === undefined) {
        throw new ArtifactContractResolutionError("ARTIFACT_CONTRACT_NOT_FOUND", "$.source", `Branch Artifact Contract Canon "${BRANCH_CANON_PATH}" was not found for ${context.nameWithOwner}.`, { repository: context.nameWithOwner, ref, path: BRANCH_CANON_PATH });
    }
    const source = await adapter.getRepositoryBlob(entry.sha);
    let raw;
    try {
        raw = JSON.parse(source);
    }
    catch {
        throw new ArtifactContractResolutionError("ARTIFACT_CONTRACT_SOURCE_INVALID", BRANCH_CANON_PATH, `Artifact Contract Canon "${BRANCH_CANON_PATH}" is not valid JSON.`);
    }
    try {
        const contract = parseArtifactContract(raw);
        if (contract.kind !== "branch") {
            throw new ArtifactContractResolutionError("ARTIFACT_CONTRACT_KIND_INVALID", "$.kind", `Artifact Contract Canon "${BRANCH_CANON_PATH}" must declare kind "branch".`);
        }
        return compileEffectiveArtifactContract(contract, {
            provenance: sourceProvenance(context, ref, tree.sha, entry, source),
        });
    }
    catch (error) {
        if (error instanceof ArtifactContractResolutionError)
            throw error;
        if (error instanceof ArtifactContractValidationError) {
            throw new ArtifactContractResolutionError("ARTIFACT_CONTRACT_SOURCE_INVALID", BRANCH_CANON_PATH, `Artifact Contract Canon "${BRANCH_CANON_PATH}" failed Core validation.`, { violations: error.violations }, error.violations);
        }
        throw new ArtifactContractResolutionError("ARTIFACT_CONTRACT_SOURCE_INVALID", BRANCH_CANON_PATH, `Artifact Contract Canon "${BRANCH_CANON_PATH}" failed Core compilation.`);
    }
}
export class SemanticBranchExecutor {
    #adapter;
    #selector;
    constructor(options) {
        this.#adapter = options.adapter;
        this.#selector = options.selector;
    }
    async execute(request) {
        validateExecutionRequest(request);
        const planResult = validateSemanticBranchMutationPlan(request.plan);
        if (!planResult.valid || planResult.plan === undefined)
            throw planInvalid(planResult.violations);
        const plan = planResult.plan;
        const selector = request.selector ?? this.#selector;
        const effective = await compileRepositoryEffectiveBranchContract(this.#adapter, selector);
        if (planGeneration(plan) !== effectiveGeneration(effective)) {
            throw new SemanticBranchExecutorError("SEMANTIC_BRANCH_EXECUTION_PRECONDITION_FAILED", "Repository governance changed after the plan was produced.", [
                diagnostic("SEMANTIC_BRANCH_GOVERNANCE_GENERATION_MISMATCH", "$.generation", "Plan generation does not match the current repository Canon generation."),
            ], { expectedTreeSha: plan.generation.treeSha, actualTreeSha: effective.generation.treeSha });
        }
        let admittedPlan = plan;
        if (request.input !== undefined) {
            const materialization = tryMaterializeSemanticArtifact(effective, request.input);
            if (!materialization.valid || materialization.artifact === undefined)
                throw revalidationFailed(materialization.violations);
            const replanned = tryPlanSemanticBranch({ artifact: materialization.artifact });
            if (!replanned.valid || replanned.plan === undefined)
                throw revalidationFailed(replanned.violations);
            if (serializeSemanticBranchMutationPlan(replanned.plan) !== serializeSemanticBranchMutationPlan(plan)) {
                throw new SemanticBranchExecutorError("SEMANTIC_BRANCH_EXECUTION_PRECONDITION_FAILED", "The supplied plan does not match execution-time Core materialization.", [diagnostic("SEMANTIC_BRANCH_PLAN_MISMATCH", "$.plan", "Versioned plan differs from the current Core plan.")]);
            }
            admittedPlan = replanned.plan;
        }
        else if (request.artifact !== undefined) {
            const replanned = tryPlanSemanticBranch({ artifact: request.artifact });
            if (!replanned.valid || replanned.plan === undefined)
                throw revalidationFailed(replanned.violations);
            if (serializeSemanticBranchMutationPlan(replanned.plan) !== serializeSemanticBranchMutationPlan(plan)) {
                throw new SemanticBranchExecutorError("SEMANTIC_BRANCH_EXECUTION_PRECONDITION_FAILED", "The supplied plan does not match the materialized Semantic Artifact.", [
                    diagnostic("SEMANTIC_BRANCH_PLAN_ARTIFACT_MISMATCH", "$.artifact", "Plan artifact identity is not bound to the supplied artifact."),
                ]);
            }
            admittedPlan = replanned.plan;
        }
        const targetPrecondition = admittedPlan.preconditions.find((entry) => entry.kind === "BRANCH_TARGET_ABSENT");
        if (targetPrecondition === undefined) {
            throw planInvalid([
                diagnostic("SEMANTIC_BRANCH_TARGET_PRECONDITION_MISSING", "$.preconditions", "Target absence is required before creation."),
            ]);
        }
        let source;
        let target;
        try {
            source = await this.#adapter.findBranch(admittedPlan.desired.source);
            target = await this.#adapter.findBranch(targetPrecondition.name);
        }
        catch {
            throw new SemanticBranchExecutorError("SEMANTIC_BRANCH_EXECUTION_READ_FAILED", "Unable to establish current branch state before mutation.", [
                diagnostic("SEMANTIC_BRANCH_TARGET_READ_FAILED", "$.preconditions", "Current branch state could not be established."),
            ]);
        }
        if (source === undefined) {
            throw new SemanticBranchExecutorError("SEMANTIC_BRANCH_EXECUTION_PRECONDITION_FAILED", "The planned source branch does not exist.", [diagnostic("SEMANTIC_BRANCH_SOURCE_ABSENT", "$.desired.source", "Source ref precondition is not satisfied.")]);
        }
        if (target !== undefined) {
            throw new SemanticBranchExecutorError("SEMANTIC_BRANCH_EXECUTION_PRECONDITION_FAILED", "A branch already exists for the planned target name.", [
                diagnostic("SEMANTIC_BRANCH_TARGET_EXISTS", "$.preconditions", "Target-absence precondition is not satisfied."),
            ]);
        }
        let created;
        try {
            created = await this.#adapter.createBranch(admittedPlan.desired.name, admittedPlan.desired.source);
        }
        catch {
            throw new SemanticBranchExecutorError("SEMANTIC_BRANCH_EXECUTION_EFFECT_FAILED", "GitHub branch creation failed.", [diagnostic("SEMANTIC_BRANCH_EFFECT_FAILED", "$.effects[0]", "CREATE_BRANCH did not succeed.")], undefined, executionEvidence("failed", "failed", undefined, {
                code: "SEMANTIC_BRANCH_EFFECT_FAILED",
                message: "CREATE_BRANCH did not succeed.",
            }));
        }
        let after;
        try {
            after = await this.#adapter.findBranch(admittedPlan.desired.name);
        }
        catch {
            throw new SemanticBranchExecutorError("SEMANTIC_BRANCH_EXECUTION_READ_FAILED", "Created branch could not be reread for postcondition verification.", [
                diagnostic("SEMANTIC_BRANCH_POSTCONDITION_READ_FAILED", "$.projection", "Created branch state could not be reread."),
            ], undefined, executionEvidence("failed", "succeeded", created, {
                code: "SEMANTIC_BRANCH_POSTCONDITION_READ_FAILED",
                message: "Created branch state could not be reread.",
            }));
        }
        if (after === undefined || after.name !== admittedPlan.desired.name || after.sha !== source.sha) {
            throw new SemanticBranchExecutorError("SEMANTIC_BRANCH_EXECUTION_PROJECTION_VERIFICATION_FAILED", "Observed branch does not satisfy the desired Semantic Branch projection.", [
                diagnostic("SEMANTIC_BRANCH_PROJECTION_MISMATCH", "$.projection", "Observed branch differs from the desired projection."),
            ], undefined, executionEvidence("failed", "succeeded", after ?? created, {
                code: "SEMANTIC_BRANCH_PROJECTION_MISMATCH",
                message: "Observed branch differs from the desired projection.",
            }));
        }
        return Object.freeze({
            plan: admittedPlan,
            projection: Object.freeze({
                kind: "branch",
                name: after.name,
                source: admittedPlan.desired.source,
                sha: after.sha,
            }),
            evidence: executionEvidence("verified", "succeeded", after),
        });
    }
}
/** Explicit alias for callers naming the local deployment. */
export const LocalSemanticBranchExecutor = SemanticBranchExecutor;
//# sourceMappingURL=semantic-branch-executor.js.map