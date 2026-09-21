/** Secret-free repository-scoped Runtime profile persistence. */

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const LOCAL_RUNTIME_PROFILE_VERSION = 1 as const;
export const LOCAL_RUNTIME_PROFILE_DIRECTORY = "runtime-profiles" as const;

const MAX_PROFILE_BYTES = 32 * 1024;
const MAX_TEXT_LENGTH = 2_048;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const AUTHORITY_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;

export type LocalRuntimeProfileErrorCode =
  | "LOCAL_RUNTIME_PROFILE_INVALID"
  | "LOCAL_RUNTIME_PROFILE_UNREADABLE"
  | "LOCAL_RUNTIME_PROFILE_MISMATCH"
  | "LOCAL_RUNTIME_PROFILE_NOT_FOUND"
  | "LOCAL_RUNTIME_PROFILE_STORAGE_FAILED";

export class LocalRuntimeProfileError extends Error {
  readonly code: LocalRuntimeProfileErrorCode;

  constructor(code: LocalRuntimeProfileErrorCode, message: string) {
    super(message);
    this.name = "LocalRuntimeProfileError";
    this.code = code;
  }
}

export interface LocalRuntimeProfileRepository {
  readonly repositoryHost: string;
  readonly repositoryId: string;
  readonly repositoryNameWithOwner: string;
}

export interface LocalRuntimeProfileApp {
  readonly appId: string;
  readonly installationId: string;
  readonly clientId?: string;
}

export interface LocalRuntimeProfileAuthority {
  readonly authorityId: string;
  readonly publicKeyFingerprint: string;
  /** Reference to the local secret file; this is never key material. */
  readonly privateKeyPath: string;
}

export interface LocalRuntimeProfile {
  readonly version: typeof LOCAL_RUNTIME_PROFILE_VERSION;
  readonly state: "trust-pending" | "ready";
  readonly endpoint: string;
  readonly relayUrl: string;
  readonly repository: LocalRuntimeProfileRepository;
  readonly app: LocalRuntimeProfileApp;
  readonly authority: LocalRuntimeProfileAuthority;
}

export interface LocalRuntimeProfileStoreOptions {
  readonly configHome?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

function invalid(message: string): LocalRuntimeProfileError {
  return new LocalRuntimeProfileError("LOCAL_RUNTIME_PROFILE_INVALID", message);
}

function boundedText(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TEXT_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalid(`${name} is invalid.`);
  }
  return value;
}

function profileKey(profile: Pick<LocalRuntimeProfile, "endpoint" | "repository">): string {
  const key = [profile.endpoint, profile.repository.repositoryHost, profile.repository.repositoryId].join("\u0000");
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function configHome(options: LocalRuntimeProfileStoreOptions = {}): string {
  const configured = options.configHome ?? options.environment?.INARI_CONFIG_HOME;
  const value = configured ?? path.join(os.homedir(), ".config", "inari");
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH || /[\u0000]/u.test(value)) {
    throw invalid("Configuration home is invalid.");
  }
  return path.resolve(value);
}

export function localRuntimeProfilePath(
  profile: Pick<LocalRuntimeProfile, "endpoint" | "repository">,
  options: LocalRuntimeProfileStoreOptions = {},
): string {
  return path.join(configHome(options), LOCAL_RUNTIME_PROFILE_DIRECTORY, `${profileKey(profile)}.json`);
}

function validateRepository(value: unknown): LocalRuntimeProfileRepository {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid("Repository profile is invalid.");
  const record = value as Record<string, unknown>;
  const repositoryHost = boundedText(record.repositoryHost, "Repository host").toLowerCase();
  const repositoryId = boundedText(record.repositoryId, "Repository id");
  const repositoryNameWithOwner = boundedText(record.repositoryNameWithOwner, "Repository name");
  if (!DECIMAL_ID.test(repositoryId) || repositoryNameWithOwner.split("/").length !== 2)
    throw invalid("Repository profile is invalid.");
  return { repositoryHost, repositoryId, repositoryNameWithOwner };
}

function validateProfile(value: unknown): LocalRuntimeProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("Runtime profile is invalid.");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["version", "state", "endpoint", "relayUrl", "repository", "app", "authority"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw invalid("Runtime profile contains an unknown field.");
  if (
    record.version !== LOCAL_RUNTIME_PROFILE_VERSION ||
    (record.state !== "ready" && record.state !== "trust-pending")
  ) {
    throw invalid("Runtime profile version or state is unsupported.");
  }
  const endpoint = boundedText(record.endpoint, "Endpoint");
  const relayUrl = boundedText(record.relayUrl, "Relay endpoint");
  let relay: URL;
  try {
    relay = new URL(relayUrl);
  } catch {
    throw invalid("Relay endpoint is invalid.");
  }
  if (relay.protocol !== "ws:" && relay.protocol !== "wss:") throw invalid("Relay endpoint is invalid.");
  const repository = validateRepository(record.repository);
  if (typeof record.app !== "object" || record.app === null || Array.isArray(record.app))
    throw invalid("App profile is invalid.");
  const appRecord = record.app as Record<string, unknown>;
  const appId = boundedText(appRecord.appId, "App id");
  const installationId = boundedText(appRecord.installationId, "Installation id");
  if (!DECIMAL_ID.test(appId) || !DECIMAL_ID.test(installationId)) throw invalid("App profile is invalid.");
  const clientId = appRecord.clientId === undefined ? undefined : boundedText(appRecord.clientId, "App client id");
  if (typeof record.authority !== "object" || record.authority === null || Array.isArray(record.authority))
    throw invalid("Authority profile is invalid.");
  const authorityRecord = record.authority as Record<string, unknown>;
  const authorityId = boundedText(authorityRecord.authorityId, "Authority id");
  const publicKeyFingerprint = boundedText(authorityRecord.publicKeyFingerprint, "Authority fingerprint");
  const privateKeyPath = boundedText(authorityRecord.privateKeyPath, "Private key reference");
  if (!AUTHORITY_ID.test(authorityId) || !FINGERPRINT.test(publicKeyFingerprint) || !path.isAbsolute(privateKeyPath))
    throw invalid("Authority profile is invalid.");
  return Object.freeze({
    version: LOCAL_RUNTIME_PROFILE_VERSION,
    state: record.state,
    endpoint,
    relayUrl,
    repository,
    app: Object.freeze({ appId, installationId, ...(clientId === undefined ? {} : { clientId }) }),
    authority: Object.freeze({ authorityId, publicKeyFingerprint, privateKeyPath }),
  });
}

export class LocalRuntimeProfileStore {
  readonly #configHome: string;

  constructor(options: LocalRuntimeProfileStoreOptions = {}) {
    this.#configHome = configHome(options);
  }

  pathFor(profile: Pick<LocalRuntimeProfile, "endpoint" | "repository">): string {
    return localRuntimeProfilePath(profile, { configHome: this.#configHome });
  }

  async load(profile: Pick<LocalRuntimeProfile, "endpoint" | "repository">): Promise<LocalRuntimeProfile | undefined> {
    const profilePath = this.pathFor(profile);
    let bytes: Buffer;
    try {
      bytes = await readFile(profilePath);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw new LocalRuntimeProfileError("LOCAL_RUNTIME_PROFILE_UNREADABLE", "Runtime profile could not be read.");
    }
    if (bytes.byteLength > MAX_PROFILE_BYTES)
      throw new LocalRuntimeProfileError("LOCAL_RUNTIME_PROFILE_INVALID", "Runtime profile is too large.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new LocalRuntimeProfileError("LOCAL_RUNTIME_PROFILE_INVALID", "Runtime profile is malformed.");
    }
    const result = validateProfile(parsed);
    if (
      result.endpoint !== profile.endpoint ||
      result.repository.repositoryHost !== profile.repository.repositoryHost ||
      result.repository.repositoryId !== profile.repository.repositoryId
    ) {
      throw new LocalRuntimeProfileError(
        "LOCAL_RUNTIME_PROFILE_MISMATCH",
        "Runtime profile identity does not match the requested repository.",
      );
    }
    return result;
  }

  async save(profile: LocalRuntimeProfile): Promise<string> {
    const validated = validateProfile(profile);
    const profilePath = this.pathFor(validated);
    const directory = path.dirname(profilePath);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        const existing = await lstat(profilePath);
        if (!existing.isFile() || existing.isSymbolicLink()) throw new Error();
      } catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const temporary = `${profilePath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temporary, JSON.stringify(validated), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, profilePath);
      await chmod(profilePath, 0o600);
      return profilePath;
    } catch {
      throw new LocalRuntimeProfileError("LOCAL_RUNTIME_PROFILE_STORAGE_FAILED", "Runtime profile could not be saved.");
    }
  }

  async findForRepository(repository: {
    readonly repositoryHost: string;
    readonly repositoryNameWithOwner: string;
  }): Promise<LocalRuntimeProfile | undefined> {
    const directory = path.join(this.#configHome, LOCAL_RUNTIME_PROFILE_DIRECTORY);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw new LocalRuntimeProfileError(
        "LOCAL_RUNTIME_PROFILE_UNREADABLE",
        "Runtime profile directory could not be read.",
      );
    }
    const matches: LocalRuntimeProfile[] = [];
    for (const entry of entries.filter((value) => value.endsWith(".json")).sort()) {
      let bytes: Buffer;
      try {
        bytes = await readFile(path.join(directory, entry));
        if (bytes.byteLength > MAX_PROFILE_BYTES) continue;
        const candidate = validateProfile(JSON.parse(bytes.toString("utf8")) as unknown);
        if (
          candidate.repository.repositoryHost === repository.repositoryHost &&
          candidate.repository.repositoryNameWithOwner.toLowerCase() ===
            repository.repositoryNameWithOwner.toLowerCase()
        ) {
          matches.push(candidate);
        }
      } catch {
        // Ignore unrelated or stale profiles during repository selection. A
        // profile selected by its immutable identity is still validated above.
      }
    }
    if (matches.length > 1)
      throw new LocalRuntimeProfileError(
        "LOCAL_RUNTIME_PROFILE_MISMATCH",
        "Multiple Runtime profiles match the repository.",
      );
    return matches[0];
  }
}

export function resolveLocalRuntimeConfigHome(options: LocalRuntimeProfileStoreOptions = {}): string {
  return configHome(options);
}

export async function loadLocalRuntimeProfile(
  identity: Pick<LocalRuntimeProfile, "endpoint" | "repository">,
  options: LocalRuntimeProfileStoreOptions = {},
): Promise<LocalRuntimeProfile | undefined> {
  return new LocalRuntimeProfileStore(options).load(identity);
}

export async function saveLocalRuntimeProfile(
  profile: LocalRuntimeProfile,
  options: LocalRuntimeProfileStoreOptions = {},
): Promise<string> {
  return new LocalRuntimeProfileStore(options).save(profile);
}

export const LocalRuntimeProfile = LocalRuntimeProfileStore;
