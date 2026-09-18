import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCli } from "./cli-core.js";
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
