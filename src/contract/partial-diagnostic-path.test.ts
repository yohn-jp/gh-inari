import assert from "node:assert/strict";
import { test } from "node:test";
import { issueContractFixture } from "./fixtures.js";
import { validatePartialSemanticInput } from "./validation.js";

test("partial diagnostics preserve the field id for invalid array items", () => {
  const result = validatePartialSemanticInput(issueContractFixture, {
    problem: "A useful problem statement",
    category: "feature",
    affected_areas: ["not-declared"],
    acceptance: ["tests"],
  });

  assert.equal(result.valid, false);
  assert.equal(
    result.diagnostics.diagnostics.some((diagnostic) => diagnostic.path === "$.fields.affected_areas[0]"),
    true,
  );
});
