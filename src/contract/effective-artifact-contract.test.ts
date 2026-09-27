import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileEffectiveArtifactContract,
  EffectiveArtifactContractCompilationError,
} from "./effective-artifact-contract.js";
import {
  parseArtifactContract,
  SCHEMA_NATIVE_ARTIFACT_CONTRACT_VERSION,
  serializeArtifactContract,
} from "./artifact-contract.js";
import type { ArtifactContractProvenance } from "./ir.js";
import { compileJsonSchema } from "./json-schema-runtime.js";
import type { JsonSchema } from "./schema.js";

const provenance: ArtifactContractProvenance = {
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
  source: {
    path: ".github/inari/canon/feature.json",
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

const schemaNativeContract = {
  version: "2",
  kind: "issue",
  id: "schema-native",
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://example.test/contracts/issue.json",
    title: "Repository issue input",
    $defs: {
      tag: {
        type: "object",
        properties: { label: { type: "string", minLength: 2 } },
        required: ["label"],
        additionalProperties: false,
      },
    },
    type: "object",
    properties: {
      summary: {
        type: "object",
        properties: {
          headline: { type: "string", minLength: 3, pattern: "^[A-Z]" },
          tags: { type: "array", items: { $ref: "#/$defs/tag" }, minItems: 1, uniqueItems: true },
        },
        required: ["headline", "tags"],
        additionalProperties: false,
      },
      optional: { type: "array", items: { $ref: "#/$defs/tag" }, maxItems: 2 },
      generated: { type: "string" },
      fixed: { type: "string", const: "main" },
      platform: { type: "boolean" },
    },
    required: ["summary", "generated", "fixed", "platform"],
    additionalProperties: false,
  },
  bindings: {
    "/summary": { authority: { kind: "supplied" } },
    "/optional": { authority: { kind: "supplied" } },
    "/generated": { authority: { kind: "derived", derive: { op: "copy", from: "summary" } } },
    "/fixed": { authority: { kind: "fixed", value: "main" } },
    "/platform": { authority: { kind: "platform" } },
  },
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

test("schema-native effective input projects supplied schemas and root requiredness", () => {
  const effective = compile(schemaNativeContract);
  const validator = compileJsonSchema(effective.inputSchema);

  assert.equal(effective.inputSchema.$id, schemaNativeContract.schema.$id);
  assert.equal(effective.inputSchema.title, schemaNativeContract.schema.title);
  assert.equal(effective.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(effective.inputSchema.properties), ["optional", "summary"]);
  assert.deepEqual(effective.inputSchema.required, ["summary"]);
  assert.deepEqual(effective.inputSchema.properties.optional, schemaNativeContract.schema.properties.optional);
  assert.deepEqual(effective.inputSchema.properties.summary, schemaNativeContract.schema.properties.summary);
  assert.deepEqual(
    (effective.inputSchema as unknown as Record<string, unknown>).$defs,
    schemaNativeContract.schema.$defs,
  );

  assert.equal(validator.validate({ summary: { headline: "A title", tags: [{ label: "core" }] } }).valid, true);
  assert.equal(
    validator.validate({
      summary: { headline: "A title", tags: [{ label: "core" }] },
      optional: [{ label: "test" }],
    }).valid,
    true,
  );
  assert.equal(
    validator.validate({ summary: { headline: "A title", tags: [{ label: "core" }] }, generated: "caller" }).valid,
    false,
  );
  assert.equal(validator.validate({ summary: { headline: "abC", tags: [{ label: "core" }] } }).valid, false);
  assert.equal(validator.validate({ summary: { headline: "A title", tags: [] } }).valid, false);
  assert.equal(validator.validate({ summary: { headline: "A title", tags: [{ label: "x" }] } }).valid, false);
  assert.equal(
    validator.validate({ summary: { headline: "A title", tags: [{ label: "core", extra: true }] } }).valid,
    false,
  );
  assert.equal(
    validator.validate({ summary: { headline: "A title", tags: [{ label: "core" }] }, fixed: "main" }).valid,
    false,
  );
  assert.equal(
    validator.validate({ summary: { headline: "A title", tags: [{ label: "core" }] }, platform: true }).valid,
    false,
  );
});

test("schema-native projection rejects root cross-property constraints and unresolved local references", () => {
  const dependentContract = parseArtifactContract({
    version: SCHEMA_NATIVE_ARTIFACT_CONTRACT_VERSION,
    kind: "issue",
    id: "dependent-properties",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { summary: { type: "string" }, generated: { type: "string" } },
      required: ["summary", "generated"],
      dependentRequired: { summary: ["generated"] },
      additionalProperties: false,
    },
    bindings: {
      "/summary": { authority: { kind: "supplied" } },
      "/generated": { authority: { kind: "derived", derive: { op: "copy", from: "summary" } } },
    },
  });
  assert.throws(
    () => compileEffectiveArtifactContract(dependentContract, { provenance }),
    (error) =>
      error instanceof EffectiveArtifactContractCompilationError &&
      error.message === "Schema-native root constraints cannot be projected equivalently to supplied caller input.",
  );

  const patternedContract = parseArtifactContract({
    version: SCHEMA_NATIVE_ARTIFACT_CONTRACT_VERSION,
    kind: "issue",
    id: "patterned-properties",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { summary: { type: "string" } },
      patternProperties: { "^x-": { type: "string" } },
      additionalProperties: false,
    },
    bindings: { "/summary": { authority: { kind: "supplied" } } },
  });
  assert.throws(
    () => compileEffectiveArtifactContract(patternedContract, { provenance }),
    (error) =>
      error instanceof EffectiveArtifactContractCompilationError &&
      error.message === "Schema-native root patternProperties cannot be projected into closed caller input.",
  );

  const referencedContract = parseArtifactContract({
    version: SCHEMA_NATIVE_ARTIFACT_CONTRACT_VERSION,
    kind: "issue",
    id: "sibling-schema-reference",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        summary: { $ref: "#/properties/generated" },
        generated: { type: "string" },
      },
      required: ["summary", "generated"],
      additionalProperties: false,
    },
    bindings: {
      "/summary": { authority: { kind: "supplied" } },
      "/generated": { authority: { kind: "derived", derive: { op: "copy", from: "summary" } } },
    },
  });
  assert.throws(
    () => compileEffectiveArtifactContract(referencedContract, { provenance }),
    (error) =>
      error instanceof EffectiveArtifactContractCompilationError &&
      error.message ===
        "Schema-native caller schema contains references that cannot be resolved after supplied-only projection.",
  );
});

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

test("a Canon v2 source compiles without constructing native-template provenance", () => {
  const canonOnlyProvenance: ArtifactContractProvenance = {
    authority: "repository-default-branch",
    repository: {
      host: "github.com",
      owner: "yohn-jp",
      name: "gh-inari",
      nameWithOwner: "yohn-jp/gh-inari",
    },
    ref: "main",
    treeSha: "tree-sha-1",
    source: {
      path: ".github/inari/canon/derived-branch.json",
      ref: "main",
      sha: "blob-sha-1",
      digest: "digest-1",
    },
  };
  assert.equal(Object.hasOwn(canonOnlyProvenance, "template"), false);

  const contract = parseArtifactContract(derivedBranch);
  const effective = compileEffectiveArtifactContract(contract, { provenance: canonOnlyProvenance });
  assert.equal(effective.generation.source.digest, "digest-1");
  assert.equal(Object.hasOwn(effective.generation, "template"), false);
});

test("changing the Canon source digest or tree generation changes effective generation identity", () => {
  const base = compile(derivedBranch);

  const changedTree = compile(derivedBranch, { treeSha: "tree-sha-2" });
  assert.notEqual(changedTree.generation.treeSha, base.generation.treeSha);
  assert.notDeepEqual(changedTree.generation, base.generation);

  const contract = parseArtifactContract(derivedBranch);
  const changedSource = compileEffectiveArtifactContract(contract, {
    provenance: { ...provenance, source: { ...provenance.source, digest: "digest-2" } },
  });
  assert.notEqual(changedSource.generation.source.digest, base.generation.source.digest);
  assert.notDeepEqual(changedSource.generation, base.generation);
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
