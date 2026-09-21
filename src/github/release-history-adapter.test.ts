import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubReleaseHistoryAdapter,
  ReleaseHistoryAdapterError,
  type GitHubReleaseHistoryApi,
} from "./release-history-adapter.js";
import type { RepositoryContext, RepositoryTree } from "./types.js";

const previousRevision = "a".repeat(40);
const targetRevision = "b".repeat(40);
const mergeRevision = "c".repeat(40);
const repository: RepositoryContext = {
  hostname: "github.com",
  host: "github.com",
  owner: "yohn-jp",
  name: "gh-inari",
  nameWithOwner: "yohn-jp/gh-inari",
  url: "https://github.com/yohn-jp/gh-inari",
  repositoryId: "1330755860",
};
const templatePath = ".github/PULL_REQUEST_TEMPLATE/default.md";
const templateSha = "1".repeat(40);
const treeSha = "2".repeat(40);
const template = "## Summary\n\n<!-- summary -->\n";
const relation = {
  version: "1",
  implements: [
    {
      repositoryHost: "github.com",
      repositoryId: "1330755860",
      repository: "yohn-jp/gh-inari",
      number: 912,
    },
  ],
};
const marker = `<!-- inari:template ${JSON.stringify({ version: "1", kind: "pull_request", path: templatePath })} -->`;
const relationMarker = `<!-- inari:semantic-relation ${JSON.stringify(relation)} -->`;
const pullRequestBody = `## Summary\n\nChange\n\n${relationMarker}\n${marker}\n`;
const pullRequest = {
  number: 927,
  title: "Add governed release planning",
  body: pullRequestBody,
  state: "closed",
  html_url: "https://github.com/yohn-jp/gh-inari/pull/927",
  draft: false,
  head: { ref: "feature/release", sha: "d".repeat(40) },
  base: { ref: "main", sha: targetRevision },
  merged: true,
  merged_at: "2026-09-21T15:00:00Z",
  merge_commit_sha: mergeRevision,
};

function compareResponse(commits: readonly unknown[] = [{ sha: mergeRevision }], total = commits.length) {
  return {
    status: "ahead",
    ahead_by: total,
    behind_by: 0,
    total_commits: total,
    base_commit: { sha: previousRevision },
    merge_base_commit: { sha: previousRevision },
    commits,
  };
}

function governanceTree(): RepositoryTree {
  return {
    sha: treeSha,
    entries: [{ path: templatePath, type: "blob", sha: templateSha }],
  };
}

function adapter(
  responses: Readonly<Record<string, unknown>>,
  branchSha = targetRevision,
): {
  readonly adapter: GitHubReleaseHistoryAdapter;
  readonly paths: string[];
} {
  const paths: string[] = [];
  const api: GitHubReleaseHistoryApi = {
    async getRepositoryDefaultBranch() {
      return "main";
    },
    async findBranch(branch) {
      assert.equal(branch, "main");
      return { name: branch, ref: `refs/heads/${branch}`, sha: branchSha };
    },
    async requestRepositoryApi(path) {
      paths.push(path);
      const body = responses[path];
      if (body === undefined) throw new Error(`Unexpected path: ${path}`);
      return { status: 200, body };
    },
    async resolveRepositoryContext() {
      return repository;
    },
    async getRepositoryTree() {
      return governanceTree();
    },
    async getRepositoryBlob(sha) {
      assert.equal(sha, templateSha);
      return template;
    },
  };
  return { adapter: new GitHubReleaseHistoryAdapter({ adapter: api }), paths };
}

test("normalizes a real compare object and commit-associated governed PR evidence", async () => {
  const { adapter: historyAdapter, paths } = adapter({
    "git/refs/tags?per_page=100": [
      { ref: "refs/tags/v0.14.1", object: { type: "commit", sha: previousRevision } },
      { ref: "refs/tags/not-a-release", object: { type: "commit", sha: "e".repeat(40) } },
    ],
    [`compare/${previousRevision}...${targetRevision}?per_page=100`]: compareResponse(),
    [`commits/${mergeRevision}/pulls?per_page=100`]: [{ number: 927 }],
    "pulls/927": pullRequest,
  });
  const evidence = await historyAdapter.readReleaseHistory();
  assert.deepEqual(evidence.previousRelease, { tag: "v0.14.1", version: "0.14.1", sourceRevision: previousRevision });
  assert.deepEqual(evidence.targetSource, { ref: "main", sourceRevision: targetRevision });
  assert.deepEqual(evidence.includedChanges, [
    {
      number: 927,
      title: "Add governed release planning",
      mergeCommitSha: mergeRevision,
      mergedAt: "2026-09-21T15:00:00Z",
      governed: true,
      sourceIssueNumbers: [912],
    },
  ]);
  assert.deepEqual(paths, [
    "git/refs/tags?per_page=100",
    `compare/${previousRevision}...${targetRevision}?per_page=100`,
    `commits/${mergeRevision}/pulls?per_page=100`,
    "pulls/927",
  ]);
});

test("annotated tags resolve before comparing the exact release range", async () => {
  const annotatedTagSha = "f".repeat(40);
  const { adapter: historyAdapter } = adapter({
    "git/refs/tags?per_page=100": [{ ref: "refs/tags/v0.14.1", object: { type: "tag", sha: annotatedTagSha } }],
    [`git/tags/${annotatedTagSha}`]: { object: { type: "commit", sha: previousRevision } },
    [`compare/${previousRevision}...${targetRevision}?per_page=100`]: compareResponse(),
    [`commits/${mergeRevision}/pulls?per_page=100`]: [{ number: 927 }],
    "pulls/927": pullRequest,
  });
  const evidence = await historyAdapter.readReleaseHistory();
  assert.equal(evidence.previousRelease.sourceRevision, previousRevision);
});

test("identical compare range has no associated PR reads", async () => {
  const { adapter: historyAdapter, paths } = adapter(
    {
      "git/refs/tags?per_page=100": [{ ref: "refs/tags/v0.14.1", object: { type: "commit", sha: previousRevision } }],
      [`compare/${previousRevision}...${previousRevision}?per_page=100`]: {
        status: "identical",
        ahead_by: 0,
        behind_by: 0,
        total_commits: 0,
        base_commit: { sha: previousRevision },
        merge_base_commit: { sha: previousRevision },
        commits: [],
      },
    },
    previousRevision,
  );
  const evidence = await historyAdapter.readReleaseHistory({ targetRef: "main" });
  assert.deepEqual(evidence.includedChanges, []);
  assert.deepEqual(paths, [
    "git/refs/tags?per_page=100",
    `compare/${previousRevision}...${previousRevision}?per_page=100`,
  ]);
});

test("compare pagination, unassociated commits, and conflicting associations fail closed", async (t) => {
  await t.test("pagination", async () => {
    const { adapter: historyAdapter } = adapter({
      "git/refs/tags?per_page=100": [{ ref: "refs/tags/v0.14.1", object: { type: "commit", sha: previousRevision } }],
      [`compare/${previousRevision}...${targetRevision}?per_page=100`]: {
        ...compareResponse([{ sha: mergeRevision }], 2),
        commits: [{ sha: mergeRevision }],
      },
    });
    // The mock transport cannot attach headers through its fixture body; the
    // cardinality mismatch exercises the same fail-closed boundary.
    await assert.rejects(() => historyAdapter.readReleaseHistory(), ReleaseHistoryAdapterError);
  });
  await t.test("unassociated", async () => {
    const { adapter: historyAdapter } = adapter({
      "git/refs/tags?per_page=100": [{ ref: "refs/tags/v0.14.1", object: { type: "commit", sha: previousRevision } }],
      [`compare/${previousRevision}...${targetRevision}?per_page=100`]: compareResponse(),
      [`commits/${mergeRevision}/pulls?per_page=100`]: [],
    });
    await assert.rejects(() => historyAdapter.readReleaseHistory(), ReleaseHistoryAdapterError);
  });
  await t.test("conflicting", async () => {
    const { adapter: historyAdapter } = adapter({
      "git/refs/tags?per_page=100": [{ ref: "refs/tags/v0.14.1", object: { type: "commit", sha: previousRevision } }],
      [`compare/${previousRevision}...${targetRevision}?per_page=100`]: compareResponse(),
      [`commits/${mergeRevision}/pulls?per_page=100`]: [{ number: 927 }, { number: 928 }],
    });
    await assert.rejects(() => historyAdapter.readReleaseHistory(), ReleaseHistoryAdapterError);
  });
});

test("ambiguous highest release tags fail closed", async () => {
  const { adapter: historyAdapter } = adapter({
    "git/refs/tags?per_page=100": [
      { ref: "refs/tags/v0.14.1", object: { type: "commit", sha: previousRevision } },
      { ref: "refs/tags/0.14.1", object: { type: "commit", sha: "d".repeat(40) } },
    ],
  });
  await assert.rejects(() => historyAdapter.readReleaseHistory(), ReleaseHistoryAdapterError);
});
