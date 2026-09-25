import assert from "node:assert/strict";
import test from "node:test";
import {
  findSetupSecretMaterial,
  type SecretEnrollmentPort,
  type SecretEnrollmentRequest,
  type SetupActionPort,
  type SetupActionRequest,
  type SetupActionResult,
  type SetupJournalEntry,
  type SetupJournalPort,
  type SetupObservation,
  type SetupObservationPort,
} from "../../runtime-contracts/index.js";
import { createSetupApplication, type SetupApplicationPorts } from "./actions.js";
import { setupOperationId } from "./state.js";

const repository = { repositoryHost: "github.com", repositoryId: "1330755860", nameWithOwner: "yohn-jp/gh-inari" };
const generation = { repository, configuration: "gen-1" };
const PUBLISH = setupOperationId("authority.publish-trust", generation);
const CONFIGURE = setupOperationId("executor.configure", generation);
const START = setupOperationId("composition.start-runtime", generation);
const PEM = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEI\n-----END PRIVATE KEY-----";

type Statuses = Record<"configuration" | "health" | "providerBinding" | "repositoryTrust" | "sessionReadiness", string>;
const DIMENSION: Record<keyof Statuses, string> = {
  configuration: "configuration",
  health: "health",
  providerBinding: "provider-binding",
  repositoryTrust: "repository-trust",
  sessionReadiness: "session-readiness",
};

/** In-memory owners: a clock, observed statuses and a journal. */
function world(initial: Partial<Statuses>) {
  let clock = Date.parse("2026-09-24T00:05:00.000Z");
  const statuses: Statuses = {
    configuration: "configured",
    health: "healthy",
    providerBinding: "bound",
    repositoryTrust: "trusted",
    sessionReadiness: "ready",
    ...initial,
  };
  let observedAt = clock;
  const journal: SetupJournalEntry[] = [];
  const performed: SetupActionRequest[] = [];
  const counts = { observe: 0, read: 0, append: 0 };
  const observation: SetupObservationPort = {
    async observe() {
      counts.observe += 1;
      const at = new Date(observedAt).toISOString();
      const result: Record<string, unknown> = { version: 1, generation, observedAt: at };
      for (const member of Object.keys(DIMENSION) as (keyof Statuses)[]) {
        result[member] = {
          dimension: DIMENSION[member],
          status: statuses[member],
          evidence: { owner: "composition", observedAt: at, generation: "gen-1" },
          diagnostics: [],
        };
      }
      return result as unknown as SetupObservation;
    },
  };
  const journalPort: SetupJournalPort & { failAppend: boolean } = {
    failAppend: false,
    async append(entry) {
      counts.append += 1;
      if (journalPort.failAppend) throw new Error("journal unavailable");
      journal.push(entry);
    },
    async read() {
      counts.read += 1;
      return journal.slice(-64);
    },
  };
  let behavior: (request: SetupActionRequest) => Promise<SetupActionResult> = async (request) => ({
    version: 1,
    actionId: request.actionId,
    generation: request.generation,
    outcome: "succeeded",
    diagnostics: [],
  });
  const action: SetupActionPort = {
    async perform(request) {
      performed.push(request);
      return behavior(request);
    },
  };
  return {
    statuses,
    journal,
    performed,
    counts,
    journalPort,
    tick(ms: number, observe = true) {
      clock += ms;
      if (observe) observedAt = clock;
    },
    setBehavior(next: typeof behavior) {
      behavior = next;
    },
    ports(extra: Partial<SetupApplicationPorts> = {}): SetupApplicationPorts {
      return { observation, action, journal: journalPort, now: () => new Date(clock), ...extra };
    },
  };
}

function request(actionId: string, extra: Partial<Record<string, unknown>> = {}) {
  return { version: 1, actionId, generation, confirmed: true, inputs: {}, ...extra };
}

test("reads observe owners and never initiate actions or journal writes", async () => {
  const w = world({ repositoryTrust: "untrusted" });
  const app = createSetupApplication(w.ports());
  const state = await app.state(repository);
  assert.equal(state.nextAction.kind, "perform");
  assert.deepEqual(w.counts, { observe: 1, read: 1, append: 0 });
  assert.equal(w.performed.length, 0);
});

test("confirmed publication dispatches once, journals phases and is not trust", async () => {
  const w = world({ repositoryTrust: "untrusted" });
  const app = createSetupApplication(w.ports());
  const result = await app.perform(repository, request(PUBLISH));
  assert.equal(result.outcome, "succeeded");
  assert.equal(w.performed.length, 1);
  assert.deepEqual(
    w.journal.map((item) => [item.phase, item.outcome]),
    [
      ["requested", undefined],
      ["confirmed", undefined],
      ["completed", "succeeded"],
    ],
  );
  // Evidence predating the result forces a refresh; the action is not re-offered.
  const before = await app.state(repository);
  assert.equal(before.stage, "configured");
  assert.deepEqual(before.nextAction, { kind: "refresh", step: "repository-trust", reason: "journal-newer" });
  // A duplicate confirmation is refused without a second effect.
  const duplicate = await app.perform(repository, request(PUBLISH));
  assert.equal(duplicate.outcome, "stale");
  assert.equal(duplicate.diagnostics[0]?.code, "SETUP_ACTION_NOT_OFFERED");
  assert.equal(w.performed.length, 1);
  // Only owner evidence moves trust forward, and it stops at human review.
  w.statuses.repositoryTrust = "pending-human-trust";
  w.tick(1000);
  const pending = await app.state(repository);
  assert.equal(pending.stage, "pending-human-trust");
  assert.equal(pending.nextAction.kind, "wait");
});

test("wrong repository and stale generation produce no effects", async () => {
  const w = world({ repositoryTrust: "untrusted" });
  const app = createSetupApplication(w.ports());
  const foreign = await app.perform({ ...repository, repositoryId: "42" }, request(PUBLISH));
  assert.equal(foreign.outcome, "stale");
  assert.equal(foreign.diagnostics[0]?.code, "SETUP_REPOSITORY_MISMATCH");
  const stale = await app.perform(repository, request(PUBLISH, { generation: { repository, configuration: "gen-0" } }));
  assert.equal(stale.outcome, "stale");
  assert.equal(stale.diagnostics[0]?.code, "SETUP_GENERATION_STALE");
  w.tick(10 * 60_000, false);
  const expired = await app.perform(repository, request(PUBLISH));
  assert.equal(expired.outcome, "stale");
  assert.equal(expired.diagnostics[0]?.code, "SETUP_ACTION_NOT_OFFERED");
  assert.equal(w.performed.length, 0);
  assert.equal(w.journal.length, 0);
});

test("confirmation and inputs are explicit; nothing is defaulted or widened", async () => {
  const w = world({ repositoryTrust: "untrusted" });
  const app = createSetupApplication(w.ports());
  const unconfirmed = await app.perform(repository, request(PUBLISH, { confirmed: false }));
  assert.equal(unconfirmed.outcome, "action-required");
  assert.equal(unconfirmed.diagnostics[0]?.code, "SETUP_CONFIRMATION_REQUIRED");
  const extra = await app.perform(repository, request(PUBLISH, { inputs: { capability: "change.merge" } }));
  assert.equal(extra.outcome, "action-required");
  assert.equal(extra.diagnostics[0]?.code, "SETUP_INPUT_UNKNOWN");
  assert.equal(w.performed.length, 0);
  assert.equal(w.journal.length, 0);

  const clean = world({ configuration: "unconfigured" });
  const setup = createSetupApplication(clean.ports());
  const missing = await setup.perform(repository, request(CONFIGURE));
  assert.equal(missing.outcome, "action-required");
  assert.equal(missing.diagnostics[0]?.code, "SETUP_INPUT_MISSING");
  assert.equal(clean.performed.length, 0);
});

test("secrets cross only the owner enrollment port and never reach state, requests or journal", async () => {
  const w = world({ configuration: "unconfigured" });
  const received: { request: SecretEnrollmentRequest; bytes: number }[] = [];
  const executorEnrollment: SecretEnrollmentPort = {
    owner: "executor",
    kinds: ["executor-issuer-private-key"],
    async enroll(enrollment, secret) {
      let bytes = 0;
      for await (const chunk of secret) bytes += chunk.byteLength;
      received.push({ request: enrollment, bytes });
      return {
        version: 1,
        kind: enrollment.kind,
        operationId: enrollment.operationId,
        repository: enrollment.repository,
        outcome: "enrolled",
        publicFingerprint: `sha256:${"a".repeat(64)}`,
        diagnostics: [],
      };
    },
  };
  const app = createSetupApplication(w.ports({ enrollment: [executorEnrollment] }));
  await assert.rejects(
    app.perform(repository, request(CONFIGURE, { inputs: { "app-id": "123", "issuer-key": PEM } })),
    { code: "RUNTIME_CONTRACT_SECRET_MATERIAL" },
  );
  assert.equal(w.performed.length, 0);

  const bytes = new TextEncoder().encode(PEM);
  const result = await app.perform(repository, request(CONFIGURE, { inputs: { "app-id": "123" } }), {
    enrollments: {
      "issuer-key": {
        declaredBytes: bytes.byteLength,
        stream: (async function* () {
          yield bytes;
        })(),
      },
    },
  });
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.receipt?.publicFingerprint, `sha256:${"a".repeat(64)}`);
  assert.equal(received.length, 1);
  assert.equal(received[0]?.request.operationId, CONFIGURE);
  assert.equal(received[0]?.bytes, bytes.byteLength);
  assert.deepEqual(w.performed[0]?.inputs, { "app-id": "123" });
  const serialized = JSON.stringify({ journal: w.journal, performed: w.performed, state: await app.state(repository) });
  assert.equal(serialized.includes("BEGIN PRIVATE KEY"), false);
  assert.deepEqual(findSetupSecretMaterial(JSON.parse(serialized)), []);

  // Without an owner enrollment port nothing is started.
  const bare = world({ configuration: "unconfigured" });
  const noPort = await createSetupApplication(bare.ports()).perform(
    repository,
    request(CONFIGURE, { inputs: { "app-id": "123" } }),
    { enrollments: { "issuer-key": { declaredBytes: 3, stream: (async function* () {})() } } },
  );
  assert.equal(noPort.outcome, "failed");
  assert.equal(bare.journal.length, 0);
});

test("partial enrollment success requires reconciliation before retry", async () => {
  const w = world({ configuration: "unconfigured" });
  let enrollments = 0;
  const executorEnrollment: SecretEnrollmentPort = {
    owner: "executor",
    kinds: ["executor-issuer-private-key"],
    async enroll(enrollment, secret) {
      for await (const _chunk of secret) {
        // Consume the bounded secret stream.
      }
      enrollments += 1;
      return {
        version: 1,
        kind: enrollment.kind,
        operationId: enrollment.operationId,
        repository: enrollment.repository,
        outcome: "enrolled",
        publicFingerprint: `sha256:${"b".repeat(64)}`,
        diagnostics: [],
      };
    },
  };
  w.setBehavior(async (item) => ({
    version: 1,
    actionId: item.actionId,
    generation: item.generation,
    outcome: "failed",
    diagnostics: [{ code: "OWNER_FAILED", message: "Configuration did not complete." }],
  }));
  const app = createSetupApplication(w.ports({ enrollment: [executorEnrollment] }));
  const bytes = new TextEncoder().encode(PEM);
  const perform = () =>
    app.perform(repository, request(CONFIGURE, { inputs: { "app-id": "123" } }), {
      enrollments: {
        "issuer-key": {
          declaredBytes: bytes.byteLength,
          stream: (async function* () {
            yield bytes;
          })(),
        },
      },
    });

  const result = await perform();
  assert.equal(result.outcome, "unknown");
  assert.equal(result.receipt?.publicFingerprint, `sha256:${"b".repeat(64)}`);
  assert.equal(result.diagnostics.at(-1)?.code, "SETUP_PARTIAL_EFFECT_UNCONFIRMED");
  assert.equal(w.journal.at(-1)?.outcome, "unknown");
  assert.equal(enrollments, 1);

  const beforeEvidence = await app.state(repository);
  assert.deepEqual(beforeEvidence.nextAction, { kind: "refresh", step: "configuration", reason: "journal-newer" });
  assert.equal((await perform()).outcome, "stale");
  assert.equal(enrollments, 1);

  w.tick(1000);
  const reconcile = await app.state(repository);
  assert.deepEqual(reconcile.nextAction, {
    kind: "perform",
    step: "configuration",
    actionId: CONFIGURE,
    reconcile: true,
  });
});

test("an unobserved effect is recorded as unknown and reconciled by operation identity", async () => {
  const w = world({ repositoryTrust: "untrusted" });
  w.setBehavior(async () => {
    throw new Error("connection reset");
  });
  const app = createSetupApplication(w.ports());
  const result = await app.perform(repository, request(PUBLISH));
  assert.equal(result.outcome, "unknown");
  assert.equal(w.journal.at(-1)?.outcome, "unknown");
  const refresh = await app.state(repository);
  assert.equal(refresh.nextAction.kind, "refresh");
  assert.equal((await app.perform(repository, request(PUBLISH))).outcome, "stale");
  assert.equal(w.performed.length, 1);

  w.tick(1000);
  const reconcile = await app.state(repository);
  assert.deepEqual(reconcile.nextAction, {
    kind: "perform",
    step: "repository-trust",
    actionId: PUBLISH,
    reconcile: true,
  });
  w.setBehavior(async (item) => ({
    version: 1,
    actionId: item.actionId,
    generation: item.generation,
    outcome: "succeeded",
    diagnostics: [],
  }));
  assert.equal((await app.perform(repository, request(PUBLISH))).outcome, "succeeded");
  // The retry reuses the same operation identity so the owner can find the existing pull request.
  assert.deepEqual(
    w.performed.map((item) => item.actionId),
    [PUBLISH, PUBLISH],
  );
});

test("owner results for another operation are unknown, not success", async () => {
  const w = world({ repositoryTrust: "untrusted" });
  w.setBehavior(async (item) => ({
    version: 1,
    actionId: "other-op",
    generation: item.generation,
    outcome: "succeeded",
    diagnostics: [],
  }));
  const result = await createSetupApplication(w.ports()).perform(repository, request(PUBLISH));
  assert.equal(result.outcome, "unknown");
  assert.equal(result.diagnostics[0]?.code, "SETUP_RESULT_MISMATCH");
});

test("cancellation never claims rollback of a started effect", async () => {
  const early = world({ health: "not-running" });
  const controller = new AbortController();
  controller.abort();
  const before = await createSetupApplication(early.ports()).perform(repository, request(START), {
    signal: controller.signal,
  });
  assert.equal(before.outcome, "cancelled");
  assert.equal(early.performed.length, 0);

  const late = world({ health: "not-running" });
  const during = new AbortController();
  late.setBehavior(async () => {
    during.abort();
    throw new Error("aborted");
  });
  const app = createSetupApplication(late.ports());
  const result = await app.perform(repository, request(START), { signal: during.signal });
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.diagnostics[0]?.code, "SETUP_EFFECT_UNCONFIRMED");
  late.tick(1000);
  const state = await app.state(repository);
  assert.equal(state.steps.find((step) => step.dimension === "health")?.status, "uncertain");
  assert.deepEqual(state.nextAction, { kind: "perform", step: "health", actionId: START, reconcile: true });
});

test("concurrent duplicates dispatch one effect", async () => {
  const w = world({ health: "not-running" });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  w.setBehavior(async (item) => {
    await gate;
    return { version: 1, actionId: item.actionId, generation: item.generation, outcome: "succeeded", diagnostics: [] };
  });
  const app = createSetupApplication(w.ports());
  const first = app.perform(repository, request(START));
  const second = await app.perform(repository, request(START));
  assert.equal(second.outcome, "stale");
  assert.equal(second.diagnostics[0]?.code, "SETUP_ACTION_IN_PROGRESS");
  // Another frontend sharing the journal sees the attempt in progress.
  const other = createSetupApplication(w.ports());
  await new Promise((resolve) => setImmediate(resolve));
  const otherState = await other.state(repository);
  assert.equal(otherState.steps.find((step) => step.dimension === "health")?.status, "in-progress");
  assert.equal((await other.perform(repository, request(START))).outcome, "stale");
  release();
  assert.equal((await first).outcome, "succeeded");
  assert.equal(w.performed.length, 1);
});

test("a journal that cannot record the attempt prevents the effect", async () => {
  const w = world({ health: "not-running" });
  w.journalPort.failAppend = true;
  const result = await createSetupApplication(w.ports()).perform(repository, request(START));
  assert.equal(result.outcome, "failed");
  assert.equal(result.diagnostics[0]?.code, "SETUP_JOURNAL_UNAVAILABLE");
  assert.equal(w.performed.length, 0);
});
