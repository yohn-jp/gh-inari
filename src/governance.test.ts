import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  compileRepositoryGovernedContract,
  discoverRepositoryTemplates,
  GovernanceError,
  rejectGovernedPolicyOverride,
} from "./governance.js";
import { type GhCommandResult, type GhTransport, type GhTransportOptions, GitHubAdapter } from "./github/index.js";
import { deserializeCanonicalContract, serializeCanonicalContract } from "./contract/index.js";
import { runCli } from "./cli.js";

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
): GhCommandResult[] {
  return [
    command("gh version 2.0"),
    command(),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
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
  });
  assert.equal(contract.provenance?.ref, "main");
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
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
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
  assert.equal(transport.calls.length, 4);
});

test("missing or unavailable remote governance never falls back to local files", async () => {
  const transport = new StubGovernanceTransport([
    command("gh version 2.0"),
    command(),
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
