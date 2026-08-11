export const VALIDATED_RENDERED_PHASE = "validated-rendered" as const;

export type ValidatedRenderedPhase = typeof VALIDATED_RENDERED_PHASE;

/**
 * This discriminator is the handoff contract from Inari's compiler/validator.
 * The adapter checks the handoff shape but does not compile, validate, or render it.
 */
export interface ValidatedRenderedIssueArtifact {
  readonly phase: ValidatedRenderedPhase;
  readonly kind: "issue";
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
}

export interface ValidatedRenderedPullRequestArtifact {
  readonly phase: ValidatedRenderedPhase;
  readonly kind: "pull_request";
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
  readonly draft?: boolean;
  readonly maintainerCanModify?: boolean;
}

export type ValidatedRenderedArtifact = ValidatedRenderedIssueArtifact | ValidatedRenderedPullRequestArtifact;

/**
 * Creates the explicit compiler-to-adapter handoff marker. Callers must invoke
 * this only after their own contract validation and canonical rendering.
 */
export function markValidatedRenderedIssueArtifact(
  artifact: Omit<ValidatedRenderedIssueArtifact, "phase">,
): ValidatedRenderedIssueArtifact {
  return { ...artifact, phase: VALIDATED_RENDERED_PHASE };
}

/**
 * Creates the explicit compiler-to-adapter handoff marker. Callers must invoke
 * this only after their own contract validation and canonical rendering.
 */
export function markValidatedRenderedPullRequestArtifact(
  artifact: Omit<ValidatedRenderedPullRequestArtifact, "phase">,
): ValidatedRenderedPullRequestArtifact {
  return { ...artifact, phase: VALIDATED_RENDERED_PHASE };
}

export interface RepositoryContext {
  readonly hostname: string;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  readonly nameWithOwner: string;
  readonly url: string;
}

export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed";
  readonly url: string;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
}

export interface GitHubPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed";
  readonly url: string;
  readonly draft: boolean;
  readonly head: string;
  readonly base: string;
}
