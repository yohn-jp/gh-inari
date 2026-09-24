import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { localComponentPath } from "./config.js";
import { localRuntimeDiscoveryPath } from "./runtime-discovery.js";
import { LOCAL_CONSOLE_CLI_TOPOLOGY_ACTION_PATH, startLocalConsole } from "./console-server.js";

interface ConsoleStateBody {
  readonly application: { readonly steps: readonly { readonly id: string; readonly status: string }[] };
}

async function temporaryEnvironment(): Promise<{ readonly root: string; readonly environment: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-local-console-"));
  return { root, environment: { INARI_CONFIG_HOME: path.join(root, "config") } };
}

test("the local console serves the canonical setup/runtime state as loopback-only, secret-free HTML and JSON", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const { server, announcement } = await startLocalConsole(root, environment);
    try {
      assert.equal(announcement.component, "console");
      assert.match(announcement.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/u);
      assert.deepEqual(
        JSON.parse(await readFile(localRuntimeDiscoveryPath("console", environment), "utf8")),
        announcement,
      );

      const page = await fetch(`${announcement.endpoint}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") ?? "", /text\/html/iu);
      assert.equal(
        page.headers.get("content-security-policy"),
        "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
      const html = await page.text();
      assert.match(html, /Ordered setup path/u);
      assert.match(html, /inari init/u);
      assert.match(html, /Runtime readiness/u);
      assert.match(html, /<dd>not-running<\/dd>/gu);
      assert.doesNotMatch(html, /BEGIN PRIVATE KEY/u);
      assert.match(html, new RegExp(`<form method="post" action="${LOCAL_CONSOLE_CLI_TOPOLOGY_ACTION_PATH}">`, "u"));
      // #1065: Session start is never projected as already executable before
      // setup completes and a canonical Issue-bound Change branch is selected.
      assert.match(html, /Issue \/ Change branch/u);
      assert.match(html, /issue-not-selected/u);
      assert.match(html, /Session start is not yet available/u);
      assert.doesNotMatch(html, /inari session start --issue \d/u);

      const state = await fetch(`${announcement.endpoint}/api/state`);
      assert.equal(state.status, 200);
      assert.match(state.headers.get("content-type") ?? "", /application\/json/iu);
      const body = await state.json();
      assert.equal(body.ok, true);
      assert.equal(body.operation, "runtime.console.state");
      assert.equal(body.application.status, "incomplete");
      assert.equal(body.application.nextAction.stepId, "cli-topology");
      assert.equal(body.application.changeBranch.status, "issue-not-selected");
      assert.equal(body.runtime.executor, "not-running");
      assert.equal(body.runtime.admission, "not-running");
      assert.equal(body.runtime.overall, "not-ready");

      assert.equal((await fetch(`${announcement.endpoint}/`, { method: "POST" })).status, 405);
      assert.equal((await fetch(`${announcement.endpoint}/unknown`)).status, 404);
    } finally {
      server.close();
      await once(server, "close");
    }
    await assert.rejects(readFile(localRuntimeDiscoveryPath("console", environment), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the local console's cli-topology action invokes the same bounded service `inari init` uses", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const { server, announcement } = await startLocalConsole(root, environment);
    try {
      const actionUrl = `${announcement.endpoint}${LOCAL_CONSOLE_CLI_TOPOLOGY_ACTION_PATH}`;
      assert.equal((await fetch(actionUrl)).status, 405);

      const configPath = localComponentPath("cli", "config.json", environment);
      await assert.rejects(readFile(configPath, "utf8"));

      const jsonResponse = await fetch(actionUrl, { method: "POST", headers: { accept: "application/json" } });
      assert.equal(jsonResponse.status, 200);
      const jsonBody = (await jsonResponse.json()) as ConsoleStateBody & {
        readonly ok: boolean;
        readonly operation: string;
        readonly action: string;
      };
      assert.equal(jsonBody.ok, true);
      assert.equal(jsonBody.operation, "runtime.console.action");
      assert.equal(jsonBody.action, "cli-topology");
      assert.equal(jsonBody.application.steps.find((step) => step.id === "cli-topology")?.status, "ready");

      // The action wrote through the exact same persisted config file `inari init` writes.
      const written = JSON.parse(await readFile(configPath, "utf8"));
      assert.deepEqual(written, { version: 1, topology: { admission: "local", executor: "local" } });

      // A plain HTML form submission (no Accept: application/json) gets a redirect back to the page.
      const redirectResponse = await fetch(actionUrl, { method: "POST", redirect: "manual" });
      assert.equal(redirectResponse.status, 303);
      assert.equal(redirectResponse.headers.get("location"), "/");

      const state = (await (await fetch(`${announcement.endpoint}/api/state`)).json()) as ConsoleStateBody;
      assert.equal(state.application.steps.find((step) => step.id === "cli-topology")?.status, "ready");
    } finally {
      server.close();
      await once(server, "close");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
