import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArtifactContract } from "./contract/artifact-contract.js";
import { compileEffectiveArtifactContract } from "./contract/effective-artifact-contract.js";
import { materializeSemanticArtifact } from "./contract/semantic-artifact.js";
import type { ArtifactContractProvenance } from "./contract/ir.js";
import { GITHUB_ISSUE_PROJECTION_CAPABILITIES, projectSemanticIssue } from "./semantic-issue-projection.js";
import {
  compareSemanticIssueProjection,
  observeSemanticIssue,
  tryObserveSemanticIssue,
} from "./semantic-issue-observation.js";

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
  id: "observation",
  properties: {
    title: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "format", template: "{type}: {slug}" } },
    },
    type: { presence: "required", authority: { kind: "supplied" }, constraints: { values: ["feature"] } },
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

const artifact = materializeSemanticArtifact(compileEffectiveArtifactContract(contract, { provenance }), {
  type: "feature",
  summary: "Observe semantic Issue",
  parent: issue(278),
  dependsOn: [issue(281), issue(282)],
});

const fallback = projectSemanticIssue({
  artifact,
  capabilities: [GITHUB_ISSUE_PROJECTION_CAPABILITIES.bodyRelationFallback],
});
const native = projectSemanticIssue({
  artifact,
  capabilities: [
    GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeParentRelation,
    GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeDependsOnRelation,
  ],
});

const repository = { host: "github.com", repositoryId: "1234", repository: "yohn-jp/gh-inari" };

function githubIssue(body: string) {
  return {
    number: 99,
    title: fallback.title,
    body,
    state: "open" as const,
    url: "https://github.com/yohn-jp/gh-inari/issues/99",
    labels: [],
    assignees: [],
  };
}

test("observes native and body fallback evidence for the same Issue relations", () => {
  const observed = observeSemanticIssue({
    issue: githubIssue(fallback.body),
    repository,
    relations: {
      parent: { native: issue(278) },
      dependsOn: { native: [issue(281), issue(282)] },
    },
  });
  assert.equal(observed.relations.parent.representation, "native");
  assert.equal(observed.relations.dependsOn.representation, "native");
  assert.deepEqual(observed.relations.parent.evidence.bodyFallback, issue(278));
  assert.deepEqual(observed.relations.dependsOn.evidence.bodyFallback, [issue(281), issue(282)]);
  assert.equal(compareSemanticIssueProjection(fallback, observed).valid, true);
});

test("retains conflicting native and body evidence as drift", () => {
  const observed = observeSemanticIssue({
    issue: githubIssue(fallback.body),
    repository,
    relations: {
      parent: { native: issue(279) },
      dependsOn: { native: [issue(281), issue(282)] },
    },
  });
  assert.equal(observed.relations.parent.representation, "conflict");
  const comparison = compareSemanticIssueProjection(fallback, observed);
  assert.equal(comparison.valid, false);
  assert.ok(comparison.diagnostics.some((diagnostic) => diagnostic.code === "RELATION_CONFLICT"));
});

test("treats explicit native parent emptiness as conflicting with a stale fallback marker", () => {
  const observed = observeSemanticIssue({
    issue: githubIssue(fallback.body),
    repository,
    relations: {
      parent: { native: [] },
    },
  });
  assert.equal(observed.relations.parent.representation, "conflict");
});

test("accepts a compact IssueReference as native parent evidence", () => {
  const observed = observeSemanticIssue({
    issue: githubIssue(""),
    repository,
    relations: { parent: issue(278) },
  });
  assert.equal(observed.relations.parent.representation, "native");
  assert.deepEqual(observed.relations.parent.reference, issue(278));
});

test("does not infer relations from arbitrary prose", () => {
  const result = tryObserveSemanticIssue({
    issue: githubIssue("This prose mentions parent #278 and blocked by #281."),
    repository,
  });
  assert.equal(result.valid, true);
  assert.equal(result.projection?.relations.parent.representation, "none");
  assert.equal(result.projection?.relations.dependsOn.representation, "none");
});

test("fails closed when desired native evidence is unavailable", () => {
  const observed = observeSemanticIssue({ issue: githubIssue(native.body), repository });
  const comparison = compareSemanticIssueProjection(native, observed);
  assert.equal(comparison.valid, false);
  assert.ok(comparison.diagnostics.some((diagnostic) => diagnostic.code === "RELATION_OBSERVATION_UNAVAILABLE"));
});
