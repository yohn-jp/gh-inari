# Implementation Contract

Status: normative task-domain contract under [Product Architecture Canon](./ARCHITECTURE.md). Existing versioned parser/authorization interfaces remain the executable format authority; this revision corrects the cross-artifact target identity, not their serialized schema.

## 1. Source, Implementation and Session

An ordinary Source Issue records a problem, requested outcome or approved architecture decision. An Implementation records one bounded execution task: objective, non-goals, approved design, READONLY/WRITE/CREATE/DELETE/DENY scopes, prerequisites, verification, base and dependencies. A PR records delivered work and evidence; it is not another task-authorization record.

A Source may have multiple Implementation children. An Implementation may reference multiple canonical Sources without acquiring multiple implicit parents or PR targets. Native provider parent/sub-issue state governs hierarchy where available. Contract Source/dependency references govern their declared semantics, not silent reparenting.

A Session is an admitted execution context. Creating an Issue, writing a contract or opening a PR does not itself issue a Session or approve the task. The current authorization record binds Implementation identity, canonical governed-body digest and base evidence.

## 2. Architecture-owner control

Implementation chooses how to satisfy the approved task, not which architecture to follow. Changes to identity, public behavior, trust/capability, credential custody, state owner, recovery semantics, supported topology or compatibility require architecture-owner approval.

A worker may identify an architecture conflict and propose a minimal correction. It must not edit the Canon or redefine the Issue to authorize itself. Pure internal restructuring, helper reuse and algorithm/test choices remain within its granted scope. Architecture-document changes require an explicitly authorized architecture task.

## 3. Current authorization and scope

Use the canonical Implementation parser, authorization verifier and [execution-scope projection](./IMPLEMENTATION_EXECUTION_SCOPE.md). Do not reconstruct scope with a consumer-specific parser or infer it from branch names, PR descriptions or prose checklists.

READONLY does not imply WRITE. WRITE does not imply CREATE or DELETE. DENY applies before operation allowlists. Missing/empty authority remains absent. Current body/base evidence, supersession, completion and invalidation are evaluated by the existing lifecycle authorities.

Changing the governed body invalidates the old authorization; it is not an in-place expansion of an already-issued grant. Rework outside the approved task needs a new/current authorization through the governed process. A failure to fit the accepted scope is a real contract issue, not permission to bypass it.

## 4. Cross-artifact identity

Implementation identity is repository plus Implementation number. The authorization additionally binds its canonical body digest and base evidence. Session task remains that Implementation. Leaf branch and PR bind the exact governed task and integration route. Execution evidence binds that task, digest, base, branch and head.

New canonical Change operations instead target a selected Source Issue. The authorized Source set is explicit. For delegated Sessions, the requested Source must belong to both signed and freshly observed current Source sets. No first/primary Source inference is allowed.

The existing Implementation-task `change.implement` compatibility claim supports only its established PR-publication/branch-side path. It is not a Change-root grant and cannot bypass Source membership. Branch advance remains bound to the Implementation's exact branch, never a Source sibling or protected base.

These joins must be verified explicitly. Do not use one variable named `issue` to equate task, Source root, native parent, PR closing target and branch identity.

## 5. Integration routing

Where Issue integration is enabled, the semantic route is Implementation leaf to canonical Source integration, then parent Epic integration, then the governed default branch. Standalone and explicitly supported in-flight routing remain separate declared cases.

The native parent and current routing contract determine the target. A Source list is not an ordered target selector. Sibling merge order does not create a dependency DAG. Downstream execution consumes physically integrated producer state, not a closed Issue or an unmerged sibling worktree.

Implementation, Source and Epic evidence must name the exact target ref and revision. Acceptance on a Source branch is not acceptance on main.

## 6. Principal profiles

Local delegated tasks consume current Authority-signed binding and Admission Session state. Remote human-operated requests consume verified Repository Access Assertions and Runtime-owned subject/operation authorization. Both use the same task/Source/scope semantics where the operation is task-bound.

A remote caller is not required to create an ephemeral Session key simply to invoke Inari. Conversely, an eligibility assertion does not manufacture an Implementation authorization or bypass a delegated Session's requirements. See [Authorization](./AGENT_CAPABILITY_AUTHORIZATION.md).

## 7. Evidence and terminalization

Verification evidence must identify the contract, subject, code revision and execution boundary it actually proved. Source-only tests cannot prove installation, browser or live-provider behavior. A stale successful run cannot validate a changed contract/head.

Implementation completion, Source acceptance and Epic acceptance are independently evaluated. A child PR closing relation is not permission to close its Source or Epic. Publishing a PR never implies approval, merge, release or repository setting changes.

## 8. Format and command authority

The current public Implementation APIs and CLI contract are defined by the existing parser, authorization/lifecycle modules and generated command metadata. This document introduces no command spelling. Use the installed version's help only within the repository's permitted operational policy; the current organization suspension of agent Inari use is not lifted here.

Historical records may be read by bounded compatibility adapters. New execution must not revive the superseded Implementation-root Change architecture. Resolve migration conflicts explicitly without modifying historical evidence to pretend it was issued under today's contract.
