#!/usr/bin/env node
/*
 * Explicitly opt-in live dogfood for gh-inari itself.
 *
 * This runner is deliberately a coordinator, not a lifecycle implementation:
 * all Issue/Change/Ready decisions come from the installed Inari executable.
 * It never calls raw GitHub mutation commands and it never repairs a branch or
 * pull request locally.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  appendCertificationDiagnostic,
  appendSelfDogfoodOperation,
  CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
  CERTIFICATION_KINDS,
  CERTIFICATION_RESULTS,
  MAX_CERTIFICATION_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_CERTIFICATION_DIAGNOSTICS,
  MAX_CERTIFICATION_OPERATIONS,
  serializeCertificationEvidence,
  SELF_DOGFOOD_OPERATIONS as CERTIFICATION_SELF_DOGFOOD_OPERATIONS,
  SELF_DOGFOOD_OUTCOMES as CERTIFICATION_SELF_DOGFOOD_OUTCOMES,
  validateDisposableGovernedIssue,
  validateSelfDogfoodEvidence,
  writeCertificationEvidence,
} from "./certification-evidence.mjs";

export const SELF_DOGFOOD_SCHEMA_VERSION = CERTIFICATION_EVIDENCE_SCHEMA_VERSION;
export const SELF_DOGFOOD_KIND = CERTIFICATION_KINDS[1];
export const MAX_DIAGNOSTICS = MAX_CERTIFICATION_DIAGNOSTICS;
export const MAX_OPERATIONS = MAX_CERTIFICATION_OPERATIONS;
export const MAX_DIAGNOSTIC_MESSAGE = MAX_CERTIFICATION_DIAGNOSTIC_MESSAGE_LENGTH;

const [CERTIFICATION_RESULT_PASSED, , CERTIFICATION_RESULT_BLOCKED] = CERTIFICATION_RESULTS;
export const SELF_DOGFOOD_OPERATIONS = CERTIFICATION_SELF_DOGFOOD_OPERATIONS;
export const SELF_DOGFOOD_OUTCOMES = CERTIFICATION_SELF_DOGFOOD_OUTCOMES;
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u;
const SECRET_KEY_PATTERN = /(token|secret|private|password|credential|app[_-]?key)/iu;
const SAFE_WORKER_ENV_KEYS = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "TMP",
  "TEMP",
  "TMPDIR",
  "USER",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME",
]);
export const WORKER_HANDOFF_FIELDS = Object.freeze([
  "version",
  "kind",
  "repositoryHost",
  "repositoryId",
  "repositoryNameWithOwner",
  "rootIssue",
  "changeVersion",
  "state",
  "branch",
  "baseBranch",
  "pullRequest",
]);
const WORKER_HANDOFF_FIELD_SET = new Set(WORKER_HANDOFF_FIELDS);
const REQUIRED_WORKER_HANDOFF_FIELDS = new Set(
  WORKER_HANDOFF_FIELDS.filter((field) => field !== "repositoryNameWithOwner"),
);
const IMPLEMENTATION_HANDOFF_CONTRACT_VERSION = 1;
const IMPLEMENTATION_HANDOFF_KIND = "implementation-handoff";
const CHANGE_CONTRACT_VERSION = 1;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function redact(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .replace(/(bearer\s+|token[=:]\s*|secret[=:]\s*|password[=:]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/[A-Za-z0-9_\-/+=]{32,}/gu, "[REDACTED]");
}

function addDiagnostic(diagnostics, code, message) {
  appendCertificationDiagnostic(diagnostics, code, redact(message));
}

function parsePositiveInteger(value, option) {
  if (!/^\d+$/u.test(value ?? "")) throw new Error(`${option} must be a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${option} must be a positive integer`);
  return number;
}

function parseRepository(value) {
  const match = REPOSITORY_PATTERN.exec(value ?? "");
  if (match === null) throw new Error("--repository must be an owner/name identity");
  return { owner: match[1], name: match[2] };
}

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

/** Parse only the harness options; command arguments are never shell-evaluated. */
export function parseArguments(argv) {
  const options = {
    inari: process.env.INARI_BIN ?? "inari",
    repository: undefined,
    issue: undefined,
    confirmDisposable: undefined,
    workerCommand: undefined,
    workerCwd: undefined,
    output: undefined,
    abort: false,
    timeoutMs: COMMAND_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true, options };
    if (token === "--abort") {
      options.abort = true;
      continue;
    }
    if (token === "--inari") {
      options.inari = requireValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token === "--repository") {
      options.repository = parseRepository(requireValue(argv, index, token));
      index += 1;
      continue;
    }
    if (token === "--issue" || token === "--disposable-issue") {
      options.issue = parsePositiveInteger(requireValue(argv, index, token), token);
      index += 1;
      continue;
    }
    if (token === "--confirm-disposable") {
      options.confirmDisposable = parsePositiveInteger(requireValue(argv, index, token), token);
      index += 1;
      continue;
    }
    if (token === "--worker-command") {
      const value = requireValue(argv, index, token);
      try {
        const command = JSON.parse(value);
        if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string"))
          throw new Error("must be a non-empty JSON string array");
        options.workerCommand = command;
      } catch (error) {
        throw new Error(`--worker-command must be a non-empty JSON string array: ${error.message}`);
      }
      index += 1;
      continue;
    }
    if (token === "--worker-cwd") {
      options.workerCwd = path.resolve(requireValue(argv, index, token));
      index += 1;
      continue;
    }
    if (token === "--output") {
      options.output = path.resolve(requireValue(argv, index, token));
      index += 1;
      continue;
    }
    if (token === "--timeout-ms") {
      const timeout = parsePositiveInteger(requireValue(argv, index, token), token);
      options.timeoutMs = Math.min(timeout, COMMAND_TIMEOUT_MS);
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }
  return { help: false, options };
}

function usage() {
  return [
    "Usage:",
    "  INARI_SELF_DOGFOOD=1 node scripts/self-dogfood.mjs --repository owner/name --issue N",
    '    --confirm-disposable N --worker-cwd /path/to/clone --worker-command \'["command","arg"]\'',
    "",
    "The Issue number must be explicitly confirmed as disposable. The worker is",
    "invoked only after Inari has issued the canonical branch and Draft PR.",
    "Pass --abort and INARI_SELF_DOGFOOD_ALLOW_RECOVERY=1 only for a disposable",
    "Change whose existing Core recovery contract permits cleanup.",
  ].join("\n");
}

function runCommand(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: MAX_CAPTURE_BYTES,
  });
  if (result.error !== undefined) {
    return {
      ok: false,
      status: result.status,
      error: result.error,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
  return { ok: result.status === 0, status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function parseJsonOutput(result, operation) {
  const output = result.stdout.trim();
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value !== null && typeof value === "object") return value;
    } catch {
      // Inari may print bounded progress text before its final JSON line.
    }
  }
  throw new Error(`${operation} did not return a JSON object`);
}

function runInari(options, args, evidence) {
  const result = runCommand(options.inari, [...args, "--json"], {
    cwd: repoRoot,
    env: process.env,
    timeoutMs: options.timeoutMs,
  });
  if (!result.ok) {
    try {
      preserveAuthoritativeFinalState(evidence, parseJsonOutput(result, args.join(" ")));
    } catch {
      // A failed command without readable authoritative JSON remains unavailable.
    }
    const detail = (result.error?.message ?? result.stderr.trim()) || `exit status ${result.status}`;
    throw new Error(`${args.join(" ")} failed: ${redact(detail)}`);
  }
  const value = parseJsonOutput(result, args.join(" "));
  preserveAuthoritativeFinalState(evidence, value);
  return value;
}

function outputField(value, ...paths) {
  for (const pathParts of paths) {
    let current = value;
    for (const part of pathParts) current = current?.[part];
    if (current !== undefined && current !== null) return current;
  }
  return undefined;
}

function changeIdentity(value, fallbackIssue) {
  const branch = outputField(value, ["branch"], ["canonicalBranch"], ["change", "projection", "branch"]);
  const pullRequest = outputField(value, ["pullRequest"], ["change", "projection", "pullRequest"]);
  const reportedIssue = outputField(value, ["issue"], ["change"], ["projection", "change", "identity", "rootIssue"]);
  if (typeof branch !== "string" || branch.length === 0) throw new Error("Change response omitted canonical branch");
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
    throw new Error("Change response omitted canonical pull request");
  if (reportedIssue !== undefined && reportedIssue !== fallbackIssue)
    throw new Error("Change response returned a different root Issue identity");
  return { issue: fallbackIssue, branch, pullRequest };
}

function outcome(value) {
  return outputField(value, ["evidence", "outcome"], ["outcome"], ["status"]) ?? "unknown";
}

function publicStatus(value) {
  return outputField(value, ["state"], ["status"], ["projection", "change", "state"], ["projection", "status"]);
}

function authoritativeRecovery(value) {
  const recoveryPaths = [
    ["recovery"],
    ["projection", "recovery"],
    ["status", "recovery"],
    ["projection", "change", "recovery"],
  ];
  let recovery;
  for (const pathParts of recoveryPaths) {
    let current = value;
    for (const part of pathParts) current = current?.[part];
    if (current !== undefined) {
      recovery = current;
      break;
    }
  }
  if (recovery === null) return { state: "none", action: null };
  if (
    recovery !== null &&
    typeof recovery === "object" &&
    typeof recovery.state === "string" &&
    (typeof recovery.action === "string" || recovery.action === null)
  )
    return { state: recovery.state, action: recovery.action };
  return { state: "unavailable", action: "inspect" };
}

function preserveAuthoritativeFinalState(evidence, value) {
  const status = publicStatus(value);
  if (typeof status === "string" && status.length > 0)
    evidence.finalState = { status, recovery: authoritativeRecovery(value) };
}

function isReview(value) {
  return publicStatus(value) === "REVIEW";
}

function isReturnedExisting(value) {
  return outcome(value) === "returned-existing";
}

function isSuccess(value) {
  return (
    value?.ok === true &&
    (outcome(value) === "verified" || outcome(value) === "returned-existing" || outcome(value) === "success")
  );
}

function contractVersion(value, ...keys) {
  const paths = [];
  for (const key of keys) {
    paths.push([key], ["contractVersions", key], ["projection", key], ["projection", "change", key]);
    if (key === "goldenPath") paths.push(["entry", "version"], ["entry", "contractVersion"]);
  }
  for (const pathParts of paths) {
    const candidate = outputField(value, pathParts);
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 1) return String(candidate);
  }
  return "unknown";
}

/**
 * Project only the canonical handoff fields into the worker boundary.  The
 * installed Inari handoff contract owns their meaning; this function only
 * rejects widening/unknown fields and keeps credentials out of the payload.
 */
export function projectWorkerHandoff(handoff) {
  if (handoff === null || typeof handoff !== "object" || Array.isArray(handoff))
    throw new Error("implementation handoff must be an object");
  const unknown = Object.keys(handoff).filter((key) => !WORKER_HANDOFF_FIELD_SET.has(key));
  if (unknown.length > 0) throw new Error(`implementation handoff has unsupported fields: ${unknown.join(", ")}`);
  if (handoff.version !== IMPLEMENTATION_HANDOFF_CONTRACT_VERSION)
    throw new Error("implementation handoff has an unsupported contract version");
  if (handoff.kind !== IMPLEMENTATION_HANDOFF_KIND) throw new Error("implementation handoff has an invalid kind");
  if (
    typeof handoff.repositoryHost !== "string" ||
    handoff.repositoryHost.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(handoff.repositoryHost)
  )
    throw new Error("implementation handoff has an invalid repository host");
  if (
    typeof handoff.repositoryId !== "string" ||
    handoff.repositoryId.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(handoff.repositoryId)
  )
    throw new Error("implementation handoff has an invalid repository identity");
  if (!Number.isSafeInteger(handoff.rootIssue) || handoff.rootIssue < 1)
    throw new Error("implementation handoff has an invalid root Issue");
  if (handoff.changeVersion !== CHANGE_CONTRACT_VERSION)
    throw new Error("implementation handoff has an unsupported Change contract version");
  if (handoff.state !== "DRAFT") throw new Error("implementation handoff state must be DRAFT");
  for (const [field, value] of [
    ["branch", handoff.branch],
    ["baseBranch", handoff.baseBranch],
  ]) {
    if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value))
      throw new Error(`implementation handoff has an invalid ${field}`);
  }
  if (!Number.isSafeInteger(handoff.pullRequest) || handoff.pullRequest < 1)
    throw new Error("implementation handoff has an invalid pull request");
  if (
    handoff.repositoryNameWithOwner !== undefined &&
    (typeof handoff.repositoryNameWithOwner !== "string" || !REPOSITORY_PATTERN.test(handoff.repositoryNameWithOwner))
  )
    throw new Error("implementation handoff has an invalid repository locator");
  const projected = {};
  for (const field of WORKER_HANDOFF_FIELDS) {
    if (!Object.hasOwn(handoff, field)) {
      if (!REQUIRED_WORKER_HANDOFF_FIELDS.has(field)) continue;
      throw new Error(`implementation handoff omitted ${field}`);
    }
    const value = handoff[field];
    if (typeof value === "string" && SECRET_KEY_PATTERN.test(value))
      throw new Error(`implementation handoff field ${field} contains sensitive text`);
    projected[field] = value;
  }
  return Object.freeze(projected);
}

/** Keep the worker environment allowlisted; issuer credentials never cross the handoff. */
export function sanitizeWorkerEnvironment(environment, handoff, sourceSha) {
  const projectedHandoff = projectWorkerHandoff(handoff);
  if (!SHA_PATTERN.test(sourceSha ?? "")) throw new Error("worker source commit SHA must be exact lowercase hex");
  const safe = {};
  for (const [key, value] of Object.entries(environment)) {
    if (SAFE_WORKER_ENV_KEYS.has(key) && !SECRET_KEY_PATTERN.test(key)) safe[key] = value;
  }
  safe.INARI_IMPLEMENTATION_HANDOFF = JSON.stringify(projectedHandoff);
  safe.INARI_IMPLEMENTATION_BRANCH = projectedHandoff.branch;
  safe.INARI_CHANGE_ISSUE = String(projectedHandoff.rootIssue);
  safe.INARI_CHANGE_PULL_REQUEST = String(projectedHandoff.pullRequest);
  safe.INARI_SOURCE_COMMIT_SHA = sourceSha;
  return safe;
}

function sourceCommitSha() {
  const result = runCommand("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repoRoot,
    env: process.env,
    timeoutMs: 10_000,
  });
  const sha = result.stdout.trim();
  if (!result.ok || !SHA_PATTERN.test(sha)) throw new Error("unable to establish exact source commit SHA");
  return sha;
}

function initialEvidence(options, sha) {
  return {
    schemaVersion: SELF_DOGFOOD_SCHEMA_VERSION,
    certificationKind: SELF_DOGFOOD_KIND,
    result: CERTIFICATION_RESULT_BLOCKED,
    sourceCommitSha: sha ?? null,
    contractVersions: { goldenPath: "unknown", statusRecovery: "unknown", skill: "unknown" },
    repository: options.repository,
    rootIssue: options.issue,
    change: { issue: options.issue, branch: "unresolved", pullRequest: 0 },
    operations: [],
    finalState: { status: "UNAVAILABLE", recovery: { state: "unavailable", action: "inspect" } },
    diagnostics: [],
  };
}

function recordOperation(evidence, operation, operationOutcome) {
  evidence.operations = appendSelfDogfoodOperation(evidence.operations, operation, operationOutcome);
}

function failEvidence(evidence, code, message, result = CERTIFICATION_RESULT_BLOCKED) {
  evidence.result = result;
  addDiagnostic(evidence.diagnostics, code, message);
  return evidence;
}

function writeEvidence(evidence, output) {
  if (output !== undefined) {
    writeCertificationEvidence(output, evidence);
  } else {
    process.stdout.write(serializeCertificationEvidence(evidence));
  }
}

function assertPreconditions(options, evidence) {
  if (process.env.INARI_SELF_DOGFOOD !== "1") throw new Error("set INARI_SELF_DOGFOOD=1 to opt into live dogfood");
  if (options.issue === undefined || options.confirmDisposable !== options.issue)
    throw new Error("--confirm-disposable must exactly match the disposable root Issue");
  if (options.workerCommand === undefined || options.workerCwd === undefined)
    throw new Error("--worker-cwd and --worker-command are required for implementation handoff");
  if (!fs.existsSync(options.workerCwd) || !fs.statSync(options.workerCwd).isDirectory())
    throw new Error("--worker-cwd must be an existing directory");
  const resolvedRepoRoot = fs.realpathSync(repoRoot);
  const resolvedWorkerCwd = fs.realpathSync(options.workerCwd);
  const relative = path.relative(resolvedRepoRoot, resolvedWorkerCwd);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".."))
    throw new Error("worker cwd must be outside the source checkout");
  if (options.abort && process.env.INARI_SELF_DOGFOOD_ALLOW_RECOVERY !== "1")
    throw new Error("--abort requires INARI_SELF_DOGFOOD_ALLOW_RECOVERY=1");
  void evidence;
}

function runWorker(options, handoff, sourceSha) {
  const workerHome = fs.mkdtempSync(path.join(os.tmpdir(), "inari-dogfood-worker-home-"));
  const workerEnvironment = sanitizeWorkerEnvironment(process.env, handoff, sourceSha);
  workerEnvironment.HOME = workerHome;
  workerEnvironment.GIT_CONFIG_GLOBAL = path.join(workerHome, ".gitconfig");
  workerEnvironment.GIT_CONFIG_NOSYSTEM = "1";
  fs.writeFileSync(workerEnvironment.GIT_CONFIG_GLOBAL, "", { encoding: "utf8", mode: 0o600 });
  try {
    const result = runCommand(options.workerCommand[0], options.workerCommand.slice(1), {
      cwd: options.workerCwd,
      env: workerEnvironment,
      timeoutMs: options.timeoutMs,
    });
    if (!result.ok) {
      const detail = (result.error?.message ?? result.stderr.trim()) || `exit status ${result.status}`;
      throw new Error(`implementation worker failed: ${redact(detail)}`);
    }
  } finally {
    fs.rmSync(workerHome, { recursive: true, force: true });
  }
}

async function runDogfood(options) {
  let sha;
  try {
    sha = sourceCommitSha();
  } catch (error) {
    const evidence = initialEvidence(options, null);
    return failEvidence(
      evidence,
      "SOURCE_COMMIT_SHA_UNAVAILABLE",
      error instanceof Error ? error.message : String(error),
    );
  }
  const evidence = initialEvidence(options, sha);
  try {
    assertPreconditions(options, evidence);
    const invoke = (args) => runInari(options, args, evidence);
    recordOperation(evidence, SELF_DOGFOOD_OPERATIONS.OPT_IN, SELF_DOGFOOD_OUTCOMES.VERIFIED);

    const runtime = invoke(["--version"]);
    if (runtime.ok !== true || runtime.name !== "gh-inari")
      throw new Error("installed executable identity was not gh-inari");
    recordOperation(evidence, SELF_DOGFOOD_OPERATIONS.EXECUTABLE, SELF_DOGFOOD_OUTCOMES.VERIFIED);

    const skill = invoke(["skill", "golden-path"]);
    const skillVersion = skill.version ?? skill.contractVersion;
    if (typeof skillVersion !== "string" || skillVersion.length === 0 || skill.id !== "golden-path")
      throw new Error("golden-path Skill contract is unavailable");
    evidence.contractVersions.skill = skillVersion;
    recordOperation(evidence, SELF_DOGFOOD_OPERATIONS.SKILL, SELF_DOGFOOD_OUTCOMES.VERIFIED);

    const issueCheck = invoke([
      "issue",
      "check",
      String(options.issue),
      "--repository",
      `${options.repository.owner}/${options.repository.name}`,
    ]);
    if (!validateDisposableGovernedIssue(issueCheck).valid) throw new Error("disposable Issue marker is invalid");
    recordOperation(evidence, SELF_DOGFOOD_OPERATIONS.GOVERNANCE, SELF_DOGFOOD_OUTCOMES.VERIFIED);

    const firstIssue = invoke([
      "change",
      "issue",
      String(options.issue),
      "--repository",
      `${options.repository.owner}/${options.repository.name}`,
    ]);
    if (!isSuccess(firstIssue) || isReturnedExisting(firstIssue) || publicStatus(firstIssue) !== "DRAFT")
      throw new Error("first issuance did not prove a new verified Draft Change");
    evidence.change = changeIdentity(firstIssue, options.issue);
    evidence.contractVersions.goldenPath = contractVersion(firstIssue, "goldenPath");
    if (evidence.contractVersions.goldenPath === "unknown")
      throw new Error("Change response omitted the Golden Path contract version");
    evidence.contractVersions.statusRecovery = contractVersion(firstIssue, "statusRecovery");
    if (evidence.contractVersions.statusRecovery === "unknown")
      throw new Error("Change response omitted the status/recovery contract version");
    const issuedBaseBranch = outputField(firstIssue, ["canonicalBaseBranch"], ["projection", "canonicalBaseBranch"]);
    if (typeof issuedBaseBranch !== "string" || issuedBaseBranch.length === 0)
      throw new Error("Change response omitted canonical base branch");
    recordOperation(evidence, SELF_DOGFOOD_OPERATIONS.FIRST_ISSUANCE, SELF_DOGFOOD_OUTCOMES.VERIFIED);

    const repeatedIssue = invoke([
      "change",
      "issue",
      String(options.issue),
      "--repository",
      `${options.repository.owner}/${options.repository.name}`,
    ]);
    if (!isSuccess(repeatedIssue) || !isReturnedExisting(repeatedIssue))
      throw new Error("repeat issuance did not return the canonical existing Change");
    const repeatedIdentity = changeIdentity(repeatedIssue, options.issue);
    if (
      repeatedIdentity.branch !== evidence.change.branch ||
      repeatedIdentity.pullRequest !== evidence.change.pullRequest
    )
      throw new Error("repeat issuance returned a different Change identity");
    const repeatedBaseBranch = outputField(
      repeatedIssue,
      ["canonicalBaseBranch"],
      ["projection", "canonicalBaseBranch"],
    );
    if (repeatedBaseBranch !== issuedBaseBranch) throw new Error("repeat issuance returned a different base branch");
    recordOperation(evidence, SELF_DOGFOOD_OPERATIONS.RETURN_EXISTING, SELF_DOGFOOD_OUTCOMES.RETURNED_EXISTING);

    const handoffResult = invoke([
      "change",
      "handoff",
      String(options.issue),
      "--repository",
      `${options.repository.owner}/${options.repository.name}`,
    ]);
    const handoff = handoffResult.handoff;
    if (
      handoffResult.ok !== true ||
      handoff === null ||
      typeof handoff !== "object" ||
      handoff.state !== "DRAFT" ||
      handoff.branch !== evidence.change.branch ||
      handoff.pullRequest !== evidence.change.pullRequest ||
      handoff.rootIssue !== options.issue ||
      handoff.baseBranch !== issuedBaseBranch
    )
      throw new Error("canonical implementation handoff did not match the issued Draft Change identity");
    recordOperation(evidence, SELF_DOGFOOD_OPERATIONS.HANDOFF, SELF_DOGFOOD_OUTCOMES.VERIFIED);
    runWorker(options, handoff, sha);
    recordOperation(evidence, SELF_DOGFOOD_OPERATIONS.WORKER, SELF_DOGFOOD_OUTCOMES.SUCCESS);
    if (sourceCommitSha() !== sha) throw new Error("worker changed the dogfood source checkout");

    const firstReady = invoke([
      "change",
      "ready",
      String(options.issue),
      "--repository",
      `${options.repository.owner}/${options.repository.name}`,
    ]);
    if (!isSuccess(firstReady) || !isReview(firstReady))
      throw new Error("first Ready did not verify public REVIEW state");
    recordOperation(evidence, SELF_DOGFOOD_OPERATIONS.FIRST_READY, SELF_DOGFOOD_OUTCOMES.VERIFIED);

    const reread = invoke([
      "change",
      "show",
      String(options.issue),
      "--repository",
      `${options.repository.owner}/${options.repository.name}`,
    ]);
    if (!isReview(reread)) throw new Error("authoritative reread did not verify REVIEW state");
    recordOperation(evidence, SELF_DOGFOOD_OPERATIONS.REREAD, SELF_DOGFOOD_OUTCOMES.VERIFIED);

    const repeatedReady = invoke([
      "change",
      "ready",
      String(options.issue),
      "--repository",
      `${options.repository.owner}/${options.repository.name}`,
    ]);
    if (!isSuccess(repeatedReady) || (!isReturnedExisting(repeatedReady) && !isReview(repeatedReady)))
      throw new Error("Ready retry was not idempotently verified");
    recordOperation(
      evidence,
      SELF_DOGFOOD_OPERATIONS.READY_RETRY,
      isReturnedExisting(repeatedReady) ? SELF_DOGFOOD_OUTCOMES.RETURNED_EXISTING : SELF_DOGFOOD_OUTCOMES.VERIFIED,
    );

    if (options.abort) {
      const aborted = invoke([
        "change",
        "abort",
        String(options.issue),
        "--repository",
        `${options.repository.owner}/${options.repository.name}`,
      ]);
      if (!isSuccess(aborted) || !["ABORTED", "aborted"].includes(publicStatus(aborted)))
        throw new Error("Core did not report a safe verified Abort state");
      const abortReread = invoke([
        "change",
        "show",
        String(options.issue),
        "--repository",
        `${options.repository.owner}/${options.repository.name}`,
      ]);
      if (!["ABORTED", "aborted"].includes(publicStatus(abortReread)))
        throw new Error("Abort reread did not verify ABORTED state");
      recordOperation(evidence, SELF_DOGFOOD_OPERATIONS.ABORT, SELF_DOGFOOD_OUTCOMES.VERIFIED);
    }
    const expectedFinalStatus = options.abort ? "ABORTED" : "REVIEW";
    if (evidence.finalState.status !== expectedFinalStatus)
      throw new Error(`authoritative final status was not ${expectedFinalStatus}`);
    if (evidence.finalState.recovery.state === "unavailable")
      throw new Error("authoritative recovery state is unavailable; integrate the status/recovery contract");
    evidence.result = CERTIFICATION_RESULT_PASSED;
    if (!validateSelfDogfoodEvidence(evidence).valid) throw new Error("self-dogfood evidence is invalid");
    evidence.diagnostics = [];
  } catch (error) {
    failEvidence(evidence, "SELF_DOGFOOD_BLOCKED", error instanceof Error ? error.message : String(error));
  }
  return evidence;
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArguments(argv);
    if (parsed.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (parsed.options.repository === undefined || parsed.options.issue === undefined)
      throw new Error("--repository and --issue are required");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
    return 64;
  }
  let evidence;
  try {
    evidence = await runDogfood(parsed.options);
  } catch (error) {
    evidence = initialEvidence(parsed.options, null);
    failEvidence(evidence, "SELF_DOGFOOD_BLOCKED", error instanceof Error ? error.message : String(error));
  }
  try {
    writeEvidence(evidence, parsed.options.output);
  } catch (error) {
    process.stderr.write(
      `unable to write certification evidence: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  return evidence.result === CERTIFICATION_RESULT_PASSED ? 0 : 2;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
