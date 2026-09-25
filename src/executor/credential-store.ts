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

export interface StoredIssuerKey {
  readonly configId: string;
  readonly appId: string;
  readonly generation: string;
  readonly fingerprint: string;
  readonly providerVerified: boolean;
  readonly file: string;
}

const INDEX = "issuer-key.json";
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

function valid(record: unknown): record is StoredIssuerKey {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
  const value = record as Record<string, unknown>;
  return (
    Object.keys(value).every((key) =>
      ["configId", "appId", "generation", "fingerprint", "providerVerified", "file"].includes(key),
    ) &&
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
      bytes = secureRead(index, 2048);
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

  markProviderVerified(generation: string): StoredIssuerKey {
    const current = this.current();
    if (current === undefined || current.generation !== generation) throw failure();
    if (current.providerVerified) return current;
    const directory = ensureLocalComponentDirectory("executor", this.#environment, "issuer");
    const verified = { ...current, providerVerified: true };
    const temporary = path.join(directory, `issuer-key-${randomBytes(24).toString("base64url")}.tmp`);
    try {
      privateWrite(temporary, Buffer.from(JSON.stringify(verified)));
      if (this.current()?.generation !== generation) throw failure();
      renameSync(temporary, path.join(directory, INDEX));
      return verified;
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
