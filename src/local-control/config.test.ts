import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  bindLocalCliAdmissionRoute,
  configuredLocalRuntimeBindHost,
  ensureLocalComponentDirectory,
  ensureLocalCliTopology,
  localComponentDirectory,
  localComponentPath,
  resolveConfigHome,
  readLocalPrivateFile,
  validateLocalAdmissionConfig,
  validateLocalCliConfig,
  validateLocalExecutorConfig,
} from "./config.js";

async function temporaryEnvironment(): Promise<{ readonly root: string; readonly environment: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-local-config-"));
  return { root, environment: { INARI_CONFIG_HOME: path.join(root, "config") } };
}

test("local CLI topology is created idempotently without provisioning component identities", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    assert.equal(resolveConfigHome(environment), environment.INARI_CONFIG_HOME);
    const first = ensureLocalCliTopology(environment);
    const second = ensureLocalCliTopology(environment);
    assert.deepEqual(second, first);
    assert.deepEqual(first, {
      version: 1,
      topology: { admission: "local", executor: "local" },
    });
    assert.equal("executor" in first, false);
    assert.equal("admission" in first, false);
    const configPath = localComponentPath("cli", "config.json", environment);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), first);
    await assert.rejects(lstat(localComponentPath("admission", "config.json", environment)));
    await assert.rejects(lstat(localComponentPath("executor", "config.json", environment)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init preserves an existing local Admission route and rejects conflicting topology", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    ensureLocalCliTopology(environment);
    const configPath = localComponentPath("cli", "config.json", environment);
    const route = {
      version: 1,
      topology: { admission: "local", executor: "local" },
      admission: { id: "adm_0123456789abcdef", endpoint: "http://127.0.0.1:8081" },
    };
    await writeFile(configPath, `${JSON.stringify(route)}\n`, { mode: 0o600 });
    assert.deepEqual(ensureLocalCliTopology(environment), route);

    const conflict = { version: 1, topology: { admission: "remote", executor: "local" } };
    await writeFile(configPath, `${JSON.stringify(conflict)}\n`, { mode: 0o600 });
    assert.throws(() => ensureLocalCliTopology(environment), /topology|configuration/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Admission setup can bind the initialized CLI route exactly once", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    ensureLocalCliTopology(environment);
    const route = { id: "adm_0123456789abcdef" };
    const bound = bindLocalCliAdmissionRoute(route, environment);
    assert.deepEqual(bound.admission, route);
    assert.deepEqual(bindLocalCliAdmissionRoute(route, environment), bound);
    assert.throws(() => bindLocalCliAdmissionRoute({ id: "adm_fedcba9876543210" }, environment), /conflicts/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Admission setup migrates a legacy static CLI endpoint to identity-only routing", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const config = ensureLocalCliTopology(environment);
    const configPath = localComponentPath("cli", "config.json", environment);
    await writeFile(
      configPath,
      `${JSON.stringify({ ...config, admission: { id: "adm_0123456789abcdef", endpoint: "http://127.0.0.1:8766" } })}\n`,
      { mode: 0o600 },
    );
    const bound = bindLocalCliAdmissionRoute({ id: "adm_0123456789abcdef" }, environment);
    assert.deepEqual(bound.admission, { id: "adm_0123456789abcdef" });
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).admission, bound.admission);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local config schemas are closed, bounded, and pin only local loopback routes", () => {
  assert.deepEqual(
    validateLocalExecutorConfig({
      version: 1,
      id: "exec_0123456789abcdef",
      listen: { host: "127.0.0.1", port: 0 },
      provider: { kind: "github", credentialProfile: "default" },
    }).listen,
    { host: "127.0.0.1", port: 0 },
  );
  assert.throws(
    () => validateLocalCliConfig({ version: 1, topology: { admission: "local", executor: "local" }, extra: true }),
    /unsupported fields/u,
  );
  assert.throws(
    () =>
      validateLocalCliConfig({
        version: 1,
        topology: { admission: "local", executor: "local" },
        admission: { id: "adm_0123456789abcdef", endpoint: "http://example.com:8081" },
      }),
    /loopback/u,
  );
  assert.throws(
    () =>
      validateLocalAdmissionConfig({
        version: 1,
        id: "adm_0123456789abcdef",
        listen: { host: "127.0.0.1", port: 8080 },
        executor: { id: "exec_0123456789abcdef", endpoint: "http://127.0.0.1:8081" },
        authorityPrivateKey: "secret",
      }),
    /unsupported fields/u,
  );
  assert.throws(
    () =>
      validateLocalExecutorConfig({
        version: 1,
        id: "exec_0123456789abcdef",
        listen: { host: "127.0.0.1", port: 8081 },
        provider: { kind: "github", credentialProfile: "default" },
        admission: "http://127.0.0.1:8080",
      }),
    /unsupported fields/u,
  );
});

test("non-loopback configuration is explicit and keeps client destinations loopback-only", () => {
  const environment = { INARI_LOCAL_RUNTIME_BIND: "0.0.0.0" };
  assert.equal(configuredLocalRuntimeBindHost(environment), "0.0.0.0");
  assert.equal(configuredLocalRuntimeBindHost({}), "127.0.0.1");
  assert.throws(() => configuredLocalRuntimeBindHost({ INARI_LOCAL_RUNTIME_BIND: "192.0.2.10" }), /must be/u);
  assert.deepEqual(
    validateLocalAdmissionConfig({
      version: 1,
      id: "adm_0123456789abcdef",
      listen: { host: "0.0.0.0", port: 8080 },
      executor: { id: "exec_0123456789abcdef", endpoint: "https://127.0.0.1:8081" },
    }),
    {
      version: 1,
      id: "adm_0123456789abcdef",
      listen: { host: "0.0.0.0", port: 8080 },
      executor: { id: "exec_0123456789abcdef", endpoint: "https://127.0.0.1:8081" },
    },
  );
  assert.throws(
    () =>
      validateLocalAdmissionConfig({
        version: 1,
        id: "adm_0123456789abcdef",
        listen: { host: "0.0.0.0", port: 8080 },
        executor: { id: "exec_0123456789abcdef", endpoint: "https://0.0.0.0:8081" },
      }),
    /loopback destination/u,
  );
  assert.throws(
    () =>
      validateLocalAdmissionConfig({
        version: 1,
        id: "adm_0123456789abcdef",
        listen: { host: "0.0.0.0", port: 8080 },
        executor: { id: "exec_0123456789abcdef", endpoint: "http://127.0.0.1:8081" },
      }),
    /loopback destination/u,
  );
});

test("local transport identity files are read only from owner-only regular files", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    ensureLocalComponentDirectory("admission", environment);
    const keyPath = localComponentPath("admission", "mtls-private-key.pem", environment);
    await writeFile(keyPath, "private material", { mode: 0o600 });
    assert.equal(
      readLocalPrivateFile("admission", "mtls-private-key.pem", environment)?.toString(),
      "private material",
    );

    const unsafePath = localComponentPath("admission", "unsafe.pem", environment);
    await writeFile(unsafePath, "private material", { mode: 0o644 });
    assert.throws(() => readLocalPrivateFile("admission", "unsafe.pem", environment), /permissions|ownership/u);

    const outsidePath = path.join(root, "outside.pem");
    await writeFile(outsidePath, "private material", { mode: 0o600 });
    await rm(keyPath);
    await symlink(outsidePath, keyPath);
    assert.throws(() => readLocalPrivateFile("admission", "mtls-private-key.pem", environment), /safely|unsafe/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local configuration rejects symlink files and keeps private directory and file modes", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    ensureLocalCliTopology(environment);
    const configPath = localComponentPath("cli", "config.json", environment);
    const before = await readFile(configPath, "utf8");
    const outsidePath = path.join(root, "outside.json");
    await writeFile(outsidePath, before, { mode: 0o600 });
    await rm(configPath);
    await symlink(outsidePath, configPath);
    assert.throws(() => ensureLocalCliTopology(environment), /safely|unsafe/u);
    assert.equal((await lstat(localComponentDirectory("cli", environment))).mode & 0o077, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
