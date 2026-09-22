/**
 * Provider-neutral release preparation planning.
 *
 * This module only validates repository evidence and projects a deterministic
 * release plan. It never reads or writes files, invokes Git, or mutates a
 * provider. Provider adapters supply the history evidence consumed here.
 */

import { createHash } from "node:crypto";
import { deriveReleasePrPublicationRoute, type ReleasePrPublicationRoute } from "./release-pr-publication.js";

export const RELEASE_PREPARATION_PLAN_VERSION = "1" as const;
export type ReleasePreparationPlanVersion = typeof RELEASE_PREPARATION_PLAN_VERSION;

export const RELEASE_PREPARATION_PLAN_KIND = "release-preparation" as const;

export const RELEASE_VERSION_ARTIFACT_KINDS = Object.freeze([
  "package",
  "lockfile",
  "codex-plugin",
  "marketplace",
] as const);
export type ReleaseVersionArtifactKind = (typeof RELEASE_VERSION_ARTIFACT_KINDS)[number];

export const RELEASE_VERSION_FORMATS = Object.freeze(["exact", "caret"] as const);
export type ReleaseVersionFormat = (typeof RELEASE_VERSION_FORMATS)[number];

export type ReleaseVersionIntentKind = "patch" | "minor" | "major" | "exact";

export interface ReleaseVersionIntent {
  readonly kind: ReleaseVersionIntentKind;
  /** Required only for an exact intent. */
  readonly version?: string;
}

export interface ReleasePreviousIdentity {
  readonly tag: string;
  readonly version: string;
  readonly sourceRevision: string;
}

export interface ReleaseTargetSourceIdentity {
  readonly ref: string;
  readonly sourceRevision: string;
}

/** One merged, provider-admitted change in the bounded release range. */
export interface ReleaseGovernedMergedChange {
  readonly number: number;
  readonly title: string;
  readonly mergeCommitSha: string;
  readonly mergedAt: string;
  /** The provider adapter marks evidence that passed its governed filter. */
  readonly governed?: boolean;
  readonly sourceIssueNumbers?: readonly number[];
}

/** Read-only history evidence supplied by a Git/repository evidence port. */
export interface ReleaseHistoryEvidence {
  readonly previousRelease: ReleasePreviousIdentity;
  readonly targetSource: ReleaseTargetSourceIdentity;
  readonly includedChanges: readonly ReleaseGovernedMergedChange[];
}

/** Repository-declared location and representation of one version value. */
export interface ReleaseVersionBearingArtifact {
  readonly path: string;
  readonly kind: ReleaseVersionArtifactKind;
  readonly field: string;
  readonly currentValue: string;
  readonly format: ReleaseVersionFormat;
}

export interface ReleaseVerificationPrerequisite {
  readonly command: string;
  readonly args: readonly string[];
}

/** Repository-declared configuration for the Issue-less release route. */
export interface ReleasePublicationContract {
  readonly kind: "release-pr-publication";
  readonly role: "release";
  readonly base: "main";
  readonly template: "release";
}

/** Target-bound Issue-less release publication identity. */
export type ReleasePublicationPrerequisite = ReleasePrPublicationRoute & {
  readonly template: "release";
};

/** Repository-specific release configuration; no product prose is embedded. */
export interface ReleasePreparationRepositoryContract {
  readonly packageName: string;
  readonly currentVersion: string;
  readonly versionBearingArtifacts: readonly ReleaseVersionBearingArtifact[];
  readonly releaseDocumentDirectory: string;
  readonly verification: ReleaseVerificationPrerequisite;
  readonly publication: ReleasePublicationContract;
}

export interface PreparedReleaseIdentity {
  readonly targetVersion: string;
  readonly sourceRevision: string;
}

/** Optional existing prepared state. A mismatch fails closed. */
export interface ExistingPreparedRelease {
  readonly targetVersion: string;
  readonly sourceRevision: string;
}

export interface ReleasePreparationPlanInput {
  readonly history: ReleaseHistoryEvidence;
  readonly intent: ReleaseVersionIntent | ReleaseVersionIntentKind;
  readonly repository: ReleasePreparationRepositoryContract;
  readonly existingPreparedRelease?: ExistingPreparedRelease;
}

export interface ReleaseVersionArtifactTarget extends ReleaseVersionBearingArtifact {
  readonly targetValue: string;
}

export interface ReleaseDocumentTarget {
  readonly path: string;
  readonly version: string;
}

export interface ReleasePreparationPlan {
  readonly version: ReleasePreparationPlanVersion;
  readonly kind: typeof RELEASE_PREPARATION_PLAN_KIND;
  readonly identity: {
    readonly previousRelease: ReleasePreviousIdentity;
    readonly targetSource: ReleaseTargetSourceIdentity;
    readonly targetVersion: string;
  };
  readonly intent: ReleaseVersionIntent;
  readonly includedChanges: readonly ReleaseGovernedMergedChange[];
  readonly versionArtifacts: readonly ReleaseVersionArtifactTarget[];
  readonly releaseDocument: ReleaseDocumentTarget;
  readonly verification: ReleaseVerificationPrerequisite;
  readonly publication: ReleasePublicationPrerequisite;
  /** SHA-256 of the canonical plan excluding this digest field. */
  readonly digest: string;
}

export type ReleasePreparationPlanViolationCode =
  | "INPUT_INVALID"
  | "HISTORY_INVALID"
  | "HISTORY_AMBIGUOUS"
  | "INTENT_INVALID"
  | "VERSION_INVALID"
  | "REPOSITORY_CONTRACT_INVALID"
  | "TARGET_CONFLICT"
  | "PLAN_INVALID";

export interface ReleasePreparationPlanViolation {
  readonly code: ReleasePreparationPlanViolationCode;
  readonly path: string;
  readonly message: string;
}

export interface ReleasePreparationPlanResult {
  readonly valid: boolean;
  readonly plan?: ReleasePreparationPlan;
  readonly violations: readonly ReleasePreparationPlanViolation[];
}

export interface ReleaseHistoryEvidencePort {
  readReleaseHistory(options?: ReleaseHistoryReadOptions): Promise<ReleaseHistoryEvidence>;
}

export interface ReleaseHistoryReadOptions {
  readonly targetRef?: string;
}

/** Alias used by callers that refer to the repository evidence seam as a port. */
export type ReleaseHistoryPort = ReleaseHistoryEvidencePort;

export class ReleasePreparationPlanError extends Error {
  readonly violations: readonly ReleasePreparationPlanViolation[];

  constructor(violations: readonly ReleasePreparationPlanViolation[]) {
    super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
    this.name = "ReleasePreparationPlanError";
    this.violations = violations;
  }
}

const MAX_STRING_LENGTH = 512;
const MAX_CHANGE_TITLE_LENGTH = 512;
const MAX_CHANGES = 100;
const MAX_SOURCE_ISSUES = 32;
const SHA_PATTERN = /^[0-9a-f]{7,128}$/iu;
const VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PATH_PATTERN = /^[^\u0000-\u001f\u007f/][^\u0000-\u001f\u007f]*$/u;
const SAFE_FIELD_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en-US");
}

function addViolation(
  violations: ReleasePreparationPlanViolation[],
  code: ReleasePreparationPlanViolationCode,
  path: string,
  message: string,
): void {
  violations.push({ code, path, message });
}

function stableSerialize(value: unknown, stack = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite numbers are not supported.");
    return String(value);
  }
  if (typeof value === "undefined") throw new TypeError("Undefined values are not supported.");
  if (typeof value !== "object") throw new TypeError("Only JSON-compatible values are supported.");
  if (stack.has(value)) throw new TypeError("Cyclic JSON data is not supported.");
  stack.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((entry) => stableSerialize(entry, stack)).join(",")}]`;
  } else if (isRecord(value)) {
    result = `{${Object.keys(value)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], stack)}`)
      .join(",")}}`;
  } else {
    throw new TypeError("Only plain JSON objects are supported.");
  }
  stack.delete(value);
  return result;
}

function cloneImmutable<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => cloneImmutable(entry))) as T;
  if (isRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareStrings)) clone[key] = cloneImmutable(value[key]);
    return Object.freeze(clone) as T;
  }
  return value;
}

function boundedString(
  value: unknown,
  path: string,
  violations: ReleasePreparationPlanViolation[],
  maximum = MAX_STRING_LENGTH,
): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !SAFE_FIELD_PATTERN.test(value)) {
    addViolation(violations, "INPUT_INVALID", path, "Expected a non-empty bounded string.");
    return undefined;
  }
  return value;
}

function validVersion(value: unknown, path: string, violations: ReleasePreparationPlanViolation[]): string | undefined {
  const version = boundedString(value, path, violations);
  if (version !== undefined && !VERSION_PATTERN.test(version)) {
    addViolation(violations, "VERSION_INVALID", path, "Expected a strict semantic version.");
    return undefined;
  }
  return version;
}

function validSha(value: unknown, path: string, violations: ReleasePreparationPlanViolation[]): string | undefined {
  const sha = boundedString(value, path, violations, 128);
  if (sha !== undefined && !SHA_PATTERN.test(sha)) {
    addViolation(violations, "HISTORY_INVALID", path, "Expected a hexadecimal Git revision.");
    return undefined;
  }
  return sha;
}

function validRepositoryPath(
  value: unknown,
  path: string,
  violations: ReleasePreparationPlanViolation[],
): string | undefined {
  const candidate = boundedString(value, path, violations);
  if (candidate !== undefined && (!PATH_PATTERN.test(candidate) || candidate.includes(".."))) {
    addViolation(violations, "REPOSITORY_CONTRACT_INVALID", path, "Repository path must be relative and safe.");
    return undefined;
  }
  return candidate;
}

function validTimestamp(
  value: unknown,
  path: string,
  violations: ReleasePreparationPlanViolation[],
): string | undefined {
  const timestamp = boundedString(value, path, violations, 64);
  if (timestamp !== undefined && (!timestamp.endsWith("Z") || !Number.isFinite(Date.parse(timestamp)))) {
    addViolation(violations, "HISTORY_INVALID", path, "Expected an ISO timestamp.");
    return undefined;
  }
  return timestamp;
}

function normalizeIntent(
  value: unknown,
  violations: ReleasePreparationPlanViolation[],
): ReleaseVersionIntent | undefined {
  const input = typeof value === "string" ? { kind: value } : value;
  if (!isRecord(input)) {
    addViolation(violations, "INTENT_INVALID", "$.intent", "Release intent must be patch, minor, major, or exact.");
    return undefined;
  }
  const kind = input.kind;
  if (kind !== "patch" && kind !== "minor" && kind !== "major" && kind !== "exact") {
    addViolation(violations, "INTENT_INVALID", "$.intent.kind", "Release intent kind is unsupported.");
    return undefined;
  }
  if (kind !== "exact") {
    if (input.version !== undefined) {
      addViolation(violations, "INTENT_INVALID", "$.intent.version", "Bump intents must not include an exact version.");
    }
    return { kind };
  }
  const version = validVersion(input.version, "$.intent.version", violations);
  if (version === undefined) return undefined;
  return { kind, version };
}

function parseBaseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (match === null) throw new Error("validated semantic version did not parse");
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function targetVersion(currentVersion: string, intent: ReleaseVersionIntent): string {
  if (intent.kind === "exact") return intent.version as string;
  const [major, minor, patch] = parseBaseVersion(currentVersion);
  if (intent.kind === "patch") return `${major}.${minor}.${patch + 1}`;
  if (intent.kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

function normalizeSourceIssues(
  value: unknown,
  path: string,
  violations: ReleasePreparationPlanViolation[],
): readonly number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SOURCE_ISSUES) {
    addViolation(violations, "HISTORY_INVALID", path, `Expected at most ${MAX_SOURCE_ISSUES} source Issue numbers.`);
    return [];
  }
  const result: number[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 1) {
      addViolation(violations, "HISTORY_INVALID", `${path}[${index}]`, "Source Issue number is invalid.");
      continue;
    }
    result.push(entry);
  }
  return [...new Set(result)].sort((left, right) => left - right);
}

function normalizeHistory(
  value: unknown,
  violations: ReleasePreparationPlanViolation[],
): ReleaseHistoryEvidence | undefined {
  if (!isRecord(value)) {
    addViolation(violations, "HISTORY_INVALID", "$.history", "History evidence must be an object.");
    return undefined;
  }
  const previous = value.previousRelease;
  const target = value.targetSource;
  if (!isRecord(previous))
    addViolation(violations, "HISTORY_INVALID", "$.history.previousRelease", "Previous release identity is required.");
  if (!isRecord(target))
    addViolation(violations, "HISTORY_INVALID", "$.history.targetSource", "Target source identity is required.");
  const tag = isRecord(previous) ? boundedString(previous.tag, "$.history.previousRelease.tag", violations) : undefined;
  const previousVersion = isRecord(previous)
    ? validVersion(previous.version, "$.history.previousRelease.version", violations)
    : undefined;
  const previousSha = isRecord(previous)
    ? validSha(previous.sourceRevision, "$.history.previousRelease.sourceRevision", violations)
    : undefined;
  const targetRef = isRecord(target) ? boundedString(target.ref, "$.history.targetSource.ref", violations) : undefined;
  const targetSha = isRecord(target)
    ? validSha(target.sourceRevision, "$.history.targetSource.sourceRevision", violations)
    : undefined;
  if (tag !== undefined && previousVersion !== undefined) {
    const tagVersion = tag.startsWith("v") ? tag.slice(1) : tag;
    if (tagVersion !== previousVersion)
      addViolation(violations, "HISTORY_INVALID", "$.history.previousRelease.tag", "Tag and release version disagree.");
  }
  if (!Array.isArray(value.includedChanges) || value.includedChanges.length > MAX_CHANGES) {
    addViolation(
      violations,
      "HISTORY_INVALID",
      "$.history.includedChanges",
      `Expected at most ${MAX_CHANGES} included changes.`,
    );
    return undefined;
  }
  const changes: ReleaseGovernedMergedChange[] = [];
  const seenNumbers = new Set<number>();
  const seenShas = new Set<string>();
  value.includedChanges.forEach((entry, index) => {
    const path = `$.history.includedChanges[${index}]`;
    if (!isRecord(entry)) {
      addViolation(violations, "HISTORY_INVALID", path, "Included change must be an object.");
      return;
    }
    const number = entry.number;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
      addViolation(violations, "HISTORY_INVALID", `${path}.number`, "Change number is invalid.");
      return;
    }
    const title = boundedString(entry.title, `${path}.title`, violations, MAX_CHANGE_TITLE_LENGTH);
    const sha = validSha(entry.mergeCommitSha, `${path}.mergeCommitSha`, violations);
    const mergedAt = validTimestamp(entry.mergedAt, `${path}.mergedAt`, violations);
    const governed = entry.governed;
    if (governed !== undefined && governed !== true)
      addViolation(violations, "HISTORY_INVALID", `${path}.governed`, "Included change evidence must be governed.");
    const sourceIssueNumbers = normalizeSourceIssues(
      entry.sourceIssueNumbers,
      `${path}.sourceIssueNumbers`,
      violations,
    );
    if (seenNumbers.has(number))
      addViolation(violations, "HISTORY_AMBIGUOUS", `${path}.number`, "Duplicate change number.");
    if (sha !== undefined && seenShas.has(sha))
      addViolation(violations, "HISTORY_AMBIGUOUS", `${path}.mergeCommitSha`, "Duplicate merge revision.");
    seenNumbers.add(number);
    if (sha !== undefined) seenShas.add(sha);
    if (title !== undefined && sha !== undefined && mergedAt !== undefined)
      changes.push({ number, title, mergeCommitSha: sha, mergedAt, governed: true, sourceIssueNumbers });
  });
  if (
    tag === undefined ||
    previousVersion === undefined ||
    previousSha === undefined ||
    targetRef === undefined ||
    targetSha === undefined
  )
    return undefined;
  changes.sort((left, right) => left.mergedAt.localeCompare(right.mergedAt, "en-US") || left.number - right.number);
  return {
    previousRelease: { tag, version: previousVersion, sourceRevision: previousSha },
    targetSource: { ref: targetRef, sourceRevision: targetSha },
    includedChanges: changes,
  };
}

function normalizeRepository(
  value: unknown,
  violations: ReleasePreparationPlanViolation[],
): ReleasePreparationRepositoryContract | undefined {
  if (!isRecord(value)) {
    addViolation(violations, "REPOSITORY_CONTRACT_INVALID", "$.repository", "Repository release contract is required.");
    return undefined;
  }
  const packageName = boundedString(value.packageName, "$.repository.packageName", violations);
  const currentVersion = validVersion(value.currentVersion, "$.repository.currentVersion", violations);
  const releaseDocumentDirectory = validRepositoryPath(
    value.releaseDocumentDirectory,
    "$.repository.releaseDocumentDirectory",
    violations,
  );
  const verification = value.verification;
  if (!isRecord(verification))
    addViolation(
      violations,
      "REPOSITORY_CONTRACT_INVALID",
      "$.repository.verification",
      "Verification prerequisite is required.",
    );
  const command = isRecord(verification)
    ? boundedString(verification.command, "$.repository.verification.command", violations)
    : undefined;
  const args = isRecord(verification) ? verification.args : undefined;
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string" || entry.length > MAX_STRING_LENGTH))
    addViolation(
      violations,
      "REPOSITORY_CONTRACT_INVALID",
      "$.repository.verification.args",
      "Verification arguments must be bounded strings.",
    );
  const publication = value.publication;
  if (
    !isRecord(publication) ||
    publication.kind !== "release-pr-publication" ||
    publication.role !== "release" ||
    publication.base !== "main" ||
    publication.template !== "release"
  )
    addViolation(
      violations,
      "REPOSITORY_CONTRACT_INVALID",
      "$.repository.publication",
      "Issue-less release publication must use the governed release route and template.",
    );
  if (isRecord(publication) && Object.hasOwn(publication, "sourceIssue"))
    addViolation(
      violations,
      "REPOSITORY_CONTRACT_INVALID",
      "$.repository.publication.sourceIssue",
      "Issue-less release publication must not contain a source Issue.",
    );
  if (
    !Array.isArray(value.versionBearingArtifacts) ||
    value.versionBearingArtifacts.length !== RELEASE_VERSION_ARTIFACT_KINDS.length
  ) {
    addViolation(
      violations,
      "REPOSITORY_CONTRACT_INVALID",
      "$.repository.versionBearingArtifacts",
      "All four version-bearing artifacts are required.",
    );
  }
  const artifacts: ReleaseVersionBearingArtifact[] = [];
  const seenKinds = new Set<string>();
  const seenPaths = new Set<string>();
  if (Array.isArray(value.versionBearingArtifacts)) {
    value.versionBearingArtifacts.forEach((entry, index) => {
      const path = `$.repository.versionBearingArtifacts[${index}]`;
      if (!isRecord(entry)) {
        addViolation(violations, "REPOSITORY_CONTRACT_INVALID", path, "Version-bearing artifact must be an object.");
        return;
      }
      const artifactPath = validRepositoryPath(entry.path, `${path}.path`, violations);
      const kind = entry.kind;
      if (!RELEASE_VERSION_ARTIFACT_KINDS.includes(kind as ReleaseVersionArtifactKind))
        addViolation(violations, "REPOSITORY_CONTRACT_INVALID", `${path}.kind`, "Artifact kind is unsupported.");
      const field = boundedString(entry.field, `${path}.field`, violations);
      const currentValue = boundedString(entry.currentValue, `${path}.currentValue`, violations);
      const format = entry.format;
      if (!RELEASE_VERSION_FORMATS.includes(format as ReleaseVersionFormat))
        addViolation(
          violations,
          "REPOSITORY_CONTRACT_INVALID",
          `${path}.format`,
          "Artifact version format is unsupported.",
        );
      if (typeof kind === "string" && seenKinds.has(kind))
        addViolation(violations, "REPOSITORY_CONTRACT_INVALID", `${path}.kind`, "Duplicate artifact kind.");
      if (artifactPath !== undefined && seenPaths.has(artifactPath))
        addViolation(violations, "REPOSITORY_CONTRACT_INVALID", `${path}.path`, "Duplicate artifact path.");
      if (typeof kind === "string") seenKinds.add(kind);
      if (artifactPath !== undefined) seenPaths.add(artifactPath);
      if (
        artifactPath !== undefined &&
        RELEASE_VERSION_ARTIFACT_KINDS.includes(kind as ReleaseVersionArtifactKind) &&
        field !== undefined &&
        currentValue !== undefined &&
        RELEASE_VERSION_FORMATS.includes(format as ReleaseVersionFormat)
      )
        artifacts.push({
          path: artifactPath,
          kind: kind as ReleaseVersionArtifactKind,
          field,
          currentValue,
          format: format as ReleaseVersionFormat,
        });
    });
  }
  for (const kind of RELEASE_VERSION_ARTIFACT_KINDS) {
    if (!seenKinds.has(kind))
      addViolation(
        violations,
        "REPOSITORY_CONTRACT_INVALID",
        "$.repository.versionBearingArtifacts",
        `Artifact kind "${kind}" is missing.`,
      );
  }
  if (currentVersion !== undefined) {
    for (const [index, artifact] of artifacts.entries()) {
      const expected = artifact.format === "caret" ? `^${currentVersion}` : currentVersion;
      if (artifact.currentValue !== expected)
        addViolation(
          violations,
          "REPOSITORY_CONTRACT_INVALID",
          `$.repository.versionBearingArtifacts[${index}].currentValue`,
          "Artifact version does not match package version.",
        );
    }
  }
  if (
    packageName === undefined ||
    currentVersion === undefined ||
    releaseDocumentDirectory === undefined ||
    command === undefined ||
    !Array.isArray(args) ||
    !isRecord(publication)
  )
    return undefined;
  return {
    packageName,
    currentVersion,
    versionBearingArtifacts: artifacts.sort((left, right) => left.path.localeCompare(right.path, "en-US")),
    releaseDocumentDirectory,
    verification: { command, args: [...args] as string[] },
    publication: {
      kind: "release-pr-publication",
      role: "release",
      base: "main",
      template: "release",
    },
  };
}

function targetArtifactValue(version: string, format: ReleaseVersionFormat): string {
  return format === "caret" ? `^${version}` : version;
}

function planDigest(plan: Omit<ReleasePreparationPlan, "digest">): string {
  return createHash("sha256").update(stableSerialize(plan), "utf8").digest("hex");
}

function invalidResult(violations: readonly ReleasePreparationPlanViolation[]): ReleasePreparationPlanResult {
  return { valid: false, violations };
}

/** Project a release plan from explicit history, intent, and repository data. */
export function tryPlanReleasePreparation(input: unknown): ReleasePreparationPlanResult {
  const violations: ReleasePreparationPlanViolation[] = [];
  if (!isRecord(input)) {
    addViolation(violations, "INPUT_INVALID", "$", "Release preparation input must be an object.");
    return invalidResult(violations);
  }
  const history = normalizeHistory(input.history, violations);
  const repository = normalizeRepository(input.repository, violations);
  const intent = normalizeIntent(input.intent, violations);
  if (history === undefined || repository === undefined || intent === undefined) return invalidResult(violations);
  if (history.previousRelease.version !== repository.currentVersion) {
    addViolation(
      violations,
      "HISTORY_INVALID",
      "$.history.previousRelease.version",
      "Previous release must match the current package version.",
    );
  }
  const targetVersionValue = targetVersion(repository.currentVersion, intent);
  if (!VERSION_PATTERN.test(targetVersionValue))
    addViolation(violations, "VERSION_INVALID", "$.intent", "Projected target version is invalid.");
  const existing = input.existingPreparedRelease;
  if (existing !== undefined) {
    if (!isRecord(existing)) {
      addViolation(
        violations,
        "TARGET_CONFLICT",
        "$.existingPreparedRelease",
        "Existing prepared release state is invalid.",
      );
    } else {
      const existingVersion = validVersion(
        existing.targetVersion,
        "$.existingPreparedRelease.targetVersion",
        violations,
      );
      const existingSha = validSha(existing.sourceRevision, "$.existingPreparedRelease.sourceRevision", violations);
      if (existingVersion !== undefined && existingVersion !== targetVersionValue)
        addViolation(
          violations,
          "TARGET_CONFLICT",
          "$.existingPreparedRelease.targetVersion",
          "Existing prepared target conflicts with intent.",
        );
      if (existingSha !== undefined && existingSha !== history.targetSource.sourceRevision)
        addViolation(
          violations,
          "TARGET_CONFLICT",
          "$.existingPreparedRelease.sourceRevision",
          "Existing prepared source conflicts with target history.",
        );
    }
  }
  if (violations.length > 0) return invalidResult(violations);
  const artifacts = repository.versionBearingArtifacts.map((artifact) => ({
    ...artifact,
    targetValue: targetArtifactValue(targetVersionValue, artifact.format),
  }));
  const releaseRoute = deriveReleasePrPublicationRoute(targetVersionValue, history.targetSource.sourceRevision);
  const publication: ReleasePublicationPrerequisite = {
    ...releaseRoute,
    template: repository.publication.template,
  };
  const releaseDocument: ReleaseDocumentTarget = {
    path: `${repository.releaseDocumentDirectory}/${targetVersionValue}.md`,
    version: targetVersionValue,
  };
  const withoutDigest: Omit<ReleasePreparationPlan, "digest"> = {
    version: RELEASE_PREPARATION_PLAN_VERSION,
    kind: RELEASE_PREPARATION_PLAN_KIND,
    identity: {
      previousRelease: history.previousRelease,
      targetSource: history.targetSource,
      targetVersion: targetVersionValue,
    },
    intent,
    includedChanges: history.includedChanges,
    versionArtifacts: artifacts,
    releaseDocument,
    verification: repository.verification,
    publication,
  };
  const plan: ReleasePreparationPlan = { ...withoutDigest, digest: planDigest(withoutDigest) };
  return { valid: true, plan: cloneImmutable(plan), violations: [] };
}

export function planReleasePreparation(input: unknown): ReleasePreparationPlan {
  const result = tryPlanReleasePreparation(input);
  if (!result.valid || result.plan === undefined) throw new ReleasePreparationPlanError(result.violations);
  return result.plan;
}

/** Build a plan after obtaining immutable history evidence from an injected port. */
export async function planReleasePreparationFromHistory(
  port: ReleaseHistoryEvidencePort,
  input: Omit<ReleasePreparationPlanInput, "history">,
  options?: ReleaseHistoryReadOptions,
): Promise<ReleasePreparationPlan> {
  if (port === null || typeof port !== "object" || typeof port.readReleaseHistory !== "function")
    throw new ReleasePreparationPlanError([
      { code: "INPUT_INVALID", path: "$.port", message: "History evidence port is required." },
    ]);
  const history = await port.readReleaseHistory(options);
  return planReleasePreparation({ ...input, history });
}

export const createReleasePreparationPlan = planReleasePreparation;
export const projectReleasePreparationPlan = planReleasePreparation;
export const tryProjectReleasePreparationPlan = tryPlanReleasePreparation;

/** Stable transport representation for the versioned plan. */
export function serializeReleasePreparationPlan(input: unknown): string {
  const result = validateReleasePreparationPlan(input);
  if (!result.valid || result.plan === undefined) throw new ReleasePreparationPlanError(result.violations);
  return stableSerialize(result.plan);
}

export function parseReleasePreparationPlan(serialized: string): ReleasePreparationPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new ReleasePreparationPlanError([{ code: "PLAN_INVALID", path: "$", message: "Plan must be valid JSON." }]);
  }
  const result = validateReleasePreparationPlan(parsed);
  if (!result.valid || result.plan === undefined) throw new ReleasePreparationPlanError(result.violations);
  return result.plan;
}

export function validateReleasePreparationPlan(input: unknown): ReleasePreparationPlanResult {
  if (!isRecord(input)) return invalidResult([{ code: "PLAN_INVALID", path: "$", message: "Plan must be an object." }]);
  if (input.version !== RELEASE_PREPARATION_PLAN_VERSION || input.kind !== RELEASE_PREPARATION_PLAN_KIND)
    return invalidResult([{ code: "PLAN_INVALID", path: "$", message: "Plan version or kind is unsupported." }]);
  if (typeof input.digest !== "string" || !/^[0-9a-f]{64}$/u.test(input.digest))
    return invalidResult([{ code: "PLAN_INVALID", path: "$.digest", message: "Plan digest must be SHA-256 hex." }]);
  const projectionInput: ReleasePreparationPlanInput = {
    history: input.identity as unknown as ReleaseHistoryEvidence,
    intent: input.intent as unknown as ReleaseVersionIntent,
    repository: {
      packageName: "validated-plan",
      currentVersion: (isRecord(input.identity) && isRecord(input.identity.previousRelease)
        ? input.identity.previousRelease.version
        : "0.0.0") as string,
      versionBearingArtifacts: (input.versionArtifacts as unknown as ReleaseVersionArtifactTarget[]).map(
        (artifact) => ({
          path: artifact.path,
          kind: artifact.kind,
          field: artifact.field,
          currentValue: artifact.currentValue,
          format: artifact.format,
        }),
      ),
      releaseDocumentDirectory:
        isRecord(input.releaseDocument) && typeof input.releaseDocument.path === "string"
          ? input.releaseDocument.path.replace(/\/[^/]+\.md$/u, "")
          : "docs/releases",
      verification: input.verification as ReleaseVerificationPrerequisite,
      publication: isRecord(input.publication)
        ? ({
            kind: input.publication.kind,
            role: input.publication.role,
            base: input.publication.base,
            template: input.publication.template,
          } as ReleasePublicationContract)
        : (input.publication as ReleasePublicationContract),
    },
  };
  const history = isRecord(input.identity)
    ? {
        previousRelease: input.identity.previousRelease,
        targetSource: input.identity.targetSource,
        includedChanges: input.includedChanges,
      }
    : undefined;
  if (history === undefined)
    return invalidResult([{ code: "PLAN_INVALID", path: "$.identity", message: "Plan identity is invalid." }]);
  const rebuilt = tryPlanReleasePreparation({ ...projectionInput, history });
  if (!rebuilt.valid || rebuilt.plan === undefined)
    return invalidResult(rebuilt.violations.map((violation) => ({ ...violation, code: "PLAN_INVALID" as const })));
  if (rebuilt.plan.digest !== input.digest)
    return invalidResult([
      { code: "PLAN_INVALID", path: "$.digest", message: "Plan digest does not match its canonical payload." },
    ]);
  return { valid: true, plan: cloneImmutable(input as unknown as ReleasePreparationPlan), violations: [] };
}
