import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { createLocalRuntimeConfig, LocalRuntimeConfigError } from "./local-runtime-config.js";
import { createAppUserCredential } from "../github/app-user-credential.js";
import { InMemoryAppUserCredentialStore } from "../github/app-user-credential-store.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function runtimeKey(): Promise<{ readonly directory: string; readonly path: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inari-runtime-config-"));
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = path.join(directory, "runtime-key.pem");
  await writeFile(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
  await chmod(privateKeyPath, 0o600);
  return { directory, path: privateKeyPath };
}

function appUserEnvironment(keyPath: string): Record<string, string> {
  return {
    INARI_RELAY_URL: "wss://relay.example.test",
    INARI_RUNTIME_AUTHORITY_ID: "runtime-authority",
    INARI_GITHUB_APP_ID: "42",
    INARI_RUNTIME_PROFILE: "app-user",
    INARI_RUNTIME_AUTHORITY_PRIVATE_KEY_FILE: keyPath,
  };
}

function appUserFetch(
  overrides: { readonly appId?: number; readonly repositoryId?: number } = {},
): typeof globalThis.fetch {
  return (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/inari") {
      return json({ id: overrides.repositoryId ?? 99, full_name: "acme/inari" });
    }
    if (url.pathname === "/user/installations") {
      return json({
        installations: [
          {
            id: 7,
            app_id: overrides.appId ?? 42,
            permissions: { contents: "write", issues: "write", pull_requests: "write", metadata: "read" },
            suspended_at: null,
          },
        ],
      });
    }
    if (url.pathname === "/user/installations/7/repositories") {
      return json({ repositories: [{ id: overrides.repositoryId ?? 99, full_name: "acme/inari" }] });
    }
    throw new Error(`unexpected provider request: ${url.pathname}`);
  }) as typeof globalThis.fetch;
}

function appUserStore(): InMemoryAppUserCredentialStore {
  return new InMemoryAppUserCredentialStore(
    createAppUserCredential({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      accessTokenExpiresAt: "2027-01-01T00:00:00.000Z",
      refreshTokenExpiresAt: "2027-06-01T00:00:00.000Z",
    }),
  );
}

test("local Runtime configuration fails closed without exposing missing secret values", async () => {
  await assert.rejects(
    () =>
      createLocalRuntimeConfig({
        repository: "github.com/1330755860/yohn-jp/gh-inari",
        relayUrl: "wss://relay.example.test",
        delegatorId: "runtime-authority",
        privateKeyPath: "/missing/runtime-key.pem",
        environment: {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal("code" in error, true);
      assert.equal(error.message.includes("missing/runtime-key.pem"), false);
      assert.equal(error.message.includes("PRIVATE_KEY"), false);
      return true;
    },
  );
});

test("relay endpoint validation is transport-only and fail-closed", async () => {
  await assert.rejects(
    () =>
      createLocalRuntimeConfig({
        repository: "github.com/1330755860/yohn-jp/gh-inari",
        relayUrl: "https://relay.example.test",
        delegatorId: "runtime-authority",
        privateKeyPath: "/missing/runtime-key.pem",
        environment: {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof LocalRuntimeConfigError);
      assert.equal(error.code, "LOCAL_RUNTIME_CONFIG_INVALID");
      assert.equal(error.message, "Relay endpoint must use ws or wss.");
      return true;
    },
  );
});

test("App-user composition resolves immutable repository and installation scope before Runtime construction", async () => {
  const key = await runtimeKey();
  try {
    const configuration = await createLocalRuntimeConfig({
      repository: "acme/inari",
      privateKeyPath: key.path,
      environment: appUserEnvironment(key.path),
      appUser: { credentialStore: appUserStore(), fetch: appUserFetch() },
    });
    assert.deepEqual(configuration.repository, {
      repositoryHost: "github.com",
      repositoryId: "99",
      repositoryNameWithOwner: "acme/inari",
    });
    assert.deepEqual(configuration.app, { appId: "42", installationId: "7" });
    assert.equal(JSON.stringify(configuration).includes("access-secret"), false);
  } finally {
    await rm(key.directory, { recursive: true, force: true });
  }
});

test("App-user provider failure rejects before a Local Runtime can connect", async () => {
  const key = await runtimeKey();
  try {
    await assert.rejects(
      () =>
        createLocalRuntimeConfig({
          repository: "github.com/99/acme/inari",
          privateKeyPath: key.path,
          environment: appUserEnvironment(key.path),
          appUser: { credentialStore: appUserStore(), fetch: appUserFetch({ appId: 41 }) },
        }),
      (error: unknown) => error instanceof Error && error.name === "GitHubAppUserCredentialBrokerError",
    );
  } finally {
    await rm(key.directory, { recursive: true, force: true });
  }
});

test("App-user repository mismatch fails closed", async () => {
  const key = await runtimeKey();
  try {
    await assert.rejects(
      () =>
        createLocalRuntimeConfig({
          repository: "github.com/99/acme/inari",
          privateKeyPath: key.path,
          environment: appUserEnvironment(key.path),
          appUser: { credentialStore: appUserStore(), fetch: appUserFetch({ repositoryId: 100 }) },
        }),
      (error: unknown) => error instanceof Error && error.name === "GitHubAppUserCredentialBrokerError",
    );
  } finally {
    await rm(key.directory, { recursive: true, force: true });
  }
});

test("legacy installation-key composition remains compatible", async () => {
  const key = await runtimeKey();
  try {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const configuration = await createLocalRuntimeConfig({
      repository: "github.com/99/acme/inari",
      privateKeyPath: key.path,
      environment: {
        INARI_RELAY_URL: "wss://relay.example.test",
        INARI_RUNTIME_AUTHORITY_ID: "runtime-authority",
        INARI_GITHUB_APP_ID: "42",
        INARI_GITHUB_APP_INSTALLATION_ID: "7",
        INARI_GITHUB_APP_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs1" }).toString(),
      },
    });
    assert.deepEqual(configuration.repository, {
      repositoryHost: "github.com",
      repositoryId: "99",
      repositoryNameWithOwner: "acme/inari",
    });
    assert.deepEqual(configuration.app, { appId: "42", installationId: "7" });
  } finally {
    await rm(key.directory, { recursive: true, force: true });
  }
});
