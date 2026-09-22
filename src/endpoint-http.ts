/** Web-standard HTTP adapter for the transport-neutral Endpoint API. */

import {
  ENDPOINT_API_CONTRACT_VERSION,
  ENDPOINT_API_LIMITS,
  ENDPOINT_API_OPERATION_PATH,
  executeEndpointApi,
  type EndpointApi,
  type EndpointApiFailure,
  type EndpointApiResult,
} from "./endpoint-api.js";

export const ENDPOINT_HTTP_CONTRACT_VERSION = ENDPOINT_API_CONTRACT_VERSION;
export const ENDPOINT_HTTP_PATH = ENDPOINT_API_OPERATION_PATH;
export const ENDPOINT_HTTP_DEFAULT_MAX_BODY_BYTES = ENDPOINT_API_LIMITS.bodyBytes;

export interface EndpointHttpHandlerOptions {
  readonly api: EndpointApi;
  readonly path?: string;
  readonly maxBodyBytes?: number;
}

export type EndpointHttpHandler = (request: Request) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function errorBody(
  code: string,
  message: string,
  extra: { readonly operation?: string; readonly diagnostics?: readonly unknown[] } = {},
): object {
  return {
    version: ENDPOINT_HTTP_CONTRACT_VERSION,
    ok: false,
    ...(extra.operation === undefined ? {} : { operation: extra.operation }),
    error: {
      code,
      message,
      ...(extra.diagnostics === undefined || extra.diagnostics.length === 0 ? {} : { diagnostics: extra.diagnostics }),
    },
  };
}

function httpStatus(result: EndpointApiFailure): number {
  switch (result.error.code) {
    case "ENDPOINT_API_AUTHENTICATION_REQUIRED":
    case "ENDPOINT_API_AUTHENTICATION_FAILED":
    case "ENDPOINT_API_AUTHENTICATION_INVALID":
      return 401;
    case "ENDPOINT_API_AUTHORIZATION_DENIED":
      return 403;
    case "ENDPOINT_API_PROJECTION_UNAVAILABLE":
    case "ENDPOINT_API_PROVIDER_FAILED":
      return 503;
    case "ENDPOINT_API_UNSUPPORTED_OPERATION":
      return 422;
    default:
      return 400;
  }
}

function resultResponse(result: EndpointApiResult): Response {
  if (result.ok) return jsonResponse(200, result);
  return jsonResponse(
    httpStatus(result),
    errorBody(result.error.code, result.error.message, {
      operation: result.operation,
      diagnostics: result.error.diagnostics,
    }),
  );
}

function isJsonContentType(value: string | null): boolean {
  if (value === null || value.includes(",")) return false;
  return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function readBody(
  request: Request,
  maxBodyBytes: number,
): Promise<
  { readonly kind: "ok"; readonly value: unknown } | { readonly kind: "too-large" } | { readonly kind: "invalid" }
> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d{1,10}$/u.test(contentLength)) return { kind: "invalid" };
    const size = Number(contentLength);
    if (!Number.isSafeInteger(size)) return { kind: "invalid" };
    if (size > maxBodyBytes) return { kind: "too-large" };
  }
  if (request.body === null) return { kind: "invalid" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
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
    return { kind: "invalid" };
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
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { kind: "ok", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}

function validPath(path: string): boolean {
  return path.length > 0 && path.length <= 256 && path.startsWith("/") && !path.includes("?") && !path.includes("#");
}

function optionsFrom(value: EndpointHttpHandlerOptions | EndpointApi): {
  readonly api: EndpointApi;
  readonly path: string;
  readonly maxBodyBytes: number;
} {
  const options = "execute" in value ? { api: value } : value;
  if (options.api === undefined || typeof options.api.execute !== "function")
    throw new TypeError("Endpoint HTTP handler requires an Endpoint API.");
  const path = options.path ?? ENDPOINT_HTTP_PATH;
  if (typeof path !== "string" || !validPath(path)) throw new TypeError("Endpoint HTTP path is invalid.");
  const maxBodyBytes = options.maxBodyBytes ?? ENDPOINT_HTTP_DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > ENDPOINT_HTTP_DEFAULT_MAX_BODY_BYTES)
    throw new TypeError("Endpoint HTTP body limit is invalid.");
  return { api: options.api, path, maxBodyBytes };
}

/** Create a bounded POST JSON adapter over the shared Endpoint API. */
export function createEndpointHttpHandler(options: EndpointHttpHandlerOptions | EndpointApi): EndpointHttpHandler {
  const validated = optionsFrom(options);
  return async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return jsonResponse(400, errorBody("ENDPOINT_HTTP_INVALID_REQUEST", "Request URL is invalid."));
    }
    if (url.pathname !== validated.path)
      return jsonResponse(404, errorBody("ENDPOINT_HTTP_NOT_FOUND", "Endpoint path is not implemented."));
    if (request.method !== "POST") {
      const response = jsonResponse(405, errorBody("ENDPOINT_HTTP_METHOD_NOT_ALLOWED", "Only POST is supported."));
      response.headers.set("allow", "POST");
      return response;
    }
    if (!isJsonContentType(request.headers.get("content-type")))
      return jsonResponse(
        415,
        errorBody("ENDPOINT_HTTP_UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json."),
      );
    const body = await readBody(request, validated.maxBodyBytes);
    if (body.kind === "too-large")
      return jsonResponse(
        413,
        errorBody("ENDPOINT_HTTP_PAYLOAD_TOO_LARGE", "Request body exceeds the configured limit."),
      );
    if (body.kind === "invalid")
      return jsonResponse(400, errorBody("ENDPOINT_HTTP_MALFORMED_JSON", "Request body is not valid JSON."));
    const result = await executeEndpointApi(validated.api, body.value, {
      transport: request,
      signal: request.signal,
    });
    return resultResponse(result);
  };
}

export const createEndpointApiHttpHandler = createEndpointHttpHandler;
