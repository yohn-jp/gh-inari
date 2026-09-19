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
interface. Operational limits are backpressure controls, not authorization.

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

The direct-App deployment remains independent and continues to use:

```sh
pnpm run worker:build
pnpm exec wrangler deploy --config wrangler.toml
```
