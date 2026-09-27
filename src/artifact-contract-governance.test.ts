import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  ArtifactContractResolutionError,
  compileRepositoryEffectiveArtifactContract,
  compileRepositoryEffectiveArtifactContracts,
} from "./artifact-contract-governance.js";
import { GitHubAdapter, type RepositoryTreeEntry } from "./github/index.js";
import {
  nativeTestTransport,
  type FixtureCommandResult,
  type FixtureCommandTransport,
  type FixtureCommandOptions,
} from "./github/test-native-transport.test.js";
import { parseSemanticTemplate, renderSemanticNative } from "./semantic-template.js";

class StubTransport implements FixtureCommandTransport {
  private readonly responses: Array<FixtureCommandResult | Error>;

  constructor(responses: Array<FixtureCommandResult | Error>) {
    this.responses = [...responses];
  }

  async run(args: readonly string[], _options?: FixtureCommandOptions): Promise<FixtureCommandResult> {
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    if (response instanceof Error) throw response;
    return response;
  }
}

function command(stdout = "", exitCode = 0, stderr = ""): FixtureCommandResult {
  return { stdout, exitCode, stderr };
}

function blob(sha: string, source: string): FixtureCommandResult {
  return command(JSON.stringify({ sha, encoding: "base64", content: Buffer.from(source, "utf8").toString("base64") }));
}

function adapter(
  entries: readonly RepositoryTreeEntry[],
  responses: readonly (FixtureCommandResult | Error)[],
  treeSha = "tree-sha",
): GitHubAdapter {
  return new GitHubAdapter({
    repository: "acme/repository",
    transport: nativeTestTransport(
      new StubTransport([
        command("gh version 2.0"),
        command(),
        command("100000200\n"),
        command(JSON.stringify({ default_branch: "main" })),
        command(JSON.stringify({ sha: treeSha, truncated: false, tree: entries })),
        ...responses,
      ]),
    ),
  });
}

function semanticIssue(id = "bug"): {
  readonly path: string;
  readonly generatedPath: string;
  readonly source: string;
  readonly native: string;
} {
  const path = `.github/inari/issues/${id}.json`;
  const generatedPath = `.github/ISSUE_TEMPLATE/${id}.yml`;
  const source = JSON.stringify({
    version: 1,
    kind: "issue",
    id,
    name: "Bug report",
    description: "Report a bug.",
    sections: [{ id: "summary", kind: "input", type: "string", label: "Summary", required: true }],
  });
  const native = renderSemanticNative(parseSemanticTemplate(source, path), generatedPath);
  return { path, generatedPath, source, native };
}

function semanticPullRequest(): {
  readonly path: string;
  readonly generatedPath: string;
  readonly source: string;
  readonly native: string;
} {
  const path = ".github/inari/pull-request.json";
  const generatedPath = ".github/PULL_REQUEST_TEMPLATE.md";
  const source = JSON.stringify({
    version: 1,
    kind: "pull_request",
    id: "pull-request",
    name: "Pull request",
    sections: [{ id: "summary", kind: "input", type: "string", label: "Summary", required: true }],
  });
  const native = renderSemanticNative(parseSemanticTemplate(source, path), generatedPath);
  return { path, generatedPath, source, native };
}

function assertResolutionError(error: unknown, expectedPath: string): asserts error is ArtifactContractResolutionError {
  assert.ok(error instanceof ArtifactContractResolutionError);
  assert.equal(error.code, "ARTIFACT_CONTRACT_SOURCE_INVALID");
  assert.equal(error.path, expectedPath);
}

test("selected numeric-v1 Issue semantic JSON compiles through Artifact Contract v2 with source provenance", async () => {
  const semantic = semanticIssue();
  const result = await compileRepositoryEffectiveArtifactContract(
    adapter(
      [
        { path: semantic.path, type: "blob", sha: "semantic-sha" },
        { path: semantic.generatedPath, type: "blob", sha: "native-sha" },
      ],
      [blob("semantic-sha", semantic.source), blob("native-sha", semantic.native)],
      "issue-tree",
    ),
    "issue",
    "bug",
  );

  assert.equal(result.artifactContractVersion, "2");
  assert.equal(result.kind, "issue");
  assert.equal(result.id, "bug");
  assert.equal(result.provenance.treeSha, "issue-tree");
  assert.equal(result.provenance.source.path, semantic.path);
  assert.equal(result.provenance.source.sha, "semantic-sha");
  assert.equal(result.provenance.source.digest, createHash("sha256").update(semantic.source, "utf8").digest("hex"));
  assert.equal(result.inputSchema.properties.summary !== undefined, true);
});

test("selected numeric-v1 Pull Request semantic JSON compiles through Artifact Contract v2", async () => {
  const semantic = semanticPullRequest();
  const result = await compileRepositoryEffectiveArtifactContract(
    adapter(
      [
        { path: semantic.path, type: "blob", sha: "semantic-pr-sha" },
        { path: semantic.generatedPath, type: "blob", sha: "native-pr-sha" },
      ],
      [blob("semantic-pr-sha", semantic.source), blob("native-pr-sha", semantic.native)],
      "pr-tree",
    ),
    "pull_request",
    "pull-request",
  );

  assert.equal(result.artifactContractVersion, "2");
  assert.equal(result.kind, "pull_request");
  assert.equal(result.id, "pull-request");
  assert.equal(result.provenance.treeSha, "pr-tree");
  assert.equal(result.provenance.source.path, semantic.path);
});

test("plural numeric-v1 discovery compiles semantic siblings and retains malformed siblings as failures", async () => {
  const valid = semanticIssue("valid");
  const invalidPath = ".github/inari/issues/invalid.json";
  const invalidSource = JSON.stringify({
    version: 1,
    kind: "issue",
    id: "invalid",
    name: "Invalid",
    description: "Invalid source.",
    sections: [],
  });
  const outcomes = await compileRepositoryEffectiveArtifactContracts(
    adapter(
      [
        { path: invalidPath, type: "blob", sha: "invalid-sha" },
        { path: valid.path, type: "blob", sha: "valid-sha" },
        { path: valid.generatedPath, type: "blob", sha: "valid-native-sha" },
      ],
      [blob("invalid-sha", invalidSource), blob("valid-sha", valid.source), blob("valid-native-sha", valid.native)],
    ),
    "issue",
  );

  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ["failed", "compiled"],
  );
  assert.equal(
    outcomes[0]?.status === "failed" ? outcomes[0].failureCode : undefined,
    "ARTIFACT_CONTRACT_SOURCE_INVALID",
  );
  assert.equal(outcomes[1]?.status === "compiled" ? outcomes[1].contract.artifactContractVersion : undefined, "2");
});

test("plural numeric-v1 Pull Request discovery uses the same native projection check", async () => {
  const semantic = semanticPullRequest();
  const outcomes = await compileRepositoryEffectiveArtifactContracts(
    adapter(
      [
        { path: semantic.path, type: "blob", sha: "semantic-pr-sha" },
        { path: semantic.generatedPath, type: "blob", sha: "native-pr-sha" },
      ],
      [blob("semantic-pr-sha", semantic.source), blob("native-pr-sha", semantic.native)],
      "pr-tree",
    ),
    "pull_request",
  );

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.status, "compiled");
  assert.equal(outcomes[0]?.status === "compiled" ? outcomes[0].contract.artifactContractVersion : undefined, "2");
});

test("numeric-v1 source fails closed when its committed native projection is missing, non-file, drifted, or unavailable", async () => {
  const semantic = semanticIssue();

  await assert.rejects(
    compileRepositoryEffectiveArtifactContract(
      adapter([{ path: semantic.path, type: "blob", sha: "semantic-sha" }], [blob("semantic-sha", semantic.source)]),
      "issue",
      "bug",
    ),
    (error: unknown) => {
      assertResolutionError(error, semantic.generatedPath);
      return /not found/u.test(error.message);
    },
  );

  await assert.rejects(
    compileRepositoryEffectiveArtifactContract(
      adapter(
        [
          { path: semantic.path, type: "blob", sha: "semantic-sha" },
          { path: semantic.generatedPath, type: "tree", sha: "native-tree-sha" },
        ],
        [blob("semantic-sha", semantic.source)],
      ),
      "issue",
      "bug",
    ),
    (error: unknown) => {
      assertResolutionError(error, semantic.generatedPath);
      return /not a regular file/u.test(error.message);
    },
  );

  await assert.rejects(
    compileRepositoryEffectiveArtifactContract(
      adapter(
        [
          { path: semantic.path, type: "blob", sha: "semantic-sha" },
          { path: semantic.generatedPath, type: "blob", sha: "native-sha" },
        ],
        [blob("semantic-sha", semantic.source), blob("native-sha", `${semantic.native}drift`)],
      ),
      "issue",
      "bug",
    ),
    (error: unknown) => {
      assertResolutionError(error, semantic.generatedPath);
      return /does not match/u.test(error.message);
    },
  );

  await assert.rejects(
    compileRepositoryEffectiveArtifactContract(
      adapter(
        [
          { path: semantic.path, type: "blob", sha: "semantic-sha" },
          { path: semantic.generatedPath, type: "blob", sha: "native-sha" },
        ],
        [blob("semantic-sha", semantic.source), new Error("projection blob unavailable")],
      ),
      "issue",
      "bug",
    ),
    (error: unknown) => error instanceof Error && /Unable to complete the native GitHub request/u.test(error.message),
  );
});

test("string-version v1/v2 Issue contracts and string-version Branch contracts retain direct parsing", async () => {
  const directV1 = JSON.stringify({
    version: "1",
    kind: "issue",
    id: "legacy-v1",
    properties: { title: { presence: "required", authority: { kind: "supplied" } } },
  });
  const directV2 = JSON.stringify({
    version: "2",
    kind: "issue",
    id: "native-v2",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { summary: { type: "string" } },
      additionalProperties: false,
    },
    bindings: { "/summary": { authority: { kind: "supplied" } } },
  });
  const branch = JSON.stringify({
    version: "1",
    kind: "branch",
    id: "branch-default",
    properties: {
      type: { presence: "required", authority: { kind: "supplied" }, constraints: { values: ["feat", "fix"] } },
      issue: { presence: "required", authority: { kind: "supplied" } },
      slug: { presence: "required", authority: { kind: "supplied" }, constraints: { minLength: 1 } },
      name: {
        presence: "required",
        authority: { kind: "derived", derive: { op: "format", template: "{type}/{issue.number}-{slug}" } },
      },
      source: { presence: "required", authority: { kind: "fixed", value: "main" } },
    },
  });

  const v1 = await compileRepositoryEffectiveArtifactContract(
    adapter([{ path: ".github/inari/issues/legacy-v1.json", type: "blob", sha: "v1-sha" }], [blob("v1-sha", directV1)]),
    "issue",
    "legacy-v1",
  );
  const v2 = await compileRepositoryEffectiveArtifactContract(
    adapter([{ path: ".github/inari/issues/native-v2.json", type: "blob", sha: "v2-sha" }], [blob("v2-sha", directV2)]),
    "issue",
    "native-v2",
  );
  const branchResult = await compileRepositoryEffectiveArtifactContract(
    adapter([{ path: ".github/inari/branch.json", type: "blob", sha: "branch-sha" }], [blob("branch-sha", branch)]),
    "branch",
    "branch",
  );

  assert.equal(v1.artifactContractVersion, "1");
  assert.equal(v2.artifactContractVersion, "2");
  assert.equal(branchResult.artifactContractVersion, "1");
  assert.equal(branchResult.kind, "branch");
});

test("numeric-v1 malformed semantic source reports bounded source diagnostics", async () => {
  const path = ".github/inari/issues/invalid.json";
  const source = JSON.stringify({
    version: 1,
    kind: "issue",
    id: "invalid",
    name: "Invalid",
    description: "Invalid source.",
    sections: [],
  });

  await assert.rejects(
    compileRepositoryEffectiveArtifactContract(
      adapter([{ path, type: "blob", sha: "invalid-sha" }], [blob("invalid-sha", source)]),
      "issue",
      "invalid",
    ),
    (error: unknown) => {
      assertResolutionError(error, path);
      assert.ok(error.diagnostics.length <= 8);
      return true;
    },
  );
});
