import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CanonicalIrValidationError,
  deserializeCanonicalContract,
  isCanonicalContract,
  serializeCanonicalContract,
  validateCanonicalContract,
  type CanonicalContract,
} from "./index.js";
import { issueContractFixture, pullRequestContractFixture } from "./fixtures.js";

function serializedFixture(fixture: CanonicalContract): Record<string, unknown> {
  return JSON.parse(serializeCanonicalContract(fixture)) as Record<string, unknown>;
}

function violationCodes(input: unknown): readonly string[] {
  return validateCanonicalContract(input).violations.map((violation) => violation.code);
}

test("representative Issue and PR contracts are valid canonical IR", () => {
  assert.equal(isCanonicalContract(issueContractFixture), true);
  assert.equal(isCanonicalContract(pullRequestContractFixture), true);
  assert.deepEqual(validateCanonicalContract(issueContractFixture), { valid: true, violations: [] });
  assert.deepEqual(validateCanonicalContract(pullRequestContractFixture), { valid: true, violations: [] });
});

test("serialization is deterministic and survives a public round trip", () => {
  const serialized = serializeCanonicalContract(issueContractFixture);
  assert.equal(serialized, serializeCanonicalContract(deserializeCanonicalContract(serialized)));
  assert.equal(serialized, serializeCanonicalContract(issueContractFixture));
  assert.deepEqual(deserializeCanonicalContract(serialized), issueContractFixture);
});

test("invalid versions and unknown properties fail closed", () => {
  const invalid = serializedFixture(issueContractFixture);
  invalid.irVersion = "2.0.0";
  invalid.unexpected = true;
  const result = validateCanonicalContract(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((violation) => violation.code === "IR_UNSUPPORTED_VERSION"));
  assert.ok(result.violations.some((violation) => violation.code === "IR_UNKNOWN_PROPERTY"));
});

test("invalid ordering, field types, and source metadata are rejected", () => {
  const invalid = serializedFixture(issueContractFixture) as {
    sections: Array<{
      render: { order: number };
      fields: Array<{ type: string; render: { order: number } }>;
      nativeMetadata: { elementType: string };
    }>;
    templateIdentity: { source: string };
  };
  invalid.sections[0].render.order = 1;
  invalid.sections[0].fields[0].type = "unsupported";
  invalid.sections[0].fields[0].render.order = 1;
  invalid.sections[0].nativeMetadata.elementType = "heading";
  invalid.templateIdentity.source = "pull_request_template";
  const codes = violationCodes(invalid);
  assert.ok(codes.includes("IR_INVALID_ORDER"));
  assert.ok(codes.includes("IR_UNSUPPORTED_FIELD_TYPE"));
  assert.ok(codes.includes("IR_INCONSISTENT_SOURCE"));
});

test("render metadata is rejected outside Issue Form textareas", () => {
  const invalid = serializedFixture(issueContractFixture) as {
    sections: Array<{ fields: Array<{ nativeMetadata: { render?: string } }> }>;
  };
  invalid.sections[1].fields[0].nativeMetadata.render = "shell";
  const result = validateCanonicalContract(invalid);
  assert.equal(result.valid, false);
  assert.ok(
    result.violations.some(
      (violation) => violation.code === "IR_INCONSISTENT_FIELD" && violation.path.endsWith(".render"),
    ),
  );
});

test("required checklist items cannot be represented as optional", () => {
  const invalid = serializedFixture(issueContractFixture) as {
    sections: Array<{ fields: Array<{ required: string }> }>;
  };
  invalid.sections[3].fields[0].required = "optional";
  const result = validateCanonicalContract(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((violation) => violation.code === "IR_CHECKLIST_REQUIRED_MISMATCH"));
});

test("supplemental constraints must reference fields and cannot contradict native constraints", () => {
  const invalid = serializedFixture(pullRequestContractFixture) as {
    sections: Array<{ fields: Array<Record<string, unknown>> }>;
    supplementalConstraints: { fields: Array<Record<string, unknown>> };
  };
  invalid.sections[0].fields[0].constraints = { minLength: 10 };
  invalid.supplementalConstraints.fields.push({ fieldId: "missing", required: true });
  invalid.supplementalConstraints.fields.push({ fieldId: "linked_issue", pattern: "[" });
  invalid.supplementalConstraints.fields.push({ fieldId: "summary", minLength: 5 });
  const result = validateCanonicalContract(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((violation) => violation.code === "IR_UNKNOWN_FIELD_REFERENCE"));
  assert.ok(result.violations.some((violation) => violation.code === "IR_INVALID_CONSTRAINT"));
  assert.ok(
    result.violations.some(
      (violation) => violation.code === "IR_INCONSISTENT_CONSTRAINT" && violation.path.endsWith(".minLength"),
    ),
  );
});

test("malformed JSON produces the same structured validation error contract", () => {
  assert.throws(
    () => deserializeCanonicalContract("{"),
    (error: unknown) => {
      assert.ok(error instanceof CanonicalIrValidationError);
      assert.equal(error.violations[0]?.code, "IR_INVALID_JSON");
      return true;
    },
  );
});
