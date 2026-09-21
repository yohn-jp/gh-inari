/** Local-only persistence for opaque GitHub App user credentials. */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { GitHubAppUserCredential, createAppUserCredential } from "./app-user-credential.js";

export const APP_USER_CREDENTIAL_STORE_VERSION = 1 as const;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_PATH_LENGTH = 4_096;

export class AppUserCredentialStoreError extends Error {
  readonly code = "APP_USER_CREDENTIAL_STORE_FAILED" as const;

  constructor() {
    super("Local App user credential storage failed closed.");
    this.name = "AppUserCredentialStoreError";
  }
}

export interface AppUserCredentialStore {
  load(): Promise<GitHubAppUserCredential | undefined>;
  save(credential: GitHubAppUserCredential): Promise<void>;
  clear(): Promise<void>;
}

interface PersistedRecord {
  readonly version: typeof APP_USER_CREDENTIAL_STORE_VERSION;
  readonly access_token: string;
  readonly refresh_token: string;
  readonly access_token_expires_at: string;
  readonly refresh_token_expires_at?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatedPath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH || /[\u0000]/u.test(value)) {
    throw new AppUserCredentialStoreError();
  }
  return value;
}

function parseRecord(value: unknown): GitHubAppUserCredential {
  if (!isRecord(value) || value.version !== APP_USER_CREDENTIAL_STORE_VERSION) {
    throw new AppUserCredentialStoreError();
  }
  try {
    return createAppUserCredential({
      accessToken: value.access_token as string,
      refreshToken: value.refresh_token as string,
      accessTokenExpiresAt: value.access_token_expires_at as string,
      ...(value.refresh_token_expires_at === undefined
        ? {}
        : { refreshTokenExpiresAt: value.refresh_token_expires_at as string }),
    });
  } catch {
    throw new AppUserCredentialStoreError();
  }
}

/** In-memory injected store useful for embedding and deterministic tests. */
export class InMemoryAppUserCredentialStore implements AppUserCredentialStore {
  #credential: GitHubAppUserCredential | undefined;

  constructor(initial?: GitHubAppUserCredential) {
    this.#credential = initial;
  }

  async load(): Promise<GitHubAppUserCredential | undefined> {
    return this.#credential;
  }

  async save(credential: GitHubAppUserCredential): Promise<void> {
    if (!(credential instanceof GitHubAppUserCredential)) throw new AppUserCredentialStoreError();
    this.#credential = credential;
  }

  async clear(): Promise<void> {
    this.#credential = undefined;
  }
}

export interface FileAppUserCredentialStoreOptions {
  readonly path: string;
  /** Create missing parent directories when persistence is first used. */
  readonly createDirectory?: boolean;
}

/**
 * Versioned, bounded, atomically replaced local credential file.  POSIX
 * platforms receive owner-only mode 0600; unsupported chmod behavior is
 * ignored only when the platform reports that the operation is unavailable.
 */
export class FileAppUserCredentialStore implements AppUserCredentialStore {
  readonly #path: string;
  readonly #createDirectory: boolean;

  constructor(options: FileAppUserCredentialStoreOptions) {
    this.#path = validatedPath(options.path);
    this.#createDirectory = options.createDirectory ?? true;
  }

  async load(): Promise<GitHubAppUserCredential | undefined> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.#path);
    } catch (error: unknown) {
      if (isMissing(error)) return undefined;
      throw new AppUserCredentialStoreError();
    }
    if (bytes.byteLength > MAX_RECORD_BYTES) throw new AppUserCredentialStoreError();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new AppUserCredentialStoreError();
    }
    return parseRecord(parsed);
  }

  async save(credential: GitHubAppUserCredential): Promise<void> {
    if (!(credential instanceof GitHubAppUserCredential)) throw new AppUserCredentialStoreError();
    const values: PersistedRecord = await credential.withAccessToken(async (accessToken) =>
      credential.withRefreshToken(async (refreshToken) => {
        const metadata = credential.metadata;
        return {
          version: APP_USER_CREDENTIAL_STORE_VERSION,
          access_token: accessToken,
          refresh_token: refreshToken,
          access_token_expires_at: metadata.accessTokenExpiresAt,
          ...(metadata.refreshTokenExpiresAt === undefined
            ? {}
            : { refresh_token_expires_at: metadata.refreshTokenExpiresAt }),
        };
      }),
    );
    const serialized = JSON.stringify(values);
    if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) throw new AppUserCredentialStoreError();
    if (this.#createDirectory) {
      try {
        await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      } catch {
        throw new AppUserCredentialStoreError();
      }
    }
    const temporary = `${this.#path}.tmp-${randomBytes(8).toString("hex")}`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(serialized, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await chmod(temporary, 0o600).catch((error: unknown) => {
        if (!isUnsupportedPermissionError(error)) throw error;
      });
      await rename(temporary, this.#path);
      await chmod(this.#path, 0o600).catch((error: unknown) => {
        if (!isUnsupportedPermissionError(error)) throw error;
      });
    } catch {
      await unlink(temporary).catch(() => {});
      throw new AppUserCredentialStoreError();
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.#path);
    } catch (error: unknown) {
      if (!isMissing(error)) throw new AppUserCredentialStoreError();
    }
  }
}

/** Compatibility alias for callers that use the shorter local-store name. */
export const LocalAppUserCredentialStore = FileAppUserCredentialStore;

function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isUnsupportedPermissionError(error: unknown): boolean {
  return isNodeError(error) && (error.code === "ENOSYS" || error.code === "EPERM" || error.code === "ENOTSUP");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
