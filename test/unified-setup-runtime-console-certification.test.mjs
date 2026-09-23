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

      // Before `init`, the ordered setup path is not yet declared: both projections must agree
      // it is blocked on the same first step.
      console_ = await startConsole(workspace, baseEnv);
      let state = await (await fetch(`${console_.announcement.endpoint}/api/state`)).json();
      assert.equal(state.application.nextAction.stepId, "cli-topology");
      await stopConsole(console_);

      const initial = jsonOutput(command(["init", "--json"], { cwd: workspace, env: baseEnv }), "init");
      assert.equal(initial.applicationState.status, "incomplete");
      assert.equal(initial.applicationState.nextAction.stepId, "app-user-authorization");
      assert.equal(initial.runtimeStatus.executor, "not-running");
      assert.equal(initial.runtimeStatus.admission, "not-running");
      assert.equal(initial.runtimeStatus.overall, "not-ready");

      // After `init` declares the local CLI topology, the CLI and the browser console must
      // agree on the exact same next action and runtime readiness — the seam is one function,
      // not two independently maintained projections.
      console_ = await startConsole(workspace, baseEnv);
      const port = new URL(console_.announcement.endpoint).port;
      assert.equal(console_.announcement.sshForward, `-L ${port}:127.0.0.1:${port}`);

      state = await (await fetch(`${console_.announcement.endpoint}/api/state`)).json();
      assert.equal(state.application.status, initial.applicationState.status);
      assert.equal(state.application.nextAction.stepId, initial.applicationState.nextAction.stepId);
      assert.deepEqual(state.application.nextAction.commands, initial.applicationState.nextAction.commands);
      assert.deepEqual(
        state.application.steps.map((step) => step.status),
        initial.applicationState.steps.map((step) => step.status),
      );
      assert.deepEqual(state.runtime, initial.runtimeStatus);

      const page = await (await fetch(`${console_.announcement.endpoint}/`)).text();
      assert.match(page, /app-user-authorization|Authorize the Inari GitHub App user/u);
      assert.match(page, /<dd>not-running<\/dd>/u);
      assert.ok(!page.includes("console-must-not-render-this-token"));

      assert.equal((await fetch(`${console_.announcement.endpoint}/`, { method: "POST" })).status, 405);
      assert.equal((await fetch(`${console_.announcement.endpoint}/unknown`)).status, 404);

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
