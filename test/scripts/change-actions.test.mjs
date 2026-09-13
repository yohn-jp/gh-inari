import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "inari-change-executor.yml");

function workflowStep(source, name, nextName) {
  const start = source.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `${name} step is present`);
  const end = nextName === undefined ? source.length : source.indexOf(`      - name: ${nextName}`, start);
  assert.notEqual(end, -1, `${nextName} step follows ${name}`);
  return source.slice(start, end);
}

test("trusted Change workflow delegates semantic decisions to the versioned executor", () => {
  const source = fs.readFileSync(workflowPath, "utf8");
  assert.match(source, /INARI_CHANGE_REQUEST:/u);
  assert.match(source, /node dist\/github\/actions-change-executor\.js/u);
  assert.match(source, /ref: \$\{\{ github\.workflow_sha \}\}/u);
  assert.match(source, /persist-credentials: false/u);
  assert.doesNotMatch(source, /^\s+(branch|pull_request|lifecycle|idempotency|compensation|recovery):/imu);
  assert.doesNotMatch(source, /^\s+ref: refs\/heads\/main$/mu);
});

test("trusted Change build failures remain a bounded preparation result", () => {
  const source = fs.readFileSync(workflowPath, "utf8");
  const initialization = workflowStep(source, "Initialize bounded result", "Checkout trusted executor source");
  const build = workflowStep(source, "Build trusted executor", "Execute Core plan");
  const execution = workflowStep(source, "Execute Core plan", "Publish bounded result");

  assert.match(initialization, /mkdir -p "\$RUNNER_TEMP\/inari-change-result"/u);
  assert.match(initialization, /"message":"Trusted Change runtime preparation failed closed\."/u);
  assert.match(initialization, /"stage":"trusted-execution"/u);
  assert.match(build, /id: build/u);
  assert.match(build, /corepack pnpm run build/u);
  assert.doesNotMatch(build, /actions-change-executor\.js/u);
  assert.match(execution, /if: steps\.build\.outcome == 'success'/u);
  assert.match(source, /if: always\(\)/u);
  assert.match(source, /path: \$\{\{ runner\.temp \}\}\/inari-change-result\/result\.json/u);
});

test("trusted executor exit 1 preserves its bounded result after a successful build", () => {
  const source = fs.readFileSync(workflowPath, "utf8");
  const build = workflowStep(source, "Build trusted executor", "Execute Core plan");
  const execution = workflowStep(source, "Execute Core plan", "Publish bounded result");

  assert.ok(source.indexOf("      - name: Build trusted executor") < source.indexOf("      - name: Execute Core plan"));
  assert.match(build, /corepack pnpm run build/u);
  assert.doesNotMatch(execution, /corepack pnpm run build/u);
  assert.match(execution, /node dist\/github\/actions-change-executor\.js > "\$result_path" 2>\/dev\/null/u);
  assert.match(execution, /execution_status=\$\?/u);
  assert.match(execution, /if \[ ! -s "\$result_path" \] \|\| \[ "\$\(wc -c < "\$result_path"\)" -gt 262144 \]; then/u);
  assert.match(execution, /message":"Trusted Change execution failed closed\."/u);
  assert.match(execution, /if \[ "\$execution_status" -ne 0 \]; then/u);
  assert.match(execution, /Trusted Change executor result:/u);
  assert.match(execution, /process\.stdout\.write\(raw\)/u);
  assert.match(execution, /result = JSON\.parse\(raw\)/u);
  assert.match(execution, /2>\/dev\/null/u);
  assert.ok(
    execution.indexOf('if [ "$execution_status" -ne 0 ]; then') < execution.indexOf("process.stdout.write(raw)"),
  );
  assert.match(execution, /exit "\$execution_status"/u);
  assert.doesNotMatch(source, /tee .*result\.json/u);
});
