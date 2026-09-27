import assert from "node:assert/strict";
import test from "node:test";
import {
  SOURCE_ACCEPTANCE_LIMITS,
  SOURCE_ACCEPTANCE_RECORD_VERSION,
  SourceAcceptanceRecordError,
  serializeSourceAcceptanceRecord,
  sourceAcceptanceCriteriaDigest,
  validateSourceAcceptanceRecord,
  type SourceAcceptanceCandidate,
  type SourceAcceptanceCriteriaSnapshot,
  type SourceAcceptanceRecord,
} from "./source-acceptance.js";

const repository = Object.freeze({ host: "github.com", id: "1330755860" });
const criteria: SourceAcceptanceCriteriaSnapshot = Object.freeze({
  version: 3,
  criteria: Object.freeze([
    Object.freeze({ id: "outcome", text: "The composed outcome matches the request." }),
    Object.freeze({ id: "validation", text: "Required validation evidence is present." }),
  ]),
});
const integrationPullRequest = Object.freeze({ number: 1273, headSha: "a".repeat(40) });
const candidate: SourceAcceptanceCandidate = Object.freeze({
  repository,
  sourceIssue: 902,
  integrationPullRequest,
  criteria,
});

function record(overrides: Partial<SourceAcceptanceRecord> = {}): SourceAcceptanceRecord {
  return {
    version: SOURCE_ACCEPTANCE_RECORD_VERSION,
    repository,
    sourceIssue: candidate.sourceIssue,
    integrationPullRequest,
    criteria: { version: criteria.version, digest: sourceAcceptanceCriteriaDigest(criteria) },
    reviewer: { providerHost: "github.com", userId: "314159" },
    results: [
      { criterionId: "outcome", result: "pass" },
      { criterionId: "validation", result: "pass" },
    ],
    ...overrides,
  };
}

function codes(result: ReturnType<typeof validateSourceAcceptanceRecord>): string[] {
  return result.diagnostics.map((item) => item.code);
}

test("criteria digest and canonical record serialization are deterministic", () => {
  const reversedCriteria = {
    version: criteria.version,
    criteria: [...criteria.criteria].reverse(),
  };
  assert.equal(sourceAcceptanceCriteriaDigest(reversedCriteria), sourceAcceptanceCriteriaDigest(criteria));

  const value = record({
    results: [
      { criterionId: "validation", result: "pass" },
      { criterionId: "outcome", result: "pass" },
    ],
  });
  const canonical = serializeSourceAcceptanceRecord(value);
  assert.equal(canonical, serializeSourceAcceptanceRecord(record()));
  assert.equal(canonical, serializeSourceAcceptanceRecord(JSON.parse(canonical) as unknown));

  const result = validateSourceAcceptanceRecord(canonical, candidate);
  assert.equal(result.classification, "valid-for-supplied-candidate");
  if (result.classification !== "valid-for-supplied-candidate") return;
  assert.deepEqual(
    result.record.results.map((item) => item.criterionId),
    ["outcome", "validation"],
  );
  assert.ok(Object.isFrozen(result.record));
  assert.ok(Object.isFrozen(result.record.repository));
  assert.ok(Object.isFrozen(result.record.criteria));
  assert.ok(Object.isFrozen(result.record.reviewer));
  assert.ok(Object.isFrozen(result.record.results));
  assert.equal(Object.hasOwn(result.record, "reviewerAuthorized"), false);
  assert.equal(Object.hasOwn(result.record, "sourceAccepted"), false);
});

test("record binds immutable repository, Source, integration PR, and exact head", () => {
  const wrongBindings: Array<[unknown, SourceAcceptanceCandidate, string]> = [
    [record(), { ...candidate, repository: { ...repository, id: "9" } }, "REPOSITORY_MISMATCH"],
    [record(), { ...candidate, sourceIssue: 903 }, "SOURCE_MISMATCH"],
    [
      record(),
      { ...candidate, integrationPullRequest: { ...integrationPullRequest, number: 1274 } },
      "INTEGRATION_PR_MISMATCH",
    ],
    [
      record(),
      { ...candidate, integrationPullRequest: { ...integrationPullRequest, headSha: "b".repeat(40) } },
      "INTEGRATION_HEAD_MISMATCH",
    ],
  ];
  for (const [value, expected, code] of wrongBindings) {
    const result = validateSourceAcceptanceRecord(value, expected);
    assert.equal(result.classification, "rejected");
    assert.ok(codes(result).includes(code), `${code} should be reported`);
  }
});

test("criteria version and content changes make an earlier record stale", () => {
  const prior = record();
  const changedVersion = validateSourceAcceptanceRecord(prior, {
    ...candidate,
    criteria: { ...criteria, version: criteria.version + 1 },
  });
  assert.equal(changedVersion.classification, "rejected");
  assert.ok(codes(changedVersion).includes("CRITERIA_VERSION_STALE"));
  assert.ok(codes(changedVersion).includes("CRITERIA_DIGEST_STALE"));

  const changedText = validateSourceAcceptanceRecord(prior, {
    ...candidate,
    criteria: {
      ...criteria,
      criteria: criteria.criteria.map((item) =>
        item.id === "outcome" ? { ...item, text: "A changed acceptance criterion." } : item,
      ),
    },
  });
  assert.equal(changedText.classification, "rejected");
  assert.deepEqual(codes(changedText), ["CRITERIA_DIGEST_STALE"]);
});

test("each current criterion needs one result and duplicate or unknown results are distinct", () => {
  const missing = validateSourceAcceptanceRecord(
    record({ results: [{ criterionId: "outcome", result: "pass" }] }),
    candidate,
  );
  assert.deepEqual(codes(missing), ["CRITERION_RESULT_MISSING"]);

  const duplicate = record({
    results: [
      { criterionId: "outcome", result: "pass" },
      { criterionId: "outcome", result: "pass" },
      { criterionId: "validation", result: "pass" },
    ],
  });
  const duplicated = validateSourceAcceptanceRecord(duplicate, candidate);
  assert.ok(codes(duplicated).includes("CRITERION_RESULT_DUPLICATE"));
  assert.throws(() => serializeSourceAcceptanceRecord(duplicate), SourceAcceptanceRecordError);

  const unknown = validateSourceAcceptanceRecord(
    record({ results: [...record().results, { criterionId: "not-current", result: "pass" }] }),
    candidate,
  );
  assert.deepEqual(codes(unknown), ["CRITERION_RESULT_UNKNOWN"]);
});

test("a recorded failing criterion is rejected without becoming Change policy acceptance", () => {
  const failed = validateSourceAcceptanceRecord(
    record({
      results: [
        { criterionId: "outcome", result: "fail" },
        { criterionId: "validation", result: "pass" },
      ],
    }),
    candidate,
  );
  assert.equal(failed.classification, "rejected");
  assert.deepEqual(codes(failed), ["CRITERION_FAILED"]);
});

test("strict shape, canonical input, and record size bounds fail closed", () => {
  const extra = { ...record(), currentReviewerAuthorized: true };
  assert.ok(codes(validateSourceAcceptanceRecord(extra, candidate)).includes("RECORD_MALFORMED"));

  const unsupported = { ...record(), version: SOURCE_ACCEPTANCE_RECORD_VERSION + 1 };
  assert.ok(codes(validateSourceAcceptanceRecord(unsupported, candidate)).includes("RECORD_VERSION_UNSUPPORTED"));

  const canonical = serializeSourceAcceptanceRecord(record());
  const oversized = " ".repeat(SOURCE_ACCEPTANCE_LIMITS.recordBytes + 1);
  assert.ok(codes(validateSourceAcceptanceRecord(oversized, candidate)).includes("RECORD_OVERSIZED"));
  assert.ok(codes(validateSourceAcceptanceRecord(` ${canonical}`, candidate)).includes("RECORD_NON_CANONICAL"));

  const duplicateJsonKey = canonical.replace('"version":1', '"version":1,"version":1');
  assert.ok(codes(validateSourceAcceptanceRecord(duplicateJsonKey, candidate)).includes("RECORD_NON_CANONICAL"));
});

test("invalid current criteria snapshots cannot produce a digest or a current binding", () => {
  const duplicateCriteria = {
    version: 3,
    criteria: [
      { id: "same", text: "First criterion." },
      { id: "same", text: "Second criterion." },
    ],
  };
  assert.throws(() => sourceAcceptanceCriteriaDigest(duplicateCriteria), SourceAcceptanceRecordError);
  const result = validateSourceAcceptanceRecord(record(), { ...candidate, criteria: duplicateCriteria });
  assert.equal(result.classification, "rejected");
  assert.ok(codes(result).includes("CRITERIA_SNAPSHOT_INVALID"));
});
