/**
 * Provider-neutral parent/sub-issue relationship authority.
 *
 * This model deliberately stores the parent edge as the forward authority and
 * treats direct children as an observed inverse view.  It has no GitHub or
 * Markdown knowledge; provider adapters supply the observed state and execute
 * the admitted effects.
 */

import { issueReferenceKey, normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";

export const ISSUE_RELATIONSHIP_MODEL_VERSION = "1" as const;
export type IssueRelationshipModelVersion = typeof ISSUE_RELATIONSHIP_MODEL_VERSION;

export type IssueRelationshipOperation = "attach" | "detach" | "reparent";

export type IssueRelationshipEvidenceStatus = "complete" | "unavailable" | "ambiguous";

export interface IssueRelationshipObservedState {
  readonly subject: IssueReference;
  readonly parent?: IssueReference;
  readonly children: readonly IssueReference[];
  readonly parentStatus: "empty" | "present" | "unavailable" | "ambiguous";
  readonly childrenStatus: "empty" | "present" | "unavailable" | "ambiguous";
  readonly status: IssueRelationshipEvidenceStatus;
}

export interface IssueRelationshipGraphNode {
  readonly reference: IssueReference;
  readonly parent?: IssueReference;
}

export interface IssueRelationshipGraph {
  readonly scope: "complete" | "unavailable";
  readonly nodes: readonly IssueRelationshipGraphNode[];
}

export type IssueRelationshipEffect =
  | {
      readonly kind: "ATTACH_CHILD";
      readonly child: IssueReference;
      readonly parent: IssueReference;
    }
  | {
      readonly kind: "DETACH_CHILD";
      readonly child: IssueReference;
      readonly parent: IssueReference;
    };

export interface IssueRelationshipMutationPlan {
  readonly version: IssueRelationshipModelVersion;
  readonly kind: "issue-parent-sub-issues";
  readonly operation: IssueRelationshipOperation;
  readonly child: IssueReference;
  readonly parent?: IssueReference;
  readonly previousParent?: IssueReference;
  readonly observed: IssueRelationshipObservedState;
  readonly parentObservations: readonly IssueRelationshipObservedState[];
  readonly graph?: IssueRelationshipGraph;
  readonly effects: readonly IssueRelationshipEffect[];
}

export type IssueRelationshipDiagnosticCode =
  | "RELATION_INPUT_INVALID"
  | "RELATION_INPUT_UNKNOWN_PROPERTY"
  | "RELATION_REFERENCE_INVALID"
  | "RELATION_REFERENCE_DUPLICATE"
  | "RELATION_SELF"
  | "RELATION_CROSS_REPOSITORY_UNSUPPORTED"
  | "RELATION_PARENT_REQUIRED"
  | "RELATION_REPARENT_REQUIRED"
  | "RELATION_PARENT_MISMATCH"
  | "RELATION_PROVIDER_AMBIGUOUS"
  | "RELATION_EVIDENCE_UNAVAILABLE"
  | "RELATION_PARENT_CYCLE"
  | "RELATION_STALE"
  | "RELATION_EFFECT_FAILED"
  | "RELATION_PARTIAL_EFFECT"
  | "RELATION_RECOVERY_READ_FAILED"
  | "RELATION_POSTCONDITION_FAILED"
  | "RELATION_PLAN_INVALID";

export interface IssueRelationshipDiagnostic {
  readonly code: IssueRelationshipDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface IssueRelationshipGraphResult {
  readonly valid: boolean;
  readonly graph?: IssueRelationshipGraph;
  readonly diagnostics: readonly IssueRelationshipDiagnostic[];
}

export interface IssueRelationshipMutationPlanResult {
  readonly valid: boolean;
  readonly plan?: IssueRelationshipMutationPlan;
  readonly diagnostics: readonly IssueRelationshipDiagnostic[];
}

export interface IssueRelationshipMutationPlanningInput {
  readonly operation: IssueRelationshipOperation;
  readonly child: unknown;
  readonly parent?: unknown;
  readonly previousParent?: unknown;
  readonly observed: unknown;
  readonly parentObservations?: unknown;
  readonly graph?: unknown;
}

type RecordValue = Record<string, unknown>;

const OBSERVED_KEYS = new Set(["subject", "parent", "children", "parentStatus", "childrenStatus", "status"]);
const GRAPH_KEYS = new Set(["scope", "nodes"]);
const NODE_KEYS = new Set(["reference", "parent"]);
const PLAN_LIMIT = 1_000;

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function diagnostic(code: IssueRelationshipDiagnosticCode, path: string, message: string): IssueRelationshipDiagnostic {
  return { code, path, message };
}

function compareReferences(left: IssueReference, right: IssueReference): number {
  return (
    left.repositoryHost.localeCompare(right.repositoryHost, "en-US") ||
    left.repositoryId.localeCompare(right.repositoryId, "en-US") ||
    left.number - right.number
  );
}

function sameReference(left: IssueReference | undefined, right: IssueReference | undefined): boolean {
  return left === undefined || right === undefined
    ? left === right
    : issueReferenceKey(left) === issueReferenceKey(right);
}

export function sameIssueRelationshipReference(left: IssueReference, right: IssueReference): boolean {
  return issueReferenceKey(left) === issueReferenceKey(right);
}

export function sameIssueRelationshipState(
  left: IssueRelationshipObservedState,
  right: IssueRelationshipObservedState,
): boolean {
  return (
    sameReference(left.parent, right.parent) &&
    left.children.length === right.children.length &&
    left.children.every((entry, index) => sameReference(entry, right.children[index])) &&
    left.parentStatus === right.parentStatus &&
    left.childrenStatus === right.childrenStatus &&
    left.status === right.status
  );
}

function sameRepository(left: IssueReference, right: IssueReference): boolean {
  return (
    left.repositoryHost.toLowerCase() === right.repositoryHost.toLowerCase() && left.repositoryId === right.repositoryId
  );
}

function unknownProperties(
  value: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: IssueRelationshipDiagnostic[],
): void {
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, "en-US"))) {
    if (!allowed.has(key))
      diagnostics.push(
        diagnostic("RELATION_INPUT_UNKNOWN_PROPERTY", `${path}.${key}`, `Property "${key}" is not supported.`),
      );
  }
}

function reference(
  input: unknown,
  path: string,
  diagnostics: IssueRelationshipDiagnostic[],
): IssueReference | undefined {
  const result = normalizeIssueReference(input, path);
  if (!result.valid || result.reference === undefined) {
    diagnostics.push(diagnostic("RELATION_REFERENCE_INVALID", path, "IssueReference is invalid."));
    return undefined;
  }
  return result.reference;
}

function references(
  input: unknown,
  path: string,
  diagnostics: IssueRelationshipDiagnostic[],
): readonly IssueReference[] | undefined {
  if (!Array.isArray(input)) {
    diagnostics.push(diagnostic("RELATION_REFERENCE_INVALID", path, "Relation references must be an array."));
    return undefined;
  }
  if (input.length > PLAN_LIMIT) {
    diagnostics.push(diagnostic("RELATION_REFERENCE_INVALID", path, "Relation references exceed the bounded limit."));
    return undefined;
  }
  const result: IssueReference[] = [];
  const seen = new Set<string>();
  input.forEach((entry, index) => {
    const parsed = reference(entry, `${path}[${index}]`, diagnostics);
    if (parsed === undefined) return;
    const key = issueReferenceKey(parsed);
    if (seen.has(key)) {
      diagnostics.push(
        diagnostic("RELATION_REFERENCE_DUPLICATE", `${path}[${index}]`, "Relation references must be unique."),
      );
      return;
    }
    seen.add(key);
    result.push(parsed);
  });
  return result.sort(compareReferences);
}

function statusIsComplete(value: unknown): value is "empty" | "present" {
  return value === "empty" || value === "present";
}

function parseObserved(
  input: unknown,
  path: string,
  diagnostics: IssueRelationshipDiagnostic[],
): IssueRelationshipObservedState | undefined {
  if (!isRecord(input)) {
    diagnostics.push(diagnostic("RELATION_INPUT_INVALID", path, "Observed relationship state must be an object."));
    return undefined;
  }
  unknownProperties(input, OBSERVED_KEYS, path, diagnostics);
  const subject = reference(input.subject, `${path}.subject`, diagnostics);
  const parent = input.parent === undefined ? undefined : reference(input.parent, `${path}.parent`, diagnostics);
  const children = references(input.children, `${path}.children`, diagnostics);
  const parentStatus = input.parentStatus;
  const childrenStatus = input.childrenStatus;
  const status = input.status;
  if (!statusIsComplete(parentStatus) && !["unavailable", "ambiguous"].includes(parentStatus as string))
    diagnostics.push(diagnostic("RELATION_INPUT_INVALID", `${path}.parentStatus`, "Invalid parent evidence status."));
  if (!statusIsComplete(childrenStatus) && !["unavailable", "ambiguous"].includes(childrenStatus as string))
    diagnostics.push(
      diagnostic("RELATION_INPUT_INVALID", `${path}.childrenStatus`, "Invalid children evidence status."),
    );
  if (!["complete", "unavailable", "ambiguous"].includes(status as string))
    diagnostics.push(diagnostic("RELATION_INPUT_INVALID", `${path}.status`, "Invalid relationship evidence status."));
  if (subject === undefined || children === undefined) return undefined;
  if (children.some((entry) => sameIssueRelationshipReference(entry, subject)))
    diagnostics.push(diagnostic("RELATION_SELF", `${path}.children`, "An Issue cannot be its own direct child."));
  return {
    subject,
    ...(parent === undefined ? {} : { parent }),
    children,
    parentStatus: parentStatus as IssueRelationshipObservedState["parentStatus"],
    childrenStatus: childrenStatus as IssueRelationshipObservedState["childrenStatus"],
    status: status as IssueRelationshipEvidenceStatus,
  };
}

function parseGraph(input: unknown, diagnostics: IssueRelationshipDiagnostic[]): IssueRelationshipGraph | undefined {
  if (!isRecord(input)) {
    diagnostics.push(diagnostic("RELATION_EVIDENCE_UNAVAILABLE", "$.graph", "Relationship graph must be an object."));
    return undefined;
  }
  unknownProperties(input, GRAPH_KEYS, "$.graph", diagnostics);
  if (input.scope !== "complete") {
    diagnostics.push(
      diagnostic("RELATION_EVIDENCE_UNAVAILABLE", "$.graph.scope", "A complete relationship graph is required."),
    );
  }
  if (!Array.isArray(input.nodes) || input.nodes.length > PLAN_LIMIT) {
    diagnostics.push(
      diagnostic("RELATION_EVIDENCE_UNAVAILABLE", "$.graph.nodes", "A bounded complete graph node list is required."),
    );
    return undefined;
  }
  const nodes: IssueRelationshipGraphNode[] = [];
  const seen = new Set<string>();
  input.nodes.forEach((entry, index) => {
    if (!isRecord(entry)) {
      diagnostics.push(diagnostic("RELATION_INPUT_INVALID", `$.graph.nodes[${index}]`, "Graph nodes must be objects."));
      return;
    }
    unknownProperties(entry, NODE_KEYS, `$.graph.nodes[${index}]`, diagnostics);
    const nodeReference = reference(entry.reference, `$.graph.nodes[${index}].reference`, diagnostics);
    const parent =
      entry.parent === undefined ? undefined : reference(entry.parent, `$.graph.nodes[${index}].parent`, diagnostics);
    if (nodeReference === undefined) return;
    const key = issueReferenceKey(nodeReference);
    if (seen.has(key)) {
      diagnostics.push(
        diagnostic("RELATION_REFERENCE_DUPLICATE", `$.graph.nodes[${index}]`, "Graph references must be unique."),
      );
      return;
    }
    seen.add(key);
    nodes.push({ reference: nodeReference, ...(parent === undefined ? {} : { parent }) });
  });
  const nodeKeys = new Set(nodes.map((entry) => issueReferenceKey(entry.reference)));
  for (const [index, node] of nodes.entries()) {
    if (node.parent !== undefined && !nodeKeys.has(issueReferenceKey(node.parent)))
      diagnostics.push(
        diagnostic(
          "RELATION_EVIDENCE_UNAVAILABLE",
          `$.graph.nodes[${index}].parent`,
          "A complete relationship graph must include every parent edge target.",
        ),
      );
    if (node.parent !== undefined && !sameRepository(node.reference, node.parent))
      diagnostics.push(
        diagnostic(
          "RELATION_CROSS_REPOSITORY_UNSUPPORTED",
          `$.graph.nodes[${index}].parent`,
          "Parent/sub-issue relationships must remain within one repository identity.",
        ),
      );
  }
  const graph: IssueRelationshipGraph = Object.freeze({
    scope: "complete",
    nodes: Object.freeze(nodes.sort((a, b) => compareReferences(a.reference, b.reference))),
  });
  const byKey = new Map(graph.nodes.map((entry) => [issueReferenceKey(entry.reference), entry]));
  for (const node of graph.nodes) {
    const visited = new Set<string>();
    let current: IssueRelationshipGraphNode | undefined = node;
    while (current?.parent !== undefined) {
      const key = issueReferenceKey(current.reference);
      if (visited.has(key)) {
        diagnostics.push(
          diagnostic("RELATION_PARENT_CYCLE", "$.graph", "The relationship graph contains a parent cycle."),
        );
        break;
      }
      visited.add(key);
      current = byKey.get(issueReferenceKey(current.parent));
      if (current === undefined) break;
    }
  }
  return graph;
}

function hasChild(state: IssueRelationshipObservedState, child: IssueReference): boolean {
  return state.children.some((entry) => sameIssueRelationshipReference(entry, child));
}

function completeState(
  state: IssueRelationshipObservedState | undefined,
  path: string,
  diagnostics: IssueRelationshipDiagnostic[],
): state is IssueRelationshipObservedState {
  if (state === undefined) return false;
  if (state.status !== "complete" || !statusIsComplete(state.parentStatus) || !statusIsComplete(state.childrenStatus)) {
    diagnostics.push(
      diagnostic("RELATION_EVIDENCE_UNAVAILABLE", path, "Complete provider relationship evidence is required."),
    );
    return false;
  }
  return true;
}

function proposedGraph(
  graph: IssueRelationshipGraph,
  child: IssueReference,
  nextParent: IssueReference | undefined,
  diagnostics: IssueRelationshipDiagnostic[],
): IssueRelationshipGraph | undefined {
  const nodes = graph.nodes.map((node) =>
    sameIssueRelationshipReference(node.reference, child)
      ? { reference: node.reference, ...(nextParent === undefined ? {} : { parent: nextParent }) }
      : node,
  );
  if (!nodes.some((node) => sameIssueRelationshipReference(node.reference, child))) {
    diagnostics.push(diagnostic("RELATION_EVIDENCE_UNAVAILABLE", "$.graph", "The graph must include the child Issue."));
    return undefined;
  }
  const next = parseGraph({ scope: "complete", nodes }, diagnostics);
  return next;
}

function requireSameRepository(
  child: IssueReference,
  parent: IssueReference | undefined,
  path: string,
  diagnostics: IssueRelationshipDiagnostic[],
): boolean {
  if (parent === undefined || sameRepository(child, parent)) return true;
  diagnostics.push(
    diagnostic(
      "RELATION_CROSS_REPOSITORY_UNSUPPORTED",
      path,
      "Parent/sub-issue relationships must remain within one repository identity.",
    ),
  );
  return false;
}

/** Validate a complete parent graph independently of a mutation plan. */
export function validateIssueParentRelationshipGraph(input: unknown): IssueRelationshipGraphResult {
  const diagnostics: IssueRelationshipDiagnostic[] = [];
  const graph = parseGraph(input, diagnostics);
  return diagnostics.length > 0 || graph === undefined
    ? { valid: false, diagnostics }
    : { valid: true, graph, diagnostics: [] };
}

/** Plan one explicit parent/sub-issue mutation from provider evidence. */
export function tryPlanIssueRelationshipMutation(
  input: IssueRelationshipMutationPlanningInput,
): IssueRelationshipMutationPlanResult {
  const diagnostics: IssueRelationshipDiagnostic[] = [];
  if (!isRecord(input))
    return {
      valid: false,
      diagnostics: [diagnostic("RELATION_INPUT_INVALID", "$", "Relationship mutation input must be an object.")],
    };
  const child = reference(input.child, "$.child", diagnostics);
  const parent = input.parent === undefined ? undefined : reference(input.parent, "$.parent", diagnostics);
  const previousParent =
    input.previousParent === undefined ? undefined : reference(input.previousParent, "$.previousParent", diagnostics);
  const observed = parseObserved(input.observed, "$.observed", diagnostics);
  const rawParentObservations = input.parentObservations ?? [];
  if (!Array.isArray(rawParentObservations))
    diagnostics.push(
      diagnostic("RELATION_INPUT_INVALID", "$.parentObservations", "Parent observations must be an array."),
    );
  const parentObservations: IssueRelationshipObservedState[] = [];
  const parentObservationKeys = new Set<string>();
  if (Array.isArray(rawParentObservations)) {
    rawParentObservations.forEach((entry, index) => {
      const parsed = parseObserved(entry, `$.parentObservations[${index}]`, diagnostics);
      if (parsed === undefined) return;
      const key = issueReferenceKey(parsed.subject);
      if (parentObservationKeys.has(key)) {
        diagnostics.push(
          diagnostic(
            "RELATION_PROVIDER_AMBIGUOUS",
            `$.parentObservations[${index}]`,
            "A parent Issue must have exactly one bounded provider observation.",
          ),
        );
        return;
      }
      parentObservationKeys.add(key);
      parentObservations.push(parsed);
    });
  }
  if (child === undefined || !completeState(observed, "$.observed", diagnostics)) return { valid: false, diagnostics };
  if (observed.subject.number !== child.number || !sameRepository(observed.subject, child))
    diagnostics.push(
      diagnostic("RELATION_STALE", "$.observed.subject", "Observed child identity does not match the request."),
    );
  const operation = input.operation;
  if (operation !== "attach" && operation !== "detach" && operation !== "reparent")
    diagnostics.push(
      diagnostic("RELATION_INPUT_INVALID", "$.operation", "Relationship mutation operation is unsupported."),
    );
  if (!requireSameRepository(child, parent, "$.parent", diagnostics)) return { valid: false, diagnostics };
  if (!requireSameRepository(child, previousParent, "$.previousParent", diagnostics))
    return { valid: false, diagnostics };
  if (parent !== undefined && child.number === parent.number && sameRepository(child, parent))
    diagnostics.push(diagnostic("RELATION_SELF", "$.parent", "An Issue cannot be its own parent."));
  if (previousParent !== undefined && child.number === previousParent.number && sameRepository(child, previousParent))
    diagnostics.push(diagnostic("RELATION_SELF", "$.previousParent", "An Issue cannot be its own parent."));
  for (const entry of parentObservations) {
    if (!completeState(entry, "$.parentObservations", diagnostics)) continue;
    if (!sameRepository(child, entry.subject))
      diagnostics.push(
        diagnostic(
          "RELATION_CROSS_REPOSITORY_UNSUPPORTED",
          "$.parentObservations",
          "Parent observations must belong to the child repository.",
        ),
      );
  }
  const targetObservation =
    parent === undefined
      ? undefined
      : parentObservations.find((entry) => sameIssueRelationshipReference(entry.subject, parent));
  const previousObservation =
    previousParent === undefined
      ? undefined
      : parentObservations.find((entry) => sameIssueRelationshipReference(entry.subject, previousParent));
  const effects: IssueRelationshipEffect[] = [];
  if (operation === "attach") {
    if (parent === undefined)
      diagnostics.push(diagnostic("RELATION_PARENT_REQUIRED", "$.parent", "Attach requires a parent."));
    else if (observed.parent !== undefined && !sameIssueRelationshipReference(observed.parent, parent))
      diagnostics.push(
        diagnostic(
          "RELATION_REPARENT_REQUIRED",
          "$.parent",
          "The child already has a different parent; use explicit reparent.",
        ),
      );
    else if (targetObservation === undefined)
      diagnostics.push(
        diagnostic(
          "RELATION_EVIDENCE_UNAVAILABLE",
          "$.parentObservations",
          "The parent direct-child evidence is required.",
        ),
      );
    else if (observed.parent !== undefined && !hasChild(targetObservation, child))
      diagnostics.push(
        diagnostic("RELATION_PROVIDER_AMBIGUOUS", "$.observed", "Provider parent and direct-child evidence disagree."),
      );
    else if (observed.parent === undefined && targetObservation !== undefined && hasChild(targetObservation, child))
      diagnostics.push(
        diagnostic("RELATION_PROVIDER_AMBIGUOUS", "$.observed", "Provider parent and direct-child evidence disagree."),
      );
    else if (observed.parent === undefined) effects.push({ kind: "ATTACH_CHILD", child, parent });
  } else if (operation === "detach") {
    const detachParent = parent ?? observed.parent;
    if (detachParent === undefined) {
      if (targetObservation !== undefined && hasChild(targetObservation, child))
        diagnostics.push(
          diagnostic(
            "RELATION_PROVIDER_AMBIGUOUS",
            "$.observed",
            "Provider direct-child evidence has no matching parent.",
          ),
        );
    } else if (observed.parent !== undefined && !sameIssueRelationshipReference(observed.parent, detachParent)) {
      diagnostics.push(
        diagnostic("RELATION_PARENT_MISMATCH", "$.parent", "The requested parent is not the child’s current parent."),
      );
    } else if (targetObservation === undefined) {
      diagnostics.push(
        diagnostic(
          "RELATION_EVIDENCE_UNAVAILABLE",
          "$.parentObservations",
          "The parent direct-child evidence is required.",
        ),
      );
    } else if (observed.parent !== undefined && !hasChild(targetObservation, child)) {
      diagnostics.push(
        diagnostic(
          "RELATION_PROVIDER_AMBIGUOUS",
          "$.parentObservations",
          "Provider parent and direct-child evidence disagree.",
        ),
      );
    } else if (observed.parent !== undefined) effects.push({ kind: "DETACH_CHILD", child, parent: detachParent });
  } else if (operation === "reparent") {
    if (parent === undefined)
      diagnostics.push(diagnostic("RELATION_PARENT_REQUIRED", "$.parent", "Reparent requires a new parent."));
    if (previousParent === undefined)
      diagnostics.push(
        diagnostic("RELATION_PARENT_REQUIRED", "$.previousParent", "Reparent requires the current parent explicitly."),
      );
    if (parent !== undefined && previousParent !== undefined && sameIssueRelationshipReference(parent, previousParent))
      diagnostics.push(
        diagnostic("RELATION_INPUT_INVALID", "$.parent", "Reparent requires distinct old and new parents."),
      );
    if (
      parent !== undefined &&
      previousParent !== undefined &&
      sameReference(observed.parent, previousParent) &&
      targetObservation !== undefined &&
      previousObservation !== undefined &&
      hasChild(previousObservation, child) &&
      !hasChild(targetObservation, child)
    ) {
      effects.push({ kind: "DETACH_CHILD", child, parent: previousParent });
      effects.push({ kind: "ATTACH_CHILD", child, parent });
    } else if (parent !== undefined && previousParent !== undefined && sameReference(observed.parent, parent)) {
      diagnostics.push(
        diagnostic("RELATION_PARENT_MISMATCH", "$.previousParent", "The child is already attached to the new parent."),
      );
    } else if (
      parent !== undefined &&
      previousParent !== undefined &&
      !sameReference(observed.parent, previousParent)
    ) {
      diagnostics.push(
        diagnostic(
          "RELATION_STALE",
          "$.previousParent",
          "The child’s current parent differs from the explicit old parent.",
        ),
      );
    } else if (parent !== undefined && previousParent !== undefined) {
      diagnostics.push(
        diagnostic(
          "RELATION_PROVIDER_AMBIGUOUS",
          "$.parentObservations",
          "Provider parent and direct-child evidence disagree.",
        ),
      );
    }
  }
  if (diagnostics.length > 0) return { valid: false, diagnostics };
  let graph: IssueRelationshipGraph | undefined;
  if (effects.length > 0) {
    if (operation !== "detach" && input.graph === undefined) {
      diagnostics.push(
        diagnostic(
          "RELATION_EVIDENCE_UNAVAILABLE",
          "$.graph",
          "A complete relationship graph is required before mutation.",
        ),
      );
    } else if (input.graph !== undefined) {
      graph = parseGraph(input.graph, diagnostics);
      const nextParent = operation === "detach" ? undefined : parent;
      if (graph !== undefined) graph = proposedGraph(graph, child, nextParent, diagnostics);
    }
  } else if (input.graph !== undefined) {
    graph = parseGraph(input.graph, diagnostics);
  }
  if (diagnostics.length > 0 || (graph === undefined && effects.length > 0 && operation !== "detach"))
    return { valid: false, diagnostics };
  const plan: IssueRelationshipMutationPlan = Object.freeze({
    version: ISSUE_RELATIONSHIP_MODEL_VERSION,
    kind: "issue-parent-sub-issues",
    operation,
    child,
    ...(parent === undefined ? {} : { parent }),
    ...(previousParent === undefined ? {} : { previousParent }),
    observed,
    parentObservations: Object.freeze([...parentObservations]),
    ...(graph === undefined ? {} : { graph }),
    effects: Object.freeze([...effects]),
  });
  return { valid: true, plan, diagnostics: [] };
}

export function planIssueRelationshipMutation(
  input: IssueRelationshipMutationPlanningInput,
): IssueRelationshipMutationPlan {
  const result = tryPlanIssueRelationshipMutation(input);
  if (!result.valid || result.plan === undefined) throw new IssueRelationshipError(result.diagnostics);
  return result.plan;
}

export class IssueRelationshipError extends Error {
  readonly diagnostics: readonly IssueRelationshipDiagnostic[];

  constructor(diagnostics: readonly IssueRelationshipDiagnostic[]) {
    super(diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join("\n"));
    this.name = "IssueRelationshipError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}
