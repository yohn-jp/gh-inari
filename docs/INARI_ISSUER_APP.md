# Inari Access: App Principal and Credential Profiles

Status: normative provider boundary under [Product Architecture Canon](./ARCHITECTURE.md). This historical filename is retained as a link, not a separate Issuer architecture. The public App name is Inari Access.

## 1. One App identity, separate uses

Inari Access is a GitHub App identity, not an Executor, policy engine, reviewer or repository authority. Hosted ingress uses its GitHub App user-authorization profile; user-owned Executor uses its installation-execution profile. There is no additional Endpoint App or Inari Identity App in the approved target.

App database ID, OAuth client ID, App slug, installation ID and repository ID are different identities. Bind and verify each at its relevant boundary. The historical `inari-issuer` name in code/provenance does not define a second App or require every dedicated App to share a slug.

## 2. User-authorization profile

Hosted authenticates a GitHub user and observes repository eligibility through the configured App installation. The GitHub user token stays only in the bounded authentication/verification operation. Hosted signs a [Repository Access Assertion](./REPOSITORY_ACCESS_ASSERTION.md), then discards the token. It does not forward the token or perform normal GitHub mutations.

GitHub App user tokens are constrained by both user and App permissions/resources. This does not guarantee the token is read-only when both possess write permission. Hosted's permitted use is authentication and eligibility observation only; no-storage is not a substitute for enforcing that use boundary.

The OAuth App/client identity used for the assertion must match the execution App identity confirmed by Executor. Dedicated-App onboarding therefore needs matching authorized OAuth configuration. A shared OAuth token is not proof for a different dedicated execution App.

## 3. Installation-execution profile

Executor owns App private keys, credential generations and repository-to-App/installation bindings. Its broker acquires narrowly scoped installation authority for the exact admitted repository/operation and does not return a reusable token or generic client to a caller.

Evidence reads are a separate bounded read capability from mutation. The initial effect ceiling covers repository evidence plus governed branch creation/deletion and PR creation, ready and close. It does not implicitly grant Issue write, administration, workflow changes, review/approval or merge.

An operation outside the implemented admitted effect set remains unsupported until its owning contract is explicitly approved and implemented. The product's semantic merge API is not proof that this App profile has merge authority. Never substitute caller OAuth credentials to bypass a missing provider capability.

## 4. Evidence and effect separation

The read capability performs only allowed repository-bound evidence requests. The Effect Authorizer accepts only an already planned and admitted effect; it does not choose names, derive artifacts, decide lifecycle policy or implement a generic GitHub proxy.

Scope evidence must bind App, installation, provider host, immutable repository, current locator and requested permissions. Check exact permission ceiling and expiry, reject excess/unselected scope, and sanitize provider/broker failures. The installation credential is contained for the scoped operation and discarded according to the broker contract.

Executor compares the assertion's repository/App/installation evidence with its own current binding. Hosted never creates or overwrites that binding. Verification success must not make stale credential generations current.

## 5. Custody and onboarding

Dedicated repository Apps and explicit manual shared Apps use the same App-scoped custody and repository-binding model. A shared App does not gain isolation by copying its PEM into per-repository directories.

Manifest conversion is Executor-owned. The temporary conversion code crosses only the authorized enrollment boundary; key material is received and stored inside Executor. App creation and repository installation are distinct human/provider steps. Binding becomes verified only after authoritative installation/repository observation.

Service OAuth client secrets needed for Hosted authentication are distinct from the App signing private key. Their provisioning and callback binding must be explicit. No App private key or installation token enters Hosted, browser state, repository files, generic Setup JSON, Relay jobs or retained evidence.

## 6. Rotation, revocation and publication

Prepare/enroll and verify the replacement before switching an active binding. Prove normal execution with the candidate before optionally retiring old access. Do not delete an App credential still referenced by another repository. Authority and Relay key rotation are separate operations.

Provider execution identity remains App-backed; the authenticated requester is recorded as bounded provenance, not impersonated by changing the GitHub credential. Commit authorship, publication identity, human review and merge authority remain distinct.

## 7. Migration

Direct App as a separate execution deployment is retired. Reuse its canonical broker/Core/effect implementation only behind the user-owned Executor. Remove deployment-specific trust/context assumptions rather than declaring an Actions runner or Worker to be the semantic authority.

The old provider contract and public symbols are implementation evidence, not a permanent license for parallel execution. [Architecture Convergence](./ARCHITECTURE_CONVERGENCE.md) records the remaining migration and certification gates.
