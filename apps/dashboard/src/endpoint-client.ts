/**
 * The Dashboard's only repository-data boundary.
 *
 * This module speaks the public Endpoint HTTP contract. It intentionally
 * contains no provider, GitHub, repository, or mutation implementation.
 */

import type { EndpointApiReadOperation, EndpointApiRequest, EndpointApiResult } from "../../../src/endpoint-api.js";
import type { EndpointReadQuery } from "../../../src/endpoint-read-query.js";

const ENDPOINT_API_CONTRACT_VERSION = 1 as const;
const ENDPOINT_API_OPERATION_PATH = "/v1/endpoint" as const;
const ENDPOINT_API_READ_OPERATIONS = ["repository.read", "work.read", "presence.read"] as const;
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type DashboardEndpointReadOperation = EndpointApiReadOperation;
export type DashboardEndpointIdentity = EndpointApiRequest["endpoint"];
export type DashboardInstallationIdentity = EndpointApiRequest["installation"];
export type DashboardRepositoryIdentity = EndpointApiRequest["repository"];
/** Capability claims are validated by the Endpoint, never by Dashboard. */
export type DashboardEndpointCapability = EndpointApiRequest["capability"];

export interface DashboardRepositoryContext {
  readonly endpoint: DashboardEndpointIdentity;
  readonly installation: DashboardInstallationIdentity;
  readonly repository: DashboardRepositoryIdentity;
  readonly capability: DashboardEndpointCapability;
}

export interface DashboardEndpointReadRequest extends DashboardRepositoryContext {
  readonly operation: DashboardEndpointReadOperation;
  /** Optional bounded root selected by the user-facing Endpoint contract. */
  readonly query?: EndpointReadQuery;
  readonly signal?: AbortSignal;
}

export type DashboardEndpointSuccess = Extract<EndpointApiResult, { readonly ok: true }>;
export type DashboardEndpointFailure = Extract<EndpointApiResult, { readonly ok: false }>;
export type DashboardEndpointResult = EndpointApiResult;

export type DashboardEndpointClientErrorCode =
  | "DASHBOARD_ENDPOINT_REQUIRED"
  | "DASHBOARD_ENDPOINT_INVALID"
  | "DASHBOARD_ENDPOINT_REQUEST_FAILED"
  | "DASHBOARD_ENDPOINT_RESPONSE_INVALID";

export class DashboardEndpointClientError extends Error {
  readonly code: DashboardEndpointClientErrorCode;
  readonly status?: number;

  constructor(code: DashboardEndpointClientErrorCode, message: string, status?: number) {
    super(message);
    this.name = "DashboardEndpointClientError";
    this.code = code;
    this.status = status;
  }
}

export interface DashboardEndpointClientOptions {
  /** Shared-hosted or self-hosted Endpoint origin. */
  readonly endpoint: string;
  /** Transport-owned authentication headers, such as an Authorization header. */
  readonly headers?: HeadersInit;
  /** Browser-memory auth session; its access token is never persisted by this client. */
  readonly auth?: {
    readonly getAccessToken: () => string | undefined;
  };
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
}

export interface DashboardEndpointClient {
  read(request: DashboardEndpointReadRequest): Promise<DashboardEndpointResult>;
}

function endpointOrigin(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DashboardEndpointClientError("DASHBOARD_ENDPOINT_REQUIRED", "An Endpoint URL is required.");
  }
  if (value.length > MAX_ENDPOINT_LENGTH) {
    throw new DashboardEndpointClientError("DASHBOARD_ENDPOINT_INVALID", "Endpoint URL exceeds the supported length.");
  }
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error();
    }
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    throw new DashboardEndpointClientError("DASHBOARD_ENDPOINT_INVALID", "Endpoint URL is invalid.");
  }
}

function requestTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) {
    throw new DashboardEndpointClientError("DASHBOARD_ENDPOINT_INVALID", "Endpoint timeout is invalid.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReadOperation(value: unknown): value is DashboardEndpointReadOperation {
  return typeof value === "string" && (ENDPOINT_API_READ_OPERATIONS as readonly string[]).includes(value);
}

function validResult(value: unknown): value is DashboardEndpointResult {
  if (!isRecord(value) || value.version !== ENDPOINT_API_CONTRACT_VERSION || typeof value.ok !== "boolean")
    return false;
  if (value.ok) {
    return (
      isReadOperation(value.operation) &&
      isRecord(value.authorization) &&
      isRecord(value.data) &&
      isRecord(value.data.repository) &&
      Array.isArray(value.data.unavailable)
    );
  }
  return (
    (value.operation === undefined || typeof value.operation === "string") &&
    (value.authorization === undefined || isRecord(value.authorization)) &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    Array.isArray(value.error.diagnostics)
  );
}

async function responseBody(response: Response): Promise<DashboardEndpointResult> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    throw new DashboardEndpointClientError(
      "DASHBOARD_ENDPOINT_RESPONSE_INVALID",
      "Endpoint response could not be read.",
    );
  }
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new DashboardEndpointClientError(
      "DASHBOARD_ENDPOINT_RESPONSE_INVALID",
      "Endpoint response exceeds the supported size.",
      response.status,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new DashboardEndpointClientError(
      "DASHBOARD_ENDPOINT_RESPONSE_INVALID",
      "Endpoint response is not valid JSON.",
      response.status,
    );
  }
  if (!validResult(parsed)) {
    throw new DashboardEndpointClientError(
      "DASHBOARD_ENDPOINT_RESPONSE_INVALID",
      "Endpoint response does not satisfy the authenticated API contract.",
      response.status,
    );
  }
  return parsed;
}

/** Create a read-only client for the authenticated Endpoint contract. */
export function createDashboardEndpointClient(options: DashboardEndpointClientOptions): DashboardEndpointClient {
  const origin = endpointOrigin(options.endpoint);
  const timeoutMs = requestTimeout(options.requestTimeoutMs);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (typeof fetcher !== "function") {
    throw new DashboardEndpointClientError("DASHBOARD_ENDPOINT_REQUEST_FAILED", "A fetch implementation is required.");
  }

  return Object.freeze({
    async read(request: DashboardEndpointReadRequest): Promise<DashboardEndpointResult> {
      if (!isReadOperation(request.operation)) {
        throw new DashboardEndpointClientError(
          "DASHBOARD_ENDPOINT_INVALID",
          "Dashboard requests may only use read operations.",
        );
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abort = () => controller.abort();
      request.signal?.addEventListener("abort", abort, { once: true });
      const headers = new Headers(options.headers);
      if (options.auth !== undefined) {
        headers.delete("authorization");
        const accessToken = options.auth.getAccessToken();
        if (accessToken !== undefined) headers.set("authorization", `Bearer ${accessToken}`);
      }
      headers.set("accept", "application/json");
      headers.set("content-type", "application/json");
      const body = {
        version: ENDPOINT_API_CONTRACT_VERSION,
        operation: request.operation,
        endpoint: request.endpoint,
        installation: request.installation,
        repository: request.repository,
        capability: request.capability,
        ...(request.query === undefined ? {} : { query: request.query }),
      };
      try {
        const response = await fetcher(`${origin}${ENDPOINT_API_OPERATION_PATH}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        return await responseBody(response);
      } catch (error: unknown) {
        if (error instanceof DashboardEndpointClientError) throw error;
        throw new DashboardEndpointClientError("DASHBOARD_ENDPOINT_REQUEST_FAILED", "Endpoint request failed.");
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
      }
    },
  });
}
