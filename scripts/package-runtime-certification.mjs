#!/usr/bin/env node

// Runtime-only certification for the packed standalone package. The Golden
// Path certification remains a separate authority in smoke-test.mjs.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const providerScript = path.join(repoRoot, "scripts", "controlled-github.mjs");
const REQUIRED_BIN_NAMES = Object.freeze(["inari", "gh-inari"]);
const FIXTURE_TOKEN = "packed-native-http-fixture-token";
const RAW_PROVIDER_SENTINEL = "PACKED_PROVIDER_RAW_RESPONSE_SENTINEL";
const POISON_GH_SENTINEL = "PACKED_POISON_GH_INVOKED";

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.error !== undefined) fail(`${command} ${args.join(" ")} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed (status ${String(result.status)}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result;
}

function invoke(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function assertNoFixtureSecrets(result, label) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  for (const secret of [FIXTURE_TOKEN, RAW_PROVIDER_SENTINEL]) {
    if (output.includes(secret)) fail(`${label} leaked bounded fixture data`);
  }
}

function jsonOutput(result, label, expectedStatus = 0) {
  assertNoFixtureSecrets(result, label);
  if (result.error !== undefined) fail(`${label} failed to start: ${result.error.message}`);
  if (result.status !== expectedStatus) {
    fail(
      `${label} exited ${String(result.status)}, expected ${expectedStatus}:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  try {
    return JSON.parse((result.stdout ?? "").trim());
  } catch (error) {
    fail(`${label} did not emit JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isPathInside(directory, candidate) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertOutsideCheckout(candidate, label) {
  const resolved = fs.realpathSync(candidate);
  if (isPathInside(repoRoot, resolved)) fail(`${label} resolves into the source checkout: ${resolved}`);
  return resolved;
}

function packageDirectoryForName(consumerDirectory, name) {
  if (name.startsWith("@")) {
    const [scope, packagePart] = name.split("/");
    return path.join(consumerDirectory, "node_modules", scope, packagePart);
  }
  return path.join(consumerDirectory, "node_modules", name);
}

function resolvePackagePath(packageDirectory, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) fail("package target must be non-empty");
  const resolved = path.resolve(packageDirectory, relativePath);
  if (!isPathInside(packageDirectory, resolved)) fail(`package target escapes the installed package: ${relativePath}`);
  return resolved;
}

function validateInstalledArtifact(installedPackageDirectory, consumerDirectory, tarballPath) {
  const installedPackageJson = JSON.parse(
    fs.readFileSync(path.join(installedPackageDirectory, "package.json"), "utf8"),
  );
  if (installedPackageJson.name !== packageJson.name || installedPackageJson.version !== packageJson.version) {
    fail(
      `installed package identity was ${String(installedPackageJson.name)}@${String(installedPackageJson.version)}, expected ${packageJson.name}@${packageJson.version}`,
    );
  }
  if (fs.lstatSync(installedPackageDirectory).isSymbolicLink())
    fail("installed package is a symlink; workspace links are not certified");
  assertOutsideCheckout(installedPackageDirectory, "installed package");

  const binEntries = Object.entries(installedPackageJson.bin ?? {});
  if (binEntries.length === 0) fail("installed package has no executable bin entries");
  for (const name of REQUIRED_BIN_NAMES) {
    const target = binEntries.find(([entryName]) => entryName === name)?.[1];
    if (typeof target !== "string") fail(`installed package is missing executable ${name}`);
    const targetPath = resolvePackagePath(installedPackageDirectory, target);
    if (!fs.existsSync(targetPath)) fail(`installed executable ${name} is missing`);
    assertOutsideCheckout(targetPath, `installed executable ${name}`);
    if ((fs.statSync(targetPath).mode & 0o100) === 0) fail(`installed executable ${name} is not executable`);
  }

  for (const target of collectExportTargets(installedPackageJson.exports)) {
    const targetPath = resolvePackagePath(installedPackageDirectory, target);
    if (!fs.existsSync(targetPath)) fail(`installed export target is missing: ${target}`);
    assertOutsideCheckout(targetPath, `installed export target ${target}`);
  }
  for (const dependencyName of Object.keys(installedPackageJson.dependencies ?? {})) {
    const dependencyPath = packageDirectoryForName(consumerDirectory, dependencyName);
    if (!fs.existsSync(dependencyPath)) fail(`installed runtime dependency is missing: ${dependencyName}`);
    if (fs.lstatSync(dependencyPath).isSymbolicLink()) fail(`runtime dependency is a symlink: ${dependencyName}`);
    assertOutsideCheckout(dependencyPath, `runtime dependency ${dependencyName}`);
  }

  const tarballDigest = crypto.createHash("sha256").update(fs.readFileSync(tarballPath)).digest("hex");
  return { installedPackageJson, tarballDigest, binEntries };
}

function collectExportTargets(value, targets = []) {
  if (typeof value === "string") {
    targets.push(value.replace(/^\.\//u, ""));
    return targets;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectExportTargets(entry, targets);
    return targets;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) collectExportTargets(entry, targets);
  }
  return targets;
}

function createConsumer(rootDirectory) {
  const consumerDirectory = path.join(rootDirectory, "consumer");
  fs.mkdirSync(consumerDirectory);
  const packageFile = path.join(consumerDirectory, "package.json");
  const packageContents = JSON.stringify({ name: "packed-runtime-consumer", private: true, version: "1.0.0" }, null, 2);
  fs.writeFileSync(packageFile, packageContents);
  return { consumerDirectory, packageFile, packageContents };
}

function installEnvironment(rootDirectory) {
  const homeDirectory = path.join(rootDirectory, "install-home");
  fs.mkdirSync(homeDirectory, { recursive: true });
  const npmrc = path.join(rootDirectory, "install.npmrc");
  fs.writeFileSync(npmrc, "");
  return {
    ...process.env,
    HOME: homeDirectory,
    NPM_CONFIG_USERCONFIG: npmrc,
    npm_config_userconfig: npmrc,
  };
}

function createNodeBin(rootDirectory, name) {
  const directory = path.join(rootDirectory, name);
  fs.mkdirSync(directory);
  fs.symlinkSync(process.execPath, path.join(directory, "node"));
  return directory;
}

function createPoisonGh(rootDirectory) {
  const directory = path.join(rootDirectory, "poison-gh");
  fs.mkdirSync(directory);
  const executable = path.join(directory, "gh");
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node\nimport fs from "node:fs";\nfs.appendFileSync(process.env.INARI_POISON_GH_LOG, "${POISON_GH_SENTINEL}\\n");\nprocess.stderr.write("${POISON_GH_SENTINEL}\\n");\nprocess.exit(97);\n`,
    { mode: 0o755 },
  );
  return { directory, log: path.join(rootDirectory, "poison-gh.log") };
}

function runtimeEnvironment(rootDirectory, consumerDirectory, mode, providerUrl) {
  const nodeDirectory = createNodeBin(rootDirectory, `runtime-node-${mode}`);
  const environment = {
    ...process.env,
    PATH: [path.join(consumerDirectory, "node_modules", ".bin"), nodeDirectory].join(path.delimiter),
    HOME: path.join(rootDirectory, `runtime-home-${mode}`),
    XDG_CONFIG_HOME: path.join(rootDirectory, `runtime-xdg-config-${mode}`),
    XDG_DATA_HOME: path.join(rootDirectory, `runtime-xdg-data-${mode}`),
    XDG_STATE_HOME: path.join(rootDirectory, `runtime-xdg-state-${mode}`),
    GH_CONFIG_DIR: path.join(rootDirectory, `runtime-gh-config-${mode}`),
    GH_PROMPT_DISABLED: "1",
    GH_TOKEN: FIXTURE_TOKEN,
    GITHUB_API_URL: providerUrl,
  };
  fs.mkdirSync(environment.HOME, { recursive: true });
  for (const variable of [
    "NODE_PATH",
    "NODE_OPTIONS",
    "NPM_CONFIG_GLOBALCONFIG",
    "NPM_CONFIG_USERCONFIG",
    "npm_config_globalconfig",
    "npm_config_userconfig",
    "GITHUB_ACTIONS",
    "GITHUB_ACTOR",
    "GITHUB_TRIGGERING_ACTOR",
  ]) {
    delete environment[variable];
  }
  if (mode === "poison") {
    const poison = createPoisonGh(rootDirectory);
    environment.PATH = [poison.directory, environment.PATH].join(path.delimiter);
    environment.INARI_POISON_GH_LOG = poison.log;
  }
  return environment;
}

function executableOnPath(name, pathValue) {
  for (const directory of pathValue.split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // The runtime PATH is intentionally bounded; continue through it.
    }
  }
  return undefined;
}

function prepareGovernedConsumer(consumerDirectory) {
  fs.cpSync(path.join(repoRoot, ".github"), path.join(consumerDirectory, ".github"), { recursive: true });
  run("git", ["init", "--quiet"], { cwd: consumerDirectory });
  run("git", ["config", "user.name", "packed-runtime-certification"], { cwd: consumerDirectory });
  run("git", ["config", "user.email", "packed-runtime-certification@example.invalid"], {
    cwd: consumerDirectory,
  });
  run("git", ["add", ".github"], { cwd: consumerDirectory });
  run("git", ["commit", "--quiet", "-m", "controlled governance generation"], { cwd: consumerDirectory });
  return run("git", ["rev-parse", "HEAD"], { cwd: consumerDirectory }).stdout.trim();
}

function createIssueInput(rootDirectory) {
  const inputPath = path.join(rootDirectory, "issue-input.json");
  fs.writeFileSync(
    inputPath,
    JSON.stringify({
      fields: {
        problem: "The packed artifact must read a governed Issue through native HTTP.",
        capability: "Certify the installed standalone package without a functional gh executable.",
        contract: "Provider fixtures must remain bounded and HTTP-native.",
        acceptance: "- [ ] Verify the installed package and native provider boundary",
        non_goals: "Change authority and Golden Path certification remain separate.",
      },
    }),
  );
  return inputPath;
}

function createProviderState(statePath, workflowSha, issueBody) {
  fs.writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        workflowSha,
        issues: {
          667: {
            number: 667,
            title: "test: certify packed and live Inari with gh unavailable",
            body: issueBody,
            state: "open",
            rawProviderResponse: RAW_PROVIDER_SENTINEL,
          },
        },
        branches: { main: "0123456789abcdef0123456789abcdef01234567" },
        pulls: {},
        runs: [],
        artifacts: [],
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function startHttpProvider(environment) {
  const child = spawn(process.execPath, [providerScript, "--server"], {
    cwd: repoRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  return await new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const failStart = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once("error", failStart);
    child.once("exit", (status) => {
      if (!settled) {
        failStart(
          new Error(
            `HTTP provider exited before binding (status ${String(status)}): ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
      }
    });
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      output += chunk.toString("utf8");
      const line = output.split(/\r?\n/u, 1)[0]?.trim() ?? "";
      if (line.length === 0) return;
      try {
        const url = new URL(line);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("invalid HTTP provider URL");
        settled = true;
        resolve({ child, url: line });
      } catch (error) {
        failStart(error instanceof Error ? error : new Error("invalid HTTP provider URL"));
      }
    });
  });
}

function certifyInstalledRuntime(consumerDirectory, installedPackageDirectory, environment) {
  const binDirectory = path.join(consumerDirectory, "node_modules", ".bin");
  for (const name of REQUIRED_BIN_NAMES) {
    const launcher = path.join(binDirectory, name);
    const help = invoke(launcher, ["--help"], { cwd: consumerDirectory, env: environment });
    assertNoFixtureSecrets(help, `${name} help`);
    if (help.status !== 0 || !(help.stdout ?? "").includes("Usage: inari"))
      fail(`installed ${name} --help did not reach the packaged entrypoint`);

    const version = jsonOutput(
      invoke(launcher, ["--version", "--json"], { cwd: consumerDirectory, env: environment }),
      `${name} version`,
    );
    if (version.ok !== true || version.name !== packageJson.name || version.version !== packageJson.version)
      fail(`installed ${name} returned an invalid exact runtime identity`);
    if (!Array.isArray(version.capabilities)) fail(`installed ${name} returned no runtime capabilities`);

    const preflight = jsonOutput(
      invoke(launcher, ["--diagnose", "--json"], { cwd: consumerDirectory, env: environment }),
      `${name} preflight`,
    );
    if (
      preflight.ok !== true ||
      preflight.name !== packageJson.name ||
      preflight.version !== packageJson.version ||
      preflight.canonical?.invocation !== "inari" ||
      preflight.canonical?.status !== "ready" ||
      !Array.isArray(preflight.requiredCapabilities) ||
      preflight.requiredCapabilities.length === 0
    )
      fail(`installed ${name} did not pass canonical runtime preflight`);

    const skill = jsonOutput(
      invoke(launcher, ["skill", "--json"], { cwd: consumerDirectory, env: environment }),
      `${name} skill`,
    );
    if (typeof skill.version !== "string" || !Array.isArray(skill.scenarios) || skill.scenarios.length === 0)
      fail(`installed ${name} returned an invalid Skill index`);
  }

  const installedCanonical = executableOnPath("inari", environment.PATH);
  if (
    installedCanonical === undefined ||
    fs.realpathSync(installedCanonical) !== fs.realpathSync(path.join(binDirectory, "inari"))
  )
    fail("runtime preflight resolved an executable outside the installed consumer");

  const launcher = path.join(binDirectory, "inari");
  const check = jsonOutput(
    invoke(launcher, ["issue", "check", "667", "--repository", "yohn-jp/gh-inari", "--json"], {
      cwd: consumerDirectory,
      env: environment,
    }),
    "native HTTP Issue check",
    2,
  );
  if (
    check.status !== "non-canonical" ||
    check.classification !== "valid" ||
    check.valid !== false ||
    check.normalizable !== true ||
    "disposableMarker" in check
  )
    fail("installed package did not accept the native HTTP Issue fixture as a compatible governed artifact");

  const inspected = jsonOutput(
    invoke(launcher, ["issue", "get", "667", "--repository", "yohn-jp/gh-inari", "--json"], {
      cwd: consumerDirectory,
      env: environment,
    }),
    "native HTTP Issue get",
  );
  if (inspected.valid !== true || inspected.classification !== "valid" || "body" in inspected)
    fail("installed package exposed an invalid or raw provider Issue projection");
}

function suppliedTarballPath(args) {
  if (args.length !== 2 || args[0] !== "--tarball" || args[1].length === 0) {
    fail("usage: package-runtime-certification.mjs --tarball <artifact.tgz>");
  }
  const tarballPath = path.resolve(args[1]);
  if (!tarballPath.endsWith(".tgz")) fail("supplied package artifact must be a .tgz file");
  if (!fs.existsSync(tarballPath) || !fs.statSync(tarballPath).isFile()) {
    fail("supplied package artifact does not exist or is not a file");
  }
  return tarballPath;
}

function certifyPoisonGhBoundary(consumerDirectory, environment) {
  const launcher = path.join(consumerDirectory, "node_modules", ".bin", "inari");
  const inspected = jsonOutput(
    invoke(launcher, ["issue", "get", "667", "--repository", "yohn-jp/gh-inari", "--json"], {
      cwd: consumerDirectory,
      env: environment,
    }),
    "poison gh native HTTP Issue get",
  );
  if (inspected.valid !== true || inspected.classification !== "valid" || "body" in inspected) {
    fail("poison gh boundary did not preserve the native HTTP Issue projection");
  }
}

async function main() {
  const tarballPath = suppliedTarballPath(process.argv.slice(2));
  const certificationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gh-inari-package-runtime-"));
  let provider;
  try {
    const { consumerDirectory, packageFile, packageContents } = createConsumer(certificationRoot);
    if (isPathInside(consumerDirectory, tarballPath))
      fail("supplied package artifact must remain outside the consumer");
    const installEnv = installEnvironment(certificationRoot);
    const npm = run("which", ["npm"]).stdout.trim();
    run(
      npm,
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
      { cwd: consumerDirectory, env: installEnv },
    );
    if (fs.readFileSync(packageFile, "utf8") !== packageContents)
      fail("package installation modified the consumer manifest");

    const installedPackageDirectory = packageDirectoryForName(consumerDirectory, packageJson.name);
    const identity = validateInstalledArtifact(installedPackageDirectory, consumerDirectory, tarballPath);
    const governanceSha = prepareGovernedConsumer(consumerDirectory);
    const noProviderEnvironment = runtimeEnvironment(
      certificationRoot,
      consumerDirectory,
      "unavailable",
      "http://127.0.0.1:1",
    );
    const inputPath = createIssueInput(certificationRoot);
    const rendered = jsonOutput(
      invoke(
        path.join(consumerDirectory, "node_modules", ".bin", "inari"),
        ["issue", "render", "--template", "feature", "--from", inputPath, "--json"],
        {
          cwd: consumerDirectory,
          env: noProviderEnvironment,
        },
      ),
      "installed Issue render",
    );
    if (rendered.valid !== true || typeof rendered.body !== "string")
      fail("installed package did not render the provider fixture");

    const statePath = path.join(certificationRoot, "provider-state.json");
    createProviderState(statePath, governanceSha, rendered.body);
    const providerEnvironment = {
      ...installEnv,
      INARI_PACKED_PROVIDER_STATE: statePath,
      INARI_PACKED_CONSUMER_ROOT: consumerDirectory,
    };
    provider = await startHttpProvider(providerEnvironment);

    const unavailable = { ...noProviderEnvironment, GITHUB_API_URL: provider.url };
    if (executableOnPath("gh", unavailable.PATH) !== undefined)
      fail("gh must be unavailable in the package runtime PATH");
    certifyInstalledRuntime(consumerDirectory, installedPackageDirectory, unavailable);
    console.log(`gh unavailable package runtime passed: ${packageJson.name}@${packageJson.version}`);

    const poison = runtimeEnvironment(certificationRoot, consumerDirectory, "poison", provider.url);
    certifyPoisonGhBoundary(consumerDirectory, poison);
    if (fs.existsSync(poison.INARI_POISON_GH_LOG)) fail(`product executed poison gh: ${POISON_GH_SENTINEL}`);
    console.log("poison gh guard passed: no product invocation was observed");
    console.log(
      `packed/installed identity passed: ${packageJson.name}@${packageJson.version} sha256:${identity.tarballDigest}`,
    );
  } finally {
    if (provider !== undefined && provider.child.exitCode === null) {
      provider.child.kill("SIGTERM");
      await new Promise((resolve) => provider.child.once("exit", resolve));
    }
    fs.rmSync(certificationRoot, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`package runtime certification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
