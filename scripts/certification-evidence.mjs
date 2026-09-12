import crypto from "node:crypto";
import fs from "node:fs";

/**
 * Versioned evidence authority shared by the packed, dogfood, and release
 * certification lanes. Only a complete passed envelope is release evidence.
 */
export const CERTIFICATION_EVIDENCE_SCHEMA_VERSION = "1";
export const CERTIFICATION_KINDS = Object.freeze(["packed-artifact-golden-path", "self-dogfood-golden-path"]);
export const CERTIFICATION_RESULTS = Object.freeze(["passed", "failed", "blocked"]);
/** Contract fields recorded by a producer; values come from that artifact's authorities. */
export const CERTIFICATION_CONTRACT_VERSION_KEYS = Object.freeze(["goldenPath", "statusRecovery", "skill"]);

export const SELF_DOGFOOD_OPERATION_REQUIREMENTS = Object.freeze([
  Object.freeze({ operation: "preflight.opt-in", outcomes: Object.freeze(["verified"]) }),
  Object.freeze({ operation: "preflight.installed-executable", outcomes: Object.freeze(["verified"]) }),
  Object.freeze({ operation: "skill.golden-path", outcomes: Object.freeze(["verified"]) }),
  Object.freeze({ operation: "disposable-issue.governance-check", outcomes: Object.freeze(["verified"]) }),
  Object.freeze({ operation: "change.issue.first", outcomes: Object.freeze(["verified"]) }),
  Object.freeze({ operation: "change.issue.return-existing", outcomes: Object.freeze(["returned-existing"]) }),
  Object.freeze({ operation: "change.handoff", outcomes: Object.freeze(["verified"]) }),
  Object.freeze({ operation: "worker.implementation", outcomes: Object.freeze(["success"]) }),
  Object.freeze({ operation: "change.ready.first", outcomes: Object.freeze(["verified"]) }),
  Object.freeze({ operation: "change.ready.reread", outcomes: Object.freeze(["verified"]) }),
  Object.freeze({
    operation: "change.ready.retry",
    outcomes: Object.freeze(["verified", "returned-existing"]),
  }),
]);
export const SELF_DOGFOOD_RECOVERY_OPERATION = Object.freeze({
  operation: "change.abort.recovery",
  outcomes: Object.freeze(["verified"]),
});

const CERTIFICATION_KIND_SET = new Set(CERTIFICATION_KINDS);
const CERTIFICATION_RESULT_SET = new Set(CERTIFICATION_RESULTS);
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const TARBALL_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const DIAGNOSTIC_CODE_PATTERN = /^[A-Z][A-Z0-9_.-]{0,127}$/u;
const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;
const BRANCH_PATTERN = /^[^\u0000-\u001F\u007F]{1,512}$/u;
const MAX_DIAGNOSTICS = 20;
const MAX_OPERATIONS = 32;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 512;
const MAX_STRING_LENGTH = 512;
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
const PACKED_KEYS = new Set([...COMMON_KEYS, "package"]);
const DOGFOOD_KEYS = new Set([...COMMON_KEYS, "repository", "rootIssue", "change", "operations", "finalState"]);
const CONTRACT_VERSION_KEYS = new Set(CERTIFICATION_CONTRACT_VERSION_KEYS);
const PACKAGE_KEYS = new Set(["name", "version", "tarballSha256"]);
const REPOSITORY_KEYS = new Set(["owner", "name"]);
const CHANGE_KEYS = new Set(["issue", "branch", "pullRequest"]);
const OPERATION_KEYS = new Set(["operation", "outcome"]);
const FINAL_STATE_KEYS = new Set(["status", "recovery"]);
const RECOVERY_KEYS = new Set(["state", "action"]);
const OPERATION_REQUIREMENT_MAP = new Map(
  SELF_DOGFOOD_OPERATION_REQUIREMENTS.map((entry) => [entry.operation, entry.outcomes]),
);
const RECOVERY_OPERATION_OUTCOMES = new Set(SELF_DOGFOOD_RECOVERY_OPERATION.outcomes);
const RECOVERY_NONE_STATES = new Set(["NONE", "none", "NOT_REQUIRED", "not-required"]);
const RECOVERY_REQUIRED_STATES = new Set(["RECOVERY_REQUIRED", "recovery-required"]);
const RECOVERY_COMPLETED_STATES = new Set(["COMPLETED", "completed"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key}: unknown property`);
  }
}

function requireString(value, path, errors, { pattern, maxLength = MAX_STRING_LENGTH, nonEmpty = true } = {}) {
  if (typeof value !== "string") {
    errors.push(`${path}: must be a string`);
    return false;
  }
  if (nonEmpty && value.length === 0) errors.push(`${path}: must not be empty`);
  if (value.length > maxLength) errors.push(`${path}: exceeds ${String(maxLength)} characters`);
  if (pattern !== undefined && !pattern.test(value)) errors.push(`${path}: has an invalid format`);
  if (/[\u0000-\u001F\u007F]/u.test(value)) errors.push(`${path}: contains control characters`);
  return true;
}

function requirePositiveInteger(value, path, errors) {
  if (!Number.isSafeInteger(value) || value < 1) {
    errors.push(`${path}: must be a positive integer`);
    return false;
  }
  return true;
}

function validateDiagnostics(value, errors) {
  if (!Array.isArray(value)) {
    errors.push("$.diagnostics: must be an array");
    return [];
  }
  if (value.length > MAX_DIAGNOSTICS)
    errors.push(`$.diagnostics: must contain at most ${String(MAX_DIAGNOSTICS)} entries`);
  const normalized = [];
  for (let index = 0; index < value.length && normalized.length < MAX_DIAGNOSTICS; index += 1) {
    const diagnostic = value[index];
    const path = `$.diagnostics[${String(index)}]`;
    if (!isRecord(diagnostic)) {
      errors.push(`${path}: must be an object`);
      continue;
    }
    rejectUnknownKeys(diagnostic, new Set(["code", "message"]), path, errors);
    const codeValid = requireString(diagnostic.code, `${path}.code`, errors, {
      pattern: DIAGNOSTIC_CODE_PATTERN,
      maxLength: 128,
    });
    const messageValid = requireString(diagnostic.message, `${path}.message`, errors, {
      maxLength: MAX_DIAGNOSTIC_MESSAGE_LENGTH,
    });
    if (codeValid && messageValid) normalized.push({ code: diagnostic.code, message: diagnostic.message });
  }
  return normalized;
}

function validateContractVersions(value, errors, { expected } = {}) {
  if (!isRecord(value)) {
    errors.push("$.contractVersions: must be an object");
    return false;
  }
  rejectUnknownKeys(value, CONTRACT_VERSION_KEYS, "$.contractVersions", errors);
  let valid = true;
  for (const key of CONTRACT_VERSION_KEYS) {
    if (!requireString(value[key], `$.contractVersions.${key}`, errors)) valid = false;
    if (typeof value[key] === "string" && value[key].trim() !== value[key]) {
      errors.push(`$.contractVersions.${key}: must not have surrounding whitespace`);
      valid = false;
    }
    if (expected !== undefined && value[key] !== expected[key]) {
      errors.push(`$.contractVersions.${key}: unknown or stale contract version`);
      valid = false;
    }
  }
  return valid;
}

function validatePackedExtension(value, errors) {
  if (!isRecord(value)) {
    errors.push("$.package: must be an object");
    return false;
  }
  rejectUnknownKeys(value, PACKAGE_KEYS, "$.package", errors);
  let valid = true;
  valid =
    requireString(value.name, "$.package.name", errors, {
      pattern: PACKAGE_NAME_PATTERN,
      maxLength: MAX_PACKAGE_NAME_LENGTH,
    }) && valid;
  valid =
    requireString(value.version, "$.package.version", errors, {
      maxLength: MAX_PACKAGE_VERSION_LENGTH,
    }) && valid;
  valid =
    requireString(value.tarballSha256, "$.package.tarballSha256", errors, {
      pattern: TARBALL_SHA256_PATTERN,
      maxLength: 71,
    }) && valid;
  return valid;
}

function validateRepository(value, errors) {
  if (!isRecord(value)) {
    errors.push("$.repository: must be an object");
    return false;
  }
  rejectUnknownKeys(value, REPOSITORY_KEYS, "$.repository", errors);
  return (
    requireString(value.owner, "$.repository.owner", errors, { pattern: REPOSITORY_PART_PATTERN, maxLength: 128 }) &&
    requireString(value.name, "$.repository.name", errors, { pattern: REPOSITORY_PART_PATTERN, maxLength: 128 })
  );
}

function validateChangeIdentity(value, rootIssue, errors) {
  if (!isRecord(value)) {
    errors.push("$.change: must be an object");
    return false;
  }
  rejectUnknownKeys(value, CHANGE_KEYS, "$.change", errors);
  const issueValid = requirePositiveInteger(value.issue, "$.change.issue", errors);
  const branchValid = requireString(value.branch, "$.change.branch", errors, { pattern: BRANCH_PATTERN });
  const pullRequestValid = requirePositiveInteger(value.pullRequest, "$.change.pullRequest", errors);
  if (rootIssue !== undefined && value.issue !== rootIssue) errors.push("$.change.issue: must match $.rootIssue");
  return issueValid && branchValid && pullRequestValid;
}

function validateOperationEntries(value, errors, { strictSequence = false, finalStatus } = {}) {
  if (!Array.isArray(value)) {
    errors.push("$.operations: must be an array");
    return false;
  }
  if (value.length > MAX_OPERATIONS)
    errors.push(`$.operations: must contain at most ${String(MAX_OPERATIONS)} entries`);
  let valid = true;
  const names = [];
  for (let index = 0; index < value.length && index < MAX_OPERATIONS; index += 1) {
    const entry = value[index];
    const path = `$.operations[${String(index)}]`;
    if (!isRecord(entry)) {
      errors.push(`${path}: must be an object`);
      valid = false;
      continue;
    }
    rejectUnknownKeys(entry, OPERATION_KEYS, path, errors);
    const operationValid = requireString(entry.operation, `${path}.operation`, errors, { maxLength: 128 });
    const outcomeValid = requireString(entry.outcome, `${path}.outcome`, errors, { maxLength: 128 });
    if (!operationValid || !outcomeValid) {
      valid = false;
      continue;
    }
    names.push(entry.operation);
    const outcomes =
      entry.operation === SELF_DOGFOOD_RECOVERY_OPERATION.operation
        ? RECOVERY_OPERATION_OUTCOMES
        : new Set(OPERATION_REQUIREMENT_MAP.get(entry.operation) ?? []);
    if (outcomes.size === 0 || !outcomes.has(entry.outcome)) {
      errors.push(`${path}: unsupported operation outcome`);
      valid = false;
    }
  }
  if (strictSequence) {
    const required = SELF_DOGFOOD_OPERATION_REQUIREMENTS.map((entry) => entry.operation);
    const expected = finalStatus === "ABORTED" ? [...required, SELF_DOGFOOD_RECOVERY_OPERATION.operation] : required;
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
      errors.push("$.operations: required operation sequence is incomplete or out of order");
      valid = false;
    }
  }
  return valid;
}

function validateFinalState(value, errors, { allowUnavailable = false } = {}) {
  if (!isRecord(value)) {
    errors.push("$.finalState: must be an object");
    return false;
  }
  rejectUnknownKeys(value, FINAL_STATE_KEYS, "$.finalState", errors);
  const allowedStatuses = allowUnavailable
    ? new Set(["REVIEW", "RECOVERY_REQUIRED", "ABORTED", "UNAVAILABLE"])
    : new Set(["REVIEW", "RECOVERY_REQUIRED", "ABORTED"]);
  if (!allowedStatuses.has(value.status)) errors.push("$.finalState.status: unsupported value");
  if (!isRecord(value.recovery)) {
    errors.push("$.finalState.recovery: must be an object");
    return false;
  }
  rejectUnknownKeys(value.recovery, RECOVERY_KEYS, "$.finalState.recovery", errors);
  let valid = allowedStatuses.has(value.status);
  if (!requireString(value.recovery.state, "$.finalState.recovery.state", errors, { maxLength: 64 })) valid = false;
  if (value.recovery.action !== null && !requireString(value.recovery.action, "$.finalState.recovery.action", errors)) {
    valid = false;
  }
  if (value.status === "REVIEW") {
    if (!RECOVERY_NONE_STATES.has(value.recovery.state)) {
      errors.push("$.finalState.recovery.state: REVIEW requires no recovery");
      valid = false;
    }
    if (value.recovery.action !== null && value.recovery.action !== "none") {
      errors.push("$.finalState.recovery.action: REVIEW requires null or none");
      valid = false;
    }
  }
  if (value.status === "RECOVERY_REQUIRED") {
    if (!RECOVERY_REQUIRED_STATES.has(value.recovery.state) || typeof value.recovery.action !== "string") {
      errors.push("$.finalState.recovery: RECOVERY_REQUIRED requires a recovery action");
      valid = false;
    }
  }
  if (value.status === "ABORTED") {
    if (!RECOVERY_COMPLETED_STATES.has(value.recovery.state) || value.recovery.action !== "none") {
      errors.push("$.finalState.recovery: ABORTED requires completed recovery");
      valid = false;
    }
  }
  return valid;
}

function validateDogfoodExtension(value, errors, { strict = false } = {}) {
  if (!isRecord(value)) {
    errors.push("$: self-dogfood evidence must be an object");
    return false;
  }
  const repositoryValid = validateRepository(value.repository, errors);
  const rootIssueValid = requirePositiveInteger(value.rootIssue, "$.rootIssue", errors);
  const changeValid = validateChangeIdentity(value.change, value.rootIssue, errors);
  const operationsValid = validateOperationEntries(value.operations, errors, {
    strictSequence: strict,
    finalStatus: value.finalState?.status,
  });
  const finalStateValid = validateFinalState(value.finalState, errors, { allowUnavailable: !strict });
  return repositoryValid && rootIssueValid && changeValid && operationsValid && finalStateValid;
}

function validateSharedEnvelope(value, { certificationKind, expectedContractVersions } = {}) {
  const errors = [];
  if (!isRecord(value)) return { valid: false, errors: ["$: must be an object"] };
  const kind = value.certificationKind;
  const allowedKeys =
    kind === "packed-artifact-golden-path"
      ? PACKED_KEYS
      : kind === "self-dogfood-golden-path"
        ? DOGFOOD_KEYS
        : COMMON_KEYS;
  rejectUnknownKeys(value, allowedKeys, "$", errors);
  if (value.schemaVersion !== CERTIFICATION_EVIDENCE_SCHEMA_VERSION)
    errors.push(`$.schemaVersion: must be exactly "${CERTIFICATION_EVIDENCE_SCHEMA_VERSION}"`);
  if (!CERTIFICATION_KIND_SET.has(kind)) errors.push("$.certificationKind: unsupported value");
  if (certificationKind !== undefined && kind !== certificationKind)
    errors.push("$.certificationKind: does not match the expected certification kind");
  if (!CERTIFICATION_RESULT_SET.has(value.result)) errors.push("$.result: unsupported value");
  requireString(value.sourceCommitSha, "$.sourceCommitSha", errors, { pattern: SOURCE_SHA_PATTERN, maxLength: 40 });
  validateContractVersions(value.contractVersions, errors, { expected: expectedContractVersions });
  validateDiagnostics(value.diagnostics, errors);
  if (value.result === "passed" && Array.isArray(value.diagnostics) && value.diagnostics.length !== 0) {
    errors.push("$.diagnostics: must be empty when result is passed");
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate the shared envelope. Contract versions are observed values from
 * the producer's exact artifact; callers may optionally provide expected
 * values when comparing two independently obtained envelopes. This avoids
 * baking a product Skill version into the evidence authority.
 */
export function validateCertificationEvidence(value, { certificationKind, contractVersions } = {}) {
  const strict = value?.result === "passed";
  const envelope = validateSharedEnvelope(value, { certificationKind, expectedContractVersions: contractVersions });
  const errors = envelope.errors;
  if (!envelope.valid) return { valid: false, errors };
  if (value.certificationKind === "packed-artifact-golden-path") {
    if (value.result === "blocked") errors.push("$.result: packed certification cannot be blocked");
    validatePackedExtension(value.package, errors);
  } else if (value.certificationKind === "self-dogfood-golden-path") {
    validateDogfoodExtension(value, errors, { strict });
  }
  return {
    valid: errors.length === 0,
    errors,
    ...(errors.length === 0 ? { evidence: value, diagnostics: value.diagnostics } : {}),
  };
}

/** Authority entry consumed by the explicit self-dogfood harness. */
export function validateSelfDogfoodEvidence(value) {
  return validateCertificationEvidence(value, { certificationKind: "self-dogfood-golden-path" });
}

/**
 * Validate the product's disposable-Issue check result. The marker is
 * product-owned; this authority only confirms the bounded, explicit opt-in
 * projection and never infers disposability from an Issue number or title.
 */
export function validateDisposableGovernedIssue(value) {
  const errors = [];
  if (!isRecord(value)) return { valid: false, errors: ["$: Issue check result must be an object"] };
  if (value.ok !== true && value.valid !== true) errors.push("$.ok: governed Issue check did not pass");
  if (
    !isRecord(value.disposableMarker) ||
    value.disposableMarker.version !== 1 ||
    value.disposableMarker.kind !== "self-dogfood"
  ) {
    errors.push("$.disposableMarker: explicit self-dogfood marker is required");
  }
  if (value.governance !== undefined && (!isRecord(value.governance) || value.governance.valid !== true)) {
    errors.push("$.governance: governed Issue contract check did not pass");
  }
  return { valid: errors.length === 0, errors };
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

/** Rebuild the envelope in contract order before serializing. */
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
  } else {
    common.repository = { owner: value.repository.owner, name: value.repository.name };
    common.rootIssue = value.rootIssue;
    common.change = {
      issue: value.change.issue,
      branch: value.change.branch,
      pullRequest: value.change.pullRequest,
    };
    common.operations = value.operations.map(({ operation, outcome }) => ({ operation, outcome }));
    common.finalState = {
      status: value.finalState.status,
      recovery: {
        state: value.finalState.recovery.state,
        action: value.finalState.recovery.action,
      },
    };
  }
  common.diagnostics = value.diagnostics.map(({ code, message }) => ({ code, message }));
  return common;
}

export function serializeCertificationEvidence(value, options) {
  return `${JSON.stringify(canonicalizeCertificationEvidence(value, options))}\n`;
}

export function writeCertificationEvidence(filePath, value, options) {
  fs.mkdirSync(pathDirectory(filePath), { recursive: true });
  fs.writeFileSync(filePath, serializeCertificationEvidence(value, options), { encoding: "utf8", mode: 0o600 });
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

function pathDirectory(filePath) {
  const separator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return separator < 0 ? "." : filePath.slice(0, separator) || "/";
}

export function sha256Tarball(filePath) {
  const digest = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  return `sha256:${digest}`;
}
