/** Injectable local HTTP projection of the canonical setup application. */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { RepositoryIdentity } from "../github/effect-authorizer.js";
import type { SetupApplication } from "../application/setup/actions.js";
import { validateSetupActionRequest, sameSetupGeneration } from "../runtime-contracts/index.js";
import { isLocalRuntimeLoopbackAddress } from "../local-control/status-page.js";
import { enrollmentUpload } from "./enrollment-forwarder.js";
import { OperatorSession } from "./operator-session.js";

export interface SetupApiOptions {
  readonly application: SetupApplication;
  readonly repository: RepositoryIdentity;
  readonly configuration: string;
  readonly session: OperatorSession;
  /** Exact browser authority, including dynamic port or SSH forwarded localhost port. */
  readonly origin: string;
}
const fail = (out: ServerResponse, status: number): void => {
  out.statusCode = status;
  out.end();
};
const json = (out: ServerResponse, value: unknown): void => {
  out.setHeader("content-type", "application/json; charset=utf-8");
  out.end(JSON.stringify(value));
};
async function boundedJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") throw new Error("Invalid content type.");
  let length = 0;
  const parts: Buffer[] = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16 * 1024) throw new Error("Request too large.");
    parts.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
}
export function createSetupApiServer(options: SetupApiOptions): Server {
  const expected = new URL(options.origin);
  if (
    expected.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(expected.hostname) ||
    expected.pathname !== "/" ||
    expected.search ||
    expected.hash
  ) {
    throw new Error("Setup API origin must be a local HTTP origin.");
  }
  return createServer((request, out) => {
    void (async () => {
      out.setHeader("cache-control", "no-store");
      out.setHeader("x-content-type-options", "nosniff");
      out.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
      out.setHeader("referrer-policy", "no-referrer");
      const expected = new URL(options.origin);
      const url = new URL(request.url ?? "/", options.origin);
      if (
        !isLocalRuntimeLoopbackAddress(request.socket.remoteAddress) ||
        request.headers.host !== expected.host ||
        (request.headers.origin !== undefined && request.headers.origin !== options.origin) ||
        (request.method !== "GET" && request.headers.origin !== options.origin) ||
        url.search !== "" ||
        url.hash !== ""
      )
        return fail(out, 403);
      const bearer = request.headers.authorization?.startsWith("Bearer ")
        ? request.headers.authorization.slice(7)
        : undefined;
      if (
        !options.session.authorize(
          bearer,
          request.headers["x-csrf-token"] as string | undefined,
          options.repository,
          options.configuration,
        )
      )
        return fail(out, 403);
      const state = await options.application.state(options.repository);
      if (
        state.generation.configuration !== options.session.context.configuration ||
        state.generation.repository.repositoryHost !== options.session.context.repository.repositoryHost ||
        state.generation.repository.repositoryId !== options.session.context.repository.repositoryId
      )
        return fail(out, 409);
      if (url.pathname === "/api/setup/state" && request.method === "GET") {
        return json(out, state);
      }
      if (url.pathname === "/api/setup/confirm" && request.method === "POST") {
        const body = await boundedJson(request);
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          typeof (body as { actionId?: unknown }).actionId !== "string"
        )
          return fail(out, 400);
        const actionId = (body as { actionId: string }).actionId;
        if (!state.actions.some((action) => action.id === actionId)) return fail(out, 409);
        return json(out, { confirmation: options.session.confirm(actionId) });
      }
      if (url.pathname === "/api/setup/actions" && request.method === "POST") {
        const body = await boundedJson(request);
        if (typeof body !== "object" || body === null || Array.isArray(body)) return fail(out, 400);
        const { confirmation, request: actionBody } = body as { confirmation?: unknown; request?: unknown };
        if (Object.keys(body).some((key) => key !== "confirmation" && key !== "request")) return fail(out, 400);
        const action = validateSetupActionRequest(actionBody);
        if (
          !sameSetupGeneration(action.generation, state.generation) ||
          !state.actions.some((item) => item.id === action.actionId) ||
          !action.confirmed ||
          !options.session.consume(confirmation as string | undefined, action.actionId)
        )
          return fail(out, 409);
        return json(out, await options.application.perform(options.repository, action));
      }
      const match = /^\/api\/setup\/enrollment\/([A-Za-z0-9_-]{1,64})$/u.exec(url.pathname);
      if (match && request.method === "POST") {
        const actionId = request.headers["x-setup-action-id"];
        const confirmation = request.headers["x-setup-confirmation"];
        if (typeof actionId !== "string" || typeof confirmation !== "string") return fail(out, 400);
        const offered = state.actions.find(
          (action) =>
            action.id === actionId &&
            action.inputs.some((input) => input.id === match[1] && input.kind === "enrollment"),
        );
        if (offered === undefined || !options.session.consume(confirmation, actionId)) return fail(out, 409);
        const upload = enrollmentUpload(request);
        const result = await options.application.perform(
          options.repository,
          {
            version: offered.version,
            actionId,
            generation: state.generation,
            confirmed: true,
            inputs: {},
          },
          { enrollments: { [match[1]]: upload } },
        );
        return json(out, result);
      }
      return fail(out, 404);
    })().catch(() => fail(out, 400));
  });
}
