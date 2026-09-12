import assert from "node:assert/strict";
import test from "node:test";
import {
  appendSelfDogfoodOperation,
  CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
  CERTIFICATION_KINDS,
  CERTIFICATION_RESULTS,
  CertificationEvidenceError,
  SELF_DOGFOOD_OPERATION_REQUIREMENTS,
  serializeCertificationEvidence,
  validateCertificationEvidence,
  validateSelfDogfoodEvidence,
} from "./certification-evidence.mjs";
import { RELEASE_CERTIFICATION_CONTRACT_VERSIONS, verifyReleaseCertification } from "../src/release-certification.js";

const SOURCE_SHA = "c".repeat(40);
const TARBALL_SHA = `sha256:${"d".repeat(64)}`;
const PACKAGE = { name: "gh-inari", version: "0.12.0", tarballSha256: TARBALL_SHA };

function completeOperations() {
  return SELF_DOGFOOD_OPERATION_REQUIREMENTS.reduce(
    (operations, requirement) => appendSelfDogfoodOperation(operations, requirement.operation, requirement.outcomes[0]),
    [],
  );
}

function packedEvidence() {
  return {
    schemaVersion: CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
    certificationKind: CERTIFICATION_KINDS[0],
    result: CERTIFICATION_RESULTS[0],
    sourceCommitSha: SOURCE_SHA,
    contractVersions: { ...RELEASE_CERTIFICATION_CONTRACT_VERSIONS },
    package: PACKAGE,
    diagnostics: [],
  };
}

function dogfoodEvidence() {
  return {
    schemaVersion: CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
    certificationKind: CERTIFICATION_KINDS[1],
    result: CERTIFICATION_RESULTS[0],
    sourceCommitSha: SOURCE_SHA,
    contractVersions: { ...RELEASE_CERTIFICATION_CONTRACT_VERSIONS },
    repository: { owner: "yohn-jp", name: "gh-inari" },
    rootIssue: 405,
    change: { issue: 405, branch: "feat/405-certification", pullRequest: 999 },
    operations: completeOperations(),
    finalState: { status: "REVIEW", recovery: { state: "NONE", action: null } },
    diagnostics: [],
  };
}

function roundTrip(value) {
  return JSON.parse(serializeCertificationEvidence(value));
}

function verificationInput(packedEvidenceValue, dogfoodEvidenceValue) {
  return {
    expectedReleaseSourceCommitSha: SOURCE_SHA,
    expectedPackageName: PACKAGE.name,
    expectedPackageVersion: PACKAGE.version,
    expectedTarballSha256: PACKAGE.tarballSha256,
    expectedRepositoryOwner: "yohn-jp",
    expectedRepositoryName: "gh-inari",
    packedEvidence: packedEvidenceValue,
    dogfoodEvidence: dogfoodEvidenceValue,
  };
}

test("canonical producer documents are accepted by the release verifier", () => {
  const packed = roundTrip(packedEvidence());
  const dogfood = roundTrip(dogfoodEvidence());

  assert.equal(
    validateCertificationEvidence(packed, { contractVersions: RELEASE_CERTIFICATION_CONTRACT_VERSIONS }).valid,
    true,
  );
  assert.equal(validateSelfDogfoodEvidence(dogfood).valid, true);
  assert.deepEqual(verifyReleaseCertification(verificationInput(packed, dogfood)), {
    passed: true,
    diagnostics: [],
  });
});

test("canonical operation and version drift is rejected before release composition", () => {
  const packed = roundTrip(packedEvidence());
  const dogfood = roundTrip(dogfoodEvidence());
  const driftedOperations = dogfood.operations.map((entry, index) =>
    index === 5 ? { ...entry, outcome: "verified" } : entry,
  );
  const driftedDogfood = { ...dogfood, operations: driftedOperations };

  assert.throws(
    () => appendSelfDogfoodOperation([], SELF_DOGFOOD_OPERATION_REQUIREMENTS[1].operation, "verified"),
    CertificationEvidenceError,
  );
  assert.equal(validateSelfDogfoodEvidence(driftedDogfood).valid, false);
  assert.throws(() => serializeCertificationEvidence(driftedDogfood), CertificationEvidenceError);

  const operationResult = verifyReleaseCertification(verificationInput(packed, driftedDogfood));
  assert.equal(operationResult.passed, false);
  assert.ok(operationResult.diagnostics.some((diagnostic) => diagnostic.code === "DOGFOOD_OPERATION_OUTCOME_INVALID"));

  const stalePacked = { ...packed, contractVersions: { ...packed.contractVersions, skill: "stale" } };
  const versionResult = verifyReleaseCertification(verificationInput(stalePacked, dogfood));
  assert.equal(versionResult.passed, false);
  assert.ok(versionResult.diagnostics.some((diagnostic) => diagnostic.code === "CONTRACT_VERSION_MISMATCH"));
});
