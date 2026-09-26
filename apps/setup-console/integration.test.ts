// Wizard controller + typed client against the real #1118 loopback API and
// the real setup application with in-memory owner ports. Producer proof only;
// installed real-browser certification belongs to #1122.
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createSetupApplication, type SetupApplication } from "../../src/application/setup/actions.js";
import { createSetupApiServer } from "../../src/console/api.js";
import { OperatorSession } from "../../src/console/operator-session.js";
import type { SetupActionRequest, SetupJournalEntry } from "../../src/runtime-contracts/setup.js";
import { createSetupApiClient } from "./src/api-client.js";
import { createSetupOperatorContext } from "./src/bootstrap.js";
import { createSetupController } from "./src/controller.js";
import { NOW, repository, settle } from "./test-fixtures.js";

const OBSERVED = "2026-09-24T00:04:00.000Z";

function observation(configuration: string, overrides: Record<string, string>) {
  const statuses: Record<string, [string, string, string]> = {
    configuration: ["configuration", overrides.configuration ?? "configured", "composition"],
    health: ["health", overrides.health ?? "healthy", "composition"],
    providerBinding: ["provider-binding", "bound", "executor"],
    repositoryTrust: ["repository-trust", "trusted", "authority"],
    sessionReadiness: ["session-readiness", "ready", "admission"],
  };
  const out: Record<string, unknown> = { version: 1, generation: { repository, configuration }, observedAt: OBSERVED };
  for (const [member, [dimension, status, owner]] of Object.entries(statuses)) {
    out[member] = {
      dimension,
      status,
      evidence: { owner, observedAt: OBSERVED, generation: configuration },
      diagnostics: [],
    };
  }
  return out;
}

async function harness(overrides: Record<string, string>) {
  let current = observation("gen-1", overrides);
  const performed: SetupActionRequest[] = [];
  const journal: SetupJournalEntry[] = [];
  const enrolledBytes: string[] = [];
  const applicationCalls: { request: unknown; enrollments: string[] }[] = [];
  const canonical = createSetupApplication({
    observation: { observe: async () => current as never },
    journal: { append: async (entry) => void journal.push(entry), read: async () => journal },
    action: {
      perform: async (request) => {
        performed.push(request);
        return {
          version: 1,
          actionId: request.actionId,
          generation: request.generation,
          outcome: "succeeded",
          diagnostics: [],
        };
      },
    },
    enrollment: [
      {
        owner: "executor",
        kinds: ["executor-issuer-private-key"],
        enroll: async (request, secret) => {
          const chunks: Uint8Array[] = [];
          for await (const chunk of secret) chunks.push(chunk);
          enrolledBytes.push(Buffer.concat(chunks).toString("utf8"));
          return {
            version: 1,
            kind: request.kind,
            operationId: request.operationId,
            repository: request.repository,
            outcome: "enrolled",
            publicFingerprint: `sha256:${"a".repeat(64)}`,
            diagnostics: [],
          };
        },
      },
    ],
    now: () => NOW,
  });
  // Records each canonical application invocation made by the real API.
  const application: SetupApplication = {
    state: (repositoryIdentity) => canonical.state(repositoryIdentity),
    perform: (repositoryIdentity, request, performOptions) => {
      applicationCalls.push({ request, enrollments: Object.keys(performOptions?.enrollments ?? {}) });
      return canonical.perform(repositoryIdentity, request, performOptions);
    },
  };
  const session = new OperatorSession(repository, "gen-1");
  const options = { application, repository, configuration: "gen-1", session, origin: "http://127.0.0.1:1" };
  const server = createSetupApiServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  options.origin = origin;
  let afterConfirm: (() => void) | undefined;
  // Browsers attach Origin to same-origin POSTs; Node's fetch does not, so the harness does.
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const { mode: _mode, ...rest } = init;
    const response = await fetch(url, { ...rest, headers: { ...(init.headers as Record<string, string>), origin } });
    if (url.endsWith("/api/setup/confirm")) afterConfirm?.();
    return response;
  }) as unknown as typeof fetch;
  const context = createSetupOperatorContext({
    apiOrigin: origin,
    bearer: session.context.bearer,
    csrf: session.context.csrf,
    receivingMachine: "runtime-host",
  });
  const controller = createSetupController({
    transport: createSetupApiClient(context, fetchImpl),
    scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
    isHidden: () => false,
  });
  return {
    controller,
    performed,
    journal,
    enrolledBytes,
    applicationCalls,
    drift: (configuration: string) => (current = observation(configuration, overrides)),
    setAfterConfirm: (hook: (() => void) | undefined) => (afterConfirm = hook),
    close: () => server.close(),
  };
}

test("a canonical action runs end to end: fresh state, confirmation, typed request, reread", async () => {
  const h = await harness({ health: "not-running" });
  try {
    await h.controller.start();
    const action = h.controller.snapshot().state!.actions[0]!;
    assert.equal(action.kind, "composition.start-runtime");
    await h.controller.submit(action.id);
    assert.equal(h.controller.snapshot().lastResult?.outcome, "succeeded");
    assert.equal(h.performed.length, 1);
    assert.equal(h.performed[0]!.actionId, action.id);
    assert.equal(h.performed[0]!.generation.configuration, "gen-1");
    assert.deepEqual(
      h.journal.map((entry) => entry.phase),
      ["requested", "confirmed", "completed"],
    );
  } finally {
    h.close();
  }
});

test("generation drift after confirmation reaches no owner effect through the real API", async () => {
  const h = await harness({ health: "not-running" });
  try {
    await h.controller.start();
    const action = h.controller.snapshot().state!.actions[0]!;
    h.setAfterConfirm(() => h.drift("gen-2"));
    await h.controller.submit(action.id);
    // The operator session is bound to gen-1, so the reread also reports the drift.
    assert.equal(h.controller.snapshot().notice?.code, "session-stale");
    assert.equal(h.controller.snapshot().phase, "unavailable");
    assert.equal(h.performed.length, 0);
    assert.equal(h.journal.length, 0);
  } finally {
    h.close();
  }
});

test("app-id + PEM complete executor.configure as exactly one canonical action through the real API", async () => {
  const h = await harness({ configuration: "unconfigured" });
  try {
    await h.controller.start();
    const action = h.controller.snapshot().state!.actions[0]!;
    assert.equal(action.kind, "executor.configure");
    h.controller.setAcknowledged(action.id, true);
    h.controller.setDraft(action.id, "app-id", "12345");
    const pem = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
    h.controller.selectEnrollment(action.id, "issuer-key", new Blob([pem]));
    await h.controller.submit(action.id);
    await settle();
    assert.equal(h.controller.snapshot().lastResult?.outcome, "succeeded");
    assert.equal(h.applicationCalls.length, 1, "exactly one canonical application invocation");
    assert.deepEqual(h.applicationCalls[0], {
      request: {
        version: 1,
        actionId: action.id,
        generation: action.freshness.generation,
        confirmed: true,
        inputs: { "app-id": "12345" },
      },
      enrollments: ["issuer-key"],
    });
    assert.deepEqual(h.enrolledBytes, [pem], "the owner enrollment port received the opaque upload once");
    assert.equal(h.performed.length, 1, "the owner action port ran once");
    assert.deepEqual(h.performed[0]!.inputs, { "app-id": "12345" });
    assert.doesNotMatch(JSON.stringify(h.performed[0]), /BEGIN/u);
    assert.doesNotMatch(JSON.stringify(h.journal), /BEGIN/u);
    assert.deepEqual(h.controller.snapshot().enrollments, {}, "the File reference is dropped");
    assert.doesNotMatch(JSON.stringify(h.controller.snapshot()), /BEGIN/u);
  } finally {
    h.close();
  }
});

test("a missing required app-id fails before any owner effect", async () => {
  const h = await harness({ configuration: "unconfigured" });
  try {
    await h.controller.start();
    const action = h.controller.snapshot().state!.actions[0]!;
    h.controller.setAcknowledged(action.id, true);
    h.controller.selectEnrollment(action.id, "issuer-key", new Blob(["-----BEGIN PRIVATE KEY-----\n"]));
    await h.controller.submit(action.id);
    await settle();
    const result = h.controller.snapshot().lastResult;
    assert.equal(result?.outcome, "action-required");
    assert.equal(result?.diagnostics[0]?.code, "SETUP_INPUT_MISSING");
    assert.deepEqual(h.enrolledBytes, []);
    assert.equal(h.performed.length, 0);
    assert.equal(h.journal.length, 0);
    assert.deepEqual(h.controller.snapshot().enrollments, {}, "the File reference is dropped");
  } finally {
    h.close();
  }
});
