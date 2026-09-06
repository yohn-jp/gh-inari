/**
 * Bounded local Executor for the Semantic PR vertical slice.
 *
 * The Executor admits a Core-produced versioned plan, resolves the repository
 * Canon again, checks the immutable generation and current target state, then
 * hands the already-projected desired values to the existing GitHub mutation
 * adapter.  It does not derive branch/title/body values and it is deliberately
 * independent from the Change control plane.
 */
import { GitHubAdapter } from "./github/index.js";
import { SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION, type SemanticPullRequestMutationPlan } from "./semantic-pr-projection.js";
export declare const SEMANTIC_PULL_REQUEST_EXECUTOR_CONTRACT_VERSION: "1";
export type SemanticPullRequestExecutorContractVersion = typeof SEMANTIC_PULL_REQUEST_EXECUTOR_CONTRACT_VERSION;
export declare const SEMANTIC_PULL_REQUEST_EXECUTION_OUTCOMES: readonly ["verified", "failed"];
export type SemanticPullRequestExecutionOutcome = (typeof SEMANTIC_PULL_REQUEST_EXECUTION_OUTCOMES)[number];
export interface SemanticPullRequestExecutionRequest {
    readonly version: SemanticPullRequestExecutorContractVersion;
    /** Versioned Core Mutation Plan. The Executor never accepts ad-hoc PR fields. */
    readonly plan: unknown;
    /** Original caller input, when available, for execution-time Core revalidation. */
    readonly input?: unknown;
    /** Materialized artifact, when available, for a plan/artifact digest binding check. */
    readonly artifact?: unknown;
    readonly selector?: string;
    readonly capabilities?: readonly string[];
}
export interface SemanticPullRequestObservedProjection {
    readonly kind: "pull_request";
    readonly number: number;
    readonly url: string;
    readonly state: "open" | "closed";
    readonly title: string;
    readonly body: string | null;
    readonly head: string;
    readonly base: string;
    readonly draft: boolean;
    readonly maintainerCanModify?: boolean;
}
export interface SemanticPullRequestExecutionEffectEvidence {
    readonly kind: "CREATE_PULL_REQUEST";
    readonly status: "succeeded" | "failed";
}
export interface SemanticPullRequestExecutionFailureEvidence {
    readonly code: string;
    readonly message: string;
}
/** Provider-independent, bounded evidence returned by local execution. */
export interface SemanticPullRequestExecutionEvidence {
    readonly version: SemanticPullRequestExecutorContractVersion;
    readonly planVersion: typeof SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION;
    readonly outcome: SemanticPullRequestExecutionOutcome;
    readonly effects: readonly SemanticPullRequestExecutionEffectEvidence[];
    readonly pullRequest?: Readonly<{
        readonly number: number;
        readonly url: string;
    }>;
    readonly failure?: SemanticPullRequestExecutionFailureEvidence;
}
export interface SemanticPullRequestExecutionResult {
    readonly plan: SemanticPullRequestMutationPlan;
    readonly projection: SemanticPullRequestObservedProjection;
    readonly evidence: SemanticPullRequestExecutionEvidence;
}
export interface SemanticPullRequestExecutionDiagnostic {
    readonly code: string;
    readonly path: string;
    readonly message: string;
}
export type SemanticPullRequestExecutorErrorCode = "SEMANTIC_PR_EXECUTION_REQUEST_INVALID" | "SEMANTIC_PR_EXECUTION_PLAN_INVALID" | "SEMANTIC_PR_EXECUTION_PRECONDITION_FAILED" | "SEMANTIC_PR_EXECUTION_REVALIDATION_FAILED" | "SEMANTIC_PR_EXECUTION_EFFECT_FAILED" | "SEMANTIC_PR_EXECUTION_READ_FAILED" | "SEMANTIC_PR_EXECUTION_PROJECTION_VERIFICATION_FAILED";
/** Stable fail-closed error at the local Executor boundary. */
export declare class SemanticPullRequestExecutorError extends Error {
    readonly code: SemanticPullRequestExecutorErrorCode;
    readonly diagnostics: readonly SemanticPullRequestExecutionDiagnostic[];
    readonly evidence?: SemanticPullRequestExecutionEvidence;
    readonly details?: Readonly<Record<string, unknown>>;
    constructor(code: SemanticPullRequestExecutorErrorCode, message: string, diagnostics?: readonly SemanticPullRequestExecutionDiagnostic[], details?: Readonly<Record<string, unknown>>, evidence?: SemanticPullRequestExecutionEvidence);
}
export interface SemanticPullRequestExecutorOptions {
    /** A repository-scoped GitHub adapter. No credentials enter the plan. */
    readonly adapter: GitHubAdapter;
    readonly selector?: string;
    readonly capabilities?: readonly string[];
}
/** Adapter port used by CLI and future trusted deployments. */
export interface SemanticPullRequestExecutionPort {
    execute(request: SemanticPullRequestExecutionRequest): Promise<SemanticPullRequestExecutionResult>;
}
/**
 * Local/development deployment of the logical Semantic Artifact Executor.
 * The class is intentionally plan-centered and never accepts CLI-owned PR
 * title, branch, body, or relation rules.
 */
export declare class SemanticPullRequestExecutor implements SemanticPullRequestExecutionPort {
    #private;
    constructor(options: SemanticPullRequestExecutorOptions);
    execute(request: SemanticPullRequestExecutionRequest): Promise<SemanticPullRequestExecutionResult>;
}
/** Explicit alias for callers naming the local deployment. */
export declare const LocalSemanticPullRequestExecutor: typeof SemanticPullRequestExecutor;
