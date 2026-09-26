/**
 * Packaged page entry of the local setup wizard (#1121).
 *
 * The static page carries no credential. This entry asks its own origin's
 * setup host for the operator bootstrap with a same-origin script request
 * (the custom header forces a CORS preflight that the host never grants
 * cross-site), hands it to `startSetupConsole` and drops the reference. The
 * bearer and CSRF values therefore live only in the controller's closure:
 * never in storage, cookies, the URL or the DOM. When the host reports the
 * session stale (configuration generation changed) or expired, a fresh
 * bootstrap is obtained in memory; repeated failures stop and say so.
 */
import { startSetupConsole, type SetupConsoleHandle } from "./browser.js";

export const SETUP_BOOTSTRAP_PATH = "/api/setup/bootstrap";
export const SETUP_BOOTSTRAP_HEADER = "x-inari-setup-bootstrap";
const MAX_CONSECUTIVE_BOOTSTRAPS = 3;

async function fetchBootstrap(window: Window): Promise<unknown> {
  const response = await window.fetch(SETUP_BOOTSTRAP_PATH, {
    method: "POST",
    headers: { [SETUP_BOOTSTRAP_HEADER]: "1" },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    mode: "same-origin",
  });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Setup host bootstrap was refused.");
  }
  return (await response.json()) as unknown;
}

function unavailable(root: HTMLElement, window: Window): void {
  const status = window.document.createElement("p");
  status.id = "setup-status";
  status.setAttribute("role", "status");
  status.textContent =
    "The local setup host is unavailable or refused this page. Restart `inari setup console` and reload.";
  root.replaceChildren(status);
}

export function bootSetupConsole(root: HTMLElement, window: Window = globalThis.window): void {
  let handle: SetupConsoleHandle | undefined;
  let attempts = 0;
  const boot = async (): Promise<void> => {
    handle?.stop();
    handle = undefined;
    if (attempts >= MAX_CONSECUTIVE_BOOTSTRAPS) return unavailable(root, window);
    attempts += 1;
    let bootstrap: unknown;
    try {
      bootstrap = await fetchBootstrap(window);
    } catch {
      return unavailable(root, window);
    }
    try {
      handle = startSetupConsole(bootstrap, root, window, { onSessionEnded: () => void boot() });
    } catch {
      return unavailable(root, window);
    }
    bootstrap = undefined;
    // A session that reaches a usable state resets the consecutive-bootstrap budget.
    const started = handle;
    let checks = 0;
    const settle = (): void => {
      if (handle !== started) return;
      if (started.controller.snapshot().phase === "ready") attempts = 0;
      else if ((checks += 1) < 40) window.setTimeout(settle, 250);
    };
    settle();
  };
  void boot();
}

const root = globalThis.document?.getElementById("setup-console");
if (root !== null && root !== undefined) bootSetupConsole(root);
