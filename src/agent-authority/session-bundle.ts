/**
 * Manual, short-lived Session credential bundles.
 *
 * A bundle is the portable form of one Session only.  It contains the
 * Session's PKCS#8 private key, the canonical #367 compact certificate, and
 * optional bounded agent provenance.  It deliberately contains no Runtime
 * private key, App credential, transport envelope, or alternate signing
 * format.
 */

import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { createPrivateKey, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  MAX_UNIX_TIME_SECONDS,
  decodeSessionCertificateCompact,
  validateSessionCertificatePayload,
  type DecodedSessionCertificate,
  type SessionCertificateRepository,
  type SessionCertificateTask,
} from "./session-certificate.js";
import {
  MIN_SESSION_TTL_SECONDS,
  MAX_SESSION_TTL_SECONDS,
  assertRuntimeAuthority,
  type RuntimeAuthority,
} from "./runtime-authority.js";
import { issueSessionCertificate, type ManagedSessionIssuanceRequest } from "./session-issuance.js";
import { exportRuntimeAuthorityPublicKey, type RuntimeAuthorityKeyPair } from "./runtime-key.js";
import { canonicalJsonString, type CanonicalJsonValue } from "./codec.js";

export const SESSION_ISSUANCE_REQUEST_VERSION = 1 as const;
export const SESSION_ISSUANCE_REQUEST_KIND = "inari-session-issuance-request" as const;
export const SESSION_CREDENTIAL_BUNDLE_VERSION = 1 as const;
export const SESSION_CREDENTIAL_BUNDLE_KIND = "inari-session-credential-bundle" as const;

/** Secret bundle files are intentionally much smaller than the general CLI input bound. */
export const MAX_SESSION_CREDENTIAL_BUNDLE_BYTES = 64 * 1024;
export const MAX_SESSION_PRIVATE_KEY_PEM_BYTES = 16 * 1024;
export const MAX_SESSION_AGENT_METADATA_KEYS = 4;
export const MAX_SESSION_AGENT_METADATA_TEXT_LENGTH = 128;

const BUNDLE_FILE_MODE = 0o600;
const BUNDLE_DIRECTORY_MODE = 0o700;
const PUBLIC_MODE_MASK = 0o077;
const EXECUTE_MODE_MASK = 0o111;
const ANCESTOR_WRITE_MODE_MASK = 0o022;
const STICKY_MODE = 0o1000;
const SAFE_METADATA_TEXT = /^[\x20-\x7e]+$/u;
const SESSION_SUBJECT_PREFIX = "session:";
/** Matches the #371 managed Session ID entropy; this bundle owns its own ID generation. */
const MANUAL_SESSION_ID_BYTES = 18;
const VALIDATION_SESSION_KEY = Object.freeze({
  kty: "OKP",
  crv: "Ed25519",
  x: "A".repeat(43),
});

export interface SessionAgentMetadata {
  /** Product or agent implementation name, for provenance only. */
  readonly name?: string;
  /** Optional implementation version, for provenance only. */
  readonly version?: string;
  /** Optional execution runtime, for provenance only. */
  readonly runtime?: string;
  /** Optional vendor/product label, for provenance only. */
  readonly product?: string;
}

export interface SessionIssuanceRequestDocument {
  readonly version: typeof SESSION_ISSUANCE_REQUEST_VERSION;
  readonly kind: typeof SESSION_ISSUANCE_REQUEST_KIND;
  readonly runtimeAuthority: RuntimeAuthority;
  readonly repository: SessionCertificateRepository;
  readonly task?: SessionCertificateTask;
  readonly capabilities: ManagedSessionIssuanceRequest["capabilities"];
  readonly ttlSeconds: number;
  readonly agent?: SessionAgentMetadata;
}

export interface SessionCredentialBundle {
  readonly version: typeof SESSION_CREDENTIAL_BUNDLE_VERSION;
  readonly kind: typeof SESSION_CREDENTIAL_BUNDLE_KIND;
  /** Canonical PKCS#8 PEM for the one ephemeral Session private key. */
  readonly sessionPrivateKey: string;
  /** Canonical three-segment #367 Session Certificate compact JWS. */
  readonly certificate: string;
  readonly agent?: SessionAgentMetadata;
}

export interface ParsedSessionCredentialBundle {
  readonly bundle: SessionCredentialBundle;
  /** Private material remains in process memory and is never part of projections. */
  readonly privateKey: KeyObject;
  readonly certificate: DecodedSessionCertificate;
}

export type CreatedSessionCredentialBundle = ParsedSessionCredentialBundle;

export interface SessionCredentialBundleInspection {
  readonly ok: true;
  readonly valid: true;
  readonly operation: "session.inspect";
  readonly bundle: {
    readonly version: typeof SESSION_CREDENTIAL_BUNDLE_VERSION;
    readonly kind: typeof SESSION_CREDENTIAL_BUNDLE_KIND;
  };
  readonly repository: SessionCertificateRepository;
  readonly task?: SessionCertificateTask;
  readonly capabilities: ManagedSessionIssuanceRequest["capabilities"];
  readonly expiry: {
    readonly iat: number;
    readonly nbf: number;
    readonly exp: number;
  };
  readonly runtime: {
    readonly authorityId: string;
    readonly issuer: string;
  };
  readonly session: {
    readonly id: string;
    readonly certificateId: string;
    readonly publicKey: DecodedSessionCertificate["payload"]["sessionKey"];
  };
  readonly certificate: {
    readonly alg: string;
    readonly typ: string;
  };
  readonly agent?: SessionAgentMetadata;
}

export type SessionCredentialBundleErrorCode =
  | "SESSION_BUNDLE_INVALID_REQUEST"
  | "SESSION_BUNDLE_INVALID_ROOT"
  | "SESSION_BUNDLE_UNKNOWN_PROPERTY"
  | "SESSION_BUNDLE_INVALID_VERSION"
  | "SESSION_BUNDLE_INVALID_KIND"
  | "SESSION_BUNDLE_NON_CANONICAL_ENCODING"
  | "SESSION_BUNDLE_INVALID_PRIVATE_KEY"
  | "SESSION_BUNDLE_CERTIFICATE_INVALID"
  | "SESSION_BUNDLE_CERTIFICATE_KEY_MISMATCH"
  | "SESSION_BUNDLE_INVALID_EXPIRY"
  | "SESSION_BUNDLE_INVALID_METADATA"
  | "SESSION_BUNDLE_INVALID_PATH"
  | "SESSION_BUNDLE_INPUT_NOT_FOUND"
  | "SESSION_BUNDLE_UNSAFE_STORAGE"
  | "SESSION_BUNDLE_OUTPUT_EXISTS"
  | "SESSION_BUNDLE_STORAGE_FAILED";

export interface SessionCredentialBundleDiagnostic {
  readonly code: SessionCredentialBundleErrorCode;
  readonly path: string;
  readonly message: string;
}

export class SessionCredentialBundleError extends Error {
  readonly code: SessionCredentialBundleErrorCode;
  readonly path?: string;
  readonly diagnostics: readonly SessionCredentialBundleDiagnostic[];

  constructor(
    code: SessionCredentialBundleErrorCode,
    message: string,
    path?: string,
    diagnostics: readonly SessionCredentialBundleDiagnostic[] = [],
  ) {
    super(message);
    this.name = "SessionCredentialBundleError";
    this.code = code;
    this.path = path;
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

const REQUEST_KEYS = new Set([
  "version",
  "kind",
  "runtimeAuthority",
  "repository",
  "task",
  "capabilities",
  "ttlSeconds",
  "agent",
]);
const BUNDLE_KEYS = new Set(["version", "kind", "sessionPrivateKey", "certificate", "agent"]);
const AGENT_KEYS = new Set(["name", "version", "runtime", "product"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(
  code: SessionCredentialBundleErrorCode,
  path: string,
  message: string,
): SessionCredentialBundleDiagnostic {
  return { code, path, message };
}

function bundleError(
  code: SessionCredentialBundleErrorCode,
  message: string,
  path?: string,
  diagnostics: readonly SessionCredentialBundleDiagnostic[] = [],
): SessionCredentialBundleError {
  return new SessionCredentialBundleError(code, message, path, diagnostics);
}

function assertRecord(
  value: unknown,
  code: SessionCredentialBundleErrorCode,
  message: string,
  path: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw bundleError(code, message, path, [diagnostic(code, path, message)]);
}

function rejectUnknownProperties(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  code: SessionCredentialBundleErrorCode,
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    const propertyPath = `${path}.${unknown}`;
    throw bundleError(code, "Input contains an unsupported property.", propertyPath, [
      diagnostic(code, propertyPath, "Property is not accepted."),
    ]);
  }
}

function required(value: Record<string, unknown>, key: string, path: string): unknown {
  if (!(key in value)) {
    const propertyPath = `${path}.${key}`;
    throw bundleError("SESSION_BUNDLE_INVALID_REQUEST", "Required property is missing.", propertyPath, [
      diagnostic("SESSION_BUNDLE_INVALID_REQUEST", propertyPath, "Property is required."),
    ]);
  }
  return value[key];
}

function validateMetadataText(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SESSION_AGENT_METADATA_TEXT_LENGTH ||
    !SAFE_METADATA_TEXT.test(value) ||
    /(?:private\s*key|secret|token|credential|begin\s+[-a-z]+\s+key)/iu.test(value)
  ) {
    throw bundleError(
      "SESSION_BUNDLE_INVALID_METADATA",
      `Metadata text must be printable text of at most ${MAX_SESSION_AGENT_METADATA_TEXT_LENGTH} characters.`,
      path,
      [diagnostic("SESSION_BUNDLE_INVALID_METADATA", path, "Metadata text is outside the bounded safe form.")],
    );
  }
  return value;
}

function parseAgentMetadata(value: unknown, path: string, request: boolean): SessionAgentMetadata | undefined {
  if (value === undefined) return undefined;
  assertRecord(
    value,
    request ? "SESSION_BUNDLE_INVALID_REQUEST" : "SESSION_BUNDLE_INVALID_METADATA",
    "Agent metadata must be an object.",
    path,
  );
  const code = request ? "SESSION_BUNDLE_INVALID_REQUEST" : "SESSION_BUNDLE_INVALID_METADATA";
  rejectUnknownProperties(value, AGENT_KEYS, code, path);
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_SESSION_AGENT_METADATA_KEYS) {
    throw bundleError(code, `Agent metadata must contain 1-${MAX_SESSION_AGENT_METADATA_KEYS} properties.`, path, [
      diagnostic(code, path, "Metadata property count is outside the bounded form."),
    ]);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of entries) result[key] = validateMetadataText(item, `${path}.${key}`);
  return Object.freeze(result) as SessionAgentMetadata;
}

/** Validate and normalize the semantic request accepted by `session issue`. */
export function parseSessionIssuanceRequest(input: unknown): SessionIssuanceRequestDocument {
  assertRecord(input, "SESSION_BUNDLE_INVALID_REQUEST", "Session issuance request must be an object.", "$");
  rejectUnknownProperties(input, REQUEST_KEYS, "SESSION_BUNDLE_INVALID_REQUEST", "$");

  if ("version" in input && input.version !== SESSION_ISSUANCE_REQUEST_VERSION) {
    throw bundleError(
      "SESSION_BUNDLE_INVALID_REQUEST",
      "Session issuance request version is unsupported.",
      "$.version",
      [diagnostic("SESSION_BUNDLE_INVALID_REQUEST", "$.version", "Only request version 1 is accepted.")],
    );
  }
  if ("kind" in input && input.kind !== SESSION_ISSUANCE_REQUEST_KIND) {
    throw bundleError("SESSION_BUNDLE_INVALID_REQUEST", "Session issuance request kind is invalid.", "$.kind", [
      diagnostic(
        "SESSION_BUNDLE_INVALID_REQUEST",
        "$.kind",
        "The canonical Session issuance request kind is required.",
      ),
    ]);
  }

  let runtimeAuthority: RuntimeAuthority;
  try {
    runtimeAuthority = assertRuntimeAuthority(required(input, "runtimeAuthority", "$") as unknown);
  } catch {
    throw bundleError(
      "SESSION_BUNDLE_INVALID_REQUEST",
      "Session issuance request must contain a valid Runtime Authority record.",
      "$.runtimeAuthority",
      [diagnostic("SESSION_BUNDLE_INVALID_REQUEST", "$.runtimeAuthority", "Runtime Authority record is invalid.")],
    );
  }

  const repository = required(input, "repository", "$") as SessionCertificateRepository;
  const capabilities = required(input, "capabilities", "$");
  const ttlSeconds = required(input, "ttlSeconds", "$");
  const agent = parseAgentMetadata(input.agent, "$.agent", true);
  if (typeof ttlSeconds !== "number" || !Number.isInteger(ttlSeconds)) {
    throw bundleError("SESSION_BUNDLE_INVALID_REQUEST", "ttlSeconds must be an integer.", "$.ttlSeconds", [
      diagnostic("SESSION_BUNDLE_INVALID_REQUEST", "$.ttlSeconds", "TTL must be a whole number of seconds."),
    ]);
  }
  if (!Array.isArray(capabilities)) {
    throw bundleError("SESSION_BUNDLE_INVALID_REQUEST", "capabilities must be an array.", "$.capabilities", [
      diagnostic("SESSION_BUNDLE_INVALID_REQUEST", "$.capabilities", "Capability claims must be an array."),
    ]);
  }
  const validationResult = validateSessionCertificatePayload({
    ver: 1,
    iss: `runtime:${runtimeAuthority.id}`,
    sub: "session:request-validation",
    jti: "request-validation",
    repository,
    sessionKey: VALIDATION_SESSION_KEY,
    ...(input.task === undefined ? {} : { task: input.task }),
    capabilities,
    iat: 0,
    nbf: 0,
    exp: ttlSeconds,
  });
  if (!validationResult.valid || validationResult.value === undefined) {
    throw bundleError(
      "SESSION_BUNDLE_INVALID_REQUEST",
      "Session issuance request is outside the bounded certificate contract.",
      "$.request",
      validationResult.diagnostics.map((item) => diagnostic("SESSION_BUNDLE_INVALID_REQUEST", item.path, item.message)),
    );
  }

  const normalized = validationResult.value;
  return Object.freeze({
    version: SESSION_ISSUANCE_REQUEST_VERSION,
    kind: SESSION_ISSUANCE_REQUEST_KIND,
    runtimeAuthority,
    repository: normalized.repository,
    ...(normalized.task === undefined ? {} : { task: normalized.task }),
    capabilities: normalized.capabilities,
    ttlSeconds,
    ...(agent === undefined ? {} : { agent }),
  });
}

function sessionPrivateKeyPem(key: KeyObject): string {
  try {
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw new TypeError("not Ed25519");
    const pem = key.export({ format: "pem", type: "pkcs8" });
    if (typeof pem !== "string" || Buffer.byteLength(pem, "utf8") > MAX_SESSION_PRIVATE_KEY_PEM_BYTES) {
      throw new TypeError("invalid key size");
    }
    return pem;
  } catch {
    throw bundleError("SESSION_BUNDLE_INVALID_PRIVATE_KEY", "Session private key is not a valid Ed25519 PKCS#8 key.");
  }
}

function parseSessionPrivateKey(value: unknown): KeyObject {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_SESSION_PRIVATE_KEY_PEM_BYTES
  ) {
    throw bundleError(
      "SESSION_BUNDLE_INVALID_PRIVATE_KEY",
      "Session private key material is invalid.",
      "$.sessionPrivateKey",
      [
        diagnostic(
          "SESSION_BUNDLE_INVALID_PRIVATE_KEY",
          "$.sessionPrivateKey",
          "A bounded PKCS#8 PEM value is required.",
        ),
      ],
    );
  }
  try {
    const privateKey = createPrivateKey({ key: value, format: "pem", type: "pkcs8" });
    if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") throw new TypeError("not Ed25519");
    if (sessionPrivateKeyPem(privateKey) !== value) throw new TypeError("non-canonical PEM");
    return privateKey;
  } catch (error: unknown) {
    if (error instanceof SessionCredentialBundleError) throw error;
    throw bundleError(
      "SESSION_BUNDLE_INVALID_PRIVATE_KEY",
      "Session private key material is not canonical Ed25519 PKCS#8 PEM.",
      "$.sessionPrivateKey",
      [
        diagnostic(
          "SESSION_BUNDLE_INVALID_PRIVATE_KEY",
          "$.sessionPrivateKey",
          "Private key encoding is invalid or non-canonical.",
        ),
      ],
    );
  }
}

function validateCertificateExpiry(certificate: DecodedSessionCertificate): void {
  const { iat, nbf, exp } = certificate.payload;
  if (
    iat > nbf ||
    nbf >= exp ||
    exp - nbf < MIN_SESSION_TTL_SECONDS ||
    exp - nbf > MAX_SESSION_TTL_SECONDS ||
    iat > MAX_UNIX_TIME_SECONDS ||
    nbf > MAX_UNIX_TIME_SECONDS ||
    exp > MAX_UNIX_TIME_SECONDS
  ) {
    throw bundleError(
      "SESSION_BUNDLE_INVALID_EXPIRY",
      "Session Certificate expiry window is not a bounded, positive Session lifetime.",
      "$.certificate.payload.exp",
      [diagnostic("SESSION_BUNDLE_INVALID_EXPIRY", "$.certificate.payload", "Certificate time claims are invalid.")],
    );
  }
}

/** Validate one bundle, including its key/certificate identity binding. */
export function parseSessionCredentialBundle(input: unknown): ParsedSessionCredentialBundle {
  assertRecord(input, "SESSION_BUNDLE_INVALID_ROOT", "Session credential bundle must be an object.", "$");
  rejectUnknownProperties(input, BUNDLE_KEYS, "SESSION_BUNDLE_INVALID_ROOT", "$");
  if (input.version !== SESSION_CREDENTIAL_BUNDLE_VERSION) {
    throw bundleError(
      "SESSION_BUNDLE_INVALID_VERSION",
      "Session credential bundle version is unsupported.",
      "$.version",
      [diagnostic("SESSION_BUNDLE_INVALID_VERSION", "$.version", "Only bundle version 1 is accepted.")],
    );
  }
  if (input.kind !== SESSION_CREDENTIAL_BUNDLE_KIND) {
    throw bundleError("SESSION_BUNDLE_INVALID_KIND", "Session credential bundle kind is invalid.", "$.kind", [
      diagnostic("SESSION_BUNDLE_INVALID_KIND", "$.kind", "The canonical Session credential bundle kind is required."),
    ]);
  }
  const privateKey = parseSessionPrivateKey(required(input, "sessionPrivateKey", "$") as unknown);
  if (typeof input.certificate !== "string") {
    throw bundleError(
      "SESSION_BUNDLE_CERTIFICATE_INVALID",
      "Session Certificate compact encoding is required.",
      "$.certificate",
      [diagnostic("SESSION_BUNDLE_CERTIFICATE_INVALID", "$.certificate", "Certificate must be a compact JWS string.")],
    );
  }
  const decoded = decodeSessionCertificateCompact(input.certificate);
  if (!decoded.valid || decoded.value === undefined) {
    throw bundleError(
      "SESSION_BUNDLE_CERTIFICATE_INVALID",
      "Session Certificate is structurally invalid or non-canonical.",
      "$.certificate",
      decoded.diagnostics.map((item) => diagnostic("SESSION_BUNDLE_CERTIFICATE_INVALID", item.path, item.message)),
    );
  }
  const publicKey = exportRuntimeAuthorityPublicKey(privateKey);
  if (publicKey.x !== decoded.value.payload.sessionKey.x) {
    throw bundleError(
      "SESSION_BUNDLE_CERTIFICATE_KEY_MISMATCH",
      "Session private key does not match the Session Certificate public key.",
      "$.certificate.payload.sessionKey",
      [
        diagnostic(
          "SESSION_BUNDLE_CERTIFICATE_KEY_MISMATCH",
          "$.certificate.payload.sessionKey",
          "Session identity binding failed.",
        ),
      ],
    );
  }
  validateCertificateExpiry(decoded.value);
  const agent = parseAgentMetadata(input.agent, "$.agent", false);
  const bundle = Object.freeze({
    version: SESSION_CREDENTIAL_BUNDLE_VERSION,
    kind: SESSION_CREDENTIAL_BUNDLE_KIND,
    sessionPrivateKey: input.sessionPrivateKey as string,
    certificate: input.certificate,
    ...(agent === undefined ? {} : { agent }),
  });
  return Object.freeze({ bundle, privateKey, certificate: decoded.value });
}

/** Return the canonical JSON representation written to a bundle file. */
export function canonicalSessionCredentialBundleJson(input: SessionCredentialBundle): string {
  const parsed = parseSessionCredentialBundle(input);
  return canonicalJsonString(parsed.bundle as unknown as CanonicalJsonValue);
}

/** Generate a locally-owned opaque Session ID for manual bundle issuance. */
function manualSessionId(): string {
  return randomBytes(MANUAL_SESSION_ID_BYTES).toString("base64url");
}

/** Generate a fresh Session keypair, issue the canonical #367 certificate, and package it. */
export function createSessionCredentialBundle(options: {
  readonly request: unknown;
  readonly runtimeKey: KeyObject | RuntimeAuthorityKeyPair;
  readonly now?: Date;
}): CreatedSessionCredentialBundle {
  const request = parseSessionIssuanceRequest(options.request);
  const sessionId = manualSessionId();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const sessionKey = exportRuntimeAuthorityPublicKey(publicKey);
  const issuanceRequest: ManagedSessionIssuanceRequest = Object.freeze({
    sessionId,
    sessionKey,
    repository: request.repository,
    ...(request.task === undefined ? {} : { task: request.task }),
    capabilities: request.capabilities,
    ttlSeconds: request.ttlSeconds,
  });
  let issued;
  try {
    issued = issueSessionCertificate({
      repository: request.repository,
      runtimeAuthority: request.runtimeAuthority,
      runtimeKey: options.runtimeKey,
      request: issuanceRequest,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  } catch (error: unknown) {
    if (error instanceof SessionCredentialBundleError) throw error;
    const code =
      typeof (error as { code?: unknown }).code === "string"
        ? ((error as { code: string }).code as SessionCredentialBundleErrorCode)
        : "SESSION_BUNDLE_INVALID_REQUEST";
    throw bundleError(
      code,
      error instanceof Error ? error.message : "Session Certificate issuance failed.",
      "$.request",
      [diagnostic(code, "$.request", error instanceof Error ? error.message : "Issuance failed.")],
    );
  }
  const bundle: SessionCredentialBundle = Object.freeze({
    version: SESSION_CREDENTIAL_BUNDLE_VERSION,
    kind: SESSION_CREDENTIAL_BUNDLE_KIND,
    sessionPrivateKey: sessionPrivateKeyPem(privateKey),
    certificate: issued.compact,
    ...(request.agent === undefined ? {} : { agent: request.agent }),
  });
  return parseSessionCredentialBundle(bundle);
}

function currentUserId(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function isOwner(stat: Pick<Stats, "uid">): boolean {
  const userId = currentUserId();
  return userId === undefined || stat.uid === userId || stat.uid === 0;
}

function storageError(
  code: SessionCredentialBundleErrorCode,
  message: string,
  pathValue?: string,
): SessionCredentialBundleError {
  return bundleError(code, message, pathValue, pathValue === undefined ? [] : [diagnostic(code, pathValue, message)]);
}

function assertSafeAncestorDirectory(stat: Stats, pathValue: string): void {
  const mode = stat.mode & 0o7777;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !isOwner(stat) ||
    ((mode & ANCESTOR_WRITE_MODE_MASK) !== 0 && (mode & STICKY_MODE) === 0)
  ) {
    throw storageError("SESSION_BUNDLE_UNSAFE_STORAGE", "Session bundle path contains an unsafe directory.", pathValue);
  }
}

function ensureParentDirectory(directory: string, createMissing: boolean): void {
  const target = path.resolve(directory);
  if (createMissing) {
    try {
      mkdirSync(target, { recursive: true, mode: BUNDLE_DIRECTORY_MODE });
    } catch {
      throw storageError(
        "SESSION_BUNDLE_UNSAFE_STORAGE",
        "Session bundle parent directory cannot be prepared.",
        target,
      );
    }
  }
  const root = path.parse(target).root;
  let current = root;
  try {
    assertSafeAncestorDirectory(lstatSync(current), current);
    for (const component of path
      .relative(root, target)
      .split(path.sep)
      .filter((item) => item.length > 0)) {
      current = path.join(current, component);
      assertSafeAncestorDirectory(lstatSync(current), current);
    }
  } catch (error: unknown) {
    if (error instanceof SessionCredentialBundleError) throw error;
    throw storageError(
      "SESSION_BUNDLE_UNSAFE_STORAGE",
      "Session bundle parent directory cannot be inspected safely.",
      target,
    );
  }
}

function isWithinDirectory(candidatePath: string, directoryPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const directory = path.resolve(directoryPath);
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function targetPath(filePath: string): string {
  if (typeof filePath !== "string" || filePath.trim().length === 0 || filePath === "-") {
    throw storageError("SESSION_BUNDLE_INVALID_PATH", "Session bundle file path is required.", filePath);
  }
  const resolved = path.resolve(filePath);
  if (path.basename(resolved) === "." || path.basename(resolved) === ".." || path.basename(resolved).length === 0) {
    throw storageError("SESSION_BUNDLE_INVALID_PATH", "Session bundle file path is invalid.", resolved);
  }
  const osTempDirectory = path.resolve(os.tmpdir());
  if (isWithinDirectory(resolved, osTempDirectory)) {
    throw storageError(
      "SESSION_BUNDLE_UNSAFE_STORAGE",
      "Session bundle file path cannot be inside the operating system temporary directory.",
      resolved,
    );
  }
  return resolved;
}

function assertSafeBundleFile(stat: Stats, filePath: string): void {
  const mode = stat.mode & 0o777;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !isOwner(stat) ||
    (mode & PUBLIC_MODE_MASK) !== 0 ||
    (mode & EXECUTE_MODE_MASK) !== 0 ||
    (mode & 0o400) === 0
  ) {
    throw storageError(
      "SESSION_BUNDLE_UNSAFE_STORAGE",
      "Session bundle file permissions or type are unsafe.",
      filePath,
    );
  }
  if (stat.size > MAX_SESSION_CREDENTIAL_BUNDLE_BYTES) {
    throw storageError("SESSION_BUNDLE_UNSAFE_STORAGE", "Session bundle file is too large.", filePath);
  }
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Preserve the original fail-closed storage diagnostic.
  }
}

/** Persist a bundle with exclusive creation, no-follow, and owner-only mode. */
export function persistSessionCredentialBundle(filePath: string, input: SessionCredentialBundle): string {
  const target = targetPath(filePath);
  const parsed = parseSessionCredentialBundle(input);
  const content = canonicalSessionCredentialBundleJson(parsed.bundle);
  if (Buffer.byteLength(content, "utf8") > MAX_SESSION_CREDENTIAL_BUNDLE_BYTES) {
    throw storageError("SESSION_BUNDLE_STORAGE_FAILED", "Session bundle is too large to persist.", target);
  }
  ensureParentDirectory(path.dirname(target), true);
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw storageError("SESSION_BUNDLE_UNSAFE_STORAGE", "This platform cannot reject Session bundle symlinks.", target);
  }

  try {
    const existing = lstatSync(target);
    if (existing.isSymbolicLink() || !existing.isFile() || !isOwner(existing)) {
      throw storageError("SESSION_BUNDLE_UNSAFE_STORAGE", "Session bundle output path is unsafe.", target);
    }
    assertSafeBundleFile(existing, target);
    throw storageError(
      "SESSION_BUNDLE_OUTPUT_EXISTS",
      "Session bundle output already exists; overwrite is not allowed.",
      target,
    );
  } catch (error: unknown) {
    if (error instanceof SessionCredentialBundleError) throw error;
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT")
      throw storageError("SESSION_BUNDLE_UNSAFE_STORAGE", "Session bundle output path is unsafe.", target);
  }

  const noFollow = fsConstants.O_NOFOLLOW;
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, BUNDLE_FILE_MODE);
    created = true;
    writeSync(fd, content, undefined, "utf8");
    fchmodSync(fd, BUNDLE_FILE_MODE);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    return target;
  } catch (error: unknown) {
    closeQuietly(fd);
    if (created) {
      try {
        unlinkSync(target);
      } catch {
        // Best-effort cleanup; the original write failure remains authoritative.
      }
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      let existing: Stats | undefined;
      try {
        existing = lstatSync(target);
      } catch {
        // The path raced away; report a generic fail-closed storage error.
      }
      if (existing?.isSymbolicLink())
        throw storageError("SESSION_BUNDLE_UNSAFE_STORAGE", "Session bundle output path is unsafe.", target);
      throw storageError(
        "SESSION_BUNDLE_OUTPUT_EXISTS",
        "Session bundle output already exists; overwrite is not allowed.",
        target,
      );
    }
    if (error instanceof SessionCredentialBundleError) throw error;
    throw storageError("SESSION_BUNDLE_STORAGE_FAILED", "Unable to persist Session credential bundle.", target);
  }
}

function readSecureBundleText(filePath: string): string {
  const target = targetPath(filePath);
  ensureParentDirectory(path.dirname(target), false);
  const noFollow = fsConstants.O_NOFOLLOW;
  const nonBlock = fsConstants.O_NONBLOCK;
  if (typeof noFollow !== "number" || typeof nonBlock !== "number") {
    throw storageError(
      "SESSION_BUNDLE_UNSAFE_STORAGE",
      "This platform cannot safely read Session bundle files.",
      target,
    );
  }
  let fd: number | undefined;
  try {
    fd = openSync(target, fsConstants.O_RDONLY | noFollow | nonBlock);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw storageError("SESSION_BUNDLE_INPUT_NOT_FOUND", "Session credential bundle file was not found.", target);
    }
    throw storageError(
      "SESSION_BUNDLE_UNSAFE_STORAGE",
      "Session credential bundle file cannot be opened safely.",
      target,
    );
  }
  try {
    const stat = fstatSync(fd);
    assertSafeBundleFile(stat, target);
    const buffer = Buffer.alloc(MAX_SESSION_CREDENTIAL_BUNDLE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const bytesRead = readSync(fd, buffer, offset, buffer.byteLength - offset, null);
      offset += bytesRead;
      if (bytesRead === 0) break;
    }
    if (offset > MAX_SESSION_CREDENTIAL_BUNDLE_BYTES) {
      throw storageError("SESSION_BUNDLE_UNSAFE_STORAGE", "Session bundle file is too large.", target);
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeQuietly(fd);
  }
}

/** Load and validate a bundle from a restrictive, non-symlink secret file. */
export function loadSessionCredentialBundle(filePath: string): ParsedSessionCredentialBundle {
  const source = readSecureBundleText(filePath);
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    throw bundleError("SESSION_BUNDLE_INVALID_ROOT", "Session credential bundle file must contain valid JSON.", "$");
  }
  const parsed = parseSessionCredentialBundle(input);
  if (source !== canonicalSessionCredentialBundleJson(parsed.bundle)) {
    throw bundleError(
      "SESSION_BUNDLE_NON_CANONICAL_ENCODING",
      "Session credential bundle JSON is not in canonical encoding.",
      "$",
      [diagnostic("SESSION_BUNDLE_NON_CANONICAL_ENCODING", "$", "Bundle JSON must use canonical encoding.")],
    );
  }
  return parsed;
}

function parsedBundle(input: ParsedSessionCredentialBundle | SessionCredentialBundle): ParsedSessionCredentialBundle {
  if ("privateKey" in input && "certificate" in input && "bundle" in input) {
    return parseSessionCredentialBundle(input.bundle);
  }
  return parseSessionCredentialBundle(input);
}

/** Project only safe metadata; no private key or compact certificate is returned. */
export function inspectSessionCredentialBundle(
  input: ParsedSessionCredentialBundle | SessionCredentialBundle,
): SessionCredentialBundleInspection {
  const parsed = parsedBundle(input);
  const { header, payload } = parsed.certificate;
  const sessionId = payload.sub.startsWith(SESSION_SUBJECT_PREFIX)
    ? payload.sub.slice(SESSION_SUBJECT_PREFIX.length)
    : payload.sub;
  return Object.freeze({
    ok: true,
    valid: true,
    operation: "session.inspect",
    bundle: Object.freeze({ version: parsed.bundle.version, kind: parsed.bundle.kind }),
    repository: payload.repository,
    ...(payload.task === undefined ? {} : { task: payload.task }),
    capabilities: payload.capabilities,
    expiry: Object.freeze({ iat: payload.iat, nbf: payload.nbf, exp: payload.exp }),
    runtime: Object.freeze({ authorityId: header.kid, issuer: payload.iss }),
    session: Object.freeze({ id: sessionId, certificateId: payload.jti, publicKey: payload.sessionKey }),
    certificate: Object.freeze({ alg: header.alg, typ: header.typ }),
    ...(parsed.bundle.agent === undefined ? {} : { agent: parsed.bundle.agent }),
  });
}
