#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { CERTIFICATION_KINDS, sha256Tarball, validateSelfDogfoodEvidence } from "./certification-evidence.mjs";

const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const TARBALL_SHA_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REPOSITORY_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u;
const CERTIFICATION_KIND = CERTIFICATION_KINDS[1];

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseRepository(value) {
  const match = REPOSITORY_PATTERN.exec(value ?? "");
  if (match === null) throw new Error("repository must be an owner/name identity");
  return { owner: match[1], name: match[2] };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function boundedText(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, 512);
}

function validateWorkerObservation(observation, sourceCommitSha, issue) {
  if (observation === null || typeof observation !== "object" || Array.isArray(observation))
    throw new Error("worker observation must be an object");
  if (observation.sourceCommitSha !== sourceCommitSha)
    throw new Error("worker observation source SHA does not match the certified source");
  if (!Array.isArray(observation.sensitiveEnvironmentKeys) || observation.sensitiveEnvironmentKeys.length !== 0)
    throw new Error("worker observation contains credential-bearing environment keys");
  const handoff = observation.handoff;
  if (
    handoff === null ||
    typeof handoff !== "object" ||
    handoff.state !== "DRAFT" ||
    handoff.rootIssue !== issue ||
    typeof handoff.branch !== "string" ||
    !Number.isSafeInteger(handoff.pullRequest) ||
    handoff.pullRequest < 1
  )
    throw new Error("worker observation does not contain the canonical implementation handoff");
}

function workflowIdentity(environment, sourceCommitSha, repository, exerciseAbort) {
  return {
    runId: environment.GITHUB_RUN_ID ?? null,
    runAttempt: environment.GITHUB_RUN_ATTEMPT ?? null,
    workflow: environment.GITHUB_WORKFLOW ?? null,
    url:
      environment.GITHUB_SERVER_URL !== undefined && environment.GITHUB_REPOSITORY !== undefined
        ? `${environment.GITHUB_SERVER_URL}/${environment.GITHUB_REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID ?? ""}`
        : null,
    artifactName: `self-dogfood-golden-path-${sourceCommitSha}`,
    exerciseAbort,
    repository,
  };
}

function residualProjection(evidence, exerciseAbort) {
  const finalState = evidence.finalState;
  const abortCompleted =
    finalState.status === "ABORTED" &&
    (finalState.recovery.state === "COMPLETED" || finalState.recovery.state === "completed") &&
    finalState.recovery.action === "none";
  if (abortCompleted) return { status: "none", reason: "Inari Core verified canonical abort cleanup." };
  return {
    status: "retained",
    issue: evidence.change.issue,
    branch: evidence.change.branch,
    pullRequest: evidence.change.pullRequest,
    finalState,
    reason: exerciseAbort
      ? "Abort was not verified; retain the bounded Core recovery state and do not perform manual cleanup."
      : "Abort was not requested; the disposable Change remains for explicit follow-up and is not silently orphaned.",
  };
}

/** Validate workflow-produced evidence and return source-addressable run metadata. */
export function verifySelfDogfoodRun(input) {
  const repository = parseRepository(input.repository);
  if (!SOURCE_SHA_PATTERN.test(input.sourceCommitSha ?? ""))
    throw new Error("sourceCommitSha must be an exact lowercase commit SHA");
  if (!TARBALL_SHA_PATTERN.test(input.tarballSha256 ?? "")) throw new Error("tarballSha256 must be a sha256 digest");
  if (!Number.isSafeInteger(input.issue) || input.issue < 1) throw new Error("issue must be a positive integer");
  if (input.evidence?.certificationKind !== CERTIFICATION_KIND)
    throw new Error("evidence is not self-dogfood-golden-path evidence");
  const validation = validateSelfDogfoodEvidence(input.evidence);
  if (!validation.valid) throw new Error(`canonical evidence validation failed: ${validation.errors.join("; ")}`);
  if (input.evidence.sourceCommitSha !== input.sourceCommitSha)
    throw new Error("evidence source SHA does not match the workflow revision");
  if (
    input.evidence.repository.owner !== repository.owner ||
    input.evidence.repository.name !== repository.name ||
    input.evidence.rootIssue !== input.issue ||
    input.evidence.change.issue !== input.issue
  )
    throw new Error("evidence repository or Issue identity does not match the workflow input");

  const sourceRoot = fs.realpathSync(input.sourceRoot);
  const tarballPath = fs.realpathSync(input.tarballPath);
  const installedPackagePath = fs.realpathSync(input.installedPackagePath);
  const installedExecutablePath = fs.realpathSync(input.installedExecutablePath);
  if (!fs.statSync(tarballPath).isFile() || !fs.statSync(installedPackagePath).isDirectory())
    throw new Error("workflow artifact or installed package path is not usable");
  if (isWithin(sourceRoot, installedPackagePath) || isWithin(sourceRoot, installedExecutablePath))
    throw new Error("installed executable must be outside the source checkout");
  if (!isWithin(installedPackagePath, installedExecutablePath))
    throw new Error("installed executable is not resolved from the installed package");
  const packageMetadata = readJson(path.join(installedPackagePath, "package.json"), "installed package metadata");
  if (packageMetadata.name !== "gh-inari" || typeof packageMetadata.version !== "string")
    throw new Error("installed package identity is not gh-inari");
  if (sha256Tarball(tarballPath) !== input.tarballSha256)
    throw new Error("workflow tarball digest does not match the recorded digest");

  if (input.evidence.result === "passed") {
    if (input.workerObservation === undefined) throw new Error("passed evidence is missing worker observation");
    validateWorkerObservation(input.workerObservation, input.sourceCommitSha, input.issue);
  }

  const residualChange = residualProjection(input.evidence, input.exerciseAbort === true);
  const metadata = {
    schemaVersion: 1,
    certificationKind: CERTIFICATION_KIND,
    result: input.evidence.result,
    sourceCommitSha: input.sourceCommitSha,
    repository,
    rootIssue: input.issue,
    artifact: {
      name: `self-dogfood-golden-path-${input.sourceCommitSha}`,
      tarballSha256: input.tarballSha256,
    },
    package: { name: packageMetadata.name, version: packageMetadata.version },
    workflow: workflowIdentity(
      input.environment ?? {},
      input.sourceCommitSha,
      repository,
      input.exerciseAbort === true,
    ),
    change: input.evidence.change,
    finalState: input.evidence.finalState,
    residualChange,
  };
  const summary = renderSummary(metadata);
  return { passed: input.evidence.result === "passed", metadata, summary };
}

function renderSummary(metadata) {
  const change = metadata.change;
  const finalState = metadata.finalState;
  const residual = metadata.residualChange;
  const lines = [
    "## self-dogfood-golden-path",
    "",
    `- Result: \`${boundedText(metadata.result)}\``,
    `- Source SHA: \`${boundedText(metadata.sourceCommitSha)}\``,
    `- Repository: \`${boundedText(metadata.repository.owner)}/${boundedText(metadata.repository.name)}\``,
    `- Root Issue: #${String(metadata.rootIssue)}`,
    `- Change: branch \`${boundedText(change.branch)}\`, PR #${String(change.pullRequest)}`,
    `- Final state: \`${boundedText(finalState.status)}\` / recovery \`${boundedText(finalState.recovery.state)}\``,
    `- Source-addressable artifact: \`${boundedText(metadata.artifact.name)}\``,
    `- Residual disposable Change: ${
      residual.status === "none"
        ? "none; Inari Core verified canonical cleanup."
        : `retained (branch \`${boundedText(residual.branch)}\`, PR #${String(residual.pullRequest)}); ${boundedText(residual.reason)}`
    }`,
  ];
  if (metadata.workflow.url !== null) lines.push(`- Workflow run: ${boundedText(metadata.workflow.url)}`);
  return `${lines.join("\n")}\n`;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help") return { help: true };
    if (!option?.startsWith("--") || index + 1 >= argv.length) throw new Error("invalid workflow verifier arguments");
    values.set(option, argv[index + 1]);
    index += 1;
  }
  return {
    help: false,
    evidence: values.get("--evidence"),
    sourceSha: values.get("--source-sha"),
    repository: values.get("--repository"),
    issue: Number(values.get("--issue")),
    tarball: values.get("--tarball"),
    tarballSha256: values.get("--tarball-sha256"),
    installedPackage: values.get("--installed-package"),
    installedExecutable: values.get("--installed-executable"),
    workerObservation: values.get("--worker-observation"),
    metadata: values.get("--metadata"),
    summary: values.get("--summary"),
    sourceRoot: values.get("--source-root"),
    exerciseAbort: values.get("--exercise-abort") === "true",
  };
}

function usage() {
  return "usage: node scripts/self-dogfood-workflow.mjs --evidence <path> --source-sha <sha> --repository <owner/name> --issue <number> --tarball <path> --tarball-sha256 <digest> --installed-package <path> --installed-executable <path> --worker-observation <path> --metadata <path> --summary <path> --source-root <path> [--exercise-abort true|false]";
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const required = [
    "evidence",
    "sourceSha",
    "repository",
    "tarball",
    "tarballSha256",
    "installedPackage",
    "installedExecutable",
    "metadata",
    "summary",
    "sourceRoot",
  ];
  const missing = required.filter((key) => options[key] === undefined);
  if (missing.length > 0) throw new Error(`${usage()}; missing: ${missing.join(", ")}`);
  const result = verifySelfDogfoodRun({
    evidence: readJson(options.evidence, "evidence"),
    sourceCommitSha: options.sourceSha,
    repository: options.repository,
    issue: options.issue,
    tarballPath: options.tarball,
    tarballSha256: options.tarballSha256,
    installedPackagePath: options.installedPackage,
    installedExecutablePath: options.installedExecutable,
    workerObservation:
      options.workerObservation === undefined || !fs.existsSync(options.workerObservation)
        ? undefined
        : readJson(options.workerObservation, "worker observation"),
    sourceRoot: options.sourceRoot,
    exerciseAbort: options.exerciseAbort,
    environment: process.env,
  });
  fs.mkdirSync(path.dirname(options.metadata), { recursive: true });
  fs.writeFileSync(options.metadata, `${JSON.stringify(result.metadata)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.appendFileSync(options.summary, result.summary, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ ok: result.passed, metadata: result.metadata }));
  return result.passed ? 0 : 2;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(
      `self-dogfood workflow verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
