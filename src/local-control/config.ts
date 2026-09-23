/**
 * Bounded persistence for the local CLI, Admission, Executor, and Authority
 * configuration roots. Config schemas are deliberately closed and versioned.
 */

import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const LOCAL_CONFIG_VERSION = 1 as const;
export const MAX_LOCAL_CONFIG_BYTES = 64 * 1024;
const MAX_LOCAL_PRIVATE_FILE_BYTES = 256 * 1024;

export type LocalComponent = "cli" | "authority" | "admission" | "executor";

export interface LocalAdmissionRoute {
  readonly id: string;
  readonly endpoint: string;
}

export interface LocalCliConfig {
  readonly version: typeof LOCAL_CONFIG_VERSION;
  readonly topology: {
    readonly admission: "local";
    readonly executor: "local";
  };
  /** Bound later by local Admission setup; init never invents its identity. */
  readonly admission?: LocalAdmissionRoute;
}

export interface LocalAdmissionConfig {
  readonly version: typeof LOCAL_CONFIG_VERSION;
  readonly id: string;
  readonly listen: { readonly host: "127.0.0.1" | "0.0.0.0"; readonly port: number };
  readonly executor: { readonly id: string; readonly endpoint: string };
}

export interface LocalExecutorConfig {
  readonly version: typeof LOCAL_CONFIG_VERSION;
  readonly id: string;
  readonly listen: { readonly host: "127.0.0.1" | "0.0.0.0"; readonly port: number };
  readonly provider: { readonly kind: "github"; readonly credentialProfile: string };
}

export interface LocalAuthorityConfig {
  readonly version: typeof LOCAL_CONFIG_VERSION;
  readonly publicKey: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };
  readonly publicKeyFingerprint: string;
  readonly privateKeyFile: "private-key.pem";
}

export type LocalConfigValidator<T> = (value: unknown) => T;

export type LocalControlErrorCode =
  | "LOCAL_CONTROL_INVALID_CONFIG"
  | "LOCAL_CONTROL_UNSAFE_STORAGE"
  | "LOCAL_CONTROL_CONFIG_CONFLICT"
  | "LOCAL_CONTROL_CONFIG_TOO_LARGE"
  | "LOCAL_CONTROL_STORAGE_FAILED";

export class LocalControlError extends Error {
  readonly code: LocalControlErrorCode;

  constructor(code: LocalControlErrorCode, message: string) {
    super(message);
    this.name = "LocalControlError";
    this.code = code;
  }
}

const COMPONENT_NAMES: ReadonlySet<string> = new Set(["cli", "authority", "admission", "executor"]);
const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const ID_VALUE = /^[a-zA-Z0-9_-]{16,64}$/u;
const LOCALHOST = "127.0.0.1";
const NON_LOOPBACK_BIND = "0.0.0.0";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_MODE_MASK = 0o077;
const ANCESTOR_WRITE_MASK = 0o022;
const STICKY_MODE = 0o1000;

interface DirectoryHandle {
  readonly fd: number;
}

function invalid(message: string): LocalControlError {
  return new LocalControlError("LOCAL_CONTROL_INVALID_CONFIG", message);
}

function unsafe(message: string): LocalControlError {
  return new LocalControlError("LOCAL_CONTROL_UNSAFE_STORAGE", message);
}

function currentUserId(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function isOwner(stat: Pick<Stats, "uid">): boolean {
  const uid = currentUserId();
  return uid === undefined || stat.uid === uid;
}

function assertSafeAncestor(stat: Stats): void {
  const mode = stat.mode & 0o7777;
  const uid = currentUserId();
  const trustedOwner = uid === undefined || stat.uid === uid || stat.uid === 0;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !trustedOwner ||
    ((mode & ANCESTOR_WRITE_MASK) !== 0 && (mode & STICKY_MODE) === 0)
  ) {
    throw unsafe("Local configuration path contains an unsafe directory.");
  }
}

function assertPrivateDirectory(stat: Stats): void {
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwner(stat)) {
    throw unsafe("Local configuration directory is unsafe.");
  }
}

function noFollow(): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw unsafe("This platform cannot safely reject local configuration symlinks.");
  }
  return fsConstants.O_NOFOLLOW;
}

function descriptorRoot(): string | undefined {
  if (process.platform === "linux") return "/proc/self/fd";
  if (process.platform === "darwin" || process.platform === "freebsd") return "/dev/fd";
  return undefined;
}

function descriptorPath(fd: number, child?: string): string {
  const root = descriptorRoot();
  if (root === undefined) throw unsafe("This platform cannot safely anchor local configuration paths.");
  return child === undefined ? path.join(root, String(fd)) : path.join(root, String(fd), child);
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Keep the original bounded storage diagnostic.
  }
}

function directoryFlags(): number {
  const directory = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
  return fsConstants.O_RDONLY | noFollow() | directory;
}

function openDirectory(pathname: string, privateDirectory: boolean): number {
  let fd: number;
  try {
    fd = openSync(pathname, directoryFlags());
  } catch {
    throw unsafe("Local configuration path contains an unsafe directory.");
  }
  try {
    const stat = fstatSync(fd);
    if (privateDirectory) {
      assertPrivateDirectory(stat);
      fchmodSync(fd, PRIVATE_DIRECTORY_MODE);
    } else {
      assertSafeAncestor(stat);
    }
    return fd;
  } catch (error: unknown) {
    closeQuietly(fd);
    throw error;
  }
}

function openSecureDirectory(directoryPath: string, create: boolean): DirectoryHandle {
  const target = path.resolve(directoryPath);
  const root = path.parse(target).root;
  const rootFd = openDirectory(root, false);
  let current: DirectoryHandle = { fd: rootFd };
  const components = path
    .relative(root, target)
    .split(path.sep)
    .filter((part) => part.length > 0);

  try {
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index];
      if (component === undefined) continue;
      const childPath = descriptorPath(current.fd, component);
      const isFinal = index === components.length - 1;
      let childFd: number;
      try {
        childFd = openDirectory(childPath, isFinal);
      } catch (error: unknown) {
        if (!create) throw error;
        try {
          mkdirSync(childPath, { mode: PRIVATE_DIRECTORY_MODE });
        } catch (mkdirError: unknown) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
            throw new LocalControlError(
              "LOCAL_CONTROL_STORAGE_FAILED",
              "Unable to prepare local configuration storage.",
            );
          }
        }
        childFd = openDirectory(childPath, isFinal);
      }
      closeQuietly(current.fd);
      current = { fd: childFd };
    }
    if (components.length === 0) throw unsafe("A filesystem root cannot be used as local configuration storage.");
    return current;
  } catch (error: unknown) {
    closeQuietly(current.fd);
    throw error;
  }
}

function withSecureDirectory<T>(directoryPath: string, operation: (directory: DirectoryHandle) => T): T {
  const directory = openSecureDirectory(directoryPath, true);
  try {
    return operation(directory);
  } finally {
    closeQuietly(directory.fd);
  }
}

export function resolveConfigHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.INARI_CONFIG_HOME;
  if (configured !== undefined) {
    if (configured.trim().length === 0) throw invalid("INARI_CONFIG_HOME must not be empty.");
    return path.resolve(configured);
  }
  return path.join(os.homedir(), ".config", "inari");
}

export function localComponentDirectory(
  component: LocalComponent,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (!COMPONENT_NAMES.has(component)) throw invalid("Unknown local component.");
  return path.join(resolveConfigHome(environment), component);
}

export function localComponentPath(
  component: LocalComponent,
  relativePath: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (!COMPONENT_NAMES.has(component)) throw invalid("Unknown local component.");
  const parts = relativePath.split(/[\\/]/u);
  if (parts.length === 0 || parts.some((part) => !SAFE_SEGMENT.test(part) || part === "." || part === "..")) {
    throw invalid("Local configuration path is invalid.");
  }
  return path.join(localComponentDirectory(component, environment), ...parts);
}

export function ensureLocalComponentDirectory(
  component: LocalComponent,
  environment: NodeJS.ProcessEnv = process.env,
  ...subdirectories: string[]
): string {
  const directory =
    subdirectories.length === 0
      ? localComponentDirectory(component, environment)
      : localComponentPath(component, path.join(...subdirectories), environment);
  return withSecureDirectory(resolveConfigHome(environment), () => withSecureDirectory(directory, () => directory));
}

function assertRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(message);
  return value as Record<string, unknown>;
}

function assertClosed(value: Record<string, unknown>, keys: readonly string[], message: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw invalid(message);
}

function assertVersion(value: unknown): void {
  if (value !== LOCAL_CONFIG_VERSION) throw invalid("Local configuration version is unsupported.");
}

function assertId(value: unknown, prefix: "adm_" | "exec_"): string {
  if (typeof value !== "string" || !value.startsWith(prefix) || !ID_VALUE.test(value.slice(prefix.length))) {
    throw invalid("Local component identity is invalid.");
  }
  return value;
}

function assertPort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw invalid("Local component port is invalid.");
  }
  return value;
}

function assertConfiguredEndpoint(value: unknown, protocols: readonly string[]): string {
  if (typeof value !== "string" || value.length > 256) throw invalid("Local component endpoint is invalid.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("Local component endpoint is invalid.");
  }
  if (
    !protocols.includes(url.protocol) ||
    url.hostname !== LOCALHOST ||
    url.port.length === 0 ||
    Number(url.port) < 1 ||
    Number(url.port) > 65535 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw invalid("Local component endpoint must use an explicit loopback destination and port.");
  }
  return url.origin;
}

function assertLoopbackEndpoint(value: unknown): string {
  return assertConfiguredEndpoint(value, ["http:"]);
}

function assertExecutorEndpoint(value: unknown, bindHost: "127.0.0.1" | "0.0.0.0"): string {
  const protocol = bindHost === NON_LOOPBACK_BIND ? "https:" : "http:";
  return assertConfiguredEndpoint(value, [protocol]);
}

function assertListen(value: unknown): { readonly host: "127.0.0.1" | "0.0.0.0"; readonly port: number } {
  const listen = assertRecord(value, "Local component listen address is invalid.");
  assertClosed(listen, ["host", "port"], "Local component listen address has unsupported fields.");
  if (listen.host !== LOCALHOST && listen.host !== NON_LOOPBACK_BIND) {
    throw invalid("Local component bind host must be 127.0.0.1 or 0.0.0.0.");
  }
  return { host: listen.host, port: assertPort(listen.port) };
}

export function configuredLocalRuntimeBindHost(environment: NodeJS.ProcessEnv = process.env): "127.0.0.1" | "0.0.0.0" {
  const host = environment.INARI_LOCAL_RUNTIME_BIND;
  if (host === undefined || host === "loopback") return LOCALHOST;
  if (host === NON_LOOPBACK_BIND) return NON_LOOPBACK_BIND;
  throw invalid("INARI_LOCAL_RUNTIME_BIND must be loopback or 0.0.0.0.");
}

export function validateLocalCliConfig(value: unknown): LocalCliConfig {
  const config = assertRecord(value, "CLI configuration is invalid.");
  assertClosed(config, ["version", "topology", "admission"], "CLI configuration has unsupported fields.");
  assertVersion(config.version);
  const topology = assertRecord(config.topology, "CLI topology is invalid.");
  assertClosed(topology, ["admission", "executor"], "CLI topology has unsupported fields.");
  if (topology.admission !== "local" || topology.executor !== "local") {
    throw invalid("CLI topology must declare local Admission and Executor components.");
  }
  let admission: LocalAdmissionRoute | undefined;
  if (config.admission !== undefined) {
    const route = assertRecord(config.admission, "CLI Admission route is invalid.");
    assertClosed(route, ["id", "endpoint"], "CLI Admission route has unsupported fields.");
    admission = { id: assertId(route.id, "adm_"), endpoint: assertLoopbackEndpoint(route.endpoint) };
  }
  return {
    version: LOCAL_CONFIG_VERSION,
    topology: { admission: "local", executor: "local" },
    ...(admission === undefined ? {} : { admission }),
  };
}

export function validateLocalComponentIdentity(
  value: unknown,
  component: "admission" | "executor",
): {
  readonly version: typeof LOCAL_CONFIG_VERSION;
  readonly id: string;
} {
  const identity = assertRecord(value, "Local component identity is invalid.");
  assertClosed(identity, ["version", "id"], "Local component identity has unsupported fields.");
  assertVersion(identity.version);
  return {
    version: LOCAL_CONFIG_VERSION,
    id: assertId(identity.id, component === "admission" ? "adm_" : "exec_"),
  };
}

export function validateLocalAdmissionConfig(value: unknown): LocalAdmissionConfig {
  const config = assertRecord(value, "Admission configuration is invalid.");
  assertClosed(config, ["version", "id", "listen", "executor"], "Admission configuration has unsupported fields.");
  assertVersion(config.version);
  const executor = assertRecord(config.executor, "Admission Executor binding is invalid.");
  assertClosed(executor, ["id", "endpoint"], "Admission Executor binding has unsupported fields.");
  const listen = assertListen(config.listen);
  return {
    version: LOCAL_CONFIG_VERSION,
    id: assertId(config.id, "adm_"),
    listen,
    executor: {
      id: assertId(executor.id, "exec_"),
      endpoint: assertExecutorEndpoint(executor.endpoint, listen.host),
    },
  };
}

export function validateLocalExecutorConfig(value: unknown): LocalExecutorConfig {
  const config = assertRecord(value, "Executor configuration is invalid.");
  assertClosed(config, ["version", "id", "listen", "provider"], "Executor configuration has unsupported fields.");
  assertVersion(config.version);
  const provider = assertRecord(config.provider, "Executor provider configuration is invalid.");
  assertClosed(provider, ["kind", "credentialProfile"], "Executor provider configuration has unsupported fields.");
  if (provider.kind !== "github") throw invalid("Executor provider kind is unsupported.");
  if (
    typeof provider.credentialProfile !== "string" ||
    provider.credentialProfile.length === 0 ||
    provider.credentialProfile.length > 128
  ) {
    throw invalid("Executor credential profile reference is invalid.");
  }
  return {
    version: LOCAL_CONFIG_VERSION,
    id: assertId(config.id, "exec_"),
    listen: assertListen(config.listen),
    provider: { kind: "github", credentialProfile: provider.credentialProfile },
  };
}

export function validateLocalAuthorityConfig(value: unknown): LocalAuthorityConfig {
  const config = assertRecord(value, "Authority configuration is invalid.");
  assertClosed(
    config,
    ["version", "publicKey", "publicKeyFingerprint", "privateKeyFile"],
    "Authority configuration has unsupported fields.",
  );
  assertVersion(config.version);
  const key = assertRecord(config.publicKey, "Authority public key is invalid.");
  assertClosed(key, ["kty", "crv", "x"], "Authority public key has unsupported fields.");
  if (
    key.kty !== "OKP" ||
    key.crv !== "Ed25519" ||
    typeof key.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(key.x) ||
    typeof config.publicKeyFingerprint !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(config.publicKeyFingerprint) ||
    config.privateKeyFile !== "private-key.pem"
  ) {
    throw invalid("Authority configuration is invalid.");
  }
  return {
    version: LOCAL_CONFIG_VERSION,
    publicKey: { kty: "OKP", crv: "Ed25519", x: key.x },
    publicKeyFingerprint: config.publicKeyFingerprint,
    privateKeyFile: "private-key.pem",
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function safeFileName(relativePath: string): { readonly directory: string; readonly fileName: string } {
  const parts = relativePath.split(/[\\/]/u);
  if (parts.length === 0 || parts.some((part) => !SAFE_SEGMENT.test(part) || part === "." || part === "..")) {
    throw invalid("Local configuration path is invalid.");
  }
  return { directory: parts.slice(0, -1).join(path.sep), fileName: parts.at(-1) as string };
}

function componentDirectoryPath(
  component: LocalComponent,
  subdirectory: string,
  environment: NodeJS.ProcessEnv,
): string {
  const base = localComponentDirectory(component, environment);
  return subdirectory.length === 0 ? base : path.join(base, subdirectory);
}

function secureFilePath(directory: DirectoryHandle, fileName: string): string {
  return descriptorPath(directory.fd, fileName);
}

function readExistingJson<T>(
  directory: DirectoryHandle,
  fileName: string,
  validator: LocalConfigValidator<T>,
): T | undefined {
  const target = secureFilePath(directory, fileName);
  let fd: number;
  try {
    fd = openSync(target, fsConstants.O_RDONLY | noFollow() | (fsConstants.O_NONBLOCK ?? 0));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw unsafe("Local configuration file could not be opened safely.");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.isSymbolicLink() || !isOwner(stat) || (stat.mode & PRIVATE_MODE_MASK) !== 0) {
      throw unsafe("Local configuration file permissions or ownership are unsafe.");
    }
    if (stat.size > MAX_LOCAL_CONFIG_BYTES) {
      throw new LocalControlError("LOCAL_CONTROL_CONFIG_TOO_LARGE", "Local configuration file is too large.");
    }
    const buffer = Buffer.alloc(MAX_LOCAL_CONFIG_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = readSync(fd, buffer, offset, buffer.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_LOCAL_CONFIG_BYTES) {
      throw new LocalControlError("LOCAL_CONTROL_CONFIG_TOO_LARGE", "Local configuration file is too large.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.subarray(0, offset).toString("utf8")) as unknown;
    } catch {
      throw invalid("Local configuration file is malformed.");
    }
    return validator(parsed);
  } finally {
    closeQuietly(fd);
  }
}

export function readLocalJson<T>(
  component: LocalComponent,
  relativePath: string,
  validator: LocalConfigValidator<T>,
  environment: NodeJS.ProcessEnv = process.env,
): T | undefined {
  const { directory, fileName } = safeFileName(relativePath);
  const directoryPath = componentDirectoryPath(component, directory, environment);
  return withSecureDirectory(resolveConfigHome(environment), () =>
    withSecureDirectory(directoryPath, (handle) => readExistingJson(handle, fileName, validator)),
  );
}

function readExistingPrivateFile(directory: DirectoryHandle, fileName: string): Buffer | undefined {
  const target = secureFilePath(directory, fileName);
  let fd: number;
  try {
    fd = openSync(target, fsConstants.O_RDONLY | noFollow() | (fsConstants.O_NONBLOCK ?? 0));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw unsafe("Local transport identity file could not be opened safely.");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.isSymbolicLink() || !isOwner(stat) || (stat.mode & PRIVATE_MODE_MASK) !== 0) {
      throw unsafe("Local transport identity file permissions or ownership are unsafe.");
    }
    if (stat.size > MAX_LOCAL_PRIVATE_FILE_BYTES) {
      throw new LocalControlError("LOCAL_CONTROL_CONFIG_TOO_LARGE", "Local transport identity file is too large.");
    }
    const buffer = Buffer.alloc(MAX_LOCAL_PRIVATE_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = readSync(fd, buffer, offset, buffer.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_LOCAL_PRIVATE_FILE_BYTES) {
      throw new LocalControlError("LOCAL_CONTROL_CONFIG_TOO_LARGE", "Local transport identity file is too large.");
    }
    return buffer.subarray(0, offset);
  } finally {
    closeQuietly(fd);
  }
}

/** Read certificate or private-key bytes from an owner-only component file. */
export function readLocalPrivateFile(
  component: LocalComponent,
  relativePath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Buffer | undefined {
  const { directory, fileName } = safeFileName(relativePath);
  const directoryPath = componentDirectoryPath(component, directory, environment);
  return withSecureDirectory(resolveConfigHome(environment), () =>
    withSecureDirectory(directoryPath, (handle) => readExistingPrivateFile(handle, fileName)),
  );
}

function persistReplaceJson<T>(directory: DirectoryHandle, fileName: string, value: T): void {
  const target = secureFilePath(directory, fileName);
  const temporary = secureFilePath(directory, `${fileName}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength > MAX_LOCAL_CONFIG_BYTES) {
    throw new LocalControlError("LOCAL_CONTROL_CONFIG_TOO_LARGE", "Local configuration file is too large.");
  }
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow(),
      PRIVATE_FILE_MODE,
    );
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
    fchmodSync(fd, PRIVATE_FILE_MODE);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    try {
      fsyncSync(directory.fd);
    } catch {
      // The replacement is already atomically visible; directory fsync is best effort.
    }
  } catch (error: unknown) {
    closeQuietly(fd);
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary path may already have been atomically renamed.
    }
    if (error instanceof LocalControlError) throw error;
    throw new LocalControlError("LOCAL_CONTROL_STORAGE_FAILED", "Local configuration could not be persisted.");
  }
}

function persistFirstJson<T>(directory: DirectoryHandle, fileName: string, value: T): void {
  const target = secureFilePath(directory, fileName);
  const temporary = secureFilePath(directory, `${fileName}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength > MAX_LOCAL_CONFIG_BYTES) {
    throw new LocalControlError("LOCAL_CONTROL_CONFIG_TOO_LARGE", "Local configuration file is too large.");
  }
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow(),
      PRIVATE_FILE_MODE,
    );
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
    fchmodSync(fd, PRIVATE_FILE_MODE);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temporary, target);
    unlinkSync(temporary);
    try {
      fsyncSync(directory.fd);
    } catch {
      // The target is already atomically visible; directory fsync is best effort.
    }
  } catch (error: unknown) {
    closeQuietly(fd);
    try {
      unlinkSync(temporary);
    } catch {
      // A missing temporary path is expected after a successful publication.
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    if (error instanceof LocalControlError) throw error;
    throw new LocalControlError("LOCAL_CONTROL_STORAGE_FAILED", "Local configuration could not be persisted.");
  }
}

export function writeLocalJson<T>(
  component: LocalComponent,
  relativePath: string,
  value: T,
  validator: LocalConfigValidator<T>,
  environment: NodeJS.ProcessEnv = process.env,
): T {
  const validated = validator(value);
  const { directory, fileName } = safeFileName(relativePath);
  const directoryPath = componentDirectoryPath(component, directory, environment);
  return withSecureDirectory(resolveConfigHome(environment), () =>
    withSecureDirectory(directoryPath, (handle) => {
      const existing = readExistingJson(handle, fileName, validator);
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(validated)) {
          throw new LocalControlError(
            "LOCAL_CONTROL_CONFIG_CONFLICT",
            "Existing local configuration conflicts with the requested identity.",
          );
        }
        return existing;
      }
      persistFirstJson(handle, fileName, validated);
      const persisted = readExistingJson(handle, fileName, validator);
      if (persisted === undefined) {
        throw new LocalControlError(
          "LOCAL_CONTROL_STORAGE_FAILED",
          "Local configuration could not be verified after persistence.",
        );
      }
      if (canonicalJson(persisted) !== canonicalJson(validated)) {
        throw new LocalControlError(
          "LOCAL_CONTROL_CONFIG_CONFLICT",
          "Existing local configuration conflicts with the requested identity.",
        );
      }
      return persisted;
    }),
  );
}

export function ensureLocalCliTopology(environment: NodeJS.ProcessEnv = process.env): LocalCliConfig {
  const initial: LocalCliConfig = {
    version: LOCAL_CONFIG_VERSION,
    topology: { admission: "local", executor: "local" },
  };
  const existing = readLocalJson("cli", "config.json", validateLocalCliConfig, environment);
  if (existing !== undefined) {
    if (existing.topology.admission !== "local" || existing.topology.executor !== "local") {
      throw new LocalControlError(
        "LOCAL_CONTROL_CONFIG_CONFLICT",
        "Existing CLI topology conflicts with local component mode.",
      );
    }
    return existing;
  }

  try {
    return writeLocalJson("cli", "config.json", initial, validateLocalCliConfig, environment);
  } catch (error: unknown) {
    if (!(error instanceof LocalControlError) || error.code !== "LOCAL_CONTROL_CONFIG_CONFLICT") throw error;
    const raced = readLocalJson("cli", "config.json", validateLocalCliConfig, environment);
    if (raced !== undefined && raced.topology.admission === "local" && raced.topology.executor === "local")
      return raced;
    throw error;
  }
}

export function bindLocalCliAdmissionRoute(
  route: LocalAdmissionRoute,
  environment: NodeJS.ProcessEnv = process.env,
): LocalCliConfig {
  const candidate = validateLocalCliConfig({
    version: LOCAL_CONFIG_VERSION,
    topology: { admission: "local", executor: "local" },
    admission: route,
  });
  const admission = candidate.admission;
  if (admission === undefined) throw invalid("CLI Admission route is invalid.");
  const { directory, fileName } = safeFileName("config.json");
  const directoryPath = componentDirectoryPath("cli", directory, environment);
  return withSecureDirectory(resolveConfigHome(environment), () =>
    withSecureDirectory(directoryPath, (handle) => {
      const existing = readExistingJson(handle, fileName, validateLocalCliConfig);
      if (existing === undefined) {
        throw new LocalControlError(
          "LOCAL_CONTROL_CONFIG_CONFLICT",
          "Local CLI topology is not initialized. Run `inari init` first.",
        );
      }
      if (existing.admission !== undefined) {
        if (canonicalJson(existing.admission) !== canonicalJson(admission)) {
          throw new LocalControlError(
            "LOCAL_CONTROL_CONFIG_CONFLICT",
            "Existing CLI Admission route conflicts with local Admission setup.",
          );
        }
        return existing;
      }
      const next = validateLocalCliConfig({ ...existing, admission });
      persistReplaceJson(handle, fileName, next);
      const persisted = readExistingJson(handle, fileName, validateLocalCliConfig);
      if (persisted === undefined || canonicalJson(persisted) !== canonicalJson(next)) {
        throw new LocalControlError(
          "LOCAL_CONTROL_STORAGE_FAILED",
          "CLI Admission route could not be verified after persistence.",
        );
      }
      return persisted;
    }),
  );
}
