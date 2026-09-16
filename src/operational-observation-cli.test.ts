import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { GitHubAdapter, type RepositoryContext, type RepositoryTree } from "./github/index.js";
import type {
  GitHubOperationalCollection,
  GitHubOperationalIssueEvidence,
  GitHubOperationalPullRequestEvidence,
} from "./github/types.js";

const context: RepositoryContext = {
  hostname: "github.com",
  host: "github.com",
  owner: "acme",
  name: "inari",
  nameWithOwner: "acme/inari",
  url: "https://github.com/acme/inari",
  repositoryId: "100",
};

function collection<T>(items: readonly T[] = []): GitHubOperationalCollection<T> {
  return {
    status: "available",
    items,
    pagination: { perPage: 100, pages: 1, returned: items.length, truncated: false },
    diagnostics: [],
  };
}

const issue: GitHubOperationalIssueEvidence = {
  repository: { host: "github.com", nameWithOwner: "acme/inari", repositoryId: "100" },
  number: 7,
  title: "Legacy Issue",
  body: "This body must remain observable.",
  state: "open",
  author: { login: "octocat" },
  labels: ["legacy"],
  assignees: [],
  url: "https://github.com/acme/inari/issues/7",
  comments: collection(),
  provenance: { provider: "github", endpoints: ["issues/7"] },
};

const pullRequest: GitHubOperationalPullRequestEvidence = {
  repository: { host: "github.com", nameWithOwner: "acme/inari", repositoryId: "100" },
  number: 8,
  title: "Runtime PR",
  body: "body",
  state: "open",
  author: { login: "octocat" },
  head: { ref: "feat/runtime", sha: "head-sha" },
  base: { ref: "main", sha: "base-sha" },
  mergeable: null,
  mergeState: null,
  reviewDecision: "APPROVED",
  merged: false,
  labels: [],
  assignees: [],
  url: "https://github.com/acme/inari/pull/8",
  checks: collection(),
  requiredCheckBindings: collection(),
  reviews: collection(),
  comments: collection(),
  inlineReviewComments: collection(),
  changedFiles: collection(),
  provenance: { provider: "github", endpoints: ["pulls/8"] },
};

class CliOperationalAdapter extends GitHubAdapter {
  constructor(private readonly kind: "issue" | "pr") {
    super({ repository: "acme/inari" });
  }

  override async resolveRepositoryContext(): Promise<RepositoryContext> {
    return context;
  }

  override async getRepositoryDefaultBranch(): Promise<string> {
    return "main";
  }

  override async getRepositoryTree(_ref: string): Promise<RepositoryTree> {
    return { sha: "tree", entries: [] };
  }

  override async getIssue(_number: number): Promise<never> {
    throw new Error("no semantic template candidate");
  }

  override async getPullRequest(_number: number): Promise<never> {
    throw new Error("no semantic template candidate");
  }

  override async observeIssue(_number: number): Promise<GitHubOperationalIssueEvidence> {
    assert.equal(this.kind, "issue");
    return issue;
  }

  override async observePullRequest(_number: number): Promise<GitHubOperationalPullRequestEvidence> {
    assert.equal(this.kind, "pr");
    return pullRequest;
  }
}

async function capture(argv: string[], adapter: GitHubAdapter): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (line: string) => lines.push(line);
    assert.equal(await runCli(argv, { createAdapter: () => adapter }), 0, lines.join("\n"));
  } finally {
    console.log = originalLog;
  }
  return JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
}

test("CLI Issue observation remains available for a wrong-template/non-canonical Issue", async () => {
  const output = await capture(["issue", "observe", "7", "--json"], new CliOperationalAdapter("issue"));
  const observed = output.observed as Record<string, unknown>;
  const semantic = output.semantic as Record<string, unknown>;
  assert.equal(output.operation, "issue.observe");
  assert.equal(observed.title, "Legacy Issue");
  assert.equal(observed.body, "This body must remain observable.");
  assert.equal(observed.state, "open");
  assert.equal(semantic.status, "unavailable");
});

test("CLI PR observation exposes identity and explicit unknown merge state", async () => {
  const output = await capture(["pr", "observe", "8", "--json"], new CliOperationalAdapter("pr"));
  const observed = output.observed as Record<string, unknown>;
  const head = observed.head as Record<string, unknown>;
  const base = observed.base as Record<string, unknown>;
  assert.equal(head.branch, "feat/runtime");
  assert.equal(head.sha, "head-sha");
  assert.equal(base.branch, "main");
  assert.equal(base.sha, "base-sha");
  assert.equal(observed.mergeability, "unknown");
  assert.equal(observed.reviewDecision, "approved");
});
