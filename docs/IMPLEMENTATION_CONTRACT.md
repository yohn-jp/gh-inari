# Issue and Implementation Governance

Status: normative task/authoring contract under
[Product Architecture Canon](./ARCHITECTURE.md).

Source outcome, Implementation execution, Source Change lifecycle, Session,
and publication are distinct. This renewal preserves the bounded contract,
authorization digest, scope, lifecycle evidence, relationship, and conformance
details while replacing the older requirement that every Change root equal
its Implementation.

## 1. Responsibility boundary

An ordinary Issue records a problem, request, decision, or research/maintenance
outcome. It owns its acceptance criteria, not a mandatory session plan.
It may remain open without an Implementation, branch, PR, or active Change.

An Implementation records one bounded execution task: objective, non-goals,
selected implementation design, path authority, constraints, dependencies,
verification, observable postconditions, and base/branch binding.
It does not replace the Source or rewrite the broader request as a session.

A PR describes delivered work, links its governing task or integration subject,
and records validation/review context. It is not a replacement authorization
record or a second source of path permissions.

Creating or editing any of these artifacts is separate from authorizing work,
starting a Session, issuing publication, requesting review, merging, or
closing the Source.

## 2. Lifecycle and current evidence

### 2.1 Ordinary Source lifecycle

Record the desired outcome first. Resolve its decision and acceptance contract.
When execution is prepared, derive the bounded Implementations necessary to
deliver it. Keep Source acceptance and implementation scope separate.

A Source can have multiple independent Implementations. Completion of a child
is not completion of the Source; Source closure requires its own composed
acceptance evidence and explicit terminalization authority.

### 2.2 Implementation lifecycle

The existing lifecycle projection distinguishes:

```text
draft
ready
authorized
completed
aborted
invalidated
superseded
```

`draft` is an incomplete or invalid canonical contract. `ready` is a complete
valid contract without current authorization. `authorized` requires an
explicit record matching repository, Implementation, canonical body digest,
and base evidence.

`completed` requires exact current authorization, bound execution evidence,
and recomputed conformant results. A caller assertion, PR closed flag, or
unchecked acceptance list is not completion evidence.

`invalidated` records body/repository/base or other required-evidence drift.
`superseded` requires explicit evidence of the successor; a similarly named
Issue or newer timestamp is not enough.

`aborted` requires the task's applicable termination evidence. Source Change
abort and Implementation task termination must not be equated merely because
a task contributes to that Source. The termination record binds directly to
the task authorization identity in §6.1; Source lifecycle is not a proxy.

The canonical task evidence is a versioned termination record owned by the
repository and finalized by an explicitly authorized Runtime operator. It is
bound to the immutable repository, Implementation Issue, current canonical
body authorization digest, and accepted base evidence. Issue closure and a
Session's self-asserted abort do not finalize it. A Source Change abort and a
Session close remain their own lifecycle events.

Admission resolves the authoritative current termination state for every
task-bound operation. A successful read proving that no termination event is
recorded means only that the task is not terminated; other Admission checks
still apply. Once the task is terminated, every existing Session for that
task fails closed. A failed or unavailable read, or invalid or mismatched
current evidence, denies the operation. The termination producer uses the
Runtime's authorized operation and Executor-owned repository effect; the
Admission evidence reader and Implementation lifecycle projection consume the
resulting current evidence. This contract does not prescribe a record path or
wire encoding.

### 2.3 Immutable authorization event

Authorization records an event against the exact canonical body and base.
Editing the body invalidates that evidence; it does not amend the previously
authorized record in place or silently enlarge a running Session.

Authorization itself does not create a branch, publish a PR, modify GitHub,
or permit operations absent from the accepted scope. A running task must not
continue under stale authorization.

## 3. Bounded Implementation contract

The existing v1 contract/schema is exposed through the
`implementation-contract` package boundary. Its native form is generated from
`.github/inari/issues/implementation.json` to
`.github/ISSUE_TEMPLATE/implementation.yml`.

Canonical governed body content establishes contract identity. Title, labels,
assignees, Projects metadata, and discussion comments are not substitutes for
that body digest.

The contract includes:

- immutable repository identity and canonical Source references;
- objective, non-goals, architecture decision, affected components,
  invariants, and compatibility constraints;
- separate READONLY, WRITE, CREATE, DELETE, and DENY path lists;
- prohibited operations, immutable areas, and prerequisites;
- acceptance criteria, targeted tests, required checks, and postconditions;
- base branch/revision/freshness, implementation branch, and execution
  dependencies.

An ordinary Implementation's architecture field selects how to implement the
approved contract. It cannot approve changes to the Product Architecture
Canon, credential/trust owners, public meaning, or recovery guarantees.

WRITE is an explicit allowlist, defaults empty, and never implies CREATE or
DELETE. DENY narrows every matching allowance. The execution projection is
produced only from a verified current authorization, not a caller scope merge.

## 4. Current `impl` command surface

The following generated block records the current baseline command contract.
It is an implementation reference, not a separate authorization policy or a
promise that the future CLI Canon migration preserves every shell byte.
The generated markers remain available to the existing documentation checks.

<!-- BEGIN GENERATED IMPLEMENTATION COMMAND SURFACE -->

The current command contract is version `1.18.0` (`urn:inari:command-contract:1.18.0`).
The `impl` namespace projects these operations from the command contract:

| Command                         | Command ID       | Metadata summary                                                                                                    |
| ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `inari impl plan <number>`      | `impl.plan`      | Draft a bounded Implementation recommendation from authoritative Issue evidence without granting authority.         |
| `inari impl show <number>`      | `impl.show`      | Show the current Implementation body, canonical contract projection, and authorization state.                       |
| `inari impl validate <number>`  | `impl.validate`  | Validate an existing Implementation body against the canonical contract without mutation.                           |
| `inari impl authorize <number>` | `impl.authorize` | Authorize one current canonical Implementation body through the #572 Core boundary.                                 |
| `inari impl inspect <number>`   | `impl.inspect`   | Inspect Implementation lifecycle and provider-authoritative parent/source relationships.                            |
| `inari impl verify <number>`    | `impl.verify`    | Verify a pull request and its authoritative diff against one current authorized Implementation.                     |
| `inari impl frontier <number>`  | `impl.frontier`  | Compose the bounded Implementation Frontier from repository evidence and project it through the authoritative Core. |

The exact contract usage and option applicability are:

- `impl plan <number> [--repository <repository>] [--from <path>] [--capability <id> ...]`
- `impl show <number> [--repository <repository>] [--from <path>] [--capability <id> ...]`
- `impl validate <number> [--repository <repository>] [--from <path>] [--capability <id> ...]`
- `impl authorize <number> [--repository <repository>] [--from <path>] [--capability <id> ...]`
- `impl inspect <number> [--repository <repository>] [--from <path>] [--capability <id> ...]`
- `impl verify <number> [--repository <repository>] --from <path> [--capability <id> ...] --pr <number> [--execution-evidence <path>]`
- `impl frontier <number> [--repository <repository>] [--capability <id> ...]`

<!-- END GENERATED IMPLEMENTATION COMMAND SURFACE -->

Repository-backed Issue operations use a positive Issue number. The existing
positional-free `impl frontier --from <path>` is a bounded-evidence mode,
not permission to substitute caller data for repository-backed authority.
`--capability` is repeatable. `--from` accepts a file or stdin where the
current command permits it; it is not supplemental trusted evidence in modes
that read authorization/conformance from the repository.

Use installed Help and the current command contract for exact syntax. The
organization's current restriction on agents invoking Inari is operational
governance and is not removed by documenting the product command surface.

## 5. Parent, Source, and dependency relations

### 5.1 Native parentage

Where the provider capability supports native parent/sub-issue relationships,
that evidence establishes immediate parentage. A legacy `Parent:` line may
explain history but does not override native state or authorize automatic
reparenting.

Source references in the body and execution dependencies are canonical
contract inputs with their own meaning. They are not substitutes for native
integration parentage.

### 5.2 Multiple Sources

A task may contribute to a bounded exact set of Sources. Do not infer a
primary Source from ordering, title, branch spelling, or the first successful
lookup. Do not treat each Source as a separate implicit PR base.

A Source lifecycle request selects one Source explicitly and proves its
membership in the signed and current authorized sets.

### 5.3 Dependencies

A true execution dependency describes a required producer capability/state.
Sibling PR merge order is not automatically such a dependency. A downstream
Implementation consumes physically integrated producer state on its accepted
base, not a sibling's unmerged worktree or an Issue closed flag.

An incomplete or unavailable relationship observation is not an empty,
complete dependency graph.

## 6. Cross-artifact identity

### 6.1 Task identity

```text
task authorization identity
  = repository identity
  + Implementation Issue
  + canonical governed-body digest
  + accepted base evidence
```

The digest identifies the authorized content; it does not create a separate
Change-ID namespace.

### 6.2 Source Change identity

```text
Change identity
  = repository identity + selected canonical Source Issue
```

The task remains the Implementation. It is not replaced with the Source to
make a Change operation pass an equality check.

### 6.3 Local Session binding

The signed local binding retains task identity, branch observation, and
current Implementation authorization with its Source set. Source lifecycle
claims are issued for that set. Branch advancement remains exact leaf-branch
authority under `branch.advance`.

Newly authorized Implementation task Sessions receive an explicit
`pullRequest.create` claim in the Runtime Authority ceiling and signed
binding only when current repository and task policy authorize that exact
leaf publication. The claim and each publication request must match the
immutable repository, Implementation, exact leaf head, accepted base, and
current policy. The claim is not inferred from `change.implement`, branch
spelling, or an App permission.

For a valid #1213 binding issued before replacement, the task-bound
`change.implement` claim remains a compatibility input only for exact
same-task Implementation leaf PR publication. Admission must verify the
original signed binding and validity interval, current task authorization,
repository, leaf head, accepted base, request, and current policy. It must
not reinterpret the old claim as a new `pullRequest.create` grant or permit
Implementation-root Source Change operations. Its use ends at the binding's
original expiry or explicit reissue; replacement issuance omits it. Retire
legacy admission only after no active valid binding can require it and the
explicit path has end-to-end proof. Historical readers may still classify
old bindings.

### 6.4 Publication and integration

An Implementation leaf PR links the Implementation and binds its exact
branch/base/head. A Source integration PR binds the Source and its composed
acceptance. An Epic integration PR binds the product-level integration.

The Source integration acceptance is a versioned record finalized by an
authorized independent reviewer. It binds immutable repository and Source
identities, the governed Source integration PR and exact head SHA, the current
Source criteria version/digest, reviewer identity and current authority, and
an explicit result for each criterion. Current repository policy determines
reviewer independence. Change `ACCEPTED` checks, reviews, governance, and
merge-policy evidence remains necessary but does not itself prove these
criteria. Source and Epic composition consume the current Source acceptance
result separately from task conformance and Change policy acceptance.

The accepted topology may be:

```text
Implementation leaf -> Source integration -> Epic integration -> default
```

Standalone work remains supported through its explicit route. Do not invent
an integration hierarchy where none is required. Existing in-flight topology
is not silently rerouted by document or branch-name changes.

### 6.5 Evidence and conformance

Execution evidence binds the authorization, repository, base, branch, and head
actually verified. Conformance is recomputed against the canonical contract
and authoritative diff/evidence. A green check from another head or a source
checkout is not the same proof as the claimed installed/composed boundary.

## 7. Source-operation admission

A Source operation must match:

- the same immutable repository;
- the current Implementation authorization and applicable task binding;
- the requested Source in the signed Source set;
- that Source in the freshly read current contract;
- the requested capability and validity ceiling;
- current branch, protected-path, lifecycle, and effect preconditions.

Source addition after Session issuance cannot widen the Session. Source
removal, stale body/base evidence, cross-repository references, or malformed
binding is denial. The task-bound publication compatibility claim does not
bypass these checks.

Remote user invocation does not require a newly issued client Session key.
Its Hosted assertion establishes identity/eligibility; Runtime still requires
actual subject/operation authorization and the applicable current task
contract. Visibility alone is not authorization to implement a task.

## 8. Scope projection and enforcement

Use the canonical projection in
[Implementation Execution Scope](./IMPLEMENTATION_EXECUTION_SCOPE.md).
It preserves independent operations, DENY precedence, repository/base, and
authorization identity. Consumers do not reconstruct it from prose.

Inari's contract is not physical filesystem isolation. A local runtime such
as Nawabari may enforce the projected scope under its own security boundary.
The projection does not give the consumer a broader permission than the
current Inari authorization.

## 9. Completion, rework, abort, and supersession

Completion requires the exact admitted task's evidence and conformance.
A merged leaf does not close its Source or Epic without their acceptance
checks. A Source being closed elsewhere does not magically certify a task.
Source completion fails closed if the acceptance record is missing,
unavailable, invalid, stale, mismatched, dismissed, or revoked, including a
changed integration head or criteria version/digest or lost reviewer authority
or independence. Historical Source data remains readable with bounded
classification, but without a current versioned record it cannot be reported
as accepted. The record grants no merge or provider mutation authority;
neither Runtime nor Relay receives a GitHub user token to obtain it.

Review rework inside the admitted contract follows its current validity and
scope rules. Work beyond that contract requires a newly authorized bounded
Implementation/session rather than inflating an old authorization record.

Supersession records a new identity and explicit relationship; it does not
widen the old grant. Abort preserves inspectable provenance while removing
current execution authority according to the task's actual lifecycle.

Task termination is finalized only by an explicitly authorized Runtime
operator recording the repository-owned versioned task event against the
current authorization digest and accepted base. Source Change abort terminates
that Change only; Session close closes that Session only. Neither Issue closure
nor a Session's self-asserted abort finalizes task termination. Admission
rereads current task-termination evidence for each task-bound operation. A
successful read proving no termination event is recorded establishes only that
the task is not terminated; all other current checks still apply. Every
Session for a terminated task fails closed. A failed or unavailable read, or
invalid or mismatched current evidence, denies. A Source may have other active
Implementations, so one task's state cannot be inferred from another task or
the Source's flag.

The producer seam is the operator-authorized Runtime lifecycle operation and
its Executor-verified repository effect. The consumer seams are Admission's
per-operation current-evidence read and the Implementation lifecycle
projection. They must compose the same repository, Implementation, current
authorization digest, and accepted base binding.

## 10. Authoring and review

Keep ordinary Source forms focused on intent and outcome. Put scope,
base/branch, dependencies, tests, and postconditions in the Implementation.
PRs describe delivered work and validation, not a duplicated authorization.

Before dispatch, resolve actual integration seams, accepted producer state,
current base, expected verification, and all files causally required for the
bounded contract. Do not invent a narrow scope that makes an obvious required
connection impossible, then ask a worker to redesign around the denial.

The worker may reorganize internal implementation within the approved scope.
Changes to architecture, credential ownership, identities, public semantics,
or acceptance requirements return to the owner/design review.

## 11. Compatibility and migration

Historical identity is preserved during observation. No record is re-rooted,
reparented, widened, or deleted merely because the target architecture changed.
Bounded readers adapt only proven semantics into the canonical model.

The current `implementation-lifecycle.ts` projection accepts a bound
ABORTED Change identity as Implementation `aborted` evidence. Preserve that
behavior only as a bounded reader for historical data during migration. New
task termination and Admission must use the repository-owned versioned task
record; the old Change identity is not new task-termination authority.

The old Implementation-root execution model is not retained as a parallel new
execution architecture. Migrate Source/task/publication joins across all
relevant producers and consumers, preserving the explicit #1213 bridge until
its governed replacement is proved.

## 12. Verification obligations

Prove canonical-body parsing/digest, authorization invalidation, each
independent path operation and DENY, exact repository/base, multiple Source
membership, wrong/removed/stale Sources, sibling task isolation, native parent
versus source/dependency semantics, publication role/base, and exact-head
conformance.

Prove task completion and Source/Epic completion separately. Test a changed
body after authorization and a changed branch after verification. Do not
accept caller-supplied completion or stale green evidence as proof.

The documentation renewal does not itself complete these migrations or alter
Issue state. The backlog audit reports those distinctions read-only.
