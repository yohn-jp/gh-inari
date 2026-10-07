# Cloudflare Deployment Profiles

Status: deployment classification under
[Product Architecture Canon](./ARCHITECTURE.md).

## Deferred Hosted target

Cloudflare may host the authenticated public ingress, Runtime Relay, and
optional static remote UI described in
[Hosted Authentication and Runtime Relay](./HOSTED_RELAY_DEPLOYMENT.md).
Repository semantics, Admission, provider execution, and private owner state
remain on the user-owned Runtime.

This approved placement remains deferred from the Local Admission lock. This
section does not claim the target is implemented, certified, or deployed.

Hosted may hold its service-owned OAuth configuration and assertion-signing
key. It must not hold Inari Access execution keys/installation tokens, Runtime
Authority keys, or persistent user access/refresh credentials.

## Temporarily frozen Direct App compatibility

The independent App-credential Worker code in `src/worker.ts` and
`wrangler.toml` is outside the active local lock target; this document does
not classify its current deployed state. Existing explicit DirectApp
selection, exported APIs, and configuration/Session readers remain frozen
under their current contracts. This decision does not delete, deprecate,
disable, or set an expiry for them. Local Admission failure never silently
selects the compatibility route.

No migration or deployment change is authorized by this classification. It
does not disable a Worker if one is configured, remove secrets, revoke an App,
or claim a migration completed.

## Deferred convergence

The approved future target inventories deployed versions, public entrypoints,
consumers, configured secrets, and rollback evidence under operator authority;
proves replacement ingress into common Admission/Executor; then removes
independent execution selection and provider custody from Hosted. It retains
only shared libraries used by the canonical Executor and bounded old-
representation readers with explicit consumers.

This convergence remains deferred and is not a local lock prerequisite. This
Issue authorizes no deployment, secret, selection, or provider-custody change.
Existing compatibility remains under its current contracts. Historical
release records retain their original revision and are not current setup
instructions.

Disabling a deployment or removing its secrets requires explicit operational
authorization and verification. No documentation update performs those actions.

## Verification

The Hosted runbook defines build/configuration, routing, authentication,
retention, reconnect, and live certification. A successful old Worker build is
not evidence for the new assertion/Relay model. Record exact source/deployed
identity and distinguish deterministic tests from live provider proof.
