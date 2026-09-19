import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicKey, generateKeyPairSync, sign as ed25519Sign, type KeyObject } from "node:crypto";
import {
  RepositoryRelayDurableObject,
  repositoryRelayDurableObjectName,
  type RepositoryRelayDurableObjectState,
  type RepositoryRelayWebSocket,
} from "./cloudflare-repository-relay.js";
import {
  createRelayPossessionProofChallenge,
  signRelayPossessionProof,
  encodeRelayPossessionProofResponse,
  type RelayPossessionProofChallenge,
} from "./connection-proof.js";
import { encodeRelayEnvelope } from "./contract.js";
import {
  SESSION_CERTIFICATE_ALG,
  SESSION_CERTIFICATE_CONTRACT_VERSION,
  SESSION_CERTIFICATE_TYP,
  encodeSessionCertificateCompact,
  sessionCertificateSigningInput,
  type SessionCertificateHeader,
  type SessionCertificatePayload,
} from "../agent-authority/session-certificate.js";

const repository = { repositoryHost: "github.com", repositoryId: "1330755860" } as const;
const encoder = new TextEncoder();

class FakeSocket implements RepositoryRelayWebSocket {
  readyState = 1;
  readonly sent: (string | Uint8Array)[] = [];
  attachment: unknown;

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(
      typeof data === "string"
        ? data
        : new Uint8Array(
            data instanceof ArrayBuffer ? data : data.buffer,
            data instanceof ArrayBuffer ? 0 : data.byteOffset,
            data instanceof ArrayBuffer ? data.byteLength : data.byteLength,
          ),
    );
  }

  close(): void {
    this.readyState = 3;
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }
}

class FakeWebSocketPair {
  readonly 0 = new FakeSocket();
  readonly 1 = new FakeSocket();
  [Symbol.iterator](): Iterator<FakeSocket> {
    return [this[0], this[1]][Symbol.iterator]();
  }
}

(globalThis as unknown as { WebSocketPair: typeof FakeWebSocketPair }).WebSocketPair = FakeWebSocketPair;

class FakeStorage {
  readonly values = new Map<string, unknown>();
  failNextPut = false;
  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("simulated storage failure");
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
  async list<T>(options?: { readonly prefix?: string; readonly limit?: number }): Promise<Map<string, T>> {
    const output = new Map<string, T>();
    for (const [key, value] of this.values) {
      if (options?.prefix !== undefined && !key.startsWith(options.prefix)) continue;
      output.set(key, value as T);
      if (output.size >= (options?.limit ?? Number.POSITIVE_INFINITY)) break;
    }
    return output;
  }
  async setAlarm(): Promise<void> {}
}

class FakeState implements RepositoryRelayDurableObjectState {
  readonly storage = new FakeStorage();
  readonly sockets: FakeSocket[] = [];
  autoResponse: unknown;
  acceptWebSocket(socket: FakeSocket): void {
    this.sockets.push(socket);
  }
  getWebSockets(tag?: string): FakeSocket[] {
    if (tag === "runtime")
      return this.sockets.filter((socket) => (socket.attachment as { role?: string } | undefined)?.role === "runtime");
    if (tag === "client")
      return this.sockets.filter((socket) => (socket.attachment as { role?: string } | undefined)?.role === "client");
    return this.sockets;
  }
  setWebSocketAutoResponse(pair: unknown): void {
    this.autoResponse = pair;
  }
}

function pairFor(object: RepositoryRelayDurableObject, query: string): FakeSocket {
  const socket = new FakeSocket();
  const state = (object as unknown as { state: FakeState }).state;
  state.acceptWebSocket(socket);
  const url = new URL(
    `https://relay.test/?repositoryId=${repository.repositoryId}&repositoryHost=${repository.repositoryHost}&${query}`,
  );
  void object.fetch(new Request(url, { headers: { Upgrade: "websocket" } }));
  return state.sockets.at(-1) as FakeSocket;
}

function publicJwk(key: KeyObject): Record<string, string> {
  return key.export({ format: "jwk" }) as Record<string, string>;
}

function signedSessionRequest(
  signer: KeyObject,
  certificateSigner: KeyObject = signer,
  delegatorId = "delegator-819",
): string {
  const header: SessionCertificateHeader = {
    alg: SESSION_CERTIFICATE_ALG,
    typ: SESSION_CERTIFICATE_TYP,
    kid: delegatorId,
  };
  const payload: SessionCertificatePayload = {
    ver: SESSION_CERTIFICATE_CONTRACT_VERSION,
    iss: `runtime:${delegatorId}`,
    sub: "session:01HXRELAY81900000000000000",
    jti: "01HXRELAY81900000000000001",
    repository: { id: repository.repositoryId, name: "yohn-jp/gh-inari" },
    sessionKey: publicJwk(createPublicKey(signer)) as unknown as SessionCertificatePayload["sessionKey"],
    task: { kind: "issue", number: 819 },
    capabilities: [{ kind: "change.implement", issue: 819 }],
    iat: 1_757_347_200,
    nbf: 1_757_347_200,
    exp: 1_757_354_400,
  };
  const { signingInput } = sessionCertificateSigningInput(header, payload);
  const certificateSignature = ed25519Sign(null, Buffer.from(signingInput), certificateSigner).toString("base64url");
  const certificate = encodeSessionCertificateCompact(header, payload, certificateSignature);
  return Buffer.from(
    JSON.stringify({
      version: 1,
      alg: "EdDSA",
      certificate,
      request: { kind: "relay" },
      certificateJti: payload.jti,
      repositoryId: repository.repositoryId,
      operation: "relay.execute",
      requestId: "request-819",
      issuedAt: 1_757_347_201,
      expiresAt: 1_757_347_301,
      signature: Buffer.alloc(64).toString("base64url"),
    }),
  ).toString("base64url");
}

test("uses one deterministic DO name per immutable repository id", () => {
  assert.equal(repositoryRelayDurableObjectName(repository), repository.repositoryId);
});

test("connection quota is fail-closed and is not an authorization result", async () => {
  const state = new FakeState();
  const object = new RepositoryRelayDurableObject(state, { repository }, { limits: { maxConnections: 1 } });
  const first = await object.fetch(
    new Request("https://relay.test/?repositoryId=1330755860&role=client&connectionId=client-1", {
      headers: { Upgrade: "websocket" },
    }),
  );
  const second = await object.fetch(
    new Request("https://relay.test/?repositoryId=1330755860&role=client&connectionId=client-2", {
      headers: { Upgrade: "websocket" },
    }),
  );
  assert.equal(first.status, 101);
  assert.equal(second.status, 503);
  assert.notEqual(second.status, 401);
});

test("runtime admission stores only bounded public attachment metadata and configures heartbeat", async () => {
  const state = new FakeState();
  const object = new RepositoryRelayDurableObject(
    state,
    { repository },
    { now: () => 10_000, randomNonce: () => "nonce-819" },
  );
  const socket = pairFor(object, "role=runtime&connectionId=runtime-1&delegatorId=delegator-1");
  await new Promise((resolve) => setImmediate(resolve));
  const challenge = (socket.attachment as { challenge: RelayPossessionProofChallenge }).challenge;
  const { privateKey } = generateKeyPairSync("ed25519");
  const response = signRelayPossessionProof(challenge, privateKey);
  await object.webSocketMessage(
    socket,
    JSON.stringify({
      type: "repository-relay-possession-response",
      proof: JSON.parse(new TextDecoder().decode(encodeRelayPossessionProofResponse(response))),
    }),
  );
  const attachment = socket.attachment as Record<string, unknown>;
  assert.equal(attachment.authenticated, true);
  assert.equal("privateKey" in attachment, false);
  assert.deepEqual(state.autoResponse, { request: "relay:ping", response: "relay:pong" });
  assert.equal((attachment.binding as { publicKey: unknown }).publicKey !== undefined, true);
  assert.deepEqual(publicJwk(privateKey).kty, "OKP");
});

test("message rate backpressure closes the connection before parsing a second message", async () => {
  const state = new FakeState();
  const object = new RepositoryRelayDurableObject(
    state,
    { repository },
    { now: () => 10_000, randomNonce: () => "nonce-rate", limits: { maxMessagesPerWindow: 1 } },
  );
  const runtime = pairFor(object, "role=runtime&connectionId=runtime-rate&delegatorId=delegator-rate");
  await new Promise((resolve) => setImmediate(resolve));
  const challenge = (runtime.attachment as { challenge: RelayPossessionProofChallenge }).challenge;
  const { privateKey } = generateKeyPairSync("ed25519");
  await object.webSocketMessage(
    runtime,
    encodeRelayPossessionProofResponse(signRelayPossessionProof(challenge, privateKey)),
  );
  await object.webSocketMessage(runtime, "{}");
  assert.equal(runtime.readyState, 3);
  assert.equal(
    runtime.sent.some((entry) => typeof entry === "string" && entry.includes("resultPayload")),
    false,
  );
});

test("retention backpressure returns a typed unavailable outcome without storing another job", async () => {
  const state = new FakeState();
  const object = new RepositoryRelayDurableObject(
    state,
    { repository },
    { limits: { maxRetainedJobs: 1, maxDeadlineMs: 1_000 } },
  );
  const client = pairFor(object, "role=client&connectionId=host-retention-limit");
  const makeJob = (jobId: string) => ({
    version: 1,
    kind: "job" as const,
    repository,
    connectionId: "runtime-offline",
    jobId,
    deliveryState: "pre-delivery" as const,
    deadlineMs: 1_000,
    signedSessionRequest: "Ag",
  });
  await object.webSocketMessage(client, encodeRelayEnvelope(makeJob("job-retained"), repository));
  await object.webSocketMessage(client, encodeRelayEnvelope(makeJob("job-overloaded"), repository));
  assert.equal((await state.storage.list?.({ prefix: "relay:job:" }))?.size, 1);
  const controls = client.sent
    .filter((entry): entry is Uint8Array => typeof entry !== "string")
    .map((entry) => new TextDecoder().decode(entry));
  assert.equal(controls.filter((entry) => entry.includes('"deliveryState":"unavailable"')).length, 2);
});

test("routes only to an authenticated matching runtime and persists digest-only delivery state", async () => {
  const state = new FakeState();
  const object = new RepositoryRelayDurableObject(
    state,
    { repository },
    { now: () => 10_000, randomNonce: () => "nonce-820", limits: { maxInFlightJobs: 1 } },
  );
  const runtime = pairFor(object, "role=runtime&connectionId=runtime-2&delegatorId=delegator-2");
  await new Promise((resolve) => setImmediate(resolve));
  const challenge = (runtime.attachment as { challenge: RelayPossessionProofChallenge }).challenge;
  const { privateKey } = generateKeyPairSync("ed25519");
  const response = signRelayPossessionProof(challenge, privateKey);
  await object.webSocketMessage(runtime, encodeRelayPossessionProofResponse(response));
  const client = pairFor(object, "role=client&connectionId=host-1");
  const job = {
    version: 1,
    kind: "job" as const,
    repository,
    connectionId: "runtime-2",
    jobId: "job-819",
    deliveryState: "pre-delivery" as const,
    deadlineMs: 1_000,
    signedSessionRequest: signedSessionRequest(privateKey, privateKey, "delegator-2"),
  };
  await object.webSocketMessage(client, encodeRelayEnvelope(job, repository));
  assert.ok(runtime.sent.some((entry) => typeof entry === "string" && entry.includes("job-819")));
  const runtimeJobCount = () =>
    runtime.sent.filter((entry) => typeof entry === "string" && entry.includes('"kind":"job"')).length;
  const beforeOverload = runtimeJobCount();
  await object.webSocketMessage(client, encodeRelayEnvelope({ ...job, jobId: "job-inflight-overload" }, repository));
  assert.equal(runtimeJobCount(), beforeOverload);
  assert.equal(
    client.sent.some(
      (entry) => typeof entry !== "string" && new TextDecoder().decode(entry).includes('"deliveryState":"unavailable"'),
    ),
    true,
  );
  const persisted = await state.storage.get<Record<string, unknown>>("relay:job:job-819");
  assert.equal("signedSessionRequest" in (persisted ?? {}), false);
  assert.equal("resultPayload" in ((persisted ?? {}).state as Record<string, unknown>), false);
  const result = {
    version: 1,
    kind: "result" as const,
    repository,
    connectionId: "runtime-2",
    jobId: "job-819",
    deliveryState: "terminal-result" as const,
    resultPayload: "Ag",
  };
  await object.webSocketMessage(runtime, encoder.encode(JSON.stringify(result)));
  const terminal = await state.storage.get<Record<string, unknown>>("relay:job:job-819");
  assert.equal(((terminal ?? {}).state as { phase?: string }).phase, "terminal-result");
  const resultCount = () =>
    client.sent.filter(
      (entry) => typeof entry !== "string" && new TextDecoder().decode(entry).includes('"kind":"result"'),
    ).length;
  assert.equal(resultCount(), 1);
  await object.webSocketMessage(runtime, encoder.encode(JSON.stringify({ ...result, resultPayload: "Aw" })));
  assert.equal(resultCount(), 1);
});

test("retained job metadata is deleted deterministically after deadline and grace", async () => {
  const state = new FakeState();
  let now = 10_000;
  const object = new RepositoryRelayDurableObject(
    state,
    { repository },
    {
      now: () => now,
      limits: { maxDeadlineMs: 100, jobRetentionMs: 100 },
    },
  );
  const client = pairFor(object, "role=client&connectionId=host-cleanup");
  const job = {
    version: 1,
    kind: "job" as const,
    repository,
    connectionId: "runtime-offline",
    jobId: "job-cleanup",
    deliveryState: "pre-delivery" as const,
    deadlineMs: 100,
    signedSessionRequest: "Ag",
  };
  await object.webSocketMessage(client, encodeRelayEnvelope(job, repository));
  assert.notEqual(await state.storage.get("relay:job:job-cleanup"), undefined);
  now = 10_201;
  await object.alarm();
  assert.equal(await state.storage.get("relay:job:job-cleanup"), undefined);
});

test("a repository envelope for another Durable Object partition is rejected", async () => {
  const state = new FakeState();
  const object = new RepositoryRelayDurableObject(state, { repository });
  const client = pairFor(object, "role=client&connectionId=host-isolation");
  const otherRepository = { repositoryHost: "github.com", repositoryId: "1330755861" } as const;
  const job = {
    version: 1,
    kind: "job" as const,
    repository: otherRepository,
    connectionId: "runtime-other",
    jobId: "job-other-repository",
    deliveryState: "pre-delivery" as const,
    deadlineMs: 1_000,
    signedSessionRequest: "Ag",
  };
  await object.webSocketMessage(client, encodeRelayEnvelope(job, otherRepository));
  assert.equal(client.readyState, 3);
  assert.equal((await state.storage.list?.({ prefix: "relay:job:" }))?.size ?? 0, 0);
});

test("does not replay a delivered job after runtime disconnect", async () => {
  const state = new FakeState();
  const object = new RepositoryRelayDurableObject(
    state,
    { repository },
    { now: () => 10_000, randomNonce: () => "nonce-821" },
  );
  const runtime = pairFor(object, "role=runtime&connectionId=runtime-3&delegatorId=delegator-3");
  await new Promise((resolve) => setImmediate(resolve));
  const challenge = (runtime.attachment as { challenge: RelayPossessionProofChallenge }).challenge;
  const { privateKey } = generateKeyPairSync("ed25519");
  await object.webSocketMessage(
    runtime,
    encodeRelayPossessionProofResponse(signRelayPossessionProof(challenge, privateKey)),
  );
  const client = pairFor(object, "role=client&connectionId=host-2");
  const job = {
    version: 1,
    kind: "job" as const,
    repository,
    connectionId: "runtime-3",
    jobId: "job-ambiguous",
    deliveryState: "pre-delivery" as const,
    deadlineMs: 1_000,
    signedSessionRequest: signedSessionRequest(privateKey, privateKey, "delegator-3"),
  };
  await object.webSocketMessage(client, encodeRelayEnvelope(job, repository));
  const before = runtime.sent.length;
  await object.webSocketClose(runtime);
  const stateAfter = await state.storage.get<Record<string, unknown>>("relay:job:job-ambiguous");
  assert.equal(((stateAfter ?? {}).state as { phase?: string }).phase, "possibly-delivered");
  assert.equal(runtime.sent.length, before);
});

test("connection TTL cleanup preserves possibly-delivered ambiguity", async () => {
  const state = new FakeState();
  let now = 10_000;
  const object = new RepositoryRelayDurableObject(
    state,
    { repository },
    { now: () => now, randomNonce: () => "nonce-ttl", limits: { connectionTtlMs: 100 } },
  );
  const runtime = pairFor(object, "role=runtime&connectionId=runtime-ttl&delegatorId=delegator-ttl");
  await new Promise((resolve) => setImmediate(resolve));
  const challenge = (runtime.attachment as { challenge: RelayPossessionProofChallenge }).challenge;
  const { privateKey } = generateKeyPairSync("ed25519");
  await object.webSocketMessage(
    runtime,
    encodeRelayPossessionProofResponse(signRelayPossessionProof(challenge, privateKey)),
  );
  const client = pairFor(object, "role=client&connectionId=host-ttl");
  const job = {
    version: 1,
    kind: "job" as const,
    repository,
    connectionId: "runtime-ttl",
    jobId: "job-ttl",
    deliveryState: "pre-delivery" as const,
    deadlineMs: 1_000,
    signedSessionRequest: signedSessionRequest(privateKey, privateKey, "delegator-ttl"),
  };
  await object.webSocketMessage(client, encodeRelayEnvelope(job, repository));
  now = 10_101;
  await object.alarm();
  const persisted = await state.storage.get<Record<string, unknown>>("relay:job:job-ttl");
  assert.equal(((persisted ?? {}).state as { phase?: string }).phase, "possibly-delivered");
  assert.equal(runtime.readyState, 3);
});

test("does not deliver when the canonical certificate signer does not match the proved runtime key", async () => {
  const state = new FakeState();
  const object = new RepositoryRelayDurableObject(
    state,
    { repository },
    { now: () => 10_000, randomNonce: () => "nonce-mismatch" },
  );
  const runtime = pairFor(object, "role=runtime&connectionId=runtime-mismatch&delegatorId=delegator-819");
  await new Promise((resolve) => setImmediate(resolve));
  const challenge = (runtime.attachment as { challenge: RelayPossessionProofChallenge }).challenge;
  const { privateKey } = generateKeyPairSync("ed25519");
  await object.webSocketMessage(
    runtime,
    encodeRelayPossessionProofResponse(signRelayPossessionProof(challenge, privateKey)),
  );
  const client = pairFor(object, "role=client&connectionId=host-mismatch");
  const wrongCertificateKey = generateKeyPairSync("ed25519").privateKey;
  const job = {
    version: 1,
    kind: "job" as const,
    repository,
    connectionId: "runtime-mismatch",
    jobId: "job-mismatch",
    deliveryState: "pre-delivery" as const,
    deadlineMs: 1_000,
    signedSessionRequest: signedSessionRequest(wrongCertificateKey),
  };
  await object.webSocketMessage(client, encodeRelayEnvelope(job, repository));
  assert.equal(
    runtime.sent.some((entry) => typeof entry === "string" && entry.includes("job-mismatch")),
    false,
  );
});

test("reports delivered ambiguity when storage fails after the Runtime send", async () => {
  const state = new FakeState();
  const object = new RepositoryRelayDurableObject(
    state,
    { repository },
    { now: () => 10_000, randomNonce: () => "nonce-storage" },
  );
  const runtime = pairFor(object, "role=runtime&connectionId=runtime-storage&delegatorId=delegator-storage");
  await new Promise((resolve) => setImmediate(resolve));
  const challenge = (runtime.attachment as { challenge: RelayPossessionProofChallenge }).challenge;
  const { privateKey } = generateKeyPairSync("ed25519");
  await object.webSocketMessage(
    runtime,
    encodeRelayPossessionProofResponse(signRelayPossessionProof(challenge, privateKey)),
  );
  const client = pairFor(object, "role=client&connectionId=host-storage");
  const job = {
    version: 1,
    kind: "job" as const,
    repository,
    connectionId: "runtime-storage",
    jobId: "job-storage",
    deliveryState: "pre-delivery" as const,
    deadlineMs: 1_000,
    signedSessionRequest: signedSessionRequest(privateKey, privateKey, "delegator-storage"),
  };
  state.storage.failNextPut = true;
  await object.webSocketMessage(client, encodeRelayEnvelope(job, repository));
  const sourceMessages = client.sent
    .filter((entry): entry is Uint8Array => typeof entry !== "string")
    .map((entry) => new TextDecoder().decode(entry));
  assert.equal(
    sourceMessages.some((entry) => entry.includes('"deliveryState":"unavailable"')),
    false,
  );
  assert.equal(
    sourceMessages.some((entry) => entry.includes('"deliveryState":"delivered-ambiguous"')),
    true,
  );
  const persisted = await state.storage.get<Record<string, unknown>>("relay:job:job-storage");
  assert.equal(((persisted ?? {}).state as { phase?: string }).phase, "possibly-delivered");
});
