import assert from "node:assert/strict";
import { test } from "node:test";
import {
  serializeSourceAcceptanceRecord,
  sourceAcceptanceCriteriaDigest,
  type SourceAcceptanceCandidate,
  type SourceAcceptanceRecord,
} from "../source-acceptance.js";
import { GitHubAdapter } from "./index.js";
import type { GitHubArtifactTransport } from "./adapter.js";
import { observeSourceAcceptanceReview } from "./source-acceptance-review.js";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const candidate: SourceAcceptanceCandidate = {
  repository: { host: "github.com", id: "100000157" },
  sourceIssue: 902,
  integrationPullRequest: { number: 43, headSha: HEAD },
  criteria: { version: 2, criteria: [{ id: "c1", text: "Works" }] },
};
const record: SourceAcceptanceRecord = {
  version: 1,
  repository: candidate.repository,
  sourceIssue: candidate.sourceIssue,
  integrationPullRequest: candidate.integrationPullRequest,
  criteria: { version: candidate.criteria.version, digest: sourceAcceptanceCriteriaDigest(candidate.criteria) },
  reviewer: { providerHost: "github.com", userId: "123" },
  results: [{ criterionId: "c1", result: "pass" }],
};
const body = serializeSourceAcceptanceRecord(record);

interface ReviewInput {
  readonly id?: number;
  readonly body?: string | null;
  readonly user?: { readonly id?: number; readonly login?: string } | null;
  readonly state?: string;
  readonly commit_id?: string;
  readonly submitted_at?: string;
}

function review(overrides: ReviewInput = {}): ReviewInput {
  return {
    id: 1,
    body,
    user: { id: 123, login: "reviewer" },
    state: "COMMENTED",
    commit_id: HEAD,
    submitted_at: "2026-09-27T00:00:00Z",
    ...overrides,
  };
}

function fixture(
  reviews: readonly ReviewInput[],
  options: {
    readonly repositoryId?: string;
    readonly head?: string;
    readonly number?: number;
    readonly failReviews?: boolean;
  } = {},
): { adapter: GitHubAdapter; calls: string[] } {
  const calls: string[] = [];
  const transport: GitHubArtifactTransport = {
    request: async ({ path, method }) => {
      assert.equal(method, "GET");
      calls.push(path);
      const local = path.replace("repos/acme/inari/", "");
      if (path === "repos/acme/inari") return { status: 200, body: { id: options.repositoryId ?? "100000157" } };
      if (local === "pulls/43")
        return {
          status: 200,
          body: {
            number: options.number ?? 43,
            title: "Source integration",
            body: "body",
            state: "open",
            html_url: "https://github.com/acme/inari/pull/43",
            head: { ref: "source", sha: options.head ?? HEAD },
            base: { ref: "main", sha: OTHER_HEAD },
            review_decision: "APPROVED",
            labels: [],
            assignees: [],
          },
        };
      if (local.startsWith("pulls/43/reviews?")) {
        if (options.failReviews) return { status: 503, body: {} };
        const page = Number(new URL(`https://example.invalid/${local}`).searchParams.get("page"));
        return { status: 200, body: reviews.slice((page - 1) * 100, page * 100) };
      }
      if (local.startsWith("commits/") && local.includes("check-runs"))
        return { status: 200, body: { check_runs: [] } };
      if (local.startsWith("commits/") && local.includes("/status")) return { status: 200, body: { statuses: [] } };
      if (local.includes("required_status_checks")) return { status: 200, body: { contexts: [], checks: [] } };
      if (local.includes("?per_page=")) return { status: 200, body: [] };
      throw new Error(`Unexpected provider path: ${path}`);
    },
  };
  return { adapter: new GitHubAdapter({ repository: "acme/inari", transport }), calls };
}

test("reads the actual adapter's complete paginated review collection and returns carrier provenance", async () => {
  const { adapter, calls } = fixture([
    ...Array.from({ length: 100 }, (_, index) => review({ id: index + 1, body: "Ordinary prose" })),
    review({ id: 101 }),
  ]);
  const result = await observeSourceAcceptanceReview(adapter, candidate);
  assert.equal(result.classification, "present");
  if (result.classification !== "present") return;
  assert.deepEqual(result.record, record);
  assert.deepEqual(result.carrier, {
    reviewId: 101,
    authorId: "123",
    commitId: HEAD,
    submittedAt: "2026-09-27T00:00:00Z",
  });
  assert.ok(calls.some((path) => path.includes("pulls/43/reviews?per_page=100&page=2")));
  assert.equal(JSON.stringify(result).includes("token"), false);
});

test("prose is absent; unavailable and truncated reviews cannot prove absence", async () => {
  assert.equal(
    (await observeSourceAcceptanceReview(fixture([review({ body: "approved" })]).adapter, candidate)).classification,
    "absent",
  );
  assert.equal(
    (await observeSourceAcceptanceReview(fixture([], { failReviews: true }).adapter, candidate)).classification,
    "unavailable",
  );
  const full = Array.from({ length: 1_000 }, (_, index) => review({ id: index + 1, body: "prose" }));
  assert.equal((await observeSourceAcceptanceReview(fixture(full).adapter, candidate)).classification, "unavailable");
});

test("malformed, noncanonical and oversized record-shaped reviews deny even beside a valid review", async () => {
  for (const malformed of ["{bad", ` ${body}`, `${body}\n`, `{${" ".repeat(16_384)}}`]) {
    const result = await observeSourceAcceptanceReview(
      fixture([review(), review({ id: 2, body: malformed })]).adapter,
      candidate,
    );
    assert.equal(result.classification, "invalid");
  }
});

test("historical Source, PR, head and criteria records are ignored", async () => {
  for (const changed of [
    { sourceIssue: 903 },
    { integrationPullRequest: { number: 44, headSha: HEAD } },
    { integrationPullRequest: { number: 43, headSha: OTHER_HEAD } },
    { criteria: { version: 1, digest: record.criteria.digest } },
  ]) {
    const old = serializeSourceAcceptanceRecord({ ...record, ...changed });
    const result = await observeSourceAcceptanceReview(fixture([review({ body: old })]).adapter, candidate);
    assert.equal(result.classification, "absent");
  }
});

test("current record requires actor, host, head commit, submitted state and timestamp", async () => {
  const cases: ReviewInput[] = [
    review({ user: { id: 124, login: "reviewer" } }),
    review({ user: { login: "reviewer" } }),
    review({ commit_id: OTHER_HEAD }),
    review({ state: "PENDING" }),
    review({ state: "DISMISSED" }),
    review({ submitted_at: undefined }),
    review({ submitted_at: "invalid" }),
    review({
      body: serializeSourceAcceptanceRecord({
        ...record,
        reviewer: { providerHost: "ghe.example.com", userId: "123" },
      }),
    }),
  ];
  for (const item of cases) {
    const result = await observeSourceAcceptanceReview(fixture([item]).adapter, candidate);
    assert.equal(result.classification, "invalid");
  }
});

test("wrong observed repository, PR or head denies, and two identical current reviews are ambiguous", async () => {
  for (const options of [{ repositoryId: "100000158" }, { number: 44 }, { head: OTHER_HEAD }]) {
    const result = await observeSourceAcceptanceReview(fixture([review()], options).adapter, candidate);
    assert.equal(result.classification, "invalid");
  }
  const result = await observeSourceAcceptanceReview(fixture([review(), review({ id: 2 })]).adapter, candidate);
  assert.equal(result.classification, "ambiguous");
});
