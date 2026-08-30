import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_ISSUE_DEPENDENCIES,
  normalizeIssueDependencies,
  normalizeIssueReference,
  validateIssueDependencies,
  type IssueReference,
} from "./issue-reference.js";

const subject: IssueReference = { repository: "yohn-jp/gh-inari", number: 157 };

test("normalizes same-repository and cross-repository references deterministically", () => {
  const result = normalizeIssueDependencies({
    blockedBy: [
      { repository: "Other-Org/Other-Repo", number: 4 },
      { repository: "yohn-jp/gh-inari", number: 149 },
    ],
    blocks: [{ repository: "yohn-jp/portal", number: 2 }],
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.dependencies, {
    blockedBy: [
      { repository: "other-org/other-repo", number: 4 },
      { repository: "yohn-jp/gh-inari", number: 149 },
    ],
    blocks: [{ repository: "yohn-jp/portal", number: 2 }],
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
        { repository: "yohn-jp/gh-inari", number: 149 },
        { repository: "yohn-jp/gh-inari", number: 149 },
      ],
      blocks: [{ repository: "yohn-jp/gh-inari", number: 149 }],
    },
    subject,
  );
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.violations.map((violation) => violation.code),
    ["REFERENCE_AMBIGUOUS", "REFERENCE_DUPLICATE", "REFERENCE_CONTRADICTORY"],
  );
});

test("rejects malformed repository and issue identities", () => {
  const result = normalizeIssueReference({ repository: "https://github.com/yohn-jp/gh-inari", number: 0 });
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.violations.map((violation) => violation.code),
    ["REFERENCE_AMBIGUOUS", "REFERENCE_NUMBER_INVALID"],
  );
});

test("aliases expose the same canonical normalization", () => {
  assert.deepEqual(
    normalizeIssueDependencies({ blocks: [{ repository: "Yohn-Jp/Portal", number: 3 }] }),
    validateIssueDependencies({ blocks: [{ repository: "Yohn-Jp/Portal", number: 3 }] }),
  );
});
