# Inari Product Architecture Canon

Status: approved target architecture, 2026-09-27. This Canon records the architecture-owner decisions from the design review. It is not a claim that every target capability is already implemented. The observed implementation baseline is `597739813c29e6d6fd97479f35a05e6950424515`.

## 1. Decision authority

The product owner approves architecture changes in the architecture-design review. Implementation agents may propose changes but cannot approve them, silently reinterpret this Canon, or amend an Implementation Issue to create architecture authority. Approval of implementation is not approval to change architecture.

This document is the single entry point for normative product architecture. Domain documents refine its decisions; they do not establish competing ones. Accepted Issues specify bounded work inside the approved architecture. Code, schemas and tests establish what a revision actually does, not permission to make an unintended behavior permanent.

When intent, an Issue and executable behavior disagree, record the exact conflict and reconcile the task with the architecture owner before changing the disputed semantics. Do not weaken a guard or rewrite a test merely to conceal the conflict. Continue unrelated, already-authorized work only when it is independent.

Architecture-owner approval is required for changes to product responsibility, public semantics, identity, credential or state ownership, trust, capability, lifecycle/recovery semantics, deployment guarantees and compatibility removal. Internal functions, file organization, algorithms and test implementation remain implementation choices within those boundaries and the task's declared scope.

Ordinary implementation must not edit normative architecture or its approval rules. An explicitly approved architecture-documentation task may do so. Generated organization governance remains owned by `yohn-jp/.github`; this policy does not authorize editing generated copies or changing live protection settings.

## 2. Product and non-goals

Inari is one deterministic repository-governance product. It resolves GitHub-backed repository contracts and current evidence, admits bounded semantic requests, applies only permitted effects, and verifies the resulting state.

Inari owns artifact meaning, Implementation contracts, repository-change authorization, Change lifecycle, governed publication, owner-controlled setup and bounded operational projections. It is not a general GitHub proxy, remote shell, filesystem server, agent scheduler, identity provider with its own user database, or arbitrary workflow engine.

GitHub remains authoritative for GitHub-owned repository facts, protected Canon, Issues, refs, PRs, checks and reviews. Admission owns local Session lifecycle; Executor owns App custody and repository bindings; Authority owns delegation keys. These local records do not form a competing GitHub state database.

Inari remains one product and distribution. Logical isolation uses explicit public ports, dependency boundaries and owner-local state. It does not require a microservice or package per role.

## 3. Responsibility model

Repository Canon declares repository-specific meaning, relationships and naming policy. Semantic Core compiles contracts, materializes values, projects state, plans changes and verifies semantic postconditions. Generic syntax, CLI mechanics and data-shape validation are not additional Inari policy engines.

Admission authenticates the caller evidence and evaluates repository, subject, current Implementation where applicable, allowed operation and bounded authority. It does not hold GitHub provider credentials or private signing keys.

Executor coordinates admitted operations, obtains current bounded provider evidence, contains Inari Access App keys and installation credentials, owns repository-to-App/installation bindings, applies admitted effects and verifies the result. Evidence reads needed by Admission use bounded owner ports; Admission must not acquire a provider token to perform them.

Authority owns delegation signing material and bounded delegation/provenance issuance. The compatibility name Runtime Authority denotes this role, not a runtime host or GitHub authority.

Setup Application derives status, available actions and recovery from owner evidence. Control authenticates operator requests and invokes specific owner ports. Composition selects and connects components and supervises processes it actually owns; it is not a secret parser or policy owner.

CLI, MCP, Local Console and optional Hosted UI are clients or protocol/presentation adapters. They do not implement alternate artifact, branch, lifecycle or authorization semantics. A remote UI is not automatically entitled to secret enrollment or operator-control actions.

## 4. One execution architecture

Local and remote ingress converge on the same user-owned Admission and Executor semantics:

```text
local caller evidence -------------------------+
                                               |
remote caller -> Hosted authentication         |
  -> signed Repository Access Assertion        |
  -> Relay -> user-owned ingress ---------------+
                                               v
                                           Admission
                                               v
                            Executor + Semantic Core / Lifecycle Controller
                                               v
                            Inari Access installation credential boundary
                                               v
                                             GitHub
                                               v
                            authoritative reread + postcondition verification
```

Admission and planning may require bounded current evidence before an effect is admitted. The diagram does not require evidence to be read only after authorization, nor does it require pure schema/render operations to acquire mutation authority.

All normal governed provider mutations use Executor-owned Inari Access installation capabilities. Caller identity and provider execution identity remain separate. OAuth credentials do not become execution credentials. Bootstrap/trust publication is a separately authorized operator path; it cannot silently serve as a normal-operation fallback.

Direct App as an independent client-to-provider execution deployment is retired. Retiring that deployment does not remove the Inari Access App, its broker, or semantic/effect implementations that the canonical Executor still needs. Actions may provide CI or a bounded integration adapter; it must not preserve a second normal execution authority.

## 5. Identity and graph semantics

Repository identity is `repositoryHost + repositoryId`. A name, checkout path, URL or installation ID is not a substitute. A rename updates metadata without creating another repository.

Source Issue records an outcome and acceptance criteria. Implementation records one bounded execution contract, its canonical Source set, body digest, base, scopes and dependencies. Session identifies one bounded delegated execution, not the Source itself.

For new canonical Change operations, the Change root is the selected Source Issue. A delegated Implementation Session keeps `task.number = Implementation`. Requested Source membership must be present in both the signed authorized Source set and the freshly read current contract. There is no implicit first or primary Source.

Implementation branch/PR publication is distinct from Source Change identity. The existing task-bound `change.implement` compatibility claim is usable only for its established leaf publication/branch-side path; it is never a Source-membership bypass or a grant to create an Implementation-root Change.

Integration routing is a separate graph. Canonical parent/routing evidence selects the Implementation leaf's target, then Source integration and Epic integration where used. Multiple authorized Sources do not create arbitrary PR-target selection. Standalone work does not have to manufacture an Epic or integration branch. See [Implementation Contract](./IMPLEMENTATION_CONTRACT.md) and [Change Control Plane](./CHANGE_CONTROL_PLANE.md).

## 6. Hosted authentication and relay

Hosted exists to make a user-owned Inari server reachable by cloud clients. It is an authenticated public endpoint, not a cloud copy of Inari's semantic control plane.

Hosted may temporarily use an Inari Access GitHub App user access token to verify GitHub user identity and access to the requested repository through the intended App installation. It emits a short-lived signed Repository Access Assertion and discards the GitHub credential. No GitHub user token is forwarded to Runtime, stored in a job, or used for normal effects.

There is no separate Endpoint App or Inari Identity App. Inari Access has user-authorization and installation-execution credential profiles. Their identity binding must be verified; their credentials and ownership never merge.

The assertion proves caller eligibility, not an Inari mutation capability and not GitHub user-scoped execution. Runtime explicitly trusts the assertion issuer for those facts, validates its signature, target and freshness, and independently admits the semantic operation. A signature does not make a compromised issuer trustworthy. Repository visibility alone cannot authorize writing, signing, trust changes, approval or merge.

Relay routes by a self-certifying public locator derived from a Runtime-owned transport public key. Runtime proves possession during a bounded WebSocket handshake. Hosted returns the confirmed relay ID/public URL only after admission. The same local transport key retains the locator across reconnects. Key replacement changes it and requires explicit client reconfiguration unless a separately approved migration proves continuity.

Relay identity is neither repository identity nor delegation authority. Its private key is separate from Authority signing and App custody. Private repositories need no public Canon file for locator discovery: the operator supplies the public URL to the client, and repository eligibility is authenticated independently.

Hosted owns only service configuration/keys, bounded authentication transactions, live routing and bounded delivery/replay metadata. It has no durable user/repository database, repository-work cache, semantic execution, or provider-mutation credential store. Authentication evidence may reveal repository IDs to Hosted; this is not a claim that Hosted cannot observe traffic. Ordinary TLS is not end-to-end payload encryption.

Details and security gates are in [Repository Access Assertion](./REPOSITORY_ACCESS_ASSERTION.md) and [Hosted Relay](./HOSTED_RELAY_DEPLOYMENT.md).

## 7. Local control and custody

Repository registry and Setup metadata are secret-free references to component-owned identities. Executor custody is App-scoped, Authority custody is Authority-ID-scoped, and repository binding is independent of either key's storage partition. Dedicated Apps and explicitly shared manual Apps use the same binding model without duplicating PEM files.

One machine-scoped Console serves repository-scoped contexts. Configuration, process health, provider binding, protected-ref trust, Session readiness, Session lifecycle, execution outcome and Relay reachability remain distinct dimensions.

Connect uses owner actions for App enrollment/installation, Authority preparation, governed trust publication, human review, protected-ref recheck and readiness. Disconnect/rotation are explicit recoverable lifecycles, not directory deletion. Shared owners are not deleted while another binding still depends on them.

Remote Control initially accepts explicit endpoint, expected component identity and operator-provided trust material. Automatic PKI, automatic remote discovery and remote Authority are not implied. Control and Admission transport principals have different route authority. See [Runtime Component Boundaries](./RUNTIME_COMPONENT_BOUNDARIES.md).

## 8. Semantic and CLI convergence

JSON Schema 2020-12 owns generic artifact data shape. Inari owns value authority, relations, derivations, provenance and capabilities. Markdown syntax is parsed through the shared mdast boundary; observed free text comes from source slices, not generic stringification. Automatic reconciliation applies only proven semantics-preserving changes with independent governance and observation freshness gates.

CLI Canon owns command grammar, standard shell, help, version, usage errors, invocation/Skill projection and eligible lexical paths. Inari retains domain meaning, security enforcement and terminal ownership for genuine interactive/protocol surfaces. This campaign completes the eligible CLI migration, not only touched routes. Each migrated fact has one active authority.

Nawabari owns worktree/process/filesystem isolation. Mottainai owns agent orchestration. Wabachi owns its architecture/design semantics. Suzukuri owns its published bounded observation/test-projection contracts. Inari consumes explicit contracts; it does not copy those products' responsibilities.

## 9. Failure, persistence and compatibility

Provider success is not semantic success. Every effect ends with authoritative reread and postcondition verification or a bounded failure/unknown outcome. Unknown delivery or a lost response never justifies blind replay.

Owner records, journals and replay fences may be durable where required for restart safety. A UI cache, XState snapshot, Relay job or OAuth session is not a Change state authority. Reuse is always bound to exact identity and relevant generation.

Old architectures must not survive as fallback executors, parallel parsers or implicit credential paths. Bounded old-data readers may remain only when they converge into the canonical model without broadening authority. Historical records retain their original identity; ambiguous records are not reinterpreted. Retirement includes consumer migration, regression evidence and removal of new-work entry points, not just a deprecated label.

## 10. Documents, implementation and completion

The normative domain set is:

- [Golden Path](./GOLDEN_PATH_ARCHITECTURE.md), [Change](./CHANGE_CONTROL_PLANE.md), [Implementation](./IMPLEMENTATION_CONTRACT.md), [Execution Scope](./IMPLEMENTATION_EXECUTION_SCOPE.md) and [Branch Policy](./REPOSITORY_BRANCH_POLICY.md).
- [Authorization](./AGENT_CAPABILITY_AUTHORIZATION.md), [Repository Access Assertion](./REPOSITORY_ACCESS_ASSERTION.md), [Inari Access](./INARI_ISSUER_APP.md) and [Runtime Boundaries](./RUNTIME_COMPONENT_BOUNDARIES.md).
- [Artifact Contracts](./SEMANTIC_ARTIFACT_CONTRACTS.md), [Templates](./SEMANTIC_TEMPLATES.md), [Lifecycle Controller](./XSTATE_CHANGE_MACHINE.md) and [MCP](./NATIVE_MCP_ISSUER_GATEWAY.md).

[Architecture Convergence](./ARCHITECTURE_CONVERGENCE.md) records implementation gaps and dependency order. [Verification Architecture](./VERIFICATION_ARCHITECTURE.md) distinguishes source, compiled, installed, process/browser and live-provider evidence. Operational guides consume these contracts; they cannot change them.

Release/certification archives record historical evidence at their stated revisions. An old Issue, document, successful test or merged leaf does not establish current product completion. Every open Issue must be assessed against this Canon before execution. No Issue is closed merely by publishing these documents.
