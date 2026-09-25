import { ExecutorCredentialStore } from "../credential-store.js";
import { localExecutorIssuerKeyStatus } from "../issuer-input.js";

/** Keep explicit operator paths; managed custody supplies only a file reference. */
export function issuerExecutionEnvironment(configId: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (localExecutorIssuerKeyStatus(environment) === "configured") return environment;
  const store = new ExecutorCredentialStore(environment);
  const current = store.current();
  if (
    current !== undefined &&
    (current.configId !== configId ||
      (environment.INARI_GITHUB_APP_ID !== undefined && environment.INARI_GITHUB_APP_ID !== current.appId))
  )
    throw new Error("Executor Issuer key binding does not match its configuration.");
  if (current !== undefined && !current.providerVerified)
    throw new Error("Executor Issuer key is stored but provider verification is pending.");
  return current === undefined
    ? environment
    : {
        ...environment,
        INARI_GITHUB_APP_ID: current.appId,
        INARI_GITHUB_APP_PRIVATE_KEY_FILE: store.keyPath(current),
      };
}
