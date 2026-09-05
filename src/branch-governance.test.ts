import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_RELEASE_BRANCH_PATTERN,
  classifyBranchName,
  effectiveBranchGovernance,
  parseCanonicalChangeBranchName,
} from "./branch-governance.js";
import { parsePullRequestPolicyOverlay } from "./pr-policy.js";

const ordinaryPolicy = {
  pattern: "^(feat|fix)/[1-9][0-9]*-[a-z0-9-]+$",
};

test("compiled branch policy exposes deterministic ordinary, release, and exemption classes", () => {
  const policy = effectiveBranchGovernance({ ...ordinaryPolicy, exemptions: ["develop", "main"] });

  assert.deepEqual(policy, {
    pattern: ordinaryPolicy.pattern,
    release: { pattern: DEFAULT_RELEASE_BRANCH_PATTERN },
    exemptions: ["develop", "main"],
  });
  assert.deepEqual(classifyBranchName("feat/42-add-init", policy), {
    valid: true,
    classification: "ordinary",
    violations: [],
  });
  assert.deepEqual(classifyBranchName("legacy", policy), {
    valid: false,
    classification: "invalid",
    violations: [
      {
        code: "BRANCH_PATTERN_MISMATCH",
        path: "$.head",
        message: 'Branch name "legacy" does not satisfy the ordinary branch governance pattern.',
      },
    ],
  });
  assert.deepEqual(classifyBranchName("develop", policy).classification, "exempt");
});

test("release branches are classified independently from ordinary rules", () => {
  const policy = effectiveBranchGovernance({ ...ordinaryPolicy, pattern: ".*" });

  assert.deepEqual(classifyBranchName("release/1.2.3", policy), {
    valid: true,
    classification: "release",
    version: "1.2.3",
    violations: [],
  });
  const invalid = classifyBranchName("release/1.2", policy);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.classification, "invalid-release");
  assert.equal(invalid.violations[0]?.code, "BRANCH_RELEASE_INVALID");
});

test("absent branch governance is a no-op while canonical Change parsing remains available", () => {
  assert.deepEqual(classifyBranchName("not-a-governed-branch", undefined), {
    valid: true,
    classification: "unclassified",
    violations: [],
  });
  assert.deepEqual(classifyBranchName(undefined, undefined), {
    valid: true,
    classification: "unclassified",
    violations: [],
  });
  assert.deepEqual(parseCanonicalChangeBranchName("feat/42-add-init"), {
    type: "feat",
    issueNumber: 42,
    slug: "add-init",
  });
});

test("policy parsing compiles the same effective branch IR used by validation", () => {
  const overlay = parsePullRequestPolicyOverlay(
    [
      "version: 1",
      "sections: []",
      "branch:",
      '  pattern: "^(feat|fix)/[1-9][0-9]*-[a-z0-9-]+$"',
      "  exemptions: [main]",
    ].join("\n"),
  );
  assert.deepEqual(overlay.branch, {
    pattern: ordinaryPolicy.pattern,
    release: { pattern: DEFAULT_RELEASE_BRANCH_PATTERN },
    exemptions: ["main"],
  });
  assert.equal(classifyBranchName("main", overlay.branch).classification, "exempt");
});
