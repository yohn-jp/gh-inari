# Hosted Relay and MCP Worker

This profile is the Inari-hosted front door for native MCP and the Repository
Relay. It is separate from the direct-App Worker in `src/worker.ts` and
`wrangler.toml`; those files remain the App-credential deployment profile.

## Composition

The hosted Worker composes the existing stateless MCP HTTP transport (#823),
the Relay-backed Session executor (#821), and the Repository Relay Durable
Object (#819). It owns only HTTP/WebSocket routing and the Durable Object
binding. Session authority, capability admission, provider credentials, and
execution remain with the user-owned Runtime.

Public routes are deliberately bounded:

- `POST /mcp` — native stateless MCP.
- `GET /v1/relay/connect` — Runtime WebSocket ingress. It requires
  `repositoryId`, `connectionId`, and `delegatorId`; `repositoryHost` is
  optional and defaults to `github.com`. It always routes the Runtime role.
- `GET /.well-known/inari` — versioned, secret-free Endpoint onboarding
  metadata. It contains the public GitHub App identity and installation URL,
  the supported App-user Device Flow profile, and the current Worker's Relay
  connection base. It contains no repository identity, credential, enrollment
  evidence, Session, or capability data.
- `POST /v1/endpoint` — request-scoped, human-authenticated Endpoint reads for
  the configured logical Endpoint. Installation and repository identities are
  admitted dynamically through the GitHub App user scope; no static repository
  binding is used.
- `POST /v1/webhooks/github` — bounded signed GitHub App delivery admission.
  The signed installation/repository identity becomes reconciliation input only;
  it is not Dashboard authorization.
- `POST /v1/auth/github/exchange` — one-shot Dashboard Authorization Code +
  PKCE exchange. The Worker never persists the returned App-user token.
- `GET /healthz` — non-secret deployment metadata only.

The Dashboard browser shell is served from the Worker Static Assets directory
`apps/dashboard/dist`. Worker routes are evaluated first for `/v1/*`, `/mcp`,
`/.well-known/*`, and `/healthz`, so those surfaces never fall through to the
SPA shell. There is no second Dashboard server.

The native MCP catalog also advertises the read-only `inari_issue_view` tool
with the MCP Apps `io.modelcontextprotocol/ui` extension. App-capable hosts
can render the stable `ui://inari/issue-view.html` resource and refresh it by
calling that same tool through the host. Hosts without the extension continue
to receive the existing tool result and do not need the resource.

The Worker derives the Durable Object name from the immutable repository ID.
MCP dispatch uses only the internal `REPOSITORY_RELAY` binding; there is no
caller-selected backend URL, public dispatch endpoint, or generic proxy.

Hosted Runtime connections should use the Delegator ID as their bounded
`connectionId`, because #821 dispatches jobs to that deterministic connection:

```text
wss://HOST/v1/relay/connect?repositoryId=1330755860&repositoryHost=github.com&connectionId=runtime-id&delegatorId=runtime-id
```

The Runtime still proves possession of its own key and executes the signed
Session request locally. The hosted Worker never receives a GitHub App key,
provider token, Runtime private key, or Session authority state.

## Operational envelope

The Repository Relay applies compile-time contract ceilings and narrower
operational defaults for each Durable Object: 64 open connections, 16
in-flight jobs, 120 messages per one-second window, a 30-second job deadline,
32 retained job records, and a one-hour connection lifetime. Deployments may
lower these values through the Durable Object options, but cannot raise the
contract ceilings. Overload closes a WebSocket with a typed operational
backpressure outcome or returns `503`; a job rejected before Runtime send is
reported as `unavailable`/`not-delivered`.

Job records, possession nonces, and connection attachments have deterministic
deadline/retention cleanup. A send followed by disconnect or storage failure
remains `possibly-delivered` and is never converted into an automatic retry.
Hibernation heartbeat uses the Workers auto-response pair (`relay:ping` /
`relay:pong`) and does not enter the message-rate path.

Optional telemetry receives only bounded transport facts: a pseudonymous
repository key, connection/job correlation, surface, timing, delivery state,
failure class, and resource counters. Request/result bodies, signatures,
credentials, tokens, and provider responses are not part of the telemetry
interface. With the hosted profile's default sink, each event is emitted as a
JSON log line through `console.log` and is available in the Cloudflare Workers
Observability Logs for the `gh-inari-hosted-relay` service. An injected
`Env.telemetry` sink remains available for deterministic tests; it is not
required by the deployed Worker or Durable Object. Operational limits are
backpressure controls, not authorization.

Alert on sustained `failureClass` values of `overloaded`, `rate-limited`, or
`transport`, and on rising `counters.connections`, `counters.inFlightJobs`,
`counters.retainedJobs`, or `counters.messagesInWindow`. `cpu-active` event
`durationMs` and `counters.cpuActiveMs` provide CPU-cost indicators. These
signals describe transport pressure and runtime cost; they do not contain
request or result payloads.

## Build and deploy

```sh
pnpm run hosted-worker:build
pnpm exec wrangler deploy --config wrangler.hosted.toml
```

The hosted build first runs the Dashboard build and requires
`apps/dashboard/dist/index.html` before packaging the Worker. The reference
`wrangler.hosted.toml` publishes that directory as Static Assets and declares
the `RepositoryRelayDurableObject` binding with its explicit migration.

Configure the non-secret Endpoint and public App metadata:

```text
INARI_ENDPOINT_ID=dashboard-endpoint
INARI_ENDPOINT_DEPLOYMENT=shared-hosted
INARI_GITHUB_APP_ID=<numeric App database ID>
INARI_GITHUB_APP_CLIENT_ID=<public OAuth client ID>
INARI_GITHUB_APP_SLUG=<App slug>
INARI_GITHUB_APP_INSTALLATION_URL=https://github.com/apps/<slug>/installations/new
INARI_GITHUB_APP_USER_AUTH_PROFILE=device-flow
INARI_GITHUB_APP_CALLBACK_URL=https://HOST/dashboard/oauth/callback
```

Configure only the non-secret provider host partition if `github.com` is not used:

```sh
pnpm exec wrangler deploy --config wrangler.hosted.toml \
  --var INARI_HOSTED_REPOSITORY_HOST:ghe.example.com
```

The onboarding descriptor also requires these non-secret public App variables:
`INARI_GITHUB_APP_ID`, `INARI_GITHUB_APP_CLIENT_ID`,
`INARI_GITHUB_APP_SLUG`, `INARI_GITHUB_APP_INSTALLATION_URL`, and
`INARI_GITHUB_APP_USER_AUTH_PROFILE=device-flow`. For Dashboard browser
authorization, configure the exact registered
`INARI_GITHUB_APP_CALLBACK_URL` and store the confidential client secret only
with `wrangler secret put INARI_GITHUB_APP_CLIENT_SECRET`. Configure the
webhook secret separately with
`wrangler secret put INARI_GITHUB_WEBHOOK_SECRET`. The descriptor exposes the
callback URI but never either secret. The descriptor remains bounded and
unavailable until all required values are valid. Do not put an App private key,
installation token, user access token, Runtime credential, or other credential
in Worker variables or Durable Object state.

The direct-App deployment remains independent and continues to use:

```sh
pnpm run worker:build
pnpm exec wrangler deploy --config wrangler.toml
```

## Composed Endpoint and Dashboard certification

Before integrating the hosted Endpoint and Dashboard Epic, run the bounded
composition oracle and its Node test. It uses in-memory provider and Relay
transports, exercises the actual Worker, Endpoint, webhook, OAuth, and
Dashboard modules, and prints only the certified Epic and current-main SHAs:

```sh
node scripts/endpoint-dashboard-certification.mjs
node --test test/endpoint-dashboard-certification.test.mjs
```

The package suite invokes the same oracle after package-runtime and release
certification. The oracle never performs provider mutation and does not retain
tokens, private keys, signed bodies, or raw provider responses.

## Live relay certification

Live certification contacts a deployed Worker and is transport-only. It checks
`/healthz`, the native `POST /mcp` initialize exchange, the Runtime WebSocket
upgrade, the production possession handshake, `relay:ping`/`relay:pong`, and a
bounded malformed-frame close. It does not execute a semantic mutation; the
controlled certification remains the semantic parity and failure-semantics
oracle.

The direct environment form uses these inputs. The private key is read from
the environment or, preferably, from a local file; never put it in argv.

```sh
export INARI_RELAY_LIVE_URL='https://HOST'
export INARI_RELAY_LIVE_REPOSITORY_ID='1330755860'
export INARI_RELAY_LIVE_REPOSITORY_HOST='github.com' # optional
export INARI_RELAY_DELEGATOR_ID='runtime-id'
export INARI_RELAY_DELEGATOR_PRIVATE_KEY_FILE='/secure/local/delegator-ed25519.pem'
node scripts/relay-certification.mjs --mode live
```

Alternatively, set `INARI_RELAY_LIVE_CONFIG_FILE` to a local JSON file. A
relative `privateKeyFile` is resolved relative to that file:

```json
{
  "url": "https://HOST",
  "repositoryId": "1330755860",
  "repositoryHost": "github.com",
  "delegatorId": "runtime-id",
  "privateKeyFile": "./delegator-ed25519.pem"
}
```

The equivalent environment variable is also accepted as
`INARI_RELAY_LIVE_CONFIG`. The file and key must be readable by the local
operator and must remain outside retained certification evidence. The command
returns `pending` when required configuration is absent, `failed` when a
configured deployment or protocol check fails, and `passed` only after all
deployment checks contact the real Worker over the network. An injected test
transport (used only by this script's own unit tests) can complete the same
normalized checks but is reported as `verified`, never `passed` — that status
is reserved for the real-network path so downstream consumers cannot mistake
a fixture run for a deployed proof. Evidence contains only bounded status
fields and check summaries; it never contains the private key, signature,
token, or raw provider response.

## Exercising a live semantic Change against the hosted relay

Live relay certification above is transport-only. To exercise an actual
`change issue` end to end against a deployed `gh-inari-hosted-relay` Worker,
two independent local processes and two distinct pieces of Runtime identity
are both required. This has no single documented example command, and the
required pieces are easy to conflate; the steps below record the exact path.

### The two identities are not interchangeable

- **Runtime Authority** (Ed25519 keypair, canonical id like
  `yohn-runtime-2026-09`): signs the Change provenance record and the Session
  Certificate. Compatibility default local path
  `~/.config/inari/runtime-authority.pem`. Supplied to CLI commands via
  `INARI_RUNTIME_AUTHORITY_ID` / `INARI_RUNTIME_AUTHORITY_PRIVATE_KEY` (the
  latter is the **raw PEM string**, not a file path — there is no
  `_FILE`-suffixed variant for this pair).
- **GitHub App identity** (App ID + App private key + installation id): only
  needed by `runtime connect` when it falls back to the `installation-key`
  credential profile (no `--profile`/App-user input supplied). Supplied via
  `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_FILE`, `GITHUB_APP_INSTALLATION_ID`
  (or their `INARI_`-prefixed equivalents). This mints installation tokens for
  provider API calls; it authenticates the Runtime to GitHub, not to the
  Relay.

### 1. Connect a foreground Runtime to the relay

```sh
GITHUB_APP_ID=<numeric App id> \
GITHUB_APP_PRIVATE_KEY_FILE=~/.config/inari/github-app-<slug>.pem \
GITHUB_APP_INSTALLATION_ID=<numeric installation id> \
inari runtime connect \
  --relay-url wss://HOST \
  --repository <repositoryId>/<owner>/<name> \
  --authority-id yohn-runtime-2026-09 \
  --private-key ~/.config/inari/runtime-authority.pem \
  --json
```

Find the installation id from the GitHub App's installation settings page, or
`gh api /repos/<owner>/<repo>/installation` using a token with App-installation
read access (a plain user PAT/`gh auth token` is not sufficient for this
endpoint). This command is foreground and long-running; run it in the
background and keep it alive for the next step.

### 2. Issue a short-lived Session credential bundle

`inari change issue` does not mint its own Session credential; one must exist
first via `inari session issue`. The `--from` input is a
`SessionIssuanceRequestDocument`, not the Change request itself:

```json
{
  "version": 1,
  "kind": "inari-session-issuance-request",
  "runtimeAuthority": {
    "version": 1,
    "kind": "runtime-authority",
    "id": "yohn-runtime-2026-09",
    "key": { "crv": "Ed25519", "kty": "OKP", "x": "<public key from the canonical trust record>" },
    "status": "active",
    "notBefore": "2026-09-13T00:00:00Z",
    "notAfter": null,
    "maxSessionTtlSeconds": 7200,
    "capabilityCeiling": ["change.implement", "change.ready"]
  },
  "repository": { "id": "<repositoryId>", "name": "<owner>/<name>" },
  "task": { "kind": "issue", "number": <issue number> },
  "capabilities": [{ "kind": "change.implement", "issue": <issue number> }],
  "ttlSeconds": 1800
}
```

The `runtimeAuthority` block is copied verbatim from the canonical public
record at `.github/inari/authorities/<authority-id>.json` — it is a public
key, safe to inline here. Two details that are easy to get wrong:

- `kind` at the top level must be exactly `inari-session-issuance-request`
  (hyphenated). This is a different vocabulary from the Change operation
  names.
- Each capability's `kind` must be `change.implement`, **not** `change.issue`
  — `change.issue` is the CLI/operation name used later, but it is rejected
  here with `SESSION_BUNDLE_INVALID_REQUEST`.

```sh
inari session issue \
  --from request.json \
  --private-key ~/.config/inari/runtime-authority.pem \
  --to ~/.config/inari/session-credential-<issue>.json
```

The `--to` destination must not be under `/tmp` (rejected as
`SESSION_BUNDLE_UNSAFE_STORAGE`); keep it under a private config directory.
The bundle's `certificate` carries a `ttlSeconds`-bounded `exp`; reissue once
expired rather than reusing a stale bundle (Session issuance itself refuses
to overwrite an existing `--to` path, so pick a fresh path or delete the old
one first).

### 3. Dispatch the Change through the direct-App transport

`change issue` reaches the hosted relay Worker only through the **direct-App
transport**, selected by supplying both `--session-credential` and
`--app-endpoint` (or their environment equivalents,
`INARI_SESSION_CREDENTIAL_FILE` and `INARI_APP_ENDPOINT`,
resolved by `resolveDirectAppTransportOptions` in `src/cli-core.ts`). This
transport selection is not yet listed in `--help` output.

```sh
GH_TOKEN="$(gh auth token)" \
INARI_RUNTIME_AUTHORITY_ID=yohn-runtime-2026-09 \
INARI_RUNTIME_AUTHORITY_PRIVATE_KEY="$(cat ~/.config/inari/runtime-authority.pem)" \
inari change issue <issue number> \
  --repository <owner>/<name> \
  --session-credential ~/.config/inari/session-credential-<issue>.json \
  --app-endpoint https://HOST \
  --json
```

`INARI_RUNTIME_AUTHORITY_ID`/`INARI_RUNTIME_AUTHORITY_PRIVATE_KEY` are
required here too — the Session credential bundle authorizes the *capability*,
but the Change provenance record is signed locally by the Runtime Authority
key independently of the bundle. `GH_TOKEN` is needed for the local
`repository.resolve` preflight step and is unrelated to the Relay or the
Actions adapter below.

**Do not omit `--session-credential`/`--app-endpoint` expecting a relay path
by default.** Omitting them does not fail closed toward the Relay; it falls
through to `createActionsChangeExecutionAdapter`, a separate,
compatibility-only GitHub Actions workflow-dispatch execution path (see
`docs/NATIVE_MCP_ISSUER_GATEWAY.md`) that has nothing to do with the hosted
Worker or `runtime connect`. Without `GH_TOKEN` set, that path fails at the
`repository.resolve` preflight with `RUNTIME_AUTHORITY_SOURCE_UNAVAILABLE`
before it even reaches the Actions adapter — a misleading local-auth error
that has no bearing on Relay dispatch.

### Known blocker: Relay dispatch timeout (#1001)

As of 0.15.0 pre-release verification, step 3 above reliably fails after a
bounded ~30s wait with:

```json
{"code":"CHANGE_REMOTE_RUN_FAILED","details":{"code":"SESSION_RECOVERY_REQUIRED"}}
```

This reproduces with a `runtime connect` process confirmed alive and
WebSocket-connected throughout. The client-side call sequence documented
above is correct; the fault is server-side, inside the deployed Worker's
Durable Object dispatch path (`REPOSITORY_RELAY` / `RepositoryRelayDurableObject`,
composed in `src/hosted-worker.ts`), not in any CLI flag or credential
combination. Do not re-derive or re-verify the client invocation while
debugging this; start from the Durable Object's job-dispatch and
possession-handshake code instead. Track resolution against Issue #1001.
