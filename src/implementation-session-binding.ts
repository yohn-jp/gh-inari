/**
 * Bounded binding between one current Implementation authorization and one
 * delegated Session task.
 *
 * This is a projection of the existing Implementation authorization record,
 * not another authorization or signing authority.  The projection contains
 * no governed Issue body; callers must first pass current evidence through
 * the existing authorization verifier.
 */

import { canonicalJsonString, type CanonicalJsonValue } from "./agent-authority/codec.js";
import { MAX_ISSUE_NUMBER } from "./agent-authority/capability.js";
import type { SessionCertificateTask } from "./agent-authority/session-certificate.js";
import {
  IMPLEMENTATION_AUTHORIZATION_KIND,
  IMPLEMENTATION_AUTHORIZATION_VERSION,
  tryVerifyImplementationAuthorization,
  type ImplementationAuthorizationVerificationInput,
  type ImplementationAuthorizationViolation,
  type ImplementationBaseEvidence,
} from "./implementation-authorization.js";
import { IMPLEMENTATION_CONTRACT_VERSION, type ImplementationRepositoryIdentity } from "./implementation-contract.js";
import { normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";

export const IMPLEMENTATION_SESSION_BINDING_VERSION = 1 as const;
export type ImplementationSessionBindingVersion = typeof IMPLEMENTATION_SESSION_BINDING_VERSION;
export const IMPLEMENTATION_SESSION_BINDING_KIND = "implementation-session-binding" as const;

/** The safe authorization identity retained by a Session Certificate. */
export interface ImplementationSessionAuthorizationIdentity {
  readonly version: typeof IMPLEMENTATION_AUTHORIZATION_VERSION;
  readonly kind: typeof IMPLEMENTATION_AUTHORIZATION_KIND;
  readonly contractVersion: typeof IMPLEMENTATION_CONTRACT_VERSION;
  readonly implementation: IssueReference;
  readonly governedBodyDigest: string;
}

/**
 * Exact current authorization identity needed by a delegated Implementation
 * Session.  Repository and base evidence remain explicit so substitution
 * across repositories or stale base snapshots cannot be hidden by the Issue
 * reference or digest alone.
 */
export interface ImplementationSessionAuthorizationBinding {
  readonly version: ImplementationSessionBindingVersion;
  readonly kind: typeof IMPLEMENTATION_SESSION_BINDING_KIND;
  readonly authorization: ImplementationSessionAuthorizationIdentity;
  readonly repository: ImplementationRepositoryIdentity;
  readonly base: ImplementationBaseEvidence;
  readonly task: SessionCertificateTask;
}

export interface ImplementationSessionAuthorizationBindingInput extends ImplementationAuthorizationVerificationInput {
  readonly task: unknown;
}

export type ImplementationSessionBindingViolationCode =
  | "IMPLEMENTATION_SESSION_BINDING_INVALID_ROOT"
  | "IMPLEMENTATION_SESSION_BINDING_UNKNOWN_PROPERTY"
  | "IMPLEMENTATION_SESSION_BINDING_INVALID_VALUE"
  | "IMPLEMENTATION_SESSION_BINDING_MISMATCH"
  | "IMPLEMENTATION_SESSION_BINDING_NOT_CURRENT"
  | ImplementationAuthorizationViolation["code"];

export interface ImplementationSessionBindingViolation {
  readonly code: ImplementationSessionBindingViolationCode;
  readonly path: string;
  readonly message: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface ImplementationSessionBindingResult {
  readonly valid: boolean;
  readonly binding?: ImplementationSessionAuthorizationBinding;
  readonly violations: readonly ImplementationSessionBindingViolation[];
}

export class ImplementationSessionBindingError extends Error {
  readonly code: ImplementationSessionBindingViolationCode;
  readonly violations: readonly ImplementationSessionBindingViolation[];

  constructor(violations: readonly ImplementationSessionBindingViolation[]) {
    const first = violations[0];
    if (first === undefined) throw new Error("Implementation Session binding errors require a violation.");
    super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
    this.name = "ImplementationSessionBindingError";
    this.code = first.code;
    this.violations = Object.freeze([...violations]);
  }
}

const BINDING_KEYS = new Set(["version", "kind", "authorization", "repository", "base", "task"]);
const AUTHORIZATION_KEYS = new Set(["version", "kind", "contractVersion", "implementation", "governedBodyDigest"]);
const REPOSITORY_KEYS = new Set(["repositoryHost", "repositoryId", "repository"]);
const BASE_KEYS = new Set(["branch", "revision", "freshness"]);
const TASK_KEYS = new Set(["kind", "number"]);
const INPUT_KEYS = new Set([
  "authorization",
  "implementation",
  "issue",
  "body",
  "repository",
  "base",
  "readiness",
  "supersession",
  "completed",
  "task",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function addViolation(
  violations: ImplementationSessionBindingViolation[],
  code: ImplementationSessionBindingViolationCode,
  path: string,
  message: string,
  expected?: unknown,
  actual?: unknown,
): void {
  violations.push({
    code,
    path,
    message,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  });
}

function unknownProperties(
  value: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  violations: ImplementationSessionBindingViolation[],
): void {
  for (const key of Object.keys(value).sort(compareStrings)) {
    if (!allowed.has(key))
      addViolation(
        violations,
        "IMPLEMENTATION_SESSION_BINDING_UNKNOWN_PROPERTY",
        `${path}.${key}`,
        "Property is not supported.",
      );
  }
}

function text(
  value: unknown,
  path: string,
  violations: ImplementationSessionBindingViolation[],
  pattern?: RegExp,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !SAFE_TEXT.test(value) ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    addViolation(violations, "IMPLEMENTATION_SESSION_BINDING_INVALID_VALUE", path, "Value is invalid.");
    return undefined;
  }
  return value;
}

function sameRepository(
  left: { readonly repositoryHost: string; readonly repositoryId: string },
  right: { readonly repositoryHost: string; readonly repositoryId: string },
): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

function validateTask(
  value: unknown,
  path: string,
  violations: ImplementationSessionBindingViolation[],
): SessionCertificateTask | undefined {
  if (!isRecord(value)) {
    addViolation(violations, "IMPLEMENTATION_SESSION_BINDING_INVALID_VALUE", path, "Session task must be an object.");
    return undefined;
  }
  unknownProperties(value, TASK_KEYS, path, violations);
  if (value.kind !== "issue")
    addViolation(
      violations,
      "IMPLEMENTATION_SESSION_BINDING_INVALID_VALUE",
      `${path}.kind`,
      'task.kind must be "issue".',
    );
  if (
    typeof value.number !== "number" ||
    !Number.isSafeInteger(value.number) ||
    value.number < 1 ||
    value.number > MAX_ISSUE_NUMBER
  ) {
    addViolation(
      violations,
      "IMPLEMENTATION_SESSION_BINDING_INVALID_VALUE",
      `${path}.number`,
      "Issue number is invalid.",
    );
    return undefined;
  }
  return { kind: "issue", number: value.number };
}

function validateRepository(
  value: unknown,
  path: string,
  violations: ImplementationSessionBindingViolation[],
): ImplementationRepositoryIdentity | undefined {
  if (!isRecord(value)) {
    addViolation(
      violations,
      "IMPLEMENTATION_SESSION_BINDING_INVALID_VALUE",
      path,
      "Repository identity must be an object.",
    );
    return undefined;
  }
  unknownProperties(value, REPOSITORY_KEYS, path, violations);
  const repositoryHost = text(value.repositoryHost, `${path}.repositoryHost`, violations);
  const repositoryId = text(value.repositoryId, `${path}.repositoryId`, violations, REPOSITORY_ID_PATTERN);
  const repository =
    value.repository === undefined
      ? undefined
      : text(value.repository, `${path}.repository`, violations, REPOSITORY_PATTERN);
  if (repositoryHost === undefined || repositoryId === undefined) return undefined;
  return { repositoryHost, repositoryId, ...(repository === undefined ? {} : { repository }) };
}

function validateBase(
  value: unknown,
  path: string,
  violations: ImplementationSessionBindingViolation[],
): ImplementationBaseEvidence | undefined {
  if (!isRecord(value)) {
    addViolation(violations, "IMPLEMENTATION_SESSION_BINDING_INVALID_VALUE", path, "Base evidence must be an object.");
    return undefined;
  }
  unknownProperties(value, BASE_KEYS, path, violations);
  const branch = text(value.branch, `${path}.branch`, violations, BRANCH_PATTERN);
  const revision = text(value.revision, `${path}.revision`, violations);
  const freshness = text(value.freshness, `${path}.freshness`, violations);
  if (branch === undefined || revision === undefined || freshness === undefined) return undefined;
  return { branch, revision, freshness };
}

function validateBinding(input: unknown): ImplementationSessionBindingResult {
  const violations: ImplementationSessionBindingViolation[] = [];
  if (!isRecord(input)) {
    addViolation(violations, "IMPLEMENTATION_SESSION_BINDING_INVALID_ROOT", "$", "Session binding must be an object.");
    return { valid: false, violations };
  }
  unknownProperties(input, BINDING_KEYS, "$", violations);
  if (input.version !== IMPLEMENTATION_SESSION_BINDING_VERSION)
    addViolation(
      violations,
      "IMPLEMENTATION_SESSION_BINDING_INVALID_VALUE",
      "$.version",
      "Binding version is unsupported.",
    );
  if (input.kind !== IMPLEMENTATION_SESSION_BINDING_KIND)
    addViolation(violations, "IMPLEMENTATION_SESSION_BINDING_INVALID_VALUE", "$.kind", "Binding kind is unsupported.");

  let authorization: ImplementationSessionAuthorizationIdentity | undefined;
  if (!isRecord(input.authorization)) {
    addViolation(
      violations,
      "IMPLEMENTATION_SESSION_BINDING_INVALID_VALUE",
      "$.authorization",
      "Authorization identity must be an object.",
    );
  } else {
    unknownProperties(input.authorization, AUTHORIZATION_KEYS, "$.authorization", violations);
    if (input.authorization.version !== IMPLEMENTATION_AUTHORIZATION_VERSION)
      addViolation(
        violations,
        "IMPLEMENTATION_SESSION_BINDING_INVALID_VALUE",
        "$.authorization.version",
        "Authorization version is unsupported.",
      );
    if (input.authorization.kind !== IMPLEMENTATION_AUTHORIZATION_KIND)
      addViolation(
        violations,
        "IMPLEMENTATION_SESSION_BINDING_INVALID_VALUE",
        "$.authorization.kind",
        "Authorization kind is unsupported.",
      );
    if (input.authorization.contractVersion !== IMPLEMENTATION_CONTRACT_VERSION)
      addViolation(
        violations,
        "IMPLEMENTATION_SESSION_BINDING_INVALID_VALUE",
        "$.authorization.contractVersion",
        "Contract version is unsupported.",
      );
    const reference = normalizeIssueReference(input.authorization.implementation, "$.authorization.implementation");
    if (!reference.valid || reference.reference === undefined)
      addViolation(
        violations,
        "IMPLEMENTATION_SESSION_BINDING_INVALID_VALUE",
        "$.authorization.implementation",
        "Implementation reference is invalid.",
      );
    const digest = text(
      input.authorization.governedBodyDigest,
      "$.authorization.governedBodyDigest",
      violations,
      SHA256_PATTERN,
    );
    if (reference.reference !== undefined && digest !== undefined)
      authorization = {
        version: IMPLEMENTATION_AUTHORIZATION_VERSION,
        kind: IMPLEMENTATION_AUTHORIZATION_KIND,
        contractVersion: IMPLEMENTATION_CONTRACT_VERSION,
        implementation: reference.reference,
        governedBodyDigest: digest,
      };
  }
  const repository = validateRepository(input.repository, "$.repository", violations);
  const base = validateBase(input.base, "$.base", violations);
  const task = validateTask(input.task, "$.task", violations);
  if (
    authorization !== undefined &&
    repository !== undefined &&
    !sameRepository(authorization.implementation, repository)
  )
    addViolation(
      violations,
      "IMPLEMENTATION_SESSION_BINDING_MISMATCH",
      "$.repository",
      "Binding repository must match the Implementation reference.",
    );
  if (authorization !== undefined && task !== undefined && task.number !== authorization.implementation.number)
    addViolation(
      violations,
      "IMPLEMENTATION_SESSION_BINDING_MISMATCH",
      "$.task.number",
      "Session task must target the Implementation Issue.",
    );
  if (
    violations.length > 0 ||
    authorization === undefined ||
    repository === undefined ||
    base === undefined ||
    task === undefined
  )
    return { valid: false, violations: Object.freeze([...violations]) };
  return {
    valid: true,
    binding: freezeDeep({
      version: IMPLEMENTATION_SESSION_BINDING_VERSION,
      kind: IMPLEMENTATION_SESSION_BINDING_KIND,
      authorization,
      repository,
      base,
      task,
    }),
    violations: [],
  };
}

function authorizationInputWithoutTask(input: RecordValue): ImplementationAuthorizationVerificationInput {
  const value = input;
  return {
    authorization: value.authorization,
    ...(value.implementation === undefined ? {} : { implementation: value.implementation as IssueReference }),
    ...(value.issue === undefined
      ? {}
      : { issue: value.issue as ImplementationAuthorizationVerificationInput["issue"] }),
    ...(value.body === undefined ? {} : { body: value.body as string }),
    ...(value.repository === undefined ? {} : { repository: value.repository as ImplementationRepositoryIdentity }),
    ...(value.base === undefined ? {} : { base: value.base as ImplementationBaseEvidence }),
    ...(value.readiness === undefined ? {} : { readiness: value.readiness }),
    ...(value.supersession === undefined
      ? {}
      : { supersession: value.supersession as ImplementationAuthorizationVerificationInput["supersession"] }),
    ...(value.completed === undefined ? {} : { completed: value.completed as boolean }),
  };
}

function authorizationViolations(
  violations: readonly ImplementationAuthorizationViolation[],
): ImplementationSessionBindingViolation[] {
  return violations.map((violation) => ({
    code: violation.code,
    path: violation.path,
    message: violation.message,
    ...(violation.expected === undefined ? {} : { expected: violation.expected }),
    ...(violation.actual === undefined ? {} : { actual: violation.actual }),
  }));
}

/** Validate a bounded binding received at a Session/Runtime boundary. */
export function validateImplementationSessionAuthorizationBinding(input: unknown): ImplementationSessionBindingResult {
  return validateBinding(input);
}

/**
 * Project a binding only from a current authorized Implementation.  The
 * returned value is safe for a certificate; the supplied Issue body and
 * other verification evidence are intentionally discarded.
 */
export function tryProjectImplementationSessionAuthorizationBinding(
  input: unknown,
): ImplementationSessionBindingResult {
  const violations: ImplementationSessionBindingViolation[] = [];
  if (!isRecord(input)) {
    addViolation(
      violations,
      "IMPLEMENTATION_SESSION_BINDING_INVALID_ROOT",
      "$",
      "Session binding input must be an object.",
    );
    return { valid: false, violations };
  }
  unknownProperties(input, INPUT_KEYS, "$", violations);
  const verification = tryVerifyImplementationAuthorization(authorizationInputWithoutTask(input));
  violations.push(...authorizationViolations(verification.violations));
  if (violations.length > 0) return { valid: false, violations: Object.freeze(violations) };
  if (
    !verification.valid ||
    !verification.authorized ||
    !verification.current ||
    verification.status !== "authorized"
  ) {
    addViolation(
      violations,
      "IMPLEMENTATION_SESSION_BINDING_NOT_CURRENT",
      "$.authorization",
      "Implementation Session binding requires a current authorized Implementation.",
    );
    return { valid: false, violations: Object.freeze(violations) };
  }
  if (verification.authorization === undefined) {
    addViolation(
      violations,
      "IMPLEMENTATION_SESSION_BINDING_NOT_CURRENT",
      "$.authorization",
      "Current authorization evidence is unavailable.",
    );
    return { valid: false, violations: Object.freeze(violations) };
  }
  const candidate = {
    version: IMPLEMENTATION_SESSION_BINDING_VERSION,
    kind: IMPLEMENTATION_SESSION_BINDING_KIND,
    authorization: {
      version: verification.authorization.version,
      kind: verification.authorization.kind,
      contractVersion: verification.authorization.contractVersion,
      implementation: verification.authorization.implementation,
      governedBodyDigest: verification.authorization.governedBodyDigest,
    },
    repository: verification.authorization.repository,
    base: verification.authorization.base,
    task: input.task,
  };
  const normalized = validateBinding(candidate);
  if (!normalized.valid || normalized.binding === undefined)
    return { valid: false, violations: Object.freeze([...violations, ...normalized.violations]) };
  return { valid: true, binding: normalized.binding, violations: [] };
}

/** Throwing counterpart for callers that require a current binding. */
export function projectImplementationSessionAuthorizationBinding(
  input: ImplementationSessionAuthorizationBindingInput,
): ImplementationSessionAuthorizationBinding {
  const result = tryProjectImplementationSessionAuthorizationBinding(input);
  if (!result.valid || result.binding === undefined) throw new ImplementationSessionBindingError(result.violations);
  return result.binding;
}

/** Canonical representation for the bounded certificate projection. */
export function serializeImplementationSessionAuthorizationBinding(input: unknown): string {
  const result = validateBinding(input);
  if (!result.valid || result.binding === undefined) throw new ImplementationSessionBindingError(result.violations);
  return canonicalJsonString(result.binding as unknown as CanonicalJsonValue);
}
