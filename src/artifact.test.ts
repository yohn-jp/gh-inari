import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ArtifactPreparationError,
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
import {
  compileIssueFormYaml,
  projectToJsonSchema,
  LINKED_ISSUE_PATTERN,
  type CanonicalContract,
} from "./contract/index.js";
import { issueContractFixture, pullRequestContractFixture } from "./contract/fixtures.js";
import { compilePullRequestPolicyOverlay, parsePullRequestPolicyOverlay } from "./pr-policy.js";
import {
  compilePullRequestTemplate,
  compilePullRequestTemplatesSync,
  parsePullRequestTemplate,
} from "./pull-request-template.js";
import { compileSemanticTemplateSource, normalizeSemanticTemplate } from "./semantic-template.js";

function governedFixture(contract: CanonicalContract): CanonicalContract {
  return {
    ...contract,
    provenance: {
      authority: "repository-default-branch",
      repository: {
        host: "github.com",
        owner: "acme",
        name: "inari",
        nameWithOwner: "acme/inari",
      },
      ref: "main",
      treeSha: "fixture-tree-sha",
      template: {
        path: contract.templateIdentity.path,
        ref: "main",
        sha: "fixture-template-sha",
        digest: "fixture-template-digest",
      },
    },
  };
}

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
  assert.doesNotMatch(first, /Describe the smallest useful outcome\./);

  const parsed = parseExistingIssueArtifact(issueContractFixture, first);
  assert.equal(parsed.parsed, true);
  assert.deepEqual(parsed.values, input);
  assert.equal(validateExistingIssueArtifact(issueContractFixture, first).classification, "valid");

  const prepared = prepareIssueArtifact(governedFixture(issueContractFixture), {
    fields: input,
    metadata: { title: "feat: preserve native labels" },
  });
  assert.deepEqual(prepared.artifact.labels, ["enhancement"]);
});

test("Issue rendering uses governed option labels while preserving semantic values", () => {
  const source = normalizeSemanticTemplate({
    version: 1,
    kind: "issue",
    id: "mapped-options",
    name: "Mapped options",
    description: "Issue Form option mapping fixture",
    sections: [
      {
        id: "priority",
        kind: "input",
        type: "enum",
        label: "Priority",
        required: true,
        options: [
          { id: "critical", value: "p-critical", label: "Critical" },
          { id: "normal", value: "p-normal", label: "Normal" },
        ],
      },
      {
        id: "areas",
        kind: "input",
        type: "array",
        label: "Areas",
        multiple: true,
        options: [
          { id: "frontend", value: "area-frontend", label: "Frontend" },
          { id: "backend", value: "area-backend", label: "Backend" },
        ],
      },
    ],
  });
  const contract = compileSemanticTemplateSource(source, ".github/ISSUE_TEMPLATE/mapped-options.yml");
  const fields = { priority: "p-critical", areas: ["area-backend", "area-frontend"] };

  const body = renderIssueArtifact(contract, fields);
  assert.match(body, /### Priority\n\nCritical\n/u);
  assert.match(body, /### Areas\n\nBackend, Frontend\n/u);
  assert.doesNotMatch(body, /p-critical|area-backend|area-frontend/u);

  const parsed = parseExistingIssueArtifact(contract, body);
  assert.equal(parsed.parsed, true);
  assert.deepEqual(parsed.values, fields);
});

test("prepared PR artifacts prove comment, preamble, and checklist-placeholder round trips", () => {
  const contract = governedFixture(
    parsePullRequestTemplate(
      "<!-- Repository guidance -->\n\n## Summary\n<!-- Explain the change. -->\n\n## Validation\n\nSelect completed items:\n\n- [ ] Tests\n- [ ] Build\n",
      {
        id: "pull-request-default:.github/PULL_REQUEST_TEMPLATE.md",
        type: "pull-request-default",
        kind: "pull-request",
        name: "default",
        path: ".github/PULL_REQUEST_TEMPLATE.md",
      },
    ),
  );
  const prepared = preparePullRequestArtifact(contract, {
    fields: { summary: "A complete prepared artifact", validation: ["tests"] },
    metadata: { title: "fix: round trip", head: "feature", base: "main" },
  });

  assert.deepEqual(parseExistingPullRequestArtifact(contract, prepared.artifact.body).values, {
    summary: "A complete prepared artifact",
    validation: ["tests"],
  });
  assert.deepEqual(prepared.artifact.provenance.repository, {
    host: "github.com",
    owner: "acme",
    name: "inari",
    nameWithOwner: "acme/inari",
  });
});

test("prepared PR artifacts preserve checklist values before commented trailing documentation", () => {
  const contract = governedFixture(
    parsePullRequestTemplate(
      [
        "## Validation",
        "",
        "- [ ] Typecheck",
        "- [ ] Tests",
        "",
        "<!-- explanatory template comment -->",
        "",
        "Test layers:",
        "",
        "- Fast / unit: `pnpm test`",
        "- Integration: `pnpm run test:integration`",
        "",
        "## Test contract",
        "",
      ].join("\n"),
      {
        id: "pull-request-default:.github/PULL_REQUEST_TEMPLATE.md",
        type: "pull-request-default",
        kind: "pull-request",
        name: "default",
        path: ".github/PULL_REQUEST_TEMPLATE.md",
      },
    ),
  );
  const fields = { validation: ["typecheck", "tests"], test_contract: "The test contract is explicit." };
  const prepared = preparePullRequestArtifact(contract, {
    fields,
    metadata: { title: "fix: preserve trailing documentation", head: "feature", base: "main" },
  });

  assert.deepEqual(parseExistingPullRequestArtifact(contract, prepared.artifact.body).values, fields);

  const malformed = parseExistingPullRequestArtifact(
    contract,
    prepared.artifact.body.replace("Test layers:", "Unexpected checklist content\n\nTest layers:"),
  );
  assert.equal(malformed.parsed, false);
  assert.ok(malformed.diagnostics.some((diagnostic) => diagnostic.code === "EXISTING_UNPARSEABLE"));
});

test("preparation fails with typed diagnostics when rendering loses a semantic value", () => {
  const contract = governedFixture(
    compileIssueFormYaml(
      "name: Optional\ndescription: Optional\nbody:\n  - type: input\n    id: optional\n    attributes:\n      label: Optional\n",
      {
        id: "issue-form:optional.yml",
        type: "issue-form",
        kind: "issue",
        name: "optional",
        path: ".github/ISSUE_TEMPLATE/optional.yml",
      },
    ),
  );

  assert.throws(
    () =>
      prepareIssueArtifact(contract, {
        fields: { optional: "" },
        metadata: { title: "fix: invalid round trip" },
      }),
    (error: unknown) =>
      error instanceof ArtifactPreparationError &&
      error.code === "ARTIFACT_ROUND_TRIP_INVALID" &&
      error.diagnostics.some((diagnostic) => diagnostic.code === "ROUND_TRIP_MISMATCH"),
  );
});

test("Issue Form native defaults, no-response values, dropdowns, checkboxes, and markdown blocks round-trip", () => {
  const contract = compileIssueFormYaml(
    `name: Native form
description: Native submission fixture
title: "[Bug] "
labels: [bug]
body:
  - type: markdown
    attributes:
      value: Before the fields
  - type: input
    id: contact
    attributes:
      label: Contact
  - type: markdown
    attributes:
      value: Between the fields
  - type: textarea
    id: details
    attributes:
      label: Details
      value: Default details
  - type: dropdown
    id: priority
    attributes:
      label: Priority
      options: [Low, High]
      default: 1
  - type: dropdown
    id: areas
    attributes:
      label: Areas
      multiple: true
      options: [frontend, docs]
  - type: checkboxes
    id: agreement
    attributes:
      label: Agreement
      options:
        - label: I agree
          required: true
        - label: I read the guide
  - type: input
    id: optional
    attributes:
      label: Optional
  - type: markdown
    attributes:
      value: After the fields
`,
    {
      id: "issue-form:native.yml",
      type: "issue-form",
      kind: "issue",
      name: "native",
      path: ".github/ISSUE_TEMPLATE/native.yml",
    },
  );
  const nativeBody = `### Contact
alice@example.com

### Details
Observed behavior

### Priority
High

### Areas
frontend, docs

### Agreement
- [x] I agree
- [ ] I read the guide

### Optional
_No response_
`;
  const parsed = parseExistingIssueArtifact(contract, nativeBody);
  assert.equal(parsed.parsed, true);
  assert.deepEqual(parsed.values, {
    contact: "alice@example.com",
    details: "Observed behavior",
    priority: "High",
    areas: ["frontend", "docs"],
    agreement: ["I-agree"],
  });
  assert.equal(validateExistingIssueArtifact(contract, nativeBody).valid, true);

  const rendered = renderIssueArtifact(contract, {
    contact: "alice@example.com",
    agreement: ["I-agree"],
  });
  assert.doesNotMatch(rendered, /Before the fields|Between the fields|After the fields/);
  assert.match(rendered, /### Priority\n\nHigh/);
  assert.match(rendered, /### Areas\n\n_No response_/);
});

test("native textarea render output uses and parses GitHub code fences", () => {
  const contract = compileIssueFormYaml(
    `name: Logs
description: Rendered logs
body:
  - type: markdown
    attributes:
      value: Guidance is not submitted
  - type: textarea
    id: logs
    attributes:
      label: Logs
      render: shell
`,
    {
      id: "issue-form:logs.yml",
      type: "issue-form",
      kind: "issue",
      name: "logs",
      path: ".github/ISSUE_TEMPLATE/logs.yml",
    },
  );
  const emptyNativeBody = "### Logs\n\n```shell\n\n```\n";
  assert.equal(validateExistingIssueArtifact(contract, emptyNativeBody).valid, true);
  assert.equal(renderIssueArtifact(contract, { logs: "echo hello" }), "### Logs\n\n```shell\necho hello\n```\n");
  const parsed = parseExistingIssueArtifact(contract, "### Logs\n\n```shell\necho hello\n```\n");
  assert.deepEqual(parsed.values, { logs: "echo hello" });
  assert.equal(parsed.parsed, true);
});

test("headings inside a rendered textarea fence do not truncate the field or misparse the next section", () => {
  const contract = compileIssueFormYaml(
    `name: Logs
description: Rendered logs
body:
  - type: textarea
    id: logs
    attributes:
      label: Logs
      render: shell
  - type: input
    id: priority
    attributes:
      label: Priority
`,
    {
      id: "issue-form:logs.yml",
      type: "issue-form",
      kind: "issue",
      name: "logs",
      path: ".github/ISSUE_TEMPLATE/logs.yml",
    },
  );
  const body = "### Logs\n\n```shell\n### Priority\necho hello\n```\n\n### Priority\n\nhigh\n";
  const parsed = parseExistingIssueArtifact(contract, body);
  assert.deepEqual(parsed.values, { logs: "### Priority\necho hello", priority: "high" });
  assert.equal(parsed.parsed, true);
});

test("native title defaults and caller labels are deterministic", () => {
  const prepared = prepareIssueArtifact(governedFixture(issueContractFixture), {
    fields: { problem: "problem", category: "feature", affected_areas: [], acceptance: ["tests"] },
    metadata: { labels: ["custom", "enhancement"] },
  });
  assert.equal(prepared.artifact.title, "Feature");
  assert.deepEqual(prepared.artifact.labels, ["enhancement", "custom"]);

  const explicit = prepareIssueArtifact(governedFixture(issueContractFixture), {
    fields: { problem: "problem", category: "feature", affected_areas: [], acceptance: ["tests"] },
    metadata: { title: "custom title" },
  });
  assert.equal(explicit.artifact.title, "custom title");
});

test("semantic violations are stable and mutation artifacts cannot be prepared", () => {
  assert.throws(
    () =>
      prepareIssueArtifact(governedFixture(issueContractFixture), {
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

test("rejects PR policy patterns with catastrophic-backtracking-prone structure", () => {
  const catastrophicPatterns = ["(a+)+$", "(a*)*$", "(a+)*b", "(a|a)+$", "(a|ab)*c", "([a-zA-Z]+)*$"];

  for (const pattern of catastrophicPatterns) {
    assert.throws(
      () =>
        compilePullRequestPolicyOverlay(
          pullRequestContractFixture,
          `version: 1\ntemplate: default\nsections:\n  - section: summary\n    pattern: "${pattern.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"\n`,
        ),
      (error: unknown) => {
        const err = error as { code: string };
        assert.equal(err.code, "PR_POLICY_INVALID_VALUE");
        return true;
      },
      `expected pattern to be rejected: ${pattern}`,
    );
  }
});

test("rejects PR policy patterns using backreferences", () => {
  assert.throws(
    () =>
      compilePullRequestPolicyOverlay(
        pullRequestContractFixture,
        `version: 1\ntemplate: default\nsections:\n  - section: summary\n    pattern: "(a)\\\\1"\n`,
      ),
    (error: unknown) => {
      const err = error as { code: string };
      assert.equal(err.code, "PR_POLICY_INVALID_VALUE");
      return true;
    },
  );
});

test("accepts ordinary PR policy patterns without nested quantifiers or backreferences", () => {
  const safePatterns = ["^Closes #\\d+$", ".*", "[a-z]+-[0-9]+", "^(feat|fix|chore): .+$", "\\w{3,20}"];

  for (const pattern of safePatterns) {
    assert.doesNotThrow(() =>
      compilePullRequestPolicyOverlay(
        pullRequestContractFixture,
        `version: 1\ntemplate: default\nsections:\n  - section: summary\n    pattern: "${pattern.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"\n`,
      ),
    );
  }
});

test("PR policy overlay parses an optional repository branch rule alongside section rules", () => {
  const overlay = parsePullRequestPolicyOverlay(
    `version: 1\ntemplate: default\nsections: []\nbranch:\n  pattern: "^(feat|fix)/\\\\d+-[a-z0-9-]+$"\n`,
  );
  assert.deepEqual(overlay.branch, { pattern: "^(feat|fix)/\\d+-[a-z0-9-]+$" });
});

test("a repository PR policy with no branch key declares no branch governance", () => {
  const overlay = parsePullRequestPolicyOverlay(`version: 1\ntemplate: default\nsections: []\n`);
  assert.equal(overlay.branch, undefined);
});

test("PR policy branch rule fails closed on a malformed declaration", () => {
  assert.throws(
    () => parsePullRequestPolicyOverlay(`version: 1\ntemplate: default\nsections: []\nbranch: "feat/*"\n`),
    (error: unknown) => {
      const err = error as { code: string };
      assert.equal(err.code, "PR_POLICY_INVALID_VALUE");
      return true;
    },
  );
  assert.throws(
    () => parsePullRequestPolicyOverlay(`version: 1\ntemplate: default\nsections: []\nbranch: {}\n`),
    (error: unknown) => {
      const err = error as { code: string };
      assert.equal(err.code, "PR_POLICY_INVALID_VALUE");
      return true;
    },
  );
  assert.throws(
    () =>
      parsePullRequestPolicyOverlay(
        `version: 1\ntemplate: default\nsections: []\nbranch:\n  pattern: "^x"\n  extra: true\n`,
      ),
    (error: unknown) => {
      const err = error as { code: string };
      assert.equal(err.code, "PR_POLICY_UNKNOWN_PROPERTY");
      return true;
    },
  );
});

test("PR policy branch rule reuses the shared regex-safety gate", () => {
  assert.throws(
    () => parsePullRequestPolicyOverlay(`version: 1\ntemplate: default\nsections: []\nbranch:\n  pattern: "(a+)+$"\n`),
    (error: unknown) => {
      const err = error as { code: string };
      assert.equal(err.code, "PR_POLICY_INVALID_VALUE");
      return true;
    },
  );
  assert.throws(
    () =>
      parsePullRequestPolicyOverlay(`version: 1\ntemplate: default\nsections: []\nbranch:\n  pattern: "(a)\\\\1"\n`),
    (error: unknown) => {
      const err = error as { code: string };
      assert.equal(err.code, "PR_POLICY_INVALID_VALUE");
      return true;
    },
  );
  assert.doesNotThrow(() =>
    parsePullRequestPolicyOverlay(
      `version: 1\ntemplate: default\nsections: []\nbranch:\n  pattern: "^feat/\\\\d+-.+$"\n`,
    ),
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

test("all native PR templates render and parse canonical values in contract order", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const contracts = compilePullRequestTemplatesSync(root);
  assert.ok(contracts.length >= 2);

  for (const contract of contracts) {
    const input: Record<string, unknown> = {};
    for (const section of contract.sections) {
      for (const field of section.fields) {
        if (field.type === "checklist") {
          input[field.id] = field.items.length === 0 ? [] : [field.items[0]?.id];
        } else if (field.type === "array") {
          input[field.id] = [`value for ${field.id}`];
        } else {
          input[field.id] = `value for ${field.id}\nsecond line`;
        }
      }
    }

    const body = renderPullRequestArtifact(contract, input);
    const reversedInput = Object.fromEntries(Object.entries(input).reverse());
    assert.equal(renderPullRequestArtifact(contract, reversedInput), body, contract.templateIdentity.path);
    const parsed = parseExistingPullRequestArtifact(contract, body);
    assert.equal(parsed.parsed, true, contract.templateIdentity.path);
    assert.deepEqual(parsed.values, input, contract.templateIdentity.path);
  }
});

test("governed default PR rendering preserves policy-constrained values", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const native = await compilePullRequestTemplate(root, "default");
  const policy = readFileSync(new URL("../.github/inari/pr-policy.yml", import.meta.url), "utf8");
  const contract = compilePullRequestPolicyOverlay(native, policy);
  const schema = projectToJsonSchema(contract);
  assert.equal(schema.properties.summary?.minLength, 10);
  assert.equal(schema.properties.linked_issue?.pattern, LINKED_ISSUE_PATTERN);
  assert.equal(schema.required?.includes("validation"), true);

  const input = {
    summary: "A governed summary",
    linked_issue: "Closes #125",
    validation: "pnpm test",
  };
  const body = renderPullRequestArtifact(contract, input);
  const parsed = parseExistingPullRequestArtifact(contract, body);
  assert.equal(parsed.parsed, true);
  assert.deepEqual(parsed.values, input);
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
    validation: "pnpm test",
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
