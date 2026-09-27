/** Runtime-owner custody of public local-operator identity keys. */

import { createHash, createPublicKey } from "node:crypto";
import { LocalControlError, readLocalJson, replaceLocalJsonIfCurrent, type LocalConfigValidator } from "./config.js";

export interface OperatorEd25519PublicKey {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
}

export interface ActiveOperatorKey {
  readonly keyId: string;
  readonly publicKey: OperatorEd25519PublicKey;
  readonly status: "active";
  readonly enrolledGeneration: number;
}

export interface RevokedOperatorKey {
  readonly keyId: string;
  readonly publicKey: OperatorEd25519PublicKey;
  readonly status: "revoked";
  readonly enrolledGeneration: number;
  readonly revokedGeneration: number;
}

export type OperatorKeyRecord = ActiveOperatorKey | RevokedOperatorKey;

export interface LocalOperatorKeyRegistry {
  readonly version: 1;
  readonly generation: number;
  readonly keys: readonly OperatorKeyRecord[];
}

const REGISTRY_PATH = "operator-keys/registry.json";
const KEY_ID = /^opk_[a-f0-9]{64}$/u;
const PUBLIC_KEY_BYTES = 32;

function invalid(message: string): LocalControlError {
  return new LocalControlError("LOCAL_CONTROL_INVALID_CONFIG", message);
}

function conflict(message: string): LocalControlError {
  return new LocalControlError("LOCAL_CONTROL_CONFIG_CONFLICT", message);
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(message);
  return value as Record<string, unknown>;
}

function closed(value: Record<string, unknown>, keys: readonly string[], message: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw invalid(message);
}

function generation(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1) throw invalid(message);
  return value;
}

function validatePublicKey(value: unknown): OperatorEd25519PublicKey {
  const candidate = record(value, "Local operator public key is invalid.");
  closed(candidate, ["kty", "crv", "x"], "Local operator public key has unsupported fields.");
  if (candidate.kty !== "OKP" || candidate.crv !== "Ed25519" || typeof candidate.x !== "string") {
    throw invalid("Local operator public key must be an Ed25519 public key.");
  }
  const encoded = candidate.x;
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) throw invalid("Local operator public key encoding is invalid.");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.byteLength !== PUBLIC_KEY_BYTES || bytes.toString("base64url") !== encoded) {
    throw invalid("Local operator public key encoding is invalid.");
  }
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: encoded }, format: "jwk" });
    const exported = key.export({ format: "jwk" });
    if (
      key.asymmetricKeyType !== "ed25519" ||
      exported.kty !== "OKP" ||
      exported.crv !== "Ed25519" ||
      exported.x !== encoded
    ) {
      throw invalid("Local operator public key is not a canonical Ed25519 key.");
    }
  } catch (error: unknown) {
    if (error instanceof LocalControlError) throw error;
    throw invalid("Local operator public key is not a valid Ed25519 key.");
  }
  return Object.freeze({ kty: "OKP", crv: "Ed25519", x: encoded });
}

/** Stable ID is the SHA-256 digest of the canonical 32-byte Ed25519 public key. */
export function operatorPublicKeyId(value: unknown): string {
  const publicKey = validatePublicKey(value);
  const bytes = Buffer.from(publicKey.x, "base64url");
  return `opk_${createHash("sha256").update(bytes).digest("hex")}`;
}

function validateKeyRecord(value: unknown, registryGeneration: number): OperatorKeyRecord {
  const candidate = record(value, "Local operator key record is invalid.");
  const status = candidate.status;
  const keys =
    status === "active"
      ? ["keyId", "publicKey", "status", "enrolledGeneration"]
      : status === "revoked"
        ? ["keyId", "publicKey", "status", "enrolledGeneration", "revokedGeneration"]
        : [];
  if (keys.length === 0) throw invalid("Local operator key status is invalid.");
  closed(candidate, keys, "Local operator key record has unsupported fields.");

  const publicKey = validatePublicKey(candidate.publicKey);
  const expectedId = operatorPublicKeyId(publicKey);
  if (candidate.keyId !== expectedId || typeof candidate.keyId !== "string" || !KEY_ID.test(candidate.keyId)) {
    throw invalid("Local operator key ID does not match its public key.");
  }
  const enrolledGeneration = generation(candidate.enrolledGeneration, "Local operator key generation is invalid.");
  if (enrolledGeneration > registryGeneration) throw invalid("Local operator key generation is ahead of the registry.");

  if (status === "active") {
    return Object.freeze({ keyId: expectedId, publicKey, status, enrolledGeneration });
  }
  const revokedGeneration = generation(candidate.revokedGeneration, "Local operator revocation generation is invalid.");
  if (revokedGeneration <= enrolledGeneration || revokedGeneration > registryGeneration) {
    throw invalid("Local operator revocation generation is inconsistent.");
  }
  return Object.freeze({ keyId: expectedId, publicKey, status: "revoked", enrolledGeneration, revokedGeneration });
}

export function validateLocalOperatorKeyRegistry(value: unknown): LocalOperatorKeyRegistry {
  const candidate = record(value, "Local operator key registry is invalid.");
  closed(candidate, ["version", "generation", "keys"], "Local operator key registry has unsupported fields.");
  if (candidate.version !== 1) throw invalid("Local operator key registry version is unsupported.");
  const registryGeneration = generation(candidate.generation, "Local operator key registry generation is invalid.");
  if (!Array.isArray(candidate.keys)) throw invalid("Local operator key registry keys are invalid.");

  const keys = candidate.keys.map((item) => validateKeyRecord(item, registryGeneration));
  const ids = new Set<string>();
  for (const key of keys) {
    if (ids.has(key.keyId)) throw invalid("Local operator key registry contains a duplicate key ID.");
    ids.add(key.keyId);
  }
  return Object.freeze({ version: 1, generation: registryGeneration, keys: Object.freeze(keys) });
}

const registryValidator: LocalConfigValidator<LocalOperatorKeyRegistry> = validateLocalOperatorKeyRegistry;

/** Fresh Runtime-owner registry read. Missing state stays missing; unsafe or invalid state throws. */
export function readLocalOperatorKeyRegistry(
  environment: NodeJS.ProcessEnv = process.env,
): LocalOperatorKeyRegistry | undefined {
  return readLocalJson("runtime", REGISTRY_PATH, registryValidator, environment);
}

function expectedGeneration(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1) {
    throw invalid("Expected local operator registry generation is invalid.");
  }
  return value;
}

function assertGenerationMatch(current: LocalOperatorKeyRegistry | undefined, expected: number | null): void {
  const actual = current?.generation ?? null;
  if (actual !== expected) throw conflict("Local operator key registry generation changed.");
}

function nextGeneration(current: LocalOperatorKeyRegistry | undefined): number {
  const next = (current?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(next)) throw conflict("Local operator key registry generation is exhausted.");
  return next;
}

/** Enroll only public key bytes; retrying the immediately preceding exact enrollment is idempotent. */
export function enrollLocalOperatorPublicKey(
  value: unknown,
  expectedGenerationValue: number | null,
  environment: NodeJS.ProcessEnv = process.env,
): LocalOperatorKeyRegistry {
  const expected = expectedGeneration(expectedGenerationValue);
  const publicKey = validatePublicKey(value);
  const keyId = operatorPublicKeyId(publicKey);
  const current = readLocalOperatorKeyRegistry(environment);
  const existingKey = current?.keys.find((key) => key.keyId === keyId);

  if (current !== undefined && existingKey !== undefined) {
    if (existingKey.publicKey.x !== publicKey.x)
      throw conflict("Local operator key ID is bound to different public bytes.");
    if (
      existingKey.status === "active" &&
      (current.generation === expected || existingKey.enrolledGeneration === (expected ?? 0) + 1)
    ) {
      return current;
    }
    throw conflict("Local operator key is already enrolled or revoked.");
  }

  assertGenerationMatch(current, expected);
  const enrolledGeneration = nextGeneration(current);
  const next = validateLocalOperatorKeyRegistry({
    version: 1,
    generation: enrolledGeneration,
    keys: [...(current?.keys ?? []), { keyId, publicKey, status: "active", enrolledGeneration }],
  });
  return replaceLocalJsonIfCurrent("runtime", REGISTRY_PATH, current, next, registryValidator, environment);
}

/** Revoke a registered key without deleting its identity or revocation evidence. */
export function revokeLocalOperatorPublicKey(
  keyId: string,
  expectedGenerationValue: number,
  environment: NodeJS.ProcessEnv = process.env,
): LocalOperatorKeyRegistry {
  const expected = expectedGeneration(expectedGenerationValue);
  if (expected === null) throw invalid("Expected local operator registry generation is invalid.");
  if (typeof keyId !== "string" || !KEY_ID.test(keyId)) throw invalid("Local operator key ID is invalid.");
  const current = readLocalOperatorKeyRegistry(environment);
  if (current === undefined) throw conflict("Local operator key registry is unavailable.");
  const existingKey = current.keys.find((key) => key.keyId === keyId);
  if (existingKey === undefined) throw conflict("Local operator key is not enrolled.");
  if (existingKey.status === "revoked") {
    if (existingKey.revokedGeneration === expected + 1 || current.generation === expected) return current;
    throw conflict("Local operator key registry generation changed.");
  }

  assertGenerationMatch(current, expected);
  const revokedGeneration = nextGeneration(current);
  const next = validateLocalOperatorKeyRegistry({
    version: 1,
    generation: revokedGeneration,
    keys: current.keys.map((key) =>
      key.keyId === keyId
        ? {
            keyId: key.keyId,
            publicKey: key.publicKey,
            status: "revoked",
            enrolledGeneration: key.enrolledGeneration,
            revokedGeneration,
          }
        : key,
    ),
  });
  return replaceLocalJsonIfCurrent("runtime", REGISTRY_PATH, current, next, registryValidator, environment);
}
