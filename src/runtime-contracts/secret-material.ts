/**
 * Secret-free guarantee for generic setup JSON (#1098).
 *
 * Setup observations, actions, requests, results and journal entries are
 * ordinary JSON that may be rendered, logged, persisted or sent to a browser.
 * PEM blocks, provider tokens and private signing material never belong in
 * them; they cross only the owner-bound streaming enrollment port
 * (`enrollment.ts`). This module detects such material and bounds the JSON
 * shape; it never acquires, parses or stores a secret.
 */
import { RuntimeContractError } from "./errors.js";

export const MAX_SETUP_JSON_BYTES = 64 * 1024;
export const MAX_SETUP_JSON_DEPTH = 12;
export const MAX_SETUP_JSON_STRING_LENGTH = 4096;

export type SetupSecretMaterialKind = "pem-block" | "provider-token" | "private-jwk" | "secret-field";

export interface SetupSecretFinding {
  readonly kind: SetupSecretMaterialKind;
  /** JSON path of the offending member; the value itself is never reported. */
  readonly path: string;
}

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]{1,64}-----/u;
const PROVIDER_TOKEN =
  /(?:^|[^A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|v1\.[0-9a-f]{40})(?![A-Za-z0-9_])/u;
const BEARER_CREDENTIAL = /\b(?:bearer|token)\s+[A-Za-z0-9._~+/-]{20,}=*/iu;

/** Member names (case/separator-insensitive) that denote secret values. */
const SECRET_FIELD_NAMES = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "credential",
  "installationtoken",
  "password",
  "pem",
  "privatekey",
  "privatekeypem",
  "refreshtoken",
  "secret",
  "signingkey",
  "token",
  "webhooksecret",
]);

/** Private members of a JWK (RFC 7517/7518/8037). */
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"];

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function stringFinding(value: string, path: string): SetupSecretFinding | undefined {
  if (PEM_BLOCK.test(value)) return { kind: "pem-block", path };
  if (PROVIDER_TOKEN.test(value) || BEARER_CREDENTIAL.test(value)) return { kind: "provider-token", path };
  return undefined;
}

/**
 * Returns every secret-bearing location in `value`. Structure bounds are not
 * checked here; see `assertSecretFreeSetupJson`.
 */
export function findSetupSecretMaterial(value: unknown): readonly SetupSecretFinding[] {
  const findings: SetupSecretFinding[] = [];
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_SETUP_JSON_DEPTH) return;
    if (typeof node === "string") {
      const finding = stringFinding(node, path);
      if (finding !== undefined) findings.push(finding);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.kty === "string" && PRIVATE_JWK_MEMBERS.some((member) => member in record)) {
      findings.push({ kind: "private-jwk", path });
    }
    for (const [key, child] of Object.entries(record)) {
      const childPath = `${path}.${key}`;
      const keyFinding = stringFinding(key, childPath);
      if (keyFinding !== undefined) findings.push(keyFinding);
      if (SECRET_FIELD_NAMES.has(normalizeFieldName(key)) && child !== undefined && child !== null && child !== false) {
        findings.push({ kind: "secret-field", path: childPath });
        continue;
      }
      visit(child, childPath, depth + 1);
    }
  };
  visit(value, "$", 0);
  return findings;
}

function assertBoundedJson(value: unknown, path: string, depth: number): void {
  if (depth > MAX_SETUP_JSON_DEPTH) {
    throw new RuntimeContractError("RUNTIME_CONTRACT_TOO_LARGE", path, "setup JSON is nested too deeply.");
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RuntimeContractError("RUNTIME_CONTRACT_INVALID", path, "must be finite.");
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_SETUP_JSON_STRING_LENGTH) {
      throw new RuntimeContractError("RUNTIME_CONTRACT_TOO_LARGE", path, "string exceeds the setup JSON bound.");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertBoundedJson(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) assertBoundedJson(child, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new RuntimeContractError("RUNTIME_CONTRACT_INVALID", path, "must be plain JSON data.");
}

/**
 * Rejects non-JSON, oversized or secret-bearing setup data. Every setup
 * contract validator calls this before shape validation.
 */
export function assertSecretFreeSetupJson(value: unknown, path = "$"): void {
  assertBoundedJson(value, path, 0);
  const serialized = JSON.stringify(value) ?? "";
  if (Buffer.byteLength(serialized, "utf8") > MAX_SETUP_JSON_BYTES) {
    throw new RuntimeContractError("RUNTIME_CONTRACT_TOO_LARGE", path, "setup JSON exceeds the byte bound.");
  }
  const [finding] = findSetupSecretMaterial(value);
  if (finding !== undefined) {
    throw new RuntimeContractError(
      "RUNTIME_CONTRACT_SECRET_MATERIAL",
      finding.path.replace(/^\$/u, path),
      `setup JSON must not carry ${finding.kind}; use the owner enrollment port.`,
    );
  }
}
