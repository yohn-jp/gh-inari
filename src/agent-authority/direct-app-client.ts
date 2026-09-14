/**
 * Installed-CLI client for the frozen #377 direct App HTTP transport (#467).
 *
 * This module owns only: loading an explicit Session credential bundle into
 * a signing seam, enforcing the HTTPS/localhost and #373 64 KiB bounded
 * request constraints before any network send, compiling and signing the
 * exact canonical #373 request envelope, and mapping the #377 bounded
 * response envelope back onto the existing `ChangeExecutionPort` boundary
 * or the #466 `branch.advance` result. It does not reimplement Session
 * authentication, capability admission, Change lifecycle, or branch/Git
 * mutation authority -- all of that remains owned by the App path.
 */

import { sign as ed25519Sign, type KeyObject } from "node:crypto";
import {
  ChangeExecutionPortError,
  normalizeChangeExecutionResult,
  normalizeChangeProjection,
  validateChangeRequest,
  type ChangeExecutionPort,
  type ChangeMutationRequest,
  type ChangeReadRequest,
} from "../change-execution-port.js";
import {
  canonicalizeSemanticRequest,
  MAX_SESSION_REQUEST_BYTES,
  signSessionRequest,
  type SemanticSessionRequest,
  type SessionRequestJsonValue,
} from "./session-request.js";
import type { ManagedSession, ManagedSessionCertificate } from "./session-issuance.js";
import {
  loadSessionCredentialBundle,
  type ParsedSessionCredentialBundle,
  type SessionAgentMetadata,
} from "./session-bundle.js";
import {
  DIRECT_APP_EXECUTE_PATH,
  type DirectAppHttpFailureEnvelope,
  type DirectAppHttpResponseEnvelope,
} from "./direct-app-http.js";
import type { BranchAdvanceSemanticRequest, BranchAdvanceSemanticResult } from "./branch-advance.js";

const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The exact value crossing this boundary is always the caller's own
 * JSON-serializable request/plan/agent data; the seam is unsafe only in the
 * type system, not at runtime (`signSessionRequest` canonicalizes it through
 * the same JCS pass regardless).
 */
function asJson(value: unknown): SessionRequestJsonValue {
  return value as SessionRequestJsonValue;
}

export type DirectAppClientErrorCode =
  | "SESSION_CREDENTIAL_INVALID"
  | "APP_ENDPOINT_INVALID"
  | "APP_REQUEST_TOO_LARGE"
  | "APP_TRANSPORT_FAILED"
  | "APP_EXECUTION_FAILED";

/** Secret-safe error: never carries private-key material or raw HTTP bodies. */
export class DirectAppClientError extends Error {
  readonly code: DirectAppClientErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: DirectAppClientErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "DirectAppClientError";
    this.code = code;
    this.details = details;
  }
}

/** Load the explicit Session credential bundle file and wrap it as a signing-only ManagedSession. */
export function loadDirectAppSession(filePath: string): {
  readonly session: ManagedSession;
  readonly agent?: SessionAgentMetadata;
} {
  let parsed: ParsedSessionCredentialBundle;
  try {
    parsed = loadSessionCredentialBundle(filePath);
  } catch (error: unknown) {
    throw new DirectAppClientError(
      "SESSION_CREDENTIAL_INVALID",
      error instanceof Error ? error.message : "Session credential bundle could not be loaded.",
    );
  }
  return {
    session: bundleManagedSession(parsed),
    ...(parsed.bundle.agent === undefined ? {} : { agent: parsed.bundle.agent }),
  };
}

function bundleManagedSession(parsed: ParsedSessionCredentialBundle): ManagedSession {
  const privateKey: KeyObject = parsed.privateKey;
  const certificate = parsed.certificate;
  const sessionId = certificate.payload.sub.replace(/^session:/u, "");
  const notSupported = (): never => {
    throw new DirectAppClientError(
      "SESSION_CREDENTIAL_INVALID",
      "This Session credential is a signing-only client bundle; it cannot issue or accept a new certificate.",
    );
  };
  const session: ManagedSession = {
    sessionId,
    publicKey: certificate.payload.sessionKey,
    certificate,
    sign: (bytes: Uint8Array) => Uint8Array.from(ed25519Sign(null, bytes, privateKey)),
    createIssuanceRequest: () => notSupported(),
    acceptCertificate: () => notSupported(),
  };
  return Object.freeze(session) as ManagedSession;
}

/** HTTPS is required except an explicit localhost development fixture; fails closed otherwise. */
export function resolveAppEndpoint(rawEndpoint: string): URL {
  let url: URL;
  try {
    url = new URL(rawEndpoint);
  } catch {
    throw new DirectAppClientError("APP_ENDPOINT_INVALID", `App endpoint "${rawEndpoint}" is not a valid URL.`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOCALHOST_HOSTNAMES.has(url.hostname)) return url;
  throw new DirectAppClientError(
    "APP_ENDPOINT_INVALID",
    "App endpoint must be HTTPS, except an explicit http://localhost development fixture.",
  );
}

/** Enforce the #373 64 KiB signed semantic-request bound locally before any network send. */
export function assertBoundedSemanticRequest(request: SemanticSessionRequest): void {
  let canonical: string;
  try {
    canonical = canonicalizeSemanticRequest(request);
  } catch (error: unknown) {
    throw new DirectAppClientError(
      "APP_REQUEST_TOO_LARGE",
      error instanceof Error ? error.message : "Semantic request exceeds the bounded request size.",
      { limit: MAX_SESSION_REQUEST_BYTES },
    );
  }
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > MAX_SESSION_REQUEST_BYTES) {
    throw new DirectAppClientError(
      "APP_REQUEST_TOO_LARGE",
      `Semantic request is ${bytes} bytes, exceeding the ${MAX_SESSION_REQUEST_BYTES} byte bound.`,
      { bytes, limit: MAX_SESSION_REQUEST_BYTES },
    );
  }
}

export interface DirectAppRequestOptions {
  readonly endpoint: URL;
  readonly session: ManagedSession;
  readonly certificate?: ManagedSessionCertificate;
  readonly operation: string;
  readonly request: SemanticSessionRequest;
  readonly agent?: SessionAgentMetadata;
  readonly now?: () => number;
  readonly requestId?: () => string;
  readonly fetchImpl?: typeof fetch;
}

let sequentialCounter = 0;
function defaultRequestId(): string {
  sequentialCounter = (sequentialCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${sequentialCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const REQUEST_TTL_SECONDS = 120;

/** Sign and submit one canonical #373 semantic request to the frozen #377 wire endpoint. */
export async function sendDirectAppRequest(options: DirectAppRequestOptions): Promise<DirectAppHttpResponseEnvelope> {
  assertBoundedSemanticRequest(options.request);
  const issuedAt = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const envelope = signSessionRequest({
    session: options.session,
    ...(options.certificate === undefined ? {} : { certificate: options.certificate }),
    request: options.request,
    operation: options.operation,
    requestId: (options.requestId ?? defaultRequestId)(),
    issuedAt,
    expiresAt: issuedAt + REQUEST_TTL_SECONDS,
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(DIRECT_APP_EXECUTE_PATH, options.endpoint);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
  } catch (error: unknown) {
    throw new DirectAppClientError(
      "APP_TRANSPORT_FAILED",
      error instanceof Error ? error.message : "The direct App endpoint could not be reached.",
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DirectAppClientError(
      "APP_TRANSPORT_FAILED",
      "The direct App endpoint returned an invalid response body.",
    );
  }
  if (!isResponseEnvelope(body)) {
    throw new DirectAppClientError(
      "APP_TRANSPORT_FAILED",
      "The direct App endpoint returned an unrecognized response.",
    );
  }
  return body;
}

function isResponseEnvelope(value: unknown): value is DirectAppHttpResponseEnvelope {
  return (
    typeof value === "object" && value !== null && "ok" in value && typeof (value as { ok: unknown }).ok === "boolean"
  );
}

function executorError(envelope: DirectAppHttpFailureEnvelope, operation: string): ChangeExecutionPortError {
  return new ChangeExecutionPortError(
    "CHANGE_REMOTE_RUN_FAILED",
    envelope.error.message,
    { operation, code: envelope.error.code },
    envelope.error.diagnostics,
  );
}

export interface DirectAppChangeExecutionAdapterOptions {
  readonly endpoint: URL;
  readonly session: ManagedSession;
  readonly agent?: SessionAgentMetadata;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly requestId?: () => string;
}

/** Direct-App transport adapter for the canonical `ChangeExecutionPort` (#467). */
export function createDirectAppChangeExecutionAdapter(
  options: DirectAppChangeExecutionAdapterOptions,
): ChangeExecutionPort {
  const send = (operation: string, request: SemanticSessionRequest) =>
    sendDirectAppRequest({
      endpoint: options.endpoint,
      session: options.session,
      operation,
      request,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    });

  return {
    async execute(request: ChangeMutationRequest) {
      validateChangeRequest(request);
      const operation = `change.${request.operation}`;
      const semanticRequest: SemanticSessionRequest = {
        version: 1,
        issue: request.issue,
        ...(request.semanticPullRequestPlan === undefined
          ? {}
          : { semanticPullRequestPlan: asJson(request.semanticPullRequestPlan) }),
        ...(request.signedProvenanceRecord === undefined
          ? {}
          : { signedProvenanceRecord: asJson(request.signedProvenanceRecord) }),
        ...(options.agent === undefined ? {} : { agent: asJson(options.agent) }),
      };
      const response = await send(operation, semanticRequest);
      if (!response.ok) throw executorError(response, operation);
      const result = response.result;
      if (result.execution === undefined) {
        throw new ChangeExecutionPortError(
          "CHANGE_REMOTE_RESULT_INVALID",
          "The direct App returned no execution result.",
          {
            operation,
          },
        );
      }
      return normalizeChangeExecutionResult(request.operation, result.execution);
    },
    async read(request: ChangeReadRequest) {
      validateChangeRequest(request);
      const operation = "change.show";
      const semanticRequest: SemanticSessionRequest = {
        version: 1,
        issue: request.issue,
        ...(options.agent === undefined ? {} : { agent: asJson(options.agent) }),
      };
      const response = await send(operation, semanticRequest);
      if (!response.ok) throw executorError(response, operation);
      const result = response.result;
      if (result.projection === undefined) {
        throw new ChangeExecutionPortError(
          "CHANGE_REMOTE_RESULT_INVALID",
          "The direct App returned no Change projection.",
          {
            operation,
          },
        );
      }
      return normalizeChangeProjection("show", result.projection);
    },
  };
}

/** @deprecated Use `DirectAppChangeExecutionAdapterOptions`. */
export type DirectAppChangeExecutorOptions = DirectAppChangeExecutionAdapterOptions;
/** @deprecated Use `createDirectAppChangeExecutionAdapter`. */
export const createDirectAppChangeRemoteExecutor = createDirectAppChangeExecutionAdapter;

export type BranchAdvanceClientErrorCode = "BRANCH_ADVANCE_TRANSPORT_FAILED" | "BRANCH_ADVANCE_REJECTED";

export class BranchAdvanceClientError extends Error {
  readonly code: BranchAdvanceClientErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: BranchAdvanceClientErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "BranchAdvanceClientError";
    this.code = code;
    this.details = details;
  }
}

export interface SendBranchAdvanceOptions {
  readonly endpoint: URL;
  readonly session: ManagedSession;
  /** #466's `BranchAdvanceSemanticRequest`; include `agent` in the request itself when desired. */
  readonly request: BranchAdvanceSemanticRequest;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly requestId?: () => string;
}

/** Sign and submit the exact canonical #466 `branch.advance` request compiled by `change publish` (#467). */
export async function sendDirectAppBranchAdvance(
  options: SendBranchAdvanceOptions,
): Promise<BranchAdvanceSemanticResult> {
  const semanticRequest = asJson(options.request) as SemanticSessionRequest;
  const response = await sendDirectAppRequest({
    endpoint: options.endpoint,
    session: options.session,
    operation: "branch.advance",
    request: semanticRequest,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  });
  if (!response.ok) {
    throw new BranchAdvanceClientError("BRANCH_ADVANCE_REJECTED", response.error.message, {
      code: response.error.code,
      diagnostics: response.error.diagnostics,
    });
  }
  const branchAdvance = response.result.branchAdvance;
  if (branchAdvance === undefined) {
    throw new BranchAdvanceClientError(
      "BRANCH_ADVANCE_TRANSPORT_FAILED",
      "The direct App returned no branch.advance result.",
    );
  }
  return branchAdvance;
}
