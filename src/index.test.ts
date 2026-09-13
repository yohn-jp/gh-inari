import assert from "node:assert/strict";
import { test } from "node:test";
import * as githubExports from "./github/index.js";
import { executeGoldenPathReviewAdmission, runCli } from "./index.js";
import * as rootExports from "./index.js";

test("root library exports can be imported without invoking the CLI", () => {
  assert.equal(typeof runCli, "function");
  assert.equal(typeof executeGoldenPathReviewAdmission, "function");
});

test("Git-data implementation and provider transport stay out of public barrels", () => {
  const forbidden = [
    "GitHubBranchAdvanceCapabilityImpl",
    "GitDataCapabilityError",
    "GIT_DATA_CAPABILITY_VERSION",
    "GIT_DATA_WRITE_MODES",
  ];
  for (const name of forbidden) {
    assert.equal(name in githubExports, false, `github barrel must not export ${name}`);
    assert.equal(name in rootExports, false, `root barrel must not export ${name}`);
  }
});
