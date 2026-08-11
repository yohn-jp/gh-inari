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
      const helpResult = spawnSync(launcher, ["--help"], { cwd: installDirectory, encoding: "utf8", timeout: 10_000 });
      if (helpResult.error) fail(`launcher "${name}" failed to start: ${helpResult.error.message}`);
      if (helpResult.status !== 0) fail(`launcher "${name}" --help exited ${helpResult.status}, expected 0`);

      console.log(`running ${name} --version through its installed launcher...`);
      const versionResult = spawnSync(launcher, ["--version"], {
        cwd: installDirectory,
        encoding: "utf8",
        timeout: 10_000,
      });
      if (versionResult.error) fail(`launcher "${name}" failed to start: ${versionResult.error.message}`);
      if (versionResult.status !== 0) fail(`launcher "${name}" --version exited ${versionResult.status}, expected 0`);
      if (versionResult.stdout.trim().length === 0) fail(`launcher "${name}" --version printed nothing`);
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
    if (!ghAvailable) {
      console.log("GitHub CLI (gh) not available, skipping extension installation tests.");
    } else {
      console.log("installing the packed executable as a local GitHub CLI extension...");
      run("gh", ["extension", "install", "."], { cwd: installedPackageDirectory, env: ghExtensionEnvironment });
      console.log("running gh inari --help through GitHub CLI extension discovery...");
      const ghHelpResult = spawnSync("gh", ["inari", "--help"], {
        cwd: installDirectory,
        env: ghExtensionEnvironment,
        encoding: "utf8",
        timeout: 10_000,
      });
      if (ghHelpResult.error) fail(`gh inari failed to start: ${ghHelpResult.error.message}`);
      if (ghHelpResult.status !== 0) {
        fail(
          `gh inari --help exited ${ghHelpResult.status}, expected 0:\n${ghHelpResult.stdout}\n${ghHelpResult.stderr}`,
        );
      }
      if (!ghHelpResult.stdout.includes("Usage: gh-inari")) fail("gh inari did not invoke the gh-inari extension");

      console.log("running gh inari --version through GitHub CLI extension discovery...");
      const ghVersionResult = spawnSync("gh", ["inari", "--version"], {
        cwd: installDirectory,
        env: ghExtensionEnvironment,
        encoding: "utf8",
        timeout: 10_000,
      });
      if (ghVersionResult.error) fail(`gh inari version failed to start: ${ghVersionResult.error.message}`);
      if (ghVersionResult.status !== 0) {
        fail(
          `gh inari --version exited ${ghVersionResult.status}, expected 0:\n${ghVersionResult.stdout}\n${ghVersionResult.stderr}`,
        );
      }
      if (!ghVersionResult.stdout.includes(`${packageName} ${packageJson.version}`))
        fail("gh inari did not report the installed package version");
    }

    console.log("smoke test passed.");
  } finally {
    fs.rmSync(installDirectory, { recursive: true, force: true });
    if (ownsTarball) fs.rmSync(tarballPath, { force: true });
  }
}

main();
