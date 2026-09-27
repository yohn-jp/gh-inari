# Lifecycle Controller and XState

Status: normative implementation boundary under [Product Architecture Canon](./ARCHITECTURE.md) and [Change Control Plane](./CHANGE_CONTROL_PLANE.md).

## 1. Responsibility

XState implements the Lifecycle Controller: legal event sequencing, retry/no-op, compensation/recovery routing, reread and postcondition verification. It is not repository authority, a persisted Change database, a credential broker or an artifact-definition language.

Core supplies semantic state, plans, preconditions and diagnostics. Provider/transport adapters supply bounded I/O. A machine may invoke those contracts but must not recreate template, branch, relation, capability or repository-policy rules in private guards.

## 2. Semantic versus execution state

The public Change vocabulary remains `DEFINED`, `DRAFT`, `REVIEW`, `ACCEPTED`, `MERGED`, `ABORTED` and `RECOVERY_REQUIRED`. The executable lifecycle contract, not a copied prose table, determines allowed transitions.

Internal actor states describe orchestration progress. They do not become public Change states. An actor reaching a terminal node proves control-flow completion only; a successful product result also requires the planned postcondition to match freshly read authoritative evidence.

A new process starts from current repository projection and relevant owner state. It never restores permission to mutate from an old actor snapshot. Owner journals and replay fences preserve the evidence needed for safe recovery without turning XState into a parallel authority.

## 3. Execution convention

Each operation uses current evidence, Core projection/admission, an explicit plan, bounded effects, reread and verification. The controller sequences those stages and maps their typed outcomes without introducing provider policy.

Issuance handles existing healthy artifacts as an explicit no-op. Partial creation has an explicit compensation or recovery path. Ready requires current canonical publication and relevant verification. Abort applies only currently safe cleanup. Merge composition requires separate semantic merge admission and an authorized provider path; a statechart transition cannot supply missing merge permission.

Unknown reads are not absence. A possible effect followed by failure is not a pre-effect retry. An already satisfied postcondition may complete without another effect only after authoritative verification.

## 4. Identity and adapters

Machines consume the Source-root Change identity and distinct Implementation/task/leaf-publication evidence defined by the domain contracts. They do not equate them or infer the selected Source from a branch name.

CLI, MCP, Local Console and Hosted transport do not select different lifecycle policies. Retiring Direct App removes a deployment/entry path, not the shared machine or effect-planning implementation required by Executor.

The current modules include `src/change.ts`, `src/change/machine/lifecycle-machine.ts`, `src/change-trusted-executor.ts` and `src/change/machine/trusted-execution-adapter.ts`. Their exact exported types remain implementation evidence; the target does not require directory churn for its own sake.

## 5. Verification

Prove lifecycle legality through the canonical machine, and execution behavior through bounded real ports. Cover no-op retries, partial effects, stale evidence, safe/unsafe compensation, abort recovery, unknown post-effect outcomes and verified terminal projection.

Do not duplicate a production transition table in tests and call agreement proof of correctness. Test externally meaningful invariants and reachable counterexamples. Package/transport certification must exercise these same machines, not fixture-side equivalents.
