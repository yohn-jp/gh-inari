// Frontend producer proofs over canonical fixtures. These are not installed
// real-browser certification (#1122 owns that).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SETUP_INPUT_KINDS, validateSetupAction } from "../../src/runtime-contracts/setup.js";
import { createSetupController, enrollmentKey, requestInputs, type SetupController } from "./src/controller.js";
import {
  ACTION_FIXTURES,
  CANONICAL_ACTION_KINDS,
  FakeSetupServer,
  ManualScheduler,
  OpaqueSecretBlob,
  canonicalState,
  inProgressState,
  settle,
} from "./test-fixtures.js";

function setup(server: FakeSetupServer, hidden = { value: false }, maxPolls = 3) {
  const scheduler = new ManualScheduler();
  let changes = 0;
  const controller = createSetupController({
    transport: server,
    scheduler,
    isHidden: () => hidden.value,
    onChange: () => void changes++,
    pollIntervalMs: 1000,
    maxPolls,
  });
  return { controller, scheduler, hidden, changes: () => changes };
}

function actionOf(controller: SetupController, kind: string) {
  const action = controller.snapshot().state?.actions.find((item) => item.kind === kind);
  assert.ok(action, `${kind} is offered`);
  return action;
}

test("every canonical action has a control path with a typed invocation after fresh state and confirmation", async () => {
  assert.deepEqual(Object.keys(ACTION_FIXTURES).sort(), [...CANONICAL_ACTION_KINDS].sort());
  for (const [kind, statuses] of Object.entries(ACTION_FIXTURES)) {
    const server = new FakeSetupServer(canonicalState(statuses));
    const { controller } = setup(server);
    await controller.start();
    const action = actionOf(controller, kind);
    assert.equal(controller.snapshot().state?.actions.length, 1, `${kind} fixture offers one action`);
    if (action.confirmation.required) controller.setAcknowledged(action.id, true);
    const enrollment = action.inputs.find((input) => input.kind === "enrollment");
    for (const input of action.inputs) {
      if (input.kind === "text") controller.setDraft(action.id, input.id, " 12345 ");
    }
    if (enrollment) controller.selectEnrollment(action.id, enrollment.id, new OpaqueSecretBlob());
    server.calls.length = 0;
    await controller.submit(action.id);
    const kinds = server.calls.map((call) => call.kind);
    assert.deepEqual(kinds, ["state", "confirm", enrollment ? "enroll" : "perform", "state"], kind);
    const confirm = server.calls[1]!;
    assert.equal(confirm.actionId, action.id);
    const invoke = server.calls[2]!;
    assert.equal(invoke.confirmation, "confirmation-1");
    if (enrollment) {
      // Per the #1119 contract the enrollment transport carries only the declared
      // enrollment input; no JSON request (and so no text input) accompanies it.
      assert.equal(invoke.inputId, enrollment.id);
      assert.equal(invoke.actionId, action.id);
      assert.ok(invoke.body instanceof OpaqueSecretBlob);
      assert.equal(invoke.request, undefined, "enrollment carries no JSON action request");
    } else {
      const inputs = Object.fromEntries(action.inputs.filter((i) => i.kind === "text").map((i) => [i.id, "12345"]));
      assert.deepEqual(invoke.request, {
        version: action.version,
        actionId: action.id,
        generation: server.current.generation,
        confirmed: true,
        inputs,
      });
    }
    assert.equal(server.effects, 1, kind);
    assert.equal(controller.snapshot().lastResult?.outcome, "succeeded");
    assert.equal(controller.snapshot().working, undefined);
    assert.equal(controller.snapshot().acknowledged[action.id], false, "acknowledgement covers one submission");
  }
});

test("every input kind maps to a typed value; enrollment and undeclared values never enter the JSON request", () => {
  const generation = canonicalState().generation;
  const action = validateSetupAction({
    version: 1,
    id: "composition.example:0000000000000000",
    kind: "composition.example",
    owner: "composition",
    title: "Example",
    prerequisites: [],
    inputs: [
      { id: "name", kind: "text", label: "Name", required: true },
      { id: "mode", kind: "choice", label: "Mode", required: true, choices: ["adopt", "prepare"] },
      { id: "agree", kind: "confirmation", label: "Agree", required: true },
      { id: "key", kind: "enrollment", label: "Key", required: false, enrollment: "executor-issuer-private-key" },
    ],
    confirmation: { required: false, summary: "Example." },
    freshness: { generation, notAfter: "2026-09-24T00:10:00.000Z" },
  });
  assert.deepEqual([...new Set(action.inputs.map((input) => input.kind))].sort(), [...SETUP_INPUT_KINDS].sort());
  assert.deepEqual(requestInputs(action, { name: "  x ", mode: "adopt", agree: true, key: "secret", other: "y" }), {
    name: "x",
    mode: "adopt",
    agree: true,
  });
  assert.deepEqual(requestInputs(action, { name: "   ", mode: "", agree: false }), {});
});

test("a confirmation issued before a generation change fails before any owner effect and is never reused", async () => {
  const server = new FakeSetupServer(canonicalState({ health: "not-running" }, "gen-1"));
  const { controller } = setup(server);
  await controller.start();
  const action = actionOf(controller, "composition.start-runtime");
  // The generation drifts after the confirmation was issued; the action kind is unchanged.
  server.afterConfirm = () => {
    server.current = canonicalState({ health: "not-running" }, "gen-2");
    server.afterConfirm = undefined;
  };
  await controller.submit(action.id);
  assert.equal(server.effects, 0);
  assert.equal(controller.snapshot().notice?.code, "api-stale");
  assert.equal(server.calls.filter((call) => call.kind === "perform").length, 1, "no automatic retry");
  assert.equal(controller.snapshot().state?.generation.configuration, "gen-2", "state was re-read");

  // Same stale confirmation cannot be replayed even with the old action ID (bound to gen-1).
  await assert.rejects(
    server.perform("confirmation-1", {
      version: 1,
      actionId: action.id,
      generation: server.current.generation,
      confirmed: true,
      inputs: {},
    }),
  );

  // A new submission uses the fresh action ID and a new confirmation for gen-2.
  const fresh = actionOf(controller, "composition.start-runtime");
  assert.notEqual(fresh.id, action.id);
  await controller.submit(fresh.id);
  const confirms = server.calls.filter((call) => call.kind === "confirm").map((call) => call.actionId);
  assert.deepEqual(confirms, [action.id, fresh.id]);
  assert.equal(server.effects, 1);
});

test("a submission against an action the fresh state no longer offers never requests confirmation", async () => {
  const server = new FakeSetupServer(canonicalState({ health: "not-running" }));
  const { controller } = setup(server);
  await controller.start();
  const action = actionOf(controller, "composition.start-runtime");
  server.current = canonicalState({ health: "not-running" }, "gen-2");
  await controller.submit(action.id);
  assert.deepEqual(
    server.calls.slice(1).map((call) => call.kind),
    ["state", "state"],
  );
  assert.equal(controller.snapshot().notice?.code, "action-not-offered");
  assert.equal(server.effects, 0);
});

test("required confirmation must be acknowledged; nothing is sent until then", async () => {
  const server = new FakeSetupServer(canonicalState({ health: "unhealthy" }));
  const { controller } = setup(server);
  await controller.start();
  const action = actionOf(controller, "composition.restart-runtime");
  assert.equal(action.confirmation.required, true);
  server.calls.length = 0;
  await controller.submit(action.id);
  assert.deepEqual(server.calls, []);
  assert.equal(controller.snapshot().notice?.code, "confirmation-required");
});

test("enrollment keeps only an in-memory reference and clears it on success, failure, error and cancel", async () => {
  for (const behavior of ["succeed", "fail", "throw"] as const) {
    const server = new FakeSetupServer(canonicalState({ configuration: "unconfigured" }));
    server.enrollBehavior = behavior;
    const { controller } = setup(server);
    await controller.start();
    const action = actionOf(controller, "executor.configure");
    controller.setAcknowledged(action.id, true);
    controller.selectEnrollment(action.id, "issuer-key", new OpaqueSecretBlob(40));
    assert.deepEqual(controller.snapshot().enrollments, { [enrollmentKey(action.id, "issuer-key")]: { bytes: 40 } });
    assert.doesNotMatch(JSON.stringify(controller.snapshot()), /BEGIN/u);
    await controller.submit(action.id);
    assert.deepEqual(controller.snapshot().enrollments, {}, behavior);
    if (behavior === "fail") assert.equal(controller.snapshot().lastResult?.outcome, "failed");
    if (behavior === "throw") assert.equal(controller.snapshot().notice?.code, "api-unavailable");
    // A second submission without reselecting sends nothing to the enrollment route.
    server.calls.length = 0;
    controller.setAcknowledged(action.id, true);
    await controller.submit(action.id);
    assert.equal(server.calls.filter((call) => call.kind === "enroll").length, 0);
    assert.equal(controller.snapshot().notice?.code, "enrollment-missing");
  }

  // Cancel before submission.
  const server = new FakeSetupServer(canonicalState({ configuration: "unconfigured" }));
  const { controller } = setup(server);
  await controller.start();
  const action = actionOf(controller, "executor.configure");
  controller.selectEnrollment(action.id, "issuer-key", new OpaqueSecretBlob());
  controller.cancelEnrollment(action.id, "issuer-key");
  assert.deepEqual(controller.snapshot().enrollments, {});

  // Cancel during upload aborts the stream and drops the reference.
  server.enrollBehavior = "hang";
  controller.setAcknowledged(action.id, true);
  controller.selectEnrollment(action.id, "issuer-key", new OpaqueSecretBlob());
  const pending = controller.submit(action.id);
  await settle();
  const upload = server.calls.find((call) => call.kind === "enroll");
  assert.ok(upload?.signal);
  assert.equal(controller.snapshot().working?.enrollment, true);
  controller.cancelEnrollment(action.id, "issuer-key");
  await pending;
  assert.equal(upload.signal.aborted, true);
  assert.deepEqual(controller.snapshot().enrollments, {});
  assert.equal(controller.snapshot().notice?.code, "enrollment-cancelled");
  assert.equal(server.effects, 0);

  // Oversized or empty selections are refused and not kept; undeclared inputs are ignored.
  controller.selectEnrollment(action.id, "issuer-key", new Blob([new Uint8Array(64 * 1024 + 1)]));
  assert.deepEqual(controller.snapshot().enrollments, {});
  assert.equal(controller.snapshot().notice?.code, "enrollment-too-large");
  controller.selectEnrollment(action.id, "app-id", new OpaqueSecretBlob());
  assert.deepEqual(controller.snapshot().enrollments, {});
  controller.dispose();
});

test("state is re-read after actions, on page return and while a bounded operation is waiting", async () => {
  const server = new FakeSetupServer(inProgressState());
  const hidden = { value: false };
  const { controller, scheduler } = setup(server, hidden, 2);
  await controller.start();
  assert.equal(controller.snapshot().state?.nextAction.kind, "wait");
  assert.equal(controller.snapshot().polling, "active");
  assert.equal(scheduler.pending.size, 1);

  await scheduler.fire();
  assert.equal(server.calls.filter((call) => call.kind === "state").length, 2);
  await scheduler.fire();
  assert.equal(controller.snapshot().polling, "paused", "poll budget is bounded");
  assert.equal(scheduler.pending.size, 0);

  // Hidden pages never poll; returning refreshes and restores the budget.
  controller.visibilityChanged(true);
  assert.equal(scheduler.pending.size, 0);
  hidden.value = true;
  controller.focusReturned();
  await settle();
  assert.equal(server.calls.filter((call) => call.kind === "state").length, 3);
  hidden.value = false;
  controller.visibilityChanged(false);
  await settle();
  assert.equal(server.calls.filter((call) => call.kind === "state").length, 4);
  assert.equal(controller.snapshot().polling, "active");
  controller.focusReturned();
  await settle();
  assert.equal(server.calls.filter((call) => call.kind === "state").length, 5);

  // Hiding cancels the scheduled poll.
  hidden.value = true;
  controller.visibilityChanged(true);
  assert.equal(scheduler.pending.size, 0);
  hidden.value = false;

  // The operation finishes: the server offers a performable action and polling stops.
  server.current = canonicalState({ health: "unhealthy" });
  controller.visibilityChanged(false);
  await settle();
  assert.equal(controller.snapshot().state?.nextAction.kind, "perform");
  assert.equal(controller.snapshot().polling, "idle");
  assert.equal(scheduler.pending.size, 0);

  // Blocked and complete states do not poll either.
  for (const state of [canonicalState({ sessionReadiness: "not-ready" }), canonicalState()]) {
    server.current = state;
    await controller.refresh();
    assert.ok(["blocked", "complete"].includes(controller.snapshot().state!.nextAction.kind));
    assert.equal(scheduler.pending.size, 0);
  }

  // Unreachable API: no polling, an explicit notice, recovery on the next refresh.
  const failing = Object.create(server) as FakeSetupServer;
  failing.state = async () => {
    throw new Error("offline");
  };
  const offline = setup(failing);
  await offline.controller.start();
  assert.equal(offline.controller.snapshot().phase, "unavailable");
  assert.equal(offline.controller.snapshot().notice?.code, "refresh-failed");
  assert.equal(offline.scheduler.pending.size, 0);
  controller.dispose();
});

test("a human trust wait is shown as waiting; the only control is the canonical recheck", async () => {
  const server = new FakeSetupServer(canonicalState({ repositoryTrust: "pending-human-trust" }));
  const { controller, scheduler } = setup(server);
  await controller.start();
  const state = controller.snapshot().state!;
  assert.deepEqual(state.nextAction, {
    kind: "wait",
    step: "repository-trust",
    reason: "human-trust",
    actionId: state.actions[0]!.id,
  });
  assert.deepEqual(
    state.actions.map((action) => action.kind),
    ["authority.recheck-trust"],
  );
  assert.equal(scheduler.pending.size, 1, "waiting for the external step polls within its budget");
  assert.equal(server.effects, 0, "nothing is approved or merged by the controller");
  controller.dispose();
});
