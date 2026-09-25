/**
 * Shared bounded primitives of the setup contracts (#1098).
 *
 * Repository identity reuses the canonical `RepositoryIdentity` type; this
 * module checks only its JSON shape. Owners keep canonical validation
 * (`validateIssuerRepositoryIdentity`) and provider evidence.
 */
import type { RepositoryIdentity } from "../github/effect-authorizer.js";
import { invalid } from "./errors.js";

export const SETUP_CONTRACT_VERSION = 1 as const;

export const MAX_SETUP_DIAGNOSTICS = 16;
export const MAX_SETUP_TEXT_LENGTH = 480;

export interface SetupDiagnostic {
  /** Stable UPPER_SNAKE_CASE code. */
  readonly code: string;
  readonly message: string;
}

/**
 * Freshness binding of setup evidence and actions: the repository plus the
 * owner-issued configuration generation. Actions for another repository or a
 * stale generation must not produce effects.
 */
export interface SetupGeneration {
  readonly repository: RepositoryIdentity;
  readonly configuration: string;
}

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const REPOSITORY_ID = /^[1-9][0-9]{0,19}$/u;
const NAME_WITH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

export function requireMembers(input: unknown, path: string, members: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw invalid(path, "must be an object.");
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!members.includes(key)) throw invalid(`${path}.${key}`, "is not a member of this contract.");
  }
  return record;
}

export function validateText(value: unknown, path: string, maxLength = MAX_SETUP_TEXT_LENGTH): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw invalid(path, `must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

export function validateOperationId(value: unknown, path: string): string {
  if (typeof value !== "string" || !OPERATION_ID.test(value)) throw invalid(path, "must be a bounded identifier.");
  return value;
}

export function validateTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw invalid(path, "must be an ISO-8601 UTC timestamp.");
  }
  return value;
}

export function validateRepositoryIdentity(value: unknown, path: string): RepositoryIdentity {
  const record = requireMembers(value, path, ["repositoryHost", "repositoryId", "nameWithOwner"]);
  if (typeof record.repositoryHost !== "string" || !HOST.test(record.repositoryHost)) {
    throw invalid(`${path}.repositoryHost`, "must be a lower-case host name.");
  }
  if (typeof record.repositoryId !== "string" || !REPOSITORY_ID.test(record.repositoryId)) {
    throw invalid(`${path}.repositoryId`, "must be a decimal repository database ID.");
  }
  if (typeof record.nameWithOwner !== "string" || !NAME_WITH_OWNER.test(record.nameWithOwner)) {
    throw invalid(`${path}.nameWithOwner`, "must be owner/name.");
  }
  return Object.freeze({
    repositoryHost: record.repositoryHost,
    repositoryId: record.repositoryId,
    nameWithOwner: record.nameWithOwner,
  });
}

export function validateSetupGeneration(value: unknown, path: string): SetupGeneration {
  const record = requireMembers(value, path, ["repository", "configuration"]);
  return Object.freeze({
    repository: validateRepositoryIdentity(record.repository, `${path}.repository`),
    configuration: validateOperationId(record.configuration, `${path}.configuration`),
  });
}

/** Same repository (by immutable ID and host) and same configuration generation. */
export function sameSetupGeneration(left: SetupGeneration, right: SetupGeneration): boolean {
  return (
    left.configuration === right.configuration &&
    left.repository.repositoryHost === right.repository.repositoryHost &&
    left.repository.repositoryId === right.repository.repositoryId
  );
}

export function validateSetupDiagnostics(value: unknown, path: string): readonly SetupDiagnostic[] {
  if (!Array.isArray(value) || value.length > MAX_SETUP_DIAGNOSTICS) {
    throw invalid(path, `must be an array of at most ${MAX_SETUP_DIAGNOSTICS} diagnostics.`);
  }
  return Object.freeze(
    value.map((item, index) => {
      const record = requireMembers(item, `${path}[${index}]`, ["code", "message"]);
      if (typeof record.code !== "string" || !DIAGNOSTIC_CODE.test(record.code)) {
        throw invalid(`${path}[${index}].code`, "must be an UPPER_SNAKE_CASE code.");
      }
      return Object.freeze({ code: record.code, message: validateText(record.message, `${path}[${index}].message`) });
    }),
  );
}
