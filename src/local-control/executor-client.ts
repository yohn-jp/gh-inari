import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { AuthorizedExecution, AuthorizedExecutionResult } from "../authorized-execution.js";
import type { RepositoryIdentity } from "../github/effect-authorizer.js";
import type { ExecutorExecutionPort } from "../runtime-contracts/ports.js";
import type { PeerCertificate } from "node:tls";
import {
  LOCAL_EXECUTOR_BRANCH_POLICY_PATH,
  LOCAL_EXECUTOR_EVIDENCE_PATH,
  LOCAL_EXECUTOR_GOVERNED_CONTRACT_PATH,
  LOCAL_EXECUTOR_EXECUTIONS_PATH,
  LOCAL_EXECUTOR_HEALTH_PATH,
  LOCAL_EXECUTOR_PROTOCOL_VERSION,
  LOCAL_EXECUTOR_REPOSITORY_PATH,
  MAX_LOCAL_EXECUTOR_BODY_BYTES,
  type LocalExecutorBranchPolicyRequest,
  type LocalExecutorEvidenceRequest,
  type LocalExecutorGovernedContractRequest,
} from "./executor-http.js";
import { verifyLocalMtlsPeerIdentity, type LocalMtlsIdentity } from "./transport-security.js";
import {
  runtimeFailure,
  validateRuntimeFailure,
  type RuntimeFailure,
  type RuntimeFailureStage,
} from "../runtime-contracts/runtime-failure.js";
import { validateImplementationTaskTerminationRecord } from "../implementation-task-termination.js";

export interface LocalExecutorClientOptions {
  readonly id: string;
  readonly endpoint: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly transport?: LocalMtlsIdentity;
  /** Deadline for readiness and other local control requests. */
  readonly timeoutMs?: number;
  /** Deadline for provider-backed repository, evidence, policy and contract reads. */
  readonly providerTimeoutMs?: number;
  /** Deadline for a dispatched authorized execution request. */
  readonly executionTimeoutMs?: number;
  /** Injectable timer seam for deterministic transport deadline tests. */
  readonly timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
  /** Optional response progress observer; reports byte counts without exposing body data. */
  readonly onResponseBodyChunkRead?: (byteLength: number) => void;
}

const DEFAULT_CONTROL_TIMEOUT_MS = 10_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;
const MAX_CONTROL_TIMEOUT_MS = 60_000;
const MAX_PROVIDER_TIMEOUT_MS = 60_000;
const MAX_EXECUTION_TIMEOUT_MS = 60_000;

type RequestBudget = "control" | "provider" | "execution";

interface RequestResources {
  readonly timeoutError: LocalExecutorClientError;
  readonly onResponseBodyChunkRead?: (byteLength: number) => void;
  timedOut: boolean;
  request?: ClientRequest;
  incoming?: IncomingMessage;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
}

export interface LocalExecutorHealth {
  readonly ok: true;
  readonly version: string;
  readonly component: "executor";
  readonly executorId: string;
  readonly protocol: typeof LOCAL_EXECUTOR_PROTOCOL_VERSION;
  readonly readiness: "ready";
}

export class LocalExecutorClientError extends Error {
  readonly code:
    "EXECUTOR_UNAVAILABLE" | "EXECUTOR_IDENTITY_MISMATCH" | "EXECUTOR_PROTOCOL_INVALID" | "EXECUTOR_TIMEOUT";
  /** Bounded Executor owner diagnostic, forwarded only when it validates against the catalog. */
  readonly runtimeFailure?: RuntimeFailure;

  constructor(code: LocalExecutorClientError["code"], message: string, runtimeFailure?: RuntimeFailure) {
    super(message);
    this.name = "LocalExecutorClientError";
    this.code = code;
    if (runtimeFailure !== undefined) this.runtimeFailure = runtimeFailure;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validTaskTerminationObservation(
  value: unknown,
  authorization: LocalExecutorEvidenceRequest["taskTerminationAuthorization"],
): boolean {
  if (authorization === undefined || !record(value) || !Array.isArray(value.recordProvenance)) return false;
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 80_000 || value.recordProvenance.length > 16)
    return false;
  if (
    !value.recordProvenance.every(
      (item: unknown) =>
        record(item) &&
        Object.keys(item).length <= 4 &&
        (item.valid === false
          ? Object.keys(item).length === 1
          : Object.values(item).every((entry) => typeof entry === "string" && entry.length <= 128)),
    )
  )
    return false;
  const validProvenance =
    record(value.provenance) &&
    Object.keys(value.provenance).length >= 1 &&
    Object.keys(value.provenance).length <= 4 &&
    Object.values(value.provenance).every(
      (entry) => typeof entry === "string" && entry.length >= 1 && entry.length <= 128,
    );
  if (value.provenance !== undefined && !validProvenance) return false;
  const common = ["status", "provenance", "recordProvenance"];
  if (value.status === "present")
    return (
      validProvenance &&
      value.recordProvenance.length >= 1 &&
      exactKeys(value, [...common, "record"]) &&
      validateImplementationTaskTerminationRecord(value.record, authorization).valid
    );
  if (value.status === "absent" || value.status === "unavailable")
    return validProvenance && value.recordProvenance.length === 0 && exactKeys(value, common);
  return (
    value.status === "invalid" &&
    exactKeys(value, [...common, "violations"]) &&
    Array.isArray(value.violations) &&
    value.violations.length > 0 &&
    value.violations.length <= 64 &&
    value.violations.every(
      (violation: unknown) =>
        record(violation) &&
        exactKeys(violation, ["code", "path", "message", "expected", "actual"]) &&
        typeof violation.code === "string" &&
        typeof violation.path === "string" &&
        typeof violation.message === "string",
    )
  );
}

function boundedTimeout(value: number | undefined, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError(`Executor ${name} timeout is invalid.`);
  return value;
}

function cancelResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

async function readJson(response: Response, resources: RequestResources): Promise<unknown> {
  if (!/^application\/json(?:\s*;|\s*$)/iu.test(response.headers.get("content-type") ?? "")) {
    cancelResponseBody(response);
    throw new LocalExecutorClientError("EXECUTOR_PROTOCOL_INVALID", "Executor response is not JSON.");
  }
  if (response.body === null)
    throw new LocalExecutorClientError("EXECUTOR_PROTOCOL_INVALID", "Executor response body is empty.");
  const reader = response.body.getReader();
  resources.reader = reader;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      resources.onResponseBodyChunkRead?.(chunk.value.byteLength);
      total += chunk.value.byteLength;
      if (total > MAX_LOCAL_EXECUTOR_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new LocalExecutorClientError("EXECUTOR_PROTOCOL_INVALID", "Executor response exceeds the size limit.");
      }
      chunks.push(chunk.value);
    }
  } catch (error: unknown) {
    if (error instanceof LocalExecutorClientError) throw error;
    throw new LocalExecutorClientError("EXECUTOR_UNAVAILABLE", "Executor response body could not be read.");
  } finally {
    if (resources.reader === reader) resources.reader = undefined;
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")) as unknown;
  } catch {
    throw new LocalExecutorClientError("EXECUTOR_PROTOCOL_INVALID", "Executor response is malformed JSON.");
  }
}

/**
 * Neutral client of the local Executor wire protocol. Admission reaches the
 * Executor only through this client; it never loads Executor internals.
 */
export class LocalExecutorClient implements ExecutorExecutionPort {
  private readonly id: string;
  private readonly endpoint: URL;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly transport: LocalMtlsIdentity | undefined;
  private readonly controlTimeoutMs: number;
  private readonly providerTimeoutMs: number;
  private readonly executionTimeoutMs: number;
  private readonly timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
  private readonly onResponseBodyChunkRead: ((byteLength: number) => void) | undefined;

  constructor(options: LocalExecutorClientOptions) {
    if (typeof options.id !== "string" || !/^exec_[A-Za-z0-9_-]{16,64}$/u.test(options.id))
      throw new TypeError("Configured Executor identity is invalid.");
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw new TypeError("Configured Executor endpoint is invalid.");
    }
    if (
      (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.username ||
      endpoint.password
    ) {
      throw new TypeError("Configured Executor endpoint must use a loopback destination.");
    }
    if ((endpoint.protocol === "https:") !== (options.transport !== undefined)) {
      throw new TypeError("HTTPS Executor endpoints require a configured mTLS identity.");
    }
    if (
      options.transport !== undefined &&
      (options.transport.peerRole !== "executor" || options.transport.peerId !== options.id)
    ) {
      throw new TypeError("Configured Executor TLS identity does not match the pinned Executor.");
    }
    this.id = options.id;
    this.endpoint = endpoint;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.transport = options.transport;
    this.controlTimeoutMs = boundedTimeout(
      options.timeoutMs,
      DEFAULT_CONTROL_TIMEOUT_MS,
      MAX_CONTROL_TIMEOUT_MS,
      "control",
    );
    this.providerTimeoutMs = boundedTimeout(
      options.providerTimeoutMs,
      DEFAULT_PROVIDER_TIMEOUT_MS,
      MAX_PROVIDER_TIMEOUT_MS,
      "provider",
    );
    this.executionTimeoutMs = boundedTimeout(
      options.executionTimeoutMs,
      DEFAULT_EXECUTION_TIMEOUT_MS,
      MAX_EXECUTION_TIMEOUT_MS,
      "execution",
    );
    this.timers = options.timers ?? globalThis;
    this.onResponseBodyChunkRead = options.onResponseBodyChunkRead;
  }

  private url(path: string): string {
    return new URL(path, this.endpoint).toString();
  }

  private async request(
    path: string,
    init?: RequestInit,
    budget: RequestBudget = "control",
    timeoutStage: RuntimeFailureStage = "trust-evidence",
    timeoutReason: "EXECUTOR_REQUEST_TIMEOUT" | "EXECUTOR_EXECUTION_TIMEOUT" = "EXECUTOR_REQUEST_TIMEOUT",
  ): Promise<{ readonly response: Response; readonly body: unknown }> {
    const timeoutMs =
      budget === "control"
        ? this.controlTimeoutMs
        : budget === "provider"
          ? this.providerTimeoutMs
          : this.executionTimeoutMs;
    const timeoutError = new LocalExecutorClientError(
      "EXECUTOR_TIMEOUT",
      budget === "execution"
        ? "Executor execution response deadline expired; the provider effect outcome is unknown."
        : "Executor request exceeded its bounded deadline.",
      runtimeFailure(timeoutStage, timeoutReason),
    );
    const controller = new AbortController();
    const resources: RequestResources = {
      timeoutError,
      onResponseBodyChunkRead: this.onResponseBodyChunkRead,
      timedOut: false,
    };
    let rejectDeadline!: (error: LocalExecutorClientError) => void;
    const deadline = new Promise<never>((_resolve, reject) => (rejectDeadline = reject));
    const timer = this.timers.setTimeout(() => {
      resources.timedOut = true;
      controller.abort(timeoutError);
      void resources.reader?.cancel().catch(() => {});
      resources.incoming?.destroy();
      resources.request?.destroy();
      rejectDeadline(timeoutError);
    }, timeoutMs);

    const operation = (async (): Promise<{ readonly response: Response; readonly body: unknown }> => {
      let response: Response;
      try {
        response =
          this.transport === undefined
            ? await this.fetcher(this.url(path), { ...init, redirect: "error", signal: controller.signal })
            : await this.requestOverMtls(path, init, this.transport, resources);
      } catch {
        if (resources.timedOut) throw timeoutError;
        throw new LocalExecutorClientError("EXECUTOR_UNAVAILABLE", "Configured Executor endpoint is unavailable.");
      }
      if (resources.timedOut) {
        cancelResponseBody(response);
        throw timeoutError;
      }
      if (response.url.length > 0 && new URL(response.url).origin !== this.endpoint.origin) {
        cancelResponseBody(response);
        throw new LocalExecutorClientError(
          "EXECUTOR_IDENTITY_MISMATCH",
          "Executor response came from another endpoint.",
        );
      }
      const body = await readJson(response, resources);
      if (response.status !== 200 && record(body) && body.ok === false && record(body.error)) {
        const failure = validateRuntimeFailure(body.error.failure);
        throw new LocalExecutorClientError("EXECUTOR_UNAVAILABLE", "Executor refused the request.", failure);
      }
      return { response, body };
    })();

    try {
      return await Promise.race([operation, deadline]);
    } catch (error: unknown) {
      if (resources.timedOut) throw timeoutError;
      throw error;
    } finally {
      this.timers.clearTimeout(timer);
      resources.reader = undefined;
      resources.incoming = undefined;
      resources.request = undefined;
    }
  }

  private requestOverMtls(
    path: string,
    init: RequestInit | undefined,
    transport: LocalMtlsIdentity,
    resources: RequestResources,
  ): Promise<Response> {
    const url = new URL(path, this.endpoint);
    const headers = new Headers(init?.headers);
    const requestHeaders: Record<string, string> = {};
    headers.forEach((value, name) => {
      requestHeaders[name] = value;
    });
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      let request: ClientRequest;
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      request = httpsRequest(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
          headers: requestHeaders,
          cert: transport.certificate,
          key: transport.privateKey,
          ca: transport.caCertificate,
          rejectUnauthorized: true,
          checkServerIdentity: (_hostname: string, peer: PeerCertificate) =>
            verifyLocalMtlsPeerIdentity(peer, "executor", transport.peerId)
              ? undefined
              : new Error("Executor TLS identity does not match configuration."),
        },
        (incoming) => {
          resources.incoming = incoming;
          if (resources.timedOut) {
            incoming.destroy();
            return;
          }
          if (settled) {
            incoming.destroy();
            return;
          }
          settled = true;
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) responseHeaders.set(name, value.join(", "));
            else if (value !== undefined) responseHeaders.set(name, value);
          }
          resolve(
            new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
              status: incoming.statusCode ?? 502,
              headers: responseHeaders,
            }),
          );
        },
      );
      resources.request = request;
      request.once("error", onError);
      request.once("close", () => request.off("error", onError));
      const body = init?.body;
      if (resources.timedOut) {
        request.destroy();
      } else {
        if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) request.write(body);
        request.end();
      }
    });
  }

  private assertIdentity(body: unknown): asserts body is Record<string, unknown> {
    if (!record(body) || body.executorId !== this.id) {
      throw new LocalExecutorClientError(
        "EXECUTOR_IDENTITY_MISMATCH",
        "Executor identity does not match configuration.",
      );
    }
    if (body.protocol !== LOCAL_EXECUTOR_PROTOCOL_VERSION || body.component !== "executor")
      throw new LocalExecutorClientError("EXECUTOR_PROTOCOL_INVALID", "Executor protocol is unsupported.");
  }

  async verifyReady(): Promise<LocalExecutorHealth> {
    const { response, body } = await this.request(LOCAL_EXECUTOR_HEALTH_PATH, { method: "GET" }, "control");
    this.assertIdentity(body);
    if (
      response.status !== 200 ||
      !exactKeys(body, ["ok", "version", "component", "executorId", "protocol", "readiness"]) ||
      body.ok !== true ||
      typeof body.version !== "string" ||
      body.readiness !== "ready"
    ) {
      throw new LocalExecutorClientError("EXECUTOR_UNAVAILABLE", "Configured Executor is not ready.");
    }
    return body as unknown as LocalExecutorHealth;
  }

  async resolveRepository(repositoryNameWithOwner: string): Promise<RepositoryIdentity> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repositoryNameWithOwner)) {
      throw new LocalExecutorClientError("EXECUTOR_PROTOCOL_INVALID", "Repository locator is invalid.");
    }
    const { response, body } = await this.request(
      LOCAL_EXECUTOR_REPOSITORY_PATH,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: LOCAL_EXECUTOR_PROTOCOL_VERSION, repositoryNameWithOwner }),
      },
      "provider",
      "repository-resolution",
    );
    this.assertIdentity(body);
    const repository = record(body.repository) ? body.repository : undefined;
    if (
      response.status !== 200 ||
      !exactKeys(body, ["ok", "component", "executorId", "protocol", "repository"]) ||
      body.ok !== true ||
      repository === undefined ||
      !exactKeys(repository, ["repositoryHost", "repositoryId", "repositoryNameWithOwner"]) ||
      repository.repositoryHost !== "github.com" ||
      typeof repository.repositoryId !== "string" ||
      !/^[1-9][0-9]{0,19}$/u.test(repository.repositoryId) ||
      typeof repository.repositoryNameWithOwner !== "string" ||
      repository.repositoryNameWithOwner.toLocaleLowerCase("en-US") !==
        repositoryNameWithOwner.toLocaleLowerCase("en-US")
    ) {
      throw new LocalExecutorClientError("EXECUTOR_UNAVAILABLE", "Repository identity could not be resolved.");
    }
    return {
      repositoryHost: "github.com",
      repositoryId: repository.repositoryId,
      nameWithOwner: repository.repositoryNameWithOwner,
    };
  }

  async readEvidence(request: LocalExecutorEvidenceRequest): Promise<unknown> {
    const { response, body } = await this.request(
      LOCAL_EXECUTOR_EVIDENCE_PATH,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
      "provider",
      "trust-evidence",
    );
    this.assertIdentity(body);
    if (
      response.status !== 200 ||
      !exactKeys(body, ["ok", "component", "executorId", "protocol", "evidence"]) ||
      body.ok !== true ||
      !Object.prototype.hasOwnProperty.call(body, "evidence")
    ) {
      throw new LocalExecutorClientError("EXECUTOR_UNAVAILABLE", "Current Executor evidence is unavailable.");
    }
    if (
      request.taskTerminationAuthorization !== undefined &&
      (!record(body.evidence) ||
        !record(body.evidence.repository) ||
        body.evidence.repository.repositoryHost !== "github.com" ||
        body.evidence.repository.repositoryId !== request.repository.id ||
        typeof body.evidence.repository.nameWithOwner !== "string" ||
        body.evidence.repository.nameWithOwner.toLowerCase() !== request.repository.name.toLowerCase() ||
        !record(body.evidence.implementation) ||
        !record(body.evidence.implementation.implementation) ||
        body.evidence.implementation.implementation.number !== request.implementationIssue ||
        body.evidence.implementation.implementation.repositoryId !== request.repository.id ||
        body.evidence.implementation.implementation.repositoryHost !== "github.com" ||
        typeof body.evidence.implementation.implementation.repository !== "string" ||
        body.evidence.implementation.implementation.repository.toLowerCase() !==
          request.repository.name.toLowerCase() ||
        !validTaskTerminationObservation(body.evidence.taskTermination, request.taskTerminationAuthorization))
    ) {
      throw new LocalExecutorClientError("EXECUTOR_PROTOCOL_INVALID", "Current task termination evidence is invalid.");
    }
    return body.evidence;
  }

  async readGovernedContract(request: LocalExecutorGovernedContractRequest): Promise<unknown> {
    const { response, body } = await this.request(
      LOCAL_EXECUTOR_GOVERNED_CONTRACT_PATH,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
      "provider",
      "trust-evidence",
    );
    this.assertIdentity(body);
    if (
      response.status !== 200 ||
      !exactKeys(body, ["ok", "component", "executorId", "protocol", "contract"]) ||
      body.ok !== true ||
      !record(body.contract)
    ) {
      throw new LocalExecutorClientError("EXECUTOR_UNAVAILABLE", "Repository-governed contract is unavailable.");
    }
    return body.contract;
  }

  async readBranchPolicy(request: LocalExecutorBranchPolicyRequest): Promise<unknown> {
    const { response, body } = await this.request(
      LOCAL_EXECUTOR_BRANCH_POLICY_PATH,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
      "provider",
      "trust-evidence",
    );
    this.assertIdentity(body);
    if (
      response.status !== 200 ||
      !exactKeys(body, ["ok", "component", "executorId", "protocol", "branchPolicy"]) ||
      body.ok !== true ||
      !record(body.branchPolicy)
    ) {
      throw new LocalExecutorClientError("EXECUTOR_UNAVAILABLE", "Current branch policy is unavailable.");
    }
    return body.branchPolicy;
  }

  async execute(execution: AuthorizedExecution): Promise<AuthorizedExecutionResult> {
    const { response, body } = await this.request(
      LOCAL_EXECUTOR_EXECUTIONS_PATH,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(execution),
      },
      "execution",
      "provider-execution",
      "EXECUTOR_EXECUTION_TIMEOUT",
    );
    this.assertIdentity(body);
    if (
      response.status !== 200 ||
      !exactKeys(body, ["ok", "component", "executorId", "protocol", "result"]) ||
      body.ok !== true ||
      !record(body.result)
    ) {
      throw new LocalExecutorClientError("EXECUTOR_UNAVAILABLE", "Authorized execution was not accepted by Executor.");
    }
    return body.result as unknown as AuthorizedExecutionResult;
  }
}
