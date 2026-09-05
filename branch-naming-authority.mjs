// Compatibility entrypoint retained for existing package consumers. Branch
// semantics are implemented by the compiled Inari Core module.
import { existsSync } from "node:fs";

const authority = await import(
  existsSync(new URL("./dist/branch-governance.js", import.meta.url))
    ? "./dist/branch-governance.js"
    : "./src/branch-governance.ts"
);

export const {
  DEFAULT_BRANCH_GOVERNANCE,
  DEFAULT_BRANCH_PATTERN,
  DEFAULT_RELEASE_BRANCH_PATTERN,
  classifyBranchName,
  deriveBranchName,
  effectiveBranchGovernance,
  parseCanonicalChangeBranchName,
  validateBranchName,
} = authority;
