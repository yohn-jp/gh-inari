import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPERATIONAL_OBSERVATION_VERSION,
  observeOperationalIssue,
  observeOperationalPullRequest,
  tryObserveOperationalPullRequest,
} from "./operational-observation.js";
import type {
  GitHubOperationalCollection,
  GitHubOperationalCheck,
  GitHubOperationalIssueEvidence,
  GitHubOperationalPullRequestEvidence,
} from "./github/types.js";

const repository = { host: "github.com", nameWithOwner: "acme/inari", repositoryId: "100" } as const;

function collection<T>(items: readonly T[]): GitHubOperationalCollection<T> {
  return {
    status: "available",
    items,
    pagination: { perPage: 100, pages: 1, returned: items.length, truncated: false },
    diagnostics: [],
  };
}

const issueEvidence: GitHubOperationalIssueEvidence = {
  repository,
  number: 520,
  title: "wrong-template Issue",
  body: "The body is still observable.\n\n- multiline\r\n- with CRLF\tand a tab",
  state: "open",
  author: { login: "author", id: 1 },
  labels: ["zeta", "alpha"],
  assignees: [{ login: "zeta" }, { login: "alpha" }],
  url: "https://github.com/acme/inari/issues/520",
  comments: collection([]),
  provenance: { provider: "github", endpoints: ["issues/520", "issues/520/comments"] },
};

function pullRequestEvidence(
  overrides: Partial<GitHubOperationalPullRequestEvidence> = {},
): GitHubOperationalPullRequestEvidence {
  return {
    repository,
    number: 522,
    title: "runtime observation",
    body: "body",
    state: "open",
    author: { login: "author" },
    head: { ref: "feat/observation", sha: "head-sha" },
    base: { ref: "main", sha: "base-sha" },
    draft: false,
    mergeable: true,
    mergeState: "clean",
    reviewDecision: "APPROVED",
    merged: false,
    labels: [],
    assignees: [],
    url: "https://github.com/acme/inari/pull/522",
    checks: collection([]),
    requiredCheckBindings: collection([]),
    reviews: collection([]),
    comments: collection([]),
    inlineReviewComments: collection([]),
    changedFiles: collection([
      { filename: "z.ts", additions: 1 },
      { filename: "a.ts", additions: 2 },
    ]),
    provenance: { provider: "github", endpoints: ["pulls/522"] },
    ...overrides,
  };
}

test("Core Issue observation preserves ordinary provider fields independently of semantic validity", () => {
  const observed = observeOperationalIssue({ issue: issueEvidence });
  assert.equal(observed.version, OPERATIONAL_OBSERVATION_VERSION);
  assert.equal(observed.kind, "issue");
  assert.equal(observed.number, 520);
  assert.equal(observed.title, issueEvidence.title);
  assert.equal(observed.body, issueEvidence.body);
  assert.equal(observed.state, "open");
  assert.deepEqual(observed.labels, ["alpha", "zeta"]);
  assert.deepEqual(
    observed.assignees.map((actor) => actor.login),
    ["alpha", "zeta"],
  );
  assert.equal(Object.isFrozen(observed), true);
});

test("Core PR observation exposes identity and deterministic changed-file evidence", () => {
  const observed = observeOperationalPullRequest({ pullRequest: pullRequestEvidence() });
  assert.equal(observed.head.branch, "feat/observation");
  assert.equal(observed.head.sha, "head-sha");
  assert.equal(observed.base.branch, "main");
  assert.equal(observed.base.sha, "base-sha");
  assert.equal(observed.mergeability, "mergeable");
  assert.equal(observed.mergeState, "clean");
  assert.equal(observed.reviewDecision, "approved");
  assert.deepEqual(
    observed.changedFiles.items.map((file) => file.filename),
    ["a.ts", "z.ts"],
  );
  assert.deepEqual(observed.changedFilesSummary, {
    count: 2,
    additions: 3,
    deletions: "unknown",
    changes: "unknown",
    truncated: false,
  });
});

test("absent provider state remains explicit unknown", () => {
  const observed = observeOperationalPullRequest({
    pullRequest: pullRequestEvidence({
      head: {},
      base: {},
      mergeable: null,
      mergeState: null,
      reviewDecision: null,
      draft: undefined,
      merged: undefined,
    }),
  });
  assert.equal(observed.head.sha, "unknown");
  assert.equal(observed.base.branch, "unknown");
  assert.equal(observed.mergeability, "unknown");
  assert.equal(observed.mergeState, "unknown");
  assert.equal(observed.reviewDecision, "unknown");
  assert.equal(observed.draft, "unknown");
  assert.equal(observed.merged, "unknown");
  assert.equal(observed.checksSummary, "unknown");
});

test("Core derives a conservative checks summary from complete normalized checks", () => {
  const observed = observeOperationalPullRequest({
    pullRequest: pullRequestEvidence({
      checks: collection([{ id: "2", name: "build", kind: "check-run", status: "completed", conclusion: "failure" }]),
    }),
  });
  assert.equal(observed.checksSummary, "failure");
});

test("Core derives success from a mix of check-runs and legacy commit statuses", () => {
  const observed = observeOperationalPullRequest({
    pullRequest: pullRequestEvidence({
      checks: collection([
        { id: "4", name: "build", kind: "check-run", status: "completed", conclusion: "success" },
        { id: "ci/status", name: "ci/status", kind: "status", status: "success" },
      ]),
    }),
  });
  assert.equal(observed.checksSummary, "success");
});

test("Core preserves bounded check identity and current-execution evidence", () => {
  const observed = observeOperationalPullRequest({
    pullRequest: pullRequestEvidence({
      checks: collection([
        {
          id: "old",
          name: "verify",
          kind: "check-run",
          identity: { context: "verify", producer: "app:1" },
          status: "completed",
          conclusion: "failure",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:01Z",
          current: false,
        },
        {
          id: "new",
          name: "verify",
          kind: "check-run",
          identity: { context: "verify", producer: "app:1" },
          status: "completed",
          conclusion: "success",
          createdAt: "2026-01-01T00:01:00Z",
          updatedAt: "2026-01-01T00:01:01Z",
          current: true,
        },
      ]),
    }),
  });
  assert.deepEqual(observed.checks.items[1]?.identity, { context: "verify", producer: "app:1" });
  assert.equal(observed.checks.items.find((check) => check.id === "old")?.current, false);
  assert.equal(observed.checks.items.find((check) => check.id === "new")?.current, true);
  assert.equal(observed.checksSummary, "success");
});

test("Core rejects unbounded check identity fields and invalid current state", () => {
  const result = tryObserveOperationalPullRequest({
    pullRequest: pullRequestEvidence({
      checks: collection([
        {
          id: "check",
          name: "verify",
          kind: "check-run",
          identity: { context: "verify", producer: "app:1", raw: "secret" },
          status: "completed",
          conclusion: "success",
          current: "latest",
        } as unknown as GitHubOperationalCheck,
      ]),
    }),
  });
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((entry) => entry.path.endsWith("identity.raw")));
  assert.ok(result.violations.some((entry) => entry.path.endsWith("current")));
});

test("Core applies Check Run precedence over a colliding commit status", () => {
  const observed = observeOperationalPullRequest({
    pullRequest: pullRequestEvidence({
      checks: collection([
        {
          id: "run",
          name: "verify",
          kind: "check-run",
          identity: { context: "verify", producer: "app:1" },
          status: "completed",
          conclusion: "failure",
          current: true,
        },
        {
          id: "status",
          name: "verify",
          kind: "status",
          identity: { context: "verify", producer: "creator:2" },
          status: "success",
          current: true,
        },
      ]),
    }),
  });
  assert.equal(observed.checksSummary, "failure");
});

test("Core normalizes required-check producer bindings independently of observed checks", () => {
  const observed = observeOperationalPullRequest({
    pullRequest: pullRequestEvidence({
      requiredCheckBindings: collection([{ context: "verify", producer: "app:101" }, { context: "lint" }]),
    }),
  });
  assert.deepEqual(observed.requiredCheckBindings.items, [
    { context: "lint" },
    { context: "verify", producer: "app:101" },
  ]);
});

test("absent required-check policy evidence is explicitly unavailable, not an empty policy", () => {
  const observed = observeOperationalPullRequest({
    pullRequest: (() => {
      const { requiredCheckBindings: _omitted, ...rest } = pullRequestEvidence();
      return rest as unknown as GitHubOperationalPullRequestEvidence;
    })(),
  });
  assert.equal(observed.requiredCheckBindings.status, "unavailable");
});

test("Core rejects a required-check binding item that is not a record", () => {
  const result = tryObserveOperationalPullRequest({
    pullRequest: pullRequestEvidence({
      requiredCheckBindings: collection([undefined as unknown as { context: string }]),
    }),
  });
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((entry) => entry.path.endsWith("requiredCheckBindings.items[0]")));
});

test("truncated collections require an explicit continuation page", () => {
  const result = tryObserveOperationalPullRequest({
    pullRequest: pullRequestEvidence({
      comments: {
        status: "available",
        items: [],
        pagination: { perPage: 100, pages: 1, returned: 0, truncated: true },
        diagnostics: [],
      },
    }),
  });
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((entry) => entry.path.includes("comments.pagination")));
});

test("Core observation rejects unsupported normalized evidence properties", () => {
  const result = tryObserveOperationalPullRequest({
    pullRequest: { ...pullRequestEvidence(), unsupported: true },
  });
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((entry) => entry.code === "OPERATIONAL_OBSERVATION_INPUT_UNKNOWN_PROPERTY"));
});

test("Core observation accepts ordinary multiline Markdown but still rejects unsafe control characters", () => {
  const withMultilineBody = tryObserveOperationalPullRequest({
    pullRequest: pullRequestEvidence({ body: "## Notes\n\nFirst line.\r\nSecond line.\tTabbed." }),
  });
  assert.equal(withMultilineBody.valid, true);
  assert.equal(withMultilineBody.observation?.body, "## Notes\n\nFirst line.\r\nSecond line.\tTabbed.");

  const withNul = tryObserveOperationalPullRequest({
    pullRequest: pullRequestEvidence({ body: "unsafe\u0000body" }),
  });
  assert.equal(withNul.valid, false);
  assert.ok(withNul.violations.some((entry) => entry.path === "$.pullRequest.body"));
});
