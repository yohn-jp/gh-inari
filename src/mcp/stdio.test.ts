import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStdioArgs } from "./stdio.js";

test("direct MCP stdio uses --repo as the canonical GitHub repository alias", () => {
  for (const alias of ["--repo", "-R"]) {
    assert.deepEqual(parseStdioArgs([alias, "acme/inari"]), {
      help: false,
      version: false,
      repository: "acme/inari",
    });
  }
});

test("direct MCP stdio accepts an explicit local repository root", () => {
  assert.deepEqual(parseStdioArgs(["--repository-root", "/work/inari", "--repository", "acme/inari"]), {
    help: false,
    version: false,
    repositoryRoot: "/work/inari",
    repository: "acme/inari",
  });
});

test("direct MCP stdio rejects an incomplete repository-root option", () => {
  assert.throws(() => parseStdioArgs(["--repository-root"]), /--repository-root requires a value/);
});
