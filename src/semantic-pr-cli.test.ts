import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { type GhCommandResult, type GhTransport, type GhTransportOptions, GitHubAdapter } from "./github/index.js";

class SemanticPrTransport implements GhTransport {
  readonly calls: string[][] = [];
  private readonly responses: GhCommandResult[];

  constructor(source: string, treeEntries: readonly { readonly path: string; readonly sha: string }[]) {
    this.responses = [
      command("gh version 2.0"),
      command(),
      command("100000200\n"),
      command(JSON.stringify({ default_branch: "main" })),
      command(
        JSON.stringify({
          sha: "tree-sha-semantic-cli",
          truncated: false,
          tree: treeEntries.map((entry) => ({ ...entry, type: "blob" })),
        }),
      ),
      blobResponse(treeEntries[0]?.sha ?? "canon-sha", source),
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

function blobResponse(sha: string, source: string): GhCommandResult {
  return command(
    JSON.stringify({
      sha,
      encoding: "base64",
      content: Buffer.from(source, "utf8").toString("base64"),
    }),
  );
}

const issue = {
  repositoryHost: "github.com",
  repositoryId: "100000200",
  repository: "acme/repository-b",
  number: 285,
};

const derivedCanon = JSON.stringify({
  version: "1",
  kind: "pull_request",
  id: "derived",
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
    type: {
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { values: ["feat", "fix"] },
    },
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

const suppliedBranchCanon = JSON.stringify({
  version: "1",
  kind: "pull_request",
  id: "supplied-branch",
  properties: {
    title: { presence: "required", authority: { kind: "supplied" } },
    head: { presence: "required", authority: { kind: "supplied" } },
    base: { presence: "required", authority: { kind: "fixed", value: "main" } },
  },
  fields: [{ id: "summary", primitive: "text", presence: "required", authority: { kind: "supplied" } }],
});

function inputForDerived(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "feat",
    implements: [issue],
    summary: "Semantic PR",
    ...overrides,
  };
}

function inputForSuppliedBranch(): Record<string, unknown> {
  return { title: "Caller-named PR", head: "topic/from-caller", summary: "Supplied branch" };
}

async function invoke(
  operation: readonly string[],
  canon: string,
  input: Record<string, unknown> | undefined,
  capabilities: readonly string[] = [],
): Promise<{
  readonly exitCode: number;
  readonly output: Record<string, unknown>;
  readonly calls: readonly string[][];
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-semantic-pr-"));
  try {
    const inputPath = path.join(directory, "input.json");
    if (input !== undefined) await writeFile(inputPath, JSON.stringify(input), "utf8");
    const sourcePath = ".github/inari/canon/pull-requests/default.json";
    const transport = new SemanticPrTransport(canon, [{ path: sourcePath, sha: "canon-sha" }]);
    const lines: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (line: string) => lines.push(line);
      const argv = [
        "pr",
        ...operation,
        "default",
        "--repository",
        "acme/repository-b",
        ...(input === undefined ? [] : ["--from", inputPath]),
        ...capabilities.flatMap((capability) => ["--capability", capability]),
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

const closingReference = "github.pull_request.implements.closing-reference";

test("CLI resolves a derived PR Canon, materializes it, and previews a deterministic read-only plan", async () => {
  const first = await invoke(["plan"], derivedCanon, inputForDerived(), [closingReference]);
  const second = await invoke(["plan"], derivedCanon, inputForDerived(), [closingReference]);

  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  const plan = first.output.plan as Record<string, unknown>;
  const desired = plan.desired as Record<string, unknown>;
  assert.equal(desired.title, "feat: semantic-pr");
  assert.equal(desired.head, "feat/semantic-pr");
  assert.equal(desired.base, "main");
  assert.equal(first.output.preview, true);
  assert.equal(first.output.mutation, false);
  assert.equal(JSON.stringify(first.output), JSON.stringify(second.output));
  assert.equal(
    first.output.generation && (first.output.generation as Record<string, unknown>).treeSha,
    "tree-sha-semantic-cli",
  );
  assert.equal(
    (first.output.provenance as Record<string, unknown>).source &&
      ((first.output.provenance as Record<string, unknown>).source as Record<string, unknown>).path,
    ".github/inari/canon/pull-requests/default.json",
  );
  assert.equal(
    first.calls.some((args) => args.includes("pull_request.create")),
    false,
  );
  assert.equal(
    first.calls.some((args) => args.includes("git/refs")),
    false,
  );
  assert.equal(
    first.calls.some((args) => args.some((arg) => ["POST", "PATCH", "PUT", "DELETE"].includes(arg))),
    false,
  );
});

test("CLI exposes the exact Core caller schema and rejects derived, fixed, missing, and unknown input", async () => {
  const contract = await invoke(["contract"], derivedCanon, undefined, [closingReference]);
  assert.equal(contract.exitCode, 0);
  const effective = contract.output.effectiveContract as Record<string, unknown>;
  const schema = effective.inputSchema as Record<string, unknown>;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties as Record<string, unknown>), ["implements", "summary", "type"]);
  assert.deepEqual((schema.required as string[]).sort(), ["implements", "summary", "type"].sort());
  const properties = effective.properties as Record<string, Record<string, unknown>>;
  assert.equal((properties.title.authority as Record<string, unknown>).kind, "derived");
  assert.equal((properties.base.authority as Record<string, unknown>).kind, "fixed");
  assert.equal((effective.generation as Record<string, unknown>).treeSha, "tree-sha-semantic-cli");

  const missing = await invoke(["materialize"], derivedCanon, { type: "feat" });
  assert.equal(missing.exitCode, 2);
  assert.deepEqual(
    (missing.output.diagnostics as Array<Record<string, unknown>>).map((diagnostic) => diagnostic.code),
    ["INPUT_REQUIRED", "INPUT_REQUIRED", "DERIVATION_UNRESOLVED", "DERIVATION_UNRESOLVED", "DERIVATION_UNRESOLVED"],
  );

  const invalid = await invoke(
    ["materialize"],
    derivedCanon,
    inputForDerived({ title: "override", head: "override", base: "develop", unknown: "value" }),
  );
  assert.equal(invalid.exitCode, 2);
  assert.deepEqual(
    (invalid.output.diagnostics as Array<Record<string, unknown>>).map((diagnostic) => diagnostic.code),
    ["INPUT_AUTHORITY", "INPUT_AUTHORITY", "INPUT_AUTHORITY", "INPUT_UNKNOWN_FIELD"],
  );
});

test("CLI preserves repository-selectable supplied branch authority through the plan", async () => {
  const result = await invoke(["semantic", "plan"], suppliedBranchCanon, inputForSuppliedBranch());
  assert.equal(result.exitCode, 0);
  const plan = result.output.plan as Record<string, unknown>;
  const desired = plan.desired as Record<string, unknown>;
  assert.equal(desired.head, "topic/from-caller");
  assert.equal(desired.title, "Caller-named PR");
  assert.equal(desired.base, "main");
});
