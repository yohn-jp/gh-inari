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

class SemanticIssueTransport implements FixtureCommandTransport {
  readonly calls: string[][] = [];
  private readonly responses: FixtureCommandResult[];

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

  async run(args: readonly string[], _options?: FixtureCommandOptions): Promise<FixtureCommandResult> {
    this.calls.push([...args]);
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    return response;
  }
}

class AmbiguousSemanticContractTransport implements FixtureCommandTransport {
  private readonly responses: FixtureCommandResult[];

  constructor(kind: "issue" | "pull_request", sources: readonly { id: string; source: string }[]) {
    const directory = kind === "issue" ? ".github/inari/issues" : ".github/inari/pull-requests";
    const entries = sources.map(({ id }) => ({
      path: `${directory}/${id}.json`,
      type: "blob",
      sha: `${id}-sha`,
    }));
    const tree = JSON.stringify({ sha: "tree-sha-semantic-ambiguous", truncated: false, tree: entries });
    this.responses = [
      command("gh version 2.0"),
      command(),
      command("100000201\n"),
      command(JSON.stringify({ default_branch: "main" })),
      command(tree),
      command(JSON.stringify({ default_branch: "main" })),
      command(tree),
      ...sources.map(({ id, source }) =>
        command(
          JSON.stringify({
            sha: `${id}-sha`,
            encoding: "base64",
            content: Buffer.from(source, "utf8").toString("base64"),
          }),
        ),
      ),
    ];
  }

  async run(args: readonly string[], _options?: FixtureCommandOptions): Promise<FixtureCommandResult> {
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    return response;
  }
}

function command(stdout = "", exitCode = 0, stderr = ""): FixtureCommandResult {
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

test("read-only semantic contract discovery returns every ambiguous Issue and PR Canon", async () => {
  for (const [domain, kind] of [
    ["issue", "issue"],
    ["pr", "pull_request"],
  ] as const) {
    const makeSource = (id: string) => {
      const source = JSON.parse(issueCanon) as Record<string, unknown>;
      source.kind = kind;
      source.id = id;
      if (kind === "pull_request") {
        source.properties = {
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
        };
      }
      return JSON.stringify(source);
    };
    const transport = new AmbiguousSemanticContractTransport(kind, [
      { id: "bug", source: makeSource("bug") },
      { id: "feature", source: makeSource("feature") },
    ]);
    const lines: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (line: string) => lines.push(line);
      const exitCode = await runCli([domain, "contract", "--repository", "acme/repository-b", "--json"], {
        repositoryRoot: "/tmp",
        createAdapter: (options) => new GitHubAdapter({ ...options, transport: nativeTestTransport(transport) }),
      });
      assert.equal(exitCode, 0, domain);
      const output = JSON.parse(lines.at(-1) ?? "{}") as {
        templates?: readonly { status?: string; id?: string; template?: { id?: string } }[];
      };
      assert.deepEqual(
        output.templates?.map((entry) => [entry.status, entry.id, entry.template?.id]),
        [
          ["compiled", "bug", "bug"],
          ["compiled", "feature", "feature"],
        ],
        domain,
      );
    } finally {
      console.log = originalLog;
    }
  }
});
