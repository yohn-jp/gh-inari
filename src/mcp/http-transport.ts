/** Stateless Web-standard Streamable HTTP adapter for the native Inari MCP catalog. */

import { SUPPORTED_PROTOCOL_VERSIONS, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createInariMcpServer, type InariMcpServerOptions } from "./server.js";

export const DEFAULT_INARI_MCP_HTTP_PATH = "/mcp" as const;
export const DEFAULT_INARI_MCP_HTTP_BODY_BYTES = 1_048_576 as const;
const MAX_HTTP_PATH_LENGTH = 256;
const MAX_ORIGIN_LENGTH = 2_048;
const MAX_PROTOCOL_HEADER_LENGTH = 64;

export interface InariMcpHttpTransportOptions extends InariMcpServerOptions {
  /** The one pathname served by the handler. */
  readonly path?: string;
  /** Origins allowed to call the handler; omitted means no Origin is allowed. */
  readonly allowedOrigins?: readonly string[];
  /** Maximum request and response body size in bytes. */
  readonly maxBodyBytes?: number;
}

export type InariMcpHttpHandler = (request: Request) => Promise<Response>;

function jsonError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
    {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

function isJsonMediaType(value: string | null): boolean {
  if (value === null || value.includes(",")) return false;
  return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function acceptsStreamableJson(value: string | null): boolean {
  if (value === null) return false;
  let acceptsJson = false;
  let acceptsEventStream = false;
  for (const part of value.split(",")) {
    const [mediaType, ...parameters] = part.trim().toLowerCase().split(";");
    if (parameters.some((parameter) => parameter.trim() === "q=0" || parameter.trim() === "q=0.0")) continue;
    if (mediaType === "application/json") acceptsJson = true;
    if (mediaType === "text/event-stream") acceptsEventStream = true;
  }
  return acceptsJson && acceptsEventStream;
}

function validateOptions(options: InariMcpHttpTransportOptions): {
  readonly path: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly maxBodyBytes: number;
} {
  const path = options.path ?? DEFAULT_INARI_MCP_HTTP_PATH;
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > MAX_HTTP_PATH_LENGTH ||
    !path.startsWith("/") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    throw new TypeError("MCP HTTP path is invalid.");
  }
  const origins = options.allowedOrigins ?? [];
  if (!Array.isArray(origins) || origins.length > 32) throw new TypeError("MCP HTTP origins are invalid.");
  for (const origin of origins) {
    if (
      typeof origin !== "string" ||
      origin.length === 0 ||
      origin.length > MAX_ORIGIN_LENGTH ||
      origin.includes(",")
    ) {
      throw new TypeError("MCP HTTP origin is invalid.");
    }
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_INARI_MCP_HTTP_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > DEFAULT_INARI_MCP_HTTP_BODY_BYTES) {
    throw new TypeError("MCP HTTP body limit is invalid.");
  }
  return { path, allowedOrigins: new Set(origins), maxBodyBytes };
}

function validateContentLength(request: Request, maxBodyBytes: number): Response | undefined {
  const value = request.headers.get("content-length");
  if (value === null) return undefined;
  if (!/^\d{1,10}$/u.test(value)) return jsonError(400, "Invalid Content-Length.");
  const length = Number(value);
  if (!Number.isSafeInteger(length)) return jsonError(400, "Invalid Content-Length.");
  if (length > maxBodyBytes) return jsonError(413, "Request body is too large.");
  return undefined;
}

async function readBoundedBody(request: Request, maxBodyBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel();
        throw new Error("body-limit");
      }
      chunks.push(next.value);
    }
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
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("invalid-json");
  }
}

async function boundResponse(response: Response, maxBodyBytes: number): Promise<Response> {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel();
        return jsonError(500, "MCP response exceeded the body limit.");
      }
      chunks.push(next.value);
    }
  } catch {
    return jsonError(500, "MCP response failed closed.");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Create a stateless Web-standard MCP handler.
 *
 * The server and SDK transport are deliberately created inside the request
 * callback. No MCP session ID, event store, or hosted authorization state is
 * retained between requests.
 */
export function createInariMcpHttpHandler(options: InariMcpHttpTransportOptions = {}): InariMcpHttpHandler {
  const validated = validateOptions(options);
  return async (request: Request): Promise<Response> => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url);
    } catch {
      return jsonError(400, "Invalid request URL.");
    }
    if (requestUrl.pathname !== validated.path) return jsonError(404, "MCP endpoint not found.");
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }),
        {
          status: 405,
          headers: { allow: "POST", "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        },
      );
    }
    const origin = request.headers.get("origin");
    if (origin !== null && (origin.length > MAX_ORIGIN_LENGTH || !validated.allowedOrigins.has(origin))) {
      return jsonError(403, "Origin is not allowed.");
    }
    const protocolVersion = request.headers.get("mcp-protocol-version");
    if (
      protocolVersion !== null &&
      (protocolVersion.length > MAX_PROTOCOL_HEADER_LENGTH || !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion))
    ) {
      return jsonError(400, "MCP protocol version is invalid.");
    }
    if (!acceptsStreamableJson(request.headers.get("accept"))) {
      return jsonError(406, "Accept must include application/json and text/event-stream.");
    }
    if (!isJsonMediaType(request.headers.get("content-type"))) {
      return jsonError(415, "Content-Type must be application/json.");
    }
    const contentLengthError = validateContentLength(request, validated.maxBodyBytes);
    if (contentLengthError !== undefined) return contentLengthError;

    let body: unknown;
    try {
      body = await readBoundedBody(request, validated.maxBodyBytes);
    } catch (error) {
      return jsonError(
        error instanceof Error && error.message === "body-limit" ? 413 : 400,
        "Request body is invalid.",
      );
    }

    const server = createInariMcpServer(options);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await boundResponse(await transport.handleRequest(request, { parsedBody: body }), validated.maxBodyBytes);
    } catch {
      return jsonError(500, "MCP request failed closed.");
    } finally {
      try {
        await server.close();
      } catch {
        // Cleanup must not expose provider or credential diagnostics.
      }
    }
  };
}
