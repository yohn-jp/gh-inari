import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { compileEffectiveArtifactContract } from "./contract/effective-artifact-contract.js";
import { parseArtifactContract } from "./contract/artifact-contract.js";
import { materializeSemanticArtifact } from "./contract/semantic-artifact.js";
import type { ArtifactContractProvenance } from "./contract/ir.js";
import type { GhCommandResult, GhTransport, GhTransportOptions } from "./github/index.js";
import { GitHubAdapter } from "./github/index.js";
import {
  SemanticIssueExecutor,
  SemanticIssueExecutorError,
  type SemanticIssueExecutionRequest,
} from "./semantic-issue-executor.js";
import { planSemanticIssue } from "./semantic-issue-projection.js";

function command(stdout = "", exitCode = 0, stderr = ""): GhCommandResult {
  return { stdout, exitCode, stderr };
}

const source = JSON.stringify({
  version: "1",
  kind: "issue",
  id: "execute",
  properties: {
    title: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "format", template: "{type}: {slug}" } },
    },
    type: { presence: "required", authority: { kind: "supplied" }, constraints: { values: ["feat", "fix"] } },
    labels: { presence: "optional", authority: { kind: "supplied" } },
    assignees: { presence: "optional", authority: { kind: "supplied" } },
    milestone: { presence: "optional", authority: { kind: "supplied" } },
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

const provenance: ArtifactContractProvenance = {
  authority: "repository-default-branch",
  repository: {
    host: "github.com",
    owner: "acme",
    name: "repository-b",
    nameWithOwner: "acme/repository-b",
    repositoryId: "100000200",
  },
  ref: "main",
  treeSha: "tree-sha",
  source: {
    path: ".github/inari/issues/default.json",
    ref: "main",
    sha: "canon-sha",
    digest: createHash("sha256").update(source, "utf8").digest("hex"),
  },
};

function rawFields(args: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--raw-field") continue;
    const raw = args[index + 1] ?? "";
    const separator = raw.indexOf("=");
    if (separator > 0) fields[raw.slice(0, separator)] = raw.slice(separator + 1);
  }
  return fields;
}

function rawFieldsAll(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--raw-field") continue;
    const raw = args[index + 1] ?? "";
    const separator = raw.indexOf("=");
    if (separator > 0 && raw.slice(0, separator) === name) values.push(raw.slice(separator + 1));
  }
  return values;
}

function issuePayload(
  values: Readonly<{ title: string; body: string; labels: readonly string[]; assignees: readonly string[] }>,
): string {
  return JSON.stringify({
    number: 701,
    title: values.title,
    body: values.body,
    state: "open",
    html_url: "https://github.com/acme/repository-b/issues/701",
    labels: values.labels.map((name) => ({ name })),
    assignees: values.assignees.map((login) => ({ login })),
    milestone: null,
  });
}

class ExecutorTransport implements GhTransport {
  readonly calls: string[][] = [];
  readonly treeShas: string[];
  private created: string | undefined;

  constructor(treeShas: readonly string[] = ["tree-sha"]) {
    this.treeShas = [...treeShas];
  }

  async run(args: readonly string[], _options?: GhTransportOptions): Promise<GhCommandResult> {
    this.calls.push([...args]);
    if (args[0] === "--version") return command("gh version 2.0");
    if (args[0] === "auth" && args[1] === "status") return command();
    if (args.includes("--jq")) return command("100000200\n");
    if (args.includes("repos/acme/repository-b") && args.includes("GET"))
      return command(JSON.stringify({ default_branch: "main" }));
    if (args.some((value) => value.endsWith("/issues")) && args.includes("POST")) {
      const fields = rawFields(args);
      this.created = issuePayload({
        title: fields.title ?? "",
        body: fields.body ?? "",
        labels: rawFieldsAll(args, "labels[]"),
        assignees: rawFieldsAll(args, "assignees[]"),
      });
      return command(this.created);
    }
    if (args.some((value) => value.includes("/issues/701"))) {
      return command(this.created ?? issuePayload({ title: "", body: "", labels: [], assignees: [] }));
    }
    if (args.some((value) => value.includes("git/trees/"))) {
      const treeSha = this.treeShas.shift() ?? "tree-sha";
      return command(
        JSON.stringify({
          sha: treeSha,
          truncated: false,
          tree: [{ path: ".github/inari/issues/default.json", type: "blob", sha: "canon-sha" }],
        }),
      );
    }
    if (args.some((value) => value.includes("git/blobs/canon-sha"))) {
      return command(
        JSON.stringify({
          sha: "canon-sha",
          encoding: "base64",
          content: Buffer.from(source, "utf8").toString("base64"),
        }),
      );
    }
    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  }
}

function input(values: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { type: "feat", summary: "Execute semantic Issue", ...values };
}

function createPlan(values: Readonly<Record<string, unknown>> = {}) {
  const contract = parseArtifactContract(JSON.parse(source) as unknown);
  const effective = compileEffectiveArtifactContract(contract, { provenance });
  const artifact = materializeSemanticArtifact(effective, input(values));
  return { artifact, plan: planSemanticIssue({ artifact, capabilities: [] }) };
}

test("local Semantic Issue Executor re-resolves, creates, rereads, and verifies a plan", async () => {
  const transport = new ExecutorTransport();
  const { artifact, plan } = createPlan({ labels: ["semantic"], assignees: ["octocat"] });
  const executor = new SemanticIssueExecutor({
    adapter: new GitHubAdapter({ repository: "acme/repository-b", transport }),
  });

  const result = await executor.execute({
    version: "1",
    plan,
    artifact,
    input: input({ labels: ["semantic"], assignees: ["octocat"] }),
  });
  assert.equal(result.evidence.outcome, "verified");
  assert.equal(result.projection.number, 701);
  assert.deepEqual(result.projection.labels, ["semantic"]);
  assert.equal(
    transport.calls.some((args) => args.includes("POST")),
    true,
  );
  assert.equal(
    transport.calls.some((args) => args.some((value) => value.includes("/issues/701"))),
    true,
  );
});

test("local Semantic Issue Executor fails closed on stale Canon generation before effects", async () => {
  const transport = new ExecutorTransport(["tree-other"]);
  const { plan } = createPlan();
  const executor = new SemanticIssueExecutor({
    adapter: new GitHubAdapter({ repository: "acme/repository-b", transport }),
  });
  await assert.rejects(
    executor.execute({ version: "1", plan }),
    (error: unknown) =>
      error instanceof SemanticIssueExecutorError && error.code === "SEMANTIC_ISSUE_EXECUTION_PRECONDITION_FAILED",
  );
  assert.equal(
    transport.calls.some((args) => args.includes("POST")),
    false,
  );
});

test("unsupported desired Issue semantics fail closed without silently dropping state", async () => {
  const transport = new ExecutorTransport();
  const { plan } = createPlan({ milestone: "wave" });
  const executor = new SemanticIssueExecutor({
    adapter: new GitHubAdapter({ repository: "acme/repository-b", transport }),
  });
  await assert.rejects(
    executor.execute({ version: "1", plan }),
    (error: unknown) =>
      error instanceof SemanticIssueExecutorError && error.code === "SEMANTIC_ISSUE_EXECUTION_PLAN_INVALID",
  );
  assert.equal(transport.calls.length, 0);
});

test("plan-only admission rejects tampered Issue plans", async () => {
  const transport = new ExecutorTransport();
  const { plan } = createPlan();
  const tampered = { ...plan, desired: { ...plan.desired, title: "tampered" } };
  const executor = new SemanticIssueExecutor({
    adapter: new GitHubAdapter({ repository: "acme/repository-b", transport }),
  });
  const request: SemanticIssueExecutionRequest = { version: "1", plan: tampered };
  await assert.rejects(
    executor.execute(request),
    (error: unknown) =>
      error instanceof SemanticIssueExecutorError && error.code === "SEMANTIC_ISSUE_EXECUTION_PLAN_INVALID",
  );
});
