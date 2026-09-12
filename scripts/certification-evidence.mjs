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

export const SELF_DOGFOOD_OUTCOMES = Object.freeze({
  VERIFIED: "verified",
  RETURNED_EXISTING: "returned-existing",
  SUCCESS: "success",
});
export const SELF_DOGFOOD_OPERATION_REQUIREMENTS = Object.freeze([
  Object.freeze({ operation: "preflight.opt-in", outcomes: Object.freeze([SELF_DOGFOOD_OUTCOMES.VERIFIED]) }),
  Object.freeze({
    operation: "preflight.installed-executable",
    outcomes: Object.freeze([SELF_DOGFOOD_OUTCOMES.VERIFIED]),
  }),
  Object.freeze({ operation: "skill.golden-path", outcomes: Object.freeze([SELF_DOGFOOD_OUTCOMES.VERIFIED]) }),
  Object.freeze({
    operation: "disposable-issue.governance-check",
    outcomes: Object.freeze([SELF_DOGFOOD_OUTCOMES.VERIFIED]),
  }),
  Object.freeze({ operation: "change.issue.first", outcomes: Object.freeze([SELF_DOGFOOD_OUTCOMES.VERIFIED]) }),
  Object.freeze({
    operation: "change.issue.return-existing",
    outcomes: Object.freeze([SELF_DOGFOOD_OUTCOMES.RETURNED_EXISTING]),
  }),
  Object.freeze({ operation: "change.handoff", outcomes: Object.freeze([SELF_DOGFOOD_OUTCOMES.VERIFIED]) }),
  Object.freeze({ operation: "worker.implementation", outcomes: Object.freeze([SELF_DOGFOOD_OUTCOMES.SUCCESS]) }),
  Object.freeze({ operation: "change.ready.first", outcomes: Object.freeze([SELF_DOGFOOD_OUTCOMES.VERIFIED]) }),
  Object.freeze({ operation: "change.ready.reread", outcomes: Object.freeze([SELF_DOGFOOD_OUTCOMES.VERIFIED]) }),
  Object.freeze({
    operation: "change.ready.retry",
    outcomes: Object.freeze([SELF_DOGFOOD_OUTCOMES.VERIFIED, SELF_DOGFOOD_OUTCOMES.RETURNED_EXISTING]),
  }),
]);
export const SELF_DOGFOOD_RECOVERY_OPERATION = Object.freeze({
  operation: "change.abort.recovery",
  outcomes: Object.freeze([SELF_DOGFOOD_OUTCOMES.VERIFIED]),
});
export const SELF_DOGFOOD_OPERATIONS = Object.freeze({
  OPT_IN: SELF_DOGFOOD_OPERATION_REQUIREMENTS[0].operation,
  EXECUTABLE: SELF_DOGFOOD_OPERATION_REQUIREMENTS[1].operation,
  SKILL: SELF_DOGFOOD_OPERATION_REQUIREMENTS[2].operation,
  GOVERNANCE: SELF_DOGFOOD_OPERATION_REQUIREMENTS[3].operation,
  FIRST_ISSUANCE: SELF_DOGFOOD_OPERATION_REQUIREMENTS[4].operation,
  RETURN_EXISTING: SELF_DOGFOOD_OPERATION_REQUIREMENTS[5].operation,
  HANDOFF: SELF_DOGFOOD_OPERATION_REQUIREMENTS[6].operation,
  WORKER: SELF_DOGFOOD_OPERATION_REQUIREMENTS[7].operation,
  FIRST_READY: SELF_DOGFOOD_OPERATION_REQUIREMENTS[8].operation,
  REREAD: SELF_DOGFOOD_OPERATION_REQUIREMENTS[9].operation,
  READY_RETRY: SELF_DOGFOOD_OPERATION_REQUIREMENTS[10].operation,
  ABORT: SELF_DOGFOOD_RECOVERY_OPERATION.operation,
});

const [PACKED_CERTIFICATION_KIND, SELF_DOGFOOD_CERTIFICATION_KIND] = CERTIFICATION_KINDS;
const [CERTIFICATION_RESULT_PASSED] = CERTIFICATION_RESULTS;
const CERTIFICATION_KIND_SET = new Set(CERTIFICATION_KINDS);
const CERTIFICATION_RESULT_SET = new Set(CERTIFICATION_RESULTS);
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const TARBALL_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const DIAGNOSTIC_CODE_PATTERN = /^[A-Z][A-Z0-9_.-]{0,127}$/u;
const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;
const BRANCH_PATTERN = /^[^\u0000-\u001F\u007F]{1,512}$/u;
export const MAX_CERTIFICATION_DIAGNOSTICS = 20;
export const MAX_CERTIFICATION_OPERATIONS = 32;
export const MAX_CERTIFICATION_DIAGNOSTIC_CODE_LENGTH = 128;
export const MAX_CERTIFICATION_DIAGNOSTIC_MESSAGE_LENGTH = 512;
export const MAX_CERTIFICATION_STRING_LENGTH = 512;
const MAX_PACKAGE_NAME_LENGTH = 214;
const MAX_PACKAGE_VERSION_LENGTH = 256;

const MAX_DIAGNOSTICS = MAX_CERTIFICATION_DIAGNOSTICS;
const MAX_OPERATIONS = MAX_CERTIFICATION_OPERATIONS;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = MAX_CERTIFICATION_DIAGNOSTIC_MESSAGE_LENGTH;
const MAX_STRING_LENGTH = MAX_CERTIFICATION_STRING_LENGTH;

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

const VALIDATION_DIAGNOSTICS = new WeakMap();

function boundedDiagnosticMessage(value) {
  const normalized = String(value)
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .trim();
  if (normalized.length === 0) return "Certification diagnostic is unavailable.";
  return normalized.length <= MAX_CERTIFICATION_DIAGNOSTIC_MESSAGE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_CERTIFICATION_DIAGNOSTIC_MESSAGE_LENGTH - 1)}…`;
}

function createValidationErrors() {
  const errors = [];
  VALIDATION_DIAGNOSTICS.set(errors, []);
  return errors;
}

function addValidationError(errors, code, message) {
  if (errors.length >= MAX_CERTIFICATION_DIAGNOSTICS) return;
  const boundedCode = typeof code === "string" && DIAGNOSTIC_CODE_PATTERN.test(code) ? code : "EVIDENCE_MALFORMED";
  const bounded = boundedDiagnosticMessage(message);
  errors.push(bounded);
  VALIDATION_DIAGNOSTICS.get(errors)?.push({ code: boundedCode, message: bounded });
}

function validationDiagnostics(errors) {
  return [...(VALIDATION_DIAGNOSTICS.get(errors) ?? [])];
}

/** Add a safe, bounded diagnostic to a producer or verifier result. */
export function appendCertificationDiagnostic(diagnostics, code, message) {
  if (!Array.isArray(diagnostics) || diagnostics.length >= MAX_CERTIFICATION_DIAGNOSTICS) return;
  const boundedCode = typeof code === "string" && DIAGNOSTIC_CODE_PATTERN.test(code) ? code : "EVIDENCE_MALFORMED";
  diagnostics.push({ code: boundedCode, message: boundedDiagnosticMessage(message) });
}

export function isCertificationBoundedString(value, maximum = MAX_CERTIFICATION_STRING_LENGTH) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001F\u007F]/u.test(value)
  );
}

export function isCertificationSourceCommitSha(value) {
  return typeof value === "string" && SOURCE_SHA_PATTERN.test(value);
}

export function isCertificationTarballSha256(value) {
  return typeof value === "string" && TARBALL_SHA256_PATTERN.test(value);
}

export function isCertificationPackageName(value) {
  return isCertificationBoundedString(value, MAX_PACKAGE_NAME_LENGTH) && PACKAGE_NAME_PATTERN.test(value);
}

export function isCertificationRepositoryPart(value) {
  return isCertificationBoundedString(value, 128) && REPOSITORY_PART_PATTERN.test(value);
}

export function isCertificationReviewState(value) {
  return (
    isRecord(value) &&
    value.status === "REVIEW" &&
    isRecord(value.recovery) &&
    RECOVERY_NONE_STATES.has(value.recovery.state) &&
    (value.recovery.action === null || value.recovery.action === "none")
  );
}

export function isCertificationCompletedRecoveryState(value) {
  return (
    isRecord(value) &&
    value.status === "ABORTED" &&
    isRecord(value.recovery) &&
    RECOVERY_COMPLETED_STATES.has(value.recovery.state) &&
    value.recovery.action === "none"
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addValidationError(errors, "EVIDENCE_MALFORMED", `${path}.${key}: unknown property`);
  }
}

function requireString(
  value,
  path,
  errors,
  { pattern, maxLength = MAX_STRING_LENGTH, nonEmpty = true, diagnosticCode = "EVIDENCE_MALFORMED" } = {},
) {
  if (typeof value !== "string") {
    addValidationError(errors, diagnosticCode, `${path}: must be a string`);
    return false;
  }
  if (nonEmpty && value.length === 0) addValidationError(errors, diagnosticCode, `${path}: must not be empty`);
  if (value.length > maxLength)
    addValidationError(errors, diagnosticCode, `${path}: exceeds ${String(maxLength)} characters`);
  if (pattern !== undefined && !pattern.test(value))
    addValidationError(errors, diagnosticCode, `${path}: has an invalid format`);
  if (/[\u0000-\u001F\u007F]/u.test(value))
    addValidationError(errors, diagnosticCode, `${path}: contains control characters`);
  return true;
}

function requirePositiveInteger(value, path, errors, diagnosticCode = "EVIDENCE_MALFORMED") {
  if (!Number.isSafeInteger(value) || value < 1) {
    addValidationError(errors, diagnosticCode, `${path}: must be a positive integer`);
    return false;
  }
  return true;
}

function validateDiagnostics(value, errors) {
  if (!Array.isArray(value)) {
    addValidationError(errors, "EVIDENCE_MALFORMED", "$.diagnostics: must be an array");
    return [];
  }
  if (value.length > MAX_DIAGNOSTICS)
    addValidationError(
      errors,
      "EVIDENCE_MALFORMED",
      `$.diagnostics: must contain at most ${String(MAX_DIAGNOSTICS)} entries`,
    );
  const normalized = [];
  for (let index = 0; index < value.length && index < MAX_DIAGNOSTICS; index += 1) {
    const diagnostic = value[index];
    const path = `$.diagnostics[${String(index)}]`;
    if (!isRecord(diagnostic)) {
      addValidationError(errors, "EVIDENCE_MALFORMED", `${path}: must be an object`);
      continue;
    }
    rejectUnknownKeys(diagnostic, new Set(["code", "message"]), path, errors);
    const codeValid = requireString(diagnostic.code, `${path}.code`, errors, {
      pattern: DIAGNOSTIC_CODE_PATTERN,
      maxLength: MAX_CERTIFICATION_DIAGNOSTIC_CODE_LENGTH,
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
    addValidationError(errors, "CONTRACT_VERSION_MISMATCH", "$.contractVersions: must be an object");
    return false;
  }
  rejectUnknownKeys(value, CONTRACT_VERSION_KEYS, "$.contractVersions", errors);
  let valid = true;
  for (const key of CONTRACT_VERSION_KEYS) {
    if (
      !requireString(value[key], `$.contractVersions.${key}`, errors, {
        diagnosticCode: "CONTRACT_VERSION_MISMATCH",
      })
    )
      valid = false;
    if (typeof value[key] === "string" && value[key].trim() !== value[key]) {
      addValidationError(
        errors,
        "CONTRACT_VERSION_MISMATCH",
        `$.contractVersions.${key}: must not have surrounding whitespace`,
      );
      valid = false;
    }
    if (expected !== undefined && value[key] !== expected[key]) {
      addValidationError(
        errors,
        "CONTRACT_VERSION_MISMATCH",
        `$.contractVersions.${key}: unknown or stale contract version`,
      );
      valid = false;
    }
  }
  return valid;
}

function validatePackedExtension(value, errors) {
  if (!isRecord(value)) {
    addValidationError(errors, "EVIDENCE_MALFORMED", "$.package: must be an object");
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
    addValidationError(errors, "DOGFOOD_IDENTITY_INVALID", "$.repository: must be an object");
    return false;
  }
  rejectUnknownKeys(value, REPOSITORY_KEYS, "$.repository", errors);
  return (
    requireString(value.owner, "$.repository.owner", errors, {
      pattern: REPOSITORY_PART_PATTERN,
      maxLength: 128,
      diagnosticCode: "DOGFOOD_IDENTITY_INVALID",
    }) &&
    requireString(value.name, "$.repository.name", errors, {
      pattern: REPOSITORY_PART_PATTERN,
      maxLength: 128,
      diagnosticCode: "DOGFOOD_IDENTITY_INVALID",
    })
  );
}

function validateChangeIdentity(value, rootIssue, errors, { allowUnavailable = false } = {}) {
  if (!isRecord(value)) {
    addValidationError(errors, "DOGFOOD_IDENTITY_INVALID", "$.change: must be an object");
    return false;
  }
  rejectUnknownKeys(value, CHANGE_KEYS, "$.change", errors);
  const issueValid = requirePositiveInteger(value.issue, "$.change.issue", errors, "DOGFOOD_IDENTITY_INVALID");
  const branchValid = requireString(value.branch, "$.change.branch", errors, {
    pattern: BRANCH_PATTERN,
    diagnosticCode: "DOGFOOD_IDENTITY_INVALID",
  });
  const pullRequestValid = allowUnavailable
    ? Number.isSafeInteger(value.pullRequest) && value.pullRequest >= 0
    : requirePositiveInteger(value.pullRequest, "$.change.pullRequest", errors, "DOGFOOD_IDENTITY_INVALID");
  if (allowUnavailable && !pullRequestValid)
    addValidationError(errors, "DOGFOOD_IDENTITY_INVALID", "$.change.pullRequest: must be a non-negative integer");
  if (rootIssue !== undefined && value.issue !== rootIssue)
    addValidationError(errors, "DOGFOOD_IDENTITY_INVALID", "$.change.issue: must match $.rootIssue");
  return issueValid && branchValid && pullRequestValid;
}

function validateOperationEntries(value, errors, { strictSequence = false, finalStatus } = {}) {
  if (!Array.isArray(value)) {
    addValidationError(errors, "DOGFOOD_IDENTITY_INVALID", "$.operations: must be an array");
    return false;
  }
  if (value.length > MAX_OPERATIONS)
    addValidationError(
      errors,
      "DOGFOOD_IDENTITY_INVALID",
      `$.operations: must contain at most ${String(MAX_OPERATIONS)} entries`,
    );
  let valid = true;
  const names = [];
  for (let index = 0; index < value.length && index < MAX_OPERATIONS; index += 1) {
    const entry = value[index];
    const path = `$.operations[${String(index)}]`;
    if (!isRecord(entry)) {
      addValidationError(errors, "DOGFOOD_IDENTITY_INVALID", `${path}: must be an object`);
      valid = false;
      continue;
    }
    rejectUnknownKeys(entry, OPERATION_KEYS, path, errors);
    const operationValid = requireString(entry.operation, `${path}.operation`, errors, {
      maxLength: MAX_CERTIFICATION_DIAGNOSTIC_CODE_LENGTH,
      diagnosticCode: "DOGFOOD_IDENTITY_INVALID",
    });
    const outcomeValid = requireString(entry.outcome, `${path}.outcome`, errors, {
      maxLength: MAX_CERTIFICATION_DIAGNOSTIC_CODE_LENGTH,
      diagnosticCode: "DOGFOOD_IDENTITY_INVALID",
    });
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
      addValidationError(errors, "DOGFOOD_OPERATION_OUTCOME_INVALID", `${path}: unsupported operation outcome`);
      valid = false;
    }
  }
  if (strictSequence) {
    const required = SELF_DOGFOOD_OPERATION_REQUIREMENTS.map((entry) => entry.operation);
    const expected = finalStatus === "ABORTED" ? [...required, SELF_DOGFOOD_RECOVERY_OPERATION.operation] : required;
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
      addValidationError(
        errors,
        "DOGFOOD_OPERATION_MISSING",
        "$.operations: required operation sequence is incomplete or out of order",
      );
      valid = false;
    }
  }
  return valid;
}

function validateFinalState(value, errors, { allowUnavailable = false } = {}) {
  if (!isRecord(value)) {
    addValidationError(errors, "DOGFOOD_FINAL_STATE_INVALID", "$.finalState: must be an object");
    return false;
  }
  rejectUnknownKeys(value, FINAL_STATE_KEYS, "$.finalState", errors);
  const allowedStatuses = allowUnavailable
    ? new Set(["REVIEW", "RECOVERY_REQUIRED", "ABORTED", "UNAVAILABLE"])
    : new Set(["REVIEW", "RECOVERY_REQUIRED", "ABORTED"]);
  if (!allowedStatuses.has(value.status))
    addValidationError(errors, "DOGFOOD_FINAL_STATE_INVALID", "$.finalState.status: unsupported value");
  if (!isRecord(value.recovery)) {
    addValidationError(errors, "DOGFOOD_FINAL_STATE_INVALID", "$.finalState.recovery: must be an object");
    return false;
  }
  rejectUnknownKeys(value.recovery, RECOVERY_KEYS, "$.finalState.recovery", errors);
  let valid = allowedStatuses.has(value.status);
  if (
    !requireString(value.recovery.state, "$.finalState.recovery.state", errors, {
      maxLength: 64,
      diagnosticCode: "DOGFOOD_FINAL_STATE_INVALID",
    })
  )
    valid = false;
  if (
    value.recovery.action !== null &&
    !requireString(value.recovery.action, "$.finalState.recovery.action", errors, {
      diagnosticCode: "DOGFOOD_FINAL_STATE_INVALID",
    })
  ) {
    valid = false;
  }
  if (value.status === "REVIEW") {
    if (!RECOVERY_NONE_STATES.has(value.recovery.state)) {
      addValidationError(
        errors,
        "DOGFOOD_FINAL_STATE_INVALID",
        "$.finalState.recovery.state: REVIEW requires no recovery",
      );
      valid = false;
    }
    if (value.recovery.action !== null && value.recovery.action !== "none") {
      addValidationError(
        errors,
        "DOGFOOD_FINAL_STATE_INVALID",
        "$.finalState.recovery.action: REVIEW requires null or none",
      );
      valid = false;
    }
  }
  if (value.status === "RECOVERY_REQUIRED") {
    if (!RECOVERY_REQUIRED_STATES.has(value.recovery.state) || typeof value.recovery.action !== "string") {
      addValidationError(
        errors,
        "DOGFOOD_FINAL_STATE_INVALID",
        "$.finalState.recovery: RECOVERY_REQUIRED requires a recovery action",
      );
      valid = false;
    }
  }
  if (value.status === "ABORTED") {
    if (!RECOVERY_COMPLETED_STATES.has(value.recovery.state) || value.recovery.action !== "none") {
      addValidationError(
        errors,
        "DOGFOOD_FINAL_STATE_INVALID",
        "$.finalState.recovery: ABORTED requires completed recovery",
      );
      valid = false;
    }
  }
  return valid;
}

function validateDogfoodExtension(value, errors, { strict = false } = {}) {
  if (!isRecord(value)) {
    addValidationError(errors, "DOGFOOD_IDENTITY_INVALID", "$: self-dogfood evidence must be an object");
    return false;
  }
  const repositoryValid = validateRepository(value.repository, errors);
  const rootIssueValid = requirePositiveInteger(value.rootIssue, "$.rootIssue", errors, "DOGFOOD_IDENTITY_INVALID");
  const changeValid = validateChangeIdentity(value.change, value.rootIssue, errors, { allowUnavailable: !strict });
  const operationsValid = validateOperationEntries(value.operations, errors, {
    strictSequence: strict,
    finalStatus: value.finalState?.status,
  });
  const finalStateValid = validateFinalState(value.finalState, errors, { allowUnavailable: !strict });
  return repositoryValid && rootIssueValid && changeValid && operationsValid && finalStateValid;
}

function validateSharedEnvelope(value, { certificationKind, expectedContractVersions } = {}) {
  const errors = createValidationErrors();
  if (!isRecord(value)) {
    addValidationError(errors, "EVIDENCE_MALFORMED", "$: must be an object");
    return { valid: false, errors };
  }
  const kind = value.certificationKind;
  const allowedKeys =
    kind === PACKED_CERTIFICATION_KIND
      ? PACKED_KEYS
      : kind === SELF_DOGFOOD_CERTIFICATION_KIND
        ? DOGFOOD_KEYS
        : COMMON_KEYS;
  rejectUnknownKeys(value, allowedKeys, "$", errors);
  if (value.schemaVersion !== CERTIFICATION_EVIDENCE_SCHEMA_VERSION)
    addValidationError(
      errors,
      "SCHEMA_UNSUPPORTED",
      `$.schemaVersion: must be exactly "${CERTIFICATION_EVIDENCE_SCHEMA_VERSION}"`,
    );
  if (!CERTIFICATION_KIND_SET.has(kind))
    addValidationError(errors, "EVIDENCE_MALFORMED", "$.certificationKind: unsupported value");
  if (certificationKind !== undefined && kind !== certificationKind)
    addValidationError(errors, "KIND_MISMATCH", "$.certificationKind: does not match the expected certification kind");
  if (!CERTIFICATION_RESULT_SET.has(value.result))
    addValidationError(errors, "EVIDENCE_MALFORMED", "$.result: unsupported value");
  if (!(value.sourceCommitSha === null && value.result !== CERTIFICATION_RESULT_PASSED)) {
    requireString(value.sourceCommitSha, "$.sourceCommitSha", errors, {
      pattern: SOURCE_SHA_PATTERN,
      maxLength: 40,
    });
  }
  validateContractVersions(value.contractVersions, errors, { expected: expectedContractVersions });
  validateDiagnostics(value.diagnostics, errors);
  if (
    value.result === CERTIFICATION_RESULT_PASSED &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.length !== 0
  ) {
    addValidationError(errors, "EVIDENCE_MALFORMED", "$.diagnostics: must be empty when result is passed");
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
  const strict = value?.result === CERTIFICATION_RESULT_PASSED;
  const envelope = validateSharedEnvelope(value, { certificationKind, expectedContractVersions: contractVersions });
  const errors = envelope.errors;
  if (!envelope.valid) return { valid: false, errors, diagnostics: validationDiagnostics(errors) };
  if (value.certificationKind === PACKED_CERTIFICATION_KIND) {
    if (value.result === CERTIFICATION_RESULTS[2])
      addValidationError(errors, "RESULT_NOT_PASSED", "$.result: packed certification cannot be blocked");
    validatePackedExtension(value.package, errors);
  } else if (value.certificationKind === SELF_DOGFOOD_CERTIFICATION_KIND) {
    validateDogfoodExtension(value, errors, { strict });
  }
  if (errors.length > 0) return { valid: false, errors, diagnostics: validationDiagnostics(errors) };
  return {
    valid: true,
    errors,
    evidence: value,
    diagnostics: value.diagnostics,
  };
}

/** Authority entry consumed by the explicit self-dogfood harness. */
export function validateSelfDogfoodEvidence(value) {
  return validateCertificationEvidence(value, { certificationKind: SELF_DOGFOOD_CERTIFICATION_KIND });
}

/**
 * Append one coordinator-observed operation through the canonical operation
 * requirements.  The coordinator owns when to invoke an operation; this
 * authority owns whether its name, outcome, and position are admissible.
 */
export function appendSelfDogfoodOperation(operations, operation, operationOutcome) {
  const errors = createValidationErrors();
  if (!Array.isArray(operations)) {
    addValidationError(errors, "DOGFOOD_OPERATION_MISSING", "$.operations: must be an array");
  } else if (operations.length >= MAX_CERTIFICATION_OPERATIONS) {
    addValidationError(
      errors,
      "DOGFOOD_OPERATION_MISSING",
      `$.operations: must contain at most ${String(MAX_CERTIFICATION_OPERATIONS - 1)} entries before append`,
    );
  }
  if (typeof operation !== "string" || typeof operationOutcome !== "string") {
    addValidationError(errors, "DOGFOOD_OPERATION_OUTCOME_INVALID", "$.operation: name and outcome must be strings");
  } else if (Array.isArray(operations)) {
    const isRecovery =
      operations.length === SELF_DOGFOOD_OPERATION_REQUIREMENTS.length &&
      operation === SELF_DOGFOOD_RECOVERY_OPERATION.operation;
    const expected = SELF_DOGFOOD_OPERATION_REQUIREMENTS[operations.length]?.operation;
    if (!isRecovery && operation !== expected) {
      addValidationError(
        errors,
        "DOGFOOD_OPERATION_MISSING",
        `$.operations: expected ${expected ?? "completion"}, got ${operation}`,
      );
    }
    const allowedOutcomes = isRecovery
      ? SELF_DOGFOOD_RECOVERY_OPERATION.outcomes
      : OPERATION_REQUIREMENT_MAP.get(operation);
    if (allowedOutcomes === undefined || !allowedOutcomes.includes(operationOutcome)) {
      addValidationError(errors, "DOGFOOD_OPERATION_OUTCOME_INVALID", "$.operation: unsupported operation outcome");
    }
  }
  if (errors.length > 0) throw new CertificationEvidenceError(errors);
  return [...operations, { operation, outcome: operationOutcome }];
}

/**
 * Validate the product's disposable-Issue check result. The marker is
 * product-owned; this authority only confirms the bounded, explicit opt-in
 * projection and never infers disposability from an Issue number or title.
 */
export function validateDisposableGovernedIssue(value) {
  const errors = createValidationErrors();
  if (!isRecord(value)) {
    addValidationError(errors, "EVIDENCE_MALFORMED", "$: Issue check result must be an object");
    return { valid: false, errors, diagnostics: validationDiagnostics(errors) };
  }
  if (value.ok !== true && value.valid !== true)
    addValidationError(errors, "EVIDENCE_MALFORMED", "$.ok: governed Issue check did not pass");
  if (
    !isRecord(value.disposableMarker) ||
    value.disposableMarker.version !== 1 ||
    value.disposableMarker.kind !== "self-dogfood"
  ) {
    addValidationError(errors, "EVIDENCE_MALFORMED", "$.disposableMarker: explicit self-dogfood marker is required");
  }
  if (value.governance !== undefined && (!isRecord(value.governance) || value.governance.valid !== true)) {
    addValidationError(errors, "EVIDENCE_MALFORMED", "$.governance: governed Issue contract check did not pass");
  }
  return { valid: errors.length === 0, errors, diagnostics: validationDiagnostics(errors) };
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
  if (value.certificationKind === PACKED_CERTIFICATION_KIND) {
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
    const errors = createValidationErrors();
    addValidationError(
      errors,
      "EVIDENCE_MALFORMED",
      `$: unable to parse evidence (${error instanceof Error ? error.message : String(error)})`,
    );
    throw new CertificationEvidenceError(errors);
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
