import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAppRepositoryEvidenceReader,
  AppRepositoryEvidenceReaderError,
} from "./app-repository-evidence-reader.js";
import type { GitHubAppRepositoryReadCapability } from "./app-installation-credential-broker.js";
import type { GitHubChangeEffectRepository } from "./change-effect-adapter.js";
import type { RepositoryIdentity } from "./effect-authorizer.js";

const REPOSITORY: GitHubChangeEffectRepository = { hostname: "github.com", owner: "acme", name: "inari" };
const IDENTITY: RepositoryIdentity = {
  repositoryHost: "github.com",
  repositoryId: "1",
  nameWithOwner: "acme/inari",
};
const COMMIT_SHA = "a".repeat(40);
const BLOB_SHA = "b".repeat(40);

function fakeCapability(
  responder: (path: string) => { readonly status: number; readonly body?: unknown },
): GitHubAppRepositoryReadCapability {
  return {
    providerPrincipal: {
      kind: "github-app",
      slug: "inari-issuer",
      appId: "1",
      principal: "app:inari-issuer",
    },
    scope: {
      app: { kind: "github-app", slug: "inari-issuer", appId: "1", principal: "app:inari-issuer" },
      installation: { appId: "1", installationId: "2", repositoryHost: "github.com" },
      repository: { repositoryHost: "github.com", repositoryId: "1", nameWithOwner: "acme/inari" },
      repositorySelection: "selected" as const,
      permissions: { contents: "read" as const, issues: "read" as const, pull_requests: "read" as const },
      expiresAt: "2026-09-12T00:10:00Z",
    },
    transport: { request: async (request) => responder(request.path) },
  };
}

test("resolves the repository default branch through the bounded transport", async () => {
  const capability = fakeCapability((path) =>
    path === "repos/acme/inari" ? { status: 200, body: { default_branch: "main" } } : { status: 404, body: {} },
  );
  const reader = createAppRepositoryEvidenceReader(capability, REPOSITORY, IDENTITY);
  assert.deepEqual(reader.providerPrincipal, capability.providerPrincipal);
  assert.equal(await reader.getRepositoryDefaultBranch(), "main");
});

test("findBranch returns undefined for a 404 and a validated branch otherwise", async () => {
  const capability = fakeCapability((path) => {
    if (path === "repos/acme/inari/git/ref/heads/main") {
      return { status: 200, body: { ref: "refs/heads/main", object: { type: "commit", sha: COMMIT_SHA } } };
    }
    if (path === "repos/acme/inari/git/ref/heads/missing") return { status: 404, body: {} };
    return { status: 500, body: {} };
  });
  const reader = createAppRepositoryEvidenceReader(capability, REPOSITORY, IDENTITY);
  assert.deepEqual(await reader.findBranch("main"), { name: "main", ref: "refs/heads/main", sha: COMMIT_SHA });
  assert.equal(await reader.findBranch("missing"), undefined);
});

test("getRepositoryTree and getRepositoryBlob decode bounded provider evidence", async () => {
  const content = Buffer.from("hello", "utf8").toString("base64");
  const capability = fakeCapability((path) => {
    if (path.includes("/git/trees/")) {
      return {
        status: 200,
        body: { sha: "c".repeat(40), truncated: false, tree: [{ path: "a.txt", type: "blob", sha: BLOB_SHA }] },
      };
    }
    if (path.includes("/git/blobs/")) return { status: 200, body: { sha: BLOB_SHA, encoding: "base64", content } };
    return { status: 404, body: {} };
  });
  const reader = createAppRepositoryEvidenceReader(capability, REPOSITORY, IDENTITY);
  const tree = await reader.getRepositoryTree("main");
  assert.deepEqual(tree.entries, [{ path: "a.txt", type: "blob", sha: BLOB_SHA }]);
  assert.equal(await reader.getRepositoryBlob(BLOB_SHA), "hello");
});

test("fails closed on a malformed provider response", async () => {
  const capability = fakeCapability(() => ({ status: 200, body: { default_branch: 12345 } }));
  const reader = createAppRepositoryEvidenceReader(capability, REPOSITORY, IDENTITY);
  await assert.rejects(reader.getRepositoryDefaultBranch(), AppRepositoryEvidenceReaderError);
});
