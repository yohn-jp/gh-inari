/** Browser-only GitHub App Authorization Code + PKCE bootstrap. */

const OAUTH_EXCHANGE_PATH = "/v1/auth/github/exchange";
const DEFAULT_AUTHORIZE_ENDPOINT = "https://github.com/login/oauth/authorize";
const STATE_STORAGE_KEY = "inari.dashboard.oauth.pending";
const RANDOM_BYTES = 32;
const MAX_RESPONSE_BYTES = 64 * 1024;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;

export type DashboardAuthErrorCode =
  | "DASHBOARD_AUTH_CONFIGURATION_INVALID"
  | "DASHBOARD_AUTH_CRYPTO_UNAVAILABLE"
  | "DASHBOARD_AUTH_CALLBACK_INVALID"
  | "DASHBOARD_AUTH_STATE_MISMATCH"
  | "DASHBOARD_AUTH_PROVIDER_ERROR"
  | "DASHBOARD_AUTH_EXCHANGE_FAILED";

export class DashboardAuthError extends Error {
  readonly code: DashboardAuthErrorCode;

  constructor(code: DashboardAuthErrorCode, message: string) {
    super(message);
    this.name = "DashboardAuthError";
    this.code = code;
  }
}

export interface DashboardAuthOptions {
  readonly clientId: string;
  readonly redirectUri: string;
  /** Same-origin Hosted Endpoint exchange URL; derived from redirectUri by default. */
  readonly exchangeEndpoint?: string;
  /** GitHub App authorization URL; GitHub.com is the default. */
  readonly authorizeEndpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly storage?: Storage | null;
  readonly crypto?: Pick<Crypto, "getRandomValues" | "subtle">;
  readonly now?: () => number;
}

export interface DashboardAuthToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

export interface DashboardAuthSession {
  beginAuthorization(): Promise<string>;
  /** Alias used by Dashboard bootstrap callers. */
  startAuthorization(): Promise<string>;
  handleCallback(callback?: string | URL): Promise<DashboardAuthToken>;
  getAccessToken(): string | undefined;
  getExpiresAt(): number | undefined;
  clearAccessToken(): void;
}

interface PendingAuthorization {
  readonly state: string;
  readonly verifier: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function safeStorage(storage: Storage | null | undefined): Storage | undefined {
  if (storage !== undefined) return storage ?? undefined;
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function secureRandom(crypto: Pick<Crypto, "getRandomValues">): string {
  if (typeof crypto?.getRandomValues !== "function") {
    throw new DashboardAuthError("DASHBOARD_AUTH_CRYPTO_UNAVAILABLE", "Browser cryptography is unavailable.");
  }
  const bytes = new Uint8Array(RANDOM_BYTES);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    throw new DashboardAuthError("DASHBOARD_AUTH_CRYPTO_UNAVAILABLE", "Browser cryptography is unavailable.");
  }
  return bytesToBase64Url(bytes);
}

function validHttpsUrl(value: string, allowQuery = false): URL {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") throw new Error();
    if (!allowQuery && (parsed.search !== "" || parsed.hash !== "")) throw new Error();
    return parsed;
  } catch {
    throw new DashboardAuthError("DASHBOARD_AUTH_CONFIGURATION_INVALID", "Dashboard OAuth configuration is invalid.");
  }
}

async function sha256Base64Url(crypto: Pick<Crypto, "subtle">, value: string): Promise<string> {
  if (typeof crypto?.subtle?.digest !== "function") {
    throw new DashboardAuthError("DASHBOARD_AUTH_CRYPTO_UNAVAILABLE", "Browser cryptography is unavailable.");
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return bytesToBase64Url(new Uint8Array(digest));
  } catch {
    throw new DashboardAuthError("DASHBOARD_AUTH_CRYPTO_UNAVAILABLE", "Browser cryptography is unavailable.");
  }
}

function pendingFrom(storage: Storage | undefined): PendingAuthorization | undefined {
  if (storage === undefined) return undefined;
  try {
    const serialized = storage.getItem(STATE_STORAGE_KEY);
    if (serialized === null) return undefined;
    const value: unknown = JSON.parse(serialized);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as { state?: unknown }).state !== "string" ||
      typeof (value as { verifier?: unknown }).verifier !== "string" ||
      !VERIFIER_PATTERN.test((value as { verifier: string }).verifier)
    )
      return undefined;
    return Object.freeze({
      state: (value as { state: string }).state,
      verifier: (value as { verifier: string }).verifier,
    });
  } catch {
    return undefined;
  }
}

function savePending(storage: Storage | undefined, pending: PendingAuthorization): void {
  if (storage === undefined) return;
  try {
    storage.setItem(STATE_STORAGE_KEY, JSON.stringify(pending));
  } catch {
    // The in-memory pending attempt remains authoritative when storage is unavailable.
  }
}

function removePending(storage: Storage | undefined): void {
  try {
    storage?.removeItem(STATE_STORAGE_KEY);
  } catch {
    // Storage failures must not turn a successful exchange into a credential error.
  }
}

function sameString(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function tokenFrom(value: unknown, now: number): DashboardAuthToken {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DashboardAuthError("DASHBOARD_AUTH_EXCHANGE_FAILED", "Dashboard OAuth exchange failed.");
  }
  const token = value as { accessToken?: unknown; expiresAt?: unknown; refreshToken?: unknown };
  if (
    typeof token.accessToken !== "string" ||
    token.accessToken.length === 0 ||
    token.accessToken.length > 8192 ||
    typeof token.expiresAt !== "number" ||
    !Number.isSafeInteger(token.expiresAt) ||
    token.expiresAt <= now ||
    token.refreshToken !== undefined
  ) {
    throw new DashboardAuthError("DASHBOARD_AUTH_EXCHANGE_FAILED", "Dashboard OAuth exchange failed.");
  }
  return Object.freeze({ accessToken: token.accessToken, expiresAt: token.expiresAt });
}

function responseUrl(callback: string | URL | undefined): URL {
  if (callback === undefined) {
    try {
      return validHttpsUrl(globalThis.location.href, true);
    } catch {
      throw new DashboardAuthError("DASHBOARD_AUTH_CALLBACK_INVALID", "Dashboard OAuth callback is invalid.");
    }
  }
  const value = callback instanceof URL ? callback.toString() : callback;
  try {
    return validHttpsUrl(value, true);
  } catch {
    throw new DashboardAuthError("DASHBOARD_AUTH_CALLBACK_INVALID", "Dashboard OAuth callback is invalid.");
  }
}

/** Generate one cryptographically random PKCE verifier or state value. */
export function generateDashboardOAuthRandomValue(crypto: Pick<Crypto, "getRandomValues"> = globalThis.crypto): string {
  return secureRandom(crypto);
}

export function createDashboardAuth(options: DashboardAuthOptions): DashboardAuthSession {
  if (typeof options?.clientId !== "string" || options.clientId.length === 0 || options.clientId.length > 256) {
    throw new DashboardAuthError("DASHBOARD_AUTH_CONFIGURATION_INVALID", "Dashboard OAuth configuration is invalid.");
  }
  const redirect = validHttpsUrl(options.redirectUri);
  const crypto = options.crypto ?? globalThis.crypto;
  const storage = safeStorage(options.storage);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new DashboardAuthError("DASHBOARD_AUTH_CONFIGURATION_INVALID", "Dashboard OAuth fetch is unavailable.");
  }
  const authorizeEndpoint = validHttpsUrl(options.authorizeEndpoint ?? DEFAULT_AUTHORIZE_ENDPOINT, true).toString();
  const exchangeEndpoint = validHttpsUrl(
    options.exchangeEndpoint ?? `${redirect.origin}${OAUTH_EXCHANGE_PATH}`,
  ).toString();
  const now = options.now ?? Date.now;
  let pending: PendingAuthorization | undefined;
  let token: DashboardAuthToken | undefined;

  const session: DashboardAuthSession = {
    async beginAuthorization(): Promise<string> {
      const verifier = secureRandom(crypto);
      const state = secureRandom(crypto);
      pending = Object.freeze({ state, verifier });
      savePending(storage, pending);
      const challenge = await sha256Base64Url(crypto, verifier);
      const url = new URL(authorizeEndpoint);
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", redirect.toString());
      url.searchParams.set("response_type", "code");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },
    startAuthorization(): Promise<string> {
      return this.beginAuthorization();
    },
    async handleCallback(callback?: string | URL): Promise<DashboardAuthToken> {
      const callbackUrl = responseUrl(callback);
      if (callbackUrl.origin !== redirect.origin || callbackUrl.pathname !== redirect.pathname) {
        throw new DashboardAuthError("DASHBOARD_AUTH_CALLBACK_INVALID", "Dashboard OAuth callback is invalid.");
      }
      const receivedState = callbackUrl.searchParams.get("state");
      const error = callbackUrl.searchParams.get("error");
      const attempt = pending ?? pendingFrom(storage);
      if (attempt === undefined || receivedState === null || !sameString(receivedState, attempt.state)) {
        throw new DashboardAuthError("DASHBOARD_AUTH_STATE_MISMATCH", "Dashboard OAuth state does not match.");
      }
      if (error !== null) {
        removePending(storage);
        pending = undefined;
        throw new DashboardAuthError("DASHBOARD_AUTH_PROVIDER_ERROR", "GitHub OAuth authorization was denied.");
      }
      const code = callbackUrl.searchParams.get("code");
      if (code === null || code.length === 0 || code.length > 2_048) {
        throw new DashboardAuthError("DASHBOARD_AUTH_CALLBACK_INVALID", "Dashboard OAuth callback is invalid.");
      }
      removePending(storage);
      pending = undefined;
      let response: Response;
      try {
        response = await fetcher(exchangeEndpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            origin: redirect.origin,
          },
          body: JSON.stringify({ code, codeVerifier: attempt.verifier, redirectUri: redirect.toString() }),
        });
      } catch {
        throw new DashboardAuthError("DASHBOARD_AUTH_EXCHANGE_FAILED", "Dashboard OAuth exchange failed.");
      }
      let body: unknown;
      try {
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error();
        body = JSON.parse(text) as unknown;
      } catch {
        throw new DashboardAuthError("DASHBOARD_AUTH_EXCHANGE_FAILED", "Dashboard OAuth exchange failed.");
      }
      if (!response.ok)
        throw new DashboardAuthError("DASHBOARD_AUTH_EXCHANGE_FAILED", "Dashboard OAuth exchange failed.");
      const result = tokenFrom(body, now());
      if (result.expiresAt <= now())
        throw new DashboardAuthError("DASHBOARD_AUTH_EXCHANGE_FAILED", "Dashboard OAuth exchange failed.");
      token = result;
      return result;
    },
    getAccessToken(): string | undefined {
      if (token === undefined || token.expiresAt <= now()) {
        token = undefined;
        return undefined;
      }
      return token.accessToken;
    },
    getExpiresAt(): number | undefined {
      return session.getAccessToken() === undefined ? undefined : token?.expiresAt;
    },
    clearAccessToken(): void {
      token = undefined;
    },
  };
  return Object.freeze(session);
}

export const createDashboardAuthSession = createDashboardAuth;
