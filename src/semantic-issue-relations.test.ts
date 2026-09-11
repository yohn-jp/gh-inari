import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planSemanticIssueRelations,
  serializeSemanticIssueRelationMutationPlan,
  tryPlanSemanticIssueRelations,
  validateSemanticIssueRelationMutationPlan,
  validateIssueRelationshipGraph,
} from "./semantic-issue-relations.js";
import type { IssueReference } from "./contract/issue-reference.js";

const repository = { repositoryHost: "github.com", repositoryId: "100", repository: "acme/inari" };

function issue(number: number, repositoryOverride = repository): IssueReference {
  return { ...repositoryOverride, number };
}

const capabilities = ["github.issue.blocked-by.native", "github.issue.parent.native"];

test("computes deterministic parent/dependency add deltas from authoritative empty evidence", () => {
  const plan = planSemanticIssueRelations({
    subject: issue(1),
    desired: { parent: issue(2), dependsOn: [issue(4), issue(3)] },
    observed: { parent: undefined, dependsOn: [] },
    capabilities,
    graph: {
      scope: "complete",
      nodes: [issue(1), issue(2), issue(3), issue(4)].map((reference) => ({ reference, dependsOn: [] })),
    },
  });
  assert.deepEqual(plan.effects, [
    { kind: "SET_PARENT_RELATION", parent: issue(2) },
    { kind: "ADD_BLOCKED_BY_RELATION", reference: issue(3) },
    { kind: "ADD_BLOCKED_BY_RELATION", reference: issue(4) },
  ]);
  assert.equal(serializeSemanticIssueRelationMutationPlan(plan), serializeSemanticIssueRelationMutationPlan(plan));
  assert.equal(Object.isFrozen(plan), true);
});

test("plans reparenting and dependency removal/addition in stable order", () => {
  const plan = planSemanticIssueRelations({
    subject: issue(1),
    desired: { parent: issue(8), dependsOn: [issue(5)] },
    observed: { parent: issue(2), dependsOn: [issue(3), issue(5)] },
    capabilities,
  });
  assert.deepEqual(plan.effects, [
    { kind: "CLEAR_PARENT_RELATION", previousParent: issue(2) },
    { kind: "SET_PARENT_RELATION", parent: issue(8) },
    { kind: "REMOVE_BLOCKED_BY_RELATION", reference: issue(3) },
  ]);
});

test("supports an explicit native empty target for no-op and parent removal", () => {
  const noOp = planSemanticIssueRelations({
    subject: issue(1),
    desired: {
      parent: { representation: "native" },
      dependsOn: { representation: "native", references: [] },
    },
    observed: { parent: undefined, dependsOn: [] },
    capabilities,
  });
  assert.deepEqual(noOp.effects, []);

  const remove = planSemanticIssueRelations({
    subject: issue(1),
    desired: { parent: { representation: "native" }, dependsOn: [] },
    observed: { parent: issue(2), dependsOn: [] },
    capabilities,
  });
  assert.deepEqual(remove.effects, [{ kind: "CLEAR_PARENT_RELATION", previousParent: issue(2) }]);

  const tampered = validateSemanticIssueRelationMutationPlan({
    ...remove,
    effects: [],
  });
  assert.equal(tampered.valid, false);
  assert.ok(tampered.diagnostics.some((entry) => entry.path === "$.effects"));
});

test("rejects cross-repository native relations and incomplete graph evidence", () => {
  const crossRepository = { repositoryHost: "github.com", repositoryId: "200", repository: "acme/other" };
  const cross = tryPlanSemanticIssueRelations({
    subject: issue(1),
    desired: { parent: issue(2, crossRepository), dependsOn: [] },
    observed: { parent: undefined, dependsOn: [] },
    capabilities,
    initiallyEmpty: true,
  });
  assert.equal(cross.valid, false);
  assert.ok(cross.diagnostics.some((entry) => entry.code === "RELATION_CROSS_REPOSITORY_UNSUPPORTED"));

  const incomplete = tryPlanSemanticIssueRelations({
    subject: issue(1),
    desired: { parent: issue(2), dependsOn: [] },
    observed: { parent: undefined, dependsOn: [] },
    capabilities,
    graph: { scope: "unavailable", nodes: [] },
  });
  assert.equal(incomplete.valid, false);
  assert.ok(incomplete.diagnostics.some((entry) => entry.code === "RELATION_EVIDENCE_UNAVAILABLE"));
});

test("rejects parent and dependency cycles before effects", () => {
  const parentCycle = validateIssueRelationshipGraph({
    nodes: [
      { reference: issue(1), parent: issue(2), dependsOn: [] },
      { reference: issue(2), parent: issue(1), dependsOn: [] },
    ],
  });
  assert.equal(parentCycle.valid, false);
  assert.ok(parentCycle.diagnostics.some((entry) => entry.code === "RELATION_PARENT_CYCLE"));

  const dependencyCycle = validateIssueRelationshipGraph({
    nodes: [
      { reference: issue(1), dependsOn: [issue(2)] },
      { reference: issue(2), dependsOn: [issue(1)] },
    ],
  });
  assert.equal(dependencyCycle.valid, false);
  assert.ok(dependencyCycle.diagnostics.some((entry) => entry.code === "RELATION_DEPENDENCY_CYCLE"));
});

test("rejects a supposedly complete graph that omits an edge target", () => {
  const result = validateIssueRelationshipGraph({
    scope: "complete",
    nodes: [{ reference: issue(1), parent: issue(2), dependsOn: [] }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((entry) => entry.code === "RELATION_EVIDENCE_UNAVAILABLE"));
});

test("accepts compact relation objects and treats non-empty omitted representations as native", () => {
  const result = planSemanticIssueRelations({
    subject: issue(1),
    desired: {
      relations: { parent: { reference: issue(2) }, dependsOn: { references: [issue(3)] } },
    },
    observed: {
      relations: { parent: { representation: "none" }, dependsOn: { representation: "none", references: [] } },
    },
    capabilities,
  });
  assert.equal(result.desired.parentRepresentation, "native");
  assert.equal(result.desired.dependsOnRepresentation, "native");
});
