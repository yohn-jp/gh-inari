import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { renderIssueArtifact } from "../artifact.js";
import {
  canonicalRuntimeAuthorityJson,
  createManagedSession,
  generateRuntimeAuthorityKeyPair,
  issueSessionCertificate,
  renderRuntimeAuthorityArtifact,
  signSessionRequest,
} from "../agent-authority/index.js";
import { assertRuntimeAuthority } from "../agent-authority/runtime-authority.js";
import { compileSemanticTemplateSource, parseSemanticTemplate, renderSemanticNative } from "../semantic-template.js";
import { createDirectAppSessionExecutor } from "./direct-app-execution.js";

const REPOSITORY = { hostname: "github.com", owner: "acme", name: "inari" } as const;
const FAKE_PRIVATE_KEY_PEM = "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n";
const NOW = new Date("2026-09-13T00:00:30.000Z");
const REPOSITORY_ID = "469000001";
const ISSUE = 469;
const INSTALLATION_ID = "456";
const BRANCH = "feat/469-verify-direct-app";
const PULL_REQUEST = 4690;
const AUTHORITY_ID = "direct-app-composition-test";
const POLICY_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const AUTHORITY_BLOB_SHA = "c".repeat(40);
const ISSUE_SOURCE_SHA = "d".repeat(40);
const ISSUE_NATIVE_SHA = "e".repeat(40);

const ISSUE_SOURCE = parseSemanticTemplate(
  JSON.stringify({
    version: 1,
    kind: "issue",
    id: "feature",
    name: "Feature",
    description: "A direct-App composition regression fixture.",
    sections: [
      { id: "problem", kind: "input", type: "string", label: "Problem", required: true, element: "textarea" },
      {
        id: "capability",
        kind: "input",
        type: "string",
        label: "Capability",
        required: true,
        element: "textarea",
      },
    ],
  }),
  ".github/inari/issues/feature.json",
);
const ISSUE_NATIVE_PATH = ".github/ISSUE_TEMPLATE/feature.yml";
const ISSUE_NATIVE = renderSemanticNative(ISSUE_SOURCE, ISSUE_NATIVE_PATH);
const ISSUE_CONTRACT = compileSemanticTemplateSource(ISSUE_SOURCE, ISSUE_NATIVE_PATH);
const ISSUE_BODY = renderIssueArtifact(ISSUE_CONTRACT, {
  problem: "Exercise the direct App composition.",
  capability: "A successful Change mutation retains verified App provenance.",
});

const APP_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const RUNTIME_KEY = generateRuntimeAuthorityKeyPair();
const RUNTIME_AUTHORITY = assertRuntimeAuthority({
  version: 1,
  kind: "runtime-authority",
  id: AUTHORITY_ID,
  key: RUNTIME_KEY.publicKeyJwk,
  status: "active",
  notBefore: "2026-01-01T00:00:00Z",
  notAfter: null,
  maxSessionTtlSeconds: 3_600,
  capabilityCeiling: ["change.abort"],
});
const RUNTIME_ARTIFACT = renderRuntimeAuthorityArtifact(RUNTIME_AUTHORITY);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function signedAbortEnvelope(): unknown {
  const session = createManagedSession();
  const issuance = session.createIssuanceRequest({
    repository: { id: REPOSITORY_ID, name: "acme/inari" },
    task: { kind: "issue", number: ISSUE },
    capabilities: [{ kind: "change.abort", issue: ISSUE }],
    ttlSeconds: 600,
  });
  const certificate = issueSessionCertificate({
    repository: { id: REPOSITORY_ID, name: "acme/inari" },
    runtimeAuthority: RUNTIME_AUTHORITY,
    runtimeKey: RUNTIME_KEY,
    request: issuance,
    now: NOW,
  });
  session.acceptCertificate(certificate.compact);
  return signSessionRequest({
    session,
    request: { version: 1, issue: ISSUE },
    operation: "change.abort",
    requestId: "direct-app-abort-request",
    issuedAt: Math.floor(NOW.getTime() / 1000),
    expiresAt: Math.floor(NOW.getTime() / 1000) + 60,
  });
}

function successfulMutationFetch(): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: readonly { readonly method: string; readonly path: string }[];
} {
  const calls: Array<{ method: string; path: string }> = [];
  let branchPresent = true;
  let pullRequestState: "open" | "closed" = "open";
  const fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    const path = decodeURIComponent(url.pathname.replace(/^\//u, ""));
    calls.push({ method, path });

    if (path === `app/installations/${INSTALLATION_ID}/access_tokens`) {
      const body = JSON.parse(String(init?.body)) as { readonly permissions: unknown };
      return jsonResponse(
        {
          token: "installation-token",
          expires_at: "2026-09-13T00:10:00.000Z",
          permissions: body.permissions,
          repositories: [{ id: Number(REPOSITORY_ID), full_name: "acme/inari" }],
        },
        201,
      );
    }
    if (path === "repos/acme/inari" && method === "GET") {
      return jsonResponse({ id: Number(REPOSITORY_ID), full_name: "acme/inari", fork: false, default_branch: "main" });
    }
    if (path === `repos/acme/inari/git/ref/heads/main` && method === "GET") {
      return jsonResponse({ ref: "refs/heads/main", object: { type: "commit", sha: POLICY_SHA } });
    }
    if (path.startsWith("repos/acme/inari/git/trees/") && url.search === "?recursive=1" && method === "GET") {
      return jsonResponse({
        sha: TREE_SHA,
        truncated: false,
        tree: [
          { path: RUNTIME_ARTIFACT.path, type: "blob", sha: AUTHORITY_BLOB_SHA },
          { path: ".github/inari/issues/feature.json", type: "blob", sha: ISSUE_SOURCE_SHA },
          { path: ISSUE_NATIVE_PATH, type: "blob", sha: ISSUE_NATIVE_SHA },
        ],
      });
    }
    if (path === `repos/acme/inari/git/blobs/${AUTHORITY_BLOB_SHA}` && method === "GET") {
      return jsonResponse({
        sha: AUTHORITY_BLOB_SHA,
        encoding: "base64",
        content: Buffer.from(canonicalRuntimeAuthorityJson(RUNTIME_AUTHORITY), "utf8").toString("base64"),
      });
    }
    if (path === `repos/acme/inari/git/blobs/${ISSUE_SOURCE_SHA}` && method === "GET") {
      return jsonResponse({
        sha: ISSUE_SOURCE_SHA,
        encoding: "base64",
        content: Buffer.from(JSON.stringify(ISSUE_SOURCE), "utf8").toString("base64"),
      });
    }
    if (path === `repos/acme/inari/git/blobs/${ISSUE_NATIVE_SHA}` && method === "GET") {
      return jsonResponse({
        sha: ISSUE_NATIVE_SHA,
        encoding: "base64",
        content: Buffer.from(ISSUE_NATIVE, "utf8").toString("base64"),
      });
    }
    if (path === `repos/acme/inari/issues/${ISSUE}` && method === "GET") {
      return jsonResponse({ number: ISSUE, title: "feat: Verify direct App", state: "open", body: ISSUE_BODY });
    }
    if (path === `repos/acme/inari/git/ref/heads/${BRANCH}` && method === "GET") {
      return branchPresent
        ? jsonResponse({ ref: `refs/heads/${BRANCH}`, object: { type: "commit" } })
        : jsonResponse({}, 404);
    }
    if (path === "repos/acme/inari/git/matching-refs/heads/" && method === "GET") {
      return jsonResponse(branchPresent ? [{ ref: `refs/heads/${BRANCH}`, object: { type: "commit" } }] : []);
    }
    if (path === "repos/acme/inari/pulls" && method === "GET") {
      return jsonResponse([
        {
          number: PULL_REQUEST,
          head: { ref: BRANCH, repo: { full_name: "acme/inari" } },
          base: { ref: "main" },
          user: { login: "inari-issuer[bot]" },
          state: pullRequestState,
          draft: true,
          merged_at: null,
        },
      ]);
    }
    if (path === `repos/acme/inari/pulls/${PULL_REQUEST}` && method === "PATCH") {
      pullRequestState = "closed";
      return jsonResponse({ number: PULL_REQUEST, state: "closed" });
    }
    if (path === `repos/acme/inari/git/refs/heads/${BRANCH}` && method === "DELETE") {
      branchPresent = false;
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected provider request: ${method} ${path}${url.search}`);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function noNetworkFetch(): typeof globalThis.fetch {
  return (async () => {
    throw new Error("no network access is expected before Session authentication succeeds");
  }) as typeof globalThis.fetch;
}

test("createDirectAppSessionExecutor returns a transport-neutral executor", () => {
  const executor = createDirectAppSessionExecutor({
    appId: "123",
    installationId: "456",
    privateKeyPem: FAKE_PRIVATE_KEY_PEM,
    repository: REPOSITORY,
    fetch: noNetworkFetch(),
  });
  assert.equal(typeof executor.execute, "function");
});

test("rejects a malformed installation identity before any network access", () => {
  assert.throws(() =>
    createDirectAppSessionExecutor({
      appId: "123",
      installationId: "not-a-decimal-id",
      privateKeyPem: FAKE_PRIVATE_KEY_PEM,
      repository: REPOSITORY,
      fetch: noNetworkFetch(),
    }),
  );
});

for (const operation of ["change.issue", "change.show", "change.ready", "change.abort", "branch.advance"] as const) {
  test(`${operation} fails closed at authentication for an unsigned envelope without contacting GitHub`, async () => {
    const executor = createDirectAppSessionExecutor({
      appId: "123",
      installationId: "456",
      privateKeyPem: FAKE_PRIVATE_KEY_PEM,
      repository: REPOSITORY,
      fetch: noNetworkFetch(),
    });
    const result = await executor.execute({ certificate: "not-a-real-certificate", request: { operation } });
    assert.equal(result.status, "failed");
    assert.equal(result.failure?.phase, "authentication");
  });
}

test("successful direct-App Change mutation retains verified broker App provenance", async () => {
  const provider = successfulMutationFetch();
  const executor = createDirectAppSessionExecutor({
    appId: "123",
    installationId: INSTALLATION_ID,
    privateKeyPem: APP_PRIVATE_KEY_PEM,
    repository: REPOSITORY,
    fetch: provider.fetch,
    now: () => NOW,
  });

  const result = await executor.execute(signedAbortEnvelope());

  assert.equal(result.status, "succeeded");
  assert.equal(result.operation, "change.abort");
  assert.equal(result.provenance?.stage, "verified");
  assert.deepEqual(result.provenance?.app, {
    kind: "github-app",
    slug: "inari-issuer",
    appId: "123",
    principal: "app:inari-issuer",
    installationId: INSTALLATION_ID,
  });
  assert.ok(provider.calls.some((call) => call.method === "PATCH"));
  assert.ok(provider.calls.some((call) => call.method === "DELETE"));
});
