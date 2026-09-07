# XState Change Machine Architecture

Status: normative implementation architecture for Epic #345 and child Issue #346. This document refines, but does not replace, the product architecture in #188 and `docs/CHANGE_CONTROL_PLANE.md`.

## 1. Purpose

Inari already models governed Change lifecycle state and trusted execution semantics. The current implementation distributes those semantics across transition tables, projection helpers, planners, validators, recovery classifiers, and imperative trusted-executor sequencing.

This document fixes the boundary for migrating that control flow to XState v5 without moving semantic authority, repository truth, or provider I/O into the machine runtime.

The key rule is:

```text
XState = control-flow authority
Core pure functions = semantic authority
Adapters = I/O authority
GitHub projection = repository truth
```

XState is an internal executable statechart implementation. It is not a new persistence layer, public API, repository policy engine, or artifact-definition authority.

## 2. Authority model

### 2.1 Repository Canon and Semantic Artifact Core

Repository Canon and Semantic Artifact Core remain authoritative for governed Issue, Branch, and PR meaning.

They own, among other things:

- effective repository policy;
- template/schema interpretation;
- canonical branch identity;
- PR title/body/base/head semantics;
- artifact validation;
- provenance requirements;
- desired projection planning;
- observed-vs-desired comparison;
- bounded semantic diagnostics.

A machine may invoke these functions. It must not independently reimplement their rules in guards, actions, or actor-local helpers.

### 2.2 Change Core

Change Core remains authoritative for the public Change vocabulary and semantic transition contract.

The public lifecycle vocabulary remains:

```text
DEFINED
DRAFT
REVIEW
ACCEPTED
MERGED
ABORTED
RECOVERY_REQUIRED
```

The currently executable semantic operations remain:

```text
issue
ready
abort
```

`merge` remains reserved/non-executable until separately governed implementation exists.

### 2.3 XState runtime

XState owns executable control flow only:

- lifecycle transition legality;
- operation sequencing;
- explicit retry/no-op branches;
- failure-state routing;
- compensation routing;
- recovery routing;
- required reread and postcondition-verification sequencing;
- final typed machine outcome selection.

It does not decide canonical names, render artifacts, normalize provider responses, resolve repository policy, or define provenance rules.

### 2.4 Adapters

GitHub and transport adapters own bounded external I/O:

- read GitHub evidence;
- normalize provider responses;
- apply already-planned effects;
- dispatch/receive Actions transport;
- convert bounded machine/Core outcomes into existing public CLI/MCP/remote-executor results.

Adapters must not add independent lifecycle policy.

### 2.5 Repository truth

GitHub remains the primary observable state store for Change projection under #188.

An XState actor snapshot is ephemeral process state. It must not become an authoritative persisted Change record.

A newly started execution always admits from current authoritative GitHub-derived projection, not from a previously persisted actor snapshot.

## 3. Target module ownership

The migration may reorganize files, but the target ownership is conceptually:

```text
src/change/
  contract.ts                public/internal Change vocabulary
  projection.ts              GitHub evidence -> Change projection
  planning.ts                pure semantic transition/effect planning
  recovery.ts                pure recovery classification/planning
  machine/
    lifecycle-machine.ts     pure lifecycle legality
    execution-machine.ts     shared operation execution conventions
    issue-execution-machine.ts
    ready-execution-machine.ts
    abort-execution-machine.ts
    machine-output.ts        internal typed completion mapping

src/change-trusted-executor.ts
  dependency injection + actor invocation + result mapping

src/github/*
  evidence/effect adapters
```

This layout is illustrative. Ownership boundaries are normative; exact filenames are not.

### 3.1 Existing code mapping

During migration:

- `src/change.ts` remains the source of public Change contract, projection/planning semantics, canonical serialization, and existing transition compatibility until those concerns are safely split.
- `CHANGE_TRANSITION_RULES` is migration-era compatibility authority only after the lifecycle machine proves exact parity. It must not remain an independent long-term transition authority.
- `src/change-trusted-executor.ts` currently owns imperative sequencing. Its end state is a thin adapter around operation actors.
- Existing projection helpers remain semantic read-model functions outside XState.
- Existing Semantic Branch and Semantic PR plan functions remain desired-state authorities outside XState.
- Existing GitHub effect executors remain provider-I/O boundaries outside XState.
- Actions/MCP/CLI remote contracts remain outside XState.

## 4. Lifecycle machine

### 4.1 Scope

The lifecycle machine is pure. It has no network actors and applies no repository effects.

Conceptual statechart:

```text
DEFINED
  issue -> DRAFT

DRAFT
  ready -> REVIEW
  abort -> ABORTED

REVIEW
  ready -> REVIEW       # idempotent retry
  abort -> ABORTED

ABORTED
  abort -> ABORTED      # idempotent retry

RECOVERY_REQUIRED
  abort -> ABORTED      # governed cleanup retry when admitted by recovery semantics
```

`ACCEPTED` and `MERGED` are currently observation-derived states. They are accepted as authoritative initialized/projection states but are not converted into synthetic mutation events merely for statechart symmetry.

### 4.2 Initialization

The lifecycle machine receives an already-classified current public Change state.

It must not fetch GitHub evidence itself.

Initialization therefore follows:

```text
GitHub evidence
  -> normalization
  -> Change projection
  -> semantic validation/classification
  -> lifecycle machine initialization
```

The projection pipeline may produce diagnostics or fail closed before a lifecycle event is admitted.

### 4.3 Event vocabulary

The internal lifecycle event vocabulary should map directly to semantic operations, for example:

```ts
{ type: "ISSUE" }
{ type: "READY" }
{ type: "ABORT" }
```

Event names are internal implementation details, but there must be a one-to-one semantic mapping to public operations. Machine-local events must not become a competing command vocabulary.

### 4.4 Parity requirement

Before the existing transition table can cease being authoritative, tests must exhaustively compare all current public state/event combinations.

For every combination, the machine must prove one of:

- legal transition with identical resulting public state;
- legal idempotent self-transition/no-op;
- deterministic rejection with compatible bounded semantics;
- unsupported/reserved operation.

No transition semantics may change incidentally during the migration.

## 5. Trusted execution topology

The trusted execution runtime should use one dispatcher plus operation-specific child actors/machines rather than one giant monolithic machine.

Conceptually:

```text
trusted request
  -> bind trusted requester/issuer context
  -> dispatch by semantic operation
       -> issue actor
       -> ready actor
       -> abort actor
  -> map final internal outcome
  -> existing trusted/public result contract
```

The dispatcher does not re-decide semantic legality. It selects the operation actor and provides trusted dependencies/context.

## 6. Machine context contract

Machine context must remain bounded and explicit.

Recommended categories:

### 6.1 Immutable request identity

- repository identity;
- root Issue number / Change identity;
- requested semantic operation;
- trusted requester identity;
- trusted issuer identity;
- request correlation metadata when already part of existing bounded contracts.

These values should not be mutated after actor startup.

### 6.2 Current semantic evidence

- normalized current Change projection;
- projection diagnostics/status;
- admitted semantic plan;
- relevant canonical branch/PR identity.

Raw GitHub response bodies must not be retained in machine context.

### 6.3 Effect evidence

Only bounded evidence needed for deterministic postcondition or compensation logic is retained, for example:

- effect kind;
- canonical target identity;
- created branch commit SHA/generation evidence;
- created/updated PR number when part of the bounded result contract.

Provider tokens, raw exception objects, unbounded URLs, and full provider payloads are prohibited.

### 6.4 Diagnostics/recovery evidence

Store only allowlisted bounded Core/trusted-executor diagnostics required to map a terminal outcome.

Machine context is not a log sink.

## 7. Actor/service boundaries

Operation actors invoke typed services for external or semantic work. The following responsibilities remain separate.

### 7.1 Evidence read actor

Input: repository + Change identity.

Output: bounded normalized repository evidence or a classified read failure.

It may call GitHub adapters. It must not classify lifecycle legality itself beyond evidence normalization.

### 7.2 Projection actor/function

Input: normalized evidence.

Output: authoritative `ChangeProjectionResult` or equivalent bounded projection result.

This remains a pure Core responsibility where practical.

### 7.3 Semantic validation/planning actor/function

Input: projection + semantic request + effective Core inputs.

Output: admitted semantic transition/effect plan or bounded semantic rejection.

It must reuse existing Core validators/planners and Semantic Branch/PR plans.

### 7.4 Effect actor

Input: one explicit planned effect plus trusted authority context.

Output: bounded effect evidence or classified effect failure.

The effect actor must not invent follow-up effects or reinterpret policy.

### 7.5 Reread actor

After any privileged mutation, repository evidence is read again through the normal evidence boundary.

A mutation response alone is never sufficient proof of successful Change transition.

### 7.6 Verification actor/function

Input: expected semantic postcondition + reread authoritative projection.

Output: verified success or bounded projection-verification failure.

Verification semantics remain Core-owned.

## 8. Common execution invariant

Every successful privileged mutation path must follow this shape:

```text
read
-> project
-> validate/admit
-> plan
-> apply effect(s)
-> reread
-> verify postcondition
-> success
```

No operation may report semantic success merely because the provider API returned 2xx.

Every failure edge must end in one of:

- bounded classified failure;
- explicit compensation flow;
- explicit recovery-required flow.

There is no generic implicit fallthrough to success or recovery.

## 9. Ready execution machine

Ready is the reference vertical slice.

Conceptual topology:

```text
reading
-> projecting
-> validating
-> planning
   -> alreadyReady -> verifyingCurrent -> success
   -> effectRequired
-> markingReady
-> rereading
-> verifying
-> success

failure states:
  readFailed
  preconditionFailed
  effectFailed
  verificationFailed
```

Required behavior:

- DRAFT -> REVIEW applies exactly one planned `MARK_PULL_REQUEST_READY` effect.
- REVIEW -> REVIEW is explicit idempotent success with no duplicate mutation.
- Invalid/conflicting/recovery evidence fails before mutation.
- Success requires reread and healthy canonical REVIEW verification.

## 10. Abort execution and recovery

Abort must distinguish normal termination from partial-cleanup retry.

Conceptual topology:

```text
reading
-> projecting
-> classifyingAbort
   -> alreadyAborted -> success
   -> normalAbort
   -> cleanupRecovery

normalAbort:
  plan
  -> closePullRequest
  -> deleteBranchIfPlanned
  -> reread
  -> verifyAborted

cleanupRecovery:
  validateRemainingCleanup
  -> deleteRemainingBranchIfSafe
  -> reread
  -> verifyAborted
```

### 10.1 Internal hierarchical recovery states

The stable public lifecycle remains `RECOVERY_REQUIRED`, but internal execution state may distinguish:

```text
recoveryRequired.abort.branchCleanupPending
recoveryRequired.abort.cleanupUnsafe
recoveryRequired.abort.verification
```

These names are illustrative. The important property is that recovery topology is explicit internally rather than inferred repeatedly from ad hoc executor conditionals.

### 10.2 Destructive cleanup safety

A recovery actor may only apply the remaining destructive effect proven safe by current authoritative evidence.

If branch generation/current SHA no longer satisfies the existing compensation/cleanup contract, automatic deletion fails closed and preserves worker data.

XState does not weaken generation-safe deletion semantics or solve provider-side atomicity limitations by itself.

## 11. Issue issuance Saga

Issuance is a logical transaction composed of multiple GitHub effects.

Conceptual topology:

```text
bindTrustedIdentity
-> validateRootIssue
-> readAuthoritativeEvidence
-> projectCurrentChange
-> classifyIssuance
   -> existingHealthyChange -> successExisting
   -> createRequired
-> admitSemanticPlans
-> createCanonicalBranch
-> recordBranchGenerationEvidence
-> createCanonicalDraftPullRequest
-> reread
-> verifyDraft
-> success
```

### 11.1 Partial failure

If branch creation succeeds and Draft PR creation fails:

```text
prCreationFailed
-> rereadPartialProjection
-> planCompensation
   -> safeToDeleteCreatedBranch
      -> deleteCreatedBranch
      -> reread
      -> verifyCompensated
      -> compensatedFailure
   -> unsafeOrAmbiguous
      -> recoveryRequired
```

Compensation is never unconditional branch deletion by name.

### 11.2 Idempotency

A healthy existing canonical issued Change is an explicit terminal success path with zero duplicate branch/PR effects.

Partial, duplicate, conflicting, or unavailable evidence is not treated as healthy idempotency and must fail closed or enter governed recovery according to existing Core semantics.

### 11.3 Artifact semantics

Issuance consumes Semantic Branch and Semantic PR plans. The Saga sequences effects; it does not rederive:

- branch name;
- branch base;
- PR head/base;
- PR title/body;
- Issue/PR relationship semantics;
- provenance requirements.

## 12. Recovery model

`RECOVERY_REQUIRED` is a public statement that repository evidence does not permit safe completion of the requested governed transition without an explicit recovery path.

Internally, hierarchical states should distinguish at least the recovery classes already required by execution behavior:

```text
recoveryRequired.issuance.orphanBranch
recoveryRequired.issuance.compensationUnsafe
recoveryRequired.abort.branchCleanupPending
recoveryRequired.verification
```

The internal subtype must be derivable from bounded current/effect evidence and must map back to the existing public lifecycle/result contract.

Do not persist the internal subtype as independent repository truth.

A retry starts from fresh GitHub-derived projection and reclassifies the current recovery topology.

## 13. Outcome and error mapping

XState terminal states are internal. Public consumers continue receiving existing Inari contracts such as `ChangeRemoteExecutionResult` and `ChangeTrustedExecutorError`.

The machine runtime should produce an internal discriminated outcome approximately equivalent to:

```ts
type MachineOutcome =
  | { kind: "success"; result: BoundedChangeResult }
  | { kind: "failure"; code: TrustedErrorCode; diagnostics: BoundedDiagnostics }
  | { kind: "recovery-required"; result: BoundedRecoveryResult };
```

Exact type names are implementation details.

Required properties:

- existing stable trusted error codes remain meaningful;
- Core diagnostics remain bounded and allowlisted;
- secret-bearing/provider objects never escape;
- machine state-node names are not exposed as public error codes;
- Actions/CLI/MCP consumers do not need to understand XState.

Issue #263 remains separately responsible for preserving allowed trusted diagnostics across the Actions transport boundary. Typed machine outcomes do not by themselves satisfy #263.

## 14. Rehydration and restart semantics

There is no authoritative actor rehydration from persisted snapshots.

A new request/retry follows:

```text
fresh request
-> fresh GitHub evidence read
-> fresh projection
-> classify current lifecycle/recovery state
-> start/enter operation machine from that admitted state
```

If an execution process crashes after an effect, the next request detects the resulting GitHub projection and proceeds through existing idempotency/recovery semantics.

This preserves the #188 invariant that GitHub, not a private actor store, is the Change state store.

## 15. Public API isolation

No public package export may require consumers to depend on XState types.

Do not export as product contracts:

- `ActorRef`;
- `Snapshot`;
- state-node values used only for internal execution phases;
- machine implementation objects as semantic authority.

Public API remains Inari-owned domain types and semantic commands.

This permits future internal machine refactoring or even runtime replacement without breaking callers.

## 16. Dependency policy

Use XState v5, exact-pinned during the migration.

Rationale:

- the trusted executor is governance/security-sensitive;
- exact pinning makes state-runtime changes explicit in review;
- dependency widening can be reconsidered after migration converges.

Graph/model testing support is development/test-only and must not become a runtime authority.

## 17. Testing architecture

Testing has three distinct layers.

### 17.1 Lifecycle parity tests

Before replacing `CHANGE_TRANSITION_RULES`, exhaustively test every public state/event pair against the pre-migration contract.

This is the migration gate for #347.

### 17.2 Focused operation tests

Each operation machine keeps deterministic fake evidence/effect actors and failure injection for:

- precondition failure;
- no-op/idempotent retry;
- effect failure;
- reread failure;
- verification mismatch;
- compensation success/failure;
- unsafe recovery.

These tests assert semantic outputs, not merely final state-node names.

### 17.3 Model/graph path coverage

After the production machines exist, model/graph traversal consumes those production definitions directly.

It must cover reachable lifecycle/execution/recovery paths without introducing a hand-written mirror machine.

A new reachable edge must either receive coverage or a bounded documented exclusion.

Model coverage supplements, not replaces, semantic/provenance/adapter/security regression tests.

## 18. Migration plan

The migration order is normative because it minimizes simultaneous authorities.

### Gate 0 — #346

Merge this architecture before runtime migration.

### Phase 1 — #347 lifecycle machine

Introduce exact-pinned XState v5 and the pure lifecycle machine. Prove complete parity before retiring the existing transition table as authority.

### Phase 2 — #348 Ready execution

Migrate the smallest complete privileged operation and establish shared operation-machine conventions.

### Phase 3 — #349 Abort/recovery

Migrate normal abort, idempotent terminal retry, and explicit cleanup recovery.

### Phase 4 — #350 issuance Saga

Migrate canonical branch + Draft PR transaction, compensation, generation-safe recovery, and issuance idempotency.

### Phase 5 — #351 graph/model coverage

Add structural reachable-path coverage over production machines.

### Phase 6 — #352 convergence

Reduce `TrustedChangeExecutor` to dependency injection, actor invocation, and public-result mapping. Remove superseded imperative sequencing/recovery classifiers and duplicate transition authority.

At every intermediate phase, supported public behavior must remain compatible.

## 19. Explicit non-goals

This architecture does not:

- replace GitHub as Change state store;
- add a Change database;
- persist XState actor snapshots as repository truth;
- change public Change state names;
- make `merge` executable;
- move Semantic Artifact rules into machine guards/actions;
- move GitHub response normalization into XState;
- redesign Actions transport;
- solve #263 transport diagnostic loss automatically;
- solve #343 workflow bootstrap/source-trust behavior;
- guarantee provider-level atomic compare-and-delete beyond the existing effect contract;
- redesign CLI or MCP semantic command vocabulary.

## 20. Review invariants

An implementation PR in #347-#352 should be rejected if it does any of the following:

- persists an actor snapshot as authoritative Change state;
- duplicates branch/PR semantic derivation inside a machine;
- treats provider mutation success as semantic success without reread/verification;
- deletes a branch during compensation without existing safety evidence;
- exposes XState implementation types through public package contracts;
- creates operation-specific lifecycle rules that diverge from the canonical lifecycle machine;
- converts ACCEPTED/MERGED into invented mutation events without separate governance;
- adds workflow/adapter policy that competes with Core/machine authority;
- silently treats #263 or #343 as solved by the XState migration.

## 21. Completion condition

The migration is complete when:

- one pure lifecycle machine is the executable transition authority;
- issue/ready/abort trusted sequencing is machine-driven;
- recovery and compensation paths are explicit and covered;
- all mutation success paths reread and verify authoritative projection;
- `TrustedChangeExecutor` no longer contains a competing imperative state machine;
- Semantic Artifact/Core and adapter authority boundaries remain intact;
- public Change/CLI/MCP/Actions contracts remain implementation-independent;
- GitHub remains the sole initial observable Change state store.

At that point, XState is an implementation mechanism for making Inari's already-governed semantics executable and mechanically complete, not a new source of product truth.
