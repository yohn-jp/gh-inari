# Inari Native MCP Transport Architecture

Status: reconciled by #381. This document records the transport/tool-contract
parts of Epic #267 and Issue #268 that remain compatible with the normative
Session/App authorization architecture in [`AGENT_CAPABILITY_AUTHORIZATION.md`](./AGENT_CAPABILITY_AUTHORIZATION.md).

The original #267/#268 proposal is preserved at
[`NATIVE_MCP_ISSUER_GATEWAY_LEGACY.md`](./NATIVE_MCP_ISSUER_GATEWAY_LEGACY.md)
as implementation history and transport prior art. It is not an authorization
authority.

## Authority and #267/#268 classification

[`AGENT_CAPABILITY_AUTHORIZATION.md`](./AGENT_CAPABILITY_AUTHORIZATION.md), the
production `src/agent-authority/` contracts, and the existing Session-authorized
Change executor are authoritative. MCP owns protocol translation only.

| Legacy design/work item                                                        | Classification     | Current meaning                                                                                                                                                       |
| ------------------------------------------------------------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native typed MCP tools and transport-neutral semantic contracts                | retained           | MCP may expose Core-backed contract, materialization, preview, observation, drift, status, and handoff projections.                                                   |
| Hosted MCP gateway as requester authentication/admission authority             | superseded         | A hosted endpoint may be a deployment adapter, but it cannot decide Session authority or become a trust root.                                                         |
| Central Runtime/Agent Session registry or requester database                   | obsolete           | Session Certificates and proof-of-possession are verified against repository Runtime trust and current policy; no central registry is required.                       |
| GitHub Actions as the mandatory privileged execution plane                     | compatibility-only | The existing Actions `ChangeRemoteExecutor` remains for callers that need it or for specialized repository-local execution; it is not the authorization architecture. |
| Actions OIDC as the normative caller-to-App authorization route                | obsolete           | Privileged requests use the canonical Session request and App admission path.                                                                                         |
| App credential dispatch broker centered on consumer workflows                  | superseded         | App credentials remain inside trusted App execution; the existing broker is an implementation detail, never an MCP/client credential.                                 |
| OAuth/MCP identity as a substitute for Session Certificate proof-of-possession | obsolete           | Protocol identity may be transport metadata, but it cannot enlarge or replace Runtime trust, Session proof, or capability admission.                                  |

The retained transport boundary is:

```text
semantic Core / XState
        ^
        |
Session-authorized App execution
        ^
        +-------------------------+
        |                         |
direct App client          MCP bridge / client
                                  (translation only)

Actions ChangeRemoteExecutor = compatibility/specialized transport
```

## Privileged MCP path

When an embedding supplies the existing Session-authorized App executor, the
optional `inari_change_execute` tool forwards one canonical signed
`SessionRequestEnvelope` unchanged. The executor, not MCP, performs:

```text
Session Certificate/request
  -> proof-of-possession
  -> capability admission
  -> trusted Change/Core/XState
  -> App effect path
```

The bridge does not define an MCP certificate, capability vocabulary, Session
registry, replay store, or authorization callback. It does not re-sign or
reinterpret the envelope, and it does not return `gh auth`, PATs, Runtime
private keys, App keys/JWTs, or installation tokens. The App path returns only
its bounded execution/provenance result.

The default native MCP server registers the semantic/read-only catalog without
requiring a Session executor. This preserves local contract discovery and
planning for callers that have no privileged authority. A privileged catalog is
registered only by an embedding that explicitly supplies the existing App
executor.

## Transport rules

- Core, repository policy, Change lifecycle, and XState remain semantic and
  execution authorities.
- Read-only MCP tools remain direct Core adapters and do not require Session
  credentials.
- Direct App and MCP privileged calls use the same signed request bytes and the
  same production executor; transport metadata cannot enlarge authority.
- Actions remains available as an explicit compatibility/specialized transport
  until equivalent Session/App parity is proven. It is not silently removed or
  treated as a trust root.
- Hosted MCP/HTTP, local stdio, and future adapters may share this catalog, but
  none may add a second authorization plane.
