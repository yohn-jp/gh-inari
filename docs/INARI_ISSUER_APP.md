# Inari Access: Provider Principal and Effect Authorizer

Status: normative provider-boundary contract under
[Product Architecture Canon](./ARCHITECTURE.md).

This filename retains its historical Issuer name. The public App name is
**Inari Access**. Canonical surfaces include `src/github/app-principal.ts`,
`src/github/effect-authorizer.ts`, and the installation credential broker.
`issuer-authority.ts` is a compatibility alias, not repository authority.

## 1. Role

Inari Access supplies the GitHub provider identity for admitted operations.
It is not the requester, semantic API, frontend, reviewer, merger, or policy
source. Core plans, Admission authorizes, and Executor coordinates effects
with the Effect Authorizer and postcondition verifier.

The Authorizer checks explicit planned effects at the credential boundary.
It does not derive branch names, render PRs, choose lifecycle transitions,
or implement independent recovery.

## 2. One App, separate credential profiles

The installation execution profile is Executor-owned and obtains short-lived
repository-scoped capabilities for evidence and admitted effects.

The user authorization profile is used transiently at Hosted for GitHub caller
and requested repository/App-installation eligibility verification. Hosted
sends a signed bounded assertion, never the user token, to Runtime.
There is no separate Endpoint App or Inari Identity App in the target.

Sharing App identity does not merge credential ownership. OAuth credentials
do not enter Executor; installation credentials and the App private key do not
enter Hosted. Normal effects never fall back to the caller's OAuth token.

A user token is constrained by user and App access but may have write powers
when both permit them. Authentication use does not make it cryptographically
read-only. Hosted uses only required identity/eligibility reads and neither
persists nor logs that token.

## 3. Existing bounded permission ceiling

Pre-admission evidence uses metadata plus contents, Issues, and pull requests
read access. That capability cannot apply a Change effect.

The initial effect set is:

```text
CREATE_BRANCH            contents: write
DELETE_BRANCH            contents: write
CREATE_PULL_REQUEST      pull_requests: write
MARK_PULL_REQUEST_READY  pull_requests: write
CLOSE_PULL_REQUEST       pull_requests: write
```

Metadata read is the provider baseline. One effect requests only its required
permission; multi-effect issuance requests the necessary union.
An installation's broad permissions do not grant every caller all effects.

This initial contract does not request Issue write, administration, Actions,
workflow, approval, review, or merge operations. Provider permissions are
coarse: semantic prohibitions also require the closed Effect Authorizer.
A merge command/state does not grant a provider merge capability.
Unsupported operations remain denied, not redirected to a broader credential.

## 4. Read and effect capabilities

The existing boundaries are `withRepositoryReadCapability` and
`TrustedInstallationCredentialBroker.withScopedInstallationCredential`.

```text
bounded evidence request
  -> fresh repository read credential inside broker
  -> repository-scoped read capability
  -> normalized evidence
  -> credential released at owner boundary

admitted effect plan
  -> target/permission verification at Effect Authorizer
  -> minimum installation credential inside broker
  -> bounded mutation capability
  -> public receipt or sanitized failure
  -> credential released at owner boundary
```

Neither exposes tokens, authorization headers, keys, a generic GitHub client,
or unrestricted callback environment. Read capability is not effect authority;
the Effect Authorizer is not a general evidence reader.

The broker acquires fresh scoped material per operation rather than returning
or caching a reusable public bearer credential. Releasing an in-memory
credential is not a claim of immediate provider revocation.

## 5. Repository/App binding

Executor owns binding. Security identity includes provider host and immutable
repository ID; current name is verified locator/display metadata.

App-scoped custody serves explicit repository bindings naming App,
installation, exact verified generation/fingerprint, and Executor identity.
Shared App use does not duplicate PEM per repository.

An assertion must match this current binding. A browser return, supplied App
ID, OAuth exchange, or old receipt cannot overwrite it. Rename preserves
identity; transfer, uninstall, permission change, or rotation requires fresh
provider/binding verification.

## 6. Scope evidence

Before use, prove exact App/installation, canonical host, selected immutable
repository/current locator, required permissions, valid expiry, and applicable
verified generation/owner binding.

Pre-admission reads resolve identity from the provider under the admitted
host. Effects match the already admitted target. Missing, malformed,
cross-host/repository, unselected, excessive, or expired scope fails closed.

Historical slug `inari-issuer` is compatibility/provenance metadata, not a
replacement for configured App ID or a prohibition on verified dedicated Apps.

## 7. Dedicated App onboarding

The recommended Manifest flow creates a dedicated Inari Access App. Executor
performs conversion so PEM is received and stored inside its custody.
Console carries bounded intent/callback state and continuation, not the
credential-bearing response. Unused secrets are not retained for future use.

App creation and installation are separate explicit human/provider steps.
Executor rereads installation, selected repository, and permissions before
marking binding verified.

Manual existing/shared App enrollment uses the same custody/binding model.
Migration verifies the candidate before switching; old working access is not
removed first.

## 8. Dedicated-App OAuth integration

Execution private-key custody and OAuth client authentication are different.
Manifest creation does not automatically configure valid Hosted callbacks or
securely register each App's OAuth client metadata.

The integration contract must authenticate App/client configuration, callback,
Relay binding, and any service-owned OAuth secret provisioning. Arbitrary
caller App IDs or redirect URLs are not trusted registration. Token passthrough
or a separate Identity App is not an implicit workaround.

This remains an explicit integration gate, not completed capability inferred
from the existing Manifest producer. Service-owned OAuth configuration and
secrets are allowed; durable user credential storage is not.

## 9. Enrollment and storage

Enrollment is streamed, bounded, owner-authorized, and available before normal
execution readiness. Executor verifies key type, App identity, safe storage,
and provider binding before returning its public receipt.

Configuration/observations expose public identities/fingerprints, not keys or
cross-host owner paths. Observation performs no migration/directory creation.
Canonical custody wins over labelled legacy adoption input. Missing key or
mismatch never selects ambient `gh auth`, App-user credentials, or another
repository's binding.

## 10. Execution and trusted code

Normal execution uses user-owned Admission -> Executor. Independent Direct
App execution remains temporarily frozen compatibility under its existing
explicit selection contract, outside the Local Admission lock. Existing
Hosted/remote contracts remain unchanged only where still exposed; this
decision does not restore previously removed routes or tools. Hosted/remote
target details remain deferred and are not claimed as implemented, deployed,
or certified live. Local Admission failure never silently falls back to a
frozen route.

Existing Actions protected-context validation belongs to that historical
adapter, not the universal new trust model. Any retained adapter must feed the
canonical execution architecture and cannot load PR-controlled code under
privileged credentials.

Keys/tokens never enter agent children, fork jobs, browser persistent storage,
Hosted semantic services, MCP client configuration, or retained evidence.
Module isolation is distinct from OS isolation; a public type grants no custody.

## 11. Errors and postconditions

Sanitize broker/provider errors before exposing them. Never echo tokens,
headers, PEM, OAuth callback payloads, or raw provider bodies.

A provider response is not semantic success. Executor rereads actual state and
verifies the planned postcondition. Unknown outcomes remain possibly executed
and require reconciliation before replay or compensation.

## 12. Separation of duties

Requester, App proposal actor, commit author, reviewer, approver, and merger
remain separately attributable. Inari Access does not approve its own PR.
Semantic merge admission requires independent policy and an authorized
provider path; the initial effect set does not supply that path.

Evidence records public owner/App/installation/repository, exact task/Source,
revision/generation, and verified outcome, not the credential used.

## 13. Verification

Prove read/effect separation, exact identity/scope/expiry, no token return,
sanitized callback failure, stale binding denial, and no ambient fallback.

Prove dedicated/shared custody without duplication, pre-ready enrollment,
Manifest containment, rename/transfer/uninstall behavior, and assertion
matching against current Executor binding.

This document is not proof of live permission or OAuth configuration. Those
require separately authorized operational certification.
