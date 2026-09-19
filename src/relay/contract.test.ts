import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RELAY_DEADLINE_MS,
  MAX_RELAY_ENVELOPE_BYTES,
  MAX_RELAY_IN_FLIGHT_JOBS,
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

test("repository identity is canonical and binds only to immutable repositoryId", () => {
  const normalized = normalizeRelayRepositoryIdentity(repository);
  assert.deepEqual(normalized, {
    repositoryId: "815000001",
    repositoryHost: "github.com",
    repositoryNameWithOwner: "yohn-jp/gh-inari",
  });
  assert.equal(relayRepositoriesMatch(repository, { ...repository, repositoryNameWithOwner: "renamed/relay" }), true);
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
  const first = encodeRelayEnvelope(job, repository.repositoryId);
  const second = encodeRelayEnvelope(reordered, repository.repositoryId);
  assert.deepEqual(first, second);
  assert.deepEqual(decodeRelayEnvelope(first, repository.repositoryId), normalizeRelayEnvelope(job));
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
});

test("malformed, unknown-version, duplicate-field, and unsafe-text inputs fail deterministically", () => {
  assert.equal(errorOf(() => decodeRelayEnvelope("{")).code, "RELAY_MALFORMED_JSON");
  assert.equal(errorOf(() => normalizeRelayEnvelope({ ...job, version: 2 })).code, "RELAY_UNSUPPORTED_VERSION");
  const duplicate = `{"version":1,"version":1,"kind":"job"}`;
  assert.equal(errorOf(() => decodeRelayEnvelope(duplicate)).code, "RELAY_DUPLICATE_FIELD");
  const unsafe = { ...job, repository: { ...repository, repositoryNameWithOwner: "owner\nrepo" } };
  assert.equal(errorOf(() => normalizeRelayEnvelope(unsafe)).code, "RELAY_INVALID_TEXT");
  const forbidden = { ...job, privateKey: "not-accepted" };
  assert.equal(errorOf(() => normalizeRelayEnvelope(forbidden)).code, "RELAY_FORBIDDEN_FIELD");
});

test("cross-repository envelopes and semantic success fields are rejected", () => {
  const crossRepository = errorOf(() => normalizeRelayEnvelope(job, "815000002"));
  assert.equal(crossRepository.code, "RELAY_CROSS_REPOSITORY");
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
  } as const;
  const normalizedControl = normalizeRelayEnvelope(control);
  assert.equal(normalizedControl.kind, "control");
  if (normalizedControl.kind === "control") assert.equal(normalizedControl.deliveryState, "unavailable");
  assert.equal(validateRelayEnvelope({ ...result, status: "success" }).valid, false);
});
