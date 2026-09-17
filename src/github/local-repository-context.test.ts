import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RepositoryContextResolutionError,
  parseRepositoryLocator,
  resolveLocalRepositoryContext,
} from "./local-repository-context.js";

test("parseRepositoryLocator accepts owner/name with the fallback hostname", () => {
  const context = parseRepositoryLocator("acme/inari", "github.com");
  assert.equal(context.hostname, "github.com");
  assert.equal(context.owner, "acme");
  assert.equal(context.name, "inari");
  assert.equal(context.nameWithOwner, "acme/inari");
  assert.equal(context.url, "https://github.com/acme/inari");
});

test("parseRepositoryLocator accepts host/owner/name", () => {
  const context = parseRepositoryLocator("ghe.example.com/acme/inari", "github.com");
  assert.equal(context.hostname, "ghe.example.com");
  assert.equal(context.nameWithOwner, "acme/inari");
});

test("parseRepositoryLocator accepts an https repository URL, including .git and a trailing slash", () => {
  const context = parseRepositoryLocator("https://github.com/acme/inari.git", "github.com");
  assert.equal(context.hostname, "github.com");
  assert.equal(context.nameWithOwner, "acme/inari");

  const withSlash = parseRepositoryLocator("https://ghe.example.com/acme/inari/", "github.com");
  assert.equal(withSlash.hostname, "ghe.example.com");
  assert.equal(withSlash.nameWithOwner, "acme/inari");
});

test("parseRepositoryLocator rejects an empty override", () => {
  assert.throws(
    () => parseRepositoryLocator("   ", "github.com"),
    (error: unknown) => error instanceof RepositoryContextResolutionError && error.reason === "invalid-override",
  );
});

test("parseRepositoryLocator rejects a malformed segment count", () => {
  assert.throws(
    () => parseRepositoryLocator("a/b/c/d", "github.com"),
    (error: unknown) => error instanceof RepositoryContextResolutionError && error.reason === "invalid-override",
  );
});

test("parseRepositoryLocator rejects a path-traversal owner or name segment", () => {
  assert.throws(
    () => parseRepositoryLocator("../inari", "github.com"),
    (error: unknown) => error instanceof RepositoryContextResolutionError && error.reason === "invalid-override",
  );
});

test("resolveLocalRepositoryContext prefers an explicit override over any local git call", () => {
  const context = resolveLocalRepositoryContext({
    repository: "acme/inari",
    git: () => {
      throw new Error("must not be called when repository is explicit");
    },
  });
  assert.equal(context.nameWithOwner, "acme/inari");
});

test("resolveLocalRepositoryContext infers identity from an https origin remote", () => {
  const context = resolveLocalRepositoryContext({
    git: (args) => {
      assert.deepEqual(args, ["remote", "get-url", "origin"]);
      return "https://github.com/acme/inari.git\n";
    },
  });
  assert.equal(context.hostname, "github.com");
  assert.equal(context.nameWithOwner, "acme/inari");
});

test("resolveLocalRepositoryContext infers identity from a scp-style Enterprise remote", () => {
  const context = resolveLocalRepositoryContext({
    git: () => "git@ghe.example.com:acme/inari.git\n",
  });
  assert.equal(context.hostname, "ghe.example.com");
  assert.equal(context.nameWithOwner, "acme/inari");
});

test("resolveLocalRepositoryContext infers identity from an ssh:// remote", () => {
  const context = resolveLocalRepositoryContext({
    git: () => "ssh://git@ghe.example.com/acme/inari\n",
  });
  assert.equal(context.hostname, "ghe.example.com");
  assert.equal(context.nameWithOwner, "acme/inari");
});

test("resolveLocalRepositoryContext respects a non-default remote name", () => {
  const context = resolveLocalRepositoryContext({
    remoteName: "upstream",
    git: (args) => {
      assert.deepEqual(args, ["remote", "get-url", "upstream"]);
      return "https://github.com/acme/inari.git\n";
    },
  });
  assert.equal(context.nameWithOwner, "acme/inari");
});

test("resolveLocalRepositoryContext fails closed when the git remote is missing", () => {
  assert.throws(
    () =>
      resolveLocalRepositoryContext({
        git: () => {
          throw new Error("fatal: No such remote 'origin'");
        },
      }),
    (error: unknown) => error instanceof RepositoryContextResolutionError && error.reason === "remote-missing",
  );
});

test("resolveLocalRepositoryContext fails closed when the remote URL is not a GitHub URL", () => {
  assert.throws(
    () => resolveLocalRepositoryContext({ git: () => "not-a-url\n" }),
    (error: unknown) => error instanceof RepositoryContextResolutionError && error.reason === "remote-unparseable",
  );
});

test("resolveLocalRepositoryContext never invokes `gh`", () => {
  let sawGit = false;
  resolveLocalRepositoryContext({
    git: (args) => {
      sawGit = true;
      assert.equal(args[0], "remote");
      return "https://github.com/acme/inari.git\n";
    },
  });
  assert.ok(sawGit);
});
