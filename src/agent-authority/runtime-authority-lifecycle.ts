/**
 * Local Runtime Authority trust-root lifecycle.
 *
 * This module owns the operator-side materialization boundary only. It never
 * accepts or reads a Runtime private key. Runtime Authority schema validation,
 * canonical JSON, and the protected-path classification remain delegated to
 * their existing authorities.
 */

import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeSync,
  type Dirent,
  type Stats,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_RUNTIME_AUTHORITY_ID_LENGTH,
  RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY,
  RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX,
  RUNTIME_AUTHORITY_ID_PATTERN,
  canonicalRuntimeAuthorityJson,
  validateRuntimeAuthority,
  type RuntimeAuthority,
} from "./runtime-authority.js";
import { classifyRepositoryPath } from "./protected-paths.js";
import { runtimeAuthorityArtifactPath } from "./runtime-authority-trust.js";

export const RUNTIME_AUTHORITY_ROTATION_KIND = "runtime-authority-rotation" as const;
export const RUNTIME_AUTHORITY_ROTATION_VERSION = 1 as const;
export const MAX_RUNTIME_AUTHORITY_ARTIFACT_BYTES = 1_048_576 as const;

export interface RuntimeAuthorityRotation {
  readonly version: typeof RUNTIME_AUTHORITY_ROTATION_VERSION;
  readonly kind: typeof RUNTIME_AUTHORITY_ROTATION_KIND;
  readonly currentAuthorityId: string;
  readonly nextAuthority: RuntimeAuthority;
}

export type RuntimeAuthorityLifecycleOperation = "register" | "rotate" | "revoke";

export type RuntimeAuthorityLifecycleErrorCode =
  | "RUNTIME_AUTHORITY_LIFECYCLE_INVALID_INPUT"
  | "RUNTIME_AUTHORITY_LIFECYCLE_INVALID_ROTATION"
  | "RUNTIME_AUTHORITY_LIFECYCLE_STATUS_INVALID"
  | "RUNTIME_AUTHORITY_LIFECYCLE_PATH_INVALID"
  | "RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_INVALID"
  | "RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_NOT_FOUND"
  | "RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_EXISTS"
  | "RUNTIME_AUTHORITY_LIFECYCLE_DUPLICATE_ID"
  | "RUNTIME_AUTHORITY_LIFECYCLE_DUPLICATE_PUBLIC_KEY"
  | "RUNTIME_AUTHORITY_LIFECYCLE_CURRENT_INACTIVE"
  | "RUNTIME_AUTHORITY_LIFECYCLE_STORAGE_FAILED";

export interface RuntimeAuthorityLifecycleErrorDetails {
  readonly operation?: RuntimeAuthorityLifecycleOperation;
  readonly path?: string;
  readonly authorityId?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

/** Safe, bounded diagnostics for local trust-root failures. */
export class RuntimeAuthorityLifecycleError extends Error {
  readonly code: RuntimeAuthorityLifecycleErrorCode;
  readonly details: Readonly<RuntimeAuthorityLifecycleErrorDetails>;
  readonly diagnostics: readonly unknown[];

  constructor(
    code: RuntimeAuthorityLifecycleErrorCode,
    message: string,
    details: RuntimeAuthorityLifecycleErrorDetails = {},
    diagnostics: readonly unknown[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeAuthorityLifecycleError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

export interface LocalRuntimeAuthorityArtifact {
  readonly path: string;
  readonly absolutePath: string;
  readonly source: string;
  readonly authority: RuntimeAuthority;
}

export interface LocalRuntimeAuthorityRepository {
  readonly root: string;
  readonly artifacts: readonly LocalRuntimeAuthorityArtifact[];
}

export interface RuntimeAuthorityLifecycleResult {
  readonly ok: true;
  readonly operation: `authority.${RuntimeAuthorityLifecycleOperation}`;
  readonly path: string;
  readonly authority: RuntimeAuthority;
  readonly changed: boolean;
}

const ROTATION_KEYS = new Set(["version", "kind", "currentAuthorityId", "nextAuthority"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown, code: string): boolean {
  return value instanceof Error && "code" in value && value.code === code;
}

function isAuthorityId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_RUNTIME_AUTHORITY_ID_LENGTH &&
    RUNTIME_AUTHORITY_ID_PATTERN.test(value)
  );
}

function lifecycleError(
  code: RuntimeAuthorityLifecycleErrorCode,
  message: string,
  operation: RuntimeAuthorityLifecycleOperation | undefined,
  details: RuntimeAuthorityLifecycleErrorDetails = {},
  diagnostics: readonly unknown[] = [],
  cause?: unknown,
): RuntimeAuthorityLifecycleError {
  return new RuntimeAuthorityLifecycleError(
    code,
    message,
    { ...(operation === undefined ? {} : { operation }), ...details },
    diagnostics,
    cause === undefined ? undefined : { cause },
  );
}

function protectedRelativePath(relativePath: string, operation: RuntimeAuthorityLifecycleOperation): string {
  const classification = classifyRepositoryPath(relativePath);
  if (classification.kind !== "protected") {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_PATH_INVALID",
      "Runtime Authority lifecycle paths must be under the canonical protected trust root.",
      operation,
      { path: relativePath, reason: classification.kind === "invalid" ? classification.reason : "unprotected path" },
    );
  }
  return classification.path;
}

function authorityRelativePath(authorityId: string, operation: RuntimeAuthorityLifecycleOperation): string {
  if (!isAuthorityId(authorityId)) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_PATH_INVALID",
      "Runtime Authority identifier is not a valid canonical artifact identifier.",
      operation,
      { authorityId, reason: "invalid authority identifier" },
    );
  }
  return protectedRelativePath(runtimeAuthorityArtifactPath(authorityId), operation);
}

function authorityDirectory(root: string, operation: RuntimeAuthorityLifecycleOperation): string {
  const relative = protectedRelativePath(RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY, operation);
  return path.join(root, ...relative.split("/"));
}

function assertDirectory(stat: Stats, operation: RuntimeAuthorityLifecycleOperation, relativePath: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_PATH_INVALID",
      `Canonical Runtime Authority path "${relativePath}" is not a directory.`,
      operation,
      { path: relativePath, reason: "symbolic link or non-directory path" },
    );
  }
}

function ensureAuthorityDirectory(root: string, operation: RuntimeAuthorityLifecycleOperation): string {
  let current = path.resolve(root);
  try {
    const rootStat = lstatSync(current);
    assertDirectory(rootStat, operation, ".");
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      throw lifecycleError(
        "RUNTIME_AUTHORITY_LIFECYCLE_STORAGE_FAILED",
        "Repository root does not exist.",
        operation,
        { path: root, reason: "repository root is missing" },
        [],
        error,
      );
    }
    if (error instanceof RuntimeAuthorityLifecycleError) throw error;
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_STORAGE_FAILED",
      "Unable to inspect the repository root for Runtime Authority storage.",
      operation,
      { path: root, reason: "repository root inspection failed" },
      [],
      error,
    );
  }

  for (const segment of RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY.split("/")) {
    current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      assertDirectory(stat, operation, path.relative(root, current).split(path.sep).join("/"));
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) {
        if (error instanceof RuntimeAuthorityLifecycleError) throw error;
        throw lifecycleError(
          "RUNTIME_AUTHORITY_LIFECYCLE_STORAGE_FAILED",
          "Unable to inspect the canonical Runtime Authority directory.",
          operation,
          { path: current, reason: "directory inspection failed" },
          [],
          error,
        );
      }
      try {
        mkdirSync(current, { mode: 0o755 });
      } catch (mkdirError: unknown) {
        throw lifecycleError(
          "RUNTIME_AUTHORITY_LIFECYCLE_STORAGE_FAILED",
          "Unable to create the canonical Runtime Authority directory.",
          operation,
          { path: current, reason: "directory creation failed" },
          [],
          mkdirError,
        );
      }
    }
  }
  return current;
}

function readBoundedFile(filePath: string, operation: RuntimeAuthorityLifecycleOperation): string {
  let stat: Stats;
  try {
    stat = lstatSync(filePath);
  } catch (error: unknown) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_STORAGE_FAILED",
      "Unable to inspect a Runtime Authority artifact.",
      operation,
      { path: filePath, reason: "artifact inspection failed" },
      [],
      error,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_INVALID",
      "Runtime Authority artifacts must be regular files.",
      operation,
      { path: filePath, reason: "symbolic link or non-file artifact" },
    );
  }
  if (stat.size > MAX_RUNTIME_AUTHORITY_ARTIFACT_BYTES) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_INVALID",
      `Runtime Authority artifact exceeds the ${MAX_RUNTIME_AUTHORITY_ARTIFACT_BYTES}-byte limit.`,
      operation,
      { path: filePath, reason: "artifact is too large" },
    );
  }
  try {
    return readFileSync(filePath, "utf8");
  } catch (error: unknown) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_STORAGE_FAILED",
      "Unable to read a Runtime Authority artifact.",
      operation,
      { path: filePath, reason: "artifact read failed" },
      [],
      error,
    );
  }
}

function parseAuthoritySource(
  source: string,
  operation: RuntimeAuthorityLifecycleOperation,
  sourcePath: string,
  expectedId?: string,
  requireCanonical = false,
): RuntimeAuthority {
  let raw: unknown;
  try {
    raw = JSON.parse(source) as unknown;
  } catch (error: unknown) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_INVALID",
      "Runtime Authority input must contain valid JSON.",
      operation,
      { path: sourcePath, reason: "invalid JSON" },
      [],
      error,
    );
  }
  const validation = validateRuntimeAuthority(raw, "$runtimeAuthority");
  if (!validation.valid || validation.value === undefined) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_INVALID",
      "Runtime Authority input failed the existing Runtime Authority schema authority.",
      operation,
      { path: sourcePath, reason: "schema validation failed" },
      validation.diagnostics,
    );
  }
  const authority = validation.value;
  if (expectedId !== undefined && authority.id !== expectedId) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_INVALID",
      `Runtime Authority id "${authority.id}" does not match canonical filename id "${expectedId}".`,
      operation,
      { path: sourcePath, authorityId: authority.id, reason: "filename and record id differ" },
    );
  }
  if (requireCanonical && source !== canonicalRuntimeAuthorityJson(authority)) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_INVALID",
      "Runtime Authority artifact JSON is not canonical.",
      operation,
      { path: sourcePath, authorityId: authority.id, reason: "noncanonical JSON bytes" },
    );
  }
  return authority;
}

function entryNameToAuthorityId(entry: Dirent, operation: RuntimeAuthorityLifecycleOperation): string {
  if (!entry.isFile()) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_INVALID",
      "The Runtime Authority directory contains an unsupported non-file entry.",
      operation,
      { path: `${RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY}/${entry.name}`, reason: "unsupported directory entry" },
    );
  }
  if (!entry.name.endsWith(".json")) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_INVALID",
      "Runtime Authority artifacts must use the canonical .json filename suffix.",
      operation,
      { path: `${RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY}/${entry.name}`, reason: "unsupported filename" },
    );
  }
  const id = entry.name.slice(0, -".json".length);
  if (!isAuthorityId(id)) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_INVALID",
      "Runtime Authority artifact filename is not a valid authority identifier.",
      operation,
      { path: `${RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY}/${entry.name}`, authorityId: id, reason: "invalid filename id" },
    );
  }
  return id;
}

/** Read and validate every canonical local Runtime Authority artifact. */
export function loadLocalRuntimeAuthorityRepository(
  root: string,
  operation: RuntimeAuthorityLifecycleOperation = "register",
): LocalRuntimeAuthorityRepository {
  const resolvedRoot = path.resolve(root);
  const directory = authorityDirectory(resolvedRoot, operation);
  try {
    const rootStat = lstatSync(resolvedRoot);
    assertDirectory(rootStat, operation, ".");
    let current = resolvedRoot;
    for (const segment of RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY.split("/")) {
      current = path.join(current, segment);
      const stat = lstatSync(current);
      assertDirectory(stat, operation, path.relative(resolvedRoot, current).split(path.sep).join("/"));
    }
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return Object.freeze({ root: resolvedRoot, artifacts: Object.freeze([]) });
    if (error instanceof RuntimeAuthorityLifecycleError) throw error;
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_STORAGE_FAILED",
      "Unable to inspect the canonical Runtime Authority directory.",
      operation,
      { path: directory, reason: "directory inspection failed" },
      [],
      error,
    );
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return Object.freeze({ root: resolvedRoot, artifacts: Object.freeze([]) });
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_STORAGE_FAILED",
      "Unable to read the canonical Runtime Authority directory.",
      operation,
      { path: directory, reason: "directory read failed" },
      [],
      error,
    );
  }

  const artifacts: LocalRuntimeAuthorityArtifact[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const entry of entries) {
    const id = entryNameToAuthorityId(entry, operation);
    const relative = authorityRelativePath(id, operation);
    const absolutePath = path.join(resolvedRoot, ...relative.split("/"));
    const source = readBoundedFile(absolutePath, operation);
    const authority = parseAuthoritySource(source, operation, relative, id, true);
    if (ids.has(authority.id)) {
      throw lifecycleError(
        "RUNTIME_AUTHORITY_LIFECYCLE_DUPLICATE_ID",
        `Runtime Authority id "${authority.id}" appears more than once.`,
        operation,
        { path: relative, authorityId: authority.id, reason: "duplicate authority id" },
      );
    }
    if (keys.has(authority.key.x)) {
      throw lifecycleError(
        "RUNTIME_AUTHORITY_LIFECYCLE_DUPLICATE_PUBLIC_KEY",
        "The same Ed25519 public key appears in more than one Runtime Authority record.",
        operation,
        { path: relative, authorityId: authority.id, reason: "duplicate public key" },
      );
    }
    ids.add(authority.id);
    keys.add(authority.key.x);
    artifacts.push(Object.freeze({ path: relative, absolutePath, source, authority }));
  }
  return Object.freeze({ root: resolvedRoot, artifacts: Object.freeze(artifacts) });
}

function parseInputAuthority(input: unknown, operation: RuntimeAuthorityLifecycleOperation): RuntimeAuthority {
  const source = JSON.stringify(input);
  if (source === undefined) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_INVALID_INPUT",
      "Runtime Authority input must be one JSON object.",
      operation,
      { path: "$", reason: "input is not JSON" },
    );
  }
  return parseAuthoritySource(source, operation, "$from", undefined, false);
}

/** Parse the exact phase-1 overlap rotation envelope. */
export function parseRuntimeAuthorityRotation(input: unknown): RuntimeAuthorityRotation {
  if (!isRecord(input)) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_INVALID_ROTATION",
      "Runtime Authority rotation input must be one JSON object.",
      "rotate",
      { path: "$from", reason: "rotation envelope is not an object" },
    );
  }
  for (const key of Object.keys(input)) {
    if (!ROTATION_KEYS.has(key)) {
      throw lifecycleError(
        "RUNTIME_AUTHORITY_LIFECYCLE_INVALID_ROTATION",
        `Runtime Authority rotation property "${key}" is not accepted.`,
        "rotate",
        { path: `$from.${key}`, reason: "unknown rotation property" },
      );
    }
  }
  if (input.version !== RUNTIME_AUTHORITY_ROTATION_VERSION || input.kind !== RUNTIME_AUTHORITY_ROTATION_KIND) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_INVALID_ROTATION",
      "Runtime Authority rotation version or kind is unsupported.",
      "rotate",
      { path: "$from", reason: "unsupported rotation envelope" },
    );
  }
  if (!isAuthorityId(input.currentAuthorityId)) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_INVALID_ROTATION",
      "currentAuthorityId must be a valid canonical authority identifier.",
      "rotate",
      { path: "$from.currentAuthorityId", reason: "invalid current authority identifier" },
    );
  }
  const nextAuthoritySource = JSON.stringify(input.nextAuthority);
  if (nextAuthoritySource === undefined) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_INVALID_ROTATION",
      "nextAuthority must be one Runtime Authority object.",
      "rotate",
      { path: "$from.nextAuthority", reason: "missing rotation authority" },
    );
  }
  const nextAuthority = parseAuthoritySource(nextAuthoritySource, "rotate", "$from.nextAuthority", undefined, false);
  return Object.freeze({
    version: RUNTIME_AUTHORITY_ROTATION_VERSION,
    kind: RUNTIME_AUTHORITY_ROTATION_KIND,
    currentAuthorityId: input.currentAuthorityId,
    nextAuthority,
  });
}

function assertActive(authority: RuntimeAuthority, operation: RuntimeAuthorityLifecycleOperation, role: string): void {
  if (authority.status !== "active") {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_STATUS_INVALID",
      `${role} Runtime Authority must have status "active".`,
      operation,
      { authorityId: authority.id, reason: `${role} authority is not active` },
    );
  }
}

function assertUniqueAuthority(
  authority: RuntimeAuthority,
  artifacts: readonly LocalRuntimeAuthorityArtifact[],
  operation: RuntimeAuthorityLifecycleOperation,
): void {
  if (artifacts.some((artifact) => artifact.authority.id === authority.id)) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_DUPLICATE_ID",
      `Runtime Authority id "${authority.id}" is already trusted by this repository.`,
      operation,
      { authorityId: authority.id, reason: "duplicate authority id" },
    );
  }
  if (artifacts.some((artifact) => artifact.authority.key.x === authority.key.x)) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_DUPLICATE_PUBLIC_KEY",
      "The Runtime Authority Ed25519 public key is already trusted by this repository.",
      operation,
      { authorityId: authority.id, reason: "duplicate public key" },
    );
  }
}

function assertDestinationAbsent(
  absolutePath: string,
  relativePath: string,
  operation: RuntimeAuthorityLifecycleOperation,
): void {
  try {
    lstatSync(absolutePath);
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_EXISTS",
      `Runtime Authority destination "${relativePath}" already exists.`,
      operation,
      { path: relativePath, reason: "exclusive creation requires an absent destination" },
    );
  } catch (error: unknown) {
    if (error instanceof RuntimeAuthorityLifecycleError) throw error;
    if (isNodeError(error, "ENOENT")) return;
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_STORAGE_FAILED",
      "Unable to inspect the Runtime Authority destination.",
      operation,
      { path: relativePath, reason: "destination inspection failed" },
      [],
      error,
    );
  }
}

function assertNonTemporaryRepositoryRoot(root: string, operation: RuntimeAuthorityLifecycleOperation): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTemp = path.resolve(os.tmpdir());
  const relativeToTemp = path.relative(resolvedTemp, resolvedRoot);
  const isTempRoot = relativeToTemp === "" || (!relativeToTemp.startsWith("..") && !path.isAbsolute(relativeToTemp));
  if (!isTempRoot) return;
  throw lifecycleError(
    "RUNTIME_AUTHORITY_LIFECYCLE_STORAGE_FAILED",
    "Runtime Authority artifacts must not be written under the operating system temporary directory.",
    operation,
    { path: resolvedRoot, reason: "temporary repository root is not allowed for authority lifecycle writes" },
  );
}

function writeExclusive(
  absolutePath: string,
  relativePath: string,
  content: string,
  operation: RuntimeAuthorityLifecycleOperation,
): void {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(absolutePath, flags, 0o644);
    created = true;
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error: unknown) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original storage diagnostic.
      }
    }
    if (created) {
      try {
        unlinkSync(absolutePath);
      } catch {
        // Preserve the original storage diagnostic.
      }
    }
    if (isNodeError(error, "EEXIST")) {
      throw lifecycleError(
        "RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_EXISTS",
        `Runtime Authority destination "${relativePath}" already exists.`,
        operation,
        { path: relativePath, reason: "exclusive creation rejected an existing destination" },
        [],
        error,
      );
    }
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_STORAGE_FAILED",
      "Unable to write the canonical Runtime Authority artifact.",
      operation,
      { path: relativePath, reason: "exclusive artifact write failed" },
      [],
      error,
    );
  }
}

function writeExisting(
  absolutePath: string,
  relativePath: string,
  content: string,
  operation: RuntimeAuthorityLifecycleOperation,
): void {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = openSync(absolutePath, fsConstants.O_WRONLY | fsConstants.O_TRUNC | noFollow);
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error: unknown) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original storage diagnostic.
      }
    }
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_STORAGE_FAILED",
      "Unable to update the canonical Runtime Authority artifact.",
      operation,
      { path: relativePath, reason: "artifact update failed" },
      [],
      error,
    );
  }
}

/** Register one active public Runtime Authority by exclusive local creation. */
export function registerRuntimeAuthority(root: string, input: unknown): RuntimeAuthorityLifecycleResult {
  const operation = "register" as const;
  const authority = parseInputAuthority(input, operation);
  assertActive(authority, operation, "Registered");
  const relativePath = authorityRelativePath(authority.id, operation);
  const resolvedRoot = path.resolve(root);
  assertNonTemporaryRepositoryRoot(resolvedRoot, operation);
  const absolutePath = path.join(resolvedRoot, ...relativePath.split("/"));
  assertDestinationAbsent(absolutePath, relativePath, operation);
  const repository = loadLocalRuntimeAuthorityRepository(resolvedRoot, operation);
  assertUniqueAuthority(authority, repository.artifacts, operation);
  ensureAuthorityDirectory(resolvedRoot, operation);
  writeExclusive(absolutePath, relativePath, canonicalRuntimeAuthorityJson(authority), operation);
  return Object.freeze({ ok: true, operation: "authority.register", path: relativePath, authority, changed: true });
}

/** Add one distinct active authority while leaving the current artifact untouched. */
export function rotateRuntimeAuthority(root: string, input: unknown): RuntimeAuthorityLifecycleResult {
  const operation = "rotate" as const;
  const rotation = parseRuntimeAuthorityRotation(input);
  assertActive(rotation.nextAuthority, operation, "Next");
  const resolvedRoot = path.resolve(root);
  assertNonTemporaryRepositoryRoot(resolvedRoot, operation);
  const repository = loadLocalRuntimeAuthorityRepository(resolvedRoot, operation);
  const current = repository.artifacts.find((artifact) => artifact.authority.id === rotation.currentAuthorityId);
  if (current === undefined) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_NOT_FOUND",
      `Current Runtime Authority "${rotation.currentAuthorityId}" is not trusted by this repository.`,
      operation,
      { authorityId: rotation.currentAuthorityId, reason: "current authority was not found" },
    );
  }
  if (current.authority.status !== "active") {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_CURRENT_INACTIVE",
      `Current Runtime Authority "${rotation.currentAuthorityId}" is not active.`,
      operation,
      { authorityId: rotation.currentAuthorityId, reason: "current authority is disabled" },
    );
  }
  assertUniqueAuthority(rotation.nextAuthority, repository.artifacts, operation);
  const relativePath = authorityRelativePath(rotation.nextAuthority.id, operation);
  const absolutePath = path.join(resolvedRoot, ...relativePath.split("/"));
  assertDestinationAbsent(absolutePath, relativePath, operation);
  ensureAuthorityDirectory(resolvedRoot, operation);
  writeExclusive(absolutePath, relativePath, canonicalRuntimeAuthorityJson(rotation.nextAuthority), operation);
  return Object.freeze({
    ok: true,
    operation: "authority.rotate",
    path: relativePath,
    authority: rotation.nextAuthority,
    changed: true,
  });
}

/** Disable one exact canonical authority artifact; disabled is idempotent. */
export function revokeRuntimeAuthority(root: string, authorityId: string): RuntimeAuthorityLifecycleResult {
  const operation = "revoke" as const;
  const relativePath = authorityRelativePath(authorityId, operation);
  const repository = loadLocalRuntimeAuthorityRepository(path.resolve(root), operation);
  const artifact = repository.artifacts.find((candidate) => candidate.path === relativePath);
  if (artifact === undefined) {
    throw lifecycleError(
      "RUNTIME_AUTHORITY_LIFECYCLE_ARTIFACT_NOT_FOUND",
      `Runtime Authority "${authorityId}" does not have an exact canonical artifact.`,
      operation,
      { authorityId, path: relativePath, reason: "canonical authority artifact was not found" },
    );
  }
  if (artifact.authority.status === "disabled") {
    return Object.freeze({
      ok: true,
      operation: "authority.revoke",
      path: relativePath,
      authority: artifact.authority,
      changed: false,
    });
  }
  const disabled = Object.freeze({ ...artifact.authority, status: "disabled" as const });
  writeExisting(artifact.absolutePath, relativePath, canonicalRuntimeAuthorityJson(disabled), operation);
  return Object.freeze({
    ok: true,
    operation: "authority.revoke",
    path: relativePath,
    authority: disabled,
    changed: true,
  });
}
