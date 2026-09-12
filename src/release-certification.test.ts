import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendSelfDogfoodOperation,
  CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
  CERTIFICATION_KINDS,
  CERTIFICATION_RESULTS,
  SELF_DOGFOOD_OPERATION_REQUIREMENTS,
  SELF_DOGFOOD_RECOVERY_OPERATION,
} from "../scripts/certification-evidence.mjs";
import {
  RELEASE_CERTIFICATION_CONTRACT_VERSIONS,
  RELEASE_CERTIFICATION_SCHEMA_VERSION,
  verifyReleaseCertification,
  type ReleaseCertificationOperationEvidence,
  type ReleaseCertificationVerificationInput,
} from "./release-certification.js";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const TARBALL_SHA = `sha256:${"a".repeat(64)}`;

function dogfoodOperations(): ReleaseCertificationOperationEvidence[] {
  let operations: ReleaseCertificationOperationEvidence[] = [];
  for (const requirement of SELF_DOGFOOD_OPERATION_REQUIREMENTS)
    operations = [...appendSelfDogfoodOperation(operations, requirement.operation, requirement.outcomes[0])];
  return operations;
}

function packedEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: RELEASE_CERTIFICATION_SCHEMA_VERSION,
    certificationKind: CERTIFICATION_KINDS[0],
    result: CERTIFICATION_RESULTS[0],
    sourceCommitSha: SOURCE_SHA,
    contractVersions: { ...RELEASE_CERTIFICATION_CONTRACT_VERSIONS },
    diagnostics: [],
    package: { name: "gh-inari", version: "0.12.0", tarballSha256: TARBALL_SHA },
    ...overrides,
  };
}

function dogfoodEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
    certificationKind: CERTIFICATION_KINDS[1],
    result: CERTIFICATION_RESULTS[0],
    sourceCommitSha: SOURCE_SHA,
    contractVersions: { ...RELEASE_CERTIFICATION_CONTRACT_VERSIONS },
    diagnostics: [],
    repository: { owner: "yohn-jp", name: "gh-inari" },
    rootIssue: 405,
    change: { issue: 405, branch: "feat/405-certification", pullRequest: 999 },
    operations: dogfoodOperations(),
    finalState: { status: "REVIEW", recovery: { state: "NONE", action: null } },
    ...overrides,
  };
}

function input(overrides: Partial<ReleaseCertificationVerificationInput> = {}): ReleaseCertificationVerificationInput {
  return {
    expectedReleaseSourceCommitSha: SOURCE_SHA,
    expectedPackageName: "gh-inari",
    expectedPackageVersion: "0.12.0",
    expectedTarballSha256: TARBALL_SHA,
    expectedRepositoryOwner: "yohn-jp",
    expectedRepositoryName: "gh-inari",
    packedEvidence: packedEvidence(),
    dogfoodEvidence: dogfoodEvidence(),
    ...overrides,
  };
}

test("accepts both complete, source- and artifact-bound certification lanes", () => {
  const result = verifyReleaseCertification(input());
  assert.deepEqual(result, { passed: true, diagnostics: [] });
});

test("requires both evidence lanes and reports missing evidence deterministically", () => {
  const result = verifyReleaseCertification(input({ packedEvidence: undefined, dogfoodEvidence: undefined }));
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["EVIDENCE_MISSING", "EVIDENCE_MISSING"],
  );
});

test("rejects #399 entry-only evidence even when it has a matching source SHA", () => {
  const entryOnly = { sourceCommitSha: SOURCE_SHA, result: "passed", package: { name: "gh-inari" } };
  const result = verifyReleaseCertification(input({ packedEvidence: entryOnly }));
  assert.equal(result.passed, false);
  assert.equal(result.diagnostics[0]?.code, "EVIDENCE_MALFORMED");
});

test("rejects stale and mismatched source identities", () => {
  const result = verifyReleaseCertification(
    input({
      packedEvidence: packedEvidence({ sourceCommitSha: "fedcba9876543210fedcba9876543210fedcba98" }),
      dogfoodEvidence: dogfoodEvidence({ sourceCommitSha: SOURCE_SHA }),
    }),
  );
  assert.equal(result.passed, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "SOURCE_SHA_MISMATCH"));
});

test("binds self-dogfood evidence to the expected release repository", () => {
  const result = verifyReleaseCertification(
    input({ dogfoodEvidence: dogfoodEvidence({ repository: { owner: "other", name: "gh-inari" } }) }),
  );
  assert.equal(result.passed, false);
  assert.equal(result.diagnostics[0]?.code, "REPOSITORY_MISMATCH");
});

test("binds the canonical Change identity to the dogfood root Issue", () => {
  const result = verifyReleaseCertification(
    input({
      dogfoodEvidence: dogfoodEvidence({
        change: { issue: 404, branch: "feat/405-certification", pullRequest: 999 },
      }),
    }),
  );
  assert.equal(result.passed, false);
  assert.equal(result.diagnostics[0]?.code, "DOGFOOD_IDENTITY_INVALID");
});

test("rejects package, version, and exact tarball digest mismatches", () => {
  const result = verifyReleaseCertification(
    input({
      packedEvidence: packedEvidence({
        package: { name: "gh-inari", version: "0.11.0", tarballSha256: `sha256:${"b".repeat(64)}` },
      }),
    }),
  );
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["PACKAGE_MISMATCH", "TARBALL_DIGEST_MISMATCH"],
  );
});

test("rejects passed evidence with diagnostics or cross-lane fields", () => {
  const diagnosticResult = verifyReleaseCertification(
    input({ packedEvidence: packedEvidence({ diagnostics: [{ code: "PACKED_WARNING", message: "not clean" }] }) }),
  );
  assert.equal(diagnosticResult.passed, false);
  assert.equal(diagnosticResult.diagnostics[0]?.code, "EVIDENCE_MALFORMED");

  const crossLaneResult = verifyReleaseCertification(
    input({
      packedEvidence: packedEvidence({
        mutableLastGreen: true,
        repository: { owner: "yohn-jp", name: "gh-inari" },
      }),
    }),
  );
  assert.equal(crossLaneResult.passed, false);
  assert.equal(crossLaneResult.diagnostics[0]?.code, "EVIDENCE_MALFORMED");
});

test("rejects failed, blocked, and unknown results", () => {
  for (const resultValue of ["failed", "blocked", "unknown"]) {
    const result = verifyReleaseCertification(input({ packedEvidence: packedEvidence({ result: resultValue }) }));
    assert.equal(result.passed, false, resultValue);
    assert.equal(result.diagnostics[0]?.code, resultValue === "unknown" ? "EVIDENCE_MALFORMED" : "RESULT_NOT_PASSED");
  }
});

test("rejects stale schema and unknown contract versions", () => {
  const schemaResult = verifyReleaseCertification(input({ dogfoodEvidence: dogfoodEvidence({ schemaVersion: "2" }) }));
  assert.equal(schemaResult.passed, false);
  assert.equal(schemaResult.diagnostics[0]?.code, "SCHEMA_UNSUPPORTED");

  const contractResult = verifyReleaseCertification(
    input({
      packedEvidence: packedEvidence({ contractVersions: { goldenPath: "1", statusRecovery: "9", skill: "1.1.0" } }),
    }),
  );
  assert.equal(contractResult.passed, false);
  assert.equal(contractResult.diagnostics[0]?.code, "CONTRACT_VERSION_MISMATCH");
});

test("rejects malformed diagnostics, identity, final state, and unbounded operations", () => {
  const malformedDiagnostics = verifyReleaseCertification(
    input({
      packedEvidence: packedEvidence({ diagnostics: Array.from({ length: 21 }, () => ({ code: "x", message: "x" })) }),
    }),
  );
  assert.equal(malformedDiagnostics.passed, false);
  assert.equal(malformedDiagnostics.diagnostics[0]?.code, "EVIDENCE_MALFORMED");

  const malformedDogfood = verifyReleaseCertification(
    input({
      dogfoodEvidence: dogfoodEvidence({
        finalState: "IMPLEMENTATION",
        operations: Array.from({ length: 33 }, () => ({ name: "operation", outcome: "verified" })),
      }),
    }),
  );
  assert.equal(malformedDogfood.passed, false);
  assert.equal(malformedDogfood.diagnostics[0]?.code, "DOGFOOD_IDENTITY_INVALID");
});

test("requires the bounded idempotency and handoff operation proofs", () => {
  const missing = dogfoodEvidence();
  (missing.operations as Array<Record<string, string>>).splice(5, 1);
  const missingResult = verifyReleaseCertification(input({ dogfoodEvidence: missing }));
  assert.equal(missingResult.passed, false);
  assert.equal(missingResult.diagnostics[0]?.code, "DOGFOOD_OPERATION_MISSING");

  const wrongOutcome = dogfoodEvidence();
  (wrongOutcome.operations as Array<Record<string, string>>)[5] = {
    operation: SELF_DOGFOOD_OPERATION_REQUIREMENTS[5].operation,
    outcome: "verified",
  };
  const wrongOutcomeResult = verifyReleaseCertification(input({ dogfoodEvidence: wrongOutcome }));
  assert.equal(wrongOutcomeResult.passed, false);
  assert.equal(wrongOutcomeResult.diagnostics[0]?.code, "DOGFOOD_OPERATION_OUTCOME_INVALID");
});

test("requires a structured public REVIEW final state and never releases recovery state", () => {
  const recovery = verifyReleaseCertification(
    input({
      dogfoodEvidence: dogfoodEvidence({
        finalState: { status: "RECOVERY_REQUIRED", recovery: { state: "RECOVERY_REQUIRED", action: "inspect" } },
      }),
    }),
  );
  assert.equal(recovery.passed, false);
  assert.equal(recovery.diagnostics[0]?.code, "DOGFOOD_FINAL_STATE_INVALID");

  const malformed = verifyReleaseCertification(input({ dogfoodEvidence: dogfoodEvidence({ finalState: "REVIEW" }) }));
  assert.equal(malformed.passed, false);
  assert.equal(malformed.diagnostics[0]?.code, "DOGFOOD_FINAL_STATE_INVALID");
});

test("accepts only an exact Core-safe optional abort recovery proof for an ABORTED result", () => {
  const evidence = dogfoodEvidence({
    operations: [
      ...dogfoodOperations(),
      {
        operation: SELF_DOGFOOD_RECOVERY_OPERATION.operation,
        outcome: SELF_DOGFOOD_RECOVERY_OPERATION.outcomes[0],
      },
    ],
    finalState: { status: "ABORTED", recovery: { state: "COMPLETED", action: "none" } },
  });
  assert.equal(verifyReleaseCertification(input({ dogfoodEvidence: evidence })).passed, true);

  const unsafe = dogfoodEvidence({
    operations: [
      ...dogfoodOperations(),
      {
        operation: SELF_DOGFOOD_RECOVERY_OPERATION.operation,
        outcome: SELF_DOGFOOD_RECOVERY_OPERATION.outcomes[0],
      },
    ],
    finalState: { status: "ABORTED", recovery: { state: "COMPLETED", action: "manual-cleanup" } },
  });
  const unsafeResult = verifyReleaseCertification(input({ dogfoodEvidence: unsafe }));
  assert.equal(unsafeResult.passed, false);
  assert.equal(unsafeResult.diagnostics[0]?.code, "DOGFOOD_FINAL_STATE_INVALID");
});

test("rejects malformed release identity before evaluating evidence", () => {
  const result = verifyReleaseCertification(input({ expectedReleaseSourceCommitSha: "not-a-sha" }));
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["EXPECTED_IDENTITY_INVALID"],
  );
});
