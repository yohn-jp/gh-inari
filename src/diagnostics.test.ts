import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARTIFACT_DIAGNOSTIC_VERSION,
  MAX_ARTIFACT_DIAGNOSTICS,
  MAX_EVIDENCE_STRING_LENGTH,
  createArtifactDiagnostic,
  createArtifactDiagnosticReport,
  deserializeArtifactDiagnosticReport,
  formatArtifactDiagnosticReport,
  serializeArtifactDiagnosticReport,
} from "./diagnostics.js";

test("diagnostic contract represents every convergence state and accepted fields", () => {
  const diagnostics = [
    createArtifactDiagnostic({
      state: "accepted",
      code: "FIELD_ACCEPTED",
      path: "$.fields.summary",
      message: "Summary was accepted.",
    }),
    createArtifactDiagnostic({
      state: "missing",
      code: "FIELD_MISSING",
      path: "$.fields.acceptance",
      message: "Acceptance is required.",
      recovery: [{ action: "provide", path: "$.fields.acceptance", hint: "Provide at least one item." }],
    }),
    createArtifactDiagnostic({
      state: "invalid",
      code: "FIELD_INVALID",
      path: "$.fields.priority",
      message: "Priority is not one of the declared values.",
      expected: ["low", "high"],
      actual: "urgent",
    }),
    createArtifactDiagnostic({
      state: "conflicting",
      code: "FIELD_CONFLICT",
      path: "$.fields.owner",
      message: "Two sources supplied different values.",
      recovery: [{ action: "resolve-conflict", path: "$.fields.owner" }],
    }),
    createArtifactDiagnostic({
      state: "unsupported",
      code: "FIELD_UNSUPPORTED",
      path: "$.fields.legacy",
      message: "The field is not supported by this contract.",
      recovery: [{ action: "replace", path: "$.fields.legacy" }],
    }),
    createArtifactDiagnostic({
      state: "unrecoverable",
      code: "ARTIFACT_UNRECOVERABLE",
      path: "$.artifact",
      message: "The artifact cannot be reconstructed deterministically.",
      recovery: [{ action: "select-template" }],
    }),
  ];
  const report = createArtifactDiagnosticReport(diagnostics, ["$.fields.summary"]);

  assert.equal(report.version, ARTIFACT_DIAGNOSTIC_VERSION);
  assert.equal(report.diagnostics.length, 6);
  assert.deepEqual(report.acceptedFields, ["$.fields.summary"]);
  assert.match(formatArtifactDiagnosticReport(report), /\[FIELD_MISSING\].*Acceptance is required/);
  assert.match(formatArtifactDiagnosticReport(report), /Accepted fields: \$\.fields\.summary/);
  assert.deepEqual(
    new Set(report.diagnostics.map((diagnostic) => diagnostic.state)),
    new Set(["accepted", "missing", "invalid", "conflicting", "unsupported", "unrecoverable"]),
  );
});

test("diagnostic evidence is bounded and redacts secrets and complete artifact containers", () => {
  const longValue = "x".repeat(MAX_EVIDENCE_STRING_LENGTH + 40);
  const diagnostic = createArtifactDiagnostic({
    state: "invalid",
    code: "FIELD_INVALID",
    path: "$.fields.summary",
    message: "The supplied value is invalid.",
    expected: {
      allowed: ["short", "long"],
      body: "complete rendered artifact must not be exposed",
      token: "secret-token-value",
      nested: { value: longValue },
    },
    actual: {
      fields: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field-${index}`, index])),
      details: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`detail-${index}`, index])),
    },
  });

  assert.deepEqual(evidenceProperty(diagnostic.expected, "body"), "[redacted]");
  assert.deepEqual(evidenceProperty(diagnostic.expected, "token"), "[redacted]");
  assert.equal(JSON.stringify(diagnostic).includes("secret-token-value"), false);
  assert.equal(JSON.stringify(diagnostic).includes("complete rendered artifact"), false);
  assert.equal(JSON.stringify(diagnostic).includes(longValue), false);
  assert.equal(JSON.stringify(diagnostic).includes("_truncated"), true);
});

test("diagnostic serialization is stable and round-trips the bounded contract", () => {
  const first = createArtifactDiagnostic({
    state: "invalid",
    code: "FIELD_INVALID",
    path: "$.fields.title",
    message: "Invalid title.",
    expected: { maxLength: 80, minLength: 1 },
    actual: "bad",
  });
  const second = createArtifactDiagnostic({
    state: "missing",
    code: "FIELD_MISSING",
    path: "$.fields.summary",
    message: "Summary is missing.",
  });
  const report = createArtifactDiagnosticReport([first, second], ["$.fields.owner", "$.fields.summary"]);
  const serialized = serializeArtifactDiagnosticReport(report);
  const restored = deserializeArtifactDiagnosticReport(serialized);

  assert.equal(serialized, serializeArtifactDiagnosticReport(restored));
  assert.deepEqual(restored, report);
  assert.throws(
    () => deserializeArtifactDiagnosticReport(JSON.stringify({ ...report, version: 2 })),
    /Unsupported artifact diagnostics version/,
  );
  assert.throws(
    () => deserializeArtifactDiagnosticReport(JSON.stringify({ ...report, extra: true })),
    /unknown property/,
  );
});

function evidenceProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Readonly<Record<string, unknown>>)[key];
}

test("diagnostic contract bounds report size, recovery actions, and state/code pairs", () => {
  const base = createArtifactDiagnostic({
    state: "missing",
    code: "FIELD_MISSING",
    path: "$.fields.summary",
    message: "Summary is missing.",
  });
  assert.throws(
    () => createArtifactDiagnosticReport(Array.from({ length: MAX_ARTIFACT_DIAGNOSTICS + 1 }, () => base)),
    /diagnostics are supported/,
  );
  assert.throws(
    () =>
      createArtifactDiagnostic({
        state: "missing",
        code: "FIELD_INVALID",
        message: "Mismatched state and code.",
      }),
    /incompatible with state/,
  );
  assert.throws(
    () =>
      createArtifactDiagnostic({
        state: "invalid",
        code: "FIELD_INVALID",
        message: "Too many recovery actions.",
        recovery: [
          { action: "repair" },
          { action: "repair" },
          { action: "repair" },
          { action: "repair" },
          { action: "repair" },
        ],
      }),
    /recovery actions are supported/,
  );
});
