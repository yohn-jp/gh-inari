import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  compileIssueFormTemplate,
  compileIssueFormYaml,
  IssueFormCompilerError,
  projectToJsonSchema,
  serializeCanonicalContract,
  serializeJsonSchema,
  type IssueFormTemplateIdentity,
} from "./index.js";
import { discoverTemplates } from "../template-discovery.js";

const TEMPLATE: IssueFormTemplateIdentity = {
  id: "issue-form:.github/ISSUE_TEMPLATE/complete.yml",
  type: "issue-form",
  kind: "issue",
  name: "complete",
  path: ".github/ISSUE_TEMPLATE/complete.yml",
};

const REPRESENTATIVE_FORM = `name: Complete form
description: Every supported field in one deterministic form.
title: "[Issue] "
labels:
  - bug
  - triage
body:
  - type: markdown
    attributes:
      value: |
        ## Before you start

        Please provide reproducible details.
  - type: input
    id: contact
    attributes:
      label: Contact
      description: Where can we reach you?
      placeholder: name@example.com
    validations:
      required: true
  - type: textarea
    id: details
    attributes:
      label: Details
      description: Describe the behavior.
      placeholder: What happened?
      value: A prefilled detail.
    validations:
      required: false
  - type: dropdown
    id: priority
    attributes:
      label: Priority
      description: Select one priority.
      options:
        - Low
        - High
      default: 1
    validations:
      required: true
  - type: dropdown
    id: areas
    attributes:
      label: Areas
      multiple: true
      options:
        - frontend
        - backend
        - docs
      default: 0
    validations:
      required: false
  - type: checkboxes
    id: agreement
    attributes:
      label: Agreement
      description: Please confirm the following.
      options:
        - label: I agree to the Code of Conduct
          required: true
        - label: I read the contribution guide
          required: false
    validations:
      required: false
  - type: checkboxes
    id: optional
    attributes:
      label: Optional checks
      options:
        - label: Include extra diagnostics
          required: false
    validations:
      required: false
  - type: markdown
    attributes:
      value: Thanks for completing the form.
`;

test("compiles every supported Issue Form field and preserves source order", () => {
  const contract = compileIssueFormYaml(REPRESENTATIVE_FORM, TEMPLATE);

  assert.deepEqual(
    contract.sections.map((section) => ({ id: section.id, kind: section.kind })),
    [
      { id: "markdown-0", kind: "documentation" },
      { id: "contact", kind: "input" },
      { id: "details", kind: "input" },
      { id: "priority", kind: "input" },
      { id: "areas", kind: "input" },
      { id: "agreement", kind: "input" },
      { id: "optional", kind: "input" },
      { id: "markdown-7", kind: "documentation" },
    ],
  );
  assert.equal(contract.templateIdentity.id, "complete");
  assert.equal(contract.templateIdentity.name, "Complete form");
  assert.equal(contract.nativeMetadata.title, "[Issue] ");
  assert.deepEqual(contract.nativeMetadata.labels, ["bug", "triage"]);
  assert.equal(contract.sections[0]?.content, "## Before you start\n\nPlease provide reproducible details.\n");
  assert.equal(contract.sections[0]?.fields.length, 0);
  assert.equal(contract.sections[1]?.fields[0]?.nativeMetadata.placeholder, "name@example.com");
  assert.equal(contract.sections[2]?.fields[0]?.nativeMetadata.defaultValue, "A prefilled detail.");

  const fields = new Map(contract.sections.flatMap((section) => section.fields).map((field) => [field.id, field]));
  const priority = fields.get("priority");
  assert.equal(priority?.type, "enum");
  if (priority?.type === "enum") {
    assert.deepEqual(
      priority.options.map((option) => option.value),
      ["Low", "High"],
    );
    assert.equal(priority.defaultValue, "High");
    assert.equal(priority.required, "required");
  }
  const areas = fields.get("areas");
  assert.equal(areas?.type, "array");
  if (areas?.type === "array") {
    assert.equal(areas.selection, "multi_select");
    assert.deepEqual(
      areas.items.options?.map((option) => option.value),
      ["frontend", "backend", "docs"],
    );
    assert.deepEqual(areas.defaultValue, ["frontend"]);
    assert.equal(areas.nativeMetadata.multiple, true);
  }
  const agreement = fields.get("agreement");
  assert.equal(agreement?.type, "checklist");
  if (agreement?.type === "checklist") {
    assert.equal(agreement.required, "required");
    assert.deepEqual(
      agreement.items.map((item) => ({ label: item.label, required: item.required })),
      [
        { label: "I agree to the Code of Conduct", required: true },
        { label: "I read the contribution guide", required: false },
      ],
    );
    assert.deepEqual(
      agreement.nativeMetadata.options?.map((option) => ({ value: option.value, required: option.required })),
      agreement.items.map((item) => ({ value: item.id, required: item.required })),
    );
  }
  const optional = fields.get("optional");
  assert.equal(optional?.type, "checklist");
  assert.equal(optional?.required, "optional");
});

test("projects the compiled Issue Form through the existing JSON Schema projection", () => {
  const contract = compileIssueFormYaml(REPRESENTATIVE_FORM, TEMPLATE);
  const schema = projectToJsonSchema(contract);

  assert.deepEqual(Object.keys(schema.properties), [
    "contact",
    "details",
    "priority",
    "areas",
    "agreement",
    "optional",
  ]);
  assert.deepEqual(schema.required, ["contact", "priority", "agreement"]);
  assert.deepEqual(schema.properties.priority?.enum, ["Low", "High"]);
  assert.equal(schema.properties.priority?.default, "High");
  assert.deepEqual(schema.properties.areas?.items?.enum, ["frontend", "backend", "docs"]);
  assert.deepEqual(schema.properties.areas?.default, ["frontend"]);
  const agreement = contract.sections.find((section) => section.id === "agreement")?.fields[0];
  assert.equal(agreement?.type, "checklist");
  if (agreement?.type === "checklist") {
    const requiredItem = agreement.items.find((item) => item.required);
    assert.ok(requiredItem);
    assert.deepEqual(schema.properties.agreement?.allOf, [{ contains: { const: requiredItem.id }, minContains: 1 }]);
  }
  assert.equal("sections" in schema, false);
  assert.equal("nativeMetadata" in schema, false);
});

test("compiled IR and schema serialization are deterministic", () => {
  const first = compileIssueFormYaml(REPRESENTATIVE_FORM, TEMPLATE);
  const second = compileIssueFormYaml(REPRESENTATIVE_FORM, TEMPLATE);
  assert.equal(serializeCanonicalContract(first), serializeCanonicalContract(second));
  assert.equal(serializeJsonSchema(projectToJsonSchema(first)), serializeJsonSchema(projectToJsonSchema(second)));
});

test("uses the merged discovery result to read and compile a selected repository template", async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "inari-issue-form-compiler-"));
  try {
    const templateDirectory = path.join(repositoryRoot, ".github", "ISSUE_TEMPLATE");
    await mkdir(templateDirectory, { recursive: true });
    await writeFile(path.join(templateDirectory, "complete.yml"), REPRESENTATIVE_FORM, "utf8");
    const discovery = await discoverTemplates(repositoryRoot);
    const contract = await compileIssueFormTemplate(discovery, "issue-form:.github/ISSUE_TEMPLATE/complete.yml");
    assert.equal(contract.templateIdentity.name, "Complete form");
    assert.equal(contract.nativeMetadata.path, ".github/ISSUE_TEMPLATE/complete.yml");
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("malformed YAML produces a typed error with source location", () => {
  assert.throws(
    () => compileIssueFormYaml("name: [\n", TEMPLATE),
    (error: unknown) => {
      assert.ok(error instanceof IssueFormCompilerError);
      assert.equal(error.code, "ISSUE_FORM_INVALID_YAML");
      assert.equal(error.context.templatePath, TEMPLATE.path);
      assert.equal(error.context.yamlPath, "$");
      assert.equal(typeof error.context.line, "number");
      return true;
    },
  );
});

test("malformed form schema, duplicate IDs, and invalid defaults fail closed", () => {
  const malformed = `name: Form
description: Description
unknown: true
body:
  - type: input
    id: duplicate
    attributes:
      label: First
  - type: input
    id: duplicate
    attributes:
      label: Second
  - type: dropdown
    id: choice
    attributes:
      label: Choice
      options:
        - one
        - one
      default: 3
`;
  assertCompilerCode(malformed, TEMPLATE, "ISSUE_FORM_UNKNOWN_PROPERTY");
  assert.throws(
    () => compileIssueFormYaml(malformed, TEMPLATE),
    (error: unknown) =>
      error instanceof IssueFormCompilerError &&
      error.violations.some((violation) => violation.code === "ISSUE_FORM_DUPLICATE_ID"),
  );
  assert.throws(
    () => compileIssueFormYaml(malformed, TEMPLATE),
    (error: unknown) =>
      error instanceof IssueFormCompilerError &&
      error.violations.some((violation) => violation.code === "ISSUE_FORM_DUPLICATE_VALUE"),
  );
  assert.throws(
    () => compileIssueFormYaml(malformed, TEMPLATE),
    (error: unknown) =>
      error instanceof IssueFormCompilerError &&
      error.violations.some((violation) => violation.path === "$.body[2].attributes.default"),
  );
});

test("missing IDs are ambiguous while native-valid and native-invalid IDs follow GitHub's syntax", () => {
  const missingId = `name: Form
description: Description
body:
  - type: input
    attributes:
      label: Name
`;
  assert.throws(
    () => compileIssueFormYaml(missingId, TEMPLATE),
    (error: unknown) =>
      error instanceof IssueFormCompilerError &&
      error.violations.some((violation) => violation.code === "ISSUE_FORM_AMBIGUOUS"),
  );

  const nativeValidIds = `name: Form
description: Description
body:
  - type: input
    id: 123-invalid
    attributes:
      label: Numeric start
  - type: input
    id: _underscore
    attributes:
      label: Underscore start
  - type: input
    id: -hyphen
    attributes:
      label: Hyphen start
`;
  const nativeContract = compileIssueFormYaml(nativeValidIds, TEMPLATE);
  assert.deepEqual(
    nativeContract.sections.map((section) => section.id),
    ["123-invalid", "_underscore", "-hyphen"],
  );

  const invalidId = `name: Form
description: Description
body:
  - type: input
    id: invalid.id
    attributes:
      label: Name
`;
  assertCompilerCode(invalidId, TEMPLATE, "ISSUE_FORM_INVALID_VALUE");
});

test("native textarea rendering is preserved while browser/API-only semantics fail explicitly", () => {
  const unsupportedForms = [
    `name: Form
description: Description
assignees: [octocat]
body:
  - type: input
    id: name
    attributes:
      label: Name
`,
    `name: Form
description: Description
body:
  - type: upload
    id: files
    attributes:
      label: Files
`,
  ];
  for (const source of unsupportedForms) assertCompilerCode(source, TEMPLATE, "ISSUE_FORM_UNSUPPORTED");

  const rendered = compileIssueFormYaml(
    `name: Form
description: Description
body:
  - type: textarea
    id: logs
    attributes:
      label: Logs
      render: shell
`,
    TEMPLATE,
  );
  assert.equal(rendered.sections[0]?.fields[0]?.nativeMetadata.render, "shell");
});

test("required checkbox items promote the field while optional checkbox groups remain optional", () => {
  const source = `name: Form
description: Description
body:
  - type: checkboxes
    id: required-group
    attributes:
      label: Required group
      options:
        - label: Required item
          required: true
        - label: Optional item
          required: false
  - type: checkboxes
    id: optional-group
    attributes:
      label: Optional group
      options:
        - label: Optional item
          required: false
`;
  const contract = compileIssueFormYaml(source, TEMPLATE);
  const fields = contract.sections.map((section) => section.fields[0]);
  assert.equal(fields[0]?.required, "required");
  assert.equal(fields[1]?.required, "optional");
});

test("YAML duplicate keys and markdown-only forms are rejected", () => {
  const duplicateKey = `name: Form
name: Other
description: Description
body:
  - type: input
    id: field
    attributes:
      label: Field
`;
  assertCompilerCode(duplicateKey, TEMPLATE, "ISSUE_FORM_DUPLICATE_KEY");

  const markdownOnly = `name: Form
description: Description
body:
  - type: markdown
    attributes:
      value: Documentation only
`;
  assertCompilerCode(markdownOnly, TEMPLATE, "ISSUE_FORM_INVALID_VALUE");
});

function assertCompilerCode(source: string, template: IssueFormTemplateIdentity, expectedFragment: string): void {
  assert.throws(
    () => compileIssueFormYaml(source, template),
    (error: unknown) => error instanceof IssueFormCompilerError && error.code.includes(expectedFragment),
  );
}
