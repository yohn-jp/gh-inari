import assert from "node:assert/strict";
import { test } from "node:test";
import { createRepositoryBranchPolicy } from "../../repository-branch-policy.js";
import {
  observeLocalBranch,
  validateLocalBranchObservation,
  validateLocalBranchPolicyInput,
} from "./branch-observation.js";

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

test("#1213 branch-policy evidence carries the canonical Source set, never inside the signed observation", () => {
  const source = (number: number, repositoryId = repository.repositoryId) => ({
    repositoryHost: "github.com",
    repositoryId,
    number,
  });
  const wire = {
    version: 1,
    kind: "local-branch-policy-input",
    policy,
    target,
    observedGeneration,
    binding: { repository, implementation: 1112, branch: "work/1112-session" },
    sources: [source(1109), source(1108), source(7, "987654321")],
  };
  const input = validateLocalBranchPolicyInput(wire);
  assert.ok(input);
  // Canonical exact set: caller order is irrelevant; cross-repository entries remain evidence only.
  assert.deepEqual(input.sources?.map((reference) => reference.number).sort(), [1108, 1109, 7].sort());
  assert.deepEqual(
    validateLocalBranchPolicyInput({ ...wire, sources: [...wire.sources].reverse() })?.sources,
    input.sources,
  );
  const { sources: _sources, ...policyOnly } = input;
  const observation = observeLocalBranch({ ...policyOnly, observedBranch: "work/1112-session" });
  assert.equal("sources" in observation, false);
  assert.deepEqual(validateLocalBranchObservation(observation), observation);

  for (const sources of [[], [source(1108), source(1108)], [{ number: 1108 }], "1108"])
    assert.equal(validateLocalBranchPolicyInput({ ...wire, sources }), undefined);

  const implementationBinding = {
    version: 1,
    kind: "implementation-session-binding",
    authorization: {
      version: 1,
      kind: "implementation-authorization",
      contractVersion: 1,
      implementation: source(1112),
      governedBodyDigest: "c".repeat(64),
    },
    repository,
    base: { branch: "trunk", revision: "d".repeat(40), freshness: "d".repeat(40) },
    task: { kind: "issue", number: 1112 },
    sources: wire.sources,
  };
  assert.deepEqual(
    validateLocalBranchPolicyInput({ ...wire, implementationBinding })?.implementationBinding?.sources,
    input.sources,
  );
  // The Implementation binding must name the same Implementation, repository and exact Source set.
  for (const binding of [
    { ...implementationBinding, sources: [source(1108)] },
    { ...implementationBinding, task: { kind: "issue", number: 1113 } },
    { ...implementationBinding, sources: undefined },
  ])
    assert.equal(validateLocalBranchPolicyInput({ ...wire, implementationBinding: binding }), undefined);
  const { sources: _omitted, ...withoutSources } = wire;
  assert.equal(validateLocalBranchPolicyInput({ ...withoutSources, implementationBinding }), undefined);
});
