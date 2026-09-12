import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  GITHUB_APP_REPOSITORY_READ_PERMISSIONS,
  GitHubAppCredentialBrokerError,
  GitHubAppInstallationCredentialBroker,
  type GitHubAppInstallationCredentialBrokerOptions,
} from "./app-installation-credential-broker.js";
import {
  ISSUER_AUTHORITY_CONTRACT_VERSION,
  createInariIssuerAppIdentity,
  type IssuerCredentialRequest,
  type IssuerPermissionSet,
  type IssuerRepositoryIdentity,
} from "./issuer-authority.js";

const repository = { hostname: "github.com", owner: "acme", name: "inari" } as const;
const target: IssuerRepositoryIdentity = {
  repositoryHost: "github.com",
  repositoryId: "218000001",
  nameWithOwner: "acme/inari",
};
const now = new Date("2026-09-05T00:00:00.000Z");
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const app = createInariIssuerAppIdentity("218");

function tokenResponse(
  overrides: Record<string, unknown> = {},
  permissions: Record<string, string> = { ...GITHUB_APP_REPOSITORY_READ_PERMISSIONS },
): Response {
  return new Response(
    JSON.stringify({
      token: "installation-token-secret",
      expires_at: "2026-09-05T00:10:00.000Z",
      permissions,
      repositories: [{ id: Number(target.repositoryId), full_name: target.nameWithOwner }],
      ...overrides,
    }),
    { status: 201 },
  );
}

function brokerOptions(
  fetch: typeof globalThis.fetch,
  overrides: Partial<GitHubAppInstallationCredentialBrokerOptions> = {},
): GitHubAppInstallationCredentialBrokerOptions {
  return {
    appId: app.appId,
    installationId: "219",
    privateKeyPem: privateKey,
    repository,
    fetch,
    now: () => now,
    ...overrides,
  };
}

function mutationRequest(permissions: IssuerPermissionSet = { contents: "write" }): IssuerCredentialRequest {
  return {
    version: ISSUER_AUTHORITY_CONTRACT_VERSION,
    authority: "issuer",
    app,
    execution: {
      version: ISSUER_AUTHORITY_CONTRACT_VERSION,
      runtime: "github-actions",
      event: "workflow_dispatch",
      repository: target,
      workflowRef: "refs/heads/main",
      workflowSha: "a".repeat(40),
      workflowTrust: "protected",
      codeExecution: "trusted-only",
      fork: false,
      pullRequest: false,
    },
    target,
    permissions,
  };
}

test("pre-admission read capability requests the minimum read ceiling and exposes only GET", async () => {
  const calls: RequestInit[] = [];
  const broker = new GitHubAppInstallationCredentialBroker(
    brokerOptions(async (_input, init) => {
      calls.push(init ?? {});
      return calls.length === 1
        ? tokenResponse({ repositories: [{ id: 218000009, full_name: target.nameWithOwner }] })
        : new Response(JSON.stringify({ number: 1 }), { status: 200 });
    }),
  );

  let scope: unknown;
  await broker.withRepositoryReadCapability({}, async (capability) => {
    scope = capability.scope;
    assert.deepEqual(Object.keys(capability).sort(), ["scope", "transport"]);
    assert.deepEqual(Object.keys(capability.transport), ["request"]);
    assert.equal("withScopedRepositoryRead" in broker, false);
    assert.equal("withRepositoryRead" in broker, false);
    const result = await capability.transport.request({
      hostname: "github.com",
      method: "GET",
      path: "repos/acme/inari/issues/1",
    });
    assert.deepEqual(result.body, { number: 1 });
    await assert.rejects(
      capability.transport.request({
        hostname: "github.com",
        method: "POST",
        path: "repos/acme/inari/issues/1",
      } as never),
      (error: unknown) => error instanceof GitHubAppCredentialBrokerError && error.stage === "repository-read",
    );
  });

  const issued = JSON.parse(String(calls[0]?.body)) as { permissions: unknown };
  assert.deepEqual(issued.permissions, GITHUB_APP_REPOSITORY_READ_PERMISSIONS);
  assert.deepEqual((scope as { repository: IssuerRepositoryIdentity }).repository, {
    repositoryHost: "github.com",
    repositoryId: "218000009",
    nameWithOwner: "acme/inari",
  });
  assert.equal(JSON.stringify(scope).includes("installation-token-secret"), false);
  assert.equal(JSON.stringify(scope).includes(privateKey), false);
  assert.match(String(calls[0]?.headers && JSON.stringify(calls[0]?.headers)), /^.*Bearer [^.]+\.[^.]+\.[^.]+.*$/u);
});

test("pre-admission reads reject caller-supplied immutable identity", async () => {
  let calls = 0;
  const broker = new GitHubAppInstallationCredentialBroker(
    brokerOptions(async () => {
      calls += 1;
      return tokenResponse();
    }),
  );
  await assert.rejects(
    broker.withRepositoryReadCapability(
      { target } as unknown as { readonly permissions?: typeof GITHUB_APP_REPOSITORY_READ_PERMISSIONS },
      async () => undefined,
    ),
    (error: unknown) => error instanceof GitHubAppCredentialBrokerError && error.stage === "installation-scope",
  );
  assert.equal(calls, 0);
});

test("read capability binds host and repository path independently of owner/name-only input", async () => {
  const broker = new GitHubAppInstallationCredentialBroker(brokerOptions(async () => tokenResponse()));
  await assert.rejects(
    broker.withRepositoryReadCapability({}, async (capability) => {
      await capability.transport.request({ hostname: "ghe.example.com", method: "GET", path: "repos/acme/inari" });
    }),
    (error: unknown) => error instanceof GitHubAppCredentialBrokerError && error.stage === "repository-read",
  );

  const calls: Array<RequestInfo | URL> = [];
  const pathBroker = new GitHubAppInstallationCredentialBroker(
    brokerOptions(async (input) => {
      calls.push(input);
      return tokenResponse();
    }),
  );
  await assert.rejects(
    pathBroker.withRepositoryReadCapability({}, async (capability) => {
      await capability.transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/other" });
    }),
    (error: unknown) => error instanceof GitHubAppCredentialBrokerError && error.stage === "repository-read",
  );
  assert.equal(calls.length, 1);
});

test("post-admission mutation capability narrows the token to the admitted effect", async () => {
  const calls: RequestInit[] = [];
  const broker = new GitHubAppInstallationCredentialBroker(
    brokerOptions(async (_input, init) => {
      calls.push(init ?? {});
      if (calls.length === 1) return tokenResponse({}, { contents: "write" });
      if (calls.length === 2) {
        return new Response(
          JSON.stringify({ ref: "refs/heads/main", object: { type: "commit", sha: "a".repeat(40) } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ ref: "refs/heads/feat/464-broker", object: { type: "commit", sha: "a".repeat(40) } }),
        { status: 201 },
      );
    }),
  );
  await broker.withScopedInstallationCredential(mutationRequest(), async (capability) => {
    await capability.apply({ kind: "CREATE_BRANCH", branch: "feat/464-broker", baseBranch: "main" });
  });
  assert.deepEqual(JSON.parse(String(calls[0]?.body)), {
    repositories: ["inari"],
    permissions: { contents: "write" },
  });
});

test("mutation capability rejects read-only evidence permissions and target identity mismatches before minting", async () => {
  let calls = 0;
  const broker = new GitHubAppInstallationCredentialBroker(
    brokerOptions(async () => {
      calls += 1;
      return tokenResponse({}, { contents: "write" });
    }),
  );
  await assert.rejects(
    broker.withScopedInstallationCredential(mutationRequest({ issues: "read" }), async () => undefined),
    (error: unknown) => error instanceof GitHubAppCredentialBrokerError && error.stage === "installation-scope",
  );
  await assert.rejects(
    broker.withScopedInstallationCredential(
      { ...mutationRequest(), target: { ...target, repositoryId: "218000002" } },
      async () => undefined,
    ),
    (error: unknown) => error instanceof GitHubAppCredentialBrokerError && error.stage === "installation-scope",
  );
  assert.equal(calls, 1);
});

test("installation response must select exactly one well-formed configured repository", async () => {
  for (const repositories of [
    [],
    [{ id: Number(target.repositoryId), full_name: "acme/other" }],
    [{ id: "not-a-repository-id", full_name: target.nameWithOwner }],
    [{ id: Number(target.repositoryId) }],
    [
      { id: Number(target.repositoryId), full_name: target.nameWithOwner },
      { id: 218000002, full_name: "acme/other" },
    ],
  ]) {
    const broker = new GitHubAppInstallationCredentialBroker(
      brokerOptions(async () => tokenResponse({ repositories })),
    );
    await assert.rejects(
      broker.withRepositoryReadCapability({}, async () => undefined),
      (error: unknown) => error instanceof GitHubAppCredentialBrokerError && error.stage === "installation-scope",
    );
  }

  for (const identity of [{ app_id: "220" }, { installation_id: "220" }]) {
    const broker = new GitHubAppInstallationCredentialBroker(brokerOptions(async () => tokenResponse(identity)));
    await assert.rejects(
      broker.withRepositoryReadCapability({}, async () => undefined),
      (error: unknown) => error instanceof GitHubAppCredentialBrokerError && error.stage === "installation-scope",
    );
  }
});

test("repository rereads must retain the provider-derived immutable identity", async () => {
  const broker = new GitHubAppInstallationCredentialBroker(
    brokerOptions(async (_input, init) => {
      return typeof init?.body === "string"
        ? tokenResponse({ repositories: [{ id: 218000009, full_name: target.nameWithOwner }] })
        : new Response(JSON.stringify({ id: 218000010, full_name: target.nameWithOwner }), { status: 200 });
    }),
  );
  await assert.rejects(
    broker.withRepositoryReadCapability({}, async (capability) => {
      await capability.transport.request({
        hostname: "github.com",
        method: "GET",
        path: "repos/acme/inari/",
      });
    }),
    (error: unknown) => error instanceof GitHubAppCredentialBrokerError && error.stage === "repository-read",
  );
});

test("expired, malformed, and over-granted installation responses fail closed", async () => {
  const cases: Array<{ readonly response: Response; readonly stage: string }> = [
    { response: tokenResponse({ expires_at: "not-a-timestamp" }), stage: "installation-scope" },
    { response: tokenResponse({ expires_at: "2026-09-04T23:59:59.000Z" }), stage: "installation-scope" },
    { response: new Response("not-json", { status: 201 }), stage: "installation-token" },
  ];
  for (const testCase of cases) {
    const broker = new GitHubAppInstallationCredentialBroker(brokerOptions(async () => testCase.response));
    await assert.rejects(
      broker.withRepositoryReadCapability({}, async () => undefined),
      (error: unknown) => error instanceof GitHubAppCredentialBrokerError && error.stage === testCase.stage,
    );
  }

  const excessPermissionBroker = new GitHubAppInstallationCredentialBroker(
    brokerOptions(async () => tokenResponse({}, { contents: "read", issues: "read", pull_requests: "write" })),
  );
  await assert.rejects(
    excessPermissionBroker.withRepositoryReadCapability({}, async () => undefined),
    (error: unknown) => error instanceof GitHubAppCredentialBrokerError && error.stage === "installation-scope",
  );
});

test("provider failures and operation errors never disclose App secrets", async () => {
  const providerSecret = "provider-path-and-token-secret";
  const failingBroker = new GitHubAppInstallationCredentialBroker(
    brokerOptions(async () => {
      throw new Error(`Authorization: Bearer ${providerSecret} /private/provider/path`);
    }),
  );
  await assert.rejects(
    failingBroker.withRepositoryReadCapability({}, async () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof GitHubAppCredentialBrokerError);
      assert.equal(error.stage, "installation-token");
      assert.doesNotMatch(error.message, /provider-path-and-token-secret|private\/provider/iu);
      return true;
    },
  );

  const operationBroker = new GitHubAppInstallationCredentialBroker(brokerOptions(async () => tokenResponse()));
  const operationSecret = "operation-secret";
  await assert.rejects(
    operationBroker.withRepositoryReadCapability({}, async () => {
      throw new Error(operationSecret);
    }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubAppCredentialBrokerError);
      assert.equal(error.stage, "repository-read");
      assert.equal(error.message.includes(operationSecret), false);
      assert.equal(JSON.stringify(error).includes(privateKey), false);
      return true;
    },
  );
});
