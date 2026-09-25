// Wizard controller + typed client against the real #1118 loopback API and
// the real setup application with in-memory owner ports. Producer proof only;
// installed real-browser certification belongs to #1122.
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createSetupApplication } from "../../src/application/setup/actions.js";
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
  let enrolled = 0;
  const application = createSetupApplication({
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
        enroll: async () => {
          enrolled += 1;
          throw new Error("not reached in these tests");
        },
      },
    ],
    now: () => NOW,
  });
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
    enrolled: () => enrolled,
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

test("enrollment streams only the declared enrollment input; the owner decides the outcome", async () => {
  const h = await harness({ configuration: "unconfigured" });
  try {
    await h.controller.start();
    const action = h.controller.snapshot().state!.actions[0]!;
    assert.equal(action.kind, "executor.configure");
    h.controller.setAcknowledged(action.id, true);
    h.controller.setDraft(action.id, "app-id", "12345");
    h.controller.selectEnrollment(action.id, "issuer-key", new Blob(["-----BEGIN PRIVATE KEY-----\n"]));
    await h.controller.submit(action.id);
    await settle();
    // The #1118 enrollment route performs with no non-secret inputs, so the
    // canonical application reports the required text input as missing before
    // any owner effect. The wizard shows that server result verbatim.
    const result = h.controller.snapshot().lastResult;
    assert.equal(result?.outcome, "action-required");
    assert.equal(result?.diagnostics[0]?.code, "SETUP_INPUT_MISSING");
    assert.equal(h.enrolled(), 0);
    assert.equal(h.performed.length, 0);
    assert.deepEqual(h.controller.snapshot().enrollments, {}, "the File reference is dropped");
    assert.doesNotMatch(JSON.stringify(h.controller.snapshot()), /BEGIN/u);
  } finally {
    h.close();
  }
});
