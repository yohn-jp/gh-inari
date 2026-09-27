import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { GitHubAdapter, type RepositoryContext, type RepositoryTree } from "./github/index.js";

const context: RepositoryContext = {
  hostname: "github.com",
  host: "github.com",
  owner: "acme",
  name: "repository",
  nameWithOwner: "acme/repository",
  url: "https://github.com/acme/repository",
  repositoryId: "100000200",
};

const branchCanon = JSON.stringify({
  version: "1",
  kind: "branch",
  id: "default",
  properties: {
    name: { presence: "required", authority: { kind: "supplied" } },
    source: { presence: "required", authority: { kind: "fixed", value: "main" } },
  },
});

class BranchObservationAdapter extends GitHubAdapter {
  constructor(private readonly source: string) {
    super({ repository: "acme/repository" });
  }

  override async resolveRepositoryContext(): Promise<RepositoryContext> {
    return context;
  }

  override async getRepositoryDefaultBranch(): Promise<string> {
    return "main";
  }

  override async getRepositoryTree(_ref: string): Promise<RepositoryTree> {
    return {
      sha: "tree-sha",
      entries: [{ path: ".github/inari/branch.json", type: "blob", sha: "canon-sha" }],
    };
  }

  override async getRepositoryBlob(_sha: string): Promise<string> {
    return this.source;
  }

  override async findBranch(name: string) {
    return { name, ref: `refs/heads/${name}`, sha: "0123456789012345678901234567890123456789" };
  }
}

test("Canon branch routes preserve typed options and delegate observation to Core", async () => {
  const adapter = new BranchObservationAdapter(branchCanon);
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-semantic-observation-cli-"));
  const inputPath = path.join(directory, "input.json");
  await writeFile(inputPath, JSON.stringify({ name: "feat/example" }), "utf8");
  const lines: string[] = [];
  const repositoryOverrides: (string | undefined)[] = [];
  const originalLog = console.log;
  try {
    console.log = (line: string) => lines.push(line);
    const dependencies: Parameters<typeof runCli>[1] = {
      createAdapter: (options) => {
        repositoryOverrides.push(options?.repository);
        return adapter;
      },
    };
    const invocations: readonly (readonly string[])[] = [
      ["branch", "semantic", "check", "feat/example", "--from", inputPath, "--json"],
      ["--repository", "acme/repository", "--from", inputPath, "branch", "semantic", "check", "feat/example", "--json"],
      [
        "--repo",
        "acme/repository",
        "--template",
        "branch",
        "--from",
        inputPath,
        "branch",
        "check",
        "feat/example",
        "--json",
      ],
      ["-R", "acme/repository", "--from", inputPath, "branch", "check", "feat/example", "--json"],
    ];
    const results: Record<string, unknown>[] = [];
    for (const argv of invocations) {
      const previousLines = lines.length;
      const exitCode = await runCli([...argv], dependencies);
      assert.equal(exitCode, 0, lines.slice(previousLines).join("\n"));
      results.push(JSON.parse(lines[previousLines] ?? "{}") as Record<string, unknown>);
    }

    assert.deepEqual(
      results.map((output) => output.operation),
      ["branch.semantic.check", "branch.semantic.check", "branch.check", "branch.check"],
    );
    for (const output of results) {
      assert.equal(output.valid, true);
      assert.equal((output.diagnostics as unknown[]).length, 0);
      assert.equal((output.desired as Record<string, unknown>).name, "feat/example");
      assert.equal((output.observed as Record<string, unknown>).name, "feat/example");
    }
    assert.deepEqual(repositoryOverrides, [undefined, "acme/repository", "acme/repository", "acme/repository"]);
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("branch pre-route prefixes fail closed for unknown, incomplete, duplicate, and surplus input", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-semantic-observation-prefix-"));
  const inputPath = path.join(directory, "input.json");
  await writeFile(inputPath, JSON.stringify({ name: "feat/example" }), "utf8");
  let adapterCalls = 0;
  try {
    for (const argv of [
      ["--unknown", "value", "branch", "semantic", "check", "feat/example", "--from", inputPath, "--json"],
      ["--repository", "branch", "semantic", "check", "feat/example", "--from", inputPath, "--json"],
      [
        "--repo",
        "acme/repository",
        "-R",
        "acme/other",
        "branch",
        "semantic",
        "check",
        "feat/example",
        "--from",
        inputPath,
        "--json",
      ],
      ["branch", "semantic", "check", "feat/example", "--from", inputPath, "extra", "--json"],
    ]) {
      const results: { exitCode: number; stdout: string; stderr: string }[] = [];
      const exitCode = await runCli([...argv], {
        createAdapter: () => {
          adapterCalls += 1;
          throw new Error("invalid branch argv reached the semantic provider adapter");
        },
        writeResult: (result) => results.push(result),
      });
      assert.notEqual(exitCode, 0, argv.join(" "));
      assert.equal(results.length, 1, argv.join(" "));
    }
    assert.equal(adapterCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
