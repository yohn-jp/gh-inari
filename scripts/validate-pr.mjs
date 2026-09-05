#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateExistingPullRequestArtifact, validateRequiredMetadataString } from "../src/artifact.ts";
import { compileLocalBranchGovernance, compileLocalGovernedContract } from "../src/governance.ts";
import { classifyBranchName } from "../src/branch-governance.ts";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Validate a GitHub pull-request event through Inari's compiled contract.
 *
 * The workflow adapter owns only event plumbing and diagnostic formatting;
 * template parsing, policy compilation, body reconstruction, and semantic
 * validation remain in the product library used by the CLI.
 */
export async function validatePullRequest({ title, body, root = REPOSITORY_ROOT, template, branch, contract }) {
  const branchGovernance = contract?.provenance?.branchGovernance ?? (await compileLocalBranchGovernance(root));
  const branchResult = classifyBranchName(branch, branchGovernance);
  if (!branchResult.valid) {
    return {
      valid: false,
      branchClassification: branchResult.classification,
      ...(branchResult.version === undefined ? {} : { branchVersion: branchResult.version }),
      violations: branchResult.violations,
      errors: branchResult.violations.map((violation) => violation.message),
    };
  }
  const routedTemplate = branchResult.classification === "release" ? "release" : template;
  const compiled = contract ?? (await compileLocalGovernedContract("pr", root, routedTemplate));
  const result = validateExistingPullRequestArtifact(compiled, body);
  const violations = [...result.violations];
  const titleViolation = validateRequiredMetadataString(title, "title");
  if (titleViolation !== undefined) violations.unshift(titleViolation);
  return {
    valid: violations.length === 0,
    contract: compiled,
    branchClassification: branchResult.classification,
    ...(branchResult.version === undefined ? {} : { branchVersion: branchResult.version }),
    result,
    violations,
    errors: violations.map((violation) => violation.message),
  };
}

async function main() {
  const eventPathArgIndex = process.argv.indexOf("--event");
  if (eventPathArgIndex === -1) throw new Error("--event <path-to-github-event-json> is required");
  const eventPath = process.argv[eventPathArgIndex + 1];
  if (eventPath === undefined) throw new Error("--event requires a path");
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const pullRequest = event.pull_request;
  if (!pullRequest) throw new Error("event has no pull_request");

  const template = optionValue("--template");
  const branch = optionValue("--branch") ?? pullRequest.head?.ref;
  const report = await validatePullRequest({
    title: pullRequest.title ?? "",
    body: pullRequest.body ?? "",
    root: process.cwd(),
    ...(template === undefined ? {} : { template }),
    ...(branch === undefined ? {} : { branch }),
  });
  console.log(
    JSON.stringify({
      valid: report.valid,
      ...(report.branchClassification === undefined ? {} : { branchClassification: report.branchClassification }),
      ...(report.branchVersion === undefined ? {} : { branchVersion: report.branchVersion }),
      ...(report.contract === undefined ? {} : { template: report.contract.templateIdentity }),
      ...(report.result === undefined ? {} : { classification: report.result.classification }),
      violations: report.violations,
    }),
  );
  if (!report.valid) process.exitCode = 1;
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
