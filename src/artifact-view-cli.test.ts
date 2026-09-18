import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { GitHubApiError, GitHubAdapter, type RepositoryContext, type RepositoryTree } from "./github/index.js";
import type { GitHubIssue, GitHubOperationalCollection, GitHubOperationalIssueEvidence } from "./github/types.js";

const context: RepositoryContext = {
  hostname: "github.com",
  host: "github.com",
  owner: "acme",
  name: "inari",
  nameWithOwner: "acme/inari",
  url: "https://github.com/acme/inari",
  repositoryId: "100",
};

const issueTemplate = [
  "name: Feature",
  "description: Feature",
  "body:",
  "  - type: textarea",
  "    id: problem",
  "    attributes: { label: Problem }",
  "    validations: { required: true }",
  "  - type: textarea",
  "    id: proposal",
  "    attributes: { label: Proposal }",
  "    validations: { required: true }",
  "",
].join("\n");

const validBody = [
  "### Problem",
  "",
  "A reproducible problem",
  "",
  "### Proposal",
  "",
  "A deterministic proposal",
  "",
].join("\n");

function collection<T>(items: readonly T[] = []): GitHubOperationalCollection<T> {
  return {
    status: "available",
    items,
    pagination: { perPage: 100, pages: 1, returned: items.length, truncated: false },
    diagnostics: [],
  };
}

function issue(number: number, body: string): GitHubIssue {
  return {
    number,
    title: "Observed Issue",
    body,
    state: "open",
    url: `https://github.com/acme/inari/issues/${number}`,
    labels: [],
    assignees: [],
  };
}

function operationalIssue(remote: GitHubIssue): GitHubOperationalIssueEvidence {
  return {
    repository: { host: "github.com", nameWithOwner: "acme/inari", repositoryId: "100" },
    number: remote.number,
    title: remote.title,
    body: remote.body,
    state: remote.state,
    author: null,
    labels: [],
    assignees: [],
    url: remote.url,
    comments: collection(),
    provenance: { provider: "github", endpoints: [`issues/${remote.number}`] },
  };
}

class ViewAdapter extends GitHubAdapter {
  constructor(
    private readonly remote: GitHubIssue,
    private readonly templates: readonly { readonly path: string; readonly source: string }[],
  ) {
    super({ repository: "acme/inari" });
  }

  override async resolveRepositoryContext(): Promise<RepositoryContext> {
    return context;
  }

  override async getRepositoryDefaultBranch(): Promise<string> {
    return "main";
  }

  override async getRepositoryTree(_ref: string): Promise<RepositoryTree> {
    return {
      sha: "tree",
      entries: this.templates.map((template, index) => ({
        path: template.path,
        type: "blob" as const,
        sha: `template-${index}`,
      })),
    };
  }

  override async getRepositoryBlob(sha: string): Promise<string> {
    const index = Number(sha.slice("template-".length));
    const template = this.templates[index];
    if (template === undefined) throw new Error(`Unexpected template blob ${sha}`);
    return template.source;
  }

  override async getIssue(_number: number): Promise<GitHubIssue> {
    return this.remote;
  }

  override async observeIssue(_number: number): Promise<GitHubOperationalIssueEvidence> {
    return operationalIssue(this.remote);
  }
}

async function capture(
  adapter: GitHubAdapter,
  argv: readonly string[] = ["issue", "view", "7", "--json"],
): Promise<{ readonly exitCode: number; readonly output: Record<string, unknown>; readonly fallbacks: string[][] }> {
  const lines: string[] = [];
  const fallbacks: string[][] = [];
  const originalLog = console.log;
  try {
    console.log = (line: string) => lines.push(line);
    const exitCode = await runCli([...argv], {
      createAdapter: () => adapter,
      runGhFallback: (args) => {
        fallbacks.push([...args]);
        return 0;
      },
    });
    return { exitCode, output: JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>, fallbacks };
  } finally {
    console.log = originalLog;
  }
}

test("issue view keeps readable provider content when semantic template resolution fails", async () => {
  const result = await capture(
    new ViewAdapter(issue(7, "Legacy body"), [{ path: ".github/ISSUE_TEMPLATE/feature.yml", source: issueTemplate }]),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.ok, true);
  assert.equal(result.output.operation, "issue.view");
  assert.equal(result.output.number, 7);
  assert.equal(result.output.url, "https://github.com/acme/inari/issues/7");
  const observed = result.output.observed as Record<string, unknown>;
  assert.equal(observed.title, "Observed Issue");
  assert.equal(observed.body, "Legacy body");
  assert.equal((result.output.semantic as Record<string, unknown>).status, "unavailable");
  assert.deepEqual(result.fallbacks, []);
});

test("issue view retains bounded semantic diagnostics for malformed, unmatched, ambiguous, legacy, and valid artifacts", async () => {
  const cases = [
    {
      name: "malformed template",
      templates: [{ path: ".github/ISSUE_TEMPLATE/feature.yml", source: "name: [broken" }],
      body: validBody,
      status: "unavailable",
    },
    {
      name: "no matching template",
      templates: [{ path: ".github/ISSUE_TEMPLATE/feature.yml", source: issueTemplate }],
      body: "### Other\n\nLegacy body\n",
      status: "unavailable",
    },
    {
      name: "ambiguous template",
      templates: [
        { path: ".github/ISSUE_TEMPLATE/alpha.yml", source: issueTemplate },
        { path: ".github/ISSUE_TEMPLATE/beta.yml", source: issueTemplate },
      ],
      body: validBody,
      status: "unavailable",
    },
    {
      name: "legacy artifact",
      templates: [{ path: ".github/ISSUE_TEMPLATE/feature.yml", source: issueTemplate }],
      body: "Problem: old format\nProposal: old format\n",
      status: "unavailable",
    },
    {
      name: "valid artifact",
      templates: [{ path: ".github/ISSUE_TEMPLATE/feature.yml", source: issueTemplate }],
      body: validBody,
      status: "valid",
    },
  ] as const;

  for (const testCase of cases) {
    const result = await capture(new ViewAdapter(issue(7, testCase.body), testCase.templates));
    assert.equal(result.exitCode, 0, testCase.name);
    assert.equal((result.output.observed as Record<string, unknown>).body, testCase.body, testCase.name);
    const semantic = result.output.semantic as Record<string, unknown>;
    assert.equal(semantic.status, testCase.status, testCase.name);
    assert.ok(Array.isArray(semantic.diagnostics), testCase.name);
    if (testCase.status === "valid") assert.ok(semantic.result, testCase.name);
  }
});

test("issue view reports provider failure as a real view failure", async () => {
  class FailingAdapter extends ViewAdapter {
    override async observeIssue(): Promise<GitHubOperationalIssueEvidence> {
      throw new GitHubApiError("issue.view", "provider unavailable");
    }
  }

  const result = await capture(new FailingAdapter(issue(7, validBody), []));
  assert.equal(result.exitCode, 3);
  assert.equal(result.output.ok, false);
  assert.equal((result.output.error as Record<string, unknown>).code, "GITHUB_API_FAILED");
});
