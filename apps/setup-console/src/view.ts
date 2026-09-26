/**
 * Pure, secret-free rendering of the setup wizard (#1119).
 *
 * `renderSetupConsole` turns a controller snapshot into a small element tree.
 * Every control comes from the canonical state: a step shows an action form
 * only when `SetupState.actions` offers that action, and each form renders
 * exactly the action's declared inputs. The tables below are presentation copy
 * only; they never enable, disable or order actions. The view never receives
 * the operator bearer or CSRF value.
 */
import type { SetupState, SetupStepState } from "../../../src/application/setup/state.js";
import type { SetupAction, SetupInputRequirement } from "../../../src/runtime-contracts/setup.js";
import { enrollmentKey, type SetupNoticeCode, type SetupSnapshot } from "./controller.js";

export interface VNode {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly VChild[];
}
export type VChild = VNode | string;

type Attrs = Record<string, string | boolean | undefined>;

export function h(tag: string, attrs: Attrs = {}, ...children: (VChild | false | undefined | null)[]): VNode {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    out[key] = value === true ? "" : value;
  }
  return Object.freeze({
    tag,
    attrs: Object.freeze(out),
    children: Object.freeze(children.filter((child): child is VChild => child !== false && child != null)),
  });
}

export interface SetupConsoleView {
  readonly snapshot: SetupSnapshot;
  /** From the injected bootstrap: the machine that receives setup effects and secrets. */
  readonly receivingMachine: string;
}

const DIMENSION_TITLES: Readonly<Record<string, string>> = Object.freeze({
  configuration: "App and Runtime configuration",
  "provider-binding": "GitHub App installation binding",
  "repository-trust": "Repository trust (Authority)",
  health: "Local Runtime",
  "session-readiness": "Admission and Session readiness",
});

const STEP_STATUS_TEXT: Readonly<Record<string, string>> = Object.freeze({
  complete: "Complete",
  "missing-input": "Input needed",
  ready: "Ready to run",
  "in-progress": "In progress",
  "external-human-wait": "Waiting for a person on GitHub",
  blocked: "Blocked",
  failed: "Previous attempt failed",
  uncertain: "Outcome not yet confirmed",
});

const REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  "repository-mismatch": "The observed repository differs from the repository of this console.",
  "evidence-unknown": "The owning component has not reported this yet.",
  "evidence-stale": "The owner evidence is stale; the state must be refreshed.",
  "journal-invalid": "The setup journal is unavailable.",
  prerequisite: "An earlier step must be complete first.",
  "owner-resolution": "The owning component must resolve this; no action is offered here.",
  "journal-newer": "A recent attempt is newer than the owner evidence; waiting for fresh evidence.",
});

const OUTCOME_TEXT: Readonly<Record<string, string>> = Object.freeze({
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  stale: "Not run: the setup state changed",
  "action-required": "More input is required",
  unknown: "Outcome unknown: the refreshed state is authoritative",
});

const NOTICE_TEXT: Readonly<Record<SetupNoticeCode, string>> = Object.freeze({
  "refresh-failed":
    "The setup state could not be read from the local setup API. Check that the console is still running on the receiving machine.",
  "session-stale":
    "The setup configuration changed since this console session started, so the session no longer accepts actions. Restart the setup console on the receiving machine.",
  "action-not-offered": "That action is no longer offered by the current state. Review the refreshed state.",
  "confirmation-required": "Confirm the action summary before running it.",
  "enrollment-missing": "Choose the required file before running this action.",
  "enrollment-too-large": "The selected file is empty or larger than the enrollment limit; it was not kept.",
  "enrollment-multiple": "Only one file can be enrolled per request.",
  "enrollment-cancelled":
    "The selected file was cleared. If an upload was in progress, the refreshed state shows its outcome.",
  "api-rejected":
    "The local operator context was rejected or has expired. Restart the setup console on the receiving machine.",
  "api-stale":
    "The setup state changed before the action ran, so the owner was not invoked. Review the refreshed state and try again.",
  "api-invalid": "The setup API rejected the request. Review the refreshed state.",
  "api-not-found": "The setup API does not provide that operation.",
  "api-unavailable":
    "The local setup API could not be reached. The outcome of an interrupted action is unknown until the state is refreshed.",
  "api-response-invalid": "The setup API returned an unexpected response. The refreshed state is authoritative.",
});

/** Presentation notes by canonical action kind; they describe, never gate. */
function actionNote(kind: string, receivingMachine: string): string | undefined {
  switch (kind) {
    case "executor.configure":
      return `The private key file is streamed once to the Executor on ${receivingMachine}. This browser does not store it.`;
    case "executor.bind-repository":
      return "GitHub may ask you to approve access. You approve on GitHub; this console cannot approve for you.";
    case "authority.publish-trust":
      return "This opens a pull request. A person must review and merge it on GitHub; this console never approves or merges it.";
    case "authority.recheck-trust":
      return "Recheck after the trust pull request has been reviewed and merged on GitHub.";
    default:
      return undefined;
  }
}

const ENROLLMENT_ACCEPT: Readonly<Record<string, string>> = Object.freeze({
  "executor-issuer-private-key": ".pem",
});

export function dimensionTitle(dimension: string): string {
  return DIMENSION_TITLES[dimension] ?? dimension;
}

/** Stable element ID for an action control, derived from its canonical kind. */
export function controlId(action: SetupAction, suffix: string): string {
  return `${action.kind.replace(/[^a-z0-9-]/gu, "-")}--${suffix.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
}

export function commandText(action: SetupAction): string | undefined {
  if (action.command === undefined) return undefined;
  return [action.command.executable, ...action.command.argv]
    .map((part) => (/^[A-Za-z0-9._/:=@-]+$/u.test(part) ? part : `'${part.replace(/'/gu, `'\\''`)}'`))
    .join(" ");
}

function statusText(snapshot: SetupSnapshot): string {
  const state = snapshot.state;
  if (snapshot.phase === "loading") return "Reading the setup state…";
  if (snapshot.working !== undefined) {
    const title = state?.actions.find((action) => action.id === snapshot.working?.actionId)?.title;
    return `Running: ${title ?? "setup action"}…`;
  }
  if (snapshot.phase === "unavailable" || state === undefined) return "The setup state is unavailable.";
  const next = state.nextAction;
  switch (next.kind) {
    case "perform": {
      const title = state.actions.find((action) => action.id === next.actionId)?.title;
      return `Next: ${title ?? dimensionTitle(next.step)}.`;
    }
    case "wait":
      return next.reason === "human-trust"
        ? "Waiting for a person to review and merge the trust pull request on GitHub."
        : `An operation is in progress for ${dimensionTitle(next.step)}.`;
    case "refresh":
      return `Waiting for fresh owner evidence${next.step ? ` for ${dimensionTitle(next.step)}` : ""}.`;
    case "blocked":
      return `Blocked at ${dimensionTitle(next.step)}: ${REASON_TEXT[next.reason] ?? next.reason}`;
    case "complete":
      return "The server reports setup complete for this repository.";
  }
}

function pollingText(snapshot: SetupSnapshot): string {
  if (snapshot.polling === "active") return "Refreshing automatically while the operation is waiting.";
  if (snapshot.polling === "paused") return "Automatic refresh paused. Use Refresh state to check again.";
  return "";
}

function diagnosticsList(items: readonly { code: string; message: string }[], label: string): VNode | undefined {
  if (items.length === 0) return undefined;
  return h(
    "ul",
    { class: "diagnostics", "aria-label": label },
    ...items.map((item) => h("li", {}, h("code", {}, item.code), " ", item.message)),
  );
}

function inputControl(action: SetupAction, input: SetupInputRequirement, view: SetupConsoleView): VNode {
  const id = controlId(action, input.id);
  const draft = view.snapshot.drafts[action.id]?.[input.id];
  const common = {
    id,
    name: input.id,
    "data-action-id": action.id,
    "data-input-id": input.id,
    "data-input-kind": input.kind,
    required: input.required,
    "aria-required": input.required ? "true" : undefined,
  };
  const label = `${input.label}${input.required ? "" : " (optional)"}`;
  switch (input.kind) {
    case "text":
      return h(
        "div",
        { class: "field" },
        h("label", { for: id }, label),
        h("input", {
          ...common,
          type: "text",
          autocomplete: "off",
          spellcheck: "false",
          maxlength: "480",
          value: typeof draft === "string" ? draft : undefined,
        }),
      );
    case "choice":
      return h(
        "div",
        { class: "field" },
        h("label", { for: id }, label),
        h(
          "select",
          common,
          h("option", { value: "", selected: draft === undefined || draft === "" }, "Choose…"),
          ...(input.choices ?? []).map((choice) => h("option", { value: choice, selected: draft === choice }, choice)),
        ),
      );
    case "confirmation":
      return h(
        "div",
        { class: "field field-check" },
        h("input", { ...common, type: "checkbox", checked: draft === true }),
        h("label", { for: id }, label),
      );
    case "enrollment": {
      const selected = view.snapshot.enrollments[enrollmentKey(action.id, input.id)];
      const noteId = `${id}-note`;
      return h(
        "div",
        { class: "field field-file" },
        h("label", { for: id }, label),
        h("input", {
          ...common,
          type: "file",
          accept: input.enrollment ? ENROLLMENT_ACCEPT[input.enrollment] : undefined,
          "aria-describedby": noteId,
        }),
        h(
          "p",
          { id: noteId, class: "hint" },
          selected
            ? `A file is selected (${selected.bytes} bytes). It is streamed once to ${view.receivingMachine} and then cleared.`
            : `The file is read only when you run the action, streamed once to ${view.receivingMachine}, and never stored in this browser.`,
        ),
        selected &&
          h(
            "button",
            {
              type: "button",
              class: "secondary",
              "data-command": "cancel-enrollment",
              "data-action-id": action.id,
              "data-input-id": input.id,
            },
            "Clear selected file",
          ),
      );
    }
  }
}

function copyControl(text: string, label: string): VNode {
  return h(
    "button",
    { type: "button", class: "secondary copy", "data-command": "copy", "data-copy-text": text, "aria-label": label },
    "Copy",
  );
}

function actionForm(action: SetupAction, view: SetupConsoleView): VNode {
  const working = view.snapshot.working;
  const busy = working !== undefined;
  const note = actionNote(action.kind, view.receivingMachine);
  const command = commandText(action);
  const confirmId = controlId(action, "confirm");
  const summaryId = controlId(action, "summary");
  return h(
    "form",
    {
      class: "action",
      id: controlId(action, "form"),
      "data-action-id": action.id,
      "aria-busy": busy ? "true" : "false",
      // Requiredness is enforced by the controller and the Setup Application. A
      // re-render empties the native file input while the selected file stays
      // in memory, so native validation would block a valid submission.
      novalidate: true,
    },
    h(
      "fieldset",
      { disabled: busy },
      h("legend", {}, action.title),
      h("p", { class: "owner" }, `Performed by: ${action.owner}`),
      note && h("p", { class: "hint", role: "note" }, note),
      ...action.inputs.map((input) => inputControl(action, input, view)),
      command &&
        h(
          "div",
          { class: "command" },
          h("code", { id: controlId(action, "command") }, command),
          copyControl(command, `Copy command: ${command}`),
        ),
      h("p", { class: "summary", id: summaryId }, action.confirmation.summary),
      action.confirmation.required &&
        h(
          "div",
          { class: "field field-check" },
          h("input", {
            type: "checkbox",
            id: confirmId,
            "data-acknowledge": action.id,
            "aria-describedby": summaryId,
            checked: view.snapshot.acknowledged[action.id] === true,
          }),
          h("label", { for: confirmId }, "I have read the summary and want to run this action"),
        ),
      h("button", { type: "submit", class: "primary" }, `Run: ${action.title}`),
    ),
    working?.actionId === action.id &&
      working.enrollment &&
      h(
        "button",
        {
          type: "button",
          class: "secondary",
          "data-command": "cancel-enrollment",
          "data-action-id": action.id,
          "data-input-id": action.inputs.find((input) => input.kind === "enrollment")?.id ?? "",
        },
        "Cancel upload",
      ),
  );
}

function externalWait(step: SetupStepState): VNode | undefined {
  if (step.status !== "external-human-wait") return undefined;
  return h(
    "div",
    { class: "external", role: "note" },
    h("h3", {}, "External step on GitHub"),
    h(
      "p",
      {},
      "A person must review and merge the trust pull request on GitHub. This console never approves or merges it and does not treat the step as done until a refreshed observation reports trust.",
    ),
  );
}

function stepPanel(step: SetupStepState, state: SetupState, view: SetupConsoleView, current: boolean): VNode {
  const titleId = `step-${step.dimension}-title`;
  const dimension = state.dimensions.find((item) => item.dimension === step.dimension);
  const action = step.actionId === undefined ? undefined : state.actions.find((item) => item.id === step.actionId);
  return h(
    "section",
    {
      class: "panel",
      id: `step-${step.dimension}`,
      "aria-labelledby": titleId,
      "data-step": step.dimension,
      "data-current": current ? "true" : undefined,
    },
    h("h2", { id: titleId }, dimensionTitle(step.dimension)),
    h(
      "p",
      { class: "step-status", "data-status": step.status },
      `Status: ${STEP_STATUS_TEXT[step.status] ?? step.status}`,
      step.reason ? ` — ${REASON_TEXT[step.reason] ?? step.reason}` : "",
    ),
    dimension &&
      h(
        "p",
        { class: "observation" },
        `Owner observation: ${dimension.status} (${dimension.freshness})`,
        dimension.observedAt ? `, observed ${dimension.observedAt}` : "",
      ),
    step.status === "in-progress" &&
      h("p", { class: "hint" }, "An operation is running. This page refreshes while it is in progress."),
    externalWait(step),
    diagnosticsList(step.diagnostics, `${dimensionTitle(step.dimension)} diagnostics`),
    action && actionForm(action, view),
  );
}

function resultSection(snapshot: SetupSnapshot, state: SetupState | undefined): VNode | undefined {
  const result = snapshot.lastResult;
  if (result === undefined) return undefined;
  const title = state?.actions.find((action) => action.id === result.actionId)?.title ?? result.actionId;
  return h(
    "section",
    { id: "setup-result", class: "result", "aria-labelledby": "setup-result-title", tabindex: "-1" },
    h("h2", { id: "setup-result-title" }, "Last action result"),
    h("p", { "data-outcome": result.outcome }, `${title}: ${OUTCOME_TEXT[result.outcome] ?? result.outcome}`),
    diagnosticsList(result.diagnostics, "Result diagnostics"),
  );
}

export function renderSetupConsole(view: SetupConsoleView): VNode {
  const { snapshot } = view;
  const state = snapshot.state;
  const currentStep =
    state && "step" in state.nextAction && state.nextAction.step !== undefined ? state.nextAction.step : undefined;
  const repository = state?.repository;
  return h(
    "div",
    { class: "setup-console", "data-phase": snapshot.phase },
    h(
      "a",
      { class: "skip-link", href: currentStep ? `#step-${currentStep}` : "#setup-status" },
      "Skip to the current step",
    ),
    h(
      "header",
      { class: "context" },
      h("h1", {}, "Inari local setup"),
      h(
        "dl",
        { class: "context-list" },
        h(
          "div",
          {},
          h("dt", {}, "Receiving machine"),
          h("dd", { "data-receiving-machine": "" }, view.receivingMachine),
        ),
        repository &&
          h(
            "div",
            {},
            h("dt", {}, "Repository"),
            h(
              "dd",
              {},
              `${repository.nameWithOwner} (${repository.repositoryHost})`,
              " ",
              copyControl(repository.nameWithOwner, `Copy repository name ${repository.nameWithOwner}`),
            ),
          ),
        state && h("div", {}, h("dt", {}, "Setup stage"), h("dd", { "data-stage": state.stage }, state.stage)),
        state && h("div", {}, h("dt", {}, "Observed"), h("dd", {}, state.observedAt)),
      ),
      h(
        "p",
        { class: "context-note" },
        `This page controls the local Runtime on ${view.receivingMachine}. Files you enroll are streamed to that machine and are not stored in this browser, including when you reach it through an SSH-forwarded port.`,
      ),
    ),
    h(
      "div",
      { class: "toolbar" },
      h(
        "button",
        { type: "button", class: "secondary", "data-command": "refresh", disabled: snapshot.working !== undefined },
        "Refresh state",
      ),
      h("span", { class: "polling", "data-polling": snapshot.polling }, pollingText(snapshot)),
    ),
    h(
      "p",
      { id: "setup-status", class: "status", role: "status", "aria-live": "polite", tabindex: "-1" },
      statusText(snapshot),
    ),
    snapshot.notice &&
      h(
        "p",
        {
          class: `notice notice-${snapshot.notice.severity}`,
          role: snapshot.notice.severity === "error" ? "alert" : "status",
          "data-notice": snapshot.notice.code,
        },
        NOTICE_TEXT[snapshot.notice.code],
      ),
    resultSection(snapshot, state),
    state && diagnosticsList(state.diagnostics, "Setup diagnostics"),
    state &&
      h(
        "div",
        { class: "layout" },
        h(
          "nav",
          { class: "stepper", "aria-label": "Setup steps" },
          h(
            "ol",
            {},
            ...state.steps.map((step) =>
              h(
                "li",
                { "data-status": step.status },
                h(
                  "a",
                  {
                    href: `#step-${step.dimension}`,
                    "aria-current": step.dimension === currentStep ? "step" : undefined,
                  },
                  h("span", { class: "step-title" }, dimensionTitle(step.dimension)),
                  h("span", { class: "badge" }, STEP_STATUS_TEXT[step.status] ?? step.status),
                ),
              ),
            ),
          ),
        ),
        h(
          "div",
          { class: "panels" },
          ...state.steps.map((step) => stepPanel(step, state, view, step.dimension === currentStep)),
        ),
      ),
  );
}

/** Reads a VNode tree's text for tests and accessible-name checks. */
export function textContent(node: VChild): string {
  return typeof node === "string" ? node : node.children.map(textContent).join("");
}
