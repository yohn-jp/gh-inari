import { readFileSync } from "node:fs";
import path from "node:path";
import type { KeyObject } from "node:crypto";
import { createDirectAppSessionExecutor, type DirectAppSessionExecutorConfig } from "../github/direct-app-execution.js";
import { loadDelegatorPrivateKey } from "../agent-authority/delegator-key.js";
import { createLocalRelayRuntime, type LocalRelayRuntime } from "./local-runtime.js";
import type { RelayRepositoryIdentity } from "./contract.js";
import type { CapabilityAuthorizedSessionExecutor } from "../session-authorized-change-executor.js";

const MAX_CONFIG_VALUE_LENGTH = 512;
const MAX_APP_PRIVATE_KEY_BYTES = 64 * 1024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;

export type LocalRuntimeConfigErrorCode =
  "LOCAL_RUNTIME_CONFIG_MISSING" | "LOCAL_RUNTIME_CONFIG_INVALID" | "LOCAL_RUNTIME_CONFIG_FILE_UNREADABLE";

/** Diagnostics for local Runtime configuration never contain credential values. */
export class LocalRuntimeConfigError extends Error {
  readonly code: LocalRuntimeConfigErrorCode;
  readonly path?: string;

  constructor(code: LocalRuntimeConfigErrorCode, message: string, optionPath?: string) {
    super(message);
    this.name = "LocalRuntimeConfigError";
    this.code = code;
    this.path = optionPath;
  }
}

export interface LocalRuntimeConfigEnvironment {
  readonly [key: string]: string | undefined;
}

export interface LocalRuntimeConfigInput {
  readonly repository?: string;
  readonly relayUrl?: string;
  readonly delegatorId?: string;
  readonly privateKeyPath?: string;
  readonly root?: string;
  readonly environment?: LocalRuntimeConfigEnvironment;
}

export interface LocalRuntimeRepository {
  readonly hostname: string;
  readonly repositoryHost: string;
  readonly repositoryId: string;
  readonly repository: string;
  readonly owner: string;
  readonly name: string;
}

export interface LocalRuntimeConfig {
  readonly relayUrl: string;
  readonly repository: RelayRepositoryIdentity;
  readonly delegatorId: string;
  readonly privateKey: KeyObject;
  readonly executor: CapabilityAuthorizedSessionExecutor;
  readonly runtime: LocalRelayRuntime;
  readonly app: {
    readonly appId: string;
    readonly installationId: string;
  };
}

function missing(name: string, optionPath: string): LocalRuntimeConfigError {
  return new LocalRuntimeConfigError("LOCAL_RUNTIME_CONFIG_MISSING", `${name} is required.`, optionPath);
}

function invalid(message: string, optionPath: string): LocalRuntimeConfigError {
  return new LocalRuntimeConfigError("LOCAL_RUNTIME_CONFIG_INVALID", message, optionPath);
}

function requiredValue(value: string | undefined, name: string, optionPath: string): string {
  if (value === undefined || value.trim().length === 0) throw missing(name, optionPath);
  if (value.length > MAX_CONFIG_VALUE_LENGTH) throw invalid(`${name} is too long.`, optionPath);
  return value.trim();
}

function environmentValue(environment: LocalRuntimeConfigEnvironment, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = environment[name];
    if (value !== undefined && value.trim().length > 0) return value;
  }
  return undefined;
}

function readAppPrivateKey(environment: LocalRuntimeConfigEnvironment): string {
  const direct = environmentValue(environment, "INARI_GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_PRIVATE_KEY");
  if (direct !== undefined) {
    const pem = direct.replace(/\\n/gu, "\n");
    if (Buffer.byteLength(pem, "utf8") > MAX_APP_PRIVATE_KEY_BYTES)
      throw invalid("GitHub App private key is too large.", "$environment.GITHUB_APP_PRIVATE_KEY");
    return pem;
  }
  const filePath = environmentValue(environment, "INARI_GITHUB_APP_PRIVATE_KEY_FILE", "GITHUB_APP_PRIVATE_KEY_FILE");
  if (filePath === undefined) throw missing("GitHub App private key", "$environment.GITHUB_APP_PRIVATE_KEY");
  try {
    const pem = readFileSync(filePath, "utf8");
    if (Buffer.byteLength(pem, "utf8") > MAX_APP_PRIVATE_KEY_BYTES)
      throw invalid("GitHub App private key is too large.", "$environment.GITHUB_APP_PRIVATE_KEY_FILE");
    return pem;
  } catch (error: unknown) {
    if (error instanceof LocalRuntimeConfigError) throw error;
    throw new LocalRuntimeConfigError(
      "LOCAL_RUNTIME_CONFIG_FILE_UNREADABLE",
      "GitHub App private key file cannot be read.",
      "$environment.GITHUB_APP_PRIVATE_KEY_FILE",
    );
  }
}

function repositoryFromValue(value: string, environment: LocalRuntimeConfigEnvironment): LocalRuntimeRepository {
  let parsed: unknown = value;
  if (value.startsWith("{")) {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw invalid("Repository identity is invalid.", "--repository");
    }
  }
  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    const host = typeof record.repositoryHost === "string" ? record.repositoryHost : "github.com";
    const id = typeof record.repositoryId === "string" ? record.repositoryId : undefined;
    const repository = typeof record.repository === "string" ? record.repository : undefined;
    if (repository === undefined) throw invalid("Repository identity is invalid.", "--repository");
    return repositoryFromParts(host, id, repository, environment);
  }
  return repositoryFromParts("github.com", undefined, value, environment);
}

function repositoryFromParts(
  host: string,
  repositoryId: string | undefined,
  repository: string,
  environment: LocalRuntimeConfigEnvironment,
): LocalRuntimeRepository {
  const parts = repository.split("/").filter((part) => part.length > 0);
  let normalizedHost = host;
  let id = repositoryId;
  let owner: string | undefined;
  let name: string | undefined;
  if (parts.length === 4) {
    [normalizedHost, id, owner, name] = parts;
  } else if (parts.length === 3 && /^\d+$/u.test(parts[0] ?? "")) {
    [id, owner, name] = parts;
  } else if (parts.length === 2) {
    [owner, name] = parts;
  }
  id ??= environmentValue(environment, "INARI_REPOSITORY_ID", "GITHUB_REPOSITORY_ID");
  if (
    owner === undefined ||
    name === undefined ||
    !IDENTIFIER_PATTERN.test(owner) ||
    !IDENTIFIER_PATTERN.test(name) ||
    !IDENTIFIER_PATTERN.test(normalizedHost) ||
    id === undefined ||
    !/^\d+$/u.test(id)
  )
    throw invalid("Repository must identify a host, numeric repository id, owner, and name.", "--repository");
  const locator = `${owner}/${name}`;
  return {
    hostname: normalizedHost,
    repositoryHost: normalizedHost,
    repositoryId: id,
    repository: locator,
    owner,
    name,
  };
}

function localAppConfig(
  repository: LocalRuntimeRepository,
  environment: LocalRuntimeConfigEnvironment,
): DirectAppSessionExecutorConfig & { readonly appId: string; readonly installationId: string } {
  const appId = requiredValue(
    environmentValue(environment, "INARI_GITHUB_APP_ID", "GITHUB_APP_ID"),
    "GitHub App id",
    "$environment.GITHUB_APP_ID",
  );
  const installationId = requiredValue(
    environmentValue(environment, "INARI_GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_INSTALLATION_ID"),
    "GitHub App installation id",
    "$environment.GITHUB_APP_INSTALLATION_ID",
  );
  if (!/^\d+$/u.test(appId) || !/^\d+$/u.test(installationId))
    throw invalid("GitHub App identifiers must be numeric.", "$environment.GITHUB_APP_ID");
  return {
    appId,
    installationId,
    privateKeyPem: readAppPrivateKey(environment),
    repository,
  };
}

export function createLocalRuntimeConfig(input: LocalRuntimeConfigInput): LocalRuntimeConfig {
  const environment = input.environment ?? process.env;
  const root = path.resolve(input.root ?? process.cwd());
  const repositoryValue = requiredValue(
    input.repository ?? environmentValue(environment, "INARI_REPOSITORY", "GITHUB_REPOSITORY"),
    "repository",
    "--repository",
  );
  const repository = repositoryFromValue(repositoryValue, environment);
  const relayUrl = requiredValue(
    input.relayUrl ?? environmentValue(environment, "INARI_RELAY_URL", "INARI_RELAY_ENDPOINT"),
    "relay endpoint",
    "--relay-url",
  );
  let parsedRelayUrl: URL;
  try {
    parsedRelayUrl = new URL(relayUrl);
  } catch {
    throw invalid("Relay endpoint is invalid.", "--relay-url");
  }
  if (parsedRelayUrl.protocol !== "ws:" && parsedRelayUrl.protocol !== "wss:")
    throw invalid("Relay endpoint must use ws or wss.", "--relay-url");
  const delegatorId = requiredValue(
    input.delegatorId ?? environmentValue(environment, "INARI_RUNTIME_AUTHORITY_ID"),
    "Delegator authority id",
    "--authority-id",
  );
  if (!IDENTIFIER_PATTERN.test(delegatorId)) throw invalid("Delegator authority id is invalid.", "--authority-id");
  const keyPathValue =
    input.privateKeyPath ??
    environmentValue(environment, "INARI_RUNTIME_AUTHORITY_PRIVATE_KEY_FILE", "INARI_RUNTIME_PRIVATE_KEY_FILE");
  const keyPath = requiredValue(keyPathValue, "Delegator private-key file", "--private-key");
  const privateKeyPath = path.resolve(root, keyPath);
  let privateKey: KeyObject;
  try {
    privateKey = loadDelegatorPrivateKey(privateKeyPath);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && typeof error.code === "string") throw error;
    throw new LocalRuntimeConfigError(
      "LOCAL_RUNTIME_CONFIG_FILE_UNREADABLE",
      "Delegator private-key file cannot be loaded.",
      "--private-key",
    );
  }
  const app = localAppConfig(repository, environment);
  const executor = createDirectAppSessionExecutor(app);
  const runtime = createLocalRelayRuntime({
    relayUrl,
    repository,
    delegatorId,
    privateKey,
    executor,
  });
  return { relayUrl, repository, delegatorId, privateKey, executor, runtime, app };
}

export const resolveLocalRuntimeConfig = createLocalRuntimeConfig;
