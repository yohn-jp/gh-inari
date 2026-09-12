/**
 * Semantic capability admission between #374 Session authentication and the
 * existing Change/Core execution authorities.
 *
 * This boundary consumes the exact AuthenticatedSessionContext produced by
 * #374. Runtime trust, certificate validity, repository binding, TTL, and the
 * Runtime capability ceiling are intentionally not read or evaluated here.
 * They are already part of that context's proof. This module only attenuates
 * the authenticated claims against the supplied Core projection and the #370
 * protected-path classifier; it performs no provider I/O or mutation.
 */

import {
  CHANGE_TRANSITION_CONTRACT_VERSION,
  planChangeTransition,
  validateChangeProjectionResult,
  type Change,
  type ChangeState,
  type ChangeProjectionResult,
} from "../change.js";
import {
  CAPABILITY_CREATE_MAX,
  MAX_ISSUE_NUMBER,
  validateCapabilityClaim,
  type CapabilityClaim,
} from "./capability.js";
import { admitDelegatedWrite, PROTECTED_PATH_CLASSIFIER_VERSION, type DelegatedTreeDelta } from "./protected-paths.js";
import type { AuthenticatedSessionContext } from "./session-authentication.js";
import type { SessionCertificateTask } from "./session-certificate.js";
import { validateIssuerRepositoryIdentity, type IssuerRepositoryIdentity } from "../github/issuer-authority.js";

export const CAPABILITY_ADMISSION_CONTRACT_VERSION = 1 as const;

export type CapabilityAdmissionOperation =
  | "change.issue"
  | "change.show"
  | "change.ready"
  | "change.abort"
  | "branch.create"
  | "branch.advance"
  | "pullRequest.create";

const CAPABILITY_ADMISSION_OPERATIONS = Object.freeze([
  "change.issue",
  "change.show",
  "change.ready",
  "change.abort",
  "branch.create",
  "branch.advance",
  "pullRequest.create",
] as const satisfies readonly CapabilityAdmissionOperation[]);

export type CapabilityAdmissionSubject =
  | { readonly kind: "change"; readonly issue: number }
  | { readonly kind: "branch"; readonly issue: number; readonly branch: string }
  | {
      readonly kind: "pullRequest";
      readonly issue: number;
      readonly head: string;
      readonly base: string;
    };

export interface CapabilityAdmissionRequest {
  readonly context: AuthenticatedSessionContext;
  readonly operation: CapabilityAdmissionOperation;
  readonly subject: CapabilityAdmissionSubject;
  readonly projection: ChangeProjectionResult;
  readonly treeDelta?: DelegatedTreeDelta;
}

export interface AdmittedSessionCapability {
  readonly version: 1;
  readonly operation: CapabilityAdmissionOperation;
  readonly repository: IssuerRepositoryIdentity;
  readonly runtimeAuthority: Readonly<{ id: string; kid: string }>;
  readonly session: Readonly<{ id: string; certificateJti: string }>;
  readonly authority: Readonly<{ ref: string; sha: string }>;
  readonly request: Readonly<{
    requestId: string;
    operation: string;
    issuedAt: number;
    expiresAt: number;
  }>;
  readonly task?: SessionCertificateTask;
  readonly capability: CapabilityClaim;
  readonly subject: CapabilityAdmissionSubject;
  readonly canonical: Readonly<{
    state?: ChangeState;
    branch?: string;
    pullRequest?: number;
  }>;
  readonly protectedPathClassifierVersion: 1;
}

export type CapabilityAdmissionFailureReason =
  | "operation"
  | "repository"
  | "task"
  | "session-capability"
  | "canonical-state"
  | "canonical-identity"
  | "protected-path"
  | "path-policy"
  | "stale-evidence";

const CAPABILITY_ADMISSION_FAILURE_REASONS = Object.freeze([
  "operation",
  "repository",
  "task",
  "session-capability",
  "canonical-state",
  "canonical-identity",
  "protected-path",
  "path-policy",
  "stale-evidence",
] as const satisfies readonly CapabilityAdmissionFailureReason[]);

export class CapabilityAdmissionError extends Error {
  readonly code = "CAPABILITY_ADMISSION_DENIED" as const;
  readonly reason: CapabilityAdmissionFailureReason;

  constructor(reason: CapabilityAdmissionFailureReason) {
    if (!CAPABILITY_ADMISSION_FAILURE_REASONS.includes(reason)) {
      throw new TypeError("Unsupported capability admission failure reason.");
    }
    super("Capability admission denied.");
    this.name = "CapabilityAdmissionError";
    this.reason = reason;
  }
}

const MAX_CONTEXT_TEXT_LENGTH = 1_024;
const MAX_CONTEXT_SHA_LENGTH = 128;
const SAFE_CONTEXT_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const CAPABILITY_ADMISSION_REQUEST_KEYS = new Set(["context", "operation", "subject", "projection", "treeDelta"]);

function deny(reason: CapabilityAdmissionFailureReason): never {
  throw new CapabilityAdmissionError(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function boundedText(value: unknown, maximum = MAX_CONTEXT_TEXT_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && SAFE_CONTEXT_TEXT.test(value);
}

function safeIssue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_ISSUE_NUMBER;
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sameRepository(
  left: { readonly repositoryHost: string; readonly repositoryId: string },
  right: IssuerRepositoryIdentity,
): boolean {
  return (
    left.repositoryHost.toLowerCase() === right.repositoryHost.toLowerCase() && left.repositoryId === right.repositoryId
  );
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
  return false;
}

function validateContext(
  context: unknown,
  operation: CapabilityAdmissionOperation,
): {
  readonly context: AuthenticatedSessionContext;
  readonly repository: IssuerRepositoryIdentity;
  readonly claims: readonly CapabilityClaim[];
} {
  if (!isRecord(context)) deny("session-capability");

  const repositoryResult = validateIssuerRepositoryIdentity(context.repository);
  if (!repositoryResult.valid || repositoryResult.value === undefined) deny("repository");

  if (!isRecord(context.runtimeAuthority)) deny("session-capability");
  if (!boundedText(context.runtimeAuthority.id) || !boundedText(context.runtimeAuthority.kid)) {
    deny("session-capability");
  }

  if (!isRecord(context.session)) deny("session-capability");
  if (!boundedText(context.session.id) || !boundedText(context.session.certificateJti)) {
    deny("session-capability");
  }

  if (!isRecord(context.authority)) deny("session-capability");
  if (!boundedText(context.authority.ref) || !boundedText(context.authority.sha, MAX_CONTEXT_SHA_LENGTH)) {
    deny("session-capability");
  }

  if (!isRecord(context.request)) deny("session-capability");
  if (
    !boundedText(context.request.requestId) ||
    !boundedText(context.request.operation) ||
    !safeTimestamp(context.request.issuedAt) ||
    !safeTimestamp(context.request.expiresAt) ||
    context.request.expiresAt <= context.request.issuedAt
  ) {
    deny("session-capability");
  }
  if (context.request.operation !== operation) deny("operation");

  if (!isRecord(context.verifiedRequest) || !isRecord(context.verifiedRequest.envelope)) {
    deny("session-capability");
  }
  const envelope = context.verifiedRequest.envelope;
  if (
    envelope.operation !== context.request.operation ||
    envelope.requestId !== context.request.requestId ||
    envelope.issuedAt !== context.request.issuedAt ||
    envelope.expiresAt !== context.request.expiresAt ||
    envelope.repositoryId !== repositoryResult.value.repositoryId
  ) {
    deny("session-capability");
  }

  if (!Array.isArray(context.capabilities) || context.capabilities.length === 0) {
    deny("session-capability");
  }
  const claims: CapabilityClaim[] = [];
  for (const [index, rawClaim] of context.capabilities.entries()) {
    const result = validateCapabilityClaim(rawClaim, `$.context.capabilities[${index}]`);
    if (!result.valid || result.value === undefined) deny("session-capability");
    if (claims.some((claim) => sameClaim(claim, result.value as CapabilityClaim))) deny("session-capability");
    claims.push(result.value);
  }

  if (context.task !== undefined) {
    if (!isRecord(context.task) || context.task.kind !== "issue" || !safeIssue(context.task.number)) {
      deny("task");
    }
  }

  return {
    context: context as unknown as AuthenticatedSessionContext,
    repository: repositoryResult.value,
    claims,
  };
}

function validateSubject(input: unknown): CapabilityAdmissionSubject {
  if (!isRecord(input) || typeof input.kind !== "string") deny("canonical-identity");

  if (input.kind === "change") {
    if (Object.keys(input).some((key) => key !== "kind" && key !== "issue") || !safeIssue(input.issue)) {
      deny("canonical-identity");
    }
    return Object.freeze({ kind: "change", issue: input.issue });
  }

  if (input.kind === "branch") {
    if (
      Object.keys(input).some((key) => !["kind", "issue", "branch"].includes(key)) ||
      !safeIssue(input.issue) ||
      !boundedText(input.branch)
    ) {
      deny("canonical-identity");
    }
    const result = validateCapabilityClaim({ kind: "branch.advance", branch: input.branch });
    if (!result.valid || result.value === undefined) deny("canonical-identity");
    return Object.freeze({ kind: "branch", issue: input.issue, branch: input.branch });
  }

  if (input.kind === "pullRequest") {
    if (
      Object.keys(input).some((key) => !["kind", "issue", "head", "base"].includes(key)) ||
      !safeIssue(input.issue) ||
      !boundedText(input.head) ||
      !boundedText(input.base)
    ) {
      deny("canonical-identity");
    }
    const result = validateCapabilityClaim({
      kind: "pullRequest.create",
      head: input.head,
      base: input.base,
      max: CAPABILITY_CREATE_MAX,
    });
    if (!result.valid || result.value === undefined) deny("canonical-identity");
    return Object.freeze({ kind: "pullRequest", issue: input.issue, head: input.head, base: input.base });
  }

  deny("canonical-identity");
}

function canonicalPullRequestCandidates(projection: ChangeProjectionResult, branch: string, base: string) {
  return projection.candidates.pullRequests.filter(
    (candidate) =>
      candidate.classification === "canonical" &&
      candidate.candidate.head === branch &&
      candidate.candidate.base === base,
  );
}

function canonicalBranchCandidates(projection: ChangeProjectionResult, branch: string) {
  return projection.candidates.branches.filter(
    (candidate) => candidate.classification === "canonical" && candidate.candidate.name === branch,
  );
}

function projectedState(
  candidate: ChangeProjectionResult["candidates"]["pullRequests"][number]["candidate"],
): Change["state"] {
  if (candidate.state === "closed") return candidate.merged ? "MERGED" : "ABORTED";
  if (candidate.draft) return "DRAFT";
  if (candidate.accepted === true) return "ACCEPTED";
  return "REVIEW";
}

interface CanonicalProjection {
  readonly projection: ChangeProjectionResult;
  readonly change: Change;
  readonly branch: string;
  readonly base: string;
  readonly pullRequest?: number;
}

function canonicalProjection(input: unknown, repository: IssuerRepositoryIdentity, issue: number): CanonicalProjection {
  const result = validateChangeProjectionResult(input);
  if (!result.valid || result.projection === undefined) deny("stale-evidence");
  const projection = result.projection;

  if (projection.status === "unavailable") deny("stale-evidence");
  if (projection.canonicalBranch === undefined || projection.canonicalBaseBranch === undefined) {
    deny("stale-evidence");
  }
  if (projection.change === undefined) deny("stale-evidence");

  const change = projection.change;
  if (!sameRepository(change.identity, repository)) deny("repository");
  if (change.identity.rootIssue !== issue) deny("task");
  if (!boundedText(projection.canonicalBranch) || projection.canonicalBranch === "main") {
    deny("canonical-identity");
  }
  if (!boundedText(projection.canonicalBaseBranch)) deny("canonical-identity");

  const branch = projection.canonicalBranch;
  const base = projection.canonicalBaseBranch;
  const branches = canonicalBranchCandidates(projection, branch);
  const pullRequests = canonicalPullRequestCandidates(projection, branch, base);
  if (
    projection.candidates.branches.some((candidate) => candidate.classification === "conflicting") ||
    projection.candidates.pullRequests.some((candidate) => candidate.classification === "conflicting")
  ) {
    deny("canonical-state");
  }
  if (
    branches.some(
      (candidate) => candidate.candidate.rootIssue !== undefined && candidate.candidate.rootIssue !== issue,
    ) ||
    pullRequests.some(
      (candidate) =>
        candidate.candidate.number === issue ||
        (candidate.candidate.rootIssue !== undefined && candidate.candidate.rootIssue !== issue),
    )
  ) {
    deny("canonical-identity");
  }

  if (projection.status === "absent") {
    if (
      !projection.valid ||
      projection.diagnostics.length > 0 ||
      change.state !== "DEFINED" ||
      change.projection !== undefined ||
      branches.length !== 0 ||
      pullRequests.length !== 0
    ) {
      deny("canonical-state");
    }
    return { projection, change, branch, base };
  }

  if (projection.status === "healthy") {
    if (!projection.valid || projection.diagnostics.length > 0 || pullRequests.length !== 1) {
      deny("canonical-state");
    }
    const pullRequest = pullRequests[0]?.candidate;
    if (
      pullRequest === undefined ||
      change.projection?.branch !== branch ||
      change.projection?.pullRequest !== pullRequest.number ||
      projectedState(pullRequest) !== change.state
    ) {
      deny("canonical-identity");
    }
    if (branches.length > 1 || (change.state !== "ABORTED" && branches.length !== 1)) deny("canonical-state");
    return { projection, change, branch, base, pullRequest: pullRequest.number };
  }

  if (projection.status === "partial") {
    if (projection.valid || projection.diagnostics.length === 0 || change.state !== "RECOVERY_REQUIRED") {
      deny("canonical-state");
    }
    if (branches.length > 1 || pullRequests.length > 1 || change.projection?.branch !== branch) {
      deny("canonical-state");
    }
    const pullRequest = pullRequests[0]?.candidate;
    if (pullRequest === undefined && change.projection?.pullRequest !== undefined) deny("canonical-identity");
    if (pullRequest !== undefined) {
      if (change.projection?.pullRequest !== pullRequest.number) deny("canonical-identity");
    }
    if (branches.length === 0 && pullRequest === undefined) deny("canonical-state");
    return {
      projection,
      change,
      branch,
      base,
      ...(pullRequest === undefined ? {} : { pullRequest: pullRequest.number }),
    };
  }

  // duplicate, wrong-base, and ambiguous projections are known canonical
  // conflicts. They must not be converted into a guessed Change identity.
  deny("canonical-state");
}

function claimForOperation(
  operation: CapabilityAdmissionOperation,
  subject: CapabilityAdmissionSubject,
  claims: readonly CapabilityClaim[],
): CapabilityClaim {
  const issue = subject.issue;
  const changeClaim = (kind: "change.implement" | "change.ready" | "change.abort"): CapabilityClaim | undefined =>
    claims.find((claim) => claim.kind === kind && claim.issue === issue);

  if (operation === "change.issue" || operation === "change.show") {
    const claim = changeClaim("change.implement");
    if (claim !== undefined) return claim;
    if (claims.some((claim) => claim.kind === "change.implement")) deny("task");
    deny("session-capability");
  }
  if (operation === "change.ready") {
    const claim = changeClaim("change.ready");
    if (claim !== undefined) return claim;
    if (claims.some((claim) => claim.kind === "change.ready")) deny("task");
    deny("session-capability");
  }
  if (operation === "change.abort") {
    const claim = changeClaim("change.abort");
    if (claim !== undefined) return claim;
    if (claims.some((claim) => claim.kind === "change.abort")) deny("task");
    deny("session-capability");
  }

  if (subject.kind === "branch") {
    if (operation === "branch.create") {
      const lower = claims.find(
        (claim): claim is Extract<CapabilityClaim, { kind: "branch.create" }> =>
          claim.kind === "branch.create" && claim.branch === subject.branch && claim.max === CAPABILITY_CREATE_MAX,
      );
      if (lower !== undefined) return lower;
      if (claims.some((claim) => claim.kind === "branch.create")) deny("canonical-identity");
    }
    if (operation === "branch.advance") {
      const lower = claims.find(
        (claim): claim is Extract<CapabilityClaim, { kind: "branch.advance" }> =>
          claim.kind === "branch.advance" && claim.branch === subject.branch,
      );
      if (lower !== undefined) return lower;
      if (claims.some((claim) => claim.kind === "branch.advance")) deny("canonical-identity");
    }
    const implement = changeClaim("change.implement");
    if (implement !== undefined) return implement;
    if (claims.some((claim) => claim.kind === "change.implement")) deny("task");
  }

  if (subject.kind === "pullRequest" && operation === "pullRequest.create") {
    const lower = claims.find(
      (claim): claim is Extract<CapabilityClaim, { kind: "pullRequest.create" }> =>
        claim.kind === "pullRequest.create" &&
        claim.head === subject.head &&
        claim.base === subject.base &&
        claim.max === CAPABILITY_CREATE_MAX,
    );
    if (lower !== undefined) return lower;
    if (claims.some((claim) => claim.kind === "pullRequest.create")) deny("canonical-identity");
    const implement = changeClaim("change.implement");
    if (implement !== undefined) return implement;
    if (claims.some((claim) => claim.kind === "change.implement")) deny("task");
  }

  deny("canonical-identity");
}

function requireSubjectShape(operation: CapabilityAdmissionOperation, subject: CapabilityAdmissionSubject): void {
  if (
    (operation === "change.issue" ||
      operation === "change.show" ||
      operation === "change.ready" ||
      operation === "change.abort") &&
    subject.kind !== "change"
  ) {
    deny("canonical-identity");
  }
  if ((operation === "branch.create" || operation === "branch.advance") && subject.kind !== "branch") {
    deny("canonical-identity");
  }
  if (operation === "pullRequest.create" && subject.kind !== "pullRequest") deny("canonical-identity");
}

function requireCanonicalState(operation: CapabilityAdmissionOperation, canonical: CanonicalProjection): void {
  const { projection, change, pullRequest } = canonical;
  switch (operation) {
    case "change.issue":
      if (projection.status !== "absent" && projection.status !== "healthy") deny("canonical-state");
      if (projection.status === "absent") {
        try {
          planChangeTransition({
            version: CHANGE_TRANSITION_CONTRACT_VERSION,
            transition: "issue",
            change,
            target: { branch: canonical.branch, baseBranch: canonical.base },
          });
        } catch {
          deny("canonical-state");
        }
      }
      return;
    case "change.show":
      if (projection.status !== "absent" && projection.status !== "healthy") deny("canonical-state");
      return;
    case "change.ready":
      if (projection.status !== "healthy" || pullRequest === undefined) deny("canonical-state");
      try {
        planChangeTransition({
          version: CHANGE_TRANSITION_CONTRACT_VERSION,
          transition: "ready",
          change,
          target: { branch: canonical.branch, pullRequest },
        });
      } catch {
        deny("canonical-state");
      }
      return;
    case "change.abort":
      if (projection.status !== "healthy" && projection.status !== "partial") deny("canonical-state");
      if (pullRequest === undefined) deny("canonical-state");
      if (projection.status === "partial" && !canonicalAbortRecovery(canonical)) deny("canonical-state");
      try {
        planChangeTransition({
          version: CHANGE_TRANSITION_CONTRACT_VERSION,
          transition: "abort",
          change,
          target: { branch: canonical.branch, pullRequest },
        });
      } catch {
        deny("canonical-state");
      }
      return;
    case "branch.create":
      if (
        projection.status !== "absent" &&
        !(
          projection.status === "healthy" &&
          canonical.projection.candidates.branches.filter(
            (candidate) => candidate.classification === "canonical" && candidate.candidate.name === canonical.branch,
          ).length === 1
        ) &&
        !(projection.status === "partial" && canonicalBranchOnly(canonical))
      ) {
        deny("canonical-state");
      }
      return;
    case "branch.advance":
      if (projection.status !== "healthy" || change.state !== "DRAFT" || pullRequest === undefined) {
        deny("canonical-state");
      }
      return;
    case "pullRequest.create":
      if (projection.status !== "healthy" && !(projection.status === "partial" && canonicalBranchOnly(canonical))) {
        deny("canonical-state");
      }
      return;
  }
}

function canonicalBranchOnly(canonical: CanonicalProjection): boolean {
  return (
    canonical.projection.candidates.branches.filter(
      (candidate) => candidate.classification === "canonical" && candidate.candidate.name === canonical.branch,
    ).length === 1 && canonical.pullRequest === undefined
  );
}

function canonicalAbortRecovery(canonical: CanonicalProjection): boolean {
  const branches = canonical.projection.candidates.branches.filter(
    (candidate) => candidate.classification === "canonical" && candidate.candidate.name === canonical.branch,
  );
  const pullRequests = canonical.projection.candidates.pullRequests.filter(
    (candidate) =>
      candidate.classification === "canonical" &&
      candidate.candidate.head === canonical.branch &&
      candidate.candidate.base === canonical.base,
  );
  return (
    branches.length === 1 &&
    pullRequests.length === 1 &&
    pullRequests[0]?.candidate.state === "closed" &&
    pullRequests[0].candidate.merged === false
  );
}

function admitTreeDelta(
  operation: CapabilityAdmissionOperation,
  subject: CapabilityAdmissionSubject,
  capability: CapabilityClaim,
  treeDelta: DelegatedTreeDelta | undefined,
): void {
  if (operation !== "branch.advance") {
    if (treeDelta !== undefined) deny("operation");
    return;
  }
  if (treeDelta === undefined) deny("protected-path");
  const admission = admitDelegatedWrite({ capability, treeDelta });
  if (!admission.allowed) deny("protected-path");
  if (capability.kind === "branch.advance" && capability.pathPolicy !== undefined) {
    // The frozen #375 seam has no policy resolver. A named policy therefore
    // cannot be resolved by a canonical authority in this leaf. Treating it
    // as an unrestricted pattern would create a second policy authority.
    deny("path-policy");
  }
  if (subject.kind !== "branch") deny("canonical-identity");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
  } else {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  }
  return Object.freeze(value);
}

/**
 * Admit one already-authenticated semantic request. This function is pure
 * with respect to GitHub: it only validates bounded values and invokes the
 * existing pure Core/#370 authorities.
 */
export function admitAuthenticatedSessionCapability(input: CapabilityAdmissionRequest): AdmittedSessionCapability {
  if (!isRecord(input)) deny("session-capability");
  if (Object.keys(input).some((key) => !CAPABILITY_ADMISSION_REQUEST_KEYS.has(key))) {
    deny("session-capability");
  }
  if (
    typeof input.operation !== "string" ||
    !CAPABILITY_ADMISSION_OPERATIONS.includes(input.operation as CapabilityAdmissionOperation)
  ) {
    deny("operation");
  }
  const operation = input.operation as CapabilityAdmissionOperation;
  const subject = validateSubject(input.subject);
  requireSubjectShape(operation, subject);

  const validatedContext = validateContext(input.context, operation);
  if (validatedContext.context.task !== undefined && validatedContext.context.task.number !== subject.issue) {
    deny("task");
  }
  const canonical = canonicalProjection(input.projection, validatedContext.repository, subject.issue);
  if (subject.kind === "branch" && subject.branch !== canonical.branch) deny("canonical-identity");
  if (subject.kind === "pullRequest" && (subject.head !== canonical.branch || subject.base !== canonical.base)) {
    deny("canonical-identity");
  }

  const capability = claimForOperation(operation, subject, validatedContext.claims);
  requireCanonicalState(operation, canonical);
  admitTreeDelta(operation, subject, capability, input.treeDelta);

  const result: AdmittedSessionCapability = {
    version: CAPABILITY_ADMISSION_CONTRACT_VERSION,
    operation,
    repository: Object.freeze({ ...validatedContext.repository }),
    runtimeAuthority: Object.freeze({
      id: validatedContext.context.runtimeAuthority.id,
      kid: validatedContext.context.runtimeAuthority.kid,
    }),
    session: Object.freeze({
      id: validatedContext.context.session.id,
      certificateJti: validatedContext.context.session.certificateJti,
    }),
    authority: Object.freeze({
      ref: validatedContext.context.authority.ref,
      sha: validatedContext.context.authority.sha,
    }),
    request: Object.freeze({
      requestId: validatedContext.context.request.requestId,
      operation: validatedContext.context.request.operation,
      issuedAt: validatedContext.context.request.issuedAt,
      expiresAt: validatedContext.context.request.expiresAt,
    }),
    ...(validatedContext.context.task === undefined
      ? {}
      : { task: Object.freeze({ ...validatedContext.context.task }) }),
    capability: Object.freeze({ ...capability }),
    subject,
    canonical: Object.freeze({
      state: canonical.change.state,
      branch: canonical.branch,
      ...(canonical.pullRequest === undefined ? {} : { pullRequest: canonical.pullRequest }),
    }),
    protectedPathClassifierVersion: PROTECTED_PATH_CLASSIFIER_VERSION,
  };
  return deepFreeze(result);
}
