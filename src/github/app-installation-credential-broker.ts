/**
 * Trusted GitHub App installation credential boundary.
 *
 * This module owns App JWT creation, installation-token minting, repository
 * selection proof, scope validation, and credential-bound transports. A
 * caller receives either a read-only repository capability or the existing
 * Effect Authorizer mutation capability; neither capability exposes a bearer token,
 * App JWT, private key, or general GitHub client.
 */

import { createSign } from "node:crypto";
import {
  GITHUB_CHANGE_EFFECT_FAILURE_MESSAGES,
  MAX_GITHUB_CHANGE_EFFECT_REJECTION_ERRORS,
  GitHubChangeEffectAdapter,
  GitHubChangeEffectFailureError,
  normalizeGitHubChangeEffectProviderDiagnostic,
  type GitHubChangeEffectRepository,
  type GitHubChangeEffectRequest,
  type GitHubChangeEffectResponse,
  type GitHubChangeEffectGraphqlTransport,
  type GitHubChangeEffectSuccessEvidence,
  type GitHubChangeProvenanceSignerOptions,
  type GitHubChangeEffectTransport,
} from "./change-effect-adapter.js";
import {
  attachChangeEffectFailureClassification,
  readChangeEffectFailureClassification,
} from "../change-failure-diagnostics.js";
import {
  GitHubBranchAdvanceCapabilityImpl,
  type BranchAdvanceCapabilityTransport,
  type GitDataGraphqlRequest,
} from "./git-data-capability.js";
import {
  APP_PRINCIPAL_MAXIMUM_PERMISSIONS,
  APP_PERMISSION_NAMES,
  EffectAuthorizerError,
  createInariAppPrincipalIdentity,
  validateAppInstallationScope,
  validateRepositoryIdentity,
  type EffectAuthorizerCredentialRequest,
  type AppInstallationScope,
  type AppPermissionName,
  type AppPermissionSet,
  type RepositoryIdentity,
  type AppScopedMutationCapability,
  type AppPrincipalIdentity,
  type TrustedInstallationCredentialBroker,
} from "./effect-authorizer.js";
import type { ChangeEffect, ChangeEffectFailureClassification, ChangeIssuanceFailureEvidence } from "../change.js";
import {
  GITHUB_APP_SEMANTIC_PULL_REQUEST_PERMISSIONS,
  GitHubAppSemanticPullRequestMutationExecutor,
} from "./app-semantic-pr-mutation.js";
import {
  SemanticPullRequestMutationError,
  type SemanticPullRequestMutationExecutionPort,
} from "../semantic-pr-mutation.js";
import {
  attachGitHubProviderFailure,
  githubProviderFailure,
  githubProviderFailureFromStatus,
  projectGitHubProviderHeaders,
  readGitHubProviderFailure,
  type GitHubProviderFailureClassification,
} from "./provider-failure.js";

const DEFAULT_API_URL = "https://api.github.com";
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_API_URL_LENGTH = 2_048;
/** Default bounded deadline for every provider request. */
const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 10_000;
/** Compile-time hard ceiling. No runtime configuration may exceed this bound. */
const MAX_PROVIDER_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TOKEN_LENGTH = 4_096;
const MAX_PRIVATE_KEY_LENGTH = 16_384;
const MAX_ID_LENGTH = 20;
const MAX_PATH_LENGTH = 4_096;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const GITHUB_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const EMPTY_COMMIT_SHA = "0".repeat(40);
const CONDITIONAL_DELETE_REF_MUTATION =
  "mutation ConditionalDeleteRef($input: UpdateRefsInput!) { " + "updateRefs(input: $input) { clientMutationId } }";

export const GITHUB_APP_REPOSITORY_READ_PERMISSIONS = Object.freeze({
  contents: "read",
  issues: "read",
  pull_requests: "read",
} as const);

export type GitHubAppRepositoryReadPermissionSet = Readonly<
  Partial<Record<"contents" | "issues" | "pull_requests", "read">>
>;

/** Minimum App permission set for the bounded Git-data capability. */
export const GITHUB_APP_GIT_DATA_PERMISSIONS = Object.freeze({
  contents: "write",
  metadata: "read",
} as const);

export const GITHUB_APP_CREDENTIAL_FAILURE_STAGES = Object.freeze([
  "issuer-configuration",
  "repository-read",
  "installation-token",
  "installation-scope",
  "projection-execution",
] as const);
export type GitHubAppCredentialFailureStage = (typeof GITHUB_APP_CREDENTIAL_FAILURE_STAGES)[number];

export class GitHubAppCredentialBrokerError extends Error {
  readonly code = "GITHUB_APP_CREDENTIAL_BROKER_FAILED" as const;
  readonly stage: GitHubAppCredentialFailureStage;
  readonly reason?: ChangeEffectFailureClassification["reason"];
  readonly status?: number;
  readonly provider?: ChangeEffectFailureClassification["provider"];
  readonly providerFailure?: GitHubProviderFailureClassification;

  constructor(
    stage: GitHubAppCredentialFailureStage,
    classification?: ChangeEffectFailureClassification,
    providerFailure?: GitHubProviderFailureClassification,
  ) {
    super("Trusted GitHub App credential operation failed closed.");
    this.name = "GitHubAppCredentialBrokerError";
    this.stage = stage;
    if (classification !== undefined) {
      attachChangeEffectFailureClassification(this, classification);
      this.reason = classification.reason;
      this.status = classification.status;
      this.provider = classification.provider;
    }
    if (providerFailure !== undefined) {
      this.providerFailure = providerFailure;
      attachGitHubProviderFailure(this, providerFailure);
    }
  }
}

/**
 * A ref'd (not `AbortSignal.timeout`'s unref'd) deadline: this deliberately
 * keeps the event loop alive until the bounded request settles one way or
 * the other, so a hung provider request fails closed instead of the runtime
 * exiting first. Always call `clear()` once the request settles.
 */
function boundedRequestSignal(timeoutMs: number): {
  readonly signal: AbortSignal;
  readonly clear: () => void;
  readonly timedOut: boolean;
} {
  const controller = new AbortController();
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
    get timedOut() {
      return state.timedOut;
    },
  };
}

export interface GitHubAppRepositoryReadTransport {
  /** Only GET requests for the selected repository are representable. */
  request(request: {
    readonly hostname: string;
    readonly method: "GET";
    readonly path: string;
  }): Promise<GitHubChangeEffectResponse>;
}

export interface GitHubAppRepositoryReadCapability {
  /** Provider Principal that performed the bounded read; no credential value. */
  readonly providerPrincipal: AppPrincipalIdentity;
  readonly scope: AppInstallationScope;
  readonly transport: GitHubAppRepositoryReadTransport;
}

export const GITHUB_APP_REPOSITORY_RESOLUTION_FAILURE_REASONS = Object.freeze([
  "repository-request",
  "repository-status",
  "repository-body",
  "repository-id",
  "repository-fork",
] as const);
export type GitHubAppRepositoryResolutionFailureReason =
  (typeof GITHUB_APP_REPOSITORY_RESOLUTION_FAILURE_REASONS)[number];

export interface GitHubAppResolvedRepository {
  readonly repository: GitHubChangeEffectRepository;
  readonly target: RepositoryIdentity;
  readonly repositoryNodeId?: string;
  readonly fork: boolean;
}

/** Resolve immutable repository identity through a credential-bound read transport. */
export async function resolveGitHubRepository(
  repository: GitHubChangeEffectRepository,
  transport: Pick<GitHubChangeEffectTransport, "request">,
  failure?: (
    reason: GitHubAppRepositoryResolutionFailureReason,
    providerFailure?: GitHubProviderFailureClassification,
  ) => Error,
): Promise<GitHubAppResolvedRepository> {
  const fail = (
    reason: GitHubAppRepositoryResolutionFailureReason,
    providerFailure?: GitHubProviderFailureClassification,
  ): Error => {
    try {
      return (
        failure?.(reason, providerFailure) ??
        new GitHubAppCredentialBrokerError("repository-read", undefined, providerFailure)
      );
    } catch {
      return new GitHubAppCredentialBrokerError("repository-read", undefined, providerFailure);
    }
  };
  let response: GitHubChangeEffectResponse;
  try {
    response = await transport.request({
      hostname: repository.hostname,
      method: "GET",
      path: `repos/${repository.owner}/${repository.name}`,
    });
  } catch (error: unknown) {
    throw fail("repository-request", readGitHubProviderFailure(error));
  }
  if (response.status !== 200) {
    throw fail("repository-status", githubProviderFailureFromStatus(response.status, response.headers));
  }
  let body: Record<string, unknown>;
  try {
    body = record(response.body);
  } catch {
    throw fail("repository-body", githubProviderFailure("response-invalid", { retryable: false }));
  }
  const repositoryId = String(body.id);
  if (!DECIMAL_ID_PATTERN.test(repositoryId)) {
    throw fail("repository-id", githubProviderFailure("response-invalid", { retryable: false }));
  }
  if (typeof body.fork !== "boolean") {
    throw fail("repository-fork", githubProviderFailure("response-invalid", { retryable: false }));
  }
  const repositoryNodeId =
    typeof body.node_id === "string" &&
    body.node_id.length > 0 &&
    body.node_id.length <= 255 &&
    !/[\u0000-\u001F\u007F]/u.test(body.node_id)
      ? body.node_id
      : undefined;
  return {
    repository,
    target: {
      repositoryHost: repository.hostname.toLowerCase(),
      repositoryId,
      nameWithOwner: repositoryName(repository),
    },
    ...(repositoryNodeId === undefined ? {} : { repositoryNodeId }),
    fork: body.fork,
  };
}

export interface GitHubAppApiTransportOptions {
  readonly apiUrl?: string;
  /** Trusted-only constructor input; never returned by this class. */
  readonly token: string;
  /** GitHub repository node ID used by the atomic conditional ref update. */
  readonly repositoryNodeId?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly failureStage?: GitHubAppCredentialFailureStage;
  readonly failure?: (stage: GitHubAppCredentialFailureStage) => Error;
  /** Bounded downward/upward only within the compile-time hard ceiling. Defaults to 10s. */
  readonly requestTimeoutMs?: number;
}

/** Credential-bound GitHub transport shared by read and mutation capabilities. */
export class GitHubAppApiTransport implements GitHubChangeEffectTransport, GitHubChangeEffectGraphqlTransport {
  readonly #apiUrl: string;
  readonly #graphqlApiUrl: string;
  readonly #token: string;
  readonly #repositoryNodeId: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #failureStage: GitHubAppCredentialFailureStage;
  readonly #failure: (stage: GitHubAppCredentialFailureStage) => Error;
  readonly #requestTimeoutMs: number;

  constructor(options: GitHubAppApiTransportOptions) {
    this.#apiUrl = boundedString(options.apiUrl ?? DEFAULT_API_URL, MAX_API_URL_LENGTH).replace(/\/+$/u, "");
    this.#graphqlApiUrl = this.#apiUrl.endsWith("/api/v3")
      ? `${this.#apiUrl.slice(0, -7)}/api/graphql`
      : `${this.#apiUrl}/graphql`;
    this.#token = boundedSecret(options.token, MAX_TOKEN_LENGTH);
    this.#repositoryNodeId =
      options.repositoryNodeId === undefined ? undefined : boundedString(options.repositoryNodeId, 255);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#failureStage = options.failureStage ?? "repository-read";
    this.#failure = options.failure ?? ((stage) => new GitHubAppCredentialBrokerError(stage));
    this.#requestTimeoutMs = normalizedRequestTimeoutMs(options.requestTimeoutMs);
  }

  async request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse> {
    return this.requestAt(this.#apiUrl, request);
  }

  /** Internal App-only GraphQL seam used solely for conditional ref updates. */
  async requestGraphql(request: GitDataGraphqlRequest): Promise<GitHubChangeEffectResponse> {
    return this.requestAt(this.#graphqlApiUrl, {
      hostname: "github.com",
      method: "POST",
      path: "",
      body: { query: request.query, variables: request.variables },
    });
  }

  private async requestAt(baseUrl: string, request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse> {
    const bounded = boundedRequestSignal(this.#requestTimeoutMs);
    let response: Response;
    try {
      try {
        response = await this.#fetch(request.path === "" ? baseUrl : `${baseUrl}/${request.path}`, {
          method: request.method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.#token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          signal: bounded.signal,
        });
      } catch {
        const providerFailure = bounded.timedOut
          ? githubProviderFailure("timeout", { retryable: true, timeoutMs: this.#requestTimeoutMs })
          : githubProviderFailure("transport", { retryable: true });
        throw this.safeFailure(this.#failureStage, { reason: "transport" }, providerFailure);
      }
      try {
        const headers = projectGitHubProviderHeaders(response.headers);
        return {
          status: response.status,
          body: await boundedBody(response),
          ...(headers === undefined ? {} : { headers }),
        };
      } catch (error: unknown) {
        const providerFailure =
          error instanceof InvalidGitHubAppResponseError
            ? githubProviderFailure("response-invalid", { retryable: false })
            : bounded.timedOut
              ? githubProviderFailure("timeout", { retryable: true, timeoutMs: this.#requestTimeoutMs })
              : githubProviderFailure("transport", { retryable: true });
        throw this.safeFailure(
          this.#failureStage,
          error instanceof InvalidGitHubAppResponseError ? { reason: "response-validation" } : { reason: "transport" },
          providerFailure,
        );
      }
    } finally {
      bounded.clear();
    }
  }

  /** Atomic compare-and-delete used by the existing Change effect adapter. */
  async compareAndDeleteBranch(request: {
    readonly branch: string;
    readonly expectedCommitSha: string;
  }): Promise<"deleted" | "mismatch"> {
    if (
      this.#repositoryNodeId === undefined ||
      typeof request.branch !== "string" ||
      request.branch.length === 0 ||
      request.branch.length > 255 ||
      /[\u0000-\u001F\u007F]/u.test(request.branch) ||
      typeof request.expectedCommitSha !== "string" ||
      !COMMIT_SHA_PATTERN.test(request.expectedCommitSha)
    ) {
      throw new GitHubChangeEffectFailureError(
        { reason: "response-validation" },
        githubProviderFailure("response-invalid", { retryable: false }),
      );
    }
    const response = await this.requestAt(this.#graphqlApiUrl, {
      hostname: "github.com",
      method: "POST",
      path: "",
      body: {
        query: CONDITIONAL_DELETE_REF_MUTATION,
        variables: {
          input: {
            repositoryId: this.#repositoryNodeId,
            refUpdates: [
              {
                name: `refs/heads/${request.branch}`,
                beforeOid: request.expectedCommitSha.toLowerCase(),
                afterOid: EMPTY_COMMIT_SHA,
                force: true,
              },
            ],
          },
        },
      },
    });
    if (response.status !== 200) {
      const provider = normalizeGitHubChangeEffectProviderDiagnostic(response.status, response.body);
      throw new GitHubChangeEffectFailureError(
        {
          reason: "provider-http",
          status: response.status,
          ...(provider === undefined ? {} : { provider }),
        },
        githubProviderFailureFromStatus(response.status, response.headers),
      );
    }
    if (!isRecord(response.body)) {
      throw new GitHubChangeEffectFailureError(
        { reason: "response-validation" },
        githubProviderFailure("response-invalid", { retryable: false }),
      );
    }
    const body = response.body;
    if (body.errors !== undefined) {
      if (!isValidGraphqlErrorList(body.errors)) {
        throw new GitHubChangeEffectFailureError(
          { reason: "response-validation" },
          githubProviderFailure("response-invalid", { retryable: false }),
        );
      }
      const provider = normalizeGitHubChangeEffectProviderDiagnostic(response.status, body);
      throw new GitHubChangeEffectFailureError(
        {
          reason: "provider-http",
          status: response.status,
          ...(provider === undefined ? {} : { provider }),
        },
        githubProviderFailure("provider-rejection", { retryable: false, status: response.status }),
      );
    }
    if (!isRecord(body.data) || !isRecord(body.data.updateRefs)) {
      throw new GitHubChangeEffectFailureError(
        { reason: "response-validation" },
        githubProviderFailure("response-invalid", { retryable: false }),
      );
    }
    if (
      !Object.prototype.hasOwnProperty.call(body.data.updateRefs, "clientMutationId") ||
      body.data.updateRefs.clientMutationId !== null
    ) {
      throw new GitHubChangeEffectFailureError(
        { reason: "response-validation" },
        githubProviderFailure("response-invalid", { retryable: false }),
      );
    }
    return "deleted";
  }

  private safeFailure(
    stage: GitHubAppCredentialFailureStage,
    classification?: ChangeEffectFailureClassification,
    providerFailure?: GitHubProviderFailureClassification,
  ): Error {
    try {
      const error = this.#failure(stage);
      if (error instanceof Error && !errorText(error).includes(this.#token)) {
        if (error instanceof GitHubAppCredentialBrokerError) {
          return new GitHubAppCredentialBrokerError(stage, classification, providerFailure);
        }
        const classified = attachChangeEffectFailureClassification(error, classification);
        return attachGitHubProviderFailure(classified, providerFailure);
      }
    } catch {
      // Fall through to the fixed safe error.
    }
    return new GitHubAppCredentialBrokerError(stage, classification, providerFailure);
  }
}

export interface GitHubAppInstallationCredentialBrokerOptions {
  readonly appId: string;
  readonly installationId: string;
  /** Trusted-only secret input. It is retained only for request-local signing. */
  readonly privateKeyPem: string;
  readonly repository: GitHubChangeEffectRepository;
  readonly repositoryNodeId?: string;
  readonly apiUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly failure?: (stage: GitHubAppCredentialFailureStage) => Error;
  readonly mutationFailure?: (effect: ChangeEffect) => Error;
  /** Trusted Runtime signer used only by CREATE_PROVENANCE_COMMIT. */
  readonly provenance?: GitHubChangeProvenanceSignerOptions;
  /** Bounded deadline applied to every provider request. Defaults to 10s; hard ceiling 30s. */
  readonly requestTimeoutMs?: number;
}

interface InstallationCredential {
  readonly token: string;
  readonly scope: AppInstallationScope;
  readonly repositoryNodeId?: string;
}

type CredentialRequest =
  | {
      readonly app: AppInstallationScope["app"];
      readonly permissions: AppPermissionSet;
      readonly kind: "read";
    }
  | {
      readonly app: AppInstallationScope["app"];
      readonly target: RepositoryIdentity;
      readonly permissions: AppPermissionSet;
      readonly kind: "mutation";
    }
  | {
      readonly app: AppInstallationScope["app"];
      readonly target: RepositoryIdentity;
      readonly permissions: AppPermissionSet;
      readonly kind: "git-data";
    };

/** Shared implementation for pre-admission reads and post-admission mutations. */
export class GitHubAppInstallationCredentialBroker implements TrustedInstallationCredentialBroker {
  readonly #app: AppInstallationScope["app"];
  readonly #installationId: string;
  readonly #privateKeyPem: string;
  readonly #repository: GitHubChangeEffectRepository;
  readonly #repositoryNodeId: string | undefined;
  readonly #apiUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;
  readonly #failure: (stage: GitHubAppCredentialFailureStage) => Error;
  readonly #mutationFailure: (effect: ChangeEffect) => Error;
  readonly #provenance: GitHubChangeProvenanceSignerOptions | undefined;
  readonly #requestTimeoutMs: number;

  constructor(options: GitHubAppInstallationCredentialBrokerOptions) {
    this.#failure = options.failure ?? ((stage) => new GitHubAppCredentialBrokerError(stage));
    this.#mutationFailure =
      options.mutationFailure ?? (() => new GitHubAppCredentialBrokerError("projection-execution"));
    try {
      if (Object.prototype.hasOwnProperty.call(options, "target")) throw new Error("repository target is not accepted");
      this.#requestTimeoutMs = normalizedRequestTimeoutMs(options.requestTimeoutMs);
      this.#app = createInariAppPrincipalIdentity(options.appId);
      this.#installationId = boundedDecimalId(options.installationId);
      this.#privateKeyPem = boundedSecret(options.privateKeyPem, MAX_PRIVATE_KEY_LENGTH);
      this.#repository = Object.freeze({
        hostname: boundedString(options.repository.hostname, 255).toLowerCase(),
        owner: boundedString(options.repository.owner, 255),
        name: boundedString(options.repository.name, 255),
      });
      this.#repositoryNodeId =
        options.repositoryNodeId === undefined ? undefined : boundedString(options.repositoryNodeId, 255);
      this.#provenance = options.provenance;
      this.#apiUrl = boundedString(options.apiUrl ?? DEFAULT_API_URL, MAX_API_URL_LENGTH).replace(/\/+$/u, "");
      this.#fetch = options.fetch ?? globalThis.fetch;
      this.#now = options.now ?? (() => new Date());
    } catch {
      throw this.safeFailure("issuer-configuration");
    }
  }

  async withRepositoryReadCapability<T>(
    request: { readonly permissions?: GitHubAppRepositoryReadPermissionSet },
    operation: (capability: GitHubAppRepositoryReadCapability) => Promise<T>,
  ): Promise<T> {
    if (!isRepositoryReadRequest(request)) throw this.safeFailure("installation-scope", { reason: "scope" });
    const permissions = request.permissions ?? GITHUB_APP_REPOSITORY_READ_PERMISSIONS;
    if (!isReadPermissionSet(permissions)) throw this.safeFailure("installation-scope", { reason: "scope" });
    const credential = await this.issueInstallationToken({
      app: this.#app,
      permissions,
      kind: "read",
    });
    const transport = new GitHubAppApiTransport({
      apiUrl: this.#apiUrl,
      token: credential.token,
      fetch: this.#fetch,
      failureStage: "repository-read",
      failure: this.#failure,
      requestTimeoutMs: this.#requestTimeoutMs,
    });
    const capability: GitHubAppRepositoryReadCapability = Object.freeze({
      providerPrincipal: credential.scope.app,
      scope: credential.scope,
      transport: Object.freeze({
        request: async (readRequest: { readonly hostname: string; readonly method: "GET"; readonly path: string }) => {
          if (!isRepositoryReadPath(readRequest, this.#repository)) {
            throw this.safeFailure("repository-read", { reason: "scope" });
          }
          const response = await transport.request({
            hostname: readRequest.hostname,
            method: "GET",
            path: readRequest.path,
          });
          if (
            isRepositoryRootPath(readRequest.path, this.#repository) &&
            !isAuthoritativeRepositoryRead(response, credential.scope.repository, this.#repository)
          ) {
            throw this.safeFailure("repository-read", { reason: "scope" });
          }
          return response;
        },
      }),
    });
    try {
      return await operation(capability);
    } catch (error: unknown) {
      throw this.safeOperationError(error, credential.token, "repository-read");
    }
  }

  async withScopedInstallationCredential(
    request: EffectAuthorizerCredentialRequest,
    operation: (capability: AppScopedMutationCapability) => Promise<void>,
  ): Promise<void> {
    const credential = await this.issueInstallationToken({
      app: request.app,
      target: request.target,
      permissions: request.permissions,
      kind: "mutation",
    });
    const transport = new GitHubAppApiTransport({
      apiUrl: this.#apiUrl,
      token: credential.token,
      repositoryNodeId: this.#repositoryNodeId,
      fetch: this.#fetch,
      failureStage: "projection-execution",
      failure: this.#failure,
      requestTimeoutMs: this.#requestTimeoutMs,
    });
    let provenance:
      | {
          readonly runtimeAuthority: GitHubChangeProvenanceSignerOptions["runtimeAuthority"];
          readonly signedRecord: GitHubChangeProvenanceSignerOptions["signedRecord"];
          readonly gitData: GitHubBranchAdvanceCapabilityImpl;
        }
      | undefined;
    if (this.#provenance !== undefined) {
      const repositoryNodeId = credential.repositoryNodeId ?? this.#repositoryNodeId;
      if (repositoryNodeId === undefined) throw this.safeFailure("installation-scope", { reason: "scope" });
      const capabilityTransport: BranchAdvanceCapabilityTransport = Object.freeze({
        request: (input: Parameters<BranchAdvanceCapabilityTransport["request"]>[0]) => transport.request(input),
        requestGraphql: (input: GitDataGraphqlRequest) => transport.requestGraphql(input),
      });
      provenance = {
        ...this.#provenance,
        gitData: new GitHubBranchAdvanceCapabilityImpl({
          repository: this.#repository,
          repositoryId: credential.scope.repository.repositoryId,
          repositoryNodeId,
          scope: credential.scope,
          transport: capabilityTransport,
        }),
      };
    }
    const adapter = new GitHubChangeEffectAdapter({
      repository: this.#repository,
      transport,
      graphqlTransport: transport,
      ...(provenance === undefined ? {} : { provenance }),
    });
    const capability: AppScopedMutationCapability = {
      scope: credential.scope,
      apply: async (effect) => {
        const result = await adapter.execute(effect);
        if (result.status === "failed") {
          throw this.safeMutationFailure(effect, result.failure, result.providerFailure);
        }
        return result.evidence as GitHubChangeEffectSuccessEvidence;
      },
    };
    try {
      await operation(capability);
    } catch (error: unknown) {
      throw this.safeOperationError(error, credential.token, "projection-execution");
    }
  }

  /**
   * Expose the existing Semantic PR authority through one short-lived,
   * repository-scoped App credential. The callback receives no transport or
   * credential, only the provider-independent mutation port.
   */
  async withSemanticPullRequestMutationExecutor<T>(
    request: { readonly target: RepositoryIdentity },
    operation: (executor: SemanticPullRequestMutationExecutionPort) => Promise<T>,
  ): Promise<T> {
    const target = validateRepositoryIdentity(request.target);
    if (!target.valid || target.value === undefined || !sameConfiguredRepository(target.value, this.#repository)) {
      throw this.safeFailure("installation-scope", { reason: "scope" });
    }
    const credential = await this.issueInstallationToken({
      app: this.#app,
      target: target.value,
      permissions: GITHUB_APP_SEMANTIC_PULL_REQUEST_PERMISSIONS,
      kind: "mutation",
    });
    const transport = new GitHubAppApiTransport({
      apiUrl: this.#apiUrl,
      token: credential.token,
      repositoryNodeId: credential.repositoryNodeId ?? this.#repositoryNodeId,
      fetch: this.#fetch,
      failureStage: "projection-execution",
      failure: this.#failure,
      requestTimeoutMs: this.#requestTimeoutMs,
    });
    const executor = new GitHubAppSemanticPullRequestMutationExecutor({
      transport,
      repository: target.value,
    });
    try {
      return await operation(executor);
    } catch (error: unknown) {
      // The Semantic PR authority owns its bounded typed outcomes. Preserve
      // those outcomes so Change can map stale, blocked, and recovery states
      // without introducing a second merge policy.
      if (error instanceof SemanticPullRequestMutationError) throw error;
      throw this.safeOperationError(error, credential.token, "projection-execution");
    }
  }

  /**
   * Execute one bounded branch-advance operation while retaining the App
   * token internally. The callback receives no generic transport or credential.
   */
  async withBranchAdvanceCapability<T>(
    request: { readonly target: RepositoryIdentity },
    operation: (capability: import("./git-data-capability.js").GitHubBranchAdvanceCapability) => Promise<T>,
  ): Promise<T> {
    if (!isRecord(request) || !isRecord(request.target) || typeof operation !== "function") {
      throw this.safeFailure("installation-scope", { reason: "scope" });
    }
    const targetResult = validateRepositoryIdentity(request.target);
    if (!targetResult.valid || targetResult.value === undefined) {
      throw this.safeFailure("installation-scope", { reason: "scope" });
    }
    const credential = await this.issueInstallationToken({
      app: this.#app,
      target: targetResult.value,
      permissions: GITHUB_APP_GIT_DATA_PERMISSIONS,
      kind: "git-data",
    });
    const repositoryNodeId = credential.repositoryNodeId ?? this.#repositoryNodeId;
    if (repositoryNodeId === undefined) throw this.safeFailure("installation-scope", { reason: "scope" });
    const transport = new GitHubAppApiTransport({
      apiUrl: this.#apiUrl,
      token: credential.token,
      repositoryNodeId,
      fetch: this.#fetch,
      failureStage: "projection-execution",
      failure: this.#failure,
      requestTimeoutMs: this.#requestTimeoutMs,
    });
    const capabilityTransport: BranchAdvanceCapabilityTransport = Object.freeze({
      request: (input: Parameters<BranchAdvanceCapabilityTransport["request"]>[0]) => transport.request(input),
      requestGraphql: (input: GitDataGraphqlRequest) => transport.requestGraphql(input),
    });
    const capability = new GitHubBranchAdvanceCapabilityImpl({
      repository: this.#repository,
      repositoryId: credential.scope.repository.repositoryId,
      repositoryNodeId,
      scope: credential.scope,
      transport: capabilityTransport,
    });
    try {
      return await operation(capability);
    } catch (error: unknown) {
      throw this.safeOperationError(error, credential.token, "projection-execution");
    }
  }

  private async issueInstallationToken(request: CredentialRequest): Promise<InstallationCredential> {
    if (
      request.app.appId !== this.#app.appId ||
      request.app.principal !== this.#app.principal ||
      request.app.slug !== this.#app.slug ||
      (request.kind !== "read" && !sameConfiguredRepository(request.target, this.#repository)) ||
      !(request.kind === "read"
        ? isReadPermissionSet(request.permissions)
        : isMutationPermissionSet(request.permissions))
    ) {
      throw this.safeFailure("installation-scope", { reason: "scope" });
    }
    const apiUrl = this.#apiUrl;
    let response: Response;
    const bounded = boundedRequestSignal(this.#requestTimeoutMs);
    try {
      response = await this.#fetch(`${apiUrl}/app/installations/${this.#installationId}/access_tokens`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${createAppJwt(this.#app.appId, this.#privateKeyPem)}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          repositories: [this.#repository.name],
          permissions: request.permissions,
        }),
        signal: bounded.signal,
      });
    } catch {
      const providerFailure = bounded.timedOut
        ? githubProviderFailure("timeout", { retryable: true, timeoutMs: this.#requestTimeoutMs })
        : githubProviderFailure("transport", { retryable: true });
      throw this.safeFailure("installation-token", { reason: "credential" }, providerFailure);
    } finally {
      bounded.clear();
    }
    if (response.status !== 201) {
      throw this.safeFailure(
        "installation-token",
        { reason: "credential" },
        githubProviderFailureFromStatus(response.status, projectGitHubProviderHeaders(response.headers)),
      );
    }

    let body: Record<string, unknown>;
    try {
      body = record(await boundedBody(response));
    } catch {
      throw this.safeFailure(
        "installation-token",
        { reason: "credential" },
        githubProviderFailure("response-invalid", { retryable: false }),
      );
    }
    let token: string;
    let expiresAt: string;
    let permissions: Record<string, unknown>;
    try {
      token = boundedSecret(body.token, MAX_TOKEN_LENGTH);
      expiresAt = boundedString(body.expires_at, 64);
      permissions = record(body.permissions);
    } catch {
      throw this.safeFailure("installation-token", { reason: "credential" });
    }
    if (!isFutureGitHubTimestamp(expiresAt, this.#now())) {
      throw this.safeFailure("installation-scope", { reason: "scope" });
    }
    if (
      (body.app_id !== undefined && String(body.app_id) !== this.#app.appId) ||
      (body.installation_id !== undefined && String(body.installation_id) !== this.#installationId)
    ) {
      throw this.safeFailure("installation-scope", { reason: "scope" });
    }

    const repositories = body.repositories;
    if (!Array.isArray(repositories) || repositories.length !== 1) {
      throw this.safeFailure("installation-scope", { reason: "scope" });
    }
    const selected = repositories[0];
    const selectedRepository = selectedRepositoryIdentity(selected, this.#repository);
    if (selectedRepository === undefined) throw this.safeFailure("installation-scope", { reason: "scope" });
    if (
      request.kind !== "read" &&
      (request.target === undefined || !sameRepository(selectedRepository, request.target))
    ) {
      throw this.safeFailure("installation-scope", { reason: "scope" });
    }
    const scopeRepository = request.kind === "read" ? selectedRepository : request.target;
    if (scopeRepository === undefined) throw this.safeFailure("installation-scope", { reason: "scope" });

    const candidateScope: AppInstallationScope = {
      app: request.app,
      installation: {
        appId: request.app.appId,
        installationId: this.#installationId,
        repositoryHost: scopeRepository.repositoryHost,
      },
      repository: scopeRepository,
      repositorySelection: "selected",
      permissions: permissions as AppPermissionSet,
      expiresAt,
    };
    const scopeResult = validateAppInstallationScope(candidateScope, {
      app: request.app,
      ...(request.kind === "mutation" ? { target: scopeRepository } : {}),
      requiredPermissions: request.permissions,
      now: this.#now(),
    });
    if (!scopeResult.valid || scopeResult.value === undefined) {
      throw this.safeFailure("installation-scope", { reason: "scope" });
    }
    const selectedNodeId = repositoryNodeIdFrom(selected);
    if (
      selectedNodeId !== undefined &&
      this.#repositoryNodeId !== undefined &&
      selectedNodeId !== this.#repositoryNodeId
    ) {
      throw this.safeFailure("installation-scope", { reason: "scope" });
    }
    return {
      token,
      scope: scopeResult.value,
      ...(selectedNodeId === undefined ? {} : { repositoryNodeId: selectedNodeId }),
    };
  }

  private safeFailure(
    stage: GitHubAppCredentialFailureStage,
    classification?: ChangeEffectFailureClassification,
    providerFailure?: GitHubProviderFailureClassification,
  ): Error {
    try {
      const error = this.#failure(stage);
      if (
        error instanceof Error &&
        (this.#privateKeyPem === undefined || !errorText(error).includes(this.#privateKeyPem)) &&
        (this.#installationId === undefined || !errorText(error).includes(this.#installationId))
      ) {
        if (error instanceof GitHubAppCredentialBrokerError) {
          return new GitHubAppCredentialBrokerError(stage, classification, providerFailure);
        }
        const classified = attachChangeEffectFailureClassification(error, classification);
        return attachGitHubProviderFailure(classified, providerFailure);
      }
    } catch {
      // Fall through to the fixed safe error.
    }
    return new GitHubAppCredentialBrokerError(stage, classification, providerFailure);
  }

  private safeMutationFailure(
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
      if (error instanceof Error && !errorText(error).includes(this.#privateKeyPem)) {
        if (error instanceof GitHubAppCredentialBrokerError && classification !== undefined) {
          return new GitHubAppCredentialBrokerError("projection-execution", classification, providerFailure);
        }
        return attachGitHubProviderFailure(
          attachChangeEffectFailureClassification(error, classification),
          providerFailure,
        );
      }
    } catch {
      // Fall through to the fixed safe error.
    }
    return new GitHubAppCredentialBrokerError("projection-execution", classification, providerFailure);
  }

  private safeOperationError(error: unknown, token: string, stage: GitHubAppCredentialFailureStage): Error {
    const classification = readChangeEffectFailureClassification(error);
    const providerFailure = readGitHubProviderFailure(error);
    if (classification !== undefined || providerFailure !== undefined) {
      return this.safeFailure(stage, classification, providerFailure);
    }
    if (error instanceof EffectAuthorizerError) {
      const serialized = errorText(error);
      if (!serialized.includes(token) && !serialized.includes(this.#privateKeyPem)) return error;
    }
    return this.safeFailure(stage);
  }
}

/** Short alias for trusted runtimes that do not use the issuer-specific name. */
export const GitHubAppCredentialBroker = GitHubAppInstallationCredentialBroker;

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function createAppJwt(appId: string, privateKeyPem: string, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000) - 60;
  const payload = { iat: issuedAt, exp: issuedAt + 540, iss: appId };
  const encodedHeader = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${encodedHeader}.${encodedPayload}`);
  return `${encodedHeader}.${encodedPayload}.${signer.sign(privateKeyPem, "base64url")}`;
}

function boundedString(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new Error("bounded value invalid");
  }
  return value;
}

function errorText(error: Error): string {
  try {
    return `${error.message}\n${JSON.stringify(error)}`;
  } catch {
    return error.message;
  }
}

function boundedSecret(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000\u007F]/u.test(value)) {
    throw new Error("secret invalid");
  }
  return value;
}

function boundedDecimalId(value: unknown): string {
  const id = boundedString(value, MAX_ID_LENGTH);
  if (!DECIMAL_ID_PATTERN.test(id)) throw new Error("id invalid");
  return id;
}

/** Bounded downward/upward only within the compile-time hard ceiling. Defaults to 10s. */
function normalizedRequestTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PROVIDER_REQUEST_TIMEOUT_MS) {
    throw new Error("request timeout invalid");
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("record invalid");
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidGraphqlErrorList(value: unknown): value is readonly Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_GITHUB_CHANGE_EFFECT_REJECTION_ERRORS &&
    value.every((entry) => isRecord(entry))
  );
}

async function boundedBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new InvalidGitHubAppResponseError();
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 0) return undefined;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidGitHubAppResponseError();
  }
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidGitHubAppResponseError();
  }
}

class InvalidGitHubAppResponseError extends Error {
  constructor() {
    super("GitHub response validation failed.");
    this.name = "InvalidGitHubAppResponseError";
  }
}

function repositoryName(repository: GitHubChangeEffectRepository): string {
  return `${repository.owner}/${repository.name}`;
}

function sameRepository(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return (
    left.repositoryHost.toLowerCase() === right.repositoryHost.toLowerCase() &&
    left.repositoryId === right.repositoryId &&
    left.nameWithOwner.toLowerCase() === right.nameWithOwner.toLowerCase()
  );
}

function isRepositoryReadRequest(
  value: unknown,
): value is { readonly permissions?: GitHubAppRepositoryReadPermissionSet } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => key === "permissions");
}

function repositoryNamePath(repository: GitHubChangeEffectRepository): string {
  return `repos/${repositoryName(repository)}`;
}

function isRepositoryRootPath(path: string, repository: GitHubChangeEffectRepository): boolean {
  const root = repositoryNamePath(repository);
  return path === root || path === `${root}/`;
}

function selectedRepositoryIdentity(
  value: unknown,
  repository: GitHubChangeEffectRepository,
): RepositoryIdentity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const repositoryId =
    typeof candidate.id === "string"
      ? candidate.id
      : typeof candidate.id === "number" && Number.isSafeInteger(candidate.id)
        ? String(candidate.id)
        : undefined;
  if (repositoryId === undefined || !DECIMAL_ID_PATTERN.test(repositoryId)) return undefined;
  if (typeof candidate.full_name !== "string") return undefined;
  const target = validateRepositoryIdentity({
    repositoryHost: repository.hostname,
    repositoryId,
    nameWithOwner: candidate.full_name,
  });
  if (
    !target.valid ||
    target.value === undefined ||
    target.value.nameWithOwner.toLowerCase() !== repositoryName(repository).toLowerCase()
  ) {
    return undefined;
  }
  return target.value;
}

function repositoryNodeIdFrom(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.node_id !== "string") return undefined;
  if (value.node_id.length === 0 || value.node_id.length > 255 || /[\u0000-\u001F\u007F]/u.test(value.node_id)) {
    return undefined;
  }
  return value.node_id;
}

function isAuthoritativeRepositoryRead(
  response: GitHubChangeEffectResponse,
  target: RepositoryIdentity,
  repository: GitHubChangeEffectRepository,
): boolean {
  const selected = selectedRepositoryIdentity(response.status === 200 ? response.body : undefined, repository);
  return selected !== undefined && sameRepository(selected, target);
}

function isFutureGitHubTimestamp(value: string, now: Date): boolean {
  const match = GITHUB_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || !Number.isFinite(now.getTime())) return false;
  return parsed.getTime() > now.getTime();
}

function isReadPermissionSet(value: Readonly<Partial<Record<string, string>>>): boolean {
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(([name, access]) =>
      name === "contents" || name === "issues" || name === "pull_requests" ? access === "read" : false,
    )
  );
}

function isMutationPermissionSet(value: AppPermissionSet): boolean {
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).every(([name, access]) => {
    if (!(APP_PERMISSION_NAMES as readonly string[]).includes(name)) return false;
    if (name === "metadata") return access === "read";
    const maximum = APP_PRINCIPAL_MAXIMUM_PERMISSIONS[name as AppPermissionName];
    return name !== "issues" && access === "write" && maximum === "write";
  });
}

function isRepositoryReadPath(
  request: { readonly hostname: string; readonly method: "GET"; readonly path: string },
  repository: GitHubChangeEffectRepository,
): boolean {
  const prefix = repositoryNamePath(repository);
  return (
    request.method === "GET" &&
    typeof request.hostname === "string" &&
    request.hostname.toLowerCase() === repository.hostname.toLowerCase() &&
    typeof request.path === "string" &&
    request.path.length > 0 &&
    request.path.length <= MAX_PATH_LENGTH &&
    !/[\u0000-\u001F\u007F]/u.test(request.path) &&
    !request.path.includes("..") &&
    !hasEncodedRepositoryPathAmbiguity(request.path, prefix) &&
    (request.path === prefix || request.path.startsWith(`${prefix}/`))
  );
}

function hasEncodedRepositoryPathAmbiguity(path: string, prefix: string): boolean {
  const pathWithoutQuery = path.split(/[?#]/u, 1)[0] ?? path;
  let candidate = pathWithoutQuery;
  let decodePasses = 0;
  for (let pass = 0; pass <= MAX_PATH_LENGTH; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return true;
    }
    if (decoded !== candidate) decodePasses += 1;
    if (
      decoded.includes("\\") ||
      decoded.split("/").some((segment) => segment === "." || segment === "..") ||
      !isRepositoryPath(decoded, prefix) ||
      (decodePasses > 1 && countPathSeparators(decoded) > countPathSeparators(candidate))
    ) {
      return true;
    }
    if (decoded === candidate) return false;
    candidate = decoded;
  }
  return true;
}

function isRepositoryPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function countPathSeparators(path: string): number {
  return (path.match(/[.\\/]/gu) ?? []).length;
}

function sameConfiguredRepository(target: RepositoryIdentity, repository: GitHubChangeEffectRepository): boolean {
  return (
    target.repositoryHost.toLowerCase() === repository.hostname.toLowerCase() &&
    target.nameWithOwner.toLowerCase() === repositoryName(repository).toLowerCase()
  );
}
