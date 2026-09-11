import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "change-provenance.yml");

test("Change provenance suspension preserves the required check as an explicit no-op", () => {
  const source = fs.readFileSync(workflowPath, "utf8");

  assert.match(source, /^name: Change provenance$/mu);
  assert.match(source, /^permissions: \{\}$/mu);
  assert.match(source, /^\s+name: Change provenance$/mu);
  assert.match(source, /name: Change provenance temporarily suspended/u);
  assert.match(source, /issue #437/u);

  assert.doesNotMatch(source, /actions\/checkout/u);
  assert.doesNotMatch(source, /actions\/setup-node/u);
  assert.doesNotMatch(source, /pnpm install/u);
  assert.doesNotMatch(source, /^\s*run:\s*.*validate-change-merge-admission\.mjs/mu);
  assert.doesNotMatch(source, /^\s+.*validate-change-merge-admission\.mjs\s*$/mu);
  assert.doesNotMatch(source, /hashFiles\(/u);
  assert.doesNotMatch(source, /change-provenance-suspended\.md/u);

  assert.match(source, /To re-enable: revert this commit/u);
  assert.match(source, /do not leave any trace of this suspension/u);
});
