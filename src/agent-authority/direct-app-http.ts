/**
 * Stateless direct HTTPS App ingress transport (#377).
 *
 * This module owns HTTP method/path/media-type/body-size/JSON parsing and
 * bounded HTTP response mapping only. It does not verify Session signatures,
 * read Runtime trust, perform capability admission, mint credentials, or
 * implement Change/branch semantics -- all of that remains owned by the
 * frozen #465 `CapabilityAuthorizedSessionExecutor` composition this module
 * delegates to. The 1 MiB HTTP body ceiling enforced here never widens the
 * #373 64 KiB signed semantic-request bound, which the delegated authority
 * continues to enforce on its own.
 */

import type {
  CapabilityAuthorizedSessionExecutionFailure,
  CapabilityAuthorizedSessionExecutionResult,
  CapabilityAuthorizedSessionExecutor,
  CapabilityAuthorizedSessionOperation,
  SessionExecutionPhase,
} from "../session-authorized-change-executor.js";
import type { ChangeDiagnostic } from "../change.js";
import type { ChangeExecutionEvidence } from "../change-execution-port.js";

export const DIRECT_APP_HTTP_CONTRACT_VERSION = 1 as const;
export const DIRECT_APP_EXECUTE_PATH = "/v1/execute" as const;

/** Default HTTP body ceiling. Configuration may only narrow/widen this within the compile-time hard ceiling. */
export const DIRECT_APP_HTTP_DEFAULT_MAX_BODY_BYTES = 1_048_576 as const;

/** Compile-time hard ceiling. No runtime configuration may exceed this bound. */
const DIRECT_APP_HTTP_MAX_BODY_BYTES_CEILING = 8_388_576 as const;

export interface DirectAppHttpHandlerOptions {
  /** The frozen #465 Session-authorized execution composition. */
  readonly executor: CapabilityAuthorizedSessionExecutor;
  /** Bounded downward/upward only within the compile-time hard ceiling. Defaults to 1 MiB. */
  readonly maxBodyBytes?: number;
}

export interface DirectAppHttpErrorBody {
  readonly code: string;
  readonly message: string;
  readonly diagnostics?: readonly ChangeDiagnostic[];
  readonly evidence?: ChangeExecutionEvidence;
}

export interface DirectAppHttpSuccessEnvelope {
  readonly version: typeof DIRECT_APP_HTTP_CONTRACT_VERSION;
  readonly ok: true;
  readonly operation: CapabilityAuthorizedSessionOperation;
  readonly requestId: string;
  readonly result: CapabilityAuthorizedSessionExecutionResult;
}

export interface DirectAppHttpFailureEnvelope {
  readonly version: typeof DIRECT_APP_HTTP_CONTRACT_VERSION;
  readonly ok: false;
  readonly operation?: CapabilityAuthorizedSessionOperation;
  readonly requestId?: string;
  readonly error: DirectAppHttpErrorBody;
}

export type DirectAppHttpResponseEnvelope = DirectAppHttpSuccessEnvelope | DirectAppHttpFailureEnvelope;

const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:[ \t]*;[ \t]*charset=utf-8)?$/iu;

const STATUS_BY_PHASE: Readonly<Record<SessionExecutionPhase, number>> = Object.freeze({
  authentication: 401,
  request: 400,
  authorization: 403,
  evidence: 500,
  execution: 500,
  conflict: 409,
  verification: 500,
  "recovery-required": 409,
});

const ERROR_CODE_BY_PHASE: Readonly<Record<SessionExecutionPhase, string>> = Object.freeze({
  authentication: "SESSION_AUTHENTICATION_FAILED",
  request: "SESSION_REQUEST_INVALID",
  authorization: "SESSION_AUTHORIZATION_DENIED",
  evidence: "SESSION_EVIDENCE_UNAVAILABLE",
  execution: "SESSION_EXECUTION_FAILED",
  conflict: "SESSION_STATE_CONFLICT",
  verification: "SESSION_VERIFICATION_FAILED",
  "recovery-required": "SESSION_RECOVERY_REQUIRED",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExecutor(value: unknown): value is CapabilityAuthorizedSessionExecutor {
  return isRecord(value) && typeof value.execute === "function";
}

function normalizeMaxBodyBytes(value: number | undefined): number {
  if (value === undefined) return DIRECT_APP_HTTP_DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0 || value > DIRECT_APP_HTTP_MAX_BODY_BYTES_CEILING) {
    throw new TypeError(
      `Direct App HTTP handler maxBodyBytes must be a positive integer not exceeding ${DIRECT_APP_HTTP_MAX_BODY_BYTES_CEILING} bytes.`,
    );
  }
  return value;
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && JSON_CONTENT_TYPE_PATTERN.test(value.trim());
}

function jsonResponse(status: number, body: DirectAppHttpResponseEnvelope): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function failureResponse(
  status: number,
  code: string,
  message: string,
  extra: {
    readonly operation?: CapabilityAuthorizedSessionOperation;
    readonly requestId?: string;
    readonly diagnostics?: readonly ChangeDiagnostic[];
    readonly evidence?: ChangeExecutionEvidence;
  } = {},
): Response {
  const body: DirectAppHttpFailureEnvelope = {
    version: DIRECT_APP_HTTP_CONTRACT_VERSION,
    ok: false,
    ...(extra.operation === undefined ? {} : { operation: extra.operation }),
    ...(extra.requestId === undefined ? {} : { requestId: extra.requestId }),
    error: Object.freeze({
      code,
      message,
      ...(extra.diagnostics === undefined || extra.diagnostics.length === 0 ? {} : { diagnostics: extra.diagnostics }),
      ...(extra.evidence === undefined ? {} : { evidence: extra.evidence }),
    }),
  };
  return jsonResponse(status, body);
}

type BoundedBodyResult =
  { readonly kind: "ok"; readonly text: string } | { readonly kind: "too-large" } | { readonly kind: "error" };

async function readBoundedBody(request: Request, maxBodyBytes: number): Promise<BoundedBodyResult> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) return { kind: "too-large" };
  }
  if (request.body === null) return { kind: "ok", text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too-large" };
      }
      chunks.push(next.value);
    }
  } catch {
    return { kind: "error" };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { kind: "ok", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { kind: "error" };
  }
}

function mapExecutionResult(result: CapabilityAuthorizedSessionExecutionResult): Response {
  if (result.status === "succeeded") {
    if (result.operation === undefined || result.provenance === undefined) {
      return failureResponse(500, "INTERNAL_ERROR", "Session execution result is invalid.");
    }
    const body: DirectAppHttpSuccessEnvelope = {
      version: DIRECT_APP_HTTP_CONTRACT_VERSION,
      ok: true,
      operation: result.operation,
      requestId: result.provenance.request.requestId,
      result,
    };
    return jsonResponse(200, body);
  }
  const failure: CapabilityAuthorizedSessionExecutionFailure | undefined = result.failure;
  if (failure === undefined) {
    return failureResponse(500, "INTERNAL_ERROR", "Session execution failed unexpectedly.");
  }
  return failureResponse(STATUS_BY_PHASE[failure.phase], ERROR_CODE_BY_PHASE[failure.phase], failure.message, {
    operation: result.operation,
    requestId: result.provenance?.request.requestId,
    diagnostics: failure.diagnostics,
    evidence: failure.evidence,
  });
}

/** Create a transport-neutral Web `Request -> Response` handler for the frozen #377 wire contract. */
export function createDirectAppHttpHandler(
  options: DirectAppHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  if (!isRecord(options) || !isExecutor(options.executor)) {
    throw new TypeError("Direct App HTTP handler configuration is invalid.");
  }
  const executor = options.executor;
  const maxBodyBytes = normalizeMaxBodyBytes(options.maxBodyBytes);

  return async function handleDirectAppHttpRequest(request: Request): Promise<Response> {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return failureResponse(400, "MALFORMED_REQUEST", "Request URL is invalid.");
    }
    if (pathname !== DIRECT_APP_EXECUTE_PATH) {
      return failureResponse(404, "NOT_FOUND", "The requested path is not implemented by this endpoint.");
    }
    if (request.method !== "POST") {
      return failureResponse(405, "METHOD_NOT_ALLOWED", "Only POST is supported for this endpoint.");
    }
    if (!isJsonContentType(request.headers.get("content-type"))) {
      return failureResponse(415, "UNSUPPORTED_MEDIA_TYPE", "Request content type must be application/json.");
    }

    const bodyResult = await readBoundedBody(request, maxBodyBytes);
    if (bodyResult.kind === "too-large") {
      return failureResponse(413, "PAYLOAD_TOO_LARGE", "Request body exceeds the configured maximum size.");
    }
    if (bodyResult.kind === "error") {
      return failureResponse(400, "MALFORMED_REQUEST", "Request body could not be read.");
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(bodyResult.text);
    } catch {
      return failureResponse(400, "MALFORMED_JSON", "Request body is not valid JSON.");
    }

    let result: CapabilityAuthorizedSessionExecutionResult;
    try {
      result = await executor.execute(envelope);
    } catch {
      return failureResponse(500, "INTERNAL_ERROR", "Session execution failed unexpectedly.");
    }
    return mapExecutionResult(result);
  };
}
