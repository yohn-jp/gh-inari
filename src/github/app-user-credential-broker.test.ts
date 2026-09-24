import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { CAPABILITY_KINDS } from "../agent-authority/capability.js";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { renderDelegatorArtifact } from "../agent-authority/delegator-trust.js";
import type { Delegator } from "../agent-authority/delegator.js";
import {
  createRuntimeAuthorityPublicationRequest,
  publishRuntimeAuthority,
  runtimeAuthorityPublicationBody,
  runtimeAuthorityPublicationBranch,
  runtimeAuthorityPublicationTitle,
} from "../runtime-authority-publication.js";
import type { RuntimeAuthorityPublicationBroker } from "./runtime-authority-publication-capability.js";
import { createAppUserCredential } from "./app-user-credential.js";
import { InMemoryAppUserCredentialStore } from "./app-user-credential-store.js";
import {
  assertTrustedExecution,
  createInariAppPrincipalIdentity,
  EFFECT_AUTHORIZER_CONTRACT_VERSION,
  validateIssuerInstallationScope,
  type EffectAuthorizerCredentialRequest,
  type RepositoryIdentity,
} from "./effect-authorizer.js";
import {
  GitHubAppUserCredentialBroker,
  GitHubAppUserCredentialBrokerError,
  type GitHubAppUserCredentialBrokerOptions,
} from "./app-user-credential-broker.js";

const REPOSITORY = { hostname: "github.com", owner: "acme", name: "inari" } as const;
const CREDENTIAL = createAppUserCredential({
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  accessTokenExpiresAt: "2027-01-01T00:00:00.000Z",
  refreshTokenExpiresAt: "2027-06-01T00:00:00.000Z",
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function options(
  fetch: typeof globalThis.fetch,
  overrides: Partial<GitHubAppUserCredentialBrokerOptions> = {},
): GitHubAppUserCredentialBrokerOptions {
  return {
    appId: "42",
    repository: REPOSITORY,
    repositoryId: "99",
    credentialStore: new InMemoryAppUserCredentialStore(CREDENTIAL),
    fetch,
    ...overrides,
  };
}

function brokerFetch(
  config: {
    readonly installations?: unknown[];
    readonly repositories?: unknown[];
    readonly repositoryStatus?: number;
    readonly repositoryBody?: unknown;
  } = {},
): { readonly fetch: typeof globalThis.fetch; readonly calls: string[] } {
  const calls: string[] = [];
  const fetch = (async (input) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/user/installations") {
      return json({
        installations: config.installations ?? [
          {
            id: 7,
            app_id: 42,
            permissions: { contents: "write", issues: "write", pull_requests: "write", metadata: "read" },
            suspended_at: null,
          },
        ],
      });
    }
    if (/^\/user\/installations\/[0-9]+\/repositories$/u.test(url.pathname)) {
      return json({ repositories: config.repositories ?? [{ id: 99, full_name: "acme/inari", node_id: "repo-node" }] });
    }
    if (/^\/repos\/[^/]+\/inari$/u.test(url.pathname)) {
      return json(
        config.repositoryBody ?? { id: 99, full_name: url.pathname.slice("/repos/".length) },
        config.repositoryStatus ?? 200,
      );
    }
    throw new Error(`unexpected ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

test("App-user broker resolves the configured App/repository and exposes no token", async () => {
  const provider = brokerFetch();
  const broker = new GitHubAppUserCredentialBroker(options(provider.fetch));
  await broker.withRepositoryReadCapability({}, async (capability) => {
    assert.equal(capability.scope.app.appId, "42");
    assert.equal(capability.scope.installation.installationId, "7");
    assert.equal(capability.scope.repository.repositoryId, "99");
    const response = await capability.transport.request({
      hostname: "github.com",
      method: "GET",
      path: "repos/acme/inari",
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.stringify(capability).includes("access-secret"), false);
  });
  assert.deepEqual(provider.calls, ["/user/installations", "/user/installations/7/repositories", "/repos/acme/inari"]);
});

test("App-user broker publishes a bootstrap Runtime Authority trust PR using this operator's own token, never an Issuer credential (#1066)", async () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const authority: Delegator = createDelegatorRecord({
    id: "runtime-bootstrap-test",
    key: publicKey,
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: null,
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: CAPABILITY_KINDS,
  });
  const artifact = renderDelegatorArtifact(authority);
  const target: RepositoryIdentity = { repositoryHost: "github.com", repositoryId: "99", nameWithOwner: "acme/inari" };
  const branch = runtimeAuthorityPublicationBranch(authority.id);
  const title = runtimeAuthorityPublicationTitle(authority.id);
  const body = runtimeAuthorityPublicationBody(authority);
  const BASE_SHA = "a".repeat(40);
  const BASE_TREE_SHA = "b".repeat(40);
  const TREE_SHA = "c".repeat(40);
  const COMMIT_SHA = "d".repeat(40);
  const blobSha = createHash("sha1")
    .update(`blob ${Buffer.byteLength(artifact.content, "utf8")}\0`)
    .update(artifact.content)
    .digest("hex");

  let branchCreated = false;
  const authorizations: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    const path = url.pathname;
    if (path === "/user/installations") {
      return json({
        installations: [
          {
            id: 7,
            app_id: 42,
            permissions: { contents: "write", issues: "write", pull_requests: "write", metadata: "read" },
            suspended_at: null,
          },
        ],
      });
    }
    if (path === "/user/installations/7/repositories") {
      return json({ repositories: [{ id: 99, full_name: "acme/inari", node_id: "repo-node" }] });
    }
    if (path === "/repos/acme/inari" && method === "GET")
      return json({ id: 99, full_name: "acme/inari", default_branch: "main" });
    if (path === "/repos/acme/inari/pulls" && method === "GET") return json([]);
    if (path === "/repos/acme/inari/git/ref/heads/main" && method === "GET") {
      return json({ ref: "refs/heads/main", object: { type: "commit", sha: BASE_SHA } });
    }
    if (path === `/repos/acme/inari/git/ref/heads/${encodeURIComponent(branch)}` && method === "GET") {
      if (!branchCreated) return new Response(null, { status: 404 });
      return json({ ref: `refs/heads/${branch}`, object: { type: "commit", sha: COMMIT_SHA } });
    }
    if (path === `/repos/acme/inari/git/commits/${BASE_SHA}` && method === "GET") {
      return json({ sha: BASE_SHA, tree: { sha: BASE_TREE_SHA } });
    }
    if (path === `/repos/acme/inari/git/commits/${COMMIT_SHA}` && method === "GET") {
      return json({ sha: COMMIT_SHA, tree: { sha: TREE_SHA } });
    }
    if (path === `/repos/acme/inari/git/trees/${BASE_TREE_SHA}` && method === "GET") {
      return json({ sha: BASE_TREE_SHA, truncated: false, tree: [] });
    }
    if (path === `/repos/acme/inari/git/trees/${TREE_SHA}` && method === "GET") {
      return json({
        sha: TREE_SHA,
        truncated: false,
        tree: [{ path: artifact.path, mode: "100644", type: "blob", sha: blobSha }],
      });
    }
    if (path === "/repos/acme/inari/git/blobs" && method === "POST") return json({ sha: blobSha }, 201);
    if (path === `/repos/acme/inari/git/blobs/${blobSha}` && method === "GET") {
      return json({
        sha: blobSha,
        encoding: "base64",
        content: Buffer.from(artifact.content, "utf8").toString("base64"),
      });
    }
    if (path === "/repos/acme/inari/git/trees" && method === "POST") return json({ sha: TREE_SHA }, 201);
    if (path === "/repos/acme/inari/git/commits" && method === "POST") return json({ sha: COMMIT_SHA }, 201);
    if (path === "/repos/acme/inari/git/refs" && method === "POST") {
      branchCreated = true;
      return json({ ref: `refs/heads/${branch}` }, 201);
    }
    if (path === `/repos/acme/inari/compare/main...${encodeURIComponent(branch)}` && method === "GET") {
      return json({ ahead_by: 1, files: [{ filename: artifact.path }] });
    }
    if (path === "/repos/acme/inari/pulls" && method === "POST") {
      return json(
        {
          number: 9,
          html_url: "https://github.com/acme/inari/pull/9",
          title,
          body,
          state: "open",
          draft: false,
          head: { ref: branch, repo: { full_name: "acme/inari" } },
          base: { ref: "main" },
          // The PR is authored by this operator's own account, never a fixed
          // Issuer bot login -- Core's `requireAuthor: null` accepts this.
          user: { login: "the-operator" },
          changed_files: 1,
        },
        201,
      );
    }
    if (path === "/repos/acme/inari/pulls/9/files" && method === "GET") return json([{ filename: artifact.path }]);
    throw new Error(`unexpected ${method} ${path}`);
  };
  const broker = new GitHubAppUserCredentialBroker(options(fetch));
  const publicationBroker: RuntimeAuthorityPublicationBroker = {
    withRuntimeAuthorityPublicationCapability: broker.withRuntimeAuthorityPublicationCapability.bind(broker),
  };

  const result = await publishRuntimeAuthority(
    createRuntimeAuthorityPublicationRequest(authority),
    target,
    publicationBroker,
    { requireAuthor: null },
  );

  assert.equal(result.status, "created");
  assert.deepEqual(result.pullRequest, { number: 9, url: "https://github.com/acme/inari/pull/9" });
  // Every GitHub call -- installation lookup and the bounded mutation alike
  // -- carries this operator's own App-user token; there is no Issuer
  // credential anywhere in this path.
  assert.ok(authorizations.length > 0 && authorizations.every((value) => value === "Bearer access-secret"));
  assert.doesNotMatch(
    JSON.stringify(result),
    /access-secret|refresh-secret|privateKey|-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  );
});

test("App-user broker rejects a target repository mismatch before resolving any credential", async () => {
  const provider = brokerFetch();
  const broker = new GitHubAppUserCredentialBroker(options(provider.fetch));

  await assert.rejects(
    broker.withRuntimeAuthorityPublicationCapability(
      { target: { repositoryHost: "github.com", repositoryId: "218000002", nameWithOwner: "acme/inari" } },
      async () => undefined,
    ),
    { code: "GITHUB_APP_USER_CREDENTIAL_BROKER_FAILED" },
  );
  assert.deepEqual(provider.calls, []);
});

test("App-user broker fails closed when the resolved installation lacks Runtime Authority publication permissions", async () => {
  const provider = brokerFetch({
    installations: [
      {
        id: 7,
        app_id: 42,
        permissions: { contents: "write", pull_requests: "read", metadata: "read" },
        suspended_at: null,
      },
    ],
  });
  const broker = new GitHubAppUserCredentialBroker(options(provider.fetch));
  const target: RepositoryIdentity = { repositoryHost: "github.com", repositoryId: "99", nameWithOwner: "acme/inari" };

  // Insufficient authority (pull_requests: read, not write) must fail closed
  // before any branch/commit/PR mutation is attempted.
  await assert.rejects(
    broker.withRuntimeAuthorityPublicationCapability({ target }, async () => undefined),
    { code: "GITHUB_APP_USER_CREDENTIAL_BROKER_FAILED" },
  );
});

test("App-user broker bounds operation scope to requested effect permissions after validating the provider grant", async () => {
  const provider = brokerFetch();
  const broker = new GitHubAppUserCredentialBroker(options(provider.fetch));
  const app = createInariAppPrincipalIdentity("42");
  const target: RepositoryIdentity = {
    repositoryHost: "github.com",
    repositoryId: "99",
    nameWithOwner: "acme/inari",
  };
  const request = {
    version: EFFECT_AUTHORIZER_CONTRACT_VERSION,
    authority: "issuer",
    app,
    execution: assertTrustedExecution({
      version: EFFECT_AUTHORIZER_CONTRACT_VERSION,
      runtime: "inari-app",
      event: "session-request",
      repository: target,
      requestId: "request-operation-scope",
      sessionId: "session-operation-scope",
      certificateJti: "certificate-operation-scope",
      requester: "session:session-operation-scope",
    }),
    target,
    permissions: { pull_requests: "write" },
  } satisfies EffectAuthorizerCredentialRequest;

  await broker.withScopedInstallationCredential(request, async (capability) => {
    assert.deepEqual(capability.scope.permissions, request.permissions);
    const validation = validateIssuerInstallationScope(capability.scope, {
      app,
      target,
      requiredPermissions: request.permissions,
    });
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  });

  assert.deepEqual(provider.calls, ["/user/installations", "/user/installations/7/repositories"]);
});

test("App-user broker preserves immutable identity across repository rename", async () => {
  const provider = brokerFetch({ repositories: [{ id: 99, full_name: "renamed/inari", node_id: "repo-node" }] });
  const broker = new GitHubAppUserCredentialBroker(options(provider.fetch));
  await broker.withRepositoryReadCapability({}, async (capability) => {
    assert.equal(capability.scope.repository.nameWithOwner, "renamed/inari");
    await capability.transport.request({ hostname: "github.com", method: "GET", path: "repos/renamed/inari" });
  });
  assert.equal(provider.calls.at(-1), "/repos/renamed/inari");
});

test("App-user broker fails closed on App mismatch, removal, ambiguity, and reduced permissions", async () => {
  const cases: Array<{
    readonly name: string;
    readonly config: Parameters<typeof brokerFetch>[0];
    readonly mutation?: boolean;
  }> = [
    {
      name: "App mismatch",
      config: { installations: [{ id: 7, app_id: 41, permissions: { contents: "write" }, suspended_at: null }] },
    },
    { name: "repository removal", config: { repositories: [] } },
    {
      name: "ambiguous installations",
      config: {
        installations: [
          {
            id: 7,
            app_id: 42,
            permissions: { contents: "write", issues: "write", pull_requests: "write" },
            suspended_at: null,
          },
          {
            id: 8,
            app_id: 42,
            permissions: { contents: "write", issues: "write", pull_requests: "write" },
            suspended_at: null,
          },
        ],
      },
    },
    {
      name: "permission reduction",
      mutation: true,
      config: {
        installations: [
          {
            id: 7,
            app_id: 42,
            permissions: { contents: "read", issues: "read", pull_requests: "read" },
            suspended_at: null,
          },
        ],
      },
    },
  ];
  for (const testCase of cases) {
    const provider = brokerFetch(testCase.config);
    const broker = new GitHubAppUserCredentialBroker(options(provider.fetch));
    await assert.rejects(
      () =>
        testCase.mutation
          ? broker.withBranchAdvanceCapability(
              { target: { repositoryHost: "github.com", repositoryId: "99", nameWithOwner: "acme/inari" } },
              async () => undefined,
            )
          : broker.withRepositoryReadCapability({}, async () => undefined),
      (error: unknown) => error instanceof GitHubAppUserCredentialBrokerError && error.stage === "installation-scope",
      testCase.name,
    );
  }
});

test("App-user provider rejection remains a bounded failure", async () => {
  const provider = brokerFetch({ repositoryStatus: 403, repositoryBody: { message: "forbidden" } });
  const broker = new GitHubAppUserCredentialBroker(options(provider.fetch));
  await assert.rejects(
    () =>
      broker.withRepositoryReadCapability({}, async (capability) =>
        capability.transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/inari" }),
      ),
    (error: unknown) =>
      error instanceof GitHubAppUserCredentialBrokerError && String(error).includes("access-secret") === false,
  );
});
