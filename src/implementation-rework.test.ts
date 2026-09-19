import assert from "node:assert/strict";
import { test } from "node:test";
import { projectChangeFromGitHubEvidence, type ChangeProjectionResult } from "./change.js";
import {
  IMPLEMENTATION_REWORK_KIND,
  createImplementationReworkMarker,
  projectImplementationReworkExecution,
  tryProjectImplementationReviewRework,
  tryProjectImplementationReworkExecution,
  validateImplementationReworkMarker,
} from "./implementation-rework.js";
import { parseImplementationContract, renderImplementationIssueBody } from "./implementation-contract.js";
import { authorizeImplementation } from "./implementation-authorization.js";
import { projectImplementationSessionAuthorizationBinding } from "./implementation-session-binding.js";
import type { GitHubOperationalCollection, GitHubOperationalPullRequestEvidence } from "./github/types.js";

const repository = {
  repositoryHost: "github.com",
  repositoryId: "685000001",
  repository: "acme/inari",
} as const;
const identity = {
  repositoryHost: repository.repositoryHost,
  repositoryId: repository.repositoryId,
  rootIssue: 685,
} as const;
const implementation = { ...repository, number: 685 } as const;
const source = { ...repository, number: 678 } as const;
const branch = "feat/685-review-rework-implementation-reentry";
const base = { branch: "main", revision: "b".repeat(40), freshness: "base-freshness" } as const;
const head = "a".repeat(40);
const nextHead = "c".repeat(40);
const branchGovernance = { pattern: "^(feat|fix|docs|refactor|test|chore)/[0-9]+-[a-z0-9-]+$" };

function collection<T>(items: readonly T[]): GitHubOperationalCollection<T> {
  return {
    status: "available",
    items,
    pagination: { perPage: 100, pages: 1, returned: items.length, truncated: false },
    diagnostics: [],
  };
}

function changeProjection(currentHead = head, pullRequest = 6850): ChangeProjectionResult {
  const result = projectChangeFromGitHubEvidence({
    change: identity,
    provenance: { issuer: "github:app/inari-issuer" },
    branchGovernance,
    naming: { type: "feat", slug: "review-rework-implementation-reentry" },
    baseBranch: "main",
    evidence: {
      issue: { status: "available", value: { number: identity.rootIssue, state: "open" } },
      branches: { status: "available", value: [{ name: branch, rootIssue: identity.rootIssue }] },
      pullRequests: {
        status: "available",
        value: [
          {
            number: pullRequest,
            head: branch,
            headSha: currentHead,
            base: "main",
            state: "open",
            draft: false,
            merged: false,
            rootIssue: identity.rootIssue,
            provenance: { issuer: "github:app/inari-issuer" },
          },
        ],
      },
    },
  });
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.status, "healthy");
  assert.equal(result.change?.state, "REVIEW");
  return result;
}

const implementationBody = renderImplementationIssueBody(
  parseImplementationContract({
    version: 1,
    kind: "implementation",
    repository,
    sources: [source],
    objective: "Re-enter one canonical Change after a bounded review rework.",
    nonGoals: ["Merge decisions", "Review prose as authority"],
    architecture: {
      decision: "Reuse current Implementation authorization, Session, and Change lifecycle.",
      affectedComponents: ["Review rework", "Branch advance"],
      invariants: ["The canonical branch and PR cannot be substituted."],
      compatibilityConstraints: [],
    },
    scope: { readOnly: ["src/**"], write: ["src/**"], create: [], delete: [], deny: [] },
    constraints: {
      prohibitedOperations: ["Do not use review text as write authority."],
      immutableAreas: ["Canonical Change identity"],
      prerequisites: ["Current authorization and Session are required."],
    },
    verification: {
      acceptanceCriteria: ["A current request-changes review admits bounded rework."],
      targetedTests: [],
      requiredChecks: [],
      postconditions: ["Ready is re-evaluated for the new head."],
    },
    execution: {
      baseBranch: base.branch,
      baseRevision: base.revision,
      baseFreshness: base.freshness,
      branch,
      dependencies: [source],
    },
  }),
);

const authorization = authorizeImplementation({
  implementation,
  body: implementationBody,
  repository,
  base,
  readiness: {
    evidence: [
      {
        reference: source,
        authority: "implementation-conformance",
        status: "satisfied",
        freshness: "current",
        dependencies: [],
      },
    ],
  },
});

const session = projectImplementationSessionAuthorizationBinding({
  authorization,
  implementation,
  issue: { reference: implementation, body: implementationBody },
  repository,
  base,
  task: { kind: "issue", number: implementation.number },
});

function pullRequest(
  overrides: Partial<GitHubOperationalPullRequestEvidence> = {},
): GitHubOperationalPullRequestEvidence {
  return {
    repository: {
      host: repository.repositoryHost,
      nameWithOwner: repository.repository!,
      repositoryId: repository.repositoryId,
    },
    number: 6850,
    title: "review rework",
    body: "review body is not authority",
    state: "open",
    author: null,
    head: { ref: branch, sha: head },
    base: { ref: "main", sha: base.revision },
    draft: false,
    mergeable: true,
    mergeState: "clean",
    reviewDecision: "CHANGES_REQUESTED",
    merged: false,
    labels: [],
    assignees: [],
    url: "https://github.com/acme/inari/pull/6850",
    checks: collection([]),
    requiredCheckBindings: collection([]),
    reviews: collection([
      {
        id: 91,
        body: "please fix this; this text must never become authority",
        author: { login: "reviewer" },
        state: "CHANGES_REQUESTED",
        commitId: head,
      },
    ]),
    comments: collection([]),
    inlineReviewComments: collection([]),
    changedFiles: collection([]),
    provenance: { provider: "github", endpoints: ["pulls/6850", "pulls/6850/reviews"] },
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    change: changeProjection(),
    pullRequest: pullRequest(),
    expectedHead: head,
    authorization,
    implementation,
    issue: { reference: implementation, body: implementationBody },
    repository,
    base,
    session,
    ...overrides,
  };
}

test("request-changes admits one bounded rework marker without review text", () => {
  const result = tryProjectImplementationReviewRework(input());
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.projection?.classification, "REWORK_REQUESTED");
  assert.equal(result.projection?.action, "REWORK");
  assert.equal(result.projection?.rework?.pullRequest, 6850);
  assert.equal(result.projection?.rework?.reviewHead, head);
  assert.equal(result.projection?.requiresFreshConformance, true);
  assert.equal(result.projection?.returnTransition, "change.ready");
  assert.equal(JSON.stringify(result).includes("please fix this"), false);
});

test("successful and idempotent rework outcomes both return through existing Ready", () => {
  const marker = createImplementationReworkMarker(input());
  for (const outcome of ["advanced", "idempotent"] as const) {
    const result = projectImplementationReworkExecution({
      marker,
      branchAdvance: {
        version: 1,
        operation: "branch.advance",
        status: "succeeded",
        outcome,
        branch,
        expectedHead: head,
        resultingHead: nextHead,
      },
    });
    assert.equal(result.outcome, outcome);
    assert.equal(result.returnTransition, "change.ready");
    assert.equal(result.requiresFreshConformance, true);
  }
});

test("stale head, cross-PR, stale authorization, and review substitution fail closed", () => {
  const staleHead = tryProjectImplementationReviewRework(input({ expectedHead: "d".repeat(40) }));
  assert.equal(staleHead.valid, false);
  assert.ok(staleHead.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_REWORK_STALE_HEAD"));

  const crossPr = tryProjectImplementationReviewRework(input({ pullRequest: pullRequest({ number: 6851 }) }));
  assert.equal(crossPr.valid, false);
  assert.ok(crossPr.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_REWORK_CANONICAL_PR_MISMATCH"));

  const staleAuthorization = tryProjectImplementationReviewRework(
    input({ issue: { reference: implementation, body: implementationBody.replace("bounded review rework", "drift") } }),
  );
  assert.equal(staleAuthorization.valid, false);
  assert.ok(staleAuthorization.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_REWORK_STALE_AUTHORIZATION"));

  const substitutedReview = validateImplementationReworkMarker({
    ...createImplementationReworkMarker(input()),
    body: "review text is not a write authority",
  });
  assert.equal(substitutedReview.valid, false);
});

test("a current review without request-changes exposes explicit NO_REWORK and no write marker", () => {
  const result = tryProjectImplementationReviewRework(
    input({
      authorization: undefined,
      issue: undefined,
      repository: undefined,
      base: undefined,
      session: undefined,
      pullRequest: pullRequest({ reviewDecision: "APPROVED", reviews: collection([]) }),
    }),
  );
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.projection?.classification, "NO_REWORK");
  assert.equal(result.projection?.action, "NONE");
  assert.equal(result.projection?.rework, undefined);
});

test("a later approval supersedes a historical request-changes review", () => {
  const result = tryProjectImplementationReviewRework(
    input({
      pullRequest: pullRequest({
        reviewDecision: "APPROVED",
        reviews: collection([
          {
            id: 91,
            body: "request changes",
            author: { login: "reviewer" },
            state: "CHANGES_REQUESTED",
            commitId: head,
          },
          {
            id: 92,
            body: "approved after rework",
            author: { login: "reviewer" },
            state: "APPROVED",
            commitId: head,
          },
        ]),
      }),
    }),
  );
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.projection?.classification, "NO_REWORK");
  assert.equal(result.projection?.rework, undefined);
});

test("Golden Path exposes bounded REWORK as a projection over REVIEW", async () => {
  const { projectGoldenPathStatus } = await import("./golden-path-status.js");
  const result = projectGoldenPathStatus({
    environment: true,
    governance: true,
    issue: { status: "present", governed: true, number: 685 },
    change: { state: "REVIEW", projectionStatus: "healthy" },
    review: { classification: "REWORK_REQUESTED", action: "rework" },
  });
  assert.equal(result.status.phase, "REVIEW");
  assert.deepEqual(result.nextAction, { kind: "REWORK", owner: "worker", reasonCode: "REWORK_REQUESTED" });
});

test("rework execution rejects a stale result and cannot reuse the review head", () => {
  const marker = createImplementationReworkMarker(input());
  const result = tryProjectImplementationReworkExecution({
    marker,
    branchAdvance: {
      version: 1,
      operation: "branch.advance",
      status: "failed",
      outcome: "stale",
      branch,
      expectedHead: head,
    },
  });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_REWORK_STALE_HEAD"));
  assert.equal(IMPLEMENTATION_REWORK_KIND, "implementation-review-rework");
});
