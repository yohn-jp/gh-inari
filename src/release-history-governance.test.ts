import assert from "node:assert/strict";
import test from "node:test";
import type { GitHubPullRequest, RepositoryContext, RepositoryTree } from "./github/types.js";
import {
  admitReleasePullRequest,
  createReleaseHistoryGovernanceReader,
  ReleaseHistoryGovernanceError,
} from "./release-history-governance.js";

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
const body = `## Summary\n\nChange\n\n<!-- inari:semantic-relation {"version":"1","implements":[{"repositoryHost":"github.com","repositoryId":"1330755860","repository":"yohn-jp/gh-inari","number":912}]} -->\n<!-- inari:template ${JSON.stringify({ version: "1", kind: "pull_request", path: templatePath })} -->\n`;
const pullRequest: GitHubPullRequest = {
  number: 927,
  title: "Governed change",
  body,
  state: "closed",
  url: "https://github.com/yohn-jp/gh-inari/pull/927",
  draft: false,
  head: "feature/release",
  base: "main",
  merged: true,
  mergedAt: "2026-09-21T15:00:00Z",
  mergeCommitSha: "c".repeat(40),
};

function reader() {
  const tree: RepositoryTree = {
    sha: "2".repeat(40),
    entries: [{ path: templatePath, type: "blob", sha: templateSha }],
  };
  return createReleaseHistoryGovernanceReader({
    context: repository,
    targetRef: "main",
    getRepositoryTree: async () => tree,
    getRepositoryBlob: async (sha) => {
      assert.equal(sha, templateSha);
      return "## Summary\n\n<!-- summary -->\n";
    },
  });
}

test("admits only a PR with the target-source template and semantic relation evidence", async () => {
  const result = await admitReleasePullRequest({
    pullRequest,
    mergeCommitSha: "c".repeat(40),
    repository,
    governance: reader(),
  });
  assert.deepEqual(result, {
    number: 927,
    title: "Governed change",
    mergeCommitSha: "c".repeat(40),
    mergedAt: "2026-09-21T15:00:00Z",
    governed: true,
    sourceIssueNumbers: [912],
  });
});

test("fails closed for merged prose without the canonical governance marker", async () => {
  await assert.rejects(
    () =>
      admitReleasePullRequest({
        pullRequest: { ...pullRequest, body: "## Summary\n\nA merged change\n" },
        mergeCommitSha: "c".repeat(40),
        repository,
        governance: reader(),
      }),
    ReleaseHistoryGovernanceError,
  );
});
