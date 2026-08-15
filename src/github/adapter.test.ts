import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContractViolationError,
  DEFAULT_GH_OUTPUT_LIMITS_BYTES,
  DEFAULT_GH_TIMEOUTS_MS,
  GhNotInstalledError,
  GhTransportOutputLimitError,
  GhTransportTimeoutError,
  GhUnauthenticatedError,
  GitHubAdapter,
  GitHubApiError,
  GitHubApiResponseError,
  GitHubOutputLimitError,
  GitHubResourceKindMismatchError,
  GitHubTimeoutError,
  GitHubTransportError,
  RepositoryResolutionError,
  type GhCommandResult,
  type GhTransport,
  type GhTransportOptions,
  type ValidatedRenderedIssueArtifact,
} from "./index.js";
import { prepareIssueArtifact, preparePullRequestArtifact } from "../artifact.js";
import { issueContractFixture, pullRequestContractFixture } from "../contract/fixtures.js";
import type { CanonicalContract } from "../contract/ir.js";

interface RecordedCall {
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly maxStdoutBytes: number | undefined;
  readonly maxStderrBytes: number | undefined;
}

class StubGhTransport implements GhTransport {
  readonly calls: RecordedCall[] = [];
  private readonly responses: Array<GhCommandResult | Error>;

  constructor(responses: Array<GhCommandResult | Error>) {
    this.responses = [...responses];
  }

  async run(args: readonly string[], options?: GhTransportOptions): Promise<GhCommandResult> {
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

class MissingGhError extends Error {
  readonly code = "ENOENT";

  constructor() {
    super("gh executable not found");
    this.name = "MissingGhError";
  }
}

function command(exitCode = 0, stdout = "", stderr = ""): GhCommandResult {
  return { exitCode, stdout, stderr };
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
  });
}

function pullRequestPayloadWithDraft(number: number, draft: unknown): string {
  const payload = JSON.parse(pullRequestPayload(number)) as Record<string, unknown>;
  if (draft === undefined) delete payload.draft;
  else payload.draft = draft;
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

test("resolves the current repository deterministically and preserves the gh cwd", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    command(0, JSON.stringify({ nameWithOwner: "acme/inari", url: "https://github.com/acme/inari" })),
  ]);
  const adapter = new GitHubAdapter({ cwd: "/workspace/inari", transport });

  const context = await adapter.resolveRepositoryContext();

  assert.deepEqual(context, {
    hostname: "github.com",
    host: "github.com",
    owner: "acme",
    name: "inari",
    nameWithOwner: "acme/inari",
    url: "https://github.com/acme/inari",
  });
  assert.deepEqual(
    transport.calls.map((call) => call.args),
    [["--version"], ["auth", "status"], ["repo", "view", "--json", "nameWithOwner,url"]],
  );
  assert.ok(transport.calls.every((call) => call.cwd === "/workspace/inari"));
});

test("uses an explicit repository override without asking gh to infer local context", async () => {
  const transport = new StubGhTransport([command(0, "gh version 2.0"), command()]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

  const context = await adapter.resolveRepositoryContext();

  assert.equal(context.nameWithOwner, "acme/inari");
  assert.equal(context.hostname, "github.com");
  assert.deepEqual(
    transport.calls.map((call) => call.args),
    [["--version"], ["auth", "status", "--hostname", "github.com"]],
  );
});

test("returns a typed actionable failure when gh is unavailable", async () => {
  const transport = new StubGhTransport([new MissingGhError()]);
  const adapter = new GitHubAdapter({ transport });

  await assert.rejects(
    adapter.checkAuthentication(),
    (error: unknown) =>
      error instanceof GhNotInstalledError &&
      error.code === "GH_NOT_INSTALLED" &&
      error.category === "environment" &&
      error.message.includes("Install gh"),
  );
});

test("retries gh availability after a transient failure instead of replaying a stale rejection", async () => {
  const transport = new StubGhTransport([new MissingGhError(), command(0, "gh version 2.0"), command()]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

  await assert.rejects(adapter.checkAuthentication(), (error: unknown) => error instanceof GhNotInstalledError);

  const context = await adapter.resolveRepositoryContext();
  assert.equal(context.nameWithOwner, "acme/inari");
});

test("coalesces concurrent gh availability checks onto one in-flight call", async () => {
  const transport = new StubGhTransport([command(0, "gh version 2.0"), command()]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

  await Promise.all([adapter.resolveRepositoryContext(), adapter.resolveRepositoryContext()]);

  assert.deepEqual(
    transport.calls.map((call) => call.args[0]),
    ["--version", "auth"],
  );
});

test("retries repository context resolution after a transient failure instead of replaying a stale rejection", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    command(1, "", "Unable to resolve repository"),
    command(0, JSON.stringify({ nameWithOwner: "acme/inari", url: "https://github.com/acme/inari" })),
  ]);
  const adapter = new GitHubAdapter({ transport });

  await assert.rejects(
    adapter.resolveRepositoryContext(),
    (error: unknown) => error instanceof RepositoryResolutionError,
  );

  const context = await adapter.resolveRepositoryContext();
  assert.equal(context.nameWithOwner, "acme/inari");
});

test("returns a typed failure when gh is not authenticated", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(1, "", "You are not logged in to any GitHub hosts."),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

  await assert.rejects(
    adapter.resolveRepositoryContext(),
    (error: unknown) =>
      error instanceof GhUnauthenticatedError &&
      error.code === "GH_UNAUTHENTICATED" &&
      error.category === "authentication",
  );
});

test("returns a typed failure when the local repository cannot be resolved", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    command(1, "", "fatal: not a git repository"),
  ]);
  const adapter = new GitHubAdapter({ cwd: "/tmp", transport });

  await assert.rejects(
    adapter.resolveRepositoryContext(),
    (error: unknown) =>
      error instanceof RepositoryResolutionError &&
      error.code === "REPOSITORY_RESOLUTION_FAILED" &&
      error.category === "repository",
  );
});

test("supports MVP Issue and pull request reads and mutations through a fake transport", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    command(0, issuePayload()),
    command(0, pullRequestPayload()),
    command(0, issuePayload(44)),
    command(0, issuePayload(45)),
    command(0, issuePayload(45)),
    command(0, pullRequestPayload(46)),
    command(0, pullRequestPayload(47)),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });
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
});

test("rejects missing and non-boolean pull request draft response fields", async () => {
  for (const draft of [undefined, null, "false", 0]) {
    const transport = new StubGhTransport([
      command(0, "gh version 2.0"),
      command(),
      command(0, pullRequestPayloadWithDraft(50, draft)),
    ]);
    const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

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
    const transport = new StubGhTransport([
      command(0, "gh version 2.0"),
      command(),
      command(0, pullRequestPayloadWithDraft(number, draft)),
    ]);
    const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

    assert.equal((await adapter.getPullRequest(number)).draft, draft);
  }
});

test("rejects an unvalidated artifact before invoking any transport or mutation", async () => {
  const transport = new StubGhTransport([]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });
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
  const transport = new StubGhTransport([command(0, "gh version 2.0"), command()]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

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
  const apiFailureTransport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    command(1, "", "HTTP 500: service unavailable"),
  ]);
  const apiFailureAdapter = new GitHubAdapter({ repository: "acme/inari", transport: apiFailureTransport });
  await assert.rejects(
    apiFailureAdapter.getIssue(42),
    (error: unknown) =>
      error instanceof GitHubApiError && error.code === "GITHUB_API_FAILED" && error.category === "api",
  );

  const transportFailureTransport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    new Error("socket closed"),
  ]);
  const transportFailureAdapter = new GitHubAdapter({
    repository: "acme/inari",
    transport: transportFailureTransport,
  });
  await assert.rejects(
    transportFailureAdapter.getIssue(42),
    (error: unknown) =>
      error instanceof GitHubTransportError &&
      error.code === "GITHUB_TRANSPORT_FAILED" &&
      error.category === "transport",
  );
});

test("surfaces an output-limit transport failure with a stable machine-readable code", async () => {
  const transport = new StubGhTransport([new GhTransportOutputLimitError("stdout", 128, 129)]);
  const adapter = new GitHubAdapter({ transport });

  await assert.rejects(
    adapter.checkAuthentication(),
    (error: unknown) =>
      error instanceof GitHubOutputLimitError &&
      error.code === "GITHUB_OUTPUT_LIMIT_EXCEEDED" &&
      error.category === "transport" &&
      error.details.operation === "gh.version" &&
      error.details.stream === "stdout" &&
      error.details.limitBytes === 128 &&
      error.details.outputBytes === 129,
  );
});

test("rejects partial JSON from a zero-exit API response", async () => {
  const transport = new StubGhTransport([command(0, "gh version 2.0"), command(), command(0, '{"number":42')]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

  await assert.rejects(
    adapter.getIssue(42),
    (error: unknown) => error instanceof GitHubApiResponseError && error.code === "GITHUB_API_RESPONSE_INVALID",
  );
});

test("getIssue fails closed when GitHub returns a pull-request-shaped resource", async () => {
  const prShapedIssue = { ...JSON.parse(issuePayload(48)), pull_request: { url: "https://api.github.com/pulls/48" } };
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    command(0, JSON.stringify(prShapedIssue)),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

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
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    command(0, JSON.stringify(prShapedIssue)),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });
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

test("applies bounded, operation-class-specific timeouts to every real adapter call", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    command(0, JSON.stringify({ nameWithOwner: "acme/inari", url: "https://github.com/acme/inari" })),
    command(0, issuePayload()),
  ]);
  const adapter = new GitHubAdapter({ cwd: "/workspace/inari", transport });

  await adapter.resolveRepositoryContext();
  await adapter.getIssue(42);

  const [ghVersion, authStatus, repoView, issueRead] = transport.calls;
  assert.equal(ghVersion.timeoutMs, DEFAULT_GH_TIMEOUTS_MS.auth);
  assert.equal(authStatus.timeoutMs, DEFAULT_GH_TIMEOUTS_MS.auth);
  assert.equal(repoView.timeoutMs, DEFAULT_GH_TIMEOUTS_MS.repositoryResolution);
  assert.equal(issueRead.timeoutMs, DEFAULT_GH_TIMEOUTS_MS.read);
  assert.ok(transport.calls.every((call) => call.maxStdoutBytes === DEFAULT_GH_OUTPUT_LIMITS_BYTES.stdout));
  assert.ok(transport.calls.every((call) => call.maxStderrBytes === DEFAULT_GH_OUTPUT_LIMITS_BYTES.stderr));
});

test("honors caller-supplied timeout overrides per operation class", async () => {
  const transport = new StubGhTransport([command(0, "gh version 2.0"), command()]);
  const adapter = new GitHubAdapter({
    repository: "acme/inari",
    transport,
    timeoutsMs: { auth: 1234 },
  });

  await adapter.resolveRepositoryContext();

  assert.ok(transport.calls.every((call) => call.timeoutMs === 1234));
});

test("honors caller-supplied stdout and stderr output limits for every operation", async () => {
  const transport = new StubGhTransport([command(0, "gh version 2.0"), command()]);
  const adapter = new GitHubAdapter({
    repository: "acme/inari",
    transport,
    outputLimitsBytes: { stdout: 128, stderr: 64 },
  });

  await adapter.checkAuthentication();

  assert.ok(transport.calls.every((call) => call.maxStdoutBytes === 128));
  assert.ok(transport.calls.every((call) => call.maxStderrBytes === 64));
});

test("rejects non-positive and non-finite timeout overrides instead of silently disabling the bound", async () => {
  const transport = new StubGhTransport([]);

  for (const invalidTimeoutsMs of [
    { auth: 0 },
    { auth: -1 },
    { auth: Number.NaN },
    { auth: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(
      () => new GitHubAdapter({ transport, timeoutsMs: invalidTimeoutsMs }),
      (error: unknown) => error instanceof ContractViolationError && error.code === "CONTRACT_VIOLATION",
    );
  }
  assert.equal(transport.calls.length, 0);
});

test("rejects invalid output limit overrides instead of disabling the bound", async () => {
  const transport = new StubGhTransport([]);

  for (const outputLimitsBytes of [
    { stdout: -1 },
    { stderr: 1.5 },
    { stdout: Number.NaN },
    { stderr: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(
      () => new GitHubAdapter({ transport, outputLimitsBytes }),
      (error: unknown) => error instanceof ContractViolationError && error.code === "CONTRACT_VIOLATION",
    );
  }
  assert.equal(transport.calls.length, 0);
});

test("an explicit-undefined timeout override falls back to the default instead of disabling the bound", async () => {
  const transport = new StubGhTransport([command(0, "gh version 2.0"), command()]);
  const adapter = new GitHubAdapter({
    repository: "acme/inari",
    transport,
    timeoutsMs: { auth: undefined },
  });

  await adapter.resolveRepositoryContext();

  assert.ok(transport.calls.every((call) => call.timeoutMs === DEFAULT_GH_TIMEOUTS_MS.auth));
});

test("classifies a mutation call's bounded timeout distinctly from read timeouts", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    command(0, JSON.stringify({ nameWithOwner: "acme/inari", url: "https://github.com/acme/inari" })),
    command(0, issuePayload(44)),
  ]);
  const adapter = new GitHubAdapter({ cwd: "/workspace/inari", transport });
  const issueArtifact = prepareIssueArtifact(governedFixture(issueContractFixture), {
    fields: {
      problem: "A rendered issue",
      category: "feature",
      affected_areas: ["contracts"],
      acceptance: ["tests"],
    },
    metadata: { title: "Rendered issue" },
  }).artifact;

  await adapter.createIssue(issueArtifact);

  const mutationCall = transport.calls.at(-1);
  assert.equal(mutationCall?.timeoutMs, DEFAULT_GH_TIMEOUTS_MS.mutation);
});

test("surfaces a timed-out gh invocation as a distinct, actionable timeout error", async () => {
  const transport = new StubGhTransport([new GhTransportTimeoutError(10_000)]);
  const adapter = new GitHubAdapter({ transport });

  await assert.rejects(
    adapter.checkAuthentication(),
    (error: unknown) =>
      error instanceof GitHubTimeoutError &&
      error.code === "GITHUB_TIMEOUT" &&
      error.category === "timeout" &&
      error.details.timeoutMs === 10_000,
  );
});
