import crypto from "node:crypto";
import fs from "node:fs";

/** Version of the evidence envelope shared by packed-artifact, dogfood, and release verification. */
export const CERTIFICATION_EVIDENCE_SCHEMA_VERSION = "1";
export const CERTIFICATION_KINDS = Object.freeze(["packed-artifact-golden-path", "self-dogfood-golden-path"]);
export const CERTIFICATION_RESULTS = Object.freeze(["passed", "failed", "blocked"]);

const CERTIFICATION_KIND_SET = new Set(CERTIFICATION_KINDS);
const CERTIFICATION_RESULT_SET = new Set(CERTIFICATION_RESULTS);
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const TARBALL_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DIAGNOSTIC_CODE_PATTERN = /^[A-Z][A-Z0-9_.-]{0,63}$/u;
const MAX_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 512;
const MAX_VERSION_LENGTH = 128;
const MAX_PACKAGE_NAME_LENGTH = 214;
const MAX_PACKAGE_VERSION_LENGTH = 256;

const COMMON_KEYS = new Set([
  "schemaVersion",
  "certificationKind",
  "result",
  "sourceCommitSha",
  "contractVersions",
  "diagnostics",
]);
const CONTRACT_VERSION_KEYS = new Set(["goldenPath", "statusRecovery", "skill"]);
const PACKED_KEYS = new Set(["name", "version", "tarballSha256"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownKeys(value) {
  return Object.keys(value);
}

function rejectUnknownKeys(value, allowed, path, errors) {
  for (const key of ownKeys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key}: unknown property`);
  }
}

function requireString(value, path, errors, { pattern, maxLength, nonEmpty = true } = {}) {
  if (typeof value !== "string") {
    errors.push(`${path}: must be a string`);
    return;
  }
  if (nonEmpty && value.length === 0) errors.push(`${path}: must not be empty`);
  if (maxLength !== undefined && value.length > maxLength)
    errors.push(`${path}: exceeds ${String(maxLength)} characters`);
  if (pattern !== undefined && !pattern.test(value)) errors.push(`${path}: has an invalid format`);
}

function validateDiagnostics(value, errors) {
  if (!Array.isArray(value)) {
    errors.push("$.diagnostics: must be an array");
    return [];
  }
  if (value.length > MAX_DIAGNOSTICS)
    errors.push(`$.diagnostics: must contain at most ${String(MAX_DIAGNOSTICS)} entries`);
  const normalized = [];
  for (let index = 0; index < value.length; index += 1) {
    const diagnostic = value[index];
    const path = `$.diagnostics[${String(index)}]`;
    if (!isRecord(diagnostic)) {
      errors.push(`${path}: must be an object`);
      continue;
    }
    rejectUnknownKeys(diagnostic, new Set(["code", "message"]), path, errors);
    requireString(diagnostic.code, `${path}.code`, errors, { pattern: DIAGNOSTIC_CODE_PATTERN, maxLength: 64 });
    requireString(diagnostic.message, `${path}.message`, errors, { maxLength: MAX_DIAGNOSTIC_MESSAGE_LENGTH });
    if (typeof diagnostic.code === "string" && typeof diagnostic.message === "string") {
      normalized.push({ code: diagnostic.code, message: diagnostic.message });
    }
  }
  return normalized;
}

function validateContractVersions(value, errors) {
  if (!isRecord(value)) {
    errors.push("$.contractVersions: must be an object");
    return;
  }
  rejectUnknownKeys(value, CONTRACT_VERSION_KEYS, "$.contractVersions", errors);
  for (const key of CONTRACT_VERSION_KEYS) {
    requireString(value[key], `$.contractVersions.${key}`, errors, { maxLength: MAX_VERSION_LENGTH });
    if (typeof value[key] === "string" && value[key].trim() !== value[key]) {
      errors.push(`$.contractVersions.${key}: must not have surrounding whitespace`);
    }
  }
}

function validatePackedExtension(value, errors) {
  if (!isRecord(value)) {
    errors.push("$.package: must be an object");
    return;
  }
  rejectUnknownKeys(value, PACKED_KEYS, "$.package", errors);
  requireString(value.name, "$.package.name", errors, { maxLength: MAX_PACKAGE_NAME_LENGTH });
  requireString(value.version, "$.package.version", errors, { maxLength: MAX_PACKAGE_VERSION_LENGTH });
  requireString(value.tarballSha256, "$.package.tarballSha256", errors, { pattern: TARBALL_SHA256_PATTERN });
}

/**
 * Validate a shared certification envelope. The returned errors are bounded by
 * the input shape and are intended for local diagnostics only; callers must not
 * treat an invalid envelope as certification evidence.
 */
export function validateCertificationEvidence(value, { certificationKind } = {}) {
  const errors = [];
  if (!isRecord(value)) {
    return { valid: false, errors: ["$: must be an object"] };
  }

  const allowedKeys = new Set(COMMON_KEYS);
  if (value.certificationKind === "packed-artifact-golden-path") allowedKeys.add("package");
  rejectUnknownKeys(value, allowedKeys, "$", errors);

  if (value.schemaVersion !== CERTIFICATION_EVIDENCE_SCHEMA_VERSION) {
    errors.push(`$.schemaVersion: must be exactly "${CERTIFICATION_EVIDENCE_SCHEMA_VERSION}"`);
  }
  if (!CERTIFICATION_KIND_SET.has(value.certificationKind)) errors.push("$.certificationKind: unsupported value");
  if (certificationKind !== undefined && value.certificationKind !== certificationKind)
    errors.push("$.certificationKind: does not match the expected certification kind");
  if (!CERTIFICATION_RESULT_SET.has(value.result)) errors.push("$.result: unsupported value");
  requireString(value.sourceCommitSha, "$.sourceCommitSha", errors, { pattern: SOURCE_SHA_PATTERN });
  validateContractVersions(value.contractVersions, errors);
  const diagnostics = validateDiagnostics(value.diagnostics, errors);

  if (value.certificationKind === "packed-artifact-golden-path") validatePackedExtension(value.package, errors);
  if (value.result === "passed" && Array.isArray(value.diagnostics) && value.diagnostics.length !== 0) {
    errors.push("$.diagnostics: must be empty when result is passed");
  }

  return {
    valid: errors.length === 0,
    errors,
    ...(errors.length === 0 ? { evidence: value, diagnostics } : {}),
  };
}

export class CertificationEvidenceError extends Error {
  constructor(errors) {
    super(`Invalid certification evidence: ${errors.join("; ")}`);
    this.name = "CertificationEvidenceError";
    this.errors = Object.freeze([...errors]);
  }
}

/** Fail-closed assertion used by evidence writers and release verifiers. */
export function assertCertificationEvidence(value, options) {
  const validation = validateCertificationEvidence(value, options);
  if (!validation.valid) throw new CertificationEvidenceError(validation.errors);
  return value;
}

/**
 * Rebuild the envelope in contract order before serializing. This prevents
 * object insertion order from making otherwise identical evidence differ.
 */
export function canonicalizeCertificationEvidence(value, options) {
  assertCertificationEvidence(value, options);
  const common = {
    schemaVersion: value.schemaVersion,
    certificationKind: value.certificationKind,
    result: value.result,
    sourceCommitSha: value.sourceCommitSha,
    contractVersions: {
      goldenPath: value.contractVersions.goldenPath,
      statusRecovery: value.contractVersions.statusRecovery,
      skill: value.contractVersions.skill,
    },
  };
  if (value.certificationKind === "packed-artifact-golden-path") {
    common.package = {
      name: value.package.name,
      version: value.package.version,
      tarballSha256: value.package.tarballSha256,
    };
  }
  common.diagnostics = value.diagnostics.map(({ code, message }) => ({ code, message }));
  return common;
}

export function serializeCertificationEvidence(value, options) {
  return `${JSON.stringify(canonicalizeCertificationEvidence(value, options))}\n`;
}

export function writeCertificationEvidence(filePath, value, options) {
  fs.writeFileSync(filePath, serializeCertificationEvidence(value, options), "utf8");
}

export function readCertificationEvidence(filePath, options) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new CertificationEvidenceError([
      `$: unable to parse evidence (${error instanceof Error ? error.message : String(error)})`,
    ]);
  }
  return assertCertificationEvidence(parsed, options);
}

export function sha256Tarball(filePath) {
  const digest = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  return `sha256:${digest}`;
}
