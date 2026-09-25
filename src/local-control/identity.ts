/** Stable local component identities and separately custodied Runtime Authority state. */

import { randomBytes } from "node:crypto";
import {
  DelegatorKeyError,
  exportDelegatorPublicKey,
  generateAndPersistDelegatorKeyPair,
  delegatorPublicKeyFingerprint,
  loadDelegatorKeyPair,
  type DelegatorKeyPair,
} from "../agent-authority/delegator-key.js";
import {
  createLocalPrivateFile,
  ensureLocalComponentDirectory,
  localComponentPath,
  readLocalJson,
  validateLocalAuthorityConfig,
  validateLocalComponentIdentity,
  writeLocalJson,
  LocalControlError,
  type LocalAuthorityConfig,
  type LocalConfigValidator,
} from "./config.js";

export type LocalIdentityKind = "admission" | "executor";

export interface LocalComponentIdentity {
  readonly version: 1;
  readonly id: string;
}

export interface LocalAuthoritySetupResult {
  readonly config: LocalAuthorityConfig;
  readonly configPath: string;
  readonly privateKeyPath: string;
}

function identityValidator(kind: LocalIdentityKind): LocalConfigValidator<LocalComponentIdentity> {
  return (value) => validateLocalComponentIdentity(value, kind);
}

function identityPrefix(kind: LocalIdentityKind): "adm_" | "exec_" {
  return kind === "admission" ? "adm_" : "exec_";
}

/** Create an opaque identity once, or return the exact previously persisted identity. */
export function ensureLocalComponentIdentity(
  kind: LocalIdentityKind,
  environment: NodeJS.ProcessEnv = process.env,
): LocalComponentIdentity {
  ensureLocalComponentDirectory(kind, environment);
  const validator = identityValidator(kind);
  const existing = readLocalJson(kind, "identity.json", validator, environment);
  if (existing !== undefined) return existing;
  const identity: LocalComponentIdentity = {
    version: 1,
    id: `${identityPrefix(kind)}${randomBytes(18).toString("base64url")}`,
  };
  return writeLocalJson(kind, "identity.json", identity, validator, environment);
}

/**
 * Select or create the local Runtime Authority key custody. The returned
 * descriptor contains only public key material; the private key remains in
 * authority/private-key.pem.
 */
export function setupLocalAuthority(environment: NodeJS.ProcessEnv = process.env): LocalAuthoritySetupResult {
  ensureLocalComponentDirectory("authority", environment);
  const privateKeyPath = localComponentPath("authority", "private-key.pem", environment);
  const configPath = localComponentPath("authority", "config.json", environment);
  const current = readLocalJson("authority", "config.json", validateLocalAuthorityConfig, environment);

  let pair: DelegatorKeyPair;
  try {
    pair = loadDelegatorKeyPair(privateKeyPath);
  } catch (error: unknown) {
    if (!(error instanceof DelegatorKeyError) || error.code !== "RUNTIME_AUTHORITY_KEY_NOT_FOUND") {
      throw new LocalControlError("LOCAL_CONTROL_UNSAFE_STORAGE", "Local Authority key could not be loaded safely.");
    }
    if (current !== undefined) {
      throw new LocalControlError(
        "LOCAL_CONTROL_CONFIG_CONFLICT",
        "Authority descriptor exists without its private key.",
      );
    }
    try {
      pair = generateAndPersistDelegatorKeyPair(privateKeyPath);
    } catch {
      throw new LocalControlError("LOCAL_CONTROL_STORAGE_FAILED", "Local Authority key could not be created safely.");
    }
  }

  const config: LocalAuthorityConfig = {
    version: 1,
    publicKey: exportDelegatorPublicKey(pair),
    publicKeyFingerprint: delegatorPublicKeyFingerprint(pair),
    privateKeyFile: "private-key.pem",
  };
  const selected = writeLocalJson("authority", "config.json", config, validateLocalAuthorityConfig, environment);
  return { config: selected, configPath, privateKeyPath };
}

const AUTHORITY_PRIVATE_KEY_FILE = "private-key.pem";

function authorityKeyError(message: string): LocalControlError {
  return new LocalControlError("LOCAL_CONTROL_CONFIG_CONFLICT", message);
}

/** Load a Runtime Authority key only when it matches the expected public fingerprint. */
function loadExpectedKey(filePath: string, expectedFingerprint: string): DelegatorKeyPair {
  let pair: DelegatorKeyPair;
  try {
    pair = loadDelegatorKeyPair(filePath);
  } catch {
    throw new LocalControlError("LOCAL_CONTROL_UNSAFE_STORAGE", "Runtime Authority key could not be loaded safely.");
  }
  if (delegatorPublicKeyFingerprint(pair) !== expectedFingerprint)
    throw authorityKeyError("Runtime Authority key does not match the adopted public fingerprint.");
  return pair;
}

/**
 * Copy an existing, safely stored Runtime Authority key into Authority-owned
 * custody (`authority/private-key.pem`). The source is verified against the
 * adopted public fingerprint first and is never moved or deleted. An existing
 * custody key is never replaced: it must already hold the same key. No key is
 * generated here.
 */
export function copyLocalAuthorityKey(
  sourcePath: string,
  expectedFingerprint: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const privateKeyPath = localComponentPath("authority", AUTHORITY_PRIVATE_KEY_FILE, environment);
  const source = loadExpectedKey(sourcePath, expectedFingerprint);
  const exported = source.privateKey.export({ format: "pem", type: "pkcs8" });
  if (typeof exported !== "string")
    throw new LocalControlError("LOCAL_CONTROL_STORAGE_FAILED", "Runtime Authority key could not be encoded.");
  createLocalPrivateFile("authority", AUTHORITY_PRIVATE_KEY_FILE, Buffer.from(exported, "utf8"), environment);
  loadExpectedKey(privateKeyPath, expectedFingerprint);
  return privateKeyPath;
}

/**
 * Create (or confirm) the public Authority custody descriptor for the key
 * already held in `authority/private-key.pem`. A descriptor for any other key
 * is a conflict; nothing is replaced and no key is generated.
 */
export function bindLocalAuthorityDescriptor(
  expectedFingerprint: string,
  environment: NodeJS.ProcessEnv = process.env,
): LocalAuthoritySetupResult {
  const privateKeyPath = localComponentPath("authority", AUTHORITY_PRIVATE_KEY_FILE, environment);
  const configPath = localComponentPath("authority", "config.json", environment);
  const pair = loadExpectedKey(privateKeyPath, expectedFingerprint);
  const config: LocalAuthorityConfig = {
    version: 1,
    publicKey: exportDelegatorPublicKey(pair),
    publicKeyFingerprint: expectedFingerprint,
    privateKeyFile: AUTHORITY_PRIVATE_KEY_FILE,
  };
  const selected = writeLocalJson("authority", "config.json", config, validateLocalAuthorityConfig, environment);
  return { config: selected, configPath, privateKeyPath };
}
