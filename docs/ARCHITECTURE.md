# Inari Product Architecture Canon

Status: architecture-owner-approved target, 2026-09-27.

This document is the product-level architecture authority. It replaces the
older vocabulary-only role of this file. Domain documents retain the detailed
contracts identified below; they are not replaced by this overview.

Implementation observation baseline:
`0cad71cf9f1b06597e0cba7f43918df2d1dd81b0`.
Documentation approval does not certify that the target is implemented,
packaged, deployed, or enabled in repository settings. The convergence ledger
in [Architecture Convergence](./ARCHITECTURE_CONVERGENCE.md) separates those
claims.

## 1. Product and completion goal

Inari is a deterministic, repository-native GitHub governance product. It
resolves repository-owned contracts and current evidence, admits explicitly
authorized semantic operations, applies bounded provider effects, and verifies
the resulting state.

The product is not a general `gh` wrapper, an arbitrary remote shell, a
credential distribution service, or an agent scheduler.

The target is one product and one distribution with several interfaces and
placement options. A local CLI, local Console, remote MCP client, and optional
remote UI consume the same semantic and authorization contracts. Network
location does not select a different governance engine.

Completion means that the accepted public paths are continuously usable from
onboarding through verified operation and recovery. Merely implementing
individual ports, closing Issues, passing isolated unit tests, or publishing
this document does not establish product completion.

## 2. Architecture change authority

### 2.1 Reserved decisions

The product owner and the explicit architecture-design review own changes to:

- product responsibilities and non-goals;
- semantic identities and their relationships;
- authorization, credential custody, and trust boundaries;
- public contract meaning and compatibility guarantees;
- persistent-state ownership;
- operation, failure, retry, recovery, and revocation semantics;
- supported deployment and transport guarantees;
- the boundaries that verification must prove.

An implementation worker may propose such a change, but may not approve it
implicitly by editing a schema, changing a test, or making a failing operation
succeed through another credential or execution path.

### 2.2 Implementation discretion

Within the accepted contract, implementers choose functions, modules,
non-public types, algorithms, internal data structures, and focused tests.
They may remove duplicate implementation and improve efficiency without
changing the owned meaning or observable guarantees.

A new file is not inherently an architecture change. A one-line fallback that
moves authority or widens permission is an architecture change.

A concrete contradiction is reported with the affected contract, reachable
behavior, and smallest required decision. The worker does not silently choose
between incompatible authorities or turn an implementation inconvenience into
a new requirement.

### 2.3 Authority and evidence

The latest explicit owner decision governs this renewal. This Canon fixes the
accepted product architecture; subordinate documents fix domain details;
accepted Issues specify bounded delivery against them. Code, schemas,
validators, tests, and live provider state establish what actually exists.

Existing behavior is not automatically correct because a test preserves it.
Conversely, a target paragraph does not change a running wire contract. A
contract change requires its explicit migration and proof.

A normal Implementation Issue cannot override this Canon. An approved
architecture amendment updates the affected Canon and domain clauses as part
of its declared scope before dependent implementation relies on it.

## 3. Architectural vocabulary

### Role

One responsibility or decision owner. A Role describes what is owned, not
which process performs it.

### Component

A module, process, or service implementing one or more Roles. Co-location
never merges credential domains or permits unauthorized private imports.

### Principal

An authenticated identity. Authentication establishes who or what is present;
it does not by itself establish repository trust or semantic permission.

### Repository authority

GitHub owns GitHub repository facts and provider-enforced state. Protected
repository Canon is the source for repository-specific policy and trust.
A Runtime, App, transport, or XState actor is not that authority.

### Runtime Authority / Delegator

The existing Runtime Authority name denotes the delegation-signing Role. Its
key issues bounded delegation or admitted provenance. It is not a GitHub
provider credential, transport identity, or repository state store.

### Canon

Authoritative governed rules or data. Product Architecture Canon and a target
repository's `.github/inari/` Canon serve different scopes. Neither is an
executing service.

### Port and adapter

A Port is a bounded, transport-neutral contract. An adapter binds it to a
protocol, provider, process, or presentation. Sending a request does not make
an adapter the owner of its semantics.

### Runtime Host and deployment

A Runtime Host is the compute environment. Deployment chooses component
placement and transports. A deployment cannot invent different operation
meaning, repository identity, or authorization policy.

### Observation and semantic projection

An operational observation normalizes bounded provider or owner evidence.
A semantic projection interprets admissible observations with current Canon.
Neither owns provider truth or performs effects.

## 4. Stable product decisions

The identifiers below are references for domain documentation and the backlog
audit, not a second machine-readable policy language.

### ARC-01: one semantic execution architecture

All normal provider-changing operations converge on user-owned Admission and
Executor. Local and Hosted inputs differ before that boundary, not in Core
planning, lifecycle, effect authorization, or postcondition verification.

Pure computation on already supplied contracts may run locally without
provider access. Private repository observation still requires its own read
authorization; it is not made public by calling the operation read-only.

### ARC-02: Source, task, publication, and integration are distinct

A Source Issue defines an outcome. A Change is rooted in the selected
canonical Source. An Implementation is a bounded execution contract that may
contribute to more than one Source. A Session task, leaf branch, leaf PR, and
execution evidence bind to that Implementation and its current authorization.

Source Change publication and Implementation leaf publication are different
objects. An Epic is a composed tracking/integration boundary, not an
Implementation Session.

An authorized independent reviewer finalizes the repository-owned, versioned
Source acceptance record for the exact composed Source candidate. It binds
immutable repository and Source identities, the governed Source integration PR,
its exact head revision, the current Source criteria version/digest, reviewer
identity and current authority, and an explicit result for each criterion.
The sole reviewer authorization source is the versioned, repository-owned
Source Acceptance Policy on the protected canonical ref. Its immutable GitHub
userId allowlist is bound to repository identity, protected-ref tree/source
digest, and policy generation. The reviewer must be a currently authorized
human independent of the Source requester, Source integration PR author, and
every human author or provider-proven co-author of the complete exact-head PR
commit set. Unresolved identity or incomplete candidate evidence fails closed.
The [Source Acceptance Policy](./SOURCE_ACCEPTANCE_POLICY.md) owns the detailed
reviewer-independence and current-evidence contract.
Current Change `ACCEPTED` policy evidence remains necessary for its Change;
checks, reviews, and merge policy alone do not establish Source criteria
acceptance. Source completion requires the current record and composed
acceptance evidence, not leaf PR success or child Issue closure. The record
grants neither merge nor provider mutation authority.

Task termination is a separate Implementation lifecycle event. Only an
explicitly authorized Runtime operator may finalize a versioned termination
record owned by the repository, bound to the immutable repository, the
Implementation, its current authorization digest, and accepted base evidence.
Aborting a Source Change or closing a Session does not terminate the task.
Closing an Issue or a Session's own abort assertion is not task-termination
authority.

### ARC-03: current evidence limits every grant

A delegated Source operation requires the Source in both the signed
Implementation Source set and the freshly read current Source set. An added
Source does not widen an existing Session; a removed Source is no longer
admissible.

Admission resolves current task-termination evidence for every task-bound
operation, including operations from an already issued Session. A successful
authoritative read showing no termination event means the task is not
terminated; it does not replace other Admission checks. A terminated task
causes its existing Sessions to fail closed. An unavailable, failed, invalid,
or mismatched read denies. Hosted eligibility does not grant the Runtime
operator permission to finalize the record.

For remote human-operated work, Admission intersects a current explicit
Runtime operator grant with current repository and, where applicable, task
policy. The grant binds the immutable GitHub user ID and provider host to
semantic operation IDs, an immutable repository ID, and exact targets. A
grant cannot widen current Implementation authorization, Source membership,
branch/base, execution scope, or effect preconditions.

For local Source or Epic integration branch and Draft PR publication, local
operator authentication is proven by possession of the private key
corresponding to an immutable key ID in the Runtime owner's versioned,
revocable operator-key registry, using a fresh signed Runtime challenge.
The Runtime owner authentication seam verifies the signature, freshness,
audience, context, and replay status, then supplies Admission bounded
authenticated subject evidence for the verified key ID and challenge context.
The operator retains the private key; Admission receives neither it nor a
reusable operator credential. Authentication alone is not mutation authority.
Admission requires a
separate current Runtime-owned exact grant for each semantic operation:
`branch.create` for integration-branch creation and `pullRequest.create` for
Draft PR creation. Each grant binds the `source-integration` or
`epic-integration` role, immutable repository, exact Source or Epic, and exact
branch/head/base. Neither grant authorizes the other operation. For every
operation, Admission rereads its grant and current repository, branch, head,
base, and policy evidence, then intersects them before effect. Unavailable,
stale, revoked, or mismatched evidence denies. Executor performs each
admitted effect as Inari Access without receiving operator credentials.
Local GitHub OAuth is not required. The
challenge binds Runtime audience, nonce, time, and requested authentication
context; expired or replayed proof is denied. Runtime admission rechecks
current enrollment and revocation for every privileged operation. The
operator retains the private key; Console may relay the signed challenge
response but never owns or persists it. Loopback, username/process labels,
anonymous Setup/Console bearer, and GitHub visibility do not establish the
local operator subject. No Source/Epic delegation claim is issued and
Implementation Sessions remain leaf-scoped. The existing #1213 bridge remains
limited to valid same-task leaf publication through original expiry or
explicit reissue. See [Caller Authentication and Capability
Authorization](./AGENT_CAPABILITY_AUTHORIZATION.md) for the proof contract.

The grant role `source-integration` is distinct from the current PR
publication work-identity token `issue-integration`. The `pr-publication`
consumer accepts that token only after validating its Source and Epic
references against current exact routing; the token identifies a publication
and supplies no Admission authority.

For newly authorized Implementation task Sessions, the Runtime Authority
ceiling and Authority-signed Session binding explicitly include
`pullRequest.create` only when current repository and task policy authorize
that exact operation. Admission binds it to the immutable repository, the
Implementation, the exact leaf head and accepted base, the request, and
current policy. Neither `change.implement` nor branch spelling supplies this
grant. `branch.advance` retains its separate exact leaf-branch authority.

An existing valid #1213 signed Session may use its task-bound
`change.implement` compatibility claim only for the same Implementation's
leaf PR publication until that binding's original expiry or explicit reissue.
It gains no new capability and cannot use the claim for an
Implementation-root Source Change operation. Replacement issuance stops the
task-bound compatibility claim; bridge admission retires after no active
valid legacy binding can require it and the explicit publication path has
end-to-end certification. Historical binding readers may remain.

### ARC-04: Hosted authenticates and relays

Hosted authenticates the caller through Inari Access's GitHub App user
authorization profile, verifies the requested repository and installation
eligibility, and signs a short-lived Repository Access Assertion. It discards
GitHub user credentials rather than forwarding them to Runtime.

Hosted does not evaluate Implementation acceptance, choose Inari capabilities,
run the repository semantic engine, maintain a work database, or execute
GitHub mutations.

### ARC-05: assertions attest eligibility, not mutation authority

A signed assertion proves what a configured trusted Hosted issuer attested.
It is not independent GitHub-signed proof and does not make a malicious issuer
trustworthy. Runtime explicitly trusts the issuer for identity and eligibility
facts, then independently performs subject/operation admission.

Repository visibility alone never grants all App write permissions or the
entire Runtime Authority ceiling. The Runtime operator owns the explicit
subject/operation/target grants in Runtime-owned owner configuration; Hosted
issues no semantic grant. Admission accepts a remote invocation only when the
verified assertion matches a current grant and the current repository/task
policy. Missing or revoked grants, stale owner configuration generations, or
a mismatch in provider host, immutable user ID, repository, semantic operation,
or target deny. OAuth success, installation permission, assertion validity,
and display names do not supply a grant.

### ARC-06: Relay identity is a locator

The user-owned Relay client keeps a transport keypair. A stable Relay ID is
derived from its public-key identity. Hosted verifies possession before
associating that ID with a live connection and returning the public endpoint.

The exact byte encoding belongs to a versioned transport contract and its
vectors. A URL, Relay ID, or public key fingerprint is not repository access.
The Relay key is distinct from the Delegator key and the Inari Access key.

### ARC-07: one App concept, separate credential profiles

Inari Access is the GitHub App provider identity. Its user authorization
profile is used transiently at Hosted authentication. Its installation
execution profile is used inside Executor.

There is no separate Endpoint App or Inari Identity App in the target. An App
ID is not a credential, and using one App identity does not permit copying
OAuth credentials into Executor or installation credentials into Hosted.

### ARC-08: Executor owns repository/App binding

Executor resolves and verifies repository-to-App/installation binding. The
binding includes immutable repository identity and exact verified credential
generation/fingerprint. Caller input, a browser return, or an assertion cannot
rewrite it.

A dedicated App per repository is the recommended onboarding choice. An
explicit manual/shared App may serve multiple repositories without duplicating
its private key. App ownership is not the same as repository scope.

### ARC-09: state and secrets have one owner

Repository registry and Setup configuration contain public references, not
owner key paths or secrets. App keys belong to Executor; delegation keys to
Authority; local Session lifecycle to Admission; process/discovery state to
its runtime lifecycle owner.

GitHub remains the source for repository artifact and Change state. XState
snapshots, browser stages, Hosted caches, and logs do not become competing
state authorities.

### ARC-10: recoverable onboarding and operation

Connect, Disconnect, rotation, and recovery compose current owner observations
and actions. Stages are projections, not a second readiness database.
Publication is not trust; component health is not repository readiness;
Session readiness is not execution success.

Identity adoption does not regenerate keys, widen ceilings, or delete old
working state. Destructive actions require explicit intent and current
reference/ownership checks.

### ARC-11: explicit remote Control

Remote component binding uses public owner ports and explicitly configured
endpoint, expected component identity, and transport trust material. Initial
support does not introduce automatic PKI, automatic remote discovery, or a
remote Authority service.

Control observation/management and Admission execution have different route
authority. A browser is not a component mTLS principal.

### ARC-12: schema and syntax are not domain policy

JSON Schema Draft 2020-12 owns generic artifact value shape. Inari owns value
authority, bounded derivation, relationships, provenance, and admission.
Markdown structure comes from the shared mdast/CommonMark/GFM boundary;
Inari preserves free text and interprets its own bounded markers.

### ARC-13: CLI Canon convergence is finite work

CLI Canon owns common command grammar, standard shell, Help, invocation,
Skill linkage, and eligible lexical paths. Inari owns domain semantics and
secure filesystem access. The target includes completion of eligible
migration, not indefinite parallel catalogs or parsers.

### ARC-14: retire competing architectures

Independent Direct App deployment/execution is retired. Old Hosted
repository/work engines and parallel semantic execution paths are removed
when the canonical replacement is certified.

Bounded old-data readers may decode/adopt into the canonical model. They may
not retain an old authorization engine or silently reinterpret identity.
Shared Core, cryptography, or effect code is not deleted merely because its
filename contains a retired profile name.

### ARC-15: verification has explicit proof ownership

Each suite states the invariant and boundary it proves: source, built,
installed package, process, browser, deterministic provider, or live service.
Same-revision build/pack reuse is allowed; stale artifact reuse is not.
Routine verification does not run release-preparation certification.

### ARC-16: delivery uncertainty survives transport failure

Not-delivered, possibly-delivered, execution outcome, and observed
postcondition are different facts. Disconnect, timeout, reauthentication, or
process restart never turns possible execution into safe blind replay.

### ARC-17: extension through existing responsibilities

Extensibility means that a new supported input or placement can reuse stable
ports, semantic identities, and owner boundaries. It does not require a
plugin engine, universal provider framework, generic secrets service,
distributed policy database, or speculative abstraction layer.

## 5. Identity model

The security identity of a repository is `repositoryHost + repositoryId`.
The current `nameWithOwner` is a mutable locator/display value. Numeric IDs
from different hosts must not alias.

An Implementation authorization adds the Implementation Issue identity,
governed-body digest, and explicit base evidence. A Session retains that
binding, a bounded lifetime, capability claims, and applicable branch-policy
evidence.

A Source-root request names the exact Source. Multiple Source references are
an exact authorized set, not an implicit primary Source or multiple PR bases.

Integration routing consumes canonical relationship and accepted base
metadata. Branch spelling validates identity/consistency; it does not invent
parentage. Standalone work does not have to manufacture an Epic.

The detailed joins, completion rules, and compatibility classification belong
to [Implementation Contract](./IMPLEMENTATION_CONTRACT.md) and
[Change Control Plane](./CHANGE_CONTROL_PLANE.md).

## 6. Components and import direction

Runtime contracts are neutral DTOs, validators, and ports. Setup Application
contains secret-free decision/projection logic over those ports. CLI and
Console invoke public contracts and present results.

Admission authenticates caller evidence and performs semantic authorization.
It obtains provider evidence through Executor's bounded public read ports; it
never acquires an App private key or user token.

Executor contains the provider credential broker, repository bindings,
provider evidence adapters, admitted execution composition, and effect
boundary. Authority contains delegation/signing custody only.

Composition wires components and owns the selected process/listener lifecycle.
It is not a private-key parser or an alternate provider authority.

The import guard and detailed port/type ownership remain in
[Runtime Component Boundaries](./RUNTIME_COMPONENT_BOUNDARIES.md).
Module isolation is not operating-system sandboxing. A hostile process with
owner filesystem access remains outside that guarantee.

## 7. Evidence-to-effect composition

The canonical responsibilities remain separate even when co-located:

1. Credential Broker acquires the bounded provider capability.
2. Evidence Reader obtains current, repository-bound evidence.
3. Observation Projector normalizes evidence without I/O or policy.
4. State Projector interprets it with current Canon.
5. Operation Planner produces explicit effects and postconditions.
6. Lifecycle Controller sequences no-op, effect, retry, compensation, and
   recovery paths.
7. Effect Authorizer checks one planned effect at the credential boundary.
8. Effect Adapter performs only that admitted provider operation.
9. Postcondition Verifier compares reread state with the plan.

Executor coordinates this composition; it does not replace the responsibilities
with one generic authority. Pre-admission evidence uses a read-only capability,
not a mutation token and not credentials supplied to Admission.

A provider response proves transport/provider outcome only. A semantic success
requires authoritative reread and a verified postcondition. Unknown reads are
not absence.

## 8. Caller and provider identities

The requester may be a local delegated Session, a remote authenticated human
operating a client, or a trusted local operator on an explicitly admitted
bootstrap/control path. Those profiles are not interchangeable.

The provider actor for normal governed mutations is Inari Access under
Executor custody. Commit author, requester, assertion issuer, Delegator,
Session, App actor, reviewer, and merger remain separately attributable.

Remote clients do not have to receive a Hosted-issued Inari Session or manage
an ephemeral Session key. They submit authenticated Inari invocations, not
shell commands or arbitrary HTTP proxy destinations.

The existing certificate/PoP representation is not silently converted into a
bearer-only format. Any retained representation has a versioned reader and
its original verification requirements before it reaches common Admission.

## 9. Hosted and Relay data boundary

Hosted may transiently observe the user identity, requested repository/App
eligibility, routing target, and the bytes it must authenticate or relay. This
is not a claim of end-to-end payload encryption or of zero metadata exposure.

Persistent service configuration and service-owned signing/OAuth client
secrets are distinct from user credentials. OAuth access/refresh tokens,
callback codes/verifiers, raw provider responses, and assertion/request bodies
must not enter persistent user stores, logs, traces, or retained evidence.

Relay owns live authenticated connections and bounded delivery records with
expiry. It has no permanent Runtime-registration, user, repository-membership,
Session, or semantic-state database. Necessary replay/delivery fencing is not
eliminated by calling the service stateless.

The public endpoint remains stable while the Runtime retains its transport
identity. A transport key rotation changes that identity unless an explicitly
approved migration proves otherwise. No automatic alias or forwarding trust is
inferred from a repeated Runtime name.

See [Hosted Relay](./HOSTED_RELAY_DEPLOYMENT.md) and
[Repository Access Assertion](./REPOSITORY_ACCESS_ASSERTION.md).

## 10. Operator experience

One machine-scoped Console serves independent repository contexts. Setup,
Runtime, trust, Session observation, and diagnostics use the same owner APIs
as the CLI. An optional Hosted UI is a remote presentation client, not a
second product backend.

Connect resolves repository identity, creates or adopts the selected App,
enrolls keys at their owner, verifies installation, prepares/adopts Authority,
publishes trust, waits for independent human approval, rereads the protected
ref, and proves the distinct readiness dimensions.

Manifest conversion occurs at Executor so one-time App private material is
born inside its custody boundary. Generic Setup JSON and the browser do not
become secret stores.

Disconnect first prevents new relevant work and resolves active Sessions.
Shared App or Authority identities are never deleted because one repository
is detached. Rotation verifies a candidate before switching and retiring old
access.

## 11. Representation and public interfaces

Repository authoring remains portable JSON. Effective contracts and semantic
artifacts are deterministic compiler products. Native Issue Forms, PR
Markdown, UI widgets, MCP results, and CLI output are projections.

A valid semantic schema may be unsupported by a presentation capability. That
is a bounded projection failure, not permission to discard content or invent
new semantics. Free-text observation preserves original source slices.

CLI Canon migration covers common mechanics only. Inari filesystem ownership,
mode checks, no-follow access, private material limits, and authorization do
not move to Path Canon.

## 12. Other product boundaries

Nawabari owns local worktree/process/filesystem isolation. Inari supplies
bounded contracts, branch identities, and admission results without becoming
the local isolation engine.

Mottainai owns agent scheduling, orchestration, and context management. It may
consume the ready frontier and execution results but does not define Inari
artifact meaning or governance.

Wabachi may provide architecture/design evidence. It does not replace the
explicit architecture-owner approval or Inari's repository lifecycle.

Suzukuri may supply bounded verification projections. It does not decide
whether a Source or Epic is complete. CLI Canon owns common CLI mechanics,
not Inari permissions or provider behavior.

## 13. Domain documentation ownership

- [Caller Authentication](./AGENT_CAPABILITY_AUTHORIZATION.md): trust,
  delegation, local/remote caller evidence, attenuation, replay, and threats.
- [Repository Access Assertion](./REPOSITORY_ACCESS_ASSERTION.md): Hosted
  attestation, request binding, issuer trust, and remote admission limits.
- [Change Control Plane](./CHANGE_CONTROL_PLANE.md): identity, publication,
  lifecycle, idempotency, compensation, ready, abort, and merge boundaries.
- [Source Acceptance Policy](./SOURCE_ACCEPTANCE_POLICY.md): protected-ref
  reviewer authority, candidate contributor independence, and current use.
- [XState](./XSTATE_CHANGE_MACHINE.md): executable lifecycle/operation control
  flow, bounded actor context, failure edges, and model proof.
- [Implementation Contract](./IMPLEMENTATION_CONTRACT.md): bounded task,
  authorization digest, relations, Session binding, evidence, and completion.
- [Execution Scope](./IMPLEMENTATION_EXECUTION_SCOPE.md): path permissions,
  projection, and separation from physical enforcement.
- [Runtime Components](./RUNTIME_COMPONENT_BOUNDARIES.md): ports, import
  direction, custody isolation, enrollment, and owner observations.
- [Semantic Artifacts](./SEMANTIC_ARTIFACT_CONTRACTS.md): schema, value
  authority, derivation, relation, projection, observation, and reconciliation.
- [Semantic Templates](./SEMANTIC_TEMPLATES.md): repository authoring,
  compatibility compilation, native generation, and discovery.
- [Branch Policy](./REPOSITORY_BRANCH_POLICY.md): repository-owned naming and
  relationship-derived integration routing.
- [Golden Path](./GOLDEN_PATH_ARCHITECTURE.md): continuous local/remote/operator
  composition and exit conditions.
- [Hosted Relay](./HOSTED_RELAY_DEPLOYMENT.md),
  [MCP](./NATIVE_MCP_ISSUER_GATEWAY.md), and
  [Remote Control](./LOCAL_RUNTIME_NON_LOOPBACK.md): transport/deployment
  contracts, not independent semantic policy.
- [Inari Access](./INARI_ISSUER_APP.md),
  [Delegator Operations](./DELEGATOR_OPERATIONS.md), and
  [Ruleset Operations](./BRANCH_CREATION_RULESET_OPERATIONS.md): owner-specific
  security and operational procedures.
- [Verification](./VERIFICATION_ARCHITECTURE.md): proof classes, execution
  ownership, artifact identity, and truthful completion.
- [Convergence](./ARCHITECTURE_CONVERGENCE.md): migration, retained detail,
  implementation gaps, and backlog classification.

Historical release/certification records retain their original revision and
meaning. The explicitly named legacy gateway document is historical material,
not a current authorization or deployment authority.

## 14. Acceptance of the architecture renewal

Every current domain must identify its owner, inputs, outputs, invariants,
failure/recovery behavior, compatibility boundary, and proof obligations.
Renewal removes contradictory authority, not detailed design information.

Later implementation must demonstrate one canonical path for each supported
operation, remove competing authorities for each migrated slice, and prove
both the happy path and reachable denial/recovery cases at the claimed
boundary. Final product certification remains separate from document review.
