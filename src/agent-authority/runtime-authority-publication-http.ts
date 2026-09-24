/**
 * Stateless HTTP ingress for the centrally custodied Runtime Authority
 * publisher (#1066 correction).
 *
 * This module owns HTTP method/path/media-type/body-size/bearer-token/JSON
 * parsing and bounded HTTP response mapping only. It never verifies a
 * Session, mints a credential, or performs the publication mutation itself
 * -- all of that remains owned by the injected publisher (see
 * `../github/direct-app-execution.js`'s `createDirectAppRuntimeAuthorityPublisher`).
 *
 * Unlike the frozen #377 `/v1/execute` transport, this endpoint intentionally
 * accepts no signed Session: Runtime Authority publication bootstraps the
 * very trust root a Session would be verified against, so there is nothing
 * to verify it against yet. It still requires an authenticated caller,
 * though: this transport requires a bearer token on every request and hands
 * it, opaque, to the injected publisher, which is the existing
 * App-user/human installation+repository authorization seam (the same one
 * `repository-setup.ts` already uses) -- proving the caller can read the
 * publisher's exact configured target repository -- never a substitute for
 * it. Only the validated public Runtime Authority request and this caller
 * proof cross the boundary; every other guarantee (single-file artifact,
 * exact repository identity, fail-closed duplicate/race handling, no
 * auto-merge/approval) is enforced by Core (`../runtime-authority-publication.js`)
 * and the publisher's fixed deployment-configured target repository, not by
 * this transport.
 */

import type { RuntimeAuthorityPublicationResult } from "../runtime-authority-publication.js";
import { RuntimeAuthorityPublicationUnauthorizedError } from "../github/direct-app-execution.js";

export const RUNTIME_AUTHORITY_PUBLICATION_HTTP_CONTRACT_VERSION = 1 as const;
export const RUNTIME_AUTHORITY_PUBLICATION_HTTP_PATH = "/v1/runtime-authority/publish" as const;

/** Transport ceiling; Core additionally enforces its own bounded request size. */
const MAX_BODY_BYTES = 131_072;
const MAX_TOKEN_LENGTH = 4_096;
const BEARER_AUTHORIZATION_PATTERN = /^Bearer[ \t]+(\S+)$/u;

/**
 * Publishes only the validated public Runtime Authority record for one
 * bearer-authorized caller; never accepts private-key material. The
 * publisher owns verifying that `callerToken` is authorized for its exact
 * configured target repository -- this transport only extracts it.
 */
export interface RuntimeAuthorityPublicationPublisher {
  publish(request: unknown, callerToken: string): Promise<RuntimeAuthorityPublicationResult>;
}

export interface RuntimeAuthorityPublicationHttpHandlerOptions {
  readonly publisher: RuntimeAuthorityPublicationPublisher;
  readonly maxBodyBytes?: number;
}

interface SuccessEnvelope {
  readonly version: typeof RUNTIME_AUTHORITY_PUBLICATION_HTTP_CONTRACT_VERSION;
  readonly ok: true;
  readonly result: RuntimeAuthorityPublicationResult;
}

interface FailureEnvelope {
  readonly version: typeof RUNTIME_AUTHORITY_PUBLICATION_HTTP_CONTRACT_VERSION;
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:[ \t]*;[ \t]*charset=utf-8)?$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPublisher(value: unknown): value is RuntimeAuthorityPublicationPublisher {
  return isRecord(value) && typeof value.publish === "function";
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && JSON_CONTENT_TYPE_PATTERN.test(value.trim());
}

function extractBearerToken(value: string | null): string | undefined {
  if (value === null) return undefined;
  const match = BEARER_AUTHORIZATION_PATTERN.exec(value);
  const token = match?.[1];
  if (
    token === undefined ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(token)
  ) {
    return undefined;
  }
  return token;
}

function jsonResponse(status: number, body: SuccessEnvelope | FailureEnvelope): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function failureResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, {
    version: RUNTIME_AUTHORITY_PUBLICATION_HTTP_CONTRACT_VERSION,
    ok: false,
    error: { code, message },
  });
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

function normalizeMaxBodyBytes(value: number | undefined): number {
  if (value === undefined) return MAX_BODY_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_BODY_BYTES) {
    throw new TypeError(
      `Runtime Authority publication HTTP handler maxBodyBytes must be a positive integer not exceeding ${MAX_BODY_BYTES} bytes.`,
    );
  }
  return value;
}

/** Create a transport-neutral Web `Request -> Response` handler for the #1066 publication boundary. */
export function createRuntimeAuthorityPublicationHttpHandler(
  options: RuntimeAuthorityPublicationHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  if (!isRecord(options) || !isPublisher(options.publisher)) {
    throw new TypeError("Runtime Authority publication HTTP handler configuration is invalid.");
  }
  const publisher = options.publisher;
  const maxBodyBytes = normalizeMaxBodyBytes(options.maxBodyBytes);

  return async function handleRuntimeAuthorityPublicationHttpRequest(request: Request): Promise<Response> {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return failureResponse(400, "MALFORMED_REQUEST", "Request URL is invalid.");
    }
    if (pathname !== RUNTIME_AUTHORITY_PUBLICATION_HTTP_PATH) {
      return failureResponse(404, "NOT_FOUND", "The requested path is not implemented by this endpoint.");
    }
    if (request.method !== "POST") {
      return failureResponse(405, "METHOD_NOT_ALLOWED", "Only POST is supported for this endpoint.");
    }
    if (!isJsonContentType(request.headers.get("content-type"))) {
      return failureResponse(415, "UNSUPPORTED_MEDIA_TYPE", "Request content type must be application/json.");
    }
    const callerToken = extractBearerToken(request.headers.get("authorization"));
    if (callerToken === undefined) {
      return failureResponse(401, "UNAUTHORIZED", "A bearer-authorized caller is required.");
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

    let result: RuntimeAuthorityPublicationResult;
    try {
      result = await publisher.publish(envelope, callerToken);
    } catch (error: unknown) {
      if (error instanceof RuntimeAuthorityPublicationUnauthorizedError) {
        return failureResponse(403, "RUNTIME_AUTHORITY_PUBLICATION_UNAUTHORIZED", "Caller is not authorized.");
      }
      return failureResponse(
        400,
        "RUNTIME_AUTHORITY_PUBLICATION_FAILED",
        "Runtime Authority trust publication failed closed.",
      );
    }
    return jsonResponse(200, {
      version: RUNTIME_AUTHORITY_PUBLICATION_HTTP_CONTRACT_VERSION,
      ok: true,
      result,
    });
  };
}
