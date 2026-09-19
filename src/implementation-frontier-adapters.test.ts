import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCli } from "./cli-core.js";
import { projectChangeFromGitHubEvidence } from "./change.js";
import type { GitHubAdapter } from "./github/adapter.js";
import { tryProjectImplementationFrontier } from "./implementation-frontier.js";
import { createInariMcpServer } from "./mcp/server.js";

function frontierInput(): Record<string, unknown> {
  return { candidates: [] };
}

test("CLI and MCP expose the exact same Core Implementation Frontier projection", async () => {
  const input = frontierInput();
  const core = tryProjectImplementationFrontier(input);
  assert.equal(core.valid, true);
  assert.deepEqual(core.projection?.candidates, []);

  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-frontier-adapters-"));
  const inputPath = path.join(directory, "frontier.json");
  await writeFile(inputPath, JSON.stringify(input), "utf8");
  const lines: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (line: string) => lines.push(line);
    assert.equal(await runCli(["impl", "frontier", "--from", inputPath, "--json"]), 0);
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(lines.length, 1);
  const cli = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.deepEqual(cli.frontier, core.projection);

  const server = createInariMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "implementation-frontier", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "inari_impl_frontier",
      arguments: { frontier: input },
    });
    const structured = response.structuredContent as Record<string, unknown>;
    assert.deepEqual(structured.frontier, core.projection);
    assert.deepEqual(structured.frontier, cli.frontier);
  } finally {
    await client.close();
    await server.close();
  }
});

test("CLI and MCP share the repository-backed starting-Issue composition", async () => {
  const calls: string[] = [];
  const change = projectChangeFromGitHubEvidence({
    change: { repositoryHost: "github.com", repositoryId: "700", rootIssue: 1 },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "frontier" },
    baseBranch: "main",
    evidence: {
      issue: { status: "available", value: { number: 1, state: "open" } },
      branches: { status: "absent" },
      pullRequests: { status: "absent" },
    },
  });
  assert.equal(change.valid, true);
  const issue = {
    number: 1,
    title: "feat: frontier",
    body: "",
    state: "open" as const,
    url: "https://github.com/acme/frontier/issues/1",
    labels: [],
    assignees: [],
  };
  const adapter = {
    getRepositoryContext: async () => ({
      hostname: "github.com",
      host: "github.com",
      owner: "acme",
      name: "frontier",
      nameWithOwner: "acme/frontier",
      url: "https://github.com/acme/frontier",
      repositoryId: "700",
    }),
    getIssue: async (number: number) => {
      calls.push(`issue:${number}`);
      return issue;
    },
    requestRepositoryApi: async (path: string) => {
      calls.push(`relation:${path}`);
      return { status: 404, body: [] };
    },
    findBranch: async () => undefined,
    observePullRequest: async () => {
      throw new Error("unexpected pull-request read");
    },
  } as unknown as GitHubAdapter;
  const changeExecutor = {
    execute: async () => change,
    read: async () => change,
  };

  const lines: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (line: string) => lines.push(line);
    assert.equal(
      await runCli(["impl", "frontier", "1", "--json"], {
        createAdapter: () => adapter,
        changeExecutor,
      }),
      0,
    );
  } finally {
    console.log = originalLog;
  }
  const cli = JSON.parse(lines[0] as string) as Record<string, unknown>;

  const server = createInariMcpServer({ adapter, changeExecutor });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "implementation-frontier-repository", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "inari_impl_frontier",
      arguments: { issue: 1 },
    });
    const structured = response.structuredContent as Record<string, unknown>;
    assert.deepEqual(structured.frontier, cli.frontier);
    assert.equal(structured.valid, true);
  } finally {
    await client.close();
    await server.close();
  }
  assert.deepEqual(
    calls.filter((call) => call === "issue:1"),
    ["issue:1", "issue:1"],
  );
  assert.equal(calls.filter((call) => call.startsWith("relation:")).length, 2);
});
