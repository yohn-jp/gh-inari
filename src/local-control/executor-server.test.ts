import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { canonicalizeSemanticRequest } from "../agent-authority/session-request.js";
import type { BranchAdvanceSemanticRequest } from "../agent-authority/branch-advance.js";
import { createCapabilityExecutionProvenance } from "../agent-authority/capability-provenance.js";
import { validateCapabilityClaim, type CapabilityClaim } from "../agent-authority/capability.js";
import { createAuthorizedExecution, type AuthorizedExecution } from "../authorized-execution.js";
import { createAppUserCredential } from "../github/app-user-credential.js";
import { FileAppUserCredentialStore } from "../github/app-user-credential-store.js";
import { assertTrustedExecution, type RepositoryIdentity } from "../github/effect-authorizer.js";
import type { PrPublicationRequest } from "../pr-publication.js";
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

function providerFetch(): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: { readonly method: string; readonly url: URL; readonly body?: Record<string, unknown> }[];
} {
  let branchHead = EXPECTED_HEAD;
  let pullRequest: Record<string, unknown> | undefined;
  const calls: { method: string; url: URL; body?: Record<string, unknown> }[] = [];
  const repository = {
    id: Number(REPOSITORY.repositoryId),
    node_id: "R_123456789",
    full_name: REPOSITORY.nameWithOwner,
    owner: { login: "acme" },
    name: "inari",
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
    if (url.pathname === "/graphql" && method === "POST") return json({ data: { updateRefs: { refUpdates: [{}] } } });
    if (url.pathname === "/repos/acme/inari/pulls" && method === "GET") return json([]);
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
      listen: { host: "127.0.0.1", port: 8765 },
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
        assert.match(error.message, /credentials are missing/u);
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
