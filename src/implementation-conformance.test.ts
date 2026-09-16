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
  GitHubOperationalCheck,
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
        identity: { context: "verify", producer: "app:trusted" },
        status: "completed",
        conclusion: "success",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:01Z",
        current: true,
        description: "provider-secret-description-must-not-be-output",
        url: "https://provider.invalid/check/secret-url",
      },
    ]),
    requiredCheckBindings: collection([{ context: "verify", producer: "app:trusted" }]),
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

function check(id: string, overrides: Partial<GitHubOperationalCheck> = {}): GitHubOperationalCheck {
  return {
    id,
    name: "verify",
    kind: "check-run",
    identity: { context: "verify", producer: "app:trusted" },
    status: "completed",
    conclusion: "success",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
    current: true,
    ...overrides,
  };
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

// Mandatory regression E: a rerun within the authoritative producer group
// resolves to the current (latest) execution.
test("fail-to-success reruns select the current execution for one producer", () => {
  const result = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({
        checks: collection([
          check("old", {
            conclusion: "failure",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:01Z",
            current: false,
          }),
          check("new", {
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:01Z",
          }),
        ]),
      }),
    ),
  );
  assert.equal(result.status, "conformant");
  assert.deepEqual(result.verification.satisfiedChecks, ["verify"]);
  assert.deepEqual(result.verification.failedChecks, []);
});

// Mandatory regression F: the same rerun selection applies symmetrically to
// a success-to-failure transition.
test("success-to-failure reruns select the current failure", () => {
  const result = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({
        checks: collection([
          check("old", {
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:01Z",
            current: false,
          }),
          check("new", {
            conclusion: "failure",
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:01Z",
          }),
        ]),
      }),
    ),
  );
  assert.equal(result.status, "missing-verification");
  assert.deepEqual(result.verification.failedChecks, ["verify"]);
  assert.deepEqual(result.verification.satisfiedChecks, []);
});

test("a same-named check from another producer cannot satisfy, replace, or poison the authoritative result", () => {
  const result = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({
        checks: collection([
          check("trusted", { conclusion: "failure" }),
          check("spoof", { identity: { context: "verify", producer: "app:spoof" } }),
        ]),
      }),
    ),
  );
  // The spoofed producer is excluded from selection entirely rather than
  // creating ambiguity: the authoritative "trusted" producer's own failure
  // is the result, not an indeterminate one.
  assert.equal(result.status, "missing-verification");
  assert.deepEqual(result.verification.failedChecks, ["verify"]);
  assert.deepEqual(result.verification.unverifiableChecks, []);
  assert.deepEqual(result.verification.satisfiedChecks, []);
});

// Mandatory regression A: a required check with no authoritative expected
// producer bound to it can never be satisfied by the sole observed check
// that happens to share its name, even when no other candidate exists.
test("regression A: a lone observed check from an unexpected producer is never satisfied", () => {
  const result = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({
        checks: collection([check("spoof-only", { identity: { context: "verify", producer: "app:999" } })]),
        requiredCheckBindings: collection([{ context: "verify", producer: "app:101" }]),
      }),
    ),
  );
  assert.equal(result.status, "unverifiable");
  assert.deepEqual(result.verification.unverifiableChecks, ["verify"]);
  assert.deepEqual(result.verification.satisfiedChecks, []);
});

// Mandatory regression B: the authoritative producer's result is selected
// even in the presence of a same-name spoofed producer.
test("regression B: the authoritative producer is selected despite a spoofed same-name check", () => {
  const result = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({
        checks: collection([
          check("authoritative", { identity: { context: "verify", producer: "app:101" } }),
          check("spoof", { identity: { context: "verify", producer: "app:999" } }),
        ]),
        requiredCheckBindings: collection([{ context: "verify", producer: "app:101" }]),
      }),
    ),
  );
  assert.equal(result.status, "conformant");
  assert.deepEqual(result.verification.satisfiedChecks, ["verify"]);
});

// Mandatory regression C: an observed same-name success with no producer
// identity at all cannot satisfy an authoritative expected binding.
test("regression C: a same-name check without producer identity cannot satisfy an authoritative binding", () => {
  const result = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({
        checks: collection([check("unidentified", { identity: { context: "verify" } })]),
        requiredCheckBindings: collection([{ context: "verify", producer: "app:101" }]),
      }),
    ),
  );
  assert.equal(result.status, "unverifiable");
  assert.deepEqual(result.verification.unverifiableChecks, ["verify"]);
  assert.deepEqual(result.verification.satisfiedChecks, []);
});

// Mandatory regression D: this is the exact defect from #643 — with no
// authoritative expected producer binding at all, a single observed
// successful same-name check must not be treated as authoritative merely
// because it is the only match.
test("regression D: no authoritative binding means a lone observed success is still unverifiable", () => {
  const result = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({
        checks: collection([check("only-match")]),
        requiredCheckBindings: collection([]),
      }),
    ),
  );
  assert.equal(result.status, "unverifiable");
  assert.deepEqual(result.verification.unverifiableChecks, ["verify"]);
  assert.deepEqual(result.verification.satisfiedChecks, []);
});

test("duplicate current executions fail closed instead of using collection order", () => {
  const result = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({
        checks: collection([check("current-a"), check("current-b", { conclusion: "failure" })]),
      }),
    ),
  );
  assert.equal(result.status, "unverifiable");
  assert.deepEqual(result.verification.unverifiableChecks, ["verify"]);
});

test("a same-name check without producer identity is excluded, not ambiguous, alongside an authoritative one", () => {
  const result = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({
        checks: collection([check("identified"), check("unidentified", { identity: { context: "verify" } })]),
      }),
    ),
  );
  assert.equal(result.status, "conformant");
  assert.deepEqual(result.verification.satisfiedChecks, ["verify"]);
});

test("Check Run precedence is explicit when a commit status collides with its context", () => {
  const result = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({
        checks: collection([
          check("check-run", { conclusion: "failure" }),
          {
            id: "status",
            name: "verify",
            kind: "status",
            identity: { context: "verify", producer: "creator:7" },
            status: "success",
            current: true,
          },
        ]),
      }),
    ),
  );
  assert.equal(result.status, "missing-verification");
  assert.deepEqual(result.verification.failedChecks, ["verify"]);
  assert.deepEqual(result.verification.satisfiedChecks, []);
});

// Mandatory regression G: an app-bound Check Run requirement cannot be
// satisfied or overridden by a same-context legacy status from an unrelated
// creator, even when the Check Run itself is otherwise absent from the
// authoritative producer group.
test("regression G: a same-context legacy status from an unrelated creator cannot satisfy an app-bound requirement", () => {
  const result = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({
        checks: collection([
          {
            id: "status",
            name: "verify",
            kind: "status",
            identity: { context: "verify", producer: "creator:7" },
            status: "success",
            current: true,
          },
        ]),
        requiredCheckBindings: collection([{ context: "verify", producer: "app:trusted" }]),
      }),
    ),
  );
  assert.equal(result.status, "unverifiable");
  assert.deepEqual(result.verification.unverifiableChecks, ["verify"]);
  assert.deepEqual(result.verification.satisfiedChecks, []);
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
            identity: { context: "verify", producer: "app:trusted" },
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

test("provider paths retain exact identity and unsafe forms produce no scope decision", () => {
  const cases = [
    { path: "src\\changed.ts", status: "scope-violation" as const },
    { path: " src/changed.ts", status: "unverifiable" as const },
    { path: "src/changed.ts ", status: "unverifiable" as const },
    { path: "src//changed.ts", status: "unverifiable" as const },
    { path: "./src/changed.ts", status: "unverifiable" as const },
    { path: "src/ｃhanged.ts", status: "unverifiable" as const },
    { path: "src/../changed.ts", status: "unverifiable" as const },
    { path: "/src/changed.ts", status: "unverifiable" as const },
    { path: "src/changed.ts", status: "conformant" as const },
  ];

  for (const { path, status } of cases) {
    const result = tryVerifyImplementationConformance(
      input(authorization(), body, pullRequest({ changedFiles: collection([changedFile(path, "modified")]) })),
    );
    assert.equal(result.status, status, path);
    if (status === "unverifiable") {
      assert.deepEqual(result.changes, [], path);
      assert.ok(
        result.diagnostics.some(
          (entry) => entry.code === "IMPLEMENTATION_CONFORMANCE_PATH_INVALID" && entry.path.endsWith(".filename"),
        ),
        path,
      );
    } else {
      assert.equal(result.changes[0]?.path, path);
      assert.equal(result.changes[0]?.allowed, status === "conformant", path);
      assert.equal(
        result.diagnostics.some((entry) => entry.code === "IMPLEMENTATION_CONFORMANCE_PATH_INVALID"),
        false,
        path,
      );
    }
  }
});

test("rename old DELETE and new CREATE identities are evaluated independently", () => {
  const oldIdentity = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({ changedFiles: collection([changedFile("docs/new.md", "renamed", "tmp\\old.txt")]) }),
    ),
  );
  assert.equal(oldIdentity.status, "scope-violation");
  assert.deepEqual(
    oldIdentity.changes.map(({ operation, path, allowed }) => ({ operation, path, allowed })),
    [
      { operation: "CREATE", path: "docs/new.md", allowed: true },
      { operation: "DELETE", path: "tmp\\old.txt", allowed: false },
    ],
  );

  const newIdentity = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({ changedFiles: collection([changedFile("docs\\new.md", "renamed", "tmp/old.txt")]) }),
    ),
  );
  assert.equal(newIdentity.status, "scope-violation");
  assert.deepEqual(
    newIdentity.changes.map(({ operation, path, allowed }) => ({ operation, path, allowed })),
    [
      { operation: "CREATE", path: "docs\\new.md", allowed: false },
      { operation: "DELETE", path: "tmp/old.txt", allowed: true },
    ],
  );

  const invalidOldIdentity = tryVerifyImplementationConformance(
    input(
      authorization(),
      body,
      pullRequest({ changedFiles: collection([changedFile("docs/new.md", "renamed", "tmp//old.txt")]) }),
    ),
  );
  assert.equal(invalidOldIdentity.status, "unverifiable");
  assert.deepEqual(invalidOldIdentity.changes, []);
  assert.ok(
    invalidOldIdentity.diagnostics.some(
      (entry) => entry.code === "IMPLEMENTATION_CONFORMANCE_PATH_INVALID" && entry.path.endsWith(".previousFilename"),
    ),
  );
});
