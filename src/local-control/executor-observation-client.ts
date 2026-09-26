/**
 * Control-plane client of the Executor owner observation route (#1223).
 *
 * Implements `ExecutorObservationPort` over the existing Executor HTTP
 * transport for an explicitly supplied endpoint and expected Executor ID. A
 * loopback `http:` endpoint uses the existing local policy; any `https:`
 * endpoint, including a separately hosted Executor, requires an explicitly
 * supplied Control mTLS identity pinned to that Executor. The client validates
 * status, exact envelope, Executor identity, protocol and the observation
 * contract, and fails closed. It never reads owner files and never falls back
 * to in-process Executor state.
 */
import {
  validateExecutorObservation,
  type ExecutorObservation,
  type ExecutorObservationPort,
} from "../runtime-contracts/executor-observation.js";
import { requestLocalExecutorOverMtls } from "./executor-client.js";
import {
  LOCAL_EXECUTOR_OWNER_OBSERVATION_PATH,
  LOCAL_EXECUTOR_PROTOCOL_VERSION,
  MAX_LOCAL_EXECUTOR_BODY_BYTES,
} from "./executor-http.js";
import type { LocalMtlsIdentity } from "./transport-security.js";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface ExecutorObservationClientOptions {
  /** Explicit Executor endpoint origin; never discovered or persisted here. */
  readonly endpoint: string;
  /** The Executor configuration ID the caller expects to observe. */
  readonly executorId: string;
  /** Required for `https:` endpoints: the Control identity pinned to `executorId`. */
  readonly transport?: LocalMtlsIdentity;
  /** Loopback `http:` transport only; tests inject it. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export type ExecutorObservationClientErrorCode =
  /** The endpoint could not be reached, refused the request or reported the observation unavailable. */
  | "EXECUTOR_OBSERVATION_UNAVAILABLE"
  /** The authenticated principal is not allowed to observe this Executor. */
  | "EXECUTOR_OBSERVATION_FORBIDDEN"
  /** The response names another Executor or came from another endpoint. */
  | "EXECUTOR_OBSERVATION_IDENTITY_MISMATCH"
  /** Malformed, oversized, unsupported-protocol or contract-invalid response. */
  | "EXECUTOR_OBSERVATION_PROTOCOL_INVALID";

export class ExecutorObservationClientError extends Error {
  readonly code: ExecutorObservationClientErrorCode;

  constructor(code: ExecutorObservationClientErrorCode, message: string) {
    super(message);
    this.name = "ExecutorObservationClientError";
    this.code = code;
  }
}

function failure(code: ExecutorObservationClientErrorCode, message: string): ExecutorObservationClientError {
  return new ExecutorObservationClientError(code, message);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!/^application\/json(?:\s*;|\s*$)/iu.test(response.headers.get("content-type") ?? ""))
    throw failure("EXECUTOR_OBSERVATION_PROTOCOL_INVALID", "Executor observation response is not JSON.");
  if (response.body === null)
    throw failure("EXECUTOR_OBSERVATION_PROTOCOL_INVALID", "Executor observation response is empty.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_LOCAL_EXECUTOR_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw failure("EXECUTOR_OBSERVATION_PROTOCOL_INVALID", "Executor observation response exceeds the size limit.");
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error: unknown) {
    if (error instanceof ExecutorObservationClientError) throw error;
    throw failure("EXECUTOR_OBSERVATION_UNAVAILABLE", "Executor observation response could not be read.");
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw failure("EXECUTOR_OBSERVATION_PROTOCOL_INVALID", "Executor observation response is malformed JSON.");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `ExecutorObservationPort` over the Executor's authenticated HTTP transport. */
export class ExecutorObservationClient implements ExecutorObservationPort {
  readonly #endpoint: URL;
  readonly #executorId: string;
  readonly #transport: LocalMtlsIdentity | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: ExecutorObservationClientOptions) {
    if (typeof options.executorId !== "string" || !/^exec_[A-Za-z0-9_-]{16,64}$/u.test(options.executorId))
      throw new TypeError("Expected Executor identity is invalid.");
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw new TypeError("Executor observation endpoint is invalid.");
    }
    if (
      (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
      endpoint.username.length > 0 ||
      endpoint.password.length > 0 ||
      (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
      endpoint.search.length > 0 ||
      endpoint.hash.length > 0
    )
      throw new TypeError("Executor observation endpoint must be a bare http(s) origin.");
    if (endpoint.protocol === "http:" && endpoint.hostname !== "127.0.0.1")
      throw new TypeError("Unauthenticated Executor observation is limited to the loopback endpoint.");
    if ((endpoint.protocol === "https:") !== (options.transport !== undefined))
      throw new TypeError("HTTPS Executor observation requires an explicit Control mTLS identity.");
    if (
      options.transport !== undefined &&
      (options.transport.peerRole !== "executor" || options.transport.peerId !== options.executorId)
    )
      throw new TypeError("Control TLS identity is not pinned to the expected Executor.");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw new TypeError("Executor observation timeout is invalid.");
    this.#endpoint = endpoint;
    this.#executorId = options.executorId;
    this.#transport = options.transport;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = timeoutMs;
  }

  async observe(): Promise<ExecutorObservation> {
    const url = new URL(LOCAL_EXECUTOR_OWNER_OBSERVATION_PATH, this.#endpoint);
    const init: RequestInit = {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(this.#timeoutMs),
    };
    let response: Response;
    try {
      response =
        this.#transport === undefined
          ? await this.#fetch(url, init)
          : await requestLocalExecutorOverMtls(url, init, this.#transport);
    } catch {
      throw failure("EXECUTOR_OBSERVATION_UNAVAILABLE", "Executor observation endpoint is unavailable.");
    }
    if (response.url.length > 0 && new URL(response.url).origin !== this.#endpoint.origin)
      throw failure("EXECUTOR_OBSERVATION_IDENTITY_MISMATCH", "Executor observation came from another endpoint.");
    if (response.status === 403)
      throw failure("EXECUTOR_OBSERVATION_FORBIDDEN", "The Executor refused owner observation to this principal.");
    const body = await readBoundedJson(response);
    if (response.status !== 200)
      throw failure("EXECUTOR_OBSERVATION_UNAVAILABLE", "Executor owner observation is unavailable.");
    if (
      !record(body) ||
      Object.keys(body).length !== 5 ||
      !["ok", "component", "executorId", "protocol", "observation"].every((key) => key in body) ||
      body.ok !== true ||
      body.component !== "executor"
    )
      throw failure("EXECUTOR_OBSERVATION_PROTOCOL_INVALID", "Executor observation envelope is invalid.");
    if (body.protocol !== LOCAL_EXECUTOR_PROTOCOL_VERSION)
      throw failure("EXECUTOR_OBSERVATION_PROTOCOL_INVALID", "Executor observation protocol is unsupported.");
    if (body.executorId !== this.#executorId)
      throw failure(
        "EXECUTOR_OBSERVATION_IDENTITY_MISMATCH",
        "Executor identity does not match the expected Executor.",
      );
    let observation: ExecutorObservation;
    try {
      observation = validateExecutorObservation(body.observation);
    } catch {
      throw failure("EXECUTOR_OBSERVATION_PROTOCOL_INVALID", "Executor observation violates its contract.");
    }
    if (observation.executorId !== this.#executorId)
      throw failure("EXECUTOR_OBSERVATION_IDENTITY_MISMATCH", "Observed custody belongs to another Executor.");
    return observation;
  }
}
