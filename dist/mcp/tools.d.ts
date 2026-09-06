/**
 * Native MCP tools for the semantic pull-request Core boundary.
 *
 * This module owns only protocol translation. Repository policy, effective
 * contract compilation, materialization, projection, and planning remain in
 * the existing Core modules. The same registration function can therefore be
 * used by stdio and a future hosted transport without changing semantics.
 */
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type EffectiveArtifactContract } from "../contract/effective-artifact-contract.js";
import { GitHubAdapter, type GitHubAdapterOptions } from "../github/index.js";
/** Version of the Inari-owned MCP tool/input/output contract. */
export declare const INARI_MCP_TOOL_CONTRACT_VERSION: "1";
export declare const INARI_MCP_TOOL_NAMES: readonly ["inari_issue_contract", "inari_issue_materialize", "inari_issue_plan", "inari_issue_observe", "inari_issue_drift", "inari_branch_contract", "inari_branch_materialize", "inari_branch_plan", "inari_branch_observe", "inari_branch_drift", "inari_pr_contract", "inari_pr_materialize", "inari_pr_plan", "inari_pr_observe", "inari_pr_drift"];
export type InariMcpToolName = (typeof INARI_MCP_TOOL_NAMES)[number];
/** Input schema shared by contract discovery and the two semantic operations. */
export declare const semanticPullRequestContractInputSchema: z.ZodObject<{
    repository: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
/** Input schema for semantic PR materialization. */
export declare const semanticPullRequestMaterializeInputSchema: z.ZodObject<{
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    repository: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
/** Input schema for semantic PR plan preview. */
export declare const semanticPullRequestPlanInputSchema: z.ZodObject<{
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    repository: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
/** Issue and Branch use the same closed-world request shape as PR. */
export declare const semanticIssueContractInputSchema: z.ZodObject<{
    repository: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const semanticIssueMaterializeInputSchema: z.ZodObject<{
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    repository: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const semanticIssuePlanInputSchema: z.ZodObject<{
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    repository: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const semanticBranchContractInputSchema: z.ZodObject<{
    repository: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const semanticBranchMaterializeInputSchema: z.ZodObject<{
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    repository: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const semanticBranchPlanInputSchema: z.ZodObject<{
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    repository: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
/** Input schemas for bounded provider observation and Core drift comparison. */
export declare const semanticIssueObserveInputSchema: z.ZodObject<{
    number: z.ZodNumber;
    repository: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const semanticIssueDriftInputSchema: z.ZodObject<{
    number: z.ZodNumber;
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    repository: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const semanticBranchObserveInputSchema: z.ZodObject<{
    name: z.ZodString;
    source: z.ZodString;
    repository: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const semanticBranchDriftInputSchema: z.ZodObject<{
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    repository: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const semanticPullRequestObserveInputSchema: z.ZodObject<{
    number: z.ZodNumber;
    repository: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const semanticPullRequestDriftInputSchema: z.ZodObject<{
    number: z.ZodNumber;
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    repository: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export type SemanticPullRequestContractInput = z.infer<typeof semanticPullRequestContractInputSchema>;
export type SemanticPullRequestMaterializeInput = z.infer<typeof semanticPullRequestMaterializeInputSchema>;
export type SemanticPullRequestPlanInput = z.infer<typeof semanticPullRequestPlanInputSchema>;
export type SemanticIssueContractInput = z.infer<typeof semanticIssueContractInputSchema>;
export type SemanticIssueMaterializeInput = z.infer<typeof semanticIssueMaterializeInputSchema>;
export type SemanticIssuePlanInput = z.infer<typeof semanticIssuePlanInputSchema>;
export type SemanticBranchContractInput = z.infer<typeof semanticBranchContractInputSchema>;
export type SemanticBranchMaterializeInput = z.infer<typeof semanticBranchMaterializeInputSchema>;
export type SemanticBranchPlanInput = z.infer<typeof semanticBranchPlanInputSchema>;
export type SemanticIssueObserveInput = z.infer<typeof semanticIssueObserveInputSchema>;
export type SemanticIssueDriftInput = z.infer<typeof semanticIssueDriftInputSchema>;
export type SemanticBranchObserveInput = z.infer<typeof semanticBranchObserveInputSchema>;
export type SemanticBranchDriftInput = z.infer<typeof semanticBranchDriftInputSchema>;
export type SemanticPullRequestObserveInput = z.infer<typeof semanticPullRequestObserveInputSchema>;
export type SemanticPullRequestDriftInput = z.infer<typeof semanticPullRequestDriftInputSchema>;
/** Injectable Core adapter seam used by stdio and tests. */
export interface NativeSemanticPullRequestDependencies {
    /** Local repository working directory used for GitHubAdapter resolution. */
    readonly repositoryRoot?: string;
    /** Default repository target for requests that omit `repository`. */
    readonly repository?: string;
    /** Direct adapter seam for tests or an embedding application. */
    readonly adapter?: GitHubAdapter;
    /** Factory seam for repository-scoped adapter construction. */
    readonly createAdapter?: (options: GitHubAdapterOptions) => GitHubAdapter;
}
/** Shared dependency seam for all read-only semantic artifact catalogs. */
export interface NativeSemanticArtifactDependencies extends NativeSemanticPullRequestDependencies {
}
/**
 * Core result fields are intentionally explicit so malformed adapter output
 * fails closed. The adapter never rewrites or narrows the nested Effective
 * Contract, Artifact, or Plan.
 */
export declare const semanticPullRequestOutputSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    valid: z.ZodBoolean;
    phase: z.ZodOptional<z.ZodEnum<{
        contract: "contract";
        projection: "projection";
        materialization: "materialization";
        observation: "observation";
        comparison: "comparison";
    }>>;
    version: z.ZodOptional<z.ZodString>;
    artifactContractVersion: z.ZodOptional<z.ZodString>;
    kind: z.ZodOptional<z.ZodString>;
    id: z.ZodOptional<z.ZodString>;
    contract: z.ZodOptional<z.ZodUnknown>;
    effectiveContract: z.ZodOptional<z.ZodUnknown>;
    inputSchema: z.ZodOptional<z.ZodUnknown>;
    properties: z.ZodOptional<z.ZodUnknown>;
    fields: z.ZodOptional<z.ZodUnknown>;
    derivations: z.ZodOptional<z.ZodUnknown>;
    dependencyGraph: z.ZodOptional<z.ZodUnknown>;
    evaluationOrder: z.ZodOptional<z.ZodUnknown>;
    capabilities: z.ZodOptional<z.ZodUnknown>;
    artifact: z.ZodOptional<z.ZodUnknown>;
    plan: z.ZodOptional<z.ZodUnknown>;
    desired: z.ZodOptional<z.ZodUnknown>;
    observed: z.ZodOptional<z.ZodUnknown>;
    comparison: z.ZodOptional<z.ZodUnknown>;
    drift: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    observationDiagnostics: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    provenance: z.ZodOptional<z.ZodUnknown>;
    generation: z.ZodOptional<z.ZodUnknown>;
    diagnostics: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    violations: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    preview: z.ZodOptional<z.ZodBoolean>;
    mutation: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export type SemanticPullRequestMcpOutput = z.infer<typeof semanticPullRequestOutputSchema>;
export type SemanticIssueMcpOutput = SemanticPullRequestMcpOutput;
export type SemanticBranchMcpOutput = SemanticPullRequestMcpOutput;
export declare const semanticIssueOutputSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    valid: z.ZodBoolean;
    phase: z.ZodOptional<z.ZodEnum<{
        contract: "contract";
        projection: "projection";
        materialization: "materialization";
        observation: "observation";
        comparison: "comparison";
    }>>;
    version: z.ZodOptional<z.ZodString>;
    artifactContractVersion: z.ZodOptional<z.ZodString>;
    kind: z.ZodOptional<z.ZodString>;
    id: z.ZodOptional<z.ZodString>;
    contract: z.ZodOptional<z.ZodUnknown>;
    effectiveContract: z.ZodOptional<z.ZodUnknown>;
    inputSchema: z.ZodOptional<z.ZodUnknown>;
    properties: z.ZodOptional<z.ZodUnknown>;
    fields: z.ZodOptional<z.ZodUnknown>;
    derivations: z.ZodOptional<z.ZodUnknown>;
    dependencyGraph: z.ZodOptional<z.ZodUnknown>;
    evaluationOrder: z.ZodOptional<z.ZodUnknown>;
    capabilities: z.ZodOptional<z.ZodUnknown>;
    artifact: z.ZodOptional<z.ZodUnknown>;
    plan: z.ZodOptional<z.ZodUnknown>;
    desired: z.ZodOptional<z.ZodUnknown>;
    observed: z.ZodOptional<z.ZodUnknown>;
    comparison: z.ZodOptional<z.ZodUnknown>;
    drift: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    observationDiagnostics: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    provenance: z.ZodOptional<z.ZodUnknown>;
    generation: z.ZodOptional<z.ZodUnknown>;
    diagnostics: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    violations: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    preview: z.ZodOptional<z.ZodBoolean>;
    mutation: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export declare const semanticBranchOutputSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    valid: z.ZodBoolean;
    phase: z.ZodOptional<z.ZodEnum<{
        contract: "contract";
        projection: "projection";
        materialization: "materialization";
        observation: "observation";
        comparison: "comparison";
    }>>;
    version: z.ZodOptional<z.ZodString>;
    artifactContractVersion: z.ZodOptional<z.ZodString>;
    kind: z.ZodOptional<z.ZodString>;
    id: z.ZodOptional<z.ZodString>;
    contract: z.ZodOptional<z.ZodUnknown>;
    effectiveContract: z.ZodOptional<z.ZodUnknown>;
    inputSchema: z.ZodOptional<z.ZodUnknown>;
    properties: z.ZodOptional<z.ZodUnknown>;
    fields: z.ZodOptional<z.ZodUnknown>;
    derivations: z.ZodOptional<z.ZodUnknown>;
    dependencyGraph: z.ZodOptional<z.ZodUnknown>;
    evaluationOrder: z.ZodOptional<z.ZodUnknown>;
    capabilities: z.ZodOptional<z.ZodUnknown>;
    artifact: z.ZodOptional<z.ZodUnknown>;
    plan: z.ZodOptional<z.ZodUnknown>;
    desired: z.ZodOptional<z.ZodUnknown>;
    observed: z.ZodOptional<z.ZodUnknown>;
    comparison: z.ZodOptional<z.ZodUnknown>;
    drift: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    observationDiagnostics: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    provenance: z.ZodOptional<z.ZodUnknown>;
    generation: z.ZodOptional<z.ZodUnknown>;
    diagnostics: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    violations: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    preview: z.ZodOptional<z.ZodBoolean>;
    mutation: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
/** Resolve the repository Canon through the existing repository/Core boundary. */
export declare function resolveSemanticPullRequestContract(input: SemanticPullRequestContractInput, dependencies?: NativeSemanticPullRequestDependencies): Promise<EffectiveArtifactContract>;
/** Resolve the repository Canon for a semantic Issue. */
export declare function resolveSemanticIssueContract(input: SemanticIssueContractInput, dependencies?: NativeSemanticArtifactDependencies): Promise<EffectiveArtifactContract>;
/** Resolve the repository Canon for a semantic Branch. */
export declare function resolveSemanticBranchContract(input: SemanticBranchContractInput, dependencies?: NativeSemanticArtifactDependencies): Promise<EffectiveArtifactContract>;
/** Register the canonical semantic PR tool catalog on any MCP transport. */
export declare function registerSemanticPullRequestTools(server: McpServer, dependencies?: NativeSemanticPullRequestDependencies): readonly RegisteredTool[];
/** Register the typed Issue semantic artifact catalog without adding policy. */
export declare function registerSemanticIssueTools(server: McpServer, dependencies?: NativeSemanticArtifactDependencies): readonly RegisteredTool[];
/** Register the typed Branch semantic artifact catalog without adding policy. */
export declare function registerSemanticBranchTools(server: McpServer, dependencies?: NativeSemanticArtifactDependencies): readonly RegisteredTool[];
/** Publicly expose the protocol annotations without allowing mutation. */
export declare const SEMANTIC_PULL_REQUEST_MCP_ANNOTATIONS: {
    title?: string | undefined;
    readOnlyHint?: boolean | undefined;
    destructiveHint?: boolean | undefined;
    idempotentHint?: boolean | undefined;
    openWorldHint?: boolean | undefined;
};
export declare const SEMANTIC_ISSUE_MCP_ANNOTATIONS: {
    title?: string | undefined;
    readOnlyHint?: boolean | undefined;
    destructiveHint?: boolean | undefined;
    idempotentHint?: boolean | undefined;
    openWorldHint?: boolean | undefined;
};
export declare const SEMANTIC_BRANCH_MCP_ANNOTATIONS: {
    title?: string | undefined;
    readOnlyHint?: boolean | undefined;
    destructiveHint?: boolean | undefined;
    idempotentHint?: boolean | undefined;
    openWorldHint?: boolean | undefined;
};
