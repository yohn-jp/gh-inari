/**
 * Transport-neutral client composition for the privileged Session MCP tool.
 *
 * This module owns neither MCP connection lifecycle nor Session authority. It
 * receives an opaque call-tool port and the canonical #888 signer capability,
 * creates one envelope immediately before each invocation, and forwards only
 * that envelope to `inari_change_execute`.
 */

import { randomUUID } from "node:crypto";
import {
  MAX_SESSION_REQUEST_ID_LENGTH,
  MAX_SESSION_REQUEST_TTL_SECONDS,
  type SemanticSessionRequest,
  type SessionRequestEnvelope,
} from "../agent-authority/session-request.js";
import type { SessionSigner, SessionSignerMetadata } from "../agent-authority/session-signer.js";

export const INARI_CHANGE_EXECUTE_TOOL_NAME = "inari_change_execute" as const;

/** The only transport capability required by this adapter. */
export interface McpCallToolPort {
  callTool(request: {
    readonly name: typeof INARI_CHANGE_EXECUTE_TOOL_NAME;
    readonly arguments: { readonly envelope: SessionRequestEnvelope };
  }): Promise<unknown>;
}

export interface SessionMcpClientOptions {
  readonly signer: SessionSigner;
  readonly callTool: McpCallToolPort;
  /** Injectable request-id source; its output is checked by the canonical signer. */
  readonly requestId?: () => string;
  /** Injectable Unix-seconds clock used for issuedAt when it is omitted. */
  readonly now?: () => number;
  /** Default freshness window for requests without an explicit expiresAt. */
  readonly ttlSeconds?: number;
}

export interface SessionMcpInvocation {
  readonly request: SemanticSessionRequest;
  readonly operation: string;
  readonly requestId?: string;
  readonly issuedAt?: number;
  readonly expiresAt?: number;
}

export interface SessionMcpClientMetadata extends SessionSignerMetadata {
  readonly toolName: typeof INARI_CHANGE_EXECUTE_TOOL_NAME;
}

export interface SessionMcpClientSuccess {
  readonly ok: true;
  readonly result: unknown;
  readonly envelope: SessionRequestEnvelope;
}

export type SessionMcpClientFailureCode =
  | "MCP_SESSION_CLIENT_INVALID_INPUT"
  | "MCP_SESSION_CLIENT_SIGNING_FAILURE"
  | "MCP_SESSION_CLIENT_TRANSPORT_FAILURE"
  | "MCP_SESSION_CLIENT_TOOL_FAILURE";

export interface SessionMcpClientFailure {
  readonly ok: false;
  readonly failure: {
    readonly code: SessionMcpClientFailureCode;
    readonly message: string;
  };
}

export type SessionMcpClientResult = SessionMcpClientSuccess | SessionMcpClientFailure;

export interface SessionMcpClient {
  readonly metadata: SessionMcpClientMetadata;
  execute(invocation: SessionMcpInvocation): Promise<SessionMcpClientResult>;
}

const DEFAULT_TTL_SECONDS = MAX_SESSION_REQUEST_TTL_SECONDS;
// Keep generated freshness values inside the same bounded Unix-time domain
// accepted by the canonical Session request validator.
const MAX_UNIX_TIME_SECONDS = 253_402_300_799;

function failure(code: SessionMcpClientFailureCode, message: string): SessionMcpClientFailure {
  return Object.freeze({ ok: false as const, failure: Object.freeze({ code, message }) });
}

function validRequestId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SESSION_REQUEST_ID_LENGTH && /^[\x21-\x7e]+$/u.test(value);
}

function validUnixSeconds(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_UNIX_TIME_SECONDS;
}

function validTtl(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_SESSION_REQUEST_TTL_SECONDS;
}

function boundedMessage(error: unknown, fallback: string): string {
  // Errors are deliberately not exposed: transport/provider errors can carry
  // credentials or implementation details. Every public failure is stable.
  void error;
  return fallback;
}

function invocationFields(
  invocation: SessionMcpInvocation,
  options: Required<Pick<SessionMcpClientOptions, "requestId" | "now" | "ttlSeconds">>,
):
  | { readonly ok: true; readonly requestId: string; readonly issuedAt: number; readonly expiresAt: number }
  | SessionMcpClientFailure {
  const requestId = invocation.requestId ?? options.requestId();
  if (typeof requestId !== "string" || !validRequestId(requestId)) {
    return failure("MCP_SESSION_CLIENT_INVALID_INPUT", "Session MCP request-id is invalid.");
  }

  const issuedAt = invocation.issuedAt ?? options.now();
  if (typeof issuedAt !== "number" || !validUnixSeconds(issuedAt)) {
    return failure("MCP_SESSION_CLIENT_INVALID_INPUT", "Session MCP issuedAt is invalid.");
  }

  const expiresAt = invocation.expiresAt ?? issuedAt + options.ttlSeconds;
  if (typeof expiresAt !== "number" || !validUnixSeconds(expiresAt) || expiresAt <= issuedAt) {
    return failure("MCP_SESSION_CLIENT_INVALID_INPUT", "Session MCP expiresAt is invalid.");
  }

  return { ok: true, requestId, issuedAt, expiresAt };
}

function isToolError(result: unknown): boolean {
  return typeof result === "object" && result !== null && "isError" in result && result.isError === true;
}

/**
 * Create the configured handoff unit. The returned object closes over the
 * signer capability and call port; it has no private-key or credential field.
 */
export function createSessionMcpClient(options: SessionMcpClientOptions): SessionMcpClient {
  if (typeof options !== "object" || options === null) throw new TypeError("Session MCP client options are invalid.");
  if (typeof options.signer?.signRequest !== "function") throw new TypeError("Session MCP signer is invalid.");
  if (typeof options.callTool?.callTool !== "function") throw new TypeError("Session MCP call-tool port is invalid.");

  const requestId = options.requestId ?? randomUUID;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (typeof requestId !== "function" || typeof now !== "function" || !validTtl(ttlSeconds)) {
    throw new TypeError("Session MCP client freshness sources are invalid.");
  }

  const metadata = Object.freeze({ ...options.signer.metadata, toolName: INARI_CHANGE_EXECUTE_TOOL_NAME });
  const execute = async (invocation: SessionMcpInvocation): Promise<SessionMcpClientResult> => {
    if (
      typeof invocation !== "object" ||
      invocation === null ||
      typeof invocation.operation !== "string" ||
      invocation.operation.length === 0 ||
      typeof invocation.request !== "object" ||
      invocation.request === null ||
      Array.isArray(invocation.request)
    ) {
      return failure("MCP_SESSION_CLIENT_INVALID_INPUT", "Session MCP invocation is invalid.");
    }

    const fields = invocationFields(invocation, { requestId, now, ttlSeconds });
    if (!fields.ok) return fields;

    let envelope: SessionRequestEnvelope;
    try {
      envelope = options.signer.signRequest({
        request: invocation.request,
        operation: invocation.operation,
        requestId: fields.requestId,
        issuedAt: fields.issuedAt,
        expiresAt: fields.expiresAt,
      });
    } catch (error: unknown) {
      return failure("MCP_SESSION_CLIENT_SIGNING_FAILURE", boundedMessage(error, "Session MCP signing failed."));
    }

    try {
      const result = await options.callTool.callTool({
        name: INARI_CHANGE_EXECUTE_TOOL_NAME,
        arguments: { envelope },
      });
      if (isToolError(result)) {
        return failure("MCP_SESSION_CLIENT_TOOL_FAILURE", "Session MCP tool execution failed.");
      }
      return Object.freeze({ ok: true as const, result, envelope });
    } catch (error: unknown) {
      return failure("MCP_SESSION_CLIENT_TRANSPORT_FAILURE", boundedMessage(error, "Session MCP transport failed."));
    }
  };

  return Object.freeze({ metadata, execute });
}

/** Naming alias for callers that describe the configured object as an adapter. */
export const createSessionMcpAdapter = createSessionMcpClient;
