// Private Executor module: reference-only Issuer inputs. It names the Issuer
// App ID and the private-key file reference, and never opens the key file or
// parses key material. Setup and status projections depend on this module;
// the key itself is read only in `./execution.ts`.
import { LocalExecutorError } from "./errors.js";

export type LocalExecutorIssuerKeyStatus = "configured" | "missing";

/**
 * Local Executor custody is a file reference only. Inline PEM variables
 * (INARI_GITHUB_APP_PRIVATE_KEY / GITHUB_APP_PRIVATE_KEY) would place key
 * material in CLI process environments and are not accepted here.
 */
export const ISSUER_KEY_REFERENCE_VARIABLES = [
  "INARI_GITHUB_APP_PRIVATE_KEY_FILE",
  "GITHUB_APP_PRIVATE_KEY_FILE",
] as const;

export function localExecutorAppId(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = environment.INARI_GITHUB_APP_ID ?? environment.GITHUB_APP_ID;
  if (value === undefined || !/^[1-9][0-9]{0,19}$/u.test(value.trim())) return undefined;
  return value.trim();
}

export function requireLocalExecutorAppId(environment: NodeJS.ProcessEnv): string {
  const value = localExecutorAppId(environment);
  if (value === undefined) {
    throw new LocalExecutorError(
      "EXECUTOR_PROVIDER_CONFIGURATION_MISSING",
      "Set INARI_GITHUB_APP_ID (or GITHUB_APP_ID) to the numeric App ID shown by `inari setup` before configuring the local Executor.",
    );
  }
  return value;
}

export function issuerKeyMissing(): LocalExecutorError {
  return new LocalExecutorError(
    "EXECUTOR_ISSUER_KEY_MISSING",
    "The local Executor mints Inari Issuer App installation credentials. Set INARI_GITHUB_APP_PRIVATE_KEY_FILE to the path of the Issuer App private key (.pem) before configuring the local Executor; only the running Executor reads the key, and it is never persisted.",
  );
}

/**
 * Whether an Executor-owned Issuer App private-key reference is configured.
 * This inspects only which custody variable is set; it never opens the key
 * file or parses key material, so CLI, setup, and browser projections stay
 * outside the Executor credential boundary.
 */
export function localExecutorIssuerKeyStatus(
  environment: NodeJS.ProcessEnv = process.env,
): LocalExecutorIssuerKeyStatus {
  return ISSUER_KEY_REFERENCE_VARIABLES.some((name) => (environment[name]?.trim().length ?? 0) > 0)
    ? "configured"
    : "missing";
}

/** Only the Issuer key file reference variables, so inline PEM variables are never used. */
export function issuerKeyReference(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const reference: NodeJS.ProcessEnv = {};
  for (const name of ISSUER_KEY_REFERENCE_VARIABLES) {
    if (environment[name] !== undefined) reference[name] = environment[name];
  }
  return reference;
}

/** Non-secret setup prerequisites: App ID and the Issuer key reference only. */
export function requireIssuerReference(environment: NodeJS.ProcessEnv): void {
  requireLocalExecutorAppId(environment);
  if (localExecutorIssuerKeyStatus(environment) === "missing") throw issuerKeyMissing();
}
