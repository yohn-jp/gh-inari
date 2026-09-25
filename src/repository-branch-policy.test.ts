import assert from "node:assert/strict";
import { test } from "node:test";
import { LEGACY_CHANGE_BRANCH_RULE, deriveBranchName, deriveBranchNamingFromIssueTitle } from "./branch-naming.js";
import {
  createRepositoryBranchPolicy,
  evaluateRepositoryBranch,
  resolveImplementationBranch,
  type RepositoryBranchPolicy,
  type RepositoryBranchPolicyGeneration,
} from "./repository-branch-policy.js";

const REPOSITORY = { repositoryHost: "github.com", repositoryId: "1001" } as const;
const OTHER_REPOSITORY = { repositoryHost: "github.com", repositoryId: "2002" } as const;
const TARGET = { repository: REPOSITORY, implementation: 77 } as const;

function generation(overrides: Partial<RepositoryBranchPolicyGeneration> = {}): RepositoryBranchPolicyGeneration {
  return {
    authority: "repository-default-branch",
    repository: {
      host: "github.com",
      owner: "acme",
      name: "widgets",
      nameWithOwner: "acme/widgets",
      repositoryId: "1001",
    },
    ref: "trunk",
    treeSha: "tree-1",
    ...overrides,
  };
}

function policy(rule?: unknown, overrides: Partial<RepositoryBranchPolicyGeneration> = {}): RepositoryBranchPolicy {
  const acquired = createRepositoryBranchPolicy({
    generation: generation(overrides),
    ...(rule === undefined ? {} : { rule }),
  });
  assert.equal(acquired.status, "available", JSON.stringify(acquired));
  return (acquired as { policy: RepositoryBranchPolicy }).policy;
}

const ALTERNATIVE_RULE = { pattern: "^work/impl-[0-9]+$", format: "work/impl-{issueNumber}" } as const;

test("an alternative convention and non-main default branch derive and bind without product hardcoding", () => {
  const altPolicy = policy(ALTERNATIVE_RULE);
  assert.equal(altPolicy.defaultBranch, "trunk");

  const resolved = resolveImplementationBranch({ policy: altPolicy, target: TARGET });
  assert.equal(resolved.status, "bound");
  assert.equal(resolved.status === "bound" && resolved.branch, "work/impl-77");
  assert.deepEqual(resolved.status === "bound" && resolved.evidence, {
    version: 1,
    kind: "repository-branch-evidence",
    repository: REPOSITORY,
    implementation: 77,
    branch: "work/impl-77",
    source: "policy-format",
    defaultBranch: "trunk",
    generation: { ref: "trunk", treeSha: "tree-1" },
    rule: ALTERNATIVE_RULE,
  });

  const evaluated = evaluateRepositoryBranch({ policy: altPolicy, target: TARGET, branch: "work/impl-77" });
  assert.equal(evaluated.status, "bound");
  // Six-prefix spelling is not privileged by the new API.
  const legacySpelling = evaluateRepositoryBranch({ policy: altPolicy, target: TARGET, branch: "feat/77-add-thing" });
  assert.equal(legacySpelling.status, "denied");
  assert.equal(legacySpelling.status === "denied" && legacySpelling.code, "BRANCH_POLICY_MISMATCH");
  // The format binds the Implementation number; another Implementation's name is not bound.
  const other = evaluateRepositoryBranch({ policy: altPolicy, target: TARGET, branch: "work/impl-78" });
  assert.equal(other.status, "action-required");
});

test("the provider default branch, not main, is refused as an ordinary Change branch", () => {
  const main = policy({ pattern: "^[a-z/-]+$" }, { ref: "main" });
  const trunk = policy({ pattern: "^[a-z/-]+$" });
  const binding = (branch: string) => ({ ...TARGET, branch });
  const onTrunk = resolveImplementationBranch({ policy: trunk, target: TARGET, binding: binding("trunk") });
  assert.equal(onTrunk.status === "denied" && onTrunk.code, "BRANCH_NAME_RESERVED");
  const mainOnTrunk = resolveImplementationBranch({ policy: trunk, target: TARGET, binding: binding("main") });
  assert.equal(mainOnTrunk.status, "bound");
  const onMain = resolveImplementationBranch({ policy: main, target: TARGET, binding: binding("main") });
  assert.equal(onMain.status === "denied" && onMain.code, "BRANCH_NAME_RESERVED");
});

test("an exact Implementation branch binding is preferred and need not encode the Issue number", () => {
  const withFormat = policy({ pattern: "^[a-z0-9/_-]+$", format: "work/impl-{issueNumber}" });
  const binding = { ...TARGET, branch: "team/storage-rewrite" };
  const resolved = resolveImplementationBranch({ policy: withFormat, target: TARGET, binding });
  assert.equal(resolved.status === "bound" && resolved.branch, "team/storage-rewrite");
  assert.equal(resolved.status === "bound" && resolved.evidence.source, "exact-binding");

  // Exact binding works even when the repository declares no rule.
  const noRule = policy();
  const bound = evaluateRepositoryBranch({ policy: noRule, target: TARGET, binding, branch: "team/storage-rewrite" });
  assert.equal(bound.status === "bound" && bound.evidence.source, "exact-binding");
  assert.equal(bound.status === "bound" && "rule" in bound.evidence, false);

  const mismatch = evaluateRepositoryBranch({ policy: noRule, target: TARGET, binding, branch: "team/other" });
  assert.equal(mismatch.status === "denied" && mismatch.code, "BRANCH_BINDING_MISMATCH");

  // A declared pattern still constrains an exact binding.
  const strict = policy({ pattern: "^work/" });
  const outside = resolveImplementationBranch({ policy: strict, target: TARGET, binding });
  assert.equal(outside.status === "denied" && outside.code, "BRANCH_POLICY_MISMATCH");
});

test("repository and Implementation binding stay explicit", () => {
  const altPolicy = policy(ALTERNATIVE_RULE);
  const wrongRepo = resolveImplementationBranch({
    policy: altPolicy,
    target: { repository: OTHER_REPOSITORY, implementation: 77 },
  });
  assert.equal(wrongRepo.status === "denied" && wrongRepo.code, "BRANCH_REPOSITORY_MISMATCH");

  const wrongBindingRepo = resolveImplementationBranch({
    policy: altPolicy,
    target: TARGET,
    binding: { repository: OTHER_REPOSITORY, implementation: 77, branch: "work/impl-77" },
  });
  assert.equal(wrongBindingRepo.status === "denied" && wrongBindingRepo.code, "BRANCH_REPOSITORY_MISMATCH");

  const wrongImplementation = resolveImplementationBranch({
    policy: altPolicy,
    target: TARGET,
    binding: { repository: REPOSITORY, implementation: 78, branch: "work/impl-77" },
  });
  assert.equal(wrongImplementation.status === "denied" && wrongImplementation.code, "BRANCH_IMPLEMENTATION_MISMATCH");

  const { repositoryId: _omitted, ...repositoryWithoutId } = generation().repository;
  const unbound = policy(ALTERNATIVE_RULE, { repository: repositoryWithoutId });
  const unboundResult = resolveImplementationBranch({ policy: unbound, target: TARGET });
  assert.equal(unboundResult.status === "denied" && unboundResult.code, "BRANCH_REPOSITORY_UNBOUND");
});

test("missing, non-derivable, and input-dependent policy return bounded action-required results", () => {
  const missing = resolveImplementationBranch({ policy: policy(), target: TARGET });
  assert.deepEqual(
    { status: missing.status, code: missing.status === "action-required" && missing.code },
    { status: "action-required", code: "BRANCH_POLICY_MISSING" },
  );
  const missingEval = evaluateRepositoryBranch({ policy: policy(), target: TARGET, branch: "feat/77-anything" });
  assert.equal(missingEval.status === "action-required" && missingEval.code, "BRANCH_POLICY_MISSING");

  // Pattern-only policy validates supplied names but is never inverted into a name.
  const patternOnly = policy({ pattern: "^(feat|fix)/[0-9]+-[a-z0-9-]+$" });
  const notDerivable = resolveImplementationBranch({ policy: patternOnly, target: TARGET, naming: { slug: "x" } });
  assert.equal(notDerivable.status === "action-required" && notDerivable.code, "BRANCH_POLICY_NOT_DERIVABLE");
  assert.equal(notDerivable.status === "action-required" && notDerivable.requirement, "exact-branch");
  const supplied = evaluateRepositoryBranch({ policy: patternOnly, target: TARGET, branch: "feat/77-thing" });
  assert.equal(supplied.status === "action-required" && supplied.code, "BRANCH_POLICY_NOT_DERIVABLE");
  const rejected = evaluateRepositoryBranch({ policy: patternOnly, target: TARGET, branch: "docs/77-thing" });
  assert.equal(rejected.status === "denied" && rejected.code, "BRANCH_POLICY_MISMATCH");

  const needsSlug = policy({ pattern: "^u/[0-9]+-[a-z0-9-]+$", format: "u/{issueNumber}-{slug}" });
  const input = resolveImplementationBranch({ policy: needsSlug, target: TARGET });
  assert.equal(input.status === "action-required" && input.code, "BRANCH_NAMING_INPUT_REQUIRED");
  assert.equal(input.status === "action-required" && input.requirement, "naming-input");
  const badSlug = resolveImplementationBranch({ policy: needsSlug, target: TARGET, naming: { slug: "Bad Slug" } });
  assert.equal(badSlug.status === "denied" && badSlug.code, "BRANCH_NAMING_INVALID");
});

test("invalid and stale policy are bounded denials", () => {
  for (const rule of [
    { pattern: "(" },
    { pattern: "^x$", format: "no-number" },
    { pattern: "^x$", format: "{type}/{issueNumber}" },
    { pattern: "^x$", format: "a/{issueNumber}", types: ["feat"] },
    { pattern: "^x$", format: "a b/{issueNumber}" },
    { pattern: "^x$", format: "{issueNumber}/{unknown}" },
    { pattern: "^x$", extra: true },
  ]) {
    const acquired = createRepositoryBranchPolicy({ generation: generation(), rule });
    assert.equal(acquired.status === "denied" && acquired.code, "BRANCH_POLICY_INVALID", JSON.stringify(rule));
  }
  const noGeneration = createRepositoryBranchPolicy({ generation: generation({ treeSha: "" }) });
  assert.equal(noGeneration.status === "denied" && noGeneration.code, "BRANCH_POLICY_INVALID");

  const tampered = { ...policy(ALTERNATIVE_RULE), defaultBranch: "main" };
  const tamperedResult = resolveImplementationBranch({ policy: tampered, target: TARGET });
  assert.equal(tamperedResult.status === "denied" && tamperedResult.code, "BRANCH_POLICY_INVALID");

  const altPolicy = policy(ALTERNATIVE_RULE);
  const stale = resolveImplementationBranch({
    policy: altPolicy,
    target: TARGET,
    observedGeneration: { ref: "trunk", treeSha: "tree-2" },
  });
  assert.equal(stale.status === "denied" && stale.code, "BRANCH_POLICY_STALE");
  const fresh = resolveImplementationBranch({
    policy: altPolicy,
    target: TARGET,
    observedGeneration: { ref: "trunk", treeSha: "tree-1" },
  });
  assert.equal(fresh.status, "bound");
});

test("reserved integration and release namespaces stay outside ordinary Change naming", () => {
  const permissive = policy({ pattern: "^[a-z0-9/._-]+$", format: "issue/{issueNumber}-x" });
  const derived = resolveImplementationBranch({ policy: permissive, target: TARGET });
  assert.equal(derived.status === "denied" && derived.code, "BRANCH_NAME_RESERVED");
  for (const branch of ["epic/1-x", "issue/77-x", "release/1.2.3"]) {
    const result = evaluateRepositoryBranch({
      policy: permissive,
      target: TARGET,
      binding: { ...TARGET, branch },
      branch,
    });
    assert.equal(result.status === "denied" && result.code, "BRANCH_NAME_RESERVED", branch);
  }
  const unsafe = evaluateRepositoryBranch({
    policy: permissive,
    target: TARGET,
    binding: { ...TARGET, branch: "a/../b" },
    branch: "a/../b",
  });
  assert.equal(unsafe.status === "denied" && unsafe.code, "BRANCH_NAME_INVALID");
});

test("the explicit legacy compatibility rule reproduces the historical derivation only when passed", () => {
  const legacy = policy(LEGACY_CHANGE_BRANCH_RULE);
  const naming = deriveBranchNamingFromIssueTitle("refactor: simplify change planning");
  const resolved = resolveImplementationBranch({ policy: legacy, target: TARGET, naming });
  assert.equal(resolved.status === "bound" && resolved.branch, deriveBranchName({ ...naming, issueNumber: 77 }));
  const evaluated = evaluateRepositoryBranch({
    policy: legacy,
    target: TARGET,
    branch: "refactor/77-simplify-change-planning",
  });
  assert.equal(evaluated.status, "bound");
  const wrongType = resolveImplementationBranch({ policy: legacy, target: TARGET, naming: { type: "wip", slug: "x" } });
  assert.equal(wrongType.status === "denied" && wrongType.code, "BRANCH_NAMING_INVALID");
});
