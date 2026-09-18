/**
 * Versioned, provider-neutral bounded Issue and PR discovery.
 *
 * Provider adapters own HTTP and response parsing. This module owns the
 * closed-world Core summary contract shared by the CLI and MCP boundaries.
 */

import type {
  GitHubOperationalActor,
  GitHubOperationalDiscoveryPage,
  GitHubOperationalIssueSummary,
  GitHubOperationalPullRequestSummary,
  GitHubOperationalRepository,
} from "./github/types.js";
import type {
  OperationalActor,
  OperationalMilestone,
  OperationalRefIdentity,
  OperationalRepositoryIdentity,
  OperationalResourceState,
  OperationalTimestamps,
} from "./operational-observation.js";

export const OPERATIONAL_DISCOVERY_VERSION = 1 as const;
export type OperationalDiscoveryVersion = typeof OPERATIONAL_DISCOVERY_VERSION;

export const OPERATIONAL_DISCOVERY_LIMITS = Object.freeze({
  titleLength: 255,
  urlLength: 2_048,
  repositoryTextLength: 512,
  actorTextLength: 512,
  refLength: 512,
  shaLength: 128,
  timestampLength: 128,
  maxPage: 10_000,
  maxLimit: 100,
  diagnostics: 100,
  diagnosticMessageLength: 500,
} as const);

export type OperationalDiscoveryState = "open" | "closed" | "all";
export type OperationalDiscoveryOrdering = "created-desc";

export interface OperationalDiscoveryFilters {
  readonly state: OperationalDiscoveryState;
  readonly page: number;
  readonly limit: number;
  readonly head?: string;
  readonly base?: string;
}

export interface OperationalDiscoveryPagination {
  readonly page: number;
  readonly limit: number;
  readonly returned: number;
  /** A provider continuation exists and must be requested explicitly. */
  readonly truncated: boolean;
  readonly nextPage?: number;
}

export interface OperationalDiscoveryProvenance {
  readonly provider: "github";
  readonly endpoints: readonly string[];
}

export interface OperationalIssueSummary {
  readonly number: number;
  readonly title: string;
  readonly state: OperationalResourceState;
  readonly stateReason: string | null | "unknown";
  readonly author: OperationalActor | null;
  readonly labels: readonly string[];
  readonly assignees: readonly OperationalActor[];
  readonly milestone?: OperationalMilestone;
  readonly timestamps: OperationalTimestamps;
  readonly url: string;
}

export interface OperationalPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly state: OperationalResourceState;
  readonly author: OperationalActor | null;
  readonly head: OperationalRefIdentity;
  readonly base: OperationalRefIdentity;
  readonly draft: boolean | "unknown";
  readonly merged: boolean | "unknown";
  readonly mergeCommitSha?: string;
  readonly labels: readonly string[];
  readonly assignees: readonly OperationalActor[];
  readonly milestone?: OperationalMilestone;
  readonly timestamps: OperationalTimestamps;
  readonly url: string;
}

export interface OperationalIssueDiscovery {
  readonly version: OperationalDiscoveryVersion;
  readonly kind: "issue";
  readonly repository: OperationalRepositoryIdentity;
  readonly filters: OperationalDiscoveryFilters;
  readonly ordering: OperationalDiscoveryOrdering;
  readonly items: readonly OperationalIssueSummary[];
  readonly pagination: OperationalDiscoveryPagination;
  readonly provenance: OperationalDiscoveryProvenance;
}

export interface OperationalPullRequestDiscovery {
  readonly version: OperationalDiscoveryVersion;
  readonly kind: "pull_request";
  readonly repository: OperationalRepositoryIdentity;
  readonly filters: OperationalDiscoveryFilters;
  readonly ordering: OperationalDiscoveryOrdering;
  readonly items: readonly OperationalPullRequestSummary[];
  readonly pagination: OperationalDiscoveryPagination;
  readonly provenance: OperationalDiscoveryProvenance;
}

export interface OperationalIssueDiscoveryInput {
  readonly discovery: GitHubOperationalDiscoveryPage<GitHubOperationalIssueSummary>;
}

export interface OperationalPullRequestDiscoveryInput {
  readonly discovery: GitHubOperationalDiscoveryPage<GitHubOperationalPullRequestSummary>;
}

export interface OperationalDiscoveryViolation {
  readonly code:
    | "OPERATIONAL_DISCOVERY_INPUT_INVALID"
    | "OPERATIONAL_DISCOVERY_INPUT_UNKNOWN_PROPERTY"
    | "OPERATIONAL_DISCOVERY_FILTER_INVALID"
    | "OPERATIONAL_DISCOVERY_VALUE_INVALID"
    | "OPERATIONAL_DISCOVERY_PAGINATION_INVALID"
    | "OPERATIONAL_DISCOVERY_PROVENANCE_INVALID";
  readonly path: string;
  readonly message: string;
}

export interface OperationalIssueDiscoveryResult {
  readonly valid: boolean;
  readonly discovery?: OperationalIssueDiscovery;
  readonly violations: readonly OperationalDiscoveryViolation[];
}

export interface OperationalPullRequestDiscoveryResult {
  readonly valid: boolean;
  readonly discovery?: OperationalPullRequestDiscovery;
  readonly violations: readonly OperationalDiscoveryViolation[];
}

export class OperationalDiscoveryError extends Error {
  readonly violations: readonly OperationalDiscoveryViolation[];

  constructor(violations: readonly OperationalDiscoveryViolation[]) {
    super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
    this.name = "OperationalDiscoveryError";
    this.violations = violations;
  }
}

type RecordValue = Record<string, unknown>;

const ISSUE_KEYS = new Set([
  "repository",
  "number",
  "title",
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
]);
const PULL_REQUEST_KEYS = new Set([
  "repository",
  "number",
  "title",
  "state",
  "author",
  "head",
  "base",
  "draft",
  "merged",
  "mergeCommitSha",
  "labels",
  "assignees",
  "milestone",
  "createdAt",
  "updatedAt",
  "closedAt",
  "mergedAt",
  "url",
]);
const REPOSITORY_KEYS = new Set(["host", "nameWithOwner", "repositoryId"]);
const ACTOR_KEYS = new Set(["login", "id", "name", "url"]);

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function violation(
  violations: OperationalDiscoveryViolation[],
  code: OperationalDiscoveryViolation["code"],
  path: string,
  message: string,
): void {
  if (violations.length < OPERATIONAL_DISCOVERY_LIMITS.diagnostics)
    violations.push({ code, path, message: message.slice(0, OPERATIONAL_DISCOVERY_LIMITS.diagnosticMessageLength) });
}

function unknownProperties(
  value: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  violations: OperationalDiscoveryViolation[],
): void {
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, "en-US")))
    if (!allowed.has(key))
      violation(
        violations,
        "OPERATIONAL_DISCOVERY_INPUT_UNKNOWN_PROPERTY",
        `${path}.${key}`,
        `Property "${key}" is not supported.`,
      );
}

function text(
  value: unknown,
  path: string,
  maximum: number,
  violations: OperationalDiscoveryViolation[],
  required = true,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== "string" ||
    (required && value.length === 0) ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    violation(violations, "OPERATIONAL_DISCOVERY_VALUE_INVALID", path, `Value at ${path} is invalid.`);
    return undefined;
  }
  return value;
}

function integer(
  value: unknown,
  path: string,
  maximum: number,
  violations: OperationalDiscoveryViolation[],
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    violation(
      violations,
      "OPERATIONAL_DISCOVERY_VALUE_INVALID",
      path,
      `Bounded positive integer at ${path} is invalid.`,
    );
    return undefined;
  }
  return value;
}

function optionalInteger(
  value: unknown,
  path: string,
  violations: OperationalDiscoveryViolation[],
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    violation(violations, "OPERATIONAL_DISCOVERY_VALUE_INVALID", path, `Positive integer at ${path} is invalid.`);
    return undefined;
  }
  return value;
}

function normalizeRepository(
  value: unknown,
  path: string,
  violations: OperationalDiscoveryViolation[],
): OperationalRepositoryIdentity | undefined {
  if (!isRecord(value)) {
    violation(violations, "OPERATIONAL_DISCOVERY_INPUT_INVALID", path, "Repository identity is required.");
    return undefined;
  }
  unknownProperties(value, REPOSITORY_KEYS, path, violations);
  const host = text(value.host, `${path}.host`, OPERATIONAL_DISCOVERY_LIMITS.repositoryTextLength, violations);
  const nameWithOwner = text(
    value.nameWithOwner,
    `${path}.nameWithOwner`,
    OPERATIONAL_DISCOVERY_LIMITS.repositoryTextLength,
    violations,
  );
  const repositoryId = text(
    value.repositoryId,
    `${path}.repositoryId`,
    OPERATIONAL_DISCOVERY_LIMITS.repositoryTextLength,
    violations,
    false,
  );
  if (host === undefined || nameWithOwner === undefined) return undefined;
  return { host: host.toLowerCase(), nameWithOwner, ...(repositoryId === undefined ? {} : { repositoryId }) };
}

function normalizeActor(
  value: unknown,
  path: string,
  violations: OperationalDiscoveryViolation[],
): OperationalActor | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    violation(violations, "OPERATIONAL_DISCOVERY_VALUE_INVALID", path, "Actor is invalid.");
    return undefined;
  }
  unknownProperties(value, ACTOR_KEYS, path, violations);
  const login = text(value.login, `${path}.login`, OPERATIONAL_DISCOVERY_LIMITS.actorTextLength, violations, false);
  const name = text(value.name, `${path}.name`, OPERATIONAL_DISCOVERY_LIMITS.actorTextLength, violations, false);
  const url = text(value.url, `${path}.url`, OPERATIONAL_DISCOVERY_LIMITS.urlLength, violations, false);
  const id = optionalInteger(value.id, `${path}.id`, violations);
  if (login === undefined && name === undefined && url === undefined && id === undefined) {
    violation(violations, "OPERATIONAL_DISCOVERY_VALUE_INVALID", path, "Actor has no bounded identity fields.");
    return undefined;
  }
  return {
    ...(login === undefined ? {} : { login }),
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(url === undefined ? {} : { url }),
  };
}

function actorKey(actor: OperationalActor): string {
  return `${actor.login ?? ""}\u0000${actor.name ?? ""}\u0000${actor.id ?? 0}\u0000${actor.url ?? ""}`;
}

function normalizeActors(
  value: unknown,
  path: string,
  violations: OperationalDiscoveryViolation[],
): readonly OperationalActor[] {
  if (!Array.isArray(value)) {
    violation(violations, "OPERATIONAL_DISCOVERY_VALUE_INVALID", path, "Actor collection is invalid.");
    return [];
  }
  return value
    .map((entry, index) => normalizeActor(entry, `${path}[${index}]`, violations))
    .filter((entry): entry is OperationalActor => entry !== null && entry !== undefined)
    .sort((left, right) => actorKey(left).localeCompare(actorKey(right), "en-US"));
}

function normalizeLabels(value: unknown, path: string, violations: OperationalDiscoveryViolation[]): readonly string[] {
  if (!Array.isArray(value)) {
    violation(violations, "OPERATIONAL_DISCOVERY_VALUE_INVALID", path, "Label collection is invalid.");
    return [];
  }
  return [
    ...new Set(
      value
        .map((entry, index) =>
          text(entry, `${path}[${index}]`, OPERATIONAL_DISCOVERY_LIMITS.actorTextLength, violations),
        )
        .filter((entry): entry is string => entry !== undefined),
    ),
  ].sort((left, right) => left.localeCompare(right, "en-US"));
}

function normalizeMilestone(
  value: unknown,
  path: string,
  violations: OperationalDiscoveryViolation[],
): OperationalMilestone | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    violation(violations, "OPERATIONAL_DISCOVERY_VALUE_INVALID", path, "Milestone is invalid.");
    return undefined;
  }
  const number = integer(value.number, `${path}.number`, Number.MAX_SAFE_INTEGER, violations);
  const title = text(value.title, `${path}.title`, OPERATIONAL_DISCOVERY_LIMITS.actorTextLength, violations);
  if (number === undefined || title === undefined) return undefined;
  return { number, title };
}

function normalizeTimestamps(
  source: RecordValue,
  path: string,
  violations: OperationalDiscoveryViolation[],
  includeMerged: boolean,
): OperationalTimestamps {
  const timestamp = (key: string): string | undefined =>
    text(source[key], `${path}.${key}`, OPERATIONAL_DISCOVERY_LIMITS.timestampLength, violations, false);
  const createdAt = timestamp("createdAt");
  const updatedAt = timestamp("updatedAt");
  const closedAt = timestamp("closedAt");
  const mergedAt = includeMerged ? timestamp("mergedAt") : undefined;
  return {
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(closedAt === undefined ? {} : { closedAt }),
    ...(mergedAt === undefined ? {} : { mergedAt }),
  };
}

function normalizeState(
  value: unknown,
  path: string,
  violations: OperationalDiscoveryViolation[],
): OperationalResourceState {
  if (value === "open" || value === "closed" || value === "unknown") return value;
  violation(violations, "OPERATIONAL_DISCOVERY_VALUE_INVALID", path, "Resource state is invalid.");
  return "unknown";
}

function normalizeRef(
  value: unknown,
  path: string,
  violations: OperationalDiscoveryViolation[],
): OperationalRefIdentity {
  if (!isRecord(value)) {
    violation(violations, "OPERATIONAL_DISCOVERY_VALUE_INVALID", path, "Ref identity is invalid.");
    return { branch: "unknown", sha: "unknown" };
  }
  const branch = text(value.ref, `${path}.ref`, OPERATIONAL_DISCOVERY_LIMITS.refLength, violations, false) ?? "unknown";
  const sha = text(value.sha, `${path}.sha`, OPERATIONAL_DISCOVERY_LIMITS.shaLength, violations, false) ?? "unknown";
  return { branch, sha };
}

function normalizeFilters(
  value: unknown,
  path: string,
  kind: "issue" | "pull_request",
  violations: OperationalDiscoveryViolation[],
): OperationalDiscoveryFilters | undefined {
  if (!isRecord(value)) {
    violation(violations, "OPERATIONAL_DISCOVERY_FILTER_INVALID", path, "Discovery filters are required.");
    return undefined;
  }
  unknownProperties(value, new Set(["state", "page", "limit", "head", "base"]), path, violations);
  const state = value.state;
  if (state !== "open" && state !== "closed" && state !== "all")
    violation(violations, "OPERATIONAL_DISCOVERY_FILTER_INVALID", `${path}.state`, "State filter is invalid.");
  const page = integer(value.page, `${path}.page`, OPERATIONAL_DISCOVERY_LIMITS.maxPage, violations);
  const limit = integer(value.limit, `${path}.limit`, OPERATIONAL_DISCOVERY_LIMITS.maxLimit, violations);
  const head = text(value.head, `${path}.head`, OPERATIONAL_DISCOVERY_LIMITS.refLength, violations, false);
  const base = text(value.base, `${path}.base`, OPERATIONAL_DISCOVERY_LIMITS.refLength, violations, false);
  if (kind === "issue" && (head !== undefined || base !== undefined))
    violation(
      violations,
      "OPERATIONAL_DISCOVERY_FILTER_INVALID",
      path,
      "Issue discovery does not accept PR ref filters.",
    );
  if (state !== "open" && state !== "closed" && state !== "all") return undefined;
  if (page === undefined || limit === undefined) return undefined;
  return {
    state,
    page,
    limit,
    ...(head === undefined ? {} : { head }),
    ...(base === undefined ? {} : { base }),
  };
}

function normalizePagination(
  value: unknown,
  path: string,
  filters: OperationalDiscoveryFilters,
  itemCount: number,
  violations: OperationalDiscoveryViolation[],
): OperationalDiscoveryPagination | undefined {
  if (!isRecord(value)) {
    violation(violations, "OPERATIONAL_DISCOVERY_PAGINATION_INVALID", path, "Pagination is required.");
    return undefined;
  }
  unknownProperties(value, new Set(["page", "limit", "returned", "truncated", "nextPage"]), path, violations);
  const page = integer(value.page, `${path}.page`, OPERATIONAL_DISCOVERY_LIMITS.maxPage, violations);
  const limit = integer(value.limit, `${path}.limit`, OPERATIONAL_DISCOVERY_LIMITS.maxLimit, violations);
  const returned = value.returned;
  if (typeof returned !== "number" || !Number.isSafeInteger(returned) || returned < 0 || returned > limit!)
    violation(violations, "OPERATIONAL_DISCOVERY_PAGINATION_INVALID", `${path}.returned`, "Returned count is invalid.");
  const truncated = value.truncated;
  if (typeof truncated !== "boolean")
    violation(
      violations,
      "OPERATIONAL_DISCOVERY_PAGINATION_INVALID",
      `${path}.truncated`,
      "Truncation state is invalid.",
    );
  const nextPage =
    value.nextPage === undefined
      ? undefined
      : integer(value.nextPage, `${path}.nextPage`, OPERATIONAL_DISCOVERY_LIMITS.maxPage, violations);
  if (page !== filters.page || limit !== filters.limit)
    violation(
      violations,
      "OPERATIONAL_DISCOVERY_PAGINATION_INVALID",
      path,
      "Pagination does not match the requested filters.",
    );
  if (typeof returned === "number" && returned !== itemCount)
    violation(
      violations,
      "OPERATIONAL_DISCOVERY_PAGINATION_INVALID",
      `${path}.returned`,
      "Returned count does not match items.",
    );
  if (truncated === true && nextPage === undefined)
    violation(violations, "OPERATIONAL_DISCOVERY_PAGINATION_INVALID", path, "Truncated results require nextPage.");
  if (truncated === false && nextPage !== undefined)
    violation(
      violations,
      "OPERATIONAL_DISCOVERY_PAGINATION_INVALID",
      path,
      "Complete results must not expose nextPage.",
    );
  if (nextPage !== undefined && page !== undefined && nextPage <= page)
    violation(violations, "OPERATIONAL_DISCOVERY_PAGINATION_INVALID", `${path}.nextPage`, "nextPage must advance.");
  if (page === undefined || limit === undefined || typeof returned !== "number" || typeof truncated !== "boolean")
    return undefined;
  return { page, limit, returned, truncated, ...(nextPage === undefined ? {} : { nextPage }) };
}

function normalizeProvenance(
  value: unknown,
  path: string,
  endpoint: string,
  violations: OperationalDiscoveryViolation[],
): OperationalDiscoveryProvenance | undefined {
  if (!isRecord(value) || value.provider !== "github" || !Array.isArray(value.endpoints)) {
    violation(violations, "OPERATIONAL_DISCOVERY_PROVENANCE_INVALID", path, "GitHub provenance is required.");
    return undefined;
  }
  const endpoints = value.endpoints
    .map((entry, index) => text(entry, `${path}.endpoints[${index}]`, 128, violations))
    .filter((entry): entry is string => entry !== undefined);
  if (!endpoints.includes(endpoint))
    violation(violations, "OPERATIONAL_DISCOVERY_PROVENANCE_INVALID", path, `Provenance must include ${endpoint}.`);
  return {
    provider: "github",
    endpoints: [...new Set(endpoints)].sort((left, right) => left.localeCompare(right, "en-US")),
  };
}

function sameRepository(left: OperationalRepositoryIdentity, right: OperationalRepositoryIdentity): boolean {
  return (
    left.host === right.host && left.nameWithOwner === right.nameWithOwner && left.repositoryId === right.repositoryId
  );
}

function normalizeIssueSummary(
  value: unknown,
  path: string,
  repository: OperationalRepositoryIdentity,
  violations: OperationalDiscoveryViolation[],
): OperationalIssueSummary | undefined {
  if (!isRecord(value)) {
    violation(violations, "OPERATIONAL_DISCOVERY_VALUE_INVALID", path, "Issue summary is invalid.");
    return undefined;
  }
  unknownProperties(value, ISSUE_KEYS, path, violations);
  const itemRepository = normalizeRepository(value.repository, `${path}.repository`, violations);
  const number = integer(value.number, `${path}.number`, Number.MAX_SAFE_INTEGER, violations);
  const title = text(value.title, `${path}.title`, OPERATIONAL_DISCOVERY_LIMITS.titleLength, violations);
  const state = normalizeState(value.state, `${path}.state`, violations);
  const stateReason =
    value.stateReason === null
      ? null
      : (text(value.stateReason, `${path}.stateReason`, 128, violations, false) ?? "unknown");
  const author = normalizeActor(value.author, `${path}.author`, violations);
  const labels = normalizeLabels(value.labels, `${path}.labels`, violations);
  const assignees = normalizeActors(value.assignees, `${path}.assignees`, violations);
  const milestone = normalizeMilestone(value.milestone, `${path}.milestone`, violations);
  const url = text(value.url, `${path}.url`, OPERATIONAL_DISCOVERY_LIMITS.urlLength, violations);
  if (itemRepository !== undefined && !sameRepository(itemRepository, repository))
    violation(
      violations,
      "OPERATIONAL_DISCOVERY_VALUE_INVALID",
      `${path}.repository`,
      "Summary repository does not match the page repository.",
    );
  if (number === undefined || title === undefined || author === undefined || url === undefined) return undefined;
  return {
    number,
    title,
    state,
    stateReason,
    author,
    labels,
    assignees,
    ...(milestone === undefined ? {} : { milestone }),
    timestamps: normalizeTimestamps(value, path, violations, false),
    url,
  };
}

function normalizePullRequestSummary(
  value: unknown,
  path: string,
  repository: OperationalRepositoryIdentity,
  violations: OperationalDiscoveryViolation[],
): OperationalPullRequestSummary | undefined {
  if (!isRecord(value)) {
    violation(violations, "OPERATIONAL_DISCOVERY_VALUE_INVALID", path, "Pull-request summary is invalid.");
    return undefined;
  }
  unknownProperties(value, PULL_REQUEST_KEYS, path, violations);
  const itemRepository = normalizeRepository(value.repository, `${path}.repository`, violations);
  const number = integer(value.number, `${path}.number`, Number.MAX_SAFE_INTEGER, violations);
  const title = text(value.title, `${path}.title`, OPERATIONAL_DISCOVERY_LIMITS.titleLength, violations);
  const state = normalizeState(value.state, `${path}.state`, violations);
  const author = normalizeActor(value.author, `${path}.author`, violations);
  const head = normalizeRef(value.head, `${path}.head`, violations);
  const base = normalizeRef(value.base, `${path}.base`, violations);
  const draft =
    value.draft === undefined
      ? "unknown"
      : value.draft === "unknown" || typeof value.draft === "boolean"
        ? value.draft
        : (violation(violations, "OPERATIONAL_DISCOVERY_VALUE_INVALID", `${path}.draft`, "Draft state is invalid."),
          "unknown");
  const merged =
    value.merged === undefined
      ? "unknown"
      : value.merged === null || value.merged === "unknown"
        ? "unknown"
        : typeof value.merged === "boolean"
          ? value.merged
          : (violation(violations, "OPERATIONAL_DISCOVERY_VALUE_INVALID", `${path}.merged`, "Merged state is invalid."),
            "unknown");
  const mergeCommitSha = text(
    value.mergeCommitSha,
    `${path}.mergeCommitSha`,
    OPERATIONAL_DISCOVERY_LIMITS.shaLength,
    violations,
    false,
  );
  const labels = normalizeLabels(value.labels, `${path}.labels`, violations);
  const assignees = normalizeActors(value.assignees, `${path}.assignees`, violations);
  const milestone = normalizeMilestone(value.milestone, `${path}.milestone`, violations);
  const url = text(value.url, `${path}.url`, OPERATIONAL_DISCOVERY_LIMITS.urlLength, violations);
  if (itemRepository !== undefined && !sameRepository(itemRepository, repository))
    violation(
      violations,
      "OPERATIONAL_DISCOVERY_VALUE_INVALID",
      `${path}.repository`,
      "Summary repository does not match the page repository.",
    );
  if (number === undefined || title === undefined || author === undefined || url === undefined) return undefined;
  return {
    number,
    title,
    state,
    author,
    head,
    base,
    draft,
    merged,
    ...(mergeCommitSha === undefined ? {} : { mergeCommitSha }),
    labels,
    assignees,
    ...(milestone === undefined ? {} : { milestone }),
    timestamps: normalizeTimestamps(value, path, violations, true),
    url,
  };
}

function normalizePageBase(
  input: unknown,
  kind: "issue" | "pull_request",
  endpoint: string,
  violations: OperationalDiscoveryViolation[],
): {
  readonly repository: OperationalRepositoryIdentity | undefined;
  readonly filters: OperationalDiscoveryFilters | undefined;
  readonly provenance: OperationalDiscoveryProvenance | undefined;
  readonly value: RecordValue | undefined;
} {
  if (!isRecord(input)) {
    violation(violations, "OPERATIONAL_DISCOVERY_INPUT_INVALID", "$.discovery", "Discovery page is required.");
    return { repository: undefined, filters: undefined, provenance: undefined, value: undefined };
  }
  unknownProperties(
    input,
    new Set(["repository", "filters", "items", "pagination", "provenance"]),
    "$.discovery",
    violations,
  );
  const repository = normalizeRepository(input.repository, "$.discovery.repository", violations);
  const filters = normalizeFilters(input.filters, "$.discovery.filters", kind, violations);
  const provenance = normalizeProvenance(input.provenance, "$.discovery.provenance", endpoint, violations);
  return { repository, filters, provenance, value: input };
}

export function tryDiscoverOperationalIssues(input: unknown): OperationalIssueDiscoveryResult {
  const violations: OperationalDiscoveryViolation[] = [];
  if (!isRecord(input)) {
    violation(violations, "OPERATIONAL_DISCOVERY_INPUT_INVALID", "$", "Discovery input is required.");
    return { valid: false, violations };
  }
  unknownProperties(input, new Set(["discovery"]), "$", violations);
  const base = normalizePageBase(input.discovery, "issue", "issues", violations);
  const items: OperationalIssueSummary[] = [];
  if (base.value !== undefined && Array.isArray(base.value.items)) {
    if (base.filters !== undefined && base.value.items.length > base.filters.limit)
      violation(
        violations,
        "OPERATIONAL_DISCOVERY_PAGINATION_INVALID",
        "$.discovery.items",
        "Items exceed the requested limit.",
      );
    if (base.repository === undefined) {
      violation(
        violations,
        "OPERATIONAL_DISCOVERY_INPUT_INVALID",
        "$.discovery.repository",
        "Repository identity is required before items can be projected.",
      );
    } else {
      const repository = base.repository;
      base.value.items.forEach((entry, index) => {
        const item = normalizeIssueSummary(entry, `$.discovery.items[${index}]`, repository, violations);
        if (item !== undefined) items.push(item);
      });
    }
  } else
    violation(
      violations,
      "OPERATIONAL_DISCOVERY_INPUT_INVALID",
      "$.discovery.items",
      "Discovery items must be an array.",
    );
  const pagination =
    base.filters === undefined || base.repository === undefined
      ? undefined
      : normalizePagination(base.value?.pagination, "$.discovery.pagination", base.filters, items.length, violations);
  if (
    base.repository === undefined ||
    base.filters === undefined ||
    base.provenance === undefined ||
    pagination === undefined ||
    violations.length > 0
  )
    return { valid: false, violations: Object.freeze(violations.slice()) };
  return {
    valid: true,
    discovery: Object.freeze({
      version: OPERATIONAL_DISCOVERY_VERSION,
      kind: "issue",
      repository: base.repository,
      filters: base.filters,
      ordering: "created-desc",
      items: Object.freeze(items.slice()),
      pagination,
      provenance: base.provenance,
    }),
    violations: [],
  };
}

export function discoverOperationalIssues(input: unknown): OperationalIssueDiscovery {
  const result = tryDiscoverOperationalIssues(input);
  if (!result.valid || result.discovery === undefined) throw new OperationalDiscoveryError(result.violations);
  return result.discovery;
}

export function tryDiscoverOperationalPullRequests(input: unknown): OperationalPullRequestDiscoveryResult {
  const violations: OperationalDiscoveryViolation[] = [];
  if (!isRecord(input)) {
    violation(violations, "OPERATIONAL_DISCOVERY_INPUT_INVALID", "$", "Discovery input is required.");
    return { valid: false, violations };
  }
  unknownProperties(input, new Set(["discovery"]), "$", violations);
  const base = normalizePageBase(input.discovery, "pull_request", "pulls", violations);
  const items: OperationalPullRequestSummary[] = [];
  if (base.value !== undefined && Array.isArray(base.value.items)) {
    if (base.filters !== undefined && base.value.items.length > base.filters.limit)
      violation(
        violations,
        "OPERATIONAL_DISCOVERY_PAGINATION_INVALID",
        "$.discovery.items",
        "Items exceed the requested limit.",
      );
    if (base.repository === undefined) {
      violation(
        violations,
        "OPERATIONAL_DISCOVERY_INPUT_INVALID",
        "$.discovery.repository",
        "Repository identity is required before items can be projected.",
      );
    } else {
      const repository = base.repository;
      base.value.items.forEach((entry, index) => {
        const item = normalizePullRequestSummary(entry, `$.discovery.items[${index}]`, repository, violations);
        if (item !== undefined) items.push(item);
      });
    }
  } else
    violation(
      violations,
      "OPERATIONAL_DISCOVERY_INPUT_INVALID",
      "$.discovery.items",
      "Discovery items must be an array.",
    );
  const pagination =
    base.filters === undefined || base.repository === undefined
      ? undefined
      : normalizePagination(base.value?.pagination, "$.discovery.pagination", base.filters, items.length, violations);
  if (
    base.repository === undefined ||
    base.filters === undefined ||
    base.provenance === undefined ||
    pagination === undefined ||
    violations.length > 0
  )
    return { valid: false, violations: Object.freeze(violations.slice()) };
  return {
    valid: true,
    discovery: Object.freeze({
      version: OPERATIONAL_DISCOVERY_VERSION,
      kind: "pull_request",
      repository: base.repository,
      filters: base.filters,
      ordering: "created-desc",
      items: Object.freeze(items.slice()),
      pagination,
      provenance: base.provenance,
    }),
    violations: [],
  };
}

export function discoverOperationalPullRequests(input: unknown): OperationalPullRequestDiscovery {
  const result = tryDiscoverOperationalPullRequests(input);
  if (!result.valid || result.discovery === undefined) throw new OperationalDiscoveryError(result.violations);
  return result.discovery;
}

export type {
  GitHubOperationalActor,
  GitHubOperationalDiscoveryPage,
  GitHubOperationalIssueSummary,
  GitHubOperationalPullRequestSummary,
  GitHubOperationalRepository,
};
