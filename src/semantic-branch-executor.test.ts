import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  ArtifactContractResolutionError,
  compileRepositoryEffectiveBranchContract,
} from "./artifact-contract-governance.js";
import { compileEffectiveArtifactContract } from "./contract/effective-artifact-contract.js";
import { parseArtifactContract } from "./contract/artifact-contract.js";
import { materializeSemanticArtifact } from "./contract/semantic-artifact.js";
import type { ArtifactContractProvenance } from "./contract/ir.js";
import { GitHubAdapter, type GhCommandResult, type GhTransport, type GhTransportOptions } from "./github/index.js";
import {
  LocalSemanticBranchExecutor,
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

const wrongKindCanon = JSON.stringify({
  version: "1",
  kind: "pull_request",
  id: "wrong-kind",
  properties: {
    title: { presence: "required", authority: { kind: "supplied" } },
    head: { presence: "required", authority: { kind: "supplied" } },
    base: { presence: "required", authority: { kind: "fixed", value: "main" } },
  },
  fields: [{ id: "summary", primitive: "text", presence: "required", authority: { kind: "supplied" } }],
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
    path: ".github/inari/branches/default.json",
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
  private readonly canonPath: string;
  private readonly canonSource: string;
  private readonly treeEntries: readonly { readonly path: string; readonly type: string; readonly sha: string }[];
  private created = false;

  constructor(
    targetAlreadyExists = false,
    options: {
      readonly canonPath?: string;
      readonly canonSource?: string;
      readonly treeEntries?: readonly { readonly path: string; readonly type: string; readonly sha: string }[];
    } = {},
  ) {
    this.targetAlreadyExists = targetAlreadyExists;
    this.canonPath = options.canonPath ?? ".github/inari/branches/default.json";
    this.canonSource = options.canonSource ?? canon;
    this.treeEntries = options.treeEntries ?? [{ path: this.canonPath, type: "blob", sha: "canon-sha" }];
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
          tree: this.treeEntries,
        }),
      );
    }
    if (endpoint.includes("git/blobs/canon-sha")) {
      return command(
        JSON.stringify({
          sha: "canon-sha",
          encoding: "base64",
          content: Buffer.from(this.canonSource, "utf8").toString("base64"),
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

async function rejected(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected operation to reject.");
}

test("local Semantic Branch Executor admits, creates, rereads, and verifies a plan", async () => {
  const transport = new ExecutorTransport();
  const adapter = new GitHubAdapter({ repository: "acme/repository-b", transport });
  const effective = await compileRepositoryEffectiveBranchContract(adapter, "default");
  const artifact = materializeSemanticArtifact(effective, { type: "feat", slug: "execute" });
  const plan = planSemanticBranch({ artifact });
  const result = await new LocalSemanticBranchExecutor({ adapter }).execute(
    request(plan, { type: "feat", slug: "execute" }),
  );

  assert.equal(result.evidence.outcome, "verified");
  assert.deepEqual(result.plan.generation, effective.generation);
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
    new LocalSemanticBranchExecutor({
      adapter: new GitHubAdapter({ repository: "acme/repository-b", transport }),
    }).execute(request(plan)),
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
    new LocalSemanticBranchExecutor({
      adapter: new GitHubAdapter({ repository: "acme/repository-b", transport }),
    }).execute(request({ ...plan, desired: { ...plan.desired, name: "evil" } })),
    (error: unknown) =>
      error instanceof SemanticBranchExecutorError && error.code === "SEMANTIC_BRANCH_EXECUTION_PLAN_INVALID",
  );
  assert.equal(transport.calls.length, 0);
});

test("Semantic Branch execution preserves shared Canon resolution diagnostics", async () => {
  const invalidCases = [
    {
      name: "missing Canon",
      options: { treeEntries: [] },
      code: "ARTIFACT_CONTRACT_NOT_FOUND",
    },
    {
      name: "invalid JSON",
      options: { canonSource: "{" },
      code: "ARTIFACT_CONTRACT_SOURCE_INVALID",
    },
    {
      name: "wrong kind",
      options: { canonSource: wrongKindCanon },
      code: "ARTIFACT_CONTRACT_KIND_INVALID",
    },
    {
      name: "invalid contract",
      options: { canonSource: JSON.stringify({}) },
      code: "ARTIFACT_CONTRACT_SOURCE_INVALID",
    },
  ] as const;
  const plan = planSemanticBranch({ artifact: inputArtifact() });

  for (const invalidCase of invalidCases) {
    const sharedTransport = new ExecutorTransport(false, invalidCase.options);
    const sharedAdapter = new GitHubAdapter({ repository: "acme/repository-b", transport: sharedTransport });
    const sharedError = await rejected(() => compileRepositoryEffectiveBranchContract(sharedAdapter));
    assert.ok(sharedError instanceof ArtifactContractResolutionError, invalidCase.name);
    assert.equal(sharedError.code, invalidCase.code, invalidCase.name);

    const executorTransport = new ExecutorTransport(false, invalidCase.options);
    const executorAdapter = new GitHubAdapter({ repository: "acme/repository-b", transport: executorTransport });
    const executorError = await rejected(() =>
      new LocalSemanticBranchExecutor({ adapter: executorAdapter }).execute(request(plan)),
    );
    assert.ok(executorError instanceof ArtifactContractResolutionError, invalidCase.name);
    assert.deepEqual(
      {
        code: executorError.code,
        path: executorError.path,
        message: executorError.message,
        diagnostics: executorError.diagnostics,
      },
      {
        code: sharedError.code,
        path: sharedError.path,
        message: sharedError.message,
        diagnostics: sharedError.diagnostics,
      },
      invalidCase.name,
    );
  }
});
