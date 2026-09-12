import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  BRANCH_ADVANCE_OPERATION,
  executeBranchAdvance,
  validateBranchAdvanceSemanticRequest,
  type BranchAdvanceSemanticRequest,
} from "./branch-advance.js";
import type { AdmittedSessionCapability } from "./capability-admission.js";
import type { AuthenticatedSessionContext } from "./session-authentication.js";
import type {
  GitDataCommitInput,
  GitDataRefUpdateInput,
  GitDataTreeInput,
  GitHubBranchAdvanceCapability,
} from "../github/git-data-capability.js";
import type { IssuerInstallationScope } from "../github/issuer-authority.js";

const HEAD = "a".repeat(40),
  COMMIT = "d".repeat(40),
  TREE = "b".repeat(40);
const BRANCH = "feat/466-session-authorized-branch-advance";
const repository = { repositoryHost: "github.com", repositoryId: "466000001", nameWithOwner: "acme/inari" } as const;
const scope = {
  app: { kind: "github-app", slug: "inari-issuer", appId: "466", principal: "app:inari-issuer" },
  installation: { appId: "466", installationId: "466001", repositoryHost: "github.com" },
  repository,
  repositorySelection: "selected",
  permissions: { contents: "write", metadata: "read" },
  expiresAt: "2099-01-01T00:00:00.000Z",
} as IssuerInstallationScope;
const content = Buffer.from("hello", "utf8").toString("base64");
const blobSha = createHash("sha1")
  .update(Buffer.concat([Buffer.from("blob 5\0"), Buffer.from("hello")]))
  .digest("hex");
const request: BranchAdvanceSemanticRequest = {
  version: 1,
  issue: 466,
  branch: BRANCH,
  expectedHead: HEAD,
  changes: [{ operation: "upsert", path: "src/file.txt", mode: "100644", content }],
  commit: { message: "bounded branch advance", author: { name: "Session author", email: "author@example.test" } },
};
const admission = {
  version: 1,
  operation: BRANCH_ADVANCE_OPERATION,
  repository,
  runtimeAuthority: { id: "runtime-466", kid: "runtime-466" },
  session: { id: "session-466", certificateJti: "certificate-466" },
  authority: { ref: "main", sha: "f".repeat(40) },
  request: { requestId: "request-466", operation: BRANCH_ADVANCE_OPERATION, issuedAt: 1, expiresAt: 2 },
  capability: { kind: "branch.advance", branch: BRANCH },
  subject: { kind: "branch", issue: 466, branch: BRANCH },
  canonical: { branch: BRANCH },
  protectedPathClassifierVersion: 1,
} as unknown as AdmittedSessionCapability;
const context = {
  repository,
  runtimeAuthority: admission.runtimeAuthority,
  session: admission.session,
  task: { kind: "issue", number: 466 },
  capabilities: [],
  authority: admission.authority,
  request: admission.request,
  verifiedRequest: { envelope: { request } },
} as unknown as AuthenticatedSessionContext;

function fake(mode: "updated" | "rejected" = "updated") {
  const calls: { blobs: string[]; updates: GitDataRefUpdateInput[] } = { blobs: [], updates: [] };
  let head = HEAD;
  const capability: GitHubBranchAdvanceCapability = {
    scope,
    readRef: async () => ({ name: BRANCH, ref: `refs/heads/${BRANCH}`, sha: head }),
    readCommit: async (sha) => ({ sha, treeSha: sha === COMMIT ? COMMIT : TREE }),
    readTree: async (sha) => ({
      sha,
      entries: [{ path: "src/file.txt", mode: "100644", type: "blob", sha: sha === COMMIT ? blobSha : "e".repeat(40) }],
    }),
    createBlob: async ({ content: value }) => {
      calls.blobs.push(value);
      return { sha: blobSha };
    },
    createTree: async (_input: GitDataTreeInput) => ({ sha: TREE }),
    createCommit: async (_input: GitDataCommitInput) => ({ sha: COMMIT }),
    compareAndAdvanceRef: async (input) => {
      calls.updates.push(input);
      if (mode === "updated") head = COMMIT;
      return { status: mode };
    },
  };
  return {
    calls,
    broker: {
      withBranchAdvanceCapability: async <T>(
        _request: unknown,
        operation: (c: GitHubBranchAdvanceCapability) => Promise<T>,
      ) => operation(capability),
    },
  };
}

test("validates exact request and canonical base64", () => {
  assert.equal(validateBranchAdvanceSemanticRequest(request).valid, true);
  assert.equal(validateBranchAdvanceSemanticRequest({ ...request, repositoryId: "1" }).valid, false);
  assert.equal(
    validateBranchAdvanceSemanticRequest({ ...request, changes: [{ ...request.changes[0], content: "a" }] }).valid,
    false,
  );
});
test("advances through narrow capability with decoded-content identity and CAS", async () => {
  const { calls, broker } = fake();
  const result = await executeBranchAdvance({ context, broker, admission });
  assert.equal(result.outcome, "advanced");
  assert.deepEqual(calls.blobs, [content]);
  assert.deepEqual(calls.updates[0], { branch: BRANCH, beforeOid: HEAD, afterOid: COMMIT, force: false });
});
test("rejects CAS conflict without force", async () => {
  const { calls, broker } = fake("rejected");
  const result = await executeBranchAdvance({ context, broker, admission });
  assert.equal(result.outcome, "stale");
  assert.equal(calls.updates[0]?.force, false);
});
