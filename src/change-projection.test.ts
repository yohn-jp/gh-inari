import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGE_CONTRACT_VERSION,
  projectChangeFromGitHubEvidence,
  type ChangeGitHubEvidence,
  type ChangeIdentity,
  type ChangeProjectionInput,
  type ChangePullRequestEvidence,
} from "./change.js";

const identity: ChangeIdentity = {
  repositoryHost: "github.com",
  repositoryId: "100000213",
  rootIssue: 213,
};
const canonicalBranch = "feat/213-derive-change-projection-from-github-evidence";
const canonicalBaseBranch = "main";
const governance = { pattern: "^feat/[0-9]+-[a-z0-9-]+$" };
const naming = { type: "feat", slug: "derive-change-projection-from-github-evidence" };

function issueEvidence(): ChangeGitHubEvidence["issue"] {
  return { status: "available", value: { number: 213, state: "open" } };
}

function branchEvidence(names: readonly string[] = [canonicalBranch]): ChangeGitHubEvidence["branches"] {
  return {
    status: "available",
    value: names.map((name) => ({ name })),
  };
}

function pullRequestEvidence(
  pullRequests: readonly ChangePullRequestEvidence[] = [
    { number: 400, head: canonicalBranch, base: canonicalBaseBranch, state: "open", draft: true, merged: false },
  ],
): ChangeGitHubEvidence["pullRequests"] {
  return { status: "available", value: pullRequests };
}

function projectionInput(evidence: ChangeGitHubEvidence): ChangeProjectionInput {
  return {
    change: identity,
    branchGovernance: governance,
    naming,
    baseBranch: canonicalBaseBranch,
    evidence,
  };
}

test("projects a healthy canonical Draft/Review/Accepted/Merged/Aborted lifecycle", () => {
  const cases: readonly [ChangePullRequestEvidence, string][] = [
    [{ number: 400, head: canonicalBranch, base: "main", state: "open", draft: true, merged: false }, "DRAFT"],
    [{ number: 401, head: canonicalBranch, base: "main", state: "open", draft: false, merged: false }, "REVIEW"],
    [
      { number: 402, head: canonicalBranch, base: "main", state: "open", draft: false, merged: false, accepted: true },
      "ACCEPTED",
    ],
    [{ number: 403, head: canonicalBranch, base: "main", state: "closed", draft: false, merged: true }, "MERGED"],
    [{ number: 404, head: canonicalBranch, base: "main", state: "closed", draft: false, merged: false }, "ABORTED"],
  ];

  for (const [pullRequest, state] of cases) {
    const result = projectChangeFromGitHubEvidence(
      projectionInput({
        issue: issueEvidence(),
        branches: state === "ABORTED" ? branchEvidence([]) : branchEvidence(),
        pullRequests: pullRequestEvidence([pullRequest]),
      }),
    );
    assert.equal(result.valid, true);
    assert.equal(result.status, "healthy");
    assert.equal(result.change?.version, CHANGE_CONTRACT_VERSION);
    assert.equal(result.change?.state, state);
    assert.deepEqual(result.change?.projection, { branch: canonicalBranch, pullRequest: pullRequest.number });
    if (state === "ABORTED") assert.equal(result.candidates.branches.length, 0);
    else assert.equal(result.candidates.branches[0]?.classification, "canonical");
    assert.equal(result.candidates.pullRequests[0]?.classification, "canonical");
  }
});

test("rejects a pull request that reuses the root Issue number", () => {
  const result = projectChangeFromGitHubEvidence(
    projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence(),
      pullRequests: pullRequestEvidence([
        {
          number: identity.rootIssue,
          head: canonicalBranch,
          base: canonicalBaseBranch,
          state: "open",
          draft: true,
          merged: false,
        },
      ]),
    }),
  );
  assert.equal(result.valid, false);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.change?.projection?.pullRequest, undefined);
  assert.equal(result.candidates.pullRequests[0]?.classification, "conflicting");
});

test("closed unmerged canonical PR with a retained branch is incomplete abort cleanup", () => {
  const result = projectChangeFromGitHubEvidence(
    projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence(),
      pullRequests: pullRequestEvidence([
        { number: 404, head: canonicalBranch, base: "main", state: "closed", draft: false, merged: false },
      ]),
    }),
  );

  assert.equal(result.valid, false);
  assert.equal(result.status, "partial");
  assert.equal(result.change?.state, "RECOVERY_REQUIRED");
  assert.deepEqual(result.change?.projection, { branch: canonicalBranch, pullRequest: 404 });
});

test("closed canonical PR without its branch preserves historical aborted provenance", () => {
  const result = projectChangeFromGitHubEvidence(
    projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence([]),
      pullRequests: pullRequestEvidence([
        {
          number: 404,
          head: canonicalBranch,
          base: "main",
          state: "closed",
          draft: false,
          merged: false,
          provenance: { requester: "human:sophia", issuer: "app:inari-issuer", implementer: "agent:codex" },
        },
      ]),
    }),
  );

  assert.equal(result.valid, true);
  assert.equal(result.status, "healthy");
  assert.equal(result.change?.state, "ABORTED");
  assert.deepEqual(result.change?.projection, { branch: canonicalBranch, pullRequest: 404 });
  assert.deepEqual(result.change?.provenance, {
    requester: "human:sophia",
    issuer: "app:inari-issuer",
    implementer: "agent:codex",
  });
});

test("projects an existing Issue with no canonical artifacts as defined/absent", () => {
  const result = projectChangeFromGitHubEvidence(
    projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence([]),
      pullRequests: pullRequestEvidence([]),
    }),
  );

  assert.equal(result.valid, true);
  assert.equal(result.status, "absent");
  assert.equal(result.change?.state, "DEFINED");
  assert.equal(result.change?.projection, undefined);
  assert.deepEqual(result.diagnostics, []);
});

test("distinguishes confirmed absence from an unavailable evidence read", () => {
  const absent = projectChangeFromGitHubEvidence(
    projectionInput({
      issue: issueEvidence(),
      branches: { status: "absent" },
      pullRequests: { status: "absent" },
    }),
  );
  assert.equal(absent.status, "absent");

  const unavailable = projectChangeFromGitHubEvidence(
    projectionInput({
      issue: { status: "unavailable", reason: "permission denied" },
      branches: branchEvidence([]),
      pullRequests: pullRequestEvidence([]),
    }),
  );
  assert.equal(unavailable.valid, false);
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.change, undefined);
  assert.ok(unavailable.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_PROJECTION_EVIDENCE_UNAVAILABLE"));
});

test("reports a canonical branch without a canonical PR as partial recovery-required state", () => {
  const result = projectChangeFromGitHubEvidence(
    projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence(),
      pullRequests: pullRequestEvidence([]),
    }),
  );

  assert.equal(result.valid, false);
  assert.equal(result.status, "partial");
  assert.equal(result.change?.state, "RECOVERY_REQUIRED");
  assert.deepEqual(result.change?.projection, { branch: canonicalBranch });
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_PROJECTION_PARTIAL"));
});

test("rejects duplicate canonical candidates instead of selecting one", () => {
  const result = projectChangeFromGitHubEvidence(
    projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence(),
      pullRequests: pullRequestEvidence([
        { number: 400, head: canonicalBranch, base: "main", state: "open", draft: true, merged: false },
        { number: 401, head: canonicalBranch, base: "main", state: "open", draft: false, merged: false },
      ]),
    }),
  );

  assert.equal(result.valid, false);
  assert.equal(result.status, "duplicate");
  assert.equal(result.change?.state, "RECOVERY_REQUIRED");
  assert.equal(result.change?.projection?.pullRequest, undefined);
  assert.ok(result.candidates.pullRequests.every((candidate) => candidate.classification === "canonical"));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_PROJECTION_DUPLICATE"));
});

test("reports a canonical-branch pull request with a wrong base explicitly", () => {
  const result = projectChangeFromGitHubEvidence(
    projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence(),
      pullRequests: pullRequestEvidence([
        { number: 400, head: canonicalBranch, base: "develop", state: "open", draft: true, merged: false },
      ]),
    }),
  );

  assert.equal(result.valid, false);
  assert.equal(result.status, "wrong-base");
  assert.equal(result.change?.state, "RECOVERY_REQUIRED");
  assert.deepEqual(result.change?.projection, { branch: canonicalBranch });
  assert.equal(result.candidates.pullRequests[0]?.classification, "conflicting");
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_PROJECTION_WRONG_BASE"));
});

test("fails closed for multiple plausible noncanonical Issue candidates", () => {
  const result = projectChangeFromGitHubEvidence(
    projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence([]),
      pullRequests: pullRequestEvidence([
        {
          number: 400,
          head: "feat/213-first-candidate",
          base: "main",
          state: "open",
          draft: true,
          merged: false,
          rootIssue: 213,
        },
        {
          number: 401,
          head: "feat/213-second-candidate",
          base: "main",
          state: "open",
          draft: false,
          merged: false,
          rootIssue: 213,
        },
      ]),
    }),
  );

  assert.equal(result.valid, false);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.change?.state, "RECOVERY_REQUIRED");
  assert.equal(result.change?.projection, undefined);
  assert.ok(result.candidates.pullRequests.every((candidate) => candidate.classification === "noncanonical"));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_PROJECTION_AMBIGUOUS"));
});

test("projection ordering is deterministic and does not depend on evidence order", () => {
  const first = projectChangeFromGitHubEvidence(
    projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence(["feat/213-other", canonicalBranch]),
      pullRequests: pullRequestEvidence([
        { number: 401, head: "feat/213-other", base: "main", state: "open", draft: false, merged: false },
        { number: 400, head: canonicalBranch, base: "main", state: "open", draft: true, merged: false },
      ]),
    }),
  );
  const reordered = projectChangeFromGitHubEvidence(
    projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence([canonicalBranch, "feat/213-other"]),
      pullRequests: pullRequestEvidence([
        { number: 400, head: canonicalBranch, base: "main", state: "open", draft: true, merged: false },
        { number: 401, head: "feat/213-other", base: "main", state: "open", draft: false, merged: false },
      ]),
    }),
  );

  assert.deepEqual(reordered, first);
});

test("missing evidence is not interpreted as an empty projection", () => {
  const result = projectChangeFromGitHubEvidence(
    projectionInput({
      issue: issueEvidence(),
      branches: branchEvidence([]),
      pullRequests: undefined,
    } as unknown as ChangeGitHubEvidence),
  );

  assert.equal(result.valid, false);
  assert.equal(result.status, "unavailable");
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_PROJECTION_EVIDENCE_MISSING"));
});
