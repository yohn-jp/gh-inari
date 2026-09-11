import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhCommandResult, GhTransport, GhTransportOptions } from "./github/index.js";
import { GitHubAdapter } from "./github/index.js";
import {
  SemanticIssueRelationExecutor,
  SemanticIssueRelationExecutorError,
} from "./semantic-issue-relation-executor.js";
import { planSemanticIssueRelations } from "./semantic-issue-relations.js";

function command(stdout = "", exitCode = 0, stderr = ""): GhCommandResult {
  return { stdout, exitCode, stderr };
}

const capabilities = ["github.issue.blocked-by.native", "github.issue.parent.native"];
const context = { host: "github.com", repositoryId: "100", repository: "acme/inari" };

function issue(number: number) {
  return {
    repositoryHost: context.host,
    repositoryId: context.repositoryId,
    repository: context.repository,
    number,
  };
}

function relationIssue(number: number, id = number + 1000): string {
  return JSON.stringify({
    id,
    number,
    repository_url: "https://api.github.com/repos/acme/inari",
  });
}

class RelationTransport implements GhTransport {
  readonly calls: string[][] = [];
  readonly parentResponses: string[];

  constructor(parentResponses: readonly string[]) {
    this.parentResponses = [...parentResponses];
  }

  async run(args: readonly string[], _options?: GhTransportOptions): Promise<GhCommandResult> {
    this.calls.push([...args]);
    if (args[0] === "--version") return command("gh version 2.0");
    if (args[0] === "auth" && args[1] === "status") return command();
    if (args.includes("--jq")) return command("100\n");
    const path = args.find((value) => value.startsWith("repos/acme/inari")) ?? "";
    if (path.endsWith("/parent")) {
      const response = this.parentResponses.shift() ?? "HTTP/2 404 Not Found\n\n";
      return command(response);
    }
    if (path.includes("/dependencies/blocked_by")) return command("HTTP/2 200 OK\n\n[]");
    if (path.endsWith("/issues/10") && args.includes("GET"))
      return command(`HTTP/2 200 OK\n\n${relationIssue(10, 1010)}`);
    if (path.endsWith("/sub_issues") && args.includes("POST")) return command("HTTP/2 201 Created\n\n{}");
    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  }
}

function plan() {
  return planSemanticIssueRelations({
    subject: issue(10),
    desired: { parent: issue(20), dependsOn: [] },
    observed: { parent: undefined, dependsOn: [] },
    capabilities,
  });
}

test("relation executor observes, applies, rereads, and verifies a native parent effect", async () => {
  const transport = new RelationTransport(["HTTP/2 404 Not Found\n\n", `HTTP/2 200 OK\n\n${relationIssue(20)}`]);
  const executor = new SemanticIssueRelationExecutor({
    adapter: new GitHubAdapter({ repository: "acme/inari", transport }),
  });
  const result = await executor.execute({ version: "1", plan: plan() });
  assert.equal(result.evidence.outcome, "verified");
  assert.deepEqual(result.observed.parent, issue(20));
  assert.equal(result.evidence.effects[0]?.kind, "SET_PARENT_RELATION");
  assert.ok(transport.calls.some((args) => args.includes("POST")));
});

test("relation executor fails stale plans before applying an effect", async () => {
  const transport = new RelationTransport([`HTTP/2 200 OK\n\n${relationIssue(21)}`, "HTTP/2 200 OK\n\n[]"]);
  const executor = new SemanticIssueRelationExecutor({
    adapter: new GitHubAdapter({ repository: "acme/inari", transport }),
  });
  await assert.rejects(
    executor.execute({ version: "1", plan: plan() }),
    (error: unknown) =>
      error instanceof SemanticIssueRelationExecutorError && error.code === "SEMANTIC_ISSUE_RELATION_EXECUTION_STALE",
  );
  assert.equal(
    transport.calls.some((args) => args.includes("POST")),
    false,
  );
});
