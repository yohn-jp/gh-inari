/**
 * Bounded local Executor for the Semantic Issue vertical slice.
 *
 * The Executor admits a Core-produced versioned plan, resolves the Issue
 * Canon again, checks its immutable generation, and hands the already
 * projected desired values to the trusted GitHub adapter. It never derives
 * title, body, metadata, or relations from CLI/MCP input.
 */
import { GitHubAdapter } from "./github/index.js";
import { SEMANTIC_ISSUE_MUTATION_PLAN_VERSION, type SemanticIssueMutationPlan } from "./semantic-issue-projection.js";
import { type ObservedIssueProjection } from "./semantic-issue-observation.js";
import type { SemanticIssueRelationEffect } from "./semantic-issue-relations.js";
export declare const SEMANTIC_ISSUE_EXECUTOR_CONTRACT_VERSION: "1";
export type SemanticIssueExecutorContractVersion = typeof SEMANTIC_ISSUE_EXECUTOR_CONTRACT_VERSION;
export declare const SEMANTIC_ISSUE_EXECUTION_OUTCOMES: readonly ["verified", "failed"];
export type SemanticIssueExecutionOutcome = (typeof SEMANTIC_ISSUE_EXECUTION_OUTCOMES)[number];
export interface SemanticIssueExecutionRequest {
    readonly version: SemanticIssueExecutorContractVersion;
    /** Versioned Core Mutation Plan. The Executor never accepts ad-hoc Issue fields. */
    readonly plan: unknown;
    /** Original caller input, when available, for execution-time Core revalidation. */
    readonly input?: unknown;
    /** Materialized artifact, when available, for a plan/artifact binding check. */
    readonly artifact?: unknown;
    readonly selector?: string;
    readonly capabilities?: readonly string[];
}
export interface SemanticIssueObservedProjection {
    readonly kind: "issue";
    readonly number: number;
    readonly url: string;
    readonly state: "open" | "closed";
    readonly title: string;
    readonly body: string | null;
    readonly labels: readonly string[];
    readonly assignees: readonly string[];
    readonly milestone?: string;
    /** Native/body relation evidence when relation capabilities were observed. */
    readonly relations?: ObservedIssueProjection["relations"];
}
export interface SemanticIssueExecutionEffectEvidence {
    readonly kind: "CREATE_ISSUE" | SemanticIssueRelationEffect["kind"];
    readonly status: "succeeded" | "failed";
}
export interface SemanticIssueExecutionFailureEvidence {
    readonly code: string;
    readonly message: string;
}
/** Provider-independent, bounded evidence returned by local execution. */
export interface SemanticIssueExecutionEvidence {
    readonly version: SemanticIssueExecutorContractVersion;
    readonly planVersion: typeof SEMANTIC_ISSUE_MUTATION_PLAN_VERSION;
    readonly outcome: SemanticIssueExecutionOutcome;
    readonly effects: readonly SemanticIssueExecutionEffectEvidence[];
    readonly issue?: Readonly<{
        readonly number: number;
        readonly url: string;
    }>;
    readonly failure?: SemanticIssueExecutionFailureEvidence;
}
export interface SemanticIssueExecutionResult {
    readonly plan: SemanticIssueMutationPlan;
    readonly projection: SemanticIssueObservedProjection;
    readonly evidence: SemanticIssueExecutionEvidence;
}
export interface SemanticIssueExecutionDiagnostic {
    readonly code: string;
    readonly path: string;
    readonly message: string;
}
export type SemanticIssueExecutorErrorCode = "SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID" | "SEMANTIC_ISSUE_EXECUTION_PLAN_INVALID" | "SEMANTIC_ISSUE_EXECUTION_PRECONDITION_FAILED" | "SEMANTIC_ISSUE_EXECUTION_REVALIDATION_FAILED" | "SEMANTIC_ISSUE_EXECUTION_EFFECT_FAILED" | "SEMANTIC_ISSUE_EXECUTION_READ_FAILED" | "SEMANTIC_ISSUE_EXECUTION_PROJECTION_VERIFICATION_FAILED";
/** Stable fail-closed error at the local Executor boundary. */
export declare class SemanticIssueExecutorError extends Error {
    readonly code: SemanticIssueExecutorErrorCode;
    readonly diagnostics: readonly SemanticIssueExecutionDiagnostic[];
    readonly evidence?: SemanticIssueExecutionEvidence;
    readonly details?: Readonly<Record<string, unknown>>;
    constructor(code: SemanticIssueExecutorErrorCode, message: string, diagnostics?: readonly SemanticIssueExecutionDiagnostic[], details?: Readonly<Record<string, unknown>>, evidence?: SemanticIssueExecutionEvidence);
}
export interface SemanticIssueExecutorOptions {
    /** A repository-scoped GitHub adapter. No credentials enter the plan. */
    readonly adapter: GitHubAdapter;
    readonly selector?: string;
    readonly capabilities?: readonly string[];
}
/** Adapter port used by CLI and future trusted deployments. */
export interface SemanticIssueExecutionPort {
    execute(request: SemanticIssueExecutionRequest): Promise<SemanticIssueExecutionResult>;
}
/**
 * Local/development deployment of the logical Semantic Artifact Executor.
 * The class is plan-centered and never accepts CLI-owned Issue projection or
 * repository-policy rules.
 */
export declare class SemanticIssueExecutor implements SemanticIssueExecutionPort {
    #private;
    constructor(options: SemanticIssueExecutorOptions);
    execute(request: SemanticIssueExecutionRequest): Promise<SemanticIssueExecutionResult>;
}
/** Explicit alias for callers naming the local deployment. */
export declare const LocalSemanticIssueExecutor: typeof SemanticIssueExecutor;
