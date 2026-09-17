import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubUserCredentialError, resolveGitHubUserCredential } from "./user-credential.js";

test("an explicitly injected token always wins, even with environment variables present", () => {
  const credential = resolveGitHubUserCredential({
    token: "explicit-token",
    env: { GH_TOKEN: "gh-token", GITHUB_TOKEN: "github-token" },
  });
  assert.deepEqual(credential, { token: "explicit-token", source: "explicit" });
});

test("github.com prefers GH_TOKEN over GITHUB_TOKEN", () => {
  const credential = resolveGitHubUserCredential({ env: { GH_TOKEN: "gh-token", GITHUB_TOKEN: "github-token" } });
  assert.deepEqual(credential, { token: "gh-token", source: "GH_TOKEN" });
});

test("github.com falls back to GITHUB_TOKEN when GH_TOKEN is absent", () => {
  const credential = resolveGitHubUserCredential({ env: { GITHUB_TOKEN: "github-token" } });
  assert.deepEqual(credential, { token: "github-token", source: "GITHUB_TOKEN" });
});

test("a non-github.com host prefers GH_ENTERPRISE_TOKEN over GITHUB_ENTERPRISE_TOKEN", () => {
  const credential = resolveGitHubUserCredential({
    hostname: "ghe.example.com",
    env: { GH_ENTERPRISE_TOKEN: "enterprise-token", GITHUB_ENTERPRISE_TOKEN: "legacy-enterprise-token" },
  });
  assert.deepEqual(credential, { token: "enterprise-token", source: "GH_ENTERPRISE_TOKEN" });
});

test("a non-github.com host falls back to GITHUB_ENTERPRISE_TOKEN", () => {
  const credential = resolveGitHubUserCredential({
    hostname: "ghe.example.com",
    env: { GITHUB_ENTERPRISE_TOKEN: "legacy-enterprise-token" },
  });
  assert.deepEqual(credential, { token: "legacy-enterprise-token", source: "GITHUB_ENTERPRISE_TOKEN" });
});

test("a non-github.com host never falls back to GH_TOKEN/GITHUB_TOKEN", () => {
  assert.throws(
    () =>
      resolveGitHubUserCredential({
        hostname: "ghe.example.com",
        env: { GH_TOKEN: "gh-token", GITHUB_TOKEN: "github-token" },
      }),
    (error: unknown) => error instanceof GitHubUserCredentialError && error.reason === "missing",
  );
});

test("no matching environment variable fails closed", () => {
  assert.throws(
    () => resolveGitHubUserCredential({ env: {} }),
    (error: unknown) => error instanceof GitHubUserCredentialError && error.reason === "missing",
  );
});

test("an empty explicit token is rejected", () => {
  assert.throws(
    () => resolveGitHubUserCredential({ token: "" }),
    (error: unknown) => error instanceof GitHubUserCredentialError && error.reason === "invalid",
  );
});

test("an environment token containing a control character is rejected", () => {
  assert.throws(
    () => resolveGitHubUserCredential({ env: { GH_TOKEN: "bad\u0000token" } }),
    (error: unknown) => error instanceof GitHubUserCredentialError && error.reason === "invalid",
  );
});

test("an invalid hostname is rejected before any environment variable is consulted", () => {
  assert.throws(
    () => resolveGitHubUserCredential({ hostname: "has a space", env: { GH_TOKEN: "gh-token" } }),
    (error: unknown) => error instanceof GitHubUserCredentialError && error.reason === "hostname",
  );
});

test("this module never reads process.env when an env override is supplied", () => {
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "leaked-from-process-env";
  try {
    assert.throws(() => resolveGitHubUserCredential({ env: {} }));
  } finally {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  }
});
