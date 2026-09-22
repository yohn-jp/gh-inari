#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

// The certification command deliberately runs against the TypeScript source
// modules that are shipped by the Worker/package build. tsx is only the loader
// for this source-level oracle; it does not replace any production module.
register();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EPIC_REF = "origin/epic/840-inari-endpoint-dashboard";
const MAIN_REF = "origin/main";
const BRANCH = "test/958-endpoint-dashboard-certification";
const API_URL = "https://api.example.test";
const ENDPOINT_URL = "https://hosted.example.test";
const DASHBOARD_ORIGIN = "https://dashboard.example.test";
const REDIRECT_URI = `${DASHBOARD_ORIGIN}/oauth/callback`;
const PUBLIC_CLIENT_ID = "public-dashboard-client";
const APP_ID = "123456";
const APP_CLIENT_SECRET = "fixture-app-client-secret";
const APP_USER_ACCESS_TOKEN = "fixture-app-user-access-token";
const REFRESH_TOKEN = "fixture-refresh-token-never-returned";
const WEBHOOK_SECRET = "fixture-webhook-secret";
const REPOSITORY_ID = "1330755860";
const ROOT_ISSUE = 1;
const PULL_REQUEST = 101;
const REPOSITORY_NAME = "yohn-jp/gh-inari";
const BRANCH_NAME = "feat/1-certification-fixture";

let modulesPromise;

function fail(message) {
  throw new Error(`Endpoint/Dashboard certification failed: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function run(command, args) {
  try {
    return execFileSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    fail(`could not resolve repository state with ${command}`);
  }
}

function gitState() {
  const epicHeadSha = run("git", ["rev-parse", `${EPIC_REF}^{commit}`]);
  const currentMainSha = run("git", ["rev-parse", `${MAIN_REF}^{commit}`]);
  const headSha = run("git", ["rev-parse", "HEAD"]);
  const mergeBase = run("git", ["merge-base", "HEAD", EPIC_REF]);
  requireCondition(mergeBase === epicHeadSha, "certification branch is not based on the current Epic head");
  requireCondition(
    run("git", ["merge-base", MAIN_REF, EPIC_REF]) === currentMainSha,
    "the Epic does not contain the current origin/main base",
  );
  requireCondition(run("git", ["merge-base", MAIN_REF, EPIC_REF]) === currentMainSha, "main/Epic base drifted");
  requireCondition(run("git", ["rev-parse", "--abbrev-ref", "HEAD"]) === BRANCH, "certification branch is incorrect");
  return Object.freeze({ epicHeadSha, currentMainSha, headSha });
}

async function loadModules() {
  if (modulesPromise !== undefined) return modulesPromise;
  modulesPromise = Promise.all([
    import("../src/hosted-worker.ts"),
    import("../src/endpoint-api.ts"),
    import("../src/endpoint-http.ts"),
    import("../src/endpoint-authorization.ts"),
    import("../src/endpoint-runtime-presence.ts"),
    import("../src/endpoint-reconciliation.ts"),
    import("../src/endpoint-webhook.ts"),
    import("../src/implementation-contract.ts"),
    import("../apps/dashboard/src/auth.ts"),
    import("../apps/dashboard/src/endpoint-client.ts"),
    import("../apps/dashboard/src/main.ts"),
    import("../apps/dashboard/src/browser.ts"),
    import("../apps/dashboard/scripts/check-dependencies.mjs"),
  ]).then(
    ([
      hostedWorker,
      endpointApi,
      endpointHttp,
      authorization,
      presence,
      reconciliation,
      webhook,
      implementation,
      auth,
      client,
      dashboard,
      browser,
      dependencies,
    ]) => ({
      hostedWorker,
      endpointApi,
      endpointHttp,
      authorization,
      presence,
      reconciliation,
      webhook,
      implementation,
      auth,
      client,
      dashboard,
      browser,
      dependencies,
    }),
  );
  return modulesPromise;
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function endpointIdentity(deployment = "shared-hosted") {
  return Object.freeze({ version: 1, kind: "endpoint", id: "dashboard-endpoint", deployment });
}

function installationIdentity() {
  return Object.freeze({ version: 1, kind: "installation", endpointId: "dashboard-endpoint", installationId: "9001" });
}

function repositoryIdentity() {
  return Object.freeze({
    version: 1,
    kind: "repository",
    endpointId: "dashboard-endpoint",
    installationId: "9001",
    repositoryHost: "github.com",
    repositoryId: REPOSITORY_ID,
    nameWithOwner: REPOSITORY_NAME,
  });
}

function endpointRequest(operation, overrides = {}) {
  const endpoint = endpointIdentity();
  const installation = installationIdentity();
  const repository = repositoryIdentity();
  return {
    version: 1,
    operation,
    endpoint,
    installation,
    repository,
    capability: { kind: operation },
    ...overrides,
  };
}

function validImplementationBody(modules) {
  const contract = {
    version: 1,
    kind: "implementation",
    repository: { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, repository: REPOSITORY_NAME },
    sources: [
      { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, repository: REPOSITORY_NAME, number: ROOT_ISSUE },
    ],
    objective: "Exercise the composed read-only Endpoint boundary.",
    nonGoals: ["Provider mutation"],
    architecture: {
      decision: "Use the existing Endpoint and provider authorities.",
      affectedComponents: ["Endpoint certification"],
      invariants: ["Provider evidence remains read-only."],
      compatibilityConstraints: ["Existing product surfaces remain available."],
    },
    scope: { readOnly: ["src/**"], write: [], create: [], delete: [], deny: ["src/agent-authority/**"] },
    constraints: {
      prohibitedOperations: ["Do not mutate the provider."],
      immutableAreas: ["Production source"],
      prerequisites: ["Controlled certification fixture."],
    },
    verification: {
      acceptanceCriteria: ["The composed read boundary returns bounded evidence."],
      targetedTests: ["controlled fixture"],
      requiredChecks: ["verify"],
      postconditions: ["No raw credential is retained."],
    },
    execution: {
      baseBranch: "main",
      baseRevision: "a".repeat(40),
      baseFreshness: "controlled fixture",
      branch: BRANCH_NAME,
      dependencies: [],
    },
  };
  const result = modules.implementation.validateImplementationContract(contract);
  requireCondition(result.valid && result.contract !== undefined, "fixture Implementation contract is invalid");
  return modules.implementation.renderImplementationIssueBody(result.contract);
}

function githubIssue(body) {
  return {
    number: ROOT_ISSUE,
    title: "feat: certification fixture",
    body,
    state: "open",
    html_url: `https://github.com/${REPOSITORY_NAME}/issues/${ROOT_ISSUE}`,
    labels: [{ name: "implementation" }],
    assignees: [],
  };
}

function githubPullRequest() {
  return {
    number: PULL_REQUEST,
    title: "Certification fixture pull request",
    body: "Controlled semantic pull-request evidence.",
    state: "open",
    draft: false,
    html_url: `https://github.com/${REPOSITORY_NAME}/pull/${PULL_REQUEST}`,
    user: { login: "certification-user" },
    head: { ref: BRANCH_NAME, sha: "b".repeat(40) },
    base: { ref: "main", sha: "a".repeat(40) },
    labels: [],
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
  };
}

function createProvider(modules, options = {}) {
  const requests = [];
  const implementationBody = validImplementationBody(modules);
  const issueBody = options.simpleIssueBody === true ? "Controlled certification fixture." : implementationBody;
  const pullRequest = githubPullRequest();
  const fetcher = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const method = request.method;
    const authorization = request.headers.get("authorization");
    requests.push({ path: url.pathname, search: url.search, method, authorization });

    if (url.pathname === "/login/oauth/access_token") {
      const form = new URLSearchParams(await request.text());
      requireCondition(form.get("client_id") === PUBLIC_CLIENT_ID, "OAuth exchange used the wrong public client");
      requireCondition(
        form.get("client_secret") === APP_CLIENT_SECRET,
        "OAuth exchange did not reach the provider boundary",
      );
      requireCondition(form.get("code_verifier") !== null, "OAuth exchange omitted the PKCE verifier");
      return jsonResponse({
        access_token: APP_USER_ACCESS_TOKEN,
        token_type: "bearer",
        expires_in: 900,
        refresh_token: REFRESH_TOKEN,
      });
    }
    if (url.pathname === "/user") {
      return jsonResponse({ id: 42, login: "certification-user" }, options.userStatus ?? 200);
    }
    if (url.pathname === "/user/installations") {
      return jsonResponse({ installations: [{ id: 9001, app_id: Number(APP_ID), suspended_at: null }] });
    }
    if (url.pathname === "/user/installations/9001/repositories") {
      return jsonResponse({ repositories: [{ id: Number(REPOSITORY_ID), full_name: REPOSITORY_NAME }] });
    }

    if (url.pathname.startsWith(`/repos/${REPOSITORY_NAME}`)) {
      requireCondition(method === "GET", "the composed Endpoint attempted a provider mutation");
      if (options.providerUnavailable) return jsonResponse({}, 503);
      const suffix = `${url.pathname}${url.search}`.slice(`/repos/${REPOSITORY_NAME}`.length).replace(/^\//u, "");
      if (suffix === "" || suffix === "") {
        if (options.crossRepository) {
          return jsonResponse({ id: "999999999", full_name: "other/repository", default_branch: "main", fork: false });
        }
        return jsonResponse({
          id: Number(REPOSITORY_ID),
          full_name: REPOSITORY_NAME,
          default_branch: "main",
          fork: false,
        });
      }
      if (suffix === "git/ref/heads/main") {
        return jsonResponse({ ref: "refs/heads/main", object: { type: "commit", sha: "a".repeat(40) } });
      }
      if (suffix.includes("git/ref/heads/feat%2F") || suffix.includes("git/ref/heads/feat/")) {
        return jsonResponse({ ref: `refs/heads/${BRANCH_NAME}`, object: { type: "commit", sha: "b".repeat(40) } });
      }
      if (suffix.startsWith("git/trees/")) return jsonResponse({ sha: "tree-fixture", tree: [], truncated: false });
      if (suffix.startsWith("git/blobs/"))
        return jsonResponse({ sha: suffix.slice("git/blobs/".length), encoding: "base64", content: "" });
      if (suffix === `issues/${ROOT_ISSUE}`) return jsonResponse(githubIssue(issueBody));
      if (suffix === `issues/${ROOT_ISSUE}/dependencies/blocked_by`) return jsonResponse([]);
      if (suffix === `issues/${ROOT_ISSUE}/comments`) return jsonResponse([]);
      if (suffix === `pulls/${PULL_REQUEST}`) return jsonResponse(pullRequest);
      if (suffix === `issues/${PULL_REQUEST}/comments`) return jsonResponse([]);
      if (suffix === `pulls/${PULL_REQUEST}/comments`) return jsonResponse([]);
      if (suffix === `pulls/${PULL_REQUEST}/reviews`) return jsonResponse([]);
      if (suffix === `pulls/${PULL_REQUEST}/files`) return jsonResponse([]);
      if (suffix.startsWith("commits/") && suffix.endsWith("/check-runs")) return jsonResponse({ check_runs: [] });
      if (suffix.startsWith("commits/") && suffix.endsWith("/status")) return jsonResponse({ statuses: [] });
      if (suffix.startsWith("branches/") && suffix.includes("/protection/")) return jsonResponse({}, 404);
      if (suffix.startsWith("branches?")) return jsonResponse([]);
      if (suffix.startsWith("pulls?")) return jsonResponse([pullRequest]);
      if (suffix.startsWith("pulls")) return jsonResponse([]);
      if (suffix.startsWith("issues/")) return jsonResponse({}, 404);
      return jsonResponse({}, 404);
    }
    return jsonResponse({}, 404);
  };
  return Object.freeze({ requests, fetch: fetcher });
}

function relaySnapshot(mode = "healthy") {
  const now = Date.now();
  const repository = { repositoryHost: "github.com", repositoryId: REPOSITORY_ID };
  if (mode === "cross-repository")
    return {
      version: 1,
      repository: { ...repository, repositoryId: "999999999" },
      availability: "available",
      observedAtMs: now,
      records: [],
    };
  if (mode === "malformed") return { malformed: true };
  if (mode === "stale") {
    return {
      version: 1,
      repository,
      availability: "available",
      observedAtMs: now - 900_000,
      records: [
        {
          version: 1,
          repository,
          connectionId: "runtime-a",
          delegatorId: "delegator-a",
          generation: 1,
          state: "connected",
          authenticated: true,
          current: true,
          openedAtMs: now - 1_000_000,
          expiresAtMs: now + 60_000,
          observedAtMs: now - 900_000,
        },
      ],
    };
  }
  return {
    version: 1,
    repository,
    availability: "available",
    observedAtMs: now,
    records: [
      {
        version: 1,
        repository,
        connectionId: "runtime-a",
        delegatorId: "delegator-a",
        generation: 1,
        state: "connected",
        authenticated: true,
        current: true,
        openedAtMs: now - 1_000,
        expiresAtMs: now + 60_000,
        observedAtMs: now,
      },
      {
        version: 1,
        repository,
        connectionId: "runtime-b",
        delegatorId: "delegator-b",
        generation: 2,
        state: "connected",
        authenticated: true,
        current: true,
        openedAtMs: now - 1_000,
        expiresAtMs: now + 60_000,
        observedAtMs: now,
      },
    ],
  };
}

function relayNamespace(mode = "healthy") {
  const ids = [];
  return Object.freeze({
    ids,
    idFromName(name) {
      ids.push(name);
      return `relay:${name}`;
    },
    get(id) {
      requireCondition(
        id === `relay:${REPOSITORY_ID}`,
        "Relay Durable Object was not selected by immutable repository ID",
      );
      return {
        async fetch() {
          if (mode === "unavailable") throw new Error("controlled Relay unavailable");
          if (mode === "malformed") return new Response("not-json", { status: 200 });
          return jsonResponse(relaySnapshot(mode));
        },
      };
    },
  });
}

function createEnvironment(provider, options = {}) {
  const assets = options.assets ?? { fetch: async () => new Response("SPA_ASSET", { status: 200 }) };
  return {
    REPOSITORY_RELAY: relayNamespace(options.relayMode ?? "healthy"),
    ASSETS: assets,
    INARI_ENDPOINT_ID: "dashboard-endpoint",
    INARI_ENDPOINT_DEPLOYMENT: "shared-hosted",
    INARI_HOSTED_REPOSITORY_HOST: "github.com",
    INARI_GITHUB_APP_ID: APP_ID,
    INARI_GITHUB_APP_CLIENT_ID: PUBLIC_CLIENT_ID,
    INARI_GITHUB_APP_SLUG: "inari-certification",
    INARI_GITHUB_APP_INSTALLATION_URL: "https://github.com/apps/inari-certification/installations/new",
    INARI_GITHUB_APP_USER_AUTH_PROFILE: "app-user-token",
    INARI_GITHUB_APP_CALLBACK_URL: REDIRECT_URI,
    INARI_GITHUB_APP_CLIENT_SECRET: APP_CLIENT_SECRET,
    INARI_GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    endpointOAuth: {
      clientId: PUBLIC_CLIENT_ID,
      clientSecret: APP_CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      fetch: provider.fetch,
    },
  };
}

async function withProvider(provider, operation) {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.GITHUB_API_URL;
  globalThis.fetch = provider.fetch;
  process.env.GITHUB_API_URL = API_URL;
  try {
    return await operation();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = previousApiUrl;
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    fail(`Worker returned non-JSON status ${response.status}`);
  }
}

async function endpointCall(worker, env, body, token = APP_USER_ACCESS_TOKEN) {
  return worker.fetch(
    new Request(`${ENDPOINT_URL}/v1/endpoint`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.get(key) ?? null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }
}

function deterministicCrypto() {
  let value = 1;
  return {
    getRandomValues(bytes) {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = value++ % 251;
      return bytes;
    },
    subtle: globalThis.crypto.subtle,
  };
}

async function signWebhook(body) {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function webhookPayload(repository = REPOSITORY_NAME, repositoryId = REPOSITORY_ID, state = "ignored") {
  return JSON.stringify({
    action: "completed",
    installation: { id: 9001 },
    repository: { id: Number(repositoryId), full_name: repository },
    state,
  });
}

async function certifySharedHosted(modules) {
  const provider = createProvider(modules);
  const assets = {
    calls: [],
    fetch: async (request) => {
      assets.calls.push(new URL(request.url).pathname);
      return new Response("SPA_ASSET", { status: 200 });
    },
  };
  const env = createEnvironment(provider, { assets });
  requireCondition(!("endpointApi" in env), "shared-hosted fixture supplied the test-only env.endpointApi injection");
  const worker = modules.hostedWorker.default;
  const dashboardCalls = [];
  return withProvider(provider, async () => {
    const fetcher = async (input, init) => {
      const request = new Request(input, init);
      dashboardCalls.push({ path: new URL(request.url).pathname, method: request.method });
      return worker.fetch(request, env);
    };
    const storage = new MemoryStorage();
    let clock = 1_000_000;
    const auth = modules.auth.createDashboardAuth({
      clientId: PUBLIC_CLIENT_ID,
      redirectUri: REDIRECT_URI,
      exchangeEndpoint: `${ENDPOINT_URL}/v1/auth/github/exchange`,
      fetch: fetcher,
      storage,
      crypto: deterministicCrypto(),
      now: () => clock,
    });
    const authorizationUrl = new URL(await auth.beginAuthorization());
    requireCondition(
      authorizationUrl.searchParams.get("response_type") === "code",
      "Dashboard did not start OAuth code flow",
    );
    requireCondition(
      authorizationUrl.searchParams.get("code_challenge_method") === "S256",
      "Dashboard did not use S256 PKCE",
    );
    const pending = JSON.parse(storage.getItem("inari.dashboard.oauth.pending"));
    const challenge = Buffer.from(
      new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.verifier))),
    ).toString("base64url");
    requireCondition(
      authorizationUrl.searchParams.get("code_challenge") === challenge,
      "Dashboard PKCE challenge did not bind the verifier",
    );
    const callback = new URL(REDIRECT_URI);
    callback.searchParams.set("code", "fixture-authorization-code");
    callback.searchParams.set("state", authorizationUrl.searchParams.get("state"));
    const token = await auth.handleCallback(callback);
    requireCondition(token.accessToken === APP_USER_ACCESS_TOKEN, "Dashboard did not receive the App-user token");
    requireCondition(auth.getAccessToken() === APP_USER_ACCESS_TOKEN, "Dashboard did not retain the token in memory");
    requireCondition(
      storage.getItem("inari.dashboard.oauth.pending") === null,
      "Dashboard retained PKCE state after exchange",
    );
    requireCondition(JSON.stringify(token).includes(REFRESH_TOKEN) === false, "Dashboard received a refresh token");
    const exchange = provider.requests.find((request) => request.path === "/login/oauth/access_token");
    requireCondition(exchange?.method === "POST", "PKCE exchange did not reach the provider token endpoint");

    const application = modules.dashboard.createDashboardApplication({ endpoint: ENDPOINT_URL, auth, fetch: fetcher });
    const repositoryResult = await application.read(endpointRequest("repository.read"));
    requireCondition(repositoryResult.ok === true, "shared-hosted /v1/endpoint repository composition failed");
    requireCondition(
      repositoryResult.data.presence?.runtimes.length === 2,
      "shared-hosted Endpoint did not preserve independent Runtime identities",
    );
    requireCondition(
      repositoryResult.data.presence?.authoritative === false,
      "Relay presence was treated as authorization authority",
    );

    const workResult = await application.read(endpointRequest("work.read", { query: { rootIssue: ROOT_ISSUE } }));
    requireCondition(workResult.ok === true, "shared-hosted rooted work read failed");
    requireCondition(
      workResult.authorization.request?.capability.kind === "work.read",
      "Endpoint did not authorize the declared read capability",
    );
    requireCondition(
      workResult.data.work?.frontier !== undefined,
      `work read did not expose Frontier authority evidence (data=${Object.keys(workResult.data ?? {})
        .sort()
        .join(
          ",",
        )}, unavailable=${(workResult.data?.unavailable ?? []).map((entry) => entry.resource).join(",")}, diagnostics=${(
        workResult.data?.unavailable ?? []
      )
        .flatMap((entry) => entry.diagnostics ?? [])
        .map((entry) => entry.code ?? "unknown")
        .join(",")}, providerPaths=${provider.requests.map((request) => request.path).join("|")})`,
    );
    requireCondition(
      workResult.data.work?.evidence.semanticPullRequests !== undefined,
      "work read omitted Semantic authority evidence",
    );
    requireCondition(
      workResult.data.work?.evidence.operationalIssues !== undefined,
      "work read omitted Operational authority evidence",
    );
    requireCondition(
      workResult.data.work?.evidence.changes !== undefined,
      "work read omitted Change authority evidence",
    );
    requireCondition(
      workResult.data.work?.items[0]?.reference.number === ROOT_ISSUE,
      "work read escaped its exact root Issue",
    );
    requireCondition(
      !provider.requests.some((request) => request.path.includes("/issues/2")),
      "work read expanded beyond its admitted root",
    );

    const beforeInvalid = provider.requests.length;
    const missingRoot = await endpointCall(worker, env, endpointRequest("work.read"));
    requireCondition(missingRoot.status === 400, "work.read without rootIssue was accepted");
    requireCondition(provider.requests.length === beforeInvalid, "invalid rooted read reached the provider");
    const mutation = await endpointCall(
      worker,
      env,
      endpointRequest("change.merge", { capability: { kind: "change.merge" } }),
    );
    requireCondition(mutation.status === 422, "Endpoint exposed an Agent mutation operation");
    requireCondition(provider.requests.length === beforeInvalid, "Agent mutation claim reached the provider boundary");

    const selfEvidence = {
      version: 1,
      authenticated: true,
      principal: { version: 1, kind: "human", id: "github-user:42" },
      endpoint: endpointIdentity("self-hosted"),
      installation: installationIdentity(),
      repository: repositoryIdentity(),
      capabilities: [{ kind: "repository.read" }],
    };
    const selfApi = modules.endpointApi.createEndpointApi({
      authentication: { authenticate: async () => selfEvidence },
      readPresence: async (request) =>
        modules.presence.projectEndpointRuntimePresence({
          endpoint: request.endpoint,
          repository: request.repository,
          now: Date.now(),
          relay: relaySnapshot("healthy"),
        }),
    });
    const selfHandler = modules.endpointHttp.createEndpointHttpHandler(selfApi);
    const selfResponse = await selfHandler(
      new Request(`${ENDPOINT_URL}/v1/endpoint`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...endpointRequest("repository.read"), endpoint: endpointIdentity("self-hosted") }),
      }),
    );
    const selfResult = await readJson(selfResponse);
    requireCondition(selfResult.ok === true, "self-hosted injected Endpoint ports did not produce the API contract");
    requireCondition(
      selfResult.data.repository.repositoryId === REPOSITORY_ID,
      "self-hosted API changed repository identity semantics",
    );

    requireCondition(
      dashboardCalls.every(({ path }) => path === "/v1/auth/github/exchange" || path === "/v1/endpoint"),
      "Dashboard made a non-Endpoint data call",
    );
    return Object.freeze({ provider, env, worker, dashboardCalls, workResult });
  });
}

async function certifyWebhook(modules) {
  const body = webhookPayload();
  const signature = await signWebhook(body);
  const endpoint = endpointIdentity();
  const installation = installationIdentity();
  const repository = repositoryIdentity();
  const hints = [];
  const replay = new modules.webhook.EndpointWebhookReplayGuard();
  const handler = modules.webhook.createEndpointWebhookHandler({
    admission: {
      secret: WEBHOOK_SECRET,
      endpoint,
      installation,
      repository,
      repositoryHost: "github.com",
      replay,
      now: new Date().toISOString(),
    },
    onHint: async (hint) => hints.push(Object.freeze({ ...hint })),
  });
  requireCondition(
    await modules.webhook.verifyGitHubWebhookSignature(WEBHOOK_SECRET, body, signature),
    "valid webhook signature was rejected",
  );
  requireCondition(
    !(await modules.webhook.verifyGitHubWebhookSignature(WEBHOOK_SECRET, body, `${signature}0`)),
    "malformed webhook signature was accepted",
  );
  const first = await handler(
    new Request("https://hosted.example.test/v1/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-delivery": "delivery-958",
        "x-github-event": "repository",
      },
      body,
    }),
  );
  const firstBody = await readJson(first);
  requireCondition(first.status === 202 && firstBody.classification === "admitted", "signed webhook admission failed");
  requireCondition(
    Object.keys(hints[0] ?? {})
      .sort()
      .join(",") === "endpointId,id,installationId,occurredAt,repositoryId",
    "webhook handoff exposed payload authority",
  );
  requireCondition(
    JSON.stringify(firstBody).includes(WEBHOOK_SECRET) === false &&
      JSON.stringify(firstBody).includes('"state"') === false,
    "webhook response retained secret or raw payload evidence",
  );
  const duplicate = await handler(
    new Request("https://hosted.example.test/v1/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-delivery": "delivery-958",
      },
      body,
    }),
  );
  requireCondition(
    duplicate.status === 200 && (await readJson(duplicate)).classification === "duplicate",
    "duplicate webhook delivery was not bounded",
  );
  const changedBody = webhookPayload(REPOSITORY_NAME, REPOSITORY_ID, "changed");
  const changedSignature = await signWebhook(changedBody);
  const replayResponse = await handler(
    new Request("https://hosted.example.test/v1/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": changedSignature,
        "x-github-delivery": "delivery-958",
      },
      body: changedBody,
    }),
  );
  requireCondition(
    replayResponse.status === 409 && (await readJson(replayResponse)).classification === "replay",
    "webhook replay evidence was accepted",
  );
  const malformedBody = "not-json";
  const malformed = await modules.webhook.admitEndpointWebhook(
    { body: malformedBody, signature: await signWebhook(malformedBody), deliveryId: "delivery-malformed" },
    { secret: WEBHOOK_SECRET, endpoint, repositoryHost: "github.com" },
  );
  requireCondition(malformed.classification === "rejected", "malformed webhook payload was accepted");
  const crossBody = webhookPayload("other/repository", "999999999");
  const crossSignature = await signWebhook(crossBody);
  const cross = await modules.webhook.admitEndpointWebhook(
    { body: crossBody, signature: crossSignature, deliveryId: "delivery-cross" },
    { secret: WEBHOOK_SECRET, endpoint, installation, repository, repositoryHost: "github.com" },
  );
  requireCondition(cross.classification === "rejected", "cross-repository webhook evidence was accepted");
  const observation = modules.reconciliation.createEndpointObservation({ key: `github.com/${REPOSITORY_ID}` });
  const handed = modules.webhook.handoffEndpointWebhookHint(
    observation,
    await modules.webhook.admitEndpointWebhook(
      { body, signature, deliveryId: "delivery-hint" },
      { secret: WEBHOOK_SECRET, endpoint, repositoryHost: "github.com" },
    ),
  );
  requireCondition(
    handed.authoritative === null && handed.pendingHints.length === 1,
    "webhook payload became authoritative state",
  );
  let cancelled = false;
  let chunks = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (chunks++ === 0) controller.enqueue(new Uint8Array(modules.webhook.ENDPOINT_WEBHOOK_LIMITS.bodyBytes));
      else if (chunks === 2) controller.enqueue(Uint8Array.of(1));
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const oversized = await handler(
    new Request("https://hosted.example.test/v1/webhooks/github", { method: "POST", body: stream, duplex: "half" }),
  );
  requireCondition(oversized.status === 413 && cancelled, "webhook streaming body bound was not enforced");

  const provider = createProvider(modules);
  const env = createEnvironment(provider);
  const workerBody = await modules.hostedWorker.default.fetch(
    new Request("https://hosted.example.test/v1/webhooks/github", {
      method: "POST",
      headers: {
        "x-hub-signature-256": signature,
        "x-github-delivery": "worker-delivery-958",
        "x-github-event": "repository",
      },
      body,
    }),
    env,
  );
  requireCondition(workerBody.status === 202, "Worker webhook route did not exercise production admission");
  return Object.freeze({ replaySize: replay.size, workerStatus: workerBody.status });
}

async function certifyFailureFreshness(modules, shared) {
  const now = "2026-09-22T00:00:00.000Z";
  const prior = modules.reconciliation.applyEndpointAuthoritativeSnapshot(
    modules.reconciliation.createEndpointObservation({ key: `github.com/${REPOSITORY_ID}` }),
    { value: { repository: repositoryIdentity() }, revision: "old", observedAt: "2026-09-20T00:00:00.000Z" },
    { now, maxAgeMs: 1_000 },
  );
  const stale = await modules.reconciliation.reconcileEndpointObservation(
    prior,
    async () => {
      throw new Error("controlled provider unavailable");
    },
    { now, maxAgeMs: 1_000 },
  );
  requireCondition(stale.state === "stale", "stale GitHub evidence was collapsed into an unavailable/current value");
  const endpoint = endpointIdentity();
  const evidence = {
    version: 1,
    authenticated: true,
    principal: { version: 1, kind: "human", id: "github-user:42" },
    endpoint,
    installation: installationIdentity(),
    repository: repositoryIdentity(),
    capabilities: [{ kind: "repository.read" }],
  };
  const unavailableApi = modules.endpointApi.createEndpointApi({
    authentication: { authenticate: async () => evidence },
    readWork: async () => ({ ...shared.workResult.data.work, freshness: stale }),
    readPresence: async () => ({ status: "unavailable", diagnostics: [] }),
  });
  const response = await modules.endpointHttp.createEndpointHttpHandler(unavailableApi)(
    new Request(`${ENDPOINT_URL}/v1/endpoint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(endpointRequest("repository.read", { query: { rootIssue: ROOT_ISSUE } })),
    }),
  );
  const result = await readJson(response);
  requireCondition(
    result.ok === true && result.data.work.freshness.state === "stale",
    "stale Endpoint evidence was not preserved in the API contract",
  );
  requireCondition(
    result.data.unavailable.some((entry) => entry.resource === "presence"),
    "unavailable Relay evidence was not explicit",
  );
}

async function certifyRelayAndProviderFailures(modules) {
  const worker = modules.hostedWorker.default;
  for (const mode of ["stale", "unavailable", "malformed", "cross-repository"]) {
    const provider = createProvider(modules);
    const env = createEnvironment(provider, { relayMode: mode });
    const response = await withProvider(provider, () => endpointCall(worker, env, endpointRequest("repository.read")));
    const result = await readJson(response);
    requireCondition(result.ok === true, `${mode} Relay evidence did not return the read contract`);
    requireCondition(result.data.presence.state !== "connected", `${mode} Relay evidence became current presence`);
    if (mode === "stale") {
      requireCondition(result.data.presence.state === "stale", "stale Relay evidence lost its explicit stale state");
      requireCondition(
        result.data.presence.runtimes.some((runtime) => runtime.state === "stale"),
        "stale Relay runtime evidence was not preserved",
      );
    } else {
      requireCondition(
        result.data.presence.state === "unknown",
        `${mode} Relay evidence was not explicit unavailable state`,
      );
      requireCondition(
        result.data.presence.runtimes.length === 0,
        `${mode} Relay evidence became an empty current state`,
      );
    }
  }
  const provider = createProvider(modules, { providerUnavailable: true });
  const env = createEnvironment(provider);
  const response = await withProvider(provider, () =>
    endpointCall(worker, env, endpointRequest("work.read", { query: { rootIssue: ROOT_ISSUE } })),
  );
  const result = await readJson(response);
  requireCondition(
    response.status === 503 ||
      (result.ok === true && result.data.unavailable.some((entry) => entry.resource === "work")),
    "unavailable provider evidence became a successful empty work state",
  );
}

async function certifyDashboardBoundary(modules) {
  const dashboardSource = path.join(repoRoot, "apps", "dashboard", "src");
  const violations = modules.dependencies.findDashboardDependencyViolations(dashboardSource);
  requireCondition(
    violations.length === 0,
    "Dashboard dependency guard found a direct provider/Relay/Session/Change import",
  );
  const dashboardDist = path.join(repoRoot, "apps", "dashboard", "dist");
  if (
    !fs.existsSync(path.join(dashboardDist, "index.html")) ||
    !fs.existsSync(path.join(dashboardDist, "browser.js"))
  ) {
    execFileSync("pnpm", ["--dir", "apps/dashboard", "build"], { cwd: repoRoot, stdio: "inherit" });
  }
  const shell = fs.readFileSync(path.join(dashboardDist, "index.html"), "utf8");
  const browser = fs.readFileSync(path.join(dashboardDist, "browser.js"), "utf8");
  requireCondition(shell.includes("data-dashboard-shell"), "built Dashboard shell is missing");
  requireCondition(
    browser.includes("code_challenge") && browser.includes("/v1/endpoint"),
    "built Dashboard does not contain the PKCE/Endpoint flow",
  );
  for (const secret of [APP_CLIENT_SECRET, APP_USER_ACCESS_TOKEN, REFRESH_TOKEN, WEBHOOK_SECRET]) {
    requireCondition(
      !browser.includes(secret) && !shell.includes(secret),
      "built Dashboard assets retain a credential value",
    );
  }
  requireCondition(!/-----BEGIN [A-Z ]+PRIVATE KEY-----/u.test(browser), "built Dashboard assets retain a private key");
  requireCondition(!browser.includes("client_secret"), "built Dashboard assets contain the server OAuth secret field");
}

async function certifyWorkerFirstRouting(modules) {
  const provider = createProvider(modules);
  const assets = {
    calls: [],
    fetch: async (request) => {
      assets.calls.push(new URL(request.url).pathname);
      return new Response("SPA_ASSET", { status: 200 });
    },
  };
  const env = createEnvironment(provider, { assets });
  const worker = modules.hostedWorker.default;
  const paths = ["/mcp", "/v1/unknown", "/.well-known/unknown", "/healthz"];
  for (const pathname of paths) {
    const response = await withProvider(provider, () =>
      worker.fetch(
        new Request(`https://hosted.example.test${pathname}`, { method: pathname === "/healthz" ? "GET" : "POST" }),
        env,
      ),
    );
    requireCondition(
      response.status !== 200 || (await response.text()) !== "SPA_ASSET",
      `${pathname} fell through to SPA assets`,
    );
  }
  const dashboardResponse = await worker.fetch(
    new Request("https://hosted.example.test/dashboard", { method: "GET" }),
    env,
  );
  requireCondition(
    dashboardResponse.status === 200 && (await dashboardResponse.text()) === "SPA_ASSET",
    "Dashboard asset route was not served by Static Assets",
  );
  requireCondition(
    assets.calls.length === 1 && assets.calls[0] === "/dashboard",
    "Worker-first API/MCP/well-known/health routing invoked SPA assets",
  );
}

export async function runEndpointDashboardCertification() {
  const state = gitState();
  const modules = await loadModules();
  const shared = await certifySharedHosted(modules);
  await certifyWebhook(modules);
  await certifyFailureFreshness(modules, shared);
  await certifyRelayAndProviderFailures(modules);
  await certifyDashboardBoundary(modules);
  await certifyWorkerFirstRouting(modules);
  return Object.freeze({
    version: 1,
    profile: "endpoint-dashboard",
    certificationStatus: "passed",
    epicHeadSha: state.epicHeadSha,
    currentMainSha: state.currentMainSha,
    branch: BRANCH,
    evidence: {
      bounded: true,
      secretSafe: true,
      rawProviderPayloads: false,
      providerMutations: false,
      checks: [
        "shared-hosted-endpoint",
        "self-hosted-contract",
        "webhook-admission",
        "dashboard-boundary",
        "worker-first-routing",
        "freshness-failures",
      ],
    },
  });
}

async function main() {
  try {
    process.stdout.write(`${JSON.stringify(await runEndpointDashboardCertification(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Endpoint/Dashboard certification failed."}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("endpoint-dashboard-certification.mjs")) main();
