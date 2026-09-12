import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "self-dogfood-certification.yml"),
  "utf8",
);

test("self-dogfood certification is an explicit, source-addressable privileged opt-in", () => {
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /disposable_issue:/u);
  assert.match(workflow, /confirm_disposable:/u);
  assert.match(workflow, /exercise_abort:/u);
  assert.match(workflow, /actions: write/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$\{GITHUB_SHA\}"/u);
  assert.match(workflow, /pnpm pack --pack-destination/u);
  assert.match(workflow, /pnpm add --ignore-scripts --save-exact/u);
  assert.match(workflow, /--inari "\$DOGFOOD_INSTALLED_EXECUTABLE"/u);
  assert.match(workflow, /scripts\/self-dogfood\.mjs/u);
  assert.match(workflow, /scripts\/self-dogfood-workflow\.mjs/u);
  assert.match(workflow, /name: self-dogfood-golden-path-\$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/u);
});

test("self-dogfood workflow contains no manual branch or pull-request mutation path", () => {
  assert.doesNotMatch(workflow, /gh\s+(?:api|pr\s+create|issue\s+create)/u);
  assert.doesNotMatch(workflow, /git\s+(?:push|update-ref|branch\s+-f)/u);
});
