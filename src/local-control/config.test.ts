import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  bindLocalCliAdmissionRoute,
  configuredLocalRuntimeBindHost,
  createLocalPrivateFile,
  isLocalAuthorityId,
  listExistingLocalComponentDirectory,
  listExistingLocalStorageDirectory,
  localStoragePath,
  MAX_LOCAL_STORAGE_DIRECTORY_ENTRIES,
  readExistingLocalStorageJson,
  replaceLocalStorageJsonIfCurrent,
  readExistingLocalJson,
  readLocalJson,
  replaceLocalJsonIfCurrent,
  ensureLocalComponentDirectory,
  ensureLocalCliTopology,
  localComponentDirectory,
  localComponentPath,
  readExistingLocalPublicJson,
  resolveConfigHome,
  readLocalPrivateFile,
  validateLocalAdmissionConfig,
  validateLocalAuthorityIdentityConfig,
  validateLocalCliConfig,
  validateLocalExecutorConfig,
  type LocalCliConfig,
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

test("existing local artifact reads do not create missing storage or follow directory symlinks", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const readUnknownJson = (value: unknown): unknown => value;
    assert.equal(
      readExistingLocalPublicJson("authority", "runtime-authority.json", readUnknownJson, environment),
      undefined,
    );
    await assert.rejects(lstat(resolveConfigHome(environment)));

    const configHome = resolveConfigHome(environment);
    const outside = path.join(root, "outside");
    await mkdir(configHome, { mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    const artifact = '{"public":true}\n';
    await writeFile(path.join(outside, "runtime-authority.json"), artifact, { mode: 0o644 });
    await mkdir(localComponentDirectory("authority", environment), { mode: 0o700 });
    await writeFile(localComponentPath("authority", "runtime-authority.json", environment), artifact, {
      mode: 0o644,
    });
    assert.deepEqual(readExistingLocalPublicJson("authority", "runtime-authority.json", readUnknownJson, environment), {
      public: true,
    });
    await rm(localComponentDirectory("authority", environment), { recursive: true });
    await symlink(outside, localComponentDirectory("authority", environment));

    assert.throws(
      () => readExistingLocalPublicJson("authority", "runtime-authority.json", readUnknownJson, environment),
      /unsafe directory/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-creating private reads never prepare the configuration home", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    assert.equal(readExistingLocalJson("cli", "config.json", validateLocalCliConfig, environment), undefined);
    await assert.rejects(lstat(resolveConfigHome(environment)));
    const initial = ensureLocalCliTopology(environment);
    assert.deepEqual(readExistingLocalJson("cli", "config.json", validateLocalCliConfig, environment), initial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compare-and-replace keeps drifted configuration and is idempotent", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const legacy = ensureLocalCliTopology(environment);
    const routed: LocalCliConfig = {
      ...legacy,
      admission: { id: "adm_0123456789abcdef", endpoint: "http://127.0.0.1:8081" },
    };
    const next: LocalCliConfig = { ...legacy, admission: { id: "adm_0123456789abcdef" } };
    assert.throws(
      () => replaceLocalJsonIfCurrent("cli", "config.json", routed, next, validateLocalCliConfig, environment),
      /changed after it was inspected/u,
    );
    const configPath = localComponentPath("cli", "config.json", environment);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), legacy);
    await writeFile(configPath, `${JSON.stringify(routed)}\n`, { mode: 0o600 });
    assert.deepEqual(
      replaceLocalJsonIfCurrent("cli", "config.json", routed, next, validateLocalCliConfig, environment),
      next,
    );
    assert.deepEqual(
      replaceLocalJsonIfCurrent("cli", "config.json", routed, next, validateLocalCliConfig, environment),
      next,
    );
    assert.equal((await lstat(configPath)).mode & 0o077, 0);
    assert.throws(
      () => replaceLocalJsonIfCurrent("admission", "absent.json", legacy, next, validateLocalCliConfig, environment),
      /changed after it was inspected/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private files are created once with owner-only mode and never replaced", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const first = Buffer.from("first\n");
    assert.equal(createLocalPrivateFile("authority", "secret.pem", first, environment), "created");
    assert.equal(createLocalPrivateFile("authority", "secret.pem", Buffer.from("second\n"), environment), "exists");
    assert.deepEqual(readLocalPrivateFile("authority", "secret.pem", environment), first);
    assert.equal((await lstat(localComponentPath("authority", "secret.pem", environment))).mode & 0o077, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-mutating private reads keep directory modes and still reject unsafe storage", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const initial = ensureLocalCliTopology(environment);
    const directory = localComponentDirectory("cli", environment);
    await chmod(directory, 0o750);
    assert.deepEqual(readExistingLocalJson("cli", "config.json", validateLocalCliConfig, environment), initial);
    assert.equal((await lstat(directory)).mode & 0o7777, 0o750);
    await chmod(directory, 0o770);
    assert.throws(
      () => readExistingLocalJson("cli", "config.json", validateLocalCliConfig, environment),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "LOCAL_CONTROL_UNSAFE_STORAGE",
    );
    assert.equal((await lstat(directory)).mode & 0o7777, 0o770);
    // The owner-private write/read path keeps normalizing permissions.
    assert.deepEqual(readLocalJson("cli", "config.json", validateLocalCliConfig, environment), initial);
    assert.equal((await lstat(directory)).mode & 0o7777, 0o700);
    const outside = path.join(root, "outside-cli");
    await rename(directory, outside);
    await symlink(outside, directory);
    assert.throws(
      () => readExistingLocalJson("cli", "config.json", validateLocalCliConfig, environment),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "LOCAL_CONTROL_UNSAFE_STORAGE",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function localControlCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && "code" in error && error.code === code;
}

function validateCounter(value: unknown): { readonly count: number } {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).join() !== "count" ||
    typeof (value as { count?: unknown }).count !== "number"
  ) {
    throw new Error("invalid counter");
  }
  return { count: (value as { count: number }).count };
}

test("config-home storage paths are bounded and never address component roots", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    assert.equal(
      localStoragePath("store/entry/record.json", environment),
      path.join(environment.INARI_CONFIG_HOME as string, "store", "entry", "record.json"),
    );
    for (const relativePath of [
      "",
      "store//x.json",
      "../store/x.json",
      "store/../x.json",
      ".store/x.json",
      "/x.json",
    ]) {
      assert.throws(
        () => localStoragePath(relativePath, environment),
        localControlCode("LOCAL_CONTROL_INVALID_CONFIG"),
      );
    }
    for (const component of ["cli", "authority", "admission", "executor", "runtime"]) {
      assert.throws(
        () => localStoragePath(`${component}/x.json`, environment),
        localControlCode("LOCAL_CONTROL_INVALID_CONFIG"),
      );
      assert.throws(
        () =>
          replaceLocalStorageJsonIfCurrent(
            `${component}/x.json`,
            undefined,
            { count: 1 },
            validateCounter,
            environment,
          ),
        localControlCode("LOCAL_CONTROL_INVALID_CONFIG"),
      );
    }
    assert.throws(
      () => readExistingLocalStorageJson("record.json", validateCounter, environment),
      localControlCode("LOCAL_CONTROL_INVALID_CONFIG"),
    );
    assert.equal(readExistingLocalStorageJson("store/1/record.json", validateCounter, environment), undefined);
    assert.equal(listExistingLocalStorageDirectory("store", 8, environment), undefined);
    await assert.rejects(lstat(environment.INARI_CONFIG_HOME as string));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("config-home storage compare-and-replace is atomic, owner-only and rejects hard links", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const record = "store/1/record.json";
    const file = localStoragePath(record, environment);
    assert.deepEqual(replaceLocalStorageJsonIfCurrent(record, undefined, { count: 1 }, validateCounter, environment), {
      count: 1,
    });
    assert.deepEqual(replaceLocalStorageJsonIfCurrent(record, undefined, { count: 1 }, validateCounter, environment), {
      count: 1,
    });
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.equal((await lstat(path.dirname(file))).mode & 0o777, 0o700);
    assert.equal((await lstat(localStoragePath("store", environment))).mode & 0o777, 0o700);
    assert.throws(
      () => replaceLocalStorageJsonIfCurrent(record, { count: 7 }, { count: 2 }, validateCounter, environment),
      localControlCode("LOCAL_CONTROL_CONFIG_CONFLICT"),
    );
    assert.throws(
      () => replaceLocalStorageJsonIfCurrent(record, undefined, { count: 2 }, validateCounter, environment),
      localControlCode("LOCAL_CONTROL_CONFIG_CONFLICT"),
    );
    assert.deepEqual(readExistingLocalStorageJson(record, validateCounter, environment), { count: 1 });
    assert.deepEqual(
      replaceLocalStorageJsonIfCurrent(record, { count: 1 }, { count: 2 }, validateCounter, environment),
      {
        count: 2,
      },
    );
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { count: 2 });

    const alias = path.join(root, "alias.json");
    await link(file, alias);
    assert.throws(
      () => readExistingLocalStorageJson(record, validateCounter, environment),
      localControlCode("LOCAL_CONTROL_UNSAFE_STORAGE"),
    );
    assert.throws(
      () => replaceLocalStorageJsonIfCurrent(record, { count: 2 }, { count: 3 }, validateCounter, environment),
      localControlCode("LOCAL_CONTROL_UNSAFE_STORAGE"),
    );
    assert.deepEqual(JSON.parse(await readFile(alias, "utf8")), { count: 2 });
    await rm(alias);

    await writeFile(file, `{"count":1}${" ".repeat(64 * 1024)}`, { mode: 0o600 });
    assert.throws(
      () => readExistingLocalStorageJson(record, validateCounter, environment),
      localControlCode("LOCAL_CONTROL_CONFIG_TOO_LARGE"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("config-home storage enumeration is sorted, non-following and bounded", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    replaceLocalStorageJsonIfCurrent("store/b/record.json", undefined, { count: 1 }, validateCounter, environment);
    replaceLocalStorageJsonIfCurrent("store/a/record.json", undefined, { count: 1 }, validateCounter, environment);
    const directory = localStoragePath("store", environment);
    await writeFile(path.join(directory, "c.json"), "{}\n", { mode: 0o600 });
    await symlink(path.join(directory, "a"), path.join(directory, "0-link"));
    assert.deepEqual(listExistingLocalStorageDirectory("store", 4, environment), [
      { name: "0-link", kind: "other" },
      { name: "a", kind: "directory" },
      { name: "b", kind: "directory" },
      { name: "c.json", kind: "file" },
    ]);
    assert.throws(
      () => listExistingLocalStorageDirectory("store", 3, environment),
      localControlCode("LOCAL_CONTROL_CONFIG_TOO_LARGE"),
    );
    for (const bound of [0, -1, 1.5, MAX_LOCAL_STORAGE_DIRECTORY_ENTRIES + 1]) {
      assert.throws(
        () => listExistingLocalStorageDirectory("store", bound, environment),
        localControlCode("LOCAL_CONTROL_INVALID_CONFIG"),
      );
    }
    await chmod(directory, 0o770);
    assert.throws(
      () => listExistingLocalStorageDirectory("store", 4, environment),
      localControlCode("LOCAL_CONTROL_UNSAFE_STORAGE"),
    );
    assert.equal((await lstat(directory)).mode & 0o7777, 0o770);
    await chmod(directory, 0o700);
    const outside = path.join(root, "outside-store");
    await rename(directory, outside);
    await symlink(outside, directory);
    assert.throws(
      () => listExistingLocalStorageDirectory("store", 4, environment),
      localControlCode("LOCAL_CONTROL_UNSAFE_STORAGE"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Authority identity descriptors are closed and bind a canonical Authority ID", () => {
  const descriptor = {
    version: 1,
    authorityId: "runtime-alpha",
    publicKey: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
    publicKeyFingerprint: `sha256:${"a".repeat(64)}`,
    privateKeyFile: "private-key.pem",
  };
  assert.deepEqual(validateLocalAuthorityIdentityConfig(descriptor), descriptor);
  for (const invalidDescriptor of [
    { ...descriptor, privateKey: "secret" },
    { ...descriptor, privateKeyPath: "/tmp/private-key.pem" },
    { ...descriptor, authorityId: undefined },
    { ...descriptor, authorityId: "Runtime-Alpha" },
    { ...descriptor, authorityId: "../runtime" },
    { ...descriptor, privateKeyFile: "../private-key.pem" },
    { ...descriptor, publicKey: { ...descriptor.publicKey, d: "secret" } },
    { ...descriptor, version: 2 },
  ]) {
    assert.throws(
      () => validateLocalAuthorityIdentityConfig(invalidDescriptor),
      localControlCode("LOCAL_CONTROL_INVALID_CONFIG"),
    );
  }
  assert.equal(isLocalAuthorityId("runtime-alpha"), true);
  assert.equal(isLocalAuthorityId("runtime/alpha"), false);
  assert.equal(isLocalAuthorityId(""), false);
});

test("component directory enumeration is sorted, non-mutating and bounded", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    assert.equal(listExistingLocalComponentDirectory("authority", "keys", 4, environment), undefined);
    await assert.rejects(lstat(environment.INARI_CONFIG_HOME as string), { code: "ENOENT" });
    ensureLocalComponentDirectory("authority", environment, "keys", "runtime-b");
    ensureLocalComponentDirectory("authority", environment, "keys", "runtime-a");
    const directory = localComponentPath("authority", "keys", environment);
    await writeFile(path.join(directory, "c.json"), "{}\n", { mode: 0o600 });
    assert.deepEqual(listExistingLocalComponentDirectory("authority", "keys", 3, environment), [
      { name: "c.json", kind: "file" },
      { name: "runtime-a", kind: "directory" },
      { name: "runtime-b", kind: "directory" },
    ]);
    assert.throws(
      () => listExistingLocalComponentDirectory("authority", "keys", 2, environment),
      localControlCode("LOCAL_CONTROL_CONFIG_TOO_LARGE"),
    );
    assert.throws(
      () => listExistingLocalComponentDirectory("authority", "../keys", 4, environment),
      localControlCode("LOCAL_CONTROL_INVALID_CONFIG"),
    );
    await chmod(directory, 0o770);
    assert.throws(
      () => listExistingLocalComponentDirectory("authority", "keys", 4, environment),
      localControlCode("LOCAL_CONTROL_UNSAFE_STORAGE"),
    );
    assert.equal((await lstat(directory)).mode & 0o7777, 0o770);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
