import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANGE_STATES, CHANGE_TRANSITION_OPERATIONS, type ChangeState, type ChangeTransition } from "./change.js";
import { createChangeLifecycleMachine, transitionChangeLifecycle } from "./change/machine/lifecycle-machine.js";

const EXPECTED_TRANSITIONS: ReadonlyMap<string, { readonly from: ChangeState; readonly to: ChangeState }> = new Map([
  ["issue/DEFINED", { from: "DEFINED", to: "DRAFT" }],
  ["ready/DRAFT", { from: "DRAFT", to: "REVIEW" }],
  ["ready/REVIEW", { from: "REVIEW", to: "REVIEW" }],
  ["abort/DRAFT", { from: "DRAFT", to: "ABORTED" }],
  ["abort/REVIEW", { from: "REVIEW", to: "ABORTED" }],
  ["abort/ABORTED", { from: "ABORTED", to: "ABORTED" }],
  ["abort/RECOVERY_REQUIRED", { from: "RECOVERY_REQUIRED", to: "ABORTED" }],
  ["merge/REVIEW", { from: "REVIEW", to: "MERGED" }],
  ["merge/ACCEPTED", { from: "ACCEPTED", to: "MERGED" }],
]);

test("XState lifecycle machine has complete parity with the test-only transition oracle", () => {
  for (const state of CHANGE_STATES) {
    for (const operation of CHANGE_TRANSITION_OPERATIONS) {
      const expected = EXPECTED_TRANSITIONS.get(`${operation}/${state}`);
      const result = transitionChangeLifecycle(state, operation);

      assert.equal(result.from, state, `${state}/${operation} source state`);
      assert.equal(result.accepted, expected !== undefined, `${state}/${operation} legality`);
      assert.equal(result.to, expected?.to ?? state, `${state}/${operation} target state`);
      assert.equal(result.idempotent, expected !== undefined && expected.from === expected.to, `${state}/${operation}`);
      assert.equal(
        result.rejection,
        expected === undefined ? "not-allowed" : undefined,
        `${state}/${operation} rejection`,
      );
    }
  }
});

test("lifecycle facade admits authoritative state and preserves sequential retry semantics", () => {
  const lifecycle = createChangeLifecycleMachine("REVIEW");
  assert.equal(lifecycle.state, "REVIEW");

  const ready = lifecycle.transition("ready");
  assert.deepEqual(ready, {
    operation: "ready",
    from: "REVIEW",
    to: "REVIEW",
    accepted: true,
    idempotent: true,
  });
  assert.equal(lifecycle.state, "REVIEW");

  const abort = lifecycle.transition("abort");
  assert.deepEqual(abort, {
    operation: "abort",
    from: "REVIEW",
    to: "ABORTED",
    accepted: true,
    idempotent: false,
  });
  assert.equal(lifecycle.state, "ABORTED");

  const retry = lifecycle.transition("abort");
  assert.equal(retry.accepted, true);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.to, "ABORTED");
});

test("observation-derived states expose only the governed merge terminalization edge", () => {
  for (const operation of CHANGE_TRANSITION_OPERATIONS as readonly ChangeTransition[]) {
    const accepted = transitionChangeLifecycle("ACCEPTED", operation);
    assert.equal(accepted.accepted, operation === "merge", `ACCEPTED/${operation}`);
    assert.equal(accepted.to, operation === "merge" ? "MERGED" : "ACCEPTED", `ACCEPTED/${operation}`);
    const merged = transitionChangeLifecycle("MERGED", operation);
    assert.equal(merged.accepted, false, `MERGED/${operation}`);
    assert.equal(merged.to, "MERGED", `MERGED/${operation}`);
  }
});
