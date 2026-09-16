/**
 * Deterministic conformance verification for one authorized Implementation
 * and one provider-reread pull request.
 *
 * The input deliberately contains no contract or scope supplied by the
 * caller.  The current Issue body is reread evidence, the authorization is
 * verified by #572, the execution scope is projected by #574, and the PR is
 * normalized by the Operational Observation boundary before any comparison.
 */

import {
  tryVerifyImplementationAuthorization,
  type ImplementationAuthorizationRecord,
  type ImplementationAuthorizationViolationCode,
  type ImplementationBaseEvidence,
  type ImplementationIssueAuthorizationEvidence,
} from "./implementation-authorization.js";
import {
  isImplementationScopeProjectionPathAllowed,
  isImplementationScopeProjectionPathDenied,
  tryProjectImplementationScope,
  type ImplementationScopeProjection,
  type ImplementationScopeProjectionViolationCode,
} from "./implementation-scope-projection.js";
import {
  tryObserveOperationalPullRequest,
  type OperationalChangedFile,
  type OperationalPullRequestObservation,
} from "./operational-observation.js";
import type { ImplementationContract, ImplementationRepositoryIdentity } from "./implementation-contract.js";

export const IMPLEMENTATION_CONFORMANCE_VERSION = 1 as const;
export type ImplementationConformanceVersion = typeof IMPLEMENTATION_CONFORMANCE_VERSION;
export const IMPLEMENTATION_CONFORMANCE_KIND = "implementation-conformance" as const;

export const IMPLEMENTATION_CONFORMANCE_STATUSES = Object.freeze([
  "conformant",
  "scope-violation",
  "stale-invalid-authorization",
  "missing-verification",
  "unverifiable",
] as const);
export type ImplementationConformanceStatus = (typeof IMPLEMENTATION_CONFORMANCE_STATUSES)[number];

/** The current authoritative Issue reread paired with the authorization. */
export type ImplementationConformanceIssueEvidence = Pick<
  ImplementationIssueAuthorizationEvidence,
  "reference" | "body"
>;

/**
 * Provider evidence accepted by the Core boundary.  `pullRequest` is the
 * adapter-normalized model, never an arbitrary GitHub payload.
 */
export interface ImplementationConformanceInput {
  readonly authorization: unknown;
  readonly issue: ImplementationConformanceIssueEvidence;
  readonly repository: ImplementationRepositoryIdentity;
  readonly base: ImplementationBaseEvidence;
  /** The PR number requested by the caller and bound to the reread. */
  readonly pullRequestNumber: number;
  /** Provider evidence normalized by the Operational Observation boundary. */
  readonly pullRequest: unknown;
  readonly supersession?: unknown;
  readonly completed?: boolean;
}

export type ImplementationConformanceChangeOperation = "WRITE" | "CREATE" | "DELETE";

export interface ImplementationConformanceChange {
  readonly operation: ImplementationConformanceChangeOperation;
  readonly path: string;
  readonly allowed: boolean;
  readonly denied: boolean;
}

export interface ImplementationConformanceBinding {
  readonly pullRequest: "matched" | "mismatch" | "unverifiable";
  readonly repository: "matched" | "mismatch" | "unverifiable";
  readonly base: "matched" | "mismatch" | "unverifiable";
  readonly branch: "matched" | "mismatch" | "unverifiable";
}

export interface ImplementationConformancePullRequestIdentity {
  readonly number: number;
  readonly repository: {
    readonly host: string;
    readonly nameWithOwner: string;
    readonly repositoryId?: string;
  };
  readonly head: { readonly branch: string; readonly revision: string };
  readonly base: { readonly branch: string; readonly revision: string };
}

export interface ImplementationConformanceVerification {
  readonly requiredChecks: readonly string[];
  readonly requiredTests: readonly string[];
  readonly satisfiedChecks: readonly string[];
  readonly satisfiedTests: readonly string[];
  readonly missingChecks: readonly string[];
  readonly missingTests: readonly string[];
  readonly failedChecks: readonly string[];
  readonly failedTests: readonly string[];
  readonly unverifiableChecks: readonly string[];
  readonly unverifiableTests: readonly string[];
}

export interface ImplementationConformanceAuthorization {
  readonly status?: string;
  readonly authorized: boolean;
  readonly current: boolean;
  readonly violations: readonly {
    readonly code: ImplementationAuthorizationViolationCode;
    readonly path: string;
    readonly message: string;
  }[];
}

export type ImplementationConformanceDiagnosticCode =
  | ImplementationAuthorizationViolationCode
  | ImplementationScopeProjectionViolationCode
  | "IMPLEMENTATION_CONFORMANCE_INPUT_INVALID"
  | "IMPLEMENTATION_CONFORMANCE_PROVIDER_EVIDENCE_INVALID"
  | "IMPLEMENTATION_CONFORMANCE_PR_IDENTITY_MISMATCH"
  | "IMPLEMENTATION_CONFORMANCE_PR_IDENTITY_UNVERIFIABLE"
  | "IMPLEMENTATION_CONFORMANCE_REPOSITORY_MISMATCH"
  | "IMPLEMENTATION_CONFORMANCE_REPOSITORY_UNVERIFIABLE"
  | "IMPLEMENTATION_CONFORMANCE_BASE_MISMATCH"
  | "IMPLEMENTATION_CONFORMANCE_BASE_UNVERIFIABLE"
  | "IMPLEMENTATION_CONFORMANCE_BRANCH_MISMATCH"
  | "IMPLEMENTATION_CONFORMANCE_BRANCH_UNVERIFIABLE"
  | "IMPLEMENTATION_CONFORMANCE_HEAD_UNVERIFIABLE"
  | "IMPLEMENTATION_CONFORMANCE_CHANGED_FILES_UNAVAILABLE"
  | "IMPLEMENTATION_CONFORMANCE_CHANGED_FILES_INCOMPLETE"
  | "IMPLEMENTATION_CONFORMANCE_PATH_INVALID"
  | "IMPLEMENTATION_CONFORMANCE_FILE_STATUS_UNSUPPORTED"
  | "IMPLEMENTATION_CONFORMANCE_SCOPE_VIOLATION"
  | "IMPLEMENTATION_CONFORMANCE_DENIED_PATH"
  | "IMPLEMENTATION_CONFORMANCE_VERIFICATION_UNAVAILABLE"
  | "IMPLEMENTATION_CONFORMANCE_CHECK_MISSING"
  | "IMPLEMENTATION_CONFORMANCE_CHECK_FAILED"
  | "IMPLEMENTATION_CONFORMANCE_CHECK_UNVERIFIABLE"
  | "IMPLEMENTATION_CONFORMANCE_TEST_MISSING"
  | "IMPLEMENTATION_CONFORMANCE_TEST_FAILED"
  | "IMPLEMENTATION_CONFORMANCE_TEST_UNVERIFIABLE";

export interface ImplementationConformanceDiagnostic {
  readonly code: ImplementationConformanceDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface ImplementationConformanceResult {
  readonly version: ImplementationConformanceVersion;
  readonly kind: typeof IMPLEMENTATION_CONFORMANCE_KIND;
  readonly status: ImplementationConformanceStatus;
  readonly valid: boolean;
  readonly authorization: ImplementationConformanceAuthorization;
  readonly binding?: ImplementationConformanceBinding;
  readonly pullRequest?: ImplementationConformancePullRequestIdentity;
  readonly changes: readonly ImplementationConformanceChange[];
  readonly verification: ImplementationConformanceVerification;
  readonly diagnostics: readonly ImplementationConformanceDiagnostic[];
}

export class ImplementationConformanceError extends Error {
  readonly code = "IMPLEMENTATION_CONFORMANCE_FAILED" as const;
  readonly result: ImplementationConformanceResult;

  constructor(result: ImplementationConformanceResult) {
    super(result.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n"));
    this.name = "ImplementationConformanceError";
    this.result = result;
  }
}

const INPUT_KEYS = new Set([
  "authorization",
  "issue",
  "repository",
  "base",
  "pullRequestNumber",
  "pullRequest",
  "supersession",
  "completed",
]);
const ISSUE_KEYS = new Set(["reference", "body"]);
const SAFE_PATH_MAX_LENGTH = 1_024;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeDeep<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => freezeDeep(entry))) as T;
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareStrings)) result[key] = freezeDeep(value[key]);
    return Object.freeze(result) as T;
  }
  return value;
}

function diagnostic(
  diagnostics: ImplementationConformanceDiagnostic[],
  code: ImplementationConformanceDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function sortDiagnostics(
  diagnostics: readonly ImplementationConformanceDiagnostic[],
): readonly ImplementationConformanceDiagnostic[] {
  return [...diagnostics].sort(
    (left, right) =>
      left.path.localeCompare(right.path, "en-US") ||
      left.code.localeCompare(right.code, "en-US") ||
      left.message.localeCompare(right.message, "en-US"),
  );
}

function sortChanges(changes: readonly ImplementationConformanceChange[]): readonly ImplementationConformanceChange[] {
  return [...changes].sort(
    (left, right) =>
      left.path.localeCompare(right.path, "en-US") || left.operation.localeCompare(right.operation, "en-US"),
  );
}

function normalizePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/{2,}/gu, "/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.length > SAFE_PATH_MAX_LENGTH ||
    normalized.startsWith("/") ||
    segments.some((segment) => segment === ".." || segment.length === 0) ||
    /^[A-Za-z]:/u.test(normalized)
  )
    return undefined;
  return normalized.replace(/^\.\//u, "");
}

function authorizationSummary(
  verification: ReturnType<typeof tryVerifyImplementationAuthorization>,
): ImplementationConformanceAuthorization {
  return {
    ...(verification.status === undefined ? {} : { status: verification.status }),
    authorized: verification.authorized,
    current: verification.current,
    violations: verification.violations.map(({ code, path, message }) => ({ code, path, message })),
  };
}

function emptyVerification(): ImplementationConformanceVerification {
  return {
    requiredChecks: [],
    requiredTests: [],
    satisfiedChecks: [],
    satisfiedTests: [],
    missingChecks: [],
    missingTests: [],
    failedChecks: [],
    failedTests: [],
    unverifiableChecks: [],
    unverifiableTests: [],
  };
}

function baseResult(
  status: ImplementationConformanceStatus,
  authorization: ImplementationConformanceAuthorization,
  diagnostics: readonly ImplementationConformanceDiagnostic[],
  values: {
    readonly binding?: ImplementationConformanceBinding;
    readonly pullRequest?: ImplementationConformancePullRequestIdentity;
    readonly changes?: readonly ImplementationConformanceChange[];
    readonly verification?: ImplementationConformanceVerification;
  } = {},
): ImplementationConformanceResult {
  return freezeDeep({
    version: IMPLEMENTATION_CONFORMANCE_VERSION,
    kind: IMPLEMENTATION_CONFORMANCE_KIND,
    status,
    valid: status === "conformant",
    authorization,
    ...(values.binding === undefined ? {} : { binding: values.binding }),
    ...(values.pullRequest === undefined ? {} : { pullRequest: values.pullRequest }),
    changes: values.changes ?? [],
    verification: values.verification ?? emptyVerification(),
    diagnostics: sortDiagnostics(diagnostics),
  });
}

function inputRecord(input: unknown, diagnostics: ImplementationConformanceDiagnostic[]): RecordValue | undefined {
  if (!isRecord(input)) {
    diagnostic(diagnostics, "IMPLEMENTATION_CONFORMANCE_INPUT_INVALID", "$", "Conformance input must be an object.");
    return undefined;
  }
  for (const key of Object.keys(input).sort(compareStrings)) {
    if (!INPUT_KEYS.has(key))
      diagnostic(diagnostics, "IMPLEMENTATION_CONFORMANCE_INPUT_INVALID", `$.${key}`, "Property is not supported.");
  }
  const issue = input.issue;
  if (isRecord(issue)) {
    for (const key of Object.keys(issue).sort(compareStrings)) {
      if (!ISSUE_KEYS.has(key))
        diagnostic(
          diagnostics,
          "IMPLEMENTATION_CONFORMANCE_INPUT_INVALID",
          `$.issue.${key}`,
          "Property is not supported.",
        );
    }
  }
  return input;
}

function issueForAuthorization(value: RecordValue): RecordValue | undefined {
  if (!hasOwn(value, "issue")) return undefined;
  const issue = value.issue;
  return isRecord(issue) ? { reference: issue.reference, body: issue.body } : (issue as RecordValue);
}

function buildAuthorizationVerification(
  value: RecordValue | undefined,
): ReturnType<typeof tryVerifyImplementationAuthorization> {
  const input: Record<string, unknown> = { authorization: value?.authorization };
  if (value !== undefined) {
    if (hasOwn(value, "issue")) input.issue = issueForAuthorization(value);
    if (hasOwn(value, "repository")) input.repository = value.repository;
    if (hasOwn(value, "base")) input.base = value.base;
    if (hasOwn(value, "supersession")) input.supersession = value.supersession;
    if (hasOwn(value, "completed")) input.completed = value.completed;
  }
  return tryVerifyImplementationAuthorization(input);
}

function currentIssueIsValid(value: RecordValue | undefined): boolean {
  if (value === undefined || !isRecord(value.issue)) return false;
  return typeof value.issue.body === "string" && isRecord(value.issue.reference);
}

function authorizationMatchesContract(
  authorization: ImplementationAuthorizationRecord,
  contract: ImplementationContract,
  diagnostics: ImplementationConformanceDiagnostic[],
): boolean {
  let matches = true;
  if (
    authorization.repository.repositoryHost !== contract.repository.repositoryHost ||
    authorization.repository.repositoryId !== contract.repository.repositoryId
  ) {
    matches = false;
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_AUTHORIZATION_BINDING_DRIFT",
      "$.authorization.repository",
      "Authorization repository identity does not match the authorized contract.",
    );
  }
  if (
    authorization.base.branch !== contract.execution.baseBranch ||
    contract.execution.baseRevision === undefined ||
    authorization.base.revision !== contract.execution.baseRevision ||
    contract.execution.baseFreshness === undefined ||
    authorization.base.freshness !== contract.execution.baseFreshness
  ) {
    matches = false;
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_AUTHORIZATION_BINDING_DRIFT",
      "$.authorization.base",
      "Authorization base evidence does not match the authorized contract.",
    );
  }
  return matches;
}

function pullRequestIdentity(
  observation: OperationalPullRequestObservation,
): ImplementationConformancePullRequestIdentity {
  return {
    number: observation.number,
    repository: {
      host: observation.repository.host,
      nameWithOwner: observation.repository.nameWithOwner,
      ...(observation.repository.repositoryId === undefined
        ? {}
        : { repositoryId: observation.repository.repositoryId }),
    },
    head: { branch: observation.head.branch, revision: observation.head.sha },
    base: { branch: observation.base.branch, revision: observation.base.sha },
  };
}

function checkBinding(
  authorization: ImplementationAuthorizationRecord,
  contract: ImplementationContract,
  expectedPullRequestNumber: unknown,
  observation: OperationalPullRequestObservation,
  diagnostics: ImplementationConformanceDiagnostic[],
): ImplementationConformanceBinding {
  let pullRequest: ImplementationConformanceBinding["pullRequest"] = "matched";
  if (
    typeof expectedPullRequestNumber !== "number" ||
    !Number.isSafeInteger(expectedPullRequestNumber) ||
    expectedPullRequestNumber < 1
  ) {
    pullRequest = "unverifiable";
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CONFORMANCE_PR_IDENTITY_UNVERIFIABLE",
      "$.pullRequestNumber",
      "The requested pull-request identity is unavailable.",
    );
  } else if (observation.number !== expectedPullRequestNumber) {
    pullRequest = "mismatch";
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CONFORMANCE_PR_IDENTITY_MISMATCH",
      "$.pullRequest.number",
      "Reread pull-request identity does not match the requested pull request.",
    );
  }
  const expectedRepository = authorization.repository;
  const actualRepository = observation.repository;
  let repository: ImplementationConformanceBinding["repository"] = "matched";
  if (actualRepository.repositoryId === undefined) {
    repository = "unverifiable";
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CONFORMANCE_REPOSITORY_UNVERIFIABLE",
      "$.pullRequest.repository.repositoryId",
      "Pull-request repository identity is unavailable.",
    );
  } else if (
    actualRepository.repositoryId !== expectedRepository.repositoryId ||
    actualRepository.host !== expectedRepository.repositoryHost ||
    (expectedRepository.repository !== undefined &&
      actualRepository.nameWithOwner.toLocaleLowerCase("en-US") !== expectedRepository.repository)
  ) {
    repository = "mismatch";
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CONFORMANCE_REPOSITORY_MISMATCH",
      "$.pullRequest.repository",
      "Pull-request repository identity does not match the authorization.",
    );
  }

  let base: ImplementationConformanceBinding["base"] = "matched";
  if (observation.base.branch === "unknown" || observation.base.sha === "unknown") {
    base = "unverifiable";
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CONFORMANCE_BASE_UNVERIFIABLE",
      "$.pullRequest.base",
      "Pull-request base branch and revision evidence is unavailable.",
    );
  } else if (
    observation.base.branch !== authorization.base.branch ||
    observation.base.sha !== authorization.base.revision
  ) {
    base = "mismatch";
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CONFORMANCE_BASE_MISMATCH",
      "$.pullRequest.base",
      "Pull-request base does not match the authorized base.",
    );
  }

  let branch: ImplementationConformanceBinding["branch"] = "matched";
  const expectedBranch = contract.execution.branch;
  if (expectedBranch === undefined || observation.head.branch === "unknown") {
    branch = "unverifiable";
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CONFORMANCE_BRANCH_UNVERIFIABLE",
      "$.pullRequest.head.ref",
      "The intended implementation branch is unavailable.",
    );
  } else if (observation.head.branch !== expectedBranch) {
    branch = "mismatch";
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CONFORMANCE_BRANCH_MISMATCH",
      "$.pullRequest.head.ref",
      "Pull-request head branch does not match the Implementation execution binding.",
    );
  }
  if (observation.head.sha === "unknown")
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CONFORMANCE_HEAD_UNVERIFIABLE",
      "$.pullRequest.head.sha",
      "Pull-request head revision evidence is unavailable.",
    );

  return { pullRequest, repository, base, branch };
}

function operationForStatus(
  status: string | undefined,
): ImplementationConformanceChangeOperation | "RENAME" | "UNKNOWN" {
  switch (status) {
    case "modified":
    case "changed":
      return "WRITE";
    case "added":
    case "copied":
      return "CREATE";
    case "removed":
    case "deleted":
      return "DELETE";
    case "renamed":
      return "RENAME";
    default:
      return "UNKNOWN";
  }
}

function evaluateChange(
  projection: ImplementationScopeProjection,
  operation: ImplementationConformanceChangeOperation,
  path: string,
  changes: ImplementationConformanceChange[],
  diagnostics: ImplementationConformanceDiagnostic[],
): void {
  const denied = isImplementationScopeProjectionPathDenied(projection, path);
  const allowed = !denied && isImplementationScopeProjectionPathAllowed(projection, operation, path);
  changes.push({ operation, path, allowed, denied });
  if (denied)
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CONFORMANCE_DENIED_PATH",
      `$.pullRequest.changedFiles.${path}`,
      "Changed path is explicitly denied by the Implementation.",
    );
  else if (!allowed)
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CONFORMANCE_SCOPE_VIOLATION",
      `$.pullRequest.changedFiles.${path}`,
      "Changed path is outside the authorized operation scope.",
    );
}

function evaluateFile(
  projection: ImplementationScopeProjection,
  file: OperationalChangedFile,
  index: number,
  changes: ImplementationConformanceChange[],
  diagnostics: ImplementationConformanceDiagnostic[],
): boolean {
  const path = normalizePath(file.filename);
  if (path === undefined) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CONFORMANCE_PATH_INVALID",
      `$.pullRequest.changedFiles.items[${index}].filename`,
      "Changed file path is not a safe repository-relative path.",
    );
    return false;
  }
  const operation = operationForStatus(file.status);
  if (operation === "UNKNOWN") {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CONFORMANCE_FILE_STATUS_UNSUPPORTED",
      `$.pullRequest.changedFiles.items[${index}].status`,
      "Changed file operation is unavailable or unsupported.",
    );
    return false;
  }
  if (operation === "RENAME") {
    const previousPath = normalizePath(file.previousFilename);
    if (previousPath === undefined) {
      diagnostic(
        diagnostics,
        "IMPLEMENTATION_CONFORMANCE_FILE_STATUS_UNSUPPORTED",
        `$.pullRequest.changedFiles.items[${index}].previousFilename`,
        "A rename requires authoritative old and new paths.",
      );
      return false;
    }
    evaluateChange(projection, "DELETE", previousPath, changes, diagnostics);
    evaluateChange(projection, "CREATE", path, changes, diagnostics);
    return true;
  }
  evaluateChange(projection, operation, path, changes, diagnostics);
  return true;
}

function evaluateChanges(
  projection: ImplementationScopeProjection,
  observation: OperationalPullRequestObservation,
  diagnostics: ImplementationConformanceDiagnostic[],
): { readonly changes: readonly ImplementationConformanceChange[]; readonly unverifiable: boolean } {
  const collection = observation.changedFiles;
  if (collection.status !== "available") {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CONFORMANCE_CHANGED_FILES_UNAVAILABLE",
      "$.pullRequest.changedFiles",
      "Authoritative changed-file evidence is unavailable.",
    );
    return { changes: [], unverifiable: true };
  }
  if (
    collection.pagination.truncated ||
    collection.pagination.returned !== collection.items.length ||
    collection.diagnostics.length > 0
  ) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CONFORMANCE_CHANGED_FILES_INCOMPLETE",
      "$.pullRequest.changedFiles",
      "Authoritative changed-file evidence is incomplete.",
    );
    return { changes: [], unverifiable: true };
  }
  const changes: ImplementationConformanceChange[] = [];
  let unverifiable = false;
  collection.items.forEach((file, index) => {
    if (!evaluateFile(projection, file, index, changes, diagnostics)) unverifiable = true;
  });
  return { changes: sortChanges(changes), unverifiable };
}

type VerificationDisposition = "satisfied" | "missing" | "failed" | "unverifiable";

function checkDisposition(
  checks: OperationalPullRequestObservation["checks"]["items"],
  name: string,
): VerificationDisposition {
  const matches = checks.filter((check) => check.name === name);
  if (matches.length === 0) return "missing";
  const dispositions = matches.map((check): VerificationDisposition => {
    const status = check.status.toLowerCase();
    const conclusion = check.conclusion?.toLowerCase();
    if (
      status === "success" ||
      (status === "completed" && conclusion === "success") ||
      (status === "completed" && conclusion === undefined && check.kind === "status")
    )
      return "satisfied";
    if (
      status === "failure" ||
      status === "error" ||
      conclusion === "failure" ||
      conclusion === "timed_out" ||
      conclusion === "cancelled" ||
      conclusion === "startup_failure"
    )
      return "failed";
    if (
      status === "queued" ||
      status === "in_progress" ||
      status === "requested" ||
      status === "waiting" ||
      status === "pending"
    )
      return "failed";
    return "unverifiable";
  });
  if (dispositions.some((entry) => entry === "unverifiable")) return "unverifiable";
  if (dispositions.some((entry) => entry === "failed")) return "failed";
  return "satisfied";
}

function evaluateVerification(
  contract: ImplementationContract,
  observation: OperationalPullRequestObservation,
  diagnostics: ImplementationConformanceDiagnostic[],
): {
  readonly verification: ImplementationConformanceVerification;
  readonly missing: boolean;
  readonly unverifiable: boolean;
} {
  const requiredChecks = [...new Set(contract.verification.requiredChecks)].sort(compareStrings);
  const requiredTests = [...new Set(contract.verification.targetedTests)].sort(compareStrings);
  const result = {
    requiredChecks,
    requiredTests,
    satisfiedChecks: [] as string[],
    satisfiedTests: [] as string[],
    missingChecks: [] as string[],
    missingTests: [] as string[],
    failedChecks: [] as string[],
    failedTests: [] as string[],
    unverifiableChecks: [] as string[],
    unverifiableTests: [] as string[],
  };
  if (requiredChecks.length === 0 && requiredTests.length === 0)
    return { verification: result, missing: false, unverifiable: false };
  if (
    observation.checks.status !== "available" ||
    observation.checks.pagination.truncated ||
    observation.checks.pagination.returned !== observation.checks.items.length ||
    observation.checks.diagnostics.length > 0
  ) {
    diagnostic(
      diagnostics,
      "IMPLEMENTATION_CONFORMANCE_VERIFICATION_UNAVAILABLE",
      "$.pullRequest.checks",
      "Required verification evidence is unavailable or incomplete.",
    );
    return { verification: result, missing: false, unverifiable: true };
  }

  const groups = [["check", requiredChecks] as const, ["test", requiredTests] as const];
  let missing = false;
  let unverifiable = false;
  for (const [kind, names] of groups) {
    for (const [index, name] of names.entries()) {
      const disposition = checkDisposition(observation.checks.items, name);
      const key = kind === "check" ? "Checks" : "Tests";
      if (disposition === "satisfied") result[`satisfied${key}` as "satisfiedChecks" | "satisfiedTests"].push(name);
      else if (disposition === "missing") {
        result[`missing${key}` as "missingChecks" | "missingTests"].push(name);
        missing = true;
        diagnostic(
          diagnostics,
          kind === "check" ? "IMPLEMENTATION_CONFORMANCE_CHECK_MISSING" : "IMPLEMENTATION_CONFORMANCE_TEST_MISSING",
          `$.verification.${kind === "check" ? "requiredChecks" : "targetedTests"}[${index}]`,
          "Required verification evidence is missing.",
        );
      } else if (disposition === "failed") {
        result[`failed${key}` as "failedChecks" | "failedTests"].push(name);
        missing = true;
        diagnostic(
          diagnostics,
          kind === "check" ? "IMPLEMENTATION_CONFORMANCE_CHECK_FAILED" : "IMPLEMENTATION_CONFORMANCE_TEST_FAILED",
          `$.verification.${kind === "check" ? "requiredChecks" : "targetedTests"}[${index}]`,
          "Required verification evidence is not successful.",
        );
      } else {
        result[`unverifiable${key}` as "unverifiableChecks" | "unverifiableTests"].push(name);
        unverifiable = true;
        diagnostic(
          diagnostics,
          kind === "check"
            ? "IMPLEMENTATION_CONFORMANCE_CHECK_UNVERIFIABLE"
            : "IMPLEMENTATION_CONFORMANCE_TEST_UNVERIFIABLE",
          `$.verification.${kind === "check" ? "requiredChecks" : "targetedTests"}[${index}]`,
          "Required verification evidence has an indeterminate result.",
        );
      }
    }
  }
  return { verification: result, missing, unverifiable };
}

/** Verify one current authorized Implementation against authoritative PR evidence. */
export function tryVerifyImplementationConformance(input: unknown): ImplementationConformanceResult {
  const inputDiagnostics: ImplementationConformanceDiagnostic[] = [];
  const value = inputRecord(input, inputDiagnostics);
  const authorizationVerification = buildAuthorizationVerification(value);
  const authorization = authorizationSummary(authorizationVerification);
  for (const violation of authorizationVerification.violations)
    diagnostic(inputDiagnostics, violation.code, violation.path, violation.message);
  if (
    !authorizationVerification.valid ||
    !authorizationVerification.authorized ||
    !authorizationVerification.current ||
    authorizationVerification.status !== "authorized" ||
    authorizationVerification.authorization === undefined ||
    authorizationVerification.contract === undefined ||
    !currentIssueIsValid(value)
  )
    return baseResult("stale-invalid-authorization", authorization, inputDiagnostics);
  if (inputDiagnostics.some((entry) => entry.code === "IMPLEMENTATION_CONFORMANCE_INPUT_INVALID"))
    return baseResult("unverifiable", authorization, inputDiagnostics);
  if (
    !authorizationMatchesContract(
      authorizationVerification.authorization,
      authorizationVerification.contract,
      inputDiagnostics,
    )
  )
    return baseResult("stale-invalid-authorization", authorization, inputDiagnostics);

  const providerResult = tryObserveOperationalPullRequest({ pullRequest: value?.pullRequest });
  if (!providerResult.valid || providerResult.observation === undefined) {
    diagnostic(
      inputDiagnostics,
      "IMPLEMENTATION_CONFORMANCE_PROVIDER_EVIDENCE_INVALID",
      "$.pullRequest",
      "Provider pull-request evidence could not be normalized.",
    );
    return baseResult("unverifiable", authorization, inputDiagnostics);
  }
  const observation = providerResult.observation;
  const binding = checkBinding(
    authorizationVerification.authorization,
    authorizationVerification.contract,
    value?.pullRequestNumber,
    observation,
    inputDiagnostics,
  );
  const pullRequest = pullRequestIdentity(observation);
  if (
    binding.pullRequest !== "matched" ||
    binding.repository !== "matched" ||
    binding.base !== "matched" ||
    binding.branch !== "matched" ||
    observation.head.sha === "unknown"
  )
    return baseResult("unverifiable", authorization, inputDiagnostics, { binding, pullRequest });

  const projectionResult = tryProjectImplementationScope({
    authorization: authorizationVerification.authorization,
    issue: value?.issue,
    repository: value?.repository,
    base: value?.base,
  });
  if (!projectionResult.valid || projectionResult.projection === undefined) {
    for (const violation of projectionResult.violations)
      diagnostic(inputDiagnostics, violation.code, violation.path, violation.message);
    return baseResult("stale-invalid-authorization", authorization, inputDiagnostics, { binding, pullRequest });
  }

  const changeResult = evaluateChanges(projectionResult.projection, observation, inputDiagnostics);
  const verificationResult = evaluateVerification(authorizationVerification.contract, observation, inputDiagnostics);
  const hasScopeViolation = changeResult.changes.some((change) => !change.allowed || change.denied);
  const status = hasScopeViolation
    ? "scope-violation"
    : verificationResult.missing
      ? "missing-verification"
      : changeResult.unverifiable || verificationResult.unverifiable
        ? "unverifiable"
        : "conformant";
  return baseResult(status, authorization, inputDiagnostics, {
    binding,
    pullRequest,
    changes: changeResult.changes,
    verification: verificationResult.verification,
  });
}

/** Throwing entry point for callers that require conformance. */
export function verifyImplementationConformance(input: unknown): ImplementationConformanceResult {
  const result = tryVerifyImplementationConformance(input);
  if (!result.valid) throw new ImplementationConformanceError(result);
  return result;
}
