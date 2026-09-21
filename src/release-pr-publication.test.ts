import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createReleasePrPublicationRequest,
  deriveReleasePrPublicationRoute,
  publishReleasePullRequest,
} from "./release-pr-publication.js";
import { publishPullRequest, type PrPublicationProvider, type PrPublicationRecord } from "./pr-publication.js";

const repository = { repositoryHost: "github.com", repositoryId: "100", repository: "acme/inari" } as const;
const sourceRevision = "a".repeat(40);
const title = "Release 1.2.3";
const body = "# Release 1.2.3\n\nRelease notes.";

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...createReleasePrPublicationRequest({ repository, targetVersion: "1.2.3", sourceRevision, title, body }),
    ...overrides,
  };
}

function provider(
  initial: readonly PrPublicationRecord[] = [],
  uncertain = false,
): PrPublicationProvider & { calls: string[] } {
  const state = [...initial];
  const calls: string[] = [];
  return {
    calls,
    async getRepositoryIdentity() {
      return repository;
    },
    async listPullRequests() {
      calls.push("list");
      return state;
    },
    async readPullRequest(number) {
      calls.push(`read:${number}`);
      const value = state.find((entry) => entry.number === number);
      if (value === undefined) throw new Error("not found");
      return value;
    },
    async createPullRequest(input) {
      calls.push("create");
      const value: PrPublicationRecord = {
        number: 42,
        url: "https://github.com/acme/inari/pull/42",
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        headRevision: input.headRevision,
        repository,
      };
      state.push(value);
      if (uncertain) throw new Error("transport timeout");
      return value;
    },
  };
}

function existing(overrides: Partial<PrPublicationRecord> = {}): PrPublicationRecord {
  return {
    number: 42,
    url: "https://github.com/acme/inari/pull/42",
    title,
    body,
    head: "release/1.2.3",
    base: "main",
    headRevision: sourceRevision,
    repository,
    ...overrides,
  };
}

test("release handoff derives an Issue-less exact route and identity", () => {
  const route = deriveReleasePrPublicationRoute("1.2.3", sourceRevision);
  assert.deepEqual(
    { role: route.role, head: route.head, base: route.base, headRevision: route.headRevision },
    { role: "release", head: "release/1.2.3", base: "main", headRevision: sourceRevision },
  );
  const publication = createReleasePrPublicationRequest({
    repository,
    targetVersion: "1.2.3",
    sourceRevision,
    title,
    body,
  });
  assert.deepEqual(publication.workIdentity, { release: { targetVersion: "1.2.3", sourceRevision } });
  assert.equal("implementation" in publication.workIdentity, false);
  assert.equal("sourceIssue" in publication.workIdentity, false);
});

test("release route rejects mismatched version, head, base, and source revision before create", async () => {
  const cases = [
    { ...request({ expectedHead: "release/1.2.4" }) },
    { ...request({ expectedBase: "develop" }) },
    { ...request({ headRevision: "b".repeat(40) }) },
    { ...request({ routing: { ...(request().routing as object), targetVersion: "1.2.4" } }) },
  ];
  for (const input of cases) {
    const current = provider();
    const result = await publishPullRequest(input, current);
    assert.equal(result.classification, "failed");
    assert.equal(current.calls.length, 0);
  }
});

test("exact release retry returns the existing Issue-less PR", async () => {
  const current = provider([existing()]);
  const result = await publishReleasePullRequest(
    { repository, targetVersion: "1.2.3", sourceRevision, title, body },
    current,
  );
  assert.equal(result.classification, "returned-existing");
  assert.equal(result.pullRequest?.number, 42);
  assert.deepEqual(current.calls, ["list"]);
});

test("conflicting release PR state fails closed", async () => {
  const current = provider([existing({ body: `${body}\nchanged` })]);
  const result = await publishReleasePullRequest(
    { repository, targetVersion: "1.2.3", sourceRevision, title, body },
    current,
  );
  assert.equal(result.classification, "failed");
  assert.ok(result.diagnostics.some((entry) => entry.code === "PR_PUBLICATION_CONFLICTING_MATCH"));
  assert.deepEqual(current.calls, ["list"]);
});

test("uncertain release create rereads authoritatively without a duplicate create", async () => {
  const current = provider([], true);
  const result = await publishReleasePullRequest(
    { repository, targetVersion: "1.2.3", sourceRevision, title, body },
    current,
  );
  assert.equal(result.classification, "returned-existing");
  assert.deepEqual(current.calls, ["list", "create", "list"]);
});
