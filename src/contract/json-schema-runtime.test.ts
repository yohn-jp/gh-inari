import assert from "node:assert/strict";
import { test } from "node:test";
import { compileEffectiveArtifactContract } from "./effective-artifact-contract.js";
import { parseArtifactContract } from "./artifact-contract.js";
import { issueContractFixture } from "./fixtures.js";
import { JSON_SCHEMA_DIALECT, type ArtifactContractProvenance } from "./ir.js";
import { compileJsonSchema, JsonSchemaCompilationError, projectToJsonSchema } from "./index.js";

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

function expectCompilationFailure(schema: unknown): void {
  assert.throws(
    () => compileJsonSchema(schema),
    (error) => {
      assert.ok(error instanceof JsonSchemaCompilationError);
      assert.equal(error.message, "JSON Schema compilation failed.");
      assert.deepEqual(error.diagnostics, [{ code: "schema_invalid" }]);
      return true;
    },
  );
}

test("Draft 2020-12 runtime validates the existing generated v1 schema", () => {
  const schema = compileJsonSchema(projectToJsonSchema(issueContractFixture));
  assert.equal(
    schema.validate({
      problem: "Describe the current limitation.",
      category: "feature",
      affected_areas: ["contracts"],
      acceptance: ["tests", "docs"],
    }).valid,
    true,
  );
  assert.equal(schema.validate({ problem: "A problem", category: "unsupported", acceptance: [] }).valid, false);
  assert.equal(
    schema.validate({ problem: "A problem", category: "bug", acceptance: ["tests"], unexpected: true }).valid,
    false,
  );
});

test("Draft 2020-12 runtime validates the existing generated v2 effective input schema", () => {
  const contract = parseArtifactContract({
    version: "1",
    kind: "issue",
    id: "schema-runtime-v2",
    properties: {
      type: {
        presence: "required",
        authority: { kind: "supplied" },
        constraints: { values: ["feature", "bug"] },
      },
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
  });
  const effective = compileEffectiveArtifactContract(contract, { provenance });
  const schema = compileJsonSchema(effective.inputSchema);

  assert.equal(schema.validate({ type: "feature", summary: "A summary" }).valid, true);
  assert.equal(schema.validate({ type: "other", summary: "A summary" }).valid, false);
  assert.equal(schema.validate({ type: "bug", summary: "" }).valid, false);
  assert.equal(schema.validate({ type: "bug", summary: "A summary", derived: "caller value" }).valid, false);
});

test("schema compilation is strict and failures expose bounded Inari diagnostics", () => {
  expectCompilationFailure({ $schema: JSON_SCHEMA_DIALECT, type: "not-a-schema-type" });
  expectCompilationFailure({ $schema: "https://json-schema.org/draft/07/schema#", type: "string" });
  expectCompilationFailure({ $schema: JSON_SCHEMA_DIALECT, type: "string", inariUnknownKeyword: true });
  expectCompilationFailure({ $schema: JSON_SCHEMA_DIALECT, type: "string", nullable: true });
  expectCompilationFailure({ $schema: JSON_SCHEMA_DIALECT, type: "object", discriminator: { propertyName: "kind" } });
  expectCompilationFailure({ $schema: JSON_SCHEMA_DIALECT, $async: true, type: "string" });
});

test("references stay within the compiled schema document", () => {
  expectCompilationFailure({ $schema: JSON_SCHEMA_DIALECT, $ref: "https://example.invalid/schema.json" });
  expectCompilationFailure({ $schema: JSON_SCHEMA_DIALECT, $dynamicRef: "../schema.json#node" });
  expectCompilationFailure({
    $schema: JSON_SCHEMA_DIALECT,
    type: "object",
    properties: { nested: { $ref: "https://example.invalid/schema.json" } },
  });

  const schema = compileJsonSchema({
    $schema: JSON_SCHEMA_DIALECT,
    type: "object",
    properties: { name: { $ref: "#/$defs/nonEmptyString" } },
    required: ["name"],
    additionalProperties: false,
    $defs: { nonEmptyString: { type: "string", minLength: 1 } },
  });
  assert.equal(schema.validate({ name: "inari" }).valid, true);
  assert.equal(schema.validate({ name: "" }).valid, false);

  const annotation = compileJsonSchema({
    $schema: JSON_SCHEMA_DIALECT,
    type: "object",
    properties: { metadata: { type: "object", default: { $ref: "https://example.invalid/annotation" } } },
  });
  assert.equal(annotation.validate({ metadata: { $ref: "https://example.invalid/annotation" } }).valid, true);
});

test("validation does not coerce, inject defaults, or remove candidate properties", () => {
  const schema = compileJsonSchema({
    $schema: JSON_SCHEMA_DIALECT,
    type: "object",
    properties: {
      label: { type: "string" },
      count: { type: "integer", default: 7 },
    },
    additionalProperties: false,
  });
  const candidate = { label: 3, extra: "keep" };
  const before = structuredClone(candidate);

  const result = schema.validate(candidate);
  assert.equal(result.valid, false);
  assert.deepEqual(candidate, before);
});

test("validation diagnostics stay small and do not expose Ajv errors or candidate values", () => {
  const properties = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [`field-${index}`, { type: "string" }]),
  );
  const schema = compileJsonSchema({
    $schema: JSON_SCHEMA_DIALECT,
    type: "object",
    properties,
    additionalProperties: false,
  });
  const candidate = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field-${index}`, index]));
  const result = schema.validate(candidate);

  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.length, 16);
  assert.ok(result.diagnostics.every((diagnostic) => diagnostic.code === "value_invalid"));
  assert.ok(result.diagnostics.every((diagnostic) => !("message" in diagnostic) && !("params" in diagnostic)));
  assert.ok(result.diagnostics.every((diagnostic) => diagnostic.path === undefined || diagnostic.path.length <= 256));
});
