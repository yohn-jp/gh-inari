import type { ArtifactContractProvenance, ContractProvenance } from "../contract/ir.js";

export const VALIDATED_RENDERED_PHASE = "validated-rendered" as const;

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

/**
 * Opaque provider handoff for a v2 Semantic PR projection.
 *
 * This remains separate from the native-template artifact type because an
 * Artifact Contract provenance has no native template fields.
 */
export interface ValidatedSemanticPullRequestArtifact {
  readonly phase: "validated-semantic";
  readonly kind: "pull_request";
  readonly title: string;
  readonly body: string;
  readonly provenance: ArtifactContractProvenance;
  readonly head: string;
  readonly base: string;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly draft?: boolean;
  readonly maintainerCanModify?: boolean;
}

/** Opaque provider handoff for a Core-projected v2 Semantic Issue. */
export interface ValidatedSemanticIssueArtifact {
  readonly phase: "validated-semantic";
  readonly kind: "issue";
  readonly title: string;
  readonly body: string;
  readonly provenance: ArtifactContractProvenance;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
}

export interface RepositoryContext {
  readonly hostname: string;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  readonly nameWithOwner: string;
  readonly url: string;
  /** Decimal REST repository database ID when resolved from gh. */
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

/** Zero-or-one Canon v2 milestone observation, stable across Issue and pull request resources. */
export interface GitHubMilestone {
  readonly number: number;
  readonly title: string;
}

/**
 * Requested pull request reviewers, kept as distinct user and team lists.
 *
 * GitHub represents user and team review targets as separate resource kinds
 * (`requested_reviewers` vs `requested_teams`) with different stable
 * identifiers (login vs slug). Collapsing them into one string list would
 * lose that distinction and make later semantic normalization ambiguous.
 */
export interface GitHubReviewRequests {
  readonly users: readonly string[];
  readonly teams: readonly string[];
}

export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed";
  readonly url: string;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly milestone?: GitHubMilestone;
  /** Decimal REST repository database ID when supplied by the adapter context. */
  readonly repositoryId?: string;
  /** Normalized GitHub host/install boundary paired with repositoryId. */
  readonly repositoryHost?: string;
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
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly milestone?: GitHubMilestone;
  readonly requestedReviewers?: GitHubReviewRequests;
}
