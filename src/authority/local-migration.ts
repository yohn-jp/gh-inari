/**
 * Recoverable local configuration migration and canonical Admission rebind (#1116).
 *
 * Local-only. The migration accepts an already adopted #1115 Runtime Authority
 * record plus the repository Runtime profile. It never selects, publishes or
 * rotates repository trust and never generates a key.
 *
 * Preview is read-only and returns a secret-free generation bound to the exact
 * owned local state. Apply requires explicit confirmation and that exact
 * generation, rereads every owned input before the first write, and performs
 * atomic, individually verified steps. After any failure it rereads state and
 * reports what is observably complete; it never claims a rollback.
 */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import {
  DelegatorKeyError,
  delegatorPublicKeyFingerprint,
  loadDelegatorKeyPair,
} from "../agent-authority/delegator-key.js";
import { canonicalDelegatorJson, validateDelegator, type Delegator } from "../agent-authority/delegator.js";
import {
  localComponentPath,
  readExistingLocalJson,
  replaceLocalJsonIfCurrent,
  validateLocalAdmissionConfig,
  validateLocalAuthorityConfig,
  validateLocalCliConfig,
  validateLocalComponentIdentity,
  validateLocalExecutorConfig,
  writeLocalJson,
  type LocalAdmissionConfig,
  type LocalAuthorityConfig,
  type LocalCliConfig,
  type LocalComponent,
  type LocalConfigValidator,
  type LocalExecutorConfig,
} from "../local-control/config.js";
import { bindLocalAuthorityDescriptor, copyLocalAuthorityKey } from "../local-control/identity.js";
import { validateLocalRuntimeEndpoint, type LocalRuntimeEndpoint } from "../local-control/runtime-discovery.js";
import {
  LocalRuntimeProfileStore,
  validateLocalRuntimeProfile,
  type LocalRuntimeProfile,
} from "../local-runtime-profile.js";

export const LOCAL_CONFIG_MIGRATION_VERSION = 1 as const;
/** Recovery evidence lives under `authority/migrations/<generation-hex>/`. */
export const LOCAL_CONFIG_MIGRATION_DIRECTORY = "migrations" as const;

/** Ordered apply steps. The Runtime profile is always last. */
export const LOCAL_CONFIG_MIGRATION_STEPS = Object.freeze([
  "recovery-evidence",
  "authority-key",
  "authority-descriptor",
  "cli-route",
  "admission-config",
  "admission-pin",
  "runtime-profile",
] as const);
export type LocalConfigMigrationStep = (typeof LOCAL_CONFIG_MIGRATION_STEPS)[number];

export type LocalConfigMigrationBlockerCode =
  | "ADOPTED_AUTHORITY_INVALID"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_AMBIGUOUS"
  | "AUTHORITY_IDENTITY_CONFLICT"
  | "LOCAL_STATE_UNREADABLE"
  | "RUNTIME_ACTIVE"
  | "AUTHORITY_KEY_UNAVAILABLE"
  | "AUTHORITY_KEY_CONFLICT"
  | "AUTHORITY_DESCRIPTOR_CONFLICT"
  | "COMPONENT_IDENTITY_UNPROVEN"
  | "TRUST_CHANGE_REQUIRED";

export interface LocalConfigMigrationBlocker {
  readonly code: LocalConfigMigrationBlockerCode;
  /** Secret-free subject, such as `admission/config.json` or `executor`. */
  readonly subject: string;
}

export type LocalConfigMigrationOperatorAction = "stop-runtime" | "restart-runtime" | "close-existing-sessions";

type Presence<T> = T | "absent" | "unreadable";

/** Secret-free evidence of every owned input. Its digest is the migration generation. */
export interface LocalConfigMigrationEvidence {
  readonly version: typeof LOCAL_CONFIG_MIGRATION_VERSION;
  readonly repository: { readonly repositoryHost: string; readonly repositoryId: string };
  readonly endpoint: string;
  readonly adoptedAuthority: {
    readonly authorityId: string;
    readonly publicKeyFingerprint: string;
    readonly recordDigest: string;
  };
  readonly profile: Presence<{
    readonly digest: string;
    readonly state: LocalRuntimeProfile["state"];
    readonly authorityId: string;
    readonly publicKeyFingerprint: string;
    readonly privateKeyPath: string;
  }>;
  readonly profileSelection: "unique" | "ambiguous";
  readonly authority: {
    /** Public fingerprints only; private-key bytes are never read into evidence. */
    readonly custodyKey: Presence<string>;
    readonly profileKey: Presence<string>;
    readonly descriptor: Presence<{ readonly digest: string; readonly publicKeyFingerprint: string }>;
  };
  readonly cli: Presence<{
    readonly digest: string;
    readonly admissionId: string | null;
    readonly legacyAdmissionEndpoint: string | null;
  }>;
  readonly admission: {
    readonly config: Presence<{
      readonly digest: string;
      readonly id: string;
      readonly executorId: string;
      readonly legacyExecutorEndpoint: string | null;
    }>;
    readonly identity: Presence<string>;
    readonly pin: Presence<{
      readonly digest: string;
      readonly authorityId: string;
      readonly publicKeyFingerprint: string;
    }>;
  };
  readonly executor: {
    readonly config: Presence<{ readonly digest: string; readonly id: string }>;
    readonly identity: Presence<string>;
  };
  readonly runtime: {
    readonly admission: Presence<"announced">;
    readonly executor: Presence<"announced">;
  };
}

export type LocalConfigMigrationPreviewStatus = "ready" | "migrated" | "blocked";

export interface LocalConfigMigrationPreview {
  readonly version: typeof LOCAL_CONFIG_MIGRATION_VERSION;
  readonly status: LocalConfigMigrationPreviewStatus;
  /** `sha256:<hex>` over the canonical secret-free evidence. */
  readonly generation: string;
  readonly steps: readonly LocalConfigMigrationStep[];
  readonly blockers: readonly LocalConfigMigrationBlocker[];
  readonly operatorActions: readonly LocalConfigMigrationOperatorAction[];
  readonly evidence: LocalConfigMigrationEvidence;
}

export interface LocalConfigMigrationRequest {
  /** Exact Runtime profile identity being migrated. */
  readonly identity: Pick<LocalRuntimeProfile, "endpoint" | "repository">;
  /** Runtime Authority record already selected/adopted by #1115 (`selectSetupAuthority`). */
  readonly adoptedAuthority: Delegator;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface LocalConfigMigrationApplyRequest extends LocalConfigMigrationRequest {
  /** Exact generation returned by the preview being confirmed. */
  readonly generation: string;
  /** Explicit operator confirmation. */
  readonly confirm: boolean;
  /** Test-only failure injection before each step; production callers omit it. */
  readonly faults?: { readonly beforeStep?: (step: LocalConfigMigrationStep) => void };
}

export type LocalConfigMigrationApplyStatus = "unconfirmed" | "stale" | "blocked" | "migrated" | "recovery-required";

export interface LocalConfigMigrationApplyResult {
  readonly version: typeof LOCAL_CONFIG_MIGRATION_VERSION;
  readonly status: LocalConfigMigrationApplyStatus;
  /** Ready only when a reread proves every owned record is migrated. */
  readonly ready: boolean;
  readonly generation: string;
  /** Generation of the state observed by the final reread. */
  readonly currentGeneration?: string;
  /** Planned steps whose outcome a reread observes as complete. */
  readonly completedSteps: readonly LocalConfigMigrationStep[];
  readonly pendingSteps: readonly LocalConfigMigrationStep[];
  readonly failedStep?: LocalConfigMigrationStep;
  readonly failureCode?: string;
  /** True only when a reread proves the owned state still equals the confirmed pre-migration state. */
  readonly preMigrationStateIntact: boolean;
  readonly recoveryPath?: string;
  readonly blockers: readonly LocalConfigMigrationBlocker[];
  readonly operatorActions: readonly LocalConfigMigrationOperatorAction[];
}

interface Read<T> {
  readonly state: "present" | "absent" | "unreadable";
  readonly value?: T;
}

interface Observation {
  readonly environment: NodeJS.ProcessEnv;
  readonly adopted: Delegator;
  readonly adoptedFingerprint: string;
  readonly identity: LocalConfigMigrationRequest["identity"];
  readonly profile: Read<LocalRuntimeProfile>;
  readonly ambiguous: boolean;
  readonly custodyPath: string;
  readonly custodyKey: Presence<string>;
  readonly profileKey: Presence<string>;
  readonly descriptor: Read<LocalAuthorityConfig>;
  readonly cli: Read<LocalCliConfig>;
  readonly admissionConfig: Read<LocalAdmissionConfig>;
  readonly admissionIdentity: Read<{ readonly id: string }>;
  readonly pin: Read<Delegator>;
  readonly executorConfig: Read<LocalExecutorConfig>;
  readonly executorIdentity: Read<{ readonly id: string }>;
  readonly admissionAnnouncement: Read<LocalRuntimeEndpoint>;
  readonly executorAnnouncement: Read<LocalRuntimeEndpoint>;
}

interface Plan {
  readonly observation: Observation;
  readonly evidence: LocalConfigMigrationEvidence;
  readonly generation: string;
  readonly steps: readonly LocalConfigMigrationStep[];
  readonly blockers: readonly LocalConfigMigrationBlocker[];
}

export class LocalConfigMigrationError extends Error {
  readonly code: "ADOPTED_AUTHORITY_INVALID";

  constructor(code: "ADOPTED_AUTHORITY_INVALID", message: string) {
    super(message);
    this.name = "LocalConfigMigrationError";
    this.code = code;
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function adoptedAuthority(input: unknown): Delegator {
  const result = validateDelegator(input);
  if (!result.valid || result.value === undefined)
    throw new LocalConfigMigrationError("ADOPTED_AUTHORITY_INVALID", "Adopted Runtime Authority record is invalid.");
  return result.value;
}

function pinValidator(value: unknown): Delegator {
  const result = validateDelegator(value);
  if (!result.valid || result.value === undefined) throw new Error("invalid pin");
  return result.value;
}

function identityValidator(kind: "admission" | "executor"): LocalConfigValidator<{ readonly id: string }> {
  return (value) => validateLocalComponentIdentity(value, kind);
}

function readOwned<T>(
  component: LocalComponent,
  relativePath: string,
  validator: LocalConfigValidator<T>,
  environment: NodeJS.ProcessEnv,
): Read<T> {
  try {
    const value = readExistingLocalJson(component, relativePath, validator, environment);
    return value === undefined ? { state: "absent" } : { state: "present", value };
  } catch {
    return { state: "unreadable" };
  }
}

/** Public fingerprint of a key file; key bytes stay inside the key loader. */
function keyFingerprint(filePath: string): Presence<string> {
  try {
    lstatSync(filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    return "unreadable";
  }
  try {
    return delegatorPublicKeyFingerprint(loadDelegatorKeyPair(filePath));
  } catch (error: unknown) {
    if (error instanceof DelegatorKeyError && error.code === "RUNTIME_AUTHORITY_KEY_NOT_FOUND") return "absent";
    return "unreadable";
  }
}

function presence<T, U>(read: Read<T>, project: (value: T) => U): Presence<U> {
  if (read.state === "present" && read.value !== undefined) return project(read.value);
  return read.state === "unreadable" ? "unreadable" : "absent";
}

async function observe(request: LocalConfigMigrationRequest): Promise<Observation> {
  const environment = request.environment ?? process.env;
  const adopted = adoptedAuthority(request.adoptedAuthority);
  const store = new LocalRuntimeProfileStore({ environment });
  let profile: Read<LocalRuntimeProfile>;
  try {
    const value = await store.load(request.identity);
    profile = value === undefined ? { state: "absent" } : { state: "present", value };
  } catch {
    profile = { state: "unreadable" };
  }
  let ambiguous = false;
  try {
    const selected = await store.findForRepository(request.identity.repository);
    if (selected !== undefined && selected.endpoint !== request.identity.endpoint) ambiguous = true;
  } catch {
    ambiguous = true;
  }
  const custodyPath = localComponentPath("authority", "private-key.pem", environment);
  const profileKeyPath = profile.value?.authority.privateKeyPath;
  const custodyKey = keyFingerprint(custodyPath);
  return {
    environment,
    adopted,
    adoptedFingerprint: delegatorPublicKeyFingerprint(adopted.key),
    identity: request.identity,
    profile,
    ambiguous,
    custodyPath,
    custodyKey,
    profileKey:
      profileKeyPath === undefined
        ? "absent"
        : profileKeyPath === custodyPath
          ? custodyKey
          : keyFingerprint(profileKeyPath),
    descriptor: readOwned("authority", "config.json", validateLocalAuthorityConfig, environment),
    cli: readOwned("cli", "config.json", validateLocalCliConfig, environment),
    admissionConfig: readOwned("admission", "config.json", validateLocalAdmissionConfig, environment),
    admissionIdentity: readOwned("admission", "identity.json", identityValidator("admission"), environment),
    pin: readOwned("admission", "runtime-authority.json", pinValidator, environment),
    executorConfig: readOwned("executor", "config.json", validateLocalExecutorConfig, environment),
    executorIdentity: readOwned("executor", "identity.json", identityValidator("executor"), environment),
    admissionAnnouncement: readOwned("runtime", "endpoints/admission.json", validateLocalRuntimeEndpoint, environment),
    executorAnnouncement: readOwned("runtime", "endpoints/executor.json", validateLocalRuntimeEndpoint, environment),
  };
}

function evidenceOf(observation: Observation): LocalConfigMigrationEvidence {
  const { adopted } = observation;
  return {
    version: LOCAL_CONFIG_MIGRATION_VERSION,
    repository: {
      repositoryHost: observation.identity.repository.repositoryHost,
      repositoryId: observation.identity.repository.repositoryId,
    },
    endpoint: observation.identity.endpoint,
    adoptedAuthority: {
      authorityId: adopted.id,
      publicKeyFingerprint: observation.adoptedFingerprint,
      recordDigest: digest(JSON.parse(canonicalDelegatorJson(adopted)) as unknown),
    },
    profile: presence(observation.profile, (profile) => ({
      digest: digest(profile),
      state: profile.state,
      authorityId: profile.authority.authorityId,
      publicKeyFingerprint: profile.authority.publicKeyFingerprint,
      privateKeyPath: profile.authority.privateKeyPath,
    })),
    profileSelection: observation.ambiguous ? "ambiguous" : "unique",
    authority: {
      custodyKey: observation.custodyKey,
      profileKey: observation.profileKey,
      descriptor: presence(observation.descriptor, (descriptor) => ({
        digest: digest(descriptor),
        publicKeyFingerprint: descriptor.publicKeyFingerprint,
      })),
    },
    cli: presence(observation.cli, (cli) => ({
      digest: digest(cli),
      admissionId: cli.admission?.id ?? null,
      legacyAdmissionEndpoint: cli.admission?.endpoint ?? null,
    })),
    admission: {
      config: presence(observation.admissionConfig, (config) => ({
        digest: digest(config),
        id: config.id,
        executorId: config.executor.id,
        legacyExecutorEndpoint: config.executor.endpoint ?? null,
      })),
      identity: presence(observation.admissionIdentity, (identity) => identity.id),
      pin: presence(observation.pin, (pin) => ({
        digest: digest(JSON.parse(canonicalDelegatorJson(pin)) as unknown),
        authorityId: pin.id,
        publicKeyFingerprint: delegatorPublicKeyFingerprint(pin.key),
      })),
    },
    executor: {
      config: presence(observation.executorConfig, (config) => ({ digest: digest(config), id: config.id })),
      identity: presence(observation.executorIdentity, (identity) => identity.id),
    },
    runtime: {
      admission: presence(observation.admissionAnnouncement, () => "announced" as const),
      executor: presence(observation.executorAnnouncement, () => "announced" as const),
    },
  };
}

function sameCeiling(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

/** Same Authority identity with unchanged immutable trust fields; only mutable lifecycle fields may differ. */
function sameImmutableTrust(pin: Delegator, adopted: Delegator): boolean {
  return (
    pin.id === adopted.id &&
    delegatorPublicKeyFingerprint(pin.key) === delegatorPublicKeyFingerprint(adopted.key) &&
    pin.notBefore === adopted.notBefore &&
    pin.maxSessionTtlSeconds === adopted.maxSessionTtlSeconds &&
    sameCeiling(pin.capabilityCeiling, adopted.capabilityCeiling)
  );
}

function planOf(observation: Observation): Plan {
  const evidence = evidenceOf(observation);
  const generation = digest(evidence);
  const blockers: LocalConfigMigrationBlocker[] = [];
  const steps = new Set<LocalConfigMigrationStep>();
  const block = (code: LocalConfigMigrationBlockerCode, subject: string): void => {
    blockers.push({ code, subject });
  };
  const { adopted, adoptedFingerprint } = observation;

  const unreadable: readonly [string, Read<unknown>][] = [
    ["runtime-profile", observation.profile],
    ["authority/config.json", observation.descriptor],
    ["cli/config.json", observation.cli],
    ["admission/config.json", observation.admissionConfig],
    ["admission/identity.json", observation.admissionIdentity],
    ["admission/runtime-authority.json", observation.pin],
    ["executor/config.json", observation.executorConfig],
    ["executor/identity.json", observation.executorIdentity],
  ];
  for (const [subject, read] of unreadable) if (read.state === "unreadable") block("LOCAL_STATE_UNREADABLE", subject);
  if (observation.custodyKey === "unreadable") block("LOCAL_STATE_UNREADABLE", "authority/private-key.pem");
  if (observation.profileKey === "unreadable") block("LOCAL_STATE_UNREADABLE", "runtime-profile-key");

  // Any announcement, including an unreadable one, means a Runtime may be live.
  if (observation.admissionAnnouncement.state !== "absent") block("RUNTIME_ACTIVE", "admission");
  if (observation.executorAnnouncement.state !== "absent") block("RUNTIME_ACTIVE", "executor");

  if (observation.ambiguous) block("PROFILE_AMBIGUOUS", "runtime-profile");
  const profile = observation.profile.value;
  if (observation.profile.state === "absent") block("PROFILE_NOT_FOUND", "runtime-profile");
  if (
    profile !== undefined &&
    (profile.authority.authorityId !== adopted.id || profile.authority.publicKeyFingerprint !== adoptedFingerprint)
  )
    block("AUTHORITY_IDENTITY_CONFLICT", "runtime-profile");

  // Key-path convergence: copy only a verified key; never generate or replace one.
  const { custodyKey, profileKey } = observation;
  if (typeof custodyKey === "string" && custodyKey.startsWith("sha256:")) {
    if (custodyKey !== adoptedFingerprint) block("AUTHORITY_KEY_CONFLICT", "authority/private-key.pem");
    else if (profileKey !== "absent" && profileKey !== "unreadable" && profileKey !== custodyKey)
      block("AUTHORITY_KEY_CONFLICT", "runtime-profile-key");
  } else if (custodyKey === "absent") {
    if (profileKey === "absent") block("AUTHORITY_KEY_UNAVAILABLE", "authority/private-key.pem");
    else if (profileKey !== "unreadable" && profileKey !== adoptedFingerprint)
      block("AUTHORITY_KEY_CONFLICT", "runtime-profile-key");
    else steps.add("authority-key");
  }
  const descriptor = observation.descriptor.value;
  if (descriptor !== undefined && descriptor.publicKeyFingerprint !== adoptedFingerprint)
    block("AUTHORITY_DESCRIPTOR_CONFLICT", "authority/config.json");
  if (observation.descriptor.state === "absent") steps.add("authority-descriptor");

  // Component identities must be proven equal before any endpoint field is dropped.
  const cli = observation.cli.value;
  const admission = observation.admissionConfig.value;
  const executor = observation.executorConfig.value;
  if (cli?.admission !== undefined) {
    if (admission === undefined || admission.id !== cli.admission.id)
      block("COMPONENT_IDENTITY_UNPROVEN", "cli/config.json");
    if (cli.admission.endpoint !== undefined) steps.add("cli-route");
  }
  if (admission !== undefined) {
    const admissionIdentity = observation.admissionIdentity.value;
    if (admissionIdentity !== undefined && admissionIdentity.id !== admission.id)
      block("COMPONENT_IDENTITY_UNPROVEN", "admission/identity.json");
    if (executor === undefined || executor.id !== admission.executor.id)
      block("COMPONENT_IDENTITY_UNPROVEN", "executor/config.json");
    if (admission.executor.endpoint !== undefined) steps.add("admission-config");
    const pin = observation.pin.value;
    if (pin !== undefined && !sameImmutableTrust(pin, adopted))
      block("TRUST_CHANGE_REQUIRED", "admission/runtime-authority.json");
    else if (
      observation.pin.state === "absent" ||
      (pin !== undefined && canonicalDelegatorJson(pin) !== canonicalDelegatorJson(adopted))
    )
      steps.add("admission-pin");
  } else if (observation.pin.state !== "absent") {
    block("COMPONENT_IDENTITY_UNPROVEN", "admission/config.json");
  }
  const executorIdentity = observation.executorIdentity.value;
  if (executor !== undefined && executorIdentity !== undefined && executorIdentity.id !== executor.id)
    block("COMPONENT_IDENTITY_UNPROVEN", "executor/identity.json");

  if (profile !== undefined && profile.authority.privateKeyPath !== observation.custodyPath)
    steps.add("runtime-profile");
  if (
    ["cli-route", "admission-config", "admission-pin", "runtime-profile"].some((step) =>
      steps.has(step as LocalConfigMigrationStep),
    )
  )
    steps.add("recovery-evidence");

  return {
    observation,
    evidence,
    generation,
    steps: LOCAL_CONFIG_MIGRATION_STEPS.filter((step) => steps.has(step)),
    blockers,
  };
}

function statusOf(plan: Plan): LocalConfigMigrationPreviewStatus {
  if (plan.blockers.length > 0) return "blocked";
  return plan.steps.length === 0 ? "migrated" : "ready";
}

function previewActions(plan: Plan): readonly LocalConfigMigrationOperatorAction[] {
  return plan.blockers.some((blocker) => blocker.code === "RUNTIME_ACTIVE") ? ["stop-runtime"] : [];
}

/** Read-only, secret-free preview bound to the exact current owned local state. */
export async function previewLocalConfigMigration(
  request: LocalConfigMigrationRequest,
): Promise<LocalConfigMigrationPreview> {
  const plan = planOf(await observe(request));
  return {
    version: LOCAL_CONFIG_MIGRATION_VERSION,
    status: statusOf(plan),
    generation: plan.generation,
    steps: plan.steps,
    blockers: plan.blockers,
    operatorActions: previewActions(plan),
    evidence: plan.evidence,
  };
}

// ---------------------------------------------------------------------------
// Recovery evidence

interface RecoveryManifest {
  readonly version: typeof LOCAL_CONFIG_MIGRATION_VERSION;
  readonly generation: string;
  readonly steps: readonly LocalConfigMigrationStep[];
  /** Exact Inari-owned records copied before replacement, mapped to their copy names. */
  readonly copies: readonly { readonly record: string; readonly copy: string }[];
  /** Prior key reference; the key file itself is retained in place and never copied here. */
  readonly retainedPrivateKeyPath: string | null;
}

function validateRecoveryManifest(value: unknown): RecoveryManifest {
  const fail = (): never => {
    throw new Error("invalid recovery manifest");
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !["version", "generation", "steps", "copies", "retainedPrivateKeyPath"].includes(key),
    ) ||
    record.version !== LOCAL_CONFIG_MIGRATION_VERSION ||
    typeof record.generation !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.generation) ||
    !Array.isArray(record.steps) ||
    !record.steps.every((step) => (LOCAL_CONFIG_MIGRATION_STEPS as readonly unknown[]).includes(step)) ||
    !Array.isArray(record.copies) ||
    record.copies.length > 4 ||
    !record.copies.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).record === "string" &&
        typeof (entry as Record<string, unknown>).copy === "string" &&
        Object.keys(entry).length === 2,
    ) ||
    (record.retainedPrivateKeyPath !== null && typeof record.retainedPrivateKeyPath !== "string")
  )
    return fail();
  return {
    version: LOCAL_CONFIG_MIGRATION_VERSION,
    generation: record.generation,
    steps: record.steps as LocalConfigMigrationStep[],
    copies: (record.copies as { record: string; copy: string }[]).map((entry) => ({
      record: entry.record,
      copy: entry.copy,
    })),
    retainedPrivateKeyPath: record.retainedPrivateKeyPath as string | null,
  };
}

function recoveryDirectory(generation: string): string {
  return `${LOCAL_CONFIG_MIGRATION_DIRECTORY}/${generation.slice("sha256:".length)}`;
}

function recoveryPath(generation: string, environment: NodeJS.ProcessEnv): string {
  return localComponentPath("authority", recoveryDirectory(generation), environment);
}

/** Persist bounded copies of exactly the owned public/config records this plan replaces. */
function persistRecoveryEvidence(plan: Plan): void {
  const { observation } = plan;
  const { environment } = observation;
  const directory = recoveryDirectory(plan.generation);
  const copies: { record: string; copy: string }[] = [];
  const cli = observation.cli.value;
  if (plan.steps.includes("cli-route") && cli !== undefined) {
    writeLocalJson("authority", `${directory}/cli-config.json`, cli, validateLocalCliConfig, environment);
    copies.push({ record: "cli/config.json", copy: "cli-config.json" });
  }
  const admission = observation.admissionConfig.value;
  if (plan.steps.includes("admission-config") && admission !== undefined) {
    writeLocalJson(
      "authority",
      `${directory}/admission-config.json`,
      admission,
      validateLocalAdmissionConfig,
      environment,
    );
    copies.push({ record: "admission/config.json", copy: "admission-config.json" });
  }
  const pin = observation.pin.value;
  if (plan.steps.includes("admission-pin") && pin !== undefined) {
    writeLocalJson("authority", `${directory}/admission-runtime-authority.json`, pin, pinValidator, environment);
    copies.push({ record: "admission/runtime-authority.json", copy: "admission-runtime-authority.json" });
  }
  const profile = observation.profile.value;
  if (plan.steps.includes("runtime-profile") && profile !== undefined) {
    writeLocalJson("authority", `${directory}/runtime-profile.json`, profile, validateLocalRuntimeProfile, environment);
    copies.push({ record: "runtime-profile", copy: "runtime-profile.json" });
  }
  // The manifest is written last: its presence means the evidence set is complete.
  writeLocalJson(
    "authority",
    `${directory}/manifest.json`,
    {
      version: LOCAL_CONFIG_MIGRATION_VERSION,
      generation: plan.generation,
      steps: plan.steps,
      copies,
      retainedPrivateKeyPath: profile?.authority.privateKeyPath ?? null,
    },
    validateRecoveryManifest,
    environment,
  );
}

function recoveryEvidenceComplete(generation: string, environment: NodeJS.ProcessEnv): boolean {
  try {
    return (
      readExistingLocalJson(
        "authority",
        `${recoveryDirectory(generation)}/manifest.json`,
        validateRecoveryManifest,
        environment,
      )?.generation === generation
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Apply

class StepVerificationError extends Error {
  readonly code = "OWNER_STATE_UNVERIFIED";
}

async function runStep(step: LocalConfigMigrationStep, plan: Plan): Promise<void> {
  const { observation } = plan;
  const { environment, adopted, adoptedFingerprint } = observation;
  switch (step) {
    case "recovery-evidence":
      persistRecoveryEvidence(plan);
      return;
    case "authority-key": {
      const source = observation.profile.value?.authority.privateKeyPath;
      if (source === undefined) throw new StepVerificationError("Runtime profile key reference is unavailable.");
      copyLocalAuthorityKey(source, adoptedFingerprint, environment);
      return;
    }
    case "authority-descriptor":
      bindLocalAuthorityDescriptor(adoptedFingerprint, environment);
      return;
    case "cli-route": {
      const cli = observation.cli.value;
      if (cli?.admission === undefined) throw new StepVerificationError("CLI route is unavailable.");
      replaceLocalJsonIfCurrent(
        "cli",
        "config.json",
        cli,
        { ...cli, admission: { id: cli.admission.id } },
        validateLocalCliConfig,
        environment,
      );
      return;
    }
    case "admission-config": {
      const config = observation.admissionConfig.value;
      if (config === undefined) throw new StepVerificationError("Admission configuration is unavailable.");
      replaceLocalJsonIfCurrent(
        "admission",
        "config.json",
        config,
        { ...config, executor: { id: config.executor.id } },
        validateLocalAdmissionConfig,
        environment,
      );
      return;
    }
    case "admission-pin":
      replaceLocalJsonIfCurrent(
        "admission",
        "runtime-authority.json",
        observation.pin.value,
        adopted,
        pinValidator,
        environment,
      );
      return;
    case "runtime-profile": {
      // Owner config and pin state must reread as migrated before the profile moves.
      const reread = planOf(await observe({ identity: observation.identity, adoptedAuthority: adopted, environment }));
      if (
        reread.blockers.length > 0 ||
        reread.steps.some((pending) => pending !== "runtime-profile" && pending !== "recovery-evidence") ||
        reread.evidence.profile === "absent" ||
        reread.evidence.profile === "unreadable" ||
        plan.evidence.profile === "absent" ||
        plan.evidence.profile === "unreadable" ||
        reread.evidence.profile.digest !== plan.evidence.profile.digest
      )
        throw new StepVerificationError("Owner configuration does not reread as migrated.");
      const profile = observation.profile.value;
      if (profile === undefined) throw new StepVerificationError("Runtime profile is unavailable.");
      await new LocalRuntimeProfileStore({ environment }).replace(profile, {
        ...profile,
        authority: { ...profile.authority, privateKeyPath: observation.custodyPath },
      });
      return;
    }
  }
}

/** Whether a reread observes the outcome of a planned step. */
function stepObserved(step: LocalConfigMigrationStep, original: Plan, reread: Plan): boolean {
  if (step === "recovery-evidence")
    return recoveryEvidenceComplete(original.generation, original.observation.environment);
  return !reread.steps.includes(step);
}

function failureCode(error: unknown): string {
  if (error instanceof StepVerificationError) return error.code;
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return "MIGRATION_STEP_FAILED";
}

/** Apply a confirmed preview generation. Never kills processes, deletes files or generates keys. */
export async function applyLocalConfigMigration(
  request: LocalConfigMigrationApplyRequest,
): Promise<LocalConfigMigrationApplyResult> {
  const base = {
    version: LOCAL_CONFIG_MIGRATION_VERSION,
    generation: request.generation,
    completedSteps: [],
    pendingSteps: [],
    preMigrationStateIntact: true,
    blockers: [],
    operatorActions: [],
  } as const;
  if (request.confirm !== true) return { ...base, status: "unconfirmed", ready: false };

  // Reread every owned input immediately before the first write.
  const plan = planOf(await observe(request));
  if (plan.generation !== request.generation)
    return { ...base, status: "stale", ready: false, currentGeneration: plan.generation, pendingSteps: plan.steps };
  const status = statusOf(plan);
  if (status === "blocked")
    return {
      ...base,
      status: "blocked",
      ready: false,
      currentGeneration: plan.generation,
      pendingSteps: plan.steps,
      blockers: plan.blockers,
      operatorActions: previewActions(plan),
    };
  if (status === "migrated") return { ...base, status: "migrated", ready: true, currentGeneration: plan.generation };

  let failedStep: LocalConfigMigrationStep | undefined;
  let failure: string | undefined;
  for (const step of plan.steps) {
    try {
      request.faults?.beforeStep?.(step);
      await runStep(step, plan);
    } catch (error: unknown) {
      failedStep = step;
      failure = failureCode(error);
      break;
    }
  }

  // The reread, not the attempted writes, determines the reported state.
  let reread: Plan;
  try {
    reread = planOf(await observe(request));
  } catch {
    return {
      ...base,
      status: "recovery-required",
      ready: false,
      completedSteps: [],
      pendingSteps: plan.steps,
      ...(failedStep === undefined ? {} : { failedStep }),
      failureCode: failure ?? "MIGRATION_REREAD_FAILED",
      preMigrationStateIntact: false,
      recoveryPath: recoveryPath(plan.generation, plan.observation.environment),
    };
  }
  const completedSteps = plan.steps.filter((step) => stepObserved(step, plan, reread));
  const pendingSteps = plan.steps.filter((step) => !completedSteps.includes(step));
  const migrated = statusOf(reread) === "migrated";
  const recovery = plan.steps.includes("recovery-evidence")
    ? { recoveryPath: recoveryPath(plan.generation, plan.observation.environment) }
    : {};
  if (failedStep === undefined && migrated)
    return {
      ...base,
      status: "migrated",
      ready: true,
      currentGeneration: reread.generation,
      completedSteps,
      pendingSteps,
      preMigrationStateIntact: false,
      operatorActions: ["restart-runtime", "close-existing-sessions"],
      ...recovery,
    };
  return {
    ...base,
    status: "recovery-required",
    ready: false,
    currentGeneration: reread.generation,
    completedSteps,
    pendingSteps,
    ...(failedStep === undefined ? {} : { failedStep }),
    failureCode: failure ?? "MIGRATION_NOT_CONVERGED",
    preMigrationStateIntact: reread.generation === plan.generation,
    blockers: reread.blockers,
    operatorActions: previewActions(reread),
    ...recovery,
  };
}
