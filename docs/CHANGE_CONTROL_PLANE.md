# Inari Governed Change Control Plane

Status: normative domain contract under
[Product Architecture Canon](./ARCHITECTURE.md).

This document preserves the detailed lifecycle, publication, idempotency,
compensation, provenance, and recovery contract. It replaces the former
Implementation-root identity and independent deployment assumptions with the
approved Source Change / Implementation task separation.

The target is not a claim that every current producer and consumer has already
migrated. In particular, the Local #1213 binding correction is not proof of
complete standalone and Source-integration publication conformance.

## 1. Purpose

Inari governs the meaning and publication of repository work, not only the
format of Issue and PR bodies. A Change gives a Source outcome a deterministic
lifecycle projected from its governed repository artifacts and evidence.

An Implementation is a bounded execution task contributing to that outcome.
Its authorization, Session, leaf branch, leaf PR, and evidence are distinct
from the Source Change and any Source integration publication.

The domain supplies one answer to what exists, what transition is permitted,
what effects are required, and how completion or uncertainty is verified.
It does not introduce a fourth persistent GitHub object or a private Change
database.

## 2. Product model and responsibilities

GitHub owns repository state. Repository Canon supplies concrete governed
contracts and policy. Semantic Core resolves, validates, projects, plans, and
classifies bounded results.

Admission authenticates the caller profile and authorizes its requested
semantic operation. Executor coordinates the admitted operation with the
existing Lifecycle Controller, evidence reader, Effect Authorizer, provider
adapter, and postcondition verifier.

Inari Access is the provider identity, not the requester, reviewer, semantic
policy engine, or repository authority. CLI, MCP, Console, and Relay are
interfaces/transports. No remote network placement creates a second Change
engine.

## 3. Why Change exists

Source intent, implementation execution, publication, reviewability, and
integration are different facts. Creating an Issue does not start execution;
creating a branch alone does not establish a canonical Change; a PR becoming
non-draft does not prove governance; and merging a leaf does not prove Source
acceptance.

Change binds lifecycle decisions to canonical repository observations and
explicit publication identity. This removes the need for callers to invent
branch/PR identities, duplicate readiness rules, or guess whether a failed
create request should be retried.

Proposal publication identity remains distinct from implementation commit
authorship. The App may publish the proposal while the commits retain the
actual author's provenance and review remains independent.

## 4. Identity and cardinality

### 4.1 Repository

Security identity is `repositoryHost + repositoryId`. Current `nameWithOwner`
is a locator and display value. Rename or name reuse cannot rebind an old
Change to a different repository. A transfer requires current installation
and repository-binding evidence, not an assumed continuation of access.

### 4.2 Source Issue

A Source records a problem, requested capability, or accepted decision and its
acceptance criteria. It may exist without an Implementation or issued Change.

A Source may have multiple contributing Implementations. Its completion must
be evaluated against composed evidence, not inferred from child count or the
last merged PR.

For the governed Source integration candidate, an authorized independent
reviewer finalizes a repository-owned, versioned Source acceptance record. It
binds the immutable repository and Source identities, governed integration PR,
exact head SHA, current Source criteria version/digest, reviewer identity and
authority, and an explicit result for every criterion. Current repository
policy determines reviewer authorization and independence. The App and Hosted
cannot approve their own PR or mint this reviewer acceptance.

### 4.3 Change

The canonical target identity is:

```text
Change = immutable repository identity + selected canonical Source Issue
```

No independent Change ID namespace is introduced. The selected Source is
explicit; the first Source listed in an Implementation is not automatically
primary.

The active canonical publication pair belongs to that Change. Conflicting
pairs are ambiguity, not a choice for the client to make heuristically.

### 4.4 Implementation

The Implementation owns a bounded task contract and current authorization:
repository identity, Implementation Issue, governed-body digest, and explicit
base evidence. Its Session task stays the Implementation.

An Implementation may name multiple canonical Sources. That set narrows which
Source operations may be requested, but it does not create multiple implicit
integration parents or permit arbitrary PR targeting.

Task termination is a separate event owned by the Implementation lifecycle.
An explicitly authorized Runtime operator finalizes a versioned record owned
by the repository and bound to its immutable identity, this Implementation,
the current authorization digest, and accepted base evidence. A Source Change
abort, Issue closure, or Session's own abort assertion cannot finalize the
task event.

### 4.5 Session

A local Session binding carries the Implementation task, permitted claims,
validity, Authority evidence, and signed branch/Implementation observations.
A requested Source must be in both its signed Source set and the current
Implementation contract's Source set.

Adding a Source later does not widen an issued Session. Removing a Source
prevents subsequent Source operations. Task/body/base/branch freshness remain
separate checks.

Admission rereads current task-termination evidence for each task-bound
operation, including an operation from an already issued Session. A successful
authoritative read showing no termination event means the Implementation is
not terminated; all other Admission checks still apply. A terminated
Implementation makes all of its Sessions fail closed. A failed or unavailable
read, or invalid or mismatched current evidence, denies. Closing a Session only
closes that Session and does not terminate its Implementation task.

The existing task-bound `change.implement` compatibility claim serves only
Implementation publication and branch-side composition. It cannot authorize
an Implementation-root `change.issue/show/ready/abort/merge` operation.

### 4.6 Publication roles

Keep three publication roles distinguishable:

```text
Implementation leaf publication
  exact task branch + leaf PR + execution evidence

Source Change publication/integration
  exact Source branch + Source PR + composed acceptance evidence

Epic integration
  composed Source outcomes + Epic PR + product certification
```

An Issue-integration topology resolves Implementation leaf to Source branch,
Source branch to Epic branch, and Epic branch to the governed default branch.
Standalone work uses its explicit supported routing contract without
manufacturing an Epic.

A missing standalone Source/publication join is not repaired by treating the
Implementation number as Source, selecting an arbitrary child PR, or copying
one leaf's branch into the Source publication slot. Its canonical binding must
be established by the relevant implementation and certified.

### 4.7 Historical data

Stored historical Change identity is read under its recorded version and
original root. A reader does not silently reinterpret an Implementation-root
record as a Source-root record merely because relationships now exist.

Bounded historical observation/adoption may remain. A compatibility reader
must produce an explicit canonical or historical classification and must not
preserve an independent old execution engine.

An Implementation-root Change abort can remain readable as historical data,
but it does not authorize new task termination or substitute for Admission's
current task-evidence check. Current code still projects Implementation
`aborted` from a bound ABORTED Change identity; migrate that producer/consumer
path to the versioned repository-owned task record while retaining only the
bounded historical read.

## 5. Domain invariants

A Source may be inert in the backlog. An active issued Change has exactly the
canonical publication required by its role and routing contract. A branch and
PR are its projections, not independent semantic authorities.

Implementation authorization, task, leaf branch/PR, and execution evidence
must agree. Source lifecycle authority and leaf publication authority must not
be confused. Sibling Implementations cannot overwrite each other's identities
or be selected as substitutes for Source acceptance.

Canonical names and desired artifacts are derived by the appropriate Core
contracts. Callers do not acquire authority by supplying already-matching
bytes. Native relationship and accepted integration metadata determine
routing; branch grammar only checks consistency.

Issuance is create-or-return-existing and logically transactional. Partial,
conflicting, or unavailable evidence is classified explicitly. Destructive
cleanup is limited to the exact admitted object and generation.

All normal mutations use Executor-owned Inari Access capability. Success
requires authoritative reread and semantic postcondition verification.
Requester, App actor, author, reviewer, approver, and merger remain distinct.

## 6. Lifecycle

```text
DEFINED
  -> issue -> DRAFT
  -> ready -> REVIEW
  -> actual policy evidence -> ACCEPTED
  -> explicit admitted merge -> MERGED

DRAFT / REVIEW
  -> admitted abort -> ABORTED

partial/unsafe/unverifiable state
  -> RECOVERY_REQUIRED
```

This is a semantic overview, not a replacement production transition table.
The canonical lifecycle machine and Core contract determine legal events.

### 6.1 DEFINED

The governed Source exists but no active canonical Change publication is
issued. No branch or PR is required merely because the Issue exists.

### 6.2 DRAFT

The canonical branch and Draft PR required by the selected publication role
exist consistently. A branch without its PR or a PR with contradictory
identity is not healthy DRAFT.

### 6.3 REVIEW

The governed ready transition has been admitted and its canonical publication
is verified as reviewable. REVIEW is not review approval or successful CI.

### 6.4 ACCEPTED

The required current checks, reviews, governance, and merge-policy conditions
are actually satisfied. A cached green badge or a child PR's checks cannot
prove the current composed candidate accepted.

This is Change policy acceptance for the exact current candidate, distinct
from the reviewer's Source criteria acceptance. Source completion requires
both applicable current Change policy evidence and a current Source acceptance
record whose results satisfy every Source criterion. A missing, unavailable,
invalid, mismatched, stale, dismissed, or revoked record fails closed. A changed
integration PR head or Source criteria version/digest, or lost reviewer
authorization or independence, invalidates its use for completion. Recheck
these bindings and current repository policy when the record is used; neither
an earlier review nor a branch name alone certifies the current candidate.
The record grants no merge or provider mutation authority.

### 6.5 MERGED

The canonical PR has actually merged under the admitted policy and its final
state has been reread. Post-merge branch cleanup is separate from the semantic
identity of the completed Change.

### 6.6 ABORTED

The admitted operation intentionally terminated the Change without merge.
Enough bounded provenance remains to distinguish intentional termination from
an absent or unreadable object.

### 6.7 RECOVERY_REQUIRED

Current evidence does not justify safe completion without the explicit
recovery path. It is not permission to reset state, delete arbitrary branches,
or retry all provider operations.

## 7. Issuance

A compliant issuance operation performs:

1. resolve immutable repository and current governance generation;
2. resolve the selected Source and applicable Implementation/caller authority;
3. validate the current task contract, Source membership, and execution scope;
4. resolve the exact publication role, base, branch, and PR relationship;
5. read current GitHub evidence for existing or conflicting publication;
6. return an already healthy canonical Change without duplicate effects, or
   admit the explicit creation plan;
7. create the canonical branch through the bounded provider effect;
8. retain its exact created head/generation;
9. create the canonical Draft PR from the admitted semantic plan;
10. reread and verify both artifacts against the planned postcondition;
11. return verified DRAFT or the appropriate bounded failure/recovery result.

The public spelling is owned by the command contract. The architecture does
not add a new command solely to describe this composition.

Publication of an Implementation leaf is not implemented by first pretending
that the Implementation is a Source Change. The bounded #1213 compatibility
path must preserve that distinction while the wider publication composition
converges.

## 8. Idempotency and duplicates

A repeated issuance can create the absent canonical publication, return an
existing healthy one, or reject/classify partial and conflicting evidence.
It cannot create a second canonical PR because the first response was lost.

An unavailable read is not absence. Multiple plausible PRs are not resolved
by oldest/newest/first matching name unless the actual canonical contract
expressly identifies one from current evidence.

An idempotency key is evidence for correlation, not a substitute for correct
provider state, identity, and effect fencing. A repeated request with changed
semantic content is not the same request.

## 9. Compensation and partial effects

GitHub effects spanning branch and PR creation are not one atomic transaction.
The controller therefore preserves explicit Saga and recovery behavior.

```text
create branch
  -> definite pre-effect failure: no issuance
  -> success: retain created generation
       -> create Draft PR
            -> verified pair: DRAFT
            -> failure/unknown: reread before compensation or retry
```

If current evidence proves the exact created branch is safe to compensate,
the compensation plan can remove it conditionally. If compensation succeeds,
issuance returns a classified failure with no orphan canonical publication.
If unsafe, failed, or unverifiable, return RECOVERY_REQUIRED.

### 9.1 Generation-safe deletion

The existing compensation contract retains the SHA returned by branch
creation and requires a fresh observation of the same generation. The
provider adapter must use the available conditional deletion primitive; a
read followed by unconditional delete is not an equivalent guarantee.

The existing implementation uses GraphQL `updateRefs` with `beforeOid` and
the zero OID when the repository node ID is available. Its safe failure is no
unsafe deletion when the conditional primitive is unavailable or rejected.
This is an implementation reference, not permission to introduce a second
provider helper or weaken that check during migration.

Confirmed absence can be an idempotent compensated result without mutation.
A branch that has advanced is not automatically deleted to make issuance
appear atomic.

### 9.2 Compensation versus abort

Issuance compensation concerns the exact generation created by that failed
issuance. Abort concerns the current canonical Change and its admitted cleanup
policy. Their plans and evidence must not be substituted for one another.

### 9.3 Unknown PR creation

When PR creation may have succeeded, first reread canonical identity and
postcondition. A timeout cannot justify deleting its branch or creating
another PR before that ambiguity is resolved.

## 10. Branch authority

### 10.1 Creation

Canonical remote branch birth is an admitted Inari effect. Repository-owned
branch policy defines its identity; provider protection enforces the
configured creation boundary where available.

`src/branch-creation-ruleset.ts` and
[Branch Creation Ruleset Operations](./BRANCH_CREATION_RULESET_OPERATIONS.md)
define the actual supported enforcement and rollback contract. A document or
compiled definition is not evidence that a live Ruleset is enabled.

### 10.2 Advancement

An Implementation updates only its admitted leaf branch and current
head/generation under the accepted scope. The canonical `branch.advance`
contract must not acquire permission for sibling branches, Source integration
branches, or default-branch writes by filename or prefix similarity.

The local edit/commit workflow and physical worktree isolation remain outside
this domain. The target does not route every local filesystem operation
through Inari, nor require Actions for every branch update.

### 10.3 Deletion

Deletion is an explicit lifecycle effect with ownership and generation
conditions. Merge cleanup, abort cleanup, and issuance compensation remain
different purposes. None may infer permission from a stale branch name alone.

## 11. PR authority and provenance

### 11.1 Canonical publication

Executor publishes the admitted PR under Inari Access. Desired title, body,
head/base, relationships, and provenance come from canonical semantic plans.
The provider adapter does not invent omitted values.

### 11.2 Noncanonical PRs

Physical existence is not semantic conformance. The provenance/merge path
checks the exact repository, publication role, Source/task relation,
branch/base, PR identity, contract generation, authorization evidence, and
expected proposal identity where the contract requires it.

A leaf PR names its Implementation. A Source integration PR names its Source.
An Epic PR names its integration outcome. One relation cannot substitute for
another simply because all use Issue numbers.

### 11.3 Conflicting claims

If multiple artifacts claim canonical identity, or a PR's body, native
relationships, branch, and admission evidence disagree, return a bounded
conflict. Do not repair by choosing an arbitrary artifact or silently
reparenting Issues.

## 12. Draft-at-issuance and reviewability

Draft publication fixes the canonical proposal identity and makes active work
observable before it becomes reviewable. The initial artifact contains only
values that its contract can validly derive/materialize at that phase.

The ready transition requires the applicable summary, validation, acceptance,
and canonical artifact evidence before reviewability is reported. Missing
intent is not filled by an automated reconciler or an LLM repair heuristic.

Source integration readiness is evaluated on the composed Source candidate.
A healthy leaf Draft/ready PR is not automatically healthy Source publication.

## 13. Separation of duties

```text
requester       authenticated Session or remote/local subject
proposal actor  Inari Access under Executor custody
commit author   actual implementation provenance
reviewer        independent admitted review identity
merger          actor permitted by repository policy and explicit intent
```

The App does not approve its own PR. The initial Inari Access effect profile
is not a review/merge grant. Existing semantic merge composition is not an
instruction to widen the App permission set or fall back to a user's token.

Repository policy decides the required independence. This renewal does not
invent a new most-recent-pusher rule or relax an existing required review.

## 14. Authority boundaries

The Source owns the requested outcome and acceptance. The Implementation owns
bounded task delivery. Core owns semantic meaning. Admission owns caller and
operation admission. Executor owns the provider-effect composition and
credential boundary. GitHub owns observed repository state and enforcement.

Control/Console orchestrate explicitly available owner actions. Hosted
attests identity/eligibility and relays. No one layer silently absorbs review,
merge, trust-root approval, or unrelated local execution authority.

## 15. Human and agent interfaces

CLI, MCP, and UI expose the same semantic operations with bounded structured
input/output. Common CLI mechanics converge to CLI Canon; product operation
meaning stays in Inari.

Remote clients invoke Inari only. The public Relay URL is not shell access,
a generic HTTP proxy, a raw GitHub operation endpoint, or a file browser.

Pure rendering/validation of supplied data can run without a Session. Private
repository reads require the applicable read admission and provider evidence;
read-only does not mean anonymously accessible.

## 16. Common execution pipeline

```text
resolve current owner/provider evidence
  -> normalize observation
  -> project semantic state
  -> authenticate and admit caller/operation
  -> plan exact effects and preconditions
  -> execute bounded provider effects
  -> authoritative reread
  -> verify expected semantic postcondition
  -> bounded result or explicit recovery
```

Pre-admission provider reads use an Executor-owned read capability. Admission
receives evidence, not its token. Effect scope is chosen only from the admitted
plan, not from the breadth of the installed App.

Governance generation, artifact observation identity, branch head, and
credential/binding generation are separate freshness conditions.

## 17. Remote transport

The normal remote path is Hosted authentication/assertion plus Relay into the
user-owned Runtime. Hosted verifies the caller's Inari Access user scope
transiently and sends only the signed request-bound eligibility evidence.

Runtime verifies the configured issuer, subject, repository, App/installation,
Relay target, time, and replay/request binding, then performs its own semantic
admission. Eligibility does not grant all write capabilities.

No independent Direct App executor or Hosted repository engine remains the
target. Transport loss does not authorize execution elsewhere or through an
ambient credential.

## 18. Actions and workflow integration

Workflow code may invoke supported public Inari contracts and supply its
explicitly authorized transport/runtime context. It must not maintain
parallel branch, template, relationship, lifecycle, or permission policy.

A retained Actions adapter must be a bounded adapter into the accepted
execution architecture, not a second privileged engine preserved for
compatibility. Historical dispatch examples remain historical evidence, not
the normal cloud-client path.

Shared workflow references follow repository governance, including the
organization's `@main` requirement. This document does not authorize a
consumer fork or noncanonical workflow pin as a migration shortcut.

## 19. Inari Access

The App's installation credential is held only by Executor's broker. The
broker issues the minimum repository/effect capability and does not return a
reusable token or unrestricted authenticated client.

The user authorization profile used by Hosted is distinct from installation
execution. Its OAuth token is not forwarded to Runtime. Neither App identity
nor token possession replaces semantic admission.

See [Inari Access](./INARI_ISSUER_APP.md) for detailed permission, scope,
credential, and evidence boundaries.

## 20. Provenance and diagnostics

A bounded result identifies the repository, Source, task/authorization where
applicable, operation, caller profile, current governance revision,
publication role, exact branch/head/base, Executor/App/installation, and
verified result or recovery condition.

Remote evidence can reference the trusted assertion issuer and request
identity without retaining signed raw payloads. Local evidence can reference
the Authority and Session without exposing private signing material.

Diagnostic categories distinguish resolution, trust, Session/subject
admission, planning, provider effect, reread, and verification failures.
A generic transport success must not erase a downstream denied/failed result.

## 21. Security model

### 21.1 Trusted code and credentials

Provider credentials never enter untrusted agent shells, fork jobs,
PR-controlled execution, browser storage, Relay payload persistence, or
retained certification evidence. A trusted executor must not load arbitrary
repository-controlled code under its App credentials.

### 21.2 Protected authority sources

Trust, policy, and privileged execution definitions require their repository
protection. An agent-controlled working branch is not an authority source.
A broad WRITE scope does not permit self-escalation through those paths.

### 21.3 Least privilege

Publication does not imply administration, secret management, review, or
merge authority. Provider permission names are not semantic capabilities.

### 21.4 Fail-closed behavior

Unknown identity, stale evidence, missing authorization, unreadable policy,
conflicting publication, or unsafe compensation is a bounded denial/recovery
result, not an invitation to try a broader credential.

### 21.5 Hosted trust

A configured Hosted signer is trusted for attested identity/eligibility facts.
Its signature does not prove an honest issuer or supply missing Runtime
subject authorization. A malicious signer is a threat explicitly described
in [Caller Authentication](./AGENT_CAPABILITY_AUTHORIZATION.md).

## 22. State derivation and drift

A reader deterministically distinguishes absent/unissued publication, one
healthy active Change, terminal historical state, and conflicting or
unavailable evidence. It does not treat provider unavailability as absence.

Observation describes evidence; semantic projection interprets it with
current Canon. Reconciliation produces a bounded plan, not immediate provider
mutation. A stale artifact or changed generation invalidates a previous plan.

## 23. Ready admission

Before ready, verify as applicable:

- selected Source and task authority remain current;
- canonical publication role, branch/base, PR and provenance agree;
- the PR semantic contract is valid/current or can be safely reconciled;
- required implementation, validation, and acceptance evidence exists;
- no unresolved projection drift or unsafe partial state remains.

Apply the admitted ready effect and reread REVIEW. A GitHub UI draft toggle
outside these checks is not proof that those conditions hold.

## 24. Merge admission

Merge requires explicit caller intent, exact current PR/head/base identity,
canonical provenance, required checks/reviews, and repository merge policy.
Change composition delegates policy and provider work to the existing
Semantic PR merge authority; it does not implement another merge engine.

A semantic transition is not an App credential grant. If the selected
execution boundary cannot lawfully perform merge, it returns a bounded
unsupported/denied result or the existing external human action, never an
implicit user-token fallback.

`MERGED` is reported only after authoritative reread. Source or Epic closure
remains its own acceptance decision and cannot be inferred from one leaf merge.
Source and Epic composition consume the current Source acceptance result at
their respective boundaries; an Epic cannot infer a Source's criteria results
from integrated leaves or Change `ACCEPTED` alone.

## 25. Product boundaries

Inari owns repository contracts, canonical publication, semantic lifecycle,
provenance, admission, and bounded provider planning/execution.
Nawabari owns local worktree/process/filesystem isolation.
Mottainai owns agent scheduling and context orchestration.
Wabachi may provide design/architecture evidence without taking over Inari
lifecycle. Verification projections do not make another product the Source
completion authority.

## 26. Compatibility

Compatibility is directional: old data may be interpreted by an explicit
versioned reader and adopted only when identity and semantics are proven.
An old execution architecture is not retained merely because its serialized
format still needs to be read.

Direct App selection and independent Hosted semantic/provider execution are
retired. Shared Core and effect helpers remain when the canonical Executor
uses them. No migration silently destroys user keys, owner state, active
Sessions, or historical provenance.

## 27. Convergence sequence

Freeze Source/task/publication identity before changing consumers. Establish
current common Admission and owner binding. Route local and remote inputs to
the same semantic operation composition. Prove standalone and Issue/Epic
integration publication independently.

Preserve the existing Saga, ready, abort, and merge-policy contracts while
replacing only their obsolete identity/transport composition. Remove old
execution entry points after replacement public-path proof. Enable live
provider enforcement only after the governed path and recovery are verified.

## 28. Verification matrix

The required proof classes include:

- absent, existing healthy, duplicate, and conflicting publication;
- two sibling Implementations under one Source without identity collision;
- multiple Sources without implicit primary or arbitrary PR base;
- stale/removed Source, changed authorization digest, and wrong branch/head;
- successful branch plus failed/unknown PR creation;
- safe conditional compensation and advanced-branch preservation;
- ready/no-op/invalid readiness;
- normal abort, partial cleanup, unsafe recovery, and already-aborted retry;
- exact-head merge admission and denied provider authority;
- local and remote admission parity with bounded diagnostic preservation;
- installed public-path composition and separate live enforcement proof.

Unit/graph proof does not establish packed or live behavior. Revision-bound
artifact reuse and distinct suite ownership are described in
[Verification Architecture](./VERIFICATION_ARCHITECTURE.md).

## 29. Rejected shortcuts

Do not use a new Change for every newly opened Issue, a private lifecycle
database, branch names as parentage authority, a second Hosted executor,
a blanket App grant for every visible repository, unconditional cleanup,
workflow-local semantic policy, or a user credential fallback to make an
unsupported effect succeed.

Do not flatten Source, task, leaf PR, integration PR, and Session into one
identity solely to simplify a validator.

## 30. Architecture amendment and completion

This document is subordinate to the Product Architecture Canon. Implementation
workers may refactor internal functions and actor wiring within these
contracts, but may not alter identities, permission/custody, cleanup safety,
compatibility, or public failure meaning without architecture-owner approval.

Completion requires the contracts above to hold on the exact composed
candidate and at the advertised public/provider boundaries. This renewal
establishes the target; it does not close any Issue or certify deployment.
