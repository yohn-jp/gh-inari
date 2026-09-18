import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { GitHubAdapter } from "./github/index.js";
import {
  nativeTestTransport,
  type FixtureCommandResult,
  type FixtureCommandTransport,
  type FixtureCommandOptions,
} from "./github/test-native-transport.test.js";

function command(stdout = "", exitCode = 0, stderr = ""): FixtureCommandResult {
  return { stdout, exitCode, stderr };
}

function parentIssue(number: number, id = number + 1000): string {
  return JSON.stringify({ id, number, repository_url: "https://api.github.com/repos/acme/repository-b" });
}

function parentIssueValue(number: number, id = number + 1000): Record<string, unknown> {
  return JSON.parse(parentIssue(number, id)) as Record<string, unknown>;
}

const canonSource = JSON.stringify({
  version: "1",
  kind: "issue",
  id: "default",
  properties: {
    title: { presence: "required", authority: { kind: "supplied" } },
    parent: { presence: "optional", authority: { kind: "supplied" } },
    dependsOn: { presence: "optional", authority: { kind: "supplied" } },
  },
  fields: [],
});

/**
 * Responds to the fixed bootstrap sequence (`--version`, `auth status`,
 * repository-ID `--jq`) and the repository Canon reads (default branch,
 * tree, blob) from any position, and otherwise consumes the supplied
 * responses in order. Every CLI invocation under test builds a fresh
 * `GitHubAdapter` per Core call (planning re-compiles the Canon, and
 * `execute` re-compiles it again independently), so both sequences recur;
 * a strict FIFO queue would misalign.
 */
class IssueRelationsTransport implements FixtureCommandTransport {
  readonly calls: string[][] = [];
  private readonly responses: FixtureCommandResult[];

  constructor(responses: readonly FixtureCommandResult[]) {
    this.responses = [...responses];
  }

  async run(args: readonly string[], _options?: FixtureCommandOptions): Promise<FixtureCommandResult> {
    this.calls.push([...args]);
    if (args[0] === "--version") return command("gh version 2.0");
    if (args[0] === "auth" && args[1] === "status") return command();
    if (args.includes("--jq")) return command("100000900\n");
    if (args.includes("repos/acme/repository-b") && args.includes("GET"))
      return command(JSON.stringify({ default_branch: "main" }));
    if (args.some((value) => value.includes("git/trees/")))
      return command(
        JSON.stringify({
          sha: "tree-sha",
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
    const path = args.find((value) => value.startsWith("repos/acme/repository-b")) ?? "";
    if (path.includes("/dependencies/blocked_by")) return command("HTTP/2 200 OK\n\n[]");
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    return response;
  }
}

class GenericRelationsTransport implements FixtureCommandTransport {
  readonly calls: string[][] = [];
  private readonly parentByChild = new Map<number, number>([[701, 20]]);

  parentFor(child: number): number | undefined {
    return this.parentByChild.get(child);
  }

  async run(args: readonly string[], _options?: FixtureCommandOptions): Promise<FixtureCommandResult> {
    this.calls.push([...args]);
    if (args[0] === "--version") return command("gh version 2.0");
    if (args[0] === "auth" && args[1] === "status") return command();
    if (args.includes("--jq")) return command("100000900\n");
    const resource = args.find((value) => value.startsWith("repos/acme/repository-b/")) ?? "";
    const path = resource.replace("repos/acme/repository-b/", "");
    const methodIndex = args.indexOf("--method");
    const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
    const issueMatch = /^issues\/(\d+)(?:\/|$)/u.exec(path);
    const issueNumber = issueMatch === null ? undefined : Number(issueMatch[1]);
    const field = (name: string): number | undefined => {
      const index = args.findIndex((value) => value === "--field" || value === "--raw-field");
      const value = index < 0 ? undefined : args[index + 1];
      if (value === undefined || !value.startsWith(`${name}=`)) return undefined;
      const parsed = Number(value.slice(name.length + 1));
      return Number.isSafeInteger(parsed) ? parsed : undefined;
    };
    if (method === "GET" && issueNumber !== undefined && /^issues\/\d+$/u.test(path))
      return command(`HTTP/2 200 OK\n\n${JSON.stringify({ id: issueNumber + 1000, number: issueNumber })}`);
    if (method === "GET" && issueNumber !== undefined && path.endsWith("/parent")) {
      const parent = this.parentByChild.get(issueNumber);
      return parent === undefined
        ? command("HTTP/2 404 Not Found\n\n")
        : command(`HTTP/2 200 OK\n\n${JSON.stringify(parentIssueValue(parent))}`);
    }
    if (method === "GET" && issueNumber !== undefined && path.includes("/sub_issues?")) {
      const children = [...this.parentByChild.entries()]
        .filter(([, parent]) => parent === issueNumber)
        .map(([child]) => parentIssueValue(child));
      return command(`HTTP/2 200 OK\n\n${JSON.stringify(children)}`);
    }
    if (method === "POST" && issueNumber !== undefined && path.endsWith("/sub_issues")) {
      const childId = field("sub_issue_id");
      if (childId !== undefined) this.parentByChild.set(childId - 1000, issueNumber);
      return command("HTTP/2 201 Created\n\n{}");
    }
    if (method === "DELETE" && issueNumber !== undefined && path.endsWith("/sub_issue")) {
      const childId = field("sub_issue_id");
      if (childId !== undefined && this.parentByChild.get(childId - 1000) === issueNumber)
        this.parentByChild.delete(childId - 1000);
      return command("HTTP/2 200 OK\n\n{}");
    }
    throw new Error(`Unexpected generic relation call: ${args.join(" ")}`);
  }
}

async function invoke(
  operation: "plan" | "execute",
  issueNumber: number,
  input: Record<string, unknown>,
  transportResponses: readonly FixtureCommandResult[],
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
        createAdapter: (options) => new GitHubAdapter({ ...options, transport: nativeTestTransport(transport) }),
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
  assert.ok(plan.generation);
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

test("issue relations plan fails closed when the repository Issue Canon does not govern relations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-issue-relations-"));
  try {
    const inputPath = path.join(directory, "input.json");
    await writeFile(inputPath, JSON.stringify({ desired: { parent: desiredParent, dependsOn: [] } }), "utf8");
    const ungovernedCanon = JSON.stringify({
      version: "1",
      kind: "issue",
      id: "default",
      properties: { title: { presence: "required", authority: { kind: "supplied" } } },
      fields: [],
    });
    class UngovernedTransport implements FixtureCommandTransport {
      readonly calls: string[][] = [];
      async run(args: readonly string[]): Promise<FixtureCommandResult> {
        this.calls.push([...args]);
        if (args[0] === "--version") return command("gh version 2.0");
        if (args[0] === "auth" && args[1] === "status") return command();
        if (args.includes("--jq")) return command("100000900\n");
        if (args.includes("repos/acme/repository-b") && args.includes("GET"))
          return command(JSON.stringify({ default_branch: "main" }));
        if (args.some((value) => value.includes("git/trees/")))
          return command(
            JSON.stringify({
              sha: "tree-sha",
              truncated: false,
              tree: [{ path: ".github/inari/issues/default.json", type: "blob", sha: "canon-sha" }],
            }),
          );
        if (args.some((value) => value.includes("git/blobs/canon-sha")))
          return command(
            JSON.stringify({
              sha: "canon-sha",
              encoding: "base64",
              content: Buffer.from(ungovernedCanon, "utf8").toString("base64"),
            }),
          );
        throw new Error(`Unexpected gh call: ${args.join(" ")}`);
      }
    }
    const transport = new UngovernedTransport();
    const lines: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (line: string) => lines.push(line);
      const exitCode = await runCli(
        [
          "issue",
          "relations",
          "plan",
          "701",
          "--repository",
          "acme/repository-b",
          "--from",
          inputPath,
          "--capability",
          "github.issue.parent.native",
          "--json",
        ],
        {
          repositoryRoot: directory,
          createAdapter: (options) => new GitHubAdapter({ ...options, transport: nativeTestTransport(transport) }),
        },
      );
      const output = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
      assert.equal(exitCode, 2);
      assert.equal(output.ok, false);
      assert.equal(
        transport.calls.some((args) => args.includes("POST")),
        false,
      );
    } finally {
      console.log = originalLog;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("issue relations execute reconciles a native parent effect through the governed executor", async () => {
  const result = await invoke(
    "execute",
    701,
    { desired: { parent: desiredParent, dependsOn: [] }, graph: closedGraph },
    [
      // planExistingIssueRelationReconciliation's own fresh parent
      // observation (blocked-by is handled generically above):
      command("HTTP/2 404 Not Found\n\n"),
      // LocalSemanticIssueRelationExecutor's independent re-observation before
      // effects: only parent, since dependsOn stays "none"-represented here.
      command("HTTP/2 404 Not Found\n\n"),
      // Live graph re-establishment: the new parent target's own current parent.
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
          createAdapter: (options) => new GitHubAdapter({ ...options, transport: nativeTestTransport(transport) }),
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

test("generic Issue relationship CLI inspects provider parent and direct children", async () => {
  const transport = new GenericRelationsTransport();
  const lines: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (line: string) => lines.push(line);
    const parentExit = await runCli(
      [
        "issue",
        "relations",
        "inspect-parent",
        "701",
        "--repository",
        "acme/repository-b",
        "--capability",
        "github.issue.parent.native",
        "--json",
      ],
      {
        repositoryRoot: "/tmp",
        createAdapter: (options) => new GitHubAdapter({ ...options, transport: nativeTestTransport(transport) }),
      },
    );
    assert.equal(parentExit, 0);
    const parentOutput = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
    assert.equal(parentOutput.operation, "issue.relations.inspect-parent");
    assert.equal((parentOutput.parent as Record<string, unknown>).number, 20);

    const childrenExit = await runCli(
      [
        "issue",
        "relations",
        "inspect-children",
        "20",
        "--repository",
        "acme/repository-b",
        "--capability",
        "github.issue.parent.native",
        "--json",
      ],
      {
        repositoryRoot: "/tmp",
        createAdapter: (options) => new GitHubAdapter({ ...options, transport: nativeTestTransport(transport) }),
      },
    );
    assert.equal(childrenExit, 0);
    const childrenOutput = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
    assert.equal(childrenOutput.operation, "issue.relations.inspect-children");
    assert.deepEqual(
      (childrenOutput.children as Array<Record<string, unknown>>).map((entry) => entry.number),
      [701],
    );
  } finally {
    console.log = originalLog;
  }
});

test("generic Issue relationship CLI mutates only through verified attach, detach, and reparent operations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-issue-relationship-cli-"));
  const transport = new GenericRelationsTransport();
  const inputPath = path.join(directory, "relationship.json");
  const lines: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (line: string) => lines.push(line);
    const invoke = async (operation: "attach" | "detach" | "reparent", input: Record<string, unknown>) => {
      await writeFile(inputPath, JSON.stringify(input), "utf8");
      return runCli(
        [
          "issue",
          "relations",
          operation,
          "702",
          "--repository",
          "acme/repository-b",
          "--from",
          inputPath,
          "--capability",
          "github.issue.parent.native",
          "--json",
        ],
        {
          repositoryRoot: directory,
          createAdapter: (options) => new GitHubAdapter({ ...options, transport: nativeTestTransport(transport) }),
        },
      );
    };
    assert.equal(await invoke("attach", { parent: 20 }), 0);
    assert.equal(transport.parentFor(702), 20);
    assert.equal(await invoke("detach", { parent: 20 }), 0);
    assert.equal(transport.parentFor(702), undefined);
    assert.equal(await invoke("attach", { parent: 20 }), 0);
    assert.equal(await invoke("reparent", { previousParent: 20, parent: 30 }), 0);
    assert.equal(transport.parentFor(702), 30);
    assert.equal(JSON.parse(lines.at(-1) ?? "{}").operation, "issue.relations.reparent");
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});
