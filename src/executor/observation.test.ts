import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExecutorAppCredentialStore, ExecutorCredentialStore } from "./credential-store.js";
import { ExecutorRepositoryBindingStore } from "./repository-binding-store.js";
import { createLocalExecutorObservationPort, observeLocalExecutorOwner } from "./observation.js";
import { ensureLocalExecutorConfiguration } from "./setup.js";

const one = { repositoryHost: "github.com", repositoryId: "101", nameWithOwner: "acme/one" };
const two = { repositoryHost: "github.com", repositoryId: "202", nameWithOwner: "acme/two" };
const three = { repositoryHost: "github.com", repositoryId: "303", nameWithOwner: "acme/three" };

function pem(): Buffer {
  return Buffer.from(
    generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }),
  );
}

/** Every path below `root` with its bytes and mode, so any write or directory creation is visible. */
function tree(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  if (!existsSync(root)) return entries;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const mode = statSync(target).mode.toString(8);
      if (entry.isDirectory()) {
        entries[path.relative(root, target) + "/"] = mode;
        visit(target);
      } else entries[path.relative(root, target)] = `${mode}:${readFileSync(target).toString("base64")}`;
    }
  };
  visit(root);
  return entries;
}

function world() {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-executor-observation-"));
  const home = path.join(root, "config");
  return {
    home,
    environment: { INARI_CONFIG_HOME: home },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function leaks(value: unknown, home: string, keys: readonly Buffer[]): readonly string[] {
  const text = JSON.stringify(value);
  return [
    home,
    "PRIVATE KEY",
    ".pem",
    '"file"',
    "configId",
    ...keys.map((key) => key.toString("utf8").slice(40, 90)),
  ].filter((needle) => text.includes(needle));
}

test("#1223 an unconfigured Executor is unavailable and observation creates nothing", async () => {
  const w = world();
  try {
    assert.throws(() => observeLocalExecutorOwner({ environment: w.environment }), {
      code: "EXECUTOR_OWNER_OBSERVATION_UNAVAILABLE",
    });
    assert.equal(existsSync(w.home), false);
    const { config } = await ensureLocalExecutorConfiguration(w.environment);
    const before = tree(w.home);
    assert.deepEqual(await createLocalExecutorObservationPort({ environment: w.environment }).observe(), {
      version: 1,
      executorId: config.id,
      apps: [],
      bindings: [],
    });
    assert.deepEqual(tree(w.home), before);
  } finally {
    w.cleanup();
  }
});

test("#1223 App-scoped custody reports shared and dedicated Apps and owner-evaluated binding status", async () => {
  const w = world();
  try {
    const { config } = await ensureLocalExecutorConfiguration(w.environment);
    const apps = new ExecutorAppCredentialStore(w.environment);
    const bindings = new ExecutorRepositoryBindingStore(w.environment);
    const [keyA, keyB, keyB2] = [pem(), pem(), pem()];
    const appA = apps.markProviderVerified("123", apps.save(config.id, "123", keyA).record.generation);
    const appB = apps.markProviderVerified("456", apps.save(config.id, "456", keyB).record.generation);
    const bind = (repository: typeof one, credential: typeof appA, installationId: string) =>
      bindings.publish({
        ...repository,
        appId: credential.appId,
        installationId,
        generation: credential.generation,
        fingerprint: credential.fingerprint,
      });
    bind(one, appA, "77");
    bind(three, appA, "79");
    bind(two, appB, "88");
    const before = tree(w.home);
    const observation = observeLocalExecutorOwner({ environment: w.environment });
    assert.deepEqual(tree(w.home), before);
    assert.deepEqual(observation.apps, [
      {
        appId: "123",
        generation: appA.generation,
        fingerprint: appA.fingerprint,
        providerVerified: true,
        source: "app-scoped",
      },
      {
        appId: "456",
        generation: appB.generation,
        fingerprint: appB.fingerprint,
        providerVerified: true,
        source: "app-scoped",
      },
    ]);
    assert.deepEqual(
      observation.bindings.map((item) => [
        item.repositoryId,
        item.appId,
        item.installationId,
        item.status,
        item.source,
      ]),
      [
        ["101", "123", "77", "bound", "app-scoped"],
        ["202", "456", "88", "bound", "app-scoped"],
        ["303", "123", "79", "bound", "app-scoped"],
      ],
    );
    assert.deepEqual(leaks(observation, w.home, [keyA, keyB]), []);

    // Rotating App B leaves its older binding stale; App A's bindings are untouched.
    const rotated = apps.save(config.id, "456", keyB2, appB).record;
    const afterRotation = observeLocalExecutorOwner({ environment: w.environment });
    assert.deepEqual(afterRotation.apps[1], {
      appId: "456",
      generation: rotated.generation,
      fingerprint: rotated.fingerprint,
      providerVerified: false,
      source: "app-scoped",
    });
    assert.deepEqual(
      afterRotation.bindings.map((item) => [item.repositoryId, item.status]),
      [
        ["101", "bound"],
        ["202", "stale"],
        ["303", "bound"],
      ],
    );
  } finally {
    w.cleanup();
  }
});

test("#1223 legacy single-App custody is labelled compatibility evidence and never overrides App-scoped custody", async () => {
  const w = world();
  try {
    const { config } = await ensureLocalExecutorConfiguration(w.environment);
    const legacyStore = new ExecutorCredentialStore(w.environment);
    const legacyKey = pem();
    const legacy = legacyStore.save(config.id, "123", legacyKey).record;
    legacyStore.recordBinding(legacy.generation, { ...one, installationId: "77" });
    legacyStore.recordBinding(legacy.generation, { ...two, installationId: "78" });
    const before = tree(w.home);
    const legacyOnly = observeLocalExecutorOwner({ environment: w.environment });
    // Observation never adopts: no App-scoped directory or binding record appears.
    assert.deepEqual(tree(w.home), before);
    assert.equal(existsSync(path.join(w.home, "executor", "apps")), false);
    assert.deepEqual(legacyOnly.apps, [
      {
        appId: "123",
        generation: legacy.generation,
        fingerprint: legacy.fingerprint,
        providerVerified: true,
        source: "legacy",
      },
    ]);
    assert.deepEqual(
      legacyOnly.bindings.map((item) => [item.repositoryId, item.installationId, item.status, item.source]),
      [
        ["101", "77", "bound", "legacy"],
        ["202", "78", "bound", "legacy"],
      ],
    );

    // Canonical App-scoped custody of the same generation wins; only repository 202 stays legacy evidence.
    const apps = new ExecutorAppCredentialStore(w.environment);
    const adopted = apps.adopt(
      {
        configId: config.id,
        appId: "123",
        generation: legacy.generation,
        fingerprint: legacy.fingerprint,
        providerVerified: true,
      },
      legacyKey,
    ).record;
    new ExecutorRepositoryBindingStore(w.environment).publish({
      ...one,
      appId: "123",
      installationId: "77",
      generation: adopted.generation,
      fingerprint: adopted.fingerprint,
    });
    const mixed = observeLocalExecutorOwner({ environment: w.environment });
    assert.deepEqual(
      mixed.apps.map((item) => [item.appId, item.source]),
      [["123", "app-scoped"]],
    );
    assert.deepEqual(
      mixed.bindings.map((item) => [item.repositoryId, item.source]),
      [
        ["101", "app-scoped"],
        ["202", "legacy"],
      ],
    );

    // Once App-scoped custody moves to another generation, stale legacy bindings are not reported.
    apps.save(config.id, "123", pem(), adopted);
    assert.deepEqual(
      observeLocalExecutorOwner({ environment: w.environment }).bindings.map((item) => [
        item.repositoryId,
        item.status,
        item.source,
      ]),
      [["101", "stale", "app-scoped"]],
    );
    assert.deepEqual(leaks(mixed, w.home, [legacyKey]), []);
  } finally {
    w.cleanup();
  }
});

test("#1223 custody of another Executor configuration or unreadable custody fails closed", async () => {
  const w = world();
  try {
    await ensureLocalExecutorConfiguration(w.environment);
    new ExecutorAppCredentialStore(w.environment).save("exec_otherconfiguration01", "123", pem());
    assert.throws(() => observeLocalExecutorOwner({ environment: w.environment }), {
      code: "EXECUTOR_OWNER_OBSERVATION_UNAVAILABLE",
    });
  } finally {
    w.cleanup();
  }
});
