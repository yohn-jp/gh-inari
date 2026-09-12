#!/usr/bin/env node
// Release-gate certification for the artifact produced by `npm pack`.
// Every product invocation below starts from the installed package in a fresh
// consumer tree; the checkout is used only to produce the tarball and read its
// expected package metadata.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  appendCertificationDiagnostic,
  CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
  CERTIFICATION_KINDS,
  CERTIFICATION_RESULTS,
  sha256Tarball,
  writeCertificationEvidence,
} from "./certification-evidence.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

export const REQUIRED_BIN_NAMES = Object.freeze(["inari", "gh-inari"]);
export const CERTIFICATION_ENTRY_COMMANDS = Object.freeze([
  Object.freeze({ name: "runtime identity", args: ["--version", "--json"] }),
  Object.freeze({ name: "canonical preflight", args: ["--diagnose", "--json"] }),
  Object.freeze({ name: "Skill discovery", args: ["skill", "--json"] }),
]);

function isPathInside(directory, candidate) {
  const relativePath = path.relative(path.resolve(directory), path.resolve(candidate));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))
  );
}

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.error !== undefined)
    throw new Error(`${command} ${args.join(" ")} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (status ${String(result.status)}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result;
}

function invoke(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 10_000, ...options });
}

function jsonOutput(result, label, expectedStatus = 0) {
  if (result.error !== undefined) fail(`${label} failed to start: ${result.error.message}`);
  if (result.status !== expectedStatus)
    fail(
      `${label} exited ${String(result.status)}, expected ${expectedStatus}:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  try {
    return JSON.parse((result.stdout ?? "").trim());
  } catch (error) {
    fail(`${label} did not emit JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readPackageJson(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
}

function packageDirectoryForName(consumerDirectory, name) {
  if (name.startsWith("@")) {
    const [scope, packagePart] = name.split("/");
    return path.join(consumerDirectory, "node_modules", scope, packagePart);
  }
  return path.join(consumerDirectory, "node_modules", name);
}

function resolvePackagePath(packageDirectory, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0)
    fail(`package target must be a non-empty string, got ${String(relativePath)}`);
  const resolved = path.resolve(packageDirectory, relativePath);
  if (!isPathInside(packageDirectory, resolved)) fail(`package target escapes the installed package: ${relativePath}`);
  return resolved;
}

export function collectExportsTargets(value, targets = []) {
  if (typeof value === "string") {
    targets.push(value.replace(/^\.\//u, ""));
    return targets;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectExportsTargets(entry, targets);
    return targets;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) collectExportsTargets(entry, targets);
  }
  return targets;
}

export function exportsTargetPaths(value) {
  return collectExportsTargets(value.exports, []);
}

export function packageBinTargets(packageDirectory, installedPackageJson = readPackageJson(packageDirectory)) {
  const bin = installedPackageJson.bin;
  if (typeof bin !== "object" || bin === null || Array.isArray(bin)) fail("installed package.json has no bin map");
  return Object.entries(bin).map(([name, relativeTarget]) => ({
    name,
    target: resolvePackagePath(packageDirectory, relativeTarget),
  }));
}

function realPath(candidate, label) {
  if (!fs.existsSync(candidate)) fail(`${label} does not exist at ${candidate}`);
  return fs.realpathSync(candidate);
}

function assertOutsideCheckout(candidate, label) {
  const checkout = fs.realpathSync(repoRoot);
  const resolved = realPath(candidate, label);
  if (isPathInside(checkout, resolved)) fail(`${label} resolves into the repository checkout: ${resolved}`);
  return resolved;
}

function assertExecutable(candidate, label) {
  const stat = fs.statSync(candidate);
  if ((stat.mode & 0o100) === 0) fail(`${label} is not executable at ${candidate}`);
}

function dependencyDirectory(consumerDirectory, dependencyName) {
  return packageDirectoryForName(consumerDirectory, dependencyName);
}

/**
 * Validates the installed package as data before any CLI command is run.
 * This catches missing bin targets, broken exports, missing runtime packages,
 * and local/workspace links independently of command behavior.
 */
export function validateInstalledPackage(installedPackageDirectory, consumerDirectory, expectedPackage) {
  const installedPackageJson = readPackageJson(installedPackageDirectory);
  if (installedPackageJson.name !== expectedPackage.name)
    fail(`installed package name was "${installedPackageJson.name}", expected "${expectedPackage.name}"`);
  if (installedPackageJson.version !== expectedPackage.version)
    fail(`installed package version was "${installedPackageJson.version}", expected "${expectedPackage.version}"`);

  const packageRootStat = fs.lstatSync(installedPackageDirectory);
  if (packageRootStat.isSymbolicLink()) fail("installed package is a symlink; workspace links are not certified");
  assertOutsideCheckout(installedPackageDirectory, "installed package");

  const binTargets = packageBinTargets(installedPackageDirectory, installedPackageJson);
  const binNames = new Set(binTargets.map(({ name }) => name));
  for (const name of REQUIRED_BIN_NAMES) {
    if (!binNames.has(name)) fail(`package.json is missing required executable "${name}"`);
  }
  for (const { name, target } of binTargets) {
    realPath(target, `bin target "${name}"`);
    assertOutsideCheckout(target, `bin target "${name}"`);
    assertExecutable(target, `bin target "${name}"`);
  }

  const exportTargets = exportsTargetPaths(installedPackageJson);
  if (exportTargets.length === 0) fail('installed package.json has no "exports" targets');
  for (const target of exportTargets) {
    const exportTarget = resolvePackagePath(installedPackageDirectory, target);
    realPath(exportTarget, `exports target "${target}"`);
    assertOutsideCheckout(exportTarget, `exports target "${target}"`);
  }

  for (const dependencyName of Object.keys(installedPackageJson.dependencies ?? {})) {
    const dependency = dependencyDirectory(consumerDirectory, dependencyName);
    realPath(dependency, `runtime dependency "${dependencyName}"`);
    if (fs.lstatSync(dependency).isSymbolicLink())
      fail(`runtime dependency "${dependencyName}" is a symlink; workspace links are not certified`);
    assertOutsideCheckout(dependency, `runtime dependency "${dependencyName}"`);
  }

  return { packageJson: installedPackageJson, binTargets, exportTargets };
}

export function validateVersionOutput(output, expectedPackage) {
  if (
    output?.ok !== true ||
    output.name !== expectedPackage.name ||
    output.version !== expectedPackage.version ||
    !Array.isArray(output.capabilities)
  )
    fail("installed executable returned an invalid runtime identity contract");
  return output;
}

export function validatePreflightOutput(output, expectedPackage) {
  validateVersionOutput(output, expectedPackage);
  if (output.canonical?.invocation !== "inari" || output.canonical?.status !== "ready")
    fail("installed executable did not pass canonical Inari preflight");
  if (!Array.isArray(output.requiredCapabilities) || output.requiredCapabilities.length === 0)
    fail("installed executable returned no required preflight capabilities");
  return output;
}

export function validateSkillIndex(output) {
  if (typeof output?.version !== "string" || !Array.isArray(output.scenarios) || output.scenarios.length === 0)
    fail("installed executable returned an invalid Skill index");
  if (output.scenarios.some((scenario) => typeof scenario?.id !== "string" || scenario.id.length === 0))
    fail("installed executable returned a Skill index with an invalid scenario");
  return output;
}

function executableOnPath(name, pathValue) {
  for (const directory of pathValue.split(path.delimiter)) {
    if (directory.length === 0) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue through the intentionally bounded PATH.
    }
  }
  return undefined;
}

function executablePath(name) {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  if (result.status !== 0 || result.stdout.trim().length === 0) fail(`${name} is required for package certification`);
  return result.stdout.trim();
}

function boundedPath(binDirectory, externalExecutables, additionalExecutables = []) {
  const directories = [
    binDirectory,
    ...additionalExecutables.map((executable) => path.dirname(executable)),
    ...externalExecutables.map((executable) => path.dirname(executable)),
    path.dirname(process.execPath),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  return [...new Set(directories)].join(path.delimiter);
}

function freshEnvironment(rootDirectory, binDirectory, externalExecutables) {
  const homeDirectory = path.join(rootDirectory, "home");
  fs.mkdirSync(homeDirectory, { recursive: true });
  const npmUserConfig = path.join(rootDirectory, "npmrc");
  fs.writeFileSync(npmUserConfig, "", { flag: "a" });

  const environment = { ...process.env };
  for (const variable of [
    "NODE_PATH",
    "NODE_OPTIONS",
    "NPM_CONFIG_GLOBALCONFIG",
    "NPM_CONFIG_USERCONFIG",
    "npm_config_globalconfig",
    "npm_config_userconfig",
  ]) {
    delete environment[variable];
  }
  environment.PATH = boundedPath(binDirectory, externalExecutables);
  environment.HOME = homeDirectory;
  environment.XDG_CONFIG_HOME = path.join(rootDirectory, "xdg-config");
  environment.XDG_DATA_HOME = path.join(rootDirectory, "xdg-data");
  environment.XDG_STATE_HOME = path.join(rootDirectory, "xdg-state");
  environment.npm_config_cache = path.join(rootDirectory, "npm-cache");
  environment.NPM_CONFIG_USERCONFIG = npmUserConfig;
  environment.GH_CONFIG_DIR = path.join(rootDirectory, "gh-config");
  environment.GH_PROMPT_DISABLED = "1";
  environment.GH_TOKEN = "golden-path-certification-token";
  return environment;
}

function packArtifact() {
  const packResult = run("npm", ["pack", "--json", "--ignore-scripts"]);
  const parsed = JSON.parse(packResult.stdout);
  const packInfo = Array.isArray(parsed) ? parsed[0] : (parsed[packageJson.name] ?? parsed);
  if (typeof packInfo?.filename !== "string") fail("npm pack did not return an artifact filename");
  const tarballPath = path.resolve(repoRoot, packInfo.filename);
  if (path.extname(tarballPath) !== ".tgz" || !fs.statSync(tarballPath).isFile())
    fail(`npm pack did not produce a tarball: ${tarballPath}`);
  return tarballPath;
}

function parseArgs(argv) {
  const index = argv.indexOf("--tarball");
  const evidenceIndex = argv.indexOf("--evidence");
  const readValue = (option, optionIndex) => {
    if (optionIndex === -1) return undefined;
    const value = argv[optionIndex + 1];
    if (value === undefined || value.startsWith("--")) fail(`${option} requires a value`);
    return value;
  };
  for (const argument of argv) {
    if (
      argument !== "--tarball" &&
      argument !== "--evidence" &&
      argument !== readValue("--tarball", index) &&
      argument !== readValue("--evidence", evidenceIndex)
    ) {
      fail(`unsupported option: ${argument}`);
    }
  }
  const value = readValue("--tarball", index);
  return {
    tarball: value,
    evidence: readValue("--evidence", evidenceIndex),
  };
}

function sourceCommitSha() {
  const value = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(value)) fail("git rev-parse HEAD did not return an exact commit SHA");
  return value;
}

function certificationContractVersions(observed = {}) {
  return {
    goldenPath: typeof observed.goldenPath === "string" ? observed.goldenPath : "unobserved",
    statusRecovery: typeof observed.statusRecovery === "string" ? observed.statusRecovery : "unobserved",
    skill: typeof observed.skill === "string" ? observed.skill : "unobserved",
  };
}

function writePackedEvidence(evidencePath, tarballPath, result, diagnostics = [], observedContractVersions = {}) {
  fs.mkdirSync(path.dirname(path.resolve(evidencePath)), { recursive: true });
  writeCertificationEvidence(evidencePath, {
    schemaVersion: CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
    certificationKind: CERTIFICATION_KINDS[0],
    result,
    sourceCommitSha: sourceCommitSha(),
    contractVersions: certificationContractVersions(observedContractVersions),
    package: {
      name: packageJson.name,
      version: packageJson.version,
      tarballSha256: sha256Tarball(tarballPath),
    },
    diagnostics,
  });
}

function createConsumer(directory, name) {
  const consumerDirectory = path.join(directory, name);
  fs.mkdirSync(consumerDirectory);
  const packageFile = path.join(consumerDirectory, "package.json");
  const packageContents = JSON.stringify({ name: `${name}-consumer`, private: true, version: "1.0.0" }, null, 2);
  fs.writeFileSync(packageFile, packageContents);
  return { consumerDirectory, packageFile, packageContents };
}

function checkInstalledLaunchers(consumerDirectory, installedPackageDirectory, binTargets, environment) {
  const binDirectory = path.join(consumerDirectory, "node_modules", ".bin");
  let skillVersion;
  for (const name of REQUIRED_BIN_NAMES) {
    const target = binTargets.find((entry) => entry.name === name);
    if (target === undefined) fail(`no installed bin target for "${name}"`);
    const launcher = path.join(binDirectory, name);
    realPath(launcher, `npm launcher "${name}"`);
    assertExecutable(launcher, `npm launcher "${name}"`);
    const resolvedLauncher = fs.realpathSync(launcher);
    if (!isPathInside(installedPackageDirectory, resolvedLauncher))
      fail(`npm launcher "${name}" does not resolve to the installed package`);

    const helpResult = invoke(launcher, ["--help"], { cwd: consumerDirectory, env: environment });
    if (helpResult.status !== 0 || !(helpResult.stdout ?? "").includes("Usage: inari"))
      fail(`installed ${name} --help did not reach the packaged entrypoint`);

    for (const sessionCommand of ["issue", "inspect"]) {
      const sessionHelp = invoke(launcher, ["session", sessionCommand, "--help"], {
        cwd: consumerDirectory,
        env: environment,
      });
      if (sessionHelp.status !== 0 || !(sessionHelp.stdout ?? "").includes(`Usage: inari session ${sessionCommand}`))
        fail(`installed ${name} does not expose session ${sessionCommand}`);
    }

    for (const authorityCommand of ["register", "rotate", "revoke"]) {
      const authorityHelp = invoke(launcher, ["authority", authorityCommand, "--help"], {
        cwd: consumerDirectory,
        env: environment,
      });
      if (
        authorityHelp.status !== 0 ||
        !(authorityHelp.stdout ?? "").includes(`Usage: inari authority ${authorityCommand}`)
      )
        fail(`installed ${name} does not expose authority ${authorityCommand}`);
    }

    const versionResult = invoke(launcher, ["--version"], { cwd: consumerDirectory, env: environment });
    if (versionResult.status !== 0 || versionResult.stdout.trim() !== `${packageJson.name} ${packageJson.version}`)
      fail(`installed ${name} --version returned an unexpected result`);

    const versionJson = jsonOutput(
      invoke(launcher, ["--version", "--json"], { cwd: consumerDirectory, env: environment }),
      `${name} --version --json`,
    );
    validateVersionOutput(versionJson, packageJson);

    const preflight = jsonOutput(
      invoke(launcher, ["--diagnose", "--json"], { cwd: consumerDirectory, env: environment }),
      `${name} --diagnose --json`,
    );
    validatePreflightOutput(preflight, packageJson);

    const skillIndex = jsonOutput(
      invoke(launcher, ["skill", "--json"], { cwd: consumerDirectory, env: environment }),
      `${name} skill --json`,
    );
    const validatedSkillIndex = validateSkillIndex(skillIndex);
    if (!validatedSkillIndex.scenarios.some((scenario) => scenario.id === "golden-path"))
      fail(`installed ${name} does not expose the Golden Path Skill scenario`);
    const skillScenario = jsonOutput(
      invoke(launcher, ["skill", "golden-path", "--json"], { cwd: consumerDirectory, env: environment }),
      `${name} skill golden-path --json`,
    );
    if (
      skillScenario.id !== "golden-path" ||
      !Array.isArray(skillScenario.workflow) ||
      skillScenario.workflow.length === 0
    )
      fail(`installed ${name} returned an invalid Skill scenario`);
    if (skillVersion === undefined) skillVersion = validatedSkillIndex.version;
    else if (skillVersion !== validatedSkillIndex.version)
      fail("installed executables disagree on Skill contract version");
  }
  const canonical = executableOnPath("inari", environment.PATH);
  const expectedCanonical = path.join(consumerDirectory, "node_modules", ".bin", "inari");
  if (canonical === undefined || fs.realpathSync(canonical) !== fs.realpathSync(expectedCanonical))
    fail("canonical preflight resolved an executable outside the fresh consumer environment");
  return { skillVersion };
}

function prepareGovernedConsumer(consumerDirectory) {
  fs.cpSync(path.join(repoRoot, ".github"), path.join(consumerDirectory, ".github"), { recursive: true });
  run("git", ["init", "--quiet"], { cwd: consumerDirectory });
  run("git", ["config", "user.name", "packed-certification"], { cwd: consumerDirectory });
  run("git", ["config", "user.email", "packed-certification@example.invalid"], { cwd: consumerDirectory });
  run("git", ["add", ".github"], { cwd: consumerDirectory });
  run("git", ["commit", "--quiet", "-m", "controlled governance generation"], { cwd: consumerDirectory });
  const workflowSha = run("git", ["rev-parse", "HEAD"], { cwd: consumerDirectory }).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(workflowSha)) fail("controlled consumer governance commit has no exact SHA");
  return workflowSha;
}

function installControlledGh(certificationRoot) {
  const directory = path.join(certificationRoot, "controlled-gh");
  fs.mkdirSync(directory);
  const executable = path.join(directory, "gh");
  fs.copyFileSync(path.join(repoRoot, "scripts", "controlled-github.mjs"), executable);
  fs.chmodSync(executable, 0o755);
  return executable;
}

function createGoldenPathInputs(certificationRoot) {
  const directory = path.join(certificationRoot, "golden-path-input");
  fs.mkdirSync(directory);
  const issueInput = path.join(directory, "issue.json");
  fs.writeFileSync(
    issueInput,
    JSON.stringify({
      fields: {
        problem: "The packed artifact must execute the governed Change lifecycle.",
        capability: "Certify the installed package through the complete Golden Path.",
        contract: "The certification harness must exercise the production lifecycle contracts.",
        acceptance: "- [ ] Verify the complete installed-package path",
        non_goals: "Live GitHub dogfood remains outside this deterministic provider.",
      },
    }),
  );
  return { issueInput };
}

function createProviderState(statePath, workflowSha, issueBody) {
  fs.writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        workflowSha,
        issues: {
          415: {
            number: 415,
            title: "test: certify packed artifact Golden Path",
            body: issueBody,
            state: "open",
          },
          416: {
            number: 416,
            title: "test: certify packed artifact recovery",
            body: issueBody,
            state: "open",
          },
        },
        branches: { main: "0123456789abcdef0123456789abcdef01234567" },
        pulls: {},
        runs: [],
        artifacts: {},
        nextRunId: 1000,
        nextArtifactId: 2000,
        failDeleteOnce: { 416: true },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function callMcp(launcher, consumerDirectory, environment, name, args) {
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "packed-certification", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
  ];
  const invocation = invoke(launcher, ["mcp", "serve", "--repository", "yohn-jp/gh-inari"], {
    cwd: consumerDirectory,
    env: environment,
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (invocation.error !== undefined) fail(`MCP ${name} failed to start: ${invocation.error.message}`);
  if (invocation.status !== 0)
    fail(`MCP ${name} exited ${String(invocation.status)}:\n${invocation.stdout ?? ""}\n${invocation.stderr ?? ""}`);
  const responses = (invocation.stdout ?? "")
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        fail(`MCP ${name} emitted non-JSON output: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  const response = responses.find((candidate) => candidate?.id === 2);
  if (response === undefined) fail(`MCP ${name} emitted no response for the tool call`);
  if (response.error !== undefined) fail(`MCP ${name} returned a protocol error: ${JSON.stringify(response.error)}`);
  const structuredContent = response.result?.structuredContent;
  if (structuredContent === undefined) fail(`MCP ${name} returned no structured content`);
  return structuredContent;
}

function statusInput(issue, projection, packageVersion, executionOutcome, review) {
  return {
    environment: { status: "available", packageIdentity: `gh-inari@${packageVersion}`, capabilities: ["golden-path"] },
    governance: { status: "available", repositoryHost: "github.com", repositoryId: "415000001" },
    issue: {
      status: "present",
      number: issue,
      state: "open",
      governed: true,
    },
    changeProjection: projection,
    implementation: { status: "ready", ready: true, complete: true, evidence: true },
    ready: { status: "eligible", eligible: true, preconditions: true, evidence: true },
    ...(executionOutcome === undefined ? {} : { executionOutcome }),
    ...(review === undefined ? {} : { review }),
    subject: { repositoryHost: "github.com", repositoryId: "415000001", rootIssue: issue },
  };
}

function assertSuccessfulChange(result, operation, expectedState) {
  if (result.ok !== true || result.operation !== operation || result.status !== "healthy")
    fail(`${operation} did not return a healthy installed-package Change projection`);
  if (expectedState !== undefined && result.state !== expectedState)
    fail(`${operation} returned state ${String(result.state)}, expected ${expectedState}`);
  if (result.evidence?.outcome !== "verified" && result.evidence?.outcome !== "returned-existing")
    fail(`${operation} did not return verified or idempotent execution evidence`);
}

function certifyCompleteGoldenPath(consumerDirectory, launcher, environment, packageVersion, statePath) {
  const repository = "yohn-jp/gh-inari";
  const invokeChange = (operation, issue, expectedStatus = 0) =>
    jsonOutput(
      invoke(launcher, ["change", operation, String(issue), "--repository", repository, "--json"], {
        cwd: consumerDirectory,
        env: environment,
      }),
      `installed change ${operation} ${issue}`,
      expectedStatus,
    );

  const firstIssue = invokeChange("issue", 415);
  assertSuccessfulChange(firstIssue, "change.issue", "DRAFT");
  if (firstIssue.entry?.valid !== true || firstIssue.entry?.action?.operation !== "change.issue")
    fail("installed Change issuance did not expose the canonical Golden Path entry action");
  if (
    firstIssue.entry.action.mode !== "return-existing" ||
    firstIssue.entry.status?.executionOutcome !== "verified" ||
    typeof firstIssue.entry.version !== "number"
  )
    fail("installed Golden Path entry did not expose the verified return-existing action and version");
  const goldenPathVersion = String(firstIssue.entry.version);

  const repeatedIssue = invokeChange("issue", 415);
  assertSuccessfulChange(repeatedIssue, "change.issue", "DRAFT");
  if (repeatedIssue.evidence.outcome !== "returned-existing" || repeatedIssue.entry?.action?.mode !== "return-existing")
    fail("repeated installed Change issuance did not prove idempotency");

  const entry = callMcp(launcher, consumerDirectory, environment, "inari_golden_path_entry", {
    repository,
    issue: 415,
  });
  if (entry.ok !== true || entry.valid !== true || entry.entry?.action?.mode !== "return-existing")
    fail(
      `installed Golden Path entry MCP boundary did not read the canonical idempotent action: ${JSON.stringify(entry)}`,
    );

  const handoff = callMcp(launcher, consumerDirectory, environment, "inari_change_handoff", {
    repository,
    issue: 415,
  });
  if (
    handoff.ok !== true ||
    handoff.valid !== true ||
    handoff.handoff?.state !== "DRAFT" ||
    handoff.handoff?.rootIssue !== 415 ||
    typeof handoff.handoff?.branch !== "string" ||
    typeof handoff.handoff?.pullRequest !== "number"
  )
    fail("installed implementation handoff MCP boundary did not expose canonical identities");

  const readyStatus = callMcp(launcher, consumerDirectory, environment, "inari_golden_path_status", {
    input: statusInput(415, firstIssue.projection, packageVersion, firstIssue.evidence.outcome),
  });
  if (
    readyStatus.ok !== true ||
    readyStatus.valid !== true ||
    readyStatus.version === undefined ||
    readyStatus.status?.phase !== "READY" ||
    readyStatus.nextAction?.kind !== "READY_CHANGE"
  )
    fail(`installed Golden Path status MCP boundary did not project the ready action: ${JSON.stringify(readyStatus)}`);
  const statusRecoveryVersion = String(readyStatus.version);

  const firstReady = invokeChange("ready", 415);
  assertSuccessfulChange(firstReady, "change.ready", "REVIEW");
  const shownReview = invokeChange("show", 415);
  if (shownReview.ok !== true || shownReview.state !== "REVIEW" || shownReview.status !== "healthy")
    fail("installed Change show did not reread the REVIEW projection");
  const repeatedReady = invokeChange("ready", 415);
  assertSuccessfulChange(repeatedReady, "change.ready", "REVIEW");
  if (repeatedReady.evidence.outcome !== "returned-existing") fail("Ready retry did not prove idempotency");

  const reviewStatus = callMcp(launcher, consumerDirectory, environment, "inari_golden_path_status", {
    input: statusInput(415, shownReview.projection, packageVersion, firstReady.evidence.outcome, {
      status: "required",
      action: "review",
    }),
  });
  if (reviewStatus.ok !== true || reviewStatus.valid !== true || reviewStatus.status?.phase !== "REVIEW")
    fail("installed Golden Path status MCP boundary did not project REVIEW");

  const firstRecoveryIssue = invokeChange("issue", 416);
  assertSuccessfulChange(firstRecoveryIssue, "change.issue", "DRAFT");
  const recoveryReady = invokeChange("ready", 416);
  assertSuccessfulChange(recoveryReady, "change.ready", "REVIEW");
  const abortFailure = invokeChange("abort", 416, 2);
  const recoveryEvidence = abortFailure.evidence;
  if (
    abortFailure.ok !== false ||
    recoveryEvidence?.outcome !== "recovery-required" ||
    recoveryEvidence.compensation !== "failed" ||
    recoveryEvidence.failure?.kind !== "DELETE_BRANCH" ||
    !Array.isArray(recoveryEvidence.effects) ||
    recoveryEvidence.effects.length !== 2 ||
    recoveryEvidence.effects[0]?.kind !== "CLOSE_PULL_REQUEST" ||
    recoveryEvidence.effects[0]?.status !== "succeeded" ||
    recoveryEvidence.effects[1]?.kind !== "DELETE_BRANCH" ||
    recoveryEvidence.effects[1]?.status !== "failed"
  )
    fail("installed abort did not expose the bounded recovery-required outcome");

  const recoveryProjection = invokeChange("show", 416, 2);
  if (
    recoveryProjection.ok !== false ||
    recoveryProjection.status !== "partial" ||
    recoveryProjection.state !== "RECOVERY_REQUIRED" ||
    recoveryProjection.canonicalBranch !== "test/416-certify-packed-artifact-recovery" ||
    recoveryProjection.projection?.change?.projection?.branch !== "test/416-certify-packed-artifact-recovery" ||
    recoveryProjection.projection?.change?.projection?.pullRequest !== 4160
  )
    fail("installed Change reread did not expose the partial recovery projection");
  const recoveryStatus = callMcp(launcher, consumerDirectory, environment, "inari_golden_path_status", {
    input: statusInput(416, recoveryProjection.projection, packageVersion),
    recoveryInput: { projection: recoveryProjection.projection, evidence: recoveryEvidence },
  });
  if (
    recoveryStatus.ok !== true ||
    recoveryStatus.valid !== true ||
    recoveryStatus.status?.phase !== "RECOVERY" ||
    recoveryStatus.nextAction?.owner !== "recovery" ||
    recoveryStatus.nextAction?.kind !== "MANUAL_REVIEW" ||
    recoveryStatus.nextAction?.reasonCode !== "MANUAL_RECOVERY_REVIEW_REQUIRED" ||
    recoveryStatus.recovery?.class !== "ABORT_CLEANUP_UNSAFE" ||
    recoveryStatus.recovery?.safeAction !== "MANUAL_REVIEW" ||
    recoveryStatus.recovery?.retryable !== false ||
    recoveryStatus.recovery?.rereadRequired !== true ||
    recoveryStatus.recovery?.automaticCleanup !== "forbidden" ||
    recoveryStatus.recovery?.owner !== "recovery" ||
    recoveryStatus.recovery?.reasonCode !== "MANUAL_RECOVERY_REVIEW_REQUIRED"
  )
    fail("installed Golden Path recovery/status boundary did not project a recovery-owned action");

  const recoveredAbort = invokeChange("abort", 416);
  assertSuccessfulChange(recoveredAbort, "change.abort", "ABORTED");
  if (
    recoveredAbort.evidence?.outcome !== "verified" ||
    !Array.isArray(recoveredAbort.evidence.effects) ||
    recoveredAbort.evidence.effects.length !== 1 ||
    recoveredAbort.evidence.effects[0]?.kind !== "DELETE_BRANCH" ||
    recoveredAbort.evidence.effects[0]?.status !== "succeeded"
  )
    fail("installed abort recovery retry was not bounded to the pending branch deletion");

  const repeatedRecoveredAbort = invokeChange("abort", 416);
  assertSuccessfulChange(repeatedRecoveredAbort, "change.abort", "ABORTED");
  if (
    repeatedRecoveredAbort.evidence?.outcome !== "returned-existing" ||
    !Array.isArray(repeatedRecoveredAbort.evidence.effects) ||
    repeatedRecoveredAbort.evidence.effects.length !== 0
  )
    fail("installed terminal abort retry duplicated a destructive effect");

  const terminal = invokeChange("show", 416);
  if (terminal.ok !== true || terminal.status !== "healthy" || terminal.state !== "ABORTED")
    fail("installed abort retry did not complete the canonical cleanup transition");
  const terminalStatus = callMcp(launcher, consumerDirectory, environment, "inari_golden_path_status", {
    input: statusInput(416, terminal.projection, packageVersion),
  });
  if (
    terminalStatus.ok !== true ||
    terminalStatus.valid !== true ||
    terminalStatus.status?.phase !== "TERMINAL" ||
    terminalStatus.nextAction !== null
  )
    fail("installed Golden Path status MCP boundary did not project terminal completion");

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (state.branches?.["test/416-certify-packed-artifact-recovery"] !== undefined)
    fail("recovered abort left the canonical branch behind");
  return { goldenPathVersion, statusRecoveryVersion };
}

function createEntryFixture(consumerDirectory) {
  const fixtureDirectory = path.join(consumerDirectory, "entry-fixture");
  const githubDirectory = path.join(fixtureDirectory, ".github");
  fs.mkdirSync(githubDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(githubDirectory, "PULL_REQUEST_TEMPLATE.md"),
    "## Summary\n\n## Linked issue\n\n## Validation\n\n- [ ] Tests\n",
  );
  fs.mkdirSync(path.join(githubDirectory, "inari"));
  fs.writeFileSync(
    path.join(githubDirectory, "inari", "pr-policy.yml"),
    "version: 1\ntemplate: default\nsections:\n  - section: summary\n    required: true\n    minLength: 10\n  - section: linked_issue\n    linkedIssue: true\n  - section: validation\n    required: true\n    checklist:\n      minCompleted: 1\n",
  );
  const inputPath = path.join(fixtureDirectory, "valid.json");
  fs.writeFileSync(
    inputPath,
    JSON.stringify({ fields: { summary: "packed entry", linked_issue: "Closes #999", validation: ["tests"] } }),
  );
  return { fixtureDirectory, inputPath };
}

function certifyEntryBoundary(consumerDirectory, environment) {
  const { fixtureDirectory, inputPath } = createEntryFixture(consumerDirectory);
  const binDirectory = path.join(consumerDirectory, "node_modules", ".bin");
  const validationArgs = ["pr", "validate", "--from", inputPath, "--json"];

  for (const name of REQUIRED_BIN_NAMES) {
    const launcher = path.join(binDirectory, name);
    const validation = jsonOutput(
      invoke(launcher, validationArgs, { cwd: fixtureDirectory, env: environment }),
      `${name} packaged entry validation`,
    );
    if (validation.valid !== true || !Array.isArray(validation.violations))
      fail(`installed ${name} did not enter the governed CLI boundary from the packed artifact`);
  }
}

function certifyNpxFallback(rootDirectory, tarballPath, externalExecutables) {
  const { consumerDirectory, packageFile, packageContents } = createConsumer(rootDirectory, "npx-consumer");
  const emptyBinDirectory = path.join(consumerDirectory, "empty-bin");
  fs.mkdirSync(emptyBinDirectory);
  const environment = freshEnvironment(rootDirectory, emptyBinDirectory, externalExecutables);
  const result = jsonOutput(
    invoke(executablePath("npx"), ["--yes", `--package=${tarballPath}`, "gh-inari", "--version", "--json"], {
      cwd: consumerDirectory,
      env: environment,
    }),
    "npx packed gh-inari --version --json",
  );
  validateVersionOutput(result, packageJson);
  if (fs.readFileSync(packageFile, "utf8") !== packageContents)
    fail("npx packed execution modified the fresh consumer package.json");
}

function main() {
  const { tarball, evidence } = parseArgs(process.argv.slice(2));
  let tarballPath;
  let ownsTarball = false;
  const observedContractVersions = {};
  if (tarball === undefined) {
    console.log("packing certification artifact with npm pack...");
    tarballPath = packArtifact();
    ownsTarball = true;
  } else {
    tarballPath = path.resolve(tarball);
    if (path.extname(tarballPath) !== ".tgz" || !fs.existsSync(tarballPath)) fail(`tarball not found: ${tarballPath}`);
  }

  const certificationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gh-inari-golden-path-"));
  try {
    const { consumerDirectory, packageFile, packageContents } = createConsumer(certificationRoot, "consumer");
    const npmExecutable = executablePath("npm");
    const npxExecutable = executablePath("npx");
    const ghExecutable = executablePath("gh");
    const externalExecutables = [npmExecutable, npxExecutable, ghExecutable];
    const installBinDirectory = path.join(certificationRoot, "install-bin");
    fs.mkdirSync(installBinDirectory);
    const environment = freshEnvironment(certificationRoot, installBinDirectory, externalExecutables);

    console.log("installing only the packed tarball into a fresh consumer...");
    run(
      npmExecutable,
      [
        "install",
        "--no-save",
        "--no-package-lock",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
        tarballPath,
      ],
      { cwd: consumerDirectory, env: environment },
    );
    if (fs.readFileSync(packageFile, "utf8") !== packageContents)
      fail("installing the packed artifact modified the fresh consumer package.json");

    const installedPackageDirectory = packageDirectoryForName(consumerDirectory, packageJson.name);
    const packageData = validateInstalledPackage(installedPackageDirectory, consumerDirectory, packageJson);
    const binDirectory = path.join(consumerDirectory, "node_modules", ".bin");
    const installedLauncher = path.join(binDirectory, "inari");
    const workflowSha = prepareGovernedConsumer(consumerDirectory);
    const { issueInput } = createGoldenPathInputs(certificationRoot);
    const renderedIssue = jsonOutput(
      invoke(installedLauncher, ["issue", "render", "--template", "feature", "--from", issueInput, "--json"], {
        cwd: consumerDirectory,
        env: environment,
      }),
      "installed issue render",
    );
    if (renderedIssue.valid !== true || typeof renderedIssue.body !== "string")
      fail("installed package did not render the governed Golden Path Issue body");
    const statePath = path.join(certificationRoot, "provider-state.json");
    createProviderState(statePath, workflowSha, renderedIssue.body);
    const controlledGh = installControlledGh(certificationRoot);
    const installedEnvironment = {
      ...environment,
      INARI_PACKED_ENTRY: path.join(installedPackageDirectory, "dist", "index.js"),
      INARI_PACKED_PACKAGE_ROOT: installedPackageDirectory,
      INARI_PACKED_CONSUMER_ROOT: consumerDirectory,
      INARI_PACKED_PROVIDER_STATE: statePath,
      PATH: boundedPath(binDirectory, externalExecutables, [controlledGh]),
    };
    const launcherChecks = checkInstalledLaunchers(
      consumerDirectory,
      installedPackageDirectory,
      packageData.binTargets,
      installedEnvironment,
    );
    observedContractVersions.skill = launcherChecks.skillVersion;
    console.log(
      `packed preflight passed: ${packageData.binTargets.length} executable(s), ${packageData.exportTargets.length} export target(s), runtime dependencies installed in the fresh consumer.`,
    );

    certifyEntryBoundary(consumerDirectory, installedEnvironment);
    console.log("executing the complete Golden Path through the installed package and controlled Actions provider...");
    const goldenPathVersions = certifyCompleteGoldenPath(
      consumerDirectory,
      installedLauncher,
      installedEnvironment,
      packageJson.version,
      statePath,
    );
    observedContractVersions.goldenPath = goldenPathVersions.goldenPathVersion;
    observedContractVersions.statusRecovery = goldenPathVersions.statusRecoveryVersion;
    certifyNpxFallback(certificationRoot, tarballPath, externalExecutables);

    // Compatibility certification is also fed from the installed package. It
    // is deliberately performed after canonical preflight; no checked-out
    // executable or repository-local package is installed as an extension.
    const extensionEnvironment = {
      ...installedEnvironment,
      GH_CONFIG_DIR: path.join(certificationRoot, "extension-gh"),
    };
    console.log("installing the packed executable as a local GitHub CLI extension...");
    run(ghExecutable, ["extension", "install", "."], {
      cwd: installedPackageDirectory,
      env: extensionEnvironment,
    });
    const extensionHelp = invoke(ghExecutable, ["inari", "--help"], {
      cwd: consumerDirectory,
      env: extensionEnvironment,
    });
    if (extensionHelp.status !== 0 || !(extensionHelp.stdout ?? "").includes("Usage: inari"))
      fail("gh inari did not execute the installed packed executable");
    const extensionVersion = jsonOutput(
      invoke(ghExecutable, ["inari", "--version", "--json"], {
        cwd: consumerDirectory,
        env: extensionEnvironment,
      }),
      "gh inari packed --version --json",
    );
    validateVersionOutput(extensionVersion, packageJson);

    console.log("packed artifact preflight, entry, and complete Golden Path certification passed.");
    if (evidence !== undefined) {
      writePackedEvidence(evidence, tarballPath, CERTIFICATION_RESULTS[0], [], observedContractVersions);
      console.log(`packed certification evidence written to ${path.resolve(evidence)}`);
    }
  } catch (error) {
    if (evidence !== undefined) {
      const diagnostics = [];
      appendCertificationDiagnostic(
        diagnostics,
        "PACKED_CERTIFICATION_FAILED",
        error instanceof Error ? error.message : error,
      );
      writePackedEvidence(evidence, tarballPath, CERTIFICATION_RESULTS[1], diagnostics, observedContractVersions);
      console.log(`packed certification evidence written to ${path.resolve(evidence)}`);
    }
    throw error;
  } finally {
    if (process.env.INARI_KEEP_CERTIFICATION_ROOT !== "1")
      fs.rmSync(certificationRoot, { recursive: true, force: true });
    if (ownsTarball && tarballPath !== undefined) fs.rmSync(tarballPath, { force: true });
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`packed certification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
