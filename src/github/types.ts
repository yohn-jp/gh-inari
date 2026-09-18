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
  /** Decimal REST repository database ID when resolved from the native provider. */
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

/** Bounded Git ref evidence used by semantic branch admission. */
export interface GitHubBranch {
  readonly name: string;
  readonly ref: string;
  readonly sha: string;
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
  /** Commit identity of the head branch when the provider supplies it. */
  readonly headSha?: string;
  readonly base: string;
  /** Commit identity of the base branch when the provider supplies it. */
  readonly baseSha?: string;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly milestone?: GitHubMilestone;
  readonly requestedReviewers?: GitHubReviewRequests;
  /** Fresh provider merge evidence; absent means the provider did not expose it. */
  readonly mergeable?: boolean | null;
  readonly mergeableState?: string;
  readonly merged?: boolean;
  readonly mergedAt?: string | null;
  readonly mergeCommitSha?: string | null;
  /** Optional provider evidence used only to prove an idempotent strategy replay. */
  readonly mergeMethod?: "merge" | "squash" | "rebase";
}

export interface GitHubPullRequestComment {
  readonly id: number;
  readonly body: string;
  readonly url?: string;
  readonly author?: string;
}

export type GitHubPullRequestReviewState =
  "approved" | "changes-requested" | "commented" | "dismissed" | "pending" | "unknown";

export interface GitHubPullRequestReview {
  readonly id: number;
  readonly body: string | null;
  readonly state: GitHubPullRequestReviewState;
  readonly commitId: string;
  readonly url?: string;
  readonly author?: string;
}

export interface GitHubPullRequestMergeResponse {
  readonly merged: boolean;
  readonly sha?: string;
}

export interface GitHubPullRequestMergePolicyEvidence {
  readonly allowedStrategies?: readonly ("merge" | "squash" | "rebase")[];
  readonly checks?: Readonly<{
    readonly authoritative: boolean;
    readonly satisfied: boolean;
    readonly required?: readonly string[];
    readonly state?: string;
  }>;
  readonly reviews?: Readonly<{
    readonly authoritative: boolean;
    readonly satisfied: boolean;
    readonly requiredApprovals?: number;
    readonly approvals?: number;
  }>;
}

/** Provider-normalized pagination evidence used by Operational Observation. */
export interface GitHubOperationalPagination {
  readonly perPage: number;
  readonly pages: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly nextPage?: number;
}

/** Provider-normalized, secret-safe diagnostic for one optional read. */
export interface GitHubOperationalDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** A bounded collection read. Unavailable collections retain their evidence. */
export interface GitHubOperationalCollection<T> {
  readonly status: "available" | "unavailable";
  readonly items: readonly T[];
  readonly pagination: GitHubOperationalPagination;
  readonly diagnostics: readonly GitHubOperationalDiagnostic[];
}

/** Minimal provider identity normalized from a GitHub actor object. */
export interface GitHubOperationalActor {
  readonly login?: string;
  readonly id?: number;
  readonly name?: string;
  readonly url?: string;
}

export interface GitHubOperationalComment {
  readonly id: number;
  readonly body: string | null;
  readonly author: GitHubOperationalActor | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly url?: string;
  readonly path?: string;
  readonly line?: number | null;
  readonly side?: string | null;
  readonly inReplyTo?: number;
}

export interface GitHubOperationalReview {
  readonly id: number;
  readonly body: string | null;
  readonly author: GitHubOperationalActor | null;
  readonly state: string;
  readonly submittedAt?: string;
  readonly commitId?: string;
  readonly url?: string;
}

/** Bounded provider-neutral identity for one GitHub check context. */
export interface GitHubOperationalCheckIdentity {
  /** The provider context represented by the check, not an arbitrary payload. */
  readonly context: string;
  /** Stable provider producer key when GitHub supplied one. */
  readonly producer?: string;
}

export interface GitHubOperationalCheck {
  readonly id: string;
  readonly name: string;
  readonly kind: "check-run" | "status";
  readonly identity?: GitHubOperationalCheckIdentity;
  readonly status: string;
  readonly conclusion?: string | null;
  readonly description?: string | null;
  readonly url?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  /** Adapter-selected current execution; unknown is an explicit fail-closed result. */
  readonly current?: boolean | "unknown";
}

/**
 * Bounded expected required-check identity read from the base branch's
 * repository-governed protection policy, not from observed check evidence.
 */
export interface GitHubOperationalRequiredCheckBinding {
  readonly context: string;
  /** Authoritative expected GitHub App identity, absent when the policy does not bind one. */
  readonly producer?: string;
}

export interface GitHubOperationalChangedFile {
  readonly filename: string;
  /** Previous path supplied by GitHub for a rename. */
  readonly previousFilename?: string;
  readonly status?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changes?: number;
  readonly sha?: string;
  readonly blobUrl?: string;
  readonly rawUrl?: string;
  readonly contentsUrl?: string;
}

export interface GitHubOperationalReviewRequests {
  readonly users: readonly GitHubOperationalActor[];
  readonly teams: readonly string[];
}

export interface GitHubOperationalRepository {
  readonly host: string;
  readonly nameWithOwner: string;
  readonly repositoryId?: string;
}

export interface GitHubOperationalProvenance {
  readonly provider: "github";
  readonly endpoints: readonly string[];
}

/** Normalized provider evidence for one Issue; no Canon/template semantics. */
export interface GitHubOperationalIssueEvidence {
  readonly repository: GitHubOperationalRepository;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed" | "unknown";
  readonly stateReason?: string | null;
  readonly author: GitHubOperationalActor | null;
  readonly labels: readonly string[];
  readonly assignees: readonly GitHubOperationalActor[];
  readonly milestone?: GitHubMilestone;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly closedAt?: string;
  readonly url: string;
  readonly comments: GitHubOperationalCollection<GitHubOperationalComment>;
  readonly provenance: GitHubOperationalProvenance;
}

/** Normalized provider evidence for one PR; no Canon/template semantics. */
export interface GitHubOperationalPullRequestEvidence {
  readonly repository: GitHubOperationalRepository;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed" | "unknown";
  readonly author: GitHubOperationalActor | null;
  readonly head: { readonly ref?: string; readonly sha?: string };
  readonly base: { readonly ref?: string; readonly sha?: string };
  readonly draft?: boolean;
  readonly mergeable?: boolean | null;
  readonly mergeState?: string | null;
  readonly reviewDecision?: string | null;
  readonly merged?: boolean | null;
  readonly mergeCommitSha?: string | null;
  readonly labels: readonly string[];
  readonly assignees: readonly GitHubOperationalActor[];
  readonly requestedReviewers?: GitHubOperationalReviewRequests;
  readonly milestone?: GitHubMilestone;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly closedAt?: string;
  readonly mergedAt?: string;
  readonly url: string;
  readonly checks: GitHubOperationalCollection<GitHubOperationalCheck>;
  /** Repository-governed expected required-check producer bindings for the base branch. */
  readonly requiredCheckBindings: GitHubOperationalCollection<GitHubOperationalRequiredCheckBinding>;
  readonly reviews: GitHubOperationalCollection<GitHubOperationalReview>;
  readonly comments: GitHubOperationalCollection<GitHubOperationalComment>;
  readonly inlineReviewComments: GitHubOperationalCollection<GitHubOperationalComment>;
  readonly changedFiles: GitHubOperationalCollection<GitHubOperationalChangedFile>;
  readonly provenance: GitHubOperationalProvenance;
}
