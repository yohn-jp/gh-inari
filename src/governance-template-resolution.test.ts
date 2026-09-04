import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  compileLocalGovernedContract,
  compileRepositoryGovernedContract,
  verifyGovernedMutationFreshness,
} from "./governance.js";
import { GitHubAdapter, type GhCommandResult, type GhTransport, type GhTransportOptions } from "./github/index.js";
import { TemplateResolutionError } from "./template-resolver.js";

const ISSUE_TEMPLATE = `name: Template
description: Template
body:
  - type: input
    id: summary
    attributes:
      label: Summary
`;

const PR_TEMPLATE = "## Summary\n\nTemplate summary.\n";

class StubTransport implements GhTransport {
  readonly calls: readonly string[][];
  private readonly history: string[][] = [];
  private readonly responses: GhCommandResult[];

  constructor(responses: readonly GhCommandResult[]) {
    this.responses = [...responses];
    this.calls = this.history;
  }

  async run(args: readonly string[], _options?: GhTransportOptions): Promise<GhCommandResult> {
    this.history.push([...args]);
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    return response;
  }
}

function command(stdout = "", exitCode = 0, stderr = ""): GhCommandResult {
  return { stdout, exitCode, stderr };
}

function blobResponse(sha: string, source: string): GhCommandResult {
  return command(JSON.stringify({ sha, encoding: "base64", content: Buffer.from(source, "utf8").toString("base64") }));
}

function remoteResponses(
  issue: boolean,
  config: string,
  selectedPath: string,
  selectedSha: string,
  selectedSource: string,
): GhCommandResult[] {
  const templateEntries = issue
    ? [
        { path: ".github/ISSUE_TEMPLATE/bug.yml", type: "blob", sha: "bug-sha" },
        { path: ".github/ISSUE_TEMPLATE/feature.yml", type: "blob", sha: selectedSha },
      ]
    : [
        { path: ".github/PULL_REQUEST_TEMPLATE/default.md", type: "blob", sha: "default-sha" },
        { path: ".github/PULL_REQUEST_TEMPLATE/release.md", type: "blob", sha: selectedSha },
      ];
  return [
    command("gh version 2.0"),
    command(),
    command("100000200\n"),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: "tree-sha",
        truncated: false,
        tree: [...templateEntries, { path: ".github/inari/template-resolution.yml", type: "blob", sha: "config-sha" }],
      }),
    ),
    blobResponse("config-sha", config),
    ...(selectedPath.length === 0 ? [] : [blobResponse(selectedSha, selectedSource)]),
  ];
}

async function compileRemote(
  domain: "issue" | "pr",
  responses: readonly GhCommandResult[],
): Promise<Awaited<ReturnType<typeof compileLocalGovernedContract>>> {
  return compileRepositoryGovernedContract(
    new GitHubAdapter({ repository: "acme/repository", transport: new StubTransport(responses) }),
    domain,
  );
}

test("Issue and PR local compile paths use the same configured-default resolver", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-inari-template-resolution-"));
  try {
    await mkdir(path.join(root, ".github/ISSUE_TEMPLATE"), { recursive: true });
    await mkdir(path.join(root, ".github/PULL_REQUEST_TEMPLATE"), { recursive: true });
    await writeFile(path.join(root, ".github/ISSUE_TEMPLATE/bug.yml"), ISSUE_TEMPLATE);
    await writeFile(path.join(root, ".github/ISSUE_TEMPLATE/feature.yml"), ISSUE_TEMPLATE);
    await writeFile(path.join(root, ".github/PULL_REQUEST_TEMPLATE/default.md"), PR_TEMPLATE);
    await writeFile(path.join(root, ".github/PULL_REQUEST_TEMPLATE/release.md"), PR_TEMPLATE);
    await mkdir(path.join(root, ".github/inari"), { recursive: true });
    await writeFile(
      path.join(root, ".github/inari/template-resolution.yml"),
      "version: 1\ndefaults:\n  issue: feature\n  pr: release\n",
    );

    const issue = await compileLocalGovernedContract("issue", root);
    const pullRequest = await compileLocalGovernedContract("pr", root);
    assert.equal(issue.templateIdentity.path, ".github/ISSUE_TEMPLATE/feature.yml");
    assert.equal(pullRequest.templateIdentity.path, ".github/PULL_REQUEST_TEMPLATE/release.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Issue and PR repository compile paths read the same remote default authority", async () => {
  const config = "version: 1\ndefaults:\n  issue: feature\n  pr: release\n";
  const issue = await compileRemote(
    "issue",
    remoteResponses(true, config, ".github/ISSUE_TEMPLATE/feature.yml", "feature-sha", ISSUE_TEMPLATE),
  );
  const pullRequest = await compileRemote(
    "pr",
    remoteResponses(false, config, ".github/PULL_REQUEST_TEMPLATE/release.md", "release-sha", PR_TEMPLATE),
  );
  assert.equal(issue.templateIdentity.path, ".github/ISSUE_TEMPLATE/feature.yml");
  assert.equal(pullRequest.templateIdentity.path, ".github/PULL_REQUEST_TEMPLATE/release.md");
  assert.equal(issue.provenance?.templateResolution?.path, ".github/inari/template-resolution.yml");
  assert.equal(pullRequest.provenance?.templateResolution?.path, ".github/inari/template-resolution.yml");
});

test("explicit remote selection records an existing resolution config for freshness without applying it", async () => {
  const config = "version: 1\ndefaults:\n  issue: feature\n";
  const tree = (sha: string) =>
    command(
      JSON.stringify({
        sha,
        truncated: false,
        tree: [
          { path: ".github/ISSUE_TEMPLATE/bug.yml", type: "blob", sha: "bug-sha" },
          { path: ".github/ISSUE_TEMPLATE/feature.yml", type: "blob", sha: "feature-sha" },
          { path: ".github/inari/template-resolution.yml", type: "blob", sha: "config-sha" },
        ],
      }),
    );
  const transport = new StubTransport([
    command("gh version 2.0"),
    command(),
    command("100000200\n"),
    command(JSON.stringify({ default_branch: "main" })),
    tree("tree-a"),
    blobResponse("config-sha", config),
    blobResponse("bug-sha", ISSUE_TEMPLATE),
    command(JSON.stringify({ default_branch: "main" })),
    tree("tree-b"),
  ]);
  const adapter = new GitHubAdapter({
    repository: "acme/repository",
    transport,
  });

  const contract = await compileRepositoryGovernedContract(adapter, "issue", "bug");
  assert.equal(contract.templateIdentity.id, "bug");
  assert.equal(contract.provenance?.templateResolution?.sha, "config-sha");
  await verifyGovernedMutationFreshness(adapter, contract.provenance as NonNullable<typeof contract.provenance>);
});

test("explicit local template selection bypasses an invalid omitted-selector config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-inari-template-resolution-"));
  try {
    await mkdir(path.join(root, ".github/ISSUE_TEMPLATE"), { recursive: true });
    await writeFile(path.join(root, ".github/ISSUE_TEMPLATE/bug.yml"), ISSUE_TEMPLATE);
    await mkdir(path.join(root, ".github/inari"), { recursive: true });
    await writeFile(path.join(root, ".github/inari/template-resolution.yml"), "version: 1\ndefaults:\n  issue: ''\n");

    const contract = await compileLocalGovernedContract("issue", root, "bug");
    assert.equal(contract.templateIdentity.path, ".github/ISSUE_TEMPLATE/bug.yml");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unavailable local configured default fails closed before template compilation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-inari-template-resolution-"));
  try {
    await mkdir(path.join(root, ".github/ISSUE_TEMPLATE"), { recursive: true });
    await writeFile(path.join(root, ".github/ISSUE_TEMPLATE/bug.yml"), ISSUE_TEMPLATE);
    await mkdir(path.join(root, ".github/inari"), { recursive: true });
    await writeFile(
      path.join(root, ".github/inari/template-resolution.yml"),
      "version: 1\ndefaults:\n  issue: missing\n",
    );

    await assert.rejects(
      compileLocalGovernedContract("issue", root),
      (error: unknown) =>
        error instanceof TemplateResolutionError && error.code === "TEMPLATE_RESOLUTION_DEFAULT_UNAVAILABLE",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
