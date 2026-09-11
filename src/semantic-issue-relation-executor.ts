/**
 * Bounded executor for a Core-produced native Semantic Issue relation plan.
 *
 * The executor owns only admission/re-observation of the relation plan.  It
 * does not derive Issue identity, lifecycle, branch, worktree, or session
 * state.  Provider-specific endpoint details remain in the GitHub relation
 * adapter; this module performs no direct GitHub API construction.
 */

import { GitHubAdapter, GitHubIssueRelationMutationAdapter, type RepositoryContext } from "./github/index.js";
import {
  SEMANTIC_ISSUE_RELATION_PLAN_VERSION,
  sameSemanticIssueRelationState,
  validateSemanticIssueRelationMutationPlan,
  type SemanticIssueRelationEffect,
  type SemanticIssueRelationMutationPlan,
  type SemanticIssueRelationObservedState,
} from "./semantic-issue-relations.js";
import type { IssueReference } from "./contract/issue-reference.js";

export const SEMANTIC_ISSUE_RELATION_EXECUTOR_CONTRACT_VERSION = "1" as const;
export type SemanticIssueRelationExecutorContractVersion = typeof SEMANTIC_ISSUE_RELATION_EXECUTOR_CONTRACT_VERSION;

export interface SemanticIssueRelationExecutionRequest {
  readonly version: SemanticIssueRelationExecutorContractVersion;
  readonly plan: unknown;
}

export interface SemanticIssueRelationExecutionEffectEvidence {
  readonly kind: SemanticIssueRelationEffect["kind"];
  readonly status: "succeeded" | "failed";
}

export interface SemanticIssueRelationExecutionEvidence {
  readonly version: SemanticIssueRelationExecutorContractVersion;
  readonly planVersion: typeof SEMANTIC_ISSUE_RELATION_PLAN_VERSION;
  readonly outcome: "verified" | "failed";
  readonly effects: readonly SemanticIssueRelationExecutionEffectEvidence[];
  readonly failure?: Readonly<{ readonly code: string; readonly message: string }>;
}

export interface SemanticIssueRelationExecutionResult {
  readonly plan: SemanticIssueRelationMutationPlan;
  readonly observed: SemanticIssueRelationObservedState;
  readonly evidence: SemanticIssueRelationExecutionEvidence;
}

export type SemanticIssueRelationExecutorErrorCode =
  | "SEMANTIC_ISSUE_RELATION_EXECUTION_REQUEST_INVALID"
  | "SEMANTIC_ISSUE_RELATION_EXECUTION_PLAN_INVALID"
  | "SEMANTIC_ISSUE_RELATION_EXECUTION_READ_FAILED"
  | "SEMANTIC_ISSUE_RELATION_EXECUTION_STALE"
  | "SEMANTIC_ISSUE_RELATION_EXECUTION_EFFECT_FAILED"
  | "SEMANTIC_ISSUE_RELATION_EXECUTION_POSTCONDITION_FAILED";

export interface SemanticIssueRelationExecutionDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class SemanticIssueRelationExecutorError extends Error {
  readonly code: SemanticIssueRelationExecutorErrorCode;
  readonly diagnostics: readonly SemanticIssueRelationExecutionDiagnostic[];
  readonly evidence?: SemanticIssueRelationExecutionEvidence;

  constructor(
    code: SemanticIssueRelationExecutorErrorCode,
    message: string,
    diagnostics: readonly SemanticIssueRelationExecutionDiagnostic[] = [],
    evidence?: SemanticIssueRelationExecutionEvidence,
  ) {
    super(message);
    this.name = "SemanticIssueRelationExecutorError";
    this.code = code;
    this.diagnostics = Object.freeze([...diagnostics]);
    this.evidence = evidence;
  }
}

export interface SemanticIssueRelationExecutorOptions {
  readonly adapter: GitHubAdapter;
}

export interface SemanticIssueRelationExecutionPort {
  execute(request: SemanticIssueRelationExecutionRequest): Promise<SemanticIssueRelationExecutionResult>;
}

type RelationCapability = "parent" | "blockedBy";

function diagnostic(code: string, path: string, message: string): SemanticIssueRelationExecutionDiagnostic {
  return { code, path, message };
}

function evidence(
  outcome: "verified" | "failed",
  effects: readonly SemanticIssueRelationExecutionEffectEvidence[],
  failure?: { readonly code: string; readonly message: string },
): SemanticIssueRelationExecutionEvidence {
  return Object.freeze({
    version: SEMANTIC_ISSUE_RELATION_EXECUTOR_CONTRACT_VERSION,
    planVersion: SEMANTIC_ISSUE_RELATION_PLAN_VERSION,
    outcome,
    effects: Object.freeze([...effects]),
    ...(failure === undefined ? {} : { failure: Object.freeze(failure) }),
  });
}

function relationCapabilities(capabilities: readonly string[]): Readonly<Record<RelationCapability, boolean>> {
  return {
    parent: capabilities.some((entry) => entry === "github.issue.parent.native" || entry === "issue.parent.native"),
    blockedBy: capabilities.some(
      (entry) =>
        entry === "github.issue.blocked-by.native" ||
        entry === "github.issue.dependencies.native" ||
        entry === "github.issue.blocked_by.native" ||
        entry === "issue.depends-on.native",
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameObservedState(
  left: SemanticIssueRelationObservedState,
  right: SemanticIssueRelationObservedState,
): boolean {
  return (
    left.status === right.status &&
    left.parentStatus === right.parentStatus &&
    left.dependsOnStatus === right.dependsOnStatus &&
    sameSemanticIssueRelationState(left, right)
  );
}

function issueReference(context: RepositoryContext, number: number): IssueReference {
  if (context.repositoryId === undefined)
    throw new SemanticIssueRelationExecutorError(
      "SEMANTIC_ISSUE_RELATION_EXECUTION_READ_FAILED",
      "A repository database identity is required for native Issue relation execution.",
      [
        diagnostic(
          "RELATION_REPOSITORY_ID_MISSING",
          "$.repository.repositoryId",
          "Repository identity is unavailable.",
        ),
      ],
    );
  return {
    repositoryHost: context.hostname,
    repositoryId: context.repositoryId,
    repository: context.nameWithOwner,
    number,
  };
}

function relationNeeded(plan: SemanticIssueRelationMutationPlan, kind: RelationCapability): boolean {
  if (kind === "parent") {
    return (
      plan.desired.parentRepresentation === "native" ||
      plan.effects.some((effect) => effect.kind === "SET_PARENT_RELATION" || effect.kind === "CLEAR_PARENT_RELATION")
    );
  }
  return (
    plan.desired.dependsOnRepresentation === "native" ||
    plan.effects.some(
      (effect) => effect.kind === "ADD_BLOCKED_BY_RELATION" || effect.kind === "REMOVE_BLOCKED_BY_RELATION",
    )
  );
}

function relationState(
  parent: Awaited<ReturnType<GitHubIssueRelationMutationAdapter["observeParent"]>> | undefined,
  blockedBy: Awaited<ReturnType<GitHubIssueRelationMutationAdapter["observeBlockedBy"]>> | undefined,
): SemanticIssueRelationObservedState {
  const parentUnavailable = parent !== undefined && parent.kind !== "empty" && parent.kind !== "present";
  const blockedByUnavailable = blockedBy !== undefined && blockedBy.kind !== "empty" && blockedBy.kind !== "present";
  const parentStatus =
    parent === undefined || parent.kind === "empty" ? "empty" : parent.kind === "present" ? "present" : "unavailable";
  const dependsOnStatus =
    blockedBy === undefined || blockedBy.kind === "empty"
      ? "empty"
      : blockedBy.kind === "present"
        ? "present"
        : "unavailable";
  const status = parentUnavailable || blockedByUnavailable ? "unavailable" : "complete";
  return {
    ...(parent?.kind === "present" && parent.reference === undefined
      ? {}
      : parent?.kind === "present"
        ? { parent: parent.reference }
        : {}),
    dependsOn: blockedBy?.kind === "present" ? blockedBy.references : [],
    parentStatus,
    dependsOnStatus,
    status,
  };
}

function failureEvidence(
  effects: readonly SemanticIssueRelationEffect[],
  statuses: readonly ("succeeded" | "failed")[],
  code: string,
  message: string,
): SemanticIssueRelationExecutionEvidence {
  return evidence(
    "failed",
    effects.map((effect, index) => ({ kind: effect.kind, status: statuses[index] ?? "failed" })),
    { code, message },
  );
}

/** Executes exactly the bounded native effects admitted by Core. */
export class SemanticIssueRelationExecutor implements SemanticIssueRelationExecutionPort {
  readonly #adapter: GitHubAdapter;

  constructor(options: SemanticIssueRelationExecutorOptions) {
    this.#adapter = options.adapter;
  }

  async execute(request: SemanticIssueRelationExecutionRequest): Promise<SemanticIssueRelationExecutionResult> {
    if (!isRecord(request) || request.version !== SEMANTIC_ISSUE_RELATION_EXECUTOR_CONTRACT_VERSION)
      throw new SemanticIssueRelationExecutorError(
        "SEMANTIC_ISSUE_RELATION_EXECUTION_REQUEST_INVALID",
        "Semantic Issue relation execution request version is unsupported.",
        [diagnostic("RELATION_EXECUTION_REQUEST_INVALID", "$.version", "Execution request version is unsupported.")],
      );
    const result = validateSemanticIssueRelationMutationPlan(request.plan);
    if (!result.valid || result.plan === undefined)
      throw new SemanticIssueRelationExecutorError(
        "SEMANTIC_ISSUE_RELATION_EXECUTION_PLAN_INVALID",
        "The Semantic Issue relation mutation plan is invalid.",
        result.diagnostics.map((entry) => diagnostic(entry.code, entry.path, entry.message)),
      );
    const plan = result.plan;
    const capabilities = relationCapabilities(plan.capabilities);
    const needParent = relationNeeded(plan, "parent");
    const needBlockedBy = relationNeeded(plan, "blockedBy");
    if (!needParent && !needBlockedBy)
      return {
        plan,
        observed: plan.observed,
        evidence: evidence("verified", []),
      };

    let context: RepositoryContext;
    try {
      context = await this.#adapter.getRepositoryContext();
    } catch {
      throw new SemanticIssueRelationExecutorError(
        "SEMANTIC_ISSUE_RELATION_EXECUTION_READ_FAILED",
        "The target repository context could not be resolved for native relation execution.",
        [diagnostic("RELATION_REPOSITORY_READ_FAILED", "$.subject", "Repository context resolution failed.")],
      );
    }
    const subject = issueReference(context, plan.subject.number);
    if (subject.repositoryHost !== plan.subject.repositoryHost || subject.repositoryId !== plan.subject.repositoryId)
      throw new SemanticIssueRelationExecutorError(
        "SEMANTIC_ISSUE_RELATION_EXECUTION_READ_FAILED",
        "The relation plan subject does not match the resolved repository identity.",
        [
          diagnostic(
            "RELATION_SUBJECT_IDENTITY_MISMATCH",
            "$.subject",
            "Subject repository identity is stale or unauthorized.",
          ),
        ],
      );

    const adapter = new GitHubIssueRelationMutationAdapter(this.#adapter, context, capabilities);
    const observedReads = await Promise.all([
      needParent ? adapter.observeParent(plan.subject.number) : Promise.resolve(undefined),
      needBlockedBy ? adapter.observeBlockedBy(plan.subject.number) : Promise.resolve(undefined),
    ]);
    const before = relationState(observedReads[0], observedReads[1]);
    if (before.status !== "complete")
      throw new SemanticIssueRelationExecutorError(
        "SEMANTIC_ISSUE_RELATION_EXECUTION_READ_FAILED",
        "Current native Issue relation evidence is incomplete; no mutation was applied.",
        [
          diagnostic(
            "RELATION_OBSERVATION_UNAVAILABLE",
            "$.observed",
            "Native relation evidence is unavailable or malformed.",
          ),
        ],
      );
    if (!sameObservedState(plan.observed, before))
      throw new SemanticIssueRelationExecutorError(
        "SEMANTIC_ISSUE_RELATION_EXECUTION_STALE",
        "The native Issue relation state changed after the plan was produced.",
        [
          diagnostic(
            "RELATION_STALE",
            "$.preconditions[0]",
            "Plan observation does not match current native relation evidence.",
          ),
        ],
      );

    const statuses: Array<"succeeded" | "failed"> = [];
    for (const effect of plan.effects) {
      try {
        await adapter.execute(effect, subject);
        statuses.push("succeeded");
      } catch {
        statuses.push("failed");
        throw new SemanticIssueRelationExecutorError(
          "SEMANTIC_ISSUE_RELATION_EXECUTION_EFFECT_FAILED",
          "A native Issue relation effect failed; no compensation was attempted.",
          [
            diagnostic(
              "RELATION_EFFECT_FAILED",
              `$.effects[${statuses.length - 1}]`,
              "Native Issue relation effect did not succeed.",
            ),
          ],
          failureEvidence(
            plan.effects,
            statuses,
            "RELATION_EFFECT_FAILED",
            "Native Issue relation effect did not succeed.",
          ),
        );
      }
    }

    const afterReads = await Promise.all([
      needParent ? adapter.observeParent(plan.subject.number) : Promise.resolve(undefined),
      needBlockedBy ? adapter.observeBlockedBy(plan.subject.number) : Promise.resolve(undefined),
    ]);
    const after = relationState(afterReads[0], afterReads[1]);
    if (after.status !== "complete")
      throw new SemanticIssueRelationExecutorError(
        "SEMANTIC_ISSUE_RELATION_EXECUTION_READ_FAILED",
        "Native Issue relation postcondition evidence is incomplete.",
        [
          diagnostic(
            "RELATION_POSTCONDITION_READ_FAILED",
            "$.postconditions",
            "Native relation evidence could not be verified.",
          ),
        ],
        failureEvidence(
          plan.effects,
          statuses,
          "RELATION_POSTCONDITION_READ_FAILED",
          "Native relation evidence could not be verified.",
        ),
      );
    const expected: SemanticIssueRelationObservedState = {
      ...(needParent
        ? plan.desired.parent === undefined
          ? {}
          : { parent: plan.desired.parent }
        : after.parent === undefined
          ? {}
          : { parent: after.parent }),
      dependsOn: needBlockedBy ? plan.desired.dependsOn : after.dependsOn,
      parentStatus: needParent ? (plan.desired.parent === undefined ? "empty" : "present") : after.parentStatus,
      dependsOnStatus: needBlockedBy
        ? plan.desired.dependsOn.length === 0
          ? "empty"
          : "present"
        : after.dependsOnStatus,
      status: "complete",
    };
    if (!sameSemanticIssueRelationState(expected, after))
      throw new SemanticIssueRelationExecutorError(
        "SEMANTIC_ISSUE_RELATION_EXECUTION_POSTCONDITION_FAILED",
        "Native Issue relation state does not satisfy the desired postcondition.",
        [
          diagnostic(
            "RELATION_POSTCONDITION_FAILED",
            "$.desired",
            "Observed native relation state differs from desired state.",
          ),
        ],
        failureEvidence(
          plan.effects,
          statuses,
          "RELATION_POSTCONDITION_FAILED",
          "Observed native relation state differs from desired state.",
        ),
      );
    return {
      plan,
      observed: after,
      evidence: evidence(
        "verified",
        plan.effects.map((effect) => ({ kind: effect.kind, status: "succeeded" as const })),
      ),
    };
  }
}

export const LocalSemanticIssueRelationExecutor = SemanticIssueRelationExecutor;
