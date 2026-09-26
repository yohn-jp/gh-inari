import { performance } from "node:perf_hooks";
import {
  createAuthorizedExecution,
  type AuthorizedExecution,
  type AuthorizedExecutionResult,
} from "../authorized-execution.js";
import { DELEGATOR_ID_PATTERN } from "../agent-authority/delegator.js";
import type { SessionCertificateRepository } from "../agent-authority/session-certificate.js";
import type { RepositoryIdentity } from "../github/effect-authorizer.js";
import {
  runtimeFailureFromError,
  runtimeFailureHttpStatus,
  type RuntimeFailureReason,
  type RuntimeFailureStage,
} from "../runtime-contracts/runtime-failure.js";
import {
  beginLocalRuntimeRequest,
  localRuntimeFailureForResponse,
  localRuntimeOutcomeForStatus,
  rememberLocalRuntimeFailure,
  runtimeCorrelationForRequestId,
  writeLocalRuntimeLog,
} from "./runtime-log.js";

export const LOCAL_EXECUTOR_PROTOCOL_VERSION = 1 as const;
export const LOCAL_EXECUTOR_EXECUTIONS_PATH = "/v1/executions" as const;
export const LOCAL_EXECUTOR_EVIDENCE_PATH = "/v1/evidence" as const;
export const LOCAL_EXECUTOR_REPOSITORY_PATH = "/v1/repository" as const;
export const LOCAL_EXECUTOR_HEALTH_PATH = "/health" as const;
export const LOCAL_EXECUTOR_BRANCH_POLICY_PATH = "/v1/branch-policy" as const;
export const LOCAL_EXECUTOR_GOVERNED_CONTRACT_PATH = "/v1/governed-contract" as const;
export const MAX_LOCAL_EXECUTOR_BODY_BYTES = 1_048_576;

export interface LocalExecutorEvidenceRequest {
  readonly version: 1;
  readonly repository: SessionCertificateRepository;
  readonly authorityId: string;
  readonly issue?: number;
  readonly implementationIssue?: number;
}

export interface LocalExecutorHttpHandlerOptions {
  readonly executorId: string;
  readonly version: string;
  readonly ready?: () => boolean;
  readonly execute: (execution: AuthorizedExecution) => Promise<AuthorizedExecutionResult>;
  readonly resolveRepository?: (repositoryNameWithOwner: string) => Promise<RepositoryIdentity>;
  readonly readEvidence?: (request: LocalExecutorEvidenceRequest) => Promise<unknown>;
  readonly readBranchPolicy?: (request: LocalExecutorBranchPolicyRequest) => Promise<unknown>;
  readonly readGovernedContract?: (request: LocalExecutorGovernedContractRequest) => Promise<unknown>;
  readonly maxBodyBytes?: number;
}

/** Repository-governed pull-request contract request (#1181). */
export interface LocalExecutorGovernedContractRequest {
  readonly version: 1;
  readonly repository: SessionCertificateRepository;
  readonly domain: "pr";
  readonly template: string;
}

export function validateLocalExecutorGovernedContractRequest(
  value: unknown,
): LocalExecutorGovernedContractRequest | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["version", "repository", "domain", "template"].includes(key))
  )
    return undefined;
  const record = value as Record<string, unknown>;
  const repository = record.repository as Record<string, unknown> | null | undefined;
  if (
    record.version !== LOCAL_EXECUTOR_PROTOCOL_VERSION ||
    record.domain !== "pr" ||
    typeof record.template !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(record.template) ||
    typeof repository !== "object" ||
    repository === null ||
    Array.isArray(repository) ||
    Object.keys(repository).some((key) => !["id", "name"].includes(key)) ||
    typeof repository.id !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(repository.id) ||
    typeof repository.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repository.name)
  )
    return undefined;
  return Object.freeze({
    version: LOCAL_EXECUTOR_PROTOCOL_VERSION,
    repository: Object.freeze({ id: repository.id, name: repository.name }),
    domain: "pr",
    template: record.template,
  });
}

/** Branch-policy observation request for one governed Implementation (#1179). */
export interface LocalExecutorBranchPolicyRequest {
  readonly version: 1;
  readonly repository: SessionCertificateRepository;
  readonly implementation: number;
}

/** Strict validator shared by the Executor wire, its client and Admission. */
export function validateLocalExecutorBranchPolicyRequest(value: unknown): LocalExecutorBranchPolicyRequest | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["version", "repository", "implementation"].includes(key))
  )
    return undefined;
  const record = value as Record<string, unknown>;
  const repository = record.repository as Record<string, unknown> | null | undefined;
  if (
    record.version !== LOCAL_EXECUTOR_PROTOCOL_VERSION ||
    typeof repository !== "object" ||
    repository === null ||
    Array.isArray(repository) ||
    Object.keys(repository).some((key) => !["id", "name"].includes(key)) ||
    typeof repository.id !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(repository.id) ||
    typeof repository.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repository.name) ||
    !Number.isSafeInteger(record.implementation) ||
    (record.implementation as number) < 1
  )
    return undefined;
  return Object.freeze({
    version: LOCAL_EXECUTOR_PROTOCOL_VERSION,
    repository: Object.freeze({ id: repository.id, name: repository.name }),
    implementation: record.implementation as number,
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Bounded owner failure envelope: fixed code and message plus the catalog diagnostic. */
function failed(
  error: unknown,
  code: string,
  message: string,
  stage: RuntimeFailureStage,
  fallback: RuntimeFailureReason,
): Response {
  const failure = runtimeFailureFromError(error, stage, fallback);
  return rememberLocalRuntimeFailure(
    json(runtimeFailureHttpStatus(failure), { ok: false, error: { code, message, failure } }),
    failure,
  );
}

function jsonContentType(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;|\s*$)/iu.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repositoryRequest(value: unknown): string | undefined {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) => ["version", "repositoryNameWithOwner"].includes(key)) ||
    value.version !== LOCAL_EXECUTOR_PROTOCOL_VERSION ||
    typeof value.repositoryNameWithOwner !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value.repositoryNameWithOwner)
  ) {
    return undefined;
  }
  return value.repositoryNameWithOwner;
}

function evidenceRequest(value: unknown): LocalExecutorEvidenceRequest | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["version", "repository", "authorityId", "issue", "implementationIssue"].includes(key),
    )
  )
    return undefined;
  if (
    value.version !== LOCAL_EXECUTOR_PROTOCOL_VERSION ||
    typeof value.authorityId !== "string" ||
    !DELEGATOR_ID_PATTERN.test(value.authorityId)
  )
    return undefined;
  if (
    !isRecord(value.repository) ||
    Object.keys(value.repository).some((key) => !["id", "name"].includes(key)) ||
    typeof value.repository.id !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(value.repository.id) ||
    typeof value.repository.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value.repository.name)
  )
    return undefined;
  const issue = value.issue;
  const implementationIssue = value.implementationIssue;
  if ((issue === undefined) !== (implementationIssue === undefined)) return undefined;
  if (issue !== undefined && (!Number.isSafeInteger(issue) || (issue as number) < 1)) return undefined;
  if (
    implementationIssue !== undefined &&
    (!Number.isSafeInteger(implementationIssue) || (implementationIssue as number) < 1)
  )
    return undefined;
  return Object.freeze({
    version: LOCAL_EXECUTOR_PROTOCOL_VERSION,
    repository: Object.freeze({ id: value.repository.id, name: value.repository.name }),
    authorityId: value.authorityId,
    ...(issue === undefined ? {} : { issue: issue as number, implementationIssue: implementationIssue as number }),
  });
}

async function readBoundedBody(
  request: Request,
  maximum: number,
): Promise<
  { readonly kind: "body"; readonly text: string } | { readonly kind: "too-large" } | { readonly kind: "error" }
> {
  if (request.body === null) return { kind: "body", text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => {});
        return { kind: "too-large" };
      }
      chunks.push(chunk.value);
    }
  } catch {
    return { kind: "error" };
  } finally {
    reader.releaseLock();
  }
  return { kind: "body", text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8") };
}

/** Web Request handler for the local post-admission Executor protocol. */
export function createLocalExecutorHttpHandler(
  options: LocalExecutorHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  if (
    typeof options.executorId !== "string" ||
    options.executorId.length === 0 ||
    typeof options.version !== "string" ||
    typeof options.execute !== "function"
  ) {
    throw new TypeError("Local Executor HTTP handler configuration is invalid.");
  }
  const maxBodyBytes = options.maxBodyBytes ?? MAX_LOCAL_EXECUTOR_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > MAX_LOCAL_EXECUTOR_BODY_BYTES) {
    throw new TypeError("Local Executor HTTP body limit is invalid.");
  }

  const handle = async (request: Request): Promise<Response> => {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return json(400, { ok: false, error: { code: "MALFORMED_REQUEST", message: "Request URL is invalid." } });
    }

    if (pathname === LOCAL_EXECUTOR_HEALTH_PATH) {
      if (request.method !== "GET") {
        return json(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is supported." } });
      }
      const ready = options.ready?.() ?? true;
      return json(ready ? 200 : 503, {
        ok: ready,
        version: options.version,
        component: "executor",
        executorId: options.executorId,
        protocol: LOCAL_EXECUTOR_PROTOCOL_VERSION,
        readiness: ready ? "ready" : "not-ready",
      });
    }

    if (pathname === LOCAL_EXECUTOR_REPOSITORY_PATH) {
      if (request.method !== "POST") {
        return json(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported." } });
      }
      if (!jsonContentType(request.headers.get("content-type"))) {
        return json(415, {
          ok: false,
          error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Request content type must be application/json." },
        });
      }
      if (options.resolveRepository === undefined) {
        return json(503, {
          ok: false,
          error: { code: "REPOSITORY_UNAVAILABLE", message: "Executor repository resolution is unavailable." },
        });
      }
      const body = await readBoundedBody(request, maxBodyBytes);
      if (body.kind !== "body") {
        return json(body.kind === "too-large" ? 413 : 400, {
          ok: false,
          error: {
            code: body.kind === "too-large" ? "PAYLOAD_TOO_LARGE" : "MALFORMED_REQUEST",
            message:
              body.kind === "too-large"
                ? "Request body exceeds the configured maximum size."
                : "Request body could not be read.",
          },
        });
      }
      let value: unknown;
      try {
        value = JSON.parse(body.text) as unknown;
      } catch {
        return json(400, { ok: false, error: { code: "MALFORMED_JSON", message: "Request body is not valid JSON." } });
      }
      const repositoryNameWithOwner = repositoryRequest(value);
      if (repositoryNameWithOwner === undefined) {
        return json(400, {
          ok: false,
          error: { code: "INVALID_REPOSITORY_REQUEST", message: "Repository request is invalid." },
        });
      }
      try {
        const repository = await options.resolveRepository(repositoryNameWithOwner);
        if (
          repository.repositoryHost !== "github.com" ||
          !/^[1-9][0-9]{0,19}$/u.test(repository.repositoryId) ||
          repository.nameWithOwner.toLocaleLowerCase("en-US") !== repositoryNameWithOwner.toLocaleLowerCase("en-US")
        ) {
          throw new Error();
        }
        return json(200, {
          ok: true,
          component: "executor",
          executorId: options.executorId,
          protocol: LOCAL_EXECUTOR_PROTOCOL_VERSION,
          repository: {
            repositoryHost: repository.repositoryHost,
            repositoryId: repository.repositoryId,
            repositoryNameWithOwner: repository.nameWithOwner,
          },
        });
      } catch (error: unknown) {
        return failed(
          error,
          "REPOSITORY_UNAVAILABLE",
          "Repository identity could not be resolved.",
          "repository-resolution",
          "RUNTIME_OWNER_UNAVAILABLE",
        );
      }
    }

    if (pathname === LOCAL_EXECUTOR_EVIDENCE_PATH) {
      if (request.method !== "POST") {
        return json(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported." } });
      }
      if (!jsonContentType(request.headers.get("content-type"))) {
        return json(415, {
          ok: false,
          error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Request content type must be application/json." },
        });
      }
      if (options.readEvidence === undefined) {
        return json(503, {
          ok: false,
          error: { code: "EVIDENCE_UNAVAILABLE", message: "Executor evidence is unavailable." },
        });
      }
      const body = await readBoundedBody(request, maxBodyBytes);
      if (body.kind === "too-large") {
        return json(413, {
          ok: false,
          error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the configured maximum size." },
        });
      }
      if (body.kind === "error") {
        return json(400, {
          ok: false,
          error: { code: "MALFORMED_REQUEST", message: "Request body could not be read." },
        });
      }
      let value: unknown;
      try {
        value = JSON.parse(body.text) as unknown;
      } catch {
        return json(400, { ok: false, error: { code: "MALFORMED_JSON", message: "Request body is not valid JSON." } });
      }
      const evidence = evidenceRequest(value);
      if (evidence === undefined) {
        return json(400, {
          ok: false,
          error: { code: "INVALID_EVIDENCE_REQUEST", message: "Evidence request is invalid." },
        });
      }
      try {
        return json(200, {
          ok: true,
          component: "executor",
          executorId: options.executorId,
          protocol: LOCAL_EXECUTOR_PROTOCOL_VERSION,
          evidence: await options.readEvidence(evidence),
        });
      } catch (error: unknown) {
        return failed(
          error,
          "EVIDENCE_UNAVAILABLE",
          "Current evidence is unavailable.",
          evidence.issue === undefined ? "trust-evidence" : "implementation-admission",
          "RUNTIME_OWNER_UNAVAILABLE",
        );
      }
    }

    if (pathname === LOCAL_EXECUTOR_GOVERNED_CONTRACT_PATH) {
      if (request.method !== "POST") {
        return json(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported." } });
      }
      if (!jsonContentType(request.headers.get("content-type")) || options.readGovernedContract === undefined) {
        return json(415, {
          ok: false,
          error: { code: "GOVERNED_CONTRACT_UNAVAILABLE", message: "Executor governed contract read is unavailable." },
        });
      }
      const body = await readBoundedBody(request, maxBodyBytes);
      let value: unknown;
      try {
        value = body.kind === "body" ? (JSON.parse(body.text) as unknown) : undefined;
      } catch {
        value = undefined;
      }
      const contractRequest = validateLocalExecutorGovernedContractRequest(value);
      if (contractRequest === undefined) {
        return json(400, {
          ok: false,
          error: { code: "INVALID_GOVERNED_CONTRACT_REQUEST", message: "Governed contract request is invalid." },
        });
      }
      try {
        return json(200, {
          ok: true,
          component: "executor",
          executorId: options.executorId,
          protocol: LOCAL_EXECUTOR_PROTOCOL_VERSION,
          contract: await options.readGovernedContract(contractRequest),
        });
      } catch (error: unknown) {
        return failed(
          error,
          "GOVERNED_CONTRACT_UNAVAILABLE",
          "Repository-governed contract is unavailable.",
          "implementation-admission",
          "RUNTIME_OWNER_UNAVAILABLE",
        );
      }
    }

    if (pathname === LOCAL_EXECUTOR_BRANCH_POLICY_PATH) {
      if (request.method !== "POST") {
        return json(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported." } });
      }
      if (!jsonContentType(request.headers.get("content-type"))) {
        return json(415, {
          ok: false,
          error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Request content type must be application/json." },
        });
      }
      if (options.readBranchPolicy === undefined) {
        return json(503, {
          ok: false,
          error: { code: "BRANCH_POLICY_UNAVAILABLE", message: "Executor branch policy is unavailable." },
        });
      }
      const body = await readBoundedBody(request, maxBodyBytes);
      if (body.kind !== "body") {
        return json(body.kind === "too-large" ? 413 : 400, {
          ok: false,
          error: {
            code: body.kind === "too-large" ? "PAYLOAD_TOO_LARGE" : "MALFORMED_REQUEST",
            message:
              body.kind === "too-large"
                ? "Request body exceeds the configured maximum size."
                : "Request body could not be read.",
          },
        });
      }
      let value: unknown;
      try {
        value = JSON.parse(body.text) as unknown;
      } catch {
        return json(400, { ok: false, error: { code: "MALFORMED_JSON", message: "Request body is not valid JSON." } });
      }
      const policyRequest = validateLocalExecutorBranchPolicyRequest(value);
      if (policyRequest === undefined) {
        return json(400, {
          ok: false,
          error: { code: "INVALID_BRANCH_POLICY_REQUEST", message: "Branch policy request is invalid." },
        });
      }
      try {
        return json(200, {
          ok: true,
          component: "executor",
          executorId: options.executorId,
          protocol: LOCAL_EXECUTOR_PROTOCOL_VERSION,
          branchPolicy: await options.readBranchPolicy(policyRequest),
        });
      } catch (error: unknown) {
        return failed(
          error,
          "BRANCH_POLICY_UNAVAILABLE",
          "Current branch policy is unavailable.",
          "session-registration",
          "RUNTIME_OWNER_UNAVAILABLE",
        );
      }
    }

    if (pathname !== LOCAL_EXECUTOR_EXECUTIONS_PATH) {
      return json(404, { ok: false, error: { code: "NOT_FOUND", message: "The requested path is not implemented." } });
    }
    if (request.method !== "POST") {
      return json(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported." } });
    }
    if (!jsonContentType(request.headers.get("content-type"))) {
      return json(415, {
        ok: false,
        error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Request content type must be application/json." },
      });
    }

    const body = await readBoundedBody(request, maxBodyBytes);
    if (body.kind === "too-large") {
      return json(413, {
        ok: false,
        error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the configured maximum size." },
      });
    }
    if (body.kind === "error") {
      return json(400, { ok: false, error: { code: "MALFORMED_REQUEST", message: "Request body could not be read." } });
    }

    let value: unknown;
    try {
      value = JSON.parse(body.text) as unknown;
    } catch {
      return json(400, { ok: false, error: { code: "MALFORMED_JSON", message: "Request body is not valid JSON." } });
    }

    let execution: AuthorizedExecution;
    try {
      execution = createAuthorizedExecution(value);
    } catch {
      return json(400, {
        ok: false,
        error: { code: "INVALID_AUTHORIZED_EXECUTION", message: "Request is not a valid AuthorizedExecution." },
      });
    }
    const correlationId = runtimeCorrelationForRequestId(execution.provenance.request.requestId);
    const executionStartedAt = performance.now();
    writeLocalRuntimeLog({
      component: "executor",
      event: "execution.received",
      method: request.method,
      route: pathname,
      operation: execution.operation,
      correlationId,
    });
    try {
      const result = await options.execute(execution);
      const response = json(200, {
        ok: true,
        component: "executor",
        executorId: options.executorId,
        protocol: LOCAL_EXECUTOR_PROTOCOL_VERSION,
        result,
      });
      writeLocalRuntimeLog({
        component: "executor",
        event: "execution.completed",
        method: request.method,
        route: pathname,
        operation: execution.operation,
        correlationId,
        elapsedMs: performance.now() - executionStartedAt,
        status: response.status,
        outcome: localRuntimeOutcomeForStatus(response.status),
      });
      return response;
    } catch (error: unknown) {
      const response = failed(
        error,
        "EXECUTION_FAILED",
        "Authorized execution failed.",
        "provider-execution",
        "EXECUTOR_EXECUTION_FAILED",
      );
      writeLocalRuntimeLog({
        component: "executor",
        event: "execution.completed",
        method: request.method,
        route: pathname,
        operation: execution.operation,
        correlationId,
        elapsedMs: performance.now() - executionStartedAt,
        status: response.status,
        outcome: localRuntimeOutcomeForStatus(response.status),
        failure: localRuntimeFailureForResponse(response),
      });
      return response;
    }
  };

  return async (request: Request): Promise<Response> => {
    let pathname = "/unknown";
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      // The handler returns a bounded malformed-request response.
    }
    const requestLog = beginLocalRuntimeRequest("executor", request.method, pathname);
    let response: Response | undefined;
    try {
      response = await handle(request);
      return response;
    } finally {
      requestLog.complete(
        response?.status,
        response === undefined ? undefined : localRuntimeFailureForResponse(response),
      );
    }
  };
}
