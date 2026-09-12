import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { type GhCommandResult, type GhTransport, type GhTransportOptions, GitHubAdapter } from "./github/index.js";

function command(stdout = "", exitCode = 0, stderr = ""): GhCommandResult {
  return { stdout, exitCode, stderr };
}

function parentIssue(number: number, id = number + 1000): string {
  return JSON.stringify({ id, number, repository_url: "https://api.github.com/repos/acme/repository-b" });
}

/**
 * Responds to the fixed bootstrap sequence (`--version`, `auth status`,
 * repository-ID `--jq`) from any position, and otherwise consumes the
 * supplied responses in order. Every CLI invocation under test builds a
 * fresh `GitHubAdapter` per Core call (planning, then execution), so the
 * bootstrap sequence recurs; a strict FIFO queue would misalign.
 */
class IssueRelationsTransport implements GhTransport {
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
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    return response;
  }
}

async function invoke(
  operation: "plan" | "execute",
  issueNumber: number,
  input: Record<string, unknown>,
  transportResponses: readonly GhCommandResult[],
): Promise<{
  readonly exitCode: number;
  readonly output: Record<string, unknown>;
  readonly calls: readonly string[][];
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-issue-relations-"));
  try {
    const inputPath = path.join(directory, "input.json");
    await writeFile(inputPath, JSON.stringify(input), "utf8");
    const transport = new IssueRelationsTransport(transportResponses);
    const lines: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (line: string) => lines.push(line);
      const argv = [
        "issue",
        "relations",
        operation,
        String(issueNumber),
        "--repository",
        "acme/repository-b",
        "--from",
        inputPath,
        "--capability",
        "github.issue.parent.native",
        "--capability",
        "github.issue.blocked-by.native",
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

const desiredParent = { repositoryHost: "github.com", repositoryId: "100000900", number: 20 };
const subjectReference = { repositoryHost: "github.com", repositoryId: "100000900", number: 701 };
const closedGraph = {
  scope: "complete",
  nodes: [
    { reference: subjectReference, dependsOn: [] },
    { reference: desiredParent, dependsOn: [] },
  ],
};

test("issue relations plan previews a deterministic Core plan from live observation without mutation", async () => {
  const result = await invoke("plan", 701, { desired: { parent: desiredParent, dependsOn: [] }, graph: closedGraph }, [
    command("HTTP/2 404 Not Found\n\n"),
    command("HTTP/2 200 OK\n\n[]"),
  ]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.ok, true);
  assert.equal(result.output.preview, true);
  assert.equal(result.output.mutation, false);
  const plan = result.output.plan as Record<string, unknown>;
  assert.deepEqual(plan.effects, [{ kind: "SET_PARENT_RELATION", parent: desiredParent }]);
  assert.equal(
    result.calls.some((args) => args.includes("POST")),
    false,
  );
});

test("issue relations plan fails closed when a real effect omits graph evidence", async () => {
  const result = await invoke("plan", 701, { desired: { parent: desiredParent, dependsOn: [] } }, [
    command("HTTP/2 404 Not Found\n\n"),
    command("HTTP/2 200 OK\n\n[]"),
  ]);
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.ok, false);
  const diagnostics = result.output.diagnostics as Array<Record<string, unknown>>;
  assert.ok(diagnostics.some((entry) => entry.path === "$.graph"));
  assert.equal(
    result.calls.some((args) => args.includes("POST")),
    false,
  );
});

test("issue relations execute reconciles a native parent effect through the governed executor", async () => {
  const result = await invoke(
    "execute",
    701,
    { desired: { parent: desiredParent, dependsOn: [] }, graph: closedGraph },
    [
      // planExistingIssueRelationReconciliation's own fresh observation
      // (parent + blocked-by; planning always observes both):
      command("HTTP/2 404 Not Found\n\n"),
      command("HTTP/2 200 OK\n\n[]"),
      // SemanticIssueRelationExecutor's independent re-observation before
      // effects: only parent, since dependsOn stays "none"-represented here.
      command("HTTP/2 404 Not Found\n\n"),
      // Resolve the subject's database ID, then apply SET_PARENT_RELATION:
      command(`HTTP/2 200 OK\n\n${parentIssue(701, 1701)}`),
      command("HTTP/2 201 Created\n\n{}"),
      // Post-effect reread and verify (parent only):
      command(`HTTP/2 200 OK\n\n${parentIssue(20)}`),
    ],
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.ok, true);
  assert.equal(result.output.mutation, true);
  const evidence = result.output.evidence as Record<string, unknown>;
  assert.equal(evidence.outcome, "verified");
  assert.ok(result.calls.some((args) => args.includes("POST")));
});

test("issue relations rejects an unsupported option before touching the adapter", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-issue-relations-"));
  try {
    const inputPath = path.join(directory, "input.json");
    await writeFile(inputPath, JSON.stringify({ desired: { dependsOn: [] } }), "utf8");
    const transport = new IssueRelationsTransport([]);
    const lines: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (line: string) => lines.push(line);
      const exitCode = await runCli(
        ["issue", "relations", "plan", "701", "--from", inputPath, "--template", "default", "--json"],
        {
          repositoryRoot: directory,
          createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
        },
      );
      assert.equal(exitCode, 1);
      assert.equal(transport.calls.length, 0);
    } finally {
      console.log = originalLog;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
