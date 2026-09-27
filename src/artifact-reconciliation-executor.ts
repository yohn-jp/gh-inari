import {
  extractIssueDependencyMarker,
  extractTemplateIdentityMarker,
  recoverExistingArtifactValues,
  type ArtifactInputDocument,
  type ArtifactRecoveryCoverage,
  type ExistingArtifactValidationResult,
  type ExistingArtifactDiagnosticCode,
  type TemplateIdentityMarker,
} from "./artifact.js";
import { createArtifactObservationIdentity, StaleArtifactObservationError } from "./artifact-observation-identity.js";
import {
  assessExistingArtifact,
  currentArtifactInput,
  diffArtifact,
  prepareRemediationArtifact,
  projectRemediationRouting,
  readGovernedExistingArtifact,
  validateReconstructedInput,
  type ExistingArtifactRead,
  type PreparedRemediationArtifact,
  type RemediationRoutingProjection,
} from "./reconciliation.js";
import { GovernanceError, verifyGovernedMutationFreshness } from "./governance.js";
import { isGitHubAdapterError, type GitHubAdapter } from "./github/index.js";
import { TemplateNotFoundError } from "./template-discovery.js";
import type { ValidatedRenderedIssueArtifact, ValidatedRenderedPullRequestArtifact } from "./github/types.js";

export const ARTIFACT_RECONCILIATION_VERSION = 1 as const;

export interface ArtifactReconciliationRequest {
  readonly version: typeof ARTIFACT_RECONCILIATION_VERSION;
  readonly domain: "issue" | "pr";
  readonly number: number;
}

export type ArtifactReconciliationOutcome =
  "unchanged" | "reconciled" | "blocked" | "safe-pre-effect-retry" | "possible-effect-ambiguity";

export type ArtifactReconciliationEffect = "not-started" | "applied" | "possible";
export type ArtifactReconciliationRetry = "none" | "safe" | "fresh-observation-required";
export type ArtifactReconciliationFailureStage = "observe" | "freshness" | "effect" | "verify";

export interface ArtifactReconciliationFailure {
  readonly stage: ArtifactReconciliationFailureStage;
  readonly code: string;
}

export interface ArtifactReconciliationRecoveryEvidence {
  readonly templatePath: string;
  readonly coverage?: ArtifactRecoveryCoverage;
  readonly diagnostics: readonly {
    readonly code: ExistingArtifactDiagnosticCode;
    readonly path: string;
  }[];
  readonly dependencyMarker?: "malformed" | "unsupported-version";
}

/** Secret-free, versioned result of one observe/decide/effect/verify operation. */
export interface ArtifactReconciliationResult {
  readonly version: typeof ARTIFACT_RECONCILIATION_VERSION;
  readonly domain: ArtifactReconciliationRequest["domain"];
  readonly number: number;
  readonly outcome: ArtifactReconciliationOutcome;
  readonly effect: ArtifactReconciliationEffect;
  readonly retry: ArtifactReconciliationRetry;
  readonly routing?: RemediationRoutingProjection;
  readonly failure?: ArtifactReconciliationFailure;
  readonly recovery?: ArtifactReconciliationRecoveryEvidence;
}

/** Reconcile one current Issue or pull request through repository governance. */
export async function executeArtifactReconciliation(
  adapter: GitHubAdapter,
  request: ArtifactReconciliationRequest,
): Promise<ArtifactReconciliationResult> {
  assertRequest(request);

  let read: ExistingArtifactRead;
  try {
    read = await readGovernedExistingArtifact(adapter, request.domain, request.number);
  } catch (error: unknown) {
    if (error instanceof TemplateNotFoundError) {
      return blocked(request, {
        version: 1,
        kind: "template-selection-required",
        inputMode: "template-selection",
        reason: "authoritative-template-selection-required",
      });
    }
    const preEffectFailure = classifyPreEffectFailure(error, "observe");
    if (preEffectFailure !== undefined) return preEffectFailure(request);
    throw error;
  }

  const markerSelected = hasAuthoritativeMarker(request.domain, read);
  const inferredSelected =
    read.templateSelection === "inferred" && read.result.parse.parsed && read.contract !== undefined;
  if (read.governanceFailures?.some((failure) => failure.kind === "governance-unavailable") && !markerSelected) {
    return safeRetry(request, "observe", "GOVERNANCE_SOURCE_UNAVAILABLE");
  }
  if (read.governanceFailures?.length && !markerSelected && !inferredSelected) {
    return blocked(request, unresolvedGovernanceRouting(read));
  }

  const recovery = recoverMarkedRead(request.domain, read);
  if (recovery.kind === "blocked") {
    return blocked(
      request,
      manualReviewRouting("marked-recovery-not-proven"),
      { stage: "observe", code: recovery.code },
      recovery.evidence,
    );
  }
  const routingRead = recovery.kind === "recovered" ? recovery.read : read;
  const recoveryEvidence = recovery.kind === "recovered" ? recovery.evidence : undefined;
  const routing = projectRemediationRouting(request.domain, routingRead);
  if (routing.kind === "none") return unchanged(request, routing, recoveryEvidence);
  if (routing.kind !== "normalize" || routingRead.contract === undefined) {
    return blocked(request, routing, undefined, recoveryEvidence);
  }

  let prepared: PreparedRemediationArtifact;
  try {
    prepared = prepareRemediationArtifact(
      request.domain,
      routingRead.contract,
      currentArtifactInput(request.domain, routingRead),
    );
  } catch (error: unknown) {
    return blocked(request, routing, failureEvidence("freshness", error), recoveryEvidence);
  }

  const diff = diffArtifact(request.domain, routingRead, prepared);
  if (diff.semantic.length > 0) {
    return blocked(
      request,
      {
        version: routing.version,
        kind: "manual-review",
        inputMode: "manual",
        reason: "semantic-preservation-not-proven",
      },
      undefined,
      recoveryEvidence,
    );
  }
  if (!diff.changed) return unchanged(request, routing, recoveryEvidence);

  try {
    await verifyGovernedMutationFreshness(adapter, prepared.provenance);
  } catch (error: unknown) {
    const preEffectFailure = classifyPreEffectFailure(error, "freshness");
    if (preEffectFailure !== undefined) return withRecoveryEvidence(preEffectFailure(request), recoveryEvidence);
    throw error;
  }

  const observationIdentity =
    routingRead.observationIdentity ?? createArtifactObservationIdentity(request.domain, routingRead.remote);
  try {
    if (request.domain === "issue") {
      await adapter.updateIssue(
        request.number,
        prepared as ValidatedRenderedIssueArtifact,
        undefined,
        observationIdentity,
      );
    } else {
      await adapter.updatePullRequest(
        request.number,
        prepared as ValidatedRenderedPullRequestArtifact,
        undefined,
        observationIdentity,
      );
    }
  } catch (error: unknown) {
    if (error instanceof StaleArtifactObservationError) {
      return safeRetry(request, "freshness", error.code, recoveryEvidence);
    }
    if (isGitHubAdapterError(error) && error.code === "GITHUB_RESOURCE_KIND_MISMATCH") {
      return blocked(request, routing, failureEvidence("effect", error), recoveryEvidence);
    }
    return possibleEffect(request, "possible", "effect", failureCode(error), undefined, recoveryEvidence);
  }

  let after: ExistingArtifactRead;
  try {
    after = await readGovernedExistingArtifact(adapter, request.domain, request.number);
  } catch (error: unknown) {
    return possibleEffect(request, "applied", "verify", failureCode(error), undefined, recoveryEvidence);
  }

  const afterRouting = projectRemediationRouting(request.domain, after);
  const postcondition =
    hasAuthoritativeMarker(request.domain, after) ||
    (after.templateSelection === "inferred" && after.result.parse.parsed && after.contract !== undefined);
  const afterAssessment = assessExistingArtifact(request.domain, after);
  const afterDiff = after.contract === undefined ? undefined : diffArtifact(request.domain, after, prepared);
  if (
    !postcondition ||
    afterRouting.kind !== "none" ||
    afterAssessment.status !== "valid-current" ||
    afterDiff?.changed !== false
  ) {
    return possibleEffect(request, "applied", "verify", "POSTCONDITION_NOT_VERIFIED", afterRouting, recoveryEvidence);
  }

  return result(request, "reconciled", "applied", "none", routing, undefined, recoveryEvidence);
}

function assertRequest(request: ArtifactReconciliationRequest): void {
  if (
    typeof request !== "object" ||
    request === null ||
    request.version !== ARTIFACT_RECONCILIATION_VERSION ||
    (request.domain !== "issue" && request.domain !== "pr") ||
    !Number.isSafeInteger(request.number) ||
    request.number <= 0
  ) {
    throw new TypeError("Artifact reconciliation request is invalid.");
  }
}

function hasAuthoritativeMarker(domain: "issue" | "pr", read: ExistingArtifactRead): boolean {
  if (read.contract === undefined) return false;
  const markerBody =
    domain === "issue" ? extractIssueDependencyMarker(read.remote.body ?? "").body : (read.remote.body ?? "");
  const marker = extractTemplateIdentityMarker(markerBody);
  if (marker.status !== "valid" || marker.marker === undefined) return false;
  return markerNamesContract(domain, marker.marker, read.contract);
}

function markerNamesContract(
  domain: "issue" | "pr",
  marker: TemplateIdentityMarker,
  contract: NonNullable<ExistingArtifactRead["contract"]>,
): boolean {
  if (marker.kind !== (domain === "issue" ? "issue" : "pull_request")) return false;
  return marker.path === contract.templateIdentity.path || marker.path === contract.provenance?.semanticSource?.path;
}

type MarkedRecovery =
  | { readonly kind: "not-applicable" }
  | {
      readonly kind: "blocked";
      readonly code: string;
      readonly evidence: ArtifactReconciliationRecoveryEvidence;
    }
  | {
      readonly kind: "recovered";
      readonly read: ExistingArtifactRead;
      readonly evidence: ArtifactReconciliationRecoveryEvidence;
    };

function recoverMarkedRead(domain: "issue" | "pr", read: ExistingArtifactRead): MarkedRecovery {
  if (read.result.parse.parsed || read.contract === undefined || !hasAuthoritativeMarker(domain, read)) {
    return { kind: "not-applicable" };
  }

  const recovered = recoverExistingArtifactValues(read.contract, read.remote.body);
  const dependencyMarker = domain === "issue" ? extractIssueDependencyMarker(read.remote.body ?? "") : undefined;
  const evidence: ArtifactReconciliationRecoveryEvidence = {
    templatePath: read.contract.templateIdentity.path,
    coverage: recovered.coverage,
    diagnostics: recovered.diagnostics.map(({ code, path }) => ({ code, path })),
    ...(dependencyMarker?.status === "malformed" || dependencyMarker?.status === "unsupported-version"
      ? { dependencyMarker: dependencyMarker.status }
      : {}),
  };
  if (dependencyMarker?.status === "malformed" || dependencyMarker?.status === "unsupported-version") {
    return { kind: "blocked", code: "RECOVERY_DEPENDENCY_MARKER_INVALID", evidence };
  }
  if (!recovered.coverage.complete || recovered.coverage.unmatchedLineCount !== 0 || recovered.coverage.truncated) {
    return { kind: "blocked", code: "RECOVERY_COVERAGE_INCOMPLETE", evidence };
  }
  if (!recoveryDiagnosticsAdmitted(read.contract, recovered.diagnostics)) {
    return { kind: "blocked", code: "RECOVERY_DIAGNOSTICS_UNSUPPORTED", evidence };
  }

  const current = currentArtifactInput(domain, read);
  const dependencies = domain === "issue" ? (recovered.dependencies ?? { blockedBy: [], blocks: [] }) : undefined;
  const input: ArtifactInputDocument = {
    fields: recovered.values,
    metadata: current.metadata,
    ...(dependencies === undefined ? {} : { dependencies }),
  };
  try {
    validateReconstructedInput(read.contract, input, "NORMALIZATION_UNSAFE");
  } catch {
    return { kind: "blocked", code: "RECOVERY_SEMANTIC_VALIDATION_FAILED", evidence };
  }

  const recoveredResult: ExistingArtifactValidationResult = {
    valid: true,
    classification: "valid",
    parse: {
      parsed: true,
      values: recovered.values,
      ...(dependencies === undefined ? {} : { dependencies }),
      diagnostics: [],
    },
    violations: [],
  };
  const candidateRead: ExistingArtifactRead = { ...read, result: recoveredResult };
  let prepared: PreparedRemediationArtifact;
  try {
    prepared = prepareRemediationArtifact(domain, read.contract, input);
  } catch {
    return { kind: "blocked", code: "RECOVERY_SEMANTIC_VALIDATION_FAILED", evidence };
  }
  if (diffArtifact(domain, candidateRead, prepared).semantic.length > 0) {
    return { kind: "blocked", code: "RECOVERY_SEMANTIC_PRESERVATION_UNPROVEN", evidence };
  }
  return { kind: "recovered", read: candidateRead, evidence };
}

function recoveryDiagnosticsAdmitted(
  contract: NonNullable<ExistingArtifactRead["contract"]>,
  diagnostics: readonly { readonly code: ExistingArtifactDiagnosticCode; readonly path: string }[],
): boolean {
  return (
    diagnostics.length > 0 &&
    diagnostics.every((diagnostic) => {
      if (diagnostic.code !== "EXISTING_WRONG_TEMPLATE") return false;
      const match = /^\$\.sections\.([A-Za-z0-9_-]+)$/u.exec(diagnostic.path);
      const section =
        match?.[1] === undefined ? undefined : contract.sections.find((candidate) => candidate.id === match[1]);
      return section?.kind === "input";
    })
  );
}

function manualReviewRouting(reason: string): RemediationRoutingProjection {
  return { version: 1, kind: "manual-review", inputMode: "manual", reason };
}

function unresolvedGovernanceRouting(read: ExistingArtifactRead): RemediationRoutingProjection {
  const candidates = [
    ...(read.result.attemptedTemplates ?? []),
    ...(read.governanceFailures?.map((failure) => failure.path) ?? []),
  ]
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort();
  return {
    version: 1,
    kind: "manual-review",
    inputMode: "manual",
    ...(candidates.length === 0 ? {} : { templateCandidates: candidates.slice(0, 32) }),
    reason: "authoritative-template-selection-unavailable",
  };
}

function classifyPreEffectFailure(
  error: unknown,
  stage: "observe" | "freshness",
): ((request: ArtifactReconciliationRequest) => ArtifactReconciliationResult) | undefined {
  if (isGitHubAdapterError(error)) return (request) => safeRetry(request, stage, error.code);
  if (error instanceof StaleArtifactObservationError) return (request) => safeRetry(request, stage, error.code);
  if (error instanceof GovernanceError) {
    if (error.code === "GOVERNANCE_SOURCE_UNAVAILABLE" || error.code === "GOVERNANCE_GENERATION_STALE") {
      return (request) => safeRetry(request, stage, error.code);
    }
    return (request) => blocked(request, undefined, { stage, code: error.code });
  }
  return undefined;
}

function failureCode(error: unknown): string {
  if (isGitHubAdapterError(error)) return error.code;
  if (error instanceof GovernanceError) return error.code;
  if (error instanceof StaleArtifactObservationError) return error.code;
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return "ARTIFACT_RECONCILIATION_FAILED";
}

function failureEvidence(stage: ArtifactReconciliationFailureStage, error: unknown): ArtifactReconciliationFailure {
  return { stage, code: failureCode(error) };
}

function result(
  request: ArtifactReconciliationRequest,
  outcome: ArtifactReconciliationOutcome,
  effect: ArtifactReconciliationEffect,
  retry: ArtifactReconciliationRetry,
  routing?: RemediationRoutingProjection,
  failure?: ArtifactReconciliationFailure,
  recovery?: ArtifactReconciliationRecoveryEvidence,
): ArtifactReconciliationResult {
  return {
    version: ARTIFACT_RECONCILIATION_VERSION,
    domain: request.domain,
    number: request.number,
    outcome,
    effect,
    retry,
    ...(routing === undefined ? {} : { routing }),
    ...(failure === undefined ? {} : { failure }),
    ...(recovery === undefined ? {} : { recovery }),
  };
}

function withRecoveryEvidence(
  resultValue: ArtifactReconciliationResult,
  recovery?: ArtifactReconciliationRecoveryEvidence,
): ArtifactReconciliationResult {
  return recovery === undefined ? resultValue : { ...resultValue, recovery };
}

function unchanged(
  request: ArtifactReconciliationRequest,
  routing: RemediationRoutingProjection,
  recovery?: ArtifactReconciliationRecoveryEvidence,
): ArtifactReconciliationResult {
  return result(request, "unchanged", "not-started", "none", routing, undefined, recovery);
}

function blocked(
  request: ArtifactReconciliationRequest,
  routing?: RemediationRoutingProjection,
  failure?: ArtifactReconciliationFailure,
  recovery?: ArtifactReconciliationRecoveryEvidence,
): ArtifactReconciliationResult {
  return result(request, "blocked", "not-started", "none", routing, failure, recovery);
}

function safeRetry(
  request: ArtifactReconciliationRequest,
  stage: "observe" | "freshness",
  code: string,
  recovery?: ArtifactReconciliationRecoveryEvidence,
): ArtifactReconciliationResult {
  return result(request, "safe-pre-effect-retry", "not-started", "safe", undefined, { stage, code }, recovery);
}

function possibleEffect(
  request: ArtifactReconciliationRequest,
  effect: "applied" | "possible",
  stage: "effect" | "verify",
  code: string,
  routing?: RemediationRoutingProjection,
  recovery?: ArtifactReconciliationRecoveryEvidence,
): ArtifactReconciliationResult {
  return result(
    request,
    "possible-effect-ambiguity",
    effect,
    "fresh-observation-required",
    routing,
    { stage, code },
    recovery,
  );
}
