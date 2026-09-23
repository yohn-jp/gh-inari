import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeAdmissionSession, createAdmissionSession, readAdmissionSession } from "./session-store.js";
import { validateLocalSessionBinding, type LocalSessionBinding } from "./session-binding.js";
import { ensureLocalComponentIdentity } from "./identity.js";
import {
  ensureLocalComponentDirectory,
  LOCAL_CONFIG_VERSION,
  readLocalJson,
  resolveConfigHome,
  validateLocalAdmissionConfig,
  validateLocalAuthorityConfig,
  validateLocalExecutorConfig,
  writeLocalJson,
  LocalControlError,
  type LocalAdmissionConfig,
} from "./config.js";
import { validateDelegator, type Delegator } from "../agent-authority/delegator.js";
import { delegatorPublicKeyFingerprint } from "../agent-authority/delegator-key.js";
import {
  admitAuthenticatedSessionCapability,
  type AdmittedSessionCapability,
  type CapabilityAdmissionOperation,
  type CapabilityAdmissionSubject,
} from "../agent-authority/capability-admission.js";
import {
  authorizeBranchAdvance,
  validateBranchAdvanceSemanticRequest,
  type BranchAdvanceSemanticRequest,
} from "../agent-authority/branch-advance.js";
import {
  createCapabilityExecutionProvenance,
  type CapabilityExecutionProvenance,
} from "../agent-authority/capability-provenance.js";
import type { SessionAdmissionAuthorizationContext } from "../agent-authority/session-authentication.js";
import type { SessionCertificateRepository } from "../agent-authority/session-certificate.js";
import type { CapabilityClaim } from "../agent-authority/capability.js";
import { createAuthorizedExecution, type AuthorizedExecution } from "../authorized-execution.js";
import { changeReadRequest } from "../change-execution-port.js";
import { validateChangeProjectionResult, type ChangeProjectionResult } from "../change.js";
import { tryAuthorizeImplementation, type ImplementationAuthorizationInput } from "../implementation-authorization.js";
import { projectImplementationSessionAuthorizationBinding } from "../implementation-session-binding.js";
import { tryProjectImplementationScope } from "../implementation-scope-projection.js";
import { canonicalJsonString, type CanonicalJsonValue } from "../agent-authority/codec.js";
import {
  assertTrustedExecution,
  validateIssuerRepositoryIdentity,
  type RepositoryIdentity,
} from "../github/effect-authorizer.js";
import { tryValidatePrPublicationRequest, type PrPublicationRequest } from "../pr-publication.js";
import { LocalExecutorClient } from "./executor-client.js";
import type { LocalExecutorEvidenceRequest } from "./executor-http.js";
import { executionIntentIssue, validateExecutionIntent, type ExecutionIntent } from "./execution-intent.js";
import {
  clearLocalRuntimeEndpoint,
  publishLocalRuntimeEndpoint,
  requireLocalRuntimeEndpoint,
  type LocalRuntimeEndpoint,
} from "./runtime-discovery.js";

export const LOCAL_ADMISSION_DEFAULT_PORT = 0;
const LOCAL_ADMISSION_HISTORICAL_PORT = 8766;
export const LOCAL_ADMISSION_PROTOCOL_VERSION = 1 as const;
export const LOCAL_ADMISSION_HEALTH_PATH = "/health" as const;
export const LOCAL_ADMISSION_SESSIONS_PATH = "/v1/sessions" as const;
export const LOCAL_ADMISSION_REPOSITORY_PATH = "/v1/repository" as const;
export const LOCAL_ADMISSION_EXECUTIONS_PATH = "/v1/executions" as const;
export const LOCAL_ADMISSION_SESSION_ID_HEADER = "x-inari-session-id" as const;
export const MAX_LOCAL_ADMISSION_BODY_BYTES = 1_048_576;

const AUTHORITY_FILE = "runtime-authority.json";
const ADMISSION_CONFIG_FILE = "config.json";

export class LocalAdmissionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalAdmissionError";
    this.code = code;
  }
}

export interface LocalAdmissionSetupResult {
  readonly config: LocalAdmissionConfig;
  readonly configPath: string;
  readonly authorityPath: string;
}

function authorityValidator(value: unknown): Delegator {
  const result = validateDelegator(value);
  if (!result.valid || result.value === undefined)
    throw new LocalControlError("LOCAL_CONTROL_INVALID_CONFIG", "Public Runtime Authority trust is invalid.");
  return result.value;
}

function configuredAuthority(environment: NodeJS.ProcessEnv): Delegator {
  const value = readLocalJson("admission", AUTHORITY_FILE, authorityValidator, environment);
  if (value === undefined) throw new LocalAdmissionError("ADMISSION_NOT_SETUP", "Local Admission is not set up.");
  return value;
}

function configuredLocalAdmission(environment: NodeJS.ProcessEnv): LocalAdmissionConfig {
  const value = readLocalJson("admission", ADMISSION_CONFIG_FILE, validateLocalAdmissionConfig, environment);
  if (value === undefined) throw new LocalAdmissionError("ADMISSION_NOT_SETUP", "Run `inari admission setup` first.");
  return value;
}

/** Create stable local Admission configuration and pin public Runtime Authority trust. */
export function setupLocalAdmission(
  authorityInput: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): LocalAdmissionSetupResult {
  const authority = authorityValidator(authorityInput);
  const localAuthority = readLocalJson("authority", "config.json", validateLocalAuthorityConfig, environment);
  if (
    localAuthority === undefined ||
    localAuthority.publicKeyFingerprint !== delegatorPublicKeyFingerprint(authority.key)
  ) {
    throw new LocalAdmissionError(
      "ADMISSION_AUTHORITY_MISMATCH",
      "Public trust record does not match the configured local Runtime Authority key.",
    );
  }
  const executor = readLocalJson("executor", "config.json", validateLocalExecutorConfig, environment);
  if (executor === undefined) throw new LocalAdmissionError("EXECUTOR_NOT_SETUP", "Run `inari executor setup` first.");
  ensureLocalComponentDirectory("admission", environment);
  const identity = ensureLocalComponentIdentity("admission", environment);
  const configPath = `${resolveConfigHome(environment)}/admission/${ADMISSION_CONFIG_FILE}`;
  const authorityPath = `${resolveConfigHome(environment)}/admission/${AUTHORITY_FILE}`;
  const existing = readLocalJson("admission", ADMISSION_CONFIG_FILE, validateLocalAdmissionConfig, environment);
  if (existing !== undefined && (existing.id !== identity.id || existing.executor.id !== executor.id)) {
    throw new LocalAdmissionError(
      "ADMISSION_CONFIG_CONFLICT",
      "Existing local Admission configuration conflicts with the pinned component identities.",
    );
  }
  const config =
    existing ??
    writeLocalJson(
      "admission",
      ADMISSION_CONFIG_FILE,
      {
        version: LOCAL_CONFIG_VERSION,
        id: identity.id,
        listen: { host: "127.0.0.1" as const, port: LOCAL_ADMISSION_DEFAULT_PORT },
        executor: { id: executor.id },
      },
      validateLocalAdmissionConfig,
      environment,
    );
  const pinnedAuthority = writeLocalJson("admission", AUTHORITY_FILE, authority, authorityValidator, environment);
  if (
    canonicalJsonString(pinnedAuthority as unknown as CanonicalJsonValue) !==
    canonicalJsonString(authority as unknown as CanonicalJsonValue)
  )
    throw new LocalAdmissionError(
      "ADMISSION_AUTHORITY_MISMATCH",
      "Existing Admission Authority trust conflicts with setup.",
    );
  return { config, configPath, authorityPath };
}

interface AdmissionExecutor {
  verifyReady(): Promise<unknown>;
  resolveRepository?(repositoryNameWithOwner: string): Promise<RepositoryIdentity>;
  readEvidence(request: LocalExecutorEvidenceRequest): Promise<unknown>;
  execute(execution: AuthorizedExecution): Promise<unknown>;
}

interface LocalAdmissionHttpHandlerOptions {
  readonly admissionId: string;
  readonly version: string;
  readonly runtimeAuthority: Delegator;
  readonly executor: AdmissionExecutor;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function jsonContentType(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;|\s*$)/iu.test(value);
}

async function readBoundedBody(
  request: Request,
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
      if (total > MAX_LOCAL_ADMISSION_BODY_BYTES) {
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

async function bodyJson(request: Request): Promise<{ readonly value?: unknown; readonly response?: Response }> {
  if (!jsonContentType(request.headers.get("content-type")))
    return {
      response: json(415, {
        ok: false,
        error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Content type must be application/json." },
      }),
    };
  const body = await readBoundedBody(request);
  if (body.kind === "too-large")
    return {
      response: json(413, {
        ok: false,
        error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the configured maximum size." },
      }),
    };
  if (body.kind === "error")
    return {
      response: json(400, {
        ok: false,
        error: { code: "MALFORMED_REQUEST", message: "Request body could not be read." },
      }),
    };
  try {
    return { value: JSON.parse(body.text) as unknown };
  } catch {
    return {
      response: json(400, { ok: false, error: { code: "MALFORMED_JSON", message: "Request body is not valid JSON." } }),
    };
  }
}

function sameRepository(left: unknown, right: SessionCertificateRepository): boolean {
  if (!isRecord(left)) return false;
  return (
    left.repositoryHost === "github.com" &&
    left.repositoryId === right.id &&
    (left.nameWithOwner === undefined ||
      (typeof left.nameWithOwner === "string" && left.nameWithOwner.toLowerCase() === right.name.toLowerCase()))
  );
}

function evidenceRepository(repository: SessionCertificateRepository) {
  return { id: repository.id, name: repository.name };
}

function intentRepositoryMatchesBinding(
  intent: ExecutionIntent["repository"],
  binding: SessionCertificateRepository,
): boolean {
  return (
    intent.repositoryHost === "github.com" &&
    intent.repositoryId === binding.id &&
    (intent.repositoryNameWithOwner === undefined ||
      intent.repositoryNameWithOwner.toLocaleLowerCase("en-US") === binding.name.toLocaleLowerCase("en-US"))
  );
}

function makeContext(
  binding: LocalSessionBinding,
  repository: RepositoryIdentity,
  authority: { readonly ref: string; readonly sha: string },
  intent: ExecutionIntent,
  operation: CapabilityAdmissionOperation,
  nowSeconds: number,
): SessionAdmissionAuthorizationContext {
  const request = Object.freeze({
    requestId: intent.requestId,
    operation,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 60,
  });
  return Object.freeze({
    repository,
    runtimeAuthority: Object.freeze({ id: binding.authority.id, kid: binding.authority.id }),
    session: Object.freeze({ id: binding.sessionId, certificateJti: binding.signature }),
    task: binding.task,
    capabilities: binding.capabilities,
    authority,
    request,
    semanticRequest: intent.request as SessionAdmissionAuthorizationContext["semanticRequest"],
  });
}

function capabilityOperation(intent: ExecutionIntent): CapabilityAdmissionOperation {
  return intent.operation === "pullRequest.publish" ? "pullRequest.create" : intent.operation;
}

function intentSubject(intent: ExecutionIntent): CapabilityAdmissionSubject {
  const issue = executionIntentIssue(intent);
  if (issue === undefined) throw new Error("ExecutionIntent has no task Issue.");
  if (intent.operation === "branch.advance") {
    const request = intent.request as BranchAdvanceSemanticRequest;
    return { kind: "branch", issue, branch: request.branch };
  }
  if (intent.operation === "pullRequest.publish") {
    const request = intent.request as PrPublicationRequest;
    if (typeof request.expectedHead !== "string" || typeof request.expectedBase !== "string")
      throw new Error("Pull request publication route is unavailable.");
    return { kind: "pullRequest", issue, head: request.expectedHead, base: request.expectedBase };
  }
  return { kind: "change", issue };
}

function readTreeDelta(intent: ExecutionIntent) {
  if (intent.operation !== "branch.advance") return undefined;
  const request = intent.request as BranchAdvanceSemanticRequest;
  return {
    changes: request.changes.map((change) => ({ operation: "modify" as const, path: change.path })),
  };
}

function validateEvidence(
  value: unknown,
  binding: LocalSessionBinding,
  pinnedAuthority: Delegator,
): {
  readonly repository: RepositoryIdentity;
  readonly authority: { readonly ref: string; readonly sha: string };
  readonly change: ChangeProjectionResult;
  readonly implementation: Record<string, unknown>;
  readonly reviewEvidence?: unknown;
} {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["repository", "authority", "runtimeAuthority", "change", "implementation", "reviewEvidence"])
  )
    throw new Error("Executor evidence response is malformed.");
  const repositoryResult = validateIssuerRepositoryIdentity(value.repository);
  if (
    !repositoryResult.valid ||
    repositoryResult.value === undefined ||
    !sameRepository(repositoryResult.value, binding.repository)
  )
    throw new Error("Executor repository evidence does not match Session.");
  const authority = value.authority;
  if (
    !isRecord(authority) ||
    !exactKeys(authority, ["ref", "sha"]) ||
    typeof authority.ref !== "string" ||
    !/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(authority.ref) ||
    typeof authority.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(authority.sha)
  )
    throw new Error("Executor Authority evidence is malformed.");
  const runtime = authorityValidator(value.runtimeAuthority);
  if (
    runtime.id !== binding.authority.id ||
    delegatorPublicKeyFingerprint(runtime.key) !== binding.authority.publicKeyFingerprint ||
    canonicalJsonString(runtime as unknown as CanonicalJsonValue) !==
      canonicalJsonString(pinnedAuthority as unknown as CanonicalJsonValue)
  )
    throw new Error("Current Runtime Authority trust does not match Admission configuration.");
  const projection = validateChangeProjectionResult(value.change);
  if (!projection.valid || projection.projection === undefined)
    throw new Error("Current Change evidence is malformed.");
  if (
    !isRecord(value.implementation) ||
    !exactKeys(value.implementation, [
      "implementation",
      "issue",
      "repository",
      "base",
      "readiness",
      "change",
      "pullRequest",
    ])
  )
    throw new Error("Current Implementation evidence is malformed.");
  return {
    repository: repositoryResult.value,
    authority: { ref: authority.ref, sha: authority.sha },
    change: projection.projection,
    implementation: value.implementation,
    ...(value.reviewEvidence === undefined ? {} : { reviewEvidence: value.reviewEvidence }),
  };
}

function validateTrustEvidence(value: unknown, binding: LocalSessionBinding, pinnedAuthority: Delegator): Delegator {
  if (!isRecord(value) || !exactKeys(value, ["repository", "authority", "runtimeAuthority"]))
    throw new Error("Executor Runtime Authority evidence is malformed.");
  if (!sameRepository(value.repository, binding.repository))
    throw new Error("Executor repository evidence does not match Session.");
  const authority = value.authority;
  if (
    !isRecord(authority) ||
    !exactKeys(authority, ["ref", "sha"]) ||
    typeof authority.ref !== "string" ||
    !/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(authority.ref) ||
    typeof authority.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(authority.sha)
  )
    throw new Error("Executor Authority evidence is malformed.");
  const current = authorityValidator(value.runtimeAuthority);
  if (
    current.id !== binding.authority.id ||
    delegatorPublicKeyFingerprint(current.key) !== binding.authority.publicKeyFingerprint ||
    canonicalJsonString(current as unknown as CanonicalJsonValue) !==
      canonicalJsonString(pinnedAuthority as unknown as CanonicalJsonValue)
  )
    throw new Error("Current Runtime Authority trust does not match Admission configuration.");
  return current;
}

function currentImplementationAuthorization(
  evidence: ReturnType<typeof validateEvidence>,
  binding: LocalSessionBinding,
) {
  const implementationEvidence = evidence.implementation;
  const authorizationInput: ImplementationAuthorizationInput = {
    implementation: implementationEvidence.implementation as ImplementationAuthorizationInput["implementation"],
    issue: implementationEvidence.issue as ImplementationAuthorizationInput["issue"],
    repository: implementationEvidence.repository as ImplementationAuthorizationInput["repository"],
    base: implementationEvidence.base as ImplementationAuthorizationInput["base"],
    readiness: implementationEvidence.readiness,
  };
  const authorization = tryAuthorizeImplementation(authorizationInput);
  if (!authorization.valid || authorization.status !== "authorized" || authorization.authorization === undefined)
    throw new Error("Current Implementation is not authorized.");
  const currentInput = { ...authorizationInput, authorization: authorization.authorization };
  const bindingProjection = projectImplementationSessionAuthorizationBinding({
    ...currentInput,
    task: binding.task,
  });
  const scope = tryProjectImplementationScope(currentInput);
  if (!scope.valid || scope.projection === undefined) throw new Error("Current Implementation scope is unavailable.");
  return { binding: bindingProjection, scope: scope.projection };
}

async function executeIntent(
  intent: ExecutionIntent,
  sessionId: string,
  options: LocalAdmissionHttpHandlerOptions,
): Promise<unknown> {
  const stored = readAdmissionSession(sessionId, options.runtimeAuthority, {
    environment: options.environment,
    now: options.now?.(),
  });
  if (stored === undefined || stored.status !== "active") throw new Error("Session is unavailable.");
  const binding = stored.record.binding;
  if (!intentRepositoryMatchesBinding(intent.repository, binding.repository))
    throw new Error("Execution repository does not match Session.");
  const issue = executionIntentIssue(intent);
  if (issue === undefined || binding.task.kind !== "issue" || binding.task.number !== issue)
    throw new Error("Execution task does not match Session.");
  const evidenceValue = await options.executor.readEvidence({
    version: 1,
    repository: evidenceRepository(binding.repository),
    authorityId: binding.authority.id,
    issue,
    implementationIssue: binding.task.number,
  });
  const evidence = validateEvidence(evidenceValue, binding, options.runtimeAuthority);
  const current = currentImplementationAuthorization(evidence, binding);
  const operation = capabilityOperation(intent);
  const nowSeconds = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
  const context = {
    ...makeContext(binding, evidence.repository, evidence.authority, intent, operation, nowSeconds),
    implementationBinding: current.binding,
    implementationScope: current.scope,
  } as SessionAdmissionAuthorizationContext;
  const admission = admitAuthenticatedSessionCapability({
    context,
    operation,
    subject: intentSubject(intent),
    projection: evidence.change,
    ...(readTreeDelta(intent) === undefined ? {} : { treeDelta: readTreeDelta(intent) }),
    ...(evidence.reviewEvidence === undefined ? {} : { reviewEvidence: evidence.reviewEvidence }),
  });
  let branchAuthorization: unknown;
  if (intent.operation === "branch.advance") {
    const authorized = authorizeBranchAdvance({ context, admission, request: intent.request });
    if (!authorized.valid) throw new Error("Branch advance is outside the current authorized scope.");
    branchAuthorization = authorized.authorization;
  }
  const provenanceRequest = {
    ...context.request,
    operation: intent.operation,
  };
  const provenance: CapabilityExecutionProvenance = createCapabilityExecutionProvenance({
    version: 1,
    stage: "authorized",
    repository: evidence.repository,
    runtimeAuthority: context.runtimeAuthority,
    session: context.session,
    authority: context.authority,
    request: provenanceRequest,
    subject: admission.subject,
    capability: admission.capability,
  });
  const localAdmissionExecution = assertTrustedExecution({
    version: 1,
    runtime: "inari-local-admission",
    event: "authorized-session-execution",
    repository: evidence.repository,
    requestId: intent.requestId,
    sessionId: binding.sessionId,
    sessionBindingSignature: binding.signature,
    requester: `session:${binding.sessionId}`,
  });
  const executionInput: Record<string, unknown> = {
    version: 1,
    operation: intent.operation,
    repository: evidence.repository,
    task: binding.task,
    subject: admission.subject,
    capability: admission.capability,
    provenance,
    request: intent.operation === "change.show" ? changeReadRequest(issue) : intent.request,
  };
  if (intent.operation === "change.show") executionInput.initialProjection = evidence.change;
  else if (intent.operation === "branch.advance") executionInput.branchAuthorization = branchAuthorization;
  else executionInput.execution = localAdmissionExecution;
  const authorizedExecution = createAuthorizedExecution(executionInput);
  return options.executor.execute(authorizedExecution);
}

function createLocalAdmissionHttpHandler(
  options: LocalAdmissionHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return json(400, { ok: false, error: { code: "MALFORMED_REQUEST", message: "Request URL is invalid." } });
    }
    if (url.pathname === LOCAL_ADMISSION_HEALTH_PATH) {
      if (request.method !== "GET")
        return json(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is supported." } });
      return json(200, {
        ok: true,
        version: options.version,
        component: "admission",
        admissionId: options.admissionId,
        protocol: LOCAL_ADMISSION_PROTOCOL_VERSION,
        readiness: "ready",
      });
    }
    if (url.pathname === LOCAL_ADMISSION_REPOSITORY_PATH) {
      if (request.method !== "POST")
        return json(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported." } });
      const parsed = await bodyJson(request);
      if (parsed.response !== undefined) return parsed.response;
      if (
        !isRecord(parsed.value) ||
        !exactKeys(parsed.value, ["version", "repositoryNameWithOwner"]) ||
        parsed.value.version !== LOCAL_ADMISSION_PROTOCOL_VERSION ||
        typeof parsed.value.repositoryNameWithOwner !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(parsed.value.repositoryNameWithOwner) ||
        options.executor.resolveRepository === undefined
      ) {
        return json(400, {
          ok: false,
          error: { code: "INVALID_REPOSITORY_REQUEST", message: "Repository request is invalid." },
        });
      }
      try {
        const repository = await options.executor.resolveRepository(parsed.value.repositoryNameWithOwner);
        const validation = validateIssuerRepositoryIdentity(repository);
        if (
          !validation.valid ||
          validation.value === undefined ||
          validation.value.nameWithOwner.toLocaleLowerCase("en-US") !==
            parsed.value.repositoryNameWithOwner.toLocaleLowerCase("en-US")
        ) {
          throw new Error();
        }
        return json(200, {
          ok: true,
          repository: {
            repositoryHost: validation.value.repositoryHost,
            repositoryId: validation.value.repositoryId,
            repositoryNameWithOwner: validation.value.nameWithOwner,
          },
        });
      } catch {
        return json(503, {
          ok: false,
          error: { code: "REPOSITORY_UNAVAILABLE", message: "Repository identity could not be resolved." },
        });
      }
    }
    if (url.pathname === LOCAL_ADMISSION_SESSIONS_PATH) {
      if (request.method !== "POST")
        return json(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported." } });
      const parsed = await bodyJson(request);
      if (parsed.response !== undefined) return parsed.response;
      if (!isRecord(parsed.value) || !exactKeys(parsed.value, ["version", "binding"]) || parsed.value.version !== 1)
        return json(400, {
          ok: false,
          error: { code: "INVALID_SESSION_BINDING", message: "Session request is invalid." },
        });
      const validation = validateLocalSessionBinding(parsed.value.binding);
      if (!validation.valid || validation.value === undefined)
        return json(403, { ok: false, error: { code: "SESSION_DENIED", message: "Session binding was denied." } });
      try {
        const binding = validation.value;
        const evidence = await options.executor.readEvidence({
          version: 1,
          repository: evidenceRepository(binding.repository),
          authorityId: binding.authority.id,
        });
        const current = validateTrustEvidence(evidence, binding, options.runtimeAuthority);
        const snapshot = createAdmissionSession(binding, current, {
          environment: options.environment,
          now: options.now?.(),
        });
        return json(201, {
          ok: true,
          session: { id: snapshot.record.binding.sessionId, status: snapshot.status, exp: snapshot.record.binding.exp },
        });
      } catch {
        return json(403, { ok: false, error: { code: "SESSION_DENIED", message: "Session binding was denied." } });
      }
    }
    if (url.pathname.startsWith(`${LOCAL_ADMISSION_SESSIONS_PATH}/`)) {
      if (request.method !== "DELETE")
        return json(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only DELETE is supported." } });
      const sessionId = url.pathname.slice(LOCAL_ADMISSION_SESSIONS_PATH.length + 1);
      if (!/^[A-Za-z0-9._-]{1,128}$/u.test(sessionId))
        return json(400, { ok: false, error: { code: "INVALID_SESSION_ID", message: "Session id is invalid." } });
      const parsed = await bodyJson(request);
      if (parsed.response !== undefined) return parsed.response;
      if (!isRecord(parsed.value) || !exactKeys(parsed.value, ["version", "binding"]) || parsed.value.version !== 1)
        return json(400, {
          ok: false,
          error: { code: "INVALID_SESSION_BINDING", message: "Session close is invalid." },
        });
      const validation = validateLocalSessionBinding(parsed.value.binding);
      if (!validation.valid || validation.value === undefined || validation.value.sessionId !== sessionId)
        return json(403, { ok: false, error: { code: "SESSION_DENIED", message: "Session close was denied." } });
      try {
        const binding = validation.value;
        const evidence = await options.executor.readEvidence({
          version: 1,
          repository: evidenceRepository(binding.repository),
          authorityId: binding.authority.id,
        });
        const current = validateTrustEvidence(evidence, binding, options.runtimeAuthority);
        const snapshot = closeAdmissionSession(binding, current, {
          environment: options.environment,
          now: options.now?.(),
        });
        return json(200, { ok: true, session: { id: snapshot.record.binding.sessionId, status: snapshot.status } });
      } catch {
        return json(403, { ok: false, error: { code: "SESSION_DENIED", message: "Session close was denied." } });
      }
    }
    if (url.pathname === LOCAL_ADMISSION_EXECUTIONS_PATH) {
      if (request.method !== "POST")
        return json(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported." } });
      const parsed = await bodyJson(request);
      if (parsed.response !== undefined) return parsed.response;
      const validation = validateExecutionIntent(parsed.value);
      if (!validation.valid || validation.intent === undefined)
        return json(400, {
          ok: false,
          error: { code: "INVALID_EXECUTION_INTENT", message: "ExecutionIntent is invalid." },
        });
      const sessionId = request.headers.get(LOCAL_ADMISSION_SESSION_ID_HEADER);
      if (sessionId === null || !/^[A-Za-z0-9._-]{1,128}$/u.test(sessionId))
        return json(400, {
          ok: false,
          error: { code: "INVALID_SESSION_SELECTOR", message: "A bounded Session selector header is required." },
        });
      try {
        const result = await executeIntent(validation.intent, sessionId, options);
        return json(200, { ok: true, result });
      } catch {
        return json(403, { ok: false, error: { code: "ADMISSION_DENIED", message: "Execution was denied." } });
      }
    }
    return json(404, { ok: false, error: { code: "NOT_FOUND", message: "The requested path is not implemented." } });
  };
}

function requestFromIncoming(request: IncomingMessage): Request {
  const host = request.headers.host ?? "127.0.0.1";
  const url = new URL(request.url ?? "/", `http://${host}`);
  const method = request.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(name, value.join(", "));
    else if (value !== undefined) headers.set(name, value);
  }
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });
  return new Request(url, {
    method,
    headers,
    body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
    duplex: "half",
  } as RequestInit & { readonly duplex: "half" });
}

export function createLocalAdmissionHttpServer(
  config: LocalAdmissionConfig,
  version: string,
  runtimeAuthority: Delegator,
  executor: AdmissionExecutor,
  options: { readonly environment?: NodeJS.ProcessEnv; readonly now?: () => Date } = {},
): Server {
  const handler = createLocalAdmissionHttpHandler({
    admissionId: config.id,
    version,
    runtimeAuthority,
    executor,
    ...options,
  });
  return createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const response = await handler(requestFromIncoming(incoming));
        outgoing.statusCode = response.status;
        response.headers.forEach((value, key) => outgoing.setHeader(key, value));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        outgoing.statusCode = 400;
        outgoing.setHeader("content-type", "application/json; charset=utf-8");
        outgoing.end(
          JSON.stringify({ ok: false, error: { code: "MALFORMED_REQUEST", message: "Request could not be handled." } }),
        );
      }
    })();
  }).listen(
    config.listen.port === LOCAL_ADMISSION_HISTORICAL_PORT ? LOCAL_ADMISSION_DEFAULT_PORT : config.listen.port,
    config.listen.host,
  );
}

export async function startConfiguredLocalAdmission(
  version: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{
  readonly server: Server;
  readonly config: LocalAdmissionConfig;
  readonly announcement: LocalRuntimeEndpoint;
}> {
  const config = configuredLocalAdmission(environment);
  const runtimeAuthority = configuredAuthority(environment);
  const discoveredExecutor = (): LocalExecutorClient => {
    const endpoint = requireLocalRuntimeEndpoint("executor", config.executor.id, environment);
    return new LocalExecutorClient({ id: config.executor.id, endpoint: endpoint.endpoint });
  };
  const executor: AdmissionExecutor = {
    verifyReady: () => discoveredExecutor().verifyReady(),
    resolveRepository: (repositoryNameWithOwner) => discoveredExecutor().resolveRepository(repositoryNameWithOwner),
    readEvidence: (request) => discoveredExecutor().readEvidence(request),
    execute: (execution) => discoveredExecutor().execute(execution),
  };
  try {
    await executor.verifyReady();
  } catch {
    throw new LocalAdmissionError("EXECUTOR_NOT_READY", "Configured Executor identity or readiness check failed.");
  }
  const server = createLocalAdmissionHttpServer(config, version, runtimeAuthority, executor, { environment });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch {
    server.close();
    throw new LocalAdmissionError("ADMISSION_LISTEN_FAILED", "Local Admission could not bind its loopback endpoint.");
  }
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : undefined;
  if (port === undefined) {
    server.close();
    throw new LocalAdmissionError("ADMISSION_LISTEN_FAILED", "Local Admission did not acquire a loopback port.");
  }
  let announcement: LocalRuntimeEndpoint;
  try {
    announcement = publishLocalRuntimeEndpoint("admission", config.id, port, environment);
  } catch {
    server.close();
    throw new LocalAdmissionError(
      "ADMISSION_DISCOVERY_FAILED",
      "Local Admission endpoint could not be published safely.",
    );
  }
  server.once("close", () => {
    try {
      clearLocalRuntimeEndpoint(announcement, environment);
    } catch {
      // A shutdown cleanup failure must not change the process close behavior.
    }
  });
  return { server, config, announcement };
}
