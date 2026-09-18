import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { test } from "node:test";
import { createInariMcpServer } from "./mcp/server.js";
import { GitHubAdapter, type RepositoryContext } from "./github/index.js";

const context: RepositoryContext = {
  hostname: "github.com",
  host: "github.com",
  owner: "acme",
  name: "inari",
  nameWithOwner: "acme/inari",
  url: "https://github.com/acme/inari",
  repositoryId: "100",
};

class McpDiscoveryAdapter extends GitHubAdapter {
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
      ],
      pagination: { page: options?.page ?? 1, limit: options?.limit ?? 30, returned: 1, truncated: false },
      provenance: { provider: "github" as const, endpoints: ["issues"] },
    };
  }
}

test("MCP exposes the same versioned Core Issue discovery result", async () => {
  const server = createInariMcpServer({ adapter: new McpDiscoveryAdapter() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "operational-discovery", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = (
      await client.callTool({
        name: "inari_issue_list",
        arguments: { state: "closed", page: 2, limit: 5 },
      })
    ).structuredContent as Record<string, unknown>;
    assert.equal(response.operation, "issue.list");
    assert.equal(response.version, 1);
    const discovered = response.discovered as Record<string, unknown>;
    assert.deepEqual(discovered.filters, { state: "closed", page: 2, limit: 5 });
    assert.equal((discovered.items as readonly Record<string, unknown>[])[0]?.number, 7);
  } finally {
    await client.close();
    await server.close();
  }
});
