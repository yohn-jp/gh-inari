import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { CAPABILITY_KINDS } from "../agent-authority/capability.js";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { renderDelegatorArtifact } from "../agent-authority/delegator-trust.js";
import type { Delegator } from "../agent-authority/delegator.js";
import { createRuntimeAuthorityPublicationRequest } from "../runtime-authority-publication.js";
import {
  createDirectAppRuntimeAuthorityPublisher,
  RuntimeAuthorityPublicationUnauthorizedError,
} from "./direct-app-execution.js";
import type { GitHubAppRepositoryReadCapability } from "./app-installation-credential-broker.js";
import type { RepositoryIdentity } from "./effect-authorizer.js";
import type {
  RuntimeAuthorityPublicationCapability,
  RuntimeAuthorityPullRequest,
} from "./runtime-authority-publication-capability.js";

const TARGET: RepositoryIdentity = {
  repositoryHost: "github.com",
  repositoryId: "469000001",
  nameWithOwner: "acme/consumer-repo",
};
const BASE_SHA = "a".repeat(40);
const BASE_TREE_SHA = "b".repeat(40);
const TREE_SHA = "c".repeat(40);
const COMMIT_SHA = "d".repeat(40);
const PULL_REQUEST_URL = "https://github.com/acme/consumer-repo/pull/9";
const CALLER_TOKEN = "caller-access-token-secret";

/** A fetch stub answering only the caller-authorization `GET /repositories/{id}` read. */
function authorizedCallerFetch(): typeof globalThis.fetch {
  return (async (input, init) => {
    const url = new URL(String(input));
    if (url.toString() === `https://api.github.com/repositories/${TARGET.repositoryId}`) {
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${CALLER_TOKEN}`);
      return new Response(
        JSON.stringify({
          id: Number(TARGET.repositoryId),
          full_name: TARGET.nameWithOwner,
          permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected ${url.toString()}`);
  }) as typeof globalThis.fetch;
}

function authority(id: string): Delegator {
  const { publicKey } = generateKeyPairSync("ed25519");
  return createDelegatorRecord({
    id,
    key: publicKey,
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: null,
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: CAPABILITY_KINDS,
  });
}

function fakeCredentialBroker(publicAuthority: Delegator): {
  readonly counts: { createBranch: number; createPullRequest: number };
  readonly broker: {
    withRepositoryReadCapability<T>(
      request: unknown,
      operation: (capability: GitHubAppRepositoryReadCapability) => Promise<T>,
    ): Promise<T>;
    withRuntimeAuthorityPublicationCapability<T>(
      request: { readonly target: RepositoryIdentity },
      operation: (capability: RuntimeAuthorityPublicationCapability) => Promise<T>,
    ): Promise<T>;
  };
} {
  const artifact = renderDelegatorArtifact(publicAuthority);
  const blobSha = createHash("sha1")
    .update(`blob ${Buffer.byteLength(artifact.content, "utf8")}\0`)
    .update(artifact.content)
    .digest("hex");
  let branchHead: string | undefined;
  let storedPullRequest: RuntimeAuthorityPullRequest | undefined;
  const counts = { createBranch: 0, createPullRequest: 0 };
  const gitData = {
    scope: {} as never,
    readRef: async () =>
      branchHead === undefined ? undefined : { name: "branch", ref: "refs/heads/branch", sha: branchHead },
    readCommit: async (sha: string) => ({ sha, treeSha: sha === BASE_SHA ? BASE_TREE_SHA : TREE_SHA }),
    readTree: async (sha: string) => ({
      sha,
      entries:
        sha === BASE_TREE_SHA
          ? []
          : [{ path: artifact.path, mode: "100644" as const, type: "blob" as const, sha: blobSha }],
    }),
    readBlob: async () => artifact.content,
    createBlob: async () => ({ sha: blobSha }),
    createTree: async () => ({ sha: TREE_SHA }),
    createCommit: async () => ({ sha: COMMIT_SHA }),
  };
  const capability: RuntimeAuthorityPublicationCapability = {
    scope: {} as RuntimeAuthorityPublicationCapability["scope"],
    gitData: gitData as never,
    getDefaultBranch: async () => ({ name: "main", sha: BASE_SHA }),
    createBranch: async (_branch, sha) => {
      counts.createBranch += 1;
      branchHead = sha;
    },
    compareBranch: async () => ({ aheadBy: 1, changedPaths: [artifact.path] }),
    findPullRequests: async () => (storedPullRequest === undefined ? [] : [storedPullRequest]),
    readPullRequestFiles: async () => [artifact.path],
    createPullRequest: async (input) => {
      counts.createPullRequest += 1;
      storedPullRequest = {
        number: 9,
        url: PULL_REQUEST_URL,
        title: input.title,
        body: input.body,
        state: "open",
        draft: false,
        headBranch: input.head,
        headRepository: TARGET.nameWithOwner,
        baseBranch: input.base,
        author: "inari-issuer[bot]",
        changedFiles: 1,
      };
      return storedPullRequest;
    },
  };
  return {
    counts,
    broker: {
      withRepositoryReadCapability: async (_request, operation) =>
        operation({ scope: { repository: TARGET } } as GitHubAppRepositoryReadCapability),
      withRuntimeAuthorityPublicationCapability: async (_request, operation) => operation(capability),
    },
  };
}

test("createDirectAppRuntimeAuthorityPublisher publishes exactly one public Authority artifact through the injected Issuer credential broker", async () => {
  const publicAuthority = authority("direct-app-runtime-authority-test");
  const fixture = fakeCredentialBroker(publicAuthority);
  // appId/installationId/privateKeyPem below are deliberately unused
  // placeholders: production always mints a fresh Issuer installation broker
  // from these Worker-held values, but this fixture proves the composition
  // itself never needs to read them from -- or write them to -- the
  // consumer repository to reach the bounded mutation.
  const publisher = createDirectAppRuntimeAuthorityPublisher({
    appId: "unused-in-this-fixture",
    installationId: "unused-in-this-fixture",
    privateKeyPem: "unused-in-this-fixture",
    repository: { hostname: TARGET.repositoryHost, owner: "acme", name: "consumer-repo" },
    credentialBroker: fixture.broker as never,
    fetch: authorizedCallerFetch(),
  });

  const result = await publisher.publish(createRuntimeAuthorityPublicationRequest(publicAuthority), CALLER_TOKEN);

  assert.equal(result.status, "created");
  assert.deepEqual(result.pullRequest, { number: 9, url: PULL_REQUEST_URL });
  assert.deepEqual(fixture.counts, { createBranch: 1, createPullRequest: 1 });

  const replay = await publisher.publish(createRuntimeAuthorityPublicationRequest(publicAuthority), CALLER_TOKEN);
  assert.equal(replay.status, "existing");
  assert.deepEqual(fixture.counts, { createBranch: 1, createPullRequest: 1 });
});

test("createDirectAppRuntimeAuthorityPublisher rejects a caller whose token cannot read the configured target repository, before any Issuer mutation", async () => {
  const publicAuthority = authority("direct-app-runtime-authority-unauthorized-caller");
  const fixture = fakeCredentialBroker(publicAuthority);
  const publisher = createDirectAppRuntimeAuthorityPublisher({
    appId: "unused-in-this-fixture",
    installationId: "unused-in-this-fixture",
    privateKeyPem: "unused-in-this-fixture",
    repository: { hostname: TARGET.repositoryHost, owner: "acme", name: "consumer-repo" },
    credentialBroker: fixture.broker as never,
    fetch: (async () => new Response(null, { status: 404 })) as typeof globalThis.fetch,
  });

  await assert.rejects(
    publisher.publish(createRuntimeAuthorityPublicationRequest(publicAuthority), "an-unauthorized-caller-token"),
    RuntimeAuthorityPublicationUnauthorizedError,
  );
  assert.deepEqual(fixture.counts, { createBranch: 0, createPullRequest: 0 });
});

test("createDirectAppRuntimeAuthorityPublisher rejects a caller token that can read a different repository than the configured target", async () => {
  const publicAuthority = authority("direct-app-runtime-authority-wrong-repository-caller");
  const fixture = fakeCredentialBroker(publicAuthority);
  const publisher = createDirectAppRuntimeAuthorityPublisher({
    appId: "unused-in-this-fixture",
    installationId: "unused-in-this-fixture",
    privateKeyPem: "unused-in-this-fixture",
    repository: { hostname: TARGET.repositoryHost, owner: "acme", name: "consumer-repo" },
    credentialBroker: fixture.broker as never,
    fetch: (async () =>
      new Response(JSON.stringify({ id: 1, full_name: "someone-else/a-different-repository" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch,
  });

  await assert.rejects(
    publisher.publish(createRuntimeAuthorityPublicationRequest(publicAuthority), "a-different-repository-token"),
    RuntimeAuthorityPublicationUnauthorizedError,
  );
  assert.deepEqual(fixture.counts, { createBranch: 0, createPullRequest: 0 });
});

test("createDirectAppRuntimeAuthorityPublisher rejects a read-only caller: repository read access alone is not enough to authorize an Issuer-side write", async () => {
  const publicAuthority = authority("direct-app-runtime-authority-read-only-caller");
  const fixture = fakeCredentialBroker(publicAuthority);
  const publisher = createDirectAppRuntimeAuthorityPublisher({
    appId: "unused-in-this-fixture",
    installationId: "unused-in-this-fixture",
    privateKeyPem: "unused-in-this-fixture",
    repository: { hostname: TARGET.repositoryHost, owner: "acme", name: "consumer-repo" },
    credentialBroker: fixture.broker as never,
    // The caller can read the exact configured target repository (correct
    // id/full_name), but their token only has pull/triage access to it --
    // never push. Without a write/push check, this read-only collaborator
    // could delegate a write through the Issuer credential.
    fetch: (async () =>
      new Response(
        JSON.stringify({
          id: Number(TARGET.repositoryId),
          full_name: TARGET.nameWithOwner,
          permissions: { admin: false, maintain: false, push: false, triage: true, pull: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof globalThis.fetch,
  });

  await assert.rejects(
    publisher.publish(createRuntimeAuthorityPublicationRequest(publicAuthority), "a-read-only-caller-token"),
    RuntimeAuthorityPublicationUnauthorizedError,
  );
  assert.deepEqual(fixture.counts, { createBranch: 0, createPullRequest: 0 });
});

test("createDirectAppRuntimeAuthorityPublisher never reads a target repository from the caller's request", async () => {
  const publicAuthority = authority("direct-app-runtime-authority-fixed-target");
  const fixture = fakeCredentialBroker(publicAuthority);
  let observedTarget: RepositoryIdentity | undefined;
  const publisher = createDirectAppRuntimeAuthorityPublisher({
    appId: "unused-in-this-fixture",
    installationId: "unused-in-this-fixture",
    privateKeyPem: "unused-in-this-fixture",
    repository: { hostname: TARGET.repositoryHost, owner: "acme", name: "consumer-repo" },
    credentialBroker: {
      withRepositoryReadCapability: fixture.broker.withRepositoryReadCapability,
      withRuntimeAuthorityPublicationCapability: async (
        request: { readonly target: RepositoryIdentity },
        operation: (capability: RuntimeAuthorityPublicationCapability) => Promise<unknown>,
      ) => {
        observedTarget = request.target;
        return fixture.broker.withRuntimeAuthorityPublicationCapability(request, operation);
      },
    } as never,
    fetch: authorizedCallerFetch(),
  });

  await publisher.publish(
    {
      version: 1,
      authority: publicAuthority,
      // The publication request contract has no repository field at all, so
      // there is nothing here for a caller to smuggle a different target with.
    },
    CALLER_TOKEN,
  );

  assert.deepEqual(observedTarget, TARGET);
});
