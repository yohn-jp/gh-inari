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
import type { ImplementationScopeProjection } from "../implementation-scope-projection.js";
import type { ImplementationSessionAuthorizationBinding } from "../implementation-session-binding.js";
import type {
  GitDataCommitInput,
  GitDataRefUpdateInput,
  GitDataTree,
  GitDataTreeInput,
  GitHubBranchAdvanceCapability,
} from "../github/git-data-capability.js";
import type { AppInstallationScope } from "../github/effect-authorizer.js";

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
} as AppInstallationScope;
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

const implementationBase = {
  branch: "main",
  revision: "base-revision",
  freshness: "base-freshness",
} as const;
const implementationAuthorization = {
  version: 1 as const,
  kind: "implementation-authorization" as const,
  contractVersion: 1 as const,
  implementation: {
    repositoryHost: repository.repositoryHost,
    repositoryId: repository.repositoryId,
    repository: repository.nameWithOwner,
    number: 466,
  },
  governedBodyDigest: "1".repeat(64),
};
const implementationScope = {
  version: 1 as const,
  kind: "implementation-execution-scope" as const,
  authorization: implementationAuthorization,
  repository: {
    repositoryHost: repository.repositoryHost,
    repositoryId: repository.repositoryId,
    repository: repository.nameWithOwner,
  },
  base: implementationBase,
  branch: BRANCH,
  scope: {
    readOnly: [],
    write: ["src/**"],
    create: ["docs/**"],
    delete: ["src/**"],
    deny: ["src/private/**"],
  },
} satisfies ImplementationScopeProjection;
const implementationBinding = {
  version: 1 as const,
  kind: "implementation-session-binding" as const,
  authorization: implementationAuthorization,
  repository: {
    repositoryHost: repository.repositoryHost,
    repositoryId: repository.repositoryId,
    repository: repository.nameWithOwner,
  },
  base: implementationBase,
  task: { kind: "issue" as const, number: 466 },
} satisfies ImplementationSessionAuthorizationBinding;

function scopedContextFor(changes: BranchAdvanceSemanticRequest["changes"]): AuthenticatedSessionContext {
  return {
    ...context,
    implementationBinding,
    implementationScope,
    verifiedRequest: { envelope: { request: { ...request, changes } } },
  } as unknown as AuthenticatedSessionContext;
}

function fake(mode: "updated" | "rejected" | "throws-applied" | "throws-not-applied" | "throws-reread" = "updated") {
  const calls: { blobs: string[]; updates: GitDataRefUpdateInput[]; readRefs: number } = {
    blobs: [],
    updates: [],
    readRefs: 0,
  };
  let head = HEAD;
  const capability: GitHubBranchAdvanceCapability = {
    scope,
    readRef: async () => {
      calls.readRefs += 1;
      if (mode === "throws-reread" && calls.readRefs === 2) throw new Error("reread unavailable");
      return { name: BRANCH, ref: `refs/heads/${BRANCH}`, sha: head };
    },
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
      if (mode === "updated" || mode === "throws-applied" || mode === "throws-reread") head = COMMIT;
      if (mode === "throws-applied" || mode === "throws-not-applied" || mode === "throws-reread")
        throw new Error("provider outcome is ambiguous");
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

function replayFake(expectedHeadTree: GitDataTree, currentHeadTree: GitDataTree, currentHead = "8".repeat(40)) {
  const commits = new Map([
    [HEAD, expectedHeadTree],
    [currentHead, currentHeadTree],
  ]);
  const trees = new Map([expectedHeadTree, currentHeadTree].map((tree) => [tree.sha, tree] as const));
  const calls: { blobs: string[]; updates: GitDataRefUpdateInput[] } = { blobs: [], updates: [] };
  const capability: GitHubBranchAdvanceCapability = {
    scope,
    readRef: async () => ({ name: BRANCH, ref: `refs/heads/${BRANCH}`, sha: currentHead }),
    readCommit: async (sha) => {
      const tree = commits.get(sha);
      if (tree === undefined) throw new Error("unknown commit");
      return { sha, treeSha: tree.sha };
    },
    readTree: async (sha) => {
      const tree = trees.get(sha);
      if (tree === undefined) throw new Error("unknown tree");
      return tree;
    },
    createBlob: async ({ content: value }) => {
      calls.blobs.push(value);
      return { sha: blobSha };
    },
    createTree: async () => ({ sha: TREE }),
    createCommit: async () => ({ sha: COMMIT }),
    compareAndAdvanceRef: async (input) => {
      calls.updates.push(input);
      return { status: "rejected" };
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

function replayTree(sha: string, entries: GitDataTree["entries"]): GitDataTree {
  return { sha, entries };
}

test("validates exact request and canonical base64", () => {
  assert.equal(validateBranchAdvanceSemanticRequest(request).valid, true);
  assert.equal(validateBranchAdvanceSemanticRequest({ ...request, repositoryId: "1" }).valid, false);
  assert.equal(
    validateBranchAdvanceSemanticRequest({ ...request, changes: [{ ...request.changes[0], content: "a" }] }).valid,
    false,
  );
});
test("accepts a well-formed branch name", () => {
  assert.equal(validateBranchAdvanceSemanticRequest({ ...request, branch: "feat/42-add-init-command" }).valid, true);
});
test("rejects the exempt main branch as a non-default branch name", () => {
  assert.equal(validateBranchAdvanceSemanticRequest({ ...request, branch: "main" }).valid, false);
});
test("rejects a branch missing an issue number", () => {
  assert.equal(validateBranchAdvanceSemanticRequest({ ...request, branch: "feat/add-init-command" }).valid, false);
});
test("rejects an unknown branch type prefix", () => {
  assert.equal(validateBranchAdvanceSemanticRequest({ ...request, branch: "wip/42-add-init-command" }).valid, false);
});
test("advances through narrow capability with decoded-content identity and CAS", async () => {
  const { calls, broker } = fake();
  const result = await executeBranchAdvance({ context: scopedContextFor(request.changes), broker, admission });
  assert.equal(result.outcome, "advanced");
  assert.deepEqual(calls.blobs, [content]);
  assert.deepEqual(calls.updates[0], { branch: BRANCH, beforeOid: HEAD, afterOid: COMMIT, force: false });
});
test("rejects CAS conflict without force", async () => {
  const { calls, broker } = fake("rejected");
  const result = await executeBranchAdvance({ context: scopedContextFor(request.changes), broker, admission });
  assert.equal(result.outcome, "stale");
  assert.equal(calls.updates[0]?.force, false);
});
test("resolves an applied mutation after the provider throws", async () => {
  const { calls, broker } = fake("throws-applied");
  const result = await executeBranchAdvance({ context: scopedContextFor(request.changes), broker, admission });
  assert.equal(result.status, "succeeded");
  assert.equal(result.outcome, "idempotent");
  assert.equal(result.resultingHead, COMMIT);
  assert.ok(result.provenance);
  assert.equal(calls.readRefs, 2);
});
test("does not claim mutation when the provider throws before applying it", async () => {
  const { calls, broker } = fake("throws-not-applied");
  const result = await executeBranchAdvance({ context: scopedContextFor(request.changes), broker, admission });
  assert.equal(result.status, "failed");
  assert.equal(result.outcome, "failed");
  assert.equal(result.failure?.reason, "provider");
  assert.equal(result.resultingHead, undefined);
  assert.equal(result.provenance, undefined);
  assert.equal(calls.readRefs, 2);
});
test("requires recovery when reread is unavailable after an ambiguous mutation", async () => {
  const { calls, broker } = fake("throws-reread");
  const result = await executeBranchAdvance({ context: scopedContextFor(request.changes), broker, admission });
  assert.equal(result.status, "failed");
  assert.equal(result.outcome, "recovery-required");
  assert.equal(result.failure?.reason, "recovery-required");
  assert.equal(result.provenance, undefined);
  assert.equal(calls.readRefs, 2);
});

// Issue #466 acceptance: the full frozen negative-case matrix. These exercise
// the current bounded `changes` wire schema and the single
// `BRANCH_ADVANCE_FAILED` code + stable `reason` taxonomy — not the retired
// `repositoryId`/`treeDelta`/alternate-code-vocabulary shape.

test("fails closed for the wrong Issue", async () => {
  const { calls, broker } = fake();
  const wrongContext = {
    ...context,
    task: { kind: "issue", number: 999 },
  } as unknown as AuthenticatedSessionContext;
  const result = await executeBranchAdvance({ context: wrongContext, broker, admission });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "authorization");
  assert.equal(calls.blobs.length, 0);
});

test("fails closed for the wrong repository", async () => {
  const { calls, broker } = fake();
  const wrongRepository = { ...repository, repositoryId: "466000002" };
  const wrongContext = { ...context, repository: wrongRepository } as unknown as AuthenticatedSessionContext;
  const result = await executeBranchAdvance({ context: wrongContext, broker, admission });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "authorization");
  assert.equal(calls.blobs.length, 0);
});

test("fails closed when the supplied admission names a different branch than the signed request", async () => {
  const { calls, broker } = fake();
  const otherBranch = "feat/466-other-branch";
  const mismatchedAdmission = {
    ...admission,
    capability: { kind: "branch.advance", branch: otherBranch },
    subject: { kind: "branch", issue: 466, branch: otherBranch },
    canonical: { branch: otherBranch },
  } as unknown as AdmittedSessionCapability;
  const result = await executeBranchAdvance({ context, broker, admission: mismatchedAdmission });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "authorization");
  assert.equal(calls.blobs.length, 0);
});

test("fails closed for the default branch", async () => {
  const { calls, broker } = fake();
  const defaultRequest = { ...request, branch: "main" };
  // "main" is rejected as a non-canonical branch name by request validation
  // itself, which is a stricter, earlier fail-closed than branch-state.
  const validation = validateBranchAdvanceSemanticRequest(defaultRequest);
  assert.equal(validation.valid, false);
  const result = await executeBranchAdvance({ context, broker, admission, request: defaultRequest });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "request");
  assert.equal(calls.blobs.length, 0);
});

test("fails closed when the request's branch equals the authenticated default ref", async () => {
  const { calls, broker } = fake();
  const defaultAsRef = {
    ...context,
    authority: { ...context.authority, ref: BRANCH },
  } as unknown as AuthenticatedSessionContext;
  const result = await executeBranchAdvance({ context: defaultAsRef, broker, admission });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "branch-state");
  assert.equal(calls.blobs.length, 0);
});

test("classifies a protected path before any Git object is created", async () => {
  const { calls, broker } = fake();
  const protectedRequest = {
    ...request,
    changes: [
      {
        operation: "upsert" as const,
        path: ".github/inari/authorities/runtime.json",
        mode: "100644" as const,
        content,
      },
    ],
  };
  const protectedContext = {
    ...context,
    verifiedRequest: { envelope: { request: protectedRequest } },
  } as unknown as AuthenticatedSessionContext;
  const result = await executeBranchAdvance({ context: protectedContext, broker, admission });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "protected-path");
  assert.equal(calls.blobs.length, 0);
});

test("rejects stale expected head without overwriting concurrent work", async () => {
  const { calls, broker } = fake();
  const staleRequest = { ...request, expectedHead: "9".repeat(40) };
  const staleContext = {
    ...context,
    implementationBinding,
    implementationScope,
    verifiedRequest: { envelope: { request: staleRequest } },
  } as unknown as AuthenticatedSessionContext;
  // The provider's current head still traces to a tree that does not already
  // prove the target state, so a stale head must never be treated as
  // idempotent success.
  const result = await executeBranchAdvance({ context: staleContext, broker, admission });
  assert.equal(result.status, "failed");
  assert.equal(result.outcome, "stale");
  assert.equal(result.failure?.reason, "stale-head");
  assert.equal(calls.blobs.length, 0);
});

test("does not treat a replay with an unrelated concurrent path as idempotent", async () => {
  const expectedBase = replayTree("7".repeat(40), [
    { path: "src/file.txt", mode: "100644", type: "blob", sha: "e".repeat(40) },
  ]);
  const requestedTarget = replayTree("6".repeat(40), [
    { path: "src/file.txt", mode: "100644", type: "blob", sha: blobSha },
  ]);
  const concurrentTarget = replayTree("5".repeat(40), [
    ...requestedTarget.entries,
    { path: "src/unrelated.txt", mode: "100644", type: "blob", sha: "c".repeat(40) },
  ]);
  const { calls, broker } = replayFake(expectedBase, concurrentTarget);

  const result = await executeBranchAdvance({ context: scopedContextFor(request.changes), broker, admission });

  assert.equal(result.status, "failed");
  assert.equal(result.outcome, "stale");
  assert.equal(result.failure?.reason, "stale-head");
  assert.equal(calls.blobs.length, 0);
  assert.equal(calls.updates.length, 0);
});

test("returns idempotent success when the stale head is the exact requested target", async () => {
  const expectedBase = replayTree("7".repeat(40), [
    { path: "src/file.txt", mode: "100644", type: "blob", sha: "e".repeat(40) },
  ]);
  const exactTarget = replayTree("6".repeat(40), [
    { path: "src/file.txt", mode: "100644", type: "blob", sha: blobSha },
  ]);
  const { calls, broker } = replayFake(expectedBase, exactTarget);

  const result = await executeBranchAdvance({ context: scopedContextFor(request.changes), broker, admission });

  assert.equal(result.status, "succeeded");
  assert.equal(result.outcome, "idempotent");
  assert.equal(result.resultingHead, "8".repeat(40));
  assert.ok(result.provenance);
  assert.equal(calls.blobs.length, 0);
  assert.equal(calls.updates.length, 0);
});

test("returns stale failure when the stale head does not contain the requested target", async () => {
  const expectedBase = replayTree("7".repeat(40), [
    { path: "src/file.txt", mode: "100644", type: "blob", sha: "e".repeat(40) },
  ]);
  const nonTarget = replayTree("6".repeat(40), [
    { path: "src/file.txt", mode: "100644", type: "blob", sha: "e".repeat(40) },
  ]);
  const { calls, broker } = replayFake(expectedBase, nonTarget);

  const result = await executeBranchAdvance({ context: scopedContextFor(request.changes), broker, admission });

  assert.equal(result.status, "failed");
  assert.equal(result.outcome, "stale");
  assert.equal(result.failure?.reason, "stale-head");
  assert.equal(calls.blobs.length, 0);
  assert.equal(calls.updates.length, 0);
});

test("rejects a concurrent head update via compare-and-swap rejection", async () => {
  const { calls, broker } = fake("rejected");
  const result = await executeBranchAdvance({ context: scopedContextFor(request.changes), broker, admission });
  assert.equal(result.status, "failed");
  assert.equal(result.outcome, "stale");
  assert.equal(result.failure?.reason, "stale-head");
  assert.deepEqual(calls.updates[0], { branch: BRANCH, beforeOid: HEAD, afterOid: COMMIT, force: false });
});

test("fails closed once the Session request is no longer admitted for this operation", async () => {
  const { calls, broker } = fake();
  // Expiry is #374's authentication boundary: an envelope/context that is no
  // longer bound to this exact branch.advance operation must never reach
  // execution, regardless of how the caller phrases the mismatch.
  const expiredContext = {
    ...context,
    request: { ...context.request, operation: "change.issue" },
  } as unknown as AuthenticatedSessionContext;
  const result = await executeBranchAdvance({ context: expiredContext, broker, admission });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "authorization");
  assert.equal(calls.blobs.length, 0);
});

test("rejects an oversized request before any capability is acquired", async () => {
  const { calls, broker } = fake();
  const oversized = {
    ...request,
    commit: { ...request.commit, message: "x".repeat(70_000) },
  };
  const result = await executeBranchAdvance({ context, broker, admission, request: oversized });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "request");
  assert.equal(calls.blobs.length, 0);
});

test("rejects an unsupported Git mode such as a symlink", async () => {
  const unsupported = {
    ...request,
    changes: [{ operation: "upsert", path: "src/link", mode: "120000", content }],
  };
  const validation = validateBranchAdvanceSemanticRequest(unsupported);
  assert.equal(validation.valid, false);
  assert.equal(validation.diagnostics[0]?.code, "BRANCH_ADVANCE_FAILED");

  const { calls, broker } = fake();
  const result = await executeBranchAdvance({ context, broker, admission, request: unsupported });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "request");
  assert.equal(calls.blobs.length, 0);
});

test("resolves provider ambiguity authoritatively instead of guessing an outcome", async () => {
  const { calls, broker } = fake("throws-applied");
  const result = await executeBranchAdvance({ context: scopedContextFor(request.changes), broker, admission });
  assert.equal(result.status, "succeeded");
  assert.equal(result.outcome, "idempotent");
  assert.ok(calls.readRefs >= 2, "must reread authoritatively rather than trust the throw");
});

test("keeps App and commit identities separate and leaks no credential or token", async () => {
  const { calls, broker } = fake();
  const result = await executeBranchAdvance({ context: scopedContextFor(request.changes), broker, admission });
  assert.equal(result.status, "succeeded");
  assert.equal(result.provenance?.app?.principal, "app:inari-issuer");
  assert.equal(result.provenance?.commitAuthor?.name, "Session author");
  assert.notEqual(result.provenance?.app?.principal, result.provenance?.commitAuthor?.name);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("installation-token"), false);
  assert.equal(serialized.includes("private-key"), false);
  assert.equal(serialized.includes("secret"), false);
  assert.deepEqual(calls.blobs, [content]);
});

test("enforces independent WRITE, CREATE, and DELETE scope operations", async () => {
  const cases = [
    {
      operation: "WRITE" as const,
      change: { operation: "upsert" as const, path: "src/file.txt", mode: "100644" as const, content },
    },
    {
      operation: "CREATE" as const,
      change: { operation: "upsert" as const, path: "docs/new.md", mode: "100644" as const, content },
    },
    { operation: "DELETE" as const, change: { operation: "delete" as const, path: "src/file.txt" } },
  ];
  for (const item of cases) {
    const { calls, broker } = fake();
    const result = await executeBranchAdvance({
      context: scopedContextFor([item.change]),
      broker,
      admission,
    });
    assert.equal(result.outcome, "advanced", item.operation);
    assert.equal(calls.updates.length, 1, item.operation);
  }
});

test("does not infer one mutation operation from another allowlist", async () => {
  const cases = [
    { operation: "WRITE", path: "src/file.txt", scope: { write: [], create: ["src/**"], delete: ["src/**"] } },
    { operation: "CREATE", path: "docs/new.md", scope: { write: ["docs/**"], create: [], delete: ["docs/**"] } },
    { operation: "DELETE", path: "src/file.txt", scope: { write: ["src/**"], create: ["src/**"], delete: [] } },
  ] as const;
  for (const item of cases) {
    const { calls, broker } = fake();
    const result = await executeBranchAdvance({
      context: {
        ...scopedContextFor([
          item.operation === "DELETE"
            ? { operation: "delete" as const, path: item.path }
            : { operation: "upsert" as const, path: item.path, mode: "100644" as const, content },
        ]),
        implementationScope: { ...implementationScope, scope: { ...implementationScope.scope, ...item.scope } },
      } as AuthenticatedSessionContext,
      broker,
      admission,
    });
    assert.equal(result.status, "failed", item.operation);
    assert.equal(result.failure?.reason, "authorization", item.operation);
    assert.equal(calls.blobs.length, 0, item.operation);
    assert.equal(calls.updates.length, 0, item.operation);
  }
});

test("DENY overrides every mutation allowlist before Git effects", async () => {
  const { calls, broker } = fake();
  const result = await executeBranchAdvance({
    context: {
      ...scopedContextFor([request.changes[0]]),
      implementationScope: {
        ...implementationScope,
        scope: { write: ["**"], create: ["**"], delete: ["**"], readOnly: [], deny: ["src/file.txt"] },
      },
    } as AuthenticatedSessionContext,
    broker,
    admission,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "authorization");
  assert.equal(calls.blobs.length, 0);
  assert.equal(calls.updates.length, 0);
});

test("enforces a rename as independent DELETE and CREATE operations", async () => {
  const { calls, broker } = fake();
  const changes = [
    { operation: "delete" as const, path: "src/file.txt" },
    { operation: "upsert" as const, path: "docs/renamed.txt", mode: "100644" as const, content },
  ];
  const result = await executeBranchAdvance({ context: scopedContextFor(changes), broker, admission });
  assert.equal(result.outcome, "advanced");
  assert.deepEqual(calls.blobs, [content]);
  assert.equal(calls.updates.length, 1);
});

test("rejects scope identity and path attacks before any Git effect", async () => {
  const mismatched = {
    ...implementationBinding,
    authorization: { ...implementationAuthorization, governedBodyDigest: "2".repeat(64) },
  } as ImplementationSessionAuthorizationBinding;
  for (const item of [
    {
      changes: [{ operation: "upsert" as const, path: "src/file.txt", mode: "100644" as const, content }],
      binding: mismatched,
    },
    { changes: [{ operation: "upsert" as const, path: "src/../secret.txt", mode: "100644" as const, content }] },
    { changes: [{ operation: "upsert" as const, path: "src\\secret.txt", mode: "100644" as const, content }] },
  ]) {
    const { calls, broker } = fake();
    const result = await executeBranchAdvance({
      context: {
        ...scopedContextFor(item.changes),
        ...(item.binding === undefined ? {} : { implementationBinding: item.binding }),
      } as AuthenticatedSessionContext,
      broker,
      admission,
    });
    assert.equal(result.status, "failed");
    assert.equal(calls.blobs.length, 0);
    assert.equal(calls.updates.length, 0);
  }
});

test("fails closed when neither Implementation scope nor binding is present", async () => {
  const { calls, broker } = fake();
  const result = await executeBranchAdvance({ context, broker, admission });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "authorization");
  assert.equal(calls.blobs.length, 0);
  assert.equal(calls.updates.length, 0);
});

test("rejects an admitted branch that differs from the canonical Implementation execution branch", async () => {
  const { calls, broker } = fake();
  const result = await executeBranchAdvance({
    context: {
      ...scopedContextFor(request.changes),
      implementationScope: { ...implementationScope, branch: "feat/466-a-different-implementation-branch" },
    } as AuthenticatedSessionContext,
    broker,
    admission,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "authorization");
  assert.equal(calls.blobs.length, 0);
  assert.equal(calls.updates.length, 0);
});
