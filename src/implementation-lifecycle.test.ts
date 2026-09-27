import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueReference } from "./contract/issue-reference.js";
import {
  IMPLEMENTATION_CONTRACT_VERSION,
  IMPLEMENTATION_KIND,
  parseImplementationContract,
  renderImplementationIssueBody,
} from "./implementation-contract.js";
import { authorizeImplementation, type ImplementationAuthorizationRecord } from "./implementation-authorization.js";
import {
  IMPLEMENTATION_EXECUTION_EVIDENCE_KIND,
  IMPLEMENTATION_EXECUTION_EVIDENCE_VERSION,
} from "./implementation-execution-evidence.js";
import { tryProjectImplementationLifecycle } from "./implementation-lifecycle.js";
import {
  IMPLEMENTATION_TASK_TERMINATION_KIND,
  IMPLEMENTATION_TASK_TERMINATION_VERSION,
} from "./implementation-task-termination.js";

const repository = {
  repositoryHost: "github.com",
  repositoryId: "686",
  repository: "acme/inari",
} as const;
const implementation = { ...repository, number: 686 } as const;
const source = { ...repository, number: 678 } as const;
const base = { branch: "main", revision: "base-revision", freshness: "base-freshness" } as const;
const branch = "feat/686-implementation-terminal-evidence";

function contract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository,
    sources: [source],
    objective: "Derive terminal Implementation state from evidence.",
    nonGoals: ["Change merge"],
    architecture: {
      decision: "Compose existing evidence boundaries.",
      affectedComponents: ["Implementation lifecycle"],
      invariants: ["Completion is never caller asserted."],
      compatibilityConstraints: [],
    },
    scope: {
      readOnly: ["src/**"],
      write: ["src/**"],
      create: [],
      delete: [],
      deny: ["src/private/**"],
    },
    constraints: {
      prohibitedOperations: ["Do not equate merge with completion."],
      immutableAreas: ["Authorization identity"],
      prerequisites: ["Current evidence is reread."],
    },
    verification: {
      acceptanceCriteria: ["Terminal state is evidence-derived."],
      targetedTests: [],
      requiredChecks: ["verify"],
      postconditions: ["Historical authorization remains inspectable."],
    },
    execution: {
      baseBranch: base.branch,
      baseRevision: base.revision,
      baseFreshness: base.freshness,
      branch,
      dependencies: [source],
    },
    ...overrides,
  };
}

const body = renderImplementationIssueBody(parseImplementationContract(contract()));

function authorization(target: IssueReference = implementation): ImplementationAuthorizationRecord {
  return authorizeImplementation({
    implementation: target,
    body,
    repository,
    base,
    readiness: {
      evidence: [
        {
          reference: source,
          authority: "implementation-conformance",
          status: "satisfied",
          freshness: "current",
          dependencies: [],
        },
      ],
    },
  });
}

function collection(items: readonly unknown[]): Record<string, unknown> {
  return {
    status: "available",
    items,
    pagination: { perPage: 100, pages: 1, returned: items.length, truncated: false },
    diagnostics: [],
  };
}

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repository: { host: "github.com", nameWithOwner: "acme/inari", repositoryId: "686" },
    number: 9686,
    title: "Implementation terminal evidence",
    body: "not lifecycle authority",
    state: "open",
    author: null,
    head: { ref: branch, sha: "head-revision" },
    base: { ref: "main", sha: "base-revision" },
    draft: false,
    labels: [],
    assignees: [],
    url: "https://provider.invalid/pull/9686",
    checks: collection([
      {
        id: "verify",
        name: "verify",
        kind: "check-run",
        identity: { context: "verify", producer: "app:trusted" },
        status: "completed",
        conclusion: "success",
        current: true,
      },
    ]),
    requiredCheckBindings: collection([{ context: "verify", producer: "app:trusted" }]),
    reviews: collection([]),
    comments: collection([]),
    inlineReviewComments: collection([]),
    changedFiles: collection([{ filename: "src/implementation-lifecycle.ts", status: "modified" }]),
    provenance: { provider: "github", endpoints: ["pulls/9686"] },
    ...overrides,
  };
}

function executionEvidence(record: ImplementationAuthorizationRecord, overrides: Record<string, unknown> = {}) {
  return {
    version: IMPLEMENTATION_EXECUTION_EVIDENCE_VERSION,
    kind: IMPLEMENTATION_EXECUTION_EVIDENCE_KIND,
    implementation: record.implementation,
    repository: record.repository,
    governedBodyDigest: record.governedBodyDigest,
    base: record.base,
    branch,
    headRevision: "head-revision",
    targetedTests: [],
    ...overrides,
  };
}

function taskTerminationRecord(
  record: ImplementationAuthorizationRecord,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: IMPLEMENTATION_TASK_TERMINATION_VERSION,
    kind: IMPLEMENTATION_TASK_TERMINATION_KIND,
    repository: record.repository,
    implementation: record.implementation,
    authorizationDigest: record.governedBodyDigest,
    base: record.base,
    ...overrides,
  };
}

function taskTerminationRead(
  record: ImplementationAuthorizationRecord,
  terminationOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: "authoritative",
    provenance: { source: "lifecycle-test" },
    records: [
      {
        record: taskTerminationRecord(record, terminationOverrides),
        provenance: { source: "lifecycle-test-record" },
      },
    ],
  };
}

function lifecycleInput(record = authorization(), overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    authorization: record,
    issue: { reference: implementation, body },
    repository,
    base,
    pullRequestNumber: 9686,
    pullRequest: pullRequest(),
    executionEvidence: executionEvidence(record),
    ...overrides,
  };
}

function abortedChangeIdentity(record: ImplementationAuthorizationRecord): Record<string, unknown> {
  return {
    contract: contract(),
    implementation,
    authorization: record,
    change: {
      version: 1,
      identity: { repositoryHost: repository.repositoryHost, repositoryId: repository.repositoryId, rootIssue: 686 },
      state: "ABORTED",
      provenance: { requester: "agent:implementation", issuer: "app:inari" },
      projection: { branch, pullRequest: 9686 },
    },
    session: {
      task: { kind: "issue", number: implementation.number },
      capabilities: [
        { kind: "change.implement", issue: implementation.number },
        { kind: "branch.advance", branch },
      ],
      authorizationDigest: record.governedBodyDigest,
    },
    branch,
    baseBranch: base.branch,
    pullRequest: {
      number: 9686,
      relation: { relation: "implements", references: [implementation], representation: "native" },
      closingReference: implementation,
    },
    executionEvidence: executionEvidence(record),
  };
}

test("completion is derived only from current authorization, exact evidence, and conformant reread", () => {
  const record = authorization();
  const result = tryProjectImplementationLifecycle(lifecycleInput(record));
  assert.equal(result.valid, true);
  assert.equal(result.status, "completed");
  assert.equal(result.authorized, true);
  assert.equal(result.current, true);
  assert.deepEqual(result.authorization, record);
});

test("missing evidence, stale head, and scope violation cannot yield completion", () => {
  const record = authorization();
  const missing = tryProjectImplementationLifecycle(lifecycleInput(record, { executionEvidence: undefined }));
  assert.equal(missing.status, "authorized");
  assert.equal(missing.valid, false);

  const stale = tryProjectImplementationLifecycle(
    lifecycleInput(record, { executionEvidence: executionEvidence(record, { headRevision: "other-head" }) }),
  );
  assert.notEqual(stale.status, "completed");
  assert.ok(
    stale.violations.some((violation) => violation.code === "IMPLEMENTATION_CONFORMANCE_EXECUTION_EVIDENCE_STALE"),
  );

  const scope = tryProjectImplementationLifecycle(
    lifecycleInput(record, {
      pullRequest: pullRequest({ changedFiles: collection([{ filename: "outside.ts", status: "modified" }]) }),
    }),
  );
  assert.notEqual(scope.status, "completed");
  assert.ok(scope.violations.some((violation) => violation.code === "IMPLEMENTATION_CONFORMANCE_SCOPE_VIOLATION"));
});

test("body drift and stale authorization invalidate before terminal completion", () => {
  const record = authorization();
  const changedBody = renderImplementationIssueBody(
    parseImplementationContract(contract({ objective: "A drifted objective." })),
  );
  const result = tryProjectImplementationLifecycle(
    lifecycleInput(record, { issue: { reference: implementation, body: changedBody } }),
  );
  assert.equal(result.status, "invalidated");
  assert.equal(result.authorized, false);
  assert.equal(result.current, false);
  assert.notEqual(result.status, "completed");
});

test("explicit supersession outranks completion and preserves the historical authorization", () => {
  const record = authorization();
  const result = tryProjectImplementationLifecycle(
    lifecycleInput(record, { supersession: { supersededBy: [{ ...repository, number: 687 }] } }),
  );
  assert.equal(result.status, "superseded");
  assert.equal(result.authorized, false);
  assert.deepEqual(result.authorization, record);
});

test("a bound Implementation-root Change abort is classified as historical only", () => {
  const record = authorization();
  const result = tryProjectImplementationLifecycle({
    authorization: record,
    issue: { reference: implementation, body },
    repository,
    base,
    changeIdentity: abortedChangeIdentity(record),
  });
  assert.equal(result.valid, true);
  assert.equal(result.status, "authorized");
  assert.equal(result.authorized, false);
  assert.equal(result.current, false);
  assert.deepEqual(result.historicalTermination, {
    classification: "historical-only",
    source: "implementation-root-change",
    implementation,
    authorizationDigest: record.governedBodyDigest,
  });
  assert.deepEqual(result.authorization, record);

  const currentRead = tryProjectImplementationLifecycle({
    authorization: record,
    issue: { reference: implementation, body },
    repository,
    base,
    changeIdentity: abortedChangeIdentity(record),
    taskTermination: {
      status: "authoritative",
      provenance: { source: "lifecycle-test" },
      records: [],
    },
  });
  assert.equal(currentRead.valid, true);
  assert.equal(currentRead.status, "authorized");
  assert.equal(currentRead.authorized, true);
  assert.equal(currentRead.current, true);
  assert.equal(currentRead.historicalTermination?.classification, "historical-only");
});

test("only a valid current bound task-termination record projects Implementation aborted", () => {
  const record = authorization();
  const result = tryProjectImplementationLifecycle(
    lifecycleInput(record, { taskTermination: taskTerminationRead(record) }),
  );
  assert.equal(result.valid, true);
  assert.equal(result.status, "aborted");
  assert.equal(result.authorized, false);
  assert.equal(result.current, false);

  const authoritativeAbsence = tryProjectImplementationLifecycle({
    authorization: record,
    issue: { reference: implementation, body },
    repository,
    base,
    taskTermination: {
      status: "authoritative",
      provenance: { source: "lifecycle-test" },
      records: [],
    },
  });
  assert.equal(authoritativeAbsence.valid, true);
  assert.equal(authoritativeAbsence.status, "authorized");
});

test("unavailable or mismatched task-termination evidence cannot project aborted", () => {
  const record = authorization();
  const unavailable = tryProjectImplementationLifecycle({
    authorization: record,
    issue: { reference: implementation, body },
    repository,
    base,
    taskTermination: { status: "unavailable", provenance: { source: "lifecycle-test" } },
  });
  assert.equal(unavailable.valid, false);
  assert.notEqual(unavailable.status, "aborted");
  assert.ok(
    unavailable.violations.some((violation) => violation.code === "IMPLEMENTATION_LIFECYCLE_TERMINATION_UNAVAILABLE"),
  );

  const mismatched = tryProjectImplementationLifecycle(
    lifecycleInput(record, {
      taskTermination: taskTerminationRead(record, { authorizationDigest: "a".repeat(64) }),
    }),
  );
  assert.equal(mismatched.valid, false);
  assert.notEqual(mismatched.status, "aborted");
  assert.ok(
    mismatched.violations.some((violation) => violation.code === "IMPLEMENTATION_LIFECYCLE_TERMINATION_INVALID"),
  );
});

test("one Implementation task termination does not terminate a sibling task", () => {
  const terminated = authorization(implementation);
  const sibling = { ...repository, number: 687 } as const;
  const siblingAuthorization = authorization(sibling);
  const siblingBody = renderImplementationIssueBody(parseImplementationContract(contract()));
  const siblingWithUnrelatedTermination = tryProjectImplementationLifecycle({
    authorization: siblingAuthorization,
    issue: { reference: sibling, body: siblingBody },
    repository,
    base,
    taskTermination: taskTerminationRead(terminated),
  });
  assert.equal(siblingWithUnrelatedTermination.valid, false);
  assert.notEqual(siblingWithUnrelatedTermination.status, "aborted");

  const siblingWithoutTermination = tryProjectImplementationLifecycle({
    authorization: siblingAuthorization,
    issue: { reference: sibling, body: siblingBody },
    repository,
    base,
    taskTermination: {
      status: "authoritative",
      provenance: { source: "lifecycle-test" },
      records: [],
    },
  });
  assert.equal(siblingWithoutTermination.valid, true);
  assert.equal(siblingWithoutTermination.status, "authorized");
});

test("completion assertions and abort replays cannot manufacture terminal authority", () => {
  const record = authorization();
  const asserted = tryProjectImplementationLifecycle(lifecycleInput(record, { completed: true }));
  assert.equal(asserted.status, "invalidated");
  assert.equal(asserted.authorized, false);

  const first = tryProjectImplementationLifecycle({
    authorization: record,
    issue: { reference: implementation, body },
    repository,
    base,
    changeIdentity: abortedChangeIdentity(record),
  });
  const replay = tryProjectImplementationLifecycle({
    authorization: record,
    issue: { reference: implementation, body },
    repository,
    base,
    changeIdentity: abortedChangeIdentity(record),
  });
  assert.deepEqual(replay, first);
  assert.equal(first.status, "authorized");
  assert.equal(first.authorized, false);
  assert.equal(first.current, false);
  assert.equal(first.historicalTermination?.classification, "historical-only");
});

test("contradictory abort evidence cannot be bypassed by otherwise conformant evidence", () => {
  const record = authorization();
  const invalidAbort = abortedChangeIdentity(record);
  (invalidAbort.change as Record<string, unknown>).state = "DRAFT";
  const result = tryProjectImplementationLifecycle(lifecycleInput(record, { changeIdentity: invalidAbort }));
  assert.equal(result.status, "authorized");
  assert.equal(result.valid, false);
  assert.notEqual(result.status, "completed");
  assert.ok(result.violations.some((violation) => violation.code === "IMPLEMENTATION_LIFECYCLE_TERMINATION_INVALID"));
});
