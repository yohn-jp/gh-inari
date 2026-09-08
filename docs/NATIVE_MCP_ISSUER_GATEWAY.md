# Inari Native MCP Issuer Gateway Architecture

Status: legacy transport architecture from Epic #267 / Issue #268. Superseded as the normative authorization and trust model by [`AGENT_CAPABILITY_AUTHORIZATION.md`](./AGENT_CAPABILITY_AUTHORIZATION.md) under Epic #364 / Issue #365.

The original #267 architecture is preserved at [`NATIVE_MCP_ISSUER_GATEWAY_LEGACY.md`](./NATIVE_MCP_ISSUER_GATEWAY_LEGACY.md) as implementation history and transport prior art.

## Current authority

The following #267 conclusions remain useful:

- Inari may own a native MCP protocol/tool surface.
- MCP, HTTP, stdio, Actions, and other ingress mechanisms are transports/adapters, not semantic authorities.
- GitHub App private keys and installation tokens remain inside the issuer/executor boundary and are never caller credentials.
- Inari Core remains repository semantic authority and GitHub remains authoritative observable state.
- Hosted and self-hosted transports should implement the same semantic contracts.

The following #267 assumptions are no longer normative after #364:

- a hosted MCP gateway as the required authentication/authorization control plane;
- centralized Runtime/Agent session registration or admission;
- OAuth identity at a hosted Inari gateway as the required source of agent authority;
- GitHub Actions as the required execution hop for every privileged repository operation;
- Actions OIDC as the required caller-to-issuer authorization mechanism;
- a hosted service deciding which semantic capability an Agent Session may receive.

The normative authorization path is now:

```text
repository trusted Runtime public key + repository policy
        |
        v
Runtime-signed short-lived Session Certificate
        +
Session proof-of-possession
        +
current authoritative GitHub state
        |
        v
Inari semantic admission / XState execution
        |
        v
GitHub App authority
        |
        v
GitHub
```

A hosted MCP gateway remains an optional deployment/transport adapter only if it preserves this model and does not introduce a competing central trust or policy authority.

See [`AGENT_CAPABILITY_AUTHORIZATION.md`](./AGENT_CAPABILITY_AUTHORIZATION.md) for the normative credential hierarchy, capability model, repository trust root, replay/one-shot semantics, App verification sequence, and migration plan.
