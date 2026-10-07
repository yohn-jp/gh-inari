# Repository Access Assertion

Status: approved remote caller-evidence architecture under
[Product Architecture Canon](./ARCHITECTURE.md).

This remote architecture is deferred from the Local Admission lock and is not
a prerequisite for it.

This is a target contract, not an assertion that the current package or Hosted
deployment implements the protocol. Its versioned wire schema, cryptographic
encoding, trust bootstrap, and public-client integration must be frozen and
proved before the remote path is advertised as available.

The architecture fixes ownership and security obligations here. An
implementation cannot omit an obligation or invent a different authorization
model merely because a lower-level contract has not yet been delivered.

## 1. Purpose

A remote client authenticates through Inari Access's GitHub App user
authorization profile. Hosted verifies who the caller is and that the caller
can access the requested repository through the relevant installation.

Hosted sends only a short-lived signed assertion and its bound Inari request
to the user-owned Runtime. The GitHub user credential is neither persisted nor
forwarded. Runtime verifies the attestation and current Executor binding,
then performs its own subject/operation authorization.

The assertion is not an Inari capability, Runtime Authority delegation,
provider credential, or new client Session Certificate. The client does not
need to generate an ephemeral signing key or carry a Delegator credential.

## 2. Ownership

Hosted authenticates the OAuth flow and provider evidence, signs the bounded
identity/eligibility facts, and handles service-owned issuer keys.

Relay delivers to the authenticated transport connection for the selected
Relay ID. It does not reinterpret the repository/task or choose capabilities.

Runtime admission verifies configured issuer trust, signature, scope, request
binding, lifetime, and replay. Executor owns the current repository-to-App/
installation binding and obtains authoritative provider evidence through its
own read capability.

Admission decides whether the authenticated subject may request the specific
semantic operation. Repository visibility is only an ingress prerequisite.
Missing subject policy or current evidence is denial, not a full App grant.
The Runtime operator owns subject/operation/target grants in Runtime-owned
owner configuration; Admission consumes the current grant at invocation.
Hosted does not issue or manage these grants.

## 3. Trust assumption

This assertion is signed by Hosted, not GitHub. A valid signature proves the
configured issuer signed these facts. Runtime therefore explicitly trusts
that issuer for the claimed GitHub identity and eligibility observation.

Signature verification does not independently prove the issuer told the truth.
A compromised assertion signer can impersonate subjects within that trust
relationship. Short lifetime, request/Relay binding, issuer revocation, and
independent Runtime authorization limit exposure but do not eliminate it.

An attacker-controlled issuer/key named in a request is never accepted by
self-description. Issuer trust is configured through an explicit operator-
authorized boundary with expected service identity and key rotation rules.

## 4. Attested identity and eligibility

The assertion must bind these concepts in one closed versioned contract:

- exact issuer and signing-key identity;
- immutable GitHub subject identity and provider host;
- intended audience/user-owned Runtime or Relay target;
- requested repository host and immutable ID;
- the Inari Access App and installation used to verify eligibility;
- the limited eligibility fact and its observation time;
- issued/not-before/expiry validity as required by the wire contract;
- unique assertion/request identity and replay domain;
- digest or equivalent integrity binding of the exact semantic request.

Names and slugs may be display metadata but cannot replace IDs. A successful
OAuth exchange alone does not prove the requested repository/installation
relationship. Private repositories must be checked through the authenticated
provider access; public readability is not a substitute.

Eligibility states that the user can access that repository under the
verified App context. It does not assert authority to approve, merge, enroll
keys, modify trust, execute a shell, or exercise all installation permissions.

These are required semantic fields, not a copy-paste serialized token example.
The implementation contract selects exact field names, canonical encoding,
algorithm allowlist, byte bounds, and test vectors once for all consumers.

## 5. OAuth verification boundary

The OAuth implementation validates the expected App/client configuration,
callback, state, expiry, PKCE where required by the accepted flow, and provider
response before using the returned user credential.

Untrusted requests do not choose arbitrary token endpoints, redirect URIs,
issuers, or App client metadata. The provider host remains bound to the
expected repository/App context.

Use the temporary credential only for required identity and eligibility
reads. User access is constrained by both user and App but may include write
permissions; describing the flow as authentication does not make the token
cryptographically read-only.

Access/refresh tokens, callback codes, verifiers, and raw credential-bearing
responses must not enter persistent storage, Relay job records, logs, traces,
error messages, retained evidence, or downstream Runtime messages.

Necessary pending OAuth state is short-lived and bounded. Lost pending state
causes a clean authentication restart, never a guessed successful callback.
No permanent user/account or repository-membership database is required.

## 6. App selection and dedicated installations

Executor owns the repository/App/installation binding. Hosted verifies the
corresponding caller eligibility; it does not create or replace that binding.

A dedicated Inari Access App may have its own OAuth client configuration.
The existing Manifest conversion foundation is not proof that Hosted knows
its correct callback/client secret. That registration/selection/bootstrap is
an explicit remaining integration contract.

A secure implementation must bind the operator-approved Runtime/Relay and
App/client configuration without accepting arbitrary browser-supplied values
as authority. Service-owned OAuth secrets are distinct from user tokens.

Neither a separate Identity App, token forwarding, nor automatic shared-App
fallback is authorized as a shortcut around missing integration.

## 7. Request binding

The assertion is for the admitted semantic request, not a reusable grant for
all requests to that repository. Bind operation, repository, semantic target,
and mutation-relevant input through one canonical digest/encoding contract.

Changing Source, Implementation, branch/head/base, operation, or payload must
invalidate the assertion/request pair. Transport representation changes may
be normalized only through the shared canonical contract, not a separate
Hosted serializer.

The selected Relay ID is part of the intended target. An assertion for A must
not execute on B, even if both Runtimes serve a repository with the same name.

A query to pure supplied-data compilation is not silently transformed into a
private repository read. A private read is not silently transformed into a
write after authentication.

## 8. Runtime verification order

1. Enforce size/shape/version limits before expensive processing.
2. Resolve the explicitly configured issuer and allowed verification key.
3. Verify the signature and accepted cryptographic/header profile.
4. Verify subject/provider, audience, Relay/Runtime target, and time bounds.
5. Verify exact request digest, repository, and semantic target binding.
6. Apply the bounded replay/consumption contract atomically.
7. Obtain current Executor repository/App/installation evidence and match it.
8. Evaluate actual subject/operation authorization and current task/Source,
   policy, branch/head, validity, and effect preconditions where applicable.
9. Invoke the common admitted execution pipeline.

The exact placement of an atomic fence relative to safe retries must be
specified by the implementation's outcome contract. Consumed identity is not
reset merely because a later provider read failed or the process restarted.

Rejection at any required gate performs no unauthorized provider mutation.
Failures return bounded categories, not provider bodies or credentials.

## 9. Eligibility versus semantic authority

An authenticated user with repository read access does not automatically gain
Inari Access write powers. The Runtime operator records grants in Runtime-owned
owner configuration. Each grant binds an immutable GitHub user ID and exact
provider host to permitted semantic operation IDs, an immutable repository ID,
and exact targets. Admission matches the verified assertion and request to
that current grant, then intersects it with current repository policy and,
where applicable, task policy. A missing or revoked grant, stale owner
configuration generation, or wrong host, user ID, repository, operation, or
target denies. A display name, OAuth success, installation permission, or
valid assertion alone cannot supply the grant.

For task-bound operations, current Implementation authorization, Source
membership, branch/base, execution scope, and protected paths still apply.
The caller's identity does not let it create a fictitious task authorization.

For non-task operations, use the existing owner/read/control authority for
that operation. Do not manufacture `change.implement` merely to perform a
read or expose control/enrollment routes to every remote caller.

The Runtime owner configuration producer and Admission's current-grant
consumer are separate implementation seams. Until both are present and
verified, remote admission fails closed. This does not require a Hosted
Session issuance protocol or a new Hosted user role database.

## 10. Replay and retry

An identifier and short expiry alone are not replay protection. Runtime needs
a suitable atomic, bounded consumption/execution fence for the claimed
single-use semantics, including concurrent delivery and process restart.

Assertion replay protection and semantic idempotency are different. A new
assertion for an old uncertain mutation does not prove that mutation never ran.
Current provider state and the canonical operation recovery contract determine
safe continuation.

Preserve not-delivered, possibly-delivered, admitted, effect-observed, and
postcondition-verified distinctions. If a result is lost, a bounded status/
reconciliation operation may recover evidence; blind replay is not the default.

## 11. Time, revocation, and rotation

The wire contract defines short maximum validity, accepted clock skew, and
observation age. Reject missing/invalid times, future-not-yet-valid proofs,
expired proofs, and excessive lifetimes.

Eligibility observed at one time is not a permanent membership claim. A user
access revocation after observation can remain undetected until the bounded
assertion lifetime expires unless a stronger current check is implemented.
Do not advertise immediate revocation from a stateless cached assertion.

Issuer rotation has explicit key identity, overlap, expiry, and removal.
Runtime never trusts a new signing key merely because the token names it or
a Relay response supplies it.

App binding/credential generation changes are independently rechecked at
Executor. Relay transport-key rotation and Authority delegation rotation are
different domains and do not implicitly rotate Hosted issuer trust.

## 12. Confidentiality and retention

The assertion contains subject/repository metadata and a usable bounded proof.
It is not a GitHub token but is still sensitive replayable material until
consumed/expired. Avoid raw assertion logging and persistent browser storage.

Hosted can see data at its TLS termination and may process the request to
bind/sign it. This target is not end-to-end encryption against Hosted.
The no-persistence promise does not mean the service cannot observe transient
credentials or payloads.

Retained operational evidence is allowlisted metadata: safe correlation,
issuer/key identifiers, target identity as permitted by logging policy,
classification, timestamps, size/counter information, and bounded outcomes.
No raw signed body or provider response is required for diagnostics.

## 13. Required negative proof

Test wrong/missing issuer, unknown key, bad signature/header/version, oversized
or malformed envelope, wrong provider/subject/repository/App/installation,
wrong Relay/audience, modified operation/body, expired/future/excessive time,
concurrent replay, reconnect/restart replay, stale owner binding, and missing
subject authority.

Prove that visibility-only users cannot acquire App write or operator rights.
Prove OAuth secrets are absent from Runtime requests, owner stores, Relay
persistence, logs, diagnostics, and retained test artifacts.

Also test allowed local/remote requests reach the same Core/Executor path;
a remote denial must not fall back to Direct App, user-token execution, or a
Hosted provider API.

## 14. Release and documentation gate

Ship and advertise this profile only after the exact wire schema, signing/
verification vectors, issuer trust setup, dedicated-App OAuth bootstrap,
subject/operation admission, replay storage, and real packed/process ingress
are composed and verified.

A deterministic provider fixture is not proof of live GitHub OAuth or a
particular cloud client's authorization flow. Keep public-client compatibility
and live-provider certification as distinct evidence classes.
