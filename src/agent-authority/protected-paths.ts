/**
 * Immutable trust-root path classification for ordinary delegated writes.
 *
 * The Runtime Authority artifact constants are the only source of the V1
 * protected root.  This module deliberately does not add authorization-policy
 * paths: future trust-root classes require a separately governed expansion.
 *
 * Callers must submit the complete tree delta, including both sides of a
 * rename or delete+add operation, before creating any Git object.  Invalid or
 * ambiguous repository paths are never treated as ordinary paths.
 */

import { validateCapabilityClaim, type CapabilityClaim, type CapabilityKind } from "./capability.js";
import { RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY, RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX } from "./runtime-authority.js";

export const PROTECTED_PATH_CLASSIFIER_VERSION = 1 as const;

/** Capability kinds that may carry an ordinary implementation tree delta. */
export const DELEGATED_WRITE_CAPABILITY_KINDS = Object.freeze(["change.implement", "branch.advance"] as const);
export type DelegatedWriteCapabilityKind = (typeof DELEGATED_WRITE_CAPABILITY_KINDS)[number];

const DELEGATED_WRITE_KINDS: ReadonlySet<CapabilityKind> = new Set(DELEGATED_WRITE_CAPABILITY_KINDS);
const DISALLOWED_UNICODE = /[\p{Cc}\p{Cf}]/u;
const ENCODED_BYTE = /%[0-9a-f]{2}/iu;
const WINDOWS_DRIVE_PATH = /^[a-z]:/iu;

export type RepositoryPathInvalidReason =
  | "NOT_STRING"
  | "EMPTY"
  | "ABSOLUTE"
  | "WINDOWS_DRIVE"
  | "BACKSLASH"
  | "CONTROL_OR_FORMAT_CHARACTER"
  | "UNPAIRED_SURROGATE"
  | "NON_CANONICAL_UNICODE"
  | "ENCODED_BYTE"
  | "EMPTY_SEGMENT"
  | "DOT_SEGMENT";

export type RepositoryPathClassification =
  | {
      readonly kind: "protected";
      readonly path: string;
    }
  | {
      readonly kind: "unprotected";
      readonly path: string;
    }
  | {
      readonly kind: "invalid";
      readonly reason: RepositoryPathInvalidReason;
      readonly message: string;
    };

function invalidPath(reason: RepositoryPathInvalidReason, message: string): RepositoryPathClassification {
  return Object.freeze({ kind: "invalid" as const, reason, message });
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Classify one repository-relative Git path.
 *
 * The function accepts `unknown` intentionally: callers at transport and
 * request boundaries must not be able to turn malformed input into an
 * unprotected path by first applying platform-specific normalization.
 */
export function classifyRepositoryPath(value: unknown): RepositoryPathClassification {
  if (typeof value !== "string") {
    return invalidPath("NOT_STRING", "Repository paths must be strings.");
  }
  if (value.length === 0) return invalidPath("EMPTY", "Repository paths must not be empty.");
  if (value.startsWith("/")) return invalidPath("ABSOLUTE", "Repository paths must be relative.");
  if (WINDOWS_DRIVE_PATH.test(value)) {
    return invalidPath("WINDOWS_DRIVE", "Repository paths must not use a Windows drive prefix.");
  }
  if (value.includes("\\")) {
    return invalidPath("BACKSLASH", "Repository paths must use canonical Git separators.");
  }
  if (DISALLOWED_UNICODE.test(value)) {
    return invalidPath(
      "CONTROL_OR_FORMAT_CHARACTER",
      "Repository paths must not contain control or format characters.",
    );
  }
  if (hasUnpairedSurrogate(value)) {
    return invalidPath("UNPAIRED_SURROGATE", "Repository paths must contain valid Unicode scalar sequences.");
  }
  if (value.normalize("NFC") !== value || value.normalize("NFKC") !== value) {
    return invalidPath("NON_CANONICAL_UNICODE", "Repository paths must use canonical Unicode normalization.");
  }
  if (ENCODED_BYTE.test(value)) {
    return invalidPath("ENCODED_BYTE", "Repository paths must not contain URI-encoded bytes.");
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return invalidPath("EMPTY_SEGMENT", "Repository paths must not contain empty path segments.");
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return invalidPath("DOT_SEGMENT", "Repository paths must not contain dot or traversal segments.");
  }

  if (value === RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY || value.startsWith(RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX)) {
    return Object.freeze({ kind: "protected" as const, path: value });
  }
  return Object.freeze({ kind: "unprotected" as const, path: value });
}

export const DELEGATED_TREE_CHANGE_OPERATIONS = Object.freeze([
  "create",
  "modify",
  "delete",
  "rename",
  "delete-add",
  "replace",
] as const);
export type DelegatedTreeChangeOperation = (typeof DELEGATED_TREE_CHANGE_OPERATIONS)[number];

export interface DelegatedTreePathChange {
  readonly operation: DelegatedTreeChangeOperation;
  readonly path: string;
  /** The source path for rename/delete+add/equivalent replacement operations. */
  readonly previousPath?: string;
}

/** Minimum immutable identity required for complete before/after tree snapshots. */
export interface DelegatedTreeSnapshotEntry {
  readonly path: string;
  readonly sha: string;
  readonly mode?: string | number;
  readonly type?: "blob" | "tree" | "commit";
}

export interface DelegatedTreeDelta {
  /** Every create/modify/delete/rename/delete+add/equivalent operation. */
  readonly changes: readonly DelegatedTreePathChange[];
  /** Optional complete snapshots used to detect implicit/equivalent tree changes. */
  readonly before?: readonly DelegatedTreeSnapshotEntry[];
  readonly after?: readonly DelegatedTreeSnapshotEntry[];
}

export type DelegatedTreeDeltaClassificationKind = "allowed" | "protected" | "invalid";
export type DelegatedTreeDeltaClassificationCode =
  "DELEGATED_TREE_DELTA_ALLOWED" | "DELEGATED_TREE_DELTA_PROTECTED_PATH" | "DELEGATED_TREE_DELTA_INVALID";

export interface DelegatedTreeDeltaClassification {
  readonly version: typeof PROTECTED_PATH_CLASSIFIER_VERSION;
  readonly kind: DelegatedTreeDeltaClassificationKind;
  readonly code: DelegatedTreeDeltaClassificationCode;
  readonly touchedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly invalidPaths: readonly string[];
  readonly message: string;
}

function treeDeltaResult(
  kind: DelegatedTreeDeltaClassificationKind,
  code: DelegatedTreeDeltaClassificationCode,
  touchedPaths: ReadonlySet<string>,
  protectedPaths: ReadonlySet<string>,
  invalidPaths: ReadonlySet<string>,
  message: string,
): DelegatedTreeDeltaClassification {
  return Object.freeze({
    version: PROTECTED_PATH_CLASSIFIER_VERSION,
    kind,
    code,
    touchedPaths: Object.freeze([...touchedPaths].sort()),
    protectedPaths: Object.freeze([...protectedPaths].sort()),
    invalidPaths: Object.freeze([...invalidPaths].sort()),
    message,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTreeChangeOperation(value: unknown): value is DelegatedTreeChangeOperation {
  return typeof value === "string" && DELEGATED_TREE_CHANGE_OPERATIONS.includes(value as DelegatedTreeChangeOperation);
}

function addPathClassification(
  value: unknown,
  touchedPaths: Set<string>,
  protectedPaths: Set<string>,
  invalidPaths: Set<string>,
  label: string,
): boolean {
  const classification = classifyRepositoryPath(value);
  if (classification.kind === "invalid") {
    invalidPaths.add(typeof value === "string" ? value : label);
    return false;
  }
  touchedPaths.add(classification.path);
  if (classification.kind === "protected") protectedPaths.add(classification.path);
  return true;
}

interface SnapshotMap {
  readonly entries: ReadonlyMap<string, string>;
  readonly invalidPaths: ReadonlySet<string>;
}

function snapshotFingerprint(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.sha !== "string" || entry.sha.length === 0) return undefined;
  if (
    entry.mode !== undefined &&
    !(
      (typeof entry.mode === "string" && entry.mode.length > 0) ||
      (typeof entry.mode === "number" && Number.isFinite(entry.mode))
    )
  ) {
    return undefined;
  }
  if (entry.type !== undefined && entry.type !== "blob" && entry.type !== "tree" && entry.type !== "commit") {
    return undefined;
  }
  return JSON.stringify([entry.sha, entry.mode ?? null, entry.type ?? null]);
}

function readSnapshot(value: unknown, label: string): SnapshotMap | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = new Map<string, string>();
  const invalidPaths = new Set<string>();
  value.forEach((rawEntry, index) => {
    if (!isRecord(rawEntry)) {
      invalidPaths.add(`${label}[${index}]`);
      return;
    }
    const classification = classifyRepositoryPath(rawEntry.path);
    if (classification.kind === "invalid") {
      invalidPaths.add(typeof rawEntry.path === "string" ? rawEntry.path : `${label}[${index}].path`);
      return;
    }
    const fingerprint = snapshotFingerprint(rawEntry);
    if (fingerprint === undefined || entries.has(classification.path)) {
      invalidPaths.add(classification.path);
      return;
    }
    entries.set(classification.path, fingerprint);
  });
  return { entries, invalidPaths };
}

function snapshotChangedPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): Set<string> {
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  return new Set([...paths].filter((path) => before.get(path) !== after.get(path)));
}

/**
 * Classify a complete delegated tree delta before any blob/tree/commit effect.
 * Protected paths are denied even when a caller supplies an otherwise broad
 * path policy, and explicit touched paths are checked even when before/after
 * snapshots are byte-for-byte equivalent.
 */
export function classifyDelegatedTreeDelta(input: unknown): DelegatedTreeDeltaClassification {
  const touchedPaths = new Set<string>();
  const protectedPaths = new Set<string>();
  const invalidPaths = new Set<string>();

  if (!isRecord(input) || !Array.isArray(input.changes)) {
    return treeDeltaResult(
      "invalid",
      "DELEGATED_TREE_DELTA_INVALID",
      touchedPaths,
      protectedPaths,
      invalidPaths,
      "A complete delegated tree delta must contain a changes array.",
    );
  }

  input.changes.forEach((rawChange, index) => {
    if (!isRecord(rawChange) || !isTreeChangeOperation(rawChange.operation)) {
      invalidPaths.add(`changes[${index}]`);
      return;
    }

    const operation = rawChange.operation;
    const pathValid = addPathClassification(
      rawChange.path,
      touchedPaths,
      protectedPaths,
      invalidPaths,
      `changes[${index}].path`,
    );
    const hasPreviousPath = "previousPath" in rawChange;
    const requiresPreviousPath = operation === "rename" || operation === "delete-add";
    if (requiresPreviousPath && (!hasPreviousPath || typeof rawChange.previousPath !== "string")) {
      invalidPaths.add(`changes[${index}].previousPath`);
      return;
    }
    if (hasPreviousPath) {
      const previousPathValid = addPathClassification(
        rawChange.previousPath,
        touchedPaths,
        protectedPaths,
        invalidPaths,
        `changes[${index}].previousPath`,
      );
      if (pathValid && previousPathValid && rawChange.path === rawChange.previousPath) {
        invalidPaths.add(rawChange.path as string);
      }
    }
  });

  const hasBefore = "before" in input;
  const hasAfter = "after" in input;
  if (hasBefore !== hasAfter) {
    invalidPaths.add("before/after");
  }

  let before: SnapshotMap | undefined;
  let after: SnapshotMap | undefined;
  if (hasBefore && hasAfter) {
    before = readSnapshot(input.before, "before");
    after = readSnapshot(input.after, "after");
    if (before === undefined) invalidPaths.add("before");
    if (after === undefined) invalidPaths.add("after");
    if (before !== undefined) for (const path of before.invalidPaths) invalidPaths.add(path);
    if (after !== undefined) for (const path of after.invalidPaths) invalidPaths.add(path);

    if (before !== undefined && after !== undefined) {
      const changedPaths = snapshotChangedPaths(before.entries, after.entries);
      for (const path of changedPaths) {
        const classification = classifyRepositoryPath(path);
        if (classification.kind === "protected") {
          protectedPaths.add(path);
        } else if (!touchedPaths.has(path)) {
          invalidPaths.add(path);
        }
      }
    }
  }

  if (invalidPaths.size > 0) {
    return treeDeltaResult(
      "invalid",
      "DELEGATED_TREE_DELTA_INVALID",
      touchedPaths,
      protectedPaths,
      invalidPaths,
      "Delegated tree delta contains an invalid or incomplete repository path representation.",
    );
  }
  if (protectedPaths.size > 0) {
    return treeDeltaResult(
      "protected",
      "DELEGATED_TREE_DELTA_PROTECTED_PATH",
      touchedPaths,
      protectedPaths,
      invalidPaths,
      "Delegated writes cannot modify the Runtime Authority trust root.",
    );
  }

  return treeDeltaResult(
    "allowed",
    "DELEGATED_TREE_DELTA_ALLOWED",
    touchedPaths,
    protectedPaths,
    invalidPaths,
    "Delegated tree delta does not affect the Runtime Authority trust root.",
  );
}

export type DelegatedWriteAdmissionCode =
  | "DELEGATED_WRITE_ALLOWED"
  | "DELEGATED_WRITE_CAPABILITY_INVALID"
  | "DELEGATED_WRITE_CAPABILITY_NOT_WRITABLE"
  | "DELEGATED_WRITE_TREE_DELTA_INVALID"
  | "DELEGATED_WRITE_TRUST_ROOT_DENIED";

export interface DelegatedWriteAdmissionRequest {
  readonly capability: unknown;
  readonly treeDelta: unknown;
}

export interface DelegatedWriteAdmissionResult {
  readonly version: typeof PROTECTED_PATH_CLASSIFIER_VERSION;
  readonly allowed: boolean;
  readonly code: DelegatedWriteAdmissionCode;
  readonly capability?: CapabilityClaim;
  readonly treeDelta?: DelegatedTreeDeltaClassification;
  readonly message: string;
}

/**
 * Apply the immutable trust-root deny-set to a validated ordinary write
 * capability.  The capability's optional pathPolicy can only attenuate a
 * future write; it is never consulted as an override for this deny-set.
 */
export function admitDelegatedWrite(input: unknown): DelegatedWriteAdmissionResult {
  if (!isRecord(input)) {
    return Object.freeze({
      version: PROTECTED_PATH_CLASSIFIER_VERSION,
      allowed: false,
      code: "DELEGATED_WRITE_CAPABILITY_INVALID" as const,
      message: "Delegated write admission requires a capability and complete tree delta.",
    });
  }

  const capabilityResult = validateCapabilityClaim(input.capability);
  if (!capabilityResult.valid || capabilityResult.value === undefined) {
    return Object.freeze({
      version: PROTECTED_PATH_CLASSIFIER_VERSION,
      allowed: false,
      code: "DELEGATED_WRITE_CAPABILITY_INVALID" as const,
      message: "Delegated write capability is invalid.",
    });
  }

  const treeDelta = classifyDelegatedTreeDelta(input.treeDelta);
  if (!DELEGATED_WRITE_KINDS.has(capabilityResult.value.kind)) {
    return Object.freeze({
      version: PROTECTED_PATH_CLASSIFIER_VERSION,
      allowed: false,
      code: "DELEGATED_WRITE_CAPABILITY_NOT_WRITABLE" as const,
      capability: capabilityResult.value,
      treeDelta,
      message: "Capability kind cannot authorize an ordinary delegated tree write.",
    });
  }
  if (treeDelta.kind === "invalid") {
    return Object.freeze({
      version: PROTECTED_PATH_CLASSIFIER_VERSION,
      allowed: false,
      code: "DELEGATED_WRITE_TREE_DELTA_INVALID" as const,
      capability: capabilityResult.value,
      treeDelta,
      message: treeDelta.message,
    });
  }
  if (treeDelta.kind === "protected") {
    return Object.freeze({
      version: PROTECTED_PATH_CLASSIFIER_VERSION,
      allowed: false,
      code: "DELEGATED_WRITE_TRUST_ROOT_DENIED" as const,
      capability: capabilityResult.value,
      treeDelta,
      message: treeDelta.message,
    });
  }
  return Object.freeze({
    version: PROTECTED_PATH_CLASSIFIER_VERSION,
    allowed: true,
    code: "DELEGATED_WRITE_ALLOWED" as const,
    capability: capabilityResult.value,
    treeDelta,
    message: treeDelta.message,
  });
}
