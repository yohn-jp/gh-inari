import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
  CERTIFICATION_KINDS,
  SELF_DOGFOOD_OPERATION_REQUIREMENTS,
} from "../../scripts/certification-evidence.mjs";
import {
  INARI_SUPERVISION_TIMEOUT_MS,
  parseArguments,
  projectWorkerHandoff,
  runCommand,
  sanitizeWorkerEnvironment,
} from "../../scripts/self-dogfood.mjs";
import { DEFAULT_CHANGE_EXECUTION_DEADLINE_MS } from "../../src/change-execution-port.ts";

const scriptPath = fileURLToPath(new URL("../../scripts/self-dogfood.mjs", import.meta.url));

test("self-dogfood requires an exact disposable Issue confirmation", () => {
  const parsed = parseArguments(["--repository", "yohn-jp/gh-inari", "--issue", "416", "--confirm-disposable", "415"]);
  assert.equal(parsed.options.issue, 416);
  assert.notEqual(
    parsed.options.confirmDisposable,
    parsed.options.issue,
    "the execution precondition must reject this mismatch before any provider call",
  );
});

test("self-dogfood derives the installed inari supervision timeout from the canonical execution deadline, not a duplicated magic constant", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.doesNotMatch(source, /DEFAULT_(?:POLL_ATTEMPTS|POLL_INTERVAL_MS|MAX_WAIT_MS)/u);
  assert.doesNotMatch(source, /const COMMAND_TIMEOUT_MS/u);
  assert.ok(
    INARI_SUPERVISION_TIMEOUT_MS > DEFAULT_CHANGE_EXECUTION_DEADLINE_MS,
    "the outer process supervision timeout must exceed the canonical transport deadline it wraps",
  );
  // --timeout-ms remains a worker-specific override; it must not affect the
  // installed inari invocation's own bounded supervision.
  assert.equal(parseArguments(["--issue", "416", "--confirm-disposable", "416"]).options.timeoutMs, undefined);
});

test("runCommand terminates a hung child process within its bounded timeout", () => {
  const start = Date.now();
  const result = runCommand("node", ["-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 200 });
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.ok(elapsed < 5_000, "a hung process must be terminated promptly by the bounded timeout, not left to run");
});

test("runCommand does not kill a healthy process finishing near a short timeout", () => {
  const result = runCommand("node", ["-e", "setTimeout(() => { process.exit(0); }, 50)"], { timeoutMs: 5_000 });
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
});

test("self-dogfood does not accept a replaceable evidence authority", () => {
  assert.throws(
    () =>
      parseArguments([
        "--evidence-authority",
        "/tmp/shared-certification-authority.mjs",
        "--repository",
        "yohn-jp/gh-inari",
        "--issue",
        "416",
        "--confirm-disposable",
        "416",
      ]),
    /unknown option/u,
  );
});

test("worker handoff allowlists environment and carries only bounded identities", () => {
  const environment = sanitizeWorkerEnvironment(
    {
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      GH_TOKEN: "issuer-secret",
      INARI_ISSUER_PRIVATE_KEY: "private-key",
      INARI_RUNTIME_AUTHORITY_ID: "yohn-self-dogfood-ci-2026-09",
      INARI_RUNTIME_AUTHORITY_PRIVATE_KEY: "runtime-private-key",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
    },
    {
      version: 1,
      kind: "implementation-handoff",
      repositoryHost: "github.com",
      repositoryId: "123239",
      rootIssue: 239,
      changeVersion: 1,
      state: "DRAFT",
      branch: "feat/239-disposable-dogfood",
      baseBranch: "main",
      pullRequest: 9239,
    },
    "a".repeat(40),
  );

  assert.deepEqual(environment.PATH, "/usr/bin");
  assert.deepEqual(environment.HOME, "/tmp/home");
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.INARI_ISSUER_PRIVATE_KEY, undefined);
  assert.equal(environment.INARI_RUNTIME_AUTHORITY_ID, undefined);
  assert.equal(environment.INARI_RUNTIME_AUTHORITY_PRIVATE_KEY, undefined);
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.INARI_CHANGE_ISSUE, "239");
  assert.equal(environment.INARI_IMPLEMENTATION_BRANCH, "feat/239-disposable-dogfood");
  assert.equal(environment.INARI_SOURCE_COMMIT_SHA, "a".repeat(40));
  assert.doesNotMatch(environment.INARI_IMPLEMENTATION_HANDOFF, /secret|private|token/iu);
});

test("worker handoff rejects unknown sensitive fields instead of serializing them", () => {
  const handoff = {
    version: 1,
    kind: "implementation-handoff",
    repositoryHost: "github.com",
    repositoryId: "123239",
    rootIssue: 239,
    changeVersion: 1,
    state: "DRAFT",
    branch: "feat/239-disposable-dogfood",
    baseBranch: "main",
    pullRequest: 9239,
    token: "issuer-secret",
    privateKey: "issuer-private-key",
  };
  assert.throws(() => projectWorkerHandoff(handoff), /unsupported fields/u);
  assert.throws(() => sanitizeWorkerEnvironment({}, handoff, "a".repeat(40)), /unsupported fields/u);
});

test("worker handoff rejects forged lifecycle or identity values", () => {
  const handoff = {
    version: 1,
    kind: "implementation-handoff",
    repositoryHost: "github.com",
    repositoryId: "123239",
    rootIssue: 239,
    changeVersion: 1,
    state: "DRAFT",
    branch: "feat/239-disposable-dogfood",
    baseBranch: "main",
    pullRequest: 9239,
  };
  assert.doesNotThrow(() => projectWorkerHandoff(handoff));
  for (const [field, value] of [
    ["version", "1"],
    ["kind", "other"],
    ["rootIssue", 0],
    ["changeVersion", 2],
    ["state", "REVIEW"],
    ["pullRequest", 0],
  ]) {
    assert.throws(() => projectWorkerHandoff({ ...handoff, [field]: value }), /implementation handoff/u, field);
  }
});

test("worker handoff preserves the canonical optional repository locator", () => {
  const handoff = {
    version: 1,
    kind: "implementation-handoff",
    repositoryHost: "github.com",
    repositoryId: "123239",
    repositoryNameWithOwner: "yohn-jp/gh-inari",
    rootIssue: 239,
    changeVersion: 1,
    state: "DRAFT",
    branch: "feat/239-disposable-dogfood",
    baseBranch: "main",
    pullRequest: 9239,
  };
  assert.equal(projectWorkerHandoff(handoff).repositoryNameWithOwner, "yohn-jp/gh-inari");
  assert.equal(
    JSON.parse(sanitizeWorkerEnvironment({}, handoff, "a".repeat(40)).INARI_IMPLEMENTATION_HANDOFF)
      .repositoryNameWithOwner,
    "yohn-jp/gh-inari",
  );
  assert.throws(
    () => projectWorkerHandoff({ ...handoff, repositoryNameWithOwner: "not-a-locator" }),
    /repository locator/u,
  );
});

test("live dogfood is opt-in and emits bounded blocked evidence without mutation", () => {
  const workerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "inari-self-dogfood-test-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        scriptPath,
        "--repository",
        "yohn-jp/gh-inari",
        "--issue",
        "239",
        "--confirm-disposable",
        "239",
        "--worker-cwd",
        workerDirectory,
        "--worker-command",
        '["node","-e","process.exit(0)"]',
      ],
      { encoding: "utf8", env: { ...process.env, INARI_SELF_DOGFOOD: undefined } },
    );
    assert.equal(result.status, 2);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.schemaVersion, CERTIFICATION_EVIDENCE_SCHEMA_VERSION);
    assert.equal(evidence.certificationKind, CERTIFICATION_KINDS[1]);
    assert.equal(evidence.result, "blocked");
    assert.match(evidence.sourceCommitSha, /^[0-9a-f]{40}$/u);
    assert.ok(evidence.diagnostics.length > 0);
    assert.ok(evidence.diagnostics.length <= 20);
    assert.ok(evidence.diagnostics.every((item) => item.message.length <= 512));
    assert.deepEqual(evidence.operations, []);
  } finally {
    fs.rmSync(workerDirectory, { recursive: true, force: true });
  }
});

test("opt-in flow consumes canonical handoff and keeps worker credentials isolated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inari-self-dogfood-flow-"));
  const workerDirectory = path.join(root, "worker");
  fs.mkdirSync(workerDirectory);
  const stateFile = path.join(root, "provider-state");
  const workerObservation = path.join(root, "worker-observation");
  const outputFile = path.join(root, "evidence.json");
  const fakeInari = path.join(root, "fake-inari.mjs");
  const worker = path.join(root, "worker.mjs");
  fs.writeFileSync(
    fakeInari,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_INARI_STATE;
const issueCount = Number(fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : "0");
const issue = args.includes("issue") && args.includes("change");
if (issue) fs.writeFileSync(stateFile, String(issueCount + 1));
const readyStateFile = process.env.FAKE_INARI_READY_STATE;
const readyCount = Number(fs.existsSync(readyStateFile) ? fs.readFileSync(readyStateFile, "utf8") : "0");
const ready = args.includes("ready");
if (ready) fs.writeFileSync(readyStateFile, String(readyCount + 1));
const common = { branch: "feat/239-self-dogfood", canonicalBaseBranch: "main", pullRequest: 9239, version: 1, contractVersions: { goldenPath: "1", statusRecovery: "1" } };
let output;
if (args.includes("--version")) output = { ok: true, name: "gh-inari", version: "0.11.0" };
else if (args.includes("skill")) output = { id: "golden-path", version: "1.1.0", contractVersions: { goldenPath: "1", statusRecovery: "1" }, workflow: [] };
else if (args.includes("check")) output = { valid: true, governance: { valid: true }, disposableMarker: { version: 1, kind: "self-dogfood" } };
else if (issue) output = { ok: true, state: "DRAFT", ...common, recovery: { state: "none", action: "none" }, evidence: { outcome: issueCount === 0 ? "verified" : "returned-existing" } };
else if (args.includes("handoff")) output = { ok: true, state: "DRAFT", ...common, recovery: { state: "none", action: "none" }, handoff: { version: 1, kind: "implementation-handoff", repositoryHost: "github.com", repositoryId: "123239", rootIssue: 239, state: "DRAFT", branch: common.branch, baseBranch: "main", pullRequest: common.pullRequest, changeVersion: 1 } };
else if (args.includes("show")) output = { ok: true, state: "REVIEW", ...common, recovery: { state: "none", action: "none" } };
else if (ready) output = { ok: true, state: "REVIEW", ...common, recovery: { state: "none", action: "none" }, evidence: { outcome: readyCount === 0 ? "verified" : "returned-existing" } };
else output = { ok: false };
console.log(JSON.stringify(output));
`,
    { encoding: "utf8", mode: 0o755 },
  );
  fs.writeFileSync(
    worker,
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(workerObservation)}, JSON.stringify({
  token: process.env.GH_TOKEN,
  runtimeAuthorityId: process.env.INARI_RUNTIME_AUTHORITY_ID,
  runtimeAuthorityPrivateKey: process.env.INARI_RUNTIME_AUTHORITY_PRIVATE_KEY,
  branch: process.env.INARI_IMPLEMENTATION_BRANCH,
}));
`,
    { encoding: "utf8", mode: 0o600 },
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        scriptPath,
        "--inari",
        fakeInari,
        "--repository",
        "yohn-jp/gh-inari",
        "--issue",
        "239",
        "--confirm-disposable",
        "239",
        "--worker-cwd",
        workerDirectory,
        "--worker-command",
        JSON.stringify([process.execPath, worker]),
        "--output",
        outputFile,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          INARI_SELF_DOGFOOD: "1",
          GH_TOKEN: "issuer-secret",
          INARI_RUNTIME_AUTHORITY_ID: "yohn-self-dogfood-ci-2026-09",
          INARI_RUNTIME_AUTHORITY_PRIVATE_KEY: "runtime-private-key",
          FAKE_INARI_STATE: stateFile,
          FAKE_INARI_READY_STATE: path.join(root, "provider-ready-state"),
        },
      },
    );
    assert.equal(
      result.status,
      0,
      `stderr: ${result.stderr}\nstdout: ${result.stdout}\nevidence: ${fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "missing"}`,
    );
    const evidence = JSON.parse(fs.readFileSync(outputFile, "utf8"));
    assert.equal(evidence.result, "passed");
    assert.deepEqual(evidence.contractVersions, { goldenPath: "1", statusRecovery: "1", skill: "1.1.0" });
    assert.equal(evidence.change.pullRequest, 9239);
    assert.deepEqual(
      evidence.operations.map(({ operation }) => operation),
      SELF_DOGFOOD_OPERATION_REQUIREMENTS.map(({ operation }) => operation),
    );
    const observation = JSON.parse(fs.readFileSync(workerObservation, "utf8"));
    assert.equal(observation.token, undefined);
    assert.equal(observation.runtimeAuthorityId, undefined);
    assert.equal(observation.runtimeAuthorityPrivateKey, undefined);
    assert.equal(observation.branch, "feat/239-self-dogfood");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failure after a recorded mid-lifecycle status still writes schema-valid blocked evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inari-self-dogfood-blocked-"));
  const workerDirectory = path.join(root, "worker");
  fs.mkdirSync(workerDirectory);
  const workerObservation = path.join(root, "worker-observation");
  const outputFile = path.join(root, "evidence.json");
  const issueStateFile = path.join(root, "provider-issue-state");
  const fakeInari = path.join(root, "fake-inari.mjs");
  const worker = path.join(root, "worker.mjs");
  fs.writeFileSync(
    fakeInari,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const issueStateFile = process.env.FAKE_INARI_ISSUE_STATE;
const issue = args.includes("issue") && args.includes("change");
const issueCount = Number(fs.existsSync(issueStateFile) ? fs.readFileSync(issueStateFile, "utf8") : "0");
if (issue) fs.writeFileSync(issueStateFile, String(issueCount + 1));
const ready = args.includes("ready");
const common = { branch: "feat/239-self-dogfood", canonicalBaseBranch: "main", pullRequest: 9239, version: 1, contractVersions: { goldenPath: "1", statusRecovery: "1" } };
let output;
if (args.includes("--version")) output = { ok: true, name: "gh-inari", version: "0.11.0" };
else if (args.includes("skill")) output = { id: "golden-path", version: "1.1.0", contractVersions: { goldenPath: "1", statusRecovery: "1" }, workflow: [] };
else if (args.includes("check")) output = { valid: true, governance: { valid: true }, disposableMarker: { version: 1, kind: "self-dogfood" } };
else if (issue) output = { ok: true, state: "DRAFT", ...common, recovery: { state: "none", action: "none" }, evidence: { outcome: issueCount === 0 ? "verified" : "returned-existing" } };
else if (args.includes("handoff")) output = { ok: true, state: "DRAFT", ...common, recovery: { state: "none", action: "none" }, handoff: { version: 1, kind: "implementation-handoff", repositoryHost: "github.com", repositoryId: "123239", rootIssue: 239, state: "DRAFT", branch: common.branch, baseBranch: "main", pullRequest: common.pullRequest, changeVersion: 1 } };
else if (ready) {
  console.log(JSON.stringify({
    ok: false,
    error: {
      code: "CHANGE_REMOTE_RUN_FAILED",
      message: "The trusted Change workflow did not produce a successful result.",
      details: {
        operation: "change.ready",
        reason: "workflow-failed",
        stage: "projection-execution",
        trustedCode: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
        token: "issuer-secret",
        diagnostics: [{ version: 1, code: "CHANGE_PROVENANCE_CONFLICT", path: "$.projection.change.provenance", message: "The trusted Change provenance is inconsistent." }],
        evidence: {
          version: 1,
          operation: "ready",
          outcome: "recovery-required",
          effects: [{ kind: "MARK_PULL_REQUEST_READY", status: "failed" }],
          compensation: "failed",
          failure: {
            kind: "MARK_PULL_REQUEST_READY",
            code: "CHANGE_EFFECT_FAILED",
            message: "The ready effect failed.",
            reason: "provider-http",
            status: 422,
            provider: { category: "validation-failed", resource: "PullRequest", field: "head", code: "custom" },
          },
        },
      },
    },
  }));
  process.exit(1);
}
else output = { ok: false };
console.log(JSON.stringify(output));
`,
    { encoding: "utf8", mode: 0o755 },
  );
  fs.writeFileSync(
    worker,
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(workerObservation)}, JSON.stringify({ token: process.env.GH_TOKEN, branch: process.env.INARI_IMPLEMENTATION_BRANCH }));
`,
    { encoding: "utf8", mode: 0o600 },
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        scriptPath,
        "--inari",
        fakeInari,
        "--repository",
        "yohn-jp/gh-inari",
        "--issue",
        "239",
        "--confirm-disposable",
        "239",
        "--worker-cwd",
        workerDirectory,
        "--worker-command",
        JSON.stringify([process.execPath, worker]),
        "--output",
        outputFile,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          INARI_SELF_DOGFOOD: "1",
          GH_TOKEN: "issuer-secret",
          FAKE_INARI_ISSUE_STATE: issueStateFile,
        },
      },
    );
    assert.equal(
      result.status,
      2,
      `stderr: ${result.stderr}\nstdout: ${result.stdout}\nevidence: ${fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "missing"}`,
    );
    assert.equal(fs.existsSync(outputFile), true, "a blocked run must still write evidence instead of crashing");
    const evidence = JSON.parse(fs.readFileSync(outputFile, "utf8"));
    assert.equal(evidence.result, "blocked");
    assert.deepEqual(evidence.finalState, {
      status: "UNAVAILABLE",
      recovery: { state: "unavailable", action: "inspect" },
    });
    const failedCommand = evidence.diagnostics.find(({ code }) => code === "CHANGE_REMOTE_RUN_FAILED");
    assert.ok(failedCommand, JSON.stringify(evidence));
    assert.deepEqual(failedCommand?.details, {
      operation: "change.ready",
      reason: "workflow-failed",
      stage: "projection-execution",
      trustedCode: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
      diagnostics: [
        {
          version: 1,
          code: "CHANGE_PROVENANCE_CONFLICT",
          path: "$.projection.change.provenance",
          message: "The trusted Change provenance is inconsistent.",
        },
      ],
      evidence: {
        version: 1,
        operation: "ready",
        outcome: "recovery-required",
        effects: [{ kind: "MARK_PULL_REQUEST_READY", status: "failed" }],
        compensation: "failed",
        failure: {
          kind: "MARK_PULL_REQUEST_READY",
          code: "CHANGE_EFFECT_FAILED",
          message: "The ready effect failed.",
          reason: "provider-http",
          status: 422,
          provider: { category: "validation-failed", resource: "PullRequest", field: "head", code: "custom" },
        },
      },
    });
    assert.doesNotMatch(JSON.stringify(evidence), /issuer-secret|runtime-private-key|rawBody|provider-payload/iu);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
