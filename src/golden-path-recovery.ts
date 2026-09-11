/**
 * Golden Path recovery projection.
 *
 * This module is deliberately a read-only projection over the bounded
 * Change/Core execution contracts.  It does not plan or execute compensation,
 * does not inspect provider errors, and does not expose an adapter effect.
 */

import {
  validateChangeIssuanceRecoveryPlan,
  validateChangeTransitionRecoveryPlan,
  type ChangeRecoveryPlan,
  type ChangeProjectionResult,
  type ChangeTransitionRecoveryPlan,
} from "./change.js";
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
  readonly owner: "recovery";
  readonly retryable: boolean;
  /** Recovery decisions always require a current authoritative read. */
  readonly rereadRequired: true;
  readonly automaticCleanup: GoldenPathAutomaticCleanupPolicy;
  readonly reasonCode: GoldenPathRecoveryReasonCode;
}

/** Explicit bounded evidence that a fresh authoritative read has completed. */
export interface GoldenPathAuthoritativeReread {
  readonly status: "complete";
  readonly projection: ChangeProjectionResult;
}

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

const ADMISSIBLE_RECOVERY_COMBINATIONS: readonly Pick<
  GoldenPathRecovery,
  "class" | "safeAction" | "retryable" | "automaticCleanup" | "reasonCode"
>[] = [
  {
    class: "ISSUANCE_PARTIAL_PROJECTION",
    safeAction: "WAIT",
    retryable: false,
    automaticCleanup: "forbidden",
    reasonCode: "AUTHORITATIVE_REREAD_REQUIRED",
  },
  {
    class: "ISSUANCE_PARTIAL_PROJECTION",
    safeAction: "RECOVER",
    retryable: false,
    automaticCleanup: "conditional",
    reasonCode: "RECOVERY_ACTION_REQUIRED",
  },
  {
    class: "ISSUANCE_COMPENSATION_UNSAFE",
    safeAction: "MANUAL_REVIEW",
    retryable: false,
    automaticCleanup: "forbidden",
    reasonCode: "MANUAL_RECOVERY_REVIEW_REQUIRED",
  },
  {
    class: "ABORT_CLEANUP_PENDING",
    safeAction: "ABORT",
    retryable: false,
    automaticCleanup: "conditional",
    reasonCode: "ABORT_CLEANUP_REQUIRED",
  },
  {
    class: "ABORT_CLEANUP_PENDING",
    safeAction: "RECOVER",
    retryable: false,
    automaticCleanup: "conditional",
    reasonCode: "ABORT_CLEANUP_REQUIRED",
  },
  {
    class: "ABORT_CLEANUP_UNSAFE",
    safeAction: "WAIT",
    retryable: false,
    automaticCleanup: "forbidden",
    reasonCode: "AUTHORITATIVE_REREAD_REQUIRED",
  },
  {
    class: "ABORT_CLEANUP_UNSAFE",
    safeAction: "MANUAL_REVIEW",
    retryable: false,
    automaticCleanup: "forbidden",
    reasonCode: "MANUAL_RECOVERY_REVIEW_REQUIRED",
  },
  {
    class: "POST_EFFECT_VERIFICATION",
    safeAction: "RETRY",
    retryable: true,
    automaticCleanup: "none",
    reasonCode: "IDEMPOTENT_RETRY",
  },
  {
    class: "POST_EFFECT_VERIFICATION",
    safeAction: "WAIT",
    retryable: false,
    automaticCleanup: "forbidden",
    reasonCode: "AUTHORITATIVE_REREAD_REQUIRED",
  },
  {
    class: "POST_EFFECT_VERIFICATION",
    safeAction: "MANUAL_REVIEW",
    retryable: false,
    automaticCleanup: "forbidden",
    reasonCode: "MANUAL_RECOVERY_REVIEW_REQUIRED",
  },
];

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

function validateRecoveryPlan(
  input: unknown,
): { readonly valid: true; readonly plan: ChangeRecoveryPlan } | { readonly valid: false } {
  if (!isRecord(input)) return { valid: false };
  try {
    if (input.operation === "recover-issue") {
      const result = validateChangeIssuanceRecoveryPlan(input);
      if (!result.valid || result.plan === undefined) return { valid: false };
      return { valid: true, plan: result.plan };
    }
    if (input.operation === "recover-transition") {
      const result = validateChangeTransitionRecoveryPlan(input);
      if (!result.valid || result.plan === undefined) return { valid: false };
      return { valid: true, plan: result.plan };
    }
  } catch {
    return { valid: false };
  }
  return { valid: false };
}

function invalidPlanRecovery(input: GoldenPathRecoveryInput): GoldenPathRecovery {
  const operation = isRecord(input.recoveryPlan) ? input.recoveryPlan.operation : undefined;
  return operation === "recover-transition"
    ? recovery("ABORT_CLEANUP_UNSAFE", "MANUAL_REVIEW", false, "forbidden", "MANUAL_RECOVERY_REVIEW_REQUIRED")
    : recovery("ISSUANCE_COMPENSATION_UNSAFE", "MANUAL_REVIEW", false, "forbidden", "MANUAL_RECOVERY_REVIEW_REQUIRED");
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
  const projection = input.projection;
  return (
    reread !== undefined &&
    projection !== undefined &&
    reread.status === "complete" &&
    canonicalJson(reread.projection) === canonicalJson(projection)
  );
}

function idempotencyProven(evidence: ChangeRemoteExecutionEvidence | undefined): boolean {
  // Only the existing executor outcome is accepted as idempotency evidence;
  // an issuance transaction key is an identity, not a retry authorization.
  return evidence?.outcome === "returned-existing";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
    owner: "recovery" as const,
    retryable,
    rereadRequired: true,
    automaticCleanup,
    reasonCode,
  });
}

function issuanceRecovery(
  input: GoldenPathRecoveryInput,
  projection: ChangeProjectionResult | undefined,
  evidence: ChangeRemoteExecutionEvidence,
): GoldenPathRecovery | null {
  const plan = input.recoveryPlan;
  // A validated Core plan (or the explicit `compensated` executor outcome)
  // proves that compensation completed and is not recovery evidence.  A
  // `recovery-required` result with `compensation: succeeded` is different:
  // the trusted executor uses that combination for an unsafe recovery plan,
  // so it must remain fail-closed rather than being mistaken for success.
  if (
    evidence.outcome === "compensated" ||
    (plan?.operation === "recover-issue" && plan.compensation.status === "succeeded")
  ) {
    // A verified compensation is not a recovery-required result.
    return null;
  }

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
  if (plan?.operation === "recover-issue") {
    // The validated Core plan is the sole cleanup authority.  This projector
    // only exposes its explicit compensation-required effect; it never
    // re-evaluates branch generations or constructs a delete effect.
    if (plan.compensation.status === "required") {
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
  // Execution evidence alone does not establish compensation safety.  A
  // fresh read may still be unavailable, so no cleanup action is admitted.
  if (projection === undefined || projection.status === "unavailable") {
    return recovery("ISSUANCE_PARTIAL_PROJECTION", "WAIT", false, "forbidden", "AUTHORITATIVE_REREAD_REQUIRED");
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
  plan: ChangeRecoveryPlan | undefined,
  projection: ChangeProjectionResult | undefined,
): GoldenPathRecovery {
  if (plan?.operation === "recover-transition") {
    // Core's transition recovery plan already admitted the remaining effect;
    // classify that decision without re-running cleanup safety here.
    const failedKind = plan.failureEvidence.failure.effect.kind;
    if (failedKind === "DELETE_BRANCH" && plan.effects.some((effect) => effect.kind === "DELETE_BRANCH")) {
      return recovery("ABORT_CLEANUP_PENDING", "RECOVER", false, "conditional", "ABORT_CLEANUP_REQUIRED");
    }
    if (failedKind === "CLOSE_PULL_REQUEST" && plan.effects.some((effect) => effect.kind === "CLOSE_PULL_REQUEST")) {
      return recovery("ABORT_CLEANUP_PENDING", "ABORT", false, "conditional", "ABORT_CLEANUP_REQUIRED");
    }
    return recovery("ABORT_CLEANUP_UNSAFE", "MANUAL_REVIEW", false, "forbidden", "MANUAL_RECOVERY_REVIEW_REQUIRED");
  }
  // Execution evidence alone cannot prove canonical cleanup ownership.
  if (projection === undefined || projection.status === "unavailable") {
    return recovery("ABORT_CLEANUP_UNSAFE", "WAIT", false, "forbidden", "AUTHORITATIVE_REREAD_REQUIRED");
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
  if (rereadProven(input) && idempotencyProven(evidence)) {
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
  const rawInput = sourceInput(source);
  let input: GoldenPathRecoveryInput = rawInput;
  if (rawInput.recoveryPlan !== undefined) {
    const planResult = validateRecoveryPlan(rawInput.recoveryPlan);
    if (!planResult.valid) return invalidPlanRecovery(rawInput);
    input = { ...rawInput, recoveryPlan: planResult.plan };
  }
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
    return abortRecovery(plan, projection);
  }
  return postEffectRecovery(input, evidence);
}

/** Validate a recovery object at the #409 composition boundary. */
export function validateGoldenPathRecovery(input: unknown): GoldenPathRecoveryValidationResult {
  const diagnostics: GoldenPathRecoveryDiagnostic[] = [];
  if (!isRecord(input)) {
    diagnostics.push({ code: "INVALID_RECOVERY", path: "$", message: "Recovery must be an object." });
    return { valid: false, diagnostics };
  }
  const allowed = new Set([
    "class",
    "safeAction",
    "owner",
    "retryable",
    "rereadRequired",
    "automaticCleanup",
    "reasonCode",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    diagnostics.push({ code: "INVALID_RECOVERY", path: "$", message: "Recovery contains an unknown property." });
  }
  if (!recoveryClasses.has(input.class as string)) {
    diagnostics.push({ code: "INVALID_RECOVERY", path: "$.class", message: "Recovery class is unsupported." });
  }
  if (input.owner !== "recovery") {
    diagnostics.push({
      code: "INVALID_RECOVERY",
      path: "$.owner",
      message: "Recovery owner must be recovery.",
    });
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
  const admissible = ADMISSIBLE_RECOVERY_COMBINATIONS.some(
    (combination) =>
      combination.class === input.class &&
      combination.safeAction === input.safeAction &&
      combination.retryable === input.retryable &&
      combination.automaticCleanup === input.automaticCleanup &&
      combination.reasonCode === input.reasonCode,
  );
  if (!admissible) {
    diagnostics.push({
      code: "INVALID_RECOVERY",
      path: "$",
      message: "Recovery fields do not form an admissible bounded combination.",
    });
  }
  if (diagnostics.length > 0) return { valid: false, diagnostics };
  const recoveryValue: GoldenPathRecovery = {
    class: input.class as GoldenPathRecoveryClass,
    safeAction: input.safeAction as GoldenPathRecoveryAction,
    owner: "recovery",
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
