/**
 * Credential-bound GitHub App capabilities backed by a local Device Flow
 * user credential.  Every capability re-establishes App installation and
 * immutable repository scope before it is exposed to its callback.
 */

import {
  GitHubAppApiTransport,
  GITHUB_APP_GIT_DATA_PERMISSIONS,
  GITHUB_APP_REPOSITORY_READ_PERMISSIONS,
  type GitHubAppCredentialFailureStage,
  type GitHubAppRepositoryReadCapability,
  type GitHubAppRepositoryReadPermissionSet,
  type GitHubAppRepositoryReadTransport,
} from "./app-installation-credential-broker.js";
import {
  GITHUB_APP_SEMANTIC_PULL_REQUEST_PERMISSIONS,
  GitHubAppSemanticPullRequestMutationExecutor,
} from "./app-semantic-pr-mutation.js";
import {
  GitHubAppUserCredential,
  GitHubAppDeviceFlowClient,
  GitHubAppUserCredentialError,
  type GitHubAppDeviceFlowOptions,
} from "./app-user-credential.js";
import type { AppUserCredentialStore } from "./app-user-credential-store.js";
import type { AppProviderCredentialBroker } from "./app-provider-credential-broker.js";
import type {
  AppInstallationScope,
  AppPermissionSet,
  AppPrincipalIdentity,
  AppScopedMutationCapability,
  EffectAuthorizerCredentialRequest,
  RepositoryIdentity,
} from "./effect-authorizer.js";
import {
  createInariAppPrincipalIdentity,
  validateAppInstallationScope,
  validateRepositoryIdentity,
} from "./effect-authorizer.js";
import type {
  GitHubChangeEffectGraphqlRequest,
  GitHubChangeEffectRepository,
  GitHubChangeEffectRequest,
  GitHubChangeEffectResponse,
  GitHubChangeProvenanceSignerOptions,
} from "./change-effect-adapter.js";
import { GitHubChangeEffectAdapter } from "./change-effect-adapter.js";
import {
  GitHubBranchAdvanceCapabilityImpl,
  type BranchAdvanceCapabilityTransport,
  type GitDataGraphqlRequest,
  type GitHubBranchAdvanceCapability,
} from "./git-data-capability.js";
import type { SemanticPullRequestMutationExecutionPort } from "../semantic-pr-mutation.js";
import { SemanticPullRequestMutationError } from "../semantic-pr-mutation.js";
import { GitHubNativeHttpTransport, githubRestBaseUrl } from "./native-http-transport.js";
import {
  attachGitHubProviderFailure,
  githubProviderFailure,
  githubProviderFailureFromStatus,
  readGitHubProviderFailure,
  type GitHubProviderFailureClassification,
} from "./provider-failure.js";
import type { ChangeEffect, ChangeEffectFailureClassification, ChangeIssuanceFailureEvidence } from "../change.js";
import { attachChangeEffectFailureClassification } from "../change-failure-diagnostics.js";

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const MAX_API_URL_LENGTH = 2_048;
const MAX_ID_LENGTH = 20;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

export const GITHUB_APP_USER_CREDENTIAL_FAILURE_STAGES = Object.freeze([
  "issuer-configuration",
  "user-credential",
  "installation-scope",
  "repository-read",
  "projection-execution",
] as const);
export type GitHubAppUserCredentialFailureStage = (typeof GITHUB_APP_USER_CREDENTIAL_FAILURE_STAGES)[number];

export class GitHubAppUserCredentialBrokerError extends Error {
  readonly code = "GITHUB_APP_USER_CREDENTIAL_BROKER_FAILED" as const;
  readonly stage: GitHubAppUserCredentialFailureStage;
  readonly reason?: ChangeEffectFailureClassification["reason"];
  readonly providerFailure?: GitHubProviderFailureClassification;

  constructor(
    stage: GitHubAppUserCredentialFailureStage,
    classification?: ChangeEffectFailureClassification,
    providerFailure?: GitHubProviderFailureClassification,
  ) {
    super("GitHub App user credential broker failed closed.");
    this.name = "GitHubAppUserCredentialBrokerError";
    this.stage = stage;
    if (classification?.reason !== undefined) this.reason = classification.reason;
    if (providerFailure !== undefined) {
      this.providerFailure = providerFailure;
      attachGitHubProviderFailure(this, providerFailure);
    }
  }
}

export interface GitHubAppUserCredentialBrokerOptions {
  readonly appId: string;
  /** Public App client ID; no private key or client secret is accepted. */
  readonly clientId?: string;
  readonly repository: GitHubChangeEffectRepository;
  /** Immutable GitHub repository database ID. */
  readonly repositoryId: string;
  readonly installationId?: string;
  readonly repositoryNodeId?: string;
  readonly credentialStore: AppUserCredentialStore;
  readonly deviceFlow?: GitHubAppDeviceFlowClient;
  readonly deviceFlowOptions?: Omit<GitHubAppDeviceFlowOptions, "clientId" | "hostname"> & {
    readonly clientId?: string;
  };
  readonly apiUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly failure?: (stage: GitHubAppUserCredentialFailureStage) => Error;
  readonly mutationFailure?: (effect: ChangeEffect) => Error;
  readonly provenance?: GitHubChangeProvenanceSignerOptions;
  readonly requestTimeoutMs?: number;
}

interface ResolvedCredential {
  readonly credential: GitHubAppUserCredential;
  readonly scope: AppInstallationScope;
  readonly repository: GitHubChangeEffectRepository;
  readonly repositoryNodeId?: string;
}

interface CredentialBoundTransport {
  request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse>;
  requestGraphql(request: GitHubChangeEffectGraphqlRequest): Promise<GitHubChangeEffectResponse>;
  compareAndDeleteBranch?: (request: {
    readonly branch: string;
    readonly expectedCommitSha: string;
  }) => Promise<"deleted" | "mismatch">;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && SAFE_TEXT.test(value)
    ? value
    : undefined;
}

function decimalId(value: unknown): string | undefined {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === "string" && text.length <= MAX_ID_LENGTH && DECIMAL_ID.test(text) ? text : undefined;
}

function repositoryFromEvidence(
  value: unknown,
  hostname: string,
):
  | {
      readonly repository: GitHubChangeEffectRepository;
      readonly identity: RepositoryIdentity;
      readonly nodeId?: string;
    }
  | undefined {
  const body = record(value);
  if (body === undefined) return undefined;
  const id = decimalId(body.id);
  const fullName = boundedText(body.full_name, 511);
  let owner: string | undefined;
  let name: string | undefined;
  if (fullName !== undefined && fullName.split("/").length === 2) {
    [owner, name] = fullName.split("/") as [string, string];
  } else {
    const ownerRecord = record(body.owner);
    owner = boundedText(ownerRecord?.login, 255);
    name = boundedText(body.name, 255);
  }
  if (
    id === undefined ||
    owner === undefined ||
    name === undefined ||
    !SAFE_TEXT.test(owner) ||
    !SAFE_TEXT.test(name)
  ) {
    return undefined;
  }
  const normalizedFullName = `${owner}/${name}`;
  const nodeId = boundedText(body.node_id, 255);
  return {
    repository: { hostname, owner, name },
    identity: { repositoryHost: hostname, repositoryId: id, nameWithOwner: normalizedFullName },
    ...(nodeId === undefined ? {} : { nodeId }),
  };
}

function permissionSet(value: unknown): AppPermissionSet {
  const body = record(value) ?? {};
  const output: Record<string, "read" | "write"> = {};
  for (const key of ["contents", "issues", "pull_requests", "metadata"] as const) {
    if (body[key] === "read") output[key] = "read";
    // The governed App ceiling permits only read access to Issues.  A user
    // installation may report the broader GitHub permission; retain only the
    // bounded App authority rather than widening Effect Authorizer scope.
    if (body[key] === "write") output[key] = key === "issues" ? "read" : "write";
  }
  return output;
}

function hasPermissions(actual: AppPermissionSet, required: AppPermissionSet): boolean {
  const rank = { read: 1, write: 2 } as const;
  for (const [key, value] of Object.entries(required)) {
    if (value !== "read" && value !== "write") return false;
    const available = actual[key as keyof AppPermissionSet];
    if (available === undefined || rank[available] < rank[value]) return false;
  }
  return true;
}

function repositoryPath(repository: GitHubChangeEffectRepository, suffix = ""): string {
  const root = `repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  return suffix.length === 0 ? root : `${root}/${suffix}`;
}

function isRootPath(path: string, repository: GitHubChangeEffectRepository): boolean {
  try {
    return decodeURIComponent(path) === repositoryPath(repository);
  } catch {
    return false;
  }
}

function isAllowedReadPath(path: string, repository: GitHubChangeEffectRepository): boolean {
  const prefix = `${repositoryPath(repository)}/`;
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    path.includes("..")
  ) {
    return false;
  }
  try {
    const decoded = decodeURIComponent(path);
    return decoded === repositoryPath(repository) || decoded.startsWith(prefix);
  } catch {
    return false;
  }
}

function normalizedApiUrl(value: string | undefined, hostname: string): string {
  const candidate = value ?? githubRestBaseUrl(hostname);
  if (candidate.length === 0 || candidate.length > MAX_API_URL_LENGTH)
    throw new GitHubAppUserCredentialBrokerError("issuer-configuration");
  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    return url.toString().replace(/\/$/u, "");
  } catch {
    throw new GitHubAppUserCredentialBrokerError("issuer-configuration");
  }
}

/** App-user broker implementing the same bounded capability port as App installations. */
export class GitHubAppUserCredentialBroker implements AppProviderCredentialBroker {
  readonly #app: AppPrincipalIdentity;
  readonly #repository: GitHubChangeEffectRepository;
  readonly #repositoryId: string;
  readonly #installationId: string | undefined;
  readonly #repositoryNodeId: string | undefined;
  readonly #store: AppUserCredentialStore;
  readonly #deviceFlow: GitHubAppDeviceFlowClient | undefined;
  readonly #apiUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;
  readonly #failure: (stage: GitHubAppUserCredentialFailureStage) => Error;
  readonly #mutationFailure: (effect: ChangeEffect) => Error;
  readonly #provenance: GitHubChangeProvenanceSignerOptions | undefined;
  readonly #requestTimeoutMs: number | undefined;

  constructor(options: GitHubAppUserCredentialBrokerOptions) {
    this.#failure = options.failure ?? ((stage) => new GitHubAppUserCredentialBrokerError(stage));
    this.#mutationFailure =
      options.mutationFailure ?? (() => new GitHubAppUserCredentialBrokerError("projection-execution"));
    try {
      if (
        Object.prototype.hasOwnProperty.call(options, "privateKeyPem") ||
        Object.prototype.hasOwnProperty.call(options, "clientSecret") ||
        Object.prototype.hasOwnProperty.call(options, "token")
      ) {
        throw new Error();
      }
      this.#app = createInariAppPrincipalIdentity(options.appId);
      this.#repositoryId =
        decimalId(options.repositoryId) ??
        (() => {
          throw new Error();
        })();
      this.#installationId =
        options.installationId === undefined
          ? undefined
          : (decimalId(options.installationId) ??
            (() => {
              throw new Error();
            })());
      this.#repositoryNodeId =
        options.repositoryNodeId === undefined
          ? undefined
          : (boundedText(options.repositoryNodeId, 255) ??
            (() => {
              throw new Error();
            })());
      this.#repository = Object.freeze({
        hostname:
          boundedText(options.repository.hostname, 255)?.toLowerCase() ??
          (() => {
            throw new Error();
          })(),
        owner:
          boundedText(options.repository.owner, 255) ??
          (() => {
            throw new Error();
          })(),
        name:
          boundedText(options.repository.name, 255) ??
          (() => {
            throw new Error();
          })(),
      });
      this.#store = options.credentialStore;
      if (!this.#store || typeof this.#store.load !== "function" || typeof this.#store.save !== "function")
        throw new Error();
      this.#deviceFlow =
        options.deviceFlow ??
        (options.clientId === undefined && options.deviceFlowOptions === undefined
          ? undefined
          : new GitHubAppDeviceFlowClient({
              ...(options.deviceFlowOptions ?? {}),
              clientId:
                options.deviceFlowOptions?.clientId ??
                options.clientId ??
                (() => {
                  throw new Error();
                })(),
              hostname: this.#repository.hostname,
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
              ...(options.now === undefined ? {} : { now: options.now }),
              ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
            }));
      this.#apiUrl = normalizedApiUrl(options.apiUrl, this.#repository.hostname);
      this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
      this.#now = options.now ?? (() => new Date());
      this.#provenance = options.provenance;
      this.#requestTimeoutMs = options.requestTimeoutMs;
    } catch (error: unknown) {
      if (error instanceof GitHubAppUserCredentialBrokerError) throw error;
      throw this.#safeFailure("issuer-configuration");
    }
  }

  async withRepositoryReadCapability<T>(
    request: { readonly permissions?: GitHubAppRepositoryReadPermissionSet },
    operation: (capability: GitHubAppRepositoryReadCapability) => Promise<T>,
  ): Promise<T> {
    const permissions = request.permissions ?? GITHUB_APP_REPOSITORY_READ_PERMISSIONS;
    if (!hasPermissions(GITHUB_APP_REPOSITORY_READ_PERMISSIONS, permissions))
      throw this.#safeFailure("installation-scope", { reason: "scope" });
    const resolved = await this.#resolve(permissions);
    const transport = this.#apiTransport(resolved.credential, "repository-read");
    const capability: GitHubAppRepositoryReadCapability = Object.freeze({
      providerPrincipal: resolved.scope.app,
      scope: resolved.scope,
      transport: Object.freeze({
        request: async (readRequest: { readonly hostname: string; readonly method: "GET"; readonly path: string }) => {
          if (
            readRequest.hostname !== resolved.repository.hostname ||
            !isAllowedReadPath(readRequest.path, resolved.repository)
          ) {
            throw this.#safeFailure("repository-read", { reason: "scope" });
          }
          const response = await transport.request({
            hostname: resolved.repository.hostname,
            method: "GET",
            path: readRequest.path,
          });
          if (isRootPath(readRequest.path, resolved.repository)) {
            const evidence = repositoryFromEvidence(response.body, resolved.repository.hostname);
            if (
              response.status !== 200 ||
              evidence === undefined ||
              evidence.identity.repositoryId !== this.#repositoryId
            ) {
              throw this.#safeFailure("repository-read", { reason: "scope" });
            }
          }
          return response;
        },
      }),
    });
    try {
      return await operation(capability);
    } catch (error: unknown) {
      throw this.#safeOperation(error, "repository-read");
    }
  }

  async withScopedInstallationCredential(
    request: EffectAuthorizerCredentialRequest,
    operation: (capability: AppScopedMutationCapability) => Promise<void>,
  ): Promise<void> {
    if (request.app.appId !== this.#app.appId || request.app.principal !== this.#app.principal) {
      throw this.#safeFailure("installation-scope", { reason: "scope" });
    }
    if (request.target.repositoryId !== this.#repositoryId)
      throw this.#safeFailure("installation-scope", { reason: "scope" });
    const resolved = await this.#resolve(request.permissions);
    if (!hasPermissions(resolved.scope.permissions, request.permissions))
      throw this.#safeFailure("installation-scope", { reason: "scope" });
    const operationScope: AppInstallationScope = Object.freeze({
      ...resolved.scope,
      permissions: Object.freeze({ ...request.permissions }),
    });
    const transport = this.#apiTransport(resolved.credential, "projection-execution", resolved.repositoryNodeId);
    let provenance:
      | {
          readonly runtimeAuthority: GitHubChangeProvenanceSignerOptions["runtimeAuthority"];
          readonly signedRecord: GitHubChangeProvenanceSignerOptions["signedRecord"];
          readonly gitData: GitHubBranchAdvanceCapability;
        }
      | undefined;
    if (this.#provenance !== undefined) {
      const repositoryNodeId = resolved.repositoryNodeId ?? this.#repositoryNodeId;
      if (repositoryNodeId === undefined) throw this.#safeFailure("installation-scope", { reason: "scope" });
      const capabilityTransport: BranchAdvanceCapabilityTransport = Object.freeze({
        request: (input: Parameters<BranchAdvanceCapabilityTransport["request"]>[0]) => transport.request(input),
        requestGraphql: (input: GitDataGraphqlRequest) => transport.requestGraphql(input),
      });
      provenance = {
        ...this.#provenance,
        gitData: new GitHubBranchAdvanceCapabilityImpl({
          repository: resolved.repository,
          repositoryId: resolved.scope.repository.repositoryId,
          repositoryNodeId,
          scope: resolved.scope,
          transport: capabilityTransport,
        }),
      };
    }
    const adapter = new GitHubChangeEffectAdapter({
      repository: resolved.repository,
      transport,
      graphqlTransport: transport,
      ...(provenance === undefined ? {} : { provenance }),
    });
    const capability: AppScopedMutationCapability = {
      scope: operationScope,
      apply: async (effect) => {
        const result = await adapter.execute(effect);
        if (result.status === "failed") throw this.#safeMutationFailure(effect, result.failure, result.providerFailure);
        return result.evidence as never;
      },
    };
    try {
      await operation(capability);
    } catch (error: unknown) {
      throw this.#safeOperation(error, "projection-execution");
    }
  }

  async withSemanticPullRequestMutationExecutor<T>(
    request: { readonly target: RepositoryIdentity },
    operation: (executor: SemanticPullRequestMutationExecutionPort) => Promise<T>,
  ): Promise<T> {
    const target = validateRepositoryIdentity(request.target);
    if (!target.valid || target.value === undefined || target.value.repositoryId !== this.#repositoryId) {
      throw this.#safeFailure("installation-scope", { reason: "scope" });
    }
    const resolved = await this.#resolve(GITHUB_APP_SEMANTIC_PULL_REQUEST_PERMISSIONS);
    const transport = this.#apiTransport(resolved.credential, "projection-execution", resolved.repositoryNodeId);
    const executor = new GitHubAppSemanticPullRequestMutationExecutor({
      transport,
      repository: resolved.scope.repository,
    });
    try {
      return await operation(executor);
    } catch (error: unknown) {
      if (error instanceof SemanticPullRequestMutationError) throw error;
      throw this.#safeOperation(error, "projection-execution");
    }
  }

  async withBranchAdvanceCapability<T>(
    request: { readonly target: RepositoryIdentity },
    operation: (capability: GitHubBranchAdvanceCapability) => Promise<T>,
  ): Promise<T> {
    const target = validateRepositoryIdentity(request.target);
    if (!target.valid || target.value === undefined || target.value.repositoryId !== this.#repositoryId) {
      throw this.#safeFailure("installation-scope", { reason: "scope" });
    }
    const resolved = await this.#resolve(GITHUB_APP_GIT_DATA_PERMISSIONS);
    const repositoryNodeId = resolved.repositoryNodeId ?? this.#repositoryNodeId;
    if (repositoryNodeId === undefined) throw this.#safeFailure("installation-scope", { reason: "scope" });
    const transport = this.#apiTransport(resolved.credential, "projection-execution", repositoryNodeId);
    const capabilityTransport: BranchAdvanceCapabilityTransport = Object.freeze({
      request: (input: Parameters<BranchAdvanceCapabilityTransport["request"]>[0]) => transport.request(input),
      requestGraphql: (input: GitDataGraphqlRequest) => transport.requestGraphql(input),
    });
    const capability = new GitHubBranchAdvanceCapabilityImpl({
      repository: resolved.repository,
      repositoryId: resolved.scope.repository.repositoryId,
      repositoryNodeId,
      scope: resolved.scope,
      transport: capabilityTransport,
    });
    try {
      return await operation(capability);
    } catch (error: unknown) {
      throw this.#safeOperation(error, "projection-execution");
    }
  }

  async #resolve(requiredPermissions: AppPermissionSet): Promise<ResolvedCredential> {
    const credential = await this.#loadCredential();
    return credential.withAccessToken(async (token) => {
      try {
        const transport = new GitHubNativeHttpTransport({
          token,
          apiUrl: this.#apiUrl,
          fetch: this.#fetch,
          ...(this.#requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.#requestTimeoutMs }),
          maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
        });
        const installationsResponse = await transport.request({
          hostname: this.#repository.hostname,
          method: "GET",
          path: "user/installations",
        });
        if (installationsResponse.status !== 200)
          throw this.#providerFailure(installationsResponse.status, installationsResponse.headers);
        const installationsBody = record(installationsResponse.body);
        if (installationsBody === undefined || !Array.isArray(installationsBody.installations))
          throw this.#safeFailure("installation-scope", { reason: "response-validation" });
        const candidates = installationsBody.installations
          .map((candidate) => record(candidate))
          .filter((candidate): candidate is Record<string, unknown> => candidate !== undefined)
          .filter((candidate) => decimalId(candidate.app_id) === this.#app.appId)
          .filter(
            (candidate) => this.#installationId === undefined || decimalId(candidate.id) === this.#installationId,
          );
        if (candidates.length === 0) throw this.#safeFailure("installation-scope", { reason: "scope" });
        const matches: ResolvedCredential[] = [];
        for (const candidate of candidates) {
          const installationId = decimalId(candidate.id);
          if (installationId === undefined || (candidate.suspended_at !== null && candidate.suspended_at !== undefined))
            continue;
          const repositoriesResponse = await transport.request({
            hostname: this.#repository.hostname,
            method: "GET",
            path: `user/installations/${installationId}/repositories`,
          });
          if (repositoriesResponse.status !== 200)
            throw this.#providerFailure(repositoriesResponse.status, repositoriesResponse.headers);
          const repositoriesBody = record(repositoriesResponse.body);
          if (repositoriesBody === undefined || !Array.isArray(repositoriesBody.repositories))
            throw this.#safeFailure("installation-scope", { reason: "response-validation" });
          const repositoryMatches = repositoriesBody.repositories
            .map((item) => repositoryFromEvidence(item, this.#repository.hostname))
            .filter((item): item is NonNullable<typeof item> => item !== undefined)
            .filter((item) => item.identity.repositoryId === this.#repositoryId);
          if (repositoryMatches.length !== 1) {
            if (repositoryMatches.length > 1) throw this.#safeFailure("installation-scope", { reason: "scope" });
            continue;
          }
          const selected = repositoryMatches[0];
          const permissions = permissionSet(
            candidate.permissions ?? record(repositoriesBody.repositories[0])?.permissions,
          );
          if (!hasPermissions(permissions, requiredPermissions))
            throw this.#safeFailure("installation-scope", { reason: "scope" });
          const scope: AppInstallationScope = {
            app: this.#app,
            installation: { appId: this.#app.appId, installationId, repositoryHost: this.#repository.hostname },
            repository: selected.identity,
            repositorySelection: "selected",
            permissions,
            expiresAt: credential.metadata.accessTokenExpiresAt,
          };
          const validated = validateAppInstallationScope(scope, {
            app: this.#app,
            // GitHub returns the installation's actual permission set.  The
            // requested capability is checked above; scope validation must
            // preserve the provider evidence instead of requiring an exact
            // (and potentially narrower) permission object.
            requiredPermissions: permissions,
            target: selected.identity,
            now: this.#now(),
          });
          if (!validated.valid || validated.value === undefined)
            throw this.#safeFailure("installation-scope", { reason: "scope" });
          matches.push({
            credential,
            scope: validated.value,
            repository: selected.repository,
            ...(selected.nodeId === undefined ? {} : { repositoryNodeId: selected.nodeId }),
          });
        }
        if (matches.length !== 1) throw this.#safeFailure("installation-scope", { reason: "scope" });
        return matches[0];
      } catch (error: unknown) {
        if (error instanceof GitHubAppUserCredentialBrokerError) throw error;
        throw this.#safeOperation(error, "installation-scope");
      }
    });
  }

  async #loadCredential(): Promise<GitHubAppUserCredential> {
    let credential: GitHubAppUserCredential | undefined;
    try {
      credential = await this.#store.load();
    } catch {
      throw this.#safeFailure("user-credential", { reason: "credential" });
    }
    if (credential === undefined) {
      if (this.#deviceFlow === undefined) throw this.#safeFailure("user-credential", { reason: "credential" });
      try {
        credential = await this.#deviceFlow.authorize();
        await this.#store.save(credential);
      } catch (error: unknown) {
        if (
          error instanceof GitHubAppUserCredentialError &&
          (error.reason === "revoked" || error.reason === "expired")
        ) {
          throw this.#safeFailure("user-credential", { reason: "credential" });
        }
        throw this.#safeFailure("user-credential", { reason: "credential" });
      }
    } else if (credential.isAccessExpired(this.#now())) {
      if (this.#deviceFlow === undefined) throw this.#safeFailure("user-credential", { reason: "credential" });
      try {
        const refreshed = await this.#deviceFlow.refresh(credential);
        await this.#store.save(refreshed);
        credential = refreshed;
      } catch {
        await this.#store.clear().catch(() => {});
        throw this.#safeFailure("user-credential", { reason: "credential" });
      }
    }
    return credential;
  }

  #apiTransport(
    credential: GitHubAppUserCredential,
    stage: GitHubAppCredentialFailureStage,
    repositoryNodeId?: string,
  ): CredentialBoundTransport {
    const create = (token: string): GitHubAppApiTransport =>
      new GitHubAppApiTransport({
        apiUrl: this.#apiUrl,
        token,
        ...(repositoryNodeId === undefined ? {} : { repositoryNodeId }),
        fetch: this.#fetch,
        failureStage: stage,
        failure: (failureStage) =>
          this.#safeFailure(failureStage === "repository-read" ? "repository-read" : "projection-execution"),
        ...(this.#requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.#requestTimeoutMs }),
      });
    return {
      request: (request) => credential.withAccessToken((token) => create(token).request(request)),
      requestGraphql: (request) => credential.withAccessToken((token) => create(token).requestGraphql(request)),
      compareAndDeleteBranch: (request) =>
        credential.withAccessToken((token) => create(token).compareAndDeleteBranch(request)),
    };
  }

  #providerFailure(status: number, headers?: Readonly<Record<string, string>>): Error {
    return this.#safeFailure(
      "installation-scope",
      { reason: "provider-http", status },
      githubProviderFailureFromStatus(status, headers),
    );
  }

  #safeFailure(
    stage: GitHubAppUserCredentialFailureStage,
    classification?: ChangeEffectFailureClassification,
    providerFailure?: GitHubProviderFailureClassification,
  ): Error {
    try {
      const error = this.#failure(stage);
      if (error instanceof Error) {
        if (error instanceof GitHubAppUserCredentialBrokerError)
          return new GitHubAppUserCredentialBrokerError(stage, classification, providerFailure);
        return attachGitHubProviderFailure(
          attachChangeEffectFailureClassification(error, classification),
          providerFailure,
        );
      }
    } catch {
      // Fall through to the fixed safe error.
    }
    return new GitHubAppUserCredentialBrokerError(stage, classification, providerFailure);
  }

  #safeMutationFailure(
    effect: ChangeEffect,
    failure: ChangeIssuanceFailureEvidence,
    providerFailure?: GitHubProviderFailureClassification,
  ): Error {
    const classification =
      failure.reason === undefined
        ? undefined
        : {
            reason: failure.reason,
            ...(failure.status === undefined ? {} : { status: failure.status }),
            ...(failure.provider === undefined ? {} : { provider: failure.provider }),
          };
    try {
      const error = this.#mutationFailure(effect);
      if (error instanceof Error)
        return attachGitHubProviderFailure(
          attachChangeEffectFailureClassification(error, classification),
          providerFailure,
        );
    } catch {
      // Fall through to the fixed safe error.
    }
    return new GitHubAppUserCredentialBrokerError("projection-execution", classification, providerFailure);
  }

  #safeOperation(error: unknown, stage: GitHubAppUserCredentialFailureStage): Error {
    if (error instanceof GitHubAppUserCredentialBrokerError) return error;
    const providerFailure = readGitHubProviderFailure(error);
    return this.#safeFailure(stage, undefined, providerFailure);
  }
}
