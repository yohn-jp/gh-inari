import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
  authorizeEndpoint,
  validateEndpointAuthorizationRequest,
  type EndpointAuthorizationRequest,
} from "./endpoint-authorization.js";

const endpoint = {
  version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
  kind: "endpoint",
  id: "shared-prod",
  deployment: "shared-hosted",
} as const;
const installation = {
  version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
  kind: "installation",
  endpointId: endpoint.id,
  installationId: "9001",
} as const;
const repository = {
  version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
  kind: "repository",
  endpointId: endpoint.id,
  installationId: installation.installationId,
  repositoryHost: "github.com",
  repositoryId: "1330755860",
  nameWithOwner: "yohn-jp/gh-inari",
} as const;
const principal = {
  version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
  kind: "runtime/client",
  id: "runtime-test",
} as const;
const capability = { kind: "change.implement", issue: 917 } as const;

function request(overrides: Partial<EndpointAuthorizationRequest> = {}): EndpointAuthorizationRequest {
  return {
    version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
    principal,
    endpoint,
    installation,
    repository,
    capability,
    evidence: {
      version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
      authenticated: true,
      principal,
      endpoint,
      installation,
      repository,
      capabilities: [capability],
    },
    ...overrides,
  };
}

test("allows an explicitly admitted capability in the exact endpoint context", () => {
  const result = authorizeEndpoint(request());
  assert.equal(result.allowed, true);
  assert.equal(result.decision, "allow");
  assert.deepEqual(result.diagnostics, []);
});

test("denies a capability that authenticated evidence did not admit", () => {
  const result = authorizeEndpoint(request({ capability: { kind: "change.ready", issue: 917 } }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "capability-denied");
  assert.equal(result.diagnostics[0]?.code, "ENDPOINT_AUTHORIZATION_CAPABILITY_DENIED");
});

test("denies cross-endpoint evidence even when the repository ID is unchanged", () => {
  const otherEndpoint = { ...endpoint, id: "self-hosted-prod", deployment: "self-hosted" as const };
  const result = authorizeEndpoint(
    request({
      evidence: {
        version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
        authenticated: true,
        principal,
        endpoint: otherEndpoint,
        installation: { ...installation, endpointId: otherEndpoint.id },
        repository: { ...repository, endpointId: otherEndpoint.id },
        capabilities: [capability],
      },
    }),
  );
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "endpoint-mismatch");
});

test("principal classes remain non-interchangeable", () => {
  const result = authorizeEndpoint(
    request({
      principal: { ...principal, kind: "human", id: principal.id },
    }),
  );
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "principal-mismatch");
});

test("rejects malformed, unknown, and missing capability evidence", () => {
  const malformed = validateEndpointAuthorizationRequest({ ...request(), extra: true });
  assert.equal(malformed.valid, false);
  assert.equal(malformed.diagnostics[0]?.code, "ENDPOINT_AUTHORIZATION_UNKNOWN_PROPERTY");

  const unknown = authorizeEndpoint(request({ capability: { kind: "repository.admin" } as never }));
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.reason, "invalid-evidence");

  const unauthenticated = authorizeEndpoint(
    request({ evidence: { ...request().evidence, authenticated: false } as never }),
  );
  assert.equal(unauthenticated.allowed, false);
  assert.equal(unauthenticated.reason, "unauthenticated");
});
