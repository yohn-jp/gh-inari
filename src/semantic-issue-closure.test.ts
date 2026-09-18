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

const repository = { repositoryHost: "github.com", repositoryId: "100", repository: "acme/inari" } as const;

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

function implementationEvidence(
  reference: IssueReference,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    valid: true,
    status: "completed",
    authorized: true,
    current: true,
    authorization: { implementation: reference },
    violations: [],
    ...overrides,
  };
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
  });
  assert.equal(result.valid, true);
  assert.equal(result.projection?.status, "blocked");
  assert.equal(result.projection?.finalGateRemainder?.number, finalGate.number);
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

  const stale = tryProjectSemanticIssueClosure(
    closeInput({ implementation: implementationEvidence(issue(10), { current: false, authorized: false }) }),
  );
  assert.equal(stale.valid, false);
  assert.ok(stale.diagnostics.some((entry) => entry.code === "CLOSURE_TERMINAL_EVIDENCE_STALE"));

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
