/**
 * Evidence-derived terminal lifecycle projection for one Implementation.
 *
 * Authorization remains the identity authority, conformance remains the
 * execution-evidence authority, and the #679 identity projection remains the
 * Change/Session binding authority. This module composes those authorities;
 * it does not persist lifecycle state or accept a caller-supplied completion
 * assertion.
 */

import { issueReferenceKey, type IssueReference } from "./contract/issue-reference.js";
import {
  inspectImplementationLifecycle,
  tryVerifyImplementationAuthorization,
  type ImplementationAuthorizationInspectionResult,
  type ImplementationAuthorizationRecord,
  type ImplementationAuthorizationVerificationInput,
  type ImplementationLifecycleStatus,
} from "./implementation-authorization.js";
import {
  tryVerifyImplementationConformance,
  type ImplementationConformanceInput,
} from "./implementation-conformance.js";
import {
  tryProjectImplementationChangeIdentity,
  type ImplementationChangeIdentity,
} from "./implementation-change-identity.js";
import { observeImplementationTaskTermination } from "./implementation-task-termination.js";

export const IMPLEMENTATION_LIFECYCLE_TERMINAL_STATUSES = Object.freeze(["completed", "aborted"] as const);
export type ImplementationLifecycleTerminalStatus = (typeof IMPLEMENTATION_LIFECYCLE_TERMINAL_STATUSES)[number];

/** The evidence accepted by the lifecycle composition seam. */
export interface ImplementationLifecycleInput extends ImplementationConformanceInput {
  /** Raw #679 identity inputs, read only as historical Implementation-root Change evidence. */
  readonly changeIdentity?: unknown;
  /** Raw current repository-owned task-termination read, when available. */
  readonly taskTermination?: unknown;
}

export interface ImplementationLifecycleViolation {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface ImplementationLifecycleHistoricalTermination {
  readonly classification: "historical-only";
  readonly source: "implementation-root-change";
  readonly implementation: IssueReference;
  readonly authorizationDigest: string;
}

/**
 * Lifecycle output intentionally preserves the existing authorization
 * projection shape so frontier and other consumers can adopt terminal state
 * without a second lifecycle representation.
 */
export interface ImplementationLifecycleResult {
  readonly valid: boolean;
  readonly status?: ImplementationLifecycleStatus;
  readonly authorization?: ImplementationAuthorizationRecord;
  readonly contract?: ImplementationAuthorizationInspectionResult["contract"];
  readonly governedBodyDigest?: string;
  readonly readiness?: ImplementationAuthorizationInspectionResult["readiness"];
  readonly authorized: boolean;
  readonly current: boolean;
  readonly historicalTermination?: ImplementationLifecycleHistoricalTermination;
  readonly violations: readonly ImplementationLifecycleViolation[];
}

type RecordValue = Record<string, unknown>;

const INPUT_KEYS = new Set([
  "authorization",
  "implementation",
  "issue",
  "body",
  "repository",
  "base",
  "readiness",
  "supersession",
  "completed",
  "pullRequestNumber",
  "pullRequest",
  "executionEvidence",
  "changeIdentity",
  "taskTermination",
]);

const AUTHORIZATION_KEYS = new Set([
  "authorization",
  "implementation",
  "issue",
  "body",
  "repository",
  "base",
  "readiness",
  "supersession",
  "completed",
]);

const CONFORMANCE_KEYS = new Set([
  "authorization",
  "issue",
  "repository",
  "base",
  "pullRequestNumber",
  "pullRequest",
  "supersession",
  "executionEvidence",
]);

const EXECUTION_EVIDENCE_DIAGNOSTICS = new Set([
  "IMPLEMENTATION_CONFORMANCE_EXECUTION_EVIDENCE_INVALID",
  "IMPLEMENTATION_CONFORMANCE_EXECUTION_EVIDENCE_MISMATCH",
  "IMPLEMENTATION_CONFORMANCE_EXECUTION_EVIDENCE_STALE",
]);

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedViolations(
  violations: readonly ImplementationLifecycleViolation[],
): readonly ImplementationLifecycleViolation[] {
  return Object.freeze(
    [...violations].sort(
      (left, right) =>
        left.path.localeCompare(right.path, "en-US") ||
        left.code.localeCompare(right.code, "en-US") ||
        left.message.localeCompare(right.message, "en-US"),
    ),
  );
}

function fromAuthorization(
  result: ImplementationAuthorizationInspectionResult,
  extraViolations: readonly ImplementationLifecycleViolation[] = [],
  overrides: {
    readonly status?: ImplementationLifecycleStatus;
    readonly authorized?: boolean;
    readonly current?: boolean;
    readonly valid?: boolean;
    readonly historicalTermination?: ImplementationLifecycleHistoricalTermination;
  } = {},
): ImplementationLifecycleResult {
  const violations = sortedViolations([...result.violations, ...extraViolations]);
  return {
    valid: overrides.valid ?? (result.valid && extraViolations.length === 0),
    ...(overrides.status === undefined
      ? result.status === undefined
        ? {}
        : { status: result.status }
      : { status: overrides.status }),
    ...(result.authorization === undefined ? {} : { authorization: result.authorization }),
    ...(result.contract === undefined ? {} : { contract: result.contract }),
    ...(result.governedBodyDigest === undefined ? {} : { governedBodyDigest: result.governedBodyDigest }),
    ...(result.readiness === undefined ? {} : { readiness: result.readiness }),
    authorized: overrides.authorized ?? result.authorized,
    current: overrides.current ?? result.current,
    ...(overrides.historicalTermination === undefined
      ? {}
      : { historicalTermination: overrides.historicalTermination }),
    violations,
  };
}

function addViolation(
  violations: ImplementationLifecycleViolation[],
  code: string,
  path: string,
  message: string,
  expected?: unknown,
  actual?: unknown,
): void {
  violations.push({
    code,
    path,
    message,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  });
}

function copyKeys(value: RecordValue, allowed: ReadonlySet<string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) if (allowed.has(key)) result[key] = value[key];
  return result;
}

function authorizationInput(value: RecordValue): ImplementationAuthorizationVerificationInput {
  return copyKeys(value, AUTHORIZATION_KEYS) as unknown as ImplementationAuthorizationVerificationInput;
}

function conformanceInput(value: RecordValue): ImplementationConformanceInput {
  return copyKeys(value, CONFORMANCE_KEYS) as unknown as ImplementationConformanceInput;
}

function inputDiagnostics(value: RecordValue): ImplementationLifecycleViolation[] {
  const violations: ImplementationLifecycleViolation[] = [];
  for (const key of Object.keys(value).sort(compareStrings)) {
    if (!INPUT_KEYS.has(key))
      addViolation(violations, "IMPLEMENTATION_LIFECYCLE_INPUT_INVALID", `$.${key}`, "Property is not supported.");
  }
  return violations;
}

function hasCompleteConformanceInput(value: RecordValue): boolean {
  return ["issue", "repository", "base", "pullRequestNumber", "pullRequest"].every((key) => hasOwn(value, key));
}

function changeAbortBinding(
  value: RecordValue,
  authorization: ImplementationAuthorizationRecord,
  violations: ImplementationLifecycleViolation[],
):
  | { readonly status: "absent" }
  | { readonly status: "historical"; readonly evidence: ImplementationLifecycleHistoricalTermination }
  | { readonly status: "invalid" } {
  if (!hasOwn(value, "changeIdentity")) return { status: "absent" };
  const projected = tryProjectImplementationChangeIdentity(value.changeIdentity);
  if (!projected.valid || projected.identity === undefined) {
    for (const diagnostic of projected.diagnostics)
      addViolation(violations, "IMPLEMENTATION_LIFECYCLE_TERMINATION_INVALID", diagnostic.path, diagnostic.message);
    return { status: "invalid" };
  }
  const identity: ImplementationChangeIdentity = projected.identity;
  let bound = true;
  if (identity.change.state !== "ABORTED") {
    bound = false;
    addViolation(
      violations,
      "IMPLEMENTATION_LIFECYCLE_TERMINATION_INVALID",
      "$.changeIdentity.change.state",
      'A terminal abort requires Change state "ABORTED".',
    );
  }
  if (issueReferenceKey(identity.implementation) !== issueReferenceKey(authorization.implementation)) {
    bound = false;
    addViolation(
      violations,
      "IMPLEMENTATION_LIFECYCLE_TERMINATION_MISMATCH",
      "$.changeIdentity.implementation",
      "Aborted Change identity does not target the current Implementation authorization.",
    );
  }
  if (identity.authorization.governedBodyDigest !== authorization.governedBodyDigest) {
    bound = false;
    addViolation(
      violations,
      "IMPLEMENTATION_LIFECYCLE_TERMINATION_MISMATCH",
      "$.changeIdentity.authorization.governedBodyDigest",
      "Aborted Change identity does not match the current authorization digest.",
    );
  }
  if (identity.session.authorizationDigest !== authorization.governedBodyDigest) {
    bound = false;
    addViolation(
      violations,
      "IMPLEMENTATION_LIFECYCLE_TERMINATION_MISMATCH",
      "$.changeIdentity.session.authorizationDigest",
      "Aborted Session identity does not match the current authorization digest.",
    );
  }
  return bound
    ? {
        status: "historical",
        evidence: {
          classification: "historical-only",
          source: "implementation-root-change",
          implementation: identity.implementation,
          authorizationDigest: authorization.governedBodyDigest,
        },
      }
    : { status: "invalid" };
}

/**
 * Derive the current Implementation lifecycle from reread evidence. A
 * supplied `completed` flag remains readable for compatibility but is
 * rejected by authorization verification and cannot create terminal state.
 */
export function tryProjectImplementationLifecycle(input: unknown): ImplementationLifecycleResult {
  if (!isRecord(input)) {
    const result = inspectImplementationLifecycle(input);
    return fromAuthorization(
      result,
      [
        {
          code: "IMPLEMENTATION_LIFECYCLE_INPUT_INVALID",
          path: "$",
          message: "Lifecycle input must be an object.",
        },
      ],
      { valid: false },
    );
  }

  const diagnostics = inputDiagnostics(input);
  const hasAuthorization = hasOwn(input, "authorization");
  const authorization = hasAuthorization
    ? tryVerifyImplementationAuthorization(authorizationInput(input))
    : inspectImplementationLifecycle(authorizationInput(input));
  if (!hasAuthorization) return fromAuthorization(authorization, diagnostics);
  if (
    authorization.authorization === undefined ||
    authorization.status === "invalidated" ||
    authorization.status === "superseded" ||
    !authorization.authorized ||
    !authorization.current
  )
    return fromAuthorization(authorization, diagnostics);

  // Precedence is deliberate: stale/superseded authorization is resolved
  // above; only the current repository-owned termination record can abort a
  // task; completion is the last and most demanding outcome.
  const terminalViolations: ImplementationLifecycleViolation[] = [...diagnostics];
  const changeBinding = changeAbortBinding(input, authorization.authorization, terminalViolations);
  const historicalTermination = changeBinding.status === "historical" ? changeBinding.evidence : undefined;
  if (changeBinding.status === "invalid") return fromAuthorization(authorization, terminalViolations, { valid: false });

  let taskTerminationStatus: "absent" | "present" | "unavailable" | "invalid" = "absent";
  if (hasOwn(input, "taskTermination")) {
    const observation = observeImplementationTaskTermination(input.taskTermination, authorization.authorization);
    taskTerminationStatus = observation.status;
    if (observation.status === "unavailable" || observation.status === "invalid") {
      for (const violation of observation.status === "invalid" ? observation.violations : [])
        addViolation(
          terminalViolations,
          "IMPLEMENTATION_LIFECYCLE_TERMINATION_INVALID",
          violation.path,
          violation.message,
        );
      if (observation.status === "unavailable")
        addViolation(
          terminalViolations,
          "IMPLEMENTATION_LIFECYCLE_TERMINATION_UNAVAILABLE",
          "$.taskTermination",
          "Current task-termination evidence is unavailable.",
        );
      return fromAuthorization(authorization, terminalViolations, {
        valid: false,
        ...(historicalTermination === undefined ? {} : { historicalTermination }),
      });
    }
  }
  if (taskTerminationStatus === "present" && terminalViolations.length === 0)
    return fromAuthorization(authorization, terminalViolations, {
      status: "aborted",
      authorized: false,
      current: false,
      valid: true,
      ...(historicalTermination === undefined ? {} : { historicalTermination }),
    });

  // A historical Implementation-root abort cannot revive that old execution
  // authority. A current authoritative task read can re-establish that the
  // task has no termination record; the historical Change alone cannot.
  const historicalAuthorityOverrides =
    historicalTermination !== undefined && !hasOwn(input, "taskTermination")
      ? { authorized: false, current: false }
      : {};

  // A lifecycle query may legitimately ask only whether authorization is
  // current. Completion is considered only when the complete conformance
  // reread is present; partial evidence never becomes a terminal assertion.
  if (!hasCompleteConformanceInput(input))
    return fromAuthorization(authorization, terminalViolations, {
      ...historicalAuthorityOverrides,
      ...(historicalTermination === undefined ? {} : { historicalTermination }),
    });

  const conformance = tryVerifyImplementationConformance(conformanceInput(input));
  const conformanceViolations = conformance.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    path: diagnostic.path,
    message: diagnostic.message,
  }));
  const evidenceDiagnostics = conformance.diagnostics.some((diagnostic) =>
    EXECUTION_EVIDENCE_DIAGNOSTICS.has(diagnostic.code),
  );
  const hasExactExecutionEvidence = input.executionEvidence !== undefined && !evidenceDiagnostics;

  if (
    conformance.status === "conformant" &&
    conformance.valid &&
    hasExactExecutionEvidence &&
    terminalViolations.length === 0 &&
    conformance.diagnostics.length === 0
  )
    return fromAuthorization(authorization, [...terminalViolations, ...conformanceViolations], {
      status: "completed",
      authorized: true,
      current: true,
      valid: true,
      ...(historicalTermination === undefined ? {} : { historicalTermination }),
    });

  if (conformance.status === "stale-invalid-authorization")
    return fromAuthorization(authorization, [...terminalViolations, ...conformanceViolations], {
      status: "invalidated",
      authorized: false,
      current: false,
      valid: false,
      ...(historicalTermination === undefined ? {} : { historicalTermination }),
    });

  return fromAuthorization(authorization, [...terminalViolations, ...conformanceViolations], {
    valid: false,
    ...(historicalTermination === undefined ? {} : { historicalTermination }),
  });
}

/** Throwing lifecycle entry point for callers that require terminal evidence. */
export function projectImplementationLifecycle(input: unknown): ImplementationLifecycleResult {
  const result = tryProjectImplementationLifecycle(input);
  if (!result.valid)
    throw new Error(result.violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
  return result;
}

/** Compatibility names for callers that use the existing verify terminology. */
export const tryVerifyImplementationLifecycle = tryProjectImplementationLifecycle;
export const verifyImplementationLifecycle = projectImplementationLifecycle;
