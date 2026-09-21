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
- `GET /healthz` — non-secret deployment metadata only.

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

`wrangler.hosted.toml` declares the `RepositoryRelayDurableObject` binding
and its explicit migration. Configure only the non-secret provider host
partition if `github.com` is not used:

```sh
pnpm exec wrangler deploy --config wrangler.hosted.toml \
  --var INARI_HOSTED_REPOSITORY_HOST:ghe.example.com
```

The onboarding descriptor also requires these non-secret public App variables:
`INARI_GITHUB_APP_ID`, `INARI_GITHUB_APP_CLIENT_ID`,
`INARI_GITHUB_APP_SLUG`, `INARI_GITHUB_APP_INSTALLATION_URL`, and
`INARI_GITHUB_APP_USER_AUTH_PROFILE=device-flow`. The descriptor remains
bounded and unavailable until all required values are valid. Do not put an App
private key, installation token, user access token, or other credential in
these variables.

The direct-App deployment remains independent and continues to use:

```sh
pnpm run worker:build
pnpm exec wrangler deploy --config wrangler.toml
```

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
