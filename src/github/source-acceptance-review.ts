/** Read-only GitHub review carrier for a current Source acceptance candidate. */
import {
  SOURCE_ACCEPTANCE_LIMITS,
  serializeSourceAcceptanceRecord,
  sourceAcceptanceCriteriaDigest,
  validateSourceAcceptanceRecord,
  type SourceAcceptanceCandidate,
  type SourceAcceptanceRecord,
  type SourceAcceptanceDiagnostic,
} from "../source-acceptance.js";
import type { GitHubOperationalPullRequestEvidence } from "./types.js";

export interface SourceAcceptanceReviewReader {
  observePullRequest(number: number): Promise<GitHubOperationalPullRequestEvidence>;
}

export interface SourceAcceptanceReviewCarrier {
  readonly reviewId: number;
  readonly authorId: string;
  readonly commitId: string;
  readonly submittedAt: string;
}

export interface SourceAcceptanceReviewDiagnostic {
  readonly code: string;
  readonly reviewId?: number;
}

export type SourceAcceptanceReviewObservation =
  | Readonly<{
      classification: "present";
      record: SourceAcceptanceRecord;
      carrier: SourceAcceptanceReviewCarrier;
      diagnostics: readonly [];
    }>
  | Readonly<{
      classification: "absent" | "unavailable" | "invalid" | "ambiguous";
      diagnostics: readonly SourceAcceptanceReviewDiagnostic[];
    }>;

const MAX_DIAGNOSTICS = SOURCE_ACCEPTANCE_LIMITS.diagnostics;
const SUBMITTED_STATES = new Set(["APPROVED", "COMMENTED", "CHANGES_REQUESTED"]);

function failure(
  classification: "unavailable" | "invalid" | "ambiguous",
  code: string,
  reviewId?: number,
): SourceAcceptanceReviewObservation {
  return { classification, diagnostics: [{ code, ...(reviewId === undefined ? {} : { reviewId }) }] };
}

function coreDiagnostics(
  diagnostics: readonly SourceAcceptanceDiagnostic[],
  reviewId: number,
): SourceAcceptanceReviewDiagnostic[] {
  return diagnostics.slice(0, MAX_DIAGNOSTICS).map(({ code }) => ({ code, reviewId }));
}

function isHistoricalBinding(diagnostics: readonly SourceAcceptanceDiagnostic[]): boolean {
  const bindingCodes = new Set([
    "REPOSITORY_MISMATCH",
    "SOURCE_MISMATCH",
    "INTEGRATION_PR_MISMATCH",
    "INTEGRATION_HEAD_MISMATCH",
    "CRITERIA_VERSION_STALE",
    "CRITERIA_DIGEST_STALE",
  ]);
  return diagnostics.length > 0 && diagnostics.every(({ code }) => bindingCodes.has(code));
}

function validSubmittedAt(value: string | undefined): value is string {
  if (value === undefined || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(value))
    return false;
  return Number.isFinite(Date.parse(value));
}

/**
 * Observe a complete review collection through the credential-bound provider
 * reader. A present result is carrier evidence, not reviewer authorization,
 * Change policy acceptance, or Source completion.
 */
export async function observeSourceAcceptanceReview(
  reader: SourceAcceptanceReviewReader,
  candidate: SourceAcceptanceCandidate,
): Promise<SourceAcceptanceReviewObservation> {
  try {
    sourceAcceptanceCriteriaDigest(candidate.criteria);
  } catch {
    return failure("invalid", "CANDIDATE_INVALID");
  }
  if (
    !/^[a-z0-9.-]+$/u.test(candidate.repository.host) ||
    !/^[1-9][0-9]*$/u.test(candidate.repository.id) ||
    !Number.isSafeInteger(candidate.sourceIssue) ||
    candidate.sourceIssue <= 0 ||
    !Number.isSafeInteger(candidate.integrationPullRequest.number) ||
    candidate.integrationPullRequest.number <= 0 ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(candidate.integrationPullRequest.headSha)
  )
    return failure("invalid", "CANDIDATE_INVALID");

  let observed: GitHubOperationalPullRequestEvidence;
  try {
    observed = await reader.observePullRequest(candidate.integrationPullRequest.number);
  } catch {
    return failure("unavailable", "PULL_REQUEST_UNAVAILABLE");
  }
  if (
    observed.repository.host !== candidate.repository.host ||
    observed.repository.repositoryId !== candidate.repository.id ||
    observed.number !== candidate.integrationPullRequest.number ||
    observed.head.sha !== candidate.integrationPullRequest.headSha ||
    observed.provenance.provider !== "github"
  )
    return failure("invalid", "PULL_REQUEST_IDENTITY_MISMATCH");
  if (
    observed.reviews.status !== "available" ||
    observed.reviews.pagination.truncated ||
    observed.reviews.pagination.nextPage !== undefined
  ) {
    return failure("unavailable", "REVIEWS_INCOMPLETE");
  }

  const current: { record: SourceAcceptanceRecord; carrier: SourceAcceptanceReviewCarrier }[] = [];
  const invalid: SourceAcceptanceReviewDiagnostic[] = [];
  for (const review of observed.reviews.items) {
    const body = review.body;
    if (body === null || !body.trimStart().startsWith("{")) continue;
    if (Buffer.byteLength(body, "utf8") > SOURCE_ACCEPTANCE_LIMITS.recordBytes) {
      invalid.push({ code: "RECORD_OVERSIZED", reviewId: review.id });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      invalid.push({ code: "RECORD_MALFORMED", reviewId: review.id });
      continue;
    }
    let canonical: string;
    try {
      canonical = serializeSourceAcceptanceRecord(parsed);
    } catch (error) {
      const diagnostics =
        error instanceof Error && "diagnostics" in error
          ? (error as { diagnostics: readonly SourceAcceptanceDiagnostic[] }).diagnostics
          : [];
      invalid.push(
        ...(diagnostics.length > 0
          ? coreDiagnostics(diagnostics, review.id)
          : [{ code: "RECORD_MALFORMED", reviewId: review.id }]),
      );
      continue;
    }
    if (canonical !== body) {
      invalid.push({ code: "RECORD_NON_CANONICAL", reviewId: review.id });
      continue;
    }
    const validated = validateSourceAcceptanceRecord(canonical, candidate);
    if (validated.classification === "rejected") {
      if (!isHistoricalBinding(validated.diagnostics))
        invalid.push(...coreDiagnostics(validated.diagnostics, review.id));
      continue;
    }
    const authorId = review.author?.id;
    if (
      !Number.isSafeInteger(authorId) ||
      authorId === undefined ||
      authorId <= 0 ||
      String(authorId) !== validated.record.reviewer.userId
    ) {
      invalid.push({ code: "REVIEW_AUTHOR_MISMATCH", reviewId: review.id });
      continue;
    }
    if (validated.record.reviewer.providerHost !== observed.repository.host) {
      invalid.push({ code: "REVIEW_PROVIDER_MISMATCH", reviewId: review.id });
      continue;
    }
    if (review.commitId !== candidate.integrationPullRequest.headSha) {
      invalid.push({ code: "REVIEW_COMMIT_MISMATCH", reviewId: review.id });
      continue;
    }
    if (!SUBMITTED_STATES.has(review.state) || !validSubmittedAt(review.submittedAt)) {
      invalid.push({ code: "REVIEW_NOT_SUBMITTED", reviewId: review.id });
      continue;
    }
    current.push({
      record: validated.record,
      carrier: {
        reviewId: review.id,
        authorId: String(authorId),
        commitId: review.commitId,
        submittedAt: review.submittedAt,
      },
    });
  }
  if (invalid.length > 0) return { classification: "invalid", diagnostics: invalid.slice(0, MAX_DIAGNOSTICS) };
  if (current.length > 1) return failure("ambiguous", "MULTIPLE_CURRENT_RECORDS");
  if (current.length === 0) return { classification: "absent", diagnostics: [] };
  return { classification: "present", ...current[0]!, diagnostics: [] };
}
