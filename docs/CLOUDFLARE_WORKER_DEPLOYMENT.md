# Cloudflare Worker deployment (#468)

This document covers the stateless direct Inari App deployment frozen by
Epic #463: a Cloudflare Worker that hosts the #377 `POST /v1/execute`
transport and delegates entirely to the existing #465/#466 Session-authorized
Change execution and branch-advance authorities through the #464 GitHub App
installation credential broker.

The Worker itself owns no authentication, capability admission, Change, or
branch semantics, and no persistent state. It is pure deployment/composition:
environment/secret validation, the frozen HTTP transport, and a bounded
non-secret `/healthz`.

In the canonical architecture this is the **Direct App / Worker Deployment
Profile**. Cloudflare Worker is the Runtime Host, `POST /v1/execute` is the
Ingress/HTTP Transport Adapter, the App Principal and Credential Broker contain
provider credentials, and the shared Session-authorized Executor/Lifecycle
Controller supplies semantics. The profile is therefore equivalent in meaning
to MCP/App and Actions compatibility paths; it is not a new Authority or
execution policy.

## Architecture

```
Cloudflare Worker (src/worker.ts)
  -> createDirectAppSessionExecutor (src/github/direct-app-execution.ts)
       -> GitHubAppInstallationCredentialBroker (#464)
       -> createAppRepositoryEvidenceReader (#464-backed evidence adapter)
       -> GitHubRepositoryEvidenceReader / GitHubChangeStateProjector / TrustedChangeExecutor (existing Change Core)
       -> executeBranchAdvance (#466)
  -> createDirectAppHttpHandler (#377, src/agent-authority/direct-app-http.ts)
```

No KV, D1, Durable Object, or session/policy database is used. Every request
resolves fresh App installation credentials through #464 and discards them
at the end of the request.

## Runtime

- Cloudflare Workers ES module `fetch` entrypoint (`src/worker.ts`, built to
  `dist-worker/worker.js`).
- `compatibility_date = "2026-09-01"` with `compatibility_flags = ["nodejs_compat"]`
  (required for `node:crypto`, reused unchanged from the existing Node/Web
  crypto primitives -- no Worker-only signing format is introduced).
- Public routes: `POST /v1/execute` (the frozen #377 wire contract) and
  `GET /healthz` (bounded non-secret build/readiness metadata only -- it
  never resolves or lists installations, Runtime authorities, certificates,
  or repository policy).

## Environment configuration

### Secrets (Worker secret bindings; never committed)

| Name                           | Description                          |
| ------------------------------ | ------------------------------------ |
| `INARI_GITHUB_APP_ID`          | GitHub App numeric identity.         |
| `INARI_GITHUB_APP_PRIVATE_KEY` | GitHub App private key, PEM-encoded. |

### Non-secret configuration (`wrangler.toml` `[vars]`)

| Name                                  | Description                                                                                                                                                                                                                                  | Default                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `INARI_GITHUB_APP_INSTALLATION_ID`    | GitHub App installation identity for the target repository.                                                                                                                                                                                  | none (required)          |
| `INARI_TARGET_REPOSITORY_OWNER`       | Fixed target repository owner.                                                                                                                                                                                                               | none (required)          |
| `INARI_TARGET_REPOSITORY_NAME`        | Fixed target repository name.                                                                                                                                                                                                                | none (required)          |
| `INARI_TARGET_REPOSITORY_HOST`        | GitHub host.                                                                                                                                                                                                                                 | `github.com`             |
| `INARI_TARGET_REPOSITORY_NODE_ID`     | Skips one installation-repository-selection round trip when set.                                                                                                                                                                             | none (optional)          |
| `INARI_GITHUB_API_URL`                | GitHub API origin, for GitHub Enterprise Server.                                                                                                                                                                                             | `https://api.github.com` |
| `INARI_MAX_BODY_BYTES`                | Bounded downward/upward override of the #377 HTTP body ceiling, within its compile-time hard limit.                                                                                                                                          | 1 MiB (#377 default)     |
| `INARI_GITHUB_API_REQUEST_TIMEOUT_MS` | Bounded deadline (ms) applied to every GitHub provider request (installation token, repository/tree/blob reads, mutations), within a 30s compile-time hard ceiling. A hung provider fails the request closed instead of executing unbounded. | 10000 (10s)              |

Caller input can never override any of these values: they are read only from
the Worker's own environment, never from the request. Missing or malformed
secrets/configuration fail closed -- `POST /v1/execute` returns a bounded
`WORKER_CONFIGURATION_INVALID` error and `/healthz` reports `ok: false` with
a `503`, in both cases without revealing which value was invalid.

## One-time setup

1. **Confirm the Inari GitHub App permission ceiling.** The installed App
   must have exactly: Contents (write), Pull requests (write), Issues
   (read), and the automatic Metadata (read) baseline. No Issues write,
   administration, Actions/workflow, secrets, review/approval, or merge
   permission. If the manifest changed, GitHub requires the installation
   owner to re-consent before the new permission set takes effect -- do
   this before the first live request.
2. **Install/authenticate `wrangler`** (pinned devDependency; see
   `package.json`). Authenticate with `pnpm exec wrangler login` or an
   `CLOUDFLARE_API_TOKEN` environment variable, per Cloudflare's standard
   Wrangler auth flow.
3. **Set the target repository non-secret vars** in `wrangler.toml`
   (`INARI_GITHUB_APP_INSTALLATION_ID`, `INARI_TARGET_REPOSITORY_OWNER`,
   `INARI_TARGET_REPOSITORY_NAME`) for the deployment's target repository.
4. **Set the Worker secrets** (never edit `wrangler.toml` for these):
   ```
   pnpm exec wrangler secret put INARI_GITHUB_APP_ID
   pnpm exec wrangler secret put INARI_GITHUB_APP_PRIVATE_KEY
   ```
5. **Build and deploy**:
   ```
   pnpm run worker:build
   pnpm run worker:deploy
   ```
   `worker:deploy` is an explicit operator action; it is never run by PR CI.

## Endpoint verification

- `curl https://<worker-host>/healthz` must return `{"ok":true,...}` with
  HTTP 200 and no secret value in the body.
- Record the deployed Worker URL together with the exact source/deployment
  SHA (`git rev-parse HEAD` at deploy time) and the `wrangler deploy`
  version ID -- required by #378 before live dogfood, without recording any
  secret.
- A real `POST /v1/execute` call with a valid #373 Session-signed request is
  the live proof owned by #378, not this deployment leaf.

## Rollback / removal

- Disable the endpoint without deleting it: `pnpm exec wrangler deployments
list` then `pnpm exec wrangler rollback <deployment-id>` to an earlier
  (or absent) deployment, or `pnpm exec wrangler delete` to remove the
  Worker entirely.
- Rotate or remove the App private-key secret independently of the Worker's
  deployment state: `pnpm exec wrangler secret delete
INARI_GITHUB_APP_PRIVATE_KEY`, then rotate the key from the GitHub App
  settings page and `wrangler secret put` the replacement.
- Neither action mutates any repository state: the Worker holds no
  persistent session/policy database to reconcile.
