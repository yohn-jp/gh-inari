import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderLocalApplicationSetupFlow,
  type LocalApplicationSetupFlowInput,
} from "./local-application-state-terminal.js";
import type { LocalApplicationSetupStep } from "./local-application-state.js";

function step(
  overrides: Partial<LocalApplicationSetupStep> & Pick<LocalApplicationSetupStep, "id">,
): LocalApplicationSetupStep {
  return {
    status: "waiting",
    title: `Title for ${overrides.id}`,
    detail: "detail",
    syntax: `syntax for ${overrides.id}`,
    ...overrides,
  };
}

test("renderLocalApplicationSetupFlow marks a ready step completed", () => {
  const input: LocalApplicationSetupFlowInput = {
    steps: [step({ id: "cli-topology", status: "ready" })],
    nextAction: { stepId: "start-runtime", commands: [], detail: "detail" },
  };
  const lines = renderLocalApplicationSetupFlow(input);
  assert.equal(lines[0], "✔ Title for cli-topology");
  assert.equal(lines[1], "   syntax for cli-topology");
});

test("renderLocalApplicationSetupFlow marks the canonical next-action step as current", () => {
  const input: LocalApplicationSetupFlowInput = {
    steps: [
      step({ id: "cli-topology", status: "ready" }),
      step({ id: "app-user-authorization", status: "required" }),
      step({ id: "executor-app-id", status: "waiting" }),
    ],
    nextAction: {
      stepId: "app-user-authorization",
      commands: ["inari setup --endpoint <endpoint-url>"],
      detail: "Authorize the App user next.",
    },
  };
  const lines = renderLocalApplicationSetupFlow(input);
  assert.equal(lines[0], "✔ Title for cli-topology");
  assert.equal(lines[1], "│  syntax for cli-topology");
  assert.equal(lines[2], "● Title for app-user-authorization");
  assert.equal(lines[3], "│  syntax for app-user-authorization");
  assert.equal(lines[4], "○ Title for executor-app-id");
  assert.equal(lines[5], "   syntax for executor-app-id");
});

test("renderLocalApplicationSetupFlow marks a blocked step current/blocked and surfaces its diagnostic", () => {
  const input: LocalApplicationSetupFlowInput = {
    steps: [
      step({ id: "runtime-authority-key", status: "blocked", diagnostic: "LOCAL_RUNTIME_AUTHORITY_KEY_INVALID" }),
    ],
    nextAction: {
      stepId: "runtime-authority-key",
      commands: [],
      detail: "Fix the Runtime Authority key.",
    },
  };
  const lines = renderLocalApplicationSetupFlow(input);
  assert.equal(lines[0], "● Title for runtime-authority-key (LOCAL_RUNTIME_AUTHORITY_KEY_INVALID)");
});

test("renderLocalApplicationSetupFlow derives markers only from canonical status and nextAction.stepId, never inventing new ones", () => {
  const input: LocalApplicationSetupFlowInput = {
    steps: [
      step({ id: "cli-topology", status: "ready" }),
      step({ id: "app-user-authorization", status: "ready" }),
      step({ id: "executor-app-id", status: "required" }),
      step({ id: "executor", status: "waiting" }),
      step({ id: "runtime-authority-key", status: "waiting" }),
      step({ id: "runtime-authority-record", status: "waiting" }),
      step({ id: "admission", status: "waiting" }),
    ],
    nextAction: {
      stepId: "executor-app-id",
      commands: ["export INARI_GITHUB_APP_ID='<numeric-app-id-from-inari-setup>'"],
      detail: "Configure the App ID.",
    },
  };
  const lines = renderLocalApplicationSetupFlow(input);
  const markers = lines.filter((_, index) => index % 2 === 0).map((line) => line.split(" ")[0]);
  assert.deepEqual(markers, ["✔", "✔", "●", "○", "○", "○", "○"]);
});
