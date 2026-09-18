import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { test } from "node:test";
import { createInariMcpServer } from "./mcp/server.js";
import { composedViewOutputSchema } from "./mcp/tools.js";
import { GitHubApiError, GitHubAdapter, type RepositoryContext, type RepositoryTree } from "./github/index.js";
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

function collection<T>(): GitHubOperationalCollection<T> {
  return {
    status: "available",
    items: [],
    pagination: { perPage: 100, pages: 1, returned: 0, truncated: false },
    diagnostics: [],
  };
}

class McpOperationalAdapter extends GitHubAdapter {
  issueReads = 0;
  pullRequestReads = 0;
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
    this.issueReads += 1;
    throw new Error("semantic template unavailable");
  }

  override async getPullRequest(_number: number): Promise<never> {
    this.pullRequestReads += 1;
    throw new Error("semantic template unavailable");
  }

  override async observeIssue(number: number): Promise<GitHubOperationalIssueEvidence> {
    return {
      repository: { host: "github.com", nameWithOwner: "acme/inari", repositoryId: "100" },
      number,
      title: "Observed Issue",
      body: "body",
      state: "open",
      author: { login: "octocat" },
      labels: [],
      assignees: [],
      url: `https://github.com/acme/inari/issues/${number}`,
      comments: collection(),
      provenance: { provider: "github", endpoints: [`issues/${number}`] },
    };
  }

  override async observePullRequest(number: number): Promise<GitHubOperationalPullRequestEvidence> {
    return {
      repository: { host: "github.com", nameWithOwner: "acme/inari", repositoryId: "100" },
      number,
      title: "Observed PR",
      body: "body",
      state: "open",
      author: { login: "octocat" },
      head: { ref: "feat/observe", sha: "head" },
      base: { ref: "main", sha: "base" },
      mergeable: null,
      mergeState: null,
      reviewDecision: "APPROVED",
      labels: [],
      assignees: [],
      url: `https://github.com/acme/inari/pull/${number}`,
      checks: collection(),
      requiredCheckBindings: collection(),
      reviews: collection(),
      comments: collection(),
      inlineReviewComments: collection(),
      changedFiles: collection(),
      provenance: { provider: "github", endpoints: [`pulls/${number}`] },
    };
  }
}

test("MCP Issue and PR observation expose the same versioned Core fields", async () => {
  const adapter = new McpOperationalAdapter();
  const server = createInariMcpServer({ adapter });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "operational-observation", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const issue = (await client.callTool({ name: "inari_issue_observe", arguments: { number: 7 } }))
      .structuredContent as Record<string, unknown>;
    const pullRequest = (await client.callTool({ name: "inari_pr_observe", arguments: { number: 8 } }))
      .structuredContent as Record<string, unknown>;
    assert.equal(issue.valid, true);
    assert.equal(pullRequest.valid, true);
    assert.equal(issue.version, 1);
    assert.equal(pullRequest.version, 1);
    assert.equal((issue.observed as Record<string, unknown>).body, "body");
    assert.equal((pullRequest.observed as Record<string, unknown>).reviewDecision, "approved");
    assert.equal((pullRequest.observed as Record<string, unknown>).mergeability, "unknown");

    const view = (await client.callTool({ name: "inari_issue_view", arguments: { number: 7 } }))
      .structuredContent as Record<string, unknown>;
    assert.equal(view.valid, true);
    assert.equal(view.operation, "issue.view");
    assert.equal(view.url, "https://github.com/acme/inari/issues/7");
    assert.equal((view.observed as Record<string, unknown>).body, "body");
    assert.equal((view.semantic as Record<string, unknown>).status, "no-matching-template");
    assert.equal(composedViewOutputSchema.safeParse(view).success, true);

    const pullRequestView = (await client.callTool({ name: "inari_pr_view", arguments: { number: 8 } }))
      .structuredContent as Record<string, unknown>;
    assert.equal(pullRequestView.valid, true);
    assert.equal(pullRequestView.operation, "pr.view");
    assert.equal(pullRequestView.url, "https://github.com/acme/inari/pull/8");
    assert.equal(
      ((pullRequestView.observed as Record<string, unknown>).head as Record<string, unknown>).branch,
      "feat/observe",
    );
    assert.equal((pullRequestView.observed as Record<string, unknown>).body, "body");
    assert.deepEqual((pullRequestView.observed as Record<string, unknown>).base, { branch: "main", sha: "base" });
    assert.equal((pullRequestView.semantic as Record<string, unknown>).status, "no-matching-template");
    assert.equal(composedViewOutputSchema.safeParse(pullRequestView).success, true);
    assert.equal(adapter.issueReads, 0);
    assert.equal(adapter.pullRequestReads, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP composed-view schema accepts a provider failure without pretending semantic success", async () => {
  class FailingAdapter extends McpOperationalAdapter {
    override async observePullRequest(): Promise<GitHubOperationalPullRequestEvidence> {
      throw new GitHubApiError("pull_request.observe", "provider unavailable");
    }
  }
  const server = createInariMcpServer({ adapter: new FailingAdapter() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "operational-observation-failure", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const output = (await client.callTool({ name: "inari_pr_view", arguments: { number: 8 } }))
      .structuredContent as Record<string, unknown>;
    assert.equal(output.ok, false);
    assert.equal((output.semantic as Record<string, unknown>).status, "provider-failure");
    assert.equal(composedViewOutputSchema.safeParse(output).success, true);
  } finally {
    await client.close();
    await server.close();
  }
});
