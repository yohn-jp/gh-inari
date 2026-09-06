import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArtifactContract } from "./contract/artifact-contract.js";
import { compileEffectiveArtifactContract } from "./contract/effective-artifact-contract.js";
import { materializeSemanticArtifact } from "./contract/semantic-artifact.js";
import type { ArtifactContractProvenance } from "./contract/ir.js";
import {
  deserializeSemanticBranchMutationPlan,
  planSemanticBranch,
  projectSemanticBranch,
  serializeSemanticBranchMutationPlan,
  tryProjectSemanticBranch,
  validateSemanticBranchMutationPlan,
  SemanticBranchProjectionError,
} from "./semantic-branch-projection.js";

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
    path: ".github/inari/canon/branch.json",
    ref: "main",
    sha: "blob-sha",
    digest: "source-digest",
  },
};

function issue(number = 283) {
  return {
    repositoryHost: "github.com",
    repositoryId: "1234",
    repository: "yohn-jp/gh-inari",
    number,
  };
}

const derivedBranchContract = parseArtifactContract({
  version: "1",
  kind: "branch",
  id: "derived-branch",
  properties: {
    type: {
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { values: ["feat", "fix"] },
    },
    issue: { presence: "required", authority: { kind: "supplied" } },
    slug: { presence: "required", authority: { kind: "supplied" } },
    name: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "format", template: "topic/{issue.number}-{slug}" } },
    },
    source: { presence: "required", authority: { kind: "fixed", value: "main" } },
  },
});

const suppliedBranchContract = parseArtifactContract({
  version: "1",
  kind: "branch",
  id: "supplied-branch",
  properties: {
    name: { presence: "required", authority: { kind: "supplied" } },
    source: { presence: "required", authority: { kind: "fixed", value: "develop" } },
  },
});

function artifact(
  contract = derivedBranchContract,
  input: Record<string, unknown> = { type: "feat", issue: issue(), slug: "projection" },
) {
  return materializeSemanticArtifact(compileEffectiveArtifactContract(contract, { provenance }), input);
}

test("projects materialized branch name and source without re-deriving identity", () => {
  const result = projectSemanticBranch({ artifact: artifact() });
  assert.deepEqual(result, {
    version: "1",
    kind: "branch",
    name: "topic/283-projection",
    source: "main",
    provenance,
    generation: provenance,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.provenance), true);
});

test("preserves caller-supplied branch identity and does not impose Change naming policy", () => {
  const result = projectSemanticBranch({ artifact: artifact(suppliedBranchContract, { name: "topic/from-caller" }) });
  assert.equal(result.name, "topic/from-caller");
  assert.equal(result.source, "develop");
});

test("projection has no override path and rejects incompatible artifacts", () => {
  assert.throws(
    () => projectSemanticBranch({ artifact: artifact(), name: "caller-override" }),
    (error: unknown) =>
      error instanceof SemanticBranchProjectionError &&
      error.violations[0]?.code === "PROJECTION_INPUT_UNKNOWN_PROPERTY",
  );

  const malformed = structuredClone(artifact()) as unknown as Record<string, unknown>;
  malformed.kind = "pull_request";
  const result = tryProjectSemanticBranch({ artifact: malformed });
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((violation) => violation.code === "SEMANTIC_ARTIFACT_INCOMPATIBLE"));
});

test("plans retain a stable artifact digest, provenance precondition, and explicit create effect", () => {
  const first = planSemanticBranch({ artifact: artifact() });
  const second = planSemanticBranch({ artifact: artifact() });
  assert.equal(serializeSemanticBranchMutationPlan(first), serializeSemanticBranchMutationPlan(second));
  assert.equal(first.version, "1");
  assert.deepEqual(first.generation, first.provenance);
  assert.deepEqual(first.preconditions, [
    { kind: "GOVERNANCE_GENERATION_MATCH", generation: first.generation },
    { kind: "BRANCH_TARGET_ABSENT", name: first.desired.name },
  ]);
  assert.deepEqual(first.effects, [{ kind: "CREATE_BRANCH", desired: first.desired }]);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.desired), true);
});

function validPlan(): Record<string, unknown> {
  return JSON.parse(serializeSemanticBranchMutationPlan(planSemanticBranch({ artifact: artifact() }))) as Record<
    string,
    unknown
  >;
}

test("mutation plan validation binds desired state, preconditions, and effects", () => {
  const plan = validPlan();
  assert.equal(validateSemanticBranchMutationPlan(plan).valid, true);
  assert.deepEqual(
    deserializeSemanticBranchMutationPlan(serializeSemanticBranchMutationPlan(plan)),
    validateSemanticBranchMutationPlan(plan).plan,
  );

  const desired = plan.desired as Record<string, unknown>;
  desired.name = "tampered";
  assert.equal(validateSemanticBranchMutationPlan(plan).valid, false);

  const second = validPlan();
  const preconditions = second.preconditions as Record<string, unknown>[];
  const target = preconditions.find((entry) => entry.kind === "BRANCH_TARGET_ABSENT");
  assert.ok(target);
  target.name = "tampered";
  assert.equal(validateSemanticBranchMutationPlan(second).valid, false);
});
