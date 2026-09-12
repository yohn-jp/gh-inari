/**
 * Release-boundary certification composition.
 *
 * The serialized evidence contract is owned by
 * scripts/certification-evidence.mjs. This module only binds validated
 * evidence to the immutable release identity and checks that both required
 * certification lanes are present and complete.
 */

import { GOLDEN_PATH_STATUS_VERSION } from "./golden-path-status.js";
import { SKILL_MODEL_VERSION } from "./skill.js";
import {
  appendCertificationDiagnostic,
  CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
  CERTIFICATION_KINDS,
  CERTIFICATION_RESULTS,
  isCertificationBoundedString,
  isCertificationCompletedRecoveryState,
  isCertificationPackageName,
  isCertificationRepositoryPart,
  isCertificationReviewState,
  isCertificationSourceCommitSha,
  isCertificationTarballSha256,
  MAX_CERTIFICATION_DIAGNOSTIC_CODE_LENGTH,
  MAX_CERTIFICATION_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_CERTIFICATION_DIAGNOSTICS,
  MAX_CERTIFICATION_OPERATIONS,
  MAX_CERTIFICATION_STRING_LENGTH,
  SELF_DOGFOOD_OPERATION_REQUIREMENTS,
  SELF_DOGFOOD_RECOVERY_OPERATION,
  validateCertificationEvidence,
  type CertificationChangeIdentity,
  type CertificationContractVersions,
  type CertificationDiagnostic,
  type CertificationDiagnosticCode,
  type CertificationEnvelopeBase,
  type CertificationEvidence,
  type CertificationFinalStateEvidence,
  type CertificationOperationEvidence,
  type CertificationPackageEvidence,
  type CertificationRecoveryEvidence,
  type CertificationRepositoryIdentity,
  type CertificationSchemaVersion,
} from "../scripts/certification-evidence.mjs";

export const RELEASE_CERTIFICATION_SCHEMA_VERSION = CERTIFICATION_EVIDENCE_SCHEMA_VERSION;
export type ReleaseCertificationSchemaVersion = CertificationSchemaVersion;

export const RELEASE_CERTIFICATION_KINDS = CERTIFICATION_KINDS;
export type ReleaseCertificationKind = (typeof RELEASE_CERTIFICATION_KINDS)[number];

export const RELEASE_CERTIFICATION_RESULTS = CERTIFICATION_RESULTS;
export type ReleaseCertificationResult = (typeof RELEASE_CERTIFICATION_RESULTS)[number];

/**
 * Product contract versions are observed from their canonical authorities.
 * The evidence authority validates their shape and compares producer values
 * with this release-specific expected set.
 */
export const RELEASE_CERTIFICATION_CONTRACT_VERSIONS = Object.freeze({
  goldenPath: String(GOLDEN_PATH_STATUS_VERSION),
  statusRecovery: String(GOLDEN_PATH_STATUS_VERSION),
  skill: SKILL_MODEL_VERSION,
}) satisfies CertificationContractVersions;
export type ReleaseCertificationContractVersions = CertificationContractVersions;

// Compatibility exports retained while the canonical values live in the
// evidence authority.
export { SELF_DOGFOOD_OPERATION_REQUIREMENTS, SELF_DOGFOOD_RECOVERY_OPERATION };

// Backward-compatible names retained as aliases of the canonical bounds.
export const MAX_RELEASE_CERTIFICATION_DIAGNOSTICS = MAX_CERTIFICATION_DIAGNOSTICS;
export const MAX_RELEASE_CERTIFICATION_DIAGNOSTIC_CODE_LENGTH = MAX_CERTIFICATION_DIAGNOSTIC_CODE_LENGTH;
export const MAX_RELEASE_CERTIFICATION_DIAGNOSTIC_MESSAGE_LENGTH = MAX_CERTIFICATION_DIAGNOSTIC_MESSAGE_LENGTH;
export const MAX_RELEASE_CERTIFICATION_OPERATIONS = MAX_CERTIFICATION_OPERATIONS;
export const MAX_RELEASE_CERTIFICATION_STRING_LENGTH = MAX_CERTIFICATION_STRING_LENGTH;

export type ReleaseCertificationDiagnostic = CertificationDiagnostic;
export type ReleaseCertificationPackageEvidence = CertificationPackageEvidence;
export type ReleaseCertificationOperationEvidence = CertificationOperationEvidence;
export type SelfDogfoodOperationName = CertificationOperationEvidence["operation"];
export type SelfDogfoodOperationOutcome = CertificationOperationEvidence["outcome"];
export type ReleaseCertificationRepositoryIdentity = CertificationRepositoryIdentity;
export type ReleaseCertificationChangeIdentity = CertificationChangeIdentity;
export type SelfDogfoodRecoveryEvidence = CertificationRecoveryEvidence;
export type SelfDogfoodFinalStateEvidence = CertificationFinalStateEvidence;
export type ReleaseCertificationEnvelopeBase = CertificationEnvelopeBase;
export type PackedArtifactCertificationEvidence = Extract<
  CertificationEvidence,
  { readonly certificationKind: "packed-artifact-golden-path" }
>;
export type SelfDogfoodCertificationEvidence = Extract<
  CertificationEvidence,
  { readonly certificationKind: "self-dogfood-golden-path" }
>;
export type ReleaseCertificationEvidence = CertificationEvidence;

export interface ReleaseCertificationVerificationInput {
  readonly expectedReleaseSourceCommitSha: string;
  readonly expectedPackageName: string;
  readonly expectedPackageVersion: string;
  readonly expectedTarballSha256: string;
  readonly expectedRepositoryOwner: string;
  readonly expectedRepositoryName: string;
  readonly packedEvidence: unknown;
  readonly dogfoodEvidence: unknown;
}

export type ReleaseCertificationDiagnosticCode = CertificationDiagnosticCode;

export interface ReleaseCertificationVerificationDiagnostic extends CertificationDiagnostic {
  readonly code: ReleaseCertificationDiagnosticCode;
}

export interface ReleaseCertificationVerificationResult {
  readonly passed: boolean;
  readonly diagnostics: readonly ReleaseCertificationVerificationDiagnostic[];
}

function pushDiagnostic(
  diagnostics: ReleaseCertificationVerificationDiagnostic[],
  code: ReleaseCertificationDiagnosticCode,
  message: string,
): void {
  appendCertificationDiagnostic(diagnostics, code, message);
}

function validExpectedIdentity(input: ReleaseCertificationVerificationInput): boolean {
  return (
    isCertificationSourceCommitSha(input.expectedReleaseSourceCommitSha) &&
    isCertificationPackageName(input.expectedPackageName) &&
    isCertificationBoundedString(input.expectedPackageVersion, MAX_CERTIFICATION_STRING_LENGTH) &&
    isCertificationTarballSha256(input.expectedTarballSha256) &&
    isCertificationRepositoryPart(input.expectedRepositoryOwner) &&
    isCertificationRepositoryPart(input.expectedRepositoryName)
  );
}

function validatedEvidence(
  value: unknown,
  expectedKind: ReleaseCertificationKind,
  diagnostics: ReleaseCertificationVerificationDiagnostic[],
): CertificationEvidence | undefined {
  const validation = validateCertificationEvidence(value, {
    certificationKind: expectedKind,
    contractVersions: RELEASE_CERTIFICATION_CONTRACT_VERSIONS,
  });
  if (validation.valid) return validation.evidence;
  for (const diagnostic of validation.diagnostics) {
    pushDiagnostic(diagnostics, diagnostic.code as ReleaseCertificationDiagnosticCode, diagnostic.message);
  }
  return undefined;
}

function verifyEvidence(
  value: unknown,
  expectedKind: ReleaseCertificationKind,
  expected: ReleaseCertificationVerificationInput,
  diagnostics: ReleaseCertificationVerificationDiagnostic[],
): boolean {
  const evidence = validatedEvidence(value, expectedKind, diagnostics);
  if (evidence === undefined) return false;

  if (evidence.result !== CERTIFICATION_RESULTS[0]) {
    pushDiagnostic(diagnostics, "RESULT_NOT_PASSED", "Certification evidence did not pass.");
    return false;
  }
  if (evidence.sourceCommitSha !== expected.expectedReleaseSourceCommitSha) {
    pushDiagnostic(diagnostics, "SOURCE_SHA_MISMATCH", "Certification evidence source SHA does not match the release.");
    return false;
  }

  if (expectedKind === CERTIFICATION_KINDS[0]) {
    const packed = evidence as PackedArtifactCertificationEvidence;
    let valid = true;
    if (
      packed.package.name !== expected.expectedPackageName ||
      packed.package.version !== expected.expectedPackageVersion
    ) {
      pushDiagnostic(
        diagnostics,
        "PACKAGE_MISMATCH",
        "Packed certification package identity does not match the release.",
      );
      valid = false;
    }
    if (packed.package.tarballSha256 !== expected.expectedTarballSha256) {
      pushDiagnostic(
        diagnostics,
        "TARBALL_DIGEST_MISMATCH",
        "Packed certification tarball digest does not match the release.",
      );
      valid = false;
    }
    return valid;
  }

  const dogfood = evidence as SelfDogfoodCertificationEvidence;
  let valid = true;
  if (
    dogfood.repository.owner !== expected.expectedRepositoryOwner ||
    dogfood.repository.name !== expected.expectedRepositoryName
  ) {
    pushDiagnostic(
      diagnostics,
      "REPOSITORY_MISMATCH",
      "Self-dogfood repository does not match the release repository.",
    );
    valid = false;
  }
  if (!(isCertificationReviewState(dogfood.finalState) || isCertificationCompletedRecoveryState(dogfood.finalState))) {
    pushDiagnostic(
      diagnostics,
      "DOGFOOD_FINAL_STATE_INVALID",
      "A passed self-dogfood certification must finish in public REVIEW with no recovery required.",
    );
    valid = false;
  }
  return valid;
}

/**
 * Verify both complete Golden Path lanes against one immutable release
 * identity. Evidence schema, operation semantics, field validation, and
 * diagnostic bounds are delegated to the canonical evidence authority.
 */
export function verifyReleaseCertification(
  input: ReleaseCertificationVerificationInput,
): ReleaseCertificationVerificationResult {
  const diagnostics: ReleaseCertificationVerificationDiagnostic[] = [];
  if (!isRecord(input) || !validExpectedIdentity(input)) {
    pushDiagnostic(diagnostics, "EXPECTED_IDENTITY_INVALID", "Release identity inputs are malformed.");
    return { passed: false, diagnostics };
  }
  if (input.packedEvidence === undefined || input.packedEvidence === null) {
    pushDiagnostic(diagnostics, "EVIDENCE_MISSING", "Packed-artifact certification evidence is required.");
  } else {
    verifyEvidence(input.packedEvidence, CERTIFICATION_KINDS[0], input, diagnostics);
  }
  if (input.dogfoodEvidence === undefined || input.dogfoodEvidence === null) {
    pushDiagnostic(diagnostics, "EVIDENCE_MISSING", "Self-dogfood certification evidence is required.");
  } else {
    verifyEvidence(input.dogfoodEvidence, CERTIFICATION_KINDS[1], input, diagnostics);
  }
  return { passed: diagnostics.length === 0, diagnostics };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
