import assert from "node:assert/strict";
import test from "node:test";
import { createPrPublicationProvider } from "./pr-publication-provider.js";

const repository = { repositoryHost: "github.com", repositoryId: "61840000", repository: "acme/inari" };
const target = { repositoryHost: "github.com", repositoryId: "61840000", nameWithOwner: "acme/inari" };
const sourceIssue = { ...repository, number: 680 };
const epic = { ...repository, number: 640 };

function provider(body: string, authorizer: unknown = {}) {
  const pull = {
    number: 7,
    html_url: "https://github.com/acme/inari/pull/7",
    title: "docs: golden path",
    body,
    head: { ref: "work/golden-path-42", sha: "a".repeat(40) },
    base: { ref: "trunk" },
    draft: true,
  };
  const broker = {
    withRepositoryReadCapability: async (_request: unknown, callback: (capability: unknown) => unknown) =>
      callback({
        scope: { repository: { ...target } },
        transport: {
          request: async ({ path }: { readonly path: string }) => ({
            status: 200,
            body: path.endsWith("/pulls/7") ? pull : [pull],
          }),
        },
      }),
  };
  return createPrPublicationProvider({
    broker: broker as never,
    authorizer: authorizer as never,
    execution: {} as never,
    target,
  });
}

test("#1181 governed publication reads back a rendered multi-line Markdown body", async () => {
  const body = "## Summary\n\nDeliver it.\r\n\n- [x] Tests\n\t- nested\n";
  const listed = await provider(body).listPullRequests({ repository, head: "work/golden-path-42", base: "trunk" });
  assert.equal(listed[0]?.body, body);
  assert.equal((await provider(body).readPullRequest(7)).body, body);
});

test("#1181 other control characters in a provider body are still rejected", async () => {
  await assert.rejects(provider("bad\u0001body").readPullRequest(7), /Provider response invalid/u);
});

test("PR create effects use the governed Issue selected by the publication role", async () => {
  for (const [workIdentity, expectedRootIssue] of [
    [{ role: "issue-integration", sourceIssue, epic }, sourceIssue.number],
    [{ role: "epic-integration", epic }, epic.number],
  ] as const) {
    const effects: Record<string, unknown>[] = [];
    const authorizer = {
      async applyEffects(input: { readonly effects: readonly Record<string, unknown>[] }) {
        effects.push(...input.effects);
        return { effects: [{ evidence: { kind: "CREATE_PULL_REQUEST", pullRequest: 7 } }] };
      },
    };
    const api = provider("## Summary", authorizer);
    await api.createPullRequest({
      repository,
      workIdentity,
      title: "feat: publication",
      body: "## Summary",
      head: "issue/680-source-routing",
      base: "epic/640-dashboard",
      headRevision: "a".repeat(40),
    });
    assert.equal(effects[0]?.rootIssue, expectedRootIssue);
  }
});
