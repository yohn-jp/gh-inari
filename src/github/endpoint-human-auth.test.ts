import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EndpointHumanAuthenticationError,
  EndpointHumanAuthenticator,
  type EndpointHumanAuthenticatorOptions,
} from "./endpoint-human-auth.js";
import { GitHubAdapter } from "./adapter.js";

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
  readonly repositoryBody?: unknown;
}

function fixture(options: FetchFixtureOptions = {}) {
  const calls: Array<{ readonly path: string; readonly method: string; readonly authorization: string }> = [];
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({
      path: url.pathname,
      method: String(init?.method ?? "GET"),
      authorization: String(new Headers(init?.headers).get("authorization")),
    });
    if (url.pathname === "/user") {
      return Response.json({ id: 42, login: "sophia" }, { status: options.userStatus ?? 200 });
    }
    if (url.pathname === "/user/installations") {
      return Response.json(
        options.installationBody ?? { installations: [{ id: 7, app_id: 1234, suspended_at: null }] },
        { status: 200 },
      );
    }
    if (url.pathname === "/user/installations/7/repositories") {
      return Response.json(
        options.repositoryBody ?? {
          repositories: [{ id: 1330755860, full_name: "acme/inari", owner: { login: "acme" }, name: "inari" }],
        },
        { status: 200 },
      );
    }
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
    ["/user", "/user/installations", "/user/installations/7/repositories"],
  );
  assert.ok(calls.every((entry) => entry.method === "GET" && entry.authorization === `Bearer ${TOKEN}`));
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
    transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/inari/contents/README.md" }),
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

test("admits canonical GitHubAdapter branch paths and rejects encoded traversal before provider I/O", async () => {
  const { calls, fetcher } = fixture();
  const result = await authenticator(fetcher).authenticate(request());
  assert.equal(result.authenticated, true);
  if (!result.authenticated) return;

  const branch = await result.withRepositoryReadTransport((transport) => {
    const adapter = new GitHubAdapter({
      repository: "acme/inari",
      hostname: "github.com",
      transport: {
        request: (input) => transport.request({ hostname: input.hostname, method: "GET", path: input.path }),
      },
    });
    return adapter.findBranch("feat/123-example");
  });
  assert.deepEqual(branch, {
    name: "feat/123-example",
    ref: "refs/heads/feat/123-example",
    sha: "a".repeat(40),
  });
  assert.equal(
    calls.some((entry) => entry.path === "/repos/acme/inari/git/ref/heads/feat%2F123-example"),
    true,
  );

  const providerReadsBeforeRejections = calls.length;
  const rejectedPaths = [
    "repos/acme/inari/git/ref/heads/feat%2F123-example%",
    "repos/acme/inari/../other",
    "repos/acme/inari/%2e%2e/other",
    "repos/acme/inari/git/ref/heads/%00",
    "repos/acme/inari/git/ref/heads/%1F",
    "repos/acme/inari/git/ref/heads/%5C..%5Cother",
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
