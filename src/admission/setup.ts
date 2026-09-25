/**
 * Admission setup (#1107). Public Admission role entry for local setup: stable
 * configuration and the pinned public Runtime Authority trust. Setup holds no
 * provider credential and no private signing key; it only reads public
 * Authority and Executor configuration.
 */
import { validateDelegator, type Delegator } from "../agent-authority/delegator.js";
import { delegatorPublicKeyFingerprint } from "../agent-authority/delegator-key.js";
import { canonicalJsonString, type CanonicalJsonValue } from "../agent-authority/codec.js";
import { ensureLocalComponentIdentity } from "../local-control/identity.js";
import {
  configuredLocalRuntimeBindHost,
  ensureLocalComponentDirectory,
  LOCAL_CONFIG_VERSION,
  LocalControlError,
  readLocalJson,
  resolveConfigHome,
  validateLocalAdmissionConfig,
  validateLocalAuthorityConfig,
  validateLocalExecutorConfig,
  writeLocalJson,
  type LocalAdmissionConfig,
} from "../local-control/config.js";

export const LOCAL_ADMISSION_DEFAULT_PORT = 0;

const AUTHORITY_FILE = "runtime-authority.json";
const ADMISSION_CONFIG_FILE = "config.json";

export class LocalAdmissionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalAdmissionError";
    this.code = code;
  }
}

export interface LocalAdmissionSetupResult {
  readonly config: LocalAdmissionConfig;
  readonly configPath: string;
  readonly authorityPath: string;
}

/** Configured Admission state required to serve. */
export interface LocalAdmissionConfiguration {
  readonly config: LocalAdmissionConfig;
  readonly runtimeAuthority: Delegator;
}

function authorityValidator(value: unknown): Delegator {
  const result = validateDelegator(value);
  if (!result.valid || result.value === undefined)
    throw new LocalControlError("LOCAL_CONTROL_INVALID_CONFIG", "Public Runtime Authority trust is invalid.");
  return result.value;
}

function configuredAuthority(environment: NodeJS.ProcessEnv): Delegator {
  const value = readLocalJson("admission", AUTHORITY_FILE, authorityValidator, environment);
  if (value === undefined) throw new LocalAdmissionError("ADMISSION_NOT_SETUP", "Local Admission is not set up.");
  return value;
}

function configuredLocalAdmission(environment: NodeJS.ProcessEnv): LocalAdmissionConfig {
  const value = readLocalJson("admission", ADMISSION_CONFIG_FILE, validateLocalAdmissionConfig, environment);
  if (value === undefined) throw new LocalAdmissionError("ADMISSION_NOT_SETUP", "Run `inari admission setup` first.");
  return value;
}

/** Reads the set-up Admission configuration and pinned public Runtime Authority trust. */
export function readLocalAdmissionConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): LocalAdmissionConfiguration {
  const config = configuredLocalAdmission(environment);
  const runtimeAuthority = configuredAuthority(environment);
  return { config, runtimeAuthority };
}

/** Create stable local Admission configuration and pin public Runtime Authority trust. */
export function setupLocalAdmission(
  authorityInput: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): LocalAdmissionSetupResult {
  const authority = authorityValidator(authorityInput);
  const localAuthority = readLocalJson("authority", "config.json", validateLocalAuthorityConfig, environment);
  if (
    localAuthority === undefined ||
    localAuthority.publicKeyFingerprint !== delegatorPublicKeyFingerprint(authority.key)
  ) {
    throw new LocalAdmissionError(
      "ADMISSION_AUTHORITY_MISMATCH",
      "Public trust record does not match the configured local Runtime Authority key.",
    );
  }
  const executor = readLocalJson("executor", "config.json", validateLocalExecutorConfig, environment);
  if (executor === undefined) throw new LocalAdmissionError("EXECUTOR_NOT_SETUP", "Run `inari executor setup` first.");
  const bindHost = configuredLocalRuntimeBindHost(environment);
  if (executor.listen.host !== bindHost) {
    throw new LocalAdmissionError(
      "ADMISSION_BIND_POLICY_CONFLICT",
      "Admission and Executor bind policies must match. Select the bind policy before setting up local components.",
    );
  }
  ensureLocalComponentDirectory("admission", environment);
  const identity = ensureLocalComponentIdentity("admission", environment);
  const configPath = `${resolveConfigHome(environment)}/admission/${ADMISSION_CONFIG_FILE}`;
  const authorityPath = `${resolveConfigHome(environment)}/admission/${AUTHORITY_FILE}`;
  const existing = readLocalJson("admission", ADMISSION_CONFIG_FILE, validateLocalAdmissionConfig, environment);
  if (
    existing !== undefined &&
    (existing.id !== identity.id || existing.executor.id !== executor.id || existing.listen.host !== bindHost)
  ) {
    throw new LocalAdmissionError(
      "ADMISSION_CONFIG_CONFLICT",
      "Existing local Admission configuration conflicts with the selected bind policy or pinned component identities.",
    );
  }
  const config =
    existing ??
    writeLocalJson(
      "admission",
      ADMISSION_CONFIG_FILE,
      {
        version: LOCAL_CONFIG_VERSION,
        id: identity.id,
        listen: { host: bindHost, port: LOCAL_ADMISSION_DEFAULT_PORT },
        executor: { id: executor.id },
      },
      validateLocalAdmissionConfig,
      environment,
    );
  const pinnedAuthority = writeLocalJson("admission", AUTHORITY_FILE, authority, authorityValidator, environment);
  if (
    canonicalJsonString(pinnedAuthority as unknown as CanonicalJsonValue) !==
    canonicalJsonString(authority as unknown as CanonicalJsonValue)
  )
    throw new LocalAdmissionError(
      "ADMISSION_AUTHORITY_MISMATCH",
      "Existing Admission Authority trust conflicts with setup.",
    );
  return { config, configPath, authorityPath };
}
