/**
 * Bounded executor for a Core-produced native Semantic Issue relation plan.
 *
 * The executor owns only admission/re-observation of the relation plan.  It
 * does not derive Issue identity, lifecycle, branch, worktree, or session
 * state.  Provider-specific endpoint details remain in the GitHub relation
 * adapter; this module performs no direct GitHub API construction.
 */
import { GitHubAdapter } from "./github/index.js";
import { SEMANTIC_ISSUE_RELATION_PLAN_VERSION, type SemanticIssueRelationEffect, type SemanticIssueRelationMutationPlan, type SemanticIssueRelationObservedState } from "./semantic-issue-relations.js";
export declare const SEMANTIC_ISSUE_RELATION_EXECUTOR_CONTRACT_VERSION: "1";
export type SemanticIssueRelationExecutorContractVersion = typeof SEMANTIC_ISSUE_RELATION_EXECUTOR_CONTRACT_VERSION;
export interface SemanticIssueRelationExecutionRequest {
    readonly version: SemanticIssueRelationExecutorContractVersion;
    readonly plan: unknown;
}
export interface SemanticIssueRelationExecutionEffectEvidence {
    readonly kind: SemanticIssueRelationEffect["kind"];
    readonly status: "succeeded" | "failed";
}
export interface SemanticIssueRelationExecutionEvidence {
    readonly version: SemanticIssueRelationExecutorContractVersion;
    readonly planVersion: typeof SEMANTIC_ISSUE_RELATION_PLAN_VERSION;
    readonly outcome: "verified" | "failed";
    readonly effects: readonly SemanticIssueRelationExecutionEffectEvidence[];
    readonly failure?: Readonly<{
        readonly code: string;
        readonly message: string;
    }>;
}
export interface SemanticIssueRelationExecutionResult {
    readonly plan: SemanticIssueRelationMutationPlan;
    readonly observed: SemanticIssueRelationObservedState;
    readonly evidence: SemanticIssueRelationExecutionEvidence;
}
export type SemanticIssueRelationExecutorErrorCode = "SEMANTIC_ISSUE_RELATION_EXECUTION_REQUEST_INVALID" | "SEMANTIC_ISSUE_RELATION_EXECUTION_PLAN_INVALID" | "SEMANTIC_ISSUE_RELATION_EXECUTION_READ_FAILED" | "SEMANTIC_ISSUE_RELATION_EXECUTION_STALE" | "SEMANTIC_ISSUE_RELATION_EXECUTION_EFFECT_FAILED" | "SEMANTIC_ISSUE_RELATION_EXECUTION_POSTCONDITION_FAILED";
export interface SemanticIssueRelationExecutionDiagnostic {
    readonly code: string;
    readonly path: string;
    readonly message: string;
}
export declare class SemanticIssueRelationExecutorError extends Error {
    readonly code: SemanticIssueRelationExecutorErrorCode;
    readonly diagnostics: readonly SemanticIssueRelationExecutionDiagnostic[];
    readonly evidence?: SemanticIssueRelationExecutionEvidence;
    constructor(code: SemanticIssueRelationExecutorErrorCode, message: string, diagnostics?: readonly SemanticIssueRelationExecutionDiagnostic[], evidence?: SemanticIssueRelationExecutionEvidence);
}
export interface SemanticIssueRelationExecutorOptions {
    readonly adapter: GitHubAdapter;
}
export interface SemanticIssueRelationExecutionPort {
    execute(request: SemanticIssueRelationExecutionRequest): Promise<SemanticIssueRelationExecutionResult>;
}
/** Executes exactly the bounded native effects admitted by Core. */
export declare class SemanticIssueRelationExecutor implements SemanticIssueRelationExecutionPort {
    #private;
    constructor(options: SemanticIssueRelationExecutorOptions);
    execute(request: SemanticIssueRelationExecutionRequest): Promise<SemanticIssueRelationExecutionResult>;
}
export declare const LocalSemanticIssueRelationExecutor: typeof SemanticIssueRelationExecutor;
