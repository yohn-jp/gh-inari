/**
 * Governed execution boundary for one explicit Issue close effect.
 *
 * The executor rereads the caller's bounded evidence immediately before the
 * effect, recomputes the pure close authority, applies one provider effect,
 * and verifies the provider's Issue state with a separate reread.
 */

import type { IssueReference } from "./contract/issue-reference.js";
import {
  SEMANTIC_ISSUE_CLOSURE_VERSION,
  planSemanticIssueClosure,
  tryPlanSemanticIssueClosure,
  validateSemanticIssueClosurePlan,
  type SemanticIssueClosureEvidenceInput,
  type SemanticIssueClosurePlan,
  type SemanticIssueClosureProjection,
  type SemanticIssueClosureStatus,
} from "./semantic-issue-closure.js";

export const SEMANTIC_ISSUE_CLOSURE_EXECUTOR_VERSION = "1" as const;
export type SemanticIssueClosureExecutorVersion = typeof SEMANTIC_ISSUE_CLOSURE_EXECUTOR_VERSION;

export type SemanticIssueClosureExecutionOutcome = "verified" | "idempotent";

export interface SemanticIssueClosureExecutionRequest {
  readonly version: SemanticIssueClosureExecutorVersion;
  readonly plan: unknown;
}

export interface SemanticIssueClosureProvider {
  /** Read the lifecycle and existing terminal authorities for one target. */
  readEvidence(target: IssueReference): Promise<SemanticIssueClosureEvidenceInput>;
  /** Apply exactly the already-admitted close effect. */
  closeIssue(target: IssueReference): Promise<unknown>;
  /** Read provider state after an effect; the response is never trusted blindly. */
  readState(target: IssueReference): Promise<unknown>;
}

export interface SemanticIssueClosureExecutionEvidence {
  readonly version: SemanticIssueClosureExecutorVersion;
  readonly outcome: SemanticIssueClosureExecutionOutcome;
  readonly effect: "not-attempted" | "succeeded";
  readonly precondition: SemanticIssueClosureStatus;
  readonly postcondition: "closed";
}

export interface SemanticIssueClosureExecutionResult {
  readonly version: SemanticIssueClosureExecutorVersion;
  readonly outcome: SemanticIssueClosureExecutionOutcome;
  readonly plan: SemanticIssueClosurePlan;
  readonly admissibility: SemanticIssueClosureProjection;
  readonly evidence: SemanticIssueClosureExecutionEvidence;
}

export type SemanticIssueClosureExecutorErrorCode =
  | "SEMANTIC_ISSUE_CLOSURE_EXECUTION_REQUEST_INVALID"
  | "SEMANTIC_ISSUE_CLOSURE_EXECUTION_PLAN_INVALID"
  | "SEMANTIC_ISSUE_CLOSURE_EXECUTION_READ_FAILED"
  | "SEMANTIC_ISSUE_CLOSURE_EXECUTION_STALE"
  | "SEMANTIC_ISSUE_CLOSURE_EXECUTION_BLOCKED"
  | "SEMANTIC_ISSUE_CLOSURE_EXECUTION_EFFECT_FAILED"
  | "SEMANTIC_ISSUE_CLOSURE_EXECUTION_POSTCONDITION_READ_FAILED"
  | "SEMANTIC_ISSUE_CLOSURE_EXECUTION_POSTCONDITION_FAILED";

export interface SemanticIssueClosureExecutionDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class SemanticIssueClosureExecutorError extends Error {
  readonly code: SemanticIssueClosureExecutorErrorCode;
  readonly diagnostics: readonly SemanticIssueClosureExecutionDiagnostic[];

  constructor(
    code: SemanticIssueClosureExecutorErrorCode,
    message: string,
    diagnostics: readonly SemanticIssueClosureExecutionDiagnostic[] = [],
  ) {
    super(message);
    this.name = "SemanticIssueClosureExecutorError";
    this.code = code;
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(code: string, path: string, message: string): SemanticIssueClosureExecutionDiagnostic {
  return { code, path, message };
}

function stableSerialize(value: unknown, stack = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : `number:${String(value)}`;
  if (typeof value === "undefined") return "undefined";
  if (typeof value !== "object") return `${typeof value}:${String(value)}`;
  if (stack.has(value)) throw new TypeError("Cyclic JSON data is not supported.");
  stack.add(value);
  const serialized = Array.isArray(value)
    ? `[${value.map((entry) => stableSerialize(entry, stack)).join(",")}]`
    : `{${Object.keys(value as RecordValue)
        .sort((left, right) => left.localeCompare(right, "en-US"))
        .map((key) => `${JSON.stringify(key)}:${stableSerialize((value as RecordValue)[key], stack)}`)
        .join(",")}}`;
  stack.delete(value);
  return serialized;
}

function compatibleAdmissibility(
  planned: SemanticIssueClosureProjection,
  current: SemanticIssueClosureProjection,
): boolean {
  const normalize = (projection: SemanticIssueClosureProjection): unknown => {
    const { effect: _effect, ...withoutEffect } = projection;
    const completion =
      projection.role === "leaf"
        ? { ...projection.lifecycle.completion, status: "in-progress" as const }
        : projection.lifecycle.completion;
    return {
      ...withoutEffect,
      status: projection.status === "already-closed" ? "closable" : projection.status,
      targetState: "open",
      lifecycle: { ...projection.lifecycle, completion },
    };
  };
  return stableSerialize(normalize(planned)) === stableSerialize(normalize(current));
}

function validRequest(input: unknown): input is SemanticIssueClosureExecutionRequest {
  if (!isRecord(input)) return false;
  return input.version === SEMANTIC_ISSUE_CLOSURE_EXECUTOR_VERSION && hasOnly(input, ["version", "plan"]);
}

function hasOnly(value: RecordValue, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function currentPlan(input: unknown): {
  readonly plan?: SemanticIssueClosurePlan;
  readonly diagnostics: readonly SemanticIssueClosureExecutionDiagnostic[];
} {
  const result = validateSemanticIssueClosurePlan(input);
  return {
    ...(result.plan === undefined ? {} : { plan: result.plan }),
    diagnostics: result.diagnostics.map((entry) => diagnostic(entry.code, entry.path, entry.message)),
  };
}

function evidenceInput(plan: SemanticIssueClosurePlan, evidence: SemanticIssueClosureEvidenceInput): unknown {
  return {
    target: plan.request.target,
    intent: plan.request.intent,
    lifecycle: evidence.lifecycle,
    ...(evidence.implementation === undefined ? {} : { implementation: evidence.implementation }),
    ...(evidence.change === undefined ? {} : { change: evidence.change }),
    ...(evidence.children === undefined ? {} : { children: evidence.children }),
  };
}

function providerState(value: unknown, target: IssueReference): "closed" {
  if (!isRecord(value) || value.number !== target.number || value.state !== "closed")
    throw new SemanticIssueClosureExecutorError(
      "SEMANTIC_ISSUE_CLOSURE_EXECUTION_POSTCONDITION_FAILED",
      "The provider did not verify the requested Issue as closed.",
      [
        diagnostic(
          "CLOSURE_PROVIDER_STATE_MISMATCH",
          "$.postcondition",
          "Provider Issue number and closed state do not match the close effect.",
        ),
      ],
    );
  return "closed";
}

/** Executes one explicit close effect through a caller-supplied provider seam. */
export class LocalSemanticIssueClosureExecutor {
  readonly #provider: SemanticIssueClosureProvider;

  constructor(options: { readonly provider: SemanticIssueClosureProvider }) {
    if (
      typeof options?.provider?.readEvidence !== "function" ||
      typeof options.provider.closeIssue !== "function" ||
      typeof options.provider.readState !== "function"
    )
      throw new TypeError("A complete Issue closure provider is required.");
    this.#provider = options.provider;
  }

  async execute(request: SemanticIssueClosureExecutionRequest): Promise<SemanticIssueClosureExecutionResult> {
    if (!validRequest(request))
      throw new SemanticIssueClosureExecutorError(
        "SEMANTIC_ISSUE_CLOSURE_EXECUTION_REQUEST_INVALID",
        "Issue closure execution request is invalid.",
        [diagnostic("CLOSURE_EXECUTION_REQUEST_INVALID", "$", "Request version, plan, or properties are invalid.")],
      );
    const parsed = currentPlan(request.plan);
    if (parsed.plan === undefined)
      throw new SemanticIssueClosureExecutorError(
        "SEMANTIC_ISSUE_CLOSURE_EXECUTION_PLAN_INVALID",
        "Issue closure plan is invalid.",
        parsed.diagnostics,
      );
    const plan = parsed.plan;
    let evidence: SemanticIssueClosureEvidenceInput;
    try {
      evidence = await this.#provider.readEvidence(plan.request.target);
    } catch {
      throw new SemanticIssueClosureExecutorError(
        "SEMANTIC_ISSUE_CLOSURE_EXECUTION_READ_FAILED",
        "Current Issue closure evidence could not be reread before the effect.",
        [diagnostic("CLOSURE_EXECUTION_READ_FAILED", "$.evidence", "Pre-effect lifecycle evidence is unavailable.")],
      );
    }
    const reread = tryPlanSemanticIssueClosure(evidenceInput(plan, evidence));
    if (!reread.valid || reread.plan === undefined || reread.projection === undefined) {
      throw new SemanticIssueClosureExecutorError(
        "SEMANTIC_ISSUE_CLOSURE_EXECUTION_STALE",
        "Current Issue closure evidence is no longer admissible.",
        reread.diagnostics.map((entry) => diagnostic(entry.code, entry.path, entry.message)),
      );
    }
    const current = reread.projection;
    if (!compatibleAdmissibility(plan.admissibility, current))
      throw new SemanticIssueClosureExecutorError(
        "SEMANTIC_ISSUE_CLOSURE_EXECUTION_STALE",
        "Issue closure evidence changed after the plan was created.",
        [diagnostic("CLOSURE_EXECUTION_STALE", "$.admissibility", "Pre-effect evidence does not match the plan.")],
      );
    if (current.status === "already-closed") {
      return {
        version: SEMANTIC_ISSUE_CLOSURE_EXECUTOR_VERSION,
        outcome: "idempotent",
        plan,
        admissibility: current,
        evidence: {
          version: SEMANTIC_ISSUE_CLOSURE_EXECUTOR_VERSION,
          outcome: "idempotent",
          effect: "not-attempted",
          precondition: current.status,
          postcondition: "closed",
        },
      };
    }
    if (current.status !== "closable" || plan.effect === undefined)
      throw new SemanticIssueClosureExecutorError(
        "SEMANTIC_ISSUE_CLOSURE_EXECUTION_BLOCKED",
        "Issue closure is not admissible at execution time.",
        [diagnostic("CLOSURE_EXECUTION_BLOCKED", "$.status", "The current close gate is blocked.")],
      );
    try {
      await this.#provider.closeIssue(plan.effect.target);
    } catch {
      throw new SemanticIssueClosureExecutorError(
        "SEMANTIC_ISSUE_CLOSURE_EXECUTION_EFFECT_FAILED",
        "The provider rejected the governed Issue close effect.",
        [diagnostic("CLOSURE_EXECUTION_EFFECT_FAILED", "$.effect", "Issue close effect failed.")],
      );
    }
    let state: unknown;
    try {
      state = await this.#provider.readState(plan.request.target);
    } catch {
      throw new SemanticIssueClosureExecutorError(
        "SEMANTIC_ISSUE_CLOSURE_EXECUTION_POSTCONDITION_READ_FAILED",
        "Provider state could not be reread after the close effect.",
        [
          diagnostic(
            "CLOSURE_EXECUTION_POSTCONDITION_READ_FAILED",
            "$.postcondition",
            "Issue state evidence is unavailable.",
          ),
        ],
      );
    }
    providerState(state, plan.request.target);
    return {
      version: SEMANTIC_ISSUE_CLOSURE_EXECUTOR_VERSION,
      outcome: "verified",
      plan,
      admissibility: current,
      evidence: {
        version: SEMANTIC_ISSUE_CLOSURE_EXECUTOR_VERSION,
        outcome: "verified",
        effect: "succeeded",
        precondition: current.status,
        postcondition: "closed",
      },
    };
  }
}

export type SemanticIssueClosureExecutionPort = Pick<LocalSemanticIssueClosureExecutor, "execute">;

export const executeSemanticIssueClosure = async (
  provider: SemanticIssueClosureProvider,
  request: SemanticIssueClosureExecutionRequest,
): Promise<SemanticIssueClosureExecutionResult> => new LocalSemanticIssueClosureExecutor({ provider }).execute(request);

export { planSemanticIssueClosure };
