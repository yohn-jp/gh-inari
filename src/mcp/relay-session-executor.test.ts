import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeSessionCertificateCompact } from "../agent-authority/session-certificate.js";
import type { RelayEnvelope, RelayRepositoryIdentity } from "../relay/contract.js";
import { createRelayBackedSessionExecutor, type RepositoryRelayDispatchRequest } from "./relay-session-executor.js";

const repository: RelayRepositoryIdentity = {
  repositoryHost: "github.com",
  repositoryId: "123456789",
  repositoryNameWithOwner: "acme/inari",
};
const certificate = encodeSessionCertificateCompact(
  { alg: "EdDSA", typ: "inari-session+jwt", kid: "runtime-relay" },
  {
    ver: 1,
    iss: "runtime:runtime-relay",
    sub: "session:relay-test",
    jti: "certificate-relay-test",
    repository: { id: repository.repositoryId, name: "acme/inari" },
    sessionKey: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
    capabilities: [{ kind: "change.implement", issue: 821 }],
    iat: 1_800_000_000,
    nbf: 1_800_000_000,
    exp: 1_800_000_060,
  },
  Buffer.alloc(64).toString("base64url"),
);

function sessionEnvelope(repositoryId = repository.repositoryId): Record<string, unknown> {
  return {
    version: 1,
    alg: "EdDSA",
    certificate,
    request: { version: 1, issue: 821 },
    certificateJti: "certificate-relay-test",
    repositoryId,
    operation: "change.issue",
    requestId: "relay-test-request",
    issuedAt: 1_800_000_000,
    expiresAt: 1_800_000_060,
    signature: "A".repeat(86),
  };
}

function resultEnvelope(
  payload: unknown,
  deliveryState: "terminal-result" | "delivered-ambiguous" = "terminal-result",
): RelayEnvelope {
  if (deliveryState === "delivered-ambiguous") {
    return {
      version: 1 as const,
      kind: "control" as const,
      repository,
      connectionId: "connection-1",
      jobId: "job-1",
      deliveryState,
      deliveryCertainty: deliveryState,
    };
  }
  return {
    version: 1 as const,
    kind: "result" as const,
    repository,
    connectionId: "connection-1",
    jobId: "job-1",
    deliveryState: "terminal-result" as const,
    resultPayload: Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
  };
}

test("forwards the original Session envelope and returns the Runtime result", async () => {
  const envelope = sessionEnvelope();
  let captured: RepositoryRelayDispatchRequest | undefined;
  const executor = createRelayBackedSessionExecutor({
    repository,
    dispatch: {
      async dispatch(request) {
        captured = request;
        return resultEnvelope({ version: 1, operation: "change.issue", status: "succeeded" });
      },
    },
    expectedCertificateSigner: "runtime-relay",
  });

  const result = await executor.execute(envelope);
  assert.equal(result.status, "succeeded");
  assert.equal(captured?.envelope, envelope);
  assert.equal(captured?.signedSessionEnvelope, envelope);
  assert.equal(captured?.repository.repositoryId, repository.repositoryId);
  assert.equal(captured?.certificateSigner, "runtime-relay");
});

test("does not authorize or retry an ambiguous delivery", async () => {
  let calls = 0;
  const executor = createRelayBackedSessionExecutor({
    repository,
    dispatch: {
      async dispatch(): Promise<RelayEnvelope> {
        calls += 1;
        return resultEnvelope({}, "delivered-ambiguous");
      },
    },
  });

  const result = await executor.execute(sessionEnvelope());
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.relayCode, "RELAY_SESSION_AMBIGUOUS_DELIVERY");
  assert.equal(result.failure?.phase, "recovery-required");
  assert.equal(calls, 1);
});

test("bounds repository and signer routing before dispatch", async () => {
  let calls = 0;
  const executor = createRelayBackedSessionExecutor({
    repository,
    expectedCertificateSigner: "runtime-relay",
    dispatch: {
      async dispatch(): Promise<RelayEnvelope> {
        calls += 1;
        throw new Error("must not dispatch");
      },
    },
  });
  const wrongRepository = await executor.execute(sessionEnvelope("987654321"));
  assert.equal(wrongRepository.failure?.relayCode, "RELAY_SESSION_REPOSITORY_MISMATCH");
  assert.equal(calls, 0);
});

test("maps unavailable, timeout, and malformed Runtime results to bounded failures", async () => {
  const unavailable = createRelayBackedSessionExecutor({
    repository,
    dispatch: {
      async dispatch(): Promise<RelayEnvelope> {
        return {
          version: 1,
          kind: "control",
          repository,
          connectionId: "c",
          jobId: "j",
          deliveryState: "unavailable",
          deliveryCertainty: "not-delivered",
        };
      },
    },
  });
  assert.equal((await unavailable.execute(sessionEnvelope())).failure?.relayCode, "RELAY_SESSION_UNAVAILABLE");

  const malformed = createRelayBackedSessionExecutor({
    repository,
    dispatch: {
      async dispatch() {
        return resultEnvelope({ version: 1, status: "succeeded", token: "secret" });
      },
    },
  });
  assert.equal((await malformed.execute(sessionEnvelope())).failure?.relayCode, "RELAY_SESSION_MALFORMED_RESULT");

  const timeout = createRelayBackedSessionExecutor({
    repository,
    timeoutMs: 1,
    dispatch: {
      async dispatch() {
        dispatchStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return resultEnvelope({ version: 1, status: "succeeded" });
      },
    },
  });
  let dispatchStarted = false;
  const timeoutResult = await timeout.execute(sessionEnvelope());
  assert.equal(dispatchStarted, true);
  assert.equal(timeoutResult.failure?.relayCode, "RELAY_SESSION_AMBIGUOUS_DELIVERY");
  assert.equal(timeoutResult.failure?.phase, "recovery-required");
});
