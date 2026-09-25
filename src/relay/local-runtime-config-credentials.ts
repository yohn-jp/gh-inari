import { readFileSync } from "node:fs";

const MAX_APP_PRIVATE_KEY_BYTES = 64 * 1024;

export type LocalRuntimeConfigErrorCode =
  | "LOCAL_RUNTIME_CONFIG_MISSING"
  | "LOCAL_RUNTIME_CONFIG_INVALID"
  | "LOCAL_RUNTIME_CONFIG_FILE_UNREADABLE"
  | "LOCAL_RUNTIME_CONFIG_PROVIDER_FAILED";

/** Diagnostics for local Runtime configuration never contain credential values. */
export class LocalRuntimeConfigError extends Error {
  readonly code: LocalRuntimeConfigErrorCode;
  readonly path?: string;

  constructor(code: LocalRuntimeConfigErrorCode, message: string, optionPath?: string) {
    super(message);
    this.name = "LocalRuntimeConfigError";
    this.code = code;
    this.path = optionPath;
  }
}

export interface LocalRuntimeConfigEnvironment {
  readonly [key: string]: string | undefined;
}

function missing(name: string, optionPath: string): LocalRuntimeConfigError {
  return new LocalRuntimeConfigError("LOCAL_RUNTIME_CONFIG_MISSING", `${name} is required.`, optionPath);
}

function invalid(message: string, optionPath: string): LocalRuntimeConfigError {
  return new LocalRuntimeConfigError("LOCAL_RUNTIME_CONFIG_INVALID", message, optionPath);
}

export function environmentValue(
  environment: LocalRuntimeConfigEnvironment,
  ...names: readonly string[]
): string | undefined {
  for (const name of names) {
    const value = environment[name];
    if (value !== undefined && value.trim().length > 0) return value;
  }
  return undefined;
}

/** Read the configured GitHub App private key without retaining or logging it. */
export function readAppPrivateKey(environment: LocalRuntimeConfigEnvironment): string {
  const direct = environmentValue(environment, "INARI_GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_PRIVATE_KEY");
  if (direct !== undefined) {
    const pem = direct.replace(/\\n/gu, "\n");
    if (Buffer.byteLength(pem, "utf8") > MAX_APP_PRIVATE_KEY_BYTES)
      throw invalid("GitHub App private key is too large.", "$environment.GITHUB_APP_PRIVATE_KEY");
    return pem;
  }
  const filePath = environmentValue(environment, "INARI_GITHUB_APP_PRIVATE_KEY_FILE", "GITHUB_APP_PRIVATE_KEY_FILE");
  if (filePath === undefined) throw missing("GitHub App private key", "$environment.GITHUB_APP_PRIVATE_KEY");
  try {
    const pem = readFileSync(filePath, "utf8");
    if (Buffer.byteLength(pem, "utf8") > MAX_APP_PRIVATE_KEY_BYTES)
      throw invalid("GitHub App private key is too large.", "$environment.GITHUB_APP_PRIVATE_KEY_FILE");
    return pem;
  } catch (error: unknown) {
    if (error instanceof LocalRuntimeConfigError) throw error;
    throw new LocalRuntimeConfigError(
      "LOCAL_RUNTIME_CONFIG_FILE_UNREADABLE",
      "GitHub App private key file cannot be read.",
      "$environment.GITHUB_APP_PRIVATE_KEY_FILE",
    );
  }
}
