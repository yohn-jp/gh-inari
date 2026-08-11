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

function main() {
  const distEntry = path.join(repoRoot, "dist", "index.js");
  if (!fs.existsSync(distEntry)) throw new Error("dist is missing; run pnpm run build before the package suite");

  const packResult = run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  const [packInfo] = JSON.parse(packResult.stdout);
  const packedFiles = packInfo.files.map((entry) => entry.path);
  const expected = [...EXPECTED_PACKED_FILES].sort();
  const actual = [...packedFiles].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`packed file set mismatch:\nexpected:\n${expected.join("\n")}\nactual:\n${actual.join("\n")}`);
  }

  const executableBinPaths = [
    "gh-inari",
    ...Object.values(JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).bin ?? {}),
  ];
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

  console.log(`package contents verified: ${packedFiles.length} file(s), all bin targets present and executable.`);

  run(process.execPath, ["scripts/smoke-test.mjs"], { stdio: "inherit" });
}

main();
