import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderPullRequestArtifact, validateExistingPullRequestArtifact } from "../src/artifact.ts";
import { pullRequestContractFixture } from "../src/contract/fixtures.ts";
import { compileLocalGovernedContract } from "../src/governance.ts";
import { runCli } from "../src/cli.ts";
import { validatePullRequest } from "./validate-pr.mjs";

const fields = {
  summary: "Does a thing.",
  linked_issue: "Closes #7",
  acceptance: ["tests"],
  scope: "The requested scope.",
};
const validBody = renderPullRequestArtifact(pullRequestContractFixture, fields);

test("uses the shared existing-artifact validator for a valid PR", async () => {
  const report = await validatePullRequest({
    title: "feat: add init command",
    body: validBody,
    contract: pullRequestContractFixture,
  });

  assert.equal(report.valid, true);
  assert.deepEqual(report.violations, []);
});

test("accepts every closing-keyword form enforced by the canonical contract", async () => {
  for (const reference of [
    "close #7",
    "CLOSED: #7",
    "fix #7",
    "FIXED #7",
    "resolve #7",
    "Resolved: octo-org/octo-repo#100",
  ]) {
    const report = await validatePullRequest({
      title: "feat: add init command",
      body: renderPullRequestArtifact(pullRequestContractFixture, { ...fields, linked_issue: reference }),
      contract: pullRequestContractFixture,
    });
    assert.equal(report.valid, true, reference);
  }
});

test("returns the same semantic violation code as the shared validator", async () => {
  const body = validBody.replace("Closes #7", "see issue 7");
  const expected = validateExistingPullRequestArtifact(pullRequestContractFixture, body);
  const actual = await validatePullRequest({
    title: "feat: add init command",
    body,
    contract: pullRequestContractFixture,
  });

  assert.equal(expected.valid, false);
  assert.deepEqual(actual.violations, expected.violations);
  assert.equal(actual.violations[0]?.code, "INPUT_PATTERN");
});

test("rejects a body that cannot be reconstructed by the canonical parser", async () => {
  const report = await validatePullRequest({
    title: "feat: add init command",
    body: "not a canonical pull request body",
    contract: pullRequestContractFixture,
  });
  assert.equal(report.valid, false);
  assert.ok(report.violations.length > 0);
});

test("keeps title validation as artifact metadata validation", async () => {
  const report = await validatePullRequest({ title: "", body: validBody, contract: pullRequestContractFixture });
  assert.equal(report.valid, false);
  assert.equal(report.violations[0]?.code, "INPUT_METADATA_INVALID");
});

test("CLI and workflow adapters return the same semantic violation code", async () => {
  const root = process.cwd();
  const contract = await compileLocalGovernedContract("pr", root, "default");
  const fields = {
    summary: "A sufficiently long summary",
    linked_issue: "Closes #10",
    scope: "The exact requested scope",
    included: "The governed implementation",
    excluded: "Unrelated changes",
    validation: ["tests"],
    breaking_changes: "No.",
  };
  const invalidValue = "see issue 10";
  const body = renderPullRequestArtifact(contract, fields).replace("Closes #10", invalidValue);
  const workflowReport = await validatePullRequest({ title: "fix: governance", body, root, template: "default" });
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-governance-"));
  const inputPath = path.join(directory, "pr.json");
  await writeFile(inputPath, JSON.stringify({ ...fields, linked_issue: invalidValue }));
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    const exitCode = await runCli(["pr", "validate", "--template", "default", "--from", inputPath, "--json"], {
      repositoryRoot: root,
    });
    const cliReport = JSON.parse(lines[0] ?? "{}");
    assert.equal(exitCode, 2);
    assert.equal(workflowReport.valid, false);
    assert.equal(cliReport.violations[0]?.code, workflowReport.violations[0]?.code);
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});
