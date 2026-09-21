import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDashboardEndpointClient,
  DashboardEndpointClientError,
  type DashboardEndpointReadRequest,
} from "./endpoint-client.js";

const endpoint = {
  version: 1 as const,
  kind: "endpoint" as const,
  id: "dashboard-endpoint",
  deployment: "shared-hosted" as const,
};
const installation = {
  version: 1 as const,
  kind: "installation" as const,
  endpointId: endpoint.id,
  installationId: "dashboard-installation",
};
const repository = {
  version: 1 as const,
  kind: "repository" as const,
  endpointId: endpoint.id,
  installationId: installation.installationId,
  repositoryHost: "github.com",
  repositoryId: "1330755860",
  nameWithOwner: "yohn-jp/gh-inari",
};
const request: DashboardEndpointReadRequest = {
  operation: "repository.read",
  endpoint,
  installation,
  repository,
  capability: { kind: "change.implement", issue: 923 },
};

const success = {
  version: 1,
  ok: true,
  operation: "repository.read",
  authorization: { allowed: true },
  data: { repository, unavailable: [] },
} as const;

test("Dashboard sends repository reads to the configured Endpoint contract", async () => {
  let called: { input?: string; init?: RequestInit } = {};
  const client = createDashboardEndpointClient({
    endpoint: "https://endpoint.example.test/",
    headers: { authorization: "Bearer dashboard-user" },
    fetch: (async (input, init) => {
      called = { input: String(input), init };
      return new Response(JSON.stringify(success), { status: 200 });
    }) as typeof globalThis.fetch,
  });

  const result = await client.read(request);
  assert.deepEqual(result, success);
  assert.equal(called.input, "https://endpoint.example.test/v1/endpoint");
  assert.equal(called.init?.method, "POST");
  assert.equal(new Headers(called.init?.headers).get("authorization"), "Bearer dashboard-user");
  assert.equal(new Headers(called.init?.headers).get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(called.init?.body)), {
    version: 1,
    operation: request.operation,
    endpoint,
    installation,
    repository,
    capability: request.capability,
  });
});

test("Dashboard accepts shared-hosted and self-hosted Endpoint origins without changing the request", async () => {
  for (const configuredEndpoint of ["https://shared.example.test", "https://self-hosted.example.test/dashboard"]) {
    let requested = "";
    const client = createDashboardEndpointClient({
      endpoint: configuredEndpoint,
      fetch: (async (input) => {
        requested = String(input);
        return new Response(JSON.stringify(success), { status: 200 });
      }) as typeof globalThis.fetch,
    });
    await client.read(request);
    assert.equal(requested, `${new URL(configuredEndpoint).toString().replace(/\/$/u, "")}/v1/endpoint`);
  }
});

test("Dashboard preserves authenticated Endpoint failures", async () => {
  const client = createDashboardEndpointClient({
    endpoint: "https://endpoint.example.test",
    fetch: (async () =>
      new Response(
        JSON.stringify({
          version: 1,
          ok: false,
          error: { code: "ENDPOINT_API_AUTHORIZATION_DENIED", message: "denied", diagnostics: [] },
        }),
        { status: 403 },
      )) as typeof globalThis.fetch,
  });
  const result = await client.read(request);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "ENDPOINT_API_AUTHORIZATION_DENIED");
});

test("Dashboard rejects malformed Endpoint responses and invalid origins", async () => {
  const client = createDashboardEndpointClient({
    endpoint: "https://endpoint.example.test",
    fetch: (async () => new Response("not-json", { status: 200 })) as typeof globalThis.fetch,
  });
  await assert.rejects(
    () => client.read(request),
    (error: unknown) =>
      error instanceof DashboardEndpointClientError && error.code === "DASHBOARD_ENDPOINT_RESPONSE_INVALID",
  );
  assert.throws(
    () => createDashboardEndpointClient({ endpoint: "http://endpoint.example.test" }),
    (error: unknown) => error instanceof DashboardEndpointClientError && error.code === "DASHBOARD_ENDPOINT_INVALID",
  );
});

test("Dashboard source keeps repository access behind the Endpoint client boundary", () => {
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  for (const sourceFile of ["endpoint-client.ts", "main.ts"]) {
    const source = readFileSync(path.join(sourceDirectory, sourceFile), "utf8");
    assert.doesNotMatch(source, /(?:from|import)\s*["'][^"']*\/(?:github|relay)(?:\/|["'])/u);
    assert.doesNotMatch(source, /(?:change-trusted-executor|session-authorized-change-executor)/u);
  }
});
