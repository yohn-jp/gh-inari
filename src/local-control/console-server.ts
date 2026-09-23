/** Loopback-only browser projection of the canonical local setup/runtime state. */

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  projectLocalApplicationState,
  projectLocalRuntimeReadiness,
  type LocalApplicationState,
  type LocalRuntimeReadiness,
} from "../local-application-state.js";
import {
  clearLocalRuntimeEndpoint,
  publishLocalRuntimeEndpoint,
  type LocalRuntimeEndpoint,
} from "./runtime-discovery.js";
import { escapeHtml, isLocalRuntimeLoopbackAddress } from "./status-page.js";

export const LOCAL_CONSOLE_PROTOCOL_VERSION = 1 as const;
export const LOCAL_CONSOLE_ROOT_PATH = "/" as const;
export const LOCAL_CONSOLE_STATE_PATH = "/api/state" as const;

export class LocalConsoleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalConsoleError";
    this.code = code;
  }
}

const SETUP_STEP_LABEL: Readonly<Record<LocalApplicationState["steps"][number]["status"], string>> = {
  ready: "completed",
  required: "pending",
  waiting: "pending",
  blocked: "blocked",
};

function renderLocalConsolePage(input: {
  readonly application: LocalApplicationState;
  readonly runtime: LocalRuntimeReadiness;
}): string {
  const { application, runtime } = input;
  const steps = application.steps
    .map((step, index) => {
      const diagnostic = step.diagnostic === undefined ? "" : ` <em>(${escapeHtml(step.diagnostic)})</em>`;
      return [
        "        <li>",
        `[${escapeHtml(SETUP_STEP_LABEL[step.status])}] ${escapeHtml(step.title)}${diagnostic}`,
        `<br><code>${escapeHtml(step.syntax)}</code>`,
        "</li>",
      ].join("");
    })
    .join("\n");
  const nextActionCommands = application.nextAction.commands
    .map((commandLine) => `      <pre><code>${escapeHtml(commandLine)}</code></pre>`)
    .join("\n");
  const body = [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    '    <meta name="robots" content="noindex, nofollow">',
    "    <title>Inari local setup and runtime console</title>",
    "  </head>",
    "  <body>",
    "    <main>",
    "      <h1>Inari local setup and runtime console</h1>",
    `      <p>Local execution setup: <strong>${escapeHtml(application.status)}</strong></p>`,
    "      <h2>Ordered setup path</h2>",
    "      <ol>",
    steps,
    "      </ol>",
    "      <h2>Next action</h2>",
    `      <p>${escapeHtml(application.nextAction.detail)}</p>`,
    nextActionCommands,
    "      <h2>Runtime readiness</h2>",
    "      <dl>",
    `        <dt>Executor</dt><dd>${escapeHtml(runtime.executor)}</dd>`,
    `        <dt>Admission</dt><dd>${escapeHtml(runtime.admission)}</dd>`,
    `        <dt>Local Runtime</dt><dd>${escapeHtml(runtime.overall)}</dd>`,
    "      </dl>",
    "      <h2>Governed Session</h2>",
    `      <p><code>${escapeHtml(application.sessionStartCommand)}</code></p>`,
    "      <p>This page is loopback-only and never renders credentials, tokens, or private key material.</p>",
    "    </main>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");
  return body;
}

export interface LocalConsoleServerOptions {
  readonly root: string;
  readonly environment?: NodeJS.ProcessEnv;
}

/** Create the loopback-only HTTP server; the returned server is already listening. */
export function createLocalConsoleHttpServer(options: LocalConsoleServerOptions): Server {
  const environment = options.environment ?? process.env;
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        if (!isLocalRuntimeLoopbackAddress(incoming.socket.remoteAddress)) {
          outgoing.statusCode = 404;
          outgoing.end();
          return;
        }
        const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== LOCAL_CONSOLE_ROOT_PATH && url.pathname !== LOCAL_CONSOLE_STATE_PATH) {
          outgoing.statusCode = 404;
          outgoing.end();
          return;
        }
        if (incoming.method !== "GET") {
          outgoing.statusCode = 405;
          outgoing.setHeader("allow", "GET");
          outgoing.setHeader("content-type", "text/plain; charset=utf-8");
          outgoing.end("Only GET is supported.\n");
          return;
        }
        const [application, runtime] = await Promise.all([
          projectLocalApplicationState({ root: options.root, environment }),
          projectLocalRuntimeReadiness(environment),
        ]);
        if (url.pathname === LOCAL_CONSOLE_STATE_PATH) {
          outgoing.statusCode = 200;
          outgoing.setHeader("content-type", "application/json; charset=utf-8");
          outgoing.setHeader("cache-control", "no-store");
          outgoing.setHeader("x-content-type-options", "nosniff");
          outgoing.end(
            JSON.stringify({
              ok: true,
              operation: "runtime.console.state",
              version: LOCAL_CONSOLE_PROTOCOL_VERSION,
              application,
              runtime,
            }),
          );
          return;
        }
        outgoing.statusCode = 200;
        outgoing.setHeader("content-type", "text/html; charset=utf-8");
        outgoing.setHeader("cache-control", "no-store");
        outgoing.setHeader(
          "content-security-policy",
          "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        );
        outgoing.setHeader("x-content-type-options", "nosniff");
        outgoing.end(renderLocalConsolePage({ application, runtime }));
      } catch {
        outgoing.statusCode = 500;
        outgoing.setHeader("content-type", "application/json; charset=utf-8");
        outgoing.end(
          JSON.stringify({
            ok: false,
            error: { code: "LOCAL_CONSOLE_STATE_UNAVAILABLE", message: "Local console state could not be read." },
          }),
        );
      }
    })();
  });
  return server.listen(0, "127.0.0.1");
}

export interface LocalConsoleStartResult {
  readonly server: Server;
  readonly announcement: LocalRuntimeEndpoint;
}

/** Start the console and publish its dynamically allocated endpoint through local Runtime discovery. */
export async function startLocalConsole(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LocalConsoleStartResult> {
  const server = createLocalConsoleHttpServer({ root, environment });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch {
    server.close();
    throw new LocalConsoleError("LOCAL_CONSOLE_LISTEN_FAILED", "Local console could not bind its loopback endpoint.");
  }
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : undefined;
  if (port === undefined) {
    server.close();
    throw new LocalConsoleError("LOCAL_CONSOLE_LISTEN_FAILED", "Local console did not acquire a listening port.");
  }
  const id = `cnsl_${randomBytes(18).toString("base64url")}`;
  let announcement: LocalRuntimeEndpoint;
  try {
    announcement = publishLocalRuntimeEndpoint("console", id, port, environment);
  } catch {
    server.close();
    throw new LocalConsoleError(
      "LOCAL_CONSOLE_DISCOVERY_FAILED",
      "Local console endpoint could not be published safely.",
    );
  }
  server.once("close", () => {
    try {
      clearLocalRuntimeEndpoint(announcement, environment);
    } catch {
      // A shutdown cleanup failure must not change the process close behavior.
    }
  });
  return { server, announcement };
}
