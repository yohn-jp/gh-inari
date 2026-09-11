/**
 * Golden Path recovery projection.
 *
 * This module is deliberately a read-only projection over the bounded
 * Change/Core execution contracts.  It does not plan or execute compensation,
 * does not inspect provider errors, and does not expose an adapter effect.
 */

import type { ChangeRecoveryPlan, ChangeProjectionResult, ChangeTransitionRecoveryPlan } from "./change.js";
import type { ChangeRemoteExecutionEvidence, ChangeRemoteExecutionResult } from "./change-executor.js";

export const GOLDEN_PATH_RECOVERY_CLASSES = Object.freeze([
  "ISSUANCE_PARTIAL_PROJECTION",
  "ISSUANCE_COMPENSATION_UNSAFE",
  "ABORT_CLEANUP_PENDING",
  "ABORT_CLEANUP_UNSAFE",
  "POST_EFFECT_VERIFICATION",
] as const);
export type GoldenPathRecoveryClass = (typeof GOLDEN_PATH_RECOVERY_CLASSES)[number];

export const GOLDEN_PATH_RECOVERY_ACTIONS = Object.freeze([
  "RETRY",
  "ABORT",
  "RECOVER",
  "MANUAL_REVIEW",
  "WAIT",
] as const);
export type GoldenPathRecoveryAction = (typeof GOLDEN_PATH_RECOVERY_ACTIONS)[number];

export const GOLDEN_PATH_RECOVERY_OWNERS = Object.freeze([
  "caller",
  "inari",
  "worker",
  "repository",
  "recovery",
] as const);
export type GoldenPathRecoveryOwner = (typeof GOLDEN_PATH_RECOVERY_OWNERS)[number];

export const GOLDEN_PATH_AUTOMATIC_CLEANUP_POLICIES = Object.freeze(["none", "conditional", "forbidden"] as const);
export type GoldenPathAutomaticCleanupPolicy = (typeof GOLDEN_PATH_AUTOMATIC_CLEANUP_POLICIES)[number];

/** Stable machine-readable reasons shared with the Golden Path status surface. */
export const GOLDEN_PATH_RECOVERY_REASON_CODES = Object.freeze([
  "PACKAGE_CAPABILITY_REQUIRED",
  "GOVERNANCE_DISCOVERY_REQUIRED",
  "GOVERNED_ISSUE_REQUIRED",
  "CHANGE_ISSUANCE_REQUIRED",
  "CHANGE_ISSUED",
  "READY_PRECONDITIONS_REQUIRED",
  "REVIEW_ADMITTED",
  "AUTHORITATIVE_REREAD_REQUIRED",
  "IDEMPOTENT_RETRY",
  "ABORT_CLEANUP_REQUIRED",
  "RECOVERY_ACTION_REQUIRED",
  "MANUAL_RECOVERY_REVIEW_REQUIRED",
  "WAIT_FOR_REPOSITORY_REVIEW",
] as const);
export type GoldenPathRecoveryReasonCode = (typeof GOLDEN_PATH_RECOVERY_REASON_CODES)[number];

/** The bounded recovery object embedded by the common status envelope. */
export interface GoldenPathRecovery {
  readonly class: GoldenPathRecoveryClass;
  readonly safeAction: GoldenPathRecoveryAction;
  readonly retryable: boolean;
  /** Recovery decisions always require a current authoritative read. */
  readonly rereadRequired: true;
  readonly automaticCleanup: GoldenPathAutomaticCleanupPolicy;
  readonly reasonCode: GoldenPathRecoveryReasonCode;
}

/** Explicit evidence that a fresh read has completed. */
export type GoldenPathAuthoritativeReread =
  | boolean
  | "complete"
  | "confirmed"
  | "performed"
  | "required"
  | "unavailable"
  | {
      readonly status: "complete" | "confirmed" | "performed" | "required" | "unavailable";
      readonly projection?: ChangeProjectionResult;
    };

/**
 * Input boundary for the projector.  Callers must provide normalized Core or
 * executor evidence; raw provider responses and exception objects are not
 * accepted by this contract.
 */
export interface GoldenPathRecoveryInput {
  readonly projection?: ChangeProjectionResult;
  readonly evidence?: ChangeRemoteExecutionEvidence;
  readonly recoveryPlan?: ChangeRecoveryPlan;
  /** Optional operation discriminator when only a Change projection is available. */
  readonly operation?: ChangeRemoteExecutionEvidence["operation"];
  readonly authoritativeReread?: GoldenPathAuthoritativeReread;
  /** Explicit proof supplied by the existing Change idempotency authority. */
  readonly idempotencyProof?: boolean | "proven" | "existing";
  /** Compatibility spelling for callers that already expose this proof. */
  readonly idempotent?: boolean;
}

export type GoldenPathRecoverySource =
  | GoldenPathRecoveryInput
  | ChangeRemoteExecutionResult
  | ChangeRemoteExecutionEvidence
  | ChangeRecoveryPlan
  | ChangeProjectionResult;

export interface GoldenPathRecoveryDiagnostic {
  readonly code: "INVALID_RECOVERY";
  readonly path: string;
  readonly message: string;
}

export interface GoldenPathRecoveryValidationResult {
  readonly valid: boolean;
  readonly recovery?: GoldenPathRecovery;
  readonly diagnostics: readonly GoldenPathRecoveryDiagnostic[];
}

const recoveryClasses = new Set<string>(GOLDEN_PATH_RECOVERY_CLASSES);
const recoveryActions = new Set<string>(GOLDEN_PATH_RECOVERY_ACTIONS);
const cleanupPolicies = new Set<string>(GOLDEN_PATH_AUTOMATIC_CLEANUP_POLICIES);
const reasonCodes = new Set<string>(GOLDEN_PATH_RECOVERY_REASON_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function sourceInput(source: GoldenPathRecoverySource): GoldenPathRecoveryInput {
  if (!isRecord(source)) return {};
  if (hasOwn(source, "projection") || hasOwn(source, "evidence") || hasOwn(source, "recoveryPlan")) {
    return source as GoldenPathRecoveryInput;
  }
  if (hasOwn(source, "outcome") && hasOwn(source, "effects")) {
    return { evidence: source as unknown as ChangeRemoteExecutionEvidence };
  }
  if (source.operation === "recover-issue" || source.operation === "recover-transition") {
    return { recoveryPlan: source as unknown as ChangeRecoveryPlan };
  }
  if (hasOwn(source, "status") && hasOwn(source, "candidates")) {
    return { projection: source as unknown as ChangeProjectionResult };
  }
  return {};
}

function projectionFor(input: GoldenPathRecoveryInput): ChangeProjectionResult | undefined {
  if (input.projection !== undefined) return input.projection;
  return input.recoveryPlan?.failureEvidence.projection;
}

function evidenceFor(input: GoldenPathRecoveryInput): ChangeRemoteExecutionEvidence | undefined {
  if (input.evidence !== undefined) return input.evidence;
  const plan = input.recoveryPlan;
  if (plan === undefined) return undefined;
  if (plan.operation === "recover-issue") {
    return {
      version: plan.version,
      operation: "issue",
      outcome: "recovery-required",
      effects: plan.failureEvidence.attemptedEffects.map((attempt) => ({
        kind: attempt.effect.kind,
        status: attempt.status,
        ...(attempt.evidence?.kind === "CREATE_BRANCH" ? { createdCommitSha: attempt.evidence.createdCommitSha } : {}),
      })),
      ...(plan.compensation.status === "succeeded" ? { compensation: "succeeded" as const } : {}),
      failure: {
        kind: plan.failureEvidence.failure.effect.kind,
        code: plan.failureEvidence.failure.code,
        message: plan.failureEvidence.failure.message,
      },
    };
  }
  const transition = plan.transition.request.transition;
  const operation = transition === "issue" || transition === "ready" || transition === "abort" ? transition : "ready";
  return {
    version: plan.version,
    operation,
    outcome: "recovery-required",
    effects: plan.failureEvidence.attemptedEffects.map((attempt) => ({
      kind: attempt.effect.kind,
      status: attempt.status,
      ...(attempt.evidence?.kind === "CREATE_BRANCH" ? { createdCommitSha: attempt.evidence.createdCommitSha } : {}),
    })),
    failure: {
      kind: plan.failureEvidence.failure.effect.kind,
      code: plan.failureEvidence.failure.code,
      message: plan.failureEvidence.failure.message,
    },
  };
}

function rereadProven(input: GoldenPathRecoveryInput): boolean {
  const reread = input.authoritativeReread;
  if (reread === true || reread === "complete" || reread === "confirmed" || reread === "performed") return true;
  return isRecord(reread) && ["complete", "confirmed", "performed"].includes(reread.status as string);
}

function idempotencyProven(
  input: GoldenPathRecoveryInput,
  evidence: ChangeRemoteExecutionEvidence | undefined,
): boolean {
  if (input.idempotencyProof === true || input.idempotencyProof === "proven" || input.idempotencyProof === "existing") {
    return true;
  }
  if (input.idempotent === true) return true;
  // `returned-existing` is itself the existing Core idempotency proof.  It is
  // never converted into a recovery result, but retaining this check makes
  // repeated issuance projection deterministic for composed callers.
  return evidence?.outcome === "returned-existing";
}

function recovery(
  className: GoldenPathRecoveryClass,
  safeAction: GoldenPathRecoveryAction,
  retryable: boolean,
  automaticCleanup: GoldenPathAutomaticCleanupPolicy,
  reasonCode: GoldenPathRecoveryReasonCode,
): GoldenPathRecovery {
  return Object.freeze({
    class: className,
    safeAction,
    retryable,
    rereadRequired: true,
    automaticCleanup,
    reasonCode,
  });
}

function canonicalBranchState(projection: ChangeProjectionResult): {
  readonly branchPresent: boolean;
  readonly branchUnambiguous: boolean;
  readonly branchAdvancedOrUnproven: boolean;
  readonly sha?: string;
} {
  const canonicalBranch = projection.canonicalBranch;
  if (canonicalBranch === undefined) {
    return { branchPresent: false, branchUnambiguous: false, branchAdvancedOrUnproven: true };
  }
  const candidates = projection.candidates.branches.filter((candidate) => candidate.candidate.name === canonicalBranch);
  const branchPresent = candidates.length > 0;
  const branchUnambiguous = candidates.length === 1 && candidates[0]?.classification === "canonical";
  const branchAdvancedOrUnproven = !branchUnambiguous || candidates[0]?.candidate.sha === undefined;
  return { branchPresent, branchUnambiguous, branchAdvancedOrUnproven, sha: candidates[0]?.candidate.sha };
}

function canonicalPullRequestState(projection: ChangeProjectionResult): {
  readonly present: boolean;
  readonly closedUnmerged: boolean;
  readonly merged: boolean;
  readonly open: boolean;
  readonly ambiguous: boolean;
} {
  const canonicalBranch = projection.canonicalBranch;
  const pullRequests = projection.candidates.pullRequests.filter((candidate) =>
    canonicalBranch === undefined ? false : candidate.candidate.head === canonicalBranch,
  );
  if (pullRequests.length === 0)
    return { present: false, closedUnmerged: false, merged: false, open: false, ambiguous: false };
  const canonical = pullRequests.filter((candidate) => candidate.classification === "canonical");
  if (canonical.length !== 1)
    return { present: true, closedUnmerged: false, merged: false, open: false, ambiguous: true };
  const candidate = canonical[0]!.candidate;
  return {
    present: true,
    closedUnmerged: candidate.state === "closed" && candidate.merged === false,
    merged: candidate.state === "closed" && candidate.merged === true,
    open: candidate.state === "open",
    ambiguous: false,
  };
}

function issuanceRecovery(
  input: GoldenPathRecoveryInput,
  projection: ChangeProjectionResult | undefined,
  evidence: ChangeRemoteExecutionEvidence,
): GoldenPathRecovery | null {
  const plan = input.recoveryPlan;
  if (
    evidence.compensation === "succeeded" ||
    (plan?.operation === "recover-issue" && plan.compensation.status === "succeeded")
  ) {
    // A verified compensation is not a recovery-required result.
    return null;
  }

  const branch = projection === undefined ? undefined : canonicalBranchState(projection);
  const pullRequest = projection === undefined ? undefined : canonicalPullRequestState(projection);
  const unavailable =
    projection === undefined || projection.status === "unavailable" || projection.status === "ambiguous";
  const expectedCompensationSha =
    plan?.operation === "recover-issue"
      ? plan.compensation.plan.effects.find((effect) => effect.kind === "DELETE_BRANCH")?.expectedCommitSha
      : evidence.effects.find((effect) => effect.kind === "CREATE_BRANCH")?.createdCommitSha;
  const branchCleanupProven =
    branch !== undefined &&
    branch.branchPresent &&
    branch.branchUnambiguous &&
    !branch.branchAdvancedOrUnproven &&
    pullRequest !== undefined &&
    !pullRequest.present &&
    expectedCompensationSha !== undefined &&
    branch.sha === expectedCompensationSha;

  if (
    evidence.compensation === "failed" ||
    (plan?.operation === "recover-issue" && plan.compensation.status === "failed")
  ) {
    return recovery(
      "ISSUANCE_COMPENSATION_UNSAFE",
      "MANUAL_REVIEW",
      false,
      "forbidden",
      "MANUAL_RECOVERY_REVIEW_REQUIRED",
    );
  }
  if (unavailable) {
    return recovery("ISSUANCE_PARTIAL_PROJECTION", "WAIT", false, "forbidden", "AUTHORITATIVE_REREAD_REQUIRED");
  }
  if (branchCleanupProven) {
    return recovery("ISSUANCE_PARTIAL_PROJECTION", "RECOVER", false, "conditional", "RECOVERY_ACTION_REQUIRED");
  }
  return recovery(
    "ISSUANCE_COMPENSATION_UNSAFE",
    "MANUAL_REVIEW",
    false,
    "forbidden",
    "MANUAL_RECOVERY_REVIEW_REQUIRED",
  );
}

function abortRecovery(
  input: GoldenPathRecoveryInput,
  projection: ChangeProjectionResult | undefined,
  evidence: ChangeRemoteExecutionEvidence,
): GoldenPathRecovery {
  const reread = rereadProven(input);
  if (projection === undefined || projection.status === "unavailable") {
    return recovery("ABORT_CLEANUP_UNSAFE", "WAIT", false, "forbidden", "AUTHORITATIVE_REREAD_REQUIRED");
  }
  const branch = canonicalBranchState(projection);
  const pullRequest = canonicalPullRequestState(projection);
  if (
    projection.status === "ambiguous" ||
    !branch.branchUnambiguous ||
    pullRequest.ambiguous ||
    !branch.branchPresent
  ) {
    return recovery("ABORT_CLEANUP_UNSAFE", "MANUAL_REVIEW", false, "forbidden", "MANUAL_RECOVERY_REVIEW_REQUIRED");
  }
  if (pullRequest.merged || (pullRequest.present && !pullRequest.open && !pullRequest.closedUnmerged)) {
    return recovery("ABORT_CLEANUP_UNSAFE", "MANUAL_REVIEW", false, "forbidden", "MANUAL_RECOVERY_REVIEW_REQUIRED");
  }
  if (pullRequest.closedUnmerged) {
    return recovery("ABORT_CLEANUP_PENDING", "RECOVER", false, "conditional", "ABORT_CLEANUP_REQUIRED");
  }
  if (pullRequest.present && !pullRequest.closedUnmerged) {
    // A failed close can be retried only through the existing abort transition.
    if (reread && idempotencyProven(input, evidence)) {
      return recovery("ABORT_CLEANUP_PENDING", "ABORT", true, "conditional", "IDEMPOTENT_RETRY");
    }
    return recovery("ABORT_CLEANUP_PENDING", "ABORT", false, "conditional", "ABORT_CLEANUP_REQUIRED");
  }
  return recovery("ABORT_CLEANUP_UNSAFE", "MANUAL_REVIEW", false, "forbidden", "MANUAL_RECOVERY_REVIEW_REQUIRED");
}

function postEffectRecovery(
  input: GoldenPathRecoveryInput,
  evidence: ChangeRemoteExecutionEvidence,
): GoldenPathRecovery {
  const projection = projectionFor(input);
  const unavailable =
    projection === undefined || projection.status === "unavailable" || projection.status === "ambiguous";
  if (unavailable) {
    return recovery("POST_EFFECT_VERIFICATION", "WAIT", false, "forbidden", "AUTHORITATIVE_REREAD_REQUIRED");
  }
  if (rereadProven(input) && idempotencyProven(input, evidence)) {
    return recovery("POST_EFFECT_VERIFICATION", "RETRY", true, "none", "IDEMPOTENT_RETRY");
  }
  return recovery("POST_EFFECT_VERIFICATION", "MANUAL_REVIEW", false, "forbidden", "MANUAL_RECOVERY_REVIEW_REQUIRED");
}

/**
 * Project one bounded recovery decision.  `null` means no recovery evidence
 * is active; in particular, generic `failed` evidence is never classified as
 * recovery merely from its outcome.
 */
export function projectGoldenPathRecovery(source: GoldenPathRecoverySource): GoldenPathRecovery | null {
  const input = sourceInput(source);
  const evidence =
    evidenceFor(input) ??
    (input.operation === undefined
      ? undefined
      : {
          version: 1 as const,
          operation: input.operation,
          outcome: "recovery-required" as const,
          effects: [],
        });
  const projection = projectionFor(input);
  const plan = input.recoveryPlan;
  const active =
    evidence?.outcome === "recovery-required" ||
    projection?.change?.state === "RECOVERY_REQUIRED" ||
    plan !== undefined;
  if (!active || evidence === undefined) return null;

  if (evidence.operation === "issue" || plan?.operation === "recover-issue") {
    return issuanceRecovery(input, projection, evidence);
  }
  if (
    evidence.operation === "abort" ||
    (plan?.operation === "recover-transition" && plan.transition.request.transition === "abort")
  ) {
    return abortRecovery(input, projection, evidence);
  }
  return postEffectRecovery(input, evidence);
}

export const classifyGoldenPathRecovery = projectGoldenPathRecovery;
export const deriveGoldenPathRecovery = projectGoldenPathRecovery;
export const createGoldenPathRecovery = projectGoldenPathRecovery;

/** Validate a recovery object at the #409 composition boundary. */
export function validateGoldenPathRecovery(input: unknown): GoldenPathRecoveryValidationResult {
  const diagnostics: GoldenPathRecoveryDiagnostic[] = [];
  if (!isRecord(input)) {
    diagnostics.push({ code: "INVALID_RECOVERY", path: "$", message: "Recovery must be an object." });
    return { valid: false, diagnostics };
  }
  if (!recoveryClasses.has(input.class as string)) {
    diagnostics.push({ code: "INVALID_RECOVERY", path: "$.class", message: "Recovery class is unsupported." });
  }
  if (!recoveryActions.has(input.safeAction as string)) {
    diagnostics.push({ code: "INVALID_RECOVERY", path: "$.safeAction", message: "Recovery action is unsupported." });
  }
  if (typeof input.retryable !== "boolean") {
    diagnostics.push({
      code: "INVALID_RECOVERY",
      path: "$.retryable",
      message: "Recovery retryability must be boolean.",
    });
  }
  if (input.rereadRequired !== true) {
    diagnostics.push({ code: "INVALID_RECOVERY", path: "$.rereadRequired", message: "Recovery must require reread." });
  }
  if (!cleanupPolicies.has(input.automaticCleanup as string)) {
    diagnostics.push({
      code: "INVALID_RECOVERY",
      path: "$.automaticCleanup",
      message: "Automatic cleanup policy is unsupported.",
    });
  }
  if (!reasonCodes.has(input.reasonCode as string)) {
    diagnostics.push({
      code: "INVALID_RECOVERY",
      path: "$.reasonCode",
      message: "Recovery reason code is unsupported.",
    });
  }
  if (diagnostics.length > 0) return { valid: false, diagnostics };
  const recoveryValue: GoldenPathRecovery = {
    class: input.class as GoldenPathRecoveryClass,
    safeAction: input.safeAction as GoldenPathRecoveryAction,
    retryable: input.retryable as boolean,
    rereadRequired: true,
    automaticCleanup: input.automaticCleanup as GoldenPathAutomaticCleanupPolicy,
    reasonCode: input.reasonCode as GoldenPathRecoveryReasonCode,
  };
  return { valid: true, recovery: Object.freeze(recoveryValue), diagnostics: [] };
}

export function isGoldenPathRecovery(input: unknown): input is GoldenPathRecovery {
  return validateGoldenPathRecovery(input).valid;
}

export function assertGoldenPathRecovery(input: unknown): asserts input is GoldenPathRecovery {
  const result = validateGoldenPathRecovery(input);
  if (!result.valid) throw new TypeError(result.diagnostics.map((diagnostic) => diagnostic.message).join(" "));
}

export function serializeGoldenPathRecovery(input: unknown): string {
  const result = validateGoldenPathRecovery(input);
  if (!result.valid || result.recovery === undefined) throw new TypeError("Invalid Golden Path recovery.");
  return JSON.stringify(result.recovery);
}

export function deserializeGoldenPathRecovery(serialized: string): GoldenPathRecovery {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new TypeError("Golden Path recovery must be valid JSON.");
  }
  const result = validateGoldenPathRecovery(parsed);
  if (!result.valid || result.recovery === undefined) throw new TypeError("Invalid Golden Path recovery.");
  return result.recovery;
}

export type { ChangeRemoteExecutionEvidence, ChangeRemoteExecutionResult, ChangeTransitionRecoveryPlan };
