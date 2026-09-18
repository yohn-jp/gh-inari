import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueReference } from "./contract/issue-reference.js";
import { projectChangeFromGitHubEvidence } from "./change.js";
import {
  planSemanticIssueClosure,
  tryProjectSemanticIssueClosure,
  type SemanticIssueClosureInput,
} from "./semantic-issue-closure.js";
import { tryProjectImplementationFrontier } from "./implementation-frontier.js";
import type { SemanticIssueLifecycleNode } from "./semantic-issue-lifecycle.js";
import type { ObservedIssueProjection } from "./semantic-issue-observation.js";
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

const repository = { repositoryHost: "github.com", repositoryId: "100", repository: "acme/inari" } as const;
const implementationSource = { ...repository, number: 678 } as const;
const implementationBase = { branch: "main", revision: "base-revision", freshness: "base-freshness" } as const;

function implementationContract(
  target: IssueReference,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository,
    sources: [implementationSource],
    objective: "Reach closure admissibility for the target Issue.",
    nonGoals: ["Change merge"],
    architecture: {
      decision: "Compose existing evidence boundaries.",
      affectedComponents: ["Issue closure"],
      invariants: ["Completion is never caller asserted."],
      compatibilityConstraints: [],
    },
    scope: { readOnly: ["src/**"], write: ["src/**"], create: [], delete: [], deny: ["src/private/**"] },
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
      baseBranch: implementationBase.branch,
      baseRevision: implementationBase.revision,
      baseFreshness: implementationBase.freshness,
      branch: `feat/${target.number}-closure`,
      dependencies: [implementationSource],
    },
    ...overrides,
  };
}

function implementationAuthorization(target: IssueReference): ImplementationAuthorizationRecord {
  const body = renderImplementationIssueBody(parseImplementationContract(implementationContract(target)));
  return authorizeImplementation({
    implementation: target,
    body,
    repository,
    base: implementationBase,
    readiness: {
      evidence: [
        {
          reference: implementationSource,
          authority: "implementation-conformance",
          status: "satisfied",
          freshness: "current",
          dependencies: [],
        },
      ],
    },
  });
}

function implementationCollection(items: readonly unknown[]): Record<string, unknown> {
  return {
    status: "available",
    items,
    pagination: { perPage: 100, pages: 1, returned: items.length, truncated: false },
    diagnostics: [],
  };
}

function implementationPullRequest(
  target: IssueReference,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    repository: {
      host: repository.repositoryHost,
      nameWithOwner: repository.repository,
      repositoryId: repository.repositoryId,
    },
    number: 9_000 + target.number,
    title: `Closure for Issue ${target.number}`,
    body: "not lifecycle authority",
    state: "open",
    author: null,
    head: { ref: `feat/${target.number}-closure`, sha: "head-revision" },
    base: { ref: "main", sha: "base-revision" },
    draft: false,
    labels: [],
    assignees: [],
    url: `https://provider.invalid/pull/${9_000 + target.number}`,
    checks: implementationCollection([
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
    requiredCheckBindings: implementationCollection([{ context: "verify", producer: "app:trusted" }]),
    reviews: implementationCollection([]),
    comments: implementationCollection([]),
    inlineReviewComments: implementationCollection([]),
    changedFiles: implementationCollection([{ filename: "src/semantic-issue-closure.ts", status: "modified" }]),
    provenance: { provider: "github", endpoints: [`pulls/${9_000 + target.number}`] },
    ...overrides,
  };
}

function implementationAbortedChangeIdentity(
  target: IssueReference,
  record: ImplementationAuthorizationRecord,
): Record<string, unknown> {
  const branch = `feat/${target.number}-closure`;
  return {
    contract: implementationContract(target),
    implementation: target,
    authorization: record,
    change: {
      version: 1,
      identity: {
        repositoryHost: repository.repositoryHost,
        repositoryId: repository.repositoryId,
        rootIssue: target.number,
      },
      state: "ABORTED",
      provenance: { requester: "agent:implementation", issuer: "app:inari" },
      projection: { branch, pullRequest: 9_000 + target.number },
    },
    session: {
      task: { kind: "issue", number: target.number },
      capabilities: [
        { kind: "change.implement", issue: target.number },
        { kind: "branch.advance", branch },
      ],
      authorizationDigest: record.governedBodyDigest,
    },
    branch,
    baseBranch: implementationBase.branch,
    pullRequest: {
      number: 9_000 + target.number,
      relation: { relation: "implements", references: [target], representation: "native" },
      closingReference: target,
    },
    executionEvidence: implementationExecutionEvidence(target, record),
  };
}

/** Genuine raw evidence that resolves to a bound, aborted Implementation lifecycle. */
function implementationEvidenceAborted(target: IssueReference): Record<string, unknown> {
  const record = implementationAuthorization(target);
  const body = renderImplementationIssueBody(parseImplementationContract(implementationContract(target)));
  return {
    authorization: record,
    issue: { reference: target, body },
    repository,
    base: implementationBase,
    changeIdentity: implementationAbortedChangeIdentity(target, record),
  };
}

function implementationExecutionEvidence(
  target: IssueReference,
  record: ImplementationAuthorizationRecord,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: IMPLEMENTATION_EXECUTION_EVIDENCE_VERSION,
    kind: IMPLEMENTATION_EXECUTION_EVIDENCE_KIND,
    implementation: record.implementation,
    repository: record.repository,
    governedBodyDigest: record.governedBodyDigest,
    base: record.base,
    branch: `feat/${target.number}-closure`,
    headRevision: "head-revision",
    targetedTests: [],
    ...overrides,
  };
}

function issue(number: number): IssueReference {
  return { ...repository, number };
}

function observed(
  reference: IssueReference,
  state: "open" | "closed",
  options: { readonly parent?: IssueReference; readonly conflict?: boolean } = {},
): ObservedIssueProjection {
  const parent = options.conflict
    ? {
        relation: "parent" as const,
        representation: "conflict" as const,
        evidence: { native: issue(90), bodyFallback: issue(91) },
      }
    : {
        relation: "parent" as const,
        ...(options.parent === undefined ? {} : { reference: options.parent }),
        representation: options.parent === undefined ? ("none" as const) : ("native" as const),
        evidence: options.parent === undefined ? {} : { native: options.parent },
      };
  return {
    version: "1",
    kind: "issue",
    number: reference.number,
    state,
    title: `Issue ${reference.number}`,
    body: "",
    metadata: {},
    relations: {
      parent,
      dependsOn: { relation: "dependsOn", references: [], representation: "none", evidence: { bodyFallback: [] } },
    },
  };
}

function node(
  reference: IssueReference,
  state: "open" | "closed",
  options: {
    readonly parent?: IssueReference;
    readonly role?: "tracker" | "leaf";
    readonly observed?: boolean;
    readonly conflict?: boolean;
  } = {},
): SemanticIssueLifecycleNode {
  return {
    reference,
    ...(options.observed === false
      ? {}
      : { observed: observed(reference, state, { parent: options.parent, conflict: options.conflict }) }),
    ...(options.role === undefined ? {} : { declaration: { role: options.role } }),
  };
}

function lifecycle(nodes: readonly SemanticIssueLifecycleNode[]): Record<string, unknown> {
  return { scope: "complete", issues: nodes };
}

/** Genuine raw #686 Implementation lifecycle evidence proving completion for `target`. */
function implementationEvidence(
  target: IssueReference,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const record = implementationAuthorization(target);
  const body = renderImplementationIssueBody(parseImplementationContract(implementationContract(target)));
  return {
    authorization: record,
    issue: { reference: target, body },
    repository,
    base: implementationBase,
    pullRequestNumber: 9_000 + target.number,
    pullRequest: implementationPullRequest(target),
    executionEvidence: implementationExecutionEvidence(target, record),
    ...overrides,
  };
}

/** Genuine raw evidence that resolves to a non-current, non-authorized (invalidated) result. */
function implementationEvidenceStale(target: IssueReference): Record<string, unknown> {
  const record = implementationAuthorization(target);
  const driftedBody = renderImplementationIssueBody(
    parseImplementationContract(implementationContract(target, { objective: "A drifted objective." })),
  );
  return implementationEvidence(target, { issue: { reference: target, body: driftedBody } });
}

function closeInput(overrides: Partial<SemanticIssueClosureInput> = {}): SemanticIssueClosureInput {
  const target = issue(10);
  return {
    target,
    intent: "close",
    lifecycle: lifecycle([node(target, "open", { role: "leaf" })]),
    implementation: implementationEvidence(target),
    ...overrides,
  };
}

test("leaf closure consumes authoritative Implementation terminal evidence", () => {
  const result = tryProjectSemanticIssueClosure(closeInput());
  assert.equal(result.valid, true);
  assert.equal(result.projection?.status, "closable");
  assert.deepEqual(result.projection?.effect, { kind: "CLOSE_ISSUE", target: issue(10) });

  const closed = tryProjectSemanticIssueClosure(
    closeInput({ lifecycle: lifecycle([node(issue(10), "closed", { role: "leaf" })]) }),
  );
  assert.equal(closed.valid, true);
  assert.equal(closed.projection?.status, "already-closed");
});

test("tracker closure requires complete child evidence and exposes the final gate", () => {
  const tracker = issue(20);
  const first = issue(21);
  const finalGate = issue(22);
  const result = tryProjectSemanticIssueClosure({
    target: tracker,
    intent: "close",
    lifecycle: lifecycle([
      node(tracker, "open", { role: "tracker" }),
      node(first, "closed", { parent: tracker }),
      node(finalGate, "open", { parent: tracker }),
    ]),
    children: [{ reference: first, implementation: implementationEvidence(first) }],
  });
  assert.equal(result.valid, true);
  assert.equal(result.projection?.status, "blocked");
  assert.equal(result.projection?.finalGateRemainder?.number, finalGate.number);
});

test("tracker closure requires authoritative terminal evidence for every provider-closed child", () => {
  const tracker = issue(23);
  const first = issue(24);
  const second = issue(25);
  const allProviderClosed = tryProjectSemanticIssueClosure({
    target: tracker,
    intent: "close",
    lifecycle: lifecycle([
      node(tracker, "open", { role: "tracker" }),
      node(first, "closed", { parent: tracker }),
      node(second, "closed", { parent: tracker }),
    ]),
    children: [{ reference: first, implementation: implementationEvidence(first) }],
  });
  assert.equal(allProviderClosed.valid, false);
  assert.equal(allProviderClosed.projection?.status, "unverifiable");
  assert.ok(
    allProviderClosed.diagnostics.some(
      (entry) => entry.code === "CLOSURE_RELATION_EVIDENCE_UNAVAILABLE" && entry.path.includes("children"),
    ),
  );

  const complete = tryProjectSemanticIssueClosure({
    target: tracker,
    intent: "close",
    lifecycle: lifecycle([
      node(tracker, "open", { role: "tracker" }),
      node(first, "closed", { parent: tracker }),
      node(second, "closed", { parent: tracker }),
    ]),
    children: [
      { reference: first, implementation: implementationEvidence(first) },
      { reference: second, implementation: implementationEvidence(second) },
    ],
  });
  assert.equal(complete.valid, true);
  assert.equal(complete.projection?.status, "closable");
});

test("an aborted tracker child does not satisfy tracker completion", () => {
  const tracker = issue(26);
  const child = issue(27);
  const result = tryProjectSemanticIssueClosure({
    target: tracker,
    intent: "close",
    lifecycle: lifecycle([node(tracker, "open", { role: "tracker" }), node(child, "closed", { parent: tracker })]),
    children: [{ reference: child, implementation: implementationEvidenceAborted(child) }],
  });
  assert.equal(result.valid, true);
  assert.equal(result.projection?.status, "blocked");
});

test("missing, stale, contradictory, and cyclic evidence fail closed", () => {
  const target = issue(30);
  const missing = tryProjectSemanticIssueClosure({
    target,
    intent: "close",
    lifecycle: lifecycle([
      node(target, "open", { role: "tracker" }),
      node(issue(31), "open", { parent: target, observed: false }),
    ]),
  });
  assert.equal(missing.valid, false);
  assert.equal(missing.projection?.status, "unverifiable");

  const stale = tryProjectSemanticIssueClosure(closeInput({ implementation: implementationEvidenceStale(issue(10)) }));
  assert.equal(stale.valid, false);
  assert.ok(stale.diagnostics.some((entry) => entry.code === "CLOSURE_TERMINAL_EVIDENCE_INVALID"));

  const contradictory = tryProjectSemanticIssueClosure({
    target,
    intent: "close",
    lifecycle: lifecycle([node(target, "open", { role: "leaf", conflict: true })]),
    implementation: implementationEvidence(target),
  });
  assert.equal(contradictory.valid, false);
  assert.ok(contradictory.diagnostics.some((entry) => entry.code === "CLOSURE_LIFECYCLE_INVALID"));

  const first = issue(40);
  const second = issue(41);
  const cyclic = tryProjectSemanticIssueClosure({
    target: first,
    intent: "close",
    lifecycle: lifecycle([
      node(first, "closed", { role: "tracker", parent: second }),
      node(second, "closed", { role: "tracker", parent: first }),
    ]),
  });
  assert.equal(cyclic.valid, false);
  assert.ok(cyclic.diagnostics.some((entry) => entry.code === "CLOSURE_RELATION_CYCLE"));
});

test("closed Issue state alone never proves leaf closure", () => {
  const result = tryProjectSemanticIssueClosure({
    target: issue(50),
    intent: "close",
    lifecycle: lifecycle([node(issue(50), "closed", { role: "leaf" })]),
  });
  assert.equal(result.valid, false);
  assert.equal(result.projection?.status, "unverifiable");
  assert.ok(result.diagnostics.some((entry) => entry.code === "CLOSURE_TERMINAL_EVIDENCE_MISSING"));
});

test("a forged shape-compatible Implementation result cannot establish closure", () => {
  const target = issue(60);
  const forged = {
    valid: true,
    status: "completed",
    authorized: true,
    current: true,
    authorization: { implementation: target },
    violations: [],
  };
  const result = tryProjectSemanticIssueClosure({
    target,
    intent: "close",
    lifecycle: lifecycle([node(target, "open", { role: "leaf" })]),
    implementation: forged,
  });
  assert.equal(result.valid, false);
  assert.equal(result.projection?.status, "unverifiable");
  assert.ok(result.diagnostics.some((entry) => entry.code === "CLOSURE_TERMINAL_EVIDENCE_INVALID"));
});

test("Change terminalization is consumed without another lifecycle authority", () => {
  const target = { repositoryHost: "github.com", repositoryId: "100000213", repository: "acme/inari", number: 213 };
  const change = projectChangeFromGitHubEvidence({
    change: { repositoryHost: target.repositoryHost, repositoryId: target.repositoryId, rootIssue: target.number },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "closure" },
    baseBranch: "main",
    evidence: {
      issue: { status: "available", value: { number: target.number, state: "open" } },
      branches: { status: "available", value: [{ name: "feat/213-closure" }] },
      pullRequests: {
        status: "available",
        value: [{ number: 400, head: "feat/213-closure", base: "main", state: "closed", draft: false, merged: true }],
      },
    },
  });
  assert.equal(change.valid, true);
  const result = tryProjectSemanticIssueClosure({
    target,
    intent: "close",
    lifecycle: lifecycle([node(target, "open", { role: "leaf" })]),
    change,
  });
  assert.equal(result.valid, true);
  assert.equal(result.projection?.status, "closable");

  const frontier = tryProjectImplementationFrontier({
    issues: [node(target, "closed", { role: "leaf" })],
    candidates: [{ reference: target, change }],
  });
  assert.equal(frontier.valid, true);
  assert.equal(frontier.projection?.candidates[0]?.classification, "SATISFIED");
});

test("close planning requires explicit caller intent", () => {
  const input = closeInput();
  const withoutIntent = { ...input, intent: undefined };
  assert.equal(tryProjectSemanticIssueClosure(withoutIntent).valid, false);
  assert.throws(() => planSemanticIssueClosure(withoutIntent), /explicit intent/u);
});
