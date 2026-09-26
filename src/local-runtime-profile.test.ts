import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  LocalRuntimeProfileStore,
  localRuntimeProfilePath,
  validateLocalRuntimeProfile,
  type LocalRuntimeProfile,
} from "./local-runtime-profile.js";

function profile(): LocalRuntimeProfile {
  return {
    version: 1,
    state: "ready",
    endpoint: "https://endpoint.example.test",
    relayUrl: "wss://relay.example.test/connect",
    repository: {
      repositoryHost: "github.com",
      repositoryId: "99",
      repositoryNameWithOwner: "acme/inari",
    },
    app: { appId: "42", installationId: "7", clientId: "public-client" },
    authority: {
      authorityId: "runtime-authority",
      publicKeyFingerprint: `sha256:${"a".repeat(64)}`,
      privateKeyPath: "/secure/runtime-key.pem",
    },
  };
}

test("Runtime profile persistence is versioned, keyed, and secret-free", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "inari-profile-test-"));
  try {
    const store = new LocalRuntimeProfileStore({ configHome: home });
    const savedPath = await store.save(profile());
    assert.equal(savedPath, localRuntimeProfilePath(profile(), { configHome: home }));
    const loaded = await store.load(profile());
    assert.deepEqual(loaded, profile());
    const serialized = await readFile(savedPath, "utf8");
    assert.doesNotMatch(serialized, /private-key-bytes|access-token|refresh-token/i);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Runtime profile lookup rejects ambiguous repository matches", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "inari-profile-test-"));
  try {
    const store = new LocalRuntimeProfileStore({ configHome: home });
    await store.save(profile());
    await store.save({ ...profile(), endpoint: "https://other-endpoint.example.test" });
    await assert.rejects(
      () => store.findForRepository({ repositoryHost: "github.com", repositoryNameWithOwner: "acme/inari" }),
      {
        code: "LOCAL_RUNTIME_PROFILE_MISMATCH",
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Runtime profile replacement is compare-and-swap, identity-preserving, and idempotent", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "inari-profile-test-"));
  try {
    const store = new LocalRuntimeProfileStore({ configHome: home });
    const current = profile();
    await store.save(current);
    const next = {
      ...current,
      authority: { ...current.authority, privateKeyPath: "/secure/authority/private-key.pem" },
    };
    await assert.rejects(
      store.replace({ ...current, state: "trust-pending" }, next),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "LOCAL_RUNTIME_PROFILE_MISMATCH",
    );
    assert.deepEqual(await store.load(current), current);
    await assert.rejects(store.replace(current, { ...next, endpoint: "https://other.example.test" }));
    await store.replace(current, next);
    assert.deepEqual(await store.load(current), next);
    await store.replace(current, next);
    assert.deepEqual(validateLocalRuntimeProfile(next), next);
    assert.throws(() => validateLocalRuntimeProfile({ ...next, token: "x" }), /unknown field/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Runtime profile identity lookup matches host and repository ID only and fails closed", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "inari-profile-test-"));
  try {
    const store = new LocalRuntimeProfileStore({ configHome: home });
    const identity = { repositoryHost: "github.com", repositoryId: "99" };
    assert.equal(await store.findForRepositoryIdentity(identity), undefined);
    const renamed = { ...profile(), repository: { ...profile().repository, repositoryNameWithOwner: "acme/renamed" } };
    await store.save(renamed);
    await store.save({ ...profile(), repository: { ...profile().repository, repositoryId: "100" } });
    assert.deepEqual(await store.findForRepositoryIdentity(identity), renamed);
    assert.equal(
      await store.findForRepositoryIdentity({ repositoryHost: "ghe.example.test", repositoryId: "99" }),
      undefined,
    );
    await store.save({ ...profile(), endpoint: "https://other-endpoint.example.test" });
    await assert.rejects(store.findForRepositoryIdentity(identity), { code: "LOCAL_RUNTIME_PROFILE_MISMATCH" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Runtime profile identity lookup rejects unreadable or misplaced profiles instead of skipping them", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "inari-profile-test-"));
  try {
    const store = new LocalRuntimeProfileStore({ configHome: home });
    const saved = await store.save(profile());
    const identity = { repositoryHost: "github.com", repositoryId: "99" };
    await writeFile(path.join(path.dirname(saved), "broken.json"), "{", { mode: 0o600 });
    await assert.rejects(store.findForRepositoryIdentity(identity), { code: "LOCAL_RUNTIME_PROFILE_UNREADABLE" });
    await rm(path.join(path.dirname(saved), "broken.json"));
    await writeFile(path.join(path.dirname(saved), "copied.json"), JSON.stringify(profile()), { mode: 0o600 });
    await assert.rejects(store.findForRepositoryIdentity(identity), { code: "LOCAL_RUNTIME_PROFILE_MISMATCH" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
