/**
 * Browser entry of the local setup wizard (#1119).
 *
 * `startSetupConsole` receives the in-memory bootstrap from the hosting
 * product (#1121) and never reads credentials from storage, cookies, the URL
 * or the DOM. The API origin must be this page's own origin: one dynamically
 * allocated local console origin, directly or through one SSH forward.
 */
import { createSetupApiClient } from "./api-client.js";
import { createSetupOperatorContext, SetupConsoleBootstrapError } from "./bootstrap.js";
import { createSetupController, type SetupController } from "./controller.js";
import { mountSetupConsole } from "./dom.js";

export { SetupConsoleBootstrapError } from "./bootstrap.js";
export type { SetupConsoleBootstrap } from "./bootstrap.js";

export interface SetupConsoleHandle {
  readonly controller: SetupController;
  stop(): void;
}

export function startSetupConsole(
  bootstrap: unknown,
  root: HTMLElement,
  window: Window = globalThis.window,
): SetupConsoleHandle {
  const context = createSetupOperatorContext(bootstrap);
  if (context.apiOrigin !== window.location.origin) {
    throw new SetupConsoleBootstrapError("Bootstrap apiOrigin must be this page's origin.");
  }
  const { document } = window;
  let view: { render(): void; unmount(): void } | undefined;
  const controller = createSetupController({
    transport: createSetupApiClient(context, window.fetch.bind(window)),
    scheduler: {
      setTimeout: (callback, ms) => window.setTimeout(callback, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    },
    isHidden: () => document.visibilityState === "hidden",
    onChange: () => view?.render(),
  });
  view = mountSetupConsole(root, controller, context.receivingMachine, {
    document,
    clipboard: window.navigator.clipboard,
  });
  const onVisibility = () => controller.visibilityChanged(document.visibilityState === "hidden");
  const onFocus = () => controller.focusReturned();
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
  void controller.start();
  return Object.freeze({
    controller,
    stop() {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      controller.dispose();
      view?.unmount();
      view = undefined;
    },
  });
}
