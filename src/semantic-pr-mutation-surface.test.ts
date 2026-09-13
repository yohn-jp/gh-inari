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
import type { CapabilityAuthorizedSessionExecutor } from "./session-authorized-change-executor.js";

const sessionExecutor: CapabilityAuthorizedSessionExecutor = {
  execute: async () => {
    throw new Error("not used by this test");
  },
};

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

test("CLI exposes the governed PR mutation plan boundary", async () => {
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
});

test("MCP does not expose governed PR comment/review/merge writes, with or without a Session executor", async () => {
  const adapter = new ContextAdapter();
  for (const options of [{ adapter }, { adapter, sessionExecutor }]) {
    const server = createInariMcpServer(options);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "inari-pr-mutation-surface-test", version: "1" }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      for (const mutationTool of ["inari_pr_comment", "inari_pr_review", "inari_pr_merge"]) {
        assert.ok(!names.includes(mutationTool), mutationTool);
      }
    } finally {
      await client.close();
      await server.close();
    }
  }
});
