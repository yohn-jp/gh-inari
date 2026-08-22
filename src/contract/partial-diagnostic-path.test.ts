import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePartialSemanticInput } from "./validation.js";
import { issueContractFixture } from "./fixtures.js";

test("partial diagnostics preserve the field id for invalid array items", () => {
  const result = validatePartialSemanticInput(issueContractFixture, {
    problem: "A useful problem statement",
    category: "feature",
    acceptance: ["not-declared"],
  });

  assert.equal(result.valid, false);
  assert.equal(
    result.diagnostics.diagnostics.some((diagnostic) => diagnostic.path === "$.fields.acceptance[0]"),
    true,
  );
});
