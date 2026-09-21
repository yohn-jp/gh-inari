import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEndpointAuthoritativeSnapshot, createEndpointObservation } from "./endpoint-reconciliation.js";
import {
  ENDPOINT_WORK_PROJECTION_VERSION,
  tryProjectEndpointWork,
  type EndpointWorkProjectionInput,
} from "./endpoint-work-projection.js";
import { projectChangeFromGitHubEvidence } from "./change.js";
import type { OperationalPullRequestObservation } from "./operational-observation.js";
import type { ObservedPullRequestProjection } from "./semantic-pr-observation.js";

const repository = {
  repositoryHost: "github.com",
  repositoryId: "1330755860",
  repository: "yohn-jp/gh-inari",
} as const;
const reference = { ...repository, number: 920 } as const;

const frontier = {
  version: 1,
  kind: "implementation-frontier",
  valid: true,
  candidates: [
    {
      reference,
      classification: "READY",
      dependencies: [],
      satisfiedDependencies: [],
      unsatisfiedDependencies: [],
      diagnostics: [],
    },
  ],
  ready: [reference],
  parallelReadyGroups: [{ items: [reference] }],
  diagnostics: [],
} as const;

function freshness() {
  return applyEndpointAuthoritativeSnapshot(
    createEndpointObservation({ key: "github.com/1330755860" }),
    { value: { repository }, revision: "42", observedAt: "2026-09-20T00:00:00.000Z" },
    { now: "2026-09-22T00:00:00.000Z", maxAgeMs: 1_000 },
  );
}

function change() {
  const result = projectChangeFromGitHubEvidence({
    change: {
      repositoryHost: repository.repositoryHost,
      repositoryId: repository.repositoryId,
      rootIssue: reference.number,
    },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "endpoint-work-projection" },
    baseBranch: "main",
    evidence: {
      issue: { status: "available", value: { number: reference.number, state: "open" } },
      branches: { status: "available", value: [{ name: "feat/920-endpoint-work-projection" }] },
      pullRequests: {
        status: "available",
        value: [
          {
            number: 142,
            head: "feat/920-endpoint-work-projection",
            base: "main",
            state: "open",
            draft: false,
            merged: false,
          },
        ],
      },
    },
  });
  assert.equal(result.valid, true);
  return result;
}

function operationalPullRequest(): OperationalPullRequestObservation {
  return {
    version: 1,
    kind: "pull_request",
    repository: {
      host: repository.repositoryHost,
      nameWithOwner: repository.repository,
      repositoryId: repository.repositoryId,
    },
    number: 142,
    title: "Endpoint work projection",
    body: null,
    state: "open",
    author: null,
    head: { branch: "feat/920-endpoint-work-projection", sha: "unknown" },
    base: { branch: "main", sha: "unknown" },
    draft: false,
    mergeability: "mergeable",
    mergeState: "clean",
    reviewDecision: "approved",
    merged: false,
    labels: [],
    assignees: [],
    timestamps: {},
    url: "https://github.com/yohn-jp/gh-inari/pull/142",
    checks: {
      status: "available",
      items: [],
      pagination: { perPage: 100, pages: 1, returned: 0, truncated: false },
      diagnostics: [],
    },
    checksSummary: "success",
    requiredCheckBindings: {
      status: "available",
      items: [],
      pagination: { perPage: 100, pages: 1, returned: 0, truncated: false },
      diagnostics: [],
    },
    reviews: {
      status: "available",
      items: [],
      pagination: { perPage: 100, pages: 1, returned: 0, truncated: false },
      diagnostics: [],
    },
    comments: {
      status: "available",
      items: [],
      pagination: { perPage: 100, pages: 1, returned: 0, truncated: false },
      diagnostics: [],
    },
    inlineReviewComments: {
      status: "available",
      items: [],
      pagination: { perPage: 100, pages: 1, returned: 0, truncated: false },
      diagnostics: [],
    },
    changedFiles: {
      status: "available",
      items: [],
      pagination: { perPage: 100, pages: 1, returned: 0, truncated: false },
      diagnostics: [],
    },
    changedFilesSummary: { count: 0, additions: 0, deletions: 0, changes: 0, truncated: false },
    provenance: { provider: "github", endpoints: ["pull-request"] },
  };
}

test("composes existing frontier, Change, semantic PR, operational PR, and freshness authorities", () => {
  const semanticPullRequest = {
    version: "1",
    kind: "pull_request",
    number: 142,
    title: "Endpoint work projection",
    head: "feat/920-endpoint-work-projection",
    base: "main",
    body: "",
    metadata: {},
    relations: {
      implements: {
        relation: "implements",
        references: [reference],
        representation: "native",
        evidence: { recognizedConvention: [], bodyFallback: [] },
      },
    },
  } as unknown as ObservedPullRequestProjection;
  const input: EndpointWorkProjectionInput = {
    repository,
    freshness: freshness(),
    frontier,
    semanticPullRequests: [semanticPullRequest],
    operationalPullRequests: [operationalPullRequest()],
    changes: [change()],
  };
  const result = tryProjectEndpointWork(input);
  assert.equal(result.valid, true);
  assert.equal(result.projection?.version, ENDPOINT_WORK_PROJECTION_VERSION);
  assert.equal(result.projection?.freshness.state, "stale");
  assert.equal(result.projection?.work.status, "present");
  assert.equal(result.projection?.work.items[0]?.readiness, frontier.candidates[0]);
  assert.equal(result.projection?.work.items[0]?.operationalPullRequest?.number, 142);
  assert.equal(result.projection?.work.items[0]?.operationalPullRequest?.checksSummary, "success");
  assert.equal(result.projection?.work.items[0]?.evidence.change.status, "present");
});

test("keeps missing and empty evidence distinct from unavailable and conflicting evidence", () => {
  const missing = tryProjectEndpointWork({ repository, freshness: freshness(), frontier });
  assert.equal(missing.valid, true);
  assert.equal(missing.projection?.evidence.operationalPullRequests.status, "missing");
  assert.equal(missing.projection?.work.items[0]?.evidence.operationalPullRequest.status, "missing");

  const empty = tryProjectEndpointWork({ repository, freshness: freshness(), frontier, operationalPullRequests: [] });
  assert.equal(empty.valid, true);
  assert.equal(empty.projection?.evidence.operationalPullRequests.status, "empty");
  assert.equal(empty.projection?.work.items[0]?.evidence.operationalPullRequest.status, "empty");

  const unavailable = tryProjectEndpointWork({
    repository,
    freshness: freshness(),
    frontier,
    operationalPullRequests: { status: "unavailable", items: [] },
  });
  assert.equal(unavailable.valid, true);
  assert.equal(unavailable.projection?.evidence.operationalPullRequests.status, "unavailable");
  assert.equal(unavailable.projection?.work.items[0]?.evidence.operationalPullRequest.status, "unavailable");

  const conflicting = tryProjectEndpointWork({
    repository,
    freshness: freshness(),
    frontier,
    operationalPullRequests: [operationalPullRequest(), { ...operationalPullRequest(), title: "duplicate" }],
  });
  assert.equal(conflicting.valid, false);
  assert.equal(conflicting.projection?.work.items[0]?.evidence.operationalPullRequest.status, "conflicting");
});

test("fails closed on a cross-repository frontier candidate", () => {
  const result = tryProjectEndpointWork({
    repository,
    freshness: freshness(),
    frontier: {
      ...frontier,
      candidates: [{ ...frontier.candidates[0], reference: { ...reference, repositoryId: "999999999" } }],
      ready: [],
    },
  });
  assert.equal(result.valid, false);
  assert.equal(
    result.projection?.diagnostics.some((entry) => entry.code === "ENDPOINT_WORK_PROJECTION_REPOSITORY_CONFLICT"),
    true,
  );
});
