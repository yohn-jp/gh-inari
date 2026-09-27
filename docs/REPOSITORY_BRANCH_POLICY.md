# Repository Branch Policy and Integration Routing

Status: normative naming/routing contract under
[Product Architecture Canon](./ARCHITECTURE.md).

Ordinary branch spelling is governed by the target repository. Spelling is
identity/consistency evidence, never parentage, authorization, provider
permission, or branch protection. Source Change and Implementation task
publication remain separate even when their branches use related conventions.

## 1. Policy source

Use the existing PR policy branch rule in `.github/inari/pr-policy.yml` or
`.inari/pr-policy.yml`, acquired from the provider-resolved default branch.
There is no second branch-policy file.

```yaml
version: 1
sections: []
branch:
  pattern: "^(story|bug)/[0-9]+-[a-z0-9-]+$"
  format: "{type}/{issueNumber}-{slug}"
  types: [story, bug]
```

Pattern validates supplied names; it is never inverted to generate a name.
Format is the explicit bounded derivation. It contains `{issueNumber}` once
and may contain `{slug}` and `{type}` at most once. Type requires the closed
types list and vice versa. Literal characters obey the existing safe format
grammar.

Pattern-only historical policy retains its meaning. Missing derivation does
not justify guessing a type/slug or falling back to a universal convention.

## 2. Pure Core API

`src/repository-branch-policy.ts` owns:

- RepositoryBranchPolicy, version 1 and kind repository-branch-policy;
- createRepositoryBranchPolicy and validateRepositoryBranchPolicyRule;
- resolveImplementationBranch and evaluateRepositoryBranch;
- ImplementationBranchBinding and RepositoryBranchEvidence;
- the bound/action-required/denied decision contract;
- reserved namespaces `epic/`, `issue/`, and `release/`.

The policy binds repository identity, default-branch ref, tree SHA, and source
fingerprint. `defaultBranch` agrees with the generation's ref. An exact
ImplementationBranchBinding names repository, Implementation, and branch.

Resolution uses exact accepted binding first, then admitted format. Evaluation
checks the exact binding or the pattern/format for the specified Implementation.
A name alone cannot establish that it is the correct task branch.

`acquireRepositoryBranchPolicy` in `src/governance.ts` reads the same existing
policy/generation. Acquisition failure remains a GovernanceError; invalid
rule/generation is a bounded denial, not an absent permissive policy.

## 3. Formatter and safe spelling

`src/branch-naming.ts` owns validateBranchFormatRule, renderBranchFormat,
matchBranchFormat, validateBranchSpelling, and normalizeBranchSlug.

Provider adapters validate repository-neutral safe spelling plus equality to
the admitted branch. They do not maintain a second repository naming regex.
A literal such as `main` is not universally special across repositories;
default/base restrictions use actual current evidence.

Reserved namespace grammar remains explicit. Malformed `issue/`, `epic/`, or
`release/` input cannot fall through as an ordinary valid branch merely
because the repository regex is broad.

## 4. Decision diagnostics

Action-required outcomes preserve:

```text
BRANCH_POLICY_MISSING
BRANCH_POLICY_NOT_DERIVABLE
BRANCH_NAMING_INPUT_REQUIRED
```

These require explicit policy/binding or missing allowed naming input. They
are not instructions to invent values.

Denied outcomes preserve:

```text
BRANCH_POLICY_INVALID
BRANCH_POLICY_STALE
BRANCH_REPOSITORY_UNBOUND
BRANCH_REPOSITORY_MISMATCH
BRANCH_IMPLEMENTATION_MISMATCH
BRANCH_BINDING_MISMATCH
BRANCH_NAME_INVALID
BRANCH_NAME_RESERVED
BRANCH_NAMING_INVALID
BRANCH_POLICY_MISMATCH
```

Malformed generation/default ref is invalid. Different observed generation is
stale. Wrong repository, task, exact bound branch, spelling, reserved target,
type/slug, or pattern remains a specific denial.

Diagnostics retain stable machine meaning and bounded safe details. A generic
CLI error or progress indicator must not erase the actual mismatch.

## 5. Source/task propagation

The current repository policy foundations project exact Implementation branch
evidence through Session, Admission, Executor, and publication. The target
retains that evidence while separating the selected Source Change identity.

`GitHubChangeStateProjector` acquires policy through canonical governance.
Core `projectChangeFromGitHubEvidence` consumes policy evidence and rechecks
its identity/generation. Existing `branchEvidence` and legacy naming inputs
are not simultaneous independent authorities.

The older assumption that the projected Change root always equals the task
Implementation must be migrated explicitly. Do not fix a Source operation by
silently renaming it to the task or assigning it an arbitrary child branch.
Source publication/integration and leaf publication have distinct bindings.

## 6. Exact advancement and provider targets

Branch-create/advance and PR head/base capability targets use safe spelling
and exact admitted identity. Advancement refuses the current authoritative
default and task base where prohibited by its contract, not only the string
`main`.

Compare-and-swap, protected paths, task WRITE/CREATE/DELETE scope, provenance,
and current authorization remain required. Admitted branch policy does not
grant provider effects or permission to modify integration branches.

`src/agent-authority/branch-advance.ts`, capability/provenance modules, and
`src/github/git-data-capability.ts` consume canonical targets. They must not
reintroduce a fixed six-prefix grammar for every repository.

## 7. Integration topology

The accepted Issue-integration model is:

```text
Implementation leaf -> Source Issue integration -> Epic integration -> default
```

An ordinary leaf uses its accepted task branch. Source integration uses
`issue/<source-number>-<slug>`, and Epic integration uses
`epic/<epic-number>-<slug>` where the selected repository contract supports
that model. `impl:` is an Issue title class, not a new `impl/*` branch class.

Routing derives from canonical relationships and accepted base metadata.
Branch names validate identity/consistency after that decision. Multiple
Source references are not multiple implicit parents.

A Source integration branch is not an implementation worktree. A leaf PR
proves the bounded task, a Source PR proves its composed capability, and an
Epic PR proves the composed product change. Neither downstream proof is
inferred from the number of child merges.

## 8. Standalone and legacy routes

Standalone work does not manufacture an Epic or Source integration branch.
Use its explicit accepted route and prove the Source/task/publication join.
Missing identity remains action-required/denied.

Existing in-flight legacy direct-to-Epic topology is not silently rerouted.
Any supported old representation is explicitly classified and adapted into
the canonical model; it does not authorize a competing new execution path.

An already-projected valid route must revalidate to itself. Cross-Source,
cross-Epic, default/base mismatch, or layer skipping is rejected where the
selected topology requires those layers.

## 9. Compatibility inventory

Existing historical helpers such as recognizeBranchName,
recognizeBranchNamingForIssue, branchBelongsToRootIssue, deriveBranchName,
deriveCanonicalBranchName, and the integration helpers may remain for
versioned historical records or reserved routing.

LEGACY_CHANGE_BRANCH_RULE explicitly represents the historical six-prefix
convention. It is used only when passed as the accepted compatibility rule,
not as an ambient fallback. resolveRepositoryBranchGovernance remains the
legacy bare-rule adapter.

Old line-number inventories are historical evidence. The causal migration
seams are local Session launch/setup, Change projection, capability targets,
branch advance, integration routing, release routing, and legacy artifact
readers. Each must have one naming owner after its slice migrates.

Hosted work-reader naming logic is retired with that semantic backend; it is
not a second consumer to preserve indefinitely.

## 10. Rulesets and shared governance

Naming policy does not enforce provider branch creation. The actual Ruleset
is a separately administered boundary described in
[Branch Creation Ruleset Operations](./BRANCH_CREATION_RULESET_OPERATIONS.md).

Shared organization validation consumes canonical Inari routing rather than
copying its semantics into YAML/shell. Generated consumer governance remains
generated, and shared workflows use their accepted `@main` contract.
Do not repair a consumer by forking the provider or skipping checks.

## 11. Verification

Preserve alternative naming and non-main default coverage, including the
existing `story/<n>-<slug>` on `trunk` certification. Prove exact binding,
missing format/input, malformed/reserved spelling, stale policy generation,
wrong repository/task/branch, and default/base protection.

Prove Source/task separation, multiple Sources without implicit parent,
standalone publication, each integration role, layer-skipping denial,
legacy-route compatibility, and no provider mutation on naming/admission
failure.

A matching branch regex is not proof of correct authorization or integration.
