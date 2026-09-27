# Repository Branch Policy and Integration

Status: normative naming/routing boundary under [Product Architecture Canon](./ARCHITECTURE.md). Branch spelling is evidence, never repository authority, parentage or a capability grant.

## 1. Policy ownership

The target repository owns ordinary branch naming through its canonical PR branch policy and exact Implementation binding. The current policy is read from the provider-resolved default branch using the existing governance reader. Do not add a second naming file or hard-code gh-inari's convention for other repositories.

A pattern validates names; it cannot be inverted to invent a canonical name. An explicit bounded format may derive names from declared inputs. Missing naming input, non-derivable policy and malformed/stale policy are distinct action-required/denied results.

## 2. Exact branch binding

Resolve an Implementation branch from its exact authorized binding or the declared repository format. Validate immutable repository identity, Implementation number, policy provenance/generation, safe spelling and the exact expected branch. The authoritative default/base branch is protected by evidence, not a universal literal named main.

The current public policy functions in `src/repository-branch-policy.ts` and grammar in `src/branch-naming.ts` remain the executable format/diagnostic authority. Existing bounded format placeholders and reserved namespace rules are not expanded by this document.

Once admitted, pass the exact branch evidence through Session, Admission, Executor and provider adapter. Downstream consumers validate identity/equality and safe spelling; they must not recreate naming from a title, regex or local environment.

## 3. Source and task separation

Implementation branch evidence belongs to the task. Change lifecycle subject belongs to the selected Source. Neither can be inferred from the other merely because both contain Issue numbers.

The Source set bounds which Change subjects a delegated task may address. The integration parent/routing contract selects the actual leaf PR base. The first Source is never an implicit primary parent and multiple Sources do not grant arbitrary target selection.

## 4. Integration roles

The supported Issue-integration topology is Implementation leaf to Source integration to Epic integration to repository default. Reserved `issue/`, `epic/` and `release/` namespaces retain their explicit class contracts; malformed reserved names cannot fall through to an ordinary-name regex.

Canonical provider relationships and routing metadata determine parentage. Name matching only verifies consistency. An integration branch is not an implementation worktree, and a leaf PR cannot skip a required integration boundary.

Standalone work does not require invented Epic/Source branches. Existing in-flight routes are handled by explicit migration rules, not silently retargeted. Sibling merge order does not create semantic execution dependencies.

## 5. Compatibility and external enforcement

Historical naming helpers may read old records or explicitly supported grammar. They are not a second rule engine for new ordinary work. Migration removes downstream hard-coded derivation once the canonical policy owns that path.

Shared governance consumes the canonical Inari routing projection rather than reimplementing semantics in YAML/shell. Organization workflow references remain `@main`; generated consumer snapshots are not edited as canonical sources.

Live branch/trust protection is separate from naming validation. A correctly named branch or green parser test is not proof of a repository Ruleset. See [Branch Ruleset Operations](./BRANCH_CREATION_RULESET_OPERATIONS.md).

## 6. Proof

Cover an alternative ordinary convention and non-main default, exact task/branch/base binding, wrong repository/Source/parent, stale policy, malformed reserved names, standalone compatibility and layer-skipping denial. Prove propagation through the real publication/branch-advance composition, not only a naming helper.
