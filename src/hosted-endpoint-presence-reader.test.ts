import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createHostedEndpointPresenceReader,
  RELAY_RUNTIME_PRESENCE_INTERNAL_PATH,
  type HostedEndpointPresenceNamespace,
} from "./hosted-endpoint-presence-reader.js";

const endpoint = {
  version: 1 as const,
  kind: "endpoint" as const,
  id: "hosted-endpoint",
  deployment: "shared-hosted" as const,
};
const repository = {
  version: 1 as const,
  kind: "repository" as const,
  endpointId: endpoint.id,
  installationId: "installation-1",
  repositoryHost: "github.com",
  repositoryId: "1330755860",
  nameWithOwner: "yohn-jp/gh-inari",
};
const request = {
  version: 1 as const,
  operation: "presence.read" as const,
  endpoint,
  installation: {
    version: 1 as const,
    kind: "installation" as const,
    endpointId: endpoint.id,
    installationId: repository.installationId,
  },
  repository,
  principal: { version: 1 as const, kind: "human" as const, id: "human-1" },
  authorization: {} as never,
};

function namespace(response: Response, ids: string[], requests: Request[]): HostedEndpointPresenceNamespace {
  return {
    idFromName(name) {
      ids.push(name);
      return `id:${name}`;
    },
    get() {
      return {
        async fetch(input) {
          requests.push(input);
          return response;
        },
      };
    },
  };
}

function record(connectionId: string, delegatorId: string, generation: number) {
  return {
    version: 1,
    repository: { repositoryHost: repository.repositoryHost, repositoryId: repository.repositoryId },
    connectionId,
    delegatorId,
    generation,
    state: "connected" as const,
    authenticated: true,
    current: true,
    openedAtMs: 900,
    expiresAtMs: 10_000,
    observedAtMs: 1_000,
  };
}

test("hosted presence reader derives one DO from the immutable repository ID and preserves runtimes", async () => {
  const ids: string[] = [];
  const requests: Request[] = [];
  const reader = createHostedEndpointPresenceReader({
    namespace: namespace(
      new Response(
        JSON.stringify({
          version: 1,
          repository: { repositoryHost: repository.repositoryHost, repositoryId: repository.repositoryId },
          availability: "available",
          observedAtMs: 1_000,
          records: [record("runtime-a", "delegator-a", 1), record("runtime-b", "delegator-b", 2)],
        }),
        { status: 200 },
      ),
      ids,
      requests,
    ),
    now: () => 1_000,
  });

  const projection = await reader(request);
  assert.deepEqual(ids, [repository.repositoryId]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "GET");
  assert.equal(new URL(requests[0]?.url ?? "https://invalid").pathname, RELAY_RUNTIME_PRESENCE_INTERNAL_PATH);
  assert.equal(projection.state, "connected");
  assert.deepEqual(
    projection.runtimes.map((runtime) => [runtime.connectionId, runtime.delegatorId]),
    [
      ["runtime-a", "delegator-a"],
      ["runtime-b", "delegator-b"],
    ],
  );
});

test("malformed, mismatched, and unavailable DO responses become unknown presence", async () => {
  for (const body of [
    JSON.stringify({
      version: 1,
      repository: { repositoryHost: "github.com", repositoryId: "999999999" },
      availability: "available",
      observedAtMs: 1,
      records: [],
    }),
    JSON.stringify({
      version: 1,
      repository: { repositoryHost: "github.com", repositoryId: repository.repositoryId },
      availability: "available",
      observedAtMs: 1,
      records: [{ bad: true }],
    }),
    "not-json",
  ]) {
    const reader = createHostedEndpointPresenceReader({
      namespace: namespace(new Response(body, { status: 200 }), [], []),
      now: () => 1_000,
    });
    const projection = await reader(request);
    assert.equal(projection.state, "unknown");
    assert.equal(projection.runtimes.length, 0);
  }

  const unavailable = createHostedEndpointPresenceReader({
    namespace: namespace(new Response("unavailable", { status: 503 }), [], []),
    now: () => 1_000,
  });
  assert.equal((await unavailable(request)).state, "unknown");
});
