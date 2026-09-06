import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArtifactContract } from "./contract/artifact-contract.js";
import { compileEffectiveArtifactContract } from "./contract/effective-artifact-contract.js";
import { materializeSemanticArtifact } from "./contract/semantic-artifact.js";
import type { ArtifactContractProvenance } from "./contract/ir.js";
import {
  GITHUB_ISSUE_PROJECTION_CAPABILITIES,
  deserializeSemanticIssueMutationPlan,
  planSemanticIssue,
  projectSemanticIssue,
  serializeSemanticIssueMutationPlan,
  tryProjectSemanticIssue,
  validateSemanticIssueMutationPlan,
  SemanticIssueProjectionError,
} from "./semantic-issue-projection.js";

const provenance: ArtifactContractProvenance = {
  authority: "repository-default-branch",
  repository: {
    host: "github.com",
    owner: "yohn-jp",
    name: "gh-inari",
    nameWithOwner: "yohn-jp/gh-inari",
    repositoryId: "1234",
  },
  ref: "main",
  treeSha: "tree-sha",
  source: {
    path: ".github/inari/canon/issue.json",
    ref: "main",
    sha: "blob-sha",
    digest: "source-digest",
  },
};

const contract = parseArtifactContract({
  version: "1",
  kind: "issue",
  id: "projection",
  properties: {
    title: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "format", template: "{type}: {slug}" } },
    },
    type: { presence: "required", authority: { kind: "supplied" }, constraints: { values: ["feature", "bug"] } },
    labels: { presence: "optional", authority: { kind: "supplied" } },
    assignees: { presence: "optional", authority: { kind: "supplied" } },
    milestone: { presence: "optional", authority: { kind: "supplied" } },
    parent: { presence: "optional", authority: { kind: "supplied" } },
    dependsOn: { presence: "optional", authority: { kind: "supplied" } },
  },
  fields: [
    {
      id: "summary",
      primitive: "text",
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { minLength: 1 },
    },
    {
      id: "slug",
      primitive: "text",
      presence: "required",
      authority: { kind: "derived", derive: { op: "slug", from: "summary" } },
    },
  ],
});

function issue(number: number) {
  return {
    repositoryHost: "github.com",
    repositoryId: "1234",
    repository: "yohn-jp/gh-inari",
    number,
  };
}

function artifact(withRelations = true) {
  return materializeSemanticArtifact(compileEffectiveArtifactContract(contract, { provenance }), {
    type: "feature",
    summary: "Project semantic Issue",
    labels: ["enhancement"],
    assignees: ["sophia"],
    milestone: "wave",
    ...(withRelations ? { parent: issue(278), dependsOn: [issue(281), issue(282)] } : {}),
  });
}

const native = [
  GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeParentRelation,
  GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeDependsOnRelation,
];
const fallback = [GITHUB_ISSUE_PROJECTION_CAPABILITIES.bodyRelationFallback];

test("projects Issue identity, metadata, fields, and native relations from the artifact", () => {
  const result = projectSemanticIssue({ artifact: artifact(), capabilities: native });
  assert.equal(result.title, "feature: project-semantic-issue");
  assert.equal(result.metadata.milestone, "wave");
  assert.deepEqual(result.metadata.labels, ["enhancement"]);
  assert.equal(result.relations.parent.representation, "native");
  assert.equal(result.relations.dependsOn.representation, "native");
  assert.match(result.body, /## summary/);
  assert.match(result.body, /Project semantic Issue/);
  assert.doesNotMatch(result.body, /semantic-relation/);
});

test("prefers GitHub-native relations over compatibility encodings", () => {
  const result = projectSemanticIssue({ artifact: artifact(), capabilities: [...native, ...fallback] });
  assert.equal(result.relations.parent.representation, "native");
  assert.equal(result.relations.dependsOn.representation, "native");
  assert.doesNotMatch(result.body, /inari:(?:semantic-relation|issue-dependencies)/);
});

test("selects native relations before bounded compatibility body fallback", () => {
  const dependencyArtifact = materializeSemanticArtifact(compileEffectiveArtifactContract(contract, { provenance }), {
    type: "feature",
    summary: "Dependency projection",
    dependsOn: [issue(282)],
  });
  const fallbackDependencyProjection = projectSemanticIssue({ artifact: dependencyArtifact, capabilities: fallback });
  assert.equal(fallbackDependencyProjection.relations.dependsOn.representation, "body-fallback");
  assert.match(fallbackDependencyProjection.body, /inari:issue-dependencies/);

  const fallbackProjection = projectSemanticIssue({ artifact: artifact(), capabilities: fallback });
  assert.equal(fallbackProjection.relations.parent.representation, "body-fallback");
  assert.equal(fallbackProjection.relations.dependsOn.representation, "body-fallback");
  assert.match(fallbackProjection.body, /inari:semantic-relation/);
  assert.match(fallbackProjection.body, /inari:issue-dependencies/);
});

test("projection has no semantic override path and fails closed when relations are unrepresentable", () => {
  const overridden = { ...artifact(false), title: "caller override" };
  assert.throws(
    () => projectSemanticIssue({ artifact: overridden, capabilities: native }),
    (error: unknown) =>
      error instanceof SemanticIssueProjectionError && error.violations[0]?.code === "SEMANTIC_ARTIFACT_INVALID",
  );
  assert.throws(
    () => projectSemanticIssue({ artifact: artifact(), capabilities: [] }),
    (error: unknown) =>
      error instanceof SemanticIssueProjectionError && error.violations[0]?.code === "RELATION_UNREPRESENTABLE",
  );
});

test("plans retain immutable provenance, desired state, and explicit effect", () => {
  const first = planSemanticIssue({ artifact: artifact(), capabilities: native });
  const second = planSemanticIssue({ artifact: artifact(), capabilities: native });
  assert.equal(serializeSemanticIssueMutationPlan(first), serializeSemanticIssueMutationPlan(second));
  assert.equal(first.version, "1");
  assert.deepEqual(first.generation, first.provenance);
  assert.deepEqual(first.preconditions[0], { kind: "GOVERNANCE_GENERATION_MATCH", generation: first.generation });
  assert.equal(first.effects[0]?.kind, "CREATE_ISSUE");
  assert.deepEqual(first.effects[0]?.desired, first.desired);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.desired), true);
});

test("mutation plan validation binds desired state and rejects tampering", () => {
  const plan = planSemanticIssue({ artifact: artifact(false), capabilities: [] });
  const serialized = serializeSemanticIssueMutationPlan(plan);
  assert.equal(validateSemanticIssueMutationPlan(JSON.parse(serialized)).valid, true);
  assert.deepEqual(deserializeSemanticIssueMutationPlan(serialized), plan);

  const tampered = JSON.parse(serialized) as Record<string, unknown>;
  (tampered.desired as Record<string, unknown>).title = "tampered";
  assert.equal(validateSemanticIssueMutationPlan(tampered).valid, false);
});

test("normalizes object capability flags into the same plan capability set", () => {
  const plan = planSemanticIssue({
    artifact: artifact(false),
    capabilities: { nativeParentRelation: true, nativeDependsOnRelation: true },
  });
  assert.deepEqual(plan.capabilities, [...native].sort());
});

test("accepts direct artifact plus capability arguments without GitHub I/O", () => {
  const result = tryProjectSemanticIssue(artifact(false), []);
  assert.equal(result.valid, true);
});
