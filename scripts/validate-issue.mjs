#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateExistingIssueArtifact } from "../src/artifact.ts";
import { compileLocalGovernedContract, compileLocalIssueFormContracts } from "../src/governance.ts";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Validate a GitHub Issue event through Inari's compiled Issue Form contract.
 *
 * GitHub does not include the selected Issue Form path in the event payload.
 * When no selector is supplied, every repository-native form is compiled by
 * the same compiler and the body is matched against those contracts. An
 * ambiguous match fails closed; no body-length or label rule is maintained
 * here.
 */
export async function validateIssue({ body, root = REPOSITORY_ROOT, template, contract }) {
  const candidates = await candidateContracts({ root, template, contract });
  const outcomes = candidates.map((candidate) => ({
    contract: candidate,
    result: validateExistingIssueArtifact(candidate, body),
  }));
  const valid = outcomes.filter((outcome) => outcome.result.valid);
  if (valid.length === 1) return report(valid[0]);
  if (valid.length > 1) {
    return report({
      contract: valid[0].contract,
      result: {
        valid: false,
        classification: "wrong-template",
        parse: { parsed: false, values: {}, diagnostics: [] },
        violations: [
          {
            code: "GOVERNANCE_TEMPLATE_AMBIGUOUS",
            path: "$.template",
            message: "Issue body matches more than one repository-native Issue Form.",
          },
        ],
      },
    });
  }

  const selected = selectBestInvalidOutcome(outcomes);
  if (selected === undefined) {
    return {
      valid: false,
      contract: undefined,
      result: undefined,
      violations: [
        {
          code: "GOVERNANCE_TEMPLATE_UNAVAILABLE",
          path: "$.template",
          message: "No repository-native Issue Form is available for validation.",
        },
      ],
      errors: ["No repository-native Issue Form is available for validation."],
    };
  }
  return report(selected);
}

async function candidateContracts({ root, template, contract }) {
  if (contract !== undefined) return [contract];
  if (template !== undefined) return [await compileLocalGovernedContract("issue", root, template)];
  return compileLocalIssueFormContracts(root);
}

function selectBestInvalidOutcome(outcomes) {
  return [...outcomes].sort((left, right) => {
    const leftParsed = left.result.parse.parsed ? 0 : 1;
    const rightParsed = right.result.parse.parsed ? 0 : 1;
    if (leftParsed !== rightParsed) return leftParsed - rightParsed;
    const leftCount = left.result.violations.length;
    const rightCount = right.result.violations.length;
    if (leftCount !== rightCount) return leftCount - rightCount;
    return left.contract.templateIdentity.id.localeCompare(right.contract.templateIdentity.id);
  })[0];
}

function report(outcome) {
  return {
    valid: outcome.result.valid,
    contract: outcome.contract,
    result: outcome.result,
    violations: [...outcome.result.violations],
    errors: outcome.result.violations.map((violation) => violation.message),
  };
}

async function main() {
  const eventPathArgIndex = process.argv.indexOf("--event");
  if (eventPathArgIndex === -1) throw new Error("--event <path-to-github-event-json> is required");
  const eventPath = process.argv[eventPathArgIndex + 1];
  if (eventPath === undefined) throw new Error("--event requires a path");
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const issue = event.issue;
  if (!issue) throw new Error("event has no issue");

  const template = optionValue("--template");
  const report = await validateIssue({
    body: issue.body ?? "",
    root: process.cwd(),
    ...(template === undefined ? {} : { template }),
  });
  const output = {
    valid: report.valid,
    ...(report.contract === undefined ? {} : { template: report.contract.templateIdentity }),
    ...(report.result === undefined ? {} : { classification: report.result.classification }),
    violations: report.violations,
  };
  console.log(JSON.stringify(output));
  if (!report.valid) {
    const reportPath = optionValue("--report");
    const markdown = [
      "Issue governance contract violation:",
      "",
      ...report.violations.map((violation) => `- [${violation.code}] ${violation.path}: ${violation.message}`),
    ].join("\n");
    if (reportPath !== undefined) fs.writeFileSync(reportPath, `${markdown}\n`);
    process.exitCode = 1;
  }
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    const violation = {
      code: typeof error?.code === "string" ? error.code : "GOVERNANCE_VALIDATION_FAILED",
      path: typeof error?.path === "string" ? error.path : "$",
      message: error instanceof Error ? error.message : String(error),
    };
    const reportPath = optionValue("--report");
    if (reportPath !== undefined) {
      fs.writeFileSync(
        reportPath,
        `Issue governance contract violation:\n\n- [${violation.code}] ${violation.path}: ${violation.message}\n`,
      );
    }
    console.error(JSON.stringify({ valid: false, violations: [violation] }));
    process.exitCode = 1;
  });
}
