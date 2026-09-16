/**
 * Transport-neutral execution authority projected from one current
 * Implementation authorization.
 *
 * This module deliberately consumes the #572 authorization verifier instead
 * of accepting a contract or scope directly.  A projection therefore cannot
 * be created from an unreviewed body, a stale base, or a body that drifted
 * after authorization.  The output contains only the bounded data an
 * enforcement runtime needs; architecture and other Issue prose remain in
 * the Implementation contract and never cross this boundary.
 */

import { canonicalJsonString, type CanonicalJsonValue } from "./agent-authority/codec.js";
import { JSON_SCHEMA_DIALECT } from "./contract/ir.js";
import { normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";
import { type JsonSchema, type JsonSchemaDocument } from "./contract/schema.js";
import {
  IMPLEMENTATION_AUTHORIZATION_KIND,
  IMPLEMENTATION_AUTHORIZATION_VERSION,
  tryVerifyImplementationAuthorization,
  type ImplementationAuthorizationVerificationInput,
  type ImplementationAuthorizationViolationCode,
  type ImplementationBaseEvidence,
} from "./implementation-authorization.js";
import {
  IMPLEMENTATION_CONTRACT_VERSION,
  type ImplementationContractVersion,
  type ImplementationRepositoryIdentity,
  type ImplementationScope,
  type ImplementationScopeOperation,
} from "./implementation-contract.js";

/** Version of the transport-neutral execution-scope projection. */
export const IMPLEMENTATION_SCOPE_PROJECTION_VERSION = 1 as const;
export type ImplementationScopeProjectionVersion = typeof IMPLEMENTATION_SCOPE_PROJECTION_VERSION;

/** Schema version for the public projection envelope. */
export const IMPLEMENTATION_SCOPE_PROJECTION_SCHEMA_VERSION = "1.0.0" as const;
export type ImplementationScopeProjectionSchemaVersion = typeof IMPLEMENTATION_SCOPE_PROJECTION_SCHEMA_VERSION;

/** Stable discriminator for this projection, independent of enforcement runtimes. */
export const IMPLEMENTATION_SCOPE_PROJECTION_KIND = "implementation-execution-scope" as const;

/** The authorization identity retained by an execution-scope projection. */
export interface ImplementationScopeAuthorizationIdentity {
  readonly version: typeof IMPLEMENTATION_AUTHORIZATION_VERSION;
  readonly kind: typeof IMPLEMENTATION_AUTHORIZATION_KIND;
  readonly contractVersion: ImplementationContractVersion;
  readonly implementation: IssueReference;
  /** Digest of the canonical governed #572 Implementation body. */
  readonly governedBodyDigest: string;
}

/**
 * The only authority exposed to an enforcement runtime.  Each operation has
 * an independent allowlist; an omitted mutation in the source contract is
 * represented as an empty list and never inferred from another operation.
 */
export interface ImplementationScopeProjection {
  readonly version: ImplementationScopeProjectionVersion;
  readonly kind: typeof IMPLEMENTATION_SCOPE_PROJECTION_KIND;
  readonly authorization: ImplementationScopeAuthorizationIdentity;
  readonly repository: ImplementationRepositoryIdentity;
  readonly base: ImplementationBaseEvidence;
  readonly scope: ImplementationScope;
}

/** Verification evidence accepted by the projection boundary. */
export interface ImplementationScopeProjectionInput extends ImplementationAuthorizationVerificationInput {}

export type ImplementationScopeProjectionOperation = ImplementationScopeOperation | "DENY";

export type ImplementationScopeProjectionViolationCode =
  | "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_ROOT"
  | "IMPLEMENTATION_SCOPE_PROJECTION_UNKNOWN_PROPERTY"
  | "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_VALUE"
  | "IMPLEMENTATION_SCOPE_PROJECTION_MISSING_PROPERTY"
  | "IMPLEMENTATION_SCOPE_PROJECTION_SCOPE_INVALID_PATH"
  | "IMPLEMENTATION_SCOPE_PROJECTION_SCOPE_DUPLICATE"
  | "IMPLEMENTATION_SCOPE_PROJECTION_SCOPE_LIMIT"
  | "IMPLEMENTATION_SCOPE_PROJECTION_UNSUPPORTED_VERSION"
  | "IMPLEMENTATION_SCOPE_PROJECTION_KIND_INVALID"
  | "IMPLEMENTATION_SCOPE_PROJECTION_AUTHORIZATION_NOT_CURRENT"
  | "IMPLEMENTATION_SCOPE_PROJECTION_NONCANONICAL"
  | ImplementationAuthorizationViolationCode;

export interface ImplementationScopeProjectionViolation {
  readonly code: ImplementationScopeProjectionViolationCode;
  readonly path: string;
  readonly message: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface ImplementationScopeProjectionResult {
  readonly valid: boolean;
  readonly projection?: ImplementationScopeProjection;
  readonly violations: readonly ImplementationScopeProjectionViolation[];
}

export class ImplementationScopeProjectionError extends Error {
  readonly code: ImplementationScopeProjectionViolationCode;
  readonly violations: readonly ImplementationScopeProjectionViolation[];

  constructor(violations: readonly ImplementationScopeProjectionViolation[]) {
    const first = violations[0];
    if (first === undefined) throw new Error("Implementation scope projection errors require a violation.");
    super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
    this.name = "ImplementationScopeProjectionError";
    this.code = first.code;
    this.violations = Object.freeze([...violations]);
  }
}

const PROJECTION_KEYS = new Set(["version", "kind", "authorization", "repository", "base", "scope"]);
const AUTHORIZATION_IDENTITY_KEYS = new Set([
  "version",
  "kind",
  "contractVersion",
  "implementation",
  "governedBodyDigest",
]);
const REPOSITORY_KEYS = new Set(["repositoryHost", "repositoryId", "repository"]);
const BASE_KEYS = new Set(["branch", "revision", "freshness"]);
const SCOPE_KEYS = new Set(["readOnly", "write", "create", "delete", "deny"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const MAX_PATH_LENGTH = 1_024;
const MAX_SCOPE_PATHS = 256;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  violations: ImplementationScopeProjectionViolation[],
  code: ImplementationScopeProjectionViolationCode,
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
  violations: ImplementationScopeProjectionViolation[],
): void {
  for (const key of Object.keys(value).sort(compareStrings)) {
    if (!allowed.has(key))
      addViolation(
        violations,
        "IMPLEMENTATION_SCOPE_PROJECTION_UNKNOWN_PROPERTY",
        `${path}.${key}`,
        "Property is not supported by the execution-scope projection.",
      );
  }
}

function text(
  value: unknown,
  path: string,
  violations: ImplementationScopeProjectionViolation[],
  required = true,
): string | undefined {
  if (typeof value !== "string") {
    if (required)
      addViolation(violations, "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_VALUE", path, "Value must be a string.");
    return undefined;
  }
  const normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) {
    if (required)
      addViolation(violations, "IMPLEMENTATION_SCOPE_PROJECTION_MISSING_PROPERTY", path, "Value must not be empty.");
    return undefined;
  }
  if (!SAFE_TEXT.test(normalized))
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_VALUE",
      path,
      "Value contains a control character.",
    );
  return SAFE_TEXT.test(normalized) ? normalized : undefined;
}

function normalizeRepository(
  value: unknown,
  path: string,
  violations: ImplementationScopeProjectionViolation[],
): ImplementationRepositoryIdentity | undefined {
  if (!isRecord(value)) {
    addViolation(violations, "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_VALUE", path, "Repository must be an object.");
    return undefined;
  }
  unknownProperties(value, REPOSITORY_KEYS, path, violations);
  const repositoryHost = text(value.repositoryHost, `${path}.repositoryHost`, violations);
  const repositoryId = text(value.repositoryId, `${path}.repositoryId`, violations);
  const repository = text(value.repository, `${path}.repository`, violations, false);
  if (repositoryHost !== undefined && /[\s/]/u.test(repositoryHost))
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_VALUE",
      `${path}.repositoryHost`,
      "repositoryHost must not contain whitespace or path separators.",
    );
  if (repositoryId !== undefined && !REPOSITORY_ID_PATTERN.test(repositoryId))
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_VALUE",
      `${path}.repositoryId`,
      "repositoryId must be a positive decimal repository ID.",
    );
  if (repository !== undefined && !REPOSITORY_PATTERN.test(repository))
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_VALUE",
      `${path}.repository`,
      "repository must be an owner/name locator.",
    );
  if (
    repositoryHost === undefined ||
    repositoryId === undefined ||
    /[\s/]/u.test(repositoryHost ?? "") ||
    !REPOSITORY_ID_PATTERN.test(repositoryId ?? "") ||
    (repository !== undefined && !REPOSITORY_PATTERN.test(repository))
  )
    return undefined;
  return {
    repositoryHost: repositoryHost.toLocaleLowerCase("en-US"),
    repositoryId,
    ...(repository === undefined ? {} : { repository: repository.toLocaleLowerCase("en-US") }),
  };
}

function normalizeBase(
  value: unknown,
  path: string,
  violations: ImplementationScopeProjectionViolation[],
): ImplementationBaseEvidence | undefined {
  if (!isRecord(value)) {
    addViolation(violations, "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_VALUE", path, "Base must be an object.");
    return undefined;
  }
  unknownProperties(value, BASE_KEYS, path, violations);
  const branch = text(value.branch, `${path}.branch`, violations);
  const revision = text(value.revision, `${path}.revision`, violations);
  const freshness = text(value.freshness, `${path}.freshness`, violations);
  if (branch !== undefined && !BRANCH_PATTERN.test(branch))
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_VALUE",
      `${path}.branch`,
      "base branch is invalid.",
    );
  if (branch === undefined || revision === undefined || freshness === undefined || !BRANCH_PATTERN.test(branch ?? ""))
    return undefined;
  return { branch, revision, freshness };
}

function normalizeReference(
  value: unknown,
  path: string,
  violations: ImplementationScopeProjectionViolation[],
): IssueReference | undefined {
  const result = normalizeIssueReference(value, path);
  if (!result.valid || result.reference === undefined) {
    addViolation(violations, "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_VALUE", path, "Issue reference is invalid.");
    return undefined;
  }
  return result.reference;
}

function normalizePath(
  value: unknown,
  path: string,
  violations: ImplementationScopeProjectionViolation[],
): string | undefined {
  const raw = text(value, path, violations);
  if (raw === undefined) return undefined;
  const normalized = raw.replaceAll("\\", "/").replace(/\/{2,}/gu, "/");
  const segments = normalized.split("/");
  if (
    normalized.length > MAX_PATH_LENGTH ||
    normalized.startsWith("/") ||
    segments.some((segment) => segment === ".." || segment.length === 0) ||
    /^[A-Za-z]:/u.test(normalized)
  ) {
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_PROJECTION_SCOPE_INVALID_PATH",
      path,
      "Scope paths must be bounded repository-relative paths or globs without parent traversal.",
    );
    return undefined;
  }
  return normalized;
}

function normalizeScopeList(
  value: unknown,
  path: string,
  violations: ImplementationScopeProjectionViolation[],
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    addViolation(violations, "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_VALUE", path, "Scope must be an array of paths.");
    return undefined;
  }
  if (value.length > MAX_SCOPE_PATHS) {
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_PROJECTION_SCOPE_LIMIT",
      path,
      `Scope exceeds ${MAX_SCOPE_PATHS} paths.`,
    );
    return undefined;
  }
  const seen = new Set<string>();
  const result: string[] = [];
  value.forEach((entry, index) => {
    const normalized = normalizePath(entry, `${path}[${index}]`, violations);
    if (normalized === undefined) return;
    if (seen.has(normalized)) {
      addViolation(
        violations,
        "IMPLEMENTATION_SCOPE_PROJECTION_SCOPE_DUPLICATE",
        `${path}[${index}]`,
        "Scope paths must be unique.",
      );
      return;
    }
    seen.add(normalized);
    result.push(normalized);
  });
  return result.sort(compareStrings);
}

function normalizeAuthorizationIdentity(
  value: unknown,
  path: string,
  violations: ImplementationScopeProjectionViolation[],
): ImplementationScopeAuthorizationIdentity | undefined {
  if (!isRecord(value)) {
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_VALUE",
      path,
      "Authorization identity must be an object.",
    );
    return undefined;
  }
  unknownProperties(value, AUTHORIZATION_IDENTITY_KEYS, path, violations);
  if (value.version !== IMPLEMENTATION_AUTHORIZATION_VERSION)
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_PROJECTION_UNSUPPORTED_VERSION",
      `${path}.version`,
      "Authorization version is unsupported.",
    );
  if (value.kind !== IMPLEMENTATION_AUTHORIZATION_KIND)
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_PROJECTION_KIND_INVALID",
      `${path}.kind`,
      "Authorization kind is invalid.",
    );
  if (value.contractVersion !== IMPLEMENTATION_CONTRACT_VERSION)
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_PROJECTION_UNSUPPORTED_VERSION",
      `${path}.contractVersion`,
      "Implementation contract version is unsupported.",
    );
  const implementation = normalizeReference(value.implementation, `${path}.implementation`, violations);
  const governedBodyDigest = text(value.governedBodyDigest, `${path}.governedBodyDigest`, violations);
  if (governedBodyDigest !== undefined && !SHA256_PATTERN.test(governedBodyDigest))
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_VALUE",
      `${path}.governedBodyDigest`,
      "governedBodyDigest must be lowercase SHA-256 hex.",
    );
  if (
    value.version !== IMPLEMENTATION_AUTHORIZATION_VERSION ||
    value.kind !== IMPLEMENTATION_AUTHORIZATION_KIND ||
    value.contractVersion !== IMPLEMENTATION_CONTRACT_VERSION ||
    implementation === undefined ||
    governedBodyDigest === undefined ||
    !SHA256_PATTERN.test(governedBodyDigest ?? "")
  )
    return undefined;
  return {
    version: IMPLEMENTATION_AUTHORIZATION_VERSION,
    kind: IMPLEMENTATION_AUTHORIZATION_KIND,
    contractVersion: IMPLEMENTATION_CONTRACT_VERSION,
    implementation,
    governedBodyDigest,
  };
}

function normalizeScope(
  value: unknown,
  path: string,
  violations: ImplementationScopeProjectionViolation[],
): ImplementationScope | undefined {
  if (!isRecord(value)) {
    addViolation(violations, "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_VALUE", path, "Scope must be an object.");
    return undefined;
  }
  unknownProperties(value, SCOPE_KEYS, path, violations);
  const readOnly = normalizeScopeList(value.readOnly, `${path}.readOnly`, violations);
  const write = normalizeScopeList(value.write, `${path}.write`, violations);
  const create = normalizeScopeList(value.create, `${path}.create`, violations);
  const deleteScope = normalizeScopeList(value.delete, `${path}.delete`, violations);
  const deny = normalizeScopeList(value.deny, `${path}.deny`, violations);
  if (
    readOnly === undefined ||
    write === undefined ||
    create === undefined ||
    deleteScope === undefined ||
    deny === undefined
  )
    return undefined;
  return { readOnly, write, create, delete: deleteScope, deny };
}

function normalizeProjection(input: unknown): ImplementationScopeProjectionResult {
  const violations: ImplementationScopeProjectionViolation[] = [];
  if (!isRecord(input)) {
    return {
      valid: false,
      violations: [
        {
          code: "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_ROOT",
          path: "$",
          message: "Execution-scope projection must be an object.",
        },
      ],
    };
  }
  unknownProperties(input, PROJECTION_KEYS, "$", violations);
  if (input.version !== IMPLEMENTATION_SCOPE_PROJECTION_VERSION)
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_PROJECTION_UNSUPPORTED_VERSION",
      "$.version",
      "Only execution-scope projection version 1 is supported.",
    );
  if (input.kind !== IMPLEMENTATION_SCOPE_PROJECTION_KIND)
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_PROJECTION_KIND_INVALID",
      "$.kind",
      `kind must be "${IMPLEMENTATION_SCOPE_PROJECTION_KIND}".`,
    );
  const authorization = normalizeAuthorizationIdentity(input.authorization, "$.authorization", violations);
  const repository = normalizeRepository(input.repository, "$.repository", violations);
  const base = normalizeBase(input.base, "$.base", violations);
  const scope = normalizeScope(input.scope, "$.scope", violations);
  if (
    violations.length > 0 ||
    authorization === undefined ||
    repository === undefined ||
    base === undefined ||
    scope === undefined
  )
    return { valid: false, violations: Object.freeze([...violations]) };
  return {
    valid: true,
    projection: freezeDeep({
      version: IMPLEMENTATION_SCOPE_PROJECTION_VERSION,
      kind: IMPLEMENTATION_SCOPE_PROJECTION_KIND,
      authorization,
      repository,
      base,
      scope,
    }),
    violations: [],
  };
}

function authorizationViolations(
  violations: readonly {
    readonly code: ImplementationAuthorizationViolationCode;
    readonly path: string;
    readonly message: string;
    readonly expected?: unknown;
    readonly actual?: unknown;
  }[],
): ImplementationScopeProjectionViolation[] {
  return violations.map((violation) => ({
    code: violation.code,
    path: violation.path,
    message: violation.message,
    ...(violation.expected === undefined ? {} : { expected: violation.expected }),
    ...(violation.actual === undefined ? {} : { actual: violation.actual }),
  }));
}

/** Validate a serialized or caller-provided execution-scope projection. */
export function validateImplementationScopeProjection(input: unknown): ImplementationScopeProjectionResult {
  return normalizeProjection(input);
}

/** Parse one execution-scope projection and fail closed on invalid shape. */
export function parseImplementationScopeProjection(input: unknown): ImplementationScopeProjection {
  const result = validateImplementationScopeProjection(input);
  if (!result.valid || result.projection === undefined) throw new ImplementationScopeProjectionError(result.violations);
  return result.projection;
}

/** Type guard for a validated, normalized execution-scope projection. */
export function isImplementationScopeProjection(input: unknown): input is ImplementationScopeProjection {
  return validateImplementationScopeProjection(input).valid;
}

/**
 * Project execution authority only from a currently valid #572 authorization.
 * There is no scope parameter: all five lists are copied from the verified
 * canonical contract, so callers cannot widen or replace authorized scope.
 */
export function tryProjectImplementationScope(input: unknown): ImplementationScopeProjectionResult {
  const verification = tryVerifyImplementationAuthorization(input);
  const violations = authorizationViolations(verification.violations);
  if (
    !verification.valid ||
    !verification.authorized ||
    !verification.current ||
    verification.status !== "authorized"
  ) {
    if (verification.valid && verification.status !== "authorized")
      addViolation(
        violations,
        "IMPLEMENTATION_SCOPE_PROJECTION_AUTHORIZATION_NOT_CURRENT",
        "$.authorization",
        "Execution authority requires an active authorized Implementation; completed authority cannot be projected.",
      );
    else if (verification.valid && (!verification.authorized || !verification.current))
      addViolation(
        violations,
        "IMPLEMENTATION_SCOPE_PROJECTION_AUTHORIZATION_NOT_CURRENT",
        "$.authorization",
        "Implementation authorization is not current execution authority.",
      );
    return { valid: false, violations: Object.freeze(violations) };
  }
  if (verification.authorization === undefined || verification.contract === undefined) {
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_PROJECTION_AUTHORIZATION_NOT_CURRENT",
      "$.authorization",
      "Current authorization must include its authorization record and canonical contract.",
    );
    return { valid: false, violations: Object.freeze(violations) };
  }
  const candidate = {
    version: IMPLEMENTATION_SCOPE_PROJECTION_VERSION,
    kind: IMPLEMENTATION_SCOPE_PROJECTION_KIND,
    authorization: {
      version: verification.authorization.version,
      kind: verification.authorization.kind,
      contractVersion: verification.authorization.contractVersion,
      implementation: verification.authorization.implementation,
      governedBodyDigest: verification.authorization.governedBodyDigest,
    },
    repository: verification.authorization.repository,
    base: verification.authorization.base,
    scope: verification.contract.scope,
  };
  const normalized = validateImplementationScopeProjection(candidate);
  if (!normalized.valid || normalized.projection === undefined)
    return { valid: false, violations: Object.freeze([...violations, ...normalized.violations]) };
  return { valid: true, projection: normalized.projection, violations: [] };
}

/** Throwing projection entry point for callers that require execution authority. */
export function projectImplementationScope(input: unknown): ImplementationScopeProjection {
  const result = tryProjectImplementationScope(input);
  if (!result.valid || result.projection === undefined) throw new ImplementationScopeProjectionError(result.violations);
  return result.projection;
}

/** Canonical JSON serialization for transport and package boundaries. */
export function serializeImplementationScopeProjection(input: unknown): string {
  return canonicalJsonString(parseImplementationScopeProjection(input) as unknown as CanonicalJsonValue);
}

/** Parse canonical JSON received from an enforcement-runtime boundary. */
export function deserializeImplementationScopeProjection(input: string): ImplementationScopeProjection {
  if (typeof input !== "string")
    throw new ImplementationScopeProjectionError([
      {
        code: "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_VALUE",
        path: "$",
        message: "Serialized execution-scope projection must be text.",
      },
    ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.endsWith("\n") ? input.slice(0, -1) : input) as unknown;
  } catch {
    throw new ImplementationScopeProjectionError([
      {
        code: "IMPLEMENTATION_SCOPE_PROJECTION_INVALID_VALUE",
        path: "$",
        message: "Serialized execution-scope projection JSON is invalid.",
      },
    ]);
  }
  const projection = validateImplementationScopeProjection(parsed);
  if (!projection.valid || projection.projection === undefined)
    throw new ImplementationScopeProjectionError(projection.violations);
  const source = input.endsWith("\n") ? input.slice(0, -1) : input;
  if (serializeImplementationScopeProjection(projection.projection) !== source)
    throw new ImplementationScopeProjectionError([
      {
        code: "IMPLEMENTATION_SCOPE_PROJECTION_NONCANONICAL",
        path: "$",
        message: "Execution-scope projection JSON is not canonical.",
      },
    ]);
  return projection.projection;
}

/** Return the explicit paths for one operation, including DENY for consumers that need it. */
export function implementationScopeProjectionPaths(
  input: unknown,
  operation: ImplementationScopeProjectionOperation,
): readonly string[] {
  const projection = parseImplementationScopeProjection(input);
  if (operation === "READONLY") return projection.scope.readOnly;
  if (operation === "WRITE") return projection.scope.write;
  if (operation === "CREATE") return projection.scope.create;
  if (operation === "DELETE") return projection.scope.delete;
  return projection.scope.deny;
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[\\^$+?.()|{}[\]]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

function safePath(value: string): string | undefined {
  if (typeof value !== "string") return undefined;
  // This is an authorization boundary: only trim and canonicalize path
  // separators, which cannot change filename identity. Unicode compatibility
  // normalization (NFKC) can collapse a distinct candidate path onto an
  // authorized glob pattern (e.g. a full-width character onto its ASCII
  // counterpart), so a non-canonical path is rejected fail-closed instead.
  const normalized = value.trim().replaceAll("\\", "/").replace(/\/{2,}/gu, "/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.length > MAX_PATH_LENGTH ||
    normalized.startsWith("/") ||
    segments.some((segment) => segment === ".." || segment.length === 0) ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.normalize("NFC") !== normalized ||
    normalized.normalize("NFKC") !== normalized
  )
    return undefined;
  return normalized.replace(/^\.\//u, "");
}

/** Return whether DENY excludes a path in the projection. */
export function isImplementationScopeProjectionPathDenied(input: unknown, path: string): boolean {
  const projection = parseImplementationScopeProjection(input);
  const normalized = safePath(path);
  return normalized !== undefined && projection.scope.deny.some((entry) => globRegex(entry).test(normalized));
}

/** Evaluate one repository-relative path against an explicit operation scope. */
export function isImplementationScopeProjectionPathAllowed(
  input: unknown,
  operation: ImplementationScopeOperation,
  path: string,
): boolean {
  const projection = parseImplementationScopeProjection(input);
  const normalized = safePath(path);
  if (normalized === undefined || isImplementationScopeProjectionPathDenied(projection, normalized)) return false;
  return implementationScopeProjectionPaths(projection, operation).some((entry) => globRegex(entry).test(normalized));
}

const stringSchema: JsonSchema = { type: "string", minLength: 1 };
const referenceSchema: JsonSchema = {
  type: "object",
  properties: {
    repositoryHost: stringSchema,
    repositoryId: stringSchema,
    repository: stringSchema,
    number: { type: "integer", minimum: 1 },
  },
  required: ["repositoryHost", "repositoryId", "number"],
  additionalProperties: false,
};
const repositorySchema: JsonSchema = {
  type: "object",
  properties: { repositoryHost: stringSchema, repositoryId: stringSchema, repository: stringSchema },
  required: ["repositoryHost", "repositoryId"],
  additionalProperties: false,
};
const baseSchema: JsonSchema = {
  type: "object",
  properties: { branch: stringSchema, revision: stringSchema, freshness: stringSchema },
  required: ["branch", "revision", "freshness"],
  additionalProperties: false,
};
const scopePathArraySchema: JsonSchema = {
  type: "array",
  items: { ...stringSchema, maxLength: MAX_PATH_LENGTH },
  uniqueItems: true,
  maxItems: MAX_SCOPE_PATHS,
};

/** Public machine-readable schema for the execution-scope projection. */
export const IMPLEMENTATION_SCOPE_PROJECTION_SCHEMA: JsonSchemaDocument = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: "urn:inari:implementation-scope-projection:1.0.0",
  title: "Implementation execution scope",
  description: "Versioned, transport-neutral execution authority derived from a current Implementation authorization.",
  type: "object",
  properties: {
    version: { type: "integer", const: IMPLEMENTATION_SCOPE_PROJECTION_VERSION },
    kind: { type: "string", const: IMPLEMENTATION_SCOPE_PROJECTION_KIND },
    authorization: {
      type: "object",
      properties: {
        version: { type: "integer", const: IMPLEMENTATION_AUTHORIZATION_VERSION },
        kind: { type: "string", const: IMPLEMENTATION_AUTHORIZATION_KIND },
        contractVersion: { type: "integer", const: IMPLEMENTATION_CONTRACT_VERSION },
        implementation: referenceSchema,
        governedBodyDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["version", "kind", "contractVersion", "implementation", "governedBodyDigest"],
      additionalProperties: false,
    },
    repository: repositorySchema,
    base: baseSchema,
    scope: {
      type: "object",
      properties: {
        readOnly: scopePathArraySchema,
        write: scopePathArraySchema,
        create: scopePathArraySchema,
        delete: scopePathArraySchema,
        deny: scopePathArraySchema,
      },
      required: ["readOnly", "write", "create", "delete", "deny"],
      additionalProperties: false,
    },
  },
  required: ["version", "kind", "authorization", "repository", "base", "scope"],
  additionalProperties: false,
};

/** Return an isolated copy of the public projection schema. */
export function projectImplementationScopeSchema(): JsonSchemaDocument {
  return structuredClone(IMPLEMENTATION_SCOPE_PROJECTION_SCHEMA) as JsonSchemaDocument;
}

/** Compatibility spelling for callers that name the envelope explicitly. */
export const tryProjectImplementationScopeProjection = tryProjectImplementationScope;
export const projectImplementationScopeProjection = projectImplementationScope;
export const validateImplementationScopeProjectionEnvelope = validateImplementationScopeProjection;
