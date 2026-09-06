import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARTIFACT_CONTRACT_KINDS,
  FIELD_PRIMITIVES,
  deserializeArtifactContract,
  isArtifactContract,
  parseArtifactContract,
  serializeArtifactContract,
  validateArtifactContract,
  type FieldPrimitive,
} from "./artifact-contract.js";

const branchContract = {
  version: "1",
  kind: "branch",
  id: "branch-default",
  properties: {
    type: {
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { values: ["feat", "fix", "docs", "refactor", "test", "chore"] },
    },
    issue: { presence: "required", authority: { kind: "supplied" } },
    slug: {
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { minLength: 1, maxLength: 60, pattern: "^[a-z0-9-]+$" },
    },
    name: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "format", template: "{type}/{issue.number}-{slug}" } },
    },
    source: { presence: "required", authority: { kind: "fixed", value: "main" } },
  },
} satisfies Record<string, unknown>;

const issueContract = {
  version: "1",
  kind: "issue",
  id: "feature",
  properties: {
    title: { presence: "required", authority: { kind: "supplied" } },
    type: {
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { values: ["bug", "feature", "enhancement"] },
    },
    labels: {
      presence: "optional",
      authority: { kind: "supplied" },
      constraints: { values: ["good-first-issue", "help-wanted"] },
    },
    assignees: { presence: "optional", authority: { kind: "supplied" } },
    milestone: { presence: "unused" },
    parent: { presence: "unused" },
    dependsOn: { presence: "optional", authority: { kind: "supplied" } },
  },
  fields: [
    {
      id: "problem",
      primitive: "text",
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { minLength: 1 },
    },
    {
      id: "category",
      primitive: "choice",
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { values: ["bug", "feature", "enhancement"], maxItems: 1 },
    },
    {
      id: "acceptance",
      primitive: "checklist",
      presence: "required",
      authority: { kind: "supplied" },
      constraints: {
        items: [
          { id: "tests", label: "Tests cover the behavior", required: true },
          { id: "docs", label: "Documentation is updated", required: false },
        ],
      },
    },
  ],
} satisfies Record<string, unknown>;

const pullRequestContract = {
  version: "1",
  kind: "pull_request",
  id: "default",
  properties: {
    title: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "format", template: "{type}: {summary}" } },
    },
    head: { presence: "unused" },
    base: { presence: "required", authority: { kind: "fixed", value: "main" } },
    type: {
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { values: ["feat", "fix", "docs", "refactor", "test", "chore"] },
    },
    labels: { presence: "unused" },
    assignees: { presence: "unused" },
    milestone: { presence: "unused" },
    reviewers: { presence: "unused" },
    draft: { presence: "required", authority: { kind: "fixed", value: false } },
    maintainerCanModify: { presence: "optional", authority: { kind: "supplied" } },
    implements: { presence: "required", authority: { kind: "supplied" } },
  },
  fields: [
    {
      id: "summary",
      primitive: "text",
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { minLength: 1 },
    },
  ],
} satisfies Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function violationCodes(input: unknown): readonly string[] {
  return validateArtifactContract(input).violations.map((violation) => violation.code);
}

test("representative Branch, Issue, and Pull Request contracts are valid Canon v2 IR", () => {
  assert.deepEqual(validateArtifactContract(branchContract), { valid: true, violations: [] });
  assert.deepEqual(validateArtifactContract(issueContract), { valid: true, violations: [] });
  assert.deepEqual(validateArtifactContract(pullRequestContract), { valid: true, violations: [] });
  assert.equal(isArtifactContract(branchContract), true);
  assert.equal(isArtifactContract(issueContract), true);
  assert.equal(isArtifactContract(pullRequestContract), true);
});

test("serialization is deterministic and survives a public round trip", () => {
  const serialized = serializeArtifactContract(parseArtifactContract(branchContract));
  const roundTripped = deserializeArtifactContract(serialized);
  assert.equal(serialized, serializeArtifactContract(roundTripped));
  assert.equal(serialized, serializeArtifactContract(parseArtifactContract(branchContract)));
});

test("rejects an artifact kind outside the closed Canon v2 vocabulary", () => {
  const invalid = clone(branchContract) as Record<string, unknown>;
  invalid.kind = "milestone";
  assert.deepEqual(violationCodes(invalid), ["ARTIFACT_CONTRACT_UNSUPPORTED_KIND"]);
});

test("rejects an arbitrary top-level semantic property not fixed by #287", () => {
  const invalid = clone(issueContract) as { properties: Record<string, unknown> };
  invalid.properties.number = { presence: "required", authority: { kind: "platform" } };
  assert.ok(violationCodes(invalid).includes("ARTIFACT_CONTRACT_UNKNOWN_SEMANTIC_PROPERTY"));
});

test("rejects an arbitrary field primitive outside text/choice/checklist/attachment", () => {
  const invalid = clone(issueContract) as { fields: Array<Record<string, unknown>> };
  invalid.fields[0].primitive = "textarea";
  assert.ok(violationCodes(invalid).includes("ARTIFACT_CONTRACT_UNSUPPORTED_FIELD_PRIMITIVE"));
});

test("branch contracts cannot declare a fields extension point", () => {
  const invalid = clone(branchContract) as Record<string, unknown>;
  invalid.fields = [];
  assert.ok(violationCodes(invalid).includes("ARTIFACT_CONTRACT_UNKNOWN_PROPERTY"));
});

test("rejects an unknown authority kind", () => {
  const invalid = clone(branchContract) as { properties: { source: { authority: unknown } } };
  invalid.properties.source.authority = { kind: "computed" };
  assert.deepEqual(violationCodes(invalid), ["ARTIFACT_CONTRACT_UNKNOWN_AUTHORITY"]);
});

test("rejects a derivation that references an undeclared value", () => {
  const invalid = clone(branchContract) as { properties: { name: { authority: { derive: { template: string } } } } };
  invalid.properties.name.authority.derive.template = "{type}/{missing}-{slug}";
  assert.ok(violationCodes(invalid).includes("ARTIFACT_CONTRACT_UNDECLARED_DEPENDENCY"));
});

test("rejects a derivation cycle deterministically", () => {
  const cyclical = {
    version: "1",
    kind: "branch",
    id: "cycle",
    properties: {
      name: { presence: "required", authority: { kind: "derived", derive: { op: "format", template: "{slug}-x" } } },
      slug: { presence: "required", authority: { kind: "derived", derive: { op: "copy", from: "name" } } },
    },
  };
  const result = validateArtifactContract(cyclical);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((violation) => violation.code === "ARTIFACT_CONTRACT_DERIVATION_CYCLE"));
});

test("rejects a missing fixed value", () => {
  const invalid = clone(branchContract) as { properties: { source: { authority: Record<string, unknown> } } };
  delete invalid.properties.source.authority.value;
  assert.deepEqual(violationCodes(invalid), ["ARTIFACT_CONTRACT_MISSING_FIXED_VALUE"]);
});

test("rejects a fixed value that does not match its Core-owned shape", () => {
  const invalid = clone(pullRequestContract) as { properties: { draft: { authority: { value: unknown } } } };
  invalid.properties.draft.authority.value = "false";
  assert.deepEqual(violationCodes(invalid), ["ARTIFACT_CONTRACT_INVALID_FIXED_VALUE"]);
});

test("classification properties fail closed without a declared closed values set", () => {
  const invalid = clone(branchContract) as { properties: { type: Record<string, unknown> } };
  delete invalid.properties.type.constraints;
  assert.ok(violationCodes(invalid).includes("ARTIFACT_CONTRACT_MISSING_PROPERTY"));
});

test("fixed authority is rejected for non-text field primitives", () => {
  const invalid = clone(issueContract) as { fields: Array<Record<string, unknown>> };
  invalid.fields[1].authority = { kind: "fixed", value: "bug" };
  assert.deepEqual(violationCodes(invalid), ["ARTIFACT_CONTRACT_INVALID_FIXED_VALUE"]);
});

test("field ids cannot collide with a Core-owned property name of the same artifact kind", () => {
  const invalid = clone(issueContract) as { fields: Array<Record<string, unknown>> };
  invalid.fields.push({
    id: "title",
    primitive: "text",
    presence: "optional",
    authority: { kind: "supplied" },
  });
  assert.ok(violationCodes(invalid).includes("ARTIFACT_CONTRACT_INVALID_VALUE"));
});

test("v1 semantic-template kinds and input types remain representable in the closed Canon v2 vocabulary", () => {
  const v1Kinds = ["issue", "pull_request"] as const;
  for (const kind of v1Kinds) assert.ok((ARTIFACT_CONTRACT_KINDS as readonly string[]).includes(kind));

  // docs/SEMANTIC_ARTIFACT_CONTRACTS.md section 16 + #287: string -> text,
  // {enum,array} -> choice (single- vs multi-select becomes a constraint,
  // not a new type), checklist -> checklist.
  const v1InputTypeToFieldPrimitive: Record<string, FieldPrimitive> = {
    string: "text",
    enum: "choice",
    array: "choice",
    checklist: "checklist",
  };
  for (const primitive of Object.values(v1InputTypeToFieldPrimitive)) {
    assert.ok((FIELD_PRIMITIVES as readonly string[]).includes(primitive));
  }
});

test("parseArtifactContract returns normalized Core IR with computed shape/cardinality", () => {
  const contract = parseArtifactContract(branchContract);
  assert.equal(contract.kind, "branch");
  assert.deepEqual(contract.properties.issue, {
    presence: "required",
    shape: "issue_reference",
    cardinality: { min: 1, max: 1 },
    authority: { kind: "supplied" },
  });
  assert.equal(contract.properties.name.presence !== "unused" && contract.properties.name.authority.kind, "derived");
});
