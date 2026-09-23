import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { CAPABILITY_KINDS } from "../agent-authority/capability.js";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { renderDelegatorArtifact } from "../agent-authority/delegator-trust.js";
import type { Delegator } from "../agent-authority/delegator.js";
import type { GitHubAppRepositoryReadCapability } from "./app-installation-credential-broker.js";
import {
  runtimeAuthorityPublicationBody,
  runtimeAuthorityPublicationBranch,
  runtimeAuthorityPublicationTitle,
} from "../runtime-authority-publication.js";
import { publishSetupRuntimeAuthority } from "./runtime-authority-publication-client.js";

function authority(): Delegator {
  const { publicKey } = generateKeyPairSync("ed25519");
  return createDelegatorRecord({
    id: "runtime-setup-test",
    key: publicKey,
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: null,
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: CAPABILITY_KINDS,
  });
}

test("setup dispatch contains only the validated public Authority and reports the verified Issuer PR", async () => {
  const publicAuthority = authority();
  const artifact = renderDelegatorArtifact(publicAuthority);
  const branch = runtimeAuthorityPublicationBranch(publicAuthority.id);
  const requestPaths: string[] = [];
  let dispatchedAuthority: Delegator | undefined;
  let pullRequestReads = 0;
  const capability: GitHubAppRepositoryReadCapability = {
    providerPrincipal: {} as GitHubAppRepositoryReadCapability["providerPrincipal"],
    scope: {
      app: {} as GitHubAppRepositoryReadCapability["scope"]["app"],
      installation: {} as GitHubAppRepositoryReadCapability["scope"]["installation"],
      repository: {
        repositoryHost: "github.com",
        repositoryId: "99",
        nameWithOwner: "acme/inari",
      },
      repositorySelection: "selected",
      permissions: { contents: "read", issues: "read", pull_requests: "read" },
      expiresAt: "2027-01-01T00:00:00.000Z",
    },
    transport: {
      request: async ({ path }) => {
        requestPaths.push(path);
        if (path === "repos/acme/inari") {
          return { status: 200, body: { id: 99, default_branch: "main" } };
        }
        if (path.includes("/pulls?")) {
          pullRequestReads += 1;
          if (pullRequestReads === 1) return { status: 200, body: [] };
          return {
            status: 200,
            body: [
              {
                number: 17,
                html_url: "https://github.com/acme/inari/pull/17",
                title: runtimeAuthorityPublicationTitle(publicAuthority.id),
                body: runtimeAuthorityPublicationBody(publicAuthority),
                state: "open",
                draft: false,
                head: { ref: branch, repo: { full_name: "acme/inari" } },
                base: { ref: "main" },
                user: { login: "inari-issuer[bot]" },
                changed_files: 1,
              },
            ],
          };
        }
        if (path.endsWith("/pulls/17/files?per_page=100")) {
          return { status: 200, body: [{ filename: artifact.path }] };
        }
        if (path.endsWith(`/git/ref/heads/${encodeURIComponent(branch)}`)) {
          return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha: "a".repeat(40) } } };
        }
        if (path.endsWith(`/git/commits/${"a".repeat(40)}`)) {
          return { status: 200, body: { sha: "a".repeat(40), tree: { sha: "c".repeat(40) } } };
        }
        if (path.includes(`/git/trees/${"c".repeat(40)}?recursive=1`)) {
          return {
            status: 200,
            body: {
              sha: "c".repeat(40),
              truncated: false,
              tree: [{ path: artifact.path, mode: "100644", type: "blob", sha: "b".repeat(40) }],
            },
          };
        }
        if (path.endsWith(`/git/blobs/${"b".repeat(40)}`)) {
          return {
            status: 200,
            body: { encoding: "base64", content: Buffer.from(artifact.content, "utf8").toString("base64") },
          };
        }
        throw new Error(`Unexpected read path: ${path}`);
      },
    },
  };
  const result = await publishSetupRuntimeAuthority({
    capability,
    repository: {
      repositoryHost: "github.com",
      repositoryId: "99",
      repositoryNameWithOwner: "acme/inari",
    },
    authority: publicAuthority,
    dispatch: async (authority) => {
      dispatchedAuthority = authority;
      assert.deepEqual(Object.keys(authority).sort(), Object.keys(publicAuthority).sort());
    },
    maxWaitMs: 10_000,
    pollIntervalMs: 1,
    now: () => 1,
    sleep: async () => undefined,
  });

  assert.equal(result.status, "created");
  assert.equal(result.branch, branch);
  assert.deepEqual(result.pullRequest, { number: 17, url: "https://github.com/acme/inari/pull/17" });
  assert.deepEqual(requestPaths.slice(0, 2), [
    "repos/acme/inari",
    `repos/acme/inari/pulls?state=open&per_page=100&head=acme%3A${encodeURIComponent(branch)}&base=main`,
  ]);

  assert.deepEqual(dispatchedAuthority, publicAuthority);
  assert.doesNotMatch(JSON.stringify(dispatchedAuthority), /privateKey|refreshToken|\.mcp\.json/iu);
});
