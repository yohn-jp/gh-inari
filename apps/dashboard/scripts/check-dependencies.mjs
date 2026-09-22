#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const defaultSourceDirectory = path.join(repositoryRoot, "apps/dashboard/src");
const allowedRootModules = new Set(["src/endpoint-api", "src/endpoint-onboarding", "src/endpoint-read-query"]);
const frameworkPackagePattern = /^(?:react|react-dom|vue|svelte|solid-js|@angular\/|@preact\/)/u;

function sourceFiles(directory) {
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(entryPath));
    else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/u.test(entry.name)) files.push(entryPath);
  }
  return files;
}

function importSpecifiers(source) {
  const result = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) result.push({ specifier: match[1], index: match.index ?? 0 });
  }
  return result.sort((left, right) => left.index - right.index || left.specifier.localeCompare(right.specifier));
}

function rootModuleName(filePath, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const resolved = path.resolve(path.dirname(filePath), specifier);
  const relative = path.relative(repositoryRoot, resolved).split(path.sep).join("/");
  if (!relative.startsWith("src/")) return undefined;
  return relative.replace(/\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/u, "");
}

function violation(filePath, specifier, reason) {
  return {
    file: path.relative(repositoryRoot, filePath).split(path.sep).join("/"),
    specifier,
    reason,
  };
}

export function findDashboardDependencyViolations(sourceDirectory = defaultSourceDirectory) {
  const violations = [];
  for (const filePath of sourceFiles(sourceDirectory)) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const { specifier } of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) {
        if (frameworkPackagePattern.test(specifier)) {
          violations.push(violation(filePath, specifier, "frontend framework imports are not allowed"));
        }
        continue;
      }
      const moduleName = rootModuleName(filePath, specifier);
      if (moduleName === undefined) continue;
      if (!allowedRootModules.has(moduleName)) {
        violations.push(violation(filePath, specifier, "root-domain implementation imports are not allowed"));
      }
    }
  }
  return violations.sort((left, right) =>
    `${left.file}\u0000${left.specifier}`.localeCompare(`${right.file}\u0000${right.specifier}`),
  );
}

export function assertDashboardDependencies(sourceDirectory = defaultSourceDirectory) {
  const violations = findDashboardDependencyViolations(sourceDirectory);
  if (violations.length === 0) return;
  const details = violations.map((entry) => `- ${entry.file}: ${entry.specifier} (${entry.reason})`).join("\n");
  throw new Error(`Dashboard dependency boundary violations:\n${details}`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertDashboardDependencies();
  process.stdout.write("Dashboard dependency boundary verified.\n");
}
