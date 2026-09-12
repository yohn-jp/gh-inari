import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArguments, projectWorkerHandoff, sanitizeWorkerEnvironment } from "./self-dogfood.mjs";

const scriptPath = fileURLToPath(new URL("./self-dogfood.mjs", import.meta.url));

test("self-dogfood requires an exact disposable Issue confirmation", () => {
  const parsed = parseArguments(["--repository", "yohn-jp/gh-inari", "--issue", "416", "--confirm-disposable", "415"]);
  assert.equal(parsed.options.issue, 416);
  assert.notEqual(
    parsed.options.confirmDisposable,
    parsed.options.issue,
    "the execution precondition must reject this mismatch before any provider call",
  );
});

test("evidence authority does not skip the following repository option", () => {
  const parsed = parseArguments([
    "--evidence-authority",
    "/tmp/shared-certification-authority.mjs",
    "--repository",
    "yohn-jp/gh-inari",
    "--issue",
    "416",
    "--confirm-disposable",
    "416",
  ]);
  assert.equal(parsed.options.evidenceAuthority, "/tmp/shared-certification-authority.mjs");
  assert.deepEqual(parsed.options.repository, { owner: "yohn-jp", name: "gh-inari" });
  assert.equal(parsed.options.issue, 416);
});

test("worker handoff allowlists environment and carries only bounded identities", () => {
  const environment = sanitizeWorkerEnvironment(
    {
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      GH_TOKEN: "issuer-secret",
      INARI_ISSUER_PRIVATE_KEY: "private-key",
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
    assert.equal(evidence.schemaVersion, "1");
    assert.equal(evidence.certificationKind, "self-dogfood-golden-path");
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
  const authority = path.join(root, "authority.mjs");
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
const common = { branch: "feat/239-self-dogfood", pullRequest: 9239, version: 1 };
let output;
if (args.includes("--version")) output = { ok: true, name: "gh-inari", version: "0.11.0" };
else if (args.includes("skill")) output = { id: "golden-path", version: "1.1.0", workflow: [] };
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
fs.writeFileSync(${JSON.stringify(workerObservation)}, JSON.stringify({ token: process.env.GH_TOKEN, branch: process.env.INARI_IMPLEMENTATION_BRANCH }));
`,
    { encoding: "utf8", mode: 0o600 },
  );
  fs.writeFileSync(
    authority,
    `export function validateDisposableGovernedIssue(value) { return { valid: value.disposableMarker?.kind === "self-dogfood" }; }
export function validateSelfDogfoodEvidence(value) { return { valid: value.result === "passed" && value.schemaVersion === "1" }; }
`,
    { encoding: "utf8", mode: 0o600 },
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
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
        "--evidence-authority",
        authority,
        "--output",
        outputFile,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          INARI_SELF_DOGFOOD: "1",
          GH_TOKEN: "issuer-secret",
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
      [
        "preflight.opt-in",
        "preflight.installed-executable",
        "skill.golden-path",
        "disposable-issue.governance-check",
        "change.issue.first",
        "change.issue.return-existing",
        "change.handoff",
        "worker.implementation",
        "change.ready.first",
        "change.ready.reread",
        "change.ready.retry",
      ],
    );
    const observation = JSON.parse(fs.readFileSync(workerObservation, "utf8"));
    assert.equal(observation.token, undefined);
    assert.equal(observation.branch, "feat/239-self-dogfood");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
