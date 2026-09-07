import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueReference } from "./contract/issue-reference.js";
import type { SemanticArtifact } from "./contract/semantic-artifact.js";
import { tryProjectSemanticIssueLifecycle, type SemanticIssueLifecycleNode } from "./semantic-issue-lifecycle.js";
import type { ObservedIssueProjection } from "./semantic-issue-observation.js";

const repository = { repositoryHost: "github.com", repositoryId: "100", repository: "yohn-jp/gh-inari" };
const otherRepository = { repositoryHost: "github.com", repositoryId: "200", repository: "yohn-jp/other" };

function issue(number: number, crossRepository = false): IssueReference {
  return { ...(crossRepository ? otherRepository : repository), number };
}

function observed(
  reference: IssueReference,
  state: "open" | "closed",
  options: {
    readonly parent?: IssueReference;
    readonly dependsOn?: readonly IssueReference[];
    readonly conflict?: boolean;
  } = {},
): ObservedIssueProjection {
  const parent = options.conflict
    ? {
        relation: "parent" as const,
        representation: "conflict" as const,
        evidence: { native: issue(99), bodyFallback: issue(98) },
      }
    : {
        relation: "parent" as const,
        ...(options.parent === undefined ? {} : { reference: options.parent }),
        representation: options.parent === undefined ? ("none" as const) : ("native" as const),
        evidence: options.parent === undefined ? {} : { native: options.parent },
      };
  const dependsOn = {
    relation: "dependsOn" as const,
    references: options.dependsOn ?? [],
    representation: (options.dependsOn === undefined || options.dependsOn.length === 0 ? "none" : "native") as
      "none" | "native",
    evidence: options.dependsOn === undefined ? { bodyFallback: [] } : { native: options.dependsOn, bodyFallback: [] },
  };
  return {
    version: "1",
    kind: "issue",
    number: reference.number,
    state,
    title: `Issue ${reference.number}`,
    body: "",
    metadata: {},
    relations: { parent, dependsOn },
  };
}

function node(
  reference: IssueReference,
  state: "open" | "closed",
  options: {
    readonly parent?: IssueReference;
    readonly dependsOn?: readonly IssueReference[];
    readonly role?: "tracker" | "leaf";
    readonly supersedes?: readonly IssueReference[];
    readonly supersededBy?: readonly IssueReference[];
    readonly checklist?: SemanticIssueLifecycleNode["checklist"];
    readonly conflict?: boolean;
    readonly observed?: boolean;
  } = {},
): SemanticIssueLifecycleNode {
  return {
    reference,
    ...(options.observed === false
      ? {}
      : {
          observed: observed(reference, state, {
            parent: options.parent,
            dependsOn: options.dependsOn,
            conflict: options.conflict,
          }),
        }),
    ...(options.role === undefined && options.supersedes === undefined && options.supersededBy === undefined
      ? {}
      : {
          declaration: {
            ...(options.role === undefined ? {} : { role: options.role }),
            ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
            ...(options.supersededBy === undefined ? {} : { supersededBy: options.supersededBy }),
          },
        }),
    ...(options.checklist === undefined ? {} : { checklist: options.checklist }),
  };
}

test("derives children and blocks from canonical forward relations and preserves repository identity", () => {
  const tracker = issue(1);
  const child = issue(2);
  const dependency = issue(3, true);
  const blocked = issue(4);
  const result = tryProjectSemanticIssueLifecycle({
    scope: "complete",
    issues: [
      node(tracker, "open", { role: "tracker" }),
      node(child, "open", { parent: tracker }),
      node(dependency, "closed"),
      node(blocked, "open", { dependsOn: [dependency] }),
    ],
  });
  const projectedTracker = result.projection?.issues.find((entry) => entry.reference.number === 1);
  const projectedDependency = result.projection?.issues.find((entry) => entry.reference.number === 3);
  assert.equal(result.valid, true);
  assert.deepEqual(
    projectedTracker?.children.map((entry) => entry.number),
    [2],
  );
  assert.deepEqual(
    projectedDependency?.blocks.map((entry) => entry.number),
    [4],
  );
  assert.equal(projectedDependency?.blocks[0]?.repositoryId, "100");
  assert.equal(projectedTracker?.childrenEvidence, "present");
  assert.equal(projectedTracker?.parentEvidence, "empty");
});

test("derives tracker completion and exposes the final-gate remainder", () => {
  const tracker = issue(10);
  const first = issue(11);
  const finalGate = issue(12);
  const result = tryProjectSemanticIssueLifecycle({
    issues: [
      node(tracker, "open", { role: "tracker" }),
      node(first, "closed", { parent: tracker }),
      node(finalGate, "open", { parent: tracker }),
    ],
  });
  const completion = result.projection?.issues.find((entry) => entry.reference.number === 10)?.completion;
  assert.equal(result.valid, true);
  assert.equal(completion?.status, "in-progress");
  assert.deepEqual(
    completion?.completed.map((entry) => entry.number),
    [11],
  );
  assert.deepEqual(
    completion?.remaining.map((entry) => entry.number),
    [12],
  );
  assert.equal(completion?.finalGateRemainder?.number, 12);
});

test("reports checklist/relation disagreement as lifecycle drift", () => {
  const tracker = issue(20);
  const child = issue(21);
  const result = tryProjectSemanticIssueLifecycle({
    issues: [
      node(tracker, "open", {
        role: "tracker",
        checklist: { status: "present", completed: [child], remaining: [] },
      }),
      node(child, "open", { parent: tracker }),
    ],
  });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CHECKLIST_RELATION_DRIFT"));
  assert.ok(result.projection?.issues[0]?.drift.some((diagnostic) => diagnostic.code === "CHECKLIST_RELATION_DRIFT"));
});

test("derives supersededBy from explicit supersedes and retains cross-repository identity", () => {
  const oldIssue = issue(30, true);
  const replacement = issue(31);
  const result = tryProjectSemanticIssueLifecycle({
    issues: [node(replacement, "open", { supersedes: [oldIssue] }), node(oldIssue, "closed")],
  });
  const oldProjection = result.projection?.issues.find((entry) => entry.reference.number === 30);
  assert.equal(result.valid, true);
  assert.deepEqual(oldProjection?.supersededBy, [replacement]);
  assert.equal(oldProjection?.supersededBy[0]?.repositoryId, "100");
  assert.equal(oldProjection?.reference.repositoryId, "200");
});

test("derives the canonical supersedes view from explicit supersededBy evidence", () => {
  const replacement = issue(32);
  const superseded = issue(33);
  const result = tryProjectSemanticIssueLifecycle({
    issues: [node(replacement, "open"), node(superseded, "closed", { supersededBy: [replacement] })],
  });
  const replacementProjection = result.projection?.issues.find((entry) => entry.reference.number === 32);
  assert.equal(result.valid, true);
  assert.deepEqual(replacementProjection?.supersedes, [superseded]);
});

test("fails closed when graph or child state evidence is unavailable", () => {
  const tracker = issue(40);
  const child = issue(41);
  const result = tryProjectSemanticIssueLifecycle({
    scope: "unavailable",
    issues: [node(tracker, "open", { role: "tracker" }), node(child, "open", { parent: tracker, observed: false })],
  });
  const projected = result.projection?.issues.find((entry) => entry.reference.number === 40);
  assert.equal(result.valid, false);
  assert.equal(projected?.childrenEvidence, "unavailable");
  assert.equal(projected?.completion.status, "unknown");
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "EVIDENCE_UNAVAILABLE"));
});

test("existing Issues without lifecycle declarations remain compatible", () => {
  const result = tryProjectSemanticIssueLifecycle({ issues: [node(issue(50), "closed")] });
  const projected = result.projection?.issues[0];
  assert.equal(result.valid, true);
  assert.equal(projected?.role, undefined);
  assert.equal(projected?.completion.status, "not-declared");
  assert.deepEqual(projected?.children, []);
  assert.deepEqual(projected?.supersededBy, []);
});

test("reads lifecycle role and supersession from the existing Semantic Artifact values", () => {
  const replacement = issue(71);
  const superseded = issue(72);
  const artifact = {
    version: "1",
    effectiveContractVersion: "1",
    artifactContractVersion: "1",
    kind: "issue",
    id: "lifecycle",
    values: { role: "leaf", supersedes: [superseded] },
    fields: {},
    provenance: {},
    generation: {},
  } as unknown as SemanticArtifact;
  const result = tryProjectSemanticIssueLifecycle({
    issues: [{ reference: replacement, artifact, observed: observed(replacement, "open") }, node(superseded, "closed")],
  });
  assert.equal(result.valid, true);
  assert.equal(result.projection?.issues[0]?.role, "leaf");
  assert.deepEqual(result.projection?.issues[1]?.supersededBy, [replacement]);
});

test("reports conflicting observed relation evidence instead of guessing", () => {
  const result = tryProjectSemanticIssueLifecycle({ issues: [node(issue(60), "open", { conflict: true })] });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "RELATION_CONFLICT"));
  assert.equal(result.projection?.issues[0]?.parentEvidence, "unavailable");
});

test("orders equivalent lifecycle projections independently of input order", () => {
  const parent = issue(80);
  const child = issue(81);
  const nodes = [node(child, "closed", { parent }), node(parent, "open", { role: "tracker" })];
  const first = tryProjectSemanticIssueLifecycle({ issues: nodes });
  const second = tryProjectSemanticIssueLifecycle({ issues: [...nodes].reverse() });
  assert.equal(first.valid, true);
  assert.equal(second.valid, true);
  assert.deepEqual(first.projection, second.projection);
});
