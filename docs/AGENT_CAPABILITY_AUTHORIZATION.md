# Caller Authentication and Capability Authorization

Status: normative target under [Product Architecture Canon](./ARCHITECTURE.md). Existing wire contracts remain revision-specific until their migration is implemented and certified.

## 1. Distinct authorities

GitHub owns repository facts and protected repository trust. Repository Canon defines policy. Authority owns bounded delegation signing. Admission authenticates caller evidence and admits semantic requests. Executor owns Inari Access provider custody, repository bindings and effect execution. Hosted attests authenticated caller eligibility; it does not issue Inari capabilities.

A provider identity is not the requester. A transport identity is not a repository grant. A public key fingerprint is not repository trust. A valid signature proves the named signer signed the payload, not that every claim is true or every operation is allowed.

## 2. Caller-evidence profiles

Local delegated work uses the current Authority-signed LocalSessionBinding and Admission-owned Session lifecycle. Its task remains the Implementation; Source-bound Change claims and exact leaf-branch evidence retain their independent meanings. Local binding is not Session Certificate V1 and does not require a cloud client to manage an ephemeral signing key.

The remote human-operated profile uses the [Repository Access Assertion](./REPOSITORY_ACCESS_ASSERTION.md). Hosted verifies GitHub identity and repository eligibility with a transient Inari Access user token, signs bounded evidence, discards the token and relays the request. Runtime verifies that evidence and performs normal semantic admission. Remote clients do not need a new Hosted-issued Inari Session or a Session-key bootstrap protocol.

Existing certificate/PoP formats are historical/delegated caller-evidence formats, not a reason to keep Direct App execution. Retaining a format requires a real supported consumer and a bounded adapter into the canonical admission path. Do not add it as a second remote Golden Path.

A trusted local operator can perform explicitly authorized bootstrap/control operations. That profile is not available merely because a cloud caller has authenticated or knows a relay URL.

## 3. Admission conditions

Admission evaluates authenticated subject, immutable repository, requested operation and semantic target; it obtains current repository/Implementation and owner-binding evidence through bounded ports. Task-bound operations additionally require current authorization body digest, base/branch binding, scopes, Source set and applicable capability/validity limits.

For a delegated Implementation Session, a Source operation requires membership in both the signed Source set and the freshly read current contract. Adding a Source later does not widen an existing Session; removing one prevents continued access. The task-bound publication compatibility claim never authorizes an Implementation-root Change.

A remote assertion establishes only eligibility. It does not create the subject's task authorization or permit every capability under a trusted Authority's ceiling. Explicit Runtime/repository authorization must admit the subject and operation. Missing policy or evidence fails closed before mutation. Read-only users do not gain App write power merely because Hosted observed repository visibility.

Pure local compile/render/schema work does not require provider mutation authority. Repository reads use their own bounded read admission, not a fabricated `change.implement` grant. Control, enrollment, delegation, review and merge remain separately authorized operations.

## 4. Credential domains and owners

Authority delegation keys stay at the Authority owner. App private keys and installation credentials stay at Executor's Inari Access broker. Local Session bindings and their lifecycle belong to Admission. Relay transport private keys stay at the user-owned Relay client. Hosted assertion signing and OAuth client secrets are service-owned authentication material.

GitHub user access/refresh tokens are transient at Hosted authentication. They are never sent to Runtime or placed in Relay persistence, logs or retained evidence. Admission receives public validated identity/scope evidence, not provider credentials. Executor does not use caller OAuth credentials for normal GitHub effects.

No credential class is interchangeable with another. Co-location is not permission to import a sibling's private store. Key rotation in one domain does not silently rotate or widen another.

## 5. Execution and effect limits

After admission, Executor uses the canonical evidence, Core planning, Lifecycle Controller, Effect Authorizer, provider adapter and postcondition verifier. The broker scopes installation authority to the exact repository and admitted permissions. It does not return a reusable token to a caller.

The initial Inari Access effect contract is not a grant to approve or merge PRs. Product support for a semantic merge request and the provider profile's authority to execute it are distinct. No unsupported operation is enabled by substituting an ambient user credential or by widening the App ceiling during migration.

Every privileged result is verified through current authoritative reread. A transport success, old actor snapshot or caller-provided effect receipt is insufficient.

## 6. Trust changes and revocation

Repository delegation trust comes from the protected canonical ref. First registration, rotation and revocation use explicit owner-controlled trust changes and independent human review. Setup publication is not trust. An authenticated remote user cannot self-approve trust, sign a delegation or change its ceiling.

Runtime explicitly accepts each Hosted assertion issuer and its permitted scope. Removing that trust blocks new acceptance. Existing assertions are observations with finite validity, not real-time membership feeds. Authentication freshness, Session lifecycle, repository trust and App installation changes are separate checks.

## 7. Replay, restart and failure

Authenticate and authorize before recording a request as eligible for an effect. Bind replay fences to caller, repository, target, request identity and relevant generation. Protect fences through their entire admissibility/uncertainty window across restart.

An identical retry may resolve an existing result according to canonical idempotency rules; it does not obtain a new effect. Wrong-payload reuse is denied. An unknown result after a possible effect requires reread/reconciliation, not blind retry or automatic reassignment to another Runtime.

Failure diagnostics are bounded and secret-free. Preserve whether a failure occurred during repository resolution, trust observation, Session/identity admission, Implementation admission, provider execution or result verification. Do not return raw downstream exceptions.

## 8. Security evidence and migration

Required negative cases include wrong user/repository/App/installation, wrong issuer/relay/audience, replay, expiry, stale body/base/branch/Source evidence, malformed owner state, unavailable evidence, trust-root writes, absent subject authorization and credential leakage. Positive tests must exercise the real shared execution composition.

The observed baseline contains older Direct App/Session and Hosted Endpoint paths. Their existence does not authorize new work on that architecture. [Architecture Convergence](./ARCHITECTURE_CONVERGENCE.md) separates retained data adapters, removed execution profiles and implementation prerequisites.
