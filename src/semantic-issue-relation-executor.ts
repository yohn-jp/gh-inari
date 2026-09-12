/**
 * Bounded executor for a Core-produced native Semantic Issue relation plan.
 *
 * The executor owns only admission/re-observation of the relation plan.  It
 * does not derive Issue identity, lifecycle, branch, worktree, or session
 * state.  Provider-specific endpoint details remain in the GitHub relation
 * adapter; this module performs no direct GitHub API construction.
 */

import { compileRepositoryEffectiveIssueContract } from "./artifact-contract-governance.js";
import { GitHubAdapter, GitHubIssueRelationMutationAdapter, type RepositoryContext } from "./github/index.js";
import {
  SEMANTIC_ISSUE_RELATION_PLAN_VERSION,
  sameSemanticIssueRelationState,
  tryPlanSemanticIssueRelations,
  validateSemanticIssueRelationMutationPlan,
  type SemanticIssueRelationEffect,
  type SemanticIssueRelationMutationPlan,
  type SemanticIssueRelationMutationPlanResult,
  type SemanticIssueRelationObservedState,
} from "./semantic-issue-relations.js";
import { issueReferenceKey, type IssueReference } from "./contract/issue-reference.js";

/** Bound on the live forward-walk used to re-establish graph safety at execution time. */
const MAX_GRAPH_WALK_NODES = 200;

function stableSerialize(value: unknown, stack = new WeakSet<object>()): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (stack.has(value)) throw new TypeError("Cyclic JSON data is not supported.");
  stack.add(value);
  const serialized = Array.isArray(value)
    ? `[${value.map((entry) => stableSerialize(entry, stack)).join(",")}]`
    : `{${Object.keys(value as Record<string, unknown>)
        .sort((left, right) => left.localeCompare(right, "en-US"))
        .map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key], stack)}`)
        .join(",")}}`;
  stack.delete(value);
  return serialized;
}

function sameCapabilitySet(left: readonly string[], right: readonly string[]): boolean {
  return stableSerialize([...left].sort()) === stableSerialize([...right].sort());
}

function validCapabilities(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((capability) => typeof capability === "string" && capability.length > 0) &&
    new Set(value).size === value.length
  );
}

export const SEMANTIC_ISSUE_RELATION_EXECUTOR_CONTRACT_VERSION = "1" as const;
export type SemanticIssueRelationExecutorContractVersion = typeof SEMANTIC_ISSUE_RELATION_EXECUTOR_CONTRACT_VERSION;

export interface SemanticIssueRelationExecutionRequest {
  readonly version: SemanticIssueRelationExecutorContractVersion;
  readonly plan: unknown;
  /** Caller-asserted current capabilities, checked against the plan's snapshot. */
  readonly capabilities?: readonly string[];
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
  | "SEMANTIC_ISSUE_RELATION_EXECUTION_POSTCONDITION_FAILED"
  | "SEMANTIC_ISSUE_RELATION_EXECUTION_GOVERNANCE_STALE";

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
  /** Issue Canon template selector, when the repository declares more than one. */
  readonly selector?: string;
  /** Caller-asserted current capabilities, checked against the plan's snapshot. */
  readonly capabilities?: readonly string[];
}

export interface SemanticIssueRelationExecutionPort {
  execute(request: SemanticIssueRelationExecutionRequest): Promise<SemanticIssueRelationExecutionResult>;
}

type RelationCapability = "parent" | "blockedBy" | "crossRepositoryParent";

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
    crossRepositoryParent: capabilities.includes("github.issue.parent.native.cross-repository-same-owner"),
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

interface GraphWalkFailure {
  readonly code: string;
  readonly message: string;
}

/**
 * Live forward-walk from a proposed new edge's target, re-establishing
 * whether the subject is currently reachable (a cycle) through *current*
 * provider state rather than the plan's transported/stale evidence. Only
 * walks within the target's own repository: a cross-repository target
 * (already same-owner-verified at admission) is checked at its immediate
 * hop only, since safely walking a foreign repository's own graph requires
 * a foreign-repository-scoped observation seam this walk does not build.
 */
async function walkForReachability(
  adapter: GitHubIssueRelationMutationAdapter,
  homeContext: RepositoryContext,
  subjectKey: string,
  start: IssueReference,
): Promise<{ readonly ok: true } | ({ readonly ok: false } & GraphWalkFailure)> {
  const visited = new Set<string>();
  const queue: IssueReference[] = [start];
  while (queue.length > 0) {
    const next = queue.shift() as IssueReference;
    const key = issueReferenceKey(next);
    if (key === subjectKey)
      return {
        ok: false,
        code: "RELATION_GRAPH_CYCLE",
        message: "The subject is currently reachable from the proposed new edge; applying it would create a cycle.",
      };
    if (visited.has(key)) continue;
    if (visited.size >= MAX_GRAPH_WALK_NODES)
      return {
        ok: false,
        code: "RELATION_GRAPH_EVIDENCE_UNAVAILABLE",
        message: "The current relationship graph exceeds the bounded live re-establishment limit.",
      };
    visited.add(key);
    if (
      next.repositoryHost.toLowerCase() !== homeContext.hostname.toLowerCase() ||
      next.repositoryId !== homeContext.repositoryId
    ) {
      // Foreign-repository hop: checked at this one hop only (already
      // reached, so already caught above if it were the subject); do not
      // expand further without a foreign-repository observation seam.
      continue;
    }
    const [parentObservation, blockedByObservation] = await Promise.all([
      adapter.observeParent(next.number),
      adapter.observeBlockedBy(next.number),
    ]);
    if (parentObservation.kind !== "empty" && parentObservation.kind !== "present")
      return {
        ok: false,
        code: "RELATION_GRAPH_EVIDENCE_UNAVAILABLE",
        message: "Current parent evidence for a node in the live relationship graph is unavailable.",
      };
    if (blockedByObservation.kind !== "empty" && blockedByObservation.kind !== "present")
      return {
        ok: false,
        code: "RELATION_GRAPH_EVIDENCE_UNAVAILABLE",
        message: "Current dependsOn evidence for a node in the live relationship graph is unavailable.",
      };
    if (parentObservation.kind === "present" && parentObservation.reference !== undefined)
      queue.push(parentObservation.reference);
    if (blockedByObservation.kind === "present") queue.push(...blockedByObservation.references);
  }
  return { ok: true };
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
  readonly #selector: string | undefined;
  readonly #capabilities: readonly string[] | undefined;

  constructor(options: SemanticIssueRelationExecutorOptions) {
    this.#adapter = options.adapter;
    this.#selector = options.selector;
    this.#capabilities = options.capabilities;
  }

  async execute(request: SemanticIssueRelationExecutionRequest): Promise<SemanticIssueRelationExecutionResult> {
    if (!isRecord(request) || request.version !== SEMANTIC_ISSUE_RELATION_EXECUTOR_CONTRACT_VERSION)
      throw new SemanticIssueRelationExecutorError(
        "SEMANTIC_ISSUE_RELATION_EXECUTION_REQUEST_INVALID",
        "Semantic Issue relation execution request version is unsupported.",
        [diagnostic("RELATION_EXECUTION_REQUEST_INVALID", "$.version", "Execution request version is unsupported.")],
      );
    if (request.capabilities !== undefined && !validCapabilities(request.capabilities))
      throw new SemanticIssueRelationExecutorError(
        "SEMANTIC_ISSUE_RELATION_EXECUTION_REQUEST_INVALID",
        "Semantic Issue relation execution capabilities are invalid.",
        [diagnostic("RELATION_EXECUTION_REQUEST_INVALID", "$.capabilities", "Capabilities must be unique strings.")],
      );
    const result = validateSemanticIssueRelationMutationPlan(request.plan);
    if (!result.valid || result.plan === undefined)
      throw new SemanticIssueRelationExecutorError(
        "SEMANTIC_ISSUE_RELATION_EXECUTION_PLAN_INVALID",
        "The Semantic Issue relation mutation plan is invalid.",
        result.diagnostics.map((entry) => diagnostic(entry.code, entry.path, entry.message)),
      );
    const plan = result.plan;
    const needParent = relationNeeded(plan, "parent");
    const needBlockedBy = relationNeeded(plan, "blockedBy");
    if (!needParent && !needBlockedBy)
      return {
        plan,
        observed: plan.observed,
        evidence: evidence("verified", []),
      };

    // Re-evaluate provider capabilities at execution time. A plan carries only
    // a frozen snapshot; execution requires the caller to independently
    // (re-)assert current capabilities every time — silently trusting the
    // plan when nothing is asserted is exactly the fail-open gap this
    // rejects.
    const requestedCapabilities = request.capabilities ?? this.#capabilities;
    if (requestedCapabilities === undefined)
      throw new SemanticIssueRelationExecutorError(
        "SEMANTIC_ISSUE_RELATION_EXECUTION_GOVERNANCE_STALE",
        "Execution requires an explicit current-capabilities assertion; a transported plan snapshot cannot be trusted alone.",
        [
          diagnostic(
            "RELATION_CAPABILITIES_UNASSERTED",
            "$.capabilities",
            "Current capabilities must be asserted before execution.",
          ),
        ],
      );
    if (!sameCapabilitySet(requestedCapabilities, plan.capabilities))
      throw new SemanticIssueRelationExecutorError(
        "SEMANTIC_ISSUE_RELATION_EXECUTION_GOVERNANCE_STALE",
        "Execution capabilities do not match the versioned plan.",
        [
          diagnostic(
            "RELATION_CAPABILITIES_MISMATCH",
            "$.capabilities",
            "Capabilities must equal the plan capabilities.",
          ),
        ],
      );
    // Unconditionally re-resolve the current Effective Issue Contract and
    // reject a plan whose governance has since changed, before any provider
    // effect — mirroring SemanticIssueExecutor's own always-refresh pattern
    // rather than skipping the check when a plan happens to omit generation.
    let effective: Awaited<ReturnType<typeof compileRepositoryEffectiveIssueContract>>;
    try {
      effective = await compileRepositoryEffectiveIssueContract(this.#adapter, this.#selector);
    } catch (error: unknown) {
      throw new SemanticIssueRelationExecutorError(
        "SEMANTIC_ISSUE_RELATION_EXECUTION_READ_FAILED",
        "The authoritative Issue Canon could not be resolved for native relation execution.",
        [
          diagnostic(
            "RELATION_CANON_RESOLUTION_FAILED",
            "$.generation",
            error instanceof Error ? error.message : "Authoritative Issue Canon could not be resolved.",
          ),
        ],
      );
    }
    if (plan.generation === undefined || stableSerialize(plan.generation) !== stableSerialize(effective.generation))
      throw new SemanticIssueRelationExecutorError(
        "SEMANTIC_ISSUE_RELATION_EXECUTION_GOVERNANCE_STALE",
        "Repository governance changed after the plan was produced, or the plan never bound one.",
        [
          diagnostic(
            "RELATION_GENERATION_MISMATCH",
            "$.generation",
            "Plan generation does not match the current repository Canon generation.",
          ),
        ],
      );
    const capabilities = relationCapabilities(plan.capabilities);

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

    // Re-establish and validate the bounded relationship graph immediately
    // before effects: the transported plan.graph is a planning-time snapshot,
    // and an edge added elsewhere after planning can close a cycle even
    // though the subject's own direct observed relation is unchanged.
    const subjectKey = issueReferenceKey(subject);
    for (const effect of plan.effects) {
      const walkTarget = effect.kind === "SET_PARENT_RELATION" ? effect.parent : undefined;
      const walkTargets = effect.kind === "ADD_BLOCKED_BY_RELATION" ? [effect.reference] : [];
      const targets = walkTarget === undefined ? walkTargets : [walkTarget, ...walkTargets];
      for (const target of targets) {
        const walk = await walkForReachability(adapter, context, subjectKey, target);
        if (!walk.ok)
          throw new SemanticIssueRelationExecutorError(
            "SEMANTIC_ISSUE_RELATION_EXECUTION_STALE",
            "The current relationship graph could not be re-established as safe immediately before effects.",
            [diagnostic(walk.code, "$.graph", walk.message)],
          );
      }
    }

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

export interface ExistingIssueRelationPlanRequest {
  readonly subjectNumber: number;
  /** Desired relation state, in any shape `tryPlanSemanticIssueRelations` accepts. */
  readonly desired: unknown;
  /** Bounded relationship graph evidence; required by Core whenever effects result. */
  readonly graph?: unknown;
  /** Caller-declared capabilities, bound to the compiled Effective Issue Contract. */
  readonly capabilities: readonly string[];
  /** Issue Canon template selector, when the repository declares more than one. */
  readonly selector?: string;
}

/**
 * Compose live native-relation observation with Core planning for an
 * already-existing Issue. This is the one shared entry every transport (CLI,
 * MCP, Actions, Skill) calls for existing-Issue relationship reconciliation,
 * so none re-derives the observe-then-plan glue independently.
 */
function planDiagnostic(
  code: "RELATION_INPUT_INVALID" | "RELATION_EVIDENCE_UNAVAILABLE",
  path: string,
  message: string,
): {
  readonly code: "RELATION_INPUT_INVALID" | "RELATION_EVIDENCE_UNAVAILABLE";
  readonly path: string;
  readonly message: string;
} {
  return { code, path, message };
}

export async function planExistingIssueRelationReconciliation(
  adapter: GitHubAdapter,
  request: ExistingIssueRelationPlanRequest,
): Promise<SemanticIssueRelationMutationPlanResult> {
  if (!Number.isSafeInteger(request.subjectNumber) || request.subjectNumber < 1)
    return {
      valid: false,
      diagnostics: [
        planDiagnostic("RELATION_INPUT_INVALID", "$.subject.number", "Issue number must be a positive safe integer."),
      ],
    };
  // Relationship semantics are governed by the repository's Issue Canon, not
  // an independent authority: refuse to plan when the Canon does not declare
  // `parent`/`dependsOn` as governed properties, before touching GitHub.
  let effective: Awaited<ReturnType<typeof compileRepositoryEffectiveIssueContract>>;
  try {
    effective = await compileRepositoryEffectiveIssueContract(adapter, request.selector, {
      capabilities: request.capabilities,
    });
  } catch (error: unknown) {
    return {
      valid: false,
      diagnostics: [
        planDiagnostic(
          "RELATION_EVIDENCE_UNAVAILABLE",
          "$.generation",
          error instanceof Error ? error.message : "Authoritative Issue Canon could not be resolved.",
        ),
      ],
    };
  }
  const properties = effective.contract.properties as Readonly<Record<string, { presence?: string }>> | undefined;
  const governsRelations =
    properties !== undefined &&
    properties.parent?.presence !== undefined &&
    properties.parent.presence !== "unused" &&
    properties.dependsOn?.presence !== undefined &&
    properties.dependsOn.presence !== "unused";
  if (!governsRelations)
    return {
      valid: false,
      diagnostics: [
        planDiagnostic(
          "RELATION_INPUT_INVALID",
          "$.generation",
          "The repository Issue Canon does not govern parent/dependsOn as relationship properties.",
        ),
      ],
    };
  let context: RepositoryContext;
  let subject: IssueReference;
  try {
    context = await adapter.getRepositoryContext();
    subject = issueReference(context, request.subjectNumber);
  } catch {
    return {
      valid: false,
      diagnostics: [
        planDiagnostic("RELATION_EVIDENCE_UNAVAILABLE", "$.subject", "Repository context resolution failed."),
      ],
    };
  }
  const relationAdapter = new GitHubIssueRelationMutationAdapter(
    adapter,
    context,
    relationCapabilities(effective.capabilities),
  );
  let parentObservation: Awaited<ReturnType<typeof relationAdapter.observeParent>>;
  let blockedByObservation: Awaited<ReturnType<typeof relationAdapter.observeBlockedBy>>;
  try {
    [parentObservation, blockedByObservation] = await Promise.all([
      relationAdapter.observeParent(request.subjectNumber),
      relationAdapter.observeBlockedBy(request.subjectNumber),
    ]);
  } catch {
    return {
      valid: false,
      diagnostics: [
        planDiagnostic("RELATION_EVIDENCE_UNAVAILABLE", "$.observed", "Native Issue relation observation failed."),
      ],
    };
  }
  const observed = relationState(parentObservation, blockedByObservation);
  return tryPlanSemanticIssueRelations({
    subject,
    desired: request.desired,
    observed,
    capabilities: effective.capabilities,
    generation: effective.generation,
    ...(request.graph === undefined ? {} : { graph: request.graph }),
  });
}
