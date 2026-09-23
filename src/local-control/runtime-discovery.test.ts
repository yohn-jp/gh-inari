import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  clearLocalRuntimeEndpoint,
  localRuntimeDiscoveryPath,
  publishLocalRuntimeEndpoint,
  readLocalRuntimeEndpoint,
  requireLocalRuntimeEndpoint,
  validateLocalRuntimeEndpoint,
} from "./runtime-discovery.js";

async function temporaryEnvironment(): Promise<{ readonly root: string; readonly environment: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-runtime-discovery-"));
  return { root, environment: { INARI_CONFIG_HOME: path.join(root, "config") } };
}

test("runtime discovery atomically replaces dynamic endpoints and clears only its own instance", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const pathOnDisk = localRuntimeDiscoveryPath("executor", environment);
    const first = publishLocalRuntimeEndpoint("executor", "exec_0123456789abcdef", 41001, environment);
    assert.equal(first.endpoint, "http://127.0.0.1:41001");
    assert.deepEqual(JSON.parse(await readFile(pathOnDisk, "utf8")), first);
    assert.deepEqual(requireLocalRuntimeEndpoint("executor", first.id, environment), first);

    const restarted = publishLocalRuntimeEndpoint("executor", first.id, 41002, environment);
    assert.equal(restarted.endpoint, "http://127.0.0.1:41002");
    assert.notEqual(restarted.instanceId, first.instanceId);
    assert.equal(clearLocalRuntimeEndpoint(first, environment), false);
    assert.deepEqual(readLocalRuntimeEndpoint("executor", environment), restarted);
    assert.equal(clearLocalRuntimeEndpoint(restarted, environment), true);
    assert.equal(readLocalRuntimeEndpoint("executor", environment), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime discovery enforces the pinned component identity and loopback endpoint", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    publishLocalRuntimeEndpoint("admission", "adm_0123456789abcdef", 41003, environment);
    assert.throws(
      () => requireLocalRuntimeEndpoint("admission", "adm_fedcba9876543210", environment),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "LOCAL_RUNTIME_ENDPOINT_IDENTITY_MISMATCH",
    );
    assert.throws(
      () => publishLocalRuntimeEndpoint("admission", "adm_0123456789abcdef", 65536, environment),
      /discovery state is invalid/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Executor discovery supports HTTPS while keeping 0.0.0.0 out of client destinations", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const executor = publishLocalRuntimeEndpoint("executor", "exec_0123456789abcdef", 41004, environment, "https");
    assert.equal(executor.endpoint, "https://127.0.0.1:41004");
    assert.deepEqual(requireLocalRuntimeEndpoint("executor", executor.id, environment), executor);
    assert.throws(() => publishLocalRuntimeEndpoint("admission", "adm_0123456789abcdef", 41005, environment, "https"));
    assert.throws(() =>
      validateLocalRuntimeEndpoint({
        version: 1,
        component: "executor",
        id: "exec_0123456789abcdef",
        endpoint: "https://0.0.0.0:41004",
        instanceId: "0123456789abcdefghijklmn",
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
