import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
