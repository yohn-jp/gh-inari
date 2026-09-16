import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMPLEMENTATION_CONTRACT_VERSION,
  IMPLEMENTATION_KIND,
  renderImplementationIssueBody,
  parseImplementationContract,
} from "./implementation-contract.js";
import { authorizeImplementation, type ImplementationAuthorizationRecord } from "./implementation-authorization.js";
import {
  IMPLEMENTATION_CONFORMANCE_KIND,
  IMPLEMENTATION_CONFORMANCE_VERSION,
  tryVerifyImplementationConformance,
  type ImplementationConformanceInput,
} from "./implementation-conformance.js";
import type {
  GitHubOperationalChangedFile,
  GitHubOperationalCollection,
  GitHubOperationalPullRequestEvidence,
} from "./github/types.js";

const repository = {
  repositoryHost: "github.com",
  repositoryId: "100",
  repository: "acme/inari",
} as const;
const implementation = { ...repository, number: 575 } as const;
const base = { branch: "main", revision: "base-revision", freshness: "base-revision" } as const;

function contract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository,
    sources: [{ ...repository, number: 568 }],
    objective: "Verify one exact authorized Implementation.",
    nonGoals: ["Automatic merge"],
    architecture: {
      decision: "Keep conformance in Core.",
      affectedComponents: ["Implementation Core"],
      invariants: ["DENY overrides every allowlist."],
      compatibilityConstraints: [],
    },
    scope: {
      readOnly: ["src/**"],
      write: ["src/**"],
      create: ["docs/**"],
      delete: ["tmp/**"],
      deny: ["src/private/**"],
    },
    constraints: {
      prohibitedOperations: ["Do not infer CREATE or DELETE from WRITE."],
      immutableAreas: ["The authorized body"],
      prerequisites: ["The PR is bound to the execution branch."],
    },
    verification: {
      acceptanceCriteria: ["Every changed path is checked."],
      targetedTests: [],
      requiredChecks: ["verify"],
      postconditions: ["The result is deterministic."],
    },
    execution: {
      baseBranch: base.branch,
      baseRevision: base.revision,
      baseFreshness: base.freshness,
      branch: "feat/575-implementation-pr-conformance",
      dependencies: [{ ...repository, number: 568 }],
    },
    ...overrides,
  };
}

const body = renderImplementationIssueBody(parseImplementationContract(contract()));

function authorization(): ImplementationAuthorizationRecord {
  return authorizeImplementation({ implementation, body, repository, base });
}

function collection<T>(items: readonly T[]): GitHubOperationalCollection<T> {
  return {
    status: "available",
    items,
    pagination: { perPage: 100, pages: 1, returned: items.length, truncated: false },
    diagnostics: [],
  };
}

function pullRequest(
  overrides: Partial<GitHubOperationalPullRequestEvidence> = {},
): GitHubOperationalPullRequestEvidence {
  return {
    repository: { host: "github.com", nameWithOwner: "acme/inari", repositoryId: "100" },
    number: 900,
    title: "Implementation conformance",
    body: "provider-secret-body-must-not-be-output",
    state: "open",
    author: null,
    head: { ref: "feat/575-implementation-pr-conformance", sha: "head-revision" },
    base: { ref: "main", sha: "base-revision" },
    draft: false,
    labels: [],
    assignees: [],
    url: "https://provider.invalid/pr/secret-url",
    checks: collection([
      {
        id: "check-1",
        name: "verify",
        kind: "check-run",
        status: "completed",
        conclusion: "success",
        description: "provider-secret-description-must-not-be-output",
        url: "https://provider.invalid/check/secret-url",
      },
    ]),
    reviews: collection([]),
    comments: collection([]),
    inlineReviewComments: collection([]),
    changedFiles: collection([]),
    provenance: { provider: "github", endpoints: ["pulls/900", "provider-secret-endpoint"] },
    ...overrides,
  };
}

function input(
  record: ImplementationAuthorizationRecord = authorization(),
  bodyValue = body,
  pr = pullRequest(),
): ImplementationConformanceInput {
  return {
    authorization: record,
    issue: { reference: implementation, body: bodyValue },
    repository,
    base,
    pullRequestNumber: pr.number,
    pullRequest: pr,
  };
}

function changedFile(filename: string, status: string, previousFilename?: string): GitHubOperationalChangedFile {
  return { filename, status, ...(previousFilename === undefined ? {} : { previousFilename }) };
}

test("successful conformance is deterministic and evaluates WRITE, CREATE, and DELETE independently", () => {
  const first = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({
        changedFiles: collection([
          changedFile("tmp/old.txt", "removed"),
          changedFile("docs/new.md", "added"),
          changedFile("src/changed.ts", "modified"),
        ]),
      }),
    ),
  );
  const second = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({
        changedFiles: collection([
          changedFile("src/changed.ts", "modified"),
          changedFile("docs/new.md", "added"),
          changedFile("tmp/old.txt", "removed"),
        ]),
      }),
    ),
  );
  assert.equal(first.status, "conformant");
  assert.equal(first.valid, true);
  assert.equal(first.version, IMPLEMENTATION_CONFORMANCE_VERSION);
  assert.equal(first.kind, IMPLEMENTATION_CONFORMANCE_KIND);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.changes.map(({ operation, path }) => ({ operation, path })),
    [
      { operation: "CREATE", path: "docs/new.md" },
      { operation: "WRITE", path: "src/changed.ts" },
      { operation: "DELETE", path: "tmp/old.txt" },
    ],
  );
});

test("modified, created, and deleted paths each require their corresponding authority class", () => {
  for (const [status, filename] of [
    ["modified", "outside/changed.ts"],
    ["added", "src/new.ts"],
    ["removed", "src/old.ts"],
  ] as const) {
    const result = tryVerifyImplementationConformance(
      input(authorization(), body, pullRequest({ changedFiles: collection([changedFile(filename, status)]) })),
    );
    assert.equal(result.status, "scope-violation", status);
    assert.equal(result.changes[0]?.allowed, false, status);
    assert.equal(
      result.changes[0]?.operation,
      status === "modified" ? "WRITE" : status === "added" ? "CREATE" : "DELETE",
    );
  }
});

test("DENY overrides a broader WRITE allowlist", () => {
  const result = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({ changedFiles: collection([changedFile("src/private/key.ts", "modified")]) }),
    ),
  );
  assert.equal(result.status, "scope-violation");
  assert.equal(result.changes[0]?.allowed, false);
  assert.equal(result.changes[0]?.denied, true);
  assert.ok(result.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_CONFORMANCE_DENIED_PATH"));
});

test("body drift makes the authorization stale and prevents diff decisions", () => {
  const changedBody = renderImplementationIssueBody(
    parseImplementationContract(contract({ objective: "A different authorized objective." })),
  );
  const result = tryVerifyImplementationConformance(
    input(
      authorization(),
      changedBody,
      pullRequest({ changedFiles: collection([changedFile("outside.ts", "modified")]) }),
    ),
  );
  assert.equal(result.status, "stale-invalid-authorization");
  assert.equal(result.changes.length, 0);
  assert.ok(result.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_MODIFIED_AFTER_AUTHORIZATION"));
});

test("tampered authorization binding is stale even when caller evidence matches the tampered record", () => {
  const tampered = {
    ...authorization(),
    base: { branch: "other-base", revision: "other-revision", freshness: "other-freshness" },
  };
  const result = tryVerifyImplementationConformance({
    ...input(tampered, body, pullRequest({ base: { ref: "other-base", sha: "other-revision" } })),
    base: tampered.base,
  });
  assert.equal(result.status, "stale-invalid-authorization");
  assert.ok(result.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_AUTHORIZATION_BINDING_DRIFT"));
});

test("missing complete check evidence is missing-verification, while unavailable evidence is unverifiable", () => {
  const missing = tryVerifyImplementationConformance(
    input(authorization(), body, pullRequest({ checks: collection([]) })),
  );
  assert.equal(missing.status, "missing-verification");
  assert.ok(missing.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_CONFORMANCE_CHECK_MISSING"));

  const unavailable = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({
        checks: {
          status: "unavailable",
          items: [],
          pagination: { perPage: 100, pages: 0, returned: 0, truncated: false },
          diagnostics: [{ code: "provider-secret", path: "provider-secret", message: "provider-secret" }],
        },
      }),
    ),
  );
  assert.equal(unavailable.status, "unverifiable");
  assert.ok(
    unavailable.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_CONFORMANCE_VERIFICATION_UNAVAILABLE"),
  );
});

test("repository, base, branch, and head identity mismatches fail closed", () => {
  const pullRequestMismatch = tryVerifyImplementationConformance({
    ...input(),
    pullRequestNumber: 901,
  });
  assert.equal(pullRequestMismatch.status, "unverifiable");
  assert.equal(pullRequestMismatch.binding?.pullRequest, "mismatch");

  const repositoryMismatch = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({ repository: { host: "github.com", nameWithOwner: "other/repo", repositoryId: "101" } }),
    ),
  );
  assert.equal(repositoryMismatch.status, "unverifiable");
  assert.equal(repositoryMismatch.binding?.repository, "mismatch");

  const branchMismatch = tryVerifyImplementationConformance(
    input(authorization(), body, pullRequest({ head: { ref: "other-branch", sha: "head-revision" } })),
  );
  assert.equal(branchMismatch.status, "unverifiable");
  assert.equal(branchMismatch.binding?.branch, "mismatch");

  const baseMismatch = tryVerifyImplementationConformance(
    input(authorization(), body, pullRequest({ base: { ref: "main", sha: "other-base" } })),
  );
  assert.equal(baseMismatch.status, "unverifiable");
  assert.equal(baseMismatch.binding?.base, "mismatch");
});

test("rename evidence is normalized into independent DELETE and CREATE decisions", () => {
  const result = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({
        changedFiles: collection([changedFile("docs/new.md", "renamed", "tmp/old.txt")]),
      }),
    ),
  );
  assert.equal(result.status, "conformant");
  assert.deepEqual(
    result.changes.map(({ operation, path }) => ({ operation, path })),
    [
      { operation: "CREATE", path: "docs/new.md" },
      { operation: "DELETE", path: "tmp/old.txt" },
    ],
  );
});

test("conformance output contains only the safe semantic projection", () => {
  const result = tryVerifyImplementationConformance(input());
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("provider-secret-body"), false);
  assert.equal(serialized.includes("provider-secret-description"), false);
  assert.equal(serialized.includes("provider-secret-url"), false);
  assert.equal(serialized.includes("provider-secret-endpoint"), false);
  assert.equal(serialized.includes("provider-secret"), false);
  assert.equal(Object.isFrozen(result), true);
});

test("a targeted test is never satisfied by a same-named or successful CI check", () => {
  const testBody = renderImplementationIssueBody(
    parseImplementationContract(
      contract({
        verification: {
          acceptanceCriteria: ["Every changed path is checked."],
          targetedTests: ["pnpm test -- src/foo.test.ts"],
          requiredChecks: ["verify"],
          postconditions: ["The result is deterministic."],
        },
      }),
    ),
  );
  const result = tryVerifyImplementationConformance(
    input(
      authorizeImplementation({ implementation, body: testBody, repository, base }),
      testBody,
      pullRequest({
        checks: collection([
          {
            id: "check-1",
            name: "verify",
            kind: "check-run",
            status: "completed",
            conclusion: "success",
          },
          {
            // A CI check that happens to share its name with the targeted-test
            // command must not be treated as test-execution evidence.
            id: "check-2",
            name: "pnpm test -- src/foo.test.ts",
            kind: "check-run",
            status: "completed",
            conclusion: "success",
          },
        ]),
      }),
    ),
  );
  assert.equal(result.status, "unverifiable");
  assert.deepEqual(result.verification.requiredTests, ["pnpm test -- src/foo.test.ts"]);
  assert.deepEqual(result.verification.unverifiableTests, ["pnpm test -- src/foo.test.ts"]);
  assert.deepEqual(result.verification.satisfiedTests, []);
  assert.deepEqual(result.verification.satisfiedChecks, ["verify"]);
  assert.ok(result.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_CONFORMANCE_TEST_UNVERIFIABLE"));
});

test("a compatibility-equivalent but byte-distinct changed path cannot inherit authority from an allowed path", () => {
  // U+FF41 FULLWIDTH LATIN SMALL LETTER A NFKC-normalizes to ASCII "a", so
  // this filename is byte-distinct from the authorized "src/allowed.ts" yet
  // would collapse onto it under NFKC normalization.
  const fullWidthPath = "src/ａllowed.ts";
  const result = tryVerifyImplementationConformance(
    input(authorization(), body, pullRequest({ changedFiles: collection([changedFile(fullWidthPath, "modified")]) })),
  );
  assert.equal(result.status, "unverifiable");
  assert.deepEqual(result.changes, []);
  assert.ok(result.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_CONFORMANCE_PATH_INVALID"));
});
