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
/** Terminal Change states a self-dogfood run's finalState may report regardless of result. */
export const CERTIFICATION_FINAL_STATE_TERMINAL_STATUSES = Object.freeze(["REVIEW", "RECOVERY_REQUIRED", "ABORTED"]);
/** finalState.status sentinel for a run that never reached a terminal Change state. */
export const CERTIFICATION_FINAL_STATE_UNAVAILABLE_STATUS = "UNAVAILABLE";

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
const WORKFLOW_RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const WORKFLOW_RUN_ATTEMPT_PATTERN = /^[1-9][0-9]{0,9}$/u;
const TARBALL_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const DIAGNOSTIC_CODE_PATTERN = /^[A-Z][A-Z0-9_.-]{0,127}$/u;
const STRUCTURED_UNSAFE_TEXT_PATTERN =
  /(?:-----BEGIN|bearer\s+|(?:access|refresh|installation|github|oauth)?[-_ ]?token\b|private\s*key|password|secret|credential|authorization|cookie|raw\s+(?:github|provider|api)?\s*(?:body|response|payload|exception|error)|(?:github|provider|api)\s+(?:api\s+)?(?:body|response|payload)|(?:^|[\\/])(?:etc|home|mnt|opt|private|root|run|srv|tmp|users|var|workspace)(?:[\\/]|$)|[A-Za-z]:[\\/]|(?:ghp|github_pat|gho|ghs|ghr)_[A-Za-z0-9_]+|https?:\/\/)/iu;
const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;
const BRANCH_PATTERN = /^[^\u0000-\u001F\u007F]{1,512}$/u;
export const MAX_CERTIFICATION_DIAGNOSTICS = 20;
export const MAX_CERTIFICATION_OPERATIONS = 32;
export const MAX_CERTIFICATION_DIAGNOSTIC_CODE_LENGTH = 128;
export const MAX_CERTIFICATION_DIAGNOSTIC_MESSAGE_LENGTH = 512;
export const MAX_CERTIFICATION_STRING_LENGTH = 512;
const MAX_STRUCTURED_DIAGNOSTIC_BYTES = 16_384;
const MAX_STRUCTURED_DIAGNOSTICS = 32;
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
const WORKFLOW_KEYS = new Set(["runId", "runAttempt"]);
const DOGFOOD_KEYS = new Set([
  ...COMMON_KEYS,
  "repository",
  "workflow",
  "rootIssue",
  "change",
  "operations",
  "finalState",
]);
const CERTIFICATION_DIAGNOSTIC_KEYS = new Set(["code", "message", "details", "diagnostics", "evidence"]);
const STRUCTURED_DETAIL_KEYS = new Set([
  "operation",
  "reason",
  "stage",
  "stageReason",
  "trustedCode",
  "path",
  "field",
  "category",
  "issue",
  "status",
  "version",
  "recovery",
  "provider",
  "effectFailure",
  "diagnostics",
  "evidence",
]);
const STRUCTURED_RECOVERY_KEYS = new Set(["state", "action"]);
const STRUCTURED_PROVIDER_KEYS = new Set(["category", "resource", "field", "code"]);
const STRUCTURED_FAILURE_KEYS = new Set(["kind", "code", "message", "reason", "status", "provider"]);
const STRUCTURED_EFFECT_KEYS = new Set(["kind", "status", "createdCommitSha"]);
const STRUCTURED_EXECUTION_EVIDENCE_KEYS = new Set([
  "version",
  "operation",
  "outcome",
  "requester",
  "issuer",
  "effects",
  "compensation",
  "compensationFailure",
  "failure",
]);
const STRUCTURED_EFFECT_KINDS = new Set([
  "CREATE_BRANCH",
  "CREATE_PROVENANCE_COMMIT",
  "CREATE_PULL_REQUEST",
  "MARK_PULL_REQUEST_READY",
  "CLOSE_PULL_REQUEST",
  "DELETE_BRANCH",
]);
const STRUCTURED_EXECUTION_OPERATIONS = new Set(["issue", "ready", "abort"]);
const STRUCTURED_EXECUTION_OUTCOMES = new Set([
  "verified",
  "returned-existing",
  "compensated",
  "recovery-required",
  "failed",
]);
const STRUCTURED_FAILURE_REASONS = new Set([
  "credential",
  "scope",
  "transport",
  "provider-http",
  "response-validation",
  "generation-mismatch",
]);
const STRUCTURED_PROVIDER_CATEGORIES = new Set([
  "validation-failed",
  "authentication-failed",
  "conflict",
  "rate-limit",
]);
const STRUCTURED_PROVIDER_RESOURCES = new Set([
  "Branch",
  "Commit",
  "Contents",
  "Issue",
  "IssueComment",
  "PullRequest",
  "PullRequestReview",
  "Reference",
  "Ref",
  "Repository",
  "User",
  "Workflow",
  "WorkflowRun",
]);
const STRUCTURED_PROVIDER_FIELDS = new Set([
  "assignees",
  "base",
  "body",
  "branch",
  "default_branch",
  "draft",
  "field",
  "head",
  "labels",
  "name",
  "number",
  "pull_request",
  "ref",
  "repository",
  "sha",
  "state",
  "title",
]);
const STRUCTURED_PROVIDER_CODES = new Set([
  "already_exists",
  "custom",
  "incorrect",
  "invalid",
  "missing",
  "missing_field",
  "not_found",
  "protected",
  "unprocessable",
]);
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

function redactCertificationText(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .replace(/(bearer\s+|token[=:]\s*|secret[=:]\s*|password[=:]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/((?:private(?:[-_ ]?key)?|credential|authorization|cookie)[=:]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/(^|[\s(])\/(?:private|tmp|var|etc|home|root|workspace)[^\s,;]*/giu, "$1[REDACTED]")
    .replace(/[A-Za-z0-9_\-/+=]{32,}/gu, "[REDACTED]");
}

/** Return bounded, redacted text only when it is safe to place in evidence. */
export function sanitizeCertificationText(value, maximum = MAX_CERTIFICATION_STRING_LENGTH) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const redacted = redactCertificationText(value);
  if (redacted.length === 0 || STRUCTURED_UNSAFE_TEXT_PATTERN.test(redacted)) return undefined;
  return redacted.slice(0, maximum);
}

/** Add a safe, bounded diagnostic to a producer or verifier result. */
export function appendCertificationDiagnostic(diagnostics, code, message, structured = undefined) {
  if (!Array.isArray(diagnostics) || diagnostics.length >= MAX_CERTIFICATION_DIAGNOSTICS) return;
  const boundedCode = typeof code === "string" && DIAGNOSTIC_CODE_PATTERN.test(code) ? code : "EVIDENCE_MALFORMED";
  const diagnostic = {
    code: boundedCode,
    message:
      sanitizeCertificationText(String(message), MAX_CERTIFICATION_DIAGNOSTIC_MESSAGE_LENGTH) ??
      "Certification diagnostic is unavailable.",
  };
  if (isRecord(structured)) {
    if (structured.details !== undefined) {
      const details = projectStructuredDetails(structured.details);
      if (details !== undefined) diagnostic.details = details;
    }
    if (structured.diagnostics !== undefined) {
      const diagnosticsProjection = projectStructuredChangeDiagnostics(structured.diagnostics);
      if (diagnosticsProjection !== undefined) diagnostic.diagnostics = diagnosticsProjection;
    }
    if (structured.evidence !== undefined) {
      const evidence = projectStructuredExecutionEvidence(structured.evidence);
      if (evidence !== undefined) diagnostic.evidence = evidence;
    }
  }
  diagnostics.push(diagnostic);
}

export function isCertificationBoundedString(value, maximum = MAX_CERTIFICATION_STRING_LENGTH) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001F\u007F]/u.test(value)
  );
}

export function isCertificationSourceCommitSha(value) {
  return typeof value === "string" && SOURCE_SHA_PATTERN.test(value);
}

export function isCertificationWorkflowRunId(value) {
  return typeof value === "string" && WORKFLOW_RUN_ID_PATTERN.test(value);
}

export function isCertificationWorkflowRunAttempt(value) {
  return typeof value === "string" && WORKFLOW_RUN_ATTEMPT_PATTERN.test(value);
}

/** Build the immutable source/run identity used by retained self-dogfood artifacts. */
export function selfDogfoodArtifactName(sourceCommitSha, workflowRunId, workflowRunAttempt) {
  if (
    !isCertificationSourceCommitSha(sourceCommitSha) ||
    !isCertificationWorkflowRunId(workflowRunId) ||
    !isCertificationWorkflowRunAttempt(workflowRunAttempt)
  )
    throw new TypeError("self-dogfood artifact identity is malformed");
  return `self-dogfood-golden-path-${sourceCommitSha}-${workflowRunId}-${workflowRunAttempt}`;
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

function isSafeStructuredText(value, maximum = MAX_STRING_LENGTH) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001F\u007F]/u.test(value) &&
    !STRUCTURED_UNSAFE_TEXT_PATTERN.test(value)
  );
}

function safeStructuredText(value, maximum) {
  return sanitizeCertificationText(value, maximum);
}

function safeStructuredCode(value) {
  return typeof value === "string" && DIAGNOSTIC_CODE_PATTERN.test(value)
    ? value.slice(0, MAX_CERTIFICATION_DIAGNOSTIC_CODE_LENGTH)
    : undefined;
}

function projectStructuredProvider(value) {
  if (!isRecord(value) || [...Object.keys(value)].some((key) => !STRUCTURED_PROVIDER_KEYS.has(key))) return undefined;
  if (!STRUCTURED_PROVIDER_CATEGORIES.has(value.category)) return undefined;
  const provider = {};
  provider.category = value.category;
  if (value.resource !== undefined && STRUCTURED_PROVIDER_RESOURCES.has(value.resource))
    provider.resource = value.resource;
  if (value.field !== undefined && STRUCTURED_PROVIDER_FIELDS.has(value.field)) provider.field = value.field;
  if (value.code !== undefined && STRUCTURED_PROVIDER_CODES.has(value.code)) provider.code = value.code;
  return Object.keys(provider).length === 0 ? undefined : provider;
}

function projectStructuredEffectFailure(value) {
  if (!isRecord(value) || [...Object.keys(value)].some((key) => !["reason", "status", "provider"].includes(key)))
    return undefined;
  const failure = {};
  if (!STRUCTURED_FAILURE_REASONS.has(value.reason)) return undefined;
  failure.reason = value.reason;
  if (value.status !== undefined) {
    if (
      value.reason !== "provider-http" ||
      !Number.isSafeInteger(value.status) ||
      value.status < 100 ||
      value.status > 599
    )
      return undefined;
    failure.status = value.status;
  }
  if (value.provider !== undefined) {
    if (value.reason !== "provider-http") return undefined;
    const provider = projectStructuredProvider(value.provider);
    if (provider === undefined) return undefined;
    failure.provider = provider;
  }
  return Object.keys(failure).length === 0 ? undefined : failure;
}

function projectStructuredChangeDiagnostics(value) {
  if (!Array.isArray(value) || value.length > MAX_STRUCTURED_DIAGNOSTICS) return undefined;
  const diagnostics = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      [...Object.keys(candidate)].some((key) => !["version", "code", "path", "message"].includes(key)) ||
      candidate.version !== 1
    )
      return undefined;
    const code = safeStructuredCode(candidate.code);
    const pathValue = safeStructuredText(candidate.path, 160);
    const message = safeStructuredText(candidate.message, 240);
    if (code === undefined || pathValue === undefined || message === undefined) return undefined;
    diagnostics.push({ version: 1, code, path: pathValue, message });
  }
  return diagnostics;
}

function projectStructuredFailure(value) {
  if (!isRecord(value) || [...Object.keys(value)].some((key) => !STRUCTURED_FAILURE_KEYS.has(key))) return undefined;
  const kind = typeof value.kind === "string" && STRUCTURED_EFFECT_KINDS.has(value.kind) ? value.kind : undefined;
  const code =
    typeof value.code === "string" && value.code.length <= MAX_CERTIFICATION_DIAGNOSTIC_CODE_LENGTH
      ? safeStructuredCode(value.code)
      : undefined;
  const message = safeStructuredText(value.message, 240);
  if (kind === undefined || code === undefined || message === undefined) return undefined;
  const failure = { kind, code, message };
  if (value.reason !== undefined) {
    if (!STRUCTURED_FAILURE_REASONS.has(value.reason)) return undefined;
    failure.reason = value.reason;
  }
  if (value.status !== undefined) {
    if (
      value.reason !== "provider-http" ||
      !Number.isSafeInteger(value.status) ||
      value.status < 100 ||
      value.status > 599
    )
      return undefined;
    failure.status = value.status;
  }
  if (value.provider !== undefined) {
    if (value.reason !== "provider-http") return undefined;
    const provider = projectStructuredProvider(value.provider);
    if (provider === undefined) return undefined;
    failure.provider = provider;
  }
  return failure;
}

function projectStructuredExecutionEvidence(value) {
  if (!isRecord(value) || [...Object.keys(value)].some((key) => !STRUCTURED_EXECUTION_EVIDENCE_KEYS.has(key)))
    return undefined;
  if (
    value.version !== 1 ||
    !STRUCTURED_EXECUTION_OPERATIONS.has(value.operation) ||
    !STRUCTURED_EXECUTION_OUTCOMES.has(value.outcome)
  )
    return undefined;
  if (!Array.isArray(value.effects) || value.effects.length > 8) return undefined;
  const effects = [];
  for (const candidate of value.effects) {
    if (!isRecord(candidate) || [...Object.keys(candidate)].some((key) => !STRUCTURED_EFFECT_KEYS.has(key)))
      return undefined;
    if (!STRUCTURED_EFFECT_KINDS.has(candidate.kind) || !["succeeded", "failed"].includes(candidate.status))
      return undefined;
    const effect = { kind: candidate.kind, status: candidate.status };
    if (candidate.createdCommitSha !== undefined) {
      if (
        (candidate.kind !== "CREATE_BRANCH" && candidate.kind !== "CREATE_PROVENANCE_COMMIT") ||
        candidate.status !== "succeeded" ||
        typeof candidate.createdCommitSha !== "string" ||
        !SOURCE_SHA_PATTERN.test(candidate.createdCommitSha)
      )
        return undefined;
      effect.createdCommitSha = candidate.createdCommitSha.toLowerCase();
    }
    effects.push(effect);
  }
  const evidence = {
    version: 1,
    operation: safeStructuredText(value.operation, 64),
    outcome: safeStructuredText(value.outcome, 64),
    effects,
  };
  if (evidence.operation === undefined || evidence.outcome === undefined) return undefined;
  for (const key of ["requester", "issuer"]) {
    if (value[key] !== undefined) {
      const projected = safeStructuredText(value[key], 160);
      if (projected === undefined) return undefined;
      evidence[key] = projected;
    }
  }
  if (value.compensation !== undefined) {
    if (!["not-required", "succeeded", "failed"].includes(value.compensation)) return undefined;
    evidence.compensation = value.compensation;
  }
  if (value.failure !== undefined) {
    const failure = projectStructuredFailure(value.failure);
    if (failure === undefined) return undefined;
    evidence.failure = failure;
  }
  if (value.compensationFailure !== undefined) {
    const failure = projectStructuredFailure(value.compensationFailure);
    if (failure === undefined) return undefined;
    evidence.compensationFailure = failure;
  }
  if (new TextEncoder().encode(JSON.stringify(evidence)).byteLength > MAX_STRUCTURED_DIAGNOSTIC_BYTES) return undefined;
  return evidence;
}

function projectStructuredDetails(value) {
  if (!isRecord(value)) return undefined;
  const details = {};
  for (const key of STRUCTURED_DETAIL_KEYS) {
    if (value[key] === undefined) continue;
    if (key === "trustedCode") {
      const projected = safeStructuredCode(value[key]);
      if (projected !== undefined) details[key] = projected;
    } else if (["operation", "reason", "stage", "stageReason", "path", "field", "category"].includes(key)) {
      const projected = safeStructuredText(value[key], MAX_CERTIFICATION_STRING_LENGTH);
      if (projected !== undefined) details[key] = projected;
    } else if (["issue", "status", "version"].includes(key)) {
      if (Number.isSafeInteger(value[key]) && value[key] > 0) details[key] = value[key];
    } else if (key === "recovery" && isRecord(value[key])) {
      const state = safeStructuredText(value[key].state, 64);
      const action = value[key].action === null ? null : safeStructuredText(value[key].action, 128);
      if (state !== undefined && (value[key].action === null || action !== undefined))
        details.recovery = { state, action };
    } else if (key === "provider") {
      const provider = projectStructuredProvider(value[key]);
      if (provider !== undefined) details.provider = provider;
    } else if (key === "effectFailure") {
      const failure = projectStructuredEffectFailure(value[key]);
      if (failure !== undefined) details.effectFailure = failure;
    } else if (key === "diagnostics") {
      const diagnostics = projectStructuredChangeDiagnostics(value[key]);
      if (diagnostics !== undefined) details.diagnostics = diagnostics;
    } else if (key === "evidence") {
      const evidence = projectStructuredExecutionEvidence(value[key]);
      if (evidence !== undefined) details.evidence = evidence;
    }
  }
  return Object.keys(details).length === 0 ? undefined : details;
}

/** Project an installed Inari structured command error into safe evidence fields. */
export function projectStructuredCommandError(value) {
  if (
    !isRecord(value) ||
    !isRecord(value.error) ||
    Object.keys(value.error).some(
      (key) => !CERTIFICATION_DIAGNOSTIC_KEYS.has(key) && !["path", "violations"].includes(key),
    )
  )
    return undefined;
  const code = safeStructuredCode(value.error.code);
  const message =
    safeStructuredText(value.error.message, MAX_CERTIFICATION_DIAGNOSTIC_MESSAGE_LENGTH) ??
    "Installed Inari reported a structured command failure.";
  if (code === undefined) return undefined;
  const structured = {};
  const details = projectStructuredDetails(value.error.details);
  const diagnostics = projectStructuredChangeDiagnostics(value.error.diagnostics);
  const evidence = projectStructuredExecutionEvidence(value.error.evidence);
  if (details !== undefined) structured.details = details;
  if (diagnostics !== undefined) structured.diagnostics = diagnostics;
  if (evidence !== undefined) structured.evidence = evidence;
  return { code, message, structured };
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
    rejectUnknownKeys(diagnostic, CERTIFICATION_DIAGNOSTIC_KEYS, path, errors);
    const codeValid = requireString(diagnostic.code, `${path}.code`, errors, {
      pattern: DIAGNOSTIC_CODE_PATTERN,
      maxLength: MAX_CERTIFICATION_DIAGNOSTIC_CODE_LENGTH,
    });
    const messageValid = validateSafeStructuredString(
      diagnostic.message,
      `${path}.message`,
      errors,
      MAX_DIAGNOSTIC_MESSAGE_LENGTH,
    );
    validateStructuredDiagnosticFields(diagnostic, path, errors);
    if (codeValid && messageValid) {
      normalized.push({
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.details === undefined ? {} : { details: diagnostic.details }),
        ...(diagnostic.diagnostics === undefined ? {} : { diagnostics: diagnostic.diagnostics }),
        ...(diagnostic.evidence === undefined ? {} : { evidence: diagnostic.evidence }),
      });
    }
  }
  return normalized;
}

function validateSafeStructuredString(value, path, errors, maximum = MAX_STRING_LENGTH) {
  if (!isSafeStructuredText(value, maximum)) {
    addValidationError(errors, "EVIDENCE_MALFORMED", `${path}: must be bounded and secret-safe`);
    return false;
  }
  return true;
}

function validateStructuredProvider(value, path, errors) {
  if (!isRecord(value)) {
    addValidationError(errors, "EVIDENCE_MALFORMED", `${path}: must be an object`);
    return false;
  }
  rejectUnknownKeys(value, STRUCTURED_PROVIDER_KEYS, path, errors);
  let valid = STRUCTURED_PROVIDER_CATEGORIES.has(value.category);
  if (!valid) addValidationError(errors, "EVIDENCE_MALFORMED", `${path}.category: unsupported value`);
  if (
    value.category !== undefined &&
    (!STRUCTURED_PROVIDER_CATEGORIES.has(value.category) ||
      !validateSafeStructuredString(value.category, `${path}.category`, errors))
  )
    valid = false;
  if (
    value.resource !== undefined &&
    (!STRUCTURED_PROVIDER_RESOURCES.has(value.resource) ||
      !validateSafeStructuredString(value.resource, `${path}.resource`, errors))
  )
    valid = false;
  if (
    value.field !== undefined &&
    (!STRUCTURED_PROVIDER_FIELDS.has(value.field) ||
      !validateSafeStructuredString(value.field, `${path}.field`, errors))
  )
    valid = false;
  if (
    value.code !== undefined &&
    (!STRUCTURED_PROVIDER_CODES.has(value.code) || !validateSafeStructuredString(value.code, `${path}.code`, errors))
  )
    valid = false;
  return valid;
}

function validateStructuredFailure(value, path, errors) {
  if (!isRecord(value)) {
    addValidationError(errors, "EVIDENCE_MALFORMED", `${path}: must be an object`);
    return false;
  }
  rejectUnknownKeys(value, STRUCTURED_FAILURE_KEYS, path, errors);
  let valid = true;
  valid =
    STRUCTURED_EFFECT_KINDS.has(value.kind) &&
    validateSafeStructuredString(value.kind, `${path}.kind`, errors, 64) &&
    valid;
  valid =
    validateSafeStructuredString(value.code, `${path}.code`, errors, MAX_CERTIFICATION_DIAGNOSTIC_CODE_LENGTH) && valid;
  valid = validateSafeStructuredString(value.message, `${path}.message`, errors, 240) && valid;
  if (
    value.reason !== undefined &&
    (!STRUCTURED_FAILURE_REASONS.has(value.reason) ||
      !validateSafeStructuredString(value.reason, `${path}.reason`, errors, 64))
  )
    valid = false;
  if (value.status !== undefined) {
    if (
      value.reason !== "provider-http" ||
      !Number.isSafeInteger(value.status) ||
      value.status < 100 ||
      value.status > 599
    ) {
      addValidationError(errors, "EVIDENCE_MALFORMED", `${path}.status: must be an HTTP status for provider-http`);
      valid = false;
    }
  }
  if (value.provider !== undefined) {
    if (value.reason !== "provider-http" || !validateStructuredProvider(value.provider, `${path}.provider`, errors))
      valid = false;
  }
  if (value.reason === undefined && (value.status !== undefined || value.provider !== undefined)) {
    addValidationError(errors, "EVIDENCE_MALFORMED", `${path}: status/provider requires reason`);
    valid = false;
  }
  return valid;
}

function validateStructuredEffectFailure(value, path, errors) {
  if (!isRecord(value)) {
    addValidationError(errors, "EVIDENCE_MALFORMED", `${path}: must be an object`);
    return false;
  }
  const keys = new Set(["reason", "status", "provider"]);
  rejectUnknownKeys(value, keys, path, errors);
  let valid = STRUCTURED_FAILURE_REASONS.has(value.reason);
  if (!valid) addValidationError(errors, "EVIDENCE_MALFORMED", `${path}.reason: unsupported value`);
  if (value.status !== undefined) {
    if (
      value.reason !== "provider-http" ||
      !Number.isSafeInteger(value.status) ||
      value.status < 100 ||
      value.status > 599
    ) {
      addValidationError(errors, "EVIDENCE_MALFORMED", `${path}.status: must be an HTTP status for provider-http`);
      valid = false;
    }
  }
  if (value.provider !== undefined) {
    if (value.reason !== "provider-http" || !validateStructuredProvider(value.provider, `${path}.provider`, errors))
      valid = false;
  }
  return valid;
}

function validateStructuredEffects(value, path, errors) {
  if (!Array.isArray(value) || value.length > 8) {
    addValidationError(errors, "EVIDENCE_MALFORMED", `${path}: must contain at most 8 entries`);
    return false;
  }
  let valid = true;
  for (let index = 0; index < value.length; index += 1) {
    const effect = value[index];
    const effectPath = `${path}[${String(index)}]`;
    if (!isRecord(effect)) {
      addValidationError(errors, "EVIDENCE_MALFORMED", `${effectPath}: must be an object`);
      valid = false;
      continue;
    }
    rejectUnknownKeys(effect, STRUCTURED_EFFECT_KEYS, effectPath, errors);
    if (
      !STRUCTURED_EFFECT_KINDS.has(effect.kind) ||
      !validateSafeStructuredString(effect.kind, `${effectPath}.kind`, errors, 64)
    )
      valid = false;
    if (effect.status !== "succeeded" && effect.status !== "failed") {
      addValidationError(errors, "EVIDENCE_MALFORMED", `${effectPath}.status: unsupported value`);
      valid = false;
    }
    if (effect.createdCommitSha !== undefined) {
      if (
        (effect.kind !== "CREATE_BRANCH" && effect.kind !== "CREATE_PROVENANCE_COMMIT") ||
        effect.status !== "succeeded" ||
        typeof effect.createdCommitSha !== "string" ||
        !/^[0-9a-f]{40}$/iu.test(effect.createdCommitSha)
      ) {
        addValidationError(errors, "EVIDENCE_MALFORMED", `${effectPath}.createdCommitSha: invalid commit SHA`);
        valid = false;
      }
    }
  }
  return valid;
}

function validateStructuredExecutionEvidence(value, path, errors) {
  if (!isRecord(value)) {
    addValidationError(errors, "EVIDENCE_MALFORMED", `${path}: must be an object`);
    return false;
  }
  rejectUnknownKeys(value, STRUCTURED_EXECUTION_EVIDENCE_KEYS, path, errors);
  let valid = value.version === 1;
  if (!valid) addValidationError(errors, "EVIDENCE_MALFORMED", `${path}.version: must be 1`);
  valid =
    STRUCTURED_EXECUTION_OPERATIONS.has(value.operation) &&
    validateSafeStructuredString(value.operation, `${path}.operation`, errors, 64) &&
    valid;
  valid =
    STRUCTURED_EXECUTION_OUTCOMES.has(value.outcome) &&
    validateSafeStructuredString(value.outcome, `${path}.outcome`, errors, 64) &&
    valid;
  if (value.requester !== undefined)
    valid = validateSafeStructuredString(value.requester, `${path}.requester`, errors, 160) && valid;
  if (value.issuer !== undefined)
    valid = validateSafeStructuredString(value.issuer, `${path}.issuer`, errors, 160) && valid;
  valid = validateStructuredEffects(value.effects, `${path}.effects`, errors) && valid;
  if (value.compensation !== undefined && !["not-required", "succeeded", "failed"].includes(value.compensation)) {
    addValidationError(errors, "EVIDENCE_MALFORMED", `${path}.compensation: unsupported value`);
    valid = false;
  }
  if (value.failure !== undefined) valid = validateStructuredFailure(value.failure, `${path}.failure`, errors) && valid;
  if (value.compensationFailure !== undefined)
    valid = validateStructuredFailure(value.compensationFailure, `${path}.compensationFailure`, errors) && valid;
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_STRUCTURED_DIAGNOSTIC_BYTES) {
      addValidationError(errors, "EVIDENCE_MALFORMED", `${path}: exceeds the bounded evidence size`);
      valid = false;
    }
  } catch {
    addValidationError(errors, "EVIDENCE_MALFORMED", `${path}: must be JSON-serializable`);
    valid = false;
  }
  return valid;
}

function validateStructuredChangeDiagnostics(value, path, errors) {
  if (!Array.isArray(value) || value.length > MAX_STRUCTURED_DIAGNOSTICS) {
    addValidationError(
      errors,
      "EVIDENCE_MALFORMED",
      `${path}: must contain at most ${String(MAX_STRUCTURED_DIAGNOSTICS)} entries`,
    );
    return false;
  }
  let valid = true;
  for (let index = 0; index < value.length; index += 1) {
    const diagnostic = value[index];
    const diagnosticPath = `${path}[${String(index)}]`;
    if (!isRecord(diagnostic)) {
      addValidationError(errors, "EVIDENCE_MALFORMED", `${diagnosticPath}: must be an object`);
      valid = false;
      continue;
    }
    rejectUnknownKeys(diagnostic, new Set(["version", "code", "path", "message"]), diagnosticPath, errors);
    if (diagnostic.version !== 1) {
      addValidationError(errors, "EVIDENCE_MALFORMED", `${diagnosticPath}.version: must be 1`);
      valid = false;
    }
    valid = validateSafeStructuredString(diagnostic.code, `${diagnosticPath}.code`, errors, 128) && valid;
    valid = validateSafeStructuredString(diagnostic.path, `${diagnosticPath}.path`, errors, 160) && valid;
    valid = validateSafeStructuredString(diagnostic.message, `${diagnosticPath}.message`, errors, 240) && valid;
  }
  return valid;
}

function validateStructuredRecovery(value, path, errors) {
  if (!isRecord(value)) {
    addValidationError(errors, "EVIDENCE_MALFORMED", `${path}: must be an object`);
    return false;
  }
  rejectUnknownKeys(value, STRUCTURED_RECOVERY_KEYS, path, errors);
  let valid = validateSafeStructuredString(value.state, `${path}.state`, errors, 64);
  if (value.action !== null && value.action !== undefined)
    valid = validateSafeStructuredString(value.action, `${path}.action`, errors, 128) && valid;
  return valid;
}

function validateStructuredDetails(value, path, errors) {
  if (!isRecord(value)) {
    addValidationError(errors, "EVIDENCE_MALFORMED", `${path}: must be an object`);
    return false;
  }
  rejectUnknownKeys(value, STRUCTURED_DETAIL_KEYS, path, errors);
  let valid = true;
  for (const key of ["operation", "reason", "stage", "stageReason", "trustedCode", "path", "field", "category"]) {
    if (value[key] !== undefined) valid = validateSafeStructuredString(value[key], `${path}.${key}`, errors) && valid;
  }
  for (const key of ["issue", "status", "version"]) {
    if (value[key] !== undefined) valid = requirePositiveInteger(value[key], `${path}.${key}`, errors) && valid;
  }
  if (value.recovery !== undefined)
    valid = validateStructuredRecovery(value.recovery, `${path}.recovery`, errors) && valid;
  if (value.provider !== undefined)
    valid = validateStructuredProvider(value.provider, `${path}.provider`, errors) && valid;
  if (value.effectFailure !== undefined)
    valid = validateStructuredEffectFailure(value.effectFailure, `${path}.effectFailure`, errors) && valid;
  if (value.diagnostics !== undefined)
    valid = validateStructuredChangeDiagnostics(value.diagnostics, `${path}.diagnostics`, errors) && valid;
  if (value.evidence !== undefined)
    valid = validateStructuredExecutionEvidence(value.evidence, `${path}.evidence`, errors) && valid;
  return valid;
}

function validateStructuredDiagnosticFields(value, path, errors) {
  let valid = true;
  if (value.details !== undefined) valid = validateStructuredDetails(value.details, `${path}.details`, errors) && valid;
  if (value.diagnostics !== undefined)
    valid = validateStructuredChangeDiagnostics(value.diagnostics, `${path}.diagnostics`, errors) && valid;
  if (value.evidence !== undefined)
    valid = validateStructuredExecutionEvidence(value.evidence, `${path}.evidence`, errors) && valid;
  return valid;
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

function validateWorkflowIdentity(value, errors) {
  if (!isRecord(value)) {
    addValidationError(errors, "DOGFOOD_IDENTITY_INVALID", "$.workflow: must be an object");
    return false;
  }
  rejectUnknownKeys(value, WORKFLOW_KEYS, "$.workflow", errors);
  const runIdValid = requireString(value.runId, "$.workflow.runId", errors, {
    pattern: WORKFLOW_RUN_ID_PATTERN,
    maxLength: 20,
    diagnosticCode: "DOGFOOD_IDENTITY_INVALID",
  });
  const runAttemptValid = requireString(value.runAttempt, "$.workflow.runAttempt", errors, {
    pattern: WORKFLOW_RUN_ATTEMPT_PATTERN,
    maxLength: 10,
    diagnosticCode: "DOGFOOD_IDENTITY_INVALID",
  });
  return runIdValid && runAttemptValid;
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
    ? new Set([...CERTIFICATION_FINAL_STATE_TERMINAL_STATUSES, CERTIFICATION_FINAL_STATE_UNAVAILABLE_STATUS])
    : new Set(CERTIFICATION_FINAL_STATE_TERMINAL_STATUSES);
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
  const workflowValid = validateWorkflowIdentity(value.workflow, errors);
  const rootIssueValid = requirePositiveInteger(value.rootIssue, "$.rootIssue", errors, "DOGFOOD_IDENTITY_INVALID");
  const changeValid = validateChangeIdentity(value.change, value.rootIssue, errors, { allowUnavailable: !strict });
  const operationsValid = validateOperationEntries(value.operations, errors, {
    strictSequence: strict,
    finalStatus: value.finalState?.status,
  });
  const finalStateValid = validateFinalState(value.finalState, errors, { allowUnavailable: !strict });
  return repositoryValid && workflowValid && rootIssueValid && changeValid && operationsValid && finalStateValid;
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
    common.workflow = { runId: value.workflow.runId, runAttempt: value.workflow.runAttempt };
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
  common.diagnostics = value.diagnostics.map(({ code, message, details, diagnostics, evidence }) => ({
    code,
    message,
    ...(details === undefined ? {} : { details }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(evidence === undefined ? {} : { evidence }),
  }));
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
