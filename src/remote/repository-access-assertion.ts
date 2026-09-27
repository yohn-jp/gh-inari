/**
 * Closed v1 wire and cryptographic profile for caller-evidence assertions.
 * This module verifies only supplied keys and bindings. It does not resolve
 * issuer trust, consume replay identities, or grant Runtime authority.
 */

import { createHash, createPublicKey, sign as ed25519Sign, verify as ed25519Verify, type KeyObject } from "node:crypto";
import {
  base64UrlDecodeToBytes,
  base64UrlEncodeBytes,
  base64UrlEncodeText,
  canonicalJsonString,
  isBase64UrlText,
  type CanonicalJsonValue,
} from "../agent-authority/codec.js";
import { assertEd25519PublicJwk, type Ed25519PublicJwk } from "../agent-authority/ed25519-jwk.js";

export const REPOSITORY_ACCESS_ASSERTION_VERSION = 1 as const;
export const REPOSITORY_ACCESS_ASSERTION_TYPE = "inari-repository-access-assertion" as const;
export const REPOSITORY_ACCESS_ASSERTION_MAX_BYTES = 16 * 1024;
export const REPOSITORY_ACCESS_REQUEST_MAX_BYTES = 64 * 1024;
export const REPOSITORY_ACCESS_ASSERTION_MAX_VALIDITY_SECONDS = 120 as const;
export const REPOSITORY_ACCESS_ASSERTION_CLOCK_SKEW_SECONDS = 30 as const;
export const REPOSITORY_ACCESS_ELIGIBILITY_MAX_AGE_SECONDS = 120 as const;

const MAX_TEXT_LENGTH = 512;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_CANONICAL_VALUE_DEPTH = 32;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const OPERATION_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:[.-][A-Za-z][A-Za-z0-9]*)*$/u;
const OPAQUE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export type RepositoryAccessAssertionErrorCode =
  | "INVALID_INPUT"
  | "INVALID_KEY"
  | "INVALID_ASSERTION"
  | "INVALID_SIGNATURE"
  | "BINDING_MISMATCH"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "ELIGIBILITY_STALE";

const ERROR_MESSAGES: Readonly<Record<RepositoryAccessAssertionErrorCode, string>> = Object.freeze({
  INVALID_INPUT: "Repository Access Assertion input is invalid.",
  INVALID_KEY: "Repository Access Assertion key is invalid.",
  INVALID_ASSERTION: "Repository Access Assertion is invalid.",
  INVALID_SIGNATURE: "Repository Access Assertion signature is invalid.",
  BINDING_MISMATCH: "Repository Access Assertion binding does not match.",
  NOT_YET_VALID: "Repository Access Assertion is not yet valid.",
  EXPIRED: "Repository Access Assertion has expired.",
  ELIGIBILITY_STALE: "Repository Access Assertion eligibility evidence is stale.",
});

/** Stable, bounded diagnostics. No input, token, request body, or key is echoed. */
export class RepositoryAccessAssertionError extends Error {
  readonly code: RepositoryAccessAssertionErrorCode;

  constructor(code: RepositoryAccessAssertionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RepositoryAccessAssertionError";
    this.code = code;
  }
}

export interface RepositoryAccessRepositoryIdentity {
  readonly host: string;
  readonly id: string;
}

/** The complete semantic request, including mutation-relevant input. */
export interface RepositoryAccessSemanticRequest {
  readonly operation: string;
  readonly repository: RepositoryAccessRepositoryIdentity;
  readonly appId: string;
  readonly installationId: string;
  readonly target: CanonicalJsonValue;
  /** Use `null` when the operation has no body; it is still part of the digest. */
  readonly input: CanonicalJsonValue;
}

export interface RepositoryAccessAssertionSigningInput {
  readonly issuer: string;
  readonly issuerKeyId: string;
  readonly subject: { readonly provider: "github"; readonly host: string; readonly userId: string };
  readonly audience: string;
  readonly relayId: string;
  readonly repository: RepositoryAccessRepositoryIdentity;
  readonly appId: string;
  readonly installationId: string;
  readonly eligibilityObservedAt: number;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly assertionId: string;
  readonly requestId: string;
  readonly request: RepositoryAccessSemanticRequest;
}

export interface RepositoryAccessAssertionExpectedBindings {
  readonly issuer: string;
  readonly issuerKeyId: string;
  readonly subject: { readonly provider: "github"; readonly host: string; readonly userId: string };
  readonly audience: string;
  readonly relayId: string;
  readonly repository: RepositoryAccessRepositoryIdentity;
  readonly appId: string;
  readonly installationId: string;
  readonly request: RepositoryAccessSemanticRequest;
}

export interface VerifyRepositoryAccessAssertionOptions {
  /** Explicit key material supplied by the caller; this is not an issuer trust lookup. */
  readonly publicKey: KeyObject | Ed25519PublicJwk;
  readonly expected: RepositoryAccessAssertionExpectedBindings;
  /** Unix seconds; defaults to the current wall clock. */
  readonly now?: number;
}

/** Bounded caller evidence only. It is not a Runtime capability or grant. */
export interface VerifiedRepositoryAccessCallerEvidence {
  readonly version: typeof REPOSITORY_ACCESS_ASSERTION_VERSION;
  readonly issuer: string;
  readonly issuerKeyId: string;
  readonly subject: Readonly<{ provider: "github"; host: string; userId: string }>;
  readonly audience: string;
  readonly relayId: string;
  readonly repository: Readonly<RepositoryAccessRepositoryIdentity>;
  readonly appId: string;
  readonly installationId: string;
  readonly eligibilityObservedAt: number;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly assertionId: string;
  readonly requestId: string;
  readonly operation: string;
  readonly requestDigest: string;
}

/** Exact protected header schema for the closed v1 JWS profile. */
export interface RepositoryAccessAssertionHeader {
  readonly alg: "EdDSA";
  readonly typ: typeof REPOSITORY_ACCESS_ASSERTION_TYPE;
  readonly version: typeof REPOSITORY_ACCESS_ASSERTION_VERSION;
  readonly kid: string;
}

/** Exact signed payload schema for the closed v1 JWS profile. */
export interface RepositoryAccessAssertionPayload {
  readonly version: typeof REPOSITORY_ACCESS_ASSERTION_VERSION;
  readonly issuer: string;
  readonly subject: Readonly<{ provider: "github"; host: string; userId: string }>;
  readonly audience: string;
  readonly relayId: string;
  readonly repository: Readonly<RepositoryAccessRepositoryIdentity>;
  readonly app: Readonly<{ id: string }>;
  readonly installation: Readonly<{ id: string }>;
  readonly eligibility: Readonly<{ fact: "repository-access"; observedAt: number }>;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly assertionId: string;
  readonly requestId: string;
  readonly operation: string;
  readonly target: CanonicalJsonValue;
  readonly requestDigest: string;
}

function fail(code: RepositoryAccessAssertionErrorCode): never {
  throw new RepositoryAccessAssertionError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: RepositoryAccessAssertionErrorCode = "INVALID_ASSERTION",
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code);
  }
}

function assertPrintableText(value: unknown, maximum = MAX_TEXT_LENGTH): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    fail("INVALID_INPUT");
  }
}

function assertOpaqueIdentifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !OPAQUE_IDENTIFIER_PATTERN.test(value)
  ) {
    fail("INVALID_INPUT");
  }
}

function assertGithubId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !GITHUB_ID_PATTERN.test(value)) fail("INVALID_INPUT");
}

function assertHost(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 253 || value !== value.toLowerCase() || value.endsWith(".")) {
    fail("INVALID_INPUT");
  }
  const labels = value.split(".");
  if (labels.length < 2 || labels.some((label) => !HOST_LABEL_PATTERN.test(label))) fail("INVALID_INPUT");
}

function assertOperation(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_IDENTIFIER_LENGTH || !OPERATION_PATTERN.test(value)) {
    fail("INVALID_INPUT");
  }
}

function assertUnixSeconds(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("INVALID_INPUT");
}

function copyCanonicalValue(value: unknown, ancestors = new Set<object>(), depth = 0): CanonicalJsonValue {
  if (depth > MAX_CANONICAL_VALUE_DEPTH) fail("INVALID_INPUT");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail("INVALID_INPUT");
    return value;
  }
  if (typeof value !== "object") fail("INVALID_INPUT");
  if (ancestors.has(value)) fail("INVALID_INPUT");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail("INVALID_INPUT");
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key === "symbol" || (key !== "length" && !/^\d+$/u.test(key))))
        fail("INVALID_INPUT");
      const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
      const copied: CanonicalJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail("INVALID_INPUT");
        copied.push(copyCanonicalValue(descriptor.value, ancestors, depth + 1));
      }
      if (ownKeys.length !== value.length + 1) fail("INVALID_INPUT");
      return copied;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) fail("INVALID_INPUT");
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    const copied: Record<string, CanonicalJsonValue> = Object.create(null) as Record<string, CanonicalJsonValue>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") fail("INVALID_INPUT");
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail("INVALID_INPUT");
      copied[key] = copyCanonicalValue(descriptor.value, ancestors, depth + 1);
    }
    return copied;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalValue(value: unknown, maximumBytes: number): CanonicalJsonValue {
  let copied: CanonicalJsonValue;
  let encoded: string;
  try {
    copied = copyCanonicalValue(value);
    encoded = canonicalJsonString(copied);
  } catch (error) {
    if (error instanceof RepositoryAccessAssertionError) throw error;
    fail("INVALID_INPUT");
  }
  if (Buffer.byteLength(encoded, "utf8") > maximumBytes) fail("INVALID_INPUT");
  return JSON.parse(encoded) as CanonicalJsonValue;
}

function repositoryIdentity(value: unknown): RepositoryAccessRepositoryIdentity {
  if (!isRecord(value)) fail("INVALID_INPUT");
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "host") || !Object.hasOwn(value, "id")) {
    fail("INVALID_INPUT");
  }
  assertHost(value.host);
  assertGithubId(value.id);
  return Object.freeze({ host: value.host, id: value.id });
}

function normalizeRequest(input: unknown): RepositoryAccessSemanticRequest {
  if (!isRecord(input)) fail("INVALID_INPUT");
  const keys = ["operation", "repository", "appId", "installationId", "target", "input"] as const;
  assertExactKeys(input, keys, "INVALID_INPUT");
  assertOperation(input.operation);
  const repository = repositoryIdentity(input.repository);
  assertGithubId(input.appId);
  assertGithubId(input.installationId);
  const target = canonicalValue(input.target, REPOSITORY_ACCESS_REQUEST_MAX_BYTES);
  const body = canonicalValue(input.input, REPOSITORY_ACCESS_REQUEST_MAX_BYTES);
  return Object.freeze({
    operation: input.operation,
    repository,
    appId: input.appId,
    installationId: input.installationId,
    target,
    input: body,
  });
}

/** Canonical digest of the complete semantic request; its body is never copied into the assertion. */
export function repositoryAccessRequestDigest(request: RepositoryAccessSemanticRequest): string {
  let normalized: RepositoryAccessSemanticRequest;
  try {
    normalized = normalizeRequest(request);
  } catch (error) {
    if (error instanceof RepositoryAccessAssertionError) throw error;
    fail("INVALID_INPUT");
  }
  const canonical = canonicalJsonString(normalized as unknown as CanonicalJsonValue);
  if (Buffer.byteLength(canonical, "utf8") > REPOSITORY_ACCESS_REQUEST_MAX_BYTES) fail("INVALID_INPUT");
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function normalizeSigningInput(input: RepositoryAccessAssertionSigningInput): RepositoryAccessAssertionPayload {
  if (!isRecord(input as unknown)) fail("INVALID_INPUT");
  assertExactKeys(
    input as unknown as Record<string, unknown>,
    [
      "issuer",
      "issuerKeyId",
      "subject",
      "audience",
      "relayId",
      "repository",
      "appId",
      "installationId",
      "eligibilityObservedAt",
      "issuedAt",
      "notBefore",
      "expiresAt",
      "assertionId",
      "requestId",
      "request",
    ],
    "INVALID_INPUT",
  );
  assertPrintableText(input.issuer);
  assertOpaqueIdentifier(input.issuerKeyId);
  assertPrintableText(input.audience);
  assertOpaqueIdentifier(input.relayId);
  if (!isRecord(input.subject) || input.subject.provider !== "github") fail("INVALID_INPUT");
  assertExactKeys(input.subject, ["provider", "host", "userId"], "INVALID_INPUT");
  assertHost(input.subject.host);
  assertGithubId(input.subject.userId);
  const repository = repositoryIdentity(input.repository);
  const appId = input.appId;
  const installationId = input.installationId;
  assertGithubId(appId);
  assertGithubId(installationId);
  const request = normalizeRequest(input.request);
  if (
    input.subject.host !== repository.host ||
    request.repository.host !== repository.host ||
    request.repository.id !== repository.id ||
    request.appId !== appId ||
    request.installationId !== installationId
  ) {
    fail("BINDING_MISMATCH");
  }
  assertUnixSeconds(input.eligibilityObservedAt);
  assertUnixSeconds(input.issuedAt);
  assertUnixSeconds(input.notBefore);
  assertUnixSeconds(input.expiresAt);
  if (
    input.notBefore > input.issuedAt ||
    input.expiresAt <= input.notBefore ||
    input.expiresAt - input.notBefore > REPOSITORY_ACCESS_ASSERTION_MAX_VALIDITY_SECONDS
  ) {
    fail("INVALID_INPUT");
  }
  assertOpaqueIdentifier(input.assertionId);
  assertOpaqueIdentifier(input.requestId);
  const target = canonicalValue(request.target, REPOSITORY_ACCESS_ASSERTION_MAX_BYTES / 2);
  return Object.freeze({
    version: REPOSITORY_ACCESS_ASSERTION_VERSION,
    issuer: input.issuer,
    subject: Object.freeze({ provider: "github", host: input.subject.host, userId: input.subject.userId }),
    audience: input.audience,
    relayId: input.relayId,
    repository,
    app: Object.freeze({ id: appId }),
    installation: Object.freeze({ id: installationId }),
    eligibility: Object.freeze({ fact: "repository-access", observedAt: input.eligibilityObservedAt }),
    issuedAt: input.issuedAt,
    notBefore: input.notBefore,
    expiresAt: input.expiresAt,
    assertionId: input.assertionId,
    requestId: input.requestId,
    operation: request.operation,
    target,
    requestDigest: repositoryAccessRequestDigest(request),
  });
}

function assertPrivateEd25519Key(key: KeyObject): void {
  if (typeof key !== "object" || key === null || key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    fail("INVALID_KEY");
  }
}

function suppliedPublicEd25519Key(key: KeyObject | Ed25519PublicJwk): KeyObject {
  try {
    if (isRecord(key) && Object.hasOwn(key, "kty")) {
      return createPublicKey({ key: assertEd25519PublicJwk(key, "$.publicKey"), format: "jwk" });
    }
    const candidate = key as KeyObject;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      candidate.type !== "public" ||
      candidate.asymmetricKeyType !== "ed25519"
    ) {
      fail("INVALID_KEY");
    }
    return candidate;
  } catch {
    fail("INVALID_KEY");
  }
}

function signingHeader(keyId: string): RepositoryAccessAssertionHeader {
  return Object.freeze({
    alg: "EdDSA",
    typ: REPOSITORY_ACCESS_ASSERTION_TYPE,
    version: REPOSITORY_ACCESS_ASSERTION_VERSION,
    kid: keyId,
  });
}

/** Sign a canonical compact JWS with an explicitly supplied Hosted issuer key. */
export function signRepositoryAccessAssertion(
  input: RepositoryAccessAssertionSigningInput,
  privateKey: KeyObject,
): string {
  assertPrivateEd25519Key(privateKey);
  let payload: RepositoryAccessAssertionPayload;
  try {
    payload = normalizeSigningInput(input);
  } catch (error) {
    if (error instanceof RepositoryAccessAssertionError) throw error;
    fail("INVALID_INPUT");
  }
  const header = signingHeader(input.issuerKeyId);
  let encodedHeader: string;
  let encodedPayload: string;
  try {
    encodedHeader = base64UrlEncodeText(canonicalJsonString(header as unknown as CanonicalJsonValue));
    encodedPayload = base64UrlEncodeText(canonicalJsonString(payload as unknown as CanonicalJsonValue));
  } catch {
    fail("INVALID_INPUT");
  }
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  let signature: Buffer;
  try {
    signature = ed25519Sign(null, Buffer.from(signingInput, "utf8"), privateKey);
  } catch {
    fail("INVALID_KEY");
  }
  const compact = `${signingInput}.${base64UrlEncodeBytes(signature)}`;
  if (Buffer.byteLength(compact, "utf8") > REPOSITORY_ACCESS_ASSERTION_MAX_BYTES) fail("INVALID_INPUT");
  return compact;
}

function decodeCanonicalSegment(segment: string): unknown {
  let bytes: Buffer;
  try {
    bytes = base64UrlDecodeToBytes(segment);
  } catch {
    fail("INVALID_ASSERTION");
  }
  if (base64UrlEncodeBytes(bytes) !== segment) fail("INVALID_ASSERTION");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("INVALID_ASSERTION");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("INVALID_ASSERTION");
  }
  try {
    if (canonicalJsonString(parsed as CanonicalJsonValue) !== text) fail("INVALID_ASSERTION");
  } catch {
    fail("INVALID_ASSERTION");
  }
  return parsed;
}

function validateHeader(value: unknown): RepositoryAccessAssertionHeader {
  if (!isRecord(value)) fail("INVALID_ASSERTION");
  assertExactKeys(value, ["alg", "typ", "version", "kid"]);
  if (
    value.alg !== "EdDSA" ||
    value.typ !== REPOSITORY_ACCESS_ASSERTION_TYPE ||
    value.version !== REPOSITORY_ACCESS_ASSERTION_VERSION
  ) {
    fail("INVALID_ASSERTION");
  }
  try {
    assertOpaqueIdentifier(value.kid);
  } catch {
    fail("INVALID_ASSERTION");
  }
  return value as unknown as RepositoryAccessAssertionHeader;
}

function validatePayload(value: unknown): RepositoryAccessAssertionPayload {
  if (!isRecord(value)) fail("INVALID_ASSERTION");
  assertExactKeys(value, [
    "version",
    "issuer",
    "subject",
    "audience",
    "relayId",
    "repository",
    "app",
    "installation",
    "eligibility",
    "issuedAt",
    "notBefore",
    "expiresAt",
    "assertionId",
    "requestId",
    "operation",
    "target",
    "requestDigest",
  ]);
  if (value.version !== REPOSITORY_ACCESS_ASSERTION_VERSION) fail("INVALID_ASSERTION");
  try {
    assertPrintableText(value.issuer);
    assertPrintableText(value.audience);
    assertOpaqueIdentifier(value.relayId);
    assertOpaqueIdentifier(value.assertionId);
    assertOpaqueIdentifier(value.requestId);
    assertOperation(value.operation);
    if (!isRecord(value.subject)) fail("INVALID_ASSERTION");
    assertExactKeys(value.subject, ["provider", "host", "userId"]);
    if (value.subject.provider !== "github") fail("INVALID_ASSERTION");
    assertHost(value.subject.host);
    assertGithubId(value.subject.userId);
    const repository = repositoryIdentity(value.repository);
    if (value.subject.host !== repository.host) fail("INVALID_ASSERTION");
    if (!isRecord(value.app)) fail("INVALID_ASSERTION");
    assertExactKeys(value.app, ["id"]);
    assertGithubId(value.app.id);
    if (!isRecord(value.installation)) fail("INVALID_ASSERTION");
    assertExactKeys(value.installation, ["id"]);
    assertGithubId(value.installation.id);
    if (!isRecord(value.eligibility)) fail("INVALID_ASSERTION");
    assertExactKeys(value.eligibility, ["fact", "observedAt"]);
    if (value.eligibility.fact !== "repository-access") fail("INVALID_ASSERTION");
    assertUnixSeconds(value.eligibility.observedAt);
    assertUnixSeconds(value.issuedAt);
    assertUnixSeconds(value.notBefore);
    assertUnixSeconds(value.expiresAt);
    if (
      value.notBefore > value.issuedAt ||
      value.expiresAt <= value.notBefore ||
      value.expiresAt - value.notBefore > REPOSITORY_ACCESS_ASSERTION_MAX_VALIDITY_SECONDS
    ) {
      fail("INVALID_ASSERTION");
    }
    if (typeof value.requestDigest !== "string" || !SHA256_PATTERN.test(value.requestDigest)) {
      fail("INVALID_ASSERTION");
    }
    const target = canonicalValue(value.target, REPOSITORY_ACCESS_ASSERTION_MAX_BYTES / 2);
    return Object.freeze({
      version: REPOSITORY_ACCESS_ASSERTION_VERSION,
      issuer: value.issuer,
      subject: Object.freeze({
        provider: "github",
        host: value.subject.host,
        userId: value.subject.userId,
      }),
      audience: value.audience,
      relayId: value.relayId,
      repository,
      app: Object.freeze({ id: value.app.id }),
      installation: Object.freeze({ id: value.installation.id }),
      eligibility: Object.freeze({ fact: "repository-access", observedAt: value.eligibility.observedAt }),
      issuedAt: value.issuedAt,
      notBefore: value.notBefore,
      expiresAt: value.expiresAt,
      assertionId: value.assertionId,
      requestId: value.requestId,
      operation: value.operation,
      target,
      requestDigest: value.requestDigest,
    });
  } catch (error) {
    if (error instanceof RepositoryAccessAssertionError && error.code === "INVALID_ASSERTION") throw error;
    fail("INVALID_ASSERTION");
  }
}

function currentSeconds(now: number | undefined): number {
  if (now === undefined) return Math.floor(Date.now() / 1000);
  assertUnixSeconds(now);
  return now;
}

function assertExpected(
  expected: RepositoryAccessAssertionExpectedBindings,
  payload: RepositoryAccessAssertionPayload,
  header: RepositoryAccessAssertionHeader,
): void {
  if (!isRecord(expected)) fail("INVALID_INPUT");
  assertExactKeys(
    expected,
    ["issuer", "issuerKeyId", "subject", "audience", "relayId", "repository", "appId", "installationId", "request"],
    "INVALID_INPUT",
  );
  const request = normalizeRequest(expected.request);
  const repository = repositoryIdentity(expected.repository);
  assertPrintableText(expected.issuer);
  assertOpaqueIdentifier(expected.issuerKeyId);
  assertPrintableText(expected.audience);
  assertOpaqueIdentifier(expected.relayId);
  if (!isRecord(expected.subject) || expected.subject.provider !== "github") fail("INVALID_INPUT");
  assertExactKeys(expected.subject, ["provider", "host", "userId"], "INVALID_INPUT");
  assertHost(expected.subject.host);
  assertGithubId(expected.subject.userId);
  assertGithubId(expected.appId);
  assertGithubId(expected.installationId);
  if (expected.subject.host !== repository.host) fail("INVALID_INPUT");
  if (
    header.kid !== expected.issuerKeyId ||
    payload.issuer !== expected.issuer ||
    payload.subject.provider !== expected.subject.provider ||
    payload.subject.host !== expected.subject.host ||
    payload.subject.userId !== expected.subject.userId ||
    payload.audience !== expected.audience ||
    payload.relayId !== expected.relayId ||
    payload.repository.host !== repository.host ||
    payload.repository.id !== repository.id ||
    payload.app.id !== expected.appId ||
    payload.installation.id !== expected.installationId ||
    payload.operation !== request.operation ||
    canonicalJsonString(payload.target) !== canonicalJsonString(request.target) ||
    request.repository.host !== repository.host ||
    request.repository.id !== repository.id ||
    request.appId !== expected.appId ||
    request.installationId !== expected.installationId ||
    payload.requestDigest !== repositoryAccessRequestDigest(request)
  ) {
    fail("BINDING_MISMATCH");
  }
}

function assertTime(payload: RepositoryAccessAssertionPayload, now: number): void {
  const skew = REPOSITORY_ACCESS_ASSERTION_CLOCK_SKEW_SECONDS;
  if (payload.issuedAt > now + skew || payload.notBefore > now + skew) fail("NOT_YET_VALID");
  if (payload.expiresAt + skew <= now) fail("EXPIRED");
  if (payload.eligibility.observedAt > now + skew) fail("NOT_YET_VALID");
  if (now - payload.eligibility.observedAt > REPOSITORY_ACCESS_ELIGIBILITY_MAX_AGE_SECONDS) {
    fail("ELIGIBILITY_STALE");
  }
}

/** Verify a supplied assertion against explicit key material and exact caller bindings. */
export function verifyRepositoryAccessAssertion(
  compact: unknown,
  options: VerifyRepositoryAccessAssertionOptions,
): VerifiedRepositoryAccessCallerEvidence {
  if (!isRecord(options)) fail("INVALID_INPUT");
  const expectedOptionKeys = Object.hasOwn(options, "now")
    ? ["publicKey", "expected", "now"]
    : ["publicKey", "expected"];
  assertExactKeys(options, expectedOptionKeys, "INVALID_INPUT");
  if (
    typeof compact !== "string" ||
    Buffer.byteLength(compact, "utf8") === 0 ||
    Buffer.byteLength(compact, "utf8") > REPOSITORY_ACCESS_ASSERTION_MAX_BYTES
  ) {
    fail("INVALID_ASSERTION");
  }
  const segments = compact.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0 || !isBase64UrlText(segment))) {
    fail("INVALID_ASSERTION");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
  const header = validateHeader(decodeCanonicalSegment(encodedHeader));
  const payload = validatePayload(decodeCanonicalSegment(encodedPayload));
  let signature: Buffer;
  try {
    signature = base64UrlDecodeToBytes(encodedSignature);
  } catch {
    fail("INVALID_ASSERTION");
  }
  if (base64UrlEncodeBytes(signature) !== encodedSignature || signature.length !== 64) fail("INVALID_ASSERTION");
  const publicKey = suppliedPublicEd25519Key(options.publicKey);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  let signatureValid = false;
  try {
    signatureValid = ed25519Verify(null, Buffer.from(signingInput, "utf8"), publicKey, signature);
  } catch {
    fail("INVALID_KEY");
  }
  if (!signatureValid) fail("INVALID_SIGNATURE");
  assertExpected(options.expected, payload, header);
  assertTime(payload, currentSeconds(options.now));
  return Object.freeze({
    version: REPOSITORY_ACCESS_ASSERTION_VERSION,
    issuer: payload.issuer,
    issuerKeyId: header.kid,
    subject: payload.subject,
    audience: payload.audience,
    relayId: payload.relayId,
    repository: payload.repository,
    appId: payload.app.id,
    installationId: payload.installation.id,
    eligibilityObservedAt: payload.eligibility.observedAt,
    issuedAt: payload.issuedAt,
    notBefore: payload.notBefore,
    expiresAt: payload.expiresAt,
    assertionId: payload.assertionId,
    requestId: payload.requestId,
    operation: payload.operation,
    requestDigest: payload.requestDigest,
  });
}
