import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitHubApiFieldValue, GitHubApiResponse } from "./github/adapter.js";
import {
  GitHubIssueRelationMutationAdapter,
  type IssueRelationApiMutator,
} from "./github/issue-relation-mutation-adapter.js";
import type { RepositoryContext } from "./github/types.js";
import { IssueRelationshipExecutorError, LocalIssueRelationshipExecutor } from "./issue-relationship-executor.js";

const CONTEXT: RepositoryContext = Object.freeze({
  hostname: "github.com",
  host: "github.com",
  owner: "acme",
  name: "inari",
  nameWithOwner: "acme/inari",
  url: "https://github.com/acme/inari",
  repositoryId: "100",
});

function issue(number: number): Record<string, unknown> {
  return {
    id: number + 1000,
    number,
    repository_url: "https://api.github.com/repos/acme/inari",
  };
}

class StatefulMutator implements IssueRelationApiMutator {
  readonly calls: Array<{ readonly path: string; readonly method: string }> = [];
  readonly parents = new Map<number, number>();
  readonly issueIds = new Map<number, number>();
  sabotageNextPostcondition = false;

  constructor() {
    for (let number = 1; number <= 100; number += 1) this.issueIds.set(number, number + 1000);
  }

  async requestRepositoryApi(
    path: string,
    method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
    fields: Readonly<Record<string, GitHubApiFieldValue>> = {},
  ): Promise<GitHubApiResponse> {
    this.calls.push({ path, method });
    const issueMatch = /^issues\/(\d+)(?:\/|$)/u.exec(path);
    const issueNumber = issueMatch === null ? undefined : Number(issueMatch[1]);
    if (method === "GET" && /^issues\/\d+$/u.test(path))
      return { status: 200, body: { id: this.issueIds.get(issueNumber as number), number: issueNumber } };
    if (method === "GET" && issueNumber !== undefined && path.endsWith("/parent")) {
      const parent = this.parents.get(issueNumber);
      return parent === undefined ? { status: 404, body: undefined } : { status: 200, body: issue(parent) };
    }
    if (method === "GET" && issueNumber !== undefined && path.includes("/sub_issues?")) {
      const children = [...this.parents.entries()]
        .filter(([, parent]) => parent === issueNumber)
        .map(([child]) => issue(child));
      return { status: 200, body: children };
    }
    if (method === "POST" && issueNumber !== undefined && path.endsWith("/sub_issues")) {
      if (!this.sabotageNextPostcondition) {
        const childId = Number(fields.sub_issue_id);
        const child = [...this.issueIds.entries()].find(([, id]) => id === childId)?.[0];
        if (child !== undefined) this.parents.set(child, issueNumber);
      }
      this.sabotageNextPostcondition = false;
      return { status: 201, body: undefined };
    }
    if (method === "DELETE" && issueNumber !== undefined && path.endsWith("/sub_issue")) {
      const childId = Number(fields.sub_issue_id);
      const child = [...this.issueIds.entries()].find(([, id]) => id === childId)?.[0];
      if (child !== undefined && this.parents.get(child) === issueNumber) this.parents.delete(child);
      return { status: 200, body: undefined };
    }
    throw new Error(`Unexpected API request ${method} ${path}`);
  }
}

function executor(mutator: StatefulMutator): LocalIssueRelationshipExecutor {
  const adapter = new GitHubIssueRelationMutationAdapter(mutator, CONTEXT, {
    parent: true,
    children: true,
    blockedBy: false,
  });
  return new LocalIssueRelationshipExecutor({ adapter, context: CONTEXT });
}

test("executes attach, idempotent replay, and explicit reparent with verified inverse reads", async () => {
  const mutator = new StatefulMutator();
  const relationExecutor = executor(mutator);
  const attached = await relationExecutor.execute({ operation: "attach", child: 10, parent: 20 });
  assert.equal(attached.evidence.outcome, "verified");
  assert.equal(mutator.parents.get(10), 20);

  const replay = await relationExecutor.execute({ operation: "attach", child: 10, parent: 20 });
  assert.equal(replay.evidence.outcome, "idempotent");

  const reparented = await relationExecutor.execute({
    operation: "reparent",
    child: 10,
    previousParent: 20,
    parent: 30,
  });
  assert.equal(reparented.evidence.outcome, "verified");
  assert.equal(mutator.parents.get(10), 30);
  assert.ok(mutator.calls.some((entry) => entry.method === "DELETE" && entry.path === "issues/20/sub_issue"));
  assert.ok(mutator.calls.some((entry) => entry.method === "POST" && entry.path === "issues/30/sub_issues"));
});

test("fails closed for cycles and provider postcondition mismatch", async () => {
  const cycleMutator = new StatefulMutator();
  cycleMutator.parents.set(30, 10);
  await assert.rejects(
    () => executor(cycleMutator).execute({ operation: "attach", child: 10, parent: 30 }),
    (error: unknown) =>
      error instanceof IssueRelationshipExecutorError &&
      error.diagnostics.some((entry) => entry.code === "RELATION_PARENT_CYCLE"),
  );

  const mismatchMutator = new StatefulMutator();
  mismatchMutator.sabotageNextPostcondition = true;
  await assert.rejects(
    () => executor(mismatchMutator).execute({ operation: "attach", child: 10, parent: 20 }),
    (error: unknown) =>
      error instanceof IssueRelationshipExecutorError && error.code === "ISSUE_RELATIONSHIP_POSTCONDITION_FAILED",
  );
});
