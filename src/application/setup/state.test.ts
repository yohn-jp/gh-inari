import assert from "node:assert/strict";
import test from "node:test";
import { findSetupSecretMaterial } from "../../runtime-contracts/index.js";
import { SETUP_STAGES, projectSetupState, setupOperationId, type SetupState } from "./state.js";

const repository = { repositoryHost: "github.com", repositoryId: "1330755860", nameWithOwner: "yohn-jp/gh-inari" };
const generation = { repository, configuration: "gen-1" };
const NOW = new Date("2026-09-24T00:05:00.000Z");
const OBSERVED = "2026-09-24T00:04:00.000Z";

type Statuses = {
  configuration: string;
  health: string;
  providerBinding: string;
  repositoryTrust: string;
  sessionReadiness: string;
};

const DIMENSION = {
  configuration: "configuration",
  health: "health",
  providerBinding: "provider-binding",
  repositoryTrust: "repository-trust",
  sessionReadiness: "session-readiness",
} as const;

const OWNER = {
  configuration: "composition",
  health: "composition",
  providerBinding: "executor",
  repositoryTrust: "authority",
  sessionReadiness: "admission",
} as const;

function observation(statuses: Partial<Statuses> = {}, observedAt = OBSERVED, evidenceGeneration = "gen-1") {
  const all: Statuses = {
    configuration: "configured",
    health: "healthy",
    providerBinding: "bound",
    repositoryTrust: "trusted",
    sessionReadiness: "ready",
    ...statuses,
  };
  const result: Record<string, unknown> = { version: 1, generation, observedAt };
  for (const member of Object.keys(DIMENSION) as (keyof Statuses)[]) {
    const status = all[member];
    result[member] = {
      dimension: DIMENSION[member],
      status,
      ...(status === "unknown"
        ? {}
        : { evidence: { owner: OWNER[member], observedAt, generation: evidenceGeneration } }),
      diagnostics: [],
    };
  }
  return result;
}

function project(input: { observation: unknown; journal?: readonly unknown[] | undefined; now?: Date }): SetupState {
  return projectSetupState({
    repository,
    observation: input.observation,
    journal: "journal" in input ? input.journal : [],
    now: input.now ?? NOW,
  });
}

function entry(actionId: string, phase: string, recordedAt: string, outcome?: string) {
  return {
    version: 1,
    actionId,
    owner: "authority",
    generation,
    phase,
    ...(outcome === undefined ? {} : { outcome }),
    recordedAt,
    diagnostics: [],
  };
}

const PUBLISH = setupOperationId("authority.publish-trust", generation);

test("clean, partial, configured, pending-human-trust, trusted, healthy and task-ready are distinct stages", () => {
  const cases: [Partial<Statuses>, string][] = [
    [{ configuration: "unconfigured", providerBinding: "unbound", repositoryTrust: "untrusted" }, "clean"],
    [{ configuration: "partial" }, "partial"],
    [{ providerBinding: "unbound" }, "partial"],
    [{ repositoryTrust: "untrusted", health: "not-running", sessionReadiness: "not-ready" }, "configured"],
    [{ repositoryTrust: "pending-human-trust" }, "pending-human-trust"],
    [{ health: "not-running" }, "trusted"],
    [{ sessionReadiness: "not-ready" }, "healthy"],
    [{}, "task-ready"],
    [{ configuration: "unknown" }, "unknown"],
  ];
  const seen = new Set<string>();
  for (const [statuses, stage] of cases) {
    const state = project({ observation: observation(statuses) });
    assert.equal(state.stage, stage, JSON.stringify(statuses));
    seen.add(state.stage);
  }
  assert.deepEqual([...seen].sort(), [...SETUP_STAGES].sort());
  const ready = project({ observation: observation() });
  assert.deepEqual(ready.nextAction, { kind: "complete" });
  assert.equal(ready.actions.length, 0);
});

test("one next action depends on required inputs and fresh owner evidence", () => {
  const clean = project({ observation: observation({ configuration: "unconfigured", providerBinding: "unbound" }) });
  assert.equal(clean.nextAction.kind, "perform");
  const configure = clean.actions.find((action) => action.kind === "executor.configure");
  assert.ok(configure);
  assert.deepEqual(clean.nextAction, {
    kind: "perform",
    step: "configuration",
    actionId: configure.id,
    reconcile: false,
  });
  assert.equal(clean.steps[0]?.status, "missing-input");
  assert.deepEqual(
    configure.inputs.map((input) => [input.id, input.kind, input.required]),
    [
      ["app-id", "text", true],
      ["issuer-key", "enrollment", true],
    ],
  );
  assert.equal(configure.confirmation.required, true);
  assert.deepEqual(configure.freshness.generation, generation);
  // Binding waits for configuration instead of being offered early.
  assert.equal(
    clean.actions.some((action) => action.kind === "executor.bind-repository"),
    false,
  );

  const untrusted = project({ observation: observation({ repositoryTrust: "untrusted" }) });
  assert.deepEqual(untrusted.nextAction, {
    kind: "perform",
    step: "repository-trust",
    actionId: PUBLISH,
    reconcile: false,
  });
  assert.equal(untrusted.steps.find((step) => step.dimension === "repository-trust")?.status, "ready");

  const stale = project({
    observation: observation({ repositoryTrust: "untrusted" }, "2026-09-23T00:00:00.000Z"),
  });
  assert.equal(stale.stage, "unknown");
  assert.equal(stale.actions.length, 0);
  assert.deepEqual(stale.nextAction, { kind: "refresh", step: "configuration", reason: "evidence-stale" });

  const otherGeneration = project({ observation: observation({ repositoryTrust: "untrusted" }, OBSERVED, "gen-0") });
  assert.equal(otherGeneration.actions.length, 0);
  assert.equal(otherGeneration.dimensions[0]?.freshness, "stale");

  const unknownBinding = project({
    observation: observation({ providerBinding: "unknown", repositoryTrust: "untrusted" }),
  });
  assert.equal(unknownBinding.stage, "unknown");
  assert.equal(
    unknownBinding.actions.some((action) => action.kind === "authority.publish-trust"),
    false,
  );
  assert.deepEqual(unknownBinding.nextAction, {
    kind: "refresh",
    step: "provider-binding",
    reason: "evidence-unknown",
  });
});

test("a wrong repository observation offers no action", () => {
  const foreign = observation({ repositoryTrust: "untrusted" });
  foreign.generation = { repository: { ...repository, repositoryId: "42" }, configuration: "gen-1" };
  const state = project({ observation: foreign });
  assert.equal(state.stage, "unknown");
  assert.equal(state.actions.length, 0);
  assert.deepEqual(state.nextAction, { kind: "refresh", step: "configuration", reason: "repository-mismatch" });
  assert.equal(state.diagnostics[0]?.code, "SETUP_REPOSITORY_MISMATCH");
});

test("trust publication is not trust approval and health is not Session readiness", () => {
  const pending = project({ observation: observation({ repositoryTrust: "pending-human-trust" }) });
  assert.deepEqual(
    pending.actions.map((action) => action.kind),
    ["authority.recheck-trust"],
  );
  assert.equal(pending.actions[0]?.confirmation.required, false);
  assert.equal(pending.steps.find((step) => step.dimension === "repository-trust")?.status, "external-human-wait");
  assert.equal(pending.nextAction.kind, "wait");
  assert.equal(pending.nextAction.kind === "wait" && pending.nextAction.reason, "human-trust");

  // A successful publication journal entry does not make the repository trusted.
  const published = project({
    observation: observation({ repositoryTrust: "untrusted" }, "2026-09-24T00:04:30.000Z"),
    journal: [
      entry(PUBLISH, "requested", "2026-09-24T00:02:00.000Z"),
      entry(PUBLISH, "confirmed", "2026-09-24T00:02:00.000Z"),
      entry(PUBLISH, "completed", "2026-09-24T00:02:01.000Z", "succeeded"),
    ],
  });
  assert.equal(published.stage, "configured");

  // Session readiness reported by Admission never becomes task-ready without trust.
  const untrustedReady = project({ observation: observation({ repositoryTrust: "untrusted" }) });
  assert.equal(untrustedReady.stage, "configured");
  // Healthy but not Session-ready stays healthy and is left to the owner.
  const notReady = project({ observation: observation({ sessionReadiness: "not-ready" }) });
  assert.deepEqual(notReady.nextAction, { kind: "blocked", step: "session-readiness", reason: "owner-resolution" });
  assert.equal(notReady.actions.length, 0);
});

test("a mismatched provider binding is never replaced automatically", () => {
  const state = project({ observation: observation({ providerBinding: "mismatched" }) });
  assert.equal(state.stage, "partial");
  assert.equal(
    state.actions.some((action) => action.kind === "executor.bind-repository"),
    false,
  );
  assert.deepEqual(state.nextAction, { kind: "blocked", step: "provider-binding", reason: "owner-resolution" });
});

test("journal attempts keep recovery state truthful", () => {
  const untrusted = { repositoryTrust: "untrusted" };
  const inFlight = project({
    observation: observation(untrusted),
    journal: [entry(PUBLISH, "requested", "2026-09-24T00:03:00.000Z")],
  });
  assert.equal(inFlight.steps.find((step) => step.dimension === "repository-trust")?.status, "in-progress");
  assert.equal(
    inFlight.actions.some((action) => action.id === PUBLISH),
    false,
  );
  assert.deepEqual(inFlight.nextAction, {
    kind: "wait",
    step: "repository-trust",
    reason: "in-progress",
    actionId: PUBLISH,
  });

  // An expired unfinished attempt with evidence observed afterwards is reconciled, not replayed under a new identity.
  const expired = project({
    observation: observation(untrusted, "2026-09-24T00:30:00.000Z"),
    journal: [entry(PUBLISH, "confirmed", "2026-09-24T00:03:00.000Z")],
    now: new Date("2026-09-24T00:30:30.000Z"),
  });
  assert.deepEqual(expired.nextAction, {
    kind: "perform",
    step: "repository-trust",
    actionId: PUBLISH,
    reconcile: true,
  });
  assert.equal(expired.steps.find((step) => step.dimension === "repository-trust")?.status, "uncertain");

  const unknownOutcome = [
    entry(PUBLISH, "requested", "2026-09-24T00:04:30.000Z"),
    entry(PUBLISH, "confirmed", "2026-09-24T00:04:30.000Z"),
    entry(PUBLISH, "completed", "2026-09-24T00:04:31.000Z", "unknown"),
  ];
  const beforeEvidence = project({ observation: observation(untrusted), journal: unknownOutcome });
  assert.deepEqual(beforeEvidence.nextAction, { kind: "refresh", step: "repository-trust", reason: "journal-newer" });
  assert.equal(beforeEvidence.actions.length, 0);
  const afterEvidence = project({
    observation: observation(untrusted, "2026-09-24T00:04:45.000Z"),
    journal: unknownOutcome,
  });
  assert.deepEqual(afterEvidence.nextAction, {
    kind: "perform",
    step: "repository-trust",
    actionId: PUBLISH,
    reconcile: true,
  });
  assert.equal(
    afterEvidence.steps.find((step) => step.dimension === "repository-trust")?.diagnostics.at(-1)?.code,
    "SETUP_EFFECT_UNCONFIRMED",
  );

  // Cancellation before confirmation had no effect; after confirmation it may have applied.
  const cancelledEarly = project({
    observation: observation(untrusted, "2026-09-24T00:04:45.000Z"),
    journal: [
      entry(PUBLISH, "requested", "2026-09-24T00:04:30.000Z"),
      entry(PUBLISH, "completed", "2026-09-24T00:04:31.000Z", "cancelled"),
    ],
  });
  assert.equal(cancelledEarly.steps.find((step) => step.dimension === "repository-trust")?.status, "ready");
  const cancelledLate = project({
    observation: observation(untrusted, "2026-09-24T00:04:45.000Z"),
    journal: [
      entry(PUBLISH, "requested", "2026-09-24T00:04:30.000Z"),
      entry(PUBLISH, "confirmed", "2026-09-24T00:04:30.000Z"),
      entry(PUBLISH, "completed", "2026-09-24T00:04:31.000Z", "cancelled"),
    ],
  });
  assert.equal(cancelledLate.steps.find((step) => step.dimension === "repository-trust")?.status, "uncertain");

  const failed = project({
    observation: observation(untrusted, "2026-09-24T00:04:45.000Z"),
    journal: [entry(PUBLISH, "completed", "2026-09-24T00:04:31.000Z", "failed")],
  });
  assert.equal(failed.steps.find((step) => step.dimension === "repository-trust")?.status, "failed");

  // Observation evidence decides completion even when an attempt is unfinished.
  const trusted = project({
    observation: observation(),
    journal: [entry(PUBLISH, "confirmed", "2026-09-24T00:04:30.000Z")],
  });
  assert.equal(trusted.stage, "task-ready");
});

test("an unavailable or invalid journal blocks every effect", () => {
  const untrusted = observation({ repositoryTrust: "untrusted" });
  for (const journal of [
    undefined,
    [{ ...entry(PUBLISH, "requested", "2026-09-24T00:03:00.000Z"), token: "x" }],
    Array.from({ length: 65 }, () => entry(PUBLISH, "requested", "2026-09-24T00:03:00.000Z")),
  ]) {
    const state = project({ observation: untrusted, journal });
    assert.equal(state.actions.length, 0);
    assert.deepEqual(state.nextAction, { kind: "blocked", step: "repository-trust", reason: "journal-invalid" });
    assert.equal(state.diagnostics[0]?.code, "SETUP_JOURNAL_INVALID");
  }
});

test("state is versioned, secret-free JSON and rejects secret-bearing observations", () => {
  const state = project({ observation: observation({ configuration: "unconfigured" }) });
  assert.equal(state.version, 1);
  assert.equal(state.contractVersion, 1);
  const json = JSON.parse(JSON.stringify(state)) as unknown;
  assert.deepEqual(findSetupSecretMaterial(json), []);
  const leaking = observation();
  (leaking.configuration as Record<string, unknown>).diagnostics = [
    { code: "KEY", message: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" },
  ];
  assert.throws(() => project({ observation: leaking }), { code: "RUNTIME_CONTRACT_SECRET_MATERIAL" });
});

test("operation identity is stable per intent and changes with generation", () => {
  assert.equal(setupOperationId("authority.publish-trust", generation), PUBLISH);
  assert.notEqual(setupOperationId("authority.publish-trust", { repository, configuration: "gen-2" }), PUBLISH);
  assert.notEqual(
    setupOperationId("authority.publish-trust", {
      repository: { ...repository, repositoryId: "2" },
      configuration: "gen-1",
    }),
    PUBLISH,
  );
  assert.match(PUBLISH, /^authority\.publish-trust:[0-9a-f]{16}$/u);
});
