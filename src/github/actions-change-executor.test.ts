import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  GitHubActionsApiTransport,
  GitHubActionsCredentialBroker,
  GitHubActionsEvidenceReader,
  GitHubActionsChangeExecutorError,
  TRUSTED_ACTIONS_FAILURE_STAGES,
  createGitHubActionsChangeExecutor,
  deriveChangeNamingFromIssueTitle,
  isTrustedActionsFailureStage,
  runGitHubActionsChangeExecutor,
} from "./actions-change-executor.js";
import type {
  GitHubChangeEffectRequest,
  GitHubChangeEffectResponse,
  GitHubChangeEffectTransport,
} from "./change-effect-adapter.js";
import {
  INARI_ISSUER_PRINCIPAL,
  type IssuerCredentialRequest,
  type IssuerRepositoryIdentity,
} from "./issuer-authority.js";
import { changeRemoteMutationRequest, changeRemoteReadRequest } from "../change-executor.js";

const repository = { hostname: "github.com", owner: "acme", name: "inari" } as const;
const target: IssuerRepositoryIdentity = {
  repositoryHost: "github.com",
  repositoryId: "218000001",
  nameWithOwner: "acme/inari",
};

function issuerCredentialRequest(): IssuerCredentialRequest {
  return {
    version: 1,
    authority: "issuer",
    app: { kind: "github-app", slug: "inari-issuer", appId: "218", principal: INARI_ISSUER_PRINCIPAL },
    execution: {
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
    },
    target,
    permissions: { contents: "write" },
  };
}

test("Issue title naming is resolved by the executable runtime and not by workflow YAML", () => {
  assert.deepEqual(deriveChangeNamingFromIssueTitle("feat: Execute Change plans safely"), {
    type: "feat",
    slug: "execute-change-plans-safely",
  });
  assert.deepEqual(deriveChangeNamingFromIssueTitle("fix: normalize café input"), {
    type: "fix",
    slug: "normalize-cafe-input",
  });
  assert.throws(() => deriveChangeNamingFromIssueTitle("unclassified work"));
});

test("trusted Actions diagnostics are enumerable, bounded, and non-secret", () => {
  assert.deepEqual(TRUSTED_ACTIONS_FAILURE_STAGES, [
    "repository-evidence",
    "trusted-execution",
    "branch-governance",
    "issuer-configuration",
    "installation-token",
    "installation-scope",
    "projection-execution",
  ]);
  for (const stage of TRUSTED_ACTIONS_FAILURE_STAGES) {
    const error = new GitHubActionsChangeExecutorError("Bearer secret-token", stage);
    assert.deepEqual(error.details, { stage });
    assert.equal(isTrustedActionsFailureStage(stage), true);
    assert.equal(JSON.stringify(error.details).includes("secret-token"), false);
  }
  assert.equal(isTrustedActionsFailureStage("arbitrary-provider-error"), false);
});

class ReadTransport implements GitHubChangeEffectTransport {
  readonly calls: GitHubChangeEffectRequest[] = [];

  async request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse> {
    this.calls.push(request);
    if (request.path.endsWith("repos/acme/inari/")) {
      return { status: 200, body: { id: 218000001, default_branch: "main" } };
    }
    if (request.path.endsWith("issues/218")) {
      return { status: 200, body: { number: 218, title: "feat: Execute Change plans safely", state: "open" } };
    }
    if (request.path.includes("git/ref/heads/feat%2F218-execute-change-plans-safely")) {
      return { status: 404, body: { message: "Not Found" } };
    }
    if (request.path.includes("pulls?state=all")) return { status: 200, body: [] };
    throw new Error("unexpected read");
  }
}

test("Actions evidence reader returns only bounded Core projection input", async () => {
  const transport = new ReadTransport();
  const reader = new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 218 },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    transport,
  });
  const result = await reader.read(changeRemoteMutationRequest("issue", 218));

  assert.deepEqual(result.naming, {
    type: "feat",
    slug: "execute-change-plans-safely",
  });
  assert.deepEqual(result.evidence.branches, { status: "available", value: [] });
  assert.deepEqual(result.evidence.pullRequests, { status: "available", value: [] });
  assert.equal(JSON.stringify(result).includes("Not Found"), false);
});

test("App installation token is confined to the broker transport and never its scope/result", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const token = "installation-secret-token";
  const calls: RequestInit[] = [];
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push(init ?? {});
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          token,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          permissions: { contents: "write", metadata: "read" },
          repositories: [{ id: Number(target.repositoryId), full_name: target.nameWithOwner }],
        }),
        { status: 201 },
      );
    }
    if (calls.length === 2) {
      return new Response(JSON.stringify({ ref: "refs/heads/main", object: { type: "commit", sha: "a".repeat(40) } }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({ ref: "refs/heads/feat/218-safe", object: { type: "commit", sha: "a".repeat(40) } }),
      {
        status: 201,
      },
    );
  };
  const broker = new GitHubActionsCredentialBroker({
    appId: "218",
    installationId: "219",
    privateKeyPem,
    repository,
    target,
    fetch,
  });
  const request = issuerCredentialRequest();
  let capabilityScope: unknown;
  await broker.withScopedInstallationCredential(request, async (capability) => {
    capabilityScope = capability.scope;
    await capability.apply({ kind: "CREATE_BRANCH", branch: "feat/218-safe", baseBranch: "main" });
  });
  assert.equal(JSON.stringify(capabilityScope).includes(token), false);
  assert.equal(JSON.stringify(capabilityScope).includes(privateKeyPem), false);
  assert.match(String(calls[1]?.headers && JSON.stringify(calls[1]?.headers)), /Bearer installation-secret-token/u);
});

test("API transport does not return credential-bearing headers or unbounded response data", async () => {
  const token = "read-token";
  let received: RequestInit | undefined;
  const transport = new GitHubActionsApiTransport({
    token,
    fetch: async (_input, init) => {
      received = init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  const result = await transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/inari" });
  assert.deepEqual(result, { status: 200, body: { ok: true } });
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.match(JSON.stringify(received?.headers), /Bearer read-token/u);
});

test("API transport failures expose only the bounded projection boundary", async () => {
  const transport = new GitHubActionsApiTransport({
    token: "read-token",
    failureStage: "projection-execution",
    fetch: async () => {
      throw new Error("Authorization: Bearer secret-token; /private/path");
    },
  });
  await assert.rejects(
    transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/inari" }),
    (error: unknown) =>
      error instanceof GitHubActionsChangeExecutorError &&
      error.details?.stage === "projection-execution" &&
      !error.message.includes("secret-token") &&
      !JSON.stringify(error).includes("secret-token") &&
      !JSON.stringify(error).includes("/private/path"),
  );
});

function trustedEnvironment(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_REPOSITORY: "acme/inari",
    GITHUB_TOKEN: "read-token",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: "acme/inari/.github/workflows/inari-change-executor.yml@refs/heads/main",
    GITHUB_WORKFLOW_SHA: "a".repeat(40),
    INARI_ISSUER_APP_ID: "218",
    INARI_ISSUER_INSTALLATION_ID: "219",
    INARI_ISSUER_APP_PRIVATE_KEY: "unused-in-these-tests",
    ...overrides,
  };
}

function repositoryOnlyFetch(fork: boolean): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify({ id: 218000001, default_branch: "main", fork }), {
      status: 200,
    })) as unknown as typeof globalThis.fetch;
}

test("runtime setup exposes the bounded stage at each setup boundary", async () => {
  const cases: readonly {
    readonly name: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly stage: (typeof TRUSTED_ACTIONS_FAILURE_STAGES)[number];
  }[] = [
    {
      name: "repository evidence",
      environment: trustedEnvironment({ GITHUB_REPOSITORY: undefined }),
      stage: "repository-evidence",
    },
    {
      name: "trusted execution",
      environment: trustedEnvironment({ GITHUB_REF: "refs/heads/feature-x" }),
      stage: "trusted-execution",
    },
    {
      name: "branch governance",
      environment: trustedEnvironment(),
      cwd: "/tmp/inari-missing-governance",
      stage: "branch-governance",
    },
    {
      name: "issuer configuration",
      environment: trustedEnvironment({ INARI_ISSUER_APP_ID: undefined }),
      stage: "issuer-configuration",
    },
  ];
  for (const testCase of cases) {
    await assert.rejects(
      createGitHubActionsChangeExecutor({
        cwd: testCase.cwd ?? process.cwd(),
        request: changeRemoteMutationRequest("issue", 218),
        environment: testCase.environment,
        fetch: repositoryOnlyFetch(false),
      }),
      (error: unknown) => error instanceof GitHubActionsChangeExecutorError && error.details?.stage === testCase.stage,
      testCase.name,
    );
  }
});

test("workflow entrypoint emits the bounded diagnostic and no exception payload", async () => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    const exitCode = await runGitHubActionsChangeExecutor(
      trustedEnvironment({
        INARI_CHANGE_REQUEST: JSON.stringify({ version: 1, operation: "issue", issue: 218 }),
        GITHUB_REPOSITORY: undefined,
      }),
      process.cwd(),
    );
    assert.equal(exitCode, 1);
  } finally {
    process.stdout.write = originalWrite;
  }
  const output = JSON.parse(writes.join("")) as { error?: Record<string, unknown> };
  assert.deepEqual(output.error, {
    code: "CHANGE_ACTIONS_RUNTIME_INVALID",
    message: "Trusted Change execution failed closed.",
    details: { stage: "repository-evidence" },
  });
  assert.doesNotMatch(JSON.stringify(output), /privateKey|token|exception|\/home/iu);
});

test("credential issuance and scope validation keep separate bounded stages", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const brokerOptions = {
    appId: "218",
    installationId: "219",
    privateKeyPem,
    repository,
    target,
  } as const;
  const request = issuerCredentialRequest();

  const tokenFailure = new GitHubActionsCredentialBroker({
    ...brokerOptions,
    fetch: async () => new Response("provider-secret", { status: 503 }),
  });
  await assert.rejects(
    tokenFailure.withScopedInstallationCredential(request, async () => undefined),
    (error: unknown) =>
      error instanceof GitHubActionsChangeExecutorError && error.details?.stage === "installation-token",
  );

  const scopeFailure = new GitHubActionsCredentialBroker({
    ...brokerOptions,
    fetch: async () =>
      new Response(
        JSON.stringify({
          token: "installation-secret-token",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          permissions: { contents: "write" },
          repositories: [],
        }),
        { status: 201 },
      ),
  });
  await assert.rejects(
    scopeFailure.withScopedInstallationCredential(request, async () => undefined),
    (error: unknown) =>
      error instanceof GitHubActionsChangeExecutorError &&
      error.details?.stage === "installation-scope" &&
      !error.message.includes("installation-secret-token") &&
      !JSON.stringify(error).includes("installation-secret-token"),
  );
});

test("Trusted executor construction rejects a workflow_ref naming a different workflow file", async () => {
  await assert.rejects(
    createGitHubActionsChangeExecutor({
      cwd: process.cwd(),
      request: changeRemoteMutationRequest("issue", 218),
      environment: trustedEnvironment({
        GITHUB_WORKFLOW_REF: "acme/inari/.github/workflows/other.yml@refs/heads/main",
      }),
      fetch: repositoryOnlyFetch(false),
    }),
  );
});

test("Trusted executor construction rejects a workflow_ref off the protected main branch", async () => {
  await assert.rejects(
    createGitHubActionsChangeExecutor({
      cwd: process.cwd(),
      request: changeRemoteMutationRequest("issue", 218),
      environment: trustedEnvironment({
        GITHUB_WORKFLOW_REF: "acme/inari/.github/workflows/inari-change-executor.yml@refs/heads/feature-x",
      }),
      fetch: repositoryOnlyFetch(false),
    }),
  );
});

test("Trusted executor construction rejects a workflow_ref from a different repository (cross-repo workflow_call)", async () => {
  await assert.rejects(
    createGitHubActionsChangeExecutor({
      cwd: process.cwd(),
      request: changeRemoteMutationRequest("issue", 218),
      environment: trustedEnvironment({
        GITHUB_WORKFLOW_REF: "other-org/other-repo/.github/workflows/inari-change-executor.yml@refs/heads/main",
      }),
      fetch: repositoryOnlyFetch(false),
    }),
  );
});

test("Trusted executor construction rejects a caller ref that is not the protected main branch", async () => {
  await assert.rejects(
    createGitHubActionsChangeExecutor({
      cwd: process.cwd(),
      request: changeRemoteMutationRequest("issue", 218),
      environment: trustedEnvironment({ GITHUB_REF: "refs/heads/feature-x" }),
      fetch: repositoryOnlyFetch(false),
    }),
  );
});

test("Trusted executor construction rejects a pull-request-triggered ref", async () => {
  await assert.rejects(
    createGitHubActionsChangeExecutor({
      cwd: process.cwd(),
      request: changeRemoteMutationRequest("issue", 218),
      environment: trustedEnvironment({ GITHUB_REF: "refs/pull/1/merge" }),
      fetch: repositoryOnlyFetch(false),
    }),
  );
});

test("Trusted executor construction rejects a forked target repository", async () => {
  await assert.rejects(
    createGitHubActionsChangeExecutor({
      cwd: process.cwd(),
      request: changeRemoteMutationRequest("issue", 218),
      environment: trustedEnvironment(),
      fetch: repositoryOnlyFetch(true),
    }),
  );
});

test("Trusted executor construction succeeds when the workflow ref, target ref, and repository identity are all proven", async () => {
  const executor = await createGitHubActionsChangeExecutor({
    cwd: process.cwd(),
    request: changeRemoteMutationRequest("issue", 218),
    environment: trustedEnvironment(),
    fetch: repositoryOnlyFetch(false),
  });
  assert.ok(executor);
});

test("read-only Change executor construction does not require Issuer App secrets", async () => {
  const environment = trustedEnvironment();
  delete environment.INARI_ISSUER_APP_ID;
  delete environment.INARI_ISSUER_INSTALLATION_ID;
  delete environment.INARI_ISSUER_APP_PRIVATE_KEY;
  const executor = await createGitHubActionsChangeExecutor({
    cwd: process.cwd(),
    request: changeRemoteReadRequest(218),
    environment,
    fetch: repositoryOnlyFetch(false),
  });
  assert.equal(typeof executor.read, "function");
});
