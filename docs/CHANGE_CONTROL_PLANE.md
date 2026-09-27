# Governed Change Control Plane

Status: normative target under [Product Architecture Canon](./ARCHITECTURE.md). The earlier Implementation-root architecture is superseded for new canonical Change operations. Historical records are not rewritten by this document.

## 1. Change and execution are different identities

A Source Issue states the outcome to achieve. Its Change is the governed lifecycle projected from repository artifacts and evidence. An Implementation is one bounded task contributing to one or more canonical Sources. Its Session, leaf branch, PR and execution evidence identify that task, not every Source Change.

The canonical Change identity is repository identity plus the selected Source Issue. No independent Change-ID namespace or persistent Change database is introduced. Multiple independent Implementations may contribute to the same Source without sharing one task identity or overwriting one another's leaf branch.

An Implementation Session can request a Source Change operation only when that Source is in both its signed authorized set and the current contract. It never treats the Implementation number as a Source by convenience. The task-bound publication compatibility claim remains restricted to leaf publication/branch-side behavior.

## 2. Publication and integration

Keep these provider objects separate:

- Implementation leaf: its exact governed branch, base, PR role, task relation and execution evidence.
- Source Change: its current canonical publication/integration evidence and lifecycle.
- Epic integration: the composed source outcomes and final product-level certification.

A Source Change's canonical publication pair must not be populated with an arbitrary child's branch/PR. In an Issue-integration topology, Source integration and Implementation publication are separate pairs. For standalone work, the existing explicit routing/publication contract determines the admitted pair; do not invent an Epic, choose the first Implementation, or alias task and Source identity to fill a missing binding.

Canonical native relationships and accepted routing evidence select the base. Branch grammar checks consistency and safe spelling, not parentage. Multiple Source references are not multiple implicit integration parents.

A request with missing or contradictory publication evidence is action-required/denied. Migration must prove standalone and multi-Implementation publication before claiming full Source-root conformance; #1213's Local binding correction alone does not prove every producer/consumer has migrated.

## 3. Lifecycle contract

The public vocabulary remains `DEFINED`, `DRAFT`, `REVIEW`, `ACCEPTED`, `MERGED`, `ABORTED` and `RECOVERY_REQUIRED`. The canonical Core and Lifecycle Controller determine legal transitions from current evidence; this guide is not a second transition table.

`DEFINED` permits a governed Source with no issued publication. Issuance materializes the exact admitted canonical artifacts. `DRAFT` requires the healthy draft publication, not merely an existing branch. `ready` produces verified reviewability; it does not mean a human approved or required checks passed. `ACCEPTED` and `MERGED` require their actual repository-policy/provider evidence.

The product's semantic merge composition retains explicit intent, exact PR/head/base and repository merge-policy admission. It is not permission for implementation agents, Hosted, or the initial App effect profile to approve or merge. Unsupported provider execution remains denied; no implicit user-token fallback is introduced.

## 4. One evidence-to-effect pipeline

```text
current repository/owner evidence
  -> normalized observation and semantic projection
  -> caller/operation admission
  -> explicit plan and preconditions
  -> bounded provider effects
  -> authoritative reread
  -> postcondition verification
  -> verified result or bounded recovery state
```

Core owns semantics and plans. XState owns sequencing. Executor composes them with evidence/effect ports. Inari Access contains provider authority. Clients and Relay do not add effects or classify success themselves.

Provider credentials used to obtain pre-admission evidence are scoped read capabilities owned by Executor; they do not become Admission credentials. Governance generation, artifact observation and branch/head freshness are distinct preconditions.

## 5. Retry, compensation and abort

Issuance is create-or-return-existing for the same admitted identity. A lost response is not absence and must not create duplicate canonical branches or PRs. Retry starts from a fresh projection.

If an effect partially succeeds, compensation is limited to the exact owned generation and admitted cleanup plan. Never delete advanced work or a sibling's branch to simulate atomicity. Unsafe/failed compensation remains recovery-required with bounded evidence.

Abort closes or cleans only the canonical artifacts admitted by the current abort plan. It preserves unrelated work, historical identity and any evidence needed for recovery. Repeated completed abort is a no-op only when the provider postcondition is established.

A possible send followed by disconnect, timeout or unreadable result stays unknown until reconciled. Relay delivery state, XState completion and HTTP status cannot independently establish a semantic terminal state.

## 6. Completion and compatibility

Implementation completion proves that task's current contract and exact revision. Source completion proves the Source acceptance criteria on the composed target ref. Epic completion proves the whole composition. Closed flags and counts of merged leaf PRs are insufficient.

Historical Implementation-root or Issue-root records retain their original identities for bounded observation/migration. They cannot authorize new work on a retired execution path. Any recovery effect requires explicit current authorization through the canonical executor, not a revived legacy provider engine.

The earlier Direct App execution deployment and parallel Hosted semantic executor are removed in convergence. Compatible data readers may remain; parallel authority may not. See [Implementation Contract](./IMPLEMENTATION_CONTRACT.md), [Lifecycle Controller](./XSTATE_CHANGE_MACHINE.md) and [Architecture Convergence](./ARCHITECTURE_CONVERGENCE.md).
