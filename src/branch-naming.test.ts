import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRANCH_TYPES,
  DEFAULT_BRANCH_NAME,
  LEGACY_CHANGE_BRANCH_RULE,
  MAX_BRANCH_TITLE_LENGTH,
  matchBranchFormat,
  normalizeBranchSlug,
  renderBranchFormat,
  validateBranchFormatRule,
  validateBranchSpelling,
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

test("the legacy compatibility rule renders and matches exactly the historical golden vectors", () => {
  assert.deepEqual(validateBranchFormatRule(LEGACY_CHANGE_BRANCH_RULE), []);
  const pattern = new RegExp(LEGACY_CHANGE_BRANCH_RULE.pattern, "u");
  for (const vector of GOLDEN_VECTORS) {
    const naming = deriveBranchNamingFromIssueTitle(vector.title);
    const legacy = deriveBranchName({ ...naming, issueNumber: vector.issueNumber });
    assert.equal(renderBranchFormat(LEGACY_CHANGE_BRANCH_RULE, { ...naming, issueNumber: vector.issueNumber }), legacy);
    assert.deepEqual(matchBranchFormat(LEGACY_CHANGE_BRANCH_RULE, legacy, vector.issueNumber), naming);
    assert.equal(matchBranchFormat(LEGACY_CHANGE_BRANCH_RULE, legacy, vector.issueNumber + 1), undefined);
    assert.equal(pattern.test(legacy), true);
  }
  assert.equal(normalizeBranchSlug("  Café -- Déjà vu! "), "cafe-deja-vu");
});

test("declarative branch formatter grammar is bounded and never uses a pattern", () => {
  const rule = { format: "users/{issueNumber}.{slug}" };
  assert.equal(renderBranchFormat(rule, { issueNumber: 9, slug: "tidy-up" }), "users/9.tidy-up");
  assert.deepEqual(matchBranchFormat(rule, "users/9.tidy-up", 9), { slug: "tidy-up" });
  assert.equal(matchBranchFormat(rule, "users/9Xtidy-up", 9), undefined);
  assert.equal(renderBranchFormat({ format: "impl-{issueNumber}" }, { issueNumber: 3 }), "impl-3");

  for (const [candidate, path] of [
    [{ format: "" }, "format"],
    [{ format: "no-number" }, "format"],
    [{ format: "{issueNumber}-{issueNumber}" }, "format"],
    [{ format: "{issueNumber}-{title}" }, "format"],
    [{ format: "a b/{issueNumber}" }, "format"],
    [{ format: "{type}/{issueNumber}" }, "types"],
    [{ format: "x/{issueNumber}", types: ["feat"] }, "types"],
    [{ format: "{type}/{issueNumber}", types: [] }, "types"],
    [{ format: "{type}/{issueNumber}", types: ["Feat"] }, "types"],
    [{ format: "{type}/{issueNumber}", types: ["a", "a"] }, "types"],
    [{ types: ["a"] }, "types"],
  ] as const) {
    const violations = validateBranchFormatRule(candidate);
    assert.notDeepEqual(violations, [], JSON.stringify(candidate));
    assert.equal(violations[0]?.path, path, JSON.stringify(candidate));
  }

  assert.throws(() => renderBranchFormat({ format: "u/{issueNumber}-{slug}" }, { issueNumber: 1 }));
  assert.throws(() => renderBranchFormat({ format: "u/{issueNumber}-{slug}" }, { issueNumber: 1, slug: "a--b" }));
  assert.throws(() => renderBranchFormat({ format: "u/{issueNumber}" }, { issueNumber: 0 }));
  assert.throws(() =>
    renderBranchFormat({ format: "{type}/{issueNumber}", types: ["a"] }, { issueNumber: 1, type: "b" }),
  );
  assert.throws(() => renderBranchFormat({ format: "u/{issueNumber}.lock" }, { issueNumber: 1 }));

  for (const branch of ["", "a//b", "/a", "a/", "a/.b", "-a", "a..b", "a b", "a.lock", "x".repeat(256)]) {
    assert.notDeepEqual(validateBranchSpelling(branch), [], branch);
  }
  assert.deepEqual(validateBranchSpelling("team/storage_rewrite-2.0"), []);
});
