import { strict as assert } from "node:assert";
import { test } from "node:test";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createSetupApiServer } from "./api.js";
import { OperatorSession } from "./operator-session.js";
import type { SetupApplication } from "../application/setup/actions.js";

const repository = { repositoryHost: "github.com", repositoryId: "1", nameWithOwner: "a/b" };
const generation = { repository, configuration: "cfg" };
const offered = { id: "act", version: 1, inputs: [] };
test("actual loopback HTTP rejects foreign origin, Host, CSRF and replay before effects", async () => {
  let effects = 0;
  let currentConfiguration = "cfg";
  const application = {
    state: async () => ({ generation: { ...generation, configuration: currentConfiguration }, actions: [offered] }),
    perform: async () => {
      effects++;
      return { outcome: "succeeded" };
    },
  } as unknown as SetupApplication;
  const session = new OperatorSession(repository, "cfg");
  const options = { application, repository, configuration: "cfg", session, origin: "http://127.0.0.1:19999" };
  const server = createSetupApiServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  options.origin = url;
  const headers = {
    host: `127.0.0.1:${address.port}`,
    origin: url,
    authorization: `Bearer ${session.context.bearer}`,
    "x-csrf-token": session.context.csrf,
    "content-type": "application/json",
  };
  const call = (path: string, extra = {}, body?: unknown) =>
    fetch(url + path, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await call("/api/setup/confirm", { origin: "http://evil.test" }, { actionId: "act" })).status, 403);
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        url + "/api/setup/confirm",
        { method: "POST", headers: { ...headers, host: "evil.test" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ actionId: "act" }));
    });
    assert.equal(wrongHost, 403);
    assert.equal((await call("/api/setup/confirm", { "x-csrf-token": "bad" }, { actionId: "act" })).status, 403);
    const confirmed = await call("/api/setup/confirm", {}, { actionId: "act" });
    assert.equal(confirmed.status, 200);
    const { confirmation } = (await confirmed.json()) as { confirmation: string };
    const action = { version: 1, actionId: "act", generation, confirmed: true, inputs: {} };
    assert.equal((await call("/api/setup/actions", {}, { confirmation, request: action })).status, 200);
    assert.equal((await call("/api/setup/actions", {}, { confirmation, request: action })).status, 409);
    currentConfiguration = "changed";
    assert.equal((await call("/api/setup/confirm", {}, { actionId: "act" })).status, 409);
    assert.equal(effects, 1);
  } finally {
    server.close();
  }
});
