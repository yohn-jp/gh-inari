import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { test } from "node:test";
import {
  createRelayPossessionProofChallenge,
  encodeRelayPossessionProofChallenge,
  decodeRelayPossessionProofResponse,
} from "./connection-proof.js";
import { decodeRelayEnvelope, encodeRelayEnvelope, type RelayRepositoryIdentity } from "./contract.js";
import { LocalRelayRuntime, type RelayWebSocket, type RelayWebSocketFactory } from "./local-runtime.js";

const repository: RelayRepositoryIdentity = {
  repositoryHost: "github.com",
  repositoryId: "1330755860",
  repositoryNameWithOwner: "yohn-jp/gh-inari",
};

class FakeWebSocket implements RelayWebSocket {
  readonly frames: string[] = [];
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void {
    this.frames.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(data: string): void {
    this.onmessage?.({ data });
  }

  disconnect(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function socketFactory(sockets: FakeWebSocket[]): RelayWebSocketFactory {
  return () => {
    const socket = new FakeWebSocket();
    sockets.push(socket);
    return socket;
  };
}

function keyPair(): { readonly privateKey: KeyObject; readonly publicKey: KeyObject } {
  return generateKeyPairSync("ed25519");
}

function signedSessionEnvelope(): string {
  return Buffer.from(JSON.stringify({ certificate: "canonical", request: { version: 1, issue: 820 } })).toString(
    "base64url",
  );
}

function challenge(): string {
  const challenge = createRelayPossessionProofChallenge({
    repositoryId: repository.repositoryId,
    delegatorId: "runtime-820",
    nonce: "bm9uY2UtODIw",
    issuedAtMs: 10_000,
    expiresAtMs: 20_000,
  });
  return JSON.stringify({
    type: "repository-relay-possession-challenge",
    version: 1,
    repository,
    connectionId: "connection-820",
    challenge: JSON.parse(new TextDecoder().decode(encodeRelayPossessionProofChallenge(challenge))),
  });
}

function connected(connectionId = "connection-820"): string {
  return JSON.stringify({
    type: "repository-relay-connected",
    version: 1,
    repository,
    connectionId,
  });
}

function job(connectionId: string, jobId = "job-820") {
  return JSON.stringify({
    version: 1,
    kind: "job",
    repository,
    connectionId,
    jobId,
    deliveryState: "pre-delivery",
    deadlineMs: 30_000,
    signedSessionRequest: signedSessionEnvelope(),
  });
}

test("opens only an outbound socket, proves possession, forwards the unchanged Session envelope, and returns a result", async () => {
  const sockets: FakeWebSocket[] = [];
  const pair = keyPair();
  let received: unknown;
  const runtime = new LocalRelayRuntime({
    relayUrl: "wss://relay.example.test/repository",
    repository,
    delegatorId: "runtime-820",
    privateKey: pair.privateKey,
    executor: {
      async execute(envelope) {
        received = envelope;
        return { version: 1, status: "succeeded" };
      },
    },
    webSocketFactory: socketFactory(sockets),
    now: () => 15_000,
    connectionId: "connection-820",
  });

  runtime.connect();
  assert.equal(sockets.length, 1);
  const socket = sockets[0]!;
  socket.open();
  assert.equal(socket.frames.length, 0);
  socket.receive(challenge());
  const handshake = JSON.parse(socket.frames[0]!) as { readonly proof: unknown; readonly type: string };
  assert.equal(handshake.type, "repository-relay-possession-response");
  const proof = decodeRelayPossessionProofResponse(JSON.stringify(handshake.proof));
  assert.equal(proof.challenge.delegatorId, "runtime-820");
  assert.equal(
    socket.frames.some((frame) => frame.includes("BEGIN PRIVATE KEY")),
    false,
  );
  assert.equal(runtime.snapshot().possessionProved, false);
  socket.receive(
    JSON.stringify({
      type: "repository-relay-connected",
      version: 1,
      repository,
      connectionId: "connection-other",
    }),
  );
  assert.equal(runtime.snapshot().possessionProved, false);
  socket.receive(
    JSON.stringify({
      type: "repository-relay-connected",
      version: 1,
      repository: { ...repository, repositoryId: "1330755861" },
      connectionId: "connection-820",
    }),
  );
  assert.equal(runtime.snapshot().possessionProved, false);
  socket.receive(connected());
  assert.equal(runtime.snapshot().possessionProved, true);

  socket.receive(job("connection-820"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(received, { certificate: "canonical", request: { version: 1, issue: 820 } });
  const result = decodeRelayEnvelope(socket.frames[1]!, repository);
  assert.equal(result.kind, "result");
  assert.equal(runtime.delivery("job-820")?.phase, "delivered");
  runtime.shutdown();
});

test("disconnect marks delivery ambiguous and reconnect never executes the same job twice", async () => {
  const sockets: FakeWebSocket[] = [];
  const pair = keyPair();
  let executions = 0;
  const runtime = new LocalRelayRuntime({
    relayUrl: "wss://relay.example.test/repository",
    repository,
    delegatorId: "runtime-820",
    privateKey: pair.privateKey,
    executor: {
      async execute() {
        executions += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
        return { version: 1, status: "succeeded" };
      },
    },
    webSocketFactory: socketFactory(sockets),
    now: () => 15_000,
    connectionId: "connection-820",
    reconnectDelayMs: 0,
  });
  runtime.connect();
  const first = sockets[0]!;
  first.open();
  first.receive(challenge());
  first.receive(connected());
  first.receive(job("connection-820", "job-ambiguous"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(first.frames.length, 2);
  first.disconnect();
  assert.equal(runtime.delivery("job-ambiguous")?.phase, "possibly-delivered");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(executions, 1);
  const second = sockets[1]!;
  second.open();
  second.receive(challenge());
  second.receive(connected());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(second.frames.length, 2);
  assert.equal(decodeRelayEnvelope(second.frames[1]!, repository).kind, "result");
  runtime.shutdown();
});
