/** Executor-only Issuer key custody. The public index is the atomic commit point. */
import { createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { ensureLocalComponentDirectory, localComponentPath } from "../local-control/config.js";

/**
 * One repository installation the current key generation was verified
 * against (#1182). It is public, secret-free owner evidence: the Executor
 * binds provider effects for this repository to exactly this installation.
 */
export interface StoredIssuerBinding {
  readonly repositoryHost: string;
  readonly repositoryId: string;
  readonly nameWithOwner: string;
  readonly installationId: string;
}

export interface StoredIssuerKey {
  readonly configId: string;
  readonly appId: string;
  readonly generation: string;
  readonly fingerprint: string;
  readonly providerVerified: boolean;
  readonly file: string;
  /** Installations this key generation was verified against; reset by every new generation. */
  readonly bindings?: readonly StoredIssuerBinding[];
}

const INDEX = "issuer-key.json";
const MAX_INDEX_BYTES = 16 * 1024;
const MAX_BINDINGS = 32;
const MAX_KEY_BYTES = 64 * 1024;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9_-]{16,64}$/u;

export class ExecutorCredentialStoreError extends Error {
  readonly code = "EXECUTOR_CREDENTIAL_STORE_FAILED";
  constructor() {
    super("Executor Issuer key custody failed closed.");
  }
}

function failure(): ExecutorCredentialStoreError {
  return new ExecutorCredentialStoreError();
}

function validBinding(binding: unknown): binding is StoredIssuerBinding {
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)) return false;
  const value = binding as Record<string, unknown>;
  return (
    Object.keys(value).every((key) =>
      ["repositoryHost", "repositoryId", "nameWithOwner", "installationId"].includes(key),
    ) &&
    value.repositoryHost === "github.com" &&
    typeof value.repositoryId === "string" &&
    /^[1-9][0-9]{0,19}$/u.test(value.repositoryId) &&
    typeof value.nameWithOwner === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value.nameWithOwner) &&
    typeof value.installationId === "string" &&
    /^[1-9][0-9]{0,19}$/u.test(value.installationId)
  );
}

function validBindings(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_BINDINGS || !value.every(validBinding)) return false;
  const ids = value.map((binding: StoredIssuerBinding) => binding.repositoryId);
  return new Set(ids).size === ids.length;
}

function valid(record: unknown): record is StoredIssuerKey {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
  const value = record as Record<string, unknown>;
  return (
    Object.keys(value).every((key) =>
      ["configId", "appId", "generation", "fingerprint", "providerVerified", "file", "bindings"].includes(key),
    ) &&
    validBindings(value.bindings) &&
    (value.bindings === undefined || value.providerVerified === true) &&
    typeof value.configId === "string" &&
    IDENTIFIER.test(value.configId) &&
    typeof value.appId === "string" &&
    /^[1-9][0-9]{0,19}$/u.test(value.appId) &&
    typeof value.generation === "string" &&
    IDENTIFIER.test(value.generation) &&
    typeof value.fingerprint === "string" &&
    FINGERPRINT.test(value.fingerprint) &&
    typeof value.providerVerified === "boolean" &&
    typeof value.file === "string" &&
    /^issuer-[A-Za-z0-9_-]{16,64}\.pem$/u.test(value.file)
  );
}

function secureRead(file: string, maxBytes: number): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > maxBytes ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      throw failure();
    return readFileSync(fd);
  } catch {
    throw failure();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function privateWrite(file: string, bytes: Buffer): void {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } catch {
    throw failure();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function issuerKeyFingerprint(pem: Buffer): string {
  if (pem.byteLength < 1 || pem.byteLength > MAX_KEY_BYTES) throw failure();
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "rsa") throw failure();
    return `sha256:${createHash("sha256")
      .update(createPublicKey(key).export({ type: "spki", format: "der" }))
      .digest("hex")}`;
  } catch {
    throw failure();
  }
}

export class ExecutorCredentialStore {
  readonly #environment: NodeJS.ProcessEnv;
  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.#environment = environment;
  }

  current(): StoredIssuerKey | undefined {
    const directory = ensureLocalComponentDirectory("executor", this.#environment, "issuer");
    const index = path.join(directory, INDEX);
    let bytes: Buffer;
    try {
      bytes = secureRead(index, MAX_INDEX_BYTES);
    } catch (error) {
      // Only an absent index means no credential. Unsafe files fail closed.
      try {
        lstatSync(index);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      }
      throw error;
    }
    try {
      const record: unknown = JSON.parse(bytes.toString("utf8"));
      if (!valid(record)) throw failure();
      const pem = secureRead(path.join(directory, record.file), MAX_KEY_BYTES);
      if (issuerKeyFingerprint(pem) !== record.fingerprint) throw failure();
      return record;
    } catch {
      throw failure();
    }
  }

  keyPath(record: StoredIssuerKey): string {
    const current = this.current();
    if (current === undefined || current.generation !== record.generation || current.fingerprint !== record.fingerprint)
      throw failure();
    return localComponentPath("executor", `issuer/${current.file}`, this.#environment);
  }

  /** Key bytes of the current record, for Executor-owned provider verification only. */
  readKey(record: StoredIssuerKey): Buffer {
    const current = this.current();
    if (current === undefined || current.generation !== record.generation || current.fingerprint !== record.fingerprint)
      throw failure();
    const pem = secureRead(localComponentPath("executor", `issuer/${current.file}`, this.#environment), MAX_KEY_BYTES);
    if (issuerKeyFingerprint(pem) !== current.fingerprint) throw failure();
    return pem;
  }

  markProviderVerified(generation: string): StoredIssuerKey {
    const current = this.current();
    if (current === undefined || current.generation !== generation) throw failure();
    if (current.providerVerified) return current;
    return this.#publish(generation, { ...current, providerVerified: true });
  }

  /**
   * Record that the current key generation acts for `binding` (#1182). Only
   * the generation that was verified can be bound; a repository already bound
   * to a different installation is never silently re-bound.
   */
  recordBinding(generation: string, binding: StoredIssuerBinding): StoredIssuerKey {
    if (!validBinding(binding)) throw failure();
    const current = this.current();
    if (current === undefined || current.generation !== generation) throw failure();
    const existing = current.bindings ?? [];
    const same = existing.find((item) => item.repositoryId === binding.repositoryId);
    if (same !== undefined) {
      if (same.installationId !== binding.installationId || same.repositoryHost !== binding.repositoryHost)
        throw failure();
      if (same.nameWithOwner === binding.nameWithOwner && current.providerVerified) return current;
    }
    const bindings = [...existing.filter((item) => item.repositoryId !== binding.repositoryId), { ...binding }];
    if (bindings.length > MAX_BINDINGS) throw failure();
    return this.#publish(generation, { ...current, providerVerified: true, bindings });
  }

  #publish(generation: string, next: StoredIssuerKey): StoredIssuerKey {
    const directory = ensureLocalComponentDirectory("executor", this.#environment, "issuer");
    const temporary = path.join(directory, `issuer-key-${randomBytes(24).toString("base64url")}.tmp`);
    try {
      privateWrite(temporary, Buffer.from(JSON.stringify(next)));
      if (this.current()?.generation !== generation) throw failure();
      renameSync(temporary, path.join(directory, INDEX));
      return next;
    } catch {
      try {
        unlinkSync(temporary);
      } catch {
        /* absent after publication */
      }
      throw failure();
    }
  }

  save(
    configId: string,
    appId: string,
    pem: Buffer,
    expected?: StoredIssuerKey,
  ): { record: StoredIssuerKey; changed: boolean } {
    const fingerprint = issuerKeyFingerprint(pem);
    const directory = ensureLocalComponentDirectory("executor", this.#environment, "issuer");
    return this.#save(configId, appId, pem, fingerprint, expected, directory);
  }

  #save(
    configId: string,
    appId: string,
    pem: Buffer,
    fingerprint: string,
    expected: StoredIssuerKey | undefined,
    directory: string,
  ): { record: StoredIssuerKey; changed: boolean } {
    const current = this.current();
    if (
      !IDENTIFIER.test(configId) ||
      !/^[1-9][0-9]{0,19}$/u.test(appId) ||
      (current !== undefined && (current.configId !== configId || current.appId !== appId))
    )
      throw failure();
    if (current?.fingerprint === fingerprint) return { record: current, changed: false };
    if (
      current !== undefined &&
      (expected === undefined ||
        expected.generation !== current.generation ||
        expected.fingerprint !== current.fingerprint)
    )
      throw failure();
    if (current === undefined && expected !== undefined) throw failure();
    const generation = randomBytes(24).toString("base64url");
    const record: StoredIssuerKey = {
      configId,
      appId,
      generation,
      fingerprint,
      providerVerified: false,
      file: `issuer-${generation}.pem`,
    };
    const key = path.join(directory, record.file);
    const temporary = path.join(directory, `issuer-key-${generation}.tmp`);
    let committed = false;
    try {
      privateWrite(key, pem);
      privateWrite(temporary, Buffer.from(JSON.stringify(record)));
      // Reject symlink or hardlink target before atomic publication.
      if (current !== undefined) this.current();
      renameSync(temporary, path.join(directory, INDEX));
      committed = true;
      const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        fsyncSync(fd);
      } catch {
        /* The atomic index is already visible. */
      } finally {
        closeSync(fd);
      }
      return { record, changed: true };
    } catch {
      if (!committed) {
        try {
          unlinkSync(temporary);
        } catch {
          /* absent */
        }
        try {
          unlinkSync(key);
        } catch {
          /* absent */
        }
      }
      throw failure();
    }
  }
}
