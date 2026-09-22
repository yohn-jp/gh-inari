/** Same-origin GitHub App Authorization Code + PKCE exchange for Hosted Endpoints. */

export const HOSTED_ENDPOINT_OAUTH_EXCHANGE_PATH = "/v1/auth/github/exchange" as const;
/** Compatibility name for embedders that refer to the exchange as the OAuth path. */
export const HOSTED_ENDPOINT_OAUTH_PATH = HOSTED_ENDPOINT_OAUTH_EXCHANGE_PATH;
export const GITHUB_OAUTH_AUTHORIZE_PATH = "/login/oauth/authorize" as const;
export const GITHUB_OAUTH_TOKEN_PATH = "/login/oauth/access_token" as const;

const MAX_BODY_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_CLIENT_FIELD_BYTES = 256;
const MAX_CODE_BYTES = 2_048;
const MAX_ACCESS_TOKEN_BYTES = 8_192;
const MAX_EXPIRY_SECONDS = 31_536_000;
const TEXT_ENCODER = new TextEncoder();
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;

export type HostedEndpointOAuthErrorCode =
  | "HOSTED_OAUTH_INVALID_REQUEST"
  | "HOSTED_OAUTH_METHOD_NOT_ALLOWED"
  | "HOSTED_OAUTH_ORIGIN_DENIED"
  | "HOSTED_OAUTH_REDIRECT_DENIED"
  | "HOSTED_OAUTH_EXCHANGE_FAILED";

export class HostedEndpointOAuthError extends Error {
  readonly code: HostedEndpointOAuthErrorCode;
  readonly status: number;

  constructor(code: HostedEndpointOAuthErrorCode, status = 400) {
    super("Hosted OAuth exchange failed closed.");
    this.name = "HostedEndpointOAuthError";
    this.code = code;
    this.status = status;
  }
}

export interface HostedEndpointOAuthOptions {
  /** Public App client ID. */
  readonly clientId: string;
  /** Confidential App client secret. This value never crosses the response boundary. */
  readonly clientSecret: string;
  /** One exact, configured callback URI. */
  readonly redirectUri: string;
  /** Same-origin browser origin. Defaults to the callback origin. */
  readonly allowedOrigin?: string;
  /** GitHub.com by default; self-hosted endpoints may use their GitHub host. */
  readonly githubHost?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxBodyBytes?: number;
}

export interface HostedEndpointOAuthToken {
  readonly accessToken: string;
  /** Absolute expiry in Unix milliseconds. */
  readonly expiresAt: number;
}

export type HostedEndpointOAuthHandler = (request: Request) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    TEXT_ENCODER.encode(value).byteLength <= maxBytes &&
    !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)
  );
}

function originOf(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    )
      return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function redirectOf(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return undefined;
    if (parsed.search !== "" || parsed.hash !== "") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function githubHost(value: string | undefined): string {
  const host = value ?? "github.com";
  if (!/^[A-Za-z0-9.-]{1,253}$/u.test(host) || host.includes("..")) {
    throw new TypeError("GitHub host is invalid.");
  }
  return host.toLowerCase();
}

function jsonResponse(status: number, body: object, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...extra,
    },
  });
}

function failure(error: HostedEndpointOAuthError): Response {
  return jsonResponse(error.status, { ok: false, error: { code: error.code } });
}

async function boundedRequestBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d{1,8}$/u.test(contentLength) || Number(contentLength) > maxBytes)) {
    throw new HostedEndpointOAuthError("HOSTED_OAUTH_INVALID_REQUEST", 413);
  }
  let body: string;
  try {
    body = await request.text();
  } catch {
    throw new HostedEndpointOAuthError("HOSTED_OAUTH_INVALID_REQUEST");
  }
  if (TEXT_ENCODER.encode(body).byteLength > maxBytes) {
    throw new HostedEndpointOAuthError("HOSTED_OAUTH_INVALID_REQUEST", 413);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new HostedEndpointOAuthError("HOSTED_OAUTH_INVALID_REQUEST");
  }
}

function inputFrom(value: unknown, redirectUri: string): { readonly code: string; readonly verifier: string } {
  if (!isRecord(value)) throw new HostedEndpointOAuthError("HOSTED_OAUTH_INVALID_REQUEST");
  const code = value.code;
  if (
    value.codeVerifier !== undefined &&
    value.code_verifier !== undefined &&
    value.codeVerifier !== value.code_verifier
  ) {
    throw new HostedEndpointOAuthError("HOSTED_OAUTH_INVALID_REQUEST");
  }
  if (value.redirectUri !== undefined && value.redirect_uri !== undefined && value.redirectUri !== value.redirect_uri) {
    throw new HostedEndpointOAuthError("HOSTED_OAUTH_INVALID_REQUEST");
  }
  const verifier = value.codeVerifier ?? value.code_verifier;
  const requestedRedirect = value.redirectUri ?? value.redirect_uri;
  if (!boundedText(code, MAX_CODE_BYTES) || !boundedText(verifier, 256) || !CODE_VERIFIER_PATTERN.test(verifier)) {
    throw new HostedEndpointOAuthError("HOSTED_OAUTH_INVALID_REQUEST");
  }
  if (requestedRedirect !== redirectUri) throw new HostedEndpointOAuthError("HOSTED_OAUTH_REDIRECT_DENIED", 403);
  const keys = Object.keys(value);
  if (keys.some((key) => !["code", "codeVerifier", "code_verifier", "redirectUri", "redirect_uri"].includes(key))) {
    throw new HostedEndpointOAuthError("HOSTED_OAUTH_INVALID_REQUEST");
  }
  return { code, verifier };
}

function tokenFrom(value: unknown, now: number): HostedEndpointOAuthToken | undefined {
  if (!isRecord(value)) return undefined;
  const accessToken = value.access_token;
  const tokenType = value.token_type;
  const expiresIn = value.expires_in;
  if (!boundedText(accessToken, MAX_ACCESS_TOKEN_BYTES) || /\s/u.test(accessToken)) return undefined;
  if (tokenType !== undefined && (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer"))
    return undefined;
  if (
    typeof expiresIn !== "number" ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > MAX_EXPIRY_SECONDS
  )
    return undefined;
  const expiresAt = now + expiresIn * 1000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return undefined;
  return Object.freeze({ accessToken, expiresAt });
}

function tokenEndpoint(host: string): string {
  return `https://${host}${GITHUB_OAUTH_TOKEN_PATH}`;
}

function validateOptions(options: HostedEndpointOAuthOptions): Required<
  Pick<HostedEndpointOAuthOptions, "clientId" | "clientSecret" | "redirectUri">
> & {
  readonly allowedOrigin: string;
  readonly tokenEndpoint: string;
  readonly fetcher: typeof globalThis.fetch;
  readonly maxBodyBytes: number;
} {
  if (
    !isRecord(options) ||
    !boundedText(options.clientId, MAX_CLIENT_FIELD_BYTES) ||
    !boundedText(options.clientSecret, MAX_CLIENT_FIELD_BYTES)
  ) {
    throw new TypeError("Hosted OAuth client configuration is invalid.");
  }
  const redirectUri = redirectOf(options.redirectUri);
  if (redirectUri === undefined) throw new TypeError("Hosted OAuth redirect URI is invalid.");
  const callbackOrigin = new URL(redirectUri).origin;
  const allowedOrigin = options.allowedOrigin === undefined ? callbackOrigin : originOf(options.allowedOrigin);
  if (allowedOrigin === undefined || allowedOrigin !== callbackOrigin)
    throw new TypeError("Hosted OAuth origin is invalid.");
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new TypeError("Hosted OAuth fetch implementation is required.");
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > MAX_BODY_BYTES) {
    throw new TypeError("Hosted OAuth request size is invalid.");
  }
  return {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    redirectUri,
    allowedOrigin,
    tokenEndpoint: tokenEndpoint(githubHost(options.githubHost)),
    fetcher,
    maxBodyBytes,
  };
}

/** Create the stateless Hosted Endpoint authorization-code exchange handler. */
export function createHostedEndpointOAuthHandler(options: HostedEndpointOAuthOptions): HostedEndpointOAuthHandler {
  const configured = validateOptions(options);
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== "POST") throw new HostedEndpointOAuthError("HOSTED_OAUTH_METHOD_NOT_ALLOWED", 405);
      if (request.headers.get("origin") !== configured.allowedOrigin) {
        throw new HostedEndpointOAuthError("HOSTED_OAUTH_ORIGIN_DENIED", 403);
      }
      const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") throw new HostedEndpointOAuthError("HOSTED_OAUTH_INVALID_REQUEST");
      const input = inputFrom(await boundedRequestBody(request, configured.maxBodyBytes), configured.redirectUri);
      const response = await configured.fetcher(configured.tokenEndpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: configured.clientId,
          client_secret: configured.clientSecret,
          code: input.code,
          redirect_uri: configured.redirectUri,
          code_verifier: input.verifier,
        }).toString(),
      });
      const text = await response.text();
      if (TEXT_ENCODER.encode(text).byteLength > MAX_RESPONSE_BYTES || !response.ok) {
        throw new HostedEndpointOAuthError("HOSTED_OAUTH_EXCHANGE_FAILED", 502);
      }
      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new HostedEndpointOAuthError("HOSTED_OAUTH_EXCHANGE_FAILED", 502);
      }
      const token = tokenFrom(body, Date.now());
      if (token === undefined) throw new HostedEndpointOAuthError("HOSTED_OAUTH_EXCHANGE_FAILED", 502);
      return jsonResponse(200, token);
    } catch (error: unknown) {
      if (error instanceof HostedEndpointOAuthError) {
        const response = failure(error);
        if (error.code === "HOSTED_OAUTH_METHOD_NOT_ALLOWED") response.headers.set("allow", "POST");
        return response;
      }
      return failure(new HostedEndpointOAuthError("HOSTED_OAUTH_EXCHANGE_FAILED", 502));
    }
  };
}

export const createHostedOAuthExchangeHandler = createHostedEndpointOAuthHandler;
