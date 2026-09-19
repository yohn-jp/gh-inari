#!/usr/bin/env node

// Issue #689 coordinator. It packs this source, installs the exact tarball in
// a disposable directory outside the checkout, and runs the lifecycle runner
// there. The runner imports only the installed package and returns bounded
// projections; this coordinator retains and validates the evidence envelope.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const REQUIRED_BINS = Object.freeze(["inari", "gh-inari"]);
const SOURCE_ISSUE = 689;
const BRANCH = "test/689-implementation-native-lifecycle-certification";

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.error !== undefined) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0)
    fail(
      `${command} ${args.join(" ")} failed (${String(result.status)}): ${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  return result;
}

function invoke(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function isInside(directory, candidate) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function outsideCheckout(candidate, label) {
  const resolved = fs.realpathSync(candidate);
  if (isInside(repoRoot, resolved)) fail(`${label} resolves into the source checkout: ${resolved}`);
  return resolved;
}

function packageDirectory(consumerDirectory) {
  if (packageJson.name.startsWith("@")) {
    const [scope, name] = packageJson.name.split("/");
    return path.join(consumerDirectory, "node_modules", scope, name);
  }
  return path.join(consumerDirectory, "node_modules", packageJson.name);
}

function packageTarget(packageDirectoryPath, target) {
  if (typeof target !== "string" || target.length === 0) fail("installed package target is invalid");
  const resolved = path.resolve(packageDirectoryPath, target.replace(/^\.\//u, ""));
  if (!isInside(packageDirectoryPath, resolved)) fail(`installed package target escapes package: ${target}`);
  return resolved;
}

function exportTargets(value, targets = []) {
  if (typeof value === "string") {
    targets.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) exportTargets(entry, targets);
  } else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) exportTargets(entry, targets);
  }
  return targets;
}

function packArtifact() {
  const result = run("npm", ["pack", "--json", "--ignore-scripts"]);
  const parsed = JSON.parse(result.stdout);
  const info = Array.isArray(parsed) ? parsed[0] : (parsed[packageJson.name] ?? parsed);
  if (typeof info?.filename !== "string") fail("npm pack did not produce a filename");
  const tarball = path.resolve(repoRoot, info.filename);
  if (!tarball.endsWith(".tgz") || !fs.statSync(tarball).isFile()) fail("npm pack did not produce a tarball");
  return tarball;
}

function installEnvironment(root) {
  const home = path.join(root, "home");
  const npmrc = path.join(root, "npmrc");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(npmrc, "", { mode: 0o600 });
  return {
    ...process.env,
    HOME: home,
    NPM_CONFIG_USERCONFIG: npmrc,
    npm_config_userconfig: npmrc,
  };
}

function installedRuntimeEnvironment(root, consumer) {
  const nodeBin = path.join(root, "node-bin");
  fs.mkdirSync(nodeBin);
  fs.symlinkSync(process.execPath, path.join(nodeBin, "node"));
  const environment = {
    ...process.env,
    PATH: [path.join(consumer, "node_modules", ".bin"), nodeBin].join(path.delimiter),
    HOME: path.join(root, "runtime-home"),
    XDG_CONFIG_HOME: path.join(root, "runtime-config"),
    XDG_DATA_HOME: path.join(root, "runtime-data"),
    XDG_STATE_HOME: path.join(root, "runtime-state"),
  };
  fs.mkdirSync(environment.HOME, { recursive: true });
  for (const key of [
    "NODE_PATH",
    "NODE_OPTIONS",
    "NPM_CONFIG_GLOBALCONFIG",
    "NPM_CONFIG_USERCONFIG",
    "npm_config_globalconfig",
    "npm_config_userconfig",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ])
    delete environment[key];
  return environment;
}

function jsonCommand(command, args, cwd, env, label) {
  const result = invoke(command, args, { cwd, env });
  if (result.error !== undefined) fail(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} failed (${String(result.status)}): ${result.stderr ?? ""}`);
  try {
    return JSON.parse((result.stdout ?? "").trim());
  } catch (error) {
    fail(`${label} did not emit JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateInstalledArtifact(installed, consumer, tarball) {
  outsideCheckout(installed, "installed package");
  if (fs.lstatSync(installed).isSymbolicLink()) fail("installed package is a symlink");
  const installedPackage = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
  if (installedPackage.name !== packageJson.name || installedPackage.version !== packageJson.version)
    fail("installed package identity does not match the source package");
  for (const name of REQUIRED_BINS) {
    const target = installedPackage.bin?.[name];
    if (typeof target !== "string") fail(`installed package is missing ${name}`);
    const executable = packageTarget(installed, target);
    if (!fs.existsSync(executable) || (fs.statSync(executable).mode & 0o100) === 0)
      fail(`installed ${name} is missing or not executable`);
    outsideCheckout(executable, `installed ${name}`);
  }
  for (const target of exportTargets(installedPackage.exports)) {
    const exportPath = packageTarget(installed, target);
    if (!fs.existsSync(exportPath)) fail(`installed export target is missing: ${target}`);
    outsideCheckout(exportPath, `installed export ${target}`);
  }
  for (const dependency of Object.keys(installedPackage.dependencies ?? {})) {
    const dependencyPath = dependency.startsWith("@")
      ? path.join(consumer, "node_modules", ...dependency.split("/"))
      : path.join(consumer, "node_modules", dependency);
    if (!fs.existsSync(dependencyPath) || fs.lstatSync(dependencyPath).isSymbolicLink())
      fail(`installed runtime dependency is missing or linked: ${dependency}`);
    outsideCheckout(dependencyPath, `runtime dependency ${dependency}`);
  }
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex")}`;
}

function assertNoSensitiveOutput(output, label) {
  const text = `${output.stdout ?? ""}\n${output.stderr ?? ""}`;
  for (const pattern of [
    /-----BEGIN/iu,
    /bearer\s+/iu,
    /private\s*key/iu,
    /\b(?:token|password|secret|credential)\b/iu,
  ])
    if (pattern.test(text)) fail(`${label} emitted secret-shaped output`);
}

async function main() {
  const currentBranch = run("git", ["branch", "--show-current"]).stdout.trim();
  if (currentBranch !== BRANCH) fail(`certification must run on ${BRANCH}, got ${currentBranch}`);
  const dirty = run("git", ["status", "--short"]).stdout.trim();
  if (dirty.length > 0) fail("certification source identity requires a clean checkout before packing");
  const tarball = packArtifact();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-inari-689-lifecycle-"));
  outsideCheckout(root, "certification root");
  let outputPath;
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex >= 0) {
    outputPath = process.argv[outputIndex + 1];
    if (typeof outputPath !== "string" || outputPath.length === 0) fail("--output requires a path");
    if (isInside(repoRoot, outputPath)) fail("certification evidence output must be outside the source checkout");
  }
  try {
    const consumer = path.join(root, "consumer");
    fs.mkdirSync(consumer);
    fs.writeFileSync(
      path.join(consumer, "package.json"),
      JSON.stringify({ name: "issue-689-installed-consumer", version: "1.0.0", private: true }, null, 2),
    );
    const installEnv = installEnvironment(root);
    run(
      "npm",
      [
        "install",
        "--no-save",
        "--no-package-lock",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
        tarball,
      ],
      { cwd: consumer, env: installEnv },
    );
    const installed = packageDirectory(consumer);
    const tarballSha256 = validateInstalledArtifact(installed, consumer, tarball);
    const runtimeEnv = installedRuntimeEnvironment(root, consumer);
    const inariBin = path.join(consumer, "node_modules", ".bin", "inari");
    const version = jsonCommand(inariBin, ["--version", "--json"], consumer, runtimeEnv, "installed version");
    if (version.ok !== true || version.name !== packageJson.name || version.version !== packageJson.version)
      fail("installed executable identity is not exact");
    const diagnose = jsonCommand(inariBin, ["--diagnose", "--json"], consumer, runtimeEnv, "installed diagnose");
    if (diagnose.ok !== true || diagnose.canonical?.status !== "ready") fail("installed diagnose is not ready");
    const skill = jsonCommand(inariBin, ["skill", "--json"], consumer, runtimeEnv, "installed skill");
    if (typeof skill.version !== "string" || !Array.isArray(skill.scenarios) || skill.scenarios.length === 0)
      fail("installed Skill index is invalid");

    const runnerPath = path.join(root, "implementation-lifecycle-certification-runner.mjs");
    fs.copyFileSync(path.join(repoRoot, "scripts", "implementation-lifecycle-certification-runner.mjs"), runnerPath);
    outsideCheckout(runnerPath, "installed lifecycle runner");
    const runner = invoke(process.execPath, [runnerPath], {
      cwd: consumer,
      env: { ...runtimeEnv, INARI_PACKED_PACKAGE_ROOT: installed },
    });
    assertNoSensitiveOutput(runner, "installed lifecycle runner");
    if (runner.error !== undefined) fail(`installed lifecycle runner failed to start: ${runner.error.message}`);
    if (runner.status !== 0)
      fail(`installed lifecycle runner failed (${String(runner.status)}): ${runner.stderr ?? ""}`);
    let projection;
    try {
      projection = JSON.parse((runner.stdout ?? "").trim());
    } catch (error) {
      fail(`installed lifecycle runner did not emit JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    const evidenceModule = await import(
      pathToFileURL(path.join(installed, "scripts", "certification-evidence.mjs")).href
    );
    const evidence = {
      schemaVersion: evidenceModule.CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
      certificationKind: "implementation-native-lifecycle",
      result: "passed",
      sourceCommitSha: run("git", ["rev-parse", "HEAD"]).stdout.trim(),
      contractVersions: projection.contractVersions,
      package: { name: packageJson.name, version: packageJson.version, tarballSha256 },
      repository: { owner: "yohn-jp", name: "gh-inari" },
      sourceIssue: SOURCE_ISSUE,
      implementation: projection.implementation,
      session: projection.session,
      operations: projection.operations,
      finalState: projection.finalState,
      diagnostics: [],
    };
    const validation = evidenceModule.validateImplementationLifecycleCertificationEvidence(evidence);
    if (!validation.valid) fail(`retained lifecycle evidence is invalid: ${validation.errors.join("; ")}`);
    const serialized = evidenceModule.serializeCertificationEvidence(evidence);
    if (outputPath !== undefined) evidenceModule.writeCertificationEvidence(outputPath, evidence);
    process.stdout.write(serialized);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tarball, { force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `implementation lifecycle certification failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
