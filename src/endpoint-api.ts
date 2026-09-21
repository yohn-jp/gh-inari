/**
 * Authenticated, transport-neutral Endpoint API for Dashboard consumers.
 *
 * Authentication is an injected transport-owned port.  Endpoint authorization
 * remains the only repository admission boundary; this module only composes
 * that decision with the existing read projections.  It owns no GitHub or
 * mutation semantics.
 */

import {
  authorizeEndpoint,
  validateEndpointAuthorizationEvidence,
  type EndpointAuthorizationEvidence,
  type EndpointAuthorizationRequest,
  type EndpointAuthorizationResult,
  type EndpointCapability,
  type EndpointIdentity,
  type EndpointInstallationIdentity,
  type EndpointPrincipal,
  type EndpointRepositoryIdentity,
  type HumanEndpointPrincipal,
} from "./endpoint-authorization.js";
import {
  projectEndpointRuntimePresence,
  type EndpointRuntimePresenceInput,
  type EndpointRuntimePresenceProjection,
} from "./endpoint-runtime-presence.js";
import {
  tryProjectEndpointWork,
  type EndpointWorkProjection,
  type EndpointWorkProjectionInput,
  type EndpointWorkProjectionResult,
} from "./endpoint-work-projection.js";

export const ENDPOINT_API_CONTRACT_VERSION = 1 as const;
export type EndpointApiContractVersion = typeof ENDPOINT_API_CONTRACT_VERSION;

/** Stable logical read operations. A mutation operation is deliberately absent. */
export const ENDPOINT_API_READ_OPERATIONS = Object.freeze(["repository.read", "work.read", "presence.read"] as const);
export type EndpointApiReadOperation = (typeof ENDPOINT_API_READ_OPERATIONS)[number];
export type EndpointApiOperation = EndpointApiReadOperation | "operation" | (string & {});

export const ENDPOINT_API_OPERATION_PATH = "/v1/endpoint" as const;
export const ENDPOINT_API_LIMITS = Object.freeze({
  diagnostics: 32,
  bodyBytes: 1_048_576,
  operationBytes: 128,
} as const);

export type EndpointApiDiagnosticCode =
  | "ENDPOINT_API_INVALID_REQUEST"
  | "ENDPOINT_API_UNSUPPORTED_VERSION"
  | "ENDPOINT_API_AUTHENTICATION_REQUIRED"
  | "ENDPOINT_API_AUTHENTICATION_FAILED"
  | "ENDPOINT_API_AUTHENTICATION_INVALID"
  | "ENDPOINT_API_AUTHORIZATION_DENIED"
  | "ENDPOINT_API_PROJECTION_UNAVAILABLE"
  | "ENDPOINT_API_PROJECTION_INVALID"
  | "ENDPOINT_API_PROVIDER_FAILED"
  | "ENDPOINT_API_UNSUPPORTED_OPERATION";

export interface EndpointApiDiagnostic {
  readonly code: EndpointApiDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface EndpointApiRequest {
  readonly version: EndpointApiContractVersion;
  readonly operation: EndpointApiOperation;
  readonly endpoint: EndpointIdentity;
  readonly installation: EndpointInstallationIdentity;
  readonly repository: EndpointRepositoryIdentity;
  /** The existing Endpoint capability vocabulary is reused for admission. */
  readonly capability: EndpointCapability;
}

export interface EndpointApiExecutionContext {
  /** Opaque transport evidence; the HTTP adapter supplies the Web Request. */
  readonly transport?: unknown;
  readonly signal?: AbortSignal;
}

export interface EndpointApiAuthenticationRequest {
  readonly version: EndpointApiContractVersion;
  readonly request: EndpointApiRequest;
  readonly transport?: unknown;
  readonly signal?: AbortSignal;
}

export interface EndpointApiAuthenticationSuccess {
  readonly authenticated: true;
  readonly evidence: EndpointAuthorizationEvidence;
}

export interface EndpointApiAuthenticationFailure {
  readonly authenticated: false;
  readonly diagnostics?: readonly EndpointApiDiagnostic[];
}

export type EndpointApiAuthenticationResult = EndpointApiAuthenticationSuccess | EndpointApiAuthenticationFailure;

/** Human authentication is intentionally an injected port owned by a transport. */
export interface EndpointHumanAuthenticationPort {
  authenticate(
    request: EndpointApiAuthenticationRequest,
  ):
    | EndpointApiAuthenticationResult
    | EndpointAuthorizationEvidence
    | Promise<EndpointApiAuthenticationResult | EndpointAuthorizationEvidence | undefined>
    | undefined;
}

export interface EndpointApiProjectionRequest {
  readonly version: EndpointApiContractVersion;
  readonly operation: EndpointApiReadOperation;
  readonly endpoint: EndpointIdentity;
  readonly installation: EndpointInstallationIdentity;
  readonly repository: EndpointRepositoryIdentity;
  readonly principal: HumanEndpointPrincipal;
  readonly authorization: EndpointAuthorizationResult;
  readonly signal?: AbortSignal;
}

export interface EndpointApiAvailableProjection<T> {
  readonly status: "available";
  readonly value: T;
}

export interface EndpointApiUnavailableProjection {
  readonly status: "unavailable";
  readonly diagnostics?: readonly EndpointApiDiagnostic[];
}

export type EndpointApiProjectionResult<T> = EndpointApiAvailableProjection<T> | EndpointApiUnavailableProjection;

export type EndpointApiWorkReader = (
  request: EndpointApiProjectionRequest,
) =>
  | EndpointWorkProjection
  | EndpointWorkProjectionInput
  | EndpointWorkProjectionResult
  | EndpointApiProjectionResult<EndpointWorkProjection | EndpointWorkProjectionInput>
  | Promise<
      | EndpointWorkProjection
      | EndpointWorkProjectionInput
      | EndpointWorkProjectionResult
      | EndpointApiProjectionResult<EndpointWorkProjection | EndpointWorkProjectionInput>
    >;

export type EndpointApiPresenceReader = (
  request: EndpointApiProjectionRequest,
) =>
  | EndpointRuntimePresenceProjection
  | EndpointRuntimePresenceInput
  | EndpointApiProjectionResult<EndpointRuntimePresenceProjection | EndpointRuntimePresenceInput>
  | Promise<
      | EndpointRuntimePresenceProjection
      | EndpointRuntimePresenceInput
      | EndpointApiProjectionResult<EndpointRuntimePresenceProjection | EndpointRuntimePresenceInput>
    >;

export interface EndpointApiOptions {
  readonly authentication?: EndpointHumanAuthenticationPort;
  /** Alias accepted by adapters that name the port as an authenticator. */
  readonly authenticator?: EndpointHumanAuthenticationPort;
  readonly readWork?: EndpointApiWorkReader;
  readonly readPresence?: EndpointApiPresenceReader;
  /** Convenience aliases for composition adapters. */
  readonly work?: EndpointApiWorkReader;
  readonly presence?: EndpointApiPresenceReader;
}

export interface EndpointApiUnavailableRead {
  readonly resource: "work" | "presence";
  readonly diagnostics: readonly EndpointApiDiagnostic[];
}

export interface EndpointApiReadData {
  readonly repository: EndpointRepositoryIdentity;
  readonly work?: EndpointWorkProjection;
  readonly presence?: EndpointRuntimePresenceProjection;
  readonly unavailable: readonly EndpointApiUnavailableRead[];
}

export interface EndpointApiSuccess {
  readonly version: EndpointApiContractVersion;
  readonly ok: true;
  readonly operation: EndpointApiOperation;
  readonly authorization: EndpointAuthorizationResult;
  readonly data: EndpointApiReadData;
}

export interface EndpointApiFailure {
  readonly version: EndpointApiContractVersion;
  readonly ok: false;
  readonly operation?: EndpointApiOperation;
  readonly authorization?: EndpointAuthorizationResult;
  readonly error: {
    readonly code: EndpointApiDiagnosticCode;
    readonly message: string;
    readonly diagnostics: readonly EndpointApiDiagnostic[];
  };
}

export type EndpointApiResult = EndpointApiSuccess | EndpointApiFailure;

export interface EndpointApi {
  execute(request: unknown, context?: EndpointApiExecutionContext): Promise<EndpointApiResult>;
}

function freezeDiagnostics(diagnostics: readonly EndpointApiDiagnostic[]): readonly EndpointApiDiagnostic[] {
  return Object.freeze(
    diagnostics.slice(0, ENDPOINT_API_LIMITS.diagnostics).map((entry) => Object.freeze({ ...entry })),
  );
}

function diagnostic(code: EndpointApiDiagnosticCode, path: string, message: string): EndpointApiDiagnostic {
  return Object.freeze({ code, path, message });
}

function failure(
  code: EndpointApiDiagnosticCode,
  message: string,
  path = "$",
  operation?: EndpointApiOperation,
  authorization?: EndpointAuthorizationResult,
  diagnostics: readonly EndpointApiDiagnostic[] = [],
): EndpointApiFailure {
  const all = freezeDiagnostics([diagnostic(code, path, message), ...diagnostics]);
  return Object.freeze({
    version: ENDPOINT_API_CONTRACT_VERSION,
    ok: false as const,
    ...(operation === undefined ? {} : { operation }),
    ...(authorization === undefined ? {} : { authorization }),
    error: Object.freeze({ code, message, diagnostics: all }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameEndpoint(left: EndpointIdentity, right: EndpointIdentity): boolean {
  return left.id === right.id && left.deployment === right.deployment;
}

function sameInstallation(left: EndpointInstallationIdentity, right: EndpointInstallationIdentity): boolean {
  return left.endpointId === right.endpointId && left.installationId === right.installationId;
}

function sameRepository(left: EndpointRepositoryIdentity, right: EndpointRepositoryIdentity): boolean {
  return (
    left.endpointId === right.endpointId &&
    left.installationId === right.installationId &&
    left.repositoryHost === right.repositoryHost &&
    left.repositoryId === right.repositoryId
  );
}

function normalizeRequest(value: unknown): EndpointApiRequest | EndpointApiFailure {
  if (!isRecord(value)) return failure("ENDPOINT_API_INVALID_REQUEST", "Request must be a plain object.");
  const allowed = new Set(["version", "operation", "endpoint", "installation", "repository", "capability"]);
  const unknown = Reflect.ownKeys(value).find((key) => typeof key !== "string" || !allowed.has(key));
  if (unknown !== undefined)
    return failure("ENDPOINT_API_INVALID_REQUEST", "Request contains an unknown property.", `$.${String(unknown)}`);
  if (value.version !== ENDPOINT_API_CONTRACT_VERSION)
    return failure("ENDPOINT_API_UNSUPPORTED_VERSION", "Endpoint API request version is unsupported.", "$.version");
  if (
    typeof value.operation !== "string" ||
    value.operation.length === 0 ||
    value.operation.length > ENDPOINT_API_LIMITS.operationBytes
  )
    return failure("ENDPOINT_API_INVALID_REQUEST", "Request operation is invalid.", "$.operation");
  if (!Object.prototype.hasOwnProperty.call(value, "endpoint"))
    return failure("ENDPOINT_API_INVALID_REQUEST", "Request endpoint is required.", "$.endpoint");
  if (!Object.prototype.hasOwnProperty.call(value, "installation"))
    return failure("ENDPOINT_API_INVALID_REQUEST", "Request installation is required.", "$.installation");
  if (!Object.prototype.hasOwnProperty.call(value, "repository"))
    return failure("ENDPOINT_API_INVALID_REQUEST", "Request repository is required.", "$.repository");
  if (!Object.prototype.hasOwnProperty.call(value, "capability"))
    return failure("ENDPOINT_API_INVALID_REQUEST", "Request capability is required.", "$.capability");
  return value as unknown as EndpointApiRequest;
}

function authenticationEvidence(
  value: unknown,
):
  | { readonly kind: "authenticated"; readonly evidence: EndpointAuthorizationEvidence }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly diagnostics: readonly EndpointApiDiagnostic[] }
  | { readonly kind: "invalid"; readonly diagnostics: readonly EndpointApiDiagnostic[] } {
  if (value === undefined || value === null) return { kind: "missing" };
  if (isRecord(value) && value.authenticated === false) {
    return {
      kind: "failed",
      diagnostics: freezeDiagnostics(
        Array.isArray(value.diagnostics)
          ? (value.diagnostics as readonly EndpointApiDiagnostic[])
          : [diagnostic("ENDPOINT_API_AUTHENTICATION_FAILED", "$.authentication", "Human authentication failed.")],
      ),
    };
  }
  const rawEvidence = isRecord(value) && value.authenticated === true && "evidence" in value ? value.evidence : value;
  const validation = validateEndpointAuthorizationEvidence(rawEvidence, "$.authentication.evidence");
  if (!validation.valid || validation.value === undefined) {
    return {
      kind: "invalid",
      diagnostics: freezeDiagnostics(
        validation.diagnostics.map((entry) =>
          diagnostic("ENDPOINT_API_AUTHENTICATION_INVALID", entry.path, entry.message),
        ),
      ),
    };
  }
  if (validation.value.principal.kind !== "human") {
    return {
      kind: "invalid",
      diagnostics: freezeDiagnostics([
        diagnostic(
          "ENDPOINT_API_AUTHENTICATION_INVALID",
          "$.authentication.evidence.principal.kind",
          "Dashboard API authentication must produce a human Endpoint principal.",
        ),
      ]),
    };
  }
  return { kind: "authenticated", evidence: validation.value };
}

function normalizeWork(
  value: unknown,
):
  | { readonly kind: "available"; readonly value: EndpointWorkProjection }
  | { readonly kind: "unavailable"; readonly diagnostics: readonly EndpointApiDiagnostic[] }
  | { readonly kind: "invalid"; readonly diagnostics: readonly EndpointApiDiagnostic[] } {
  if (isRecord(value) && value.status === "unavailable") {
    return {
      kind: "unavailable",
      diagnostics: freezeDiagnostics(
        Array.isArray(value.diagnostics)
          ? (value.diagnostics as readonly EndpointApiDiagnostic[])
          : [diagnostic("ENDPOINT_API_PROJECTION_UNAVAILABLE", "$.work", "Work projection is unavailable.")],
      ),
    };
  }
  let candidate = value;
  if (isRecord(value) && value.status === "available" && "value" in value) candidate = value.value;
  if (isRecord(candidate) && typeof candidate.valid === "boolean" && "projection" in candidate) {
    const result = candidate as unknown as EndpointWorkProjectionResult;
    if (!result.valid || result.projection === undefined) {
      return {
        kind: "invalid",
        diagnostics: freezeDiagnostics(
          result.diagnostics.map((entry) => diagnostic("ENDPOINT_API_PROJECTION_INVALID", entry.path, entry.message)),
        ),
      };
    }
    candidate = result.projection;
  } else if (isRecord(candidate) && candidate.kind !== "endpoint-work") {
    const result = tryProjectEndpointWork(candidate);
    if (!result.valid || result.projection === undefined) {
      return {
        kind: "invalid",
        diagnostics: freezeDiagnostics(
          result.diagnostics.map((entry) => diagnostic("ENDPOINT_API_PROJECTION_INVALID", entry.path, entry.message)),
        ),
      };
    }
    candidate = result.projection;
  }
  if (!isRecord(candidate) || candidate.kind !== "endpoint-work" || candidate.version !== 1) {
    return {
      kind: "invalid",
      diagnostics: freezeDiagnostics([
        diagnostic("ENDPOINT_API_PROJECTION_INVALID", "$.work", "Work projection does not satisfy the #920 contract."),
      ]),
    };
  }
  return { kind: "available", value: candidate as unknown as EndpointWorkProjection };
}

function normalizePresence(
  value: unknown,
):
  | { readonly kind: "available"; readonly value: EndpointRuntimePresenceProjection }
  | { readonly kind: "unavailable"; readonly diagnostics: readonly EndpointApiDiagnostic[] }
  | { readonly kind: "invalid"; readonly diagnostics: readonly EndpointApiDiagnostic[] } {
  if (isRecord(value) && value.status === "unavailable") {
    return {
      kind: "unavailable",
      diagnostics: freezeDiagnostics(
        Array.isArray(value.diagnostics)
          ? (value.diagnostics as readonly EndpointApiDiagnostic[])
          : [diagnostic("ENDPOINT_API_PROJECTION_UNAVAILABLE", "$.presence", "Runtime presence is unavailable.")],
      ),
    };
  }
  let candidate = value;
  if (isRecord(value) && value.status === "available" && "value" in value) candidate = value.value;
  if (isRecord(candidate) && "relay" in candidate && "endpoint" in candidate && "repository" in candidate) {
    try {
      candidate = projectEndpointRuntimePresence(candidate as unknown as EndpointRuntimePresenceInput);
    } catch (error) {
      return {
        kind: "invalid",
        diagnostics: freezeDiagnostics([
          diagnostic(
            "ENDPOINT_API_PROJECTION_INVALID",
            "$.presence",
            error instanceof Error ? error.message : "Presence projection is invalid.",
          ),
        ]),
      };
    }
  }
  if (
    !isRecord(candidate) ||
    candidate.version !== 1 ||
    candidate.authoritative !== false ||
    typeof candidate.state !== "string"
  ) {
    return {
      kind: "invalid",
      diagnostics: freezeDiagnostics([
        diagnostic(
          "ENDPOINT_API_PROJECTION_INVALID",
          "$.presence",
          "Presence projection does not satisfy the #921 contract.",
        ),
      ]),
    };
  }
  return { kind: "available", value: candidate as unknown as EndpointRuntimePresenceProjection };
}

function contextMatches(
  request: EndpointApiRequest,
  work: EndpointWorkProjection | undefined,
  presence: EndpointRuntimePresenceProjection | undefined,
): boolean {
  if (work !== undefined) {
    if (
      work.repository.repositoryHost !== request.repository.repositoryHost ||
      work.repository.repositoryId !== request.repository.repositoryId ||
      (work.repository.endpointId !== undefined && work.repository.endpointId !== request.endpoint.id) ||
      (work.repository.installationId !== undefined &&
        work.repository.installationId !== request.installation.installationId)
    )
      return false;
  }
  if (presence !== undefined) {
    if (
      !sameEndpoint(presence.endpoint, request.endpoint) ||
      presence.repository.endpointId !== request.installation.endpointId ||
      presence.repository.installationId !== request.installation.installationId ||
      !sameRepository(presence.repository, request.repository)
    )
      return false;
  }
  return true;
}

function isReadOperation(operation: string): operation is EndpointApiReadOperation {
  return (ENDPOINT_API_READ_OPERATIONS as readonly string[]).includes(operation);
}

function projectionRequest(
  request: EndpointApiRequest,
  principal: HumanEndpointPrincipal,
  authorization: EndpointAuthorizationResult,
  operation: EndpointApiReadOperation,
  signal?: AbortSignal,
): EndpointApiProjectionRequest {
  return Object.freeze({
    version: ENDPOINT_API_CONTRACT_VERSION,
    operation,
    endpoint: request.endpoint,
    installation: request.installation,
    repository: request.repository,
    principal,
    authorization,
    ...(signal === undefined ? {} : { signal }),
  });
}

async function readWork(
  reader: EndpointApiWorkReader | undefined,
  context: EndpointApiProjectionRequest,
): Promise<ReturnType<typeof normalizeWork>> {
  if (reader === undefined) {
    return {
      kind: "unavailable",
      diagnostics: freezeDiagnostics([
        diagnostic("ENDPOINT_API_PROJECTION_UNAVAILABLE", "$.work", "Work projection reader is unavailable."),
      ]),
    };
  }
  try {
    return normalizeWork(await reader(context));
  } catch (error) {
    return {
      kind: "unavailable",
      diagnostics: freezeDiagnostics([
        diagnostic(
          "ENDPOINT_API_PROVIDER_FAILED",
          "$.work",
          error instanceof Error ? error.message : "Work projection reader failed closed.",
        ),
      ]),
    };
  }
}

async function readPresence(
  reader: EndpointApiPresenceReader | undefined,
  context: EndpointApiProjectionRequest,
): Promise<ReturnType<typeof normalizePresence>> {
  if (reader === undefined) {
    return {
      kind: "unavailable",
      diagnostics: freezeDiagnostics([
        diagnostic("ENDPOINT_API_PROJECTION_UNAVAILABLE", "$.presence", "Runtime presence reader is unavailable."),
      ]),
    };
  }
  try {
    return normalizePresence(await reader(context));
  } catch (error) {
    return {
      kind: "unavailable",
      diagnostics: freezeDiagnostics([
        diagnostic(
          "ENDPOINT_API_PROVIDER_FAILED",
          "$.presence",
          error instanceof Error ? error.message : "Runtime presence reader failed closed.",
        ),
      ]),
    };
  }
}

/** Create the shared/self-hosted logical API composition. */
export function createEndpointApi(options: EndpointApiOptions): EndpointApi {
  if (options === null || typeof options !== "object" || Array.isArray(options))
    throw new TypeError("Endpoint API options are invalid.");
  const configured = options as EndpointApiOptions;
  const authentication = configured.authentication ?? configured.authenticator;
  if (authentication === undefined || typeof authentication.authenticate !== "function") {
    throw new TypeError("Endpoint API requires a human authentication port.");
  }
  const workReader = configured.readWork ?? configured.work;
  const presenceReader = configured.readPresence ?? configured.presence;
  return Object.freeze({
    async execute(rawRequest: unknown, context: EndpointApiExecutionContext = {}): Promise<EndpointApiResult> {
      const normalized = normalizeRequest(rawRequest);
      if ("ok" in normalized) return normalized;
      const request: EndpointApiRequest = normalized;
      let rawAuthentication: unknown;
      try {
        rawAuthentication = await authentication.authenticate({
          version: ENDPOINT_API_CONTRACT_VERSION,
          request,
          transport: context.transport,
          signal: context.signal,
        });
      } catch (error) {
        return failure(
          "ENDPOINT_API_AUTHENTICATION_FAILED",
          error instanceof Error ? error.message : "Human authentication failed closed.",
          "$.authentication",
          request.operation,
        );
      }
      const auth = authenticationEvidence(rawAuthentication);
      if (auth.kind === "missing")
        return failure(
          "ENDPOINT_API_AUTHENTICATION_REQUIRED",
          "An authenticated human Endpoint principal is required.",
          "$.authentication",
          request.operation,
        );
      if (auth.kind === "failed")
        return failure(
          "ENDPOINT_API_AUTHENTICATION_FAILED",
          "Human authentication failed.",
          "$.authentication",
          request.operation,
          undefined,
          auth.diagnostics,
        );
      if (auth.kind === "invalid")
        return failure(
          "ENDPOINT_API_AUTHENTICATION_INVALID",
          "Human authentication returned invalid Endpoint evidence.",
          "$.authentication",
          request.operation,
          undefined,
          auth.diagnostics,
        );
      const evidence = auth.evidence;
      const authorizationRequest: EndpointAuthorizationRequest = {
        version: ENDPOINT_API_CONTRACT_VERSION,
        principal: evidence.principal,
        endpoint: request.endpoint,
        installation: request.installation,
        repository: request.repository,
        capability: request.capability,
        evidence,
      };
      const authorization = authorizeEndpoint(authorizationRequest);
      if (!authorization.allowed)
        return failure(
          "ENDPOINT_API_AUTHORIZATION_DENIED",
          "Endpoint authorization denied the repository-scoped request.",
          "$.authorization",
          request.operation,
          authorization,
          authorization.diagnostics.map((entry) =>
            diagnostic("ENDPOINT_API_AUTHORIZATION_DENIED", entry.path, entry.message),
          ),
        );
      if (!isReadOperation(request.operation))
        return failure(
          "ENDPOINT_API_UNSUPPORTED_OPERATION",
          "The requested Endpoint operation is not supported.",
          "$.operation",
          request.operation,
          authorization,
        );
      const principal = evidence.principal as HumanEndpointPrincipal;
      const data: {
        repository: EndpointRepositoryIdentity;
        work?: EndpointWorkProjection;
        presence?: EndpointRuntimePresenceProjection;
        unavailable: EndpointApiUnavailableRead[];
      } = { repository: request.repository, unavailable: [] };
      const needWork = request.operation === "repository.read" || request.operation === "work.read";
      const needPresence = request.operation === "repository.read" || request.operation === "presence.read";
      if (needWork) {
        const result = await readWork(
          workReader,
          projectionRequest(request, principal, authorization, "work.read", context.signal),
        );
        if (result.kind === "available") data.work = result.value;
        else if (result.kind === "unavailable")
          data.unavailable.push({ resource: "work", diagnostics: result.diagnostics });
        else
          return failure(
            "ENDPOINT_API_PROJECTION_INVALID",
            "Work projection is invalid.",
            "$.work",
            request.operation,
            authorization,
            result.diagnostics,
          );
      }
      if (needPresence) {
        const result = await readPresence(
          presenceReader,
          projectionRequest(request, principal, authorization, "presence.read", context.signal),
        );
        if (result.kind === "available") data.presence = result.value;
        else if (result.kind === "unavailable")
          data.unavailable.push({ resource: "presence", diagnostics: result.diagnostics });
        else
          return failure(
            "ENDPOINT_API_PROJECTION_INVALID",
            "Runtime presence projection is invalid.",
            "$.presence",
            request.operation,
            authorization,
            result.diagnostics,
          );
      }
      if (!contextMatches(request, data.work, data.presence)) {
        return failure(
          "ENDPOINT_API_PROJECTION_INVALID",
          "Projection identity does not match the authorized repository context.",
          "$.data",
          request.operation,
          authorization,
        );
      }
      return Object.freeze({
        version: ENDPOINT_API_CONTRACT_VERSION,
        ok: true as const,
        operation: request.operation,
        authorization,
        data: Object.freeze({
          repository: request.repository,
          ...(data.work === undefined ? {} : { work: data.work }),
          ...(data.presence === undefined ? {} : { presence: data.presence }),
          unavailable: Object.freeze(
            data.unavailable.map((entry) =>
              Object.freeze({
                resource: entry.resource,
                diagnostics: freezeDiagnostics(entry.diagnostics),
              }),
            ),
          ),
        }),
      });
    },
  });
}

/** Execute one request without retaining API composition state. */
export async function executeEndpointApi(
  api: EndpointApi,
  request: unknown,
  context?: EndpointApiExecutionContext,
): Promise<EndpointApiResult> {
  if (!isRecord(api) || typeof api.execute !== "function")
    return failure("ENDPOINT_API_INVALID_REQUEST", "Endpoint API executor is invalid.");
  try {
    return await api.execute(request, context);
  } catch {
    return failure("ENDPOINT_API_PROVIDER_FAILED", "Endpoint API execution failed closed.");
  }
}
