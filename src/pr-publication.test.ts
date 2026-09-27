import assert from "node:assert/strict";
import { test } from "node:test";
import {
  publishPullRequest,
  tryValidatePrPublicationRequest,
  type PrPublicationProvider,
  type PrPublicationRecord,
} from "./pr-publication.js";

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

function integrationRequest(
  role: "issue-integration" | "epic-integration",
  overrides: Record<string, unknown> = {},
  topology: {
    readonly source?: {
      readonly repositoryHost: string;
      readonly repositoryId: string;
      readonly repository?: string;
      readonly number: number;
    };
    readonly parentEpic?: {
      readonly repositoryHost: string;
      readonly repositoryId: string;
      readonly repository?: string;
      readonly number: number;
    };
  } = {},
): Record<string, unknown> {
  const selectedSource = topology.source ?? sourceIssue;
  const selectedEpic = topology.parentEpic ?? epic;
  const routing = {
    version: 1,
    kind: "integration-routing",
    mode: "issue-integration",
    role,
    implementation,
    sourceIssue: selectedSource,
    epic: selectedEpic,
    relationships: { implementationParent: selectedSource, sourceIssueParent: selectedEpic },
    branches: {
      default: "main",
      implementation: "feat/700-publication",
      issue: `issue/${selectedSource.number}-source-routing`,
      epic: `epic/${selectedEpic.number}-dashboard`,
    },
    head:
      role === "issue-integration"
        ? `issue/${selectedSource.number}-source-routing`
        : `epic/${selectedEpic.number}-dashboard`,
    base: role === "issue-integration" ? `epic/${selectedEpic.number}-dashboard` : "main",
  };
  const workIdentity =
    role === "issue-integration"
      ? { role, sourceIssue: selectedSource, epic: selectedEpic }
      : { role, epic: selectedEpic };
  return request({
    workIdentity,
    routing,
    title: role === "issue-integration" ? "feat: integrate source outcome" : "feat: integrate epic outcome",
    body: "## Summary\n\nCompose the governed outcome.",
    ...overrides,
  });
}

function fakeProvider(
  initial: readonly PrPublicationRecord[] = [],
  options: { readonly uncertain?: boolean; readonly duplicateAfterUncertain?: boolean } = {},
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
        if (options.duplicateAfterUncertain)
          state.push({ ...created, number: 43, url: "https://github.com/acme/inari/pull/43" });
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

test("historical Implementation markers must be complete terminal comments", async () => {
  const marker = `<!-- inari:pr-publication ${JSON.stringify({ implementation })} -->`;
  const candidate: PrPublicationRecord = {
    number: 42,
    url: "https://github.com/acme/inari/pull/42",
    title: "feat: publish governed work",
    body: `Closes #700\n${marker}`,
    head: "feat/700-publication",
    base: "issue/680-integration",
    headRevision: "a".repeat(40),
    repository,
  };

  const exactProvider = fakeProvider([candidate]);
  const exact = await publishPullRequest(request(), exactProvider);
  assert.equal(exact.classification, "returned-existing");
  assert.deepEqual(exactProvider.calls, ["list"]);

  for (const body of [`${candidate.body}\nUnbound trailing text`, `Closes #700\n${marker.slice(0, -4)}`]) {
    const provider = fakeProvider([{ ...candidate, body }]);
    const result = await publishPullRequest(request(), provider);
    assert.equal(result.classification, "failed");
    assert.ok(result.diagnostics.some((entry) => entry.code === "PR_PUBLICATION_CONFLICTING_MATCH"));
    assert.deepEqual(provider.calls, ["list"]);
  }
});

test("Source and Epic integrations publish and reread their own role identities", async () => {
  for (const role of ["issue-integration", "epic-integration"] as const) {
    const input = integrationRequest(role);
    const validation = tryValidatePrPublicationRequest(input);
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
    assert.ok(validation.request);
    assert.match(validation.request.body, /<!-- inari:pr-publication /u);
    assert.ok(validation.request.body.includes(`"role":"${role}"`));

    const createdProvider = fakeProvider();
    const created = await publishPullRequest(input, createdProvider);
    assert.equal(created.classification, "created", JSON.stringify(created.diagnostics));
    assert.deepEqual(createdProvider.calls, ["list", "create", "read:42"]);

    const existing: PrPublicationRecord = {
      number: 42,
      url: "https://github.com/acme/inari/pull/42",
      title: validation.request.title,
      body: validation.request.body,
      head: validation.request.expectedHead,
      base: validation.request.expectedBase,
      headRevision: validation.request.headRevision,
      repository,
    };
    const retryProvider = fakeProvider([existing]);
    const retry = await publishPullRequest(input, retryProvider);
    assert.equal(retry.classification, "returned-existing", JSON.stringify(retry.diagnostics));
    assert.deepEqual(retryProvider.calls, ["list"]);
  }
});

test("route identity rejects wrong publication role, Source, Epic, and repository before provider reads", async () => {
  const otherRepository = { repositoryHost: "github.com", repositoryId: "101", repository: "acme/other" };
  const cases: readonly Record<string, unknown>[] = [
    integrationRequest("issue-integration", { workIdentity: { implementation } }),
    integrationRequest("issue-integration", {
      workIdentity: { role: "issue-integration", sourceIssue: { ...repository, number: 681 }, epic },
    }),
    integrationRequest("issue-integration", {
      workIdentity: { role: "issue-integration", sourceIssue, epic: { ...repository, number: 641 } },
    }),
    integrationRequest("issue-integration", {
      workIdentity: {
        role: "issue-integration",
        sourceIssue: { ...otherRepository, number: sourceIssue.number },
        epic,
      },
    }),
    integrationRequest("epic-integration", {
      workIdentity: { role: "epic-integration", epic: { ...repository, number: 641 } },
    }),
  ];

  for (const input of cases) {
    const provider = fakeProvider();
    const result = await publishPullRequest(input, provider);
    assert.equal(result.classification, "failed");
    assert.equal(provider.calls.length, 0);
  }
});

test("contradictory role, Source, Epic, or repository candidates fail closed", async () => {
  const otherRepository = { repositoryHost: "github.com", repositoryId: "101", repository: "acme/other" };
  const sourceInput = integrationRequest("issue-integration");
  const sourceValidation = tryValidatePrPublicationRequest(sourceInput);
  assert.equal(sourceValidation.valid, true, JSON.stringify(sourceValidation.diagnostics));
  assert.ok(sourceValidation.request);
  const wrongSource = tryValidatePrPublicationRequest(
    integrationRequest("issue-integration", {}, { source: { ...repository, number: 681 } }),
  );
  const wrongEpic = tryValidatePrPublicationRequest(
    integrationRequest("issue-integration", {}, { parentEpic: { ...repository, number: 641 } }),
  );
  const wrongRole = tryValidatePrPublicationRequest(integrationRequest("epic-integration"));
  assert.equal(wrongSource.valid, true, JSON.stringify(wrongSource.diagnostics));
  assert.equal(wrongEpic.valid, true, JSON.stringify(wrongEpic.diagnostics));
  assert.equal(wrongRole.valid, true, JSON.stringify(wrongRole.diagnostics));
  assert.ok(wrongSource.request && wrongEpic.request && wrongRole.request);

  const expected = sourceValidation.request;
  const candidates: readonly PrPublicationRecord[] = [
    {
      number: 50,
      url: "https://github.com/acme/inari/pull/50",
      title: expected.title,
      body: wrongSource.request.body,
      head: expected.expectedHead,
      base: expected.expectedBase,
      headRevision: expected.headRevision,
      repository,
    },
    {
      number: 51,
      url: "https://github.com/acme/inari/pull/51",
      title: expected.title,
      body: wrongEpic.request.body,
      head: expected.expectedHead,
      base: expected.expectedBase,
      headRevision: expected.headRevision,
      repository,
    },
    {
      number: 52,
      url: "https://github.com/acme/inari/pull/52",
      title: expected.title,
      body: wrongRole.request.body,
      head: expected.expectedHead,
      base: expected.expectedBase,
      headRevision: expected.headRevision,
      repository,
    },
    {
      number: 53,
      url: "https://github.com/acme/inari/pull/53",
      title: expected.title,
      body: expected.body,
      head: expected.expectedHead,
      base: expected.expectedBase,
      headRevision: expected.headRevision,
      repository: otherRepository,
    },
  ];
  for (const candidate of candidates) {
    const provider = fakeProvider([candidate]);
    const result = await publishPullRequest(sourceInput, provider);
    assert.equal(result.classification, "failed");
    assert.ok(result.diagnostics.some((entry) => entry.code === "PR_PUBLICATION_CONFLICTING_MATCH"));
    assert.deepEqual(provider.calls, ["list"]);
  }
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

test("uncertain create with ambiguous matching effects fails closed without retrying create", async () => {
  const provider = fakeProvider([], { uncertain: true, duplicateAfterUncertain: true });
  const result = await publishPullRequest(request(), provider);
  assert.equal(result.classification, "failed");
  assert.ok(result.diagnostics.some((entry) => entry.code === "PR_PUBLICATION_AMBIGUOUS_MATCH"));
  assert.deepEqual(provider.calls, ["list", "create", "list"]);
});
