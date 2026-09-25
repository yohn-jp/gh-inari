# Repository branch policy

Status: foundation for Source #1100 (Implementation #1111). Consumer migration: #1112 (local Session/Admission/setup) and #1113 (Change/provider, see below).

Ordinary Change/Implementation branch spelling is governed by the target repository, not by a product-wide convention. Branch spelling is naming evidence only: it never establishes parentage, authorization, GitHub permissions, or branch protection.

## Policy source

The policy is the existing PR policy `branch` rule (`.github/inari/pr-policy.yml`, or `.inari/pr-policy.yml`), read from the repository's provider-resolved default branch. There is no second policy file.

```yaml
version: 1
sections: []
branch:
  pattern: "^(story|bug)/[0-9]+-[a-z0-9-]+$" # required; validates supplied names
  format: "{type}/{issueNumber}-{slug}" # optional; bounded derivation
  types: [story, bug] # required only when format uses {type}
```

- `pattern` validates supplied names. It is never inverted into a generated name.
- `format` is the only way policy generates a name. Literals use `[A-Za-z0-9._/-]`. Placeholders are `{issueNumber}` (required, once), `{slug}` and `{type}` (each at most once). `{type}` requires a closed `types` list, and `types` requires `{type}`.
- `format` and `types` are additive. Historical records that carry only `pattern` keep their meaning.

## Public API

`src/repository-branch-policy.ts` (pure Core):

| Symbol                                                                                    | Purpose                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RepositoryBranchPolicy` (`version: 1`, `kind: "repository-branch-policy"`)               | Rule bound to `generation` (repository, default-branch `ref`, `treeSha`, policy source fingerprint) and `defaultBranch` (equal to `generation.ref`). |
| `createRepositoryBranchPolicy({ generation, rule? })`                                     | Validates a generation and rule. Returns `{ status: "available", policy }` or a `denied` result.                                                     |
| `validateRepositoryBranchPolicyRule(rule)`                                                | Validates a rule through the canonical PR policy parser.                                                                                             |
| `resolveImplementationBranch({ policy, target, binding?, naming?, observedGeneration? })` | Resolves the branch for one Implementation. It uses the exact binding first, then the bounded `format`.                                              |
| `evaluateRepositoryBranch({ policy, target, branch, binding?, observedGeneration? })`     | Checks a supplied branch against the exact binding, or against the pattern and the format for this Implementation number.                            |
| `ImplementationBranchBinding`                                                             | Exact expected-branch evidence: `{ repository: { repositoryHost, repositoryId }, implementation, branch }`.                                          |
| `RepositoryBranchDecision`                                                                | `bound` (with versioned `RepositoryBranchEvidence`), `action-required`, or `denied`.                                                                 |
| `RESERVED_BRANCH_NAMESPACES`                                                              | `epic/`, `issue/`, `release/`. These are never ordinary Change branches.                                                                             |

`src/governance.ts`: `acquireRepositoryBranchPolicy(adapter)` reads the default-branch generation and the PR policy. It returns an `available` policy (with or without a rule) or a `BRANCH_POLICY_INVALID` denial. Source acquisition failures still throw `GovernanceError`.

`src/branch-naming.ts` (formatter grammar): `validateBranchFormatRule`, `renderBranchFormat`, `matchBranchFormat`, `validateBranchSpelling`, `normalizeBranchSlug`, and `LEGACY_CHANGE_BRANCH_RULE`.

### Decision outcomes

| Status            | Code                             | Meaning                                                                                                                 |
| ----------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `action-required` | `BRANCH_POLICY_MISSING`          | No rule and no exact binding. Supply the exact branch or declare a rule.                                                |
| `action-required` | `BRANCH_POLICY_NOT_DERIVABLE`    | The rule has only a pattern, or the supplied name is not this Implementation's formatted name. Supply the exact branch. |
| `action-required` | `BRANCH_NAMING_INPUT_REQUIRED`   | The format needs `slug` or `type` input that was not supplied.                                                          |
| `denied`          | `BRANCH_POLICY_INVALID`          | The rule, generation, version, or default-branch binding is malformed.                                                  |
| `denied`          | `BRANCH_POLICY_STALE`            | `observedGeneration` differs from the policy generation.                                                                |
| `denied`          | `BRANCH_REPOSITORY_UNBOUND`      | The policy has no repository ID, or the target identity is missing.                                                     |
| `denied`          | `BRANCH_REPOSITORY_MISMATCH`     | The policy, target, or binding repository differs.                                                                      |
| `denied`          | `BRANCH_IMPLEMENTATION_MISMATCH` | The binding is for a different Implementation.                                                                          |
| `denied`          | `BRANCH_BINDING_MISMATCH`        | The supplied branch is not the exact bound branch.                                                                      |
| `denied`          | `BRANCH_NAME_INVALID`            | The name is not safe Git branch spelling.                                                                               |
| `denied`          | `BRANCH_NAME_RESERVED`           | The name is the default branch or in a reserved namespace.                                                              |
| `denied`          | `BRANCH_NAMING_INVALID`          | The `slug` or `type` input is malformed or outside `types`.                                                             |
| `denied`          | `BRANCH_POLICY_MISMATCH`         | The declared pattern rejects the name.                                                                                  |

## Legacy compatibility adapters

These keep their signatures and behavior for historical contracts, signed records, and reserved routing. They are not the rule for new ordinary Change naming.

- `src/branch-naming.ts`: `CANONICAL_BRANCH_TYPES`, `BRANCH_TYPES`, `DEFAULT_BRANCH_NAME`, `validateBranchName`, `recognizeBranchName`, `recognizeBranchNamingForIssue`, `branchBelongsToRootIssue`, `deriveBranchNamingFromIssueTitle`, `deriveNamingFromIssueTitle`, `deriveBranchName`, `deriveCanonicalBranchName`, `recognizeCanonicalBranchName`, and the integration helpers (`recognizeIntegrationBranchName`, `deriveIssueIntegrationBranchName`, `deriveEpicIntegrationBranchName`, and their aliases).
- `LEGACY_CHANGE_BRANCH_RULE` expresses the historical `<feat|fix|docs|refactor|test|chore>/<issue>-<slug>` convention as a policy rule. It applies only when a caller passes it explicitly.
- `src/governance.ts`: `resolveRepositoryBranchGovernance` returns only the bare rule.

## Change and provider propagation (#1113)

New Implementation-native execution consumes the exact admitted branch end to end. Provider adapters and capability records check only repository-neutral safe spelling (`validateBranchSpelling`) plus exact equality to the authorized subject; they are not a second naming authority.

- `GitHubChangeStateProjector` acquires the policy through the existing governance reader (`acquireRepositoryBranchPolicy`) for an Implementation Issue and resolves its exact branch with `resolveImplementationBranch` (exact contract binding first). It threads the resulting `RepositoryBranchEvidence` into Core projection as `branchEvidence`, with the provider-resolved default branch as `baseBranch`. A denial, a foreign contract repository, or a policy generation whose default branch differs from the provider default fails closed. Without exact evidence (non-Implementation Issue, or action-required policy), the historical title-derived path applies unchanged.
- `projectChangeFromGitHubEvidence` accepts `branchEvidence` in place of `naming`/`branchGovernance` (they are mutually exclusive). It re-evaluates the evidence through `evaluateRepositoryBranch` against the Change repository and root Implementation and requires `baseBranch` to equal the evidence default branch. `deriveCanonicalBranchIdentity` remains only for legacy callers without policy evidence.
- `capability.ts`: `branch.create.branch`, `branch.advance.branch`, and `pullRequest.create.head` are exact safe targets; `pullRequest.create.base` is a safe provider branch and may be a non-`main` default branch. `capability-provenance.ts` applies the same safe-spelling rule to branch/head/base subjects.
- `branch-advance.ts` and `git-data-capability.ts` validate safe spelling. Branch advance refuses the authoritative default branch (the Runtime Authority policy ref) and the Implementation base branch; exact admission binding, compare-and-swap, path scope, and provenance are unchanged.
- `implementation-change-identity.ts` accepts a safe, non-reserved Implementation branch that differs from its base and equals the contract, Change projection, Session capability, and execution evidence.
- `integration-routing.ts`: ordinary Implementation heads and the default branch are exact governed evidence (safe spelling, outside `epic/`, `issue/`, `release/`, not the default/base branch). A name the historical convention recognizes must still name the Implementation. Reserved `epic/` and `issue/` routing keeps its canonical grammar. An already-projected route re-validates to itself.

`test/repository-branch-policy-certification.test.mjs` certifies an alternative convention (`story/<n>-<slug>`) on a `trunk` default through Session → Admission → Executor → PR publication and branch advance, and proves that wrong repository, Implementation, branch, and stale generation fail before any provider mutation.

## Caller inventory

This inventory comes from targeted symbol references at base `18fb72ef`. P1 callers belong to #1112 and P2 callers to #1113. Other callers are reserved routing or historical-record paths and stay on the legacy adapters.

| Caller                                                                                               | Legacy symbols used                                                                                                                  | Owner                                                                     |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `src/local-control/session-launcher.ts:210-213`                                                      | `recognizeBranchName`, `CANONICAL_BRANCH_TYPES`                                                                                      | P1 #1112                                                                  |
| `src/local-application-state.ts:113,189-202`                                                         | `CANONICAL_BRANCH_TYPES` (setup display pattern), `recognizeBranchName`, `DEFAULT_BRANCH_NAME`                                       | P1 #1112                                                                  |
| `src/change.ts:1643` (canonical branch derivation)                                                   | `deriveBranchName` plus pattern-only `branchGovernance`                                                                              | #1113: legacy only; `branchEvidence` for new execution                    |
| `src/github/change-state-projector.ts:136,226,281,741`                                               | `deriveBranchNamingFromIssueTitle`, `recognizeBranchNamingForIssue`, `branchBelongsToRootIssue`, `resolveRepositoryBranchGovernance` | #1113: legacy only; policy evidence for Implementations                   |
| `src/hosted-endpoint-work-reader.ts:199`                                                             | `resolveRepositoryBranchGovernance`                                                                                                  | P2 #1113                                                                  |
| `src/semantic-branch-projection.ts:460`                                                              | comment only (does not derive)                                                                                                       | none                                                                      |
| `src/branch-creation-ruleset.ts:56,61`                                                               | `CANONICAL_BRANCH_TYPES`, `DEFAULT_BRANCH_NAME` (gh-inari's own ruleset)                                                             | retained (repository's own convention)                                    |
| `src/release-pr-publication.ts:21`                                                                   | `DEFAULT_BRANCH_NAME`                                                                                                                | retained (release routing)                                                |
| `src/integration-routing.ts:210,228,382,628`                                                         | `validateBranchName`, `recognizeBranchName`, `DEFAULT_BRANCH_NAME`                                                                   | #1113: reserved `epic/`/`issue/` routing and absent-default fallback only |
| `src/implementation-contract.ts:813,824`                                                             | `validateBranchName` (reserved-namespace checks)                                                                                     | retained                                                                  |
| `src/implementation-change-identity.ts:301,306`                                                      | `validateBranchName`, `recognizeBranchName`                                                                                          | migrated #1113 (safe spelling)                                            |
| `src/agent-authority/branch-advance.ts:222`, `capability.ts:115,119`, `capability-provenance.ts:348` | `validateBranchName`                                                                                                                 | migrated #1113 (safe spelling)                                            |
| `src/legacy-artifact-convergence.ts:490,724`                                                         | `validateBranchName`                                                                                                                 | retained (historical artifacts)                                           |
| `src/github/git-data-capability.ts:432`                                                              | `validateBranchName`                                                                                                                 | migrated #1113 (safe spelling)                                            |
