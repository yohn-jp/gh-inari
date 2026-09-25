import { randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { LocalControlError, readLocalJson, writeLocalJson } from "../../local-control/config.js";
import { validateLocalSessionBinding, type LocalSessionBinding } from "../../local-control/session-binding.js";
import { delegatorPublicKeyFingerprint } from "../../agent-authority/delegator-key.js";
import { validateDelegator, type Delegator } from "../../agent-authority/delegator.js";
import { CANONICAL_BRANCH_TYPES, recognizeBranchName } from "../../branch-naming.js";
import {
  validateChangeProvenanceRecord,
  verifyChangeProvenanceRecord,
  type SignedChangeProvenanceRecord,
} from "../../change-provenance-record.js";
import type { CapabilityClaim } from "../../agent-authority/capability.js";
import { MAX_ISSUE_NUMBER } from "../../agent-authority/capability.js";
import { resolveLocalRepositoryNameWithOwner } from "../../change-publish-projection.js";
import {
  LocalRuntimeAuthorityError,
  openLocalRuntimeAuthority,
  type LocalRuntimeAuthority,
} from "../../authority/index.js";
import type { LocalAdmissionClient } from "./admission-client.js";

const STORED_BINDING_VERSION = 1 as const;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const DEFAULT_SESSION_TTL_SECONDS = 3_600;
const CHANGE_CAPABILITIES = ["change.implement", "change.ready", "change.abort", "change.merge"] as const;
const CHANGE_ISSUE_PROVENANCE_SUFFIX = ".change-issue-provenance.json";
const CHILD_ENVIRONMENT_DENYLIST = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "INARI_GITHUB_APP_USER_CREDENTIAL_FILE",
  "INARI_APP_USER_CREDENTIAL_FILE",
  "INARI_RUNTIME_AUTHORITY_PRIVATE_KEY",
  "INARI_ISSUER_APP_PRIVATE_KEY",
  "INARI_GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY",
  "INARI_GITHUB_APP_PRIVATE_KEY_FILE",
  "GITHUB_APP_PRIVATE_KEY_FILE",
]);

interface StoredSessionBinding {
  readonly version: typeof STORED_BINDING_VERSION;
  readonly binding: LocalSessionBinding;
}

export interface LocalSessionRepositoryIdentity {
  readonly host: string;
  readonly repositoryId: string;
  readonly nameWithOwner: string;
}

export interface StartLocalSessionOptions {
  readonly cwd: string;
  readonly issue: number;
  readonly command: string;
  readonly commandArgs: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly admission: LocalAdmissionClient;
  readonly resolveRepository: () => Promise<LocalSessionRepositoryIdentity>;
  readonly spawnChild?: typeof spawn;
  readonly now?: Date;
}

export class LocalSessionLauncherError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalSessionLauncherError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new LocalSessionLauncherError(code, message);
}

function validateIssue(issue: number): void {
  if (!Number.isInteger(issue) || issue < 1 || issue > MAX_ISSUE_NUMBER) {
    fail("ADMISSION_SESSION_ISSUE_INVALID", "Session requires a bounded positive Issue number.");
  }
}

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    fail("ADMISSION_SESSION_SELECTOR_INVALID", "INARI_SESSION_ID is malformed.");
  }
}

function generateSessionId(): string {
  return `sess_${randomBytes(32).toString("base64url")}`;
}

function storedBindingValidator(value: unknown): StoredSessionBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LocalControlError("LOCAL_CONTROL_INVALID_CONFIG", "Stored local Session binding is malformed.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "version" && key !== "binding") || record.version !== 1) {
    throw new LocalControlError("LOCAL_CONTROL_INVALID_CONFIG", "Stored local Session binding is malformed.");
  }
  const validation = validateLocalSessionBinding(record.binding);
  if (!validation.valid || validation.value === undefined) {
    throw new LocalControlError("LOCAL_CONTROL_INVALID_CONFIG", "Stored local Session binding is malformed.");
  }
  return Object.freeze({ version: STORED_BINDING_VERSION, binding: validation.value });
}

function bindingPath(sessionId: string): string {
  validateSessionId(sessionId);
  return `sessions/${sessionId}.json`;
}

export function readLocalSessionBinding(
  sessionId: string,
  environment: NodeJS.ProcessEnv = process.env,
): LocalSessionBinding | undefined {
  const stored = readLocalJson("cli", bindingPath(sessionId), storedBindingValidator, environment);
  if (stored === undefined) return undefined;
  if (stored.binding.sessionId !== sessionId) {
    fail("ADMISSION_SESSION_BINDING_MISMATCH", "Stored Session binding does not match the selected Session.");
  }
  return stored.binding;
}

export function storeLocalSessionBinding(
  binding: LocalSessionBinding,
  environment: NodeJS.ProcessEnv = process.env,
): LocalSessionBinding {
  validateSessionId(binding.sessionId);
  const validation = validateLocalSessionBinding(binding);
  if (!validation.valid || validation.value === undefined) {
    fail("ADMISSION_SESSION_BINDING_INVALID", "Local Session binding is invalid.");
  }
  const stored = writeLocalJson(
    "cli",
    bindingPath(binding.sessionId),
    { version: STORED_BINDING_VERSION, binding: validation.value },
    storedBindingValidator,
    environment,
  );
  return stored.binding;
}

function trustedRuntimeAuthority(environment: NodeJS.ProcessEnv): Delegator {
  const value = readLocalJson(
    "admission",
    "runtime-authority.json",
    (input) => {
      const validation = validateDelegator(input);
      if (!validation.valid || validation.value === undefined) {
        throw new LocalControlError("LOCAL_CONTROL_INVALID_CONFIG", "Pinned Runtime Authority trust is invalid.");
      }
      return validation.value;
    },
    environment,
  );
  if (value === undefined) fail("ADMISSION_NOT_SETUP", "Local Admission Runtime Authority trust is not configured.");
  return value;
}

/**
 * Open the local Runtime Authority owner. Private-key custody and signing stay
 * in `src/authority`; the launcher only maps its diagnostics to Session errors.
 */
function localRuntimeAuthority(environment: NodeJS.ProcessEnv, now: Date): LocalRuntimeAuthority {
  try {
    return openLocalRuntimeAuthority({
      environment,
      trustedAuthority: () => trustedRuntimeAuthority(environment),
      now,
    });
  } catch (error: unknown) {
    if (error instanceof LocalRuntimeAuthorityError) fail(error.code, error.message);
    throw error;
  }
}

function canonicalIssueBranch(cwd: string, issue: number): string {
  let branch: string;
  try {
    branch = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    fail("ADMISSION_SESSION_BRANCH_UNAVAILABLE", "A canonical local Change branch is required for branch.advance.");
  }
  const identity = recognizeBranchName(branch);
  if (
    identity === undefined ||
    !CANONICAL_BRANCH_TYPES.some((kind) => kind === identity.type) ||
    identity.issueNumber !== issue
  ) {
    fail("ADMISSION_SESSION_BRANCH_MISMATCH", "Local Change branch must be canonical and bound to the selected Issue.");
  }
  return branch;
}

function createBinding(
  sessionId: string,
  issue: number,
  repository: LocalSessionRepositoryIdentity,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  now: Date,
): LocalSessionBinding {
  const runtimeAuthority = localRuntimeAuthority(environment, now);
  const { authority } = runtimeAuthority;
  const capabilities: CapabilityClaim[] = [];
  for (const kind of CHANGE_CAPABILITIES) {
    if (authority.capabilityCeiling.includes(kind)) capabilities.push({ kind, issue });
  }
  if (authority.capabilityCeiling.includes("branch.advance")) {
    capabilities.push({ kind: "branch.advance", branch: canonicalIssueBranch(cwd, issue) });
  }
  if (!capabilities.some((claim) => claim.kind === "change.implement")) {
    fail("ADMISSION_SESSION_CAPABILITY_UNAVAILABLE", "Runtime Authority cannot delegate Issue implementation.");
  }

  const remainingAuthoritySeconds =
    authority.notAfter === null
      ? Number.POSITIVE_INFINITY
      : Math.floor((Date.parse(authority.notAfter) - now.getTime()) / 1000);
  const ttlSeconds = Math.min(DEFAULT_SESSION_TTL_SECONDS, authority.maxSessionTtlSeconds, remainingAuthoritySeconds);
  try {
    return runtimeAuthority.issueSessionBinding({
      sessionId,
      repository: { id: repository.repositoryId, name: repository.nameWithOwner },
      task: { kind: "issue", number: issue },
      capabilities,
      ttlSeconds,
      now,
    });
  } catch {
    fail(
      "ADMISSION_SESSION_BINDING_ISSUE_FAILED",
      "Local Runtime Authority could not issue the bounded Session binding.",
    );
  }
}

function provenancePath(sessionId: string): string {
  validateSessionId(sessionId);
  return `sessions/${sessionId}${CHANGE_ISSUE_PROVENANCE_SUFFIX}`;
}

function storedProvenanceValidator(value: unknown): SignedChangeProvenanceRecord {
  const validation = validateChangeProvenanceRecord(value);
  if (!validation.valid || validation.record === undefined) {
    throw new LocalControlError("LOCAL_CONTROL_INVALID_CONFIG", "Stored Session provenance is malformed.");
  }
  return validation.record;
}

function verifySessionProvenance(
  binding: LocalSessionBinding,
  record: SignedChangeProvenanceRecord,
  authority: Delegator,
): void {
  if (
    binding.authority.id !== authority.id ||
    binding.authority.publicKeyFingerprint !== delegatorPublicKeyFingerprint(authority.key)
  ) {
    fail("ADMISSION_CHANGE_PROVENANCE_AUTHORITY_MISMATCH", "Session and provenance Runtime Authority do not match.");
  }
  let payload: ReturnType<typeof verifyChangeProvenanceRecord>;
  try {
    payload = verifyChangeProvenanceRecord(record, authority);
  } catch {
    fail("ADMISSION_CHANGE_PROVENANCE_INVALID", "Signed Runtime provenance could not be verified.");
  }
  if (payload.rootIssue !== binding.task.number || payload.operation !== "change.issue") {
    fail("ADMISSION_CHANGE_PROVENANCE_MISMATCH", "Signed provenance is not bound to this Session Issue.");
  }
}

export function readLocalSessionChangeIssueProvenance(
  binding: LocalSessionBinding,
  environment: NodeJS.ProcessEnv = process.env,
): SignedChangeProvenanceRecord | undefined {
  const record = readLocalJson("cli", provenancePath(binding.sessionId), storedProvenanceValidator, environment);
  if (record === undefined) return undefined;
  verifySessionProvenance(binding, record, trustedRuntimeAuthority(environment));
  return record;
}

export function storeLocalSessionChangeIssueProvenance(
  binding: LocalSessionBinding,
  record: SignedChangeProvenanceRecord,
  environment: NodeJS.ProcessEnv = process.env,
): SignedChangeProvenanceRecord {
  validateSessionId(binding.sessionId);
  const validated = storedProvenanceValidator(record);
  verifySessionProvenance(binding, validated, trustedRuntimeAuthority(environment));
  return writeLocalJson("cli", provenancePath(binding.sessionId), validated, storedProvenanceValidator, environment);
}

async function ensureLocalSessionChangeIssueProvenance(
  binding: LocalSessionBinding,
  environment: NodeJS.ProcessEnv,
  now: Date,
): Promise<SignedChangeProvenanceRecord> {
  const existing = readLocalSessionChangeIssueProvenance(binding, environment);
  if (existing !== undefined) return existing;
  const signer = localRuntimeAuthority(environment, now);
  let record: SignedChangeProvenanceRecord;
  try {
    record = await signer.signChangeProvenance(binding.task.number);
  } catch {
    fail("ADMISSION_CHANGE_PROVENANCE_SIGNING_FAILED", "Runtime Authority could not sign change.issue provenance.");
  }
  return storeLocalSessionChangeIssueProvenance(binding, record, environment);
}

function validateRepositoryIdentity(repository: LocalSessionRepositoryIdentity): void {
  if (
    repository.host.toLowerCase() !== "github.com" ||
    !/^[1-9][0-9]{0,19}$/u.test(repository.repositoryId) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository.nameWithOwner)
  ) {
    fail("ADMISSION_SESSION_REPOSITORY_INVALID", "Local GitHub repository identity is unavailable or invalid.");
  }
}

function childExitCode(options: StartLocalSessionOptions, sessionId: string): Promise<number> {
  const spawnChild = options.spawnChild ?? spawn;
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(options.environment)) {
    if (!CHILD_ENVIRONMENT_DENYLIST.has(name) && value !== undefined) childEnvironment[name] = value;
  }
  childEnvironment.INARI_SESSION_ID = sessionId;
  return new Promise((resolve, reject) => {
    const child = spawnChild(options.command, [...options.commandArgs], {
      cwd: options.cwd,
      env: childEnvironment,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

/** Issue/reuse one bounded Session binding through Admission and launch the exact child argv. */
export async function startLocalSession(options: StartLocalSessionOptions): Promise<number> {
  validateIssue(options.issue);
  if (options.command.length === 0) fail("ADMISSION_SESSION_COMMAND_REQUIRED", "A command after -- is required.");

  const inheritedSessionId = options.environment.INARI_SESSION_ID;
  if (inheritedSessionId !== undefined) validateSessionId(inheritedSessionId);
  const sessionId = inheritedSessionId ?? generateSessionId();

  const now = options.now ?? new Date();
  let binding = readLocalSessionBinding(sessionId, options.environment);
  if (binding !== undefined) {
    if (binding.task.number !== options.issue) {
      fail("ADMISSION_SESSION_BINDING_MISMATCH", "Selected Session is bound to a different Issue.");
    }
    const localRepository = resolveLocalRepositoryNameWithOwner(options.cwd);
    if (localRepository?.toLocaleLowerCase("en-US") !== binding.repository.name.toLocaleLowerCase("en-US")) {
      fail("ADMISSION_SESSION_REPOSITORY_MISMATCH", "Local repository does not match the selected Session.");
    }
  } else {
    const repository = await options.resolveRepository();
    validateRepositoryIdentity(repository);
    binding = createBinding(sessionId, options.issue, repository, options.cwd, options.environment, now);
  }

  const stored = storeLocalSessionBinding(binding, options.environment);
  if (stored.sessionId !== sessionId || stored.task.number !== options.issue) {
    fail("ADMISSION_SESSION_BINDING_MISMATCH", "Stored Session binding does not match the requested Session.");
  }
  await ensureLocalSessionChangeIssueProvenance(stored, options.environment, now);
  const registration = await options.admission.registerSession(stored);
  if (registration.id !== sessionId || registration.status !== "active") {
    fail("ADMISSION_SESSION_REGISTRATION_FAILED", "Admission did not register the selected Session as active.");
  }
  return childExitCode(options, sessionId);
}

/** Close only the binding selected by inherited INARI_SESSION_ID; private Authority material is not read. */
export async function closeLocalSession(options: {
  readonly environment: NodeJS.ProcessEnv;
  readonly admission: LocalAdmissionClient;
}): Promise<{ readonly id: string; readonly status: string }> {
  const sessionId = options.environment.INARI_SESSION_ID;
  if (sessionId === undefined || sessionId.length === 0) {
    fail("ADMISSION_SESSION_SELECTOR_REQUIRED", "session close requires inherited INARI_SESSION_ID.");
  }
  validateSessionId(sessionId);
  const binding = readLocalSessionBinding(sessionId, options.environment);
  if (binding === undefined || binding.sessionId !== sessionId) {
    fail("ADMISSION_SESSION_BINDING_NOT_FOUND", "No local binding exists for the selected Session.");
  }
  return options.admission.closeSession(binding);
}
