import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { ChangeTrustedExecutorError } from "../change-trusted-executor.js";
import {
  GITHUB_APP_REPOSITORY_READ_PERMISSIONS,
  GitHubAppCredentialBrokerError,
  GitHubAppInstallationCredentialBroker,
} from "../github/app-installation-credential-broker.js";
import { withChangeFailures } from "./execution.js";

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
