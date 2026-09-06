import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { type GhCommandResult, type GhTransport, type GhTransportOptions, GitHubAdapter } from "./github/index.js";

class SemanticIssueTransport implements GhTransport {
  readonly calls: string[][] = [];
  private readonly responses: GhCommandResult[];

  constructor(source: string) {
    this.responses = [
      command("gh version 2.0"),
      command(),
      command("100000200\n"),
      command(JSON.stringify({ default_branch: "main" })),
      command(
        JSON.stringify({
          sha: "tree-sha-semantic-issue-cli",
          truncated: false,
          tree: [{ path: ".github/inari/issues/default.json", type: "blob", sha: "canon-sha" }],
        }),
      ),
      command(
        JSON.stringify({
          sha: "canon-sha",
          encoding: "base64",
          content: Buffer.from(source, "utf8").toString("base64"),
        }),
      ),
    ];
  }

  async run(args: readonly string[], _options?: GhTransportOptions): Promise<GhCommandResult> {
    this.calls.push([...args]);
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    return response;
  }
}

function command(stdout = "", exitCode = 0, stderr = ""): GhCommandResult {
  return { stdout, exitCode, stderr };
}

const issueCanon = JSON.stringify({
  version: "1",
  kind: "issue",
  id: "default",
  properties: {
    title: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "format", template: "{type}: {slug}" } },
    },
    type: {
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { values: ["feature", "bug"] },
    },
    parent: { presence: "unused" },
    dependsOn: { presence: "unused" },
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

async function invoke(
  operation: readonly string[],
  input?: Record<string, unknown>,
): Promise<{
  readonly exitCode: number;
  readonly output: Record<string, unknown>;
  readonly calls: readonly string[][];
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-semantic-issue-"));
  try {
    const inputPath = path.join(directory, "input.json");
    if (input !== undefined) await writeFile(inputPath, JSON.stringify(input), "utf8");
    const transport = new SemanticIssueTransport(issueCanon);
    const lines: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (line: string) => lines.push(line);
      const argv = [
        "issue",
        ...operation,
        "default",
        "--repository",
        "acme/repository-b",
        ...(input === undefined ? [] : ["--from", inputPath]),
        "--json",
      ];
      const exitCode = await runCli(argv, {
        repositoryRoot: directory,
        createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
      });
      const output = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
      return { exitCode, output, calls: transport.calls };
    } finally {
      console.log = originalLog;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Issue CLI delegates contract, materialization, and plan preview to Core", async () => {
  const input = { type: "feature", summary: "Semantic Issue" };
  const contract = await invoke(["contract"]);
  const first = await invoke(["plan"], input);
  const second = await invoke(["semantic", "plan"], input);

  assert.equal(contract.exitCode, 0);
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  const effective = contract.output.effectiveContract as Record<string, unknown>;
  assert.equal(effective.kind, "issue");
  assert.equal((effective.inputSchema as Record<string, unknown>).additionalProperties, false);
  const plan = first.output.plan as Record<string, unknown>;
  const desired = plan.desired as Record<string, unknown>;
  assert.equal(desired.title, "feature: semantic-issue");
  assert.equal(first.output.preview, true);
  assert.equal(first.output.mutation, false);
  assert.deepEqual(first.output, second.output);
  assert.equal(
    first.calls.some((args) => args.some((arg) => ["POST", "PATCH", "PUT", "DELETE"].includes(arg))),
    false,
  );
});
