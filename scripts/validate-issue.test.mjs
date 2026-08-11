import assert from "node:assert/strict";
import test from "node:test";
import { renderIssueArtifact, validateExistingIssueArtifact } from "../src/artifact.ts";
import { issueContractFixture } from "../src/contract/fixtures.ts";
import { validateIssue } from "./validate-issue.mjs";

const fields = {
  problem: "A",
  category: "feature",
  affected_areas: ["contracts"],
  acceptance: ["tests"],
};
const validBody = renderIssueArtifact(issueContractFixture, fields);

test("uses the shared existing-artifact validator for a valid Issue", async () => {
  const report = await validateIssue({ body: validBody, contract: issueContractFixture });
  assert.equal(report.valid, true);
  assert.deepEqual(report.violations, []);
});

test("rejects an empty body through parser diagnostics, not a body-length rule", async () => {
  const report = await validateIssue({ body: "", contract: issueContractFixture });
  assert.equal(report.valid, false);
  assert.ok(report.violations.some((violation) => violation.code === "EXISTING_UNPARSEABLE"));
});

test("accepts short field content when the compiled Issue Form permits it", async () => {
  const shortBody = renderIssueArtifact(issueContractFixture, fields);
  const report = await validateIssue({ body: shortBody, contract: issueContractFixture });
  assert.equal(report.valid, true);
});

test("returns the same violation as the shared validator for a malformed Issue", async () => {
  const body = "### Problem\n\nvalue\n";
  const expected = validateExistingIssueArtifact(issueContractFixture, body);
  const actual = await validateIssue({ body, contract: issueContractFixture });

  assert.equal(expected.valid, false);
  assert.deepEqual(actual.violations, expected.violations);
});
