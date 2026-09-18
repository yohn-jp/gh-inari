import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubAdapter, GitHubApiError, GitHubApiResponseError, type GitHubArtifactTransport } from "./index.js";

function issue(number: number): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    body: "bounded body",
    html_url: `https://github.com/acme/inari/issues/${number}`,
    user: { login: "octocat", id: 1 },
    labels: [{ name: "discovery" }],
    assignees: [],
  };
}

function pullRequest(number: number): Record<string, unknown> {
  return {
    number,
    title: `PR ${number}`,
    state: "open",
    body: "bounded body",
    html_url: `https://github.com/acme/inari/pull/${number}`,
    user: { login: "octocat", id: 1 },
    head: { ref: "feat/discovery", sha: "head-sha" },
    base: { ref: "main", sha: "base-sha" },
    draft: false,
    merged: false,
    labels: [],
    assignees: [],
  };
}

class DiscoveryTransport implements GitHubArtifactTransport {
  readonly requests: string[] = [];
  readonly responses: readonly (readonly Record<string, unknown>[])[];

  constructor(responses: readonly (readonly Record<string, unknown>[])[]) {
    this.responses = responses;
  }

  async request(request: { readonly path: string }): Promise<{
    readonly status: number;
    readonly body: unknown;
    readonly headers?: Readonly<Record<string, string>>;
  }> {
    this.requests.push(request.path);
    if (request.path === "user") return { status: 200, body: { login: "octocat" } };
    if (request.path === "repos/acme/inari") return { status: 200, body: { id: 100 } };
    if (request.path.startsWith("repos/acme/inari/issues?"))
      return {
        status: 200,
        body: this.responses[0],
        headers: { link: '<https://api.github.com/?page=2>; rel="next"' },
      };
    if (request.path.startsWith("repos/acme/inari/pulls?")) return { status: 200, body: this.responses[1] };
    throw new Error(`Unexpected native endpoint: ${request.path}`);
  }
}

class DiscoveryFailureTransport implements GitHubArtifactTransport {
  constructor(private readonly discoveryResponse: { readonly status: number; readonly body: unknown }) {}

  async request(request: { readonly path: string }): Promise<{
    readonly status: number;
    readonly body: unknown;
  }> {
    if (request.path === "user") return { status: 200, body: { login: "octocat" } };
    if (request.path === "repos/acme/inari") return { status: 200, body: { id: 100 } };
    if (request.path.startsWith("repos/acme/inari/issues?")) return this.discoveryResponse;
    throw new Error(`Unexpected native endpoint: ${request.path}`);
  }
}

test("adapter lists Issues and PRs through native HTTP with explicit bounded filters", async () => {
  const transport = new DiscoveryTransport([
    [issue(9), { ...issue(8), pull_request: { url: "https://api.github.com/repos/acme/inari/pulls/8" } }],
    [pullRequest(7)],
  ]);
  const adapter = new GitHubAdapter({ repository: "acme/inari", transport });

  const issues = await adapter.listOperationalIssues({ state: "closed", page: 1, limit: 2 });
  const pullRequests = await adapter.listOperationalPullRequests({
    state: "all",
    head: "feat/discovery",
    base: "main",
    page: 1,
    limit: 20,
  });

  assert.deepEqual(
    issues.items.map((item) => item.number),
    [9],
  );
  assert.deepEqual(issues.pagination, { page: 1, limit: 2, returned: 1, truncated: true, nextPage: 2 });
  const issueRequest = transport.requests.find((request) => request.startsWith("repos/acme/inari/issues?"));
  assert.ok(issueRequest);
  const issueQuery = new URLSearchParams(issueRequest.slice(issueRequest.indexOf("?") + 1));
  assert.equal(issueQuery.get("state"), "closed");
  assert.equal(issueQuery.get("per_page"), "2");
  assert.equal(issueQuery.get("page"), "1");
  const pullRequestRequest = transport.requests.find((request) => request.startsWith("repos/acme/inari/pulls?"));
  assert.ok(pullRequestRequest);
  const pullRequestQuery = new URLSearchParams(pullRequestRequest.slice(pullRequestRequest.indexOf("?") + 1));
  assert.equal(pullRequestQuery.get("head"), "acme:feat/discovery");
  assert.equal(pullRequestQuery.get("base"), "main");
  assert.equal(pullRequestQuery.get("state"), "all");
  assert.deepEqual(
    pullRequests.items.map((item) => item.number),
    [7],
  );
});

test("adapter rejects an oversized provider page before projecting summaries", async () => {
  const adapter = new GitHubAdapter({
    repository: "acme/inari",
    transport: new DiscoveryFailureTransport({ status: 200, body: [issue(1), issue(2)] }),
  });

  await assert.rejects(
    adapter.listOperationalIssues({ limit: 1 }),
    (error: unknown) =>
      error instanceof GitHubApiResponseError &&
      error.code === "GITHUB_API_RESPONSE_INVALID" &&
      error.details.operation === "issue.list" &&
      error.details.path === "body",
  );
});

test("adapter fails closed on provider errors without exposing response content", async () => {
  const secret = "Authorization: Bearer provider-secret";
  const adapter = new GitHubAdapter({
    repository: "acme/inari",
    transport: new DiscoveryFailureTransport({ status: 500, body: { message: secret } }),
  });

  await assert.rejects(
    adapter.listOperationalIssues(),
    (error: unknown) =>
      error instanceof GitHubApiError &&
      error.code === "GITHUB_API_FAILED" &&
      error.details.operation === "issue.list" &&
      !error.message.includes(secret) &&
      !JSON.stringify(error).includes(secret),
  );
});
