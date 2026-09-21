import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENDPOINT_RECONCILIATION_VERSION,
  applyEndpointAuthoritativeSnapshot,
  applyEndpointWebhookHint,
  createEndpointObservation,
  reconcileEndpointObservation,
} from "./endpoint-reconciliation.js";

const now = "2026-09-22T00:00:00.000Z";

test("webhook hints never establish authority and duplicate or reordered hints converge", () => {
  const initial = createEndpointObservation<{ status: string }>({ key: "repo:endpoint" });
  const first = applyEndpointWebhookHint(initial, { id: "event-b", revision: 2, occurredAt: now });
  const reordered = applyEndpointWebhookHint(
    applyEndpointWebhookHint(initial, { id: "event-a", revision: 1, occurredAt: now }),
    { id: "event-b", revision: 2, occurredAt: now },
  );
  const firstWithA = applyEndpointWebhookHint(first, { id: "event-a", revision: 1, occurredAt: now });
  const duplicate = applyEndpointWebhookHint(firstWithA, { id: "event-a", revision: 1, occurredAt: now });
  assert.equal(first.state, "reconciling");
  assert.equal(first.authoritative, null);
  assert.equal(first.version, ENDPOINT_RECONCILIATION_VERSION);
  assert.deepEqual(firstWithA.pendingHints, reordered.pendingHints);
  assert.deepEqual(duplicate, firstWithA);
});

test("authoritative reread resolves lost hints and records revision/time provenance", async () => {
  const initial = createEndpointObservation<{ status: string }>({ key: "repo:endpoint" });
  let request: { key: string; pendingHints: readonly unknown[]; attempt: number } | undefined;
  const result = await reconcileEndpointObservation(
    initial,
    (value) => {
      request = value;
      return {
        value: { status: "ready" },
        revision: 8,
        observedAt: now,
      };
    },
    { now, maxAgeMs: 60_000 },
  );
  assert.equal(result.state, "fresh");
  assert.deepEqual(result.authoritative?.provenance, {
    source: "github-authoritative",
    authoritative: true,
    revision: 8,
    observedAt: now,
  });
  assert.equal(request?.key, "repo:endpoint");
  assert.equal(request?.pendingHints.length, 0);
  assert.equal(request?.attempt, 1);
});

test("a stale snapshot is explicit and cannot replace newer authority", () => {
  const initial = createEndpointObservation<{ status: string }>({ key: "repo:endpoint" });
  const current = applyEndpointAuthoritativeSnapshot(
    initial,
    { value: { status: "ready" }, revision: 2, observedAt: now },
    { now, maxAgeMs: 60_000 },
  );
  const older = applyEndpointAuthoritativeSnapshot(
    current,
    { value: { status: "starting" }, revision: 1, observedAt: "2026-09-21T23:59:00.000Z" },
    { now, maxAgeMs: 60_000 },
  );
  assert.equal(older.state, "fresh");
  assert.deepEqual(older.authoritative?.value, { status: "ready" });
  assert.equal(older.diagnostics[0]?.code, "ENDPOINT_RECONCILIATION_STALE_SNAPSHOT");

  const aged = applyEndpointAuthoritativeSnapshot(
    initial,
    { value: { status: "starting" }, revision: 1, observedAt: "2026-09-21T00:00:00.000Z" },
    { now, maxAgeMs: 60_000 },
  );
  assert.equal(aged.state, "stale");
});

test("reread failure remains explicit and bounded", async () => {
  const initial = createEndpointObservation({ key: "repo:endpoint" });
  let attempts = 0;
  const unavailable = await reconcileEndpointObservation(
    initial,
    () => {
      attempts += 1;
      throw new Error("network unavailable");
    },
    { maxAttempts: 2, now },
  );
  assert.equal(attempts, 2);
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.authoritative, null);
  assert.equal(unavailable.diagnostics[0]?.code, "ENDPOINT_RECONCILIATION_REREAD_EXHAUSTED");

  const known = applyEndpointAuthoritativeSnapshot(initial, { value: "ready", revision: 1, observedAt: now }, { now });
  const stale = await reconcileEndpointObservation(
    known,
    async () => {
      throw new Error("network unavailable");
    },
    { now, maxAgeMs: 60_000 },
  );
  assert.equal(stale.state, "stale");
  assert.equal(stale.diagnostics[0]?.code, "ENDPOINT_RECONCILIATION_REREAD_FAILED");
});
