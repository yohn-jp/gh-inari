import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContractViolationError,
  GitHubAuthenticationError,
  GitHubAdapter,
  GitHubApiError,
  GitHubApiResponseError,
  GitHubResponseLimitError,
  GitHubResourceKindMismatchError,
  GitHubTimeoutError,
  GitHubTransportError,
  RepositoryResolutionError,
  type GitHubIssue,
  type GitHubPullRequest,
  type ValidatedRenderedIssueArtifact,
} from "./index.js";
import {
  nativeTestTransport,
  type FixtureCommandOptions,
  type FixtureCommandResult,
  type FixtureCommandTransport,
} from "./test-native-transport.test.js";
import { GitHubHttpResponseLimitError, GitHubHttpTimeoutError } from "./native-http-transport.js";
import { readGitHubProviderFailure } from "./provider-failure.js";
import { prepareIssueArtifact, preparePullRequestArtifact } from "../artifact.js";
import { issueContractFixture, pullRequestContractFixture } from "../contract/fixtures.js";
import type { CanonicalContract } from "../contract/ir.js";
import { createChangeExecutionDeadline } from "../change-execution-port.js";

interface RecordedCall {
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly maxStdoutBytes: number | undefined;
  readonly maxStderrBytes: number | undefined;
}

class StubFixtureTransport implements FixtureCommandTransport {
  readonly calls: RecordedCall[] = [];
  private readonly responses: Array<FixtureCommandResult | Error>;

  constructor(responses: Array<FixtureCommandResult | Error>) {
    this.responses = [...responses];
  }

  async run(args: readonly string[], options?: FixtureCommandOptions): Promise<FixtureCommandResult> {
    this.calls.push({
      args: [...args],
      cwd: options?.cwd,
      timeoutMs: options?.timeoutMs,
      maxStdoutBytes: options?.maxStdoutBytes,
      maxStderrBytes: options?.maxStderrBytes,
    });
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    if (response instanceof Error) throw response;
    return response;
  }
}

class MissingProviderError extends Error {
  readonly code = "ENOENT";

  constructor() {
    super("gh executable not found");
    this.name = "MissingProviderError";
  }
}

function command(exitCode = 0, stdout = "", stderr = ""): FixtureCommandResult {
  return { exitCode, stdout, stderr };
}

function repositoryIdentityResponse(
  repository = "acme/inari",
  id = "100000157",
  host = "github.com",
): FixtureCommandResult {
  return command(0, `${id}\n`);
}

function repositoryMetadataResponse(repository = "acme/inari", host = "github.com"): FixtureCommandResult {
  return command(0, JSON.stringify({ nameWithOwner: repository, url: `https://${host}/${repository}` }));
}

function issuePayload(number = 42): string {
  return JSON.stringify({
    number,
    title: "An issue",
    body: "Rendered issue body",
    state: "open",
    html_url: `https://github.com/acme/inari/issues/${number}`,
    labels: [{ name: "bug" }],
    assignees: [{ login: "octocat" }],
  });
}

function pullRequestPayload(number = 43): string {
  return JSON.stringify({
    number,
    title: "A pull request",
    body: "Rendered pull request body",
    state: "open",
    draft: false,
    html_url: `https://github.com/acme/inari/pull/${number}`,
    head: { ref: "feature" },
    base: { ref: "main" },
    labels: [],
    assignees: [],
    milestone: null,
    requested_reviewers: [],
    requested_teams: [],
  });
}

function operationalPullRequestPayload(number = 43): string {
  const payload = JSON.parse(pullRequestPayload(number)) as Record<string, unknown>;
  payload.head = { ref: "feature", sha: "head-sha" };
  payload.review_decision = "APPROVED";
  return JSON.stringify(payload);
}

function jsonCommand(value: unknown): FixtureCommandResult {
  return command(0, JSON.stringify(value));
}

function includedJsonCommand(value: unknown, status = 200): FixtureCommandResult {
  return command(0, `HTTP/2 ${status} OK\ncontent-type: application/json\n\n${JSON.stringify(value)}`);
}

function operationalPullRequestTransport(
  checkRuns: readonly Record<string, unknown>[],
  statuses: readonly Record<string, unknown>[],
  requiredStatusChecks: Record<string, unknown> = { contexts: [], checks: [] },
): StubFixtureTransport {
  return new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    jsonCommand(JSON.parse(operationalPullRequestPayload())),
    includedJsonCommand([]),
    includedJsonCommand([]),
    includedJsonCommand([]),
    includedJsonCommand([]),
    includedJsonCommand({ check_runs: checkRuns }),
    includedJsonCommand({ statuses }),
    includedJsonCommand(requiredStatusChecks),
  ]);
}

function withField(payload: string, field: string, value: unknown): string {
  const record = JSON.parse(payload) as Record<string, unknown>;
  record[field] = value;
  return JSON.stringify(record);
}

function withoutFields(payload: string, ...fields: readonly string[]): string {
  const record = JSON.parse(payload) as Record<string, unknown>;
  for (const field of fields) delete record[field];
  return JSON.stringify(record);
}

function pullRequestPayloadWithDraft(number: number, draft: unknown): string {
  const payload = JSON.parse(pullRequestPayload(number)) as Record<string, unknown>;
  if (draft === undefined) delete payload.draft;
  else payload.draft = draft;
  return JSON.stringify(payload);
}

function pullRequestPayloadWithMaintainerCanModify(number: number, value: unknown): string {
  const payload = JSON.parse(pullRequestPayload(number)) as Record<string, unknown>;
  payload.maintainer_can_modify = value;
  return JSON.stringify(payload);
}

function governedFixture(contract: CanonicalContract): CanonicalContract {
  return {
    ...contract,
    provenance: {
      authority: "repository-default-branch",
      repository: {
        host: "github.com",
        owner: "acme",
        name: "inari",
        nameWithOwner: "acme/inari",
        repositoryId: "100000157",
      },
      ref: "main",
      treeSha: "fixture-tree-sha",
      template: {
        path: contract.templateIdentity.path,
        ref: "main",
        sha: "fixture-template-sha",
        digest: "fixture-template-digest",
      },
    },
  };
}

test("resolves the current repository from local Git evidence", async () => {
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryMetadataResponse(),
    repositoryIdentityResponse(),
  ]);
  const adapter = new GitHubAdapter({
    cwd: "/workspace/inari",
    git: () => "https://github.com/acme/inari.git\n",
    transport: nativeTestTransport(transport, { localRepository: true }),
  });

  const context = await adapter.resolveRepositoryContext();

  assert.deepEqual(context, {
    hostname: "github.com",
    host: "github.com",
    owner: "acme",
    name: "inari",
    nameWithOwner: "acme/inari",
    url: "https://github.com/acme/inari",
    repositoryId: "100000157",
  });
  assert.deepEqual(
    transport.calls.map((call) => call.args),
    [
      ["--version"],
      ["auth", "status", "--hostname", "github.com"],
      ["repo", "view", "--json", "nameWithOwner,url"],
      ["api", "repos/acme/inari", "--hostname", "github.com", "--method", "GET", "--jq", ".id"],
    ],
  );
});

test("uses an explicit repository override without asking gh to infer local context", async () => {
  const transport = new StubFixtureTransport([command(0, "gh version 2.0"), command(), repositoryIdentityResponse()]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  const context = await adapter.resolveRepositoryContext();

  assert.equal(context.nameWithOwner, "acme/inari");
  assert.equal(context.hostname, "github.com");
  assert.equal(context.repositoryId, "100000157");
  assert.deepEqual(
    transport.calls.map((call) => call.args),
    [
      ["--version"],
      ["auth", "status", "--hostname", "github.com"],
      ["api", "repos/acme/inari", "--hostname", "github.com", "--method", "GET", "--jq", ".id"],
    ],
  );
});

test("binds explicit GHES repository overrides to the resolved host and database identity", async () => {
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse("acme/inari", "100000157", "ghe.example.com"),
  ]);
  const adapter = new GitHubAdapter({
    repository: "ghe.example.com/acme/inari",
    transport: nativeTestTransport(transport),
  });

  const context = await adapter.resolveRepositoryContext();
  assert.equal(context.hostname, "ghe.example.com");
  assert.equal(context.repositoryId, "100000157");
  assert.deepEqual(transport.calls[2]?.args, [
    "api",
    "repos/acme/inari",
    "--hostname",
    "ghe.example.com",
    "--method",
    "GET",
    "--jq",
    ".id",
  ]);
});

test("returns a typed actionable failure when the native provider is unavailable", async () => {
  const transport = new StubFixtureTransport([new MissingProviderError()]);
  const adapter = new GitHubAdapter({ transport: nativeTestTransport(transport) });

  await assert.rejects(
    adapter.checkAuthentication(),
    (error: unknown) =>
      error instanceof GitHubTransportError &&
      error.code === "GITHUB_TRANSPORT_FAILED" &&
      error.category === "transport",
  );
});

test("coalesces concurrent native repository resolutions onto one in-flight call", async () => {
  const transport = new StubFixtureTransport([command(0, "gh version 2.0"), command(), repositoryIdentityResponse()]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  await Promise.all([adapter.resolveRepositoryContext(), adapter.resolveRepositoryContext()]);

  assert.deepEqual(
    transport.calls.map((call) => call.args[0]),
    ["--version", "auth", "api"],
  );
});

test("repository context accepts repository-scoped credentials without requiring GET /user", async () => {
  const paths: string[] = [];
  const adapter = new GitHubAdapter({
    repository: "acme/inari",
    transport: {
      request: async (request) => {
        paths.push(request.path);
        if (request.path === "user")
          return { status: 403, body: { message: "Resource not accessible by integration" } };
        if (request.path === "repos/acme/inari") return { status: 200, body: { id: 100000157 } };
        throw new Error(`Unexpected request: ${request.method} ${request.path}`);
      },
    },
  });

  const context = await adapter.resolveRepositoryContext();
  assert.equal(context.repositoryId, "100000157");
  assert.deepEqual(paths, ["repos/acme/inari"]);

  await assert.rejects(
    adapter.getAuthenticatedUser(),
    (error: unknown) =>
      error instanceof GitHubAuthenticationError &&
      error.code === "GITHUB_AUTHENTICATION_FAILED" &&
      error.category === "authentication",
  );
  assert.deepEqual(paths, ["repos/acme/inari", "user"]);
});

test("returns a typed failure when the native provider is not authenticated", async () => {
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(1, "", "You are not logged in to any GitHub hosts."),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  await assert.rejects(
    adapter.resolveRepositoryContext(),
    (error: unknown) =>
      error instanceof GitHubAuthenticationError &&
      error.code === "GITHUB_AUTHENTICATION_FAILED" &&
      error.category === "authentication",
  );
});

test("preserves authentication provider failure classification through the typed wrapper", async () => {
  const adapter = new GitHubAdapter({
    transport: {
      request: async () => ({ status: 401, body: { message: "provider response" } }),
    },
  });

  await assert.rejects(
    adapter.checkAuthentication(),
    (error: unknown) =>
      error instanceof GitHubAuthenticationError &&
      readGitHubProviderFailure(error)?.failureClass === "authentication" &&
      readGitHubProviderFailure(error)?.retryable === false,
  );
});

test("preserves bounded status classifications for authenticated-user failures", async () => {
  const cases = [
    { status: 429, failureClass: "rate-limit", retryable: true },
    { status: 500, failureClass: "server", retryable: true },
    { status: 400, failureClass: "provider-rejection", retryable: false },
  ] as const;

  for (const expected of cases) {
    const responses = [
      { status: 200, body: { login: "octocat" } },
      { status: expected.status, body: { message: "provider response" } },
    ];
    const adapter = new GitHubAdapter({
      transport: { request: async () => responses.shift() ?? { status: 500, body: undefined } },
    });

    await assert.rejects(
      adapter.getAuthenticatedUser(),
      (error: unknown) =>
        error instanceof GitHubApiError &&
        readGitHubProviderFailure(error)?.failureClass === expected.failureClass &&
        readGitHubProviderFailure(error)?.retryable === expected.retryable &&
        readGitHubProviderFailure(error)?.status === expected.status,
      `status ${expected.status}`,
    );
  }
});

test("preserves timeout provider classification through authentication", async () => {
  const adapter = new GitHubAdapter({
    transport: {
      request: async () => {
        throw new GitHubHttpTimeoutError(250);
      },
    },
  });

  await assert.rejects(
    adapter.checkAuthentication(),
    (error: unknown) =>
      error instanceof GitHubTimeoutError &&
      readGitHubProviderFailure(error)?.failureClass === "timeout" &&
      readGitHubProviderFailure(error)?.retryable === true &&
      readGitHubProviderFailure(error)?.timeoutMs === 250,
  );
});

test("returns a typed failure when the local repository cannot be resolved", async () => {
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    command(1, "", "fatal: not a git repository"),
  ]);
  const adapter = new GitHubAdapter({ cwd: "/tmp", transport: nativeTestTransport(transport) });

  await assert.rejects(
    adapter.resolveRepositoryContext(),
    (error: unknown) =>
      error instanceof RepositoryResolutionError &&
      error.code === "REPOSITORY_RESOLUTION_FAILED" &&
      error.category === "repository",
  );
});

test("fails closed when repository resolution has no immutable identity", async () => {
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryMetadataResponse(),
    command(0, JSON.stringify({ nameWithOwner: "acme/inari", url: "https://github.com/acme/inari" })),
  ]);
  const adapter = new GitHubAdapter({
    cwd: "/workspace/inari",
    git: () => "https://github.com/acme/inari.git\n",
    transport: nativeTestTransport(transport, { localRepository: true }),
  });

  await assert.rejects(
    adapter.resolveRepositoryContext(),
    (error: unknown) =>
      error instanceof RepositoryResolutionError && error.message.includes("repository database identity"),
  );
});

test("fails closed when an explicit repository override has no immutable identity", async () => {
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    command(0, JSON.stringify({ nameWithOwner: "acme/inari", url: "https://github.com/acme/inari" })),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  await assert.rejects(
    adapter.resolveRepositoryContext(),
    (error: unknown) =>
      error instanceof RepositoryResolutionError && error.message.includes("repository database identity"),
  );
});

test("supports MVP Issue and pull request reads and mutations through a fake transport", async () => {
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, issuePayload()),
    command(0, pullRequestPayload()),
    command(0, issuePayload(44)),
    command(0, issuePayload(45)),
    command(0, issuePayload(45)),
    command(0, pullRequestPayload(46)),
    command(0, pullRequestPayload(47)),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });
  const issueArtifact = prepareIssueArtifact(governedFixture(issueContractFixture), {
    fields: {
      problem: "A rendered issue",
      category: "feature",
      affected_areas: ["contracts"],
      acceptance: ["tests"],
    },
    metadata: { title: "Rendered issue", labels: ["bug"], assignees: ["octocat"] },
  }).artifact;
  const pullRequestArtifact = preparePullRequestArtifact(governedFixture(pullRequestContractFixture), {
    fields: { summary: "A rendered pull request", linked_issue: "Closes #22", acceptance: ["tests"] },
    metadata: {
      title: "Rendered pull request",
      head: "feature",
      base: "main",
      draft: false,
      maintainerCanModify: true,
    },
  }).artifact;

  assert.equal((await adapter.getIssue(42)).number, 42);
  const pullRequest = await adapter.getPullRequest(43);
  assert.equal(pullRequest.head, "feature");
  assert.equal(pullRequest.draft, false);
  assert.equal((await adapter.createIssue(issueArtifact)).number, 44);
  assert.equal((await adapter.updateIssue(45, issueArtifact)).number, 45);
  assert.equal((await adapter.createPullRequest(pullRequestArtifact)).number, 46);
  assert.equal((await adapter.updatePullRequest(47, pullRequestArtifact)).number, 47);

  const issueCreate = transport.calls.find(
    (call) => call.args.includes("repos/acme/inari/issues") && call.args.includes("POST"),
  );
  assert.ok(issueCreate);
  assert.ok(issueCreate.args.some((argument) => argument.startsWith("body=### Problem")));
  assert.ok(issueCreate.args.includes("labels[]=bug"));
  assert.ok(issueCreate.args.includes("assignees[]=octocat"));

  const pullRequestCreate = transport.calls.find(
    (call) => call.args.includes("repos/acme/inari/pulls") && call.args.includes("POST"),
  );
  assert.ok(pullRequestCreate);
  assert.ok(pullRequestCreate.args.some((argument) => argument.startsWith("body=## Summary")));
  assert.ok(pullRequestCreate.args.includes("head=feature"));
  assert.ok(pullRequestCreate.args.includes("base=main"));
  assert.ok(pullRequestCreate.args.includes("maintainer_can_modify=true"));

  const pullRequestUpdate = transport.calls.find(
    (call) => call.args.includes("repos/acme/inari/pulls/47") && call.args.includes("PATCH"),
  );
  assert.ok(pullRequestUpdate);
  assert.ok(pullRequestUpdate.args.includes("base=main"));
  assert.ok(pullRequestUpdate.args.includes("maintainer_can_modify=true"));
  assert.equal(
    pullRequestUpdate.args.some((argument) => argument.startsWith("draft=")),
    false,
  );
});

test("createBranch uses the supplied source SHA without rereading the source ref", async () => {
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, JSON.stringify({ ref: "refs/heads/feature", object: { type: "commit", sha: "bound-sha" } })),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  const branch = await adapter.createBranch("feature", "main", "bound-sha");

  assert.equal(branch.sha, "bound-sha");
  assert.equal(
    transport.calls.some((call) => call.args.includes("git/ref/heads/main")),
    false,
  );
  const create = transport.calls.find((call) => call.args.includes("repos/acme/inari/git/refs"));
  assert.ok(create);
  assert.ok(create.args.includes("sha=bound-sha"));
});

test("reads the repository root without adding a trailing slash", async () => {
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, 'HTTP/2 200 OK\ncontent-type: application/json\n\n{"id":100000157,"default_branch":"main"}'),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  const response = await adapter.requestRepositoryApi("");

  assert.deepEqual(response, { status: 200, body: { id: 100000157, default_branch: "main" } });
  assert.deepEqual(transport.calls.at(-1)?.args, [
    "api",
    "repos/acme/inari",
    "--hostname",
    "github.com",
    "--method",
    "GET",
    "--include",
  ]);
});

test("allows the bounded commit compare path used by release history", async () => {
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, 'HTTP/2 200 OK\ncontent-type: application/json\n\n{"status":"ahead","commits":[]}'),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  const response = await adapter.requestRepositoryApi(`compare/${base}...${head}?per_page=100`);

  assert.equal(response.status, 200);
  assert.ok(transport.calls.at(-1)?.args.includes(`repos/acme/inari/compare/${base}...${head}?per_page=100`));
});

test("normalizes Check Run app identity and commit-status source identity", async () => {
  const transport = operationalPullRequestTransport(
    [
      {
        id: 11,
        name: "verify",
        app: { id: 101, slug: "trusted-ci" },
        status: "completed",
        conclusion: "failure",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:01Z",
      },
    ],
    [
      {
        id: 21,
        context: "verify",
        creator: { id: 202, login: "spoof" },
        state: "success",
        created_at: "2026-01-01T00:00:02Z",
        updated_at: "2026-01-01T00:00:03Z",
      },
    ],
  );
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  const observed = await adapter.observePullRequest(43);
  assert.equal(observed.checks.status, "available");
  assert.deepEqual(
    observed.checks.items.map((check) => check.identity),
    [
      { context: "verify", producer: "app:101" },
      { context: "verify", producer: "creator:202" },
    ],
  );
  assert.deepEqual(
    observed.checks.items.map((check) => check.current),
    [true, true],
  );
  assert.deepEqual(observed.provenance.endpoints, [
    "branches/main/protection/required_status_checks",
    "commits/head-sha/check-runs",
    "commits/head-sha/status",
    "issues/43/comments",
    "pulls/43",
    "pulls/43/comments",
    "pulls/43/files",
    "pulls/43/reviews",
  ]);
});

test("normalizes the base branch's required-status-check policy into expected producer bindings", async () => {
  const transport = operationalPullRequestTransport([], [], {
    contexts: ["legacy-context"],
    checks: [
      { context: "verify", app_id: 101 },
      { context: "legacy-context", app_id: null },
    ],
  });
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  const observed = await adapter.observePullRequest(43);
  assert.equal(observed.requiredCheckBindings.status, "available");
  assert.deepEqual(observed.requiredCheckBindings.items, [
    { context: "legacy-context" },
    { context: "verify", producer: "app:101" },
  ]);
});

test("conflicting producer bindings for one context fail closed regardless of provider array order", async () => {
  for (const checks of [
    [
      { context: "verify", app_id: 101 },
      { context: "verify", app_id: 202 },
    ],
    [
      { context: "verify", app_id: 202 },
      { context: "verify", app_id: 101 },
    ],
  ]) {
    const transport = operationalPullRequestTransport([], [], { checks });
    const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

    const observed = await adapter.observePullRequest(43);
    assert.equal(observed.requiredCheckBindings.status, "unavailable");
    assert.equal(observed.requiredCheckBindings.items.length, 0);
  }
});

test("duplicate identical producer bindings for one context dedupe to a single authoritative binding", async () => {
  const transport = operationalPullRequestTransport([], [], {
    checks: [
      { context: "verify", app_id: 101 },
      { context: "verify", app_id: 101 },
    ],
  });
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  const observed = await adapter.observePullRequest(43);
  assert.equal(observed.requiredCheckBindings.status, "available");
  assert.deepEqual(observed.requiredCheckBindings.items, [{ context: "verify", producer: "app:101" }]);
});

test("a malformed required-check policy entry fails the whole policy read closed", async () => {
  for (const checks of [
    [{ context: "verify", app_id: 101 }, { app_id: 202 }],
    [{ context: "verify", app_id: "not-a-number" }],
  ]) {
    const transport = operationalPullRequestTransport([], [], { checks });
    const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

    const observed = await adapter.observePullRequest(43);
    assert.equal(observed.requiredCheckBindings.status, "unavailable");
    assert.equal(observed.requiredCheckBindings.items.length, 0);
  }
});

test("a missing required-status-check policy is explicitly unavailable, not an empty policy", async () => {
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    jsonCommand(JSON.parse(operationalPullRequestPayload())),
    includedJsonCommand([]),
    includedJsonCommand([]),
    includedJsonCommand([]),
    includedJsonCommand([]),
    includedJsonCommand({ check_runs: [] }),
    includedJsonCommand({ statuses: [] }),
    includedJsonCommand({}, 404),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  const observed = await adapter.observePullRequest(43);
  assert.equal(observed.requiredCheckBindings.status, "unavailable");
  assert.equal(observed.requiredCheckBindings.items.length, 0);
});

test("adapter marks the newest same-producer execution current and ties unknown", async () => {
  const transport = operationalPullRequestTransport(
    [
      {
        id: 11,
        name: "verify",
        app: { id: 101 },
        status: "completed",
        conclusion: "failure",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:01Z",
      },
      {
        id: 12,
        name: "verify",
        app: { id: 101 },
        status: "completed",
        conclusion: "success",
        created_at: "2026-01-01T00:01:00Z",
        updated_at: "2026-01-01T00:01:01Z",
      },
    ],
    [],
  );
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });
  const observed = await adapter.observePullRequest(43);
  assert.equal(observed.checks.items.find((check) => check.id === "11")?.current, false);
  assert.equal(observed.checks.items.find((check) => check.id === "12")?.current, true);

  const tiedTransport = operationalPullRequestTransport(
    [
      {
        id: 13,
        name: "verify",
        app: { id: 101 },
        status: "completed",
        conclusion: "success",
        updated_at: "2026-01-01T00:02:00Z",
      },
      {
        id: 14,
        name: "verify",
        app: { id: 101 },
        status: "completed",
        conclusion: "failure",
        updated_at: "2026-01-01T00:02:00Z",
      },
    ],
    [],
  );
  const tied = await new GitHubAdapter({
    repository: "acme/inari",
    transport: nativeTestTransport(tiedTransport),
  }).observePullRequest(43);
  assert.deepEqual(
    tied.checks.items.map((check) => check.current),
    ["unknown", "unknown"],
  );
});

test("rejects missing and non-boolean pull request draft response fields", async () => {
  for (const draft of [undefined, null, "false", 0]) {
    const transport = new StubFixtureTransport([
      command(0, "gh version 2.0"),
      command(),
      repositoryIdentityResponse(),
      command(0, pullRequestPayloadWithDraft(50, draft)),
    ]);
    const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

    await assert.rejects(
      adapter.getPullRequest(50),
      (error: unknown) =>
        error instanceof GitHubApiResponseError &&
        error.code === "GITHUB_API_RESPONSE_INVALID" &&
        error.category === "api" &&
        error.details.operation === "pull_request.read" &&
        error.details.path === "draft",
    );
  }
});

test("preserves valid pull request draft boolean response fields", async () => {
  for (const [number, draft] of [
    [51, false],
    [52, true],
  ] as const) {
    const transport = new StubFixtureTransport([
      command(0, "gh version 2.0"),
      command(),
      repositoryIdentityResponse(),
      command(0, pullRequestPayloadWithDraft(number, draft)),
    ]);
    const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

    assert.equal((await adapter.getPullRequest(number)).draft, draft);
  }
});

test("preserves optional pull request maintainer-can-modify response metadata", async () => {
  for (const [number, value] of [
    [53, false],
    [54, true],
  ] as const) {
    const transport = new StubFixtureTransport([
      command(0, "gh version 2.0"),
      command(),
      repositoryIdentityResponse(),
      command(0, pullRequestPayloadWithMaintainerCanModify(number, value)),
    ]);
    const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

    assert.equal((await adapter.getPullRequest(number)).maintainerCanModify, value);
  }
});

test("rejects a non-boolean pull request maintainer-can-modify response field", async () => {
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, pullRequestPayloadWithMaintainerCanModify(55, "true")),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  await assert.rejects(
    adapter.getPullRequest(55),
    (error: unknown) =>
      error instanceof GitHubApiResponseError &&
      error.code === "GITHUB_API_RESPONSE_INVALID" &&
      error.details.operation === "pull_request.read" &&
      error.details.path === "maintainer_can_modify",
  );
});

test("rejects an unvalidated artifact before invoking any transport or mutation", async () => {
  const transport = new StubFixtureTransport([]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });
  const rawArtifact = {
    phase: "validated-rendered",
    kind: "issue",
    title: "Raw title",
    body: "Raw body",
    provenance: {
      authority: "repository-default-branch",
      repository: { host: "github.com", owner: "acme", name: "inari", nameWithOwner: "acme/inari" },
      ref: "main",
      template: { path: ".github/ISSUE_TEMPLATE/feature.yml", ref: "main", sha: "sha", digest: "digest" },
    },
  } as unknown as ValidatedRenderedIssueArtifact;

  await assert.rejects(
    adapter.createIssue(rawArtifact),
    (error: unknown) =>
      error instanceof ContractViolationError && error.code === "CONTRACT_VIOLATION" && error.category === "contract",
  );
  assert.equal(transport.calls.length, 0);
});

test("rejects a prepared artifact bound to a different repository before mutation", async () => {
  const sourceContract = governedFixture(issueContractFixture);
  const mismatchedContract = {
    ...sourceContract,
    provenance: {
      ...sourceContract.provenance,
      repository: {
        ...sourceContract.provenance?.repository,
        name: "other",
        nameWithOwner: "acme/other",
        repositoryId: "100000999",
      },
    },
  } as CanonicalContract;
  const artifact = prepareIssueArtifact(mismatchedContract, {
    fields: {
      problem: "A mismatched target",
      category: "feature",
      affected_areas: ["contracts"],
      acceptance: ["tests"],
    },
    metadata: { title: "mismatch" },
  }).artifact;
  const transport = new StubFixtureTransport([command(0, "gh version 2.0"), command(), repositoryIdentityResponse()]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  await assert.rejects(
    adapter.createIssue(artifact),
    (error: unknown) => error instanceof ContractViolationError && error.message.includes("provenance"),
  );
  assert.equal(
    transport.calls.some((call) => call.args.includes("POST")),
    false,
  );
});

test("keeps API failures and process transport failures distinct from contract failures", async () => {
  const apiFailureTransport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(1, "", "HTTP 500: service unavailable"),
  ]);
  const apiFailureAdapter = new GitHubAdapter({
    repository: "acme/inari",
    transport: nativeTestTransport(apiFailureTransport),
  });
  await assert.rejects(
    apiFailureAdapter.getIssue(42),
    (error: unknown) =>
      error instanceof GitHubApiError && error.code === "GITHUB_API_FAILED" && error.category === "api",
  );

  const transportFailureTransport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    new Error("socket closed"),
  ]);
  const transportFailureAdapter = new GitHubAdapter({
    repository: "acme/inari",
    transport: nativeTestTransport(transportFailureTransport),
  });
  await assert.rejects(
    transportFailureAdapter.getIssue(42),
    (error: unknown) =>
      error instanceof GitHubTransportError &&
      error.code === "GITHUB_TRANSPORT_FAILED" &&
      error.category === "transport",
  );
});

test("surfaces a response-limit failure with a stable machine-readable code", async () => {
  const transport = new StubFixtureTransport([new GitHubHttpResponseLimitError(128)]);
  const adapter = new GitHubAdapter({ transport: nativeTestTransport(transport) });

  await assert.rejects(
    adapter.checkAuthentication(),
    (error: unknown) =>
      error instanceof GitHubResponseLimitError &&
      error.code === "GITHUB_RESPONSE_LIMIT_EXCEEDED" &&
      error.category === "transport",
  );
});

test("rejects partial JSON from a zero-exit API response", async () => {
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, '{"number":42'),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  await assert.rejects(
    adapter.getIssue(42),
    (error: unknown) => error instanceof GitHubApiResponseError && error.code === "GITHUB_API_RESPONSE_INVALID",
  );
});

test("getIssue fails closed when GitHub returns a pull-request-shaped resource", async () => {
  const prShapedIssue = { ...JSON.parse(issuePayload(48)), pull_request: { url: "https://api.github.com/pulls/48" } };
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, JSON.stringify(prShapedIssue)),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  await assert.rejects(
    adapter.getIssue(48),
    (error: unknown) =>
      error instanceof GitHubResourceKindMismatchError &&
      error.code === "GITHUB_RESOURCE_KIND_MISMATCH" &&
      error.category === "api",
  );
});

test("updateIssue fails closed before mutating a pull-request-shaped resource", async () => {
  const prShapedIssue = { ...JSON.parse(issuePayload(49)), pull_request: { url: "https://api.github.com/pulls/49" } };
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, JSON.stringify(prShapedIssue)),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });
  const issueArtifact = prepareIssueArtifact(governedFixture(issueContractFixture), {
    fields: {
      problem: "A rendered issue",
      category: "feature",
      affected_areas: ["contracts"],
      acceptance: ["tests"],
    },
    metadata: { title: "Rendered issue" },
  }).artifact;

  await assert.rejects(
    adapter.updateIssue(49, issueArtifact),
    (error: unknown) => error instanceof GitHubResourceKindMismatchError,
  );
  assert.equal(
    transport.calls.some((call) => call.args.includes("PATCH")),
    false,
  );
});

test("closeIssue applies only the explicit Issue close state after an Issue-kind reread", async () => {
  const closed = { ...JSON.parse(issuePayload(50)), state: "closed" };
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, issuePayload(50)),
    command(0, JSON.stringify(closed)),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  const result = await adapter.closeIssue(50);
  assert.equal(result.state, "closed");
  const closeCall = transport.calls.find(
    (call) => call.args.includes("repos/acme/inari/issues/50") && call.args.includes("PATCH"),
  );
  assert.ok(closeCall);
  assert.ok(closeCall.args.includes("state=closed"));
});

function blobPayload(sha: string, contentBase64: string): string {
  return JSON.stringify({ sha, encoding: "base64", content: contentBase64 });
}

test("decodes a governed repository blob with exact valid multibyte UTF-8 text", async () => {
  const sha = "a".repeat(40);
  const text = "こんにちは 😀";
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, blobPayload(sha, Buffer.from(text, "utf8").toString("base64"))),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  const decoded = await adapter.getRepositoryBlob(sha);

  assert.equal(decoded, text);
});

test("rejects a governed repository blob containing invalid UTF-8 byte sequences instead of lossily decoding it", async () => {
  const sha = "a".repeat(40);
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, blobPayload(sha, invalidUtf8.toString("base64"))),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  await assert.rejects(
    adapter.getRepositoryBlob(sha),
    (error: unknown) =>
      error instanceof GitHubApiResponseError &&
      error.code === "GITHUB_API_RESPONSE_INVALID" &&
      error.message.includes("invalid UTF-8"),
  );
});

test("rejects a base64-valid but UTF-8-invalid governed repository blob", async () => {
  const sha = "a".repeat(40);
  const truncatedMultibyte = Buffer.from([0xe3, 0x81]);
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, blobPayload(sha, truncatedMultibyte.toString("base64"))),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  await assert.rejects(
    adapter.getRepositoryBlob(sha),
    (error: unknown) => error instanceof GitHubApiResponseError && error.code === "GITHUB_API_RESPONSE_INVALID",
  );
});

async function issueWith(number: number, field: string, value: unknown): Promise<GitHubIssue> {
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, withField(issuePayload(number), field, value)),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });
  return adapter.getIssue(number);
}

async function issueWithout(number: number, ...fields: readonly string[]): Promise<GitHubIssue> {
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, withoutFields(issuePayload(number), ...fields)),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });
  return adapter.getIssue(number);
}

async function pullRequestWith(number: number, field: string, value: unknown): Promise<GitHubPullRequest> {
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, withField(pullRequestPayload(number), field, value)),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });
  return adapter.getPullRequest(number);
}

async function pullRequestWithout(number: number, ...fields: readonly string[]): Promise<GitHubPullRequest> {
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, withoutFields(pullRequestPayload(number), ...fields)),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });
  return adapter.getPullRequest(number);
}

function assertMilestonePathViolation(error: unknown, operation: string): boolean {
  return (
    error instanceof GitHubApiResponseError &&
    error.code === "GITHUB_API_RESPONSE_INVALID" &&
    error.details.operation === operation &&
    typeof error.details.path === "string" &&
    error.details.path.startsWith("milestone")
  );
}

test("getIssue observes a present milestone", async () => {
  const issue = await issueWith(60, "milestone", { number: 7, title: "v1" });
  assert.deepEqual(issue.milestone, { number: 7, title: "v1" });
});

test("getIssue treats a null and an absent milestone key identically as no milestone", async () => {
  assert.equal((await issueWith(61, "milestone", null)).milestone, undefined);
  assert.equal((await issueWithout(62, "milestone")).milestone, undefined);
});

test("getIssue fails closed on a malformed milestone", async () => {
  for (const malformed of ["not-an-object", { title: "missing number" }, { number: "7", title: "v1" }, []]) {
    await assert.rejects(issueWith(63, "milestone", malformed), (error: unknown) =>
      assertMilestonePathViolation(error, "issue.read"),
    );
  }
});

test("getPullRequest observes present labels, assignees, milestone, and requested reviewers", async () => {
  const pullRequest = await (async () => {
    const transport = new StubFixtureTransport([
      command(0, "gh version 2.0"),
      command(),
      repositoryIdentityResponse(),
      command(
        0,
        withField(
          withField(
            withField(withField(pullRequestPayload(70), "labels", [{ name: "bug" }]), "assignees", [
              { login: "octocat" },
            ]),
            "milestone",
            { number: 3, title: "v2" },
          ),
          "requested_reviewers",
          [{ login: "alice" }],
        ),
      ),
    ]);
    const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });
    return adapter.getPullRequest(70);
  })();

  assert.deepEqual(pullRequest.labels, ["bug"]);
  assert.deepEqual(pullRequest.assignees, ["octocat"]);
  assert.deepEqual(pullRequest.milestone, { number: 3, title: "v2" });
});

test("getPullRequest reports distinct user and team requested reviewers without conflating them", async () => {
  const transport = new StubFixtureTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(
      0,
      withField(
        withField(pullRequestPayload(71), "requested_reviewers", [{ login: "alice" }, { login: "bob" }]),
        "requested_teams",
        [{ slug: "platform-team", name: "Platform Team" }],
      ),
    ),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport: nativeTestTransport(transport) });

  const pullRequest = await adapter.getPullRequest(71);

  assert.deepEqual(pullRequest.requestedReviewers, { users: ["alice", "bob"], teams: ["platform-team"] });
});

test("getPullRequest reports empty requested reviewers distinctly from absent reviewers", async () => {
  const emptyPullRequest = await pullRequestWith(72, "requested_reviewers", []);
  assert.deepEqual(emptyPullRequest.requestedReviewers, { users: [], teams: [] });

  const absentPullRequest = await pullRequestWithout(73, "requested_reviewers", "requested_teams");
  assert.equal(absentPullRequest.requestedReviewers, undefined);
});

test("getPullRequest treats absent labels, assignees, and milestone as unset rather than empty", async () => {
  const pullRequest = await pullRequestWithout(74, "labels", "assignees", "milestone");
  assert.equal(pullRequest.labels, undefined);
  assert.equal(pullRequest.assignees, undefined);
  assert.equal(pullRequest.milestone, undefined);
});

test("getPullRequest fails closed on malformed labels, assignees, and milestone", async () => {
  await assert.rejects(
    pullRequestWith(75, "labels", "not-an-array"),
    (error: unknown) =>
      error instanceof GitHubApiResponseError &&
      error.code === "GITHUB_API_RESPONSE_INVALID" &&
      error.details.operation === "pull_request.read" &&
      error.details.path === "labels",
  );
  await assert.rejects(
    pullRequestWith(76, "assignees", [{ id: 1 }]),
    (error: unknown) =>
      error instanceof GitHubApiResponseError &&
      error.code === "GITHUB_API_RESPONSE_INVALID" &&
      error.details.operation === "pull_request.read",
  );
  await assert.rejects(pullRequestWith(77, "milestone", "not-an-object"), (error: unknown) =>
    assertMilestonePathViolation(error, "pull_request.read"),
  );
});

test("getPullRequest fails closed on malformed requested reviewers, including a partially-shaped response", async () => {
  await assert.rejects(
    pullRequestWith(78, "requested_reviewers", "not-an-array"),
    (error: unknown) =>
      error instanceof GitHubApiResponseError &&
      error.code === "GITHUB_API_RESPONSE_INVALID" &&
      error.details.operation === "pull_request.read" &&
      error.details.path === "requested_reviewers",
  );
  await assert.rejects(
    pullRequestWith(79, "requested_teams", [{ name: "Team without slug" }]),
    (error: unknown) =>
      error instanceof GitHubApiResponseError &&
      error.code === "GITHUB_API_RESPONSE_INVALID" &&
      error.details.operation === "pull_request.read",
  );
  // Only one of the paired keys present is malformed, not "half absent".
  await assert.rejects(
    pullRequestWithout(80, "requested_teams"),
    (error: unknown) =>
      error instanceof GitHubApiResponseError &&
      error.code === "GITHUB_API_RESPONSE_INVALID" &&
      error.details.operation === "pull_request.read" &&
      error.details.path === "requested_teams",
  );
});

test("bounded PR mutation adapter maps canonical comment, review, and merge effects", async () => {
  const context = {
    hostname: "github.com",
    host: "github.com",
    owner: "acme",
    name: "inari",
    nameWithOwner: "acme/inari",
    url: "https://github.com/acme/inari",
    repositoryId: "100000157",
  };
  const transport = new StubFixtureTransport([
    command(0, JSON.stringify({ id: 1, body: "hello", html_url: "https://github.com/acme/inari#issuecomment-1" })),
    command(0, JSON.stringify([{ id: 1, body: "hello", html_url: "https://github.com/acme/inari#issuecomment-1" }])),
    command(0, JSON.stringify([])),
    command(
      0,
      JSON.stringify({
        id: 2,
        body: "LGTM",
        state: "APPROVED",
        commit_id: "head-sha",
        html_url: "https://github.com/acme/inari#review-2",
      }),
    ),
    command(0, JSON.stringify({ merged: true, sha: "merge-sha" })),
  ]);
  class MutationAdapter extends GitHubAdapter {
    constructor() {
      super({ repository: "acme/inari", transport: nativeTestTransport(transport) });
    }

    override async resolveRepositoryContext() {
      return context;
    }
  }
  const adapter = new MutationAdapter();

  assert.deepEqual(await adapter.createPullRequestComment(521, "hello"), {
    id: 1,
    body: "hello",
    url: "https://github.com/acme/inari#issuecomment-1",
  });
  assert.deepEqual(await adapter.listPullRequestComments(521), [
    { id: 1, body: "hello", url: "https://github.com/acme/inari#issuecomment-1" },
  ]);
  assert.deepEqual(await adapter.listPullRequestReviews(521), []);
  assert.deepEqual(await adapter.submitPullRequestReview(521, "approve", "LGTM", "head-sha"), {
    id: 2,
    body: "LGTM",
    state: "approved",
    commitId: "head-sha",
    url: "https://github.com/acme/inari#review-2",
  });
  assert.deepEqual(await adapter.mergePullRequest(521, "squash", "head-sha"), { merged: true, sha: "merge-sha" });
  assert.ok(transport.calls[0]?.args.includes("--method") && transport.calls[0]?.args.includes("POST"));
  assert.ok(transport.calls[0]?.args.includes("--raw-field") && transport.calls[0]?.args.includes("body=hello"));
  assert.ok(transport.calls[3]?.args.includes("event=APPROVE"));
  assert.ok(transport.calls[3]?.args.includes("commit_id=head-sha"));
  assert.ok(transport.calls[4]?.args.includes("--method") && transport.calls[4]?.args.includes("PUT"));
  assert.ok(transport.calls[4]?.args.includes("merge_method=squash"));
  assert.ok(transport.calls[4]?.args.includes("sha=head-sha"));
});
