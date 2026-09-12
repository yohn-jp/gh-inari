import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  BRANCH_ADVANCE_OPERATION,
  executeBranchAdvance,
  validateBranchAdvanceSemanticRequest,
  type BranchAdvanceSemanticRequest,
} from "./branch-advance.js";
import type { BranchAdvanceCapabilityClaim } from "./capability.js";
import { validateCapabilityExecutionProvenance } from "./capability-provenance.js";
import type { AuthenticatedSessionContext } from "./session-authentication.js";
import type {
  GitDataCapability,
  GitDataCommitInput,
  GitDataRefUpdateInput,
  GitDataTree,
  GitDataTreeInput,
} from "../github/git-data-capability.js";
import type { IssuerInstallationScope } from "../github/issuer-authority.js";
import type { DelegatedTreePathChange } from "./protected-paths.js";
import { RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX } from "./runtime-authority.js";

const NOW = 1_800_000_000;
const REPOSITORY_ID = "466000001";
const BRANCH = "feat/466-session-authorized-branch-advance";
const HEAD = "a".repeat(40);
const BEFORE_TREE = "b".repeat(40);
const AFTER_TREE = "c".repeat(40);
const COMMIT = "d".repeat(40);
const OTHER_HEAD = "e".repeat(40);
const repository = {
  repositoryHost: "github.com",
  repositoryId: REPOSITORY_ID,
  nameWithOwner: "acme/inari",
} as const;
const scope: IssuerInstallationScope = {
  app: {
    kind: "github-app",
    slug: "inari-issuer",
    appId: "466",
    principal: "app:inari-issuer",
  },
  installation: {
    appId: "466",
    installationId: "466001",
    repositoryHost: "github.com",
  },
  repository,
  repositorySelection: "selected",
  permissions: { contents: "write", metadata: "read" },
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function shaForContent(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`, "utf8"), bytes]))
    .digest("hex");
}

function entry(path: string, sha: string, mode = "100644") {
  return { path, sha, mode, type: "blob" as const };
}

function contentEntry(path: string, content: string, mode = "100644") {
  return { ...entry(path, shaForContent(content), mode), content: Buffer.from(content, "utf8").toString("base64") };
}

interface TreeCase {
  readonly request: BranchAdvanceSemanticRequest;
  readonly beforeTree: GitDataTree;
  readonly afterTree: GitDataTree;
  readonly changedBlobCount: number;
}

function tree(sha: string, entries: readonly ReturnType<typeof entry>[]): GitDataTree {
  return Object.freeze({
    sha,
    entries: Object.freeze(
      entries.map((item) => ({ path: item.path, sha: item.sha, mode: item.mode, type: item.type as "blob" })),
    ),
  });
}

function treeCase(kind: "create" | "modify" | "delete" | "mode" | "rename"): TreeCase {
  const old = entry("src/old.txt", shaForContent("old"));
  const unchanged = entry("src/keep.txt", shaForContent("keep"));
  let changes: readonly DelegatedTreePathChange[];
  let before = [old, unchanged];
  let after: ReturnType<typeof entry>[];
  let changedBlobCount = 0;

  if (kind === "create") {
    const added = contentEntry("src/new.txt", "new");
    changes = [{ operation: "create", path: added.path }];
    after = [old, unchanged, added];
    changedBlobCount = 1;
  } else if (kind === "modify") {
    const modified = contentEntry(old.path, "modified");
    changes = [{ operation: "modify", path: modified.path }];
    after = [modified, unchanged];
    changedBlobCount = 1;
  } else if (kind === "delete") {
    changes = [{ operation: "delete", path: old.path }];
    after = [unchanged];
  } else if (kind === "mode") {
    const executable = entry(old.path, old.sha, "100755");
    changes = [{ operation: "modify", path: executable.path }];
    after = [executable, unchanged];
  } else {
    const renamed = contentEntry("src/renamed.txt", "old");
    changes = [{ operation: "rename", path: renamed.path, previousPath: old.path }];
    after = [renamed, unchanged];
    changedBlobCount = 1;
  }

  const request = {
    version: 1 as const,
    repositoryId: REPOSITORY_ID,
    branch: BRANCH,
    expectedHead: HEAD,
    treeDelta: { changes, before, after },
    commit: { message: `test ${kind}`, author: { name: "Session author", email: "author@example.test" } },
  } as BranchAdvanceSemanticRequest;
  return {
    request,
    beforeTree: tree(BEFORE_TREE, before),
    afterTree: tree(AFTER_TREE, after),
    changedBlobCount,
  };
}

function contextFor(
  request: BranchAdvanceSemanticRequest,
  claim: BranchAdvanceCapabilityClaim = { kind: "branch.advance", branch: BRANCH },
) {
  const envelope = {
    version: 1,
    alg: "EdDSA",
    certificate: "compact-certificate",
    request,
    certificateJti: "certificate-466",
    repositoryId: REPOSITORY_ID,
    operation: BRANCH_ADVANCE_OPERATION,
    requestId: "request-466",
    issuedAt: NOW - 10,
    expiresAt: NOW + 100,
    signature: "request-signature",
  };
  return {
    repository,
    runtimeAuthority: { id: "runtime-466", kid: "runtime-466" },
    session: { id: "session-466", certificateJti: "certificate-466" },
    task: { kind: "issue", number: 466 },
    capabilities: [claim],
    authority: { ref: "main", sha: "f".repeat(40) },
    request: {
      requestId: "request-466",
      operation: BRANCH_ADVANCE_OPERATION,
      issuedAt: NOW - 10,
      expiresAt: NOW + 100,
    },
    verifiedRequest: {
      envelope,
      certificate: {
        header: { alg: "EdDSA", typ: "inari-session+jwt", kid: "runtime-466" },
        payload: {
          ver: 1,
          iss: "runtime:runtime-466",
          sub: "session:session-466",
          jti: "certificate-466",
          repository: { id: REPOSITORY_ID, name: "acme/inari" },
          sessionKey: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
          task: { kind: "issue", number: 466 },
          capabilities: [claim],
          iat: NOW - 20,
          nbf: NOW - 20,
          exp: NOW + 200,
        },
        signature: "certificate-signature",
        signingInput: "certificate-signing-input",
      },
      requestDigest: "0".repeat(64),
      signingInput: "signing-input",
      signingInputBytes: new Uint8Array(),
    },
  } as unknown as AuthenticatedSessionContext;
}

interface FakeGitData {
  readonly capability: GitDataCapability;
  readonly calls: {
    readonly blobs: string[];
    readonly trees: GitDataTreeInput[];
    readonly commits: GitDataCommitInput[];
    readonly updates: GitDataRefUpdateInput[];
    readonly reads: string[];
  };
  setHead(head: string, currentTree: GitDataTree): void;
}

function fakeGitData(testCase: TreeCase, mode: "normal" | "reject" | "ambiguous" = "normal"): FakeGitData {
  let head = HEAD;
  let currentTree = testCase.beforeTree;
  const trees = new Map<string, GitDataTree>([
    [BEFORE_TREE, testCase.beforeTree],
    [AFTER_TREE, testCase.afterTree],
    [COMMIT, testCase.afterTree],
  ]);
  const calls = { blobs: [], trees: [], commits: [], updates: [], reads: [] } as FakeGitData["calls"];
  const capability: GitDataCapability = {
    version: 1,
    scope,
    readRef: async (branch) => {
      calls.reads.push(`ref:${branch}`);
      return { name: branch, ref: `refs/heads/${branch}`, sha: head };
    },
    readTree: async (refOrSha) => {
      calls.reads.push(`tree:${refOrSha}`);
      const result = trees.get(refOrSha) ?? (refOrSha === head ? currentTree : undefined);
      if (result === undefined) throw new Error("unknown tree");
      return result;
    },
    createBlob: async ({ content }) => {
      calls.blobs.push(content);
      return { sha: shaForContent(Buffer.from(content, "base64").toString("utf8")) };
    },
    createTree: async (input) => {
      calls.trees.push(input);
      return { sha: AFTER_TREE };
    },
    createCommit: async (input) => {
      calls.commits.push(input);
      return { sha: COMMIT };
    },
    updateRefs: async (input) => {
      calls.updates.push(input);
      if (mode === "reject") return { status: "rejected" };
      head = COMMIT;
      currentTree = testCase.afterTree;
      if (mode === "ambiguous") throw new Error("provider timeout after submission");
      return { status: "updated" };
    },
  };
  return {
    capability,
    calls,
    setHead(nextHead, nextTree) {
      head = nextHead;
      currentTree = nextTree;
    },
  };
}

function brokerFor(fake: FakeGitData) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async withGitDataCapability<T>(_request: unknown, operation: (capability: GitDataCapability) => Promise<T>) {
      calls += 1;
      return operation(fake.capability);
    },
  };
}

async function execute(testCase: TreeCase, mode: "normal" | "reject" | "ambiguous" = "normal") {
  const fake = fakeGitData(testCase, mode);
  const broker = brokerFor(fake);
  const result = await executeBranchAdvance({ context: contextFor(testCase.request), broker, now: NOW });
  return { result, fake, broker };
}

test("validates and advances create, modify, delete, mode, and rename-equivalent deltas", async () => {
  for (const kind of ["create", "modify", "delete", "mode", "rename"] as const) {
    const testCase = treeCase(kind);
    const { result, fake } = await execute(testCase);
    assert.equal(result.status, "succeeded", kind);
    assert.equal(result.outcome, "advanced", kind);
    assert.equal(result.afterHead, COMMIT, kind);
    assert.equal(fake.calls.blobs.length, testCase.changedBlobCount, kind);
    assert.equal(fake.calls.trees.length, 1, kind);
    assert.equal(fake.calls.commits[0]?.author.email, "author@example.test", kind);
    assert.deepEqual(fake.calls.updates[0], {
      branch: BRANCH,
      beforeOid: HEAD,
      afterOid: COMMIT,
      force: false,
    });
  }
});

test("classifies protected paths before the broker can create a Git object", async () => {
  const base = treeCase("modify");
  const protectedPath = `${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime.json`;
  const protectedRequest = {
    ...base.request,
    treeDelta: {
      changes: [{ operation: "modify", path: protectedPath }],
      before: [entry(protectedPath, shaForContent("old"))],
      after: [contentEntry(protectedPath, "new")],
    },
  } as BranchAdvanceSemanticRequest;
  const fake = fakeGitData(base);
  const broker = brokerFor(fake);
  const result = await executeBranchAdvance({ context: contextFor(protectedRequest), broker, now: NOW });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "PROTECTED_PATH_DENIED");
  assert.equal(broker.calls, 0);
  assert.equal(fake.calls.blobs.length, 0);
});

test("fails closed for an unresolved optional path policy", async () => {
  const testCase = treeCase("modify");
  const fake = fakeGitData(testCase);
  const broker = brokerFor(fake);
  const result = await executeBranchAdvance({
    context: contextFor(testCase.request, { kind: "branch.advance", branch: BRANCH, pathPolicy: "policy-v1" }),
    broker,
    now: NOW,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "PATH_POLICY_DENIED");
  assert.equal(broker.calls, 0);
  assert.equal(fake.calls.blobs.length, 0);
});

test("fails closed for wrong repository, wrong branch claim, and default branch", async () => {
  const base = treeCase("modify");
  const wrongRepository = { ...base.request, repositoryId: "466000002" } as BranchAdvanceSemanticRequest;
  const fake = fakeGitData(base);
  const wrongRepositoryResult = await executeBranchAdvance({
    context: contextFor(wrongRepository),
    broker: brokerFor(fake),
    now: NOW,
  });
  assert.equal(wrongRepositoryResult.status, "failed");
  assert.equal(wrongRepositoryResult.failure?.code, "REPOSITORY_MISMATCH");

  const wrongBranch = { ...base.request, branch: "feat/466-other-branch" } as BranchAdvanceSemanticRequest;
  const wrongBranchFake = fakeGitData(base);
  const wrongBranchResult = await executeBranchAdvance({
    context: contextFor(wrongBranch),
    broker: brokerFor(wrongBranchFake),
    now: NOW,
  });
  assert.equal(wrongBranchResult.failure?.code, "CAPABILITY_DENIED");
  assert.equal(wrongBranchFake.calls.blobs.length, 0);

  const defaultRequest = { ...base.request, branch: "main" } as BranchAdvanceSemanticRequest;
  const defaultFake = fakeGitData(base);
  const defaultResult = await executeBranchAdvance({
    context: contextFor(defaultRequest),
    broker: brokerFor(defaultFake),
    now: NOW,
  });
  assert.equal(defaultResult.status, "failed");
  assert.equal(defaultResult.failure?.code, "BRANCH_MISMATCH");
  assert.equal(defaultFake.calls.blobs.length, 0);
});

test("rejects stale and concurrent heads without overwriting", async () => {
  const testCase = treeCase("modify");
  const fake = fakeGitData(testCase);
  fake.setHead(OTHER_HEAD, tree("other-tree", [entry("other.txt", shaForContent("other"))]));
  const result = await executeBranchAdvance({
    context: contextFor(testCase.request),
    broker: brokerFor(fake),
    now: NOW,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.outcome, "stale");
  assert.equal(result.failure?.code, "STALE_EXPECTED_HEAD");
  assert.equal(fake.calls.blobs.length, 0);
  assert.equal(fake.calls.updates.length, 0);
});

test("returns idempotent success only after authoritative reread on exact replay", async () => {
  const testCase = treeCase("modify");
  const { result: first, fake, broker } = await execute(testCase);
  assert.equal(first.outcome, "advanced");
  const second = await executeBranchAdvance({ context: contextFor(testCase.request), broker, now: NOW });
  assert.equal(second.status, "succeeded");
  assert.equal(second.outcome, "idempotent");
  assert.equal(fake.calls.trees.length, 1);
  assert.equal(fake.calls.commits.length, 1);
  assert.equal(fake.calls.updates.length, 1);
  assert.ok(fake.calls.reads.some((read) => read === `tree:${COMMIT}`));
});

test("rereads authoritatively after provider ambiguity before reporting success", async () => {
  const testCase = treeCase("modify");
  const { result, fake } = await execute(testCase, "ambiguous");
  assert.equal(result.status, "succeeded");
  assert.equal(result.outcome, "advanced");
  assert.ok(fake.calls.reads.filter((read) => read === "ref:" + BRANCH).length >= 2);
  assert.equal(fake.calls.updates[0]?.force, false);
});

test("reports a CAS rejection as stale and never force-updates", async () => {
  const testCase = treeCase("modify");
  const { result, fake } = await execute(testCase, "reject");
  assert.equal(result.status, "failed");
  assert.equal(result.outcome, "stale");
  assert.equal(result.failure?.code, "CAS_REJECTED");
  assert.equal(fake.calls.updates[0]?.beforeOid, HEAD);
  assert.equal(fake.calls.updates[0]?.force, false);
});

test("binds freshness and size before any App capability is acquired", async () => {
  const testCase = treeCase("modify");
  const fake = fakeGitData(testCase);
  const broker = brokerFor(fake);
  const expired = await executeBranchAdvance({
    context: contextFor(testCase.request),
    broker,
    now: NOW + 101,
  });
  assert.equal(expired.failure?.code, "SESSION_EXPIRED");
  assert.equal(broker.calls, 0);

  const oversized = {
    ...testCase.request,
    commit: { ...testCase.request.commit, message: "x".repeat(70_000) },
  };
  const oversizedResult = await executeBranchAdvance({
    context: contextFor(oversized as BranchAdvanceSemanticRequest),
    broker,
    now: NOW,
  });
  assert.equal(oversizedResult.failure?.code, "REQUEST_TOO_LARGE");
  assert.equal(broker.calls, 0);
});

test("rejects unsupported Git modes and incomplete deltas before object creation", async () => {
  const testCase = treeCase("mode");
  const unsupported = {
    ...testCase.request,
    treeDelta: {
      ...testCase.request.treeDelta,
      after: [entry("src/old.txt", testCase.request.treeDelta.before[0]!.sha, "160000")],
    },
  } as BranchAdvanceSemanticRequest;
  const fake = fakeGitData(testCase);
  const unsupportedResult = await executeBranchAdvance({
    context: contextFor(unsupported),
    broker: brokerFor(fake),
    now: NOW,
  });
  assert.equal(unsupportedResult.status, "failed");
  assert.equal(unsupportedResult.failure?.code, "TREE_DELTA_INVALID");
  assert.equal(fake.calls.blobs.length, 0);

  const validation = validateBranchAdvanceSemanticRequest({
    ...testCase.request,
    treeDelta: { changes: testCase.request.treeDelta.changes, before: testCase.request.treeDelta.before },
  });
  assert.equal(validation.valid, false);
  assert.equal(validation.diagnostics[0]?.code, "TREE_DELTA_INVALID");
});

test("keeps App and commit identities separate and does not return a credential", async () => {
  const { result } = await execute(treeCase("modify"));
  assert.equal(result.provenance?.app?.principal, "app:inari-issuer");
  assert.equal(result.provenance?.commitAuthor?.name, "Session author");
  assert.notEqual(result.provenance?.app?.principal, result.provenance?.commitAuthor?.name);
  assert.equal(validateCapabilityExecutionProvenance(result.provenance).valid, true);
  assert.equal(JSON.stringify(result).includes("installation-token"), false);
  assert.equal(JSON.stringify(result).includes("private-key"), false);
});
