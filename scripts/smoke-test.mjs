#!/usr/bin/env node
// Installs the packed tarball into an isolated directory and runs the
// installed bin through its real npm-generated launcher. The checked-out
// extension path is kept in a separate temporary tree so its first run cannot
// resolve dependencies from the repository's node_modules. `npm pack --dry-run`
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

  const smokeRootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gh-inari-smoke-"));
  const installDirectory = path.join(smokeRootDirectory, "consumer");
  fs.mkdirSync(installDirectory);
  try {
    const consumerPackageJsonPath = path.join(installDirectory, "package.json");
    const consumerPackageJson = JSON.stringify({ name: "smoke-consumer", private: true, version: "1.0.0" }, null, 2);
    fs.writeFileSync(consumerPackageJsonPath, consumerPackageJson);

    console.log("installing packed tarball into isolated directory...");
    run("npm", ["install", "--no-save", "--ignore-scripts", tarballPath], { cwd: installDirectory });
    if (fs.readFileSync(consumerPackageJsonPath, "utf8") !== consumerPackageJson)
      fail("installing gh-inari modified the consumer package.json");

    const scope = packageName.startsWith("@") ? packageName.split("/")[0] : undefined;
    const installedPackageDirectory = scope
      ? path.join(installDirectory, "node_modules", scope, packageName.split("/")[1])
      : path.join(installDirectory, "node_modules", packageName);
    if (!fs.existsSync(installedPackageDirectory)) fail(`${packageName} was not installed under node_modules`);

    console.log("checking Codex Plugin manifest and Skill resolve from the installed package...");
    const installedManifestPath = path.join(installedPackageDirectory, ".codex-plugin", "plugin.json");
    if (!fs.existsSync(installedManifestPath))
      fail(`installed package did not expose .codex-plugin/plugin.json at ${installedManifestPath}`);
    const installedPackageJson = JSON.parse(
      fs.readFileSync(path.join(installedPackageDirectory, "package.json"), "utf8"),
    );
    const installedManifest = JSON.parse(fs.readFileSync(installedManifestPath, "utf8"));
    if (installedManifest.name !== "inari")
      fail(`installed plugin name was "${installedManifest.name}", expected "inari"`);
    if (installedManifest.version !== installedPackageJson.version)
      fail("installed plugin manifest version does not match installed package version");
    if (typeof installedManifest.skills !== "string" || installedManifest.skills.length === 0)
      fail("installed .codex-plugin/plugin.json has no skills declared");
    if (installedManifest.skills !== "skills/inari")
      fail(`installed plugin Skill path was "${installedManifest.skills}", expected "skills/inari"`);
    const skillPath = installedManifest.skills;
    const installedSkillFile = path.join(installedPackageDirectory, skillPath, "SKILL.md");
    if (!fs.existsSync(installedSkillFile))
      fail(`installed plugin skill "${skillPath}" does not resolve to a SKILL.md at ${installedSkillFile}`);

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

      const versionJson = jsonOutput(
        invoke(launcher, ["--version", "--json"], { cwd: installDirectory }),
        `${name} --version --json`,
      );
      if (
        versionJson.ok !== true ||
        versionJson.name !== packageName ||
        versionJson.version !== packageJson.version ||
        !Array.isArray(versionJson.capabilities)
      )
        fail(`${name} --version --json returned an invalid runtime contract`);

      console.log(`running ${name} skill --json through its installed launcher...`);
      const skillIndexJson = jsonOutput(
        invoke(launcher, ["skill", "--json"], { cwd: installDirectory }),
        `${name} skill --json`,
      );
      if (
        typeof skillIndexJson.version !== "string" ||
        !Array.isArray(skillIndexJson.scenarios) ||
        skillIndexJson.scenarios.length === 0
      )
        fail(`${name} skill --json returned an invalid scenario index`);

      const firstScenarioId = skillIndexJson.scenarios[0].id;
      const skillScenarioJson = jsonOutput(
        invoke(launcher, ["skill", firstScenarioId, "--json"], { cwd: installDirectory }),
        `${name} skill ${firstScenarioId} --json`,
      );
      if (skillScenarioJson.id !== firstScenarioId || !Array.isArray(skillScenarioJson.workflow))
        fail(`${name} skill ${firstScenarioId} --json returned an invalid scenario playbook`);
    }

    console.log("checking one-command npx bootstrap without consumer manifest mutation...");
    const npxVersion = jsonOutput(
      invoke("npx", ["--yes", `--package=${tarballPath}`, "gh-inari", "--version", "--json"], {
        cwd: installDirectory,
      }),
      "npx gh-inari --version --json",
    );
    if (npxVersion.ok !== true || npxVersion.name !== packageName || npxVersion.version !== packageJson.version)
      fail("npx gh-inari did not execute the packed artifact");
    if (fs.readFileSync(consumerPackageJsonPath, "utf8") !== consumerPackageJson)
      fail("npx gh-inari modified the consumer package.json");

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
    // The canonical-invocation diagnostic below shells out to a bare "inari"
    // on PATH. Nothing installs that globally on a clean CI runner, so
    // prepend the locally-installed package's own node_modules/.bin (created
    // above) ahead of the inherited PATH — the same launcher already proven
    // to work is what canonical resolution should find.
    const canonicalBinPath = `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`;
    const ghExtensionEnvironment = {
      ...process.env,
      PATH: canonicalBinPath,
      GH_CONFIG_DIR: ghConfigDirectory,
      XDG_DATA_HOME: path.join(smokeRootDirectory, "gh-data"),
      XDG_STATE_HOME: path.join(smokeRootDirectory, "gh-state"),
      GH_PROMPT_DISABLED: "1",
      GH_TOKEN: "smoke-test-token",
    };
    const ghAvailable = spawnSync("gh", ["--version"], { encoding: "utf8" }).status === 0;
    if (!ghAvailable) fail("GitHub CLI (gh) is required for the packed extension smoke test");
    const ghPathResult = spawnSync("which", ["gh"], { encoding: "utf8" });
    const ghExecutable = ghPathResult.status === 0 ? ghPathResult.stdout.trim() : "";
    if (ghExecutable.length === 0) fail("unable to resolve the GitHub CLI executable path");

    const sourceGhConfigDirectory = path.join(smokeRootDirectory, "source-gh-config");
    const sourceExtensionEnvironment = {
      ...ghExtensionEnvironment,
      GH_CONFIG_DIR: sourceGhConfigDirectory,
      XDG_DATA_HOME: path.join(smokeRootDirectory, "source-gh-data"),
      XDG_STATE_HOME: path.join(smokeRootDirectory, "source-gh-state"),
    };
    // Keep the checked-out extension outside the packed consumer tree. The
    // sibling layout leaves no ancestor node_modules directory that npm's
    // first-run bootstrap could accidentally reuse.
    const sourceExtensionDirectory = path.join(smokeRootDirectory, "checked-out", "gh-inari");
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
    if (sourceGhHelpResult.status !== 0 || !sourceGhHelpResult.stdout.includes("Usage: inari"))
      fail(`checked-out gh inari --help failed:\n${sourceGhHelpResult.stdout}\n${sourceGhHelpResult.stderr}`);

    console.log("installing the packed executable as a local GitHub CLI extension...");
    run("gh", ["extension", "install", "."], { cwd: installedPackageDirectory, env: ghExtensionEnvironment });
    const ghHelpResult = invoke("gh", ["inari", "--help"], {
      cwd: fixtureDirectory,
      env: ghExtensionEnvironment,
    });
    if (ghHelpResult.status !== 0 || !ghHelpResult.stdout.includes("Usage: inari"))
      fail(`gh inari --help failed:\n${ghHelpResult.stdout}\n${ghHelpResult.stderr}`);

    for (const [label, command, args, options] of [
      [
        "checked-out gh inari",
        "gh",
        ["inari", "--diagnose", "--json"],
        { cwd: fixtureDirectory, env: sourceExtensionEnvironment },
      ],
      ["gh inari", "gh", ["inari", "--diagnose", "--json"], { cwd: fixtureDirectory, env: ghExtensionEnvironment }],
    ]) {
      const diagnostic = jsonOutput(invoke(command, args, options), label + " --diagnose --json");
      if (diagnostic.ok !== true || diagnostic.canonical?.status !== "ready")
        fail(label + " did not report a ready canonical extension");
    }

    const smokeIssueTemplate =
      "name: Feature\ndescription: Smoke feature\nbody:\n  - type: textarea\n    id: problem\n    attributes: { label: Problem }\n    validations: { required: true }\n";
    const smokePrTemplate = "## Summary\n\n## Linked issue\n\n## Validation\n\n- [ ] Tests\n- [ ] Build\n";
    const smokePrPolicy =
      "version: 1\ntemplate: default\nsections:\n  - section: summary\n    required: true\n    minLength: 10\n  - section: linked_issue\n    linkedIssue: true\n  - section: validation\n    required: true\n    checklist:\n      minCompleted: 1\n";
    const fakeGhDirectory = path.join(installDirectory, "fake-gh");
    fs.mkdirSync(fakeGhDirectory, { recursive: true });
    const fakeGhPath = path.join(fakeGhDirectory, "gh");
    const fakeGhResponses = {
      "repos/smoke/repository": { default_branch: "main" },
      "repos/smoke/repository/git/trees/main?recursive=1": {
        truncated: false,
        sha: "tree-sha",
        tree: [
          { path: ".github/ISSUE_TEMPLATE/feature.yml", type: "blob", sha: "issue-template-sha" },
          { path: ".github/PULL_REQUEST_TEMPLATE.md", type: "blob", sha: "pr-template-sha" },
          { path: ".github/inari/pr-policy.yml", type: "blob", sha: "pr-policy-sha" },
        ],
      },
      "repos/smoke/repository/git/blobs/issue-template-sha": {
        sha: "issue-template-sha",
        encoding: "base64",
        content: Buffer.from(smokeIssueTemplate, "utf8").toString("base64"),
      },
      "repos/smoke/repository/git/blobs/pr-template-sha": {
        sha: "pr-template-sha",
        encoding: "base64",
        content: Buffer.from(smokePrTemplate, "utf8").toString("base64"),
      },
      "repos/smoke/repository/git/blobs/pr-policy-sha": {
        sha: "pr-policy-sha",
        encoding: "base64",
        content: Buffer.from(smokePrPolicy, "utf8").toString("base64"),
      },
      "repos/smoke/repository/issues/21": {
        number: 21,
        title: "feat: smoke get",
        body: '### Problem\n\nA smoke-test problem\n\n<!-- inari:template {"version":"1","kind":"issue","path":".github/ISSUE_TEMPLATE/feature.yml"} -->\n',
        state: "open",
        html_url: "https://github.com/smoke/repository/issues/21",
        labels: [],
        assignees: [],
      },
      "repos/smoke/repository/pulls/43": {
        number: 43,
        title: "feat: smoke get",
        body: "## Summary\n\nA smoke-test summary\n\n## Linked issue\n\nCloses #21\n\n## Validation\n\n- [x] Tests\n- [ ] Build\n",
        state: "open",
        html_url: "https://github.com/smoke/repository/pull/43",
        draft: false,
        head: { ref: "feature" },
        base: { ref: "main" },
      },
    };
    fs.writeFileSync(
      fakeGhPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("gh version smoke\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") process.exit(0);
if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ nameWithOwner: "smoke/repository", url: "https://github.com/smoke/repository" }));
  process.exit(0);
}
if (args[0] !== "api") {
  process.stderr.write("unsupported fake gh command\\n");
  process.exit(1);
}
const endpoint = args[1];
if (endpoint === "repos/smoke/repository" && args.includes("--jq") && args[args.indexOf("--jq") + 1] === ".id") {
  process.stdout.write("100000157\\n");
  process.exit(0);
}
const responses = ${JSON.stringify(fakeGhResponses)};
if (!(endpoint in responses)) {
  process.stderr.write("unsupported fake gh endpoint: " + endpoint + "\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify(responses[endpoint]));
`,
      "utf8",
    );
    fs.chmodSync(fakeGhPath, 0o755);
    const fakeGhPathPrefix = `${fakeGhDirectory}${path.delimiter}${process.env.PATH ?? ""}`;
    const sourceGetEnvironment = { ...sourceExtensionEnvironment, PATH: fakeGhPathPrefix };
    const packedGetEnvironment = { ...ghExtensionEnvironment, PATH: fakeGhPathPrefix };
    // Goes through the gh-inari launcher rather than dist/index.js directly:
    // the launcher is what bootstraps production dependencies on first run,
    // and a bare `node dist/index.js` invocation on a clean checkout (no
    // node_modules) fails with ERR_MODULE_NOT_FOUND before that logic runs.
    const sourceEntry = path.join(sourceExtensionDirectory, "gh-inari");
    const packedLauncher = path.join(installDirectory, "node_modules", ".bin", "gh-inari");
    const validationArgs = (inputPath) => ["pr", "validate", "--from", inputPath, "--json"];
    console.log("checking isolated clean-install extension, packed gh-inari, and gh inari parity...");
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

    console.log("checking isolated clean-install, packed gh-inari, and gh inari validation parity...");
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

    console.log("checking isolated clean-install, packed gh-inari, and gh inari render parity...");
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

    console.log("checking isolated clean-install, packed gh-inari, and gh inari canonical get parity...");
    const getCases = [
      {
        name: "issue get",
        args: ["issue", "get", "21", "--template", "feature", "--repository", "smoke/repository", "--json"],
        environment: sourceGetEnvironment,
        packedEnvironment: packedGetEnvironment,
      },
      {
        name: "pr get",
        args: ["pr", "get", "43", "--repository", "smoke/repository", "--json"],
        environment: sourceGetEnvironment,
        packedEnvironment: packedGetEnvironment,
      },
    ];
    for (const getCase of getCases) {
      const sourceGet = invoke(process.execPath, [sourceEntry, ...getCase.args], {
        cwd: fixtureDirectory,
        env: getCase.environment,
      });
      const sourceGhGet = invoke(ghExecutable, ["inari", ...getCase.args], {
        cwd: fixtureDirectory,
        env: getCase.environment,
      });
      const packedGet = invoke(packedLauncher, getCase.args, {
        cwd: fixtureDirectory,
        env: getCase.packedEnvironment,
      });
      const ghGet = invoke(ghExecutable, ["inari", ...getCase.args], {
        cwd: fixtureDirectory,
        env: getCase.packedEnvironment,
      });
      const outputs = [
        ["source", sourceGet],
        ["checked-out gh inari", sourceGhGet],
        ["packed gh-inari", packedGet],
        ["gh inari", ghGet],
      ];
      for (const [label, result] of outputs) {
        const output = jsonOutput(result, label + " " + getCase.name);
        if (output.valid !== true || output.projection !== "canonical" || !output.fields)
          fail(label + " " + getCase.name + " did not return canonical fields");
        if (Object.prototype.hasOwnProperty.call(output, "body"))
          fail(label + " " + getCase.name + " returned raw Markdown");
      }
      if (
        sourceGhGet.stdout !== sourceGet.stdout ||
        packedGet.stdout !== sourceGet.stdout ||
        ghGet.stdout !== sourceGet.stdout
      )
        fail(getCase.name + " output diverged across execution paths");
    }

    console.log("checking isolated clean-install, packed gh-inari, and gh inari remediation parity...");
    const remediationCases = [
      {
        name: "issue check",
        args: ["issue", "check", "21", "--template", "feature", "--repository", "smoke/repository"],
      },
      {
        name: "pr normalize dry-run",
        args: ["pr", "normalize", "43", "--dry-run", "--repository", "smoke/repository"],
      },
    ];
    for (const remediationCase of remediationCases) {
      const sourceRemediation = invoke(process.execPath, [sourceEntry, ...remediationCase.args], {
        cwd: fixtureDirectory,
        env: sourceGetEnvironment,
      });
      const sourceGhRemediation = invoke(ghExecutable, ["inari", ...remediationCase.args], {
        cwd: fixtureDirectory,
        env: sourceGetEnvironment,
      });
      const packedRemediation = invoke(packedLauncher, remediationCase.args, {
        cwd: fixtureDirectory,
        env: packedGetEnvironment,
      });
      const ghRemediation = invoke(ghExecutable, ["inari", ...remediationCase.args], {
        cwd: fixtureDirectory,
        env: packedGetEnvironment,
      });
      const outputs = [
        ["source", sourceRemediation],
        ["checked-out gh inari", sourceGhRemediation],
        ["packed gh-inari", packedRemediation],
        ["gh inari", ghRemediation],
      ];
      for (const [label, result] of outputs) jsonOutput(result, label + " " + remediationCase.name);
      for (const [label, result] of outputs) jsonOutput(result, label + " " + remediationCase.name);
      for (const [label, result] of outputs) {
        if (result.status !== sourceRemediation.status)
          fail(
            label + " " + remediationCase.name + " exited " + result.status + ", expected " + sourceRemediation.status,
          );
      }
      if (
        sourceGhRemediation.stdout !== sourceRemediation.stdout ||
        packedRemediation.stdout !== sourceRemediation.stdout ||
        ghRemediation.stdout !== sourceRemediation.stdout
      )
        fail(remediationCase.name + " output diverged across execution paths");
    }

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

      const versionJson = jsonOutput(invoke(command, [...args, "--json"], options), label + " --version --json");
      if (versionJson.ok !== true || versionJson.name !== packageName || versionJson.version !== packageJson.version)
        fail(label + " did not report the machine-readable package version");
    }

    console.log("smoke test passed.");
  } finally {
    fs.rmSync(smokeRootDirectory, { recursive: true, force: true });
    if (ownsTarball) fs.rmSync(tarballPath, { force: true });
  }
}

main();
