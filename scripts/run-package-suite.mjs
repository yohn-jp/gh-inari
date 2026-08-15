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
  "dist/artifact.d.ts",
  "dist/artifact.js",
  "dist/artifact.js.map",
  "dist/cli.d.ts",
  "dist/cli.js",
  "dist/cli.js.map",
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
  "dist/contract/schema.d.ts",
  "dist/contract/schema.js",
  "dist/contract/schema.js.map",
  "dist/contract/validation.d.ts",
  "dist/contract/validation.js",
  "dist/contract/validation.js.map",
  "dist/github.d.ts",
  "dist/github.js",
  "dist/github.js.map",
  "dist/github/adapter.d.ts",
  "dist/github/adapter.js",
  "dist/github/adapter.js.map",
  "dist/github/capability.d.ts",
  "dist/github/capability.js",
  "dist/github/capability.js.map",
  "dist/github/errors.d.ts",
  "dist/github/errors.js",
  "dist/github/errors.js.map",
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
  "dist/pr-policy.d.ts",
  "dist/pr-policy.js",
  "dist/pr-policy.js.map",
  "dist/pull-request-template.d.ts",
  "dist/pull-request-template.js",
  "dist/pull-request-template.js.map",
  "dist/semantic-template.d.ts",
  "dist/semantic-template.js",
  "dist/semantic-template.js.map",
  "dist/template-discovery.d.ts",
  "dist/template-discovery.js",
  "dist/template-discovery.js.map",
];

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

function main() {
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

  console.log(
    `package contents verified: ${packedFiles.length} file(s), ${exportTargets.length} export target(s), all bin targets present and executable.`,
  );

  run(process.execPath, ["scripts/smoke-test.mjs"], { stdio: "inherit" });
}

if (process.argv[1]?.endsWith("run-package-suite.mjs")) main();
