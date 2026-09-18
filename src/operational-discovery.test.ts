import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPERATIONAL_DISCOVERY_VERSION,
  tryDiscoverOperationalIssues,
  tryDiscoverOperationalPullRequests,
} from "./operational-discovery.js";
import type {
  GitHubOperationalDiscoveryPage,
  GitHubOperationalIssueSummary,
  GitHubOperationalPullRequestSummary,
} from "./github/types.js";

const repository = { host: "github.com", nameWithOwner: "acme/inari", repositoryId: "100" } as const;

const issueSummary = (number: number): GitHubOperationalIssueSummary => ({
  repository,
  number,
  title: `Issue ${number}`,
  state: "open",
  stateReason: null,
  author: { login: "octocat" },
  labels: ["discovery"],
  assignees: [],
  url: `https://github.com/acme/inari/issues/${number}`,
});

const pullRequestSummary = (number: number): GitHubOperationalPullRequestSummary => ({
  repository,
  number,
  title: `PR ${number}`,
  state: "open",
  author: { login: "octocat" },
  head: { ref: "feat/discovery", sha: "head-sha" },
  base: { ref: "main", sha: "base-sha" },
  draft: false,
  merged: false,
  labels: [],
  assignees: [],
  url: `https://github.com/acme/inari/pull/${number}`,
});

function issuePage(
  overrides: Partial<GitHubOperationalDiscoveryPage<GitHubOperationalIssueSummary>> = {},
): GitHubOperationalDiscoveryPage<GitHubOperationalIssueSummary> {
  return {
    repository,
    filters: { state: "open", page: 1, limit: 2 },
    items: [issueSummary(9), issueSummary(7)],
    pagination: { page: 1, limit: 2, returned: 2, truncated: true, nextPage: 2 },
    provenance: { provider: "github", endpoints: ["issues"] },
    ...overrides,
  };
}

test("Core discovery preserves the provider created-desc page ordering", () => {
  const result = tryDiscoverOperationalIssues({ discovery: issuePage() });
  assert.equal(result.valid, true);
  assert.equal(result.discovery?.version, OPERATIONAL_DISCOVERY_VERSION);
  assert.deepEqual(
    result.discovery?.items.map((item) => item.number),
    [9, 7],
  );
  assert.equal(result.discovery?.pagination.truncated, true);
  assert.equal(result.discovery?.pagination.nextPage, 2);
  assert.equal(result.discovery?.ordering, "created-desc");
  assert.equal("body" in (result.discovery?.items[0] ?? {}), false);
});

test("explicit continuation preserves provider created-desc ordering across pages", () => {
  const first = tryDiscoverOperationalIssues({
    discovery: issuePage({
      filters: { state: "open", page: 1, limit: 2 },
      items: [issueSummary(9), issueSummary(7)],
      pagination: { page: 1, limit: 2, returned: 2, truncated: true, nextPage: 2 },
    }),
  });
  const second = tryDiscoverOperationalIssues({
    discovery: issuePage({
      filters: { state: "open", page: 2, limit: 2 },
      items: [issueSummary(6), issueSummary(2)],
      pagination: { page: 2, limit: 2, returned: 2, truncated: false },
    }),
  });
  assert.equal(first.valid, true);
  assert.equal(second.valid, true);
  assert.equal(first.discovery?.ordering, "created-desc");
  assert.equal(second.discovery?.ordering, "created-desc");
  assert.deepEqual(
    [...(first.discovery?.items ?? []), ...(second.discovery?.items ?? [])].map((item) => item.number),
    [9, 7, 6, 2],
  );
});

test("Core discovery preserves exact PR filters and bounded identity metadata", () => {
  const page: GitHubOperationalDiscoveryPage<GitHubOperationalPullRequestSummary> = {
    repository,
    filters: { state: "all", head: "feat/discovery", base: "main", page: 1, limit: 20 },
    items: [pullRequestSummary(8)],
    pagination: { page: 1, limit: 20, returned: 1, truncated: false },
    provenance: { provider: "github", endpoints: ["pulls"] },
  };
  const result = tryDiscoverOperationalPullRequests({ discovery: page });
  assert.equal(result.valid, true);
  assert.deepEqual(result.discovery?.filters, {
    state: "all",
    head: "feat/discovery",
    base: "main",
    page: 1,
    limit: 20,
  });
  assert.deepEqual(result.discovery?.items[0]?.head, { branch: "feat/discovery", sha: "head-sha" });
});

test("Core discovery rejects oversized or malformed bounded pagination", () => {
  const result = tryDiscoverOperationalIssues({
    discovery: issuePage({
      filters: { state: "open", page: 1, limit: 101 },
      pagination: { page: 1, limit: 101, returned: 2, truncated: false },
    }),
  });
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((violation) => violation.path.includes("limit")));
});

test("Core discovery fails closed for a malformed page without throwing", () => {
  const result = tryDiscoverOperationalIssues({
    discovery: { ...issuePage(), repository: null },
  });
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((violation) => violation.path === "$.discovery.repository"));
});
