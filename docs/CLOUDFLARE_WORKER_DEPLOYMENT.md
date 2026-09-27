# Direct App Worker Retirement

Status: retired target deployment. [Product Architecture Canon](./ARCHITECTURE.md) is authoritative.

The independent Direct App Worker/client-to-provider execution profile is not part of the approved target. Normal local and remote mutations converge on user-owned Admission and Executor, using Executor-owned Inari Access installation credentials.

At the observed baseline, `src/worker.ts`, `wrangler.toml` and their build paths still exist. This documentation-only change does not remove them from a published package or deployment. Their presence is implementation debt to retire, not permission to add new consumers or a fallback from Hosted unavailability.

Removal must inventory public consumers/exports, migrate necessary caller-data adapters, retain shared Core/broker/effect code required by Executor, remove independent execution/deployment wiring and prove the common path. Do not delete the Inari Access App merely because this deployment is retired.

Cloudflare may continue to host authentication/Relay/static presentation under [Hosted Relay](./HOSTED_RELAY_DEPLOYMENT.md). That deployment has no App private-key or installation-token custody and no semantic GitHub execution. Historical deployment instructions remain in Git history, not an alternative current runbook.
