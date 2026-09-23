import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalRuntimeAuthorityJson,
  createManagedSession,
  generateRuntimeAuthorityKeyPair,
  issueSessionCertificate,
  renderRuntimeAuthorityArtifact,
  signSessionRequest,
  type RuntimeAuthority,
} from "./agent-authority/index.js";
import { assertRuntimeAuthority } from "./agent-authority/runtime-authority.js";
import type { GitHubAppRepositoryReadCapability } from "./github/app-installation-credential-broker.js";
import type { GitHubChangeEffectRepository } from "./github/change-effect-adapter.js";
import { projectChangeFromGitHubEvidence, type ChangeGitHubEvidence, type ChangeProjectionResult } from "./change.js";
import {
  INARI_ISSUER_PRINCIPAL,
  validateTrustedExecutionContext,
  type TrustedExecutionContext,
} from "./github/effect-authorizer.js";
import { ChangeTrustedExecutorError } from "./change-trusted-executor.js";
import {
  createCapabilityAuthorizedSessionExecutor,
  type CapabilityAuthorizedSessionExecutorOptions,
} from "./session-authorized-change-executor.js";
import type {
  ChangeExecutionResult,
  ChangeExecutionPort,
  ChangeMutationRequest,
  ChangeReadRequest,
} from "./change-execution-port.js";
import type { CapabilityClaim } from "./agent-authority/capability.js";
import type { SemanticSessionRequest } from "./agent-authority/session-request.js";

const NOW = new Date("2026-09-13T00:00:30.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const REPOSITORY: GitHubChangeEffectRepository = { hostname: "github.com", owner: "acme", name: "inari" };
const REPOSITORY_ID = "123456789";
const AUTHORITY_ID = "runtime-session-execution-test";
const POLICY_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const BLOB_SHA = "c".repeat(40);
const ISSUE = 465;
const BRANCH = "feat/465-session-authorized-change-execution";
const APP = {
  kind: "github-app" as const,
  slug: "inari-issuer" as const,
  appId: "1",
  principal: "app:inari-issuer" as const,
  installationId: "2",
};

function runtimeAuthority(): {
  readonly authority: RuntimeAuthority;
  readonly key: ReturnType<typeof generateRuntimeAuthorityKeyPair>;
} {
  const key = generateRuntimeAuthorityKeyPair();
  return {
    key,
    authority: assertRuntimeAuthority({
      version: 1,
      kind: "runtime-authority",
      id: AUTHORITY_ID,
      key: key.publicKeyJwk,
      status: "active",
      notBefore: "2026-01-01T00:00:00Z",
      notAfter: null,
      maxSessionTtlSeconds: 3_600,
      capabilityCeiling: ["change.implement", "change.ready", "change.abort", "branch.advance", "pullRequest.create"],
    }),
  };
}

function readCapability(authority: RuntimeAuthority): GitHubAppRepositoryReadCapability {
  const artifact = renderRuntimeAuthorityArtifact(authority);
  const content = Buffer.from(canonicalRuntimeAuthorityJson(authority), "utf8").toString("base64");
  return {
    providerPrincipal: APP,
    scope: {
      app: APP,
      installation: { appId: APP.appId, installationId: APP.installationId, repositoryHost: REPOSITORY.hostname },
      repository: { repositoryHost: REPOSITORY.hostname, repositoryId: REPOSITORY_ID, nameWithOwner: "acme/inari" },
      repositorySelection: "selected",
      permissions: { contents: "read", issues: "read", pull_requests: "read" },
      expiresAt: "2026-09-13T00:10:00Z",
    },
    transport: {
      async request(request) {
        if (request.path === "repos/acme/inari") {
          return {
            status: 200,
            body: { id: Number(REPOSITORY_ID), full_name: "acme/inari", fork: false, default_branch: "main" },
          };
        }
        if (request.path === "repos/acme/inari/git/ref/heads/main") {
          return { status: 200, body: { ref: "refs/heads/main", object: { type: "commit", sha: POLICY_SHA } } };
        }
        if (request.path.includes("/git/trees/")) {
          return {
            status: 200,
            body: { sha: TREE_SHA, truncated: false, tree: [{ path: artifact.path, type: "blob", sha: BLOB_SHA }] },
          };
        }
        if (request.path.includes("/git/blobs/")) {
          return { status: 200, body: { sha: BLOB_SHA, encoding: "base64", content } };
        }
        return { status: 404, body: {} };
      },
    },
  };
}

function signedEnvelope(
  operation: string,
  request: Record<string, unknown>,
  capabilities: readonly CapabilityClaim[],
): {
  readonly envelope: unknown;
  readonly authentication: CapabilityAuthorizedSessionExecutorOptions["authentication"];
} {
  const runtime = runtimeAuthority();
  const session = createManagedSession();
  const issuance = session.createIssuanceRequest({
    repository: { id: REPOSITORY_ID, name: "acme/inari" },
    task: { kind: "issue", number: ISSUE },
    capabilities,
    ttlSeconds: 600,
  });
  const certificate = issueSessionCertificate({
    repository: { id: REPOSITORY_ID, name: "acme/inari" },
    runtimeAuthority: runtime.authority,
    runtimeKey: runtime.key,
    request: issuance,
    now: NOW,
  });
  session.acceptCertificate(certificate.compact);
  const envelope = signSessionRequest({
    session,
    request: request as unknown as SemanticSessionRequest,
    operation,
    requestId: `request-${operation.replaceAll(".", "-")}`,
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + 60,
  });
  const capability = readCapability(runtime.authority);
  return {
    envelope,
    authentication: {
      broker: {
        async withRepositoryReadCapability<T>(
          _request: { readonly permissions?: unknown },
          callback: (value: GitHubAppRepositoryReadCapability) => Promise<T>,
        ): Promise<T> {
          return callback(capability);
        },
      },
      repository: REPOSITORY,
      now: NOW,
    },
  };
}

function projection(
  kind: "absent" | "branch-only" | "draft" | "review" | "aborted" | "duplicate",
): ChangeProjectionResult {
  const evidence: ChangeGitHubEvidence = {
    issue: { status: "available", value: { number: ISSUE, state: "open" } },
    branches:
      kind === "absent" || kind === "aborted"
        ? { status: "absent" }
        : {
            status: "available",
            value: [{ name: BRANCH, sha: "d".repeat(40), rootIssue: ISSUE }],
          },
    pullRequests:
      kind === "absent"
        ? { status: "absent" }
        : kind === "branch-only"
          ? { status: "available", value: [] }
          : kind === "duplicate"
            ? {
                status: "available",
                value: [
                  {
                    number: 4650,
                    head: BRANCH,
                    base: "main",
                    state: "open",
                    draft: true,
                    merged: false,
                    rootIssue: ISSUE,
                  },
                  {
                    number: 4651,
                    head: BRANCH,
                    base: "main",
                    state: "open",
                    draft: true,
                    merged: false,
                    rootIssue: ISSUE,
                  },
                ],
              }
            : {
                status: "available",
                value: [
                  {
                    number: 4650,
                    head: BRANCH,
                    base: "main",
                    state: kind === "aborted" ? "closed" : "open",
                    draft: kind === "draft",
                    merged: false,
                    rootIssue: ISSUE,
                    provenance: { issuer: INARI_ISSUER_PRINCIPAL },
                  },
                ],
              },
  };
  return projectChangeFromGitHubEvidence({
    change: { repositoryHost: REPOSITORY.hostname, repositoryId: REPOSITORY_ID, rootIssue: ISSUE },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "session-authorized-change-execution" },
    baseBranch: "main",
    provenance: { issuer: INARI_ISSUER_PRINCIPAL },
    evidence,
  });
}

class FakeChangeExecutor implements ChangeExecutionPort {
  readonly events: string[] = [];
  readonly #initial: ChangeProjectionResult;
  readonly #after: ChangeProjectionResult;
  readonly #executionProjection: ChangeProjectionResult;
  readonly #failure: "provider" | "recovery" | "none";
  #reads = 0;

  constructor(
    initial: ChangeProjectionResult,
    after: ChangeProjectionResult,
    options: { readonly executionProjection?: ChangeProjectionResult; readonly failure?: "provider" | "recovery" } = {},
  ) {
    this.#initial = initial;
    this.#after = after;
    this.#executionProjection = options.executionProjection ?? after;
    this.#failure = options.failure ?? "none";
  }

  async read(_request: ChangeReadRequest): Promise<ChangeProjectionResult> {
    this.events.push("read");
    this.#reads += 1;
    return this.#reads === 1 ? this.#initial : this.#after;
  }

  async execute(request: ChangeMutationRequest): Promise<ChangeProjectionResult | ChangeExecutionResult> {
    this.events.push("execute");
    if (this.#failure === "provider") throw new Error("provider response token=secret stack=private-key");
    if (this.#failure === "recovery") {
      return {
        projection: this.#executionProjection,
        evidence: {
          version: 1,
          operation: request.operation,
          outcome: "recovery-required",
          effects: [],
          failure: { kind: "CREATE_BRANCH", code: "BOUND_FAILURE", message: "bounded effect failure" },
        },
      };
    }
    return {
      projection: this.#executionProjection,
      evidence: { version: 1, operation: request.operation, outcome: "verified", effects: [] },
    };
  }
}

function optionsFor(
  operation: string,
  request: Record<string, unknown>,
  capabilities: readonly CapabilityClaim[],
  executor: FakeChangeExecutor,
): { readonly options: CapabilityAuthorizedSessionExecutorOptions; readonly envelope: unknown } {
  const signed = signedEnvelope(operation, request, capabilities);
  return {
    envelope: signed.envelope,
    options: {
      authentication: signed.authentication,
      changeExecutor: executor,
      app: APP,
      createChangeExecutor: async (input) => {
        executor.events.push("factory");
        assert.equal(input.execution.runtime, "inari-app");
        assert.equal("workflowRef" in input.execution, false);
        return { executor, app: APP };
      },
    },
  };
}

function directRequest(operation: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, issue: ISSUE, ...extra };
}

function publicationRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const repository = { repositoryHost: REPOSITORY.hostname, repositoryId: REPOSITORY_ID, repository: "acme/inari" };
  const implementation = { ...repository, number: ISSUE };
  return {
    version: 1,
    issue: ISSUE,
    publication: {
      version: 1,
      kind: "pr-publication",
      repository,
      workIdentity: { implementation },
      routing: {
        version: 1,
        kind: "integration-routing",
        mode: "standalone",
        role: "implementation",
        implementation,
        relationships: {},
        branches: {
          default: "main",
          implementation: BRANCH,
        },
        head: BRANCH,
        base: "main",
      },
      headRevision: "d".repeat(40),
      title: "feat: publish governed work",
      body: `Closes #${ISSUE}`,
      ...overrides,
    },
  };
}

test("executes change.issue/show/ready/abort through the frozen composition sequence", async () => {
  const cases = [
    {
      operation: "change.issue",
      capability: { kind: "change.implement", issue: ISSUE },
      initial: projection("absent"),
      after: projection("draft"),
    },
    {
      operation: "change.show",
      capability: { kind: "change.implement", issue: ISSUE },
      initial: projection("draft"),
      after: projection("draft"),
    },
    {
      operation: "change.ready",
      capability: { kind: "change.ready", issue: ISSUE },
      initial: projection("draft"),
      after: projection("review"),
    },
    {
      operation: "change.abort",
      capability: { kind: "change.abort", issue: ISSUE },
      initial: projection("draft"),
      after: projection("aborted"),
    },
  ] as const;
  for (const item of cases) {
    const executor = new FakeChangeExecutor(item.initial, item.after);
    const request = directRequest(
      item.operation,
      item.operation === "change.issue" ? { agent: { name: "codex", runtime: "test" } } : {},
    );
    const configured = optionsFor(item.operation, request, [item.capability], executor);
    const result = await createCapabilityAuthorizedSessionExecutor(configured.options).execute(configured.envelope);
    assert.equal(result.status, "succeeded");
    assert.equal(result.operation, item.operation);
    assert.ok(result.provenance);
    assert.equal(result.provenance.stage, item.operation === "change.show" ? "authorized" : "verified");
    assert.deepEqual(
      executor.events,
      item.operation === "change.show" ? ["read", "read"] : ["read", "factory", "execute", "read"],
    );
  }
});

test("pullRequest.publish requires the existing exact pullRequest.create capability", async () => {
  const executor = new FakeChangeExecutor(projection("branch-only"), projection("branch-only"));
  const missing = optionsFor(
    "pullRequest.publish",
    publicationRequest(),
    [{ kind: "change.implement", issue: ISSUE }],
    executor,
  );
  const denied = await createCapabilityAuthorizedSessionExecutor(missing.options).execute(missing.envelope);
  assert.equal(denied.status, "failed");
  assert.equal(denied.failure?.phase, "authorization");
  assert.deepEqual(executor.events, ["read"]);

  const accepted = optionsFor(
    "pullRequest.publish",
    publicationRequest(),
    [{ kind: "pullRequest.create", head: BRANCH, base: "main", max: 1 }],
    new FakeChangeExecutor(projection("branch-only"), projection("branch-only")),
  );
  const acceptedExecutor = accepted.options.changeExecutor as FakeChangeExecutor;
  const result = await createCapabilityAuthorizedSessionExecutor({
    ...accepted.options,
    app: APP,
    publishPullRequest: async () => ({
      publication: {
        version: 1,
        kind: "pr-publication",
        ok: true,
        classification: "created",
        outcome: "created",
        pullRequest: { number: 42, url: "https://github.com/acme/inari/pull/42" },
        diagnostics: [],
        effects: [{ kind: "CREATE_PULL_REQUEST", status: "succeeded" }],
      },
      app: APP,
    }),
  }).execute(accepted.envelope);
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.operation, "pullRequest.publish");
  assert.equal(result.publication?.classification, "created");
  assert.equal(result.provenance?.capability?.kind, "pullRequest.create");
  assert.deepEqual(acceptedExecutor.events, ["read"]);
});

test("pullRequest.publish rejects a publication repository mismatch before delegated mutation", async () => {
  const executor = new FakeChangeExecutor(projection("branch-only"), projection("branch-only"));
  const configured = optionsFor(
    "pullRequest.publish",
    publicationRequest({ repository: { repositoryHost: "github.com", repositoryId: "999", repository: "acme/inari" } }),
    [{ kind: "pullRequest.create", head: BRANCH, base: "main", max: 1 }],
    executor,
  );
  let delegated = false;
  const result = await createCapabilityAuthorizedSessionExecutor({
    ...configured.options,
    publishPullRequest: async () => {
      delegated = true;
      throw new Error("must not run");
    },
  }).execute(configured.envelope);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.phase, "request");
  assert.equal(delegated, false);
  assert.deepEqual(executor.events, []);
});

test("authentication failure returns before evidence or privileged execution and retains no provenance", async () => {
  const executor = new FakeChangeExecutor(projection("absent"), projection("draft"));
  const configured = optionsFor(
    "change.issue",
    directRequest("change.issue"),
    [{ kind: "change.implement", issue: ISSUE }],
    executor,
  );
  const envelope = { ...(configured.envelope as Record<string, unknown>), signature: `${"A".repeat(86)}A` };
  const result = await createCapabilityAuthorizedSessionExecutor(configured.options).execute(envelope);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "SESSION_EXECUTION_FAILED");
  assert.equal(result.failure?.phase, "authentication");
  assert.equal(result.provenance, undefined);
  assert.deepEqual(executor.events, []);
});

test("authorization denial happens after read but before the App/effect executor", async () => {
  const executor = new FakeChangeExecutor(projection("absent"), projection("draft"));
  const configured = optionsFor(
    "change.issue",
    directRequest("change.issue"),
    [{ kind: "change.ready", issue: ISSUE }],
    executor,
  );
  const result = await createCapabilityAuthorizedSessionExecutor(configured.options).execute(configured.envelope);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.phase, "authorization");
  assert.equal(result.provenance?.stage, "authenticated");
  assert.deepEqual(executor.events, ["read"]);
});

test("unknown direct fields fail closed and semanticPullRequestPlan is issue-only", async () => {
  const executor = new FakeChangeExecutor(projection("absent"), projection("draft"));
  const configured = optionsFor(
    "change.ready",
    directRequest("change.ready", {
      semanticPullRequestPlan: { leaked: "value" },
      requester: "github:spoofed",
    }),
    [{ kind: "change.ready", issue: ISSUE }],
    executor,
  );
  const result = await createCapabilityAuthorizedSessionExecutor(configured.options).execute(configured.envelope);
  assert.equal(result.failure?.phase, "request");
  assert.deepEqual(executor.events, []);
});

test("a signed direct requester assertion cannot influence App execution", async () => {
  const executor = new FakeChangeExecutor(projection("absent"), projection("draft"));
  const configured = optionsFor(
    "change.issue",
    directRequest("change.issue", { requester: "github:spoofed" }),
    [{ kind: "change.implement", issue: ISSUE }],
    executor,
  );
  const result = await createCapabilityAuthorizedSessionExecutor(configured.options).execute(configured.envelope);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.phase, "request");
  assert.equal(result.provenance, undefined);
  assert.deepEqual(executor.events, []);
});

test("provider/effect failures, recovery, conflict, and authoritative verification are bounded", async () => {
  const providerExecutor = new FakeChangeExecutor(projection("absent"), projection("draft"), { failure: "provider" });
  const provider = optionsFor(
    "change.issue",
    directRequest("change.issue"),
    [{ kind: "change.implement", issue: ISSUE }],
    providerExecutor,
  );
  const providerResult = await createCapabilityAuthorizedSessionExecutor(provider.options).execute(provider.envelope);
  assert.equal(providerResult.failure?.phase, "execution");
  assert.equal(JSON.stringify(providerResult).includes("token"), false);
  assert.equal(JSON.stringify(providerResult).includes("private-key"), false);
  assert.equal(providerResult.provenance?.stage, "app-scoped");

  const recoveryExecutor = new FakeChangeExecutor(projection("absent"), projection("draft"), { failure: "recovery" });
  const recovery = optionsFor(
    "change.issue",
    directRequest("change.issue"),
    [{ kind: "change.implement", issue: ISSUE }],
    recoveryExecutor,
  );
  const recoveryResult = await createCapabilityAuthorizedSessionExecutor(recovery.options).execute(recovery.envelope);
  assert.equal(recoveryResult.failure?.phase, "recovery-required");
  assert.equal(recoveryResult.provenance?.stage, "app-scoped");

  const conflictExecutor = new FakeChangeExecutor(projection("duplicate"), projection("duplicate"));
  const conflict = optionsFor(
    "change.issue",
    directRequest("change.issue"),
    [{ kind: "change.implement", issue: ISSUE }],
    conflictExecutor,
  );
  const conflictResult = await createCapabilityAuthorizedSessionExecutor(conflict.options).execute(conflict.envelope);
  assert.equal(conflictResult.failure?.phase, "conflict");
  assert.deepEqual(conflictExecutor.events, ["read"]);

  const mismatchExecutor = new FakeChangeExecutor(projection("absent"), projection("review"), {
    executionProjection: projection("draft"),
  });
  const mismatch = optionsFor(
    "change.issue",
    directRequest("change.issue"),
    [{ kind: "change.implement", issue: ISSUE }],
    mismatchExecutor,
  );
  const mismatchResult = await createCapabilityAuthorizedSessionExecutor(mismatch.options).execute(mismatch.envelope);
  assert.equal(mismatchResult.failure?.phase, "verification");
});

test("direct App trusted context dispatches without weakening the existing Actions variant", () => {
  const direct = validateTrustedExecutionContext({
    version: 1,
    runtime: "inari-app",
    event: "session-request",
    repository: { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, nameWithOwner: "acme/inari" },
    requestId: "request-1",
    sessionId: "session-1",
    certificateJti: "certificate-1",
    requester: "session:session-1",
  });
  assert.equal(direct.valid, true);
  const rejectedImpersonation = validateTrustedExecutionContext({
    ...direct.value,
    workflowRef: "refs/heads/main",
  });
  assert.equal(rejectedImpersonation.valid, false);

  const actions: TrustedExecutionContext = {
    version: 1,
    runtime: "github-actions",
    event: "workflow_dispatch",
    repository: { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, nameWithOwner: "acme/inari" },
    workflowRef: "refs/heads/main",
    workflowSha: "a".repeat(40),
    workflowTrust: "protected",
    codeExecution: "trusted-only",
    fork: false,
    pullRequest: false,
  };
  assert.equal(validateTrustedExecutionContext(actions).valid, true);
});

function branchAdvanceRequest(): Record<string, unknown> {
  return {
    version: 1,
    issue: ISSUE,
    branch: BRANCH,
    expectedHead: "d".repeat(40),
    changes: [
      {
        operation: "upsert",
        path: "src/session.txt",
        mode: "100644",
        content: Buffer.from("after", "utf8").toString("base64"),
      },
    ],
    commit: { message: "bounded test commit", author: { name: "Test Author", email: "test@example.test" } },
  };
}

test("branch.advance requires bound Implementation scope before reaching provider execution", async () => {
  const executor = new FakeChangeExecutor(projection("draft"), projection("draft"));
  const signed = signedEnvelope("branch.advance", branchAdvanceRequest(), [{ kind: "branch.advance", branch: BRANCH }]);
  let delegated = 0;
  const result = await createCapabilityAuthorizedSessionExecutor({
    authentication: signed.authentication,
    changeExecutor: executor,
    branchAdvance: async () => {
      delegated += 1;
      throw new Error("Must not run without bound Implementation scope.");
    },
  }).execute(signed.envelope);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.phase, "authorization");
  assert.equal(result.branchAdvance?.failure?.reason, "authorization");
  assert.equal(delegated, 0);
  assert.deepEqual(executor.events, ["read"]);
});

test("ChangeTrustedExecutor errors retain only its bounded diagnostics/evidence", async () => {
  const executor = new FakeChangeExecutor(projection("absent"), projection("draft"));
  executor.execute = async () => {
    throw new ChangeTrustedExecutorError("CHANGE_EXECUTION_RECOVERY_REQUIRED", "secret provider stack", [], {
      version: 1,
      operation: "issue",
      outcome: "recovery-required",
      effects: [],
    });
  };
  const configured = optionsFor(
    "change.issue",
    directRequest("change.issue"),
    [{ kind: "change.implement", issue: ISSUE }],
    executor,
  );
  const result = await createCapabilityAuthorizedSessionExecutor(configured.options).execute(configured.envelope);
  assert.equal(result.failure?.code, "SESSION_EXECUTION_FAILED");
  assert.equal(result.failure?.phase, "recovery-required");
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
