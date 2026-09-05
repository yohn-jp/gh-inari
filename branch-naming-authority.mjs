// Shared executable authority for repository branch naming.
// Consumers validate or assemble names through this module instead of
// reimplementing the repository's branch grammar.

const BRANCH_PATTERN = /^(feat|fix|docs|refactor|test|chore)\/\d+-[a-z0-9-]+$/;
const EXEMPT_BRANCHES = new Set(["main"]);

export function validateBranchName(branch) {
  if (EXEMPT_BRANCHES.has(branch)) return [];
  if (BRANCH_PATTERN.test(branch)) return [];
  return [
    `branch name "${branch}" does not match <type>/<issue-number>-<slug>` +
      ' (e.g. "feat/42-add-init-command"); type must be one of feat, fix, docs, refactor, test, chore',
  ];
}

export function deriveBranchName({ type, issueNumber, slug }) {
  if (typeof type !== "string" || type.length === 0) throw new TypeError("Branch type must be a non-empty string.");
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new TypeError("Branch issue number must be a positive safe integer.");
  }
  if (typeof slug !== "string" || slug.length === 0) throw new TypeError("Branch slug must be a non-empty string.");

  const branch = `${type}/${issueNumber}-${slug}`;
  const errors = validateBranchName(branch);
  if (errors.length > 0) throw new TypeError(errors[0]);
  return branch;
}
