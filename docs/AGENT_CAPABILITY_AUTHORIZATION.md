# Caller Authentication and Capability Authorization

Status: normative target under [Product Architecture Canon](./ARCHITECTURE.md).

This document retains the detailed trust, delegation, attenuation, replay,
provenance, and threat contracts of the earlier Session architecture. It
replaces the requirement that every remote caller bring a Session private key
and reach an independent Direct App executor. Existing wire formats are
identified separately from the target remote invocation contract.

The target is not claimed implemented by this documentation change. Current
code and certification remain revision-bound evidence.

## 1. Purpose

Coding agents must not need reusable GitHub provider credentials to perform
governed repository work. Inari separates caller evidence from provider
execution authority and admits only the semantic operation justified by the
caller's actual authorization and current repository state.

There are two normal caller-evidence profiles:

- local delegated work uses Authority-signed LocalSessionBinding and the
  Admission-owned Session lifecycle;
- remote human-operated clients use a Hosted-signed Repository Access
  Assertion and Runtime-side subject/operation admission.

A trusted local operator additionally has explicitly authorized bootstrap and
control operations. That operator profile is not granted by knowing a Relay
URL, possessing a repository visibility assertion, or running on loopback.

The common outcome is an admitted semantic request reaching user-owned
Executor. No profile may bypass Core planning, effect authorization, or
postcondition verification.

## 2. Product responsibilities

GitHub owns repository facts and provider-enforced state. Protected repository
Canon defines repository policy and trust. Inari Core interprets contracts and
plans bounded operations.

Authority owns delegation-signing material. Admission authenticates supported
caller evidence and evaluates capability/task/operation authorization.
Executor owns Inari Access credentials, repository/App binding, provider
observations, and admitted effects.

Hosted authenticates through the Inari Access user authorization profile and
attests caller/repository eligibility. Relay authenticates the Runtime's
transport connection and delivers bounded requests. Neither issues Inari
capabilities or decides task execution legality.

A signature proves that a key signed bytes. Trust in the signer, scope,
freshness, current repository evidence, and the requested operation are
separate checks.

## 3. Relationship to other contracts

### 3.1 Change lifecycle

[Change Control Plane](./CHANGE_CONTROL_PLANE.md) owns Source Change identity,
canonical publication, issuance, ready, abort, merge composition, idempotency,
and recovery. Authentication does not redefine those operations.

A Source Change is not the Session task. A Session task is the Implementation
and its exact current authorization. The binding between them is explicit,
not equality of Issue numbers.

### 3.2 Artifact semantics

[Semantic Artifact Contracts](./SEMANTIC_ARTIFACT_CONTRACTS.md) owns effective
contracts, supplied/derived/fixed values, relationships, desired projections,
and mutation plans. Caller evidence does not carry another copy of those
rules.

### 3.3 Lifecycle Controller

[XState](./XSTATE_CHANGE_MACHINE.md) implements operation sequencing and
recovery. Capability admission precedes effects; it does not become a second
state machine or a persisted Change store.

### 3.4 Provider boundary

[Inari Access](./INARI_ISSUER_APP.md) defines the bounded read and effect
capabilities. A caller's OAuth credential is not used by Executor for normal
mutations, and installation credentials never become caller credentials.

### 3.5 Interfaces

CLI, MCP, Console, HTTP, and Relay bind these contracts to input and transport.
They do not select weaker authorization semantics. Direct App is retired as
an independent execution profile.

## 4. Trust topology

Local delegated work:

```text
protected repository trust and policy
  -> Authority signs bounded local Session binding
  -> Admission validates current trust, binding, task and capabilities
  -> Executor observes repository evidence through its read capability
  -> Core plans and Lifecycle Controller sequences the admitted operation
  -> Inari Access applies bounded provider effects
  -> authoritative reread and verification
```

Remote human-operated work:

```text
GitHub user authorization through Inari Access
  -> Hosted verifies caller and exact repository/installation eligibility
  -> Hosted signs a short-lived request-bound assertion
  -> GitHub user credential is discarded, not relayed
  -> Relay delivers to the authenticated Runtime connection
  -> Runtime verifies the configured assertion issuer and exact binding
  -> Admission evaluates subject, operation, target and current policy
  -> the same Executor/Core/effect/verification composition
```

The assertion is not a Hosted-issued Inari Session. The client receives no
Runtime Authority private key, installation token, shell access, or arbitrary
filesystem/network capability.

## 5. Credential and state ownership

### Delegation credential

Authority holds the long-lived delegation private key. Public trust records
contain the public key, status, validity, and maximum delegable scope. The
private key never goes to Hosted, Relay storage, an agent child, or Executor.

### Local Session binding

Admission owns the local Session record and its active/closed lifecycle.
The binding is Authority-signed and includes task, repository, claims, and
validity. It is not Session Certificate V1 and contains no Agent private key.

A Session identifier is a locator for that binding, not a secret that replaces
authenticated transport or current authorization.

### Certificate/PoP compatibility material

Where a supported legacy reader consumes Session Certificate V1, the
certificate binds an ephemeral public key. The associated private key remains
with its client-side signer. A credential bundle containing that key is
secret; the certificate alone is not sufficient for PoP authentication.

Keeping a decoder does not retain the retired Direct App engine or make
manual secret-bundle transfer the remote Golden Path.

### Provider credential

Executor holds the Inari Access private key and obtains short-lived,
repository-scoped installation credentials. Only bounded read/effect
capabilities leave the broker; tokens and generic authenticated clients do
not.

App-scoped custody may intentionally serve multiple repository bindings.
Repository registration is not permission to copy that App key into each
repository's configuration.

### Hosted authentication material

Hosted may hold service-owned OAuth client secrets and assertion-signing keys.
GitHub user access tokens, refresh tokens, callback codes, and PKCE verifiers
are transient authentication material. They are not durable user accounts or
repository membership state.

These values must not be forwarded to Runtime, serialized into Relay jobs,
placed in URLs, logs, traces, crash evidence, or browser persistent storage.
Discarding a token is not the same as cryptographically revoking it. An
implementation must not claim immediate provider revocation merely because
its in-memory reference was released.

### Relay transport credential

The user-owned Relay client keeps its own transport keypair. Hosted verifies
possession and derives the corresponding public locator. Delegation and App
keys are not reused as Relay credentials.

### Operational state

GitHub owns repository/Change facts. Admission owns local Session lifecycle.
The runtime lifecycle owner owns process/discovery state. Relay may retain
bounded delivery and replay state with explicit expiry. An actor snapshot,
UI stage, or log line is not an alternate state authority.

## 6. Repository-native Runtime trust root

### 6.1 Canonical location and content

The existing public trust-record location is:

```text
.github/inari/authorities/<authority-id>.json
```

A trust record contains the Delegator identity/public key and governed
validity, status, maximum Session TTL, and capability ceiling. A bare public
key file cannot replace these policy dimensions.

The exact serialized format is validated by the current Delegator contract.
A reader must reject unsupported versions, malformed key material, unknown
security fields, and identity disagreement rather than ignoring them.

### 6.2 Authoritative ref

Mutation admission reads trust and authorization policy from the configured
protected canonical ref. The normal default is the repository default branch.
It records the resolved ref and immutable commit used as evidence.

The agent's working branch is not a source of trust keys or a way to enlarge
its own authority. A valid key on an untrusted branch is not a trusted key.

### 6.3 Bootstrap

Adding the first public key is an explicit trust-root operation. The new key
cannot authorize its own registration.

Setup may prepare or publish the exact public record through the existing
operator-authorized path. Independent human review/merge and protected-ref
reread establish repository trust. A successful PR publication is not trust.

The App-user bootstrap credential remains a separately owned operator input;
normal Executor operation does not fall back to it.

### 6.4 Self-escalation prevention

Ordinary delegated writes must not modify their own trust roots,
authorization policy, or privileged execution definitions. Protected-path
restrictions are in addition to task WRITE/CREATE/DELETE scopes.

A signed request cannot override these restrictions. A broad provider
permission such as contents write is not a semantic grant to change them.

### 6.5 Rotation

Rotation is staged:

1. prepare a candidate key at Authority;
2. publish the new public trust record through governed review;
3. establish the explicitly authorized overlap;
4. move issuance to the verified candidate;
5. revoke/retire old trust through the same independent boundary.

A Setup rerun must not regenerate the key, alter identity, change validity, or
widen the capability ceiling as a repair for a mismatch.

### 6.6 Revocation

Removing or disabling a trust record prevents subsequent admitted mutations
under that delegation once current trust is reread. Read failure is denial,
not permission to reuse stale trust indefinitely.

A cache optimization must preserve the explicitly accepted freshness and
revocation contract. This renewal does not grant an unbounded cached-trust
window.

Revocation of delegation, closure of a local Session, rotation of an App key,
and expiry of a Hosted assertion are different events. One does not silently
rewrite the others.

### 6.7 Repository enforcement

Trust-root publication requires the applicable Runtime Authority Governance
check and independent human approval under actual repository policy.
Configured Rulesets and their operation are distinct from product validation.
The presence of a validator or document does not prove live enforcement.

See [Delegator Operations](./DELEGATOR_OPERATIONS.md) and the read-only
operational backlog audit before making enforcement claims.

## 7. Delegator

### 7.1 Signing semantics

The current delegation profile uses Ed25519. Authority signs only an admitted
bounded delegation/provenance payload with its domain-separated format.
It is not a general signing oracle and does not authenticate arbitrary remote
GitHub effects merely by signing their bytes.

The public signing port does not return the private key. Hosted never uses
that key to attest GitHub caller identity.

### 7.2 Storage

Authority uses owner-controlled restrictive storage. Key loading verifies
format, identity/fingerprint, file ownership, permissions, and the applicable
safe-filesystem contract.

Generic Setup configuration stores only public identity references. No key
path is used as a cross-host component-binding contract. An external secret
manager may supply owner material, but Inari does not become a general
secrets-management product.

### 7.3 Attenuation

For a delegated Session S and trusted Authority R:

```text
delegated scope(S) is within ceiling(R)
ceiling(R) is constrained by current repository policy
TTL(S) is no greater than the accepted Authority TTL ceiling
repository(S) is the same immutable repository that trusts R
```

A valid signature outside those bounds is unauthorized.

The ceiling is a maximum, not a grant to every authenticated caller. Remote
repository visibility does not cause Authority to issue its full ceiling.

## 8. Caller-evidence profiles

### 8.1 Local delegated Session

The current LocalSessionBinding has these distinct fields:

```text
version
sessionId
repository
task
capabilities
authority identity and public fingerprint
iat / nbf / exp
signature
optional signed branchObservation
optional signed implementationBinding
```

`src/local-control/session-binding.ts` is the exact versioned byte/validation
reference. It uses an Authority signature and does not accept an Agent Session
private key. The schema-only public key used internally for shared vocabulary
validation is not a real Session key and is not serialized into the binding.

Admission checks current trust, signature, lifetime, repository, Session
lifecycle, task/authorization evidence, capabilities, and the requested
operation. Loading a well-formed local file alone does not prove admission.

### 8.2 Remote human-operated invocation

The remote client authenticates through Hosted and submits the selected
repository and Inari request. Hosted sends only the signed eligibility
assertion plus the bound request over Relay.

Runtime validates the assertion as specified in
[Repository Access Assertion](./REPOSITORY_ACCESS_ASSERTION.md). Executor
checks the asserted App/installation/repository against its current binding.
Admission then requires the actual subject/operation authorization.

No new Hosted Session issuance handshake, client-generated ephemeral key, or
secret credential bundle is required by this profile.

This profile authorizes Inari protocol operations only. It is not SSH, a VPN,
a raw GitHub API tunnel, arbitrary command execution, or access to owner
configuration directories.

### 8.3 Retained certificate/PoP readers

Existing serialized certificates and signed request envelopes may remain
readable through a bounded compatibility adapter. Their signature, proof,
expiry, repository, task, and current-policy checks remain intact.

A managed legacy signer generated its ephemeral key locally and supplied only
the public key for issuance. A manual legacy bundle also contained the
private key and therefore required secret handling. These describe existing
material and its threat model, not a second normal cloud-client bootstrap.

A retained reader must have a supported consumer, exact version, negative
fixtures, and a canonical output. It must not route into an independent
provider executor or automatically issue new legacy authority.

### 8.4 Client name is not principal identity

A client implementation name is provenance metadata, not a principal.
Two invocations from the same client product do not become the same Session
or GitHub subject. A local process name, username string, or Relay connection
label is not verified caller evidence.

### 8.5 Read and operator profiles

Pure validation/rendering of already supplied data needs no mutation grant.
Private repository reads use a bounded read authorization path, not a
fabricated `change.implement` claim.

Enrollment, delegation, trust publication, configuration changes, reviews,
and merges retain their own authority boundaries. Remote identity does not
implicitly make the caller a local operator.

An authenticated local operator is distinct from both a delegated local
Session and a remote Repository Access Assertion. Local authentication
identifies the operator; it does not by itself grant Source or Epic
integration publication authority, and the local path does not require GitHub
OAuth.

The local operator subject is the immutable key ID of an operator public key
enrolled in the Runtime owner's versioned operator-key registry. The Runtime
owner controls enrollment and revocation. A local CLI or browser proves
possession of the matching operator-held private key by signing a fresh
Runtime challenge. The challenge binds the Runtime audience, a nonce, time,
and the requested authentication context. The Runtime owner authentication
seam verifies the signature against the enrolled public key and rejects
expired, replayed, wrong-audience, or context-mismatched proofs. It passes
Admission bounded authenticated subject evidence for the verified key ID and
challenge context, not the operator private key or a reusable credential. The
private key remains with the operator; Console may relay the challenge and
signed response but does not own or persist the key or other operator
credentials.

Authentication proves the enrolled subject only. Before every privileged
operation, Runtime admission rereads current enrollment and revocation state
and separately evaluates the current exact operation-to-target grant and
repository policy. Missing, stale, revoked, or mismatched evidence denies.
Loopback, an operating-system username, a process label, an anonymous
Setup/Console bearer, and GitHub visibility do not establish the local
operator subject. This proof creates no Source/Epic delegation claim and does
not change the separate provider App credential boundary.

## 9. Session Certificate V1 reference

This section preserves the existing representation contract for bounded
compatibility. It does not make this certificate the target Hosted credential.

### 9.1 Header and claims

The current header uses `alg: EdDSA`, `typ: inari-session+jwt`, and a `kid`
resolving to the trusted Delegator. The versioned claims include:

```text
ver
iss = runtime:<Delegator id>
sub = session:<opaque Session id>
jti
repository.id and diagnostic repository.name
sessionKey (Ed25519 public JWK)
optional task
optional implementationBinding
capabilities
iat / nbf / exp
```

The precise closed schemas and canonical encoding are in
`src/agent-authority/session-certificate.ts` and its codec. Its repository
field is not silently rewritten by this document. The enclosing trusted
provider context must bind the GitHub host so IDs cannot cross host partitions.

Unknown properties, malformed IDs, header/issuer disagreement, invalid
capabilities, noncanonical encoding, unsupported algorithm/type/version, and
invalid time values fail closed. A decoder's structural success is not
signature verification or live authorization.

### 9.2 Confidentiality

A certificate without its associated private key does not authenticate a PoP
request. It still contains identity/task metadata and must not be gratuitously
logged or publicly retained.

A bundle containing the private key is confidential even if its certificate
is public. No certificate statement makes a bearer token non-secret.

### 9.3 Validity

The certificate is valid only within its accepted time interval and Authority
ceiling. The current implementation uses an exclusive `exp` boundary.
A request cannot extend expiry by supplying a later timestamp.

Time validation uses the accepted clock-skew and maximum-age contract. A
malformed or absent time does not become an unlimited grant.

### 9.4 No delegation chaining

A Session cannot certify another Session. Retaining a legacy decoder does not
introduce a delegation chain or authorize descendant issuance.

## 10. Session request proof-of-possession reference

A retained signed request binds the certificate identity, repository,
operation, canonical semantic request digest, unique request identity, and
request validity interval.

Canonicalization, hashing, signature input, and domain separation are defined
by the existing codec/request-envelope implementation and byte-level vectors.
No adapter substitutes its own JSON serialization or delimiter convention.

A certificate signature, provenance signature, Relay possession proof, and
request signature cannot substitute for one another.

The verifier checks the request against the certificate's public Session key,
then checks certificate/task/repository/request agreement and current
admission. Signature verification alone does not establish single use.

MCP and HTTP may wrap the envelope without changing signed semantic bytes.
A compatibility adapter returns an authenticated bounded request to common
Admission; it does not bypass that boundary because the older executor once
performed both steps in one component.

## 11. Capability model

### 11.1 Effective authority is an intersection

For local delegated execution:

```text
Session's delegated authority
  intersect current trusted Authority ceiling
  intersect current repository policy
  intersect current Implementation/task scope
  intersect requested operation and current-state admission
```

For remote human-operated execution, the verified assertion establishes
identity/eligibility first. The Runtime operator's current explicit grant in
Runtime-owned owner configuration binds the immutable GitHub user ID and
provider host to semantic operation IDs, an immutable repository ID, and exact
targets. Admission matches that grant to the assertion and request, then
intersects it with current repository/task policy, state, and provider-effect
limits. Hosted eligibility and assertion validity do not supply the semantic
grant.

For local Source or Epic integration branch and Draft PR publication,
Admission separately requires a current Runtime-owned exact grant for each
semantic operation: `branch.create` for the branch and `pullRequest.create`
for the Draft PR. Each grant binds publication role (`source-integration` or
`epic-integration`), immutable repository identity, exact Source or Epic, and
the exact branch/head/base. Neither operation grant implies the other. For
each operation, Admission rereads its grant and current repository, branch,
head, base, and policy evidence, then intersects them before effect. Missing,
stale, revoked, unavailable, or mismatched evidence denies. Executor performs
admitted effects using Inari Access; operator credentials are not stored by
Admission or used for provider execution. These grants do not become a
Source/Epic delegation claim in an Implementation Session. Sessions remain
leaf-scoped, and the existing #1213 bridge remains only for valid same-task
leaf publication through original expiry or reissue.

No later layer adds a permission absent from an earlier required gate.

### 11.2 Semantic rather than provider-shaped

`contents: write`, `pull_requests: write`, and `issues: write` are GitHub
provider permissions. They are not the agent-facing capability vocabulary.
Inari capabilities refer to bounded semantic operations and their exact
subjects.

An App installation permission is a ceiling on possible provider effects.
It does not tell Admission which task, Source, branch, or transition the
caller may request.

### 11.3 Source and task binding

The local #1213 composition retains the Implementation as `task.number`.
It projects a bounded canonical Source set in signed Implementation evidence.
Source lifecycle claims target those Sources; `branch.advance` remains bound
to the Implementation leaf branch.

A Source operation requires membership in both signed and current Source
sets. There is no implicit primary Source. Unrelated, removed, malformed,
cross-repository, or stale Source evidence is denied.

For newly authorized Implementation task Sessions, current repository and
task policy must authorize exact leaf PR publication before Runtime Authority
adds `pullRequest.create` to its capability ceiling and issues the explicit
claim in the Authority-signed LocalSessionBinding. That claim is scoped to
the immutable repository, Implementation task, exact leaf head and accepted
base, and the bound publication request. Admission checks those identities
against current policy and evidence for each operation. Neither the App's
provider permission, a branch name, nor `change.implement` creates the
claim. `branch.advance` remains a separate exact branch-write grant.

The #1213 LocalSessionBinding version 1 task-bound `change.implement` claim
is a legacy input. Its canonical output is only same-task Implementation
leaf PR publication; it is not a `pullRequest.create` claim or an
Implementation-root Change grant. The existing Session launcher is its
producer; capability admission and authorized execution are its consumers.
For an already signed valid binding, those consumers verify its original
signature, trust, task, immutable repository, validity interval, exact leaf
head and accepted base, bound request, and current repository/task policy.
They admit only that same-task leaf publication, never
`change.issue/show/ready/abort/merge` on the Implementation as a Change root
or a branch write through this claim. Existing bindings gain no new grant;
their bridge eligibility ends at original expiry or explicit reissue.

Once the replacement producer is active, new task Session issuance omits
the compatibility claim and signs the exact `pullRequest.create` claim only
under the new ceiling and policy. Keep legacy consumer validation until no
active valid legacy binding can require it and end-to-end tests certify
issuance, Admission, authorized execution, provider publication, and
postcondition verification through the explicit path. Then retire bridge
admission. Historical readers may still classify old binding data.

### 11.4 Branch advancement

Branch writes bind immutable repository identity, exact admitted branch,
current head/generation, target content/tree/commit, validity, task scope, and
protected paths.

WRITE does not imply CREATE or DELETE. A rename may require both creation
and deletion authority. The current canonical scope/projector owns exact
classification; clients and provider adapters do not maintain parallel rules.

A branch-write operation returns bounded evidence, not a reusable token or
an unrestricted authenticated Git client.

### 11.5 Distinct ceilings

Different Authority identities may have different capability ceilings.
Trust in one public key does not imply trust for every operation. A migration
must preserve an existing restricted ceiling rather than resetting it to a
product-wide maximum.

### 11.6 Separately privileged operations

Trust-root changes, repository administration, Rulesets, App installation or
permission changes, default-branch writes, secret management, reviews,
approvals, and merge/release actions are not ordinary implementation grants.

A semantic merge command, an accepted lifecycle state, and permission to
perform the provider merge effect are separate. Unsupported execution is
denied, not redirected to ambient user credentials.

## 12. Authentication, admission, and execution order

### 12.1 Resolve the owner binding

Executor resolves the requested repository and its verified App/installation
binding. It does not accept caller-supplied binding as authority. Repository
name is checked as a locator, not used in place of immutable identity.

### 12.2 Obtain current read evidence

Executor uses its bounded read capability for trust, policy, contract, branch,
PR, and other operation-specific evidence. Admission receives normalized
public evidence, not the read token.

### 12.3 Authenticate the caller profile

Admission validates local binding, supported legacy proof, or the remote
assertion using that profile's issuer, signature, identity, and validity
rules. An authenticated transport peer alone does not select a more
privileged profile.

### 12.4 Validate subject and operation authority

Check current Session lifecycle where applicable, task authorization/digest,
Source membership, branch/base evidence, allowed scope, and requested
capability. Remote invocations also require explicit Runtime subject/operation
authorization. Absent policy is denial, not a default full grant.

### 12.5 Project and plan

Core derives the current semantic state and intended bounded effects. The
Lifecycle Controller selects the legal execution/recovery path. Neither
Hosted nor a browser chooses effect permission or fabricates ready evidence.

### 12.6 Recheck effect preconditions

Governance generation, observed artifact identity, current branch head, and
credential/binding generation are separate preconditions. A valid caller
proof does not make stale effect input safe.

### 12.7 Apply minimum provider authority

The Effect Authorizer obtains the repository- and effect-scoped installation
capability from the broker. It applies only admitted effects and exposes no
token or arbitrary provider operation.

### 12.8 Reread and verify

After a possible effect, reacquire authoritative state and verify the planned
postcondition. A provider 2xx, sent Relay frame, or completed actor alone is
not semantic success.

### 12.9 Return bounded evidence

Return admitted subject/target, operation, safe owner/provider identities,
relevant revision/generation, classified effect result, and verified outcome
or recovery diagnostics. Raw credentials and provider exceptions are excluded.

## 13. Replay, one-shot semantics, and durable state

### 13.1 A signature is not a consumed token

A timestamp, nonce, `jti`, or `requestId` does not prevent replay without the
corresponding verification and atomic consumption/state conditions.
Strict single-use claims require a suitable owner-held fence or proof from
canonical state.

### 13.2 State-derived idempotency

Canonical branch/PR identity, existing Change projection, ready/aborted state,
and expected-head conditions allow deterministic no-op or already-applied
results. Repeating a request must not create another canonical publication.

### 13.3 Conditional advancement

A successful branch advance changes the expected head. Reuse against the old
head fails or returns a proven already-applied result for the exact target.
A name-only lookup cannot replace generation evidence.

### 13.4 Owner-held consumption state

Where a side effect cannot be proven from current repository state, strict
one-shot execution requires explicit durable state at the relevant execution
owner. It must remain bounded and must not become a competing Change or
Hosted Session database.

### 13.5 Assertion and semantic replay are separate

The remote assertion is target/request-bound and consumed under the Runtime
replay contract. The semantic request additionally obeys operation-specific
idempotency and effect fencing. A fresh authentication assertion is not
permission to replay an uncertain old mutation.

## 14. Ambiguous outcomes and recovery

A timeout after a provider request may occur after the provider applied the
effect. It is not evidence that no effect occurred.

The recovery sequence is:

```text
possible effect
  -> authoritative reread
  -> desired state proven: verify and return the existing result
  -> no effect proven: retry only if the operation contract permits it
  -> conflicting/unsafe/unavailable evidence: bounded recovery required
```

Compensation deletes only the exact generation proven safe by its plan.
Abort has its own cleanup semantics. Neither can delete a sibling branch or
advanced work merely to restore a convenient apparent state.

Admission failure before any effect, transport not-delivered, and post-effect
uncertainty remain distinguishable in public diagnostics.

## 15. Deployment and persistence boundary

Normal execution belongs to the user-owned Runtime. Hosted provides
transient authentication/attestation and Relay. No independent Direct App
execution deployment remains a target.

Hosted needs no durable user profile, repository membership, Runtime
registration, or semantic Session database. Service configuration and
service-owned secrets remain necessary. Bounded OAuth flow state, connection
attachments, rate-limit/replay fences, and delivery records are lifecycle
state, not a promise of zero state.

The local Admission Session store remains valid and necessary. Removing a
central Hosted Session database does not remove the owner's local lifecycle.

TLS to Hosted plus TLS/WebSocket to Runtime is not end-to-end encryption
against Hosted. Hosted can observe transiting data at termination. The target
claims bounded custody and no credential forwarding/persistence, not immunity
to a malicious authentication issuer.

## 16. CLI and Runtime responsibilities

CLI and Control invoke existing owner ports for identity generation,
enrollment, trust preparation, Session admission, and observation. Exact
commands come from the installed command contract, not duplicated prose.

Ordinary CLI and browser modules must not load sibling private custody
implementations. Composition may wire owners but cannot parse or retain their
private material.

Mottainai or Nawabari integration consumes the same contracts; it receives no
special issuer privilege. Agent environment construction must not copy
Authority, App, Control mTLS, or Hosted secrets into a child process.

## 17. Provenance

Retain the distinction between:

- repository trust owner and current policy ref/SHA;
- caller profile and authenticated subject;
- assertion issuer and assertion/request identity for remote calls;
- Delegator and local Session for delegated calls;
- Implementation authorization digest and selected Source;
- exact branch/base/head and publication role;
- Executor, App, installation, and credential generation;
- implementation commit authors;
- reviewer, approver, and merger.

The App actor on GitHub is not proof that the App was the requester. A client
product label is not a cryptographic identity. Logs record bounded provenance,
not signed raw payloads or credentials.

## 18. Threat model

### 18.1 Delegation-key theft

An attacker may issue delegation within that Authority's trusted ceiling until
revocation is observed. Restrictive custody, narrow ceilings, short Session
lifetimes, and current protected-ref reads limit exposure. The key is not a
GitHub credential.

### 18.2 Local Session misuse

A compromised agent may exercise its own admitted scope. Task/Source/branch
binding, expiry, current contract reads, Session closure, and protected paths
limit it. A Session ID alone must not cross another operator/transport trust
boundary.

### 18.3 Legacy Session-key or bundle theft

The attacker obtains that Session's remaining authority, not delegation
rights. A bundle is secret because it contains the private key. Certificate
capture alone does not satisfy the retained PoP verifier.

### 18.4 Replay

Captured requests or assertions may be resent concurrently or after a crash.
Atomic replay consumption, current-state idempotency, request binding,
expected-head conditions, and bounded validity must compose. A timestamp
alone is insufficient.

### 18.5 Cross-repository confused deputy

A proof for repository A must not execute against B. Check provider host,
immutable repository ID, assertion/local binding, selected Source/task,
Executor App/installation binding, and requested effect together.

### 18.6 Rename, transfer, and name reuse

A name is not durable identity. Reobserve host/ID and current App installation.
A display-name change does not create another repository or silently preserve
a binding whose provider authorization changed.

### 18.7 Policy-ref substitution

An agent-controlled branch must not supply its own trusted key or policy.
Protected-ref evidence and its resolved SHA remain explicit.

### 18.8 Self-registration

A newly generated key cannot install its own trust. Ordinary delegated writes
cannot alter trust roots or approve their own trust PR. Human/provider
approval boundaries remain independent.

### 18.9 Broad App permission

An installation credential can be more powerful than a caller grant. The
broker's minimum scope and Effect Authorizer's closed effect set prevent
ordinary code from turning caller eligibility into arbitrary GitHub actions.
App permission alone does not enforce every Inari semantic restriction.

### 18.10 Direct-path bypass

An independently supplied PAT or administrator credential is outside Inari's
ability to constrain its owner. Repository protection, provenance checks,
credential hygiene, and execution isolation remain defense in depth. Do not
claim the retirement of Direct App prevents all out-of-band GitHub access.

### 18.11 Inari Access private-key compromise

An attacker may obtain provider authority up to the App's installations and
permissions without following Inari admission. Executor isolation, minimum
permissions, rotation, provider audit, and repository protection are required.
This remains the principal provider-level secret.

### 18.12 Hosted assertion-signer compromise

An attacker can forge the identity/eligibility facts for which Runtime trusts
that issuer. A valid signature cannot detect a dishonest issuer. Request and
Relay binding, short validity, explicit issuer trust/revocation, and independent
Runtime subject/operation admission limit the consequences; they do not
eliminate that trust assumption.

### 18.13 Transient OAuth-token compromise

A GitHub App user token is limited by both user and App access, but can carry
write permissions when both have them. Hosted's verification code must use
only the needed identity/eligibility reads. Calling it an authentication token
does not make it cryptographically read-only.

No persistence/forwarding reduces retention and downstream exposure, not the
impact of theft during the bounded authentication window.

### 18.14 Relay impersonation and connection replacement

A caller cannot claim another public locator without proving its transport
key. Challenges bind the intended service and connection context. Concurrent
connections/reconnects require explicit ownership and generation rules; last
arrival is not an authorization rule.

### 18.15 Cross-Runtime replay and payload substitution

An assertion for Relay A or request X cannot authorize Relay B or request Y.
Runtime verifies the signed target and canonical request binding, rather than
trusting Relay-added plain user-ID headers.

### 18.16 Transport and storage disclosure

TLS termination does not hide payloads from Hosted. Logs, traces, queue
records, error bodies, and retained artifacts must have explicit allowlists.
Bounded delivery metadata excludes user credentials and semantic payloads.

## 19. Security invariants

Delegation, caller proof, transport proof, and provider credentials are
separate domains. Current repository policy constrains every semantic effect.
Trust-root modifications are outside ordinary task authority. A valid proof
for one repository/task/Relay/request does not authorize another.

Read-only eligibility is not a mutation grant. Unsupported authority, stale
binding, malformed proof, unreadable trust, unknown execution outcome, and
missing policy fail closed with bounded diagnostics.

All normal provider effects use Executor-owned Inari Access. All success
claims require verified postconditions. No network location changes those
rules.

## 20. MCP and old ingress classification

MCP remains a typed protocol adapter. Hosted MCP does not run a second
semantic executor, acquire provider credentials, or issue Inari Sessions.
Local pure tools may use Core on already supplied data; private reads and
effects retain their respective authorization gates.

The independent Direct App endpoint and old Hosted repository/work backend
are retired target architectures. Existing format readers do not justify
retaining their execution engines. Actions, where a real supported adapter
remains, cannot become a second trust or lifecycle authority.

See [Native MCP](./NATIVE_MCP_ISSUER_GATEWAY.md) for catalog and transport
boundaries, not a second authorization model.

## 21. Migration and proof

First fix the Source/task/publication joins and caller-evidence contract at
common Admission. Preserve the current local path while adding remote
assertion verification and subject/operation admission under explicit scope.

Then route Hosted delivery into that common path, prove provider binding and
credential isolation, and retire independent Direct App composition and its
public selection flags. Preserve shared cryptography/Core/effect helpers
needed by the canonical Executor.

For each retained legacy representation, record its version, consumer,
canonical output, validation, and retirement condition. Never reinterpret
old stored identity or destroy private keys/configuration during a read.

Certification must include positive and denied local/remote operations,
wrong repository/Source/task/App/Relay, expired/revoked trust, replay,
post-effect ambiguity, restart, credential leak negatives, and actual packed
public-path composition. Fixtures cannot substitute for live-provider proof.

## 22. Implementation discretion and reserved changes

Internal module layout, bounded data structures, and implementation libraries
may change within the accepted contract. Exact existing wire bytes remain
versioned, tested interfaces.

Changes to issuer trust, subject authorization, permission mapping, key
custody, signature domain, replay semantics, compatibility, or remote
bootstrap are architecture changes. Implementers do not invent them to make
a missing producer seam disappear. The remote subject decision is a Runtime
operator grant for exact immutable GitHub user IDs, semantic operation IDs,
and targets in Runtime-owned owner configuration. Admission consumes only a
current grant, intersected with current repository and task policy. Missing,
stale, revoked, or mismatched host/user/repository/operation/target grants
deny; usernames and Hosted eligibility cannot replace them.

Dedicated-App Hosted OAuth registration/callback/client authentication and
the Runtime owner grant producer/Admission consumer require explicit
implementation contracts before those paths can be advertised as complete.
Their absence must not be hidden by accepting arbitrary callback metadata or
granting every visible repository full App authority. Hosted does not issue
semantic grants or hold the Runtime owner configuration.

## 23. Completion condition

The domain is complete when every supported caller profile reaches common
Admission, every grant is bounded by current policy and binding, provider
credentials stay at Executor, and all reachable denial/recovery cases are
proved at their actual interface boundary.

Publishing this document establishes the target and preserves its detailed
security contract. It is not evidence that those migrations, live settings,
or end-to-end certifications have passed.
