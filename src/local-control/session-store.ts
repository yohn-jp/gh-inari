/** Persistent per-Session Admission lifecycle records. */

import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { MAX_LOCAL_CONFIG_BYTES, ensureLocalComponentDirectory, localComponentPath, readLocalJson } from "./config.js";
import {
  validateLocalSessionBinding,
  verifyLocalSessionBinding,
  type LocalSessionBinding,
  type LocalSessionBindingVerificationResult,
} from "./session-binding.js";
import { MAX_UNIX_TIME_SECONDS } from "../agent-authority/session-certificate.js";
import type { Delegator } from "../agent-authority/delegator.js";
import { canonicalJsonString, type CanonicalJsonValue } from "../agent-authority/codec.js";

export const ADMISSION_SESSION_RECORD_VERSION = 1 as const;
export const MAX_ADMISSION_SESSION_RECORD_BYTES = MAX_LOCAL_CONFIG_BYTES;

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const RECORD_KEYS = new Set(["version", "binding", "state", "closedAt"]);

export type AdmissionSessionRecordState = "active" | "closed";
export type AdmissionSessionStatus = "active" | "closed" | "expired";

export interface AdmissionSessionRecord {
  readonly version: typeof ADMISSION_SESSION_RECORD_VERSION;
  readonly binding: LocalSessionBinding;
  readonly state: AdmissionSessionRecordState;
  readonly closedAt?: number;
}

export interface AdmissionSessionSnapshot {
  readonly record: AdmissionSessionRecord;
  /** Expiry is derived from the supplied clock and the immutable binding. */
  readonly status: AdmissionSessionStatus;
}

export interface AdmissionSessionStoreOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: Date;
}

export type AdmissionSessionStoreErrorCode =
  | "ADMISSION_SESSION_STORE_INVALID_SESSION_ID"
  | "ADMISSION_SESSION_STORE_INVALID_BINDING"
  | "ADMISSION_SESSION_STORE_TRUST_MISMATCH"
  | "ADMISSION_SESSION_STORE_NOT_FOUND"
  | "ADMISSION_SESSION_STORE_CONFLICT"
  | "ADMISSION_SESSION_STORE_CLOSED"
  | "ADMISSION_SESSION_STORE_EXPIRED"
  | "ADMISSION_SESSION_STORE_INVALID_RECORD"
  | "ADMISSION_SESSION_STORE_STORAGE_FAILED";

export class AdmissionSessionStoreError extends Error {
  readonly code: AdmissionSessionStoreErrorCode;

  constructor(code: AdmissionSessionStoreErrorCode, message: string) {
    super(message);
    this.name = "AdmissionSessionStoreError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: AdmissionSessionStoreErrorCode, message: string): never {
  throw new AdmissionSessionStoreError(code, message);
}

function validateRecord(value: unknown): AdmissionSessionRecord {
  if (!isRecord(value) || Object.keys(value).some((key) => !RECORD_KEYS.has(key))) {
    return fail("ADMISSION_SESSION_STORE_INVALID_RECORD", "Admission Session record is malformed.");
  }
  if (value.version !== ADMISSION_SESSION_RECORD_VERSION) {
    return fail("ADMISSION_SESSION_STORE_INVALID_RECORD", "Admission Session record version is unsupported.");
  }
  const bindingResult = validateLocalSessionBinding(value.binding);
  if (!bindingResult.valid || bindingResult.value === undefined) {
    return fail("ADMISSION_SESSION_STORE_INVALID_RECORD", "Admission Session record is malformed.");
  }
  if (value.state === "active" && !("closedAt" in value)) {
    return Object.freeze({ version: ADMISSION_SESSION_RECORD_VERSION, binding: bindingResult.value, state: "active" });
  }
  if (
    value.state === "closed" &&
    Number.isInteger(value.closedAt) &&
    (value.closedAt as number) >= 0 &&
    (value.closedAt as number) <= MAX_UNIX_TIME_SECONDS
  ) {
    return Object.freeze({
      version: ADMISSION_SESSION_RECORD_VERSION,
      binding: bindingResult.value,
      state: "closed",
      closedAt: value.closedAt as number,
    });
  }
  return fail("ADMISSION_SESSION_STORE_INVALID_RECORD", "Admission Session record lifecycle state is malformed.");
}

function pathFor(sessionId: string, environment: NodeJS.ProcessEnv): string {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    return fail("ADMISSION_SESSION_STORE_INVALID_SESSION_ID", "Session id is invalid.");
  }
  return localComponentPath("admission", `sessions/${sessionId}.json`, environment);
}

function relativePathFor(sessionId: string): string {
  return `sessions/${sessionId}.json`;
}

function recordBytes(record: AdmissionSessionRecord): Buffer {
  const text = `${canonicalJsonString(record as unknown as CanonicalJsonValue)}\n`;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > MAX_ADMISSION_SESSION_RECORD_BYTES) {
    return fail("ADMISSION_SESSION_STORE_STORAGE_FAILED", "Admission Session record exceeds the storage limit.");
  }
  return bytes;
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Best-effort cleanup after a failed write.
  }
}

function syncDirectory(directoryPath: string): void {
  try {
    const fd = openSync(directoryPath, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // The file itself is synced and atomically published; directory fsync is best effort.
  }
}

/** Atomically publish a record. Create uses link(2) to avoid overwriting a concurrent winner. */
function writeRecord(record: AdmissionSessionRecord, environment: NodeJS.ProcessEnv, createOnly: boolean): boolean {
  const directoryPath = ensureLocalComponentDirectory("admission", environment, "sessions");
  const targetPath = pathFor(record.binding.sessionId, environment);
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    return fail("ADMISSION_SESSION_STORE_STORAGE_FAILED", "Safe Admission Session storage is unavailable.");
  }
  const temporaryName = `${record.binding.sessionId}.tmp-${process.pid}-${randomBytes(12).toString("hex")}.json`;
  const temporaryPath = localComponentPath("admission", `sessions/${temporaryName}`, environment);
  const bytes = recordBytes(record);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (createOnly) {
      try {
        linkSync(temporaryPath, targetPath);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          try {
            unlinkSync(temporaryPath);
          } catch {
            // The winning record is still atomically published.
          }
          return false;
        }
        throw error;
      }
      unlinkSync(temporaryPath);
    } else {
      renameSync(temporaryPath, targetPath);
    }
    syncDirectory(directoryPath);
    return true;
  } catch {
    closeQuietly(fd);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary path may already have been moved or linked.
    }
    return fail("ADMISSION_SESSION_STORE_STORAGE_FAILED", "Admission Session record could not be persisted.");
  }
}

function readRecord(sessionId: string, environment: NodeJS.ProcessEnv): AdmissionSessionRecord | undefined {
  pathFor(sessionId, environment);
  ensureLocalComponentDirectory("admission", environment, "sessions");
  try {
    return readLocalJson("admission", relativePathFor(sessionId), validateRecord, environment);
  } catch (error: unknown) {
    if (error instanceof AdmissionSessionStoreError) throw error;
    return fail("ADMISSION_SESSION_STORE_INVALID_RECORD", "Admission Session record could not be read safely.");
  }
}

function verifiedStatus(
  record: AdmissionSessionRecord,
  runtimeAuthority: Delegator,
  now: Date,
): AdmissionSessionSnapshot {
  const verification = verifyLocalSessionBinding(record.binding, runtimeAuthority, { now });
  if (!verification.valid || verification.value === undefined) {
    const trustMismatch = verification.diagnostics.some(
      (entry) => entry.code === "LOCAL_SESSION_BINDING_TRUST_MISMATCH",
    );
    return fail(
      trustMismatch ? "ADMISSION_SESSION_STORE_TRUST_MISMATCH" : "ADMISSION_SESSION_STORE_INVALID_BINDING",
      trustMismatch
        ? "Runtime Authority trust does not match the stored Session."
        : "Stored Session binding is invalid.",
    );
  }
  const status: AdmissionSessionStatus =
    record.state === "closed" ? "closed" : (verification.status as "active" | "expired");
  return Object.freeze({ record, status });
}

function currentTime(options: AdmissionSessionStoreOptions): Date {
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return fail("ADMISSION_SESSION_STORE_INVALID_BINDING", "Admission Session clock is invalid.");
  }
  return now;
}

function assertMatchingBinding(expected: LocalSessionBinding, actual: LocalSessionBinding): void {
  const expectedJson = canonicalJsonString(expected as unknown as CanonicalJsonValue);
  const actualJson = canonicalJsonString(actual as unknown as CanonicalJsonValue);
  if (expectedJson !== actualJson) {
    return fail("ADMISSION_SESSION_STORE_CONFLICT", "Session id is already bound to different immutable claims.");
  }
}

function snapshotExisting(
  requested: LocalSessionBinding,
  record: AdmissionSessionRecord,
  runtimeAuthority: Delegator,
  now: Date,
): AdmissionSessionSnapshot {
  const snapshot = verifiedStatus(record, runtimeAuthority, now);
  assertMatchingBinding(requested, record.binding);
  if (snapshot.status === "closed") {
    return fail("ADMISSION_SESSION_STORE_CLOSED", "Closed Session id cannot be reused.");
  }
  if (snapshot.status === "expired") {
    return fail("ADMISSION_SESSION_STORE_EXPIRED", "Expired Session id cannot be reused.");
  }
  return snapshot;
}

/** Create one immutable per-Session record; only exact active reuse is idempotent. */
export function createAdmissionSession(
  input: LocalSessionBinding,
  runtimeAuthority: Delegator,
  options: AdmissionSessionStoreOptions = {},
): AdmissionSessionSnapshot {
  const now = currentTime(options);
  const validation = verifyLocalSessionBinding(input, runtimeAuthority, { now });
  if (!validation.valid || validation.value === undefined) {
    const trustMismatch = validation.diagnostics.some((entry) => entry.code === "LOCAL_SESSION_BINDING_TRUST_MISMATCH");
    return fail(
      trustMismatch ? "ADMISSION_SESSION_STORE_TRUST_MISMATCH" : "ADMISSION_SESSION_STORE_INVALID_BINDING",
      trustMismatch ? "Runtime Authority trust does not match the Session binding." : "Session binding is invalid.",
    );
  }
  const binding = validation.value;
  if (validation.status === "expired") {
    return fail("ADMISSION_SESSION_STORE_EXPIRED", "Expired Session id cannot be created or reused.");
  }
  const environment = options.environment ?? process.env;
  const existing = readRecord(binding.sessionId, environment);
  if (existing !== undefined) return snapshotExisting(binding, existing, runtimeAuthority, now);

  const record: AdmissionSessionRecord = Object.freeze({
    version: ADMISSION_SESSION_RECORD_VERSION,
    binding,
    state: "active",
  });
  if (writeRecord(record, environment, true)) return verifiedStatus(record, runtimeAuthority, now);

  const raced = readRecord(binding.sessionId, environment);
  if (raced === undefined) {
    return fail(
      "ADMISSION_SESSION_STORE_STORAGE_FAILED",
      "Concurrent Session record publication could not be verified.",
    );
  }
  return snapshotExisting(binding, raced, runtimeAuthority, now);
}

/** Read a record by its locator and verify its immutable Authority binding. */
export function readAdmissionSession(
  sessionId: string,
  runtimeAuthority: Delegator,
  options: AdmissionSessionStoreOptions = {},
): AdmissionSessionSnapshot | undefined {
  const record = readRecord(sessionId, options.environment ?? process.env);
  if (record === undefined) return undefined;
  if (record.binding.sessionId !== sessionId) {
    return fail("ADMISSION_SESSION_STORE_INVALID_RECORD", "Admission Session record does not match its locator.");
  }
  return verifiedStatus(record, runtimeAuthority, currentTime(options));
}

/** Close an exact signed Session binding while preserving its immutable claims. */
export function closeAdmissionSession(
  input: LocalSessionBinding,
  runtimeAuthority: Delegator,
  options: AdmissionSessionStoreOptions = {},
): AdmissionSessionSnapshot {
  const now = currentTime(options);
  const verification: LocalSessionBindingVerificationResult = verifyLocalSessionBinding(input, runtimeAuthority, {
    now,
  });
  if (!verification.valid || verification.value === undefined) {
    const trustMismatch = verification.diagnostics.some(
      (entry) => entry.code === "LOCAL_SESSION_BINDING_TRUST_MISMATCH",
    );
    return fail(
      trustMismatch ? "ADMISSION_SESSION_STORE_TRUST_MISMATCH" : "ADMISSION_SESSION_STORE_INVALID_BINDING",
      trustMismatch ? "Runtime Authority trust does not match the Session binding." : "Session binding is invalid.",
    );
  }
  const environment = options.environment ?? process.env;
  const existing = readRecord(verification.value.sessionId, environment);
  if (existing === undefined)
    return fail("ADMISSION_SESSION_STORE_NOT_FOUND", "Admission Session record was not found.");
  assertMatchingBinding(verification.value, existing.binding);
  const snapshot = verifiedStatus(existing, runtimeAuthority, now);
  if (existing.state === "closed") return snapshot;

  const closedRecord = Object.freeze({
    version: ADMISSION_SESSION_RECORD_VERSION,
    binding: existing.binding,
    state: "closed" as const,
    closedAt: Math.floor(now.getTime() / 1000),
  });
  writeRecord(closedRecord, environment, false);
  const persisted = readRecord(verification.value.sessionId, environment);
  if (persisted === undefined || persisted.state !== "closed" || persisted.closedAt !== closedRecord.closedAt) {
    return fail("ADMISSION_SESSION_STORE_STORAGE_FAILED", "Closed Admission Session record could not be verified.");
  }
  assertMatchingBinding(verification.value, persisted.binding);
  return verifiedStatus(persisted, runtimeAuthority, now);
}
