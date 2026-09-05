import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  compileRepositoryGovernedContract,
  createGovernedIssue,
  createGovernedPullRequest,
  discoverRepositoryTemplates,
  GovernanceError,
  rejectGovernedPolicyOverride,
  updateGovernedIssue,
  updateGovernedPullRequest,
} from "./governance.js";
import { type GhCommandResult, type GhTransport, type GhTransportOptions, GitHubAdapter } from "./github/index.js";
import { deserializeCanonicalContract, serializeCanonicalContract } from "./contract/index.js";
import { prepareIssueArtifact, preparePullRequestArtifact } from "./artifact.js";
import { runCli } from "./cli.js";
import { normalizeSemanticTemplate, renderSemanticNative } from "./semantic-template.js";
import { PullRequestPolicyError } from "./pr-policy.js";
import { DEFAULT_RELEASE_BRANCH_PATTERN } from "./branch-governance.js";

class StubGovernanceTransport implements GhTransport {
  readonly calls: readonly string[][];
  private readonly history: string[][] = [];
  private readonly responses: Array<GhCommandResult | Error>;

  constructor(responses: Array<GhCommandResult | Error>) {
    this.responses = [...responses];
    this.calls = this.history;
  }

  async run(args: readonly string[], _options?: GhTransportOptions): Promise<GhCommandResult> {
    this.history.push([...args]);
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    if (response instanceof Error) throw response;
    return response;
  }
}

function command(stdout = "", exitCode = 0, stderr = ""): GhCommandResult {
  return { stdout, exitCode, stderr };
}

function issueTemplate(fieldId: string, label = "Remote field"): string {
  return `name: Remote\ndescription: Remote governance\nbody:\n  - type: input\n    id: ${fieldId}\n    attributes:\n      label: ${label}\n    validations:\n      required: true\n`;
}

function blobResponse(sha: string, content: string): GhCommandResult {
  return command(
    JSON.stringify({
      sha,
      encoding: "base64",
      content: Buffer.from(content, "utf8").toString("base64"),
    }),
  );
}

function governanceResponses(
  templatePath: string,
  templateSha: string,
  templateSource: string,
  extraTreeEntries: readonly Record<string, string>[] = [],
  treeSha = "tree-sha-a",
): GhCommandResult[] {
  return [
    command("gh version 2.0"),
    command(),
    command("100000200\n"),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: treeSha,
        truncated: false,
        tree: [
          { path: templatePath, type: "blob", sha: templateSha },
          ...extraTreeEntries.map((entry) => ({ ...entry })),
        ],
      }),
    ),
    blobResponse(templateSha, templateSource),
  ];
}

function adapterFor(responses: GhCommandResult[], cwd: string, repository = "acme/repository-b"): GitHubAdapter {
  return new GitHubAdapter({ cwd, repository, transport: new StubGovernanceTransport(responses) });
}

test("governance is bound to the repository override, not the CWD repository", async () => {
  const source = issueTemplate("remote_field");
  const transport = new StubGovernanceTransport(
    governanceResponses(".github/ISSUE_TEMPLATE/remote.yml", "remote-sha", source),
  );
  const contract = await compileRepositoryGovernedContract(
    new GitHubAdapter({ cwd: "/workspace/repository-a/.github", repository: "acme/repository-b", transport }),
    "issue",
    "remote",
  );

  assert.equal(contract.sections[0]?.fields[0]?.id, "remote_field");
  assert.deepEqual(contract.provenance?.repository, {
    host: "github.com",
    owner: "acme",
    name: "repository-b",
    nameWithOwner: "acme/repository-b",
    repositoryId: "100000200",
  });
  assert.equal(contract.provenance?.ref, "main");
  assert.equal(contract.provenance?.treeSha, "tree-sha-a");
  assert.equal(contract.provenance?.template.path, ".github/ISSUE_TEMPLATE/remote.yml");
  assert.equal(contract.provenance?.template.sha, "remote-sha");
  assert.equal(contract.provenance?.template.digest, createHash("sha256").update(source).digest("hex"));
  assert.ok(transport.calls.every((args) => !args.includes("repository-a")));
});

test("the same target yields the same governed contract from different nested CWDs", async () => {
  const source = issueTemplate("stable_field");
  const first = new StubGovernanceTransport(
    governanceResponses(".github/ISSUE_TEMPLATE/remote.yml", "stable-sha", source),
  );
  const second = new StubGovernanceTransport(
    governanceResponses(".github/ISSUE_TEMPLATE/remote.yml", "stable-sha", source),
  );
  const firstContract = await compileRepositoryGovernedContract(
    new GitHubAdapter({ cwd: "/tmp/nested/false/.github", repository: "acme/repository-b", transport: first }),
    "issue",
    "remote",
  );
  const secondContract = await compileRepositoryGovernedContract(
    new GitHubAdapter({ cwd: "/tmp/another/nested/.github", repository: "acme/repository-b", transport: second }),
    "issue",
    "remote",
  );

  assert.equal(serializeCanonicalContract(firstContract), serializeCanonicalContract(secondContract));
});

test("authoritative discovery matches all supported native PR template locations", async () => {
  const paths = [
    "PULL_REQUEST_TEMPLATE.MD",
    "docs/pull_request_template.txt",
    ".github/PuLl_ReQuEsT_TeMpLaTe.TxT",
    "PULL_REQUEST_TEMPLATE/release.MD",
    "docs/PULL_REQUEST_TEMPLATE/docs.txt",
    ".github/PULL_REQUEST_TEMPLATE/security.md",
  ];
  const transport = new StubGovernanceTransport([
    command("gh version 2.0"),
    command(),
    command("100000200\n"),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: "tree-sha-a",
        truncated: false,
        tree: paths.map((path, index) => ({ path, type: "blob", sha: `sha-${index}` })),
      }),
    ),
  ]);

  const discovery = await discoverRepositoryTemplates(
    new GitHubAdapter({ repository: "acme/repository-b", transport }),
  );
  assert.deepEqual(
    discovery.pullRequestTemplates.map(({ path }) => path),
    [
      ".github/PuLl_ReQuEsT_TeMpLaTe.TxT",
      "PULL_REQUEST_TEMPLATE.MD",
      "docs/pull_request_template.txt",
      ".github/PULL_REQUEST_TEMPLATE/security.md",
      "PULL_REQUEST_TEMPLATE/release.MD",
      "docs/PULL_REQUEST_TEMPLATE/docs.txt",
    ],
  );
});

test("nested remote governance paths fail closed", async () => {
  const transport = new StubGovernanceTransport(
    governanceResponses(".github/ISSUE_TEMPLATE/remote.yml", "remote-sha", issueTemplate("remote_field"), [
      { path: ".github/ISSUE_TEMPLATE/nested/other.yml", type: "blob", sha: "other-sha" },
    ]),
  );
  await assert.rejects(
    compileRepositoryGovernedContract(
      new GitHubAdapter({ repository: "acme/repository-b", transport }),
      "issue",
      "remote",
    ),
    (error: unknown) => error instanceof GovernanceError && error.code === "GOVERNANCE_SOURCE_INVALID",
  );
  assert.equal(transport.calls.length, 5);
});

test("missing or unavailable remote governance never falls back to local files", async () => {
  const transport = new StubGovernanceTransport([
    command("gh version 2.0"),
    command(),
    command("100000200\n"),
    command(JSON.stringify({ default_branch: "main" })),
    command("", 1, "offline"),
  ]);
  await assert.rejects(
    compileRepositoryGovernedContract(
      new GitHubAdapter({ cwd: "/workspace/stale-copy", repository: "acme/repository-b", transport }),
      "issue",
      "remote",
    ),
    (error: unknown) => error instanceof GovernanceError && error.code === "GOVERNANCE_SOURCE_UNAVAILABLE",
  );
});

test("governed provenance survives canonical contract serialization", async () => {
  const contract = await compileRepositoryGovernedContract(
    adapterFor(governanceResponses(".github/ISSUE_TEMPLATE/remote.yml", "remote-sha", issueTemplate("field")), "/tmp"),
    "issue",
    "remote",
  );
  const roundTripped = deserializeCanonicalContract(serializeCanonicalContract(contract));
  assert.deepEqual(roundTripped.provenance, contract.provenance);
});

test("remote schema output exposes repository and trusted source provenance", async () => {
  const transport = new StubGovernanceTransport(
    governanceResponses(".github/ISSUE_TEMPLATE/remote.yml", "remote-sha", issueTemplate("remote_field")),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["issue", "schema", "remote", "--repository", "acme/repository-b", "--json"], {
      repositoryRoot: "/tmp/stale-copy",
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    const output = JSON.parse(lines[0] ?? "{}") as {
      contract?: { provenance?: { repository?: { nameWithOwner?: string }; ref?: string } };
      rendering?: { provenance?: { template?: { sha?: string } } };
    };
    assert.equal(exitCode, 0);
    assert.equal(output.contract?.provenance?.repository?.nameWithOwner, "acme/repository-b");
    assert.equal(output.contract?.provenance?.ref, "main");
    assert.equal(output.rendering?.provenance?.template?.sha, "remote-sha");
  } finally {
    console.log = originalLog;
  }
});

test("createGovernedIssue mutates when the default branch advances without changing governance content", async () => {
  const source = issueTemplate("remote_field");
  const unchangedTree = command(
    JSON.stringify({
      sha: "tree-sha-b",
      truncated: false,
      tree: [{ path: ".github/ISSUE_TEMPLATE/remote.yml", type: "blob", sha: "remote-sha" }],
    }),
  );
  const transport = new StubGovernanceTransport([
    ...governanceResponses(".github/ISSUE_TEMPLATE/remote.yml", "remote-sha", source, [], "tree-sha-a"),
    command(JSON.stringify({ default_branch: "main" })),
    unchangedTree,
    command(
      JSON.stringify({
        number: 50,
        title: "Remote issue",
        body: "### Remote field\n\nvalue\n",
        state: "open",
        html_url: "https://github.com/acme/repository-b/issues/50",
        labels: [],
        assignees: [],
      }),
    ),
    command(JSON.stringify({ default_branch: "main" })),
    unchangedTree,
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/repository-b", transport });
  const contract = await compileRepositoryGovernedContract(adapter, "issue", "remote");
  assert.equal(contract.provenance?.treeSha, "tree-sha-a");
  const prepared = prepareIssueArtifact(contract, {
    fields: { remote_field: "value" },
    metadata: { title: "Remote issue" },
  }).artifact;

  const created = await createGovernedIssue(adapter, prepared);
  assert.equal(created.artifact.number, 50);
  assert.equal(created.governance.reconciled, true);
  assert.equal(created.governance.validatedGeneration, "tree-sha-a");
  assert.equal(created.governance.currentGeneration, "tree-sha-b");
});

test("createGovernedIssue fails closed when the template changed at a new governance generation", async () => {
  const source = issueTemplate("remote_field");
  const transport = new StubGovernanceTransport([
    ...governanceResponses(".github/ISSUE_TEMPLATE/remote.yml", "remote-sha", source, [], "tree-sha-a"),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: "tree-sha-c",
        truncated: false,
        tree: [{ path: ".github/ISSUE_TEMPLATE/remote.yml", type: "blob", sha: "remote-sha-changed" }],
      }),
    ),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/repository-b", transport });
  const contract = await compileRepositoryGovernedContract(adapter, "issue", "remote");
  const prepared = prepareIssueArtifact(contract, {
    fields: { remote_field: "value" },
    metadata: { title: "Remote issue" },
  }).artifact;

  await assert.rejects(
    createGovernedIssue(adapter, prepared),
    (error: unknown) => error instanceof GovernanceError && error.code === "GOVERNANCE_GENERATION_STALE",
  );
  assert.equal(
    transport.calls.some((args) => args.includes("POST")),
    false,
  );
});

test("createGovernedIssue reports a reconciliation mismatch without losing the created issue identity", async () => {
  const source = issueTemplate("remote_field");
  const transport = new StubGovernanceTransport([
    ...governanceResponses(".github/ISSUE_TEMPLATE/remote.yml", "remote-sha", source, [], "tree-sha-a"),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: "tree-sha-a",
        truncated: false,
        tree: [{ path: ".github/ISSUE_TEMPLATE/remote.yml", type: "blob", sha: "remote-sha" }],
      }),
    ),
    command(
      JSON.stringify({
        number: 51,
        title: "Remote issue",
        body: "### Remote field\n\nvalue\n",
        state: "open",
        html_url: "https://github.com/acme/repository-b/issues/51",
        labels: [],
        assignees: [],
      }),
    ),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: "tree-sha-d",
        truncated: false,
        tree: [{ path: ".github/ISSUE_TEMPLATE/remote.yml", type: "blob", sha: "remote-sha-changed-after-mutation" }],
      }),
    ),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/repository-b", transport });
  const contract = await compileRepositoryGovernedContract(adapter, "issue", "remote");
  const prepared = prepareIssueArtifact(contract, {
    fields: { remote_field: "value" },
    metadata: { title: "Remote issue" },
  }).artifact;

  const created = await createGovernedIssue(adapter, prepared);

  assert.equal(created.artifact.number, 51);
  assert.equal(created.governance.reconciled, false);
  assert.equal(created.governance.validatedGeneration, "tree-sha-a");
  assert.equal(created.governance.currentGeneration, "tree-sha-d");
  assert.equal(created.governance.reason, "template governance input changed");
});

test("createGovernedPullRequest fails closed when a policy governance input is newly introduced", async () => {
  const templatePath = ".github/PULL_REQUEST_TEMPLATE.md";
  const templateSource = "## Summary\n\nSummary text.\n";
  const transport = new StubGovernanceTransport([
    command("gh version 2.0"),
    command(),
    command("100000200\n"),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: "tree-sha-a",
        truncated: false,
        tree: [{ path: templatePath, type: "blob", sha: "pr-template-sha" }],
      }),
    ),
    blobResponse("pr-template-sha", templateSource),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: "tree-sha-b",
        truncated: false,
        tree: [
          { path: templatePath, type: "blob", sha: "pr-template-sha" },
          { path: ".github/inari/pr-policy.yml", type: "blob", sha: "policy-sha" },
        ],
      }),
    ),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/repository-b", transport });
  const contract = await compileRepositoryGovernedContract(adapter, "pr", "default");
  assert.equal(contract.provenance?.policy, undefined);
  const prepared = preparePullRequestArtifact(contract, {
    fields: { summary: "A summary" },
    metadata: { title: "PR title", head: "feature", base: "main" },
  }).artifact;

  await assert.rejects(
    createGovernedPullRequest(adapter, prepared),
    (error: unknown) => error instanceof GovernanceError && error.code === "GOVERNANCE_GENERATION_STALE",
  );
  assert.equal(
    transport.calls.some((args) => args.includes("POST")),
    false,
  );
});

test("createGovernedPullRequest proceeds through the existing mutation path when the actual head branch satisfies repository branch governance", async () => {
  const templatePath = ".github/PULL_REQUEST_TEMPLATE.md";
  const templateSource = "## Summary\n\nSummary text.\n";
  const policySource = 'version: 1\nsections: []\nbranch:\n  pattern: "^feat/[0-9]+-[a-z0-9-]+$"\n';
  const tree = command(
    JSON.stringify({
      sha: "tree-sha-a",
      truncated: false,
      tree: [
        { path: templatePath, type: "blob", sha: "pr-template-sha" },
        { path: ".github/inari/pr-policy.yml", type: "blob", sha: "policy-sha" },
      ],
    }),
  );
  const transport = new StubGovernanceTransport([
    command("gh version 2.0"),
    command(),
    command("100000200\n"),
    command(JSON.stringify({ default_branch: "main" })),
    tree,
    blobResponse("pr-template-sha", templateSource),
    blobResponse("policy-sha", policySource),
    command(JSON.stringify({ default_branch: "main" })),
    tree,
    command(
      JSON.stringify({
        number: 60,
        title: "PR title",
        body: "## Summary\n\nA summary\n",
        state: "open",
        html_url: "https://github.com/acme/repository-b/pull/60",
        draft: false,
        head: { ref: "feat/42-add-branch-preflight" },
        base: { ref: "main" },
      }),
    ),
    command(JSON.stringify({ default_branch: "main" })),
    tree,
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/repository-b", transport });
  const contract = await compileRepositoryGovernedContract(adapter, "pr", "default");
  assert.deepEqual(contract.provenance?.branchGovernance, {
    pattern: "^feat/[0-9]+-[a-z0-9-]+$",
    release: { pattern: DEFAULT_RELEASE_BRANCH_PATTERN },
    exemptions: [],
  });
  const prepared = preparePullRequestArtifact(contract, {
    fields: { summary: "A summary" },
    metadata: { title: "PR title", head: "feat/42-add-branch-preflight", base: "main" },
  }).artifact;

  const created = await createGovernedPullRequest(adapter, prepared);
  assert.equal(created.artifact.number, 60);
  const postCall = transport.calls.find((args) => args.includes("POST"));
  assert.ok(postCall?.includes("head=feat/42-add-branch-preflight"));
});

test("createGovernedPullRequest rejects a head branch that violates repository branch governance before any GitHub mutation, with a bounded stable diagnostic", async () => {
  const templatePath = ".github/PULL_REQUEST_TEMPLATE.md";
  const templateSource = "## Summary\n\nSummary text.\n";
  const policySource = 'version: 1\nsections: []\nbranch:\n  pattern: "^feat/[0-9]+-[a-z0-9-]+$"\n';
  const transport = new StubGovernanceTransport([
    command("gh version 2.0"),
    command(),
    command("100000200\n"),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: "tree-sha-a",
        truncated: false,
        tree: [
          { path: templatePath, type: "blob", sha: "pr-template-sha" },
          { path: ".github/inari/pr-policy.yml", type: "blob", sha: "policy-sha" },
        ],
      }),
    ),
    blobResponse("pr-template-sha", templateSource),
    blobResponse("policy-sha", policySource),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/repository-b", transport });
  const contract = await compileRepositoryGovernedContract(adapter, "pr", "default");
  const prepared = preparePullRequestArtifact(contract, {
    fields: { summary: "A summary" },
    metadata: { title: "PR title", head: "not-governance-compliant", base: "main" },
  }).artifact;

  await assert.rejects(createGovernedPullRequest(adapter, prepared), (error: unknown) => {
    assert.ok(error instanceof GovernanceError);
    assert.equal(error.code, "GOVERNANCE_BRANCH_INVALID");
    assert.equal(error.details.head, "not-governance-compliant");
    assert.equal(error.details.pattern, "^feat/[0-9]+-[a-z0-9-]+$");
    return true;
  });
  assert.equal(
    transport.calls.some((args) => args.includes("POST")),
    false,
  );
  assert.equal(transport.calls.length, 7);
});

test("a malformed repository branch governance declaration fails closed while compiling the contract, before any PR mutation is reachable", async () => {
  const templatePath = ".github/PULL_REQUEST_TEMPLATE.md";
  const templateSource = "## Summary\n\nSummary text.\n";
  const policySource = 'version: 1\nsections: []\nbranch:\n  pattern: "(a+)+$"\n';
  const transport = new StubGovernanceTransport([
    command("gh version 2.0"),
    command(),
    command("100000200\n"),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: "tree-sha-a",
        truncated: false,
        tree: [
          { path: templatePath, type: "blob", sha: "pr-template-sha" },
          { path: ".github/inari/pr-policy.yml", type: "blob", sha: "policy-sha" },
        ],
      }),
    ),
    blobResponse("pr-template-sha", templateSource),
    blobResponse("policy-sha", policySource),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/repository-b", transport });

  await assert.rejects(
    compileRepositoryGovernedContract(adapter, "pr", "default"),
    (error: unknown) => error instanceof PullRequestPolicyError && error.code === "PR_POLICY_INVALID_VALUE",
  );
  assert.equal(
    transport.calls.some((args) => args.includes("POST")),
    false,
  );
});

test("unavailable repository branch governance fails closed before any PR mutation is reachable", async () => {
  const templatePath = ".github/PULL_REQUEST_TEMPLATE.md";
  const templateSource = "## Summary\n\nSummary text.\n";
  const transport = new StubGovernanceTransport([
    command("gh version 2.0"),
    command(),
    command("100000200\n"),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: "tree-sha-a",
        truncated: false,
        tree: [
          { path: templatePath, type: "blob", sha: "pr-template-sha" },
          { path: ".github/inari/pr-policy.yml", type: "blob", sha: "policy-sha" },
        ],
      }),
    ),
    blobResponse("pr-template-sha", templateSource),
    command("", 1, "offline"),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/repository-b", transport });

  await assert.rejects(
    compileRepositoryGovernedContract(adapter, "pr", "default"),
    (error: unknown) => error instanceof GovernanceError && error.code === "GOVERNANCE_SOURCE_UNAVAILABLE",
  );
  assert.equal(
    transport.calls.some((args) => args.includes("POST")),
    false,
  );
});

test("a repository PR policy with no branch rule leaves the existing valid-branch mutation path unchanged", async () => {
  const templatePath = ".github/PULL_REQUEST_TEMPLATE.md";
  const templateSource = "## Summary\n\nSummary text.\n";
  const policySource = "version: 1\nsections: []\n";
  const tree = command(
    JSON.stringify({
      sha: "tree-sha-a",
      truncated: false,
      tree: [
        { path: templatePath, type: "blob", sha: "pr-template-sha" },
        { path: ".github/inari/pr-policy.yml", type: "blob", sha: "policy-sha" },
      ],
    }),
  );
  const transport = new StubGovernanceTransport([
    command("gh version 2.0"),
    command(),
    command("100000200\n"),
    command(JSON.stringify({ default_branch: "main" })),
    tree,
    blobResponse("pr-template-sha", templateSource),
    blobResponse("policy-sha", policySource),
    command(JSON.stringify({ default_branch: "main" })),
    tree,
    command(
      JSON.stringify({
        number: 61,
        title: "PR title",
        body: "## Summary\n\nA summary\n",
        state: "open",
        html_url: "https://github.com/acme/repository-b/pull/61",
        draft: false,
        head: { ref: "anything-goes" },
        base: { ref: "main" },
      }),
    ),
    command(JSON.stringify({ default_branch: "main" })),
    tree,
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/repository-b", transport });
  const contract = await compileRepositoryGovernedContract(adapter, "pr", "default");
  assert.equal(contract.provenance?.branchGovernance, undefined);
  const prepared = preparePullRequestArtifact(contract, {
    fields: { summary: "A summary" },
    metadata: { title: "PR title", head: "anything-goes", base: "main" },
  }).artifact;

  const created = await createGovernedPullRequest(adapter, prepared);
  assert.equal(created.artifact.number, 61);
});

test("compileRepositoryGovernedContract succeeds for a repository governed by .github/inari/ semantic sources", async () => {
  const semanticSource = {
    version: 1,
    kind: "issue",
    id: "bug",
    name: "Bug",
    description: "Reproducible defect",
    sections: [{ id: "summary", type: "textarea", label: "Summary", required: true }],
  };
  const generatedPath = ".github/ISSUE_TEMPLATE/bug.yml";
  const nativeSource = renderSemanticNative(
    normalizeSemanticTemplate(semanticSource, ".github/inari/issues/bug.json"),
    generatedPath,
  );
  const transport = new StubGovernanceTransport([
    command("gh version 2.0"),
    command(),
    command("100000200\n"),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: "tree-sha-a",
        truncated: false,
        tree: [
          { path: ".github/inari/issues/bug.json", type: "blob", sha: "semantic-sha" },
          { path: generatedPath, type: "blob", sha: "native-sha" },
        ],
      }),
    ),
    blobResponse("semantic-sha", JSON.stringify(semanticSource)),
    blobResponse("native-sha", nativeSource),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/repository-b", transport });
  const contract = await compileRepositoryGovernedContract(adapter, "issue", "bug");

  assert.equal(contract.templateIdentity.path, generatedPath);
  assert.equal(contract.provenance?.template.path, generatedPath);
  assert.equal(contract.provenance?.template.sha, "native-sha");
  assert.doesNotThrow(() => deserializeCanonicalContract(serializeCanonicalContract(contract)));
});

test("arbitrary policy overrides are rejected for governed operations", () => {
  assert.throws(
    () => rejectGovernedPolicyOverride("/tmp/policy.yml"),
    (error: unknown) => error instanceof GovernanceError && error.code === "GOVERNANCE_POLICY_OVERRIDE_FORBIDDEN",
  );
});

test("existing-artifact validation acquires the contract from the artifact target repository", async () => {
  const transport = new StubGovernanceTransport([
    ...governanceResponses(".github/ISSUE_TEMPLATE/remote.yml", "remote-sha", issueTemplate("remote_field")),
    command(
      JSON.stringify({
        number: 42,
        title: "Remote issue",
        body: "### Remote field\n\nvalue\n",
        state: "open",
        html_url: "https://github.com/acme/repository-b/issues/42",
        labels: [],
        assignees: [],
      }),
    ),
  ]);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(
      ["issue", "validate", "42", "--template", "remote", "--repository", "acme/repository-b", "--json"],
      {
        repositoryRoot: "/tmp/stale-local-copy/.github/false",
        createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
      },
    );
    assert.equal(exitCode, 0);
    assert.equal(JSON.parse(lines[0] ?? "{}").valid, true);
    assert.ok(transport.calls.some((args) => args.includes("repos/acme/repository-b/issues/42")));
  } finally {
    console.log = originalLog;
  }
});

test("successful Issue update keeps identity when post-effect governance crosses generations", async () => {
  const source = issueTemplate("remote_field");
  const updatedIssue = {
    number: 52,
    title: "Remote issue updated",
    body: "### Remote field\n\nupdated\n",
    state: "open",
    html_url: "https://github.com/acme/repository-b/issues/52",
    labels: [],
    assignees: [],
  };
  const transport = new StubGovernanceTransport([
    ...governanceResponses(".github/ISSUE_TEMPLATE/remote.yml", "remote-sha", source, [], "tree-sha-a"),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: "tree-sha-a",
        truncated: false,
        tree: [{ path: ".github/ISSUE_TEMPLATE/remote.yml", type: "blob", sha: "remote-sha" }],
      }),
    ),
    command(JSON.stringify({ ...updatedIssue, body: "### Remote field\n\nold\n" })),
    command(JSON.stringify(updatedIssue)),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: "tree-sha-d",
        truncated: false,
        tree: [{ path: ".github/ISSUE_TEMPLATE/remote.yml", type: "blob", sha: "remote-sha-changed" }],
      }),
    ),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/repository-b", transport });
  const contract = await compileRepositoryGovernedContract(adapter, "issue", "remote");
  const prepared = prepareIssueArtifact(contract, {
    fields: { remote_field: "updated" },
    metadata: { title: "Remote issue updated" },
  }).artifact;

  const result = await updateGovernedIssue(adapter, 52, prepared);
  assert.equal(result.artifact.number, 52);
  assert.equal(result.artifact.url, updatedIssue.html_url);
  assert.equal(result.governance.reconciled, false);
  assert.equal(result.governance.currentGeneration, "tree-sha-d");
});

test("successful pull-request update keeps identity when post-effect governance crosses generations", async () => {
  const templatePath = ".github/PULL_REQUEST_TEMPLATE.md";
  const source = "## Summary\n\nSummary text.\n";
  const updatedPullRequest = {
    number: 53,
    title: "feat: updated",
    body: "## Summary\n\nUpdated summary.\n",
    state: "open",
    html_url: "https://github.com/acme/repository-b/pull/53",
    draft: false,
    head: { ref: "feature" },
    base: { ref: "main" },
  };
  const transport = new StubGovernanceTransport([
    ...governanceResponses(templatePath, "pr-sha", source, [], "tree-sha-a"),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: "tree-sha-a",
        truncated: false,
        tree: [{ path: templatePath, type: "blob", sha: "pr-sha" }],
      }),
    ),
    command(JSON.stringify(updatedPullRequest)),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: "tree-sha-d",
        truncated: false,
        tree: [{ path: templatePath, type: "blob", sha: "pr-sha-changed" }],
      }),
    ),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/repository-b", transport });
  const contract = await compileRepositoryGovernedContract(adapter, "pr", "default");
  const prepared = preparePullRequestArtifact(contract, {
    fields: { summary: "Updated summary" },
    metadata: { title: "feat: updated", head: "feature", base: "main" },
  }).artifact;

  const result = await updateGovernedPullRequest(adapter, 53, prepared);
  assert.equal(result.artifact.number, 53);
  assert.equal(result.artifact.url, updatedPullRequest.html_url);
  assert.equal(result.governance.reconciled, false);
  assert.equal(result.governance.currentGeneration, "tree-sha-d");
});
