# Native MCP and Remote Client Boundary

Status: normative transport/client contract under [Product Architecture Canon](./ARCHITECTURE.md). The historical filename does not identify an Issuer gateway or independent executor.

## 1. Responsibility

MCP exposes bounded Inari operations backed by the same user-owned Core, Admission and Executor as other clients. It translates protocol input/output; it does not own repository policy, identity joins, Session issuance, provider credentials or lifecycle legality.

Local pure discovery/schema/preview operations may use Core without mutation authority. Provider reads and mutations use their corresponding admitted runtime paths. Read access is not represented by a fake mutation capability.

## 2. Hosted path

Hosted handles the supported HTTP MCP/authentication transport and routes to the configured public Relay locator. The user-owned Runtime provides semantic catalog/results and performs repository authorization and execution. Hosted must not run a second semantic tool implementation or directly answer private repository-work queries from GitHub/cache.

Remote clients authenticate through the Inari Access user-authorization profile. Hosted sends only a signed request-bound [Repository Access Assertion](./REPOSITORY_ACCESS_ASSERTION.md) and the request downstream. GitHub credentials are neither MCP execution credentials nor Relay payloads.

A client does not have to generate an ephemeral Session key or obtain a new Hosted Session Certificate for this human-operated profile. Runtime still requires explicit authority for the subject and operation; OAuth/repository visibility alone cannot enable writes or operator controls.

## 3. Protocol authentication

Implement the supported MCP protected-resource/authorization metadata and token audience requirements. A Hosted client-access token, GitHub upstream user token and Runtime-bound assertion have different purposes and audiences. Do not accept arbitrary provider tokens as MCP bearer credentials or forward a client bearer to a downstream provider.

Browser/code-flow authentication retains PKCE, state, exact callback and bounded expiry. Finite authentication state does not imply a durable user account database. Missing client-compatible authentication support is a blocked integration, not permission to ask an LLM to copy a GitHub credential through tool arguments.

## 4. Surface restrictions

The catalog contains only implemented, versioned, admitted semantic operations. It is not a shell/argv tunnel, arbitrary HTTP proxy or a generic GitHub API gateway. Parameters cannot select an arbitrary backend URL, owner credential, filesystem path or unbound repository.

Control/enrollment, review/approval, trust and merge are not automatically exposed because an equivalent local command exists. Each needs its explicit owner/operation authority and supported provider path. Preserve denials until those contracts exist.

MCP Apps or a hosted static UI are thin projections over the same authorized results. UI availability does not confer authority. A disconnected Runtime is unavailable, not a cue to use Direct App or ambient credentials.

## 5. Failure and migration

Translate bounded Runtime outcomes without inventing semantic success. Preserve request correlation, delivery uncertainty, authentication expiry, stale evidence and denied operations. Reconnect/retry uses Runtime's idempotency/reconciliation contract.

The old signed-Session Direct App bridge and historical gateway architecture are not the new remote Golden Path. Retire independent execution entry points while preserving only necessary, explicit data/protocol adapters that reach the canonical runtime. Exact public removals and client migration require verified consumer inventory.

Prove real client authentication, private-repository denial/success, wrong audience/locator, unsupported tool denial, no token leakage, common Runtime execution and reconnect uncertainty. A protocol initialize response alone proves none of those product properties.
