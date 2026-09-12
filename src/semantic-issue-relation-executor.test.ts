import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { GhCommandResult, GhTransport, GhTransportOptions } from "./github/index.js";
import { GitHubAdapter } from "./github/index.js";
import {
  SemanticIssueRelationExecutor,
  SemanticIssueRelationExecutorError,
} from "./semantic-issue-relation-executor.js";
import { planSemanticIssueRelations } from "./semantic-issue-relations.js";
import type { ArtifactContractProvenance } from "./contract/ir.js";

function command(stdout = "", exitCode = 0, stderr = ""): GhCommandResult {
  return { stdout, exitCode, stderr };
}

const canonSource = JSON.stringify({
  version: "1",
  kind: "issue",
  id: "relations",
  properties: {
    title: { presence: "required", authority: { kind: "supplied" } },
  },
  fields: [],
});

const canonProvenance: ArtifactContractProvenance = {
  authority: "repository-default-branch",
  repository: {
    host: "github.com",
    owner: "acme",
    name: "inari",
    nameWithOwner: "acme/inari",
    repositoryId: "100",
  },
  ref: "main",
  treeSha: "tree-sha",
  source: {
    path: ".github/inari/issues/default.json",
    ref: "main",
    sha: "canon-sha",
    digest: createHash("sha256").update(canonSource, "utf8").digest("hex"),
  },
};

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
  readonly canonTreeSha: string;
  readonly failSetParent: boolean;

  constructor(parentResponses: readonly string[], canonTreeSha = "tree-sha", failSetParent = false) {
    this.parentResponses = [...parentResponses];
    this.canonTreeSha = canonTreeSha;
    this.failSetParent = failSetParent;
  }

  async run(args: readonly string[], _options?: GhTransportOptions): Promise<GhCommandResult> {
    this.calls.push([...args]);
    if (args[0] === "--version") return command("gh version 2.0");
    if (args[0] === "auth" && args[1] === "status") return command();
    if (args.includes("--jq")) return command("100\n");
    if (args.includes("repos/acme/inari") && args.includes("GET"))
      return command(JSON.stringify({ default_branch: "main" }));
    if (args.some((value) => value.includes("git/trees/")))
      return command(
        JSON.stringify({
          sha: this.canonTreeSha,
          truncated: false,
          tree: [{ path: ".github/inari/issues/default.json", type: "blob", sha: "canon-sha" }],
        }),
      );
    if (args.some((value) => value.includes("git/blobs/canon-sha")))
      return command(
        JSON.stringify({
          sha: "canon-sha",
          encoding: "base64",
          content: Buffer.from(canonSource, "utf8").toString("base64"),
        }),
      );
    const path = args.find((value) => value.startsWith("repos/acme/inari")) ?? "";
    if (path.endsWith("/parent")) {
      const response = this.parentResponses.shift() ?? "HTTP/2 404 Not Found\n\n";
      return command(response);
    }
    if (path.includes("/dependencies/blocked_by")) return command("HTTP/2 200 OK\n\n[]");
    if (path.endsWith("/issues/10") && args.includes("GET"))
      return command(`HTTP/2 200 OK\n\n${relationIssue(10, 1010)}`);
    if (path.endsWith("/sub_issue") && args.includes("DELETE")) return command("HTTP/2 200 OK\n\n{}");
    if (path.endsWith("/sub_issues") && args.includes("POST"))
      return this.failSetParent
        ? command("HTTP/2 422 Unprocessable Entity\n\n{}")
        : command("HTTP/2 201 Created\n\n{}");
    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  }
}

function plan() {
  return planSemanticIssueRelations({
    subject: issue(10),
    desired: { parent: issue(20), dependsOn: [] },
    observed: { parent: undefined, dependsOn: [] },
    capabilities,
    generation: canonProvenance,
    graph: {
      scope: "complete",
      nodes: [issue(10), issue(20)].map((reference) => ({ reference, dependsOn: [] })),
    },
  });
}

function reparentPlan() {
  return planSemanticIssueRelations({
    subject: issue(10),
    desired: { parent: issue(20), dependsOn: [] },
    observed: { parent: issue(15), dependsOn: [] },
    capabilities,
    generation: canonProvenance,
    graph: {
      scope: "complete",
      nodes: [issue(10), issue(15), issue(20)].map((reference) => ({ reference, dependsOn: [] })),
    },
  });
}

test("relation executor reports partial application when a later effect fails", async () => {
  const transport = new RelationTransport(
    [`HTTP/2 200 OK\n\n${relationIssue(15)}`, "HTTP/2 404 Not Found\n\n"],
    "tree-sha",
    true,
  );
  const executor = new SemanticIssueRelationExecutor({
    adapter: new GitHubAdapter({ repository: "acme/inari", transport }),
    capabilities,
  });
  await assert.rejects(
    executor.execute({ version: "1", plan: reparentPlan() }),
    (error: unknown) =>
      error instanceof SemanticIssueRelationExecutorError &&
      error.code === "SEMANTIC_ISSUE_RELATION_EXECUTION_EFFECT_FAILED" &&
      error.evidence?.effects[0]?.kind === "CLEAR_PARENT_RELATION" &&
      error.evidence?.effects[0]?.status === "succeeded" &&
      error.evidence?.effects[1]?.kind === "SET_PARENT_RELATION" &&
      error.evidence?.effects[1]?.status === "failed",
  );
  assert.ok(transport.calls.some((args) => args.includes("DELETE")));
  assert.ok(transport.calls.some((args) => args.includes("POST")));
});

test("relation executor observes, applies, rereads, and verifies a native parent effect", async () => {
  const transport = new RelationTransport([
    "HTTP/2 404 Not Found\n\n", // before: subject's own current parent (empty)
    "HTTP/2 404 Not Found\n\n", // graph walk: the new parent target's own current parent
    `HTTP/2 200 OK\n\n${relationIssue(20)}`, // after: subject's parent now present
  ]);
  const executor = new SemanticIssueRelationExecutor({
    adapter: new GitHubAdapter({ repository: "acme/inari", transport }),
    capabilities,
  });
  const result = await executor.execute({ version: "1", plan: plan() });
  assert.equal(result.evidence.outcome, "verified");
  assert.deepEqual(result.observed.parent, issue(20));
  assert.equal(result.evidence.effects[0]?.kind, "SET_PARENT_RELATION");
  assert.ok(transport.calls.some((args) => args.includes("POST")));
});

test("relation executor rejects a capabilities mismatch before touching the plan's effects", async () => {
  const transport = new RelationTransport([]);
  const executor = new SemanticIssueRelationExecutor({
    adapter: new GitHubAdapter({ repository: "acme/inari", transport }),
    capabilities: ["github.issue.parent.native"],
  });
  await assert.rejects(
    executor.execute({ version: "1", plan: plan(), capabilities: ["github.issue.parent.native"] }),
    (error: unknown) =>
      error instanceof SemanticIssueRelationExecutorError &&
      error.code === "SEMANTIC_ISSUE_RELATION_EXECUTION_GOVERNANCE_STALE" &&
      error.diagnostics.some((entry) => entry.code === "RELATION_CAPABILITIES_MISMATCH"),
  );
  assert.equal(
    transport.calls.some((args) => args.includes("POST")),
    false,
  );
});

test("relation executor rejects a plan bound to stale repository governance", async () => {
  const staleGeneration = { ...canonProvenance, treeSha: "old-tree-sha" };
  const staleGenerationPlan = { ...plan(), generation: staleGeneration };
  const transport = new RelationTransport(["HTTP/2 404 Not Found\n\n", `HTTP/2 200 OK\n\n${relationIssue(20)}`]);
  const executor = new SemanticIssueRelationExecutor({
    adapter: new GitHubAdapter({ repository: "acme/inari", transport }),
    capabilities,
  });
  await assert.rejects(
    executor.execute({ version: "1", plan: staleGenerationPlan }),
    (error: unknown) =>
      error instanceof SemanticIssueRelationExecutorError &&
      error.code === "SEMANTIC_ISSUE_RELATION_EXECUTION_GOVERNANCE_STALE" &&
      error.diagnostics.some((entry) => entry.code === "RELATION_GENERATION_MISMATCH"),
  );
  assert.equal(
    transport.calls.some((args) => args.includes("POST")),
    false,
  );
});

test("relation executor accepts a plan bound to the current repository governance", async () => {
  const currentGenerationPlan = { ...plan(), generation: canonProvenance };
  const transport = new RelationTransport([
    "HTTP/2 404 Not Found\n\n",
    "HTTP/2 404 Not Found\n\n",
    `HTTP/2 200 OK\n\n${relationIssue(20)}`,
  ]);
  const executor = new SemanticIssueRelationExecutor({
    adapter: new GitHubAdapter({ repository: "acme/inari", transport }),
    capabilities,
  });
  const result = await executor.execute({ version: "1", plan: currentGenerationPlan });
  assert.equal(result.evidence.outcome, "verified");
});

test("relation executor fails closed when the post-effect reread does not match the desired state", async () => {
  const transport = new RelationTransport([
    "HTTP/2 404 Not Found\n\n", // before: matches plan.observed (empty), not stale
    "HTTP/2 404 Not Found\n\n", // graph walk: the new parent target's own current parent
    "HTTP/2 404 Not Found\n\n", // after: still empty, disagreeing with the desired parent
  ]);
  const executor = new SemanticIssueRelationExecutor({
    adapter: new GitHubAdapter({ repository: "acme/inari", transport }),
    capabilities,
  });
  await assert.rejects(
    executor.execute({ version: "1", plan: plan() }),
    (error: unknown) =>
      error instanceof SemanticIssueRelationExecutorError &&
      error.code === "SEMANTIC_ISSUE_RELATION_EXECUTION_POSTCONDITION_FAILED" &&
      error.evidence?.effects[0]?.status === "succeeded",
  );
  assert.ok(transport.calls.some((args) => args.includes("POST")));
});

test("relation executor rejects execution with no capabilities asserted at all", async () => {
  const transport = new RelationTransport([]);
  const executor = new SemanticIssueRelationExecutor({
    adapter: new GitHubAdapter({ repository: "acme/inari", transport }),
  });
  await assert.rejects(
    executor.execute({ version: "1", plan: plan() }),
    (error: unknown) =>
      error instanceof SemanticIssueRelationExecutorError &&
      error.code === "SEMANTIC_ISSUE_RELATION_EXECUTION_GOVERNANCE_STALE" &&
      error.diagnostics.some((entry) => entry.code === "RELATION_CAPABILITIES_UNASSERTED"),
  );
  assert.equal(transport.calls.length, 0);
});

test("relation executor rejects a same-owner cross-repository parent plan before any provider effect", async () => {
  const localPlan = plan();
  const foreignParent = {
    ...issue(20),
    repositoryId: "200",
    repository: "acme/other",
  };
  const crossRepositoryPlan = {
    ...localPlan,
    desired: { ...localPlan.desired, parent: foreignParent },
    capabilities: [...localPlan.capabilities, "github.issue.parent.native.cross-repository-same-owner"],
    effects: [{ kind: "SET_PARENT_RELATION" as const, parent: foreignParent }],
    graph: {
      scope: "complete" as const,
      nodes: [
        { reference: issue(10), dependsOn: [] },
        { reference: foreignParent, dependsOn: [] },
      ],
    },
  };
  const transport = new RelationTransport([]);
  const executor = new SemanticIssueRelationExecutor({
    adapter: new GitHubAdapter({ repository: "acme/inari", transport }),
    capabilities: localPlan.capabilities,
  });
  await assert.rejects(
    executor.execute({ version: "1", plan: crossRepositoryPlan }),
    (error: unknown) =>
      error instanceof SemanticIssueRelationExecutorError &&
      error.code === "SEMANTIC_ISSUE_RELATION_EXECUTION_PLAN_INVALID" &&
      error.diagnostics.some(
        (entry) =>
          entry.path === "$.desired.parent" &&
          entry.message.includes("foreign-repository graph evidence is unavailable"),
      ),
  );
  assert.equal(transport.calls.length, 0);
});

test("relation executor re-establishes the live graph and rejects a cycle formed after planning", async () => {
  // The plan's own transported graph shows no cycle (20 has no parent at
  // planning time). Between planning and execution, issue 20 acquires
  // subject(10) as its own parent out of band -- closing 10 -> 20 -> 10.
  const transport = new RelationTransport([
    "HTTP/2 404 Not Found\n\n", // before: subject's own current parent (still empty, not stale)
    `HTTP/2 200 OK\n\n${relationIssue(10, 1010)}`, // graph walk: issue 20's current parent is now subject(10)
  ]);
  const executor = new SemanticIssueRelationExecutor({
    adapter: new GitHubAdapter({ repository: "acme/inari", transport }),
    capabilities,
  });
  await assert.rejects(
    executor.execute({ version: "1", plan: plan() }),
    (error: unknown) =>
      error instanceof SemanticIssueRelationExecutorError &&
      error.code === "SEMANTIC_ISSUE_RELATION_EXECUTION_STALE" &&
      error.diagnostics.some((entry) => entry.code === "RELATION_GRAPH_CYCLE"),
  );
  assert.equal(
    transport.calls.some((args) => args.includes("POST")),
    false,
  );
});

test("relation executor fails stale plans before applying an effect", async () => {
  const transport = new RelationTransport([`HTTP/2 200 OK\n\n${relationIssue(21)}`, "HTTP/2 200 OK\n\n[]"]);
  const executor = new SemanticIssueRelationExecutor({
    adapter: new GitHubAdapter({ repository: "acme/inari", transport }),
    capabilities,
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
