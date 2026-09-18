import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueReference } from "./contract/issue-reference.js";
import type { ObservedIssueProjection } from "./semantic-issue-observation.js";
import {
  deserializeImplementationFrontierProjection,
  serializeImplementationFrontierProjection,
  tryProjectImplementationFrontier,
} from "./implementation-frontier.js";

const repository = { repositoryHost: "github.com", repositoryId: "677", repository: "acme/frontier" };

function issue(number: number): IssueReference {
  return { ...repository, number };
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

test("derives SATISFIED from current Implementation evidence, never Issue state", () => {
  const complete = issue(10);
  const closedOnly = issue(11);
  const result = project(
    [
      {
        reference: complete,
        implementation: { lifecycle: { status: "completed", authorized: true, current: true } },
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

test("projects ACTIVE from current authorization evidence", () => {
  const reference = issue(20);
  const result = project([
    { reference, implementation: { lifecycle: { status: "authorized", authorized: true, current: true } } },
  ]);
  assert.equal(result.valid, true);
  assert.deepEqual(classifications(result), ["20:ACTIVE"]);
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
  const result = tryProjectImplementationFrontier({
    candidates: [
      {
        reference: stale,
        issue: rawNode(stale, "open"),
        implementation: { lifecycle: { status: "invalidated", authorized: false, current: false } },
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
