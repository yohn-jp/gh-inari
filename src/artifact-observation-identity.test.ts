import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertArtifactObservationIdentityCurrent,
  createArtifactObservationIdentity,
  StaleArtifactObservationError,
  type ArtifactObservationIdentity,
} from "./artifact-observation-identity.js";
import type { GitHubIssue, GitHubPullRequest } from "./github/types.js";

const issue: GitHubIssue = {
  number: 12,
  title: "feat: original",
  body: "Original body\n",
  state: "open",
  url: "https://github.com/acme/repository/issues/12",
  labels: ["feature", "triage"],
  assignees: ["octocat", "hubot"],
  repositoryId: "1234",
  repositoryHost: "github.com",
};

const pullRequest: GitHubPullRequest = {
  number: 18,
  title: "feat: original",
  body: "Original body\n",
  state: "open",
  url: "https://github.com/acme/repository/pull/18",
  draft: false,
  head: "feature",
  headSha: "head-a",
  base: "main",
  baseSha: "base-a",
  maintainerCanModify: true,
};

test("Issue observation identity is deterministic for provider-normalized collection order", () => {
  const reordered: GitHubIssue = {
    ...issue,
    labels: [...issue.labels].reverse(),
    assignees: [...issue.assignees].reverse(),
  };

  const identity = createArtifactObservationIdentity("issue", issue);
  assert.equal(createArtifactObservationIdentity("issue", reordered), identity);
  assert.match(identity, /^[a-f0-9]{64}$/u);
});

test("Issue identity changes for resource, body, title, state, and governed metadata changes", () => {
  const identity = createArtifactObservationIdentity("issue", issue);
  const changed: readonly GitHubIssue[] = [
    { ...issue, number: issue.number + 1 },
    { ...issue, url: "https://github.com/acme/renamed/issues/12" },
    { ...issue, repositoryId: "5678" },
    { ...issue, body: "Concurrent body edit\n" },
    { ...issue, title: "feat: concurrent title" },
    { ...issue, state: "closed" },
    { ...issue, labels: ["feature"] },
    { ...issue, assignees: ["octocat"] },
  ];

  for (const snapshot of changed) assert.notEqual(createArtifactObservationIdentity("issue", snapshot), identity);
});

test("PR identity binds body, title, state, draft, head/base refs and observed metadata", () => {
  const identity = createArtifactObservationIdentity("pr", pullRequest);
  const changed: readonly GitHubPullRequest[] = [
    { ...pullRequest, number: pullRequest.number + 1 },
    { ...pullRequest, body: "Concurrent body edit\n" },
    { ...pullRequest, title: "feat: concurrent title" },
    { ...pullRequest, state: "closed" },
    { ...pullRequest, draft: true },
    { ...pullRequest, head: "other-feature" },
    { ...pullRequest, headSha: "head-b" },
    { ...pullRequest, base: "release" },
    { ...pullRequest, baseSha: "base-b" },
    { ...pullRequest, maintainerCanModify: false },
    { ...pullRequest, headSha: undefined },
  ];

  for (const snapshot of changed) assert.notEqual(createArtifactObservationIdentity("pr", snapshot), identity);
});

test("stale comparison fails with a stable, credential-free error", () => {
  const expected: ArtifactObservationIdentity = createArtifactObservationIdentity("pr", pullRequest);

  assert.throws(
    () => assertArtifactObservationIdentityCurrent("pr", expected, { ...pullRequest, base: "release" }, 18),
    (error: unknown) => {
      assert.ok(error instanceof StaleArtifactObservationError);
      assert.equal(error.code, "ARTIFACT_OBSERVATION_STALE");
      assert.deepEqual(error.details, { domain: "pr", number: 18 });
      assert.equal(error.message.includes("head-a"), false);
      return true;
    },
  );
});
