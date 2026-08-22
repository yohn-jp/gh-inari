import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPartialArtifactInput } from "../artifact.js";
import { serializePartialSemanticValidationResult, validatePartialSemanticInput } from "./validation.js";
import type { CanonicalContract } from "./ir.js";
import { issueContractFixture, pullRequestContractFixture } from "./fixtures.js";

test("partial validation preserves accepted fields when one required field is missing", () => {
  const result = validatePartialSemanticInput(issueContractFixture, {
    problem: "A useful problem statement",
    category: "feature",
  });

  assert.equal(result.valid, false);
  assert.equal(result.complete, false);
  assert.deepEqual(result.acceptedFields, ["$.fields.category", "$.fields.problem"]);
  assert.deepEqual(
    result.missingFields.map((field) => field.field),
    ["acceptance"],
  );
  assert.deepEqual(result.invalidFields, []);
  assert.deepEqual(result.values, {
    problem: "A useful problem statement",
    category: "feature",
  });
  assert.deepEqual(
    result.diagnostics.diagnostics.map((diagnostic) => diagnostic.detailCode),
    ["FIELD_REQUIRED"],
  );
  assert.deepEqual(
    result.projectedConstraints.map((constraint) => constraint.field),
    ["acceptance"],
  );
  assert.equal(result.projectedConstraints[0]?.required, true);
});

test("partial validation classifies one invalid field without rejecting unrelated valid fields", () => {
  const result = validatePartialSemanticInput(issueContractFixture, {
    problem: "A useful problem statement",
    category: "not-declared",
    acceptance: ["tests"],
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.acceptedFields, ["$.fields.acceptance", "$.fields.problem"]);
  assert.deepEqual(result.missingFields, []);
  assert.deepEqual(
    result.invalidFields.map((field) => field.field),
    ["category"],
  );
  assert.equal(result.invalidFields[0]?.reason, "constraint");
  assert.equal(result.invalidFields[0]?.constraints?.allowedValues?.includes("feature"), true);
  assert.equal(result.diagnostics.diagnostics[0]?.detailCode, "FIELD_CONSTRAINT_VIOLATION");
  assert.equal(JSON.stringify(result.diagnostics).includes("not-declared"), false);
});

test("multiple missing and invalid fields remain independent and deterministic", () => {
  const first = validatePartialSemanticInput(issueContractFixture, {
    category: "unknown",
    acceptance: ["unknown"],
  });
  const second = validatePartialSemanticInput(issueContractFixture, {
    acceptance: ["unknown"],
    category: "unknown",
  });

  assert.equal(first.valid, false);
  assert.deepEqual(
    first.missingFields.map((field) => field.field),
    ["problem"],
  );
  assert.deepEqual(
    first.invalidFields.map((field) => field.field),
    ["acceptance", "category"],
  );
  assert.deepEqual(
    first.projectedConstraints.map((constraint) => constraint.field),
    ["acceptance", "category", "problem"],
  );
  assert.equal(serializePartialSemanticValidationResult(first), serializePartialSemanticValidationResult(second));
});

test("partial validation does not materialize defaults and projects supplemental constraints only when unresolved", () => {
  const contract = withSummaryOptions(pullRequestContractFixture, {
    defaultValue: "default summary",
    supplemental: { required: true, minLength: 8, pattern: "^Fix", linkedIssue: true },
  });
  const missing = validatePartialSemanticInput(contract, {});

  assert.equal(missing.valid, false);
  assert.deepEqual(missing.values, {});
  assert.deepEqual(
    missing.missingFields.map((field) => field.field),
    ["summary"],
  );
  assert.equal(missing.projectedConstraints[0]?.minLength, 8);
  assert.equal(missing.projectedConstraints[0]?.pattern, "^Fix");
  assert.equal(missing.projectedConstraints[0]?.linkedIssue, true);

  const accepted = validatePartialSemanticInput(contract, { summary: "Fix this Closes #1" });
  assert.equal(accepted.valid, true);
  assert.equal(accepted.complete, false);
  assert.deepEqual(accepted.acceptedFields, ["$.fields.summary"]);
  assert.deepEqual(accepted.projectedConstraints, []);
  assert.deepEqual(accepted.values, { summary: "Fix this Closes #1" });
});

test("complete valid partial input is all-accepted in one pass", () => {
  const result = validatePartialSemanticInput(issueContractFixture, {
    problem: "A useful problem statement",
    category: "feature",
    affected_areas: ["contracts"],
    acceptance: ["tests", "docs"],
  });

  assert.equal(result.valid, true);
  assert.equal(result.complete, true);
  assert.equal(result.missingFields.length, 0);
  assert.equal(result.invalidFields.length, 0);
  assert.equal(result.acceptedFields.length, 4);
  assert.equal(result.diagnostics.diagnostics.length, 0);
  assert.equal(result.diagnostics.acceptedFields.length, 4);
  assert.equal(result.identity.templateIdentity.path, issueContractFixture.templateIdentity.path);
});

test("unknown fields do not erase accepted fields and invalid diagnostics do not echo raw input", () => {
  const result = validatePartialSemanticInput(issueContractFixture, {
    problem: "A useful problem statement",
    category: "feature",
    acceptance: ["tests"],
    unexpected: "sensitive-user-value",
  });

  assert.deepEqual(result.acceptedFields, ["$.fields.acceptance", "$.fields.category", "$.fields.problem"]);
  assert.deepEqual(
    result.invalidFields.map((field) => field.field),
    ["unexpected"],
  );
  assert.equal(JSON.stringify(result.diagnostics).includes("sensitive-user-value"), false);
  assert.equal(JSON.stringify(result.invalidFields).includes("sensitive-user-value"), false);
});

test("classification alias returns the same stateless contract result", () => {
  const result = classifyPartialArtifactInput(issueContractFixture, { fields: { problem: "ok" } });
  assert.equal(result.templateIdentity.id, "feature");
  assert.equal(result.identity.artifactKind, "issue");
});

function withSummaryOptions(
  contract: CanonicalContract,
  options: { readonly defaultValue: string; readonly supplemental: Record<string, unknown> },
): CanonicalContract {
  return {
    ...contract,
    sections: contract.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) =>
        field.id === "summary"
          ? ({
              ...field,
              defaultValue: options.defaultValue,
            } as CanonicalContract["sections"][number]["fields"][number])
          : field,
      ),
    })),
    supplementalConstraints: { fields: [{ fieldId: "summary", ...options.supplemental }] },
  };
}
