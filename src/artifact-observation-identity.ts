import { createHash } from "node:crypto";
import type { GitHubIssue, GitHubPullRequest } from "./github/types.js";

export type ArtifactObservationDomain = "issue" | "pr";

declare const artifactObservationIdentityBrand: unique symbol;

/** Secret-free identity for the provider-normalized state used to prepare a mutation. */
export type ArtifactObservationIdentity = string & {
  readonly [artifactObservationIdentityBrand]: true;
};

export class StaleArtifactObservationError extends Error {
  readonly code = "ARTIFACT_OBSERVATION_STALE" as const;
  readonly details: Readonly<{ readonly domain: ArtifactObservationDomain; readonly number: number }>;

  constructor(domain: ArtifactObservationDomain, number: number) {
    super(
      `The ${domain === "issue" ? "Issue" : "pull request"} changed after it was read for remediation; no update was applied. Reread the artifact and prepare the change again.`,
    );
    this.name = "StaleArtifactObservationError";
    this.details = { domain, number };
  }
}

/**
 * Derive the mutation-relevant identity from the provider-normalized snapshot.
 * Collections whose order is not semantic are sorted before hashing. No
 * timestamps, credentials, raw responses, or governance-generation evidence
 * participate in artifact freshness.
 */
export function createArtifactObservationIdentity(
  domain: ArtifactObservationDomain,
  artifact: GitHubIssue | GitHubPullRequest,
): ArtifactObservationIdentity {
  const common = {
    number: artifact.number,
    url: artifact.url,
    title: artifact.title,
    body: artifact.body,
    state: artifact.state,
  };
  const observation =
    domain === "issue"
      ? issueObservation(common, artifact as GitHubIssue)
      : pullRequestObservation(common, artifact as GitHubPullRequest);
  const digest = createHash("sha256")
    .update(JSON.stringify({ version: 1, domain, observation }), "utf8")
    .digest("hex");
  return digest as ArtifactObservationIdentity;
}

/** Fail closed when the pre-effect provider reread differs from the prepared snapshot. */
export function assertArtifactObservationIdentityCurrent(
  domain: ArtifactObservationDomain,
  expected: ArtifactObservationIdentity,
  current: GitHubIssue | GitHubPullRequest,
  targetNumber: number,
): void {
  if (current.number !== targetNumber || createArtifactObservationIdentity(domain, current) !== expected) {
    throw new StaleArtifactObservationError(domain, targetNumber);
  }
}

function issueObservation(
  common: Readonly<Record<string, unknown>>,
  issue: GitHubIssue,
): Readonly<Record<string, unknown>> {
  return {
    ...common,
    repositoryHost: issue.repositoryHost?.toLowerCase() ?? null,
    repositoryId: issue.repositoryId ?? null,
    labels: sortedStrings(issue.labels),
    assignees: sortedStrings(issue.assignees),
  };
}

function pullRequestObservation(
  common: Readonly<Record<string, unknown>>,
  pullRequest: GitHubPullRequest,
): Readonly<Record<string, unknown>> {
  return {
    ...common,
    draft: pullRequest.draft,
    head: pullRequest.head,
    headSha: optionalObservation(pullRequest.headSha),
    base: pullRequest.base,
    baseSha: optionalObservation(pullRequest.baseSha),
    maintainerCanModify: optionalObservation(pullRequest.maintainerCanModify),
  };
}

function sortedStrings(values: readonly string[]): readonly string[] {
  return [...values].sort();
}

function optionalObservation<T extends string | boolean>(value: T | undefined): Readonly<Record<string, unknown>> {
  return value === undefined ? { observed: false } : { observed: true, value };
}
