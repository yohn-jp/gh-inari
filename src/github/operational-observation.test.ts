import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitHubAdapter,
  GitHubResourceKindMismatchError,
  type GhCommandResult,
  type GhTransport,
  type GhTransportOptions,
} from "./index.js";

function command(stdout = "", exitCode = 0): GhCommandResult {
  return { stdout, exitCode, stderr: "" };
}

function included(body: unknown, link?: string): GhCommandResult {
  return command(`HTTP/1.1 200 OK\n${link === undefined ? "" : `Link: ${link}\n`}\n${JSON.stringify(body)}`);
}

class OperationalTransport implements GhTransport {
  private readonly history: string[][] = [];

  async run(args: readonly string[], _options?: GhTransportOptions): Promise<GhCommandResult> {
    this.history.push([...args]);
    if (args[0] === "--version") return command("gh version 2.0");
    if (args[0] === "auth") return command();
    if (args.includes("--jq")) return command("100\n");
    if (args[0] === "api" && args[1] === "graphql")
      return command(
        JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: "CHANGES_REQUESTED" } } } }),
      );
    const endpoint = args[1] ?? "";
    const path = endpoint.replace("repos/acme/inari/", "");
    if (!args.includes("--include")) {
      if (path === "issues/7")
        return command(
          JSON.stringify({
            number: 7,
            title: "Wrong template",
            body: "Provider body remains readable.\n\n- line one\r\n- line two\ttabbed",
            state: "open",
            state_reason: null,
            html_url: "https://github.com/acme/inari/issues/7",
            user: { login: "octocat", id: 1 },
            labels: [{ name: "enhancement" }],
            assignees: [{ login: "octocat" }],
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
          }),
        );
      if (path === "issues/9")
        return command(
          JSON.stringify({
            number: 9,
            title: "Truncated Issue",
            body: "body",
            state: "open",
            html_url: "https://github.com/acme/inari/issues/9",
            user: { login: "octocat" },
          }),
        );
      if (path === "issues/11")
        return command(
          JSON.stringify({
            number: 11,
            title: "Actually a pull request",
            body: "body",
            state: "open",
            html_url: "https://github.com/acme/inari/issues/11",
            user: { login: "octocat" },
            pull_request: { url: "https://api.github.com/repos/acme/inari/pulls/11" },
          }),
        );
      if (path === "pulls/8")
        return command(
          JSON.stringify({
            number: 8,
            title: "Operational PR",
            body: "## Summary\n\nMultiline PR body.\r\n\r\n- item",
            state: "open",
            html_url: "https://github.com/acme/inari/pull/8",
            user: { login: "octocat" },
            head: { ref: "feat/observation", sha: "head-sha" },
            base: { ref: "main", sha: "base-sha" },
            draft: false,
            mergeable: null,
            mergeable_state: "unknown",
            review_decision: "APPROVED",
            merged: false,
            merge_commit_sha: null,
            labels: [],
            assignees: [],
            requested_reviewers: [{ login: "reviewer" }],
            requested_teams: [{ slug: "platform" }],
          }),
        );
      if (path === "pulls/10")
        return command(
          JSON.stringify({
            number: 10,
            title: "Review decision fallback",
            body: "body",
            state: "open",
            html_url: "https://github.com/acme/inari/pull/10",
            user: { login: "octocat" },
            head: { ref: "feat/fallback", sha: "head-sha-10" },
            base: { ref: "main", sha: "base-sha" },
            mergeable: null,
            mergeable_state: "unknown",
            merged: false,
          }),
        );
      throw new Error(`Unexpected non-paginated endpoint: ${endpoint}`);
    }
    const url = new URL(`https://github.invalid/${path}`);
    const page = Number(url.searchParams.get("page") ?? "1");
    if (path.startsWith("issues/7/comments")) {
      const entries =
        page === 1
          ? Array.from({ length: 100 }, (_unused, index) => ({
              id: index + 1,
              body: `comment-${index}`,
              user: { login: "octocat" },
            }))
          : [{ id: 101, body: "last", user: { login: "octocat" } }];
      return included(entries, page === 1 ? '<https://api.github.invalid?page=2>; rel="next"' : undefined);
    }
    if (path.startsWith("issues/9/comments"))
      return included(
        Array.from({ length: 100 }, (_unused, index) => ({
          id: page * 100 + index,
          body: `comment-${page}-${index}`,
          user: { login: "octocat" },
        })),
        `<https://api.github.invalid?page=${page + 1}>; rel="next"`,
      );
    if (path.startsWith("pulls/8/comments"))
      return included([
        {
          id: 2,
          body: "inline\nfeedback\r\nhere",
          user: { login: "reviewer" },
          path: "src/a.ts",
          line: 4,
          side: "RIGHT",
        },
      ]);
    if (path.startsWith("pulls/10/") || path.startsWith("issues/10/") || path.startsWith("commits/head-sha-10/"))
      return included([]);
    if (path.startsWith("pulls/8/reviews"))
      return included([
        {
          id: 3,
          body: "Approved.\n\nLooks good\toverall.",
          user: { login: "reviewer" },
          state: "APPROVED",
          submitted_at: "2026-01-03T00:00:00Z",
        },
      ]);
    if (path.startsWith("pulls/8/files"))
      return included([
        { filename: "z.ts", status: "modified", additions: 2, deletions: 1 },
        { filename: "a.ts", status: "added", additions: 4, deletions: 0 },
      ]);
    if (path.startsWith("commits/head-sha/check-runs"))
      return included({
        total_count: 1,
        check_runs: [{ id: 4, name: "build", status: "completed", conclusion: "success" }],
      });
    if (path.startsWith("commits/head-sha/status"))
      return included({
        state: "success",
        total_count: 1,
        statuses: [{ context: "ci/status", state: "success", description: "ok" }],
      });
    throw new Error(`Unexpected paginated endpoint: ${endpoint}`);
  }

  get calls(): readonly string[][] {
    return this.history;
  }
}

test("GitHub adapter preserves bounded Issue comments pagination and provenance", async () => {
  const transport = new OperationalTransport();
  const observed = await new GitHubAdapter({ repository: "acme/inari", transport }).observeIssue(7);
  assert.equal(observed.body, "Provider body remains readable.\n\n- line one\r\n- line two\ttabbed");
  assert.equal(observed.comments.status, "available");
  assert.equal(observed.comments.items.length, 101);
  assert.equal(observed.comments.pagination.pages, 2);
  assert.equal(observed.comments.pagination.truncated, false);
  assert.ok(observed.provenance.endpoints.includes("issues/7/comments"));
});

test("GitHub adapter makes the bounded collection truncation continuation explicit", async () => {
  const transport = new OperationalTransport();
  const observed = await new GitHubAdapter({ repository: "acme/inari", transport }).observeIssue(9);
  assert.equal(observed.comments.status, "available");
  assert.equal(observed.comments.pagination.pages, 10);
  assert.equal(observed.comments.pagination.returned, 1_000);
  assert.equal(observed.comments.pagination.truncated, true);
  assert.equal(observed.comments.pagination.nextPage, 11);
  assert.equal(observed.comments.diagnostics[0]?.code, "OPERATIONAL_COLLECTION_TRUNCATED");
  assert.equal(transport.calls.filter((args) => args[1]?.includes("issues/9/comments") === true).length, 10);
});

test("GitHub adapter observeIssue fails closed when the resource is PR-shaped", async () => {
  const transport = new OperationalTransport();
  await assert.rejects(
    new GitHubAdapter({ repository: "acme/inari", transport }).observeIssue(11),
    (error: unknown) =>
      error instanceof GitHubResourceKindMismatchError &&
      error.code === "GITHUB_RESOURCE_KIND_MISMATCH" &&
      error.category === "api",
  );
});

test("GitHub adapter normalizes PR runtime evidence without raw API shapes", async () => {
  const transport = new OperationalTransport();
  const observed = await new GitHubAdapter({ repository: "acme/inari", transport }).observePullRequest(8);
  assert.deepEqual(observed.head, { ref: "feat/observation", sha: "head-sha" });
  assert.deepEqual(observed.base, { ref: "main", sha: "base-sha" });
  assert.equal(observed.reviewDecision, "APPROVED");
  assert.equal(observed.body, "## Summary\n\nMultiline PR body.\r\n\r\n- item");
  assert.equal(observed.checks.status, "available");
  assert.equal(observed.checks.items.length, 2);
  assert.deepEqual(
    observed.checks.items.map((check) => ({ kind: check.kind, id: check.id })).sort((left, right) => left.id.localeCompare(right.id)),
    [
      { kind: "check-run", id: "4" },
      { kind: "status", id: "ci/status" },
    ],
  );
  assert.deepEqual(
    observed.changedFiles.items.map((file) => file.filename),
    ["a.ts", "z.ts"],
  );
  assert.equal(observed.inlineReviewComments.items[0]?.path, "src/a.ts");
  assert.equal(observed.inlineReviewComments.items[0]?.body, "inline\nfeedback\r\nhere");
  assert.equal(observed.reviews.items[0]?.body, "Approved.\n\nLooks good\toverall.");
  assert.ok(observed.provenance.endpoints.includes("pulls/8/reviews"));
});

test("GitHub adapter uses the fixed aggregate review decision read when REST omits it", async () => {
  const transport = new OperationalTransport();
  const observed = await new GitHubAdapter({ repository: "acme/inari", transport }).observePullRequest(10);
  assert.equal(observed.reviewDecision, "CHANGES_REQUESTED");
  assert.ok(observed.provenance.endpoints.includes("graphql:pullRequest.reviewDecision"));
  assert.ok(transport.calls.some((args) => args[1] === "graphql"));
});
