#!/usr/bin/env node
// Installs the packed tarball into an isolated directory and runs the
// installed bin through its real npm-generated launcher. `npm pack --dry-run`
// only lists file contents — it never proves install or execution actually
// work, which is the failure mode this guards against.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const packageName = packageJson.name;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (status ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function fail(message) {
  console.error(`smoke test failed: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function packageBinTargets(packageDirectory) {
  const installedPackageJson = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
  const bin = installedPackageJson.bin;
  if (typeof bin !== "object" || bin === null) fail("installed package.json has no bin map");
  return Object.entries(bin).map(([name, relativeTarget]) => ({
    name,
    target: path.join(packageDirectory, relativeTarget),
  }));
}

function invoke(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000, ...options });
  if (result.error) fail(`${command} ${args.join(" ")} failed to start: ${result.error.message}`);
  return result;
}

function jsonOutput(result, label, expectedStatus = 0) {
  if (result.status !== expectedStatus) {
    fail(`${label} exited ${result.status}:\n${result.stdout}\n${result.stderr}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`${label} did not emit JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseArgs(argv) {
  const index = argv.indexOf("--tarball");
  return { tarball: index === -1 ? undefined : argv[index + 1] };
}

function main() {
  const { tarball } = parseArgs(process.argv.slice(2));
  let tarballPath;
  let ownsTarball;
  if (tarball !== undefined) {
    tarballPath = path.resolve(tarball);
    ownsTarball = false;
    if (!fs.existsSync(tarballPath)) fail(`tarball not found: ${tarballPath}`);
  } else {
    console.log("packing tarball...");
    // Verifies the dist produced by the build step, not a re-built one:
    // prepack's implicit rebuild is intentionally not relied on here.
    const packResult = run("npm", ["pack", "--json", "--ignore-scripts"], { cwd: repoRoot });
    const [packInfo] = JSON.parse(packResult.stdout);
    tarballPath = path.join(repoRoot, packInfo.filename);
    ownsTarball = true;
  }

  const installDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
  try {
    fs.writeFileSync(
      path.join(installDirectory, "package.json"),
      JSON.stringify({ name: "smoke-consumer", private: true, version: "1.0.0" }, null, 2),
    );

    console.log("installing packed tarball into isolated directory...");
    run("npm", ["install", "--no-save", tarballPath], { cwd: installDirectory });

    const scope = packageName.startsWith("@") ? packageName.split("/")[0] : undefined;
    const installedPackageDirectory = scope
      ? path.join(installDirectory, "node_modules", scope, packageName.split("/")[1])
      : path.join(installDirectory, "node_modules", packageName);
    if (!fs.existsSync(installedPackageDirectory)) fail(`${packageName} was not installed under node_modules`);

    const binTargets = packageBinTargets(installedPackageDirectory);
    if (binTargets.length === 0) fail("package.json defines no bin entries to smoke test");

    for (const { name, target } of binTargets) {
      if (!fs.existsSync(target)) fail(`bin target for "${name}" does not exist at ${target}`);
    }

    // Goes through node_modules/.bin so a broken npm-generated launcher is
    // caught too — checking bin target existence alone would miss that.
    const binDirectory = path.join(installDirectory, "node_modules", ".bin");
    for (const { name } of binTargets) {
      const launcher = path.join(binDirectory, name);
      if (!fs.existsSync(launcher)) fail(`npm did not generate a launcher for "${name}" at ${launcher}`);

      console.log(`running ${name} --help through its installed launcher...`);
      const helpResult = invoke(launcher, ["--help"], { cwd: installDirectory });
      if (helpResult.status !== 0) fail(`launcher "${name}" --help exited ${helpResult.status}, expected 0`);

      console.log(`running ${name} --version through its installed launcher...`);
      const versionResult = invoke(launcher, ["--version"], { cwd: installDirectory });
      if (versionResult.status !== 0) fail(`launcher "${name}" --version exited ${versionResult.status}, expected 0`);
      if (versionResult.stdout.trim().length === 0) fail(`launcher "${name}" --version printed nothing`);
    }

    const fixtureDirectory = path.join(installDirectory, "fixture-repository");
    const policyDirectory = path.join(fixtureDirectory, ".github", "inari");
    fs.mkdirSync(policyDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(fixtureDirectory, ".github", "PULL_REQUEST_TEMPLATE.md"),
      "## Summary\n\n## Linked issue\n\n## Validation\n\n- [ ] Tests\n- [ ] Build\n",
    );
    fs.writeFileSync(
      path.join(policyDirectory, "pr-policy.yml"),
      "version: 1\ntemplate: default\nsections:\n  - section: summary\n    required: true\n    minLength: 10\n  - section: linked_issue\n    linkedIssue: true\n  - section: validation\n    required: true\n    checklist:\n      minCompleted: 1\n",
    );
    const validationCases = [
      {
        name: "linked-issue",
        fields: { summary: "valid summary", linked_issue: "see issue 999", validation: ["tests"] },
        valid: false,
      },
      {
        name: "short-string",
        fields: { summary: "short", linked_issue: "Closes #999", validation: ["tests"] },
        valid: false,
      },
      {
        name: "empty-checklist",
        fields: { summary: "valid summary", linked_issue: "Closes #999", validation: [] },
        valid: false,
      },
      {
        name: "valid",
        fields: { summary: "valid summary", linked_issue: "Closes #999", validation: ["tests"] },
        valid: true,
      },
    ];
    for (const validationCase of validationCases) {
      validationCase.inputPath = path.join(fixtureDirectory, validationCase.name + ".json");
      fs.writeFileSync(validationCase.inputPath, JSON.stringify({ fields: validationCase.fields }));
    }

    const ghConfigDirectory = path.join(installDirectory, "gh-config");
    fs.mkdirSync(ghConfigDirectory, { recursive: true });
    const installedExtension = path.join(installedPackageDirectory, "gh-inari");
    if (!fs.existsSync(installedExtension)) fail("installed package did not expose the gh-inari extension executable");
    const ghExtensionEnvironment = {
      ...process.env,
      GH_CONFIG_DIR: ghConfigDirectory,
      XDG_DATA_HOME: path.join(installDirectory, "gh-data"),
      GH_PROMPT_DISABLED: "1",
      GH_TOKEN: "smoke-test-token",
    };
    const ghAvailable = spawnSync("gh", ["--version"], { encoding: "utf8" }).status === 0;
    if (!ghAvailable) fail("GitHub CLI (gh) is required for the packed extension smoke test");

    const sourceGhConfigDirectory = path.join(installDirectory, "source-gh-config");
    const sourceExtensionEnvironment = {
      ...ghExtensionEnvironment,
      GH_CONFIG_DIR: sourceGhConfigDirectory,
      XDG_DATA_HOME: path.join(installDirectory, "source-gh-data"),
    };
    const sourceExtensionDirectory = path.join(installDirectory, "gh-inari");
    fs.mkdirSync(sourceExtensionDirectory, { recursive: true });
    fs.copyFileSync(path.join(repoRoot, "gh-inari"), path.join(sourceExtensionDirectory, "gh-inari"));
    fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(sourceExtensionDirectory, "package.json"));
    fs.cpSync(path.join(repoRoot, "dist"), path.join(sourceExtensionDirectory, "dist"), { recursive: true });
    console.log("installing the checked-out executable as a GitHub CLI extension...");
    run("gh", ["extension", "install", "."], {
      cwd: sourceExtensionDirectory,
      env: sourceExtensionEnvironment,
    });
    const sourceGhHelpResult = invoke("gh", ["inari", "--help"], {
      cwd: fixtureDirectory,
      env: sourceExtensionEnvironment,
    });
    if (sourceGhHelpResult.status !== 0 || !sourceGhHelpResult.stdout.includes("Usage: gh-inari"))
      fail(`checked-out gh inari --help failed:\n${sourceGhHelpResult.stdout}\n${sourceGhHelpResult.stderr}`);

    console.log("installing the packed executable as a local GitHub CLI extension...");
    run("gh", ["extension", "install", "."], { cwd: installedPackageDirectory, env: ghExtensionEnvironment });
    const ghHelpResult = invoke("gh", ["inari", "--help"], {
      cwd: fixtureDirectory,
      env: ghExtensionEnvironment,
    });
    if (ghHelpResult.status !== 0 || !ghHelpResult.stdout.includes("Usage: gh-inari"))
      fail(`gh inari --help failed:\n${ghHelpResult.stdout}\n${ghHelpResult.stderr}`);
    const sourceEntry = path.join(repoRoot, "dist", "index.js");
    const packedLauncher = path.join(installDirectory, "node_modules", ".bin", "gh-inari");
    const validationArgs = (inputPath) => ["pr", "validate", "--from", inputPath, "--json"];
    const sourceSchema = jsonOutput(
      invoke(process.execPath, [sourceEntry, "pr", "schema"], { cwd: fixtureDirectory }),
      "source pr schema",
    );
    const sourceGhSchema = jsonOutput(
      invoke("gh", ["inari", "pr", "schema"], { cwd: fixtureDirectory, env: sourceExtensionEnvironment }),
      "checked-out gh inari pr schema",
    );
    const packedSchema = jsonOutput(
      invoke(packedLauncher, ["pr", "schema"], { cwd: fixtureDirectory }),
      "packed gh-inari pr schema",
    );
    const ghSchema = jsonOutput(
      invoke("gh", ["inari", "pr", "schema"], { cwd: fixtureDirectory, env: ghExtensionEnvironment }),
      "gh inari pr schema",
    );
    if (JSON.stringify(sourceGhSchema) !== JSON.stringify(sourceSchema))
      fail("checked-out gh inari schema diverged from the source CLI");
    if (JSON.stringify(packedSchema) !== JSON.stringify(sourceSchema))
      fail("packed gh-inari pr schema diverged from the source CLI");
    if (JSON.stringify(ghSchema) !== JSON.stringify(sourceSchema))
      fail("gh inari pr schema diverged from the source CLI");

    console.log("checking source, packed, and gh inari validation parity...");
    for (const validationCase of validationCases) {
      const args = validationArgs(validationCase.inputPath);
      const sourceResult = invoke(process.execPath, [sourceEntry, ...args], { cwd: fixtureDirectory });
      const sourceGhResult = invoke("gh", ["inari", ...args], {
        cwd: fixtureDirectory,
        env: sourceExtensionEnvironment,
      });
      const packedResult = invoke(packedLauncher, args, { cwd: fixtureDirectory });
      const ghResult = invoke("gh", ["inari", ...args], { cwd: fixtureDirectory, env: ghExtensionEnvironment });
      for (const [label, result] of [
        ["source", sourceResult],
        ["checked-out gh inari", sourceGhResult],
        ["packed gh-inari", packedResult],
        ["gh inari", ghResult],
      ]) {
        const expectedStatus = validationCase.valid ? 0 : 2;
        if (result.status !== expectedStatus)
          fail(label + " " + validationCase.name + " exited " + result.status + ", expected " + expectedStatus);
        const output = jsonOutput(result, label + " " + validationCase.name, expectedStatus);
        if (output.valid !== validationCase.valid || !Array.isArray(output.violations))
          fail(label + " " + validationCase.name + " returned an unexpected validation result");
      }
      if (
        sourceGhResult.stdout !== sourceResult.stdout ||
        packedResult.stdout !== sourceResult.stdout ||
        ghResult.stdout !== sourceResult.stdout
      )
        fail(validationCase.name + " validation output diverged across execution paths");
    }

    console.log("checking source, packed, and gh inari render parity...");
    const renderCase = validationCases.find((candidate) => candidate.valid);
    const renderArgs = ["pr", "render", "--from", renderCase.inputPath, "--json"];
    const sourceRender = jsonOutput(
      invoke(process.execPath, [sourceEntry, ...renderArgs], { cwd: fixtureDirectory }),
      "source pr render",
    );
    const sourceGhRender = jsonOutput(
      invoke("gh", ["inari", ...renderArgs], { cwd: fixtureDirectory, env: sourceExtensionEnvironment }),
      "checked-out gh inari pr render",
    );
    const packedRender = jsonOutput(
      invoke(packedLauncher, renderArgs, { cwd: fixtureDirectory }),
      "packed gh-inari pr render",
    );
    const ghRender = jsonOutput(
      invoke("gh", ["inari", ...renderArgs], { cwd: fixtureDirectory, env: ghExtensionEnvironment }),
      "gh inari pr render",
    );
    if (sourceRender.valid !== true || typeof sourceRender.body !== "string" || sourceRender.body.length === 0)
      fail("source pr render did not produce a rendered governance body");
    if (JSON.stringify(sourceGhRender) !== JSON.stringify(sourceRender))
      fail("checked-out gh inari render diverged from the source CLI");
    if (JSON.stringify(packedRender) !== JSON.stringify(sourceRender))
      fail("packed gh-inari pr render diverged from the source CLI");
    if (JSON.stringify(ghRender) !== JSON.stringify(sourceRender))
      fail("gh inari pr render diverged from the source CLI");

    for (const [label, command, args, options] of [
      ["source", process.execPath, [sourceEntry, "--version"], { cwd: fixtureDirectory }],
      [
        "checked-out gh inari",
        "gh",
        ["inari", "--version"],
        { cwd: fixtureDirectory, env: sourceExtensionEnvironment },
      ],
      ["packed gh-inari", packedLauncher, ["--version"], { cwd: fixtureDirectory }],
      ["gh inari", "gh", ["inari", "--version"], { cwd: fixtureDirectory, env: ghExtensionEnvironment }],
    ]) {
      const versionResult = invoke(command, args, options);
      const expectedVersion = packageName + " " + packageJson.version;
      if (versionResult.status !== 0 || versionResult.stdout.trim() !== expectedVersion)
        fail(label + " did not report the package version " + expectedVersion);
    }

    console.log("smoke test passed.");
  } finally {
    fs.rmSync(installDirectory, { recursive: true, force: true });
    if (ownsTarball) fs.rmSync(tarballPath, { force: true });
  }
}

main();
