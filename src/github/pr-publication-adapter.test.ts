import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubAdapter, type GitHubArtifactRequest, type GitHubArtifactTransport } from "./adapter.js";
import { GitHubPrPublicationAdapter } from "./pr-publication-adapter.js";

class PublicationTransport implements GitHubArtifactTransport {
  readonly calls: GitHubArtifactRequest[] = [];

  async request(request: GitHubArtifactRequest) {
    this.calls.push(request);
    if (request.path === "repos/acme/inari") return { status: 200, body: { id: 100 } };
    if (request.path.startsWith("repos/acme/inari/pulls?") && request.method === "GET")
      return { status: 200, body: [] };
    if (request.path === "repos/acme/inari/pulls" && request.method === "POST")
      return {
        status: 201,
        body: {
          number: 42,
          title: String(request.body?.title),
          body: String(request.body?.body),
          state: "open",
          draft: false,
          html_url: "https://github.com/acme/inari/pull/42",
          head: { ref: String(request.body?.head), sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
          base: { ref: String(request.body?.base) },
        },
      };
    if (request.path === "repos/acme/inari/pulls/42" && request.method === "GET")
      return {
        status: 200,
        body: {
          number: 42,
          title: "feat: publication",
          body: "Closes #700",
          state: "open",
          draft: false,
          html_url: "https://github.com/acme/inari/pull/42",
          head: { ref: "feat/700-publication", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
          base: { ref: "issue/680-integration" },
        },
      };
    throw new Error(`unexpected request ${request.method} ${request.path}`);
  }
}

test("GitHub publication adapter maps repository-scoped list/read/create", async () => {
  const transport = new PublicationTransport();
  const adapter = new GitHubPrPublicationAdapter(
    new GitHubAdapter({ repository: "acme/inari", token: "test-token", transport }),
  );
  const repository = await adapter.getRepositoryIdentity();
  assert.deepEqual(repository, { repositoryHost: "github.com", repositoryId: "100", repository: "acme/inari" });
  const listed = await adapter.listPullRequests({
    repository,
    head: "feat/700-publication",
    base: "issue/680-integration",
  });
  assert.deepEqual(listed, []);
  const created = await adapter.createPullRequest({
    repository,
    workIdentity: { implementation: { ...repository, number: 700 } },
    title: "feat: publication",
    body: "Closes #700",
    head: "feat/700-publication",
    base: "issue/680-integration",
    headRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(created.number, 42);
  const read = await adapter.readPullRequest(42);
  assert.equal(read.headRevision, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(transport.calls.filter((call) => call.method === "POST").length, 1);
});
