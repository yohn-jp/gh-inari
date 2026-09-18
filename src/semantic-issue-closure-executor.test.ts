import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueReference } from "./contract/issue-reference.js";
import { planSemanticIssueClosure, type SemanticIssueClosureEvidenceInput } from "./semantic-issue-closure.js";
import {
  LocalSemanticIssueClosureExecutor,
  SemanticIssueClosureExecutorError,
  type SemanticIssueClosureProvider,
} from "./semantic-issue-closure-executor.js";

const target: IssueReference = {
  repositoryHost: "github.com",
  repositoryId: "100",
  repository: "acme/inari",
  number: 10,
};

function evidence(
  state: "open" | "closed",
  implementation: Record<string, unknown> = {},
): SemanticIssueClosureEvidenceInput {
  return {
    lifecycle: {
      scope: "complete",
      issues: [
        {
          reference: target,
          observed: {
            version: "1",
            kind: "issue",
            number: target.number,
            state,
            title: "Issue 10",
            body: "",
            metadata: {},
            relations: {
              parent: { relation: "parent", representation: "none", evidence: {} },
              dependsOn: {
                relation: "dependsOn",
                references: [],
                representation: "none",
                evidence: { bodyFallback: [] },
              },
            },
          },
          declaration: { role: "leaf" },
        },
      ],
    },
    implementation: {
      valid: true,
      status: "completed",
      authorized: true,
      current: true,
      authorization: { implementation: target },
      violations: [],
      ...implementation,
    },
  };
}

class Provider implements SemanticIssueClosureProvider {
  readonly calls: string[] = [];
  current: SemanticIssueClosureEvidenceInput;
  readonly postState: { number: number; state: "open" | "closed" };

  constructor(current = evidence("open"), postState: "open" | "closed" = "closed") {
    this.current = current;
    this.postState = { number: target.number, state: postState };
  }

  async readEvidence(): Promise<SemanticIssueClosureEvidenceInput> {
    this.calls.push("readEvidence");
    return this.current;
  }

  async closeIssue(): Promise<void> {
    this.calls.push("closeIssue");
    this.current = evidence("closed");
  }

  async readState(): Promise<unknown> {
    this.calls.push("readState");
    return this.postState;
  }
}

function plan() {
  return planSemanticIssueClosure({ target, intent: "close", ...evidence("open") });
}

test("close executor rereads, applies one explicit effect, and verifies provider state", async () => {
  const provider = new Provider();
  const result = await new LocalSemanticIssueClosureExecutor({ provider }).execute({ version: "1", plan: plan() });
  assert.equal(result.outcome, "verified");
  assert.deepEqual(provider.calls, ["readEvidence", "closeIssue", "readState"]);
});

test("close executor rejects stale reread evidence before the effect", async () => {
  const provider = new Provider(evidence("open", { current: false, authorized: false }));
  await assert.rejects(
    new LocalSemanticIssueClosureExecutor({ provider }).execute({ version: "1", plan: plan() }),
    (error: unknown) =>
      error instanceof SemanticIssueClosureExecutorError &&
      error.code === "SEMANTIC_ISSUE_CLOSURE_EXECUTION_STALE" &&
      !provider.calls.includes("closeIssue"),
  );
});

test("already-closed retry is idempotent only for compatible evidence", async () => {
  const provider = new Provider();
  const executor = new LocalSemanticIssueClosureExecutor({ provider });
  const request = { version: "1" as const, plan: plan() };
  await executor.execute(request);
  const retry = await executor.execute(request);
  assert.equal(retry.outcome, "idempotent");
  assert.deepEqual(provider.calls, ["readEvidence", "closeIssue", "readState", "readEvidence"]);

  const incompatible = new Provider(evidence("closed", { current: false, authorized: false }));
  await assert.rejects(
    new LocalSemanticIssueClosureExecutor({ provider: incompatible }).execute(request),
    (error: unknown) =>
      error instanceof SemanticIssueClosureExecutorError &&
      error.code === "SEMANTIC_ISSUE_CLOSURE_EXECUTION_STALE" &&
      !incompatible.calls.includes("closeIssue"),
  );
});

test("close executor fails when post-close provider state is not closed", async () => {
  const provider = new Provider(evidence("open"), "open");
  await assert.rejects(
    new LocalSemanticIssueClosureExecutor({ provider }).execute({ version: "1", plan: plan() }),
    (error: unknown) =>
      error instanceof SemanticIssueClosureExecutorError &&
      error.code === "SEMANTIC_ISSUE_CLOSURE_EXECUTION_POSTCONDITION_FAILED",
  );
});
