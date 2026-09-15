import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planIssueRelationshipMutation,
  tryPlanIssueRelationshipMutation,
  validateIssueParentRelationshipGraph,
  type IssueRelationshipObservedState,
} from "./issue-relationship.js";
import type { IssueReference } from "./contract/issue-reference.js";

const repository = { repositoryHost: "github.com", repositoryId: "100", repository: "acme/inari" };

function issue(number: number): IssueReference {
  return { ...repository, number };
}

function state(
  subject: IssueReference,
  parent: IssueReference | undefined,
  children: readonly IssueReference[],
): IssueRelationshipObservedState {
  return {
    subject,
    ...(parent === undefined ? {} : { parent }),
    children,
    parentStatus: parent === undefined ? "empty" : "present",
    childrenStatus: children.length === 0 ? "empty" : "present",
    status: "complete",
  };
}

const child = issue(1);
const oldParent = issue(2);
const newParent = issue(3);

test("plans attach, detach, explicit reparent, and idempotent replay", () => {
  const graph = {
    scope: "complete",
    nodes: [{ reference: child }, { reference: oldParent }, { reference: newParent }],
  } as const;
  const attach = planIssueRelationshipMutation({
    operation: "attach",
    child,
    parent: oldParent,
    observed: state(child, undefined, []),
    parentObservations: [state(oldParent, undefined, [])],
    graph,
  });
  assert.deepEqual(attach.effects, [{ kind: "ATTACH_CHILD", child, parent: oldParent }]);

  const idempotent = planIssueRelationshipMutation({
    operation: "attach",
    child,
    parent: oldParent,
    observed: state(child, oldParent, []),
    parentObservations: [state(oldParent, undefined, [child])],
  });
  assert.deepEqual(idempotent.effects, []);

  const detach = planIssueRelationshipMutation({
    operation: "detach",
    child,
    parent: oldParent,
    observed: state(child, oldParent, []),
    parentObservations: [state(oldParent, undefined, [child])],
  });
  assert.deepEqual(detach.effects, [{ kind: "DETACH_CHILD", child, parent: oldParent }]);

  const reparent = planIssueRelationshipMutation({
    operation: "reparent",
    child,
    previousParent: oldParent,
    parent: newParent,
    observed: state(child, oldParent, []),
    parentObservations: [state(oldParent, undefined, [child]), state(newParent, undefined, [])],
    graph,
  });
  assert.deepEqual(reparent.effects, [
    { kind: "DETACH_CHILD", child, parent: oldParent },
    { kind: "ATTACH_CHILD", child, parent: newParent },
  ]);
});

test("rejects self-parenting, cycles, and provider ambiguity", () => {
  const self = tryPlanIssueRelationshipMutation({
    operation: "attach",
    child,
    parent: child,
    observed: state(child, undefined, []),
    parentObservations: [state(child, undefined, [])],
    graph: { scope: "complete", nodes: [{ reference: child }] },
  });
  assert.equal(self.valid, false);
  assert.ok(self.diagnostics.some((entry) => entry.code === "RELATION_SELF"));

  const cycle = tryPlanIssueRelationshipMutation({
    operation: "attach",
    child,
    parent: newParent,
    observed: state(child, undefined, []),
    parentObservations: [state(newParent, child, [])],
    graph: {
      scope: "complete",
      nodes: [{ reference: child }, { reference: newParent, parent: child }],
    },
  });
  assert.equal(cycle.valid, false);
  assert.ok(cycle.diagnostics.some((entry) => entry.code === "RELATION_PARENT_CYCLE"));

  const ambiguity = tryPlanIssueRelationshipMutation({
    operation: "attach",
    child,
    parent: oldParent,
    observed: state(child, oldParent, []),
    parentObservations: [state(oldParent, undefined, [])],
  });
  assert.equal(ambiguity.valid, false);
  assert.ok(ambiguity.diagnostics.some((entry) => entry.code === "RELATION_PROVIDER_AMBIGUOUS"));

  const graph = validateIssueParentRelationshipGraph({
    scope: "complete",
    nodes: [{ reference: child, parent: newParent }, { reference: newParent }],
  });
  assert.equal(graph.valid, true);
});
