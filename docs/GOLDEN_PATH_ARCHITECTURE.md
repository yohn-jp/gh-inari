# Inari Golden Path Composition

Status: normative composition contract under
[Product Architecture Canon](./ARCHITECTURE.md).

A Golden Path composes existing owners into a continuous usable workflow.
It does not add a command namespace, lifecycle engine, credential model,
private repository database, or second recovery classifier.

The detailed status/next-action/recovery and installed-package proof obligations
remain here. The approved future target replaces old Implementation-root and
Direct App/Actions-required composition, not these evidence requirements.
That convergence is deferred from the Local Admission lock; current explicit
DirectApp compatibility remains under its existing contract.

## 1. Outcome

A caller can discover the repository contract, provide permitted semantic
intent, obtain the applicable authorization, perform a governed operation,
and receive a verified result or one bounded next action.

The workflow includes onboarding, normal operation, retry, abort, and recovery.
Local and remote clients differ in authentication and transport. They reach
the same user-owned Admission/Executor and semantic contracts. The remote
composition remains an approved but deferred target, outside the Local
Admission lock.

Issue, Source Change, Implementation task, Session, leaf publication, and
integration publication are not a single identity despite the short lifecycle
summary Issue -> Change -> PR -> Merge.

## 2. Composition responsibilities

Repository Canon and Semantic Artifact Core determine accepted input, desired
values, relations, and projections. Implementation authorization determines
bounded task scope and current body/base binding. Change determines Source
lifecycle/publication and recovery. XState sequences admitted operations.

Admission authenticates and authorizes. Executor obtains bounded provider
observations and applies admitted effects through Inari Access. Setup
Application composes owner observations/actions without holding secrets.

Golden Path projection owns only stage order, bounded status/next-action
composition, and its certification boundary. It must not derive a second
branch name, render a parallel artifact, invent a capability, or persist a
competing readiness state.

CLI/Skill/UI guidance derives from those public results and command metadata.
A static Skill router is not another operational policy source.

## 3. Repository connection

The recommended owner-composed sequence is:

```text
resolve immutable repository
  -> register or adopt public repository context
  -> choose dedicated App or explicit manual existing/shared App
  -> Executor-owned Manifest conversion or bounded key enrollment
  -> human App installation consent
  -> provider-observed App/installation/repository verification
  -> Executor repository binding
  -> Authority creation or exact-identity adoption
  -> governed publication of the public trust record
  -> independent human review/merge
  -> protected-ref trust reread
  -> Admission/Runtime configuration and owner observations
  -> repository Session-readiness proof
```

App registration is not installation. Enrollment is not provider verification.
Trust publication is not trust. Runtime health is not Session readiness.
A connected network socket is not a ready repository.

The stage is recomputed from persisted owner/repository state and the bounded
operation journal. Browser refresh, a new CLI process, or server restart must
not trust a completed-step flag and replay an uncertain external effect.

Existing identities, keys, validity, and capability ceilings are adopted only
when exact evidence matches. Setup never regenerates or widens them merely
to escape a conflict.

## 4. Local delegated work

### 4.1 Environment and governance

Use the installed package's supported compatibility/discovery surfaces to
verify executable identity and capability before mutation. Resolve the target
repository and immutable governance generation through Core.

Read the Source and bounded Implementation, current authorization, and the
explicit integration route. A stale body/base or missing producer is not
repaired by selecting a different root or branch.

### 4.2 Session and publication

Authority and Admission establish the current local Session binding. Its task
is the Implementation; signed Source claims and leaf branch evidence retain
their different meanings.

Source Change operations name the selected canonical Source. Leaf branch
advance and PR publication bind the Implementation. The existing task-bound
publication compatibility claim does not grant an Implementation-root Change.

Source integration and leaf publication pairs are resolved explicitly.
Standalone work uses its accepted route and must not select an arbitrary
child pair to fill a missing Source binding.

### 4.3 Implementation and ready

The worker performs the authorized task in its bounded local execution
context. Inari does not replace physical worktree/process isolation.

Readiness is admitted against current task, publication, and verification
requirements. Report REVIEW only after the intended canonical publication is
reread and verified as reviewable. Required CI, independent review, approval,
and explicit merge remain separate events.

Leaf completion does not prove Source or Epic acceptance.

## 5. Remote human-operated work

```text
Runtime proves Relay transport-key possession
  -> receives its stable public Relay endpoint
  -> operator configures the endpoint in the remote client
  -> client authenticates through Inari Access user authorization
  -> Hosted verifies caller and requested repository/App eligibility
  -> Hosted signs a short-lived request-bound access assertion
  -> user credential is discarded, not forwarded
  -> Relay delivers to the authenticated Runtime connection
  -> Runtime verifies issuer, request, target, time and replay binding
  -> Executor verifies current repository/App/installation binding
  -> Admission requires actual subject/operation authorization
  -> the common Core/Executor/effect/reread path
```

A cloud client needs no new Hosted-issued Inari Session or ephemeral
Session-key bootstrap. It also gains no shell, raw GitHub proxy, filesystem,
network-forwarding, enrollment, or operator-admin privilege.

Repository visibility is eligibility, not permission to exercise every App
write capability. A missing Runtime subject/operation rule is denial.
Private repositories are verified through the transient authenticated provider
access, not by requiring a publicly readable repository descriptor.

An offline Runtime returns bounded transport unavailability. Hosted does not
fall back to its own provider read/write backend or a different Runtime.
Reauthentication does not make an uncertain prior operation safe to replay.

## 6. Phase and exit conditions

The existing composition phase vocabulary is retained:

```text
ENVIRONMENT
GOVERNANCE
ISSUE
CHANGE
IMPLEMENTATION
READY
REVIEW
TERMINAL
RECOVERY
```

These are projections, not a second lifecycle. Environment means package
compatibility/readiness. Governance means current contract discovery. Issue
means the governed Source/task context is available. Change means the exact
Source publication operation. Implementation means bounded task activity.
Ready means admitted transition preparation/execution. Review means verified
reviewability and external repository activity. Terminal and Recovery reflect
the actual domain result.

Any serialized projection that formerly equated `rootIssue` with the
Implementation requires explicit identity migration. This document does not
silently reinterpret an existing wire record.

## 7. Machine-readable result

### 7.1 Envelope responsibilities

The composition result contains its version, exact subject identity, bounded
status, one next action or null, recovery or null, and diagnostics.
It may accompany existing Change results but must not replace their authority
or expose XState types.

Subject is the Source Change when the result concerns a Change. Applicable
Implementation/task/publication identity remains separately bound. A partial
subject before resolution is not a grant to infer missing identity.

### 7.2 Status dimensions

`availability` remains one of actionable, blocked, recovery-required, or
terminal. Domain `changeState` uses DEFINED, DRAFT, REVIEW, ACCEPTED, MERGED,
ABORTED, and RECOVERY_REQUIRED where present.

Projection status preserves healthy, absent, partial, duplicate, wrong-base,
ambiguous, and unavailable. Execution outcome preserves verified,
returned-existing, compensated, recovery-required, and failed.

A status belongs to its own dimension. Unavailable evidence is not absent;
verified transport is not verified execution; REVIEW is not ACCEPTED.

### 7.3 Next action

The existing bounded action vocabulary includes:

```text
PREFLIGHT
DISCOVER_GOVERNANCE
CREATE_ISSUE
ISSUE_CHANGE
IMPLEMENT
READY_CHANGE
REVIEW
RETRY
ABORT
RECOVER
MANUAL_REVIEW
WAIT
```

Each action identifies its owner, stable reason code, and the retried semantic
operation when applicable. It is not a free-form sentence that clients parse
for commands.

The existing owner vocabulary is caller, inari, worker, repository, and
recovery. Structured invocation is derived from the command contract rather
than assembled from untrusted shell strings.

### 7.4 Reason codes

Preserve the existing bounded meanings:

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
MANUAL_RECOVERY_REVIEW_REQUIRED
WAIT_FOR_REPOSITORY_REVIEW
```

Changing public code meaning is a contract change. Additional domain evidence
may explain a result, but diagnostic prose is not a substitute action code.

### 7.5 Recovery object

The bounded recovery classification retains:

- ISSUANCE_PARTIAL_PROJECTION;
- ISSUANCE_COMPENSATION_UNSAFE;
- ABORT_CLEANUP_PENDING;
- ABORT_CLEANUP_UNSAFE;
- POST_EFFECT_VERIFICATION.

It identifies the safe action, retryability, required reread, and cleanup
policy. Safe action is RETRY, ABORT, RECOVER, or MANUAL_REVIEW. Automatic
cleanup is none, conditional, or forbidden. Recovery requires fresh evidence.

An unsafe compensation cannot expose a normal mutation action. Manual review
must not fabricate a cleanup command. A recovery result cannot be normalized
to DEFINED/ABORTED/absent without proof.

### 7.6 Consistency

Actionable requires exactly one safe next action and no recovery object.
Blocked/terminal has no automatic next action. Recovery-required has its
recovery object and matching bounded recovery action.

A healthy issuance retry returns existing without create effects. Safe failed
compensation reports compensated, not successful issuance. Verified ready
reports healthy REVIEW and the relevant review/wait activity, not early merge.

Raw provider payloads, tokens, stack traces, machine snapshots, and arbitrary
logs never enter this public result.

## 8. Retry, abort, and compensation

Every retry starts with the required fresh observation. A possible effect
followed by timeout is not a pre-effect failure.

If canonical publication already satisfies the request, return existing.
If partial creation can be compensated under exact generation safety, apply
only that plan and verify the outcome. If advanced or ambiguous state makes
cleanup unsafe, preserve work and report recovery required.

Abort uses its own canonical closure/cleanup contract. It is not the issuance
compensation algorithm. An already aborted Change is an idempotent result;
remaining cleanup is applied only when currently safe.

## 9. Console and operator composition

One machine Console serves independent repository contexts. Setup, Runtime,
trust, Sessions, and diagnostics consume canonical owner/Application APIs.
A route selection does not mutate another repository's Application context.

Configuration, process health, provider binding, repository trust, Session
readiness, Session lifecycle, Relay reachability, and execution result remain
independent observations with owner evidence and freshness.

Remote UI, when supplied, is a presentation client over the same Runtime API.
It does not create Hosted repository state or bypass operator authorization.

Disconnect prevents new relevant work, obtains the active Session decision,
detaches bindings, and performs only explicitly selected cleanup. Shared App
or Authority material is not deleted with one repository. Rotation verifies
the candidate before switching and retiring old access.

## 10. Installed-package certification

### 10.1 Subject

```text
exact repository candidate
  -> build and pack
  -> isolated consumer installation of the tarball
  -> installed inari / gh-inari executable
  -> public-path scenario
```

A source entrypoint, workspace link, direct dist invocation, or unrelated
global install does not prove the installed package boundary.

The harness records source/package identity, isolates config and credentials,
verifies package capability before mutation, and captures only bounded output.
Skill assets and command discovery must come from that installed artifact.

### 10.2 Continuous scenario

The installed path resolves Canon, establishes Source/task authorization and
publication, exercises no-op retry, performs admitted ready, and tests abort
and partial-effect recovery on controlled disposable state.

For onboarding proof, fixtures must not pre-create connected/trusted/ready
state. For operation proof, provider fakes may supply bounded external
conditions but may not implement a second semantic engine.

### 10.3 Required matrix

Prove clean package discovery; valid and invalid governance; clean local
onboarding; resume/adoption; exact Source/task publication; healthy issuance
retry; ready retry; normal abort; already-aborted retry; partial issuance;
unsafe compensation; unavailable reread; conflicting publication; and
packaged Skill/command discovery.

For multi-repository composition, use A/B positive operations and cross-target
negative attempts, rename with stable identity, concurrent Sessions,
restart, shared-versus-dedicated App binding, rotation, and disconnect.

For remote composition, prove the real public ingress into separate owner
processes, wrong issuer/Relay/repository/App/task/request denial, expiry/replay,
Runtime offline/reconnect, and absence of GitHub user credentials downstream.

### 10.4 Evidence classes

Source tests, compiled tests, installed package, real process transport,
actual browser, deterministic provider, and live GitHub/deployment proof are
separate classes. A separate temp directory is not proof of a separate host.
A mocked GitHub response is not a live provider success.

Missing prerequisites are blocked/not checked, never passed.

## 11. Verification ownership

Reuse the same revision-bound build/package only when its identity and
producer are proved. Avoid concurrent writers to shared outputs. A cache hit
or older tarball is not evidence for the current candidate.

Routine verification retains its required installed/runtime negative proofs
but must not reach release-preparation certification. Release and live
operational certification have explicit separate entrypoints/authority.

See [Verification Architecture](./VERIFICATION_ARCHITECTURE.md) for the suite
ownership and timing/evidence rules.

## 12. Convergence and review gate

Preserve the existing Core, Saga, model coverage, and Setup owner foundations.
Migrate identity and public owner seams, then compose local and remote paths,
then retire competing implementations. Do not rebuild completed foundations
or use a helper-only success stub to replace an unimplemented connection.

The architecture review asks whether each stage has one owner, whether every
public state/action is evidence-derived, whether Source/task/publication are
unambiguous, whether credentials stay with owners, and whether every partial
failure has a safe next step.

The delivery review additionally requires exact-candidate execution evidence.
Documentation completion and an Issue closed flag are not Golden Path
certification, release readiness, or permission to merge.
