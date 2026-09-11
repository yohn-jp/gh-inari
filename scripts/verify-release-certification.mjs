#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseCertification } from "../dist/release-certification.js";

const USAGE =
  "usage: node scripts/verify-release-certification.mjs --source-sha <sha> --package-name <name> " +
  "--package-version <version> --tarball-sha256 sha256:<digest> --packed-evidence <file> --dogfood-evidence <file>";
const OPTION_NAMES = new Set([
  "--source-sha",
  "--package-name",
  "--package-version",
  "--tarball-sha256",
  "--packed-evidence",
  "--dogfood-evidence",
]);

function parseArgs(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const key = argumentsList[index];
    if (key === "--help") {
      console.log(USAGE);
      process.exit(0);
    }
    if (!key?.startsWith("--") || index + 1 >= argumentsList.length || argumentsList[index + 1]?.startsWith("--")) {
      throw new Error(USAGE);
    }
    if (!OPTION_NAMES.has(key)) throw new Error(`unknown option: ${key}`);
    if (values.has(key)) throw new Error(`duplicate option: ${key}`);
    values.set(key, argumentsList[index + 1]);
    index += 1;
  }
  return {
    sourceSha: values.get("--source-sha"),
    packageName: values.get("--package-name"),
    packageVersion: values.get("--package-version"),
    tarballSha256: values.get("--tarball-sha256"),
    packedEvidence: values.get("--packed-evidence"),
    dogfoodEvidence: values.get("--dogfood-evidence"),
  };
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (error) {
    throw new Error(`${label} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const required = Object.entries(options);
  const missing = required.filter(([, value]) => typeof value !== "string" || value.length === 0).map(([key]) => key);
  if (missing.length > 0) throw new Error(`${USAGE}; missing: ${missing.join(", ")}`);

  const result = verifyReleaseCertification({
    expectedReleaseSourceCommitSha: options.sourceSha,
    expectedPackageName: options.packageName,
    expectedPackageVersion: options.packageVersion,
    expectedTarballSha256: options.tarballSha256,
    packedEvidence: readJson(options.packedEvidence, "packed evidence"),
    dogfoodEvidence: readJson(options.dogfoodEvidence, "dogfood evidence"),
  });
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`release certification verifier failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

export { parseArgs };
