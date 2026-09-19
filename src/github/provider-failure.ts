/**
 * Canonical bounded GitHub provider failure classification (#732).
 *
 * This module is deliberately provider-I/O only. It preserves the minimum
 * secret-safe facts needed by higher layers to diagnose and retry failures
 * without carrying raw provider payloads, URLs, headers, exception text, or
 * credentials across authority boundaries.
 */

export const GITHUB_PROVIDER_FAILURE_CLASSES = Object.freeze([
  "authentication",
  "authorization",
  "not-found",
  "conflict",
  "validation",
  "rate-limit",
  "server",
  "timeout",
  "transport",
  "response-invalid",
  "response-limit",
  "provider-rejection",
] as const);

export type GitHubProviderFailureClass = (typeof GITHUB_PROVIDER_FAILURE_CLASSES)[number];

export interface GitHubProviderFailureClassification {
  readonly failureClass: GitHubProviderFailureClass;
  readonly retryable: boolean;
  readonly status?: number;
  readonly timeoutMs?: number;
  readonly limitBytes?: number;
  readonly requestId?: string;
}

const PROVIDER_FAILURE_PROPERTY = "githubProviderFailureClassification";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9:._-]{1,128}$/u;
const ALLOWED_KEYS = new Set(["failureClass", "retryable", "status", "timeoutMs", "limitBytes", "requestId"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function safeStatus(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 100 && Number(value) <= 599 ? Number(value) : undefined;
}

function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

function headerValue(
  headers: Headers | Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && typeof value === "string") return value;
  }
  return undefined;
}

export function normalizeGitHubProviderFailureClassification(
  value: unknown,
): GitHubProviderFailureClassification | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) {
    throw new TypeError("GitHub provider failure classification is malformed.");
  }
  if (
    !GITHUB_PROVIDER_FAILURE_CLASSES.includes(value.failureClass as GitHubProviderFailureClass) ||
    typeof value.retryable !== "boolean"
  ) {
    throw new TypeError("GitHub provider failure classification is malformed.");
  }
  const status = value.status === undefined ? undefined : safeStatus(value.status);
  const timeoutMs = value.timeoutMs === undefined ? undefined : safePositiveInteger(value.timeoutMs);
  const limitBytes = value.limitBytes === undefined ? undefined : safePositiveInteger(value.limitBytes);
  const requestId = value.requestId === undefined ? undefined : safeRequestId(value.requestId);
  if (
    (value.status !== undefined && status === undefined) ||
    (value.timeoutMs !== undefined && timeoutMs === undefined) ||
    (value.limitBytes !== undefined && limitBytes === undefined) ||
    (value.requestId !== undefined && requestId === undefined)
  ) {
    throw new TypeError("GitHub provider failure classification is malformed.");
  }
  return Object.freeze({
    failureClass: value.failureClass as GitHubProviderFailureClass,
    retryable: value.retryable,
    ...(status === undefined ? {} : { status }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(limitBytes === undefined ? {} : { limitBytes }),
    ...(requestId === undefined ? {} : { requestId }),
  });
}

export function githubProviderFailureFromStatus(
  status: number,
  headers?: Headers | Readonly<Record<string, string>>,
): GitHubProviderFailureClassification {
  const normalizedStatus = safeStatus(status);
  if (normalizedStatus === undefined) throw new TypeError("GitHub provider status is invalid.");
  const requestId = safeRequestId(headerValue(headers, "x-github-request-id"));
  const rateLimited =
    normalizedStatus === 429 ||
    (normalizedStatus === 403 &&
      (headerValue(headers, "x-ratelimit-remaining") === "0" || headerValue(headers, "retry-after") !== undefined));
  let failureClass: GitHubProviderFailureClass;
  let retryable = false;
  if (normalizedStatus === 401) failureClass = "authentication";
  else if (rateLimited) {
    failureClass = "rate-limit";
    retryable = true;
  } else if (normalizedStatus === 403) failureClass = "authorization";
  else if (normalizedStatus === 404) failureClass = "not-found";
  else if (normalizedStatus === 409) failureClass = "conflict";
  else if (normalizedStatus === 422) failureClass = "validation";
  else if (normalizedStatus >= 500) {
    failureClass = "server";
    retryable = true;
  } else {
    failureClass = "provider-rejection";
  }
  return Object.freeze({
    failureClass,
    retryable,
    status: normalizedStatus,
    ...(requestId === undefined ? {} : { requestId }),
  });
}

export function githubProviderFailure(
  failureClass: GitHubProviderFailureClass,
  options: {
    readonly retryable: boolean;
    readonly status?: number;
    readonly timeoutMs?: number;
    readonly limitBytes?: number;
    readonly requestId?: string;
  },
): GitHubProviderFailureClassification {
  return normalizeGitHubProviderFailureClassification({ failureClass, ...options })!;
}

export function attachGitHubProviderFailure<T extends Error>(
  error: T,
  classification: GitHubProviderFailureClassification | undefined,
): T {
  if (classification === undefined) return error;
  const normalized = normalizeGitHubProviderFailureClassification(classification)!;
  Object.defineProperty(error, PROVIDER_FAILURE_PROPERTY, {
    configurable: true,
    enumerable: false,
    value: normalized,
    writable: false,
  });
  return error;
}

export function readGitHubProviderFailure(value: unknown): GitHubProviderFailureClassification | undefined {
  if (!isRecord(value)) return undefined;
  try {
    return normalizeGitHubProviderFailureClassification(
      value[PROVIDER_FAILURE_PROPERTY] ?? value.providerFailure,
    );
  } catch {
    return undefined;
  }
}
