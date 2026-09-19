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

test("the optional fallback is last and receives a normalized github.com hostname", () => {
  const hosts: string[] = [];
  const credential = resolveGitHubUserCredential({
    hostname: " GitHub.COM ",
    env: {},
    fallbackProvider: (hostname) => {
      hosts.push(hostname);
      return "gh-auth-token";
    },
  });

  assert.deepEqual(credential, { token: "gh-auth-token", source: "gh auth token" });
  assert.deepEqual(hosts, ["github.com"]);
});

test("the enterprise fallback receives the normalized GHES hostname", () => {
  const hosts: string[] = [];
  const credential = resolveGitHubUserCredential({
    hostname: " GHE.Example.COM ",
    env: {},
    fallbackProvider: (hostname) => {
      hosts.push(hostname);
      return "enterprise-gh-auth-token";
    },
  });

  assert.deepEqual(credential, { token: "enterprise-gh-auth-token", source: "gh auth token" });
  assert.deepEqual(hosts, ["ghe.example.com"]);
});

test("higher-priority credentials prevent the fallback", () => {
  let calls = 0;
  const fallbackProvider = () => {
    calls += 1;
    return "fallback-token";
  };

  assert.deepEqual(
    resolveGitHubUserCredential({ token: "explicit-token", env: { GH_TOKEN: "env-token" }, fallbackProvider }),
    { token: "explicit-token", source: "explicit" },
  );
  assert.deepEqual(
    resolveGitHubUserCredential({ env: { GH_TOKEN: "gh-token", GITHUB_TOKEN: "github-token" }, fallbackProvider }),
    { token: "gh-token", source: "GH_TOKEN" },
  );
  assert.equal(calls, 0);
});

test("invalid higher-priority credentials fail closed without invoking the fallback", () => {
  let calls = 0;
  assert.throws(
    () =>
      resolveGitHubUserCredential({
        token: "",
        fallbackProvider: () => {
          calls += 1;
          return "fallback-token";
        },
      }),
    (error: unknown) => error instanceof GitHubUserCredentialError && error.reason === "invalid",
  );
  assert.throws(
    () =>
      resolveGitHubUserCredential({
        env: { GH_TOKEN: "invalid\u0000token" },
        fallbackProvider: () => {
          calls += 1;
          return "fallback-token";
        },
      }),
    (error: unknown) => error instanceof GitHubUserCredentialError && error.reason === "invalid",
  );
  assert.equal(calls, 0);
});

test("fallback failures and malformed or oversized output resolve as ordinary missing credentials", () => {
  const secret = "fallback-secret";
  const fallbacks = [
    () => undefined,
    () => {
      throw new Error(`provider failed with ${secret}`);
    },
    () => `${secret}\nsecond-line`,
    () => "x".repeat(4_097),
  ];

  for (const fallbackProvider of fallbacks) {
    assert.throws(
      () => resolveGitHubUserCredential({ env: {}, fallbackProvider }),
      (error: unknown) => {
        assert.equal(error instanceof GitHubUserCredentialError, true);
        assert.equal((error as GitHubUserCredentialError).reason, "missing");
        assert.doesNotMatch(JSON.stringify(error), /fallback-secret/iu);
        return true;
      },
    );
  }
});
