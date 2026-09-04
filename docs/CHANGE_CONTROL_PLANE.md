# Inari Governed Change Control Plane

Status: proposed architecture for Epic #188; implementation begins only after this document is merged.

## 1. Purpose

Inari is evolving from a governed GitHub CLI into a deterministic governance control plane for repository Changes.

The product already treats repository-native Issue Forms and pull request templates as deterministic typed contracts, validates structured semantic input, renders canonical GitHub artifacts, and fails closed when governance cannot be resolved safely. The next architectural step is to govern the lifecycle by which implementation work is published to GitHub, not only the shape of the individual Issue or pull request artifact.

The central abstraction is `Change`.

A Change is the governed execution identity that connects one intent-bearing Issue to one canonical remote branch and one canonical pull request. It is issued when implementation begins, remains observable while work proceeds, becomes reviewable through an explicit governed transition, and terminates through merge or abort.

This document defines the product model, lifecycle, authority boundaries, caller interfaces, trusted execution path, security model, failure semantics, provenance, and migration constraints for that control plane.

This document is architectural authority for those boundaries. It does not replace executable semantic templates, schemas, validators, command metadata, repository Rulesets, or tests. Where a rule can be expressed and enforced mechanically, the executable authority remains canonical and this document describes its intended role.

## 2. Product definition

The target product definition is:

> Inari is a deterministic governance control plane for GitHub repository Changes.

This definition deliberately does not say that Inari *is* GitHub Actions, a GitHub App, a CLI, or a Web application.

Those are distinct roles:

- **Inari Core** owns semantic contracts, policy resolution, canonicalization, Change state-machine validation, transition planning, invariants, and diagnostics.
- **Inari CLI** is the canonical human- and agent-facing client surface.
- **GitHub Actions** is the initial trusted remote execution runtime for privileged Change transitions.
- **Inari GitHub App** is the authority identity and capability used by trusted execution to apply privileged GitHub effects.
- **GitHub** is the initial observable state store and primary human visualization surface for Issue, branch, PR, CI, review, and merge state.
- **MCP, GitHub-native UI adapters, or a future service** may become additional clients or transports without becoming new semantic authorities.

The architecture therefore separates three concerns that must not collapse into one another:

```text
semantic authority     execution runtime       mutation identity
------------------     -----------------       -----------------
Inari Core             GitHub Actions          Inari GitHub App
```

Actions executes a transition plan. The App authenticates privileged effects. Neither defines the meaning of a Change.

## 3. Why Change exists

Today, Issue, branch, and pull request can be created as independent artifacts by human or agent callers. Even when Inari validates Issue and PR contracts, two important governance properties remain distributed:

1. the caller may choose a remote branch name before Inari sees the pull request; and
2. the person who implements the change often becomes the PR author merely because they invoked `pr create`, which prevents that same person from formally approving the PR in GitHub.

Both problems are symptoms of the same missing abstraction: publication of repository work is not yet a governed transition.

The Change model changes that.

Instead of treating branch creation and PR creation as unrelated user actions, Inari treats them as projections of one semantic operation: **issue a Change**.

```text
Issue #189
    |
    | issue Change
    v
Change #189
    +-- canonical branch
    `-- canonical Draft PR
```

The Issue number is the natural Change identity in the initial model. No independent Change ID namespace is introduced.

## 4. Core domain model

### 4.1 Issue

An Issue represents intent, requirement, defect, architecture decision, maintenance request, or other governed work definition.

An Issue may exist indefinitely without an active Change. Creating an Issue does **not** imply implementation has started.

```text
Issue -> Change cardinality: 0..1 active canonical Change
```

The architecture does not require Issue creation itself to be issuer-only.

### 4.2 Change

A Change represents the governed execution identity for implementing one Issue.

A Change is not a fourth persistent GitHub object. It is a semantic state derived from canonical GitHub projections and governed metadata.

The initial identity is:

```text
Change identity = repository identity + root Issue number
```

For example, `yohn-jp/gh-inari#189` identifies the Change rooted in Issue #189 when that Issue has been issued.

### 4.3 Canonical branch

Every issued active Change has exactly one canonical remote branch.

The branch name is a deterministic projection computed by Inari from governed inputs. Human and agent callers do not supply the canonical branch name as free-form authority.

The exact naming grammar remains executable repository governance, not prose in this document. This architecture only fixes ownership:

> Inari determines the canonical remote branch identity for a governed Change.

### 4.4 Canonical pull request

Every issued active Change has exactly one canonical pull request.

The canonical PR is created as **Draft** during Change issuance. It exists from the beginning of implementation rather than being created after implementation is complete.

The canonical PR author is the issuer identity, normally the Inari GitHub App, not necessarily the implementation author.

This deliberately separates:

```text
proposal publication identity != implementation authorship
```

Commit authorship and other Git provenance continue to record who authored implementation commits.

## 5. Cardinality and identity invariants

The following invariants are normative.

### 5.1 Root Issue

Every Change has exactly one root Issue.

A Change without a governed root Issue is invalid.

### 5.2 Issue without Change is valid

Backlog and planning Issues may exist without branches or PRs.

Change issuance represents the transition from intent to active implementation.

### 5.3 One canonical branch

Every issued active Change has exactly one canonical branch.

A second branch may physically exist in GitHub, but it is not automatically another canonical branch for the Change.

### 5.4 One canonical PR

Every issued active Change has exactly one canonical PR.

A manually created or otherwise noncanonical PR may physically exist, but it must not gain governed Change provenance or become merge-admissible merely by pointing at the same code.

### 5.5 Branch and PR are born together logically

Successful Change issuance means both canonical branch and canonical Draft PR exist and agree with the same Change identity.

GitHub requires these effects to happen through multiple API operations, so this is a **logical transaction**, not an atomic GitHub transaction.

### 5.6 Derived state before duplicated state

Inari does not introduce a persistent Change database in the initial architecture.

Change identity and lifecycle state are derived from governed GitHub state and canonical metadata. A separate database may be introduced only if a demonstrated requirement cannot be satisfied safely through deterministic derivation.

This follows the rule:

> Derive state; do not duplicate state without necessity.

## 6. Change lifecycle

The lifecycle should be modeled semantically by Inari Core and projected onto GitHub-native states where possible.

A minimal model is:

```text
DEFINED
   |
   | issue
   v
DRAFT
   |
   | ready
   v
REVIEW
   |
   | policy satisfied
   v
ACCEPTED
   |
   | merge
   v
MERGED

DRAFT / REVIEW
   |
   | abort
   v
ABORTED

Any privileged transition with unrecoverable projection drift
   |
   v
RECOVERY_REQUIRED
```

The names used in the final machine contract may differ, but the semantics below are fixed.

### 6.1 DEFINED

A governed Issue exists, but no active Change has been issued.

There is no requirement for a canonical branch or PR.

### 6.2 DRAFT

Change issuance completed successfully.

Both canonical branch and canonical Draft PR exist. Implementation may proceed. The Draft state represents active execution, not review readiness.

GitHub's Draft PR state is intentionally reused as the visible projection of this phase.

### 6.3 REVIEW

The Change has passed the governed `ready` transition.

The canonical PR is Ready for review. The transition is not merely a raw GitHub UI toggle; Inari must validate the Change projection and all governance preconditions that belong to the transition before admitting the Change to review.

### 6.4 ACCEPTED

Required reviews, status checks, governance checks, and other merge admission policy are satisfied.

Whether ACCEPTED exists as a separately materialized state or is derived at read time is an implementation detail. The semantic distinction remains useful: reviewability and merge admissibility are not the same thing.

### 6.5 MERGED

The canonical PR has been merged under repository policy.

The implementation leaves active execution state. Post-merge branch cleanup policy is separate from the semantic identity of the completed Change.

### 6.6 ABORTED

The Change is intentionally stopped without merge.

Abort behavior must define what happens to the canonical PR and branch, but it must preserve enough provenance to explain that the Change existed and was intentionally terminated.

### 6.7 RECOVERY_REQUIRED

GitHub's effects are not atomic. An operation may partially succeed and then fail, and compensation may itself fail.

When Inari cannot restore or prove a valid canonical projection, it must fail closed and expose an explicit recovery-required condition. It must not silently pretend the Change is healthy.

## 7. Issuance transaction

The semantic operation is conceptually:

```text
inari change issue <issue>
```

The public command name is not yet implementation contract, but the operation is.

A compliant issuance plan performs the following logical steps:

1. resolve target repository and governance generation;
2. read the root Issue;
3. resolve and validate the governing Issue contract;
4. verify that the Issue is eligible for Change issuance;
5. determine the target base branch;
6. compute the canonical Change branch name;
7. inspect existing GitHub state for prior issuance or inconsistency;
8. create the canonical remote branch through the issuer identity;
9. create the canonical Draft PR through the issuer identity;
10. verify that the resulting branch/PR projection matches the planned Change;
11. return one bounded machine-readable Change result.

The user-visible operation succeeds only when the canonical branch and canonical Draft PR are both established consistently.

## 8. Idempotency

Authoritative remote operations must be retry-safe because Actions, network calls, clients, and users can all retry.

Issuance therefore follows **create-or-return-existing** semantics, not blind create semantics.

Repeated issuance for the same eligible Issue must produce one of three outcomes:

1. the canonical Change does not exist: create it;
2. the canonical Change already exists and matches all invariants: return the existing Change deterministically;
3. partial, conflicting, or ambiguous state exists: fail closed with an inconsistency/recovery diagnostic.

It must never create PR #N and then PR #N+1 merely because the request was retried.

Idempotency keys may be implicit in repository + Issue identity or explicit in a future transport. That transport choice does not change the semantic requirement.

## 9. Compensation and recovery

GitHub does not provide an atomic transaction spanning ref creation and PR creation.

The initial compensation rule is:

```text
create canonical branch
    |
    +-- failure -> no Change issued
    |
    `-- success
          |
          v
    create Draft PR
          |
          +-- success -> verify projection -> Change issued
          |
          `-- failure -> compensate branch creation
```

If compensation succeeds, issuance fails but does not leave a canonical orphan branch.

If compensation fails, Inari reports `RECOVERY_REQUIRED` or equivalent structured failure and preserves exact evidence needed for bounded repair.

Recovery must itself be governed and deterministic. The architecture rejects ad hoc hidden cleanup that erases provenance or guesses caller intent.

## 10. Branch authority model

The initial architecture governs **branch birth**, not every branch update.

### 10.1 Creation

Canonical remote branch creation is issuer-controlled.

Where GitHub Rulesets can enforce `Restrict creations`, the issuer identity should be the allowed/bypass actor for the governed namespace.

The objective is capability control rather than post-hoc naming validation:

```text
caller chooses arbitrary new remote branch -> denied
Inari issues canonical branch             -> allowed
```

### 10.2 Updates

Ordinary fast-forward pushes to an already-issued working branch remain available to the worker under the initial architecture.

This preserves the normal development loop:

```text
edit -> commit -> push -> edit -> commit -> push
```

without forcing each update through Actions.

The architecture explicitly rejects routing every feature-branch push through the issuer in the first version. A future policy may strengthen publication authority if a concrete requirement justifies the added friction.

### 10.3 Deletion

Branch deletion is a lifecycle/governance concern distinct from creation and update. Implementation must define when cleanup is allowed and how merged/aborted Change provenance remains recoverable.

## 11. PR authority model

GitHub does not provide an exact symmetric native rule equivalent to branch `Restrict creations` that means "only this GitHub App may create pull requests" for the entire repository.

Therefore canonical PR issuer control is enforced semantically and at merge admission.

### 11.1 Canonical PR creation

The trusted executor creates the canonical Draft PR using the Inari GitHub App identity.

The PR is created immediately after canonical branch issuance, removing the normal need for humans or agents to run direct `pr create` for governed Changes.

### 11.2 Noncanonical PRs

A user may still be technically capable of creating a PR from an existing branch through GitHub.

Such a PR is not canonical merely because it exists.

A required Change-provenance governance check should validate at least:

- root Issue identity;
- canonical branch identity;
- canonical base;
- canonical PR identity for the Change;
- expected issuer/proposal-author identity where applicable;
- valid governed PR contract;
- absence of conflicting canonical projections.

A noncanonical PR may be visible but must not become merge-admissible as the governed Change.

This is a deliberate distinction:

```text
physical creation prevention: not always complete
canonical merge admission:    enforceable
```

## 12. Draft-at-issuance semantics

Creating the PR as Draft at Change issuance is a central design decision, not incidental automation.

It provides four properties:

1. Issue, branch, and PR identity are fixed before implementation diverges;
2. GitHub's PR list becomes an observable list of active Changes;
3. the proposal author can be neutral issuer infrastructure from the beginning;
4. review readiness becomes an explicit lifecycle transition rather than being conflated with PR creation.

The mapping is:

```text
Draft PR = implementation/execution state
Ready PR = review-admitted state
```

The initial Draft PR may contain only information derivable before implementation, such as root Issue, target, status, and governed placeholders.

The `ready` transition may canonicalize or complete implementation summary, validation evidence, acceptance evidence, and other required PR semantics before changing GitHub's Draft state.

## 13. Review separation and self-review

GitHub does not allow a PR author to approve their own PR.

In this architecture the canonical PR author represents the authority that published the proposal, not the developer who wrote the code.

Typical provenance becomes:

```text
requester       = human or agent execution identity
issuer          = inari-issuer[bot]
commit author   = human / coding agent provenance
PR author       = inari-issuer[bot]
reviewer        = human or independent review agent
merger          = permitted actor under repository policy
```

A human implementer can therefore formally review and approve the issuer-authored PR without losing implementation attribution.

The issuer must not approve the PR it creates. Issuance and review are separate authorities.

The initial architecture also should not rely on a "reviewer must differ from most recent pusher" rule when the intended workflow permits the human implementer to push commits and then perform formal review. If a repository later requires that stronger independence property, update publication authority must be redesigned explicitly rather than accidentally breaking self-review semantics.

## 14. Authority separation

The architecture distinguishes the following authorities:

### 14.1 Intent authority

The governed Issue defines the requested work and accepted scope.

### 14.2 Semantic policy authority

Inari Core defines deterministic Change semantics, policy resolution, canonical projection rules, transition validity, and diagnostics.

### 14.3 Request authority

The authenticated human or agent is the actor requesting a semantic transition.

A requester may be allowed to request issuance without being granted the issuer's privileged GitHub credentials.

### 14.4 Issuance authority

The Inari GitHub App is the privileged mutation identity for canonical branch/PR issuance.

### 14.5 Execution authority

Workers perform implementation in their local/session environment and may update already-issued working branches under the initial policy.

### 14.6 Review authority

Humans and/or independent review agents evaluate the proposal. They are not the issuer identity.

### 14.7 Merge authority

Repository policy, Rulesets, status checks, reviews, and permitted actors determine merge admissibility and execution.

No single bot should silently collapse issuer, reviewer, and merge authority into one unreviewable principal.

## 15. Human and agent interface

GitHub App credentials are not a user interface.

The caller-facing interface is a semantic Inari request surface.

### 15.1 Canonical CLI

The `inari` executable remains the canonical human- and agent-facing client.

Candidate semantic operations include:

```text
inari change issue <issue>
inari change show <issue>
inari change ready <issue>
inari change abort <issue>
```

Exact public syntax must be defined through the canonical command authority when implemented.

The important architectural rule is that callers express **semantic Change operations**, not low-level effects.

Agents should never have to construct commands conceptually equivalent to:

```text
create_git_ref(...)
create_pull_request(...)
```

They request `issue Change` and consume the resulting structured identity.

### 15.2 Machine-readable contract

Every semantic operation intended for agent or automation use must provide deterministic structured input/output and bounded diagnostics.

A successful issuance result should be capable of expressing at least:

```json
{
  "change": 189,
  "issue": 189,
  "branch": "<canonical branch>",
  "pullRequest": 123,
  "state": "draft"
}
```

The exact schema belongs to executable contract authority.

### 15.3 GUI

A dedicated GUI is not required for the initial product.

GitHub already provides rich visualization of Issues, Draft/Ready PRs, review, checks, and merge state.

Future human-oriented adapters may include Issue comment commands, GitHub App surfaces, or other GitHub-native controls. They must invoke the same semantic transition contract rather than implement parallel business logic.

### 15.4 MCP

MCP is a natural future first-class adapter for coding agents.

An MCP surface should expose semantic tools such as `change.issue`, `change.show`, `change.ready`, and `change.abort`, not raw privileged GitHub mutation primitives.

MCP remains a client/adapter. It does not become an alternative Change authority.

## 16. Local operations versus authoritative transitions

Not every Inari operation belongs in Actions.

Pure deterministic operations should remain local-capable, including the existing families of:

- schema discovery;
- validation;
- rendering;
- explain/diagnostics;
- canonical checks;
- canonical reads where remote authority credentials are not required.

Authoritative repository transitions require the trusted remote path because they must apply effects under issuer authority.

The split is:

```text
pure/deterministic computation       authoritative repository mutation
------------------------------       ---------------------------------
local Inari Core                     trusted remote executor
```

The architecture therefore does **not** turn Inari into "everything is a GitHub Action".

## 17. Remote execution transport

The first implementation may use GitHub Actions `workflow_dispatch` or an equivalent GitHub-native dispatch mechanism as the remote execution transport.

That choice is intentionally hidden behind the semantic CLI/client surface.

Bad public contract:

```text
gh workflow run inari-change.yml -f operation=issue -f issue=189
```

Desired public contract:

```text
inari change issue 189
```

The workflow filename, dispatch input shape, job structure, and token-generation details are implementation concerns.

This preserves the option to add or replace transport later with an MCP gateway, GitHub App event handler, remote service, or other executor without changing Change semantics.

## 18. GitHub Actions role

GitHub Actions is the initial authoritative execution runtime because it provides:

- a repository-native trusted execution environment;
- auditable workflow runs;
- secrets and App credential confinement;
- straightforward repository scoping;
- no separate always-on service requirement;
- a natural integration point for existing GitHub governance.

However, Actions YAML must remain thin.

The workflow should conceptually:

1. authenticate/identify the requester and requested operation;
2. invoke Inari Core to resolve and validate a transition;
3. obtain a short-lived GitHub App installation token in trusted execution;
4. apply the planned effects through the GitHub adapter;
5. verify the resulting projection through Inari Core;
6. publish bounded structured result/evidence.

The workflow must not contain an independent handwritten naming policy, PR schema, state machine, or governance rule that competes with Inari Core.

## 19. GitHub App role

The Inari GitHub App is an authority identity, not a frontend.

It exists to provide least-privilege, auditable, short-lived mutation capability for trusted execution.

Human and agent clients must not receive:

- the GitHub App private key;
- installation tokens;
- reusable privileged bearer credentials;
- direct capability to impersonate the issuer outside the trusted executor.

The App's permissions should be limited to the effects required by the implemented transition set. Permissions must be expanded only when an explicit Change capability requires them.

## 20. Requester authentication and provenance

Requester identity and mutation identity are intentionally different.

The CLI should continue to use the caller's existing GitHub authentication context rather than introducing a second long-lived credential store merely for Inari.

The remote request must preserve enough identity to answer:

> Who requested this transition?

The App-authenticated mutation must answer:

> Which authority applied the governed effect?

At minimum, provenance should distinguish:

- repository and root Issue;
- requested transition;
- requester identity;
- request source/client class where useful;
- issuer identity;
- resulting canonical branch and PR;
- governance generation/contract identity where applicable;
- workflow/run or execution evidence sufficient for audit;
- implementation commit provenance;
- review and merge actors.

No single `author` field should collapse all of those roles.

## 21. Security model

The privileged boundary is the trusted executor plus GitHub App credentials.

### 21.1 No privileged credentials in untrusted execution

App private keys and installation tokens must not be exposed to arbitrary coding-agent shells, PR jobs, fork code, or untrusted repository content.

### 21.2 Avoid privileged execution of untrusted PR code

A privileged workflow must not check out and execute arbitrary PR-controlled code under issuer credentials merely because a PR event triggered it.

Architectures analogous to unsafe `pull_request_target` patterns must be rejected unless the trust boundary is explicitly proven.

### 21.3 Protect the authority path

If an attacker who can modify the privileged workflow can cause arbitrary App-authenticated mutations, the issuer boundary is meaningless.

The workflow, canonical Inari execution dependency, App configuration, and governance files that define issuer behavior must therefore receive repository protection appropriate to their privilege.

Exact enforcement may use CODEOWNERS, required review, required checks, Rulesets, immutable/reusable workflow references, or equivalent mechanisms. The implementation design must ensure that unreviewed working-branch code cannot redefine its own privileged issuer behavior.

### 21.4 Least privilege

The App receives only repository permissions required for the current transition set.

Issuance authority does not imply review approval authority, administration authority, arbitrary secret access, or unrestricted repository mutation.

### 21.5 Fail closed

When requester authorization, governance generation, canonical identity, or resulting projection cannot be proven, privileged mutation must not proceed by guessing.

## 22. State derivation and canonical markers

Inari already uses deterministic artifact identity and canonical parsing principles. Change projection should extend that model rather than introduce opaque hidden state.

The exact marker format is not fixed here, but Change reconstruction must be deterministic from governed GitHub evidence.

A compliant reader should be able to derive whether Issue #N has:

- no active Change;
- one healthy canonical Change;
- a merged/aborted historical Change;
- ambiguous or conflicting projections requiring attention.

If multiple candidate PRs or branches can plausibly claim canonical identity and no deterministic authority resolves them, Inari must report ambiguity rather than pick one heuristically.

## 23. Ready transition

`ready` is a governed Change transition, not merely an alias for a GitHub API call.

Before moving Draft -> Ready, Inari should be able to validate the relevant transition preconditions, including as applicable:

- root Issue remains governed and valid;
- canonical branch identity remains correct;
- canonical PR identity and issuer provenance remain correct;
- target base is valid;
- PR semantic contract is canonical or can be deterministically synchronized;
- required implementation/validation/acceptance evidence is present under repository policy;
- no unreconciled Change projection drift exists.

After successful validation, the trusted executor changes the PR to Ready and verifies the resulting state.

A caller must not need to reconstruct GitHub-specific transition mechanics.

## 24. Merge admission

Inari does not replace GitHub Rulesets, required checks, or review policy.

The Change architecture composes with them.

A required provenance check can establish that the PR being considered for merge is the canonical projection of the governed Change. Other repository checks determine code quality, security, review, and release constraints.

Conceptually:

```text
canonical Change provenance
          +
repository CI/security checks
          +
required reviews
          +
repository merge policy
          =
merge admission
```

A future `change merge` semantic operation may coordinate merge, but it must not bypass repository-native admission policy.

## 25. Product boundaries with Nawabari and Mottainai

The Change model must not absorb execution responsibilities already owned by adjacent products.

### 25.1 Inari

Owns governed GitHub Change semantics:

- Issue/PR semantic contracts;
- Change identity;
- canonical remote branch projection;
- issuance/ready/abort/merge-admission semantics;
- GitHub-side provenance and governance validation;
- authoritative transition planning.

### 25.2 Nawabari

Owns local Git/worktree/session isolation and execution mechanics:

- worktree lifecycle;
- local ownership and claim semantics;
- local Git/session safety;
- physical execution isolation.

Inari may provide Nawabari the canonical remote branch identity. It does not take ownership of Nawabari's local worktree/session model.

### 25.3 Mottainai

Owns agent orchestration and execution coordination:

- task delegation;
- agent/session orchestration;
- context/runtime coordination.

Mottainai may request or consume an Inari Change. It does not define Change naming, PR provenance, or repository governance semantics.

The intended flow is:

```text
Issue
  |
  v
Inari issues Change
  |
  +--> canonical branch + Draft PR
  |
  v
Nawabari establishes local execution session/worktree
  |
  v
Mottainai / coding agent implements
  |
  v
Inari validates ready transition
  |
  v
review / checks / merge policy
```

## 26. Existing behavior and compatibility

Inari currently provides direct governed Issue/PR mutation commands through the local CLI.

The new architecture must be introduced incrementally rather than breaking all existing callers immediately.

The migration may temporarily support both:

- current direct artifact-level mutation operations; and
- new authoritative Change transitions.

However, compatibility must be directional. The long-term governed implementation workflow should converge on Change issuance rather than preserve two equivalent canonical ways to create the same branch/PR lifecycle.

Existing capabilities such as branch preflight remain useful as compatibility and diagnostic behavior, but the target architecture moves canonical branch identity earlier: from "validate a branch chosen by the caller before PR creation" toward "derive and issue the canonical branch as part of Change creation."

## 27. Migration strategy

Implementation should proceed only after this architecture is merged and Epic #188 is decomposed into bounded Issues.

The intended order is dependency-driven, not a commitment to exact Issue count:

1. **Domain model and transition planning**
   - define machine-readable Change identity, state, transition requests, transition plans, and diagnostics in Inari Core;
   - preserve pure/deterministic local computation.

2. **Canonical Change read/projection**
   - deterministically derive Change state from governed GitHub Issue/branch/PR evidence;
   - define ambiguity and drift diagnostics.

3. **Issuance planning and idempotency**
   - derive branch/PR plan from root Issue and governance;
   - define create-or-return-existing and inconsistent-state behavior independent of workflow transport.

4. **GitHub App authority boundary**
   - establish least-privilege issuer identity and trusted token acquisition.

5. **Trusted Actions executor**
   - implement remote transition execution as a thin projection of Inari Core plans;
   - preserve requester provenance and verify resulting state.

6. **CLI remote request adapter**
   - expose semantic Change commands to humans and agents while hiding workflow transport details.

7. **Branch creation enforcement**
   - apply repository Ruleset enforcement only after the issuer path is operational and recoverable.

8. **Canonical Draft PR/provenance enforcement**
   - make issuer-created PRs the merge-admissible Change path and add required provenance checks.

9. **Ready/abort lifecycle transitions**
   - govern state changes and cleanup/recovery behavior.

10. **Agent adapters and broader rollout**
    - add MCP or GitHub-native adapters only as projections of the same semantic contract;
    - roll out repository-by-repository after dogfooding proves recovery and operational usability.

This ordering intentionally establishes semantics before privileged automation.

## 28. Non-goals

The initial architecture does not include:

- making Issue creation issuer-only;
- routing every working-branch push through Actions;
- exposing GitHub App credentials directly to agents or humans;
- making the issuer App approve its own PRs;
- replacing GitHub with a proprietary Change database;
- creating a standalone always-on HTTP service before it is needed;
- requiring a custom Web GUI;
- making workflow YAML the semantic source of truth;
- embedding Mottainai orchestration semantics into Inari;
- owning Nawabari's local worktree/session lifecycle;
- using LLM/free-form inference to determine canonical governance state;
- weakening fail-closed behavior to recover from ambiguous GitHub state automatically;
- fixing the exact final command spelling or wire transport in architectural prose before the executable command/protocol contracts are designed.

## 29. Architectural consequences

This architecture changes the meaning of Inari more than it changes its existing principles.

The existing principle is:

```text
semantic contract
   -> validate
   -> canonical projection
   -> governed mutation
```

The extended principle becomes:

```text
semantic Change
   -> validate transition
   -> canonical effect plan
   -> privileged governed mutation
   -> verify GitHub projection
```

Issue Forms and PR templates remain structured semantic authorities for their artifacts. Change composes those existing contracts into a lifecycle rather than replacing them.

The largest operational consequence is that a dedicated trusted execution path and GitHub App become part of Inari deployment. The largest product benefit is that branch naming, PR proposal authorship, and lifecycle publication stop depending on every human or coding agent voluntarily reproducing governance rules.

## 30. Review criteria for this architecture

Before implementation decomposition, reviewers should be able to answer yes to all of the following:

- Is `Change` clearly distinct from Issue, branch, and PR while being deterministically projected through them?
- Is Issue -> Change cardinality unambiguous?
- Is branch creation authority separated from ordinary branch update authority?
- Is canonical PR provenance enforceable even though GitHub cannot necessarily prevent every manual PR creation?
- Is Draft-at-issuance justified as a lifecycle state rather than automation convenience?
- Can an implementation author formally review an issuer-authored PR without erasing commit provenance?
- Are requester, issuer, implementer, reviewer, and merger identities distinct?
- Is Inari Core clearly the semantic authority while Actions remains an executor and the GitHub App remains an identity/capability?
- Can both humans and agents use the same semantic request model without a GUI dependency?
- Are App credentials confined to trusted execution?
- Are issuance retries idempotent?
- Are partial failures compensated or surfaced explicitly as recovery-required?
- Does the initial architecture avoid a duplicate Change database?
- Are Nawabari and Mottainai boundaries preserved?
- Is migration staged so enforcement is enabled only after the governed path is proven?

If any answer is unclear, implementation Issues should not invent the missing policy independently; the architecture must be amended first.

## 31. Epic relationship

This document implements the documentation gate in Epic #188 through Issue #189.

After this document is merged, Epic #188 should be decomposed into independently executable implementation Issues derived from the architecture above. The Epic remains the roadmap/tracking authority; this document remains the architectural boundary authority; executable schemas, validators, tests, Rulesets, and command metadata remain the mechanical authorities for their respective contracts.
