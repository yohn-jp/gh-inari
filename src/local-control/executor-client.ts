import type { AuthorizedExecution, AuthorizedExecutionResult } from "../authorized-execution.js";
import type { RepositoryIdentity } from "../github/effect-authorizer.js";
import {
  LOCAL_EXECUTOR_EVIDENCE_PATH,
  LOCAL_EXECUTOR_EXECUTIONS_PATH,
  LOCAL_EXECUTOR_HEALTH_PATH,
  LOCAL_EXECUTOR_PROTOCOL_VERSION,
  LOCAL_EXECUTOR_REPOSITORY_PATH,
  MAX_LOCAL_EXECUTOR_BODY_BYTES,
  type LocalExecutorEvidenceRequest,
} from "./executor-http.js";

export interface LocalExecutorClientOptions {
  readonly id: string;
  readonly endpoint: string;
  readonly fetch?: typeof globalThis.fetch;
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
  readonly code: "EXECUTOR_UNAVAILABLE" | "EXECUTOR_IDENTITY_MISMATCH" | "EXECUTOR_PROTOCOL_INVALID";

  constructor(code: LocalExecutorClientError["code"], message: string) {
    super(message);
    this.name = "LocalExecutorClientError";
    this.code = code;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

async function readJson(response: Response): Promise<unknown> {
  if (!/^application\/json(?:\s*;|\s*$)/iu.test(response.headers.get("content-type") ?? ""))
    throw new LocalExecutorClientError("EXECUTOR_PROTOCOL_INVALID", "Executor response is not JSON.");
  if (response.body === null)
    throw new LocalExecutorClientError("EXECUTOR_PROTOCOL_INVALID", "Executor response body is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_LOCAL_EXECUTOR_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new LocalExecutorClientError("EXECUTOR_PROTOCOL_INVALID", "Executor response exceeds the size limit.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")) as unknown;
  } catch {
    throw new LocalExecutorClientError("EXECUTOR_PROTOCOL_INVALID", "Executor response is malformed JSON.");
  }
}

export class LocalExecutorClient {
  private readonly id: string;
  private readonly endpoint: URL;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: LocalExecutorClientOptions) {
    if (typeof options.id !== "string" || !/^exec_[A-Za-z0-9_-]{16,64}$/u.test(options.id))
      throw new TypeError("Configured Executor identity is invalid.");
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw new TypeError("Configured Executor endpoint is invalid.");
    }
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password)
      throw new TypeError("Configured Executor endpoint must be loopback HTTP.");
    this.id = options.id;
    this.endpoint = endpoint;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private url(path: string): string {
    return new URL(path, this.endpoint).toString();
  }

  private async request(
    path: string,
    init?: RequestInit,
  ): Promise<{ readonly response: Response; readonly body: unknown }> {
    let response: Response;
    try {
      response = await this.fetcher(this.url(path), { ...init, redirect: "error" });
    } catch {
      throw new LocalExecutorClientError("EXECUTOR_UNAVAILABLE", "Configured Executor endpoint is unavailable.");
    }
    if (response.url.length > 0 && new URL(response.url).origin !== this.endpoint.origin)
      throw new LocalExecutorClientError("EXECUTOR_IDENTITY_MISMATCH", "Executor response came from another endpoint.");
    const body = await readJson(response);
    return { response, body };
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
    const { response, body } = await this.request(LOCAL_EXECUTOR_HEALTH_PATH, { method: "GET" });
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
    const { response, body } = await this.request(LOCAL_EXECUTOR_REPOSITORY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: LOCAL_EXECUTOR_PROTOCOL_VERSION, repositoryNameWithOwner }),
    });
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
    const { response, body } = await this.request(LOCAL_EXECUTOR_EVIDENCE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    this.assertIdentity(body);
    if (
      response.status !== 200 ||
      !exactKeys(body, ["ok", "component", "executorId", "protocol", "evidence"]) ||
      body.ok !== true ||
      !Object.prototype.hasOwnProperty.call(body, "evidence")
    ) {
      throw new LocalExecutorClientError("EXECUTOR_UNAVAILABLE", "Current Executor evidence is unavailable.");
    }
    return body.evidence;
  }

  async execute(execution: AuthorizedExecution): Promise<AuthorizedExecutionResult> {
    const { response, body } = await this.request(LOCAL_EXECUTOR_EXECUTIONS_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(execution),
    });
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
