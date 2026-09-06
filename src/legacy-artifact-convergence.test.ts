import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalContract } from "./contract/ir.js";
import {
  artifactContractFromLegacyCanonical,
  compileLegacyEffectiveArtifactContract,
  convergeLegacyArtifactInput,
  tryMaterializeLegacyArtifact,
  validateLegacyBranchProjection,
} from "./legacy-artifact-convergence.js";

const provenance = {
  authority: "repository-default-branch" as const,
  repository: { host: "github.com", owner: "acme", name: "repo", nameWithOwner: "acme/repo" },
  ref: "main",
  treeSha: "a".repeat(40),
  template: {
    path: ".github/ISSUE_TEMPLATE/legacy.yml",
    ref: "main",
    sha: "b".repeat(40),
    digest: "c".repeat(64),
  },
};

const issueContract = {
  irVersion: "1.0.0",
  schemaVersion: "1.0.0",
  artifactKind: "issue",
  templateIdentity: {
    id: "legacy",
    name: "Legacy",
    path: ".github/ISSUE_TEMPLATE/legacy.yml",
    source: "issue_form",
  },
  nativeMetadata: { source: "issue_form", path: ".github/ISSUE_TEMPLATE/legacy.yml", title: "Legacy" },
  sections: [
    {
      id: "category",
      title: "Category",
      kind: "input",
      render: { order: 0 },
      nativeMetadata: { elementType: "dropdown" },
      fields: [
        {
          id: "category",
          label: "Category",
          type: "enum",
          required: "required",
          options: [{ value: "feature", label: "Feature" }],
          render: { order: 0 },
          nativeMetadata: { elementType: "dropdown" },
        },
      ],
    },
  ],
  supplementalConstraints: { fields: [] },
  provenance,
} satisfies CanonicalContract;

const prContract = {
  ...issueContract,
  artifactKind: "pull_request" as const,
  templateIdentity: {
    id: "legacy-pr",
    name: "Legacy PR",
    path: ".github/PULL_REQUEST_TEMPLATE.md",
    source: "pull_request_template" as const,
  },
  nativeMetadata: { source: "pull_request_template" as const, path: ".github/PULL_REQUEST_TEMPLATE.md" },
  sections: [
    {
      id: "summary",
      title: "Summary",
      kind: "input" as const,
      render: { order: 0 },
      nativeMetadata: { elementType: "heading" as const },
      fields: [
        {
          id: "summary",
          label: "Summary",
          type: "string" as const,
          required: "required" as const,
          render: { order: 0 },
          nativeMetadata: { elementType: "pr_section" as const },
        },
      ],
    },
    {
      id: "linked_issue",
      title: "Linked issue",
      kind: "input" as const,
      render: { order: 1 },
      nativeMetadata: { elementType: "heading" as const },
      fields: [
        {
          id: "linked_issue",
          label: "Linked issue",
          type: "string" as const,
          required: "required" as const,
          render: { order: 0 },
          nativeMetadata: { elementType: "pr_section" as const },
        },
      ],
    },
  ],
  supplementalConstraints: { fields: [{ fieldId: "linked_issue", linkedIssue: true }] },
} satisfies CanonicalContract;

const reference = {
  repositoryHost: "github.com",
  repositoryId: "42",
  repository: "acme/repo",
  number: 7,
};

test("legacy Issue candidate maps metadata and dependency sidecar into Core input", () => {
  const effective = compileLegacyEffectiveArtifactContract(issueContract);
  const result = convergeLegacyArtifactInput(effective, {
    fields: { category: "feature" },
    metadata: { title: "Feature title" },
    source: "json",
    dependencies: { blockedBy: [reference], blocks: [{ ...reference, number: 8 }] },
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.semanticInput, { category: ["feature"], dependsOn: [reference], title: "Feature title" });
  assert.deepEqual(result.compatibility?.dependencies, {
    blockedBy: [reference],
    blocks: [{ ...reference, number: 8 }],
  });
  assert.deepEqual(result.diagnostics, []);
});

test("sidecar dependency evidence cannot override a semantic dependsOn value", () => {
  const effective = compileLegacyEffectiveArtifactContract(issueContract);
  const result = convergeLegacyArtifactInput(effective, {
    fields: { category: "feature", dependsOn: [reference] },
    metadata: { title: "Feature title" },
    source: "fields",
    dependencies: {
      blockedBy: [{ ...reference, number: 8 }],
      blocks: [],
    },
  });

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.diagnostics.map((entry) => entry.code),
    ["LEGACY_SEMANTIC_CONFLICT"],
  );
  assert.equal(result.semanticInput, undefined);
});

test("linkedIssue is converted only from a complete explicit reference", () => {
  const effective = compileLegacyEffectiveArtifactContract(prContract);
  const valid = convergeLegacyArtifactInput(
    effective,
    {
      fields: { summary: "A change", linked_issue: "Closes #7" },
      metadata: { title: "Change", head: "feat/7-change", base: "main" },
      source: "existing",
    },
    { linkedIssueRepository: { repositoryHost: "github.com", repositoryId: "42", repository: "acme/repo" } },
  );
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.semanticInput?.implements, [reference]);
  assert.equal(Object.hasOwn(valid.semanticInput ?? {}, "linked_issue"), false);

  const prose = convergeLegacyArtifactInput(effective, {
    fields: { summary: "A change", linked_issue: "This closes #7 after the migration" },
    metadata: { title: "Change", head: "feat/7-change", base: "main" },
    source: "existing",
  });
  assert.equal(prose.valid, false);
  assert.deepEqual(
    prose.diagnostics.map((entry) => entry.code),
    ["LEGACY_LINKED_ISSUE_INVALID"],
  );
});

test("legacy materialization is Core-owned after the compatibility ingress", () => {
  const result = tryMaterializeLegacyArtifact(issueContract, {
    fields: { category: "feature" },
    metadata: { title: "Feature title" },
    source: "json",
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.artifact?.fields, { category: ["feature"] });
  assert.equal(result.artifact?.values.title, "Feature title");
});

test("legacy branch compatibility validates but never derives a branch name", () => {
  assert.equal(validateLegacyBranchProjection("feat/7-change").valid, true);
  assert.equal(validateLegacyBranchProjection("feature work").valid, false);
});

test("legacy contract conversion remains bounded for unsupported free-form arrays", () => {
  const unsupported = {
    ...issueContract,
    sections: [
      {
        ...issueContract.sections[0],
        fields: [
          {
            id: "areas",
            label: "Areas",
            type: "array" as const,
            required: "required" as const,
            selection: "list" as const,
            items: { type: "string" as const },
            render: { order: 0 },
            nativeMetadata: { elementType: "dropdown" as const },
          },
        ],
      },
    ],
  } satisfies CanonicalContract;
  const result = tryMaterializeLegacyArtifact(unsupported, {
    fields: { areas: ["cli"] },
    metadata: { title: "Feature title" },
    source: "json",
  });
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.diagnostics.map((entry) => entry.code),
    ["LEGACY_CONTRACT_UNSUPPORTED"],
  );
});
