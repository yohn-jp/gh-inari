#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  appendCertificationDiagnostic,
  isCertificationBoundedString,
  isCertificationSourceCommitSha,
} from "./certification-evidence.mjs";
import { readCurrentSourceSha, retrieveSelfDogfoodEvidence } from "./verify-release-certification.mjs";
import { verifyGhExtensionReleaseCertification } from "../src/release-certification.js";

const REPOSITORY_OWNER = "yohn-jp";
const REPOSITORY_NAME = "gh-inari";
const EXTENSION_NAME = "gh-inari";
const ARTIFACT_MANIFEST_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ARTIFACT_NAME_PATTERN = new RegExp(
  `^${EXTENSION_NAME}-(darwin|freebsd|linux|windows|android)-(amd64|arm64|386|arm)(\\.exe)?$`,
  "u",
);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_CONTEXT_KEYS = Object.freeze([
  "GITHUB_REPOSITORY",
  "RELEASE_SOURCE_SHA",
  "RELEASE_TAG",
  "RELEASE_ARTIFACT_DIR",
  "RELEASE_ARTIFACT_MANIFEST_SHA256",
]);

class WorkflowCertificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkflowCertificationError";
    this.code = code;
  }
}

function workflowError(code, message) {
  return new WorkflowCertificationError(code, message);
}

function failureResult(code, message) {
  const diagnostics = [];
  appendCertificationDiagnostic(diagnostics, code, message);
  return { passed: false, diagnostics };
}

function requireEnvironmentValue(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0)
    throw workflowError("WORKFLOW_CONTEXT_MISSING", `${key} is required`);
  if (/[\u0000-\u001F\u007F]/u.test(value))
    throw workflowError("WORKFLOW_CONTEXT_INVALID", `${key} contains control characters`);
  return value;
}

/** Parse the no-argument environment contract supplied by the shared workflow. */
export function parseWorkflowContext(environment = process.env) {
  const missing = WORKFLOW_CONTEXT_KEYS.filter(
    (key) => typeof environment[key] !== "string" || environment[key].length === 0,
  );
  if (missing.length > 0)
    throw workflowError("WORKFLOW_CONTEXT_MISSING", `missing workflow context: ${missing.join(", ")}`);

  const repository = requireEnvironmentValue(environment, "GITHUB_REPOSITORY");
  if (repository !== `${REPOSITORY_OWNER}/${REPOSITORY_NAME}`)
    throw workflowError("REPOSITORY_MISMATCH", `GITHUB_REPOSITORY must be ${REPOSITORY_OWNER}/${REPOSITORY_NAME}`);

  const sourceSha = requireEnvironmentValue(environment, "RELEASE_SOURCE_SHA");
  if (!isCertificationSourceCommitSha(sourceSha))
    throw workflowError("WORKFLOW_CONTEXT_INVALID", "RELEASE_SOURCE_SHA must be an exact lowercase commit SHA");

  const releaseTag = requireEnvironmentValue(environment, "RELEASE_TAG");
  if (!isCertificationBoundedString(releaseTag))
    throw workflowError("WORKFLOW_CONTEXT_INVALID", "RELEASE_TAG must be a bounded non-empty string");

  const artifactDirectory = requireEnvironmentValue(environment, "RELEASE_ARTIFACT_DIR");
  const artifactManifestSha256 = requireEnvironmentValue(environment, "RELEASE_ARTIFACT_MANIFEST_SHA256");
  if (!ARTIFACT_MANIFEST_SHA256_PATTERN.test(artifactManifestSha256))
    throw workflowError(
      "WORKFLOW_CONTEXT_INVALID",
      "RELEASE_ARTIFACT_MANIFEST_SHA256 must be a lowercase SHA-256 digest",
    );

  return {
    repositoryOwner: REPOSITORY_OWNER,
    repositoryName: REPOSITORY_NAME,
    sourceSha,
    releaseTag,
    artifactDirectory: path.resolve(artifactDirectory),
    artifactManifestSha256,
  };
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sameStat(left, right) {
  return ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].every((key) => left[key] === right[key]);
}

function assertArtifactDirectory(artifactDirectory) {
  let directoryStat;
  try {
    directoryStat = fs.lstatSync(artifactDirectory);
  } catch (error) {
    throw workflowError(
      "ARTIFACT_DIRECTORY_INVALID",
      `artifact directory is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    throw workflowError("ARTIFACT_DIRECTORY_INVALID", "artifact directory must be a real directory");
  return directoryStat;
}

function assertSupportedArtifactName(name) {
  const match = ARTIFACT_NAME_PATTERN.exec(name);
  if (match === null)
    throw workflowError(
      "ARTIFACT_NAME_INVALID",
      `artifact filename is outside the gh-extension naming surface: ${name}`,
    );
  const isWindows = match[1] === "windows";
  const hasWindowsSuffix = match[3] === ".exe";
  if (isWindows !== hasWindowsSuffix)
    throw workflowError("ARTIFACT_NAME_INVALID", `artifact filename has an invalid Windows suffix: ${name}`);
}

function assertUniqueArtifactNames(names) {
  const exact = new Set();
  const normalized = new Set();
  for (const name of names) {
    if (exact.has(name)) throw workflowError("ARTIFACT_NAME_AMBIGUOUS", `duplicate artifact filename: ${name}`);
    exact.add(name);
    const key = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (normalized.has(key)) throw workflowError("ARTIFACT_NAME_AMBIGUOUS", `ambiguous artifact filename: ${name}`);
    normalized.add(key);
  }
}

function readArtifactEntries(artifactDirectory) {
  const directoryStat = assertArtifactDirectory(artifactDirectory);
  let entries;
  try {
    entries = fs.readdirSync(artifactDirectory, { withFileTypes: true });
  } catch (error) {
    throw workflowError(
      "ARTIFACT_DIRECTORY_INVALID",
      `artifact directory could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (entries.length === 0) throw workflowError("ARTIFACT_DIRECTORY_EMPTY", "artifact directory is empty");

  const names = entries.map((entry) => entry.name).sort(compareBytes);
  assertUniqueArtifactNames(names);
  for (const entry of entries) {
    const filePath = path.join(artifactDirectory, entry.name);
    let fileStat;
    try {
      fileStat = fs.lstatSync(filePath);
    } catch (error) {
      throw workflowError(
        "ARTIFACT_FILE_INVALID",
        `artifact ${entry.name} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (entry.isSymbolicLink() || fileStat.isSymbolicLink())
      throw workflowError("ARTIFACT_FILE_INVALID", `artifact ${entry.name} must not be a symlink`);
    if (!entry.isFile() || !fileStat.isFile())
      throw workflowError("ARTIFACT_FILE_INVALID", `artifact ${entry.name} must be a direct regular file`);
    assertSupportedArtifactName(entry.name);
  }
  return { directoryStat, names };
}

function readStableArtifactDigest(artifactDirectory, name) {
  const filePath = path.join(artifactDirectory, name);
  let descriptor;
  try {
    const pathBefore = fs.lstatSync(filePath);
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile())
      throw workflowError("ARTIFACT_FILE_INVALID", `artifact ${name} must be a direct regular file`);
    descriptor = fs.openSync(filePath, "r");
    const fileBefore = fs.fstatSync(descriptor);
    if (!sameStat(pathBefore, fileBefore))
      throw workflowError("ARTIFACT_FILE_DRIFT", `artifact ${name} changed while opening`);
    if (fileBefore.size === 0) throw workflowError("ARTIFACT_FILE_INVALID", `artifact ${name} is empty`);
    const bytes = fs.readFileSync(descriptor);
    const fileAfter = fs.fstatSync(descriptor);
    const pathAfter = fs.lstatSync(filePath);
    if (!sameStat(fileBefore, fileAfter) || !sameStat(fileBefore, pathAfter) || bytes.byteLength !== fileAfter.size)
      throw workflowError("ARTIFACT_FILE_DRIFT", `artifact ${name} changed during manifest construction`);
    return { digest: crypto.createHash("sha256").update(bytes).digest("hex"), stat: fileAfter };
  } catch (error) {
    if (error instanceof WorkflowCertificationError) throw error;
    throw workflowError(
      "ARTIFACT_FILE_INVALID",
      `artifact ${name} could not be hashed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertManifestInputsUnchanged(artifactDirectory, initialDirectoryStat, names, artifacts) {
  const finalEntries = readArtifactEntries(artifactDirectory);
  if (!sameStat(initialDirectoryStat, finalEntries.directoryStat) || names.length !== finalEntries.names.length)
    throw workflowError("ARTIFACT_FILE_DRIFT", "artifact directory changed during manifest construction");
  for (let index = 0; index < names.length; index += 1) {
    if (names[index] !== finalEntries.names[index])
      throw workflowError("ARTIFACT_FILE_DRIFT", "artifact directory contents changed during manifest construction");
    const currentStat = fs.lstatSync(path.join(artifactDirectory, names[index]));
    if (!sameStat(artifacts[index].stat, currentStat))
      throw workflowError("ARTIFACT_FILE_DRIFT", `artifact ${names[index]} changed during manifest construction`);
  }
}

/** Build the exact manifest bytes used by the shared release workflow. */
export function buildArtifactManifest(artifactDirectory) {
  const initial = readArtifactEntries(artifactDirectory);
  const artifacts = initial.names.map((name) => ({ name, ...readStableArtifactDigest(artifactDirectory, name) }));
  assertManifestInputsUnchanged(artifactDirectory, initial.directoryStat, initial.names, artifacts);
  const lines = artifacts.map(({ name, digest }) => `${digest}  ${name}\n`).sort(compareBytes);
  return Buffer.from(lines.join(""), "utf8");
}

export function computeArtifactManifestSha256(artifactDirectory) {
  return crypto.createHash("sha256").update(buildArtifactManifest(artifactDirectory)).digest("hex");
}

/** Execute the no-argument extension release certification adapter. */
export async function runWorkflowCertification({
  environment = process.env,
  repositoryRoot = REPOSITORY_ROOT,
  currentSourceSha,
  dogfoodEvidenceRetriever = retrieveSelfDogfoodEvidence,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  try {
    const context = parseWorkflowContext(environment);
    const checkedOutSha = currentSourceSha ?? readCurrentSourceSha(repositoryRoot);
    if (checkedOutSha !== context.sourceSha)
      return failureResult("SOURCE_SHA_MISMATCH", "checked-out source SHA does not match RELEASE_SOURCE_SHA");

    const observedArtifactManifestSha256 = computeArtifactManifestSha256(context.artifactDirectory);
    const dogfoodEvidence = await dogfoodEvidenceRetriever({
      sourceSha: context.sourceSha,
      repositoryOwner: context.repositoryOwner,
      repositoryName: context.repositoryName,
      environment,
      fetchImpl,
      now,
    });
    return verifyGhExtensionReleaseCertification({
      expectedReleaseSourceCommitSha: context.sourceSha,
      expectedRepositoryOwner: context.repositoryOwner,
      expectedRepositoryName: context.repositoryName,
      expectedReleaseTag: context.releaseTag,
      expectedArtifactManifestSha256: context.artifactManifestSha256,
      observedArtifactManifestSha256,
      dogfoodEvidence,
    });
  } catch (error) {
    return failureResult(
      error instanceof WorkflowCertificationError ? error.code : "WORKFLOW_CERTIFICATION_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function main() {
  if (process.argv.length !== 2) {
    console.log(
      JSON.stringify(failureResult("WORKFLOW_CONTEXT_INVALID", "the certification script accepts no arguments")),
    );
    process.exitCode = 1;
  } else {
    const result = await runWorkflowCertification();
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  void main().catch((error) => {
    console.log(
      JSON.stringify(
        failureResult("WORKFLOW_CERTIFICATION_FAILED", error instanceof Error ? error.message : String(error)),
      ),
    );
    process.exitCode = 1;
  });
}
