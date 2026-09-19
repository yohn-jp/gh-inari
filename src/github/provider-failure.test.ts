import assert from "node:assert/strict";
import { test } from "node:test";
import {
  githubProviderFailure,
  githubProviderFailureFromStatus,
  normalizeGitHubProviderFailureClassification,
  projectGitHubProviderHeaders,
  readGitHubProviderFailure,
  attachGitHubProviderFailure,
} from "./provider-failure.js";

test("provider HTTP status classification is stable and drives retryability", () => {
  const cases = [
    [401, "authentication", false],
    [403, "authorization", false],
    [404, "not-found", false],
    [409, "conflict", false],
    [422, "validation", false],
    [429, "rate-limit", true],
    [500, "server", true],
    [503, "server", true],
  ] as const;
  for (const [status, failureClass, retryable] of cases) {
    assert.deepEqual(githubProviderFailureFromStatus(status), {
      failureClass,
      retryable,
      status,
    });
  }
});

test("403 rate limiting is distinct from authorization and preserves only bounded request identity", () => {
  const headers = new Headers({
    "x-ratelimit-remaining": "0",
    "retry-after": "2",
    "x-github-request-id": "ABCD:1234:5678",
    authorization: "Bearer secret-token",
    cookie: "secret-cookie",
  });
  assert.deepEqual(projectGitHubProviderHeaders(headers), {
    "x-ratelimit-remaining": "0",
    "retry-after": "2",
    "x-github-request-id": "ABCD:1234:5678",
  });
  assert.deepEqual(githubProviderFailureFromStatus(403, headers), {
    failureClass: "rate-limit",
    retryable: true,
    status: 403,
    requestId: "ABCD:1234:5678",
  });
});

test("provider failure normalization rejects unknown fields and unsafe request ids", () => {
  assert.deepEqual(
    normalizeGitHubProviderFailureClassification({
      failureClass: "timeout",
      retryable: true,
      timeoutMs: 1000,
    }),
    { failureClass: "timeout", retryable: true, timeoutMs: 1000 },
  );
  assert.throws(() =>
    normalizeGitHubProviderFailureClassification({
      failureClass: "transport",
      retryable: true,
      rawProviderBody: "forbidden",
    }),
  );
  assert.throws(() =>
    normalizeGitHubProviderFailureClassification({
      failureClass: "server",
      retryable: true,
      status: 503,
      requestId: "bad\nrequest-id",
    }),
  );
});

test("provider failure survives bounded error wrapping without exposing arbitrary text", () => {
  const inner = attachGitHubProviderFailure(
    new Error("provider raw text remains internal"),
    githubProviderFailure("transport", { retryable: true }),
  );
  const outer = new Error("domain wrapper", { cause: inner });
  assert.deepEqual(readGitHubProviderFailure(outer), {
    failureClass: "transport",
    retryable: true,
  });
});
