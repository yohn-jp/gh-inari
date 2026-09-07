import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "change-provenance.yml");

test("Change provenance bootstrap executes the validator from the pull request head", () => {
  const source = fs.readFileSync(workflowPath, "utf8");

  assert.match(source, /name: Checkout pull request head/u);
  assert.match(source, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
  assert.match(source, /persist-credentials: false/u);
  assert.doesNotMatch(source, /github\.event\.repository\.default_branch/u);
});
