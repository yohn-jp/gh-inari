import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRelayTelemetryEvent,
  recordRelayTelemetry,
  relayTelemetryRepositoryKey,
  type RelayTelemetryEvent,
} from "./telemetry.js";

const repository = { repositoryHost: "github.com", repositoryId: "1330755860" } as const;

test("telemetry is bounded, pseudonymous, and transport-only", () => {
  const event = createRelayTelemetryEvent({
    occurredAtMs: 10_000,
    kind: "delivery",
    surface: "durable-object",
    repository,
    connectionId: "runtime-1",
    jobId: "job-1",
    deliveryState: "possibly-delivered",
    failureClass: "disconnected",
    durationMs: Number.MAX_SAFE_INTEGER,
    counters: {
      connections: Number.MAX_SAFE_INTEGER,
      inFlightJobs: 1,
      retainedJobs: 2,
      messagesInWindow: 3,
      cpuActiveMs: Number.MAX_SAFE_INTEGER,
    },
  });
  const serialized = JSON.stringify(event);
  assert.equal(event.repositoryKey, relayTelemetryRepositoryKey(repository));
  assert.equal(event.repositoryKey.includes(repository.repositoryId), false);
  assert.equal(event.durationMs, 86_400_000);
  assert.equal(event.counters?.connections, 1_000_000);
  assert.equal(event.counters?.cpuActiveMs, 86_400_000);
  assert.equal(serialized.includes("signedSessionRequest"), false);
  assert.equal(serialized.includes("resultPayload"), false);
  assert.equal(serialized.includes("signature"), false);
  assert.equal(serialized.includes("credential"), false);
  assert.equal(serialized.includes("token"), false);
});

test("telemetry sink failures cannot affect relay behavior", async () => {
  const events: RelayTelemetryEvent[] = [];
  const sink = {
    record(event: RelayTelemetryEvent): void {
      events.push(event);
      throw new Error("telemetry unavailable");
    },
  };
  await recordRelayTelemetry(
    sink,
    createRelayTelemetryEvent({
      occurredAtMs: 1,
      kind: "message",
      surface: "hosted-worker",
      repository,
    }),
  );
  assert.equal(events.length, 1);
});
