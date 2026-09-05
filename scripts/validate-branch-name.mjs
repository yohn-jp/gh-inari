#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { validateBranchName } from "../branch-naming-authority.mjs";

export { validateBranchName };

function main() {
  const branchArgIndex = process.argv.indexOf("--branch");
  const branch =
    branchArgIndex === -1
      ? execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim()
      : process.argv[branchArgIndex + 1];

  const errors = validateBranchName(branch);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log(`branch name "${branch}" is valid.`);
}

if (process.argv[1]?.endsWith("validate-branch-name.mjs")) main();
