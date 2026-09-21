/**
 * GitHub App Device Flow credential boundary for a local Runtime.
 *
 * This module is intentionally separate from `user-credential.ts`.  The
 * latter resolves generic standalone credentials; this boundary accepts only
 * a public App client ID and the native Device Flow responses.  Credential
 * material is retained in an opaque handle and is usable only through a
 * short-lived callback.
 */

const DEFAULT_HOSTNAME = "github.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CLIENT_ID_LENGTH = 255;
const MAX_TOKEN_LENGTH = 4_096;
const MAX_DEVICE_CODE_LENGTH = 4_096;
const MAX_USER_CODE_LENGTH = 255;
const MAX_URI_LENGTH = 2_048;
const MAX_POLL_ATTEMPTS = 120;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

export type GitHubAppUserCredentialFailureReason =
  | "configuration"
  | "transport"
  | "provider"
  | "malformed"
  | "authorization-pending"
  | "slow-down"
  | "access-denied"
  | "expired"
  | "revoked";

/** Secret-safe deterministic failure from the Device Flow boundary. */
export class GitHubAppUserCredentialError extends Error {
  readonly code = "GITHUB_APP_USER_CREDENTIAL_FAILED" as const;
  readonly reason: GitHubAppUserCredentialFailureReason;
  readonly status?: number;

  constructor(reason: GitHubAppUserCredentialFailureReason, status?: number) {
    super("GitHub App user credential operation failed closed.");
    this.name = "GitHubAppUserCredentialError";
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
}

export interface AppUserCredentialMetadata {
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt?: string;
}

interface CredentialValues {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt?: string;
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    !SAFE_TEXT.test(value)
  ) {
    throw new GitHubAppUserCredentialError("malformed");
  }
  return value;
}

function boundedToken(value: unknown): string {
  return boundedString(value, MAX_TOKEN_LENGTH);
}

function boundedClientId(value: unknown): string {
  return boundedString(value, MAX_CLIENT_ID_LENGTH);
}

function boundedHostname(value: unknown): string {
  const hostname = boundedString(value, 255).trim().toLowerCase();
  if (hostname.length === 0 || /[\s/]/u.test(hostname)) throw new GitHubAppUserCredentialError("configuration");
  return hostname;
}

function boundedDate(value: unknown): string {
  const text = boundedString(value, 64);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new GitHubAppUserCredentialError("malformed");
  return date.toISOString();
}

function secondsFrom(value: unknown, required = true): number | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 31_536_000) {
    throw new GitHubAppUserCredentialError("malformed");
  }
  return value;
}

function requestTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_REQUEST_TIMEOUT_MS) {
    throw new GitHubAppUserCredentialError("configuration");
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubAppUserCredentialError("malformed");
  }
  return value as Record<string, unknown>;
}

function responseBodyText(response: Response, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => finish(() => reject(new GitHubAppUserCredentialError("transport")));
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    response
      .text()
      .then((text) => {
        if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
          finish(() => reject(new GitHubAppUserCredentialError("malformed")));
        } else {
          finish(() => resolve(text));
        }
      })
      .catch(() => finish(() => reject(new GitHubAppUserCredentialError("transport"))));
  });
}

function parseJson(text: string): Record<string, unknown> {
  try {
    return record(text.trim().length === 0 ? undefined : JSON.parse(text));
  } catch (error: unknown) {
    if (error instanceof GitHubAppUserCredentialError) throw error;
    throw new GitHubAppUserCredentialError("malformed");
  }
}

function boundedEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0 || url.search || url.hash) {
      throw new Error();
    }
    return url.toString().replace(/\/$/u, "");
  } catch {
    throw new GitHubAppUserCredentialError("configuration");
  }
}

function oauthBaseUrl(hostname: string, explicit: string | undefined): string {
  if (explicit !== undefined) return boundedEndpoint(explicit);
  return `https://${hostname}`;
}

function isoFromNow(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1_000).toISOString();
}

function isFuture(value: string, now: Date, skewMs = 0): boolean {
  return new Date(value).getTime() > now.getTime() + skewMs;
}

/** Opaque App-user credential. Values are not enumerable or returned by metadata. */
export class GitHubAppUserCredential {
  readonly #values: CredentialValues;

  /** @internal Construct through `createAppUserCredential` or a Device Flow client. */
  constructor(values: CredentialValues) {
    this.#values = Object.freeze({ ...values });
  }

  get metadata(): AppUserCredentialMetadata {
    return Object.freeze({
      accessTokenExpiresAt: this.#values.accessTokenExpiresAt,
      ...(this.#values.refreshTokenExpiresAt === undefined
        ? {}
        : { refreshTokenExpiresAt: this.#values.refreshTokenExpiresAt }),
    });
  }

  /** Internal credential-bound callback; callers receive no credential result. */
  async withAccessToken<T>(operation: (token: string) => Promise<T>): Promise<T> {
    if (typeof operation !== "function") throw new GitHubAppUserCredentialError("configuration");
    return operation(this.#values.accessToken);
  }

  /** Internal credential-bound callback used only by the refresh client. */
  async withRefreshToken<T>(operation: (token: string) => Promise<T>): Promise<T> {
    if (typeof operation !== "function") throw new GitHubAppUserCredentialError("configuration");
    return operation(this.#values.refreshToken);
  }

  isAccessExpired(now = new Date(), skewMs = 60_000): boolean {
    return !isFuture(this.#values.accessTokenExpiresAt, now, skewMs);
  }

  isRefreshExpired(now = new Date()): boolean {
    return this.#values.refreshTokenExpiresAt !== undefined && !isFuture(this.#values.refreshTokenExpiresAt, now);
  }
}

/** Construct an opaque credential for injected stores and deterministic tests. */
export function createAppUserCredential(values: {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt?: string;
}): GitHubAppUserCredential {
  return new GitHubAppUserCredential({
    accessToken: boundedToken(values.accessToken),
    refreshToken: boundedToken(values.refreshToken),
    accessTokenExpiresAt: boundedDate(values.accessTokenExpiresAt),
    ...(values.refreshTokenExpiresAt === undefined
      ? {}
      : { refreshTokenExpiresAt: boundedDate(values.refreshTokenExpiresAt) }),
  });
}

export interface GitHubAppDeviceFlowOptions {
  /** Public GitHub App client identity. No App secret/private key is accepted. */
  readonly clientId: string;
  readonly hostname?: string;
  /** Explicit OAuth origin, required when an Enterprise deployment does not use its host origin. */
  readonly oauthBaseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly requestTimeoutMs?: number;
  readonly maxPollAttempts?: number;
}

export interface GitHubAppDeviceCode {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
}

const deviceCodeSecrets = new WeakMap<object, string>();

/** Public, secret-free Device Flow result metadata. */
export interface GitHubAppDeviceFlowResult {
  readonly credential: GitHubAppUserCredential;
}

/** Native GitHub App Device Flow client. */
export class GitHubAppDeviceFlowClient {
  readonly #clientId: string;
  readonly #hostname: string;
  readonly #oauthBaseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #requestTimeoutMs: number;
  readonly #maxPollAttempts: number;

  constructor(options: GitHubAppDeviceFlowOptions) {
    if (
      Object.prototype.hasOwnProperty.call(options, "clientSecret") ||
      Object.prototype.hasOwnProperty.call(options, "privateKeyPem") ||
      Object.prototype.hasOwnProperty.call(options, "token")
    ) {
      throw new GitHubAppUserCredentialError("configuration");
    }
    this.#clientId = boundedClientId(options.clientId);
    this.#hostname = boundedHostname(options.hostname ?? DEFAULT_HOSTNAME);
    this.#oauthBaseUrl = oauthBaseUrl(this.#hostname, options.oauthBaseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#requestTimeoutMs = requestTimeout(options.requestTimeoutMs);
    const maxAttempts = options.maxPollAttempts ?? MAX_POLL_ATTEMPTS;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0 || maxAttempts > MAX_POLL_ATTEMPTS) {
      throw new GitHubAppUserCredentialError("configuration");
    }
    this.#maxPollAttempts = maxAttempts;
  }

  async requestDeviceCode(): Promise<GitHubAppDeviceCode> {
    const body = await this.#request("/login/device/code", { client_id: this.#clientId });
    const deviceCode = boundedString(body.device_code, MAX_DEVICE_CODE_LENGTH);
    const userCode = boundedString(body.user_code, MAX_USER_CODE_LENGTH);
    const verificationUri = boundedString(body.verification_uri ?? body.verification_url, MAX_URI_LENGTH);
    const verificationUriComplete =
      body.verification_uri_complete === undefined
        ? undefined
        : boundedString(body.verification_uri_complete, MAX_URI_LENGTH);
    const expiresIn = secondsFrom(body.expires_in);
    const interval = secondsFrom(body.interval, false) ?? 5;
    if (expiresIn === undefined) throw new GitHubAppUserCredentialError("malformed");
    const metadata = Object.freeze({
      userCode,
      verificationUri,
      ...(verificationUriComplete === undefined ? {} : { verificationUriComplete }),
      expiresAt: isoFromNow(this.#now(), expiresIn),
      intervalSeconds: interval,
    });
    deviceCodeSecrets.set(metadata, deviceCode);
    return metadata;
  }

  async authorize(): Promise<GitHubAppUserCredential> {
    const deviceCode = await this.requestDeviceCode();
    return this.poll(deviceCode);
  }

  async poll(deviceCode: GitHubAppDeviceCode): Promise<GitHubAppUserCredential> {
    const expiresAt = boundedDate(deviceCode.expiresAt);
    const secret = deviceCodeSecrets.get(deviceCode);
    if (secret === undefined) throw new GitHubAppUserCredentialError("configuration");
    let interval = Math.max(1, Math.min(900, deviceCode.intervalSeconds));
    for (let attempt = 0; attempt < this.#maxPollAttempts; attempt += 1) {
      if (!isFuture(expiresAt, this.#now())) throw new GitHubAppUserCredentialError("expired");
      const body = await this.#request("/login/oauth/access_token", {
        client_id: this.#clientId,
        device_code: boundedString(secret, MAX_DEVICE_CODE_LENGTH),
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      const error = body.error;
      if (error === "authorization_pending") {
        await this.#sleep(interval * 1_000);
        continue;
      }
      if (error === "slow_down") {
        interval = Math.min(900, interval + 5);
        await this.#sleep(interval * 1_000);
        continue;
      }
      if (error === "access_denied") throw new GitHubAppUserCredentialError("access-denied");
      if (error === "expired_token") throw new GitHubAppUserCredentialError("expired");
      if (error !== undefined) throw new GitHubAppUserCredentialError("provider");
      return this.#credentialFromTokenResponse(body);
    }
    throw new GitHubAppUserCredentialError("expired");
  }

  async refresh(credential: GitHubAppUserCredential): Promise<GitHubAppUserCredential> {
    if (!(credential instanceof GitHubAppUserCredential) || credential.isRefreshExpired(this.#now())) {
      throw new GitHubAppUserCredentialError("revoked");
    }
    const body = await credential.withRefreshToken((refreshToken) =>
      this.#request("/login/oauth/access_token", {
        client_id: this.#clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    );
    if (body.error === "invalid_grant" || body.error === "invalid_request") {
      throw new GitHubAppUserCredentialError("revoked");
    }
    if (body.error !== undefined) throw new GitHubAppUserCredentialError("provider");
    return this.#credentialFromTokenResponse(body);
  }

  #credentialFromTokenResponse(body: Record<string, unknown>): GitHubAppUserCredential {
    const accessToken = boundedToken(body.access_token);
    const refreshToken = boundedToken(body.refresh_token);
    const expiresIn = secondsFrom(body.expires_in);
    const refreshExpiresIn = secondsFrom(body.refresh_token_expires_in, false);
    if (expiresIn === undefined) throw new GitHubAppUserCredentialError("malformed");
    if (body.token_type !== undefined && body.token_type !== "bearer") {
      throw new GitHubAppUserCredentialError("malformed");
    }
    const now = this.#now();
    return createAppUserCredential({
      accessToken,
      refreshToken,
      accessTokenExpiresAt: isoFromNow(now, expiresIn),
      ...(refreshExpiresIn === undefined ? {} : { refreshTokenExpiresAt: isoFromNow(now, refreshExpiresIn) }),
    });
  }

  async #request(
    path: "/login/device/code" | "/login/oauth/access_token",
    body: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#oauthBaseUrl}${path}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await responseBodyText(response, controller.signal);
      const parsed = parseJson(text);
      if (response.status < 200 || response.status >= 300) {
        throw new GitHubAppUserCredentialError("provider", response.status);
      }
      return parsed;
    } catch (error: unknown) {
      if (error instanceof GitHubAppUserCredentialError) throw error;
      throw new GitHubAppUserCredentialError(controller.signal.aborted ? "transport" : "transport");
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Compatibility names used by embedders that call this a Device Flow client. */
export const GitHubAppUserCredentialClient = GitHubAppDeviceFlowClient;
export const AppUserCredentialClient = GitHubAppDeviceFlowClient;
