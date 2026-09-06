/**
 * Native MCP tools for the semantic pull-request Core boundary.
 *
 * This module owns only protocol translation. Repository policy, effective
 * contract compilation, materialization, projection, and planning remain in
 * the existing Core modules. The same registration function can therefore be
 * used by stdio and a future hosted transport without changing semantics.
 */
import { z } from "zod";
import { ArtifactContractResolutionError, compileRepositoryEffectiveArtifactContract, compileRepositoryEffectiveBranchContract, compileRepositoryEffectiveIssueContract, compileRepositoryEffectivePullRequestContract, } from "../artifact-contract-governance.js";
import { EffectiveArtifactContractCompilationError, } from "../contract/effective-artifact-contract.js";
import { SemanticArtifactMaterializationError, tryMaterializeSemanticArtifact, } from "../contract/semantic-artifact.js";
import { SemanticBranchProjectionError, tryPlanSemanticBranch, } from "../semantic-branch-projection.js";
import { compareSemanticBranchProjection, tryObserveSemanticBranch } from "../semantic-branch-observation.js";
import { SemanticIssueProjectionError, tryPlanSemanticIssue, } from "../semantic-issue-projection.js";
import { compareSemanticIssueProjection, tryObserveSemanticIssue } from "../semantic-issue-observation.js";
import { SemanticPullRequestProjectionError, tryPlanSemanticPullRequest, } from "../semantic-pr-projection.js";
import { compareSemanticPullRequestProjection, tryObserveSemanticPullRequest } from "../semantic-pr-observation.js";
import { GitHubAdapter, GitHubIssueRelationObservationAdapter, isGitHubAdapterError, } from "../github/index.js";
import { GITHUB_ISSUE_PROJECTION_CAPABILITIES } from "../semantic-issue-projection.js";
/** Version of the Inari-owned MCP tool/input/output contract. */
export const INARI_MCP_TOOL_CONTRACT_VERSION = "1";
export const INARI_MCP_TOOL_NAMES = Object.freeze([
    "inari_issue_contract",
    "inari_issue_materialize",
    "inari_issue_plan",
    "inari_issue_observe",
    "inari_issue_drift",
    "inari_branch_contract",
    "inari_branch_materialize",
    "inari_branch_plan",
    "inari_branch_observe",
    "inari_branch_drift",
    "inari_pr_contract",
    "inari_pr_materialize",
    "inari_pr_plan",
    "inari_pr_observe",
    "inari_pr_drift",
]);
const MAX_STRING_LENGTH = 1_024;
const MAX_CAPABILITIES = 64;
const MAX_INPUT_PROPERTIES = 200;
function boundedString(description) {
    return z
        .string()
        .min(1)
        .max(MAX_STRING_LENGTH)
        .refine((value) => !/[\u0000\r\n]/u.test(value), { message: "String contains an unsafe control character." })
        .describe(description);
}
const repositorySchema = boundedString("Optional GitHub repository override.");
const templateSchema = boundedString("Optional repository Canon/template selector.");
const capabilitySchema = boundedString("Opaque target capability identifier.");
const artifactNumberSchema = z
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .describe("GitHub Issue or pull-request number.");
const branchNameSchema = boundedString("Git branch name to observe.");
const branchSourceSchema = boundedString("Explicit Git branch source evidence.");
const inputValueSchema = z
    .record(z.string().min(1).max(MAX_STRING_LENGTH), z.unknown())
    .refine((value) => Object.keys(value).length <= MAX_INPUT_PROPERTIES, {
    message: `input must contain at most ${MAX_INPUT_PROPERTIES} properties`,
})
    .describe("Caller-supplied semantic values. Core validates the closed-world contract.");
const commonRequestShape = {
    repository: repositorySchema.optional(),
    template: templateSchema.optional(),
    capabilities: z.array(capabilitySchema).max(MAX_CAPABILITIES).optional(),
};
/** Input schema shared by contract discovery and the two semantic operations. */
export const semanticPullRequestContractInputSchema = z.strictObject(commonRequestShape);
/** Input schema for semantic PR materialization. */
export const semanticPullRequestMaterializeInputSchema = z.strictObject({
    ...commonRequestShape,
    input: inputValueSchema,
});
/** Input schema for semantic PR plan preview. */
export const semanticPullRequestPlanInputSchema = z.strictObject({
    ...commonRequestShape,
    input: inputValueSchema,
});
/** Issue and Branch use the same closed-world request shape as PR. */
export const semanticIssueContractInputSchema = z.strictObject(commonRequestShape);
export const semanticIssueMaterializeInputSchema = z.strictObject({ ...commonRequestShape, input: inputValueSchema });
export const semanticIssuePlanInputSchema = z.strictObject({ ...commonRequestShape, input: inputValueSchema });
export const semanticBranchContractInputSchema = z.strictObject(commonRequestShape);
export const semanticBranchMaterializeInputSchema = z.strictObject({ ...commonRequestShape, input: inputValueSchema });
export const semanticBranchPlanInputSchema = z.strictObject({ ...commonRequestShape, input: inputValueSchema });
/** Input schemas for bounded provider observation and Core drift comparison. */
export const semanticIssueObserveInputSchema = z.strictObject({
    ...commonRequestShape,
    number: artifactNumberSchema,
});
export const semanticIssueDriftInputSchema = z.strictObject({
    ...commonRequestShape,
    number: artifactNumberSchema,
    input: inputValueSchema,
});
export const semanticBranchObserveInputSchema = z.strictObject({
    ...commonRequestShape,
    name: branchNameSchema,
    source: branchSourceSchema,
});
export const semanticBranchDriftInputSchema = z.strictObject({
    ...commonRequestShape,
    input: inputValueSchema,
});
export const semanticPullRequestObserveInputSchema = z.strictObject({
    ...commonRequestShape,
    number: artifactNumberSchema,
});
export const semanticPullRequestDriftInputSchema = z.strictObject({
    ...commonRequestShape,
    number: artifactNumberSchema,
    input: inputValueSchema,
});
const READ_ONLY = Object.freeze({
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
});
/**
 * Core result fields are intentionally explicit so malformed adapter output
 * fails closed. The adapter never rewrites or narrows the nested Effective
 * Contract, Artifact, or Plan.
 */
export const semanticPullRequestOutputSchema = z
    .object({
    ok: z.boolean(),
    valid: z.boolean(),
    phase: z.enum(["contract", "materialization", "projection", "observation", "comparison"]).optional(),
    version: z.string().optional(),
    artifactContractVersion: z.string().optional(),
    kind: z.string().optional(),
    id: z.string().optional(),
    contract: z.unknown().optional(),
    effectiveContract: z.unknown().optional(),
    inputSchema: z.unknown().optional(),
    properties: z.unknown().optional(),
    fields: z.unknown().optional(),
    derivations: z.unknown().optional(),
    dependencyGraph: z.unknown().optional(),
    evaluationOrder: z.unknown().optional(),
    capabilities: z.unknown().optional(),
    artifact: z.unknown().optional(),
    plan: z.unknown().optional(),
    desired: z.unknown().optional(),
    observed: z.unknown().optional(),
    comparison: z.unknown().optional(),
    drift: z.array(z.unknown()).optional(),
    observationDiagnostics: z.array(z.unknown()).optional(),
    provenance: z.unknown().optional(),
    generation: z.unknown().optional(),
    diagnostics: z.array(z.unknown()).optional(),
    violations: z.array(z.unknown()).optional(),
    preview: z.boolean().optional(),
    mutation: z.boolean().optional(),
})
    .strict();
export const semanticIssueOutputSchema = semanticPullRequestOutputSchema;
export const semanticBranchOutputSchema = semanticPullRequestOutputSchema;
function adapterFor(requestRepository, dependencies) {
    if (dependencies.adapter !== undefined)
        return dependencies.adapter;
    const repository = requestRepository ?? dependencies.repository;
    const options = {
        ...(dependencies.repositoryRoot === undefined ? {} : { cwd: dependencies.repositoryRoot }),
        ...(repository === undefined ? {} : { repository }),
    };
    return (dependencies.createAdapter ?? ((adapterOptions) => new GitHubAdapter(adapterOptions)))(options);
}
/** Resolve the repository Canon through the existing repository/Core boundary. */
export async function resolveSemanticPullRequestContract(input, dependencies = {}) {
    const adapter = adapterFor(input.repository, dependencies);
    const options = input.capabilities === undefined ? {} : { capabilities: input.capabilities };
    return compileRepositoryEffectivePullRequestContract(adapter, input.template, options);
}
/** Resolve any supported Artifact Contract through the repository/Core boundary. */
async function resolveSemanticArtifactContract(kind, input, dependencies) {
    const adapter = adapterFor(input.repository, dependencies);
    return compileSemanticArtifactContract(kind, input, adapter);
}
async function compileSemanticArtifactContract(kind, input, adapter) {
    const options = input.capabilities === undefined ? {} : { capabilities: input.capabilities };
    if (kind === "issue")
        return compileRepositoryEffectiveIssueContract(adapter, input.template, options);
    if (kind === "branch")
        return compileRepositoryEffectiveBranchContract(adapter, input.template, options);
    return compileRepositoryEffectiveArtifactContract(adapter, kind, input.template, options);
}
/** Resolve the repository Canon for a semantic Issue. */
export async function resolveSemanticIssueContract(input, dependencies = {}) {
    return resolveSemanticArtifactContract("issue", input, dependencies);
}
/** Resolve the repository Canon for a semantic Branch. */
export async function resolveSemanticBranchContract(input, dependencies = {}) {
    return resolveSemanticArtifactContract("branch", input, dependencies);
}
function contractProjection(effectiveContract) {
    return {
        ok: true,
        valid: true,
        version: effectiveContract.version,
        artifactContractVersion: effectiveContract.artifactContractVersion,
        kind: effectiveContract.kind,
        id: effectiveContract.id,
        contract: effectiveContract.contract,
        effectiveContract,
        inputSchema: effectiveContract.inputSchema,
        properties: effectiveContract.properties,
        ...(effectiveContract.fields === undefined ? {} : { fields: effectiveContract.fields }),
        derivations: effectiveContract.derivations,
        dependencyGraph: effectiveContract.dependencyGraph,
        evaluationOrder: effectiveContract.evaluationOrder,
        provenance: effectiveContract.provenance,
        generation: effectiveContract.generation,
        capabilities: effectiveContract.capabilities,
    };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedErrorMessage(error) {
    const message = error instanceof Error ? error.message : "Semantic PR Core operation failed.";
    return message.length > 4_096 ? `${message.slice(0, 4_096)}…` : message;
}
function boundedDiagnostics(diagnostics) {
    return diagnostics.slice(0, 64).map((diagnostic) => {
        if (!isRecord(diagnostic))
            return diagnostic;
        const message = diagnostic.message;
        if (typeof message !== "string" || message.length <= 4_096)
            return diagnostic;
        return { ...diagnostic, message: `${message.slice(0, 4_096)}…` };
    });
}
function diagnosticsForError(error) {
    if (error instanceof ArtifactContractResolutionError)
        return boundedDiagnostics(error.diagnostics);
    if (error instanceof SemanticArtifactMaterializationError)
        return boundedDiagnostics(error.violations);
    if (error instanceof SemanticPullRequestProjectionError)
        return boundedDiagnostics(error.violations);
    if (error instanceof SemanticIssueProjectionError)
        return boundedDiagnostics(error.violations);
    if (error instanceof SemanticBranchProjectionError)
        return boundedDiagnostics(error.violations);
    if (isGitHubAdapterError(error)) {
        return [
            {
                code: error.code,
                path: typeof error.details.path === "string" ? error.details.path : "$",
                message: boundedErrorMessage(error),
            },
        ];
    }
    if (error instanceof EffectiveArtifactContractCompilationError) {
        return [{ code: "EFFECTIVE_CONTRACT_INVALID", path: "$", message: boundedErrorMessage(error) }];
    }
    return [{ code: "CORE_OPERATION_FAILED", path: "$", message: boundedErrorMessage(error) }];
}
function failure(phase, diagnostics) {
    const normalized = Array.isArray(diagnostics) ? boundedDiagnostics(diagnostics) : diagnosticsForError(diagnostics);
    return {
        ok: false,
        valid: false,
        phase,
        diagnostics: normalized,
        violations: normalized,
    };
}
function result(data, summary) {
    return {
        structuredContent: data,
        content: [{ type: "text", text: summary }],
    };
}
function observationRepository(context) {
    return {
        host: context.hostname,
        ...(context.repositoryId === undefined ? {} : { repositoryId: context.repositoryId }),
        repository: context.nameWithOwner,
    };
}
function issueRelationCapabilities(effectiveContract) {
    const capabilities = new Set(effectiveContract.capabilities);
    return {
        parent: capabilities.has(GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeParentRelation),
        blockedBy: capabilities.has(GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeBlockedByRelation) ||
            capabilities.has(GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeDependsOnRelation),
    };
}
async function observeIssueFromGitHub(adapter, effectiveContract, number) {
    const [issue, context] = await Promise.all([adapter.readIssue(number), adapter.resolveRepositoryContext()]);
    const relations = new GitHubIssueRelationObservationAdapter(adapter, context, issueRelationCapabilities(effectiveContract));
    const [parent, dependsOn] = await Promise.all([relations.observeParent(number), relations.observeBlockedBy(number)]);
    const nativeRelations = {};
    if (parent.kind === "present" && parent.reference !== undefined)
        nativeRelations.parent = { native: parent.reference };
    if (dependsOn.kind === "present")
        nativeRelations.dependsOn = { native: dependsOn.references };
    const observed = tryObserveSemanticIssue({
        issue,
        repository: observationRepository(context),
        ...(Object.keys(nativeRelations).length === 0 ? {} : { relations: nativeRelations }),
    });
    return {
        result: observed,
        observationDiagnostics: [...parent.diagnostics, ...dependsOn.diagnostics],
    };
}
async function observePullRequestFromGitHub(adapter, number) {
    const [pullRequest, context] = await Promise.all([
        adapter.readPullRequest(number),
        adapter.resolveRepositoryContext(),
    ]);
    return {
        result: tryObserveSemanticPullRequest({
            pullRequest,
            repository: observationRepository(context),
        }),
    };
}
async function handleIssueObserve(input, dependencies) {
    const adapter = adapterFor(input.repository, dependencies);
    let effectiveContract;
    try {
        effectiveContract = await compileSemanticArtifactContract("issue", input, adapter);
        const envelope = await observeIssueFromGitHub(adapter, effectiveContract, input.number);
        if (!envelope.result.valid || envelope.result.projection === undefined) {
            return result({
                ...failure("observation", envelope.result.violations),
                effectiveContract,
                ...(envelope.observationDiagnostics.length === 0
                    ? {}
                    : { observationDiagnostics: [...envelope.observationDiagnostics] }),
            }, "Semantic Issue observation failed; see diagnostics.");
        }
        return result({
            ok: true,
            valid: true,
            effectiveContract,
            observed: envelope.result.projection,
            ...(envelope.observationDiagnostics.length === 0
                ? {}
                : { observationDiagnostics: [...envelope.observationDiagnostics] }),
        }, "Observed the semantic Issue through the bounded GitHub adapter.");
    }
    catch (error) {
        return result({ ...failure("observation", error), ...(effectiveContract === undefined ? {} : { effectiveContract }) }, "Semantic Issue observation failed; see diagnostics.");
    }
}
async function handleIssueDrift(input, dependencies) {
    const adapter = adapterFor(input.repository, dependencies);
    let effectiveContract;
    try {
        effectiveContract = await compileSemanticArtifactContract("issue", input, adapter);
        const materialization = tryMaterializeSemanticArtifact(effectiveContract, input.input);
        if (!materialization.valid || materialization.artifact === undefined)
            return result({ ...failure("materialization", materialization.violations), effectiveContract }, "Semantic Issue materialization failed; see diagnostics.");
        const planned = tryPlanSemanticIssue({
            artifact: materialization.artifact,
            capabilities: effectiveContract.capabilities,
        });
        if (!planned.valid || planned.plan === undefined)
            return result({ ...failure("projection", planned.violations), effectiveContract, artifact: materialization.artifact }, "Semantic Issue projection failed; see diagnostics.");
        const envelope = await observeIssueFromGitHub(adapter, effectiveContract, input.number);
        if (!envelope.result.valid || envelope.result.projection === undefined)
            return result({
                ...failure("observation", envelope.result.violations),
                effectiveContract,
                desired: planned.plan.desired,
                artifact: materialization.artifact,
                ...(envelope.observationDiagnostics.length === 0
                    ? {}
                    : { observationDiagnostics: [...envelope.observationDiagnostics] }),
            }, "Semantic Issue observation failed; see diagnostics.");
        const comparison = compareSemanticIssueProjection(planned.plan.desired, envelope.result.projection);
        return result({
            ok: comparison.valid,
            valid: comparison.valid,
            phase: "comparison",
            effectiveContract,
            artifact: materialization.artifact,
            desired: planned.plan.desired,
            observed: envelope.result.projection,
            comparison,
            drift: [...comparison.drift],
            ...(envelope.observationDiagnostics.length === 0
                ? {}
                : { observationDiagnostics: [...envelope.observationDiagnostics] }),
        }, comparison.valid ? "Semantic Issue has no observed drift." : "Semantic Issue drift detected; see comparison.");
    }
    catch (error) {
        return result({ ...failure("observation", error), ...(effectiveContract === undefined ? {} : { effectiveContract }) }, "Semantic Issue drift observation failed; see diagnostics.");
    }
}
async function handlePullRequestObserve(input, dependencies) {
    const adapter = adapterFor(input.repository, dependencies);
    let effectiveContract;
    try {
        effectiveContract = await compileSemanticArtifactContract("pull_request", input, adapter);
        const envelope = await observePullRequestFromGitHub(adapter, input.number);
        if (!envelope.result.valid || envelope.result.projection === undefined)
            return result({ ...failure("observation", envelope.result.violations), effectiveContract }, "Semantic PR observation failed; see diagnostics.");
        return result({ ok: true, valid: true, effectiveContract, observed: envelope.result.projection }, "Observed the semantic PR through the bounded GitHub adapter.");
    }
    catch (error) {
        return result({ ...failure("observation", error), ...(effectiveContract === undefined ? {} : { effectiveContract }) }, "Semantic PR observation failed; see diagnostics.");
    }
}
async function handlePullRequestDrift(input, dependencies) {
    const adapter = adapterFor(input.repository, dependencies);
    let effectiveContract;
    try {
        effectiveContract = await compileSemanticArtifactContract("pull_request", input, adapter);
        const materialization = tryMaterializeSemanticArtifact(effectiveContract, input.input);
        if (!materialization.valid || materialization.artifact === undefined)
            return result({ ...failure("materialization", materialization.violations), effectiveContract }, "Semantic PR materialization failed; see diagnostics.");
        const planned = tryPlanSemanticPullRequest({
            artifact: materialization.artifact,
            capabilities: effectiveContract.capabilities,
        });
        if (!planned.valid || planned.plan === undefined)
            return result({ ...failure("projection", planned.violations), effectiveContract, artifact: materialization.artifact }, "Semantic PR projection failed; see diagnostics.");
        const envelope = await observePullRequestFromGitHub(adapter, input.number);
        if (!envelope.result.valid || envelope.result.projection === undefined)
            return result({
                ...failure("observation", envelope.result.violations),
                effectiveContract,
                desired: planned.plan.desired,
                artifact: materialization.artifact,
            }, "Semantic PR observation failed; see diagnostics.");
        const comparison = compareSemanticPullRequestProjection(planned.plan.desired, envelope.result.projection);
        return result({
            ok: comparison.valid,
            valid: comparison.valid,
            phase: "comparison",
            effectiveContract,
            artifact: materialization.artifact,
            desired: planned.plan.desired,
            observed: envelope.result.projection,
            comparison,
            drift: [...comparison.drift],
        }, comparison.valid ? "Semantic PR has no observed drift." : "Semantic PR drift detected; see comparison.");
    }
    catch (error) {
        return result({ ...failure("observation", error), ...(effectiveContract === undefined ? {} : { effectiveContract }) }, "Semantic PR drift observation failed; see diagnostics.");
    }
}
async function handleBranchObserve(input, dependencies) {
    const adapter = adapterFor(input.repository, dependencies);
    let effectiveContract;
    try {
        effectiveContract = await compileSemanticArtifactContract("branch", input, adapter);
        const branch = await adapter.findBranch(input.name);
        if (branch === undefined)
            return result({
                ...failure("observation", new Error(`Branch "${input.name}" was not found.`)),
                effectiveContract,
            }, "Semantic Branch observation failed; see diagnostics.");
        const observed = tryObserveSemanticBranch({
            ref: { ref: branch.ref, object: { type: "commit", sha: branch.sha } },
            source: input.source,
            generation: effectiveContract.generation,
        });
        if (!observed.valid || observed.projection === undefined)
            return result({ ...failure("observation", observed.violations), effectiveContract }, "Semantic Branch observation failed; see diagnostics.");
        return result({ ok: true, valid: true, effectiveContract, observed: observed.projection }, "Observed the semantic Branch through the bounded GitHub adapter.");
    }
    catch (error) {
        return result({ ...failure("observation", error), ...(effectiveContract === undefined ? {} : { effectiveContract }) }, "Semantic Branch observation failed; see diagnostics.");
    }
}
async function handleBranchDrift(input, dependencies) {
    const adapter = adapterFor(input.repository, dependencies);
    let effectiveContract;
    try {
        effectiveContract = await compileSemanticArtifactContract("branch", input, adapter);
        const materialization = tryMaterializeSemanticArtifact(effectiveContract, input.input);
        if (!materialization.valid || materialization.artifact === undefined)
            return result({ ...failure("materialization", materialization.violations), effectiveContract }, "Semantic Branch materialization failed; see diagnostics.");
        const planned = tryPlanSemanticBranch({ artifact: materialization.artifact });
        if (!planned.valid || planned.plan === undefined)
            return result({ ...failure("projection", planned.violations), effectiveContract, artifact: materialization.artifact }, "Semantic Branch projection failed; see diagnostics.");
        const branch = await adapter.findBranch(planned.plan.desired.name);
        if (branch === undefined)
            return result({
                ...failure("observation", new Error(`Branch "${planned.plan.desired.name}" was not found.`)),
                effectiveContract,
                artifact: materialization.artifact,
                desired: planned.plan.desired,
            }, "Semantic Branch observation failed; see diagnostics.");
        const observed = tryObserveSemanticBranch({
            ref: { ref: branch.ref, object: { type: "commit", sha: branch.sha } },
            source: planned.plan.desired.source,
            generation: effectiveContract.generation,
        });
        if (!observed.valid || observed.projection === undefined)
            return result({
                ...failure("observation", observed.violations),
                effectiveContract,
                artifact: materialization.artifact,
                desired: planned.plan.desired,
            }, "Semantic Branch observation failed; see diagnostics.");
        const comparison = compareSemanticBranchProjection(planned.plan.desired, observed.projection);
        return result({
            ok: comparison.valid,
            valid: comparison.valid,
            phase: "comparison",
            effectiveContract,
            artifact: materialization.artifact,
            desired: planned.plan.desired,
            observed: observed.projection,
            comparison,
            drift: [...comparison.drift],
        }, comparison.valid ? "Semantic Branch has no observed drift." : "Semantic Branch drift detected; see comparison.");
    }
    catch (error) {
        return result({ ...failure("observation", error), ...(effectiveContract === undefined ? {} : { effectiveContract }) }, "Semantic Branch drift observation failed; see diagnostics.");
    }
}
async function handleContract(input, dependencies) {
    try {
        return result(contractProjection(await resolveSemanticPullRequestContract(input, dependencies)), "Resolved the Effective PR Artifact Contract.");
    }
    catch (error) {
        return result(failure("contract", error), "Semantic PR contract resolution failed; see diagnostics.");
    }
}
async function handleMaterialize(input, dependencies) {
    let effectiveContract;
    try {
        effectiveContract = await resolveSemanticPullRequestContract(input, dependencies);
    }
    catch (error) {
        return result(failure("contract", error), "Semantic PR contract resolution failed; see diagnostics.");
    }
    const materialization = tryMaterializeSemanticArtifact(effectiveContract, input.input);
    if (!materialization.valid || materialization.artifact === undefined) {
        return result({ ...failure("materialization", materialization.violations), effectiveContract }, "Semantic PR materialization failed; see diagnostics.");
    }
    const artifact = materialization.artifact;
    return result({
        ok: true,
        valid: true,
        effectiveContract,
        artifact,
        provenance: artifact.provenance,
        generation: artifact.generation,
    }, "Materialized the semantic PR artifact.");
}
async function handlePlan(input, dependencies) {
    let effectiveContract;
    try {
        effectiveContract = await resolveSemanticPullRequestContract(input, dependencies);
    }
    catch (error) {
        return result(failure("contract", error), "Semantic PR contract resolution failed; see diagnostics.");
    }
    const materialization = tryMaterializeSemanticArtifact(effectiveContract, input.input);
    if (!materialization.valid || materialization.artifact === undefined) {
        return result({ ...failure("materialization", materialization.violations), effectiveContract }, "Semantic PR materialization failed; see diagnostics.");
    }
    const planResult = tryPlanSemanticPullRequest({
        artifact: materialization.artifact,
        capabilities: effectiveContract.capabilities,
    });
    if (!planResult.valid || planResult.plan === undefined) {
        return result({ ...failure("projection", planResult.violations), effectiveContract }, "Semantic PR projection failed; see diagnostics.");
    }
    const plan = planResult.plan;
    return result({
        ok: true,
        valid: true,
        effectiveContract,
        artifact: materialization.artifact,
        plan,
        provenance: plan.provenance,
        generation: plan.generation,
        preview: true,
        mutation: false,
    }, "Produced a deterministic read-only semantic PR plan preview.");
}
/** Register the canonical semantic PR tool catalog on any MCP transport. */
export function registerSemanticPullRequestTools(server, dependencies = {}) {
    const contract = server.registerTool("inari_pr_contract", {
        title: "Resolve semantic PR contract",
        description: "Resolve the repository's effective semantic pull-request contract and caller input schema through Inari Core. Repository Canon and Core remain authoritative.",
        inputSchema: semanticPullRequestContractInputSchema,
        outputSchema: semanticPullRequestOutputSchema,
        annotations: READ_ONLY,
    }, async (input) => handleContract(input, dependencies));
    const materialize = server.registerTool("inari_pr_materialize", {
        title: "Materialize semantic PR",
        description: "Materialize caller input into a validated semantic pull-request artifact through Inari Core. Contract-declared values are evaluated by Core.",
        inputSchema: semanticPullRequestMaterializeInputSchema,
        outputSchema: semanticPullRequestOutputSchema,
        annotations: READ_ONLY,
    }, async (input) => handleMaterialize(input, dependencies));
    const plan = server.registerTool("inari_pr_plan", {
        title: "Preview semantic PR plan",
        description: "Preview the deterministic semantic pull-request projection and mutation plan through Inari Core without performing GitHub mutation.",
        inputSchema: semanticPullRequestPlanInputSchema,
        outputSchema: semanticPullRequestOutputSchema,
        annotations: READ_ONLY,
    }, async (input) => handlePlan(input, dependencies));
    const observe = server.registerTool("inari_pr_observe", {
        title: "Observe semantic PR",
        description: "Observe one GitHub pull request through the bounded adapter and normalize it with the Core semantic observer.",
        inputSchema: semanticPullRequestObserveInputSchema,
        outputSchema: semanticPullRequestOutputSchema,
        annotations: READ_ONLY,
    }, async (input) => handlePullRequestObserve(input, dependencies));
    const drift = server.registerTool("inari_pr_drift", {
        title: "Compare semantic PR drift",
        description: "Materialize and project semantic PR input, observe the bounded GitHub state, and compare both through Inari Core without mutation.",
        inputSchema: semanticPullRequestDriftInputSchema,
        outputSchema: semanticPullRequestOutputSchema,
        annotations: READ_ONLY,
    }, async (input) => handlePullRequestDrift(input, dependencies));
    return Object.freeze([contract, materialize, plan, observe, drift]);
}
function kindLabel(kind) {
    return kind === "issue" ? "Issue" : "Branch";
}
async function handleArtifactContract(kind, input, dependencies) {
    try {
        return result(contractProjection(await resolveSemanticArtifactContract(kind, input, dependencies)), `Resolved the Effective ${kindLabel(kind)} Artifact Contract.`);
    }
    catch (error) {
        return result(failure("contract", error), `Semantic ${kindLabel(kind)} contract resolution failed; see diagnostics.`);
    }
}
async function handleArtifactMaterialize(kind, input, dependencies) {
    let effectiveContract;
    try {
        effectiveContract = await resolveSemanticArtifactContract(kind, input, dependencies);
    }
    catch (error) {
        return result(failure("contract", error), `Semantic ${kindLabel(kind)} contract resolution failed; see diagnostics.`);
    }
    const materialization = tryMaterializeSemanticArtifact(effectiveContract, input.input);
    if (!materialization.valid || materialization.artifact === undefined) {
        return result({ ...failure("materialization", materialization.violations), effectiveContract }, `Semantic ${kindLabel(kind)} materialization failed; see diagnostics.`);
    }
    return result({
        ok: true,
        valid: true,
        effectiveContract,
        artifact: materialization.artifact,
        provenance: materialization.artifact.provenance,
        generation: materialization.artifact.generation,
    }, `Materialized the semantic ${kindLabel(kind)} artifact.`);
}
async function handleArtifactPlan(kind, input, dependencies) {
    let effectiveContract;
    try {
        effectiveContract = await resolveSemanticArtifactContract(kind, input, dependencies);
    }
    catch (error) {
        return result(failure("contract", error), `Semantic ${kindLabel(kind)} contract resolution failed; see diagnostics.`);
    }
    const materialization = tryMaterializeSemanticArtifact(effectiveContract, input.input);
    if (!materialization.valid || materialization.artifact === undefined) {
        return result({ ...failure("materialization", materialization.violations), effectiveContract }, `Semantic ${kindLabel(kind)} materialization failed; see diagnostics.`);
    }
    const planResult = kind === "issue"
        ? tryPlanSemanticIssue({ artifact: materialization.artifact, capabilities: effectiveContract.capabilities })
        : tryPlanSemanticBranch({ artifact: materialization.artifact });
    if (!planResult.valid || planResult.plan === undefined) {
        return result({ ...failure("projection", planResult.violations), effectiveContract }, `Semantic ${kindLabel(kind)} projection failed; see diagnostics.`);
    }
    const plan = planResult.plan;
    return result({
        ok: true,
        valid: true,
        effectiveContract,
        artifact: materialization.artifact,
        plan,
        provenance: plan.provenance,
        generation: plan.generation,
        preview: true,
        mutation: false,
    }, `Produced a deterministic read-only semantic ${kindLabel(kind)} plan preview.`);
}
/** Register the typed Issue semantic artifact catalog without adding policy. */
export function registerSemanticIssueTools(server, dependencies = {}) {
    const contract = server.registerTool("inari_issue_contract", {
        title: "Resolve semantic Issue contract",
        description: "Resolve the repository's effective semantic Issue contract and caller schema through Inari Core.",
        inputSchema: semanticIssueContractInputSchema,
        outputSchema: semanticPullRequestOutputSchema,
        annotations: READ_ONLY,
    }, async (input) => handleArtifactContract("issue", input, dependencies));
    const materialize = server.registerTool("inari_issue_materialize", {
        title: "Materialize semantic Issue",
        description: "Materialize caller input into a validated semantic Issue artifact through Inari Core.",
        inputSchema: semanticIssueMaterializeInputSchema,
        outputSchema: semanticPullRequestOutputSchema,
        annotations: READ_ONLY,
    }, async (input) => handleArtifactMaterialize("issue", input, dependencies));
    const plan = server.registerTool("inari_issue_plan", {
        title: "Preview semantic Issue plan",
        description: "Preview a deterministic semantic Issue projection and mutation plan without GitHub mutation.",
        inputSchema: semanticIssuePlanInputSchema,
        outputSchema: semanticPullRequestOutputSchema,
        annotations: READ_ONLY,
    }, async (input) => handleArtifactPlan("issue", input, dependencies));
    const observe = server.registerTool("inari_issue_observe", {
        title: "Observe semantic Issue",
        description: "Observe one GitHub Issue through the bounded adapter and normalize it with the Core semantic observer.",
        inputSchema: semanticIssueObserveInputSchema,
        outputSchema: semanticPullRequestOutputSchema,
        annotations: READ_ONLY,
    }, async (input) => handleIssueObserve(input, dependencies));
    const drift = server.registerTool("inari_issue_drift", {
        title: "Compare semantic Issue drift",
        description: "Materialize and project semantic Issue input, observe the bounded GitHub state, and compare both through Inari Core without mutation.",
        inputSchema: semanticIssueDriftInputSchema,
        outputSchema: semanticPullRequestOutputSchema,
        annotations: READ_ONLY,
    }, async (input) => handleIssueDrift(input, dependencies));
    return Object.freeze([contract, materialize, plan, observe, drift]);
}
/** Register the typed Branch semantic artifact catalog without adding policy. */
export function registerSemanticBranchTools(server, dependencies = {}) {
    const contract = server.registerTool("inari_branch_contract", {
        title: "Resolve semantic Branch contract",
        description: "Resolve the repository's effective semantic Branch contract and caller schema through Inari Core.",
        inputSchema: semanticBranchContractInputSchema,
        outputSchema: semanticPullRequestOutputSchema,
        annotations: READ_ONLY,
    }, async (input) => handleArtifactContract("branch", input, dependencies));
    const materialize = server.registerTool("inari_branch_materialize", {
        title: "Materialize semantic Branch",
        description: "Materialize caller input into a validated semantic Branch artifact through Inari Core.",
        inputSchema: semanticBranchMaterializeInputSchema,
        outputSchema: semanticPullRequestOutputSchema,
        annotations: READ_ONLY,
    }, async (input) => handleArtifactMaterialize("branch", input, dependencies));
    const plan = server.registerTool("inari_branch_plan", {
        title: "Preview semantic Branch plan",
        description: "Preview a deterministic semantic Branch projection and mutation plan without GitHub mutation.",
        inputSchema: semanticBranchPlanInputSchema,
        outputSchema: semanticPullRequestOutputSchema,
        annotations: READ_ONLY,
    }, async (input) => handleArtifactPlan("branch", input, dependencies));
    const observe = server.registerTool("inari_branch_observe", {
        title: "Observe semantic Branch",
        description: "Observe one GitHub branch ref through the bounded adapter and normalize it with the Core semantic observer.",
        inputSchema: semanticBranchObserveInputSchema,
        outputSchema: semanticPullRequestOutputSchema,
        annotations: READ_ONLY,
    }, async (input) => handleBranchObserve(input, dependencies));
    const drift = server.registerTool("inari_branch_drift", {
        title: "Compare semantic Branch drift",
        description: "Materialize and project semantic Branch input, observe the bounded GitHub ref, and compare both through Inari Core without mutation.",
        inputSchema: semanticBranchDriftInputSchema,
        outputSchema: semanticPullRequestOutputSchema,
        annotations: READ_ONLY,
    }, async (input) => handleBranchDrift(input, dependencies));
    return Object.freeze([contract, materialize, plan, observe, drift]);
}
/** Publicly expose the protocol annotations without allowing mutation. */
export const SEMANTIC_PULL_REQUEST_MCP_ANNOTATIONS = READ_ONLY;
export const SEMANTIC_ISSUE_MCP_ANNOTATIONS = READ_ONLY;
export const SEMANTIC_BRANCH_MCP_ANNOTATIONS = READ_ONLY;
//# sourceMappingURL=tools.js.map