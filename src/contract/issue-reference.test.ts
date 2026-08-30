import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_ISSUE_DEPENDENCIES,
  normalizeIssueDependencies,
  normalizeIssueReference,
  issueReferenceKey,
  validateIssueDependencies,
  type IssueReference,
} from "./issue-reference.js";

const subject: IssueReference = {
  repositoryHost: "github.com",
  repositoryId: "100000157",
  repository: "yohn-jp/gh-inari",
  number: 157,
};

test("normalizes same-repository and cross-repository references deterministically", () => {
  const result = normalizeIssueDependencies({
    blockedBy: [
      { repositoryHost: "github.com", repositoryId: "100000004", repository: "Other-Org/Other-Repo", number: 4 },
      { repositoryHost: "github.com", repositoryId: "100000157", repository: "yohn-jp/gh-inari", number: 149 },
    ],
    blocks: [{ repositoryHost: "github.com", repositoryId: "200000002", repository: "yohn-jp/portal", number: 2 }],
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.dependencies, {
    blockedBy: [
      { repositoryHost: "github.com", repositoryId: "100000004", repository: "other-org/other-repo", number: 4 },
      { repositoryHost: "github.com", repositoryId: "100000157", repository: "yohn-jp/gh-inari", number: 149 },
    ],
    blocks: [{ repositoryHost: "github.com", repositoryId: "200000002", repository: "yohn-jp/portal", number: 2 }],
  });
});

test("omitted dependency directions project as an empty canonical object", () => {
  assert.deepEqual(validateIssueDependencies(undefined), {
    valid: true,
    dependencies: EMPTY_ISSUE_DEPENDENCIES,
    violations: [],
  });
});

test("rejects ambiguous, duplicate, self, and contradictory references", () => {
  const result = validateIssueDependencies(
    {
      blockedBy: [
        "yohn-jp/gh-inari#157",
        { repositoryHost: "github.com", repositoryId: "100000157", repository: "yohn-jp/gh-inari", number: 149 },
        { repositoryHost: "github.com", repositoryId: "100000157", repository: "yohn-jp/gh-inari", number: 149 },
      ],
      blocks: [
        { repositoryHost: "github.com", repositoryId: "100000157", repository: "yohn-jp/gh-inari", number: 149 },
      ],
    },
    subject,
  );
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.violations.map((violation) => violation.code),
    ["REFERENCE_AMBIGUOUS", "REFERENCE_DUPLICATE", "REFERENCE_CONTRADICTORY"],
  );
});

test("rejects a canonical object that refers to its own Issue", () => {
  const result = validateIssueDependencies(
    {
      blockedBy: [
        { repositoryHost: "github.com", repositoryId: "100000157", repository: "Yohn-Jp/gh-inari", number: 157 },
      ],
    },
    subject,
  );
  assert.equal(result.valid, false);
  assert.deepEqual(result.violations, [
    {
      code: "REFERENCE_SELF",
      path: "$.blockedBy[0]",
      message: "An Issue cannot depend on itself.",
    },
  ]);
});

test("rejects malformed repository and issue identities", () => {
  const result = normalizeIssueReference({ repositoryId: "https://github.com/yohn-jp/gh-inari", number: 0 });
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.violations.map((violation) => violation.code),
    ["REFERENCE_REPOSITORY_HOST_INVALID", "REFERENCE_REPOSITORY_ID_INVALID", "REFERENCE_NUMBER_INVALID"],
  );
});

test("rejects owner/name-only references because the locator is not a stable identity", () => {
  const result = normalizeIssueReference({ repository: "yohn-jp/gh-inari", number: 157 });
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.violations.map((violation) => violation.code),
    ["REFERENCE_REPOSITORY_HOST_INVALID", "REFERENCE_REPOSITORY_ID_INVALID"],
  );
});

test("aliases expose the same canonical normalization", () => {
  assert.deepEqual(
    normalizeIssueDependencies({
      blocks: [{ repositoryHost: "github.com", repositoryId: "200000002", repository: "Yohn-Jp/Portal", number: 3 }],
    }),
    validateIssueDependencies({
      blocks: [{ repositoryHost: "github.com", repositoryId: "200000002", repository: "Yohn-Jp/Portal", number: 3 }],
    }),
  );
});

test("repository rename or transfer changes only the locator, never the identity key", () => {
  const before = normalizeIssueReference({
    repositoryHost: "github.com",
    repositoryId: "100000157",
    repository: "old-owner/old-name",
    number: 157,
  });
  const after = normalizeIssueReference({
    repositoryHost: "github.com",
    repositoryId: "100000157",
    repository: "new-owner/new-name",
    number: 157,
  });
  assert.equal(before.valid, true);
  assert.equal(after.valid, true);
  assert.equal(
    issueReferenceKey(before.reference as IssueReference),
    issueReferenceKey(after.reference as IssueReference),
  );
  assert.equal(after.reference?.repository, "new-owner/new-name");
});

test("the same numeric ID on another GitHub host is a different repository identity", () => {
  const publicHost = normalizeIssueReference({
    repositoryHost: "github.com",
    repositoryId: "100000157",
    repository: "yohn-jp/gh-inari",
    number: 157,
  });
  const enterpriseHost = normalizeIssueReference({
    repositoryHost: "ghe.example.com",
    repositoryId: "100000157",
    repository: "yohn-jp/gh-inari",
    number: 157,
  });
  assert.equal(publicHost.valid, true);
  assert.equal(enterpriseHost.valid, true);
  assert.notEqual(
    issueReferenceKey(publicHost.reference as IssueReference),
    issueReferenceKey(enterpriseHost.reference as IssueReference),
  );
});

test("legacy opaque IDs are rejected instead of being silently equated", () => {
  const legacy = normalizeIssueReference({
    repositoryHost: "github.com",
    repositoryId: "MDEwOlJlcG9zaXRvcnkx",
    repository: "yohn-jp/gh-inari",
    number: 157,
  });
  const current = normalizeIssueReference({
    repositoryHost: "github.com",
    repositoryId: "100000157",
    repository: "yohn-jp/gh-inari",
    number: 157,
  });
  assert.equal(legacy.valid, false);
  assert.equal(current.valid, true);
  assert.equal(legacy.violations[0]?.code, "REFERENCE_REPOSITORY_ID_INVALID");
});
