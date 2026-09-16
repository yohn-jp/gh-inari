import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "self-dogfood-certification.yml"),
  "utf8",
);

test("self-dogfood certification is an explicit, source-addressable privileged opt-in", () => {
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /disposable_issue:/u);
  assert.match(workflow, /confirm_disposable:/u);
  assert.match(workflow, /--scenario fresh-create/u);
  assert.match(workflow, /exercise_abort:/u);
  assert.match(workflow, /actions: write/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$\{GITHUB_SHA\}"/u);
  assert.match(workflow, /pnpm pack --pack-destination/u);
  assert.match(workflow, /pnpm add --ignore-scripts --save-exact/u);
  assert.match(workflow, /packageMetadata\.bin\.inari/u);
  assert.doesNotMatch(workflow, /node_modules\/\.bin\/inari/u);
  assert.match(workflow, /--inari "\$DOGFOOD_INSTALLED_EXECUTABLE"/u);
  assert.match(workflow, /scripts\/self-dogfood\.mjs/u);
  assert.match(workflow, /scripts\/self-dogfood-workflow\.mjs/u);
  assert.match(
    workflow,
    /name: self-dogfood-golden-path-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u,
  );
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/u);
});

test("self-dogfood signer is dedicated and scoped to the coordinator", () => {
  assert.match(workflow, /environment:\n\s+name: self-dogfood-certification/u);
  assert.match(workflow, /INARI_RUNTIME_AUTHORITY_ID: \$\{\{ vars\.INARI_RUNTIME_AUTHORITY_ID \}\}/u);
  assert.match(
    workflow,
    /INARI_RUNTIME_AUTHORITY_PRIVATE_KEY: \$\{\{ secrets\.INARI_RUNTIME_AUTHORITY_PRIVATE_KEY \}\}/u,
  );
  assert.match(workflow, /test "\$INARI_RUNTIME_AUTHORITY_ID" = "yohn-self-dogfood-ci-2026-09"/u);
  assert.match(workflow, /test -n "\$INARI_RUNTIME_AUTHORITY_PRIVATE_KEY"/u);
  assert.doesNotMatch(workflow, /yohn-runtime-2026-09/u);

  const coordinatorStart = workflow.indexOf(
    "- name: Run the real self-dogfood coordinator with the installed artifact",
  );
  assert.notEqual(coordinatorStart, -1);
  assert.doesNotMatch(workflow.slice(0, coordinatorStart), /INARI_RUNTIME_AUTHORITY_PRIVATE_KEY/u);
  assert.equal((workflow.match(/INARI_RUNTIME_AUTHORITY_PRIVATE_KEY:/gu) ?? []).length, 1);
});

test("self-dogfood workflow contains no manual branch or pull-request mutation path", () => {
  assert.doesNotMatch(workflow, /gh\s+(?:api|pr\s+create|issue\s+create)/u);
  assert.doesNotMatch(workflow, /git\s+(?:push|update-ref|branch\s+-f)/u);
});
