import assert from "node:assert/strict";
import test from "node:test";
import { renderPullRequestArtifact } from "../src/artifact.ts";
import { pullRequestContractFixture } from "../src/contract/fixtures.ts";
import { INARI_ISSUER_PRINCIPAL } from "../src/github/issuer-authority.ts";
import {
  classifyChangePullRequestContract,
  validateChangeMergeAdmissionEvent,
} from "./validate-change-merge-admission.mjs";

const identity = {
  repositoryHost: "github.com",
  repositoryId: "100000261",
  rootIssue: 261,
};
const canonicalBranch = "feat/261-change-provenance-merge-admission";
const baseBranch = "main";
const issuer = INARI_ISSUER_PRINCIPAL;

const contract = {
  ...pullRequestContractFixture,
  provenance: {
    authority: "repository-default-branch",
    repository: {
      host: identity.repositoryHost,
      owner: "yohn-jp",
      name: "gh-inari",
      nameWithOwner: "yohn-jp/gh-inari",
      repositoryId: identity.repositoryId,
    },
    ref: baseBranch,
    treeSha: "tree-261",
    template: {
      path: pullRequestContractFixture.templateIdentity.path,
      ref: baseBranch,
      sha: "template-261",
      digest: "digest-261",
    },
  },
};

const body = renderPullRequestArtifact(contract, {
  summary: "Project canonical Change provenance into merge admission.",
  linked_issue: "Closes #261",
  acceptance: ["tests"],
  scope: "repository merge admission",
});

function pullRequest(number = 500, overrides = {}) {
  return {
    number,
    head: canonicalBranch,
    base: baseBranch,
    state: "open",
    draft: true,
    merged: false,
    provenance: { issuer },
    ...overrides,
  };
}

function projectionInput(pullRequests, overrides = {}) {
  return {
    change: identity,
    provenance: { issuer },
    naming: { type: "feat", slug: "change-provenance-merge-admission" },
    baseBranch,
    evidence: {
      issue: { status: "available", value: { number: identity.rootIssue, state: "open" } },
      branches: { status: "available", value: [{ name: canonicalBranch }] },
      pullRequests: { status: "available", value: pullRequests },
    },
    ...overrides,
  };
}

function githubEvent(number = 500, overrides = {}) {
  const candidate = pullRequest(number, overrides);
  return {
    repository: { full_name: "yohn-jp/gh-inari" },
    pull_request: {
      number: candidate.number,
      body,
      state: candidate.state,
      draft: candidate.draft,
      head: { ref: candidate.head },
      base: { ref: candidate.base },
    },
  };
}

function evaluate(eventPullRequest, evidencePullRequests = [pullRequest()]) {
  const observed = pullRequest(eventPullRequest.number, eventPullRequest);
  return validateChangeMergeAdmissionEvent({
    event: githubEvent(eventPullRequest.number, eventPullRequest),
    projection: projectionInput(evidencePullRequests),
    contract,
    body,
    observedPullRequest: observed,
  });
}

function assertRejected(result, code) {
  assert.equal(result.valid, false);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === code),
    code,
  );
  assert.ok(result.diagnostics.length <= 8);
  assert.ok(result.diagnostics.every((diagnostic) => !JSON.stringify(diagnostic).includes("token")));
}

test("canonical GitHub-shaped PR and evidence pass deterministically", () => {
  const first = evaluate(pullRequest(), [pullRequest()]);
  const reordered = evaluate(pullRequest(), [pullRequest()]);

  assert.equal(first.valid, true);
  assert.deepEqual(first, reordered);
  assert.equal(first.classification, "governed-change");
  assert.equal(first.canonicalPullRequest, 500);
  assert.equal(first.canonicalBranch, canonicalBranch);
});

test("an explicitly non-Change contract is classified outside the Change model", () => {
  const releaseContract = {
    ...contract,
    templateIdentity: { ...contract.templateIdentity, id: "release" },
    supplementalConstraints: { fields: [] },
  };

  assert.equal(classifyChangePullRequestContract(releaseContract), "outside-governed-change");
  assert.equal(
    classifyChangePullRequestContract({
      ...releaseContract,
      templateIdentity: { ...releaseContract.templateIdentity, id: "default" },
    }),
    "outside-governed-change",
  );
});

test("wrong branch and wrong base fail closed at the live event boundary", () => {
  assertRejected(
    evaluate(pullRequest(500, { head: "feat/261-manual-branch" }), [
      pullRequest(500, { head: "feat/261-manual-branch" }),
    ]),
    "CHANGE_PROJECTION_PARTIAL",
  );
  assertRejected(
    evaluate(pullRequest(500, { base: "develop" }), [pullRequest(500, { base: "develop" })]),
    "CHANGE_PROJECTION_WRONG_BASE",
  );
});

test("wrong PR identity and manual same-intent PR fail closed", () => {
  assertRejected(
    evaluate(pullRequest(501), [pullRequest(), pullRequest(501)]),
    "CHANGE_PROVENANCE_PULL_REQUEST_MISMATCH",
  );
  assertRejected(
    evaluate(pullRequest(501, { provenance: {} }), [
      pullRequest(),
      pullRequest(501, { provenance: {}, rootIssue: identity.rootIssue }),
    ]),
    "CHANGE_PROJECTION_DUPLICATE",
  );
});

test("missing and nonissuer provenance fail closed", () => {
  assertRejected(
    evaluate(pullRequest(500, { provenance: {} }), [pullRequest(500, { provenance: {} })]),
    "CHANGE_PROVENANCE_INVALID_ISSUER",
  );
  assertRejected(
    evaluate(pullRequest(500, { provenance: { issuer: "human:manual" } }), [
      pullRequest(500, { provenance: { issuer: "human:manual" } }),
    ]),
    "CHANGE_PROVENANCE_ISSUER_MISMATCH",
  );
});

test("invalid governed contract, duplicate/conflicting evidence, and recovery fail closed", () => {
  assertRejected(
    validateChangeMergeAdmissionEvent({
      event: githubEvent(),
      projection: projectionInput([pullRequest()]),
      contract,
      body: body.replace("Closes #261", "No linked issue"),
      observedPullRequest: pullRequest(),
    }),
    "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
  );
  assertRejected(evaluate(pullRequest(), [pullRequest(), pullRequest(501)]), "CHANGE_PROJECTION_DUPLICATE");
  assertRejected(evaluate(pullRequest(), [pullRequest(500, { rootIssue: 999 })]), "CHANGE_PROJECTION_AMBIGUOUS");

  const recovery = {
    version: 1,
    identity,
    state: "RECOVERY_REQUIRED",
    provenance: { issuer },
    projection: { branch: canonicalBranch, pullRequest: 500 },
  };
  const result = validateChangeMergeAdmissionEvent({
    event: githubEvent(),
    projection: projectionInput([pullRequest()]),
    contract,
    body,
    observedPullRequest: pullRequest(),
    canonicalChange: recovery,
  });
  assertRejected(result, "CHANGE_PROVENANCE_INVALID_INPUT");
});
