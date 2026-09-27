import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateSourceAcceptanceReviewer,
  type SourceAcceptanceProviderActorEvidence,
  type SourceAcceptanceReviewerEvaluationInput,
} from "./source-acceptance-reviewer.js";
import {
  SOURCE_ACCEPTANCE_POLICY_KIND,
  SOURCE_ACCEPTANCE_POLICY_PATH,
  SOURCE_ACCEPTANCE_POLICY_VERSION,
  type LoadedSourceAcceptancePolicy,
} from "./source-acceptance-policy.js";

const REPOSITORY = Object.freeze({ host: "github.com", id: "1330755860" });
const HEAD_SHA = "a".repeat(40);
const COMMIT_SHA = "b".repeat(40);
const POLICY_DIGEST = "c".repeat(64);

function currentPolicy(
  repository: Readonly<{ host: string; id: string }> = REPOSITORY,
  reviewerUserIds: readonly string[] = ["99"],
): LoadedSourceAcceptancePolicy {
  return Object.freeze({
    policy: Object.freeze({
      version: SOURCE_ACCEPTANCE_POLICY_VERSION,
      kind: SOURCE_ACCEPTANCE_POLICY_KIND,
      generation: 7,
      reviewerUserIds: Object.freeze([...reviewerUserIds]),
    }),
    provenance: Object.freeze({
      authority: "repository-default-branch",
      repository: Object.freeze({ ...repository }),
      ref: "main",
      commitSha: "d".repeat(40),
      treeSha: "e".repeat(40),
      source: Object.freeze({
        path: SOURCE_ACCEPTANCE_POLICY_PATH,
        ref: "main",
        blobSha: "f".repeat(40),
        digest: POLICY_DIGEST,
      }),
      generation: 7,
    }),
  });
}

function human(userId: string) {
  return { classification: "human" as const, providerHost: REPOSITORY.host, userId };
}

function bot() {
  return { classification: "bot" as const, providerHost: REPOSITORY.host };
}

function commit(sha: string, author: SourceAcceptanceProviderActorEvidence = human("30")) {
  return {
    sha,
    author,
    coAuthors: { resolution: "complete" as const, actors: [human("40")] },
  };
}

function validInput(): SourceAcceptanceReviewerEvaluationInput {
  return {
    currentPolicy: currentPolicy(),
    candidate: {
      repository: REPOSITORY,
      sourceIssue: 902,
      integrationPullRequest: { number: 1200, headSha: HEAD_SHA },
    },
    reviewer: human("99"),
    sourceRequester: { repository: REPOSITORY, sourceIssue: 902, author: human("10") },
    integrationPullRequestAuthor: {
      repository: REPOSITORY,
      pullRequest: { number: 1200, headSha: HEAD_SHA },
      author: human("20"),
    },
    contributors: {
      repository: REPOSITORY,
      pullRequest: { number: 1200, headSha: HEAD_SHA },
      pagination: "complete",
      observedHeadSha: HEAD_SHA,
      commits: [commit(HEAD_SHA)],
    },
  };
}

function expectDenied(input: unknown, expectedCode: string): void {
  const result = evaluateSourceAcceptanceReviewer(input);
  assert.equal(result.classification, "denied");
  if (result.classification === "denied") assert.equal(result.diagnostics[0]?.code, expectedCode);
}

test("authorizes only a current allowlisted human independent of every exact-head human contributor", () => {
  const result = evaluateSourceAcceptanceReviewer(validInput());
  assert.equal(result.classification, "authorized-independent-reviewer");
  if (result.classification !== "authorized-independent-reviewer") return;
  assert.deepEqual(result.evidence, {
    repository: REPOSITORY,
    sourceIssue: 902,
    integrationPullRequest: { number: 1200, headSha: HEAD_SHA },
    reviewer: { providerHost: "github.com", userId: "99" },
    policy: {
      generation: 7,
      provenance: currentPolicy().provenance,
    },
  });
  assert.equal("criteria" in result.evidence, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.evidence.policy.provenance.source), true);
});

test("rejects a missing, malformed, stale-generation, or cross-repository policy snapshot", () => {
  const input = validInput();
  expectDenied({ ...input, currentPolicy: undefined }, "POLICY_INVALID");
  expectDenied(
    {
      ...input,
      currentPolicy: { ...input.currentPolicy, policy: { ...input.currentPolicy.policy, reviewerUserIds: ["0"] } },
    },
    "POLICY_INVALID",
  );
  expectDenied(
    {
      ...input,
      currentPolicy: { ...input.currentPolicy, provenance: { ...input.currentPolicy.provenance, generation: 8 } },
    },
    "POLICY_INVALID",
  );
  expectDenied(
    { ...input, currentPolicy: currentPolicy({ host: "github.com", id: "7" }) },
    "POLICY_REPOSITORY_MISMATCH",
  );
});

test("requires a provider-proven human reviewer on the policy's provider and in its current allowlist", () => {
  const input = validInput();
  expectDenied({ ...input, reviewer: bot() }, "REVIEWER_IDENTITY_UNAVAILABLE");
  expectDenied(
    { ...input, reviewer: { classification: "unknown", providerHost: "github.com" } },
    "REVIEWER_IDENTITY_UNAVAILABLE",
  );
  expectDenied(
    { ...input, reviewer: { ...human("99"), providerHost: "github.enterprise" } },
    "REVIEWER_IDENTITY_UNAVAILABLE",
  );
  expectDenied({ ...input, currentPolicy: currentPolicy(REPOSITORY, ["98"]) }, "REVIEWER_NOT_AUTHORIZED");
});

test("excludes the Source requester and integration PR author and fails closed when either is unresolved", () => {
  const input = validInput();
  expectDenied(
    { ...input, sourceRequester: { repository: REPOSITORY, sourceIssue: 902, author: human("99") } },
    "REVIEWER_NOT_INDEPENDENT",
  );
  expectDenied(
    {
      ...input,
      integrationPullRequestAuthor: {
        repository: REPOSITORY,
        pullRequest: { number: 1200, headSha: HEAD_SHA },
        author: human("99"),
      },
    },
    "REVIEWER_NOT_INDEPENDENT",
  );
  expectDenied(
    {
      ...input,
      sourceRequester: {
        repository: REPOSITORY,
        sourceIssue: 902,
        author: { classification: "unknown", providerHost: "github.com" },
      },
    },
    "REQUESTER_IDENTITY_UNAVAILABLE",
  );
  expectDenied(
    {
      ...input,
      integrationPullRequestAuthor: {
        repository: REPOSITORY,
        pullRequest: { number: 1200, headSha: HEAD_SHA },
        author: { classification: "unknown", providerHost: "github.com" },
      },
    },
    "PULL_REQUEST_AUTHOR_IDENTITY_UNAVAILABLE",
  );
  assert.equal(
    evaluateSourceAcceptanceReviewer({
      ...input,
      sourceRequester: { repository: REPOSITORY, sourceIssue: 902, author: bot() },
      integrationPullRequestAuthor: {
        repository: REPOSITORY,
        pullRequest: { number: 1200, headSha: HEAD_SHA },
        author: bot(),
      },
    }).classification,
    "authorized-independent-reviewer",
  );
  expectDenied(
    { ...input, sourceRequester: { repository: REPOSITORY, sourceIssue: 903, author: human("10") } },
    "REQUESTER_EVIDENCE_MISMATCH",
  );
  expectDenied(
    {
      ...input,
      integrationPullRequestAuthor: {
        repository: REPOSITORY,
        pullRequest: { number: 1200, headSha: "f".repeat(40) },
        author: human("20"),
      },
    },
    "PULL_REQUEST_AUTHOR_EVIDENCE_MISMATCH",
  );
});

test("excludes every human commit author and provider-resolved human co-author", () => {
  const input = validInput();
  const authorConflict = {
    ...input,
    contributors: { ...input.contributors, commits: [commit(HEAD_SHA, human("99"))] },
  };
  expectDenied(authorConflict, "REVIEWER_NOT_INDEPENDENT");

  const coAuthorConflict = {
    ...input,
    contributors: {
      ...input.contributors,
      commits: [{ ...commit(HEAD_SHA), coAuthors: { resolution: "complete" as const, actors: [human("99")] } }],
    },
  };
  expectDenied(coAuthorConflict, "REVIEWER_NOT_INDEPENDENT");
});

test("known bot authors/co-authors are not contributors and the committer is deliberately excluded", () => {
  const input = validInput();
  const result = evaluateSourceAcceptanceReviewer({
    ...input,
    contributors: {
      ...input.contributors,
      commits: [
        {
          ...commit(HEAD_SHA, bot()),
          coAuthors: { resolution: "complete", actors: [bot()] },
          committer: human("99"),
        },
      ],
    },
  });
  assert.equal(result.classification, "authorized-independent-reviewer");
});

test("fails closed for unresolved authors/co-authors and incomplete co-author resolution", () => {
  const input = validInput();
  expectDenied(
    {
      ...input,
      contributors: {
        ...input.contributors,
        commits: [commit(HEAD_SHA, { classification: "unknown", providerHost: "github.com" })],
      },
    },
    "CONTRIBUTOR_IDENTITY_UNAVAILABLE",
  );
  expectDenied(
    {
      ...input,
      contributors: {
        ...input.contributors,
        commits: [
          {
            ...commit(HEAD_SHA),
            coAuthors: { resolution: "complete", actors: [{ classification: "unknown", providerHost: "github.com" }] },
          },
        ],
      },
    },
    "CONTRIBUTOR_IDENTITY_UNAVAILABLE",
  );
  expectDenied(
    {
      ...input,
      contributors: {
        ...input.contributors,
        commits: [{ ...commit(HEAD_SHA), coAuthors: { resolution: "unavailable", actors: [] } }],
      },
    },
    "CONTRIBUTOR_EVIDENCE_INCOMPLETE",
  );
});

test("requires complete unique commit pagination bound to the exact repository, PR, and observed head", () => {
  const input = validInput();
  for (const pagination of ["incomplete", "truncated", "unavailable"] as const) {
    expectDenied({ ...input, contributors: { ...input.contributors, pagination } }, "CONTRIBUTOR_EVIDENCE_INCOMPLETE");
  }
  expectDenied(
    { ...input, contributors: { ...input.contributors, repository: { host: "github.com", id: "7" } } },
    "CONTRIBUTOR_EVIDENCE_MISMATCH",
  );
  expectDenied(
    { ...input, contributors: { ...input.contributors, pullRequest: { number: 1201, headSha: HEAD_SHA } } },
    "CONTRIBUTOR_EVIDENCE_MISMATCH",
  );
  expectDenied(
    { ...input, contributors: { ...input.contributors, observedHeadSha: "f".repeat(40) } },
    "CONTRIBUTOR_EVIDENCE_MISMATCH",
  );
  expectDenied({ ...input, contributors: { ...input.contributors, commits: [] } }, "CONTRIBUTOR_EVIDENCE_INCOMPLETE");
  expectDenied(
    { ...input, contributors: { ...input.contributors, commits: [commit(COMMIT_SHA)] } },
    "CONTRIBUTOR_EVIDENCE_MISMATCH",
  );
  expectDenied(
    { ...input, contributors: { ...input.contributors, commits: [commit(HEAD_SHA), commit(HEAD_SHA)] } },
    "CONTRIBUTOR_EVIDENCE_INVALID",
  );
});

test("bounds malformed input to one stable denial and never exposes raw provider details", () => {
  const hostile = Object.defineProperty({}, "currentPolicy", {
    enumerable: true,
    get() {
      throw new Error("sensitive provider failure");
    },
  });
  const result = evaluateSourceAcceptanceReviewer(hostile);
  assert.equal(result.classification, "denied");
  assert.equal(result.diagnostics.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /sensitive provider failure/u);
});
