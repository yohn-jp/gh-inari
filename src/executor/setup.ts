// Public Executor setup entry. Reference-only: its import closure never
// reaches Issuer key reading or parsing (see `./setup.test.ts`).
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  LocalControlError,
  LOCAL_CONFIG_VERSION,
  readLocalJson,
  resolveConfigHome,
  validateLocalExecutorConfig,
  configuredLocalRuntimeBindHost,
  writeLocalJson,
  type LocalExecutorConfig,
} from "../local-control/config.js";
import { LocalExecutorError } from "./errors.js";
import { requireIssuerReference } from "./issuer-input.js";

export { LocalExecutorError } from "./errors.js";
export { localExecutorAppId, localExecutorIssuerKeyStatus, type LocalExecutorIssuerKeyStatus } from "./issuer-input.js";

export const LOCAL_EXECUTOR_DEFAULT_PORT = 0;
export const LOCAL_EXECUTOR_CREDENTIAL_PROFILE = "default";
const EXECUTOR_CONFIG_PATH = "config.json";

export interface LocalExecutorSetupResult {
  readonly config: LocalExecutorConfig;
  readonly configPath: string;
}

function requireSupportedCredentialProfile(config: LocalExecutorConfig): LocalExecutorConfig {
  if (config.provider.credentialProfile !== LOCAL_EXECUTOR_CREDENTIAL_PROFILE) {
    throw new LocalExecutorError(
      "EXECUTOR_CREDENTIAL_PROFILE_UNSUPPORTED",
      "Executor configuration references an unsupported GitHub credential profile.",
    );
  }
  return config;
}

export async function setupLocalExecutor(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LocalExecutorSetupResult> {
  requireIssuerReference(environment);
  return ensureLocalExecutorConfiguration(environment);
}

/**
 * Create (or return) only the secret-free Executor configuration. Managed
 * Issuer key custody (#1114) binds the enrolled key to this configuration ID,
 * so enrollment needs it before any key exists; the operator key-reference
 * prerequisite of `setupLocalExecutor` does not apply to that path.
 */
export async function ensureLocalExecutorConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LocalExecutorSetupResult> {
  const configPath = path.join(resolveConfigHome(environment), "executor", EXECUTOR_CONFIG_PATH);
  const existing = readLocalJson("executor", EXECUTOR_CONFIG_PATH, validateLocalExecutorConfig, environment);
  const bindHost = configuredLocalRuntimeBindHost(environment);
  if (existing !== undefined) requireSupportedCredentialProfile(existing);
  if (existing !== undefined && existing.listen.host !== bindHost) {
    throw new LocalExecutorError(
      "EXECUTOR_BIND_POLICY_CONFLICT",
      "Executor bind policy conflicts with existing setup. Select the bind policy before setting up local components.",
    );
  }
  if (existing !== undefined) return { config: existing, configPath };

  const config: LocalExecutorConfig = {
    version: LOCAL_CONFIG_VERSION,
    id: `exec_${randomBytes(24).toString("base64url")}`,
    listen: { host: bindHost, port: LOCAL_EXECUTOR_DEFAULT_PORT },
    provider: { kind: "github", credentialProfile: LOCAL_EXECUTOR_CREDENTIAL_PROFILE },
  };
  try {
    return {
      config: writeLocalJson("executor", EXECUTOR_CONFIG_PATH, config, validateLocalExecutorConfig, environment),
      configPath,
    };
  } catch (error: unknown) {
    if (!(error instanceof LocalControlError) || error.code !== "LOCAL_CONTROL_CONFIG_CONFLICT") throw error;
    const raced = readLocalJson("executor", EXECUTOR_CONFIG_PATH, validateLocalExecutorConfig, environment);
    if (raced !== undefined) return { config: raced, configPath };
    throw error;
  }
}

/** Reads the persisted, secret-free Executor configuration written by setup. */
export function configuredLocalExecutor(environment: NodeJS.ProcessEnv = process.env): LocalExecutorConfig {
  const config = readLocalJson("executor", EXECUTOR_CONFIG_PATH, validateLocalExecutorConfig, environment);
  if (config === undefined) {
    throw new LocalExecutorError(
      "EXECUTOR_NOT_SETUP",
      "Local Executor is not set up. Run `inari executor setup` first.",
    );
  }
  return requireSupportedCredentialProfile(config);
}
