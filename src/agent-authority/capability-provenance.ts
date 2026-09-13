/**
 * Bounded provenance for one Session-authorized capability execution.
 *
 * This is an additive sidecar. Authentication, capability admission, Change
 * lifecycle/effect evidence, and provider credentials remain owned by their
 * existing authorities. In particular, this module never accepts or retains
 * a certificate, signed request, provider response, credential, or error.
 */

import { validateCapabilityClaim, MAX_ISSUE_NUMBER, type CapabilityClaim } from "./capability.js";
import type { CapabilityAdmissionSubject } from "./capability-admission.js";
import { MAX_OPAQUE_ID_LENGTH, MAX_UNIX_TIME_SECONDS } from "./session-certificate.js";
import { validateBranchName } from "../../branch-naming-authority.mjs";
import {
  MAX_SESSION_AGENT_METADATA_KEYS,
  MAX_SESSION_AGENT_METADATA_TEXT_LENGTH,
  type SessionAgentMetadata,
} from "./session-bundle.js";
import {
  INARI_ISSUER_APP_KIND,
  INARI_ISSUER_APP_SLUG,
  INARI_ISSUER_PRINCIPAL,
  validateInariIssuerAppIdentity,
  validateIssuerRepositoryIdentity,
  type IssuerRepositoryIdentity,
} from "../github/issuer-authority.js";

export const CAPABILITY_PROVENANCE_VERSION = 1 as const;
export type CapabilityProvenanceStage = "authenticated" | "authorized" | "app-scoped" | "verified";

export interface CapabilityExecutionProvenance {
  readonly version: 1;
  readonly stage: CapabilityProvenanceStage;
  readonly repository: IssuerRepositoryIdentity;
  readonly runtimeAuthority: Readonly<{ id: string; kid: string }>;
  readonly session: Readonly<{ id: string; certificateJti: string }>;
  readonly authority: Readonly<{ ref: string; sha: string }>;
  readonly request: Readonly<{
    requestId: string;
    operation: string;
    issuedAt: number;
    expiresAt: number;
  }>;
  readonly subject: CapabilityAdmissionSubject;
  readonly capability?: CapabilityClaim;
  readonly app?: Readonly<{
    kind: "github-app";
    slug: "inari-issuer";
    appId: string;
    principal: "app:inari-issuer";
    installationId: string;
  }>;
  readonly agent?: SessionAgentMetadata;
  readonly commitAuthor?: Readonly<{ name: string; email?: string }>;
}

export interface CapabilityExecutionProvenanceValidationResult {
  readonly valid: boolean;
  readonly value?: CapabilityExecutionProvenance;
  readonly diagnostics: readonly CapabilityExecutionProvenanceDiagnostic[];
}

export type CapabilityExecutionProvenanceDiagnosticCode =
  | "PROVENANCE_INVALID_ROOT"
  | "PROVENANCE_MISSING_PROPERTY"
  | "PROVENANCE_UNKNOWN_PROPERTY"
  | "PROVENANCE_UNSUPPORTED_VERSION"
  | "PROVENANCE_INVALID_STAGE"
  | "PROVENANCE_INVALID_FIELD"
  | "PROVENANCE_STAGE_INVARIANT";

export interface CapabilityExecutionProvenanceDiagnostic {
  readonly code: CapabilityExecutionProvenanceDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export class CapabilityExecutionProvenanceError extends Error {
  readonly code = "CAPABILITY_PROVENANCE_INVALID" as const;
  readonly diagnostics: readonly CapabilityExecutionProvenanceDiagnostic[];

  constructor(diagnostics: readonly CapabilityExecutionProvenanceDiagnostic[]) {
    super("Capability execution provenance is invalid.");
    this.name = "CapabilityExecutionProvenanceError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

const MAX_DIAGNOSTICS = 32;
const MAX_REFERENCE_LENGTH = 255;
const MAX_COMMIT_AUTHOR_NAME_LENGTH = 128;
const MAX_COMMIT_AUTHOR_EMAIL_LENGTH = 320;
const MAX_INSTALLATION_ID_LENGTH = 20;
const MAX_SUBJECT_BRANCH_LENGTH = 255;
const MAX_SUBJECT_HEAD_LENGTH = 255;
const MAX_SUBJECT_BASE_LENGTH = 255;
const STAGES = Object.freeze(["authenticated", "authorized", "app-scoped", "verified"] as const);
const ROOT_KEYS = new Set([
  "version",
  "stage",
  "repository",
  "runtimeAuthority",
  "session",
  "authority",
  "request",
  "subject",
  "capability",
  "app",
  "agent",
  "commitAuthor",
]);
const RUNTIME_KEYS = new Set(["id", "kid"]);
const SESSION_KEYS = new Set(["id", "certificateJti"]);
const AUTHORITY_KEYS = new Set(["ref", "sha"]);
const REQUEST_KEYS = new Set(["requestId", "operation", "issuedAt", "expiresAt"]);
const SUBJECT_KEYS = new Map([
  ["change", new Set(["kind", "issue"])],
  ["branch", new Set(["kind", "issue", "branch"])],
  ["pullRequest", new Set(["kind", "issue", "head", "base"])],
]);
const APP_KEYS = new Set(["kind", "slug", "appId", "principal", "installationId"]);
const AGENT_KEYS = new Set(["name", "version", "runtime", "product"]);
const COMMIT_AUTHOR_KEYS = new Set(["name", "email"]);
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const RUNTIME_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const LINE_TOKEN = /^[\x21-\x7e]+$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function diagnostic(
  code: CapabilityExecutionProvenanceDiagnosticCode,
  path: string,
  message: string,
): CapabilityExecutionProvenanceDiagnostic {
  return { code, path, message };
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    SAFE_TEXT.test(value) &&
    !LONE_SURROGATE.test(value)
  );
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_OPAQUE_ID_LENGTH && SAFE_ID.test(value);
}

function addUnknownProperties(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: CapabilityExecutionProvenanceDiagnostic[],
): void {
  for (const key of Object.keys(input).sort(compareText)) {
    if (allowed.has(key) || diagnostics.length >= MAX_DIAGNOSTICS) continue;
    diagnostics.push(diagnostic("PROVENANCE_UNKNOWN_PROPERTY", `${path}.${key}`, "Property is not accepted."));
  }
}

function requireProperty(
  input: Record<string, unknown>,
  key: string,
  path: string,
  diagnostics: CapabilityExecutionProvenanceDiagnostic[],
): boolean {
  if (key in input) return true;
  if (diagnostics.length < MAX_DIAGNOSTICS) {
    diagnostics.push(diagnostic("PROVENANCE_MISSING_PROPERTY", `${path}.${key}`, "Property is required."));
  }
  return false;
}

function invalid(
  path: string,
  diagnostics: CapabilityExecutionProvenanceDiagnostic[],
  message = "Value is outside the bounded provenance form.",
): void {
  if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(diagnostic("PROVENANCE_INVALID_FIELD", path, message));
}

function stageInvariant(path: string, diagnostics: CapabilityExecutionProvenanceDiagnostic[], message: string): void {
  if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(diagnostic("PROVENANCE_STAGE_INVARIANT", path, message));
}

function validateRuntimeAuthority(
  input: unknown,
  path: string,
  diagnostics: CapabilityExecutionProvenanceDiagnostic[],
): input is { readonly id: string; readonly kid: string } {
  if (!isRecord(input)) {
    invalid(path, diagnostics, "Runtime Authority identity must be an object.");
    return false;
  }
  addUnknownProperties(input, RUNTIME_KEYS, path, diagnostics);
  const idPresent = requireProperty(input, "id", path, diagnostics);
  const kidPresent = requireProperty(input, "kid", path, diagnostics);
  const valid =
    idPresent && typeof input.id === "string" && RUNTIME_ID.test(input.id) && input.id.length <= MAX_OPAQUE_ID_LENGTH;
  const kidValid =
    kidPresent &&
    typeof input.kid === "string" &&
    RUNTIME_ID.test(input.kid) &&
    input.kid.length <= MAX_OPAQUE_ID_LENGTH;
  if (!valid) invalid(`${path}.id`, diagnostics, "Runtime Authority id is invalid.");
  if (!kidValid) invalid(`${path}.kid`, diagnostics, "Runtime Authority kid is invalid.");
  return valid && kidValid;
}

function validateSession(
  input: unknown,
  path: string,
  diagnostics: CapabilityExecutionProvenanceDiagnostic[],
): input is { readonly id: string; readonly certificateJti: string } {
  if (!isRecord(input)) {
    invalid(path, diagnostics, "Session identity must be an object.");
    return false;
  }
  addUnknownProperties(input, SESSION_KEYS, path, diagnostics);
  const idPresent = requireProperty(input, "id", path, diagnostics);
  const jtiPresent = requireProperty(input, "certificateJti", path, diagnostics);
  const idValid = idPresent && isSafeId(input.id);
  const jtiValid = jtiPresent && isSafeId(input.certificateJti);
  if (!idValid) invalid(`${path}.id`, diagnostics, "Session id is invalid.");
  if (!jtiValid) invalid(`${path}.certificateJti`, diagnostics, "Session certificate jti is invalid.");
  return idValid && jtiValid;
}

function validateAuthority(
  input: unknown,
  path: string,
  diagnostics: CapabilityExecutionProvenanceDiagnostic[],
): input is { readonly ref: string; readonly sha: string } {
  if (!isRecord(input)) {
    invalid(path, diagnostics, "Authority reference must be an object.");
    return false;
  }
  addUnknownProperties(input, AUTHORITY_KEYS, path, diagnostics);
  const refPresent = requireProperty(input, "ref", path, diagnostics);
  const shaPresent = requireProperty(input, "sha", path, diagnostics);
  const refValid = refPresent && isBoundedText(input.ref, MAX_REFERENCE_LENGTH);
  const shaValid = shaPresent && typeof input.sha === "string" && COMMIT_SHA.test(input.sha);
  if (!refValid) invalid(`${path}.ref`, diagnostics, "Authority ref is invalid.");
  if (!shaValid) invalid(`${path}.sha`, diagnostics, "Authority SHA is invalid.");
  return refValid && shaValid;
}

function validateRequest(
  input: unknown,
  path: string,
  diagnostics: CapabilityExecutionProvenanceDiagnostic[],
): input is {
  readonly requestId: string;
  readonly operation: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
} {
  if (!isRecord(input)) {
    invalid(path, diagnostics, "Request identity must be an object.");
    return false;
  }
  addUnknownProperties(input, REQUEST_KEYS, path, diagnostics);
  const requestIdPresent = requireProperty(input, "requestId", path, diagnostics);
  const operationPresent = requireProperty(input, "operation", path, diagnostics);
  const issuedAtPresent = requireProperty(input, "issuedAt", path, diagnostics);
  const expiresAtPresent = requireProperty(input, "expiresAt", path, diagnostics);
  const requestIdValid =
    requestIdPresent &&
    typeof input.requestId === "string" &&
    LINE_TOKEN.test(input.requestId) &&
    input.requestId.length <= MAX_OPAQUE_ID_LENGTH;
  const operationValid =
    operationPresent &&
    typeof input.operation === "string" &&
    LINE_TOKEN.test(input.operation) &&
    input.operation.length <= MAX_OPAQUE_ID_LENGTH;
  const issuedAtValid = issuedAtPresent && isUnixTime(input.issuedAt);
  const expiresAtValid = expiresAtPresent && isUnixTime(input.expiresAt);
  if (!requestIdValid) invalid(`${path}.requestId`, diagnostics, "Request id is invalid.");
  if (!operationValid) invalid(`${path}.operation`, diagnostics, "Operation is invalid.");
  if (!issuedAtValid) invalid(`${path}.issuedAt`, diagnostics, "issuedAt is invalid.");
  if (!expiresAtValid) invalid(`${path}.expiresAt`, diagnostics, "expiresAt is invalid.");
  if (issuedAtValid && expiresAtValid && (input.expiresAt as number) <= (input.issuedAt as number)) {
    invalid(`${path}.expiresAt`, diagnostics, "expiresAt must be later than issuedAt.");
  }
  return requestIdValid && operationValid && issuedAtValid && expiresAtValid;
}

function isUnixTime(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_UNIX_TIME_SECONDS;
}

function validateSubject(
  input: unknown,
  path: string,
  diagnostics: CapabilityExecutionProvenanceDiagnostic[],
): input is CapabilityAdmissionSubject {
  if (!isRecord(input)) {
    invalid(path, diagnostics, "Admission subject must be an object.");
    return false;
  }
  const kind = input.kind;
  const allowed = SUBJECT_KEYS.get(kind as string);
  if (allowed === undefined) {
    invalid(`${path}.kind`, diagnostics, "Admission subject kind is invalid.");
    return false;
  }
  addUnknownProperties(input, allowed, path, diagnostics);
  const issuePresent = requireProperty(input, "issue", path, diagnostics);
  const issueValid = issuePresent && isSafeIssue(input.issue);
  if (!issueValid) invalid(`${path}.issue`, diagnostics, "Admission subject issue is invalid.");
  if (kind === "change") return issueValid;

  if (kind === "branch") {
    const branchPresent = requireProperty(input, "branch", path, diagnostics);
    const branchValid = branchPresent && isCanonicalBranch(input.branch, MAX_SUBJECT_BRANCH_LENGTH);
    if (!branchValid) invalid(`${path}.branch`, diagnostics, "Admission subject branch is invalid.");
    return issueValid && branchValid;
  }

  const headPresent = requireProperty(input, "head", path, diagnostics);
  const basePresent = requireProperty(input, "base", path, diagnostics);
  const headValid = headPresent && isCanonicalBranch(input.head, MAX_SUBJECT_HEAD_LENGTH);
  const baseValid = basePresent && isCanonicalBranch(input.base, MAX_SUBJECT_BASE_LENGTH);
  if (!headValid) invalid(`${path}.head`, diagnostics, "Pull request head is invalid.");
  if (!baseValid) invalid(`${path}.base`, diagnostics, "Pull request base is invalid.");
  return issueValid && headValid && baseValid;
}

function isSafeIssue(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_ISSUE_NUMBER;
}

function isCanonicalBranch(value: unknown, maximum: number): value is string {
  return isBoundedText(value, maximum) && validateBranchName(value).length === 0;
}

function validateCapability(
  input: unknown,
  path: string,
  diagnostics: CapabilityExecutionProvenanceDiagnostic[],
): input is CapabilityClaim {
  const result = validateCapabilityClaim(input, path);
  if (!result.valid || result.value === undefined) {
    invalid(path, diagnostics, "Capability claim is invalid.");
    return false;
  }
  return true;
}

function validateApp(
  input: unknown,
  path: string,
  diagnostics: CapabilityExecutionProvenanceDiagnostic[],
): input is {
  readonly kind: "github-app";
  readonly slug: "inari-issuer";
  readonly appId: string;
  readonly principal: "app:inari-issuer";
  readonly installationId: string;
} {
  if (!isRecord(input)) {
    invalid(path, diagnostics, "App identity must be an object.");
    return false;
  }
  addUnknownProperties(input, APP_KEYS, path, diagnostics);
  const appResult = validateInariIssuerAppIdentity(
    { kind: input.kind, slug: input.slug, appId: input.appId, principal: input.principal },
    path,
  );
  const installationIdValid =
    typeof input.installationId === "string" &&
    input.installationId.length <= MAX_INSTALLATION_ID_LENGTH &&
    DECIMAL_ID.test(input.installationId);
  if (!appResult.valid || appResult.value === undefined) invalid(path, diagnostics, "App issuer identity is invalid.");
  if (!installationIdValid) invalid(`${path}.installationId`, diagnostics, "App installation identity is invalid.");
  return appResult.valid && appResult.value !== undefined && installationIdValid;
}

function validateAgent(
  input: unknown,
  path: string,
  diagnostics: CapabilityExecutionProvenanceDiagnostic[],
): input is SessionAgentMetadata {
  if (!isRecord(input)) {
    invalid(path, diagnostics, "Agent metadata must be an object.");
    return false;
  }
  addUnknownProperties(input, AGENT_KEYS, path, diagnostics);
  const keys = Object.keys(input).filter((key) => AGENT_KEYS.has(key));
  if (keys.length === 0 || keys.length > MAX_SESSION_AGENT_METADATA_KEYS) {
    invalid(path, diagnostics, "Agent metadata has an invalid property count.");
  }
  let valid = keys.length > 0 && keys.length <= MAX_SESSION_AGENT_METADATA_KEYS;
  for (const key of keys.sort(compareText)) {
    const value = input[key];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_SESSION_AGENT_METADATA_TEXT_LENGTH ||
      !/^[\x20-\x7e]+$/u.test(value) ||
      /(?:private\s*key|secret|token|credential|begin\s+[-a-z]+\s+key)/iu.test(value)
    ) {
      invalid(`${path}.${key}`, diagnostics, "Agent metadata text is invalid.");
      valid = false;
    }
  }
  return valid;
}

function validateCommitAuthor(
  input: unknown,
  path: string,
  diagnostics: CapabilityExecutionProvenanceDiagnostic[],
): input is { readonly name: string; readonly email?: string } {
  if (!isRecord(input)) {
    invalid(path, diagnostics, "Commit author identity must be an object.");
    return false;
  }
  addUnknownProperties(input, COMMIT_AUTHOR_KEYS, path, diagnostics);
  const namePresent = requireProperty(input, "name", path, diagnostics);
  const nameValid = namePresent && isBoundedText(input.name, MAX_COMMIT_AUTHOR_NAME_LENGTH);
  const emailValid = input.email === undefined || isBoundedText(input.email, MAX_COMMIT_AUTHOR_EMAIL_LENGTH);
  if (!nameValid) invalid(`${path}.name`, diagnostics, "Commit author name is invalid.");
  if (!emailValid) invalid(`${path}.email`, diagnostics, "Commit author email is invalid.");
  return nameValid && emailValid;
}

function validateRoot(input: unknown): CapabilityExecutionProvenanceValidationResult {
  const diagnostics: CapabilityExecutionProvenanceDiagnostic[] = [];
  if (!isRecord(input)) {
    return {
      valid: false,
      diagnostics: Object.freeze([diagnostic("PROVENANCE_INVALID_ROOT", "$", "Provenance must be an object.")]),
    };
  }

  addUnknownProperties(input, ROOT_KEYS, "$", diagnostics);
  const versionPresent = requireProperty(input, "version", "$", diagnostics);
  const stagePresent = requireProperty(input, "stage", "$", diagnostics);
  const repositoryPresent = requireProperty(input, "repository", "$", diagnostics);
  const runtimePresent = requireProperty(input, "runtimeAuthority", "$", diagnostics);
  const sessionPresent = requireProperty(input, "session", "$", diagnostics);
  const authorityPresent = requireProperty(input, "authority", "$", diagnostics);
  const requestPresent = requireProperty(input, "request", "$", diagnostics);
  const subjectPresent = requireProperty(input, "subject", "$", diagnostics);

  if (versionPresent && input.version !== CAPABILITY_PROVENANCE_VERSION) {
    if (diagnostics.length < MAX_DIAGNOSTICS) {
      diagnostics.push(
        diagnostic("PROVENANCE_UNSUPPORTED_VERSION", "$.version", "Only provenance version 1 is accepted."),
      );
    }
  }
  const stageValid = stagePresent && STAGES.includes(input.stage as CapabilityProvenanceStage);
  if (!stageValid) invalid("$.stage", diagnostics, "Provenance stage is invalid.");

  const repositoryResult = repositoryPresent
    ? validateIssuerRepositoryIdentity(input.repository, "$.repository")
    : undefined;
  if (repositoryPresent && (!repositoryResult?.valid || repositoryResult.value === undefined)) {
    invalid("$.repository", diagnostics, "Repository identity is invalid.");
  }
  const runtimeValid =
    runtimePresent && validateRuntimeAuthority(input.runtimeAuthority, "$.runtimeAuthority", diagnostics);
  const sessionValid = sessionPresent && validateSession(input.session, "$.session", diagnostics);
  const authorityValid = authorityPresent && validateAuthority(input.authority, "$.authority", diagnostics);
  const requestValid = requestPresent && validateRequest(input.request, "$.request", diagnostics);
  const subjectValid = subjectPresent && validateSubject(input.subject, "$.subject", diagnostics);

  let capabilityValid = true;
  if (input.capability !== undefined)
    capabilityValid = validateCapability(input.capability, "$.capability", diagnostics);
  let appValid = true;
  if (input.app !== undefined) appValid = validateApp(input.app, "$.app", diagnostics);
  let agentValid = true;
  if (input.agent !== undefined) agentValid = validateAgent(input.agent, "$.agent", diagnostics);
  let commitAuthorValid = true;
  if (input.commitAuthor !== undefined) {
    commitAuthorValid = validateCommitAuthor(input.commitAuthor, "$.commitAuthor", diagnostics);
  }

  if (stageValid) {
    const stage = input.stage as CapabilityProvenanceStage;
    const requiresCapability = stage !== "authenticated";
    const requiresApp = stage === "app-scoped" || stage === "verified";
    const forbidsCapability = stage === "authenticated";
    const forbidsApp = stage === "authenticated" || stage === "authorized";
    if (requiresCapability && input.capability === undefined) {
      stageInvariant("$.capability", diagnostics, "This stage requires an admitted capability.");
    }
    if (requiresApp && input.app === undefined) {
      stageInvariant("$.app", diagnostics, "This stage requires validated App identity.");
    }
    if (forbidsCapability && input.capability !== undefined) {
      stageInvariant("$.capability", diagnostics, "Authenticated provenance cannot claim admission.");
    }
    if (forbidsApp && input.app !== undefined) {
      stageInvariant("$.app", diagnostics, "App identity is not established at this stage.");
    }
  }

  const valid =
    diagnostics.length === 0 &&
    versionPresent &&
    input.version === CAPABILITY_PROVENANCE_VERSION &&
    stageValid &&
    repositoryResult?.valid === true &&
    runtimeValid &&
    sessionValid &&
    authorityValid &&
    requestValid &&
    subjectValid &&
    capabilityValid &&
    appValid &&
    agentValid &&
    commitAuthorValid;
  if (!valid) return { valid: false, diagnostics: Object.freeze([...diagnostics]) };

  const value = materialize(input, repositoryResult.value as IssuerRepositoryIdentity);
  return { valid: true, value, diagnostics: Object.freeze([]) };
}

function materialize(
  input: Record<string, unknown>,
  repository: IssuerRepositoryIdentity,
): CapabilityExecutionProvenance {
  const runtimeAuthority = input.runtimeAuthority as { readonly id: string; readonly kid: string };
  const session = input.session as { readonly id: string; readonly certificateJti: string };
  const authority = input.authority as { readonly ref: string; readonly sha: string };
  const request = input.request as {
    readonly requestId: string;
    readonly operation: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
  };
  const subject = input.subject as CapabilityAdmissionSubject;
  const capability = input.capability === undefined ? undefined : cloneCapability(input.capability as CapabilityClaim);
  const app = input.app === undefined ? undefined : cloneApp(input.app);
  const agent = input.agent === undefined ? undefined : cloneAgent(input.agent as SessionAgentMetadata);
  const commitAuthor = input.commitAuthor === undefined ? undefined : cloneCommitAuthor(input.commitAuthor);
  return Object.freeze({
    version: CAPABILITY_PROVENANCE_VERSION,
    stage: input.stage as CapabilityProvenanceStage,
    repository: Object.freeze({ ...repository }),
    runtimeAuthority: Object.freeze({ id: runtimeAuthority.id, kid: runtimeAuthority.kid }),
    session: Object.freeze({ id: session.id, certificateJti: session.certificateJti }),
    authority: Object.freeze({ ref: authority.ref, sha: authority.sha }),
    request: Object.freeze({
      requestId: request.requestId,
      operation: request.operation,
      issuedAt: request.issuedAt,
      expiresAt: request.expiresAt,
    }),
    subject: cloneSubject(subject),
    ...(capability === undefined ? {} : { capability }),
    ...(app === undefined ? {} : { app }),
    ...(agent === undefined ? {} : { agent }),
    ...(commitAuthor === undefined ? {} : { commitAuthor }),
  });
}

function cloneCapability(value: CapabilityClaim): CapabilityClaim {
  return Object.freeze({ ...value }) as CapabilityClaim;
}

function cloneSubject(value: CapabilityAdmissionSubject): CapabilityAdmissionSubject {
  return Object.freeze({ ...value });
}

function cloneApp(value: unknown): CapabilityExecutionProvenance["app"] {
  const app = value as NonNullable<CapabilityExecutionProvenance["app"]>;
  return Object.freeze({
    kind: INARI_ISSUER_APP_KIND,
    slug: INARI_ISSUER_APP_SLUG,
    appId: app.appId,
    principal: INARI_ISSUER_PRINCIPAL,
    installationId: app.installationId,
  });
}

function cloneAgent(value: SessionAgentMetadata): SessionAgentMetadata {
  return Object.freeze({ ...value });
}

function cloneCommitAuthor(value: unknown): Readonly<{ name: string; email?: string }> {
  const author = value as { readonly name: string; readonly email?: string };
  return Object.freeze({
    name: author.name,
    ...(author.email === undefined ? {} : { email: author.email }),
  });
}

/** Validate and normalize one bounded provenance value. */
export function validateCapabilityExecutionProvenance(input: unknown): CapabilityExecutionProvenanceValidationResult {
  return validateRoot(input);
}

/**
 * Safely omit malformed, pre-authentication, or otherwise untrusted evidence.
 * Unknown properties are never copied into the returned value.
 */
export function normalizeCapabilityExecutionProvenance(input: unknown): CapabilityExecutionProvenance | undefined {
  const result = validateCapabilityExecutionProvenance(input);
  return result.valid ? result.value : undefined;
}

/**
 * Project only the frozen public fields before normalization. This is useful
 * at an internal failure boundary where a larger diagnostic object may also
 * contain provider/error material. Invalid values in the retained fields
 * still fail closed through the normal validator.
 */
export function redactCapabilityExecutionProvenance(input: unknown): CapabilityExecutionProvenance | undefined {
  if (!isRecord(input)) return undefined;
  const projected = projectRoot(input);
  return normalizeCapabilityExecutionProvenance(projected);
}

function projectObject(value: unknown, allowed: ReadonlySet<string>): unknown {
  if (!isRecord(value)) return value;
  const projected: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in value) projected[key] = value[key];
  }
  return projected;
}

function projectRoot(input: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of ROOT_KEYS) {
    if (key in input) projected[key] = input[key];
  }
  if ("repository" in projected)
    projected.repository = projectObject(
      projected.repository,
      new Set(["repositoryHost", "repositoryId", "nameWithOwner"]),
    );
  if ("runtimeAuthority" in projected)
    projected.runtimeAuthority = projectObject(projected.runtimeAuthority, RUNTIME_KEYS);
  if ("session" in projected) projected.session = projectObject(projected.session, SESSION_KEYS);
  if ("authority" in projected) projected.authority = projectObject(projected.authority, AUTHORITY_KEYS);
  if ("request" in projected) projected.request = projectObject(projected.request, REQUEST_KEYS);
  if ("subject" in projected) {
    const subject = projected.subject;
    const kind = isRecord(subject) ? subject.kind : undefined;
    projected.subject = projectObject(subject, SUBJECT_KEYS.get(kind as string) ?? new Set(["kind"]));
  }
  if ("capability" in projected) {
    const capability = projected.capability;
    const kind = isRecord(capability) ? capability.kind : undefined;
    const capabilityKeys =
      kind === "change.implement" || kind === "change.ready" || kind === "change.abort"
        ? new Set(["kind", "issue"])
        : kind === "branch.create"
          ? new Set(["kind", "branch", "max"])
          : kind === "branch.advance"
            ? new Set(["kind", "branch", "pathPolicy"])
            : kind === "pullRequest.create"
              ? new Set(["kind", "head", "base", "max"])
              : new Set(["kind"]);
    projected.capability = projectObject(capability, capabilityKeys);
  }
  if ("app" in projected) projected.app = projectObject(projected.app, APP_KEYS);
  if ("agent" in projected) projected.agent = projectObject(projected.agent, AGENT_KEYS);
  if ("commitAuthor" in projected) projected.commitAuthor = projectObject(projected.commitAuthor, COMMIT_AUTHOR_KEYS);
  return projected;
}

/** Construct a value or fail closed with fixed, bounded diagnostics. */
export function createCapabilityExecutionProvenance(input: unknown): CapabilityExecutionProvenance {
  const result = validateCapabilityExecutionProvenance(input);
  if (!result.valid || result.value === undefined) throw new CapabilityExecutionProvenanceError(result.diagnostics);
  return result.value;
}

/** Return no provenance before #374 has established a Session identity. */
export function omitUnauthenticatedCapabilityExecutionProvenance(): undefined {
  return undefined;
}
