import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCli } from "./cli.js";
import { createInariMcpServer } from "./mcp/server.js";
import { GitHubAdapter, type GitHubPullRequest, type RepositoryContext } from "./github/index.js";
import type {
  SemanticPullRequestMutationExecutionPort,
  SemanticPullRequestMutationExecutionRequest,
  SemanticPullRequestMutationPlan,
  SemanticPullRequestMutationResult,
} from "./semantic-pr-mutation.js";

const context: RepositoryContext = {
  hostname: "github.com",
  host: "github.com",
  owner: "acme",
  name: "inari",
  nameWithOwner: "acme/inari",
  url: "https://github.com/acme/inari",
  repositoryId: "42",
};

const current: GitHubPullRequest = {
  number: 521,
  title: "Govern PR mutations",
  body: "",
  state: "open",
  url: "https://github.com/acme/inari/pull/521",
  draft: false,
  head: "feat/521-govern-pr-mutations",
  headSha: "head-521",
  base: "main",
};

class ContextAdapter extends GitHubAdapter {
  constructor() {
    super({ repository: context.nameWithOwner });
  }

  override async getRepositoryContext(): Promise<RepositoryContext> {
    return context;
  }
}

class CaptureExecutor implements SemanticPullRequestMutationExecutionPort {
  readonly requests: SemanticPullRequestMutationExecutionRequest[] = [];

  async execute(request: SemanticPullRequestMutationExecutionRequest): Promise<SemanticPullRequestMutationResult> {
    this.requests.push(request);
    const plan = request.plan as SemanticPullRequestMutationPlan;
    return {
      version: "1",
      operation: plan.operation,
      outcome: "succeeded",
      plan,
      evidence: {
        version: "1",
        operation: plan.operation,
        outcome: "succeeded",
        effect: "succeeded",
        verified: true,
        postcondition: plan.operation === "merge" ? "merged" : "recorded",
      },
      current,
    };
  }
}

async function captureCli(
  argv: string[],
  dependencies: Parameters<typeof runCli>[1],
): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(argv, dependencies);
    assert.equal(exitCode, 0);
    return JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  } finally {
    console.log = originalLog;
  }
}

test("CLI and MCP expose the same governed PR mutation plan boundary", async () => {
  const adapter = new ContextAdapter();
  const cliExecutor = new CaptureExecutor();
  const cli = await captureCli(
    ["pr", "review", "521", "--expected-head", "head-521", "--intent", "approve", "--body", "LGTM", "--json"],
    { createAdapter: () => adapter, semanticPullRequestMutationExecutor: cliExecutor },
  );
  const cliPlan = cli.plan as Record<string, unknown>;
  const cliRequest = cliPlan.request as Record<string, unknown>;
  assert.equal(cli.operation, "pr.review");
  assert.deepEqual(
    {
      expectedHead: cliRequest.expectedHead,
      intent: cliRequest.intent,
      body: cliRequest.body,
      retry: cliRequest.retry,
    },
    { expectedHead: "head-521", intent: "approve", body: "LGTM", retry: "reject-duplicate" },
  );

  const mcpExecutor = new CaptureExecutor();
  const server = createInariMcpServer({ adapter, semanticPullRequestMutationExecutor: mcpExecutor });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inari-pr-mutation-surface-test", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "inari_pr_review",
      arguments: { number: 521, expectedHead: "head-521", intent: "approve", body: "LGTM" },
    });
    assert.equal(response.isError, undefined);
    const content = response.structuredContent as Record<string, unknown>;
    assert.equal(content.operation, "pr.review");
    const mcpPlan = content.plan as Record<string, unknown>;
    const mcpRequest = mcpPlan.request as Record<string, unknown>;
    assert.deepEqual(
      {
        expectedHead: mcpRequest.expectedHead,
        intent: mcpRequest.intent,
        body: mcpRequest.body,
        retry: mcpRequest.retry,
      },
      { expectedHead: "head-521", intent: "approve", body: "LGTM", retry: "reject-duplicate" },
    );
  } finally {
    await client.close();
    await server.close();
  }
});
