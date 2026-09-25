import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePullRequestPolicyOverlay, PullRequestPolicyError } from "./pr-policy.js";

function branchPolicy(branch: string): string {
  return `version: 1\nsections: []\nbranch:\n${branch}`;
}

test("PR policy branch rule stays pattern-only when no formatter is declared", () => {
  const overlay = parsePullRequestPolicyOverlay(branchPolicy('  pattern: "^work/[0-9]+$"\n'));
  assert.deepEqual(overlay.branch, { pattern: "^work/[0-9]+$" });
});

test("PR policy branch rule accepts an additive bounded formatter and type vocabulary", () => {
  const overlay = parsePullRequestPolicyOverlay(
    branchPolicy(
      '  pattern: "^(story|bug)/[0-9]+-[a-z0-9-]+$"\n  format: "{type}/{issueNumber}-{slug}"\n  types: [story, bug]\n',
    ),
  );
  assert.deepEqual(overlay.branch, {
    pattern: "^(story|bug)/[0-9]+-[a-z0-9-]+$",
    format: "{type}/{issueNumber}-{slug}",
    types: ["story", "bug"],
  });
});

test("PR policy branch rule rejects invalid formatter declarations with bounded paths", () => {
  for (const [branch, path] of [
    ['  pattern: "^x$"\n  format: "no-number"\n', "$.branch.format"],
    ['  pattern: "^x$"\n  format: "{type}/{issueNumber}"\n', "$.branch.types"],
    ['  pattern: "^x$"\n  format: "x/{issueNumber}"\n  types: [a]\n', "$.branch.types"],
    ['  pattern: "^x$"\n  format: 3\n', "$.branch.format"],
    ['  pattern: "^x$"\n  derive: true\n', "$.branch.derive"],
  ] as const) {
    assert.throws(
      () => parsePullRequestPolicyOverlay(branchPolicy(branch)),
      (error: unknown) => error instanceof PullRequestPolicyError && error.path === path,
      branch,
    );
  }
});
