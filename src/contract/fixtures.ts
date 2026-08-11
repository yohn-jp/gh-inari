import { CANONICAL_IR_VERSION, CONTRACT_SCHEMA_VERSION, type CanonicalContract } from "./ir.js";

/** A representative Issue Form compilation used by contract tests and examples. */
export const issueContractFixture = {
  irVersion: CANONICAL_IR_VERSION,
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  artifactKind: "issue",
  templateIdentity: {
    id: "feature",
    name: "Feature",
    path: ".github/ISSUE_TEMPLATE/feature.yml",
    source: "issue_form",
  },
  nativeMetadata: {
    source: "issue_form",
    path: ".github/ISSUE_TEMPLATE/feature.yml",
    title: "Feature",
    description: "New capability or enhancement",
    labels: ["enhancement"],
  },
  sections: [
    {
      id: "problem",
      title: "Problem",
      kind: "input",
      render: { order: 0 },
      nativeMetadata: { elementType: "textarea", sourceId: "problem" },
      fields: [
        {
          id: "problem",
          label: "Problem",
          description: "What is currently not possible, and why it matters",
          type: "string",
          required: "required",
          render: { order: 0 },
          nativeMetadata: { elementType: "textarea", sourceId: "problem" },
        },
      ],
    },
    {
      id: "category",
      title: "Category",
      kind: "input",
      render: { order: 1 },
      nativeMetadata: {
        elementType: "dropdown",
        sourceId: "category",
      },
      fields: [
        {
          id: "category",
          label: "Category",
          type: "enum",
          required: "required",
          options: [
            { value: "bug", label: "Bug" },
            { value: "feature", label: "Feature" },
            { value: "enhancement", label: "Enhancement" },
          ],
          render: { order: 0 },
          nativeMetadata: {
            elementType: "dropdown",
            sourceId: "category",
            options: [{ value: "bug" }, { value: "feature" }, { value: "enhancement" }],
          },
        },
      ],
    },
    {
      id: "affected_areas",
      title: "Affected areas",
      kind: "input",
      render: { order: 2 },
      nativeMetadata: {
        elementType: "dropdown",
        sourceId: "affected_areas",
      },
      fields: [
        {
          id: "affected_areas",
          label: "Affected areas",
          type: "array",
          selection: "multi_select",
          required: "optional",
          items: {
            type: "string",
            options: [
              { value: "cli", label: "CLI" },
              { value: "contracts", label: "Contracts" },
              { value: "docs", label: "Documentation" },
            ],
          },
          render: { order: 0 },
          nativeMetadata: {
            elementType: "dropdown",
            sourceId: "affected_areas",
            multiple: true,
            options: [{ value: "cli" }, { value: "contracts" }, { value: "docs" }],
          },
        },
      ],
    },
    {
      id: "acceptance",
      title: "Acceptance criteria",
      kind: "input",
      render: { order: 3 },
      nativeMetadata: {
        elementType: "checkboxes",
        sourceId: "acceptance",
      },
      fields: [
        {
          id: "acceptance",
          label: "Acceptance criteria",
          type: "checklist",
          required: "required",
          items: [
            { id: "tests", label: "Tests cover the behavior", required: true },
            { id: "docs", label: "Documentation is updated", required: false },
          ],
          render: { order: 0 },
          nativeMetadata: {
            elementType: "checkboxes",
            sourceId: "acceptance",
            options: [
              { value: "tests", required: true },
              { value: "docs", required: false },
            ],
          },
        },
      ],
    },
    {
      id: "guidance",
      title: "Guidance",
      kind: "documentation",
      content: "Describe the smallest useful outcome.",
      render: { order: 4 },
      nativeMetadata: {
        elementType: "markdown",
        sourceId: "guidance",
        markdown: "Describe the smallest useful outcome.",
      },
      fields: [],
    },
  ],
  supplementalConstraints: { fields: [] },
} as const satisfies CanonicalContract;

/** A representative PR template compilation with a deliberately thin policy overlay. */
export const pullRequestContractFixture = {
  irVersion: CANONICAL_IR_VERSION,
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  artifactKind: "pull_request",
  templateIdentity: {
    id: "default",
    name: "Default pull request",
    path: ".github/PULL_REQUEST_TEMPLATE.md",
    source: "pull_request_template",
  },
  nativeMetadata: {
    source: "pull_request_template",
    path: ".github/PULL_REQUEST_TEMPLATE.md",
    title: "Pull request",
  },
  sections: [
    {
      id: "summary",
      title: "Summary",
      kind: "input",
      render: { order: 0, headingLevel: 2 },
      nativeMetadata: { elementType: "heading", sourceId: "summary", headingLevel: 2 },
      fields: [
        {
          id: "summary",
          label: "Summary",
          type: "string",
          required: "unknown",
          render: { order: 0 },
          nativeMetadata: { elementType: "pr_section", sourceId: "summary" },
        },
      ],
    },
    {
      id: "linked_issue",
      title: "Linked issue",
      kind: "input",
      render: { order: 1, headingLevel: 2 },
      nativeMetadata: { elementType: "heading", sourceId: "linked_issue", headingLevel: 2 },
      fields: [
        {
          id: "linked_issue",
          label: "Linked issue",
          type: "string",
          required: "unknown",
          render: { order: 0 },
          nativeMetadata: { elementType: "pr_section", sourceId: "linked_issue" },
        },
      ],
    },
    {
      id: "acceptance",
      title: "Acceptance criteria",
      kind: "input",
      render: { order: 2, headingLevel: 2 },
      nativeMetadata: { elementType: "heading", sourceId: "acceptance", headingLevel: 2 },
      fields: [
        {
          id: "acceptance",
          label: "Acceptance criteria",
          type: "checklist",
          required: "unknown",
          items: [
            { id: "tests", label: "Tests", required: false },
            { id: "build", label: "Build", required: false },
          ],
          render: { order: 0 },
          nativeMetadata: {
            elementType: "pr_section",
            sourceId: "acceptance",
            options: [
              { value: "tests", required: false },
              { value: "build", required: false },
            ],
          },
        },
      ],
    },
    {
      id: "scope",
      title: "Scope",
      kind: "input",
      render: { order: 3, headingLevel: 2 },
      nativeMetadata: { elementType: "heading", sourceId: "scope", headingLevel: 2 },
      fields: [
        {
          id: "scope",
          label: "Scope",
          type: "string",
          required: "unknown",
          render: { order: 0 },
          nativeMetadata: { elementType: "pr_section", sourceId: "scope" },
        },
      ],
    },
  ],
  supplementalConstraints: {
    fields: [
      {
        fieldId: "linked_issue",
        required: true,
        linkedIssue: true,
      },
      {
        fieldId: "acceptance",
        required: true,
        minItems: 1,
      },
    ],
  },
} as const satisfies CanonicalContract;
