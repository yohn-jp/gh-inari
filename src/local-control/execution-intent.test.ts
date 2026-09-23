import assert from "node:assert/strict";
import { test } from "node:test";
import { tryValidatePrPublicationRequest } from "../pr-publication.js";
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

test("ExecutionIntent preserves canonical publication routing and rejects conflicting route claims", () => {
  const repository = {
    repositoryHost: "github.com",
    repositoryId: "123456789",
    repository: "acme/inari",
  };
  const implementation = { ...repository, number: 1028 };
  const request = {
    version: 1,
    kind: "pr-publication",
    repository,
    workIdentity: { implementation },
    routing: {
      version: 1,
      kind: "integration-routing",
      mode: "standalone",
      role: "implementation",
      implementation,
      relationships: {},
      branches: { default: "main", implementation: "feat/1028-local-admission" },
      head: "feat/1028-local-admission",
      base: "main",
    },
    headRevision: "a".repeat(40),
    title: "feat: local admission",
    body: "Closes #1028",
    draft: true,
  };
  const canonical = tryValidatePrPublicationRequest(request);
  assert.equal(canonical.valid, true);
  assert.ok(canonical.request);
  assert.equal(canonical.request.expectedHead, request.routing.head);
  assert.equal(canonical.request.expectedBase, request.routing.base);
  const intent = {
    version: 1,
    requestId: "publication-routing",
    repository: {
      repositoryHost: repository.repositoryHost,
      repositoryId: repository.repositoryId,
      repositoryNameWithOwner: repository.repository,
    },
    operation: "pullRequest.publish",
    request,
  };
  const validated = validateExecutionIntent(intent);
  assert.equal(validated.valid, true);
  assert.deepEqual(validated.intent?.request, canonical.request);
  assert.equal(validateExecutionIntent({ ...intent, request: { ...request, expectedBase: "other" } }).valid, false);
});
