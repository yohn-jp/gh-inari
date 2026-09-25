import assert from "node:assert/strict";
import { test } from "node:test";
import { createRepositoryBranchPolicy } from "../../repository-branch-policy.js";
import { observeLocalBranch, validateLocalBranchObservation } from "./branch-observation.js";

const repository = { repositoryHost: "github.com", repositoryId: "1330755860" };
const target = { repository, implementation: 1112 };
const observedGeneration = { ref: "trunk", treeSha: "a".repeat(40) };
const acquisition = createRepositoryBranchPolicy({
  generation: {
    authority: "repository-default-branch",
    repository: {
      host: "github.com",
      repositoryId: repository.repositoryId,
      owner: "yohn-jp",
      name: "gh-inari",
      nameWithOwner: "yohn-jp/gh-inari",
    },
    ...observedGeneration,
  },
  rule: { pattern: "^work/[0-9]+-[a-z]+$", format: "work/{issueNumber}-{slug}" },
});
assert.equal(acquisition.status, "available");
const policy = acquisition.status === "available" ? acquisition.policy : undefined;
assert.ok(policy);

test("alternative repository naming and default branch bind the exact Implementation", () => {
  const observation = observeLocalBranch({
    policy,
    target,
    observedGeneration,
    observedBranch: "work/1112-session",
    naming: { slug: "session" },
  });
  assert.equal(observation.expectedBranch, "work/1112-session");
  assert.equal(observation.evidence.defaultBranch, "trunk");
  assert.deepEqual(validateLocalBranchObservation(observation), observation);
  assert.throws(() =>
    observeLocalBranch({
      policy,
      target,
      observedGeneration,
      observedBranch: "work/1113-session",
      naming: { slug: "session" },
    }),
  );
});

test("stale and contradictory observation fails closed", () => {
  assert.throws(() =>
    observeLocalBranch({
      policy,
      target,
      observedGeneration: { ref: "trunk", treeSha: "b".repeat(40) },
      observedBranch: "work/1112-session",
      naming: { slug: "session" },
    }),
  );
  const observation = observeLocalBranch({
    policy,
    target,
    observedGeneration,
    observedBranch: "work/1112-session",
    naming: { slug: "session" },
  });
  assert.equal(validateLocalBranchObservation({ ...observation, expectedBranch: "work/1113-session" }), undefined);
  assert.equal(
    validateLocalBranchObservation({ ...observation, evidence: { ...observation.evidence, unexpected: undefined } }),
    undefined,
  );
});
