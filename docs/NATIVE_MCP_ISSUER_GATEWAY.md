# Inari Native MCP Issuer Gateway Architecture

Status: proposed architecture for Epic #267 and Issue #268.

This document extends, and does not replace, [`CHANGE_CONTROL_PLANE.md`](./CHANGE_CONTROL_PLANE.md).
The Change model, lifecycle, semantic authority, canonical branch/PR invariants,
idempotency, compensation, recovery, and provenance defined there remain authoritative.
[`INARI_ISSUER_APP.md`](./INARI_ISSUER_APP.md) remains the current issuer implementation
contract until the migration described here moves the credential broker from a consumer
repository Actions job into the remote issuer boundary.

## 1. Purpose

Epic #188 intentionally separated three concerns:

```text
semantic authority     execution runtime       mutation identity
------------------     -----------------       -----------------
Inari Core             GitHub Actions          Inari GitHub App
```

That architecture has now been implemented far enough to prove the model. Inari has a
transport-neutral `ChangeRemoteExecutor`, a trusted Change executor, a GitHub effect
adapter, a typed issuer authority, and a GitHub Actions implementation that executes a
semantic request on trusted repository code.

The remaining problem is the external ingress.

The current CLI remote transport uses GitHub Actions itself as an RPC mechanism. The
client knows the executor workflow file and ref, dispatches it, discovers and polls
workflow runs, correlates a run to a request, discovers an artifact, downloads a ZIP,
and decodes `result.json`. Those mechanics were useful to establish trusted execution,
but they are not the product contract described by the Change architecture.

This document defines the next boundary:

> Inari owns a native MCP protocol surface. A lightweight hosted MCP gateway authenticates
> and admits requests, dispatches semantic work to the consumer repository's trusted
> GitHub Actions runner, and contains the GitHub App credential boundary. Repository-local
> policy remains in the repository and is evaluated in its trusted runner. The hosted
> service never becomes a tenant repository execution platform.

The intended result is a single Human/Agent/UI ingress that can be hosted as a
multi-tenant service or self-hosted from the same OSS implementation, while retaining
GitHub-hosted runners as Inari's repository execution plane.

## 2. Relationship to the existing Change architecture

This architecture is a continuation of #188, not a reversal.

`CHANGE_CONTROL_PLANE.md` already requires that:

- Inari Core, not Actions YAML, owns Change semantics.
- GitHub Actions is an initial trusted execution runtime, not the product identity.
- callers issue semantic operations rather than low-level GitHub effects;
- workflow details are transport details, not the public contract;
- MCP, GitHub-native UI adapters, or a future service may be added without becoming
  semantic authorities; and
- App credentials are not a caller interface.

Issue #218 implemented the Actions executor with the same boundary: the workflow invokes
Core, applies only Core-planned effects, confines issuer credentials, verifies the final
projection, and emits bounded evidence. Its explicit non-goal was making
`workflow_dispatch` the public product API.

Epic #267 therefore changes **where the transport boundary terminates**, not **where
semantic authority lives**.

### 2.1 Authority hierarchy

The authority order after this change is:

1. `CHANGE_CONTROL_PLANE.md` and executable Inari Core contracts define Change semantics.
2. Repository-native Inari templates/policy define repository governance data.
3. This document defines hosted ingress, remote execution, authentication, attestation,
   and issuer placement.
4. MCP handlers, Actions workflows, GitHub App clients, and hosting adapters implement
   those boundaries; none independently defines policy.

If an adapter disagrees with Core, Core wins and the adapter must fail closed.

## 3. Current implementation inventory

The target architecture should reuse the existing seams rather than introduce parallel
business logic.

### 3.1 `src/change-executor.ts` — retain

`ChangeRemoteExecutor` is already the transport-neutral semantic remote boundary:

```ts
export interface ChangeRemoteExecutor {
  execute(request: ChangeRemoteMutationRequest):
    Promise<ChangeProjectionResult | ChangeRemoteExecutionResult>;
  read(request: ChangeRemoteReadRequest): Promise<ChangeProjectionResult>;
}
```

The request identifies a semantic operation and root Issue. The bounded result contains
a Change projection and optional execution evidence. It has no workflow filename,
installation token, artifact ID, or HTTP endpoint.

This interface remains the semantic remote execution contract used by the CLI and may
also back MCP Change tools.

### 3.2 `src/github/change-actions-remote-executor.ts` — compatibility/internal transport

`GitHubActionsChangeRemoteExecutor` currently owns the client-side mechanics that should
move behind the MCP gateway:

- fixed workflow selection (`inari-change-executor.yml`);
- fixed trusted ref;
- `workflow_dispatch`;
- workflow-run discovery and polling;
- request correlation;
- artifact discovery;
- ZIP validation/decompression;
- `result.json` validation; and
- mapping Actions failures into `ChangeRemoteExecutorError`.

It should not be deleted early. It becomes the compatibility implementation while the
MCP gateway is introduced and remains a useful local/dogfood diagnostic path.

The target hosted client no longer knows these mechanics.

### 3.3 `.github/workflows/inari-change-executor.yml` — evolve into consumer executor entry

The current workflow already has important trust properties:

- it is dispatched or called explicitly;
- it executes only on the protected default branch;
- it checks out trusted executor source rather than PR-controlled source;
- it invokes Inari Core rather than implementing policy in YAML;
- it emits a bounded result artifact.

Its current credential placement is transitional: `INARI_ISSUER_APP_ID`, installation ID,
and App private key are repository Actions secrets and the runner mints the App
installation token locally.

The target architecture removes those long-lived issuer credentials from consumer
repositories. The runner receives only `id-token: write` and proves its execution identity
to the remote issuer using GitHub Actions OIDC.

### 3.4 `src/change-trusted-executor.ts` — retain sequencing, split the effect sink

`TrustedChangeExecutor` already owns the correct orchestration boundary:

```text
read bounded evidence
-> Core projection / planning
-> apply explicit ChangeEffect
-> reread evidence
-> verify projection
-> return bounded execution evidence
```

It does not own naming, lifecycle policy, or idempotency semantics. Those remain in Core.

Today it receives a local `InariIssuerAppAuthority` and the Actions process calls that
authority directly. In the target hosted architecture the sequencing remains in the
runner, but effect application crosses a narrow remote issuer boundary.

The implementation should introduce an effect-sink abstraction rather than teach
`TrustedChangeExecutor` about HTTP, OAuth, OIDC, or Cloudflare.

Conceptually:

```ts
interface ChangeEffectSink {
  apply(input: AttestedChangeEffectRequest): Promise<BoundedEffectReceipt>;
}
```

The existing local issuer authority can implement that role in the compatibility path;
a remote OIDC-attested sink implements it for hosted execution.

### 3.5 `src/github/change-effect-adapter.ts` — retain

`GitHubChangeEffectTransport` is explicitly designed for an App, Actions, or service
transport. `GitHubChangeEffectAdapter` projects exactly one already-authorized Core effect
onto GitHub REST/GraphQL and deliberately owns no plan, retry, naming, lifecycle,
idempotency, or compensation policy.

This adapter moves naturally into the remote issuer process. It should remain the single
GitHub projection for the initial effect kinds:

- `CREATE_BRANCH`;
- `CREATE_PULL_REQUEST`;
- `MARK_PULL_REQUEST_READY`;
- `CLOSE_PULL_REQUEST`; and
- `DELETE_BRANCH`.

### 3.6 `src/github/issuer-authority.ts` — retain authority semantics, generalize execution proof

The current issuer authority correctly owns:

- App identity;
- installation identity;
- immutable repository identity;
- permission derivation from `ChangeEffect`;
- scope validation;
- credential containment; and
- fail-closed mutation authorization.

The current `TrustedExecutionContext` is intentionally Actions-specific and is the main
coupling that must evolve. It assumes a trusted execution context is constructed locally
inside GitHub Actions and includes workflow ref/SHA flags.

The hosted design must not replace these checks with "the HTTP request came from the
Internet". Instead an OIDC verifier constructs an equivalent **attested execution
context** from GitHub-signed claims, and only that validated context enters issuer
authority.

### 3.7 `src/github/actions-change-executor.ts` — split

This module currently combines several responsibilities because they all lived in the
first trusted Actions runtime:

1. read repository/GitHub evidence;
2. load repository-local governance;
3. invoke `TrustedChangeExecutor`;
4. construct App JWTs;
5. mint installation access tokens;
6. create a credential-bound GitHub transport; and
7. apply effects through `GitHubChangeEffectAdapter`.

Responsibilities 1–3 remain in the consumer repository runner. Responsibilities 4–7 move
to the remote issuer boundary for hosted execution.

The move is architectural, not semantic: Core still decides what effect exists and the
effect adapter still decides how that one effect maps to GitHub.

### 3.8 `src/cli-core.ts` — retain dependency seam

The CLI already supports an injectable `changeExecutor` and `createChangeExecutor`.
Therefore a hosted MCP-backed remote executor can be introduced without changing Change
command semantics.

The CLI may support both:

```text
local / compatibility: CLI -> GitHubActionsChangeRemoteExecutor
hosted:              CLI -> Inari MCP client -> hosted gateway
```

until hosted dogfood proves parity.

### 3.9 Majiwari `adapters/inari/` — upstream contract, retire ownership

The Majiwari adapter is valuable prior art, not a second authority. It already exposes:

- `adapter_health`;
- `inari_template_list`;
- `inari_issue_schema`;
- `inari_pr_schema`;
- `inari_issue_get`;
- `inari_pr_get`;
- `inari_issue_validate`;
- `inari_pr_validate`;
- `inari_issue_create`; and
- `inari_pr_create`.

It explicitly states that Inari remains authoritative and that the adapter only translates
arguments, invokes the local `inari` process, and normalizes results.

Inari should upstream the useful tool schemas/annotations and expose them from a native
server. Majiwari should then register/federate the native Inari MCP server through its
generic gateway instead of owning Inari-specific protocol definitions.

## 4. Target topology

### 4.1 Hosted multi-tenant path

```text
+-----------------------------+
| MCP client                  |
| CLI / agent / host / UI     |
+-------------+---------------+
              |
              | MCP 2026-07-28 over HTTPS
              | OAuth access token for Inari resource
              v
+-------------+---------------+
| Inari MCP Gateway           |
|                             |
| - MCP tool registry         |
| - requester authn           |
| - installation/repo authz   |
| - envelope/schema checks    |
| - admission/rate limits     |
| - Actions dispatch          |
| - execution projection      |
+-------------+---------------+
              |
              | scoped App token: Actions write only
              | workflow_dispatch on trusted default ref
              v
+-------------+---------------+
| Consumer repository        |
| trusted GitHub Actions job  |
|                             |
| - trusted executor code     |
| - repo-local policy         |
| - GitHub evidence           |
| - Inari Core                |
| - effect planning           |
| - projection verification   |
+-------------+---------------+
              |
              | GitHub Actions OIDC + bounded effect envelope
              v
+-------------+---------------+
| Inari Issuer Boundary       |
|                             |
| - verify OIDC               |
| - bind run/repo/workflow    |
| - replay/lease guard        |
| - derive effect permission  |
| - mint scoped App token     |
| - apply effect adapter      |
+-------------+---------------+
              |
              | scoped App installation token
              v
+-------------+---------------+
| GitHub API                  |
+-----------------------------+
```

The MCP Gateway and Issuer Boundary may be one deployed service/process in V1. They are
separate logical trust roles even when colocated.

### 4.2 Local stdio path

```text
MCP host
   |
   | stdio
   v
Inari native MCP server
   |
   +-- local repository discovery / Inari Core
   `-- normal local GitHub authentication / configured Change executor
```

Local stdio is not forced through the hosted service. It is primarily the native
replacement for the Majiwari process adapter and a convenient local Agent interface.

### 4.3 Self-hosted remote path

```text
MCP clients
   |
   v
self-hosted Inari MCP/Issuer deployment
   |
   +-- operator-owned GitHub App
   +-- operator-owned OAuth configuration
   `-- same consumer-repository runner protocol
```

Self-hosting changes deployment identity and configuration, not tool semantics or
repository policy ownership.

## 5. MCP protocol boundary

### 5.1 Protocol generation

New hosted implementations target MCP `2026-07-28`.

That revision is specifically suitable for this architecture because the protocol core is
stateless: requests are self-describing, protocol sessions and `Mcp-Session-Id` are gone,
`server/discover` is optional, list results are cacheable, and HTTP requests include
`Mcp-Method`/`Mcp-Name` headers that a gateway can use for routing, rate limits, and
admission without parsing arbitrary JSON first.

The product contract must not require sticky sessions or an MCP session database.

A runtime adapter may serve a legacy compatibility lane when the SDK can do so cheaply,
but compatibility must not pull legacy session state into Inari Core.

### 5.2 One native tool catalog

The same tool definitions should be registered against stdio and Streamable HTTP.
Transport-specific authentication or execution behavior is dependency injection below the
tool handler, not duplicated tool declarations.

Proposed canonical V1 catalog:

| Tool | Class | Repository semantic evaluation | Notes |
| --- | --- | --- | --- |
| `inari_health` | read | no/limited | Native replacement for `adapter_health`; returns protocol/runtime capability only, never filesystem paths or credentials. |
| `inari_template_list` | read | yes | Discover governed repository templates. |
| `inari_issue_schema` | read | yes | Resolve canonical Issue contract. |
| `inari_pr_schema` | read | yes | Resolve canonical PR contract. |
| `inari_issue_get` | read | yes | Canonical governed Issue projection. |
| `inari_pr_get` | read | yes | Canonical governed PR projection. |
| `inari_issue_validate` | read | yes | Validate existing/new Issue fields. |
| `inari_pr_validate` | read | yes | Validate existing/new PR fields. |
| `inari_issue_create` | write | yes | Governed Issue creation; Issue creation is not Change issuance. |
| `inari_pr_create` | compatibility write | yes | Existing artifact-level contract. It must not bypass Change-control enforcement where a repository requires canonical Change issuance. |
| `inari_change_show` | read | yes | Project the Change rooted at one Issue. |
| `inari_change_issue` | write | yes | Issue the canonical branch + Draft PR Change transition. |
| `inari_change_ready` | write | yes | Govern Ready transition. |
| `inari_change_abort` | write | yes | Govern abort/recovery cleanup transition. |
| `inari_execution_get` | read | no new policy evaluation | Resolve an accepted hosted execution handle to bounded Actions/result state. |

The final executable tool schemas, names, annotations, and descriptions must live in one
Inari-owned module and be tested as public contract. Majiwari may temporarily alias
`adapter_health` during migration but Inari does not preserve the adapter-oriented name as
its canonical identity.

### 5.3 Do not encode repository policy into tool schemas

MCP input schemas enforce structural safety, bounds, and required protocol fields. They do
not encode a repository's mutable business policy.

For example, the gateway may reject:

- an Issue number that is not a positive integer;
- an unknown tool;
- an oversized field map;
- malformed repository coordinates; or
- an unsupported protocol/tool-contract version.

It must not decide centrally that:

- a branch must have a particular repository-defined prefix;
- a template field is required by this repository;
- an Issue is eligible for Change issuance; or
- a PR may become Ready under this repository's policy.

Those remain runner/Core decisions.

### 5.4 MCP Apps

MCP Apps is an optional presentation layer over the same tools. A tool may associate a
`ui://` resource through `_meta.ui.resourceUri`; compatible hosts can fetch and render the
resource in a sandboxed iframe and the app can call server tools through the host.

This gives Inari a natural future UI path:

```text
inari_template_list
        |
        v
inari_pr_schema / inari_issue_schema
        |
        v
MCP App renders dynamic governed form
        |
        v
validate
        |
        v
Change / artifact mutation tool
```

UI metadata is optional. Every tool must remain usable through structured/text results by
non-UI MCP clients. The UI is not a second governance authority.

### 5.5 Long-running calls and MCP Tasks

Actions execution is longer-lived than a normal gateway request. The MCP Tasks extension
supports server-directed asynchronous task handles and polling, but Tasks is an extension
rather than a core requirement.

V1 therefore defines a baseline execution envelope that works without Tasks:

```json
{
  "status": "accepted",
  "execution": {
    "version": 1,
    "id": "opaque-signed-execution-handle"
  }
}
```

`inari_execution_get` resolves the handle to one of:

```text
queued
in_progress
completed
failed
cancelled
```

and, when complete, returns the existing bounded Change result/evidence contract.

When the client advertises the MCP Tasks extension, the hosted transport may project the
same execution state as an MCP Task. The explicit Inari execution handle remains the
baseline compatibility path and the source state remains GitHub Actions, not an Inari
Change database.

The CLI may hide the asynchronous protocol by polling until completion when synchronous
CLI behavior is desired.

## 6. Hosted gateway responsibilities

The gateway answers this question:

> May this authenticated request enter Inari's repository execution system, and where
> should it be routed?

It does **not** answer:

> Does this repository's governance allow this Change?

### 6.1 Admission checks

Before allocating a Runner, the gateway may fail closed on:

- MCP protocol/header/body disagreement;
- unsupported protocol/tool-contract generation;
- missing/invalid OAuth bearer;
- requester not bound to a GitHub identity;
- target repository not selected by the Inari App installation;
- requester lacking explicit access to that installation/repository;
- unknown repository identity or host mismatch;
- operation not supported by the installed Inari generation;
- missing/disabled trusted executor workflow;
- caller-controlled executor ref;
- malformed or oversized request envelope;
- request/rate limits;
- duplicate request identifier where an execution already exists; and
- tenant/request/repository mismatch.

Errors are stable protocol diagnostics such as:

```text
UNAUTHENTICATED
REPOSITORY_NOT_AUTHORIZED
INSTALLATION_NOT_FOUND
EXECUTOR_UNAVAILABLE
UNSUPPORTED_OPERATION
INVALID_REQUEST
REQUEST_ALREADY_EXISTS
RATE_LIMITED
```

Repository-policy failures use a separate classification returned by the Runner/Core.

### 6.2 Explicit non-responsibilities

The hosted gateway must not:

- checkout tenant repositories;
- run tenant package managers/builds/scripts;
- interpret repository branch policy;
- render its own competing PR template rules;
- guess a missing Change transition;
- mint a reusable installation bearer and return it to the client/runner;
- accept arbitrary low-level GitHub HTTP requests from a client;
- accept arbitrary `ChangeEffect` values from an unauthenticated or unattested caller; or
- become a persistent duplicate of GitHub Change state.

## 7. Requester authentication and authorization

### 7.1 Remote MCP authentication follows MCP OAuth

A remote protected MCP endpoint is an OAuth resource server. The hosted Inari MCP endpoint
must expose/participate in standard MCP OAuth discovery, including OAuth Protected Resource
Metadata and authorization-server discovery, and must return standards-compliant 401/403
challenges.

The public contract must **not** be "send a GitHub personal/user token directly as the MCP
Bearer token". MCP access tokens must be issued for the Inari resource and validated as
such; accepting arbitrary upstream GitHub bearer credentials would collapse identity
provider credentials into a resource credential and weakens audience/issuer isolation.

### 7.2 GitHub is the requester identity provider

The official hosted authorization flow may use GitHub App user authorization as the
upstream identity source.

Conceptually:

```text
MCP client
   |
   | OAuth authorization for Inari resource
   v
Inari authorization boundary
   |
   | upstream GitHub App OAuth / device-compatible user authorization
   v
GitHub user identity
   |
   v
Inari access token with Inari audience + GitHub subject binding
```

The authorization boundary stores or exchanges upstream GitHub credentials only as needed
to establish identity/installation authorization. Those upstream credentials are never
forwarded to the consumer Runner.

CLI clients should use the standard MCP OAuth client behavior where possible. The official
GitHub App may enable GitHub Device Flow as an implementation aid for headless/bootstrap
clients, but Device Flow is not a replacement for the MCP resource-server contract.

### 7.3 Repository authorization

Authentication answers "who is the requester?" Authorization answers "may this requester
ask Inari to operate on this installation/repository?"

The gateway must resolve:

- immutable GitHub user identity;
- Inari App installation identity;
- immutable repository ID;
- owner/name locator;
- installation selected-repository scope; and
- requester's explicit access to an installation/repository.

Owner/name alone is never an authority key. Repository ID and GitHub host remain part of
the trust tuple, matching the existing issuer authority model.

Authorization to request a Change does not imply review, approval, administration, or
merge authority.

## 8. GitHub App capability model

### 8.1 One App registration, separate logical capabilities in V1

For deployment simplicity, V1 uses one installed Inari GitHub App but treats dispatch and
mutation as different logical capabilities.

The App registration permission ceiling becomes sufficient for:

```text
Actions:       write   # dispatch trusted workflow
Contents:      write   # CREATE_BRANCH / DELETE_BRANCH effects
Pull requests: write   # PR create/ready/close effects
Metadata:      read    # GitHub automatic baseline
```

The current issuer contract intentionally excludes Actions permission. Expanding the App
registration ceiling is therefore a deliberate migration and must be reviewed as a
permission change.

The gateway must never mint a token with all permissions merely because the App
registration permits them.

### 8.2 Dispatch capability

For one accepted semantic request, the gateway mints/selects an installation token scoped
to:

- exactly the target repository; and
- `actions: write` only (plus GitHub's automatic metadata baseline).

That token is used only to dispatch the trusted Inari workflow and is discarded.

### 8.3 Issuer mutation capability

When an attested Runner requests one effect, the issuer derives the exact permission set
from the effect:

```text
CREATE_BRANCH           -> contents: write
DELETE_BRANCH           -> contents: write
CREATE_PULL_REQUEST     -> pull_requests: write
MARK_PULL_REQUEST_READY -> pull_requests: write
CLOSE_PULL_REQUEST      -> pull_requests: write
```

It mints/selects a fresh installation token scoped to exactly one repository and the
required permission set, applies the effect through `GitHubChangeEffectAdapter`, and
discards the credential.

The token/private key is never returned to the Runner.

### 8.4 Why not two Apps initially

A distinct dispatcher App and issuer App would provide stronger principal-level
separation, but doubles installation/setup and complicates the OSS onboarding path. V1
therefore separates capabilities and tokens, not registrations.

The internal types must not assume the two roles are permanently the same principal. A
future high-assurance deployment may bind `DispatcherAuthority` and `IssuerAuthority` to
different App IDs without changing Core or MCP tool semantics.

## 9. Consumer repository trusted workflow

### 9.1 Repository-owned bootstrap, centrally trusted executor

Each participating repository contains a small bootstrap workflow on its protected default
branch. The preferred implementation delegates the actual trusted executor job to a
reusable workflow shipped by `gh-inari` and pinned to an immutable release commit SHA.

Conceptually:

```yaml
name: Inari Change executor
on:
  workflow_dispatch:
    inputs:
      request:
        required: true
        type: string
      execution:
        required: true
        type: string
permissions:
  contents: read
  issues: read
  pull-requests: read
  id-token: write
jobs:
  execute:
    uses: yohn-jp/gh-inari/.github/workflows/inari-trusted-executor.yml@<immutable-sha>
    with:
      request: ${{ inputs.request }}
      execution: ${{ inputs.execution }}
```

Exact YAML is implementation work, but these trust properties are normative.

The App should not auto-write workflow files in V1. That would require an additional
workflow-file mutation permission and would broaden the bootstrap authority. Users may add
the small bootstrap through normal repository governance, organization templates, or
shared `.github` synchronization.

### 9.2 Dispatch ref is not caller-controlled

The external MCP request never supplies the executor ref.

The gateway resolves the repository's default branch and dispatches the bootstrap workflow
on that trusted ref. The Runner verifies that the actual execution ref/commit matches the
trusted default-branch execution context.

### 9.3 Policy source

Repository policy is evaluated from the trusted repository revision associated with the
executor run, not from a PR head, merge ref, fork checkout, or arbitrary request ref.

The executor may read GitHub API evidence about the canonical Change/PR, but it does not
execute code from the Change branch in the privileged mutation job.

This preserves the existing `codeExecution=trusted-only` principle.

### 9.4 Executor version trust

When a reusable Inari workflow is used, GitHub OIDC provides `job_workflow_ref` and
`job_workflow_sha` claims. The issuer accepts only configured trusted reusable workflow
identities and immutable SHAs.

The official hosted deployment should allow a bounded rollout set, for example current
and immediately previous compatible executor SHA, so repositories can upgrade without a
flag day. The accepted set is deployment configuration/release metadata, not repository
policy.

## 10. Runner-to-issuer OIDC attestation

### 10.1 No shared issuer secret

The consumer Runner receives:

```yaml
permissions:
  id-token: write
```

and asks GitHub for an OIDC token with an audience bound to the Inari issuer resource.

It sends that token with a bounded effect-authorization request. It receives only a bounded
receipt, never an App bearer credential.

### 10.2 Required verification

The issuer validates GitHub signature/JWKS and fails closed unless all required claims
match the execution record and target repository.

At minimum verify:

- `iss` is the GitHub Actions OIDC issuer;
- `aud` is the configured Inari issuer audience;
- `exp`, `nbf`, and `iat` are within accepted clock bounds;
- `jti` is present and not already consumed for an effect authorization;
- `repository_id` equals the immutable target repository ID;
- `repository` equals the expected locator for that ID;
- `repository_owner_id`/host context is consistent where available;
- `event_name` is an explicitly supported trusted dispatch event;
- `ref` is the trusted default-branch ref selected by the gateway;
- `workflow_ref` identifies the expected repository bootstrap workflow/ref;
- `workflow_sha` matches the trusted caller revision;
- `job_workflow_ref` identifies the trusted reusable Inari executor when that topology is used;
- `job_workflow_sha` is in the accepted immutable executor SHA set;
- `run_id` equals the run created for the gateway execution handle;
- `run_attempt` is valid for the recorded execution; and
- PR/fork/untrusted execution contexts are not accepted for issuer effects.

Claims such as actor identity are preserved as evidence where useful but do not replace the
repository/workflow trust proof.

### 10.3 Attested execution context

OIDC verification produces a bounded internal value, for example:

```ts
interface AttestedRunnerExecution {
  version: 1;
  provider: "github-actions-oidc";
  repository: IssuerRepositoryIdentity;
  runId: string;
  runAttempt: number;
  workflowRef: string;
  workflowSha: string;
  jobWorkflowRef?: string;
  jobWorkflowSha?: string;
  ref: string;
  requester?: string;
}
```

`issuer-authority.ts` should consume a trusted/attested execution abstraction rather than
parse JWTs itself. JWT verification belongs in an OIDC adapter; effect permission/scope
checks remain issuer-authority responsibility.

## 11. Effect authorization and replay safety

### 11.1 Remote issuer accepts effects, not arbitrary GitHub requests

A trusted Runner sends a bounded envelope such as:

```json
{
  "version": 1,
  "execution": "opaque-execution-handle",
  "operation": "issue",
  "effectIndex": 0,
  "effectDigest": "sha256:...",
  "effect": {
    "kind": "CREATE_BRANCH",
    "branch": "...",
    "baseBranch": "main"
  }
}
```

The issuer validates the existing `ChangeEffect` contract and derives permissions itself.
There is no `method`, arbitrary URL, authorization header, or free-form permission set in
the Runner request.

### 11.2 Minimal execution guard state is allowed and required

The MCP protocol itself is stateless, but effect authorization must resist bearer replay
and concurrent duplicate execution. A completely storage-free issuer would have no
reliable way to mark an OIDC `jti`/effect authorization as consumed.

V1 therefore permits and requires a **small TTL execution guard store**. This is not a
Change database and does not store repository policy.

It stores only bounded operational guards such as:

```text
execution id -> repository id / run id / semantic operation / expiry
OIDC jti     -> consumed until token expiry
effect key   -> plan digest / effect index / effect digest / applied receipt
lease key    -> Change identity / active run / expiry
```

Required store semantics:

- atomic create-if-absent / compare-and-set for replay keys;
- short TTL/automatic expiry;
- tenant/repository namespacing;
- bounded values with no GitHub bearer/private key;
- no template or Change lifecycle authority; and
- deletion/loss may cause safe retry/revalidation, never permission expansion.

A Cloudflare reference deployment may use a Durable Object, D1 transaction, or another
atomic adapter. A Node/self-host deployment may use SQLite or another small store. The
Core contract depends only on an `ExecutionGuardStore` interface, not the provider.

### 11.3 Change-level serialization

In addition to issuer replay protection, consumer execution should serialize authoritative
operations for the same Change identity. GitHub Actions `concurrency` may be used with a
gateway-derived, bounded Change key so duplicate `issue`/`ready`/`abort` runs do not race.

Core idempotency and compensation remain mandatory; concurrency is a defense against
avoidable races, not a replacement for semantic idempotency.

## 12. Dispatch and execution lifecycle

### 12.1 Dispatch

After admission, the gateway:

1. resolves immutable installation/repository identity;
2. resolves the default branch/trusted bootstrap workflow;
3. allocates an opaque execution ID and bounded dispatch envelope;
4. acquires a per-Change execution lease when required;
5. mints an App token scoped to that repository + `actions: write`;
6. dispatches the workflow on the trusted ref; and
7. records/binds the returned workflow run ID to the execution handle.

Current GitHub REST returns the workflow run ID and run URLs from the workflow-dispatch
endpoint. New code should use that direct identity rather than the current baseline-list +
run-discovery correlation algorithm.

### 12.2 Execution handle

The external execution ID is opaque. It may be a signed compact value or a random ID
resolved by the guard store. It must bind at least:

- protocol version;
- immutable repository identity;
- GitHub workflow run ID;
- semantic operation/root Issue;
- requester/tenant boundary; and
- expiry.

Clients must not be able to substitute a run from another repository or installation.

### 12.3 Result state without a Change database

`inari_execution_get` uses the execution binding to query the exact GitHub Actions run.
No list/discovery scan is needed.

While active it reports bounded GitHub-derived state. After completion it retrieves the
bounded Inari result artifact for that exact run and applies the existing strict result
validation.

The artifact may retain `result.json`, but artifact lookup should be run-scoped rather
than globally correlated by name. Transport-specific archive handling belongs in the
hosted Actions result adapter, not MCP tool handlers or the CLI.

### 12.4 Failure taxonomy

Maintain separation between:

**Admission failures** — request never reached a Runner.

```text
UNAUTHENTICATED
REPOSITORY_NOT_AUTHORIZED
INVALID_REQUEST
EXECUTOR_UNAVAILABLE
RATE_LIMITED
```

**Transport/execution failures** — Runner dispatch/run/result machinery failed.

```text
EXECUTION_DISPATCH_FAILED
EXECUTION_RUN_FAILED
EXECUTION_RESULT_INVALID
EXECUTION_ATTESTATION_FAILED
```

**Policy/semantic failures** — Inari Core rejected the repository operation.

Existing Change diagnostics remain authoritative.

**Effect/issuer failures** — attested execution could not apply a scoped GitHub effect.

Existing bounded effect/issuer evidence should be reused.

A caller should never need to inspect raw Actions logs to classify these top-level failure
classes, although logs remain useful operator evidence.

## 13. Read and validation execution

Repository-semantic read operations also need a repository policy/source. V1 keeps the
hosted gateway deliberately small and routes repository-semantic operations to trusted
repository execution rather than embedding a second Core/policy compiler into the
Worker.

This includes template discovery/schema, canonical artifact projection, and semantic
validation when the answer depends on repository files.

Potential future optimization may execute pure Inari Core over data fetched directly from
the trusted default branch inside the gateway. That is allowed only if it reuses the same
Core packages and source revision; it must not become a separate policy implementation.
It is explicitly not required for V1.

Gateway-only reads may include non-semantic infrastructure metadata such as installation
presence, repository identity, executor availability, and execution status.

## 14. Security model and threats

### 14.1 Confused deputy

Threat: an authenticated user asks Inari to mutate a repository they cannot operate.

Controls:

- bind MCP subject to GitHub user identity;
- resolve installations accessible to that user;
- require target repository to be selected by the installation;
- bind immutable repository ID through dispatch, OIDC, effect request, and App token;
- never authorize from owner/name alone.

### 14.2 Cross-tenant execution

Threat: execution/result handle from tenant A is replayed against tenant B.

Controls:

- execution handle/ledger binds tenant/requester + installation + repository ID + run ID;
- every status/effect call rechecks authenticated tenant authorization;
- OIDC repository ID must match execution binding;
- App token is selected to one repository.

### 14.3 Untrusted workflow or PR code

Threat: PR-controlled code obtains issuer authority.

Controls:

- gateway chooses default-branch dispatch ref;
- privileged job does not checkout PR head/merge ref;
- bootstrap workflow is protected;
- reusable executor is pinned to an accepted immutable SHA;
- OIDC verifies workflow/ref/SHA and, where used, job reusable-workflow ref/SHA;
- no App private key exists in consumer repository secrets.

### 14.4 OIDC replay

Threat: captured short-lived Actions OIDC bearer is replayed.

Controls:

- TLS;
- strict issuer/audience/expiry validation;
- `jti` consume-once guard with TTL;
- run/repository/workflow binding;
- effect index/digest binding;
- atomic effect receipt guard.

### 14.5 App token/private-key leakage

Threat: long-lived issuer credentials reach tenant code, logs, artifacts, or MCP results.

Controls:

- private key only in issuer deployment secret store;
- installation token only inside scoped gateway callback/adapter;
- no token-bearing public type;
- sanitize provider errors;
- bounded receipts only;
- never place App credentials in Actions inputs/env/secrets for hosted mode.

### 14.6 Direct-path bypass

Threat: a user manually creates a branch/PR outside Inari.

This architecture does not claim GitHub can physically prevent every PR creation path.
The #188 model remains:

- branch creation can be restricted where platform Rulesets allow;
- canonical PR provenance is issuer-controlled semantically; and
- required Change provenance/merge-admission checks prevent a noncanonical PR from
  becoming an admissible governed Change.

The MCP gateway is the normal publication path, not a substitute for repository-side
merge enforcement.

### 14.7 Replay of MCP mutation requests

Threat: client retries or intermediary replays a mutation request.

Controls:

- bounded client request ID/idempotency key where available;
- execution lease per Change identity;
- Core idempotent transitions;
- direct run ID binding;
- effect replay guards; and
- deterministic returned-existing semantics.

### 14.8 Gateway compromise

The gateway/issuer deployment holds the App private key and is therefore a high-value
boundary. A compromise is limited by:

- App installation selection;
- App registration permission ceiling;
- per-operation installation-token permission narrowing;
- per-repository token narrowing;
- no admin/review/merge permissions;
- no tenant code execution; and
- auditability of App-issued GitHub mutations and Actions runs.

Operator secret rotation and App permission changes are deployment operations and must be
documented separately from Core semantics.

## 15. Hosted state model

The architecture distinguishes three types of state.

### 15.1 Authoritative repository/Change state — GitHub

```text
Issues
branches
pull requests
reviews/checks
Actions runs/artifacts
```

Inari continues deriving Change state from GitHub projections.

### 15.2 Repository policy state — repository

```text
.github/inari/**
repository-native templates
protected workflow bootstrap
```

The hosted gateway does not duplicate this as a semantic database.

### 15.3 Ephemeral security/execution guard state — issuer deployment

```text
execution/run binding
short idempotency lease
OIDC jti replay guard
effect digest/receipt
OAuth/session/token state required by the auth implementation
```

This state is bounded and expiring. It exists to authenticate/serialize transport, not to
represent a Change lifecycle.

## 16. Reference deployment model

### 16.1 Runtime-neutral packages

A likely package/module decomposition is:

```text
src/mcp/
  tools.ts                  # canonical tool catalog, schemas, annotations
  server.ts                 # transport-neutral registration
  results.ts                # bounded MCP projections

src/remote/
  admission.ts              # authz/admission contracts
  execution.ts              # execution handle/result projection
  effect-sink.ts            # local/remote effect sink interface
  execution-guard.ts        # ephemeral atomic guard interface

src/github/
  actions-dispatch.ts       # dispatch + run-id/result adapter
  actions-oidc.ts           # OIDC claim verification -> attested context
  app-dispatch-authority.ts # actions:write scoped capability
  issuer-authority.ts       # existing effect permission/scope authority
  change-effect-adapter.ts  # existing effect -> GitHub projection

src/mcp/transports/
  stdio.ts
  http.ts

deployments/
  cloudflare-worker/        # reference adapter only
```

Exact paths may be adjusted to repository conventions, but dependency direction is
normative:

```text
MCP transport -> native tool handlers -> semantic/application interfaces
hosting SDK    -> adapters only
GitHub SDK/API -> github adapters only
Core           -X-> Cloudflare/MCP HTTP/OAuth implementation details
```

### 16.2 Cloudflare Workers reference

Cloudflare Workers is a strong official hosted candidate because current MCP is stateless
and Cloudflare's current Agents SDK exposes a stateless `createMcpHandler` path using the
MCP v2 server package. A Worker can therefore host the MCP protocol without a protocol
session/Durable Object solely for transport.

Worker-specific APIs should be confined to `deployments/cloudflare-worker` (or equivalent).
If an atomic replay store uses a Cloudflare-specific primitive, it implements the generic
`ExecutionGuardStore` contract.

### 16.3 Self-host reference

A self-hosted operator provides:

- their own GitHub App ID/private key;
- their own OAuth/authorization-server configuration;
- hosted MCP public URL;
- trusted executor SHA allowlist; and
- an `ExecutionGuardStore` implementation.

They do not fork repository policy into the service.

## 17. GitHub App installation and onboarding

Official hosted onboarding should be conceptually:

```text
1. Install Inari GitHub App on selected repositories.
2. Add/provision the small trusted Inari Actions bootstrap workflow.
3. Authorize requester identity through the hosted MCP OAuth flow.
4. Connect MCP client to the Inari endpoint.
5. Gateway verifies installation + executor availability.
6. Use native Inari tools.
```

The installation should expose only the repository permissions required by the design.
Users who do not trust the hosted service may deploy the same OSS gateway/issuer with
their own App.

## 18. Majiwari migration

The migration is intentionally one-way with respect to ownership:

```text
before
------
Inari CLI
   ^
Majiwari Inari-specific MCP adapter
   ^
Majiwari gateway


after
-----
Inari Core / CLI
   ^
Inari native MCP server
   ^
Majiwari generic registry/gateway (optional federation)
```

Steps:

1. port Majiwari tool schemas, safety bounds, descriptions, annotations, and tests into
   Inari-owned native MCP modules;
2. replace `execFile("inari", ...)` inside the native implementation with direct Inari
   application/Core calls where feasible, avoiding self-spawn as the permanent design;
3. add Change tools from the current semantic remote executor;
4. prove local stdio parity;
5. point Majiwari registry at the native Inari server and retain temporary compatibility
   aliases only where needed; and
6. delete the Inari-specific adapter implementation from Majiwari after consumers move.

Majiwari remains valuable for federation: it can expose Inari alongside other MCP servers
without knowing Inari governance semantics.

## 19. Migration from Actions-as-RPC

There is no flag day.

### Phase 0 — architecture gate

- merge this document;
- make no runtime behavior change in the documentation PR.

### Phase 1 — native local MCP ownership

- add MCP SDK dependency in an isolated module/package boundary;
- port Majiwari tool schemas/handlers;
- add Change tools;
- provide native stdio server;
- keep CLI and current Actions remote executor unchanged.

### Phase 2 — hosted MCP + authentication/admission

- add Streamable HTTP adapter targeting MCP 2026-07-28;
- implement MCP OAuth protected-resource behavior;
- bind requester identity to GitHub user authorization;
- implement installation/repository authorization;
- implement structural admission diagnostics;
- initially dispatch no mutations until auth tests prove fail-closed behavior.

### Phase 3 — hosted Actions dispatch

- add logical Dispatcher authority;
- expand the App registration permission model to include `actions: write` after review;
- dispatch only trusted default-branch bootstrap workflow;
- use the workflow-dispatch response run ID directly;
- add execution handles and `inari_execution_get`;
- retain current artifact/result validation.

At this point clients can use MCP as the public ingress while the consumer Runner may still
use its existing local issuer secret path during transitional dogfood.

### Phase 4 — OIDC-attested remote issuer

- add `id-token: write` to trusted executor job;
- implement OIDC verifier and `AttestedRunnerExecution`;
- implement ephemeral execution/replay guard;
- introduce remote `ChangeEffectSink`;
- move App JWT/installation-token creation into hosted issuer;
- remove private key/install ID requirements from consumer repository Actions secrets;
- keep existing local credential broker only for explicit compatibility/self-contained
  execution mode.

### Phase 5 — reusable executor hardening

- publish trusted reusable workflow pinned by immutable release SHA;
- validate `job_workflow_ref`/`job_workflow_sha`;
- define compatible executor SHA rollout window;
- reduce consumer bootstrap workflow to routing + permissions only.

### Phase 6 — default inversion and Majiwari simplification

- dogfood Issue → Change → Ready → abort/recovery through MCP ingress;
- switch hosted-capable CLI/agents to MCP executor by default where configured;
- keep direct Actions executor as diagnostic/compatibility path until deprecation criteria
  are met;
- switch Majiwari to generic native MCP federation;
- remove duplicate adapter logic.

### Phase 7 — optional UI

- add MCP Apps resources for repository/template/Change UI;
- do not change tool semantics to accommodate presentation.

## 20. Follow-up implementation work graph

Implementation Issues should be created only after this document merges. The recommended
slices are:

### Wave A — native protocol ownership

A1. **Native MCP contract module**
- Port existing Majiwari tool schema/annotation contract.
- Add Change and execution tools.
- Add contract snapshots/tests.
- No remote service.

A2. **Native stdio server**
- Register A1 against stdio.
- Direct application/Core integration.
- Prove Majiwari-equivalent local behavior.

A3. **Majiwari federation migration preparation**
- Make Majiwari capable of registering the native Inari server without Inari-specific
  protocol logic.
- Do not delete old adapter until parity tests pass.

A1 is prerequisite for A2/A3.

### Wave B — hosted ingress

B1. **Streamable HTTP MCP adapter**
- MCP 2026-07-28 endpoint.
- Protocol/header/schema bounds.
- No repository mutation yet.

B2. **MCP OAuth requester authentication**
- Protected Resource Metadata and authorization discovery.
- Hosted authorization boundary with GitHub user identity binding.
- Token audience/issuer isolation.

B3. **Installation/repository admission**
- GitHub App installation resolution.
- Immutable repository authorization.
- Stable admission diagnostics.

B1 + B2 precede B3.

### Wave C — dispatch and result transport

C1. **Dispatcher App capability**
- Model `actions: write` as a distinct logical capability.
- Repository/permission-scoped installation token.
- App permission migration documentation/tests.

C2. **Trusted workflow dispatch adapter**
- Resolve default branch/workflow.
- Dispatch fixed trusted workflow/ref.
- Consume returned workflow run ID.

C3. **Execution handle/result adapter**
- Opaque execution ID.
- Run-scoped status polling.
- Run-scoped bounded result artifact retrieval.
- `inari_execution_get`.

C1 precedes C2; C2 precedes C3.

### Wave D — remote issuer credential boundary

D1. **Actions OIDC verifier**
- JWT/JWKS validation.
- exact claim policy and diagnostics.
- attested execution contract.

D2. **Execution guard store**
- atomic replay/lease/effect receipt interface.
- bounded TTL reference adapter/tests.

D3. **Remote effect sink protocol**
- bounded `ChangeEffect` envelope + digest/index.
- OIDC + execution binding.
- no arbitrary GitHub request surface.

D4. **Hosted installation credential broker/effect application**
- move App JWT/token issuance from Actions into issuer deployment;
- reuse `GitHubChangeEffectAdapter`;
- exact effect-derived permission narrowing.

D5. **Trusted executor integration**
- inject remote effect sink into `TrustedChangeExecutor` sequencing;
- remove hosted dependency on tenant App secrets;
- preserve compatibility broker.

D1 + D2 precede D3; D3 precedes D4/D5 integration.

### Wave E — reusable workflow and rollout

E1. **Trusted reusable executor**
- publish pin-able workflow;
- consumer bootstrap contract;
- OIDC `job_workflow_ref`/SHA verification.

E2. **Hosted Change dogfood**
- issue/show/ready/abort/retry/recovery;
- concurrent duplicate request tests;
- provenance/issuer author verification.

E3. **CLI hosted MCP executor**
- implement MCP-backed `ChangeRemoteExecutor` using existing CLI dependency seam;
- default selection/configuration and fallback diagnostics.

E4. **Majiwari native federation cutover**
- switch to native Inari MCP;
- remove duplicate adapter after parity.

### Wave F — optional presentation

F1. **MCP Apps Inari UI**
- schema-driven forms and Change status;
- UI resources only; no policy duplication.

## 21. Compatibility and versioning

Four versions must not be conflated:

1. **MCP protocol version** — e.g. `2026-07-28`.
2. **Inari MCP tool-contract version** — tool names/input/output semantics.
3. **Change remote executor contract version** — existing semantic Change request/result
   generation.
4. **Issuer/attestation protocol version** — Runner → issuer envelope/claims.

A change in one does not automatically require a change in the others.

`inari_health` / `server/discover` should expose bounded Inari capability information
without leaking deployment paths or credentials. Tool list discovery is the MCP-native
capability surface; Inari should not create a parallel `/capabilities` REST API unless a
non-MCP consumer requirement appears.

The current `inari --version --json` name/protocol/capability contract remains useful for
local compatibility but is not silently reused as the hosted MCP protocol version.

## 22. Observability and audit

The hosted path should emit correlation without exposing secrets.

At minimum associate:

```text
MCP request trace/request id
requester GitHub identity
installation id
immutable repository id
root Issue / semantic operation
execution id
GitHub workflow run id / attempt
OIDC attested workflow SHA
issuer effect kind/digest
GitHub mutation receipt classification
final Change execution outcome
```

Use W3C Trace Context carried by MCP `_meta` where supported and continue bounded GitHub
execution evidence. Logs must never contain OAuth refresh tokens, GitHub user access
tokens, App JWTs, installation tokens, private keys, or raw OIDC bearer tokens.

Audit metadata is operational evidence; GitHub remains the primary Change state store.

## 23. Deployment and operational failure modes

### Gateway unavailable

No new hosted operation is admitted. Existing GitHub repository state and Actions runs are
unaffected. Local/compatibility execution may remain available according to explicit
configuration.

### Authorization provider unavailable

Fail authentication closed. Do not fall back to unauthenticated GitHub identity guesses.

### GitHub Actions dispatch unavailable

Return a transport/admission failure with no repository mutation. Do not route around the
trusted executor directly from the gateway.

### Runner fails before effect

Run fails; no issuer effect is authorized. `inari_execution_get` reports bounded failure.

### Runner loses connection during effect

Effect receipt/replay guard plus Core projection verification determines whether retry is
safe. Never blindly reapply an untracked effect.

### Issuer unavailable

Runner fails the effect through the existing bounded failure/recovery path. App credentials
remain contained.

### Guard store unavailable

Fail mutation authorization closed. Read/status operations that do not require guard state
may continue if safely derivable from GitHub.

### Result artifact unavailable/corrupt

Treat as `EXECUTION_RESULT_INVALID`; never infer success solely from workflow conclusion.
The caller may inspect GitHub state through a governed `change show` recovery path.

## 24. Decisions frozen by this document

The following are architectural decisions, not open implementation choices:

1. Native MCP belongs to Inari, not Majiwari.
2. MCP is the primary hosted external protocol; no parallel bespoke REST product API is
   required for V1.
3. Local stdio and hosted HTTP share one native tool catalog.
4. Hosted MCP targets the stateless MCP 2026-07-28 generation.
5. Consumer GitHub Actions remains the repository semantic execution plane.
6. Repository policy does not move into the hosted service.
7. Hosted service does not execute arbitrary tenant repository code.
8. App private key/installation bearer do not live in consumer repository secrets after
   the hosted issuer migration.
9. Runner authenticates to issuer with GitHub Actions OIDC.
10. Issuer applies only bounded Core `ChangeEffect` contracts, never arbitrary GitHub HTTP
    requests supplied by a Runner/client.
11. V1 uses one GitHub App registration with logically separated dispatch and issuer
    capabilities and per-operation token narrowing; types remain compatible with future
    principal separation.
12. Workflow dispatch uses a trusted default ref selected by the gateway, not caller input.
13. A centrally published reusable executor pinned to immutable SHA is the preferred trust
    topology.
14. GitHub workflow run ID is the canonical hosted execution identity beneath the opaque
    Inari execution handle.
15. GitHub remains Change state authority; only ephemeral security/execution guard state is
    added centrally.
16. MCP Tasks and MCP Apps are optional extensions, not baseline requirements.
17. The current Actions remote executor remains a compatibility path during migration.

## 25. Implementation-level questions intentionally deferred

The following do not change the architecture and may be decided in bounded implementation
Issues:

- exact TypeScript MCP v2 helper APIs and package layout;
- Cloudflare Worker vs another runtime for a self-host deployment;
- Durable Object vs D1 vs equivalent adapter for the official guard store, provided atomic
  TTL semantics hold;
- exact opaque execution-handle encoding;
- exact accepted executor-SHA rollout window;
- whether the HTTP adapter serves a legacy MCP generation concurrently during migration;
- exact MCP Apps visual design; and
- whether pure read/schema operations are later optimized to execute Core in the gateway
  against trusted GitHub-fetched policy data.

None of these may weaken the authority/trust boundaries frozen above.

## 26. References

Current Inari implementation authority:

- [`CHANGE_CONTROL_PLANE.md`](./CHANGE_CONTROL_PLANE.md)
- [`INARI_ISSUER_APP.md`](./INARI_ISSUER_APP.md)
- Epic #188
- Issue #218
- Epic #267
- Issue #268

External platform references used to validate this architecture as of 2026-09-05:

- MCP 2026-07-28 release: <https://blog.modelcontextprotocol.io/posts/2026-07-28/>
- MCP authorization: <https://modelcontextprotocol.io/specification/draft/basic/authorization>
- MCP Tasks extension: <https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks>
- MCP Apps overview: <https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html>
- MCP TypeScript v2 server SDK: <https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/>
- GitHub Actions workflow dispatch REST API: <https://docs.github.com/en/rest/actions/workflows>
- GitHub Actions OIDC claims: <https://docs.github.com/en/actions/reference/security/oidc>
- GitHub App installation authentication/token scoping: <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation>
- GitHub App permissions: <https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app>
- GitHub App installation/user authorization APIs: <https://docs.github.com/en/rest/apps/installations>
- Cloudflare stateless MCP handler reference: <https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/>

## 27. Completion gate for #268

Issue #268 is complete when this architecture is reviewed and merged and any material
review finding is reflected here. Runtime implementation must not begin by silently
changing the decisions in section 24.

After merge, Epic #267 should be decomposed into the work graph in section 20, adjusted
only for discovered implementation dependencies rather than re-deciding the product
architecture.
