import assert from "node:assert/strict";
import { test } from "node:test";
import { LINKED_ISSUE_PATTERN, projectContract, projectToJsonSchema, serializeJsonSchema } from "./index.js";
import { issueContractFixture, pullRequestContractFixture } from "./fixtures.js";

test("Issue projection is stable and uses standard JSON Schema", () => {
  const first = projectToJsonSchema(issueContractFixture);
  const second = projectToJsonSchema(issueContractFixture);
  assert.equal(serializeJsonSchema(first), serializeJsonSchema(second));
  assert.equal(first.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(first.type, "object");
  assert.equal(first.additionalProperties, false);
  assert.deepEqual(Object.keys(first.properties), ["problem", "category", "affected_areas", "acceptance"]);
  assert.deepEqual(first.properties.category?.enum, ["bug", "feature", "enhancement"]);
  assert.deepEqual(first.properties.affected_areas?.items?.enum, ["cli", "contracts", "docs"]);
  assert.equal(first.properties.affected_areas?.uniqueItems, true);
  assert.deepEqual(first.required, ["problem", "category", "acceptance"]);
});

test("checklist projection expresses required items with JSON Schema contains", () => {
  const schema = projectToJsonSchema(issueContractFixture);
  const acceptance = schema.properties.acceptance;
  assert.equal(acceptance?.type, "array");
  assert.deepEqual(acceptance?.items?.enum, ["tests", "docs"]);
  assert.equal(acceptance?.uniqueItems, true);
  assert.deepEqual(acceptance?.allOf, [{ contains: { const: "tests" }, minContains: 1 }]);
});

test("PR projection keeps unknown native required semantics but applies thin supplemental policy", () => {
  const schema = projectToJsonSchema(pullRequestContractFixture);
  assert.deepEqual(schema.required, ["linked_issue", "acceptance"]);
  assert.equal(schema.required?.includes("summary"), false);
  assert.ok(schema.properties.summary !== undefined);
  assert.equal(schema.properties.linked_issue?.pattern, LINKED_ISSUE_PATTERN);
  assert.equal(schema.properties.acceptance?.minItems, 1);
});

test("rendering order and native metadata are projected separately from semantic JSON Schema", () => {
  const projection = projectContract(issueContractFixture);
  assert.deepEqual(
    projection.rendering.sections.map((section) => section.id),
    ["problem", "category", "affected_areas", "acceptance", "guidance"],
  );
  assert.equal(projection.rendering.sections[0]?.nativeMetadata.elementType, "textarea");
  assert.equal("nativeMetadata" in projection.schema, false);
  assert.equal("sections" in projection.schema, false);
  assert.equal("render" in (projection.schema.properties.problem ?? {}), false);
});

test("required create title metadata is projected separately from semantic fields", () => {
  for (const contract of [issueContractFixture, pullRequestContractFixture]) {
    const projection = projectContract(contract);
    assert.deepEqual(projection.metadata.required, ["title"]);
    assert.deepEqual(Object.keys(projection.metadata.properties), ["title"]);
    assert.equal(projection.metadata.properties.title?.type, "string");
    assert.equal(projection.metadata.properties.title?.pattern, "\\S");
    assert.equal("title" in projection.schema.properties, false);
  }
});
