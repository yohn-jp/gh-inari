# Inari Repository-Native Agent Capability Authorization

Status: proposed normative architecture for Epic #364 and Issue #365. Implementation begins only after this document is merged.

This document extends [`CHANGE_CONTROL_PLANE.md`](./CHANGE_CONTROL_PLANE.md),
[`SEMANTIC_ARTIFACT_CONTRACTS.md`](./SEMANTIC_ARTIFACT_CONTRACTS.md), and
[`XSTATE_CHANGE_MACHINE.md`](./XSTATE_CHANGE_MACHINE.md). It changes the authentication,
delegation, and privileged execution boundary; it does not replace their Change lifecycle,
Semantic Artifact authority, or trusted execution semantics.

[`NATIVE_MCP_ISSUER_GATEWAY.md`](./NATIVE_MCP_ISSUER_GATEWAY.md) is retained as transport
prior art, but its hosted gateway, centralized requester-authentication/admission, and
Actions-as-required-execution assumptions are subordinate to this document where they
conflict. MCP remains a supported protocol/transport, not the trust root.

## 1. Purpose

Coding agents should not need a user's GitHub credential in order to perform governed
repository work.

The common model today is effectively:

```text
Human authority
     |
     | GH_TOKEN / PAT / gh auth / installation token
     v
Agent process
     |
     v
GitHub
```

Even when the credential is short-lived, the agent still receives provider-level GitHub
authority. The blast radius is defined by GitHub permissions rather than by the task the
agent was asked to perform.

Inari instead delegates **repository-change authority**.

A trusted local Runtime may certify that one Agent Session is authorized to perform a
bounded semantic task for one repository and a short period. The Agent Session proves
possession of its own ephemeral key. The Inari GitHub App then uses its GitHub authority
only when the signed delegation, repository policy, and current authoritative GitHub
state all admit the requested semantic operation.

The target property is:

> An agent receives the minimum authority necessary to complete a governed repository
> change, not general GitHub access.

This document freezes the trust model, credential ownership, repository trust roots,
Session Certificate contract, capability attenuation model, execution ordering, replay
rules, threat model, and migration boundary required to implement that property.

## 2. Product definition

For this architecture, Inari is:

> A repository-native semantic authorization plane for AI coding agents.

Inari is not a general identity provider and is not defined by a hosted control-plane
service. It uses GitHub's existing repository and GitHub App authorities while adding a
cryptographic delegation layer whose semantics are repository-native.

The product separates six roles:

- **Repository governance** — declares trusted Runtime Authorities and the maximum
  semantic authority each Runtime may delegate.
- **Runtime Authority** — holds a long-lived delegation key and certifies bounded Agent
  Sessions. It is a delegation principal, not a GitHub mutation principal.
- **Agent Session** — holds one ephemeral Session private key and a Runtime-signed
  Session Certificate. It requests only the authority delegated to that session.
- **Inari Core / trusted executor** — resolves canonical repository semantics, projects
  current state, admits transitions, plans effects, and verifies postconditions.
- **Inari GitHub App / issuer executor** — holds GitHub mutation credentials, verifies
  delegated authority, and applies only Inari-admitted effects.
- **GitHub** — remains the authoritative observable repository state and the provider
  enforcing the App's installation permission ceiling, Rulesets, reviews, and merges.

The architecture intentionally separates **delegation authority** from **execution
authority**.

```text
Repository                         GitHub
    |                                 ^
    | trusts Runtime signer           | App installation authority
    v                                 |
Runtime Authority                    |
    |                                 |
    | certifies bounded Session       |
    v                                 |
Agent Session -> Inari authorization/executor -> GitHub App
```

A Runtime key can delegate. It cannot mutate GitHub.

A Session key can authenticate a delegated request. It cannot create another Session
Certificate.

Only the App/executor can turn an admitted semantic request into a GitHub mutation.

## 3. Relationship to existing Inari architecture

### 3.1 Change remains semantic lifecycle authority

`CHANGE_CONTROL_PLANE.md` remains authoritative for Change identity, canonical Issue /
branch / pull-request projections, lifecycle transitions, idempotency, compensation,
recovery, and provenance.

This document does not silently redefine `change issue`, `change ready`, `change abort`,
or the current invariant that Change issuance is one logical transaction. A future change
to those public semantics requires separate governance.

The capability layer answers a different question:

> Is this Agent Session authorized to request the semantic transition or bounded effect
> that Core already knows how to plan and verify?

### 3.2 Semantic Artifact remains desired-state authority

Repository policy, canonical artifact derivation, branch identity, PR rendering, and
artifact validation remain Core/Semantic Artifact responsibilities. Certificates do not
carry duplicate copies of those semantics.

### 3.3 XState remains execution-control authority

The XState machines remain responsible for lifecycle legality and trusted execution
sequencing. Capability authorization is an admission gate before privileged effects, not
a replacement state machine.

Ambiguous GitHub outcomes continue to use the existing pattern:

```text
request
  -> authoritative read
  -> project
  -> authorize/admit
  -> plan
  -> effect
  -> authoritative reread
  -> verify
  -> result / recovery
```

A network error after an effect never proves the effect did not happen.

### 3.4 GitHub App remains mutation authority

`INARI_ISSUER_APP.md` remains correct that App private keys and installation tokens are
not caller credentials. This architecture strengthens that boundary by also prohibiting
Runtime delegation keys from becoming caller-to-App execution credentials.

### 3.5 MCP and Actions become transports/executors, not trust roots

The native MCP work under #267 remains useful where it defines a typed agent protocol,
transport-neutral boundaries, and App credential containment. It is no longer normative
that Inari must have a central hosted requester-authentication/session service or that
GitHub Actions must mediate every repository operation.

A hosted MCP endpoint, local stdio server, direct HTTPS App endpoint, Actions bridge, or
other adapter may carry the same signed Session request. None may change the
authorization model.

## 4. Normative trust topology

The target topology is:

```text
┌───────────────────────────────────────────────────────────────┐
│ Repository protected canonical ref                           │
│                                                               │
│ .github/inari/authorities/*.json                              │
│ .github/inari/... semantic authorization policy               │
│                                                               │
│ - trusted Runtime public keys                                │
│ - per-Runtime delegation ceilings                            │
│ - repository capability policy                              │
└──────────────────────────┬────────────────────────────────────┘
                           │ trusts / limits
                           v
                  ┌──────────────────┐
                  │ Runtime Authority│
                  │                  │
                  │ Runtime private  │
                  │ key              │
                  └────────┬─────────┘
                           │ signs delegation
                           v
                  ┌──────────────────┐
                  │ Agent Session    │
                  │                  │
                  │ Session private  │
                  │ key              │
                  │ + Certificate    │
                  └────────┬─────────┘
                           │ signed semantic request
                           v
                  ┌──────────────────┐
                  │ Inari executor   │
                  │ / GitHub App     │
                  │                  │
                  │ verify           │
                  │ authorize        │
                  │ project / admit  │
                  │ effect           │
                  │ reread / verify  │
                  └────────┬─────────┘
                           │ installation token, never returned
                           v
                        GitHub
```

There is no required central Session registry between Runtime and App.

## 5. Authority and credential ownership matrix

| Item                             | Holder / canonical location                            | Lifetime                        | Secret?                                             | What it authorizes                                                                    | Must never be used for                                                    |
| -------------------------------- | ------------------------------------------------------ | ------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Runtime private key              | Runtime manager / local secret store                   | Long-lived, rotated             | Yes                                                 | Signing bounded Session Certificates                                                  | Direct App request authentication; GitHub API; Agent bootstrap disclosure |
| Runtime public key               | Repository canonical trust artifact                    | Until revoked/rotated           | No                                                  | Verification that a Session Certificate came from a trusted Runtime                   | GitHub mutation by itself                                                 |
| Runtime trust record             | Protected canonical repository ref                     | Versioned                       | No                                                  | Maximum delegable capability, TTL and key status for one Runtime                      | Session-local policy overrides                                            |
| Session private key              | One Agent Session                                      | Ephemeral; session/TTL bounded  | Yes                                                 | Proof-of-possession and request signatures for that Session                           | Signing new Session Certificates; GitHub API authentication               |
| Session public key               | Embedded in Session Certificate                        | Same as certificate             | No                                                  | Verification of Session request signatures                                            | Delegation by itself                                                      |
| Session Certificate              | Agent Session; may be logged only where policy permits | Short-lived                     | No in the PoP model                                 | Evidence that a trusted Runtime delegated bounded authority to the Session public key | GitHub API authentication without Session proof-of-possession             |
| Manual Session credential bundle | Human -> one manual Agent Session                      | Short-lived                     | **Yes** because it contains the Session private key | Portable bootstrap of the same Session protocol                                       | Reuse across sessions or long-term storage                                |
| GitHub App private key           | App/executor deployment only                           | Long-lived, rotated             | Yes                                                 | Minting App JWT / installation tokens                                                 | Agent or Runtime credential                                               |
| GitHub App installation token    | App/executor process only                              | Provider-bounded short lifetime | Yes                                                 | Actual GitHub API operations within App/install permission ceiling                    | Returning to Agent/Runtime/MCP result                                     |
| Repository semantic policy       | Protected canonical repository ref                     | Versioned                       | No                                                  | Defines admissible semantic capabilities and constraints                              | Secret storage or session identity                                        |
| Current GitHub evidence          | GitHub                                                 | Current state                   | No                                                  | Admission, idempotency, postcondition and one-shot evidence                           | Delegation identity                                                       |

Three secret classes exist and must remain separated:

```text
Runtime private key      -> Runtime only
Session private key      -> one Session only
GitHub App credential    -> App/executor only
```

No component needs any other component's private key.

## 6. Repository-native Runtime trust root

### 6.1 Canonical location

V1 uses repository-native structured trust records under:

```text
.github/inari/authorities/<authority-id>.json
```

The file contains the Runtime public key plus policy metadata. A raw `.pub` file is
insufficient because rotation state, lifetime ceilings, and delegable capability ceilings
must be governed alongside the key.

Illustrative shape:

```json
{
  "version": 1,
  "kind": "runtime-authority",
  "id": "yohn-local-runtime-2026-09",
  "key": {
    "kty": "OKP",
    "crv": "Ed25519",
    "x": "<base64url-public-key>"
  },
  "status": "active",
  "notBefore": "2026-09-08T00:00:00Z",
  "notAfter": null,
  "maxSessionTtlSeconds": 7200,
  "capabilityCeiling": ["change.implement", "change.ready", "change.abort"]
}
```

The exact semantic-schema implementation is a follow-up task, but these fields and
meanings are normative.

### 6.2 Authoritative ref

Mutation authorization reads Runtime trust records and authorization policy only from the
repository's configured protected canonical authority ref. V1 defaults to the repository
default branch.

The Agent working branch is never an authority source for Runtime keys or authorization
policy.

An executor must record the authority ref and resolved commit SHA used for authorization
in bounded provenance/evidence.

```text
policyRef = refs/heads/main
policySha = <immutable commit SHA>
```

### 6.3 Registration and bootstrap

Adding the first Runtime public key is an explicit trust-root bootstrap ceremony. It
cannot be authorized by the Runtime key that is being added.

Bootstrap uses an already-trusted repository administrative/governed path: for example a
human-reviewed PR created through the existing governance path and merged under the
repository's Ruleset. Inari CLI may generate/render the trust artifact, but possession of
the new private key does not grant permission to install its public key.

### 6.4 Self-escalation prevention

Ordinary Agent capabilities must never authorize modification of:

```text
.github/inari/authorities/**
<canonical authorization-policy paths>
<other repository trust-root configuration>
```

A generic branch-write capability therefore requires an immutable deny-set for trust-root
paths in addition to any repository-configured path restrictions.

Trust-root changes require a distinct highest-privilege governance path that is not
included in normal Runtime delegation ceilings by default.

### 6.5 Rotation

Rotation is overlap-based:

1. generate a new Runtime keypair locally;
2. add the new public trust record through governed review;
3. allow old and new keys during a bounded overlap;
4. move runtimes to the new private key;
5. remove or disable the old trust record through governed review.

No private key is committed or transmitted to GitHub.

### 6.6 Revocation

Removing or disabling the Runtime trust record revokes all unexpired Session Certificates
issued by that Runtime because every mutation request re-evaluates current repository
trust.

Mutation admission must fail closed when the canonical trust record or policy cannot be
read or validated.

A cached trust decision may not outlive the mutation request in V1. Optimized caching is a
future concern and must preserve bounded revocation latency explicitly.

## 7. Runtime Authority

### 7.1 Runtime key semantics

The Runtime keypair uses Ed25519 in V1.

The private key is an **offline/local delegation signer**. The App protocol must not have
an endpoint or authentication mode in which a Runtime private-key signature alone can
execute a GitHub mutation.

The only normative privileged operation of the Runtime key is:

```text
sign(Session Certificate)
```

This is a protocol-level distinction, not merely a UI convention.

### 7.2 Runtime storage

`inari authority generate` is expected to create the keypair locally. The default private
key output must be a secret file with restrictive filesystem permissions or an OS-backed
key-store reference where supported. Printing raw private-key material to ordinary logs
or making an environment variable the default storage form is prohibited.

Managed runtimes may obtain the private key from their own secret manager. Inari defines
the key interface/format; it does not become a general secrets manager.

### 7.3 Runtime authority ceiling

A trusted Runtime is privileged because it can mint Session Certificates without asking
an Inari management server. Its power is therefore bounded by the repository trust
record.

For any Session Certificate `S` issued by Runtime `R`:

```text
Authority(S) ⊆ CapabilityCeiling(R) ⊆ RepositoryPolicy
TTL(S)       <= MaxSessionTTL(R)
Repository(S) = repository trusting R
```

A Runtime signature claiming authority outside its repository-defined ceiling is valid
cryptographically but unauthorized semantically and must be rejected.

## 8. Agent Session identity

### 8.1 Managed session flow

The preferred flow is proof-of-possession with a Session-generated ephemeral keypair:

```text
Agent Session                           Runtime
     |
     | generate Ed25519 Session keypair
     |
     |-- Session public key ----------->|
     |                                  | validate requested delegation
     |                                  | sign Session Certificate
     |<--------- Session Certificate ---|
     |
     | retains Session private key only
```

The Runtime never receives the Session private key.

The Session key is destroyed when the session ends. The certificate must expire no later
than the delegated session lifetime.

### 8.2 Manual Claude/Web-style flow

A manual environment cannot always generate a keypair and perform an interactive local
bootstrap before the user hands it credentials. In that case the Inari CLI may generate
the ephemeral Session keypair locally, sign the Session Certificate with the Runtime key,
and emit a **Session credential bundle** containing:

- Session private key;
- Session Certificate;
- non-secret metadata required by the client.

```text
Human local machine
  inari session issue ...
       |
       | generate Session keypair
       | certify Session public key
       v
  short-lived secret bundle
       |
       | manual handoff
       v
  Claude Web / other isolated session
```

The bundle is secret because it contains the Session private key. It must be short-lived,
repository/task bounded, and treated as compromised when the manual session ends.

This weaker bootstrap changes **who generated the Session key**, not the App-side
verification protocol. App verification remains identical to the managed flow.

### 8.3 Agent implementation identity vs security principal

`claude-web`, `codex`, `cursor`, `luna`, or another product name is provenance metadata,
not the cryptographic principal.

The security principal is the unique Session key / Session ID. Agent implementation and
runtime metadata may be included for audit, but two Claude sessions do not share an
identity merely because both use Claude.

## 9. Session Certificate contract

### 9.1 Cryptographic profile

V1 uses a JWS-signed certificate with Ed25519 (`alg = EdDSA`). The Runtime trust record
contains the corresponding Ed25519 public key and stable key ID.

JWS is used so the signed bytes are explicit and existing JOSE implementations can verify
the Runtime signature without Inari inventing an ad-hoc certificate encoding.

The protected header includes at minimum:

```json
{
  "alg": "EdDSA",
  "typ": "inari-session+jwt",
  "kid": "yohn-local-runtime-2026-09"
}
```

The payload is a versioned claims object. V1 requires at least:

```json
{
  "ver": 1,
  "iss": "runtime:yohn-local-runtime-2026-09",
  "sub": "session:<opaque-id>",
  "jti": "<unique-certificate-id>",
  "repository": {
    "id": "<immutable-github-repository-id>",
    "name": "yohn-jp/gh-inari"
  },
  "sessionKey": {
    "kty": "OKP",
    "crv": "Ed25519",
    "x": "<base64url-public-key>"
  },
  "task": {
    "kind": "issue",
    "number": 364
  },
  "capabilities": [{ "kind": "change.implement", "issue": 364 }],
  "iat": 0,
  "nbf": 0,
  "exp": 0
}
```

`repository.id` is the security binding. The human-readable full name is retained for
provenance and diagnostics but must not replace immutable repository identity.

`task` is optional for capability kinds that are not rooted in one task, but any task
scope present in the certificate narrows authority and cannot be widened by the request.

### 9.2 Certificate confidentiality

The Session Certificate is not confidential in the target proof-of-possession model.
Possession of it without the Session private key is insufficient to authorize a request.

Implementations must nevertheless avoid gratuitous public logging because certificates
carry provenance and task metadata.

### 9.3 Expiry

Session Certificates are intentionally short-lived. The repository Runtime trust record
defines the maximum TTL. The issuer may choose a shorter TTL for an individual session.

The App rejects expired or not-yet-valid certificates before semantic admission.

### 9.4 No delegation chaining in V1

An Agent Session cannot issue child Session Certificates. V1 has exactly one delegation
edge:

```text
trusted Runtime -> Agent Session
```

Multi-hop delegation can be considered later only with an explicit attenuation proof and
new threat model.

## 10. Session request proof-of-possession

A Session request contains:

- Session Certificate;
- semantic Inari request;
- request timestamp / expiry window;
- unique request ID;
- signature made by the Session private key.

The request signature covers a versioned Inari request envelope containing at minimum:

```text
protocol version
Session Certificate jti
immutable repository ID
semantic operation name
canonical semantic request digest
request ID
issued-at / expiry
```

The semantic request payload is canonicalized using RFC 8785 JSON Canonicalization Scheme
before SHA-256 hashing. The Session signs the versioned envelope with Ed25519.

The envelope is domain-separated; a Session Certificate signature and a Session request
signature are not interchangeable.

Conceptually:

```text
INARI-REQUEST-V1\n
certificate-jti\n
repository-id\n
operation\n
sha256(jcs(request))\n
request-id\n
issued-at\n
expires-at
```

Exact byte-level fixtures must be added with the implementation so alternative clients
produce identical signatures.

A transport may wrap this envelope in MCP, HTTP, stdio IPC, or another protocol, but may
not alter the signed semantic content.

## 11. Capability model

### 11.1 Effective authority is an intersection

A valid signature is necessary but never sufficient.

For request `Q` from Session Certificate `S`:

```text
EffectiveAuthority(Q)
  = DelegatedAuthority(S)
    ∩ RuntimeCeiling(repository, S.iss)
    ∩ RepositoryPolicy(current canonical ref)
    ∩ CurrentStateAdmission(GitHub evidence)
```

No layer can add authority omitted by an earlier layer.

### 11.2 Semantic, not provider-shaped

Agent-facing capabilities must not be expressed as:

```text
contents: write
pull_requests: write
issues: write
```

Those are App/provider permission ceilings.

The capability vocabulary represents governed repository work, for example:

```text
change.implement(issue:364)
change.ready(issue:364)
change.abort(issue:364)
```

Where lower-level capability primitives are necessary, they are bounded semantic effects,
not general GitHub permissions:

```text
branch.create(name=X, max=1)
branch.advance(branch=X, until=T, expectedHead=H, pathPolicy=P)
pullRequest.create(head=X, base=main, max=1)
```

### 11.3 Higher-level capability compilation

A high-level certificate may say:

```json
{
  "kind": "change.implement",
  "issue": 364
}
```

Repository policy and Inari Core determine the exact canonical branch, PR, allowed paths,
and lifecycle effects. The Runtime does not reproduce canonical branch naming or PR
rendering rules inside the certificate.

Conceptually:

```text
change.implement(issue:364)
       |
       | Core + repository policy
       v
bounded execution plan
  - canonical branch issuance as permitted by Change semantics
  - branch advancement only on canonical branch and within TTL/path policy
  - canonical PR issuance as permitted by Change semantics
```

The existing public `change issue` transaction remains unchanged until separately
governed. The primitive capability examples above describe authorization granularity, not
a silent lifecycle redesign.

### 11.4 Branch-write authority

A branch-write capability must bind at least:

- immutable repository ID;
- exact canonical/authorized branch identity;
- certificate/session expiry;
- expected current branch generation/head for each write request;
- target commit/tree/content operation;
- immutable protected-path deny-set;
- optional repository-defined allow/deny paths.

It must not be implemented by returning a general GitHub installation token to the agent.

Possible transports include Git data/content API effects or a future bounded Git proxy,
but the transport must preserve conditional branch advancement and path policy. Raw
`git push` using a broad bearer token is not the target authorization model.

### 11.5 Capability ceilings by Runtime

Different Runtime keys may have different ceilings. For example:

```text
personal-runtime:
  change.implement
  change.ready

ci-release-runtime:
  release.prepare

review-runtime:
  review.submit
```

Trusting a Runtime public key does not imply trusting it for every Inari operation.

### 11.6 Non-delegable / separately privileged capabilities

V1 repository policy should treat the following as non-delegable by ordinary
implementation Runtime Authorities unless explicitly configured through a higher trust
class:

- trust-root / authorization-policy modification;
- repository administration;
- Ruleset modification;
- App installation/permission changes;
- arbitrary default-branch writes;
- secret management;
- merge/release authority where separation of duties is required.

## 12. App verification and execution sequence

A privileged request follows this normative sequence.

### 12.1 Resolve installation and authoritative repository identity

The App/executor resolves the target GitHub App installation and immutable repository
identity internally. No installation token is returned to the caller.

### 12.2 Read current trust and policy

Using its own bounded App read authority, the executor reads trusted Runtime records and
semantic authorization policy from the canonical protected ref and records its commit
SHA.

Failure to read/validate current trust policy fails closed.

### 12.3 Verify Runtime delegation

The executor verifies:

- JWS algorithm/type/version;
- `kid` resolves to an active trusted Runtime record;
- Runtime signature;
- certificate repository ID equals target repository ID;
- `nbf` / `exp`;
- requested capability is within the Runtime ceiling;
- certificate claims are structurally canonical and bounded.

### 12.4 Verify Session proof-of-possession

The executor verifies the request signature against `sessionKey` embedded in the
certificate and checks request freshness, repository binding, certificate `jti`, and
semantic payload digest.

### 12.5 Evaluate repository policy

The executor resolves the requested semantic capability against current repository
policy. Certificate claims cannot override repository deny rules, canonical names,
protected paths, review requirements, or lifecycle constraints.

### 12.6 Read authoritative GitHub evidence

Before mutation, Inari rereads the repository state required by the operation and projects
canonical current state.

### 12.7 Admit and plan

Core/XState determines whether the transition is currently legal and emits an explicit
bounded effect plan.

### 12.8 Mint minimum App capability internally

Only after authorization/admission, the App/executor mints or uses the minimum installation
token permissions necessary for the planned effect. Provider permissions are an internal
ceiling, not the Session capability.

### 12.9 Apply effect

The existing GitHub effect adapter applies only the admitted effect. The adapter does not
reinterpret certificate policy.

### 12.10 Authoritative reread and verification

Success is reported only after authoritative reread and semantic postcondition
verification. Provenance includes at minimum:

```text
runtime authority ID / key ID
Session ID / certificate jti
semantic operation / task
repository ID
policy ref + policy commit SHA
App installation / issuer identity
bounded effect evidence
final verified projection
```

## 13. Replay, one-shot semantics, and durable state

### 13.1 A signed certificate is not a consumed token

The architecture does not pretend a stateless signature can prove single consumption.
`maxUses: 1` is meaningful only when Inari can prove prior consumption from authoritative
state or from an explicit durable consumption record.

### 13.2 Prefer state-derived one-shot semantics

Many GitHub operations already have canonical state that can prove one-shot behavior:

- canonical branch creation: branch exists or it does not;
- canonical PR creation: canonical head/base/identity exists or it does not;
- Change issuance: existing Change projection is idempotent or conflicting;
- Ready: PR is already ready;
- Abort: terminal projection / recovery state is observable.

For these operations, repeated requests are handled by existing idempotent projection and
transition semantics rather than by a central certificate-consumption database.

### 13.3 Conditional branch advancement

Repeated branch-write requests must bind to an expected head/generation. A successful
write advances the branch; replay against the old expected head fails or returns a proven
already-applied result if the exact target state is current.

This makes the mutation state itself part of replay protection.

### 13.4 When durable consumption state is required

If a future capability has a side effect whose exact prior execution cannot be proven
from GitHub/canonical evidence, strict one-shot semantics require durable state.

That state must be scoped to the App/execution function and must not become a general
Session management database or competing Change state store.

Until such state exists, Inari must not advertise strict single-use for that capability.

### 13.5 Request ID does not by itself prevent replay

A `requestId` is required for correlation and bounded idempotency evidence, but a unique ID
without a durable seen-set is not a security guarantee. Documentation and code must not
confuse the two.

## 14. Ambiguous mutation, retry, compensation, and recovery

Capability authorization does not change distributed-systems failure semantics.

Example:

```text
App -> GitHub POST
GitHub applies effect
network response times out
```

The certificate remains evidence that the operation was authorized, but the executor must
not blindly spend/consume another authority unit or replay the mutation based on the
network error.

The XState trusted executor performs:

```text
effect result ambiguous
       |
       v
authoritative reread
       |
       +-- desired state proven -> verify success / idempotent completion
       |
       +-- no effect proven -> retry only if existing operation semantics permit
       |
       `-- conflicting / unsafe -> RECOVERY_REQUIRED / fail closed
```

Issuance compensation, branch cleanup, and other destructive recovery retain their
existing generation/provenance safety requirements. Session authority never weakens a
recovery guard.

## 15. App deployment boundary without a management server

A GitHub App that accepts remote Agent requests necessarily has some execution endpoint or
adapter capable of holding the App private key and contacting GitHub. This architecture
distinguishes that **stateless issuer/execution boundary** from a central Inari management
control plane.

The required App-side state is intentionally minimal:

- App private key / installation configuration;
- transient provider tokens;
- request-local trust/policy/evidence;
- optional narrowly-scoped idempotency state only where a capability demonstrably
  requires it.

V1 does **not** require:

- user accounts in Inari;
- Runtime registration database;
- Session database;
- Session issuance API;
- central repository policy copy;
- organization administration UI;
- central capability-grant database.

The authoritative Runtime registry and capability ceilings live in the repository.
Session Certificates are minted locally by trusted Runtime keys.

A deployment may be hosted, serverless, self-hosted, or bridged through Actions. That is
an operational choice, not the authorization model.

## 16. CLI and Runtime responsibilities

The architecture implies an Inari CLI surface similar to:

```text
inari authority generate
inari authority render/register <public-key>
inari session issue ...
inari session inspect ...
```

Exact command names are follow-up design, but responsibilities are fixed:

- generate Runtime keypairs locally;
- render repository trust artifacts without publishing private material;
- create/bind ephemeral Session identity;
- sign Session Certificates with a Runtime key;
- package manual short-lived Session credentials when required;
- sign semantic requests with a Session key;
- never require `gh auth` as the cryptographic authority for this protocol.

Managed runtimes such as Mottainai/Nawabari may automate the same primitives. They do not
receive special server-side privileges beyond possession of a repository-trusted Runtime
private key.

## 17. Provenance model

GitHub may show the mutation actor as the Inari App, while Inari evidence preserves the
actual delegation chain.

Illustrative provenance:

```text
authority_owner / repository = yohn-jp/gh-inari
runtime_authority             = yohn-local-runtime-2026-09
session                       = session:01...
agent_metadata                = claude-web
certificate_jti               = ...
operation                     = change.implement
subject                       = issue:364
policy_sha                    = ...
executed_by                   = inari-issuer[bot]
```

The following identities must remain distinguishable:

- repository trust owner;
- Runtime Authority;
- Agent Session;
- agent implementation metadata;
- issuer GitHub App;
- commit author(s);
- reviewer/approver;
- merger.

The App actor must never be presented as proof that the requester was the App itself.

## 18. Threat model

### 18.1 Runtime private-key theft

**Impact:** attacker can mint Session Certificates up to that Runtime's repository-defined
ceiling until the Runtime trust record is revoked.

**Mitigations:** delegation-only protocol; per-Runtime capability ceiling; maximum short
Session TTL; local secret-store protections; repository-side immediate key revocation;
separate Runtime keys for different authority classes.

The attacker still cannot use the Runtime key directly as a GitHub/App credential.

### 18.2 Session private-key theft

**Impact:** attacker can exercise the stolen Session's remaining delegated authority until
expiry/revocation/current-state exhaustion.

**Mitigations:** ephemeral per-session keys; short TTL; repository/task/capability binding;
conditional branch writes; semantic idempotency; no delegation rights.

Blast radius is one bounded Session, not the Runtime or user GitHub account.

### 18.3 Certificate theft without Session private key

**Impact:** no mutation authority in the target PoP model.

**Mitigation:** every request requires Session private-key signature.

### 18.4 Manual credential-bundle theft

**Impact:** equivalent to Session private-key theft because the bundle contains the key.

**Mitigations:** short TTL, narrow capability scope, single-session use, no long-term
storage/logging. Manual bootstrap is intentionally weaker than managed PoP generation but
has the same bounded blast radius.

### 18.5 Replay

**Risk:** a captured signed request is resubmitted.

**Mitigations:** request freshness; certificate binding; current-state idempotency;
expected-head/generation conditions; explicit durable consumption state only when strict
single-use cannot otherwise be proven.

Freshness alone is not claimed as complete replay protection.

### 18.6 Cross-repository confused deputy

**Risk:** a certificate trusted in repository A is presented for repository B.

**Mitigations:** immutable repository ID in certificate and request signature; App resolves
actual installation/repository independently; Runtime public key must be trusted by that
same repository.

### 18.7 Repository rename / name reuse

**Risk:** name-only binding points authority at a different repository.

**Mitigation:** immutable GitHub repository ID is the security binding; full name is
diagnostic metadata.

### 18.8 Policy-ref substitution

**Risk:** Agent modifies its branch policy/public-key files and asks App to trust them.

**Mitigations:** trust/policy read only from configured canonical protected ref;
authoritative SHA recorded; working branch never supplies authorization data.

### 18.9 Self-registration / privilege escalation

**Risk:** Agent writes its own Runtime public key into trusted authorities.

**Mitigations:** immutable protected-path deny-set for ordinary delegated writes;
trust-root changes require separate human/admin governance and cannot be delegated by
normal implementation capability.

### 18.10 Broad App permission / confused deputy

**Risk:** App installation has broader provider permissions than the Session capability and
is tricked into using them.

**Mitigations:** certificate verification -> repository policy -> current-state admission
-> explicit effect plan before provider token/effect; per-effect minimum installation
permission; effect adapter cannot accept arbitrary GitHub operations.

### 18.11 Direct-path bypass

**Risk:** Agent bypasses Inari and uses another GitHub credential.

**Mitigations:** this architecture removes the need to provide such a credential. Repository
Rulesets/provenance checks continue to reject noncanonical publication where GitHub cannot
prevent all writes. Inari cannot protect a separately supplied human PAT from its owner;
credential hygiene and repository Rulesets remain defense in depth.

### 18.12 App private-key compromise

**Impact:** attacker may obtain GitHub authority up to App installation permissions and
bypass Inari certificate checks.

**Mitigations:** isolate App credential boundary; minimal App permissions; secure deployment
secret storage; rotation; GitHub audit; repository Rulesets; do not distribute App private
keys to Runtimes, Actions tenants, or agents.

This remains the highest provider-level execution secret.

### 18.13 Compromised local Agent process

The architecture does not attempt to stop an Agent from exercising authority deliberately
given to its own Session. It limits what that Session can do remotely and prevents the
Agent from obtaining Runtime/App/user credentials with larger authority.

## 19. Security invariants

- A Runtime private key is never a mutation credential.
- A Session private key cannot mint another valid Session Certificate.
- A Session Certificate without Session proof-of-possession cannot mutate GitHub.
- A cryptographically valid certificate outside repository policy is unauthorized.
- A certificate valid for one repository is invalid for another.
- A certificate valid for one task cannot silently widen to another task.
- Agent-facing capabilities are semantic and bounded, never raw GitHub provider
  permissions.
- Trust-root/policy changes are outside ordinary delegated implementation authority.
- Authorization policy is read only from an authoritative protected ref.
- Mutation success requires authoritative reread and semantic verification.
- Ambiguous effect outcomes never imply safe replay.
- GitHub App credentials never cross into Runtime or Agent Session environments.
- No hosted identity/session database is required for V1.

## 20. Relationship to Epic #267 / native MCP issuer gateway

Epic #267 correctly identified several durable boundaries:

- MCP can be a typed native Inari protocol;
- transport mechanics must not become semantic authority;
- App credentials must remain outside agents;
- Core owns repository semantics;
- hosted and self-hosted transports should share one contract.

Those remain valid.

The following assumptions are superseded by #364 as normative architecture:

- a hosted MCP gateway is the required authentication/authorization control plane;
- Runtime/Agent sessions must be registered or admitted by a centralized Inari service;
- repository policy must be evaluated through a consumer Actions runner for every
  privileged operation;
- Actions OIDC is the required caller-to-issuer trust mechanism;
- a hosted service is required to decide which requester may ask for which capability.

The new model is:

```text
local Runtime delegation
       +
repository trust/policy
       +
Session proof-of-possession
       +
current GitHub state
       ->
App execution authority
```

MCP may carry the signed request directly to the App/executor. Actions may remain a
compatibility or specialized execution adapter where repository-local code execution is
actually required. Neither is mandatory for authorization.

No implementation work under #267 should introduce a central competing authority after
this document becomes normative. #267 should be reassessed after #364 implementation
leaves are derived.

## 21. Migration

The migration is intentionally architecture-first and incremental.

### Gate 0 — architecture

Merge this document through #365. Do not implement certificate/key/App behavior in the
same PR.

### Gate 1 — cryptographic and repository trust foundations

Expected follow-up slices:

1. define Runtime Authority / Session Certificate schemas and conformance vectors;
2. add local Runtime Ed25519 key generation and secure key loading;
3. add canonical repository Runtime trust artifacts and validation;
4. protect trust-root paths in semantic branch-write policy.

### Gate 2 — Session delegation

5. add managed Session ephemeral key generation and Runtime certificate issuance;
6. add manual short-lived Session credential-bundle issuance/inspection;
7. add signed semantic request envelope and proof-of-possession verification library.

### Gate 3 — App admission

8. add App/executor trust-record lookup from canonical ref;
9. add certificate + Session request verification;
10. add capability attenuation/admission before existing trusted Change executor;
11. preserve bounded provenance with Runtime/Session/policy SHA evidence.

### Gate 4 — gh-independent execution transport

12. expose the verified semantic request through a minimal transport that does not depend
    on user `gh auth`;
13. retain MCP, Actions, and `gh` paths as adapters/compatibility until parity is proven;
14. never return installation tokens to callers.

### Gate 5 — bounded write dogfood

15. dogfood narrow authority on Inari itself, including canonical branch issuance,
    authorized branch advancement, and governed PR publication under short Session TTL;
16. inject ambiguous-effect/replay/key-revocation failures and verify fail-closed/recovery
    behavior.

### Gate 6 — managed runtime integration

17. integrate Nawabari/Mottainai only after the manual/local Inari protocol is stable;
18. each runtime-created Agent Session gets its own ephemeral identity and certificate;
19. Runtime integration remains optional and uses the same public cryptographic protocol.

### Gate 7 — reconcile old ingress architecture

20. reassess Epic #267 and retain only native MCP/transport work compatible with this
    trust model;
21. retire redundant Actions-RPC / `gh` credential dependencies only after equivalent
    capability-authorized paths are proven.

Implementation Issue boundaries must be derived from this merged work graph rather than
created before the architecture gate.

## 22. Open implementation choices that are not architectural ambiguity

The following may be selected by bounded implementation Issues without reopening the
trust model:

- exact local private-key container format / OS keystore adapters;
- exact CLI command spelling;
- HTTP vs MCP endpoint deployment adapter;
- implementation library for JOSE/JCS/Ed25519;
- App hosting platform;
- precise repository policy file decomposition under `.github/inari/`;
- bounded cache implementation if it preserves current-ref authorization semantics;
- Git data vs content API vs future bounded Git proxy for branch advancement.

The following are **not** open:

- Runtime private key as a direct App credential;
- Agent receiving GitHub/App/user credentials;
- central Session registry as a V1 requirement;
- authorization policy sourced from the Agent branch;
- raw GitHub permissions as the Agent-facing capability vocabulary;
- mutation success without post-effect authoritative reread/verification;
- ordinary delegated capability modifying its own trust roots.

## 23. Architectural acceptance conditions

This architecture is complete when later implementation can proceed without reopening
these questions:

- who holds every key and credential;
- where Runtime trust is rooted;
- how Runtime authority is limited;
- how Session identity and manual/managed bootstrap work;
- what a Session Certificate proves;
- how Session proof-of-possession is verified;
- how semantic capabilities attenuate GitHub App authority;
- how current GitHub state participates in authorization and one-shot behavior;
- how ambiguous effects and replay are handled;
- why a central Inari credential-management server is not required;
- how MCP, Actions, HTTP, CLI, and `gh` fit without becoming trust authorities;
- and how #267 is reconciled with the new product direction.

The implementation must preserve the central invariant:

> GitHub authority remains inside the App. Runtime authority can only delegate. Agent
> Sessions can only exercise the bounded semantic authority certified for that session
> and still admitted by the repository's current canonical policy and state.
