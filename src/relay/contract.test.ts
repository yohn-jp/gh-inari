import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RELAY_DEADLINE_MS,
  MAX_RELAY_ENVELOPE_BYTES,
  MAX_RELAY_IN_FLIGHT_JOBS,
  MAX_RELAY_OPAQUE_PAYLOAD_BYTES,
  RELAY_DELIVERY_STATES,
  RelayContractError,
  decodeRelayEnvelope,
  encodeRelayEnvelope,
  normalizeRelayEnvelope,
  normalizeRelayRepositoryIdentity,
  relayRepositoriesMatch,
  serializeRelayEnvelope,
  validateRelayEnvelope,
} from "./contract.js";

const repository = {
  repositoryHost: "GITHUB.COM",
  repositoryId: "815000001",
  repositoryNameWithOwner: "yohn-jp/gh-inari",
} as const;

const job = {
  kind: "job",
  version: 1,
  repository,
  connectionId: "connection-815",
  jobId: "job-1",
  deliveryState: "pre-delivery",
  deadlineMs: 10_000,
  signedSessionRequest: "eyJ2ZXJzaW9uIjoxfQ",
} as const;

function errorOf(action: () => unknown): RelayContractError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RelayContractError);
    return error;
  }
  assert.fail("expected RelayContractError");
}

test("repository identity is canonical and binds to host plus immutable repositoryId", () => {
  const normalized = normalizeRelayRepositoryIdentity(repository);
  assert.deepEqual(normalized, {
    repositoryId: "815000001",
    repositoryHost: "github.com",
    repositoryNameWithOwner: "yohn-jp/gh-inari",
  });
  assert.equal(relayRepositoriesMatch(repository, { ...repository, repositoryNameWithOwner: "renamed/relay" }), true);
  assert.equal(relayRepositoriesMatch(repository, { ...repository, repositoryHost: "ghe.example.com" }), false);
  assert.throws(
    () => normalizeRelayRepositoryIdentity({ repositoryHost: "github.com", repositoryNameWithOwner: "owner/repo" }),
    (error: unknown) => error instanceof RelayContractError && error.code === "RELAY_MISSING_FIELD",
  );
});

test("envelopes normalize and encode deterministically without interpreting the signed request", () => {
  const reordered = {
    signedSessionRequest: job.signedSessionRequest,
    deadlineMs: job.deadlineMs,
    jobId: job.jobId,
    connectionId: job.connectionId,
    repository: job.repository,
    version: job.version,
    kind: job.kind,
    deliveryState: job.deliveryState,
  };
  const first = encodeRelayEnvelope(job, repository);
  const second = encodeRelayEnvelope(reordered, repository);
  assert.deepEqual(first, second);
  assert.deepEqual(decodeRelayEnvelope(first, repository), normalizeRelayEnvelope(job));
  assert.equal(Object.isFrozen(normalizeRelayEnvelope(job)), true);
  assert.equal(serializeRelayEnvelope(job), new TextDecoder().decode(first));
});

test("byte, count, and deadline ceilings are hard and closed", () => {
  const connection = {
    version: 1,
    kind: "connection",
    repository,
    connectionId: "connection-815",
    maxInFlightJobs: MAX_RELAY_IN_FLIGHT_JOBS,
    deadlineMs: MAX_RELAY_DEADLINE_MS,
  } as const;
  const normalizedConnection = normalizeRelayEnvelope(connection);
  assert.equal(normalizedConnection.kind, "connection");
  if (normalizedConnection.kind === "connection") {
    assert.equal(normalizedConnection.maxInFlightJobs, MAX_RELAY_IN_FLIGHT_JOBS);
    assert.equal(normalizedConnection.deadlineMs, MAX_RELAY_DEADLINE_MS);
  }
  assert.equal(validateRelayEnvelope({ ...connection, maxInFlightJobs: MAX_RELAY_IN_FLIGHT_JOBS + 1 }).valid, false);
  assert.equal(validateRelayEnvelope({ ...job, deadlineMs: MAX_RELAY_DEADLINE_MS + 1 }).valid, false);
  assert.equal(validateRelayEnvelope({ ...job, extra: true }).valid, false);
  assert.equal(validateRelayEnvelope("x".repeat(MAX_RELAY_ENVELOPE_BYTES + 1)).valid, false);

  const exactPayload = Buffer.alloc(MAX_RELAY_OPAQUE_PAYLOAD_BYTES).toString("base64url");
  assert.equal(normalizeRelayEnvelope({ ...job, signedSessionRequest: exactPayload }).kind, "job");
  const oversizedPayload = Buffer.alloc(MAX_RELAY_OPAQUE_PAYLOAD_BYTES + 1).toString("base64url");
  assert.equal(validateRelayEnvelope({ ...job, signedSessionRequest: oversizedPayload }).valid, false);
  assert.equal(validateRelayEnvelope({ ...job, signedSessionRequest: "AB" }).valid, false);
});

test("malformed, unknown-version, duplicate-field, and unsafe-text inputs fail deterministically", () => {
  assert.equal(errorOf(() => decodeRelayEnvelope("{")).code, "RELAY_MALFORMED_JSON");
  assert.equal(errorOf(() => normalizeRelayEnvelope({ ...job, version: 2 })).code, "RELAY_UNSUPPORTED_VERSION");
  const duplicate = `{"version":1,"version":1,"kind":"job"}`;
  assert.equal(errorOf(() => decodeRelayEnvelope(duplicate)).code, "RELAY_DUPLICATE_FIELD");
  const nestedDuplicate =
    '{"version":1,"kind":"job","repository":{"repositoryHost":"github.com","repositoryId":"1","repositoryId":"2"},"connectionId":"connection-815","jobId":"job-1","deliveryState":"pre-delivery","deadlineMs":1,"signedSessionRequest":"AQ"}';
  assert.equal(errorOf(() => decodeRelayEnvelope(nestedDuplicate)).code, "RELAY_DUPLICATE_FIELD");
  const unsafe = { ...job, repository: { ...repository, repositoryNameWithOwner: "owner\nrepo" } };
  assert.equal(errorOf(() => normalizeRelayEnvelope(unsafe)).code, "RELAY_INVALID_TEXT");
  const forbidden = { ...job, privateKey: "not-accepted" };
  assert.equal(errorOf(() => normalizeRelayEnvelope(forbidden)).code, "RELAY_FORBIDDEN_FIELD");
  const nestedForbidden = { ...job, repository: { ...repository, privateKey: "not-accepted" } };
  assert.equal(errorOf(() => normalizeRelayEnvelope(nestedForbidden)).code, "RELAY_FORBIDDEN_FIELD");
});

test("cross-repository envelopes and semantic success fields are rejected", () => {
  const crossRepository = errorOf(() => normalizeRelayEnvelope(job, { ...repository, repositoryId: "815000002" }));
  assert.equal(crossRepository.code, "RELAY_CROSS_REPOSITORY");
  const crossHost = errorOf(() => normalizeRelayEnvelope(job, { ...repository, repositoryHost: "ghe.example.com" }));
  assert.equal(crossHost.code, "RELAY_CROSS_REPOSITORY");
  const result = {
    version: 1,
    kind: "result",
    repository,
    connectionId: "connection-815",
    jobId: "job-1",
    deliveryState: "terminal-result",
    resultPayload: "",
  } as const;
  const normalizedResult = normalizeRelayEnvelope(result);
  assert.equal(normalizedResult.kind, "result");
  if (normalizedResult.kind === "result") assert.equal(normalizedResult.deliveryState, "terminal-result");
  for (const state of RELAY_DELIVERY_STATES) {
    if (state === "terminal-result") continue;
    const candidate = { ...result, deliveryState: state };
    assert.equal(validateRelayEnvelope(candidate).valid, false);
  }
  const control = {
    version: result.version,
    kind: "control",
    repository: result.repository,
    connectionId: result.connectionId,
    jobId: result.jobId,
    deliveryState: "unavailable",
    deliveryCertainty: "not-delivered",
  } as const;
  const normalizedControl = normalizeRelayEnvelope(control);
  assert.equal(normalizedControl.kind, "control");
  if (normalizedControl.kind === "control") {
    assert.equal(normalizedControl.deliveryState, "unavailable");
    assert.equal(normalizedControl.deliveryCertainty, "not-delivered");
  }
  const ambiguousExpiry = { ...control, deliveryState: "expired", deliveryCertainty: "delivered-ambiguous" } as const;
  const normalizedAmbiguousExpiry = normalizeRelayEnvelope(ambiguousExpiry);
  assert.equal(normalizedAmbiguousExpiry.kind, "control");
  if (normalizedAmbiguousExpiry.kind === "control") {
    assert.equal(normalizedAmbiguousExpiry.deliveryState, "expired");
    assert.equal(normalizedAmbiguousExpiry.deliveryCertainty, "delivered-ambiguous");
  }
  assert.equal(
    validateRelayEnvelope({ ...control, deliveryState: "delivered-ambiguous", deliveryCertainty: "not-delivered" })
      .valid,
    false,
  );
  assert.equal(validateRelayEnvelope({ ...result, status: "success" }).valid, false);
});
