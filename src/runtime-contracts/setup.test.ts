import assert from "node:assert/strict";
import test from "node:test";
import { validateStructuredCommand } from "./command.js";
import {
  SETUP_DIMENSION_STATUSES,
  SETUP_DIMENSIONS,
  SETUP_OBSERVATION_MEMBERS,
  validateSetupAction,
  validateSetupActionRequest,
  validateSetupActionResult,
  validateSetupJournalEntry,
  validateSetupObservation,
} from "./setup.js";
import { sameSetupGeneration } from "./setup-primitives.js";

const repository = { repositoryHost: "github.com", repositoryId: "1330755860", nameWithOwner: "yohn-jp/gh-inari" };
const generation = { repository, configuration: "gen-1" };
const evidence = (owner: string) => ({ owner, observedAt: "2026-09-24T00:00:00Z", generation: "gen-1" });

function observation(): Record<string, unknown> {
  return {
    version: 1,
    generation,
    observedAt: "2026-09-24T00:00:00Z",
    configuration: {
      dimension: "configuration",
      status: "configured",
      evidence: evidence("executor"),
      diagnostics: [],
    },
    health: { dimension: "health", status: "not-running", evidence: evidence("composition"), diagnostics: [] },
    providerBinding: { dimension: "provider-binding", status: "unknown", diagnostics: [] },
    repositoryTrust: {
      dimension: "repository-trust",
      status: "pending-human-trust",
      evidence: evidence("authority"),
      diagnostics: [{ code: "TRUST_PR_OPEN", message: "Trust pull request awaits human review." }],
    },
    sessionReadiness: {
      dimension: "session-readiness",
      status: "not-ready",
      evidence: evidence("admission"),
      diagnostics: [],
    },
  };
}

function action(): Record<string, unknown> {
  return {
    version: 1,
    id: "op-1",
    kind: "executor.enroll-issuer-key",
    owner: "executor",
    title: "Register the Issuer App private key",
    prerequisites: [{ dimension: "configuration", statuses: ["unconfigured", "partial"] }],
    inputs: [
      { id: "app-id", kind: "text", label: "Issuer App ID", required: true },
      {
        id: "issuer-key",
        kind: "enrollment",
        label: "Issuer private key",
        required: true,
        enrollment: "executor-issuer-private-key",
      },
    ],
    confirmation: { required: true, summary: "Store the key in the Executor." },
    freshness: { generation, notAfter: "2026-09-24T00:10:00Z" },
    command: { executable: "inari", argv: ["runtime", "executor", "setup", "--app-id", "123"] },
  };
}

test("configuration, health, provider binding, trust and Session readiness stay distinct", () => {
  assert.deepEqual(Object.keys(SETUP_OBSERVATION_MEMBERS), [...SETUP_DIMENSIONS]);
  const parsed = validateSetupObservation(observation());
  assert.equal(parsed.configuration.status, "configured");
  assert.equal(parsed.health.status, "not-running");
  assert.equal(parsed.repositoryTrust.status, "pending-human-trust");
  assert.equal("ready" in parsed, false);
  // No non-unknown status is shared between dimensions, so none can stand in for another.
  const seen = new Map<string, string>();
  for (const dimension of SETUP_DIMENSIONS) {
    for (const status of SETUP_DIMENSION_STATUSES[dimension]) {
      if (status === "unknown") continue;
      assert.equal(seen.get(status), undefined, `${status} is shared by ${dimension} and ${seen.get(status)}`);
      seen.set(status, dimension);
    }
  }
  const crossed = observation();
  crossed.health = { dimension: "health", status: "trusted", evidence: evidence("composition"), diagnostics: [] };
  assert.throws(() => validateSetupObservation(crossed), /health status/u);
  const swapped = observation();
  swapped.health = swapped.configuration;
  assert.throws(() => validateSetupObservation(swapped), /must be health/u);
  const aggregate = { ...observation(), ready: true };
  assert.throws(() => validateSetupObservation(aggregate), /not a member/u);
});

test("known statuses require owner evidence", () => {
  const missing = observation();
  missing.configuration = { dimension: "configuration", status: "configured", diagnostics: [] };
  assert.throws(() => validateSetupObservation(missing), /evidence/u);
});

test("actions carry prerequisites, inputs, confirmation, freshness and argv commands", () => {
  const parsed = validateSetupAction(action());
  assert.equal(parsed.inputs[1]?.enrollment, "executor-issuer-private-key");
  assert.deepEqual(parsed.command?.argv, ["runtime", "executor", "setup", "--app-id", "123"]);
  assert.throws(() => validateSetupAction({ ...action(), kind: "enroll" }), /component/u);
  assert.throws(
    () => validateSetupAction({ ...action(), prerequisites: [{ dimension: "health", statuses: ["trusted"] }] }),
    /health status/u,
  );
  assert.throws(
    () =>
      validateSetupAction({
        ...action(),
        inputs: [{ id: "issuer-key", kind: "enrollment", label: "Key", required: true }],
      }),
    /enrollment kind/u,
  );
  assert.throws(() => validateSetupAction({ ...action(), command: "inari runtime supervise" }), /object/u);
});

test("structured commands reject shell strings and multi-line arguments", () => {
  assert.throws(() => validateStructuredCommand({ executable: "sh -c", argv: [] }), /whitespace/u);
  assert.throws(() => validateStructuredCommand({ executable: "inari", argv: ["a\nb"] }), /single-line/u);
  assert.throws(() => validateStructuredCommand({ executable: "inari", argv: [], shell: true }), /unknown/u);
});

test("setup JSON rejects credential and private-key material", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEI\n-----END PRIVATE KEY-----";
  assert.throws(
    () =>
      validateSetupActionRequest({
        version: 1,
        actionId: "op-1",
        generation,
        confirmed: true,
        inputs: { "issuer-key": pem },
      }),
    { code: "RUNTIME_CONTRACT_SECRET_MATERIAL" },
  );
  assert.throws(
    () =>
      validateSetupActionRequest({ version: 1, actionId: "op-1", generation, confirmed: true, inputs: { token: "x" } }),
    { code: "RUNTIME_CONTRACT_SECRET_MATERIAL" },
  );
  const withKey = action();
  withKey.command = { executable: "inari", argv: ["--key", `ghp_${"b".repeat(36)}`] };
  assert.throws(() => validateSetupAction(withKey), { code: "RUNTIME_CONTRACT_SECRET_MATERIAL" });
  const withJwk = observation();
  withJwk.configuration = {
    dimension: "configuration",
    status: "configured",
    evidence: evidence("authority"),
    diagnostics: [],
    key: { kty: "OKP", d: "x" },
  };
  assert.throws(() => validateSetupObservation(withJwk), { code: "RUNTIME_CONTRACT_SECRET_MATERIAL" });
});

test("results are bounded outcomes bound to a generation", () => {
  const result = validateSetupActionResult({
    version: 1,
    actionId: "op-1",
    generation,
    outcome: "unknown",
    diagnostics: [],
  });
  assert.equal(result.outcome, "unknown");
  assert.throws(
    () => validateSetupActionResult({ version: 1, actionId: "op-1", generation, outcome: "ready", diagnostics: [] }),
    /outcome/u,
  );
  const stale = { repository, configuration: "gen-2" };
  const otherRepository = { repository: { ...repository, repositoryId: "1" }, configuration: "gen-1" };
  assert.equal(sameSetupGeneration(generation, { ...generation }), true);
  assert.equal(sameSetupGeneration(generation, stale), false);
  assert.equal(sameSetupGeneration(generation, otherRepository), false);
});

test("journal entries are secret-free and completed entries carry an outcome", () => {
  const entry = {
    version: 1,
    actionId: "op-1",
    owner: "executor",
    generation,
    phase: "completed",
    outcome: "succeeded",
    recordedAt: "2026-09-24T00:00:01Z",
    diagnostics: [],
  };
  assert.equal(validateSetupJournalEntry(entry).outcome, "succeeded");
  assert.throws(() => validateSetupJournalEntry({ ...entry, outcome: undefined }), /outcome/u);
  assert.throws(() => validateSetupJournalEntry({ ...entry, phase: "requested" }), /outcome/u);
  assert.throws(() => validateSetupJournalEntry({ ...entry, secret: "x" }), {
    code: "RUNTIME_CONTRACT_SECRET_MATERIAL",
  });
});
