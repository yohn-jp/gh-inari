import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RELEASE_CERTIFICATION_CONTRACT_VERSIONS,
  verifyReleaseCertification,
  type ReleaseCertificationVerificationInput,
} from "./release-certification.js";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const TARBALL_SHA = `sha256:${"a".repeat(64)}`;

function packedEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    certificationKind: "packed-artifact-golden-path",
    result: "passed",
    sourceCommitSha: SOURCE_SHA,
    contractVersions: { ...RELEASE_CERTIFICATION_CONTRACT_VERSIONS },
    diagnostics: [],
    package: { name: "gh-inari", version: "0.12.0", tarballSha256: TARBALL_SHA },
    ...overrides,
  };
}

function dogfoodEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    certificationKind: "self-dogfood-golden-path",
    result: "passed",
    sourceCommitSha: SOURCE_SHA,
    contractVersions: { ...RELEASE_CERTIFICATION_CONTRACT_VERSIONS },
    diagnostics: [],
    repository: { owner: "yohn-jp", name: "gh-inari" },
    rootIssue: 405,
    change: { issue: 405, branch: "feat/405-certification", pullRequest: 999 },
    operations: [
      { name: "issue", outcome: "verified" },
      { name: "repeat-issue", outcome: "returned-existing" },
      { name: "handoff", outcome: "verified" },
      { name: "ready-reread", outcome: "verified" },
    ],
    finalState: "REVIEW",
    ...overrides,
  };
}

function input(overrides: Partial<ReleaseCertificationVerificationInput> = {}): ReleaseCertificationVerificationInput {
  return {
    expectedReleaseSourceCommitSha: SOURCE_SHA,
    expectedPackageName: "gh-inari",
    expectedPackageVersion: "0.12.0",
    expectedTarballSha256: TARBALL_SHA,
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

test("rejects malformed release identity before evaluating evidence", () => {
  const result = verifyReleaseCertification(input({ expectedReleaseSourceCommitSha: "not-a-sha" }));
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["EXPECTED_IDENTITY_INVALID"],
  );
});
