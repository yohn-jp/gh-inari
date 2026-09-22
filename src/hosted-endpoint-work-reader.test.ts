import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostedEndpointWorkReader, type HostedEndpointWorkReaderOptions } from "./hosted-endpoint-work-reader.js";
import type { EndpointApiProjectionRequest } from "./endpoint-api.js";
import type { ChangeProjectionResult } from "./change.js";

const repository = {
  version: 1 as const,
  kind: "repository" as const,
  endpointId: "endpoint-1",
  installationId: "installation-1",
  repositoryHost: "github.com",
  repositoryId: "700",
  nameWithOwner: "acme/frontier",
};

const request = {
  version: 1 as const,
  operation: "work.read" as const,
  endpoint: { version: 1 as const, kind: "endpoint" as const, id: "endpoint-1", deployment: "shared-hosted" as const },
  installation: {
    version: 1 as const,
    kind: "installation" as const,
    endpointId: "endpoint-1",
    installationId: "installation-1",
  },
  repository,
  principal: { version: 1 as const, kind: "human" as const, id: "github-user:1" },
  authorization: {} as never,
  rootIssue: 1,
} satisfies EndpointApiProjectionRequest;

const absentChange: ChangeProjectionResult = {
  valid: true,
  status: "absent",
  candidates: { branches: [], pullRequests: [] },
  diagnostics: [],
};

function readerOptions(
  calls: Array<{ readonly method: string; readonly path: string }>,
): HostedEndpointWorkReaderOptions {
  return {
    now: () => "2026-09-22T00:00:00.000Z",
    changeReader: { read: async () => absentChange },
    withRepositoryReadTransport: async (operation) =>
      operation({
        async request(input) {
          calls.push(input);
          if (input.method !== "GET") throw new Error("mutation");
          if (input.path === "repos/acme/frontier" || input.path === "repos/acme/frontier/") {
            return { status: 200, body: { id: 700, default_branch: "main" } };
          }
          if (input.path === "repos/acme/frontier/issues/1") {
            return {
              status: 200,
              body: {
                number: 1,
                title: "Root",
                body: null,
                state: "open",
                html_url: "https://github.com/acme/frontier/issues/1",
                labels: [],
                assignees: [],
              },
            };
          }
          if (input.path.startsWith("repos/acme/frontier/issues/1/dependencies/blocked_by")) {
            return { status: 404, body: {} };
          }
          if (input.path.startsWith("repos/acme/frontier/issues/1/comments")) {
            return { status: 404, body: {} };
          }
          if (input.path === "repos/acme/frontier/git/ref/heads/main") {
            return { status: 200, body: { ref: "refs/heads/main", object: { type: "commit", sha: "a".repeat(40) } } };
          }
          throw new Error(`unexpected path ${input.path}`);
        },
      }),
  };
}

test("requires the exact admitted root Issue before invoking the read capability", async () => {
  let calls = 0;
  const reader = createHostedEndpointWorkReader({
    withRepositoryReadTransport: async () => {
      calls += 1;
      throw new Error("must not read");
    },
  });
  await assert.rejects(reader({ ...request, rootIssue: undefined }), /rootIssue/);
  assert.equal(calls, 0);
});

test("composes a bounded Frontier closure and only uses GET repository reads", async () => {
  const calls: Array<{ readonly method: string; readonly path: string }> = [];
  const reader = createHostedEndpointWorkReader(readerOptions(calls));
  const projection = await reader(request);
  assert.equal(projection.kind, "endpoint-work");
  assert.equal(projection.repository.repositoryId, repository.repositoryId);
  assert.equal(projection.freshness.authoritative?.provenance.revision, "a".repeat(40));
  assert.equal(projection.work.items.length, 1);
  assert.equal(projection.work.items[0]?.evidence.operationalIssue.status, "present");
  assert.equal(
    calls.every((entry) => entry.method === "GET"),
    true,
  );
  assert.equal(
    calls.some((entry) => entry.path.includes("issues/2")),
    false,
  );
});
