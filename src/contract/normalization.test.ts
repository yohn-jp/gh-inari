import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_NORMALIZABLE_STRING_LENGTH, normalizeFieldValue } from "./normalization.js";
import type { CanonicalField } from "./ir.js";

const stringField: CanonicalField = {
  id: "problem",
  label: "Problem",
  type: "string",
  required: "required",
  render: { order: 0 },
  nativeMetadata: { elementType: "textarea" },
};

const enumField: CanonicalField = {
  id: "category",
  label: "Category",
  type: "enum",
  required: "required",
  options: [{ value: "feature", label: "Feature" }],
  render: { order: 0 },
  nativeMetadata: { elementType: "dropdown" },
};

const arrayField: CanonicalField = {
  id: "affected_areas",
  label: "Affected areas",
  type: "array",
  selection: "list",
  required: "optional",
  items: { type: "string" },
  render: { order: 0 },
  nativeMetadata: { elementType: "dropdown" },
};

const checklistField: CanonicalField = {
  id: "acceptance",
  label: "Acceptance criteria",
  type: "checklist",
  required: "required",
  items: [{ id: "tests", label: "Tests", required: true }],
  render: { order: 0 },
  nativeMetadata: { elementType: "checkboxes" },
};

// Constructed via fromCharCode/fromCodePoint rather than literal or escaped
// source characters, so this file's own bytes stay unambiguous ASCII.
const BOM = String.fromCharCode(0xfeff);
const BELL = String.fromCharCode(0x0007);
const DEL = String.fromCharCode(0x007f);
const C1_NEL = String.fromCharCode(0x0085);
const PRECOMPOSED_E_ACUTE = String.fromCodePoint(0x00e9);
const DECOMPOSED_E_ACUTE = "e" + String.fromCodePoint(0x0301);

test("strips a leading BOM, applies a single newline policy, and trims bounded whitespace", () => {
  const result = normalizeFieldValue(stringField, `${BOM}  Hello\r\nWorld  \r\n`);
  assert.deepEqual(result, { ok: true, value: "Hello\nWorld" });
});

test("normalizes CR-only line endings the same as CRLF", () => {
  const crlf = normalizeFieldValue(stringField, "one\r\ntwo\r\nthree");
  const cr = normalizeFieldValue(stringField, "one\rtwo\rthree");
  assert.deepEqual(crlf, cr);
  assert.deepEqual(crlf, { ok: true, value: "one\ntwo\nthree" });
});

test("folds Unicode to NFC so decomposed and precomposed candidates converge", () => {
  const decomposed = normalizeFieldValue(stringField, `Caf${DECOMPOSED_E_ACUTE}`);
  const precomposed = normalizeFieldValue(stringField, `Caf${PRECOMPOSED_E_ACUTE}`);
  assert.deepEqual(decomposed, precomposed);
  assert.equal(decomposed.ok, true);
  if (decomposed.ok) assert.equal(decomposed.value, `Caf${PRECOMPOSED_E_ACUTE}`);
});

test("preserves internal tabs and newlines, only trimming bounding whitespace", () => {
  const result = normalizeFieldValue(stringField, "  a\tb\nc  ");
  assert.deepEqual(result, { ok: true, value: "a\tb\nc" });
});

test("rejects control characters instead of stripping them", () => {
  const result = normalizeFieldValue(stringField, `before${BELL}after`);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "INPUT_UNSAFE_CONTENT");
});

test("rejects DEL and C1 control characters", () => {
  const del = normalizeFieldValue(stringField, `value${DEL}end`);
  const c1 = normalizeFieldValue(stringField, `value${C1_NEL}end`);
  assert.equal(del.ok, false);
  assert.equal(c1.ok, false);
});

test("rejects values exceeding the normalizable length ceiling before any other processing", () => {
  const oversized = "a".repeat(MAX_NORMALIZABLE_STRING_LENGTH + 1);
  const result = normalizeFieldValue(stringField, oversized);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "INPUT_MAX_LENGTH");
});

test("enum candidates receive the same whitespace normalization as string fields", () => {
  const result = normalizeFieldValue(enumField, "  feature  ");
  assert.deepEqual(result, { ok: true, value: "feature" });
});

test("array entries are normalized independently and non-string entries pass through", () => {
  const result = normalizeFieldValue(arrayField, ["  contracts \r\n", "  docs"]);
  assert.deepEqual(result, { ok: true, value: ["contracts", "docs"] });

  const mixed = normalizeFieldValue(arrayField, ["cli", 7]);
  assert.deepEqual(mixed, { ok: true, value: ["cli", 7] });
});

test("checklist entries are normalized and one unsafe entry fails the whole array closed", () => {
  const clean = normalizeFieldValue(checklistField, ["  tests  "]);
  assert.deepEqual(clean, { ok: true, value: ["tests"] });

  const unsafe = normalizeFieldValue(checklistField, ["tests", `bad${BELL}entry`]);
  assert.equal(unsafe.ok, false);
});

test("non-string, non-array values pass through untouched for type validation to reject", () => {
  assert.deepEqual(normalizeFieldValue(stringField, 42), { ok: true, value: 42 });
  assert.deepEqual(normalizeFieldValue(stringField, null), { ok: true, value: null });
  assert.deepEqual(normalizeFieldValue(arrayField, "not-an-array"), { ok: true, value: "not-an-array" });
});

test("normalization is idempotent", () => {
  const once = normalizeFieldValue(stringField, `${BOM}  Caf${DECOMPOSED_E_ACUTE}\r\n\r\nline two  `);
  assert.equal(once.ok, true);
  if (!once.ok) return;
  const twice = normalizeFieldValue(stringField, once.value as string);
  assert.deepEqual(once, twice);
});
