# Cloudflare Deployment Profiles

Status: deployment classification under
[Product Architecture Canon](./ARCHITECTURE.md).

## Supported target

Cloudflare may host the authenticated public ingress, Runtime Relay, and
optional static remote UI described in
[Hosted Authentication and Runtime Relay](./HOSTED_RELAY_DEPLOYMENT.md).
Repository semantics, Admission, provider execution, and private owner state
remain on the user-owned Runtime.

Hosted may hold its service-owned OAuth configuration and assertion-signing
key. It must not hold Inari Access execution keys/installation tokens, Runtime
Authority keys, or persistent user access/refresh credentials.

## Retired Direct App deployment

The independent App-credential Worker historically implemented by
`src/worker.ts` and `wrangler.toml` is not a target deployment. It must not be
advertised as an alternative when canonical Runtime/Relay execution is
unavailable.

Existing source/configuration may remain until the governed retirement is
implemented. This document does not disable a live Worker, remove secrets,
revoke an App, delete shared Core code, or claim migration completed.

## Controlled retirement

Inventory actual deployed versions, public entrypoints, consumers, configured
secrets, and required rollback evidence under operator authority. Prove the
replacement ingress into common Admission/Executor before cutting over.

Remove independent execution selection and provider custody from Hosted.
Retain only shared libraries used by the canonical Executor and bounded old-
representation readers with explicit consumers. Historical release records
retain their original revision and are not current setup instructions.

Disabling a deployment or removing its secrets requires explicit operational
authorization and verification. No documentation update performs those actions.

## Verification

The Hosted runbook defines build/configuration, routing, authentication,
retention, reconnect, and live certification. A successful old Worker build is
not evidence for the new assertion/Relay model. Record exact source/deployed
identity and distinguish deterministic tests from live provider proof.
