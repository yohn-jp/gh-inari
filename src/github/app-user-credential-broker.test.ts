import assert from "node:assert/strict";
import test from "node:test";
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
