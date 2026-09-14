/**
 * Signed, repository-persisted provenance for the initial Change issuance.
 *
 * The semantic payload is intentionally smaller than the Change execution
 * journal.  It is an offline-verifiable statement about the Change identity
 * and operation only; requester, lifecycle, provider, and recovery state stay
 * in their existing authorities.
 */

import { createPublicKey, sign as ed25519Sign, verify as ed25519Verify, type KeyObject } from "node:crypto";
import {
  assertDelegator,
  isDelegatorActive,
  MAX_DELEGATOR_ID_LENGTH,
  DELEGATOR_ID_PATTERN,
  type Delegator,
} from "./agent-authority/delegator.js";
import { exportDelegatorPublicKey, type DelegatorKeyPair } from "./agent-authority/delegator-key.js";
import { assertEd25519PublicJwk, type Ed25519PublicJwk } from "./agent-authority/ed25519-jwk.js";
import {
  base64UrlDecodeToBytes,
  base64UrlEncodeText,
  canonicalJsonString,
  isBase64UrlText,
  type CanonicalJsonValue,
} from "./agent-authority/codec.js";

export const CHANGE_PROVENANCE_RECORD_VERSION = 1 as const;
export const CHANGE_PROVENANCE_RECORD_OPERATION = "change.issue" as const;
export const CHANGE_PROVENANCE_RECORD_PATH_PREFIX = ".inari/provenance/" as const;
export const CHANGE_PROVENANCE_RECORD_PATH_SUFFIX = ".json" as const;
export const CHANGE_PROVENANCE_RECORD_SIGNATURE_ALGORITHM = "EdDSA" as const;
export const CHANGE_PROVENANCE_RECORD_SIGNATURE_TYPE = "inari-change-provenance+jws" as const;
export const CHANGE_PROVENANCE_RECORD_SIGNATURE_DOMAIN = "INARI-CHANGE-PROVENANCE-V1" as const;
export const MAX_CHANGE_PROVENANCE_ACTOR_NAME_LENGTH = 160 as const;

export const CHANGE_PROVENANCE_ACTOR_TYPES = Object.freeze(["user", "bot", "agent"] as const);
export type ChangeProvenanceActorType = (typeof CHANGE_PROVENANCE_ACTOR_TYPES)[number];

export interface ChangeProvenanceActor {
  readonly type: ChangeProvenanceActorType;
  /** Attribution only; this is never consulted for authorization. */
  readonly name: string;
}

export interface ChangeProvenancePayload {
  readonly version: typeof CHANGE_PROVENANCE_RECORD_VERSION;
  readonly rootIssue: number;
  readonly operation: typeof CHANGE_PROVENANCE_RECORD_OPERATION;
  readonly actor?: ChangeProvenanceActor;
}

export interface ChangeProvenanceSignatureEnvelope {
  readonly alg: typeof CHANGE_PROVENANCE_RECORD_SIGNATURE_ALGORITHM;
  readonly typ: typeof CHANGE_PROVENANCE_RECORD_SIGNATURE_TYPE;
  /** Delegator key identifier, not an actor identifier. */
  readonly kid: string;
  readonly value: string;
}

export type SignedChangeProvenanceRecord = ChangeProvenancePayload & {
  readonly signature: ChangeProvenanceSignatureEnvelope;
};

export interface ChangeProvenanceRecordValidationResult {
  readonly valid: boolean;
  readonly record?: SignedChangeProvenanceRecord;
  readonly diagnostics: readonly ChangeProvenanceRecordDiagnostic[];
}

export interface ChangeProvenanceRecordDiagnostic {
  readonly path: string;
  readonly message: string;
}

export type ChangeProvenanceRuntimeKey = KeyObject | DelegatorKeyPair;

export interface CreateChangeProvenanceRecordOptions {
  readonly rootIssue: number;
  readonly actor?: ChangeProvenanceActor;
  readonly runtimeAuthority: Delegator;
  readonly runtimeKey: ChangeProvenanceRuntimeKey;
  readonly now?: Date;
}

export type ChangeProvenanceErrorCode =
  | "CHANGE_PROVENANCE_RECORD_INVALID"
  | "CHANGE_PROVENANCE_RECORD_NONCANONICAL"
  | "CHANGE_PROVENANCE_RECORD_UNTRUSTED_KEY"
  | "CHANGE_PROVENANCE_RECORD_SIGNATURE_INVALID"
  | "CHANGE_PROVENANCE_RECORD_SIGNING_FAILED";

export class ChangeProvenanceRecordError extends Error {
  readonly code: ChangeProvenanceErrorCode;
  readonly diagnostics: readonly ChangeProvenanceRecordDiagnostic[];

  constructor(
    code: ChangeProvenanceErrorCode,
    message: string,
    diagnostics: readonly ChangeProvenanceRecordDiagnostic[] = [],
  ) {
    super(message);
    this.name = "ChangeProvenanceRecordError";
    this.code = code;
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

const PAYLOAD_KEYS = new Set(["version", "rootIssue", "operation", "actor"]);
const RECORD_KEYS = new Set([...PAYLOAD_KEYS, "signature"]);
const ACTOR_KEYS = new Set(["type", "name"]);
const SIGNATURE_KEYS = new Set(["alg", "typ", "kid", "value"]);
const SIGNATURE_BYTES = 64;
const SIGNATURE_TEXT_LENGTH = 86;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function unknownProperties(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: ChangeProvenanceRecordDiagnostic[],
): void {
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key)) diagnostics.push({ path: `${path}.${key}`, message: "Property is not accepted." });
  }
}

function validActor(
  value: unknown,
  path: string,
  diagnostics: ChangeProvenanceRecordDiagnostic[],
): ChangeProvenanceActor | undefined {
  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Actor must be an object." });
    return undefined;
  }
  unknownProperties(value, ACTOR_KEYS, path, diagnostics);
  if (!CHANGE_PROVENANCE_ACTOR_TYPES.includes(value.type as ChangeProvenanceActorType)) {
    diagnostics.push({ path: `${path}.type`, message: "Actor type is unsupported." });
  }
  if (
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    value.name.length > MAX_CHANGE_PROVENANCE_ACTOR_NAME_LENGTH ||
    !SAFE_TEXT.test(value.name)
  ) {
    diagnostics.push({ path: `${path}.name`, message: "Actor name is invalid." });
  }
  if (
    diagnostics.some(
      ({ path: diagnosticPath }) => diagnosticPath === `${path}.type` || diagnosticPath === `${path}.name`,
    ) ||
    typeof value.type !== "string" ||
    typeof value.name !== "string"
  ) {
    return undefined;
  }
  return Object.freeze({ type: value.type as ChangeProvenanceActorType, name: value.name });
}

function validPayload(
  value: unknown,
  path: string,
  diagnostics: ChangeProvenanceRecordDiagnostic[],
): ChangeProvenancePayload | undefined {
  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Provenance payload must be an object." });
    return undefined;
  }
  unknownProperties(value, RECORD_KEYS, path, diagnostics);
  if (value.version !== CHANGE_PROVENANCE_RECORD_VERSION) {
    diagnostics.push({ path: `${path}.version`, message: "Provenance record version is unsupported." });
  }
  if (typeof value.rootIssue !== "number" || !Number.isSafeInteger(value.rootIssue) || value.rootIssue < 1) {
    diagnostics.push({ path: `${path}.rootIssue`, message: "Root Issue must be a positive safe integer." });
  }
  if (value.operation !== CHANGE_PROVENANCE_RECORD_OPERATION) {
    diagnostics.push({ path: `${path}.operation`, message: "Provenance operation is unsupported." });
  }
  let actor: ChangeProvenanceActor | undefined;
  if (hasOwn(value, "actor")) actor = validActor(value.actor, `${path}.actor`, diagnostics);
  if (
    diagnostics.some(
      ({ path: diagnosticPath }) =>
        diagnosticPath === `${path}.version` ||
        diagnosticPath === `${path}.rootIssue` ||
        diagnosticPath === `${path}.operation`,
    ) ||
    typeof value.rootIssue !== "number"
  ) {
    return undefined;
  }
  return {
    version: CHANGE_PROVENANCE_RECORD_VERSION,
    rootIssue: value.rootIssue,
    operation: CHANGE_PROVENANCE_RECORD_OPERATION,
    ...(actor === undefined ? {} : { actor }),
  };
}

function validSignature(
  value: unknown,
  path: string,
  diagnostics: ChangeProvenanceRecordDiagnostic[],
): ChangeProvenanceSignatureEnvelope | undefined {
  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Signature envelope must be an object." });
    return undefined;
  }
  unknownProperties(value, SIGNATURE_KEYS, path, diagnostics);
  if (value.alg !== CHANGE_PROVENANCE_RECORD_SIGNATURE_ALGORITHM) {
    diagnostics.push({ path: `${path}.alg`, message: "Signature algorithm is unsupported." });
  }
  if (value.typ !== CHANGE_PROVENANCE_RECORD_SIGNATURE_TYPE) {
    diagnostics.push({ path: `${path}.typ`, message: "Signature type is unsupported." });
  }
  if (
    typeof value.kid !== "string" ||
    value.kid.length === 0 ||
    value.kid.length > MAX_DELEGATOR_ID_LENGTH ||
    !DELEGATOR_ID_PATTERN.test(value.kid) ||
    !SAFE_TEXT.test(value.kid)
  ) {
    diagnostics.push({ path: `${path}.kid`, message: "Signature key identifier is invalid." });
  }
  if (
    typeof value.value !== "string" ||
    value.value.length !== SIGNATURE_TEXT_LENGTH ||
    !isBase64UrlText(value.value)
  ) {
    diagnostics.push({ path: `${path}.value`, message: "Signature encoding is invalid." });
  } else {
    try {
      if (base64UrlDecodeToBytes(value.value).byteLength !== SIGNATURE_BYTES) {
        diagnostics.push({ path: `${path}.value`, message: "Signature length is invalid." });
      }
    } catch {
      diagnostics.push({ path: `${path}.value`, message: "Signature encoding is invalid." });
    }
  }
  if (
    diagnostics.some(({ path: diagnosticPath }) =>
      [`${path}.alg`, `${path}.typ`, `${path}.kid`, `${path}.value`].includes(diagnosticPath),
    ) ||
    typeof value.kid !== "string" ||
    typeof value.value !== "string"
  ) {
    return undefined;
  }
  return {
    alg: CHANGE_PROVENANCE_RECORD_SIGNATURE_ALGORITHM,
    typ: CHANGE_PROVENANCE_RECORD_SIGNATURE_TYPE,
    kid: value.kid,
    value: value.value,
  };
}

function payloadForRecord(record: SignedChangeProvenanceRecord): ChangeProvenancePayload {
  return {
    version: record.version,
    rootIssue: record.rootIssue,
    operation: record.operation,
    ...(record.actor === undefined ? {} : { actor: record.actor }),
  };
}

export function changeProvenanceRecordPath(rootIssue: number): string {
  if (!Number.isSafeInteger(rootIssue) || rootIssue < 1) {
    throw new ChangeProvenanceRecordError(
      "CHANGE_PROVENANCE_RECORD_INVALID",
      "Root Issue must be a positive safe integer.",
    );
  }
  return `${CHANGE_PROVENANCE_RECORD_PATH_PREFIX}${rootIssue}${CHANGE_PROVENANCE_RECORD_PATH_SUFFIX}`;
}

export function canonicalChangeProvenancePayload(payload: ChangeProvenancePayload): string {
  return canonicalJsonString(payload as unknown as CanonicalJsonValue);
}

export function canonicalChangeProvenanceRecord(record: SignedChangeProvenanceRecord): string {
  return canonicalJsonString(record as unknown as CanonicalJsonValue);
}

function signingInput(payload: ChangeProvenancePayload, authorityId: string): string {
  const header = canonicalJsonString({
    alg: CHANGE_PROVENANCE_RECORD_SIGNATURE_ALGORITHM,
    typ: CHANGE_PROVENANCE_RECORD_SIGNATURE_TYPE,
    kid: authorityId,
  });
  return `${CHANGE_PROVENANCE_RECORD_SIGNATURE_DOMAIN}.${base64UrlEncodeText(header)}.${base64UrlEncodeText(canonicalChangeProvenancePayload(payload))}`;
}

function assertRuntimeKeyMatchesAuthority(runtimeKey: ChangeProvenanceRuntimeKey, authority: Delegator): void {
  let publicKey: Ed25519PublicJwk;
  try {
    publicKey = exportDelegatorPublicKey(runtimeKey);
  } catch {
    throw new ChangeProvenanceRecordError("CHANGE_PROVENANCE_RECORD_SIGNING_FAILED", "Runtime signing key is invalid.");
  }
  if (publicKey.x !== authority.key.x) {
    throw new ChangeProvenanceRecordError(
      "CHANGE_PROVENANCE_RECORD_UNTRUSTED_KEY",
      "Runtime signing key does not match the repository trust anchor.",
    );
  }
}

export function createChangeProvenanceRecord(
  options: CreateChangeProvenanceRecordOptions,
): SignedChangeProvenanceRecord {
  const authority = assertDelegator(options.runtimeAuthority);
  const now = options.now ?? new Date();
  if (!isDelegatorActive(authority, now)) {
    throw new ChangeProvenanceRecordError(
      "CHANGE_PROVENANCE_RECORD_UNTRUSTED_KEY",
      "Runtime signing authority is inactive.",
    );
  }
  const diagnostics: ChangeProvenanceRecordDiagnostic[] = [];
  const actor = options.actor === undefined ? undefined : validActor(options.actor, "$.actor", diagnostics);
  if (!Number.isSafeInteger(options.rootIssue) || options.rootIssue < 1) {
    diagnostics.push({ path: "$.rootIssue", message: "Root Issue must be a positive safe integer." });
  }
  if (diagnostics.length > 0 || (actor === undefined && options.actor !== undefined)) {
    throw new ChangeProvenanceRecordError(
      "CHANGE_PROVENANCE_RECORD_INVALID",
      "Provenance payload is invalid.",
      diagnostics,
    );
  }
  assertRuntimeKeyMatchesAuthority(options.runtimeKey, authority);
  const payload: ChangeProvenancePayload = {
    version: CHANGE_PROVENANCE_RECORD_VERSION,
    rootIssue: options.rootIssue,
    operation: CHANGE_PROVENANCE_RECORD_OPERATION,
    ...(actor === undefined ? {} : { actor }),
  };
  let value: string;
  try {
    value = ed25519Sign(
      null,
      Buffer.from(signingInput(payload, authority.id), "utf8"),
      options.runtimeKey instanceof Object && "privateKey" in options.runtimeKey
        ? options.runtimeKey.privateKey
        : options.runtimeKey,
    ).toString("base64url");
  } catch {
    throw new ChangeProvenanceRecordError(
      "CHANGE_PROVENANCE_RECORD_SIGNING_FAILED",
      "Runtime provenance signing failed.",
    );
  }
  return Object.freeze({
    ...payload,
    signature: Object.freeze({
      alg: CHANGE_PROVENANCE_RECORD_SIGNATURE_ALGORITHM,
      typ: CHANGE_PROVENANCE_RECORD_SIGNATURE_TYPE,
      kid: authority.id,
      value,
    }),
  });
}

export function renderChangeProvenanceRecord(record: SignedChangeProvenanceRecord): string {
  const validation = validateChangeProvenanceRecord(record);
  if (!validation.valid || validation.record === undefined) {
    throw new ChangeProvenanceRecordError(
      "CHANGE_PROVENANCE_RECORD_INVALID",
      "Provenance record is invalid.",
      validation.diagnostics,
    );
  }
  return `${canonicalChangeProvenanceRecord(validation.record)}\n`;
}

export function validateChangeProvenanceRecord(input: unknown): ChangeProvenanceRecordValidationResult {
  const diagnostics: ChangeProvenanceRecordDiagnostic[] = [];
  if (!isRecord(input)) {
    return { valid: false, diagnostics: [{ path: "$", message: "Provenance record must be an object." }] };
  }
  unknownProperties(input, RECORD_KEYS, "$.record", diagnostics);
  const payload = validPayload(input, "$", diagnostics);
  const signature = validSignature(input.signature, "$.signature", diagnostics);
  if (payload === undefined || signature === undefined || diagnostics.length > 0) {
    return { valid: false, diagnostics: Object.freeze(diagnostics) };
  }
  return {
    valid: true,
    record: Object.freeze({ ...payload, signature: Object.freeze(signature) }),
    diagnostics: [],
  };
}

function parseCanonicalRecord(input: unknown): SignedChangeProvenanceRecord {
  if (typeof input === "string") {
    const canonicalSource = input.endsWith("\n") ? input.slice(0, -1) : input;
    let parsed: unknown;
    try {
      parsed = JSON.parse(canonicalSource) as unknown;
    } catch {
      throw new ChangeProvenanceRecordError("CHANGE_PROVENANCE_RECORD_INVALID", "Provenance record JSON is invalid.");
    }
    const validation = validateChangeProvenanceRecord(parsed);
    if (!validation.valid || validation.record === undefined) {
      throw new ChangeProvenanceRecordError(
        "CHANGE_PROVENANCE_RECORD_INVALID",
        "Provenance record is invalid.",
        validation.diagnostics,
      );
    }
    if (canonicalChangeProvenanceRecord(validation.record) !== canonicalSource) {
      throw new ChangeProvenanceRecordError(
        "CHANGE_PROVENANCE_RECORD_NONCANONICAL",
        "Provenance record JSON is not canonical.",
      );
    }
    return validation.record;
  }
  const validation = validateChangeProvenanceRecord(input);
  if (!validation.valid || validation.record === undefined) {
    throw new ChangeProvenanceRecordError(
      "CHANGE_PROVENANCE_RECORD_INVALID",
      "Provenance record is invalid.",
      validation.diagnostics,
    );
  }
  return validation.record;
}

export function verifyChangeProvenanceRecord(
  input: unknown,
  runtimeAuthorityInput: Delegator,
): ChangeProvenancePayload {
  const record = parseCanonicalRecord(input);
  const authority = assertDelegator(runtimeAuthorityInput);
  if (record.signature.kid !== authority.id) {
    throw new ChangeProvenanceRecordError(
      "CHANGE_PROVENANCE_RECORD_UNTRUSTED_KEY",
      "Provenance signature key is not the repository trust anchor.",
    );
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: assertEd25519PublicJwk(authority.key), format: "jwk" });
  } catch {
    throw new ChangeProvenanceRecordError(
      "CHANGE_PROVENANCE_RECORD_UNTRUSTED_KEY",
      "Repository trust anchor public key is invalid.",
    );
  }
  let valid = false;
  try {
    valid = ed25519Verify(
      null,
      Buffer.from(signingInput(payloadForRecord(record), authority.id), "utf8"),
      publicKey,
      base64UrlDecodeToBytes(record.signature.value),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new ChangeProvenanceRecordError(
      "CHANGE_PROVENANCE_RECORD_SIGNATURE_INVALID",
      "Provenance signature verification failed.",
    );
  }
  return payloadForRecord(record);
}

export function isChangeProvenanceRecordValid(input: unknown, runtimeAuthority: Delegator): boolean {
  try {
    verifyChangeProvenanceRecord(input, runtimeAuthority);
    return true;
  } catch {
    return false;
  }
}
