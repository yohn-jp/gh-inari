import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EndpointHumanAuthenticationError,
  EndpointHumanAuthenticator,
  type EndpointHumanAuthenticatorOptions,
} from "./endpoint-human-auth.js";
import { GitHubAdapter } from "./adapter.js";
import { GitHubIssueRelationObservationAdapter } from "./issue-relation-observation-adapter.js";
import { GitHubRepositoryEvidenceReader } from "./repository-evidence-reader.js";

const TOKEN = "ghu_request_scoped_secret";
const endpoint = { version: 1, kind: "endpoint", id: "hosted-endpoint", deployment: "shared-hosted" } as const;
const installation = {
  version: 1,
  kind: "installation",
  endpointId: endpoint.id,
  installationId: "7",
} as const;
const repository = {
  version: 1,
  kind: "repository",
  endpointId: endpoint.id,
  installationId: installation.installationId,
  repositoryHost: "github.com",
  repositoryId: "1330755860",
  nameWithOwner: "acme/inari",
} as const;

function request(
  operation: "repository.read" | "work.read" | "presence.read" = "repository.read",
  authorization = `Bearer ${TOKEN}`,
) {
  return {
    version: 1 as const,
    request: {
      version: 1 as const,
      operation,
      endpoint,
      installation,
      repository,
      capability: { kind: operation },
    },
    transport: new Request("https://endpoint.example/v1/endpoint", {
      headers: authorization.length === 0 ? {} : { authorization },
    }),
  };
}

interface FetchFixtureOptions {
  readonly userStatus?: number;
  readonly installationBody?: unknown;
  readonly installationPages?: readonly unknown[];
  readonly repositoryBody?: unknown;
  readonly repositoryPages?: readonly unknown[];
  readonly repositoryResponse?: (url: URL) => Response | undefined;
}

function fixture(options: FetchFixtureOptions = {}) {
  const calls: Array<{ readonly path: string; readonly method: string; readonly authorization: string }> = [];
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({
      path: `${url.pathname}${url.search}`,
      method: String(init?.method ?? "GET"),
      authorization: String(new Headers(init?.headers).get("authorization")),
    });
    if (url.pathname === "/user") {
      return Response.json({ id: 42, login: "sophia" }, { status: options.userStatus ?? 200 });
    }
    if (url.pathname === "/user/installations") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const paginatedBody = options.installationPages?.[page - 1];
      return Response.json(
        paginatedBody ?? options.installationBody ?? { installations: [{ id: 7, app_id: 1234, suspended_at: null }] },
        { status: 200 },
      );
    }
    if (url.pathname === "/user/installations/7/repositories") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const paginatedBody = options.repositoryPages?.[page - 1];
      return Response.json(
        paginatedBody ??
          options.repositoryBody ?? {
            repositories: [{ id: 1330755860, full_name: "acme/inari", owner: { login: "acme" }, name: "inari" }],
          },
        { status: 200 },
      );
    }
    const repositoryResponse = options.repositoryResponse?.(url);
    if (repositoryResponse !== undefined) return repositoryResponse;
    if (url.pathname === "/repos/acme/inari") {
      return Response.json({ id: 1330755860, full_name: "acme/inari", default_branch: "main" }, { status: 200 });
    }
    if (url.pathname === "/repos/acme/inari/git/ref/heads/feat%2F123-example") {
      return Response.json(
        {
          ref: "refs/heads/feat/123-example",
          object: { type: "commit", sha: "a".repeat(40) },
        },
        { status: 200 },
      );
    }
    if (url.pathname === "/repos/acme/inari/git/trees/feat%2F123-example" && url.search === "?recursive=1") {
      return Response.json({ sha: "b".repeat(40), truncated: false, tree: [] }, { status: 200 });
    }
    if (url.pathname.startsWith("/repos/acme/inari")) return Response.json({ ok: true }, { status: 200 });
    return Response.json({}, { status: 404 });
  };
  return { calls, fetcher };
}

function authenticator(fetcher: typeof globalThis.fetch, appId = "1234"): EndpointHumanAuthenticator {
  const options: EndpointHumanAuthenticatorOptions = { appId, apiUrl: "https://api.example", fetch: fetcher };
  return new EndpointHumanAuthenticator(options);
}

test("missing and malformed bearer credentials fail before provider reads", async () => {
  const { calls, fetcher } = fixture();
  const auth = authenticator(fetcher);
  for (const authorization of ["", "Basic abc", "Bearer", "Bearer one two", "Bearer a,b"]) {
    await assert.rejects(
      () => auth.authenticate(request("repository.read", authorization)),
      EndpointHumanAuthenticationError,
    );
  }
  assert.deepEqual(calls, []);
});

test("authenticates the stable GitHub user and emits only the requested Endpoint read capability", async () => {
  const { calls, fetcher } = fixture();
  const result = await authenticator(fetcher).authenticate(request("repository.read"));
  assert.equal(result.authenticated, true);
  if (!result.authenticated) return;
  assert.deepEqual(result.evidence.principal, { version: 1, kind: "human", id: "github-user:42" });
  assert.deepEqual(result.evidence.capabilities, [{ kind: "repository.read" }]);
  assert.equal("token" in result.evidence, false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.deepEqual(
    calls.map((entry) => entry.path),
    ["/user", "/user/installations?per_page=100&page=1", "/user/installations/7/repositories?per_page=100&page=1"],
  );
  assert.ok(calls.every((entry) => entry.method === "GET" && entry.authorization === `Bearer ${TOKEN}`));
});

test("paginates installations and repositories before admitting the requested immutable scope", async () => {
  const { fetcher, calls } = fixture({
    installationPages: [
      { total_count: 2, installations: [{ id: 8, app_id: 1234, suspended_at: null }] },
      { total_count: 2, installations: [{ id: 7, app_id: 1234, suspended_at: null }] },
    ],
    repositoryPages: [
      { total_count: 2, repositories: [{ id: 99, full_name: "acme/other" }] },
      {
        total_count: 2,
        repositories: [{ id: 1330755860, full_name: "acme/inari", owner: { login: "acme" }, name: "inari" }],
      },
    ],
  });
  const result = await authenticator(fetcher).authenticate(request());
  assert.equal(result.authenticated, true);
  if (!result.authenticated) return;
  assert.equal(result.evidence.repository.repositoryId, "1330755860");
  assert.deepEqual(
    calls.map((entry) => entry.path),
    [
      "/user",
      "/user/installations?per_page=100&page=1",
      "/user/installations?per_page=100&page=2",
      "/user/installations/7/repositories?per_page=100&page=1",
      "/user/installations/7/repositories?per_page=100&page=2",
    ],
  );
});

test("accepts a renamed repository by immutable ID and refreshes locator metadata", async () => {
  const { fetcher } = fixture({
    repositoryBody: {
      repositories: [
        { id: "1330755860", full_name: "new-owner/renamed", owner: { login: "new-owner" }, name: "renamed" },
      ],
    },
  });
  const result = await authenticator(fetcher).authenticate(request());
  assert.equal(result.authenticated, true);
  if (result.authenticated) assert.equal(result.evidence.repository.nameWithOwner, "new-owner/renamed");
});

test("rejects wrong App, suspended or removed installation, and removed or ambiguous repository", async () => {
  const wrongApp = fixture({ installationBody: { installations: [{ id: 7, app_id: 9999, suspended_at: null }] } });
  await assert.rejects(() => authenticator(wrongApp.fetcher).authenticate(request()), EndpointHumanAuthenticationError);

  const suspended = fixture({
    installationBody: { installations: [{ id: 7, app_id: 1234, suspended_at: "2024-01-01T00:00:00Z" }] },
  });
  await assert.rejects(
    () => authenticator(suspended.fetcher).authenticate(request()),
    EndpointHumanAuthenticationError,
  );

  const removedInstallation = fixture({ installationBody: { installations: [] } });
  await assert.rejects(
    () => authenticator(removedInstallation.fetcher).authenticate(request()),
    EndpointHumanAuthenticationError,
  );

  const removedRepository = fixture({ repositoryBody: { repositories: [{ id: "99", full_name: "acme/other" }] } });
  await assert.rejects(
    () => authenticator(removedRepository.fetcher).authenticate(request()),
    EndpointHumanAuthenticationError,
  );

  const ambiguousRepository = fixture({
    repositoryBody: {
      repositories: [
        { id: "1330755860", full_name: "acme/inari" },
        { id: "1330755860", full_name: "acme/renamed" },
      ],
    },
  });
  await assert.rejects(
    () => authenticator(ambiguousRepository.fetcher).authenticate(request()),
    EndpointHumanAuthenticationError,
  );
});

test("revoked credentials fail closed and the returned transport is GET-only and repository-bound", async () => {
  const revoked = fixture({ userStatus: 401 });
  await assert.rejects(() => authenticator(revoked.fetcher).authenticate(request()), EndpointHumanAuthenticationError);

  const { fetcher } = fixture();
  const result = await authenticator(fetcher).authenticate(request());
  assert.equal(result.authenticated, true);
  if (!result.authenticated) return;
  const response = await result.withRepositoryReadTransport((transport) =>
    transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/inari/git/blobs/README" }),
  );
  assert.equal(response.status, 200);
  await assert.rejects(
    () =>
      result.withRepositoryReadTransport((transport) =>
        transport.request({ hostname: "github.com", method: "GET", path: "repos/other/repository" }),
      ),
    EndpointHumanAuthenticationError,
  );
  await assert.rejects(
    () =>
      result.withRepositoryReadTransport((transport) =>
        transport.request({ hostname: "github.com", method: "POST" as "GET", path: "repos/acme/inari" }),
      ),
    EndpointHumanAuthenticationError,
  );
});

test("admits canonical GitHubAdapter branch and tree paths and rejects encoded traversal before provider I/O", async () => {
  const { calls, fetcher } = fixture();
  const result = await authenticator(fetcher).authenticate(request());
  assert.equal(result.authenticated, true);
  if (!result.authenticated) return;

  const reads = await result.withRepositoryReadTransport(async (transport) => {
    const adapter = new GitHubAdapter({
      repository: "acme/inari",
      hostname: "github.com",
      transport: {
        request: (input) => transport.request({ hostname: input.hostname, method: "GET", path: input.path }),
      },
    });
    return {
      branch: await adapter.findBranch("feat/123-example"),
      tree: await adapter.getRepositoryTree("feat/123-example"),
    };
  });
  assert.deepEqual(reads.branch, {
    name: "feat/123-example",
    ref: "refs/heads/feat/123-example",
    sha: "a".repeat(40),
  });
  assert.deepEqual(reads.tree, { sha: "b".repeat(40), entries: [] });
  assert.equal(
    calls.some((entry) => entry.path === "/repos/acme/inari/git/ref/heads/feat%2F123-example"),
    true,
  );
  assert.equal(
    calls.some((entry) => entry.path === "/repos/acme/inari/git/trees/feat%2F123-example?recursive=1"),
    true,
  );

  const providerReadsBeforeRejections = calls.length;
  const rejectedPaths = [
    "repos/acme/inari/contents/README.md",
    "repos/acme/inari/git/ref/heads/main?unexpected=1",
    "repos/acme/inari/issues/123/dependencies/blocked_by?per_page=100",
    "repos/acme/inari/issues/123/dependencies/blocked_by?per_page=100&page=1&extra=1",
    "repos/acme/inari/issues/123/dependencies/blocked_by?per_page=100&page=1&page=1",
    "repos/acme/inari/issues/123/dependencies/blocked_by?per_page=100&page=0",
    "repos/acme/inari/issues/123/dependencies/blocked_by?per_page=100&page=-1",
    "repos/acme/inari/issues/123/dependencies/blocked_by?per_page=100&page=11",
    "repos/acme/inari/issues/123/dependencies/blocked_by?per_page=100&page=one",
    "repos/acme/inari/issues/123/dependencies/blocked_by?per_page=99&page=1",
    "repos/acme/inari/pulls?state=open&head=acme%3Amain&base=main&per_page=100",
    "repos/acme/inari/pulls?state=all&head=other%3Amain&base=main&per_page=100",
    "repos/acme/inari/pulls?state=all&head=acme%3Amain&base=main&per_page=50",
    "repos/acme/inari/pulls?state=all&head=acme%3Amain&base=main",
    "repos/acme/inari/git/ref/heads/feat%2F123-example%",
    "repos/acme/inari/../other",
    "repos/acme/inari/%2e%2e/other",
    "repos/acme/inari/git/ref/heads/%00",
    "repos/acme/inari/git/ref/heads/%1F",
    "repos/acme/inari/git/ref/heads/%5C..%5Cother",
    "repos/acme/inari/git/trees/main?recursive=1%",
    "repos/acme/inari/git/trees/main?recursive%3D1",
    "repos/acme/inari/git/trees/main?recursive=1%00",
    "repos/acme/inari/git/trees/main?recursive=1?other",
    "repos/acme/inari/git/trees/main?//github.com/repos/other",
    "repos/acme/inari/git/trees/main?recursive=1#fragment",
    "repos/acme/other/git/ref/heads/main",
    "repos/acme%2Finari/git/ref/heads/main",
    "https://github.com/repos/acme/inari/git/ref/heads/main",
  ];
  for (const path of rejectedPaths) {
    await assert.rejects(
      () =>
        result.withRepositoryReadTransport((transport) =>
          transport.request({ hostname: "github.com", method: "GET", path }),
        ),
      EndpointHumanAuthenticationError,
    );
  }
  await assert.rejects(
    () =>
      result.withRepositoryReadTransport((transport) =>
        transport.request({ hostname: "wrong.example", method: "GET", path: "repos/acme/inari" }),
      ),
    EndpointHumanAuthenticationError,
  );
  assert.equal(calls.length, providerReadsBeforeRejections);
});

test("admits every query-bearing rooted-work family through the actual production emitters", async () => {
  const issueNumber = 123;
  const pullRequestNumber = 456;
  const branch = "feat/123-example";
  const headSha = "c".repeat(40);
  const issue = {
    number: issueNumber,
    title: "Root issue",
    body: "Issue body",
    state: "open",
    user: { id: 42, login: "sophia" },
    labels: [],
    assignees: [],
    html_url: `https://github.com/acme/inari/issues/${issueNumber}`,
  };
  const pullRequest = {
    number: pullRequestNumber,
    title: "Change",
    body: "Pull request body",
    state: "open",
    draft: false,
    user: { id: 42, login: "sophia" },
    head: { ref: branch, sha: headSha },
    base: { ref: "main" },
    review_decision: "APPROVED",
    labels: [],
    assignees: [],
    html_url: `https://github.com/acme/inari/pull/${pullRequestNumber}`,
  };
  const { calls, fetcher } = fixture({
    repositoryResponse: (url) => {
      if (url.pathname === "/repos/acme/inari") {
        return Response.json({ id: 1330755860, full_name: "acme/inari" }, { status: 200 });
      }
      if (url.pathname === "/repos/acme/inari/git/ref/heads/feat%2F123-example") {
        return Response.json(
          { ref: `refs/heads/${branch}`, object: { type: "commit", sha: "a".repeat(40) } },
          { status: 200 },
        );
      }
      if (url.pathname === "/repos/acme/inari/git/trees/feat%2F123-example" && url.search === "?recursive=1") {
        return Response.json({ sha: "b".repeat(40), truncated: false, tree: [] }, { status: 200 });
      }
      if (
        url.pathname === `/repos/acme/inari/issues/${issueNumber}/dependencies/blocked_by` &&
        url.search === "?per_page=100&page=1"
      ) {
        return Response.json([], { status: 200 });
      }
      if (url.pathname === "/repos/acme/inari/pulls" && url.search.includes("state=all")) {
        return Response.json([], { status: 200 });
      }
      if (url.pathname === `/repos/acme/inari/issues/${issueNumber}`) {
        return Response.json(issue, { status: 200 });
      }
      if (url.pathname === `/repos/acme/inari/pulls/${pullRequestNumber}`) {
        return Response.json(pullRequest, { status: 200 });
      }
      if (
        url.pathname === `/repos/acme/inari/issues/${issueNumber}/comments` ||
        url.pathname === `/repos/acme/inari/pulls/${pullRequestNumber}/comments` ||
        url.pathname === `/repos/acme/inari/pulls/${pullRequestNumber}/reviews` ||
        url.pathname === `/repos/acme/inari/pulls/${pullRequestNumber}/files`
      ) {
        return Response.json([], { status: 200 });
      }
      if (url.pathname === `/repos/acme/inari/commits/${headSha}/check-runs` && url.search === "?per_page=100&page=1") {
        return Response.json({ check_runs: [] }, { status: 200 });
      }
      if (url.pathname === `/repos/acme/inari/commits/${headSha}/status` && url.search === "?per_page=100&page=1") {
        return Response.json({ statuses: [] }, { status: 200 });
      }
      if (url.pathname === "/repos/acme/inari/branches/main/protection/required_status_checks") {
        return Response.json({ contexts: [], checks: [] }, { status: 200 });
      }
      return undefined;
    },
  });
  const result = await authenticator(fetcher).authenticate(request());
  assert.equal(result.authenticated, true);
  if (!result.authenticated) return;

  await result.withRepositoryReadTransport(async (transport) => {
    const adapterTransport = {
      request: (input: { readonly hostname: string; readonly method: "GET"; readonly path: string }) =>
        transport.request(input),
    };
    const adapter = new GitHubAdapter({
      repository: "acme/inari",
      hostname: "github.com",
      transport: adapterTransport,
    });
    await adapter.findBranch(branch);
    await adapter.getRepositoryTree(branch);
    const context = await adapter.getRepositoryContext();
    await new GitHubIssueRelationObservationAdapter(adapter, context, {
      parent: false,
      blockedBy: true,
    }).observeBlockedBy(issueNumber);
    const evidenceReader = new GitHubRepositoryEvidenceReader({
      repository: { hostname: "github.com", owner: "acme", name: "inari" },
      repositoryId: "1330755860",
      transport: adapterTransport,
    });
    await evidenceReader.readPullRequests([branch], "main");
    await adapter.observeIssue(issueNumber);
    await adapter.observePullRequest(pullRequestNumber);
  });

  const expected = [
    `/repos/acme/inari/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    `/repos/acme/inari/issues/${issueNumber}/dependencies/blocked_by?per_page=100&page=1`,
    `/repos/acme/inari/pulls?state=all&head=${encodeURIComponent(`acme:${branch}`)}&base=main&per_page=100`,
    `/repos/acme/inari/issues/${issueNumber}/comments?per_page=100&page=1`,
    `/repos/acme/inari/pulls/${pullRequestNumber}/comments?per_page=100&page=1`,
    `/repos/acme/inari/pulls/${pullRequestNumber}/reviews?per_page=100&page=1`,
    `/repos/acme/inari/pulls/${pullRequestNumber}/files?per_page=100&page=1`,
    `/repos/acme/inari/commits/${headSha}/check-runs?per_page=100&page=1`,
    `/repos/acme/inari/commits/${headSha}/status?per_page=100&page=1`,
  ];
  for (const target of expected)
    assert.equal(
      calls.some((entry) => entry.path === target),
      true,
      target,
    );
  assert.equal(
    calls.some((entry) => entry.path.includes("/graphql")),
    false,
  );
  assert.ok(calls.every((entry) => entry.method === "GET"));
});
