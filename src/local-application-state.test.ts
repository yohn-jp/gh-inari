import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { projectLocalApplicationState, projectLocalRuntimeReadiness } from "./local-application-state.js";

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "inari-local-application-state-"));
}

function git(root: string, ...args: readonly string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function environmentFor(root: string): NodeJS.ProcessEnv {
  return { INARI_CONFIG_HOME: path.join(root, "config") };
}

test("#1065: the local Runtime Supervisor is the sole canonical runtime command", async () => {
  const root = await temporaryRoot();
  try {
    const state = await projectLocalApplicationState({ root, environment: environmentFor(root) });
    assert.deepEqual(state.runtime.commands, ["inari runtime supervise"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#1065: no Issue/Change branch is selected outside a Git checkout", async () => {
  const root = await temporaryRoot();
  try {
    const state = await projectLocalApplicationState({ root, environment: environmentFor(root) });
    assert.equal(state.changeBranch.status, "issue-not-selected");
    assert.equal(state.changeBranch.issue, undefined);
    assert.equal(state.changeBranch.branch, undefined);
    assert.match(state.changeBranch.detail, /<feat\|fix\|docs\|refactor\|test\|chore>\/<issue-number>-<slug>/u);
    assert.equal("command" in state.changeBranch, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#1065: nextAction.commands never carries a placeholder that a shell would parse as an operator", async () => {
  // Review finding on PR #1088: the branch-naming placeholder pattern uses
  // `<`, `|`, and `>`, which are shell redirection/pipeline operators. It
  // must never appear inside `nextAction.commands`, since the CLI and
  // console both print each entry as a literal "Run: ..." command.
  const root = await temporaryRoot();
  try {
    const state = await projectLocalApplicationState({ root, environment: environmentFor(root) });
    for (const command of state.nextAction.commands) {
      assert.doesNotMatch(command, /[<>|]/u, `nextAction.commands entry is not a literal shell command: ${command}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#1065: no Issue/Change branch is selected while on the default branch", async () => {
  const root = await temporaryRoot();
  try {
    git(root, "init", "--quiet");
    git(root, "checkout", "-q", "-b", "main");
    const state = await projectLocalApplicationState({ root, environment: environmentFor(root) });
    assert.equal(state.changeBranch.status, "issue-not-selected");
    assert.equal(state.changeBranch.branch, "main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#1065: a canonical Issue-bound Change branch is projected as ready", async () => {
  const root = await temporaryRoot();
  try {
    git(root, "init", "--quiet");
    git(root, "checkout", "-q", "-b", "feat/777-canonical-branch-readiness");
    const state = await projectLocalApplicationState({ root, environment: environmentFor(root) });
    assert.deepEqual(state.changeBranch, {
      status: "ready",
      detail: "Local branch feat/777-canonical-branch-readiness is the canonical Change branch for Issue #777.",
      issue: 777,
      branch: "feat/777-canonical-branch-readiness",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#1065: a non-canonical branch is a mismatch, not a silent pass-through to Session start", async () => {
  const root = await temporaryRoot();
  try {
    git(root, "init", "--quiet");
    git(root, "checkout", "-q", "-b", "wip-exploration");
    const state = await projectLocalApplicationState({ root, environment: environmentFor(root) });
    assert.equal(state.changeBranch.status, "branch-mismatch");
    assert.equal(state.changeBranch.branch, "wip-exploration");
    assert.match(state.changeBranch.detail, /<feat\|fix\|docs\|refactor\|test\|chore>\/<issue-number>-<slug>/u);
    assert.equal("command" in state.changeBranch, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#1065: an Epic/Issue integration branch is a mismatch, not a canonical Change branch", async () => {
  const root = await temporaryRoot();
  try {
    git(root, "init", "--quiet");
    git(root, "checkout", "-q", "-b", "epic/1071-local-runtime-ux");
    const state = await projectLocalApplicationState({ root, environment: environmentFor(root) });
    assert.equal(state.changeBranch.status, "branch-mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#1092: the Issuer key setup step checks only the Executor-owned reference and never reads key material", async () => {
  const root = await temporaryRoot();
  try {
    const missing = await projectLocalApplicationState({ root, environment: environmentFor(root) });
    assert.equal(missing.provider.issuerKey, "missing");
    assert.equal(missing.steps.find((step) => step.id === "executor-issuer-key")?.status, "required");

    // Inline PEM variables are not a Local Executor custody reference.
    const inline = await projectLocalApplicationState({
      root,
      environment: {
        ...environmentFor(root),
        INARI_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\ninline\n-----END PRIVATE KEY-----\n",
      },
    });
    assert.equal(inline.provider.issuerKey, "missing");

    // A reference to an absent file projects as configured: the projection never opens it.
    const absent = await projectLocalApplicationState({
      root,
      environment: {
        ...environmentFor(root),
        INARI_GITHUB_APP_PRIVATE_KEY_FILE: path.join(root, "absent-issuer-app.private-key.pem"),
      },
    });
    assert.equal(absent.provider.issuerKey, "configured");
    assert.equal(absent.steps.find((step) => step.id === "executor-issuer-key")?.status, "ready");

    // Malformed material also projects as configured and is never echoed: the projection never parses it.
    const sentinel = "bm90LWEta2V5LXNlbnRpbmVs";
    const keyPath = path.join(root, "issuer-app.private-key.pem");
    await writeFile(keyPath, `-----BEGIN PRIVATE KEY-----\n${sentinel}\n-----END PRIVATE KEY-----\n`, { mode: 0o600 });
    const malformed = await projectLocalApplicationState({
      root,
      environment: { ...environmentFor(root), INARI_GITHUB_APP_PRIVATE_KEY_FILE: keyPath },
    });
    assert.equal(malformed.provider.issuerKey, "configured");
    const rendered = JSON.stringify(malformed);
    assert.equal(rendered.includes(sentinel), false);
    assert.equal(rendered.includes("PRIVATE KEY"), false);
    assert.equal(rendered.includes("EXECUTOR_ISSUER_KEY_INVALID"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#1108: live Runtime readiness is projected from public role health without a running Runtime", async () => {
  const root = await temporaryRoot();
  try {
    assert.deepEqual(await projectLocalRuntimeReadiness(environmentFor(root)), {
      executor: "not-running",
      admission: "not-running",
      overall: "not-ready",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
