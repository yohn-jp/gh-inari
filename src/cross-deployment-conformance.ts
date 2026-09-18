/**
 * Deployment-neutral semantic conformance contract.
 *
 * Fixtures in this module describe the inputs that Core is allowed to see:
 * semantic requests, bounded GitHub evidence, and Governance Canon
 * generations.  They deliberately stop at the transport boundary.  Actions,
 * Direct App, MCP, and local callers may add correlation or provider metadata
 * around a result, but that metadata is not part of conformance.
 */

import {
  normalizeChangeExecutionResult,
  normalizeChangeProjection,
  type ChangeExecutionResult,
  type ChangeExecutionEffectKind,
  type ChangeMutation,
  type ChangeExecutionOutcome,
} from "./change-execution-port.js";
import type {
  ChangeGitHubEvidence,
  ChangeIdentity,
  ChangeProjectionResult,
  ChangeProjection,
  ChangeProjectionStatus,
} from "./change.js";
import type { CapabilityAuthorizedSessionExecutionResult } from "./session-authorized-change-executor.js";

export const CROSS_DEPLOYMENT_CONFORMANCE_VERSION = 1 as const;

export const CROSS_DEPLOYMENT_PROFILES = Object.freeze(["trusted-local", "actions", "direct-app", "mcp"] as const);
export type CrossDeploymentProfile = (typeof CROSS_DEPLOYMENT_PROFILES)[number];

export type CrossDeploymentOperation = ChangeMutation | "show";

/** A semantic request that contains no caller-owned requester assertion. */
export interface CrossDeploymentRequest {
  readonly version: 1;
  readonly operation: CrossDeploymentOperation;
  readonly issue: number;
  readonly semanticPullRequestPlan?: unknown;
}

/** The normalized Authority and Canon inputs used by an offline fixture. */
export interface CrossDeploymentAuthoritySnapshot {
  readonly generation: string;
  readonly identity: ChangeIdentity;
  readonly branchGovernance?: Readonly<{ readonly pattern: string }>;
  readonly naming: Readonly<{ readonly type: string; readonly slug: string }>;
  readonly baseBranch: string;
  readonly evidence: ChangeGitHubEvidence;
}

export interface CrossDeploymentEffectSummary {
  readonly kind: ChangeExecutionEffectKind;
  readonly status: "succeeded" | "failed";
}

export interface CrossDeploymentPostcondition {
  readonly status: ChangeProjectionStatus;
  readonly state?: string;
  readonly branch?: string;
  readonly pullRequest?: number;
}

export interface CrossDeploymentPlanSummary {
  readonly operation: ChangeMutation;
  readonly effects: readonly CrossDeploymentEffectSummary[];
  readonly postcondition: CrossDeploymentPostcondition;
}

/** Diagnostics intentionally contain only bounded semantic fields. */
export interface CrossDeploymentDiagnostic {
  readonly code: string;
  readonly path?: string;
  readonly message?: string;
  readonly phase?: string;
}

export interface CrossDeploymentProjectionSummary {
  readonly valid: boolean;
  readonly status: ChangeProjectionStatus;
  readonly canonicalBranch?: string;
  readonly canonicalBaseBranch?: string;
  readonly change?: {
    readonly identity: ChangeIdentity;
    readonly state: string;
    readonly projection?: ChangeProjection;
  };
  readonly diagnostics: readonly CrossDeploymentDiagnostic[];
}

export type CrossDeploymentAdmission = "admitted" | "denied";
export type CrossDeploymentOutcome = ChangeExecutionOutcome | "denied" | "not-run";

/** The only result shape compared across deployment profiles. */
export interface CrossDeploymentSemanticResult {
  readonly version: typeof CROSS_DEPLOYMENT_CONFORMANCE_VERSION;
  readonly status: "succeeded" | "failed";
  readonly admission: CrossDeploymentAdmission;
  readonly operation?: CrossDeploymentOperation;
  readonly projection?: CrossDeploymentProjectionSummary;
  readonly plan?: CrossDeploymentPlanSummary;
  readonly outcome: CrossDeploymentOutcome;
  readonly diagnostics: readonly CrossDeploymentDiagnostic[];
  /** True only when the profile reached its semantic postcondition. */
  readonly verified: boolean;
  /** A stable statement of trusted binding, without a session/request ID. */
  readonly requesterBinding?: "authenticated-session" | "trusted-local-user";
}

export interface CrossDeploymentExpectation {
  readonly admission: CrossDeploymentAdmission;
  readonly projection?: CrossDeploymentProjectionSummary;
  readonly plan?: CrossDeploymentPlanSummary;
  readonly outcome: CrossDeploymentOutcome;
  readonly diagnostics: readonly CrossDeploymentDiagnostic[];
  readonly verified: boolean;
  readonly requesterBinding?: CrossDeploymentSemanticResult["requesterBinding"];
}

export interface CrossDeploymentFixture {
  readonly version: typeof CROSS_DEPLOYMENT_CONFORMANCE_VERSION;
  readonly name: string;
  readonly request: CrossDeploymentRequest;
  readonly before: CrossDeploymentAuthoritySnapshot;
  readonly after?: CrossDeploymentAuthoritySnapshot;
  readonly expected: CrossDeploymentExpectation;
}

export interface CrossDeploymentFixtureValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly CrossDeploymentDiagnostic[];
}

const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,95}$/u;
const SAFE_GENERATION = /^[A-Za-z0-9._:/-]{1,255}$/u;
const FORBIDDEN_KEY =
  /(?:private.?key|secret|token|credential|bearer|authorization|installation.?token|raw.?payload)/iu;
const FORBIDDEN_VALUE = /(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9_]+|token\s*=|password\s*=)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(code: string, path: string, message: string): CrossDeploymentDiagnostic {
  return { code, path, message };
}

function inspectFixtureMaterial(value: unknown, path: string, diagnostics: CrossDeploymentDiagnostic[]): void {
  if (diagnostics.length >= 32) return;
  if (typeof value === "string") {
    if (FORBIDDEN_VALUE.test(value))
      diagnostics.push(diagnostic("FIXTURE_SECRET_MATERIAL", path, "Secret material is not accepted."));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectFixtureMaterial(item, `${path}[${index}]`, diagnostics));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      diagnostics.push(
        diagnostic("FIXTURE_PROVIDER_MATERIAL", `${path}.${key}`, "Provider or credential payloads are not accepted."),
      );
      if (diagnostics.length >= 32) return;
    }
    inspectFixtureMaterial(item, `${path}.${key}`, diagnostics);
    if (diagnostics.length >= 32) return;
  }
}

/** Validate the closed, secret-safe fixture format before executing a fixture. */
export function validateCrossDeploymentFixture(input: unknown): CrossDeploymentFixtureValidationResult {
  const diagnostics: CrossDeploymentDiagnostic[] = [];
  inspectFixtureMaterial(input, "$", diagnostics);
  if (!isRecord(input)) {
    diagnostics.push(diagnostic("FIXTURE_INVALID_ROOT", "$", "A conformance fixture must be an object."));
    return { valid: false, diagnostics };
  }
  if (input.version !== CROSS_DEPLOYMENT_CONFORMANCE_VERSION) {
    diagnostics.push(diagnostic("FIXTURE_UNSUPPORTED_VERSION", "$.version", "Fixture version is unsupported."));
  }
  if (typeof input.name !== "string" || !SAFE_NAME.test(input.name)) {
    diagnostics.push(diagnostic("FIXTURE_INVALID_NAME", "$.name", "Fixture name is invalid."));
  }
  const request = input.request;
  if (!isRecord(request)) {
    diagnostics.push(diagnostic("FIXTURE_INVALID_REQUEST", "$.request", "Fixture request is invalid."));
  } else {
    if (Object.prototype.hasOwnProperty.call(request, "requester")) {
      diagnostics.push(
        diagnostic(
          "FIXTURE_CALLER_REQUESTER",
          "$.request.requester",
          "Caller requester assertions are not part of a semantic fixture request.",
        ),
      );
    }
    if (request.version !== 1 || !Number.isSafeInteger(request.issue) || (request.issue as number) < 1) {
      diagnostics.push(
        diagnostic("FIXTURE_INVALID_REQUEST", "$.request", "Request version or Issue number is invalid."),
      );
    }
    if (
      typeof request.operation !== "string" ||
      (request.operation !== "show" && !["issue", "ready", "abort"].includes(request.operation))
    ) {
      diagnostics.push(diagnostic("FIXTURE_INVALID_REQUEST", "$.request.operation", "Request operation is invalid."));
    }
  }
  const before = input.before;
  if (!isRecord(before)) {
    diagnostics.push(diagnostic("FIXTURE_INVALID_AUTHORITY", "$.before", "Initial Authority snapshot is required."));
  } else {
    if (typeof before.generation !== "string" || !SAFE_GENERATION.test(before.generation)) {
      diagnostics.push(
        diagnostic("FIXTURE_INVALID_GENERATION", "$.before.generation", "Authority generation is invalid."),
      );
    }
    if (
      !isRecord(before.identity) ||
      typeof before.identity.repositoryHost !== "string" ||
      typeof before.identity.repositoryId !== "string"
    ) {
      diagnostics.push(diagnostic("FIXTURE_INVALID_AUTHORITY", "$.before.identity", "Authority identity is invalid."));
    }
    if (typeof before.baseBranch !== "string" || before.baseBranch.length === 0) {
      diagnostics.push(
        diagnostic("FIXTURE_INVALID_AUTHORITY", "$.before.baseBranch", "Canonical base branch is invalid."),
      );
    }
    if (!isRecord(before.evidence)) {
      diagnostics.push(
        diagnostic("FIXTURE_INVALID_AUTHORITY", "$.before.evidence", "Bounded Authority evidence is required."),
      );
    }
  }
  const after = input.after;
  if (after !== undefined && !isRecord(after)) {
    diagnostics.push(diagnostic("FIXTURE_INVALID_AUTHORITY", "$.after", "Terminal Authority snapshot is invalid."));
  }
  if (!isRecord(input.expected)) {
    diagnostics.push(diagnostic("FIXTURE_INVALID_EXPECTATION", "$.expected", "Fixture expectation is required."));
  }
  return { valid: diagnostics.length === 0, diagnostics: Object.freeze(diagnostics) };
}

export function assertCrossDeploymentFixture(input: unknown): asserts input is CrossDeploymentFixture {
  const result = validateCrossDeploymentFixture(input);
  if (!result.valid) throw new TypeError("Cross-deployment conformance fixture is invalid.");
}

function stableDiagnostics(diagnostics: readonly CrossDeploymentDiagnostic[]): readonly CrossDeploymentDiagnostic[] {
  return [...diagnostics]
    .sort((left, right) =>
      `${left.phase ?? ""}\u0000${left.code}\u0000${left.path ?? ""}`.localeCompare(
        `${right.phase ?? ""}\u0000${right.code}\u0000${right.path ?? ""}`,
      ),
    )
    .map((item) => ({
      code: item.code,
      ...(item.path === undefined ? {} : { path: item.path }),
      ...(item.message === undefined ? {} : { message: item.message }),
      ...(item.phase === undefined ? {} : { phase: item.phase }),
    }));
}

function normalizeDiagnostic(value: unknown, phase?: string): CrossDeploymentDiagnostic | undefined {
  if (!isRecord(value) || typeof value.code !== "string") return undefined;
  return {
    code: value.code,
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(phase === undefined ? {} : { phase }),
  };
}

function projectionSummary(projection: ChangeProjectionResult): CrossDeploymentProjectionSummary {
  return {
    valid: projection.valid,
    status: projection.status,
    ...(projection.canonicalBranch === undefined ? {} : { canonicalBranch: projection.canonicalBranch }),
    ...(projection.canonicalBaseBranch === undefined ? {} : { canonicalBaseBranch: projection.canonicalBaseBranch }),
    ...(projection.change === undefined
      ? {}
      : {
          change: {
            identity: projection.change.identity,
            state: projection.change.state,
            ...(projection.change.projection === undefined ? {} : { projection: projection.change.projection }),
          },
        }),
    diagnostics: stableDiagnostics(
      projection.diagnostics
        .map((item) => normalizeDiagnostic(item))
        .filter((item): item is CrossDeploymentDiagnostic => item !== undefined),
    ),
  };
}

function postcondition(projection: ChangeProjectionResult): CrossDeploymentPostcondition {
  return {
    status: projection.status,
    ...(projection.change === undefined ? {} : { state: projection.change.state }),
    ...(projection.change?.projection?.branch === undefined ? {} : { branch: projection.change.projection.branch }),
    ...(projection.change?.projection?.pullRequest === undefined
      ? {}
      : { pullRequest: projection.change.projection.pullRequest }),
  };
}

function planSummary(
  request: CrossDeploymentRequest,
  execution: ChangeExecutionResult,
): CrossDeploymentPlanSummary | undefined {
  if (request.operation === "show" || execution.evidence === undefined) return undefined;
  return {
    operation: request.operation,
    effects: [...execution.evidence.effects]
      .map(({ kind, status }) => ({ kind, status }))
      .sort((left, right) => `${left.kind}:${left.status}`.localeCompare(`${right.kind}:${right.status}`)),
    postcondition: postcondition(execution.projection),
  };
}

function outcomeForExecution(
  request: CrossDeploymentRequest,
  execution: ChangeExecutionResult,
): CrossDeploymentOutcome {
  if (request.operation === "show") return "verified";
  return execution.evidence?.outcome ?? (execution.projection.valid ? "verified" : "failed");
}

function resultFromExecution(
  request: CrossDeploymentRequest,
  execution: ChangeExecutionResult,
  requesterBinding: CrossDeploymentSemanticResult["requesterBinding"],
): CrossDeploymentSemanticResult {
  const outcome = outcomeForExecution(request, execution);
  const evidenceDiagnostic =
    execution.evidence?.failure === undefined
      ? undefined
      : normalizeDiagnostic(
          execution.evidence.failure,
          outcome === "recovery-required" ? "recovery-required" : "execution",
        );
  const failed = outcome === "recovery-required" || outcome === "failed";
  const projection = projectionSummary(execution.projection);
  const plan = planSummary(request, execution);
  return Object.freeze({
    version: CROSS_DEPLOYMENT_CONFORMANCE_VERSION,
    status: failed ? "failed" : "succeeded",
    admission: "admitted",
    operation: request.operation,
    ...(failed ? {} : { projection }),
    ...(failed || plan === undefined ? {} : { plan }),
    outcome,
    diagnostics: stableDiagnostics([
      ...(failed ? [] : projection.diagnostics),
      ...(evidenceDiagnostic === undefined ? [] : [evidenceDiagnostic]),
    ]),
    verified:
      request.operation === "show"
        ? execution.projection.valid
        : outcome === "verified" || outcome === "returned-existing",
    ...(requesterBinding === undefined ? {} : { requesterBinding }),
  });
}

/** Normalize a local or Actions Change Port result to semantic fields only. */
export function normalizeCrossDeploymentChangeResult(
  request: CrossDeploymentRequest,
  value: unknown,
  requesterBinding: CrossDeploymentSemanticResult["requesterBinding"] = "trusted-local-user",
): CrossDeploymentSemanticResult {
  const execution =
    request.operation === "show"
      ? { projection: normalizeChangeProjection(request.operation, value) }
      : normalizeChangeExecutionResult(request.operation, value);
  return resultFromExecution(request, execution, requesterBinding);
}

function failureResult(
  operation: CrossDeploymentOperation | undefined,
  phase: string,
  diagnostics: readonly CrossDeploymentDiagnostic[],
  requesterBinding?: CrossDeploymentSemanticResult["requesterBinding"],
): CrossDeploymentSemanticResult {
  const admission =
    phase === "authentication" || phase === "request" || phase === "authorization" || phase === "conflict"
      ? "denied"
      : "admitted";
  return Object.freeze({
    version: CROSS_DEPLOYMENT_CONFORMANCE_VERSION,
    status: "failed",
    admission,
    ...(operation === undefined ? {} : { operation }),
    outcome: phase === "recovery-required" ? "recovery-required" : admission === "denied" ? "denied" : "failed",
    diagnostics: stableDiagnostics(diagnostics.map((item) => ({ ...item, phase }))),
    verified: false,
    ...(requesterBinding === undefined ? {} : { requesterBinding }),
  });
}

function semanticOperation(value: string | undefined): CrossDeploymentOperation | undefined {
  if (value === "change.issue") return "issue";
  if (value === "change.show") return "show";
  if (value === "change.ready") return "ready";
  if (value === "change.abort") return "abort";
  return undefined;
}

/** Normalize the Session/App result while dropping request/session/App metadata. */
export function normalizeCrossDeploymentSessionResult(
  request: CrossDeploymentRequest,
  result: CapabilityAuthorizedSessionExecutionResult,
): CrossDeploymentSemanticResult {
  if (result.status === "succeeded") {
    const execution = result.execution;
    if (execution !== undefined) {
      const normalized = resultFromExecution(
        request,
        normalizeChangeExecutionResult(request.operation, execution),
        "authenticated-session",
      );
      return Object.freeze({
        ...normalized,
        verified:
          request.operation === "show"
            ? normalized.verified
            : result.provenance?.stage === "verified" && normalized.verified,
      });
    }
    if (result.projection !== undefined) {
      return resultFromExecution(
        request,
        { projection: normalizeChangeProjection(request.operation, result.projection) },
        "authenticated-session",
      );
    }
    return failureResult(
      request.operation,
      "verification",
      [{ code: "SESSION_RESULT_INVALID", message: "Session result did not contain a semantic result." }],
      "authenticated-session",
    );
  }
  return failureResult(
    semanticOperation(result.operation),
    result.failure?.phase ?? "execution",
    [
      ...(result.failure?.diagnostics ?? [])
        .map((item) => normalizeDiagnostic(item))
        .filter((item): item is CrossDeploymentDiagnostic => item !== undefined),
      ...(result.failure?.evidence?.failure === undefined
        ? []
        : [normalizeDiagnostic(result.failure.evidence.failure)]),
    ].filter((item): item is CrossDeploymentDiagnostic => item !== undefined),
    result.provenance === undefined ? undefined : "authenticated-session",
  );
}

/**
 * Build a bounded semantic failure from diagnostics a real execution boundary
 * already produced. A bare string is shorthand for a single-code diagnostic;
 * this never manufactures a diagnostic that no production code emitted.
 */
export function normalizeCrossDeploymentFailure(
  operation: CrossDeploymentOperation | undefined,
  phase: string,
  diagnostics: string | readonly CrossDeploymentDiagnostic[],
  requesterBinding?: CrossDeploymentSemanticResult["requesterBinding"],
): CrossDeploymentSemanticResult {
  const list = typeof diagnostics === "string" ? [{ code: diagnostics }] : diagnostics;
  return failureResult(operation, phase, list, requesterBinding);
}

/** Convert an adapter error to a bounded semantic failure without retaining its message. */
export function normalizeCrossDeploymentError(
  operation: CrossDeploymentOperation,
  error: unknown,
  requesterBinding?: CrossDeploymentSemanticResult["requesterBinding"],
): CrossDeploymentSemanticResult {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "CROSS_DEPLOYMENT_EXECUTION_FAILED";
  return failureResult(operation, "execution", [{ code }], requesterBinding);
}

function comparable(result: CrossDeploymentSemanticResult): unknown {
  return {
    version: result.version,
    status: result.status,
    admission: result.admission,
    ...(result.operation === undefined ? {} : { operation: result.operation }),
    ...(result.projection === undefined ? {} : { projection: result.projection }),
    ...(result.plan === undefined ? {} : { plan: result.plan }),
    outcome: result.outcome,
    diagnostics: stableDiagnostics(result.diagnostics),
    verified: result.verified,
  };
}

/** Return true when two profiles have the same semantic result. */
export function areCrossDeploymentResultsEquivalent(
  left: CrossDeploymentSemanticResult,
  right: CrossDeploymentSemanticResult,
): boolean {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

/** Assert semantic parity without comparing transport/provider metadata. */
export function assertCrossDeploymentParity(
  expected: CrossDeploymentSemanticResult,
  actual: CrossDeploymentSemanticResult,
): void {
  if (!areCrossDeploymentResultsEquivalent(expected, actual)) {
    throw new Error(
      `Cross-deployment semantic mismatch.\nexpected: ${JSON.stringify(comparable(expected))}\nactual: ${JSON.stringify(comparable(actual))}`,
    );
  }
}

export function assertCrossDeploymentExpectation(
  actual: CrossDeploymentSemanticResult,
  expected: CrossDeploymentExpectation,
): void {
  const expectedResult: CrossDeploymentSemanticResult = {
    version: CROSS_DEPLOYMENT_CONFORMANCE_VERSION,
    status:
      expected.outcome === "denied" || expected.outcome === "failed" || expected.outcome === "recovery-required"
        ? "failed"
        : "succeeded",
    admission: expected.admission,
    ...(actual.operation === undefined ? {} : { operation: actual.operation }),
    ...(expected.projection === undefined ? {} : { projection: expected.projection }),
    ...(expected.plan === undefined ? {} : { plan: expected.plan }),
    outcome: expected.outcome,
    diagnostics: expected.diagnostics,
    verified: expected.verified,
  };
  assertCrossDeploymentParity(expectedResult, actual);
}
