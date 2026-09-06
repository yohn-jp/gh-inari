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

test("semantic Branch CLI check delegates Canon, projection, observation, and comparison to Core", async () => {
  const adapter = new BranchObservationAdapter(branchCanon);
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-semantic-observation-cli-"));
  const inputPath = path.join(directory, "input.json");
  await writeFile(inputPath, JSON.stringify({ name: "feat/example" }), "utf8");
  const lines: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (line: string) => lines.push(line);
    const exitCode = await runCli(["branch", "semantic", "check", "feat/example", "--from", inputPath, "--json"], {
      createAdapter: () => adapter,
    });
    assert.equal(exitCode, 0, lines.join("\n"));
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
  const output = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(output.operation, "branch.semantic.check");
  assert.equal(output.valid, true);
  assert.equal((output.diagnostics as unknown[]).length, 0);
  assert.equal((output.desired as Record<string, unknown>).name, "feat/example");
  assert.equal((output.observed as Record<string, unknown>).name, "feat/example");
});
