/**
 * Thin DOM adapter for the setup wizard: mounts the pure view with
 * `createElement`/`textContent` only (never HTML parsing) and forwards native
 * keyboard/mouse events to the controller through delegated listeners.
 * Focus and caret position survive re-renders by element ID; file inputs are
 * recreated empty on every render, so no browser file reference outlives the
 * controller's in-memory selection.
 */
import type { SetupController } from "./controller.js";
import { renderSetupConsole, type VChild } from "./view.js";

export interface SetupConsoleDomEnvironment {
  readonly document: Document;
  readonly clipboard?: Pick<Clipboard, "writeText">;
}

function build(document: Document, node: VChild): Node {
  if (typeof node === "string") return document.createTextNode(node);
  const element = document.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs)) element.setAttribute(name, value);
  for (const child of node.children) element.appendChild(build(document, child));
  return element;
}

export function mountSetupConsole(
  root: HTMLElement,
  controller: SetupController,
  receivingMachine: string,
  environment: SetupConsoleDomEnvironment,
): { readonly render: () => void; readonly unmount: () => void } {
  const { document } = environment;
  let focusRequest = controller.snapshot().focusRequest;

  function render(): void {
    const snapshot = controller.snapshot();
    const active = document.activeElement as HTMLInputElement | null;
    const activeId = active && root.contains(active) ? active.id : "";
    const caret =
      active && typeof active.selectionStart === "number" && active.type === "text"
        ? [active.selectionStart, active.selectionEnd ?? active.selectionStart]
        : undefined;
    root.replaceChildren(build(document, renderSetupConsole({ snapshot, receivingMachine })));
    if (snapshot.focusRequest !== focusRequest) {
      focusRequest = snapshot.focusRequest;
      (document.getElementById("setup-result") ?? document.getElementById("setup-status"))?.focus();
      return;
    }
    if (activeId !== "") {
      const next = document.getElementById(activeId) as HTMLInputElement | null;
      if (next && !next.disabled) {
        next.focus();
        if (caret) next.setSelectionRange(caret[0]!, caret[1]!);
      }
    }
  }

  function target(event: Event): HTMLElement | null {
    return event.target instanceof Element ? (event.target as HTMLElement) : null;
  }

  const onSubmit = (event: Event) => {
    const form = target(event);
    if (form?.tagName !== "FORM") return;
    event.preventDefault();
    const actionId = form.dataset.actionId;
    if (actionId) void controller.submit(actionId);
  };
  const onInput = (event: Event) => {
    const element = target(event) as HTMLInputElement | HTMLSelectElement | null;
    if (!element) return;
    const { actionId, inputId, inputKind } = element.dataset;
    const acknowledge = element.dataset.acknowledge;
    if (acknowledge !== undefined && element instanceof HTMLInputElement) {
      controller.setAcknowledged(acknowledge, element.checked);
    } else if (actionId && inputId && inputKind === "enrollment" && element instanceof HTMLInputElement) {
      if (event.type !== "change") return;
      controller.selectEnrollment(actionId, inputId, element.files?.[0]);
    } else if (actionId && inputId && inputKind === "confirmation" && element instanceof HTMLInputElement) {
      controller.setDraft(actionId, inputId, element.checked);
    } else if (actionId && inputId && (inputKind === "text" || inputKind === "choice")) {
      controller.setDraft(actionId, inputId, element.value);
    }
  };
  const onClick = (event: Event) => {
    const button = target(event)?.closest<HTMLElement>("[data-command]");
    if (!button || !root.contains(button)) return;
    const { command, actionId, inputId, copyText } = button.dataset;
    if (command === "refresh") void controller.refresh();
    else if (command === "cancel-enrollment" && actionId && inputId) controller.cancelEnrollment(actionId, inputId);
    else if (command === "copy" && copyText) void environment.clipboard?.writeText(copyText).catch(() => undefined);
  };

  root.addEventListener("submit", onSubmit);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onInput);
  root.addEventListener("click", onClick);
  render();
  return Object.freeze({
    render,
    unmount() {
      root.removeEventListener("submit", onSubmit);
      root.removeEventListener("input", onInput);
      root.removeEventListener("change", onInput);
      root.removeEventListener("click", onClick);
      root.replaceChildren();
    },
  });
}
