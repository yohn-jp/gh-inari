import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEndpointAuthoritativeSnapshot, createEndpointObservation } from "./endpoint-reconciliation.js";
import { ENDPOINT_API_CONTRACT_VERSION, createEndpointApi, type EndpointApiRequest } from "./endpoint-api.js";
import type { EndpointAuthorizationEvidence } from "./endpoint-authorization.js";
import type { EndpointRuntimePresenceInput } from "./endpoint-runtime-presence.js";

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
  installationId: "installation-922",
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
const principal = {
  version: 1 as const,
  kind: "human" as const,
  id: "human-922",
};
const capability = { kind: "repository.read" as const };

const evidence: EndpointAuthorizationEvidence = {
  version: ENDPOINT_API_CONTRACT_VERSION,
  authenticated: true,
  principal,
  endpoint,
  installation,
  repository,
  capabilities: [capability],
};

function request(overrides: Partial<EndpointApiRequest> = {}): EndpointApiRequest {
  return {
    version: ENDPOINT_API_CONTRACT_VERSION,
    operation: "repository.read",
    endpoint,
    installation,
    repository,
    capability,
    ...overrides,
  };
}

function freshness() {
  return applyEndpointAuthoritativeSnapshot(
    createEndpointObservation({ key: "github.com/1330755860" }),
    { value: { repository }, revision: "1", observedAt: "2026-09-22T00:00:00.000Z" },
    { now: "2026-09-22T00:00:00.000Z", maxAgeMs: 300_000 },
  );
}

const frontier = {
  version: 1,
  kind: "implementation-frontier",
  valid: true,
  candidates: [
    {
      reference: { repositoryHost: repository.repositoryHost, repositoryId: repository.repositoryId, number: 922 },
      classification: "READY",
      dependencies: [],
      satisfiedDependencies: [],
      unsatisfiedDependencies: [],
      diagnostics: [],
    },
  ],
  ready: [{ repositoryHost: repository.repositoryHost, repositoryId: repository.repositoryId, number: 922 }],
  parallelReadyGroups: [
    { items: [{ repositoryHost: repository.repositoryHost, repositoryId: repository.repositoryId, number: 922 }] },
  ],
  diagnostics: [],
} as const;

function workInput() {
  return { repository, freshness: freshness(), frontier };
}

function presenceInput(overrides: Partial<EndpointRuntimePresenceInput["relay"]> = {}): EndpointRuntimePresenceInput {
  return {
    endpoint,
    repository,
    now: 1_000,
    maxAgeMs: 300_000,
    relay: {
      version: 1,
      repository: { repositoryHost: repository.repositoryHost, repositoryId: repository.repositoryId },
      availability: "available",
      observedAtMs: 1_000,
      records: [],
      ...overrides,
    },
  };
}

function api(options: Parameters<typeof createEndpointApi>[0] = {}) {
  return createEndpointApi({
    authentication: { authenticate: async () => evidence },
    readWork: async () => workInput(),
    readPresence: async () => presenceInput(),
    ...options,
  });
}

test("requires an authenticated human principal", async () => {
  const result = await createEndpointApi({
    authentication: { authenticate: async () => undefined },
  }).execute(request());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ENDPOINT_API_AUTHENTICATION_REQUIRED");
});

test("denies a human request when the Endpoint capability is not admitted", async () => {
  const result = await api({
    authentication: {
      authenticate: async () => ({
        ...evidence,
        capabilities: [{ kind: "presence.read" }],
      }),
    },
  }).execute(request());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ENDPOINT_API_AUTHORIZATION_DENIED");
  assert.equal(result.authorization?.reason, "capability-denied");
});

test("allows an admitted human and composes work and runtime presence through one API", async () => {
  const result = await api().execute(request());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.authorization.allowed, true);
  assert.equal(result.data.work?.kind, "endpoint-work");
  assert.equal(result.data.presence?.state, "unavailable");
  assert.equal(result.data.unavailable.length, 0);
});

test("denies cross-repository requests even when the human is authenticated", async () => {
  const result = await api().execute(
    request({
      repository: { ...repository, repositoryId: "999999999", nameWithOwner: "other/repository" },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ENDPOINT_API_AUTHORIZATION_DENIED");
  assert.equal(result.authorization?.reason, "repository-mismatch");
});

test("exposes stale work and unavailable presence instead of treating them as empty", async () => {
  const stale = applyEndpointAuthoritativeSnapshot(
    createEndpointObservation({ key: "github.com/1330755860" }),
    { value: { repository }, revision: "1", observedAt: "2026-09-20T00:00:00.000Z" },
    { now: "2026-09-22T00:00:00.000Z", maxAgeMs: 1_000 },
  );
  const result = await api({
    readWork: async () => ({ ...workInput(), freshness: stale }),
    readPresence: async () => ({ status: "unavailable", diagnostics: [] as const }),
  }).execute(request());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.work?.freshness.state, "stale");
  assert.equal(result.data.unavailable[0]?.resource, "presence");
});

test("fails closed for unsupported operations", async () => {
  const result = await api().execute(request({ operation: "change.merge" }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ENDPOINT_API_UNSUPPORTED_OPERATION");
});
