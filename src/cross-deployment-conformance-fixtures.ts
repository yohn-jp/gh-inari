import type { ChangeGitHubEvidence } from "./change.js";
import {
  CROSS_DEPLOYMENT_CONFORMANCE_VERSION,
  type CrossDeploymentAuthoritySnapshot,
  type CrossDeploymentFixture,
  type CrossDeploymentProjectionSummary,
} from "./cross-deployment-conformance.js";

const ISSUE = 553;
const REPOSITORY_ID = "553000001";
const BRANCH = "feat/553-cross-deployment-conformance";
const PULL_REQUEST = 5530;
const BASE = {
  repositoryHost: "github.com",
  repositoryId: REPOSITORY_ID,
  rootIssue: ISSUE,
} as const;
const NAMING = { type: "feat", slug: "cross-deployment-conformance" } as const;
const BRANCH_GOVERNANCE = { pattern: "^feat/[0-9]+-[a-z0-9-]+$" } as const;

const ABSENT_EVIDENCE: ChangeGitHubEvidence = {
  issue: { status: "available", value: { number: ISSUE, state: "open" } },
  branches: { status: "absent" },
  pullRequests: { status: "absent" },
};

const DRAFT_EVIDENCE: ChangeGitHubEvidence = {
  issue: { status: "available", value: { number: ISSUE, state: "open" } },
  branches: {
    status: "available",
    value: [{ name: BRANCH, sha: "b".repeat(40), rootIssue: ISSUE }],
  },
  pullRequests: {
    status: "available",
    value: [
      {
        number: PULL_REQUEST,
        head: BRANCH,
        base: "main",
        state: "open",
        draft: true,
        merged: false,
        rootIssue: ISSUE,
      },
    ],
  },
};

const RECOVERY_EVIDENCE: ChangeGitHubEvidence = {
  issue: { status: "available", value: { number: ISSUE, state: "open" } },
  branches: {
    status: "available",
    value: [{ name: BRANCH, sha: "b".repeat(40), rootIssue: ISSUE }],
  },
  pullRequests: {
    status: "available",
    value: [
      {
        number: PULL_REQUEST,
        head: BRANCH,
        base: "main",
        state: "closed",
        draft: false,
        merged: false,
        rootIssue: ISSUE,
      },
    ],
  },
};

function snapshot(generation: string, evidence: ChangeGitHubEvidence): CrossDeploymentAuthoritySnapshot {
  return Object.freeze({
    generation,
    identity: BASE,
    branchGovernance: BRANCH_GOVERNANCE,
    naming: NAMING,
    baseBranch: "main",
    evidence,
  });
}

function projection(state: "defined" | "draft" | "recovery"): CrossDeploymentProjectionSummary {
  if (state === "defined") {
    return {
      valid: true,
      status: "absent",
      canonicalBranch: BRANCH,
      canonicalBaseBranch: "main",
      change: { identity: BASE, state: "DEFINED" },
      diagnostics: [],
    };
  }
  if (state === "draft") {
    return {
      valid: true,
      status: "healthy",
      canonicalBranch: BRANCH,
      canonicalBaseBranch: "main",
      change: {
        identity: BASE,
        state: "DRAFT",
        projection: { branch: BRANCH, pullRequest: PULL_REQUEST },
      },
      diagnostics: [],
    };
  }
  return {
    valid: false,
    status: "partial",
    canonicalBranch: BRANCH,
    canonicalBaseBranch: "main",
    change: {
      identity: BASE,
      state: "RECOVERY_REQUIRED",
      projection: { branch: BRANCH, pullRequest: PULL_REQUEST },
    },
    diagnostics: [
      {
        code: "CHANGE_PROJECTION_PARTIAL",
        path: "$.evidence",
        message: "Canonical branch and pull request evidence do not form a complete Change projection.",
      },
    ],
  };
}

const VERIFIED_EFFECTS = [
  { kind: "CREATE_BRANCH" as const, status: "succeeded" as const },
  { kind: "CREATE_PROVENANCE_COMMIT" as const, status: "succeeded" as const },
  { kind: "CREATE_PULL_REQUEST" as const, status: "succeeded" as const },
];

const DRAFT_PLAN = {
  operation: "issue" as const,
  effects: VERIFIED_EFFECTS,
  postcondition: { status: "healthy" as const, state: "DRAFT", branch: BRANCH, pullRequest: PULL_REQUEST },
};

/**
 * Offline golden fixtures shared by all deployment-profile conformance tests.
 * The recovery and generation cases intentionally remain data-only: a test
 * adapter supplies the bounded effect outcome without adding provider payloads.
 */
export const CROSS_DEPLOYMENT_FIXTURES: readonly CrossDeploymentFixture[] = Object.freeze([
  {
    version: CROSS_DEPLOYMENT_CONFORMANCE_VERSION,
    name: "issue-verified",
    request: { version: 1, operation: "issue", issue: ISSUE },
    before: snapshot("canon-generation-1", ABSENT_EVIDENCE),
    after: snapshot("canon-generation-2", DRAFT_EVIDENCE),
    expected: {
      admission: "admitted",
      projection: projection("draft"),
      plan: DRAFT_PLAN,
      outcome: "verified",
      diagnostics: [],
      verified: true,
    },
  },
  {
    version: CROSS_DEPLOYMENT_CONFORMANCE_VERSION,
    name: "issue-idempotent-retry",
    request: { version: 1, operation: "issue", issue: ISSUE },
    before: snapshot("canon-generation-2", DRAFT_EVIDENCE),
    after: snapshot("canon-generation-2", DRAFT_EVIDENCE),
    expected: {
      admission: "admitted",
      projection: projection("draft"),
      plan: { operation: "issue", effects: [], postcondition: DRAFT_PLAN.postcondition },
      outcome: "returned-existing",
      diagnostics: [],
      verified: true,
    },
  },
  {
    version: CROSS_DEPLOYMENT_CONFORMANCE_VERSION,
    name: "abort-compensation-recovery",
    request: { version: 1, operation: "abort", issue: ISSUE },
    before: snapshot("canon-generation-2", DRAFT_EVIDENCE),
    after: snapshot("canon-generation-3", RECOVERY_EVIDENCE),
    expected: {
      admission: "admitted",
      outcome: "recovery-required",
      diagnostics: [
        {
          code: "COMPENSATION_REQUIRED",
          phase: "recovery-required",
          message: "Bounded cleanup could not prove the canonical branch generation.",
        },
      ],
      verified: false,
    },
  },
  {
    version: CROSS_DEPLOYMENT_CONFORMANCE_VERSION,
    name: "stale-authority-generation",
    request: { version: 1, operation: "ready", issue: ISSUE },
    before: snapshot("canon-generation-stale", DRAFT_EVIDENCE),
    after: snapshot("canon-generation-3", DRAFT_EVIDENCE),
    expected: {
      admission: "denied",
      outcome: "denied",
      diagnostics: [{ code: "STALE_AUTHORITY_GENERATION", phase: "authorization" }],
      verified: false,
    },
  },
  {
    version: CROSS_DEPLOYMENT_CONFORMANCE_VERSION,
    name: "permission-admission-denied",
    request: { version: 1, operation: "ready", issue: ISSUE },
    before: snapshot("canon-generation-2", DRAFT_EVIDENCE),
    after: snapshot("canon-generation-2", DRAFT_EVIDENCE),
    expected: {
      admission: "denied",
      outcome: "denied",
      diagnostics: [],
      verified: false,
    },
  },
]);

export const CROSS_DEPLOYMENT_CONFORMANCE_ISSUE = ISSUE;
