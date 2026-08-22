import assert from "node:assert/strict";
import { test } from "node:test";
import { repairPartialArtifactInput, validatePartialArtifactInput } from "../artifact.js";
import { issueContractFixture } from "./fixtures.js";

test("repair can explicitly replace a previously accepted field with another valid value", () => {
  const partial = validatePartialArtifactInput(issueContractFixture, {
    fields: {
      problem: "A useful problem",
      category: "feature",
      acceptance: ["tests"],
    },
  });

  const repaired = repairPartialArtifactInput(issueContractFixture, partial, {
    identity: partial.identity,
    fields: { category: "bug" },
  });

  assert.equal(repaired.valid, true);
  assert.equal(repaired.complete, true);
  assert.deepEqual(repaired.changedFields, ["category"]);
  assert.deepEqual(repaired.values, {
    problem: "A useful problem",
    category: "bug",
    acceptance: ["tests"],
  });
});
