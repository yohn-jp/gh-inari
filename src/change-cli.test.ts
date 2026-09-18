import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  createSessionCredentialBundle,
  persistSessionCredentialBundle,
  type SessionIssuanceRequestDocument,
} from "./agent-authority/session-bundle.js";
import {
  AGENT_INVOCATION_CONTRACT,
  COMMAND_CONTRACT_ID,
  commandExample,
  commandInvocation,
  commandUsage,
  getCommand,
  getCommandForPositionals,
  projectCommandContract,
  projectCommandHelp,
} from "./command-contract.js";
import {
  CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
  ChangeExecutionPortError,
  createUnavailableChangeExecutionPort,
  type ChangeExecutionPort,
  type ChangeExecutionEvidence,
  type ChangeMutationRequest,
  type ChangeReadRequest,
} from "./change-execution-port.js";
import { projectChangeFromGitHubEvidence, type ChangeProjectionResult } from "./change.js";
import { runCli } from "./cli.js";
import { GitHubAuthenticationError, GitHubAdapter } from "./github/index.js";
import {
  createActionsChangeExecutionAdapter,
  type ActionsChangeExecutionAdapterApi,
} from "./github/actions-change-execution-adapter.js";
import { findSkillScenario, SKILL_MODEL_VERSION } from "./skill.js";
import { GOLDEN_PATH_STATUS_VERSION } from "./golden-path-status.js";
import { verifyChangeProvenanceRecord } from "./change-provenance-record.js";
import { createRuntimeAuthorityRecord } from "./agent-authority/runtime-authority-operations.js";
import { renderRuntimeAuthorityArtifact } from "./agent-authority/runtime-authority-trust.js";
import { generateRuntimeAuthorityKeyPair } from "./agent-authority/runtime-key.js";

const identity = {
  repositoryHost: "github.com",
  repositoryId: "100000219",
  rootIssue: 42,
} as const;
const branch = "feat/42-semantic-change";

const runtimeSignerPair = generateRuntimeAuthorityKeyPair();
const runtimeSignerAuthority = createRuntimeAuthorityRecord({
  id: "runtime-cli-test",
  key: runtimeSignerPair,
  notBefore: "2026-01-01T00:00:00Z",
  maxSessionTtlSeconds: 7200,
  capabilityCeiling: ["change.implement", "change.ready"],
});
const runtimeSignerArtifact = renderRuntimeAuthorityArtifact(runtimeSignerAuthority);
const runtimeSignerPrivateKeyPem = runtimeSignerPair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const runtimeSignerEnvironment = {
  INARI_RUNTIME_AUTHORITY_ID: runtimeSignerAuthority.id,
  INARI_RUNTIME_AUTHORITY_PRIVATE_KEY: runtimeSignerPrivateKeyPem,
};

function runtimeTrustAdapter(overrides: Record<string, unknown> = {}): GitHubAdapter {
  const context = {
    hostname: "github.com",
    host: "github.com",
    owner: "acme",
    name: "inari",
    nameWithOwner: "acme/inari",
    url: "https://github.com/acme/inari",
    repositoryId: identity.repositoryId,
  };
  return {
    async resolveRepositoryContext() {
      return context;
    },
    async getRepositoryContext() {
      return context;
    },
    async getRepositoryDefaultBranch() {
      return "main";
    },
    async findBranch(branchName: string) {
      return { name: branchName, ref: `refs/heads/${branchName}`, sha: "runtime-policy-commit" };
    },
    async getRepositoryTree() {
      return {
        sha: "runtime-policy-tree",
        entries: [{ path: runtimeSignerArtifact.path, type: "blob" as const, sha: "runtime-policy-blob" }],
      };
    },
    async getRepositoryBlob(sha: string) {
      if (sha !== "runtime-policy-blob") throw new Error("unexpected Runtime Authority blob");
      return runtimeSignerArtifact.content;
    },
    ...overrides,
  } as unknown as GitHubAdapter;
}

function runtimeSignerDependencies(overrides: Parameters<typeof runCli>[1] = {}): Parameters<typeof runCli>[1] {
  return {
    environment: runtimeSignerEnvironment,
    createAdapter: () => runtimeTrustAdapter(),
    ...overrides,
  };
}

/** A Direct App Session credential bundle; unrelated to the caller-side Delegator signer under test. */
async function createDirectAppBundleFile(dir: string): Promise<string> {
  const sessionKey = generateRuntimeAuthorityKeyPair();
  const request: SessionIssuanceRequestDocument = {
    version: 1,
    kind: "inari-session-issuance-request",
    runtimeAuthority: createRuntimeAuthorityRecord({
      id: "session-issuer",
      key: sessionKey,
      notBefore: "2020-01-01T00:00:00Z",
      maxSessionTtlSeconds: 3600,
      capabilityCeiling: ["change.implement"],
    }),
    repository: { id: identity.repositoryId, name: "acme/inari" },
    task: { kind: "issue", number: identity.rootIssue },
    capabilities: [{ kind: "change.implement", issue: identity.rootIssue }],
    ttlSeconds: 1800,
  } as SessionIssuanceRequestDocument;
  const created = createSessionCredentialBundle({
    request,
    runtimeKey: sessionKey,
    now: new Date("2026-06-01T00:00:00Z"),
  });
  const filePath = path.join(dir, "bundle.json");
  persistSessionCredentialBundle(filePath, created.bundle);
  return filePath;
}

function installFakeFetch(handler: (url: URL, body: unknown) => { status: number; body: unknown }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const { status, body: responseBody } = handler(url, body);
    return new Response(JSON.stringify(responseBody), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function projection(draft = true): ChangeProjectionResult {
  const result = projectChangeFromGitHubEvidence({
    change: identity,
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "semantic-change" },
    baseBranch: "main",
    evidence: {
      issue: { status: "available", value: { number: identity.rootIssue, state: "open" } },
      branches: { status: "available", value: [{ name: branch }] },
      pullRequests: {
        status: "available",
        value: [
          {
            number: 142,
            head: branch,
            base: "main",
            state: "open",
            draft,
            merged: false,
          },
        ],
      },
    },
  });
  assert.equal(result.valid, true);
  return result;
}

function executor(calls: Array<ChangeMutationRequest | ChangeReadRequest>, result = projection()): ChangeExecutionPort {
  return {
    async execute(request) {
      calls.push(request);
      return result;
    },
    async read(request) {
      calls.push(request);
      return result;
    },
  };
}

async function capture(
  argv: readonly string[],
  dependencies: Parameters<typeof runCli>[1] = {},
): Promise<{ readonly exitCode: number; readonly output: Record<string, unknown> | undefined }> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli([...argv], dependencies);
    const last = lines.at(-1);
    return { exitCode, output: last === undefined ? undefined : (JSON.parse(last) as Record<string, unknown>) };
  } finally {
    console.log = originalLog;
  }
}

test("Change commands are additions to the existing canonical command authority", () => {
  const ids = [
    "change.issue",
    "change.show",
    "change.handoff",
    "change.ready",
    "change.abort",
    "change.merge",
    "change.publish",
  ] as const;
  const contract = projectCommandContract();
  assert.equal(contract.id, COMMAND_CONTRACT_ID);
  assert.equal(contract.invocation, AGENT_INVOCATION_CONTRACT);
  for (const id of ids) {
    const definition = getCommand(id);
    const projected = contract.commands.find((entry) => entry.id === id);
    assert.ok(projected);
    assert.equal(getCommandForPositionals(definition.path)?.id, id);
    assert.equal(projected.invocation, commandInvocation(id));
    assert.equal(projected.example, commandExample(id));
    assert.match(commandUsage(definition), /^change (issue|show|handoff|ready|abort|publish) <number>/u);
  }
  assert.deepEqual(
    projectCommandHelp(["change"]).commands.map((entry) => entry.id),
    ids,
  );
});

test("change show reads a bounded projection without invoking mutation", async () => {
  const calls: Array<ChangeMutationRequest | ChangeReadRequest> = [];
  const result = await capture(["change", "show", "42", "--json"], {
    changeExecutor: executor(calls),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
    operation: "show",
    issue: 42,
  });
  assert.equal(result.output?.ok, true);
  assert.equal(result.output?.change, 42);
  assert.equal(result.output?.issue, 42);
  assert.equal(result.output?.state, "DRAFT");
  assert.equal(result.output?.branch, branch);
  assert.equal(result.output?.pullRequest, 142);
  assert.equal(result.output?.operation, "change.show");
  assert.deepEqual(result.output?.contractVersions, {
    goldenPath: String(GOLDEN_PATH_STATUS_VERSION),
    statusRecovery: String(GOLDEN_PATH_STATUS_VERSION),
    skill: SKILL_MODEL_VERSION,
  });
});

test("change show forwards an explicit repository target to its executor factory", async () => {
  let factoryOptions: Record<string, unknown> | undefined;
  const result = await capture(["change", "show", "42", "--repository", "acme/target", "--json"], {
    createChangeExecutor: (options) => {
      factoryOptions = { ...options };
      return executor([]);
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(factoryOptions, { cwd: process.cwd(), repository: "acme/target" });
});

test("change handoff reads the same Change projection and exposes only canonical identity", async () => {
  const calls: Array<ChangeMutationRequest | ChangeReadRequest> = [];
  const result = await capture(["change", "handoff", "42", "--json"], {
    changeExecutor: executor(calls),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [
    {
      version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
      operation: "show",
      issue: 42,
    },
  ]);
  assert.equal(result.output?.ok, true);
  assert.equal(result.output?.valid, true);
  assert.deepEqual(result.output?.handoff, {
    version: 1,
    kind: "implementation-handoff",
    repositoryHost: identity.repositoryHost,
    repositoryId: identity.repositoryId,
    rootIssue: identity.rootIssue,
    changeVersion: 1,
    state: "DRAFT",
    branch,
    baseBranch: "main",
    pullRequest: 142,
  });
  assert.doesNotMatch(JSON.stringify(result.output?.handoff), /worktree|session|process|checkout/iu);
});

test("change handoff rejects an already-review Change without mutation", async () => {
  const calls: Array<ChangeMutationRequest | ChangeReadRequest> = [];
  const result = await capture(["change", "handoff", "42", "--json"], {
    changeExecutor: executor(calls, projection(false)),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(calls[0]?.operation, "show");
  assert.equal(result.output?.ok, false);
  assert.equal(result.output?.valid, false);
  assert.equal(result.output?.handoff, undefined);
  assert.ok(Array.isArray(result.output?.diagnostics));
});

test("change handoff includes the repository locator when an adapter is available", async () => {
  const calls: Array<ChangeMutationRequest | ChangeReadRequest> = [];
  const result = await capture(["change", "handoff", "42", "--json"], {
    changeExecutor: executor(calls),
    createAdapter: () =>
      ({
        async getRepositoryContext() {
          return {
            hostname: "github.com",
            host: "github.com",
            owner: "acme",
            name: "inari",
            nameWithOwner: "acme/inari",
            url: "https://github.com/acme/inari",
            repositoryId: identity.repositoryId,
          };
        },
      }) as unknown as GitHubAdapter,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.output?.ok, true);
  assert.equal((result.output?.handoff as Record<string, unknown> | undefined)?.repositoryNameWithOwner, "acme/inari");
});

test("authoritative Change commands use semantic executor requests only", async () => {
  const calls: Array<ChangeMutationRequest | ChangeReadRequest> = [];
  const factoryCalls: Record<string, unknown>[] = [];
  const result = await capture(["change", "ready", "42", "--repository", "acme/inari", "--json"], {
    createChangeExecutor: (options) => {
      factoryCalls.push({ ...options });
      return executor(calls, projection(false));
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(factoryCalls, [{ cwd: process.cwd(), repository: "acme/inari" }]);
  assert.deepEqual(calls, [
    {
      version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
      operation: "ready",
      issue: 42,
    },
  ]);
  assert.equal(result.output?.operation, "change.ready");
  assert.equal(result.output?.state, "REVIEW");
  assert.doesNotMatch(JSON.stringify(calls), /workflow|dispatch|token|credential|privateKey/iu);
});

test("abort is routed through the same executor boundary", async () => {
  const calls: Array<ChangeMutationRequest | ChangeReadRequest> = [];
  const result = await capture(["change", "abort", "42", "--json"], {
    changeExecutor: executor(calls),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(calls[0]?.operation, "abort");
  assert.equal(result.output?.operation, "change.abort");
});

test("CLI preserves the normalized provider rejection projection in execution evidence", async () => {
  const evidence: ChangeExecutionEvidence = {
    version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
    operation: "ready",
    outcome: "failed",
    effects: [{ kind: "MARK_PULL_REQUEST_READY", status: "failed" }],
    failure: {
      kind: "MARK_PULL_REQUEST_READY",
      code: "PULL_REQUEST_READY_FAILED",
      message: "The pull request ready effect failed.",
      reason: "provider-http",
      status: 422,
      provider: { category: "validation-failed", resource: "PullRequest", field: "head", code: "custom" },
    },
  };
  const result = await capture(["change", "ready", "42", "--json"], {
    changeExecutor: {
      async execute() {
        return { projection: projection(), evidence };
      },
      async read() {
        throw new Error("unreachable");
      },
    },
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual((result.output?.evidence as Record<string, unknown> | undefined)?.failure, evidence.failure);
});

test("default Change wiring omits caller requester and normalizes dispatch failure", async () => {
  const calls: Array<{ url: URL; body: unknown }> = [];
  const token = "native-actions-test-token";
  const originalToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = token;
  const restoreFetch = installFakeFetch((url, body) => {
    calls.push({ url, body });
    if (url.pathname === "/repos/acme/inari") return { status: 200, body: { id: identity.repositoryId, fork: false } };
    if (url.pathname.endsWith(`/actions/workflows/inari-change-executor.yml/runs`)) {
      return { status: 200, body: { workflow_runs: [] } };
    }
    if (url.pathname.endsWith(`/actions/workflows/inari-change-executor.yml/dispatches`)) {
      return { status: 500, body: { message: "dispatch failed" } };
    }
    throw new Error(`unexpected URL ${url}`);
  });
  const adapterOptions: ConstructorParameters<typeof GitHubAdapter>[0][] = [];
  try {
    const result = await capture(["change", "issue", "42", "--repository", "acme/inari", "--json"], {
      repositoryRoot: "/workspace/inari",
      environment: runtimeSignerEnvironment,
      createAdapter: (options) => {
        adapterOptions.push(options);
        return runtimeTrustAdapter();
      },
    });

    assert.equal(result.exitCode, 3);
    assert.equal((result.output?.error as { code?: string } | undefined)?.code, "CHANGE_REMOTE_DISPATCH_FAILED");
    assert.deepEqual(adapterOptions, [{ cwd: "/workspace/inari", repository: "acme/inari" }]);
    const dispatch = calls.find((call) => call.url.pathname.endsWith("/dispatches"));
    assert.ok(dispatch);
    const dispatched = dispatch.body as { readonly inputs?: { readonly request?: string } };
    const request = JSON.parse(dispatched.inputs?.request ?? "{}") as Record<string, unknown>;
    const signedProvenanceRecord = request.signedProvenanceRecord;
    delete request.signedProvenanceRecord;
    assert.deepEqual(request, {
      version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
      operation: "issue",
      issue: 42,
    });
    assert.equal(typeof signedProvenanceRecord, "object");
    assert.deepEqual(verifyChangeProvenanceRecord(signedProvenanceRecord, runtimeSignerAuthority), {
      version: 1,
      rootIssue: 42,
      operation: "change.issue",
    });
    assert.doesNotMatch(JSON.stringify(result.output), /token|privateKey|secret|workflow_path/iu);
  } finally {
    restoreFetch();
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
  }
});

test("GitHub Actions Change wiring never supplies caller-side requester or resolves /user", async () => {
  // The trusted executor (the workflow_dispatch-authenticated actor) is the sole authority
  // for requester provenance in the Actions execution lane -- see
  // TrustedChangeExecutor.assertRequest(). The caller must not inject GITHUB_ACTOR (or
  // GITHUB_TRIGGERING_ACTOR) as requester, and must not resolve /user either.
  const calls: Array<{ url: URL; body: unknown }> = [];
  const token = "actions-wiring-test-token";
  const originalToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = token;
  const restoreFetch = installFakeFetch((url, body) => {
    calls.push({ url, body });
    if (url.pathname === "/repos/acme/inari") return { status: 200, body: { id: identity.repositoryId, fork: false } };
    if (url.pathname.endsWith(`/actions/workflows/inari-change-executor.yml/runs`)) {
      return { status: 200, body: { workflow_runs: [] } };
    }
    if (url.pathname.endsWith(`/actions/workflows/inari-change-executor.yml/dispatches`)) {
      return { status: 500, body: { message: "dispatch failed" } };
    }
    throw new Error(`unexpected URL ${url}`);
  });
  try {
    const result = await capture(["change", "issue", "42", "--repository", "acme/inari", "--json"], {
      repositoryRoot: "/workspace/inari",
      environment: {
        ...runtimeSignerEnvironment,
        GITHUB_ACTIONS: "true",
        GITHUB_ACTOR: "actions-actor",
        GITHUB_TRIGGERING_ACTOR: "triggering-actor",
      },
      createAdapter: () => runtimeTrustAdapter(),
    });

    assert.equal(result.exitCode, 3);
    assert.equal((result.output?.error as { code?: string } | undefined)?.code, "CHANGE_REMOTE_DISPATCH_FAILED");
    assert.equal(
      calls.some((call) => call.url.pathname === "/user"),
      false,
    );
    const dispatch = calls.find((call) => call.url.pathname.endsWith("/dispatches"));
    assert.ok(dispatch);
    const dispatched = dispatch.body as { readonly inputs?: { readonly request?: string } };
    const request = JSON.parse(dispatched.inputs?.request ?? "{}") as Record<string, unknown>;
    assert.equal("requester" in request, false);
  } finally {
    restoreFetch();
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
  }
});

test("fresh change issue fails before dispatch when the Runtime signer is not configured", async () => {
  let constructed = false;
  let executed = false;
  const result = await capture(["change", "issue", "42", "--json"], {
    environment: {},
    createAdapter: () => runtimeTrustAdapter(),
    createChangeExecutor: () => {
      constructed = true;
      return {
        async execute() {
          executed = true;
          throw new Error("unreachable");
        },
        async read() {
          throw new Error("unreachable");
        },
      };
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(constructed, false);
  assert.equal(executed, false);
  assert.deepEqual(result.output?.error, {
    code: "CHANGE_PROVENANCE_RECORD_SIGNING_FAILED",
    message: "Runtime signer configuration must provide an authority ID and private key.",
    diagnostics: [],
  });
});

test("Direct App Session selection for change issue signs locally, never constructs a GitHubAdapter, and ignores poisoned ambient GitHub credentials", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".change-issue-direct-app-"));
  try {
    const bundlePath = await createDirectAppBundleFile(dir);
    let executeRequest: Record<string, unknown> | undefined;
    const restore = installFakeFetch((url, body) => {
      assert.equal(url.pathname, "/v1/execute");
      const envelope = body as { operation: string; request: Record<string, unknown> };
      assert.equal(envelope.operation, "change.issue");
      executeRequest = envelope.request;
      return {
        status: 200,
        body: {
          version: 1,
          ok: true,
          operation: "change.issue",
          requestId: "r1",
          result: { version: 1, status: "succeeded", execution: { projection: projection() } },
        },
      };
    });
    try {
      const result = await capture(
        [
          "change",
          "issue",
          String(identity.rootIssue),
          "--session-credential",
          bundlePath,
          "--app-endpoint",
          "https://app.example.com",
          "--json",
        ],
        {
          environment: {
            ...runtimeSignerEnvironment,
            // Poison ambient GitHub user credentials must never be read or
            // promoted into authority on the Direct App Session path.
            GH_TOKEN: "poison-gh-token",
            GITHUB_TOKEN: "poison-github-token",
            GH_ENTERPRISE_TOKEN: "poison-gh-enterprise-token",
            GITHUB_ENTERPRISE_TOKEN: "poison-github-enterprise-token",
          },
          createAdapter: () => {
            throw new Error("GitHubAdapter must not be constructed on the Direct App Session path");
          },
        },
      );

      assert.equal(result.exitCode, 0, JSON.stringify(result.output));
      assert.ok(executeRequest !== undefined);
      const signedProvenanceRecord = executeRequest.signedProvenanceRecord;
      assert.equal(typeof signedProvenanceRecord, "object");
      assert.deepEqual(verifyChangeProvenanceRecord(signedProvenanceRecord, runtimeSignerAuthority), {
        version: 1,
        rootIssue: identity.rootIssue,
        operation: "change.issue",
      });
      assert.doesNotMatch(JSON.stringify(executeRequest), /poison-/u);
    } finally {
      restore();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI preserves the bounded trusted Actions diagnostic stage", async () => {
  const result = await capture(
    ["change", "issue", "42", "--json"],
    runtimeSignerDependencies({
      changeExecutor: {
        async execute() {
          throw new ChangeExecutionPortError(
            "CHANGE_REMOTE_RUN_FAILED",
            "The trusted Change workflow did not produce a successful result.",
            { operation: "change.issue", reason: "workflow-failed", stage: "installation-token" },
          );
        },
        async read() {
          throw new Error("unreachable");
        },
      },
    }),
  );

  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.output?.error, {
    code: "CHANGE_REMOTE_RUN_FAILED",
    message: "The trusted Change workflow did not produce a successful result.",
    details: { operation: "change.issue", reason: "workflow-failed", stage: "installation-token" },
  });
});

test("CLI --json preserves the bounded trusted code and Core diagnostic envelope", async () => {
  const result = await capture(
    ["change", "issue", "42", "--json"],
    runtimeSignerDependencies({
      changeExecutor: {
        async execute() {
          throw new ChangeExecutionPortError(
            "CHANGE_REMOTE_RUN_FAILED",
            "The trusted Change workflow did not produce a successful result.",
            {
              operation: "change.issue",
              reason: "workflow-failed",
              stage: "projection-execution",
              trustedCode: "CHANGE_EXECUTION_PRECONDITION_FAILED",
            },
            [
              {
                version: 1,
                code: "CHANGE_PROVENANCE_CONFLICT",
                path: "$.projection.change.provenance",
                message: "The trusted Change provenance is inconsistent.",
              },
            ],
          );
        },
        async read() {
          throw new Error("unreachable");
        },
      },
    }),
  );

  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.output?.error, {
    code: "CHANGE_REMOTE_RUN_FAILED",
    message: "The trusted Change workflow did not produce a successful result.",
    details: {
      operation: "change.issue",
      reason: "workflow-failed",
      stage: "projection-execution",
      trustedCode: "CHANGE_EXECUTION_PRECONDITION_FAILED",
    },
    diagnostics: [
      {
        version: 1,
        code: "CHANGE_PROVENANCE_CONFLICT",
        path: "$.projection.change.provenance",
        message: "The trusted Change provenance is inconsistent.",
      },
    ],
  });
});

test("caller transport authentication failure is distinct from an unconfigured executor", async () => {
  const api: ActionsChangeExecutionAdapterApi = {
    async getRepositoryContext() {
      return runtimeTrustAdapter().getRepositoryContext();
    },
    async requestActionsApi() {
      throw new GitHubAuthenticationError("github.com", "token=secret");
    },
    async downloadActionsArtifact() {
      throw new Error("unreachable");
    },
  };
  const authResult = await capture(["change", "issue", "42", "--json"], {
    environment: runtimeSignerEnvironment,
    createAdapter: () => runtimeTrustAdapter(),
    createChangeExecutor: (options) =>
      createActionsChangeExecutionAdapter({
        ...options,
        api,
        maxPollAttempts: 1,
        pollIntervalMs: 0,
        sleep: async () => undefined,
      }),
  });
  assert.equal(authResult.exitCode, 3);
  assert.deepEqual(authResult.output?.error, {
    code: "CHANGE_REMOTE_TRANSPORT_FAILED",
    message: "The GitHub Actions Change transport failed.",
    details: { operation: "change.issue", reason: "authentication", stage: "run-read" },
  });

  const unavailableResult = await capture(
    ["change", "issue", "42", "--json"],
    runtimeSignerDependencies({ changeExecutor: createUnavailableChangeExecutionPort() }),
  );
  assert.equal(unavailableResult.exitCode, 3);
  assert.deepEqual(unavailableResult.output?.error, {
    code: "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE",
    message: "No remote Change executor is configured for this CLI runtime.",
    details: { operation: "issue" },
  });
});

test("invalid Change numbers fail before the executor is constructed", async () => {
  let constructed = false;
  const result = await capture(["change", "show", "0", "--json"], {
    createChangeExecutor: () => {
      constructed = true;
      return executor([]);
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(constructed, false);
  assert.equal((result.output?.error as { code?: string } | undefined)?.code, "INVALID_CHANGE_NUMBER");
});

test("Change parsing rejects options outside the canonical command definition", async () => {
  let constructed = false;
  const result = await capture(["change", "show", "42", "--title", "ignored", "--json"], {
    createChangeExecutor: () => {
      constructed = true;
      return executor([]);
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(constructed, false);
  assert.deepEqual(result.output?.error, {
    code: "INVALID_OPTION",
    message: "Option --title is not supported by change show.",
    path: "$argv",
    details: { command: "change show", option: "title" },
  });
});

test("Skill references resolve the four Change commands through the canonical model", () => {
  const scenario = findSkillScenario("manage-change");
  assert.ok(scenario);
  assert.deepEqual(
    scenario.workflow.map((step) => step.command),
    [
      "inari change issue <number>",
      "inari change show <number>",
      "inari change ready <number>",
      "inari change abort <number>",
    ],
  );
  assert.equal(scenario.helpPointer, "inari change --help");
});
