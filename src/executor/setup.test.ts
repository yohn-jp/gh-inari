import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as setup from "./setup.js";
import * as server from "./server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

interface ModuleReference {
  readonly kind: "value" | "type";
  readonly target: { readonly kind: string; readonly path?: string };
}

interface BoundaryGuardModule {
  buildModuleGraph(
    root: string,
    options: { readonly files: readonly string[] },
  ): { load(relativePath: string): { readonly references: readonly ModuleReference[] } };
  privateGroupsOf(relativePath: string): string[];
}

const { buildModuleGraph, privateGroupsOf } = (await import(
  new URL("../../scripts/check-runtime-boundaries.mjs", import.meta.url).href
)) as BoundaryGuardModule;

function valueClosure(start: string): Set<string> {
  const { load } = buildModuleGraph(root, { files: [] });
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const reference of load(queue.shift() as string).references) {
      if (reference.kind !== "value") continue;
      assert.equal(reference.target.kind === "dynamic" || reference.target.kind === "unresolved", false);
      if (reference.target.kind !== "internal") continue;
      const target = reference.target.path as string;
      if (seen.has(target) || !target.startsWith("src/") || target.endsWith(".d.ts")) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

test("reference-only Executor setup cannot reach Issuer key reading or parsing through imports", () => {
  const closure = valueClosure("src/executor/setup.ts");
  for (const forbidden of [
    "src/executor/execution.ts",
    "src/executor/server.ts",
    "src/relay/local-runtime-config.ts",
    "src/github/app-installation-credential-broker.ts",
    "src/github/index.ts",
  ]) {
    assert.equal(closure.has(forbidden), false, `${forbidden} is reachable from Executor setup`);
  }
  const privateModules = [...closure].filter(
    (module) => privateGroupsOf(module).length > 0 && !module.startsWith("src/executor/"),
  );
  assert.deepEqual(privateModules, []);
  assert.deepEqual([...closure].filter((module) => module.startsWith("src/executor/")).sort(), [
    "src/executor/errors.ts",
    "src/executor/issuer-input.ts",
    "src/executor/setup.ts",
  ]);
});

test("the Executor server entry loads no App-user credential or Authority signing module directly", () => {
  const { load } = buildModuleGraph(root, { files: [] });
  const direct = load("src/executor/server.ts")
    .references.filter((reference) => reference.target.kind === "internal")
    .map((reference) => reference.target.path as string);
  for (const target of direct) {
    assert.deepEqual(
      privateGroupsOf(target).filter((group) => group !== "issuer-custody"),
      [],
      `${target} is a private non-Executor module`,
    );
  }
});

test("the public Executor setup and server entries are narrow and explicit", () => {
  assert.deepEqual(Object.keys(setup).sort(), [
    "LOCAL_EXECUTOR_CREDENTIAL_PROFILE",
    "LOCAL_EXECUTOR_DEFAULT_PORT",
    "LocalExecutorError",
    "configuredLocalExecutor",
    "ensureLocalExecutorConfiguration",
    "localExecutorAppId",
    "localExecutorIssuerKeyStatus",
    "setupLocalExecutor",
  ]);
  assert.deepEqual(Object.keys(server).sort(), [
    "LOCAL_EXECUTOR_STATUS_PATH",
    "createLocalExecutorHttpServer",
    "startConfiguredLocalExecutor",
  ]);
});

test("managed custody can create the secret-free Executor configuration without an operator key reference", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "inari-executor-config-"));
  try {
    const environment = { INARI_CONFIG_HOME: home };
    await assert.rejects(setup.setupLocalExecutor(environment), { code: "EXECUTOR_PROVIDER_CONFIGURATION_MISSING" });
    const first = await setup.ensureLocalExecutorConfiguration(environment);
    const second = await setup.ensureLocalExecutorConfiguration(environment);
    assert.equal(second.config.id, first.config.id);
    assert.deepEqual(Object.keys(first.config).sort(), ["id", "listen", "provider", "version"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
