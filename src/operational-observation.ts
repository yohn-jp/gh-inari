/**
 * Versioned, provider-neutral Operational Observation for Issue and PR
 * runtime state.
 *
 * This is deliberately separate from the Semantic Artifact observers. The
 * input is already normalized provider evidence, while Canon/template
 * interpretation remains owned by the existing semantic projection modules.
 * This module performs no GitHub I/O and no mutation.
 */

import type {
  GitHubOperationalActor,
  GitHubOperationalChangedFile,
  GitHubOperationalCheck,
  GitHubOperationalCollection,
  GitHubOperationalComment,
  GitHubOperationalDiagnostic,
  GitHubOperationalIssueEvidence,
  GitHubOperationalPagination,
  GitHubOperationalPullRequestEvidence,
  GitHubOperationalReview,
  GitHubOperationalRepository,
} from "./github/types.js";

export const OPERATIONAL_OBSERVATION_VERSION = 1 as const;
export type OperationalObservationVersion = typeof OPERATIONAL_OBSERVATION_VERSION;

export const OPERATIONAL_OBSERVATION_LIMITS = Object.freeze({
  titleLength: 255,
  bodyBytes: 1_048_576,
  urlLength: 2_048,
  repositoryTextLength: 512,
  actorTextLength: 512,
  refLength: 512,
  shaLength: 128,
  timestampLength: 128,
  collectionPageSize: 100,
  collectionPages: 10,
  collectionItems: 1_000,
  diagnostics: 100,
  diagnosticMessageLength: 500,
} as const);

export type OperationalResourceKind = "issue" | "pull_request";
export type OperationalResourceState = "open" | "closed" | "unknown";
export type OperationalMergeability = "mergeable" | "conflicting" | "unknown";
export type OperationalReviewDecision = "approved" | "changes_requested" | "review_required" | "unknown";
export type OperationalChecksSummary = "success" | "failure" | "pending" | "error" | "unknown";

export interface OperationalRepositoryIdentity {
  readonly host: string;
  readonly nameWithOwner: string;
  readonly repositoryId?: string;
}

export interface OperationalActor {
  readonly login?: string;
  readonly id?: number;
  readonly name?: string;
  readonly url?: string;
}

export interface OperationalMilestone {
  readonly number: number;
  readonly title: string;
}

export interface OperationalTimestamps {
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly closedAt?: string;
  readonly mergedAt?: string;
}

export interface OperationalPagination {
  readonly perPage: number;
  readonly pages: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly nextPage?: number;
}

export interface OperationalDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface OperationalCollection<T> {
  readonly status: "available" | "unavailable";
  readonly items: readonly T[];
  readonly pagination: OperationalPagination;
  readonly diagnostics: readonly OperationalDiagnostic[];
}

export interface OperationalComment {
  readonly id: number;
  readonly body: string | null;
  readonly author: OperationalActor | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly url?: string;
  readonly kind: "conversation" | "inline";
  readonly path?: string;
  readonly line?: number | null;
  readonly side?: string | null;
  readonly inReplyTo?: number;
}

export interface OperationalReview {
  readonly id: number;
  readonly body: string | null;
  readonly author: OperationalActor | null;
  readonly state: string;
  readonly submittedAt?: string;
  readonly commitId?: string;
  readonly url?: string;
}

export interface OperationalCheck {
  readonly id: string;
  readonly name: string;
  readonly kind: "check-run" | "status";
  readonly status: string;
  readonly conclusion?: string | null;
  readonly description?: string | null;
  readonly url?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface OperationalChangedFile {
  readonly filename: string;
  readonly status?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changes?: number;
  readonly sha?: string;
  readonly blobUrl?: string;
  readonly rawUrl?: string;
  readonly contentsUrl?: string;
}

export interface OperationalChangedFilesSummary {
  /** Number of files returned by the bounded provider read. */
  readonly count: number;
  readonly additions: number | "unknown";
  readonly deletions: number | "unknown";
  readonly changes: number | "unknown";
  readonly truncated: boolean;
}

export interface OperationalReviewRequests {
  readonly users: readonly OperationalActor[];
  readonly teams: readonly string[];
}

export interface OperationalProvenance {
  readonly provider: "github";
  /** Fixed adapter-owned endpoint labels, never arbitrary provider payloads. */
  readonly endpoints: readonly string[];
}

export interface OperationalIssueObservation {
  readonly version: OperationalObservationVersion;
  readonly kind: "issue";
  readonly repository: OperationalRepositoryIdentity;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: OperationalResourceState;
  readonly stateReason: string | null | "unknown";
  readonly author: OperationalActor | null;
  readonly labels: readonly string[];
  readonly assignees: readonly OperationalActor[];
  readonly milestone?: OperationalMilestone;
  readonly timestamps: OperationalTimestamps;
  readonly url: string;
  readonly comments: OperationalCollection<OperationalComment>;
  readonly provenance: OperationalProvenance;
}

export interface OperationalRefIdentity {
  readonly branch: string | "unknown";
  readonly sha: string | "unknown";
}

export interface OperationalPullRequestObservation {
  readonly version: OperationalObservationVersion;
  readonly kind: "pull_request";
  readonly repository: OperationalRepositoryIdentity;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: OperationalResourceState;
  readonly author: OperationalActor | null;
  readonly head: OperationalRefIdentity;
  readonly base: OperationalRefIdentity;
  readonly draft: boolean | "unknown";
  readonly mergeability: OperationalMergeability;
  /** Provider merge-state vocabulary is retained; absent/indeterminate is unknown. */
  readonly mergeState: string | "unknown";
  readonly reviewDecision: OperationalReviewDecision;
  readonly merged: boolean | "unknown";
  readonly mergeCommitSha?: string;
  readonly labels: readonly string[];
  readonly assignees: readonly OperationalActor[];
  readonly requestedReviewers?: OperationalReviewRequests;
  readonly milestone?: OperationalMilestone;
  readonly timestamps: OperationalTimestamps;
  readonly url: string;
  readonly checks: OperationalCollection<OperationalCheck>;
  readonly checksSummary: OperationalChecksSummary;
  readonly reviews: OperationalCollection<OperationalReview>;
  readonly comments: OperationalCollection<OperationalComment>;
  readonly inlineReviewComments: OperationalCollection<OperationalComment>;
  readonly changedFiles: OperationalCollection<OperationalChangedFile>;
  readonly changedFilesSummary: OperationalChangedFilesSummary;
  readonly provenance: OperationalProvenance;
}

export interface OperationalIssueObservationInput {
  readonly issue: GitHubOperationalIssueEvidence;
}

export interface OperationalPullRequestObservationInput {
  readonly pullRequest: GitHubOperationalPullRequestEvidence;
}

export type OperationalObservationViolationCode =
  | "OPERATIONAL_OBSERVATION_INPUT_INVALID"
  | "OPERATIONAL_OBSERVATION_INPUT_UNKNOWN_PROPERTY"
  | "OPERATIONAL_OBSERVATION_VALUE_INVALID"
  | "OPERATIONAL_OBSERVATION_COLLECTION_INVALID"
  | "OPERATIONAL_OBSERVATION_DIAGNOSTIC_INVALID";

export interface OperationalObservationViolation {
  readonly code: OperationalObservationViolationCode;
  readonly path: string;
  readonly message: string;
}

export interface OperationalIssueObservationResult {
  readonly valid: boolean;
  readonly observation?: OperationalIssueObservation;
  readonly violations: readonly OperationalObservationViolation[];
}

export interface OperationalPullRequestObservationResult {
  readonly valid: boolean;
  readonly observation?: OperationalPullRequestObservation;
  readonly violations: readonly OperationalObservationViolation[];
}

export class OperationalObservationError extends Error {
  readonly violations: readonly OperationalObservationViolation[];

  constructor(violations: readonly OperationalObservationViolation[]) {
    super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
    this.name = "OperationalObservationError";
    this.violations = violations;
  }
}

type RecordValue = Record<string, unknown>;
type Mapper<T> = (value: unknown, path: string, violations: OperationalObservationViolation[]) => T | undefined;

const OPERATIONAL_ISSUE_KEYS = new Set([
  "repository",
  "number",
  "title",
  "body",
  "state",
  "stateReason",
  "author",
  "labels",
  "assignees",
  "milestone",
  "createdAt",
  "updatedAt",
  "closedAt",
  "url",
  "comments",
  "provenance",
]);
const OPERATIONAL_PULL_REQUEST_KEYS = new Set([
  "repository",
  "number",
  "title",
  "body",
  "state",
  "author",
  "head",
  "base",
  "draft",
  "mergeable",
  "mergeState",
  "reviewDecision",
  "merged",
  "mergeCommitSha",
  "labels",
  "assignees",
  "requestedReviewers",
  "milestone",
  "createdAt",
  "updatedAt",
  "closedAt",
  "mergedAt",
  "url",
  "checks",
  "reviews",
  "comments",
  "inlineReviewComments",
  "changedFiles",
  "provenance",
]);

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(record: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function unknownProperties(
  input: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  violations: OperationalObservationViolation[],
): void {
  for (const key of Object.keys(input).sort((left, right) => left.localeCompare(right, "en-US"))) {
    if (!allowed.has(key))
      violation(
        violations,
        "OPERATIONAL_OBSERVATION_INPUT_UNKNOWN_PROPERTY",
        `${path}.${key}`,
        `Property "${key}" is not supported.`,
      );
  }
}

function violation(
  violations: OperationalObservationViolation[],
  code: OperationalObservationViolationCode,
  path: string,
  message: string,
): void {
  if (violations.length >= OPERATIONAL_OBSERVATION_LIMITS.diagnostics) return;
  violations.push({ code, path, message: message.slice(0, OPERATIONAL_OBSERVATION_LIMITS.diagnosticMessageLength) });
}

function invalidInput(violations: OperationalObservationViolation[], path: string, message: string): void {
  violation(violations, "OPERATIONAL_OBSERVATION_INPUT_INVALID", path, message);
}

function text(
  value: unknown,
  path: string,
  maximum: number,
  violations: OperationalObservationViolation[],
  required = true,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== "string" ||
    (required && value.length === 0) ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    violation(violations, "OPERATIONAL_OBSERVATION_VALUE_INVALID", path, `Value at ${path} is invalid.`);
    return undefined;
  }
  return value;
}

function nullableText(
  value: unknown,
  path: string,
  maximum: number,
  violations: OperationalObservationViolation[],
): string | null | undefined {
  if (value === null) return null;
  return text(value, path, maximum, violations, false);
}

function positiveNumber(
  value: unknown,
  path: string,
  violations: OperationalObservationViolation[],
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    violation(violations, "OPERATIONAL_OBSERVATION_VALUE_INVALID", path, `Positive integer at ${path} is invalid.`);
    return undefined;
  }
  return value;
}

function nonNegativeNumber(
  value: unknown,
  path: string,
  violations: OperationalObservationViolation[],
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    violation(violations, "OPERATIONAL_OBSERVATION_VALUE_INVALID", path, `Non-negative integer at ${path} is invalid.`);
    return undefined;
  }
  return value;
}

function normalizeRepository(
  value: unknown,
  path: string,
  violations: OperationalObservationViolation[],
): OperationalRepositoryIdentity | undefined {
  if (!isRecord(value)) {
    invalidInput(violations, path, "Operational observation repository identity is required.");
    return undefined;
  }
  const host = text(value.host, `${path}.host`, OPERATIONAL_OBSERVATION_LIMITS.repositoryTextLength, violations);
  const nameWithOwner = text(
    value.nameWithOwner,
    `${path}.nameWithOwner`,
    OPERATIONAL_OBSERVATION_LIMITS.repositoryTextLength,
    violations,
  );
  const repositoryId = text(
    value.repositoryId,
    `${path}.repositoryId`,
    OPERATIONAL_OBSERVATION_LIMITS.repositoryTextLength,
    violations,
    false,
  );
  if (host === undefined || nameWithOwner === undefined) return undefined;
  return { host: host.toLowerCase(), nameWithOwner, ...(repositoryId === undefined ? {} : { repositoryId }) };
}

function normalizeActor(
  value: unknown,
  path: string,
  violations: OperationalObservationViolation[],
): OperationalActor | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    violation(violations, "OPERATIONAL_OBSERVATION_VALUE_INVALID", path, `Actor at ${path} is invalid.`);
    return undefined;
  }
  const login = text(value.login, `${path}.login`, OPERATIONAL_OBSERVATION_LIMITS.actorTextLength, violations, false);
  const name = text(value.name, `${path}.name`, OPERATIONAL_OBSERVATION_LIMITS.actorTextLength, violations, false);
  const url = text(value.url, `${path}.url`, OPERATIONAL_OBSERVATION_LIMITS.urlLength, violations, false);
  const id = value.id === undefined ? undefined : positiveNumber(value.id, `${path}.id`, violations);
  if (login === undefined && name === undefined && url === undefined && id === undefined) {
    violation(violations, "OPERATIONAL_OBSERVATION_VALUE_INVALID", path, `Actor at ${path} has no identity fields.`);
    return undefined;
  }
  return {
    ...(login === undefined ? {} : { login }),
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(url === undefined ? {} : { url }),
  };
}

function normalizeActorArray(
  value: unknown,
  path: string,
  violations: OperationalObservationViolation[],
): readonly OperationalActor[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    violation(violations, "OPERATIONAL_OBSERVATION_VALUE_INVALID", path, `Actor collection at ${path} is invalid.`);
    return [];
  }
  const result: OperationalActor[] = [];
  value.forEach((entry, index) => {
    const actor = normalizeActor(entry, `${path}[${index}]`, violations);
    if (actor !== null && actor !== undefined) result.push(actor);
  });
  return result.sort((left, right) => actorKey(left).localeCompare(actorKey(right), "en-US"));
}

function actorKey(actor: OperationalActor): string {
  return `${actor.login ?? ""}\u0000${actor.name ?? ""}\u0000${actor.id ?? 0}\u0000${actor.url ?? ""}`;
}

function normalizeLabels(
  value: unknown,
  path: string,
  violations: OperationalObservationViolation[],
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    violation(violations, "OPERATIONAL_OBSERVATION_VALUE_INVALID", path, `Label collection at ${path} is invalid.`);
    return [];
  }
  const labels = value
    .map((entry, index) => text(entry, `${path}[${index}]`, OPERATIONAL_OBSERVATION_LIMITS.actorTextLength, violations))
    .filter((entry): entry is string => entry !== undefined);
  return [...new Set(labels)].sort((left, right) => left.localeCompare(right, "en-US"));
}

function normalizeMilestone(
  value: unknown,
  path: string,
  violations: OperationalObservationViolation[],
): OperationalMilestone | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    violation(violations, "OPERATIONAL_OBSERVATION_VALUE_INVALID", path, `Milestone at ${path} is invalid.`);
    return undefined;
  }
  const number = positiveNumber(value.number, `${path}.number`, violations);
  const title = text(value.title, `${path}.title`, OPERATIONAL_OBSERVATION_LIMITS.actorTextLength, violations);
  if (number === undefined || title === undefined) return undefined;
  return { number, title };
}

function normalizeTimestamp(
  value: unknown,
  path: string,
  violations: OperationalObservationViolation[],
): string | undefined {
  return text(value, path, OPERATIONAL_OBSERVATION_LIMITS.timestampLength, violations, false);
}

function timestamps(
  source: RecordValue,
  path: string,
  violations: OperationalObservationViolation[],
  includeMerged: boolean,
): OperationalTimestamps {
  const createdAt = normalizeTimestamp(source.createdAt, `${path}.createdAt`, violations);
  const updatedAt = normalizeTimestamp(source.updatedAt, `${path}.updatedAt`, violations);
  const closedAt = normalizeTimestamp(source.closedAt, `${path}.closedAt`, violations);
  const mergedAt = includeMerged ? normalizeTimestamp(source.mergedAt, `${path}.mergedAt`, violations) : undefined;
  return {
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(closedAt === undefined ? {} : { closedAt }),
    ...(mergedAt === undefined ? {} : { mergedAt }),
  };
}

function normalizePagination(
  value: unknown,
  path: string,
  itemCount: number,
  violations: OperationalObservationViolation[],
): OperationalPagination | undefined {
  if (!isRecord(value)) {
    violation(violations, "OPERATIONAL_OBSERVATION_COLLECTION_INVALID", path, `Pagination at ${path} is invalid.`);
    return undefined;
  }
  const perPage = positiveNumber(value.perPage, `${path}.perPage`, violations);
  const pages = nonNegativeNumber(value.pages, `${path}.pages`, violations);
  const returned = nonNegativeNumber(value.returned, `${path}.returned`, violations);
  const truncated = value.truncated;
  const nextPage =
    value.nextPage === undefined ? undefined : positiveNumber(value.nextPage, `${path}.nextPage`, violations);
  if (typeof truncated !== "boolean") {
    violation(
      violations,
      "OPERATIONAL_OBSERVATION_COLLECTION_INVALID",
      `${path}.truncated`,
      "Truncation state is invalid.",
    );
  }
  if (perPage === undefined || pages === undefined || returned === undefined || typeof truncated !== "boolean")
    return undefined;
  if (
    perPage > OPERATIONAL_OBSERVATION_LIMITS.collectionPageSize ||
    pages > OPERATIONAL_OBSERVATION_LIMITS.collectionPages ||
    returned > OPERATIONAL_OBSERVATION_LIMITS.collectionItems
  ) {
    violation(
      violations,
      "OPERATIONAL_OBSERVATION_COLLECTION_INVALID",
      path,
      "Collection pagination exceeds the bounded limit.",
    );
    return undefined;
  }
  if (returned < itemCount || itemCount > OPERATIONAL_OBSERVATION_LIMITS.collectionItems) {
    violation(
      violations,
      "OPERATIONAL_OBSERVATION_COLLECTION_INVALID",
      path,
      "Collection pagination count is invalid.",
    );
    return undefined;
  }
  if (truncated && nextPage === undefined) {
    violation(
      violations,
      "OPERATIONAL_OBSERVATION_COLLECTION_INVALID",
      path,
      "Truncated collections must expose nextPage.",
    );
    return undefined;
  }
  if (!truncated && nextPage !== undefined) {
    violation(
      violations,
      "OPERATIONAL_OBSERVATION_COLLECTION_INVALID",
      path,
      "Complete collections must not expose nextPage.",
    );
    return undefined;
  }
  return { perPage, pages, returned, truncated, ...(nextPage === undefined ? {} : { nextPage }) };
}

function normalizeDiagnostics(
  value: unknown,
  path: string,
  violations: OperationalObservationViolation[],
): readonly OperationalDiagnostic[] {
  if (!Array.isArray(value)) {
    violation(violations, "OPERATIONAL_OBSERVATION_DIAGNOSTIC_INVALID", path, `Diagnostics at ${path} are invalid.`);
    return [];
  }
  if (value.length > OPERATIONAL_OBSERVATION_LIMITS.diagnostics) {
    violation(
      violations,
      "OPERATIONAL_OBSERVATION_DIAGNOSTIC_INVALID",
      path,
      "Diagnostic collection exceeds the bounded limit.",
    );
  }
  const result: OperationalDiagnostic[] = [];
  value.slice(0, OPERATIONAL_OBSERVATION_LIMITS.diagnostics).forEach((entry, index) => {
    if (!isRecord(entry)) {
      violation(
        violations,
        "OPERATIONAL_OBSERVATION_DIAGNOSTIC_INVALID",
        `${path}[${index}]`,
        "Diagnostic is invalid.",
      );
      return;
    }
    const code = text(entry.code, `${path}[${index}].code`, 128, violations);
    const diagnosticPath = text(entry.path, `${path}[${index}].path`, 512, violations);
    const message = text(
      entry.message,
      `${path}[${index}].message`,
      OPERATIONAL_OBSERVATION_LIMITS.diagnosticMessageLength,
      violations,
    );
    if (code !== undefined && diagnosticPath !== undefined && message !== undefined)
      result.push({ code, path: diagnosticPath, message });
  });
  return result;
}

function normalizeCollection<T>(
  value: unknown,
  path: string,
  mapItem: Mapper<T>,
  violations: OperationalObservationViolation[],
): OperationalCollection<T> {
  if (value === undefined) {
    return {
      status: "unavailable",
      items: [],
      pagination: {
        perPage: OPERATIONAL_OBSERVATION_LIMITS.collectionPageSize,
        pages: 0,
        returned: 0,
        truncated: false,
      },
      diagnostics: [
        {
          code: "OPERATIONAL_COLLECTION_ABSENT",
          path,
          message: "Collection was not supplied by the provider adapter.",
        },
      ],
    };
  }
  if (!isRecord(value)) {
    violation(violations, "OPERATIONAL_OBSERVATION_COLLECTION_INVALID", path, `Collection at ${path} is invalid.`);
    return unavailableCollection(path);
  }
  const status = value.status;
  if (status !== "available" && status !== "unavailable") {
    violation(
      violations,
      "OPERATIONAL_OBSERVATION_COLLECTION_INVALID",
      `${path}.status`,
      "Collection status is invalid.",
    );
  }
  if (!Array.isArray(value.items)) {
    violation(
      violations,
      "OPERATIONAL_OBSERVATION_COLLECTION_INVALID",
      `${path}.items`,
      "Collection items are invalid.",
    );
  }
  if (Array.isArray(value.items) && value.items.length > OPERATIONAL_OBSERVATION_LIMITS.collectionItems) {
    violation(
      violations,
      "OPERATIONAL_OBSERVATION_COLLECTION_INVALID",
      `${path}.items`,
      "Collection items exceed the bounded limit.",
    );
  }
  const items: T[] = [];
  if (Array.isArray(value.items)) {
    value.items.slice(0, OPERATIONAL_OBSERVATION_LIMITS.collectionItems).forEach((entry, index) => {
      const item = mapItem(entry, `${path}.items[${index}]`, violations);
      if (item !== undefined) items.push(item);
    });
  }
  const pagination = normalizePagination(value.pagination, `${path}.pagination`, items.length, violations);
  const diagnostics = normalizeDiagnostics(value.diagnostics, `${path}.diagnostics`, violations);
  if (pagination === undefined || (status !== "available" && status !== "unavailable"))
    return unavailableCollection(path);
  return { status, items, pagination, diagnostics };
}

function unavailableCollection<T>(path: string): OperationalCollection<T> {
  return {
    status: "unavailable",
    items: [],
    pagination: { perPage: OPERATIONAL_OBSERVATION_LIMITS.collectionPageSize, pages: 0, returned: 0, truncated: false },
    diagnostics: [{ code: "OPERATIONAL_COLLECTION_INVALID", path, message: "Collection evidence is unavailable." }],
  };
}

function sortCollection<T>(
  collection: OperationalCollection<T>,
  compare: (left: T, right: T) => number,
): OperationalCollection<T> {
  return { ...collection, items: [...collection.items].sort(compare) };
}

function compareChecks(left: OperationalCheck, right: OperationalCheck): number {
  return (
    left.name.localeCompare(right.name, "en-US") ||
    left.kind.localeCompare(right.kind, "en-US") ||
    left.id.localeCompare(right.id, "en-US")
  );
}

function compareFiles(left: OperationalChangedFile, right: OperationalChangedFile): number {
  return (
    left.filename.localeCompare(right.filename, "en-US") || (left.sha ?? "").localeCompare(right.sha ?? "", "en-US")
  );
}

function compareComments(left: OperationalComment, right: OperationalComment): number {
  return left.id - right.id || (left.createdAt ?? "").localeCompare(right.createdAt ?? "", "en-US");
}

function compareReviews(left: OperationalReview, right: OperationalReview): number {
  return left.id - right.id || (left.submittedAt ?? "").localeCompare(right.submittedAt ?? "", "en-US");
}

function changedFilesSummary(
  collection: OperationalCollection<OperationalChangedFile>,
): OperationalChangedFilesSummary {
  const complete = collection.status === "available" && !collection.pagination.truncated;
  const total = (field: "additions" | "deletions" | "changes"): number | "unknown" => {
    if (!complete || collection.items.some((file) => file[field] === undefined)) return "unknown";
    return collection.items.reduce((sum, file) => sum + (file[field] ?? 0), 0);
  };
  return {
    count: collection.pagination.returned,
    additions: total("additions"),
    deletions: total("deletions"),
    changes: total("changes"),
    truncated: collection.pagination.truncated,
  };
}

function normalizeProvenance(
  value: unknown,
  path: string,
  violations: OperationalObservationViolation[],
): OperationalProvenance | undefined {
  if (!isRecord(value) || value.provider !== "github" || !Array.isArray(value.endpoints)) {
    violation(violations, "OPERATIONAL_OBSERVATION_INPUT_INVALID", path, "GitHub observation provenance is required.");
    return undefined;
  }
  const endpoints = value.endpoints
    .map((entry, index) => text(entry, `${path}.endpoints[${index}]`, 512, violations))
    .filter((entry): entry is string => entry !== undefined);
  if (endpoints.length === 0) {
    violation(
      violations,
      "OPERATIONAL_OBSERVATION_INPUT_INVALID",
      path,
      "GitHub observation provenance must name at least one fixed endpoint.",
    );
    return undefined;
  }
  return {
    provider: "github",
    endpoints: [...new Set(endpoints)].sort((left, right) => left.localeCompare(right, "en-US")),
  };
}

function normalizeState(
  value: unknown,
  path: string,
  violations: OperationalObservationViolation[],
): OperationalResourceState {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "open" || normalized === "closed" || normalized === "unknown") return normalized;
  }
  if (value === undefined || value === null) return "unknown";
  violation(violations, "OPERATIONAL_OBSERVATION_VALUE_INVALID", path, `Resource state at ${path} is invalid.`);
  return "unknown";
}

function normalizeRef(
  value: unknown,
  path: string,
  violations: OperationalObservationViolation[],
): OperationalRefIdentity {
  if (!isRecord(value)) return { branch: "unknown", sha: "unknown" };
  const branch =
    text(value.ref, `${path}.ref`, OPERATIONAL_OBSERVATION_LIMITS.refLength, violations, false) ?? "unknown";
  const sha = text(value.sha, `${path}.sha`, OPERATIONAL_OBSERVATION_LIMITS.shaLength, violations, false) ?? "unknown";
  return { branch, sha };
}

function normalizeComment(
  value: unknown,
  path: string,
  kind: "conversation" | "inline",
  violations: OperationalObservationViolation[],
): OperationalComment | undefined {
  if (!isRecord(value)) {
    violation(violations, "OPERATIONAL_OBSERVATION_VALUE_INVALID", path, `Comment at ${path} is invalid.`);
    return undefined;
  }
  const id = positiveNumber(value.id, `${path}.id`, violations);
  const body =
    value.body === null
      ? null
      : text(value.body, `${path}.body`, OPERATIONAL_OBSERVATION_LIMITS.bodyBytes, violations, false);
  const author = normalizeActor(value.author, `${path}.author`, violations);
  const createdAt = normalizeTimestamp(value.createdAt, `${path}.createdAt`, violations);
  const updatedAt = normalizeTimestamp(value.updatedAt, `${path}.updatedAt`, violations);
  const url = text(value.url, `${path}.url`, OPERATIONAL_OBSERVATION_LIMITS.urlLength, violations, false);
  const commentPath = text(value.path, `${path}.path`, OPERATIONAL_OBSERVATION_LIMITS.refLength, violations, false);
  const line =
    value.line === undefined || value.line === null
      ? value.line
      : positiveNumber(value.line, `${path}.line`, violations);
  const side =
    value.side === undefined || value.side === null ? value.side : text(value.side, `${path}.side`, 32, violations);
  const inReplyTo =
    value.inReplyTo === undefined ? undefined : positiveNumber(value.inReplyTo, `${path}.inReplyTo`, violations);
  if (id === undefined || body === undefined || author === undefined) return undefined;
  return {
    id,
    body,
    author,
    kind,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(url === undefined ? {} : { url }),
    ...(commentPath === undefined ? {} : { path: commentPath }),
    ...(line === undefined ? {} : { line }),
    ...(side === undefined ? {} : { side }),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
  };
}

function normalizeReview(
  value: unknown,
  path: string,
  violations: OperationalObservationViolation[],
): OperationalReview | undefined {
  if (!isRecord(value)) {
    violation(violations, "OPERATIONAL_OBSERVATION_VALUE_INVALID", path, `Review at ${path} is invalid.`);
    return undefined;
  }
  const id = positiveNumber(value.id, `${path}.id`, violations);
  const body =
    value.body === null
      ? null
      : text(value.body, `${path}.body`, OPERATIONAL_OBSERVATION_LIMITS.bodyBytes, violations, false);
  const author = normalizeActor(value.author, `${path}.author`, violations);
  const state = text(value.state, `${path}.state`, 64, violations);
  const submittedAt = normalizeTimestamp(value.submittedAt, `${path}.submittedAt`, violations);
  const commitId = text(
    value.commitId,
    `${path}.commitId`,
    OPERATIONAL_OBSERVATION_LIMITS.shaLength,
    violations,
    false,
  );
  const url = text(value.url, `${path}.url`, OPERATIONAL_OBSERVATION_LIMITS.urlLength, violations, false);
  if (id === undefined || body === undefined || author === undefined || state === undefined) return undefined;
  return {
    id,
    body,
    author,
    state: state.toLowerCase(),
    ...(submittedAt === undefined ? {} : { submittedAt }),
    ...(commitId === undefined ? {} : { commitId }),
    ...(url === undefined ? {} : { url }),
  };
}

function normalizeCheck(
  value: unknown,
  path: string,
  violations: OperationalObservationViolation[],
): OperationalCheck | undefined {
  if (!isRecord(value)) {
    violation(violations, "OPERATIONAL_OBSERVATION_VALUE_INVALID", path, `Check at ${path} is invalid.`);
    return undefined;
  }
  const id = text(value.id, `${path}.id`, 128, violations);
  const name = text(value.name, `${path}.name`, 512, violations);
  const kind = value.kind;
  const status = text(value.status, `${path}.status`, 64, violations);
  const conclusion = nullableText(value.conclusion, `${path}.conclusion`, 64, violations);
  const description = nullableText(value.description, `${path}.description`, 2_048, violations);
  const url = text(value.url, `${path}.url`, OPERATIONAL_OBSERVATION_LIMITS.urlLength, violations, false);
  const startedAt = normalizeTimestamp(value.startedAt, `${path}.startedAt`, violations);
  const completedAt = normalizeTimestamp(value.completedAt, `${path}.completedAt`, violations);
  if (kind !== "check-run" && kind !== "status")
    violation(violations, "OPERATIONAL_OBSERVATION_VALUE_INVALID", `${path}.kind`, "Check kind is invalid.");
  if (id === undefined || name === undefined || status === undefined || (kind !== "check-run" && kind !== "status"))
    return undefined;
  return {
    id,
    name,
    kind,
    status: status.toLowerCase(),
    ...(conclusion === undefined ? {} : { conclusion }),
    ...(description === undefined ? {} : { description }),
    ...(url === undefined ? {} : { url }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function normalizeFile(
  value: unknown,
  path: string,
  violations: OperationalObservationViolation[],
): OperationalChangedFile | undefined {
  if (!isRecord(value)) {
    violation(violations, "OPERATIONAL_OBSERVATION_VALUE_INVALID", path, `Changed file at ${path} is invalid.`);
    return undefined;
  }
  const filename = text(value.filename, `${path}.filename`, OPERATIONAL_OBSERVATION_LIMITS.refLength, violations);
  const status = text(value.status, `${path}.status`, 64, violations, false);
  const additions =
    value.additions === undefined ? undefined : nonNegativeNumber(value.additions, `${path}.additions`, violations);
  const deletions =
    value.deletions === undefined ? undefined : nonNegativeNumber(value.deletions, `${path}.deletions`, violations);
  const changes =
    value.changes === undefined ? undefined : nonNegativeNumber(value.changes, `${path}.changes`, violations);
  const sha = text(value.sha, `${path}.sha`, OPERATIONAL_OBSERVATION_LIMITS.shaLength, violations, false);
  const blobUrl = text(value.blobUrl, `${path}.blobUrl`, OPERATIONAL_OBSERVATION_LIMITS.urlLength, violations, false);
  const rawUrl = text(value.rawUrl, `${path}.rawUrl`, OPERATIONAL_OBSERVATION_LIMITS.urlLength, violations, false);
  const contentsUrl = text(
    value.contentsUrl,
    `${path}.contentsUrl`,
    OPERATIONAL_OBSERVATION_LIMITS.urlLength,
    violations,
    false,
  );
  if (filename === undefined) return undefined;
  return {
    filename,
    ...(status === undefined ? {} : { status: status.toLowerCase() }),
    ...(additions === undefined ? {} : { additions }),
    ...(deletions === undefined ? {} : { deletions }),
    ...(changes === undefined ? {} : { changes }),
    ...(sha === undefined ? {} : { sha }),
    ...(blobUrl === undefined ? {} : { blobUrl }),
    ...(rawUrl === undefined ? {} : { rawUrl }),
    ...(contentsUrl === undefined ? {} : { contentsUrl }),
  };
}

function normalizeReviewRequests(
  value: unknown,
  path: string,
  violations: OperationalObservationViolation[],
): OperationalReviewRequests | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Array.isArray(value.users) || !Array.isArray(value.teams)) {
    violation(violations, "OPERATIONAL_OBSERVATION_VALUE_INVALID", path, "Requested reviewers are invalid.");
    return undefined;
  }
  const users = normalizeActorArray(value.users, `${path}.users`, violations);
  const teams = value.teams
    .map((entry, index) =>
      text(entry, `${path}.teams[${index}]`, OPERATIONAL_OBSERVATION_LIMITS.actorTextLength, violations),
    )
    .filter((entry): entry is string => entry !== undefined);
  return { users, teams: [...new Set(teams)].sort((left, right) => left.localeCompare(right, "en-US")) };
}

function normalizeProvenanceValue(
  evidence: RecordValue,
  violations: OperationalObservationViolation[],
): OperationalProvenance | undefined {
  return normalizeProvenance(evidence.provenance, "$.provenance", violations);
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as RecordValue)) freeze(child);
  return value;
}

function unwrap(value: unknown, property: "issue" | "pullRequest"): RecordValue | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[property];
  return isRecord(nested) ? nested : value;
}

function issueProjection(
  input: unknown,
  violations: OperationalObservationViolation[],
): OperationalIssueObservation | undefined {
  const wrapped = isRecord(input) && hasOwn(input, "issue");
  const evidence = unwrap(input, "issue");
  if (evidence === undefined) {
    invalidInput(violations, "$", "Operational Issue observation input must be an object.");
    return undefined;
  }
  if (wrapped) unknownProperties(input as RecordValue, new Set(["issue"]), "$", violations);
  unknownProperties(evidence, OPERATIONAL_ISSUE_KEYS, "$.issue", violations);
  const repository = normalizeRepository(evidence.repository, "$.issue.repository", violations);
  const number = positiveNumber(evidence.number, "$.issue.number", violations);
  const title = text(evidence.title, "$.issue.title", OPERATIONAL_OBSERVATION_LIMITS.titleLength, violations);
  const body =
    evidence.body === null
      ? null
      : text(evidence.body, "$.issue.body", OPERATIONAL_OBSERVATION_LIMITS.bodyBytes, violations, false);
  const state = normalizeState(evidence.state, "$.issue.state", violations);
  const stateReason =
    evidence.stateReason === undefined
      ? "unknown"
      : evidence.stateReason === null
        ? null
        : text(evidence.stateReason, "$.issue.stateReason", 128, violations);
  const author = normalizeActor(evidence.author, "$.issue.author", violations);
  const labels = normalizeLabels(evidence.labels, "$.issue.labels", violations);
  const assignees = normalizeActorArray(evidence.assignees, "$.issue.assignees", violations);
  const milestone = normalizeMilestone(evidence.milestone, "$.issue.milestone", violations);
  const url = text(evidence.url, "$.issue.url", OPERATIONAL_OBSERVATION_LIMITS.urlLength, violations);
  const comments = normalizeCollection(
    evidence.comments,
    "$.issue.comments",
    (entry, path, local) => normalizeComment(entry, path, "conversation", local),
    violations,
  );
  const normalizedComments = sortCollection(comments, compareComments);
  const provenance = repository === undefined ? undefined : normalizeProvenanceValue(evidence, violations);
  if (
    repository === undefined ||
    number === undefined ||
    title === undefined ||
    body === undefined ||
    author === undefined ||
    stateReason === undefined ||
    url === undefined ||
    provenance === undefined
  )
    return undefined;
  return {
    version: OPERATIONAL_OBSERVATION_VERSION,
    kind: "issue",
    repository,
    number,
    title,
    body,
    state,
    stateReason,
    author,
    labels,
    assignees,
    ...(milestone === undefined ? {} : { milestone }),
    timestamps: timestamps(evidence, "$.issue", violations, false),
    url,
    comments: normalizedComments,
    provenance,
  };
}

function normalizeMergeability(value: unknown): OperationalMergeability {
  if (value === true) return "mergeable";
  if (value === false) return "conflicting";
  return "unknown";
}

function normalizeMergeState(
  value: unknown,
  path: string,
  violations: OperationalObservationViolation[],
): string | "unknown" {
  if (value === undefined || value === null || value === "") return "unknown";
  return text(value, path, 64, violations) ?? "unknown";
}

function normalizeReviewDecision(value: unknown): OperationalReviewDecision {
  if (typeof value !== "string") return "unknown";
  switch (value.toLowerCase()) {
    case "approved":
      return "approved";
    case "changes_requested":
    case "changes-requested":
      return "changes_requested";
    case "review_required":
    case "review-required":
      return "review_required";
    default:
      return "unknown";
  }
}

function deriveChecksSummary(collection: OperationalCollection<OperationalCheck>): OperationalChecksSummary {
  if (collection.status !== "available" || collection.pagination.truncated || collection.items.length === 0)
    return "unknown";
  let pending = false;
  let unknown = false;
  for (const check of collection.items) {
    const status = check.status.toLowerCase();
    const conclusion = check.conclusion?.toLowerCase();
    if (status === "error" || conclusion === "startup_failure") return "error";
    if (status === "failure" || conclusion === "failure" || conclusion === "timed_out" || conclusion === "cancelled")
      return "failure";
    if (
      status === "queued" ||
      status === "in_progress" ||
      status === "requested" ||
      status === "waiting" ||
      status === "pending"
    )
      pending = true;
    else if (!(
      status === "success" ||
      (status === "completed" && conclusion === "success") ||
      (status === "completed" && conclusion === undefined && check.kind === "status")
    ))
      unknown = true;
  }
  if (pending) return "pending";
  if (unknown) return "unknown";
  return "success";
}

function pullRequestProjection(
  input: unknown,
  violations: OperationalObservationViolation[],
): OperationalPullRequestObservation | undefined {
  const wrapped = isRecord(input) && hasOwn(input, "pullRequest");
  const evidence = unwrap(input, "pullRequest");
  if (evidence === undefined) {
    invalidInput(violations, "$", "Operational PR observation input must be an object.");
    return undefined;
  }
  if (wrapped) unknownProperties(input as RecordValue, new Set(["pullRequest"]), "$", violations);
  unknownProperties(evidence, OPERATIONAL_PULL_REQUEST_KEYS, "$.pullRequest", violations);
  const repository = normalizeRepository(evidence.repository, "$.pullRequest.repository", violations);
  const number = positiveNumber(evidence.number, "$.pullRequest.number", violations);
  const title = text(evidence.title, "$.pullRequest.title", OPERATIONAL_OBSERVATION_LIMITS.titleLength, violations);
  const body =
    evidence.body === null
      ? null
      : text(evidence.body, "$.pullRequest.body", OPERATIONAL_OBSERVATION_LIMITS.bodyBytes, violations, false);
  const state = normalizeState(evidence.state, "$.pullRequest.state", violations);
  const author = normalizeActor(evidence.author, "$.pullRequest.author", violations);
  const head = normalizeRef(evidence.head, "$.pullRequest.head", violations);
  const base = normalizeRef(evidence.base, "$.pullRequest.base", violations);
  const draft = typeof evidence.draft === "boolean" ? evidence.draft : "unknown";
  const mergeability = normalizeMergeability(evidence.mergeable);
  const mergeState = normalizeMergeState(evidence.mergeState, "$.pullRequest.mergeState", violations);
  const reviewDecision = normalizeReviewDecision(evidence.reviewDecision);
  const merged = typeof evidence.merged === "boolean" ? evidence.merged : "unknown";
  const mergeCommitSha =
    evidence.mergeCommitSha === undefined || evidence.mergeCommitSha === null
      ? undefined
      : text(
          evidence.mergeCommitSha,
          "$.pullRequest.mergeCommitSha",
          OPERATIONAL_OBSERVATION_LIMITS.shaLength,
          violations,
        );
  const labels = normalizeLabels(evidence.labels, "$.pullRequest.labels", violations);
  const assignees = normalizeActorArray(evidence.assignees, "$.pullRequest.assignees", violations);
  const requestedReviewers = normalizeReviewRequests(
    evidence.requestedReviewers,
    "$.pullRequest.requestedReviewers",
    violations,
  );
  const milestone = normalizeMilestone(evidence.milestone, "$.pullRequest.milestone", violations);
  const url = text(evidence.url, "$.pullRequest.url", OPERATIONAL_OBSERVATION_LIMITS.urlLength, violations);
  const checks = sortCollection(
    normalizeCollection(evidence.checks, "$.pullRequest.checks", normalizeCheck, violations),
    compareChecks,
  );
  const checksSummary = deriveChecksSummary(checks);
  const reviews = sortCollection(
    normalizeCollection(evidence.reviews, "$.pullRequest.reviews", normalizeReview, violations),
    compareReviews,
  );
  const comments = normalizeCollection(
    evidence.comments,
    "$.pullRequest.comments",
    (entry, path, local) => normalizeComment(entry, path, "conversation", local),
    violations,
  );
  const normalizedComments = sortCollection(comments, compareComments);
  const inlineReviewComments = sortCollection(
    normalizeCollection(
      evidence.inlineReviewComments,
      "$.pullRequest.inlineReviewComments",
      (entry, path, local) => normalizeComment(entry, path, "inline", local),
      violations,
    ),
    compareComments,
  );
  const changedFiles = sortCollection(
    normalizeCollection(evidence.changedFiles, "$.pullRequest.changedFiles", normalizeFile, violations),
    compareFiles,
  );
  const provenance = repository === undefined ? undefined : normalizeProvenanceValue(evidence, violations);
  if (
    repository === undefined ||
    number === undefined ||
    title === undefined ||
    body === undefined ||
    author === undefined ||
    url === undefined ||
    (mergeCommitSha === undefined && evidence.mergeCommitSha !== undefined && evidence.mergeCommitSha !== null) ||
    provenance === undefined
  )
    return undefined;
  return {
    version: OPERATIONAL_OBSERVATION_VERSION,
    kind: "pull_request",
    repository,
    number,
    title,
    body,
    state,
    author,
    head,
    base,
    draft,
    mergeability,
    mergeState,
    reviewDecision,
    merged,
    ...(mergeCommitSha === undefined ? {} : { mergeCommitSha }),
    labels,
    assignees,
    ...(requestedReviewers === undefined ? {} : { requestedReviewers }),
    ...(milestone === undefined ? {} : { milestone }),
    timestamps: timestamps(evidence, "$.pullRequest", violations, true),
    url,
    checks,
    checksSummary,
    reviews,
    comments: normalizedComments,
    inlineReviewComments,
    changedFiles,
    changedFilesSummary: changedFilesSummary(changedFiles),
    provenance,
  };
}

/** Normalize provider-normalized Issue evidence into the versioned Core model. */
export function tryObserveOperationalIssue(input: unknown): OperationalIssueObservationResult {
  const violations: OperationalObservationViolation[] = [];
  const observation = issueProjection(input, violations);
  if (observation === undefined || violations.length > 0)
    return { valid: false, violations: freeze(violations.slice()) };
  return { valid: true, observation: freeze(observation), violations: [] };
}

/** Throwing Core entry point for callers that require a complete observation. */
export function observeOperationalIssue(input: unknown): OperationalIssueObservation {
  const result = tryObserveOperationalIssue(input);
  if (!result.valid || result.observation === undefined) throw new OperationalObservationError(result.violations);
  return result.observation;
}

/** Normalize provider-normalized PR evidence into the versioned Core model. */
export function tryObserveOperationalPullRequest(input: unknown): OperationalPullRequestObservationResult {
  const violations: OperationalObservationViolation[] = [];
  const observation = pullRequestProjection(input, violations);
  if (observation === undefined || violations.length > 0)
    return { valid: false, violations: freeze(violations.slice()) };
  return { valid: true, observation: freeze(observation), violations: [] };
}

/** Throwing Core entry point for callers that require a complete observation. */
export function observeOperationalPullRequest(input: unknown): OperationalPullRequestObservation {
  const result = tryObserveOperationalPullRequest(input);
  if (!result.valid || result.observation === undefined) throw new OperationalObservationError(result.violations);
  return result.observation;
}

export const observeOperationalPr = observeOperationalPullRequest;
export const tryObserveOperationalPr = tryObserveOperationalPullRequest;
export type {
  GitHubOperationalActor,
  GitHubOperationalChangedFile,
  GitHubOperationalCheck,
  GitHubOperationalCollection,
  GitHubOperationalComment,
  GitHubOperationalDiagnostic,
  GitHubOperationalIssueEvidence,
  GitHubOperationalPagination,
  GitHubOperationalPullRequestEvidence,
  GitHubOperationalReview,
  GitHubOperationalRepository,
};
