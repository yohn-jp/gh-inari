import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";
import type { GhCommandResult, GhTransport, GhTransportOptions } from "./github/index.js";
import { GitHubAdapter } from "./github/index.js";
import { SemanticPullRequestExecutor, type SemanticPullRequestExecutionRequest } from "./semantic-pr-executor.js";
import { compileEffectiveArtifactContract } from "./contract/effective-artifact-contract.js";
import { parseArtifactContract } from "./contract/artifact-contract.js";
import { materializeSemanticArtifact } from "./contract/semantic-artifact.js";
import { planSemanticPullRequest } from "./semantic-pr-projection.js";
import type { ArtifactContractProvenance } from "./contract/ir.js";

function command(stdout = "", exitCode = 0, stderr = ""): GhCommandResult {
  return { stdout, exitCode, stderr };
}

const source = JSON.stringify({
  version: "1",
  kind: "pull_request",
  id: "execute",
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
    type: { presence: "required", authority: { kind: "supplied" }, constraints: { values: ["feat", "fix"] } },
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

const issue = {
  repositoryHost: "github.com",
  repositoryId: "100000200",
  repository: "acme/repository-b",
  number: 286,
};

function pullRequestPayload(
  values: Readonly<{ title: string; body: string; head: string; base: string }>,
  number = 700,
): string {
  return JSON.stringify({
    number,
    title: values.title,
    body: values.body,
    state: "open",
    draft: false,
    html_url: `https://github.com/acme/repository-b/pull/${number}`,
    head: { ref: values.head },
    base: { ref: values.base },
    labels: [],
    assignees: [],
    milestone: null,
    requested_reviewers: [],
    requested_teams: [],
  });
}

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
    if (args.some((value) => value.includes("/pulls?") && value.includes("head=")))
      return command("HTTP/1.1 200 OK\n\n[]");
    if (args.some((value) => value.includes("/pulls/700"))) {
      return command(this.created ?? pullRequestPayload({ title: "", body: "", head: "", base: "" }));
    }
    if (args.some((value) => value.includes("/pulls")) && args.includes("--method") && args.includes("POST")) {
      const fields = rawFields(args);
      this.created = pullRequestPayload({
        title: fields.title ?? "",
        body: fields.body ?? "",
        head: fields.head ?? "",
        base: fields.base ?? "",
      });
      return command(this.created);
    }
    if (args.some((value) => value.includes("git/trees/"))) {
      const treeSha = this.treeShas.shift() ?? "tree-sha";
      return command(
        JSON.stringify({
          sha: treeSha,
          truncated: false,
          tree: [{ path: ".github/inari/pull-requests/default.json", type: "blob", sha: "canon-sha" }],
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

function input(): Record<string, unknown> {
  return { type: "feat", implements: [issue], summary: "Execute semantic PR" };
}

async function invoke(
  transport: ExecutorTransport,
  treeShas: readonly string[] = ["tree-sha", "tree-sha"],
): Promise<{
  readonly exitCode: number;
  readonly output: Record<string, unknown>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-semantic-pr-executor-"));
  try {
    const inputPath = path.join(directory, "input.json");
    await writeFile(inputPath, JSON.stringify(input()), "utf8");
    const lines: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (line: string) => lines.push(line);
      const exitCode = await runCli(
        [
          "pr",
          "execute",
          "default",
          "--repository",
          "acme/repository-b",
          "--from",
          inputPath,
          "--capability",
          "github.pull_request.implements.closing-reference",
          "--json",
        ],
        {
          repositoryRoot: directory,
          createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
        },
      );
      return { exitCode, output: JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown> };
    } finally {
      console.log = originalLog;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("local Semantic PR Executor re-resolves, creates, rereads, and verifies a plan", async () => {
  const transport = new ExecutorTransport();
  const result = await invoke(transport);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.mutation, true);
  assert.equal(result.output.preview, false);
  assert.equal((result.output.evidence as Record<string, unknown>).outcome, "verified");
  const projection = result.output.projection as Record<string, unknown>;
  assert.equal(projection.number, 700);
  assert.equal(projection.head, "feat/execute-semantic-pr");
  assert.equal(
    transport.calls.some((args) => args.some((value) => value.includes("/pulls?") && value.includes("head="))),
    true,
  );
  assert.equal(
    transport.calls.some((args) => args.includes("POST")),
    true,
  );
  assert.equal(
    transport.calls.some((args) => args.some((value) => value.includes("/pulls/700"))),
    true,
  );
});

test("local Semantic PR Executor fails closed when the Canon generation is stale", async () => {
  const transport = new ExecutorTransport(["tree-a", "tree-b"]);
  const result = await invoke(transport, ["tree-a", "tree-b"]);
  assert.equal(result.exitCode, 2);
  const error = result.output.error as Record<string, unknown>;
  assert.equal(error.code, "SEMANTIC_PR_EXECUTION_PRECONDITION_FAILED");
  assert.equal(
    transport.calls.some((args) => args.includes("POST")),
    false,
  );
});

test("plan-only executor admission remains versioned and rejects tampered plans", async () => {
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
    source: { path: ".github/inari/pull-requests/default.json", ref: "main", sha: "canon-sha", digest: "source" },
  };
  const contract = parseArtifactContract(JSON.parse(source) as unknown);
  const effective = compileEffectiveArtifactContract(contract, { provenance });
  const artifact = materializeSemanticArtifact(effective, {
    type: "feat",
    implements: [issue],
    summary: "Executor direct",
  });
  const plan = planSemanticPullRequest({
    artifact,
    capabilities: ["github.pull_request.implements.closing-reference"],
  });
  const adapter = new GitHubAdapter({ repository: "acme/repository-b", transport: new ExecutorTransport() });
  const executor = new SemanticPullRequestExecutor({ adapter });
  const request: SemanticPullRequestExecutionRequest = {
    version: "1",
    plan: { ...plan, desired: { ...plan.desired, title: "tampered" } },
  };
  await assert.rejects(
    executor.execute(request),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "SEMANTIC_PR_EXECUTION_PLAN_INVALID",
  );
});
