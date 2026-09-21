/**
 * Transport-neutral authorization for an enrolled Inari Endpoint.
 *
 * This module is deliberately an evidence boundary, not a transport
 * authenticator. Webhook signature verification, human authentication, and
 * Session/App verification happen at their owning adapters. They provide
 * verified evidence here; this module only validates the closed contract,
 * binds the endpoint/install/repository context, and checks an explicitly
 * declared semantic capability.
 */

import {
  validateCapabilityClaim,
  type CapabilityClaim,
  type CapabilityDiagnostic,
  type CapabilityKind,
} from "./agent-authority/capability.js";
import { validateRepositoryIdentity, type RepositoryIdentity } from "./github/effect-authorizer.js";

export const ENDPOINT_AUTHORIZATION_CONTRACT_VERSION = 1 as const;
export type EndpointAuthorizationContractVersion = typeof ENDPOINT_AUTHORIZATION_CONTRACT_VERSION;

export const ENDPOINT_PRINCIPAL_KINDS = Object.freeze(["human", "runtime/client", "webhook-delivery"] as const);
export type EndpointPrincipalKind = (typeof ENDPOINT_PRINCIPAL_KINDS)[number];

export const ENDPOINT_DEPLOYMENT_KINDS = Object.freeze(["shared-hosted", "self-hosted"] as const);
export type EndpointDeploymentKind = (typeof ENDPOINT_DEPLOYMENT_KINDS)[number];

/** Endpoint authorization composes the existing Core semantic capability vocabulary. */
export type EndpointCapability = CapabilityClaim;
export type EndpointCapabilityKind = CapabilityKind;

export interface HumanEndpointPrincipal {
  readonly version: EndpointAuthorizationContractVersion;
  readonly kind: "human";
  /** Stable authenticated human identifier; display names are not authority. */
  readonly id: string;
}

export interface RuntimeClientEndpointPrincipal {
  readonly version: EndpointAuthorizationContractVersion;
  readonly kind: "runtime/client";
  /** Stable Runtime/client identifier; transport connection identity is not enough. */
  readonly id: string;
}

export interface WebhookDeliveryEndpointPrincipal {
  readonly version: EndpointAuthorizationContractVersion;
  readonly kind: "webhook-delivery";
  /** Verified GitHub delivery identifier for this webhook principal. */
  readonly id: string;
}

export type EndpointPrincipal =
  HumanEndpointPrincipal | RuntimeClientEndpointPrincipal | WebhookDeliveryEndpointPrincipal;

export interface EndpointIdentity {
  readonly version: EndpointAuthorizationContractVersion;
  readonly kind: "endpoint";
  /** Stable logical Endpoint identity, independent of transport URL. */
  readonly id: string;
  /** Deployment mode is descriptive; both modes use this same contract. */
  readonly deployment: EndpointDeploymentKind;
}

export interface EndpointInstallationIdentity {
  readonly version: EndpointAuthorizationContractVersion;
  readonly kind: "installation";
  readonly endpointId: string;
  /** Immutable GitHub App installation identifier. */
  readonly installationId: string;
}

/** Repository owner/name is retained for diagnostics; host + immutable ID bind authority. */
export interface EndpointRepositoryIdentity extends RepositoryIdentity {
  readonly version: EndpointAuthorizationContractVersion;
  readonly kind: "repository";
  readonly endpointId: string;
  readonly installationId: string;
}

export interface EndpointAuthorizationEvidence {
  readonly version: EndpointAuthorizationContractVersion;
  /** The adapter has completed its own authentication/verification boundary. */
  readonly authenticated: true;
  readonly principal: EndpointPrincipal;
  readonly endpoint: EndpointIdentity;
  readonly installation: EndpointInstallationIdentity;
  readonly repository: EndpointRepositoryIdentity;
  /** Explicit capabilities admitted by the owning authority. */
  readonly capabilities: readonly EndpointCapability[];
}

export interface EndpointAuthorizationRequest {
  readonly version: EndpointAuthorizationContractVersion;
  readonly principal: EndpointPrincipal;
  readonly endpoint: EndpointIdentity;
  readonly installation: EndpointInstallationIdentity;
  readonly repository: EndpointRepositoryIdentity;
  readonly capability: EndpointCapability;
  /** Authenticated evidence is intentionally supplied separately from the target. */
  readonly evidence: EndpointAuthorizationEvidence;
}

export type EndpointAuthorizationDiagnosticCode =
  | "ENDPOINT_AUTHORIZATION_INVALID_ROOT"
  | "ENDPOINT_AUTHORIZATION_MISSING_PROPERTY"
  | "ENDPOINT_AUTHORIZATION_UNKNOWN_PROPERTY"
  | "ENDPOINT_AUTHORIZATION_UNSUPPORTED_VERSION"
  | "ENDPOINT_AUTHORIZATION_INVALID_PRINCIPAL"
  | "ENDPOINT_AUTHORIZATION_INVALID_ENDPOINT"
  | "ENDPOINT_AUTHORIZATION_INVALID_INSTALLATION"
  | "ENDPOINT_AUTHORIZATION_INVALID_REPOSITORY"
  | "ENDPOINT_AUTHORIZATION_INVALID_CAPABILITY"
  | "ENDPOINT_AUTHORIZATION_UNKNOWN_CAPABILITY"
  | "ENDPOINT_AUTHORIZATION_UNAUTHENTICATED"
  | "ENDPOINT_AUTHORIZATION_ENDPOINT_MISMATCH"
  | "ENDPOINT_AUTHORIZATION_INSTALLATION_MISMATCH"
  | "ENDPOINT_AUTHORIZATION_REPOSITORY_MISMATCH"
  | "ENDPOINT_AUTHORIZATION_PRINCIPAL_MISMATCH"
  | "ENDPOINT_AUTHORIZATION_CAPABILITY_DENIED";

export interface EndpointAuthorizationDiagnostic {
  readonly version: EndpointAuthorizationContractVersion;
  readonly code: EndpointAuthorizationDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface EndpointAuthorizationValidationResult<T> {
  readonly valid: boolean;
  readonly value?: T;
  readonly diagnostics: readonly EndpointAuthorizationDiagnostic[];
}

export type EndpointAuthorizationDenyReason =
  | "invalid-evidence"
  | "unauthenticated"
  | "principal-mismatch"
  | "endpoint-mismatch"
  | "installation-mismatch"
  | "repository-mismatch"
  | "capability-denied";

export interface EndpointAuthorizationResult {
  readonly version: EndpointAuthorizationContractVersion;
  readonly allowed: boolean;
  readonly decision: "allow" | "deny";
  readonly reason?: EndpointAuthorizationDenyReason;
  readonly diagnostics: readonly EndpointAuthorizationDiagnostic[];
  readonly request?: EndpointAuthorizationRequest;
}

const PRINCIPAL_KEYS = new Set(["version", "kind", "id"]);
const ENDPOINT_KEYS = new Set(["version", "kind", "id", "deployment"]);
const INSTALLATION_KEYS = new Set(["version", "kind", "endpointId", "installationId"]);
const REPOSITORY_KEYS = new Set([
  "version",
  "kind",
  "endpointId",
  "installationId",
  "repositoryHost",
  "repositoryId",
  "nameWithOwner",
]);
const EVIDENCE_KEYS = new Set([
  "version",
  "authenticated",
  "principal",
  "endpoint",
  "installation",
  "repository",
  "capabilities",
]);
const REQUEST_KEYS = new Set([
  "version",
  "principal",
  "endpoint",
  "installation",
  "repository",
  "capability",
  "evidence",
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_DIAGNOSTICS = 32;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function diagnostic(
  code: EndpointAuthorizationDiagnosticCode,
  path: string,
  message: string,
): EndpointAuthorizationDiagnostic {
  return { version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION, code, path, message };
}

function uniqueDiagnostics(
  diagnostics: readonly EndpointAuthorizationDiagnostic[],
): readonly EndpointAuthorizationDiagnostic[] {
  const seen = new Set<string>();
  const result: EndpointAuthorizationDiagnostic[] = [];
  for (const entry of diagnostics) {
    const key = `${entry.code}\u0000${entry.path}\u0000${entry.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
    if (result.length === MAX_DIAGNOSTICS) break;
  }
  return Object.freeze(result);
}

function addUnknownProperties(
  value: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: EndpointAuthorizationDiagnostic[],
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      diagnostics.push(
        diagnostic(
          "ENDPOINT_AUTHORIZATION_UNKNOWN_PROPERTY",
          typeof key === "string" ? `${path}.${key}` : path,
          "Property is not accepted by the closed Endpoint authorization contract.",
        ),
      );
    }
  }
}

function requireProperty(
  value: RecordValue,
  key: string,
  path: string,
  diagnostics: EndpointAuthorizationDiagnostic[],
): boolean {
  if (hasOwn(value, key)) return true;
  diagnostics.push(
    diagnostic("ENDPOINT_AUTHORIZATION_MISSING_PROPERTY", `${path}.${key}`, "Required property is missing."),
  );
  return false;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function invalidRoot(path: string): EndpointAuthorizationValidationResult<never> {
  return {
    valid: false,
    diagnostics: [
      diagnostic("ENDPOINT_AUTHORIZATION_INVALID_ROOT", path, "Endpoint authorization values must be plain objects."),
    ],
  };
}

function normalizePrincipal(value: unknown, path: string): EndpointAuthorizationValidationResult<EndpointPrincipal> {
  if (!isRecord(value)) return invalidRoot(path);
  const diagnostics: EndpointAuthorizationDiagnostic[] = [];
  addUnknownProperties(value, PRINCIPAL_KEYS, path, diagnostics);
  if (!requireProperty(value, "version", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (value.version !== ENDPOINT_AUTHORIZATION_CONTRACT_VERSION) {
    diagnostics.push(
      diagnostic("ENDPOINT_AUTHORIZATION_UNSUPPORTED_VERSION", `${path}.version`, "Contract version is unsupported."),
    );
  }
  if (!requireProperty(value, "kind", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (!ENDPOINT_PRINCIPAL_KINDS.includes(value.kind as EndpointPrincipalKind)) {
    diagnostics.push(
      diagnostic("ENDPOINT_AUTHORIZATION_INVALID_PRINCIPAL", `${path}.kind`, "Principal class is not recognized."),
    );
  }
  if (!requireProperty(value, "id", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (!validId(value.id)) {
    diagnostics.push(
      diagnostic(
        "ENDPOINT_AUTHORIZATION_INVALID_PRINCIPAL",
        `${path}.id`,
        "Principal identifier must be a bounded stable identifier.",
      ),
    );
  }
  if (diagnostics.length > 0) return { valid: false, diagnostics: uniqueDiagnostics(diagnostics) };
  return {
    valid: true,
    value: Object.freeze({
      version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
      kind: value.kind as EndpointPrincipalKind,
      id: value.id as string,
    }) as EndpointPrincipal,
    diagnostics: [],
  };
}

export function validateEndpointPrincipal(
  value: unknown,
  path = "$.principal",
): EndpointAuthorizationValidationResult<EndpointPrincipal> {
  return normalizePrincipal(value, path);
}

function normalizeEndpoint(value: unknown, path: string): EndpointAuthorizationValidationResult<EndpointIdentity> {
  if (!isRecord(value)) return invalidRoot(path);
  const diagnostics: EndpointAuthorizationDiagnostic[] = [];
  addUnknownProperties(value, ENDPOINT_KEYS, path, diagnostics);
  if (!requireProperty(value, "version", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (value.version !== ENDPOINT_AUTHORIZATION_CONTRACT_VERSION) {
    diagnostics.push(
      diagnostic("ENDPOINT_AUTHORIZATION_UNSUPPORTED_VERSION", `${path}.version`, "Contract version is unsupported."),
    );
  }
  if (!requireProperty(value, "kind", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (value.kind !== "endpoint") {
    diagnostics.push(
      diagnostic("ENDPOINT_AUTHORIZATION_INVALID_ENDPOINT", `${path}.kind`, "Resource kind is invalid."),
    );
  }
  if (!requireProperty(value, "id", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (!validId(value.id)) {
    diagnostics.push(
      diagnostic("ENDPOINT_AUTHORIZATION_INVALID_ENDPOINT", `${path}.id`, "Endpoint identifier is invalid."),
    );
  }
  if (!requireProperty(value, "deployment", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (!ENDPOINT_DEPLOYMENT_KINDS.includes(value.deployment as EndpointDeploymentKind)) {
    diagnostics.push(
      diagnostic("ENDPOINT_AUTHORIZATION_INVALID_ENDPOINT", `${path}.deployment`, "Endpoint deployment is invalid."),
    );
  }
  if (diagnostics.length > 0) return { valid: false, diagnostics: uniqueDiagnostics(diagnostics) };
  return {
    valid: true,
    value: Object.freeze({
      version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
      kind: "endpoint",
      id: value.id as string,
      deployment: value.deployment as EndpointDeploymentKind,
    }),
    diagnostics: [],
  };
}

export function validateEndpointIdentity(
  value: unknown,
  path = "$.endpoint",
): EndpointAuthorizationValidationResult<EndpointIdentity> {
  return normalizeEndpoint(value, path);
}

function normalizeInstallation(
  value: unknown,
  path: string,
): EndpointAuthorizationValidationResult<EndpointInstallationIdentity> {
  if (!isRecord(value)) return invalidRoot(path);
  const diagnostics: EndpointAuthorizationDiagnostic[] = [];
  addUnknownProperties(value, INSTALLATION_KEYS, path, diagnostics);
  if (!requireProperty(value, "version", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (value.version !== ENDPOINT_AUTHORIZATION_CONTRACT_VERSION) {
    diagnostics.push(
      diagnostic("ENDPOINT_AUTHORIZATION_UNSUPPORTED_VERSION", `${path}.version`, "Contract version is unsupported."),
    );
  }
  if (!requireProperty(value, "kind", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (value.kind !== "installation") {
    diagnostics.push(
      diagnostic("ENDPOINT_AUTHORIZATION_INVALID_INSTALLATION", `${path}.kind`, "Resource kind is invalid."),
    );
  }
  if (!requireProperty(value, "endpointId", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (!validId(value.endpointId)) {
    diagnostics.push(
      diagnostic(
        "ENDPOINT_AUTHORIZATION_INVALID_INSTALLATION",
        `${path}.endpointId`,
        "Endpoint identifier is invalid.",
      ),
    );
  }
  if (!requireProperty(value, "installationId", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (!validId(value.installationId)) {
    diagnostics.push(
      diagnostic(
        "ENDPOINT_AUTHORIZATION_INVALID_INSTALLATION",
        `${path}.installationId`,
        "Installation identifier is invalid.",
      ),
    );
  }
  if (diagnostics.length > 0) return { valid: false, diagnostics: uniqueDiagnostics(diagnostics) };
  return {
    valid: true,
    value: Object.freeze({
      version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
      kind: "installation",
      endpointId: value.endpointId as string,
      installationId: value.installationId as string,
    }),
    diagnostics: [],
  };
}

export function validateEndpointInstallationIdentity(
  value: unknown,
  path = "$.installation",
): EndpointAuthorizationValidationResult<EndpointInstallationIdentity> {
  return normalizeInstallation(value, path);
}

function normalizeRepository(
  value: unknown,
  path: string,
): EndpointAuthorizationValidationResult<EndpointRepositoryIdentity> {
  if (!isRecord(value)) return invalidRoot(path);
  const diagnostics: EndpointAuthorizationDiagnostic[] = [];
  addUnknownProperties(value, REPOSITORY_KEYS, path, diagnostics);
  if (!requireProperty(value, "version", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (value.version !== ENDPOINT_AUTHORIZATION_CONTRACT_VERSION) {
    diagnostics.push(
      diagnostic("ENDPOINT_AUTHORIZATION_UNSUPPORTED_VERSION", `${path}.version`, "Contract version is unsupported."),
    );
  }
  if (!requireProperty(value, "kind", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (value.kind !== "repository") {
    diagnostics.push(
      diagnostic("ENDPOINT_AUTHORIZATION_INVALID_REPOSITORY", `${path}.kind`, "Resource kind is invalid."),
    );
  }
  if (!requireProperty(value, "endpointId", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (!validId(value.endpointId)) {
    diagnostics.push(
      diagnostic("ENDPOINT_AUTHORIZATION_INVALID_REPOSITORY", `${path}.endpointId`, "Endpoint identifier is invalid."),
    );
  }
  if (!requireProperty(value, "installationId", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (!validId(value.installationId)) {
    diagnostics.push(
      diagnostic(
        "ENDPOINT_AUTHORIZATION_INVALID_REPOSITORY",
        `${path}.installationId`,
        "Installation identifier is invalid.",
      ),
    );
  }
  const repository = validateRepositoryIdentity(
    {
      repositoryHost: value.repositoryHost,
      repositoryId: value.repositoryId,
      nameWithOwner: value.nameWithOwner,
    },
    path,
  );
  if (!repository.valid || repository.value === undefined) {
    diagnostics.push(
      ...repository.diagnostics.map((entry) =>
        diagnostic("ENDPOINT_AUTHORIZATION_INVALID_REPOSITORY", entry.path, entry.message),
      ),
    );
  }
  if (diagnostics.length > 0 || repository.value === undefined) {
    return { valid: false, diagnostics: uniqueDiagnostics(diagnostics) };
  }
  return {
    valid: true,
    value: Object.freeze({
      version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
      kind: "repository",
      endpointId: value.endpointId as string,
      installationId: value.installationId as string,
      repositoryHost: repository.value.repositoryHost,
      repositoryId: repository.value.repositoryId,
      nameWithOwner: repository.value.nameWithOwner,
    }),
    diagnostics: [],
  };
}

export function validateEndpointRepositoryIdentity(
  value: unknown,
  path = "$.repository",
): EndpointAuthorizationValidationResult<EndpointRepositoryIdentity> {
  return normalizeRepository(value, path);
}

function capabilityDiagnostic(entry: CapabilityDiagnostic): EndpointAuthorizationDiagnostic {
  const unknown = entry.code === "CAPABILITY_UNSUPPORTED_KIND";
  return diagnostic(
    unknown ? "ENDPOINT_AUTHORIZATION_UNKNOWN_CAPABILITY" : "ENDPOINT_AUTHORIZATION_INVALID_CAPABILITY",
    entry.path,
    entry.message,
  );
}

export function validateEndpointCapability(
  value: unknown,
  path = "$.capability",
): EndpointAuthorizationValidationResult<EndpointCapability> {
  const result = validateCapabilityClaim(value, path);
  if (!result.valid || result.value === undefined) {
    return {
      valid: false,
      diagnostics: uniqueDiagnostics(result.diagnostics.map((entry) => capabilityDiagnostic(entry))),
    };
  }
  return { valid: true, value: result.value, diagnostics: [] };
}

function samePrincipal(left: EndpointPrincipal, right: EndpointPrincipal): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function sameEndpoint(left: EndpointIdentity, right: EndpointIdentity): boolean {
  return left.id === right.id && left.deployment === right.deployment;
}

function sameInstallation(left: EndpointInstallationIdentity, right: EndpointInstallationIdentity): boolean {
  return left.endpointId === right.endpointId && left.installationId === right.installationId;
}

function sameRepository(left: EndpointRepositoryIdentity, right: EndpointRepositoryIdentity): boolean {
  return (
    left.endpointId === right.endpointId &&
    left.installationId === right.installationId &&
    left.repositoryHost === right.repositoryHost &&
    left.repositoryId === right.repositoryId
  );
}

function sameCapability(left: EndpointCapability, right: EndpointCapability): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "change.implement":
    case "change.ready":
    case "change.abort":
    case "change.merge":
      return right.kind === left.kind && right.issue === left.issue;
    case "branch.create":
      return right.kind === left.kind && right.branch === left.branch && right.max === left.max;
    case "branch.advance":
      return right.kind === left.kind && right.branch === left.branch && right.pathPolicy === left.pathPolicy;
    case "pullRequest.create":
      return right.kind === left.kind && right.head === left.head && right.base === left.base && right.max === left.max;
  }
}

function normalizeEvidence(
  value: unknown,
  path: string,
): EndpointAuthorizationValidationResult<EndpointAuthorizationEvidence> {
  if (!isRecord(value)) return invalidRoot(path);
  const diagnostics: EndpointAuthorizationDiagnostic[] = [];
  addUnknownProperties(value, EVIDENCE_KEYS, path, diagnostics);
  if (!requireProperty(value, "version", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (value.version !== ENDPOINT_AUTHORIZATION_CONTRACT_VERSION) {
    diagnostics.push(
      diagnostic("ENDPOINT_AUTHORIZATION_UNSUPPORTED_VERSION", `${path}.version`, "Contract version is unsupported."),
    );
  }
  if (!requireProperty(value, "authenticated", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (value.authenticated !== true) {
    diagnostics.push(
      diagnostic(
        "ENDPOINT_AUTHORIZATION_UNAUTHENTICATED",
        `${path}.authenticated`,
        "Only explicitly authenticated evidence can authorize an operation.",
      ),
    );
  }
  const principal = normalizePrincipal(value.principal, `${path}.principal`);
  const endpoint = normalizeEndpoint(value.endpoint, `${path}.endpoint`);
  const installation = normalizeInstallation(value.installation, `${path}.installation`);
  const repository = normalizeRepository(value.repository, `${path}.repository`);
  diagnostics.push(
    ...principal.diagnostics,
    ...endpoint.diagnostics,
    ...installation.diagnostics,
    ...repository.diagnostics,
  );
  if (!requireProperty(value, "capabilities", path, diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
    diagnostics.push(
      diagnostic(
        "ENDPOINT_AUTHORIZATION_INVALID_CAPABILITY",
        `${path}.capabilities`,
        "At least one explicit capability is required.",
      ),
    );
  }
  const capabilities: EndpointCapability[] = [];
  if (Array.isArray(value.capabilities)) {
    for (const [index, rawCapability] of value.capabilities.entries()) {
      const result = validateEndpointCapability(rawCapability, `${path}.capabilities[${index}]`);
      diagnostics.push(...result.diagnostics);
      if (result.value !== undefined) {
        if (capabilities.some((entry) => sameCapability(entry, result.value as EndpointCapability))) {
          diagnostics.push(
            diagnostic(
              "ENDPOINT_AUTHORIZATION_INVALID_CAPABILITY",
              `${path}.capabilities[${index}]`,
              "Duplicate capability claims are not accepted.",
            ),
          );
        } else {
          capabilities.push(result.value);
        }
      }
    }
  }
  if (
    endpoint.value !== undefined &&
    installation.value !== undefined &&
    installation.value.endpointId !== endpoint.value.id
  ) {
    diagnostics.push(
      diagnostic(
        "ENDPOINT_AUTHORIZATION_ENDPOINT_MISMATCH",
        `${path}.installation.endpointId`,
        "Installation evidence is bound to a different Endpoint.",
      ),
    );
  }
  if (
    endpoint.value !== undefined &&
    repository.value !== undefined &&
    repository.value.endpointId !== endpoint.value.id
  ) {
    diagnostics.push(
      diagnostic(
        "ENDPOINT_AUTHORIZATION_ENDPOINT_MISMATCH",
        `${path}.repository.endpointId`,
        "Repository evidence is bound to a different Endpoint.",
      ),
    );
  }
  if (
    installation.value !== undefined &&
    repository.value !== undefined &&
    repository.value.installationId !== installation.value.installationId
  ) {
    diagnostics.push(
      diagnostic(
        "ENDPOINT_AUTHORIZATION_INSTALLATION_MISMATCH",
        `${path}.repository.installationId`,
        "Repository evidence is bound to a different installation.",
      ),
    );
  }
  if (
    diagnostics.length > 0 ||
    principal.value === undefined ||
    endpoint.value === undefined ||
    installation.value === undefined ||
    repository.value === undefined
  ) {
    return { valid: false, diagnostics: uniqueDiagnostics(diagnostics) };
  }
  return {
    valid: true,
    value: Object.freeze({
      version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
      authenticated: true,
      principal: principal.value,
      endpoint: endpoint.value,
      installation: installation.value,
      repository: repository.value,
      capabilities: Object.freeze([...capabilities]),
    }),
    diagnostics: [],
  };
}

export function validateEndpointAuthorizationEvidence(
  value: unknown,
  path = "$.evidence",
): EndpointAuthorizationValidationResult<EndpointAuthorizationEvidence> {
  return normalizeEvidence(value, path);
}

export function validateEndpointAuthorizationRequest(
  value: unknown,
): EndpointAuthorizationValidationResult<EndpointAuthorizationRequest> {
  if (!isRecord(value)) return invalidRoot("$");
  const diagnostics: EndpointAuthorizationDiagnostic[] = [];
  addUnknownProperties(value, REQUEST_KEYS, "$", diagnostics);
  if (!requireProperty(value, "version", "$", diagnostics)) {
    // Continue collecting deterministic diagnostics.
  } else if (value.version !== ENDPOINT_AUTHORIZATION_CONTRACT_VERSION) {
    diagnostics.push(
      diagnostic("ENDPOINT_AUTHORIZATION_UNSUPPORTED_VERSION", "$.version", "Contract version is unsupported."),
    );
  }
  const principal = normalizePrincipal(value.principal, "$.principal");
  const endpoint = normalizeEndpoint(value.endpoint, "$.endpoint");
  const installation = normalizeInstallation(value.installation, "$.installation");
  const repository = normalizeRepository(value.repository, "$.repository");
  const capability = validateEndpointCapability(value.capability, "$.capability");
  const evidence = normalizeEvidence(value.evidence, "$.evidence");
  diagnostics.push(
    ...principal.diagnostics,
    ...endpoint.diagnostics,
    ...installation.diagnostics,
    ...repository.diagnostics,
    ...capability.diagnostics,
    ...evidence.diagnostics,
  );
  if (
    diagnostics.length > 0 ||
    principal.value === undefined ||
    endpoint.value === undefined ||
    installation.value === undefined ||
    repository.value === undefined ||
    capability.value === undefined ||
    evidence.value === undefined
  ) {
    return { valid: false, diagnostics: uniqueDiagnostics(diagnostics) };
  }
  return {
    valid: true,
    value: Object.freeze({
      version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
      principal: principal.value,
      endpoint: endpoint.value,
      installation: installation.value,
      repository: repository.value,
      capability: capability.value,
      evidence: evidence.value,
    }),
    diagnostics: [],
  };
}

function reasonForDiagnostics(
  diagnostics: readonly EndpointAuthorizationDiagnostic[],
): EndpointAuthorizationDenyReason {
  if (diagnostics.some((entry) => entry.code === "ENDPOINT_AUTHORIZATION_UNAUTHENTICATED")) return "unauthenticated";
  if (diagnostics.some((entry) => entry.code === "ENDPOINT_AUTHORIZATION_PRINCIPAL_MISMATCH"))
    return "principal-mismatch";
  if (diagnostics.some((entry) => entry.code === "ENDPOINT_AUTHORIZATION_ENDPOINT_MISMATCH"))
    return "endpoint-mismatch";
  if (diagnostics.some((entry) => entry.code === "ENDPOINT_AUTHORIZATION_INSTALLATION_MISMATCH"))
    return "installation-mismatch";
  if (diagnostics.some((entry) => entry.code === "ENDPOINT_AUTHORIZATION_REPOSITORY_MISMATCH"))
    return "repository-mismatch";
  if (diagnostics.some((entry) => entry.code === "ENDPOINT_AUTHORIZATION_CAPABILITY_DENIED"))
    return "capability-denied";
  return "invalid-evidence";
}

function denied(
  diagnostics: readonly EndpointAuthorizationDiagnostic[],
  reason?: EndpointAuthorizationDenyReason,
): EndpointAuthorizationResult {
  const normalized = uniqueDiagnostics(diagnostics);
  return {
    version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
    allowed: false,
    decision: "deny",
    reason: reason ?? reasonForDiagnostics(normalized),
    diagnostics: normalized,
  };
}

/** Evaluate one explicit request; malformed or cross-context evidence always denies. */
export function authorizeEndpoint(value: unknown): EndpointAuthorizationResult {
  const validation = validateEndpointAuthorizationRequest(value);
  if (!validation.valid || validation.value === undefined) return denied(validation.diagnostics);
  const request = validation.value;
  const evidence = request.evidence;
  const mismatches: EndpointAuthorizationDiagnostic[] = [];
  if (!samePrincipal(request.principal, evidence.principal)) {
    mismatches.push(
      diagnostic(
        "ENDPOINT_AUTHORIZATION_PRINCIPAL_MISMATCH",
        "$.evidence.principal",
        "Authenticated principal does not match the requested principal.",
      ),
    );
  }
  if (!sameEndpoint(request.endpoint, evidence.endpoint)) {
    mismatches.push(
      diagnostic(
        "ENDPOINT_AUTHORIZATION_ENDPOINT_MISMATCH",
        "$.evidence.endpoint",
        "Authenticated evidence belongs to a different Endpoint.",
      ),
    );
  }
  if (!sameInstallation(request.installation, evidence.installation)) {
    mismatches.push(
      diagnostic(
        "ENDPOINT_AUTHORIZATION_INSTALLATION_MISMATCH",
        "$.evidence.installation",
        "Authenticated evidence belongs to a different installation.",
      ),
    );
  }
  if (!sameRepository(request.repository, evidence.repository)) {
    mismatches.push(
      diagnostic(
        "ENDPOINT_AUTHORIZATION_REPOSITORY_MISMATCH",
        "$.evidence.repository",
        "Authenticated evidence belongs to a different immutable repository context.",
      ),
    );
  }
  if (mismatches.length > 0) return denied(mismatches);
  if (!evidence.capabilities.some((entry) => sameCapability(entry, request.capability))) {
    return denied(
      [
        diagnostic(
          "ENDPOINT_AUTHORIZATION_CAPABILITY_DENIED",
          "$.capability",
          "The requested capability was not explicitly admitted by authenticated evidence.",
        ),
      ],
      "capability-denied",
    );
  }
  return {
    version: ENDPOINT_AUTHORIZATION_CONTRACT_VERSION,
    allowed: true,
    decision: "allow",
    diagnostics: [],
    request,
  };
}

/** Descriptive alias for callers that model authorization as a decision. */
export const evaluateEndpointAuthorization = authorizeEndpoint;
