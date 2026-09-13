/**
 * Cloudflare Worker entrypoint for the stateless direct Inari App deployment
 * (#468). This module owns deployment/composition only: environment/secret
 * validation, exposing the frozen #377 `POST /v1/execute` transport, and a
 * bounded non-secret `/healthz`. It performs no authentication, capability
 * admission, Change, or branch semantics of its own -- all of that remains
 * owned by the existing #377/#464/#465/#466 authorities this module wires
 * together through `createDirectAppSessionExecutor`.
 *
 * App ID/private key are read only from Worker secret bindings. Installation
 * ID and the target repository locator are non-secret deployment
 * configuration. No caller input can override any of these values: they are
 * never read from the request.
 */

import { createDirectAppSessionExecutor } from "./github/direct-app-execution.js";
import {
  createDirectAppHttpHandler,
  DIRECT_APP_EXECUTE_PATH,
  DIRECT_APP_HTTP_CONTRACT_VERSION,
} from "./agent-authority/direct-app-http.js";

/** Cloudflare Worker secret and non-secret environment bindings. */
export interface Env {
  /** Worker secret. GitHub App numeric identity. Never caller input. */
  readonly INARI_GITHUB_APP_ID: string;
  /** Worker secret. GitHub App private key, PEM-encoded. Never caller input. */
  readonly INARI_GITHUB_APP_PRIVATE_KEY: string;
  /** Non-secret deployment configuration. GitHub App installation identity. */
  readonly INARI_GITHUB_APP_INSTALLATION_ID: string;
  /** Non-secret deployment configuration. Fixed target repository owner. */
  readonly INARI_TARGET_REPOSITORY_OWNER: string;
  /** Non-secret deployment configuration. Fixed target repository name. */
  readonly INARI_TARGET_REPOSITORY_NAME: string;
  /** Non-secret deployment configuration. Defaults to "github.com". */
  readonly INARI_TARGET_REPOSITORY_HOST?: string;
  /** Non-secret deployment configuration. Skips one installation lookup round trip when set. */
  readonly INARI_TARGET_REPOSITORY_NODE_ID?: string;
  /** Non-secret deployment configuration. Defaults to the public GitHub API origin. */
  readonly INARI_GITHUB_API_URL?: string;
  /** Non-secret deployment configuration. Bounded downward/upward only within the transport's compile-time ceiling. */
  readonly INARI_MAX_BODY_BYTES?: string;
  /** Non-secret deployment configuration. Bounded GitHub provider request deadline (ms). Defaults to 10s; hard ceiling 30s. */
  readonly INARI_GITHUB_API_REQUEST_TIMEOUT_MS?: string;
}

const DEFAULT_REPOSITORY_HOST = "github.com";
const MAX_SHORT_ENV_LENGTH = 64;
const MAX_HOST_LENGTH = 255;
const MAX_OWNER_OR_NAME_LENGTH = 255;
const MAX_API_URL_LENGTH = 2_048;
const MAX_PRIVATE_KEY_LENGTH = 16_384;

/** Stable, deliberately non-sensitive failure raised for invalid Worker configuration. */
class WorkerConfigurationError extends Error {
  constructor() {
    super("Worker environment configuration is invalid or incomplete.");
    this.name = "WorkerConfigurationError";
  }
}

function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new WorkerConfigurationError();
  }
  return value;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, maxLength);
}

function optionalPositiveInteger(value: unknown): number | undefined {
  const raw = optionalString(value, 16);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new WorkerConfigurationError();
  return parsed;
}

interface WorkerRuntime {
  readonly handler: (request: Request) => Promise<Response>;
}

let cachedRuntime: WorkerRuntime | undefined;

function buildRuntime(env: Env): WorkerRuntime {
  const appId = requiredString(env.INARI_GITHUB_APP_ID, MAX_SHORT_ENV_LENGTH);
  const installationId = requiredString(env.INARI_GITHUB_APP_INSTALLATION_ID, MAX_SHORT_ENV_LENGTH);
  const privateKeyPem = requiredString(env.INARI_GITHUB_APP_PRIVATE_KEY, MAX_PRIVATE_KEY_LENGTH);
  const owner = requiredString(env.INARI_TARGET_REPOSITORY_OWNER, MAX_OWNER_OR_NAME_LENGTH);
  const name = requiredString(env.INARI_TARGET_REPOSITORY_NAME, MAX_OWNER_OR_NAME_LENGTH);
  const hostname = optionalString(env.INARI_TARGET_REPOSITORY_HOST, MAX_HOST_LENGTH) ?? DEFAULT_REPOSITORY_HOST;
  const repositoryNodeId = optionalString(env.INARI_TARGET_REPOSITORY_NODE_ID, MAX_OWNER_OR_NAME_LENGTH);
  const apiUrl = optionalString(env.INARI_GITHUB_API_URL, MAX_API_URL_LENGTH);
  const maxBodyBytes = optionalPositiveInteger(env.INARI_MAX_BODY_BYTES);
  const requestTimeoutMs = optionalPositiveInteger(env.INARI_GITHUB_API_REQUEST_TIMEOUT_MS);
  const executor = createDirectAppSessionExecutor({
    appId,
    installationId,
    privateKeyPem,
    repository: { hostname, owner, name },
    ...(repositoryNodeId === undefined ? {} : { repositoryNodeId }),
    ...(apiUrl === undefined ? {} : { apiUrl }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });
  const handler = createDirectAppHttpHandler({
    executor,
    ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
  });
  return Object.freeze({ handler });
}

type RuntimeResolution = { readonly ok: true; readonly runtime: WorkerRuntime } | { readonly ok: false };

/** Fail closed on missing/malformed secrets or configuration; never throws. */
function resolveRuntime(env: Env): RuntimeResolution {
  if (cachedRuntime !== undefined) return { ok: true, runtime: cachedRuntime };
  try {
    cachedRuntime = buildRuntime(env);
    return { ok: true, runtime: cachedRuntime };
  } catch {
    return { ok: false };
  }
}

function configurationFailureResponse(): Response {
  return new Response(
    JSON.stringify({
      version: DIRECT_APP_HTTP_CONTRACT_VERSION,
      ok: false,
      error: { code: "WORKER_CONFIGURATION_INVALID", message: "Worker configuration is invalid or incomplete." },
    }),
    { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

/**
 * Bounded non-secret build/readiness metadata only. Never resolves or lists
 * installations, Runtime authorities, certificates, or repository policy.
 */
function healthzResponse(env: Env): Response {
  const resolution = resolveRuntime(env);
  const body = {
    ok: resolution.ok,
    service: "gh-inari-direct-app-worker",
    contractVersion: DIRECT_APP_HTTP_CONTRACT_VERSION,
    executePath: DIRECT_APP_EXECUTE_PATH,
  };
  return new Response(JSON.stringify(body), {
    status: resolution.ok ? 200 : 503,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function safePathname(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (safePathname(request.url) === "/healthz") return healthzResponse(env);
    const resolution = resolveRuntime(env);
    if (!resolution.ok) return configurationFailureResponse();
    return resolution.runtime.handler(request);
  },
};
