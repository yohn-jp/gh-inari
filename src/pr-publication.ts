/**
 * Idempotent, provider-neutral governed pull-request publication.
 *
 * Routing is owned by integration-routing.ts.  This module only binds one
 * already projected route and work identity to one repository/head/base/head
 * revision and coordinates the provider's bounded list/read/create seam.
 * It never retries a create after an uncertain provider response.
 */

import { issueReferenceKey, normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";
import { tryAdaptIntegrationRouting } from "./integration-routing-adapters.js";
import type { IntegrationRoutingProjection } from "./integration-routing.js";
import { deriveReleasePrPublicationRoute, type ReleasePrPublicationRoute } from "./release-pr-publication.js";

export const PR_PUBLICATION_CONTRACT_VERSION = 1 as const;
export type PrPublicationContractVersion = typeof PR_PUBLICATION_CONTRACT_VERSION;
export const PR_PUBLICATION_KIND = "pr-publication" as const;
const PR_PUBLICATION_IDENTITY_MARKER_KIND = "pr-publication-identity" as const;
const PR_PUBLICATION_IDENTITY_MARKER_VERSION = 1 as const;
export const PR_PUBLICATION_RESULT_CLASSIFICATIONS = Object.freeze(["created", "returned-existing", "failed"] as const);
export type PrPublicationResultClassification = (typeof PR_PUBLICATION_RESULT_CLASSIFICATIONS)[number];

export interface PrPublicationRepositoryIdentity {
  readonly repositoryHost: string;
  readonly repositoryId: string;
  readonly repository?: string;
}

/** A governed Implementation leaf publication remains repository-bound. */
export interface PrPublicationImplementationWorkIdentity {
  /** Omitted only by the bounded pre-role Implementation compatibility form. */
  readonly role?: "implementation";
  readonly implementation: IssueReference;
  readonly sourceIssue?: IssueReference;
  readonly epic?: IssueReference;
  readonly identityKey?: string;
}

/** A Source Change integration PR is bound to its Source and parent Epic. */
export interface PrPublicationSourceIntegrationWorkIdentity {
  readonly role: "issue-integration";
  /** Type-only compatibility slot for older Implementation-only readers. */
  readonly implementation?: Readonly<{ readonly number?: never }>;
  readonly sourceIssue: IssueReference;
  readonly epic: IssueReference;
}

/** An Epic integration PR is bound to the Epic it composes. */
export interface PrPublicationEpicIntegrationWorkIdentity {
  readonly role: "epic-integration";
  /** Type-only compatibility slot for older Implementation-only readers. */
  readonly implementation?: Readonly<{ readonly number?: never }>;
  readonly epic: IssueReference;
}

/** Issue-less release publication identity. */
export interface PrPublicationReleaseWorkIdentity {
  /**
   * Type-only provider compatibility slot. Release values never serialize
   * this property; privileged providers must remain unable to derive an Issue
   * from a release identity.
   */
  readonly implementation: Readonly<{ readonly number: never }>;
  readonly release: Readonly<{
    readonly targetVersion: string;
    readonly sourceRevision: string;
  }>;
}

/** Publication identity follows the canonical route role. */
export type PrPublicationWorkIdentity =
  | PrPublicationImplementationWorkIdentity
  | PrPublicationSourceIntegrationWorkIdentity
  | PrPublicationEpicIntegrationWorkIdentity
  | PrPublicationReleaseWorkIdentity;

export type PrPublicationRouting = IntegrationRoutingProjection | ReleasePrPublicationRoute;

export interface PrPublicationRequest {
  readonly version: PrPublicationContractVersion;
  readonly kind?: typeof PR_PUBLICATION_KIND;
  readonly repository: PrPublicationRepositoryIdentity;
  readonly workIdentity: unknown;
  /** Raw route input or the canonical #925 projection. */
  readonly routing?: unknown;
  readonly expectedHead?: string;
  readonly expectedBase?: string;
  readonly headRevision: string;
  readonly title: string;
  readonly body: string;
  readonly draft?: boolean;
  readonly maintainerCanModify?: boolean;
}

export interface PrPublicationRecord {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string | null;
  readonly head: string;
  readonly base: string;
  readonly headRevision?: string;
  readonly repository?: PrPublicationRepositoryIdentity;
  readonly workIdentity?: unknown;
  readonly draft?: boolean;
}

export interface PrPublicationListQuery {
  readonly repository: PrPublicationRepositoryIdentity;
  readonly head: string;
  readonly base: string;
}

export interface PrPublicationCreateInput {
  readonly repository: PrPublicationRepositoryIdentity;
  readonly workIdentity: PrPublicationWorkIdentity;
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
  readonly headRevision: string;
  readonly draft?: boolean;
  readonly maintainerCanModify?: boolean;
}

/** Narrow provider port. Provider-specific authentication and HTTP stay outside Core. */
export interface PrPublicationProvider {
  readonly getRepositoryIdentity?: () => Promise<PrPublicationRepositoryIdentity>;
  readonly listPullRequests: (query: PrPublicationListQuery) => Promise<readonly PrPublicationRecord[]>;
  readonly readPullRequest: (number: number) => Promise<PrPublicationRecord>;
  readonly createPullRequest: (input: PrPublicationCreateInput) => Promise<PrPublicationRecord>;
}

export interface PrPublicationDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface PrPublicationResult {
  readonly version: PrPublicationContractVersion;
  readonly kind: typeof PR_PUBLICATION_KIND;
  readonly ok: boolean;
  readonly classification: PrPublicationResultClassification;
  /** Alias retained for callers that use the existing execution terminology. */
  readonly outcome: PrPublicationResultClassification;
  readonly pullRequest?: Readonly<{ readonly number: number; readonly url: string }>;
  readonly routing?: PrPublicationRouting;
  readonly diagnostics: readonly PrPublicationDiagnostic[];
  readonly effects: readonly Readonly<{
    readonly kind: "CREATE_PULL_REQUEST";
    readonly status: "succeeded" | "not-attempted";
  }>[];
}

export interface PrPublicationValidationResult {
  readonly valid: boolean;
  readonly request?: NormalizedPrPublicationRequest;
  readonly routing?: PrPublicationRouting;
  readonly workIdentity?: PrPublicationWorkIdentity;
  readonly diagnostics: readonly PrPublicationDiagnostic[];
}

export interface NormalizedPrPublicationRequest {
  readonly version: PrPublicationContractVersion;
  readonly kind: typeof PR_PUBLICATION_KIND;
  readonly repository: PrPublicationRepositoryIdentity;
  readonly workIdentity: PrPublicationWorkIdentity;
  readonly routing: PrPublicationRouting;
  readonly expectedHead: string;
  readonly expectedBase: string;
  readonly headRevision: string;
  readonly title: string;
  /** Provider body; Source/Epic roles include the hidden canonical binding. */
  readonly body: string;
  readonly draft?: boolean;
  readonly maintainerCanModify?: boolean;
}

export class PrPublicationError extends Error {
  readonly code: string;
  readonly diagnostics: readonly PrPublicationDiagnostic[];
  readonly result?: PrPublicationResult;

  constructor(
    code: string,
    message: string,
    diagnostics: readonly PrPublicationDiagnostic[] = [],
    result?: PrPublicationResult,
  ) {
    super(message);
    this.name = "PrPublicationError";
    this.code = code;
    this.diagnostics = Object.freeze([...diagnostics]);
    this.result = result;
  }
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(code: string, path: string, message: string): PrPublicationDiagnostic {
  return { code, path, message };
}

function sortedDiagnostics(diagnostics: readonly PrPublicationDiagnostic[]): readonly PrPublicationDiagnostic[] {
  return Object.freeze(
    [...diagnostics].sort(
      (left, right) => left.path.localeCompare(right.path, "en-US") || left.code.localeCompare(right.code, "en-US"),
    ),
  );
}

function freezeDeep<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => freezeDeep(entry))) as T;
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) result[key] = freezeDeep(value[key]);
    return Object.freeze(result) as T;
  }
  return value;
}

function sameRepository(left: PrPublicationRepositoryIdentity, right: PrPublicationRepositoryIdentity): boolean {
  return (
    left.repositoryHost.toLowerCase() === right.repositoryHost.toLowerCase() && left.repositoryId === right.repositoryId
  );
}

function repositoryIdentity(
  value: unknown,
  path: string,
  diagnostics: PrPublicationDiagnostic[],
): PrPublicationRepositoryIdentity | undefined {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("PR_PUBLICATION_REPOSITORY_INVALID", path, "Repository identity must be an object."));
    return undefined;
  }
  const repositoryHost = value.repositoryHost;
  const repositoryId = value.repositoryId;
  const repository = value.repository;
  if (typeof repositoryHost !== "string" || repositoryHost.length === 0)
    diagnostics.push(
      diagnostic("PR_PUBLICATION_REPOSITORY_INVALID", `${path}.repositoryHost`, "Repository host is required."),
    );
  if (typeof repositoryId !== "string" || !/^[1-9][0-9]{0,19}$/u.test(repositoryId))
    diagnostics.push(
      diagnostic(
        "PR_PUBLICATION_REPOSITORY_INVALID",
        `${path}.repositoryId`,
        "Repository id must be a decimal identity.",
      ),
    );
  if (repository !== undefined && (typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/u.test(repository)))
    diagnostics.push(
      diagnostic("PR_PUBLICATION_REPOSITORY_INVALID", `${path}.repository`, "Repository locator must be owner/name."),
    );
  if (
    typeof repositoryHost !== "string" ||
    typeof repositoryId !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(repositoryId)
  )
    return undefined;
  return {
    repositoryHost: repositoryHost.toLowerCase(),
    repositoryId,
    ...(typeof repository === "string" ? { repository } : {}),
  };
}

function issueReference(
  value: unknown,
  path: string,
  diagnostics: PrPublicationDiagnostic[],
): IssueReference | undefined {
  const result = normalizeIssueReference(value, path);
  if (!result.valid || result.reference === undefined) {
    diagnostics.push(
      diagnostic("PR_PUBLICATION_WORK_IDENTITY_INVALID", path, "Work identity Issue reference is invalid."),
    );
    return undefined;
  }
  return result.reference;
}

function releaseWorkIdentity(
  value: unknown,
  path: string,
  diagnostics: PrPublicationDiagnostic[],
): PrPublicationReleaseWorkIdentity | undefined {
  if (!isRecord(value) || !isRecord(value.release)) {
    diagnostics.push(
      diagnostic("PR_PUBLICATION_WORK_IDENTITY_INVALID", `${path}.release`, "Release identity must be an object."),
    );
    return undefined;
  }
  const release = value.release;
  const targetVersion = release.targetVersion;
  const sourceRevision = release.sourceRevision;
  if (typeof targetVersion !== "string" || targetVersion.length === 0 || targetVersion.length > 256)
    diagnostics.push(
      diagnostic(
        "PR_PUBLICATION_WORK_IDENTITY_INVALID",
        `${path}.release.targetVersion`,
        "Release target version is required and bounded.",
      ),
    );
  if (typeof sourceRevision !== "string" || sourceRevision.trim().length === 0 || sourceRevision.length > 128)
    diagnostics.push(
      diagnostic(
        "PR_PUBLICATION_WORK_IDENTITY_INVALID",
        `${path}.release.sourceRevision`,
        "Release source revision is required and bounded.",
      ),
    );
  if (
    Object.keys(value).some((key) => key !== "release") ||
    Object.keys(release).some((key) => key !== "targetVersion" && key !== "sourceRevision")
  )
    diagnostics.push(
      diagnostic(
        "PR_PUBLICATION_WORK_IDENTITY_INVALID",
        path,
        "Release identity cannot contain an Issue reference or unsupported property.",
      ),
    );
  if (diagnostics.length > 0 || typeof targetVersion !== "string" || typeof sourceRevision !== "string")
    return undefined;
  return { release: { targetVersion, sourceRevision } } as PrPublicationReleaseWorkIdentity;
}

function normalizeWorkIdentity(
  value: unknown,
  path: string,
  diagnostics: PrPublicationDiagnostic[],
): PrPublicationWorkIdentity | undefined {
  if (isRecord(value) && value.release !== undefined) return releaseWorkIdentity(value, path, diagnostics);
  const source =
    isRecord(value) && ("role" in value || "implementation" in value || "issue" in value)
      ? value
      : { implementation: value };
  const role = source.role;
  const allowed =
    role === "issue-integration"
      ? new Set(["role", "sourceIssue", "epic"])
      : role === "epic-integration"
        ? new Set(["role", "epic"])
        : new Set(["role", "implementation", "issue", "sourceIssue", "epic", "identityKey"]);
  for (const key of Object.keys(source))
    if (!allowed.has(key))
      diagnostics.push(
        diagnostic("PR_PUBLICATION_WORK_IDENTITY_INVALID", `${path}.${key}`, "Property is not supported."),
      );

  if (role !== undefined && role !== "implementation" && role !== "issue-integration" && role !== "epic-integration")
    diagnostics.push(
      diagnostic("PR_PUBLICATION_WORK_IDENTITY_INVALID", `${path}.role`, "Publication role is not supported."),
    );

  if (role === "issue-integration") {
    const sourceIssue = issueReference(source.sourceIssue, `${path}.sourceIssue`, diagnostics);
    const epic = issueReference(source.epic, `${path}.epic`, diagnostics);
    if (sourceIssue === undefined || epic === undefined || diagnostics.length > 0) return undefined;
    return { role, sourceIssue, epic };
  }
  if (role === "epic-integration") {
    const epic = issueReference(source.epic, `${path}.epic`, diagnostics);
    if (epic === undefined || diagnostics.length > 0) return undefined;
    return { role, epic };
  }

  const implementation = issueReference(source.implementation ?? source.issue, `${path}.implementation`, diagnostics);
  const sourceIssue =
    source.sourceIssue === undefined
      ? undefined
      : issueReference(source.sourceIssue, `${path}.sourceIssue`, diagnostics);
  const epic = source.epic === undefined ? undefined : issueReference(source.epic, `${path}.epic`, diagnostics);
  const identityKey = source.identityKey;
  if (
    identityKey !== undefined &&
    (typeof identityKey !== "string" || identityKey.length === 0 || identityKey.length > 512)
  )
    diagnostics.push(
      diagnostic(
        "PR_PUBLICATION_WORK_IDENTITY_INVALID",
        `${path}.identityKey`,
        "Identity key must be a bounded non-empty string.",
      ),
    );
  if (implementation === undefined || diagnostics.length > 0) return undefined;
  return {
    implementation,
    ...(sourceIssue === undefined ? {} : { sourceIssue }),
    ...(epic === undefined ? {} : { epic }),
    ...(typeof identityKey === "string" ? { identityKey } : {}),
  };
}

function workIdentityKey(value: PrPublicationWorkIdentity): string {
  if ("release" in value) return `release:${value.release.targetVersion}:${value.release.sourceRevision}`;
  if (value.role === "issue-integration")
    return `issue-integration:${issueReferenceKey(value.sourceIssue)}:${issueReferenceKey(value.epic)}`;
  if (value.role === "epic-integration") return `epic-integration:${issueReferenceKey(value.epic)}`;
  return `implementation:${issueReferenceKey(value.implementation)}:${value.sourceIssue ? issueReferenceKey(value.sourceIssue) : ""}:${value.epic ? issueReferenceKey(value.epic) : ""}`;
}

function workIdentityMatchesRouting(
  workIdentity: PrPublicationWorkIdentity,
  routing: IntegrationRoutingProjection,
): boolean {
  if ("release" in workIdentity || (workIdentity.role ?? "implementation") !== routing.role) return false;
  if (routing.role === "implementation") {
    if (
      (workIdentity.role !== undefined && workIdentity.role !== "implementation") ||
      routing.implementation === undefined ||
      issueReferenceKey(workIdentity.implementation) !== issueReferenceKey(routing.implementation)
    )
      return false;
    if (
      workIdentity.sourceIssue !== undefined &&
      (routing.sourceIssue === undefined ||
        issueReferenceKey(workIdentity.sourceIssue) !== issueReferenceKey(routing.sourceIssue))
    )
      return false;
    if (
      workIdentity.epic !== undefined &&
      (routing.epic === undefined || issueReferenceKey(workIdentity.epic) !== issueReferenceKey(routing.epic))
    )
      return false;
    return true;
  }
  if (routing.role === "issue-integration")
    return (
      workIdentity.role === "issue-integration" &&
      routing.sourceIssue !== undefined &&
      routing.epic !== undefined &&
      issueReferenceKey(workIdentity.sourceIssue) === issueReferenceKey(routing.sourceIssue) &&
      issueReferenceKey(workIdentity.epic) === issueReferenceKey(routing.epic)
    );
  return (
    workIdentity.role === "epic-integration" &&
    routing.epic !== undefined &&
    issueReferenceKey(workIdentity.epic) === issueReferenceKey(routing.epic)
  );
}

function workIdentityReferences(value: PrPublicationWorkIdentity): readonly IssueReference[] {
  if ("release" in value) return [];
  if (value.role === "issue-integration") return [value.sourceIssue, value.epic];
  if (value.role === "epic-integration") return [value.epic];
  return [
    value.implementation,
    ...(value.sourceIssue === undefined ? [] : [value.sourceIssue]),
    ...(value.epic === undefined ? [] : [value.epic]),
  ];
}

type CandidateIdentityEvidence =
  | {
      readonly classification: "canonical";
      readonly workIdentity: PrPublicationWorkIdentity;
      readonly routing?: PrPublicationRouting;
      readonly expectedHead?: string;
      readonly expectedBase?: string;
      readonly headRevision?: string;
      readonly bodyContent?: string;
    }
  | {
      readonly classification: "historical-implementation";
      readonly workIdentity: PrPublicationImplementationWorkIdentity;
      readonly bodyContent?: string;
    }
  | { readonly classification: "invalid"; readonly bodyContent?: string }
  | undefined;

function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

interface PublicationIdentityMarker {
  readonly version: typeof PR_PUBLICATION_IDENTITY_MARKER_VERSION;
  readonly kind: typeof PR_PUBLICATION_IDENTITY_MARKER_KIND;
  readonly workIdentity: PrPublicationWorkIdentity;
  readonly routing: IntegrationRoutingProjection;
  readonly expectedHead: string;
  readonly expectedBase: string;
  readonly headRevision: string;
  readonly bodyLength: number;
}

function markerLine(marker: PublicationIdentityMarker): string {
  const json = JSON.stringify(marker).replaceAll("<", "\\u003c").replaceAll("--", "\\u002d\\u002d");
  return `<!-- inari:pr-publication ${json} -->`;
}

function parseMarkerValue(
  value: unknown,
):
  | { readonly current: PublicationIdentityMarker }
  | { readonly historical: PrPublicationImplementationWorkIdentity }
  | { readonly invalid: true } {
  if (!isRecord(value)) return { invalid: true };
  if (value.kind !== PR_PUBLICATION_IDENTITY_MARKER_KIND && value.version !== PR_PUBLICATION_IDENTITY_MARKER_VERSION) {
    const diagnostics: PrPublicationDiagnostic[] = [];
    const identity = normalizeWorkIdentity(value, "$.bodyMarker", diagnostics);
    return identity !== undefined &&
      !isReleaseWorkIdentity(identity) &&
      (identity.role === undefined || identity.role === "implementation") &&
      diagnostics.length === 0
      ? { historical: { ...identity, role: undefined } as PrPublicationImplementationWorkIdentity }
      : { invalid: true };
  }
  if (
    value.kind !== PR_PUBLICATION_IDENTITY_MARKER_KIND ||
    value.version !== PR_PUBLICATION_IDENTITY_MARKER_VERSION ||
    typeof value.expectedHead !== "string" ||
    typeof value.expectedBase !== "string" ||
    typeof value.headRevision !== "string" ||
    !Number.isSafeInteger(value.bodyLength) ||
    (value.bodyLength as number) < 0
  )
    return { invalid: true };
  const identityDiagnostics: PrPublicationDiagnostic[] = [];
  const workIdentity = normalizeWorkIdentity(value.workIdentity, "$.bodyMarker.workIdentity", identityDiagnostics);
  const routing = tryAdaptIntegrationRouting(value.routing);
  if (
    workIdentity === undefined ||
    identityDiagnostics.length > 0 ||
    routing === undefined ||
    !routing.valid ||
    routing.projection === undefined ||
    !workIdentityMatchesRouting(workIdentity, routing.projection) ||
    routing.projection.expectedBase !== value.expectedBase ||
    routing.projection.expectedHead !== value.expectedHead
  )
    return { invalid: true };
  return {
    current: {
      version: PR_PUBLICATION_IDENTITY_MARKER_VERSION,
      kind: PR_PUBLICATION_IDENTITY_MARKER_KIND,
      workIdentity,
      routing: routing.projection,
      expectedHead: value.expectedHead,
      expectedBase: value.expectedBase,
      headRevision: value.headRevision,
      bodyLength: value.bodyLength as number,
    },
  };
}

function bodyMarker(
  body: string | null | undefined,
):
  | { readonly marker: PublicationIdentityMarker; readonly bodyContent: string }
  | { readonly historical: PrPublicationImplementationWorkIdentity; readonly bodyContent: string }
  | { readonly invalid: true }
  | undefined {
  if (typeof body !== "string") return undefined;
  const start = body.lastIndexOf("inari:pr-publication ");
  if (start < 0) return undefined;
  const match = /inari:pr-publication\s+(\{[^\r\n]*\})\s+-->/u.exec(body.slice(start));
  if (match === null || /inari:pr-publication\s+\{/u.test(body.slice(0, start))) return { invalid: true };
  const markerStart = start >= 5 && body.slice(start - 5, start) === "<!-- " ? start - 5 : -1;
  if (markerStart < 0 || body.slice(markerStart).trim() !== `<!-- ${match[0]}`) return { invalid: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    return { invalid: true };
  }
  const evidence = parseMarkerValue(parsed);
  if ("invalid" in evidence) return evidence;
  if ("historical" in evidence) {
    return { historical: evidence.historical, bodyContent: body.slice(0, markerStart).replace(/\r?\n$/u, "") };
  }
  if (evidence.current.bodyLength > body.length) return { invalid: true };
  const bodyContent = body.slice(0, evidence.current.bodyLength);
  const separator = bodyContent.length === 0 || bodyContent.endsWith("\n") || bodyContent.endsWith("\r") ? "" : "\n";
  if (
    markerLine(evidence.current) !== body.slice(markerStart).trim() ||
    markerStart < bodyContent.length ||
    body.slice(bodyContent.length, markerStart) !== separator
  )
    return { invalid: true };
  return { marker: evidence.current, bodyContent };
}

function bodyForIdentity(
  bodyContent: string,
  workIdentity: PrPublicationWorkIdentity,
  routing: IntegrationRoutingProjection,
  expectedHead: string,
  expectedBase: string,
  headRevision: string,
): string {
  if ("release" in workIdentity) return bodyContent;
  const marker: PublicationIdentityMarker = {
    version: PR_PUBLICATION_IDENTITY_MARKER_VERSION,
    kind: PR_PUBLICATION_IDENTITY_MARKER_KIND,
    workIdentity,
    routing,
    expectedHead,
    expectedBase,
    headRevision,
    bodyLength: bodyContent.length,
  };
  const separator = bodyContent.length === 0 || bodyContent.endsWith("\n") || bodyContent.endsWith("\r") ? "" : "\n";
  return `${bodyContent}${separator}${markerLine(marker)}`;
}

function requestBodyContent(request: NormalizedPrPublicationRequest): string {
  const evidence = bodyMarker(request.body);
  return evidence !== undefined && "bodyContent" in evidence ? evidence.bodyContent : request.body;
}

function candidateIdentity(
  candidate: PrPublicationRecord,
  repository: PrPublicationRepositoryIdentity,
): CandidateIdentityEvidence {
  const bodyEvidence = bodyMarker(candidate.body);
  if (bodyEvidence !== undefined && "invalid" in bodyEvidence) return { classification: "invalid" };
  const diagnostics: PrPublicationDiagnostic[] = [];
  const explicit =
    candidate.workIdentity === undefined
      ? undefined
      : normalizeWorkIdentity(candidate.workIdentity, "$.workIdentity", diagnostics);
  if (candidate.workIdentity !== undefined && (explicit === undefined || diagnostics.length > 0))
    return {
      classification: "invalid",
      ...(bodyEvidence !== undefined && "bodyContent" in bodyEvidence ? { bodyContent: bodyEvidence.bodyContent } : {}),
    };
  if (bodyEvidence !== undefined && "marker" in bodyEvidence) {
    if (explicit !== undefined && workIdentityKey(explicit) !== workIdentityKey(bodyEvidence.marker.workIdentity))
      return { classification: "invalid", bodyContent: bodyEvidence.bodyContent };
    return {
      classification: "canonical",
      workIdentity: bodyEvidence.marker.workIdentity,
      routing: bodyEvidence.marker.routing,
      expectedHead: bodyEvidence.marker.expectedHead,
      expectedBase: bodyEvidence.marker.expectedBase,
      headRevision: bodyEvidence.marker.headRevision,
      bodyContent: bodyEvidence.bodyContent,
    };
  }
  if (bodyEvidence !== undefined && "historical" in bodyEvidence) {
    if (explicit !== undefined && workIdentityKey(explicit) !== workIdentityKey(bodyEvidence.historical))
      return { classification: "invalid", bodyContent: bodyEvidence.bodyContent };
    return {
      classification: "historical-implementation",
      workIdentity: bodyEvidence.historical,
      bodyContent: bodyEvidence.bodyContent,
    };
  }
  if (explicit !== undefined) {
    if ("release" in explicit)
      return { classification: "canonical", workIdentity: explicit, bodyContent: candidate.body ?? undefined };
    if ((explicit.role === undefined || explicit.role === "implementation") && !isRecord(candidate.workIdentity))
      return { classification: "historical-implementation", workIdentity: explicit };
    if (
      (explicit.role === undefined || explicit.role === "implementation") &&
      isRecord(candidate.workIdentity) &&
      !("role" in candidate.workIdentity)
    )
      return { classification: "historical-implementation", workIdentity: explicit };
    return { classification: "canonical", workIdentity: explicit, bodyContent: candidate.body ?? undefined };
  }
  const match = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9][0-9]*)\b/iu.exec(candidate.body ?? "");
  if (match === null) return undefined;
  const referenceDiagnostics: PrPublicationDiagnostic[] = [];
  const legacy = normalizeWorkIdentity(
    { implementation: { ...repository, number: Number(match[1]) } },
    "$.bodyReference",
    referenceDiagnostics,
  );
  return legacy === undefined || isReleaseWorkIdentity(legacy) || legacy.role !== undefined
    ? { classification: "invalid" }
    : {
        classification: "historical-implementation",
        workIdentity: { ...legacy, role: undefined } as PrPublicationImplementationWorkIdentity,
      };
}

function requestResult(
  classification: PrPublicationResultClassification,
  diagnostics: readonly PrPublicationDiagnostic[],
  pullRequest?: PrPublicationRecord,
  routing?: PrPublicationRouting,
  effectStatus: "succeeded" | "not-attempted" = classification === "created" ? "succeeded" : "not-attempted",
): PrPublicationResult {
  return freezeDeep({
    version: PR_PUBLICATION_CONTRACT_VERSION,
    kind: PR_PUBLICATION_KIND,
    ok: classification !== "failed",
    classification,
    outcome: classification,
    ...(pullRequest === undefined ? {} : { pullRequest: { number: pullRequest.number, url: pullRequest.url } }),
    ...(routing === undefined ? {} : { routing }),
    diagnostics: sortedDiagnostics(diagnostics),
    effects: [{ kind: "CREATE_PULL_REQUEST" as const, status: effectStatus }],
  });
}

function isReleaseWorkIdentity(
  value: PrPublicationWorkIdentity | undefined,
): value is PrPublicationReleaseWorkIdentity {
  return value !== undefined && "release" in value;
}

function releaseRouting(
  value: unknown,
  identity: PrPublicationReleaseWorkIdentity,
  diagnostics: PrPublicationDiagnostic[],
): ReleasePrPublicationRoute | undefined {
  let derived: ReleasePrPublicationRoute | undefined;
  try {
    derived = deriveReleasePrPublicationRoute(identity.release.targetVersion, identity.release.sourceRevision);
  } catch (error: unknown) {
    diagnostics.push(
      diagnostic(
        "PR_PUBLICATION_RELEASE_ROUTE_INVALID",
        "$.workIdentity.release",
        error instanceof Error ? error.message : "Release route identity is invalid.",
      ),
    );
  }
  if (value === undefined) return derived;
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic("PR_PUBLICATION_RELEASE_ROUTE_INVALID", "$.routing", "Release routing must be an object."),
    );
    return derived;
  }
  if (value.kind !== "release-pr-publication" || value.role !== "release")
    diagnostics.push(
      diagnostic(
        "PR_PUBLICATION_RELEASE_ROUTE_INVALID",
        "$.routing",
        "Release publication must use the canonical release route.",
      ),
    );
  if (derived !== undefined) {
    const head = value.head ?? value.expectedHead;
    const base = value.base ?? value.expectedBase;
    const revision = value.headRevision ?? value.sourceRevision;
    if (value.targetVersion !== undefined && value.targetVersion !== derived.targetVersion)
      diagnostics.push(
        diagnostic(
          "PR_PUBLICATION_RELEASE_VERSION_MISMATCH",
          "$.routing.targetVersion",
          "Release route version must match identity.",
        ),
      );
    if (head !== undefined && head !== derived.head)
      diagnostics.push(
        diagnostic(
          "PR_PUBLICATION_RELEASE_HEAD_MISMATCH",
          "$.routing.head",
          "Release route head must be release/<semver>.",
        ),
      );
    if (base !== undefined && base !== derived.base)
      diagnostics.push(
        diagnostic(
          "PR_PUBLICATION_RELEASE_BASE_MISMATCH",
          "$.routing.base",
          "Release route base must be the governed default branch.",
        ),
      );
    if (revision !== undefined && revision !== derived.headRevision)
      diagnostics.push(
        diagnostic(
          "PR_PUBLICATION_RELEASE_REVISION_MISMATCH",
          "$.routing.headRevision",
          "Release route revision must match source revision.",
        ),
      );
  }
  return derived;
}

function validateRequest(input: unknown): PrPublicationValidationResult {
  const diagnostics: PrPublicationDiagnostic[] = [];
  if (!isRecord(input))
    return {
      valid: false,
      diagnostics: [diagnostic("PR_PUBLICATION_REQUEST_INVALID", "$", "Publication request must be an object.")],
    };
  const allowed = new Set([
    "version",
    "kind",
    "repository",
    "workIdentity",
    "routing",
    "expectedHead",
    "expectedBase",
    "headRevision",
    "title",
    "body",
    "draft",
    "maintainerCanModify",
  ]);
  for (const key of Object.keys(input))
    if (!allowed.has(key))
      diagnostics.push(diagnostic("PR_PUBLICATION_UNKNOWN_PROPERTY", `$.${key}`, "Property is not supported."));
  if (input.version !== PR_PUBLICATION_CONTRACT_VERSION)
    diagnostics.push(
      diagnostic("PR_PUBLICATION_VERSION_UNSUPPORTED", "$.version", "Only publication request version 1 is supported."),
    );
  if (input.kind !== undefined && input.kind !== PR_PUBLICATION_KIND)
    diagnostics.push(diagnostic("PR_PUBLICATION_KIND_INVALID", "$.kind", `kind must be \"${PR_PUBLICATION_KIND}\".`));
  const repository = repositoryIdentity(input.repository, "$.repository", diagnostics);
  const workIdentity = normalizeWorkIdentity(input.workIdentity, "$.workIdentity", diagnostics);
  const release = isReleaseWorkIdentity(workIdentity) ? workIdentity : undefined;
  const route = release ? undefined : tryAdaptIntegrationRouting(input.routing);
  const routing = release ? releaseRouting(input.routing, release, diagnostics) : route?.projection;
  if (route !== undefined && (!route.valid || route.projection === undefined))
    for (const item of route.diagnostics)
      diagnostics.push(diagnostic("PR_PUBLICATION_ROUTING_INVALID", item.path, item.message));
  if (routing !== undefined && repository !== undefined) {
    if ("role" in routing && routing.role === "release") {
      if (!isReleaseWorkIdentity(workIdentity))
        diagnostics.push(
          diagnostic(
            "PR_PUBLICATION_WORK_IDENTITY_MISMATCH",
            "$.workIdentity.role",
            "Release routing requires the release work identity.",
          ),
        );
    } else {
      const refs = [routing.implementation, routing.sourceIssue, routing.epic].filter(
        (entry): entry is IssueReference => entry !== undefined,
      );
      for (const ref of refs)
        if (
          ref.repositoryHost.toLowerCase() !== repository.repositoryHost ||
          ref.repositoryId !== repository.repositoryId
        )
          diagnostics.push(
            diagnostic(
              "PR_PUBLICATION_REPOSITORY_MISMATCH",
              "$.routing",
              "Routing references must match the request repository.",
            ),
          );
      if (workIdentity !== undefined && !isReleaseWorkIdentity(workIdentity)) {
        for (const ref of workIdentityReferences(workIdentity))
          if (!sameRepository(ref, repository))
            diagnostics.push(
              diagnostic(
                "PR_PUBLICATION_REPOSITORY_MISMATCH",
                "$.workIdentity",
                "Work identity references must match the request repository.",
              ),
            );
        if (!workIdentityMatchesRouting(workIdentity, routing))
          diagnostics.push(
            diagnostic(
              "PR_PUBLICATION_WORK_IDENTITY_MISMATCH",
              "$.workIdentity",
              "Work identity role and governed references must match canonical routing.",
            ),
          );
      }
    }
  }
  const releaseExpectedHead =
    routing !== undefined && "role" in routing && routing.role === "release" ? routing.head : undefined;
  const releaseExpectedBase =
    routing !== undefined && "role" in routing && routing.role === "release" ? routing.base : undefined;
  const expectedHead =
    input.expectedHead ?? releaseExpectedHead ?? (routing as IntegrationRoutingProjection | undefined)?.expectedHead;
  const expectedBase =
    input.expectedBase ?? releaseExpectedBase ?? (routing as IntegrationRoutingProjection | undefined)?.expectedBase;
  if (typeof expectedHead !== "string" || expectedHead.length === 0)
    diagnostics.push(diagnostic("PR_PUBLICATION_HEAD_INVALID", "$.expectedHead", "Expected head is required."));
  if (typeof expectedBase !== "string" || expectedBase.length === 0)
    diagnostics.push(diagnostic("PR_PUBLICATION_BASE_INVALID", "$.expectedBase", "Expected base is required."));
  if (routing !== undefined && "role" in routing && routing.role === "release") {
    if (typeof expectedHead === "string" && expectedHead !== routing.head)
      diagnostics.push(
        diagnostic(
          "PR_PUBLICATION_RELEASE_HEAD_MISMATCH",
          "$.expectedHead",
          "Expected head must match release/<semver>.",
        ),
      );
    if (typeof expectedBase === "string" && expectedBase !== routing.base)
      diagnostics.push(
        diagnostic(
          "PR_PUBLICATION_RELEASE_BASE_MISMATCH",
          "$.expectedBase",
          "Expected base must be the governed default branch.",
        ),
      );
  } else if (routing !== undefined) {
    if (typeof expectedHead === "string" && routing.expectedHead !== undefined && expectedHead !== routing.expectedHead)
      diagnostics.push(
        diagnostic("PR_PUBLICATION_HEAD_MISMATCH", "$.expectedHead", "Expected head must match canonical routing."),
      );
    if (typeof expectedBase === "string" && expectedBase !== routing.expectedBase)
      diagnostics.push(
        diagnostic("PR_PUBLICATION_BASE_MISMATCH", "$.expectedBase", "Expected base must match canonical routing."),
      );
  }
  if (
    typeof input.headRevision !== "string" ||
    input.headRevision.trim().length === 0 ||
    input.headRevision.length > 256
  )
    diagnostics.push(
      diagnostic("PR_PUBLICATION_HEAD_REVISION_INVALID", "$.headRevision", "Head revision is required and bounded."),
    );
  if (
    release !== undefined &&
    typeof input.headRevision === "string" &&
    input.headRevision !== release.release.sourceRevision
  )
    diagnostics.push(
      diagnostic(
        "PR_PUBLICATION_RELEASE_REVISION_MISMATCH",
        "$.headRevision",
        "Release head revision must match the exact source revision.",
      ),
    );
  if (typeof input.title !== "string" || input.title.trim().length === 0 || input.title.length > 256)
    diagnostics.push(diagnostic("PR_PUBLICATION_TITLE_INVALID", "$.title", "Title is required and bounded."));
  if (typeof input.body !== "string" || input.body.length > 1_000_000)
    diagnostics.push(diagnostic("PR_PUBLICATION_BODY_INVALID", "$.body", "Body must be a bounded string."));
  if (input.draft !== undefined && typeof input.draft !== "boolean")
    diagnostics.push(diagnostic("PR_PUBLICATION_DRAFT_INVALID", "$.draft", "draft must be boolean."));
  if (input.maintainerCanModify !== undefined && typeof input.maintainerCanModify !== "boolean")
    diagnostics.push(
      diagnostic("PR_PUBLICATION_MAINTAINER_INVALID", "$.maintainerCanModify", "maintainerCanModify must be boolean."),
    );
  let bodyContent = typeof input.body === "string" ? input.body : "";
  let publicationBody = bodyContent;
  if (
    typeof input.body === "string" &&
    workIdentity !== undefined &&
    !isReleaseWorkIdentity(workIdentity) &&
    (workIdentity.role === "issue-integration" || workIdentity.role === "epic-integration") &&
    routing !== undefined &&
    !("role" in routing && routing.role === "release") &&
    typeof expectedHead === "string" &&
    typeof expectedBase === "string" &&
    typeof input.headRevision === "string"
  ) {
    const existingMarker = bodyMarker(input.body);
    if (existingMarker !== undefined && "invalid" in existingMarker) {
      diagnostics.push(
        diagnostic(
          "PR_PUBLICATION_WORK_IDENTITY_INVALID",
          "$.body",
          "Publication identity marker is malformed or contradictory.",
        ),
      );
    } else if (existingMarker !== undefined && "marker" in existingMarker) {
      const marker = existingMarker.marker;
      if (
        workIdentityKey(marker.workIdentity) !== workIdentityKey(workIdentity) ||
        stableKey(marker.routing) !== stableKey(routing) ||
        marker.expectedHead !== expectedHead ||
        marker.expectedBase !== expectedBase ||
        marker.headRevision !== input.headRevision
      )
        diagnostics.push(
          diagnostic(
            "PR_PUBLICATION_WORK_IDENTITY_MISMATCH",
            "$.body",
            "Publication identity marker must match the governed role, route, and revision.",
          ),
        );
      bodyContent = existingMarker.bodyContent;
    } else if (existingMarker !== undefined && "historical" in existingMarker) {
      diagnostics.push(
        diagnostic(
          "PR_PUBLICATION_WORK_IDENTITY_MISMATCH",
          "$.body",
          "Historical Implementation identity cannot bind another publication role.",
        ),
      );
      bodyContent = existingMarker.bodyContent;
    }
    publicationBody = bodyForIdentity(
      bodyContent,
      workIdentity,
      routing,
      expectedHead,
      expectedBase,
      input.headRevision,
    );
    if (publicationBody.length > 1_000_000)
      diagnostics.push(diagnostic("PR_PUBLICATION_BODY_INVALID", "$.body", "Bound publication body is too large."));
  }
  if (
    diagnostics.length > 0 ||
    repository === undefined ||
    workIdentity === undefined ||
    routing === undefined ||
    typeof expectedHead !== "string" ||
    typeof expectedBase !== "string" ||
    typeof input.headRevision !== "string" ||
    typeof input.title !== "string" ||
    typeof input.body !== "string"
  )
    return {
      valid: false,
      diagnostics: sortedDiagnostics(diagnostics),
      ...(routing === undefined ? {} : { routing }),
      ...(workIdentity === undefined ? {} : { workIdentity }),
    };
  const request: NormalizedPrPublicationRequest = freezeDeep({
    version: PR_PUBLICATION_CONTRACT_VERSION,
    kind: PR_PUBLICATION_KIND,
    repository,
    workIdentity,
    routing,
    expectedHead,
    expectedBase,
    headRevision: input.headRevision,
    title: input.title,
    body: publicationBody,
    ...(typeof input.draft === "boolean" ? { draft: input.draft } : {}),
    ...(typeof input.maintainerCanModify === "boolean" ? { maintainerCanModify: input.maintainerCanModify } : {}),
  });
  return { valid: true, request, routing, workIdentity, diagnostics: [] };
}

export function tryValidatePrPublicationRequest(input: unknown): PrPublicationValidationResult {
  return validateRequest(input);
}

export const tryValidatePullRequestPublication = tryValidatePrPublicationRequest;

function candidateIdentityMatchesRequest(
  identity: CandidateIdentityEvidence,
  request: NormalizedPrPublicationRequest,
): boolean {
  if (identity === undefined || identity.classification === "invalid") return false;
  if (identity.classification === "historical-implementation")
    return (
      !isReleaseWorkIdentity(request.workIdentity) &&
      (request.workIdentity.role === undefined || request.workIdentity.role === "implementation") &&
      issueReferenceKey(identity.workIdentity.implementation) === issueReferenceKey(request.workIdentity.implementation)
    );
  if (workIdentityKey(identity.workIdentity) !== workIdentityKey(request.workIdentity)) return false;
  if (!isReleaseWorkIdentity(request.workIdentity) && identity.routing === undefined) return false;
  if (identity.routing !== undefined && stableKey(identity.routing) !== stableKey(request.routing)) return false;
  if (identity.expectedHead !== undefined && identity.expectedHead !== request.expectedHead) return false;
  if (identity.expectedBase !== undefined && identity.expectedBase !== request.expectedBase) return false;
  if (identity.headRevision !== undefined && identity.headRevision !== request.headRevision) return false;
  return true;
}

function candidateCoreMatches(candidate: PrPublicationRecord, request: NormalizedPrPublicationRequest): boolean {
  if (candidate.repository !== undefined && !sameRepository(candidate.repository, request.repository)) return false;
  if (candidate.head !== request.expectedHead || candidate.base !== request.expectedBase) return false;
  if (candidate.headRevision !== request.headRevision) return false;
  const identity = candidateIdentity(candidate, request.repository);
  if (isReleaseWorkIdentity(request.workIdentity)) {
    if (identity === undefined) return request.expectedHead === `release/${request.workIdentity.release.targetVersion}`;
    return candidateIdentityMatchesRequest(identity, request);
  }
  return candidateIdentityMatchesRequest(identity, request);
}

function candidateBodyContent(candidate: PrPublicationRecord, request: NormalizedPrPublicationRequest): string | null {
  const identity = candidateIdentity(candidate, request.repository);
  if (identity !== undefined && "bodyContent" in identity && identity.bodyContent !== undefined)
    return identity.bodyContent;
  return candidate.body;
}

function candidateMatches(candidate: PrPublicationRecord, request: NormalizedPrPublicationRequest): boolean {
  return (
    candidateCoreMatches(candidate, request) &&
    candidate.title === request.title &&
    candidateBodyContent(candidate, request) === requestBodyContent(request)
  );
}

function candidateConflicts(candidate: PrPublicationRecord, request: NormalizedPrPublicationRequest): boolean {
  if (candidate.repository !== undefined && !sameRepository(candidate.repository, request.repository)) return true;
  if (candidate.head !== request.expectedHead || candidate.base !== request.expectedBase) return false;
  if (candidate.headRevision !== request.headRevision) return true;
  if (candidate.title !== request.title || candidateBodyContent(candidate, request) !== requestBodyContent(request))
    return true;
  const identity = candidateIdentity(candidate, request.repository);
  if (isReleaseWorkIdentity(request.workIdentity) && identity === undefined)
    return request.expectedHead !== `release/${request.workIdentity.release.targetVersion}`;
  return !candidateIdentityMatchesRequest(identity, request);
}

function matchingResult(
  records: readonly PrPublicationRecord[],
  request: NormalizedPrPublicationRequest,
  routing: PrPublicationRouting,
): PrPublicationResult | undefined {
  const coreMatches = records.filter((candidate) => candidateCoreMatches(candidate, request));
  const exact = records.filter((candidate) => candidateMatches(candidate, request));
  const conflicts = records.filter((candidate) => candidateConflicts(candidate, request));
  if (coreMatches.length > 1 || exact.length > 1)
    return requestResult(
      "failed",
      [
        diagnostic(
          "PR_PUBLICATION_AMBIGUOUS_MATCH",
          "$.pullRequests",
          "Multiple exact pull-request matches exist; publication is fail-closed.",
        ),
      ],
      undefined,
      routing,
    );
  if (conflicts.length > 0)
    return requestResult(
      "failed",
      [
        diagnostic(
          "PR_PUBLICATION_CONFLICTING_MATCH",
          "$.pullRequests",
          "A conflicting pull request already exists; publication is fail-closed.",
        ),
      ],
      undefined,
      routing,
    );
  if (exact.length === 1) return requestResult("returned-existing", [], exact[0], routing);
  return undefined;
}

async function reread(
  provider: PrPublicationProvider,
  request: NormalizedPrPublicationRequest,
  routing: PrPublicationRouting,
): Promise<PrPublicationResult | undefined> {
  try {
    const records = await provider.listPullRequests({
      repository: request.repository,
      head: request.expectedHead,
      base: request.expectedBase,
    });
    return matchingResult(records, request, routing);
  } catch {
    return undefined;
  }
}

/** Publish one governed PR, converging exact retries and create uncertainty by authoritative reread. */
export async function publishPullRequest(
  input: unknown,
  provider: PrPublicationProvider,
): Promise<PrPublicationResult> {
  const validation = validateRequest(input);
  if (!validation.valid || validation.request === undefined || validation.routing === undefined)
    return requestResult("failed", validation.diagnostics, undefined, validation.routing);
  const request = validation.request;
  const routing = validation.routing;
  if (
    provider === undefined ||
    typeof provider.listPullRequests !== "function" ||
    typeof provider.readPullRequest !== "function" ||
    typeof provider.createPullRequest !== "function"
  )
    return requestResult(
      "failed",
      [
        diagnostic(
          "PR_PUBLICATION_PROVIDER_INVALID",
          "$.provider",
          "Publication provider must expose list/read/create.",
        ),
      ],
      undefined,
      routing,
    );
  try {
    if (provider.getRepositoryIdentity !== undefined) {
      const actual = await provider.getRepositoryIdentity();
      if (!sameRepository(actual, request.repository))
        return requestResult(
          "failed",
          [
            diagnostic(
              "PR_PUBLICATION_REPOSITORY_MISMATCH",
              "$.repository",
              "Provider repository does not match the governed request.",
            ),
          ],
          undefined,
          routing,
        );
    }
    const existing = matchingResult(
      await provider.listPullRequests({
        repository: request.repository,
        head: request.expectedHead,
        base: request.expectedBase,
      }),
      request,
      routing,
    );
    if (existing !== undefined) return existing;
    let created: PrPublicationRecord;
    try {
      created = await provider.createPullRequest({
        repository: request.repository,
        workIdentity: request.workIdentity,
        title: request.title,
        body: request.body,
        head: request.expectedHead,
        base: request.expectedBase,
        headRevision: request.headRevision,
        ...(request.draft === undefined ? {} : { draft: request.draft }),
        ...(request.maintainerCanModify === undefined ? {} : { maintainerCanModify: request.maintainerCanModify }),
      });
    } catch {
      const converged = await reread(provider, request, routing);
      if (converged !== undefined) return converged;
      return requestResult(
        "failed",
        [
          diagnostic(
            "PR_PUBLICATION_CREATE_UNCERTAIN",
            "$.create",
            "Provider create was uncertain and authoritative reread found no exact match.",
          ),
        ],
        undefined,
        routing,
      );
    }
    // A successful response is still verified through the provider's read seam.
    try {
      const observed = await provider.readPullRequest(created.number);
      if (candidateMatches(observed, request)) return requestResult("created", [], observed, routing);
    } catch {
      // Fall through to the list reread below.
    }
    const converged = await reread(provider, request, routing);
    if (converged !== undefined && converged.ok)
      return {
        ...converged,
        classification: "created",
        outcome: "created",
        effects: [{ kind: "CREATE_PULL_REQUEST", status: "succeeded" }],
      };
    return requestResult(
      "failed",
      [
        diagnostic(
          "PR_PUBLICATION_VERIFICATION_FAILED",
          "$.create",
          "Created pull request could not be authoritatively verified.",
        ),
      ],
      undefined,
      routing,
    );
  } catch {
    return requestResult(
      "failed",
      [diagnostic("PR_PUBLICATION_PROVIDER_FAILED", "$.provider", "Provider publication failed.")],
      undefined,
      routing,
    );
  }
}

export const executePrPublication = publishPullRequest;
export const publishGovernedPullRequest = publishPullRequest;
