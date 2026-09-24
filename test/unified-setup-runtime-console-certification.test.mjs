import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliEntry = path.join(projectRoot, "src/index.ts");
const tsx = path.join(projectRoot, "node_modules/.bin/tsx");

function command(args, { cwd, env, timeout = 20_000 } = {}) {
  const result = spawnSync(tsx, [cliEntry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

function successful(result, label) {
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${label}: ${result.stdout}\n${result.stderr}`);
  return result;
}

function jsonOutput(result, label) {
  successful(result, label);
  const lines = result.stdout.trim().split("\n");
  return JSON.parse(lines.at(-1));
}

async function startConsole(cwd, env) {
  const child = spawn(tsx, [cliEntry, "runtime", "console", "--json"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const announcement = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runtime console timed out: ${stdout}\n${stderr}`)), 15_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split("\n").find((candidate) => candidate.startsWith("{"));
      if (line === undefined) return;
      try {
        const value = JSON.parse(line);
        clearTimeout(timer);
        resolve(value);
      } catch {
        /* wait for a complete line */
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`runtime console exited ${code}: ${stdout}\n${stderr}`));
    });
  });
  assert.equal(announcement.operation, "runtime.console");
  return { child, announcement, stdout: () => stdout, stderr: () => stderr };
}

async function startConsoleHuman(cwd, env) {
  const child = spawn(tsx, [cliEntry, "runtime", "console"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runtime console timed out: ${stdout}\n${stderr}`)), 15_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("Press Ctrl-C to stop.")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`runtime console exited ${code}: ${stdout}\n${stderr}`));
    });
  });
  return { child, stdout: () => stdout };
}

async function stopConsole(console_) {
  if (console_.child.exitCode !== null) return;
  console_.child.kill("SIGTERM");
  let timeout;
  try {
    await Promise.race([
      once(console_.child, "close"),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Console did not stop")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

test(
  "#1070 certifies that the real CLI and the real browser console agree on canonical setup/runtime state",
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "inari-console-cert-"));
    const configHome = path.join(directory, "config");
    const workspace = path.join(directory, "workspace");
    let console_;
    try {
      await Promise.all([mkdir(configHome), mkdir(workspace)]);
      git(workspace, "init", "-q");
      git(workspace, "remote", "add", "origin", "https://github.com/acme/inari.git");
      git(workspace, "checkout", "-q", "-b", "main");

      const baseEnv = {
        ...process.env,
        INARI_CONFIG_HOME: configHome,
        GH_TOKEN: "console-must-not-render-this-token",
        GITHUB_TOKEN: "console-must-not-render-this-token",
      };
      delete baseEnv.INARI_GITHUB_APP_USER_CREDENTIAL_FILE;
      delete baseEnv.INARI_APP_USER_CREDENTIAL_FILE;
      delete baseEnv.INARI_RUNTIME_AUTHORITY_PRIVATE_KEY;

      // Before anything runs, the ordered setup path is not yet declared: the browser
      // console must show it is blocked on the same first step the CLI would report.
      console_ = await startConsole(workspace, baseEnv);
      const port = new URL(console_.announcement.endpoint).port;
      assert.equal(console_.announcement.sshForward, `-L ${port}:127.0.0.1:${port}`);

      let state = await (await fetch(`${console_.announcement.endpoint}/api/state`)).json();
      assert.equal(state.application.status, "incomplete");
      assert.equal(state.application.nextAction.stepId, "cli-topology");
      assert.equal(state.runtime.executor, "not-running");
      assert.equal(state.runtime.admission, "not-running");
      assert.equal(state.runtime.overall, "not-ready");

      // The browser performs its one bounded setup action — declaring the local CLI
      // topology — through the console, not through the CLI.
      const actionResponse = await fetch(`${console_.announcement.endpoint}/api/actions/cli-topology`, {
        method: "POST",
        headers: { accept: "application/json" },
      });
      assert.equal(actionResponse.status, 200);
      const actionState = await actionResponse.json();
      assert.equal(actionState.operation, "runtime.console.action");
      assert.equal(actionState.action, "cli-topology");
      assert.equal(actionState.application.steps.find((step) => step.id === "cli-topology").status, "ready");
      assert.equal(actionState.application.nextAction.stepId, "app-user-authorization");

      // A plain HTML form submission of the same action (no Accept: application/json)
      // is redirected back to the page — the same bounded service, browser-native flow.
      const formResponse = await fetch(`${console_.announcement.endpoint}/api/actions/cli-topology`, {
        method: "POST",
        redirect: "manual",
      });
      assert.equal(formResponse.status, 303);
      assert.equal(formResponse.headers.get("location"), "/");

      await stopConsole(console_);

      // The CLI, run only after the browser action, must see exactly the state the
      // browser produced: the same persisted config file, the same next action. This is
      // the proof that the browser action invoked the same bounded application service
      // the CLI uses, rather than a second, independent setup implementation.
      const afterBrowserAction = jsonOutput(
        command(["init", "--json"], { cwd: workspace, env: baseEnv }),
        "init after the browser's cli-topology action",
      );
      assert.equal(afterBrowserAction.applicationState.nextAction.stepId, "app-user-authorization");
      assert.deepEqual(afterBrowserAction.applicationState.nextAction, actionState.application.nextAction);
      assert.deepEqual(
        afterBrowserAction.applicationState.steps.map((step) => step.status),
        actionState.application.steps.map((step) => step.status),
      );
      assert.equal(afterBrowserAction.runtimeStatus.executor, "not-running");
      assert.equal(afterBrowserAction.runtimeStatus.admission, "not-running");
      assert.equal(afterBrowserAction.runtimeStatus.overall, "not-ready");

      // Restarting the console afterward must independently agree with the CLI on the
      // exact same next action and runtime readiness — the seam is one function read
      // live each time, not a cached or independently maintained projection.
      console_ = await startConsole(workspace, baseEnv);
      state = await (await fetch(`${console_.announcement.endpoint}/api/state`)).json();
      assert.equal(state.application.status, afterBrowserAction.applicationState.status);
      assert.equal(state.application.nextAction.stepId, afterBrowserAction.applicationState.nextAction.stepId);
      assert.deepEqual(state.application.nextAction.commands, afterBrowserAction.applicationState.nextAction.commands);
      assert.deepEqual(
        state.application.steps.map((step) => step.status),
        afterBrowserAction.applicationState.steps.map((step) => step.status),
      );
      assert.deepEqual(state.runtime, afterBrowserAction.runtimeStatus);

      const page = await (await fetch(`${console_.announcement.endpoint}/`)).text();
      assert.match(page, /app-user-authorization|Authorize the Inari GitHub App user/u);
      assert.match(page, /<dd>not-running<\/dd>/u);
      assert.ok(!page.includes("console-must-not-render-this-token"));
      // The cli-topology step is already complete, so its action form is no longer offered.
      assert.doesNotMatch(page, /action="\/api\/actions\/cli-topology"/u);

      assert.equal((await fetch(`${console_.announcement.endpoint}/`, { method: "POST" })).status, 405);
      assert.equal((await fetch(`${console_.announcement.endpoint}/unknown`)).status, 404);
      assert.equal((await fetch(`${console_.announcement.endpoint}/api/actions/cli-topology`)).status, 405);

      // The operator-facing (non-JSON) guidance must substitute the actual dynamically
      // allocated port into the ready-to-use SSH forward, so the operator never has to
      // discover or manage that internal port themselves.
      const human = await startConsoleHuman(workspace, baseEnv);
      try {
        const humanText = human.stdout();
        const humanPort = /Local setup\/runtime console: http:\/\/127\.0\.0\.1:(\d+)\//u.exec(humanText)?.[1];
        assert.ok(humanPort);
        assert.match(
          humanText,
          new RegExp(`ssh -L ${humanPort}:127\\.0\\.0\\.1:${humanPort} <user>@<remote-host>`, "u"),
        );
        assert.match(humanText, /Loopback-only/u);
      } finally {
        human.child.kill("SIGTERM");
        await once(human.child, "close");
      }
    } finally {
      if (console_ !== undefined) await stopConsole(console_);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
