import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGE_CONTRACT_VERSION,
  MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_CHANGE_DIAGNOSTIC_PATH_LENGTH,
  planChangeIssuance,
  validateChangeMergeAdmission,
  type Change,
  type ChangeGitHubEvidence,
  type ChangeIssuancePlan,
  type ChangeProjectionInput,
  type ChangePullRequestEvidence,
} from "./change.js";
import { renderPullRequestArtifact } from "./artifact.js";
import { pullRequestContractFixture } from "./contract/fixtures.js";
import type { CanonicalContract } from "./contract/ir.js";

const identity = {
  repositoryHost: "github.com",
  repositoryId: "100000220",
  rootIssue: 220,
} as const;
const canonicalBranch = "feat/220-enforce-canonical-change-provenance";
const canonicalBaseBranch = "main";
const branchGovernance = { pattern: "^feat/[0-9]+-[a-z0-9-]+$" };
const naming = { type: "feat", slug: "enforce-canonical-change-provenance" };
const issuer = "app:inari-issuer";

const governedPullRequestContract: CanonicalContract = {
  ...pullRequestContractFixture,
  provenance: {
    authority: "repository-default-branch",
    repository: {
      host: "github.com",
      owner: "acme",
      name: "inari",
      nameWithOwner: "acme/inari",
      repositoryId: identity.repositoryId,
    },
    ref: canonicalBaseBranch,
    treeSha: "fixture-tree-sha",
    template: {
      path: pullRequestContractFixture.templateIdentity.path,
      ref: canonicalBaseBranch,
      sha: "fixture-template-sha",
      digest: "fixture-template-digest",
    },
  },
};

const pullRequestBody = renderPullRequestArtifact(governedPullRequestContract, {
  summary: "A canonical provenance validation change.",
  linked_issue: "Closes #220",
  acceptance: ["tests"],
  scope: "merge admission",
});

function issueEvidence(number: number = identity.rootIssue): ChangeGitHubEvidence["issue"] {
  return { status: "available", value: { number, state: "open" } };
}

function branchEvidence(names: readonly string[] = [canonicalBranch]): ChangeGitHubEvidence["branches"] {
  return { status: "available", value: names.map((name) => ({ name })) };
}

function pullRequest(number = 500, overrides: Partial<ChangePullRequestEvidence> = {}): ChangePullRequestEvidence {
  return {
    number,
    head: canonicalBranch,
    base: canonicalBaseBranch,
    state: "open",
    draft: true,
    merged: false,
    provenance: { issuer },
    ...overrides,
  };
}

function projectionInput(evidence: ChangeGitHubEvidence, withProvenance = true): ChangeProjectionInput {
  return {
    change: identity,
    ...(withProvenance ? { provenance: { issuer } } : {}),
    branchGovernance,
    naming,
    baseBranch: canonicalBaseBranch,
    evidence,
  };
}

function canonicalProjectionInput(): ChangeProjectionInput {
  return projectionInput({
    issue: issueEvidence(),
    branches: branchEvidence(),
    pullRequests: { status: "available", value: [pullRequest()] },
  });
}

function canonicalIssuance(): ChangeIssuancePlan {
  return planChangeIssuance(canonicalProjectionInput());
}

function canonicalChange(): Change {
  return canonicalIssuance().result;
}

function admissionInput(
  projection: ChangeProjectionInput = canonicalProjectionInput(),
  change: Change = canonicalChange(),
  issuance: ChangeIssuancePlan = canonicalIssuance(),
) {
  return {
    change,
    projection,
    issuance,
    pullRequest: {
      contract: governedPullRequestContract,
      body: pullRequestBody,
    },
  };
}

function assertDiagnostic(result: ReturnType<typeof validateChangeMergeAdmission>, code: string): void {
  assert.equal(result.valid, false);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === code),
    code,
  );
}

test("healthy canonical Change passes merge-admission provenance validation", () => {
  const result = validateChangeMergeAdmission(admissionInput());

  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.change?.identity.rootIssue, identity.rootIssue);
  assert.deepEqual(result.change?.projection, { branch: canonicalBranch, pullRequest: 500 });
  assert.equal(result.projection?.status, "healthy");
  assert.equal(result.physicalPullRequest?.number, 500);
});

test("projection and diagnostics are deterministic regardless of evidence order", () => {
  const firstProjection = projectionInput({
    issue: issueEvidence(),
    branches: branchEvidence(["feat/220-unrelated", canonicalBranch]),
    pullRequests: {
      status: "available",
      value: [pullRequest(501, { head: "feat/220-unrelated", provenance: {} }), pullRequest()],
    },
  });
  const reorderedProjection = projectionInput({
    issue: issueEvidence(),
    branches: branchEvidence([canonicalBranch, "feat/220-unrelated"]),
    pullRequests: {
      status: "available",
      value: [pullRequest(), pullRequest(501, { head: "feat/220-unrelated", provenance: {} })],
    },
  });

  const first = validateChangeMergeAdmission(admissionInput(firstProjection));
  const reordered = validateChangeMergeAdmission(admissionInput(reorderedProjection));
  assert.deepEqual(reordered, first);
  assert.ok(first.diagnostics.every((diagnostic) => diagnostic.path.length <= MAX_CHANGE_DIAGNOSTIC_PATH_LENGTH));
  assert.ok(first.diagnostics.every((diagnostic) => diagnostic.message.length <= MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH));
});

test("wrong branch, base, root Issue, or pull-request identity fails closed", () => {
  const wrongBranch = validateChangeMergeAdmission(
    admissionInput(
      projectionInput({
        issue: issueEvidence(),
        branches: branchEvidence(),
        pullRequests: {
          status: "available",
          value: [pullRequest(500, { head: "feat/220-wrong-branch" })],
        },
      }),
    ),
  );
  assertDiagnostic(wrongBranch, "CHANGE_PROVENANCE_BRANCH_MISMATCH");

  const wrongBase = validateChangeMergeAdmission(
    admissionInput(
      projectionInput({
        issue: issueEvidence(),
        branches: branchEvidence(),
        pullRequests: {
          status: "available",
          value: [pullRequest(500, { base: "develop" })],
        },
      }),
    ),
  );
  assertDiagnostic(wrongBase, "CHANGE_PROJECTION_WRONG_BASE");

  const wrongIssue = validateChangeMergeAdmission(
    admissionInput(
      projectionInput({
        issue: issueEvidence(999),
        branches: branchEvidence(),
        pullRequests: { status: "available", value: [pullRequest()] },
      }),
    ),
  );
  assertDiagnostic(wrongIssue, "CHANGE_PROJECTION_ISSUE_MISMATCH");

  const wrongPullRequest = validateChangeMergeAdmission(
    admissionInput(
      projectionInput({
        issue: issueEvidence(),
        branches: branchEvidence(),
        pullRequests: { status: "available", value: [pullRequest(501)] },
      }),
    ),
  );
  assertDiagnostic(wrongPullRequest, "CHANGE_PROVENANCE_PULL_REQUEST_MISMATCH");
});

test("missing or noncanonical issuer provenance fails closed", () => {
  const missing = validateChangeMergeAdmission(
    admissionInput(
      projectionInput({
        issue: issueEvidence(),
        branches: branchEvidence(),
        pullRequests: { status: "available", value: [pullRequest(500, { provenance: {} })] },
      }),
    ),
  );
  assertDiagnostic(missing, "CHANGE_PROVENANCE_INVALID_ISSUER");

  const nonissuer = validateChangeMergeAdmission(
    admissionInput(
      projectionInput({
        issue: issueEvidence(),
        branches: branchEvidence(),
        pullRequests: {
          status: "available",
          value: [pullRequest(500, { provenance: { issuer: "human:manual" } })],
        },
      }),
    ),
  );
  assertDiagnostic(nonissuer, "CHANGE_PROVENANCE_ISSUER_MISMATCH");
});

test("invalid governed PR contract fails closed", () => {
  const invalidBody = validateChangeMergeAdmission({
    ...admissionInput(),
    pullRequest: {
      contract: governedPullRequestContract,
      body: pullRequestBody.replace("Closes #220", "No linked issue"),
    },
  });
  assertDiagnostic(invalidBody, "CHANGE_PROVENANCE_INVALID_PR_CONTRACT");

  const ungoverned = validateChangeMergeAdmission({
    ...admissionInput(),
    pullRequest: {
      contract: pullRequestContractFixture,
      body: pullRequestBody,
    },
  });
  assertDiagnostic(ungoverned, "CHANGE_PROVENANCE_INVALID_PR_CONTRACT");
});

test("physical PR existence does not promote a manual same-intent PR", () => {
  const manual = validateChangeMergeAdmission(
    admissionInput(
      projectionInput({
        issue: issueEvidence(),
        branches: branchEvidence(),
        pullRequests: {
          status: "available",
          value: [pullRequest(501, { provenance: {} })],
        },
      }),
    ),
  );

  assertDiagnostic(manual, "CHANGE_PROVENANCE_PULL_REQUEST_MISMATCH");
  assert.equal(manual.change, undefined);
});

test("duplicate, conflicting, and ambiguous projections fail closed", () => {
  const duplicate = validateChangeMergeAdmission(
    admissionInput(
      projectionInput({
        issue: issueEvidence(),
        branches: branchEvidence(),
        pullRequests: { status: "available", value: [pullRequest(), pullRequest(501)] },
      }),
    ),
  );
  assertDiagnostic(duplicate, "CHANGE_PROJECTION_DUPLICATE");

  const conflicting = validateChangeMergeAdmission(
    admissionInput(
      projectionInput({
        issue: issueEvidence(),
        branches: branchEvidence(),
        pullRequests: { status: "available", value: [pullRequest(500, { rootIssue: 999 })] },
      }),
    ),
  );
  assertDiagnostic(conflicting, "CHANGE_PROJECTION_AMBIGUOUS");

  const ambiguous = validateChangeMergeAdmission(
    admissionInput(
      projectionInput({
        issue: issueEvidence(),
        branches: branchEvidence([]),
        pullRequests: {
          status: "available",
          value: [
            pullRequest(501, { head: "feat/220-first", rootIssue: 220 }),
            pullRequest(502, { head: "feat/220-second", rootIssue: 220 }),
          ],
        },
      }),
    ),
  );
  assertDiagnostic(ambiguous, "CHANGE_PROJECTION_AMBIGUOUS");
});

test("recovery and undefined canonical snapshots never pass admission", () => {
  const recovery = validateChangeMergeAdmission(
    admissionInput(undefined, { ...canonicalChange(), state: "RECOVERY_REQUIRED" }),
  );
  assertDiagnostic(recovery, "CHANGE_PROVENANCE_INVALID_INPUT");

  const defined = validateChangeMergeAdmission(
    admissionInput(undefined, {
      version: CHANGE_CONTRACT_VERSION,
      identity,
      state: "DEFINED",
      provenance: { issuer },
    }),
  );
  assertDiagnostic(defined, "CHANGE_PROVENANCE_PULL_REQUEST_MISMATCH");
});
