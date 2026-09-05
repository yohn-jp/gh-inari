# Inari Governed Change Control Plane

Status: proposed architecture for Epic #188. Implementation begins only after this document is merged.

## 1. Purpose

Inari is evolving from a governed GitHub CLI into a deterministic governance control plane for repository Changes.

The product already treats repository-native Issue Forms and pull request templates as deterministic typed contracts, validates structured semantic input, renders canonical GitHub artifacts, and fails closed when governance cannot be resolved safely. The next architectural step is to govern how implementation work is published to GitHub, not only the shape of individual Issue or pull request artifacts.

The central abstraction is `Change`.

A Change is the governed execution identity that connects one intent-bearing Issue to one canonical remote branch and one canonical pull request. It is issued when implementation begins, remains observable while work proceeds, becomes reviewable through an explicit governed transition, and terminates through merge or abort.

This document defines the product model, lifecycle, authority boundaries, caller interfaces, trusted execution path, security model, failure semantics, provenance, and migration constraints for that control plane.

This document is architectural authority for those boundaries. It does not replace executable semantic templates, schemas, validators, command metadata, repository Rulesets, or tests. Where a rule can be expressed and enforced mechanically, the executable authority remains canonical and this document describes its intended role.

## 2. Product definition

The target product definition is:

> Inari is a deterministic governance control plane for GitHub repository Changes.

Inari is not defined as GitHub Actions, a GitHub App, a CLI, or a Web application. Those are separate roles.

- **Inari Core** owns semantic contracts, policy resolution, canonicalization, Change state-machine validation, transition planning, invariants, and diagnostics.
- **Inari CLI** is the canonical human- and agent-facing client surface.
- **GitHub Actions** is the initial trusted remote execution runtime for privileged Change transitions.
- **Inari GitHub App** is the authority identity and capability used by trusted execution to apply privileged GitHub effects.
- **GitHub** is the initial observable state store and primary human visualization surface for Issue, branch, PR, CI, review, and merge state.
- **MCP, GitHub-native UI adapters, or a future service** may become additional clients or transports without becoming new semantic authorities.

The architecture separates three concerns that must not collapse into one another:

```text
semantic authority     execution runtime       mutation identity
------------------     -----------------       -----------------
Inari Core             GitHub Actions          Inari GitHub App
```

Actions executes a transition plan. The App authenticates privileged effects. Neither defines the meaning of a Change.

## 3. Why Change exists

Today, Issue, branch, and pull request can be created as independent artifacts by human or agent callers. Even when Inari validates Issue and PR contracts, publication authority remains distributed.

- A caller may choose a remote branch name before Inari sees the pull request.
- The person who implements the change often becomes the PR author merely because they invoked `pr create`.
- GitHub then prevents that PR author from formally approving the same PR.
- Governance such as branch naming remains advisory unless every caller reproduces it correctly.

These are symptoms of the same missing abstraction: publication of repository work is not yet a governed transition.

Instead of treating branch creation and PR creation as unrelated user actions, Inari treats them as projections of one semantic operation: issue a Change.

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

An Issue may exist indefinitely without an active Change. Creating an Issue does not imply implementation has started.

```text
Issue -> Change cardinality: 0..1 active canonical Change
```

The architecture does not require Issue creation itself to be issuer-only.

### 4.2 Change

A Change represents the governed execution identity for implementing one Issue.

A Change is not a fourth persistent GitHub object. It is semantic state derived from canonical GitHub projections and governed metadata.

The initial identity is:

```text
Change identity = repository identity + root Issue number
```

For example, `yohn-jp/gh-inari#189` identifies the Change rooted in Issue #189 when that Issue has been issued.

### 4.3 Canonical branch

Every issued active Change has exactly one canonical remote branch.

The branch name is a deterministic projection computed by Inari from governed inputs. Human and agent callers do not supply the canonical branch name as free-form authority.

The exact naming grammar remains executable repository governance, not prose in this document.

> Inari determines the canonical remote branch identity for a governed Change.

### 4.4 Canonical pull request

Every issued active Change has exactly one canonical pull request.

The canonical PR is created as Draft during Change issuance. It exists from the beginning of implementation rather than being created after implementation is complete.

The canonical PR author is the issuer identity, normally the Inari GitHub App, not necessarily the implementation author.

```text
proposal publication identity != implementation authorship
```

Commit authorship and other Git provenance continue to record who authored implementation commits.

## 5. Normative invariants

The following invariants are architectural requirements.

- Every Change has exactly one root Issue.
- An Issue may exist without an issued Change.
- Every issued active Change has exactly one canonical branch.
- Every issued active Change has exactly one canonical PR.
- Branch and PR are projections of one Change, not independent authorities.
- Canonical branch naming is computed by Inari.
- Canonical branch creation is issuer-controlled.
- Ordinary updates to an already-issued working branch remain worker-controlled in the initial model.
- Canonical PR creation is issuer-controlled at the semantic layer.
- Noncanonical PRs may physically exist but must not become merge-admissible governed Changes.
- Change issuance is a logical transaction even though GitHub requires multiple API effects.
- Change issuance is idempotent.
- Partial or conflicting state fails closed.
- Draft represents implementation state.
- Ready represents admission to review.
- PR author represents proposal publication authority, not implementation authorship.
- Issuer and reviewer are separate authorities.
- Human and agent callers never receive GitHub App private keys or installation tokens.
- Requester, issuer, implementer, reviewer, and merger identities remain distinguishable.
- Pure deterministic operations remain local-capable.
- Authoritative repository transitions use a trusted remote executor.
- Actions workflow YAML is not a second semantic authority.
- GitHub is the initial state store for Change projection.
- A separate persistent Change database is not introduced without a demonstrated requirement.
- Existing semantic template authority remains authoritative for Issue and PR artifact contracts.
- Humans and agents share the same semantic Change contract.
- GUI-only operation is not acceptable.

## 6. Change lifecycle

The lifecycle is modeled semantically by Inari Core and projected onto GitHub-native states where possible.

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

unrecoverable projection drift
   |
   v
RECOVERY_REQUIRED
```

The final machine-state names may differ, but these semantics are fixed.

### 6.1 DEFINED

A governed Issue exists, but no active Change has been issued. There is no requirement for a canonical branch or PR.

### 6.2 DRAFT

Change issuance completed successfully. Both canonical branch and canonical Draft PR exist. Implementation may proceed.

GitHub Draft PR state is intentionally reused as the visible projection of this phase.

### 6.3 REVIEW

The Change has passed the governed `ready` transition. The canonical PR is Ready for review.

The transition is not merely a raw GitHub UI toggle. Inari validates the Change projection and required governance preconditions before admitting the Change to review.

### 6.4 ACCEPTED

Required reviews, status checks, governance checks, and merge-admission policy are satisfied.

Whether ACCEPTED is materialized or derived at read time is an implementation detail. Reviewability and merge admissibility remain distinct semantics.

### 6.5 MERGED

The canonical PR has been merged under repository policy. Post-merge branch cleanup is separate from the semantic identity of the completed Change.

### 6.6 ABORTED

The Change is intentionally stopped without merge. Abort behavior must preserve enough provenance to explain that the Change existed and was intentionally terminated.

### 6.7 RECOVERY_REQUIRED

GitHub effects are not atomic. If a privileged operation partially succeeds and compensation cannot restore a valid canonical projection, Inari fails closed and exposes an explicit recovery-required state.

## 7. Change issuance

The semantic operation is conceptually:

```text
inari change issue <issue>
```

The public command spelling is not fixed by this document. The operation is.

A compliant issuance transition performs these semantic steps:

- Resolve target repository and governance generation.
- Read the root Issue.
- Resolve and validate the governing Issue contract.
- Verify that the Issue is eligible for Change issuance.
- Determine the target base branch.
- Compute the canonical Change branch name.
- Inspect existing GitHub state for prior issuance or inconsistency.
- Create the canonical remote branch through issuer authority.
- Create the canonical Draft PR through issuer authority.
- Verify that the resulting branch and PR match the planned Change.
- Return one bounded machine-readable Change result.

The user-visible operation succeeds only when branch and Draft PR are both established consistently.

## 8. Idempotency

Authoritative remote operations must be retry-safe because Actions, network calls, clients, and users can all retry.

Issuance therefore uses create-or-return-existing semantics, not blind create semantics.

A repeated issuance request has only these valid outcomes:

- The canonical Change does not exist, so create it.
- The canonical Change already exists and matches all invariants, so return it deterministically.
- Partial, conflicting, or ambiguous state exists, so fail closed with a structured inconsistency or recovery diagnostic.

A retry must never create a second canonical PR merely because the first request already succeeded.

## 9. Compensation and recovery

GitHub does not provide an atomic transaction spanning ref creation and PR creation.

The initial compensation model is:

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

If compensation succeeds, issuance fails without leaving an orphan canonical branch.

If compensation fails, Inari reports `RECOVERY_REQUIRED` or equivalent structured failure and preserves exact evidence needed for bounded repair.

Recovery is itself governed and deterministic. Hidden cleanup that guesses caller intent is rejected.

## 10. Branch authority model

The initial architecture governs branch birth, not every branch update.

### 10.1 Creation

Canonical remote branch creation is issuer-controlled.

Where GitHub Rulesets can enforce `Restrict creations`, the issuer identity should be the allowed or bypass actor for the governed namespace.

```text
caller creates arbitrary new remote branch -> denied
Inari issues canonical branch             -> allowed
```

The objective is capability control rather than post-hoc naming validation.

### 10.2 Updates

Ordinary fast-forward pushes to an already-issued working branch remain available to workers in the initial architecture.

```text
edit -> commit -> push -> edit -> commit -> push
```

The architecture explicitly rejects routing every feature-branch push through the issuer in the first version. A future policy may strengthen publication authority only if a concrete requirement justifies the added friction.

### 10.3 Deletion

Branch deletion is a lifecycle and governance concern distinct from creation and update. Implementation must define cleanup behavior while preserving merged or aborted Change provenance.

## 11. PR authority model

GitHub does not provide an exact symmetric native rule equivalent to branch `Restrict creations` that makes all PR creation exclusive to one GitHub App.

Canonical PR issuer control is therefore enforced semantically and at merge admission.

### 11.1 Canonical PR creation

The trusted executor creates the canonical Draft PR using the Inari GitHub App identity immediately after branch issuance.

Humans and agents therefore have no normal need to run direct `pr create` for governed Changes.

### 11.2 Noncanonical PRs

A user may still be technically capable of creating a PR from an existing branch. Such a PR is not canonical merely because it exists.

A required Change-provenance check should validate at least:

- Root Issue identity.
- Canonical branch identity.
- Canonical base branch.
- Canonical PR identity for the Change.
- Expected issuer or proposal-author identity where applicable.
- Valid governed PR contract.
- Absence of conflicting canonical projections.

A noncanonical PR may be visible but must not become merge-admissible as the governed Change.

```text
physical creation prevention: not always complete
canonical merge admission:    enforceable
```

## 12. Draft-at-issuance semantics

Creating the PR as Draft at Change issuance is a central design decision.

It provides these properties:

- Issue, branch, and PR identity are fixed before implementation diverges.
- GitHub's PR list becomes an observable list of active Changes.
- Proposal authorship can be neutral issuer infrastructure from the beginning.
- Review readiness becomes an explicit lifecycle transition rather than being conflated with PR creation.

```text
Draft PR = implementation state
Ready PR = review-admitted state
```

The initial Draft PR may contain only information derivable before implementation, such as root Issue, target, status, and governed placeholders.

The `ready` transition may canonicalize or complete implementation summary, validation evidence, acceptance evidence, and other required PR semantics before changing GitHub's Draft state.

## 13. Review separation and self-review

GitHub does not allow a PR author to approve their own PR.

In this architecture, the canonical PR author represents the authority that published the proposal, not the developer who wrote the code.

```text
requester       = human or agent execution identity
issuer          = inari-issuer[bot]
commit author   = human or coding-agent provenance
PR author       = inari-issuer[bot]
reviewer        = human or independent review agent
merger          = permitted actor under repository policy
```

A human implementer can therefore formally review and approve an issuer-authored PR without losing implementation attribution.

The issuer must not approve the PR it creates.

The initial architecture should not rely on a rule requiring the reviewer to differ from the most recent pusher when the intended workflow permits the human implementer to push and then perform formal review. A future stronger-independence policy must redesign update publication authority explicitly.

## 14. Authority separation

The architecture distinguishes these authorities.

### 14.1 Intent authority

The governed Issue defines requested work and accepted scope.

### 14.2 Semantic policy authority

Inari Core defines deterministic Change semantics, policy resolution, canonical projection rules, transition validity, and diagnostics.

### 14.3 Request authority

The authenticated human or agent requests a semantic transition without receiving issuer credentials.

### 14.4 Issuance authority

The Inari GitHub App is the privileged mutation identity for canonical branch and PR issuance.

### 14.5 Execution authority

Workers implement code in their local or session environment and may update already-issued working branches under initial policy.

### 14.6 Review authority

Humans or independent review agents evaluate the proposal. They are not the issuer identity.

### 14.7 Merge authority

Repository policy, Rulesets, status checks, reviews, and permitted actors determine merge admissibility and execution.

No single bot should silently collapse issuer, reviewer, and merge authority into one principal.

## 15. Human and agent interface

GitHub App credentials are not a user interface. The caller-facing interface is a semantic Inari request surface.

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

Agents should request semantic operations, not low-level effects such as creating Git refs or pull requests directly.

### 15.2 Machine-readable contract

Every semantic operation intended for agent or automation use must provide deterministic structured input and output with bounded diagnostics.

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

A dedicated GUI is not required for the initial product. GitHub already provides rich visualization of Issues, Draft and Ready PRs, review, checks, and merge state.

Future human-oriented adapters may include Issue comment commands, GitHub App surfaces, or other GitHub-native controls. They must invoke the same semantic transition contract rather than implement parallel business logic.

### 15.4 MCP

MCP is a natural future first-class adapter for coding agents.

An MCP surface should expose semantic tools such as `change.issue`, `change.show`, `change.ready`, and `change.abort`, not raw privileged GitHub mutation primitives.

MCP remains a client or adapter. It does not become an alternative Change authority.

## 16. Local operations versus authoritative transitions

Not every Inari operation belongs in Actions.

Pure deterministic operations remain local-capable, including schema discovery, validation, rendering, explain diagnostics, canonical checks, and canonical reads where privileged credentials are not required.

Authoritative repository transitions use the trusted remote path because they apply effects under issuer authority.

```text
pure deterministic computation     authoritative repository mutation
------------------------------     ---------------------------------
local Inari Core                   trusted remote executor
```

The architecture does not turn Inari into an "everything is a GitHub Action" product.

## 17. Remote execution transport

The first implementation may use GitHub Actions `workflow_dispatch` or an equivalent GitHub-native dispatch mechanism as the remote execution transport.

That choice is hidden behind the semantic CLI or client surface.

Bad public contract:

```text
gh workflow run inari-change.yml -f operation=issue -f issue=189
```

Desired public contract:

```text
inari change issue 189
```

### 17.1 Actions dogfood

With `gh auth login` completed for the target repository, run the installed
CLI or the package entrypoint from the repository checkout:

```bash
npx --yes gh-inari change issue 189 --repository yohn-jp/gh-inari --json
# or: inari change issue 189 --repository yohn-jp/gh-inari --json
inari change show 189 --repository yohn-jp/gh-inari --json
gh pr view "$(inari change show 189 --repository yohn-jp/gh-inari --json | jq -r .pullRequest)" --json headRefName,isDraft,author
```

The first command dispatches the protected Actions executor. The executor
keeps the Issuer App credentials in Actions secrets, creates the canonical
branch and Draft PR, and returns only the bounded Change projection. `ready`
and `abort` use the same semantic path; no #223 ruleset enforcement is
required for this dogfood.

Workflow filename, dispatch input shape, job structure, and token-generation details are implementation concerns.

The transport may later be replaced or supplemented by MCP, a GitHub App event handler, a remote service, or another executor without changing Change semantics.

## 18. GitHub Actions role

GitHub Actions is the initial authoritative execution runtime because it provides a repository-native trusted environment, auditable runs, secret confinement, repository scoping, and no separate always-on service requirement.

Actions YAML must remain thin.

A trusted workflow should conceptually:

- Identify the requester and semantic transition.
- Invoke Inari Core to resolve and validate a transition.
- Obtain a short-lived GitHub App installation token in trusted execution.
- Apply the planned effects through the GitHub adapter.
- Verify the resulting projection through Inari Core.
- Publish bounded structured result or evidence.

The workflow must not contain an independent handwritten naming policy, PR schema, state machine, or governance rule that competes with Inari Core.

## 19. GitHub App role

The Inari GitHub App is an authority identity, not a frontend.

It provides least-privilege, auditable, short-lived mutation capability for trusted execution.

Human and agent clients must not receive:

- The GitHub App private key.
- Installation tokens.
- Reusable privileged bearer credentials.
- Direct capability to impersonate the issuer outside trusted execution.

App permissions are limited to effects required by the implemented transition set and expanded only for explicit capabilities.

## 20. Requester authentication and provenance

Requester identity and mutation identity are intentionally different.

The CLI should continue using the caller's existing GitHub authentication context rather than introducing a second long-lived credential store merely for Inari.

The system must preserve enough identity to answer both of these questions:

- Who requested this transition?
- Which authority applied the governed effect?

Provenance should distinguish at least:

- Repository and root Issue.
- Requested transition.
- Requester identity.
- Request source or client class where useful.
- Issuer identity.
- Resulting canonical branch and PR.
- Governance generation or contract identity where applicable.
- Workflow or execution evidence sufficient for audit.
- Implementation commit provenance.
- Review and merge actors.

No single author field should collapse these roles.

## 21. Security model

The privileged boundary is the trusted executor plus GitHub App credentials.

### 21.1 No privileged credentials in untrusted execution

App private keys and installation tokens must not be exposed to arbitrary coding-agent shells, PR jobs, fork code, or untrusted repository content.

### 21.2 Do not execute untrusted PR code with issuer credentials

A privileged workflow must not check out and execute arbitrary PR-controlled code under issuer credentials merely because a PR event triggered it.

Unsafe `pull_request_target`-style trust patterns are rejected unless the trust boundary is explicitly proven.

### 21.3 Protect the authority path

If untrusted code can modify the privileged workflow or the code it executes, the issuer boundary is meaningless.

Privileged workflow definitions, canonical Inari execution dependencies, App configuration, and governance files that define issuer behavior must receive protection appropriate to their privilege.

Exact enforcement may use CODEOWNERS, required review, required checks, Rulesets, immutable reusable workflow references, or equivalent mechanisms.

### 21.4 Least privilege

Issuance authority does not imply review approval authority, administration authority, arbitrary secret access, or unrestricted repository mutation.

### 21.5 Fail closed

When requester authorization, governance generation, canonical identity, or resulting projection cannot be proven, privileged mutation does not proceed by guessing.

## 22. State derivation and drift

Change reconstruction must be deterministic from governed GitHub evidence.

A compliant reader should be able to derive whether Issue #N has:

- No active Change.
- One healthy canonical Change.
- A merged or aborted historical Change.
- Ambiguous or conflicting projections requiring attention.

If multiple candidate PRs or branches plausibly claim canonical identity and no deterministic authority resolves them, Inari reports ambiguity rather than choosing heuristically.

This extends Inari's existing canonical-read and fail-closed principles.

## 23. Ready transition

`ready` is a governed Change transition, not merely an alias for a GitHub API call.

Before moving Draft to Ready, Inari validates the relevant transition preconditions, including as applicable:

- Root Issue remains governed and valid.
- Canonical branch identity remains correct.
- Canonical PR identity and issuer provenance remain correct.
- Target base remains valid.
- PR semantic contract is canonical or can be deterministically synchronized.
- Required implementation, validation, and acceptance evidence is present under repository policy.
- No unreconciled Change projection drift exists.

After successful validation, the trusted executor changes the PR to Ready and verifies resulting state.

## 24. Merge admission

Inari does not replace GitHub Rulesets, required checks, or review policy. The Change architecture composes with them.

```text
canonical Change provenance
          +
repository CI and security checks
          +
required reviews
          +
repository merge policy
          =
merge admission
```

A future `change merge` semantic operation may coordinate merge, but it must not bypass repository-native admission policy.

## 25. Product boundaries

### 25.1 Inari

Inari owns governed GitHub Change semantics, including:

- Issue and PR semantic contracts.
- Change identity.
- Canonical remote branch projection.
- Issuance, ready, abort, and merge-admission semantics.
- GitHub-side provenance and governance validation.
- Authoritative transition planning.

### 25.2 Nawabari

Nawabari owns local Git, worktree, session isolation, ownership, and physical execution safety.

Inari may provide Nawabari the canonical remote branch identity. It does not take ownership of Nawabari's local worktree or session model.

### 25.3 Mottainai

Mottainai owns agent orchestration, task delegation, context, and execution coordination.

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
Mottainai or coding agent implements
  |
  v
Inari validates ready transition
  |
  v
review / checks / merge policy
```

## 26. Existing behavior and compatibility

Inari currently provides direct governed Issue and PR mutation commands through the local CLI.

The new architecture is introduced incrementally rather than breaking all existing callers immediately.

Migration may temporarily support both current direct artifact-level mutation operations and new authoritative Change transitions. Compatibility is directional: the long-term governed implementation workflow converges on Change issuance rather than preserving two equivalent canonical ways to create the same branch and PR lifecycle.

Existing branch-preflight capabilities remain useful as compatibility and diagnostic behavior. The target architecture moves canonical branch identity earlier, from validating a caller-chosen branch before PR creation to deriving and issuing the canonical branch as part of Change creation.

## 27. Migration strategy

Implementation begins only after this architecture is merged and Epic #188 is decomposed into bounded Issues.

The dependency order is:

- Define machine-readable Change identity, state, transition requests, transition plans, and diagnostics in Inari Core.
- Add deterministic Change read and projection from governed GitHub evidence.
- Define issuance planning, idempotency, conflict detection, and recovery semantics independent of transport.
- Establish the least-privilege GitHub App issuer boundary.
- Implement the trusted Actions executor as a thin projection of Inari Core plans.
- Add the CLI remote-request adapter while hiding workflow transport details.
- Enable branch-creation enforcement only after the issuer path is proven and recoverable.
- Enforce canonical Draft PR provenance and merge admission.
- Add governed ready and abort transitions.
- Add MCP or GitHub-native adapters only as projections of the same semantic contract.
- Roll out repository-by-repository after dogfooding proves recovery and operational usability.

This ordering establishes semantics before privileged automation.

## 28. Explicit non-goals

The initial architecture does not include:

- Making Issue creation issuer-only.
- Routing every working-branch push through Actions.
- Exposing GitHub App credentials directly to agents or humans.
- Making the issuer App approve its own PRs.
- Replacing GitHub with a proprietary Change database.
- Creating a standalone always-on HTTP service before it is needed.
- Requiring a custom Web GUI.
- Making workflow YAML the semantic source of truth.
- Embedding Mottainai orchestration semantics into Inari.
- Owning Nawabari's local worktree or session lifecycle.
- Using LLM or free-form inference to determine canonical governance state.
- Weakening fail-closed behavior to recover from ambiguous GitHub state automatically.
- Fixing final command spelling or wire transport in architectural prose before executable contracts are designed.

## 29. Rejected alternatives

### 29.1 Keep Inari as a local direct-mutation CLI

Rejected because publication authority remains distributed and privileged issuer identity would have to be exposed to every execution environment.

### 29.2 Route every push through Actions

Rejected for the initial architecture because it would make the ordinary edit, commit, and push loop unnecessarily expensive and slow.

### 29.3 Make GitHub Actions the semantic authority

Rejected because workflow YAML would become a second business-logic contract and lock Inari to one executor.

### 29.4 Expose the GitHub App directly to agents

Rejected because App credentials are privileged capability, not a caller interface.

### 29.5 Build a dedicated GUI first

Rejected because agents require deterministic machine interfaces and GitHub already provides state visualization.

### 29.6 Build a standalone HTTP service first

Rejected because Actions can provide the initial trusted remote boundary without additional server operations.

### 29.7 Create a Change whenever an Issue opens

Rejected because backlog Issues should remain inert. Change issuance represents work beginning, not intent merely existing.

### 29.8 Persist a separate Change database immediately

Rejected because duplicated lifecycle state creates drift before a need for separate persistence has been demonstrated.

## 30. Architectural consequences

The existing Inari principle is:

```text
semantic contract
   -> validate
   -> canonical projection
   -> governed mutation
```

The extended principle is:

```text
semantic Change
   -> validate transition
   -> canonical effect plan
   -> privileged governed mutation
   -> verify GitHub projection
```

Issue Forms and PR templates remain semantic authorities for their artifacts. Change composes those contracts into a lifecycle rather than replacing them.

The largest operational consequence is that a dedicated trusted execution path and GitHub App become part of Inari deployment.

The largest product benefit is that branch naming, proposal authorship, and lifecycle publication stop depending on every human or coding agent voluntarily reproducing governance rules.

## 31. Review gate

Before implementation decomposition, reviewers should be able to answer yes to all of these questions:

- Is `Change` clearly distinct from Issue, branch, and PR while being deterministically projected through them?
- Is Issue-to-Change cardinality unambiguous?
- Is branch creation authority separated from ordinary branch update authority?
- Is canonical PR provenance enforceable even though GitHub cannot prevent every manual PR creation?
- Is Draft-at-issuance justified as lifecycle state rather than automation convenience?
- Can an implementation author formally review an issuer-authored PR without erasing commit provenance?
- Are requester, issuer, implementer, reviewer, and merger identities distinct?
- Is Inari Core clearly the semantic authority while Actions remains an executor and the GitHub App remains an identity and capability?
- Can humans and agents use the same semantic request model without a GUI dependency?
- Are App credentials confined to trusted execution?
- Are issuance retries idempotent?
- Are partial failures compensated or surfaced explicitly as recovery-required?
- Does the initial architecture avoid a duplicate Change database?
- Are Nawabari and Mottainai boundaries preserved?
- Is migration staged so enforcement is enabled only after the governed path is proven?

If any answer is unclear, implementation Issues must not invent missing policy independently. The architecture must be amended first.

## 32. Epic relationship

This document implements the documentation gate in Epic #188 through Issue #189.

After this document is merged, Epic #188 is decomposed into independently executable implementation Issues derived from this architecture. The Epic remains the roadmap and tracking authority. This document remains the architectural boundary authority. Executable schemas, validators, tests, Rulesets, and command metadata remain the mechanical authorities for their respective contracts.
