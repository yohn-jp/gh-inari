import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adaptCliFieldCandidate,
  adaptExistingArtifactCandidate,
  loadCanonicalArtifact,
  loadCanonicalExistingArtifact,
  loadCanonicalJsonArtifact,
  loadCanonicalMarkdownArtifact,
  renderIssueArtifact,
  renderPullRequestArtifact,
} from "./artifact.js";
import { issueContractFixture, pullRequestContractFixture } from "./contract/fixtures.js";

const issueFields = {
  problem: "A useful problem statement",
  category: "feature",
  affected_areas: ["contracts"],
  acceptance: ["tests", "docs"],
};

const prFields = {
  summary: "A deterministic summary",
  linked_issue: "Closes #21",
  acceptance: ["tests"],
  scope: "Small and explicit",
};

// Constructed via fromCharCode rather than literal or escaped source
// characters, so this file's own bytes stay unambiguous ASCII.
const BOM = String.fromCharCode(0xfeff);
const BELL = String.fromCharCode(0x0007);

test("Issue JSON and native Markdown candidates converge to identical canonical JSON", () => {
  const body = renderIssueArtifact(issueContractFixture, issueFields);
  const fromJson = loadCanonicalJsonArtifact(issueContractFixture, { fields: issueFields });
  const fromMarkdown = loadCanonicalMarkdownArtifact(issueContractFixture, body);

  assert.equal(fromJson.valid, true);
  assert.equal(fromMarkdown.valid, true);
  assert.deepEqual(fromMarkdown.canonicalJson, fromJson.canonicalJson);
  assert.equal(loadCanonicalExistingArtifact(issueContractFixture, body).candidate.source, "existing");
});

test("PR JSON and native Markdown candidates converge to identical canonical JSON", () => {
  const body = renderPullRequestArtifact(pullRequestContractFixture, prFields);
  const fromJson = loadCanonicalJsonArtifact(pullRequestContractFixture, prFields);
  const fromMarkdown = loadCanonicalMarkdownArtifact(pullRequestContractFixture, body);

  assert.equal(fromJson.valid, true);
  assert.equal(fromMarkdown.valid, true);
  assert.deepEqual(fromMarkdown.canonicalJson, fromJson.canonicalJson);
});

test("invalid candidate reload is bounded and preserves accepted fields", () => {
  const result = loadCanonicalArtifact(
    issueContractFixture,
    adaptCliFieldCandidate({ ...issueFields, category: "not-a-contract-value", secret: "do-not-echo" }),
  );

  assert.equal(result.valid, false);
  assert.deepEqual(result.canonical, {
    problem: issueFields.problem,
    affected_areas: issueFields.affected_areas,
    acceptance: issueFields.acceptance,
  });
  assert.deepEqual(
    result.invalidFields.map((field) => field.field),
    ["category", "secret"],
  );
  assert.equal(JSON.stringify(result.diagnostics).includes("do-not-echo"), false);
  assert.equal(adaptExistingArtifactCandidate(issueContractFixture, "not a template").parsed, false);
});

test("JSON candidates with CRLF, a BOM, surrounding whitespace, and padded list entries normalize to the same canonical JSON as clean input", () => {
  const messyFields = {
    problem: `${BOM}  ${issueFields.problem}\r\n\r\n`,
    category: "  feature  ",
    affected_areas: ["  contracts \r\n"],
    acceptance: [" tests", "docs \r\n"],
  };

  const clean = loadCanonicalJsonArtifact(issueContractFixture, { fields: issueFields });
  const messy = loadCanonicalJsonArtifact(issueContractFixture, { fields: messyFields });

  assert.equal(clean.valid, true);
  assert.equal(messy.valid, true);
  assert.deepEqual(messy.canonicalJson, clean.canonicalJson);
});

test("CLI-field candidates normalize equivalently to JSON candidates for the same messy input", () => {
  const messyFields = {
    problem: `  ${issueFields.problem}\r\n`,
    category: "feature",
    affected_areas: issueFields.affected_areas,
    acceptance: issueFields.acceptance,
  };

  const fromJson = loadCanonicalJsonArtifact(issueContractFixture, { fields: messyFields });
  const fromCliFields = loadCanonicalArtifact(issueContractFixture, adaptCliFieldCandidate(messyFields));

  assert.equal(fromJson.valid, true);
  assert.equal(fromCliFields.valid, true);
  assert.deepEqual(fromCliFields.canonicalJson, fromJson.canonicalJson);
});

test("unsafe control-character content is rejected by the canonical loader instead of silently stripped", () => {
  const result = loadCanonicalArtifact(
    issueContractFixture,
    adaptCliFieldCandidate({ ...issueFields, problem: `broken${BELL}content` }),
  );

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.invalidFields.map((field) => field.field),
    ["problem"],
  );
  assert.equal(result.invalidFields[0]?.reason, "unsupported");
  const diagnostic = result.diagnostics.diagnostics.find((entry) => entry.path === "$.fields.problem");
  assert.equal(diagnostic?.state, "unsupported");
  assert.equal(diagnostic?.code, "FIELD_UNSUPPORTED");
  assert.equal(diagnostic?.detailCode, "FIELD_UNSUPPORTED");
  assert.equal(JSON.stringify(result.diagnostics).includes(String.fromCharCode(0x0007)), false);
});

test("a normalization rejection is diagnostically distinguishable from a semantic constraint violation", () => {
  const unsafeContent = loadCanonicalArtifact(
    issueContractFixture,
    adaptCliFieldCandidate({ ...issueFields, problem: `broken${BELL}content` }),
  );
  const constraintViolation = loadCanonicalArtifact(
    issueContractFixture,
    adaptCliFieldCandidate({ ...issueFields, category: "not-a-contract-value" }),
  );

  const unsafeDiagnostic = unsafeContent.diagnostics.diagnostics.find((entry) => entry.path === "$.fields.problem");
  const constraintDiagnostic = constraintViolation.diagnostics.diagnostics.find(
    (entry) => entry.path === "$.fields.category",
  );

  assert.equal(unsafeDiagnostic?.state, "unsupported");
  assert.equal(unsafeDiagnostic?.reason, "unsupported");
  assert.equal(constraintDiagnostic?.state, "invalid");
  assert.equal(constraintDiagnostic?.reason, "constraint");
  assert.notEqual(unsafeDiagnostic?.detailCode, constraintDiagnostic?.detailCode);
});

test("already-canonical valid JSON is unchanged by loading it through the normalization boundary", () => {
  const first = loadCanonicalJsonArtifact(issueContractFixture, { fields: issueFields });
  assert.equal(first.valid, true);
  const second = loadCanonicalJsonArtifact(issueContractFixture, { fields: first.canonicalJson });
  assert.equal(second.valid, true);
  assert.deepEqual(second.canonicalJson, first.canonicalJson);
});

test("whitespace-only required values remain rejected after normalization", () => {
  const result = loadCanonicalJsonArtifact(issueContractFixture, {
    fields: { ...issueFields, problem: "   \r\n  " },
  });

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.invalidFields.map((field) => field.field),
    ["problem"],
  );
});

test("a linked-issue reference value normalizes the same from JSON and native Markdown ingress despite CRLF and padding", () => {
  const cleanPrFields = { ...prFields, linked_issue: "Closes #21" };
  const messyPrFields = { ...prFields, linked_issue: "  Closes #21  \r\n" };

  const fromCleanJson = loadCanonicalJsonArtifact(pullRequestContractFixture, cleanPrFields);
  const fromMessyJson = loadCanonicalJsonArtifact(pullRequestContractFixture, messyPrFields);
  assert.equal(fromCleanJson.valid, true);
  assert.equal(fromMessyJson.valid, true);
  assert.deepEqual(fromMessyJson.canonicalJson, fromCleanJson.canonicalJson);

  const body = renderPullRequestArtifact(pullRequestContractFixture, cleanPrFields);
  const fromMarkdown = loadCanonicalMarkdownArtifact(pullRequestContractFixture, body);
  assert.equal(fromMarkdown.valid, true);
  assert.equal(fromMarkdown.canonicalJson.linked_issue, fromCleanJson.canonicalJson.linked_issue);
});

test("a cross-repository short-form reference normalizes the same after BOM and CRLF cleanup", () => {
  const result = loadCanonicalJsonArtifact(pullRequestContractFixture, {
    ...prFields,
    linked_issue: `${BOM}Fixes acme/widgets#42\r\n`,
  });

  assert.equal(result.valid, true);
  assert.equal(result.canonicalJson.linked_issue, "Fixes acme/widgets#42");
});

test("normalization does not launder a value that merely resembles a reference into a valid linked issue", () => {
  const result = loadCanonicalJsonArtifact(pullRequestContractFixture, {
    ...prFields,
    linked_issue: "  This closes nothing in particular  \r\n",
  });

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.invalidFields.map((field) => field.field),
    ["linked_issue"],
  );
});
