/**
 * Bounded local Executor for a Core-produced Semantic Branch mutation plan.
 *
 * Admission is plan-centered: the Executor re-resolves the repository Canon,
 * revalidates the generation and semantic intent, observes the current refs,
 * applies only the explicit Core effect, and verifies the resulting ref.  It
 * never derives a branch name or source from Change, Issue, or free-form input.
 */
import { GitHubAdapter } from "./github/index.js";
import { SEMANTIC_BRANCH_MUTATION_PLAN_VERSION, type SemanticBranchMutationPlan } from "./semantic-branch-projection.js";
export declare const SEMANTIC_BRANCH_EXECUTOR_CONTRACT_VERSION: "1";
export type SemanticBranchExecutorContractVersion = typeof SEMANTIC_BRANCH_EXECUTOR_CONTRACT_VERSION;
export declare const SEMANTIC_BRANCH_EXECUTION_OUTCOMES: readonly ["verified", "failed"];
export type SemanticBranchExecutionOutcome = (typeof SEMANTIC_BRANCH_EXECUTION_OUTCOMES)[number];
export interface SemanticBranchExecutionRequest {
    readonly version: SemanticBranchExecutorContractVersion;
    /** Versioned Core Mutation Plan. Ad-hoc branch fields are not accepted. */
    readonly plan: unknown;
    /** Original caller input, when available, for execution-time Core revalidation. */
    readonly input?: unknown;
    /** Materialized Semantic Artifact, when available, for plan binding validation. */
    readonly artifact?: unknown;
    readonly selector?: string;
}
export interface SemanticBranchObservedProjection {
    readonly kind: "branch";
    readonly name: string;
    readonly source: string;
    readonly sha: string;
}
export interface SemanticBranchExecutionEffectEvidence {
    readonly kind: "CREATE_BRANCH";
    readonly status: "succeeded" | "failed";
}
export interface SemanticBranchExecutionFailureEvidence {
    readonly code: string;
    readonly message: string;
}
export interface SemanticBranchExecutionEvidence {
    readonly version: SemanticBranchExecutorContractVersion;
    readonly planVersion: typeof SEMANTIC_BRANCH_MUTATION_PLAN_VERSION;
    readonly outcome: SemanticBranchExecutionOutcome;
    readonly effects: readonly SemanticBranchExecutionEffectEvidence[];
    readonly branch?: Readonly<{
        readonly name: string;
        readonly sha: string;
    }>;
    readonly failure?: SemanticBranchExecutionFailureEvidence;
}
export interface SemanticBranchExecutionResult {
    readonly plan: SemanticBranchMutationPlan;
    readonly projection: SemanticBranchObservedProjection;
    readonly evidence: SemanticBranchExecutionEvidence;
}
export interface SemanticBranchExecutionDiagnostic {
    readonly code: string;
    readonly path: string;
    readonly message: string;
}
export type SemanticBranchExecutorErrorCode = "SEMANTIC_BRANCH_EXECUTION_REQUEST_INVALID" | "SEMANTIC_BRANCH_EXECUTION_PLAN_INVALID" | "SEMANTIC_BRANCH_EXECUTION_PRECONDITION_FAILED" | "SEMANTIC_BRANCH_EXECUTION_REVALIDATION_FAILED" | "SEMANTIC_BRANCH_EXECUTION_EFFECT_FAILED" | "SEMANTIC_BRANCH_EXECUTION_READ_FAILED" | "SEMANTIC_BRANCH_EXECUTION_PROJECTION_VERIFICATION_FAILED";
export declare class SemanticBranchExecutorError extends Error {
    readonly code: SemanticBranchExecutorErrorCode;
    readonly diagnostics: readonly SemanticBranchExecutionDiagnostic[];
    readonly evidence?: SemanticBranchExecutionEvidence;
    readonly details?: Readonly<Record<string, unknown>>;
    constructor(code: SemanticBranchExecutorErrorCode, message: string, diagnostics?: readonly SemanticBranchExecutionDiagnostic[], details?: Readonly<Record<string, unknown>>, evidence?: SemanticBranchExecutionEvidence);
}
export interface SemanticBranchExecutorOptions {
    /** Repository-scoped GitHub adapter; credentials never enter the plan. */
    readonly adapter: GitHubAdapter;
    readonly selector?: string;
}
export interface SemanticBranchExecutionPort {
    execute(request: SemanticBranchExecutionRequest): Promise<SemanticBranchExecutionResult>;
}
export declare class SemanticBranchExecutor implements SemanticBranchExecutionPort {
    #private;
    constructor(options: SemanticBranchExecutorOptions);
    execute(request: SemanticBranchExecutionRequest): Promise<SemanticBranchExecutionResult>;
}
/** Explicit alias for callers naming the local deployment. */
export declare const LocalSemanticBranchExecutor: typeof SemanticBranchExecutor;
