import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { LocalAdmissionClient } from "../local-control/admission-client.js";
import type { LocalExecutorClient } from "../local-control/executor-client.js";
import { RUNTIME_COMPONENT_CATALOG, RUNTIME_COMPONENTS, RUNTIME_PUBLIC_PORTS } from "./components.js";
import type { AdmissionSessionPort, ExecutorExecutionPort } from "./ports.js";

interface BoundaryGuardModule {
  readonly RUNTIME_ROLE_OWNERSHIP: Readonly<Record<string, readonly string[]>>;
  readonly MIGRATION_EDGE_OWNERS: readonly string[];
}

async function loadGuard(): Promise<BoundaryGuardModule> {
  const guardUrl = new URL("../../scripts/check-runtime-boundaries.mjs", import.meta.url).href;
  return (await import(guardUrl)) as BoundaryGuardModule;
}

test("the frozen catalog and the dependency guard declare identical ownership", async () => {
  const guard = await loadGuard();
  assert.deepEqual(Object.keys(guard.RUNTIME_ROLE_OWNERSHIP).sort(), [...RUNTIME_COMPONENTS].sort());
  for (const component of RUNTIME_COMPONENTS) {
    assert.deepEqual(guard.RUNTIME_ROLE_OWNERSHIP[component], RUNTIME_COMPONENT_CATALOG[component].paths, component);
  }
});

test("every public entry lies inside its owner's paths and owners are Epic leaves", async () => {
  const guard = await loadGuard();
  for (const component of RUNTIME_COMPONENTS) {
    const entry = RUNTIME_COMPONENT_CATALOG[component];
    for (const publicEntry of entry.publicEntries) {
      assert.ok(
        entry.paths.some((owned) => (owned.endsWith("/") ? publicEntry.startsWith(owned) : publicEntry === owned)),
        `${component}: ${publicEntry}`,
      );
    }
    assert.ok(["#1105", "#1110", ...guard.MIGRATION_EDGE_OWNERS].includes(entry.owner), component);
  }
});

test("every catalogued port is exported by the public contract entry", () => {
  const index =
    readFileSync(new URL("./ports.ts", import.meta.url), "utf8") +
    readFileSync(new URL("./enrollment.ts", import.meta.url), "utf8");
  for (const port of RUNTIME_PUBLIC_PORTS) assert.match(index, new RegExp(`export interface ${port} \\{`, "u"), port);
  for (const component of RUNTIME_COMPONENTS) {
    const entry = RUNTIME_COMPONENT_CATALOG[component];
    for (const port of [...entry.implements, ...entry.consumes]) assert.ok(RUNTIME_PUBLIC_PORTS.includes(port), port);
  }
});

test("existing neutral clients already satisfy the frozen ports", () => {
  // Compile-time proof: the ports reuse the current wire contracts unchanged.
  const executor = (client: LocalExecutorClient): ExecutorExecutionPort => client;
  const admission = (client: LocalAdmissionClient): AdmissionSessionPort => client;
  assert.equal(typeof executor, "function");
  assert.equal(typeof admission, "function");
});
