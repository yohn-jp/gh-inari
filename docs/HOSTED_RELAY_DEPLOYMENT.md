# Hosted Authentication and Inari Relay

Status: approved target deployment under [Product Architecture Canon](./ARCHITECTURE.md). The repository still contains the earlier repository-routed Endpoint/Dashboard implementation at the observed baseline. This guide does not certify that the target routes or handshake have shipped.

## 1. Purpose

Hosted exposes a public authenticated transport to a user-owned Inari Runtime for cloud clients. It owns GitHub OAuth authentication, bounded repository-eligibility verification, assertion signing, routing and delivery control. It does not own repository semantics, normal provider effects, Session issuance, repository-work projection or an independent account system.

Inari Access provides both GitHub user authorization for ingress and installation authority inside Executor. A separate Endpoint App or Inari Identity App is not part of the target. See [Repository Access Assertion](./REPOSITORY_ACCESS_ASSERTION.md).

## 2. Runtime locator and connection

The Runtime creates and retains a Relay transport keypair in owner-local private storage. Its public-key fingerprint determines a stable, versioned relay locator. This key is not the Authority delegation key or the App key.

```text
Runtime -> outbound WebSocket -> Hosted
Hosted -> fresh bounded challenge -> Runtime
Runtime -> public key + bound proof -> Hosted
Hosted -> verify proof and locator -> activate routing
Hosted -> confirmed relay ID + public endpoint -> Runtime/operator
```

The proof binds protocol/domain, intended Hosted origin, challenge, public key and connection attempt. Challenges expire and cannot be reused. The locator is derived from the validated canonical public key, not accepted as an arbitrary string chosen by a connecting peer.

The public path is conceptually `/r/<relayId>`. Exact paths/encoding are protocol-versioned producer outputs, not new CLI commands defined by this document. A confirmed connection returns the URL for client configuration. Reconnection with the same key retains the locator; replacing the key changes it. Offline status never causes fallback to another Runtime.

A routing slot must reject unauthorized replacement and fence old connections/results by connection generation. An explicit reconnect policy handles simultaneous connections for the same key. It must not silently route a job to whichever socket last wrote a map entry.

The operator supplies the locator to the client. Knowing it grants no repository authority. Private repository access is verified during authentication, not through publicly readable Canon discovery.

## 3. Request path

Hosted verifies the caller through Inari Access OAuth and checks eligibility for the selected repository/App installation. It forwards the signed, request-bound Repository Access Assertion plus the bounded request to the selected live Runtime. The user token is discarded and never enters the Relay job or Runtime request.

Runtime verifies the assertion and current Executor binding and performs semantic admission. Responses return through the same correlated delivery path. Hosted does not interpret Issue/PR/Change state, select the execution App, or turn an error into a success.

Runtime-owned MCP/Control adapters implement product operations. Hosted MCP terminates only the supported HTTP/protocol/authentication transport, not a second product catalog or semantic executor. The same rule applies to any hosted static UI: repository data and actions come from user-owned services.

## 4. State and retention

Persist service configuration, permitted OAuth client configuration and service signing secrets through the deployment's protected secret/configuration facilities. Do not persist GitHub user tokens, refresh tokens, user profiles, repository membership, raw requests/responses or a semantic repository database.

Live routing associates relay locator with authenticated connection generation. It is reconstructible after reconnect; a permanent Runtime registration database is not required. Hibernation attachments are bounded connection metadata, not account records.

Finite authentication transaction state, nonce fences and delivery metadata may be retained for their safety window. Delivery records contain correlation, connection generation, deadline and delivery/result classification, not reusable credentials. Any result retention must be explicitly bounded and secret-safe; full payload caching is not the default.

A restart must not erase the evidence needed to distinguish not-delivered from possibly-delivered. If safe recovery cannot be proved, return unknown/unavailable and let Runtime reconciliation decide. Stateless identity does not mean zero safety state.

## 5. Delivery and abuse controls

Apply message/body limits while reading, not after unbounded buffering. Bound connections, in-flight work, retention, deadlines and per-caller/per-locator traffic. Refuse overload before send when possible.

Distinguish not-delivered, possibly-delivered and result-observed. After send or an ambiguous send failure, reconnect does not authorize replay. Delivery completion is not semantic verification. Runtime owns idempotency and provider reread.

TLS protects each transport hop. This design does not claim payload end-to-end encryption or protection from a malicious Relay seeing traffic. Hosted can deny service or forge an assertion if its signing authority is compromised; Runtime's separate authorization limits, rather than a transparency claim, constrain resulting effects.

## 6. Configuration and key rotation

OAuth callback/client configuration must match the actual Inari Access App used by the target Executor binding. A dedicated-App flow does not automatically configure shared Hosted OAuth. Do not accept an arbitrary client's callback, issuer, key URL or backend URL as trusted configuration.

Assertion issuer trust and signing-key rotation are explicit Runtime configuration. Relay transport-key replacement is a separate local operation. App key rotation remains Executor-owned. None of the three rotations implies another.

Remote Control initially uses explicit endpoint, component identity and trust material. Hosted does not become a PKI or discover owner secret paths. Loss of Hosted removes remote connectivity; local governance and owner state remain usable.

## 7. Deployment transition

At the observed baseline, `src/hosted-worker.ts`, the Relay modules and `wrangler.hosted.toml` still implement the earlier Endpoint model. Existing build/deploy commands describe that code, not this target. Do not deploy an unchanged build and label it assertion-based Relay conformance.

The old repository-ID Durable Object routing must migrate to relay-locator routing with explicit protocol/version and client migration. Existing bounded delivery/backpressure mechanics are reused where their guarantees remain valid. Hosted work readers, semantic execution, repository caches and webhook-driven repository projection are removed from this deployment rather than hidden behind compatibility flags.

Static public onboarding metadata may remain for transport/version/authentication discovery. It must not become a repository binding authority. Repository/work observations are requested from Runtime. Direct App deployment is retired as described in [its retirement notice](./CLOUDFLARE_WORKER_DEPLOYMENT.md).

No new `inari relay connect` spelling is promised by this guide. Public commands and MCP metadata are published by the canonical command/protocol producers when implemented.

## 8. Certification

Separate deterministic protocol tests, real-process Runtime composition, packed public-client/browser tests and live Hosted/GitHub proof. Record exact package/deployment revision, authentication App and target binding, wrong-target denials, no-token-retention evidence, reconnect/unknown-delivery behavior and operation-level postcondition verification.

A health response, OAuth callback, successful WebSocket upgrade or transport-only live probe is not proof of repository readiness or a successful governed operation. See [Verification Architecture](./VERIFICATION_ARCHITECTURE.md).
