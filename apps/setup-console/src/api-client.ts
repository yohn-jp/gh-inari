/**
 * Typed browser transport over the exact #1118 local setup API.
 *
 * Every request carries the in-memory operator context as headers only, with
 * no cookies, no cache and no referrer. Response bodies are parsed as the
 * canonical contracts; error bodies are never read or echoed.
 */
import type { SetupState } from "../../../src/application/setup/state.js";
import { MAX_SECRET_ENROLLMENT_BYTES } from "../../../src/runtime-contracts/enrollment.js";
import {
  validateSetupAction,
  validateSetupActionResult,
  type SetupActionRequest,
  type SetupActionResult,
} from "../../../src/runtime-contracts/setup.js";
import { validateSetupDiagnostics, validateSetupGeneration } from "../../../src/runtime-contracts/setup-primitives.js";
import type { SetupOperatorContext } from "./bootstrap.js";

export const SETUP_API_PATHS = Object.freeze({
  state: "/api/setup/state",
  confirm: "/api/setup/confirm",
  actions: "/api/setup/actions",
  enrollment: "/api/setup/enrollment/",
});

const MAX_RESPONSE_CHARACTERS = 256 * 1024;
const INPUT_ID = /^[A-Za-z0-9_-]{1,64}$/u;

export type SetupApiFailure = "rejected" | "stale" | "invalid" | "unavailable" | "not-found" | "response-invalid";

/** Transport failure with a fixed, secret-free classification; no response body is kept. */
export class SetupApiError extends Error {
  readonly failure: SetupApiFailure;
  readonly status: number;
  constructor(failure: SetupApiFailure, status: number) {
    super(`Setup API request failed: ${failure}.`);
    this.name = "SetupApiError";
    this.failure = failure;
    this.status = status;
  }
}

export interface SetupTransport {
  state(): Promise<SetupState>;
  /** Short-lived single-use confirmation bound by the server to the action and current generation. */
  confirm(actionId: string): Promise<string>;
  perform(confirmation: string, request: SetupActionRequest): Promise<SetupActionResult>;
  /**
   * Streams one enrollment upload together with the action's secret-free typed
   * request (declared non-enrollment inputs, generation). The file is the body;
   * it never enters JSON.
   */
  enroll(
    inputId: string,
    confirmation: string,
    request: SetupActionRequest,
    body: Blob,
    signal: AbortSignal,
  ): Promise<SetupActionResult>;
}

function classify(status: number): SetupApiFailure {
  if (status === 403) return "rejected";
  if (status === 409) return "stale";
  if (status === 404) return "not-found";
  if (status === 400) return "invalid";
  return "unavailable";
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SetupApiError("response-invalid", 200);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new SetupApiError("response-invalid", 200);
  }
  return value;
}

/** Parses the canonical state the wizard renders; unknown shapes are rejected, not repaired. */
export function readSetupState(value: unknown): SetupState {
  try {
    const record = object(value);
    const steps = record.steps;
    const dimensions = record.dimensions;
    const actions = record.actions;
    if (!Array.isArray(steps) || !Array.isArray(dimensions) || !Array.isArray(actions)) {
      throw new SetupApiError("response-invalid", 200);
    }
    const generation = validateSetupGeneration(record.generation, "$.generation");
    const next = object(record.nextAction);
    string(next.kind);
    for (const item of steps) {
      const step = object(item);
      string(step.dimension);
      string(step.status);
      if (step.actionId !== undefined) string(step.actionId);
      validateSetupDiagnostics(step.diagnostics, "$.steps.diagnostics");
    }
    for (const item of dimensions) {
      const dimension = object(item);
      string(dimension.dimension);
      string(dimension.status);
      string(dimension.freshness);
    }
    const repository = validateSetupGeneration(
      { repository: record.repository, configuration: generation.configuration },
      "$.repository",
    ).repository;
    return Object.freeze({
      ...(record as unknown as SetupState),
      repository,
      generation,
      stage: string(record.stage) as SetupState["stage"],
      actions: Object.freeze(actions.map((action) => validateSetupAction(action))),
      diagnostics: validateSetupDiagnostics(record.diagnostics, "$.diagnostics"),
    });
  } catch (error) {
    if (error instanceof SetupApiError) throw error;
    throw new SetupApiError("response-invalid", 200);
  }
}

export function createSetupApiClient(context: SetupOperatorContext, fetchImpl: typeof fetch): SetupTransport {
  async function send(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: BodyInit; signal?: AbortSignal },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(context.apiOrigin + path, {
        method: init.method,
        headers: { ...init.headers, ...context.authorizationHeaders() },
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        mode: "same-origin",
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new SetupApiError("unavailable", 0);
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new SetupApiError(classify(response.status), response.status);
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARACTERS) throw new SetupApiError("response-invalid", 200);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SetupApiError("response-invalid", 200);
    }
  }
  const jsonHeaders = { "content-type": "application/json" };

  return Object.freeze({
    async state() {
      return readSetupState(await send(SETUP_API_PATHS.state, { method: "GET" }));
    },
    async confirm(actionId: string) {
      const value = object(
        await send(SETUP_API_PATHS.confirm, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ actionId }),
        }),
      );
      return string(value.confirmation);
    },
    async perform(confirmation: string, request: SetupActionRequest) {
      const value = await send(SETUP_API_PATHS.actions, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ confirmation, request }),
      });
      try {
        return validateSetupActionResult(value);
      } catch {
        throw new SetupApiError("response-invalid", 200);
      }
    },
    async enroll(inputId: string, confirmation: string, request: SetupActionRequest, file: Blob, signal: AbortSignal) {
      if (!INPUT_ID.test(inputId)) throw new SetupApiError("invalid", 0);
      if (file.size < 1 || file.size > MAX_SECRET_ENROLLMENT_BYTES) throw new SetupApiError("invalid", 0);
      const value = await send(SETUP_API_PATHS.enrollment + inputId, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-setup-action-id": request.actionId,
          "x-setup-confirmation": confirmation,
          // Percent-encoded so any secret-free text input stays a valid header value.
          "x-setup-request": encodeURIComponent(JSON.stringify(request)),
        },
        body: file,
        signal,
      });
      try {
        return validateSetupActionResult(value);
      } catch {
        throw new SetupApiError("response-invalid", 200);
      }
    },
  });
}
