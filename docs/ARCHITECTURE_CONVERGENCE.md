# Architecture Convergence and Retirement Plan

Status: implementation planning derived from [Product Architecture Canon](./ARCHITECTURE.md), approved 2026-09-27. This is not authorization to implement every item, mutate Issues or merge branches. Concrete execution still requires a current bounded task.

## 1. Baseline and truth labels

The documentation baseline is main `597739813c29e6d6fd97479f35a05e6950424515`, containing the Local Source-bound Session correction. Current code still includes older Hosted Endpoint/Direct App and schema/CLI machinery. Separate Source-branch work must not be called main implementation.

Distinguish approved target, implemented in a named branch/revision, verified at a named boundary, integrated into main and deployed/published. An Issue's closed flag, a PR's existence or an old successful certification does not collapse those states.

This documentation PR changes no production code, wire schema, workflow, permission or installed deployment. The audit delivered after PR publication classifies Issues against this document set without editing their bodies, labels, relationships or state.

## 2. Gate A: architecture and evidence baseline

Publish one Product Architecture Canon and subordinate domain/runbooks. Explicitly retire competing normative decisions, including new Implementation-root Changes, independent Direct App execution, Hosted repository-work ownership, token forwarding and a separate Identity/Endpoint App.

Inventory current code, tests, package surfaces and in-flight branch lineage against each target. Classify existing work as retain, rewrite, supersede or closure-candidate with evidence. Missing accepted capabilities become reported gaps, not silently created Issues.

Implementation agents cannot redefine architecture to resolve an inconvenient test/contract. A required architecture change is returned to the owner with the exact contradiction and smallest correction. No task is dispatched from a stale Issue contract.

## 3. Gate B: verification and common contracts

Reconcile verification ownership before scaling implementation. Ordinary source checks, built/package proof, browser/process certification and release/live proof have distinct owners. Reuse only exact-revision artifacts; do not weaken proofs to reduce duration.

Establish common Source/task/publication identity joins and regression coverage. The Local #1213 binding is retained, but every branch/PR/projector/capability consumer must be assessed. Preserve standalone and multi-Implementation behavior and explicit historical identity.

Freeze public producer schemas/ports before dependent workers start. Concrete assertion encoding, size/lifetime limits, issuer-key trust/rotation, request/replay binding, locator handshake and connection fencing require reviewed producer contracts. A conceptual diagram is not a callable API.

## 4. Gate C: independent producer tracks

The artifact track converges the shared Markdown boundary, schema-native Canon, Effective input schema, materialization, capability projection and single-artifact reconciliation. Keep the generic data-shape authority separate from Inari semantics.

The runtime track completes secret-free repository registry, App-scoped Executor custody, Authority-ID custody and public owner observations on the canonical integration lineage. Admission Session observation is a producer for disconnect and UI, not a dependency on those consumers. Avoid the previous UI/Session-observation dependency cycle.

The CLI track establishes CLI Canon product composition and migrates the complete eligible surface by bounded route families. Remove each duplicate parser/catalog/help/Skill/path fact as it migrates. This campaign's end state is full eligible convergence, not indefinite touch-driven debt. Inari authorization, secure storage and genuine terminal/protocol ownership remain local.

These tracks may run concurrently only when their contracts and write sets are independent. Do not use sibling worktrees or unmerged symbols as dependencies. Integration wiring is explicitly owned rather than edited by every producer.

## 5. Gate D: operator composition

Compose dedicated Manifest and manual App onboarding into the same binding model. Complete recoverable Connect, trust publication/human wait, readiness, rotation and disconnect. The private key is born/stored at Executor, not Console.

Compose one machine Console with repository-scoped Setup, Runtime, trust, Sessions and diagnostics. Remove the old competing Runtime HTML surface only after its supported functions are represented by the canonical owner APIs.

Prove multi-repository/rename/isolation and restart through installed commands, real processes and browser actions. Remote Executor observation alone does not prove remote enrollment/mutation or endpoint provisioning. Explicit remote Control setup remains bounded; automatic PKI and remote Authority are excluded.

## 6. Gate E: Hosted authentication and relay

Implement the same Inari Access App's user-authorization profile at Hosted, transient user-token handling, repository/App/installation observation and signed request-bound assertions. Runtime verifies issuer, audience/locator, freshness and request identity and compares current Executor binding before semantic admission.

The approved remote caller profile needs no new cloud-client Session-key issuance. Explicit Runtime subject/operation authorization remains mandatory. Existing local Session authority is not inferred from an OAuth login.

Dedicated-App OAuth client/callback provisioning and supported HTTP MCP client authorization are explicit connection prerequisites. A shared login App cannot substitute for the bound execution App. Missing provisioning or protocol support blocks activation; do not invent an alternative App topology, credential vault or token passthrough.

Implement stable transport-key-derived locator, proof-of-possession handshake, live routing, fenced reconnect and bounded delivery metadata. Migrate repository-ID routing and client URLs explicitly. Hosted no longer implements repository work reads, semantic MCP operations, webhook-driven repository projections or provider effects. Optional UI consumes Runtime data through the same transport.

## 7. Gate F: retire competing architectures

Remove independent Direct App entry points/deployment wiring and parallel Hosted executors after consumer migration. Preserve shared Core/broker/effect code needed behind Executor. Retire command flags/exports by explicit reviewed compatibility decisions; a documentation label does not remove a shipped surface.

Keep only bounded old-data/protocol readers that reach the canonical model. Each retained adapter has a real consumer, supported input version, owner, conformance tests and retirement condition. No fallback to another credential, semantic engine or repository after a denial.

Historical release/certification evidence remains immutable. Old documents are not left active under a second normative status. Git history preserves prior designs; redirect notices do not authorize their implementation.

## 8. Gate G: product and operational certification

Prove the continuous installed local and Hosted paths, positive and negative authorization, exact Source/task/branch/PR joins, unknown-result recovery, no secret persistence and all supported operator lifecycles.

Then perform separately authorized live Hosted/GitHub, trust/branch Ruleset, shared workflow adoption and release certification. Deterministic-provider tests cannot satisfy those operational tasks. Shared workflows remain `@main`; no feature-ref workaround or local fork of generated governance is allowed.

The architecture is complete only when each accepted capability has current implementation and the correct evidence, competing authorities are removed, retained compatibility is bounded and supported public entry points agree. Open Issue count alone is not a completion criterion.

## 9. Audit taxonomy

KEEP means the contract remains aligned; it does not assert implementation is missing or complete without code evidence. REWRITE means the goal remains but the contract/verification/dependency assumptions need revision. SUPERSEDE means its requested architecture no longer belongs to the target, while any distinct valid requirement must be traced elsewhere.

CLOSE-CANDIDATE requires acceptance evidence on the correct target revision and boundary; an old merge reference alone is insufficient. BLOCKED or NOT-VERIFIED is an evidence/execution status, not proof of irrelevance. NEW-GAP records a target capability without adequate current task coverage; it is not automatic Issue creation.

Reports identify the Issue, applicable document sections, conflicting/aligned requirements, available code/PR/check evidence and the minimal required disposition. The present audit makes no Issue mutations.
