import assert from "node:assert/strict";
import test from "node:test";
import {
  RELAY_DELIVERY_STATE_VERSION,
  RelayDeliveryStateError,
  applyRelayDeliveryEvent,
  createRelayDeliveryState,
  deserializeRelayDeliveryState,
  isRelayDeliveryRetryable,
  reduceRelayDeliveryState,
  serializeRelayDeliveryState,
} from "./delivery-state.js";

const job = { connectionId: "connection-818", jobId: "job-818" } as const;

function event(type: "deliver" | "acknowledge" | "disconnect" | "timeout" | "reconnect" | "expire" | "cancel") {
  return { version: RELAY_DELIVERY_STATE_VERSION, type, ...job } as const;
}

function result(resultDigest: string) {
  return { version: RELAY_DELIVERY_STATE_VERSION, type: "result", ...job, resultDigest } as const;
}

test("initial queue and pre-delivery disconnect remain provably undelivered and retryable", () => {
  const initial = createRelayDeliveryState(job);
  assert.equal(initial.phase, "queued");
  assert.equal(initial.deliveryEvidence, "not-delivered");
  assert.equal(isRelayDeliveryRetryable(initial), true);

  const disconnected = reduceRelayDeliveryState(initial, event("disconnect"));
  assert.equal(disconnected.phase, "unavailable");
  assert.equal(disconnected.recovery, "none");
  assert.equal(isRelayDeliveryRetryable(disconnected), true);

  const reconnected = reduceRelayDeliveryState(disconnected, event("reconnect"));
  assert.equal(reconnected.phase, "queued");
  assert.equal(isRelayDeliveryRetryable(reconnected), true);
});

test("delivery, acknowledgement, timeout, and reconnect preserve ambiguity and prohibit retry", () => {
  const delivered = reduceRelayDeliveryState(createRelayDeliveryState(job), event("deliver"));
  assert.equal(delivered.phase, "delivered");
  assert.equal(isRelayDeliveryRetryable(delivered), false);

  const acknowledged = reduceRelayDeliveryState(delivered, event("acknowledge"));
  assert.equal(acknowledged.phase, "acknowledged");

  const ambiguous = reduceRelayDeliveryState(acknowledged, event("timeout"));
  assert.equal(ambiguous.phase, "possibly-delivered");
  assert.equal(ambiguous.deliveryEvidence, "delivered-ambiguous");
  assert.equal(ambiguous.recovery, "recovery-required");
  assert.equal(isRelayDeliveryRetryable(ambiguous), false);
  assert.equal(reduceRelayDeliveryState(ambiguous, event("reconnect")).phase, "possibly-delivered");
  assert.equal(reduceRelayDeliveryState(ambiguous, event("disconnect")).phase, "possibly-delivered");
  assert.equal(reduceRelayDeliveryState(ambiguous, event("acknowledge")).phase, "possibly-delivered");
});

test("disconnect and expiry after delivery never claim rollback or safe replay", () => {
  const delivered = reduceRelayDeliveryState(createRelayDeliveryState(job), event("deliver"));
  const disconnected = reduceRelayDeliveryState(delivered, event("disconnect"));
  assert.equal(disconnected.phase, "possibly-delivered");
  assert.equal(disconnected.automaticRetry, "forbidden");
  assert.equal(reduceRelayDeliveryState(disconnected, event("expire")).phase, "possibly-delivered");

  const preDeliveryExpiry = reduceRelayDeliveryState(createRelayDeliveryState(job), event("expire"));
  assert.equal(preDeliveryExpiry.phase, "expired");
  assert.equal(preDeliveryExpiry.deliveryEvidence, "not-delivered");
  assert.equal(isRelayDeliveryRetryable(preDeliveryExpiry), false);
  assert.equal(reduceRelayDeliveryState(preDeliveryExpiry, event("deliver")).phase, "expired");
  const lateResult = applyRelayDeliveryEvent(preDeliveryExpiry, result("sha256-late-result"));
  assert.equal(lateResult.transition, "late-event-ignored");
  assert.deepEqual(lateResult.state, preDeliveryExpiry);

  const cancelled = reduceRelayDeliveryState(createRelayDeliveryState(job), event("cancel"));
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.automaticRetry, "forbidden");
});

test("terminal results are digest-only, deterministic, and immutable", () => {
  const terminal = reduceRelayDeliveryState(
    reduceRelayDeliveryState(createRelayDeliveryState(job), event("deliver")),
    result("sha256-result-a"),
  );
  assert.equal(terminal.phase, "terminal-result");
  assert.equal(terminal.resultDigest, "sha256-result-a");
  assert.equal(terminal.recovery, "none");
  assert.equal(isRelayDeliveryRetryable(terminal), false);

  const duplicate = applyRelayDeliveryEvent(terminal, result("sha256-result-a"));
  assert.equal(duplicate.transition, "duplicate-result-ignored");
  assert.deepEqual(duplicate.state, terminal);
  const conflicting = applyRelayDeliveryEvent(terminal, result("sha256-result-b"));
  assert.equal(conflicting.transition, "conflicting-result-ignored");
  assert.deepEqual(conflicting.state, terminal);
  assert.equal(reduceRelayDeliveryState(terminal, event("reconnect")).phase, "terminal-result");
});

test("a late result is transport evidence and never stores the result payload", () => {
  const ambiguous = reduceRelayDeliveryState(
    reduceRelayDeliveryState(createRelayDeliveryState(job), event("deliver")),
    event("disconnect"),
  );
  const terminal = reduceRelayDeliveryState(ambiguous, result("sha256-late-result"));
  assert.equal(terminal.phase, "terminal-result");
  assert.equal(terminal.resultDigest, "sha256-late-result");
  assert.equal("resultPayload" in terminal, false);
  assert.equal("signedSessionRequest" in terminal, false);
});

test("versioned state serialization is canonical and rejects semantic or payload fields", () => {
  const state = createRelayDeliveryState(job);
  const serialized = serializeRelayDeliveryState(state);
  assert.equal(serialized, JSON.stringify(state));
  assert.deepEqual(deserializeRelayDeliveryState(serialized), state);
  assert.throws(
    () => deserializeRelayDeliveryState(JSON.stringify({ ...state, version: 2 })),
    (error: unknown) => error instanceof RelayDeliveryStateError && error.code === "RELAY_DELIVERY_UNSUPPORTED_VERSION",
  );
  assert.throws(
    () => deserializeRelayDeliveryState(JSON.stringify({ ...state, signedSessionRequest: "raw" })),
    (error: unknown) => error instanceof RelayDeliveryStateError && error.code === "RELAY_DELIVERY_INVALID_STATE",
  );
  assert.throws(
    () => deserializeRelayDeliveryState(JSON.stringify({ ...state, phase: "success" })),
    (error: unknown) => error instanceof RelayDeliveryStateError && error.code === "RELAY_DELIVERY_INVALID_STATE",
  );
});

test("mismatched events and invalid digests cannot mutate a state", () => {
  const state = createRelayDeliveryState(job);
  assert.throws(
    () => reduceRelayDeliveryState(state, { ...event("deliver"), jobId: "other-job" }),
    (error: unknown) => error instanceof RelayDeliveryStateError && error.code === "RELAY_DELIVERY_MISMATCHED_JOB",
  );
  assert.throws(
    () => reduceRelayDeliveryState(state, result("raw result bytes")),
    (error: unknown) => error instanceof RelayDeliveryStateError && error.code === "RELAY_DELIVERY_INVALID_DIGEST",
  );
});
