import assert from "node:assert/strict";
import { test } from "node:test";
import { createGhAuthTokenCredentialProvider, type GhAuthTokenCommandOptions } from "./gh-auth-credential.js";

test("gh fallback uses only the bounded auth-token command with the normalized host", () => {
  const calls: Array<{ args: readonly string[]; options: GhAuthTokenCommandOptions }> = [];
  const provider = createGhAuthTokenCredentialProvider({
    run: (args, options) => {
      calls.push({ args, options });
      return { status: 0, stdout: "gh-token\n" };
    },
  });

  assert.equal(provider("ghe.example.com"), "gh-token");
  assert.deepEqual(calls, [
    {
      args: ["auth", "token", "--hostname", "ghe.example.com"],
      options: {
        encoding: "utf8",
        maxBuffer: 4_098,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3_000,
      },
    },
  ]);
});

test("gh fallback treats unavailable, timed-out, empty, malformed, and oversized output as unavailable", () => {
  const results = [
    { status: 1, stdout: "failure-secret" },
    { status: null, stdout: "", failed: true },
    { status: 0, stdout: "" },
    { status: 0, stdout: "token\nsecond-line" },
    { status: 0, stdout: "x".repeat(4_099) },
  ];

  for (const result of results) {
    const provider = createGhAuthTokenCredentialProvider({ run: () => result });
    assert.equal(provider("github.com"), undefined);
  }
});

test("gh fallback discards runner failures without exposing their details", () => {
  const secret = "runner-secret";
  const provider = createGhAuthTokenCredentialProvider({
    run: () => {
      throw new Error(secret);
    },
  });

  assert.equal(provider("github.com"), undefined);
});
