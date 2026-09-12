/**
 * Pure implementation-handoff projection for an issued Change.
 *
 * The handoff is deliberately narrower than the Change projection it
 * consumes.  It gives a worker the canonical remote identity it needs to
 * establish its own local execution context; it never carries a worktree,
 * session, process, checkout, or other local-runtime fact.
 */

import {
  CHANGE_CONTRACT_VERSION,
  MAX_CHANGE_BASE_BRANCH_LENGTH,
  MAX_CHANGE_BRANCH_LENGTH,
  MAX_CHANGE_DIAGNOSTICS,
  createChangeDiagnostic,
  createChangeDiagnosticReport,
  validateChangeIdentity,
  validateChangeProjectionResult,
  type Change,
  type ChangeDiagnostic,
  type ChangeProjectionResult,
  type ChangeProjectionStatus,
} from "./change.js";

/** Independent version for the transport-neutral handoff envelope. */
export const IMPLEMENTATION_HANDOFF_CONTRACT_VERSION = 1 as const;
export type ImplementationHandoffContractVersion = typeof IMPLEMENTATION_HANDOFF_CONTRACT_VERSION;

/** Explicit discriminator for the worker-facing projection. */
export const IMPLEMENTATION_HANDOFF_KIND = "implementation-handoff" as const;

/**
 * The bounded identity needed by a worker runtime.
 *
 * `repositoryHost`, `repositoryId`, and `rootIssue` are copied from the
 * validated Change identity.  `changeVersion` and `state` describe the
 * existing Change contract; they do not create a second lifecycle.
 */
export interface ImplementationHandoff {
  readonly version: ImplementationHandoffContractVersion;
  readonly kind: typeof IMPLEMENTATION_HANDOFF_KIND;
  readonly repositoryHost: string;
  readonly repositoryId: string;
  /** `owner/name` locator, present whenever the caller resolved it alongside the stable repository ID. */
  readonly repositoryNameWithOwner?: string;
  readonly rootIssue: number;
  readonly changeVersion: typeof CHANGE_CONTRACT_VERSION;
  readonly state: "DRAFT";
  readonly branch: string;
  readonly baseBranch: string;
  readonly pullRequest: number;
}

/** Compatibility name for callers that name the projection by its Change. */
export type ChangeImplementationHandoff = ImplementationHandoff;

export interface ImplementationHandoffProjectionResult {
  readonly valid: boolean;
  readonly handoff?: ImplementationHandoff;
  readonly diagnostics: readonly ChangeDiagnostic[];
}

/** Compatibility name for callers that use the Change-prefixed result. */
export type ChangeImplementationHandoffResult = ImplementationHandoffProjectionResult;

export class ImplementationHandoffProjectionError extends Error {
  readonly diagnostics: readonly ChangeDiagnostic[];

  constructor(diagnostics: readonly ChangeDiagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n"));
    this.name = "ImplementationHandoffProjectionError";
    this.diagnostics = diagnostics;
  }
}

/** Compatibility name for callers that use the Change-prefixed error. */
export class ChangeImplementationHandoffError extends ImplementationHandoffProjectionError {
  constructor(diagnostics: readonly ChangeDiagnostic[]) {
    super(diagnostics);
    this.name = "ChangeImplementationHandoffError";
  }
}

const HANDOFF_KEYS = new Set([
  "version",
  "kind",
  "repositoryHost",
  "repositoryId",
  "repositoryNameWithOwner",
  "rootIssue",
  "changeVersion",
  "state",
  "branch",
  "baseBranch",
  "pullRequest",
]);

const NON_ADMISSIBLE_STATUS_CODES: Readonly<Partial<Record<ChangeProjectionStatus, ChangeDiagnostic["code"]>>> = {
  absent: "CHANGE_INVALID_PROJECTION",
  partial: "CHANGE_PROJECTION_PARTIAL",
  duplicate: "CHANGE_PROJECTION_DUPLICATE",
  "wrong-base": "CHANGE_PROJECTION_WRONG_BASE",
  ambiguous: "CHANGE_PROJECTION_AMBIGUOUS",
  unavailable: "CHANGE_PROJECTION_EVIDENCE_UNAVAILABLE",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareDiagnostics(left: ChangeDiagnostic, right: ChangeDiagnostic): number {
  return left.path.localeCompare(right.path, "en-US") || left.code.localeCompare(right.code, "en-US");
}

function boundedDiagnostics(diagnostics: readonly ChangeDiagnostic[]): readonly ChangeDiagnostic[] {
  const bounded = diagnostics.slice(0, MAX_CHANGE_DIAGNOSTICS);
  const report = createChangeDiagnosticReport(bounded);
  return Object.freeze([...report.diagnostics].sort(compareDiagnostics));
}

function diagnostic(code: ChangeDiagnostic["code"], path: string, message: string): ChangeDiagnostic {
  return createChangeDiagnostic({ code, path, message });
}

function invalid(diagnostics: readonly ChangeDiagnostic[]): ImplementationHandoffProjectionResult {
  return { valid: false, diagnostics: boundedDiagnostics(diagnostics) };
}

function statusDiagnostic(status: ChangeProjectionStatus): ChangeDiagnostic | undefined {
  const code = NON_ADMISSIBLE_STATUS_CODES[status];
  if (code === undefined) return undefined;
  return diagnostic(code, "$.status", `Change projection status "${status}" is not implementation-admissible.`);
}

const MAX_REPOSITORY_NAME_WITH_OWNER_LENGTH = 256;

function validNameWithOwner(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REPOSITORY_NAME_WITH_OWNER_LENGTH &&
    /^[^\s/]+\/[^\s/]+$/u.test(value)
  );
}

function validBranch(value: unknown, path: string): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= (path.endsWith("baseBranch") ? MAX_CHANGE_BASE_BRANCH_LENGTH : MAX_CHANGE_BRANCH_LENGTH) &&
    !/[\u0000-\u001F\u007F]/u.test(value)
  );
}

function validateHandoffShape(input: unknown): ImplementationHandoffProjectionResult {
  const diagnostics: ChangeDiagnostic[] = [];
  if (!isRecord(input))
    return invalid([diagnostic("CHANGE_INVALID_PLAN", "$", "Implementation handoff must be an object.")]);
  for (const key of Object.keys(input).sort()) {
    if (!HANDOFF_KEYS.has(key))
      diagnostics.push(diagnostic("CHANGE_UNKNOWN_PROPERTY", `$.${key}`, "Property is not supported."));
  }
  if (input.version !== IMPLEMENTATION_HANDOFF_CONTRACT_VERSION)
    diagnostics.push(
      diagnostic("CHANGE_UNSUPPORTED_VERSION", "$.version", "Implementation handoff version is unsupported."),
    );
  if (input.kind !== IMPLEMENTATION_HANDOFF_KIND)
    diagnostics.push(diagnostic("CHANGE_INVALID_PLAN", "$.kind", "Implementation handoff kind is invalid."));

  const identity = {
    repositoryHost: input.repositoryHost,
    repositoryId: input.repositoryId,
    rootIssue: input.rootIssue,
  };
  const identityResult = validateChangeIdentity(identity);
  if (input.changeVersion !== CHANGE_CONTRACT_VERSION)
    diagnostics.push(
      diagnostic("CHANGE_UNSUPPORTED_VERSION", "$.changeVersion", "Change contract version is unsupported."),
    );
  if (input.state !== "DRAFT")
    diagnostics.push(diagnostic("CHANGE_INVALID_STATE", "$.state", "Implementation handoff state must be DRAFT."));
  if (!validBranch(input.branch, "$.branch"))
    diagnostics.push(diagnostic("CHANGE_INVALID_PROJECTION", "$.branch", "Canonical branch identity is invalid."));
  if (!validBranch(input.baseBranch, "$.baseBranch"))
    diagnostics.push(
      diagnostic("CHANGE_INVALID_PROJECTION", "$.baseBranch", "Canonical base branch identity is invalid."),
    );
  if (!Number.isSafeInteger(input.pullRequest) || (input.pullRequest as number) < 1)
    diagnostics.push(
      diagnostic("CHANGE_INVALID_PROJECTION", "$.pullRequest", "pullRequest must be a positive safe integer."),
    );
  if (input.repositoryNameWithOwner !== undefined && !validNameWithOwner(input.repositoryNameWithOwner))
    diagnostics.push(
      diagnostic(
        "CHANGE_INVALID_PROJECTION",
        "$.repositoryNameWithOwner",
        "repositoryNameWithOwner must be an owner/name locator.",
      ),
    );
  if (!identityResult.valid) diagnostics.push(...identityResult.diagnostics);
  if (diagnostics.length > 0) return invalid(diagnostics);
  const normalizedIdentity = identityResult.identity;
  if (normalizedIdentity === undefined)
    return invalid([diagnostic("CHANGE_INVALID_IDENTITY", "$.identity", "A valid Change identity is required.")]);
  const handoff: ImplementationHandoff = {
    version: IMPLEMENTATION_HANDOFF_CONTRACT_VERSION,
    kind: IMPLEMENTATION_HANDOFF_KIND,
    repositoryHost: normalizedIdentity.repositoryHost,
    repositoryId: normalizedIdentity.repositoryId,
    ...(input.repositoryNameWithOwner === undefined
      ? {}
      : { repositoryNameWithOwner: input.repositoryNameWithOwner as string }),
    rootIssue: normalizedIdentity.rootIssue,
    changeVersion: CHANGE_CONTRACT_VERSION,
    state: "DRAFT",
    branch: input.branch as string,
    baseBranch: input.baseBranch as string,
    pullRequest: input.pullRequest as number,
  };
  return { valid: true, handoff: Object.freeze(handoff), diagnostics: [] };
}

/** Validate a serialized handoff at a transport/package boundary. */
export function validateImplementationHandoff(input: unknown): ImplementationHandoffProjectionResult {
  return validateHandoffShape(input);
}

/** Alias named after the Change-owned projection. */
export const validateChangeImplementationHandoff = validateImplementationHandoff;

function canonicalCandidateCount(
  projection: ChangeProjectionResult,
  branch: string,
  baseBranch: string,
  pullRequest: number,
): { readonly branches: number; readonly pullRequests: number } {
  return {
    branches: projection.candidates.branches.filter(
      (candidate) => candidate.classification === "canonical" && candidate.candidate.name === branch,
    ).length,
    pullRequests: projection.candidates.pullRequests.filter(
      (candidate) =>
        candidate.classification === "canonical" &&
        candidate.candidate.number === pullRequest &&
        candidate.candidate.head === branch &&
        candidate.candidate.base === baseBranch,
    ).length,
  };
}

export interface ImplementationHandoffProjectionOptions {
  /**
   * `owner/name` repository locator, supplied by the caller alongside the
   * stable repository ID it already resolved (e.g. from `RepositoryContext`).
   * This function performs no GitHub I/O and cannot derive it independently.
   */
  readonly repositoryNameWithOwner?: string;
}

/**
 * Project a worker handoff from one already-validated Change projection.
 *
 * No GitHub I/O occurs here.  Callers acquire fresh evidence through the
 * existing Change read/executor boundary before invoking this function.
 */
export function tryProjectImplementationHandoff(
  input: unknown,
  options: ImplementationHandoffProjectionOptions = {},
): ImplementationHandoffProjectionResult {
  const validation = validateChangeProjectionResult(input);
  if (!validation.valid || validation.projection === undefined) return invalid(validation.diagnostics);
  const projection = validation.projection;
  const extraDiagnostics: ChangeDiagnostic[] = [];
  const statusFailure = statusDiagnostic(projection.status);
  if (!projection.valid || projection.status !== "healthy") {
    if (projection.diagnostics.length > 0) extraDiagnostics.push(...projection.diagnostics);
    if (statusFailure !== undefined) extraDiagnostics.push(statusFailure);
    if (extraDiagnostics.length === 0) {
      extraDiagnostics.push(
        diagnostic("CHANGE_INVALID_PROJECTION", "$.valid", "Change projection is not implementation-admissible."),
      );
    }
    return invalid(extraDiagnostics);
  }
  if (projection.diagnostics.length > 0) {
    return invalid([
      ...projection.diagnostics,
      diagnostic("CHANGE_INVALID_PROJECTION", "$.diagnostics", "Healthy Change evidence contains diagnostics."),
    ]);
  }
  const change: Change | undefined = projection.change;
  if (change === undefined) {
    return invalid([diagnostic("CHANGE_MISSING_PROPERTY", "$.change", "A healthy Change projection is required.")]);
  }
  if (change.state !== "DRAFT") {
    return invalid([
      diagnostic(
        "CHANGE_INVALID_STATE",
        "$.change.state",
        `Change state "${change.state}" is not implementation-admissible; only DRAFT may be handed off.`,
      ),
    ]);
  }
  if (projection.canonicalBranch === undefined)
    extraDiagnostics.push(
      diagnostic("CHANGE_MISSING_PROPERTY", "$.canonicalBranch", "Canonical branch identity is required."),
    );
  if (projection.canonicalBaseBranch === undefined)
    extraDiagnostics.push(
      diagnostic("CHANGE_MISSING_PROPERTY", "$.canonicalBaseBranch", "Canonical base branch identity is required."),
    );
  const branch = projection.canonicalBranch;
  const baseBranch = projection.canonicalBaseBranch;
  const changeProjection = change.projection;
  if (changeProjection?.branch === undefined)
    extraDiagnostics.push(
      diagnostic("CHANGE_MISSING_PROPERTY", "$.change.projection.branch", "Change branch identity is required."),
    );
  else if (branch !== undefined && changeProjection.branch !== branch)
    extraDiagnostics.push(
      diagnostic(
        "CHANGE_PROVENANCE_BRANCH_MISMATCH",
        "$.change.projection.branch",
        "Change branch does not match the canonical projection.",
      ),
    );
  const pullRequest = changeProjection?.pullRequest;
  if (pullRequest === undefined)
    extraDiagnostics.push(
      diagnostic(
        "CHANGE_MISSING_PROPERTY",
        "$.change.projection.pullRequest",
        "Canonical pull-request identity is required.",
      ),
    );
  if (branch === undefined || baseBranch === undefined || pullRequest === undefined) return invalid(extraDiagnostics);
  if (change.identity.rootIssue < 1)
    extraDiagnostics.push(
      diagnostic("CHANGE_INVALID_IDENTITY", "$.change.identity.rootIssue", "Change root Issue is invalid."),
    );
  const candidates = canonicalCandidateCount(projection, branch, baseBranch, pullRequest);
  const canonicalPullRequest = projection.candidates.pullRequests.find(
    (candidate) =>
      candidate.classification === "canonical" &&
      candidate.candidate.number === pullRequest &&
      candidate.candidate.head === branch &&
      candidate.candidate.base === baseBranch,
  )?.candidate;
  const canonicalBranchCandidate = projection.candidates.branches.find(
    (candidate) => candidate.classification === "canonical" && candidate.candidate.name === branch,
  )?.candidate;
  if (candidates.branches !== 1)
    extraDiagnostics.push(
      diagnostic(
        "CHANGE_PROJECTION_AMBIGUOUS",
        "$.candidates.branches",
        "Exactly one canonical branch candidate is required.",
      ),
    );
  if (candidates.pullRequests !== 1)
    extraDiagnostics.push(
      diagnostic(
        "CHANGE_PROJECTION_AMBIGUOUS",
        "$.candidates.pullRequests",
        "Exactly one canonical pull-request candidate is required.",
      ),
    );
  if (
    canonicalBranchCandidate?.rootIssue !== undefined &&
    canonicalBranchCandidate.rootIssue !== change.identity.rootIssue
  )
    extraDiagnostics.push(
      diagnostic(
        "CHANGE_PROJECTION_CONFLICT",
        "$.candidates.branches",
        "Canonical branch root Issue does not match the Change identity.",
      ),
    );
  if (canonicalPullRequest !== undefined) {
    if (canonicalPullRequest.state !== "open" || !canonicalPullRequest.draft || canonicalPullRequest.merged) {
      extraDiagnostics.push(
        diagnostic(
          "CHANGE_INVALID_STATE",
          "$.candidates.pullRequests",
          "Canonical pull request must be open and in DRAFT state for implementation handoff.",
        ),
      );
    }
    if (canonicalPullRequest.accepted === true) {
      extraDiagnostics.push(
        diagnostic(
          "CHANGE_PROJECTION_CONFLICT",
          "$.candidates.pullRequests",
          "A draft canonical pull request cannot be accepted.",
        ),
      );
    }
    if (canonicalPullRequest.rootIssue !== undefined && canonicalPullRequest.rootIssue !== change.identity.rootIssue) {
      extraDiagnostics.push(
        diagnostic(
          "CHANGE_PROJECTION_CONFLICT",
          "$.candidates.pullRequests",
          "Canonical pull-request root Issue does not match the Change identity.",
        ),
      );
    }
  }
  if (options.repositoryNameWithOwner !== undefined && !validNameWithOwner(options.repositoryNameWithOwner))
    extraDiagnostics.push(
      diagnostic(
        "CHANGE_INVALID_PROJECTION",
        "$.repositoryNameWithOwner",
        "repositoryNameWithOwner must be an owner/name locator.",
      ),
    );
  if (extraDiagnostics.length > 0) return invalid(extraDiagnostics);
  const handoff: ImplementationHandoff = {
    version: IMPLEMENTATION_HANDOFF_CONTRACT_VERSION,
    kind: IMPLEMENTATION_HANDOFF_KIND,
    repositoryHost: change.identity.repositoryHost,
    repositoryId: change.identity.repositoryId,
    ...(options.repositoryNameWithOwner === undefined
      ? {}
      : { repositoryNameWithOwner: options.repositoryNameWithOwner }),
    rootIssue: change.identity.rootIssue,
    changeVersion: change.version,
    state: "DRAFT",
    branch,
    baseBranch,
    pullRequest,
  };
  return { valid: true, handoff: Object.freeze(handoff), diagnostics: [] };
}

/** Alias named after the Change-owned projection. */
export const tryProjectChangeImplementationHandoff = tryProjectImplementationHandoff;

/** Throwing Core entry point for callers that require an admissible handoff. */
export function projectImplementationHandoff(
  input: unknown,
  options: ImplementationHandoffProjectionOptions = {},
): ImplementationHandoff {
  const result = tryProjectImplementationHandoff(input, options);
  if (!result.valid || result.handoff === undefined) throw new ImplementationHandoffProjectionError(result.diagnostics);
  return result.handoff;
}

/** Alias named after the Change-owned projection. */
export const projectChangeImplementationHandoff = projectImplementationHandoff;
