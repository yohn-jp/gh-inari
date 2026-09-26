import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeFailure } from "../runtime-contracts/runtime-failure.js";
import {
  beginLocalRuntimeRequest,
  runtimeCorrelationForRequestId,
  writeLocalRuntimeLog,
  type LocalRuntimeLogFields,
} from "./runtime-log.js";

function captureStderr(run: () => void): string {
  const originalWrite = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = originalWrite;
  }
  return output;
}

test("Runtime request logs sanitize routes and project only bounded failure metadata", () => {
  const sessionId = "session-route-secret-value";
  const requestId = "request-correlation-secret-value";
  const providerValue = "provider-response-secret-value";
  const correlationId = runtimeCorrelationForRequestId(requestId);
  assert.ok(correlationId !== undefined);
  const output = captureStderr(() => {
    const request = beginLocalRuntimeRequest("admission", "DELETE", `/v1/sessions/${sessionId}?token=${providerValue}`);
    request.complete(403, runtimeFailure("session-registration", "ADMISSION_SESSION_BINDING_INVALID"));
    writeLocalRuntimeLog({
      component: "executor",
      event: "execution.completed",
      operation: "change.show",
      correlationId,
      elapsedMs: Number.MAX_VALUE,
      status: 500,
      outcome: "failure",
      failure: new Error(providerValue),
      rawBody: providerValue,
    } as LocalRuntimeLogFields);
  });
  const lines = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], {
    component: "admission",
    event: "request.received",
    method: "DELETE",
    route: "/v1/sessions/:id",
    correlationId: lines[0]?.correlationId,
  });
  assert.equal(lines[1]?.event, "request.completed");
  assert.equal(lines[1]?.route, "/v1/sessions/:id");
  assert.equal(lines[1]?.elapsedMs !== undefined, true);
  assert.equal(lines[1]?.status, 403);
  assert.equal(lines[1]?.outcome, "denied");
  assert.deepEqual(lines[1]?.failure, {
    code: "ADMISSION_SESSION_BINDING_INVALID",
    stage: "session-registration",
    category: "session",
  });
  assert.equal(lines[2]?.elapsedMs, 2_147_483_647);
  assert.equal(lines[2]?.operation, "change.show");
  assert.equal(lines[2]?.failure, undefined);
  assert.doesNotMatch(
    output,
    /session-route-secret-value|request-correlation-secret-value|provider-response-secret-value/u,
  );
});

test("Runtime execution correlation is deterministic and never returns the source request id", () => {
  const requestId = "a-private-request-id";
  const correlationId = runtimeCorrelationForRequestId(requestId);
  assert.equal(correlationId, runtimeCorrelationForRequestId(requestId));
  assert.match(correlationId ?? "", /^corr_[0-9a-f]{24}$/u);
  assert.ok(!correlationId?.includes(requestId));
  assert.equal(runtimeCorrelationForRequestId("\nsecret"), undefined);
  assert.equal(runtimeCorrelationForRequestId("x".repeat(129)), undefined);
});
