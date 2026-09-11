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

export const SELF_DOGFOOD_SCHEMA_VERSION = "1";
export const SELF_DOGFOOD_KIND = "self-dogfood-golden-path";
export const MAX_DIAGNOSTICS = 20;
export const MAX_OPERATIONS = 32;
export const MAX_DIAGNOSTIC_MESSAGE = 512;
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function boundedMessage(value) {
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim();
  return text.length <= MAX_DIAGNOSTIC_MESSAGE ? text : `${text.slice(0, MAX_DIAGNOSTIC_MESSAGE - 1)}…`;
}

function redact(value) {
  return boundedMessage(value)
    .replace(/(bearer\s+|token[=:]\s*|secret[=:]\s*|password[=:]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/[A-Za-z0-9_\-/+=]{32,}/gu, "[REDACTED]");
}

function diagnostic(code, message) {
  return { code, message: redact(message) };
}

function addDiagnostic(diagnostics, code, message) {
  if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(diagnostic(code, message));
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

function runInari(options, args) {
  const result = runCommand(options.inari, [...args, "--json"], {
    cwd: repoRoot,
    env: process.env,
    timeoutMs: options.timeoutMs,
  });
  if (!result.ok) {
    const detail = (result.error?.message ?? result.stderr.trim()) || `exit status ${result.status}`;
    throw new Error(`${args.join(" ")} failed: ${redact(detail)}`);
  }
  return parseJsonOutput(result, args.join(" "));
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
  if (typeof branch !== "string" || branch.length === 0) throw new Error("Change response omitted canonical branch");
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
    throw new Error("Change response omitted canonical pull request");
  return { issue: fallbackIssue, branch, pullRequest };
}

function outcome(value) {
  return outputField(value, ["evidence", "outcome"], ["outcome"], ["status"]) ?? "unknown";
}

function publicStatus(value) {
  return outputField(value, ["state"], ["status"], ["projection", "change", "state"], ["projection", "status"]);
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
  for (const key of keys) {
    const candidate = outputField(
      value,
      [key],
      ["contractVersions", key],
      ["projection", key],
      ["projection", "change", key],
    );
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return "unknown";
}

/** Keep the worker environment allowlisted; issuer credentials never cross the handoff. */
export function sanitizeWorkerEnvironment(environment, handoff) {
  const safe = {};
  for (const [key, value] of Object.entries(environment)) {
    if (SAFE_WORKER_ENV_KEYS.has(key) && !SECRET_KEY_PATTERN.test(key)) safe[key] = value;
  }
  safe.INARI_IMPLEMENTATION_HANDOFF = JSON.stringify(handoff);
  safe.INARI_IMPLEMENTATION_BRANCH = handoff.branch;
  safe.INARI_CHANGE_ISSUE = String(handoff.issue);
  safe.INARI_CHANGE_PULL_REQUEST = String(handoff.pullRequest);
  safe.INARI_SOURCE_COMMIT_SHA = handoff.sourceCommitSha;
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
    result: "blocked",
    sourceCommitSha: sha,
    contractVersions: { goldenPath: "unknown", statusRecovery: "unknown", skill: "unknown" },
    repository: options.repository,
    rootIssue: options.issue,
    change: { issue: options.issue, branch: "unresolved", pullRequest: 0 },
    operations: [],
    finalState: { status: "BLOCKED", recovery: { state: "required", action: "inspect" } },
    diagnostics: [],
  };
}

function recordOperation(evidence, operation, operationOutcome) {
  if (evidence.operations.length < MAX_OPERATIONS)
    evidence.operations.push({ operation, outcome: boundedMessage(operationOutcome) });
}

function failEvidence(evidence, code, message, result = "blocked") {
  evidence.result = result;
  addDiagnostic(evidence.diagnostics, code, message);
  evidence.finalState = { status: "BLOCKED", recovery: { state: "required", action: "inspect" } };
  return evidence;
}

function writeEvidence(evidence, output) {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (output !== undefined) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, serialized, { encoding: "utf8", mode: 0o600 });
  } else {
    process.stdout.write(serialized);
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
  const relative = path.relative(repoRoot, options.workerCwd);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".."))
    throw new Error("worker cwd must be outside the source checkout");
  if (options.abort && process.env.INARI_SELF_DOGFOOD_ALLOW_RECOVERY !== "1")
    throw new Error("--abort requires INARI_SELF_DOGFOOD_ALLOW_RECOVERY=1");
  void evidence;
}

function runWorker(options, handoff) {
  const workerHome = fs.mkdtempSync(path.join(os.tmpdir(), "inari-dogfood-worker-home-"));
  const workerEnvironment = sanitizeWorkerEnvironment(process.env, handoff);
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

function runDogfood(options) {
  const sha = sourceCommitSha();
  const evidence = initialEvidence(options, sha);
  try {
    assertPreconditions(options, evidence);
    recordOperation(evidence, "preflight.opt-in", "verified");

    const runtime = runInari(options, ["--version"]);
    if (runtime.ok !== true || runtime.name !== "gh-inari")
      throw new Error("installed executable identity was not gh-inari");
    recordOperation(evidence, "preflight.installed-executable", "verified");

    const skill = runInari(options, ["skill", "golden-path"]);
    const skillVersion = skill.version ?? skill.contractVersion;
    if (typeof skillVersion !== "string" || skillVersion.length === 0 || skill.id !== "golden-path")
      throw new Error("golden-path Skill contract is unavailable");
    evidence.contractVersions.skill = skillVersion;
    evidence.contractVersions.goldenPath = skillVersion;
    recordOperation(evidence, "skill.golden-path", "verified");

    const issueCheck = runInari(options, [
      "issue",
      "check",
      String(options.issue),
      "--repository",
      `${options.repository.owner}/${options.repository.name}`,
    ]);
    if (issueCheck.valid !== true && issueCheck.ok !== true && issueCheck.governance?.valid !== true)
      throw new Error("disposable Issue is not confirmed as a governed Issue");
    recordOperation(evidence, "disposable-issue.governance-check", "verified");

    const firstIssue = runInari(options, [
      "change",
      "issue",
      String(options.issue),
      "--repository",
      `${options.repository.owner}/${options.repository.name}`,
    ]);
    if (!isSuccess(firstIssue) || isReturnedExisting(firstIssue) || publicStatus(firstIssue) !== "DRAFT")
      throw new Error("first issuance did not prove a new verified Draft Change");
    evidence.change = changeIdentity(firstIssue, options.issue);
    evidence.contractVersions.statusRecovery = contractVersion(
      firstIssue,
      "statusRecovery",
      "changeContractVersion",
      "version",
    );
    if (evidence.contractVersions.statusRecovery === "unknown")
      throw new Error("Change response omitted the status/recovery contract version");
    recordOperation(evidence, "change.issue.first", "verified");

    const repeatedIssue = runInari(options, [
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
    recordOperation(evidence, "change.issue.return-existing", "returned-existing");

    const handoffResult = runInari(options, [
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
      handoff.rootIssue !== options.issue
    )
      throw new Error("canonical implementation handoff did not match the issued Draft Change");
    recordOperation(evidence, "change.handoff", "verified");
    runWorker(options, { ...handoff, sourceCommitSha: sha });
    recordOperation(evidence, "worker.implementation", "success");
    if (sourceCommitSha() !== sha) throw new Error("worker changed the dogfood source checkout");

    const firstReady = runInari(options, [
      "change",
      "ready",
      String(options.issue),
      "--repository",
      `${options.repository.owner}/${options.repository.name}`,
    ]);
    if (!isSuccess(firstReady) || !isReview(firstReady))
      throw new Error("first Ready did not verify public REVIEW state");
    recordOperation(evidence, "change.ready.first", "verified");

    const reread = runInari(options, [
      "change",
      "show",
      String(options.issue),
      "--repository",
      `${options.repository.owner}/${options.repository.name}`,
    ]);
    if (!isReview(reread)) throw new Error("authoritative reread did not verify REVIEW state");
    recordOperation(evidence, "change.ready.reread", "verified");

    const repeatedReady = runInari(options, [
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
      "change.ready.retry",
      isReturnedExisting(repeatedReady) ? "returned-existing" : "verified",
    );

    if (options.abort) {
      const aborted = runInari(options, [
        "change",
        "abort",
        String(options.issue),
        "--repository",
        `${options.repository.owner}/${options.repository.name}`,
      ]);
      if (!isSuccess(aborted) || !["ABORTED", "aborted"].includes(publicStatus(aborted)))
        throw new Error("Core did not report a safe verified Abort state");
      const abortReread = runInari(options, [
        "change",
        "show",
        String(options.issue),
        "--repository",
        `${options.repository.owner}/${options.repository.name}`,
      ]);
      if (!["ABORTED", "aborted"].includes(publicStatus(abortReread)))
        throw new Error("Abort reread did not verify ABORTED state");
      recordOperation(evidence, "change.abort.recovery", "verified");
      evidence.finalState = { status: publicStatus(abortReread), recovery: { state: "completed", action: "none" } };
    } else {
      evidence.finalState = { status: publicStatus(reread), recovery: { state: "none", action: "none" } };
    }
    evidence.result = "passed";
    evidence.diagnostics = [];
  } catch (error) {
    recordOperation(evidence, "self-dogfood", "blocked");
    failEvidence(evidence, "SELF_DOGFOOD_BLOCKED", error instanceof Error ? error.message : String(error));
  }
  return evidence;
}

export function main(argv = process.argv.slice(2)) {
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
    evidence = runDogfood(parsed.options);
  } catch (error) {
    const sha = (() => {
      try {
        return sourceCommitSha();
      } catch {
        return "0000000000000000000000000000000000000000";
      }
    })();
    evidence = initialEvidence(parsed.options, sha);
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
  return evidence.result === "passed" ? 0 : 2;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main();
