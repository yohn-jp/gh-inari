/**
 * Native bounded GitHub HTTP transport foundation (#662).
 *
 * This module owns provider I/O only: base URL/host selection, REST
 * requests, GraphQL requests, binary response handling, request deadlines,
 * bounded response sizes, headers, status projection, and secret-safe
 * failures. It never executes `gh` or reads gh config, and it never decides
 * whether a caller is authorized -- authority remains with the credential
 * and capability layers above it (`user-credential.ts`,
 * `app-installation-credential-broker.ts`).
 *
 * `GitHubAppApiTransport` remains the separate, capability-restricted
 * transport used by trusted GitHub App credentials; this class exists so a
 * standalone user-token caller gets the same bounded REST/GraphQL/binary
 * discipline without being handed App-specific capability ownership.
 */

import type {
  GitHubChangeEffectHttpMethod,
  GitHubChangeEffectRequest,
  GitHubChangeEffectResponse,
  GitHubChangeEffectTransport,
} from "./change-effect-adapter.js";
import {
  githubProviderFailure,
  type GitHubProviderFailureClassification,
} from "./provider-failure.js";

const DEFAULT_HOSTNAME = "github.com";
const MAX_HOSTNAME_LENGTH = 255;
const MAX_PATH_LENGTH = 4_096;
const MAX_TOKEN_LENGTH = 4_096;
const MAX_API_URL_LENGTH = 2_048;
/** Default bounded deadline for every provider request. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Compile-time hard ceiling. No runtime configuration may exceed this bound. */
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const MAX_MAX_RESPONSE_BYTES = 64 * 1_048_576;

export type GitHubHttpFailureReason = "timeout" | "transport" | "response-limit" | "malformed-response";

export class GitHubHttpTransportError extends Error {
  readonly code = "GITHUB_HTTP_TRANSPORT_FAILED" as const;
  readonly reason: GitHubHttpFailureReason;
  readonly providerFailure: GitHubProviderFailureClassification;

  constructor(
    reason: GitHubHttpFailureReason,
    message: string,
    cause?: unknown,
    providerFailure: GitHubProviderFailureClassification = githubProviderFailure("transport", { retryable: true }),
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GitHubHttpTransportError";
    this.reason = reason;
    this.providerFailure = providerFailure;
  }
}

export class GitHubHttpTimeoutError extends GitHubHttpTransportError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      "timeout",
      `GitHub HTTP request exceeded its bounded timeout of ${timeoutMs}ms.`,
      undefined,
      githubProviderFailure("timeout", { retryable: true, timeoutMs }),
    );
    this.name = "GitHubHttpTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class GitHubHttpResponseLimitError extends GitHubHttpTransportError {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(
      "response-limit",
      `GitHub HTTP response exceeded its bounded limit of ${limitBytes} bytes.`,
      undefined,
      githubProviderFailure("response-limit", { retryable: false, limitBytes }),
    );
    this.name = "GitHubHttpResponseLimitError";
    this.limitBytes = limitBytes;
  }
}

export class GitHubHttpMalformedResponseError extends GitHubHttpTransportError {
  constructor() {
    super(
      "malformed-response",
      "GitHub HTTP response body could not be decoded.",
      undefined,
      githubProviderFailure("response-invalid", { retryable: false }),
    );
    this.name = "GitHubHttpMalformedResponseError";
  }
}

/** Internal-only marker: a bounded body read was cancelled by the request deadline. Never thrown across the public API. */
class BoundedReadAbortedError extends Error {
  constructor() {
    super("GitHub HTTP bounded body read was aborted.");
    this.name = "BoundedReadAbortedError";
  }
}

/** Derive the REST API base URL for a GitHub host; github.com uses the dedicated API host. */
export function githubRestBaseUrl(hostname: string): string {
  const normalized = normalizedHostname(hostname);
  return normalized === DEFAULT_HOSTNAME ? "https://api.github.com" : `https://${normalized}/api/v3`;
}

/** Derive the GraphQL endpoint URL for a GitHub host. */
export function githubGraphqlUrl(hostname: string): string {
  const normalized = normalizedHostname(hostname);
  return normalized === DEFAULT_HOSTNAME ? "https://api.github.com/graphql" : `https://${normalized}/api/graphql`;
}

function normalizedHostname(hostname: string): string {
  if (
    typeof hostname !== "string" ||
    hostname.length === 0 ||
    hostname.length > MAX_HOSTNAME_LENGTH ||
    /[\u0000-\u001F\u007F\s/]/u.test(hostname)
  ) {
    throw new GitHubHttpTransportError("transport", "GitHub hostname is invalid.");
  }
  return hostname.toLowerCase();
}

function boundedEndpoint(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > MAX_API_URL_LENGTH) {
    throw new GitHubHttpTransportError("transport", "GitHub API endpoint is invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GitHubHttpTransportError("transport", "GitHub API endpoint is invalid.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new GitHubHttpTransportError("transport", "GitHub API endpoint is invalid.");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function boundedPath(path: string): string {
  if (typeof path !== "string" || path.length > MAX_PATH_LENGTH || /[\u0000-\u001F\u007F]/u.test(path)) {
    throw new GitHubHttpTransportError("transport", "GitHub request path is invalid.");
  }
  return path;
}

function normalizedRequestTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_REQUEST_TIMEOUT_MS) {
    throw new RangeError(`requestTimeoutMs must be a finite integer in (0, ${MAX_REQUEST_TIMEOUT_MS}], got ${value}.`);
  }
  return value;
}

function normalizedMaxResponseBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_MAX_RESPONSE_BYTES) {
    throw new RangeError(`maxResponseBytes must be a finite integer in (0, ${MAX_MAX_RESPONSE_BYTES}], got ${value}.`);
  }
  return value;
}

function boundedToken(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TOKEN_LENGTH ||
    /[\u0000\u007F]/u.test(value)
  ) {
    throw new Error("GitHub HTTP transport token is invalid.");
  }
  return value;
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
  timedOut: boolean;
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

/**
 * `signal` keeps the same request deadline active through body consumption:
 * headers can arrive well within the bound while the body then stalls
 * indefinitely, and a provider that does that must still fail closed instead
 * of hanging forever. `reader.cancel()` (rather than relying on the fetch
 * implementation to propagate the abort into an already-open body stream)
 * guarantees the pending `read()` settles even against a fake/mocked
 * transport in tests.
 */
async function readBoundedBytes(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  if (response.status === 204 || response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = (): void => {
    reader.cancel(new Error("GitHub HTTP response body read aborted.")).catch(() => {});
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (signal.aborted) throw new BoundedReadAbortedError();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxResponseBytes) throw new GitHubHttpResponseLimitError(maxResponseBytes);
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be errored/cancelled; the lock is released either way.
    }
  }
  if (chunks.length === 0) return undefined;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeJsonBody(bytes: Uint8Array | undefined): unknown {
  if (bytes === undefined) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubHttpMalformedResponseError();
  }
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubHttpMalformedResponseError();
  }
}

function safeResponseHeaders(headers: Headers): Readonly<Record<string, string>> | undefined {
  const projected: Record<string, string> = {};
  for (const name of ["link", "x-github-request-id", "retry-after", "x-ratelimit-remaining"] as const) {
    const value = headers.get(name);
    if (
      value !== null &&
      value.length > 0 &&
      value.length <= 512 &&
      !/[\u0000-\u001F\u007F]/u.test(value)
    ) {
      projected[name] = value;
    }
  }
  return Object.keys(projected).length === 0 ? undefined : Object.freeze(projected);
}

export interface GitHubHttpBinaryResponse {
  readonly status: number;
  readonly bytes?: Uint8Array;
  readonly contentType?: string;
  /** Only bounded, non-secret response headers are exposed to callers. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Native response metadata retained by ordinary artifact observation. */
export interface GitHubNativeHttpResponse extends GitHubChangeEffectResponse {
  readonly body: unknown;
  /** Only bounded, non-secret response headers are exposed to callers. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface GitHubHttpGraphqlRequest {
  readonly hostname: string;
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
}

/** REST request shape used by ordinary artifact operations, including merge PUTs. */
export type GitHubNativeHttpRequest = Omit<GitHubChangeEffectRequest, "method"> & {
  readonly method: GitHubChangeEffectHttpMethod | "PUT";
};

export interface GitHubNativeHttpTransportOptions {
  /** Trusted-only constructor input; never returned or logged by this class. */
  readonly token: string;
  /** Optional fully-qualified REST API base, otherwise derived from hostname. */
  readonly apiUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Bounded downward/upward only within the compile-time hard ceiling. Defaults to 10s. */
  readonly requestTimeoutMs?: number;
  /** Bounded downward/upward only within the compile-time hard ceiling. Defaults to 1MiB. */
  readonly maxResponseBytes?: number;
}

/**
 * Standalone, host-flexible GitHub HTTP transport for explicitly injected or
 * environment-resolved user credentials. Implements the same
 * `GitHubChangeEffectTransport` request shape the trusted App transport
 * uses, so REST, GraphQL, and binary I/O share one host/auth/error
 * discipline and a caller written against one is portable to the other.
 */
export class GitHubNativeHttpTransport implements GitHubChangeEffectTransport {
  readonly #token: string;
  readonly #apiUrl: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(options: GitHubNativeHttpTransportOptions) {
    this.#token = boundedToken(options.token);
    this.#apiUrl = boundedEndpoint(options.apiUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestTimeoutMs = normalizedRequestTimeoutMs(options.requestTimeoutMs);
    this.#maxResponseBytes = normalizedMaxResponseBytes(options.maxResponseBytes);
  }

  async request(request: GitHubChangeEffectRequest): Promise<GitHubNativeHttpResponse>;
  async request(request: GitHubNativeHttpRequest): Promise<GitHubNativeHttpResponse>;
  async request(request: GitHubNativeHttpRequest): Promise<GitHubNativeHttpResponse> {
    const path = boundedPath(request.path);
    const url = this.restUrl(request.hostname, path);
    const { response, bytes } = await this.execute(url, request.method, request.body);
    return this.jsonResponse(response, bytes);
  }

  async requestGraphql(request: GitHubHttpGraphqlRequest): Promise<GitHubNativeHttpResponse> {
    const url = this.#apiUrl === undefined ? githubGraphqlUrl(request.hostname) : `${this.#apiUrl}/graphql`;
    const { response, bytes } = await this.execute(url, "POST", {
      query: request.query,
      variables: request.variables ?? {},
    });
    return this.jsonResponse(response, bytes);
  }

  /** Bounded binary read (for example an Actions artifact archive); never JSON-decoded. */
  async requestBinary(request: {
    readonly hostname: string;
    readonly method: "GET";
    readonly path: string;
    readonly accept?: string;
  }): Promise<GitHubHttpBinaryResponse> {
    const path = boundedPath(request.path);
    const url = this.restUrl(request.hostname, path);
    const { response, bytes } = await this.execute(url, request.method, undefined, request.accept);
    const contentType = response.headers.get("content-type");
    const headers = safeResponseHeaders(response.headers);
    return {
      status: response.status,
      ...(bytes === undefined ? {} : { bytes }),
      ...(contentType === null ? {} : { contentType }),
      ...(headers === undefined ? {} : { headers }),
    };
  }

  private restUrl(hostname: string, path: string): string {
    const base = this.#apiUrl ?? githubRestBaseUrl(hostname);
    return path.length === 0 ? base : `${base}/${path}`;
  }

  private jsonResponse(response: Response, bytes: Uint8Array | undefined): GitHubNativeHttpResponse {
    const headers = safeResponseHeaders(response.headers);
    return {
      status: response.status,
      body: decodeJsonBody(bytes),
      ...(headers === undefined ? {} : { headers }),
    };
  }

  /**
   * Runs the fetch and the bounded body read under the same deadline/signal:
   * a provider that returns headers promptly and then stalls the body must
   * still fail closed within `requestTimeoutMs`, not hang until the process
   * is killed.
   */
  private async execute(
    url: string,
    method: GitHubChangeEffectHttpMethod | "PUT",
    body: unknown,
    accept?: string,
  ): Promise<{ readonly response: Response; readonly bytes: Uint8Array | undefined }> {
    const bounded = boundedRequestSignal(this.#requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            Accept: accept ?? "application/vnd.github+json",
            Authorization: `Bearer ${this.#token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: bounded.signal,
        });
      } catch (error: unknown) {
        if (bounded.timedOut) throw new GitHubHttpTimeoutError(this.#requestTimeoutMs);
        throw this.safeTransportFailure(error);
      }
      let bytes: Uint8Array | undefined;
      try {
        bytes = await readBoundedBytes(response, this.#maxResponseBytes, bounded.signal);
      } catch (error: unknown) {
        if (bounded.timedOut || error instanceof BoundedReadAbortedError) {
          throw new GitHubHttpTimeoutError(this.#requestTimeoutMs);
        }
        if (error instanceof GitHubHttpResponseLimitError) throw error;
        throw new GitHubHttpMalformedResponseError();
      }
      return { response, bytes };
    } finally {
      bounded.clear();
    }
  }

  /** Never includes the bearer token in the thrown error's message. */
  private safeTransportFailure(cause: unknown): GitHubHttpTransportError {
    const message = cause instanceof Error ? cause.message : "GitHub HTTP request failed.";
    const safeMessage = message.includes(this.#token) ? "GitHub HTTP request failed." : message;
    return new GitHubHttpTransportError("transport", `GitHub HTTP transport failed: ${safeMessage}`, cause);
  }
}
