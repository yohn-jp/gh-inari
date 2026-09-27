/**
 * Pure Core evaluator for current Source acceptance reviewer authority and
 * independence. Provider adapters supply current policy and complete exact-head
 * evidence; this module never reads provider state or establishes Source
 * completion.
 */

import {
  SOURCE_ACCEPTANCE_POLICY_KIND,
  SOURCE_ACCEPTANCE_POLICY_PATH,
  SOURCE_ACCEPTANCE_POLICY_VERSION,
  type LoadedSourceAcceptancePolicy,
  type SourceAcceptancePolicyProvenance,
} from "./source-acceptance-policy.js";
import type { SourceAcceptancePullRequestIdentity, SourceAcceptanceRepositoryIdentity } from "./source-acceptance.js";

const MAX_IDENTITY_LENGTH = 20;
const GIT_OBJECT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const HOST_PATTERN =
  /^(?=.{1,255}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/u;
const SAFE_REF_PATTERN = /^[^\u0000-\u0020\u007f]{1,255}$/u;

/** Provider classification attached to immutable actor identity evidence. */
export type SourceAcceptanceProviderActorEvidence =
  | Readonly<{ classification: "human"; providerHost: string; userId: string }>
  | Readonly<{ classification: "bot"; providerHost: string }>
  | Readonly<{ classification: "unknown"; providerHost: string }>;

/** Provider-neutral representation of one exact-head PR commit. */
export interface SourceAcceptanceCommitContributorEvidence {
  readonly sha: string;
  readonly author: SourceAcceptanceProviderActorEvidence;
  readonly coAuthors: Readonly<{
    resolution: "complete" | "incomplete" | "unavailable";
    actors: readonly SourceAcceptanceProviderActorEvidence[];
  }>;
  /** Committers are provider/integration actors and do not affect independence. */
  readonly committer?: SourceAcceptanceProviderActorEvidence;
}

/** Complete provider observation for one immutable repository, PR, and head. */
export interface SourceAcceptanceContributorEvidence {
  readonly repository: SourceAcceptanceRepositoryIdentity;
  readonly pullRequest: SourceAcceptancePullRequestIdentity;
  readonly pagination: "complete" | "incomplete" | "truncated" | "unavailable";
  /** Independently observed PR head; the complete commit set must contain it. */
  readonly observedHeadSha: string;
  readonly commits: readonly SourceAcceptanceCommitContributorEvidence[];
}

/** Provider-observed Source Issue author bound to its immutable Source target. */
export interface SourceAcceptanceSourceRequesterEvidence {
  readonly repository: SourceAcceptanceRepositoryIdentity;
  readonly sourceIssue: number;
  readonly author: SourceAcceptanceProviderActorEvidence;
}

/** Provider-observed integration PR author bound to its exact repository/head. */
export interface SourceAcceptancePullRequestAuthorEvidence {
  readonly repository: SourceAcceptanceRepositoryIdentity;
  readonly pullRequest: SourceAcceptancePullRequestIdentity;
  readonly author: SourceAcceptanceProviderActorEvidence;
}

export interface SourceAcceptanceReviewerEvaluationInput {
  /** A newly loaded snapshot. Freshness and reloading remain caller duties. */
  readonly currentPolicy: LoadedSourceAcceptancePolicy;
  readonly candidate: Readonly<{
    repository: SourceAcceptanceRepositoryIdentity;
    sourceIssue: number;
    integrationPullRequest: SourceAcceptancePullRequestIdentity;
  }>;
  readonly reviewer: SourceAcceptanceProviderActorEvidence;
  readonly sourceRequester: SourceAcceptanceSourceRequesterEvidence;
  readonly integrationPullRequestAuthor: SourceAcceptancePullRequestAuthorEvidence;
  readonly contributors: SourceAcceptanceContributorEvidence;
}

export type SourceAcceptanceReviewerDiagnosticCode =
  | "INPUT_INVALID"
  | "POLICY_INVALID"
  | "POLICY_REPOSITORY_MISMATCH"
  | "REVIEWER_IDENTITY_UNAVAILABLE"
  | "REVIEWER_NOT_AUTHORIZED"
  | "REQUESTER_IDENTITY_UNAVAILABLE"
  | "REQUESTER_EVIDENCE_MISMATCH"
  | "PULL_REQUEST_AUTHOR_IDENTITY_UNAVAILABLE"
  | "PULL_REQUEST_AUTHOR_EVIDENCE_MISMATCH"
  | "REVIEWER_NOT_INDEPENDENT"
  | "CONTRIBUTOR_EVIDENCE_INVALID"
  | "CONTRIBUTOR_EVIDENCE_INCOMPLETE"
  | "CONTRIBUTOR_EVIDENCE_MISMATCH"
  | "CONTRIBUTOR_IDENTITY_UNAVAILABLE";

export interface SourceAcceptanceReviewerDiagnostic {
  readonly code: SourceAcceptanceReviewerDiagnosticCode;
  readonly message: string;
}

/**
 * `authorized-independent-reviewer` is limited to the supplied exact Source
 * candidate and policy provenance. It does not certify criteria or completion.
 */
export type SourceAcceptanceReviewerEvaluation =
  | Readonly<{
      classification: "authorized-independent-reviewer";
      evidence: Readonly<{
        repository: SourceAcceptanceRepositoryIdentity;
        sourceIssue: number;
        integrationPullRequest: SourceAcceptancePullRequestIdentity;
        reviewer: Readonly<{ providerHost: string; userId: string }>;
        policy: Readonly<{
          generation: number;
          provenance: SourceAcceptancePolicyProvenance;
        }>;
      }>;
      diagnostics: readonly [];
    }>
  | Readonly<{
      classification: "denied";
      diagnostics: readonly [SourceAcceptanceReviewerDiagnostic];
    }>;

type ActorClass = "human" | "bot" | "unknown";
type HumanIdentity = Readonly<{ providerHost: string; userId: string }>;

const DIAGNOSTIC_MESSAGES: Readonly<Record<SourceAcceptanceReviewerDiagnosticCode, string>> = Object.freeze({
  INPUT_INVALID: "Reviewer evaluation input is malformed.",
  POLICY_INVALID: "Current Source acceptance policy evidence is invalid.",
  POLICY_REPOSITORY_MISMATCH: "Current Source acceptance policy belongs to another repository.",
  REVIEWER_IDENTITY_UNAVAILABLE: "Reviewer is not a provider-proven human immutable identity.",
  REVIEWER_NOT_AUTHORIZED: "Reviewer is not in the current Source acceptance policy.",
  REQUESTER_IDENTITY_UNAVAILABLE: "Source requester identity or classification is unavailable.",
  REQUESTER_EVIDENCE_MISMATCH: "Source requester evidence does not bind to the exact Source Issue.",
  PULL_REQUEST_AUTHOR_IDENTITY_UNAVAILABLE: "Integration PR author identity or classification is unavailable.",
  PULL_REQUEST_AUTHOR_EVIDENCE_MISMATCH: "Integration PR author evidence does not bind to the exact candidate head.",
  REVIEWER_NOT_INDEPENDENT:
    "Reviewer is not independent of the Source requester, PR author, or candidate contributors.",
  CONTRIBUTOR_EVIDENCE_INVALID: "Candidate contributor evidence is malformed.",
  CONTRIBUTOR_EVIDENCE_INCOMPLETE: "Candidate contributor evidence is incomplete or unavailable.",
  CONTRIBUTOR_EVIDENCE_MISMATCH:
    "Candidate contributor evidence does not bind to the exact Source integration PR head.",
  CONTRIBUTOR_IDENTITY_UNAVAILABLE: "A candidate commit author or co-author identity/classification is unresolved.",
});

/** Evaluate the current policy and exact candidate contributor evidence. */
export function evaluateSourceAcceptanceReviewer(input: unknown): SourceAcceptanceReviewerEvaluation {
  try {
    return evaluate(input);
  } catch {
    // Getters, proxies, and malformed untrusted input must not escape as an
    // authorization success or provider-shaped exception.
    return denied("INPUT_INVALID");
  }
}

function evaluate(input: unknown): SourceAcceptanceReviewerEvaluation {
  const value = recordWithKeys(input, [
    "currentPolicy",
    "candidate",
    "reviewer",
    "sourceRequester",
    "integrationPullRequestAuthor",
    "contributors",
  ]);
  if (value === undefined) return denied("INPUT_INVALID");

  const candidate = readCandidate(value.candidate);
  if (candidate === undefined) return denied("INPUT_INVALID");

  const policy = readCurrentPolicy(value.currentPolicy);
  if (policy === undefined) return denied("POLICY_INVALID");
  if (!sameRepository(policy.provenance.repository, candidate.repository)) {
    return denied("POLICY_REPOSITORY_MISMATCH");
  }

  const reviewer = readActor(value.reviewer, candidate.repository.host);
  if (reviewer === undefined || reviewer.classification !== "human") {
    return denied("REVIEWER_IDENTITY_UNAVAILABLE");
  }
  if (!policy.reviewerUserIds.includes(reviewer.userId)) return denied("REVIEWER_NOT_AUTHORIZED");

  const independentFrom = new Set<string>();
  const requesterEvidence = readIssueAuthor(value.sourceRequester, candidate);
  if (requesterEvidence === "mismatch") return denied("REQUESTER_EVIDENCE_MISMATCH");
  if (requesterEvidence === undefined || requesterEvidence.classification === "unknown") {
    return denied("REQUESTER_IDENTITY_UNAVAILABLE");
  }
  if (requesterEvidence.classification === "human") independentFrom.add(requesterEvidence.userId);

  const pullRequestAuthorEvidence = readPullRequestAuthor(value.integrationPullRequestAuthor, candidate);
  if (pullRequestAuthorEvidence === "mismatch") return denied("PULL_REQUEST_AUTHOR_EVIDENCE_MISMATCH");
  if (pullRequestAuthorEvidence === undefined || pullRequestAuthorEvidence.classification === "unknown") {
    return denied("PULL_REQUEST_AUTHOR_IDENTITY_UNAVAILABLE");
  }
  if (pullRequestAuthorEvidence.classification === "human") independentFrom.add(pullRequestAuthorEvidence.userId);

  const contributorResult = readContributors(value.contributors, candidate);
  if (contributorResult.kind !== "valid") return denied(contributorResult.code);
  for (const id of contributorResult.humanUserIds) independentFrom.add(id);

  if (independentFrom.has(reviewer.userId)) return denied("REVIEWER_NOT_INDEPENDENT");

  const repository = Object.freeze({ ...candidate.repository });
  const integrationPullRequest = Object.freeze({ ...candidate.integrationPullRequest });
  const provenance = freezeProvenance(policy.provenance);
  return Object.freeze({
    classification: "authorized-independent-reviewer" as const,
    evidence: Object.freeze({
      repository,
      sourceIssue: candidate.sourceIssue,
      integrationPullRequest,
      reviewer: Object.freeze({ providerHost: reviewer.providerHost, userId: reviewer.userId }),
      policy: Object.freeze({ generation: policy.generation, provenance }),
    }),
    diagnostics: Object.freeze([]) as readonly [],
  });
}

function readCandidate(input: unknown):
  | Readonly<{
      repository: SourceAcceptanceRepositoryIdentity;
      sourceIssue: number;
      integrationPullRequest: SourceAcceptancePullRequestIdentity;
    }>
  | undefined {
  const candidate = recordWithKeys(input, ["repository", "sourceIssue", "integrationPullRequest"]);
  if (
    candidate === undefined ||
    !Number.isSafeInteger(candidate.sourceIssue) ||
    typeof candidate.sourceIssue !== "number" ||
    candidate.sourceIssue <= 0
  ) {
    return undefined;
  }
  const repository = readRepository(candidate.repository);
  const pullRequest = readPullRequest(candidate.integrationPullRequest);
  if (repository === undefined || pullRequest === undefined) return undefined;
  return Object.freeze({ repository, sourceIssue: candidate.sourceIssue, integrationPullRequest: pullRequest });
}

function readCurrentPolicy(input: unknown):
  | Readonly<{
      generation: number;
      reviewerUserIds: readonly string[];
      provenance: SourceAcceptancePolicyProvenance;
    }>
  | undefined {
  const loaded = recordWithKeys(input, ["policy", "provenance"]);
  if (loaded === undefined) return undefined;
  const policy = recordWithKeys(loaded.policy, ["version", "kind", "generation", "reviewerUserIds"]);
  if (
    policy === undefined ||
    policy.version !== SOURCE_ACCEPTANCE_POLICY_VERSION ||
    policy.kind !== SOURCE_ACCEPTANCE_POLICY_KIND ||
    !Number.isSafeInteger(policy.generation) ||
    typeof policy.generation !== "number" ||
    policy.generation <= 0 ||
    !Array.isArray(policy.reviewerUserIds)
  ) {
    return undefined;
  }
  const reviewerUserIds: string[] = [];
  const seen = new Set<string>();
  for (const id of policy.reviewerUserIds) {
    if (!isUserId(id) || seen.has(id)) return undefined;
    seen.add(id);
    reviewerUserIds.push(id);
  }

  const provenance = readProvenance(loaded.provenance);
  if (provenance === undefined || provenance.generation !== policy.generation) return undefined;
  return Object.freeze({
    generation: policy.generation,
    reviewerUserIds: Object.freeze(reviewerUserIds),
    provenance,
  });
}

function readIssueAuthor(
  input: unknown,
  candidate: Readonly<{
    repository: SourceAcceptanceRepositoryIdentity;
    sourceIssue: number;
  }>,
): ReturnType<typeof readActor> | "mismatch" {
  const evidence = recordWithKeys(input, ["repository", "sourceIssue", "author"]);
  if (evidence === undefined) return undefined;
  const repository = readRepository(evidence.repository);
  if (
    repository === undefined ||
    !sameRepository(repository, candidate.repository) ||
    evidence.sourceIssue !== candidate.sourceIssue
  ) {
    return "mismatch";
  }
  return readActor(evidence.author, candidate.repository.host);
}

function readPullRequestAuthor(
  input: unknown,
  candidate: Readonly<{
    repository: SourceAcceptanceRepositoryIdentity;
    integrationPullRequest: SourceAcceptancePullRequestIdentity;
  }>,
): ReturnType<typeof readActor> | "mismatch" {
  const evidence = recordWithKeys(input, ["repository", "pullRequest", "author"]);
  if (evidence === undefined) return undefined;
  const repository = readRepository(evidence.repository);
  const pullRequest = readPullRequest(evidence.pullRequest);
  if (
    repository === undefined ||
    pullRequest === undefined ||
    !sameRepository(repository, candidate.repository) ||
    pullRequest.number !== candidate.integrationPullRequest.number ||
    pullRequest.headSha !== candidate.integrationPullRequest.headSha
  ) {
    return "mismatch";
  }
  return readActor(evidence.author, candidate.repository.host);
}

function readProvenance(input: unknown): SourceAcceptancePolicyProvenance | undefined {
  const provenance = recordWithKeys(input, [
    "authority",
    "repository",
    "ref",
    "commitSha",
    "treeSha",
    "source",
    "generation",
  ]);
  if (
    provenance === undefined ||
    provenance.authority !== "repository-default-branch" ||
    !isSafeRef(provenance.ref) ||
    !isGitObjectSha(provenance.commitSha) ||
    !isGitObjectSha(provenance.treeSha) ||
    !Number.isSafeInteger(provenance.generation) ||
    typeof provenance.generation !== "number" ||
    provenance.generation <= 0
  ) {
    return undefined;
  }
  const repository = readRepository(provenance.repository);
  const source = recordWithKeys(provenance.source, ["path", "ref", "blobSha", "digest"]);
  if (
    repository === undefined ||
    source === undefined ||
    source.path !== SOURCE_ACCEPTANCE_POLICY_PATH ||
    source.ref !== provenance.ref ||
    !isGitObjectSha(source.blobSha) ||
    typeof source.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(source.digest)
  ) {
    return undefined;
  }
  return Object.freeze({
    authority: "repository-default-branch",
    repository,
    ref: provenance.ref,
    commitSha: provenance.commitSha,
    treeSha: provenance.treeSha,
    source: Object.freeze({
      path: SOURCE_ACCEPTANCE_POLICY_PATH,
      ref: source.ref,
      blobSha: source.blobSha,
      digest: source.digest,
    }),
    generation: provenance.generation,
  });
}

function readContributors(
  input: unknown,
  candidate: Readonly<{
    repository: SourceAcceptanceRepositoryIdentity;
    integrationPullRequest: SourceAcceptancePullRequestIdentity;
  }>,
):
  | Readonly<{ kind: "valid"; humanUserIds: readonly string[] }>
  | Readonly<{ kind: "denied"; code: SourceAcceptanceReviewerDiagnosticCode }> {
  const evidence = recordWithKeys(input, ["repository", "pullRequest", "pagination", "observedHeadSha", "commits"]);
  if (evidence === undefined) return Object.freeze({ kind: "denied", code: "CONTRIBUTOR_EVIDENCE_INVALID" });
  const repository = readRepository(evidence.repository);
  const pullRequest = readPullRequest(evidence.pullRequest);
  if (repository === undefined || pullRequest === undefined || !isGitObjectSha(evidence.observedHeadSha)) {
    return Object.freeze({ kind: "denied", code: "CONTRIBUTOR_EVIDENCE_INVALID" });
  }
  if (
    !sameRepository(repository, candidate.repository) ||
    pullRequest.number !== candidate.integrationPullRequest.number ||
    pullRequest.headSha !== candidate.integrationPullRequest.headSha ||
    evidence.observedHeadSha !== candidate.integrationPullRequest.headSha
  ) {
    return Object.freeze({ kind: "denied", code: "CONTRIBUTOR_EVIDENCE_MISMATCH" });
  }
  if (evidence.pagination !== "complete") {
    return Object.freeze({ kind: "denied", code: "CONTRIBUTOR_EVIDENCE_INCOMPLETE" });
  }
  if (!Array.isArray(evidence.commits) || evidence.commits.length === 0) {
    return Object.freeze({ kind: "denied", code: "CONTRIBUTOR_EVIDENCE_INCOMPLETE" });
  }

  const ids = new Set<string>();
  const commitShas = new Set<string>();
  for (const commitInput of evidence.commits) {
    const commit = recordWithOptionalKeys(commitInput, ["sha", "author", "coAuthors"], ["committer"]);
    if (commit === undefined || !isGitObjectSha(commit.sha)) {
      return Object.freeze({ kind: "denied", code: "CONTRIBUTOR_EVIDENCE_INVALID" });
    }
    if (commitShas.has(commit.sha)) {
      return Object.freeze({ kind: "denied", code: "CONTRIBUTOR_EVIDENCE_INVALID" });
    }
    commitShas.add(commit.sha);

    const author = readActor(commit.author, candidate.repository.host);
    if (author === undefined || author.classification === "unknown") {
      return Object.freeze({ kind: "denied", code: "CONTRIBUTOR_IDENTITY_UNAVAILABLE" });
    }
    if (author.classification === "human") ids.add(author.userId);

    const coAuthors = recordWithKeys(commit.coAuthors, ["resolution", "actors"]);
    if (coAuthors === undefined || !Array.isArray(coAuthors.actors)) {
      return Object.freeze({ kind: "denied", code: "CONTRIBUTOR_EVIDENCE_INVALID" });
    }
    if (coAuthors.resolution !== "complete") {
      return Object.freeze({ kind: "denied", code: "CONTRIBUTOR_EVIDENCE_INCOMPLETE" });
    }
    for (const coAuthorInput of coAuthors.actors) {
      const coAuthor = readActor(coAuthorInput, candidate.repository.host);
      if (coAuthor === undefined || coAuthor.classification === "unknown") {
        return Object.freeze({ kind: "denied", code: "CONTRIBUTOR_IDENTITY_UNAVAILABLE" });
      }
      if (coAuthor.classification === "human") ids.add(coAuthor.userId);
    }

    // The provider committer is intentionally not added to the contributor set.
    // Validate its shape if present, while allowing unresolved classification:
    // a committer's human/bot status is not needed for reviewer independence.
    if ("committer" in commit && !isActorEvidenceShape(commit.committer)) {
      return Object.freeze({ kind: "denied", code: "CONTRIBUTOR_EVIDENCE_INVALID" });
    }
  }
  if (!commitShas.has(candidate.integrationPullRequest.headSha)) {
    return Object.freeze({ kind: "denied", code: "CONTRIBUTOR_EVIDENCE_MISMATCH" });
  }
  return Object.freeze({ kind: "valid", humanUserIds: Object.freeze([...ids]) });
}

function readActor(
  input: unknown,
  expectedHost: string,
):
  | (HumanIdentity & { classification: ActorClass })
  | { classification: "bot" | "unknown"; providerHost: string }
  | undefined {
  if (!isActorEvidenceShape(input)) return undefined;
  const actor = input as Record<string, unknown>;
  if (actor.providerHost !== expectedHost) return undefined;
  if (actor.classification === "human" && isUserId(actor.userId)) {
    return Object.freeze({ classification: "human", providerHost: expectedHost, userId: actor.userId });
  }
  if (actor.classification === "bot" || actor.classification === "unknown") {
    return Object.freeze({ classification: actor.classification, providerHost: expectedHost });
  }
  return undefined;
}

function isActorEvidenceShape(input: unknown): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const actor = input as Record<string, unknown>;
  if (actor.classification === "human") {
    return (
      recordWithKeys(input, ["classification", "providerHost", "userId"]) !== undefined &&
      typeof actor.providerHost === "string"
    );
  }
  if (actor.classification === "bot" || actor.classification === "unknown") {
    return (
      recordWithKeys(input, ["classification", "providerHost"]) !== undefined && typeof actor.providerHost === "string"
    );
  }
  return false;
}

function readRepository(input: unknown): SourceAcceptanceRepositoryIdentity | undefined {
  const repository = recordWithKeys(input, ["host", "id"]);
  if (
    repository === undefined ||
    typeof repository.host !== "string" ||
    !HOST_PATTERN.test(repository.host) ||
    repository.host !== repository.host.toLowerCase() ||
    !isRepositoryId(repository.id)
  ) {
    return undefined;
  }
  return Object.freeze({ host: repository.host, id: repository.id });
}

function readPullRequest(input: unknown): SourceAcceptancePullRequestIdentity | undefined {
  const pullRequest = recordWithKeys(input, ["number", "headSha"]);
  if (
    pullRequest === undefined ||
    typeof pullRequest.number !== "number" ||
    !Number.isSafeInteger(pullRequest.number) ||
    pullRequest.number <= 0 ||
    !isGitObjectSha(pullRequest.headSha)
  ) {
    return undefined;
  }
  return Object.freeze({ number: pullRequest.number, headSha: pullRequest.headSha });
}

function recordWithKeys(input: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    keys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })
  ) {
    return undefined;
  }
  return input as Record<string, unknown>;
}

function recordWithOptionalKeys(
  input: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.some((key) => typeof key !== "string" || (!requiredKeys.includes(key) && !optionalKeys.includes(key))) ||
    requiredKeys.some((key) => !ownKeys.includes(key))
  ) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    ownKeys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = descriptors[key];
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })
  ) {
    return undefined;
  }
  return input as Record<string, unknown>;
}

function denied(code: SourceAcceptanceReviewerDiagnosticCode): SourceAcceptanceReviewerEvaluation {
  return Object.freeze({
    classification: "denied" as const,
    diagnostics: Object.freeze([Object.freeze({ code, message: DIAGNOSTIC_MESSAGES[code] })]) as readonly [
      SourceAcceptanceReviewerDiagnostic,
    ],
  });
}

function freezeProvenance(provenance: SourceAcceptancePolicyProvenance): SourceAcceptancePolicyProvenance {
  return Object.freeze({
    authority: provenance.authority,
    repository: Object.freeze({ ...provenance.repository }),
    ref: provenance.ref,
    commitSha: provenance.commitSha,
    treeSha: provenance.treeSha,
    source: Object.freeze({ ...provenance.source }),
    generation: provenance.generation,
  });
}

function sameRepository(left: SourceAcceptanceRepositoryIdentity, right: SourceAcceptanceRepositoryIdentity): boolean {
  return left.host === right.host && left.id === right.id;
}

function isUserId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_IDENTITY_LENGTH && DECIMAL_ID_PATTERN.test(value);
}

function isRepositoryId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && DECIMAL_ID_PATTERN.test(value);
}

function isGitObjectSha(value: unknown): value is string {
  return typeof value === "string" && GIT_OBJECT_SHA_PATTERN.test(value);
}

function isSafeRef(value: unknown): value is string {
  return typeof value === "string" && SAFE_REF_PATTERN.test(value);
}
