import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArtifactContract } from "./contract/artifact-contract.js";
import { compileEffectiveArtifactContract } from "./contract/effective-artifact-contract.js";
import { materializeSemanticArtifact } from "./contract/semantic-artifact.js";
import type { ArtifactContractProvenance } from "./contract/ir.js";
import { GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES, projectSemanticPullRequest } from "./semantic-pr-projection.js";
import {
  compareSemanticPullRequestProjection,
  observeSemanticPullRequest,
  tryObserveSemanticPullRequest,
} from "./semantic-pr-observation.js";

const provenance: ArtifactContractProvenance = {
  authority: "repository-default-branch",
  repository: {
    host: "github.com",
    owner: "yohn-jp",
    name: "gh-inari",
    nameWithOwner: "yohn-jp/gh-inari",
    repositoryId: "1234",
  },
  ref: "main",
  treeSha: "tree-sha",
  source: {
    path: ".github/inari/canon/pull-request.json",
    ref: "main",
    sha: "blob-sha",
    digest: "source-digest",
  },
};

const contract = parseArtifactContract({
  version: "1",
  kind: "pull_request",
  id: "observation",
  properties: {
    title: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "format", template: "{type}: {slug}" } },
    },
    head: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "format", template: "{type}/{slug}" } },
    },
    base: { presence: "required", authority: { kind: "fixed", value: "main" } },
    type: { presence: "required", authority: { kind: "supplied" }, constraints: { values: ["feat", "fix"] } },
    implements: { presence: "required", authority: { kind: "supplied" } },
  },
  fields: [
    {
      id: "summary",
      primitive: "text",
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { minLength: 1 },
    },
    {
      id: "slug",
      primitive: "text",
      presence: "required",
      authority: { kind: "derived", derive: { op: "slug", from: "summary" } },
    },
  ],
});

function issue(number: number) {
  return {
    repositoryHost: "github.com",
    repositoryId: "1234",
    repository: "yohn-jp/gh-inari",
    number,
  };
}

const artifact = materializeSemanticArtifact(compileEffectiveArtifactContract(contract, { provenance }), {
  type: "feat",
  summary: "Observe semantic PR drift",
  implements: [issue(283)],
});

const recognizedDesired = projectSemanticPullRequest({
  artifact,
  capabilities: [GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES.recognizedClosingReference],
});
const fallbackDesired = projectSemanticPullRequest({
  artifact,
  capabilities: [GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES.bodyRelationFallback],
});
const nativeDesired = projectSemanticPullRequest({
  artifact,
  capabilities: [GITHUB_PULL_REQUEST_PROJECTION_CAPABILITIES.nativeImplementsRelation],
});

const repository = {
  host: "github.com",
  repositoryId: "1234",
  repository: "yohn-jp/gh-inari",
};

function githubPullRequest(desired: typeof recognizedDesired, body = desired.body) {
  return {
    number: 99,
    title: desired.title,
    body,
    state: "open" as const,
    url: "https://github.com/yohn-jp/gh-inari/pull/99",
    draft: false,
    maintainerCanModify: true,
    head: desired.head,
    base: desired.base,
  };
}

test("normalizes a bounded GitHub PR and recognized closing-reference evidence", () => {
  const observed = observeSemanticPullRequest({
    pullRequest: githubPullRequest(recognizedDesired),
    repository,
  });
  assert.equal(observed.version, "1");
  assert.equal(observed.kind, "pull_request");
  assert.equal(observed.title, recognizedDesired.title);
  assert.equal(observed.head, recognizedDesired.head);
  assert.equal(observed.base, recognizedDesired.base);
  assert.equal(observed.relations.implements.representation, "recognized-convention");
  assert.deepEqual(observed.relations.implements.references, [issue(283)]);
  assert.deepEqual(observed.relations.implements.evidence.native, undefined);
  assert.deepEqual(observed.relations.implements.evidence.bodyFallback, []);
});

test("recognizes GitHub closing-keyword variants and cross-repository syntax", () => {
  const observed = observeSemanticPullRequest({
    pullRequest: githubPullRequest(recognizedDesired, "This text resolves: #283 and fixes yohn-jp/gh-inari#283."),
    repository,
  });
  assert.equal(observed.relations.implements.representation, "recognized-convention");
  assert.deepEqual(observed.relations.implements.references, [issue(283)]);
});

test("reconciles native and fallback representations without changing semantic references", () => {
  const native = observeSemanticPullRequest({
    pullRequest: githubPullRequest(nativeDesired),
    relations: { implements: { native: [issue(283)] } },
    repository,
  });
  assert.equal(native.relations.implements.representation, "native");
  assert.deepEqual(native.relations.implements.references, [issue(283)]);

  const fallback = observeSemanticPullRequest({ pullRequest: githubPullRequest(fallbackDesired), repository });
  assert.equal(fallback.relations.implements.representation, "body-fallback");
  assert.deepEqual(fallback.relations.implements.references, [issue(283)]);
  assert.equal(compareSemanticPullRequestProjection(fallbackDesired, fallback).valid, true);
});

test("retains conflicting relation evidence for comparison as drift", () => {
  const observed = observeSemanticPullRequest({
    pullRequest: githubPullRequest(recognizedDesired, "Closes #284\n"),
    relations: { implements: { native: [issue(283)] } },
    repository,
  });
  assert.equal(observed.relations.implements.representation, "conflict");
  const result = compareSemanticPullRequestProjection(recognizedDesired, observed);
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["BODY_DRIFT", "RELATION_CONFLICT"],
  );
});

test("compares governed PR identity, body, metadata, and relation with stable paths", () => {
  const desired = {
    ...recognizedDesired,
    metadata: {
      labels: ["semantic", "wave"],
      assignees: ["octocat"],
      milestone: "v1",
      reviewers: ["alice", "platform-team"],
      draft: false,
      maintainerCanModify: true,
    },
  };
  const observed = observeSemanticPullRequest({
    pullRequest: {
      ...githubPullRequest(desired),
      title: "edited title",
      head: "edited/head",
      base: "develop",
      body: "edited body",
      labels: ["wrong"],
      assignees: [],
      milestone: { number: 2, title: "v2" },
      requestedReviewers: { users: ["bob"], teams: [] },
      draft: true,
      maintainerCanModify: false,
    },
    repository,
  });
  const result = compareSemanticPullRequestProjection(desired, observed);
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.path),
    [
      "$.title",
      "$.head",
      "$.base",
      "$.body",
      "$.metadata.labels",
      "$.metadata.assignees",
      "$.metadata.milestone",
      "$.metadata.reviewers",
      "$.metadata.draft",
      "$.metadata.maintainerCanModify",
      "$.relations.implements.references",
    ],
  );
});

test("native relation comparison fails closed when native evidence is unavailable", () => {
  const observed = observeSemanticPullRequest({
    pullRequest: githubPullRequest(nativeDesired),
    repository,
  });
  const result = compareSemanticPullRequestProjection(nativeDesired, observed);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0]?.code, "RELATION_OBSERVATION_UNAVAILABLE");
});

test("observation rejects malformed, unknown, and oversized evidence", () => {
  const malformed = tryObserveSemanticPullRequest({
    pullRequest: { ...githubPullRequest(recognizedDesired), labels: ["duplicate", "duplicate"] },
    repository,
  });
  assert.equal(malformed.valid, false);
  assert.ok(malformed.violations.some((violation) => violation.code === "OBSERVED_PULL_REQUEST_VALUE_INVALID"));

  const unknown = tryObserveSemanticPullRequest({
    pullRequest: githubPullRequest(recognizedDesired),
    repository,
    extra: true,
  });
  assert.equal(unknown.valid, false);
  assert.equal(unknown.violations[0]?.code, "OBSERVATION_INPUT_UNKNOWN_PROPERTY");

  const oversized = tryObserveSemanticPullRequest({
    pullRequest: { ...githubPullRequest(recognizedDesired), body: "x".repeat(1_048_577) },
    repository,
  });
  assert.equal(oversized.valid, false);
  assert.ok(oversized.violations.some((violation) => violation.code === "OBSERVED_BODY_INVALID"));
});

test("observed projections are immutable and key-order independent", () => {
  const first = observeSemanticPullRequest({ pullRequest: githubPullRequest(recognizedDesired), repository });
  const second = observeSemanticPullRequest({
    repository,
    pullRequest: {
      base: recognizedDesired.base,
      body: recognizedDesired.body,
      head: recognizedDesired.head,
      title: recognizedDesired.title,
      url: "https://github.com/yohn-jp/gh-inari/pull/99",
      state: "open",
      draft: false,
      maintainerCanModify: true,
      number: 99,
    },
  });
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.relations.implements.evidence), true);
});
