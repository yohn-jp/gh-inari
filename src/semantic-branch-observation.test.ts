import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArtifactContractProvenance } from "./contract/ir.js";
import {
  compareSemanticBranchProjection,
  observeSemanticBranch,
  tryObserveSemanticBranch,
  type ObservedBranchProjection,
} from "./semantic-branch-observation.js";
import type { DesiredBranchProjection } from "./semantic-branch-projection.js";

const generation: ArtifactContractProvenance = {
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

const desired: DesiredBranchProjection = {
  version: "1",
  kind: "branch",
  name: "feat/311-observation",
  source: "main",
  provenance: generation,
  generation,
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    ref: {
      ref: "refs/heads/feat/311-observation",
      object: { type: "commit", sha: "a".repeat(40) },
    },
    source: "main",
    generation,
    ...overrides,
  };
}

test("observes a bounded Git branch ref without making it semantic authority", () => {
  const observed = observeSemanticBranch(input());
  assert.deepEqual(observed, {
    version: "1",
    kind: "branch",
    name: "feat/311-observation",
    source: "main",
    generation,
  });
  assert.equal(Object.isFrozen(observed), true);
  assert.equal(Object.isFrozen(observed.generation), true);
});

test("fails closed for non-branch refs, missing evidence, and unknown input", () => {
  const tag = tryObserveSemanticBranch(
    input({ ref: { ref: "refs/tags/v1", object: { type: "commit", sha: "a".repeat(40) } } }),
  );
  assert.equal(tag.valid, false);
  assert.ok(tag.violations.some((violation) => violation.code === "OBSERVED_BRANCH_REF_INVALID"));

  const missing = tryObserveSemanticBranch(input({ source: undefined }));
  assert.equal(missing.valid, false);

  const unknown = tryObserveSemanticBranch(input({ arbitrary: "guess" }));
  assert.equal(unknown.valid, false);
  assert.ok(unknown.violations.some((violation) => violation.code === "OBSERVATION_INPUT_UNKNOWN_PROPERTY"));
});

test("compares desired and observed branch values deterministically", () => {
  const observed = observeSemanticBranch(input());
  assert.deepEqual(compareSemanticBranchProjection(desired, observed), {
    valid: true,
    diagnostics: [],
    drift: [],
  });

  const drifted: ObservedBranchProjection = {
    ...observed,
    name: "feat/other",
    source: "develop",
    generation: { ...generation, treeSha: "different-tree" },
  };
  const result = compareSemanticBranchProjection({ desired, observed: drifted });
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["NAME_DRIFT", "SOURCE_DRIFT", "GENERATION_DRIFT"],
  );
});

test("does not infer or accept an invalid observed projection", () => {
  const observed = observeSemanticBranch(input());
  const invalid = { ...observed, generation: { ...generation, ref: "" } };
  const result = compareSemanticBranchProjection(desired, invalid);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0]?.code, "OBSERVED_PROJECTION_INVALID");
});
