import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";
import {
  IMPLEMENTATION_CONTRACT_VERSION,
  IMPLEMENTATION_KIND,
  renderImplementationIssueBody,
} from "./implementation-contract.js";
import {
  GitHubAdapter,
  type GitHubApiResponse,
  type GitHubBranch,
  type GitHubIssue,
  type GitHubOperationalCollection,
  type GitHubOperationalPullRequestEvidence,
  type RepositoryContext,
} from "./github/index.js";

const CONTEXT: RepositoryContext = {
  hostname: "github.com",
  host: "github.com",
  owner: "acme",
  name: "inari",
  nameWithOwner: "acme/inari",
  url: "https://github.com/acme/inari",
  repositoryId: "415000001",
};

const BRANCH: GitHubBranch = {
  name: "main",
  ref: "refs/heads/main",
  sha: "a".repeat(40),
};

function implementationBody(): string {
  return renderImplementationIssueBody({
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository: {
      repositoryHost: CONTEXT.hostname,
      repositoryId: CONTEXT.repositoryId,
      repository: CONTEXT.nameWithOwner,
    },
    sources: [
      {
        repositoryHost: CONTEXT.hostname,
        repositoryId: CONTEXT.repositoryId,
        repository: CONTEXT.nameWithOwner,
        number: 7,
      },
    ],
    objective: "Expose the Implementation CLI.",
    nonGoals: ["Automatic authorization"],
    architecture: {
      decision: "Keep the CLI as a projection over the canonical Core.",
      affectedComponents: ["CLI"],
      invariants: ["Inferred scope has no authority."],
      compatibilityConstraints: [],
    },
    scope: {
      readOnly: ["src/**"],
      write: ["src/cli-core.ts"],
      create: [],
      delete: [],
      deny: ["src/private/**"],
    },
    constraints: {
      prohibitedOperations: ["Do not mutate GitHub."],
      immutableAreas: ["Canonical contract semantics"],
      prerequisites: ["The canonical authorities exist."],
    },
    verification: {
      acceptanceCriteria: ["The CLI is discoverable."],
      targetedTests: ["pnpm test"],
      requiredChecks: ["pnpm run verify"],
      postconditions: ["Authorization is explicit."],
    },
    execution: {
      baseBranch: BRANCH.name,
      baseRevision: BRANCH.sha,
      baseFreshness: BRANCH.sha,
      branch: "feat/573-impl-cli",
      dependencies: [
        {
          repositoryHost: CONTEXT.hostname,
          repositoryId: CONTEXT.repositoryId,
          repository: CONTEXT.nameWithOwner,
          number: 7,
        },
      ],
    },
  });
}

function issue(body: string): GitHubIssue {
  return {
    number: 42,
    title: "impl: expose the Implementation CLI",
    body,
    state: "open",
    url: "https://github.com/acme/inari/issues/42",
    labels: ["implementation"],
    assignees: [],
    repositoryId: CONTEXT.repositoryId,
    repositoryHost: CONTEXT.hostname,
  };
}

function collection<T>(items: readonly T[]): GitHubOperationalCollection<T> {
  return {
    status: "available",
    items,
    pagination: { perPage: 100, pages: 1, returned: items.length, truncated: false },
    diagnostics: [],
  };
}

class ImplementationCliAdapter extends GitHubAdapter {
  readonly relationCalls: string[] = [];
  readonly currentIssue: GitHubIssue;
  readonly currentBranch: GitHubBranch | undefined;
  readonly parentNumber: number | undefined;

  constructor(body: string, currentBranch: GitHubBranch | undefined = BRANCH, parentNumber?: number) {
    super();
    this.currentIssue = issue(body);
    this.currentBranch = currentBranch;
    this.parentNumber = parentNumber;
  }

  override async getRepositoryContext(): Promise<RepositoryContext> {
    return CONTEXT;
  }

  override async getIssue(): Promise<GitHubIssue> {
    return this.currentIssue;
  }

  override async findBranch(): Promise<GitHubBranch | undefined> {
    return this.currentBranch;
  }

  override async observePullRequest(pullRequestNumber: number): Promise<GitHubOperationalPullRequestEvidence> {
    return {
      repository: {
        host: CONTEXT.hostname,
        nameWithOwner: CONTEXT.nameWithOwner,
        repositoryId: CONTEXT.repositoryId,
      },
      number: pullRequestNumber,
      title: "Implementation PR",
      body: "PR body is not conformance authority.",
      state: "open",
      author: null,
      head: { ref: "feat/573-impl-cli", sha: "b".repeat(40) },
      base: { ref: BRANCH.name, sha: BRANCH.sha },
      draft: false,
      labels: [],
      assignees: [],
      url: `https://github.com/${CONTEXT.nameWithOwner}/pull/${pullRequestNumber}`,
      checks: collection([
        {
          id: "verify",
          name: "pnpm run verify",
          kind: "check-run",
          identity: { context: "pnpm run verify", producer: "app:trusted" },
          status: "completed",
          conclusion: "success",
        },
        { id: "test", name: "pnpm test", kind: "check-run", status: "completed", conclusion: "success" },
      ]),
      requiredCheckBindings: collection([{ context: "pnpm run verify", producer: "app:trusted" }]),
      reviews: collection([]),
      comments: collection([]),
      inlineReviewComments: collection([]),
      changedFiles: collection([{ filename: "src/cli-core.ts", status: "modified" }]),
      provenance: { provider: "github", endpoints: [`pulls/${pullRequestNumber}`] },
    };
  }

  override async requestRepositoryApi(repositoryPath: string): Promise<GitHubApiResponse> {
    this.relationCalls.push(repositoryPath);
    if (repositoryPath.endsWith("/parent")) {
      return this.parentNumber === undefined
        ? { status: 404, body: {} }
        : {
            status: 200,
            body: {
              number: this.parentNumber,
              repository_url: "https://api.github.com/repos/acme/inari",
            },
          };
    }
    if (repositoryPath.includes("/sub_issues?")) {
      return {
        status: 200,
        body: [
          {
            number: 43,
            repository_url: "https://api.github.com/repos/acme/inari",
          },
        ],
      };
    }
    throw new Error(`Unexpected relation request: ${repositoryPath}`);
  }
}

async function invoke(
  argv: readonly string[],
  adapter: ImplementationCliAdapter,
): Promise<{ readonly exitCode: number; readonly output: Record<string, unknown> }> {
  const lines: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (line: string) => lines.push(line);
    const exitCode = await runCli([...argv], {
      createAdapter: () => adapter,
      repositoryRoot: process.cwd(),
    });
    return { exitCode, output: JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown> };
  } finally {
    console.log = originalLog;
  }
}

test("impl is discoverable and plan keeps inferred recommendations unauthorized", async () => {
  const helpLines: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (line: string) => helpLines.push(line);
    assert.equal(await runCli(["impl", "--help=json"]), 0);
  } finally {
    console.log = originalLog;
  }
  const help = JSON.parse(helpLines.at(-1) ?? "{}") as { commands: readonly { id: string }[] };
  assert.deepEqual(
    help.commands.map((entry) => entry.id),
    ["impl.plan", "impl.show", "impl.validate", "impl.authorize", "impl.inspect", "impl.verify"],
  );

  const adapter = new ImplementationCliAdapter("A source Issue with a checklist.\n\n- [ ] Keep scope explicit");
  const result = await invoke(["impl", "plan", "42", "--json"], adapter);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.operation, "impl.plan");
  assert.equal((result.output.authorization as Record<string, unknown>).authorized, false);
  assert.equal((result.output.recommendations as Record<string, unknown>).authoritative, false);
  assert.deepEqual(adapter.relationCalls, []);
});

test("impl validate and authorize use the canonical body and #572 Core", async () => {
  const adapter = new ImplementationCliAdapter(implementationBody());
  const validated = await invoke(["impl", "validate", "42", "--json"], adapter);
  assert.equal(validated.exitCode, 0);
  assert.equal(validated.output.valid, true);
  assert.equal((validated.output.canonical as Record<string, unknown>).valid, true);

  const authorized = await invoke(["impl", "authorize", "42", "--json"], adapter);
  assert.equal(authorized.exitCode, 0);
  const authorization = authorized.output.authorization as Record<string, unknown>;
  assert.equal(authorization.authorized, true);
  assert.equal((authorization.record as Record<string, unknown>).kind, "implementation-authorization");
  assert.equal(authorized.output.mutation, false);
});

test("impl inspect uses provider relationship authority and detects stale base evidence", async () => {
  const adapter = new ImplementationCliAdapter(implementationBody(), BRANCH, 10);
  const authorized = await invoke(["impl", "authorize", "42", "--json"], adapter);
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-implementation-cli-"));
  try {
    const authorizationPath = path.join(directory, "authorization.json");
    await writeFile(
      authorizationPath,
      JSON.stringify(
        authorized.output.authorization && (authorized.output.authorization as Record<string, unknown>).record,
      ),
      "utf8",
    );
    const inspected = await invoke(
      ["impl", "inspect", "42", "--from", authorizationPath, "--capability", "github.issue.parent.native", "--json"],
      adapter,
    );
    assert.equal(inspected.exitCode, 0);
    const relationships = inspected.output.relationships as Record<string, unknown>;
    assert.equal((relationships.parent as Record<string, unknown>).reference !== undefined, true);
    assert.equal((relationships.children as Record<string, unknown>).references !== undefined, true);

    const staleAdapter = new ImplementationCliAdapter(implementationBody(), { ...BRANCH, sha: "b".repeat(40) });
    const stale = await invoke(["impl", "authorize", "42", "--json"], staleAdapter);
    assert.equal(stale.exitCode, 2);
    const violations = (stale.output.authorization as Record<string, unknown>).violations as Array<
      Record<string, unknown>
    >;
    assert.ok(violations.some((entry) => entry.code === "IMPLEMENTATION_AUTHORIZATION_BASE_REVISION_MISMATCH"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("impl verify rereads the Implementation and checks the normalized PR evidence", async () => {
  const adapter = new ImplementationCliAdapter(implementationBody());
  const authorized = await invoke(["impl", "authorize", "42", "--json"], adapter);
  assert.equal(authorized.exitCode, 0);
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-implementation-verify-cli-"));
  try {
    const authorizationPath = path.join(directory, "authorization.json");
    await writeFile(
      authorizationPath,
      JSON.stringify(
        authorized.output.authorization && (authorized.output.authorization as Record<string, unknown>).record,
      ),
      "utf8",
    );
    const verified = await invoke(
      ["impl", "verify", "42", "--from", authorizationPath, "--pr", "90", "--json"],
      adapter,
    );
    assert.equal(verified.output.operation, "impl.verify");
    // The contract's targetedTests name a test-execution command ("pnpm
    // test"), which has no authoritative provider evidence distinct from a
    // same-named CI check, so it is reported unverifiable rather than
    // satisfied even though the mock PR carries a successful check with a
    // matching name.
    assert.equal(verified.output.status, "unverifiable");
    assert.equal(verified.output.valid, false);
    assert.equal(verified.exitCode, 2);
    const verification = verified.output.verification as Record<string, unknown>;
    assert.deepEqual(verification.satisfiedChecks, ["pnpm run verify"]);
    assert.deepEqual(verification.unverifiableTests, ["pnpm test"]);
    assert.equal(JSON.stringify(verified.output).includes("PR body is not conformance authority."), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
