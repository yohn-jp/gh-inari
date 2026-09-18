import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { GitHubApiError, GitHubAdapter, type RepositoryContext, type RepositoryTree } from "./github/index.js";
import type {
  GitHubIssue,
  GitHubOperationalCollection,
  GitHubOperationalIssueEvidence,
  GitHubOperationalPullRequestEvidence,
  GitHubPullRequest,
} from "./github/types.js";

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

const pullRequestTemplate = [
  "<!-- Pull request summary -->",
  "",
  "## Summary",
  "<!-- Explain the change. -->",
  "",
  "## Validation",
  "",
  "- [ ] Tests",
  "",
].join("\n");

const validPullRequestBody = ["## Summary", "", "A coherent change", "", "## Validation", "", "- [x] Tests", ""].join(
  "\n",
);

const pullRequestPolicy = [
  "version: 1",
  "template: default",
  "sections:",
  "  - section: summary",
  "    required: true",
  "    minLength: 10",
  "  - section: validation",
  "    required: true",
  "    checklist:",
  "      minCompleted: 1",
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

function pullRequest(number: number, body: string): GitHubPullRequest {
  return {
    number,
    title: "Observed pull request",
    body,
    state: "open",
    url: `https://github.com/acme/inari/pull/${number}`,
    draft: false,
    head: "feat/snapshot",
    headSha: "head-sha",
    base: "main",
    baseSha: "base-sha",
    labels: [],
    assignees: [],
  };
}

function operationalPullRequest(remote: GitHubPullRequest): GitHubOperationalPullRequestEvidence {
  return {
    repository: { host: "github.com", nameWithOwner: "acme/inari", repositoryId: "100" },
    number: remote.number,
    title: remote.title,
    body: remote.body,
    state: remote.state,
    author: null,
    head: { ref: remote.head, sha: remote.headSha },
    base: { ref: remote.base, sha: remote.baseSha },
    draft: remote.draft,
    mergeable: true,
    mergeState: "clean",
    reviewDecision: "APPROVED",
    merged: false,
    labels: [],
    assignees: [],
    checks: collection(),
    requiredCheckBindings: collection(),
    reviews: collection(),
    comments: collection(),
    inlineReviewComments: collection(),
    changedFiles: collection(),
    url: remote.url,
    provenance: { provider: "github", endpoints: [`pulls/${remote.number}`] },
  };
}

class ViewAdapter extends GitHubAdapter {
  getIssueCalls = 0;
  constructor(
    protected readonly remote: GitHubIssue,
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
    this.getIssueCalls += 1;
    return this.remote;
  }

  override async observeIssue(_number: number): Promise<GitHubOperationalIssueEvidence> {
    return operationalIssue(this.remote);
  }
}

class PullRequestViewAdapter extends GitHubAdapter {
  getPullRequestCalls = 0;

  constructor(
    private readonly remote: GitHubPullRequest,
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

  override async getPullRequest(_number: number): Promise<GitHubPullRequest> {
    this.getPullRequestCalls += 1;
    return this.remote;
  }

  override async getIssue(_number: number): Promise<never> {
    throw new Error("issue read is outside the PR view");
  }

  override async observePullRequest(_number: number): Promise<GitHubOperationalPullRequestEvidence> {
    return operationalPullRequest(this.remote);
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
  assert.equal((result.output.semantic as Record<string, unknown>).status, "legacy-artifact");
  assert.deepEqual(result.fallbacks, []);
});

test("issue view retains bounded semantic diagnostics for malformed, unmatched, ambiguous, legacy, and valid artifacts", async () => {
  const cases = [
    {
      name: "malformed template",
      templates: [{ path: ".github/ISSUE_TEMPLATE/feature.yml", source: "name: [broken" }],
      body: validBody,
      status: "malformed-template",
    },
    {
      name: "no matching template",
      templates: [{ path: ".github/ISSUE_TEMPLATE/feature.yml", source: issueTemplate }],
      body: "### Other\n\nLegacy body\n",
      status: "no-matching-template",
    },
    {
      name: "ambiguous template",
      templates: [
        { path: ".github/ISSUE_TEMPLATE/alpha.yml", source: issueTemplate },
        { path: ".github/ISSUE_TEMPLATE/beta.yml", source: issueTemplate },
      ],
      body: validBody,
      status: "ambiguous-template",
    },
    {
      name: "legacy artifact",
      templates: [{ path: ".github/ISSUE_TEMPLATE/feature.yml", source: issueTemplate }],
      body: "Problem: old format\nProposal: old format\n",
      status: "legacy-artifact",
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

test("PR view preserves runtime evidence for every semantic failure class", async () => {
  const cases = [
    {
      name: "malformed template",
      templates: [{ path: ".github/PULL_REQUEST_TEMPLATE.md", source: "" }],
      body: validPullRequestBody,
      status: "malformed-template",
    },
    {
      name: "no matching template",
      templates: [{ path: ".github/PULL_REQUEST_TEMPLATE.md", source: pullRequestTemplate }],
      body: "## Other\n\nLegacy body\n",
      status: "no-matching-template",
    },
    {
      name: "ambiguous template",
      templates: [
        { path: ".github/PULL_REQUEST_TEMPLATE.md", source: pullRequestTemplate },
        { path: ".github/PULL_REQUEST_TEMPLATE/alternative.md", source: pullRequestTemplate },
      ],
      body: validPullRequestBody,
      status: "ambiguous-template",
    },
    {
      name: "legacy artifact",
      templates: [{ path: ".github/PULL_REQUEST_TEMPLATE.md", source: pullRequestTemplate }],
      body: "Summary: old format\n",
      status: "legacy-artifact",
    },
    {
      name: "valid canonical artifact",
      templates: [{ path: ".github/PULL_REQUEST_TEMPLATE.md", source: pullRequestTemplate }],
      body: validPullRequestBody,
      status: "valid",
    },
  ] as const;

  for (const testCase of cases) {
    const result = await capture(new PullRequestViewAdapter(pullRequest(8, testCase.body), testCase.templates), [
      "pr",
      "view",
      "8",
      "--json",
    ]);
    assert.equal(result.exitCode, 0, testCase.name);
    const observed = result.output.observed as Record<string, unknown>;
    assert.equal(observed.title, "Observed pull request", testCase.name);
    assert.equal(observed.body, testCase.body, testCase.name);
    assert.equal(observed.state, "open", testCase.name);
    assert.deepEqual(observed.head, { branch: "feat/snapshot", sha: "head-sha" }, testCase.name);
    assert.deepEqual(observed.base, { branch: "main", sha: "base-sha" }, testCase.name);
    assert.equal((result.output.semantic as Record<string, unknown>).status, testCase.status, testCase.name);
    assert.deepEqual(result.fallbacks, [], testCase.name);
  }
});

test("PR view reports semantic-invalidity without dropping runtime evidence", async () => {
  const body = ["## Summary", "", "short", "## Validation", "", "- [x] Tests", ""].join("\n");
  const result = await capture(
    new PullRequestViewAdapter(pullRequest(8, body), [
      { path: ".github/PULL_REQUEST_TEMPLATE.md", source: pullRequestTemplate },
      { path: ".github/inari/pr-policy.yml", source: pullRequestPolicy },
    ]),
    ["pr", "view", "8", "--json"],
  );
  assert.equal(result.exitCode, 0);
  assert.equal((result.output.semantic as Record<string, unknown>).status, "semantic-invalidity");
  const observed = result.output.observed as Record<string, unknown>;
  assert.equal(observed.title, "Observed pull request");
  assert.equal(observed.body, body);
  assert.deepEqual(observed.head, { branch: "feat/snapshot", sha: "head-sha" });
  assert.deepEqual(observed.base, { branch: "main", sha: "base-sha" });
});

test("semantic governance evidence failure is distinct from artifact provider failure", async () => {
  class GovernanceEvidenceUnavailableAdapter extends PullRequestViewAdapter {
    override async getRepositoryBlob(_sha: string): Promise<string> {
      throw new Error("repository Canon read failed");
    }
  }

  const governanceEvidence = await capture(
    new GovernanceEvidenceUnavailableAdapter(pullRequest(8, validPullRequestBody), [
      { path: ".github/PULL_REQUEST_TEMPLATE.md", source: pullRequestTemplate },
    ]),
    ["pr", "view", "8", "--json"],
  );
  assert.equal(governanceEvidence.exitCode, 0);
  assert.equal(
    (governanceEvidence.output.semantic as Record<string, unknown>).status,
    "governance-evidence-unavailable",
  );
  assert.equal(
    ((governanceEvidence.output.semantic as Record<string, unknown>).failure as Record<string, unknown>).kind,
    "governance-evidence",
  );

  class GovernanceFailingAdapter extends PullRequestViewAdapter {
    override async getRepositoryBlob(_sha: string): Promise<string> {
      throw new GitHubApiError("repository.governance.blob", "template evidence unavailable");
    }
  }

  const governance = await capture(
    new GovernanceFailingAdapter(pullRequest(8, validPullRequestBody), [
      { path: ".github/PULL_REQUEST_TEMPLATE.md", source: pullRequestTemplate },
    ]),
    ["pr", "view", "8", "--json"],
  );
  assert.equal(governance.exitCode, 0);
  assert.equal((governance.output.semantic as Record<string, unknown>).status, "provider-failure");
  assert.equal(
    ((governance.output.semantic as Record<string, unknown>).failure as Record<string, unknown>).kind,
    "provider",
  );
  assert.equal((governance.output.observed as Record<string, unknown>).body, validPullRequestBody);

  class ArtifactFailingAdapter extends PullRequestViewAdapter {
    override async observePullRequest(): Promise<GitHubOperationalPullRequestEvidence> {
      throw new GitHubApiError("pull_request.observe", "artifact unavailable");
    }
  }
  const artifact = await capture(new ArtifactFailingAdapter(pullRequest(8, validPullRequestBody), []), [
    "pr",
    "view",
    "8",
    "--json",
  ]);
  assert.equal(artifact.exitCode, 3);
  assert.equal(artifact.output.ok, false);
  assert.equal((artifact.output.error as Record<string, unknown>).code, "GITHUB_API_FAILED");
});

test("view derives semantic and observed output from one artifact snapshot", async () => {
  class FlappingIssueAdapter extends ViewAdapter {
    observations = 0;

    override async observeIssue(_number: number): Promise<GitHubOperationalIssueEvidence> {
      this.observations += 1;
      return operationalIssue(issue(7, validBody));
    }
  }

  const issueAdapter = new FlappingIssueAdapter(issue(7, "Legacy second read"), [
    { path: ".github/ISSUE_TEMPLATE/feature.yml", source: issueTemplate },
  ]);
  const issueResult = await capture(issueAdapter);
  assert.equal(issueAdapter.observations, 1);
  assert.equal(issueAdapter.getIssueCalls, 0);
  assert.equal((issueResult.output.observed as Record<string, unknown>).body, validBody);
  assert.equal((issueResult.output.semantic as Record<string, unknown>).status, "valid");

  class FlappingPullRequestAdapter extends PullRequestViewAdapter {
    observations = 0;

    override async observePullRequest(_number: number): Promise<GitHubOperationalPullRequestEvidence> {
      this.observations += 1;
      return operationalPullRequest(pullRequest(8, validPullRequestBody));
    }
  }
  const prAdapter = new FlappingPullRequestAdapter(pullRequest(8, "Legacy second read"), [
    { path: ".github/PULL_REQUEST_TEMPLATE.md", source: pullRequestTemplate },
  ]);
  const prResult = await capture(prAdapter, ["pr", "view", "8", "--json"]);
  assert.equal(prAdapter.observations, 1);
  assert.equal(prAdapter.getPullRequestCalls, 0);
  assert.equal((prResult.output.observed as Record<string, unknown>).body, validPullRequestBody);
  assert.equal((prResult.output.semantic as Record<string, unknown>).status, "valid");
});
