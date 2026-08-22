import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARTIFACT_DIAGNOSTIC_VERSION,
  MAX_ACCEPTED_FIELDS,
  MAX_ARTIFACT_DIAGNOSTICS,
  MAX_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_DIAGNOSTIC_PATH_LENGTH,
  MAX_EVIDENCE_COLLECTION_LENGTH,
  MAX_EVIDENCE_LENGTH,
  MAX_RECOVERY_ACTIONS,
  MAX_RECOVERY_HINT_LENGTH,
  createArtifactDiagnostic,
  createArtifactDiagnosticReport,
  createFieldEvidence,
  deserializeArtifactDiagnosticReport,
  formatArtifactDiagnosticReport,
  serializeArtifactDiagnosticReport,
  type ArtifactDiagnosticEvidence,
} from "./diagnostics.js";

test("diagnostic contract represents every state plus stable reason/detail codes", () => {
  const diagnostics = [
    createArtifactDiagnostic({
      state: "accepted",
      code: "FIELD_ACCEPTED",
      path: "$.fields.summary",
      message: "Summary was accepted.",
      detailCode: "FIELD_ACCEPTED",
    }),
    createArtifactDiagnostic({
      state: "missing",
      code: "FIELD_MISSING",
      path: "$.fields.acceptance",
      message: "Acceptance is required.",
      detailCode: "FIELD_REQUIRED",
      recovery: [{ action: "provide", path: "$.fields.acceptance", hint: "Provide at least one item." }],
    }),
    createArtifactDiagnostic({
      state: "invalid",
      code: "FIELD_INVALID",
      path: "$.fields.priority",
      message: "Priority has an invalid value.",
      reason: "constraint",
      detailCode: "FIELD_CONSTRAINT_VIOLATION",
      expected: createFieldEvidence("$.fields.priority", ["low", "high"]),
      actual: createFieldEvidence("$.fields.priority", "urgent"),
    }),
    createArtifactDiagnostic({
      state: "invalid",
      code: "FIELD_INVALID",
      path: "$.fields.owner",
      message: "Owner has the wrong type.",
      reason: "type",
      detailCode: "FIELD_TYPE_MISMATCH",
    }),
    createArtifactDiagnostic({
      state: "conflicting",
      code: "FIELD_CONFLICT",
      path: "$.fields.owner",
      message: "Two sources supplied different values.",
      detailCode: "FIELD_VALUE_CONFLICT",
      recovery: [{ action: "resolve-conflict", path: "$.fields.owner" }],
    }),
    createArtifactDiagnostic({
      state: "conflicting",
      code: "FIELD_CONFLICT",
      path: "$.artifact",
      message: "More than one template is a candidate.",
      detailCode: "TEMPLATE_AMBIGUOUS",
      recovery: [{ action: "select-template" }],
    }),
    createArtifactDiagnostic({
      state: "unsupported",
      code: "FIELD_UNSUPPORTED",
      path: "$.fields.legacy",
      message: "The field is not supported by this contract.",
      detailCode: "FIELD_UNSUPPORTED",
      recovery: [{ action: "replace", path: "$.fields.legacy" }],
    }),
    createArtifactDiagnostic({
      state: "unsupported",
      code: "FIELD_UNSUPPORTED",
      path: "$.artifact",
      message: "The artifact cannot be parsed under this contract.",
      detailCode: "TEMPLATE_UNPARSEABLE",
    }),
    createArtifactDiagnostic({
      state: "unrecoverable",
      code: "ARTIFACT_UNRECOVERABLE",
      path: "$.artifact",
      message: "The artifact cannot be reconstructed deterministically.",
      recovery: [{ action: "repair" }],
    }),
  ];
  const report = createArtifactDiagnosticReport(diagnostics, ["$.fields.summary"]);

  assert.equal(report.version, ARTIFACT_DIAGNOSTIC_VERSION);
  assert.equal(report.diagnostics.length, 9);
  assert.deepEqual(report.acceptedFields, ["$.fields.summary"]);
  assert.match(formatArtifactDiagnosticReport(report), /\[FIELD_MISSING\/FIELD_REQUIRED\/required\]/);
  assert.match(formatArtifactDiagnosticReport(report), /Accepted fields: \$\.fields\.summary/);
  assert.deepEqual(
    new Set(report.diagnostics.map((diagnostic) => diagnostic.state)),
    new Set(["accepted", "missing", "invalid", "conflicting", "unsupported", "unrecoverable"]),
  );
});

test("evidence is field-local and never retains direct strings, raw bodies, or secret locations", () => {
  const evidence = createFieldEvidence("$.fields.summary", "short-secret");
  assert.deepEqual(evidence, {
    field: "$.fields.summary",
    type: "string",
    length: "short-secret".length,
    truncated: false,
  });
  assert.equal(JSON.stringify(evidence).includes("short-secret"), false);

  for (const field of [
    "$.rawBody",
    "$.renderedBody",
    "$.fullArtifact",
    "$.accessToken",
    "$.privateKey",
    "$.sessionSecret",
    "$.fields.token",
  ]) {
    assert.throws(() => createFieldEvidence(field, "secret"), /non-sensitive semantic field/);
  }

  assert.throws(
    () =>
      createArtifactDiagnostic({
        state: "invalid",
        code: "FIELD_INVALID",
        message: "Direct evidence is not allowed.",
        expected: "short-secret" as unknown as ArtifactDiagnosticEvidence,
      }),
    /field-local typed evidence/,
  );

  const objectEvidence = createFieldEvidence("$.fields.summary", {
    rawBody: "full body",
    accessToken: "secret",
    nested: { privateKey: "secret" },
  });
  assert.deepEqual(objectEvidence, {
    field: "$.fields.summary",
    type: "object",
    keyCount: 3,
    truncated: false,
  });
  assert.equal(JSON.stringify(objectEvidence).includes("full body"), false);
  assert.equal(JSON.stringify(objectEvidence).includes("secret"), false);
});

test("serialization canonicalizes equivalent diagnostic sets including evidence and recovery", () => {
  const invalid = createArtifactDiagnostic({
    state: "invalid",
    code: "FIELD_INVALID",
    path: "$.fields.title",
    message: "Invalid title.",
    detailCode: "FIELD_CONSTRAINT_VIOLATION",
    expected: createFieldEvidence("$.fields.title", "expected"),
    actual: createFieldEvidence("$.fields.title", "actual"),
    recovery: [
      { action: "retry", hint: "Retry after correcting input." },
      { action: "provide", path: "$.fields.title", hint: "Provide a valid title." },
    ],
  });
  const missing = createArtifactDiagnostic({
    state: "missing",
    code: "FIELD_MISSING",
    path: "$.fields.summary",
    message: "Summary is missing.",
    expected: createFieldEvidence("$.fields.summary", "required"),
  });
  const first = createArtifactDiagnosticReport([invalid, missing], ["$.fields.owner", "$.fields.summary"]);
  const second = createArtifactDiagnosticReport([missing, invalid], ["$.fields.summary", "$.fields.owner"]);

  const serialized = serializeArtifactDiagnosticReport(first);
  assert.equal(serialized, serializeArtifactDiagnosticReport(second));
  assert.deepEqual(deserializeArtifactDiagnosticReport(serialized), first);
  assert.throws(
    () => deserializeArtifactDiagnosticReport(JSON.stringify({ ...first, extra: true })),
    /unknown property/,
  );
});

test("all report, text, recovery, and evidence bounds fail closed at the first excess value", () => {
  const base = createArtifactDiagnostic({
    state: "missing",
    code: "FIELD_MISSING",
    path: "$.fields.summary",
    message: "Summary is missing.",
  });
  assert.equal(
    createArtifactDiagnosticReport(Array.from({ length: MAX_ARTIFACT_DIAGNOSTICS }, () => base)).diagnostics.length,
    MAX_ARTIFACT_DIAGNOSTICS,
  );
  assert.throws(
    () => createArtifactDiagnosticReport(Array.from({ length: MAX_ARTIFACT_DIAGNOSTICS + 1 }, () => base)),
    /diagnostics are supported/,
  );

  const accepted = Array.from({ length: MAX_ACCEPTED_FIELDS }, (_, index) => `$.fields.f${index}`);
  assert.equal(createArtifactDiagnosticReport([], accepted).acceptedFields.length, MAX_ACCEPTED_FIELDS);
  assert.throws(
    () => createArtifactDiagnosticReport([], [...accepted, "$.fields.tooMany"]),
    /accepted fields are supported/,
  );

  assert.doesNotThrow(() =>
    createArtifactDiagnostic({
      state: "missing",
      code: "FIELD_MISSING",
      message: "x".repeat(MAX_DIAGNOSTIC_MESSAGE_LENGTH),
    }),
  );
  assert.throws(
    () =>
      createArtifactDiagnostic({
        state: "missing",
        code: "FIELD_MISSING",
        message: "x".repeat(MAX_DIAGNOSTIC_MESSAGE_LENGTH + 1),
      }),
    /text exceeds/,
  );

  const exactPath = `$.${"x".repeat(MAX_DIAGNOSTIC_PATH_LENGTH - 2)}`;
  assert.deepEqual(createFieldEvidence(exactPath, true), { field: exactPath, type: "boolean", value: true });
  assert.throws(() => createFieldEvidence(`${exactPath}x`, true), /text exceeds/);

  const exactHint = "h".repeat(MAX_RECOVERY_HINT_LENGTH);
  assert.equal(
    createArtifactDiagnostic({
      state: "missing",
      code: "FIELD_MISSING",
      message: "missing",
      recovery: Array.from({ length: MAX_RECOVERY_ACTIONS }, (_, index) => ({
        action: "repair" as const,
        path: `$.fields.f${index}`,
        hint: exactHint,
      })),
    }).recovery?.length,
    MAX_RECOVERY_ACTIONS,
  );
  assert.throws(
    () =>
      createArtifactDiagnostic({
        state: "missing",
        code: "FIELD_MISSING",
        message: "missing",
        recovery: Array.from({ length: MAX_RECOVERY_ACTIONS + 1 }, () => ({ action: "repair" as const })),
      }),
    /recovery actions are supported/,
  );
  assert.throws(
    () =>
      createArtifactDiagnostic({
        state: "missing",
        code: "FIELD_MISSING",
        message: "missing",
        recovery: [{ action: "repair", hint: `${exactHint}x` }],
      }),
    /text exceeds/,
  );

  const exactString = createFieldEvidence("$.fields.summary", "x".repeat(MAX_EVIDENCE_LENGTH));
  assert.deepEqual(exactString, {
    field: "$.fields.summary",
    type: "string",
    length: MAX_EVIDENCE_LENGTH,
    truncated: false,
  });
  assert.deepEqual(createFieldEvidence("$.fields.summary", "x".repeat(MAX_EVIDENCE_LENGTH + 1)), {
    field: "$.fields.summary",
    type: "string",
    length: MAX_EVIDENCE_LENGTH,
    truncated: true,
  });
  assert.deepEqual(
    createFieldEvidence(
      "$.fields.items",
      Array.from({ length: MAX_EVIDENCE_COLLECTION_LENGTH }, () => "x"),
    ),
    {
      field: "$.fields.items",
      type: "array",
      itemCount: MAX_EVIDENCE_COLLECTION_LENGTH,
      itemTypes: ["string"],
      truncated: false,
    },
  );
  assert.equal(
    (
      createFieldEvidence(
        "$.fields.items",
        Array.from({ length: MAX_EVIDENCE_COLLECTION_LENGTH + 1 }, () => "x"),
      ) as { truncated: boolean }
    ).truncated,
    true,
  );
});

test("detail-code/state mismatches and non-finite evidence fail closed", () => {
  assert.throws(
    () =>
      createArtifactDiagnostic({
        state: "missing",
        code: "FIELD_INVALID",
        detailCode: "FIELD_REQUIRED",
        message: "Mismatched state and code.",
      }),
    /incompatible with state\/code/,
  );
  assert.throws(
    () =>
      createArtifactDiagnostic({
        state: "invalid",
        code: "FIELD_INVALID",
        reason: "required",
        message: "Mismatched reason.",
      }),
    /incompatible with reason/,
  );
  assert.throws(() => createFieldEvidence("$.fields.count", Number.NaN), /Non-finite/);
});
