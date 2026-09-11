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
  CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
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

function boundedPath(binDirectory, externalExecutables) {
  const directories = [
    binDirectory,
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
  const goldenPathIndex = argv.indexOf("--certify-golden-path");
  const readValue = (option, optionIndex) => {
    if (optionIndex === -1) return undefined;
    const value = argv[optionIndex + 1];
    if (value === undefined || value.startsWith("--")) fail(`${option} requires a value`);
    return value;
  };
  const value = readValue("--tarball", index);
  return {
    tarball: value,
    evidence: readValue("--evidence", evidenceIndex),
    certifyGoldenPath: goldenPathIndex !== -1,
  };
}

function sourceCommitSha() {
  const value = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(value)) fail("git rev-parse HEAD did not return an exact commit SHA");
  return value;
}

function certificationContractVersions() {
  return {
    goldenPath: process.env.INARI_GOLDEN_PATH_CONTRACT_VERSION ?? "unavailable",
    statusRecovery: process.env.INARI_STATUS_RECOVERY_CONTRACT_VERSION ?? "unavailable",
    skill: process.env.INARI_SKILL_CONTRACT_VERSION ?? "unavailable",
  };
}

function writePackedEvidence(evidencePath, tarballPath, result = "blocked", diagnostics = []) {
  fs.mkdirSync(path.dirname(path.resolve(evidencePath)), { recursive: true });
  writeCertificationEvidence(evidencePath, {
    schemaVersion: CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
    certificationKind: "packed-artifact-golden-path",
    result,
    sourceCommitSha: sourceCommitSha(),
    contractVersions: certificationContractVersions(),
    package: {
      name: packageJson.name,
      version: packageJson.version,
      tarballSha256: sha256Tarball(tarballPath),
    },
    diagnostics,
  });
}

function certifyGoldenPathSkill(consumerDirectory, environment) {
  const launcher = path.join(consumerDirectory, "node_modules", ".bin", "inari");
  const result = jsonOutput(
    invoke(launcher, ["skill", "golden-path", "--json"], { cwd: consumerDirectory, env: environment }),
    "installed inari skill golden-path --json",
  );
  if (result.id !== "golden-path" || !Array.isArray(result.workflow) || result.workflow.length === 0)
    fail("installed inari skill golden-path returned an invalid playbook");
  return result;
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
    const firstScenario = validatedSkillIndex.scenarios[0].id;
    const skillScenario = jsonOutput(
      invoke(launcher, ["skill", firstScenario, "--json"], { cwd: consumerDirectory, env: environment }),
      `${name} skill ${firstScenario} --json`,
    );
    if (skillScenario.id !== firstScenario || !Array.isArray(skillScenario.workflow))
      fail(`installed ${name} returned an invalid Skill scenario`);
  }
  const canonical = executableOnPath("inari", environment.PATH);
  const expectedCanonical = path.join(consumerDirectory, "node_modules", ".bin", "inari");
  if (canonical === undefined || fs.realpathSync(canonical) !== fs.realpathSync(expectedCanonical))
    fail("canonical preflight resolved an executable outside the fresh consumer environment");
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
  const { tarball, evidence, certifyGoldenPath } = parseArgs(process.argv.slice(2));
  let tarballPath;
  let ownsTarball = false;
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
    const installedEnvironment = { ...environment, PATH: boundedPath(binDirectory, externalExecutables) };
    checkInstalledLaunchers(consumerDirectory, installedPackageDirectory, packageData.binTargets, installedEnvironment);
    console.log(
      `packed preflight passed: ${packageData.binTargets.length} executable(s), ${packageData.exportTargets.length} export target(s), runtime dependencies installed in the fresh consumer.`,
    );

    certifyEntryBoundary(consumerDirectory, installedEnvironment);
    if (certifyGoldenPath) {
      console.log("checking the installed inari skill golden-path contract...");
      certifyGoldenPathSkill(consumerDirectory, installedEnvironment);
    }
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

    console.log("packed Golden Path preflight and entry certification passed.");
    if (evidence !== undefined) {
      writePackedEvidence(evidence, tarballPath, "blocked", [
        {
          code: "DEPENDENCY_CONTRACTS_NOT_INTEGRATED",
          message:
            "Complete Golden Path certification remains blocked until the #402/#403/#404 contracts are integrated and exercised.",
        },
      ]);
      console.log(`packed certification evidence written to ${path.resolve(evidence)}`);
    }
  } finally {
    fs.rmSync(certificationRoot, { recursive: true, force: true });
    if (ownsTarball && tarballPath !== undefined) fs.rmSync(tarballPath, { force: true });
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`packed Golden Path certification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
