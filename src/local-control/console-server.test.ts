import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { localRuntimeDiscoveryPath } from "./runtime-discovery.js";
import { startLocalConsole } from "./console-server.js";

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
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      const html = await page.text();
      assert.match(html, /Ordered setup path/u);
      assert.match(html, /inari init/u);
      assert.match(html, /Runtime readiness/u);
      assert.match(html, /<dd>not-running<\/dd>/gu);
      assert.doesNotMatch(html, /BEGIN PRIVATE KEY/u);

      const state = await fetch(`${announcement.endpoint}/api/state`);
      assert.equal(state.status, 200);
      assert.match(state.headers.get("content-type") ?? "", /application\/json/iu);
      const body = await state.json();
      assert.equal(body.ok, true);
      assert.equal(body.operation, "runtime.console.state");
      assert.equal(body.application.status, "incomplete");
      assert.equal(body.application.nextAction.stepId, "cli-topology");
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
