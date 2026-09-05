#!/usr/bin/env node
// Package-content validation: confirms `npm pack` includes exactly the files
// package.json's "files" field promises (no more, no less), then delegates
// install/exec verification to smoke-test.mjs against the same tarball.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// This manifest must be updated whenever a source module is added or renamed.
// Suite failures are intentional until the manifest is maintained.
const EXPECTED_PACKED_FILES = [
  "gh-inari",
  "LICENSE",
  "README.md",
  "package.json",
  "branch-naming-authority.d.mts",
  "branch-naming-authority.mjs",
  ".codex-plugin/plugin.json",
  "skills/inari/SKILL.md",
  "dist/artifact.d.ts",
  "dist/artifact.js",
  "dist/artifact.js.map",
  "dist/cli-core.d.ts",
  "dist/cli-core.js",
  "dist/cli-core.js.map",
  "dist/cli.d.ts",
  "dist/cli.js",
  "dist/cli.js.map",
  "dist/change.d.ts",
  "dist/change.js",
  "dist/change.js.map",
  "dist/change-executor.d.ts",
  "dist/change-executor.js",
  "dist/change-executor.js.map",
  "dist/change-trusted-executor.d.ts",
  "dist/change-trusted-executor.js",
  "dist/change-trusted-executor.js.map",
  "dist/command-contract.d.ts",
  "dist/command-contract.js",
  "dist/command-contract.js.map",
  "dist/contract/index.d.ts",
  "dist/contract/index.js",
  "dist/contract/index.js.map",
  "dist/contract/constraints.d.ts",
  "dist/contract/constraints.js",
  "dist/contract/constraints.js.map",
  "dist/contract/ir.d.ts",
  "dist/contract/ir.js",
  "dist/contract/ir.js.map",
  "dist/contract/issue-form.d.ts",
  "dist/contract/issue-form.js",
  "dist/contract/issue-form.js.map",
  "dist/contract/issue-reference.d.ts",
  "dist/contract/issue-reference.js",
  "dist/contract/issue-reference.js.map",
  "dist/contract/normalization.d.ts",
  "dist/contract/normalization.js",
  "dist/contract/normalization.js.map",
  "dist/contract/schema.d.ts",
  "dist/contract/schema.js",
  "dist/contract/schema.js.map",
  "dist/contract/validation.d.ts",
  "dist/contract/validation.js",
  "dist/contract/validation.js.map",
  "dist/diagnostics.d.ts",
  "dist/diagnostics.js",
  "dist/diagnostics.js.map",
  "dist/github.d.ts",
  "dist/github.js",
  "dist/github.js.map",
  "dist/github/adapter.d.ts",
  "dist/github/adapter.js",
  "dist/github/adapter.js.map",
  "dist/github/capability.d.ts",
  "dist/github/capability.js",
  "dist/github/capability.js.map",
  "dist/github/change-effect-adapter.d.ts",
  "dist/github/change-effect-adapter.js",
  "dist/github/change-effect-adapter.js.map",
  "dist/github/actions-change-executor.d.ts",
  "dist/github/actions-change-executor.js",
  "dist/github/actions-change-executor.js.map",
  "dist/github/errors.d.ts",
  "dist/github/errors.js",
  "dist/github/errors.js.map",
  "dist/github/issuer-authority.d.ts",
  "dist/github/issuer-authority.js",
  "dist/github/issuer-authority.js.map",
  "dist/github/index.d.ts",
  "dist/github/index.js",
  "dist/github/index.js.map",
  "dist/github/transport.d.ts",
  "dist/github/transport.js",
  "dist/github/transport.js.map",
  "dist/github/types.d.ts",
  "dist/github/types.js",
  "dist/github/types.js.map",
  "dist/governance.d.ts",
  "dist/governance.js",
  "dist/governance.js.map",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/index.js.map",
  "dist/issuer-identity.d.ts",
  "dist/issuer-identity.js",
  "dist/issuer-identity.js.map",
  "dist/pr-policy.d.ts",
  "dist/pr-policy.js",
  "dist/pr-policy.js.map",
  "dist/pr-sync-input.d.ts",
  "dist/pr-sync-input.js",
  "dist/pr-sync-input.js.map",
  "dist/pull-request-template.d.ts",
  "dist/pull-request-template.js",
  "dist/pull-request-template.js.map",
  "dist/reconciliation.d.ts",
  "dist/reconciliation.js",
  "dist/reconciliation.js.map",
  "dist/semantic-template.d.ts",
  "dist/semantic-template.js",
  "dist/semantic-template.js.map",
  "dist/skill.d.ts",
  "dist/skill.js",
  "dist/skill.js.map",
  "dist/template-discovery.d.ts",
  "dist/template-discovery.js",
  "dist/template-discovery.js.map",
  "dist/template-resolver.d.ts",
  "dist/template-resolver.js",
  "dist/template-resolver.js.map",
];

const CODEX_MARKETPLACE_NAME = "gh-inari";
const CODEX_PLUGIN_NAME = "inari";
const CODEX_PLUGIN_SKILL_PATH = "skills/inari";
const NPM_REGISTRY = "https://registry.npmjs.org";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  return result;
}

// Walks every shape the "exports" map can take: a direct string target, an
// array of fallback targets, or a conditions object whose values may
// themselves be any of these (nested conditions such as node/import/require).
function collectExportsTargets(value, targets) {
  if (typeof value === "string") {
    targets.push(value.replace(/^\.\//u, ""));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectExportsTargets(entry, targets);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) collectExportsTargets(entry, targets);
  }
}

export function exportsTargetPaths(packageJson) {
  const targets = [];
  collectExportsTargets(packageJson.exports, targets);
  return targets;
}

export function validateCodexPluginMetadata(packageJson, manifest, marketplace) {
  if (packageJson.name !== "gh-inari") {
    throw new Error(`package.json name must be "gh-inari", got "${packageJson.name}"`);
  }
  if (manifest.name !== CODEX_PLUGIN_NAME) {
    throw new Error(`.codex-plugin/plugin.json name must be "${CODEX_PLUGIN_NAME}", got "${manifest.name}"`);
  }
  if (manifest.version !== packageJson.version) {
    throw new Error(
      `.codex-plugin/plugin.json version "${manifest.version}" does not match package.json version "${packageJson.version}"`,
    );
  }
  if (manifest.skills !== CODEX_PLUGIN_SKILL_PATH) {
    throw new Error(
      `.codex-plugin/plugin.json skills path must be "${CODEX_PLUGIN_SKILL_PATH}", got "${manifest.skills}"`,
    );
  }

  if (marketplace.name !== CODEX_MARKETPLACE_NAME) {
    throw new Error(`marketplace name must be "${CODEX_MARKETPLACE_NAME}", got "${marketplace.name}"`);
  }
  if (marketplace.interface?.displayName !== "Inari") {
    throw new Error('marketplace interface.displayName must be "Inari"');
  }
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) {
    throw new Error("marketplace must contain exactly one plugin entry");
  }

  const [plugin] = marketplace.plugins;
  if (plugin.name !== manifest.name) {
    throw new Error(`marketplace plugin name "${plugin.name}" does not match manifest name "${manifest.name}"`);
  }
  if (plugin.source?.source !== "npm") {
    throw new Error('marketplace plugin source.source must be "npm"');
  }
  if (plugin.source.package !== packageJson.name) {
    throw new Error(
      `marketplace npm package "${plugin.source.package}" does not match package.json name "${packageJson.name}"`,
    );
  }
  if (plugin.source.version !== `^${packageJson.version}`) {
    throw new Error(
      `marketplace npm version "${plugin.source.version}" must explicitly target compatible ${packageJson.version} releases`,
    );
  }
  if (plugin.source.registry !== NPM_REGISTRY) {
    throw new Error(`marketplace npm registry must be "${NPM_REGISTRY}"`);
  }
  if (plugin.policy?.installation !== "AVAILABLE") {
    throw new Error('marketplace policy.installation must be "AVAILABLE"');
  }
  if (plugin.policy?.authentication !== "ON_INSTALL") {
    throw new Error('marketplace policy.authentication must be "ON_INSTALL"');
  }
  if (typeof plugin.category !== "string" || plugin.category.length === 0) {
    throw new Error("marketplace plugin category must be a non-empty string");
  }
}

// Validates the repo marketplace -> npm package -> Codex Plugin manifest ->
// Skill distribution contract, confirms the declared Skill path resolves
// inside the package and is included in the packed tarball, and confirms the
// Skill routes to `inari skill` rather than duplicating the scenario
// playbooks it must stay thin against. Imports `dist/skill.js` (not
// `src/skill.ts`) so this check runs against the same build the tarball ships.
export async function validateCodexPlugin(packageJson, packedFiles) {
  const manifestPath = path.join(repoRoot, ".codex-plugin", "plugin.json");
  if (!fs.existsSync(manifestPath)) throw new Error(".codex-plugin/plugin.json is missing");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const marketplacePath = path.join(repoRoot, ".agents", "plugins", "marketplace.json");
  if (!fs.existsSync(marketplacePath)) throw new Error(".agents/plugins/marketplace.json is missing");
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  validateCodexPluginMetadata(packageJson, manifest, marketplace);

  const { SKILL_SCENARIOS } = await import(path.join(repoRoot, "dist", "skill.js"));

  const skillPath = manifest.skills;
  const skillFile = path.join(repoRoot, skillPath, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    throw new Error(`Codex plugin skill path "${skillPath}" does not resolve to a SKILL.md`);
  }
  const skillPackedPath = path.relative(repoRoot, skillFile).split(path.sep).join("/");
  if (!packedFiles.includes(skillPackedPath)) {
    throw new Error(`"${skillPackedPath}" is declared by the plugin manifest but not packed in the tarball`);
  }

  const body = fs.readFileSync(skillFile, "utf8");
  if (!body.includes("inari skill")) {
    throw new Error(`${skillPath}/SKILL.md must route agents to \`inari skill\` instead of duplicating playbooks`);
  }
  for (const scenario of SKILL_SCENARIOS) {
    // Match `inari skill <scenario-id>` regardless of Markdown formatting (backticks, code fences, plain text).
    // Use word boundaries to avoid partial-word false matches.
    const pattern = new RegExp(`\\binari\\s+skill\\s+${scenario.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (pattern.test(body)) {
      throw new Error(
        `${skillPath}/SKILL.md must not hard-code scenario "${scenario.id}"; route via \`inari skill\` only`,
      );
    }
  }
}

async function main() {
  const distEntry = path.join(repoRoot, "dist", "index.js");
  if (!fs.existsSync(distEntry)) throw new Error("dist is missing; run pnpm run build before the package suite");

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  const packResult = run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  const [packInfo] = JSON.parse(packResult.stdout);
  const packedFiles = packInfo.files.map((entry) => entry.path);
  const expected = [...EXPECTED_PACKED_FILES].sort();
  const actual = [...packedFiles].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`packed file set mismatch:\nexpected:\n${expected.join("\n")}\nactual:\n${actual.join("\n")}`);
  }

  // Every "exports" map target must ship inside the packed tarball: an entry
  // pointing at a file the manifest doesn't carry would break consumers at
  // resolution time even though `npm pack` and `test:package` file-set checks
  // pass independently of each other.
  const exportTargets = exportsTargetPaths(packageJson);
  if (exportTargets.length === 0) throw new Error('package.json "exports" map is empty or missing');
  for (const target of exportTargets) {
    if (!packedFiles.includes(target)) {
      throw new Error(`exports map target "${target}" is not included in the packed tarball`);
    }
    if (!fs.existsSync(path.join(repoRoot, target))) {
      throw new Error(`exports map target "${target}" does not exist in the built dist output`);
    }
  }

  const executableBinPaths = ["gh-inari", ...Object.values(packageJson.bin ?? {})];
  for (const binPath of executableBinPaths) {
    if (!packedFiles.includes(binPath)) {
      throw new Error(`bin entry "${binPath}" is not included in the packed tarball`);
    }
    const stat = fs.statSync(path.join(repoRoot, binPath));
    const isExecutableByOwner = (stat.mode & 0o100) !== 0;
    if (!isExecutableByOwner) {
      throw new Error(`bin entry "${binPath}" is not executable (chmod +x it, or check build step file perms)`);
    }
  }

  await validateCodexPlugin(packageJson, packedFiles);

  console.log(
    `package contents verified: ${packedFiles.length} file(s), ${exportTargets.length} export target(s), all bin targets present and executable.`,
  );

  run(process.execPath, ["scripts/smoke-test.mjs"], { stdio: "inherit" });
}

if (process.argv[1]?.endsWith("run-package-suite.mjs")) main();
