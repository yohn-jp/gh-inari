/**
 * Request-scoped human authentication for a hosted Endpoint.
 *
 * The HTTP transport owns the bearer credential.  This adapter uses that
 * credential only for the bounded GitHub reads needed to establish the
 * authenticated user, App installation, and immutable repository scope.  The
 * credential is never part of Endpoint evidence or the returned capability.
 */

import type { EndpointApiAuthenticationRequest, EndpointHumanAuthenticationPort } from "../endpoint-api.js";
import {
  ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
  endpointCapabilityForOperation,
  validateEndpointCapability,
  validateEndpointAuthorizationEvidence,
  validateEndpointIdentity,
  validateEndpointInstallationIdentity,
  validateEndpointRepositoryIdentity,
  type EndpointAuthorizationEvidence,
  type EndpointCapability,
  type EndpointIdentity,
  type EndpointInstallationIdentity,
  type EndpointRepositoryIdentity,
} from "../endpoint-authorization.js";
import type { GitHubChangeEffectResponse } from "./change-effect-adapter.js";
import { GitHubNativeHttpTransport, type GitHubNativeHttpResponse } from "./native-http-transport.js";

const MAX_TOKEN_LENGTH = 4_096;
const MAX_ID_LENGTH = 20;
const MAX_HOSTNAME_LENGTH = 255;
const MAX_PATH_LENGTH = 4_096;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

export const ENDPOINT_HUMAN_AUTH_CONTRACT_VERSION = ENDPOINT_AUTHORIZATION_CONTRACT_VERSION;

export type EndpointHumanAuthenticationFailureStage =
  "authorization" | "user-identity" | "installation-scope" | "repository-scope" | "repository-read";

/** Stable, secret-free failure returned by this authentication boundary. */
export class EndpointHumanAuthenticationError extends Error {
  readonly code = "ENDPOINT_HUMAN_AUTHENTICATION_FAILED" as const;
  readonly stage: EndpointHumanAuthenticationFailureStage;

  constructor(stage: EndpointHumanAuthenticationFailureStage) {
    super("Hosted Endpoint human authentication failed closed.");
    this.name = "EndpointHumanAuthenticationError";
    this.stage = stage;
  }
}

export interface EndpointHumanRepositoryReadRequest {
  readonly hostname: string;
  readonly method: "GET";
  readonly path: string;
}

/** The only provider capability exposed after hosted human admission. */
export interface EndpointHumanRepositoryReadTransport {
  request(request: EndpointHumanRepositoryReadRequest): Promise<GitHubNativeHttpResponse>;
}

export type EndpointHumanRepositoryReadOperation<T> = (
  transport: EndpointHumanRepositoryReadTransport,
) => T | Promise<T>;

export interface EndpointHumanAuthenticationSuccess {
  readonly authenticated: true;
  readonly evidence: EndpointAuthorizationEvidence;
  /**
   * Execute one request-scoped repository reader without exposing the bearer
   * credential or an unrestricted GitHub transport to the caller.
   */
  readonly withRepositoryReadTransport: <T>(operation: EndpointHumanRepositoryReadOperation<T>) => Promise<T>;
}

export interface EndpointHumanAuthenticationFailure {
  readonly authenticated: false;
  readonly diagnostics?: readonly [];
}

export type EndpointHumanAuthenticationResult = EndpointHumanAuthenticationSuccess | EndpointHumanAuthenticationFailure;

export interface EndpointHumanAuthenticatorOptions {
  /** Configured GitHub App database ID. */
  readonly appId: string;
  /** Optional GitHub REST base URL, normally derived from the repository host. */
  readonly apiUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
}

type AuthenticationRequest = EndpointApiAuthenticationRequest;

interface RepositoryLocator {
  readonly owner: string;
  readonly name: string;
  readonly nameWithOwner: string;
}

interface AuthenticatedUser {
  readonly databaseId: string;
}

interface InstallationEvidence {
  readonly id: string;
}

interface RepositoryEvidence {
  readonly identity: EndpointRepositoryIdentity;
  readonly locator: RepositoryLocator;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function decimalId(value: unknown): string | undefined {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return undefined;
    value = String(value);
  }
  return typeof value === "string" && value.length <= MAX_ID_LENGTH && DECIMAL_ID.test(value) ? value : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && SAFE_TEXT.test(value)
    ? value
    : undefined;
}

function repositoryLocator(value: unknown): RepositoryLocator | undefined {
  const body = isRecord(value) ? value : undefined;
  if (body === undefined) return undefined;
  const fullName = boundedText(body.full_name, 511);
  if (fullName !== undefined) {
    const parts = fullName.split("/");
    if (parts.length === 2 && parts.every((part) => /^[A-Za-z0-9_.-]+$/u.test(part))) {
      return Object.freeze({ owner: parts[0]!, name: parts[1]!, nameWithOwner: fullName });
    }
  }
  const owner = isRecord(body.owner) ? boundedText(body.owner.login, 255) : undefined;
  const name = boundedText(body.name, 255);
  if (owner === undefined || name === undefined) return undefined;
  if (!/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(name)) return undefined;
  return Object.freeze({ owner, name, nameWithOwner: `${owner}/${name}` });
}

function requestedLocator(value: string): RepositoryLocator | undefined {
  const parts = value.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part))) return undefined;
  return Object.freeze({ owner: parts[0]!, name: parts[1]!, nameWithOwner: value });
}

function headerValue(value: unknown, name: string): string | undefined {
  if (typeof Headers !== "undefined" && value instanceof Headers) return value.get(name) ?? undefined;
  if (typeof Request !== "undefined" && value instanceof Request) return value.headers.get(name) ?? undefined;
  if (!isRecord(value)) return undefined;
  const headers = value.headers;
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name) ?? undefined;
  if (isRecord(headers)) {
    for (const [key, candidate] of Object.entries(headers)) {
      if (key.toLowerCase() === name.toLowerCase() && typeof candidate === "string") return candidate;
    }
  }
  return undefined;
}

/** Read one bounded Bearer credential from the injected HTTP transport. */
export function readEndpointBearerCredential(transport: unknown): string {
  const value = headerValue(transport, "authorization");
  if (value === undefined || value.length === 0 || value.length > MAX_TOKEN_LENGTH || value.includes(",")) {
    throw new EndpointHumanAuthenticationError("authorization");
  }
  const match = /^Bearer[ \t]+([^ \t\r\n]+)$/iu.exec(value);
  if (match === null || match[1]!.length === 0 || match[1]!.length > MAX_TOKEN_LENGTH) {
    throw new EndpointHumanAuthenticationError("authorization");
  }
  return match[1]!;
}

function responseStatus(response: GitHubChangeEffectResponse | undefined): number | undefined {
  return response !== undefined && Number.isSafeInteger(response.status) ? response.status : undefined;
}

function safeFailure(stage: EndpointHumanAuthenticationFailureStage): EndpointHumanAuthenticationError {
  return new EndpointHumanAuthenticationError(stage);
}

async function get(
  transport: Pick<GitHubNativeHttpTransport, "request">,
  hostname: string,
  path: string,
  stage: EndpointHumanAuthenticationFailureStage,
): Promise<GitHubNativeHttpResponse> {
  try {
    const response = await transport.request({ hostname, method: "GET", path });
    if (responseStatus(response) === undefined) throw safeFailure(stage);
    return response;
  } catch (error) {
    if (error instanceof EndpointHumanAuthenticationError) throw error;
    throw safeFailure(stage);
  }
}

function validateRequest(request: AuthenticationRequest): {
  readonly endpoint: EndpointIdentity;
  readonly installation: EndpointInstallationIdentity;
  readonly repository: EndpointRepositoryIdentity;
  readonly capability: EndpointCapability;
  readonly operation: string;
} {
  if (!isRecord(request) || request.version !== ENDPOINT_AUTHORIZATION_CONTRACT_VERSION || !isRecord(request.request)) {
    throw safeFailure("authorization");
  }
  const target = request.request;
  if (target.version !== ENDPOINT_AUTHORIZATION_CONTRACT_VERSION) throw safeFailure("authorization");
  const endpoint = validateEndpointIdentity(target.endpoint).value;
  const installation = validateEndpointInstallationIdentity(target.installation).value;
  const repository = validateEndpointRepositoryIdentity(target.repository).value;
  if (endpoint === undefined || installation === undefined || repository === undefined) {
    throw safeFailure("authorization");
  }
  let capability: EndpointCapability;
  try {
    capability = endpointCapabilityForOperation(target.operation);
  } catch {
    throw safeFailure("authorization");
  }
  const requestedCapability = validateEndpointCapability(target.capability).value;
  if (requestedCapability === undefined || requestedCapability.kind !== capability.kind) {
    throw safeFailure("authorization");
  }
  if (
    decimalId(installation.installationId) === undefined ||
    requestedLocator(repository.nameWithOwner) === undefined
  ) {
    throw safeFailure("authorization");
  }
  if (repository.repositoryHost.length > MAX_HOSTNAME_LENGTH || /[\s/]/u.test(repository.repositoryHost)) {
    throw safeFailure("authorization");
  }
  return Object.freeze({ endpoint, installation, repository, capability, operation: target.operation });
}

function readUser(response: GitHubNativeHttpResponse): AuthenticatedUser {
  if (response.status !== 200 || !isRecord(response.body)) throw safeFailure("user-identity");
  const databaseId = decimalId(response.body.id);
  const login = boundedText(response.body.login, 39);
  if (databaseId === undefined || login === undefined || !LOGIN.test(login)) throw safeFailure("user-identity");
  return Object.freeze({ databaseId });
}

function readInstallation(
  response: GitHubNativeHttpResponse,
  expectedAppId: string,
  expectedInstallationId: string,
): InstallationEvidence {
  if (response.status !== 200 || !isRecord(response.body) || !Array.isArray(response.body.installations)) {
    throw safeFailure("installation-scope");
  }
  const matches = response.body.installations
    .filter(isRecord)
    .filter((candidate) => decimalId(candidate.id) === expectedInstallationId);
  if (matches.length !== 1) throw safeFailure("installation-scope");
  const candidate = matches[0]!;
  if (decimalId(candidate.app_id) !== expectedAppId) throw safeFailure("installation-scope");
  if (candidate.suspended_at !== undefined && candidate.suspended_at !== null) {
    throw safeFailure("installation-scope");
  }
  return Object.freeze({ id: expectedInstallationId });
}

function readRepository(response: GitHubNativeHttpResponse, target: EndpointRepositoryIdentity): RepositoryEvidence {
  if (response.status !== 200 || !isRecord(response.body) || !Array.isArray(response.body.repositories)) {
    throw safeFailure("repository-scope");
  }
  const matches = response.body.repositories
    .filter(isRecord)
    .filter((candidate) => decimalId(candidate.id) === target.repositoryId);
  if (matches.length !== 1) throw safeFailure("repository-scope");
  const locator = repositoryLocator(matches[0]);
  if (locator === undefined) throw safeFailure("repository-scope");
  const identity: EndpointRepositoryIdentity = Object.freeze({
    version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
    kind: "repository",
    endpointId: target.endpointId,
    installationId: target.installationId,
    repositoryHost: target.repositoryHost,
    repositoryId: target.repositoryId,
    // This is diagnostic locator metadata.  Authorization remains ID/host-bound.
    nameWithOwner: locator.nameWithOwner,
  });
  return Object.freeze({ identity, locator });
}

function repositoryPath(locator: RepositoryLocator): string {
  return `repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}`;
}

function allowedRepositoryPath(path: unknown, locator: RepositoryLocator): path is string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > MAX_PATH_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    path.startsWith("/") ||
    path.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)
  ) {
    return false;
  }
  const root = repositoryPath(locator);
  if (path !== root && !path.startsWith(`${root}/`)) return false;

  const suffix = path.slice(root.length + 1);
  if (path === root || /%(?![0-9A-Fa-f]{2})/u.test(suffix)) return path === root;

  try {
    const decoded = decodeURIComponent(suffix);
    if (/[\u0000-\u001f\u007f]/u.test(decoded) || decoded.includes("\\")) return false;
    return !decoded.split("/").some((component) => component === "." || component === "..");
  } catch {
    return false;
  }
}

function evidenceFor(
  endpoint: EndpointIdentity,
  installation: EndpointInstallationIdentity,
  repository: EndpointRepositoryIdentity,
  user: AuthenticatedUser,
  capability: EndpointCapability,
): EndpointAuthorizationEvidence {
  const principal = Object.freeze({
    version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
    kind: "human" as const,
    id: `github-user:${user.databaseId}`,
  });
  return Object.freeze({
    version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
    authenticated: true as const,
    principal,
    endpoint,
    installation,
    repository,
    capabilities: Object.freeze([capability]),
  });
}

/** Hosted GitHub App-user authenticator implementing the Endpoint auth port. */
export class EndpointHumanAuthenticator implements EndpointHumanAuthenticationPort {
  readonly #appId: string;
  readonly #apiUrl: string | undefined;
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #requestTimeoutMs: number | undefined;

  constructor(options: EndpointHumanAuthenticatorOptions) {
    if (!isRecord(options) || decimalId(options.appId) === undefined) throw safeFailure("authorization");
    this.#appId = options.appId;
    this.#apiUrl = options.apiUrl;
    this.#fetch = options.fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs;
  }

  async authenticate(request: AuthenticationRequest): Promise<EndpointHumanAuthenticationResult> {
    const target = validateRequest(request);
    const token = readEndpointBearerCredential(request.transport);
    const hostname = target.repository.repositoryHost.toLowerCase();
    const provider = new GitHubNativeHttpTransport({
      token,
      ...(this.#apiUrl === undefined ? {} : { apiUrl: this.#apiUrl }),
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
      ...(this.#requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.#requestTimeoutMs }),
    });

    const userResponse = await get(provider, hostname, "user", "user-identity");
    const user = readUser(userResponse);
    const installationResponse = await get(provider, hostname, "user/installations", "installation-scope");
    const installation = readInstallation(installationResponse, this.#appId, target.installation.installationId);
    const repositoryResponse = await get(
      provider,
      hostname,
      `user/installations/${installation.id}/repositories`,
      "repository-scope",
    );
    const repository = readRepository(repositoryResponse, target.repository);
    const evidence = evidenceFor(target.endpoint, target.installation, repository.identity, user, target.capability);

    // Re-validate the exact evidence shape before it crosses the auth boundary.
    const validated = validateEndpointAuthorizationEvidence(evidence);
    if (!validated.valid || validated.value === undefined) throw safeFailure("authorization");

    const withRepositoryReadTransport = async <T>(operation: EndpointHumanRepositoryReadOperation<T>): Promise<T> => {
      if (typeof operation !== "function") throw safeFailure("repository-read");
      const boundedTransport: EndpointHumanRepositoryReadTransport = Object.freeze({
        request: async (input: EndpointHumanRepositoryReadRequest): Promise<GitHubNativeHttpResponse> => {
          if (
            !isRecord(input) ||
            input.method !== "GET" ||
            typeof input.hostname !== "string" ||
            input.hostname.toLowerCase() !== hostname ||
            !allowedRepositoryPath(input.path, repository.locator)
          ) {
            throw safeFailure("repository-read");
          }
          try {
            return await provider.request({ hostname, method: "GET", path: input.path });
          } catch {
            throw safeFailure("repository-read");
          }
        },
      });
      try {
        return await operation(boundedTransport);
      } catch (error) {
        if (error instanceof EndpointHumanAuthenticationError) throw error;
        throw safeFailure("repository-read");
      }
    };

    return Object.freeze({
      authenticated: true as const,
      evidence: validated.value,
      withRepositoryReadTransport,
    });
  }
}

export function createEndpointHumanAuthenticator(
  options: EndpointHumanAuthenticatorOptions,
): EndpointHumanAuthenticator {
  return new EndpointHumanAuthenticator(options);
}

export async function authenticateEndpointHuman(
  options: EndpointHumanAuthenticatorOptions,
  request: AuthenticationRequest,
): Promise<EndpointHumanAuthenticationResult> {
  return new EndpointHumanAuthenticator(options).authenticate(request);
}
