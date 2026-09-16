# Issue and Implementation governance

Status: normative authoring and execution guidance for the repository's
Issue and Implementation contracts. Executable schemas, validators, command
metadata, and provider relationship evidence remain authoritative for their
machine-readable behavior.

## 1. Responsibility boundary

The governing model is:

```text
ordinary Issue = problem / request / decision record
Implementation = one authorized implementation-session contract
```

An ordinary Issue records why work matters and what outcome is wanted. It may
be an Architecture, Bug, Feature, Research, or Maintenance Issue. Its
responsibility is the problem, request, or decision and its issue-level
acceptance criteria. An ordinary Issue may remain open indefinitely without an
Implementation, a branch, a pull request, or a Change.

An Implementation is a separate governed Issue created when a concrete
implementation session is being prepared. It records the bounded work that a
single session may perform. Its responsibility is the session objective,
selected implementation design, explicit path authority, constraints,
verification evidence, base binding, and execution dependencies. It is not a
replacement for the source Issue and it does not rewrite the source Issue into
an execution plan.

The distinction is normative:

| Artifact       | Owns                                                                                                                                                 | Does not require for its existence                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Ordinary Issue | Problem, request, decision, context, issue-level contract, and acceptance outcome                                                                    | Session path scopes, implementation branch/base, targeted checks, postconditions, or authorization |
| Implementation | One-session objective, non-goals, architecture choice, scopes, constraints, prerequisites, tests/checks, postconditions, and base/dependency binding | A new problem statement or a second authorization model                                            |
| Pull request   | Delivered result, linked work, validation, and review context under the applicable PR/Change contract                                                | The Implementation's path authority or a replacement authorization record                          |

Creating or editing either an ordinary Issue or an Implementation does not
start implementation. An Implementation is not ready to authorize until its
canonical body is complete and its required execution evidence is available.

## 2. Normative lifecycle

### 2.1 Ordinary Issue lifecycle

An ordinary Issue follows this norm:

1. Record the problem, request, or decision in the appropriate ordinary Issue
   form.
2. Resolve the issue-level decision and acceptance outcome without requiring a
   session plan.
3. When execution is actually being prepared, derive one or more bounded
   Implementation Issues from the source Issue. Add session-specific detail to
   those Implementations, not to every ordinary Issue.
4. Keep the ordinary Issue as the source record. Its creation, linkage,
   implementation, and closure are separate events; authorizing an
   Implementation does not automatically close or mutate the source Issue.

An ordinary Issue can therefore be useful before implementation is selected,
while work is waiting on a decision, or after an Implementation has completed.

### 2.2 Implementation lifecycle

The Implementation lifecycle is an evidence projection with these current
statuses:

```text
DRAFT -> READY -> AUTHORIZED -> COMPLETED
                  |             ^
                  +-------------+

AUTHORIZED + body/base drift -> INVALIDATED
AUTHORIZED + explicit newer Implementation -> SUPERSEDED
```

The status names are the current `ImplementationLifecycleStatus` values. The
terminal side states are evidence outcomes, not automatic repository
migrations.

- `draft` means the contract is absent or not yet a valid complete canonical
  body.
- `ready` means the body projects to a valid contract but no current
  authorization record has admitted it.
- `authorized` means an explicit authorization record matches the current
  Implementation identity, canonical body digest, repository, and base
  evidence. The implementation session may use only that current contract and
  its derived scope.
- `completed` is reported only when completion is explicitly supplied while
  the authorization remains current.
- `invalidated` means current evidence no longer matches the authorization,
  including body or repository/base drift.
- `superseded` means explicit provider evidence identifies a newer
  Implementation.

The `impl` commands project and verify this lifecycle; they do not persist an
alternative lifecycle store. Authorization produces immutable evidence for one
event. It does not edit GitHub, create a branch or pull request, or grant scope
outside the canonical contract. A session must stop if its authorization is no
longer current.

## 3. Implementation contract

The v1 Core contract is `version: 1` with schema `1.0.0`, exposed from the
`implementation-contract` package entry point. Its GitHub Issue Form adapter
is `.github/ISSUE_TEMPLATE/implementation.yml`, generated from
`.github/inari/issues/implementation.json`. The normalized Implementation
body is canonical; title, labels, assignees, Projects metadata, and comments
are not contract identity.

The contract contains:

- repository identity and one or more source Issue references;
- the session objective, non-goals, architecture decision, affected
  components, invariants, and compatibility constraints;
- independent `READONLY`, `WRITE`, `CREATE`, `DELETE`, and `DENY` path lists;
- prohibited operations, immutable areas, and prerequisites;
- acceptance criteria, targeted tests, required checks, and observable
  postconditions; and
- base branch, optional base revision/freshness before authorization,
  implementation branch, and execution dependencies.

`WRITE` is an explicit allowlist and defaults to empty. `CREATE` and `DELETE`
are never inferred from `WRITE`; `DENY` narrows every matching allowlist. The
execution-scope projection is derived only from a current #572
`ImplementationAuthorizationRecord` plus fresh verification evidence. It has
no scope override input, and body drift, supersession, or stale repository/base
evidence fails closed.

## 4. Current `impl` command surface

<!-- BEGIN GENERATED IMPLEMENTATION COMMAND SURFACE -->

The current command contract is version `1.11.0` (`urn:inari:command-contract:1.11.0`).
The `impl` namespace projects these operations from the command contract:

| Command                         | Command ID       | Metadata summary                                                                                            |
| ------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `inari impl plan <number>`      | `impl.plan`      | Draft a bounded Implementation recommendation from authoritative Issue evidence without granting authority. |
| `inari impl show <number>`      | `impl.show`      | Show the current Implementation body, canonical contract projection, and authorization state.               |
| `inari impl validate <number>`  | `impl.validate`  | Validate an existing Implementation body against the canonical contract without mutation.                   |
| `inari impl authorize <number>` | `impl.authorize` | Authorize one current canonical Implementation body through the #572 Core boundary.                         |
| `inari impl inspect <number>`   | `impl.inspect`   | Inspect Implementation lifecycle and provider-authoritative parent/source relationships.                    |
| `inari impl verify <number>`    | `impl.verify`    | Verify a pull request and its authoritative diff against one current authorized Implementation.             |

The exact contract usage and option applicability are:

- `impl plan <number> [--repository <repository>] [--from <path>] [--capability <id> ...]`
- `impl show <number> [--repository <repository>] [--from <path>] [--capability <id> ...]`
- `impl validate <number> [--repository <repository>] [--from <path>] [--capability <id> ...]`
- `impl authorize <number> [--repository <repository>] [--from <path>] [--capability <id> ...]`
- `impl inspect <number> [--repository <repository>] [--from <path>] [--capability <id> ...]`
- `impl verify <number> [--repository <repository>] --from <path> [--capability <id> ...] --pr <number>`

<!-- END GENERATED IMPLEMENTATION COMMAND SURFACE -->

Each operation accepts a positive Issue number. The generated projection above
owns the command IDs, version, contract ID, summaries, usage, and option
applicability. `--capability` is repeatable. `--from` accepts a JSON input file
or `-` for stdin; for lifecycle verification it can carry the current
authorization, base, supersession, or completion evidence accepted by the
existing Core boundary. `--repository` overrides the repository context for
the governed read. Use `--json` for structured output.

Author the separate Issue through the existing governed Issue operation with
the Implementation template, for example:

```text
inari issue create --template implementation
```

Then use only the command surface above to plan, show, validate, authorize,
inspect, and verify the contract. Do not infer a new command or authorization
behavior from the prose.

## 5. Canonical parent and source relationships

Relations are graph state, not body strings. Where the provider supports
GitHub's native parent/sub-issue relationship, the provider relationship is
canonical:

```text
source Issue --native parent/sub-issue--> Implementation
```

Attach an Implementation under its immediate governing source Issue through
the existing relationship authority. `Source Issues` and `Execution
dependencies` in the Implementation body remain canonical contract
references, but they do not override provider relationship evidence. The
`github.issue.parent.native` capability is the current native relationship
authority used by Implementation inspection.

Older Issues may contain a prose `Parent:` or `Parent Epic:` line. That prose
is compatibility guidance for recognizing historical intent only. It is not a
current parent assertion when native provider evidence is available, and it
must not trigger silent reparenting. Reconcile an existing relationship only
through the explicit, bounded relationship workflow after inspecting current
provider state. This documentation introduces no automatic historical
reparenting or bulk migration.

## 6. Supported hierarchy examples

The arrows below mean actual parent/sub-issue relationships where GitHub
supports them; the body may retain source references for the Implementation
contract.

```text
Epic
└── Architecture
    └── Implementation

Epic
└── Bug
    ├── Implementation 1
    └── Implementation 2

Feature
└── Implementation
```

An Epic remains a tracking and integration record. Architecture, Bug, and
Feature Issues remain problem/decision/request records. Each Implementation
child owns one bounded session; a second session gets a separate
Implementation child rather than inflating the ordinary Issue or reusing an
old authorization.

## 7. Authoring and compatibility rules

- Ordinary Issue forms stay lightweight. Their acceptance criteria describe
  the requested or decided outcome; they do not require execution scopes,
  branch/base identity, targeted tests, postconditions, or authorization.
- The Implementation form is the place to make session planning explicit.
  Keep its body aligned with the v1 contract and authorize only the current
  canonical body against current base evidence.
- A PR describes the delivered result and validation. It links the governing
  Issue or Implementation according to the applicable PR contract; it does
  not carry a second implementation-session authorization.
- Native parent/sub-issue state is preferred and authoritative where
  supported. Prose `Parent:` is retained only to help older artifacts be
  understood; it is not a migration command.
- No historical Issue is reparented merely because this guidance changed.
