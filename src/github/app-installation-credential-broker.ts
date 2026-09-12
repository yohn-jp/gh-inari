/**
 * Trusted GitHub App installation credential boundary.
 *
 * This module owns App JWT creation, installation-token minting, repository
 * selection proof, scope validation, and credential-bound transports. A
 * caller receives either a read-only repository capability or the existing
 * issuer mutation capability; neither capability exposes a bearer token,
 * App JWT, private key, or general GitHub client.
 */

import { createSign } from "node:crypto";
import {
  GITHUB_CHANGE_EFFECT_FAILURE_MESSAGES,
  GitHubChangeEffectAdapter,
  type GitHubChangeEffectRepository,
  type GitHubChangeEffectRequest,
  type GitHubChangeEffectResponse,
  type GitHubChangeEffectSuccessEvidence,
  type GitHubChangeEffectTransport,
} from "./change-effect-adapter.js";
import {
  INARI_ISSUER_MAXIMUM_PERMISSIONS,
  ISSUER_PERMISSION_NAMES,
  IssuerAuthorityError,
  createInariIssuerAppIdentity,
  validateIssuerInstallationScope,
  validateIssuerRepositoryIdentity,
  type IssuerCredentialRequest,
  type IssuerInstallationScope,
  type IssuerPermissionName,
  type IssuerPermissionSet,
  type IssuerRepositoryIdentity,
  type IssuerScopedMutationCapability,
  type TrustedInstallationCredentialBroker,
} from "./issuer-authority.js";
import type { ChangeEffect } from "../change.js";

const DEFAULT_API_URL = "https://api.github.com";
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_API_URL_LENGTH = 2_048;
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

  constructor(stage: GitHubAppCredentialFailureStage) {
    super("Trusted GitHub App credential operation failed closed.");
    this.name = "GitHubAppCredentialBrokerError";
    this.stage = stage;
  }
}

export interface GitHubAppRepositoryReadRequest {
  readonly target: IssuerRepositoryIdentity;
  /** Requested permissions are narrowed to read-only repository evidence. */
  readonly permissions?: GitHubAppRepositoryReadPermissionSet;
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
  readonly scope: IssuerInstallationScope;
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
  readonly target: IssuerRepositoryIdentity;
  readonly repositoryNodeId?: string;
  readonly fork: boolean;
}

/** Resolve immutable repository identity through a credential-bound read transport. */
export async function resolveGitHubRepository(
  repository: GitHubChangeEffectRepository,
  transport: Pick<GitHubChangeEffectTransport, "request">,
  failure?: (reason: GitHubAppRepositoryResolutionFailureReason) => Error,
): Promise<GitHubAppResolvedRepository> {
  const fail = (reason: GitHubAppRepositoryResolutionFailureReason): Error => {
    try {
      return failure?.(reason) ?? new GitHubAppCredentialBrokerError("repository-read");
    } catch {
      return new GitHubAppCredentialBrokerError("repository-read");
    }
  };
  let response: GitHubChangeEffectResponse;
  try {
    response = await transport.request({
      hostname: repository.hostname,
      method: "GET",
      path: `repos/${repository.owner}/${repository.name}`,
    });
  } catch {
    throw fail("repository-request");
  }
  if (response.status !== 200) throw fail("repository-status");
  let body: Record<string, unknown>;
  try {
    body = record(response.body);
  } catch {
    throw fail("repository-body");
  }
  const repositoryId = String(body.id);
  if (!DECIMAL_ID_PATTERN.test(repositoryId)) throw fail("repository-id");
  if (typeof body.fork !== "boolean") throw fail("repository-fork");
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
}

/** Credential-bound GitHub transport shared by read and mutation capabilities. */
export class GitHubAppApiTransport implements GitHubChangeEffectTransport {
  readonly #apiUrl: string;
  readonly #graphqlApiUrl: string;
  readonly #token: string;
  readonly #repositoryNodeId: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #failureStage: GitHubAppCredentialFailureStage;
  readonly #failure: (stage: GitHubAppCredentialFailureStage) => Error;

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
  }

  async request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse> {
    return this.requestAt(this.#apiUrl, request);
  }

  private async requestAt(baseUrl: string, request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse> {
    try {
      const response = await this.#fetch(request.path === "" ? baseUrl : `${baseUrl}/${request.path}`, {
        method: request.method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.#token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      return { status: response.status, body: await boundedBody(response) };
    } catch {
      throw this.safeFailure(this.#failureStage);
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
      return "mismatch";
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
    if (
      response.status !== 200 ||
      typeof response.body !== "object" ||
      response.body === null ||
      Array.isArray(response.body)
    ) {
      return "mismatch";
    }
    const body = response.body as Record<string, unknown>;
    if (body.errors !== undefined) return "mismatch";
    const data = body.data;
    if (
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data) ||
      typeof (data as Record<string, unknown>).updateRefs !== "object" ||
      (data as Record<string, unknown>).updateRefs === null ||
      Array.isArray((data as Record<string, unknown>).updateRefs)
    ) {
      return "mismatch";
    }
    return "deleted";
  }

  private safeFailure(stage: GitHubAppCredentialFailureStage): Error {
    try {
      const error = this.#failure(stage);
      if (error instanceof Error && !errorText(error).includes(this.#token)) return error;
    } catch {
      // Fall through to the fixed safe error.
    }
    return new GitHubAppCredentialBrokerError(stage);
  }
}

export interface GitHubAppInstallationCredentialBrokerOptions {
  readonly appId: string;
  readonly installationId: string;
  /** Trusted-only secret input. It is retained only for request-local signing. */
  readonly privateKeyPem: string;
  readonly repository: GitHubChangeEffectRepository;
  readonly target: IssuerRepositoryIdentity;
  readonly repositoryNodeId?: string;
  readonly apiUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly failure?: (stage: GitHubAppCredentialFailureStage) => Error;
  readonly mutationFailure?: (effect: ChangeEffect) => Error;
}

interface InstallationCredential {
  readonly token: string;
  readonly scope: IssuerInstallationScope;
}

interface CredentialRequest {
  readonly app: IssuerInstallationScope["app"];
  readonly target: IssuerRepositoryIdentity;
  readonly permissions: IssuerPermissionSet;
  readonly kind: "read" | "mutation";
}

/** Shared implementation for pre-admission reads and post-admission mutations. */
export class GitHubAppInstallationCredentialBroker implements TrustedInstallationCredentialBroker {
  readonly #app: IssuerInstallationScope["app"];
  readonly #installationId: string;
  readonly #privateKeyPem: string;
  readonly #repository: GitHubChangeEffectRepository;
  readonly #target: IssuerRepositoryIdentity;
  readonly #repositoryNodeId: string | undefined;
  readonly #apiUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;
  readonly #failure: (stage: GitHubAppCredentialFailureStage) => Error;
  readonly #mutationFailure: (effect: ChangeEffect) => Error;

  constructor(options: GitHubAppInstallationCredentialBrokerOptions) {
    this.#failure = options.failure ?? ((stage) => new GitHubAppCredentialBrokerError(stage));
    this.#mutationFailure =
      options.mutationFailure ?? (() => new GitHubAppCredentialBrokerError("projection-execution"));
    try {
      this.#app = createInariIssuerAppIdentity(options.appId);
      this.#installationId = boundedDecimalId(options.installationId);
      this.#privateKeyPem = boundedSecret(options.privateKeyPem, MAX_PRIVATE_KEY_LENGTH);
      this.#repository = Object.freeze({
        hostname: boundedString(options.repository.hostname, 255).toLowerCase(),
        owner: boundedString(options.repository.owner, 255),
        name: boundedString(options.repository.name, 255),
      });
      const target = validateIssuerRepositoryIdentity(options.target);
      if (!target.valid || target.value === undefined) throw new Error("invalid repository target");
      this.#target = target.value;
      if (
        this.#repository.hostname !== this.#target.repositoryHost ||
        repositoryName(this.#repository).toLowerCase() !== this.#target.nameWithOwner.toLowerCase()
      ) {
        throw new Error("repository target mismatch");
      }
      this.#repositoryNodeId =
        options.repositoryNodeId === undefined ? undefined : boundedString(options.repositoryNodeId, 255);
      this.#apiUrl = boundedString(options.apiUrl ?? DEFAULT_API_URL, MAX_API_URL_LENGTH).replace(/\/+$/u, "");
      this.#fetch = options.fetch ?? globalThis.fetch;
      this.#now = options.now ?? (() => new Date());
    } catch {
      throw this.safeFailure("issuer-configuration");
    }
  }

  async withRepositoryReadCapability<T>(
    request: GitHubAppRepositoryReadRequest,
    operation: (capability: GitHubAppRepositoryReadCapability) => Promise<T>,
  ): Promise<T> {
    const permissions = request.permissions ?? GITHUB_APP_REPOSITORY_READ_PERMISSIONS;
    if (!isReadPermissionSet(permissions)) throw this.safeFailure("installation-scope");
    const credential = await this.issueInstallationToken({
      app: this.#app,
      target: request.target,
      permissions,
      kind: "read",
    });
    const transport = new GitHubAppApiTransport({
      apiUrl: this.#apiUrl,
      token: credential.token,
      fetch: this.#fetch,
      failureStage: "repository-read",
      failure: this.#failure,
    });
    const capability: GitHubAppRepositoryReadCapability = Object.freeze({
      scope: credential.scope,
      transport: {
        request: async (readRequest: { readonly hostname: string; readonly method: "GET"; readonly path: string }) => {
          if (!isRepositoryReadPath(readRequest, this.#repository, this.#target)) {
            throw this.safeFailure("repository-read");
          }
          return transport.request({
            hostname: readRequest.hostname,
            method: "GET",
            path: readRequest.path,
          });
        },
      },
    });
    try {
      return await operation(capability);
    } catch (error: unknown) {
      throw this.safeOperationError(error, credential.token, "repository-read");
    }
  }

  /** Naming alias for callers that model the read capability as a scoped lease. */
  async withScopedRepositoryRead<T>(
    request: GitHubAppRepositoryReadRequest,
    operation: (capability: GitHubAppRepositoryReadCapability) => Promise<T>,
  ): Promise<T> {
    return this.withRepositoryReadCapability(request, operation);
  }

  /** Explicit short form for trusted runtimes that already scope the call site. */
  async withRepositoryRead<T>(
    request: GitHubAppRepositoryReadRequest,
    operation: (capability: GitHubAppRepositoryReadCapability) => Promise<T>,
  ): Promise<T> {
    return this.withRepositoryReadCapability(request, operation);
  }

  async withScopedInstallationCredential(
    request: IssuerCredentialRequest,
    operation: (capability: IssuerScopedMutationCapability) => Promise<void>,
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
    });
    const adapter = new GitHubChangeEffectAdapter({ repository: this.#repository, transport });
    const capability: IssuerScopedMutationCapability = {
      scope: credential.scope,
      apply: async (effect) => {
        const result = await adapter.execute(effect);
        if (result.status === "failed") throw this.safeMutationFailure(effect);
        return result.evidence as GitHubChangeEffectSuccessEvidence;
      },
    };
    try {
      await operation(capability);
    } catch (error: unknown) {
      throw this.safeOperationError(error, credential.token, "projection-execution");
    }
  }

  private async issueInstallationToken(request: CredentialRequest): Promise<InstallationCredential> {
    if (
      request.app.appId !== this.#app.appId ||
      request.app.principal !== this.#app.principal ||
      request.app.slug !== this.#app.slug ||
      !sameRepository(request.target, this.#target) ||
      !(request.kind === "read"
        ? isReadPermissionSet(request.permissions)
        : isMutationPermissionSet(request.permissions))
    ) {
      throw this.safeFailure("installation-scope");
    }
    const apiUrl = this.#apiUrl;
    let response: Response;
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
      });
    } catch {
      throw this.safeFailure("installation-token");
    }
    if (response.status !== 201) throw this.safeFailure("installation-token");

    let body: Record<string, unknown>;
    try {
      body = record(await boundedBody(response));
    } catch {
      throw this.safeFailure("installation-token");
    }
    let token: string;
    let expiresAt: string;
    let permissions: Record<string, unknown>;
    try {
      token = boundedSecret(body.token, MAX_TOKEN_LENGTH);
      expiresAt = boundedString(body.expires_at, 64);
      permissions = record(body.permissions);
    } catch {
      throw this.safeFailure("installation-token");
    }
    if (!isFutureGitHubTimestamp(expiresAt, this.#now())) throw this.safeFailure("installation-scope");
    if (
      (body.app_id !== undefined && String(body.app_id) !== this.#app.appId) ||
      (body.installation_id !== undefined && String(body.installation_id) !== this.#installationId)
    ) {
      throw this.safeFailure("installation-scope");
    }

    const repositories = body.repositories;
    if (!Array.isArray(repositories) || repositories.length !== 1) {
      throw this.safeFailure("installation-scope");
    }
    const selected = repositories[0];
    if (!isSelectedRepository(selected, this.#target)) throw this.safeFailure("installation-scope");

    const candidateScope: IssuerInstallationScope = {
      app: request.app,
      installation: {
        appId: request.app.appId,
        installationId: this.#installationId,
        repositoryHost: request.target.repositoryHost,
      },
      repository: request.target,
      repositorySelection: "selected",
      permissions: permissions as IssuerPermissionSet,
      expiresAt,
    };
    const scopeResult = validateIssuerInstallationScope(candidateScope, {
      app: request.app,
      target: request.target,
      requiredPermissions: request.permissions,
      now: this.#now(),
    });
    if (!scopeResult.valid || scopeResult.value === undefined) throw this.safeFailure("installation-scope");
    return { token, scope: scopeResult.value };
  }

  private safeFailure(stage: GitHubAppCredentialFailureStage): Error {
    try {
      const error = this.#failure(stage);
      if (
        error instanceof Error &&
        (this.#privateKeyPem === undefined || !errorText(error).includes(this.#privateKeyPem)) &&
        (this.#installationId === undefined || !errorText(error).includes(this.#installationId))
      ) {
        return error;
      }
    } catch {
      // Fall through to the fixed safe error.
    }
    return new GitHubAppCredentialBrokerError(stage);
  }

  private safeMutationFailure(effect: ChangeEffect): Error {
    try {
      const error = this.#mutationFailure(effect);
      if (error instanceof Error && !errorText(error).includes(this.#privateKeyPem)) return error;
    } catch {
      // Fall through to the fixed safe error.
    }
    return new GitHubAppCredentialBrokerError("projection-execution");
  }

  private safeOperationError(error: unknown, token: string, stage: GitHubAppCredentialFailureStage): Error {
    if (error instanceof IssuerAuthorityError) {
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

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("record invalid");
  return value as Record<string, unknown>;
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
      if (size > MAX_RESPONSE_BYTES) throw new Error("response too large");
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
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("response JSON invalid");
  }
}

function repositoryName(repository: GitHubChangeEffectRepository): string {
  return `${repository.owner}/${repository.name}`;
}

function sameRepository(left: IssuerRepositoryIdentity, right: IssuerRepositoryIdentity): boolean {
  return (
    left.repositoryHost.toLowerCase() === right.repositoryHost.toLowerCase() &&
    left.repositoryId === right.repositoryId &&
    left.nameWithOwner.toLowerCase() === right.nameWithOwner.toLowerCase()
  );
}

function isSelectedRepository(value: unknown, target: IssuerRepositoryIdentity): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    String(candidate.id) === target.repositoryId &&
    typeof candidate.full_name === "string" &&
    candidate.full_name.toLowerCase() === target.nameWithOwner.toLowerCase()
  );
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

function isMutationPermissionSet(value: IssuerPermissionSet): boolean {
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).every(([name, access]) => {
    if (!(ISSUER_PERMISSION_NAMES as readonly string[]).includes(name)) return false;
    if (name === "metadata") return access === "read";
    const maximum = INARI_ISSUER_MAXIMUM_PERMISSIONS[name as IssuerPermissionName];
    return name !== "issues" && access === "write" && maximum === "write";
  });
}

function isRepositoryReadPath(
  request: { readonly hostname: string; readonly method: "GET"; readonly path: string },
  repository: GitHubChangeEffectRepository,
  target: IssuerRepositoryIdentity,
): boolean {
  const prefix = `repos/${repositoryName(repository)}`;
  return (
    request.method === "GET" &&
    request.hostname.toLowerCase() === target.repositoryHost.toLowerCase() &&
    typeof request.path === "string" &&
    request.path.length > 0 &&
    request.path.length <= MAX_PATH_LENGTH &&
    !/[\u0000-\u001F\u007F]/u.test(request.path) &&
    !request.path.includes("..") &&
    (request.path === prefix || request.path.startsWith(`${prefix}/`))
  );
}
