import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { generateDelegatorKeyPair } from "../agent-authority/delegator-key.js";
import type { Delegator } from "../agent-authority/delegator.js";
import { projectSetupState } from "../application/setup/index.js";
import { publishLocalRuntimeEndpoint } from "../local-control/runtime-discovery.js";
import { findSetupSecretMaterial, type SetupGeneration } from "../runtime-contracts/index.js";
import { SetupConfigStore } from "./setup-config-store.js";
import {
  SetupProviderError,
  compareCanonicalTrust,
  createAdmissionSessionReadiness,
  createAppUserSetupProvider,
  observeSetup,
  type RuntimeLifecyclePort,
  type SetupProviderPort,
} from "./setup-observation.js";

const repository = { repositoryHost: "github.com", repositoryId: "1330755860", nameWithOwner: "yohn-jp/gh-inari" };

function home(): { root: string; environment: NodeJS.ProcessEnv } {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-setup-observation-"));
  return { root, environment: { INARI_CONFIG_HOME: root } };
}

function record(ceiling: Delegator["capabilityCeiling"] = ["change.implement"]): Delegator {
  return createDelegatorRecord({
    id: "runtime-test",
    key: generateDelegatorKeyPair(),
    maxSessionTtlSeconds: 3600,
    notBefore: "2026-01-01T00:00:00.000Z",
    capabilityCeiling: ceiling,
  });
}

const provider: SetupProviderPort = {
  resolveInstallation: async () => {
    throw new SetupProviderError("authorization");
  },
  readCanonicalAuthorities: async () => {
    throw new SetupProviderError("authorization");
  },
  publishAuthority: async () => {
    throw new SetupProviderError("authorization");
  },
};

test("a clean repository is unconfigured and every other dimension stays distinct and truthful", async () => {
  const { root, environment } = home();
  try {
    const observation = await observeSetup(repository, { environment, provider });
    assert.equal(observation.configuration.status, "unconfigured");
    assert.equal(observation.providerBinding.status, "unbound");
    assert.equal(observation.repositoryTrust.status, "unknown");
    assert.equal(observation.health.status, "unknown");
    assert.equal(observation.health.diagnostics[0]?.code, "SETUP_RUNTIME_LIFECYCLE_UNAVAILABLE");
    assert.equal(observation.sessionReadiness.status, "unknown");
    assert.deepEqual(findSetupSecretMaterial(observation), []);
    for (const item of [observation.configuration, observation.providerBinding]) {
      assert.equal(item.evidence?.generation, observation.generation.configuration);
    }
    const state = projectSetupState({ repository, observation, journal: [], now: new Date() });
    assert.equal(state.stage, "clean");
    assert.equal(state.actions[0]?.kind, "executor.configure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("healthy Runtime evidence never substitutes for trust or Session readiness", async () => {
  const { root, environment } = home();
  try {
    const lifecycle: RuntimeLifecyclePort = {
      observe: async (generation: SetupGeneration) => ({
        status: "healthy",
        observedAt: new Date().toISOString(),
        generation: generation.configuration,
        diagnostics: [],
      }),
      start: async () => ({ outcome: "failed", diagnostics: [] }),
      restart: async () => ({ outcome: "failed", diagnostics: [] }),
    };
    const observation = await observeSetup(repository, { environment, provider, lifecycle });
    assert.equal(observation.health.status, "healthy");
    assert.equal(observation.repositoryTrust.status, "unknown");
    assert.equal(observation.sessionReadiness.status, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle evidence for another generation is unknown", async () => {
  const { root, environment } = home();
  try {
    const lifecycle: RuntimeLifecyclePort = {
      observe: async () => ({
        status: "healthy",
        observedAt: new Date().toISOString(),
        generation: "cfg-other",
        diagnostics: [],
      }),
      start: async () => ({ outcome: "failed", diagnostics: [] }),
      restart: async () => ({ outcome: "failed", diagnostics: [] }),
    };
    const observation = await observeSetup(repository, { environment, provider, lifecycle });
    assert.equal(observation.health.status, "unknown");
    assert.equal(observation.health.diagnostics[0]?.code, "SETUP_RUNTIME_HEALTH_UNAVAILABLE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the configuration generation follows the shared record and binds every fresh process", async () => {
  const { root, environment } = home();
  try {
    const before = await observeSetup(repository, { environment, provider });
    new SetupConfigStore({ environment }).update(repository, 0, { app: { appId: "4242" } });
    const after = await observeSetup(repository, { environment: { INARI_CONFIG_HOME: root }, provider });
    assert.notEqual(after.generation.configuration, before.generation.configuration);
    assert.equal(after.configuration.status, "partial");
    const again = await observeSetup(repository, { environment: { INARI_CONFIG_HOME: root }, provider });
    assert.equal(again.generation.configuration, after.generation.configuration);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical trust must match the adopted Authority exactly", () => {
  const adopted = record();
  assert.equal(compareCanonicalTrust([], adopted), "absent");
  assert.equal(compareCanonicalTrust([adopted], adopted), "trusted");
  assert.equal(
    compareCanonicalTrust([{ ...adopted, capabilityCeiling: ["change.implement", "change.merge"] }], adopted),
    "conflict",
  );
  assert.equal(compareCanonicalTrust([{ ...adopted, maxSessionTtlSeconds: 60 }], adopted), "conflict");
  assert.equal(compareCanonicalTrust([{ ...adopted, notBefore: "2026-02-01T00:00:00.000Z" }], adopted), "conflict");
  assert.equal(compareCanonicalTrust([{ ...adopted, id: "runtime-other" }], adopted), "conflict");
  assert.equal(compareCanonicalTrust([adopted, adopted], adopted), "conflict");
});

test("Admission readiness comes from the announced Admission of the configured identity", async () => {
  const { root, environment } = home();
  const admissionId = "adm_abcdefghijklmnopqrstuvwx";
  let readiness = "ready";
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, component: "admission", admissionId, readiness }));
  });
  try {
    const port = createAdmissionSessionReadiness({ environment });
    const generation = { repository, configuration: "cfg-1" };
    assert.equal((await port.observe(generation, admissionId)).status, "not-ready");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    publishLocalRuntimeEndpoint("admission", admissionId, address.port, environment);
    assert.equal((await port.observe(generation, admissionId)).status, "ready");
    readiness = "starting";
    assert.equal((await port.observe(generation, admissionId)).status, "not-ready");
    await assert.rejects(port.observe(generation, "adm_zyxwvutsrqponmlkjihgfedc"));
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real App-user provider never starts bootstrap authorization implicitly", async () => {
  const { root, environment } = home();
  try {
    let requests = 0;
    const real = createAppUserSetupProvider({
      environment,
      fetch: (async () => {
        requests += 1;
        throw new Error("no network in tests");
      }) as typeof fetch,
    });
    const context = { repository, appId: "4242", clientId: "Iv1.abc" };
    await assert.rejects(real.resolveInstallation(context), (error: unknown) => {
      assert.ok(error instanceof SetupProviderError);
      assert.equal(error.stage, "authorization");
      return true;
    });
    await assert.rejects(real.readCanonicalAuthorities(context), { stage: "authorization" });
    await assert.rejects(real.publishAuthority(context, record()), { stage: "authorization" });
    assert.equal(requests, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
