import assert from "node:assert/strict";
import { test } from "node:test";
import { validateExecutionIntent } from "./execution-intent.js";

const branchRequest = {
  version: 1,
  issue: 1018,
  branch: "feat/1018-local-admission",
  expectedHead: "a".repeat(40),
  changes: [{ operation: "upsert", path: "src/example.ts", mode: "100644", content: "eA==" }],
  commit: { message: "Update implementation" },
};

test("ExecutionIntent accepts a closed operation request and rejects caller-authored authority", () => {
  const valid = validateExecutionIntent({
    version: 1,
    requestId: "request-local",
    repository: {
      repositoryHost: "github.com",
      repositoryId: "123456789",
      repositoryNameWithOwner: "acme/inari",
    },
    operation: "branch.advance",
    request: branchRequest,
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.intent?.operation, "branch.advance");

  for (const invalid of [
    { ...valid.intent, capability: [] },
    { ...valid.intent, request: { ...branchRequest, scope: {} } },
    { ...valid.intent, sessionId: "session-local" },
    { ...valid.intent, requestId: "bad id" },
    { ...valid.intent, repository: { ...valid.intent?.repository, repositoryId: "invalid" } },
    {
      version: 2,
      requestId: "request-local",
      repository: valid.intent?.repository,
      operation: "branch.advance",
      request: branchRequest,
    },
    {
      version: 1,
      requestId: "request-local",
      repository: valid.intent?.repository,
      operation: "unknown",
      request: branchRequest,
    },
  ]) {
    assert.equal(validateExecutionIntent(invalid).valid, false);
  }
});
