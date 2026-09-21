import assert from "node:assert/strict";
import { test } from "node:test";
import { base64UrlEncodeText } from "./agent-authority/codec.js";
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

test("hosted MCP serves the stable Issue MCP App resource while preserving the native tool", async () => {
  const worker = (await import("./hosted-worker.js")).default;
  const binding = relayNamespace({ fetch: async () => new Response("unused") }, []);
  const call = (id: number, method: string, params: Record<string, unknown> = {}) =>
    worker.fetch(
      new Request("https://hosted.example/mcp", {
        method: "POST",
        headers: { accept: ACCEPT, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }),
      env(binding),
    );

  const listed = await (await call(2, "tools/list")).json();
  assert.ok(listed.result.tools.some((tool: { name: string }) => tool.name === "inari_pr_publish"));
  const issueView = listed.result.tools.find((tool: { name: string }) => tool.name === "inari_issue_view");
  assert.deepEqual(issueView._meta.ui, { resourceUri: "ui://inari/issue-view.html" });
  assert.equal(issueView.annotations.readOnlyHint, true);

  const resources = await (await call(3, "resources/list")).json();
  assert.ok(
    resources.result.resources.some((resource: { uri: string }) => resource.uri === "ui://inari/issue-view.html"),
  );

  const read = await (await call(4, "resources/read", { uri: "ui://inari/issue-view.html" })).json();
  assert.equal(read.result.contents[0].uri, "ui://inari/issue-view.html");
  assert.equal(read.result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(read.result.contents[0].text, /inari_issue_view/);
});
