import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GIT_DATA_CAPABILITY_VERSION,
  GitDataCapabilityError,
  GitHubBranchAdvanceCapabilityImpl,
  type BranchAdvanceCapabilityTransport,
} from "./git-data-capability.js";
import type { IssuerInstallationScope } from "./issuer-authority.js";

const repository = { hostname: "github.com", owner: "acme", name: "inari" } as const;
const repositoryIdentity = {
  repositoryHost: "github.com",
  repositoryId: "466000001",
  nameWithOwner: "acme/inari",
} as const;
const scope: IssuerInstallationScope = {
  app: { kind: "github-app", slug: "inari-issuer", appId: "466", principal: "app:inari-issuer" },
  installation: { appId: "466", installationId: "466001", repositoryHost: "github.com" },
  repository: repositoryIdentity,
  repositorySelection: "selected",
  permissions: { contents: "write", metadata: "read" },
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const head = "a".repeat(40);
const tree = "b".repeat(40);
const blob = "c".repeat(40);
const commit = "d".repeat(40);
const branch = "feat/466-session-authorized-branch-advance";

function transportFor(): {
  readonly transport: BranchAdvanceCapabilityTransport;
  readonly requests: Array<Record<string, unknown>>;
  readonly graphql: Array<Record<string, unknown>>;
} {
  const requests: Array<Record<string, unknown>> = [];
  const graphql: Array<Record<string, unknown>> = [];
  const transport: BranchAdvanceCapabilityTransport = {
    async request(request) {
      requests.push(request as unknown as Record<string, unknown>);
      if (request.method === "GET" && request.path.includes("/git/ref/heads/")) {
        return {
          status: 200,
          body: { ref: `refs/heads/${branch}`, object: { type: "commit", sha: head } },
        };
      }
      if (request.method === "GET" && request.path.includes("/git/trees/")) {
        return {
          status: 200,
          body: {
            sha: tree,
            truncated: false,
            tree: [{ path: "src/file.txt", mode: "100644", type: "blob", sha: blob }],
          },
        };
      }
      if (request.path.endsWith("/git/blobs")) return { status: 201, body: { sha: blob } };
      if (request.path.endsWith("/git/trees")) return { status: 201, body: { sha: tree } };
      if (request.path.endsWith("/git/commits")) return { status: 201, body: { sha: commit } };
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    },
    async requestGraphql(request) {
      graphql.push(request as unknown as Record<string, unknown>);
      return { status: 200, body: { data: { updateRefs: { clientMutationId: null } } } };
    },
  };
  return { transport, requests, graphql };
}

function capability(transport: BranchAdvanceCapabilityTransport) {
  return new GitHubBranchAdvanceCapabilityImpl({
    repository,
    repositoryId: repositoryIdentity.repositoryId,
    repositoryNodeId: "R_kgDO466000001",
    scope,
    transport,
  });
}

test("exposes only bounded Git object operations and uses conditional updateRefs", async () => {
  const fake = transportFor();
  const data = capability(fake.transport);
  assert.deepEqual(await data.readRef(branch), { name: branch, ref: `refs/heads/${branch}`, sha: head });
  assert.deepEqual(await data.readTree(tree), {
    sha: tree,
    entries: [{ path: "src/file.txt", mode: "100644", type: "blob", sha: blob }],
  });
  assert.deepEqual(await data.createBlob({ content: "bmV3" }), { sha: blob });
  assert.deepEqual(
    await data.createTree({
      baseTreeSha: tree,
      entries: [{ path: "src/file.txt", mode: "100644", type: "blob", sha: blob }],
    }),
    { sha: tree },
  );
  assert.deepEqual(
    await data.createCommit({
      message: "bounded commit",
      treeSha: tree,
      parents: [head],
      author: { name: "Session author", email: "author@example.test" },
    }),
    { sha: commit },
  );
  assert.deepEqual(await data.compareAndAdvanceRef({ branch, beforeOid: head, afterOid: commit, force: false }), {
    status: "updated",
  });
  const mutation = fake.graphql[0];
  assert.equal(typeof mutation?.query, "string");
  assert.deepEqual(mutation?.variables, {
    input: {
      repositoryId: "R_kgDO466000001",
      refUpdates: [{ name: `refs/heads/${branch}`, beforeOid: head, afterOid: commit, force: false }],
    },
  });
  assert.equal(
    fake.requests.some((request) => String(request.path).includes("/git/refs")),
    false,
  );
  assert.equal(Object.keys(data).sort().join(","), "scope");
});

test("rejects unsupported modes, force updates, malformed provider trees, and scope drift", async () => {
  const fake = transportFor();
  const data = capability(fake.transport);
  await assert.rejects(
    data.createTree({
      baseTreeSha: tree,
      entries: [{ path: "submodule", mode: "160000" as "100644", type: "blob", sha: blob }],
    }),
    GitDataCapabilityError,
  );
  await assert.rejects(
    data.updateRefs({ branch, beforeOid: head, afterOid: commit, force: true } as never),
    GitDataCapabilityError,
  );
  const malformedTransport: BranchAdvanceCapabilityTransport = {
    ...fake.transport,
    request: async (request) =>
      request.path.includes("/git/trees/")
        ? { status: 200, body: { sha: tree, truncated: true, tree: [] } }
        : fake.transport.request(request),
  };
  assert.throws(
    () =>
      new GitHubBranchAdvanceCapabilityImpl({
        repository,
        repositoryId: "466000002",
        repositoryNodeId: "R_kgDO466000001",
        scope,
        transport: fake.transport,
      }),
    GitDataCapabilityError,
  );
  const malformed = capability(malformedTransport);
  await assert.rejects(malformed.readTree(tree), GitDataCapabilityError);
});

test("never includes a credential in the capability or fixed failure", async () => {
  const fake = transportFor();
  const data = capability(fake.transport);
  assert.equal(JSON.stringify(data).includes("installation-token"), false);
  await assert.rejects(data.readTree(""), (error: unknown) => {
    assert.equal(error instanceof GitDataCapabilityError, true);
    assert.equal(JSON.stringify(error).includes("installation-token"), false);
    return true;
  });
});
