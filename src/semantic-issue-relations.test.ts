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
    graph: {
      scope: "complete",
      nodes: [issue(1), issue(2), issue(3), issue(5), issue(8)].map((reference) => ({
        reference,
        dependsOn: [],
      })),
    },
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
    graph: {
      scope: "complete",
      nodes: [issue(1), issue(2)].map((reference) => ({ reference, dependsOn: [] })),
    },
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

test("admits a same-owner cross-repository parent only when the capability is declared", () => {
  const otherRepo = { repositoryHost: "github.com", repositoryId: "200", repository: "acme/other" };
  const crossRepositoryParent = issue(2, otherRepo);
  const rejected = tryPlanSemanticIssueRelations({
    subject: issue(1),
    desired: { parent: crossRepositoryParent, dependsOn: [] },
    observed: { parent: undefined, dependsOn: [] },
    capabilities,
    graph: {
      scope: "complete",
      nodes: [issue(1), crossRepositoryParent].map((reference) => ({ reference, dependsOn: [] })),
    },
  });
  assert.equal(rejected.valid, false);
  assert.ok(rejected.diagnostics.some((entry) => entry.code === "RELATION_CROSS_REPOSITORY_UNSUPPORTED"));

  const admitted = tryPlanSemanticIssueRelations({
    subject: issue(1),
    desired: { parent: crossRepositoryParent, dependsOn: [] },
    observed: { parent: undefined, dependsOn: [] },
    capabilities: [...capabilities, "github.issue.parent.native.cross-repository-same-owner"],
    graph: {
      scope: "complete",
      nodes: [issue(1), crossRepositoryParent].map((reference) => ({ reference, dependsOn: [] })),
    },
  });
  assert.equal(admitted.valid, true);
  assert.deepEqual(admitted.plan?.effects, [{ kind: "SET_PARENT_RELATION", parent: crossRepositoryParent }]);
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

test("rejects a new parent edge that closes an already-existing multi-hop cycle path", () => {
  // Existing chain: 1's parent is 2; 2's parent is 3. Proposing 3's parent as
  // 1 would close the cycle 3 -> 1 -> 2 -> 3, not just a direct 2-node cycle.
  const result = tryPlanSemanticIssueRelations({
    subject: issue(3),
    desired: { parent: issue(1), dependsOn: [] },
    observed: { parent: undefined, dependsOn: [] },
    capabilities,
    graph: {
      scope: "complete",
      nodes: [
        { reference: issue(1), parent: issue(2), dependsOn: [] },
        { reference: issue(2), parent: issue(3), dependsOn: [] },
        { reference: issue(3), dependsOn: [] },
      ],
    },
  });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((entry) => entry.code === "RELATION_PARENT_CYCLE"));

  // The equivalent dependency chain must also be rejected when the new edge
  // would close a multi-hop `dependsOn` cycle.
  const dependencyResult = tryPlanSemanticIssueRelations({
    subject: issue(3),
    desired: { parent: undefined, dependsOn: [issue(1)] },
    observed: { parent: undefined, dependsOn: [] },
    capabilities,
    graph: {
      scope: "complete",
      nodes: [
        { reference: issue(1), dependsOn: [issue(2)] },
        { reference: issue(2), dependsOn: [issue(3)] },
        { reference: issue(3), dependsOn: [] },
      ],
    },
  });
  assert.equal(dependencyResult.valid, false);
  assert.ok(dependencyResult.diagnostics.some((entry) => entry.code === "RELATION_DEPENDENCY_CYCLE"));
});

test("rejects omitted, ambiguous, or incomplete graph evidence when effects are planned", () => {
  const omitted = tryPlanSemanticIssueRelations({
    subject: issue(1),
    desired: { parent: issue(2), dependsOn: [] },
    observed: { parent: undefined, dependsOn: [] },
    capabilities,
  });
  assert.equal(omitted.valid, false);
  assert.ok(
    omitted.diagnostics.some((entry) => entry.code === "RELATION_EVIDENCE_UNAVAILABLE" && entry.path === "$.graph"),
  );

  const noOpWithoutGraph = tryPlanSemanticIssueRelations({
    subject: issue(1),
    desired: { parent: undefined, dependsOn: [] },
    observed: { parent: undefined, dependsOn: [] },
    capabilities,
  });
  assert.equal(noOpWithoutGraph.valid, true);
  assert.equal(noOpWithoutGraph.plan?.graph, undefined);
});

test("transports the admitted graph on the plan and requires it at revalidation", () => {
  const plan = planSemanticIssueRelations({
    subject: issue(1),
    desired: { parent: issue(2), dependsOn: [] },
    observed: { parent: undefined, dependsOn: [] },
    capabilities,
    graph: {
      scope: "complete",
      nodes: [issue(1), issue(2)].map((reference) => ({ reference, dependsOn: [] })),
    },
  });
  assert.ok(plan.graph);
  assert.equal(plan.graph?.scope, "complete");
  assert.equal(validateSemanticIssueRelationMutationPlan(plan).valid, true);

  const strippedGraph = validateSemanticIssueRelationMutationPlan({ ...plan, graph: undefined });
  assert.equal(strippedGraph.valid, false);
  assert.ok(strippedGraph.diagnostics.some((entry) => entry.path === "$.graph"));

  const tamperedGraph = validateSemanticIssueRelationMutationPlan({
    ...plan,
    graph: { scope: "complete", nodes: [{ reference: issue(1), parent: issue(2), dependsOn: [] }] },
  });
  assert.equal(tamperedGraph.valid, false);
  assert.ok(tamperedGraph.diagnostics.some((entry) => entry.code === "RELATION_PLAN_INVALID"));
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
    graph: {
      scope: "complete",
      nodes: [issue(1), issue(2), issue(3)].map((reference) => ({ reference, dependsOn: [] })),
    },
  });
  assert.equal(result.desired.parentRepresentation, "native");
  assert.equal(result.desired.dependsOnRepresentation, "native");
});
