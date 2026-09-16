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
  type GitHubIssue,
  type GitHubPullRequest,
  type ValidatedRenderedIssueArtifact,
} from "./index.js";
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

/**
 * Sequential fake transport whose steps may be `"hold"`: that call's promise
 * stays pending until released, letting a test observe a caller mid-flight
 * before deciding what happens next.
 */
class DeferredGhTransport implements GhTransport {
  readonly calls: RecordedCall[] = [];
  private readonly steps: Array<GhCommandResult | Error | "hold">;
  private readonly held: Array<(result: GhCommandResult) => void> = [];

  constructor(steps: ReadonlyArray<GhCommandResult | Error | "hold">) {
    this.steps = [...steps];
  }

  async run(args: readonly string[], options?: GhTransportOptions): Promise<GhCommandResult> {
    this.calls.push({
      args: [...args],
      cwd: options?.cwd,
      timeoutMs: options?.timeoutMs,
      maxStdoutBytes: options?.maxStdoutBytes,
      maxStderrBytes: options?.maxStderrBytes,
    });
    const step = this.steps.shift();
    if (step === undefined) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    if (step === "hold") return new Promise<GhCommandResult>((resolve) => this.held.push(resolve));
    if (step instanceof Error) throw step;
    return step;
  }

  /** Queue one more response, consumed by the next call once prior steps drain. */
  pushStep(step: GhCommandResult | Error | "hold"): void {
    this.steps.push(step);
  }

  /** Resolve the oldest still-pending held call. */
  releaseNextHold(result: GhCommandResult): void {
    const resolve = this.held.shift();
    if (resolve === undefined) throw new Error("No held gh call to release.");
    resolve(result);
  }

  get heldCount(): number {
    return this.held.length;
  }
}

/** Drain pending microtasks so a caller blocked on a held gh call is observably in flight. */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

class ArtifactGhTransport implements GhTransport {
  readonly mode: "regular" | "oversized" | "missing";
  binaryStdoutRequests = 0;

  constructor(mode: "regular" | "oversized" | "missing") {
    this.mode = mode;
  }

  async run(args: readonly string[], options?: GhTransportOptions): Promise<GhCommandResult> {
    if (args[0] === "--version") return command(0, "gh version 2.0");
    if (args[0] === "auth" && args[1] === "status") return command();
    if (args.includes("--jq")) return command(0, "100000157\n");
    assert.equal(args.includes("--output"), false);
    assert.equal(options?.binaryStdout, true);
    this.binaryStdoutRequests += 1;
    if (this.mode === "missing") return command();
    const bytes = this.mode === "oversized" ? Buffer.alloc(1_048_577) : Buffer.from("artifact");
    return { exitCode: 0, stdout: "", stderr: "", stdoutBytes: new Uint8Array(bytes) };
  }
}

test("reads an Actions artifact through bounded binary stdout", async () => {
  const transport = new ArtifactGhTransport("regular");
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

  assert.deepEqual(await adapter.downloadActionsArtifact(21), new Uint8Array(Buffer.from("artifact")));
  assert.equal(transport.binaryStdoutRequests, 1);
});

test("clamps an Actions artifact download to the remaining Change budget", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    { exitCode: 0, stdout: "", stderr: "", stdoutBytes: new Uint8Array(Buffer.from("artifact")) },
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });
  const deadline = createChangeExecutionDeadline(1, () => 0);

  assert.deepEqual(await adapter.downloadActionsArtifact(21, deadline), new Uint8Array(Buffer.from("artifact")));
  assert.equal(transport.calls.at(-1)?.timeoutMs, 1);
});

test("fails closed for missing and oversized binary artifact responses", async () => {
  for (const mode of ["missing", "oversized"] as const) {
    const transport = new ArtifactGhTransport(mode);
    const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

    await assert.rejects(
      adapter.downloadActionsArtifact(21),
      (error: unknown) =>
        error instanceof GitHubApiResponseError &&
        error.code === "GITHUB_API_RESPONSE_INVALID" &&
        !error.message.includes("unexpected-path"),
    );
  }
});

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

function repositoryIdentityResponse(repository = "acme/inari", id = "100000157", host = "github.com"): GhCommandResult {
  return command(0, `${id}\n`);
}

function repositoryMetadataResponse(repository = "acme/inari", host = "github.com"): GhCommandResult {
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

function jsonCommand(value: unknown): GhCommandResult {
  return command(0, JSON.stringify(value));
}

function includedJsonCommand(value: unknown, status = 200): GhCommandResult {
  return command(0, `HTTP/2 ${status} OK\ncontent-type: application/json\n\n${JSON.stringify(value)}`);
}

function operationalPullRequestTransport(
  checkRuns: readonly Record<string, unknown>[],
  statuses: readonly Record<string, unknown>[],
  requiredStatusChecks: Record<string, unknown> = { contexts: [], checks: [] },
): StubGhTransport {
  return new StubGhTransport([
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

test("resolves the current repository deterministically and preserves the gh cwd", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryMetadataResponse(),
    repositoryIdentityResponse(),
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
    repositoryId: "100000157",
  });
  assert.deepEqual(
    transport.calls.map((call) => call.args),
    [
      ["--version"],
      ["auth", "status"],
      ["repo", "view", "--json", "nameWithOwner,url"],
      ["api", "repos/acme/inari", "--hostname", "github.com", "--method", "GET", "--jq", ".id"],
    ],
  );
  assert.ok(transport.calls.every((call) => call.cwd === "/workspace/inari"));
});

test("uses an explicit repository override without asking gh to infer local context", async () => {
  const transport = new StubGhTransport([command(0, "gh version 2.0"), command(), repositoryIdentityResponse()]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

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
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse("acme/inari", "100000157", "ghe.example.com"),
  ]);
  const adapter = new GitHubAdapter({ repository: "ghe.example.com/acme/inari", transport });

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
  const transport = new StubGhTransport([
    new MissingGhError(),
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

  await assert.rejects(adapter.checkAuthentication(), (error: unknown) => error instanceof GhNotInstalledError);

  const context = await adapter.resolveRepositoryContext();
  assert.equal(context.nameWithOwner, "acme/inari");
});

test("coalesces concurrent gh availability checks onto one in-flight call", async () => {
  const transport = new StubGhTransport([command(0, "gh version 2.0"), command(), repositoryIdentityResponse()]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

  await Promise.all([adapter.resolveRepositoryContext(), adapter.resolveRepositoryContext()]);

  assert.deepEqual(
    transport.calls.map((call) => call.args[0]),
    ["--version", "auth", "api"],
  );
});

test("a deadline-bound repository resolution does not join an unbounded in-flight resolution", async () => {
  const transport = new DeferredGhTransport([command(0, "gh version 2.0"), command(), "hold"]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

  const ordinary = adapter.resolveRepositoryContext();
  await flushMicrotasks();
  assert.equal(transport.calls.length, 3);
  assert.equal(transport.heldCount, 1);

  transport.pushStep(repositoryIdentityResponse());
  const deadline = createChangeExecutionDeadline(5, () => 0);
  const bounded = await adapter.resolveRepositoryContext(deadline);

  assert.equal(bounded.nameWithOwner, "acme/inari");
  assert.equal(transport.calls.length, 4);
  assert.deepEqual(transport.calls[3]?.args.slice(0, 2), ["api", "repos/acme/inari"]);
  assert.equal(transport.calls[3]?.timeoutMs, 5);

  transport.releaseNextHold(repositoryIdentityResponse());
  const ordinaryContext = await ordinary;
  assert.equal(ordinaryContext.nameWithOwner, "acme/inari");
});

test("a deadline-bound authentication check does not join an unbounded in-flight auth status call", async () => {
  const transport = new DeferredGhTransport([command(0, "gh version 2.0"), "hold"]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

  const ordinary = adapter.resolveRepositoryContext();
  await flushMicrotasks();
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.heldCount, 1);
  assert.deepEqual(transport.calls[1]?.args, ["auth", "status", "--hostname", "github.com"]);

  transport.pushStep(command());
  transport.pushStep(repositoryIdentityResponse());
  const deadline = createChangeExecutionDeadline(5, () => 0);
  const bounded = await adapter.resolveRepositoryContext(deadline);

  assert.equal(bounded.nameWithOwner, "acme/inari");
  assert.equal(transport.calls.length, 4);
  assert.deepEqual(transport.calls[2]?.args, ["auth", "status", "--hostname", "github.com"]);
  assert.equal(transport.calls[2]?.timeoutMs, 5);
  assert.equal(transport.calls[3]?.timeoutMs, 5);

  transport.pushStep(repositoryIdentityResponse());
  transport.releaseNextHold(command());
  const ordinaryContext = await ordinary;
  assert.equal(ordinaryContext.nameWithOwner, "acme/inari");
});

test("an ordinary caller retains its configured timeout instead of inheriting a shorter in-flight Change deadline", async () => {
  const transport = new DeferredGhTransport(["hold"]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

  const deadline = createChangeExecutionDeadline(5, () => 0);
  const bounded = adapter.resolveRepositoryContext(deadline);
  await flushMicrotasks();
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]?.timeoutMs, 5);
  assert.equal(transport.heldCount, 1);

  transport.pushStep(command(0, "gh version 2.0"));
  transport.pushStep(command());
  transport.pushStep(repositoryIdentityResponse());
  const ordinary = await adapter.resolveRepositoryContext();

  assert.equal(ordinary.nameWithOwner, "acme/inari");
  assert.equal(transport.calls.length, 4);
  assert.equal(transport.calls[1]?.timeoutMs, DEFAULT_GH_TIMEOUTS_MS.auth);

  transport.pushStep(repositoryIdentityResponse());
  transport.releaseNextHold(command(0, "gh version 2.0"));
  const boundedContext = await bounded;
  assert.equal(boundedContext.nameWithOwner, "acme/inari");
});

test("retries repository context resolution after a transient failure instead of replaying a stale rejection", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    command(1, "", "Unable to resolve repository"),
    repositoryMetadataResponse(),
    repositoryIdentityResponse(),
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

test("fails closed when repository resolution has no immutable identity", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryMetadataResponse(),
    command(0, JSON.stringify({ nameWithOwner: "acme/inari", url: "https://github.com/acme/inari" })),
  ]);
  const adapter = new GitHubAdapter({ cwd: "/workspace/inari", transport });

  await assert.rejects(
    adapter.resolveRepositoryContext(),
    (error: unknown) =>
      error instanceof RepositoryResolutionError && error.message.includes("repository database identity"),
  );
});

test("fails closed when an explicit repository override has no immutable identity", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    command(0, JSON.stringify({ nameWithOwner: "acme/inari", url: "https://github.com/acme/inari" })),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

  await assert.rejects(
    adapter.resolveRepositoryContext(),
    (error: unknown) =>
      error instanceof RepositoryResolutionError && error.message.includes("repository database identity"),
  );
});

test("supports MVP Issue and pull request reads and mutations through a fake transport", async () => {
  const transport = new StubGhTransport([
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

test("reads the repository root without adding a trailing slash", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, 'HTTP/2 200 OK\ncontent-type: application/json\n\n{"id":100000157,"default_branch":"main"}'),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

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
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

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
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

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
    const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

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
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

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
    const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

    const observed = await adapter.observePullRequest(43);
    assert.equal(observed.requiredCheckBindings.status, "unavailable");
    assert.equal(observed.requiredCheckBindings.items.length, 0);
  }
});

test("a missing required-status-check policy is explicitly unavailable, not an empty policy", async () => {
  const transport = new StubGhTransport([
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
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

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
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });
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
  const tied = await new GitHubAdapter({ repository: "acme/inari", transport: tiedTransport }).observePullRequest(43);
  assert.deepEqual(
    tied.checks.items.map((check) => check.current),
    ["unknown", "unknown"],
  );
});

test("rejects missing and non-boolean pull request draft response fields", async () => {
  for (const draft of [undefined, null, "false", 0]) {
    const transport = new StubGhTransport([
      command(0, "gh version 2.0"),
      command(),
      repositoryIdentityResponse(),
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
      repositoryIdentityResponse(),
      command(0, pullRequestPayloadWithDraft(number, draft)),
    ]);
    const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

    assert.equal((await adapter.getPullRequest(number)).draft, draft);
  }
});

test("preserves optional pull request maintainer-can-modify response metadata", async () => {
  for (const [number, value] of [
    [53, false],
    [54, true],
  ] as const) {
    const transport = new StubGhTransport([
      command(0, "gh version 2.0"),
      command(),
      repositoryIdentityResponse(),
      command(0, pullRequestPayloadWithMaintainerCanModify(number, value)),
    ]);
    const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

    assert.equal((await adapter.getPullRequest(number)).maintainerCanModify, value);
  }
});

test("rejects a non-boolean pull request maintainer-can-modify response field", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, pullRequestPayloadWithMaintainerCanModify(55, "true")),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

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
  const transport = new StubGhTransport([command(0, "gh version 2.0"), command(), repositoryIdentityResponse()]);
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
    repositoryIdentityResponse(),
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
    repositoryIdentityResponse(),
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
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, '{"number":42'),
  ]);
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
    repositoryIdentityResponse(),
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
    repositoryIdentityResponse(),
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
    repositoryMetadataResponse(),
    repositoryIdentityResponse(),
    command(0, issuePayload()),
  ]);
  const adapter = new GitHubAdapter({ cwd: "/workspace/inari", transport });

  await adapter.resolveRepositoryContext();
  const issue = await adapter.getIssue(42);
  assert.equal(issue.repositoryId, "100000157");

  const [ghVersion, authStatus, repoView, repositoryIdentity, issueRead] = transport.calls;
  assert.equal(ghVersion.timeoutMs, DEFAULT_GH_TIMEOUTS_MS.auth);
  assert.equal(authStatus.timeoutMs, DEFAULT_GH_TIMEOUTS_MS.auth);
  assert.equal(repoView.timeoutMs, DEFAULT_GH_TIMEOUTS_MS.repositoryResolution);
  assert.equal(repositoryIdentity.timeoutMs, DEFAULT_GH_TIMEOUTS_MS.repositoryResolution);
  assert.equal(issueRead.timeoutMs, DEFAULT_GH_TIMEOUTS_MS.read);
  assert.ok(transport.calls.every((call) => call.maxStdoutBytes === DEFAULT_GH_OUTPUT_LIMITS_BYTES.stdout));
  assert.ok(transport.calls.every((call) => call.maxStderrBytes === DEFAULT_GH_OUTPUT_LIMITS_BYTES.stderr));
});

test("clamps cold repository resolution, auth, and Actions I/O to one shared millisecond", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, JSON.stringify({ workflow_runs: [] })),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });
  const deadline = createChangeExecutionDeadline(1, () => 0);

  await adapter.requestActionsApi("actions/workflows/inari-change-executor.yml/runs", "GET", {}, deadline);

  assert.deepEqual(
    transport.calls.map((call) => call.timeoutMs),
    [1, 1, 1, 1],
  );
});

test("clamps a repository read to the remaining Change budget", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, 'HTTP/2 200 OK\ncontent-type: application/json\n\n{"id":100000157,"default_branch":"main"}'),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });
  const deadline = createChangeExecutionDeadline(1, () => 0);

  await adapter.requestRepositoryApi("", "GET", {}, deadline);

  assert.equal(transport.calls.at(-1)?.timeoutMs, 1);
});

test("clamps a repository mutation to the remaining Change budget", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, 'HTTP/2 200 OK\ncontent-type: application/json\n\n{"ok":true}'),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });
  const deadline = createChangeExecutionDeadline(1, () => 0);

  await adapter.requestRepositoryApi("issues/42", "PATCH", { title: "updated" }, deadline);

  assert.equal(transport.calls.at(-1)?.timeoutMs, 1);
});

test("fails before any GitHub I/O when the Change deadline is already expired", async () => {
  const transport = new StubGhTransport([]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });
  let now = 1;
  const deadline = createChangeExecutionDeadline(1, () => now);
  now = 2;

  await assert.rejects(
    adapter.requestActionsApi("actions/workflows/inari-change-executor.yml/runs", "GET", {}, deadline),
    (error: unknown) => error instanceof GitHubTimeoutError && error.details.timeoutMs === 0,
  );
  assert.equal(transport.calls.length, 0);
});

test("keeps a shorter custom operation timeout below the Change budget", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, 'HTTP/2 200 OK\ncontent-type: application/json\n\n{"id":100000157,"default_branch":"main"}'),
  ]);
  const adapter = new GitHubAdapter({
    repository: "acme/inari",
    transport,
    timeoutsMs: { read: 7 },
  });
  const deadline = createChangeExecutionDeadline(100, () => 0);

  await adapter.requestRepositoryApi("", "GET", {}, deadline);

  assert.equal(transport.calls.at(-1)?.timeoutMs, 7);
});

test("preserves the configured operation-class timeout when no Change deadline is supplied", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, JSON.stringify({ workflow_runs: [] })),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

  await adapter.requestActionsApi("actions/workflows/inari-change-executor.yml/runs", "GET");

  assert.equal(transport.calls.at(-1)?.timeoutMs, DEFAULT_GH_TIMEOUTS_MS.mutation);
});

test("honors caller-supplied timeout overrides per operation class", async () => {
  const transport = new StubGhTransport([command(0, "gh version 2.0"), command(), repositoryIdentityResponse()]);
  const adapter = new GitHubAdapter({
    repository: "acme/inari",
    transport,
    timeoutsMs: { auth: 1234 },
  });

  await adapter.resolveRepositoryContext();

  assert.equal(transport.calls[0]?.timeoutMs, 1234);
  assert.equal(transport.calls[1]?.timeoutMs, 1234);
  assert.equal(transport.calls[2]?.timeoutMs, DEFAULT_GH_TIMEOUTS_MS.repositoryResolution);
});

test("honors caller-supplied stdout and stderr output limits for every operation", async () => {
  const transport = new StubGhTransport([command(0, "gh version 2.0"), command(), repositoryIdentityResponse()]);
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
  const transport = new StubGhTransport([command(0, "gh version 2.0"), command(), repositoryIdentityResponse()]);
  const adapter = new GitHubAdapter({
    repository: "acme/inari",
    transport,
    timeoutsMs: { auth: undefined },
  });

  await adapter.resolveRepositoryContext();

  assert.equal(transport.calls[0]?.timeoutMs, DEFAULT_GH_TIMEOUTS_MS.auth);
  assert.equal(transport.calls[1]?.timeoutMs, DEFAULT_GH_TIMEOUTS_MS.auth);
  assert.equal(transport.calls[2]?.timeoutMs, DEFAULT_GH_TIMEOUTS_MS.repositoryResolution);
});

test("classifies a mutation call's bounded timeout distinctly from read timeouts", async () => {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryMetadataResponse(),
    repositoryIdentityResponse(),
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

function blobPayload(sha: string, contentBase64: string): string {
  return JSON.stringify({ sha, encoding: "base64", content: contentBase64 });
}

test("decodes a governed repository blob with exact valid multibyte UTF-8 text", async () => {
  const sha = "a".repeat(40);
  const text = "こんにちは 😀";
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, blobPayload(sha, Buffer.from(text, "utf8").toString("base64"))),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

  const decoded = await adapter.getRepositoryBlob(sha);

  assert.equal(decoded, text);
});

test("rejects a governed repository blob containing invalid UTF-8 byte sequences instead of lossily decoding it", async () => {
  const sha = "a".repeat(40);
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, blobPayload(sha, invalidUtf8.toString("base64"))),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

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
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, blobPayload(sha, truncatedMultibyte.toString("base64"))),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

  await assert.rejects(
    adapter.getRepositoryBlob(sha),
    (error: unknown) => error instanceof GitHubApiResponseError && error.code === "GITHUB_API_RESPONSE_INVALID",
  );
});

async function issueWith(number: number, field: string, value: unknown): Promise<GitHubIssue> {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, withField(issuePayload(number), field, value)),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });
  return adapter.getIssue(number);
}

async function issueWithout(number: number, ...fields: readonly string[]): Promise<GitHubIssue> {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, withoutFields(issuePayload(number), ...fields)),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });
  return adapter.getIssue(number);
}

async function pullRequestWith(number: number, field: string, value: unknown): Promise<GitHubPullRequest> {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, withField(pullRequestPayload(number), field, value)),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });
  return adapter.getPullRequest(number);
}

async function pullRequestWithout(number: number, ...fields: readonly string[]): Promise<GitHubPullRequest> {
  const transport = new StubGhTransport([
    command(0, "gh version 2.0"),
    command(),
    repositoryIdentityResponse(),
    command(0, withoutFields(pullRequestPayload(number), ...fields)),
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });
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
    const transport = new StubGhTransport([
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
    const adapter = new GitHubAdapter({ repository: "acme/inari", transport });
    return adapter.getPullRequest(70);
  })();

  assert.deepEqual(pullRequest.labels, ["bug"]);
  assert.deepEqual(pullRequest.assignees, ["octocat"]);
  assert.deepEqual(pullRequest.milestone, { number: 3, title: "v2" });
});

test("getPullRequest reports distinct user and team requested reviewers without conflating them", async () => {
  const transport = new StubGhTransport([
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
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

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
  const transport = new StubGhTransport([
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
      super({ repository: "acme/inari", transport });
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
