import assert from "node:assert/strict";
import { test } from "node:test";
import { ENDPOINT_READ_QUERY_LIMITS, validateEndpointReadQuery } from "./endpoint-read-query.js";

test("requires a bounded root for work reads and preserves it", () => {
  assert.equal(validateEndpointReadQuery("work.read", undefined).valid, false);
  const result = validateEndpointReadQuery("work.read", { rootIssue: 952 });
  assert.equal(result.valid, true);
  assert.deepEqual(result.value, { rootIssue: 952 });
});

test("allows repository reads without a root and accepts an explicit root", () => {
  assert.equal(validateEndpointReadQuery("repository.read", undefined).valid, true);
  assert.deepEqual(validateEndpointReadQuery("repository.read", { rootIssue: 950 }).value, { rootIssue: 950 });
});

test("rejects work fields for presence reads and rejects unknown query fields", () => {
  const presence = validateEndpointReadQuery("presence.read", { rootIssue: 950 });
  assert.equal(presence.valid, false);
  assert.equal(presence.diagnostics[0]?.code, "ENDPOINT_READ_QUERY_UNSUPPORTED_FIELD");
  const unknown = validateEndpointReadQuery("repository.read", { provider: "github" });
  assert.equal(unknown.valid, false);
  assert.equal(unknown.diagnostics[0]?.code, "ENDPOINT_READ_QUERY_UNKNOWN_PROPERTY");
});

test("rejects non-integer, non-positive, and oversized roots", () => {
  for (const rootIssue of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, ENDPOINT_READ_QUERY_LIMITS.maxRootIssue + 1]) {
    const result = validateEndpointReadQuery("work.read", { rootIssue });
    assert.equal(result.valid, false);
    assert.equal(result.diagnostics[0]?.code, "ENDPOINT_READ_QUERY_INVALID_ROOT");
  }
});
