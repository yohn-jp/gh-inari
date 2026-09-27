# Architecture Convergence and Documentation Map

Status: migration/planning companion to
[Product Architecture Canon](./ARCHITECTURE.md).

Authority is the explicit 2026-09-27 architecture-owner decision. Observation
baseline is main `0cad71cf9f1b06597e0cba7f43918df2d1dd81b0`.
This ledger distinguishes approved target from implemented, integrated,
certified, and deployed behavior. It is not an automatic Issue-closing list.

## 1. Renewal method

The first compressed rewrite removed too much valid domain information.
This renewal instead preserves contract detail and replaces only conflicting
architecture, repeated authority, and obsolete current-state claims.

A useful domain document contains responsibility, identity, input/output,
invariants, negative cases, recovery, compatibility, and proof obligations.
A short overview cannot substitute for those contracts.

Existing historical release and certification records keep their revision and
meaning. The explicitly historical NATIVE_MCP_ISSUER_GATEWAY_LEGACY document
is retained unchanged; its content is not current authorization guidance.
No product code, schema, workflow, live setting, or Issue is changed by the
documentation renewal itself.

## 2. Detailed retention and replacement map

### Product architecture

ARCHITECTURE becomes the product Canon rather than only a vocabulary glossary.
It preserves Role/Component/Principal/Port/Adapter/Transport distinctions,
provider-versus-caller identity, observation-versus-semantic projection, and
the separate evidence/effect responsibilities.

It adds explicit architecture change rights, ARC-01 through ARC-17 decision
references, full Source/task/publication separation, Hosted/Relay boundaries,
owner state/custody, finite CLI migration, and bounded extension principles.

### Caller authorization

AGENT_CAPABILITY_AUTHORIZATION retains protected-ref trust, bootstrap,
attenuation, certificate/PoP validation, validity/revocation, path/capability
limits, replay, ambiguous effects, provenance, and the detailed threat model.

It distinguishes LocalSessionBinding, the new remote assertion profile, and
bounded historical certificate readers. It removes the requirement for cloud
clients to receive new Session keys and reach an independent Direct App engine.
Privileged local operator identity uses the Runtime owner-enrolled public-key
registry and fresh signed challenge contract. The Runtime owner authentication
seam verifies proof and supplies bounded subject evidence to Admission, which
rechecks current enrollment; authentication remains separate from local
publication grants and repository policy.

REPOSITORY_ACCESS_ASSERTION owns issuer trust, exact request/Relay/repository/
App binding, ephemeral OAuth handling, replay, remote subject authority,
negative proof, and remaining wire/bootstrap integration gates.

### Change and XState

CHANGE_CONTROL_PLANE preserves lifecycle states, canonical publication,
idempotent issuance, conditional generation-safe compensation, abort recovery,
ready/merge admission, provenance, branch enforcement, and verification cases.
It replaces new Implementation-root Change assumptions with distinct Source
and task publication identities.

SOURCE_ACCEPTANCE_POLICY fixes the approved protected-ref reviewer allowlist,
independence against the complete exact-head candidate, and current-evidence
rules. It is the domain contract for bounded policy loading, reviewer
evaluation, and Source acceptance carrier consumption; this documentation
decision does not claim those consumers are implemented.

XSTATE_CHANGE_MACHINE preserves transition parity, operation graphs, bounded
context, actor responsibilities, ready/abort/issuance Saga, error mapping,
non-authoritative snapshots, production graph coverage, and public API
isolation. It does not rebuild the completed machine extraction.

### Task and scope

IMPLEMENTATION_CONTRACT preserves the complete task contract, current generated
command block, immutable authorization digest, lifecycle/conformance,
relationships, path scopes, and review/termination rules. It corrects the
Source/task/publication joins and makes the remaining termination/publication
integration proof explicit.

IMPLEMENTATION_EXECUTION_SCOPE retains exact v1 kind/schema/public API,
canonical serialization, independent operation lists, DENY, lifecycle gates,
and consumer/physical-enforcement boundaries. Schema migration elsewhere does
not silently version this artifact.

### Semantic artifacts and templates

SEMANTIC_ARTIFACT_CONTRACTS retains authority, bounded derivation, relation
identity/direction, repository variance, Effective Contract, materialization,
capability projection, mutation plan/provenance, freshness, reconciliation,
and verification detail.

It replaces duplicate primitive/presence/constraint shape languages with one
Draft 2020-12 schema and top-level bindings, and replaces parallel Markdown
lexers with the shared mdast/source-slice boundary.

SEMANTIC_TEMPLATES preserves exact discovery paths, existing v1 compatibility,
native sync/check/import, selection precedence, compact input, and current
native-provenance requirements while describing explicit target migration.

### Runtime and operations

RUNTIME_COMPONENT_BOUNDARIES preserves catalog/port ownership, five distinct
Setup dimensions, typed/fresh actions, secret-free JSON, streamed enrollment,
transitive/type import guard, empty historical exception ledger, and process
wiring. It includes owner observation, multi-repository custody, and explicit
remote Control without weakening private boundaries.

DELEGATOR_OPERATIONS retains generation, public trust sequence, readiness,
overlap rotation, emergency revocation, backup/destruction, diagnostics, and
compatibility inventory. RUNTIME_AUTHORITY_OPERATIONS remains its pointer.

INARI_ISSUER_APP retains bounded read/effect permissions, broker scope proof,
credential containment, sanitized failures, and separation of duties under
the Inari Access name. It distinguishes OAuth user and installation execution
profiles without a separate Identity App.

REPOSITORY_BRANCH_POLICY preserves policy source/API, bounded derivation,
diagnostics, safe-spelling versus exact binding, alternative naming,
integration routing, and compatibility inventory. It removes old root equality
and Hosted semantic-reader assumptions.

BRANCH_CREATION_RULESET_OPERATIONS retains exact creation-only scope/bypass,
canonical payload generation, staged rollout, verification, and rollback.
It removes an unsupported assertion about today's live settings.

LOCAL_RUNTIME_NON_LOOPBACK preserves dynamic loopback discovery and detailed
TLS/SAN/ownership checks while separating listen address, remote destination,
Control role, and Admission execution. It does not add automatic PKI.

### Public composition and transport

GOLDEN_PATH_ARCHITECTURE retains the finite phase/status/action/recovery
vocabulary, exit consistency, installed-package boundary, complete failure
matrix, and continuous-path proof. It composes the approved local/remote and
operator flows rather than duplicating their semantics.

HOSTED_RELAY_DEPLOYMENT replaces the repository/work backend with transient
authentication/attestation and Runtime Relay. It retains bounded connection,
backpressure, delivery ambiguity, safe telemetry, deployment identity, and
controlled-versus-live certification detail.

NATIVE_MCP_ISSUER_GATEWAY retains typed catalog/projection, protocol and result
boundaries, legacy envelope validation, MCP Apps presentation, and capability
limits. It removes MCP as an independent authorization/execution plane.

CLOUDFLARE_WORKER_DEPLOYMENT classifies the supported Hosted target and safe
retirement of Direct App. It does not disable a live deployment.

### Contributor and verification entrypoints

README, AGENTS, CONTRIBUTING, SECURITY, and the packaged Skill router point to
one Canon and current versioned entrypoints. They do not contain another
branch grammar, command catalog, or permission model.

VERIFICATION_ARCHITECTURE records proof classes, suite ownership, revision-bound
artifact reuse, routine/release separation, negative testing, timing evidence,
and truthful local/CI/live reporting.

## 3. Existing foundations to reuse

The observed code already has Role/port/import boundaries, Setup Application,
XState execution, bounded App broker/effect contracts, current local Session
binding, source-contract parsing, and branch-policy foundations.

The main lineage includes the #1213 Source-set correction. It keeps local task
identity at Implementation while restricting Source operations to signed and
current membership and retaining the bounded publication bridge.

The #1187 producer lineage contains repository registry, App-scoped custody,
Authority identity custody, secret-free Setup adoption, Executor observation,
and component binding work. Physical integration into its Source is not the
same as integration into main or full product certification. Re-pin that
lineage and its checks when auditing/implementing downstream work.

Do not reimplement these producers or assume an Issue closed flag proves the
particular candidate contains them.

## 4. Required convergence domains

### Identity and publication

Audit all producers/consumers of Change root, task authorization, Source set,
leaf publication, Source integration, standalone routing, termination, and
conformance. Local integration publication authenticates the Runtime
owner-enrolled operator key subject before evaluating its separate exact
operation grant. #1213 is an important Local correction, not proof that all
historical Implementation-root joins have been removed.

### Remote authentication and admission

Deliver the bounded Repository Access Assertion wire/crypto contract, explicit
issuer trust and rotation, authenticated Inari Access OAuth configuration,
request/Relay binding, and Runtime replay fencing.

The remote subject-to-operation policy must be explicit and enforce actual
authority. Repository visibility is not an implicit write grant. Do not solve
this by inventing a new client Session-key handshake or forwarding user tokens.

### Dedicated-App OAuth bootstrap

One repository may use a dedicated execution App. Its OAuth client/callback
and service-owned secret registration are not automatically established by
Manifest private-key enrollment. Define and prove that secure integration
without a separate Identity App, arbitrary redirect metadata, or durable user
credential storage.

### Relay transport

Migrate repository-ID routing to stable transport-key-derived Relay identity.
Specify canonical encoding, possession challenge, connection-generation
replacement, bounds, reconnect, and possible-delivery handling. Reuse valid
existing Relay primitives rather than build another message broker.

### Owner APIs and Console

Complete secret-free multi-repository binding and the explicit remote Control
configuration. Session enumeration is an Admission producer used by both
Disconnect and Console; produce it before those consumers to avoid a circular
UI/lifecycle dependency.

Compose Manifest, Connect, human trust wait/recheck, rotation, Disconnect,
unified Console, and bounded observation. No helper pre-seeds ready state.

### Artifact and CLI convergence

Finish the shared mdast readers, independent artifact freshness, safe
single-artifact reconcile, schema-native Effective Contract/materialization,
and lossless capability projection.

Complete eligible CLI Canon migration in bounded route families. The older
indefinite touch-driven instruction must be reconciled with the approved
finite completion target. Domain/security/path access does not move to Canon.

### Retired architecture removal

Remove independent Direct App execution and the old Hosted repository/work
backend after replacement public-path proof. Inventory remaining adapters by
actual consumer and semantics. Old format readability is not a reason for
retaining old authorization engines.

### Verification and operations

Reconcile routine/shared CI duplicate ownership, release-certification
isolation, artifact identity, and browser/runtime proofs early enough to
support subsequent implementation efficiently.

Live Rulesets, OAuth/deployment certification, and shared release-workflow
adoption remain operational/cross-repository gates. Documentation and ordinary
CI cannot close them by inference.

## 5. Dependency order

1. Approve this Canon and reconcile domain/Issue authority without changing
   existing Issue state during the requested audit.
2. Establish current verification ownership and exact producer/main baseline.
3. Fix common identity/publication and remote caller-evidence/owner contracts.
4. Run independent artifact/schema, CLI, owner-observation, and Relay producer
   work where contracts and write sets are independent.
5. Compose onboarding/Disconnect/Console after owner APIs exist.
6. Compose Hosted authentication/Relay into common Admission/Executor.
7. Retire competing architectures only after replacement proof.
8. Certify installed/process/browser paths, then separately certify live
   provider/deployment/enforcement and shared adoption.

This order is a dependency plan, not blanket permission for concurrent writes,
automatic merge, or worker-driven architecture changes. Pin actual producer
revisions and accepted scopes at dispatch.

## 6. Backlog audit classification

The requested audit is read-only. Classify each currently open Issue against
this Canon and its actual implementation/evidence:

- KEEP: the requested outcome remains valid; report actual remaining proof.
- REWRITE: valid outcome but obsolete identity, scope, dependencies, or
  acceptance contract must be updated before dispatch.
- SUPERSEDE: the requested architecture no longer belongs in the target;
  identify what replaces it without silently closing the Issue.
- CLOSE_CANDIDATE: the complete required acceptance has evidence; distinguish
  a candidate recommendation from an actual close.
- VERIFY/BLOCKED: an evidence or external dependency qualifier, not completion.

Report new uncovered gaps separately without creating Issues. A title match,
old audit paragraph, closed child, merged PR, or published version does not
alone prove full acceptance. Separate code, Source integration, main,
packaging, exact-head CI, and live operations.

## 7. Compatibility inventory rule

Each retained adapter states its exact old input/version, canonical output,
consumer, validations, and retirement condition. New work may not select the
old engine. No migration silently re-roots records, widens grants, regenerates
keys, deletes user configuration, or changes live deployment.

Historical evidence remains historical. A disabled public trust record,
release note, old certification, or legacy design is not rewritten to make
new architecture appear already verified.

## 8. Completion gates

Architecture/documentation completion means the owner boundaries and domain
contracts agree and valid detail remains accessible.

Implementation completion means all accepted semantic and interface gaps are
actually delivered with no competing authority for each migrated slice.
Verification completion means the exact candidate passed its required proof
classes. Deployment/enforcement completion requires actual live evidence.

Report these separately. The purpose of the Canon is to make incomplete work
visible and bounded, not to certify it by declaration.
