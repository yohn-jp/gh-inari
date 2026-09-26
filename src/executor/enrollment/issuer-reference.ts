import { readFileSync } from "node:fs";
import { ExecutorCredentialStore, issuerKeyFingerprint, type StoredIssuerKey } from "../credential-store.js";
import { adoptLegacyExecutorCustody } from "../credential-migration.js";
import { LocalExecutorError } from "../errors.js";
import { issuerKeyReference, localExecutorAppId, localExecutorIssuerKeyStatus } from "../issuer-input.js";

function bindingConflict(): LocalExecutorError {
  return new LocalExecutorError(
    "EXECUTOR_ISSUER_BINDING_CONFLICT",
    "The explicit Issuer App ID or private-key reference contradicts the managed Executor Issuer custody. Remove the override or enroll the key explicitly with `inari setup next`.",
  );
}

function explicitKeyFingerprint(environment: NodeJS.ProcessEnv): string {
  const reference = issuerKeyReference(environment);
  const file = reference.INARI_GITHUB_APP_PRIVATE_KEY_FILE ?? reference.GITHUB_APP_PRIVATE_KEY_FILE;
  try {
    return issuerKeyFingerprint(readFileSync(file ?? "", { flag: "r" }));
  } catch {
    throw new LocalExecutorError(
      "EXECUTOR_ISSUER_KEY_INVALID",
      "The explicit Issuer App private-key reference is not a readable RSA private key.",
    );
  }
}

/**
 * The one Issuer input the Executor starts with (#1178). Managed custody is
 * canonical once it exists: a fresh shell needs no App ID or key export. An
 * explicit operator override is accepted only when it names the same App and
 * the same key as the managed custody; any contradiction is a bounded
 * diagnostic, never a silent preference. Without managed custody the explicit
 * reference remains the legacy input.
 */
export function issuerExecutionEnvironment(configId: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const store = new ExecutorCredentialStore(environment);
  let current: StoredIssuerKey | undefined;
  try {
    current = store.current();
  } catch {
    throw new LocalExecutorError(
      "EXECUTOR_ISSUER_CUSTODY_UNAVAILABLE",
      "The managed Executor Issuer custody could not be read safely.",
    );
  }
  if (current === undefined) return environment;
  const explicitAppId = localExecutorAppId(environment);
  if (current.configId !== configId || (explicitAppId !== undefined && explicitAppId !== current.appId))
    throw bindingConflict();
  if (
    localExecutorIssuerKeyStatus(environment) === "configured" &&
    explicitKeyFingerprint(environment) !== current.fingerprint
  )
    throw bindingConflict();
  if (!current.providerVerified)
    throw new LocalExecutorError(
      "EXECUTOR_ISSUER_CUSTODY_UNVERIFIED",
      "The managed Executor Issuer key is stored but not yet verified for an App installation. Run `inari setup next` to bind the repository.",
    );
  // #1199: the Executor adopts legacy single-App custody and its bindings into
  // App-scoped custody before execution reads repository bindings.
  try {
    adoptLegacyExecutorCustody(environment);
  } catch {
    throw new LocalExecutorError(
      "EXECUTOR_ISSUER_CUSTODY_UNAVAILABLE",
      "The managed Executor Issuer custody could not be adopted safely.",
    );
  }
  const resolved: NodeJS.ProcessEnv = { ...environment };
  delete resolved.GITHUB_APP_ID;
  delete resolved.GITHUB_APP_PRIVATE_KEY_FILE;
  return { ...resolved, INARI_GITHUB_APP_ID: current.appId, INARI_GITHUB_APP_PRIVATE_KEY_FILE: store.keyPath(current) };
}
