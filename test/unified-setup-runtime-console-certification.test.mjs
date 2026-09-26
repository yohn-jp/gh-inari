// #1065: `inari init`, `inari setup status`, `inari setup console` and
// `inari runtime console` all render the one canonical Setup Application over
// the same persisted owner evidence. `runtime console` is the canonical
// loopback setup/control host, not a second setup projector. Run with
// `--import tsx` (as `pnpm test` does) so every module shares one instance.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCli } from "../src/cli.ts";

const REPOSITORY = ["--repository", "acme/inari", "--repository-id", "4242000"];

async function capture(argv, environment, dependencies = {}) {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const exitCode = await runCli(argv, { environment, ...dependencies });
    return { exitCode, stdout: lines.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function bootstrap(endpoint) {
  const response = await fetch(`${endpoint}/api/setup/bootstrap`, {
    method: "POST",
    headers: { origin: endpoint, "x-inari-setup-bootstrap": "1", "sec-fetch-site": "same-origin" },
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("#1065 certifies that init, setup status and the runtime console share one canonical setup state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inari-console-cert-"));
  const configHome = path.join(directory, "config");
  const workspace = path.join(directory, "workspace");
  const assets = path.join(directory, "assets");
  let handle;
  try {
    await Promise.all([mkdir(configHome), mkdir(workspace), mkdir(assets)]);
    for (const file of ["index.html", "setup-console.js", "styles.css"]) await writeFile(path.join(assets, file), file);
    const environment = {
      INARI_CONFIG_HOME: configHome,
      GH_TOKEN: "console-must-not-render-this-token",
      GITHUB_TOKEN: "console-must-not-render-this-token",
    };
    const dependencies = { repositoryRoot: workspace, setupAssetDirectory: assets };

    const init = await capture(["init", "--json", ...REPOSITORY], environment, dependencies);
    assert.equal(init.exitCode, 0, init.stdout);
    const initState = JSON.parse(init.stdout).setup;
    assert.equal(initState.stage, "clean");

    const started = await capture(["runtime", "console", "--json", ...REPOSITORY], environment, {
      ...dependencies,
      onSetupHostStarted: (value) => (handle = value),
    });
    assert.equal(started.exitCode, 0, started.stdout);
    const console_ = JSON.parse(started.stdout);
    assert.equal(console_.operation, "runtime.console");
    assert.equal(console_.reused, false);
    const port = new URL(console_.endpoint).port;
    assert.equal(console_.sshForward, `-L ${port}:127.0.0.1:${port}`);
    assert.ok(handle);

    // The browser API renders the same generation, stage and next action the CLI does.
    const session = await bootstrap(console_.endpoint);
    const browserState = await (
      await fetch(`${console_.endpoint}/api/setup/state`, {
        headers: { authorization: `Bearer ${session.bearer}`, "x-csrf-token": session.csrf },
      })
    ).json();
    assert.deepEqual(browserState.generation, initState.generation);
    assert.equal(browserState.stage, initState.stage);
    assert.deepEqual(browserState.nextAction.kind, initState.nextAction.kind);
    assert.deepEqual(
      browserState.actions.map((action) => action.kind),
      initState.actions.map((action) => action.kind),
    );
    const status = await capture(["setup", "status", "--json", ...REPOSITORY], environment, dependencies);
    assert.deepEqual(JSON.parse(status.stdout).state.generation, browserState.generation);

    // `setup console` and `runtime console` are the same host: reused, never duplicated.
    const reused = await capture(["setup", "console", "--json", ...REPOSITORY], environment, {
      ...dependencies,
      onSetupHostStarted: () => assert.fail("a second host must not start"),
    });
    assert.equal(JSON.parse(reused.stdout).reused, true);
    assert.equal(JSON.parse(reused.stdout).endpoint, console_.endpoint);

    const page = await (await fetch(`${console_.endpoint}/`)).text();
    assert.equal(page.includes("console-must-not-render-this-token"), false);
    assert.equal(JSON.stringify(browserState).includes("console-must-not-render-this-token"), false);
    await handle.close();
    handle = undefined;

    // Operator-facing guidance substitutes the dynamically allocated port into the SSH forward.
    const human = await capture(["runtime", "console", ...REPOSITORY], environment, {
      ...dependencies,
      onSetupHostStarted: (value) => (handle = value),
    });
    const humanPort = /Local setup console: http:\/\/127\.0\.0\.1:(\d+)\//u.exec(human.stdout)?.[1];
    assert.ok(humanPort, human.stdout);
    assert.match(
      human.stdout,
      new RegExp(`ssh -L ${humanPort}:127\\.0\\.0\\.1:${humanPort} <user>@<remote-host>`, "u"),
    );
    assert.match(human.stdout, /Loopback-only/u);
  } finally {
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
