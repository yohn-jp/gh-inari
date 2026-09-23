import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAppUserCredential } from "../github/app-user-credential.js";
import { FileAppUserCredentialStore } from "../github/app-user-credential-store.js";
import { LocalExecutorError, setupLocalExecutor, startConfiguredLocalExecutor } from "./executor-server.js";

async function temporaryEnvironment(): Promise<{ readonly root: string; readonly environment: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-local-executor-"));
  return {
    root,
    environment: {
      INARI_CONFIG_HOME: path.join(root, "config"),
      INARI_GITHUB_APP_ID: "123456",
    },
  };
}

async function saveCredential(environment: NodeJS.ProcessEnv): Promise<void> {
  const store = new FileAppUserCredentialStore({
    path: path.join(environment.INARI_CONFIG_HOME as string, "app-user-credential.json"),
  });
  await store.save(
    createAppUserCredential({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      accessTokenExpiresAt: "2027-01-01T00:00:00.000Z",
      refreshTokenExpiresAt: "2027-06-01T00:00:00.000Z",
    }),
  );
}

test("Executor setup provisions stable identity and references the existing App-user credential store", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    await saveCredential(environment);
    const first = await setupLocalExecutor(environment);
    const second = await setupLocalExecutor(environment);
    assert.equal(first.config.id, second.config.id);
    assert.match(first.config.id, /^exec_[A-Za-z0-9_-]{16,64}$/u);
    assert.equal(first.configPath, path.join(environment.INARI_CONFIG_HOME as string, "executor", "config.json"));
    assert.deepEqual(first.config, {
      version: 1,
      id: first.config.id,
      listen: { host: "127.0.0.1", port: 8765 },
      provider: { kind: "github", credentialProfile: "default" },
    });
    const configText = await readFile(first.configPath, "utf8");
    assert.equal(configText.includes("access-secret"), false);
    assert.equal(configText.includes("refresh-secret"), false);
    assert.ok(
      (await readFile(path.join(environment.INARI_CONFIG_HOME as string, "app-user-credential.json"), "utf8")).includes(
        "access-secret",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Executor serve fails closed when setup or existing provider credentials are missing", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    await assert.rejects(
      () => startConfiguredLocalExecutor("0.14.1", environment),
      (error: unknown) => {
        assert.ok(error instanceof LocalExecutorError);
        assert.equal(error.code, "EXECUTOR_NOT_SETUP");
        return true;
      },
    );

    await saveCredential(environment);
    const configured = await setupLocalExecutor(environment);
    await unlink(path.join(environment.INARI_CONFIG_HOME as string, "app-user-credential.json"));
    await assert.rejects(
      () => startConfiguredLocalExecutor("0.14.1", environment),
      (error: unknown) => {
        assert.ok(error instanceof LocalExecutorError);
        assert.equal(error.code, "EXECUTOR_CREDENTIALS_MISSING");
        assert.match(error.message, /credentials are missing/u);
        return true;
      },
    );
    assert.ok(configured.config.id.startsWith("exec_"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Executor setup reports missing credentials without creating component configuration", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    await assert.rejects(
      () => setupLocalExecutor(environment),
      (error: unknown) => {
        assert.ok(error instanceof LocalExecutorError);
        assert.equal(error.code, "EXECUTOR_CREDENTIALS_MISSING");
        return true;
      },
    );
    await assert.rejects(readFile(path.join(environment.INARI_CONFIG_HOME as string, "executor", "config.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
