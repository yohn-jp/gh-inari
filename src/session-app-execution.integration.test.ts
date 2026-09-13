import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  canonicalRuntimeAuthorityJson,
  createManagedSession,
  generateRuntimeAuthorityKeyPair,
  issueSessionCertificate,
  renderRuntimeAuthorityArtifact,
  signSessionRequest,
  type CapabilityClaim,
  type RuntimeAuthority,
  type SemanticSessionRequest,
} from "./agent-authority/index.js";
import { assertRuntimeAuthority } from "./agent-authority/runtime-authority.js";
import { createDirectAppSessionExecutor } from "./github/direct-app-execution.js";
import type { GitHubChangeEffectRepository } from "./github/change-effect-adapter.js";

const NOW = new Date("2026-09-13T00:00:30.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const REPOSITORY: GitHubChangeEffectRepository = { hostname: "github.com", owner: "acme", name: "inari" };
const REPOSITORY_ID = "123456789";
const APP_ID = "123";
const INSTALLATION_ID = "456";
const REPOSITORY_NODE_ID = "R_kgDO123456789";
const AUTHORITY_ID = "session-app-integration";
const POLICY_SHA = "a".repeat(40);
const POLICY_TREE_SHA = "b".repeat(40);
const POLICY_BLOB_SHA = "c".repeat(40);
const BRANCH = "feat/465-session-authorized-change-execution";
const ISSUE = 465;
const PULL_REQUEST = 4650;
const EXPECTED_HEAD = "d".repeat(40);
const STALE_HEAD = "e".repeat(40);
const RESULTING_HEAD = "f".repeat(40);
const BRANCH_TREE_SHA = "1".repeat(40);
const STALE_TREE_SHA = "2".repeat(40);
const EXPECTED_TREE_SHA = "3".repeat(40);
const RESULTING_TREE_SHA = "4".repeat(40);
const BASE_BLOB_SHA = "5".repeat(40);
const UNRELATED_BLOB_SHA = "6".repeat(40);
const PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

type ProviderMode = "abort" | "abort-timeout-after-close" | "branch-success" | "branch-stale";

interface SessionFixture {
  readonly authority: RuntimeAuthority;
  readonly envelope: unknown;
  readonly runtimePrivateKeyPem: string;
}

interface ProviderState {
  runtimeAuthority: RuntimeAuthority;
  branchPresent: boolean;
  branchSha: string;
  pullRequestState: "open" | "closed";
  pullRequestDraft: boolean;
  readonly calls: readonly { readonly method: string; readonly path: string }[];
  readonly authorizationHeaders: readonly string[];
}

interface ProviderFixture {
  readonly fetch: typeof globalThis.fetch;
  readonly state: ProviderState;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function blobSha(content: string): string {
  const bytes = Buffer.from(content, "base64");
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`, "utf8"), bytes]))
    .digest("hex");
}

function createRuntimeAuthority(): {
  readonly authority: RuntimeAuthority;
  readonly key: ReturnType<typeof generateRuntimeAuthorityKeyPair>;
} {
  const key = generateRuntimeAuthorityKeyPair();
  const authority = assertRuntimeAuthority({
    version: 1,
    kind: "runtime-authority",
    id: AUTHORITY_ID,
    key: key.publicKeyJwk,
    status: "active",
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.abort", "branch.advance"],
  });
  return { authority, key };
}

function signedSession(
  operation: string,
  request: Record<string, unknown>,
  capabilities: readonly CapabilityClaim[],
  options: {
    readonly taskIssue?: number;
    readonly certificateRepository?: { readonly id: string; readonly name: string };
  } = {},
): SessionFixture {
  const runtime = createRuntimeAuthority();
  const session = createManagedSession();
  const certificateRepository = options.certificateRepository ?? { id: REPOSITORY_ID, name: "acme/inari" };
  const issuance = session.createIssuanceRequest({
    repository: certificateRepository,
    task: { kind: "issue", number: options.taskIssue ?? ISSUE },
    capabilities,
    ttlSeconds: 600,
  });
  const certificate = issueSessionCertificate({
    repository: certificateRepository,
    runtimeAuthority: runtime.authority,
    runtimeKey: runtime.key,
    request: issuance,
    now: NOW,
  });
  session.acceptCertificate(certificate.compact);
  return {
    authority: runtime.authority,
    envelope: signSessionRequest({
      session,
      request: request as unknown as SemanticSessionRequest,
      operation,
      requestId: `integration-${operation.replaceAll(".", "-")}`,
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + 60,
    }),
    runtimePrivateKeyPem: runtime.key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function pullRequestEvidence(state: ProviderState): Record<string, unknown> {
  return {
    number: PULL_REQUEST,
    head: { ref: BRANCH, repo: { full_name: "acme/inari" } },
    base: { ref: "main" },
    user: { login: "inari-issuer[bot]" },
    state: state.pullRequestState,
    draft: state.pullRequestDraft,
    merged_at: null,
  };
}

function providerFixture(mode: ProviderMode, authority: RuntimeAuthority): ProviderFixture {
  const artifact = renderRuntimeAuthorityArtifact(authority);
  const changeContent = Buffer.from("integration", "utf8").toString("base64");
  const targetBlobSha = blobSha(changeContent);
  const state: ProviderState = {
    runtimeAuthority: authority,
    branchPresent: true,
    branchSha: mode === "branch-stale" ? STALE_HEAD : mode === "branch-success" ? EXPECTED_HEAD : EXPECTED_HEAD,
    pullRequestState: "open",
    pullRequestDraft: true,
    calls: [],
    authorizationHeaders: [],
  };
  const calls: Array<{ readonly method: string; readonly path: string }> = [];
  const authorizationHeaders: string[] = [];
  Object.defineProperty(state, "calls", { get: () => calls });
  Object.defineProperty(state, "authorizationHeaders", { get: () => authorizationHeaders });

  const repository = {
    id: Number(REPOSITORY_ID),
    full_name: "acme/inari",
    fork: false,
    default_branch: "main",
    node_id: REPOSITORY_NODE_ID,
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const parsed = new URL(url);
    const path = `${decodeURIComponent(parsed.pathname.replace(/^\/+/, ""))}${parsed.search}`;
    const method = String(init?.method ?? "GET").toUpperCase();
    calls.push({ method, path });
    const authorization = new Headers(init?.headers).get("authorization");
    if (authorization !== null) authorizationHeaders.push(authorization);

    if (path === `app/installations/${INSTALLATION_ID}/access_tokens` && method === "POST") {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      return jsonResponse(201, {
        token: "integration-installation-token",
        expires_at: "2026-09-13T00:10:00.000Z",
        permissions: body.permissions ?? {},
        repositories: [{ ...repository }],
      });
    }

    if (path === "graphql" && method === "POST") {
      if (mode !== "branch-success") return jsonResponse(200, { errors: [{ message: "compare and swap rejected" }] });
      state.branchSha = RESULTING_HEAD;
      return jsonResponse(200, { data: { updateRefs: { clientMutationId: "integration" } } });
    }

    if (path === "repos/acme/inari" && method === "GET") return jsonResponse(200, repository);
    if (path === "repos/acme/inari/git/ref/heads/main" && method === "GET") {
      return jsonResponse(200, { ref: "refs/heads/main", object: { type: "commit", sha: POLICY_SHA } });
    }
    if (path.startsWith(`repos/acme/inari/git/trees/${POLICY_SHA}`)) {
      return jsonResponse(200, {
        sha: POLICY_TREE_SHA,
        truncated: false,
        tree: [{ path: artifact.path, type: "blob", sha: POLICY_BLOB_SHA }],
      });
    }
    if (path === `repos/acme/inari/git/blobs/${POLICY_BLOB_SHA}`) {
      return jsonResponse(200, {
        sha: POLICY_BLOB_SHA,
        encoding: "base64",
        content: Buffer.from(canonicalRuntimeAuthorityJson(state.runtimeAuthority), "utf8").toString("base64"),
      });
    }

    if (path === `repos/acme/inari/issues/${ISSUE}`) {
      return jsonResponse(200, {
        number: ISSUE,
        title: "feat: session-authorized-change-execution",
        state: "open",
        body: null,
      });
    }
    if (path === `repos/acme/inari/git/ref/heads/${BRANCH}` && method === "GET") {
      return state.branchPresent
        ? jsonResponse(200, {
            ref: `refs/heads/${BRANCH}`,
            object: { type: "commit", sha: state.branchSha },
          })
        : jsonResponse(404, {});
    }
    if (path === "repos/acme/inari/git/matching-refs/heads/" && method === "GET") {
      return jsonResponse(
        200,
        state.branchPresent ? [{ ref: `refs/heads/${BRANCH}`, object: { type: "commit", sha: state.branchSha } }] : [],
      );
    }
    if (path.startsWith("repos/acme/inari/pulls?") && method === "GET") {
      return jsonResponse(200, [pullRequestEvidence(state)]);
    }

    if (path === `repos/acme/inari/pulls/${PULL_REQUEST}` && method === "PATCH") {
      state.pullRequestState = "closed";
      state.pullRequestDraft = false;
      if (mode === "abort-timeout-after-close") throw new Error("simulated transport timeout after provider effect");
      return jsonResponse(200, { number: PULL_REQUEST, state: "closed" });
    }
    if (path === `repos/acme/inari/pulls/${PULL_REQUEST}`) {
      return jsonResponse(200, pullRequestEvidence(state));
    }
    if (path === `repos/acme/inari/git/refs/heads/${BRANCH}` && method === "DELETE") {
      state.branchPresent = false;
      return new Response(null, { status: 204 });
    }

    if (path.startsWith("repos/acme/inari/git/commits/") && method === "GET") {
      const sha = path.slice("repos/acme/inari/git/commits/".length);
      if (sha === EXPECTED_HEAD) return jsonResponse(200, { sha, tree: { sha: EXPECTED_TREE_SHA } });
      if (sha === STALE_HEAD) return jsonResponse(200, { sha, tree: { sha: STALE_TREE_SHA } });
      if (sha === RESULTING_HEAD) return jsonResponse(200, { sha, tree: { sha: RESULTING_TREE_SHA } });
    }
    if (path.startsWith("repos/acme/inari/git/trees/") && method === "GET") {
      const sha = path.slice("repos/acme/inari/git/trees/".length).split("?")[0];
      if (sha === BRANCH_TREE_SHA || sha === EXPECTED_HEAD) {
        return jsonResponse(200, {
          sha: BRANCH_TREE_SHA,
          truncated: false,
          tree: [{ path: "README.md", mode: "100644", type: "blob", sha: BASE_BLOB_SHA }],
        });
      }
      if (sha === STALE_TREE_SHA || sha === STALE_HEAD) {
        return jsonResponse(200, {
          sha: STALE_TREE_SHA,
          truncated: false,
          tree: [
            { path: "src/integration.txt", mode: "100644", type: "blob", sha: targetBlobSha },
            { path: "concurrent.txt", mode: "100644", type: "blob", sha: UNRELATED_BLOB_SHA },
          ],
        });
      }
      if (sha === EXPECTED_TREE_SHA) {
        return jsonResponse(200, {
          sha: EXPECTED_TREE_SHA,
          truncated: false,
          tree: [{ path: "README.md", mode: "100644", type: "blob", sha: BASE_BLOB_SHA }],
        });
      }
      if (sha === RESULTING_TREE_SHA) {
        return jsonResponse(200, {
          sha: RESULTING_TREE_SHA,
          truncated: false,
          tree: [
            { path: "README.md", mode: "100644", type: "blob", sha: BASE_BLOB_SHA },
            { path: "src/integration.txt", mode: "100644", type: "blob", sha: targetBlobSha },
          ],
        });
      }
    }
    if (path === "repos/acme/inari/git/blobs" && method === "POST") {
      return jsonResponse(201, { sha: targetBlobSha });
    }
    if (path === "repos/acme/inari/git/trees" && method === "POST") {
      return jsonResponse(201, { sha: RESULTING_TREE_SHA });
    }
    if (path === "repos/acme/inari/git/commits" && method === "POST") {
      return jsonResponse(201, { sha: RESULTING_HEAD });
    }
    throw new Error(`Unexpected fake provider request: ${method} ${path}`);
  };

  return { fetch, state };
}

function branchAdvanceRequest(): Record<string, unknown> {
  return {
    version: 1,
    issue: ISSUE,
    branch: BRANCH,
    expectedHead: EXPECTED_HEAD,
    changes: [
      {
        operation: "upsert",
        path: "src/integration.txt",
        mode: "100644",
        content: Buffer.from("integration", "utf8").toString("base64"),
      },
    ],
    commit: { message: "integration branch advance", author: { name: "Integration Test", email: "test@example.test" } },
  };
}

function directExecutor(session: SessionFixture, provider: ProviderFixture) {
  return createDirectAppSessionExecutor({
    appId: APP_ID,
    installationId: INSTALLATION_ID,
    privateKeyPem: PRIVATE_KEY_PEM,
    repository: REPOSITORY,
    repositoryNodeId: REPOSITORY_NODE_ID,
    apiUrl: "https://api.test",
    fetch: provider.fetch,
    now: () => NOW,
  });
}

test("authenticated direct-App Change mutation returns verified App provenance after provider effects", async () => {
  const session = signedSession("change.abort", { version: 1, issue: ISSUE }, [{ kind: "change.abort", issue: ISSUE }]);
  const provider = providerFixture("abort", session.authority);
  const result = await directExecutor(session, provider).execute(session.envelope);

  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.operation, "change.abort");
  assert.equal(result.provenance?.stage, "verified");
  assert.equal(result.provenance?.app?.installationId, INSTALLATION_ID);
  assert.equal(provider.state.pullRequestState, "closed");
  assert.equal(provider.state.branchPresent, false);
  assert.ok(
    provider.state.calls.some((call) => call.method === "PATCH" && call.path.endsWith(`/pulls/${PULL_REQUEST}`)),
  );
  assert.ok(
    provider.state.calls.some((call) => call.method === "DELETE" && call.path.endsWith(`/git/refs/heads/${BRANCH}`)),
  );
});

test("replaying the same signed Change request does not duplicate canonical effects", async () => {
  const session = signedSession("change.abort", { version: 1, issue: ISSUE }, [{ kind: "change.abort", issue: ISSUE }]);
  const provider = providerFixture("abort", session.authority);
  const executor = directExecutor(session, provider);

  const first = await executor.execute(session.envelope);
  assert.equal(first.status, "succeeded", JSON.stringify(first));
  assert.equal(first.execution?.evidence?.outcome, "verified");
  const effectCallsAfterFirst = provider.state.calls.filter(
    (call) =>
      (call.method === "PATCH" && call.path.endsWith(`/pulls/${PULL_REQUEST}`)) ||
      (call.method === "DELETE" && call.path.endsWith(`/git/refs/heads/${BRANCH}`)),
  ).length;

  const replay = await executor.execute(session.envelope);
  assert.equal(replay.status, "succeeded", JSON.stringify(replay));
  assert.equal(replay.execution?.evidence?.outcome, "returned-existing");
  assert.equal(
    provider.state.calls.filter(
      (call) =>
        (call.method === "PATCH" && call.path.endsWith(`/pulls/${PULL_REQUEST}`)) ||
        (call.method === "DELETE" && call.path.endsWith(`/git/refs/heads/${BRANCH}`)),
    ).length,
    effectCallsAfterFirst,
  );
});

test("production branch.advance composition consumes the exact signed request and preserves #466 provenance", async () => {
  const request = branchAdvanceRequest();
  const session = signedSession("branch.advance", request, [{ kind: "branch.advance", branch: BRANCH }]);
  const provider = providerFixture("branch-success", session.authority);
  const result = await directExecutor(session, provider).execute(session.envelope);

  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.operation, "branch.advance");
  assert.equal(result.branchAdvance?.outcome, "advanced");
  assert.equal(result.branchAdvance?.expectedHead, EXPECTED_HEAD);
  assert.equal(result.branchAdvance?.resultingHead, RESULTING_HEAD);
  assert.equal(result.provenance?.stage, "verified");
  assert.deepEqual(result.provenance, result.branchAdvance?.provenance);
  assert.equal(provider.state.branchSha, RESULTING_HEAD);
});

test("production branch.advance replay with an unrelated concurrent tree change is not idempotent success", async () => {
  const session = signedSession("branch.advance", branchAdvanceRequest(), [{ kind: "branch.advance", branch: BRANCH }]);
  const provider = providerFixture("branch-stale", session.authority);
  const result = await directExecutor(session, provider).execute(session.envelope);

  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(result.failure?.phase, "conflict");
  assert.equal(result.branchAdvance?.status, "failed");
  assert.equal(result.branchAdvance?.outcome, "stale");
  assert.equal(result.branchAdvance?.failure?.reason, "stale-head");
  assert.equal(provider.state.branchSha, STALE_HEAD);
  assert.equal(
    provider.state.calls.some((call) => call.method === "POST" && call.path === "repos/acme/inari/git/refs"),
    false,
  );
});

test("replaying the same signed branch.advance request resolves only from the exact authoritative target", async () => {
  const session = signedSession("branch.advance", branchAdvanceRequest(), [{ kind: "branch.advance", branch: BRANCH }]);
  const provider = providerFixture("branch-success", session.authority);
  const executor = directExecutor(session, provider);

  const first = await executor.execute(session.envelope);
  assert.equal(first.status, "succeeded", JSON.stringify(first));
  assert.equal(first.branchAdvance?.outcome, "advanced");
  const mutationCallsAfterFirst = provider.state.calls.filter(
    (call) =>
      call.method === "POST" &&
      (call.path === "graphql" ||
        call.path === "repos/acme/inari/git/blobs" ||
        call.path === "repos/acme/inari/git/trees" ||
        call.path === "repos/acme/inari/git/commits"),
  ).length;

  const replay = await executor.execute(session.envelope);
  assert.equal(replay.status, "succeeded", JSON.stringify(replay));
  assert.equal(replay.branchAdvance?.outcome, "idempotent");
  assert.equal(replay.branchAdvance?.resultingHead, RESULTING_HEAD);
  assert.equal(
    provider.state.calls.filter(
      (call) =>
        call.method === "POST" &&
        (call.path === "graphql" ||
          call.path === "repos/acme/inari/git/blobs" ||
          call.path === "repos/acme/inari/git/trees" ||
          call.path === "repos/acme/inari/git/commits"),
    ).length,
    mutationCallsAfterFirst,
  );
});

test("Runtime revocation rejects the next otherwise-unexpired privileged request at authentication", async () => {
  const session = signedSession("branch.advance", branchAdvanceRequest(), [{ kind: "branch.advance", branch: BRANCH }]);
  const provider = providerFixture("branch-success", session.authority);
  const executor = directExecutor(session, provider);

  const first = await executor.execute(session.envelope);
  assert.equal(first.status, "succeeded", JSON.stringify(first));

  provider.state.runtimeAuthority = assertRuntimeAuthority({ ...session.authority, status: "disabled" });
  const replay = await executor.execute(session.envelope);

  assert.equal(replay.status, "failed");
  assert.equal(replay.failure?.phase, "authentication");
  assert.equal(replay.branchAdvance, undefined);
  assert.equal(provider.state.calls.filter((call) => call.method === "POST" && call.path === "graphql").length, 1);
});

test("a Change timeout after provider close effect is reread and becomes bounded recovery-required", async () => {
  const session = signedSession("change.abort", { version: 1, issue: ISSUE }, [{ kind: "change.abort", issue: ISSUE }]);
  const provider = providerFixture("abort-timeout-after-close", session.authority);
  const closeCallIndexBefore = provider.state.calls.length;
  const result = await directExecutor(session, provider).execute(session.envelope);

  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(result.failure?.phase, "recovery-required");
  assert.equal(result.failure?.evidence?.outcome, "recovery-required");
  assert.equal(provider.state.pullRequestState, "closed");
  const closeCallIndex = provider.state.calls.findIndex(
    (call, index) =>
      index >= closeCallIndexBefore && call.method === "PATCH" && call.path.endsWith(`/pulls/${PULL_REQUEST}`),
  );
  assert.notEqual(closeCallIndex, -1);
  assert.ok(
    provider.state.calls
      .slice(closeCallIndex + 1)
      .some((call) => call.method === "GET" && call.path.startsWith("repos/acme/inari/pulls?")),
  );
  assert.equal(
    provider.state.calls.some((call) => call.method === "DELETE" && call.path.endsWith(`/git/refs/heads/${BRANCH}`)),
    false,
  );

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(PRIVATE_KEY_PEM), false);
  assert.equal(serialized.includes(session.runtimePrivateKeyPem), false);
  assert.equal(serialized.includes("integration-installation-token"), false);
  assert.equal(serialized.includes("BEGIN PRIVATE KEY"), false);
  for (const header of provider.state.authorizationHeaders) assert.equal(serialized.includes(header), false);
});

test("wrong Issue task and certificate repository substitution fail closed before branch mutation", async () => {
  const taskSession = signedSession(
    "branch.advance",
    branchAdvanceRequest(),
    [{ kind: "branch.advance", branch: BRANCH }],
    { taskIssue: ISSUE + 1 },
  );
  const taskProvider = providerFixture("branch-success", taskSession.authority);
  const taskResult = await directExecutor(taskSession, taskProvider).execute(taskSession.envelope);
  assert.equal(taskResult.status, "failed");
  assert.equal(taskResult.failure?.phase, "authorization");
  assert.equal(
    taskProvider.state.calls.some((call) => call.method === "POST" && call.path === "graphql"),
    false,
  );

  const repositorySession = signedSession(
    "branch.advance",
    branchAdvanceRequest(),
    [{ kind: "branch.advance", branch: BRANCH }],
    { certificateRepository: { id: "987654321", name: "acme/inari" } },
  );
  const repositoryProvider = providerFixture("branch-success", repositorySession.authority);
  const repositoryResult = await directExecutor(repositorySession, repositoryProvider).execute(
    repositorySession.envelope,
  );
  assert.equal(repositoryResult.status, "failed");
  assert.equal(repositoryResult.failure?.phase, "authentication");
  assert.equal(
    repositoryProvider.state.calls.some((call) => call.method === "POST" && call.path === "graphql"),
    false,
  );
});
