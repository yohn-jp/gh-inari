#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  appendCertificationDiagnostic,
  isCertificationPackageName,
  isCertificationSourceCommitSha,
  sha256Tarball,
  validateSelfDogfoodEvidence,
} from "./certification-evidence.mjs";
import { verifyReleaseCertification } from "../src/release-certification.js";

const REPOSITORY_OWNER = "yohn-jp";
const REPOSITORY_NAME = "gh-inari";
const SELF_DOGFOOD_ARTIFACT_PREFIX = "self-dogfood-golden-path-";
const SELF_DOGFOOD_EVIDENCE_FILE = "self-dogfood-golden-path.json";
const MAX_GITHUB_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_ARCHIVE_BYTES = 32 * 1024 * 1024;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_CONTEXT_KEYS = Object.freeze([
  "GITHUB_REPOSITORY",
  "RELEASE_SOURCE_SHA",
  "RELEASE_TAG",
  "RELEASE_ARTIFACT_PATH",
  "RELEASE_ARTIFACT_SHA256",
]);

const USAGE =
  "usage: node --import tsx scripts/verify-release-certification.mjs --source-sha <sha> --package-name <name> " +
  "--package-version <version> --tarball-sha256 sha256:<digest> --repository-owner <owner> " +
  "--repository-name <name> --packed-evidence <file> --dogfood-evidence <file>";
const OPTION_NAMES = new Set([
  "--source-sha",
  "--package-name",
  "--package-version",
  "--tarball-sha256",
  "--repository-owner",
  "--repository-name",
  "--packed-evidence",
  "--dogfood-evidence",
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

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const key = argumentsList[index];
    if (key === "--help") {
      console.log(USAGE);
      process.exit(0);
    }
    if (!key?.startsWith("--") || index + 1 >= argumentsList.length || argumentsList[index + 1]?.startsWith("--")) {
      throw new Error(USAGE);
    }
    if (!OPTION_NAMES.has(key)) throw new Error(`unknown option: ${key}`);
    if (values.has(key)) throw new Error(`duplicate option: ${key}`);
    values.set(key, argumentsList[index + 1]);
    index += 1;
  }
  return {
    sourceSha: values.get("--source-sha"),
    packageName: values.get("--package-name"),
    packageVersion: values.get("--package-version"),
    tarballSha256: values.get("--tarball-sha256"),
    repositoryOwner: values.get("--repository-owner"),
    repositoryName: values.get("--repository-name"),
    packedEvidence: values.get("--packed-evidence"),
    dogfoodEvidence: values.get("--dogfood-evidence"),
  };
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (error) {
    throw workflowError(
      "EVIDENCE_MALFORMED",
      `${label} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requireEnvironmentValue(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0)
    throw workflowError("WORKFLOW_CONTEXT_MISSING", `${key} is required`);
  if (/^[\u0000-\u001F\u007F]/u.test(value) || /[\u0000-\u001F\u007F]$/u.test(value))
    throw workflowError("WORKFLOW_CONTEXT_INVALID", `${key} contains control characters`);
  return value;
}

/** Parse the no-argument environment contract used by the reusable npm workflow. */
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
  const artifactPath = requireEnvironmentValue(environment, "RELEASE_ARTIFACT_PATH");
  const artifactSha256 = requireEnvironmentValue(environment, "RELEASE_ARTIFACT_SHA256");
  if (!/^[0-9a-f]{64}$/u.test(artifactSha256))
    throw workflowError("WORKFLOW_CONTEXT_INVALID", "RELEASE_ARTIFACT_SHA256 must be a lowercase SHA-256 digest");

  return {
    repositoryOwner: REPOSITORY_OWNER,
    repositoryName: REPOSITORY_NAME,
    sourceSha,
    releaseTag,
    artifactPath: path.resolve(artifactPath),
    artifactSha256,
  };
}

function readPackageMetadata(repositoryRoot) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  } catch (error) {
    throw workflowError(
      "PACKAGE_METADATA_INVALID",
      `package.json could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validatePackageMetadata(value);
}

function validatePackageMetadata(value) {
  if (
    !isRecord(value) ||
    !isCertificationPackageName(value.name) ||
    typeof value.version !== "string" ||
    value.version.length === 0
  )
    throw workflowError("PACKAGE_METADATA_INVALID", "package metadata must define a valid package name and version");
  return { name: value.name, version: value.version };
}

function assertReleaseTagMatchesPackageVersion(releaseTag, packageVersion) {
  const releaseVersion = releaseTag.startsWith("v") ? releaseTag.slice(1) : releaseTag;
  if (releaseVersion !== packageVersion)
    throw workflowError(
      "PACKAGE_VERSION_MISMATCH",
      `release tag ${releaseTag} does not match package.json version ${packageVersion}`,
    );
}

export function readCurrentSourceSha(repositoryRoot, runCommand = defaultCommandRunner) {
  const result = runCommand("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0)
    throw workflowError("CHECKOUT_SOURCE_UNAVAILABLE", "the checked-out source SHA could not be determined");
  const sourceSha = (result.stdout ?? "").trim();
  if (!isCertificationSourceCommitSha(sourceSha))
    throw workflowError("CHECKOUT_SOURCE_UNAVAILABLE", "git rev-parse HEAD did not return an exact commit SHA");
  return sourceSha;
}

function assertRegularFile(filePath, label) {
  try {
    if (!fs.statSync(filePath).isFile()) throw new Error("is not a regular file");
  } catch (error) {
    throw workflowError(
      "ARTIFACT_FILE_INVALID",
      `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return filePath;
}

function defaultCommandRunner(command, argumentsList, options = {}) {
  return spawnSync(command, argumentsList, options);
}

function commandFailure(result, label) {
  if (result?.error !== undefined) return `${label} failed to start: ${result.error.message}`;
  return `${label} failed with status ${String(result?.status)}`;
}

/** Run the existing packed certification against the supplied tarball only. */
export function generatePackedEvidence({
  artifactPath,
  evidencePath,
  repositoryRoot = REPOSITORY_ROOT,
  runCommand = defaultCommandRunner,
}) {
  assertRegularFile(artifactPath, "release artifact");
  const smokeScript = path.join(repositoryRoot, "scripts", "smoke-test.mjs");
  const result = runCommand(process.execPath, [smokeScript, "--tarball", artifactPath, "--evidence", evidencePath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!fs.existsSync(evidencePath))
    throw workflowError("PACKED_CERTIFICATION_FAILED", commandFailure(result, "packed certification"));
  // A failed smoke process writes failed evidence before exiting. Preserve that
  // canonical document so release composition supplies the bounded verdict.
  return readJson(evidencePath, "packed evidence");
}

function githubApiBase(environment) {
  const value =
    typeof environment.GITHUB_API_URL === "string" && environment.GITHUB_API_URL.length > 0
      ? environment.GITHUB_API_URL
      : "https://api.github.com";
  try {
    return new URL(value.endsWith("/") ? value : `${value}/`);
  } catch (error) {
    throw workflowError(
      "GITHUB_API_INVALID",
      `GITHUB_API_URL is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function githubHeaders(environment) {
  const token =
    typeof environment.GITHUB_TOKEN === "string" && environment.GITHUB_TOKEN.length > 0
      ? environment.GITHUB_TOKEN
      : typeof environment.GH_TOKEN === "string" && environment.GH_TOKEN.length > 0
        ? environment.GH_TOKEN
        : undefined;
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  };
}

async function readGitHubJson(response, label) {
  if (!response?.ok)
    throw workflowError("ARTIFACT_LOOKUP_FAILED", `${label} returned HTTP ${String(response?.status)}`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_GITHUB_RESPONSE_BYTES)
    throw workflowError("ARTIFACT_LOOKUP_FAILED", `${label} response exceeded the bounded size limit`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw workflowError(
      "ARTIFACT_LOOKUP_FAILED",
      `${label} did not return JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function artifactDate(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw workflowError("ARTIFACT_METADATA_INVALID", `artifact ${field} is invalid`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw workflowError("ARTIFACT_METADATA_INVALID", `artifact ${field} is invalid`);
  return timestamp;
}

function selectArtifact(payload, expectedName, sourceSha, now) {
  if (!isRecord(payload) || !Array.isArray(payload.artifacts))
    throw workflowError("ARTIFACT_LOOKUP_FAILED", "Actions artifact response did not contain an artifact list");
  const named = payload.artifacts.filter((artifact) => isRecord(artifact) && artifact.name === expectedName);
  if (named.length === 0)
    throw workflowError("SELF_DOGFOOD_ARTIFACT_MISSING", `no artifact named ${expectedName} was found`);

  const active = [];
  for (const artifact of named) {
    if (!Number.isSafeInteger(artifact.id) || artifact.id < 1)
      throw workflowError("ARTIFACT_METADATA_INVALID", "self-dogfood artifact has an invalid id");
    if (typeof artifact.expired !== "boolean")
      throw workflowError("ARTIFACT_METADATA_INVALID", "self-dogfood artifact has an invalid expiration flag");
    const expiresAt = artifactDate(artifact.expires_at, "expires_at");
    if (!artifact.expired && (expiresAt === undefined || expiresAt > now)) active.push(artifact);
  }
  if (active.length === 0) throw workflowError("SELF_DOGFOOD_ARTIFACT_EXPIRED", `artifact ${expectedName} is expired`);

  active.sort((left, right) => {
    const leftCreated = artifactDate(left.created_at, "created_at") ?? 0;
    const rightCreated = artifactDate(right.created_at, "created_at") ?? 0;
    return rightCreated - leftCreated || right.id - left.id;
  });
  const selected = active[0];
  const headSha = selected.workflow_run?.head_sha;
  if (headSha !== undefined) {
    if (!isCertificationSourceCommitSha(headSha))
      throw workflowError("ARTIFACT_METADATA_INVALID", "self-dogfood workflow head SHA is invalid");
    if (headSha !== sourceSha)
      throw workflowError(
        "DOGFOOD_SOURCE_MISMATCH",
        "self-dogfood artifact workflow head SHA does not match the release",
      );
  }
  return selected;
}

function archiveCommand(command, argumentsList) {
  return spawnSync(command, argumentsList, { encoding: "utf8", maxBuffer: MAX_ARTIFACT_ARCHIVE_BYTES });
}

function archiveEntryIsSafe(entry) {
  if (entry.length === 0 || entry.includes("\u0000") || entry.startsWith("/")) return false;
  const normalized = path.posix.normalize(entry);
  return normalized === entry && normalized !== ".." && !normalized.startsWith("../") && !entry.endsWith("/");
}

/** Extract and canonically validate the single #449 self-dogfood document. */
export function extractSelfDogfoodEvidence(archivePath, { runCommand = archiveCommand } = {}) {
  const listing = runCommand("unzip", ["-Z1", archivePath]);
  if (listing.error !== undefined || listing.status !== 0)
    throw workflowError("ARTIFACT_ARCHIVE_INVALID", commandFailure(listing, "artifact archive listing"));
  const entries = String(listing.stdout ?? "")
    .split(/\r?\n/u)
    .filter((entry) => entry.length > 0);
  const candidates = entries.filter(
    (entry) => archiveEntryIsSafe(entry) && path.posix.basename(entry) === SELF_DOGFOOD_EVIDENCE_FILE,
  );
  if (candidates.length !== 1)
    throw workflowError(
      "ARTIFACT_EVIDENCE_AMBIGUOUS",
      `artifact must contain exactly one ${SELF_DOGFOOD_EVIDENCE_FILE} document`,
    );
  const document = runCommand("unzip", ["-p", archivePath, candidates[0]]);
  if (document.error !== undefined || document.status !== 0)
    throw workflowError("ARTIFACT_ARCHIVE_INVALID", commandFailure(document, "artifact evidence extraction"));
  let evidence;
  try {
    evidence = JSON.parse(String(document.stdout ?? ""));
  } catch (error) {
    throw workflowError(
      "EVIDENCE_MALFORMED",
      `self-dogfood evidence is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const validation = validateSelfDogfoodEvidence(evidence);
  if (!validation.valid)
    throw workflowError(
      "EVIDENCE_MALFORMED",
      `self-dogfood evidence failed canonical validation: ${validation.diagnostics.map(({ message }) => message).join("; ")}`,
    );
  return evidence;
}

/** Retrieve #449 evidence without trusting artifact names as the evidence authority. */
export async function retrieveSelfDogfoodEvidence({
  sourceSha,
  repositoryOwner = REPOSITORY_OWNER,
  repositoryName = REPOSITORY_NAME,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  extractArchive = extractSelfDogfoodEvidence,
} = {}) {
  if (repositoryOwner !== REPOSITORY_OWNER || repositoryName !== REPOSITORY_NAME)
    throw workflowError("REPOSITORY_MISMATCH", "self-dogfood retrieval is restricted to yohn-jp/gh-inari");
  if (!isCertificationSourceCommitSha(sourceSha))
    throw workflowError("WORKFLOW_CONTEXT_INVALID", "self-dogfood retrieval requires an exact source SHA");
  if (typeof fetchImpl !== "function") throw workflowError("ARTIFACT_LOOKUP_FAILED", "fetch is unavailable");

  const artifactName = `${SELF_DOGFOOD_ARTIFACT_PREFIX}${sourceSha}`;
  const base = githubApiBase(environment);
  const repositoryPath = `repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/actions/artifacts`;
  const listUrl = new URL(`${repositoryPath}?name=${encodeURIComponent(artifactName)}&per_page=100`, base).toString();
  const headers = githubHeaders(environment);
  let listResponse;
  try {
    listResponse = await fetchImpl(listUrl, { headers });
  } catch (error) {
    throw workflowError(
      "ARTIFACT_LOOKUP_FAILED",
      `Actions artifact lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const selected = selectArtifact(
    await readGitHubJson(listResponse, "Actions artifact lookup"),
    artifactName,
    sourceSha,
    now,
  );
  const downloadUrl = new URL(`${repositoryPath}/${String(selected.id)}/zip`, base).toString();
  let archiveResponse;
  try {
    archiveResponse = await fetchImpl(downloadUrl, { headers });
  } catch (error) {
    throw workflowError(
      "ARTIFACT_DOWNLOAD_FAILED",
      `Actions artifact download failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!archiveResponse?.ok)
    throw workflowError(
      "ARTIFACT_DOWNLOAD_FAILED",
      `Actions artifact download returned HTTP ${String(archiveResponse?.status)}`,
    );
  let archiveBytes;
  try {
    archiveBytes = Buffer.from(await archiveResponse.arrayBuffer());
  } catch (error) {
    throw workflowError(
      "ARTIFACT_DOWNLOAD_FAILED",
      `Actions artifact bytes could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (archiveBytes.length > MAX_ARTIFACT_ARCHIVE_BYTES)
    throw workflowError("ARTIFACT_DOWNLOAD_FAILED", "Actions artifact archive exceeded the bounded size limit");

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "inari-dogfood-artifact-"));
  const archivePath = path.join(temporaryDirectory, "artifact.zip");
  try {
    fs.writeFileSync(archivePath, archiveBytes, { mode: 0o600 });
    return await extractArchive(archivePath);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function failureResult(code, message) {
  const diagnostics = [];
  appendCertificationDiagnostic(diagnostics, code, message);
  return { passed: false, diagnostics };
}

/** Execute the no-argument workflow adapter and delegate the verdict to Core. */
export async function runWorkflowCertification({
  environment = process.env,
  repositoryRoot = REPOSITORY_ROOT,
  currentSourceSha,
  packageMetadata,
  packedEvidenceGenerator = generatePackedEvidence,
  dogfoodEvidenceRetriever = retrieveSelfDogfoodEvidence,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  let temporaryDirectory;
  try {
    const context = parseWorkflowContext(environment);
    const metadata = validatePackageMetadata(packageMetadata ?? readPackageMetadata(repositoryRoot));
    assertReleaseTagMatchesPackageVersion(context.releaseTag, metadata.version);

    const checkedOutSha = currentSourceSha ?? readCurrentSourceSha(repositoryRoot);
    if (checkedOutSha !== context.sourceSha)
      return failureResult("SOURCE_SHA_MISMATCH", "checked-out source SHA does not match RELEASE_SOURCE_SHA");

    assertRegularFile(context.artifactPath, "RELEASE_ARTIFACT_PATH");
    const expectedTarballSha256 = `sha256:${context.artifactSha256}`;
    if (sha256Tarball(context.artifactPath) !== expectedTarballSha256)
      return failureResult("TARBALL_DIGEST_MISMATCH", "RELEASE_ARTIFACT_PATH does not match RELEASE_ARTIFACT_SHA256");

    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "inari-release-certification-"));
    const packedEvidence = await packedEvidenceGenerator({
      artifactPath: context.artifactPath,
      evidencePath: path.join(temporaryDirectory, "packed-evidence.json"),
      repositoryRoot,
    });
    const dogfoodEvidence = await dogfoodEvidenceRetriever({
      sourceSha: context.sourceSha,
      repositoryOwner: context.repositoryOwner,
      repositoryName: context.repositoryName,
      environment,
      fetchImpl,
      now,
    });
    return verifyReleaseCertification({
      expectedReleaseSourceCommitSha: context.sourceSha,
      expectedPackageName: metadata.name,
      expectedPackageVersion: metadata.version,
      expectedTarballSha256,
      expectedRepositoryOwner: context.repositoryOwner,
      expectedRepositoryName: context.repositoryName,
      packedEvidence,
      dogfoodEvidence,
    });
  } catch (error) {
    return failureResult(
      error instanceof WorkflowCertificationError ? error.code : "WORKFLOW_CERTIFICATION_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (temporaryDirectory !== undefined) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function explicitModeResult(argumentsList) {
  const options = parseArgs(argumentsList);
  const missing = Object.entries(options)
    .filter(([, value]) => typeof value !== "string" || value.length === 0)
    .map(([key]) => key);
  if (missing.length > 0) throw new Error(`${USAGE}; missing: ${missing.join(", ")}`);
  return verifyReleaseCertification({
    expectedReleaseSourceCommitSha: options.sourceSha,
    expectedPackageName: options.packageName,
    expectedPackageVersion: options.packageVersion,
    expectedTarballSha256: options.tarballSha256,
    expectedRepositoryOwner: options.repositoryOwner,
    expectedRepositoryName: options.repositoryName,
    packedEvidence: readJson(options.packedEvidence, "packed evidence"),
    dogfoodEvidence: readJson(options.dogfoodEvidence, "dogfood evidence"),
  });
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const result =
    argumentsList.length === 0
      ? await runWorkflowCertification()
      : (() => {
          try {
            return explicitModeResult(argumentsList);
          } catch (error) {
            return failureResult(
              "WORKFLOW_CERTIFICATION_FAILED",
              error instanceof Error ? error.message : String(error),
            );
          }
        })();
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("verify-release-certification.mjs")) {
  void main().catch((error) => {
    console.log(
      JSON.stringify(
        failureResult("WORKFLOW_CERTIFICATION_FAILED", error instanceof Error ? error.message : String(error)),
      ),
    );
    process.exitCode = 1;
  });
}

export { parseArgs };
