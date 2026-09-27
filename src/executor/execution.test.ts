import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ChangeTrustedExecutorError } from "../change-trusted-executor.js";
import {
  GITHUB_APP_REPOSITORY_READ_PERMISSIONS,
  GitHubAppCredentialBrokerError,
  GitHubAppInstallationCredentialBroker,
} from "../github/app-installation-credential-broker.js";
import { withChangeFailures } from "./execution.js";
import { setupLocalExecutor, startConfiguredLocalExecutor } from "../local-control/executor-server.js";

const repository = { hostname: "github.com", owner: "acme", name: "inari" } as const;
const now = new Date("2026-09-05T00:00:00.000Z");
const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

function broker(): GitHubAppInstallationCredentialBroker {
  return new GitHubAppInstallationCredentialBroker({
    appId: "218",
    installationId: "219",
    privateKeyPem,
    repository,
    fetch: async () =>
      new Response(
        JSON.stringify({
          token: "installation-token-test-secret",
          expires_at: "2026-09-05T00:10:00.000Z",
          permissions: { ...GITHUB_APP_REPOSITORY_READ_PERMISSIONS },
          repositories: [{ id: 123456789, full_name: "acme/inari" }],
        }),
        { status: 201 },
      ),
    now: () => now,
  });
}

test("preserves only exact bounded Change failures across broker callback sanitization", async () => {
  const diagnostics = [{ code: "bounded-diagnostic", path: "execution", message: "Change failed safely." }] as never;
  const evidence = Object.freeze({ outcome: "recovery-required", testEvidence: "bounded" }) as never;
  const changeFailure = new ChangeTrustedExecutorError(
    "CHANGE_EXECUTION_RECOVERY_REQUIRED",
    "Change execution requires governed recovery.",
    diagnostics,
    evidence,
  );

  await assert.rejects(
    withChangeFailures((keep) =>
      broker().withRepositoryReadCapability({}, () =>
        keep(async () => {
          throw changeFailure;
        }),
      ),
    ),
    (error: unknown) => {
      assert.equal(error, changeFailure);
      return true;
    },
  );

  class ExtendedChangeTrustedExecutorError extends ChangeTrustedExecutorError {
    readonly providerSecret = "provider-secret-must-not-escape";
  }
  const unsafeFailure = new Error("raw provider detail with provider-secret-must-not-escape");
  const subclassFailure = new ExtendedChangeTrustedExecutorError("CHANGE_EXECUTION_EFFECT_FAILED", "extended failure");
  for (const callbackFailure of [unsafeFailure, subclassFailure]) {
    await assert.rejects(
      withChangeFailures((keep) =>
        broker().withRepositoryReadCapability({}, () =>
          keep(async () => {
            throw callbackFailure;
          }),
        ),
      ),
      (error: unknown) => {
        assert.ok(error instanceof GitHubAppCredentialBrokerError);
        assert.notEqual(error, callbackFailure);
        assert.doesNotMatch(error.message, /provider-secret-must-not-escape|installation-token-test-secret/iu);
        return true;
      },
    );
  }
});

test("configured Executor process wires exact task evidence through existing read route and denies missing custody", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-task-termination-process-"));
  const keyPath = path.join(root, "issuer.pem");
  const environment: NodeJS.ProcessEnv = {
    INARI_CONFIG_HOME: path.join(root, "config"),
    INARI_GITHUB_APP_ID: "218",
    INARI_GITHUB_APP_PRIVATE_KEY_FILE: keyPath,
  };
  await writeFile(keyPath, privateKeyPem, { mode: 0o600 });
  let server: Awaited<ReturnType<typeof startConfiguredLocalExecutor>>["server"] | undefined;
  try {
    await setupLocalExecutor(environment);
    const started = await startConfiguredLocalExecutor("0.14.1", environment);
    server = started.server;
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}/v1/evidence`;
    const authorization = {
      version: 1,
      kind: "implementation-authorization",
      contractVersion: 1,
      repository: { repositoryHost: "github.com", repositoryId: "123456789", repository: "acme/inari" },
      implementation: {
        repositoryHost: "github.com",
        repositoryId: "123456789",
        repository: "acme/inari",
        number: 1250,
      },
      base: { branch: "main", revision: "a".repeat(40), freshness: "fresh-1" },
      governedBodyDigest: "b".repeat(64),
    };
    const request = {
      version: 1,
      repository: { id: "123456789", name: "acme/inari" },
      authorityId: "runtime-test",
      issue: 1250,
      implementationIssue: 1250,
      taskTerminationAuthorization: authorization,
    };
    const send = (body: unknown) =>
      fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(
      (await send({ ...request, taskTerminationAuthorization: { ...authorization, base: {} } })).status,
      400,
    );
    const unavailable = await send(request);
    assert.equal(unavailable.status, 409);
    const result = (await unavailable.json()) as {
      readonly executorId?: string;
      readonly evidence?: unknown;
      readonly error?: { readonly code?: string };
    };
    assert.equal(result.evidence, undefined);
    assert.equal(result.executorId, undefined);
    assert.equal(result.error?.code, "EVIDENCE_UNAVAILABLE");
  } finally {
    if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
