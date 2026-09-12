/**
 * Semantic capability admission at the boundary before trusted Change
 * execution.
 *
 * This module composes existing authorities only. Runtime trust is reread
 * through `resolveRuntimeAuthority`, Change identity/state is projected by
 * `change.ts`, and protected repository paths are classified by
 * `protected-paths.ts`. It does not own credentials, provider clients,
 * repository policy, Change state, or effects.
 */

import {
  CHANGE_TRANSITION_CONTRACT_VERSION,
  planChangeTransition,
  projectChangeFromGitHubEvidence,
  validateChangeProjectionResult,
  type Change,
  type ChangeIdentity,
  type ChangeProjectionInput,
  type ChangeProjectionResult,
  type ChangeProjectionStatus,
  type ChangeState,
  type ChangeTransition,
} from "../change.js";
import { tryProjectImplementationHandoff } from "../change-handoff.js";
import {
  MAX_ISSUE_NUMBER,
  capabilityClaimIssueNumber,
  capabilityClaimWithinCeiling,
  validateCapabilityClaim,
  type CapabilityClaim,
  type CapabilityKind,
} from "./capability.js";
import { admitDelegatedWrite, type DelegatedTreeDeltaClassification } from "./protected-paths.js";
import {
  resolveRuntimeAuthority,
  type LoadedRuntimeAuthority,
  type RuntimeAuthoritySourceReader,
  type RuntimeAuthorityTrustProvenance,
} from "./runtime-authority-trust.js";
import type {
  AuthenticatedSessionAuthorityRef,
  AuthenticatedSessionContext,
  AuthenticatedSessionRepository,
} from "./session-authentication.js";
import { MAX_UNIX_TIME_SECONDS } from "./session-certificate.js";
import { canonicalizeSemanticRequest } from "./session-request.js";

export const CAPABILITY_ADMISSION_CONTRACT_VERSION = 1 as const;
export type CapabilityAdmissionContractVersion = typeof CAPABILITY_ADMISSION_CONTRACT_VERSION;

/** Semantic operations that can be admitted by this V1 boundary. */
export const CAPABILITY_ADMISSION_OPERATIONS = Object.freeze([
  "change.implement",
  "change.issue",
  "change.show",
  "change.handoff",
  "change.ready",
  "change.abort",
  "branch.create",
  "branch.advance",
  "pullRequest.create",
] as const);
export type CapabilityAdmissionOperation = (typeof CAPABILITY_ADMISSION_OPERATIONS)[number];

/** Stable, non-secret denial reasons for the admission boundary. */
export const CAPABILITY_ADMISSION_FAILURE_REASONS = Object.freeze([
  "runtime-trust",
  "runtime-ceiling",
  "session-capability",
  "repository",
  "task",
  "canonical-state",
  "protected-path",
  "path-policy",
  "stale-evidence",
] as const);
export type CapabilityAdmissionFailureReason = (typeof CAPABILITY_ADMISSION_FAILURE_REASONS)[number];

/** Stable failure class for every denied admission. */
export class CapabilityAdmissionError extends Error {
  readonly code = "CAPABILITY_ADMISSION_DENIED" as const;
  readonly reason: CapabilityAdmissionFailureReason;

  constructor(reason: CapabilityAdmissionFailureReason) {
    super("Capability admission denied.");
    this.name = "CapabilityAdmissionError";
    this.reason = reason;
  }
}

/** Compatibility name for callers that name the stable failure by its code. */
export { CapabilityAdmissionError as CapabilityAdmissionDeniedError };

/** Immutable generation proof attached to the canonical Change read. */
export interface CapabilityAdmissionAuthorityGeneration {
  /** The canonical protected ref from which the evidence was read. */
  readonly ref: string;
  /** The immutable commit SHA for that ref generation. */
  readonly sha: string;
}

/**
 * Canonical Change evidence supplied by the existing Change read boundary.
 * The generation is deliberately outside `ChangeProjectionInput`; this
 * wrapper binds that existing Core value to the same canonical generation as
 * the fresh Runtime trust read without changing the frozen Change contract.
 */
export interface CapabilityAdmissionCanonicalState {
  readonly projection: ChangeProjectionInput | ChangeProjectionResult;
  readonly authority: CapabilityAdmissionAuthorityGeneration;
}

/** Compatibility name for integrations that call the value Change evidence. */
export type CanonicalChangeStateEvidence = CapabilityAdmissionCanonicalState;

/**
 * A resolver supplied by the repository-policy consumer. It is a read seam,
 * not a policy store: the resolver must resolve the named policy from the
 * current canonical repository generation and return only a path predicate.
 */
export interface CapabilityAdmissionPathPolicyResolver {
  resolve(
    name: string,
    input: {
      readonly repository: AuthenticatedSessionRepository;
      readonly authority: RuntimeAuthorityTrustProvenance;
    },
  ): Promise<CapabilityAdmissionResolvedPathPolicy | undefined>;
}

/** Bounded result of resolving one named path policy. */
export interface CapabilityAdmissionResolvedPathPolicy {
  readonly name: string;
  readonly ref: string;
  readonly sha: string;
  /** Return true only for paths allowed by this narrower policy. */
  readonly allowsPath: (path: string) => boolean;
}

export interface AdmitAuthenticatedSessionCapabilityOptions {
  /** The exact output of #374 `authenticateSessionRequest`. */
  readonly context: AuthenticatedSessionContext;
  /** Existing #369 canonical Runtime trust reader. */
  readonly runtimeAuthorityReader: RuntimeAuthoritySourceReader;
  /** Current Core projection and the immutable generation used to read it. */
  readonly canonicalState: CapabilityAdmissionCanonicalState;
  /** Optional named path-policy resolver; absence is valid when no name is claimed. */
  readonly pathPolicyResolver?: CapabilityAdmissionPathPolicyResolver;
  /** One request-local admission clock. Defaults to the current time. */
  readonly now?: Date | number | (() => Date | number);
  /**
   * Optional caller assertion for composition. It must be present in the
   * signed semantic request and equal it; unsigned tree deltas are rejected.
   */
  readonly treeDelta?: unknown;
}

export interface CapabilityAdmissionCanonicalProjection {
  readonly status: ChangeProjectionStatus;
  readonly issue: number;
  readonly state: ChangeState;
  readonly branch: string;
  readonly baseBranch: string;
  readonly pullRequest?: number;
}

export interface CapabilityAdmissionLifecycle {
  readonly operation: Extract<ChangeTransition, "issue" | "ready" | "abort">;
  readonly from: ChangeState;
  readonly to: ChangeState;
  readonly idempotent: boolean;
}

export interface CapabilityAdmissionWrite {
  readonly branch: string;
  readonly expectedHead: string;
  readonly treeDelta: DelegatedTreeDeltaClassification;
  readonly pathPolicy?: {
    readonly name: string;
    readonly ref: string;
    readonly sha: string;
  };
}

/**
 * The only successful output. It contains bounded semantic identity and
 * provenance; it contains no certificate bytes, provider payload, credential,
 * provider client, path predicate, or executable effect.
 */
export interface AuthenticatedSessionCapabilityAdmission {
  readonly version: CapabilityAdmissionContractVersion;
  readonly operation: CapabilityAdmissionOperation;
  readonly repository: AuthenticatedSessionRepository;
  readonly runtimeAuthority: {
    readonly id: string;
    readonly kid: string;
  };
  readonly session: {
    readonly id: string;
    readonly certificateJti: string;
  };
  readonly task?: { readonly kind: "issue"; readonly number: number };
  readonly issue: number;
  /** All Session claims remaining after the current Runtime ceiling intersection. */
  readonly effectiveCapabilities: readonly CapabilityClaim[];
  /** The claim that directly admits this operation. */
  readonly capability: CapabilityClaim;
  /** Explicit lower-level claims that further narrow a high-level operation. */
  readonly narrowingCapabilities: readonly CapabilityClaim[];
  readonly authority: AuthenticatedSessionAuthorityRef;
  readonly canonical: CapabilityAdmissionCanonicalProjection;
  readonly change: Change;
  readonly lifecycle?: CapabilityAdmissionLifecycle;
  readonly write?: CapabilityAdmissionWrite;
}

const MAX_ADMISSION_TEXT_LENGTH = 1_024;
const MAX_BRANCH_HEAD_LENGTH = 128;

function deny(reason: CapabilityAdmissionFailureReason): never {
  throw new CapabilityAdmissionError(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validBoundedText(value: unknown, maximum = MAX_ADMISSION_TEXT_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function validIssue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_ISSUE_NUMBER;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_UNIX_TIME_SECONDS;
}

function validPullRequest(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function normalizeNow(input: Date | number | (() => Date | number) | undefined): Date {
  if (input === undefined) return new Date();
  if (typeof input === "function") {
    try {
      return normalizeNow(input());
    } catch {
      deny("stale-evidence");
    }
  }
  if (input instanceof Date) {
    if (!Number.isFinite(input.getTime())) deny("stale-evidence");
    return new Date(input.getTime());
  }
  if (!Number.isSafeInteger(input) || input < 0 || input > MAX_UNIX_TIME_SECONDS) deny("stale-evidence");
  return new Date(input * 1000);
}

function sameRepository(
  left: { readonly repositoryHost: string; readonly repositoryId: string },
  right: {
    readonly host: string;
    readonly repositoryId: string;
  },
): boolean {
  return left.repositoryHost.toLowerCase() === right.host.toLowerCase() && left.repositoryId === right.repositoryId;
}

function sameClaim(left: CapabilityClaim, right: CapabilityClaim): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "change.implement":
    case "change.ready":
    case "change.abort":
      return right.kind === left.kind && right.issue === left.issue;
    case "branch.create":
      return right.kind === left.kind && right.branch === left.branch && right.max === left.max;
    case "branch.advance":
      return right.kind === left.kind && right.branch === left.branch && right.pathPolicy === left.pathPolicy;
    case "pullRequest.create":
      return right.kind === left.kind && right.head === left.head && right.base === left.base && right.max === left.max;
  }
}

function sameClaimList(left: readonly CapabilityClaim[], right: readonly CapabilityClaim[]): boolean {
  return (
    left.length === right.length &&
    left.every((claim, index) => right[index] !== undefined && sameClaim(claim, right[index]))
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function validateContextConsistency(context: AuthenticatedSessionContext, now: Date): void {
  if (!isRecord(context) || !isRecord(context.repository) || !isRecord(context.runtimeAuthority))
    deny("session-capability");
  if (
    !validBoundedText(context.repository.repositoryHost) ||
    !validBoundedText(context.repository.repositoryId) ||
    !validBoundedText(context.repository.nameWithOwner)
  ) {
    deny("repository");
  }
  if (!validBoundedText(context.runtimeAuthority.id) || context.runtimeAuthority.id !== context.runtimeAuthority.kid) {
    deny("runtime-trust");
  }
  if (
    !isRecord(context.session) ||
    !validBoundedText(context.session.id) ||
    !validBoundedText(context.session.certificateJti)
  ) {
    deny("session-capability");
  }
  if (
    !isRecord(context.authority) ||
    !validBoundedText(context.authority.ref) ||
    !validBoundedText(context.authority.sha)
  ) {
    deny("runtime-trust");
  }
  if (
    !isRecord(context.request) ||
    !validBoundedText(context.request.requestId) ||
    !validBoundedText(context.request.operation) ||
    !validTimestamp(context.request.issuedAt) ||
    !validTimestamp(context.request.expiresAt) ||
    context.request.expiresAt <= context.request.issuedAt
  ) {
    deny("session-capability");
  }

  const verified = context.verifiedRequest;
  if (!isRecord(verified) || !isRecord(verified.envelope) || !isRecord(verified.certificate)) {
    deny("session-capability");
  }
  const envelope = verified.envelope;
  const certificate = verified.certificate;
  const payload = certificate.payload;
  const header = certificate.header;
  if (!isRecord(payload) || !isRecord(header)) deny("session-capability");
  if (!isRecord(payload.repository)) deny("repository");
  if (payload.task !== undefined && !isRecord(payload.task)) deny("task");
  if (
    envelope.repositoryId !== context.repository.repositoryId ||
    envelope.operation !== context.request.operation ||
    envelope.requestId !== context.request.requestId ||
    envelope.issuedAt !== context.request.issuedAt ||
    envelope.expiresAt !== context.request.expiresAt ||
    envelope.certificateJti !== context.session.certificateJti
  ) {
    deny("session-capability");
  }
  if (
    header.kid !== context.runtimeAuthority.kid ||
    payload.repository.id !== context.repository.repositoryId ||
    payload.iss !== `runtime:${context.runtimeAuthority.id}` ||
    payload.jti !== context.session.certificateJti ||
    payload.sub !== `session:${context.session.id}`
  ) {
    deny("session-capability");
  }
  if (
    !validTimestamp(payload.nbf) ||
    !validTimestamp(payload.exp) ||
    !validTimestamp(payload.iat) ||
    payload.exp <= payload.nbf
  ) {
    deny("session-capability");
  }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    nowSeconds < payload.nbf ||
    nowSeconds >= payload.exp ||
    nowSeconds < envelope.issuedAt ||
    nowSeconds >= envelope.expiresAt
  ) {
    deny("stale-evidence");
  }

  const contextTask = context.task;
  const certificateTask = payload.task;
  if (
    (contextTask !== undefined && (contextTask.kind !== "issue" || !validIssue(contextTask.number))) ||
    (certificateTask !== undefined && (certificateTask.kind !== "issue" || !validIssue(certificateTask.number)))
  ) {
    deny("task");
  }
  if (
    (contextTask === undefined) !== (certificateTask === undefined) ||
    (contextTask !== undefined &&
      (certificateTask === undefined ||
        contextTask.kind !== certificateTask.kind ||
        contextTask.number !== certificateTask.number))
  ) {
    deny("task");
  }

  if (!Array.isArray(context.capabilities) || !Array.isArray(payload.capabilities)) deny("session-capability");
  const normalizedContextClaims: CapabilityClaim[] = [];
  for (const [index, claim] of context.capabilities.entries()) {
    const result = validateCapabilityClaim(claim, `$.context.capabilities[${index}]`);
    if (!result.valid || result.value === undefined) deny("session-capability");
    if (normalizedContextClaims.some((existing) => sameClaim(existing, result.value as CapabilityClaim))) {
      deny("session-capability");
    }
    normalizedContextClaims.push(result.value);
  }
  const normalizedCertificateClaims: CapabilityClaim[] = [];
  for (const [index, claim] of payload.capabilities.entries()) {
    const result = validateCapabilityClaim(claim, `$.certificate.capabilities[${index}]`);
    if (!result.valid || result.value === undefined) deny("session-capability");
    normalizedCertificateClaims.push(result.value);
  }
  if (!sameClaimList(normalizedContextClaims, normalizedCertificateClaims)) deny("session-capability");
}

function resolveProjection(state: CapabilityAdmissionCanonicalState): {
  readonly projection: ChangeProjectionResult;
  readonly source?: ChangeProjectionInput;
} {
  if (!isRecord(state) || !isRecord(state.authority) || !isRecord(state.projection)) deny("stale-evidence");
  if (!validBoundedText(state.authority.ref) || !validBoundedText(state.authority.sha)) deny("stale-evidence");

  const candidate = state.projection;
  if (hasOwn(candidate, "status") || hasOwn(candidate, "candidates") || hasOwn(candidate, "valid")) {
    const result = validateChangeProjectionResult(candidate);
    if (!result.valid || result.projection === undefined) deny("canonical-state");
    return { projection: result.projection };
  }
  const projection = projectChangeFromGitHubEvidence(candidate);
  return { projection, source: candidate as ChangeProjectionInput };
}

function canonicalChange(
  projection: ChangeProjectionResult,
  repository: AuthenticatedSessionRepository,
  issue: number,
): CapabilityAdmissionCanonicalProjection & { readonly change: Change } {
  if (projection.status === "unavailable") deny("stale-evidence");
  if (!projection.change || projection.canonicalBranch === undefined || projection.canonicalBaseBranch === undefined) {
    deny("canonical-state");
  }
  const change = projection.change;
  const identity: ChangeIdentity = change.identity;
  if (
    identity.repositoryHost.toLowerCase() !== repository.repositoryHost.toLowerCase() ||
    identity.repositoryId !== repository.repositoryId
  ) {
    deny("repository");
  }
  if (identity.rootIssue !== issue) deny("task");
  if (projection.canonicalBranch === "main" || !validBoundedText(projection.canonicalBranch)) deny("canonical-state");
  if (!validBoundedText(projection.canonicalBaseBranch)) deny("canonical-state");

  const branch = projection.canonicalBranch;
  const baseBranch = projection.canonicalBaseBranch;
  const canonicalBranches = projection.candidates.branches.filter(
    (candidate) => candidate.classification === "canonical" && candidate.candidate.name === branch,
  );
  const canonicalPullRequests = projection.candidates.pullRequests.filter(
    (candidate) =>
      candidate.classification === "canonical" &&
      candidate.candidate.head === branch &&
      candidate.candidate.base === baseBranch &&
      candidate.candidate.number !== issue,
  );

  if (projection.status === "absent") {
    if (change.state !== "DEFINED" || change.projection !== undefined) deny("canonical-state");
    return { status: projection.status, issue, state: change.state, branch, baseBranch, change };
  }

  if (projection.status === "partial") {
    if (
      change.state !== "RECOVERY_REQUIRED" ||
      change.projection?.branch !== branch ||
      change.projection.pullRequest === undefined
    ) {
      deny("canonical-state");
    }
    if (canonicalPullRequests.length !== 1) deny("canonical-state");
    return {
      status: projection.status,
      issue,
      state: change.state,
      branch,
      baseBranch,
      pullRequest: change.projection.pullRequest,
      change,
    };
  }

  if (projection.status !== "healthy" || projection.diagnostics.length > 0 || !projection.valid)
    deny("canonical-state");
  if (
    change.projection?.branch !== branch ||
    change.projection.pullRequest === undefined ||
    canonicalPullRequests.length !== 1
  ) {
    deny("canonical-state");
  }
  if (change.state === "DRAFT" && canonicalBranches.length !== 1) deny("canonical-state");
  return {
    status: projection.status,
    issue,
    state: change.state,
    branch,
    baseBranch,
    pullRequest: change.projection.pullRequest,
    change,
  };
}

function requestObject(context: AuthenticatedSessionContext): Record<string, unknown> {
  const request = context.verifiedRequest.envelope.request;
  if (!isRecord(request)) deny("session-capability");
  return request;
}

function requestedIssue(request: Record<string, unknown>): number {
  if (!validIssue(request.issue)) deny("task");
  return request.issue;
}

function optionalExact(request: Record<string, unknown>, key: string, expected: string | number): void {
  if (!hasOwn(request, key)) return;
  if (request[key] !== expected) deny("canonical-state");
}

function requiredExact(request: Record<string, unknown>, key: string, expected: string | number): void {
  if (!hasOwn(request, key) || request[key] !== expected) deny("canonical-state");
}

function capabilityForOperation(
  operation: CapabilityAdmissionOperation,
  claims: readonly CapabilityClaim[],
  allClaims: readonly CapabilityClaim[],
  issue: number,
): CapabilityClaim {
  const matching = (kind: CapabilityKind): CapabilityClaim | undefined =>
    claims.find(
      (claim) =>
        claim.kind === kind &&
        (capabilityClaimIssueNumber(claim) === undefined || capabilityClaimIssueNumber(claim) === issue),
    );
  let candidate: CapabilityClaim | undefined;
  if (operation === "change.ready") candidate = matching("change.ready");
  else if (operation === "change.abort") candidate = matching("change.abort");
  else if (operation === "branch.create") candidate = claims.find((claim) => claim.kind === "branch.create");
  else if (operation === "pullRequest.create") candidate = claims.find((claim) => claim.kind === "pullRequest.create");
  else if (operation === "branch.advance") {
    candidate = claims.find((claim) => claim.kind === "branch.advance") ?? matching("change.implement");
  } else candidate = matching("change.implement");

  if (candidate !== undefined) return candidate;

  const possibleKinds: readonly CapabilityKind[] =
    operation === "change.ready"
      ? ["change.ready"]
      : operation === "change.abort"
        ? ["change.abort"]
        : operation === "branch.create"
          ? ["branch.create"]
          : operation === "pullRequest.create"
            ? ["pullRequest.create"]
            : operation === "branch.advance"
              ? ["branch.advance", "change.implement"]
              : ["change.implement"];
  if (
    allClaims.some(
      (claim) =>
        possibleKinds.includes(claim.kind) &&
        (capabilityClaimIssueNumber(claim) === undefined || capabilityClaimIssueNumber(claim) === issue),
    )
  ) {
    deny("runtime-ceiling");
  }
  if (
    allClaims.some(
      (claim) =>
        possibleKinds.includes(claim.kind) &&
        capabilityClaimIssueNumber(claim) !== undefined &&
        capabilityClaimIssueNumber(claim) !== issue,
    )
  ) {
    deny("task");
  }
  deny("session-capability");
}

function validateExplicitNarrowing(
  operation: CapabilityAdmissionOperation,
  claims: readonly CapabilityClaim[],
  branch: string,
  baseBranch: string,
  treeWriteRequested: boolean,
): readonly CapabilityClaim[] {
  const narrowing: CapabilityClaim[] = [];
  if (operation === "change.issue") {
    const branchClaims = claims.filter(
      (claim): claim is Extract<CapabilityClaim, { kind: "branch.create" }> => claim.kind === "branch.create",
    );
    if (branchClaims.length > 0) {
      const exact = branchClaims.find((claim) => claim.branch === branch);
      if (exact === undefined) deny("canonical-state");
      narrowing.push(exact);
    }
    const pullRequestClaims = claims.filter(
      (claim): claim is Extract<CapabilityClaim, { kind: "pullRequest.create" }> => claim.kind === "pullRequest.create",
    );
    if (pullRequestClaims.length > 0) {
      const exact = pullRequestClaims.find((claim) => claim.head === branch && claim.base === baseBranch);
      if (exact === undefined) deny("canonical-state");
      narrowing.push(exact);
    }
  }
  if (operation === "branch.advance" || (operation === "change.implement" && treeWriteRequested)) {
    const branchClaims = claims.filter(
      (claim): claim is Extract<CapabilityClaim, { kind: "branch.advance" }> => claim.kind === "branch.advance",
    );
    if (branchClaims.length > 0) {
      const exact = branchClaims.find((claim) => claim.branch === branch);
      if (exact === undefined) deny("canonical-state");
      narrowing.push(exact);
    }
  }
  return Object.freeze(narrowing);
}

function requireCanonicalOperationState(
  operation: CapabilityAdmissionOperation,
  canonical: CapabilityAdmissionCanonicalProjection & { readonly change: Change },
): void {
  if (operation === "change.issue" || operation === "change.show" || operation === "change.implement") {
    if (canonical.status !== "absent" && canonical.status !== "healthy") deny("canonical-state");
    if (operation === "change.implement" && canonical.status === "healthy" && canonical.state !== "DRAFT") {
      deny("canonical-state");
    }
  } else if (operation === "change.handoff") {
    if (canonical.status !== "healthy" || canonical.state !== "DRAFT" || canonical.pullRequest === undefined) {
      deny("canonical-state");
    }
  } else if (operation === "change.ready") {
    if (canonical.status !== "healthy") deny("canonical-state");
  } else if (operation === "change.abort") {
    if (canonical.status !== "healthy" && canonical.status !== "partial") deny("canonical-state");
  } else if (operation === "branch.advance") {
    if (canonical.status !== "healthy" || canonical.state !== "DRAFT" || canonical.pullRequest === undefined) {
      deny("canonical-state");
    }
  } else if (operation === "branch.create") {
    if (canonical.status !== "absent" && canonical.status !== "healthy") deny("canonical-state");
  } else if (operation === "pullRequest.create") {
    if (canonical.status !== "healthy" || canonical.pullRequest === undefined) deny("canonical-state");
  }
}

function lifecycleFor(
  operation: CapabilityAdmissionOperation,
  canonical: CapabilityAdmissionCanonicalProjection & { readonly change: Change },
): CapabilityAdmissionLifecycle | undefined {
  const transition: Extract<ChangeTransition, "issue" | "ready" | "abort"> | undefined =
    (operation === "change.issue" || operation === "change.implement") && canonical.status === "absent"
      ? "issue"
      : operation === "change.ready"
        ? "ready"
        : operation === "change.abort"
          ? "abort"
          : undefined;
  if (transition === undefined) {
    if (operation === "change.issue" && canonical.status === "healthy") {
      return Object.freeze({
        operation: "issue",
        from: canonical.state,
        to: canonical.state,
        idempotent: true,
      });
    }
    return undefined;
  }
  try {
    const plan = planChangeTransition({
      version: CHANGE_TRANSITION_CONTRACT_VERSION,
      transition,
      change: canonical.change,
      target: {
        branch: canonical.branch,
        ...(transition === "issue" ? { baseBranch: canonical.baseBranch } : {}),
        ...(canonical.pullRequest === undefined ? {} : { pullRequest: canonical.pullRequest }),
      },
    });
    return Object.freeze({
      operation: transition,
      from: plan.from,
      to: plan.to,
      idempotent: plan.from === plan.to,
    });
  } catch {
    deny("canonical-state");
  }
}

function writeTreeDelta(request: Record<string, unknown>, supplied: unknown): unknown {
  const signed = hasOwn(request, "treeDelta") ? request.treeDelta : undefined;
  if (supplied !== undefined) {
    if (signed === undefined) deny("session-capability");
    try {
      if (canonicalizeSemanticRequest({ value: supplied }) !== canonicalizeSemanticRequest({ value: signed })) {
        deny("session-capability");
      }
    } catch {
      deny("session-capability");
    }
  }
  if (signed === undefined) deny("protected-path");
  return signed;
}

async function admitPathPolicy(
  claim: Extract<CapabilityClaim, { kind: "branch.advance" }>,
  resolver: CapabilityAdmissionPathPolicyResolver | undefined,
  repository: AuthenticatedSessionRepository,
  authority: RuntimeAuthorityTrustProvenance,
  treeDelta: DelegatedTreeDeltaClassification,
): Promise<CapabilityAdmissionWrite["pathPolicy"]> {
  if (claim.pathPolicy === undefined) return undefined;
  if (resolver === undefined) deny("path-policy");
  let resolved: CapabilityAdmissionResolvedPathPolicy | undefined;
  try {
    resolved = await resolver.resolve(claim.pathPolicy, { repository, authority });
  } catch {
    deny("path-policy");
  }
  if (
    resolved === undefined ||
    resolved.name !== claim.pathPolicy ||
    resolved.ref !== authority.ref ||
    resolved.sha !== authority.policySha ||
    typeof resolved.allowsPath !== "function"
  ) {
    deny("path-policy");
  }
  try {
    if (!treeDelta.touchedPaths.every((path) => resolved.allowsPath(path))) deny("path-policy");
  } catch {
    deny("path-policy");
  }
  return Object.freeze({ name: resolved.name, ref: resolved.ref, sha: resolved.sha });
}

function verifyCurrentAuthorityGeneration(
  state: CapabilityAdmissionCanonicalState,
  runtime: LoadedRuntimeAuthority,
): void {
  if (
    !isRecord(state) ||
    !isRecord(state.authority) ||
    !validBoundedText(state.authority.ref) ||
    !validBoundedText(state.authority.sha) ||
    state.authority.ref !== runtime.provenance.ref ||
    state.authority.sha !== runtime.provenance.policySha
  ) {
    deny("stale-evidence");
  }
}

function freezeClaim(claim: CapabilityClaim): CapabilityClaim {
  return Object.freeze({ ...claim }) as CapabilityClaim;
}

/**
 * Admit the exact authenticated Session principal against fresh Runtime trust
 * and a current Core Change projection. No provider effect is invoked.
 */
export async function admitAuthenticatedSessionCapability(
  options: AdmitAuthenticatedSessionCapabilityOptions,
): Promise<AuthenticatedSessionCapabilityAdmission> {
  if (!isRecord(options)) deny("session-capability");
  const now = normalizeNow(options.now);
  const context = options.context;
  validateContextConsistency(context, now);

  let runtime: LoadedRuntimeAuthority;
  try {
    runtime = await resolveRuntimeAuthority(options.runtimeAuthorityReader, context.runtimeAuthority.id, { now });
  } catch {
    deny("runtime-trust");
  }

  if (runtime.authority.id !== context.runtimeAuthority.id || runtime.authority.id !== context.runtimeAuthority.kid) {
    deny("runtime-trust");
  }
  if (!sameRepository(context.repository, runtime.provenance.repository)) deny("repository");
  if (context.authority.ref !== runtime.provenance.ref || context.authority.sha !== runtime.provenance.policySha) {
    deny("runtime-trust");
  }

  const certificate = context.verifiedRequest.certificate;
  const payload = certificate.payload;
  if (payload.exp - payload.nbf > runtime.authority.maxSessionTtlSeconds) deny("runtime-ceiling");

  const allClaims: CapabilityClaim[] = context.capabilities.map((claim) => freezeClaim(claim));
  const effectiveCapabilities = allClaims.filter((claim) =>
    capabilityClaimWithinCeiling(claim, runtime.authority.capabilityCeiling),
  );
  const request = requestObject(context);
  const operationValue = context.request.operation;
  if (!CAPABILITY_ADMISSION_OPERATIONS.includes(operationValue as CapabilityAdmissionOperation)) {
    deny("session-capability");
  }
  const operation = operationValue as CapabilityAdmissionOperation;
  const issue = requestedIssue(request);
  if (context.task !== undefined && context.task.number !== issue) deny("task");

  const claim = capabilityForOperation(operation, effectiveCapabilities, allClaims, issue);
  const state = options.canonicalState;
  verifyCurrentAuthorityGeneration(state, runtime);
  const projection = resolveProjection(state).projection;
  const canonical = canonicalChange(projection, context.repository, issue);
  requireCanonicalOperationState(operation, canonical);

  optionalExact(request, "branch", canonical.branch);
  optionalExact(request, "head", canonical.branch);
  optionalExact(request, "base", canonical.baseBranch);
  if (hasOwn(request, "pullRequest")) {
    if (!validPullRequest(request.pullRequest) || canonical.pullRequest !== request.pullRequest)
      deny("canonical-state");
  }

  const requestsTreeWrite =
    operation === "branch.advance" || (operation === "change.implement" && hasOwn(request, "treeDelta"));
  const narrowingCapabilities = validateExplicitNarrowing(
    operation,
    effectiveCapabilities,
    canonical.branch,
    canonical.baseBranch,
    requestsTreeWrite,
  );

  if (operation === "branch.create") requiredExact(request, "branch", canonical.branch);
  if (operation === "pullRequest.create") {
    requiredExact(request, "head", canonical.branch);
    requiredExact(request, "base", canonical.baseBranch);
  }
  if (operation === "branch.advance" || (operation === "change.implement" && requestsTreeWrite)) {
    requiredExact(request, "branch", canonical.branch);
  }

  if (operation === "change.handoff") {
    const handoff = tryProjectImplementationHandoff(projection, {
      repositoryNameWithOwner: context.repository.nameWithOwner,
    });
    if (!handoff.valid) deny("canonical-state");
  }

  let write: CapabilityAdmissionWrite | undefined;
  if (requestsTreeWrite) {
    if (canonical.pullRequest === undefined) deny("canonical-state");
    if (!validBoundedText(request.expectedHead, MAX_BRANCH_HEAD_LENGTH)) deny("stale-evidence");
    const branchHead = projection.candidates.branches.find(
      (candidate) => candidate.classification === "canonical" && candidate.candidate.name === canonical.branch,
    )?.candidate.sha;
    if (!validBoundedText(branchHead, MAX_BRANCH_HEAD_LENGTH)) deny("stale-evidence");
    if (request.expectedHead !== branchHead) deny("stale-evidence");
    const treeDelta = writeTreeDelta(request, options.treeDelta);
    const writeCapability =
      claim.kind === "branch.advance"
        ? claim
        : narrowingCapabilities.find(
            (candidate): candidate is Extract<CapabilityClaim, { kind: "branch.advance" }> =>
              candidate.kind === "branch.advance",
          );
    const delegated = admitDelegatedWrite({ capability: writeCapability ?? claim, treeDelta });
    if (!delegated.allowed || delegated.treeDelta === undefined) deny("protected-path");
    const pathPolicy =
      writeCapability === undefined || writeCapability.kind !== "branch.advance"
        ? undefined
        : await admitPathPolicy(
            writeCapability,
            options.pathPolicyResolver,
            context.repository,
            runtime.provenance,
            delegated.treeDelta,
          );
    write = Object.freeze({
      branch: canonical.branch,
      expectedHead: request.expectedHead as string,
      treeDelta: delegated.treeDelta,
      ...(pathPolicy === undefined ? {} : { pathPolicy }),
    });
  }

  const lifecycle = lifecycleFor(operation, canonical);
  const result: AuthenticatedSessionCapabilityAdmission = {
    version: CAPABILITY_ADMISSION_CONTRACT_VERSION,
    operation,
    repository: Object.freeze({ ...context.repository }),
    runtimeAuthority: Object.freeze({ id: runtime.authority.id, kid: context.runtimeAuthority.kid }),
    session: Object.freeze({ ...context.session }),
    ...(context.task === undefined ? {} : { task: Object.freeze({ ...context.task }) }),
    issue,
    effectiveCapabilities: Object.freeze(effectiveCapabilities),
    capability: claim,
    narrowingCapabilities,
    authority: Object.freeze({ ref: runtime.provenance.ref, sha: runtime.provenance.policySha }),
    canonical: Object.freeze({
      status: canonical.status,
      issue: canonical.issue,
      state: canonical.state,
      branch: canonical.branch,
      baseBranch: canonical.baseBranch,
      ...(canonical.pullRequest === undefined ? {} : { pullRequest: canonical.pullRequest }),
    }),
    change: deepFreeze(canonical.change),
    ...(lifecycle === undefined ? {} : { lifecycle }),
    ...(write === undefined ? {} : { write }),
  };
  return Object.freeze(result);
}
