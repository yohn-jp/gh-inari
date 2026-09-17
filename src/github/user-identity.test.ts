import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubUserIdentityError, resolveAuthenticatedGitHubUser } from "./user-identity.js";

test("resolves the authenticated login from a bounded GET user request", async () => {
  let requested: unknown;
  const login = await resolveAuthenticatedGitHubUser(
    {
      request: async (request) => {
        requested = request;
        return { status: 200, body: { login: "octocat" } };
      },
    },
    "github.com",
  );
  assert.equal(login, "octocat");
  assert.deepEqual(requested, { hostname: "github.com", method: "GET", path: "user" });
});

test("a non-200 status fails closed with reason=status", async () => {
  await assert.rejects(
    resolveAuthenticatedGitHubUser({ request: async () => ({ status: 401, body: {} }) }, "github.com"),
    (error: unknown) => error instanceof GitHubUserIdentityError && error.reason === "status" && error.status === 401,
  );
});

test("a missing login field fails closed with reason=response", async () => {
  await assert.rejects(
    resolveAuthenticatedGitHubUser({ request: async () => ({ status: 200, body: {} }) }, "github.com"),
    (error: unknown) => error instanceof GitHubUserIdentityError && error.reason === "response",
  );
});

test("a login outside GitHub's identity grammar fails closed", async () => {
  await assert.rejects(
    resolveAuthenticatedGitHubUser(
      { request: async () => ({ status: 200, body: { login: "not valid!" } }) },
      "github.com",
    ),
    (error: unknown) => error instanceof GitHubUserIdentityError && error.reason === "response",
  );
});

test("a transport failure fails closed with reason=request", async () => {
  await assert.rejects(
    resolveAuthenticatedGitHubUser(
      {
        request: async () => {
          throw new Error("network down");
        },
      },
      "github.com",
    ),
    (error: unknown) => error instanceof GitHubUserIdentityError && error.reason === "request",
  );
});
