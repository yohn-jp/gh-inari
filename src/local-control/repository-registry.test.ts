import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalControlError } from "./config.js";
import {
  MAX_REGISTERED_REPOSITORIES,
  RepositoryRegistry,
  RepositoryRegistryError,
  repositoryRegistryRecordPath,
  validateRepositoryRegistryRecord,
  type RepositoryRegistryErrorCode,
} from "./repository-registry.js";

const INARI = { repositoryHost: "github.com", repositoryId: "1330755860", nameWithOwner: "yohn-jp/gh-inari" };
const OTHER = { repositoryHost: "github.com", repositoryId: "42", nameWithOwner: "yohn-jp/other" };
const SMALL = { repositoryHost: "github.com", repositoryId: "7", nameWithOwner: "octo/small" };

async function temporaryRegistry(): Promise<{
  readonly root: string;
  readonly home: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly registry: RepositoryRegistry;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-repository-registry-"));
  const home = path.join(root, "config");
  const environment = { INARI_CONFIG_HOME: home };
  return { root, home, environment, registry: new RepositoryRegistry({ environment }) };
}

function registryError(code: RepositoryRegistryErrorCode, causeCode?: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof RepositoryRegistryError);
    assert.equal(error.code, code);
    if (causeCode !== undefined) {
      assert.ok(error.cause instanceof LocalControlError);
      assert.equal(error.cause.code, causeCode);
    }
    return true;
  };
}

async function writePrivate(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, typeof value === "string" ? value : `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

test("distinct repositories are registered under their decimal ID and listed deterministically", async () => {
  const { root, home, environment, registry } = await temporaryRegistry();
  try {
    assert.deepEqual(registry.list(), []);
    for (const observation of [OTHER, INARI, SMALL]) {
      assert.deepEqual(registry.register(observation), { version: 1, ...observation });
    }
    assert.deepEqual(registry.register(INARI), { version: 1, ...INARI });
    const expected = [SMALL, OTHER, INARI].map((identity) => ({ version: 1, ...identity }));
    assert.deepEqual(registry.list(), expected);
    assert.deepEqual(new RepositoryRegistry({ environment }).list(), expected);
    assert.deepEqual(registry.get(INARI.repositoryId), { version: 1, ...INARI });
    assert.equal(registry.get("99"), undefined);

    const file = path.join(home, "repositories", "1330755860", "repository.json");
    assert.equal(repositoryRegistryRecordPath("1330755860", environment), file);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      version: 1,
      repositoryHost: "github.com",
      repositoryId: "1330755860",
      nameWithOwner: "yohn-jp/gh-inari",
    });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(home, "repositories"))).mode & 0o777, 0o700);
    assert.deepEqual((await readdir(home)).sort(), ["repositories"]);
    assert.deepEqual((await readdir(path.join(home, "repositories"))).sort(), ["1330755860", "42", "7"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry path identity is the decimal repository ID only", async () => {
  const { root, home, environment, registry } = await temporaryRegistry();
  try {
    for (const invalidId of ["", "0", "0123", "-1", "1e3", "abc", "../1", "1/2", "github.com", "1".repeat(21)]) {
      assert.throws(
        () => repositoryRegistryRecordPath(invalidId, environment),
        registryError("REPOSITORY_REGISTRY_INVALID"),
      );
      assert.throws(() => registry.get(invalidId), registryError("REPOSITORY_REGISTRY_INVALID"));
    }
    const sameName = { ...INARI, repositoryId: "1330755861" };
    registry.register(INARI);
    registry.register(sameName);
    assert.deepEqual(
      registry.list().map((record) => record.repositoryId),
      ["1330755860", "1330755861"],
    );
    for (const record of registry.list()) {
      assert.equal(
        repositoryRegistryRecordPath(record.repositoryId, environment),
        path.join(home, "repositories", record.repositoryId, "repository.json"),
      );
    }
    assert.deepEqual((await readdir(path.join(home, "repositories"))).sort(), ["1330755860", "1330755861"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rename of the same host and ID replaces only nameWithOwner in place", async () => {
  const { root, home, registry } = await temporaryRegistry();
  try {
    const observed = registry.register(INARI);
    const renamed = { ...INARI, nameWithOwner: "yohn-jp/inari" };
    assert.throws(() => registry.register(renamed), registryError("REPOSITORY_REGISTRY_METADATA_CONFLICT"));
    assert.deepEqual(registry.get(INARI.repositoryId), observed);

    const updated = registry.updateNameWithOwner(observed, renamed);
    assert.deepEqual(updated, { version: 1, ...renamed });
    assert.deepEqual(registry.updateNameWithOwner(observed, renamed), updated);
    assert.deepEqual(registry.register(renamed), updated);
    assert.deepEqual(registry.list(), [updated]);
    assert.deepEqual(await readdir(path.join(home, "repositories")), ["1330755860"]);
    assert.deepEqual(await readdir(path.join(home, "repositories", "1330755860")), ["repository.json"]);
    assert.throws(() => registry.register(INARI), registryError("REPOSITORY_REGISTRY_METADATA_CONFLICT"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same repository ID under another host fails closed before any write", async () => {
  const { root, environment, registry } = await temporaryRegistry();
  try {
    const observed = registry.register(INARI);
    const file = repositoryRegistryRecordPath(INARI.repositoryId, environment);
    const before = await readFile(file);
    const beforeStat = await stat(file);
    const foreign = { ...INARI, repositoryHost: "ghe.example.com" };
    assert.throws(() => registry.register(foreign), registryError("REPOSITORY_REGISTRY_IDENTITY_CONFLICT"));
    assert.throws(
      () => registry.updateNameWithOwner(observed, foreign),
      registryError("REPOSITORY_REGISTRY_IDENTITY_CONFLICT"),
    );
    assert.throws(
      () => registry.updateNameWithOwner({ ...observed, repositoryHost: "ghe.example.com" }, foreign),
      registryError("REPOSITORY_REGISTRY_IDENTITY_CONFLICT"),
    );
    assert.throws(
      () => registry.updateNameWithOwner(observed, { ...OTHER, nameWithOwner: INARI.nameWithOwner }),
      registryError("REPOSITORY_REGISTRY_IDENTITY_CONFLICT"),
    );
    assert.deepEqual(await readFile(file), before);
    assert.equal((await stat(file)).ino, beforeStat.ino);
    assert.deepEqual(registry.list(), [observed]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale compare-and-replace rename fails without corrupting the prior record", async () => {
  const { root, environment, registry } = await temporaryRegistry();
  try {
    assert.throws(
      () => registry.updateNameWithOwner({ version: 1, ...INARI }, { ...INARI, nameWithOwner: "yohn-jp/inari" }),
      registryError("REPOSITORY_REGISTRY_STALE"),
    );
    const observed = registry.register(INARI);
    const concurrent = new RepositoryRegistry({ environment });
    const current = concurrent.updateNameWithOwner(observed, { ...INARI, nameWithOwner: "yohn-jp/renamed" });
    const file = repositoryRegistryRecordPath(INARI.repositoryId, environment);
    const before = await readFile(file);
    assert.throws(
      () => registry.updateNameWithOwner(observed, { ...INARI, nameWithOwner: "yohn-jp/stale" }),
      registryError("REPOSITORY_REGISTRY_STALE"),
    );
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(registry.get(INARI.repositoryId), current);
    assert.deepEqual(registry.list(), [current]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed observations are rejected before storage is prepared", async () => {
  const { root, home, registry } = await temporaryRegistry();
  try {
    const invalidObservations: unknown[] = [
      { ...INARI, repositoryId: "0123" },
      { ...INARI, repositoryId: 1330755860 },
      { ...INARI, repositoryHost: "GitHub.com" },
      { ...INARI, repositoryHost: "github.com/evil" },
      { ...INARI, nameWithOwner: "gh-inari" },
      { ...INARI, nameWithOwner: "yohn-jp/gh-inari/extra" },
      { ...INARI, nameWithOwner: "../gh-inari" },
      { ...INARI, nameWithOwner: `yohn-jp/${"a".repeat(101)}` },
      { ...INARI, installationId: "1" },
      null,
      [],
    ];
    for (const observation of invalidObservations) {
      assert.throws(() => registry.register(observation as typeof INARI), registryError("REPOSITORY_REGISTRY_INVALID"));
    }
    assert.throws(
      () => validateRepositoryRegistryRecord({ ...INARI, version: 2 }),
      registryError("REPOSITORY_REGISTRY_INVALID"),
    );
    await assert.rejects(stat(home));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secret-like material never enters the closed registry schema", async () => {
  const { root, home, environment, registry } = await temporaryRegistry();
  try {
    const token = `ghp_${"A".repeat(36)}`;
    const secretBearing: unknown[] = [
      { ...INARI, nameWithOwner: `yohn-jp/${token}` },
      { ...INARI, privateKey: "-----BEGIN PRIVATE KEY-----" },
      { ...INARI, token },
      { ...INARI, credentialPath: "/home/user/.config/inari/executor/issuer.pem" },
      { ...INARI, session: { id: "s" } },
    ];
    for (const observation of secretBearing) {
      assert.throws(() => registry.register(observation as typeof INARI), registryError("REPOSITORY_REGISTRY_INVALID"));
      assert.throws(
        () => validateRepositoryRegistryRecord({ version: 1, ...(observation as object) }),
        registryError("REPOSITORY_REGISTRY_INVALID"),
      );
    }
    await assert.rejects(stat(home));

    const observed = registry.register(INARI);
    assert.throws(
      () => registry.updateNameWithOwner(observed, { ...INARI, nameWithOwner: `yohn-jp/${token}` }),
      registryError("REPOSITORY_REGISTRY_INVALID"),
    );
    const file = repositoryRegistryRecordPath(INARI.repositoryId, environment);
    await writePrivate(file, { version: 1, ...INARI, token });
    assert.throws(() => registry.get(INARI.repositoryId), registryError("REPOSITORY_REGISTRY_UNREADABLE"));
    assert.throws(() => registry.list(), registryError("REPOSITORY_REGISTRY_UNREADABLE"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed, oversized and inconsistent stored records fail closed", async () => {
  const { root, environment, registry } = await temporaryRegistry();
  try {
    registry.register(INARI);
    const file = repositoryRegistryRecordPath(INARI.repositoryId, environment);
    const cases: readonly [string | object, string | undefined][] = [
      ["{not json", "LOCAL_CONTROL_INVALID_CONFIG"],
      [`${JSON.stringify({ version: 1, ...INARI })}${" ".repeat(64 * 1024)}`, "LOCAL_CONTROL_CONFIG_TOO_LARGE"],
      [{ version: 1, ...INARI, extra: true }, undefined],
      [{ version: 1, ...INARI, repositoryId: "42" }, undefined],
      [{ version: 2, ...INARI }, undefined],
    ];
    for (const [content, causeCode] of cases) {
      await writePrivate(file, content);
      assert.throws(() => registry.get(INARI.repositoryId), registryError("REPOSITORY_REGISTRY_UNREADABLE", causeCode));
      assert.throws(() => registry.list(), registryError("REPOSITORY_REGISTRY_UNREADABLE", causeCode));
      assert.throws(() => registry.register(INARI), registryError("REPOSITORY_REGISTRY_UNREADABLE", causeCode));
      assert.deepEqual(
        await readFile(file, "utf8"),
        typeof content === "string" ? content : `${JSON.stringify(content)}\n`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlinked, hard-linked and unsafely permissioned registry storage fails through storage safety rules", async () => {
  const { root, home, environment, registry } = await temporaryRegistry();
  try {
    registry.register(INARI);
    const file = repositoryRegistryRecordPath(INARI.repositoryId, environment);
    const outside = path.join(root, "outside.json");
    await writePrivate(outside, { version: 1, ...INARI });
    const unsafeStorage = registryError("REPOSITORY_REGISTRY_UNREADABLE", "LOCAL_CONTROL_UNSAFE_STORAGE");

    await rm(file);
    await symlink(outside, file);
    assert.throws(() => registry.get(INARI.repositoryId), unsafeStorage);
    assert.throws(() => registry.list(), unsafeStorage);
    assert.throws(() => registry.register(INARI), unsafeStorage);

    await rm(file);
    await link(outside, file);
    assert.throws(() => registry.get(INARI.repositoryId), unsafeStorage);
    assert.throws(() => registry.list(), unsafeStorage);
    assert.throws(() => registry.register(INARI), unsafeStorage);

    await rm(file);
    await writePrivate(file, { version: 1, ...INARI });
    await chmod(file, 0o644);
    assert.throws(() => registry.get(INARI.repositoryId), unsafeStorage);
    assert.throws(() => registry.list(), unsafeStorage);
    await chmod(file, 0o600);
    assert.deepEqual(registry.list(), [{ version: 1, ...INARI }]);

    const repositoryDirectory = path.dirname(file);
    await chmod(repositoryDirectory, 0o770);
    assert.throws(() => registry.get(INARI.repositoryId), unsafeStorage);
    assert.throws(() => registry.list(), unsafeStorage);
    await chmod(repositoryDirectory, 0o700);

    const registryDirectory = path.join(home, "repositories");
    await chmod(registryDirectory, 0o777);
    assert.throws(() => registry.list(), unsafeStorage);
    await chmod(registryDirectory, 0o700);

    const outsideDirectory = path.join(root, "outside-repository");
    await writePrivate(path.join(outsideDirectory, "repository.json"), { version: 1, ...OTHER });
    await symlink(outsideDirectory, path.join(registryDirectory, OTHER.repositoryId));
    assert.throws(() => registry.get(OTHER.repositoryId), unsafeStorage);
    assert.throws(() => registry.list(), registryError("REPOSITORY_REGISTRY_UNREADABLE"));
    assert.throws(() => registry.register(OTHER), unsafeStorage);
    assert.deepEqual(await readdir(outsideDirectory), ["repository.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enumeration reports unexpected registry content and its bound instead of fabricating absence", async () => {
  const { root, home, registry } = await temporaryRegistry();
  try {
    registry.register(INARI);
    const registryDirectory = path.join(home, "repositories");
    const unexpected = registryError("REPOSITORY_REGISTRY_UNREADABLE");

    await writePrivate(path.join(registryDirectory, "notes.json"), {});
    assert.throws(() => registry.list(), unexpected);
    await rm(path.join(registryDirectory, "notes.json"));

    await mkdir(path.join(registryDirectory, "yohn-jp"), { mode: 0o700 });
    assert.throws(() => registry.list(), unexpected);
    await rm(path.join(registryDirectory, "yohn-jp"), { recursive: true });

    await writePrivate(path.join(registryDirectory, "42"), { version: 1, ...OTHER });
    assert.throws(() => registry.list(), unexpected);
    await rm(path.join(registryDirectory, "42"));

    await mkdir(path.join(registryDirectory, "42"), { mode: 0o700 });
    assert.equal(registry.get("42"), undefined);
    assert.throws(() => registry.list(), unexpected);
    await rm(path.join(registryDirectory, "42"), { recursive: true });

    assert.deepEqual(registry.list(), [{ version: 1, ...INARI }]);
    for (let index = 1; index <= MAX_REGISTERED_REPOSITORIES; index += 1) {
      await mkdir(path.join(registryDirectory, String(index)), { mode: 0o700 });
    }
    assert.throws(
      () => registry.list(),
      registryError("REPOSITORY_REGISTRY_UNREADABLE", "LOCAL_CONTROL_CONFIG_TOO_LARGE"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry entries are never inferred from other component or legacy storage", async () => {
  const { root, home, registry } = await temporaryRegistry();
  try {
    await writePrivate(path.join(home, "runtime-profiles", "profile.json"), { repository: INARI });
    await writePrivate(path.join(home, "runtime", "setup", "0123456789abcdef0123456789abcdef.json"), {
      repository: INARI,
    });
    await writePrivate(path.join(home, "executor", "credential.json"), { bindings: [INARI] });
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.get(INARI.repositoryId), undefined);
    await assert.rejects(stat(path.join(home, "repositories")));

    registry.register(INARI);
    assert.deepEqual(JSON.parse(await readFile(path.join(home, "executor", "credential.json"), "utf8")), {
      bindings: [INARI],
    });
    assert.deepEqual((await readdir(home)).sort(), ["executor", "repositories", "runtime", "runtime-profiles"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
