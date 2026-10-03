# Verification Architecture

Status: proof and execution-ownership contract under
[Product Architecture Canon](./ARCHITECTURE.md).

This document defines what each verification boundary proves and how the
verification graph should converge. It does not claim that package scripts,
workflows, or live certification already match the target graph.
The existing `pnpm run verify` remains the canonical local entrypoint until
its explicitly governed implementation changes.

## 1. Principle

A check is evidence for a named contract on an exact subject in a specific
environment. Passing one layer does not imply that another layer was tested.
A successful compile, helper test, package build, or HTTP response cannot
stand in for a continuous user-visible path.

Each proof has a clear owner, entrypoint, inputs, output identity, required
environment, and failure semantics. Do not add repeated full-suite execution
merely because both shared CI and repository verification can invoke it.

## 2. Evidence classes

### Source contract

Pure Core/schema/parser/lifecycle tests prove deterministic semantics,
invariants, boundary cases, and stable diagnostics against source code.
They do not prove emitted artifacts, installation, or real network composition.

### Built runtime

Compiled execution proves emitted modules, exports, runtime loading, and
source-to-build compatibility. A TypeScript source import alone is not this
boundary. Exact build identity must match the candidate.

### Installed package

Build and pack the exact candidate, install the resulting tarball in an
isolated consumer, and run its installed public binary/API.
Do not use workspace links, source files, direct dist invocation, or an
unrelated global installation as package proof.

This layer verifies shipped files, plugin/Skill assets, entrypoints, declared
public exports, standard shell composition, and product-specific runtime
behavior available to consumers.

### Process and owner composition

Run actual components with their owned configuration and transports.
Prove public ports, discovery, identity, mTLS, lifecycle, and absence of shared
secret filesystem assumptions. An injected port test proves a producer, not
that the product actually wires that producer.

Separate processes/temp directories prove process/configuration boundaries.
They are not separate-host/network evidence unless run on separate hosts.

### Browser/public client

Use the actual built/served application and supported client protocol.
Prove forms, route/context selection, security checks, narrow layout,
keyboard operation, loading/error/recovery, and action/result rendering.
Static HTML snapshots or controller tests do not prove real browser behavior.

### Deterministic provider composition

A controlled GitHub-shaped fixture may exercise real product code against
repeatable external state, failures, races, and partial effects.
It must not contain its own semantic engine or pre-create the condition being
proved. It is not a live GitHub/API configuration certification.

### Live deployment/provider

Contact the actual deployed service/provider using explicitly authorized
controlled resources. Bind evidence to exact source/package/deployed identity.
Real OAuth, installation, callback/webhook configuration where retained,
Ruleset enforcement, and production Relay reachability require this class.

A fake or injected network is never reported as live pass.

## 3. Contract ownership

Core owns shape, authority, relation, derivation, projection, lifecycle, and
plan semantics. Admission tests prove caller/task/Source/capability and current
policy gates. Executor tests prove exact App/installation/repository scope,
custody, effect limits, sanitized errors, and postcondition composition.

Setup tests prove owner-evidence-derived actions, freshness, and recovery.
Console tests prove public UI/controller/routing behavior. Relay tests prove
connection ownership, bounded delivery, backpressure, and ambiguity.
Hosted assertion tests prove authentication attestation, request/target/time/
replay binding, and credential non-forwarding/non-retention.

Installed Golden Path certification composes those owners. It does not replace
their focused negative tests. Live operations remain separate proof of the
actual external configuration.

## 4. Current entrypoint families

Existing entrypoints include ordinary `pnpm test`, typecheck/build/format/lint
scripts, `pnpm run verify`, `node scripts/run-package-suite.mjs`, and the
product-specific package/runtime/Setup certification scripts.

`pnpm run test:setup-browser` runs the existing actual browser boundary.
`scripts/endpoint-dashboard-certification.mjs` is an existing deterministic
composition oracle, not live proof of the new Hosted target. Its ordinary
execution owner is the root source-test graph through
`test/endpoint-dashboard-certification.test.mjs`; package certification must
not invoke the same source-level oracle again.
`scripts/relay-certification.mjs` distinguishes controlled and live transport
proof; transport certification alone does not prove a semantic GitHub effect.

`scripts/release-preparation-certification.mjs` belongs to explicit release
verification, not routine code verification. Its assertions remain important;
its placement in the ordinary execution graph is the defect addressed by the
existing verification ownership work.

Inspect current package/workflow definitions when implementing changes. This
inventory is not an independently maintained replacement command graph.

## 5. One owner per ordinary execution graph

The target graph performs ordinary format, lint, type, source, build, and
package obligations once per required boundary/environment on the same
candidate. Shared CI and repository full verify must not independently repeat
an identical full ordinary suite without a distinct proof reason.

Do not simply delete the full verify job: it may contain additional installed
Runtime/provider-negative certification absent from shared CI. Assign each
obligation to its proper owner before removing duplicate invocation.

A Node-version/platform matrix is a distinct environment when explicitly
required. The same scenario at source and installed boundaries is not
automatically redundant. Document the actual reason for retained repetition.

## 6. Artifact identity and exclusive production

Build/package reuse must bind exact source revision, relevant inputs,
dependency/toolchain/configuration identity, and produced artifact identity.
No stale dist directory, prior package version, or arbitrary cached tarball
can satisfy current verification.

Routine source certification is bound to the exact checked-out candidate.
It may read that candidate identity, but it must not fetch or rewrite Git refs
to compare against a moving remote branch during the proof. Remote-main
freshness belongs to the workflow/admission boundary that selected the
candidate, not to a deterministic source oracle.

Independent consumers may share a prepared immutable artifact. Concurrent
build/pack jobs must not write the same mutable output directory. Establish
one producer and explicit dependency/barrier before consumption.

The package allowlist remains an independent expectation. Do not generate the
expected packed files from actual output and call agreement proof that all
required files shipped.

## 7. Routine versus release

Routine verification must not invoke release-preparation certification.
Explicit release preparation/certification still proves version-bearing files,
history/plan, idempotent release PR behavior, and publication requirements.

Do not weaken release assertions to improve developer latency. Fix routing
and isolation so release tests run at their owned boundary and cannot mutate
the developer's repository identity/configuration.

Publishing a version or green ordinary CI does not automatically satisfy a
separate live/adoption/Ruleset requirement.

## 8. Regression and test adequacy

Tests prove the accepted contract, not a frozen accidental implementation.
For a regression, preserve the actual previously failing behavior and assert
its externally meaningful safe outcome.

Do not add speculative case matrices unrelated to a real boundary. Do not
replace a production machine with a fixture-side duplicate or weaken an
assertion because it conflicts with an obsolete identity assumption.

When the approved architecture changes meaning, explicitly update the owning
contract and its proof. A docs-only PR does not authorize silently changing
production tests to declare the target implemented.

## 9. Required security and recovery coverage

Preserve wrong repository/host/task/Source/App/installation/branch denial,
changed contract/policy/credential generation, expired/revoked authority,
protected-path constraints, and independent WRITE/CREATE/DELETE/DENY checks.

Prove local and remote caller differences converge at common admission.
Visibility-only remote callers must not receive App write/operator authority.
Wrong issuer/Relay/audience/request, expired assertions, concurrent replay,
and Runtime restart must be exercised.

Preserve partial branch/PR creation, conditional compensation, advanced-branch
safety, no-op retries, abort cleanup, unavailable reread, and unknown
post-effect outcome. Reconnect/reauthentication cannot reset possible execution.

Secret-leak tests inspect the generated data/log/evidence surfaces rather than
merely asserting a helper returned a safe object.

## 10. Onboarding and multi-repository proof

A clean path must actually establish owner custody, installation binding,
trust publication/human wait/recheck, Runtime, Session authorization, and a
verified operation. Fixtures cannot pre-seed connected/trusted/ready and then
claim onboarding succeeded.

Use repositories A and B for positive paths and cross-target negative cases.
Prove stable identity on rename, shared/dedicated App behavior without key
copies, owner-side Session filtering, restart/adoption, candidate-first
rotation, and interrupted disconnect recovery.

An unavailable browser/component/provider prerequisite is blocked/not checked.
A same-machine process topology does not become remote-host certification by
naming a client remote.

## 11. Performance evidence

Measure actual command invocation counts, suite durations, and workflow
critical path separately. Parallel job durations cannot be summed and reported
as developer waiting time.

Report cold/warm/cache conditions, candidate/toolchain, and relevant fixture
cost. Do not promise a savings percentage from one historical CI sample.
Wall-clock speed changes must not trade away required proof or failure
propagation.

## 12. Result vocabulary and reporting

Passed means executed successfully on the stated subject/environment.
Failed means executed with a contract/check failure. Blocked means a required
prerequisite prevented the intended check. Pending, cancelled, skipped, stale,
and not run remain distinct and are never normalized to passed.

For each required check report command or CI job, exact SHA, environment,
result, and bounded evidence. Local verification and remote CI are separate.
A successful documentation structure check is not `pnpm run verify`.

A current PR is not merge-ready while required checks are pending/failed or
its claimed proof uses an earlier head. Re-read exact-head checks before the
final readiness claim.

## 13. Convergence acceptance

The verification work is complete only when each obligation has one named
execution owner, duplicate same-boundary runs are removed, revision-bound
build/pack consumption is proved, routine and release checks are separated,
and Inari-specific installed/process/browser/security proofs remain intact.

Implementing this architecture may require the shared workflow's own bounded
change. Do not fork generated consumer governance or pin a workaround to an
unaccepted workflow branch. Report external dependencies explicitly.
