import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENDPOINT_RUNTIME_PRESENCE_CONTRACT_VERSION,
  projectEndpointRuntimePresence,
  type EndpointRuntimePresenceInput,
} from "./endpoint-runtime-presence.js";
import type { RelayRuntimePresenceRecord, RelayRuntimePresenceSnapshot } from "./relay/cloudflare-repository-relay.js";

const endpoint = {
  version: 1 as const,
  kind: "endpoint" as const,
  id: "endpoint-921",
  deployment: "self-hosted" as const,
};
const repository = {
  version: 1 as const,
  kind: "repository" as const,
  endpointId: endpoint.id,
  installationId: "installation-921",
  repositoryHost: "github.com",
  repositoryId: "1330755860",
  nameWithOwner: "yohn-jp/gh-inari",
};

function record(overrides: Partial<RelayRuntimePresenceRecord> = {}): RelayRuntimePresenceRecord {
  return {
    version: 1,
    repository: { repositoryHost: repository.repositoryHost, repositoryId: repository.repositoryId },
    connectionId: "runtime-921",
    delegatorId: "delegator-921",
    generation: 1,
    state: "connected",
    authenticated: true,
    current: true,
    openedAtMs: 900,
    expiresAtMs: 10_000,
    observedAtMs: 1_000,
    ...overrides,
  };
}

function snapshot(
  records: readonly RelayRuntimePresenceRecord[],
  overrides: Partial<RelayRuntimePresenceSnapshot> = {},
) {
  return {
    version: ENDPOINT_RUNTIME_PRESENCE_CONTRACT_VERSION,
    repository: { repositoryHost: repository.repositoryHost, repositoryId: repository.repositoryId },
    availability: "available" as const,
    observedAtMs: 1_000,
    records,
    ...overrides,
  };
}

function input(relay: RelayRuntimePresenceSnapshot): EndpointRuntimePresenceInput {
  return { endpoint, repository, relay, now: 1_000, maxAgeMs: 100 };
}

test("projects a fresh current generation as connected", () => {
  const result = projectEndpointRuntimePresence(input(snapshot([record()])));
  assert.equal(result.state, "connected");
  assert.equal(result.freshness.state, "fresh");
  assert.equal(result.authoritative, false);
  assert.deepEqual(result.runtime, {
    connectionId: "runtime-921",
    delegatorId: "delegator-921",
    generation: 1,
    current: true,
  });
});

test("projects old evidence and replaced generations as stale", () => {
  const result = projectEndpointRuntimePresence(
    input(snapshot([record({ state: "stale", current: false, observedAtMs: 800 })])),
  );
  assert.equal(result.state, "stale");
  assert.equal(result.freshness.state, "stale");
  assert.equal(result.runtime?.current, false);
});

test("projects an admitted reconnect attempt as reconnecting", () => {
  const result = projectEndpointRuntimePresence(
    input(snapshot([record({ generation: undefined, state: "reconnecting", authenticated: false, current: false })])),
  );
  assert.equal(result.state, "reconnecting");
  assert.equal(result.freshness.state, "fresh");
});

test("projects a readable relay with no matching Runtime as unavailable", () => {
  const result = projectEndpointRuntimePresence(input(snapshot([])));
  assert.equal(result.state, "unavailable");
  assert.equal(result.freshness.state, "fresh");
  assert.equal(result.runtime, null);
});

test("projects unavailable or ambiguous relay evidence as unknown", () => {
  const unavailable = projectEndpointRuntimePresence(input(snapshot([], { availability: "unknown" })));
  assert.equal(unavailable.state, "unknown");
  assert.equal(unavailable.freshness.state, "unknown");

  const ambiguous = projectEndpointRuntimePresence(
    input(snapshot([record(), record({ connectionId: "runtime-other" })])),
  );
  assert.equal(ambiguous.state, "unknown");
  assert.equal(ambiguous.diagnostics[0]?.code, "ENDPOINT_RUNTIME_PRESENCE_AMBIGUOUS");
});

test("immutable repository mismatches never become presence", () => {
  const result = projectEndpointRuntimePresence(
    input(
      snapshot([record()], {
        repository: { repositoryHost: "github.com", repositoryId: "999999999" },
      }),
    ),
  );
  assert.equal(result.state, "unknown");
  assert.equal(result.diagnostics[0]?.code, "ENDPOINT_RUNTIME_PRESENCE_REPOSITORY_MISMATCH");
});
