import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "inari-change-executor.yml");

test("trusted Change workflow delegates semantic decisions to the versioned executor", () => {
  const source = fs.readFileSync(workflowPath, "utf8");
  assert.match(source, /INARI_CHANGE_REQUEST:/u);
  assert.match(source, /node dist\/github\/actions-change-executor\.js/u);
  assert.match(source, /ref: refs\/heads\/main/u);
  assert.match(source, /persist-credentials: false/u);
  assert.doesNotMatch(source, /^\s+(branch|pull_request|lifecycle|idempotency|compensation|recovery):/imu);
  assert.doesNotMatch(source, /ref:\s*\$\{\{/u);
});
