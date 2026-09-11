/**
 * GitHub-native Issue relation mutation adapter (#419).
 *
 * This is a provider-facing projection of one already-admitted Core relation
 * effect.  It deliberately does not plan, infer, retry, compensate, or own
 * lifecycle state.  The caller supplies the bounded effect and the adapter
 * only resolves the GitHub database IDs required by the native REST API,
 * applies the matching endpoint, and fails closed on an unexpected response.
 */
import type { GitHubApiFieldValue, GitHubApiResponse } from "./adapter.js";
import type { RepositoryContext } from "./types.js";
import { type IssueBlockedByObservation, type IssueParentObservation, type IssueRelationCapabilities, type IssueRelationApiReader } from "./issue-relation-observation-adapter.js";
import { type IssueReference } from "../contract/issue-reference.js";
import type { SemanticIssueRelationEffect } from "../semantic-issue-relations.js";
/** Narrow mutation seam exposed by the GitHub adapter. */
export interface IssueRelationApiMutator extends IssueRelationApiReader {
    requestRepositoryApi(repositoryPath: string, method?: "GET" | "POST" | "PATCH" | "DELETE", fields?: Readonly<Record<string, GitHubApiFieldValue>>): Promise<GitHubApiResponse>;
}
export type IssueRelationMutationErrorCode = "RELATION_MUTATION_INVALID" | "RELATION_MUTATION_UNSUPPORTED" | "RELATION_MUTATION_READ_FAILED" | "RELATION_MUTATION_RESPONSE_INVALID" | "RELATION_MUTATION_FAILED";
/** Bounded error that never exposes a provider response body. */
export declare class GitHubIssueRelationMutationError extends Error {
    readonly code: IssueRelationMutationErrorCode;
    readonly path?: string;
    readonly status?: number;
    constructor(code: IssueRelationMutationErrorCode, message: string, options?: {
        readonly path?: string;
        readonly status?: number;
        readonly cause?: unknown;
    });
}
/**
 * Executes native parent and blocked-by effects against one repository.
 * Observation remains available through the same adapter so callers can use a
 * single capability declaration and bounded transport seam for reread.
 */
export declare class GitHubIssueRelationMutationAdapter {
    private readonly mutator;
    private readonly context;
    private readonly capabilities;
    private readonly observation;
    private readonly issueDatabaseIds;
    constructor(mutator: IssueRelationApiMutator, context: RepositoryContext, capabilities: IssueRelationCapabilities);
    observeParent(issueNumber: number): Promise<IssueParentObservation>;
    observeBlockedBy(issueNumber: number): Promise<IssueBlockedByObservation>;
    /** Execute exactly one already-admitted Core relation effect. */
    execute(effect: SemanticIssueRelationEffect, subject: IssueReference): Promise<void>;
    /** Add or replace the native parent relation for a child Issue. */
    setParent(child: IssueReference, parent: IssueReference): Promise<void>;
    /** Remove one observed native parent relation, bounded by that parent identity. */
    clearParent(child: IssueReference, previousParent: IssueReference): Promise<void>;
    /** Add one native blocked-by dependency to an Issue. */
    addBlockedBy(child: IssueReference, blocker: IssueReference): Promise<void>;
    /** Remove one native blocked-by dependency. */
    removeBlockedBy(child: IssueReference, blocker: IssueReference): Promise<void>;
    private assertReference;
    private assertSameRepository;
    private assertParentCapability;
    private assertBlockedByCapability;
    private issueDatabaseId;
    private request;
}
