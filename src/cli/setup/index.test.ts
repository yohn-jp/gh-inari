import assert from "node:assert/strict";
import { test } from "node:test";
import { renderShellCommand, renderSetupHelp, renderSetupState, runSetupAction } from "./index.js";
import type { SetupApplication, SetupState } from "../../application/setup/index.js";

const repository = { repositoryHost: "github.com", repositoryId: "123", nameWithOwner: "o/r" };
const generation = { repository, configuration: "v1" };
const action = {
  version: 1 as const,
  id: "executor.configure:abc",
  kind: "executor.configure",
  owner: "executor" as const,
  title: "Configure Executor",
  prerequisites: [],
  inputs: [{ id: "app-id", kind: "text" as const, label: "Issuer App ID", required: true }],
  confirmation: { required: true, summary: "Store issuer config." },
  freshness: { generation, notAfter: "2026-09-26T00:00:00Z" },
  command: { executable: "inari", argv: ["setup", "--name", "has space"] },
};
const state = {
  version: 1,
  contractVersion: 1,
  repository,
  generation,
  observedAt: "2026-09-26T00:00:00Z",
  evaluatedAt: "2026-09-26T00:00:00Z",
  stage: "clean",
  dimensions: [{ dimension: "configuration", status: "unconfigured", freshness: "fresh", diagnostics: [] }],
  steps: [
    { dimension: "configuration", status: "missing-input", diagnostics: [] },
    { dimension: "health", status: "complete", diagnostics: [] },
  ],
  actions: [action],
  nextAction: { kind: "perform", step: "configuration", actionId: action.id, reconcile: false },
  diagnostics: [],
} as SetupState;

test("argv quotes each argument and preserves shell metacharacters in multiline output", () => {
  assert.equal(
    renderShellCommand({ executable: "inari", argv: ["setup", "a b", "x'$(oops);y"] }, true),
    "inari \\\n  setup \\\n  'a b' \\\n  'x'\\''$(oops);y'",
  );
});

test("compact state gives one next action and input prose; detail reports observed states", () => {
  const compact = renderSetupState(state);
  assert.match(compact, /Next: Configure Executor/);
  assert.match(compact, /Input required: Issuer App ID/);
  assert.doesNotMatch(compact, /has space|Steps:|<app-id>/);
  assert.match(renderSetupState(state, true), /configuration: missing-input/);
  assert.match(renderSetupHelp(state), /Issuer App ID: text \(required\)/);
});

test("non-TTY and JSON do not prompt; explicit input and confirmation dispatch exactly once", async () => {
  let calls = 0;
  let prompts = 0;
  const application: SetupApplication = {
    state: async () => state,
    perform: async (_repository, request) => {
      calls++;
      assert.deepEqual(request, {
        version: 1,
        actionId: action.id,
        generation,
        confirmed: true,
        inputs: { "app-id": "123" },
      });
      return { version: 1, actionId: action.id, generation, outcome: "succeeded", diagnostics: [] };
    },
  };
  const io = {
    isTTY: false,
    prompt: async () => {
      prompts++;
      return "123";
    },
    confirm: async () => {
      prompts++;
      return true;
    },
  };
  assert.equal((await runSetupAction(application, repository, { execute: true, io })).kind, "input-required");
  assert.equal(
    (await runSetupAction(application, repository, { execute: true, json: true, io })).kind,
    "input-required",
  );
  assert.equal(calls, 0);
  assert.equal(prompts, 0);
  const result = await runSetupAction(application, repository, {
    execute: true,
    json: true,
    inputs: { "app-id": "123" },
    confirmed: true,
  });
  assert.equal(result.kind, "result");
  assert.equal(calls, 1);
  assert.match(result.output, /"outcome":"succeeded"/);
});

test("TTY cancellation never dispatches", async () => {
  let calls = 0;
  const application: SetupApplication = {
    state: async () => state,
    perform: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };
  const result = await runSetupAction(application, repository, {
    execute: true,
    io: { isTTY: true, prompt: async () => undefined, confirm: async () => true },
  });
  assert.equal(result.kind, "cancelled");
  assert.equal(calls, 0);
});

test("TTY gathers declared input and explicit confirmation", async () => {
  let dispatched = 0;
  const application: SetupApplication = {
    state: async () => state,
    perform: async (_repository, request) => {
      dispatched++;
      assert.deepEqual((request as { inputs: unknown }).inputs, { "app-id": "123" });
      return { version: 1, actionId: action.id, generation, outcome: "succeeded", diagnostics: [] };
    },
  };
  const result = await runSetupAction(application, repository, {
    execute: true,
    io: { isTTY: true, prompt: async () => "123", confirm: async () => true },
  });
  assert.equal(result.kind, "result");
  assert.equal(dispatched, 1);
});
