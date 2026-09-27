# Contributing to Inari

## Start with the contract

Read `AGENTS.md`, the organization governance contract, and the applicable
purpose-specific Skill. The [Product Architecture Canon](./docs/ARCHITECTURE.md)
and domain guides define the accepted target; the governing Issue or latest
explicit owner instruction defines the requested work and lifecycle.

Do not treat a historical Issue, stale PR description, or current accidental
behavior as permission to redesign a settled contract. When evidence conflicts,
identify the exact contradiction and return the architecture decision to the
owner rather than silently choosing a broader fallback.

Architecture includes identity, public meaning, credential/trust/state owners,
compatibility, failure/recovery semantics, deployment guarantees, and proof
boundaries. Internal functions, files, algorithms, and focused tests remain
implementation choices within the accepted scope.

## Environment

Use the repository-supported Node.js version (24 or newer) and package-manager
contract from package.json. Install the pinned dependency graph:

```sh
pnpm install --frozen-lockfile
```

An unsupported local environment does not justify weakening checks or claiming
CI is green. Record what could and could not be executed.

## Isolated work

Do not implement directly on main. Use the governed branch/worktree and
current base. Preserve unrelated work. Do not reset, force-push, merge, close,
or alter live settings without the corresponding explicit authority.

An Implementation leaf is not its Source/Epic integration branch. Cross-Source
dependencies require physically integrated producer state, not sibling
worktrees or an Issue closed flag. Standalone work follows its accepted route.

## Implementation boundaries

Implement the accepted gap. Reuse canonical Core, parser, schema, lifecycle,
port, and storage primitives. Remove duplicate authority for a migrated slice
rather than leaving both paths active indefinitely.

Source Change identity is distinct from Implementation task/leaf publication.
Hosted assertion eligibility is distinct from semantic authorization.
Provider effects stay at Executor, delegation keys at Authority, and Setup
configuration remains secret-free.

Path scope distinguishes READONLY, WRITE, CREATE, DELETE, and DENY. A naming
check does not establish task authorization; a valid signature does not prove
fresh repository state; a provider success does not prove the postcondition.

## Documentation changes

Preserve valid domain detail: inputs/outputs, invariants, threat model,
state/ownership, failure and recovery, migration, and verification. Remove
conflicting authority, not useful design information.

Use the [convergence ledger](./docs/ARCHITECTURE_CONVERGENCE.md) to distinguish
approved target, existing implementation, missing integration, and live proof.
Do not update historical release/certification records to imply they certified
a new architecture. Keep generated command/native-template sections aligned
with their actual producer.

## Validation

During edits run focused checks for the changed contract. After stabilization,
run canonical verification:

```sh
pnpm run verify
```

Source, built, installed, process, browser, deterministic-provider, and live
checks prove different boundaries. Reuse revision-bound artifacts only when
identity and exclusive producer ownership are established. Do not drop a real
boundary test because a mock covers similar logic.

Report actual command, candidate SHA, environment, result, and limitations.
Pending, blocked, skipped, stale, and not-run evidence are not pass.
Documentation-only changes still require their applicable formatting,
reference, contract, and CI checks; do not mark full verify passed from prose
inspection alone.

## Pull requests

Use the repository's current title, branch, template, and routing contracts.
The PR describes delivered work and actual validation; it does not supply a
second task authorization or auto-close a Source whose acceptance was not
proved.

Keep each semantic template section parseable. In particular, Validation
checklist content is the canonical task-list values; detailed validation prose
belongs in the appropriate narrative section rather than contaminating the
checklist field.

A PR being created or mergeable is not approval, verified readiness, or merge.
Review checks the actual diff, authority, architecture, tests, and exact-head
CI. Architecture, governance, and implementation correctness are all part of
the delivery contract.

## Security and disclosure

Follow [Security Policy](./SECURITY.md). Never include keys, tokens, OAuth
codes/verifiers, raw signed request bodies, credential-bearing logs, or private
provider responses in Issues, PRs, or retained evidence.
