import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer, RegisteredResource } from "@modelcontextprotocol/server";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Stable MCP Apps resource URI associated with the existing Issue view tool. */
export const INARI_APP_RESOURCE_URI = "ui://inari/issue-view.html" as const;
export const INARI_APP_TOOL_NAME = "inari_issue_view" as const;
export const INARI_APP_RESOURCE_MIME_TYPE = RESOURCE_MIME_TYPE;

/**
 * The fallback keeps the native package usable after TypeScript compilation.
 * The hosted-worker build replaces this value with the checked-in HTML file.
 */
const FALLBACK_INARI_APP_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Inari Issue</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: system-ui, sans-serif;
      }

      body {
        margin: 0;
        padding: 1rem;
      }

      main {
        display: grid;
        gap: 0.75rem;
      }

      pre {
        border: 1px solid CanvasText;
        border-radius: 0.35rem;
        margin: 0;
        max-height: 24rem;
        overflow: auto;
        padding: 0.75rem;
        white-space: pre-wrap;
        word-break: break-word;
      }

      button {
        justify-self: start;
        padding: 0.4rem 0.75rem;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Inari Issue</h1>
      <p id="status" role="status">Waiting for the Issue result…</p>
      <pre id="result">No result yet.</pre>
      <button id="refresh" type="button" disabled>Refresh Issue</button>
    </main>
    <script>
      (() => {
        "use strict";

        const TOOL_NAME = "inari_issue_view";
        const status = document.getElementById("status");
        const result = document.getElementById("result");
        const refresh = document.getElementById("refresh");
        const pending = new Map();
        let nextId = 1;
        let latestArguments = {};

        function show(value) {
          result.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
          status.textContent = "Issue result received.";
        }

        function request(method, params) {
          const id = nextId++;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(new Error("Host request timed out."));
            }, 30000);
            pending.set(id, { resolve, reject, timer });
            window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
          });
        }

        window.addEventListener("message", (event) => {
          if (event.source !== window.parent || event.data?.jsonrpc !== "2.0") return;
          const message = event.data;
          if (message.id === 0 && message.result) {
            window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
            return;
          }
          if (message.id !== undefined && pending.has(message.id)) {
            const entry = pending.get(message.id);
            pending.delete(message.id);
            clearTimeout(entry.timer);
            if (message.error) entry.reject(new Error(message.error.message || "Host request failed."));
            else entry.resolve(message.result);
            return;
          }
          if (message.method === "ui/notifications/tool-input") {
            latestArguments = message.params?.arguments || {};
            refresh.disabled = false;
          }
          if (message.method === "ui/notifications/tool-result") show(message.params);
        });

        refresh.addEventListener("click", async () => {
          refresh.disabled = true;
          status.textContent = "Refreshing Issue…";
          try {
            show(await request("tools/call", { name: TOOL_NAME, arguments: latestArguments }));
          } catch (error) {
            status.textContent = "The host could not refresh the Issue.";
            result.textContent = error instanceof Error ? error.message : "Host request failed.";
          } finally {
            refresh.disabled = false;
          }
        });

        window.parent.postMessage(
          {
            jsonrpc: "2.0",
            id: 0,
            method: "ui/initialize",
            params: {
              appInfo: { name: "Inari Issue App", version: "1" },
              appCapabilities: {},
              protocolVersion: "2026-01-26",
            },
          },
          "*",
        );
      })();
    </script>
  </body>
</html>`;

// build-hosted-worker.mjs defines this symbol with the canonical checked-in
// resource. Source and package consumers use the bounded fallback above.
declare const INARI_APP_HTML_SOURCE: string | undefined;

export const INARI_APP_HTML =
  typeof INARI_APP_HTML_SOURCE === "string" ? INARI_APP_HTML_SOURCE : FALLBACK_INARI_APP_HTML;

/** Link the existing read-only Issue view tool to the App resource. */
export function linkInariAppTool(tool: RegisteredTool): void {
  if (typeof tool?.update !== "function") throw new TypeError("Inari MCP App tool is invalid.");
  tool.update({
    _meta: {
      ...(tool._meta ?? {}),
      ui: { resourceUri: INARI_APP_RESOURCE_URI },
    },
  });
}

/** Register the static HTML resource without introducing a second data path. */
export function registerInariAppResource(server: Pick<McpServer, "registerResource">): RegisteredResource {
  return registerAppResource(
    server,
    "Inari Issue View",
    INARI_APP_RESOURCE_URI,
    {
      description: "Presentation-only view for the existing read-only Inari Issue view tool.",
    },
    async () => ({
      contents: [
        {
          uri: INARI_APP_RESOURCE_URI,
          mimeType: INARI_APP_RESOURCE_MIME_TYPE,
          text: INARI_APP_HTML,
        },
      ],
    }),
  );
}
