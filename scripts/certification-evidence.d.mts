export const CERTIFICATION_EVIDENCE_SCHEMA_VERSION: "1";
export type CertificationSchemaVersion = typeof CERTIFICATION_EVIDENCE_SCHEMA_VERSION;
export const CERTIFICATION_KINDS: readonly ["packed-artifact-golden-path", "self-dogfood-golden-path"];
export type CertificationKind = (typeof CERTIFICATION_KINDS)[number];
export const CERTIFICATION_RESULTS: readonly ["passed", "failed", "blocked"];
export type CertificationResult = (typeof CERTIFICATION_RESULTS)[number];
export const CERTIFICATION_CONTRACT_VERSION_KEYS: readonly ["goldenPath", "statusRecovery", "skill"];

export interface CertificationContractVersions {
  readonly goldenPath: string;
  readonly statusRecovery: string;
  readonly skill: string;
}

export const SELF_DOGFOOD_OPERATION_REQUIREMENTS: readonly {
  readonly operation: string;
  readonly outcomes: readonly string[];
}[];
export const SELF_DOGFOOD_RECOVERY_OPERATION: {
  readonly operation: string;
  readonly outcomes: readonly string[];
};
export const SELF_DOGFOOD_OUTCOMES: {
  readonly VERIFIED: "verified";
  readonly RETURNED_EXISTING: "returned-existing";
  readonly SUCCESS: "success";
};
export const SELF_DOGFOOD_OPERATIONS: {
  readonly OPT_IN: string;
  readonly EXECUTABLE: string;
  readonly SKILL: string;
  readonly GOVERNANCE: string;
  readonly FIRST_ISSUANCE: string;
  readonly RETURN_EXISTING: string;
  readonly HANDOFF: string;
  readonly WORKER: string;
  readonly FIRST_READY: string;
  readonly REREAD: string;
  readonly READY_RETRY: string;
  readonly ABORT: string;
};

export const MAX_CERTIFICATION_DIAGNOSTICS: 20;
export const MAX_CERTIFICATION_OPERATIONS: 32;
export const MAX_CERTIFICATION_DIAGNOSTIC_CODE_LENGTH: 128;
export const MAX_CERTIFICATION_DIAGNOSTIC_MESSAGE_LENGTH: 512;
export const MAX_CERTIFICATION_STRING_LENGTH: 512;

export interface CertificationDiagnostic {
  readonly code: string;
  readonly message: string;
}
export type CertificationDiagnosticCode =
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
  | "REPOSITORY_MISMATCH"
  | "DOGFOOD_IDENTITY_INVALID"
  | "DOGFOOD_OPERATION_MISSING"
  | "DOGFOOD_OPERATION_OUTCOME_INVALID"
  | "DOGFOOD_FINAL_STATE_INVALID";

export interface CertificationPackageEvidence {
  readonly name: string;
  readonly version: string;
  readonly tarballSha256: string;
}

export interface CertificationOperationEvidence {
  readonly operation: string;
  readonly outcome: string;
}

export interface CertificationRepositoryIdentity {
  readonly owner: string;
  readonly name: string;
}

export interface CertificationChangeIdentity {
  readonly issue: number;
  readonly branch: string;
  readonly pullRequest: number;
}

export interface CertificationRecoveryEvidence {
  readonly state: string;
  readonly action: string | null;
}

export interface CertificationFinalStateEvidence {
  readonly status: string;
  readonly recovery: CertificationRecoveryEvidence;
}

export interface CertificationEnvelopeBase {
  readonly schemaVersion: typeof CERTIFICATION_EVIDENCE_SCHEMA_VERSION;
  readonly certificationKind: CertificationKind;
  readonly result: CertificationResult;
  readonly sourceCommitSha: string;
  readonly contractVersions: CertificationContractVersions;
  readonly diagnostics: readonly CertificationDiagnostic[];
}

export interface PackedArtifactCertificationEvidence extends CertificationEnvelopeBase {
  readonly certificationKind: "packed-artifact-golden-path";
  readonly package: CertificationPackageEvidence;
}

export interface SelfDogfoodCertificationEvidence extends CertificationEnvelopeBase {
  readonly certificationKind: "self-dogfood-golden-path";
  readonly repository: CertificationRepositoryIdentity;
  readonly rootIssue: number;
  readonly change: CertificationChangeIdentity;
  readonly operations: readonly CertificationOperationEvidence[];
  readonly finalState: CertificationFinalStateEvidence;
}

export type CertificationEvidence = PackedArtifactCertificationEvidence | SelfDogfoodCertificationEvidence;

export interface CertificationValidationOptions {
  readonly certificationKind?: CertificationKind;
  readonly contractVersions?: CertificationContractVersions;
}

export interface CertificationValidationSuccess {
  readonly valid: true;
  readonly errors: readonly string[];
  readonly evidence: CertificationEvidence;
  readonly diagnostics: readonly CertificationDiagnostic[];
}

export interface CertificationValidationFailure {
  readonly valid: false;
  readonly errors: readonly string[];
  readonly diagnostics: readonly CertificationDiagnostic[];
}

export type CertificationValidationResult = CertificationValidationSuccess | CertificationValidationFailure;

export function validateCertificationEvidence(
  value: unknown,
  options?: CertificationValidationOptions,
): CertificationValidationResult;
export function validateSelfDogfoodEvidence(value: unknown): CertificationValidationResult;
export function validateDisposableGovernedIssue(value: unknown): CertificationValidationStatus;

export interface CertificationValidationStatus {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly diagnostics: readonly CertificationDiagnostic[];
}

export function appendSelfDogfoodOperation(
  operations: readonly CertificationOperationEvidence[],
  operation: string,
  outcome: string,
): readonly CertificationOperationEvidence[];
export function appendCertificationDiagnostic<T extends CertificationDiagnostic>(
  diagnostics: T[],
  code: string,
  message: string,
): void;

export function isCertificationBoundedString(value: unknown, maximum?: number): value is string;
export function isCertificationSourceCommitSha(value: unknown): value is string;
export function isCertificationTarballSha256(value: unknown): value is string;
export function isCertificationPackageName(value: unknown): value is string;
export function isCertificationRepositoryPart(value: unknown): value is string;
export function isCertificationReviewState(value: unknown): boolean;
export function isCertificationCompletedRecoveryState(value: unknown): boolean;

export class CertificationEvidenceError extends Error {
  readonly errors: readonly string[];
}

export function assertCertificationEvidence(
  value: unknown,
  options?: CertificationValidationOptions,
): CertificationEvidence;
export function canonicalizeCertificationEvidence(
  value: CertificationEvidence,
  options?: CertificationValidationOptions,
): CertificationEvidence;
export function serializeCertificationEvidence(
  value: CertificationEvidence,
  options?: CertificationValidationOptions,
): string;
export function writeCertificationEvidence(
  filePath: string,
  value: unknown,
  options?: CertificationValidationOptions,
): void;
export function readCertificationEvidence(
  filePath: string,
  options?: CertificationValidationOptions,
): CertificationEvidence;
export function sha256Tarball(filePath: string): string;
