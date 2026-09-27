# Repository Access Assertion

Status: approved target contract under [Product Architecture Canon](./ARCHITECTURE.md). This is not an implemented wire-schema claim. Production activation requires the versioned producer contract and the evidence in [Architecture Convergence](./ARCHITECTURE_CONVERGENCE.md).

## 1. Purpose and trust

Hosted verifies a GitHub user's eligibility for one repository using a transient Inari Access user credential. Only a signed assertion and the bounded Inari request cross the Relay into the user-owned Runtime. Runtime never receives that GitHub credential.

An assertion is Hosted's attestation of a bounded observation. It is not a GitHub-signed token, a delegation certificate, an Inari capability, proof of GitHub write permission, or continuously current membership. Runtime explicitly trusts a configured issuer to authenticate the user and truthfully attest the observation. Signature verification proves issuer authenticity and message integrity, not issuer honesty.

A compromised issuer can forge eligibility within that trust boundary. Runtime-side repository binding, explicit subject/operation authorization, trust protections and capability ceilings remain necessary. Do not claim that an issuer signature removes Hosted from the authentication trust base.

## 2. Issuance

The authentication transaction binds the intended Hosted origin, relay locator, App identity, redirect, nonce/state and expiry before exchanging a code. Browser authorization uses the provider's supported authorization-code flow with PKCE and state validation. Callback success, caller-supplied IDs and an unverified login string are not proof of identity.

Hosted uses the resulting user credential only inside the bounded authentication/access-verification operation. It obtains the immutable provider user identity, verifies the App/installation context and proves the target repository is accessible through that installation. Public repository fetch success alone is insufficient: installation membership and authenticated-user evidence are still required. Paginated evidence must be complete enough to prove the exact target; incomplete collection results do not prove absence or access.

The assertion binds the App database ID, installation ID and immutable repository identity. Client ID, App slug, repository name and user login remain different concepts. An assertion from App A cannot be substituted for an Executor binding to App B, even when the user can access the same repository through both.

The approved design uses the same Inari Access App identity for the two credential profiles. Dedicated-App onboarding must therefore establish the corresponding valid OAuth client/callback configuration, not silently reuse a shared login App. An unconfigured/mismatched OAuth profile is blocked. Defining its owner-approved provisioning contract is a convergence prerequisite, not license to add a generic Hosted credential vault.

## 3. Semantic claim set

The producer must publish one versioned, closed schema and canonical signing representation. All consumers use it; no adapter invents a parallel assertion. The contract must unambiguously carry:

- issuer identity and signing-key identifier; an allowlisted verification algorithm;
- GitHub provider host and immutable user ID;
- repository host and immutable repository ID;
- Inari Access App ID and installation ID;
- intended Runtime/Relay audience and exact relay ID;
- repository-visibility observation time, issuance time, validity bounds and a bounded unique assertion/request identifier;
- binding to the exact bounded invocation, including operation, semantic subject and canonical request identity/digest.

It carries no GitHub token, refresh token, OAuth code/verifier, App/Authority/Session key, provider response, unbounded user profile, delegated capability grant or inferred write/admin flag.

Wire field names, algorithm encoding, size ceilings, clock tolerance and concrete lifetime belong to the reviewed producer schema. They must be fixed and tested before activation; prose examples or arbitrary caller values are not defaults. The lifetime is short and finite, and may not outlive its supporting observation/authorization context.

## 4. Runtime verification and admission

The user-owned ingress verifies the assertion again, even if Relay already validated it. Verification rejects an unknown issuer/key, unsupported algorithm/version, malformed/oversized claims, wrong audience/relay, future/expired times, wrong request binding and replay before invoking semantic effects.

Issuer keys come from trusted configuration or an authenticated, issuer-bound rotation mechanism. Never follow a key URL supplied by the assertion or trust a key merely because Relay sent it.

Executor supplies the current public repository/App/installation binding through a bounded evidence port. Runtime compares it exactly with the assertion and the requested repository. Stale, unavailable or conflicting binding is a denial, not a reason to switch credentials, Apps or repositories.

Admission then evaluates the current repository policy, authenticated subject, operation and task/Source/branch context. Repository visibility is only eligibility. It does not mint a Session or grant every operation under an Authority ceiling. Without an explicit applicable authorization for the subject and requested operation, mutation is denied.

Remote human-operated invocation does not require the cloud client to generate a Session PoP key or receive a new Session Certificate. Its caller-evidence profile differs from local delegated Session evidence; both feed the same semantic admission and Executor pipeline. Existing delegated Session controls are not weakened by this profile.

Trust-root changes, review, approval, merge and destructive operator controls retain their separate explicit authority. A remote repository read or OAuth login cannot activate those rights.

## 5. Freshness, revocation and retry

An assertion records eligibility at its observation time. Without another provider observation, revocation after issuance cannot be known instantaneously. Validity limits the stale-observation window; documentation and UI must not call this continuous GitHub user authorization.

Expired eligibility requires renewed authentication/provider evidence. Hosted must not issue a fresh assertion indefinitely from an expired observation merely because its signature is valid. Runtime may narrow or revoke accepted issuer/subject access independently through its controlled policy.

Replay defense binds assertion ID, caller, target and request. Reuse for a different request is rejected. A same-request retry may return retained bounded execution evidence only under the existing idempotency contract; it never creates a second effect. A nonce alone is not replay protection without a consuming store/fence.

Runtime owns the execution replay/idempotency fence. Its retention must cover the admissible lifetime and uncertainty window and remain safe across process restart. Relay delivery IDs and authentication nonces are separate domains; neither replaces the execution fence.

After a possible effect, expiry or response loss does not mean the effect failed. Re-authenticate as required to read the result, then reconcile current owner/provider evidence before any retry.

## 6. Credential and state handling

GitHub user access and refresh credentials are never written to Hosted databases, Durable Object state, queues, logs, traces, crash reports or retained certification artifacts. They are not forwarded to Runtime. OAuth codes/verifiers and authentication cookies are protected temporary transaction data, not durable account state.

Service-owned OAuth client secrets and assertion signing keys may persist in managed service-secret storage. They are not user credentials. Runtime transport keys persist only at their user-owned owner. Hosted may retain bounded nonce/delivery metadata necessary for safety; it must not retain raw signed assertions as an audit database.

A finite transaction or client-held Hosted access credential is not a durable Hosted user database. For HTTP MCP, protected-resource metadata and audience validation must match the supported protocol. GitHub API credentials must not be accepted as arbitrary MCP bearer credentials or passed downstream. The client-access credential and the Runtime-bound assertion have different audiences and uses.

No-storage is a property of the deployed configuration as well as the open implementation. Request-body/header logging, platform telemetry and error middleware are part of the review. Do not claim guaranteed memory zeroization in a managed runtime.

## 7. Required proofs

Prove private and public repository cases, wrong App/installation/repository, repository transfer/rename, stale visibility, unknown issuer/key, wrong relay/audience/request, expired/future assertion, replay and reconnect, Runtime restart, rejected write for visibility-only callers, and absence of provider credentials outside the transient authentication boundary.

Prove that successful remote operations reach the same real Admission/Executor path and App installation broker as local operations. A fake ready state, Hosted-side effect or injected success callback does not prove the target architecture.

## 8. External protocol references

Provider/protocol facts are checked against these upstream authorities, not inferred from internal terminology:

- [GitHub App user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app): user/App permission and resource intersection; App installation discovery.
- [GitHub PKCE support](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/): authorization-code flow protection.
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization): resource audience and token handling for the supported HTTP profile.

These protocol requirements do not confer additional Inari semantic authority.
