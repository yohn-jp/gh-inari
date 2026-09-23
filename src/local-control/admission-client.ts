import { randomUUID } from "node:crypto";
import {
  changeMutationRequest,
  changeReadRequest,
  type ChangeExecutionPort,
  type ChangeMutationRequest,
  type ChangeReadRequest,
} from "../change-execution-port.js";
import type { AuthorizedExecutionOperation, AuthorizedExecutionResult } from "../authorized-execution.js";
import type { LocalSessionBinding } from "./session-binding.js";
import {
  LOCAL_ADMISSION_EXECUTIONS_PATH,
  LOCAL_ADMISSION_PROTOCOL_VERSION,
  LOCAL_ADMISSION_SESSION_ID_HEADER,
  LOCAL_ADMISSION_SESSIONS_PATH,
} from "./admission-server.js";
import { validateExecutionIntent, type ExecutionIntent } from "./execution-intent.js";
import { readLocalJson, validateLocalCliConfig, type LocalAdmissionRoute } from "./config.js";

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_SESSION_BINDING_BYTES = 16 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

export class LocalAdmissionClientError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "LocalAdmissionClientError";
    this.code = code;
    this.status = status;
  }
}

export interface LocalAdmissionClient {
  registerSession(binding: LocalSessionBinding): Promise<{ readonly id: string; readonly status: string }>;
  closeSession(binding: LocalSessionBinding): Promise<{ readonly id: string; readonly status: string }>;
  executeIntent(intent: ExecutionIntent, sessionId: string): Promise<unknown>;
}

export interface LocalAdmissionClientOptions {
  readonly endpoint: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

function validLoopbackEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalAdmissionClientError("ADMISSION_ROUTE_INVALID", "Configured Admission route is invalid.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new LocalAdmissionClientError("ADMISSION_ROUTE_INVALID", "Configured Admission must use loopback HTTP.");
  }
  return url.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonBytes(value: unknown, maximum: number): string {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body, "utf8") > maximum) {
    throw new LocalAdmissionClientError("ADMISSION_REQUEST_TOO_LARGE", "Admission request exceeds its size limit.");
  }
  return body;
}

async function responseJson(response: Response): Promise<unknown> {
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch {
    throw new LocalAdmissionClientError("ADMISSION_RESPONSE_INVALID", "Admission response could not be read.");
  }
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new LocalAdmissionClientError("ADMISSION_RESPONSE_TOO_LARGE", "Admission response exceeds its size limit.");
  }
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new LocalAdmissionClientError("ADMISSION_RESPONSE_INVALID", "Admission returned malformed JSON.");
  }
}

function requireEnvelope(value: unknown, status: number): Record<string, unknown> {
  if (!isRecord(value) || value.ok !== true) {
    throw new LocalAdmissionClientError("ADMISSION_REQUEST_DENIED", "Configured Admission denied the request.", status);
  }
  return value;
}

export function createLocalAdmissionClient(options: LocalAdmissionClientOptions): LocalAdmissionClient {
  const endpoint = validLoopbackEndpoint(options.endpoint);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new LocalAdmissionClientError("ADMISSION_TIMEOUT_INVALID", "Admission timeout is invalid.");
  }

  async function request(
    path: string,
    method: "POST" | "DELETE",
    body: unknown,
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const serialized = jsonBytes(
      body,
      path === LOCAL_ADMISSION_SESSIONS_PATH ? MAX_SESSION_BINDING_BYTES + 128 : MAX_RESPONSE_BYTES,
    );
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, endpoint), {
        method,
        headers: {
          "content-type": "application/json",
          ...(sessionId === undefined ? {} : { [LOCAL_ADMISSION_SESSION_ID_HEADER]: sessionId }),
        },
        body: serialized,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new LocalAdmissionClientError("ADMISSION_TRANSPORT_FAILED", "Configured local Admission is unavailable.");
    }
    const parsed = await responseJson(response);
    if (!response.ok) {
      throw new LocalAdmissionClientError(
        "ADMISSION_REQUEST_DENIED",
        "Configured Admission denied the request.",
        response.status,
      );
    }
    return requireEnvelope(parsed, response.status);
  }

  return Object.freeze({
    async registerSession(binding: LocalSessionBinding) {
      const envelope = await request(LOCAL_ADMISSION_SESSIONS_PATH, "POST", {
        version: LOCAL_ADMISSION_PROTOCOL_VERSION,
        binding,
      });
      const session = isRecord(envelope.session) ? envelope.session : undefined;
      if (session === undefined || session.id !== binding.sessionId || session.status !== "active") {
        throw new LocalAdmissionClientError(
          "ADMISSION_RESPONSE_INVALID",
          "Admission returned an invalid Session result.",
        );
      }
      return { id: session.id, status: session.status };
    },
    async closeSession(binding: LocalSessionBinding) {
      if (!SESSION_ID_PATTERN.test(binding.sessionId)) {
        throw new LocalAdmissionClientError("ADMISSION_SESSION_SELECTOR_INVALID", "Session selector is invalid.");
      }
      const envelope = await request(
        `${LOCAL_ADMISSION_SESSIONS_PATH}/${encodeURIComponent(binding.sessionId)}`,
        "DELETE",
        { version: LOCAL_ADMISSION_PROTOCOL_VERSION, binding },
      );
      const session = isRecord(envelope.session) ? envelope.session : undefined;
      if (session === undefined || session.id !== binding.sessionId || session.status !== "closed") {
        throw new LocalAdmissionClientError(
          "ADMISSION_RESPONSE_INVALID",
          "Admission returned an invalid Session result.",
        );
      }
      return { id: session.id, status: session.status };
    },
    async executeIntent(intent: ExecutionIntent, sessionId: string) {
      if (!SESSION_ID_PATTERN.test(sessionId)) {
        throw new LocalAdmissionClientError("ADMISSION_SESSION_SELECTOR_INVALID", "Session selector is invalid.");
      }
      const validation = validateExecutionIntent(intent);
      if (!validation.valid || validation.intent === undefined) {
        throw new LocalAdmissionClientError("ADMISSION_EXECUTION_INTENT_INVALID", "ExecutionIntent is invalid.");
      }
      const envelope = await request(LOCAL_ADMISSION_EXECUTIONS_PATH, "POST", validation.intent, sessionId);
      if (!("result" in envelope)) {
        throw new LocalAdmissionClientError(
          "ADMISSION_RESPONSE_INVALID",
          "Admission returned an invalid execution result.",
        );
      }
      return envelope.result;
    },
  });
}

export function configuredLocalAdmissionTopology(environment: NodeJS.ProcessEnv = process.env): boolean {
  return readLocalJson("cli", "config.json", validateLocalCliConfig, environment) !== undefined;
}

export function configuredLocalAdmissionRoute(
  environment: NodeJS.ProcessEnv = process.env,
): LocalAdmissionRoute | undefined {
  const config = readLocalJson("cli", "config.json", validateLocalCliConfig, environment);
  return config?.admission;
}

export function requireConfiguredLocalAdmissionRoute(
  environment: NodeJS.ProcessEnv = process.env,
): LocalAdmissionRoute {
  const route = configuredLocalAdmissionRoute(environment);
  if (route === undefined) {
    throw new LocalAdmissionClientError(
      "ADMISSION_ROUTE_NOT_CONFIGURED",
      "No Admission route is configured for the local CLI.",
    );
  }
  return route;
}

export function createSessionExecutionIntent(
  binding: LocalSessionBinding,
  operation: AuthorizedExecutionOperation,
  request: unknown,
): ExecutionIntent {
  const candidate: ExecutionIntent = {
    version: 1,
    requestId: randomUUID(),
    repository: {
      repositoryHost: "github.com",
      repositoryId: binding.repository.id,
      repositoryNameWithOwner: binding.repository.name,
    },
    operation,
    request,
  };
  const validation = validateExecutionIntent(candidate);
  if (!validation.valid || validation.intent === undefined) {
    throw new LocalAdmissionClientError("ADMISSION_EXECUTION_INTENT_INVALID", "ExecutionIntent is invalid.");
  }
  return validation.intent;
}

function authorizedResult(value: unknown, operation: string): AuthorizedExecutionResult {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.operation !== operation ||
    (value.status !== "succeeded" && value.status !== "failed")
  ) {
    throw new LocalAdmissionClientError(
      "ADMISSION_RESPONSE_INVALID",
      "Admission returned an invalid execution result.",
    );
  }
  if (value.status !== "succeeded") {
    throw new LocalAdmissionClientError(
      "ADMISSION_EXECUTION_DENIED",
      "Admission did not authorize the Change operation.",
    );
  }
  return value as unknown as AuthorizedExecutionResult;
}

export function createAdmissionChangeExecutionPort(
  client: LocalAdmissionClient,
  binding: LocalSessionBinding,
): ChangeExecutionPort {
  const execute = async (
    operation: AuthorizedExecutionOperation,
    request: unknown,
  ): Promise<AuthorizedExecutionResult> => {
    const intent = createSessionExecutionIntent(binding, operation, request);
    return authorizedResult(await client.executeIntent(intent, binding.sessionId), operation);
  };

  return Object.freeze({
    async read(request: ChangeReadRequest) {
      const result = await execute("change.show", changeReadRequest(request.issue));
      if (result.projection === undefined) {
        throw new LocalAdmissionClientError("ADMISSION_RESPONSE_INVALID", "Admission returned no Change projection.");
      }
      return result.projection;
    },
    async execute(request: ChangeMutationRequest) {
      const safeRequest = changeMutationRequest(
        request.operation,
        request.issue,
        undefined,
        request.operation === "issue" ? request.signedProvenanceRecord : undefined,
        request.mergeStrategy,
      );
      const operation = `change.${request.operation}` as AuthorizedExecutionOperation;
      const result = await execute(operation, safeRequest);
      if (result.execution !== undefined) return result.execution;
      if (result.projection !== undefined) return { projection: result.projection };
      throw new LocalAdmissionClientError("ADMISSION_RESPONSE_INVALID", "Admission returned no Change result.");
    },
  });
}
