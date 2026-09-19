import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  GITHUB_APP_GIT_DATA_PERMISSIONS,
  GITHUB_APP_REPOSITORY_READ_PERMISSIONS,
  GitHubAppCredentialBrokerError,
  GitHubAppInstallationCredentialBroker,
  type GitHubAppInstallationCredentialBrokerOptions,
} from "./app-installation-credential-broker.js";
import {
  EFFECT_AUTHORIZER_CONTRACT_VERSION,
  createInariAppPrincipalIdentity,
  type EffectAuthorizerCredentialRequest,
  type AppPermissionSet,
  type RepositoryIdentity,
} from "./effect-authorizer.js";

const repository = { hostname: "github.com", owner: "acme", name: "inari" } as const;
const target: RepositoryIdentity = {
  repositoryHost: "github.com",
  repositoryId: "218000001",
  nameWithOwner: "acme/inari",
};
const now = new Date("2026-09-05T00:00:00.000Z");
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const app = createInariAppPrincipalIdentity("218");

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

function mutationRequest(permissions: AppPermissionSet = { contents: "write" }): EffectAuthorizerCredentialRequest {
  return {
    version: EFFECT_AUTHORIZER_CONTRACT_VERSION,
    authority: "issuer",
    app,
    execution: {
      version: EFFECT_AUTHORIZER_CONTRACT_VERSION,
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

const createPullRequestEffect = {
  kind: "CREATE_PULL_REQUEST",
  branch: "feat/507-provider-diagnostics",
  baseBranch: "main",
  rootIssue: 507,
  title: "Change #507",
  body: "Closes #507",
  draft: true,
} as const;

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
    assert.deepEqual(Object.keys(capability).sort(), ["providerPrincipal", "scope", "transport"]);
    assert.deepEqual(capability.providerPrincipal, capability.scope.app);
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
  assert.deepEqual((scope as { repository: RepositoryIdentity }).repository, {
    repositoryHost: "github.com",
    repositoryId: "218000009",
    nameWithOwner: "acme/inari",
  });
  assert.equal(JSON.stringify(scope).includes("installation-token-secret"), false);
  assert.equal(JSON.stringify(scope).includes(privateKey), false);
  assert.match(String(calls[0]?.headers && JSON.stringify(calls[0]?.headers)), /^.*Bearer [^.]+\.[^.]+\.[^.]+.*$/u);
});

test("broker-injected clock controls App JWT iat and exp", async () => {
  const injectedNow = new Date("2040-02-03T04:05:06.789Z");
  let clockCalls = 0;
  let authorization = "";
  const broker = new GitHubAppInstallationCredentialBroker(
    brokerOptions(
      async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return tokenResponse({ expires_at: "2040-02-03T04:15:06.000Z" });
      },
      {
        now: () => {
          clockCalls += 1;
          return injectedNow;
        },
      },
    ),
  );

  await broker.withRepositoryReadCapability({}, async () => undefined);

  const jwt = authorization.slice("Bearer ".length).split(".");
  assert.equal(jwt.length, 3);
  assert.deepEqual(JSON.parse(Buffer.from(jwt[1] ?? "", "base64url").toString("utf8")), {
    iat: Math.floor(injectedNow.getTime() / 1000) - 60,
    exp: Math.floor(injectedNow.getTime() / 1000) - 60 + 540,
    iss: app.appId,
  });
  assert.equal(clockCalls, 1);
});

test("Git-data capability keeps the App credential private and binds the immutable repository", async () => {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  const broker = new GitHubAppInstallationCredentialBroker(
    brokerOptions(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (calls.length === 1) {
        return tokenResponse({
          permissions: GITHUB_APP_GIT_DATA_PERMISSIONS,
          repositories: [
            {
              id: Number(target.repositoryId),
              full_name: target.nameWithOwner,
              node_id: "R_kgDO218000001",
            },
          ],
        });
      }
      return new Response(
        JSON.stringify({
          ref: "refs/heads/feat/466-session-authorized-branch-advance",
          object: { type: "commit", sha: "a".repeat(40) },
        }),
        { status: 200 },
      );
    }),
  );

  let result: unknown;
  await broker.withBranchAdvanceCapability({ target }, async (capability) => {
    assert.deepEqual(Object.keys(capability).sort(), ["scope"]);
    assert.equal("request" in capability, false);
    await capability.readRef("feat/466-session-authorized-branch-advance");
    result = { scope: capability.scope, capability };
  });

  const tokenRequest = JSON.parse(String(calls[0]?.init.body)) as { permissions: Record<string, string> };
  assert.deepEqual(tokenRequest.permissions, GITHUB_APP_GIT_DATA_PERMISSIONS);
  assert.equal(JSON.stringify(result).includes("installation-token-secret"), false);
  assert.equal(JSON.stringify(result).includes(privateKey), false);
  assert.match(JSON.stringify(calls[1]?.init.headers), /Bearer installation-token-secret/u);
  assert.equal(
    calls[1]?.url.endsWith("/repos/acme/inari/git/ref/heads/feat%2F466-session-authorized-branch-advance"),
    true,
  );
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

test("read capability rejects encoded traversal and separator ambiguity", async () => {
  const calls: Array<RequestInfo | URL> = [];
  const broker = new GitHubAppInstallationCredentialBroker(
    brokerOptions(async (input) => {
      calls.push(input);
      return calls.length === 1 ? tokenResponse() : new Response(JSON.stringify({ number: 1 }), { status: 200 });
    }),
  );

  await broker.withRepositoryReadCapability({}, async (capability) => {
    for (const path of [
      "repos/acme/inari/issues/%2e%2e/secret",
      "repos/acme/inari/issues/%2E%2E/secret",
      "repos/acme/inari/issues/%2e%2fsecret",
      "repos/acme/inari/issues/%2E%2Fsecret",
      "repos/acme/inari/issues/%5csecret",
      "repos/acme/inari/issues/%5Csecret",
      "repos/acme/inari/issues/%252e%252e/secret",
      "repos/acme/inari/issues/%252e%252fsecret",
      "repos/acme/inari/issues/%255csecret",
    ]) {
      await assert.rejects(
        capability.transport.request({ hostname: "github.com", method: "GET", path }),
        (error: unknown) => error instanceof GitHubAppCredentialBrokerError && error.stage === "repository-read",
      );
    }

    const refResponse = await capability.transport.request({
      hostname: "github.com",
      method: "GET",
      path: "repos/acme/inari/git/ref/heads/feat%2F218-execute-change-plans-safely",
    });
    assert.deepEqual(refResponse.body, { number: 1 });

    const response = await capability.transport.request({
      hostname: "github.com",
      method: "GET",
      path: "repos/acme/inari/issues?search=hello%20world",
    });
    assert.deepEqual(response.body, { number: 1 });
  });
  assert.equal(calls.length, 3);
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

test("ready mutation uses the provider GraphQL endpoint for github.com and GHES", async () => {
  const nodeId = "MDExOlB1bGxSZXF1ZXN0OTA=";
  for (const testCase of [
    { apiUrl: "https://api.github.com", graphqlUrl: "https://api.github.com/graphql" },
    { apiUrl: "https://ghe.example.com/api/v3", graphqlUrl: "https://ghe.example.com/api/graphql" },
  ]) {
    const calls: string[] = [];
    const broker = new GitHubAppInstallationCredentialBroker(
      brokerOptions(
        async (input) => {
          calls.push(String(input));
          if (calls.length === 1) return tokenResponse({}, { contents: "write" });
          if (calls.length === 2) {
            return new Response(JSON.stringify({ number: 901, state: "open", draft: true, node_id: nodeId }), {
              status: 200,
            });
          }
          return new Response(
            JSON.stringify({
              data: {
                markPullRequestReadyForReview: {
                  pullRequest: { id: nodeId, number: 901, state: "OPEN", isDraft: false },
                },
              },
            }),
            { status: 200 },
          );
        },
        { apiUrl: testCase.apiUrl },
      ),
    );

    await broker.withScopedInstallationCredential(mutationRequest(), async (capability) => {
      await capability.apply({ kind: "MARK_PULL_REQUEST_READY", pullRequest: 901 });
    });

    assert.equal(calls[1], `${testCase.apiUrl}/repos/acme/inari/pulls/901`);
    assert.equal(calls[2], testCase.graphqlUrl);
  }
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

test("mutation failures retain distinct bounded provider classifications without secrets", async () => {
  const cases: Array<{
    readonly name: string;
    readonly expectedReason: "credential" | "scope" | "transport" | "provider-http" | "response-validation";
    readonly expectedStage: "installation-token" | "installation-scope" | "projection-execution";
    readonly expectedProviderFailure?: Readonly<Record<string, unknown>>;
    readonly fetch: typeof globalThis.fetch;
    readonly status?: number;
    readonly expectedProvider?: {
      readonly category: "validation-failed";
      readonly resource: "PullRequest";
      readonly field: "head";
      readonly code: "custom";
    };
  }> = [
    {
      name: "installation-token rejection",
      expectedReason: "credential",
      expectedStage: "installation-token",
      expectedProviderFailure: { failureClass: "server", retryable: true, status: 503 },
      fetch: async () => new Response("provider-token-secret", { status: 503 }),
    },
    {
      name: "installation scope mismatch",
      expectedReason: "scope",
      expectedStage: "installation-scope",
      fetch: async () => tokenResponse({ repositories: [] }),
    },
    {
      name: "provider transport failure",
      expectedReason: "transport",
      expectedStage: "projection-execution",
      expectedProviderFailure: { failureClass: "transport", retryable: true },
      fetch: (async (_input, init) => {
        if ((init?.body as string | undefined)?.includes('"permissions"')) {
          return tokenResponse({}, { contents: "write" });
        }
        throw new Error("Authorization: Bearer provider-transport-secret /private/provider/path");
      }) as typeof globalThis.fetch,
    },
    {
      name: "provider HTTP rejection",
      expectedReason: "provider-http",
      expectedStage: "projection-execution",
      expectedProviderFailure: { failureClass: "validation", retryable: false, status: 422 },
      status: 422,
      expectedProvider: {
        category: "validation-failed",
        resource: "PullRequest",
        field: "head",
        code: "custom",
      },
      fetch: (async (_input, init) => {
        if ((init?.body as string | undefined)?.includes('"permissions"')) {
          return tokenResponse({}, { contents: "write" });
        }
        return new Response(
          JSON.stringify({
            message: "Bearer provider-body-secret",
            errors: [
              {
                resource: "PullRequest",
                field: "head",
                code: "custom",
                message: "provider-controlled prose",
              },
            ],
          }),
          { status: 422 },
        );
      }) as typeof globalThis.fetch,
    },
    {
      name: "provider response validation",
      expectedReason: "response-validation",
      expectedStage: "projection-execution",
      expectedProviderFailure: { failureClass: "response-invalid", retryable: false },
      fetch: (async (_input, init) => {
        if ((init?.body as string | undefined)?.includes('"permissions"')) {
          return tokenResponse({}, { contents: "write" });
        }
        return new Response(JSON.stringify({ number: "903" }), { status: 201 });
      }) as typeof globalThis.fetch,
    },
  ];

  for (const testCase of cases) {
    const broker = new GitHubAppInstallationCredentialBroker(brokerOptions(testCase.fetch));
    await assert.rejects(
      broker.withScopedInstallationCredential(mutationRequest(), async (capability) => {
        await capability.apply(createPullRequestEffect);
      }),
      (error: unknown) => {
        assert.ok(error instanceof GitHubAppCredentialBrokerError, testCase.name);
        assert.equal(error.stage, testCase.expectedStage, testCase.name);
        assert.equal(error.reason, testCase.expectedReason, testCase.name);
        assert.equal(error.status, testCase.status, testCase.name);
        assert.deepEqual(error.provider, testCase.expectedProvider, testCase.name);
        assert.deepEqual(error.providerFailure, testCase.expectedProviderFailure, testCase.name);
        assert.doesNotMatch(
          JSON.stringify(error),
          /provider-token-secret|provider-transport-secret|provider-body-secret|private\/provider|authorization/iu,
          testCase.name,
        );
        return true;
      },
    );
  }
});

function neverRespondingFetch(): typeof globalThis.fetch {
  return (async (_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = (init as RequestInit | undefined)?.signal;
      if (signal !== undefined && signal !== null) {
        if (signal.aborted) {
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      }
    });
  }) as typeof globalThis.fetch;
}

function headersThenStalledBodyFetch(): typeof globalThis.fetch {
  return (async (_input, init) => {
    const signal = (init as RequestInit | undefined)?.signal;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                token: "installation-token-secret",
                expires_at: "2026-09-05T00:10:00.000Z",
                permissions: GITHUB_APP_REPOSITORY_READ_PERMISSIONS,
                repositories: [{ id: Number(target.repositoryId), full_name: target.nameWithOwner }],
              }),
            ),
          );
          const abort = () => controller.error(new DOMException("The operation was aborted.", "AbortError"));
          if (signal?.aborted) {
            abort();
          } else {
            signal?.addEventListener("abort", abort, { once: true });
          }
        },
      }),
      { status: 201 },
    );
  }) as typeof globalThis.fetch;
}

test("a hung installation-token request fails closed after the bounded deadline", async () => {
  const broker = new GitHubAppInstallationCredentialBroker(
    brokerOptions(neverRespondingFetch(), { requestTimeoutMs: 5 }),
  );
  const start = Date.now();
  await assert.rejects(
    broker.withRepositoryReadCapability({}, async () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof GitHubAppCredentialBrokerError);
      assert.equal(error.stage, "installation-token");
      assert.deepEqual(error.providerFailure, { failureClass: "timeout", retryable: true, timeoutMs: 5 });
      assert.equal(JSON.stringify(error).includes(privateKey), false);
      return true;
    },
  );
  assert.ok(Date.now() - start < 5_000, "the hung request must fail well before an unbounded wait");
});

test("a stalled installation-token response body fails closed after the bounded deadline", async () => {
  const broker = new GitHubAppInstallationCredentialBroker(
    brokerOptions(headersThenStalledBodyFetch(), { requestTimeoutMs: 5 }),
  );
  const start = Date.now();
  await assert.rejects(
    broker.withRepositoryReadCapability({}, async () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof GitHubAppCredentialBrokerError);
      assert.equal(error.stage, "installation-token");
      assert.deepEqual(error.providerFailure, { failureClass: "timeout", retryable: true, timeoutMs: 5 });
      assert.equal(JSON.stringify(error).includes(privateKey), false);
      return true;
    },
  );
  assert.ok(Date.now() - start < 5_000, "the stalled body must fail well before an unbounded wait");
});

test("a hung provider read request fails closed after the bounded deadline once credentialed", async () => {
  let calls = 0;
  const broker = new GitHubAppInstallationCredentialBroker(
    brokerOptions(
      async (input, init) => {
        calls += 1;
        if (calls === 1) return tokenResponse();
        return neverRespondingFetch()(input, init);
      },
      { requestTimeoutMs: 5 },
    ),
  );
  const start = Date.now();
  await assert.rejects(
    broker.withRepositoryReadCapability({}, (capability) =>
      capability.transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/inari" }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof GitHubAppCredentialBrokerError);
      assert.equal(error.stage, "repository-read");
      assert.deepEqual(error.providerFailure, { failureClass: "timeout", retryable: true, timeoutMs: 5 });
      assert.equal(JSON.stringify(error).includes(privateKey), false);
      return true;
    },
  );
  assert.ok(Date.now() - start < 5_000, "the hung request must fail well before an unbounded wait");
});

test("requestTimeoutMs is bounded within the compile-time ceiling", () => {
  assert.throws(
    () => new GitHubAppInstallationCredentialBroker(brokerOptions(neverRespondingFetch(), { requestTimeoutMs: 0 })),
  );
  assert.throws(
    () =>
      new GitHubAppInstallationCredentialBroker(brokerOptions(neverRespondingFetch(), { requestTimeoutMs: 999_999 })),
  );
});
