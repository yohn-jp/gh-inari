# Native MCP and Remote Inari Transport

Status: protocol/interface contract under
[Product Architecture Canon](./ARCHITECTURE.md) and
[Caller Authentication](./AGENT_CAPABILITY_AUTHORIZATION.md).

The historical filename does not make MCP an Issuer, repository authority,
credential broker, or semantic executor. The older gateway proposal remains
in [Historical Gateway Design](./NATIVE_MCP_ISSUER_GATEWAY_LEGACY.md) as prior
art, not a source of current authorization.

## 1. Responsibility

MCP exposes typed Inari operations and bounded results. Local supplied-data
operations invoke the same Core as other clients. Repository-backed reads and
mutations use their applicable admission and user-owned Runtime contracts.

Hosted MCP transports authenticated requests through Relay. It does not run a
second repository materializer, work projection, task scheduler, or provider
executor. The transport may validate its envelope and resource bounds without
interpreting repository policy.

Protocol identity and a reachable server are not Inari capabilities. A client
cannot select a more privileged profile by choosing a different MCP tool name.

## 2. Catalog authority

The admitted public operation contract determines which tools may be exposed.
Tool names, input schema, bounded output, and availability must derive from
one canonical definition rather than a handwritten parallel command catalog.

Discovery/validation/materialization on supplied contracts can remain useful
without provider credentials. A private repository read is different and
requires the proper authenticated read boundary.

The existing default native server has a semantic/read-only catalog. The
historical optional `inari_change_execute` bridge accepted a signed Session
request through a supplied executor. That is a baseline interface fact, not
a requirement to issue a new Session key to remote human-operated clients.

Migration must explicitly version/adapt retained inputs and route supported
operations to common Admission. Do not advertise a new target profile before
its actual public catalog and authentication composition exist.

## 3. Remote request path

```text
remote MCP client configured with public Relay endpoint
  -> Inari Access user authentication at Hosted
  -> repository/App eligibility verification
  -> signed request-bound Repository Access Assertion
  -> bounded Relay delivery
  -> Runtime assertion and current binding verification
  -> subject/operation admission
  -> same semantic Core/Executor pipeline
  -> bounded verified result or recovery evidence
```

The client does not manage Runtime Authority private material or a new
Hosted-issued Inari Session. The public URL is a locator, not a bearer grant.
GitHub user tokens stop at the transient Hosted authentication boundary.

See [Hosted Relay](./HOSTED_RELAY_DEPLOYMENT.md) and
[Repository Access Assertion](./REPOSITORY_ACCESS_ASSERTION.md) for issuer,
request, replay, and delivery contracts. MCP does not duplicate them.

## 4. Inari-only remote access

The remote endpoint is not a shell, arbitrary argv runner, filesystem browser,
network tunnel, arbitrary URL fetcher, or general GitHub API proxy.

Operations have typed semantic inputs and explicit target identities. Caller
input cannot name another backend URL, choose a credential, switch an App
binding, or bypass admission through a debugging tool.

Control/enrollment/trust/review/merge retain their separate authorization.
A read-only repository eligibility assertion does not authorize App writes,
operator actions, or every advertised product command.

## 5. Legacy Session envelopes

A retained certificate/PoP envelope must preserve exact signature verification,
canonical semantic bytes, task/repository identity, time, current trust, and
replay protections. Translation does not replace a signature with a plain
user-ID header or treat the certificate alone as bearer authority.

The compatibility adapter feeds the canonical Admission path. Retaining an
input format does not retain Direct App execution, a central Hosted Session
registry, or a parallel permission vocabulary.

If the actual consumer no longer exists, remove the unused adapter through
an explicit compatibility decision rather than maintaining another engine.

## 6. Reviews and merge

The existence of CLI/Core review or merge semantics does not prove the
Session/App execution boundary admits those effects. The initial Inari Access
profile does not approve or merge PRs.

Do not expose privileged MCP review/merge operations using ambient user
credentials or an unrestricted provider client to fill that gap. A supported
operation requires explicit semantic and provider authority plus its proof.
Unavailable capability is a bounded result, not a transport-local fallback.

## 7. Results, cancellation, and transport failure

Return canonical typed results and stable diagnostics without raw provider
responses, private keys, tokens, signed bodies, or internal actor snapshots.

MCP completion is not semantic success. Preserve Runtime denial, effect
failure, postcondition mismatch, and recovery-required outcomes even when the
HTTP/MCP exchange itself succeeded.

Cancellation or connection loss after delivery does not prove nonexecution.
Do not automatically replay a mutation on reconnect or reauthentication.
Use the operation's bounded status/reconciliation path and preserve original
request identity and possible-delivery evidence.

Transport timeout, control request deadline, and long-running semantic
execution are different limits. No generic small timeout may silently abort
or misreport an admitted operation.

## 8. MCP Apps and remote UI

An optional MCP Apps resource is a thin presentation of its underlying typed
tool. Hosts without that extension receive the ordinary tool result.
The resource does not become another repository or authorization backend.

An integrated remote UI likewise consumes user-owned Runtime APIs. It does
not retain a Hosted work database or reproduce Setup action legality. Client
state never proves trust, readiness, or provider execution success.

## 9. Discovery and protocol versions

Protocol initialization and tool/resource discovery declare the implemented
capabilities. Version negotiation must not silently downgrade to a retired
execution profile or broaden authorization to preserve old clients.

The stable Relay locator and supported route shape are versioned transport
contracts. Public metadata does not authorize arbitrary issuer keys, OAuth
callbacks, or connection replacement.

Service availability is distinct from Runtime/repository readiness. Report
unsupported protocol, unavailable Runtime, and denied operation separately.

## 10. Baseline adapters and retirement

`ChangeExecutionPort` remains a transport-neutral request/result contract.
Actions/Direct-App named legacy exports are implementation/API compatibility,
not independent semantic authority.

Independent Direct App deployment is retired. Shared Core, lifecycle, crypto,
and effect helpers remain when used by the canonical Executor. A retained
Actions adapter cannot become another trust root or privileged engine.

Migrate Hosted MCP dispatch away from constructing a provider-executing local
Direct App composition. Its only normal route is the user's Admission and
Executor. Private repository access never depends on public Canon discovery.

## 11. Verification

Prove tool schemas/catalog derive from the admitted operation contract,
unsupported operations stay absent/denied, local pure operations remain pure,
and private reads are authenticated.

Prove real remote MCP ingress reaches common Admission/Executor, wrong
issuer/Relay/repository/App/task/request is denied, tokens never travel to
Runtime, and reconnect/cancellation preserve possible execution.

Catalog unit tests do not certify client OAuth compatibility or a deployed
MCP host. Test the actual installed package/protocol and keep deterministic
provider, browser/client, and live-service proof distinct.
