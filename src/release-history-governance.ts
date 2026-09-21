/**
 * Governance admission for release-history pull requests.
 *
 * This module composes the existing repository governance compiler, existing
 * artifact validator, and existing Semantic PR observation. It deliberately
 * owns no release-specific relation parser or provider mutation.
 */

import { extractTemplateIdentityMarker, validateExistingPullRequestArtifact } from "./artifact.js";
import { compileRepositoryGovernedContract, type RepositoryGovernanceSourceReader } from "./governance.js";
import { observeSemanticPullRequest } from "./semantic-pr-observation.js";
import type { RepositoryContext, RepositoryTree, GitHubPullRequest } from "./github/types.js";
import type { ReleaseGovernedMergedChange } from "./release-preparation-plan.js";

const SHA_PATTERN = /^[0-9a-f]{7,128}$/iu;

export interface ReleaseHistoryGovernanceReader extends RepositoryGovernanceSourceReader {
  readonly context: RepositoryContext;
  readonly targetRef: string;
}

export interface ReleaseHistoryGovernanceTransport {
  readonly context: RepositoryContext;
  readonly targetRef: string;
  readonly getRepositoryTree: (ref: string) => Promise<RepositoryTree>;
  readonly getRepositoryBlob: (sha: string) => Promise<string>;
}

export interface ReleaseHistoryPullRequestAdmissionInput {
  readonly pullRequest: GitHubPullRequest;
  readonly mergeCommitSha: string;
  readonly repository: RepositoryContext;
  readonly governance: ReleaseHistoryGovernanceReader;
}

export class ReleaseHistoryGovernanceError extends Error {
  readonly code = "RELEASE_HISTORY_GOVERNANCE_UNAVAILABLE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReleaseHistoryGovernanceError";
  }
}

function sourceIssueNumbers(pullRequest: GitHubPullRequest, repository: RepositoryContext): readonly number[] {
  const repositoryEvidence =
    repository.repositoryId === undefined
      ? undefined
      : {
          host: repository.hostname,
          repositoryHost: repository.hostname,
          repositoryId: repository.repositoryId,
          repository: repository.nameWithOwner,
        };
  const observed = observeSemanticPullRequest(
    pullRequest,
    repositoryEvidence === undefined ? undefined : { repository: repositoryEvidence },
  );
  const references = observed.relations.implements.references;
  return [
    ...new Set(
      references
        .filter(
          (reference) =>
            reference.repositoryHost === repository.hostname.toLocaleLowerCase("en-US") &&
            reference.repositoryId === repository.repositoryId,
        )
        .map((reference) => reference.number),
    ),
  ].sort((left, right) => left - right);
}

export function createReleaseHistoryGovernanceReader(
  transport: ReleaseHistoryGovernanceTransport,
): ReleaseHistoryGovernanceReader {
  return {
    context: transport.context,
    targetRef: transport.targetRef,
    resolveRepositoryContext: async () => transport.context,
    getRepositoryDefaultBranch: async () => transport.targetRef,
    getRepositoryTree: transport.getRepositoryTree,
    getRepositoryBlob: transport.getRepositoryBlob,
  };
}

/** Admit one merged PR only after target-source contract and semantic checks. */
export async function admitReleasePullRequest(
  input: ReleaseHistoryPullRequestAdmissionInput,
): Promise<ReleaseGovernedMergedChange> {
  const { pullRequest, mergeCommitSha, repository, governance } = input;
  if (!SHA_PATTERN.test(mergeCommitSha))
    throw new ReleaseHistoryGovernanceError(`Pull request #${pullRequest.number} has invalid release commit evidence.`);
  if (pullRequest.body === null)
    throw new ReleaseHistoryGovernanceError(`Pull request #${pullRequest.number} has no readable governed body.`);
  const marker = extractTemplateIdentityMarker(pullRequest.body);
  if (marker.status !== "valid" || marker.marker === undefined || marker.marker.kind !== "pull_request")
    throw new ReleaseHistoryGovernanceError(
      `Pull request #${pullRequest.number} has no valid canonical pull-request template marker.`,
    );
  let contract;
  try {
    contract = await compileRepositoryGovernedContract(governance, "pr", marker.marker.path);
  } catch (error: unknown) {
    throw new ReleaseHistoryGovernanceError(
      `Pull request #${pullRequest.number} target-source governance could not be established.`,
      { cause: error },
    );
  }
  const validation = validateExistingPullRequestArtifact(contract, pullRequest.body);
  if (!validation.valid)
    throw new ReleaseHistoryGovernanceError(
      `Pull request #${pullRequest.number} does not satisfy the target-source pull-request contract.`,
    );
  let issueNumbers: readonly number[];
  try {
    issueNumbers = sourceIssueNumbers(pullRequest, repository);
  } catch (error: unknown) {
    throw new ReleaseHistoryGovernanceError(
      `Pull request #${pullRequest.number} semantic relation evidence is unavailable or conflicting.`,
      { cause: error },
    );
  }
  if (pullRequest.mergedAt === undefined || pullRequest.mergedAt === null)
    throw new ReleaseHistoryGovernanceError(`Pull request #${pullRequest.number} has no merged-at evidence.`);
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    mergeCommitSha: mergeCommitSha.toLowerCase(),
    mergedAt: pullRequest.mergedAt,
    governed: true,
    sourceIssueNumbers: issueNumbers,
  };
}
