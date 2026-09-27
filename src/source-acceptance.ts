/**
 * Pure, bounded Core contract for reviewer-owned Source acceptance evidence.
 *
 * This module validates record shape, criteria coverage, and binding to the
 * candidate and criteria snapshot supplied by its caller. It does not verify
 * reviewer authority or independence, current Change policy, provider state,
 * or Source completion.
 */

import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { canonicalJsonString, type CanonicalJsonValue } from "./agent-authority/codec.js";

export const SOURCE_ACCEPTANCE_RECORD_VERSION = 1 as const;
export type SourceAcceptanceRecordVersion = typeof SOURCE_ACCEPTANCE_RECORD_VERSION;

export const SOURCE_ACCEPTANCE_LIMITS = Object.freeze({
  recordBytes: 16_384,
  diagnostics: 32,
  diagnosticPathLength: 160,
  diagnosticMessageLength: 240,
  hostLength: 255,
  repositoryIdLength: 32,
  reviewerIdLength: 20,
  headShaLength: 64,
  criteriaCount: 64,
  criteriaIdLength: 128,
  criterionTextBytes: 2_048,
  criteriaSnapshotBytes: 65_536,
} as const);

export interface SourceAcceptanceRepositoryIdentity {
  readonly host: string;
  /** Decimal GitHub repository database identity, scoped to `host`. */
  readonly id: string;
}

export interface SourceAcceptancePullRequestIdentity {
  readonly number: number;
  /** Lowercase hexadecimal commit object ID observed for the composed candidate. */
  readonly headSha: string;
}

export interface SourceAcceptanceCriterion {
  /** Stable, opaque identifier supplied with the current Source criteria. */
  readonly id: string;
  /** Exact criterion text; digest binding preserves its UTF-8 content. */
  readonly text: string;
}

export interface SourceAcceptanceCriteriaSnapshot {
  readonly version: number;
  readonly criteria: readonly SourceAcceptanceCriterion[];
}

export interface SourceAcceptanceReviewerIdentity {
  readonly providerHost: string;
  /** Decimal immutable provider user ID, not a login or authority assertion. */
  readonly userId: string;
}

export interface SourceAcceptanceCriterionResult {
  readonly criterionId: string;
  readonly result: "pass" | "fail";
}

/**
 * Version 1 records identity and outcomes only. Reviewer authorization,
 * independence, policy acceptance, and completion are established elsewhere.
 */
export interface SourceAcceptanceRecord {
  readonly version: SourceAcceptanceRecordVersion;
  readonly repository: SourceAcceptanceRepositoryIdentity;
  readonly sourceIssue: number;
  readonly integrationPullRequest: SourceAcceptancePullRequestIdentity;
  readonly criteria: Readonly<{ version: number; digest: string }>;
  readonly reviewer: SourceAcceptanceReviewerIdentity;
  readonly results: readonly SourceAcceptanceCriterionResult[];
}

/** Exact candidate and current criteria snapshot against which a record is checked. */
export interface SourceAcceptanceCandidate {
  readonly repository: SourceAcceptanceRepositoryIdentity;
  readonly sourceIssue: number;
  readonly integrationPullRequest: SourceAcceptancePullRequestIdentity;
  readonly criteria: SourceAcceptanceCriteriaSnapshot;
}

export type SourceAcceptanceDiagnosticCode =
  | "RECORD_MALFORMED"
  | "RECORD_OVERSIZED"
  | "RECORD_NON_CANONICAL"
  | "RECORD_VERSION_UNSUPPORTED"
  | "CANDIDATE_INVALID"
  | "CRITERIA_SNAPSHOT_INVALID"
  | "REPOSITORY_MISMATCH"
  | "SOURCE_MISMATCH"
  | "INTEGRATION_PR_MISMATCH"
  | "INTEGRATION_HEAD_MISMATCH"
  | "CRITERIA_VERSION_STALE"
  | "CRITERIA_DIGEST_STALE"
  | "CRITERION_RESULT_MISSING"
  | "CRITERION_RESULT_DUPLICATE"
  | "CRITERION_RESULT_UNKNOWN"
  | "CRITERION_FAILED";

export interface SourceAcceptanceDiagnostic {
  readonly code: SourceAcceptanceDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

/**
 * `valid-for-supplied-candidate` means only that the immutable binding and
 * every supplied criterion result match and pass. It is not a reviewer
 * authorization, Change-policy, provider, or Source-completion decision.
 */
export type SourceAcceptanceValidationResult =
  | Readonly<{
      classification: "valid-for-supplied-candidate";
      record: SourceAcceptanceRecord;
      diagnostics: readonly [];
    }>
  | Readonly<{
      classification: "rejected";
      diagnostics: readonly SourceAcceptanceDiagnostic[];
    }>;

export class SourceAcceptanceRecordError extends TypeError {
  readonly diagnostics: readonly SourceAcceptanceDiagnostic[];

  constructor(diagnostics: readonly SourceAcceptanceDiagnostic[]) {
    super(diagnostics.map((item) => `${item.path}: ${item.message}`).join("\n"));
    this.name = "SourceAcceptanceRecordError";
    this.diagnostics = Object.freeze([...diagnostics].slice(0, SOURCE_ACCEPTANCE_LIMITS.diagnostics));
  }
}

/**
 * Hash the canonical current criteria snapshot. Criteria are a set keyed by
 * ID, so input order does not change their digest; text and version changes do.
 */
export function sourceAcceptanceCriteriaDigest(snapshot: SourceAcceptanceCriteriaSnapshot): string {
  const normalized = normalizeCriteriaSnapshot(snapshot);
  if (normalized.diagnostics.length > 0 || normalized.value === undefined) {
    throw new SourceAcceptanceRecordError(normalized.diagnostics);
  }
  return createHash("sha256")
    .update(canonicalJsonString(criteriaCanonicalValue(normalized.value)), "utf8")
    .digest("hex");
}

/**
 * Return deterministic canonical JSON for a structurally sound record.
 * Failing outcomes remain serializable evidence; duplicate criterion results
 * do not, because they make the per-criterion result ambiguous.
 */
export function serializeSourceAcceptanceRecord(input: unknown): string {
  const normalized = normalizeRecordObject(input);
  if (normalized.diagnostics.length > 0 || normalized.value === undefined) {
    throw new SourceAcceptanceRecordError(normalized.diagnostics);
  }
  const duplicateResults = duplicateResultDiagnostics(normalized.value.results);
  if (duplicateResults.length > 0) throw new SourceAcceptanceRecordError(duplicateResults);
  const serialized = canonicalJsonString(normalized.value as unknown as CanonicalJsonValue);
  if (Buffer.byteLength(serialized, "utf8") > SOURCE_ACCEPTANCE_LIMITS.recordBytes) {
    throw new SourceAcceptanceRecordError([
      diagnostic("RECORD_OVERSIZED", "$", "Serialized Source acceptance record exceeds its byte bound."),
    ]);
  }
  return serialized;
}

/**
 * Validate an object or canonical JSON representation against the supplied
 * Source integration candidate and current Source criteria snapshot.
 */
export function validateSourceAcceptanceRecord(
  input: unknown,
  candidateInput: SourceAcceptanceCandidate,
): SourceAcceptanceValidationResult {
  const readRecord = readRecordInput(input);
  if (readRecord.diagnostics.length > 0 || readRecord.value === undefined) {
    return rejected(readRecord.diagnostics);
  }

  const readCandidate = normalizeCandidate(candidateInput);
  if (readCandidate.diagnostics.length > 0 || readCandidate.value === undefined) {
    return rejected(readCandidate.diagnostics);
  }

  const record = readRecord.value;
  const candidate = readCandidate.value;
  const criteriaDigest = createHash("sha256")
    .update(canonicalJsonString(criteriaCanonicalValue(candidate.criteria)), "utf8")
    .digest("hex");
  const bindingDiagnostics: SourceAcceptanceDiagnostic[] = [];

  if (record.repository.host !== candidate.repository.host || record.repository.id !== candidate.repository.id) {
    bindingDiagnostics.push(
      diagnostic("REPOSITORY_MISMATCH", "$.repository", "Record repository does not match the supplied candidate."),
    );
  }
  if (record.sourceIssue !== candidate.sourceIssue) {
    bindingDiagnostics.push(
      diagnostic("SOURCE_MISMATCH", "$.sourceIssue", "Record Source Issue does not match the supplied candidate."),
    );
  }
  if (record.integrationPullRequest.number !== candidate.integrationPullRequest.number) {
    bindingDiagnostics.push(
      diagnostic(
        "INTEGRATION_PR_MISMATCH",
        "$.integrationPullRequest.number",
        "Record integration PR does not match the supplied candidate.",
      ),
    );
  }
  if (record.integrationPullRequest.headSha !== candidate.integrationPullRequest.headSha) {
    bindingDiagnostics.push(
      diagnostic(
        "INTEGRATION_HEAD_MISMATCH",
        "$.integrationPullRequest.headSha",
        "Record integration head does not match the supplied candidate.",
      ),
    );
  }
  if (record.criteria.version !== candidate.criteria.version) {
    bindingDiagnostics.push(
      diagnostic("CRITERIA_VERSION_STALE", "$.criteria.version", "Record criteria version is stale."),
    );
  }
  if (record.criteria.digest !== criteriaDigest) {
    bindingDiagnostics.push(
      diagnostic("CRITERIA_DIGEST_STALE", "$.criteria.digest", "Record criteria digest is stale."),
    );
  }
  if (bindingDiagnostics.length > 0) return rejected(bindingDiagnostics);

  const resultDiagnostics: SourceAcceptanceDiagnostic[] = [];
  const currentIds = new Set(candidate.criteria.criteria.map((criterion) => criterion.id));
  const seen = new Set<string>();
  for (const result of record.results) {
    if (seen.has(result.criterionId)) {
      resultDiagnostics.push(
        diagnostic("CRITERION_RESULT_DUPLICATE", "$.results", "A criterion has more than one recorded result."),
      );
      continue;
    }
    seen.add(result.criterionId);
    if (!currentIds.has(result.criterionId)) {
      resultDiagnostics.push(
        diagnostic("CRITERION_RESULT_UNKNOWN", "$.results", "A result names no current Source criterion."),
      );
    } else if (result.result === "fail") {
      resultDiagnostics.push(
        diagnostic("CRITERION_FAILED", "$.results", "At least one current Source criterion failed."),
      );
    }
  }
  for (const criterion of candidate.criteria.criteria) {
    if (!seen.has(criterion.id)) {
      resultDiagnostics.push(
        diagnostic("CRITERION_RESULT_MISSING", "$.results", "A current Source criterion has no result."),
      );
    }
  }
  if (resultDiagnostics.length > 0) return rejected(resultDiagnostics);

  return Object.freeze({
    classification: "valid-for-supplied-candidate" as const,
    record,
    diagnostics: Object.freeze([]) as readonly [],
  });
}

interface NormalizeResult<T> {
  readonly value?: T;
  readonly diagnostics: readonly SourceAcceptanceDiagnostic[];
}

function readRecordInput(input: unknown): NormalizeResult<SourceAcceptanceRecord> {
  let value = input;
  let sourceText: string | undefined;
  if (typeof input === "string") {
    sourceText = input;
  } else if (input instanceof Uint8Array) {
    if (input.byteLength > SOURCE_ACCEPTANCE_LIMITS.recordBytes) {
      return failure("RECORD_OVERSIZED", "$", "Source acceptance record exceeds its input byte bound.");
    }
    if (input.byteLength >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
      return failure("RECORD_MALFORMED", "$", "Source acceptance record is not valid canonical JSON.");
    }
    try {
      sourceText = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      return failure("RECORD_MALFORMED", "$", "Source acceptance record is not valid UTF-8 JSON.");
    }
  }

  if (sourceText !== undefined) {
    if (Buffer.byteLength(sourceText, "utf8") > SOURCE_ACCEPTANCE_LIMITS.recordBytes) {
      return failure("RECORD_OVERSIZED", "$", "Source acceptance record exceeds its input byte bound.");
    }
    try {
      value = JSON.parse(sourceText) as unknown;
    } catch {
      return failure("RECORD_MALFORMED", "$", "Source acceptance record is not valid JSON.");
    }
  }

  const normalized = normalizeRecordObject(value);
  if (normalized.diagnostics.length > 0 || normalized.value === undefined) return normalized;
  const canonical = canonicalJsonString(normalized.value as unknown as CanonicalJsonValue);
  if (Buffer.byteLength(canonical, "utf8") > SOURCE_ACCEPTANCE_LIMITS.recordBytes) {
    return failure("RECORD_OVERSIZED", "$", "Source acceptance record exceeds its canonical byte bound.");
  }
  if (sourceText !== undefined && sourceText !== canonical) {
    return failure("RECORD_NON_CANONICAL", "$", "Serialized Source acceptance record is not canonical JSON.");
  }
  return { value: normalized.value, diagnostics: Object.freeze([]) };
}

function normalizeRecordObject(input: unknown): NormalizeResult<SourceAcceptanceRecord> {
  const diagnostics: SourceAcceptanceDiagnostic[] = [];
  const root = exactObject(
    input,
    ["version", "repository", "sourceIssue", "integrationPullRequest", "criteria", "reviewer", "results"],
    "$",
    diagnostics,
  );
  if (root === undefined) return { diagnostics: freezeDiagnostics(diagnostics) };

  if (root.version !== SOURCE_ACCEPTANCE_RECORD_VERSION) {
    diagnostics.push(
      diagnostic("RECORD_VERSION_UNSUPPORTED", "$.version", "Source acceptance record version is unsupported."),
    );
  }
  const repository = normalizeRepository(root.repository, "$.repository", diagnostics);
  const sourceIssue = positiveSafeInteger(root.sourceIssue, "$.sourceIssue", "RECORD_MALFORMED", diagnostics);
  const integrationPullRequest = normalizePullRequest(
    root.integrationPullRequest,
    "$.integrationPullRequest",
    diagnostics,
  );
  const criteria = normalizeCriteriaBinding(root.criteria, diagnostics);
  const reviewer = normalizeReviewer(root.reviewer, diagnostics);
  const results = normalizeResults(root.results, diagnostics);

  if (
    diagnostics.length > 0 ||
    repository === undefined ||
    sourceIssue === undefined ||
    integrationPullRequest === undefined ||
    criteria === undefined ||
    reviewer === undefined ||
    results === undefined
  ) {
    return { diagnostics: freezeDiagnostics(diagnostics) };
  }

  const record: SourceAcceptanceRecord = Object.freeze({
    version: SOURCE_ACCEPTANCE_RECORD_VERSION,
    repository,
    sourceIssue,
    integrationPullRequest,
    criteria,
    reviewer,
    results: Object.freeze(results),
  });
  const bytes = Buffer.byteLength(canonicalJsonString(record as unknown as CanonicalJsonValue), "utf8");
  if (bytes > SOURCE_ACCEPTANCE_LIMITS.recordBytes) {
    return failure("RECORD_OVERSIZED", "$", "Source acceptance record exceeds its canonical byte bound.");
  }
  return { value: record, diagnostics: Object.freeze([]) };
}

function normalizeCandidate(input: unknown): NormalizeResult<NormalizedCandidate> {
  const diagnostics: SourceAcceptanceDiagnostic[] = [];
  const candidate = exactObject(
    input,
    ["repository", "sourceIssue", "integrationPullRequest", "criteria"],
    "$candidate",
    diagnostics,
  );
  if (candidate === undefined) {
    return {
      diagnostics: freezeDiagnostics(diagnostics.map((item) => ({ ...item, code: "CANDIDATE_INVALID" as const }))),
    };
  }
  const repository = normalizeRepository(
    candidate.repository,
    "$candidate.repository",
    diagnostics,
    "CANDIDATE_INVALID",
  );
  const sourceIssue = positiveSafeInteger(
    candidate.sourceIssue,
    "$candidate.sourceIssue",
    "CANDIDATE_INVALID",
    diagnostics,
  );
  const integrationPullRequest = normalizePullRequest(
    candidate.integrationPullRequest,
    "$candidate.integrationPullRequest",
    diagnostics,
    "CANDIDATE_INVALID",
  );
  const criteriaRead = normalizeCriteriaSnapshot(candidate.criteria);
  if (criteriaRead.diagnostics.length > 0 || criteriaRead.value === undefined) {
    diagnostics.push(...criteriaRead.diagnostics);
  }
  if (
    diagnostics.length > 0 ||
    repository === undefined ||
    sourceIssue === undefined ||
    integrationPullRequest === undefined ||
    criteriaRead.value === undefined
  ) {
    return { diagnostics: freezeDiagnostics(diagnostics) };
  }
  return {
    value: Object.freeze({ repository, sourceIssue, integrationPullRequest, criteria: criteriaRead.value }),
    diagnostics: Object.freeze([]),
  };
}

interface NormalizedCandidate {
  readonly repository: SourceAcceptanceRepositoryIdentity;
  readonly sourceIssue: number;
  readonly integrationPullRequest: SourceAcceptancePullRequestIdentity;
  readonly criteria: SourceAcceptanceCriteriaSnapshot;
}

function normalizeCriteriaSnapshot(input: unknown): NormalizeResult<SourceAcceptanceCriteriaSnapshot> {
  const diagnostics: SourceAcceptanceDiagnostic[] = [];
  const snapshot = exactObject(input, ["version", "criteria"], "$criteria", diagnostics);
  if (snapshot === undefined) {
    return {
      diagnostics: freezeDiagnostics(
        diagnostics.map((item) => ({ ...item, code: "CRITERIA_SNAPSHOT_INVALID" as const })),
      ),
    };
  }
  const version = positiveSafeInteger(snapshot.version, "$criteria.version", "CRITERIA_SNAPSHOT_INVALID", diagnostics);
  if (!Array.isArray(snapshot.criteria) || snapshot.criteria.length === 0) {
    diagnostics.push(
      diagnostic("CRITERIA_SNAPSHOT_INVALID", "$criteria.criteria", "Current criteria must be a non-empty array."),
    );
  } else if (snapshot.criteria.length > SOURCE_ACCEPTANCE_LIMITS.criteriaCount) {
    diagnostics.push(
      diagnostic("CRITERIA_SNAPSHOT_INVALID", "$criteria.criteria", "Current criteria exceed the item bound."),
    );
  }
  const criteria: SourceAcceptanceCriterion[] = [];
  if (Array.isArray(snapshot.criteria) && snapshot.criteria.length <= SOURCE_ACCEPTANCE_LIMITS.criteriaCount) {
    for (const [index, entry] of snapshot.criteria.entries()) {
      const path = `$criteria.criteria[${index}]`;
      const item = exactObject(entry, ["id", "text"], path, diagnostics);
      if (item === undefined) continue;
      const id = criterionId(item.id, `${path}.id`, "CRITERIA_SNAPSHOT_INVALID", diagnostics);
      const text = criterionText(item.text, `${path}.text`, diagnostics);
      if (id !== undefined && text !== undefined) criteria.push(Object.freeze({ id, text }));
    }
  }
  const seen = new Set<string>();
  for (const criterion of criteria) {
    if (seen.has(criterion.id)) {
      diagnostics.push(
        diagnostic(
          "CRITERIA_SNAPSHOT_INVALID",
          "$criteria.criteria",
          "Current criteria contain a duplicate identifier.",
        ),
      );
      break;
    }
    seen.add(criterion.id);
  }
  if (
    version === undefined ||
    !Array.isArray(snapshot.criteria) ||
    criteria.length !== snapshot.criteria.length ||
    diagnostics.length > 0
  ) {
    return { diagnostics: freezeDiagnostics(diagnostics) };
  }
  criteria.sort((left, right) => compareStrings(left.id, right.id));
  const normalized: SourceAcceptanceCriteriaSnapshot = Object.freeze({
    version,
    criteria: Object.freeze(criteria),
  });
  const bytes = Buffer.byteLength(canonicalJsonString(criteriaCanonicalValue(normalized)), "utf8");
  if (bytes > SOURCE_ACCEPTANCE_LIMITS.criteriaSnapshotBytes) {
    return failure(
      "CRITERIA_SNAPSHOT_INVALID",
      "$criteria",
      "Current Source criteria exceed the canonical byte bound.",
    );
  }
  return { value: normalized, diagnostics: Object.freeze([]) };
}

function normalizeRepository(
  input: unknown,
  path: string,
  diagnostics: SourceAcceptanceDiagnostic[],
  code: SourceAcceptanceDiagnosticCode = "RECORD_MALFORMED",
): SourceAcceptanceRepositoryIdentity | undefined {
  const value = exactObject(input, ["host", "id"], path, diagnostics, code);
  if (value === undefined) return undefined;
  const host = hostName(value.host, `${path}.host`, code, diagnostics);
  const id = decimalIdentity(value.id, `${path}.id`, SOURCE_ACCEPTANCE_LIMITS.repositoryIdLength, code, diagnostics);
  if (host === undefined || id === undefined) return undefined;
  return Object.freeze({ host, id });
}

function normalizePullRequest(
  input: unknown,
  path: string,
  diagnostics: SourceAcceptanceDiagnostic[],
  code: SourceAcceptanceDiagnosticCode = "RECORD_MALFORMED",
): SourceAcceptancePullRequestIdentity | undefined {
  const value = exactObject(input, ["number", "headSha"], path, diagnostics, code);
  if (value === undefined) return undefined;
  const number = positiveSafeInteger(value.number, `${path}.number`, code, diagnostics);
  const headSha = value.headSha;
  if (
    typeof headSha !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(headSha) ||
    headSha.length > SOURCE_ACCEPTANCE_LIMITS.headShaLength
  ) {
    diagnostics.push(diagnostic(code, `${path}.headSha`, "Pull request head must be a lowercase Git object ID."));
  }
  if (number === undefined || typeof headSha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(headSha)) {
    return undefined;
  }
  return Object.freeze({ number, headSha });
}

function normalizeCriteriaBinding(
  input: unknown,
  diagnostics: SourceAcceptanceDiagnostic[],
): SourceAcceptanceRecord["criteria"] | undefined {
  const value = exactObject(input, ["version", "digest"], "$.criteria", diagnostics);
  if (value === undefined) return undefined;
  const version = positiveSafeInteger(value.version, "$.criteria.version", "RECORD_MALFORMED", diagnostics);
  const digest = value.digest;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
    diagnostics.push(diagnostic("RECORD_MALFORMED", "$.criteria.digest", "Criteria digest must be lowercase SHA-256."));
  }
  if (version === undefined || typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) return undefined;
  return Object.freeze({ version, digest });
}

function normalizeReviewer(
  input: unknown,
  diagnostics: SourceAcceptanceDiagnostic[],
): SourceAcceptanceReviewerIdentity | undefined {
  const value = exactObject(input, ["providerHost", "userId"], "$.reviewer", diagnostics);
  if (value === undefined) return undefined;
  const providerHost = hostName(value.providerHost, "$.reviewer.providerHost", "RECORD_MALFORMED", diagnostics);
  const userId = decimalIdentity(
    value.userId,
    "$.reviewer.userId",
    SOURCE_ACCEPTANCE_LIMITS.reviewerIdLength,
    "RECORD_MALFORMED",
    diagnostics,
  );
  if (providerHost === undefined || userId === undefined) return undefined;
  return Object.freeze({ providerHost, userId });
}

function normalizeResults(
  input: unknown,
  diagnostics: SourceAcceptanceDiagnostic[],
): SourceAcceptanceCriterionResult[] | undefined {
  if (!Array.isArray(input)) {
    diagnostics.push(diagnostic("RECORD_MALFORMED", "$.results", "Criterion results must be an array."));
    return undefined;
  }
  if (input.length > SOURCE_ACCEPTANCE_LIMITS.criteriaCount) {
    diagnostics.push(diagnostic("RECORD_OVERSIZED", "$.results", "Criterion results exceed the item bound."));
    return undefined;
  }
  const results: SourceAcceptanceCriterionResult[] = [];
  for (const [index, entry] of input.entries()) {
    const path = `$.results[${index}]`;
    const value = exactObject(entry, ["criterionId", "result"], path, diagnostics);
    if (value === undefined) continue;
    const criterionId = criterionIdValue(value.criterionId, `${path}.criterionId`, diagnostics);
    const result = value.result;
    if (result !== "pass" && result !== "fail") {
      diagnostics.push(diagnostic("RECORD_MALFORMED", `${path}.result`, "Criterion result must be pass or fail."));
    }
    if (criterionId !== undefined && (result === "pass" || result === "fail")) {
      results.push(Object.freeze({ criterionId, result }));
    }
  }
  if (results.length !== input.length || diagnostics.length > 0) return undefined;
  results.sort(
    (left, right) => compareStrings(left.criterionId, right.criterionId) || compareStrings(left.result, right.result),
  );
  return results;
}

function exactObject(
  input: unknown,
  expectedKeys: readonly string[],
  path: string,
  diagnostics: SourceAcceptanceDiagnostic[],
  code: SourceAcceptanceDiagnosticCode = "RECORD_MALFORMED",
): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    diagnostics.push(diagnostic(code, path, "Value must be an object."));
    return undefined;
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    diagnostics.push(diagnostic(code, path, "Object prototype is not supported."));
    return undefined;
  }
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string") || keys.length !== expectedKeys.length) {
    diagnostics.push(diagnostic(code, path, "Object has missing, extra, or non-string keys."));
    return undefined;
  }
  const object = input as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(object);
  if (
    expectedKeys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })
  ) {
    diagnostics.push(diagnostic(code, path, "Object has missing or accessor properties."));
    return undefined;
  }
  return object;
}

function hostName(
  value: unknown,
  path: string,
  code: SourceAcceptanceDiagnosticCode,
  diagnostics: SourceAcceptanceDiagnostic[],
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > SOURCE_ACCEPTANCE_LIMITS.hostLength ||
    value !== value.toLowerCase() ||
    !/^(?=.{1,255}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u.test(
      value,
    )
  ) {
    diagnostics.push(diagnostic(code, path, "Host must be a canonical lowercase DNS name."));
    return undefined;
  }
  return value;
}

function decimalIdentity(
  value: unknown,
  path: string,
  maximumLength: number,
  code: SourceAcceptanceDiagnosticCode,
  diagnostics: SourceAcceptanceDiagnostic[],
): string | undefined {
  if (typeof value !== "string" || value.length > maximumLength || !/^[1-9][0-9]*$/u.test(value)) {
    diagnostics.push(diagnostic(code, path, "Identity must be a bounded positive decimal string."));
    return undefined;
  }
  return value;
}

function criterionId(
  value: unknown,
  path: string,
  code: SourceAcceptanceDiagnosticCode,
  diagnostics: SourceAcceptanceDiagnostic[],
): string | undefined {
  const result = criterionIdValue(value, path, diagnostics, code);
  return result;
}

function criterionIdValue(
  value: unknown,
  path: string,
  diagnostics: SourceAcceptanceDiagnostic[],
  code: SourceAcceptanceDiagnosticCode = "RECORD_MALFORMED",
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > SOURCE_ACCEPTANCE_LIMITS.criteriaIdLength ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    diagnostics.push(diagnostic(code, path, "Criterion identifier is malformed or exceeds its bound."));
    return undefined;
  }
  return value;
}

function criterionText(value: unknown, path: string, diagnostics: SourceAcceptanceDiagnostic[]): string | undefined {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > SOURCE_ACCEPTANCE_LIMITS.criterionTextBytes
  ) {
    diagnostics.push(
      diagnostic("CRITERIA_SNAPSHOT_INVALID", path, "Criterion text must be non-empty and within its byte bound."),
    );
    return undefined;
  }
  return value;
}

function positiveSafeInteger(
  value: unknown,
  path: string,
  code: SourceAcceptanceDiagnosticCode,
  diagnostics: SourceAcceptanceDiagnostic[],
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    diagnostics.push(diagnostic(code, path, "Value must be a positive safe integer."));
    return undefined;
  }
  return value;
}

function criteriaCanonicalValue(snapshot: SourceAcceptanceCriteriaSnapshot): CanonicalJsonValue {
  return {
    version: snapshot.version,
    criteria: snapshot.criteria.map(({ id, text }) => ({ id, text })),
  };
}

function duplicateResultDiagnostics(
  results: readonly SourceAcceptanceCriterionResult[],
): readonly SourceAcceptanceDiagnostic[] {
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.criterionId)) {
      return Object.freeze([
        diagnostic("CRITERION_RESULT_DUPLICATE", "$.results", "A criterion has more than one recorded result."),
      ]);
    }
    seen.add(result.criterionId);
  }
  return Object.freeze([]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function diagnostic(code: SourceAcceptanceDiagnosticCode, path: string, message: string): SourceAcceptanceDiagnostic {
  return Object.freeze({
    code,
    path: path.slice(0, SOURCE_ACCEPTANCE_LIMITS.diagnosticPathLength),
    message: message.slice(0, SOURCE_ACCEPTANCE_LIMITS.diagnosticMessageLength),
  });
}

function failure<T>(code: SourceAcceptanceDiagnosticCode, path: string, message: string): NormalizeResult<T> {
  return { diagnostics: Object.freeze([diagnostic(code, path, message)]) };
}

function freezeDiagnostics(diagnostics: readonly SourceAcceptanceDiagnostic[]): readonly SourceAcceptanceDiagnostic[] {
  return Object.freeze(diagnostics.slice(0, SOURCE_ACCEPTANCE_LIMITS.diagnostics));
}

function rejected(diagnostics: readonly SourceAcceptanceDiagnostic[]): SourceAcceptanceValidationResult {
  return Object.freeze({ classification: "rejected" as const, diagnostics: freezeDiagnostics(diagnostics) });
}
