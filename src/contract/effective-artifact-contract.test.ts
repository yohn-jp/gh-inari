import assert from "node:assert/strict";
import { test } from "node:test";
import { compileEffectiveArtifactContract } from "./effective-artifact-contract.js";
import { parseArtifactContract, serializeArtifactContract } from "./artifact-contract.js";
import type { ContractProvenance } from "./ir.js";
import type { JsonSchema } from "./schema.js";

const provenance: ContractProvenance = {
  authority: "repository-default-branch",
  repository: {
    host: "github.com",
    owner: "yohn-jp",
    name: "gh-inari",
    nameWithOwner: "yohn-jp/gh-inari",
    repositoryId: "1234",
  },
  ref: "main",
  treeSha: "tree-sha-1",
  template: {
    path: ".github/inari/feature.json",
    ref: "main",
    sha: "blob-sha-1",
    digest: "digest-1",
  },
};

const derivedBranch = {
  version: "1",
  kind: "branch",
  id: "derived-branch",
  properties: {
    type: {
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { values: ["feat", "fix"] },
    },
    issue: { presence: "required", authority: { kind: "supplied" } },
    slug: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "slug", from: "type" } },
    },
    name: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "format", template: "{slug}/{issue.number}" } },
    },
    source: { presence: "required", authority: { kind: "fixed", value: "main" } },
  },
} satisfies Record<string, unknown>;

const suppliedBranch = {
  version: "1",
  kind: "branch",
  id: "supplied-branch",
  properties: {
    name: {
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { minLength: 1 },
    },
    source: { presence: "required", authority: { kind: "fixed", value: "main" } },
  },
} satisfies Record<string, unknown>;

const authorityContract = {
  version: "1",
  kind: "issue",
  id: "authority-test",
  properties: {
    type: {
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { values: ["feature", "bug"] },
    },
    title: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "format", template: "{type}" } },
    },
    labels: { presence: "optional", authority: { kind: "platform" } },
    assignees: {
      presence: "optional",
      authority: { kind: "fixed", value: ["sophia"] },
    },
    parent: { presence: "unused" },
  },
  fields: [
    {
      id: "summary",
      primitive: "text",
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { minLength: 1 },
    },
    {
      id: "optional-note",
      primitive: "text",
      presence: "optional",
      authority: { kind: "supplied" },
    },
    {
      id: "derived-summary",
      primitive: "text",
      presence: "optional",
      authority: { kind: "derived", derive: { op: "copy", from: "summary" } },
    },
    {
      id: "fixed-note",
      primitive: "text",
      presence: "optional",
      authority: { kind: "fixed", value: "fixed" },
    },
    {
      id: "platform-note",
      primitive: "text",
      presence: "optional",
      authority: { kind: "platform" },
    },
    { id: "unused-note", primitive: "text", presence: "unused" },
  ],
} satisfies Record<string, unknown>;

function compile(input: Record<string, unknown>, options?: { readonly treeSha?: string }) {
  const contract = parseArtifactContract(input);
  return compileEffectiveArtifactContract(contract, {
    provenance: { ...provenance, ...(options?.treeSha === undefined ? {} : { treeSha: options.treeSha }) },
    capabilities: ["projection:test", "projection:test", "core:test"],
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaAccepts(schema: JsonSchema, value: unknown): boolean {
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.type === "object") {
    if (!isRecord(value)) return false;
    if (
      schema.additionalProperties === false &&
      Object.keys(value).some((key) => !(key in (schema.properties ?? {})))
    ) {
      return false;
    }
    if ((schema.required ?? []).some((key) => !Object.hasOwn(value, key))) return false;
    if (
      Object.entries(value).some(([key, entry]) => {
        const property = schema.properties?.[key];
        return property !== undefined && !schemaAccepts(property, entry);
      })
    ) {
      return false;
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") return false;
    if (schema.enum !== undefined && !schema.enum.includes(value)) return false;
    if (schema.minLength !== undefined && Array.from(value).length < schema.minLength) return false;
    if (schema.maxLength !== undefined && Array.from(value).length > schema.maxLength) return false;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) return false;
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") return false;
  } else if (schema.type === "integer") {
    if (!Number.isSafeInteger(value)) return false;
    if (schema.minimum !== undefined && (value as number) < schema.minimum) return false;
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    if (schema.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) return false;
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items !== undefined && value.some((entry) => !schemaAccepts(schema.items as JsonSchema, entry))) {
      return false;
    }
  }
  return (schema.allOf ?? []).every((rule) => {
    if (rule.contains !== undefined && Array.isArray(value)) {
      return (
        value.filter((entry) => schemaAccepts(rule.contains as JsonSchema, entry)).length >= (rule.minContains ?? 1)
      );
    }
    return schemaAccepts(rule, value);
  });
}

test("required and optional supplied values compile into a closed exact input schema", () => {
  const effective = compile(authorityContract);
  assert.equal(effective.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(effective.inputSchema.properties), ["optional-note", "summary", "type"]);
  assert.deepEqual(effective.inputSchema.required, ["summary", "type"]);
  assert.equal(schemaAccepts(effective.inputSchema, { type: "feature", summary: "A summary" }), true);
  assert.equal(
    schemaAccepts(effective.inputSchema, { type: "feature", summary: "A summary", "optional-note": "note" }),
    true,
  );
  assert.equal(schemaAccepts(effective.inputSchema, { type: "feature" }), false);
  assert.equal(schemaAccepts(effective.inputSchema, { type: "other", summary: "A summary" }), false);
});

test("derived, fixed, platform, and unused declarations are excluded from caller input", () => {
  const effective = compile(authorityContract);
  for (const excluded of [
    "title",
    "labels",
    "assignees",
    "parent",
    "derived-summary",
    "fixed-note",
    "platform-note",
    "unused-note",
  ]) {
    assert.equal(Object.hasOwn(effective.inputSchema.properties, excluded), false, excluded);
  }
  assert.equal(
    schemaAccepts(effective.inputSchema, {
      type: "feature",
      summary: "A summary",
      title: "feature",
      "fixed-note": "override",
      "platform-note": "override",
    }),
    false,
  );
  const labels = effective.properties.labels;
  const title = effective.properties.title;
  const fixedNote = effective.fields?.find((field) => field.id === "fixed-note");
  assert.equal(labels?.presence === "unused" ? undefined : labels?.authority.kind, "platform");
  assert.equal(title?.presence === "unused" ? undefined : title?.authority.kind, "derived");
  assert.equal(fixedNote?.presence === "unused" ? undefined : fixedNote?.authority.kind, "fixed");
});

test("derived branch identity and caller-supplied branch identity have distinct input contracts", () => {
  const derived = compile(derivedBranch);
  assert.deepEqual(Object.keys(derived.inputSchema.properties), ["issue", "type"]);
  assert.equal(Object.hasOwn(derived.inputSchema.properties, "name"), false);
  assert.equal(Object.hasOwn(derived.inputSchema.properties, "source"), false);

  const supplied = compile(suppliedBranch);
  assert.deepEqual(Object.keys(supplied.inputSchema.properties), ["name"]);
  assert.deepEqual(supplied.inputSchema.required, ["name"]);
  assert.equal(Object.hasOwn(supplied.inputSchema.properties, "issue"), false);
});

test("derivation dependencies are parsed once and expose deterministic evaluation metadata", () => {
  const effective = compile(derivedBranch);
  assert.deepEqual(effective.evaluationOrder, ["slug", "name"]);
  assert.deepEqual(effective.dependencyGraph.name, [{ name: "slug" }, { name: "issue", member: "number" }]);
  const name = effective.derivations.find((derivation) => derivation.target === "name");
  assert.deepEqual(name?.formatParts, [
    { kind: "reference", reference: { name: "slug" } },
    { kind: "literal", value: "/" },
    { kind: "reference", reference: { name: "issue", member: "number" } },
  ]);
  assert.deepEqual(effective.derivations.find((derivation) => derivation.target === "slug")?.dependencies, [
    { name: "type" },
  ]);
});

test("provenance/generation is immutable and stable for a fixed contract, capability set, and generation", () => {
  const first = compile(derivedBranch);
  const second = compile(derivedBranch);
  assert.deepEqual(first, second);
  assert.equal(first.generation, first.provenance);
  assert.equal(first.generation.treeSha, "tree-sha-1");
  assert.deepEqual(first.capabilities, ["core:test", "projection:test"]);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.provenance), true);
  assert.equal(Object.isFrozen(first.inputSchema), true);

  const changedGeneration = compile(derivedBranch, { treeSha: "tree-sha-2" });
  assert.notDeepEqual(first.generation, changedGeneration.generation);
});

test("compiled output is structurally stable regardless of authored property insertion order", () => {
  const reversed = {
    ...derivedBranch,
    properties: Object.fromEntries(Object.entries(derivedBranch.properties).reverse()),
  };
  assert.equal(JSON.stringify(compile(derivedBranch)), JSON.stringify(compile(reversed)));
});

test("unknown input remains fail-closed at the effective schema boundary", () => {
  const effective = compile(derivedBranch);
  const issue = {
    repositoryHost: "github.com",
    repositoryId: "1234",
    number: 282,
  };
  assert.equal(schemaAccepts(effective.inputSchema, { type: "feat", issue }), true);
  assert.equal(schemaAccepts(effective.inputSchema, { type: "feat", issue, name: "override" }), false);
  assert.equal(schemaAccepts(effective.inputSchema, { type: "feat", issue, unknown: "value" }), false);
});

test("Artifact Contract IR retains parsed format parts while authoring serialization stays minimal", () => {
  const contract = parseArtifactContract(derivedBranch);
  assert.equal(contract.derivations.length, 2);
  assert.equal(JSON.stringify(contract).includes("formatParts"), true);
  assert.equal(JSON.stringify(contract.derivations).includes("formatParts"), true);
  assert.equal(serializeArtifactContract(contract).includes("formatParts"), false);
});
