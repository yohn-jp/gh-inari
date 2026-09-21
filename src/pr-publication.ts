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

export const PR_PUBLICATION_CONTRACT_VERSION = 1 as const;
export type PrPublicationContractVersion = typeof PR_PUBLICATION_CONTRACT_VERSION;
export const PR_PUBLICATION_KIND = "pr-publication" as const;
export const PR_PUBLICATION_RESULT_CLASSIFICATIONS = Object.freeze(["created", "returned-existing", "failed"] as const);
export type PrPublicationResultClassification = (typeof PR_PUBLICATION_RESULT_CLASSIFICATIONS)[number];

export interface PrPublicationRepositoryIdentity {
  readonly repositoryHost: string;
  readonly repositoryId: string;
  readonly repository?: string;
}

/** The governed work identity is deliberately explicit and repository-bound. */
export interface PrPublicationWorkIdentity {
  readonly implementation: IssueReference;
  readonly sourceIssue?: IssueReference;
  readonly identityKey?: string;
}

export interface PrPublicationRequest {
  readonly version: PrPublicationContractVersion;
  readonly kind?: typeof PR_PUBLICATION_KIND;
  readonly repository: PrPublicationRepositoryIdentity;
  readonly workIdentity: unknown;
  /** Raw route input or the canonical #925 projection. */
  readonly routing: unknown;
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
  readonly routing?: IntegrationRoutingProjection;
  readonly diagnostics: readonly PrPublicationDiagnostic[];
  readonly effects: readonly Readonly<{
    readonly kind: "CREATE_PULL_REQUEST";
    readonly status: "succeeded" | "not-attempted";
  }>[];
}

export interface PrPublicationValidationResult {
  readonly valid: boolean;
  readonly request?: NormalizedPrPublicationRequest;
  readonly routing?: IntegrationRoutingProjection;
  readonly workIdentity?: PrPublicationWorkIdentity;
  readonly diagnostics: readonly PrPublicationDiagnostic[];
}

export interface NormalizedPrPublicationRequest {
  readonly version: PrPublicationContractVersion;
  readonly kind: typeof PR_PUBLICATION_KIND;
  readonly repository: PrPublicationRepositoryIdentity;
  readonly workIdentity: PrPublicationWorkIdentity;
  readonly routing: IntegrationRoutingProjection;
  readonly expectedHead: string;
  readonly expectedBase: string;
  readonly headRevision: string;
  readonly title: string;
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

function normalizeWorkIdentity(
  value: unknown,
  path: string,
  diagnostics: PrPublicationDiagnostic[],
): PrPublicationWorkIdentity | undefined {
  const source =
    isRecord(value) && (value.implementation !== undefined || value.issue !== undefined)
      ? value
      : { implementation: value };
  const implementation = issueReference(source.implementation ?? source.issue, `${path}.implementation`, diagnostics);
  const sourceIssue =
    source.sourceIssue === undefined
      ? undefined
      : issueReference(source.sourceIssue, `${path}.sourceIssue`, diagnostics);
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
  if (implementation === undefined) return undefined;
  return {
    implementation,
    ...(sourceIssue === undefined ? {} : { sourceIssue }),
    ...(typeof identityKey === "string" ? { identityKey } : {}),
  };
}

function workIdentityKey(value: PrPublicationWorkIdentity): string {
  // The GitHub PR relation persists the governed Implementation reference;
  // authorization/source evidence remains request-side binding data and is
  // intentionally not reconstructed from mutable PR prose.
  return issueReferenceKey(value.implementation);
}

function bodyWorkIdentity(
  body: string | null | undefined,
  repository: PrPublicationRepositoryIdentity,
): PrPublicationWorkIdentity | undefined {
  if (typeof body !== "string") return undefined;
  const marker = /inari:pr-publication\s+(\{[^\n]*\})/u.exec(body);
  if (marker !== null) {
    try {
      const parsed = JSON.parse(marker[1]!) as unknown;
      const diagnostics: PrPublicationDiagnostic[] = [];
      const normalized = normalizeWorkIdentity(parsed, "$.bodyMarker", diagnostics);
      if (normalized !== undefined && diagnostics.length === 0) return normalized;
    } catch {
      // The body is provider data. It is simply not identity evidence when malformed.
    }
  }
  const match = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9][0-9]*)\b/iu.exec(body);
  if (match === null) return undefined;
  const diagnostics: PrPublicationDiagnostic[] = [];
  return normalizeWorkIdentity(
    { implementation: { ...repository, number: Number(match[1]) } },
    "$.bodyReference",
    diagnostics,
  );
}

function candidateIdentity(
  candidate: PrPublicationRecord,
  repository: PrPublicationRepositoryIdentity,
): PrPublicationWorkIdentity | undefined {
  const diagnostics: PrPublicationDiagnostic[] = [];
  const explicit =
    candidate.workIdentity === undefined
      ? undefined
      : normalizeWorkIdentity(candidate.workIdentity, "$.workIdentity", diagnostics);
  return explicit ?? bodyWorkIdentity(candidate.body, repository);
}

function requestResult(
  classification: PrPublicationResultClassification,
  diagnostics: readonly PrPublicationDiagnostic[],
  pullRequest?: PrPublicationRecord,
  routing?: IntegrationRoutingProjection,
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
  const route = tryAdaptIntegrationRouting(input.routing);
  const routing = route.projection;
  if (!route.valid || routing === undefined)
    for (const item of route.diagnostics)
      diagnostics.push(diagnostic("PR_PUBLICATION_ROUTING_INVALID", item.path, item.message));
  if (routing !== undefined && repository !== undefined) {
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
    if (
      workIdentity !== undefined &&
      !sameRepository(
        {
          repositoryHost: workIdentity.implementation.repositoryHost,
          repositoryId: workIdentity.implementation.repositoryId,
        },
        repository,
      )
    )
      diagnostics.push(
        diagnostic(
          "PR_PUBLICATION_REPOSITORY_MISMATCH",
          "$.workIdentity.implementation",
          "Work identity must match the request repository.",
        ),
      );
    if (
      workIdentity !== undefined &&
      routing.implementation !== undefined &&
      issueReferenceKey(workIdentity.implementation) !== issueReferenceKey(routing.implementation)
    )
      diagnostics.push(
        diagnostic(
          "PR_PUBLICATION_WORK_IDENTITY_MISMATCH",
          "$.workIdentity.implementation",
          "Work identity must match the canonical routing Implementation.",
        ),
      );
    if (
      workIdentity?.sourceIssue !== undefined &&
      routing.sourceIssue !== undefined &&
      issueReferenceKey(workIdentity.sourceIssue) !== issueReferenceKey(routing.sourceIssue)
    )
      diagnostics.push(
        diagnostic(
          "PR_PUBLICATION_WORK_IDENTITY_MISMATCH",
          "$.workIdentity.sourceIssue",
          "Work identity source Issue must match canonical routing.",
        ),
      );
  }
  const expectedHead = input.expectedHead ?? routing?.expectedHead;
  const expectedBase = input.expectedBase ?? routing?.expectedBase;
  if (typeof expectedHead !== "string" || expectedHead.length === 0)
    diagnostics.push(diagnostic("PR_PUBLICATION_HEAD_INVALID", "$.expectedHead", "Expected head is required."));
  if (typeof expectedBase !== "string" || expectedBase.length === 0)
    diagnostics.push(diagnostic("PR_PUBLICATION_BASE_INVALID", "$.expectedBase", "Expected base is required."));
  if (
    routing !== undefined &&
    typeof expectedHead === "string" &&
    routing.expectedHead !== undefined &&
    expectedHead !== routing.expectedHead
  )
    diagnostics.push(
      diagnostic("PR_PUBLICATION_HEAD_MISMATCH", "$.expectedHead", "Expected head must match canonical routing."),
    );
  if (routing !== undefined && typeof expectedBase === "string" && expectedBase !== routing.expectedBase)
    diagnostics.push(
      diagnostic("PR_PUBLICATION_BASE_MISMATCH", "$.expectedBase", "Expected base must match canonical routing."),
    );
  if (
    typeof input.headRevision !== "string" ||
    input.headRevision.trim().length === 0 ||
    input.headRevision.length > 256
  )
    diagnostics.push(
      diagnostic("PR_PUBLICATION_HEAD_REVISION_INVALID", "$.headRevision", "Head revision is required and bounded."),
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
    body: input.body,
    ...(typeof input.draft === "boolean" ? { draft: input.draft } : {}),
    ...(typeof input.maintainerCanModify === "boolean" ? { maintainerCanModify: input.maintainerCanModify } : {}),
  });
  return { valid: true, request, routing, workIdentity, diagnostics: [] };
}

export function tryValidatePrPublicationRequest(input: unknown): PrPublicationValidationResult {
  return validateRequest(input);
}

export const tryValidatePullRequestPublication = tryValidatePrPublicationRequest;

function candidateMatches(candidate: PrPublicationRecord, request: NormalizedPrPublicationRequest): boolean {
  if (candidate.repository !== undefined && !sameRepository(candidate.repository, request.repository)) return false;
  if (candidate.head !== request.expectedHead || candidate.base !== request.expectedBase) return false;
  if (candidate.headRevision !== request.headRevision) return false;
  const identity = candidateIdentity(candidate, request.repository);
  return identity !== undefined && workIdentityKey(identity) === workIdentityKey(request.workIdentity);
}

function candidateConflicts(candidate: PrPublicationRecord, request: NormalizedPrPublicationRequest): boolean {
  if (candidate.repository !== undefined && !sameRepository(candidate.repository, request.repository)) return true;
  if (candidate.head !== request.expectedHead || candidate.base !== request.expectedBase) return false;
  if (candidate.headRevision !== request.headRevision) return true;
  const identity = candidateIdentity(candidate, request.repository);
  return identity === undefined || workIdentityKey(identity) !== workIdentityKey(request.workIdentity);
}

function matchingResult(
  records: readonly PrPublicationRecord[],
  request: NormalizedPrPublicationRequest,
  routing: IntegrationRoutingProjection,
): PrPublicationResult | undefined {
  const exact = records.filter((candidate) => candidateMatches(candidate, request));
  const conflicts = records.filter((candidate) => candidateConflicts(candidate, request));
  if (exact.length > 1)
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
  routing: IntegrationRoutingProjection,
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
