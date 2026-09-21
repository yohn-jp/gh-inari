import assert from "node:assert/strict";
import { test } from "node:test";
import { base64UrlEncodeText } from "./agent-authority/codec.js";
import { ENDPOINT_AUTHORIZATION_CONTRACT_VERSION } from "./endpoint-authorization.js";
import { createEndpointApi } from "./endpoint-api.js";
import { ENDPOINT_HTTP_PATH } from "./endpoint-http.js";
import { ENDPOINT_WEBHOOK_PATH, EndpointWebhookReplayGuard } from "./endpoint-webhook.js";
import { decodeRelayEnvelope, type RelayRepositoryIdentity } from "./relay/contract.js";
import {
  createHostedRelayDispatch,
  type Env,
  type HostedDurableObjectNamespace,
  type HostedDurableObjectStub,
} from "./hosted-worker.js";
import type { RepositoryRelayDispatchRequest } from "./mcp/relay-session-executor.js";

const repository: RelayRepositoryIdentity = { repositoryHost: "github.com", repositoryId: "1330755860" };
const ACCEPT = "application/json, text/event-stream";

class FakeSocket {
  readonly frames: string[] = [];
  readyState = 1;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.frames.push(data);
    const envelope = decodeRelayEnvelope(data, repository);
    if (envelope.kind !== "job") return;
    queueMicrotask(() => {
      this.emit(
        "message",
        JSON.stringify({
          version: 1,
          kind: "result",
          repository,
          connectionId: envelope.connectionId,
          jobId: envelope.jobId,
          deliveryState: "terminal-result",
          resultPayload: base64UrlEncodeText(JSON.stringify({ version: 1, status: "succeeded" })),
        }),
      );
    });
  }

  close(): void {
    this.readyState = 3;
  }

  private emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

function relayNamespace(stub: HostedDurableObjectStub, ids: string[]): HostedDurableObjectNamespace {
  return {
    idFromName(name) {
      ids.push(name);
      return `id:${name}`;
    },
    get() {
      return stub;
    },
  };
}

function env(namespace: HostedDurableObjectNamespace): Env {
  return { REPOSITORY_RELAY: namespace };
}

function onboardingEnv(namespace: HostedDurableObjectNamespace): Env {
  return {
    ...env(namespace),
    INARI_GITHUB_APP_ID: "123456",
    INARI_GITHUB_APP_CLIENT_ID: "Iv1.public-client",
    INARI_GITHUB_APP_SLUG: "inari",
    INARI_GITHUB_APP_INSTALLATION_URL: "https://github.com/apps/inari/installations/new",
    INARI_GITHUB_APP_USER_AUTH_PROFILE: "device-flow",
  };
}

test("public onboarding descriptor exposes deployment metadata without authority", async () => {
  const worker = (await import("./hosted-worker.js")).default;
  const ids: string[] = [];
  const response = await worker.fetch(
    new Request("https://hosted.example/.well-known/inari"),
    onboardingEnv(relayNamespace({ fetch: async () => new Response("unused") }, ids)),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    version: 1,
    githubHost: "github.com",
    appId: "123456",
    appClientId: "Iv1.public-client",
    appSlug: "inari",
    appInstallationUrl: "https://github.com/apps/inari/installations/new",
    appUserAuthProfile: "device-flow",
    relayConnectionBase: "wss://hosted.example/v1/relay/connect",
  });
  assert.deepEqual(ids, []);
  assert.equal(JSON.stringify(body).includes("repositoryId"), false);
});

test("public onboarding descriptor fails closed for missing or malformed metadata", async () => {
  const worker = (await import("./hosted-worker.js")).default;
  const ids: string[] = [];
  const binding = relayNamespace({ fetch: async () => new Response("unused") }, ids);
  const missing = await worker.fetch(new Request("https://hosted.example/.well-known/inari"), env(binding));
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), {
    version: 1,
    ok: false,
    error: { code: "ENDPOINT_ONBOARDING_NOT_CONFIGURED" },
  });
  const malformed = await worker.fetch(new Request("https://hosted.example/.well-known/inari"), {
    ...onboardingEnv(binding),
    INARI_GITHUB_APP_ID: "not-numeric",
  });
  assert.equal(malformed.status, 503);
  assert.deepEqual(await malformed.json(), {
    version: 1,
    ok: false,
    error: { code: "ENDPOINT_ONBOARDING_NOT_CONFIGURED" },
  });
  assert.deepEqual(ids, []);
});

test("public onboarding descriptor only accepts GET", async () => {
  const worker = (await import("./hosted-worker.js")).default;
  const response = await worker.fetch(
    new Request("https://hosted.example/.well-known/inari", { method: "POST" }),
    onboardingEnv(relayNamespace({ fetch: async () => new Response("unused") }, [])),
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

test("healthz is bounded metadata and does not expose repository or credential state", async () => {
  const worker = (await import("./hosted-worker.js")).default;
  const ids: string[] = [];
  const response = await worker.fetch(
    new Request("https://hosted.example/healthz"),
    env(relayNamespace({ fetch: async () => new Response("unused") }, ids)),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: true,
    service: "gh-inari-hosted-relay-worker",
    version: "1",
    transport: "mcp-and-repository-relay",
  });
  assert.equal(JSON.stringify(body).includes(repository.repositoryId), false);
  assert.deepEqual(ids, []);
});

test("hosted relay uses the production telemetry sink without Env.telemetry", async () => {
  const worker = (await import("./hosted-worker.js")).default;
  const ids: string[] = [];
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const response = await worker.fetch(
      new Request(
        "https://hosted.example/v1/relay/connect?repositoryId=1330755860&repositoryHost=github.com&role=runtime&connectionId=runtime-telemetry&delegatorId=runtime-telemetry",
        { headers: { upgrade: "websocket" } },
      ),
      env(
        relayNamespace(
          {
            fetch: async () => ({ status: 101, webSocket: new FakeSocket() }) as unknown as Response,
          },
          ids,
        ),
      ),
    );
    assert.equal(response.status, 101);
  } finally {
    console.log = originalLog;
  }
  assert.ok(lines.length > 0);
  assert.ok(lines.every((line) => !line.includes(repository.repositoryId)));
  assert.ok(lines.every((line) => !line.includes("signedSessionRequest")));
  assert.ok(lines.every((line) => !line.includes("resultPayload")));
  assert.ok(lines.some((line) => JSON.parse(line).surface === "hosted-worker"));
  assert.deepEqual(ids, [repository.repositoryId]);
});

test("relay ingress validates repository routing and fixes the public role to runtime", async () => {
  const worker = (await import("./hosted-worker.js")).default;
  const ids: string[] = [];
  let routedUrl = "";
  const stub: HostedDurableObjectStub = {
    async fetch(request) {
      routedUrl = request.url;
      return { status: 101, webSocket: new FakeSocket() } as unknown as Response;
    },
  };
  const binding = relayNamespace(stub, ids);
  const response = await worker.fetch(
    new Request(
      "https://hosted.example/v1/relay/connect?repositoryId=1330755860&repositoryHost=github.com&role=runtime&connectionId=runtime-1&delegatorId=runtime-1",
      { headers: { upgrade: "websocket" } },
    ),
    env(binding),
  );
  assert.equal(response.status, 101);
  assert.deepEqual(ids, [repository.repositoryId]);
  const routed = new URL(routedUrl);
  assert.equal(routed.searchParams.get("role"), "runtime");
  assert.equal(routed.searchParams.get("repositoryId"), repository.repositoryId);

  const rejected = await worker.fetch(
    new Request(
      "https://hosted.example/v1/relay/connect?repositoryId=1330755860&connectionId=client-1&delegatorId=runtime-1&role=client",
      { headers: { upgrade: "websocket" } },
    ),
    env(binding),
  );
  assert.equal(rejected.status, 400);

  const missing = await worker.fetch(
    new Request("https://hosted.example/v1/relay/connect?connectionId=runtime-1&delegatorId=runtime-1", {
      headers: { upgrade: "websocket" },
    }),
    env(binding),
  );
  assert.equal(missing.status, 400);
});

test("relay ingress enforces the configured provider host before selecting a repository DO", async () => {
  const worker = (await import("./hosted-worker.js")).default;
  const ids: string[] = [];
  const stub: HostedDurableObjectStub = {
    async fetch() {
      return { status: 101, webSocket: new FakeSocket() } as unknown as Response;
    },
  };
  const binding = relayNamespace(stub, ids);
  const mismatched = await worker.fetch(
    new Request(
      "https://hosted.example/v1/relay/connect?repositoryId=1330755860&repositoryHost=github.com&role=runtime&connectionId=runtime-ghe&delegatorId=runtime-ghe",
      { headers: { upgrade: "websocket" } },
    ),
    { ...env(binding), INARI_HOSTED_REPOSITORY_HOST: "ghe.example.com" },
  );
  assert.equal(mismatched.status, 400);
  assert.deepEqual(ids, []);

  const accepted = await worker.fetch(
    new Request(
      "https://hosted.example/v1/relay/connect?repositoryId=1330755860&repositoryHost=ghe.example.com&role=runtime&connectionId=runtime-ghe&delegatorId=runtime-ghe",
      { headers: { upgrade: "websocket" } },
    ),
    { ...env(binding), INARI_HOSTED_REPOSITORY_HOST: "ghe.example.com" },
  );
  assert.equal(accepted.status, 101);
  assert.deepEqual(ids, [repository.repositoryId]);
});

test("hosted MCP exposes the native catalog and internal dispatch targets the immutable DO name", async () => {
  const worker = (await import("./hosted-worker.js")).default;
  const ids: string[] = [];
  const response = await worker.fetch(
    new Request("https://hosted.example/mcp", {
      method: "POST",
      headers: { accept: ACCEPT, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }),
    }),
    env(relayNamespace({ fetch: async () => new Response("unused") }, ids)),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.serverInfo.name, "inari");

  const socket = new FakeSocket();
  const dispatch = createHostedRelayDispatch(
    relayNamespace(
      {
        async fetch(request) {
          assert.equal(new URL(request.url).searchParams.get("role"), "client");
          return { status: 101, webSocket: socket } as unknown as Response;
        },
      },
      ids,
    ),
  );
  const request: RepositoryRelayDispatchRequest = {
    repository,
    certificateSigner: "runtime-1",
    delegatorId: "runtime-1",
    envelope: { repositoryId: repository.repositoryId },
    signedSessionEnvelope: { repositoryId: repository.repositoryId, certificate: "opaque" },
  };
  const result = await dispatch.dispatch(request);
  const envelope = "envelope" in result ? result.envelope : result;
  assert.equal(envelope.kind, "result");
  assert.equal(ids.at(-1), repository.repositoryId);
  assert.equal(decodeRelayEnvelope(socket.frames[0]!, repository).kind, "job");
});

test("hosted webhook route admits only the bounded Endpoint webhook surface", async () => {
  const worker = (await import("./hosted-worker.js")).default;
  const secret = "hosted-webhook-secret";
  const body = JSON.stringify({
    installation: { id: 9001 },
    repository: { id: 1330755860, full_name: "yohn-jp/gh-inari" },
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body) as unknown as BufferSource),
  );
  const signature = "sha256=" + [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
  const endpointWebhook = {
    admission: {
      secret,
      endpoint: {
        version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
        kind: "endpoint" as const,
        id: "hosted",
        deployment: "shared-hosted" as const,
      },
      installation: {
        version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
        kind: "installation" as const,
        endpointId: "hosted",
        installationId: "9001",
      },
      repositories: [
        {
          version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
          kind: "repository" as const,
          endpointId: "hosted",
          installationId: "9001",
          repositoryHost: "github.com",
          repositoryId: "1330755860",
          nameWithOwner: "yohn-jp/gh-inari",
        },
      ],
      now: "2026-09-22T00:00:00.000Z",
      maxAgeMs: 86_400_000,
      replay: new EndpointWebhookReplayGuard(),
    },
  };
  const hostedEnv = { ...env(relayNamespace({ fetch: async () => new Response("unused") }, [])), endpointWebhook };
  const response = await worker.fetch(
    new Request(`https://hosted.example${ENDPOINT_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "x-hub-signature-256": signature,
        "x-github-delivery": "hosted-delivery",
        "x-inari-delivery-at": "2026-09-22T00:00:00.000Z",
      },
      body,
    }),
    hostedEnv,
  );
  assert.equal(response.status, 202);
  assert.equal((await response.text()).includes(secret), false);
  const duplicate = await worker.fetch(
    new Request(`https://hosted.example${ENDPOINT_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "x-hub-signature-256": signature,
        "x-github-delivery": "hosted-delivery",
        "x-inari-delivery-at": "2026-09-22T00:00:00.000Z",
      },
      body,
    }),
    hostedEnv,
  );
  assert.equal(duplicate.status, 200);
  assert.equal((await worker.fetch(new Request("https://hosted.example/missing"), hostedEnv)).status, 404);
});

test("hosted Endpoint route delegates to the shared authenticated API composition", async () => {
  const worker = (await import("./hosted-worker.js")).default;
  const endpoint = {
    version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
    kind: "endpoint" as const,
    id: "hosted-dashboard",
    deployment: "shared-hosted" as const,
  };
  const installation = {
    version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
    kind: "installation" as const,
    endpointId: endpoint.id,
    installationId: "hosted-installation",
  };
  const repositoryIdentity = {
    version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
    kind: "repository" as const,
    endpointId: endpoint.id,
    installationId: installation.installationId,
    repositoryHost: "github.com",
    repositoryId: "1330755860",
    nameWithOwner: "yohn-jp/gh-inari",
  };
  const principal = { version: 1 as const, kind: "human" as const, id: "hosted-human" };
  const capability = { kind: "change.implement" as const, issue: 922 };
  const endpointApi = createEndpointApi({
    authentication: {
      authenticate: async () => ({
        version: 1,
        authenticated: true as const,
        principal,
        endpoint,
        installation,
        repository: repositoryIdentity,
        capabilities: [capability],
      }),
    },
    readPresence: async () => ({
      endpoint,
      repository: repositoryIdentity,
      now: 1_000,
      relay: {
        version: 1,
        repository: { repositoryHost: "github.com", repositoryId: "1330755860" },
        availability: "available" as const,
        observedAtMs: 1_000,
        records: [],
      },
    }),
  });
  const response = await worker.fetch(
    new Request(`https://hosted.example${ENDPOINT_HTTP_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        operation: "presence.read",
        endpoint,
        installation,
        repository: repositoryIdentity,
        capability,
      }),
    }),
    { ...env(relayNamespace({ fetch: async () => new Response("unused") }, [])), endpointApi },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(
    (
      await worker.fetch(
        new Request(`https://hosted.example${ENDPOINT_HTTP_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: 1,
            operation: "presence.read",
            endpoint,
            installation,
            repository: repositoryIdentity,
            capability,
          }),
        }),
        env(relayNamespace({ fetch: async () => new Response("unused") }, [])),
      )
    ).status,
    503,
  );
});
