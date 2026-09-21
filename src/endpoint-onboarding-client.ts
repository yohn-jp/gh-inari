/** Native, public Endpoint onboarding metadata client. */

import {
  decodeEndpointOnboardingDescriptor,
  ENDPOINT_ONBOARDING_PATH,
  type EndpointOnboardingDescriptor,
} from "./endpoint-onboarding.js";

const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_RESPONSE_BYTES = 128 * 1024;

export type EndpointOnboardingClientErrorCode =
  | "ENDPOINT_ONBOARDING_ENDPOINT_REQUIRED"
  | "ENDPOINT_ONBOARDING_ENDPOINT_INVALID"
  | "ENDPOINT_ONBOARDING_REQUEST_FAILED"
  | "ENDPOINT_ONBOARDING_RESPONSE_INVALID";

export class EndpointOnboardingClientError extends Error {
  readonly code: EndpointOnboardingClientErrorCode;
  readonly status?: number;

  constructor(code: EndpointOnboardingClientErrorCode, message: string, status?: number) {
    super(message);
    this.name = "EndpointOnboardingClientError";
    this.code = code;
    this.status = status;
  }
}

export interface EndpointOnboardingClientOptions {
  readonly endpoint: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
}

function endpointOrigin(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EndpointOnboardingClientError(
      "ENDPOINT_ONBOARDING_ENDPOINT_REQUIRED",
      "An Endpoint URL is required for repository setup.",
    );
  }
  if (value.length > MAX_ENDPOINT_LENGTH) {
    throw new EndpointOnboardingClientError(
      "ENDPOINT_ONBOARDING_ENDPOINT_INVALID",
      "Endpoint URL exceeds the supported length.",
    );
  }
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error();
    }
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    throw new EndpointOnboardingClientError("ENDPOINT_ONBOARDING_ENDPOINT_INVALID", "Endpoint URL is invalid.");
  }
}

function timeout(value: number | undefined): number {
  if (value === undefined) return 10_000;
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) {
    throw new EndpointOnboardingClientError("ENDPOINT_ONBOARDING_ENDPOINT_INVALID", "Endpoint timeout is invalid.");
  }
  return value;
}

/** Resolve and validate the public descriptor at an Endpoint origin. */
export async function fetchEndpointOnboardingDescriptor(
  options: EndpointOnboardingClientOptions,
): Promise<EndpointOnboardingDescriptor> {
  const origin = endpointOrigin(options.endpoint);
  const requestTimeoutMs = timeout(options.requestTimeoutMs);
  const fetcher = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetcher(`${origin}${ENDPOINT_ONBOARDING_PATH}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
      throw new EndpointOnboardingClientError(
        "ENDPOINT_ONBOARDING_RESPONSE_INVALID",
        "Endpoint onboarding metadata exceeds the supported size.",
      );
    }
    if (!response.ok) {
      throw new EndpointOnboardingClientError(
        "ENDPOINT_ONBOARDING_REQUEST_FAILED",
        "Endpoint onboarding metadata could not be fetched.",
        response.status,
      );
    }
    try {
      return decodeEndpointOnboardingDescriptor(body);
    } catch {
      throw new EndpointOnboardingClientError(
        "ENDPOINT_ONBOARDING_RESPONSE_INVALID",
        "Endpoint onboarding metadata is invalid.",
      );
    }
  } catch (error: unknown) {
    if (error instanceof EndpointOnboardingClientError) throw error;
    throw new EndpointOnboardingClientError(
      "ENDPOINT_ONBOARDING_REQUEST_FAILED",
      "Endpoint onboarding request failed.",
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Small class form for embedders that prefer an explicit client object. */
export class EndpointOnboardingClient {
  readonly #options: EndpointOnboardingClientOptions;

  constructor(options: EndpointOnboardingClientOptions) {
    this.#options = { ...options };
  }

  fetchDescriptor(): Promise<EndpointOnboardingDescriptor> {
    return fetchEndpointOnboardingDescriptor(this.#options);
  }
}

export function createEndpointOnboardingClient(options: EndpointOnboardingClientOptions): EndpointOnboardingClient {
  return new EndpointOnboardingClient(options);
}

export const fetchEndpointDescriptor = fetchEndpointOnboardingDescriptor;
