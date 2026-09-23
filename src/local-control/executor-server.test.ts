import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { canonicalizeSemanticRequest } from "../agent-authority/session-request.js";
import type { BranchAdvanceSemanticRequest } from "../agent-authority/branch-advance.js";
import { createCapabilityExecutionProvenance } from "../agent-authority/capability-provenance.js";
import { validateCapabilityClaim, type CapabilityClaim } from "../agent-authority/capability.js";
import {
  createDelegatorRecord,
  createLocalDelegatorSignedChangeProvenanceRecord,
} from "../agent-authority/delegator-operations.js";
import { renderDelegatorArtifact } from "../agent-authority/delegator-trust.js";
import { createAuthorizedExecution, type AuthorizedExecution } from "../authorized-execution.js";
import { renderIssueArtifact, renderPullRequestArtifact } from "../artifact.js";
import type { SignedChangeProvenanceRecord } from "../change-provenance-record.js";
import { changeMutationRequest } from "../change-execution-port.js";
import { compileIssueFormYaml } from "../contract/issue-form.js";
import { projectChangeFromGitHubEvidence } from "../change.js";
import { createAppUserCredential } from "../github/app-user-credential.js";
import { FileAppUserCredentialStore } from "../github/app-user-credential-store.js";
import { assertTrustedExecution, type RepositoryIdentity } from "../github/effect-authorizer.js";
import type { PrPublicationRequest } from "../pr-publication.js";
import { parsePullRequestTemplate } from "../pull-request-template.js";
import {
  executeLocalAuthorizedExecution,
  LocalExecutorError,
  setupLocalExecutor,
  startConfiguredLocalExecutor,
} from "./executor-server.js";

const ISSUE = 1026;
const REPOSITORY: RepositoryIdentity = {
  repositoryHost: "github.com",
  repositoryId: "123456789",
  nameWithOwner: "acme/inari",
};
const BRANCH = "feat/1026-local-executor-server";
const EXPECTED_HEAD = "d".repeat(40);
const TREE = "c".repeat(40);
const EXISTING_BLOB = "b".repeat(40);
const NEW_TREE = "e".repeat(40);
const NEW_HEAD = "f".repeat(40);
const APP = {
  kind: "github-app" as const,
  slug: "inari-issuer" as const,
  appId: "123456",
  principal: "app:inari-issuer" as const,
  installationId: "456",
};
const CHANGE_PULL_REQUEST = 10261;
const CHANGE_TITLE = "feat: Local Executor Server";
const POLICY_COMMIT = "1".repeat(40);
const POLICY_TREE = "2".repeat(40);
const AUTHORITY_BLOB = "3".repeat(40);
const READY_ISSUE_TEMPLATE_PATH = ".github/ISSUE_TEMPLATE/feature.yml";
const READY_ISSUE_TEMPLATE_SOURCE = `name: Feature\ndescription: A feature change\ntitle: "feat: "\nbody:\n  - type: textarea\n    id: problem\n    attributes:\n      label: Problem\n    validations:\n      required: true\n`;
const READY_PR_TEMPLATE_PATH = ".github/PULL_REQUEST_TEMPLATE.md";
const READY_PR_TEMPLATE_SOURCE = "## Summary\n\nSummarize the change.\n";
const READY_ISSUE_TEMPLATE_SHA = "4".repeat(40);
const READY_PR_TEMPLATE_SHA = "5".repeat(40);
const READY_ISSUE_CONTRACT = compileIssueFormYaml(READY_ISSUE_TEMPLATE_SOURCE, {
  id: "feature",
  type: "issue-form",
  kind: "issue",
  name: "Feature",
  path: READY_ISSUE_TEMPLATE_PATH,
});
const READY_PR_CONTRACT = parsePullRequestTemplate(READY_PR_TEMPLATE_SOURCE, {
  id: "default",
  type: "pull-request-default",
  kind: "pull-request",
  name: "Default pull request",
  path: READY_PR_TEMPLATE_PATH,
});
const READY_ISSUE_BODY = renderIssueArtifact(READY_ISSUE_CONTRACT, {
  problem: "Exercise Local Executor Ready with repository-governed artifacts.",
});
const READY_PR_BODY = renderPullRequestArtifact(READY_PR_CONTRACT, {
  summary: "Exercise Local Executor Ready with repository-governed artifacts.",
});

function capability(input: unknown): CapabilityClaim {
  const result = validateCapabilityClaim(input);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.ok(result.value);
  return result.value;
}

function authorizedProvenance(
  operation: string,
  claim: CapabilityClaim,
  subject: AuthorizedExecution["subject"],
): ReturnType<typeof createCapabilityExecutionProvenance> {
  const requestId = `executor-${operation.replaceAll(".", "-")}`;
  return createCapabilityExecutionProvenance({
    version: 1,
    stage: "authorized",
    repository: REPOSITORY,
    runtimeAuthority: { id: "runtime-executor-test", kid: "delegator-key" },
    session: { id: "session-executor-test", certificateJti: "certificate-executor-test" },
    authority: { ref: "refs/heads/main", sha: "a".repeat(40) },
    request: { requestId, operation, issuedAt: 1_800_000_000, expiresAt: 1_800_000_060 },
    subject,
    capability: claim,
  });
}

function trustedExecution(provenance: ReturnType<typeof authorizedProvenance>) {
  return assertTrustedExecution({
    version: 1,
    runtime: "inari-app",
    event: "session-request",
    repository: REPOSITORY,
    requestId: provenance.request.requestId,
    sessionId: provenance.session.id,
    certificateJti: provenance.session.certificateJti,
    requester: `session:${provenance.session.id}`,
  });
}

function branchExecution(): AuthorizedExecution {
  const request: BranchAdvanceSemanticRequest = {
    version: 1,
    issue: ISSUE,
    branch: BRANCH,
    expectedHead: EXPECTED_HEAD,
    changes: [
      {
        operation: "upsert",
        path: "src/local-control/production.txt",
        mode: "100644",
        content: Buffer.from("provider verified").toString("base64"),
      },
    ],
    commit: { message: "test: exercise production branch advance" },
  };
  const claim = capability({ kind: "branch.advance", branch: BRANCH });
  const subject = { kind: "branch" as const, issue: ISSUE, branch: BRANCH };
  const provenance = authorizedProvenance("branch.advance", claim, subject);
  return createAuthorizedExecution({
    version: 1,
    operation: "branch.advance",
    repository: REPOSITORY,
    task: { kind: "issue", number: ISSUE },
    subject,
    capability: claim,
    provenance,
    request,
    branchAuthorization: {
      version: 1,
      requestDigest: createHash("sha256").update(canonicalizeSemanticRequest(request), "utf8").digest("hex"),
      implementation: { number: ISSUE, governedBodyDigest: "9".repeat(64) },
      paths: [{ path: request.changes[0]!.path, operations: ["WRITE"] }],
    },
  });
}

function publicationExecution(): AuthorizedExecution {
  const repository = {
    repositoryHost: REPOSITORY.repositoryHost,
    repositoryId: REPOSITORY.repositoryId,
    repository: REPOSITORY.nameWithOwner,
  };
  const implementation = { ...repository, number: ISSUE };
  const request: PrPublicationRequest = {
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
      branches: { default: "main", implementation: BRANCH },
      head: BRANCH,
      base: "main",
    },
    headRevision: EXPECTED_HEAD,
    title: "feat: exercise Executor PR publication",
    body: `Closes #${ISSUE}`,
    draft: true,
  };
  const claim = capability({ kind: "pullRequest.create", head: BRANCH, base: "main", max: 1 });
  const subject = { kind: "pullRequest" as const, issue: ISSUE, head: BRANCH, base: "main" };
  const provenance = authorizedProvenance("pullRequest.publish", claim, subject);
  return createAuthorizedExecution({
    version: 1,
    operation: "pullRequest.publish",
    repository: REPOSITORY,
    task: { kind: "issue", number: ISSUE },
    subject,
    capability: claim,
    provenance,
    request,
    execution: trustedExecution(provenance),
  });
}

function changeExecution(
  operation: "show" | "issue" | "ready" | "abort" | "merge",
  signedProvenanceRecord?: SignedChangeProvenanceRecord,
): AuthorizedExecution {
  const name = `change.${operation}`;
  const request =
    operation === "show"
      ? { version: 1 as const, operation, issue: ISSUE }
      : changeMutationRequest(
          operation,
          ISSUE,
          undefined,
          signedProvenanceRecord,
          operation === "merge" ? "squash" : undefined,
        );
  const capabilityInput =
    operation === "show" || operation === "issue"
      ? { kind: "change.implement", issue: ISSUE }
      : { kind: name, issue: ISSUE };
  const claim = capability(capabilityInput);
  const subject = { kind: "change" as const, issue: ISSUE };
  const provenance = authorizedProvenance(name, claim, subject);
  const common = {
    version: 1 as const,
    operation: name,
    repository: REPOSITORY,
    task: { kind: "issue" as const, number: ISSUE },
    subject,
    capability: claim,
    provenance,
    request,
  };
  return operation === "show"
    ? createAuthorizedExecution({ ...common, operation: name, initialProjection: absentChangeProjection() })
    : createAuthorizedExecution({ ...common, operation: name, execution: trustedExecution(provenance) });
}

function absentChangeProjection() {
  return projectChangeFromGitHubEvidence({
    change: { repositoryHost: REPOSITORY.repositoryHost, repositoryId: REPOSITORY.repositoryId, rootIssue: ISSUE },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "local-executor-server" },
    baseBranch: "main",
    provenance: { issuer: "app:inari-issuer" },
    evidence: {
      issue: { status: "available", value: { number: ISSUE, state: "open" } },
      branches: { status: "absent" },
      pullRequests: { status: "absent" },
    },
  });
}

async function signedIssueProvenanceFixture() {
  const keyPair = generateKeyPairSync("ed25519");
  const authority = createDelegatorRecord({
    id: "executor-production-test",
    key: keyPair.publicKey,
    notBefore: "2026-01-01T00:00:00Z",
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement"],
  });
  return {
    artifact: renderDelegatorArtifact(authority),
    signedProvenanceRecord: await createLocalDelegatorSignedChangeProvenanceRecord(ISSUE, {
      authorityId: authority.id,
      privateKey: keyPair.privateKey,
      now: new Date("2026-09-23T00:00:00Z"),
    }),
  };
}

function providerFetch(
  options: {
    readonly change?: "absent" | "active";
    readonly draft?: boolean;
    readonly issueBody?: string;
    readonly pullRequestBody?: string;
    readonly repositoryArtifacts?: readonly Readonly<{ path: string; sha: string; content: string }>[];
  } = {},
): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: { readonly method: string; readonly url: URL; readonly body?: Record<string, unknown> }[];
} {
  let branchHead = EXPECTED_HEAD;
  let pullRequest: Record<string, unknown> | undefined;
  let changeBranchPresent = options.change === "active";
  let changePullRequestState: "open" | "closed" = "open";
  let changeDraft = options.draft ?? true;
  const calls: { method: string; url: URL; body?: Record<string, unknown> }[] = [];
  const repository = {
    id: Number(REPOSITORY.repositoryId),
    node_id: "R_123456789",
    full_name: REPOSITORY.nameWithOwner,
    owner: { login: "acme" },
    name: "inari",
    default_branch: "main",
  };
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, url, ...(body === undefined ? {} : { body }) });
    if (url.pathname === "/user/installations" && method === "GET") {
      return json({
        installations: [
          {
            id: 456,
            app_id: Number(APP.appId),
            suspended_at: null,
            permissions: { contents: "write", issues: "write", pull_requests: "write", metadata: "read" },
          },
        ],
      });
    }
    if (url.pathname === "/user/installations/456/repositories" && method === "GET") {
      return json({ repositories: [{ ...repository, permissions: { contents: "write", metadata: "read" } }] });
    }
    if (url.pathname === "/repos/acme/inari" && method === "GET") return json(repository);
    if (url.pathname === `/repos/acme/inari/issues/${ISSUE}` && method === "GET") {
      return json({
        number: ISSUE,
        title: CHANGE_TITLE,
        state: "open",
        body: options.issueBody ?? "A bounded Change fixture body.",
      });
    }
    if (
      options.repositoryArtifacts !== undefined &&
      url.pathname === "/repos/acme/inari/git/ref/heads/main" &&
      method === "GET"
    ) {
      return json({ ref: "refs/heads/main", object: { type: "commit", sha: POLICY_COMMIT } });
    }
    if (
      options.repositoryArtifacts !== undefined &&
      (url.pathname === `/repos/acme/inari/git/trees/${POLICY_COMMIT}` ||
        url.pathname === "/repos/acme/inari/git/trees/main") &&
      method === "GET"
    ) {
      return json({
        sha: POLICY_TREE,
        truncated: false,
        tree: [
          ...(options.repositoryArtifacts ?? []).map(({ path: artifactPath, sha }) => ({
            path: artifactPath,
            type: "blob",
            sha,
          })),
        ],
      });
    }
    const repositoryArtifact = options.repositoryArtifacts?.find((artifact) =>
      url.pathname.endsWith(`/git/blobs/${artifact.sha}`),
    );
    if (repositoryArtifact !== undefined && method === "GET") {
      return json({
        sha: repositoryArtifact.sha,
        encoding: "base64",
        content: Buffer.from(repositoryArtifact.content, "utf8").toString("base64"),
      });
    }
    if (
      options.change !== undefined &&
      url.pathname === `/repos/acme/inari/git/ref/heads/${encodeURIComponent(BRANCH)}` &&
      method === "GET"
    ) {
      return changeBranchPresent
        ? json({ ref: `refs/heads/${BRANCH}`, object: { type: "commit", sha: EXPECTED_HEAD } })
        : json({}, 404);
    }
    if (
      options.change !== undefined &&
      url.pathname === "/repos/acme/inari/git/matching-refs/heads/" &&
      method === "GET"
    ) {
      return json(
        changeBranchPresent ? [{ ref: `refs/heads/${BRANCH}`, object: { type: "commit", sha: EXPECTED_HEAD } }] : [],
      );
    }
    if (url.pathname === "/repos/acme/inari/git/ref/heads/" + encodeURIComponent(BRANCH) && method === "GET") {
      return json({ ref: `refs/heads/${BRANCH}`, object: { type: "commit", sha: branchHead } });
    }
    if (url.pathname === `/repos/acme/inari/git/commits/${EXPECTED_HEAD}` && method === "GET") {
      return json({ sha: EXPECTED_HEAD, tree: { sha: TREE } });
    }
    if (url.pathname === `/repos/acme/inari/git/trees/${TREE}` && method === "GET") {
      return json({
        sha: TREE,
        truncated: false,
        tree: [{ path: "src/local-control/production.txt", mode: "100644", type: "blob", sha: EXISTING_BLOB }],
      });
    }
    if (url.pathname.startsWith("/repos/acme/inari/git/trees/") && method === "GET") {
      return json({ sha: TREE, truncated: false, tree: [] });
    }
    if (url.pathname === "/repos/acme/inari/git/blobs" && method === "POST") {
      assert.equal(body?.encoding, "base64");
      const content = String(body?.content);
      const bytes = Buffer.from(content, "base64");
      const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      return json({ sha }, 201);
    }
    if (url.pathname === "/repos/acme/inari/git/trees" && method === "POST") return json({ sha: NEW_TREE }, 201);
    if (url.pathname === "/repos/acme/inari/git/commits" && method === "POST") {
      branchHead = NEW_HEAD;
      return json({ sha: NEW_HEAD }, 201);
    }
    if (url.pathname === "/graphql" && method === "POST") {
      if (body?.query && String(body.query).includes("PullRequestReadyForReview")) {
        changeDraft = false;
        return json({
          data: {
            markPullRequestReadyForReview: {
              pullRequest: { id: "PR_10261", number: CHANGE_PULL_REQUEST, state: "OPEN", isDraft: false },
            },
          },
        });
      }
      return json({ data: { updateRefs: { refUpdates: [{}] } } });
    }
    if (url.pathname === "/repos/acme/inari/pulls" && method === "GET") {
      if (url.searchParams.get("head") === `acme:${BRANCH}` && url.searchParams.get("state") === "all") {
        return json(
          options.change === "active"
            ? [
                {
                  number: CHANGE_PULL_REQUEST,
                  head: { ref: BRANCH, sha: EXPECTED_HEAD, repo: { full_name: REPOSITORY.nameWithOwner } },
                  base: { ref: "main" },
                  user: { login: "inari-issuer[bot]" },
                  state: changePullRequestState,
                  draft: changeDraft,
                  merged_at: null,
                },
              ]
            : [],
        );
      }
      return json([]);
    }
    if (url.pathname === `/repos/acme/inari/pulls/${CHANGE_PULL_REQUEST}` && method === "GET") {
      return json({
        number: CHANGE_PULL_REQUEST,
        node_id: "PR_10261",
        html_url: `https://github.com/acme/inari/pull/${CHANGE_PULL_REQUEST}`,
        title: CHANGE_TITLE,
        body: options.pullRequestBody ?? "Closes #1026",
        head: { ref: BRANCH, sha: EXPECTED_HEAD, repo: { full_name: REPOSITORY.nameWithOwner } },
        base: { ref: "main" },
        user: { login: "inari-issuer[bot]" },
        state: changePullRequestState,
        draft: changeDraft,
        merged_at: null,
      });
    }
    if (url.pathname === `/repos/acme/inari/pulls/${CHANGE_PULL_REQUEST}` && method === "PATCH") {
      changePullRequestState = "closed";
      return json({ number: CHANGE_PULL_REQUEST, state: "closed" });
    }
    if (url.pathname === `/repos/acme/inari/git/refs/heads/${encodeURIComponent(BRANCH)}` && method === "DELETE") {
      changeBranchPresent = false;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/repos/acme/inari/pulls" && method === "POST") {
      pullRequest = {
        number: 10260,
        html_url: "https://github.com/acme/inari/pull/10260",
        title: body?.title,
        body: body?.body,
        head: { ref: body?.head, sha: EXPECTED_HEAD },
        base: { ref: body?.base },
        state: "open",
        draft: true,
      };
      return json(pullRequest, 201);
    }
    if (url.pathname === "/repos/acme/inari/pulls/10260" && method === "GET" && pullRequest !== undefined) {
      return json(pullRequest);
    }
    throw new Error(`unexpected mock provider request: ${method} ${url.pathname}${url.search}`);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

async function withProviderFetch<T>(fetch: typeof globalThis.fetch, operation: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await operation();
  } finally {
    globalThis.fetch = original;
  }
}

async function temporaryEnvironment(): Promise<{ readonly root: string; readonly environment: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-local-executor-"));
  return {
    root,
    environment: {
      INARI_CONFIG_HOME: path.join(root, "config"),
      INARI_GITHUB_APP_ID: "123456",
    },
  };
}

async function saveCredential(environment: NodeJS.ProcessEnv): Promise<void> {
  const store = new FileAppUserCredentialStore({
    path: path.join(environment.INARI_CONFIG_HOME as string, "app-user-credential.json"),
  });
  await store.save(
    createAppUserCredential({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      accessTokenExpiresAt: "2027-01-01T00:00:00.000Z",
      refreshTokenExpiresAt: "2027-06-01T00:00:00.000Z",
    }),
  );
}

test("Executor setup provisions stable identity and references the existing App-user credential store", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    await saveCredential(environment);
    const first = await setupLocalExecutor(environment);
    const second = await setupLocalExecutor(environment);
    assert.equal(first.config.id, second.config.id);
    assert.match(first.config.id, /^exec_[A-Za-z0-9_-]{16,64}$/u);
    assert.equal(first.configPath, path.join(environment.INARI_CONFIG_HOME as string, "executor", "config.json"));
    assert.deepEqual(first.config, {
      version: 1,
      id: first.config.id,
      listen: { host: "127.0.0.1", port: 0 },
      provider: { kind: "github", credentialProfile: "default" },
    });
    const configText = await readFile(first.configPath, "utf8");
    assert.equal(configText.includes("access-secret"), false);
    assert.equal(configText.includes("refresh-secret"), false);
    assert.ok(
      (await readFile(path.join(environment.INARI_CONFIG_HOME as string, "app-user-credential.json"), "utf8")).includes(
        "access-secret",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Executor setup accepts an explicit all-interface bind policy", async () => {
  const { root, environment } = await temporaryEnvironment();
  environment.INARI_LOCAL_RUNTIME_BIND = "0.0.0.0";
  try {
    await saveCredential(environment);
    const configured = await setupLocalExecutor(environment);
    assert.equal(configured.config.listen.host, "0.0.0.0");
    assert.equal(configured.config.listen.port, 0);
    delete environment.INARI_LOCAL_RUNTIME_BIND;
    await assert.rejects(
      () => setupLocalExecutor(environment),
      (error: unknown) => error instanceof LocalExecutorError && error.code === "EXECUTOR_BIND_POLICY_CONFLICT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Executor serve fails closed when setup or existing provider credentials are missing", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    await assert.rejects(
      () => startConfiguredLocalExecutor("0.14.1", environment),
      (error: unknown) => {
        assert.ok(error instanceof LocalExecutorError);
        assert.equal(error.code, "EXECUTOR_NOT_SETUP");
        return true;
      },
    );

    await saveCredential(environment);
    const configured = await setupLocalExecutor(environment);
    await unlink(path.join(environment.INARI_CONFIG_HOME as string, "app-user-credential.json"));
    await assert.rejects(
      () => startConfiguredLocalExecutor("0.14.1", environment),
      (error: unknown) => {
        assert.ok(error instanceof LocalExecutorError);
        assert.equal(error.code, "EXECUTOR_CREDENTIALS_MISSING");
        assert.match(error.message, /authorization is missing/u);
        assert.match(error.message, /inari setup --endpoint/u);
        return true;
      },
    );
    assert.ok(configured.config.id.startsWith("exec_"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Executor setup reports missing credentials without creating component configuration", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    await assert.rejects(
      () => setupLocalExecutor(environment),
      (error: unknown) => {
        assert.ok(error instanceof LocalExecutorError);
        assert.equal(error.code, "EXECUTOR_CREDENTIALS_MISSING");
        assert.match(error.message, /Device Flow/u);
        assert.match(error.message, /inari setup --endpoint/u);
        return true;
      },
    );
    await assert.rejects(readFile(path.join(environment.INARI_CONFIG_HOME as string, "executor", "config.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Executor setup names the supported App ID configuration when credentials exist", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    await saveCredential(environment);
    delete environment.INARI_GITHUB_APP_ID;
    await assert.rejects(
      () => setupLocalExecutor(environment),
      (error: unknown) => {
        assert.ok(error instanceof LocalExecutorError);
        assert.equal(error.code, "EXECUTOR_PROVIDER_CONFIGURATION_MISSING");
        assert.match(error.message, /INARI_GITHUB_APP_ID/u);
        assert.match(error.message, /inari setup/u);
        return true;
      },
    );
    await assert.rejects(readFile(path.join(environment.INARI_CONFIG_HOME as string, "executor", "config.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Local Executor production composition executes branch.advance through canonical Git-data CAS", async () => {
  const { root, environment } = await temporaryEnvironment();
  const provider = providerFetch();
  try {
    await saveCredential(environment);
    const result = await withProviderFetch(provider.fetch, () =>
      executeLocalAuthorizedExecution(branchExecution(), environment),
    );

    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(result.operation, "branch.advance");
    assert.equal(result.branchAdvance?.status, "succeeded");
    assert.equal(result.branchAdvance?.outcome, "advanced");
    assert.equal(result.branchAdvance?.expectedHead, EXPECTED_HEAD);
    assert.equal(result.branchAdvance?.resultingHead, NEW_HEAD);
    assert.equal(result.provenance?.stage, "verified");
    assert.equal(
      provider.calls.filter(
        (call) =>
          call.method === "GET" &&
          call.url.pathname === `/repos/acme/inari/git/ref/heads/${encodeURIComponent(BRANCH)}`,
      ).length,
      2,
      "the canonical branch authority must reread the ref after compare-and-swap",
    );
    assert.equal(
      provider.calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/git/blobs")).length,
      1,
    );
    assert.equal(
      provider.calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/git/trees")).length,
      1,
    );
    assert.equal(
      provider.calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/git/commits")).length,
      1,
    );
    const compareAndAdvance = provider.calls.find((call) => call.url.pathname === "/graphql");
    assert.ok(compareAndAdvance?.body);
    const refUpdate = (
      compareAndAdvance.body.variables as { input: { refUpdates: readonly Record<string, unknown>[] } }
    ).input.refUpdates[0];
    assert.deepEqual(refUpdate, {
      name: `refs/heads/${BRANCH}`,
      beforeOid: EXPECTED_HEAD,
      afterOid: NEW_HEAD,
      force: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Local Executor production composition executes change.show through authoritative Change evidence", async () => {
  const { root, environment } = await temporaryEnvironment();
  const provider = providerFetch({ change: "absent" });
  try {
    await saveCredential(environment);
    const result = await withProviderFetch(provider.fetch, () =>
      executeLocalAuthorizedExecution(changeExecution("show"), environment),
    );

    assert.equal(result.status, "succeeded", JSON.stringify({ result, calls: provider.calls }));
    assert.equal(result.operation, "change.show");
    assert.equal(result.projection?.change?.identity.rootIssue, ISSUE);
    assert.ok(
      provider.calls.some((call) => call.method === "GET" && call.url.pathname === `/repos/acme/inari/issues/${ISSUE}`),
    );
    assert.ok(provider.calls.some((call) => call.method === "GET" && call.url.pathname === "/repos/acme/inari/pulls"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Local Executor production composition executes change.abort through canonical Change and App effect authorities", async () => {
  const { root, environment } = await temporaryEnvironment();
  const provider = providerFetch({ change: "active" });
  try {
    await saveCredential(environment);
    const result = await withProviderFetch(provider.fetch, () =>
      executeLocalAuthorizedExecution(changeExecution("abort"), environment),
    );

    assert.equal(result.status, "succeeded", JSON.stringify({ result, calls: provider.calls }));
    assert.equal(result.operation, "change.abort");
    assert.equal(result.provenance?.stage, "verified");
    assert.ok(
      provider.calls.some(
        (call) => call.method === "PATCH" && call.url.pathname === `/repos/acme/inari/pulls/${CHANGE_PULL_REQUEST}`,
      ),
    );
    assert.ok(
      provider.calls.some(
        (call) =>
          call.method === "DELETE" &&
          call.url.pathname === `/repos/acme/inari/git/refs/heads/${encodeURIComponent(BRANCH)}`,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Local Executor production composition executes change.ready from repository-governed Change evidence", async () => {
  const { root, environment } = await temporaryEnvironment();
  const provider = providerFetch({
    change: "active",
    issueBody: READY_ISSUE_BODY,
    pullRequestBody: READY_PR_BODY,
    repositoryArtifacts: [
      {
        path: READY_ISSUE_TEMPLATE_PATH,
        sha: READY_ISSUE_TEMPLATE_SHA,
        content: READY_ISSUE_TEMPLATE_SOURCE,
      },
      {
        path: READY_PR_TEMPLATE_PATH,
        sha: READY_PR_TEMPLATE_SHA,
        content: READY_PR_TEMPLATE_SOURCE,
      },
    ],
  });
  try {
    await saveCredential(environment);
    const result = await withProviderFetch(provider.fetch, () =>
      executeLocalAuthorizedExecution(changeExecution("ready"), environment),
    );

    assert.equal(result.status, "succeeded", JSON.stringify({ result, calls: provider.calls }));
    assert.equal(result.operation, "change.ready");
    assert.equal(result.projection?.change?.state, "REVIEW");
    assert.equal(result.provenance?.stage, "verified");
    assert.ok(
      provider.calls.some((call) => call.method === "POST" && call.url.pathname === "/graphql"),
      "the canonical App effect authority must mark the existing draft PR ready",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Local Executor production composition resolves change.issue provenance through canonical repository trust", async () => {
  const { root, environment } = await temporaryEnvironment();
  const signed = await signedIssueProvenanceFixture();
  const provider = providerFetch({
    repositoryArtifacts: [{ path: signed.artifact.path, sha: AUTHORITY_BLOB, content: signed.artifact.content }],
  });
  try {
    await saveCredential(environment);
    const result = await withProviderFetch(provider.fetch, () =>
      executeLocalAuthorizedExecution(changeExecution("issue", signed.signedProvenanceRecord), environment),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.operation, "change.issue");
    assert.ok(
      provider.calls.some(
        (call) => call.method === "GET" && call.url.pathname === `/repos/acme/inari/git/blobs/${AUTHORITY_BLOB}`,
      ),
      "the production Change delegate must resolve the signed issuer from repository-default-branch trust",
    );
    assert.ok(
      provider.calls.some((call) => call.method === "GET" && call.url.pathname === `/repos/acme/inari/issues/${ISSUE}`),
    );
    assert.equal(
      provider.calls.some((call) => call.method === "POST" && call.url.pathname === "/repos/acme/inari/pulls"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Local Executor production composition routes change.merge through canonical Change evidence", async () => {
  const { root, environment } = await temporaryEnvironment();
  const provider = providerFetch({ change: "active", draft: false });
  try {
    await saveCredential(environment);
    const result = await withProviderFetch(provider.fetch, () =>
      executeLocalAuthorizedExecution(changeExecution("merge"), environment),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.operation, "change.merge");
    assert.ok(
      provider.calls.some((call) => call.method === "GET" && call.url.pathname === `/repos/acme/inari/issues/${ISSUE}`),
    );
    assert.ok(provider.calls.some((call) => call.method === "GET" && call.url.pathname === "/repos/acme/inari/pulls"));
    assert.ok(
      provider.calls.some(
        (call) => call.method === "GET" && call.url.pathname.startsWith("/repos/acme/inari/git/trees/"),
      ),
      "the production Change delegate must read repository governance before planning this mutation",
    );
    assert.equal(
      provider.calls.some(
        (call) =>
          call.method === "PATCH" ||
          (call.method === "POST" && call.url.pathname === "/graphql") ||
          (call.method === "POST" && call.url.pathname === "/repos/acme/inari/pulls"),
      ),
      false,
      "missing canonical governance evidence must fail before provider mutation",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Local Executor production composition executes pullRequest.publish through canonical provider and effect authorities", async () => {
  const { root, environment } = await temporaryEnvironment();
  const provider = providerFetch();
  try {
    await saveCredential(environment);
    const result = await withProviderFetch(provider.fetch, () =>
      executeLocalAuthorizedExecution(publicationExecution(), environment),
    );

    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(result.operation, "pullRequest.publish");
    assert.equal(result.publication?.classification, "created");
    assert.deepEqual(result.publication?.pullRequest, {
      number: 10260,
      url: "https://github.com/acme/inari/pull/10260",
    });
    assert.deepEqual(result.provenance?.app, APP);
    const create = provider.calls.find(
      (call) => call.method === "POST" && call.url.pathname === "/repos/acme/inari/pulls",
    );
    assert.deepEqual(create?.body, {
      head: BRANCH,
      base: "main",
      title: "feat: exercise Executor PR publication",
      body: `Closes #${ISSUE}`,
      draft: true,
    });
    assert.ok(
      provider.calls.some((call) => call.method === "GET" && call.url.pathname === "/repos/acme/inari/pulls/10260"),
      "the canonical publication path must reread the created pull request",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
