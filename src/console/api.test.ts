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

test("confirmation tokens are bound to the observed generation for generic actions and enrollment", async () => {
  let effects = 0;
  let currentConfiguration = "cfg";
  const enrollmentAction = {
    id: "enroll",
    version: 1,
    inputs: [{ id: "issuer-key", kind: "enrollment", label: "Key", required: true }],
  };
  const application = {
    state: async () => ({
      generation: { ...generation, configuration: currentConfiguration },
      actions: [offered, enrollmentAction],
    }),
    perform: async (_repository: unknown, _request: unknown, options?: { enrollments?: Record<string, unknown> }) => {
      effects++;
      const upload = options?.enrollments?.["issuer-key"] as { stream: AsyncIterable<Uint8Array> } | undefined;
      if (upload) for await (const _ of upload.stream) void _;
      return { outcome: "succeeded" };
    },
  } as unknown as SetupApplication;
  const issued: string[] = [];
  const consumed: string[] = [];
  class RecordingSession extends OperatorSession {
    override confirm(actionId: string, bound: typeof generation, now?: number): string {
      issued.push(`${actionId}@${bound.configuration}`);
      return super.confirm(actionId, bound, now);
    }
    override consume(value: string | undefined, actionId: string, bound: typeof generation, now?: number): boolean {
      consumed.push(`${actionId}@${bound.configuration}`);
      return super.consume(value, actionId, bound, now);
    }
  }
  const session = new RecordingSession(repository, "cfg");
  const options = { application, repository, configuration: "cfg", session, origin: "http://127.0.0.1:19999" };
  const server = createSetupApiServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  options.origin = url;
  const base = {
    origin: url,
    authorization: `Bearer ${session.context.bearer}`,
    "x-csrf-token": session.context.csrf,
  };
  const post = (path: string, body: unknown) =>
    fetch(url + path, {
      method: "POST",
      headers: { ...base, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const enroll = (confirmation: string, actionId = "enroll") =>
    fetch(url + "/api/setup/enrollment/issuer-key", {
      method: "POST",
      headers: {
        ...base,
        "content-type": "application/octet-stream",
        "x-setup-action-id": actionId,
        "x-setup-confirmation": confirmation,
        "x-setup-request": encodeURIComponent(
          JSON.stringify({
            version: 1,
            actionId,
            generation: { ...generation, configuration: currentConfiguration },
            confirmed: true,
            inputs: {},
          }),
        ),
      },
      body: new Uint8Array([1, 2, 3]),
    });
  const confirm = async (actionId: string) =>
    ((await (await post("/api/setup/confirm", { actionId })).json()) as { confirmation: string }).confirmation;
  const action = { version: 1, actionId: "act", generation, confirmed: true, inputs: {} };
  try {
    // A token minted for an earlier generation fails before any owner effect, same action ID.
    const olderGeneration = { ...generation, configuration: "cfg-old" };
    assert.equal(
      (await post("/api/setup/actions", { confirmation: session.confirm("act", olderGeneration), request: action }))
        .status,
      409,
    );
    assert.equal((await enroll(session.confirm("enroll", olderGeneration))).status, 409);
    assert.equal(effects, 0);

    // The API captures the current generation at confirm and requires it at consumption.
    issued.length = 0;
    consumed.length = 0;
    assert.equal(
      (await post("/api/setup/actions", { confirmation: await confirm("act"), request: action })).status,
      200,
    );
    assert.equal((await enroll(await confirm("enroll"))).status, 200);
    assert.deepEqual(issued, ["act@cfg", "enroll@cfg"]);
    assert.deepEqual(consumed, ["act@cfg", "enroll@cfg"]);
    assert.equal(effects, 2);

    // A token confirmed before generation drift fails for both transports without effects.
    const staleAction = await confirm("act");
    const staleEnrollment = await confirm("enroll");
    currentConfiguration = "cfg-2";
    assert.equal(
      (
        await post("/api/setup/actions", {
          confirmation: staleAction,
          request: { ...action, generation: { ...generation, configuration: "cfg-2" } },
        })
      ).status,
      409,
    );
    assert.equal((await enroll(staleEnrollment)).status, 409);
    assert.equal(effects, 2);
  } finally {
    server.close();
  }
});

test("enrollment carries the declared secret-free inputs beside the opaque upload in one canonical action", async () => {
  const configure = {
    id: "executor.configure:1",
    version: 1,
    inputs: [
      { id: "app-id", kind: "text", label: "App ID", required: true },
      { id: "issuer-key", kind: "enrollment", label: "Key", required: true },
    ],
  };
  let currentConfiguration = "cfg";
  const calls: { request: unknown; enrollments: string[]; bytes: number[] }[] = [];
  const application = {
    state: async () => ({ generation: { ...generation, configuration: currentConfiguration }, actions: [configure] }),
    perform: async (
      _repository: unknown,
      request: unknown,
      options?: { enrollments?: Record<string, { stream: AsyncIterable<Uint8Array> }> },
    ) => {
      const bytes: number[] = [];
      for (const upload of Object.values(options?.enrollments ?? {})) {
        for await (const chunk of upload.stream) bytes.push(...chunk);
      }
      calls.push({ request, enrollments: Object.keys(options?.enrollments ?? {}), bytes });
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
  const base = { origin: url, authorization: `Bearer ${session.context.bearer}`, "x-csrf-token": session.context.csrf };
  const confirm = async () =>
    (
      (await (
        await fetch(url + "/api/setup/confirm", {
          method: "POST",
          headers: { ...base, "content-type": "application/json" },
          body: JSON.stringify({ actionId: configure.id }),
        })
      ).json()) as { confirmation: string }
    ).confirmation;
  const pem = new TextEncoder().encode("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n");
  const typed = (patch: Record<string, unknown> = {}) => ({
    version: 1,
    actionId: configure.id,
    generation,
    confirmed: true,
    inputs: { "app-id": "12345" },
    ...patch,
  });
  const enroll = async (request: unknown, confirmation: string, extra: Record<string, string> = {}) =>
    (
      await fetch(url + "/api/setup/enrollment/issuer-key", {
        method: "POST",
        headers: {
          ...base,
          "content-type": "application/octet-stream",
          "x-setup-action-id": configure.id,
          "x-setup-confirmation": confirmation,
          "x-setup-request": encodeURIComponent(JSON.stringify(request)),
          ...extra,
        },
        body: pem,
      })
    ).status;
  try {
    // Rejected before any owner effect: unknown input, enrollment value in JSON,
    // secret material in JSON, stale generation, action mismatch, unconfirmed, missing request.
    assert.equal(await enroll(typed({ inputs: { "app-id": "1", other: "x" } }), await confirm()), 400);
    assert.equal(await enroll(typed({ inputs: { "issuer-key": "x" } }), await confirm()), 400);
    assert.equal(
      await enroll(typed({ inputs: { "app-id": "-----BEGIN PRIVATE KEY-----\nAAAA" } }), await confirm()),
      400,
    );
    assert.equal(await enroll(typed({ generation: { ...generation, configuration: "old" } }), await confirm()), 409);
    assert.equal(await enroll(typed({ actionId: "other" }), await confirm()), 409);
    assert.equal(await enroll(typed({ confirmed: false }), await confirm()), 409);
    assert.equal(await enroll(typed(), await confirm(), { "x-setup-request": "%7Bnot-json" }), 400);
    assert.equal(await enroll(typed(), await confirm(), { "x-setup-request": "x".repeat(12 * 1024 + 1) }), 400);
    // A confirmation bound to an earlier generation is refused with the same action ID.
    assert.equal(await enroll(typed(), session.confirm(configure.id, { ...generation, configuration: "old" })), 409);
    assert.equal(calls.length, 0);

    // app-id + PEM: exactly one canonical action with typed inputs and the opaque upload.
    const confirmation = await confirm();
    assert.equal(await enroll(typed(), confirmation), 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.request, typed());
    assert.deepEqual(calls[0]!.enrollments, ["issuer-key"]);
    assert.deepEqual(Buffer.from(calls[0]!.bytes), Buffer.from(pem));
    assert.doesNotMatch(JSON.stringify(calls[0]!.request), /BEGIN/u);
    // Single use.
    assert.equal(await enroll(typed(), confirmation), 409);

    // A generation change after confirmation fails before any owner effect.
    const stale = await confirm();
    currentConfiguration = "cfg-2";
    assert.equal(await enroll(typed({ generation: { ...generation, configuration: "cfg-2" } }), stale), 409);
    assert.equal(calls.length, 1);
  } finally {
    server.close();
  }
});
