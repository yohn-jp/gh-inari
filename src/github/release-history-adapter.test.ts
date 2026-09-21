import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubReleaseHistoryAdapter,
  ReleaseHistoryAdapterError,
  type GitHubReleaseHistoryApi,
} from "./release-history-adapter.js";

const previousRevision = "a".repeat(40);
const targetRevision = "b".repeat(40);
const mergeRevision = "c".repeat(40);

function adapter(responses: Readonly<Record<string, unknown>>): {
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
      return { name: branch, ref: `refs/heads/${branch}`, sha: targetRevision };
    },
    async requestRepositoryApi(path) {
      paths.push(path);
      const body = responses[path];
      if (body === undefined) throw new Error(`Unexpected path: ${path}`);
      return { status: 200, body };
    },
  };
  return { adapter: new GitHubReleaseHistoryAdapter({ adapter: api }), paths };
}

test("normalizes a bounded GitHub tag, source history, and merged PR evidence", async () => {
  const { adapter: historyAdapter, paths } = adapter({
    "git/refs/tags?per_page=100": [
      { ref: "refs/tags/v0.14.1", object: { type: "commit", sha: previousRevision } },
      { ref: "refs/tags/not-a-release", object: { type: "commit", sha: "d".repeat(40) } },
    ],
    [`commits/${targetRevision}?per_page=100`]: [
      { sha: targetRevision },
      { sha: mergeRevision },
      { sha: previousRevision },
    ],
    "pulls?state=closed&base=main&per_page=100": [
      {
        number: 927,
        title: "Add governed release planning",
        body: "Closes #912",
        base: { ref: "main" },
        merged_at: "2026-09-21T15:00:00Z",
        merge_commit_sha: mergeRevision,
      },
      {
        number: 900,
        title: "An unrelated future branch",
        base: { ref: "main" },
        merged_at: "2026-09-21T15:01:00Z",
        merge_commit_sha: "e".repeat(40),
      },
    ],
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
    `commits/${targetRevision}?per_page=100`,
    "pulls?state=closed&base=main&per_page=100",
  ]);
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
