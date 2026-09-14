import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRANCH_TYPES,
  DEFAULT_BRANCH_NAME,
  MAX_BRANCH_TITLE_LENGTH,
  branchBelongsToRootIssue,
  deriveBranchName,
  deriveBranchNamingFromIssueTitle,
  recognizeBranchName,
  recognizeBranchNamingForIssue,
  validateBranchName,
} from "./branch-naming.js";

const GOLDEN_VECTORS = [
  { title: "feat: add init command", issueNumber: 42, type: "feat", slug: "add-init-command" },
  { title: "fix: repair provider timeout", issueNumber: 43, type: "fix", slug: "repair-provider-timeout" },
  { title: "docs: explain the API", issueNumber: 44, type: "docs", slug: "explain-the-api" },
  { title: "refactor: simplify change planning", issueNumber: 45, type: "refactor", slug: "simplify-change-planning" },
  { title: "test: cover café input", issueNumber: 46, type: "test", slug: "cover-cafe-input" },
  { title: "chore: update release metadata", issueNumber: 47, type: "chore", slug: "update-release-metadata" },
] as const;

test("canonical branch golden vectors derive and recognize symmetrically for every supported kind", () => {
  assert.deepEqual(BRANCH_TYPES, ["feat", "fix", "docs", "refactor", "test", "chore"]);

  for (const vector of GOLDEN_VECTORS) {
    const naming = deriveBranchNamingFromIssueTitle(vector.title);
    assert.deepEqual(naming, { type: vector.type, slug: vector.slug });

    const branch = deriveBranchName({ ...naming, issueNumber: vector.issueNumber });
    assert.equal(branch, `${vector.type}/${vector.issueNumber}-${vector.slug}`);
    assert.deepEqual(recognizeBranchName(branch), {
      type: vector.type,
      issueNumber: vector.issueNumber,
      slug: vector.slug,
    });
    assert.deepEqual(recognizeBranchNamingForIssue(branch, vector.issueNumber), naming);
    assert.equal(branchBelongsToRootIssue(branch, vector.issueNumber), true);
    assert.equal(branchBelongsToRootIssue(branch, vector.issueNumber + 1), false);
  }
});

test("branch recognition applies repository branch governance without redefining grammar", () => {
  const branch = "refactor/45-simplify-change-planning";
  assert.equal(branchBelongsToRootIssue(branch, 45, { pattern: "^refactor/[0-9]+-[a-z0-9-]+$" }), true);
  assert.equal(branchBelongsToRootIssue(branch, 45, { pattern: "^feat/" }), false);
  assert.equal(branchBelongsToRootIssue(branch, 45, { pattern: "(" }), false);
});

test("legacy accepted branch boundaries remain stable while default branch stays outside Change recognition", () => {
  assert.deepEqual(validateBranchName(DEFAULT_BRANCH_NAME), []);
  assert.equal(recognizeBranchName(DEFAULT_BRANCH_NAME), undefined);
  assert.deepEqual(validateBranchName("feat/0-zero-issue"), []);
  assert.deepEqual(recognizeBranchName("feat/00042-leading-zero"), {
    type: "feat",
    issueNumber: 42,
    slug: "leading-zero",
  });
  assert.equal(branchBelongsToRootIssue("feat/00042-leading-zero", 42), true);
});

test("Core branch naming rejects unsupported grammar and unsafe title inputs", () => {
  for (const branch of [
    "wip/42-unsupported-kind",
    "feat/42-missing issue separator",
    "feat/42-UPPERCASE",
    "feat/42-",
    "feat/42",
  ]) {
    assert.notDeepEqual(validateBranchName(branch), []);
    assert.equal(recognizeBranchName(branch), undefined);
  }

  assert.throws(() => deriveBranchNamingFromIssueTitle("unclassified work"));
  assert.throws(() => deriveBranchNamingFromIssueTitle("feat: "));
  assert.throws(() => deriveBranchNamingFromIssueTitle("x".repeat(MAX_BRANCH_TITLE_LENGTH + 1)));
  assert.throws(() => deriveBranchName({ type: "feat", issueNumber: 0, slug: "invalid-issue" }));
  assert.throws(() => deriveBranchName({ type: "feat", issueNumber: 42, slug: "UPPERCASE" }));
});
