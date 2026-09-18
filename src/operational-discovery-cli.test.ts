import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { GitHubAdapter, type GitHubOperationalDiscoveryPage, type RepositoryContext } from "./github/index.js";
import type { GitHubOperationalIssueSummary, GitHubOperationalPullRequestSummary } from "./github/types.js";

const context: RepositoryContext = {
  hostname: "github.com",
  host: "github.com",
  owner: "acme",
  name: "inari",
  nameWithOwner: "acme/inari",
  url: "https://github.com/acme/inari",
  repositoryId: "100",
};

class CliDiscoveryAdapter extends GitHubAdapter {
  override async resolveRepositoryContext(): Promise<RepositoryContext> {
    return context;
  }

  override async listOperationalIssues(options?: Parameters<GitHubAdapter["listOperationalIssues"]>[0]) {
    return {
      repository: { host: "github.com", nameWithOwner: "acme/inari", repositoryId: "100" },
      filters: { state: options?.state ?? "open", page: options?.page ?? 1, limit: options?.limit ?? 30 },
      items: [
        {
          repository: { host: "github.com", nameWithOwner: "acme/inari", repositoryId: "100" },
          number: 7,
          title: "Discovered Issue",
          state: "open" as const,
          author: { login: "octocat" },
          labels: [],
          assignees: [],
          url: "https://github.com/acme/inari/issues/7",
        },
      ] satisfies readonly GitHubOperationalIssueSummary[],
      pagination: { page: options?.page ?? 1, limit: options?.limit ?? 30, returned: 1, truncated: false },
      provenance: { provider: "github" as const, endpoints: ["issues"] },
    } satisfies GitHubOperationalDiscoveryPage<GitHubOperationalIssueSummary>;
  }

  override async listOperationalPullRequests(options?: Parameters<GitHubAdapter["listOperationalPullRequests"]>[0]) {
    return {
      repository: { host: "github.com", nameWithOwner: "acme/inari", repositoryId: "100" },
      filters: {
        state: options?.state ?? "open",
        ...(options?.head === undefined ? {} : { head: options.head }),
        ...(options?.base === undefined ? {} : { base: options.base }),
        page: options?.page ?? 1,
        limit: options?.limit ?? 30,
      },
      items: [
        {
          repository: { host: "github.com", nameWithOwner: "acme/inari", repositoryId: "100" },
          number: 8,
          title: "Discovered PR",
          state: "open" as const,
          author: { login: "octocat" },
          head: { ref: options?.head ?? "feat/discovery", sha: "head" },
          base: { ref: options?.base ?? "main", sha: "base" },
          draft: false,
          merged: false,
          labels: [],
          assignees: [],
          url: "https://github.com/acme/inari/pull/8",
        },
      ] satisfies readonly GitHubOperationalPullRequestSummary[],
      pagination: { page: options?.page ?? 1, limit: options?.limit ?? 30, returned: 1, truncated: false },
      provenance: { provider: "github" as const, endpoints: ["pulls"] },
    } satisfies GitHubOperationalDiscoveryPage<GitHubOperationalPullRequestSummary>;
  }
}

async function capture(argv: string[]): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const originalLog = console.log;
  let fallbackCalls = 0;
  try {
    console.log = (line: string) => lines.push(line);
    assert.equal(
      await runCli(argv, {
        createAdapter: () => new CliDiscoveryAdapter(),
        runGhFallback: () => {
          fallbackCalls += 1;
          throw new Error("raw gh fallback must never be reachable for owned discovery commands");
        },
      }),
      0,
      lines.join("\n"),
    );
  } finally {
    console.log = originalLog;
  }
  assert.equal(fallbackCalls, 0);
  return JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
}

test("CLI Issue list projects the versioned Core discovery result", async () => {
  const output = await capture(["issue", "list", "--state", "closed", "--limit", "2", "--page", "3", "--json"]);
  assert.equal(output.operation, "issue.list");
  assert.equal(output.version, 1);
  const discovered = output.discovered as Record<string, unknown>;
  assert.deepEqual(discovered.filters, { state: "closed", page: 3, limit: 2 });
  assert.equal((discovered.items as readonly Record<string, unknown>[])[0]?.number, 7);
});

test("CLI PR list passes exact head and base filters to the provider seam", async () => {
  const output = await capture([
    "pr",
    "list",
    "--state",
    "all",
    "--head",
    "feat/discovery",
    "--base",
    "main",
    "--json",
  ]);
  const discovered = output.discovered as Record<string, unknown>;
  assert.deepEqual(discovered.filters, {
    state: "all",
    head: "feat/discovery",
    base: "main",
    page: 1,
    limit: 30,
  });
});

test("owned Issue and PR discovery never reach the raw gh process fallback", async () => {
  await capture(["issue", "list", "--limit", "1", "--json"]);
  await capture(["pr", "list", "--limit", "1", "--json"]);
});
