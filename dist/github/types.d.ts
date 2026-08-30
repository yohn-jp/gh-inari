import type { ContractProvenance } from "../contract/ir.js";
export declare const VALIDATED_RENDERED_PHASE: "validated-rendered";
export type ValidatedRenderedPhase = typeof VALIDATED_RENDERED_PHASE;
/**
 * Compiler-owned handoff data for the GitHub mutation adapter.
 *
 * The runtime capability is intentionally opaque: a structurally matching
 * object, including one carrying this public phase string, is not accepted by
 * the adapter. `prepareIssueArtifact` and `preparePullRequestArtifact` are the
 * trusted preparation boundary.
 */
export interface ValidatedRenderedIssueArtifact {
    readonly phase: ValidatedRenderedPhase;
    readonly kind: "issue";
    readonly title: string;
    readonly body: string;
    readonly provenance: ContractProvenance;
    readonly labels?: readonly string[];
    readonly assignees?: readonly string[];
}
export interface ValidatedRenderedPullRequestArtifact {
    readonly phase: ValidatedRenderedPhase;
    readonly kind: "pull_request";
    readonly title: string;
    readonly body: string;
    readonly provenance: ContractProvenance;
    readonly head: string;
    readonly base: string;
    readonly draft?: boolean;
    readonly maintainerCanModify?: boolean;
}
export type ValidatedRenderedArtifact = ValidatedRenderedIssueArtifact | ValidatedRenderedPullRequestArtifact;
export interface RepositoryContext {
    readonly hostname: string;
    readonly host: string;
    readonly owner: string;
    readonly name: string;
    readonly nameWithOwner: string;
    readonly url: string;
    /** Immutable GitHub repository node ID when resolved from gh. */
    readonly repositoryId?: string;
}
/** A file entry from the repository Git tree at a trusted ref. */
export interface RepositoryTreeEntry {
    readonly path: string;
    readonly type: "blob" | "tree";
    readonly sha: string;
}
/** A repository Git tree read at a trusted ref, with its own immutable, content-addressed identity. */
export interface RepositoryTree {
    /** SHA of the tree object itself; changes whenever any entry under it changes. */
    readonly sha: string;
    readonly entries: readonly RepositoryTreeEntry[];
}
export interface GitHubIssue {
    readonly number: number;
    readonly title: string;
    readonly body: string | null;
    readonly state: "open" | "closed";
    readonly url: string;
    readonly labels: readonly string[];
    readonly assignees: readonly string[];
    /** Immutable repository node ID when supplied by the adapter context. */
    readonly repositoryId?: string;
}
export interface GitHubPullRequest {
    readonly number: number;
    readonly title: string;
    readonly body: string | null;
    readonly state: "open" | "closed";
    readonly url: string;
    readonly draft: boolean;
    readonly maintainerCanModify?: boolean;
    readonly head: string;
    readonly base: string;
}
