import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { KeyObject } from "node:crypto";
import { createDirectAppSessionExecutor, type DirectAppSessionExecutorConfig } from "../github/direct-app-execution.js";
import {
  GitHubAppDeviceFlowClient,
  GitHubAppUserCredential,
  GitHubAppUserCredentialError,
  type GitHubAppDeviceFlowOptions,
} from "../github/app-user-credential.js";
import { FileAppUserCredentialStore, type AppUserCredentialStore } from "../github/app-user-credential-store.js";
import {
  GitHubAppUserCredentialBroker,
  type GitHubAppUserCredentialBrokerOptions,
} from "../github/app-user-credential-broker.js";
import type { AppProviderCredentialBroker } from "../github/app-provider-credential-broker.js";
import { GitHubNativeHttpTransport, githubRestBaseUrl } from "../github/native-http-transport.js";
import type { RepositoryIdentity } from "../github/effect-authorizer.js";
import { loadDelegatorPrivateKey } from "../agent-authority/delegator-key.js";
import { createLocalRelayRuntime, type LocalRelayRuntime } from "./local-runtime.js";
import type { RelayRepositoryIdentity } from "./contract.js";
import type { CapabilityAuthorizedSessionExecutor } from "../session-authorized-change-executor.js";

const MAX_CONFIG_VALUE_LENGTH = 512;
const MAX_APP_PRIVATE_KEY_BYTES = 64 * 1024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;

export type LocalRuntimeConfigErrorCode =
  | "LOCAL_RUNTIME_CONFIG_MISSING"
  | "LOCAL_RUNTIME_CONFIG_INVALID"
  | "LOCAL_RUNTIME_CONFIG_FILE_UNREADABLE"
  | "LOCAL_RUNTIME_CONFIG_PROVIDER_FAILED";

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

export type LocalRuntimeCredentialProfile = "installation-key" | "app-user";

export interface LocalRuntimeRepository {
  readonly hostname: string;
  readonly repositoryHost: string;
  readonly repositoryId?: string;
  readonly repository: string;
  readonly owner: string;
  readonly name: string;
}

export interface LocalRuntimeAppUserInput {
  /** Public App identity. No private key, PAT, or generic GitHub token is accepted. */
  readonly appId?: string;
  readonly clientId?: string;
  readonly installationId?: string;
  readonly credentialStore?: AppUserCredentialStore;
  readonly credentialFile?: string;
  readonly deviceFlow?: GitHubAppDeviceFlowClient;
  readonly deviceFlowOptions?: Omit<GitHubAppDeviceFlowOptions, "clientId" | "hostname"> & {
    readonly clientId?: string;
  };
  readonly apiUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  /** Optional deterministic repository-id resolver for an embedding Runtime. */
  readonly resolveRepository?: (repository: LocalRuntimeRepository) => Promise<LocalRuntimeRepository>;
  /** Optional already-composed App-user broker. */
  readonly credentialBroker?: AppProviderCredentialBroker;
}

export interface LocalRuntimeConfigInput {
  readonly repository?: string;
  readonly relayUrl?: string;
  readonly delegatorId?: string;
  readonly privateKeyPath?: string;
  readonly root?: string;
  readonly environment?: LocalRuntimeConfigEnvironment;
  readonly profile?: LocalRuntimeCredentialProfile;
  readonly appUser?: LocalRuntimeAppUserInput;
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

function providerFailed(optionPath = "$appUser"): LocalRuntimeConfigError {
  return new LocalRuntimeConfigError(
    "LOCAL_RUNTIME_CONFIG_PROVIDER_FAILED",
    "App-user repository and installation scope could not be established.",
    optionPath,
  );
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

function repositoryFromValue(
  value: string,
  environment: LocalRuntimeConfigEnvironment,
  requireRepositoryId: boolean,
): LocalRuntimeRepository {
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
    return repositoryFromParts(host, id, repository, environment, requireRepositoryId);
  }
  return repositoryFromParts("github.com", undefined, value, environment, requireRepositoryId);
}

function repositoryFromParts(
  host: string,
  repositoryId: string | undefined,
  repository: string,
  environment: LocalRuntimeConfigEnvironment,
  requireRepositoryId: boolean,
): LocalRuntimeRepository {
  const parts = repository.split("/").filter((part) => part.length > 0);
  let normalizedHost = host;
  let id = repositoryId;
  let owner: string | undefined;
  let name: string | undefined;
  if (parts.length === 4) {
    [normalizedHost, id, owner, name] = parts;
  } else if (parts.length === 3 && DECIMAL_ID.test(parts[0] ?? "")) {
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
    (id !== undefined && !DECIMAL_ID.test(id)) ||
    (requireRepositoryId && id === undefined)
  )
    throw invalid(
      requireRepositoryId
        ? "Repository must identify a host, numeric repository id, owner, and name."
        : "Repository must identify a host, owner, and name.",
      "--repository",
    );
  const locator = `${owner}/${name}`;
  return {
    hostname: normalizedHost,
    repositoryHost: normalizedHost,
    ...(id === undefined ? {} : { repositoryId: id }),
    repository: locator,
    owner,
    name,
  };
}

function localAppConfig(
  repository: LocalRuntimeRepository & { readonly repositoryId: string },
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
  if (!DECIMAL_ID.test(appId) || !DECIMAL_ID.test(installationId))
    throw invalid("GitHub App identifiers must be numeric.", "$environment.GITHUB_APP_ID");
  return {
    appId,
    installationId,
    privateKeyPem: readAppPrivateKey(environment),
    repository,
  };
}

function appUserCredentialPath(environment: LocalRuntimeConfigEnvironment, input: LocalRuntimeAppUserInput): string {
  return (
    input.credentialFile ??
    environmentValue(environment, "INARI_GITHUB_APP_USER_CREDENTIAL_FILE", "INARI_APP_USER_CREDENTIAL_FILE") ??
    path.join(os.homedir(), ".config", "inari", "app-user-credential.json")
  );
}

function appUserStore(
  environment: LocalRuntimeConfigEnvironment,
  input: LocalRuntimeAppUserInput,
): AppUserCredentialStore {
  return input.credentialStore ?? new FileAppUserCredentialStore({ path: appUserCredentialPath(environment, input) });
}

function appUserDeviceFlow(
  environment: LocalRuntimeConfigEnvironment,
  input: LocalRuntimeAppUserInput,
  hostname: string,
): GitHubAppDeviceFlowClient | undefined {
  if (input.deviceFlow !== undefined) return input.deviceFlow;
  const clientId =
    input.clientId ??
    environmentValue(
      environment,
      "INARI_GITHUB_APP_CLIENT_ID",
      "INARI_GITHUB_APP_USER_CLIENT_ID",
      "GITHUB_APP_CLIENT_ID",
    );
  if (clientId === undefined && input.deviceFlowOptions === undefined) return undefined;
  try {
    return new GitHubAppDeviceFlowClient({
      ...(input.deviceFlowOptions ?? {}),
      clientId:
        input.deviceFlowOptions?.clientId ??
        clientId ??
        (() => {
          throw new Error();
        })(),
      hostname,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  } catch {
    throw providerFailed();
  }
}

async function loadAppUserCredential(
  store: AppUserCredentialStore,
  deviceFlow: GitHubAppDeviceFlowClient | undefined,
  now: () => Date,
): Promise<GitHubAppUserCredential> {
  let credential: GitHubAppUserCredential | undefined;
  try {
    credential = await store.load();
    if (credential === undefined) {
      if (deviceFlow === undefined) throw providerFailed();
      credential = await deviceFlow.authorize();
      await store.save(credential);
    } else if (credential.isAccessExpired(now())) {
      if (deviceFlow === undefined) throw providerFailed();
      try {
        const refreshed = await deviceFlow.refresh(credential);
        await store.save(refreshed);
        credential = refreshed;
      } catch {
        await store.clear().catch(() => {});
        throw providerFailed();
      }
    }
  } catch (error: unknown) {
    if (error instanceof LocalRuntimeConfigError) throw error;
    if (error instanceof GitHubAppUserCredentialError) throw providerFailed();
    throw providerFailed();
  }
  if (credential === undefined) throw providerFailed();
  return credential;
}

function repositoryEvidence(
  value: unknown,
  hostname: string,
  expectedNameWithOwner: string,
): { readonly id: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "number" && Number.isSafeInteger(record.id) ? String(record.id) : record.id;
  const fullName = typeof record.full_name === "string" ? record.full_name : undefined;
  if (
    typeof id !== "string" ||
    !DECIMAL_ID.test(id) ||
    fullName === undefined ||
    fullName.split("/").length !== 2 ||
    fullName.toLowerCase() !== expectedNameWithOwner.toLowerCase() ||
    hostname.length === 0
  )
    return undefined;
  return { id };
}

async function resolveRepositoryId(
  repository: LocalRuntimeRepository,
  environment: LocalRuntimeConfigEnvironment,
  input: LocalRuntimeAppUserInput,
): Promise<LocalRuntimeRepository & { readonly repositoryId: string }> {
  if (repository.repositoryId !== undefined)
    return repository as LocalRuntimeRepository & { readonly repositoryId: string };
  if (input.resolveRepository !== undefined) {
    const resolved = await input.resolveRepository(repository);
    if (resolved.repositoryId === undefined || resolved.hostname !== repository.hostname) throw providerFailed();
    return resolved as LocalRuntimeRepository & { readonly repositoryId: string };
  }
  const store = appUserStore(environment, input);
  const deviceFlow = appUserDeviceFlow(environment, input, repository.hostname);
  const now = input.now ?? (() => new Date());
  const credential = await loadAppUserCredential(store, deviceFlow, now);
  try {
    const response = await credential.withAccessToken(async (token) => {
      const transport = new GitHubNativeHttpTransport({
        token,
        apiUrl: input.apiUrl ?? githubRestBaseUrl(repository.hostname),
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      });
      return transport.request({
        hostname: repository.hostname,
        method: "GET",
        path: `repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`,
      });
    });
    if (response.status !== 200) throw providerFailed();
    const evidence = repositoryEvidence(response.body, repository.hostname, `${repository.owner}/${repository.name}`);
    if (evidence === undefined) throw providerFailed();
    return { ...repository, repositoryId: evidence.id };
  } catch (error: unknown) {
    if (error instanceof LocalRuntimeConfigError) throw error;
    throw providerFailed();
  }
}

async function localAppUserConfig(
  repository: LocalRuntimeRepository,
  environment: LocalRuntimeConfigEnvironment,
  input: LocalRuntimeAppUserInput,
): Promise<{
  readonly repository: LocalRuntimeRepository & { readonly repositoryId: string };
  readonly executor: CapabilityAuthorizedSessionExecutor;
  readonly app: { readonly appId: string; readonly installationId: string };
}> {
  const requestedAppId = input.appId ?? environmentValue(environment, "INARI_GITHUB_APP_ID", "GITHUB_APP_ID");
  if (requestedAppId !== undefined && !DECIMAL_ID.test(requestedAppId.trim()))
    throw invalid("GitHub App id must be numeric.", "$environment.GITHUB_APP_ID");
  const candidate =
    input.credentialBroker === undefined ? await resolveRepositoryId(repository, environment, input) : repository;
  let broker = input.credentialBroker;
  if (broker === undefined) {
    if (candidate.repositoryId === undefined) throw providerFailed();
    const appId = requiredValue(requestedAppId, "GitHub App id", "$environment.GITHUB_APP_ID");
    const store = appUserStore(environment, input);
    const deviceFlow = appUserDeviceFlow(environment, input, candidate.hostname);
    const installationId = input.installationId ?? environmentValue(environment, "INARI_GITHUB_APP_INSTALLATION_ID");
    const brokerOptions: GitHubAppUserCredentialBrokerOptions = {
      appId,
      repository: { hostname: candidate.hostname, owner: candidate.owner, name: candidate.name },
      repositoryId: candidate.repositoryId,
      ...(installationId === undefined ? {} : { installationId }),
      credentialStore: store,
      ...(deviceFlow === undefined ? {} : { deviceFlow }),
      ...(input.apiUrl === undefined ? {} : { apiUrl: input.apiUrl }),
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      ...(input.now === undefined ? {} : { now: input.now }),
    };
    broker = new GitHubAppUserCredentialBroker(brokerOptions);
  }
  let established:
    | {
        readonly appId: string;
        readonly installationId: string;
        readonly repository: RepositoryIdentity;
      }
    | undefined;
  try {
    await broker.withRepositoryReadCapability({}, async (capability) => {
      established = {
        appId: capability.scope.app.appId,
        installationId: capability.scope.installation.installationId,
        repository: capability.scope.repository,
      };
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "GitHubAppUserCredentialBrokerError") throw error;
    throw providerFailed();
  }
  if (established === undefined) throw providerFailed();
  if (requestedAppId !== undefined && established.appId !== requestedAppId.trim()) throw providerFailed();
  if (established.repository.repositoryHost !== candidate.hostname) throw providerFailed();
  if (candidate.repositoryId !== undefined && candidate.repositoryId !== established.repository.repositoryId)
    throw providerFailed();
  const nameWithOwner = established.repository.nameWithOwner;
  const [owner, name] = nameWithOwner.split("/");
  if (owner === undefined || name === undefined) throw providerFailed();
  const resolvedRepository: LocalRuntimeRepository & { readonly repositoryId: string } = {
    hostname: established.repository.repositoryHost,
    repositoryHost: established.repository.repositoryHost,
    repositoryId: established.repository.repositoryId,
    repository: nameWithOwner,
    owner,
    name,
  };
  const executor = createDirectAppSessionExecutor({
    appId: established.appId,
    repository: {
      hostname: resolvedRepository.hostname,
      owner: resolvedRepository.owner,
      name: resolvedRepository.name,
    },
    credentialBroker: broker,
  });
  return {
    repository: resolvedRepository,
    executor,
    app: { appId: established.appId, installationId: established.installationId },
  };
}

function profileFromInput(
  input: LocalRuntimeConfigInput,
  environment: LocalRuntimeConfigEnvironment,
): LocalRuntimeCredentialProfile {
  if (input.profile !== undefined) return input.profile;
  if (input.appUser !== undefined) return "app-user";
  const configured = environmentValue(
    environment,
    "INARI_RUNTIME_PROFILE",
    "INARI_RUNTIME_CREDENTIAL_PROFILE",
    "INARI_GITHUB_APP_USER_AUTH_PROFILE",
  )?.toLowerCase();
  if (configured === "app-user" || configured === "app_user" || configured === "device-flow") return "app-user";
  if (configured === "installation-key" || configured === "private-key" || configured === "legacy")
    return "installation-key";
  if (
    environmentValue(
      environment,
      "INARI_GITHUB_APP_CLIENT_ID",
      "INARI_GITHUB_APP_USER_CLIENT_ID",
      "GITHUB_APP_CLIENT_ID",
    ) !== undefined &&
    environmentValue(
      environment,
      "INARI_GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_PRIVATE_KEY",
      "INARI_GITHUB_APP_PRIVATE_KEY_FILE",
      "GITHUB_APP_PRIVATE_KEY_FILE",
    ) === undefined
  )
    return "app-user";
  return "installation-key";
}

/** Compose the provider scope before constructing the immutable local Runtime. */
export async function createLocalRuntimeConfig(input: LocalRuntimeConfigInput): Promise<LocalRuntimeConfig> {
  const environment = input.environment ?? process.env;
  const profile = profileFromInput(input, environment);
  const root = path.resolve(input.root ?? process.cwd());
  const repositoryValue = requiredValue(
    input.repository ?? environmentValue(environment, "INARI_REPOSITORY", "GITHUB_REPOSITORY"),
    "repository",
    "--repository",
  );
  const repository = repositoryFromValue(repositoryValue, environment, profile === "installation-key");
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
  let resolvedRepository: LocalRuntimeRepository & { readonly repositoryId: string };
  let executor: CapabilityAuthorizedSessionExecutor;
  let app: { readonly appId: string; readonly installationId: string };
  if (profile === "app-user") {
    const composed = await localAppUserConfig(repository, environment, input.appUser ?? {});
    resolvedRepository = composed.repository;
    executor = composed.executor;
    app = composed.app;
  } else {
    if (repository.repositoryId === undefined)
      throw invalid("Repository must identify a numeric repository id.", "--repository");
    const legacy = localAppConfig({ ...repository, repositoryId: repository.repositoryId }, environment);
    executor = createDirectAppSessionExecutor(legacy);
    app = { appId: legacy.appId, installationId: legacy.installationId };
    resolvedRepository = { ...repository, repositoryId: repository.repositoryId };
  }
  const relayRepository: RelayRepositoryIdentity = {
    repositoryHost: resolvedRepository.repositoryHost,
    repositoryId: resolvedRepository.repositoryId,
    repositoryNameWithOwner: resolvedRepository.repository,
  };
  const runtime = createLocalRelayRuntime({
    relayUrl,
    repository: relayRepository,
    delegatorId,
    privateKey,
    executor,
  });
  return { relayUrl, repository: relayRepository, delegatorId, privateKey, executor, runtime, app };
}

export const resolveLocalRuntimeConfig = createLocalRuntimeConfig;
