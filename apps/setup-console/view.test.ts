// Render-structure producer proofs over canonical fixtures; not real-browser certification (#1122).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { SetupState } from "../../src/application/setup/state.js";
import { validateSetupAction } from "../../src/runtime-contracts/setup.js";
import { createSetupApiClient } from "./src/api-client.js";
import { createSetupOperatorContext } from "./src/bootstrap.js";
import { createSetupController, enrollmentKey, type SetupSnapshot } from "./src/controller.js";
import { renderSetupConsole, textContent, type VNode } from "./src/view.js";
import { ACTION_FIXTURES, canonicalState, inProgressState } from "./test-fixtures.js";

const RECEIVING = "build-host-01";

function snapshot(state: SetupState | undefined, patch: Partial<SetupSnapshot> = {}): SetupSnapshot {
  return {
    phase: state ? "ready" : "loading",
    ...(state ? { state } : {}),
    drafts: {},
    acknowledged: {},
    enrollments: {},
    polling: "idle",
    focusRequest: 0,
    ...patch,
  };
}

function all(node: VNode, predicate: (node: VNode) => boolean, out: VNode[] = []): VNode[] {
  if (predicate(node)) out.push(node);
  for (const child of node.children) if (typeof child !== "string") all(child, predicate, out);
  return out;
}

const render = (state: SetupState | undefined, patch: Partial<SetupSnapshot> = {}) =>
  renderSetupConsole({ snapshot: snapshot(state, patch), receivingMachine: RECEIVING });

const INTERACTIVE = new Set(["button", "input", "select", "a", "textarea"]);

function assertAccessible(tree: VNode, label: string): void {
  const ids = all(tree, (node) => node.attrs.id !== undefined).map((node) => node.attrs.id);
  assert.equal(new Set(ids).size, ids.length, `${label}: element IDs are unique`);
  const labels = new Set(all(tree, (node) => node.tag === "label").map((node) => node.attrs.for));
  for (const control of all(tree, (node) => node.tag === "input" || node.tag === "select")) {
    assert.ok(labels.has(control.attrs.id), `${label}: ${control.attrs.id} has a <label for>`);
  }
  for (const button of all(tree, (node) => node.tag === "button")) {
    assert.ok(textContent(button).trim() !== "" || button.attrs["aria-label"], `${label}: button has a name`);
    assert.ok(button.attrs.type === "button" || button.attrs.type === "submit", `${label}: button type is explicit`);
  }
  for (const node of all(tree, () => true)) {
    // Keyboard order is document order: no positive tabindex, no click-only widgets.
    assert.ok(node.attrs.tabindex === undefined || node.attrs.tabindex === "-1", `${label}: no positive tabindex`);
    assert.ok(!Object.keys(node.attrs).some((name) => name.startsWith("on")), `${label}: no inline handlers`);
    if (node.attrs["data-command"] !== undefined) assert.ok(INTERACTIVE.has(node.tag), `${label}: native control`);
    if (node.tag === "a") assert.match(node.attrs.href ?? "", /^#[a-z-]+$/u, `${label}: in-page links only`);
  }
}

test("forms are rendered exactly for the canonical actions, with every declared input", () => {
  const states = [
    ...Object.values(ACTION_FIXTURES).map((statuses) => canonicalState(statuses)),
    inProgressState(),
    canonicalState({ sessionReadiness: "not-ready" }),
    canonicalState(),
    canonicalState({ configuration: "unknown" }),
  ];
  for (const state of states) {
    const tree = render(state);
    const forms = all(tree, (node) => node.tag === "form");
    assert.deepEqual(
      forms.map((form) => form.attrs["data-action-id"]),
      state.actions.map((action) => action.id),
      state.stage,
    );
    for (const action of state.actions) {
      const form = forms.find((item) => item.attrs["data-action-id"] === action.id)!;
      const inputs = all(form, (node) => node.attrs["data-input-id"] !== undefined && node.tag !== "button");
      assert.deepEqual(
        inputs.map((node) => [node.attrs["data-input-id"], node.attrs["data-input-kind"]]),
        action.inputs.map((input) => [input.id, input.kind]),
      );
      assert.equal(all(form, (node) => node.attrs.type === "submit").length, 1);
      const acknowledge = all(form, (node) => node.attrs["data-acknowledge"] === action.id);
      assert.equal(acknowledge.length, action.confirmation.required ? 1 : 0);
      assert.match(
        textContent(form),
        new RegExp(action.confirmation.summary.slice(0, 20).replace(/[.()]/gu, "\\$&"), "u"),
      );
      if (action.command) {
        const copy = all(form, (node) => node.attrs["data-command"] === "copy");
        assert.equal(copy[0]?.attrs["data-copy-text"], [action.command.executable, ...action.command.argv].join(" "));
      }
    }
    assertAccessible(tree, state.stage);
    // Steps mirror the canonical steps; the current one comes from nextAction only.
    const stepLinks = all(
      tree,
      (node) => node.tag === "a" && node.attrs.class !== "skip-link" && node.attrs.href?.startsWith("#step-") === true,
    );
    assert.equal(stepLinks.length, state.steps.length);
    const current = stepLinks.filter((node) => node.attrs["aria-current"] === "step");
    const step = "step" in state.nextAction ? state.nextAction.step : undefined;
    assert.deepEqual(
      current.map((node) => node.attrs.href),
      step ? [`#step-${step}`] : [],
    );
  }
});

test("input kinds render as labelled native controls with drafts preserved", () => {
  const base = canonicalState({ configuration: "unconfigured" });
  const action = validateSetupAction({
    version: 1,
    id: "composition.example:0000000000000000",
    kind: "composition.example",
    owner: "composition",
    title: "Example",
    prerequisites: [],
    inputs: [
      { id: "name", kind: "text", label: "Name", required: true },
      { id: "mode", kind: "choice", label: "Mode", required: false, choices: ["adopt", "prepare"] },
      { id: "agree", kind: "confirmation", label: "Agree", required: true },
      { id: "key", kind: "enrollment", label: "Key", required: true, enrollment: "executor-issuer-private-key" },
    ],
    confirmation: { required: true, summary: "Example summary." },
    freshness: { generation: base.generation, notAfter: "2026-09-24T00:10:00.000Z" },
  });
  const state: SetupState = {
    ...base,
    steps: base.steps.map((step) => (step.dimension === "configuration" ? { ...step, actionId: action.id } : step)),
    actions: [action],
  };
  const tree = render(state, {
    drafts: { [action.id]: { name: "abc", mode: "prepare", agree: true } },
    enrollments: { [enrollmentKey(action.id, "key")]: { bytes: 1700 } },
  });
  const byInput = (id: string) => all(tree, (node) => node.attrs["data-input-id"] === id && node.tag !== "button")[0]!;
  assert.equal(byInput("name").attrs.type, "text");
  assert.equal(byInput("name").attrs.value, "abc");
  assert.equal(byInput("name").attrs.autocomplete, "off");
  assert.equal(byInput("mode").tag, "select");
  assert.deepEqual(
    all(byInput("mode"), (node) => node.tag === "option" && node.attrs.selected !== undefined).map(
      (o) => o.attrs.value,
    ),
    ["prepare"],
  );
  assert.equal(byInput("agree").attrs.type, "checkbox");
  assert.equal(byInput("agree").attrs.checked, "");
  assert.equal(byInput("key").attrs.type, "file");
  assert.equal(byInput("key").attrs.accept, ".pem");
  assert.equal(byInput("key").attrs.value, undefined, "file inputs are recreated empty");
  assert.match(textContent(tree), /A file is selected \(1700 bytes\)/u);
  assert.equal(all(tree, (node) => node.attrs["data-command"] === "cancel-enrollment").length, 1);
  assertAccessible(tree, "all kinds");
});

test("receiving-machine and repository context are explicit; statuses come from server state", () => {
  const tree = render(canonicalState({ repositoryTrust: "pending-human-trust" }));
  const text = textContent(tree);
  assert.equal(all(tree, (node) => node.attrs["data-receiving-machine"] !== undefined).map(textContent)[0], RECEIVING);
  assert.match(text, /not stored in this browser, including when you reach it through an SSH-forwarded port/u);
  assert.match(text, /yohn-jp\/gh-inari \(github\.com\)/u);
  assert.match(text, /External step on GitHub/u);
  assert.match(text, /never approves or merges/u);
  const buttons = all(tree, (node) => node.tag === "button").map(textContent);
  assert.ok(!buttons.some((name) => /approve|merge/iu.test(name)), "no approve/merge control");
  assert.equal(all(tree, (node) => node.attrs.role === "status").length >= 1, true);
  assert.equal(render(undefined).attrs["data-phase"], "loading");
  const unavailable = render(undefined, {
    phase: "unavailable",
    notice: { code: "refresh-failed", severity: "error" },
  });
  assert.equal(all(unavailable, (node) => node.attrs.role === "alert").length, 1);
});

test("working state disables controls, offers upload cancel and renders result diagnostics", () => {
  const state = canonicalState({ configuration: "unconfigured" });
  const action = state.actions[0]!;
  const tree = render(state, {
    phase: "working",
    working: { actionId: action.id, enrollment: true },
    enrollments: { [enrollmentKey(action.id, "issuer-key")]: { bytes: 10 } },
  });
  assert.ok(all(tree, (node) => node.tag === "fieldset").every((node) => node.attrs.disabled === ""));
  const cancel = all(tree, (node) => node.tag === "button" && textContent(node) === "Cancel upload");
  assert.equal(cancel.length, 1);
  assert.equal(cancel[0]!.attrs["data-input-id"], "issuer-key");
  const done = render(state, {
    lastResult: {
      version: 1,
      actionId: action.id,
      generation: state.generation,
      outcome: "action-required",
      diagnostics: [{ code: "SETUP_INPUT_MISSING", message: "Input app-id is required." }],
    },
  });
  const result = all(done, (node) => node.attrs.id === "setup-result")[0]!;
  assert.equal(result.attrs.tabindex, "-1", "result region can receive focus after an action");
  assert.match(textContent(result), /More input is required/u);
  assert.match(textContent(result), /SETUP_INPUT_MISSING/u);
});

test("narrow layout stacks the stepper above the panels in one column", async () => {
  const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
  const narrow = /@media \(max-width: 40rem\) \{([\s\S]*)\}\s*$/u.exec(css)?.[1] ?? "";
  assert.match(narrow, /\.layout \{\s*grid-template-columns: 1fr;/u);
  assert.match(narrow, /button \{[^}]*width: 100%;/u);
  assert.match(css, /:focus-visible \{/u);
  const tree = render(canonicalState({ health: "not-running" }));
  const layout = all(tree, (node) => node.attrs.class === "layout")[0]!;
  assert.deepEqual(
    layout.children.map((child) => (typeof child === "string" ? child : child.tag)),
    ["nav", "div"],
  );
  const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /width=device-width, initial-scale=1/u);
});

test("operator credentials never reach the view, snapshot or serialized context", async () => {
  const bearer = "B".repeat(43);
  const csrf = "C".repeat(43);
  const context = createSetupOperatorContext({
    apiOrigin: "http://127.0.0.1:43123",
    bearer,
    csrf,
    receivingMachine: RECEIVING,
  });
  assert.doesNotMatch(JSON.stringify(context), /BBBB|CCCC/u);
  assert.deepEqual(Object.keys(context).sort(), ["apiOrigin", "authorizationHeaders", "receivingMachine", "toJSON"]);
  const state = canonicalState({ configuration: "unconfigured" });
  const fetchImpl = (async () => new Response(JSON.stringify(state), { status: 200 })) as typeof fetch;
  const controller = createSetupController({
    transport: createSetupApiClient(context, fetchImpl),
    scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
    isHidden: () => false,
  });
  await controller.start();
  const serialized = JSON.stringify(
    renderSetupConsole({ snapshot: controller.snapshot(), receivingMachine: RECEIVING }),
  );
  assert.doesNotMatch(serialized, /BBBB|CCCC/u);
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), /BBBB|CCCC/u);
});
