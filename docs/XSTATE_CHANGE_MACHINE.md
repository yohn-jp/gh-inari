# XState Change Machine Architecture

Status: normative Lifecycle Controller detail under
[Product Architecture Canon](./ARCHITECTURE.md) and
[Change Control Plane](./CHANGE_CONTROL_PLANE.md).

This renewal preserves the operation topology, actor boundaries, failure
semantics, parity and graph-proof requirements established by the earlier
XState work. It changes identity/deployment references to the accepted
Source/Implementation and user-owned Runtime architecture. It does not
replace the machine runtime or claim the target identity migration is complete.

## 1. Purpose

Inari models governed Change lifecycle and trusted execution through Change
Core, XState operation machines, and bounded adapters.

```text
GitHub                  repository authority and observed state
Repository Canon/Core   deterministic semantic contracts and plans
XState                  Lifecycle Controller implementation
Adapters                bounded provider/transport I/O
Executor                admitted operation composition
```

XState is not a persistence layer, public API, credential broker, repository
policy engine, or artifact-definition owner.

## 2. Responsibility model

### 2.1 Repository Canon and Semantic Artifact Core

Core and repository contracts own effective policy, schema interpretation,
branch identity, PR title/body/base/head, artifact validation, provenance,
desired projections, observed/desired comparison, and semantic diagnostics.

Machines invoke these functions. They do not reproduce their rules in private
guards or actor-local helpers.

### 2.2 Change Core

Change Core owns the public vocabulary and semantic transition contract.
The public states remain:

```text
DEFINED
DRAFT
REVIEW
ACCEPTED
MERGED
ABORTED
RECOVERY_REQUIRED
```

The operation vocabulary remains issue, ready, abort, and the explicitly
admitted merge composition. A public operation name is not evidence that every
provider profile is authorized to execute it.

Source Change identity and Implementation task/publication identity are
separate inputs. The controller must not replace the selected Source with the
Implementation number to satisfy an old equality guard.

### 2.3 Lifecycle Controller

XState implements executable legality and control flow:

- operation sequencing;
- explicit retry and no-op branches;
- failure routing;
- compensation and recovery routing;
- required reread and postcondition-verification order;
- coordination with the existing Semantic PR merge authority;
- selection of a bounded typed machine outcome.

It does not decide repository trust, derive artifact values, mint credentials,
normalize raw provider responses, or become a second state store.

### 2.4 Adapters

Evidence adapters read bounded provider/owner state. Effect adapters apply
already-planned operations. Transport adapters move requests/results.
Public result adapters map machine outcomes into Inari contracts.

No adapter adds an independent lifecycle rule or converts transport success
into semantic success.

### 2.5 Repository truth

An actor snapshot is ephemeral execution state. A new execution initializes
from current authoritative evidence, not a persisted snapshot that once had
permission to mutate.

Bounded replay/effect journals may preserve necessary recovery facts. They do
not replace GitHub Change projection or become an actor-state database.

## 3. Module ownership

The following is an ownership illustration, not an instruction to move files
for directory aesthetics:

```text
Change contract/projection/planning/recovery
  -> lifecycle machine
  -> operation-specific machines
  -> bounded machine outcome

TrustedChangeExecutor
  -> dependency injection
  -> actor invocation
  -> existing public-result mapping

provider adapters
  -> evidence read
  -> admitted effect
```

Current reference modules include:

- `src/change.ts` for Change contracts, projection/planning, and serialization;
- `src/change/machine/lifecycle-machine.ts` for executable lifecycle legality;
- `src/change-trusted-executor.ts` for the stable public adapter;
- `src/change/machine/trusted-execution-adapter.ts` for binding semantic
  callbacks and bounded I/O to operation actors.

Semantic Branch/PR planning, provider normalization, Session/remote caller
admission, and transport protocols remain outside the machine implementation.

Future separately approved Direct App convergence does not delete a shared
machine or planning helper merely because that profile historically called
it. Direct App remains temporarily frozen compatibility outside the Local
Admission lock.

## 4. Pure lifecycle machine

### 4.1 Scope

The lifecycle machine receives an already-classified public Change state and
an admitted semantic event. It has no network actor and performs no effect.

The existing conceptual transition map is:

```text
DEFINED
  issue -> DRAFT

DRAFT
  ready -> REVIEW
  abort -> ABORTED

REVIEW
  ready -> REVIEW       idempotent request
  merge -> MERGED       only through governed merge composition
  abort -> ABORTED

ACCEPTED
  merge -> MERGED       only through governed merge composition

ABORTED
  abort -> ABORTED      idempotent request

RECOVERY_REQUIRED
  abort -> ABORTED      only when current recovery semantics admit cleanup
```

This table explains the contract. The production machine is the executable
transition authority; no production copy of the table may compete with it.

`ACCEPTED` requires actual merge-admission evidence. `MERGED` requires actual
provider state verified after the admitted effect. An internal transition to
a terminal node is not sufficient proof of either.

### 4.2 Initialization

```text
current provider/owner evidence
  -> bounded normalization
  -> Change projection
  -> semantic validation/classification
  -> lifecycle initialization
```

Projection may return ambiguity or denial before the machine receives an
event. Initialization never silently fills missing Source/publication identity
from an arbitrary child branch or the first PR found.

### 4.3 Events

Internal events map directly to issue, ready, abort, and merge semantics.
Their spelling is internal, but one event must not accidentally select
another operation or acquire a new capability.

Machine-local progress events do not become public command names.

### 4.4 Parity

Test-only expected state/event pairs exhaustively cover the declared public
combinations. Each must produce a legal transition, an admitted idempotent
no-op, or deterministic rejection.

The expected set is a contract oracle in tests, not a second production
machine. Identity migration must not incidentally change unrelated lifecycle
legality.

## 5. Trusted operation topology

Use one dispatcher and bounded operation-specific actors rather than one
unstructured conditional executor or one monolithic machine that owns every
domain rule.

```text
admitted request and immutable execution context
  -> dispatch by semantic operation
       -> issue actor
       -> ready actor
       -> abort/recovery actor
       -> governed Semantic PR merge coordination
  -> typed machine outcome
  -> bounded public execution result
```

The dispatcher selects an operation implementation and supplies dependencies.
It does not repeat admission or infer permission from the actor selected.

Admission and the Effect Authorizer remain separate gates. A lifecycle event
cannot manufacture an installation capability or authorize a provider effect
missing from the selected execution profile.

## 6. Machine context

### 6.1 Immutable identity

Retain the admitted repository, selected Source Change, Implementation/task
binding when applicable, semantic operation, authenticated requester,
Executor/provider identity, and bounded request correlation.

Those fields do not change midway through execution. A repository switch or
new Source is a different admitted request, not a context patch.

### 6.2 Current semantic evidence

Context may contain the bounded normalized projection, its status and
diagnostics, accepted semantic plan, and exact canonical publication identity.

Raw GitHub bodies, arbitrary URLs, user credentials, and unbounded exception
objects do not belong in context.

### 6.3 Effect evidence

Retain only the evidence needed for verification or compensation:

- effect kind and exact target;
- branch creation head/generation;
- relevant PR identity;
- classified outcome and allowed correlation;
- the plan's preconditions/postcondition.

An effect receipt is not a new source of repository truth. Reread still owns
verification of current state.

### 6.4 Diagnostics

Diagnostics are typed, bounded, and allowlisted. Context is not a log sink.
Provider response objects and secret-bearing errors must be sanitized at their
owner boundary before they reach an actor outcome.

## 7. Actor and service boundaries

### 7.1 Evidence read

Input is the exact admitted repository/subject and bounded query.
Output is normalized evidence or a classified read failure.

The reader performs I/O through the owner/provider adapter. It does not
choose lifecycle transitions or determine desired artifact values.

### 7.2 Projection

Input is bounded normalized evidence plus the relevant Canon.
Output is Change/semantic projection and diagnostics.

Projection is deterministic and contains no provider credential acquisition.

### 7.3 Validation and planning

Input is the semantic request, current projection, and accepted context.
Output is a bounded rejection or an explicit plan with preconditions and
postconditions.

Reuse the canonical Core, Semantic Branch, and Semantic PR planners. Machine
guards do not render a parallel PR body or derive another branch name.

### 7.4 Effect

Input is one admitted effect and the trusted execution context.
Output is bounded effect evidence or a classified failure.

The actor does not add follow-up effects, widen permissions, or retry an
unknown provider result without the canonical recovery decision.

### 7.5 Reread

After a possible mutation, reacquire evidence through the same canonical
reader boundary. A 2xx response, callback completion, or Relay delivery
acknowledgment is not the postcondition.

### 7.6 Verification

Compare the expected semantic postcondition with the fresh projection.
Return verified completion or bounded mismatch/unavailability/recovery.
Verification performs no compensating mutation on its own.

## 8. Common execution invariant

Every effectful success follows:

```text
read
  -> project
  -> validate/admit
  -> plan
  -> effect
  -> authoritative reread
  -> verify postcondition
  -> success
```

Every failure edge terminates in classified failure, explicit compensation,
or explicit recovery. There is no generic catch that silently returns success
or translates an unknown effect into a safe pre-effect retry.

A no-op success is permitted only after current evidence proves the requested
postcondition already holds.

## 9. Ready machine

Ready remains the small reference vertical slice:

```text
reading
  -> projecting
  -> validating
  -> planning
       -> alreadyReady
            -> verifyCurrent
            -> success
       -> effectRequired
            -> markReady
            -> reread
            -> verifyReview
            -> success
```

Required distinctions:

- healthy DRAFT to REVIEW applies the single admitted ready effect;
- an already healthy REVIEW is a verified no-op;
- invalid identity, drift, missing evidence, or unauthorized caller fails
  before effect;
- failed effect, failed reread, and mismatched postcondition remain different
  outcomes.

Changing a PR draft flag outside this path does not itself prove that the
Change is governed and reviewable.

Source Change ready and Implementation leaf publication are not aliases.
The caller must supply the correct semantic subject; a task-bound publication
claim cannot be consumed as a Source ready grant.

## 10. Abort and recovery

Abort distinguishes intentional termination, already-aborted state, and
remaining cleanup after a partial failure.

```text
read and project
  -> classifyAbort
       -> alreadyAborted: verify existing terminal state
       -> normalAbort: plan current closure/cleanup
       -> cleanupRecovery: validate only the remaining safe effect
```

Normal abort:

```text
plan
  -> close canonical PR if admitted
  -> delete canonical branch only if the abort plan permits it
  -> reread
  -> verify ABORTED
```

Recovery:

```text
current partial projection
  -> validate remaining cleanup ownership/generation
  -> apply only that safe remaining effect
  -> reread
  -> verify ABORTED or remain RECOVERY_REQUIRED
```

### 10.1 Internal recovery hierarchy

Internal actor states may distinguish branch-cleanup pending, cleanup unsafe,
and verification unavailable. Those names are not new public Change states.
They derive from current evidence and map to the established bounded result.

### 10.2 Destructive safety

A recovery actor must not delete advanced work, another Implementation's
branch, a mismatched Source publication, or a target selected only by name.

Issuance compensation and ordinary abort cleanup retain their distinct
contracts. XState does not make provider deletion atomic or justify weakening
the generation check.

## 11. Issuance Saga

Issuance is one logical operation with multiple provider effects:

```text
bind admitted identity
  -> validate selected Source and applicable task authority
  -> read current repository evidence
  -> project canonical publication
  -> classify issuance
       -> existingHealthy: verify and return existing
       -> createRequired
            -> admit Semantic Branch/PR plans
            -> create canonical branch
            -> retain created generation
            -> create canonical Draft PR
            -> reread
            -> verify DRAFT
```

The Source integration publication and Implementation leaf publication must
be explicitly resolved before this sequence. The actor cannot fill a missing
Source pair with an arbitrary child's branch/PR.

### 11.1 Partial creation failure

```text
branch creation succeeded
  -> PR creation failed or outcome uncertain
  -> reread partial projection
  -> plan compensation/reconciliation
       -> desired publication proven: verify existing result
       -> exact created branch safe to compensate
            -> conditional delete
            -> reread
            -> verify compensated failure
       -> unsafe/conflicting/unavailable
            -> recovery required
```

Compensation is never unconditional deletion by branch name. Failure after
sending a create request is not proof the object was not created.

### 11.2 Idempotency

Healthy existing canonical publication is a zero-duplicate-effect path.
Partial, duplicate, conflicting, or unavailable observations are not healthy
idempotency and must not trigger another blind branch/PR creation.

### 11.3 Artifact semantics

The Saga consumes canonical Semantic Branch and Semantic PR plans. It does not
rederive branch/base, PR head/base, title/body, relation meaning, or provenance.

A renderer or relation-policy change belongs to its domain contract, not a
machine-local formatting helper.

## 12. Recovery classification

Public `RECOVERY_REQUIRED` means that current evidence does not justify safe
completion of the requested transition without the explicit recovery path.

Existing internal distinctions include issuance orphan/compensation unsafe,
abort cleanup pending, and unavailable/mismatched post-effect verification.
They must be derivable from bounded evidence.

A new process rereads and reclassifies. It does not resume destructive
permission merely because an old actor snapshot was in a cleanup state.

## 13. Outcome and error mapping

Public consumers receive Inari domain results, not XState state-node names.
An internal discriminated result can distinguish verified success, bounded
failure, and recovery required while preserving the existing public contract.

Stable diagnostic codes retain their meanings. Secret-bearing provider
objects do not escape through exception causes or callback failures.
Transport adapters preserve allowed error evidence without exposing raw
responses or converting every failure into one generic success envelope.

A controller test does not prove transport diagnostic preservation. The
transport must have its own boundary proof.

## 14. Restart and rehydration

There is no authoritative actor rehydration from persisted snapshots.

```text
new request or recovery attempt
  -> fresh owner/provider evidence
  -> fresh projection
  -> current admission and recovery classification
  -> new bounded operation execution
```

If a process crashes after an effect, repository state and the relevant owner
fences determine whether to return existing, safely continue, or require
recovery. Process restart does not reset request identity into unused authority.

Runtime availability, Session lifecycle, Relay delivery, and Change state
remain different observations during this process.

## 15. Public API isolation

Public package contracts must not require `ActorRef`, XState snapshots,
internal state-node values, or machine objects as repository authority.

Consumers use Inari request/result and diagnostic types. Internal actor
refactoring must not require clients to understand machine implementation
states or select recovery branches themselves.

## 16. Dependency policy

XState is an internal implementation dependency. Changes to its version or
execution behavior are explicit reviewed changes with the required parity
and operation proofs.

Model/graph tooling remains a test dependency, not a runtime trust principal.
The architecture does not require a new generic workflow framework or
replacement state-machine abstraction.

## 17. Testing architecture

### 17.1 Lifecycle parity

Keep the expected public state/event pairs in tests only. Exhaustively compare
accepted transition, no-op, and rejected combinations with the production
machine. The expected set must come from the accepted contract, not a copy
computed from the same function under test.

### 17.2 Focused operation proof

Use deterministic evidence/effect ports and failure injection for:

- invalid identity and preconditions;
- healthy no-op retry;
- effect rejection and unknown effect outcome;
- reread failure;
- verification mismatch;
- successful and failed compensation;
- unsafe recovery;
- branch-generation change between observations.

Assert semantic output and effect count/targets, not merely a terminal
state-node name.

### 17.3 Production graph traversal

Graph/model traversal consumes production machine definitions. It covers
reachable execution/recovery edges without adding a handwritten mirror
machine. An uncovered edge needs a concrete proof or a bounded justified
exclusion.

Graph coverage supplements semantic, provenance, adapter, and security tests;
it does not replace them.

### 17.4 Composition and installed boundary

The actual Executor must invoke these machines with real owner/provider
adapters. Packed/public-path certification must not substitute a fixture-side
state machine or pre-create the desired ready/merged condition.

The same scenario at a different boundary may be necessary. Repeating the
same full suite twice at the same revision without a distinct proof is not.
See [Verification Architecture](./VERIFICATION_ARCHITECTURE.md).

## 18. Migration obligations

The existing XState extraction is a foundation to preserve, not work to redo.
The current architecture renewal requires:

1. Source/task/publication identity to be supplied consistently by every
   canonical caller;
2. local and remote caller evidence to converge before operation execution;
3. the approved Hosted/Direct App convergence to stop owning parallel
   sequencing after replacement-path proof; this is deferred from the Local
   Admission lock and is not authorized by this Issue;
4. public results to preserve bounded failure and recovery evidence;
5. continuous packed composition to prove the resulting path.

Do not revive the earlier imperative executor or create a second lifecycle
machine to ease a migration. Any future adapter retirement requires a
separate explicit owner decision; this target does not set an expiry for
existing compatibility.

## 19. Non-goals

This contract does not add a Change database, persist actor snapshots as
repository truth, change public state names, grant merge permission,
reimplement artifact semantics, normalize GitHub responses in XState, solve
provider atomicity, or create an autonomous orchestrator.

The existence of a merge transition does not authorize an implementation
agent, Hosted service, or App profile to approve or merge a PR.

## 20. Review invariants

Reject changes that:

- use a snapshot as current mutation authority;
- duplicate branch, template, relation, or capability policy in an actor;
- treat provider success as semantic success without reread;
- delete during compensation without exact safety evidence;
- expose machine internals as public product contracts;
- diverge operation-local legality from the canonical lifecycle machine;
- fabricate a provider merge capability from a state transition;
- alias Source Change and Implementation task identity;
- lose post-effect uncertainty in transport/result mapping;
- claim graph/unit tests certify a live provider path.

## 21. Completion condition

One lifecycle machine owns executable legality. Operation machines own
sequencing and explicit recovery. Core owns semantic rules and plans.
Executor/provider adapters own bounded effects and evidence. Every success
has a verified postcondition, every failure retains its correct ambiguity,
and public clients remain independent of XState internals.

The architecture renewal is certified only when those properties hold through
the supported local and remote public paths on the exact candidate revision.
