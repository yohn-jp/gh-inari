import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueReference } from "./contract/issue-reference.js";
import type { ObservedIssueProjection } from "./semantic-issue-observation.js";
import {
  deserializeImplementationFrontierProjection,
  serializeImplementationFrontierProjection,
  tryProjectImplementationFrontier,
  validateImplementationFrontierProjection,
  type ImplementationFrontierProjection,
} from "./implementation-frontier.js";
import {
  IMPLEMENTATION_CONTRACT_VERSION,
  IMPLEMENTATION_KIND,
  parseImplementationContract,
  renderImplementationIssueBody,
} from "./implementation-contract.js";
import { authorizeImplementation, type ImplementationAuthorizationRecord } from "./implementation-authorization.js";

const repository = { repositoryHost: "github.com", repositoryId: "677", repository: "acme/frontier" };
const base = { branch: "main", revision: "a".repeat(40), freshness: "fresh-1" };

function issue(number: number): IssueReference {
  return { ...repository, number };
}

function contract(reference: IssueReference, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const source = { ...repository, number: reference.number + 500 };
  return {
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository,
    sources: [source],
    objective: "Project the implementation frontier.",
    nonGoals: ["Automatic re-authorization"],
    architecture: {
      decision: "Keep the frontier projection pure.",
      affectedComponents: ["Implementation Frontier"],
      invariants: ["Authority evidence is never inferred from lifecycle flags."],
      compatibilityConstraints: [],
    },
    scope: { readOnly: ["src/**"], write: ["src/implementation-frontier.ts"], create: [], delete: [], deny: [] },
    constraints: { prohibitedOperations: [], immutableAreas: [], prerequisites: ["The canonical contract is valid."] },
    verification: {
      acceptanceCriteria: ["The frontier projects deterministically."],
      targetedTests: [],
      requiredChecks: [],
      postconditions: [],
    },
    execution: {
      baseBranch: base.branch,
      baseRevision: base.revision,
      baseFreshness: base.freshness,
      branch: `feat/${reference.number}-implementation-frontier-fixture`,
      dependencies: [source],
    },
    ...overrides,
  };
}

function authorizationRecord(
  reference: IssueReference,
  overrides: Record<string, unknown> = {},
): { readonly body: string; readonly record: ImplementationAuthorizationRecord } {
  const source = { ...repository, number: reference.number + 500 };
  const body = renderImplementationIssueBody(parseImplementationContract(contract(reference, overrides)));
  const record = authorizeImplementation({
    implementation: reference,
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
  return { body, record };
}

function collection(items: readonly unknown[]): Record<string, unknown> {
  return {
    status: "available",
    items,
    pagination: { perPage: 100, pages: 1, returned: items.length, truncated: false },
    diagnostics: [],
  };
}

function completionEvidence(
  reference: IssueReference,
  body: string,
  record: ImplementationAuthorizationRecord,
): { readonly conformance: Record<string, unknown>; readonly executionEvidence: Record<string, unknown> } {
  const branch = `feat/${reference.number}-implementation-frontier-fixture`;
  const headRevision = `head-${reference.number}`;
  const executionEvidence = {
    version: 1,
    kind: "implementation-execution-evidence",
    implementation: reference,
    repository,
    governedBodyDigest: record.governedBodyDigest,
    base,
    branch,
    headRevision,
    targetedTests: [],
  };
  const pullRequest = {
    repository: { host: "github.com", nameWithOwner: "acme/frontier", repositoryId: repository.repositoryId },
    number: 1_000 + reference.number,
    title: "Frontier completion",
    body: "provider body is not lifecycle authority",
    state: "open",
    author: null,
    head: { ref: branch, sha: headRevision },
    base: { ref: base.branch, sha: base.revision },
    draft: false,
    labels: [],
    assignees: [],
    url: `https://github.com/acme/frontier/pull/${1_000 + reference.number}`,
    checks: collection([]),
    requiredCheckBindings: collection([]),
    reviews: collection([]),
    comments: collection([]),
    inlineReviewComments: collection([]),
    changedFiles: collection([]),
    provenance: { provider: "github", endpoints: [`pulls/${1_000 + reference.number}`] },
  };
  return {
    conformance: {
      authorization: record,
      issue: { reference, body },
      repository,
      base,
      pullRequestNumber: pullRequest.number,
      pullRequest,
      executionEvidence,
    },
    executionEvidence,
  };
}

function observed(
  reference: IssueReference,
  state: "open" | "closed",
  dependsOn: readonly IssueReference[] = [],
): ObservedIssueProjection {
  return {
    version: "1",
    kind: "issue",
    number: reference.number,
    state,
    title: `Issue ${reference.number}`,
    body: "",
    metadata: {},
    relations: {
      parent: { relation: "parent", representation: "none", evidence: {} },
      dependsOn: {
        relation: "dependsOn",
        references: dependsOn,
        representation: dependsOn.length === 0 ? "none" : "native",
        evidence: { native: dependsOn, bodyFallback: [] },
      },
    },
  };
}

function rawNode(reference: IssueReference, state: "open" | "closed", dependsOn: readonly IssueReference[] = []) {
  return { reference, observed: observed(reference, state, dependsOn) };
}

function project(
  candidates: readonly Record<string, unknown>[],
  nodes: readonly Record<string, unknown>[] = candidates.map((candidate) =>
    rawNode(candidate.reference as IssueReference, "open"),
  ),
) {
  return tryProjectImplementationFrontier({ issues: nodes, candidates });
}

function classifications(result: ReturnType<typeof tryProjectImplementationFrontier>): readonly string[] {
  return (
    result.projection?.candidates.map((candidate) => `${candidate.reference.number}:${candidate.classification}`) ?? []
  );
}

test("projects READY and BLOCKED from semantic dependencies", () => {
  const first = issue(1);
  const second = issue(2);
  const result = project(
    [{ reference: first }, { reference: second }],
    [rawNode(first, "open", [second]), rawNode(second, "open")],
  );
  assert.equal(result.valid, true);
  assert.deepEqual(classifications(result), ["1:BLOCKED", "2:READY"]);
  assert.deepEqual(
    result.projection?.ready.map((reference) => reference.number),
    [2],
  );
  assert.deepEqual(
    result.projection?.parallelReadyGroups[0]?.items.map((reference) => reference.number),
    [2],
  );
});

test("derives SATISFIED only from conformant reread plus exact execution evidence, never Issue state", () => {
  const complete = issue(10);
  const closedOnly = issue(11);
  const { body, record } = authorizationRecord(complete);
  const completion = completionEvidence(complete, body, record);
  const result = project(
    [
      {
        reference: complete,
        implementation: {
          authorization: { authorization: record, body, repository, base },
          conformance: completion.conformance,
          executionEvidence: completion.executionEvidence,
        },
      },
      { reference: closedOnly },
    ],
    [rawNode(complete, "open"), rawNode(closedOnly, "closed")],
  );
  assert.equal(result.valid, false);
  assert.deepEqual(classifications(result), ["10:SATISFIED", "11:INVALID"]);
  assert.ok(
    result.projection?.candidates[1]?.diagnostics.some((entry) => entry.code === "FRONTIER_CLOSED_ISSUE_UNPROVEN"),
  );
});

test("projects ACTIVE from a current authorization inspection, never bare lifecycle flags", () => {
  const reference = issue(20);
  const { body, record } = authorizationRecord(reference);
  const result = project([
    { reference, implementation: { authorization: { authorization: record, body, repository, base } } },
  ]);
  assert.equal(result.valid, true);
  assert.deepEqual(classifications(result), ["20:ACTIVE"]);
  assert.deepEqual(result.projection?.ready, []);
});

test("a contradictory authorization result (valid:false with completed flags) fails closed as INVALID", () => {
  const reference = issue(21);
  const { record } = authorizationRecord(reference);
  const result = project([
    {
      reference,
      implementation: {
        // A body mismatch makes the authorization stale/invalid even though
        // the caller asserts completion; the frontier must not trust the
        // caller's flags over the recomputed authority result.
        authorization: { authorization: record, body: "not an Implementation body", repository, base, completed: true },
      },
    },
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.projection?.candidates[0]?.classification, "INVALID");
  assert.ok(
    result.projection?.candidates[0]?.diagnostics.some((entry) => entry.code === "FRONTIER_AUTHORIZATION_INVALID"),
  );
});

test("aborted Change evidence is terminal and cannot re-enter READY", () => {
  const reference = issue(29);
  const branch = "feat/29-terminal-change";
  const changeProjection = {
    valid: true,
    status: "healthy",
    canonicalBranch: branch,
    canonicalBaseBranch: "main",
    candidates: {
      branches: [{ candidate: { name: branch }, classification: "canonical", reason: "canonical" }],
      pullRequests: [
        {
          candidate: {
            number: 129,
            head: branch,
            base: "main",
            state: "closed",
            draft: false,
            merged: false,
          },
          classification: "canonical",
          reason: "canonical",
        },
      ],
    },
    change: {
      version: 1,
      identity: {
        repositoryHost: reference.repositoryHost,
        repositoryId: reference.repositoryId,
        rootIssue: reference.number,
      },
      state: "ABORTED",
      provenance: {},
      projection: { branch, pullRequest: 129 },
    },
    diagnostics: [],
  };

  const result = project([{ reference, change: changeProjection }], [rawNode(reference, "open")]);
  assert.equal(result.valid, false);
  assert.equal(result.projection?.candidates[0]?.classification, "INVALID");
  assert.ok(result.projection?.candidates[0]?.diagnostics.some((entry) => entry.code === "FRONTIER_CHANGE_TERMINAL"));
  assert.deepEqual(result.projection?.ready, []);
});

test("fails closed for cycles and self-dependencies", () => {
  const first = issue(30);
  const second = issue(31);
  const self = issue(32);
  const result = project(
    [{ reference: first }, { reference: second }, { reference: self }],
    [rawNode(first, "open", [second]), rawNode(second, "open", [first]), rawNode(self, "open", [self])],
  );
  assert.equal(result.valid, false);
  assert.deepEqual(classifications(result), ["30:INVALID", "31:INVALID", "32:INVALID"]);
  assert.ok(
    result.projection?.candidates.some((candidate) =>
      candidate.diagnostics.some((entry) => entry.code === "FRONTIER_DEPENDENCY_CYCLE"),
    ),
  );
  assert.ok(
    result.projection?.candidates.some((candidate) =>
      candidate.diagnostics.some((entry) => entry.code === "FRONTIER_SELF_DEPENDENCY"),
    ),
  );
});

test("is deterministic and serializable across repeated projection", () => {
  const first = issue(40);
  const second = issue(41);
  const input = {
    issues: [rawNode(first, "open"), rawNode(second, "open")],
    candidates: [{ reference: second }, { reference: first }],
  };
  const left = tryProjectImplementationFrontier(input);
  const right = tryProjectImplementationFrontier(input);
  assert.deepEqual(left, right);
  assert.equal(left.projection === undefined, false);
  const serialized = serializeImplementationFrontierProjection(left.projection);
  assert.deepEqual(deserializeImplementationFrontierProjection(serialized), left.projection);
});

test("missing Issue authority is INVALID rather than READY", () => {
  const result = tryProjectImplementationFrontier({ candidates: [{ reference: issue(50) }] });
  assert.equal(result.valid, false);
  assert.equal(result.projection?.candidates[0]?.classification, "INVALID");
  assert.ok(result.projection?.candidates[0]?.diagnostics.some((entry) => entry.code === "FRONTIER_EVIDENCE_MISSING"));
});

test("fails closed for stale and contradictory authority evidence", () => {
  const stale = issue(60);
  const contradictory = issue(61);
  const other = issue(99);
  const { body: staleBody, record: staleRecord } = authorizationRecord(stale);
  const result = tryProjectImplementationFrontier({
    candidates: [
      {
        reference: stale,
        issue: rawNode(stale, "open"),
        implementation: {
          // A stale base revision makes the recomputed authorization
          // invalidated even though a record exists.
          authorization: {
            authorization: staleRecord,
            body: staleBody,
            repository,
            base: { ...base, revision: "b".repeat(40) },
          },
        },
      },
      {
        reference: contradictory,
        issue: {
          reference: other,
          dependsOn: [],
          dependsOnEvidence: "empty",
          drift: [],
        },
      },
    ],
  });
  assert.equal(result.valid, false);
  assert.equal(
    result.projection?.candidates.find((candidate) => candidate.reference.number === 60)?.classification,
    "INVALID",
  );
  assert.equal(
    result.projection?.candidates.find((candidate) => candidate.reference.number === 61)?.classification,
    "INVALID",
  );
  assert.ok(result.projection?.diagnostics.some((entry) => entry.code === "FRONTIER_AUTHORIZATION_INVALID"));
  assert.ok(result.projection?.diagnostics.some((entry) => entry.code === "FRONTIER_CONTRADICTORY_EVIDENCE"));
});

test("a dependency with no candidate evidence fails closed as INVALID, not BLOCKED", () => {
  const depending = issue(70);
  const missingDependency = issue(71);
  const result = project([{ reference: depending }], [rawNode(depending, "open", [missingDependency])]);
  assert.equal(result.valid, false);
  assert.equal(result.projection?.candidates[0]?.classification, "INVALID");
  assert.ok(
    result.projection?.candidates[0]?.diagnostics.some((entry) => entry.code === "FRONTIER_DEPENDENCY_MISSING"),
  );
  assert.ok(
    !result.projection?.candidates[0]?.diagnostics.some((entry) => entry.code === "FRONTIER_DEPENDENCY_BLOCKED"),
  );
});

test("candidate-local Issue evidence contradicting batch lifecycle evidence fails closed", () => {
  const reference = issue(80);
  const dependency = issue(81);
  const result = tryProjectImplementationFrontier({
    issues: [rawNode(reference, "open", []), rawNode(dependency, "open")],
    candidates: [
      {
        reference,
        // Disagrees with the batch lifecycle evidence above, which reports
        // no dependencies for this candidate.
        issue: { reference, dependsOn: [dependency], dependsOnEvidence: "present", drift: [] },
      },
      { reference: dependency },
    ],
  });
  assert.equal(result.valid, false);
  assert.equal(result.projection?.candidates.find((c) => c.reference.number === 80)?.classification, "INVALID");
  assert.ok(
    result.projection?.diagnostics.some(
      (entry) => entry.code === "FRONTIER_CONTRADICTORY_EVIDENCE" && entry.path === "$.candidates[0].issue",
    ),
  );
});

test("disagreement between semantic dependencies and the canonical contract dependency set fails closed", () => {
  const reference = issue(90);
  const semanticOnlyDependency = issue(91);
  // `contract(reference, ...)` binds the contract's own dependency set to
  // `reference.number + 500`, which differs from the semantic dependency
  // supplied via the raw Issue node below.
  const result = project(
    [{ reference, implementation: { contract: contract(reference) } }],
    [rawNode(reference, "open", [semanticOnlyDependency])],
  );
  assert.equal(result.valid, false);
  assert.equal(result.projection?.candidates[0]?.classification, "INVALID");
  assert.ok(
    result.projection?.diagnostics.some(
      (entry) => entry.code === "FRONTIER_CONTRADICTORY_EVIDENCE" && entry.path === "$.candidates[0].dependencies",
    ),
  );
});

test("rejects a contract with the same repository ID on a different host", () => {
  const reference = { ...issue(92), repositoryHost: "ghe.example.com" };
  const dependency = { ...repository, number: reference.number + 500 };
  const result = project(
    [{ reference, implementation: { contract: contract(reference) } }, { reference: dependency }],
    [rawNode(reference, "open", [dependency]), rawNode(dependency, "open")],
  );
  const candidate = result.projection?.candidates.find((entry) => entry.reference.number === reference.number);
  assert.equal(result.valid, false);
  assert.equal(candidate?.classification, "INVALID");
  assert.ok(
    candidate?.diagnostics.some(
      (entry) =>
        entry.code === "FRONTIER_CONTRADICTORY_EVIDENCE" &&
        entry.path === "$.candidates[0].implementation.contract.repository",
    ),
  );
});

test("rejects a contract from a different repository", () => {
  const reference = issue(93);
  const dependency = { ...repository, number: reference.number + 500 };
  const result = project(
    [
      {
        reference,
        implementation: { contract: contract(reference, { repository: { ...repository, repositoryId: "999" } }) },
      },
      { reference: dependency },
    ],
    [rawNode(reference, "open", [dependency]), rawNode(dependency, "open")],
  );
  const candidate = result.projection?.candidates.find((entry) => entry.reference.number === reference.number);
  assert.equal(result.valid, false);
  assert.equal(candidate?.classification, "INVALID");
  assert.ok(
    candidate?.diagnostics.some(
      (entry) =>
        entry.code === "FRONTIER_CONTRADICTORY_EVIDENCE" &&
        entry.path === "$.candidates[0].implementation.contract.repository",
    ),
  );
});

function validProjection(): ImplementationFrontierProjection {
  const blocked = issue(200);
  const ready = issue(201);
  const result = project(
    [{ reference: blocked }, { reference: ready }],
    [rawNode(blocked, "open", [ready]), rawNode(ready, "open")],
  );
  assert.equal(result.valid, true);
  if (result.projection === undefined) throw new Error("expected a valid fixture projection");
  return result.projection;
}

test("validateImplementationFrontierProjection rejects projection integrity violations", () => {
  const baseline = validProjection();
  assert.equal(validateImplementationFrontierProjection(baseline).valid, true);

  // valid:true while a candidate is INVALID.
  const invalidCandidate = {
    ...baseline,
    valid: true,
    candidates: baseline.candidates.map((candidate) =>
      candidate.reference.number === 200 ? { ...candidate, classification: "INVALID" as const } : candidate,
    ),
  };
  assert.equal(validateImplementationFrontierProjection(invalidCandidate).valid, false);

  // A reference in `ready` whose candidate is not READY.
  const readyMismatch = { ...baseline, ready: [...baseline.ready, issue(200)] };
  assert.equal(validateImplementationFrontierProjection(readyMismatch).valid, false);

  // A READY candidate omitted from `ready`.
  const readyOmitted = { ...baseline, ready: [] };
  assert.equal(validateImplementationFrontierProjection(readyOmitted).valid, false);

  // parallelReadyGroups containing a non-READY/unknown reference.
  const groupNonReady = {
    ...baseline,
    parallelReadyGroups: [{ items: [issue(200)] }],
  };
  assert.equal(validateImplementationFrontierProjection(groupNonReady).valid, false);

  // Duplicate READY reference across groups.
  const groupDuplicate = {
    ...baseline,
    parallelReadyGroups: [{ items: [issue(201)] }, { items: [issue(201)] }],
  };
  assert.equal(validateImplementationFrontierProjection(groupDuplicate).valid, false);

  // A READY candidate missing from every group.
  const groupMissing = { ...baseline, parallelReadyGroups: [] };
  assert.equal(validateImplementationFrontierProjection(groupMissing).valid, false);

  // satisfiedDependencies/unsatisfiedDependencies that do not partition dependencies.
  const partitionGap = {
    ...baseline,
    candidates: baseline.candidates.map((candidate) =>
      candidate.reference.number === 200 ? { ...candidate, unsatisfiedDependencies: [] } : candidate,
    ),
  };
  assert.equal(validateImplementationFrontierProjection(partitionGap).valid, false);

  // The same dependency in both satisfied and unsatisfied sets.
  const partitionOverlap = {
    ...baseline,
    candidates: baseline.candidates.map((candidate) =>
      candidate.reference.number === 200
        ? { ...candidate, satisfiedDependencies: [issue(201)], unsatisfiedDependencies: [issue(201)] }
        : candidate,
    ),
  };
  assert.equal(validateImplementationFrontierProjection(partitionOverlap).valid, false);

  // `valid:false` claimed with no INVALID candidate is also inconsistent.
  const validityUnderclaimed = { ...baseline, valid: false };
  assert.equal(validateImplementationFrontierProjection(validityUnderclaimed).valid, false);

  // Duplicate candidate references.
  const duplicateCandidate = { ...baseline, candidates: [...baseline.candidates, baseline.candidates[0]] };
  assert.equal(validateImplementationFrontierProjection(duplicateCandidate).valid, false);
});
