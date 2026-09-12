#!/usr/bin/env node

/**
 * The dedicated PR authority for the Runtime Authority trust root.
 *
 * This validator compares complete base and head snapshots. It intentionally
 * imports the existing Runtime Authority schema, canonical serializer, path
 * helper, and #370 repository-path classifier instead of defining parallel
 * trust-root rules here.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY,
  RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX,
  canonicalRuntimeAuthorityJson,
  validateRuntimeAuthority,
} from "../src/agent-authority/runtime-authority.ts";
import { classifyRepositoryPath } from "../src/agent-authority/protected-paths.ts";
import { runtimeAuthorityArtifactPath } from "../src/agent-authority/runtime-authority-trust.ts";

export const RUNTIME_AUTHORITY_GOVERNANCE_CHECK_NAME = "Runtime Authority Governance";
export const RUNTIME_AUTHORITY_GOVERNANCE_VERSION = 1;

const NORMAL_FILE_MODE = "100644";

/** A complete repository snapshot entry used by offline tests and git reads. */
export function snapshotEntry(content, mode = NORMAL_FILE_MODE, type = "blob") {
  return Object.freeze({ content, mode, type });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSnapshotMap(snapshot) {
  if (snapshot instanceof Map) return snapshot;
  if (isRecord(snapshot)) return new Map(Object.entries(snapshot));
  return undefined;
}

function normalizeSnapshotEntry(value) {
  if (typeof value === "string") return snapshotEntry(value);
  if (!isRecord(value) || typeof value.content !== "string") return undefined;
  return snapshotEntry(
    value.content,
    typeof value.mode === "string" ? value.mode : NORMAL_FILE_MODE,
    typeof value.type === "string" ? value.type : "blob",
  );
}

function violation(code, pathValue, message, side) {
  return Object.freeze({
    code,
    path: pathValue,
    ...(side === undefined ? {} : { side }),
    message,
  });
}

function addViolation(violations, code, pathValue, message, side) {
  violations.push(violation(code, pathValue, message, side));
}

function canonicalAuthorityPath(filePath) {
  const classification = classifyRepositoryPath(filePath);
  if (classification.kind !== "protected") return { error: "path is not classified as protected" };
  if (!filePath.startsWith(RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX))
    return { error: "path is outside the canonical directory" };
  const relative = filePath.slice(RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX.length);
  if (relative.includes("/") || !relative.endsWith(".json")) return { error: "artifact must be a direct .json file" };
  const id = relative.slice(0, -".json".length);
  try {
    const expected = runtimeAuthorityArtifactPath(id);
    return expected === filePath ? { id, path: expected } : { error: "filename is not canonical" };
  } catch {
    return { error: "filename does not contain a valid authority identifier" };
  }
}

function validateSnapshot(snapshot, side) {
  const violations = [];
  const records = new Map();
  const ids = new Map();
  const keys = new Map();
  const entries = asSnapshotMap(snapshot);
  if (entries === undefined) {
    addViolation(
      violations,
      "RUNTIME_AUTHORITY_SNAPSHOT_INVALID",
      "$",
      "Runtime Authority validation requires a complete path-to-file snapshot.",
      side,
    );
    return { records, violations };
  }

  for (const [filePath, rawEntry] of [...entries.entries()].sort(([left], [right]) =>
    String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0,
  )) {
    if (typeof filePath !== "string") {
      addViolation(violations, "RUNTIME_AUTHORITY_PATH_INVALID", "$", "Runtime Authority paths must be strings.", side);
      continue;
    }
    if (
      filePath !== RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY &&
      !filePath.startsWith(RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX)
    )
      continue;
    const classification = classifyRepositoryPath(filePath);
    if (classification.kind !== "protected") {
      addViolation(
        violations,
        "RUNTIME_AUTHORITY_PATH_INVALID",
        String(filePath),
        "Runtime Authority path is invalid.",
        side,
      );
      continue;
    }
    const canonical = canonicalAuthorityPath(filePath);
    if (canonical.error !== undefined) {
      addViolation(
        violations,
        "RUNTIME_AUTHORITY_PATH_UNSUPPORTED",
        filePath,
        `Unsupported Runtime Authority path: ${canonical.error}.`,
        side,
      );
      continue;
    }
    const entry = normalizeSnapshotEntry(rawEntry);
    if (entry === undefined || entry.type !== "blob" || entry.mode !== NORMAL_FILE_MODE) {
      addViolation(
        violations,
        "RUNTIME_AUTHORITY_FILE_UNSUPPORTED",
        filePath,
        "Runtime Authority artifacts must be regular 100644 JSON blobs.",
        side,
      );
      continue;
    }

    let raw;
    try {
      raw = JSON.parse(entry.content);
    } catch {
      addViolation(
        violations,
        "RUNTIME_AUTHORITY_RECORD_MALFORMED",
        filePath,
        "Runtime Authority artifact is not valid JSON.",
        side,
      );
      continue;
    }
    const validation = validateRuntimeAuthority(raw, "$runtimeAuthority");
    if (!validation.valid || validation.value === undefined) {
      addViolation(
        violations,
        "RUNTIME_AUTHORITY_RECORD_MALFORMED",
        filePath,
        "Runtime Authority artifact failed the existing Runtime Authority schema authority.",
        side,
      );
      for (const diagnostic of validation.diagnostics) {
        addViolation(violations, diagnostic.code, `${filePath}:${diagnostic.path}`, diagnostic.message, side);
      }
      continue;
    }
    const authority = validation.value;
    if (ids.has(authority.id)) {
      addViolation(
        violations,
        "RUNTIME_AUTHORITY_DUPLICATE_ID",
        filePath,
        `Authority id "${authority.id}" is duplicated.`,
        side,
      );
    }
    if (keys.has(authority.key.x)) {
      addViolation(
        violations,
        "RUNTIME_AUTHORITY_DUPLICATE_PUBLIC_KEY",
        filePath,
        "Ed25519 public key is duplicated.",
        side,
      );
    }
    ids.set(authority.id, filePath);
    keys.set(authority.key.x, filePath);
    if (authority.id !== canonical.id) {
      addViolation(
        violations,
        "RUNTIME_AUTHORITY_PATH_ID_MISMATCH",
        filePath,
        `Artifact id "${authority.id}" does not match filename id "${canonical.id}".`,
        side,
      );
      continue;
    }
    if (entry.content !== canonicalRuntimeAuthorityJson(authority)) {
      addViolation(
        violations,
        "RUNTIME_AUTHORITY_NONCANONICAL_JSON",
        filePath,
        "Runtime Authority artifact JSON is not canonical.",
        side,
      );
      continue;
    }
    records.set(filePath, { authority, entry });
  }
  return { records, violations };
}

function authorityWithoutStatus(authority) {
  return canonicalRuntimeAuthorityJson({ ...authority, status: "active" });
}

function transitionReport(violations, baseRecords, headRecords) {
  const paths = new Set([...baseRecords.keys(), ...headRecords.keys()]);
  const creates = [];
  const revocations = [];
  for (const filePath of [...paths].sort()) {
    const before = baseRecords.get(filePath);
    const after = headRecords.get(filePath);
    if (before === undefined && after === undefined) continue;
    if (before === undefined) {
      if (after.authority.status !== "active") {
        addViolation(
          violations,
          "RUNTIME_AUTHORITY_CREATE_DISABLED",
          filePath,
          "New Runtime Authority records must be active.",
        );
      } else creates.push(filePath);
      continue;
    }
    if (after === undefined) {
      addViolation(
        violations,
        "RUNTIME_AUTHORITY_DELETION_FORBIDDEN",
        filePath,
        "Runtime Authority deletion is forbidden.",
      );
      continue;
    }

    const bytesUnchanged = before.entry.content === after.entry.content;
    const fileMetadataUnchanged = before.entry.mode === after.entry.mode && before.entry.type === after.entry.type;
    if (bytesUnchanged && fileMetadataUnchanged) continue;
    if (!fileMetadataUnchanged) {
      addViolation(
        violations,
        "RUNTIME_AUTHORITY_FILE_MUTATION_FORBIDDEN",
        filePath,
        "Runtime Authority artifact file metadata may not change.",
      );
      continue;
    }
    if (before.authority.status === "active" && after.authority.status === "disabled") {
      if (authorityWithoutStatus(before.authority) === authorityWithoutStatus(after.authority))
        revocations.push(filePath);
      else {
        addViolation(
          violations,
          "RUNTIME_AUTHORITY_IMMUTABLE_FIELD_MUTATION",
          filePath,
          "Revocation may change only status from active to disabled.",
        );
      }
      continue;
    }
    if (before.authority.status === "disabled" && after.authority.status === "active") {
      addViolation(
        violations,
        "RUNTIME_AUTHORITY_REACTIVATION_FORBIDDEN",
        filePath,
        "Disabled Runtime Authorities cannot be reactivated.",
      );
      continue;
    }
    addViolation(
      violations,
      "RUNTIME_AUTHORITY_TRANSITION_FORBIDDEN",
      filePath,
      "Existing Runtime Authority records may change only from active to disabled.",
    );
  }
  if (creates.length > 0 && revocations.length > 0) {
    addViolation(
      violations,
      "RUNTIME_AUTHORITY_MIXED_TRANSITION_UNSUPPORTED",
      RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY,
      "A Runtime Authority PR must create active records or revoke existing records, not mix both phases.",
    );
  }
  return { creates, revocations };
}

/** Validate the complete base-to-head Runtime Authority trust-root transition. */
export function validateRuntimeAuthorityTransition({ base, head }) {
  const baseResult = validateSnapshot(base, "base");
  const headResult = validateSnapshot(head, "head");
  const violations = [...baseResult.violations, ...headResult.violations];
  const transition = transitionReport(violations, baseResult.records, headResult.records);
  return Object.freeze({
    version: RUNTIME_AUTHORITY_GOVERNANCE_VERSION,
    check: RUNTIME_AUTHORITY_GOVERNANCE_CHECK_NAME,
    valid: violations.length === 0,
    ok: violations.length === 0,
    changed: transition.creates.length > 0 || transition.revocations.length > 0,
    created: Object.freeze([...transition.creates]),
    revoked: Object.freeze([...transition.revocations]),
    violations: Object.freeze(violations),
  });
}

export const validateRuntimeAuthorityGovernance = validateRuntimeAuthorityTransition;

function gitSnapshot(root, revision) {
  if (typeof revision !== "string" || revision.length === 0) throw new Error("revision is required");
  const resolvedRevision = execFileSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(resolvedRevision)) throw new Error("git revision is not an exact commit SHA");
  const output = execFileSync(
    "git",
    ["ls-tree", "-r", "-z", "--full-name", resolvedRevision, "--", RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY],
    { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  const snapshot = new Map();
  for (const record of output.split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error("git tree entry is malformed");
    const [mode, type, sha] = record.slice(0, tab).split(" ");
    const filePath = record.slice(tab + 1);
    if (
      typeof mode !== "string" ||
      typeof type !== "string" ||
      typeof sha !== "string" ||
      !/^[0-9a-f]{40}$/u.test(sha) ||
      filePath.length === 0
    ) {
      throw new Error("git tree entry is malformed");
    }
    const content = execFileSync("git", ["show", `${resolvedRevision}:${filePath}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: MAX_BLOB_BYTES,
    });
    snapshot.set(filePath, snapshotEntry(content, mode, type));
  }
  return snapshot;
}

const MAX_BLOB_BYTES = 1_048_576;

/** Read complete base/head snapshots from a Git worktree for the PR check. */
export function validateRuntimeAuthorityGitTransition(root, baseRevision, headRevision) {
  return validateRuntimeAuthorityTransition({
    base: gitSnapshot(path.resolve(root), baseRevision),
    head: gitSnapshot(path.resolve(root), headRevision),
  });
}

function parseCliArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== "--base" && token !== "--head" && token !== "--root") {
      throw new Error(`unsupported option ${token ?? ""}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} requires a value`);
    values[token.slice(2)] = value;
    index += 1;
  }
  if (values.base === undefined || values.head === undefined) throw new Error("--base and --head are required");
  return values;
}

function runAsCommand() {
  try {
    const args = parseCliArguments(process.argv.slice(2));
    const root = args.root === undefined ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") : args.root;
    const result = validateRuntimeAuthorityGitTransition(root, args.base, args.head);
    if (!result.valid) {
      console.error(`${RUNTIME_AUTHORITY_GOVERNANCE_CHECK_NAME} failed`);
      for (const entry of result.violations) {
        console.error(`- [${entry.code}] ${entry.path}: ${entry.message}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(
      `${RUNTIME_AUTHORITY_GOVERNANCE_CHECK_NAME} passed: ${result.created.length} creation(s), ${result.revoked.length} revocation(s).`,
    );
  } catch (error) {
    console.error(
      `${RUNTIME_AUTHORITY_GOVERNANCE_CHECK_NAME} failed closed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) runAsCommand();
