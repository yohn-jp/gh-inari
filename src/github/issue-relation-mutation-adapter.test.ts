import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitHubApiFieldValue, GitHubApiResponse } from "./adapter.js";
import type { RepositoryContext } from "./types.js";
import {
  GitHubIssueRelationMutationAdapter,
  GitHubIssueRelationMutationError,
  type IssueRelationApiMutator,
} from "./issue-relation-mutation-adapter.js";
import type { IssueReference } from "../contract/issue-reference.js";

const CONTEXT: RepositoryContext = Object.freeze({
  hostname: "github.com",
  host: "github.com",
  owner: "yohn-jp",
  name: "gh-inari",
  nameWithOwner: "yohn-jp/gh-inari",
  url: "https://github.com/yohn-jp/gh-inari",
  repositoryId: "100000157",
});

const CAPABILITIES = Object.freeze({ parent: true, blockedBy: true });

function reference(number: number, repositoryId = CONTEXT.repositoryId): IssueReference {
  return {
    repositoryHost: CONTEXT.hostname,
    repositoryId: repositoryId as string,
    repository: CONTEXT.nameWithOwner,
    number,
  };
}

interface Call {
  readonly path: string;
  readonly method: string;
  readonly fields?: Readonly<Record<string, GitHubApiFieldValue>>;
}

class StubMutator implements IssueRelationApiMutator {
  readonly calls: Call[] = [];
  private readonly responses: Array<GitHubApiResponse | Error>;

  constructor(responses: Array<GitHubApiResponse | Error>) {
    this.responses = [...responses];
  }

  async requestRepositoryApi(
    path: string,
    method = "GET",
    fields: Readonly<Record<string, GitHubApiFieldValue>> = {},
  ): Promise<GitHubApiResponse> {
    this.calls.push({ path, method, ...(Object.keys(fields).length === 0 ? {} : { fields }) });
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected API call: ${method} ${path}`);
    if (response instanceof Error) throw response;
    return response;
  }
}

function issueIdentity(id: number, number = id): GitHubApiResponse {
  return { status: 200, body: { id, number } };
}

const OTHER_REPO: RepositoryContext = Object.freeze({
  hostname: "github.com",
  host: "github.com",
  owner: "yohn-jp",
  name: "other-repo",
  nameWithOwner: "yohn-jp/other-repo",
  url: "https://github.com/yohn-jp/other-repo",
  repositoryId: "200000900",
});

test("projects parent and blocked-by effects onto the documented native endpoints", async () => {
  const mutator = new StubMutator([
    issueIdentity(501, 10),
    { status: 201, body: undefined },
    { status: 200, body: {} },
    issueIdentity(502, 30),
    { status: 201, body: undefined },
    { status: 200, body: {} },
  ]);
  const adapter = new GitHubIssueRelationMutationAdapter(mutator, CONTEXT, CAPABILITIES);
  const child = reference(10);
  const parent = reference(20);
  const blocker = reference(30);

  await adapter.setParent(child, parent);
  await adapter.clearParent(child, parent);
  await adapter.addBlockedBy(child, blocker);
  await adapter.removeBlockedBy(child, blocker);

  assert.deepEqual(mutator.calls, [
    { path: "issues/10", method: "GET" },
    { path: "issues/20/sub_issues", method: "POST", fields: { sub_issue_id: 501 } },
    { path: "issues/20/sub_issue", method: "DELETE", fields: { sub_issue_id: 501 } },
    { path: "issues/30", method: "GET" },
    { path: "issues/10/dependencies/blocked_by", method: "POST", fields: { issue_id: 502 } },
    { path: "issues/10/dependencies/blocked_by/502", method: "DELETE" },
  ]);
});

test("executes one Core relation effect and requires a bounded clear parent", async () => {
  const mutator = new StubMutator([issueIdentity(501, 10), { status: 201, body: undefined }]);
  const adapter = new GitHubIssueRelationMutationAdapter(mutator, CONTEXT, CAPABILITIES);
  await adapter.execute({ kind: "SET_PARENT_RELATION", parent: reference(20) }, reference(10));
  await assert.rejects(
    () => adapter.execute({ kind: "CLEAR_PARENT_RELATION" }, reference(10)),
    (error: unknown) =>
      error instanceof GitHubIssueRelationMutationError &&
      error.code === "RELATION_MUTATION_INVALID" &&
      error.path === "effect.previousParent",
  );
});

test("fails closed before network I/O for unsupported or cross-repository relations", async () => {
  const unsupported = new StubMutator([]);
  const unsupportedAdapter = new GitHubIssueRelationMutationAdapter(unsupported, CONTEXT, {
    parent: false,
    blockedBy: false,
  });
  await assert.rejects(
    () => unsupportedAdapter.addBlockedBy(reference(10), reference(20)),
    (error: unknown) =>
      error instanceof GitHubIssueRelationMutationError && error.code === "RELATION_MUTATION_UNSUPPORTED",
  );
  assert.equal(unsupported.calls.length, 0);

  const crossRepository = new StubMutator([]);
  const crossRepositoryAdapter = new GitHubIssueRelationMutationAdapter(crossRepository, CONTEXT, CAPABILITIES);
  await assert.rejects(
    () => crossRepositoryAdapter.setParent(reference(10), reference(20, "999999")),
    (error: unknown) =>
      error instanceof GitHubIssueRelationMutationError && error.code === "RELATION_MUTATION_UNSUPPORTED",
  );
  assert.equal(crossRepository.calls.length, 0);
});

test("rejects the legacy 204 response for native relation removal", async () => {
  // GitHub's real contract returns 200 on a successful sub_issue/blocked_by
  // DELETE; a 204 here must not be accepted as success (see #443).
  const staleParent = new StubMutator([issueIdentity(501, 10), { status: 204, body: undefined }]);
  const staleParentAdapter = new GitHubIssueRelationMutationAdapter(staleParent, CONTEXT, CAPABILITIES);
  await assert.rejects(
    () => staleParentAdapter.clearParent(reference(10), reference(20)),
    (error: unknown) =>
      error instanceof GitHubIssueRelationMutationError && error.code === "RELATION_MUTATION_RESPONSE_INVALID",
  );

  const staleBlockedBy = new StubMutator([issueIdentity(502, 30), { status: 204, body: undefined }]);
  const staleBlockedByAdapter = new GitHubIssueRelationMutationAdapter(staleBlockedBy, CONTEXT, CAPABILITIES);
  await assert.rejects(
    () => staleBlockedByAdapter.removeBlockedBy(reference(10), reference(30)),
    (error: unknown) =>
      error instanceof GitHubIssueRelationMutationError && error.code === "RELATION_MUTATION_RESPONSE_INVALID",
  );
});

function otherRepoReference(number: number): IssueReference {
  return {
    repositoryHost: OTHER_REPO.hostname,
    repositoryId: OTHER_REPO.repositoryId as string,
    repository: OTHER_REPO.nameWithOwner,
    number,
  };
}

test("setParent fails closed for a same-owner cross-repository target before network I/O", async () => {
  const mutator = new StubMutator([]);
  const adapter = new GitHubIssueRelationMutationAdapter(mutator, CONTEXT, CAPABILITIES);
  await assert.rejects(
    () => adapter.setParent(reference(10), otherRepoReference(20)),
    (error: unknown) =>
      error instanceof GitHubIssueRelationMutationError && error.code === "RELATION_MUTATION_UNSUPPORTED",
  );
  assert.equal(mutator.calls.length, 0);
});

test("rejects malformed identity and unexpected mutation status", async () => {
  const malformed = new StubMutator([{ status: 200, body: { id: "not-an-id" } }]);
  const malformedAdapter = new GitHubIssueRelationMutationAdapter(malformed, CONTEXT, CAPABILITIES);
  await assert.rejects(
    () => malformedAdapter.addBlockedBy(reference(10), reference(20)),
    (error: unknown) =>
      error instanceof GitHubIssueRelationMutationError && error.code === "RELATION_MUTATION_RESPONSE_INVALID",
  );

  const unexpected = new StubMutator([issueIdentity(501, 10), { status: 200, body: undefined }]);
  const unexpectedAdapter = new GitHubIssueRelationMutationAdapter(unexpected, CONTEXT, CAPABILITIES);
  await assert.rejects(
    () => unexpectedAdapter.setParent(reference(10), reference(20)),
    (error: unknown) =>
      error instanceof GitHubIssueRelationMutationError &&
      error.code === "RELATION_MUTATION_RESPONSE_INVALID" &&
      error.status === 200,
  );
});
