/**
 * Bounded, read-only Endpoint repository/work composition.
 *
 * This module is deliberately an adapter between existing Core projections.
 * It does not derive Issue lifecycle, Implementation readiness, Change state,
 * PR state, or authorization. Those values are retained from their owning
 * authorities and are only joined by the stable repository/Issue identity.
 */

import { ENDPOINT_RECONCILIATION_VERSION, type EndpointObservationRecord } from "./endpoint-reconciliation.js";
import { issueReferenceKey, normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";
import { validateChangeProjectionResult, type ChangeProjectionResult } from "./change.js";
import type {
  ImplementationFrontierCandidateProjection,
  ImplementationFrontierProjection,
  ImplementationFrontierResult,
} from "./implementation-frontier.js";
import type {
  SemanticIssueLifecycleIssueProjection,
  SemanticIssueLifecycleProjection,
  SemanticIssueLifecycleResult,
} from "./semantic-issue-lifecycle.js";
import type { OperationalIssueObservation, OperationalPullRequestObservation } from "./operational-observation.js";
import type { ObservedPullRequestProjection } from "./semantic-pr-observation.js";
import type { DesiredPullRequestProjection } from "./semantic-pr-projection.js";

export const ENDPOINT_WORK_PROJECTION_VERSION = 1 as const;
export type EndpointWorkProjectionVersion = typeof ENDPOINT_WORK_PROJECTION_VERSION;
export const ENDPOINT_WORK_PROJECTION_KIND = "endpoint-work" as const;

/** Evidence state is intentionally different from the empty collection state. */
export const ENDPOINT_WORK_EVIDENCE_STATES = Object.freeze([
  "present",
  "empty",
  "missing",
  "unavailable",
  "conflicting",
] as const);
export type EndpointWorkEvidenceState = (typeof ENDPOINT_WORK_EVIDENCE_STATES)[number];

export const ENDPOINT_WORK_PROJECTION_LIMITS = Object.freeze({
  diagnostics: 100,
  workItems: 1_000,
  semanticPullRequests: 1_000,
  operationalIssues: 1_000,
  operationalPullRequests: 1_000,
  changes: 1_000,
} as const);

/** Repository identity is the same host + immutable id tuple used by IssueReference. */
export interface EndpointWorkRepositoryIdentity {
  readonly repositoryHost: string;
  readonly repositoryId: string;
  readonly repository?: string;
  /** Retained when supplied by the Endpoint authorization context. */
  readonly endpointId?: string;
  readonly installationId?: string;
}

export type EndpointWorkFreshness = EndpointObservationRecord<unknown>;
export type EndpointWorkSemanticPullRequest = ObservedPullRequestProjection | DesiredPullRequestProjection;

export interface EndpointWorkEvidence {
  readonly status: EndpointWorkEvidenceState;
  readonly diagnostics: readonly EndpointWorkProjectionDiagnostic[];
}

export interface EndpointWorkProjectionDiagnostic {
  readonly code: EndpointWorkProjectionDiagnosticCode;
  readonly path: string;
  readonly message: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export type EndpointWorkProjectionDiagnosticCode =
  | "ENDPOINT_WORK_PROJECTION_INVALID_INPUT"
  | "ENDPOINT_WORK_PROJECTION_MISSING_PROPERTY"
  | "ENDPOINT_WORK_PROJECTION_INVALID_REPOSITORY"
  | "ENDPOINT_WORK_PROJECTION_INVALID_FRESHNESS"
  | "ENDPOINT_WORK_PROJECTION_INVALID_FRONTIER"
  | "ENDPOINT_WORK_PROJECTION_INVALID_LIFECYCLE"
  | "ENDPOINT_WORK_PROJECTION_INVALID_OPERATIONAL_EVIDENCE"
  | "ENDPOINT_WORK_PROJECTION_INVALID_CHANGE"
  | "ENDPOINT_WORK_PROJECTION_REPOSITORY_CONFLICT"
  | "ENDPOINT_WORK_PROJECTION_REFERENCE_CONFLICT"
  | "ENDPOINT_WORK_PROJECTION_DUPLICATE_EVIDENCE"
  | "ENDPOINT_WORK_PROJECTION_UNMATCHED_EVIDENCE";

/** Input evidence may be a concrete collection or an explicit unavailable read. */
export type EndpointWorkEvidenceInput<T> =
  | readonly T[]
  | {
      readonly status: "available" | "empty" | "unavailable" | "conflicting";
      readonly items?: readonly T[];
      readonly diagnostics?: readonly EndpointWorkProjectionDiagnostic[];
    };

export interface EndpointWorkChangeEvidence {
  readonly reference?: IssueReference;
  readonly projection: ChangeProjectionResult;
  readonly freshness?: EndpointWorkFreshness;
}

export interface EndpointWorkProjectionInput {
  /** Runtime validation accepts the existing Endpoint, GitHub, and Issue identity shapes. */
  readonly repository: unknown;
  readonly freshness: EndpointWorkFreshness;
  readonly frontier: ImplementationFrontierProjection | ImplementationFrontierResult;
  readonly lifecycle?: SemanticIssueLifecycleProjection | SemanticIssueLifecycleResult;
  /** Alias retained for adapters that name the authority explicitly. */
  readonly semanticIssueLifecycle?: SemanticIssueLifecycleProjection | SemanticIssueLifecycleResult;
  readonly semanticPullRequests?: EndpointWorkEvidenceInput<EndpointWorkSemanticPullRequest>;
  readonly operationalIssues?: EndpointWorkEvidenceInput<OperationalIssueObservation>;
  /** Compatibility spelling for callers that already use the short name. */
  readonly issues?: EndpointWorkEvidenceInput<OperationalIssueObservation>;
  readonly operationalPullRequests?: EndpointWorkEvidenceInput<OperationalPullRequestObservation>;
  /** Compatibility spelling for callers that already use the short name. */
  readonly pullRequests?: EndpointWorkEvidenceInput<OperationalPullRequestObservation>;
  readonly changes?: EndpointWorkEvidenceInput<EndpointWorkChangeEvidence | ChangeProjectionResult>;
  readonly changeProjections?: EndpointWorkEvidenceInput<EndpointWorkChangeEvidence | ChangeProjectionResult>;
}

export interface EndpointWorkItemEvidence {
  readonly lifecycle: EndpointWorkEvidence;
  readonly semanticPullRequest: EndpointWorkEvidence;
  readonly operationalIssue: EndpointWorkEvidence;
  readonly operationalPullRequest: EndpointWorkEvidence;
  readonly change: EndpointWorkEvidence;
}

export interface EndpointWorkItem {
  readonly reference: IssueReference;
  /** The complete readiness/dependency authority, retained without reinterpretation. */
  readonly frontier: ImplementationFrontierCandidateProjection;
  readonly readiness: ImplementationFrontierCandidateProjection;
  readonly freshness: EndpointWorkFreshness;
  readonly evidence: EndpointWorkItemEvidence;
  readonly lifecycle?: SemanticIssueLifecycleIssueProjection;
  readonly semanticPullRequest?: EndpointWorkSemanticPullRequest;
  readonly operationalIssue?: OperationalIssueObservation;
  readonly operationalPullRequest?: OperationalPullRequestObservation;
  readonly change?: ChangeProjectionResult;
}

export interface EndpointWorkProjection {
  readonly version: EndpointWorkProjectionVersion;
  readonly kind: typeof ENDPOINT_WORK_PROJECTION_KIND;
  readonly repository: EndpointWorkRepositoryIdentity;
  readonly freshness: EndpointWorkFreshness;
  /** Existing authorities are exposed for consumers that need their details. */
  readonly frontier: ImplementationFrontierProjection;
  readonly lifecycle?: SemanticIssueLifecycleProjection;
  readonly evidence: {
    readonly frontier: EndpointWorkEvidence;
    readonly lifecycle: EndpointWorkEvidence;
    readonly semanticPullRequests: EndpointWorkEvidence;
    readonly operationalIssues: EndpointWorkEvidence;
    readonly operationalPullRequests: EndpointWorkEvidence;
    readonly changes: EndpointWorkEvidence;
  };
  readonly work: {
    readonly status: EndpointWorkEvidenceState;
    readonly items: readonly EndpointWorkItem[];
    /** These are copied from Implementation Frontier, not recomputed here. */
    readonly ready: readonly IssueReference[];
    readonly parallelReadyGroups: ImplementationFrontierProjection["parallelReadyGroups"];
  };
  /** Convenience alias for clients that consume the bounded item collection directly. */
  readonly items: readonly EndpointWorkItem[];
  readonly diagnostics: readonly EndpointWorkProjectionDiagnostic[];
}

export interface EndpointWorkProjectionResult {
  readonly valid: boolean;
  readonly projection?: EndpointWorkProjection;
  readonly diagnostics: readonly EndpointWorkProjectionDiagnostic[];
}

export class EndpointWorkProjectionError extends Error {
  readonly diagnostics: readonly EndpointWorkProjectionDiagnostic[];

  constructor(diagnostics: readonly EndpointWorkProjectionDiagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n"));
    this.name = "EndpointWorkProjectionError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

type RecordValue = Record<string, unknown>;
type EvidenceCollection<T> = {
  readonly state: EndpointWorkEvidenceState;
  readonly items: readonly T[];
  readonly diagnostics: readonly EndpointWorkProjectionDiagnostic[];
};

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function diagnostic(
  code: EndpointWorkProjectionDiagnosticCode,
  path: string,
  message: string,
  expected?: unknown,
  actual?: unknown,
): EndpointWorkProjectionDiagnostic {
  return {
    code,
    path,
    message,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  };
}

function addDiagnostic(diagnostics: EndpointWorkProjectionDiagnostic[], entry: EndpointWorkProjectionDiagnostic): void {
  if (diagnostics.length < ENDPOINT_WORK_PROJECTION_LIMITS.diagnostics) diagnostics.push(entry);
}

function repositoryIdentity(
  value: unknown,
  path: string,
  diagnostics: EndpointWorkProjectionDiagnostic[],
): EndpointWorkRepositoryIdentity | undefined {
  if (!isRecord(value)) {
    addDiagnostic(
      diagnostics,
      diagnostic("ENDPOINT_WORK_PROJECTION_INVALID_REPOSITORY", path, "Repository identity must be an object."),
    );
    return undefined;
  }
  const repositoryHost =
    typeof value.repositoryHost === "string"
      ? value.repositoryHost
      : typeof value.host === "string"
        ? value.host
        : undefined;
  const repositoryId = typeof value.repositoryId === "string" ? value.repositoryId : undefined;
  const repository =
    typeof value.repository === "string"
      ? value.repository
      : typeof value.nameWithOwner === "string"
        ? value.nameWithOwner
        : undefined;
  if (
    repositoryHost === undefined ||
    repositoryHost.length === 0 ||
    repositoryId === undefined ||
    repositoryId.length === 0
  ) {
    addDiagnostic(
      diagnostics,
      diagnostic(
        "ENDPOINT_WORK_PROJECTION_INVALID_REPOSITORY",
        path,
        "Repository host and immutable repository id are required.",
      ),
    );
    return undefined;
  }
  return Object.freeze({
    repositoryHost: repositoryHost.toLocaleLowerCase("en-US"),
    repositoryId,
    ...(repository === undefined ? {} : { repository: repository.toLocaleLowerCase("en-US") }),
    ...(typeof value.endpointId === "string" ? { endpointId: value.endpointId } : {}),
    ...(typeof value.installationId === "string" ? { installationId: value.installationId } : {}),
  });
}

function sameRepository(left: IssueReference, right: EndpointWorkRepositoryIdentity): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

function operationalRepositoryMatches(
  value: OperationalIssueObservation | OperationalPullRequestObservation,
  repository: EndpointWorkRepositoryIdentity,
): boolean {
  return (
    value.repository.host.toLocaleLowerCase("en-US") === repository.repositoryHost &&
    value.repository.repositoryId === repository.repositoryId
  );
}

function validFreshness(value: unknown): value is EndpointWorkFreshness {
  if (!isRecord(value)) return false;
  return (
    value.version === ENDPOINT_RECONCILIATION_VERSION &&
    typeof value.key === "string" &&
    (value.state === "fresh" ||
      value.state === "stale" ||
      value.state === "unavailable" ||
      value.state === "reconciling") &&
    Array.isArray(value.pendingHints) &&
    Array.isArray(value.seenHintIds) &&
    Array.isArray(value.diagnostics) &&
    (value.authoritative === null || isRecord(value.authoritative))
  );
}

function evidenceCollection<T>(value: unknown, path: string): EvidenceCollection<T> {
  if (value === undefined) return { state: "missing", items: [], diagnostics: [] };
  if (Array.isArray(value)) {
    return { state: value.length === 0 ? "empty" : "present", items: value as T[], diagnostics: [] };
  }
  if (!isRecord(value)) {
    const entry = diagnostic(
      "ENDPOINT_WORK_PROJECTION_INVALID_OPERATIONAL_EVIDENCE",
      path,
      "Evidence must be an array or an explicit evidence record.",
    );
    return { state: "conflicting", items: [], diagnostics: [entry] };
  }
  const status = value.status;
  const allowed = status === "available" || status === "empty" || status === "unavailable" || status === "conflicting";
  if (!allowed) {
    const entry = diagnostic(
      "ENDPOINT_WORK_PROJECTION_INVALID_OPERATIONAL_EVIDENCE",
      `${path}.status`,
      "Evidence status is not recognized.",
    );
    return { state: "conflicting", items: [], diagnostics: [entry] };
  }
  const items = value.items === undefined ? [] : Array.isArray(value.items) ? (value.items as T[]) : undefined;
  if (items === undefined) {
    const entry = diagnostic(
      "ENDPOINT_WORK_PROJECTION_INVALID_OPERATIONAL_EVIDENCE",
      `${path}.items`,
      "Evidence items must be an array.",
    );
    return { state: "conflicting", items: [], diagnostics: [entry] };
  }
  const state: EndpointWorkEvidenceState = status === "available" ? (items.length === 0 ? "empty" : "present") : status;
  const supplied = Array.isArray(value.diagnostics) ? value.diagnostics : [];
  return { state, items, diagnostics: supplied };
}

function unwrapFrontier(value: unknown): { projection?: ImplementationFrontierProjection; valid: boolean } {
  if (!isRecord(value)) return { valid: false };
  if (isRecord(value.projection)) {
    return { projection: value.projection as unknown as ImplementationFrontierProjection, valid: value.valid === true };
  }
  if (value.kind === "implementation-frontier" && Array.isArray(value.candidates)) {
    return { projection: value as unknown as ImplementationFrontierProjection, valid: value.valid === true };
  }
  return { valid: false };
}

function unwrapLifecycle(value: unknown): { projection?: SemanticIssueLifecycleProjection; valid: boolean } {
  if (!isRecord(value)) return { valid: false };
  if (isRecord(value.projection)) {
    return { projection: value.projection as unknown as SemanticIssueLifecycleProjection, valid: value.valid === true };
  }
  if (value.kind === "issue-lifecycle" && Array.isArray(value.issues)) {
    return { projection: value as unknown as SemanticIssueLifecycleProjection, valid: true };
  }
  return { valid: false };
}

function statusForChange(projection: ChangeProjectionResult | undefined): EndpointWorkEvidenceState {
  if (projection === undefined) return "conflicting";
  if (projection.status === "absent") return "empty";
  if (projection.status === "unavailable") return "unavailable";
  if (projection.status === "duplicate" || projection.status === "ambiguous" || projection.status === "wrong-base")
    return "conflicting";
  return "present";
}

interface NormalizedChange {
  readonly reference?: IssueReference;
  readonly projection?: ChangeProjectionResult;
  readonly freshness?: EndpointWorkFreshness;
  readonly diagnostics: readonly EndpointWorkProjectionDiagnostic[];
}

function normalizeChange(value: unknown, path: string): NormalizedChange {
  const diagnostics: EndpointWorkProjectionDiagnostic[] = [];
  let candidate: unknown = value;
  let explicitReference: unknown;
  let freshness: EndpointWorkFreshness | undefined;
  if (isRecord(value) && hasOwn(value, "projection")) {
    candidate = value.projection;
    explicitReference = value.reference;
    if (value.freshness !== undefined) {
      if (validFreshness(value.freshness)) freshness = value.freshness;
      else
        addDiagnostic(
          diagnostics,
          diagnostic("ENDPOINT_WORK_PROJECTION_INVALID_FRESHNESS", `${path}.freshness`, "Change freshness is invalid."),
        );
    }
  }
  const validation = validateChangeProjectionResult(candidate);
  if (!validation.valid || validation.projection === undefined) {
    addDiagnostic(
      diagnostics,
      diagnostic(
        "ENDPOINT_WORK_PROJECTION_INVALID_CHANGE",
        path,
        "Change evidence is not a valid existing Change projection.",
      ),
    );
    return { diagnostics };
  }
  let reference: IssueReference | undefined;
  const rawReference = explicitReference ?? validation.projection.change?.identity;
  if (rawReference !== undefined) {
    const normalized = normalizeIssueReference(
      isRecord(rawReference) && hasOwn(rawReference, "rootIssue")
        ? {
            repositoryHost: rawReference.repositoryHost,
            repositoryId: rawReference.repositoryId,
            ...(rawReference.repository === undefined ? {} : { repository: rawReference.repository }),
            number: rawReference.rootIssue,
          }
        : rawReference,
      `${path}.reference`,
    );
    if (normalized.valid) reference = normalized.reference;
    else
      addDiagnostic(
        diagnostics,
        diagnostic(
          "ENDPOINT_WORK_PROJECTION_INVALID_CHANGE",
          `${path}.reference`,
          "Change identity does not identify a valid Issue.",
        ),
      );
  }
  return {
    reference,
    projection: validation.projection,
    ...(freshness === undefined ? {} : { freshness }),
    diagnostics,
  };
}

function evidence(
  status: EndpointWorkEvidenceState,
  diagnostics: readonly EndpointWorkProjectionDiagnostic[] = [],
): EndpointWorkEvidence {
  return Object.freeze({ status, diagnostics: Object.freeze([...diagnostics]) });
}

/** Compose the Endpoint repository/work read projection from existing authorities. */
export function tryProjectEndpointWork(input: unknown): EndpointWorkProjectionResult {
  const diagnostics: EndpointWorkProjectionDiagnostic[] = [];
  if (!isRecord(input)) {
    const entry = diagnostic(
      "ENDPOINT_WORK_PROJECTION_INVALID_INPUT",
      "$",
      "Endpoint work projection input must be an object.",
    );
    return { valid: false, diagnostics: [entry] };
  }
  const repository = repositoryIdentity(input.repository, "$.repository", diagnostics);
  if (repository === undefined) return { valid: false, diagnostics: Object.freeze([...diagnostics]) };
  if (!validFreshness(input.freshness)) {
    addDiagnostic(
      diagnostics,
      diagnostic(
        "ENDPOINT_WORK_PROJECTION_INVALID_FRESHNESS",
        "$.freshness",
        "Endpoint reconciliation freshness must be an existing observation record.",
      ),
    );
    return { valid: false, diagnostics: Object.freeze([...diagnostics]) };
  }
  const frontierResult = unwrapFrontier(input.frontier);
  if (frontierResult.projection === undefined) {
    addDiagnostic(
      diagnostics,
      diagnostic(
        "ENDPOINT_WORK_PROJECTION_INVALID_FRONTIER",
        "$.frontier",
        "Implementation Frontier evidence is required.",
      ),
    );
    return { valid: false, diagnostics: Object.freeze([...diagnostics]) };
  }
  const frontier = frontierResult.projection;
  const frontierDiagnostics: EndpointWorkProjectionDiagnostic[] = [];
  if (frontier.valid !== true || frontierResult.valid !== true) {
    addDiagnostic(
      frontierDiagnostics,
      diagnostic(
        "ENDPOINT_WORK_PROJECTION_INVALID_FRONTIER",
        "$.frontier",
        "Implementation Frontier evidence is invalid.",
      ),
    );
  }

  const lifecycleInput = input.lifecycle ?? input.semanticIssueLifecycle;
  const lifecycleCollection =
    lifecycleInput === undefined
      ? { state: "missing" as const, projection: undefined, diagnostics: [] as EndpointWorkProjectionDiagnostic[] }
      : (() => {
          const result = unwrapLifecycle(lifecycleInput);
          if (result.projection === undefined) {
            return {
              state: "conflicting" as const,
              projection: undefined,
              diagnostics: [
                diagnostic(
                  "ENDPOINT_WORK_PROJECTION_INVALID_LIFECYCLE",
                  "$.lifecycle",
                  "Semantic Issue lifecycle evidence is invalid.",
                ),
              ],
            };
          }
          return {
            state:
              result.projection.issues.length === 0
                ? ("empty" as const)
                : result.valid
                  ? ("present" as const)
                  : ("conflicting" as const),
            projection: result.projection,
            diagnostics: result.valid
              ? []
              : [
                  diagnostic(
                    "ENDPOINT_WORK_PROJECTION_INVALID_LIFECYCLE",
                    "$.lifecycle",
                    "Semantic Issue lifecycle evidence is invalid.",
                  ),
                ],
          };
        })();
  const lifecycle = lifecycleCollection.projection;

  const semanticPullRequests = evidenceCollection<EndpointWorkSemanticPullRequest>(
    input.semanticPullRequests,
    "$.semanticPullRequests",
  );
  const operationalIssues = evidenceCollection<OperationalIssueObservation>(
    input.operationalIssues ?? input.issues,
    "$.operationalIssues",
  );
  const operationalPullRequests = evidenceCollection<OperationalPullRequestObservation>(
    input.operationalPullRequests ?? input.pullRequests,
    "$.operationalPullRequests",
  );
  const rawChanges = input.changes ?? input.changeProjections;
  const changesInput = evidenceCollection<EndpointWorkChangeEvidence | ChangeProjectionResult>(rawChanges, "$.changes");
  const normalizedChanges: NormalizedChange[] = changesInput.items.map((value, index) =>
    normalizeChange(value, `$.changes[${index}]`),
  );
  const changeDiagnostics = normalizedChanges.flatMap((entry) => entry.diagnostics);

  const lifecycleByKey = new Map<string, SemanticIssueLifecycleIssueProjection>();
  if (lifecycle !== undefined) {
    for (const [index, issue] of lifecycle.issues.entries()) {
      const normalized = normalizeIssueReference(issue.reference, `$.lifecycle.issues[${index}].reference`);
      if (!normalized.valid || normalized.reference === undefined) {
        addDiagnostic(
          diagnostics,
          diagnostic(
            "ENDPOINT_WORK_PROJECTION_REFERENCE_CONFLICT",
            `$.lifecycle.issues[${index}].reference`,
            "Lifecycle Issue identity is invalid.",
          ),
        );
      } else if (!sameRepository(normalized.reference, repository)) {
        addDiagnostic(
          diagnostics,
          diagnostic(
            "ENDPOINT_WORK_PROJECTION_REPOSITORY_CONFLICT",
            `$.lifecycle.issues[${index}].reference`,
            "Lifecycle Issue belongs to a different repository.",
          ),
        );
      } else {
        lifecycleByKey.set(issueReferenceKey(normalized.reference), issue);
      }
    }
  }

  const semanticPrByKey = new Map<string, EndpointWorkSemanticPullRequest[]>();
  for (const [index, pullRequest] of semanticPullRequests.items.entries()) {
    const references = pullRequest.relations?.implements?.references;
    if (!Array.isArray(references)) {
      addDiagnostic(
        diagnostics,
        diagnostic(
          "ENDPOINT_WORK_PROJECTION_INVALID_OPERATIONAL_EVIDENCE",
          `$.semanticPullRequests[${index}]`,
          "Semantic PR relation evidence is unavailable.",
        ),
      );
      continue;
    }
    for (const reference of references) {
      const normalized = normalizeIssueReference(
        reference,
        `$.semanticPullRequests[${index}].relations.implements.references`,
      );
      if (!normalized.valid || normalized.reference === undefined) {
        addDiagnostic(
          diagnostics,
          diagnostic(
            "ENDPOINT_WORK_PROJECTION_REFERENCE_CONFLICT",
            `$.semanticPullRequests[${index}]`,
            "Semantic PR relation identifies an invalid Issue.",
          ),
        );
      } else if (!sameRepository(normalized.reference, repository)) {
        addDiagnostic(
          diagnostics,
          diagnostic(
            "ENDPOINT_WORK_PROJECTION_REPOSITORY_CONFLICT",
            `$.semanticPullRequests[${index}]`,
            "Semantic PR relation belongs to a different repository.",
          ),
        );
      } else {
        const existing = semanticPrByKey.get(issueReferenceKey(normalized.reference)) ?? [];
        existing.push(pullRequest);
        semanticPrByKey.set(issueReferenceKey(normalized.reference), existing);
      }
    }
  }

  const issueByNumber = new Map<number, OperationalIssueObservation>();
  const duplicateIssueNumbers = new Set<number>();
  for (const issue of operationalIssues.items) {
    if (!operationalRepositoryMatches(issue, repository)) {
      addDiagnostic(
        diagnostics,
        diagnostic(
          "ENDPOINT_WORK_PROJECTION_REPOSITORY_CONFLICT",
          "$.operationalIssues",
          "Operational Issue belongs to a different repository.",
        ),
      );
      continue;
    }
    if (issueByNumber.has(issue.number)) duplicateIssueNumbers.add(issue.number);
    else issueByNumber.set(issue.number, issue);
  }
  const pullRequestByNumber = new Map<number, OperationalPullRequestObservation>();
  const duplicatePullRequestNumbers = new Set<number>();
  for (const pullRequest of operationalPullRequests.items) {
    if (!operationalRepositoryMatches(pullRequest, repository)) {
      addDiagnostic(
        diagnostics,
        diagnostic(
          "ENDPOINT_WORK_PROJECTION_REPOSITORY_CONFLICT",
          "$.operationalPullRequests",
          "Operational PR belongs to a different repository.",
        ),
      );
      continue;
    }
    if (pullRequestByNumber.has(pullRequest.number)) duplicatePullRequestNumbers.add(pullRequest.number);
    else pullRequestByNumber.set(pullRequest.number, pullRequest);
  }
  for (const number of duplicateIssueNumbers)
    addDiagnostic(
      diagnostics,
      diagnostic(
        "ENDPOINT_WORK_PROJECTION_DUPLICATE_EVIDENCE",
        "$.operationalIssues",
        `More than one operational Issue observation claims number ${number}.`,
      ),
    );
  for (const number of duplicatePullRequestNumbers)
    addDiagnostic(
      diagnostics,
      diagnostic(
        "ENDPOINT_WORK_PROJECTION_DUPLICATE_EVIDENCE",
        "$.operationalPullRequests",
        `More than one operational PR observation claims number ${number}.`,
      ),
    );

  const changeByKey = new Map<string, NormalizedChange>();
  const duplicateChanges = new Set<string>();
  for (const change of normalizedChanges) {
    if (change.reference === undefined) continue;
    if (!sameRepository(change.reference, repository)) {
      addDiagnostic(
        diagnostics,
        diagnostic(
          "ENDPOINT_WORK_PROJECTION_REPOSITORY_CONFLICT",
          "$.changes",
          "Change belongs to a different repository.",
        ),
      );
      continue;
    }
    const key = issueReferenceKey(change.reference);
    if (changeByKey.has(key)) duplicateChanges.add(key);
    else changeByKey.set(key, change);
  }
  for (const key of duplicateChanges)
    addDiagnostic(
      diagnostics,
      diagnostic(
        "ENDPOINT_WORK_PROJECTION_DUPLICATE_EVIDENCE",
        "$.changes",
        `More than one Change projection claims ${key}.`,
      ),
    );

  const items: EndpointWorkItem[] = [];
  for (const [index, candidate] of frontier.candidates.slice(0, ENDPOINT_WORK_PROJECTION_LIMITS.workItems).entries()) {
    const normalizedReference = normalizeIssueReference(
      candidate.reference,
      `$.frontier.candidates[${index}].reference`,
    );
    if (!normalizedReference.valid || normalizedReference.reference === undefined) {
      addDiagnostic(
        diagnostics,
        diagnostic(
          "ENDPOINT_WORK_PROJECTION_REFERENCE_CONFLICT",
          `$.frontier.candidates[${index}].reference`,
          "Frontier candidate identity is invalid.",
        ),
      );
      continue;
    }
    const reference = normalizedReference.reference;
    const key = issueReferenceKey(reference);
    if (!sameRepository(reference, repository)) {
      addDiagnostic(
        diagnostics,
        diagnostic(
          "ENDPOINT_WORK_PROJECTION_REPOSITORY_CONFLICT",
          `$.frontier.candidates[${index}].reference`,
          "Frontier candidate belongs to a different repository.",
        ),
      );
      continue;
    }
    const lifecycleIssue = lifecycleByKey.get(key);
    const semanticPullRequestList = semanticPrByKey.get(key) ?? [];
    const operationalIssue = issueByNumber.get(reference.number);
    const change = changeByKey.get(key);
    const semanticPullRequestNumber =
      semanticPullRequestList.length === 1 &&
      "number" in semanticPullRequestList[0] &&
      typeof semanticPullRequestList[0].number === "number"
        ? semanticPullRequestList[0].number
        : undefined;
    const pullRequestNumber = change?.projection?.change?.projection?.pullRequest ?? semanticPullRequestNumber;
    const operationalPullRequest =
      pullRequestNumber === undefined ? undefined : pullRequestByNumber.get(pullRequestNumber);
    const itemDiagnostics: EndpointWorkProjectionDiagnostic[] = [];
    if (lifecycle !== undefined && lifecycleIssue === undefined && lifecycle.scope === "complete")
      addDiagnostic(
        itemDiagnostics,
        diagnostic(
          "ENDPOINT_WORK_PROJECTION_UNMATCHED_EVIDENCE",
          `$.work[${index}].lifecycle`,
          "Complete lifecycle evidence does not contain this frontier candidate.",
        ),
      );
    if (semanticPullRequestList.length > 1)
      addDiagnostic(
        itemDiagnostics,
        diagnostic(
          "ENDPOINT_WORK_PROJECTION_DUPLICATE_EVIDENCE",
          `$.work[${index}].semanticPullRequest`,
          "More than one semantic PR claims this Issue.",
        ),
      );
    if (duplicateIssueNumbers.has(reference.number))
      addDiagnostic(
        itemDiagnostics,
        diagnostic(
          "ENDPOINT_WORK_PROJECTION_DUPLICATE_EVIDENCE",
          `$.work[${index}].operationalIssue`,
          "More than one operational Issue observation claims this number.",
        ),
      );
    if (pullRequestNumber !== undefined && duplicatePullRequestNumbers.has(pullRequestNumber))
      addDiagnostic(
        itemDiagnostics,
        diagnostic(
          "ENDPOINT_WORK_PROJECTION_DUPLICATE_EVIDENCE",
          `$.work[${index}].operationalPullRequest`,
          "More than one operational PR observation claims this number.",
        ),
      );
    if (duplicateChanges.has(key))
      addDiagnostic(
        itemDiagnostics,
        diagnostic(
          "ENDPOINT_WORK_PROJECTION_DUPLICATE_EVIDENCE",
          `$.work[${index}].change`,
          "More than one Change projection claims this Issue.",
        ),
      );
    const itemEvidence: EndpointWorkItemEvidence = {
      lifecycle: evidence(
        lifecycleCollection.state === "missing"
          ? "missing"
          : lifecycleIssue === undefined
            ? lifecycleCollection.state === "present"
              ? "empty"
              : lifecycleCollection.state
            : "present",
        itemDiagnostics.filter((entry) => entry.path.endsWith(".lifecycle")),
      ),
      semanticPullRequest: evidence(
        semanticPullRequests.state === "missing"
          ? "missing"
          : semanticPullRequestList.length === 0
            ? semanticPullRequests.state === "present"
              ? "empty"
              : semanticPullRequests.state
            : semanticPullRequests.state,
        itemDiagnostics.filter((entry) => entry.path.endsWith(".semanticPullRequest")),
      ),
      operationalIssue: evidence(
        duplicateIssueNumbers.has(reference.number)
          ? "conflicting"
          : operationalIssues.state === "missing"
            ? "missing"
            : operationalIssue === undefined
              ? operationalIssues.state === "present"
                ? "empty"
                : operationalIssues.state
              : operationalIssues.state,
        itemDiagnostics.filter((entry) => entry.path.endsWith(".operationalIssue")),
      ),
      operationalPullRequest: evidence(
        duplicatePullRequestNumbers.size > 0
          ? "conflicting"
          : operationalPullRequests.state === "missing"
            ? "missing"
            : pullRequestNumber === undefined
              ? operationalPullRequests.state === "present" || operationalPullRequests.state === "empty"
                ? "empty"
                : operationalPullRequests.state
              : operationalPullRequest === undefined
                ? operationalPullRequests.state === "present"
                  ? "empty"
                  : operationalPullRequests.state
                : operationalPullRequests.state,
        itemDiagnostics.filter((entry) => entry.path.endsWith(".operationalPullRequest")),
      ),
      change: evidence(
        change === undefined
          ? changesInput.state === "missing"
            ? "missing"
            : changesInput.state === "present"
              ? "empty"
              : changesInput.state
          : duplicateChanges.has(key)
            ? "conflicting"
            : statusForChange(change.projection),
        changeDiagnostics,
      ),
    };
    if (itemDiagnostics.length > 0) diagnostics.push(...itemDiagnostics);
    items.push(
      Object.freeze({
        reference,
        frontier: candidate,
        readiness: candidate,
        freshness: input.freshness,
        evidence: itemEvidence,
        ...(lifecycleIssue === undefined ? {} : { lifecycle: lifecycleIssue }),
        ...(semanticPullRequestList[0] === undefined ? {} : { semanticPullRequest: semanticPullRequestList[0] }),
        ...(operationalIssue === undefined ? {} : { operationalIssue }),
        ...(operationalPullRequest === undefined ? {} : { operationalPullRequest }),
        ...(change?.projection === undefined ? {} : { change: change.projection }),
      }),
    );
  }

  const valid =
    diagnostics.length === 0 &&
    frontierDiagnostics.length === 0 &&
    lifecycleCollection.diagnostics.length === 0 &&
    semanticPullRequests.diagnostics.length === 0 &&
    operationalIssues.diagnostics.length === 0 &&
    operationalPullRequests.diagnostics.length === 0 &&
    changesInput.diagnostics.length === 0 &&
    changeDiagnostics.length === 0;
  const evidenceSummary = {
    frontier: evidence(
      frontierDiagnostics.length === 0 ? (frontier.candidates.length === 0 ? "empty" : "present") : "conflicting",
      frontierDiagnostics,
    ),
    lifecycle: evidence(lifecycleCollection.state, lifecycleCollection.diagnostics),
    semanticPullRequests: evidence(semanticPullRequests.state, semanticPullRequests.diagnostics),
    operationalIssues: evidence(
      duplicateIssueNumbers.size > 0 ? "conflicting" : operationalIssues.state,
      operationalIssues.diagnostics,
    ),
    operationalPullRequests: evidence(
      duplicatePullRequestNumbers.size > 0 ? "conflicting" : operationalPullRequests.state,
      operationalPullRequests.diagnostics,
    ),
    changes: evidence(
      duplicateChanges.size > 0 || (changesInput.state === "present" && changeDiagnostics.length > 0)
        ? "conflicting"
        : changesInput.state,
      [...changesInput.diagnostics, ...changeDiagnostics],
    ),
  };
  const workStatus: EndpointWorkEvidenceState =
    frontierDiagnostics.length > 0 ? "conflicting" : frontier.candidates.length === 0 ? "empty" : "present";
  const projection: EndpointWorkProjection = Object.freeze({
    version: ENDPOINT_WORK_PROJECTION_VERSION,
    kind: ENDPOINT_WORK_PROJECTION_KIND,
    repository,
    freshness: input.freshness,
    frontier,
    ...(lifecycle === undefined ? {} : { lifecycle }),
    evidence: Object.freeze(evidenceSummary),
    work: Object.freeze({
      status: workStatus,
      items: Object.freeze(items),
      ready: Object.freeze([...frontier.ready]),
      parallelReadyGroups: Object.freeze(
        frontier.parallelReadyGroups.map((group) => Object.freeze({ items: Object.freeze([...group.items]) })),
      ),
    }),
    items: Object.freeze(items),
    diagnostics: Object.freeze([
      ...diagnostics,
      ...frontierDiagnostics,
      ...lifecycleCollection.diagnostics,
      ...semanticPullRequests.diagnostics,
      ...operationalIssues.diagnostics,
      ...operationalPullRequests.diagnostics,
      ...changesInput.diagnostics,
      ...changeDiagnostics,
    ]),
  });
  return { valid, projection, diagnostics: projection.diagnostics };
}

/** Throwing entry point for callers that require a coherent Endpoint projection. */
export function projectEndpointWork(input: unknown): EndpointWorkProjection {
  const result = tryProjectEndpointWork(input);
  if (!result.valid || result.projection === undefined) throw new EndpointWorkProjectionError(result.diagnostics);
  return result.projection;
}

export const tryProjectEndpointWorkProjection = tryProjectEndpointWork;
export const projectEndpointWorkProjection = projectEndpointWork;
export const composeEndpointWorkProjection = projectEndpointWork;
