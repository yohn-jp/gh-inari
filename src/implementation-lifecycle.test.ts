import assert from "node:assert/strict";
import { test } from "node:test";
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

function authorization(): ImplementationAuthorizationRecord {
  return authorizeImplementation({
    implementation,
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

test("a bound Change/session abort deterministically removes current execution authority", () => {
  const record = authorization();
  const result = tryProjectImplementationLifecycle({
    authorization: record,
    issue: { reference: implementation, body },
    repository,
    base,
    changeIdentity: abortedChangeIdentity(record),
  });
  assert.equal(result.valid, true);
  assert.equal(result.status, "aborted");
  assert.equal(result.authorized, false);
  assert.equal(result.current, false);
  assert.deepEqual(result.authorization, record);
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
