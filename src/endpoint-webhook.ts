/**
 * Bounded GitHub webhook admission for an Inari Endpoint.
 *
 * A valid GitHub signature authenticates delivery origin only. The adapter
 * additionally binds the delivery to the configured Endpoint, App
 * installation, and enrolled repository, then emits an Endpoint
 * reconciliation hint. It never treats the webhook payload as authority.
 */

import {
  validateEndpointIdentity,
  validateEndpointInstallationIdentity,
  validateEndpointRepositoryIdentity,
  type EndpointIdentity,
  type EndpointInstallationIdentity,
  type EndpointPrincipal,
  type EndpointRepositoryIdentity,
} from "./endpoint-authorization.js";
import {
  ENDPOINT_RECONCILIATION_LIMITS,
  applyEndpointWebhookHint,
  type EndpointObservationRecord,
} from "./endpoint-reconciliation.js";

export const ENDPOINT_WEBHOOK_CONTRACT_VERSION = 1 as const;
export type EndpointWebhookContractVersion = typeof ENDPOINT_WEBHOOK_CONTRACT_VERSION;

/** Public hosted ingress. Existing MCP, relay, setup, and health routes are unchanged. */
export const ENDPOINT_WEBHOOK_PATH = "/v1/webhooks/github" as const;
export const GITHUB_WEBHOOK_PATH = ENDPOINT_WEBHOOK_PATH;

export const ENDPOINT_WEBHOOK_LIMITS = Object.freeze({
  bodyBytes: 1_048_576,
  secretBytes: 4_096,
  deliveryIdBytes: 256,
  eventBytes: 128,
  seenDeliveries: 256,
  maxAgeMs: 86_400_000,
  maxFutureSkewMs: 300_000,
} as const);

export const ENDPOINT_WEBHOOK_CLASSIFICATIONS = Object.freeze([
  "admitted",
  "duplicate",
  "retry",
  "replay",
  "stale",
  "rejected",
] as const);
export type EndpointWebhookClassification = (typeof ENDPOINT_WEBHOOK_CLASSIFICATIONS)[number];

export type EndpointWebhookDiagnosticCode =
  | "ENDPOINT_WEBHOOK_INVALID_INPUT"
  | "ENDPOINT_WEBHOOK_MISSING_SIGNATURE"
  | "ENDPOINT_WEBHOOK_INVALID_SIGNATURE"
  | "ENDPOINT_WEBHOOK_MISSING_DELIVERY"
  | "ENDPOINT_WEBHOOK_MALFORMED_PAYLOAD"
  | "ENDPOINT_WEBHOOK_UNCONFIGURED"
  | "ENDPOINT_WEBHOOK_ENDPOINT_MISMATCH"
  | "ENDPOINT_WEBHOOK_INSTALLATION_MISMATCH"
  | "ENDPOINT_WEBHOOK_REPOSITORY_UNBOUND"
  | "ENDPOINT_WEBHOOK_STALE_DELIVERY"
  | "ENDPOINT_WEBHOOK_DUPLICATE_DELIVERY"
  | "ENDPOINT_WEBHOOK_REPLAYED_DELIVERY"
  | "ENDPOINT_WEBHOOK_RETRY_DELIVERY";

export interface EndpointWebhookDiagnostic {
  readonly version: EndpointWebhookContractVersion;
  readonly code: EndpointWebhookDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface EndpointWebhookHint {
  readonly id: string;
  readonly occurredAt: string;
  readonly endpointId: string;
  readonly installationId: string;
  readonly repositoryId: string;
}

export interface EndpointWebhookAdmissionContext {
  readonly endpoint: EndpointIdentity;
  /** Optional self-hosted installation restriction. Signed payload evidence is the default. */
  readonly installation?: EndpointInstallationIdentity;
  /** Optional self-hosted repository restriction. Signed immutable IDs remain authoritative. */
  readonly repositories?: readonly EndpointRepositoryIdentity[];
  /** Singular form is convenient for one-repository self-hosted endpoints. */
  readonly repository?: EndpointRepositoryIdentity;
  /** Provider host partition used when constructing signed repository evidence. */
  readonly repositoryHost?: string;
  /** Optional self-hosted restriction; it may only narrow signed provider evidence. */
  readonly resolveEnrollment?: (candidate: EndpointWebhookEnrollmentCandidate) => boolean | Promise<boolean>;
}

export interface EndpointWebhookEnrollmentCandidate {
  readonly endpoint: EndpointIdentity;
  readonly installation: EndpointInstallationIdentity;
  readonly repository: EndpointRepositoryIdentity;
}

export interface EndpointWebhookAdmissionOptions extends EndpointWebhookAdmissionContext {
  /** GitHub App webhook secret. It is never copied into a result or diagnostic. */
  readonly secret: string;
  readonly now?: string | Date;
  readonly maxAgeMs?: number;
  /** Optional endpoint binding supplied by the transport, not by the payload. */
  readonly endpointId?: string;
  readonly replay?: EndpointWebhookReplayGuard;
}

export interface EndpointWebhookDelivery {
  readonly body: string | ArrayBuffer | ArrayBufferView;
  readonly signature?: string;
  readonly deliveryId?: string;
  readonly endpointId?: string;
  readonly event?: string;
  readonly occurredAt?: string | Date;
  /** GitHub retry marker supplied by an owning transport when known. */
  readonly retry?: boolean;
}

export interface EndpointWebhookAdmissionResult {
  readonly version: EndpointWebhookContractVersion;
  readonly classification: EndpointWebhookClassification;
  readonly admitted: boolean;
  readonly authenticated: boolean;
  readonly principal?: EndpointPrincipal;
  readonly diagnostics: readonly EndpointWebhookDiagnostic[];
  readonly hint?: EndpointWebhookHint;
  readonly endpoint?: EndpointIdentity;
  readonly installation?: EndpointInstallationIdentity;
  readonly repository?: EndpointRepositoryIdentity;
  readonly event?: string;
  readonly retryOf?: string;
}

export interface EndpointWebhookHandlerOptions {
  readonly admission: EndpointWebhookAdmissionOptions;
  readonly onHint?: (hint: EndpointWebhookHint, result: EndpointWebhookAdmissionResult) => void | Promise<void>;
}

export interface EndpointWebhookReplayRecord {
  readonly fingerprint: string;
  readonly admitted: boolean;
  readonly seenAt: number;
}

/** In-memory replay evidence is intentionally bounded and non-authoritative. */
export class EndpointWebhookReplayGuard {
  readonly #entries = new Map<string, EndpointWebhookReplayRecord>();
  readonly #limit: number;

  constructor(limit = ENDPOINT_WEBHOOK_LIMITS.seenDeliveries) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > ENDPOINT_WEBHOOK_LIMITS.seenDeliveries)
      throw new TypeError("Webhook replay capacity is outside the bounded limit.");
    this.#limit = limit;
  }

  get(deliveryId: string): EndpointWebhookReplayRecord | undefined {
    return this.#entries.get(deliveryId);
  }

  set(deliveryId: string, record: EndpointWebhookReplayRecord): void {
    this.#entries.delete(deliveryId);
    this.#entries.set(deliveryId, Object.freeze({ ...record }));
    while (this.#entries.size > this.#limit) this.#entries.delete(this.#entries.keys().next().value as string);
  }

  clear(): void {
    this.#entries.clear();
  }

  delete(deliveryId: string): void {
    this.#entries.delete(deliveryId);
  }

  get size(): number {
    return this.#entries.size;
  }
}

const encoder = new TextEncoder();
const DELIVERY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/iu;
const EVENT_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;

function diagnostic(code: EndpointWebhookDiagnosticCode, path: string, message: string): EndpointWebhookDiagnostic {
  return { version: ENDPOINT_WEBHOOK_CONTRACT_VERSION, code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const normalized = value.normalize("NFC");
  if (/[\u0000-\u001f\u007f]/u.test(normalized) || /[\ud800-\udfff]/u.test(normalized)) return undefined;
  if (encoder.encode(normalized).byteLength > maxBytes) return undefined;
  return normalized;
}

function dateValue(value: string | Date | undefined, fallback: number): { value?: string; ms: number } {
  if (value === undefined) return { ms: fallback };
  let source: string | undefined;
  try {
    source = value instanceof Date ? value.toISOString() : boundedText(value, 128);
  } catch {
    return { ms: Number.NaN };
  }
  if (source === undefined) return { ms: Number.NaN };
  const ms = Date.parse(source);
  return Number.isFinite(ms) ? { value: new Date(ms).toISOString(), ms } : { ms: Number.NaN };
}

function bodyBytes(value: EndpointWebhookDelivery["body"]): Uint8Array | undefined {
  if (typeof value === "string") {
    const bytes = encoder.encode(value);
    return bytes.byteLength <= ENDPOINT_WEBHOOK_LIMITS.bodyBytes ? bytes : undefined;
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > ENDPOINT_WEBHOOK_LIMITS.bodyBytes) return undefined;
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength > ENDPOINT_WEBHOOK_LIMITS.bodyBytes) return undefined;
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return undefined;
}

type BoundedRequestBody =
  { readonly kind: "ok"; readonly bytes: Uint8Array } | { readonly kind: "too-large" } | { readonly kind: "invalid" };

function contentLength(
  request: Request,
): { readonly kind: "ok" } | { readonly kind: "too-large" } | { readonly kind: "invalid" } {
  const value = request.headers.get("content-length");
  if (value === null) return { kind: "ok" };
  if (!/^\d{1,10}$/u.test(value)) return { kind: "invalid" };
  const length = Number(value);
  if (!Number.isSafeInteger(length)) return { kind: "invalid" };
  return length > ENDPOINT_WEBHOOK_LIMITS.bodyBytes ? { kind: "too-large" } : { kind: "ok" };
}

async function readBoundedRequestBody(request: Request): Promise<BoundedRequestBody> {
  const declared = contentLength(request);
  if (declared.kind !== "ok") return declared;
  const reader = request.body?.getReader();
  if (reader === undefined) return { kind: "invalid" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > ENDPOINT_WEBHOOK_LIMITS.bodyBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too-large" };
      }
      chunks.push(next.value);
    }
  } catch {
    return { kind: "invalid" };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", bytes };
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function sameBytes(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function expectedSignature(secret: string, body: Uint8Array): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await globalThis.crypto.subtle.sign("HMAC", key, body as unknown as BufferSource));
}

/** Verify GitHub's X-Hub-Signature-256 without exposing the secret. */
export async function verifyGitHubWebhookSignature(
  secret: string,
  body: EndpointWebhookDelivery["body"],
  signature: string | undefined,
): Promise<boolean> {
  const boundedSecret = boundedText(secret, ENDPOINT_WEBHOOK_LIMITS.secretBytes);
  const bytes = bodyBytes(body);
  if (boundedSecret === undefined || bytes === undefined || typeof signature !== "string") return false;
  const match = SIGNATURE_PATTERN.exec(signature.trim());
  if (match === null) return false;
  try {
    return sameBytes(match[1]!.toLowerCase(), await expectedSignature(boundedSecret, bytes));
  } catch {
    return false;
  }
}

function identityContext(options: EndpointWebhookAdmissionOptions):
  | {
      endpoint: EndpointIdentity;
      installation?: EndpointInstallationIdentity;
      repositories: readonly EndpointRepositoryIdentity[];
      repositoryHost: string;
      resolveEnrollment?: EndpointWebhookAdmissionContext["resolveEnrollment"];
    }
  | undefined {
  const endpoint = validateEndpointIdentity(options.endpoint);
  if (!endpoint.valid || endpoint.value === undefined) return undefined;
  const installation =
    options.installation === undefined ? undefined : validateEndpointInstallationIdentity(options.installation);
  if (installation !== undefined && (!installation.valid || installation.value === undefined)) return undefined;
  if (installation?.value !== undefined && installation.value.endpointId !== endpoint.value.id) return undefined;
  const configuredRepositories = options.repositories ?? (options.repository === undefined ? [] : [options.repository]);
  const repositories: EndpointRepositoryIdentity[] = [];
  for (const [index, value] of configuredRepositories.entries()) {
    const repository = validateEndpointRepositoryIdentity(value, `$.repositories[${index}]`);
    if (!repository.valid || repository.value === undefined) return undefined;
    if (repository.value.endpointId !== endpoint.value.id) return undefined;
    if (installation?.value !== undefined && repository.value.installationId !== installation.value.installationId)
      return undefined;
    repositories.push(repository.value);
  }
  const repositoryHost = options.repositoryHost ?? repositories[0]?.repositoryHost ?? "github.com";
  return {
    endpoint: endpoint.value,
    installation: installation?.value,
    repositories,
    repositoryHost,
    resolveEnrollment: options.resolveEnrollment,
  };
}

function repositoryFromPayload(payload: Record<string, unknown>): { id: string; nameWithOwner: string } | undefined {
  const repository = payload.repository;
  if (!isRecord(repository)) return undefined;
  const rawId = repository.id;
  const id =
    typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId >= 0
      ? String(rawId)
      : typeof rawId === "string" && /^\d{1,32}$/u.test(rawId)
        ? rawId
        : undefined;
  const name = boundedText(repository.full_name, 256);
  if (id === undefined || name === undefined || !/^[^/\s]+\/[^/\s]+$/u.test(name)) return undefined;
  return { id, nameWithOwner: name };
}

function installationFromPayload(payload: Record<string, unknown>): string | undefined {
  const installation = payload.installation;
  if (!isRecord(installation)) return undefined;
  const rawId = installation.id;
  if (typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId >= 0) return String(rawId);
  if (typeof rawId === "string" && /^\d{1,32}$/u.test(rawId)) return rawId;
  return undefined;
}

async function fingerprint(body: Uint8Array): Promise<string> {
  return hex(await globalThis.crypto.subtle.digest("SHA-256", body as unknown as BufferSource));
}

function emptyResult(
  classification: EndpointWebhookClassification,
  authenticated: boolean,
  diagnostics: readonly EndpointWebhookDiagnostic[],
): EndpointWebhookAdmissionResult {
  return Object.freeze({
    version: ENDPOINT_WEBHOOK_CONTRACT_VERSION,
    classification,
    admitted: classification === "admitted",
    authenticated,
    diagnostics: Object.freeze([...diagnostics].slice(0, 16)),
  });
}

/**
 * Authenticate and admit one delivery. The returned hint contains delivery
 * identity only; payload fields are intentionally absent from the handoff.
 */
export async function admitEndpointWebhook(
  delivery: EndpointWebhookDelivery,
  options: EndpointWebhookAdmissionOptions,
): Promise<EndpointWebhookAdmissionResult> {
  if (options === undefined || options === null || typeof options !== "object")
    return emptyResult("rejected", false, [
      diagnostic("ENDPOINT_WEBHOOK_UNCONFIGURED", "$.context", "Endpoint enrollment evidence is incomplete."),
    ]);
  const bytes = bodyBytes(delivery?.body);
  if (bytes === undefined)
    return emptyResult("rejected", false, [
      diagnostic("ENDPOINT_WEBHOOK_INVALID_INPUT", "$.body", "Webhook body is missing or exceeds its bounded size."),
    ]);
  const deliveryId = boundedText(delivery.deliveryId, ENDPOINT_WEBHOOK_LIMITS.deliveryIdBytes);
  if (deliveryId === undefined || !DELIVERY_PATTERN.test(deliveryId))
    return emptyResult("rejected", false, [
      diagnostic("ENDPOINT_WEBHOOK_MISSING_DELIVERY", "$.deliveryId", "A bounded delivery identifier is required."),
    ]);
  const signature = typeof delivery.signature === "string" ? delivery.signature : undefined;
  if (signature === undefined)
    return emptyResult("rejected", false, [
      diagnostic("ENDPOINT_WEBHOOK_MISSING_SIGNATURE", "$.signature", "A GitHub SHA-256 signature is required."),
    ]);
  const authenticated = await verifyGitHubWebhookSignature(options.secret, bytes, signature);
  if (!authenticated)
    return emptyResult("rejected", false, [
      diagnostic("ENDPOINT_WEBHOOK_INVALID_SIGNATURE", "$.signature", "Webhook signature verification failed."),
    ]);

  const context = identityContext(options);
  if (context === undefined)
    return emptyResult("rejected", true, [
      diagnostic("ENDPOINT_WEBHOOK_UNCONFIGURED", "$.context", "Endpoint enrollment evidence is incomplete."),
    ]);
  const suppliedEndpointId = delivery.endpointId ?? options.endpointId;
  if (suppliedEndpointId !== undefined && suppliedEndpointId !== context.endpoint.id)
    return emptyResult("rejected", true, [
      diagnostic("ENDPOINT_WEBHOOK_ENDPOINT_MISMATCH", "$.endpointId", "Delivery is bound to a different Endpoint."),
    ]);

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return emptyResult("rejected", true, [
      diagnostic("ENDPOINT_WEBHOOK_MALFORMED_PAYLOAD", "$.body", "Webhook payload is not valid JSON."),
    ]);
  }
  if (!isRecord(payload))
    return emptyResult("rejected", true, [
      diagnostic("ENDPOINT_WEBHOOK_MALFORMED_PAYLOAD", "$.body", "Webhook payload must be an object."),
    ]);
  const event = boundedText(delivery.event ?? payload.action, ENDPOINT_WEBHOOK_LIMITS.eventBytes);
  if (delivery.event !== undefined && (event === undefined || !EVENT_PATTERN.test(event)))
    return emptyResult("rejected", true, [
      diagnostic("ENDPOINT_WEBHOOK_INVALID_INPUT", "$.event", "Webhook event name is invalid."),
    ]);
  const installationId = installationFromPayload(payload);
  if (installationId === undefined)
    return emptyResult("rejected", true, [
      diagnostic(
        "ENDPOINT_WEBHOOK_INSTALLATION_MISMATCH",
        "$.installation.id",
        "Delivery has no valid installation identity.",
      ),
    ]);
  if (context.installation !== undefined && installationId !== context.installation.installationId)
    return emptyResult("rejected", true, [
      diagnostic(
        "ENDPOINT_WEBHOOK_INSTALLATION_MISMATCH",
        "$.installation.id",
        "Delivery is bound to a different installation.",
      ),
    ]);
  const payloadRepository = repositoryFromPayload(payload);
  if (payloadRepository === undefined)
    return emptyResult("rejected", true, [
      diagnostic("ENDPOINT_WEBHOOK_REPOSITORY_UNBOUND", "$.repository", "Delivery has no valid repository identity."),
    ]);
  const installation = {
    version: ENDPOINT_WEBHOOK_CONTRACT_VERSION,
    kind: "installation",
    endpointId: context.endpoint.id,
    installationId,
  } satisfies EndpointInstallationIdentity;
  const repositoryCandidate = {
    version: ENDPOINT_WEBHOOK_CONTRACT_VERSION,
    kind: "repository",
    endpointId: context.endpoint.id,
    installationId,
    repositoryHost: context.repositoryHost,
    repositoryId: payloadRepository.id,
    nameWithOwner: payloadRepository.nameWithOwner,
  } satisfies EndpointRepositoryIdentity;
  const repositoryValidation = validateEndpointRepositoryIdentity(repositoryCandidate);
  if (!repositoryValidation.valid || repositoryValidation.value === undefined)
    return emptyResult("rejected", true, [
      diagnostic("ENDPOINT_WEBHOOK_REPOSITORY_UNBOUND", "$.repository.id", "Delivery repository identity is invalid."),
    ]);
  const repository = repositoryValidation.value;
  const repositories = context.repositories.filter(
    (candidate) =>
      candidate.installationId === installationId &&
      candidate.repositoryHost === repository.repositoryHost &&
      candidate.repositoryId === repository.repositoryId,
  );
  if (context.repositories.length > 0 && repositories.length !== 1)
    return emptyResult("rejected", true, [
      diagnostic(
        "ENDPOINT_WEBHOOK_REPOSITORY_UNBOUND",
        "$.repository.id",
        "Repository is not enrolled on this Endpoint installation.",
      ),
    ]);
  if (context.resolveEnrollment !== undefined) {
    let enrolled = false;
    try {
      enrolled = await context.resolveEnrollment({ endpoint: context.endpoint, installation, repository });
    } catch {
      enrolled = false;
    }
    if (!enrolled)
      return emptyResult("rejected", true, [
        diagnostic(
          "ENDPOINT_WEBHOOK_REPOSITORY_UNBOUND",
          "$.repository.id",
          "Repository is not enrolled on this Endpoint installation.",
        ),
      ]);
  }

  const receivedAt = dateValue(delivery.occurredAt, Date.now());
  if (!Number.isFinite(receivedAt.ms))
    return emptyResult("rejected", true, [
      diagnostic("ENDPOINT_WEBHOOK_INVALID_INPUT", "$.occurredAt", "Delivery time is invalid."),
    ]);
  const nowInput = dateValue(options.now, Date.now());
  if (!Number.isFinite(nowInput.ms))
    return emptyResult("rejected", true, [
      diagnostic("ENDPOINT_WEBHOOK_INVALID_INPUT", "$.now", "Admission time is invalid."),
    ]);
  const maxAgeMs = options.maxAgeMs ?? ENDPOINT_RECONCILIATION_LIMITS.defaultFreshnessMs;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > ENDPOINT_WEBHOOK_LIMITS.maxAgeMs)
    return emptyResult("rejected", true, [
      diagnostic("ENDPOINT_WEBHOOK_INVALID_INPUT", "$.maxAgeMs", "Delivery freshness bound is invalid."),
    ]);
  if (nowInput.ms - receivedAt.ms > maxAgeMs || receivedAt.ms - nowInput.ms > ENDPOINT_WEBHOOK_LIMITS.maxFutureSkewMs)
    return emptyResult("stale", true, [
      diagnostic("ENDPOINT_WEBHOOK_STALE_DELIVERY", "$.occurredAt", "Delivery is outside the freshness bound."),
    ]);

  const guard = options.replay ?? new EndpointWebhookReplayGuard();
  let digest: string;
  try {
    digest = await fingerprint(bytes);
  } catch {
    return emptyResult("rejected", true, [
      diagnostic("ENDPOINT_WEBHOOK_INVALID_INPUT", "$.body", "Delivery fingerprinting is unavailable."),
    ]);
  }
  const prior = guard.get(deliveryId);
  if (prior !== undefined) {
    if (prior.fingerprint !== digest)
      return Object.freeze({
        ...emptyResult("replay", true, [
          diagnostic(
            "ENDPOINT_WEBHOOK_REPLAYED_DELIVERY",
            "$.deliveryId",
            "Delivery identity was reused with different content.",
          ),
        ]),
        retryOf: deliveryId,
      });
    const classification: EndpointWebhookClassification = delivery.retry === true ? "retry" : "duplicate";
    return Object.freeze({
      ...emptyResult(classification, true, [
        diagnostic(
          classification === "retry" ? "ENDPOINT_WEBHOOK_RETRY_DELIVERY" : "ENDPOINT_WEBHOOK_DUPLICATE_DELIVERY",
          "$.deliveryId",
          classification === "retry" ? "Delivery retry was already observed." : "Duplicate delivery was ignored.",
        ),
      ]),
      endpoint: context.endpoint,
      installation,
      repository,
      principal: {
        version: 1,
        kind: "webhook-delivery",
        id: deliveryId,
      } as const,
      event,
      retryOf: deliveryId,
    });
  }
  const hint = Object.freeze({
    id: deliveryId,
    occurredAt: receivedAt.value ?? new Date(receivedAt.ms).toISOString(),
    endpointId: context.endpoint.id,
    installationId,
    repositoryId: repository.repositoryId,
  }) satisfies EndpointWebhookHint;
  guard.set(deliveryId, { fingerprint: digest, admitted: true, seenAt: nowInput.ms });
  return Object.freeze({
    version: ENDPOINT_WEBHOOK_CONTRACT_VERSION,
    classification: "admitted",
    admitted: true,
    authenticated: true,
    diagnostics: [],
    hint,
    endpoint: context.endpoint,
    installation,
    repository,
    principal: {
      version: 1,
      kind: "webhook-delivery",
      id: deliveryId,
    } as const,
    event,
  });
}

function webhookResponse(result: EndpointWebhookAdmissionResult): Response {
  const status =
    result.classification === "admitted" || result.classification === "stale"
      ? 202
      : result.classification === "duplicate" || result.classification === "retry"
        ? 200
        : result.classification === "replay"
          ? 409
          : result.authenticated
            ? 400
            : 401;
  return new Response(
    JSON.stringify({
      version: result.version,
      ok: result.admitted,
      classification: result.classification,
      authenticated: result.authenticated,
      diagnostics: result.diagnostics,
      ...(result.hint === undefined ? {} : { hint: result.hint }),
    }),
    {
      status,
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
    },
  );
}

/** Create a bounded POST handler for a hosted or self-hosted GitHub route. */
export function createEndpointWebhookHandler(
  options: EndpointWebhookHandlerOptions,
): (request: Request) => Promise<Response> {
  const replay = options.admission.replay ?? new EndpointWebhookReplayGuard();
  const admission = { ...options.admission, replay };
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST")
      return new Response("Method not allowed.", { status: 405, headers: { allow: "POST" } });
    const receivedAt = new Date().toISOString();
    const body = await readBoundedRequestBody(request);
    if (body.kind === "too-large")
      return new Response("Payload too large.", { status: 413, headers: { "cache-control": "no-store" } });
    if (body.kind === "invalid")
      return new Response("Invalid webhook body.", { status: 400, headers: { "cache-control": "no-store" } });
    const result = await admitEndpointWebhook(
      {
        body: body.bytes,
        signature: request.headers.get("x-hub-signature-256") ?? undefined,
        deliveryId: request.headers.get("x-github-delivery") ?? undefined,
        event: request.headers.get("x-github-event") ?? undefined,
        occurredAt: receivedAt,
      },
      admission,
    );
    if (result.admitted && result.hint !== undefined && options.onHint !== undefined) {
      try {
        await options.onHint(result.hint, result);
      } catch {
        admission.replay?.delete(result.hint.id);
        return new Response("Webhook handoff unavailable.", { status: 503, headers: { "cache-control": "no-store" } });
      }
    }
    return webhookResponse(result);
  };
}

/** Apply only an admitted hint to the existing reconciliation kernel. */
export function handoffEndpointWebhookHint<T>(
  record: EndpointObservationRecord<T>,
  result: EndpointWebhookAdmissionResult,
): EndpointObservationRecord<T> {
  if (!result.admitted || result.hint === undefined) return record;
  return applyEndpointWebhookHint(record, {
    id: result.hint.id,
    occurredAt: result.hint.occurredAt,
  });
}

export const admitGitHubWebhook = admitEndpointWebhook;
export const verifyWebhookSignature = verifyGitHubWebhookSignature;
export const applyEndpointWebhookAdmissionHint = handoffEndpointWebhookHint;
