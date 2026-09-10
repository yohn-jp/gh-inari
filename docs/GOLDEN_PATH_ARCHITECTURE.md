# Inari Golden Path Architecture

Status: normative architecture gate for Issue #395. This document freezes the
Golden Path composition contract before implementation leaves are created. It
does not add a Golden Path CLI, runtime orchestration code, a new persistence
store, or a new operational playbook implementation.

Issue #395 is the intent authority for this gate. Its Decision, Invariants, and
Acceptance criteria are reflected here without replacing the executable
authorities named below. This document is the architecture authority for the
composition and certification boundary only.

## 1. Decision

The Inari Golden Path is the canonical agent and human workflow for a governed
repository Change. It is a product-level composition over the existing
Repository Canon, Semantic Artifact Core, Change, XState, GitHub adapters, and
`inari skill` authorities.

The normative path is:

```text
fresh environment
  -> packaged gh-inari compatibility/preflight
  -> repository Canon and semantic contract discovery
  -> governed Issue
  -> Change issuance
  -> canonical branch + canonical Draft PR
  -> implementation
  -> deterministic status/next-action projection
  -> Change ready
  -> REVIEW
  -> repository CI, review, and merge admission

failure at any governed effect
  -> bounded diagnostic
  -> authoritative reread
  -> idempotent retry, safe abort/cleanup, or explicit recovery
```

`REVIEW` means that the governed `ready` transition has been admitted and
verified. It does not mean that a human review, required check, or merge has
already succeeded. `ACCEPTED` and `MERGED` remain the existing Change and
repository-policy states; they are not new Golden Path lifecycle states.

The Golden Path eliminates caller rediscovery of templates, branch identity,
PR identity, Change legality, and recovery action by composing existing
semantic operations and projecting one bounded next action. It does not move
any of those decisions into a new orchestration authority.

## 2. Scope and invariants

### 2.1 Scope

This architecture gate fixes:

- the end-to-end workflow from a fresh packaged environment through verified
  `REVIEW`;
- the boundary between composition and existing semantic, lifecycle, control-
  flow, transport, and playbook authorities;
- the finite machine-readable status, next-action, diagnostic, and recovery
  contract;
- the package-level certification subject and isolation boundary;
- the retry, abort, partial-effect, reread, and recovery certification matrix;
- the dependency and implementation order for #239, #350, #351, and #352.

The document is normative for those boundaries. Executable schemas, validators,
command contracts, Change types, XState machines, GitHub workflows, repository
Rulesets, and tests remain the mechanical authorities for their own contracts.

### 2.2 Normative invariants

- The Golden Path is continuously executable and package-certified; README or
  Skill prose alone is not evidence of completion.
- The certification subject is an installed packed `gh-inari` artifact. A
  source checkout, TypeScript entrypoint, workspace `node_modules`, or direct
  `dist` invocation cannot satisfy package-level certification.
- A normal caller never supplies or guesses the canonical branch name, PR
  identity, template path, lifecycle legality, or compensation effect.
- A governed Issue may exist in `DEFINED` without an issued Change. Issue
  creation does not implicitly create a branch or PR.
- An issued active Change has exactly one canonical branch and one canonical
  Draft PR, both projected from the same Change identity.
- Issuance retry is create-or-return-existing and never creates a duplicate
  canonical branch or PR.
- Every retry, compensation, abort, or recovery decision starts from fresh
  authoritative GitHub-derived evidence. A provider response or stale actor
  snapshot is not sufficient proof.
- A privileged mutation succeeds semantically only after reread and
  postcondition verification.
- Partial or ambiguous state fails closed. Destructive cleanup is permitted
  only under the existing generation-safe Change compensation/abort contract.
- `change abort` and cleanup are part of certification, not optional manual
  maintenance.
- Raw GitHub write commands are not part of the normal governed path.
- GitHub remains the observable Change state store. No competing persistent
  Golden Path or XState database is introduced.
- `inari skill golden-path` is the single versioned operational playbook once
  its implementation leaf lands. `skills/inari/SKILL.md` remains a thin
  router and does not duplicate that playbook.
- CLI, MCP, Actions, and other adapters expose or transport the same Core and
  Change semantics. They do not acquire independent Golden Path policy.
- Existing public contracts remain compatible unless a separately governed
  implementation Issue explicitly versions them.

### 2.3 Non-goals of this gate

This gate does not:

- add `inari golden-path` or any other new CLI command;
- add or change `src/` code, command metadata, MCP tools, Actions workflows,
  package behavior, or XState machines;
- define a second branch grammar, template schema, artifact IR, Change state
  machine, or recovery classifier;
- replace Repository Canon, Semantic Artifact Core, Change, XState, GitHub, or
  `inari skill` with a Golden Path authority;
- move Nawabari worktree/process isolation or Mottainai agent orchestration
  into Inari;
- introduce merge automation, a hosted service, or a separate Change store;
- treat documentation completion as executable Golden Path completion.

## 3. Authority boundaries

The Golden Path is a composition layer. The following table is normative:

| Authority                                                                   | Owns                                                                                                                                                                                                         | Golden Path must not do                                                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Repository Canon and native repository contracts                            | Repository-specific Issue/PR meaning, template selection, branch policy, governance generation, and declared supplied/derived/fixed values                                                                   | Embed repository paths, regexes, title/body rules, branch grammars, or template defaults in orchestration         |
| Semantic Artifact Core                                                      | Contract compilation, effective input schema, artifact materialization, relation semantics, canonical branch/PR desired projections, validation, observed-vs-desired reconciliation, and bounded diagnostics | Re-derive artifact values, render a parallel body, or turn GitHub presentation into semantic authority            |
| Change Core and [`CHANGE_CONTROL_PLANE.md`](./CHANGE_CONTROL_PLANE.md)      | Change identity, `DEFINED`/`DRAFT`/`REVIEW`/terminal lifecycle, provenance roles, transition legality, issuance idempotency, effect plans, compensation, abort, and recovery semantics                       | Add a parallel lifecycle, Change ID, effect plan, or persistent Change record                                     |
| XState runtime and [`XSTATE_CHANGE_MACHINE.md`](./XSTATE_CHANGE_MACHINE.md) | Executable control flow: sequencing, explicit retry/no-op branches, reread, postcondition verification, compensation routing, and recovery routing                                                           | Decide semantic names, template meaning, provenance policy, GitHub normalization, or public state vocabulary      |
| GitHub and bounded adapters                                                 | Observable repository state and bounded provider I/O; read normalization and application of already-admitted effects                                                                                         | Become semantic policy, infer missing intent, or report provider success as semantic success without verification |
| GitHub Actions executor and Inari Issuer App                                | Actions is the trusted execution runtime; the App is the privileged mutation identity and capability                                                                                                         | Expose credentials to callers, define lifecycle policy in workflow YAML, or become a second Core                  |
| `inari skill`                                                               | Versioned operational playbooks and their scenario routing; `inari skill golden-path` is the Golden Path playbook authority                                                                                  | Be copied into `SKILL.md`, README, prompts, or a second static playbook                                           |
| Golden Path composition                                                     | Stage order, composition-level status/next-action projection, package certification boundary, and dependency matrix                                                                                          | Own any underlying semantic rule, provider effect, lifecycle transition, or transport-specific command spelling   |

The precedence is therefore:

```text
Repository Canon + Semantic Artifact Core
              -> artifact meaning and desired projections
Change Core + XState
              -> lifecycle legality and effect control flow
GitHub/adapters/executor
              -> observed state and bounded effects
Golden Path
              -> composition and next-action projection only
```

An implementation may expose the composition through a bounded facade or
extend existing Change outputs, as permitted by a later implementation Issue.
Neither choice changes the authority table or creates a new lifecycle.

## 4. Canonical workflow

### 4.1 Stages and exit conditions

| Stage             | Authoritative activity                                                                                                                                                                                          | Exit condition and next action                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ENVIRONMENT`     | Run the packaged executable's compatibility/capability preflight in a clean environment.                                                                                                                        | Package identity and required capabilities are verified; discover the target repository Canon.                           |
| `GOVERNANCE`      | Resolve the target repository, immutable governance generation, Issue/PR contracts, and effective semantic inputs through existing Core discovery.                                                              | Governance is available and valid; obtain or create a governed Issue through the existing Issue path.                    |
| `ISSUE`           | Read an existing governed Issue or create one with the existing governed Issue operation.                                                                                                                       | The root Issue is valid and eligible; its Change projection is `DEFINED`; issue the Change.                              |
| `CHANGE_ISSUANCE` | Invoke existing Change issuance semantics: root-Issue validation, authoritative projection, Semantic Branch/PR plan admission, canonical branch creation, separate Draft PR creation, reread, and verification. | Exactly one healthy canonical branch and Draft PR exist; Change is `DRAFT`; implement on that canonical branch.          |
| `IMPLEMENTATION`  | A worker edits, commits, and updates the already-issued working branch under the existing Change and local execution boundaries.                                                                                | Ready preconditions and required evidence are satisfied; request the governed `ready` transition.                        |
| `READY`           | Invoke existing Change ready semantics. Core validates the projection and preconditions; XState/executor sequences the effect, rereads, and verifies.                                                           | Canonical PR is non-draft and the Change is `REVIEW`; repository review and CI become the next external activity.        |
| `REVIEW`          | GitHub review, required checks, Rulesets, and merge admission remain repository and Change policy.                                                                                                              | The Golden Path certification target is reached. Any later accepted/merged state is observed under existing authorities. |

The stage name is a composition-level read projection, not a replacement for
Change state. In particular:

- `DEFINED`, `DRAFT`, `REVIEW`, `ACCEPTED`, `MERGED`, `ABORTED`, and
  `RECOVERY_REQUIRED` retain the exact Change vocabulary;
- `DRAFT` is the visible implementation state and requires both canonical
  branch and canonical Draft PR;
- `REVIEW` is admitted reviewability, not approval or merge;
- a worker owns implementation activity, while Inari owns the governed ready
  transition;
- existing Issue and Change operations remain usable independently during
  migration, but the Golden Path has one canonical composition order.

### 4.2 Normal path

The normal path has these properties:

1. Package preflight is read-only and runs before repository mutation.
2. Repository Canon and Effective Contract are discovered from the target
   repository; callers do not reconstruct template requirements.
3. Issue creation, when needed, uses the existing governed Issue operation.
4. Change issuance consumes Core-produced branch and PR plans and creates the
   canonical branch before the separate canonical Draft PR.
5. A healthy existing Change is an explicit idempotent return-existing result.
6. Implementation updates an issued branch; it does not create a competing
   branch or PR.
7. `ready` is a governed transition, not a raw GitHub draft toggle.
8. The result after successful ready contains a verified healthy `REVIEW`
   projection and a deterministic external review/CI next action.

### 4.3 Retry, abort, and recovery path

All privileged effects use this shape:

```text
read authoritative evidence
  -> project and validate
  -> admit and plan
  -> apply explicit effect(s)
  -> reread authoritative evidence
  -> verify postcondition
  -> return bounded result
```

The failure rules are fixed:

- A retry after a healthy issuance returns the existing Change with zero
  duplicate effects.
- A retry after an unknown effect outcome rereads GitHub before choosing
  retry, compensation, or recovery. It never blindly repeats creation.
- If branch creation succeeds and Draft PR creation fails, compensation may
  delete only the same canonical branch generation when the existing Change
  safety contract proves that deletion is safe. Successful compensation leaves
  no issued Change; unsafe or failed compensation yields
  `RECOVERY_REQUIRED`.
- `abort` from `DRAFT` or `REVIEW` uses the existing close-PR and conditional
  canonical-branch cleanup plan, then rereads and verifies `ABORTED`.
- An already-aborted Change is an explicit idempotent retry result.
- A recovery retry starts from fresh evidence. It may apply only the remaining
  effect admitted by current evidence; ambiguous or advanced branch state
  remains fail-closed and preserves worker data.
- An unavailable read is not interpreted as absence or success. The result
  exposes a bounded retry/read diagnostic and no unsafe effect.

No failure path silently falls through to success, and no recovery path guesses
caller intent.

## 5. Machine-readable status, next-action, and recovery contract

### 5.1 Transport-neutral envelope

The Golden Path result is a transport-neutral projection. A later implementation
may carry it alongside `ChangeProjectionResult` and
`ChangeRemoteExecutionResult`, or expose it through a thin composition facade.
It must not replace those underlying contracts or expose XState types.

The minimum envelope is:

```json
{
  "version": 1,
  "subject": {
    "repositoryHost": "github.com",
    "repositoryId": "<decimal repository id>",
    "rootIssue": 395
  },
  "status": {
    "phase": "IMPLEMENTATION",
    "availability": "actionable",
    "changeState": "DRAFT",
    "projectionStatus": "healthy",
    "executionOutcome": "verified"
  },
  "nextAction": {
    "kind": "IMPLEMENT",
    "owner": "worker",
    "reasonCode": "CHANGE_ISSUED"
  },
  "recovery": null,
  "diagnostics": []
}
```

The fields have these rules:

- `version` is the Golden Path envelope version. It is independent of, and
  must not fork, the versions of the underlying Change or Artifact contracts.
- `subject` reuses the stable Change repository identity and root Issue. It is
  absent or incomplete only before repository/Issue scope has been resolved.
- `status.phase` is one of `ENVIRONMENT`, `GOVERNANCE`, `ISSUE`, `CHANGE`,
  `IMPLEMENTATION`, `READY`, `REVIEW`, `TERMINAL`, or `RECOVERY`.
- `status.availability` is one of `actionable`, `blocked`,
  `recovery-required`, or `terminal`. `actionable` requires exactly one
  `nextAction` and no `recovery`; `blocked` and `terminal` expose no safe
  next action; `recovery-required` requires a `recovery` object and exactly
  one recovery next action.
- `status.changeState`, when present, is the existing Change state vocabulary:
  `DEFINED`, `DRAFT`, `REVIEW`, `ACCEPTED`, `MERGED`, `ABORTED`, or
  `RECOVERY_REQUIRED`. It is derived from authoritative projection and is
  never caller input.
- `status.projectionStatus`, when present, reuses the existing Change
  projection status vocabulary: `healthy`, `absent`, `partial`, `duplicate`,
  `wrong-base`, `ambiguous`, or `unavailable`.
- `status.executionOutcome`, when present, reuses the existing trusted
  execution outcomes: `verified`, `returned-existing`, `compensated`,
  `recovery-required`, or `failed`.
- `diagnostics` contains only bounded, allowlisted Core/executor diagnostics.
  Human-readable messages are explanatory; `code`, `path`, and the status or
  recovery fields are the machine contract. Raw provider payloads, tokens,
  stack traces, and unbounded logs never cross this boundary.

### 5.2 `nextAction` vocabulary

`nextAction` is either one object or `null`; it is never a free-form sentence.
Its `kind` is one of:

| Kind                  | Meaning                                                                          |
| --------------------- | -------------------------------------------------------------------------------- |
| `PREFLIGHT`           | Verify or repair the packaged executable environment before mutation.            |
| `DISCOVER_GOVERNANCE` | Resolve the target repository Canon and effective contract.                      |
| `CREATE_ISSUE`        | Create or complete the governed root Issue through the existing Issue authority. |
| `ISSUE_CHANGE`        | Issue the Change through existing Change semantics.                              |
| `IMPLEMENT`           | Work on the already-issued canonical branch.                                     |
| `READY_CHANGE`        | Request the governed ready transition after implementation evidence is present.  |
| `REVIEW`              | Perform repository review/CI activity after verified review admission.           |
| `RETRY`               | Repeat the named safe operation after the required reread/precondition.          |
| `ABORT`               | Run the governed abort/cleanup transition.                                       |
| `RECOVER`             | Run the explicitly admitted recovery action.                                     |
| `WAIT`                | Wait for an external repository condition such as CI or review.                  |

Each object also contains:

- `owner`: one of `caller`, `inari`, `worker`, `repository`, or `recovery`;
- `reasonCode`: a bounded stable code, not a diagnostic sentence;
- `retryOf`, only for `RETRY`, naming the semantic operation being retried.

The initial reason-code vocabulary is:

```text
PACKAGE_CAPABILITY_REQUIRED
GOVERNANCE_DISCOVERY_REQUIRED
GOVERNED_ISSUE_REQUIRED
CHANGE_ISSUANCE_REQUIRED
CHANGE_ISSUED
READY_PRECONDITIONS_REQUIRED
REVIEW_ADMITTED
AUTHORITATIVE_REREAD_REQUIRED
IDEMPOTENT_RETRY
ABORT_CLEANUP_REQUIRED
RECOVERY_ACTION_REQUIRED
WAIT_FOR_REPOSITORY_REVIEW
```

An implementation may add a code only through a separately governed contract
change. It may use an existing Core diagnostic code as additional evidence,
but may not replace a stable `nextAction` with free-form diagnostic parsing.

### 5.3 Recovery contract

`recovery` is `null` for a healthy or ordinary blocked projection. When present
it has this minimum shape:

```json
{
  "class": "ISSUANCE_COMPENSATION_UNSAFE",
  "safeAction": "MANUAL_REVIEW",
  "retryable": false,
  "rereadRequired": true,
  "automaticCleanup": "forbidden"
}
```

The bounded recovery classes are:

- `ISSUANCE_PARTIAL_PROJECTION` — an issuance effect may have succeeded but a
  complete Change is not proven;
- `ISSUANCE_COMPENSATION_UNSAFE` — the created branch generation cannot be
  safely deleted under the existing compare/generation contract;
- `ABORT_CLEANUP_PENDING` — abort has occurred partially and a remaining
  cleanup effect is still explicitly admissible;
- `ABORT_CLEANUP_UNSAFE` — cleanup evidence is insufficient or the branch has
  advanced, so automatic deletion is forbidden;
- `POST_EFFECT_VERIFICATION` — the effect response and authoritative reread do
  not prove the planned postcondition.

`safeAction` is one of `RETRY`, `ABORT`, `RECOVER`, or `MANUAL_REVIEW`.
`automaticCleanup` is one of `none`, `conditional`, or `forbidden`.
`rereadRequired` is always `true`; recovery never authorizes acting on stale
effect evidence. A `MANUAL_REVIEW` recovery must not manufacture a cleanup
command. A recovery result is not success and cannot be normalized to
`absent`, `DEFINED`, or `ABORTED` without authoritative proof.

### 5.4 Contract consistency rules

- `status.changeState` and `status.projectionStatus` are read projections from
  existing Core/Change evidence, not Golden Path-owned state.
- `status.availability = actionable` requires one safe `nextAction` and no
  `recovery`; `blocked` and `terminal` require no `nextAction`.
- `status.availability = recovery-required` requires non-null `recovery` and
  one `RETRY`, `ABORT`, `RECOVER`, or `WAIT` next action whose safety is
  justified by that recovery object.
- `nextAction = RETRY` is valid only after the required authoritative reread or
  an explicitly read-only preflight retry.
- A healthy `change.issue` retry exposes `executionOutcome = returned-existing`
  and no duplicate effect. A safe failed issuance compensation exposes
  `executionOutcome = compensated` and no issued Change.
- A verified ready transition exposes `changeState = REVIEW`,
  `projectionStatus = healthy`, and `nextAction.kind = REVIEW` or `WAIT` for
  repository review/CI. It does not expose `ACCEPTED` or `MERGED` early.
- A recovery-required result never exposes a normal mutation action in place of
  its recovery action.
- A machine state-node name, XState snapshot, provider error object, or CLI
  prose string is not a public status value.

## 6. Package-level certification boundary

### 6.1 Certification subject

The certification subject is the artifact produced by the repository's build
and pack flow and installed into an isolated fresh environment:

```text
repository source
  -> build
  -> pack gh-inari
  -> isolated consumer environment
  -> installed package bin: inari / gh-inari
  -> Golden Path certification
```

The harness must:

- build and pack the package before the scenario run;
- install the packed tarball, not a workspace link or source path;
- run the real packaged `inari` executable from a clean consumer directory;
- verify package identity/capabilities before any GitHub write;
- include the packaged Skill assets and invoke the versioned
  `inari skill golden-path` scenario once that implementation leaf exists;
- capture and validate only bounded machine-readable output;
- exercise normal mutations through existing Inari Change/Issue operations and
  the trusted executor, never raw GitHub writes;
- use a disposable or explicitly controlled governed repository/fixture for
  the run, with credentials and repository state isolated from the source
  checkout.

The source-level test suite remains valuable for Core and machine semantics,
but it is a separate evidence class. Passing source tests without the packed
executable does not certify the Golden Path.

### 6.2 Certification procedure

The release-blocking certification sequence is:

1. Build and pack `gh-inari`.
2. Create a fresh isolated consumer environment with no dependency on the
   source checkout's runtime modules or global `inari` installation.
3. Install the tarball and invoke the installed `inari` bin for preflight and
   Skill discovery.
4. Resolve repository Canon and effective Issue/PR contracts through the
   packaged executable.
5. Create or select a governed Issue through the existing Issue authority.
6. Issue the Change through the packaged executable and verify one canonical
   branch plus one canonical Draft PR.
7. Repeat issuance and assert `returned-existing` with no duplicate effects.
8. Perform implementation setup in the controlled worker environment, invoke
   ready through the packaged executable, and verify `REVIEW` after reread.
9. Exercise abort/cleanup and retry on disposable Changes.
10. Inject or reproduce partial-effect, reread, verification, and unsafe
    cleanup conditions and assert bounded status/next-action/recovery results.
11. Preserve the JSON evidence and fail the certification if any row invokes a
    source entrypoint, raw GitHub write, duplicate effect, unsafe cleanup, or
    unbounded diagnostic.

Failure injection may use deterministic bounded adapter fakes for provider
conditions that cannot be safely manufactured in a live repository, but the
scenario runner and result boundary remain the installed package executable.
The fakes supply evidence/effect outcomes; they do not define semantic policy
or a second lifecycle model.

### 6.3 Required certification matrix

| Case                    | Starting condition                                                           | Required result                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh package preflight | Clean consumer directory and packed artifact                                 | Real installed `inari` verifies identity/capabilities; no mutation occurs before success.                                                  |
| Governance and Issue    | Valid repository Canon and no root Issue, or a valid existing governed Issue | Existing Issue authority creates/reads the Issue; invalid or ambiguous governance fails closed with a deterministic recovery action.       |
| Happy path              | Governed Issue in `DEFINED`                                                  | `change.issue` yields one canonical branch and one Draft PR; implementation then yields verified `DRAFT -> REVIEW` through `change.ready`. |
| Issuance retry          | Healthy canonical Change already exists                                      | `change.issue` returns the existing projection with `returned-existing`; branch/PR create effects remain zero.                             |
| Ready retry             | Healthy canonical PR is already `REVIEW`                                     | Ready is an explicit idempotent no-op/verified result; no duplicate ready effect is emitted.                                               |
| Normal abort            | Disposable Change in `DRAFT` or `REVIEW`                                     | Close canonical PR, conditionally clean canonical branch, reread, and verify `ABORTED`.                                                    |
| Abort retry             | Change already `ABORTED`                                                     | Deterministic idempotent result; no unsafe or duplicate cleanup.                                                                           |
| Partial issuance        | Branch effect succeeds and PR effect fails or is ambiguous                   | Reread first; safe conditional compensation yields `compensated` with no issued Change, otherwise `RECOVERY_REQUIRED`.                     |
| Unsafe compensation     | Branch generation advanced, moved, or cannot be proven                       | No blind delete; expose recovery class/action with `automaticCleanup = forbidden`.                                                         |
| Reread unavailable      | Provider read after an effect is unavailable                                 | Do not treat unavailable as absent/success; expose bounded retry/recovery semantics and no duplicate create.                               |
| Conflicting projection  | Duplicate, wrong-base, ambiguous, or partial canonical evidence              | Fail closed before mutation or enter explicit recovery; no heuristic candidate selection.                                                  |
| Package/Skill boundary  | Installed package contains plugin/Skill assets                               | `inari skill golden-path` resolves from the packaged artifact; `SKILL.md` remains a router, not a copied playbook.                         |

The matrix covers the happy path, issuance idempotency, abort/cleanup,
partial failure, authoritative reread, verification failure, and
recovery-required behavior required by Issue #395.

### 6.4 Dogfood and release gate

`yohn-jp/gh-inari` is the first continuous dogfood consumer. Dogfood must use
the same packaged executable and governed Change path as external consumers.
The certification lane becomes release-blocking after dogfood demonstrates
stable happy-path and recovery behavior. Manual branch or PR creation required
to develop Inari is a regression signal, not a replacement for certification.

## 7. Dependency and convergence graph

The Golden Path composes the following work without taking over its semantic
responsibilities:

```text
#239 Change dogfood / abort-cleanup evidence --\
#350 issuance Saga --------------------------+--> Golden Path certification matrix
#351 production-machine graph coverage -------/
#352 TrustedChangeExecutor convergence -------/
```

The graph is a certification/decomposition relationship, not a new runtime
dependency database. Exact implementation readiness remains governed by the
Issues and their executable acceptance criteria.

| Issue | Dependency role                                                                                                                                                                                                                          | Boundary preserved                                                                                                       |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| #239  | Supplies the end-to-end dogfood evidence for Change issuance/ready and the still-critical abort, canonical-branch cleanup, and orphan/partial-issuance cases. Its abort/cleanup acceptance must be part of the Golden Path release gate. | It owns dogfood evidence and lifecycle validation; Golden Path does not reimplement abort or cleanup.                    |
| #350  | Supplies the XState issuance Saga: root-Issue admission, authoritative projection, idempotent existing-Change path, branch-before-PR effects, compensation, reread, and verification.                                                    | XState sequences the Saga; Core still owns branch/PR semantics and effect plans.                                         |
| #351  | Supplies graph/model coverage over production lifecycle and operation machines, including retries, failures, compensation, and recovery.                                                                                                 | Production machines are traversed; no hand-written Golden Path state model becomes a second authority.                   |
| #352  | Converges `TrustedChangeExecutor` on the canonical XState runtime while preserving public Change/Actions/CLI/MCP contracts.                                                                                                              | The executor remains an adapter; Golden Path consumes its bounded results and does not classify lifecycle independently. |

Until these dependencies' acceptance criteria are met, an architecture-level
matrix can be defined but must not be reported as completed package
certification. In particular, #350/#351/#352 do not authorize a new facade to
duplicate their sequencing, coverage, or convergence work.

## 8. Post-gate implementation order

After this document merges, implementation work is decomposed into independent
Issues in this order:

1. Extend the existing package-level harness to run the Golden Path from a
   packed artifact in a fresh environment.
2. Define the transport-neutral status/next-action/recovery projection by
   composing existing Change projection, execution evidence, and bounded Core
   diagnostics. Preserve existing public fields and versions.
3. Add the `inari skill golden-path` playbook as a thin composition over the
   existing live skill scenarios and exact command help. Do not copy its
   content into `skills/inari/SKILL.md`.
4. Integrate #239 abort/cleanup and the #350/#351/#352 evidence into the
   package certification matrix and dogfood lane.
5. Make the packed certification release-blocking after dogfood proves
   stability; add no new authority as a shortcut around an incomplete
   dependency.

Each leaf must identify its exact executable authority, preserve the status
contract above, and add only the smallest surface needed to certify the path.
No implementation leaf may introduce Golden Path-specific branch, template,
transition, recovery, or provider rules.

## 9. Architecture review gate

This document is ready for implementation decomposition only when reviewers can
answer yes to all of the following:

- Does the path explicitly cover fresh environment, packaged `gh-inari`,
  governed Issue, Change issuance, implementation, ready, and verified
  `REVIEW`?
- Are Repository Canon/Semantic Artifact Core, Change, XState, GitHub
  adapters/executor, and `inari skill` each assigned one authority with no
  Golden Path duplicate?
- Are `status`, `nextAction`, and `recovery` bounded, machine-readable, and
  derived from authoritative evidence rather than prose parsing?
- Does every effect path reread and verify, and does every retry avoid
  duplicate canonical branches/PRs?
- Are abort/cleanup, partial issuance, unsafe compensation, unavailable reads,
  and recovery-required outcomes in the certification matrix?
- Is the packed artifact installed and invoked in an isolated fresh
  environment, with source-only execution explicitly insufficient?
- Is `inari skill golden-path` defined as the operational authority while
  `SKILL.md` remains a thin router?
- Are #239, #350, #351, and #352 mapped without taking over their semantic
  responsibilities?
- Is `yohn-jp/gh-inari` identified as the first continuous dogfood consumer?
- Does the next implementation work decompose into independently executable
  Issues without adding a new lifecycle or persistence authority?

Until a later implementation Issue satisfies these gates with executable
evidence, this document is an architecture contract, not a claim that the
Golden Path is implemented.
