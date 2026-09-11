import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createInariMcpServer } from "./mcp/server.js";
import { GitHubAdapter, type GhCommandResult, type GhTransport, type GhTransportOptions } from "./github/index.js";
import { ChangeRemoteExecutorError } from "./change-executor.js";

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

  constructor(source: string, sourcePath = ".github/inari/pull-requests/default.json") {
    this.responses = [
      command("gh version 2.0"),
      command(),
      command("100000200\n"),
      command(JSON.stringify({ default_branch: "main" })),
      command(
        JSON.stringify({
          sha: "tree-sha-semantic-mcp",
          truncated: false,
          tree: [{ path: sourcePath, type: "blob", sha: "canon-sha" }],
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

class SemanticObservationTransport implements GhTransport {
  readonly calls: string[][] = [];
  private readonly responses: GhCommandResult[];

  constructor(kind: "issue" | "branch" | "pull_request", source: string) {
    const resource =
      kind === "issue"
        ? {
            number: 42,
            title: "MCP Issue",
            body: "Issue through Core",
            state: "open",
            html_url: "https://github.com/acme/repository-b/issues/42",
            labels: [],
            assignees: [],
            milestone: null,
          }
        : kind === "pull_request"
          ? {
              number: 43,
              title: "feat: native-mcp-semantic-pr",
              body: "Closes #285",
              state: "open",
              html_url: "https://github.com/acme/repository-b/pull/43",
              draft: false,
              maintainer_can_modify: true,
              head: { ref: "feat/native-mcp-semantic-pr" },
              base: { ref: "main" },
              labels: [],
              assignees: [],
              milestone: null,
            }
          : {
              ref: "refs/heads/feat/mcp",
              object: { type: "commit", sha: "a".repeat(40) },
            };
    this.responses = [
      command("gh version 2.0"),
      command(),
      command("100000200\n"),
      command(JSON.stringify({ default_branch: "main" })),
      command(
        JSON.stringify({
          sha: "tree-sha-semantic-observation-mcp",
          truncated: false,
          tree: [
            {
              path:
                kind === "issue"
                  ? ".github/inari/issues/default.json"
                  : kind === "branch"
                    ? ".github/inari/branches/default.json"
                    : ".github/inari/pull-requests/default.json",
              type: "blob",
              sha: "canon-sha",
            },
          ],
        }),
      ),
      blobResponse("canon-sha", source),
      kind === "branch"
        ? command(`HTTP/1.1 200 OK\ncontent-type: application/json\n\n${JSON.stringify(resource)}`)
        : command(JSON.stringify(resource)),
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

const semanticIssueCanon = JSON.stringify({
  version: "1",
  kind: "issue",
  id: "default",
  properties: {
    title: { presence: "required", authority: { kind: "supplied" } },
  },
  fields: [{ id: "summary", primitive: "text", presence: "required", authority: { kind: "supplied" } }],
});

const semanticBranchCanon = JSON.stringify({
  version: "1",
  kind: "branch",
  id: "default",
  properties: {
    name: { presence: "required", authority: { kind: "supplied" } },
    source: { presence: "required", authority: { kind: "fixed", value: "main" } },
  },
});

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
      [
        "inari_issue_contract",
        "inari_issue_materialize",
        "inari_issue_plan",
        "inari_issue_observe",
        "inari_issue_drift",
        "inari_branch_contract",
        "inari_branch_materialize",
        "inari_branch_plan",
        "inari_branch_observe",
        "inari_branch_drift",
        "inari_pr_contract",
        "inari_pr_materialize",
        "inari_pr_plan",
        "inari_pr_observe",
        "inari_pr_drift",
        "inari_change_handoff",
      ].sort(),
    );
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations?.destructiveHint, false, tool.name);
      assert.ok(tool.outputSchema, tool.name);
    }
  });
});

function changeHandoffProjection(draft = true): Record<string, unknown> {
  const branch = "feat/42-canonical-change";
  return {
    valid: true,
    status: "healthy",
    canonicalBranch: branch,
    canonicalBaseBranch: "main",
    candidates: {
      branches: [{ candidate: { name: branch }, classification: "canonical", reason: "canonical" }],
      pullRequests: [
        {
          candidate: { number: 142, head: branch, base: "main", state: "open", draft, merged: false },
          classification: "canonical",
          reason: "canonical",
        },
      ],
    },
    change: {
      version: 1,
      identity: { repositoryHost: "github.com", repositoryId: "100000219", rootIssue: 42 },
      state: draft ? "DRAFT" : "REVIEW",
      provenance: {},
      projection: { branch, pullRequest: 142 },
    },
    diagnostics: [],
  };
}

test("native MCP exposes the canonical implementation handoff through the Change read boundary", async () => {
  const calls: string[] = [];
  const server = createInariMcpServer({
    changeExecutor: {
      async execute() {
        throw new Error("handoff must not mutate");
      },
      async read(request) {
        calls.push(request.operation);
        return changeHandoffProjection() as never;
      },
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inari-mcp-change-test", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const handoff = await client.callTool({ name: "inari_change_handoff", arguments: { issue: 42 } });
    const content = structuredContent(handoff.structuredContent);
    assert.equal(handoff.isError, undefined);
    assert.equal(content.ok, true);
    assert.deepEqual(content.handoff, {
      version: 1,
      kind: "implementation-handoff",
      repositoryHost: "github.com",
      repositoryId: "100000219",
      rootIssue: 42,
      changeVersion: 1,
      state: "DRAFT",
      branch: "feat/42-canonical-change",
      baseBranch: "main",
      pullRequest: 142,
    });
    assert.deepEqual(calls, ["show"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("native MCP implementation handoff fails closed for REVIEW evidence", async () => {
  const server = createInariMcpServer({
    changeExecutor: {
      async execute() {
        throw new Error("handoff must not mutate");
      },
      async read() {
        return changeHandoffProjection(false) as never;
      },
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inari-mcp-change-review-test", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const handoff = await client.callTool({ name: "inari_change_handoff", arguments: { issue: 42 } });
    const content = structuredContent(handoff.structuredContent);
    assert.equal(content.ok, false);
    assert.equal(content.handoff, undefined);
    assert.ok(Array.isArray(content.diagnostics));
  } finally {
    await client.close();
    await server.close();
  }
});

test("native MCP implementation handoff preserves bounded Change read diagnostics", async () => {
  const server = createInariMcpServer({
    changeExecutor: {
      async execute() {
        throw new Error("handoff must not mutate");
      },
      async read() {
        throw new ChangeRemoteExecutorError(
          "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE",
          "The Change read executor is unavailable.",
          undefined,
          [
            {
              version: 1,
              code: "CHANGE_PROJECTION_EVIDENCE_UNAVAILABLE",
              path: "$.evidence",
              message: "Evidence read is unavailable.",
            },
          ],
        );
      },
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inari-mcp-change-unavailable-test", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const handoff = await client.callTool({ name: "inari_change_handoff", arguments: { issue: 42 } });
    const content = structuredContent(handoff.structuredContent);
    assert.equal(content.ok, false);
    assert.deepEqual(content.diagnostics, [
      {
        version: 1,
        code: "CHANGE_PROJECTION_EVIDENCE_UNAVAILABLE",
        path: "$.evidence",
        message: "Evidence read is unavailable.",
      },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
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

test("native MCP exposes Issue and Branch catalogs through the same Core boundaries", async () => {
  const transports: SemanticPrTransport[] = [];
  const server = createInariMcpServer({
    repository: "acme/repository-b",
    createAdapter: (options) => {
      const sourcePath =
        transports.length < 2 ? ".github/inari/issues/default.json" : ".github/inari/branches/default.json";
      const source = transports.length < 2 ? semanticIssueCanon : semanticBranchCanon;
      const transport = new SemanticPrTransport(source, sourcePath);
      transports.push(transport);
      return new GitHubAdapter({ ...options, transport });
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inari-mcp-artifacts-test", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const issueContract = await client.callTool({ name: "inari_issue_contract", arguments: {} });
    assert.equal(record(issueContract.structuredContent).kind, "issue");
    const issuePlan = await client.callTool({
      name: "inari_issue_plan",
      arguments: { input: { title: "MCP Issue", summary: "Issue through Core" } },
    });
    const issuePlanContent = structuredContent(issuePlan.structuredContent);
    assert.equal(issuePlanContent.valid, true);
    assert.equal(issuePlanContent.mutation, false);

    const branchContract = await client.callTool({ name: "inari_branch_contract", arguments: {} });
    assert.equal(record(branchContract.structuredContent).kind, "branch");
    const branchPlan = await client.callTool({
      name: "inari_branch_plan",
      arguments: { input: { name: "feat/mcp" } },
    });
    const branchPlanContent = structuredContent(branchPlan.structuredContent);
    assert.equal(branchPlanContent.valid, true);
    assert.equal(branchPlanContent.mutation, false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("native MCP exposes bounded observation tools for Issue, Branch, and PR", async () => {
  const sources = { issue: semanticIssueCanon, branch: semanticBranchCanon, pull_request: derivedCanon } as const;
  const transports: SemanticObservationTransport[] = [];
  const server = createInariMcpServer({
    repository: "acme/repository-b",
    createAdapter: (options) => {
      const kind = transports.length === 0 ? "issue" : transports.length === 1 ? "branch" : "pull_request";
      const transport = new SemanticObservationTransport(kind, sources[kind]);
      transports.push(transport);
      return new GitHubAdapter({ ...options, transport });
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inari-mcp-observation-test", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const issue = await client.callTool({ name: "inari_issue_observe", arguments: { number: 42 } });
    assert.equal(record(issue.structuredContent).valid, true);
    assert.equal(record(issue.structuredContent).kind, undefined);
    assert.equal(record(record(issue.structuredContent).observed).kind, "issue");

    const branch = await client.callTool({
      name: "inari_branch_observe",
      arguments: { name: "feat/mcp", source: "main" },
    });
    assert.equal(record(branch.structuredContent).valid, true);
    assert.equal(record(record(branch.structuredContent).observed).kind, "branch");

    const pullRequest = await client.callTool({ name: "inari_pr_observe", arguments: { number: 43 } });
    assert.equal(record(pullRequest.structuredContent).valid, true);
    assert.equal(record(record(pullRequest.structuredContent).observed).kind, "pull_request");

    assert.equal(transports.length, 3);
    assert.ok(transports.every((transport) => transport.calls.every((args) => !args.includes("POST"))));
  } finally {
    await client.close();
    await server.close();
  }
});
