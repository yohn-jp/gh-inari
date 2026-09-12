#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ACTION_ROOTS = Object.freeze([".github/workflows", ".github/actions"]);
const ISSUE_GOVERNANCE_WORKFLOW = ".github/workflows/issue-governance.yml";
const USES_LINE_PATTERN = /^\s*(?:-\s+)?uses:\s*(.*)$/u;
const VALUE_PATTERN = /^(\S+)(?:\s+#.*)?$/u;
const IMMUTABLE_EXTERNAL_ACTION_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/u;
const ORGANIZATION_WORKFLOW_PREFIX = "yohn-jp/.github/.github/workflows/";
const SHARED_ISSUE_GOVERNANCE_REFERENCE = "yohn-jp/.github/.github/workflows/issue-governance.yml@main";

export function validateActionText(source, filePath = "<text>") {
  const references = [];
  const errors = [];

  source.split(/\r?\n/u).forEach((line, index) => {
    const usesMatch = line.match(USES_LINE_PATTERN);
    if (usesMatch === null) return;

    const lineNumber = index + 1;
    const rawValue = usesMatch[1].trim();
    if (rawValue.length === 0) {
      errors.push(filePath + ":" + lineNumber + ": uses reference must be on the same line");
      return;
    }

    const valueMatch = rawValue.match(VALUE_PATTERN);
    if (valueMatch === null) {
      errors.push(filePath + ":" + lineNumber + ": uses reference is not a single YAML value");
      return;
    }

    const reference = valueMatch[1];
    const local = reference.startsWith("./");
    references.push({ file: filePath, line: lineNumber, reference, local });
    const organizationWorkflow = reference.startsWith(ORGANIZATION_WORKFLOW_PREFIX);
    if (organizationWorkflow && !reference.endsWith("@main")) {
      errors.push(
        filePath +
          ":" +
          lineNumber +
          ": organization-owned reusable workflows under yohn-jp/.github must use @main: " +
          reference,
      );
    } else if (!local && !organizationWorkflow && !IMMUTABLE_EXTERNAL_ACTION_PATTERN.test(reference)) {
      errors.push(
        filePath + ":" + lineNumber + ": external GitHub Action must use a full 40-character commit SHA: " + reference,
      );
    }
  });

  return { references, errors };
}

export function repositoryActionFiles(root) {
  const output = execFileSync("git", ["ls-files", "--", ...ACTION_ROOTS], {
    cwd: path.resolve(root),
    encoding: "utf8",
  });
  return output.split(/\r?\n/u).filter(Boolean);
}

export function validateIssueGovernanceWorkflow(source, filePath = ISSUE_GOVERNANCE_WORKFLOW) {
  const errors = [];
  if (!/^\s+issues:\s*(?:\[|$)/mu.test(source)) {
    errors.push(filePath + ": missing issues event trigger");
  }
  if (!source.includes("uses: " + SHARED_ISSUE_GOVERNANCE_REFERENCE)) {
    errors.push(filePath + ": must delegate Issue governance to " + SHARED_ISSUE_GOVERNANCE_REFERENCE);
  }
  if (/scripts\/validate-issue\.mjs/u.test(source)) {
    errors.push(filePath + ": must not duplicate gh-inari Issue semantic validation locally");
  }
  return { errors };
}

export function validateRepositoryActions(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  const resolvedRoot = path.resolve(root);
  const files = repositoryActionFiles(resolvedRoot);
  const references = [];
  const errors = [];

  for (const file of files) {
    const source = fs.readFileSync(path.join(resolvedRoot, file), "utf8");
    const result = validateActionText(source, file);
    references.push(...result.references);
    errors.push(...result.errors);
    if (file === ISSUE_GOVERNANCE_WORKFLOW) {
      errors.push(...validateIssueGovernanceWorkflow(source, file).errors);
    }
  }

  return { root: resolvedRoot, files, references, errors };
}

function runAsCommand() {
  const result = validateRepositoryActions();
  if (result.errors.length > 0) {
    console.error("GitHub Action pin validation failed");
    for (const error of result.errors) console.error("- " + error);
    process.exitCode = 1;
    return;
  }

  const externalCount = result.references.filter((reference) => !reference.local).length;
  const localCount = result.references.filter((reference) => reference.local).length;
  console.log(
    "GitHub Action pin validation passed: " +
      externalCount +
      " external reference(s), " +
      localCount +
      " local reference(s).",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runAsCommand();
}
