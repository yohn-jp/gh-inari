import assert from "node:assert/strict";
import { test } from "node:test";
import { createEndpointApi, type EndpointApiRequest } from "./endpoint-api.js";
import { createEndpointHttpHandler, ENDPOINT_HTTP_PATH } from "./endpoint-http.js";
import type { EndpointHumanAuthenticationPort } from "./endpoint-api.js";

const endpoint = { version: 1, kind: "endpoint", id: "http-endpoint", deployment: "self-hosted" } as const;
const installation = {
  version: 1,
  kind: "installation",
  endpointId: endpoint.id,
  installationId: "http-installation",
} as const;
const repository = {
  version: 1,
  kind: "repository",
  endpointId: endpoint.id,
  installationId: installation.installationId,
  repositoryHost: "github.com",
  repositoryId: "1330755860",
  nameWithOwner: "yohn-jp/gh-inari",
} as const;
const principal = { version: 1, kind: "human", id: "http-human" } as const;
const capability = { kind: "presence.read" } as const;
const evidence = {
  version: 1,
  authenticated: true,
  principal,
  endpoint,
  installation,
  repository,
  capabilities: [capability],
} as const;

function request(operation: string = "presence.read"): EndpointApiRequest {
  return { version: 1, operation, endpoint, installation, repository, capability };
}

function handler(authenticate: EndpointHumanAuthenticationPort["authenticate"] = async () => evidence) {
  return createEndpointHttpHandler({
    api: createEndpointApi({
      authentication: { authenticate },
      readPresence: async () => ({
        endpoint,
        repository,
        now: 1_000,
        relay: {
          version: 1,
          repository: { repositoryHost: repository.repositoryHost, repositoryId: repository.repositoryId },
          availability: "available",
          observedAtMs: 1_000,
          records: [],
        },
      }),
    }),
  });
}

async function post(body: unknown, apiHandler = handler()): Promise<Response> {
  return apiHandler(
    new Request(`https://endpoint.example${ENDPOINT_HTTP_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("HTTP adapter carries the shared API success envelope", async () => {
  const response = await post(request());
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok?: boolean; data?: { presence?: { state?: string } } };
  assert.equal(body.ok, true);
  assert.equal(body.data?.presence?.state, "unavailable");
});

test("HTTP adapter maps missing human authentication to 401", async () => {
  const response = await post(
    request(),
    handler(async () => undefined),
  );
  assert.equal(response.status, 401);
  const body = (await response.json()) as { error?: { code?: string } };
  assert.equal(body.error?.code, "ENDPOINT_API_AUTHENTICATION_REQUIRED");
});

test("HTTP adapter fails closed for an unsupported operation", async () => {
  const response = await post(request("change.merge"));
  assert.equal(response.status, 422);
  const body = (await response.json()) as { error?: { code?: string } };
  assert.equal(body.error?.code, "ENDPOINT_API_UNSUPPORTED_OPERATION");
});

test("HTTP adapter bounds its method, media type, and JSON surface", async () => {
  const apiHandler = handler();
  const method = await apiHandler(new Request(`https://endpoint.example${ENDPOINT_HTTP_PATH}`));
  assert.equal(method.status, 405);
  const media = await apiHandler(
    new Request(`https://endpoint.example${ENDPOINT_HTTP_PATH}`, { method: "POST", body: "{}" }),
  );
  assert.equal(media.status, 415);
  const malformed = await apiHandler(
    new Request(`https://endpoint.example${ENDPOINT_HTTP_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    }),
  );
  assert.equal(malformed.status, 400);
});
