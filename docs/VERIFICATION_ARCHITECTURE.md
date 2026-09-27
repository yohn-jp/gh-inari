# Verification Architecture

Status: normative proof-boundary requirements under [Product Architecture Canon](./ARCHITECTURE.md). This document does not change the current verification graph or claim it is already deduplicated.

## 1. Evidence must name its boundary

Source tests prove Core contracts, validators, admission and pure/store behavior. Built-runtime tests prove compiled entry points and module/owner boundaries. Installed-package tests prove packaged files, exports, command shell and public behavior without relying on the source workspace.

Real-process tests prove component transport, owner separation, restart and discovery at the exercised topology. Browser tests prove the actual built/served controls, authentication context and routes. Controlled-provider tests prove product composition against deterministic provider-shaped behavior. Live tests alone prove actual deployment/provider configuration and integration.

A fixture must not pre-create the trust, Session-ready, connected or successful state it claims to prove. Separate temp directories are not automatically separate-host evidence. A valid MCP initialize, OAuth callback or health response is not a governed-operation proof.

## 2. Execution ownership and reuse

Each proof obligation has one owning entry point in a verification graph for a given revision/environment. Distinct boundaries may legitimately exercise the same scenario; duplicate full execution at the same boundary needs a concrete reason.

Build/package/browser assets may be reused only with exact source/configuration/toolchain identity and no concurrent writers. A stale artifact cannot satisfy a new revision's proof. Cold/warm command counts, suite duration and workflow critical path are measured separately; parallel job times are not summed as developer wait time.

Current canonical full local verification remains `pnpm run verify` until an approved implementation changes its graph. Focused checks run while the write set changes; final required checks run against the stabilized result. Unexecuted checks are not passed because the diff looks safe.

## 3. Routine versus release/live work

Routine verification must not invoke release preparation or live production mutation implicitly. Explicit release certification owns release planning/publication behavior and uses isolated disposable state. Never rewrite the developer checkout's Git identity or operator configuration during verification.

The existing full graph still needs the execution-ownership reconciliation tracked by the relevant maintenance work. Do not remove an entire job just because part of it overlaps: preserve Inari-specific package, Runtime, setup and provider-effect denials.

Live Hosted, App installation, webhook retirement/migration where relevant, trust/branch Rulesets and shared release adoption remain operational evidence. They require the proper credentials/environment and explicit authorization; mocks and old logs are not substitutes.

## 4. Architecture conformance

Map each invariant to the narrowest proof and one composed path where crossing boundaries matters. Important joins include Source versus task identity, exact App/installation/repository binding, no provider credential outside its owner, issuer/audience/request-bound assertion verification, remote visibility without automatic write authority, replay and uncertain delivery.

Retain tests for actual regressions but remove duplicated test machinery through canonical helpers only when assertions remain intact. Do not recreate implementation transition tables, broaden fixture scaffolding without need, suppress findings or replace real boundary proof with an injected success stub.

Architecture import guards are code-loading checks, not OS isolation proof. Static checks cannot prove every semantic boundary; review still traces real execution paths and counterexamples.

## 5. Completion reports

For every result, record exact base/head, contract/invariant, command, environment and boundary. Distinguish pass, failure, pending, skipped, not checked and environment-blocked. Local and CI results are separate; a green old head cannot certify a changed head.

A documentation-only change can prove Markdown structure, reference consistency and absence of non-document changes without claiming production tests ran. Full repository checks remain reported honestly, including missing Node/package/browser prerequisites. A docs PR is not proof that its target architecture is implemented.

Source, Source-integration, Epic, main, packed release and deployed service are different evidence subjects. Audit and closure decisions must use the one required by the task.
