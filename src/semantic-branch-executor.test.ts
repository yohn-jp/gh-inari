import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { compileEffectiveArtifactContract } from "./contract/effective-artifact-contract.js";
import { parseArtifactContract } from "./contract/artifact-contract.js";
import { materializeSemanticArtifact } from "./contract/semantic-artifact.js";
import type { ArtifactContractProvenance } from "./contract/ir.js";
import { GitHubAdapter, type GhCommandResult, type GhTransport, type GhTransportOptions } from "./github/index.js";
import {
  SemanticBranchExecutor,
  type SemanticBranchExecutionRequest,
  SemanticBranchExecutorError,
} from "./semantic-branch-executor.js";
import { planSemanticBranch } from "./semantic-branch-projection.js";

function command(stdout = "", exitCode = 0, stderr = ""): GhCommandResult {
  return { stdout, exitCode, stderr };
}

const canon = JSON.stringify({
  version: "1",
  kind: "branch",
  id: "branch-execute",
  properties: {
    name: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "format", template: "{type}/{slug}" } },
    },
    source: { presence: "required", authority: { kind: "fixed", value: "main" } },
    type: { presence: "required", authority: { kind: "supplied" }, constraints: { values: ["feat", "fix"] } },
    slug: { presence: "required", authority: { kind: "supplied" } },
  },
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
    path: ".github/inari/canon/branch.json",
    ref: "main",
    sha: "canon-sha",
    digest: createHash("sha256").update(canon, "utf8").digest("hex"),
  },
};

function branchReference(name: string, sha = "source-sha"): string {
  return JSON.stringify({ ref: `refs/heads/${name}`, object: { type: "commit", sha } });
}

function included(status: number, body: unknown): string {
  return `HTTP/1.1 ${status} Test\n\n${JSON.stringify(body)}`;
}

class ExecutorTransport implements GhTransport {
  readonly calls: string[][] = [];
  readonly targetAlreadyExists: boolean;
  private created = false;

  constructor(targetAlreadyExists = false) {
    this.targetAlreadyExists = targetAlreadyExists;
  }

  async run(args: readonly string[], _options?: GhTransportOptions): Promise<GhCommandResult> {
    this.calls.push([...args]);
    const endpoint = args.find((value) => value.startsWith("repos/acme/repository-b")) ?? "";
    if (args[0] === "--version") return command("gh version 2.0");
    if (args[0] === "auth" && args[1] === "status") return command();
    if (args.includes("--jq")) return command("100000200\n");
    if (endpoint === "repos/acme/repository-b" && args.includes("--method")) {
      return command(JSON.stringify({ default_branch: "main" }));
    }
    if (endpoint.includes("git/trees/")) {
      return command(
        JSON.stringify({
          sha: "tree-sha",
          truncated: false,
          tree: [{ path: ".github/inari/canon/branch.json", type: "blob", sha: "canon-sha" }],
        }),
      );
    }
    if (endpoint.includes("git/blobs/canon-sha")) {
      return command(
        JSON.stringify({
          sha: "canon-sha",
          encoding: "base64",
          content: Buffer.from(canon, "utf8").toString("base64"),
        }),
      );
    }
    if (endpoint.includes("git/ref/heads/main")) return command(included(200, JSON.parse(branchReference("main"))));
    if (endpoint.includes("git/ref/heads/feat%2Fexecute")) {
      if (this.targetAlreadyExists || this.created)
        return command(included(200, JSON.parse(branchReference("feat/execute"))));
      return command(included(404, { message: "Not Found" }));
    }
    if (endpoint.endsWith("git/refs") && args.includes("POST")) {
      this.created = true;
      return command(branchReference("feat/execute"));
    }
    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  }
}

function inputArtifact() {
  const contract = parseArtifactContract(JSON.parse(canon) as unknown);
  return materializeSemanticArtifact(compileEffectiveArtifactContract(contract, { provenance }), {
    type: "feat",
    slug: "execute",
  });
}

function request(plan: unknown, input?: unknown): SemanticBranchExecutionRequest {
  return { version: "1", plan, ...(input === undefined ? {} : { input }) };
}

test("local Semantic Branch Executor admits, creates, rereads, and verifies a plan", async () => {
  const transport = new ExecutorTransport();
  const artifact = inputArtifact();
  const plan = planSemanticBranch({ artifact });
  const result = await new SemanticBranchExecutor({
    adapter: new GitHubAdapter({ repository: "acme/repository-b", transport }),
  }).execute(request(plan, { type: "feat", slug: "execute" }));

  assert.equal(result.evidence.outcome, "verified");
  assert.deepEqual(result.projection, {
    kind: "branch",
    name: "feat/execute",
    source: "main",
    sha: "source-sha",
  });
  assert.equal(
    transport.calls.some((args) => args.includes("POST")),
    true,
  );
  assert.equal(
    transport.calls.filter((args) => args.some((value) => value.includes("git/ref/heads/feat%2Fexecute"))).length,
    2,
  );
});

test("local Semantic Branch Executor rejects an existing target before effects", async () => {
  const transport = new ExecutorTransport(true);
  const plan = planSemanticBranch({ artifact: inputArtifact() });
  await assert.rejects(
    new SemanticBranchExecutor({ adapter: new GitHubAdapter({ repository: "acme/repository-b", transport }) }).execute(
      request(plan),
    ),
    (error: unknown) =>
      error instanceof SemanticBranchExecutorError && error.code === "SEMANTIC_BRANCH_EXECUTION_PRECONDITION_FAILED",
  );
  assert.equal(
    transport.calls.some((args) => args.includes("POST")),
    false,
  );
});

test("local Semantic Branch Executor fails closed for a tampered plan", async () => {
  const transport = new ExecutorTransport();
  const plan = planSemanticBranch({ artifact: inputArtifact() });
  await assert.rejects(
    new SemanticBranchExecutor({ adapter: new GitHubAdapter({ repository: "acme/repository-b", transport }) }).execute(
      request({ ...plan, desired: { ...plan.desired, name: "evil" } }),
    ),
    (error: unknown) =>
      error instanceof SemanticBranchExecutorError && error.code === "SEMANTIC_BRANCH_EXECUTION_PLAN_INVALID",
  );
  assert.equal(transport.calls.length, 0);
});
