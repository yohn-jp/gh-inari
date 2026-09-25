import assert from "node:assert/strict";
import { test } from "node:test";
import { publishPullRequest, type PrPublicationProvider, type PrPublicationRecord } from "./pr-publication.js";

const repository = { repositoryHost: "github.com", repositoryId: "100", repository: "acme/inari" } as const;
const implementation = { ...repository, number: 700 } as const;
const sourceIssue = { ...repository, number: 680 } as const;
const epic = { ...repository, number: 640 } as const;

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    kind: "pr-publication",
    repository,
    workIdentity: { implementation },
    routing: {
      version: 1,
      kind: "integration-routing",
      mode: "issue-integration",
      role: "implementation",
      implementation,
      sourceIssue,
      epic,
      relationships: { implementationParent: sourceIssue, sourceIssueParent: epic },
      branches: {
        default: "main",
        implementation: "feat/700-publication",
        issue: "issue/680-integration",
        epic: "epic/640-integration",
      },
      head: "feat/700-publication",
      base: "issue/680-integration",
    },
    headRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    title: "feat: publish governed work",
    body: "Closes #700",
    ...overrides,
  };
}

function fakeProvider(
  initial: readonly PrPublicationRecord[] = [],
  options: { readonly uncertain?: boolean } = {},
): PrPublicationProvider & { readonly calls: string[] } {
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
      const found = state.find((entry) => entry.number === number);
      if (found === undefined) throw new Error("not found");
      return found;
    },
    async createPullRequest(input) {
      calls.push("create");
      const created: PrPublicationRecord = {
        number: 42,
        url: "https://github.com/acme/inari/pull/42",
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        headRevision: input.headRevision,
        repository,
      };
      if (!options.uncertain) state.push(created);
      if (options.uncertain) {
        state.push(created);
        throw new Error("transport timeout");
      }
      return created;
    },
  };
}

test("correct governed route creates exactly one PR and verifies it", async () => {
  const provider = fakeProvider();
  const result = await publishPullRequest(request(), provider);
  assert.equal(result.classification, "created");
  assert.equal(result.pullRequest?.number, 42);
  assert.deepEqual(provider.calls, ["list", "create", "read:42"]);
});

test("exact retry returns the existing identity without creating again", async () => {
  const existing: PrPublicationRecord = {
    number: 42,
    url: "https://github.com/acme/inari/pull/42",
    title: "feat: publish governed work",
    body: "Closes #700",
    head: "feat/700-publication",
    base: "issue/680-integration",
    headRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    repository,
  };
  const provider = fakeProvider([existing]);
  const result = await publishPullRequest(request(), provider);
  assert.equal(result.classification, "returned-existing");
  assert.equal(result.pullRequest?.number, 42);
  assert.deepEqual(provider.calls, ["list"]);
});

test("wrong work identity and route refs fail before create", async () => {
  const provider = fakeProvider();
  const result = await publishPullRequest(
    request({
      workIdentity: { implementation: { ...repository, number: 701 } },
      expectedHead: "feat/701-wrong",
    }),
    provider,
  );
  assert.equal(result.classification, "failed");
  assert.equal(provider.calls.length, 0);
});

test("an alternative repository convention publishes its exact head to a non-main default base", async () => {
  const provider = fakeProvider();
  const route = {
    version: 1,
    kind: "integration-routing",
    mode: "standalone",
    role: "implementation",
    implementation,
    branches: { default: "trunk", implementation: "story/700-alternative-policy" },
  };
  const result = await publishPullRequest(request({ routing: route }), provider);
  assert.equal(result.classification, "created", JSON.stringify(result.diagnostics));
  const routing = result.routing as { expectedHead?: string; expectedBase?: string } | undefined;
  assert.deepEqual([routing?.expectedHead, routing?.expectedBase], ["story/700-alternative-policy", "trunk"]);
  for (const expectedHead of ["story/701-other", "trunk"]) {
    const denied = fakeProvider();
    const failed = await publishPullRequest(request({ routing: route, expectedHead }), denied);
    assert.equal(failed.classification, "failed", expectedHead);
    assert.equal(denied.calls.length, 0);
  }
});

test("multiple and conflicting matches fail closed", async () => {
  const first: PrPublicationRecord = {
    number: 42,
    url: "https://github.com/acme/inari/pull/42",
    title: "one",
    body: "Closes #700",
    head: "feat/700-publication",
    base: "issue/680-integration",
    headRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    repository,
  };
  const second = { ...first, number: 43, url: "https://github.com/acme/inari/pull/43" };
  const provider = fakeProvider([first, second]);
  const result = await publishPullRequest(request(), provider);
  assert.equal(result.classification, "failed");
  assert.ok(result.diagnostics.some((entry) => entry.code === "PR_PUBLICATION_AMBIGUOUS_MATCH"));
  assert.deepEqual(provider.calls, ["list"]);
});

test("uncertain create rereads and returns the one provider-created PR", async () => {
  const provider = fakeProvider([], { uncertain: true });
  const result = await publishPullRequest(request(), provider);
  assert.equal(result.classification, "returned-existing");
  assert.equal(result.pullRequest?.number, 42);
  assert.deepEqual(provider.calls, ["list", "create", "list"]);
});
