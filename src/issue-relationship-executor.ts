/**
 * Local executor for the generic parent/sub-issue relationship authority.
 *
 * It composes Core planning with the GitHub adapter, but keeps provider paths
 * and response parsing out of the CLI.  Every effect is admitted from fresh
 * evidence and followed by a fresh inverse-view postcondition read.
 */

import { normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";
import {
  tryPlanIssueRelationshipMutation,
  type IssueRelationshipDiagnostic,
  type IssueRelationshipEffect,
  type IssueRelationshipMutationPlan,
  type IssueRelationshipObservedState,
  type IssueRelationshipOperation,
} from "./issue-relationship.js";
import { GitHubIssueRelationMutationAdapter } from "./github/issue-relation-mutation-adapter.js";
import type { IssueChildrenObservation, IssueParentObservation } from "./github/issue-relation-observation-adapter.js";
import type { RepositoryContext } from "./github/types.js";

export const ISSUE_RELATIONSHIP_EXECUTOR_VERSION = "1" as const;
export type IssueRelationshipExecutorVersion = typeof ISSUE_RELATIONSHIP_EXECUTOR_VERSION;

export interface IssueRelationshipMutationRequest {
  readonly operation: IssueRelationshipOperation;
  readonly child: number | IssueReference;
  readonly parent?: number | IssueReference;
  readonly previousParent?: number | IssueReference;
}

export interface IssueRelationshipInspection {
  readonly version: IssueRelationshipExecutorVersion;
  readonly operation: "inspect-parent" | "inspect-children";
  readonly issue: IssueReference;
  readonly parent?: IssueReference;
  readonly children?: readonly IssueReference[];
  readonly evidence: {
    readonly status: "empty" | "present";
    readonly diagnostics: readonly unknown[];
  };
}

export interface IssueRelationshipExecutionEvidence {
  readonly version: IssueRelationshipExecutorVersion;
  readonly outcome: "verified" | "idempotent" | "partial-effect";
  readonly effects: readonly Readonly<{
    readonly kind: IssueRelationshipEffect["kind"];
    readonly status: "succeeded" | "failed" | "skipped";
  }>[];
  readonly recovery?: Readonly<{
    readonly child: IssueRelationshipObservedState;
    readonly parents: readonly IssueRelationshipObservedState[];
  }>;
}

export interface IssueRelationshipExecutionResult {
  readonly plan: IssueRelationshipMutationPlan;
  readonly observed: Readonly<{
    readonly child: IssueRelationshipObservedState;
    readonly parents: readonly IssueRelationshipObservedState[];
  }>;
  readonly postcondition: Readonly<{
    readonly child: IssueRelationshipObservedState;
    readonly parents: readonly IssueRelationshipObservedState[];
  }>;
  readonly evidence: IssueRelationshipExecutionEvidence;
}

export type IssueRelationshipExecutorErrorCode =
  | "ISSUE_RELATIONSHIP_REQUEST_INVALID"
  | "ISSUE_RELATIONSHIP_READ_FAILED"
  | "ISSUE_RELATIONSHIP_STALE"
  | "ISSUE_RELATIONSHIP_EFFECT_FAILED"
  | "ISSUE_RELATIONSHIP_RECOVERY_READ_FAILED"
  | "ISSUE_RELATIONSHIP_POSTCONDITION_FAILED";

export class IssueRelationshipExecutorError extends Error {
  readonly code: IssueRelationshipExecutorErrorCode;
  readonly diagnostics: readonly IssueRelationshipDiagnostic[];
  readonly evidence?: IssueRelationshipExecutionEvidence;

  constructor(
    code: IssueRelationshipExecutorErrorCode,
    message: string,
    diagnostics: readonly IssueRelationshipDiagnostic[] = [],
    evidence?: IssueRelationshipExecutionEvidence,
  ) {
    super(message);
    this.name = "IssueRelationshipExecutorError";
    this.code = code;
    this.diagnostics = Object.freeze([...diagnostics]);
    this.evidence = evidence;
  }
}

interface RelationshipSnapshot {
  readonly child: IssueRelationshipObservedState;
  readonly parents: readonly IssueRelationshipObservedState[];
}

const MAX_GRAPH_NODES = 200;

function diagnostic(code: string, path: string, message: string): IssueRelationshipDiagnostic {
  return { code: code as IssueRelationshipDiagnostic["code"], path, message };
}

function isReference(value: unknown): value is IssueReference {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameReference(left: IssueReference | undefined, right: IssueReference | undefined): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.repositoryHost.toLowerCase() === right.repositoryHost.toLowerCase() &&
        left.repositoryId === right.repositoryId &&
        left.number === right.number;
}

function sameState(left: IssueRelationshipObservedState, right: IssueRelationshipObservedState): boolean {
  return (
    sameReference(left.parent, right.parent) &&
    left.children.length === right.children.length &&
    left.children.every((entry, index) => sameReference(entry, right.children[index])) &&
    left.parentStatus === right.parentStatus &&
    left.childrenStatus === right.childrenStatus &&
    left.status === right.status
  );
}

function containsChild(state: IssueRelationshipObservedState, child: IssueReference): boolean {
  return state.children.some((entry) => sameReference(entry, child));
}

function issueReference(context: RepositoryContext, value: number | IssueReference, path: string): IssueReference {
  if (isReference(value)) {
    const normalized = normalizeIssueReference(value, path);
    if (!normalized.valid || normalized.reference === undefined)
      throw new IssueRelationshipExecutorError(
        "ISSUE_RELATIONSHIP_REQUEST_INVALID",
        "Issue relationship references must be valid IssueReference objects.",
        [diagnostic("RELATION_REFERENCE_INVALID", path, "The relationship reference is invalid.")],
      );
    const resolved = normalized.reference;
    if (
      resolved.repositoryHost.toLowerCase() !== context.hostname.toLowerCase() ||
      resolved.repositoryId !== context.repositoryId
    )
      throw new IssueRelationshipExecutorError(
        "ISSUE_RELATIONSHIP_REQUEST_INVALID",
        "Native parent/sub-issue relationships must use the resolved repository identity.",
        [
          diagnostic(
            "RELATION_CROSS_REPOSITORY_UNSUPPORTED",
            path,
            "The relationship target is outside the resolved repository.",
          ),
        ],
      );
    return resolved;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || context.repositoryId === undefined)
    throw new IssueRelationshipExecutorError(
      "ISSUE_RELATIONSHIP_REQUEST_INVALID",
      "Issue numbers must be positive safe integers and the repository must have a database identity.",
      [diagnostic("RELATION_INPUT_INVALID", path, "A valid Issue number and repository identity are required.")],
    );
  return {
    repositoryHost: context.hostname,
    repositoryId: context.repositoryId,
    repository: context.nameWithOwner,
    number: value,
  };
}

function stateFromEvidence(
  subject: IssueReference,
  parent: IssueParentObservation,
  children: IssueChildrenObservation,
): IssueRelationshipObservedState {
  const parentStatus =
    parent.kind === "empty"
      ? "empty"
      : parent.kind === "present"
        ? "present"
        : parent.kind === "malformed"
          ? "ambiguous"
          : "unavailable";
  const childrenStatus =
    children.kind === "empty"
      ? "empty"
      : children.kind === "present"
        ? "present"
        : children.kind === "malformed"
          ? "ambiguous"
          : "unavailable";
  return {
    subject,
    ...(parent.kind === "present" && parent.reference !== undefined ? { parent: parent.reference } : {}),
    children: children.kind === "present" ? children.references : [],
    parentStatus,
    childrenStatus,
    status:
      parentStatus === "empty" || parentStatus === "present"
        ? childrenStatus === "empty" || childrenStatus === "present"
          ? "complete"
          : childrenStatus
        : parentStatus,
  };
}

function relationDiagnostics(
  parent: IssueParentObservation,
  children: IssueChildrenObservation,
): readonly IssueRelationshipDiagnostic[] {
  return [
    ...parent.diagnostics.map((entry) => diagnostic(entry.code, "$.parent", entry.message)),
    ...children.diagnostics.map((entry) => diagnostic(entry.code, "$.children", entry.message)),
  ];
}

export class LocalIssueRelationshipExecutor {
  readonly #adapter: GitHubIssueRelationMutationAdapter;
  readonly #context: RepositoryContext;

  constructor(options: { readonly adapter: GitHubIssueRelationMutationAdapter; readonly context: RepositoryContext }) {
    this.#adapter = options.adapter;
    this.#context = options.context;
  }

  async inspectParent(value: number | IssueReference): Promise<IssueRelationshipInspection> {
    const issue = issueReference(this.#context, value, "$.issue");
    const observation = await this.#adapter.observeParent(issue.number);
    if (observation.kind !== "empty" && observation.kind !== "present")
      throw new IssueRelationshipExecutorError(
        "ISSUE_RELATIONSHIP_READ_FAILED",
        "The native parent relationship could not be read completely.",
        observation.diagnostics.map((entry) => diagnostic(entry.code, "$.parent", entry.message)),
      );
    return {
      version: ISSUE_RELATIONSHIP_EXECUTOR_VERSION,
      operation: "inspect-parent",
      issue,
      ...(observation.reference === undefined ? {} : { parent: observation.reference }),
      evidence: { status: observation.kind, diagnostics: observation.diagnostics },
    };
  }

  async inspectChildren(value: number | IssueReference): Promise<IssueRelationshipInspection> {
    const issue = issueReference(this.#context, value, "$.issue");
    const observation = await this.#adapter.observeChildren(issue.number);
    if (observation.kind !== "empty" && observation.kind !== "present")
      throw new IssueRelationshipExecutorError(
        "ISSUE_RELATIONSHIP_READ_FAILED",
        "The native direct-child relationship could not be read completely.",
        observation.diagnostics.map((entry) => diagnostic(entry.code, "$.children", entry.message)),
      );
    return {
      version: ISSUE_RELATIONSHIP_EXECUTOR_VERSION,
      operation: "inspect-children",
      issue,
      children: observation.references,
      evidence: { status: observation.kind, diagnostics: observation.diagnostics },
    };
  }

  async execute(request: IssueRelationshipMutationRequest): Promise<IssueRelationshipExecutionResult> {
    const child = issueReference(this.#context, request.child, "$.child");
    const parent = request.parent === undefined ? undefined : issueReference(this.#context, request.parent, "$.parent");
    const previousParent =
      request.previousParent === undefined
        ? undefined
        : issueReference(this.#context, request.previousParent, "$.previousParent");
    let initial = await this.readSnapshot(child, parent, previousParent);
    const effectiveParent = request.operation === "detach" ? (parent ?? initial.child.parent) : parent;
    if (effectiveParent !== parent) initial = await this.readSnapshot(child, effectiveParent, previousParent);
    const initialPlan = await this.plan(request.operation, child, effectiveParent, previousParent, initial);
    if (initialPlan.effects.length === 0) {
      return {
        plan: initialPlan,
        observed: initial,
        postcondition: initial,
        evidence: {
          version: ISSUE_RELATIONSHIP_EXECUTOR_VERSION,
          outcome: "idempotent",
          effects: [],
        },
      };
    }

    const fresh = await this.readSnapshot(child, initialPlan.parent, initialPlan.previousParent);
    const freshPlan = await this.plan(request.operation, child, initialPlan.parent, initialPlan.previousParent, fresh);
    if (freshPlan.effects.length === 0) {
      return {
        plan: freshPlan,
        observed: fresh,
        postcondition: fresh,
        evidence: {
          version: ISSUE_RELATIONSHIP_EXECUTOR_VERSION,
          outcome: "idempotent",
          effects: [],
        },
      };
    }
    if (!sameSnapshot(initial, fresh))
      throw new IssueRelationshipExecutorError(
        "ISSUE_RELATIONSHIP_STALE",
        "The provider relationship state changed while the mutation was being admitted.",
        [
          diagnostic(
            "RELATION_STALE",
            "$.observed",
            "The fresh provider relationship state differs from the initial observation.",
          ),
        ],
      );

    const statuses: Array<"succeeded" | "failed" | "skipped"> = freshPlan.effects.map(() => "skipped");
    let failedIndex = -1;
    try {
      for (let index = 0; index < freshPlan.effects.length; index += 1) {
        await this.executeEffect(freshPlan.effects[index] as IssueRelationshipEffect);
        statuses[index] = "succeeded";
      }
    } catch {
      failedIndex = statuses.findIndex((status) => status === "skipped");
      if (failedIndex === -1) failedIndex = statuses.length - 1;
      statuses[failedIndex] = "failed";

      const hasSucceededEffect = statuses.includes("succeeded");
      const effects = freshPlan.effects.map((effect, index) => ({ kind: effect.kind, status: statuses[index] }));

      if (!hasSucceededEffect)
        throw new IssueRelationshipExecutorError(
          "ISSUE_RELATIONSHIP_EFFECT_FAILED",
          "A native parent/sub-issue mutation failed before any effect took hold; no provider state changed.",
          [
            diagnostic(
              "RELATION_EFFECT_FAILED",
              `$.effects[${failedIndex}]`,
              "The provider rejected a relationship effect.",
            ),
          ],
          { version: ISSUE_RELATIONSHIP_EXECUTOR_VERSION, outcome: "verified", effects },
        );

      let recoverySnapshot: RelationshipSnapshot;
      try {
        recoverySnapshot = await this.readSnapshot(child, freshPlan.parent, freshPlan.previousParent);
      } catch {
        throw new IssueRelationshipExecutorError(
          "ISSUE_RELATIONSHIP_RECOVERY_READ_FAILED",
          "A native parent/sub-issue mutation partially applied and the authoritative recovery state could not be reread; the provider relationship is left in an unverified, possibly inconsistent state.",
          [
            diagnostic(
              "RELATION_RECOVERY_READ_FAILED",
              `$.effects[${failedIndex}]`,
              "The provider relationship state could not be reread after a partial mutation failure.",
            ),
          ],
          { version: ISSUE_RELATIONSHIP_EXECUTOR_VERSION, outcome: "partial-effect", effects },
        );
      }

      throw new IssueRelationshipExecutorError(
        "ISSUE_RELATIONSHIP_EFFECT_FAILED",
        "A native parent/sub-issue mutation partially applied; the provider relationship changed but the requested operation did not complete. No compensation was attempted.",
        [
          diagnostic(
            "RELATION_PARTIAL_EFFECT",
            `$.effects[${failedIndex}]`,
            "The provider rejected a relationship effect after a prior effect in the same operation already applied.",
          ),
        ],
        {
          version: ISSUE_RELATIONSHIP_EXECUTOR_VERSION,
          outcome: "partial-effect",
          effects,
          recovery: recoverySnapshot,
        },
      );
    }

    const postcondition = await this.readSnapshot(child, freshPlan.parent, freshPlan.previousParent);
    const postconditionDiagnostics = verifyPostcondition(freshPlan, postcondition);
    if (postconditionDiagnostics.length > 0)
      throw new IssueRelationshipExecutorError(
        "ISSUE_RELATIONSHIP_POSTCONDITION_FAILED",
        "The provider relationship mutation completed without the requested verified postcondition.",
        postconditionDiagnostics,
        {
          version: ISSUE_RELATIONSHIP_EXECUTOR_VERSION,
          outcome: "verified",
          effects: freshPlan.effects.map((effect) => ({ kind: effect.kind, status: "succeeded" as const })),
        },
      );
    return {
      plan: freshPlan,
      observed: fresh,
      postcondition,
      evidence: {
        version: ISSUE_RELATIONSHIP_EXECUTOR_VERSION,
        outcome: "verified",
        effects: freshPlan.effects.map((effect) => ({ kind: effect.kind, status: "succeeded" as const })),
      },
    };
  }

  private async readSnapshot(
    child: IssueReference,
    parent: IssueReference | undefined,
    previousParent: IssueReference | undefined,
  ): Promise<RelationshipSnapshot> {
    const parentTargets = [parent, previousParent].filter((entry): entry is IssueReference => entry !== undefined);
    const uniqueTargets = [
      ...new Map(parentTargets.map((entry) => [`${entry.repositoryId}:${entry.number}`, entry])).values(),
    ];
    const [childParent, childChildren, ...targetResults] = await Promise.all([
      this.#adapter.observeParent(child.number),
      this.#adapter.observeChildren(child.number),
      ...uniqueTargets.flatMap((target) => [
        this.#adapter.observeParent(target.number),
        this.#adapter.observeChildren(target.number),
      ]),
    ]);
    const childState = stateFromEvidence(child, childParent, childChildren);
    const targets: IssueRelationshipObservedState[] = [];
    for (let index = 0; index < uniqueTargets.length; index += 1) {
      const targetParent = targetResults[index * 2];
      const targetChildren = targetResults[index * 2 + 1];
      if (targetParent === undefined || targetChildren === undefined) continue;
      targets.push(
        stateFromEvidence(
          uniqueTargets[index] as IssueReference,
          targetParent as IssueParentObservation,
          targetChildren as IssueChildrenObservation,
        ),
      );
    }
    const errors = [
      ...relationDiagnostics(childParent, childChildren),
      ...targetResults.flatMap((entry, index) =>
        index % 2 === 0
          ? relationDiagnostics(entry as IssueParentObservation, targetResults[index + 1] as IssueChildrenObservation)
          : [],
      ),
    ];
    if (childState.status !== "complete" || targets.some((entry) => entry.status !== "complete"))
      throw new IssueRelationshipExecutorError(
        "ISSUE_RELATIONSHIP_READ_FAILED",
        "Complete provider parent and direct-child evidence is required before mutation.",
        errors.length > 0
          ? errors
          : [diagnostic("RELATION_EVIDENCE_UNAVAILABLE", "$.observed", "Provider evidence is incomplete.")],
      );
    return { child: childState, parents: targets };
  }

  private async plan(
    operation: IssueRelationshipOperation,
    child: IssueReference,
    parent: IssueReference | undefined,
    previousParent: IssueReference | undefined,
    snapshot: RelationshipSnapshot,
  ): Promise<IssueRelationshipMutationPlan> {
    const graph = operation === "detach" ? undefined : await this.readParentGraph(child, parent, snapshot.child.parent);
    const result = tryPlanIssueRelationshipMutation({
      operation,
      child,
      ...(parent === undefined ? {} : { parent }),
      ...(previousParent === undefined ? {} : { previousParent }),
      observed: snapshot.child,
      parentObservations: snapshot.parents,
      ...(graph === undefined ? {} : { graph }),
    });
    if (!result.valid || result.plan === undefined)
      throw new IssueRelationshipExecutorError(
        "ISSUE_RELATIONSHIP_REQUEST_INVALID",
        "The relationship mutation was rejected by the Core authority.",
        result.diagnostics,
      );
    return result.plan;
  }

  private async readParentGraph(
    child: IssueReference,
    target: IssueReference | undefined,
    currentParent: IssueReference | undefined,
  ): Promise<{
    readonly scope: "complete";
    readonly nodes: readonly { readonly reference: IssueReference; readonly parent?: IssueReference }[];
  }> {
    if (target === undefined)
      throw new IssueRelationshipExecutorError(
        "ISSUE_RELATIONSHIP_REQUEST_INVALID",
        "A parent target is required for this relationship operation.",
        [
          diagnostic(
            "RELATION_PARENT_REQUIRED",
            "$.parent",
            "A complete graph cannot be built without a parent target.",
          ),
        ],
      );
    const queue: IssueReference[] = [child, target];
    const nodes = new Map<string, { readonly reference: IssueReference; readonly parent?: IssueReference }>();
    if (currentParent !== undefined)
      nodes.set(`${child.repositoryId}:${child.number}`, { reference: child, parent: currentParent });
    while (queue.length > 0) {
      const current = queue.shift() as IssueReference;
      const key = `${current.repositoryId}:${current.number}`;
      if (nodes.has(key) && current.number !== child.number) continue;
      if (nodes.size >= MAX_GRAPH_NODES)
        throw new IssueRelationshipExecutorError(
          "ISSUE_RELATIONSHIP_READ_FAILED",
          "The relationship graph exceeded the bounded live-read limit.",
          [
            diagnostic(
              "RELATION_EVIDENCE_UNAVAILABLE",
              "$.graph",
              "The relationship graph is too large to verify safely.",
            ),
          ],
        );
      const observation = await this.#adapter.observeParent(current.number);
      if (observation.kind !== "empty" && observation.kind !== "present")
        throw new IssueRelationshipExecutorError(
          "ISSUE_RELATIONSHIP_READ_FAILED",
          "The relationship graph could not be reread completely.",
          observation.diagnostics.map((entry) => diagnostic(entry.code, "$.graph", entry.message)),
        );
      const parent = observation.kind === "present" ? observation.reference : undefined;
      nodes.set(key, { reference: current, ...(parent === undefined ? {} : { parent }) });
      if (parent !== undefined) queue.push(parent);
    }
    return { scope: "complete", nodes: [...nodes.values()] };
  }

  private async executeEffect(effect: IssueRelationshipEffect): Promise<void> {
    if (effect.kind === "ATTACH_CHILD") return this.#adapter.attachChild(effect.parent, effect.child);
    return this.#adapter.detachChild(effect.parent, effect.child);
  }
}

function sameSnapshot(left: RelationshipSnapshot, right: RelationshipSnapshot): boolean {
  return (
    sameState(left.child, right.child) &&
    left.parents.length === right.parents.length &&
    left.parents.every((entry, index) => sameState(entry, right.parents[index] as IssueRelationshipObservedState))
  );
}

function verifyPostcondition(
  plan: IssueRelationshipMutationPlan,
  snapshot: RelationshipSnapshot,
): readonly IssueRelationshipDiagnostic[] {
  const diagnostics: IssueRelationshipDiagnostic[] = [];
  const parent = plan.parent;
  const previousParent = plan.previousParent;
  if (plan.operation === "attach") {
    if (parent === undefined || !sameReference(snapshot.child.parent, parent))
      diagnostics.push(
        diagnostic(
          "RELATION_POSTCONDITION_FAILED",
          "$.postcondition.parent",
          "The child parent does not match the attached parent.",
        ),
      );
    const target = snapshot.parents.find((entry) => parent !== undefined && sameReference(entry.subject, parent));
    if (target === undefined || !containsChild(target, plan.child))
      diagnostics.push(
        diagnostic(
          "RELATION_POSTCONDITION_FAILED",
          "$.postcondition.children",
          "The new parent does not list the child.",
        ),
      );
  } else if (plan.operation === "detach") {
    if (snapshot.child.parent !== undefined)
      diagnostics.push(
        diagnostic(
          "RELATION_POSTCONDITION_FAILED",
          "$.postcondition.parent",
          "The child still has a parent after detach.",
        ),
      );
    const target = snapshot.parents.find((entry) => parent !== undefined && sameReference(entry.subject, parent));
    if (target !== undefined && containsChild(target, plan.child))
      diagnostics.push(
        diagnostic(
          "RELATION_POSTCONDITION_FAILED",
          "$.postcondition.children",
          "The old parent still lists the child.",
        ),
      );
  } else {
    if (parent === undefined || previousParent === undefined || !sameReference(snapshot.child.parent, parent))
      diagnostics.push(
        diagnostic(
          "RELATION_POSTCONDITION_FAILED",
          "$.postcondition.parent",
          "The child parent does not match the new parent.",
        ),
      );
    const oldTarget = snapshot.parents.find((entry) => sameReference(entry.subject, previousParent));
    const newTarget = snapshot.parents.find((entry) => sameReference(entry.subject, parent));
    if (oldTarget !== undefined && containsChild(oldTarget, plan.child))
      diagnostics.push(
        diagnostic(
          "RELATION_POSTCONDITION_FAILED",
          "$.postcondition.previousParent",
          "The old parent still lists the child.",
        ),
      );
    if (newTarget === undefined || !containsChild(newTarget, plan.child))
      diagnostics.push(
        diagnostic(
          "RELATION_POSTCONDITION_FAILED",
          "$.postcondition.parent",
          "The new parent does not list the child.",
        ),
      );
  }
  return diagnostics;
}
