import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseExistingIssueArtifact,
  parseExistingPullRequestArtifact,
  prepareIssueArtifact,
  preparePullRequestArtifact,
  removeHtmlComments,
  renderIssueArtifact,
  renderPullRequestArtifact,
  validateExistingIssueArtifact,
  validateExistingPullRequestArtifact,
} from "./artifact.js";
import { projectToJsonSchema, LINKED_ISSUE_PATTERN } from "./contract/index.js";
import { issueContractFixture, pullRequestContractFixture } from "./contract/fixtures.js";
import { compilePullRequestPolicyOverlay } from "./pr-policy.js";
import { compilePullRequestTemplate, parsePullRequestTemplate } from "./pull-request-template.js";

test("Issue validation and rendering are deterministic and reversible", () => {
  const input = {
    problem: "# heading\n- [ ] user content",
    category: "feature",
    affected_areas: ["contracts", "docs"],
    acceptance: ["tests"],
  };
  const first = renderIssueArtifact(issueContractFixture, input);
  const second = renderIssueArtifact(issueContractFixture, input);
  assert.equal(first, second);
  assert.match(first, /\\# heading/);
  assert.match(first, /Describe the smallest useful outcome\./);

  const parsed = parseExistingIssueArtifact(issueContractFixture, first);
  assert.equal(parsed.parsed, true);
  assert.deepEqual(parsed.values, input);
  assert.equal(validateExistingIssueArtifact(issueContractFixture, first).classification, "valid");

  const prepared = prepareIssueArtifact(issueContractFixture, {
    fields: input,
    metadata: { title: "feat: preserve native labels" },
  });
  assert.deepEqual(prepared.artifact.labels, ["enhancement"]);
});

test("semantic violations are stable and mutation artifacts cannot be prepared", () => {
  assert.throws(
    () =>
      prepareIssueArtifact(issueContractFixture, {
        fields: { problem: "", category: "unknown", affected_areas: ["contracts", "contracts"], acceptance: ["bogus"] },
        metadata: { title: "feat: invalid" },
      }),
    (error: unknown) => {
      assert.equal(typeof error, "object");
      const violations = (error as { violations: readonly { code: string; path: string }[] }).violations;
      assert.deepEqual(
        violations.map((violation) => `${violation.code}:${violation.path}`),
        [
          "INPUT_REQUIRED:$.problem",
          "INPUT_ENUM:$.category",
          "INPUT_DUPLICATE:$.affected_areas",
          "INPUT_OPTION:$.acceptance[0]",
          "INPUT_CHECKLIST_REQUIRED:$.acceptance",
        ],
      );
      return true;
    },
  );
});

test("PR overlay compiles to the shared contract and schema authority", () => {
  const contract = compilePullRequestPolicyOverlay(
    pullRequestContractFixture,
    `version: 1\ntemplate: default\nsections:\n  - section: summary\n    required: true\n    minLength: 5\n  - section: linked_issue\n    linkedIssue: true\n  - section: acceptance\n    required: true\n    checklist:\n      minCompleted: 1\n`,
  );
  const schema = projectToJsonSchema(contract);
  assert.deepEqual(schema.required, ["summary", "linked_issue", "acceptance"]);
  assert.equal(schema.properties.summary?.minLength, 5);
  assert.equal(schema.properties.linked_issue?.pattern, LINKED_ISSUE_PATTERN);
  assert.equal(schema.properties.acceptance?.minItems, 1);
});

test("linkedIssue follows GitHub closing-keyword and cross-repository syntax", () => {
  const contract = compilePullRequestPolicyOverlay(
    pullRequestContractFixture,
    `version: 1\ntemplate: default\nsections:\n  - section: linked_issue\n    linkedIssue: true\n`,
  );
  const validReferences = [
    "Closes #10",
    "CLOSES: #10",
    "closed #10",
    "Fix #10",
    "fixed #10",
    "resolve #10",
    "Resolved: octo-org/octo-repo#100",
    "Resolves #10, resolves #123, resolves octo-org/octo-repo#100",
  ];
  for (const linked_issue of validReferences) {
    assert.doesNotThrow(() =>
      renderPullRequestArtifact(contract, { summary: "A useful summary", linked_issue, acceptance: ["tests"] }),
    );
  }

  const invalidReferences = ["see #10", "Closes", "Closes #0", "Closes issue #10", "Closes octo-org/octo-repo/#10"];
  for (const linked_issue of invalidReferences) {
    assert.throws(() =>
      renderPullRequestArtifact(contract, { summary: "A useful summary", linked_issue, acceptance: ["tests"] }),
    );
  }
});

test("one PR policy file binds multiple native templates deterministically", () => {
  const releaseContract = {
    ...pullRequestContractFixture,
    templateIdentity: {
      ...pullRequestContractFixture.templateIdentity,
      id: "release",
      name: "release",
      path: ".github/PULL_REQUEST_TEMPLATE/release.md",
    },
    nativeMetadata: {
      ...pullRequestContractFixture.nativeMetadata,
      path: ".github/PULL_REQUEST_TEMPLATE/release.md",
    },
  };
  const source = `version: 1\ntemplates:\n  - template: default\n    sections:\n      - section: summary\n        minLength: 10\n  - template: release\n    sections:\n      - section: summary\n        minLength: 20\n`;
  const templateIdentities = [pullRequestContractFixture.templateIdentity, releaseContract.templateIdentity];

  const defaultContract = compilePullRequestPolicyOverlay(pullRequestContractFixture, source, { templateIdentities });
  const selectedReleaseContract = compilePullRequestPolicyOverlay(releaseContract, source, { templateIdentities });
  assert.equal(
    defaultContract.supplementalConstraints.fields.find((field) => field.fieldId === "summary")?.minLength,
    10,
  );
  assert.equal(
    selectedReleaseContract.supplementalConstraints.fields.find((field) => field.fieldId === "summary")?.minLength,
    20,
  );

  assert.throws(
    () =>
      compilePullRequestPolicyOverlay(
        pullRequestContractFixture,
        `version: 1\ntemplates:\n  - template: default\n    sections: []\n  - template: default\n    sections: []\n`,
      ),
    (error: unknown) => (error as { code?: string }).code === "PR_POLICY_AMBIGUOUS_REFERENCE",
  );
  assert.throws(
    () =>
      compilePullRequestPolicyOverlay(
        pullRequestContractFixture,
        `version: 1\ntemplates:\n  - template: stale\n    sections: []\n  - template: release\n    sections: []\n`,
        { templateIdentities },
      ),
    (error: unknown) => (error as { code?: string }).code === "PR_POLICY_TEMPLATE_MISMATCH",
  );
});

test("PR policy overlay fault paths produce deterministic errors", () => {
  assert.throws(
    () =>
      compilePullRequestPolicyOverlay(pullRequestContractFixture, `version: 999\ntemplate: default\nsections: []\n`),
    (error: unknown) => {
      const err = error as { code: string };
      assert.equal(err.code, "PR_POLICY_UNSUPPORTED_VERSION");
      return true;
    },
  );

  assert.throws(
    () =>
      compilePullRequestPolicyOverlay(
        pullRequestContractFixture,
        `version: 1\ntemplate: wrong-template\nsections: []\n`,
      ),
    (error: unknown) => {
      const err = error as { code: string };
      assert.equal(err.code, "PR_POLICY_TEMPLATE_MISMATCH");
      return true;
    },
  );

  assert.throws(
    () =>
      compilePullRequestPolicyOverlay(
        pullRequestContractFixture,
        `version: 1\ntemplate: default\nsections:\n  - section: unknown_section\n    required: true\n`,
      ),
    (error: unknown) => {
      const err = error as { code: string };
      assert.equal(err.code, "PR_POLICY_UNKNOWN_REFERENCE");
      return true;
    },
  );

  assert.throws(
    () =>
      compilePullRequestPolicyOverlay(
        pullRequestContractFixture,
        `version: 1\ntemplate: default\nsections:\n  - section: summary\n    linkedIssue: true\n    pattern: ".*"\n`,
      ),
    (error: unknown) => {
      const err = error as { code: string };
      assert.equal(err.code, "PR_POLICY_CONFLICT");
      return true;
    },
  );

  assert.throws(
    () =>
      compilePullRequestPolicyOverlay(
        pullRequestContractFixture,
        `version: 1\ntemplate: default\nsections:\n  - section: acceptance\n    linkedIssue: true\n`,
      ),
    (error: unknown) => {
      const err = error as { code: string };
      assert.equal(err.code, "PR_POLICY_UNSUPPORTED_CONSTRAINT");
      return true;
    },
  );

  assert.throws(
    () =>
      compilePullRequestPolicyOverlay(
        pullRequestContractFixture,
        `version: 1\ntemplate: default\nsections:\n  - section: summary\n    required: true\n  - section: summary\n    required: false\n`,
      ),
    (error: unknown) => {
      const err = error as { code: string };
      assert.equal(err.code, "PR_POLICY_CONFLICT");
      return true;
    },
  );
});

test("PR rendering and existing-artifact validation share semantic rules", () => {
  const input = { summary: "A useful summary", linked_issue: "Closes #22", acceptance: ["tests"] };
  const body = renderPullRequestArtifact(pullRequestContractFixture, input);
  const parsed = parseExistingPullRequestArtifact(pullRequestContractFixture, body);
  assert.equal(parsed.parsed, true);
  assert.deepEqual(parsed.values, input);
  assert.equal(validateExistingPullRequestArtifact(pullRequestContractFixture, body).classification, "valid");

  const drift = validateExistingPullRequestArtifact(
    pullRequestContractFixture,
    body.replace("Closes #22", "No linked issue"),
  );
  assert.equal(drift.classification, "semantic");
  assert.equal(drift.valid, false);
  assert.deepEqual(
    drift.violations.map((violation) => `${violation.code}:${violation.path}`),
    ["INPUT_PATTERN:$.linked_issue"],
  );
});

test("wrong-template and unparseable existing bodies are distinguished", () => {
  const wrong = validateExistingIssueArtifact(issueContractFixture, "### Other\n\nvalue\n");
  assert.equal(wrong.classification, "wrong-template");
  const malformed = validateExistingIssueArtifact(issueContractFixture, "not a canonical artifact\n");
  assert.equal(malformed.classification, "unparseable");
});

test("PR placeholder-only sections reconstruct as omitted semantic values", async () => {
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const nativeContract = await compilePullRequestTemplate(repositoryRoot, "default");
  const body = renderPullRequestArtifact(nativeContract, {
    summary: "A deterministic summary",
    linked_issue: "Closes #22",
    validation: ["tests"],
  });
  const parsed = parseExistingPullRequestArtifact(nativeContract, body);
  assert.equal(parsed.parsed, true);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.values, "breaking_changes"), false);
});

test("existing PR validation accepts a body filled from a native template with comments", () => {
  const contract = parsePullRequestTemplate(
    "<!-- Guidance for reviewers. -->\n\n## Summary\n<!-- Explain the change. -->\n",
    {
      id: "pull-request-default:.github/PULL_REQUEST_TEMPLATE.md",
      type: "pull-request-default",
      kind: "pull-request",
      name: "default",
      path: ".github/PULL_REQUEST_TEMPLATE.md",
    },
  );
  const nativeBody = "<!-- Guidance for reviewers. -->\n\n## Summary\n<!-- Explain the change. -->\nA useful summary\n";
  const parsed = parseExistingPullRequestArtifact(contract, nativeBody);
  assert.equal(parsed.parsed, true);
  assert.deepEqual(parsed.values, { summary: "A useful summary" });
});

test("PR checklist placeholders are structural and do not make canonical artifacts unparseable", () => {
  const contract = parsePullRequestTemplate("## Validation\n\nSelect completed items:\n\n- [ ] Tests\n- [ ] Build\n", {
    id: "pull-request:.github/PULL_REQUEST_TEMPLATE.md",
    type: "pull-request-default",
    kind: "pull-request",
    name: "default",
    path: ".github/PULL_REQUEST_TEMPLATE.md",
  });
  const body = renderPullRequestArtifact(contract, { validation: ["tests"] });
  const parsed = parseExistingPullRequestArtifact(contract, body);
  assert.equal(parsed.parsed, true);
  assert.deepEqual(parsed.values, { validation: ["tests"] });
});

test("HTML comment removal is linear and fails closed on unterminated comments", () => {
  assert.equal(removeHtmlComments("before<!--hidden-->after"), "beforeafter");
  assert.equal(removeHtmlComments("before<!--unterminated"), "before");
  assert.equal(removeHtmlComments("<!--".repeat(10_000)), "");
  assert.equal(removeHtmlComments("<!--unterminated<!--nested"), "");
});
