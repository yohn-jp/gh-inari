import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGE_STATES,
  CHANGE_TRANSITION_OPERATIONS,
  CHANGE_TRANSITION_RULES,
  type ChangeState,
  type ChangeTransition,
} from "./change.js";
import { createChangeLifecycleMachine, transitionChangeLifecycle } from "./change/machine/lifecycle-machine.js";

test("XState lifecycle machine has complete parity with the migration transition contract", () => {
  for (const state of CHANGE_STATES) {
    for (const operation of CHANGE_TRANSITION_OPERATIONS) {
      const expected = CHANGE_TRANSITION_RULES.find((rule) => rule.from === state && rule.transition === operation);
      const result = transitionChangeLifecycle(state, operation);

      assert.equal(result.from, state, `${state}/${operation} source state`);
      assert.equal(result.accepted, expected !== undefined, `${state}/${operation} legality`);
      assert.equal(result.to, expected?.to ?? state, `${state}/${operation} target state`);
      assert.equal(result.idempotent, expected !== undefined && expected.from === expected.to, `${state}/${operation}`);
      assert.equal(
        result.rejection,
        expected === undefined ? (operation === "merge" ? "unsupported" : "not-allowed") : undefined,
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

test("observation-derived states have no synthetic lifecycle mutation edges", () => {
  for (const state of ["ACCEPTED", "MERGED"] as const satisfies readonly ChangeState[]) {
    for (const operation of CHANGE_TRANSITION_OPERATIONS as readonly ChangeTransition[]) {
      const result = transitionChangeLifecycle(state, operation);
      assert.equal(result.accepted, false, `${state}/${operation}`);
      assert.equal(result.to, state, `${state}/${operation}`);
    }
  }
});
