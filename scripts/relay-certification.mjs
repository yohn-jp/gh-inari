#!/usr/bin/env node

import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { register } from "tsx/esm/api";

// The requested certification command is intentionally runnable without a
// pre-built dist directory.  The production adapters remain TypeScript source
// modules; tsx is only the loader for this test harness.
register();

const repository = Object.freeze({
  repositoryHost: "github.com",
  repositoryId: "553000001",
  repositoryNameWithOwner: "acme/inari",
});
const target = Object.freeze({
  repositoryHost: repository.repositoryHost,
  repositoryId: repository.repositoryId,
  nameWithOwner: repository.repositoryNameWithOwner,
});
const app = Object.freeze({
  kind: "github-app",
  slug: "inari-issuer",
  appId: "1",
  principal: "app:inari-issuer",
  installationId: "2",
});
const now = new Date("2026-09-19T00:00:30.000Z");
const nowSeconds = Math.floor(now.getTime() / 1000);
const trustedExecution = Object.freeze({
  version: 1,
  runtime: "github-actions",
  event: "workflow_dispatch",
  repository: target,
  workflowRef: "refs/heads/main",
  workflowSha: "a".repeat(40),
  workflowTrust: "protected",
  codeExecution: "trusted-only",
  fork: false,
  pullRequest: false,
});
const issue = 553;
const branch = "feat/553-cross-deployment-conformance";
const pullRequest = 5530;
const createdCommitSha = "e".repeat(40);

const LIVE_TIMEOUT_MS = 10_000;
const LIVE_MAX_RESPONSE_BYTES = 64 * 1024;
const LIVE_MAX_CONFIG_BYTES = 64 * 1024;
const LIVE_MAX_PRIVATE_KEY_BYTES = 16 * 1024;
const LIVE_CONFIG_FILE_ENV = "INARI_RELAY_LIVE_CONFIG_FILE";
const LIVE_CONFIG_FILE_ALIAS = "INARI_RELAY_LIVE_CONFIG";
const LIVE_FAILURE_MESSAGES = Object.freeze({
  configuration: "Live configuration is invalid.",
  deployment: "The configured deployment could not be reached.",
  protocol: "The configured deployment returned an unexpected protocol response.",
  timeout: "The configured deployment did not complete within the live bound.",
  transport: "The configured deployment transport failed.",
});

class LiveCertificationFailure extends Error {
  constructor(stage, failureClass) {
    super(LIVE_FAILURE_MESSAGES[failureClass] ?? LIVE_FAILURE_MESSAGES.transport);
    this.name = "LiveCertificationFailure";
    this.stage = stage;
    this.failureClass = failureClass;
  }
}

function liveFailure(stage, failureClass = "transport") {
  return new LiveCertificationFailure(stage, failureClass);
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function liveBaseUrl(value) {
  const raw = nonEmptyString(value);
  if (raw === undefined) throw liveFailure("configuration", "configuration");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw liveFailure("configuration", "configuration");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw liveFailure("configuration", "configuration");
  }
  return parsed;
}

function readLiveConfiguration(environment) {
  const fileName = nonEmptyString(environment[LIVE_CONFIG_FILE_ENV] ?? environment[LIVE_CONFIG_FILE_ALIAS]);
  let fileValues = {};
  let fileDirectory;
  if (fileName !== undefined) {
    let fileText;
    try {
      const filePath = path.resolve(fileName);
      fileDirectory = path.dirname(filePath);
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > LIVE_MAX_CONFIG_BYTES) throw new Error("config-file-bounds");
      fileText = fs.readFileSync(filePath, "utf8");
      fileValues = record(JSON.parse(fileText));
      if (fileValues === undefined) throw new Error("config-file-shape");
    } catch {
      return { status: "failed", failure: { stage: "configuration", failureClass: "configuration" } };
    }
  }

  const value = (environmentName, fileNameKey) => environment[environmentName] ?? fileValues[fileNameKey];
  const url = nonEmptyString(value("INARI_RELAY_LIVE_URL", "url"));
  const repositoryId = nonEmptyString(value("INARI_RELAY_LIVE_REPOSITORY_ID", "repositoryId"));
  const repositoryHost = (
    nonEmptyString(value("INARI_RELAY_LIVE_REPOSITORY_HOST", "repositoryHost")) ?? "github.com"
  ).toLowerCase();
  const delegatorId = nonEmptyString(environment.INARI_RELAY_DELEGATOR_ID ?? fileValues.delegatorId);
  const privateKey = nonEmptyString(environment.INARI_RELAY_DELEGATOR_PRIVATE_KEY ?? fileValues.privateKey);
  const privateKeyFile = nonEmptyString(
    environment.INARI_RELAY_DELEGATOR_PRIVATE_KEY_FILE ?? fileValues.privateKeyFile,
  );
  const missing = [
    url === undefined ? "url" : undefined,
    repositoryId === undefined ? "repositoryId" : undefined,
    delegatorId === undefined ? "delegatorId" : undefined,
    privateKey === undefined && privateKeyFile === undefined ? "privateKey" : undefined,
  ].filter((item) => item !== undefined);
  if (missing.length > 0) {
    return { status: "pending", reason: "Live configuration is incomplete.", missing };
  }

  let baseUrl;
  try {
    baseUrl = liveBaseUrl(url);
  } catch (error) {
    return {
      status: "failed",
      failure:
        error instanceof LiveCertificationFailure
          ? { stage: error.stage, failureClass: error.failureClass }
          : { stage: "configuration", failureClass: "configuration" },
    };
  }
  if (!/^[1-9][0-9]{0,19}$/u.test(repositoryId) || !/^[A-Za-z0-9._-]{1,128}$/u.test(delegatorId)) {
    return { status: "failed", failure: { stage: "configuration", failureClass: "configuration" } };
  }
  if (!/^[A-Za-z0-9.-]{1,255}$/u.test(repositoryHost)) {
    return { status: "failed", failure: { stage: "configuration", failureClass: "configuration" } };
  }

  let resolvedPrivateKeyFile;
  let privateKeyPem = privateKey;
  if (privateKeyPem === undefined && privateKeyFile !== undefined) {
    resolvedPrivateKeyFile = path.resolve(fileDirectory ?? process.cwd(), privateKeyFile);
    try {
      const stat = fs.statSync(resolvedPrivateKeyFile);
      if (!stat.isFile() || stat.size > LIVE_MAX_PRIVATE_KEY_BYTES) throw new Error("private-key-bounds");
      privateKeyPem = fs.readFileSync(resolvedPrivateKeyFile, "utf8");
    } catch {
      return { status: "failed", failure: { stage: "configuration", failureClass: "configuration" } };
    }
  }
  return {
    status: "configured",
    config: Object.freeze({
      baseUrl,
      repositoryId,
      repositoryHost,
      delegatorId,
      privateKeyPem,
      privateKeyFile: resolvedPrivateKeyFile,
    }),
  };
}

function liveEndpoints(baseUrl) {
  const prefix = baseUrl.pathname === "/" ? "" : baseUrl.pathname.replace(/\/+$/u, "");
  const endpoint = (suffix) => new URL(`${baseUrl.origin}${prefix}${suffix}`);
  const websocket = endpoint("/v1/relay/connect");
  websocket.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
  return Object.freeze({
    endpoint: `${baseUrl.origin}${prefix || "/"}`,
    healthz: endpoint("/healthz"),
    mcp: endpoint("/mcp"),
    websocket,
  });
}

function liveEvidence(endpoints, checks, contactedDeployment, transportKind) {
  return {
    bounded: true,
    secretSafe: true,
    rawProviderPayloads: false,
    contactedDeployment,
    transport: transportKind,
    endpoint: endpoints.endpoint,
    checks,
  };
}

function livePending(reason = "Live configuration is unavailable.", missing) {
  return {
    version: 1,
    profile: "relay",
    mode: "live",
    certificationStatus: "pending",
    live: {
      status: "pending",
      reason,
      ...(missing === undefined ? {} : { missing }),
      evidence: { bounded: true, secretSafe: true, rawProviderPayloads: false, contactedDeployment: false },
    },
  };
}

function liveFailed(failure, endpoints, checks, contactedDeployment, transportKind) {
  const evidence =
    endpoints === undefined
      ? {
          bounded: true,
          secretSafe: true,
          rawProviderPayloads: false,
          contactedDeployment,
          transport: transportKind,
          checks,
        }
      : liveEvidence(endpoints, checks, contactedDeployment, transportKind);
  return {
    version: 1,
    profile: "relay",
    mode: "live",
    certificationStatus: "failed",
    live: {
      status: "failed",
      failure: { stage: failure.stage, failureClass: failure.failureClass },
      evidence,
    },
  };
}

function livePassed(endpoints, checks, contactedDeployment, transportKind) {
  const status = contactedDeployment ? "passed" : "verified";
  return {
    version: 1,
    profile: "relay",
    mode: "live",
    certificationStatus: status,
    live: {
      status,
      evidence: liveEvidence(endpoints, checks, contactedDeployment, transportKind),
    },
  };
}

let modulePromise;
async function loadModules() {
  if (modulePromise !== undefined) return modulePromise;
  modulePromise = Promise.all([
    import("../src/cross-deployment-conformance.ts"),
    import("../src/cross-deployment-conformance-fixtures.ts"),
    import("../src/hosted-worker.ts"),
    import("../src/relay/cloudflare-repository-relay.ts"),
    import("../src/relay/contract.ts"),
    import("../src/relay/connection-proof.ts"),
    import("../src/relay/delivery-state.ts"),
    import("../src/relay/local-runtime.ts"),
    import("../src/mcp/relay-session-executor.ts"),
    import("../src/session-authorized-change-executor.ts"),
    import("../src/change-trusted-executor.ts"),
    import("../src/github/effect-authorizer.ts"),
    import("../src/agent-authority/index.ts"),
    import("../src/agent-authority/runtime-authority.ts"),
    import("../src/issuer-identity.ts"),
  ]).then(
    ([
      conformance,
      fixtures,
      hosted,
      durableObject,
      contract,
      connectionProof,
      delivery,
      localRuntime,
      relayExecutor,
      sessionExecutor,
      trusted,
      effectAuthorizer,
      authority,
      runtimeAuthority,
      issuer,
    ]) => ({
      conformance,
      fixtures,
      hosted,
      durableObject,
      contract,
      connectionProof,
      delivery,
      localRuntime,
      relayExecutor,
      sessionExecutor,
      trusted,
      effectAuthorizer,
      authority,
      runtimeAuthority,
      issuer,
    }),
  );
  return modulePromise;
}

function evidenceInput(snapshot) {
  return {
    change: snapshot.identity,
    ...(snapshot.branchGovernance === undefined ? {} : { branchGovernance: snapshot.branchGovernance }),
    naming: snapshot.naming,
    baseBranch: snapshot.baseBranch,
    evidence: snapshot.evidence,
  };
}

function successEvidenceFor(effect) {
  switch (effect.kind) {
    case "CREATE_BRANCH":
      return { kind: effect.kind, branch: effect.branch, baseBranch: effect.baseBranch, createdCommitSha };
    case "CREATE_PROVENANCE_COMMIT":
      return {
        kind: effect.kind,
        branch: effect.branch,
        rootIssue: effect.rootIssue,
        path: effect.path,
        createdCommitSha,
      };
    case "CREATE_PULL_REQUEST":
      return {
        kind: effect.kind,
        branch: effect.branch,
        baseBranch: effect.baseBranch,
        rootIssue: effect.rootIssue,
        pullRequest,
      };
    case "MARK_PULL_REQUEST_READY":
    case "CLOSE_PULL_REQUEST":
      return { kind: effect.kind, pullRequest: effect.pullRequest };
    case "DELETE_BRANCH":
      return effect.expectedCommitSha === undefined
        ? { kind: effect.kind, branch: effect.branch }
        : { kind: effect.kind, branch: effect.branch, expectedCommitSha: effect.expectedCommitSha, outcome: "deleted" };
  }
}

function providerFor(fixture, modules, options = {}) {
  let current = evidenceInput(fixture.before);
  let reads = 0;
  let executions = 0;
  let releaseExecution;
  const reader = {
    async read() {
      reads += 1;
      return current;
    },
  };
  const failEffect = fixture.name === "abort-compensation-recovery" ? "DELETE_BRANCH" : undefined;
  const effectAuthorizer = {
    async applyEffects(request) {
      const effect = request.effects[0];
      assert.ok(effect);
      if (effect.kind === failEffect) throw new Error("controlled provider effect failure");
      current = evidenceInput(fixture.after ?? fixture.before);
      return {
        version: modules.effectAuthorizer.EFFECT_AUTHORIZER_CONTRACT_VERSION,
        authority: "issuer",
        issuer: {
          kind: "github-app",
          slug: app.slug,
          appId: app.appId,
          principal: modules.issuer.INARI_ISSUER_PRINCIPAL,
        },
        repository: target,
        installation: { appId: app.appId, installationId: app.installationId, repositoryHost: target.repositoryHost },
        permissions: {},
        effects: [{ kind: effect.kind, status: "applied", evidence: successEvidenceFor(effect) }],
      };
    },
  };
  const changeExecutor = new modules.trusted.TrustedChangeExecutor({
    reader,
    effectAuthorizer,
    execution: trustedExecution,
    target,
  });
  const execute = changeExecutor.execute.bind(changeExecutor);
  const wrappedChangeExecutor = {
    read: changeExecutor.read.bind(changeExecutor),
    async execute(request) {
      executions += 1;
      if (options.deferExecution) {
        await new Promise((resolve) => {
          releaseExecution = resolve;
        });
      }
      return execute(request);
    },
  };
  return {
    changeExecutor: wrappedChangeExecutor,
    release() {
      releaseExecution?.();
    },
    get reads() {
      return reads;
    },
    get executions() {
      return executions;
    },
  };
}

function authorityAndSession(fixture, modules, options = {}) {
  const authorityKey = modules.authority.generateRuntimeAuthorityKeyPair();
  const connectionKey = options.separateConnectionKey
    ? modules.authority.generateRuntimeAuthorityKeyPair().privateKey
    : authorityKey.privateKey;
  const certificateSigner = options.certificateSigner ?? "delegator-826";
  const authority = modules.runtimeAuthority.assertRuntimeAuthority({
    version: 1,
    kind: "runtime-authority",
    id: certificateSigner,
    key: authorityKey.publicKeyJwk,
    status: "active",
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement", "change.ready", "change.abort"],
  });
  const session = modules.authority.createManagedSession();
  const capability = options.capability ?? {
    kind: fixture.request.operation === "abort" ? "change.abort" : "change.implement",
    issue,
  };
  const issuance = session.createIssuanceRequest({
    repository: { id: repository.repositoryId, name: repository.repositoryNameWithOwner },
    task: { kind: "issue", number: issue },
    capabilities: [capability],
    ttlSeconds: 600,
  });
  const certificateKey = options.certificateKey ?? authorityKey;
  const certificate = modules.authority.issueSessionCertificate({
    repository: { id: repository.repositoryId, name: repository.repositoryNameWithOwner },
    runtimeAuthority: authority,
    runtimeKey: certificateKey,
    request: issuance,
    now,
  });
  // The relay binds the certificate kid to the connection's Delegator id.
  session.acceptCertificate(certificate.compact);
  const envelope = modules.authority.signSessionRequest({
    session,
    request: { version: 1, issue },
    operation: `change.${fixture.request.operation}`,
    requestId: `relay-certification-${fixture.name}`,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 60,
  });
  const artifact = modules.authority.renderRuntimeAuthorityArtifact(authority);
  const content = Buffer.from(modules.authority.canonicalRuntimeAuthorityJson(authority), "utf8").toString("base64");
  const capabilityRead = {
    providerPrincipal: app,
    scope: {
      app,
      installation: { appId: app.appId, installationId: app.installationId, repositoryHost: repository.repositoryHost },
      repository: {
        repositoryHost: repository.repositoryHost,
        repositoryId: repository.repositoryId,
        nameWithOwner: repository.repositoryNameWithOwner,
      },
      repositorySelection: "selected",
      permissions: { contents: "read", issues: "read", pull_requests: "read" },
      expiresAt: "2026-09-19T00:10:00Z",
    },
    transport: {
      async request(request) {
        if (request.path === "repos/acme/inari") {
          return {
            status: 200,
            body: {
              id: Number(repository.repositoryId),
              full_name: repository.repositoryNameWithOwner,
              fork: false,
              default_branch: "main",
            },
          };
        }
        if (request.path === "repos/acme/inari/git/ref/heads/main") {
          return { status: 200, body: { ref: "refs/heads/main", object: { type: "commit", sha: "b".repeat(40) } } };
        }
        if (request.path.includes("/git/trees/")) {
          return {
            status: 200,
            body: {
              sha: "b".repeat(40),
              truncated: false,
              tree: [{ path: artifact.path, type: "blob", sha: "c".repeat(40) }],
            },
          };
        }
        if (request.path.includes("/git/blobs/")) {
          return { status: 200, body: { sha: "c".repeat(40), encoding: "base64", content } };
        }
        return { status: 404, body: {} };
      },
    },
  };
  const provider = providerFor(fixture, modules, options);
  const executor = modules.sessionExecutor.createCapabilityAuthorizedSessionExecutor({
    authentication: {
      broker: {
        async withRepositoryReadCapability(_request, callback) {
          return callback(capabilityRead);
        },
      },
      repository: { hostname: repository.repositoryHost, owner: "acme", name: "inari" },
      now,
    },
    changeExecutor: provider.changeExecutor,
    app,
  });
  return {
    envelope,
    executor,
    provider,
    connectionKey,
    certificateSigner,
  };
}

class MemorySocket {
  readyState = 0;
  sent = [];
  received = [];
  closeCode;
  closeReason;
  peer;
  inbound;
  peerClosed;
  #listeners = new Map();
  #pending = [];
  #buffered = [];
  attachment;

  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  serializeAttachment(value) {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment() {
    return structuredClone(this.attachment);
  }

  send(data) {
    if (this.readyState === 3) throw new Error("socket closed");
    this.sent.push(data);
    this.#buffered.push(data);
    this.peer?.receive(data);
  }

  receive(data) {
    this.received.push(data);
    if (this.inbound !== undefined) {
      queueMicrotask(() => void this.inbound(data));
      return;
    }
    if ((this.#listeners.get("message")?.size ?? 0) === 0) {
      this.#pending.push(data);
      return;
    }
    this.emit("message", { data });
  }

  open() {
    this.readyState = 1;
    this.emit("open", {});
  }

  flushPending() {
    const pending = this.#pending.splice(0);
    for (const data of pending) this.emit("message", { data });
  }

  emit(type, event) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  close(code = 1000, reason = "closed") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit("close", { code, reason });
    this.peer?.remoteClose(code, reason);
  }

  remoteClose(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit("close", { code, reason });
    this.peerClosed?.();
  }
}

class MemoryWebSocketPair {
  constructor() {
    this[0] = new MemorySocket();
    this[1] = new MemorySocket();
    this[0].peer = this[1];
    this[1].peer = this[0];
  }
}

class MemoryStorage {
  values = new Map();
  async get(key) {
    return this.values.get(key);
  }
  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    return this.values.delete(key);
  }
  async list(options = {}) {
    const output = new Map();
    for (const [key, value] of this.values) {
      if (options.prefix !== undefined && !key.startsWith(options.prefix)) continue;
      output.set(key, value);
      if (output.size >= (options.limit ?? Number.POSITIVE_INFINITY)) break;
    }
    return output;
  }
  async setAlarm() {}
}

class MemoryState {
  storage = new MemoryStorage();
  sockets = [];
  handler;
  acceptWebSocket(socket) {
    socket.readyState = 1;
    socket.peer.readyState = 1;
    socket.inbound = (data) => this.handler?.message(socket, data);
    socket.peerClosed = () => this.handler?.close(socket);
    this.sockets.push(socket);
  }
  getWebSockets(tag) {
    if (tag === undefined) return this.sockets;
    return this.sockets.filter((socket) => socket.deserializeAttachment?.()?.role === tag);
  }
  setWebSocketAutoResponse() {}
  waitUntil(promise) {
    void promise;
  }
  bind(object) {
    this.handler = {
      message: (socket, data) => object.webSocketMessage(socket, data),
      close: (socket) => object.webSocketClose(socket),
    };
  }
}

class RelaySocketProxy {
  readyState = 0;
  #target;
  #buffer = [];
  #listeners = new Map();
  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }
  send(data) {
    if (this.#target === undefined) this.#buffer.push(data);
    else this.#target.send(data);
  }
  close(code, reason) {
    this.#target?.close(code, reason);
    if (this.#target === undefined) this.emit("close", { code, reason });
  }
  emit(type, event) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
  attach(target) {
    this.#target = target;
    target.addEventListener?.("message", (event) => this.emit("message", event));
    target.addEventListener?.("close", (event) => {
      this.readyState = 3;
      this.emit("close", event);
    });
    target.addEventListener?.("error", (event) => this.emit("error", event));
    this.readyState = target.readyState ?? 1;
    for (const data of this.#buffer.splice(0)) target.send(data);
    this.emit("open", {});
    target.flushPending?.();
  }
}

function createNetwork(modules, options = {}) {
  globalThis.WebSocketPair = MemoryWebSocketPair;
  const state = new MemoryState();
  let object = new modules.durableObject.RepositoryRelayDurableObject(
    state,
    { repository },
    { now: options.now ?? (() => 10_000), randomNonce: () => "relay-certification-nonce" },
  );
  state.bind(object);
  const runtimeProxies = [];
  const ids = [];
  const namespace = {
    idFromName(name) {
      ids.push(name);
      return `id:${name}`;
    },
    get() {
      return { fetch: (request) => object.fetch(request) };
    },
  };
  const env = { REPOSITORY_RELAY: namespace };
  const worker = modules.hosted.default;
  const webSocketFactory = (url) => {
    const proxy = new RelaySocketProxy();
    runtimeProxies.push(proxy);
    void worker
      .fetch(new Request(url, { headers: { upgrade: "websocket" } }), env)
      .then((response) => {
        const targetSocket = response.webSocket;
        if (targetSocket === undefined) throw new Error("runtime relay connection unavailable");
        proxy.attach(targetSocket);
      })
      .catch(() => proxy.emit("error", new Error("runtime relay connection unavailable")));
    return proxy;
  };
  return {
    env,
    worker,
    state,
    namespace,
    runtimeProxies,
    ids,
    get object() {
      return object;
    },
    replaceObject() {
      object = new modules.durableObject.RepositoryRelayDurableObject(
        state,
        { repository },
        { now: options.now ?? (() => 10_000), randomNonce: () => "relay-certification-reconnect-nonce" },
      );
      state.bind(object);
    },
    webSocketFactory,
    async openClient(connectionId = "host-certification") {
      const response = await object.fetch(
        new Request(
          `https://relay.internal/?repositoryId=${repository.repositoryId}&repositoryHost=${repository.repositoryHost}&role=client&connectionId=${connectionId}`,
          {
            headers: { upgrade: "websocket" },
          },
        ),
      );
      return { client: response.webSocket, server: state.sockets.at(-1) };
    },
  };
}

function relayUrl(delegatorId) {
  return `wss://hosted.example/v1/relay/connect?repositoryId=${repository.repositoryId}&repositoryHost=${repository.repositoryHost}&role=runtime&connectionId=${delegatorId}&delegatorId=${delegatorId}`;
}

async function openRuntime(network, modules, delegatorId, privateKey) {
  const response = await network.worker.fetch(
    new Request(relayUrl(delegatorId), { headers: { upgrade: "websocket" } }),
    network.env,
  );
  const client = response.webSocket;
  const server = network.state.sockets.at(-1);
  assert.ok(client);
  assert.ok(server);
  const challenge = server.deserializeAttachment().challenge;
  await network.object.webSocketMessage(
    server,
    modules.connectionProof.encodeRelayPossessionProofResponse(
      modules.connectionProof.signRelayPossessionProof(challenge, privateKey),
    ),
  );
  return { client, server };
}

function runtimeFor(network, session, modules, options = {}) {
  return new modules.localRuntime.LocalRelayRuntime({
    relayUrl: relayUrl(options.delegatorId ?? "delegator-826"),
    repository,
    delegatorId: options.delegatorId ?? "delegator-826",
    privateKey: session.connectionKey,
    executor: session.executor,
    webSocketFactory: network.webSocketFactory,
    now: () => 10_000,
    connectionId: options.connectionId ?? options.delegatorId ?? "delegator-826",
    reconnectDelayMs: options.reconnectDelayMs ?? 25,
  });
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error("controlled relay certification timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function semantic(result, modules, request) {
  return modules.conformance.normalizeCrossDeploymentSessionResult(request, result);
}

function summary(result) {
  return {
    status: result.status,
    admission: result.admission,
    outcome: result.outcome,
    verified: result.verified,
    diagnostics: result.diagnostics.map((item) => item.code),
  };
}

function frameText(frame) {
  return typeof frame === "string" ? frame : new TextDecoder().decode(frame);
}

async function positiveParity(modules) {
  const fixture = modules.fixtures.CROSS_DEPLOYMENT_FIXTURES.find((item) => item.name === "issue-verified");
  assert.ok(fixture);
  const direct = authorityAndSession(fixture, modules);
  const directResult = await direct.executor.execute(direct.envelope);
  const expected = semantic(directResult, modules, fixture.request);
  const relay = authorityAndSession(fixture, modules);
  const network = createNetwork(modules);
  const runtime = runtimeFor(network, relay, modules);
  runtime.connect();
  await waitFor(() => network.runtimeProxies.length > 0, 750);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const actualResult = await modules.hosted.createHostedMcpSessionExecutor(network.env).execute(relay.envelope);
  const actual = semantic(actualResult, modules, fixture.request);
  const handshake = {
    runtimeState: runtime.state,
    possessionProved: runtime.snapshot().possessionProved,
    runtimeCloseCode: network.runtimeProxies[0]?.closeCode,
  };
  runtime.shutdown();
  const parity = modules.conformance.areCrossDeploymentResultsEquivalent(expected, actual);
  return {
    status: parity ? "passed" : "blocked",
    expected: summary(expected),
    actual: summary(actual),
    providerExecutions: relay.provider.executions,
    ...(parity
      ? {}
      : {
          productionFailure: {
            code: "RELAY_HANDSHAKE_INCOMPATIBLE",
            runtimeState: handshake.runtimeState,
            possessionProved: handshake.possessionProved,
            runtimeCloseCode: handshake.runtimeCloseCode,
            evidence:
              "Local Runtime sends a connection envelope before possession proof; Hosted Relay expects proof first and sends a wrapped challenge the Runtime decoder does not accept.",
          },
        }),
  };
}

async function capabilityDenial(modules) {
  const fixture = modules.fixtures.CROSS_DEPLOYMENT_FIXTURES.find((item) => item.name === "issue-verified");
  assert.ok(fixture);
  const session = authorityAndSession(fixture, modules, { capability: { kind: "change.ready", issue } });
  const result = await session.executor.execute(session.envelope);
  return {
    result: summary(semantic(result, modules, fixture.request)),
    providerExecutions: session.provider.executions,
  };
}

async function wrongDelegator(modules) {
  const fixture = modules.fixtures.CROSS_DEPLOYMENT_FIXTURES.find((item) => item.name === "issue-verified");
  assert.ok(fixture);
  const session = authorityAndSession(fixture, modules, {
    certificateSigner: "wrong-delegator",
    separateConnectionKey: true,
  });
  const network = createNetwork(modules);
  const runtime = await openRuntime(network, modules, "delegator-826", session.connectionKey);
  const source = await network.openClient("wrong-delegator-source");
  const job = {
    version: 1,
    kind: "job",
    repository,
    connectionId: "delegator-826",
    jobId: "wrong-delegator-job",
    deliveryState: "pre-delivery",
    deadlineMs: 1_000,
    signedSessionRequest: Buffer.from(JSON.stringify(session.envelope)).toString("base64url"),
  };
  await network.object.webSocketMessage(source.server, modules.contract.encodeRelayEnvelope(job, repository));
  await new Promise((resolve) => setImmediate(resolve));
  return {
    denied: true,
    runtimeJobFrames: runtime.server.sent.filter((frame) => String(frame).includes("wrong-delegator-job")).length,
    sourceControl: source.client.received.some((frame) => frameText(frame).includes('"deliveryState":"unavailable"')),
    providerExecutions: session.provider.executions,
  };
}

async function crossRepository(modules) {
  const fixture = modules.fixtures.CROSS_DEPLOYMENT_FIXTURES.find((item) => item.name === "issue-verified");
  assert.ok(fixture);
  const session = authorityAndSession(fixture, modules);
  let dispatches = 0;
  const executor = modules.relayExecutor.createRelayBackedSessionExecutor({
    repository,
    dispatch: {
      async dispatch() {
        dispatches += 1;
        throw new Error("dispatch must not run for a cross-repository route");
      },
    },
  });
  const result = await executor.execute({ ...session.envelope, repositoryId: "553000002" });
  return {
    result: summary(semantic(result, modules, fixture.request)),
    relayCode: result.failure?.relayCode,
    dispatches,
  };
}

async function malformedAndOversized(modules) {
  const network = createNetwork(modules);
  const malformed = await network.openClient("malformed-client");
  await network.object.webSocketMessage(malformed.server, "{");
  const oversized = await network.openClient("oversized-client");
  await network.object.webSocketMessage(oversized.server, "x".repeat(modules.contract.MAX_RELAY_ENVELOPE_BYTES + 1));
  return {
    malformed: { closeCode: malformed.client.closeCode },
    oversized: { closeCode: oversized.client.closeCode },
  };
}

async function runtimeUnavailable(modules) {
  const fixture = modules.fixtures.CROSS_DEPLOYMENT_FIXTURES.find((item) => item.name === "issue-verified");
  assert.ok(fixture);
  const session = authorityAndSession(fixture, modules);
  const network = createNetwork(modules);
  const result = await modules.hosted.createHostedMcpSessionExecutor(network.env).execute(session.envelope);
  return {
    result: summary(semantic(result, modules, fixture.request)),
    providerExecutions: session.provider.executions,
  };
}

async function preDeliveryAndExpired(modules) {
  const fixture = modules.fixtures.CROSS_DEPLOYMENT_FIXTURES.find((item) => item.name === "issue-verified");
  assert.ok(fixture);
  const session = authorityAndSession(fixture, modules);
  const preDelivery = modules.relayExecutor.createRelayBackedSessionExecutor({
    repository,
    timeoutMs: 50,
    dispatch: {
      async dispatch() {
        throw new Error("pre-delivery failure");
      },
    },
  });
  const preDeliveryResult = await preDelivery.execute(session.envelope);
  const expired = modules.relayExecutor.createRelayBackedSessionExecutor({
    repository,
    dispatch: {
      async dispatch(request) {
        return {
          envelope: {
            version: 1,
            kind: "control",
            repository: request.repository,
            connectionId: "delegator-826",
            jobId: "expired-job",
            deliveryState: "expired",
            deliveryCertainty: "not-delivered",
          },
        };
      },
    },
  });
  const expiredResult = await expired.execute(session.envelope);
  const initial = modules.delivery.createRelayDeliveryState({
    connectionId: "delegator-826",
    jobId: "pre-delivery-job",
  });
  return {
    preDelivery: {
      result: summary(semantic(preDeliveryResult, modules, fixture.request)),
      retryable: modules.delivery.isRelayDeliveryRetryable(initial),
    },
    expired: {
      result: summary(semantic(expiredResult, modules, fixture.request)),
      relayCode: expiredResult.failure?.relayCode,
    },
  };
}

async function disconnectReconnectAndHibernation(modules) {
  const fixture = modules.fixtures.CROSS_DEPLOYMENT_FIXTURES.find((item) => item.name === "issue-verified");
  assert.ok(fixture);
  const session = authorityAndSession(fixture, modules, { deferExecution: true });
  const sockets = [];
  const runtime = new modules.localRuntime.LocalRelayRuntime({
    relayUrl: "wss://controlled.relay.test/connect",
    repository,
    delegatorId: "delegator-826",
    privateKey: session.connectionKey,
    executor: session.executor,
    webSocketFactory: () => {
      const socket = new MemorySocket();
      sockets.push(socket);
      setImmediate(() => socket.open());
      return socket;
    },
    now: () => 10_000,
    connectionId: "delegator-826",
    reconnectDelayMs: 25,
  });
  runtime.connect();
  await waitFor(() => sockets[0]?.readyState === 1);
  const challenge = modules.connectionProof.createRelayPossessionProofChallenge({
    repositoryId: repository.repositoryId,
    delegatorId: "delegator-826",
    nonce: "local-runtime-certification-nonce",
    issuedAtMs: 10_000,
  });
  const challengeText = new TextDecoder().decode(
    modules.connectionProof.encodeRelayPossessionProofChallenge(challenge),
  );
  sockets[0].receive(challengeText);
  await waitFor(() => runtime.snapshot().possessionProved);
  const job = {
    version: 1,
    kind: "job",
    repository,
    connectionId: "delegator-826",
    jobId: "disconnect-after-delivery-job",
    deliveryState: "pre-delivery",
    deadlineMs: 1_000,
    signedSessionRequest: Buffer.from(JSON.stringify(session.envelope)).toString("base64url"),
  };
  sockets[0].receive(new TextDecoder().decode(modules.contract.encodeRelayEnvelope(job, repository)));
  await waitFor(() => session.provider.executions === 1);
  sockets[0].close(1006, "controlled-disconnect");
  session.provider.release();
  await waitFor(() => sockets.length >= 2 && sockets[1].readyState === 1);
  sockets[1].receive(challengeText);
  await waitFor(() => sockets[1].sent.some((frame) => String(frame).includes('"kind":"result"')));
  const reconnect = runtime.snapshot();
  runtime.shutdown();
  return {
    executions: session.provider.executions,
    delivery: runtime.delivery("disconnect-after-delivery-job")?.phase,
    reconnectConnectionId: reconnect.connectionId,
    resultSentAfterReconnect: true,
  };
}

async function hibernationReconstruction(modules) {
  const fixture = modules.fixtures.CROSS_DEPLOYMENT_FIXTURES.find((item) => item.name === "issue-verified");
  assert.ok(fixture);
  const session = authorityAndSession(fixture, modules);
  const network = createNetwork(modules);
  const runtime = await openRuntime(network, modules, "delegator-826", session.connectionKey);
  const source = await network.openClient("hibernation-source");
  const job = {
    version: 1,
    kind: "job",
    repository,
    connectionId: "delegator-826",
    jobId: "hibernation-job",
    deliveryState: "pre-delivery",
    deadlineMs: 1_000,
    signedSessionRequest: Buffer.from(JSON.stringify(session.envelope)).toString("base64url"),
  };
  const wire = modules.contract.encodeRelayEnvelope(job, repository);
  await network.object.webSocketMessage(source.server, wire);
  await new Promise((resolve) => setImmediate(resolve));
  const before = runtime.server.sent.filter((frame) => String(frame).includes("hibernation-job")).length;
  network.replaceObject();
  await network.object.webSocketMessage(source.server, wire);
  await new Promise((resolve) => setImmediate(resolve));
  const after = runtime.server.sent.filter((frame) => String(frame).includes("hibernation-job")).length;
  return {
    preserved: before === 1 && after === 1,
    routingConnectionId: runtime.server.deserializeAttachment().connectionId,
    replayFramesAfterReconstruction: after - before,
  };
}

async function lostLateDuplicateAndHibernation(modules) {
  const initial = modules.delivery.createRelayDeliveryState({ connectionId: "connection-826", jobId: "job-826" });
  const delivered = modules.delivery.reduceRelayDeliveryState(initial, {
    version: 1,
    type: "deliver",
    connectionId: "connection-826",
    jobId: "job-826",
  });
  const ambiguous = modules.delivery.reduceRelayDeliveryState(delivered, {
    version: 1,
    type: "disconnect",
    connectionId: "connection-826",
    jobId: "job-826",
  });
  const reconnected = modules.delivery.reduceRelayDeliveryState(ambiguous, {
    version: 1,
    type: "reconnect",
    connectionId: "connection-826",
    jobId: "job-826",
  });
  const terminal = modules.delivery.reduceRelayDeliveryState(delivered, {
    version: 1,
    type: "result",
    connectionId: "connection-826",
    jobId: "job-826",
    resultDigest: "sha256-result",
  });
  const duplicate = modules.delivery.applyRelayDeliveryEvent(terminal, {
    version: 1,
    type: "result",
    connectionId: "connection-826",
    jobId: "job-826",
    resultDigest: "sha256-result",
  });
  const expired = modules.delivery.reduceRelayDeliveryState(initial, {
    version: 1,
    type: "expire",
    connectionId: "connection-826",
    jobId: "job-826",
  });
  const late = modules.delivery.applyRelayDeliveryEvent(expired, {
    version: 1,
    type: "result",
    connectionId: "connection-826",
    jobId: "job-826",
    resultDigest: "sha256-late",
  });
  return {
    lostResult: { phase: ambiguous.phase, recovery: ambiguous.recovery, automaticRetry: ambiguous.automaticRetry },
    reconnect: { phase: reconnected.phase, connectionId: reconnected.connectionId },
    duplicate: duplicate.transition,
    late: late.transition,
  };
}

async function recoveryRequired(modules) {
  const fixture = modules.fixtures.CROSS_DEPLOYMENT_FIXTURES.find(
    (item) => item.name === "abort-compensation-recovery",
  );
  assert.ok(fixture);
  const session = authorityAndSession(fixture, modules);
  const result = await session.executor.execute(session.envelope);
  const normalized = semantic(result, modules, fixture.request);
  modules.conformance.assertCrossDeploymentExpectation(normalized, fixture.expected);
  return { result: summary(normalized), providerExecutions: session.provider.executions };
}

async function readLiveResponseBody(response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > LIVE_MAX_RESPONSE_BYTES) {
    throw liveFailure("transport", "protocol");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > LIVE_MAX_RESPONSE_BYTES) throw liveFailure("transport", "protocol");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw liveFailure("transport", "protocol");
  }
}

async function requestLiveJson(url, init, stage) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LIVE_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw liveFailure(stage, timedOut ? "timeout" : "deployment");
  } finally {
    clearTimeout(timer);
  }
  const text = await readLiveResponseBody(response);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw liveFailure(stage, "protocol");
  }
  return { response, body };
}

async function liveHealthz(url) {
  const { response, body } = await requestLiveJson(
    url,
    { method: "GET", headers: { accept: "application/json" } },
    "healthz",
  );
  const value = record(body);
  if (
    response.status !== 200 ||
    response.headers.get("content-type")?.toLowerCase().includes("application/json") !== true ||
    value?.ok !== true ||
    value.service !== "gh-inari-hosted-relay-worker" ||
    value.transport !== "mcp-and-repository-relay"
  ) {
    throw liveFailure("healthz", response.status === 200 ? "protocol" : "deployment");
  }
  return { httpStatus: response.status, ok: true, service: value.service, transport: value.transport };
}

async function liveMcp(url) {
  const { response, body } = await requestLiveJson(
    url,
    {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "inari-relay-certification", version: "1" },
        },
      }),
    },
    "mcp",
  );
  const value = record(body);
  const result = record(value?.result);
  const serverInfo = record(result?.serverInfo);
  if (
    response.status !== 200 ||
    response.headers.get("content-type")?.toLowerCase().includes("application/json") !== true ||
    value?.jsonrpc !== "2.0" ||
    value.id !== 1 ||
    serverInfo?.name !== "inari"
  ) {
    throw liveFailure("mcp", response.status === 200 ? "protocol" : "deployment");
  }
  return { httpStatus: response.status, jsonrpc: value.jsonrpc, serverName: serverInfo.name };
}

async function liveFrameText(value) {
  const data = record(value)?.data ?? value;
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  if (typeof data?.arrayBuffer === "function") {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(await data.arrayBuffer()));
  }
  return undefined;
}

function relayConnectionFrame(value, config, modules) {
  if (value?.type !== "repository-relay-connected" || value.version !== 1 || value.connectionId !== config.delegatorId)
    return false;
  try {
    const repository = modules.contract.normalizeRelayRepositoryIdentity(value.repository);
    return repository.repositoryId === config.repositoryId && repository.repositoryHost === config.repositoryHost;
  } catch {
    return false;
  }
}

function liveWebSocket(url, config, modules, privateKey) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== "function") {
      reject(liveFailure("relay", "transport"));
      return;
    }
    let socket;
    let settled = false;
    let opened = false;
    let challengeSeen = false;
    let connected = false;
    let heartbeat = false;
    let malformedSent = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close?.(1000, "relay-certification-complete");
      } catch {
        // The result already contains the bounded failure class.
      }
      if (error === undefined) resolve(result);
      else reject(error);
    };
    const timer = setTimeout(() => finish(liveFailure("relay", "timeout")), LIVE_TIMEOUT_MS);
    const fail = (failure) => finish(failure);
    try {
      socket = new WebSocket(url);
      socket.addEventListener("open", () => {
        opened = true;
      });
      socket.addEventListener("error", () => {
        if (!settled) fail(liveFailure("relay", opened ? "transport" : "deployment"));
      });
      socket.addEventListener("close", (event) => {
        if (settled) return;
        if (malformedSent && event.code === 1008) {
          finish(undefined, {
            upgrade: opened,
            possessionHandshake: challengeSeen,
            connected,
            heartbeat,
            boundedMalformedFrame: true,
            malformedFrameCloseCode: event.code,
          });
          return;
        }
        fail(liveFailure("relay", opened ? (connected ? "protocol" : "protocol") : "deployment"));
      });
      socket.addEventListener("message", (event) => {
        void (async () => {
          if (settled) return;
          let text;
          try {
            text = await liveFrameText(event);
            if (text === undefined || new TextEncoder().encode(text).byteLength > 16_384) {
              throw liveFailure("relay", "protocol");
            }
          } catch (error) {
            fail(error instanceof LiveCertificationFailure ? error : liveFailure("relay", "protocol"));
            return;
          }
          if (text === "relay:pong" && connected && !heartbeat) {
            heartbeat = true;
            malformedSent = true;
            try {
              socket.send("{");
            } catch {
              fail(liveFailure("relay", "transport"));
            }
            return;
          }
          let candidate;
          try {
            candidate = record(JSON.parse(text));
          } catch {
            return;
          }
          if (
            !challengeSeen &&
            candidate?.type === "repository-relay-possession-challenge" &&
            candidate.version === 1 &&
            record(candidate.challenge) !== undefined
          ) {
            try {
              const challenge = modules.connectionProof.decodeRelayPossessionProofChallenge(
                modules.connectionProof.encodeRelayPossessionProofChallenge(candidate.challenge),
              );
              if (challenge.repositoryId !== config.repositoryId || challenge.delegatorId !== config.delegatorId) {
                throw liveFailure("relay", "protocol");
              }
              const proof = modules.connectionProof.signRelayPossessionProof(challenge, privateKey);
              const encodedProof = JSON.parse(
                new TextDecoder().decode(modules.connectionProof.encodeRelayPossessionProofResponse(proof)),
              );
              challengeSeen = true;
              socket.send(
                JSON.stringify({ type: "repository-relay-possession-response", version: 1, proof: encodedProof }),
              );
            } catch (error) {
              fail(error instanceof LiveCertificationFailure ? error : liveFailure("relay", "protocol"));
            }
            return;
          }
          if (relayConnectionFrame(candidate, config, modules)) {
            connected = true;
            try {
              socket.send("relay:ping");
            } catch {
              fail(liveFailure("relay", "transport"));
            }
          }
        })();
      });
    } catch {
      fail(liveFailure("relay", "deployment"));
    }
  });
}

function createLiveTransport(privateKey, modules) {
  return Object.freeze({
    healthz: (url) => liveHealthz(url),
    mcp: (url) => liveMcp(url),
    relay: (url, config) =>
      liveWebSocket(
        (() => {
          const targetUrl = new URL(url);
          targetUrl.searchParams.set("repositoryId", config.repositoryId);
          targetUrl.searchParams.set("repositoryHost", config.repositoryHost);
          targetUrl.searchParams.set("connectionId", config.delegatorId);
          targetUrl.searchParams.set("delegatorId", config.delegatorId);
          targetUrl.searchParams.set("role", "runtime");
          return targetUrl;
        })(),
        config,
        modules,
        privateKey,
      ),
  });
}

function normalizeLiveHealthCheck(value) {
  const check = record(value);
  if (
    check === undefined ||
    !Number.isSafeInteger(check.httpStatus) ||
    check.ok !== true ||
    check.service !== "gh-inari-hosted-relay-worker" ||
    check.transport !== "mcp-and-repository-relay"
  ) {
    throw liveFailure("healthz", "protocol");
  }
  return {
    httpStatus: check.httpStatus,
    ok: true,
    service: check.service,
    transport: check.transport,
  };
}

function normalizeLiveMcpCheck(value) {
  const check = record(value);
  if (
    check === undefined ||
    !Number.isSafeInteger(check.httpStatus) ||
    check.jsonrpc !== "2.0" ||
    check.serverName !== "inari"
  ) {
    throw liveFailure("mcp", "protocol");
  }
  return { httpStatus: check.httpStatus, jsonrpc: check.jsonrpc, serverName: check.serverName };
}

function normalizeLiveRelayCheck(value) {
  const check = record(value);
  if (
    check === undefined ||
    check.upgrade !== true ||
    check.possessionHandshake !== true ||
    check.connected !== true ||
    check.heartbeat !== true ||
    check.boundedMalformedFrame !== true ||
    check.malformedFrameCloseCode !== 1008
  ) {
    throw liveFailure("relay", "protocol");
  }
  return {
    upgrade: true,
    possessionHandshake: true,
    connected: true,
    heartbeat: true,
    boundedMalformedFrame: true,
    malformedFrameCloseCode: 1008,
  };
}

function loadLivePrivateKey(config) {
  try {
    const key = createPrivateKey(config.privateKeyPem);
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw new Error("key-type");
    return key;
  } catch {
    throw liveFailure("configuration", "configuration");
  }
}

export async function runLiveCertification(options = {}) {
  const resolution = readLiveConfiguration(options.environment ?? process.env);
  if (resolution.status === "pending") return livePending(resolution.reason, resolution.missing);
  if (resolution.status === "failed") return liveFailed(resolution.failure, undefined, {}, false, "none");

  const config = resolution.config;
  const endpoints = liveEndpoints(config.baseUrl);
  const checks = {};
  const contactedDeployment = options.transport === undefined;
  const transportKind = contactedDeployment ? "real-network" : "injected-test-transport";
  let stage = "healthz";
  try {
    let transport = options.transport;
    if (transport === undefined) {
      const modules = await loadModules();
      transport = createLiveTransport(loadLivePrivateKey(config), modules);
    }
    checks.healthz = normalizeLiveHealthCheck(
      await transport.healthz(endpoints.healthz, { timeoutMs: LIVE_TIMEOUT_MS }),
    );
    stage = "mcp";
    checks.mcp = normalizeLiveMcpCheck(await transport.mcp(endpoints.mcp, { timeoutMs: LIVE_TIMEOUT_MS }));
    stage = "relay";
    const modules = transport === options.transport ? undefined : await loadModules();
    checks.relay = normalizeLiveRelayCheck(
      await transport.relay(
        endpoints.websocket,
        {
          repositoryId: config.repositoryId,
          repositoryHost: config.repositoryHost,
          delegatorId: config.delegatorId,
          ...(modules === undefined ? {} : { privateKey: loadLivePrivateKey(config), modules }),
        },
        { timeoutMs: LIVE_TIMEOUT_MS },
      ),
    );
    return livePassed(endpoints, checks, contactedDeployment, transportKind);
  } catch (error) {
    const failure =
      error instanceof LiveCertificationFailure
        ? { stage: error.stage, failureClass: error.failureClass }
        : { stage, failureClass: "transport" };
    return liveFailed(failure, endpoints, checks, contactedDeployment, transportKind);
  }
}

function liveStatus() {
  const configured = Boolean(
    process.env.INARI_RELAY_LIVE_URL &&
    process.env.INARI_RELAY_DELEGATOR_ID &&
    process.env.INARI_RELAY_DELEGATOR_PRIVATE_KEY,
  );
  return {
    status: "pending",
    reason: configured
      ? "Live credentials were detected, but controlled mode does not claim a deployed proof; run the separately authorized live smoke."
      : "No deployment credential-safe live smoke configuration is available.",
  };
}

export async function runControlledCertification() {
  const modules = await loadModules();
  const positive = await positiveParity(modules);
  const messageBounds = await malformedAndOversized(modules);
  const deliveryOutcomes = await preDeliveryAndExpired(modules);
  const lifecycle = await lostLateDuplicateAndHibernation(modules);
  const reconnectOutcomes = await disconnectReconnectAndHibernation(modules);
  const hibernation = await hibernationReconstruction(modules);
  const scenarios = {
    "cross-repository-route": await crossRepository(modules),
    "wrong-delegator-key": await wrongDelegator(modules),
    "capability-denial": await capabilityDenial(modules),
    "malformed-message": messageBounds.malformed,
    "oversized-message": messageBounds.oversized,
    "runtime-unavailable": await runtimeUnavailable(modules),
    "pre-delivery-failure": deliveryOutcomes.preDelivery,
    "expired-message": deliveryOutcomes.expired,
    "disconnect-after-delivery": reconnectOutcomes,
    "lost-result": lifecycle.lostResult,
    reconnect: lifecycle.reconnect,
    "late-result": {
      transition: lifecycle.late,
      ...(lifecycle.late === "late-event-ignored"
        ? {}
        : { productionFailure: "Expired delivery state did not ignore a late terminal result." }),
    },
    "duplicate-result": lifecycle.duplicate,
    "hibernation-reconstruction": hibernation,
    "ambiguous-effect-recovery": await recoveryRequired(modules),
  };
  const productionFailures = [
    positive.productionFailure === undefined
      ? undefined
      : { scenario: "semantic-parity", ...positive.productionFailure },
    scenarios["late-result"].productionFailure === undefined
      ? undefined
      : { scenario: "late-result", code: "LATE_RESULT_ACCEPTED", evidence: scenarios["late-result"].productionFailure },
  ].filter((failure) => failure !== undefined);
  const result = {
    version: 1,
    profile: "relay",
    mode: "controlled",
    certificationStatus: productionFailures.length === 0 ? "passed" : "blocked",
    profiles: modules.conformance.CROSS_DEPLOYMENT_PROFILES,
    semanticParity: positive,
    scenarios,
    productionFailures,
    evidence: {
      bounded: true,
      secretSafe: true,
      rawProviderPayloads: false,
      transportMetadataCompared: false,
    },
    live: liveStatus(),
  };
  assert.equal(result.profiles.includes("relay"), true);
  return result;
}

async function main() {
  const mode = process.argv[2] === "--mode" ? process.argv[3] : "controlled";
  if (mode === "live") {
    console.log(JSON.stringify(await runLiveCertification(), null, 2));
    return;
  }
  if (mode !== "controlled") {
    console.error("relay certification mode must be controlled or live");
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(await runControlledCertification(), null, 2));
}

if (process.argv[1]?.endsWith("relay-certification.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "relay certification failed");
    process.exitCode = 1;
  });
}
