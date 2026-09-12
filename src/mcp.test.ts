import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createInariMcpServer } from "./mcp/server.js";
import { GitHubAdapter, type GhCommandResult, type GhTransport, type GhTransportOptions } from "./github/index.js";
import { ChangeRemoteExecutorError, type ChangeRemoteExecutionResult } from "./change-executor.js";
import { tryProjectGoldenPathEntry } from "./golden-path-entry.js";
import { projectGoldenPathRecovery } from "./golden-path-recovery.js";
import { projectGoldenPathStatus, type GoldenPathStatusInput } from "./golden-path-status.js";
import {
  absentEvidenceInput,
  createGoldenPathActors,
  draftEvidenceInput,
  mutationRequest,
} from "./golden-path-status/fixtures.js";

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

const goldenPathScope = {
  environment: { status: "available", verified: true },
  governance: {
    status: "available",
    valid: true,
    repositoryHost: "github.com",
    repositoryId: "411000001",
  },
  issue: { status: "present", governed: true, number: 411, state: "open" },
  subject: { repositoryHost: "github.com", repositoryId: "411000001", rootIssue: 411 },
} as const;

function goldenPathInput(
  result: ChangeRemoteExecutionResult,
  extras: Record<string, unknown> = {},
): GoldenPathStatusInput {
  return {
    ...goldenPathScope,
    changeProjection: result.projection,
    ...(result.evidence === undefined ? {} : { execution: { outcome: result.evidence.outcome } }),
    ...extras,
  };
}

function goldenPathEnvelope(value: Record<string, unknown>): Record<string, unknown> {
  return {
    version: value.version,
    ...(value.subject === undefined ? {} : { subject: value.subject }),
    status: value.status,
    nextAction: value.nextAction,
    recovery: value.recovery,
    diagnostics: value.diagnostics,
  };
}

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
        "inari_golden_path_status",
        "inari_issue_contract",
        "inari_issue_materialize",
        "inari_issue_plan",
        "inari_issue_observe",
        "inari_issue_drift",
        "inari_issue_relations_plan",
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
        "inari_golden_path_entry",
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

test("native MCP exposes the shared Golden Path entry/action projection read-only", async () => {
  const calls: string[] = [];
  let mutations = 0;
  const projection = changeHandoffProjection();
  const expected = tryProjectGoldenPathEntry({ projection, requireGovernedIssue: false });
  const server = createInariMcpServer({
    changeExecutor: {
      async execute() {
        mutations += 1;
        throw new Error("Golden Path entry must not mutate");
      },
      async read(request) {
        calls.push(request.operation);
        return projection as never;
      },
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inari-mcp-golden-path-entry-test", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "inari_golden_path_entry",
      arguments: { issue: 42 },
    });
    const content = structuredContent(response.structuredContent);
    assert.equal(response.isError, undefined);
    assert.equal(content.ok, true);
    assert.equal(content.valid, true);
    assert.equal(content.preview, true);
    assert.equal(content.mutation, false);
    assert.deepEqual(content.entry, expected);
    assert.deepEqual(record(record(content.entry).action), {
      operation: "change.issue",
      issue: 42,
      mode: "return-existing",
    });
    assert.deepEqual(calls, ["show"]);
    assert.equal(mutations, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("native MCP Golden Path entry fails closed for an absent Change", async () => {
  const server = createInariMcpServer({
    changeExecutor: {
      async execute() {
        throw new Error("Golden Path entry must not mutate");
      },
      async read() {
        return {
          valid: true,
          status: "absent",
          canonicalBranch: "feat/42-canonical-change",
          canonicalBaseBranch: "main",
          candidates: { branches: [], pullRequests: [] },
          change: {
            version: 1,
            identity: { repositoryHost: "github.com", repositoryId: "100000219", rootIssue: 42 },
            state: "DEFINED",
            provenance: {},
          },
          diagnostics: [],
        } as never;
      },
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inari-mcp-golden-path-entry-absent-test", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "inari_golden_path_entry",
      arguments: { issue: 42 },
    });
    const content = structuredContent(response.structuredContent);
    const entry = record(content.entry);
    assert.equal(content.ok, false);
    assert.equal(content.valid, false);
    assert.equal(entry.action, undefined);
    assert.ok(
      (entry.diagnostics as unknown[]).some(
        (diagnostic) => record(diagnostic).code === "GOLDEN_PATH_GOVERNED_ISSUE_REQUIRED",
      ),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

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

test("native MCP implementation handoff includes the repository locator when an adapter is available", async () => {
  const server = createInariMcpServer({
    changeExecutor: {
      async execute() {
        throw new Error("handoff must not mutate");
      },
      async read() {
        return changeHandoffProjection() as never;
      },
    },
    createAdapter: () =>
      ({
        async getRepositoryContext() {
          return {
            hostname: "github.com",
            host: "github.com",
            owner: "acme",
            name: "inari",
            nameWithOwner: "acme/inari",
            url: "https://github.com/acme/inari",
            repositoryId: "100000219",
          };
        },
      }) as never,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inari-mcp-change-test", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const handoff = await client.callTool({ name: "inari_change_handoff", arguments: { issue: 42 } });
    const content = structuredContent(handoff.structuredContent);
    assert.equal(content.ok, true);
    assert.equal((content.handoff as Record<string, unknown> | undefined)?.repositoryNameWithOwner, "acme/inari");
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

test("MCP Golden Path status preserves the canonical normal projection", async () => {
  await withClient(async (client, transports) => {
    const actors = createGoldenPathActors(draftEvidenceInput());
    const execution = await actors.executor.execute(mutationRequest("ready"));
    const input = goldenPathInput(execution, { review: { status: "required", action: "review" } });
    const expected = projectGoldenPathStatus(input);

    const response = await client.callTool({
      name: "inari_golden_path_status",
      arguments: { input, recoveryInput: execution },
    });
    assert.equal(response.isError, undefined);
    const content = structuredContent(response.structuredContent);
    assert.equal(content.ok, true);
    assert.equal(content.valid, true);
    assert.deepEqual(goldenPathEnvelope(content), expected);
    assert.deepEqual(content.status, {
      phase: "REVIEW",
      availability: "actionable",
      changeState: "REVIEW",
      projectionStatus: "healthy",
      executionOutcome: "verified",
    });
    assert.deepEqual(content.nextAction, {
      kind: "REVIEW",
      owner: "repository",
      reasonCode: "REVIEW_ADMITTED",
    });
    assert.equal(content.recovery, null);
    assert.equal(transports.length, 0, "Golden Path projection must not construct a GitHub adapter");
  });
});

test("MCP Golden Path status preserves the canonical recovery projection", async () => {
  await withClient(async (client, transports) => {
    const actors = createGoldenPathActors(absentEvidenceInput(), {
      failEffect: "CREATE_PULL_REQUEST",
      applyFailedEffect: true,
    });
    const execution = await actors.executor.execute(mutationRequest("issue"));
    const recovery = projectGoldenPathRecovery(execution);
    assert.ok(recovery);
    const input = goldenPathInput(execution);
    const expected = projectGoldenPathStatus({ ...input, recovery });

    const response = await client.callTool({
      name: "inari_golden_path_status",
      arguments: { input, recoveryInput: execution },
    });
    assert.equal(response.isError, undefined);
    const content = structuredContent(response.structuredContent);
    assert.equal(content.ok, true);
    assert.equal(content.valid, true);
    assert.deepEqual(goldenPathEnvelope(content), expected);
    assert.deepEqual(content.status, {
      phase: "RECOVERY",
      availability: "recovery-required",
      changeState: "RECOVERY_REQUIRED",
      projectionStatus: "partial",
      executionOutcome: "recovery-required",
    });
    assert.deepEqual(content.nextAction, {
      kind: "MANUAL_REVIEW",
      owner: "recovery",
      reasonCode: "MANUAL_RECOVERY_REVIEW_REQUIRED",
    });
    assert.deepEqual(content.recovery, recovery);
    assert.equal(transports.length, 0, "Golden Path projection must not construct a GitHub adapter");
  });
});

test("MCP Golden Path status fails closed without a Core-authorized recovery source", async () => {
  await withClient(async (client) => {
    const actors = createGoldenPathActors(absentEvidenceInput(), {
      failEffect: "CREATE_PULL_REQUEST",
      applyFailedEffect: true,
    });
    const execution = await actors.executor.execute(mutationRequest("issue"));
    const input = goldenPathInput(execution, {
      recovery: {
        class: "POST_EFFECT_VERIFICATION",
        safeAction: "RETRY",
        owner: "recovery",
        retryable: true,
        rereadRequired: true,
        automaticCleanup: "none",
        reasonCode: "IDEMPOTENT_RETRY",
      },
    });
    const expected = projectGoldenPathStatus({ ...input, recovery: null });

    const response = await client.callTool({
      name: "inari_golden_path_status",
      arguments: { input },
    });
    assert.equal(response.isError, undefined);
    const content = structuredContent(response.structuredContent);
    assert.equal(content.ok, true);
    assert.equal(content.valid, true);
    assert.deepEqual(goldenPathEnvelope(content), expected);
    assert.equal(record(content.status).availability, "blocked");
    assert.equal(content.nextAction, null);
    assert.equal(content.recovery, null);
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

const issueRelationsCanonSource = JSON.stringify({
  version: "1",
  kind: "issue",
  id: "default",
  properties: {
    title: { presence: "required", authority: { kind: "supplied" } },
    parent: { presence: "optional", authority: { kind: "supplied" } },
    dependsOn: { presence: "optional", authority: { kind: "supplied" } },
  },
  fields: [],
});

class IssueRelationsMcpTransport implements GhTransport {
  readonly calls: string[][] = [];
  private readonly responses: GhCommandResult[];

  constructor(responses: readonly GhCommandResult[]) {
    this.responses = [...responses];
  }

  async run(args: readonly string[], _options?: GhTransportOptions): Promise<GhCommandResult> {
    this.calls.push([...args]);
    if (args[0] === "--version") return command("gh version 2.0");
    if (args[0] === "auth" && args[1] === "status") return command();
    if (args.includes("--jq")) return command("100000900\n");
    if (args.includes("repos/acme/repository-b") && args.includes("GET"))
      return command(JSON.stringify({ default_branch: "main" }));
    if (args.some((value) => value.includes("git/trees/")))
      return command(
        JSON.stringify({
          sha: "tree-sha",
          truncated: false,
          tree: [{ path: ".github/inari/issues/default.json", type: "blob", sha: "canon-sha" }],
        }),
      );
    if (args.some((value) => value.includes("git/blobs/canon-sha")))
      return command(
        JSON.stringify({
          sha: "canon-sha",
          encoding: "base64",
          content: Buffer.from(issueRelationsCanonSource, "utf8").toString("base64"),
        }),
      );
    const path = args.find((value) => value.startsWith("repos/acme/repository-b")) ?? "";
    if (path.includes("/dependencies/blocked_by")) return command("HTTP/2 200 OK\n\n[]");
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    return response;
  }
}

test("native MCP previews an existing-Issue relationship plan without mutation", async () => {
  const transport = new IssueRelationsMcpTransport([command("HTTP/2 404 Not Found\n\n")]);
  const server = createInariMcpServer({
    repository: "acme/repository-b",
    createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inari-mcp-issue-relations-test", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const plan = await client.callTool({
      name: "inari_issue_relations_plan",
      arguments: {
        number: 701,
        desired: {
          parent: { repositoryHost: "github.com", repositoryId: "100000900", number: 20 },
          dependsOn: [],
        },
        graph: {
          scope: "complete",
          nodes: [
            { reference: { repositoryHost: "github.com", repositoryId: "100000900", number: 701 }, dependsOn: [] },
            { reference: { repositoryHost: "github.com", repositoryId: "100000900", number: 20 }, dependsOn: [] },
          ],
        },
        capabilities: ["github.issue.parent.native", "github.issue.blocked-by.native"],
      },
    });
    const content = structuredContent(plan.structuredContent);
    assert.equal(content.ok, true);
    assert.equal(content.mutation, false);
    assert.deepEqual(record(content.plan).effects, [
      {
        kind: "SET_PARENT_RELATION",
        parent: { repositoryHost: "github.com", repositoryId: "100000900", number: 20 },
      },
    ]);
    assert.ok(transport.calls.every((args) => !args.includes("POST")));
  } finally {
    await client.close();
    await server.close();
  }
});
