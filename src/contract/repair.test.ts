import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergePartialArtifactInput,
  repairPartialArtifactInput,
  renderIssueArtifact,
  validatePartialArtifactInput,
} from "../artifact.js";
import { issueContractFixture } from "./fixtures.js";

const accepted = {
  fields: {
    problem: "A useful problem statement",
    category: "feature",
  },
};

test("repairs one missing field using only the targeted patch and renders one-pass equivalently", () => {
  const partial = validatePartialArtifactInput(issueContractFixture, accepted);
  const repaired = repairPartialArtifactInput(issueContractFixture, partial, {
    identity: partial.identity,
    fields: { acceptance: ["tests"] },
  });

  assert.equal(repaired.valid, true);
  assert.equal(repaired.complete, true);
  assert.deepEqual(repaired.values, {
    problem: accepted.fields.problem,
    category: accepted.fields.category,
    acceptance: ["tests"],
  });
  assert.deepEqual(repaired.changedFields, ["acceptance"]);
  assert.equal(
    renderIssueArtifact(issueContractFixture, repaired.values),
    renderIssueArtifact(issueContractFixture, {
      problem: accepted.fields.problem,
      category: accepted.fields.category,
      acceptance: ["tests"],
    }),
  );
});

test("repeated repairs use returned context and preserve accepted fields", () => {
  const partial = validatePartialArtifactInput(issueContractFixture, { fields: { problem: "A useful problem" } });
  const first = mergePartialArtifactInput(issueContractFixture, partial, {
    identity: partial.identity,
    fields: { category: "feature" },
  });
  const second = mergePartialArtifactInput(issueContractFixture, first.context, {
    identity: first.identity,
    fields: { acceptance: ["tests"] },
  });

  assert.equal(second.valid, true);
  assert.deepEqual(second.values, {
    problem: "A useful problem",
    category: "feature",
    acceptance: ["tests"],
  });
  assert.deepEqual(second.acceptedFields, ["$.fields.acceptance", "$.fields.category", "$.fields.problem"]);
});

test("request envelope can carry accepted values and its own patch", () => {
  const partial = validatePartialArtifactInput(issueContractFixture, accepted);
  const repaired = repairPartialArtifactInput(issueContractFixture, {
    identity: partial.identity,
    acceptedValues: partial.values,
    patch: { fields: { acceptance: ["tests"] } },
  });

  assert.equal(repaired.valid, true);
  assert.deepEqual(repaired.values.acceptance, ["tests"]);
});

test("a no-op repair leaves accepted state unchanged", () => {
  const partial = validatePartialArtifactInput(issueContractFixture, accepted);
  const repaired = repairPartialArtifactInput(issueContractFixture, partial, {
    identity: partial.identity,
    fields: {},
  });

  assert.equal(repaired.noOp, true);
  assert.deepEqual(repaired.changedFields, []);
  assert.deepEqual(repaired.values, partial.values);
  assert.deepEqual(repaired.context.values, partial.values);
});

test("an invalid replacement does not erase its previously accepted value", () => {
  const partial = validatePartialArtifactInput(issueContractFixture, {
    fields: { problem: "A useful problem", category: "feature", acceptance: ["tests"] },
  });
  const repaired = repairPartialArtifactInput(issueContractFixture, partial, {
    identity: partial.identity,
    fields: { category: "not-declared" },
  });

  assert.equal(repaired.valid, false);
  assert.deepEqual(repaired.values, partial.values);
  assert.deepEqual(
    repaired.invalidFields.map((field) => field.field),
    ["category"],
  );
  assert.equal(repaired.diagnostics.diagnostics.length <= 32, true);
});

test("stale identity is rejected with bounded diagnostics", () => {
  const partial = validatePartialArtifactInput(issueContractFixture, accepted);
  const stale = {
    ...partial.identity,
    templateIdentity: { ...partial.identity.templateIdentity, path: ".github/ISSUE_TEMPLATE/other.yml" },
  };
  const repaired = repairPartialArtifactInput(issueContractFixture, partial, {
    identity: stale,
    fields: { acceptance: ["tests"] },
  });

  assert.equal(repaired.valid, false);
  assert.equal(repaired.diagnostics.diagnostics.length <= 32, true);
  assert.equal(
    repaired.diagnostics.diagnostics.some((diagnostic) => diagnostic.path === "repair.identity"),
    true,
  );
  assert.deepEqual(repaired.values, partial.values);
});

test("final invalidity remains explicit when a repair patch is unknown", () => {
  const partial = validatePartialArtifactInput(issueContractFixture, accepted);
  const repaired = repairPartialArtifactInput(issueContractFixture, partial, {
    identity: partial.identity,
    fields: { unknown: "value" },
  });

  assert.equal(repaired.valid, false);
  assert.deepEqual(
    repaired.invalidFields.map((field) => field.field),
    ["unknown"],
  );
  assert.deepEqual(repaired.values, partial.values);
});
