import assert from "node:assert/strict";
import { test } from "node:test";
import { ContractViolationError } from "./errors.js";
import type { GitHubApiResponse } from "./adapter.js";
import type { RepositoryContext } from "./types.js";
import {
  GitHubIssueRelationObservationAdapter,
  type IssueRelationApiReader,
} from "./issue-relation-observation-adapter.js";

const CONTEXT: RepositoryContext = Object.freeze({
  hostname: "github.com",
  host: "github.com",
  owner: "yohn-jp",
  name: "gh-inari",
  nameWithOwner: "yohn-jp/gh-inari",
  url: "https://github.com/yohn-jp/gh-inari",
  repositoryId: "100000157",
});

interface RecordedCall {
  readonly repositoryPath: string;
}

class StubReader implements IssueRelationApiReader {
  readonly calls: RecordedCall[] = [];
  private readonly responses: Array<GitHubApiResponse | Error>;

  constructor(responses: Array<GitHubApiResponse | Error>) {
    this.responses = [...responses];
  }

  async requestRepositoryApi(repositoryPath: string): Promise<GitHubApiResponse> {
    this.calls.push({ repositoryPath });
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected repository API call: ${repositoryPath}`);
    if (response instanceof Error) throw response;
    return response;
  }
}

function issueBody(number: number, repository = "yohn-jp/gh-inari", host = "api.github.com"): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    html_url: `https://github.com/${repository}/issues/${number}`,
    repository_url: `https://${host}/repos/${repository}`,
  };
}

test("observeParent requests the bounded parent read seam", async () => {
  const reader = new StubReader([{ status: 200, body: issueBody(278) }]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  await adapter.observeParent(288);
  assert.deepEqual(reader.calls, [{ repositoryPath: "issues/288/parent" }]);
});

test("observeParent returns present with a normalized IssueReference", async () => {
  const reader = new StubReader([{ status: 200, body: issueBody(278) }]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  const observation = await adapter.observeParent(288);
  assert.deepEqual(observation, {
    kind: "present",
    reference: { repositoryHost: "github.com", repositoryId: "100000157", repository: "yohn-jp/gh-inari", number: 278 },
    diagnostics: [],
  });
});

test("observeParent returns empty on 404 (no parent set)", async () => {
  const reader = new StubReader([{ status: 404, body: undefined }]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  const observation = await adapter.observeParent(288);
  assert.deepEqual(observation, { kind: "empty", reference: undefined, diagnostics: [] });
});

test("observeParent returns malformed when the response body is not an object", async () => {
  const reader = new StubReader([{ status: 200, body: "not-an-object" }]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  const observation = await adapter.observeParent(288);
  assert.equal(observation.kind, "malformed");
  assert.equal(observation.reference, undefined);
  assert.equal(observation.diagnostics.length, 1);
  assert.equal(observation.diagnostics[0]?.code, "RELATION_RESPONSE_MALFORMED");
});

test("observeParent returns malformed when the Issue number is invalid", async () => {
  const reader = new StubReader([{ status: 200, body: { ...issueBody(278), number: -1 } }]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  const observation = await adapter.observeParent(288);
  assert.equal(observation.kind, "malformed");
  assert.equal(observation.diagnostics[0]?.code, "RELATION_ENTRY_MALFORMED");
});

test("observeParent returns unavailable when the parent belongs to a different repository", async () => {
  const reader = new StubReader([{ status: 200, body: issueBody(9, "yohn-jp/other-repo") }]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  const observation = await adapter.observeParent(288);
  assert.equal(observation.kind, "unavailable");
  assert.equal(observation.reference, undefined);
  assert.equal(observation.diagnostics[0]?.code, "RELATION_REPOSITORY_UNRESOLVED");
});

test("observeParent returns unavailable when repository_url is missing", async () => {
  const body = issueBody(9);
  delete body.repository_url;
  const reader = new StubReader([{ status: 200, body }]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  const observation = await adapter.observeParent(288);
  assert.equal(observation.kind, "unavailable");
});

test("observeParent returns unavailable when the repository context lacks a repositoryId", async () => {
  const contextWithoutId: RepositoryContext = { ...CONTEXT, repositoryId: undefined };
  const reader = new StubReader([{ status: 200, body: issueBody(278) }]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, contextWithoutId);
  const observation = await adapter.observeParent(288);
  assert.equal(observation.kind, "unavailable");
});

test("observeParent returns unavailable when the read itself fails", async () => {
  const reader = new StubReader([new Error("gh: transport failed")]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  const observation = await adapter.observeParent(288);
  assert.equal(observation.kind, "unavailable");
  assert.equal(observation.diagnostics[0]?.code, "RELATION_READ_FAILED");
  assert.equal(observation.diagnostics[0]?.message, "gh: transport failed");
});

test("observeParent rejects an invalid Issue number before reading", async () => {
  const reader = new StubReader([]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  await assert.rejects(() => adapter.observeParent(0), ContractViolationError);
  assert.equal(reader.calls.length, 0);
});

test("observeBlockedBy requests the bounded dependency read seam", async () => {
  const reader = new StubReader([{ status: 200, body: [] }]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  await adapter.observeBlockedBy(288);
  assert.deepEqual(reader.calls, [{ repositoryPath: "issues/288/dependencies/blocked_by?per_page=100" }]);
});

test("observeBlockedBy returns empty on 404", async () => {
  const reader = new StubReader([{ status: 404, body: undefined }]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  const observation = await adapter.observeBlockedBy(288);
  assert.deepEqual(observation, { kind: "empty", references: [], diagnostics: [] });
});

test("observeBlockedBy returns empty on a valid empty array", async () => {
  const reader = new StubReader([{ status: 200, body: [] }]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  const observation = await adapter.observeBlockedBy(288);
  assert.deepEqual(observation, { kind: "empty", references: [], diagnostics: [] });
});

test("observeBlockedBy returns present with every normalized IssueReference", async () => {
  const reader = new StubReader([{ status: 200, body: [issueBody(10), issueBody(11)] }]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  const observation = await adapter.observeBlockedBy(288);
  assert.equal(observation.kind, "present");
  assert.deepEqual(observation.diagnostics, []);
  assert.deepEqual(
    observation.references.map((reference) => reference.number),
    [10, 11],
  );
  for (const reference of observation.references) {
    assert.equal(reference.repositoryHost, "github.com");
    assert.equal(reference.repositoryId, "100000157");
  }
});

test("observeBlockedBy returns malformed when the response body is not an array", async () => {
  const reader = new StubReader([{ status: 200, body: { not: "an array" } }]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  const observation = await adapter.observeBlockedBy(288);
  assert.equal(observation.kind, "malformed");
  assert.deepEqual(observation.references, []);
  assert.equal(observation.diagnostics[0]?.code, "RELATION_RESPONSE_MALFORMED");
});

test("observeBlockedBy returns malformed when any entry is malformed, even alongside valid entries", async () => {
  const reader = new StubReader([{ status: 200, body: [issueBody(10), { number: "not-a-number" }] }]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  const observation = await adapter.observeBlockedBy(288);
  assert.equal(observation.kind, "malformed");
  assert.deepEqual(observation.references, []);
  assert.equal(observation.diagnostics.length, 1);
  assert.equal(observation.diagnostics[0]?.code, "RELATION_ENTRY_MALFORMED");
  assert.equal(observation.diagnostics[0]?.path, "$[1].number");
});

test("observeBlockedBy returns unavailable when an entry's repository cannot be resolved", async () => {
  const reader = new StubReader([{ status: 200, body: [issueBody(10), issueBody(20, "yohn-jp/other-repo")] }]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  const observation = await adapter.observeBlockedBy(288);
  assert.equal(observation.kind, "unavailable");
  assert.deepEqual(observation.references, []);
  assert.equal(observation.diagnostics.length, 1);
  assert.equal(observation.diagnostics[0]?.code, "RELATION_REPOSITORY_UNRESOLVED");
  assert.equal(observation.diagnostics[0]?.path, "$[1]");
});

test("observeBlockedBy returns unavailable when the read itself fails", async () => {
  const reader = new StubReader([new Error("gh: not authenticated")]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  const observation = await adapter.observeBlockedBy(288);
  assert.equal(observation.kind, "unavailable");
  assert.equal(observation.diagnostics[0]?.code, "RELATION_READ_FAILED");
});

test("observeBlockedBy rejects an invalid Issue number before reading", async () => {
  const reader = new StubReader([]);
  const adapter = new GitHubIssueRelationObservationAdapter(reader, CONTEXT);
  await assert.rejects(() => adapter.observeBlockedBy(1.5), ContractViolationError);
  assert.equal(reader.calls.length, 0);
});
