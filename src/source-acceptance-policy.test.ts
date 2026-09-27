import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { DelegatorSourceReader } from "./agent-authority/delegator-trust.js";
import type { GitHubBranch, RepositoryContext, RepositoryTree } from "./github/types.js";
import {
  loadSourceAcceptancePolicy,
  SOURCE_ACCEPTANCE_POLICY_KIND,
  SOURCE_ACCEPTANCE_POLICY_PATH,
  SOURCE_ACCEPTANCE_POLICY_VERSION,
  SourceAcceptancePolicyLoadError,
  type SourceAcceptancePolicyLoadErrorCode,
} from "./source-acceptance-policy.js";

const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const REPOSITORY: RepositoryContext = {
  hostname: "github.com",
  host: "github.com",
  owner: "yohn-jp",
  name: "gh-inari",
  nameWithOwner: "yohn-jp/gh-inari",
  url: "https://github.com/yohn-jp/gh-inari",
  repositoryId: "1330755860",
};

interface EvidenceState {
  context: RepositoryContext;
  defaultBranch: string;
  branch: GitHubBranch | undefined;
  tree: RepositoryTree;
  readonly blobs: Map<string, string>;
  treeError?: Error;
  blobError?: Error;
}

interface ReaderCalls {
  readonly branchRefs: string[];
  readonly treeRefs: string[];
  readonly blobShas: string[];
}

function policySource(generation = 4, reviewerUserIds: readonly string[] = ["12345", "67890"]): string {
  return JSON.stringify({
    version: SOURCE_ACCEPTANCE_POLICY_VERSION,
    kind: SOURCE_ACCEPTANCE_POLICY_KIND,
    generation,
    reviewerUserIds,
  });
}

function gitBlobSha(source: string): string {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(source, "utf8")}\0`, "utf8")
    .update(source, "utf8")
    .digest("hex");
}

function makeState(source = policySource()): EvidenceState {
  const blobSha = gitBlobSha(source);
  return {
    context: REPOSITORY,
    defaultBranch: "main",
    branch: { name: "main", ref: "refs/heads/main", sha: COMMIT_SHA },
    tree: {
      sha: TREE_SHA,
      entries: [{ path: SOURCE_ACCEPTANCE_POLICY_PATH, type: "blob", sha: blobSha }],
    },
    blobs: new Map([[blobSha, source]]),
  };
}

function reader(state: EvidenceState, calls: ReaderCalls): DelegatorSourceReader {
  return {
    async resolveRepositoryContext() {
      return state.context;
    },
    async getRepositoryDefaultBranch() {
      return state.defaultBranch;
    },
    async findBranch(ref) {
      calls.branchRefs.push(ref);
      return state.branch;
    },
    async getRepositoryTree(ref) {
      calls.treeRefs.push(ref);
      if (state.treeError !== undefined) throw state.treeError;
      return state.tree;
    },
    async getRepositoryBlob(sha) {
      calls.blobShas.push(sha);
      if (state.blobError !== undefined) throw state.blobError;
      const source = state.blobs.get(sha);
      if (source === undefined) throw new Error("blob missing");
      return source;
    },
  };
}

function calls(): ReaderCalls {
  return { branchRefs: [], treeRefs: [], blobShas: [] };
}

async function rejectsWithCode(promise: Promise<unknown>, code: SourceAcceptancePolicyLoadErrorCode): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof SourceAcceptancePolicyLoadError && error.code === code,
  );
}

test("loads one strict policy from the current protected default-branch snapshot with exact provenance", async () => {
  const source = policySource(7, ["12345", "67890"]);
  const state = makeState(source);
  const observed = calls();
  const loaded = await loadSourceAcceptancePolicy(reader(state, observed));

  assert.deepEqual(loaded.policy, {
    version: 1,
    kind: "source-acceptance-policy",
    generation: 7,
    reviewerUserIds: ["12345", "67890"],
  });
  assert.deepEqual(loaded.provenance, {
    authority: "repository-default-branch",
    repository: { host: "github.com", id: "1330755860" },
    ref: "main",
    commitSha: COMMIT_SHA,
    treeSha: TREE_SHA,
    source: {
      path: SOURCE_ACCEPTANCE_POLICY_PATH,
      ref: "main",
      blobSha: gitBlobSha(source),
      digest: createHash("sha256").update(source, "utf8").digest("hex"),
    },
    generation: 7,
  });
  assert.deepEqual(observed.branchRefs, ["main"]);
  assert.deepEqual(observed.treeRefs, [COMMIT_SHA]);
  assert.deepEqual(observed.blobShas, [gitBlobSha(source)]);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.policy), true);
  assert.equal(Object.isFrozen(loaded.policy.reviewerUserIds), true);
  assert.equal(Object.isFrozen(loaded.provenance), true);
});

test("uses only the one exact policy path and rejects its absence", async () => {
  const state = makeState();
  state.tree = {
    sha: TREE_SHA,
    entries: [
      {
        path: `${SOURCE_ACCEPTANCE_POLICY_PATH}.backup`,
        type: "blob",
        sha: gitBlobSha(policySource()),
      },
    ],
  };
  const observed = calls();
  await rejectsWithCode(loadSourceAcceptancePolicy(reader(state, observed)), "SOURCE_ACCEPTANCE_POLICY_NOT_FOUND");
  assert.deepEqual(observed.blobShas, []);
});

test("rejects duplicate paths, non-blob policy entries, and incomplete tree evidence", async () => {
  const duplicate = makeState();
  duplicate.tree = {
    sha: TREE_SHA,
    entries: [
      { path: SOURCE_ACCEPTANCE_POLICY_PATH, type: "blob", sha: gitBlobSha(policySource()) },
      { path: SOURCE_ACCEPTANCE_POLICY_PATH, type: "blob", sha: gitBlobSha(policySource()) },
    ],
  };
  await rejectsWithCode(loadSourceAcceptancePolicy(reader(duplicate, calls())), "SOURCE_ACCEPTANCE_POLICY_AMBIGUOUS");

  const directory = makeState();
  directory.tree = {
    sha: TREE_SHA,
    entries: [{ path: SOURCE_ACCEPTANCE_POLICY_PATH, type: "tree", sha: TREE_SHA }],
  };
  await rejectsWithCode(
    loadSourceAcceptancePolicy(reader(directory, calls())),
    "SOURCE_ACCEPTANCE_POLICY_SOURCE_INVALID",
  );

  const truncated = makeState();
  truncated.tree = {
    ...truncated.tree,
    truncated: true,
  } as RepositoryTree;
  await rejectsWithCode(
    loadSourceAcceptancePolicy(reader(truncated, calls())),
    "SOURCE_ACCEPTANCE_POLICY_SOURCE_INVALID",
  );
});

test("rejects a stale or malformed branch binding before reading its tree", async () => {
  const state = makeState();
  state.branch = { name: "work", ref: "refs/heads/work", sha: COMMIT_SHA };
  const observed = calls();
  await rejectsWithCode(loadSourceAcceptancePolicy(reader(state, observed)), "SOURCE_ACCEPTANCE_POLICY_SOURCE_INVALID");
  assert.deepEqual(observed.treeRefs, []);
  assert.deepEqual(observed.blobShas, []);
});

test("fails closed on malformed JSON, duplicate JSON members, unknown fields, duplicate IDs, and invalid generation or IDs", async () => {
  const invalidSources = [
    "{",
    '{"version":1,"version":1,"kind":"source-acceptance-policy","generation":4,"reviewerUserIds":[]}',
    JSON.stringify({
      version: 1,
      kind: "source-acceptance-policy",
      generation: 4,
      reviewerUserIds: [],
      extra: true,
    }),
    policySource(0),
    policySource(Number.MAX_SAFE_INTEGER + 1),
    policySource(4, ["12345", "12345"]),
    policySource(4, ["0"]),
    policySource(4, ["0123"]),
    policySource(4, ["not-a-user-id"]),
    JSON.stringify({ version: 2, kind: "source-acceptance-policy", generation: 4, reviewerUserIds: [] }),
  ];

  for (const source of invalidSources) {
    const state = makeState(source);
    await rejectsWithCode(
      loadSourceAcceptancePolicy(reader(state, calls())),
      "SOURCE_ACCEPTANCE_POLICY_SOURCE_INVALID",
    );
  }
});

test("allows an explicit empty allowlist without granting any reviewer", async () => {
  const loaded = await loadSourceAcceptancePolicy(reader(makeState(policySource(1, [])), calls()));
  assert.deepEqual(loaded.policy.reviewerUserIds, []);
});

test("maps unavailable tree and blob reads to fail-closed evidence errors", async () => {
  const treeUnavailable = makeState();
  treeUnavailable.treeError = new Error("provider unavailable");
  await rejectsWithCode(
    loadSourceAcceptancePolicy(reader(treeUnavailable, calls())),
    "SOURCE_ACCEPTANCE_POLICY_SOURCE_UNAVAILABLE",
  );

  const blobUnavailable = makeState();
  blobUnavailable.blobError = new Error("provider unavailable");
  await rejectsWithCode(
    loadSourceAcceptancePolicy(reader(blobUnavailable, calls())),
    "SOURCE_ACCEPTANCE_POLICY_SOURCE_UNAVAILABLE",
  );
});

test("rereads the protected ref and returns new generation provenance instead of using a cache", async () => {
  const state = makeState(policySource(1, ["12345"]));
  const observed = calls();
  const source = reader(state, observed);
  const first = await loadSourceAcceptancePolicy(source);

  const nextSource = policySource(2, ["67890"]);
  const nextBlobSha = gitBlobSha(nextSource);
  state.branch = { name: "main", ref: "refs/heads/main", sha: "c".repeat(40) };
  state.tree = {
    sha: "d".repeat(40),
    entries: [{ path: SOURCE_ACCEPTANCE_POLICY_PATH, type: "blob", sha: nextBlobSha }],
  };
  state.blobs.set(nextBlobSha, nextSource);

  const second = await loadSourceAcceptancePolicy(source);
  assert.equal(first.policy.generation, 1);
  assert.equal(second.policy.generation, 2);
  assert.equal(second.provenance.commitSha, "c".repeat(40));
  assert.equal(second.provenance.treeSha, "d".repeat(40));
  assert.equal(second.provenance.source.digest, createHash("sha256").update(nextSource, "utf8").digest("hex"));
  assert.equal(observed.branchRefs.length, 2);
  assert.equal(observed.treeRefs.length, 2);
  assert.equal(observed.blobShas.length, 2);
});

test("rejects invalid immutable repository identity before reading policy evidence", async () => {
  const state = makeState();
  state.context = { ...REPOSITORY, repositoryId: "0" };
  const observed = calls();
  await rejectsWithCode(
    loadSourceAcceptancePolicy(reader(state, observed)),
    "SOURCE_ACCEPTANCE_POLICY_REPOSITORY_ID_UNAVAILABLE",
  );
  assert.deepEqual(observed.branchRefs, []);
  assert.deepEqual(observed.treeRefs, []);
});
