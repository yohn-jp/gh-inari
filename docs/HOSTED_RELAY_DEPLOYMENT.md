# Hosted Authentication and Runtime Relay

Status: target deployment/transport contract under
[Product Architecture Canon](./ARCHITECTURE.md).

Hosted is a public authenticated entry point to a user-owned Inari Runtime.
It is not a second cloud implementation of Inari repository semantics.
This renewal replaces the earlier Hosted Endpoint/Dashboard repository engine
and repository-keyed routing model. Existing code and deployed behavior remain
revision-specific until the migration is implemented and certified.

## 1. Target composition

```text
cloud client / optional remote UI
  -> Inari Access user authorization at Hosted
  -> verified caller and repository/App eligibility
  -> short-lived signed request-bound access assertion
  -> Relay routing by stable transport identity
  -> user-owned Runtime
  -> Admission
  -> Executor / Core / Lifecycle Controller
  -> Inari Access installation capability
  -> GitHub and authoritative postcondition verification
```

Hosted never forwards the GitHub user token to Runtime. It does not determine
Implementation acceptance, issue Inari capabilities, select a semantic plan,
or apply provider mutations.

All repository/work/Session/Runtime observations exposed remotely come from
the user's server under its admission, not a parallel Hosted work database.
Optional Hosted UI is a presentation client over that same remote contract.

## 2. Responsibilities

Hosted owns the authenticated OAuth ingress and service-signed eligibility
attestation described by [Repository Access Assertion](./REPOSITORY_ACCESS_ASSERTION.md).

Relay owns transport connection authentication, route lookup, request/result
correlation, bounded buffering, timeouts, backpressure, and delivery-state
classification. It does not reinterpret Inari payloads as repository policy.

The user-owned Relay client owns its transport key and outbound connection.
Admission/Executor/Authority retain their respective user-owned state and
credential custody. Hosted unavailability affects remote connectivity, not
the validity of repository Canon or the local execution architecture.

## 3. Stable Relay identity

The Runtime generates or loads a dedicated local transport keypair. Its stable
public-key identity determines Relay ID through a versioned canonical
encoding/hash contract with test vectors.

The ID is a public locator, not a secret, repository grant, or Runtime
Authority ID. Reusing a display name is not proof of the same transport key.
Delegation and App keys must not be reused for this role.

The public path is conceptually `/r/<relayId>` at the configured service
origin. Exact MCP/HTTP routes and encoding belong to the versioned transport
contract; this example does not create an implemented CLI command or URL API.

The Runtime receives its confirmed Relay ID/public endpoint after successful
connection admission. Operators configure that endpoint in their clients.
No publicly readable repository descriptor is required for private repositories.

## 4. Connection establishment

```text
Runtime opens outbound secure WebSocket
  -> Relay supplies a fresh bounded challenge
  -> Runtime signs the connection-bound challenge with its transport key
  -> Relay verifies key encoding, possession, challenge and service context
  -> Relay derives/checks the exact Relay ID
  -> Relay admits that live connection and returns the public endpoint
```

Challenge proof is bound to the intended service/connection and has explicit
expiry and single-use behavior. A signature captured for another service,
connection, or old challenge is not admission.

Concurrent/replacement connections require explicit connection-generation and
ownership rules. Last arrival is not permission to steal a route or clear old
in-flight delivery evidence. The wire implementation must prove reconnect,
handoff, stale connection cleanup, and race behavior.

Keeping the local transport key stable keeps the public locator stable across
Runtime restarts. Rotation changes identity unless a separately approved
migration establishes an authenticated alias. No automatic alias is inferred.

## 5. Routing and availability

Route by Relay ID to its currently authenticated live connection. Do not use
repository name/ID as Hosted semantic routing authority or require a permanent
user/repository registration database.

An offline or unadmitted Runtime returns bounded transport unavailability.
Relay does not read GitHub itself to answer the user's semantic request,
fall back to another connection, or instantiate a Direct App executor.

The Runtime resolves repository selection inside the authenticated request.
The assertion binds that repository and target Relay, and Executor verifies
its current App/installation binding before the common operation is admitted.

## 6. Transport state and retention

Hosted may retain service configuration and its own signing/OAuth client
secrets. These are not user credentials.

Pending OAuth state, live connection attachment, challenge/replay fences,
rate-limit counters, and delivery records are bounded lifecycle state with
explicit expiry. Calling the service stateless does not remove the state
needed to prevent replay and ambiguous delivery.

No permanent user profile, membership, repository work, Inari Session, or
Runtime registration database is introduced. Persisted delivery metadata must
not contain OAuth tokens, callback codes, raw assertions, request/result
bodies, or provider credentials.

If payload retention is not supported, a disconnected caller may need a
separately authorized status/reconciliation request. Do not silently persist
sensitive payloads to improve retry convenience or pretend a lost result is
a failed execution.

## 7. Delivery semantics

The contract distinguishes definite non-delivery from possible delivery.
Rejection before sending to Runtime may be returned as not-delivered.
A send followed by disconnect, timeout, or storage uncertainty remains
possibly-delivered.

```text
accepted for transport
  -> not sent: bounded non-delivery
  -> sent: execution may have occurred
       -> result received: preserve its semantic outcome
       -> result lost/unknown: preserve uncertainty and reconcile
```

Neither delivery acknowledgment nor an HTTP success proves an Inari operation
succeeded. Runtime's admitted execution and verified provider postcondition
are distinct evidence.

Retries preserve request identity and obey Runtime replay/idempotency rules.
Reauthentication, a new connection, or a new assertion cannot reset an old
uncertain mutation into a definitely unused request.

## 8. Bounded operation and backpressure

Preserve the existing closed Relay size, rate, connection, in-flight, deadline,
and retention bounds until an explicit contract changes them. The observed
baseline describes operational defaults of 64 open connections, 16 in-flight
jobs, 120 messages per second, a 30-second job deadline, 32 retained job
records, and one-hour connection lifetime.

Those are baseline references, not permission to impose a 30-second semantic
execution deadline on every Inari operation. Transport waiting, connection
lifetime, control calls, and long-running execution are different bounds.
The convergence must preserve bounded progress/timeout evidence rather than
revive the generic short-timeout failure addressed by existing Runtime work.

Overload and rate limits fail before delivery where possible and retain typed
delivery classification. Cleanup of expired jobs/challenges/attachments is
deterministic and bounded. Heartbeat traffic must not create uncontrolled
application work or erase ownership evidence.

## 9. Authentication and trust

Public client access is authenticated through the accepted Inari Access user
OAuth profile. The service verifies the actual subject and requested repository
eligibility, signs the bounded assertion, and discards user credentials.

Runtime trusts a configured Hosted issuer for those attested facts. It still
checks actual subject/operation authorization; authenticated visibility is
not a write grant. Plain user-ID headers supplied by a caller or Relay are
not a substitute for verified evidence.

An assertion is audience/Relay/request/repository-bound with bounded validity
and Runtime replay protection. Service key rotation/revocation, dedicated-App
OAuth selection, and client callback configuration are explicit integration
contracts rather than guessed defaults.

## 10. Secret handling and observability

The following never enter persistent user stores, Relay metadata, logs, traces,
error bodies, or retained evidence:

- GitHub user access/refresh tokens and callback codes/verifiers;
- App private keys and installation credentials;
- Runtime Authority or Relay private keys;
- raw assertion or signed semantic request bodies;
- raw provider responses and arbitrary command output.

Telemetry uses allowlisted transport metadata: safe correlation, surface,
delivery classification, duration, size/counters, and bounded error class.
Record freshness and possible delivery honestly. Do not infer semantic
success from transport activity.

TLS terminates at Hosted and separately at the Runtime connection. Hosted can
observe transiting bytes. This is not end-to-end encryption against Hosted;
no credential persistence is a different guarantee.

## 11. Public protocol and UI

MCP/HTTP ingress carries the bounded Runtime operation contract. Hosted does
not execute a second repository Core, materializer, or private-read adapter.
The local/remote public catalogs must reflect actual admitted capabilities,
not expose raw review/merge or operator methods merely because transport exists.

A remote UI may be served as static assets. It consumes Runtime Control APIs
through the same authentication/Relay path. It has no independent repository
RBAC, cached work authority, or server-side GitHub mutation logic.

Public health reports only safe deployment/transport status. Reachable Relay
is not a healthy Executor, trusted repository, or ready Session.

## 12. Baseline implementation and migration

The observed baseline uses `wrangler.hosted.toml`, a Repository Relay Durable
Object, `runtime connect`, and the Endpoint/Dashboard modules. Its DO routing
is repository-ID-based and some Hosted paths perform provider reads/OAuth/
webhook reconciliation. Those are existing implementation facts, not the
approved steady state.

The target changes routing to authenticated Relay identity and moves all
semantic observation/execution behind the user-owned Runtime. Retire the
Hosted repository/work reader and webhook-driven semantic backend once the
replacement public paths are verified.

Keep authentication plumbing only where it implements the accepted transient
assertion boundary. Preserve static asset delivery where useful as presentation.
Do not retain an old backend because its UI needs a second API.

Independent Direct App `src/worker.ts`/`wrangler.toml` deployment is retired.
Shared broker/Core/crypto helpers may remain when the canonical Executor
uses them; profile retirement is not indiscriminate code deletion.

## 13. Deployment procedure and evidence

Existing build/deployment entrypoints are baseline operational references:

```sh
pnpm run hosted-worker:build
pnpm exec wrangler deploy --config wrangler.hosted.toml
```

Running them before convergence deploys the current implementation, not the
new architecture. Do not advertise a new assertion route or stable Relay URL
until the compiled package/configuration actually implements it.

Record source/package SHA, deployed version identity, service origin, public
client configuration, signer public identity, and the tested Runtime topology.
Keep private service/runtime material out of deployment evidence.

Static onboarding metadata must match deployed configuration and have one
owner. Public metadata is not authority for arbitrary redirects, keys, or
Runtime connection replacement.

## 14. Certification boundaries

The existing `scripts/endpoint-dashboard-certification.mjs` is a deterministic
composition oracle for its old target. Rebase its obligations to the new
Hosted boundary; do not call it live proof or silently delete the security
cases it covered.

The existing `scripts/relay-certification.mjs` live mode proves actual network
health, MCP handshake, WebSocket possession/heartbeat, and bounded malformed
frame behavior. It does not by itself prove semantic provider mutation.

Required new composed proof includes actual packed/public ingress, separate
Runtime processes, stable locator restart, connection replacement denial,
wrong issuer/Relay/repository/App/request, concurrent replay, expired proof,
Runtime unavailability, possible delivery, and credential-leak negatives.

Live OAuth/GitHub/deployment certification uses explicitly authorized
controlled resources and records exact revisions. A fixture network yields
only deterministic evidence, not live pass. Missing prerequisite stays
blocked/not checked.

## 15. Removal and rollback

Do not delete keys, revoke installations, or alter live service settings as a
side effect of documentation or ordinary observation. Deployment cutover has
its own owner approval and rollback plan.

Preserve historical release/certification evidence with its original revision.
Old-data readers may remain when bounded and necessary; old semantic engines
must not become alternate execution paths after cutover.
