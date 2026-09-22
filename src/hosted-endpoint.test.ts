import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostedEndpoint } from "./hosted-endpoint.js";
import { ENDPOINT_AUTHORIZATION_CONTRACT_VERSION } from "./endpoint-authorization.js";
import type { HostedEndpointPresenceNamespace } from "./hosted-endpoint-presence-reader.js";

const endpoint = {
  version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
  kind: "endpoint" as const,
  id: "dashboard-endpoint",
  deployment: "shared-hosted" as const,
};
const installation = {
  version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
  kind: "installation" as const,
  endpointId: endpoint.id,
  installationId: "9001",
};
const repository = {
  version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
  kind: "repository" as const,
  endpointId: endpoint.id,
  installationId: installation.installationId,
  repositoryHost: "github.com",
  repositoryId: "1330755860",
  nameWithOwner: "yohn-jp/gh-inari",
};

function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    operation: "presence.read",
    endpoint,
    installation,
    repository,
    capability: { kind: "presence.read" },
    ...overrides,
  };
}

function presenceNamespace(): HostedEndpointPresenceNamespace {
  return {
    idFromName(name) {
      assert.equal(name, repository.repositoryId);
      return `relay:${name}`;
    },
    get(id) {
      assert.equal(id, `relay:${repository.repositoryId}`);
      return {
        async fetch(request) {
          assert.equal(request.method, "GET");
          return new Response(
            JSON.stringify({
              version: 1,
              repository: {
                repositoryHost: repository.repositoryHost,
                repositoryId: repository.repositoryId,
              },
              availability: "available",
              observedAtMs: 1_000,
              records: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      };
    },
  };
}

function providerFetch(calls: Array<{ url: string; authorization: string | null }>): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, authorization: request.headers.get("authorization") });
    const path = new URL(request.url).pathname;
    const body =
      path === "/user"
        ? { id: 42, login: "sophia" }
        : path === "/user/installations"
          ? { installations: [{ id: 9001, app_id: 123456, suspended_at: null }] }
          : { repositories: [{ id: 1330755860, full_name: "yohn-jp/gh-inari" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("shared-hosted Endpoint composes request-scoped human auth with Relay presence", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const handler = createHostedEndpoint({
    endpoint,
    appId: "123456",
    presenceNamespace: presenceNamespace(),
    fetch: providerFetch(calls),
  });
  const response = await handler(
    new Request("https://hosted.example/v1/endpoint", {
      method: "POST",
      headers: { authorization: "Bearer request-scoped-token", "content-type": "application/json" },
      body: JSON.stringify(requestBody()),
    }),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.repository.repositoryId, repository.repositoryId);
  assert.equal(body.data.presence.authoritative, false);
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    ["/user", "/user/installations", "/user/installations/9001/repositories"],
  );
  assert.ok(calls.every((call) => call.authorization === "Bearer request-scoped-token"));
  assert.equal(JSON.stringify(body).includes("request-scoped-token"), false);
});

test("shared-hosted Endpoint rejects a request for a different logical Endpoint before provider access", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const handler = createHostedEndpoint({
    endpoint,
    appId: "123456",
    presenceNamespace: presenceNamespace(),
    fetch: providerFetch(calls),
  });
  const response = await handler(
    new Request("https://hosted.example/v1/endpoint", {
      method: "POST",
      headers: { authorization: "Bearer request-scoped-token", "content-type": "application/json" },
      body: JSON.stringify(requestBody({ endpoint: { ...endpoint, id: "attacker-selected-endpoint" } })),
    }),
  );

  assert.equal(response.status, 401);
  assert.deepEqual(calls, []);
});
