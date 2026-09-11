/**
 * Release-boundary certification evidence.
 *
 * This module is deliberately transport and workflow neutral.  The packed
 * and self-dogfood harnesses produce the evidence; a release workflow passes
 * it to `verifyReleaseCertification`.  No provider payload, mutable "last
 * green" pointer, or entry-only smoke result is accepted here.
 */

import { SKILL_MODEL_VERSION } from "./skill.js";

export const RELEASE_CERTIFICATION_SCHEMA_VERSION = "1" as const;
export type ReleaseCertificationSchemaVersion = typeof RELEASE_CERTIFICATION_SCHEMA_VERSION;

export const RELEASE_CERTIFICATION_KINDS = Object.freeze([
  "packed-artifact-golden-path",
  "self-dogfood-golden-path",
] as const);
export type ReleaseCertificationKind = (typeof RELEASE_CERTIFICATION_KINDS)[number];

export const RELEASE_CERTIFICATION_RESULTS = Object.freeze(["passed", "failed", "blocked"] as const);
export type ReleaseCertificationResult = (typeof RELEASE_CERTIFICATION_RESULTS)[number];

/**
 * These are the only contract versions accepted by this verifier.  They are
 * strings in the serialized envelope so producers cannot accidentally mix
 * JSON number and string representations of the same contract version.
 *
 * Golden Path and status/recovery are v1 in the public architecture contract;
 * Skill uses the version exposed by the existing Skill authority.
 */
export const RELEASE_CERTIFICATION_CONTRACT_VERSIONS = Object.freeze({
  goldenPath: "1",
  statusRecovery: "1",
  skill: SKILL_MODEL_VERSION,
} as const);
export type ReleaseCertificationContractVersions = typeof RELEASE_CERTIFICATION_CONTRACT_VERSIONS;

export const MAX_RELEASE_CERTIFICATION_DIAGNOSTICS = 20 as const;
export const MAX_RELEASE_CERTIFICATION_DIAGNOSTIC_CODE_LENGTH = 128 as const;
export const MAX_RELEASE_CERTIFICATION_DIAGNOSTIC_MESSAGE_LENGTH = 512 as const;
export const MAX_RELEASE_CERTIFICATION_OPERATIONS = 32 as const;
export const MAX_RELEASE_CERTIFICATION_STRING_LENGTH = 512 as const;

export interface ReleaseCertificationDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface ReleaseCertificationPackageEvidence {
  readonly name: string;
  readonly version: string;
  readonly tarballSha256: string;
}

export interface ReleaseCertificationOperationEvidence {
  readonly name: string;
  readonly outcome: string;
}

export interface ReleaseCertificationRepositoryIdentity {
  readonly owner: string;
  readonly name: string;
}

export interface ReleaseCertificationChangeIdentity {
  readonly issue: number;
  readonly branch: string;
  readonly pullRequest: number;
}

export interface ReleaseCertificationEnvelopeBase {
  readonly schemaVersion: ReleaseCertificationSchemaVersion;
  readonly certificationKind: ReleaseCertificationKind;
  readonly result: ReleaseCertificationResult;
  readonly sourceCommitSha: string;
  readonly contractVersions: ReleaseCertificationContractVersions;
  readonly diagnostics: readonly ReleaseCertificationDiagnostic[];
}

export interface PackedArtifactCertificationEvidence extends ReleaseCertificationEnvelopeBase {
  readonly certificationKind: "packed-artifact-golden-path";
  readonly package: ReleaseCertificationPackageEvidence;
}

export interface SelfDogfoodCertificationEvidence extends ReleaseCertificationEnvelopeBase {
  readonly certificationKind: "self-dogfood-golden-path";
  readonly repository: ReleaseCertificationRepositoryIdentity;
  readonly rootIssue: number;
  readonly change: ReleaseCertificationChangeIdentity;
  readonly operations: readonly ReleaseCertificationOperationEvidence[];
  readonly finalState: "REVIEW" | "RECOVERY_REQUIRED";
}

export type ReleaseCertificationEvidence = PackedArtifactCertificationEvidence | SelfDogfoodCertificationEvidence;

export interface ReleaseCertificationVerificationInput {
  readonly expectedReleaseSourceCommitSha: string;
  readonly expectedPackageName: string;
  readonly expectedPackageVersion: string;
  readonly expectedTarballSha256: string;
  readonly packedEvidence: unknown;
  readonly dogfoodEvidence: unknown;
}

export type ReleaseCertificationDiagnosticCode =
  | "EXPECTED_IDENTITY_INVALID"
  | "EVIDENCE_MISSING"
  | "EVIDENCE_MALFORMED"
  | "SCHEMA_UNSUPPORTED"
  | "KIND_MISMATCH"
  | "RESULT_NOT_PASSED"
  | "SOURCE_SHA_MISMATCH"
  | "CONTRACT_VERSION_MISMATCH"
  | "PACKAGE_MISMATCH"
  | "TARBALL_DIGEST_MISMATCH"
  | "DOGFOOD_IDENTITY_INVALID"
  | "DOGFOOD_FINAL_STATE_INVALID";

export interface ReleaseCertificationVerificationDiagnostic extends ReleaseCertificationDiagnostic {
  readonly code: ReleaseCertificationDiagnosticCode;
}

export interface ReleaseCertificationVerificationResult {
  readonly passed: boolean;
  readonly diagnostics: readonly ReleaseCertificationVerificationDiagnostic[];
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const EVIDENCE_KEYS = new Set([
  "schemaVersion",
  "certificationKind",
  "result",
  "sourceCommitSha",
  "contractVersions",
  "diagnostics",
  "package",
  "repository",
  "rootIssue",
  "change",
  "operations",
  "finalState",
]);
const CONTRACT_VERSION_KEYS = new Set(["goldenPath", "statusRecovery", "skill"]);
const DIAGNOSTIC_KEYS = new Set(["code", "message"]);
const PACKAGE_KEYS = new Set(["name", "version", "tarballSha256"]);
const REPOSITORY_KEYS = new Set(["owner", "name"]);
const CHANGE_KEYS = new Set(["issue", "branch", "pullRequest"]);
const OPERATION_KEYS = new Set(["name", "outcome"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function isBoundedString(value: unknown, maximum: number = MAX_RELEASE_CERTIFICATION_STRING_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function pushDiagnostic(
  diagnostics: ReleaseCertificationVerificationDiagnostic[],
  code: ReleaseCertificationDiagnosticCode,
  message: string,
): void {
  if (diagnostics.length < MAX_RELEASE_CERTIFICATION_DIAGNOSTICS) diagnostics.push({ code, message });
}

function validExpectedIdentity(input: ReleaseCertificationVerificationInput): boolean {
  return (
    typeof input.expectedReleaseSourceCommitSha === "string" &&
    SOURCE_SHA_PATTERN.test(input.expectedReleaseSourceCommitSha) &&
    isBoundedString(input.expectedPackageName) &&
    PACKAGE_NAME_PATTERN.test(input.expectedPackageName) &&
    isBoundedString(input.expectedPackageVersion) &&
    typeof input.expectedTarballSha256 === "string" &&
    SHA256_PATTERN.test(input.expectedTarballSha256)
  );
}

function validateDiagnostics(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_RELEASE_CERTIFICATION_DIAGNOSTICS) return false;
  return value.every((diagnostic) => {
    if (!isRecord(diagnostic) || !hasOnlyKeys(diagnostic, DIAGNOSTIC_KEYS)) return false;
    return (
      isBoundedString(diagnostic.code, MAX_RELEASE_CERTIFICATION_DIAGNOSTIC_CODE_LENGTH) &&
      isBoundedString(diagnostic.message, MAX_RELEASE_CERTIFICATION_DIAGNOSTIC_MESSAGE_LENGTH)
    );
  });
}

function validateContractVersions(value: unknown): value is ReleaseCertificationContractVersions {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, CONTRACT_VERSION_KEYS) &&
    value.goldenPath === RELEASE_CERTIFICATION_CONTRACT_VERSIONS.goldenPath &&
    value.statusRecovery === RELEASE_CERTIFICATION_CONTRACT_VERSIONS.statusRecovery &&
    value.skill === RELEASE_CERTIFICATION_CONTRACT_VERSIONS.skill
  );
}

function validateEnvelope(
  value: unknown,
  expectedKind: ReleaseCertificationKind,
  diagnostics: ReleaseCertificationVerificationDiagnostic[],
): value is ReleaseCertificationEvidence {
  if (!isRecord(value)) {
    pushDiagnostic(diagnostics, "EVIDENCE_MALFORMED", "Certification evidence must be a JSON object.");
    return false;
  }
  if (!hasOnlyKeys(value, EVIDENCE_KEYS)) {
    pushDiagnostic(diagnostics, "EVIDENCE_MALFORMED", "Certification evidence contains unknown fields.");
    return false;
  }
  if (typeof value.schemaVersion !== "string") {
    pushDiagnostic(diagnostics, "EVIDENCE_MALFORMED", "Certification evidence schemaVersion is missing or malformed.");
    return false;
  }
  if (value.schemaVersion !== RELEASE_CERTIFICATION_SCHEMA_VERSION) {
    pushDiagnostic(diagnostics, "SCHEMA_UNSUPPORTED", "Certification evidence schema version is unsupported.");
    return false;
  }
  if (value.certificationKind !== expectedKind) {
    pushDiagnostic(diagnostics, "KIND_MISMATCH", "Certification evidence kind does not match the required lane.");
    return false;
  }
  if (!RELEASE_CERTIFICATION_RESULTS.includes(value.result as ReleaseCertificationResult)) {
    pushDiagnostic(diagnostics, "EVIDENCE_MALFORMED", "Certification evidence result is unknown.");
    return false;
  }
  if (typeof value.sourceCommitSha !== "string" || !SOURCE_SHA_PATTERN.test(value.sourceCommitSha)) {
    pushDiagnostic(diagnostics, "EVIDENCE_MALFORMED", "Certification evidence sourceCommitSha is invalid.");
    return false;
  }
  if (!validateContractVersions(value.contractVersions)) {
    pushDiagnostic(diagnostics, "CONTRACT_VERSION_MISMATCH", "Certification evidence contract versions are not known.");
    return false;
  }
  if (!validateDiagnostics(value.diagnostics)) {
    pushDiagnostic(diagnostics, "EVIDENCE_MALFORMED", "Certification evidence diagnostics are missing or unbounded.");
    return false;
  }
  return true;
}

function validatePackedExtension(
  value: unknown,
  expected: ReleaseCertificationVerificationInput,
  diagnostics: ReleaseCertificationVerificationDiagnostic[],
): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, PACKAGE_KEYS)) {
    pushDiagnostic(diagnostics, "EVIDENCE_MALFORMED", "Packed certification package evidence is malformed.");
    return false;
  }
  if (
    !isBoundedString(value.name) ||
    !PACKAGE_NAME_PATTERN.test(value.name) ||
    !isBoundedString(value.version) ||
    typeof value.tarballSha256 !== "string" ||
    !SHA256_PATTERN.test(value.tarballSha256)
  ) {
    pushDiagnostic(diagnostics, "EVIDENCE_MALFORMED", "Packed certification package identity is malformed.");
    return false;
  }
  let valid = true;
  if (value.name !== expected.expectedPackageName || value.version !== expected.expectedPackageVersion) {
    pushDiagnostic(
      diagnostics,
      "PACKAGE_MISMATCH",
      "Packed certification package identity does not match the release.",
    );
    valid = false;
  }
  if (value.tarballSha256 !== expected.expectedTarballSha256) {
    pushDiagnostic(
      diagnostics,
      "TARBALL_DIGEST_MISMATCH",
      "Packed certification tarball digest does not match the release.",
    );
    valid = false;
  }
  return valid;
}

function validateDogfoodExtension(value: unknown, diagnostics: ReleaseCertificationVerificationDiagnostic[]): boolean {
  if (!isRecord(value)) {
    pushDiagnostic(diagnostics, "DOGFOOD_IDENTITY_INVALID", "Self-dogfood evidence is malformed.");
    return false;
  }
  const repository = value.repository;
  const change = value.change;
  const operations = value.operations;
  if (
    !isRecord(repository) ||
    !hasOnlyKeys(repository, REPOSITORY_KEYS) ||
    !isBoundedString(repository.owner) ||
    !isBoundedString(repository.name) ||
    typeof value.rootIssue !== "number" ||
    !Number.isSafeInteger(value.rootIssue) ||
    value.rootIssue <= 0 ||
    !isRecord(change) ||
    !hasOnlyKeys(change, CHANGE_KEYS) ||
    typeof change.issue !== "number" ||
    !Number.isSafeInteger(change.issue) ||
    change.issue <= 0 ||
    !isBoundedString(change.branch) ||
    typeof change.pullRequest !== "number" ||
    !Number.isSafeInteger(change.pullRequest) ||
    change.pullRequest <= 0 ||
    !Array.isArray(operations) ||
    operations.length === 0 ||
    operations.length > MAX_RELEASE_CERTIFICATION_OPERATIONS ||
    !operations.every(
      (operation) =>
        isRecord(operation) &&
        hasOnlyKeys(operation, OPERATION_KEYS) &&
        isBoundedString(operation.name) &&
        isBoundedString(operation.outcome),
    )
  ) {
    pushDiagnostic(
      diagnostics,
      "DOGFOOD_IDENTITY_INVALID",
      "Self-dogfood identity or bounded operations are malformed.",
    );
    return false;
  }
  if (value.finalState !== "REVIEW" && value.finalState !== "RECOVERY_REQUIRED") {
    pushDiagnostic(
      diagnostics,
      "DOGFOOD_FINAL_STATE_INVALID",
      "Self-dogfood final state is not a governed review or recovery state.",
    );
    return false;
  }
  return true;
}

function verifyEvidence(
  value: unknown,
  expectedKind: ReleaseCertificationKind,
  expected: ReleaseCertificationVerificationInput,
  diagnostics: ReleaseCertificationVerificationDiagnostic[],
): value is ReleaseCertificationEvidence {
  if (!validateEnvelope(value, expectedKind, diagnostics)) return false;
  if (value.result !== "passed") {
    pushDiagnostic(diagnostics, "RESULT_NOT_PASSED", "Certification evidence did not pass.");
    return false;
  }
  if (value.sourceCommitSha !== expected.expectedReleaseSourceCommitSha) {
    pushDiagnostic(diagnostics, "SOURCE_SHA_MISMATCH", "Certification evidence source SHA does not match the release.");
    return false;
  }
  if (expectedKind === "packed-artifact-golden-path") {
    return validatePackedExtension((value as PackedArtifactCertificationEvidence).package, expected, diagnostics);
  }
  return validateDogfoodExtension(value, diagnostics);
}

/**
 * Verify both complete Golden Path lanes against one immutable release
 * identity.  Diagnostics are ordered packed-then-dogfood and capped at 20,
 * making the result safe for workflow logs and deterministic for tests.
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
    verifyEvidence(input.packedEvidence, "packed-artifact-golden-path", input, diagnostics);
  }
  if (input.dogfoodEvidence === undefined || input.dogfoodEvidence === null) {
    pushDiagnostic(diagnostics, "EVIDENCE_MISSING", "Self-dogfood certification evidence is required.");
  } else {
    verifyEvidence(input.dogfoodEvidence, "self-dogfood-golden-path", input, diagnostics);
  }
  return { passed: diagnostics.length === 0, diagnostics };
}
