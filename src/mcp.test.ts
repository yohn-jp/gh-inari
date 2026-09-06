import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createInariMcpServer } from "./mcp/server.js";
import { GitHubAdapter, type GhCommandResult, type GhTransport, type GhTransportOptions } from "./github/index.js";

function command(stdout = "", exitCode = 0, stderr = ""): GhCommandResult {
  return { stdout, exitCode, stderr };
}

function blobResponse(sha: string, source: string): GhCommandResult {
  return command(
    JSON.stringify({
      sha,
      encoding: "base64",
      content: Buffer.from(source, "utf8").toString("base64"),
    }),
  );
}

class SemanticPrTransport implements GhTransport {
  readonly calls: string[][] = [];
  private readonly responses: GhCommandResult[];

  constructor(source: string) {
    this.responses = [
      command("gh version 2.0"),
      command(),
      command("100000200\n"),
      command(JSON.stringify({ default_branch: "main" })),
      command(
        JSON.stringify({
          sha: "tree-sha-semantic-mcp",
          truncated: false,
          tree: [{ path: ".github/inari/pull-requests/default.json", type: "blob", sha: "canon-sha" }],
        }),
      ),
      blobResponse("canon-sha", source),
    ];
  }

  async run(args: readonly string[], _options?: GhTransportOptions): Promise<GhCommandResult> {
    this.calls.push([...args]);
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    return response;
  }
}

const derivedCanon = JSON.stringify({
  version: "1",
  kind: "pull_request",
  id: "default",
  properties: {
    title: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "format", template: "{type}: {slug}" } },
    },
    head: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "format", template: "{type}/{slug}" } },
    },
    base: { presence: "required", authority: { kind: "fixed", value: "main" } },
    type: {
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { values: ["feat", "fix"] },
    },
    implements: { presence: "required", authority: { kind: "supplied" } },
  },
  fields: [
    { id: "summary", primitive: "text", presence: "required", authority: { kind: "supplied" } },
    {
      id: "slug",
      primitive: "text",
      presence: "required",
      authority: { kind: "derived", derive: { op: "slug", from: "summary" } },
    },
  ],
});

const issueReference = {
  repositoryHost: "github.com",
  repositoryId: "100000200",
  repository: "acme/repository-b",
  number: 285,
};

function createAdapterFactory(
  source: string,
  transports: SemanticPrTransport[],
): (options: ConstructorParameters<typeof GitHubAdapter>[0]) => GitHubAdapter {
  return (options) => {
    const transport = new SemanticPrTransport(source);
    transports.push(transport);
    return new GitHubAdapter({ ...options, transport });
  };
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function structuredContent(value: unknown): Record<string, unknown> {
  return record(value);
}

async function withClient<T>(callback: (client: Client, transports: SemanticPrTransport[]) => Promise<T>): Promise<T> {
  const transports: SemanticPrTransport[] = [];
  const factory = createAdapterFactory(derivedCanon, transports);
  const server = createInariMcpServer({ repository: "acme/repository-b", createAdapter: factory });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inari-mcp-test", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await callback(client, transports);
  } finally {
    await client.close();
    await server.close();
  }
}

test("native MCP exposes one transport-neutral typed semantic PR catalog", async () => {
  await withClient(async (client) => {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["inari_pr_contract", "inari_pr_materialize", "inari_pr_plan"].sort(),
    );
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations?.destructiveHint, false, tool.name);
      assert.ok(tool.outputSchema, tool.name);
    }
  });
});

test("MCP semantic tools call Core directly and preserve contract, artifact, and plan results", async () => {
  await withClient(async (client, transports) => {
    const contract = await client.callTool({
      name: "inari_pr_contract",
      arguments: { capabilities: ["github.pull_request.implements.closing-reference"] },
    });
    assert.equal(contract.isError, undefined);
    const contractContent = structuredContent(contract.structuredContent);
    const effectiveContract = record(contractContent.effectiveContract);
    assert.equal(contractContent.ok, true);
    assert.equal(effectiveContract.kind, "pull_request");
    assert.deepEqual(effectiveContract.capabilities, ["github.pull_request.implements.closing-reference"]);

    const input = {
      type: "feat",
      implements: [issueReference],
      summary: "Native MCP semantic PR",
    };
    const materialized = await client.callTool({
      name: "inari_pr_materialize",
      arguments: { capabilities: ["github.pull_request.implements.closing-reference"], input },
    });
    assert.equal(materialized.isError, undefined);
    const materializedContent = structuredContent(materialized.structuredContent);
    const materializedArtifact = record(materializedContent.artifact);
    const materializedValues = record(materializedArtifact.values);
    assert.equal(materializedContent.valid, true);
    assert.equal(materializedValues.title, "feat: native-mcp-semantic-pr");

    const planned = await client.callTool({
      name: "inari_pr_plan",
      arguments: { capabilities: ["github.pull_request.implements.closing-reference"], input },
    });
    assert.equal(planned.isError, undefined);
    const plannedContent = structuredContent(planned.structuredContent);
    const plannedPlan = record(plannedContent.plan);
    const plannedDesired = record(plannedPlan.desired);
    assert.equal(plannedContent.valid, true);
    assert.equal(plannedContent.preview, true);
    assert.equal(plannedContent.mutation, false);
    assert.equal(plannedDesired.head, "feat/native-mcp-semantic-pr");

    assert.equal(transports.length, 3);
    assert.ok(transports.every((transport) => transport.calls.every((args) => !args.includes("inari"))));
  });
});

test("MCP preserves bounded Core diagnostics and rejects derived-value overrides", async () => {
  await withClient(async (client) => {
    const invalid = await client.callTool({
      name: "inari_pr_materialize",
      arguments: {
        input: {
          type: "feat",
          implements: [issueReference],
          summary: "Native MCP semantic PR",
          title: "caller override",
        },
      },
    });
    assert.equal(invalid.isError, undefined);
    const invalidContent = structuredContent(invalid.structuredContent);
    const diagnostics = invalidContent.diagnostics as unknown[];
    assert.equal(invalidContent.ok, false);
    assert.equal(invalidContent.phase, "materialization");
    assert.equal(record(diagnostics[0]).code, "INPUT_AUTHORITY");

    const malformed = await client.callTool({
      name: "inari_pr_contract",
      arguments: { unexpected: true },
    });
    assert.equal(malformed.isError, true);
  });
});
