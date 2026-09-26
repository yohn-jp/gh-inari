import assert from "node:assert/strict";
import test from "node:test";
import { createPrPublicationProvider } from "./pr-publication-provider.js";

const repository = { repositoryHost: "github.com", repositoryId: "61840000", repository: "acme/inari" };
const target = { repositoryHost: "github.com", repositoryId: "61840000", nameWithOwner: "acme/inari" };

function provider(body: string) {
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
    authorizer: {} as never,
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
